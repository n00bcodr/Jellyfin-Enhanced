/**
 * @file Requests & downloads, phase 1: the status pill and journey on movie and episode details
 * pages, the summary line on series and season pages (season pages also get episode chips and the
 * "Not in the library yet" banner from status-episodes.js), and the admin explanation lines. One
 * request per page view; re-rendered in place when the change feed (or JE.arrStatus.refresh)
 * reports a change for the page's title. Each read is handed to status-arrival.js, which turns the
 * page into the playable one once its title arrives.
 * D95: a title on its way opens with its journey shown (the chevron closes it for that page view), its poster
 * shows the download progress, and a title that is ready shows nothing at all.
 */
(function (JE) {
    'use strict';

    const SURFACE = 'details';
    /** Pauses before asking again after a failed read (a re-read keeps following meanwhile); the last one repeats. */
    const RETRY_MS = [5000, 15000, 60000];
    let current = null; // { page, itemId, epoch, userId, serverId, controller, loading, dirty, quiet, unsubscribe, retries, retryTimer }
    let started = false;
    /** D95: the page view whose journey the viewer closed ({page, itemId}), or null. */
    let collapsed = null;

    /**
     * The details page currently shown, or null.
     * @returns {HTMLElement|null} Page.
     */
    function visiblePage() {
        return document.querySelector('#itemDetailPage:not(.hide)');
    }

    /**
     * Item id from the URL hash of a details page.
     * @returns {string|null} Id.
     */
    function itemIdFromHash() {
        const hash = window.location.hash || '';
        if (!/details/i.test(hash)) return null;
        try {
            return new URLSearchParams(hash.split('?')[1] || '').get('id');
        } catch {
            return null;
        }
    }

    /**
     * Server identity from both the route and API client, including a server switch on the same item.
     * @returns {string} Server identity.
     */
    function serverIdentity() {
        const route = new URLSearchParams((window.location.hash || '').split('?')[1] || '');
        return JSON.stringify([route.get('serverId'), window.ApiClient?.serverId?.()]);
    }

    /**
     * Whether a read still belongs to the page and signed-in identity shown now.
     * @param {Object} state Read state.
     * @returns {boolean} Same context.
     */
    function sameContext(state) {
        return state.page === visiblePage() && state.itemId === itemIdFromHash()
            && state.epoch === JE.session?.getEpoch?.()
            && state.userId === window.ApiClient?.getCurrentUserId?.()
            && state.serverId === serverIdentity();
    }

    /**
     * Where the status block goes: at the top of the primary detail section (under the title
     * ribbon), falling back to the primary container.
     * @param {HTMLElement} page Details page.
     * @returns {HTMLElement|null} Anchor.
     */
    function anchorOf(page) {
        // A title that isn't in the library (native details): the page's own status slot.
        return page.querySelector('.je-native-absent-status')
            || page.querySelector('.detailPagePrimaryContent .detailSection')
            || page.querySelector('.detailPagePrimaryContent')
            || page.querySelector('.detailPagePrimaryContainer');
    }

    /**
     * Removes this surface's blocks (and stops following the old title).
     * @param {ParentNode} [root] Where to clean.
     * @returns {void}
     */
    function clear(root) {
        (root || document).querySelectorAll(`.je-arr-status[data-je-arr-surface="${SURFACE}"], .je-arr-art[data-je-arr-surface="${SURFACE}"]`).forEach(n => n.remove());
    }

    /**
     * D95: the details page's posters, where the download progress is drawn. jellyfin-web draws two (one for
     * desktop and TV, one for phones, each hidden in the other layouts), so both get it.
     * @param {HTMLElement} page Details page.
     * @returns {HTMLElement[]} Hosts.
     */
    function postersOf(page) {
        return [...page.querySelectorAll('.detailImageContainer')]
            .map(box => box.querySelector('.cardImageContainer') || box.querySelector('.card') || box);
    }

    /**
     * D95: draws the download progress on the details poster (when the switch is on and the title is downloading or
     * almost ready).
     * @param {HTMLElement} page Details page.
     * @param {Object} status Item status.
     * @returns {void}
     */
    function paintPoster(page, status) {
        if (!JE.arrStatus.artworkEnabled?.() || !JE.arrStatus.buildArtworkProgress?.(status)) return;
        for (const host of postersOf(page)) {
            const art = JE.arrStatus.buildArtworkProgress(status);
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
            art.dataset.jeArrSurface = SURFACE;
            host.appendChild(art);
        }
    }

    /**
     * Renders a status on the visible details page.
     * @param {HTMLElement} page Details page.
     * @param {Object} status Item status.
     * @param {Object} ctx Response context.
     * @returns {HTMLElement|null} The block rendered (null when quiet).
     */
    function render(page, status, ctx) {
        // A live update re-draws the block: the pill keeps the keyboard/D-pad focus it had.
        const before = page.querySelector(`.je-arr-status[data-je-arr-surface="${SURFACE}"]`);
        const refocus = !!before && before.contains(document.activeElement) && document.activeElement.classList.contains('je-arr-pill');
        clear(page);
        const episodes = JE.internals?.arrStatusEpisodes;
        if (status.kind === 'season' && episodes) episodes.render(page, status, ctx);
        else if (episodes) episodes.clear();
        // D95: a title that is ready, with nothing on its way, shows nothing from JE (no pill, journey or arr line).
        if (JE.arrStatus.settled?.(status)) return null;
        if (status.quiet && !status.admin) return null;
        if (!status.quiet) paintPoster(page, status);
        let block = null;
        // The ready/missing counts and the administrators' Sonarr/Radarr lines only when switched on
        // (D92): with neither, a summary with nothing on its way draws no block, so no space either.
        const itemId = itemIdFromHash();
        const options = {
            ...JE.arrStatus.detailsOptions(),
            // D95: on its way, the journey is shown unless the viewer closed it on this page view.
            expanded: !!JE.arrStatus.inFlight?.(status) && !(collapsed && collapsed.page === page && collapsed.itemId === itemId),
            onToggle: open => { collapsed = open ? null : { page, itemId }; }
        };
        // The page of a title that isn't in the library: one pill for its scope (not here, asked,
        // downloading…), like the more-info modal, rather than the counts of a library series.
        const absent = !!JE.titleDetails?.isSynthetic?.(itemId);
        if (absent && !status.quiet) {
            block = JE.arrStatus.buildPill(status, ctx, options);
        } else if (status.kind === 'series' || status.kind === 'season') {
            block = JE.arrStatus.buildSummary(status, options);
        } else if (!status.quiet) {
            block = JE.arrStatus.buildPill(status, ctx, options);
        } else if (options.admin && JE.arrStatus.adminLines(status).length) {
            block = JE.arrStatus.buildPill(status, ctx, options);
        }
        if (!block) return null;
        block.dataset.jeArrSurface = SURFACE;
        const anchor = anchorOf(page);
        if (!anchor) return null;
        anchor.insertBefore(block, anchor.firstChild);
        if (refocus) block.querySelector('button.je-arr-pill')?.focus({ preventScroll: true });
        return block;
    }

    /**
     * Loads and renders the status of the details page shown now (once per item; again on refresh).
     * A re-read of the item shown (a change was reported) keeps following the title until its
     * answer arrives; if it fails, the page keeps what it shows, keeps following and asks again
     * after a pause, so one failed request doesn't end the live updates of the page view. A failed
     * first read (a dropped connection, a 5xx) is asked again after the same pauses too, not left quiet;
     * view events meanwhile don't add requests.
     * @param {boolean} [force] Fetch even if this item is already shown.
     * @returns {Promise<void>}
     */
    async function update(force) {
        if (!JE.arrStatus?.enabled()) {
            stop();
            return;
        }
        const page = visiblePage();
        const itemId = itemIdFromHash();
        // A title that isn't in the library (native details facade) is read by its page id too: the
        // server answers it by key (status, seasons and episodes from public metadata). A person's own
        // page (or another page such a title links to) has no status.
        const synthetic = JE.titleDetails?.parse?.(itemId);
        if (!page || !itemId || (synthetic && !['movie', 'series', 'season', 'episode'].includes(synthetic.kind))) {
            stop();
            return;
        }
        if (current && !sameContext(current)) stop();
        if (current?.loading) {
            // Keep the active answer: progress events can arrive faster than a status read.
            // Any number of refreshes during it needs just one trailing read.
            if (force) current.dirty = true;
            return;
        }
        if (!force && current && (page.querySelector(`.je-arr-status[data-je-arr-surface="${SURFACE}"]`) || current.quiet || current.retryTimer)) return;
        // The subscription of the item shown is handed over until the new answer replaces it.
        const previous = force ? current : null;
        const kept = previous ? previous.unsubscribe : null;
        const retries = previous ? previous.retries : 0;
        if (previous) previous.unsubscribe = null;
        stop();
        const controller = new AbortController();
        // A re-read keeps the session of the read it repeats; a switch ends it (the page is reset by the session hook).
        const action = previous?.action || JE.createSessionAction?.() || null;
        const state = {
            page, itemId, controller, epoch: JE.session?.getEpoch?.(),
            userId: window.ApiClient?.getCurrentUserId?.(), serverId: serverIdentity(),
            loading: true, dirty: false, quiet: false, unsubscribe: kept, retries, retryTimer: null, action
        };
        current = state;
        try {
            // Sent only as the session of the read it repeats (checked by the transport after the feed-position wait).
            const data = await JE.arrStatus.fetchItem(itemId, controller.signal, action?.bound?.(() => current === state));
            if (current !== state || (action && !action.current())) return;
            if (!sameContext(state)) { stop(); return; }
            if (!data && (kept || JE.arrStatus?.enabled())) {
                // The read failed (or timed out): keep what is shown and the subscription (if any), ask again later.
                state.retries = retries + 1;
                state.retryTimer = setTimeout(() => {
                    state.retryTimer = null;
                    if (current === state && (!action || action.current())) update(true);
                }, RETRY_MS[Math.min(state.retries, RETRY_MS.length) - 1]);
                return;
            }
            state.retries = 0;
            state.unsubscribe = null;
            // The handed-over subscription ends once the new one (if any) is in place, so the feed's
            // running poll isn't restarted for the same titles.
            const release = () => { if (typeof kept === 'function') kept(); };
            const status = data?.items?.[0];
            if (!status) {
                // The item the page showed is gone (Jellyfin deleted a missing episode or season once its file
                // was there): when its successor opens in the page's place, the page stays as it is until then.
                const arrival = JE.internals?.arrStatusArrival;
                if (arrival?.vanished) {
                    // Still following while the successor is looked up (a newer read takes the subscription over).
                    state.unsubscribe = kept;
                    const moving = await arrival.vanished(page, itemId);
                    if (current !== state) return;
                    if (!sameContext(state)) { stop(); return; }
                    if (moving) return;
                    state.unsubscribe = null;
                }
                // Nothing to show (a person, collection or album page, an item without provider ids, or the
                // status surfaces were switched off): don't ask again for this page view, and drop what was shown.
                state.quiet = true;
                clear();
                JE.internals?.arrStatusEpisodes?.clear?.();
                JE.internals?.arrManage?.attachDetails?.(visiblePage(), null);
                JE.internals?.arrNotify?.attachDetails?.(visiblePage(), null);
                JE.internals?.arrAskActions?.attachDetails?.(visiblePage(), null);
                release();
                return;
            }
            const livePage = visiblePage();
            if (!livePage || itemIdFromHash() !== itemId) {
                release();
                return;
            }
            const block = render(livePage, status, data);
            state.quiet = !block;
            // Administrators (only they get the admin block) get the Manage button in the action row.
            JE.internals?.arrManage?.attachDetails?.(livePage, status);
            // Phase 2: Notify me / Following in the action row, Remind next to a stuck status.
            JE.internals?.arrNotify?.attachDetails?.(livePage, status, data);
            JE.internals?.arrAskActions?.attachDetails?.(livePage, status, data);
            // Native details of an absent title: Open once a copy arrives, and the blocks in its slot.
            JE.internals?.nativeDetails?.statusShown?.(livePage, status);
            // The title (or the item Jellyfin replaced it with) became available: the page turns into it.
            JE.internals?.arrStatusArrival?.seen?.(livePage, itemId, status);
            // The title's own key and, for a title Jellyfin knows by another id, the key the feed announces it under.
            const keys = [status.key, status.liveKey].filter(Boolean);
            state.unsubscribe = JE.arrStatus.subscribe(keys, () => update(true), { since: data.since ?? null });
            release();
        } finally {
            state.loading = false;
            if (current === state) {
                if (!sameContext(state)) stop();
                else if (state.dirty && (!action || action.current())) update(true);
            }
        }
    }

    /**
     * Forgets the current item (navigation away).
     * @returns {void}
     */
    function stop() {
        if (!current) return;
        current.controller.abort();
        if (current.retryTimer) clearTimeout(current.retryTimer);
        if (typeof current.unsubscribe === 'function') current.unsubscribe();
        current = null;
    }

    /**
     * Starts the details surface (behind the status flags).
     * @returns {void}
     */
    function initialize() {
        if (started || !JE.arrStatus?.enabled()) return;
        started = true;
        const lifecycle = JE.core?.lifecycle?.register('arr-status-details');
        // Nothing during load: a navigation or view event in the first 400 ms waits until then.
        const readyAt = Date.now() + 400;
        let held = null;
        const look = () => {
            const wait = readyAt - Date.now();
            if (wait <= 0) {
                update(false);
            } else if (!held) {
                held = setTimeout(() => {
                    held = null;
                    update(false);
                }, wait);
            }
        };
        const schedule = JE.helpers?.debounce ? JE.helpers.debounce(look, 60) : () => setTimeout(look, 60);
        const changed = () => {
            // A journey closed on another page view opens again here.
            if (collapsed && (collapsed.page !== visiblePage() || collapsed.itemId !== itemIdFromHash())) collapsed = null;
            // Cancellation is immediate; only the next page's first look is debounced.
            if (current && !sameContext(current)) stop();
            schedule();
        };
        const onNav = JE.core?.navigation?.onNavigate?.(changed);
        const onView = JE.core?.navigation?.onViewPage?.(changed);
        if (lifecycle) {
            if (onNav) lifecycle.track(onNav);
            if (onView) lifecycle.track(onView);
        }
        // The first look happens after the page has settled.
        setTimeout(schedule, 400);
    }

    JE.session?.onUserChange?.('arr-status-details', () => {
        collapsed = null;
        stop();
        clear();
    });

    JE.internals = JE.internals || {};
    JE.internals.arrStatusDetails = { render, update, stop, anchorOf };
    JE.initializeArrStatusDetails = initialize;
})(window.JellyfinEnhanced);
