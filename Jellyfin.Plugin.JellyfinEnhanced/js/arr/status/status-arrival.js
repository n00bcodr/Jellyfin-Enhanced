/**
 * @file Requests & downloads: a details page whose title arrives turns into the normal playable page by
 * itself. One rule for every details page (movie, series, season, episode, and the native page of a
 * title that isn't in the library): once the title shown, or the item Jellyfin replaced it with, is
 * available, the page either moves to that item in its own history entry (Jellyfin gives a missing
 * episode or season a new id once its file is there, a native page's title gets its library item, and
 * a movie or episode whose file became a version of a new item moves to that item), or, for the same
 * item (also when Jellyfin adds a version to it), has Jellyfin redraw its own page, so Play, badges,
 * media info and the version picker are Jellyfin's own. A season or series page gets one coalesced redraw
 * per view (later arrivals patch its rows in place); a movie or episode page redraws again for a later
 * version, coalesced per burst and spaced out by the gap, and counts it drawn only once Jellyfin's own
 * version picker shows it (a redraw that didn't take is tried again a few times). It follows the page's status reads (status-details hands each one over; JE's change
 * feed starts them) and Jellyfin's LibraryChanged message about the page's item, season or series,
 * whichever comes first. A change waits while the viewer types, plays or has a dialog open, is checked
 * again right before it happens (a move reads its destination again as the viewer first), happens once
 * per page view, and is dropped when the viewer leaves the page or the user
 * changes. A page Jellyfin restores as it was drawn catches up on what arrived while it was away.
 */
(function (JE) {
    'use strict';

    /** Pauses in ms (tests shorten them). */
    const timing = {
        /** Jellyfin messages close together make one status read. */
        probe: 1200,
        /** How soon a held change looks again whether the viewer is still busy. */
        recheck: 1000,
        /** After a reload, when Jellyfin has drawn its page again (JE's page handlers then run on it). */
        settle: 1500,
        /** Least time between two reloads of one page. */
        gap: 15000,
        /** A movie or episode redraw that Jellyfin's version picker doesn't reflect is tried at most this often per change. */
        redrawTries: 3,
        /** How often per page view a change given up on may get a fresh set of tries (a different read, or Jellyfin adding or removing versions). */
        redrawRenewals: 3,
        /**
         * A season or series page reloads once its status has stopped changing for this long: a season
         * pack arriving file by file, and Jellyfin dropping the missing episodes the files replace (the
         * Jellyfin bridge does that a few seconds after each file), make one reload.
         */
        batch: 6000,
        /** The longest a season or series page waits for its arrivals to settle, from the first one. */
        batchMax: 30000,
        /**
         * After the item a page showed was deleted with nothing in its place yet, when to look again
         * (Jellyfin adds the file's item a moment after it drops the missing one); then the page gives up.
         */
        lost: [1500, 4000, 10000, 30000]
    };
    const LIBRARY_ID = /^[0-9a-f]{32}$/;
    const NOT_TYPING = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden']);
    const DIALOGS = '.dialogContainer .dialog, .dialog.opened, [role="dialog"], [aria-modal="true"], .actionSheet, #jellyfin-enhanced-panel';
    /** Viewer actions that mean they moved the page themselves (their scroll position is theirs to keep). */
    const INTENTS = ['wheel', 'touchmove', 'keydown', 'mousedown'];

    /**
     * The page followed now: { view, id, key, series, kind, base, pending, timer, probeTimer, reloadedAt, tried, parents }.
     * `base` is what the page was drawn with (its first status, then each change acted on; on a movie or
     * episode page, each change Jellyfin's controls were seen to reflect). `drawing` is a movie or episode
     * redraw not yet checked, `failures` its unreconciled attempts, `abandoned` the change given up on,
     * `latest` the newest status read, `pickerSeen` whether Jellyfin's version picker was ever on the page,
     * `renewals` how many fresh sets of tries the view has granted.
     * @type {Object|null}
     */
    let page = null;
    /** Counts the pages followed (a destination check that answers after the page changed is dropped). */
    let generation = 0;
    /** Jellyfin's message subscription: { client, off }. */
    let socket = null;
    /** Pointer ids held on screen, plus a quiet period after scrolling/release. */
    const pressed = new Set();
    let interactingUntil = 0;
    let touching = false;
    let stopInteraction = null;

    /** Records interaction without cancelling or consuming any host input. @returns {void} */
    function trackInteraction() {
        if (stopInteraction) return;
        const bindings = [];
        const bind = (type, fn) => {
            window.addEventListener(type, fn, { capture: true, passive: true });
            bindings.push([type, fn]);
        };
        const quiet = () => { interactingUntil = Date.now() + 350; };
        bind('pointerdown', e => { pressed.add(e.pointerId); });
        for (const type of ['pointerup', 'pointercancel']) bind(type, e => { pressed.delete(e.pointerId); quiet(); });
        bind('touchstart', () => { touching = true; });
        for (const type of ['touchend', 'touchcancel']) bind(type, e => { touching = !!e.touches?.length; quiet(); });
        bind('mousedown', () => { pressed.add('mouse'); });
        bind('mouseup', () => { pressed.delete('mouse'); quiet(); });
        for (const type of ['scroll', 'wheel']) bind(type, quiet);
        bind('blur', () => { pressed.clear(); touching = false; quiet(); });
        stopInteraction = () => {
            for (const [type, fn] of bindings) window.removeEventListener(type, fn, { capture: true });
            stopInteraction = null;
            pressed.clear(); touching = false; interactingUntil = 0;
        };
    }
    /**
     * The scope key (and series item) each item's page showed lately (item id -> { key, series }): a page
     * shown again after Jellyfin deleted its item (the viewer was on other pages meanwhile) still finds
     * its successor, in the same series copy.
     * @type {Map<string, {key: string|null, series: string|null}>}
     */
    const keys = new Map();
    const KEYS_KEPT = 50;
    /**
     * What each details view was last drawn with (view -> { id, base, reloadedAt }). Jellyfin restores a
     * view it showed before as it was drawn, without reading its item again (Back from a series page to
     * its season): the view's first status read is compared with that, not taken as what it shows.
     * @type {WeakMap<HTMLElement, {id: string, base: Object, reloadedAt: number}>}
     */
    let drawn = new WeakMap();

    /**
     * An item id in one form (no dashes, lower case).
     * @param {*} id Id.
     * @returns {string} Id, or ''.
     */
    function norm(id) {
        return typeof id === 'string' ? id.replace(/-/g, '').toLowerCase() : '';
    }

    /**
     * A Jellyfin library item id (never a native page's id or anything else).
     * @param {*} id Candidate.
     * @returns {string|null} The id, normalised, or null.
     */
    function libraryId(id) {
        const n = norm(id);
        return LIBRARY_ID.test(n) && !JE.titleDetails?.isSynthetic?.(n) ? n : null;
    }

    /**
     * The query of the details URL shown now.
     * @returns {URLSearchParams} Parameters.
     */
    function hashParams() {
        try {
            return new URLSearchParams((window.location.hash || '').split('?')[1] || '');
        } catch {
            return new URLSearchParams();
        }
    }

    /**
     * The id of the details page in the URL, or null.
     * @returns {string|null} Id.
     */
    function hashId() {
        return /details/i.test(window.location.hash || '') ? hashParams().get('id') : null;
    }

    /**
     * True when the status surfaces are on.
     * @returns {boolean} On.
     */
    function enabled() {
        return !!JE.arrStatus?.enabled?.();
    }

    /**
     * True when an element is on screen: in the page, not hidden by Jellyfin's classes or attributes,
     * and (where the browser lays pages out) with a box.
     * @param {Element|null} n Element.
     * @returns {boolean} Shown.
     */
    function visible(n) {
        if (!n || !n.isConnected || n.closest('.hide, [hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle ? window.getComputedStyle(n) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        const laidOut = document.body && document.body.getClientRects().length > 0;
        return !laidOut || n.getClientRects().length > 0;
    }

    /**
     * Why the page can't change under the viewer right now, or null: typing in a field, a dialog,
     * sheet or menu open (Jellyfin's or JE's), or something playing.
     * @returns {'typing'|'dialog'|'playing'|null} Reason.
     */
    function busy() {
        if (pressed.size || touching || Date.now() < interactingUntil) return 'interaction';
        const a = document.activeElement;
        if (a && a !== document.body && (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
            || (a.tagName === 'INPUT' && !NOT_TYPING.has(String(a.type || 'text').toLowerCase())))) return 'typing';
        if ([...document.querySelectorAll(DIALOGS)].some(visible)) return 'dialog';
        const bar = document.querySelector('.nowPlayingBar');
        if ((bar && !bar.classList.contains('nowPlayingBar-hidden') && visible(bar))
            || [...document.querySelectorAll('.videoPlayerContainer, #videoOsdPage')].some(visible)) return 'playing';
        return null;
    }

    /**
     * What a status says is available: an episode or movie is there or not, and in how many versions
     * (Jellyfin's version picker: files it keeps as one item); a season or series has so many episodes there.
     * @param {Object} status Status.
     * @returns {{ready: boolean, count: number|null, versions: number|null}} Signature.
     */
    function signature(status) {
        if (status.kind === 'season' || status.kind === 'series') {
            const count = status.summary?.ready;
            return { ready: false, count: Number.isFinite(count) ? count : null, versions: null };
        }
        const ready = status.stage === 'ready';
        return { ready, count: null, versions: ready && Number.isFinite(status.versions) ? status.versions : null };
    }

    /**
     * True for a season or series page (its reloads wait for a burst of arrivals to settle).
     * @param {Object} state Page state.
     * @returns {boolean} A list page.
     */
    function listPage(state) {
        return state.kind === 'season' || state.kind === 'series';
    }

    /**
     * True when `now` has more of the title available than `before`: it arrived, more episodes did, or
     * Jellyfin added a version to the item.
     * @param {{ready: boolean, count: number|null, versions: number|null}} now Signature now.
     * @param {{ready: boolean, count: number|null, versions: number|null}} before Signature the page was drawn with.
     * @returns {boolean} More.
     */
    function more(now, before) {
        return (now.ready && !before.ready) || (now.count != null && before.count != null && now.count > before.count)
            || (now.versions != null && before.versions != null && now.versions > before.versions);
    }

    /**
     * The page state for a details view and its item: the one followed now, or a new one (the old one,
     * with whatever it was waiting to do, is dropped).
     * @param {HTMLElement} view Details page.
     * @param {string} itemId Its item (or native page) id.
     * @returns {Object|null} Page state.
     */
    function follow(view, itemId) {
        if (!view || !itemId) return null;
        if (page && page.view === view && page.id === itemId) return page;
        drop();
        const known = keys.get(norm(itemId));
        const last = drawn.get(view);
        const shownBefore = last && last.id === itemId ? last : null;
        const state = {
            view, id: itemId, key: known?.key || null, series: known?.series || null, kind: null,
            base: shownBefore?.base || null, pending: null, timer: null, probeTimer: null, checking: false,
            lostTimer: null, lostTries: 0, reloadedAt: shownBefore?.reloadedAt || 0, tried: new Set(), parents: new Set([norm(itemId)])
        };
        state.refreshed = false;
        state.drawing = null;
        state.failures = null;
        state.abandoned = null;
        state.latest = null;
        state.pickerSeen = false;
        state.renewals = 0;
        state.settleTimer = null;
        state.endSettle = null;
        page = state;
        trackInteraction();
        state.onHide = () => { if (page === state && !state.refreshing) drop(); };
        view.addEventListener('viewbeforehide', state.onHide);
        generation++;
        if (enabled()) {
            listen();
            learnParents(state);
        }
        return state;
    }

    /**
     * Learns the page item's season and series, whose LibraryChanged entries also concern it (a
     * missing episode's file lands in its season; a new season folder in its series). Read through
     * JE's item cache, which the page's other modules fill.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function learnParents(state) {
        if (!libraryId(state.id) || typeof JE.helpers?.getItemCached !== 'function') return;
        let read;
        try {
            read = JE.helpers.getItemCached(state.id);
        } catch {
            return;
        }
        Promise.resolve(read).then((item) => {
            if (page !== state || !item) return;
            [item.SeriesId, item.SeasonId].forEach((id) => { if (id) state.parents.add(norm(id)); });
            if (item.SeriesId) {
                state.series = norm(item.SeriesId);
                remember(state);
            }
        }).catch(() => { /* the item itself is still followed */ });
    }

    /**
     * Remembers the page's scope key and series item under its item id (the most recent 50).
     * @param {Object} state Page state.
     * @returns {void}
     */
    function remember(state) {
        if (!state.key) return;
        const id = norm(state.id);
        keys.delete(id);
        keys.set(id, { key: state.key, series: state.series });
        if (keys.size > KEYS_KEPT) keys.delete(keys.keys().next().value);
    }

    /**
     * Records what the page is drawn with now.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function drew(state) {
        drawn.set(state.view, { id: state.id, base: state.base, reloadedAt: state.reloadedAt });
    }

    /**
     * What the page shows or is being redrawn with now (a read no newer than a redraw in progress waits for its check).
     * @param {Object} state Page state.
     * @returns {{ready: boolean, count: number|null, versions: number|null}} Signature.
     */
    function expected(state) {
        return state.drawing ? higher(state.base, state.drawing) : state.base;
    }

    /**
     * Whether Jellyfin's own version picker on the page lists `base`'s versions.
     * @param {Object} state Page state.
     * @param {{versions: number|null}} base Signature.
     * @returns {boolean|null} True or false; null when there is nothing to check (one version, or no picker).
     */
    function reconciled(state, base) {
        if (!(base?.versions > 1)) return null;
        const picker = state.view.querySelector('select.selectSource');
        if (picker) {
            state.pickerSeen = true;
            return picker.options.length >= base.versions;
        }
        // The page's picker missing (Jellyfin mid-redraw) is not a redraw that took. Jellyfin shows one
        // whenever the item has more than one version, so a page drawn with several (or that showed one)
        // expects it; only a page with neither can't be checked.
        return state.pickerSeen || state.base?.versions > 1 ? false : null;
    }

    /**
     * Gives a change given up on a fresh set of tries, at most `redrawRenewals` times per page view.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function renew(state) {
        if (state.renewals >= timing.redrawRenewals) return;
        state.renewals++;
        state.abandoned = null;
        state.failures = null;
    }

    /**
     * True when two signatures say the same.
     * @param {{ready: boolean, count: number|null, versions: number|null}} a Signature.
     * @param {{ready: boolean, count: number|null, versions: number|null}} b Signature.
     * @returns {boolean} Same.
     */
    function same(a, b) {
        return !!a && !!b && a.ready === b.ready && a.count === b.count && a.versions === b.versions;
    }

    /**
     * A movie or episode page's newest status read: a change waiting for its redraw (or given up on)
     * follows it, so a version removed meanwhile never stays the target, and a change that is gone
     * no longer waits.
     * @param {Object} state Page state.
     * @param {{ready: boolean, count: number|null, versions: number|null}} now Signature read.
     * @returns {void}
     */
    function track(state, now) {
        state.latest = now;
        if (!state.refreshed) return;
        if (state.abandoned && !same(now, state.abandoned)) renew(state);
        // A change given up on that Jellyfin's picker shows now (it redrew by itself) is drawn, with no redraw.
        if (state.abandoned && more(now, state.base) && reconciled(state, now) === true) commit(state, now);
        const pending = state.pending;
        if (pending?.kind !== 'reload') return;
        if (!more(now, state.base)) state.pending = null;
        else if (!more(now, pending.base)) pending.base = now;
    }

    /**
     * Records a movie or episode change as drawn.
     * @param {Object} state Page state.
     * @param {{ready: boolean, count: number|null, versions: number|null}} base The change.
     * @returns {void}
     */
    function commit(state, base) {
        state.base = base;
        state.failures = null;
        state.abandoned = null;
        drew(state);
    }

    /**
     * After a movie or episode redraw settles: drawn if Jellyfin's picker reflects it, otherwise the
     * baseline stays and the change is planned again (coalesced, after the gap), up to `redrawTries`
     * attempts; then the page is left as it is until a newer change.
     * @param {Object} state Page state.
     * @param {{ready: boolean, count: number|null, versions: number|null}} base The change redrawn.
     * @returns {void}
     */
    function settled(state, base) {
        state.drawing = null;
        // Checked against what was redrawn, or less if a version went meanwhile; a newer arrival has its own plan.
        const latest = state.latest || base;
        const target = more(base, latest) ? latest : base;
        if (reconciled(state, target) !== false) {
            commit(state, target);
            return;
        }
        const tries = state.failures && same(target, state.failures.base) ? state.failures.tries + 1 : 1;
        state.failures = { base: target, tries };
        if (tries >= timing.redrawTries) {
            state.abandoned = target;
            return;
        }
        if (more(latest, state.base)) plan(state, { kind: 'reload', base: latest });
    }

    /**
     * Forgets the page followed (and what it was waiting to do).
     * @returns {void}
     */
    function drop() {
        const state = page;
        if (!state) return;
        clearTimeout(state.timer);
        clearTimeout(state.probeTimer);
        clearTimeout(state.lostTimer);
        clearTimeout(state.settleTimer);
        state.endSettle?.();
        state.view.removeEventListener('viewbeforehide', state.onHide);
        stopInteraction?.();
        page = null;
        generation++;
    }

    /**
     * Subscribes to Jellyfin's LibraryChanged message once per API client: Jellyfin 12's
     * `ApiClient.subscribe`, or the 10.11 API client's `message` event.
     * @returns {void}
     */
    function listen() {
        const client = window.ApiClient;
        if (!client || socket?.client === client) return;
        unlisten();
        let off = null;
        try {
            if (typeof client.subscribe === 'function') {
                const result = client.subscribe(['LibraryChanged'], msg => onLibrary(msg?.Data));
                off = typeof result === 'function' ? result : null;
            } else {
                client._callbacks = client._callbacks || {};
                const list = client._callbacks.message = client._callbacks.message || [];
                const handler = (e, msg) => { if (msg?.MessageType === 'LibraryChanged') onLibrary(msg.Data); };
                list.push(handler);
                off = () => {
                    const at = list.indexOf(handler);
                    if (at !== -1) list.splice(at, 1);
                };
            }
        } catch {
            off = null;
        }
        socket = { client, off };
    }

    /**
     * Ends the LibraryChanged subscription.
     * @returns {void}
     */
    function unlisten() {
        const current = socket;
        socket = null;
        try { current?.off?.(); } catch { /* the client is gone */ }
    }

    /**
     * Jellyfin's LibraryChanged message: when it names the page's item, season or series, the page's
     * status is read again (once for messages close together). A season or series page that Jellyfin
     * removed something from (the missing episode or season a file replaced) has its own list redrawn.
     * @param {Object} data Message data.
     * @returns {void}
     */
    function onLibrary(data) {
        const state = page;
        if (!state || !data || !enabled()) return;
        const ids = [].concat(data.ItemsAdded || [], data.ItemsUpdated || [], data.ItemsRemoved || [], data.FoldersAddedTo || [], data.FoldersRemovedFrom || []);
        if (!ids.some(id => state.parents.has(norm(id)))) return;
        const self = norm(state.id);
        // Jellyfin added or removed items with the page's own item named: the same version count can be a
        // different set of versions now, so a redraw given up on gets a fresh (bounded) chance. Its item
        // being updated again (metadata, scans) is no such evidence.
        if (state.abandoned && ids.some(id => norm(id) === self) && ((data.ItemsAdded || []).length || (data.ItemsRemoved || []).length)) renew(state);
        const removedFromPage = (data.FoldersRemovedFrom || []).some(id => norm(id) === self) && !(data.ItemsRemoved || []).some(id => norm(id) === self);
        if (removedFromPage && state.base && libraryId(state.id) && (state.kind === 'season' || state.kind === 'series')) {
            plan(state, { kind: 'reload', base: state.base, listed: true });
        }
        if (state.probeTimer) return;
        state.probeTimer = setTimeout(() => {
            state.probeTimer = null;
            if (page === state) JE.internals?.arrStatusDetails?.update?.(true);
        }, timing.probe);
    }

    /**
     * The details surface read the page's status (each read, after drawing it). A successor item named
     * by the status opens in the page's place; more of the title than the page was drawn with reloads
     * Jellyfin's page. The first read is what the page was drawn with, unless Jellyfin restored a view
     * it drew before (then that is what it shows), or the page is still marked missing although the
     * item has its file now.
     * @param {HTMLElement} view Details page.
     * @param {string} itemId Its item (or native page) id.
     * @param {Object} status Status read.
     * @returns {void}
     */
    function seen(view, itemId, status) {
        if (!status || !enabled()) return;
        const state = follow(view, itemId);
        if (!state) return;
        if (status.key) {
            state.key = status.key;
            remember(state);
        }
        if (status.kind) state.kind = status.kind;
        const target = libraryId(status.openItemId);
        if (target && target !== norm(state.id)) {
            plan(state, { kind: 'replace', target });
            return;
        }
        // A native page has no library item to reload: it only ever moves to one.
        if (!libraryId(state.id)) return;
        const now = signature(status);
        // The picker the page is shown with counts as seen before any redraw needs it.
        if (!listPage(state) && state.view.querySelector('select.selectSource')) state.pickerSeen = true;
        if (!state.base) {
            state.base = now;
            drew(state);
            if (now.ready && state.kind === 'episode' && missingShown(view)) plan(state, { kind: 'reload', base: now });
            return;
        }
        if (!listPage(state)) track(state, now);
        if (more(now, expected(state))) plan(state, { kind: 'reload', base: now });
    }

    /**
     * True when Jellyfin's page shows the item as missing (its badge in the title area).
     * @param {HTMLElement} view Details page.
     * @returns {boolean} Shown.
     */
    function missingShown(view) {
        return [...view.querySelectorAll('.detailPagePrimaryContainer .missingIndicator, .itemMiscInfo-primary .missingIndicator')].some(visible);
    }

    /**
     * The details surface read nothing for an item that had a status: Jellyfin deleted it (a missing
     * episode or season once its file is there). When the viewer can open an item of the same scope,
     * it opens in the page's place. Jellyfin adds that item a moment after it drops the missing one,
     * so with none yet the page is read again after a pause (and on any live signal meanwhile), a few
     * times, before it gives up. The caller keeps the page as it is while this answers true.
     * @param {HTMLElement} view Details page.
     * @param {string} itemId Its item id.
     * @returns {Promise<boolean>} True while a successor is opening or still looked for.
     */
    async function vanished(view, itemId) {
        if (!enabled()) return false;
        const state = follow(view, itemId);
        if (!state?.key) return false;
        if (state.lostTries > timing.lost.length) return false;
        const answer = await JE.arrStatus.fetchArrival(state.key, libraryId(state.id), state.series);
        if (page !== state) return false;
        const target = libraryId(answer?.itemId);
        if (target && target !== norm(state.id)) {
            plan(state, { kind: 'replace', target });
            return true;
        }
        // Looked again after the last pause: nothing came in its place.
        if (state.lostTries === timing.lost.length) {
            state.lostTries++;
            return false;
        }
        clearTimeout(state.lostTimer);
        state.lostTimer = setTimeout(() => {
            state.lostTimer = null;
            if (page === state) JE.internals?.arrStatusDetails?.update?.(true);
        }, timing.lost[state.lostTries++]);
        return true;
    }

    /**
     * Another module (the native page's first look) found that the page's title is here now: the page
     * moves to that item by the same rule (at once, or once the viewer is done).
     * @param {HTMLElement} view Details page.
     * @param {string} fromId The page's id.
     * @param {string} targetId The library item.
     * @returns {boolean} True when it will move (false: not a library item).
     */
    function open(view, fromId, targetId) {
        const target = libraryId(targetId);
        const state = follow(view, fromId);
        if (!state || !target || target === norm(fromId)) return false;
        plan(state, { kind: 'replace', target });
        return true;
    }

    /**
     * The signature with the most of the title available of two.
     * @param {{ready: boolean, count: number|null, versions: number|null}} a Signature.
     * @param {{ready: boolean, count: number|null, versions: number|null}} b Signature.
     * @returns {{ready: boolean, count: number|null, versions: number|null}} The higher.
     */
    function higher(a, b) {
        const counts = [a.count, b.count].filter(n => n != null);
        const versions = [a.versions, b.versions].filter(n => n != null);
        return { ready: a.ready || b.ready, count: counts.length ? Math.max(...counts) : null, versions: versions.length ? Math.max(...versions) : null };
    }

    /**
     * Sets what the page is to do (moving to another item wins over a reload) and tries it. A season
     * or series page waits for its arrivals to settle: the wait starts again only when more of the
     * title is available, or Jellyfin removed something the page lists (the same count read again,
     * a download moving along, is no change), and never runs past `batchMax` from the first change.
     * After its one redraw a season or series page takes later arrivals in place (its rows are patched).
     * A movie or episode page's version picker is Jellyfin's own, so a later version waits the same way
     * for its burst to settle and then has Jellyfin redraw again; until then the page is not recorded
     * as drawn with it.
     * @param {Object} state Page state.
     * @param {{kind: 'replace'|'reload', target?: string, base?: Object, listed?: boolean}} action Action.
     * @returns {void}
     */
    function plan(state, action) {
        if (page !== state) return;
        if (action.kind === 'replace' && state.tried.has(action.target)) return;
        if (action.kind === 'reload' && state.abandoned && !more(action.base, state.abandoned)) return;
        if (action.kind === 'reload' && state.refreshed && listPage(state)) {
            state.base = higher(state.base, action.base);
            drew(state);
            return;
        }
        const prior = state.pending;
        if (action.kind === 'reload' && prior?.kind === 'replace') return;
        if (action.kind !== 'reload' || (!listPage(state) && !state.refreshed)) {
            state.pending = action;
            schedule(state, 0);
            return;
        }
        const now = Date.now();
        const waiting = prior?.kind === 'reload' ? prior : null;
        const next = waiting
            // A movie or episode page waits for the newest read; a list page for the most it has seen.
            ? { kind: 'reload', base: listPage(state) ? higher(waiting.base, action.base) : action.base, since: waiting.since }
            : { kind: 'reload', base: action.base, since: now };
        state.pending = next;
        const changed = !waiting || action.listed || more(next.base, waiting.base);
        if (!changed && (state.timer || state.checking)) return;
        schedule(state, Math.min(timing.batch, next.since + timing.batchMax - now));
    }

    /**
     * Tries the pending action after a pause.
     * @param {Object} state Page state.
     * @param {number} wait Pause.
     * @returns {void}
     */
    function schedule(state, wait) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = null;
            run(state);
        }, Math.max(0, wait));
    }

    /**
     * True while the followed page is the one shown.
     * @param {Object} state Page state.
     * @returns {boolean} Shown.
     */
    function shown(state) {
        return state.view.isConnected && !state.view.classList.contains('hide') && hashId() === state.id;
    }

    /**
     * Does the pending action now, unless the page isn't shown (another page: dropped; hidden: later)
     * or the viewer is busy (later), or the page was reloaded a moment ago (after the gap).
     * @param {Object} state Page state.
     * @returns {void}
     */
    function run(state) {
        if (page !== state || !state.pending) return;
        if (state.checking) {
            schedule(state, timing.recheck);
            return;
        }
        if (!shown(state)) {
            if (hashId() !== state.id) drop();
            else schedule(state, timing.recheck);
            return;
        }
        if (busy()) {
            schedule(state, timing.recheck);
            return;
        }
        const action = state.pending;
        if (action.kind === 'reload' && state.reloadedAt) {
            const wait = state.reloadedAt + timing.gap - Date.now();
            if (wait > 0) {
                schedule(state, wait);
                return;
            }
        }
        if (action.kind === 'replace') {
            go(state, action).catch(() => { /* the page stays as it is */ });
            return;
        }
        state.pending = null;
        // A slow host redraw that caught up meanwhile needs no other.
        if (!listPage(state) && more(action.base, state.base) && reconciled(state, action.base) === true) {
            commit(state, action.base);
            return;
        }
        reload(state, action.base);
    }

    /**
     * Moves to the pending item once Jellyfin answers that the viewer can still open it. A move can wait
     * a long while (a dialog, playback), and their library access or parental limits can change
     * meanwhile, so the item is read again as the signed-in viewer right before: an item they can't
     * open drops the move. The user, the page and the viewer are checked again after the answer.
     * @param {Object} state Page state.
     * @param {{kind: 'replace', target: string}} action The move.
     * @returns {Promise<void>} Done.
     */
    async function go(state, action) {
        const epoch = JE.session?.getEpoch?.();
        const followed = generation;
        state.checking = true;
        let open = false;
        try {
            open = await openable(action.target);
        } finally {
            state.checking = false;
        }
        if (page !== state || generation !== followed) return;
        if (typeof JE.session?.isCurrent === 'function' && !JE.session.isCurrent(epoch)) {
            drop();
            return;
        }
        // A newer change for the page took over meanwhile (it is scheduled).
        if (state.pending !== action) return;
        if (!open) {
            state.pending = null;
            return;
        }
        if (!shown(state)) {
            if (hashId() !== state.id) drop();
            else schedule(state, timing.recheck);
            return;
        }
        if (busy()) {
            schedule(state, timing.recheck);
            return;
        }
        state.pending = null;
        state.tried.add(action.target);
        move(state, action.target);
    }

    /**
     * True when Jellyfin gives the signed-in viewer the item (its own library access and parental
     * checks): read afresh, never from a cache.
     * @param {string} target Library item id.
     * @returns {Promise<boolean>} They can open it.
     */
    async function openable(target) {
        const client = window.ApiClient;
        const user = client?.getCurrentUserId?.();
        if (!user || typeof client.getItem !== 'function') return false;
        try {
            const item = await client.getItem(user, target);
            return norm(item?.Id) === target;
        } catch {
            return false;
        }
    }

    /**
     * Shows another item in the page's history entry (Back goes where it went before), keeping the
     * server and context of the URL.
     * @param {Object} state Page state.
     * @param {string} target Library item id.
     * @returns {void}
     */
    function move(state, target) {
        const params = hashParams();
        params.set('id', target);
        if (!params.get('serverId')) {
            const server = window.ApiClient?.serverId?.();
            if (server) params.set('serverId', server);
        }
        const path = (window.location.hash || '').split('?')[0] || '#/details';
        drop();
        window.location.replace(`${path}?${params.toString()}`);
    }

    /**
     * Has Jellyfin reload its own details page for the same item: JE's copy of the item is refreshed,
     * then the page gets the view events a fresh show sends (its controller reads the item again and
     * draws Play, badges, media info and versions; the hide first releases what its last show
     * subscribed). Only the page hears them (they don't bubble: no theme music, no router). Once it has
     * redrawn, JE reuses its accepted status before its page handlers run again, and the viewer's scroll
     * position and focus stay, unless they moved meanwhile. A season or series page counts the change
     * drawn at once; a movie or episode page only once its redraw is seen to have taken (`settled`).
     * @param {Object} state Page state.
     * @param {{ready: boolean, count: number|null, versions: number|null}} base What the page shows from now on.
     * @returns {void}
     */
    function reload(state, base) {
        const list = listPage(state);
        if (list) state.base = base;
        else state.drawing = base;
        if (!list && state.view.querySelector('select.selectSource')) state.pickerSeen = true;
        state.refreshed = true;
        state.reloadedAt = Date.now();
        if (list) drew(state);
        const scroller = document.scrollingElement || document.documentElement;
        const top = scroller.scrollTop;
        const focused = document.activeElement && document.activeElement !== document.body && state.view.contains(document.activeElement) ? document.activeElement : null;
        let moved = false;
        const mark = () => { moved = true; };
        INTENTS.forEach(type => window.addEventListener(type, mark, { capture: true, passive: true }));
        state.endSettle = () => INTENTS.forEach(type => window.removeEventListener(type, mark, { capture: true }));
        try {
            const refreshed = JE.helpers?.getItemCached?.(state.id, { forceRefresh: true });
            if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => { /* Jellyfin reads it itself */ });
        } catch {
            // Jellyfin reads the item itself.
        }
        const detail = { type: state.view.getAttribute('data-type'), isRestored: false, params: Object.fromEntries(hashParams()) };
        state.refreshing = true;
        state.view.dispatchEvent(new CustomEvent('viewbeforehide', { detail, bubbles: false, cancelable: false }));
        state.view.dispatchEvent(new CustomEvent('viewshow', { detail, bubbles: false, cancelable: false }));
        state.refreshing = false;
        state.settleTimer = setTimeout(() => {
            state.settleTimer = null;
            state.endSettle?.();
            state.endSettle = null;
            if (page !== state) return;
            if (!shown(state)) {
                // Not checked: the baseline stays, so the next read (or a later visit) tries again.
                state.drawing = null;
                return;
            }
            if (!moved && scroller.scrollTop !== top) scroller.scrollTop = top;
            const active = document.activeElement;
            if (focused && focused.isConnected && (!active || active === document.body)) focused.focus({ preventScroll: true });
            if (!list) settled(state, base);
            JE.internals?.arrStatusDetails?.repaint?.();
            JE.core?.navigation?.replayViewShow?.(state.view);
        }, timing.settle);
    }

    JE.core?.navigation?.onNavigate?.(() => { if (page && !shown(page)) drop(); });

    JE.session?.onUserChange?.('arr-status-arrival', () => {
        drop();
        unlisten();
        keys.clear();
        drawn = new WeakMap();
    });

    JE.internals = JE.internals || {};
    JE.internals.arrStatusArrival = { seen, vanished, open, busy, drop, timing, state: () => page };
})(window.JellyfinEnhanced);
