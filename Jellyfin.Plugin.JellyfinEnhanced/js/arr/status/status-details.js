/**
 * @file Requests & downloads, phase 1: the status pill and journey on movie and episode details
 * pages, the summary line on series and season pages (season pages also get episode chips and the
 * "Not in the library yet" banner from status-episodes.js), and the admin explanation lines. One
 * request per page view; re-rendered in place when the change feed (or JE.arrStatus.refresh)
 * reports a change for the page's title.
 */
(function (JE) {
    'use strict';

    const SURFACE = 'details';
    let current = null; // { itemId, controller, unsubscribe, key }
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
        return page.querySelector('.detailPagePrimaryContent .detailSection')
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
        if (status.kind === 'series' || status.kind === 'season') {
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
     * @param {boolean} [force] Fetch even if this item is already shown.
     * @returns {Promise<void>}
     */
    async function update(force) {
        if (!JE.arrStatus?.enabled()) return;
        const page = visiblePage();
        const itemId = itemIdFromHash();
        if (!page || !itemId) {
            stop();
            return;
        }
        if (!force && current && current.itemId === itemId && (current.loading || page.querySelector(`.je-arr-status[data-je-arr-surface="${SURFACE}"]`) || current.quiet)) return;
        stop();
        const controller = new AbortController();
        const state = { itemId, controller, loading: true, quiet: false, unsubscribe: null };
        current = state;
        const data = await JE.arrStatus.fetchItem(itemId, controller.signal);
        if (current !== state) return;
        state.loading = false;
        const status = data?.items?.[0];
        if (!status) {
            // Nothing to show (a person, collection or album page, an item without provider ids, or a
            // failed request): don't ask again for this page view.
            state.quiet = true;
            return;
        }
        const livePage = visiblePage();
        if (!livePage || itemIdFromHash() !== itemId) return;
        const block = render(livePage, status, data);
        state.quiet = !block;
        state.unsubscribe = JE.arrStatus.subscribe([status.key], () => update(true));
    }

    /**
     * Forgets the current item (navigation away).
     * @returns {void}
     */
    function stop() {
        if (!current) return;
        current.controller.abort();
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
