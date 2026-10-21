/** Provider action contract. Transports, permissions and privacy updates stay with their existing owners. */
(function (JE) {
    'use strict';
    const providers = new Map();
    const admissions = new WeakMap();
    const pressing = new Set();
    const presses = new WeakMap();
    const A = JE.titleActions = {};

    /** Normalizes known metadata without guessing a media kind or making a native write ID. */
    function context(data) {
        if (!data) return null;
        const parsed = JE.titleDetails?.parse?.(data.itemId || data.Id || data.id);
        if (parsed && !['movie', 'series', 'season', 'episode'].includes(parsed.kind)) return null;
        const raw = String(parsed?.kind || data.mediaType || data.type || data.Type || '').toLowerCase();
        const type = raw === 'movie' ? 'movie' : ['tv', 'series', 'season', 'episode'].includes(raw) ? 'tv' : null;
        const id = Number(parsed?.tmdbId || data.tmdbId || data.ProviderIds?.Tmdb || (data.mediaType ? data.id : null));
        const season = parsed && ['season', 'episode'].includes(parsed.kind) ? parsed.season : data.season;
        const episode = parsed?.kind === 'episode' ? parsed.episode : data.episode;
        if (!type || !Number.isInteger(id) || id <= 0 || id > 2147483647 ||
            [season, episode].some(n => n != null && (!Number.isInteger(n) || n < 0 || n > 65535)) ||
            (type === 'movie' && season != null) || (episode != null && season == null)) return null;
        const titleKey = type + ':tmdb:' + id;
        return Object.freeze({ type, tmdbId: id, titleKey, key: titleKey + (season != null ? ':s' + season : '') + (episode != null ? ':e' + episode : ''),
            season, episode, variant: data.variant === '4k' ? '4k' : 'standard', shownItemId: data.absent === false ? data.Id || null : null, name: String(data.Name || data.title || data.name || ''), data,
            absent: parsed ? true : data.absent !== false && !data.mediaInfo?.jellyfinMediaId && !data.Id });
    }

    /** Parses only the published stable key, including a precise child scope. */
    function fromKey(key) {
        const m = /^(movie|tv):tmdb:([1-9][0-9]*)(?::s([0-9]+)(?::e([0-9]+))?)?$/.exec(String(key || ''));
        return m ? context({ mediaType: m[1], id: Number(m[2]), ...(m[3] != null ? { season: Number(m[3]) } : {}), ...(m[4] != null ? { episode: Number(m[4]) } : {}) }) : null;
    }

    /** The route a continuation belongs to: the semantic route (core: the view, the shown item, a shared-title link, a search query, a tab). */
    const routeKey = hash => JE.routeKey(hash);

    // The lifecycle (D53, ended is forever) is the core's (D46S2-R10 shape 6): every owner token carries its session,
    // document and semantic route, so an operation ends with a route change (a new search query or hub tab included),
    // a user switch, the document leaving or coming back, and the action bar going off ({@link end}).
    let lifecycle = 0;
    const live = new Set();
    /** Ends every operation started so far (a user switch, the feature going off, disposal). */
    function end() { lifecycle++; for (const token of [...live]) token.end(); live.clear(); }
    JE.session?.onUserChange?.('title-actions-lifecycle', end);
    /** Releases every operation that has ended (D46S2-R11-13): each route change prunes the registry. */
    const prune = () => { for (const token of live) if (!token.current()) live.delete(token); };
    for (const type of ['hashchange', 'popstate', 'je:navigate']) window.addEventListener(type, () => queueMicrotask(prune));
    // Leaving the document (pagehide, freeze) and coming back (pageshow from the cache, resume) end every operation in
    // core; the hosts reconcile fresh controls for the new one (no new view is shown on a restore).
    const own = event => event.target?.nodeType !== 1;
    window.addEventListener('pagehide', event => { if (own(event)) A.departed?.(); });
    document.addEventListener('freeze', event => { if (own(event)) A.departed?.(); });
    window.addEventListener('pageshow', event => { if (own(event) && event.persisted) A.restored?.(); });
    document.addEventListener('resume', event => { if (own(event)) A.restored?.(); });

    /**
     * One owner generation (D53): an operation token (core `JE.operation`) with the session, document and semantic
     * route it started in, and the mount (`mount()` says the owning host is still this one). Every setup/action
     * continuation checks `current()` after each await, and every effect checks it as it happens. Once it isn't current
     * it never is again, even if the page, card or user comes back. Two owners use it. The OFFER is whatever showed a
     * choice (a sheet, row or menu); a press counts only while it is current. The OPERATION starts when the person
     * submits: it belongs to the session, the route and the owning row/card, not to the offer, so it survives the offer
     * closing.
     */
    function generation(mount = () => true) {
        const born = lifecycle;
        // Bounded (D46S2-R11-13): the registry holds only operations that are still current; an ended one (its route,
        // session, document or mount gone) leaves it as the next one is minted, so it never grows with reconciliation
        // passes or navigation.
        for (const token of live) if (!token.current()) live.delete(token);
        const token = JE.operation({ mount: () => lifecycle === born && mount() !== false });
        // Ending it releases it at once (D46S2-R12-8): an offer that closed, failed or was superseded is not kept until
        // the next mint or route change.
        const end = token.end;
        token.end = () => { live.delete(token); end(); };
        live.add(token);
        return token;
    }
    /**
     * Finishes an owner (D46S2-R12-8): an OFFER (a menu's opening, a sheet's lease) ends on every terminal path — its
     * normal close, a rejected or failed opening, a newer opening superseding it — and leaves the registry with it.
     */
    function finish(token) { if (token) token.end(); }
    /**
     * Releases a SUBMITTED operation from the registry once its run has settled (D46S2-R12-8): it is not ended (what it
     * opened, a sheet or a drawer, lives on with its own scope and closes with it), but the registry no longer holds it.
     */
    function release(token) { if (token) live.delete(token); }

    /** True for a cancelled lookup, which ends the setup rather than becoming a fallback state. */
    const cancelled = error => error?.name === 'AbortError';

    /** Reuses the server's provider admission, with fresh scope/access checks after metadata awaits. */
    async function admit(c, action) {
        if (!c || !action.current()) return false;
        const q = new URLSearchParams();
        if (c.season != null) q.set('season', c.season);
        if (c.episode != null) q.set('episode', c.episode);
        const reply = await JE.core.api.plugin('/title-actions/' + c.type + '/' + c.tmdbId + (q.size ? '?' + q : ''), { skipCache: true, skipRetry: true });
        if (!action.current() || reply?.allowed !== true) return false;
        admissions.set(c, { action, itemId: reply.itemId });
        return true;
    }

    /** Makes an authenticated deep link containing identity only; the recipient supplies all policy/state. */
    function shareUrl(c) {
        const url = new URL(window.location.href);
        url.hash = '/home?jeTitle=' + encodeURIComponent(c.key);
        url.search = '';
        return url.href;
    }

    /** Resolves a shared link only after the receiver's access and projection have been read. */
    async function receive(key) {
        const c = fromKey(key);
        if (!c) return false;
        const action = generation();
        try {
            if (!await admit(c, action)) return false;
            if (!admissions.get(c)?.itemId) {
            await JE.core.api.plugin('/native-details/title/' + c.type + '/' + c.tmdbId, { skipCache: true });
            if (!action.current()) return false;
            if (c.season != null) await JE.core.api.plugin('/native-details/title/tv/' + c.tmdbId + '/season/' + c.season, { skipCache: true });
            if (!action.current()) return false;
            }
            if (!await admit(c, action)) return false;
            const actual = admissions.get(c)?.itemId;
            if (!action.current()) return false;
            // Opening navigates, so the route changes: report the opening itself, not the generation after it.
            if (actual && JE.titleDetails.openItem) { JE.titleDetails.openItem(actual); return true; }
            // The link's operation reaches whatever opens it, the fallback window included (D46S2-R8-1).
            return await JE.titleDetails.openKey(c.key, { owner: action }) === true;
        } catch (_) { return false; }
    }

    /**
     * Presses an owner's control for a submitted operation: the click carries it (JE.press), and owners whose write
     * follows a confirmation or an await (Spoiler Guard, Hide, Report) take it from their event and recheck it right
     * before writing.
     */
    function dispatch(source, operation) {
        pressing.add(source);
        try { return JE.press(source, operation); } finally { pressing.delete(source); }
    }

    /**
     * Makes a direct press on an owner's Guard, Hide or Report control in a row the adapter manages an
     * operation of that row (`owner`): the press is re-dispatched with it, so the owner's confirmation
     * and write recheck it. One listener per node; a remount only updates its owner. When the owner is
     * no longer current, an adapter-made control does nothing and a native one behaves as without us.
     */
    function bindPress(node, owner, { native = false } = {}) {
        const bound = presses.has(node);
        presses.set(node, { owner, native });
        if (bound) return;
        node.addEventListener('click', event => {
            const { owner: live, native: own } = presses.get(node);
            if (pressing.has(node) || (own && !live.current())) return;
            event.preventDefault(); event.stopImmediatePropagation();
            // Only a press someone made becomes the row's operation (D46S2-R11-1): the viewer's own (a trusted or the
            // host's verified activation) or a title action's; a script's click is no one's and does nothing.
            if (!JE.ownerOf(event)) return;
            // A fresh event (JE.press): click() is a no-op while this element's own click is still in progress.
            if (live.current()) dispatch(node, generation(() => live.current()));
        }, true);
    }

    /** A source control can still be pressed: sheet-owned controls go with their sheet, row controls stay. */
    function pressable(entry) {
        const source = entry.source;
        return (source === entry.control || source.isConnected) && !source.disabled && source.getAttribute('aria-disabled') !== 'true';
    }

    /**
     * One submitted operation, carried through admission, the owner's run and its confirmations. It has a lifetime of
     * its own (its session, route and mount), independent of the offer that showed the choice, and leaves the registry
     * once its run has settled (D46S2-R12-8).
     */
    async function invoke(c, entry, opener, operation = generation()) {
        try {
            if (!operation.current() || entry.disabled) return false;
            if (entry.source) {
                if (c?.absent && !await admit(c, operation)) return false;
                if (!operation.current() || !pressable(entry)) return false;
                entry.beforeRun?.();
                dispatch(entry.source, operation);
                return true;
            }
            if (!await admit(c, operation) || !operation.current()) return false;
            entry.beforeRun?.();
            const result = await entry.run(opener, operation);
            return operation.current() && result !== false;
        } finally { release(operation); }
    }

    /** Registers a lazy capability (4c3b: provider returns null until permitted). No list storage lives here. */
    function register(name, provider) {
        if (providers.has(name)) throw new Error('Action provider already registered: ' + name);
        providers.set(name, provider);
        return () => { if (providers.get(name) === provider) providers.delete(name); };
    }

    /** Existing owner controls supplied by a host take precedence over adapted provider entries. */
    async function entries(c, options = {}) {
        if (!c) return [];
        const action = options.action || generation();
        const out = [];
        const root = options.root;
        const displayName = () => c.name || root?.querySelector('.nameContainer .itemName:not(.originalTitle)')?.textContent || '';
        /** Finds an existing control, preserving its original handler and state. */
        function source(id, selector, group, label, icon) {
            const node = root?.querySelector(selector);
            if (!node || node.hidden || node.classList.contains('hide')) return false;
            out.push({ id, source: node, group, label: node.getAttribute('aria-label') || node.title || label, icon,
                state: id === 'manage' ? JE.t('title_actions_admin') : undefined });
            return true;
        }
        if (!source('guard', '.je-spoiler-pending-detail, .je-spoiler-pending-btn, .je-spoiler-blur-btn', 'view', JE.t('title_actions_guard'), 'blur_on')) {
            const node = JE.internals?.spoilerGuard?.buildSeerrToggle?.({ ...c.data, id: c.tmdbId }, c.type);
            if (node) out.push({ id: 'guard', group: 'view', label: node.title || JE.t('title_actions_guard'), icon: 'blur_on', control: node });
        }
        if (!source('hide', '.je-detail-hide-btn, .je-hide-btn', 'view', JE.t('hidden_content_hide_button'), 'visibility')) {
            const node = JE.hiddenContent?.buildTitleControl?.({ type: c.type, tmdbId: c.tmdbId, name: c.name }, { detail: true, surface: options.surface || 'details' });
            if (node) out.push({ id: 'hide', group: 'view', label: node.title, icon: 'visibility', control: node });
        }
        if (JE.arrNotify?.enabled?.() && c.episode == null && !source('follow', '.je-notify-follow', 'requests', JE.t('title_actions_follow'), 'notifications_none')) {
            await JE.arrNotify.loadFollows(false);
            if (!action.current()) return [];
            out.push({ id: 'follow', group: 'requests', label: JE.t('title_actions_follow'), icon: 'notifications_none',
                pressed: JE.arrNotify.isFollowing(c.key), run: async (_opener, submitted) => {
                    const on = !JE.arrNotify.isFollowing(c.key);
                    const result = await JE.arrNotify.setFollow(c.key, on, submitted);
                    if (submitted.current() && !result.ok) JE.toast?.(JE.t('arr_notify_follow_failed'));
                    return result.ok;
                } });
        }
        // Status is per title (the endpoint refuses season/episode keys); Manage still opens on the exact scope.
        const status = JE.arrStatus?.enabled?.() && JE.arrStatus.fetchKey ? await JE.arrStatus.fetchKey(c.titleKey) : null;
        if (!action.current()) return [];
        const titleStatus = status?.items?.[0];
        if (c.absent && JE.arrAsk?.enabled?.() && JE.arrAskSheet) {
            const caps = await JE.arrAsk.me();
            if (!action.current()) return [];
            // Not while the title is already asked for, on its way or here: the page's own request control shows no
            // Request then either (the status says where it is), so the bar never offers one over it (Q-PLAYR18-2).
            // A row (`options.reconcile`) gets it either way, marked `askable`: it follows the newest status (D46S2-R7-5).
            const askable = JE.internals?.arrAskSheet?.askable?.(titleStatus) !== false;
            if (JE.arrAsk.canAsk(caps, c.type === 'movie' ? 'movie' : 'series') && (askable || options.reconcile)) out.push({ id: 'request', group: 'requests', icon: 'add', label: JE.t('jellyseerr_btn_request'), askable,
                run: (opener, submitted) => JE.arrAskSheet.open({ key: c.titleKey, kind: c.type === 'movie' ? 'movie' : 'series', name: displayName(),
                    initialSeason: c.season, initialEpisode: c.episode }, { opener, operation: submitted }) });
        } else if (c.absent && !JE.arrAsk?.enabled?.() && JE.pluginConfig?.JellyseerrEnabled && JE.jellyseerrMoreInfo?.open && !root?.matches?.('.je-more-info-modal')) {
            // Not in the window itself: its own Request is the row's primary there, and a second window would replace
            // (and so end) the one it was pressed in.
            out.push({ id: 'request', group: 'requests', icon: 'add', label: JE.t('jellyseerr_btn_request'), run: (_opener, submitted) => JE.jellyseerrMoreInfo.open(c.tmdbId, c.type, { season: c.season, episode: c.episode }, submitted) });
        }
        // The window's 4K request (Q-D46S2FIX5-1 (b)): its compact row hides Seerr's 4K split, so its More sheet offers
        // it while Seerr 4K is on. Like every entry it belongs to the operation the press submitted (D46S2-R7-1), also in a
        // window opened natively.
        if (root?.matches?.('.je-more-info-modal') && typeof root.jeRequest4k === 'function')
            out.push({ id: 'request-4k', group: 'requests', icon: '4k', label: JE.t('jellyseerr_btn_request_4k'), run: (_opener, submitted) => root.jeRequest4k(submitted) });
        if (JE.pluginConfig?.JellyseerrShowReportButton && JE.jellyseerrIssueReporter) {
            if (!source('report', '.jellyseerr-report-issue-icon', 'requests', JE.t('jellyseerr_report_issue_button'), 'warning')) {
                const status = JE.pluginConfig.JellyseerrEnabled ? await JE.jellyseerrAPI?.checkUserStatus?.() : null;
                if (!action.current() || status?.cancelled) return [];
                const permitted = status?.active === true && status.userFound === true && status.canReportIssues !== false;
                const record = permitted && JE.jellyseerrAPI?.reportContext ? await JE.jellyseerrAPI.reportContext(c.tmdbId, c.type, action) : null;
                if (!action.current()) return [];
                const ok = permitted && (!JE.jellyseerrAPI?.reportContext || !!record?.mediaId);
                const item = { jeAbsent: c.absent, Type: c.episode != null ? 'Episode' : c.season != null ? 'Season' : c.type === 'movie' ? 'Movie' : 'Series', IndexNumber: c.episode ?? c.season, ParentIndexNumber: c.season };
                const control = ok && JE.jellyseerrIssueReporter.createReportButton?.(root || document.body, String(c.tmdbId), displayName(), c.type, null, item);
                out.push({ id: 'report', group: 'requests', icon: 'warning', label: JE.t('jellyseerr_report_issue_button'),
                    disabled: !ok, reason: JE.t(!JE.pluginConfig.JellyseerrEnabled ? 'title_actions_report_no_seerr' : status?.canReportIssues === false ? 'title_actions_report_no_permission' : permitted && !record?.mediaId ? 'title_actions_report_no_record' : 'title_actions_report_no_account'),
                    ...(control ? { control } : { run: (_opener, submitted) => JE.jellyseerrIssueReporter.showReportModal(String(c.tmdbId), displayName(), c.type, null, item, submitted) }) });
            }
        }
        if (JE.pluginConfig?.ArrManageDrawerEnabled && JE.arrManage && titleStatus?.admin) {
            if (!source('manage', '.je-manage-open, .je-arr-modal-manage', 'requests', JE.t('arr_manage_button'), 'tune'))
                out.push({ id: 'manage', group: 'requests', icon: 'tune', label: JE.t('arr_manage_button'),
                    state: JE.t('title_actions_admin'), run: (_opener, submitted) => JE.arrManage.open({ key: c.key }, { operation: submitted }) });
        }
        const proof = admissions.get(c);
        // Open goes to the accessible actual copy; never offered on that copy's own page.
        const same = id => id && String(id).replace(/-/g, '').toLowerCase() === String(proof.itemId).replace(/-/g, '').toLowerCase();
        if (proof?.action.current() && proof.itemId && !same(c.shownItemId)) out.push({ id: 'open', group: 'watch', icon: 'open_in_new', label: JE.t('native_details_open'), run: () => {
            const latest = admissions.get(c);
            if (!latest?.action.current() || !latest.itemId) return false;
            JE.titleDetails.openItem(latest.itemId);
        } });
        out.push({ id: 'share', group: 'other', icon: 'share', label: JE.t('title_actions_share'), run: async (_opener, submitted) => {
            const url = shareUrl(c);
            // The fallback link sheet is the operation's own (D46S2-R6-4): it opens only while the operation is current and
            // closes with it, also after Web Share or the clipboard refused.
            if (navigator.share) { try { await navigator.share({ url }); } catch (error) { if (submitted.current() && error?.name !== 'AbortError') JE.titleActions.showLink?.(url, submitted); } }
            else if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(url); if (submitted.current()) JE.toast?.(JE.t('title_actions_copied')); } catch (_) { if (submitted.current()) JE.titleActions.showLink?.(url, submitted); } }
            else JE.titleActions.showLink?.(url, submitted);
        } });
        for (const provider of providers.values()) {
            const result = await provider(c, { action, root, surface: options.surface });
            if (!action.current()) return [];
            if (result) out.push(...(Array.isArray(result) ? result : [result]));
        }
        return action.current() ? out : [];
    }
    /** Diagnostics (read-only): how many operations the registry holds now (bounded: D46S2-R11-13). */
    const registrySize = () => live.size;
    Object.assign(A, { context, fromKey, routeKey, generation, finish, release, end, cancelled, admit, shareUrl, receive, dispatch, bindPress, invoke, register, entries, registrySize });
})(window.JellyfinEnhanced);
