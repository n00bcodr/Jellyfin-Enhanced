/**
 * @file Requests & downloads, phase 1: the status pill and journey on movie and episode details
 * pages, the summary line on series and season pages (season pages also get episode chips and the
 * "Not in the library yet" banner from status-episodes.js), and the admin explanation lines. One
 * request per page view; re-rendered in place when the change feed (or JE.arrStatus.refresh)
 * reports a change for the page's title. Each read is handed to status-arrival.js, which turns the
 * page into the playable one once its title arrives.
 */
(function (JE) {
    'use strict';

    const SURFACE = 'details';
    /** Pauses before asking again after a failed re-read (the page keeps following meanwhile). */
    const RETRY_MS = [5000, 15000, 60000];
    let current = null; // { itemId, controller, loading, quiet, unsubscribe, retries, retryTimer }
    let started = false;

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
        (root || document).querySelectorAll(`.je-arr-status[data-je-arr-surface="${SURFACE}"]`).forEach(n => n.remove());
    }

    /**
     * Renders a status on the visible details page.
     * @param {HTMLElement} page Details page.
     * @param {Object} status Item status.
     * @param {Object} ctx Response context.
     * @returns {HTMLElement|null} The block rendered (null when quiet).
     */
    function render(page, status, ctx) {
        clear(page);
        const episodes = JE.internals?.arrStatusEpisodes;
        if (status.kind === 'season' && episodes) episodes.render(page, status, ctx);
        else if (episodes) episodes.clear();
        if (status.quiet && !status.admin) return null;
        let block = null;
        // The page of a title that isn't in the library: one pill for its scope (not here, asked,
        // downloading…), like the more-info modal, rather than the counts of a library series.
        const absent = !!JE.titleDetails?.isSynthetic?.(itemIdFromHash());
        if (absent && !status.quiet) {
            block = JE.arrStatus.buildPill(status, ctx);
        } else if (status.kind === 'series' || status.kind === 'season') {
            block = JE.arrStatus.buildSummary(status);
        } else if (!status.quiet) {
            block = JE.arrStatus.buildPill(status, ctx);
        } else if (JE.arrStatus.adminLines(status).length) {
            block = JE.arrStatus.buildPill(status, ctx);
        }
        if (!block) return null;
        block.dataset.jeArrSurface = SURFACE;
        const anchor = anchorOf(page);
        if (!anchor) return null;
        anchor.insertBefore(block, anchor.firstChild);
        return block;
    }

    /**
     * Loads and renders the status of the details page shown now (once per item; again on refresh).
     * A re-read of the item shown (a change was reported) keeps following the title until its
     * answer arrives; if it fails, the page keeps what it shows, keeps following and asks again
     * after a pause, so one failed request doesn't end the live updates of the page view.
     * @param {boolean} [force] Fetch even if this item is already shown.
     * @returns {Promise<void>}
     */
    async function update(force) {
        if (!JE.arrStatus?.enabled()) return;
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
        if (!force && current && current.itemId === itemId && (current.loading || page.querySelector(`.je-arr-status[data-je-arr-surface="${SURFACE}"]`) || current.quiet)) return;
        // The subscription of the item shown is handed over until the new answer replaces it.
        const previous = force && current && current.itemId === itemId ? current : null;
        const kept = previous ? previous.unsubscribe : null;
        const retries = previous ? previous.retries : 0;
        if (previous) previous.unsubscribe = null;
        stop();
        const controller = new AbortController();
        // A re-read keeps the session of the read it repeats; a switch ends it (the page is reset by the session hook).
        const action = previous?.action || JE.createSessionAction?.() || null;
        const state = { itemId, controller, loading: true, quiet: false, unsubscribe: kept, retries, retryTimer: null, action };
        current = state;
        const data = await JE.arrStatus.fetchItem(itemId, controller.signal);
        if (current !== state || (action && !action.current())) return;
        state.loading = false;
        if (!data && kept) {
            // The re-read failed (or timed out): keep what is shown and the subscription, ask again later.
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
                if (current !== state || moving) return;
                state.unsubscribe = null;
            }
            // Nothing to show (a person, collection or album page, an item without provider ids, or a
            // failed first request): don't ask again for this page view, and drop what was shown.
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
        const onNav = JE.core?.navigation?.onNavigate?.(schedule);
        const onView = JE.core?.navigation?.onViewPage?.(schedule);
        if (lifecycle) {
            if (onNav) lifecycle.track(onNav);
            if (onView) lifecycle.track(onView);
        }
        // The first look happens after the page has settled.
        setTimeout(schedule, 400);
    }

    JE.session?.onUserChange?.('arr-status-details', () => {
        stop();
        clear();
    });

    JE.internals = JE.internals || {};
    JE.internals.arrStatusDetails = { render, update, stop, anchorOf };
    JE.initializeArrStatusDetails = initialize;
})(window.JellyfinEnhanced);
