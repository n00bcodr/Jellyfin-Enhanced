// /js/jellyseerr/recommendations/recommendations-category.js
// Recommendations Page: the "View All" / studio / network category page and its infinite-scroll
// paging. A category is one or more feeds paged side by side: a studio or network page reads a movie
// feed and a series feed (interleaved into one list) and offers All | Movies | Series once both have
// answered with results.
import { bindToSession, filterOf, translate } from '../host-discovery';
import { clampPages, decodeFeedPage, estimateYield, isAbortError, resultKey, sortResults, unseenResults } from '../discovery/domain';
import type { FeedPage, FilterMode, ScrollHint, ScrollResult, SeerrResult } from '../discovery/types';
import { CATEGORY_PAGE_ID, FILTER_MODULE, LOG_PREFIX, OTHER_PAGE, part, recommendationsHost, SORT_MODULE } from './stage';
import type { CategoryFeed, CategoryState, ResolvedCategory } from './types';

const SCROLL_ROOT = `#${CATEGORY_PAGE_ID} .content-primary`;
const RETURN_HASH = '#/recommendations';
/** Upper bound on pages fetched in parallel per feed by one load-more call. */
const MAX_PAGES_PER_LOAD = 4;
const CATEGORY_YIELD_COLD = 0.9;
const CATEGORY_YIELD_FLOOR = 0.1;
const FEED_PAGE_SIZE = 20;
const PAGE_MARKUP = `
        <div data-role="content">
          <div class="content-primary je-recommendations-category-page">
            <div id="je-recommendations-category-header" class="je-recommendations-category-header">
              <button type="button" id="je-recommendations-category-back" class="paper-icon-button-light">
                <span class="material-icons" aria-hidden="true">arrow_back</span>
              </button>
              <h1 id="je-recommendations-category-title"></h1>
              <div id="je-recommendations-category-controls" style="margin-left:auto;display:flex;align-items:center;gap:0.75em;">
                <div id="je-recommendations-category-filter"></div>
                <div id="je-recommendations-category-sort"></div>
              </div>
            </div>
            <div id="je-recommendations-category-container" is="emby-itemscontainer" class="itemsContainer je-pad-left je-pad-right vertical-wrap"></div>
          </div>
        </div>
      `;

const mergeFeedResults = (perFeed: readonly SeerrResult[][], interleave: (a: SeerrResult[], b: SeerrResult[]) => SeerrResult[]): SeerrResult[] => {
    const [first = [], second] = perFeed;
    return second ? interleave(first, second) : first;
};
const nextPages = (feed: CategoryFeed, ahead: number): number[] => {
    const last = feed.totalPages ? Math.min(feed.totalPages, feed.page + ahead) : feed.page + ahead;
    const pages: number[] = [];
    for (let page = feed.page + 1; page <= last; page++) pages.push(page);
    return pages;
};

(function () {
    'use strict';
    const { JE, P } = recommendationsHost();
    const state = () => part(P, 'state');
    const filter = () => filterOf(JE);
    // Stops the sticky-bar tracking for the open category page.
    let stopStickyTracking: (() => void) | null = null;

    /** Fresh paging state. A load that finds another one installed belongs to a page nobody is looking at. */
    function newCategoryState(category: ResolvedCategory): CategoryState {
        const controller = new AbortController();
        bindToSession(JE, controller);
        return {
            activeScrollObserver: null, isLoading: false,
            // Whether the All | Movies | Series control governs this page.
            filtered: false,
            feeds: category.feeds.map(feed => ({
                path: feed.path, mediaType: feed.mediaType ?? null, page: 0, totalPages: 0, hasMore: true, seen: 0, failing: false
            })),
            controller, yieldStats: { fetched: 0, rendered: 0 }, shown: new Set()
        };
    }
    /** Ends a state's requests and scroll engine; its late results can no longer land anywhere. */
    function retire(st: CategoryState): void {
        st.controller?.abort();
        filter().cleanupScrollObserver(st);
    }
    const fetchPage = async (st: CategoryState, feed: CategoryFeed, page: number): Promise<FeedPage> => {
        const options = st.controller ? { signal: st.controller.signal } : {};
        return decodeFeedPage(await part(P, 'fetchWithManagedRequest')(`${feed.path}?page=${page}`, options));
    };
    /**
     * The feeds read right now: every feed until the filter control is in play, then only the
     * selected media type's. A feed without a media type (Trending, plain rows) is always read.
     */
    function activeFeeds(st: CategoryState): CategoryFeed[] {
        if (!st.filtered) return st.feeds;
        const mode = filter().getFilterMode(FILTER_MODULE);
        const { MIXED, MOVIES } = filter().MODES;
        return st.feeds.filter(feed => !feed.mediaType || mode === MIXED ||
            (mode === MOVIES ? feed.mediaType === 'movie' : feed.mediaType === 'tv'));
    }
    function prefetchCategoryPages(st: CategoryState, count: number): void {
        for (const feed of activeFeeds(st)) {
            if (!feed.hasMore || (feed.failing && st.feeds.length > 1)) continue;
            for (const page of nextPages(feed, count)) {
                fetchPage(st, feed, page).catch(() => { /* Surfaces, with retry, when actually needed. */ });
            }
        }
    }
    /** Commits one fetched page onto its feed's cursor and returns its sorted rows. */
    function commitPage(feed: CategoryFeed, pageNumber: number, page: FeedPage): SeerrResult[] {
        console.debug(`${LOG_PREFIX} category page ${pageNumber}/${page.totalPages}: ${page.results.length} raw result(s)`);
        feed.page = pageNumber;
        feed.totalPages = page.totalPages ? clampPages(page.totalPages) : (feed.totalPages || 1);
        // An empty page is not the end of the feed: server-side parental filtering removes rows while
        // preserving the upstream page counts. The scroll engine's empty-page valve decides when to stop.
        feed.hasMore = pageNumber < feed.totalPages;
        feed.seen += page.results.length;
        return sortResults(page.results, filter().getSortMode(SORT_MODULE));
    }
    const interleave = (a: SeerrResult[], b: SeerrResult[]) => filter().interleaveArrays(a, b);
    /** Appends a batch's cards and returns how many landed. */
    function renderBatch(st: CategoryState, container: HTMLElement, batch: SeerrResult[]): number {
        // TMDB pages overlap as popularity shifts between requests; repeats render once. Marked only
        // once built: a batch whose card fails to build must come back on retry.
        const results = unseenResults(batch, st.shown);
        // Filters out in-library and hidden items: a non-empty page can still render zero cards.
        const fragment = filter().createCardsFragment(results, { cardClass: 'portraitCard' });
        for (const item of results) st.shown.add(resultKey(item));
        const rendered = fragment.childNodes.length;
        st.yieldStats.fetched += results.length;
        st.yieldStats.rendered += rendered;
        container.appendChild(fragment);
        ensureFilterControl(st, container);
        return rendered;
    }
    /** Switching hides the other type's cards and re-arms the engine: its feed may be short or unread. */
    function createFilterControl(container: HTMLElement): HTMLElement {
        return filter().createFilterControl(FILTER_MODULE, (mode: FilterMode) => {
            filter().applyFilterVisibility(container, mode);
            armScroll(container);
        });
    }
    /** Adds the control once every feed of a multi-feed category has answered with rows. */
    function ensureFilterControl(st: CategoryState, container: HTMLElement): void {
        if (st.filtered || st.feeds.length < 2 || !st.feeds.every(feed => feed.seen > 0)) return;
        const slot = document.getElementById('je-recommendations-category-filter');
        if (!slot) return;
        st.filtered = true;
        slot.replaceChildren(createFilterControl(container));
        filter().applyFilterVisibility(container, filter().getFilterMode(FILTER_MODULE));
    }
    /**
     * Fetches the next batch in parallel from every active feed (sized from the buffer deficit and
     * post-filter yield) and appends its cards. A batch that renders nothing is fine: the scroll engine
     * calls again for the pages after it, so heavily-owned categories never stall.
     */
    async function loadMoreCategoryItems(st: CategoryState, container: HTMLElement, hint?: ScrollHint,
        isStale?: () => boolean): Promise<ScrollResult> {
        st.isLoading = true;
        const budget = hint?.pageBudget;
        const pageBudget = budget !== undefined && Number.isFinite(budget) ? Math.max(0, budget) : Infinity;
        let feeds = activeFeeds(st).filter(feed => feed.hasMore);
        // With less budget than feeds, read fewer so the valve is reached exactly instead of this
        // load planning zero pages (which the engine takes as "no progress" without the button).
        if (pageBudget >= 1 && pageBudget < feeds.length) feeds = feeds.slice(0, pageBudget);
        const cursors = feeds.map(feed => ({
            feed, restore: { page: feed.page, totalPages: feed.totalPages, hasMore: feed.hasMore, seen: feed.seen }
        }));
        try {
            if (feeds.length === 0) return { pages: 0, rendered: 0 };
            const wantCards = JE.seamlessScroll?.cardsNeeded?.(container, hint, FEED_PAGE_SIZE) || FEED_PAGE_SIZE;
            const yieldRatio = estimateYield(st.yieldStats, CATEGORY_YIELD_COLD, CATEGORY_YIELD_FLOOR);
            // Together the feeds should cover the deficit.
            let count = Math.min(MAX_PAGES_PER_LOAD, Math.max(1, Math.ceil(wantCards / (FEED_PAGE_SIZE * feeds.length * yieldRatio))));
            count = Math.min(count, Math.floor(pageBudget / feeds.length));
            if (count < 1) return { pages: 0, rendered: 0 }; // Out of budget for now; the valve decides.
            const plans = feeds.map(feed => ({ feed, pages: nextPages(feed, feed.failing && st.feeds.length > 1 ? 1 : count) }));
            const settled = await Promise.all(plans.map(({ feed, pages }) =>
                Promise.allSettled(pages.map(page => fetchPage(st, feed, page)))));
            // Another category (or Back) took over: this page's DOM and state are not ours.
            if (isStale?.()) return { pages: 0, rendered: 0 };

            // Commit each feed's pages in order up to its first failure; throw only if nothing arrived.
            const perFeed: SeerrResult[][] = [];
            const failures: unknown[] = [];
            let committed = 0;
            for (const [index, { feed, pages }] of plans.entries()) {
                const rows: SeerrResult[] = [];
                for (const [position, outcome] of (settled[index] ?? []).entries()) {
                    if (outcome.status !== 'fulfilled') {
                        if (isAbortError(outcome.reason)) throw outcome.reason;
                        failures.push(outcome.reason);
                        feed.failing = true;
                        break;
                    }
                    feed.failing = false;
                    rows.push(...commitPage(feed, pages[position] ?? feed.page + 1, outcome.value));
                    committed++;
                }
                perFeed.push(rows);
            }
            if (failures.length > 0 && committed === 0) throw failures[0];
            const rendered = renderBatch(st, container, mergeFeedResults(perFeed, interleave));
            const pagesFetched = plans.reduce((total, plan) => total + plan.pages.length, 0);
            const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pagesFetched);
            const prefetch = rendered > 0 ? count : Math.min(count, Math.floor(remainingBudget / feeds.length));
            if (prefetch > 0) prefetchCategoryPages(st, prefetch);
            return { pages: committed, rendered };
        } catch (error) {
            // Roll back so the retry fetches and renders the same pages.
            cursors.forEach(({ feed, restore }) => { Object.assign(feed, restore); });
            throw error;
        } finally {
            st.isLoading = false;
            // A filter switch re-arms the engine during a load; its first fill stood down, so wake it.
            if (!isStale?.()) queueMicrotask(() => st.fill?.());
        }
    }
    /** Page 1 of every feed into an emptied container; extra requests would only slow it down at Seerr. */
    async function loadInitialCategoryPage(st: CategoryState, container: HTMLElement, isStale: () => boolean): Promise<void> {
        JE.jellyseerrUI?.releasePosters?.(container);
        container.replaceChildren();
        const settled = await Promise.allSettled(st.feeds.map(feed => fetchPage(st, feed, 1)));
        // A failed request can also settle after navigation or a sort reload.
        if (isStale()) return;
        const perFeed = st.feeds.map((feed, index) => {
            const outcome = settled[index];
            if (outcome?.status === 'fulfilled') return commitPage(feed, 1, outcome.value);
            // A 504 while the parental lookups warm, or a Seerr hiccup: leave the feed at page 0 so
            // the engine's first fill asks for page 1 again rather than silently starting at page 2.
            feed.page = 0;
            feed.hasMore = true;
            feed.failing = true;
            console.error(`${LOG_PREFIX} Failed to load category page 1; it will be retried`, outcome?.reason);
            return [];
        });
        renderBatch(st, container, mergeFeedResults(perFeed, interleave));
    }
    /** (Re-)installs the scroll engine for the current category state. */
    function armScroll(container: HTMLElement): void {
        const st = state().categoryState;
        const stale = () => state().categoryState !== st || !state().categoryPageVisible;
        filter().cleanupScrollObserver(st);
        filter().setupInfiniteScroll(st, SCROLL_ROOT, hint => loadMoreCategoryItems(st, container, hint, stale),
            () => activeFeeds(st).some(feed => feed.hasMore), () => st.isLoading);
    }
    function createCategoryPageContainer(): HTMLElement {
        const existing = document.getElementById(CATEGORY_PAGE_ID);
        if (existing) return existing;
        const page = document.createElement('div');
        page.id = CATEGORY_PAGE_ID;
        page.className = 'page type-interior mainAnimatedPage hide';
        page.setAttribute('data-title', translate(JE, 'recommendations_title'));
        page.setAttribute('data-backbutton', 'true');
        page.setAttribute('data-type', 'custom');
        page.innerHTML = PAGE_MARKUP;
        // This page takes no part in the History API (see showCategoryPage), so there's no browser
        // Back support and this button is the way out, to wherever the page was opened from.
        page.querySelector('#je-recommendations-category-back')?.addEventListener('click', () => {
            const returnToPage = state().categoryReturnsToPage && window.location.hash === RETURN_HASH;
            hideCategoryPage();
            if (returnToPage) part(P, 'showPage')();
        });
        (document.querySelector('.mainAnimatedPages') ?? document.body).appendChild(page);
        return page;
    }
    async function showCategoryPage(categoryKey: string): Promise<void> {
        const category = part(P, 'resolveCategory')(categoryKey);
        if (!category || !JE.pluginConfig?.RecommendationsPageEnabled) return;
        const pageState = state();
        const fromPage = pageState.pageVisible;
        if (fromPage) part(P, 'hidePage')();
        // Before categoryState is replaced wholesale, or the old observer leaks: nothing else holds it.
        retire(pageState.categoryState);
        pageState.categoryPageVisible = true;
        pageState.categoryReturnsToPage = fromPage || pageState.categoryReturnsToPage;
        // Back pressed (or another category opened) before page 1 lands must not install an engine on
        // a page nobody is looking at: every step checks this state is still the installed one.
        const st = pageState.categoryState = newCategoryState(category);
        const stale = () => pageState.categoryState !== st || !pageState.categoryPageVisible;

        const page = createCategoryPageContainer();
        const title = document.getElementById('je-recommendations-category-title');
        const container = document.getElementById('je-recommendations-category-container');
        const filterSlot = document.getElementById('je-recommendations-category-filter');
        const sortSlot = document.getElementById('je-recommendations-category-sort');
        if (!title || !container || !filterSlot || !sortSlot) return;
        title.textContent = category.title;
        // Trending mixes both types from the start; a studio or network page gets the control once
        // both of its feeds have answered with results.
        filterSlot.replaceChildren();
        if (categoryKey === 'trending') {
            st.filtered = true;
            filterSlot.appendChild(createFilterControl(container));
        }
        filter().applyFilterVisibility(container, st.filtered ? filter().getFilterMode(FILTER_MODULE) : filter().MODES.MIXED);
        sortSlot.replaceChildren(filter().createSortControl(SORT_MODULE, () => {
            const previous = pageState.categoryState;
            retire(previous);
            // A sort reload is its own operation: results of the previous sort must not land in the
            // re-sorted list. The filter control already on the page keeps governing it.
            const sorted = pageState.categoryState = newCategoryState(category);
            sorted.filtered = previous.filtered;
            const sortStale = () => pageState.categoryState !== sorted || !pageState.categoryPageVisible;
            loadInitialCategoryPage(sorted, container, sortStale)
                .then(() => { if (!sortStale()) armScroll(container); })
                .catch(error => console.error(`${LOG_PREFIX} Failed to re-sort category`, error));
        }));
        // Deliberately does NOT touch the History API: jellyfin-web's router intercepts every pushState
        // and re-resolves its own routes against the URL, and this page was never one of them, which
        // produced a "not found" flash even a hard refresh couldn't recover from. The page is shown and
        // hidden purely as in-memory UI state; navigating away or the back button closes it.
        const activePage = document.querySelector(`.mainAnimatedPage:not(.hide):not(#${CATEGORY_PAGE_ID})`);
        if (activePage) {
            pageState.categoryPreviousPage = activePage;
            activePage.classList.add('hide');
            activePage.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'interior' } }));
        }
        page.classList.remove('hide');
        page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'custom', isRestored: false, options: {} } }));
        page.dispatchEvent(new CustomEvent('pageshow', { bubbles: true, detail: {} }));
        stopStickyTracking?.();
        const header = document.getElementById('je-recommendations-category-header');
        stopStickyTracking = header ? part(P, 'trackStickyBar')(header) : null;
        await loadInitialCategoryPage(st, container, stale);
        if (!stale()) armScroll(container);
    }
    function hideCategoryPage(): void {
        const pageState = state();
        if (!pageState.categoryPageVisible) return;
        pageState.categoryPageVisible = false;
        pageState.categoryReturnsToPage = false;
        retire(pageState.categoryState);
        stopStickyTracking?.();
        stopStickyTracking = null;
        const page = document.getElementById(CATEGORY_PAGE_ID);
        JE.jellyseerrUI?.releasePosters?.(page ?? undefined);
        document.getElementById('je-recommendations-category-container')?.replaceChildren();
        if (page) {
            page.classList.add('hide');
            page.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'custom' } }));
        }
        const previous = pageState.categoryPreviousPage;
        pageState.categoryPreviousPage = null;
        if (previous && !document.querySelector(OTHER_PAGE)) {
            previous.classList.remove('hide');
            previous.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'interior', isRestored: true } }));
        }
    }
    P.createCategoryPageContainer = createCategoryPageContainer;
    P.loadMoreCategoryItems = loadMoreCategoryItems;
    P.showCategoryPage = showCategoryPage;
    P.hideCategoryPage = hideCategoryPage;
})();
