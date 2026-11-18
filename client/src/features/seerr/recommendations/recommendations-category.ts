// /js/jellyseerr/recommendations/recommendations-category.js
// Recommendations Page: the "View All" / studio / network category page and its infinite-scroll
// paging. A category is one or more feeds paged side by side: a studio or network page reads a movie
// feed and a series feed (interleaved into one list) and offers All | Movies | Series once both have
// answered with results. Its filters are the Recommendations page's (FILTER_MODULE): it opens with what
// the page has set, and what is set here is the page's too. Opened from the Home tab, its address names
// it (`jeCategory`, see discovery/address.ts), so Back and Forward move between the tab and its
// categories, and a link or a reload opens it again.
import { bindToSession, filterOf, translate } from '../host-discovery';
import { clampPages, estimateYield, isAbortError, isRecord, resultKey, sortResults, unseenResults } from '../discovery/domain';
import type { FeedPage, FilterMode, ProfilesHost, ScrollHint, ScrollResult, SeerrResult } from '../discovery/types';
import { CATEGORY_PAGE_ID, FILTER_MODULE, LOG_PREFIX, OTHER_PAGE, part, recommendationsHost, SORT_MODULE } from './stage';
import type { CategoryFeed, CategoryState, ResolvedCategory } from './types';

const SCROLL_ROOT = `#${CATEGORY_PAGE_ID} .content-primary`;
// In a category entry's state: the entry below it is the tab it was opened from, so the arrow can go Back to it.
const BACK_KEY = 'jeCategoryBack';
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
              <div id="je-recommendations-category-controls" class="je-recommendations-category-controls" style="margin-left:auto;display:flex;align-items:center;gap:0.75em;">
                <div id="je-recommendations-category-filter"></div>
                <div id="je-recommendations-category-filters"></div>
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
            // kind: the kind the filters are asked for (null: Trending takes none, its titles are kept here by what each says of itself).
            feeds: category.feeds.map(feed => ({
                path: feed.path, mediaType: feed.mediaType ?? null, kind: feed.kind ?? null, page: 0, totalPages: 0, hasMore: true, seen: 0, failing: false
            })),
            controller, yieldStats: { fetched: 0, rendered: 0 }, shown: new Set()
        };
    }
    /** Ends a state's requests and scroll engine; its late results can no longer land anywhere. */
    function retire(st: CategoryState): void {
        st.controller?.abort();
        filter().cleanupScrollObserver(st);
    }
    /** One page of a category feed, under the page's filters as the feed's kind takes them. */
    const fetchPage = (st: CategoryState, feed: CategoryFeed, page: number): Promise<FeedPage> =>
        part(P, 'feedPage')(feed.path, feed.kind, page, st.controller ? { signal: st.controller.signal } : {});
    /** The titles of a page the filters keep: Seerr filtered a feed that takes filters already; one that takes none (Trending) is filtered here. */
    const keepOnPage = (st: CategoryState, results: SeerrResult[]): SeerrResult[] =>
        st.feeds.every(feed => feed.kind) ? results : filter().keepByFilters(FILTER_MODULE, results);
    /** Whether a filter is set that a feed taking none can't be checked against (runtime, rating, services, keywords): nothing of it can be said to match. */
    function uncheckable(st: CategoryState): boolean {
        if (st.feeds.every(feed => feed.kind) || !JE.discoveryFilters?.checkableOnLoaded) return false;
        return !JE.discoveryFilters.checkableOnLoaded(filter().getFilters(FILTER_MODULE));
    }
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
        // Filters out in-library and hidden items (and, for a feed that takes no filters, what they leave out): a
        // non-empty page can still render zero cards.
        const fragment = filter().createCardsFragment(keepOnPage(st, results), { cardClass: 'portraitCard' });
        for (const item of results) st.shown.add(resultKey(item));
        const rendered = fragment.childNodes.length;
        st.yieldStats.fetched += results.length;
        st.yieldStats.rendered += rendered;
        container.appendChild(fragment);
        ensureFilterControl(st, container);
        noteIfNothing(st, container);
        return rendered;
    }
    /** Switching hides the other type's cards and re-arms the engine: its feed may be short or unread. */
    function createFilterControl(container: HTMLElement): HTMLElement {
        return filter().createFilterControl(FILTER_MODULE, (mode: FilterMode) => {
            writeAddress();
            filter().applyFilterVisibility(container, mode);
            noteIfNothing(state().categoryState, container);
            armScroll(container);
        });
    }
    /**
     * When the filters leave the page nothing (every feed it reads has no more pages, and no card of the type shown is
     * on it), it says so, with the way back to everything. Gone again as soon as the page reloads.
     */
    function noteIfNothing(st: CategoryState, container: HTMLElement): void {
        const page = container.parentElement;
        page?.querySelector('.je-reco-filters-none')?.remove();
        if (state().categoryState !== st || !part(P, 'isNarrowed')() || activeFeeds(st).some(feed => feed.hasMore)) return;
        const { MODES } = filter();
        const mode = st.filtered ? filter().getFilterMode(FILTER_MODULE) : MODES.MIXED;
        const kind = mode === MODES.MOVIES ? '[data-media-type="movie"]' : mode === MODES.TV ? '[data-media-type="tv"]' : '';
        if (container.querySelector(`.card${kind}`)) return;
        const note = JE.discoverySection?.buildMessageRow?.({
            message: translate(JE, 'discovery_filters_none'),
            actionLabel: translate(JE, 'discovery_filters_clear'),
            onAction() {
                const keyed = note?.contains(document.activeElement) ?? false;
                part(P, 'clearFilters')();
                writeAddress();
                if (openCategory) showControls(openCategory.key, openCategory.category, container);
                reload(container);
                // (This note goes with the reload: the keys go to the Filters button.)
                if (keyed) document.querySelector<HTMLElement>('#je-recommendations-category-filters .jellyseerr-filters-btn')?.focus({ preventScroll: true });
            }
        });
        if (!note) return;
        note.classList.add('je-recommendations-empty', 'je-reco-filters-none', 'je-pad-left', 'je-pad-right');
        container.after(note);
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
        container.parentElement?.querySelector('.je-reco-filters-none')?.remove();
        // A filter Trending's titles can't be checked against: nothing to ask for.
        if (uncheckable(st)) {
            st.feeds.forEach(feed => { feed.hasMore = false; });
            noteIfNothing(st, container);
            return;
        }
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
        // With a history entry open the button goes through Back, so the entry is consumed. A page its address opened
        // (a link, a reload) has nothing of the tab's below it: the address goes back to the tab.
        page.querySelector('#je-recommendations-category-back')?.addEventListener('click', () => {
            const address = JE.discoveryAddress;
            if (urlMode && isRecord(history.state) && history.state[BACK_KEY] === true) history.back();
            else if (urlMode && address) {
                address.go(address.addressWith(window.location.hash, null, address.current(FILTER_MODULE, null), false));
                hideCategoryPage();
            } else if (historyEntryActive) history.back();
            else closeCategoryPage();
        });
        (document.querySelector('.mainAnimatedPages') ?? document.body).appendChild(page);
        return page;
    }
    /** Closes the page to wherever it was opened from. */
    function closeCategoryPage(): void {
        const returnToPage = state().categoryReturnsToPage && part(P, 'isPageHash')(window.location.hash);
        hideCategoryPage();
        if (returnToPage) part(P, 'showPage')();
    }
    // An open category page owns one history entry, so Back (and the Android back button) closes it instead of leaving
    // the page underneath. Off Home it is a copy of the current URL (the same pattern as the More Info modal): pushing a
    // URL of its own made jellyfin-web's router look for a route that does not exist (a "not found" flash). On Home the
    // entry's address names the category (urlMode): Home is the router's own route, so the address can carry it.
    let historyEntryActive = false;
    // The open category, and whether its address names it.
    let openCategory: { readonly key: string; readonly category: ResolvedCategory } | null = null;
    let urlMode = false;
    // Bumped by every open and close: an open still resolving its category (a genre's names) gives up when a newer
    // open or a close came meanwhile.
    let openTicket = 0;
    const isOwnEntry = (entry: unknown): boolean => isRecord(entry) && entry.jeCategory === true;
    /**
     * Our entry carries `jeCategory`: a pop that lands back on it (the More Info modal above the page closing) keeps the
     * page open, and any other pop closes it. In urlMode the address leads instead (followUrl).
     */
    function onHistoryPop(event: PopStateEvent): void {
        if (!historyEntryActive || urlMode || isOwnEntry(event.state)) return;
        releaseHistoryEntry();
        closeCategoryPage();
    }
    function releaseHistoryEntry(): void {
        historyEntryActive = false;
        window.removeEventListener('popstate', onHistoryPop);
    }
    /**
     * The filters and the order into the address of the page in view, where it holds them: a category named by its
     * address (with its order), or the page it opened over.
     */
    function writeAddress(): void {
        if (urlMode) JE.discoveryAddress?.write(FILTER_MODULE, SORT_MODULE, true);
        else if (part(P, 'addressHoldsFilters')()) JE.discoveryAddress?.write(FILTER_MODULE, null, false);
    }
    /**
     * A new sort or new filters: the page starts again from page 1 as its own operation (page 1 and load-mores of the
     * previous ones must not land in the new list). The type control already on the page keeps governing it.
     */
    function reload(container: HTMLElement): void {
        const pageState = state();
        const category = openCategory?.category;
        if (!category) return;
        const previous = pageState.categoryState;
        retire(previous);
        const next = pageState.categoryState = newCategoryState(category);
        next.filtered = previous.filtered;
        const stale = () => pageState.categoryState !== next || !pageState.categoryPageVisible;
        loadInitialCategoryPage(next, container, stale)
            .then(() => { if (!stale()) armScroll(container); })
            .catch(error => console.error(`${LOG_PREFIX} Failed to reload category`, error));
    }
    /**
     * The page's controls: All | Movies | Series (Trending mixes both types from the start; a studio or network page gets
     * it once both of its feeds have answered with results, or at once when the page's filters chose a type), the
     * Filters button, and the sort.
     */
    function showControls(categoryKey: string, category: ResolvedCategory, container: HTMLElement): void {
        const st = state().categoryState;
        const facade = filter();
        const filterSlot = document.getElementById('je-recommendations-category-filter');
        const filtersSlot = document.getElementById('je-recommendations-category-filters');
        const sortSlot = document.getElementById('je-recommendations-category-sort');
        const header = document.getElementById('je-recommendations-category-header');
        if (!filterSlot || !filtersSlot || !sortSlot || !header) return;
        filterSlot.replaceChildren();
        const typed = st.feeds.filter(feed => feed.mediaType).length >= 2;
        if (categoryKey === 'trending' || st.filtered || (typed && facade.getFilterMode(FILTER_MODULE) !== facade.MODES.MIXED)) {
            st.filtered = true;
            filterSlot.appendChild(createFilterControl(container));
        }
        facade.applyFilterVisibility(container, st.filtered ? facade.getFilterMode(FILTER_MODULE) : facade.MODES.MIXED);
        // The page's further filters (the "More from" sections' button and menu). A feed that takes none (Trending)
        // offers the ones its titles can be checked against; a genre's page has its genre given.
        // (The kinds the category shows, for the filters that are one kind's own: a content rating.)
        const kinds = [...new Set(st.feeds.map(feed => feed.kind).filter(Boolean))];
        if (kinds.length > 0) header.setAttribute('data-je-kinds', kinds.join(',')); else header.removeAttribute('data-je-kinds');
        const scope = st.feeds.some(feed => !feed.kind) ? 'loaded' : 'feed';
        const address = JE.discoveryAddress;
        // The saved filters: what is set now with the page's order, and a profile's applied as the address would be.
        const profiles: ProfilesHost | undefined = address ? {
            read: () => address.filterPairs(address.current(FILTER_MODULE, SORT_MODULE), true).join('&'),
            apply(filters) {
                // (Only what this page offers: Trending's titles are kept by what they say of themselves.)
                const wanted = address.filtersOf(filters, scope);
                facade.setFilterMode(FILTER_MODULE, wanted.mode);
                if (wanted.sort) facade.setSortMode(SORT_MODULE, wanted.sort); else facade.resetSortMode(SORT_MODULE);
                facade.setFilters(FILTER_MODULE, wanted.selection);
                showControls(categoryKey, category, container);
                writeAddress();
                reload(container);
            }
        } : undefined;
        const button = facade.createFiltersButton(header, FILTER_MODULE, scope, () => { writeAddress(); reload(container); }, {
            place: () => document.querySelector<HTMLElement>(`#${CATEGORY_PAGE_ID} .content-primary`),
            ...(categoryKey.startsWith('genre-') ? { ownGenre: category.title } : {}),
            ...(profiles ? { profiles } : {})
        });
        filtersSlot.replaceChildren(...(button ? [button] : []));
        sortSlot.replaceChildren(facade.createSortControl(SORT_MODULE, () => { writeAddress(); reload(container); }));
    }
    /** The category for a key. A genre's page opened by its address (a link, a reload) waits for the genre names it needs. */
    async function resolve(categoryKey: string): Promise<ResolvedCategory | null> {
        const found = part(P, 'resolveCategory')(categoryKey);
        const genre = /^genre-(movie|tv)-\d+$/.exec(categoryKey)?.[1];
        if (found || (genre !== 'movie' && genre !== 'tv')) return found;
        const list = await part(P, 'fetchGenreSlider')(genre);
        if (!list.length) return null;
        if (genre === 'movie') P.MOVIE_GENRES = list; else P.TV_GENRES = list;
        return part(P, 'resolveCategory')(categoryKey);
    }
    /**
     * Marks the page's history entry. On Home its address names the category (with the filters and the order): opened
     * by its address (a link, Back, Forward) the entry is marked as it is, otherwise one is added. Elsewhere a same-URL
     * entry is added, as before.
     */
    function markHistory(categoryKey: string, fromUrl: boolean): void {
        const address = JE.discoveryAddress;
        urlMode = !!address?.isHomeHash(window.location.hash);
        if (address && urlMode) {
            const target = address.addressWith(window.location.hash, categoryKey, address.current(FILTER_MODULE, SORT_MODULE), true);
            releaseHistoryEntry();
            if (fromUrl || window.location.hash === target) {
                if (window.location.hash !== target || !isOwnEntry(history.state)) {
                    address.go(target, { state: { ...(isRecord(history.state) ? history.state : {}), jeCategory: true } });
                }
                return;
            }
            address.go(target, { push: true, state: { jeCategory: true, [BACK_KEY]: true } });
            return;
        }
        if (!historyEntryActive) {
            history.pushState({ jeCategory: true }, '', window.location.href);
            historyEntryActive = true;
            window.addEventListener('popstate', onHistoryPop);
        }
    }
    /** Opens a category page; `fromUrl`: opened by its address (a link, a reload, Back, Forward), which names it. */
    async function showCategoryPage(categoryKey: string, fromUrl = false): Promise<void> {
        const ticket = ++openTicket;
        // Which page this is (the filters may change meanwhile; the page may not).
        const pageOf = () => JE.discoveryAddress?.withoutOwn(window.location.hash) ?? window.location.hash;
        const from = pageOf();
        const category = await resolve(categoryKey);
        // Another open, a close or a navigation came while it resolved: this one is no longer wanted. One its address
        // asked for is wanted only while the address still names it (Back to the tab meanwhile).
        if (!category || ticket !== openTicket || pageOf() !== from) return;
        if (fromUrl && JE.discoveryAddress?.categoryOfHash(window.location.hash) !== categoryKey) return;
        if (!JE.pluginConfig?.RecommendationsPageEnabled) return;
        // Opened by its address: that says what the filters and the order are.
        if (fromUrl) JE.discoveryAddress?.adopt(FILTER_MODULE, SORT_MODULE, { withSort: true });
        const pageState = state();
        const fromPage = pageState.pageVisible;
        if (fromPage) part(P, 'hidePage')();
        // Before categoryState is replaced wholesale, or the old observer leaks: nothing else holds it.
        retire(pageState.categoryState);
        pageState.categoryPageVisible = true;
        pageState.categoryReturnsToPage = fromPage || pageState.categoryReturnsToPage;
        openCategory = { key: categoryKey, category };
        // Back pressed (or another category opened) before page 1 lands must not install an engine on
        // a page nobody is looking at: every step checks this state is still the installed one.
        const st = pageState.categoryState = newCategoryState(category);
        const stale = () => pageState.categoryState !== st || !pageState.categoryPageVisible;

        const page = createCategoryPageContainer();
        const title = document.getElementById('je-recommendations-category-title');
        const container = document.getElementById('je-recommendations-category-container');
        if (!title || !container) return;
        title.textContent = category.title;
        showControls(categoryKey, category, container);
        markHistory(categoryKey, fromUrl);
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
        openTicket++;
        const pageState = state();
        if (!pageState.categoryPageVisible) return;
        pageState.categoryPageVisible = false;
        pageState.categoryReturnsToPage = false;
        // Closed by navigating away: the entry stays in history but is no longer ours to pop.
        releaseHistoryEntry();
        retire(pageState.categoryState);
        stopStickyTracking?.();
        stopStickyTracking = null;
        const page = document.getElementById(CATEGORY_PAGE_ID);
        JE.jellyseerrUI?.releasePosters?.(page ?? undefined);
        document.getElementById('je-recommendations-category-container')?.replaceChildren();
        page?.querySelector('.je-reco-filters-none')?.remove();
        if (page) {
            page.classList.add('hide');
            page.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'custom' } }));
        }
        const previous = pageState.categoryPreviousPage;
        pageState.categoryPreviousPage = null;
        if (previous && !document.querySelector(OTHER_PAGE)) {
            previous.classList.remove('hide');
            // (jeRestored: this page coming back is not the router showing it, which would follow its address.)
            previous.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'interior', isRestored: true, jeRestored: true } }));
        }
        openCategory = null;
        urlMode = false;
        // The filters are the page's too: a page still on screen shows what was set here.
        P.syncFilters?.();
    }
    /** Whether the Home page is the one showing (a category named by its address opens over it). */
    const homeShowing = (): boolean => !!document.querySelector('#indexPage:not(.hide)');
    /** Opens the category an address names. */
    function openFromUrl(key: string): void {
        showCategoryPage(key, true).catch(error => console.error(`${LOG_PREFIX} Failed to open category`, error));
    }
    /**
     * Follows the address after a navigation, as far as it is a category's on Home: true when it did. A category page
     * its address named goes when the address no longer does (Back to the tab) and gives way to another one named (Back
     * and Forward between categories); one named while Home shows opens over it.
     */
    function followUrl(): boolean {
        const address = JE.discoveryAddress;
        if (!address) return false;
        const hash = window.location.hash;
        const wanted = address.isHomeHash(hash) ? address.categoryOfHash(hash) : null;
        if (state().categoryPageVisible && urlMode) {
            // The same page at other filters (a pasted link): it shows them.
            if (wanted === openCategory?.key) {
                if (address.adopt(FILTER_MODULE, SORT_MODULE, { withSort: true })) openFromUrl(wanted);
                return true;
            }
            if (wanted) { openFromUrl(wanted); return true; }
            if (!address.isHomeHash(hash)) return false;
            // Back to the tab: at the filters its own entry has.
            address.adopt(FILTER_MODULE, null, { withSort: false });
            hideCategoryPage();
            return true;
        }
        if (!wanted || state().categoryPageVisible || !homeShowing()) {
            // The page in view at an address whose filters are other ones (Back, Forward, a pasted link): it shows them.
            if (!state().categoryPageVisible && address.isRecommendationsHash(hash)
                && address.adopt(FILTER_MODULE, null, { withSort: false })) P.syncFilters?.();
            return false;
        }
        openFromUrl(wanted);
        return true;
    }
    P.createCategoryPageContainer = createCategoryPageContainer;
    P.loadMoreCategoryItems = loadMoreCategoryItems;
    P.showCategoryPage = showCategoryPage;
    P.hideCategoryPage = hideCategoryPage;
    P.categoryOnOwnEntry = () => historyEntryActive && isOwnEntry(history.state);
    P.followUrl = followUrl;
})();
