/**
 * @file Requests & downloads, phase 2: the client side of notifications. Holds the signed-in user's
 * inbox (first page + unread count), follows and settings; follows the user's own inbox key on the
 * change feed (ntf:u:<id>) so the bell updates within seconds; shows a toast for each new
 * notification on open pages — never while a video plays (those wait, then one summary toast shows
 * when playback ends; toasts on screen go away when playback starts). Texts come from en.json by
 * notification kind; titles are set as text, never as HTML. Every per-user answer is dropped when
 * the signed-in user changed while it was on its way. Exposes JE.arrNotify (used by the bell, the
 * Notify me / Remind buttons and the panel).
 */
(function (JE) {
    'use strict';

    const N = (JE.internals = JE.internals || {}).arrNotify = JE.internals.arrNotify || {};
    const PAGE = 20;
    const TOAST_MS = 8000;
    const MAX_TOASTS = 3;

    const state = {
        started: false,
        loaded: false,
        unread: 0,
        items: [],
        more: false,
        newestSeen: 0,
        follows: null,
        muted: new Set(),
        requested: new Set(),
        prefs: null,
        channels: null,
        contact: '',
        admin: false,
        heldDuringPlayback: 0,
        unsubscribe: null,
        listeners: new Set(),
        loading: null,
        refreshAgain: false,
        identity: 0,
        hooked: false
    };

    /** Dismiss timers of the toasts on screen (cancelled when a toast goes). */
    const toastTimers = new Map();

    // The person's notification settings have one queue, bound to the signed-in session (core/mutation-queue.js): changes
    // go out one at a time in the order they were made (each a change of the fields it names, applied by the server to
    // what it holds then), the session is checked right before each is sent, and an account switch cancels the previous
    // person's. Its revision moves on with every change queued or answered: a settings read that began before one is not
    // taken over it.
    const prefsQueue = JE.core.mutationQueue('arr-notify-prefs');

    /**
     * True when the server has notifications on (master, phase 1, phase 2 and the notifications switch).
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return JE.pluginConfig?.ArrNotificationsEnabled === true;
    }

    /**
     * Translates an en.json key with {name} parameters.
     * @param {string} key Key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        if (JE.arrStatus?.tr) return JE.arrStatus.tr(key, params);
        const out = typeof JE.t === 'function' ? JE.t(key, params) : key;
        return typeof out === 'string' ? out : key;
    }

    /**
     * The signed-in user's id as 32 lower-case hex digits, or null.
     * @returns {string|null} Id.
     */
    function userHex() {
        const id = typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
        return id ? String(id).replace(/-/g, '').toLowerCase() : null;
    }

    /**
     * Calls a JE route (never cached).
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {Object} [options] method, body.
     * @returns {Promise<any>} JSON.
     */
    function api(path, options) {
        return JE.core.api.plugin(path, Object.assign({ skipCache: true, skipRetry: true, timeoutMs: 15000 }, options || {}));
    }

    /**
     * Tells every listener (bell, panel, buttons) that something changed.
     * @param {string} what inbox, follows or prefs.
     * @returns {void}
     */
    function emit(what) {
        for (const fn of Array.from(state.listeners)) {
            try {
                fn(what);
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: notifications listener failed', err);
            }
        }
    }

    /**
     * Subscribes to changes.
     * @param {(what: string) => void} fn Listener.
     * @returns {() => void} Unsubscribe.
     */
    function onChange(fn) {
        state.listeners.add(fn);
        return () => state.listeners.delete(fn);
    }

    /**
     * True while a video plays (or the player page is shown): no toasts then.
     * @returns {boolean} Playing.
     */
    function playing() {
        if (typeof JE.isVideoPage === 'function' && JE.isVideoPage()) return true;
        const video = document.querySelector('.videoPlayerContainer:not(.hide) video, video.htmlvideoplayer');
        return !!(video && !video.paused);
    }

    /**
     * Reads the newest page of the inbox; new unread items (after the first read) become toasts.
     * Asked again while a read is under way, it reads once more after it (a notification created
     * after that read began would otherwise wait for the next change to show).
     * @returns {Promise<void>}
     */
    function refresh() {
        if (state.loading) {
            state.refreshAgain = true;
            return state.loading;
        }
        const identity = state.identity;
        const loading = (async () => {
            let data = null;
            try {
                data = await api(`/acquire/notify/inbox?limit=${PAGE}`);
            } catch (_) {
                data = null;
            }
            if (identity !== state.identity || !data || !Array.isArray(data.items)) return;
            const first = !state.loaded;
            const fresh = first ? [] : data.items.filter(i => !i.read && i.id > state.newestSeen);
            state.loaded = true;
            state.unread = Number(data.unread) || 0;
            // Keep older pages already loaded below the new first page.
            const ids = new Set(data.items.map(i => i.id));
            const older = state.items.filter(i => !ids.has(i.id) && i.id < (data.items[data.items.length - 1]?.id ?? 0));
            state.items = data.items.concat(older);
            state.more = state.items.length > data.items.length ? state.more : !!data.more;
            state.newestSeen = Math.max(state.newestSeen, ...data.items.map(i => i.id), 0);
            emit('inbox');
            if (fresh.length) toast(fresh);
        })().finally(() => {
            if (state.loading !== loading) return;
            state.loading = null;
            if (state.refreshAgain && identity === state.identity) {
                state.refreshAgain = false;
                refresh();
            }
        });
        state.loading = loading;
        return loading;
    }

    /**
     * Loads the next (older) page.
     * @returns {Promise<void>}
     */
    async function loadMore() {
        const last = state.items[state.items.length - 1];
        if (!last) return;
        const identity = state.identity;
        let data = null;
        try {
            data = await api(`/acquire/notify/inbox?limit=${PAGE}&before=${encodeURIComponent(last.id)}`);
        } catch (_) {
            return;
        }
        if (identity !== state.identity || !data || !Array.isArray(data.items)) return;
        const ids = new Set(state.items.map(i => i.id));
        state.items = state.items.concat(data.items.filter(i => !ids.has(i.id)));
        state.more = !!data.more;
        emit('inbox');
    }

    /**
     * Marks notifications read (all of them without ids).
     * @param {number[]|null} ids Ids, or null for all.
     * @returns {Promise<void>}
     */
    async function markRead(ids, origin) {
        origin = JE.core.userWrite.originOf(origin);
        const body = ids ? { ids } : { all: true };
        // A read acknowledgement is the viewer's own inbox state, no title action's (D46S2-R12-1): it is sent with an
        // explicit session-only binding (the session the core captured now), so it goes out only as this account.
        const session = typeof JE.core.api.session === 'function' ? JE.core.api.session() : JE.captureSession?.();
        state.items = state.items.map(i => (!ids || ids.includes(i.id)) ? Object.assign({}, i, { read: true }) : i);
        state.unread = ids ? Math.max(0, state.unread - ids.length) : 0;
        emit('inbox');
        const identity = state.identity;
        try {
            const res = await api('/acquire/notify/read', { method: 'POST', body, session: origin, ...(session ? { bound: { session } } : {}) });
            if (identity === state.identity && res && typeof res.unread === 'number') {
                state.unread = res.unread;
                emit('inbox');
            }
        } catch (_) { /* the next refresh corrects it */ }
    }

    /**
     * The follows of the user (cached; reloaded on demand).
     * @param {boolean} [force] Reload.
     * @returns {Promise<void>}
     */
    // Follow reads in the order they started (D46S2 audit S4): an answer is applied only while no read that started
    // later has been applied, so a read from before a write never replaces the reread after it.
    let followReads = 0;
    let followsApplied = 0;
    async function loadFollows(force) {
        if (state.follows && !force) return;
        const identity = state.identity;
        const mine = ++followReads;
        let data = null;
        try {
            data = await api('/acquire/follows');
        } catch (_) {
            data = null;
        }
        if (identity !== state.identity || mine < followsApplied) return;
        if (data) followsApplied = mine;
        if (data) {
            state.follows = new Set((data.follows || []).map(f => f.key));
            state.muted = new Set(data.muted || []);
            state.requested = new Set(data.requested || []);
        } else {
            state.follows = state.follows || new Set();
        }
        emit('follows');
    }

    /**
     * The title (movie/series) key of a key.
     * @param {string} key Key.
     * @returns {string} Title key.
     */
    function titleOf(key) {
        return String(key || '').replace(/:s\d+(:e\d+)?$/, '');
    }

    /**
     * True when the user follows the key (explicitly, or because they asked for the title and didn't mute it).
     * @param {string} key Movie, series or season key.
     * @returns {boolean} Following.
     */
    function isFollowing(key) {
        if (!state.follows) return false;
        if (state.follows.has(key)) return true;
        const title = titleOf(key);
        if (key !== title && state.follows.has(title)) return true;
        return state.requested.has(title) && !state.muted.has(title);
    }

    /**
     * True when the user follows the title only because they asked for it.
     * @param {string} key Key.
     * @returns {boolean} Requested.
     */
    function followsAsRequester(key) {
        const title = titleOf(key);
        return !!state.follows && !state.follows.has(key) && state.requested.has(title) && !state.muted.has(title);
    }

    /**
     * Follows or unfollows a title.
     * @param {string} key Movie, series or season key.
     * @param {boolean} on Follow.
     * @param {Object|Node|Event} owner The owner (required, D46S2-R6): pressed for a title action, the PUT is that
     *     operation's, checked by the transport right before it goes out; the viewer's own press otherwise.
     * @param {any} [origin] The press's origin (JE.core.userWrite), else the session of this direct call.
     * @returns {Promise<{ok: boolean, code?: string, accepted?: boolean}>} Outcome (D46S2 audit S3): never sent
     *     (cancelled, or user_changed once its session ended); accepted after its owner ended (ok, accepted: the follows
     *     are reread for this session, the caller shows nothing); answered; unconfirmed (its answer was lost); or failed.
     *     The reread after the PUT never joins a read from before it.
     */
    async function setFollow(key, on, owner, origin) {
        origin = JE.core.userWrite.originOf(origin);
        const action = JE.createSessionAction();
        const submitted = JE.captureSubmitted(owner);
        let accepted = false;
        try {
            await api('/acquire/follows', { method: 'PUT', body: { key, on }, bound: submitted.bound(), session: origin });
        } catch (err) {
            if (err?.sessionChanged) return { ok: false, code: 'user_changed' };
            if (JE.core.userWrite.outcome(err) === 'uncertain') return { ok: false, code: 'unconfirmed' };
            const outcome = JE.core.api.writeOutcome?.(err) || { outcome: 'failed' };
            if (outcome.outcome === 'unsent') return { ok: false, code: 'cancelled' };
            if (outcome.outcome !== 'accepted') {
                return { ok: false, code: err?.responseJSON?.code || (err?.status === 403 ? 'not_allowed' : 'failed') };
            }
            // Taken after another account signed in (D46S2-R12-4): it happened for the origin; nothing is reread or
            // said for the new account.
            if (outcome.sessionChanged) return { ok: true, accepted: true, sessionChanged: true };
            accepted = true;
        }
        if (!JE.core.userWrite.isBound(origin)) return { ok: false, code: 'user_changed' };
        if (!action.current()) return { ok: false, code: 'cancelled' };
        await loadFollows(true);
        if (!action.current()) return { ok: false, code: 'cancelled' };
        return accepted ? { ok: true, accepted: true } : { ok: true };
    }

    /**
     * "Remind {contact}" about a stuck title.
     * @param {string} key Title key.
     * @param {string|null} itemId Jellyfin item shown, if any.
     * @param {Object|Node|Event} owner The owner (required, D46S2-R6): pressed for a title action (the library More
     *     sheet's Remind), the POST is that operation's, checked by the transport right before it goes out.
     * @returns {Promise<{ok: boolean, code?: string, nextAt?: string, accepted?: boolean}>} Outcome (D46S2-R11-9): never
     *     sent (cancelled); accepted after its owner ended (ok, accepted: the caller shows nothing); answered; or failed.
     */
    async function remind(key, itemId, owner, origin) {
        // The reminder's origin (JE.core.userWrite): the caller's, taken when the person acted, else the session now.
        origin = JE.core.userWrite.originOf(origin);
        const submitted = JE.captureSubmitted(owner);
        try {
            const res = await api('/acquire/remind', { method: 'POST', body: { key, itemId: itemId || null }, bound: submitted.bound(), session: origin });
            return { ok: true, nextAt: res?.nextAt };
        } catch (err) {
            const outcome = JE.core.api.writeOutcome?.(err) || { outcome: 'failed' };
            if (outcome.outcome === 'unsent') return { ok: false, code: 'cancelled' };
            if (outcome.outcome === 'accepted') return { ok: true, accepted: true, nextAt: outcome.answer?.nextAt, ...(outcome.sessionChanged ? { sessionChanged: true } : {}) };
            if (err?.sessionChanged) return { ok: false, code: 'user_changed' };
            if (JE.core.userWrite.outcome(err) === 'uncertain') return { ok: false, code: 'unconfirmed' };
            return { ok: false, code: err?.responseJSON?.code || (err?.status === 429 ? 'too_soon' : 'failed'), nextAt: err?.responseJSON?.nextAt };
        }
    }

    /**
     * The user's notification settings and the channels on offer.
     * @param {boolean} [force] Reload.
     * @returns {Promise<Object|null>} Body.
     */
    async function loadPrefs(force) {
        if (state.prefs && !force) return { prefs: state.prefs, channels: state.channels, contact: state.contact, admin: state.admin };
        const identity = state.identity;
        const revision = prefsQueue.revision;
        let body = null;
        try {
            body = await api('/acquire/notify/prefs');
        } catch (_) {
            return null;
        }
        // Another user signed in meanwhile: this answer (their topic, their address) isn't theirs.
        if (identity !== state.identity) return null;
        // A change was queued or answered since this read began: the read may hold less than the page does.
        if (revision === prefsQueue.revision && !prefsQueue.pending) applyPrefs(body);
        return { prefs: state.prefs, channels: state.channels, contact: state.contact, admin: state.admin };
    }

    /**
     * Keeps a prefs answer.
     * @param {Object} body Server answer.
     * @returns {void}
     */
    function applyPrefs(body) {
        if (!body || !body.prefs) return;
        const followedRequests = state.prefs ? state.prefs.autoFollowRequests : undefined;
        state.prefs = body.prefs;
        state.channels = body.channels || null;
        state.contact = body.contact || '';
        state.admin = !!body.admin;
        emit('prefs');
        // "Follow what I request" changed: which titles count as followed changed with it.
        if (state.follows && followedRequests !== undefined && followedRequests !== body.prefs.autoFollowRequests) loadFollows(true);
    }

    /**
     * Sends a settings call and keeps the answer.
     * @param {string} path Route.
     * @param {string} method Method.
     * @param {Object} [body] Body.
     * @param {any} [origin] The change's origin (taken when the person acted; required from a caller that waited, e.g.
     *   the second call of a chain): sent only while it is the signed-in session (JE.core.userWrite).
     * @returns {Promise<{ok: boolean, code?: string, body?: Object}>} Outcome.
     */
    async function prefsCall(path, method, body, origin) {
        const identity = state.identity;
        const binding = JE.core.userWrite.originOf(origin);
        try {
            const res = await prefsQueue.send(bound => api(path, { method, body, session: bound }), binding);
            if (identity !== state.identity) return { ok: false, code: 'user_changed' };
            if (res && res.prefs) applyPrefs(res);
            return { ok: true, body: res };
        } catch (err) {
            if (err?.sessionChanged) return { ok: false, code: 'user_changed' };
            // The server may have committed. Read once after queued writes settle, preserving the original owner and
            // refusing a read overtaken by another edit. A read proves the current document, not this write's outcome.
            if (JE.core.userWrite.outcome(err) === 'uncertain') {
                await prefsQueue.settled();
                if (identity === state.identity && JE.core.userWrite.isBound(binding) && !prefsQueue.pending) {
                    const revision = prefsQueue.revision;
                    try {
                        const stored = await api('/acquire/notify/prefs', { timeoutMs: 10000 });
                        if (identity === state.identity && JE.core.userWrite.isBound(binding)
                            && revision === prefsQueue.revision && !prefsQueue.pending) applyPrefs(stored);
                    } catch (_) { /* Keep uncertainty when the one reconciliation read is unavailable. */ }
                }
                return { ok: false, code: 'unconfirmed' };
            }
            const code = err?.responseJSON?.code || (err?.status === 429 ? 'too_soon' : 'failed');
            return { ok: false, code, status: err?.status };
        }
    }

    // ------------------------------------------------------------------ texts

    const KIND_KEYS = {
        ready: 'arr_notify_ready',
        declined: 'arr_notify_declined',
        approved: 'arr_notify_approved',
        approval: 'arr_notify_approval',
        instance_down: 'arr_notify_instance_down',
        instance_up: 'arr_notify_instance_up',
        low_disk: 'arr_notify_low_disk',
        stuck_digest: 'arr_notify_stuck_digest_short',
        remind: 'arr_notify_remind',
        attention: 'arr_notify_attention',
        test: 'arr_notify_test',
        summary: 'arr_notify_summary'
    };

    /**
     * The en.json key for a notification.
     * @param {Object} item Inbox item.
     * @returns {string} Key.
     */
    function textKey(item) {
        const p = item.params || {};
        if (item.kind === 'episodes') return p.mode === 'single' ? 'arr_notify_episode' : p.mode === 'season' ? 'arr_notify_season' : 'arr_notify_episodes';
        if (item.kind === 'ready' && p.variant === '4k') return 'arr_notify_ready_4k';
        if (item.kind === 'declined' && p.reason) return 'arr_notify_declined_reason';
        if (item.kind === 'approved' && p.shared === '1') return 'arr_notify_approved_shared';
        // A stuck digest reads as a count; which downloads, and why, is the bell's expandable list (digestEntries).
        if ((item.kind === 'stuck_digest' || item.kind === 'summary') && String(p.count) === '1') return `${KIND_KEYS[item.kind]}_one`;
        if (item.kind === 'attention') {
            if (p.code === 'import_blocked') return 'arr_notify_attention_import_blocked';
            if (p.code === 'approved_not_in_arr') return p.variant === '4k' ? 'arr_notify_attention_approved_not_in_4k' : 'arr_notify_attention_approved_not_in_arr';
            // F83: a request held because its episode can't be matched to Sonarr's by id.
            if (p.code === 'episode_identity_unresolved') return 'arr_notify_attention_episode_identity';
        }
        return KIND_KEYS[item.kind] || 'arr_notify_generic';
    }

    /**
     * Builds the notification's text as DOM (the title in bold), never through innerHTML.
     * @param {Object} item Inbox item.
     * @returns {DocumentFragment} Text.
     */
    function buildText(item) {
        const p = Object.assign({}, item.params || {});
        // A title withheld from the recipient: an ask or a reminder names "a title" (as its phone and e-mail text does).
        if (!p.title) p.title = tr(item.kind === 'approval' || item.kind === 'remind' ? 'arr_notify_untitled_ask' : 'arr_notify_untitled');
        if (!p.contact) p.contact = state.contact || tr('arr_contact_default');
        if (!p.user) p.user = tr('arr_notify_someone');
        // Episodes a download covers ("S02E05") follow the title after a space.
        p.scope = p.scope ? ` ${p.scope}` : '';
        const template = tr(textKey(item));
        const frag = document.createDocumentFragment();
        const parts = template.split(/(\{[a-zA-Z]+\})/);
        for (const part of parts) {
            const m = /^\{([a-zA-Z]+)\}$/.exec(part);
            if (!m) {
                if (part) frag.appendChild(document.createTextNode(part));
                continue;
            }
            const value = p[m[1]] != null ? String(p[m[1]]) : '';
            if (m[1] === 'title' || m[1] === 'instance') {
                const strong = document.createElement('strong');
                strong.textContent = value;
                frag.appendChild(strong);
            } else {
                frag.appendChild(document.createTextNode(value));
            }
        }
        return frag;
    }

    // Needs attention reasons a stuck digest lists (the server's DownloadCodes), named as Overview names them.
    const DIGEST_CODES = new Set(['import_blocked', 'import_waiting', 'download_failed', 'download_warning', 'download_stalled', 'client_unavailable']);

    /**
     * The downloads a stuck digest lists, one line each: from its fields (entries), else, for a digest
     * stored before they existed, its one-line list split back into lines. Never more than the digest holds.
     * @param {Object} item Inbox item.
     * @returns {Array<{title: string, scope?: string, instance?: string, reason?: string, text?: string}>} Lines.
     */
    function digestEntries(item) {
        const p = item?.params || {};
        let parsed = null;
        try {
            parsed = typeof p.entries === 'string' ? JSON.parse(p.entries) : null;
        } catch (_) {
            parsed = null;
        }
        if (Array.isArray(parsed)) {
            return parsed.filter(e => e && typeof e.title === 'string').slice(0, 200).map(e => ({
                title: e.title,
                scope: typeof e.scope === 'string' ? e.scope : '',
                instance: typeof e.instance === 'string' ? e.instance : '',
                reason: DIGEST_CODES.has(e.code) ? tr(`arr_ops_code_${e.code}`) : ''
            }));
        }
        return typeof p.items === 'string' && p.items ? p.items.split('; ').slice(0, 200).map(text => ({ title: '', text })) : [];
    }

    /**
     * The plain text of a notification (toasts' aria label, tests).
     * @param {Object} item Inbox item.
     * @returns {string} Text.
     */
    function plainText(item) {
        const div = document.createElement('div');
        div.appendChild(buildText(item));
        return div.textContent || '';
    }

    /**
     * "5 min ago" / "Yesterday".
     * @param {string} iso Time.
     * @returns {string} Text.
     */
    function ago(iso) {
        const t = Date.parse(iso);
        if (isNaN(t)) return '';
        const seconds = Math.round((Date.now() - t) / 1000);
        if (seconds < 60) return tr('arr_notify_just_now');
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return tr('arr_notify_minutes_ago', { n: minutes });
        const hours = Math.round(minutes / 60);
        if (hours < 24) return tr('arr_notify_hours_ago', { n: hours });
        const days = Math.round(hours / 24);
        if (days === 1) return tr('arr_notify_yesterday');
        return JE.arrStatus?.formatDate ? JE.arrStatus.formatDate(iso) : new Date(t).toLocaleDateString();
    }

    /**
     * A small poster for an item: the Jellyfin image when there is one, else TMDB's.
     * @param {Object} item Inbox item.
     * @returns {string|null} URL.
     */
    function posterUrl(item) {
        const p = item.params || {};
        if (p.image && /^[0-9a-f]{32}$/i.test(p.image) && typeof ApiClient !== 'undefined' && ApiClient.getUrl) {
            return ApiClient.getUrl(`/Items/${p.image}/Images/Primary`, { fillHeight: 96, quality: 80 });
        }
        if (typeof p.poster === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(p.poster)) return `https://image.tmdb.org/t/p/w92${p.poster}`;
        return null;
    }

    /**
     * Opens what a notification is about (its Jellyfin page; for a title that isn't in the library,
     * its native details page when offered; else the Requests page or, for an administrators'
     * alert, the tab of it the server linked) and marks it read.
     * @param {Object} item Inbox item.
     * @param {Object} owner The press's owner (JE.ownerOf(event)): opening is its effect (D46S2-R10-1).
     * @returns {void}
     */
    function open(item, owner) {
        // Opening is the press's effect (D46S2-R11-5): every branch (the bell, a library item, a title, the Requests page)
        // acts only for an owner that is current now; an ended or missing one opens and navigates nothing.
        if (!JE.effectOwner(owner, 'a notification')) return;
        if (item.kind === 'summary') {
            N.openBell?.();
            return;
        }
        if (!item.read) markRead([item.id]);
        if (item.itemId && /^[0-9a-f-]{32,36}$/i.test(item.itemId)) {
            if (window.Emby?.Page?.showItem) window.Emby.Page.showItem(item.itemId);
            else window.location.hash = `#/details?id=${encodeURIComponent(item.itemId)}`;
            return;
        }
        // Administrators' alerts link to the Requests page's tab that shows them (Overview, System).
        const fallback = typeof item.link === 'string' && /^#\/requests(\?tab=[a-z]+)?$/.test(item.link) ? item.link : '#/requests';
        const alert = /\?tab=/.test(fallback);
        if (!alert && typeof item.key === 'string' && /^(movie|tv):[a-z]+:[A-Za-z0-9]+(:s\d+(:e\d+)?)?$/.test(item.key) && JE.titleDetails?.available?.() === true) {
            // A title notice: the title's page (a copy the user can open first), else the Requests page.
            const m = /^(.*?)(?::s(\d+)(?::e(\d+))?)?$/.exec(item.key);
            JE.titleDetails.openKey(m[1], { season: m[2] != null ? Number(m[2]) : undefined, episode: m[3] != null ? Number(m[3]) : undefined, modal: false, owner })
                .then((opened) => { if (!opened && JE.effectOwner(owner, 'a notification')) window.location.hash = fallback; });
            return;
        }
        window.location.hash = fallback;
    }

    // ------------------------------------------------------------------ toasts

    /**
     * The toast stack (bottom right; bottom on phones).
     * @returns {HTMLElement} Host.
     */
    function toastHost() {
        let host = document.getElementById('je-notify-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'je-notify-toasts';
            host.className = 'je-notify-toasts';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        return host;
    }

    /**
     * Shows toasts for new notifications, unless the user turned them off or a video plays.
     * @param {Object[]} items New items (newest first).
     * @returns {void}
     */
    function toast(items) {
        if (state.prefs && state.prefs.toasts === false) return;
        if (playing()) {
            state.heldDuringPlayback += items.length;
            return;
        }
        const shown = items.slice(0, MAX_TOASTS);
        for (const item of shown.reverse()) showToast(item);
        if (items.length > MAX_TOASTS) showSummary(items.length - MAX_TOASTS);
    }

    /**
     * One toast.
     * @param {Object} item Inbox item.
     * @returns {void}
     */
    function showToast(item) {
        const host = toastHost();
        const el = document.createElement('div');
        el.className = 'je-notify-toast';
        el.dataset.id = String(item.id);
        const text = document.createElement('button');
        text.type = 'button';
        text.className = 'je-notify-toast-text';
        text.appendChild(buildText(item));
        text.addEventListener('click', (e) => { const owner = JE.ownerOf(e); dismiss(el); open(item, owner); });
        el.appendChild(text);
        if (item.itemId && (item.kind === 'ready' || item.kind === 'episodes')) {
            const play = document.createElement('button');
            play.type = 'button';
            play.className = 'je-notify-toast-play';
            play.textContent = tr('arr_notify_play');
            play.addEventListener('click', (e) => { const owner = JE.ownerOf(e); dismiss(el); open(item, owner); });
            el.appendChild(play);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'je-notify-toast-close';
        close.setAttribute('aria-label', tr('arr_notify_dismiss'));
        close.textContent = '×';
        close.addEventListener('click', () => dismiss(el));
        el.appendChild(close);
        host.appendChild(el);
        toastTimers.set(el, setTimeout(() => dismiss(el), TOAST_MS));
    }

    /**
     * A toast that says more arrived (after playback, or past the toast limit).
     * @param {number} count How many.
     * @returns {void}
     */
    function showSummary(count) {
        showToast({ id: 0, kind: 'summary', params: { count: String(count), title: '' }, read: true, itemId: null });
    }

    /**
     * Removes a toast.
     * @param {HTMLElement} el Toast.
     * @returns {void}
     */
    function dismiss(el) {
        if (!el) return;
        const timer = toastTimers.get(el);
        if (timer) clearTimeout(timer);
        toastTimers.delete(el);
        if (el.parentNode) el.parentNode.removeChild(el);
    }

    /**
     * Removes every toast on screen (playback started, another user signed in).
     * @returns {void}
     */
    function clearToasts() {
        const host = document.getElementById('je-notify-toasts');
        if (host) Array.from(host.children).forEach(dismiss);
    }

    /**
     * After a navigation: playback started (toasts go, none show over the video) or ended (one
     * summary of what arrived meanwhile).
     * @returns {void}
     */
    function afterNavigate() {
        if (playing()) clearToasts();
        else flushHeld();
    }

    /**
     * After playback ends: one toast for what arrived meanwhile.
     * @returns {void}
     */
    function flushHeld() {
        if (!state.heldDuringPlayback || playing()) return;
        const count = state.heldDuringPlayback;
        state.heldDuringPlayback = 0;
        if (state.prefs && state.prefs.toasts === false) return;
        showSummary(count);
    }

    // ------------------------------------------------------------------ lifecycle

    /**
     * Starts following the inbox (once per signed-in user).
     * @returns {void}
     */
    function start() {
        if (state.started || !enabled()) return;
        const hex = userHex();
        if (!hex) return;
        state.started = true;
        const identity = state.identity;
        const inbox = `ntf:u:${hex}`;
        const requests = `req:u:${hex}`;
        // Settings first (toasts on/off), then the inbox; both after the page has settled.
        setTimeout(async () => {
            await loadPrefs(false);
            await refresh();
            if (identity !== state.identity || typeof JE.arr?.onStatusChange !== 'function') return;
            // The inbox key moves with each new notification; the user's request-list key when their
            // own Seerr requests change (a new request is followed automatically).
            state.unsubscribe = JE.arr.onStatusChange([inbox, requests], (keys, info) => {
                const changed = Array.isArray(keys) ? keys : [];
                const all = !!info?.reset || changed.length === 0;
                if (all || changed.some(k => k !== requests)) refresh();
                if ((all || changed.includes(requests)) && state.follows) loadFollows(true);
            });
        }, 600);
        if (state.hooked) return;
        state.hooked = true;
        JE.core?.navigation?.onNavigate?.(() => setTimeout(afterNavigate, 500));
        document.addEventListener('visibilitychange', () => { if (state.started && document.visibilityState === 'visible') refresh(); });
    }

    JE.session?.onUserChange?.('arr-notify', () => {
        state.identity++;
        if (typeof state.unsubscribe === 'function') state.unsubscribe();
        state.unsubscribe = null;
        state.started = false;
        state.loaded = false;
        state.loading = null;
        state.refreshAgain = false;
        state.items = [];
        state.more = false;
        state.unread = 0;
        state.newestSeen = 0;
        state.heldDuringPlayback = 0;
        state.follows = null;
        state.muted = new Set();
        state.requested = new Set();
        state.prefs = null;
        state.channels = null;
        state.contact = '';
        state.admin = false;
        clearToasts();
        emit('inbox');
        emit('follows');
        emit('prefs');
    });

    N.state = state;
    N.buildText = buildText;
    N.plainText = plainText;
    N.textKey = textKey;
    N.digestEntries = digestEntries;
    N.showSummary = showSummary;
    N.flushHeld = flushHeld;
    N.afterNavigate = afterNavigate;
    N.clearToasts = clearToasts;
    N.playing = playing;
    N.prefsCall = prefsCall;
    N.titleOf = titleOf;

    JE.arrNotify = Object.freeze({
        enabled,
        start,
        refresh,
        loadMore,
        markRead,
        loadFollows,
        isFollowing,
        followsAsRequester,
        setFollow,
        remind,
        loadPrefs,
        onChange,
        open,
        ago,
        posterUrl,
        tr,
        get unread() { return state.unread; },
        get items() { return state.items.slice(); },
        get more() { return state.more; },
        get prefs() { return state.prefs; },
        get channels() { return state.channels; }
    });
})(window.JellyfinEnhanced);
