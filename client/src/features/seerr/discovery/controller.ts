// The state machine behind every Seerr discovery section (genre, tag, network, person, collection):
// processed-page dedup, re-entry guard, abort swap, metrics, error handling and lifecycle wiring,
// plus the pagination machines:
//   'dual-feed'    server-paginated TV + Movie feeds, interleaved, filter/sort, infinite scroll
//   'client-paged' one fetched list chunk-rendered client-side, filter/sort, infinite scroll
//   'one-shot'     a single render, no pagination
import { bindToSession, filterOf, type SeerrDiscoveryHost } from '../host-discovery';
import {
    abortError, clampPages, decodeFeedPage, estimateYield, isAbortError, pageRange, planPagesPerFeed, resultKey, sortResults,
    throwIfAborted, unseenResults, type YieldStats
} from './domain';
import type {
    DiscoveryController, DiscoverySpec, FeedKind, FeedPage, FilterMode, ManagedFetchOptions,
    ResolvedFeeds, ScrollHint, ScrollResult, ScrollState, SeerrResult
} from './types';

/** Prefetch per feed stays below the shared 8-slot request pool so demand never queues behind it. */
const MAX_PREFETCH_PER_FEED = 3;
const KEEP_ATTACHED_MS = 6000;
const LOAD_YIELD_COLD = 0.8;
const LOAD_YIELD_FLOOR = 0.05;

interface FeedCursor { page: number; hasMore: boolean; total: number }
interface TypedPage { readonly kind: FeedKind; readonly data: FeedPage }
const newCursor = (): FeedCursor => ({ page: 1, hasMore: true, total: Infinity });
function resetCursor(cursor: FeedCursor): void { Object.assign(cursor, newCursor()); }

/** Cheap signature of what a list shows; React may reuse child nodes, so compare content, not identity. */
function listSignature(page: Element | null): string {
    const container = page?.querySelector('.itemsContainer');
    if (!container) return '';
    const first = container.firstElementChild;
    const label = first?.getAttribute('data-id') || first?.getAttribute('data-index') ||
        first?.textContent?.trim().slice(0, 40) || '';
    return `${container.childElementCount}|${label}`;
}

export function createDiscoveryController(spec: DiscoverySpec, JE: SeerrDiscoveryHost): DiscoveryController {
    const { key } = spec;
    const logPrefix = `🪼 Jellyfin Enhanced: ${spec.logLabel}:`;
    const sectionSelector = `.jellyseerr-${key}-discovery-section`;
    const isDualFeed = spec.mode === 'dual-feed';
    const isClientPaged = spec.mode === 'client-paged';
    const cardClass = isDualFeed ? 'portraitCard' : 'overflowPortraitCard';
    const pageSize = (spec.mode === 'client-paged' && spec.pageSize) || 40;
    const filter = () => filterOf(JE);

    // ---- Chassis state (all modes) -------------------------------------------
    const processedPages = new Set<string>();
    // The page visible when the navigation started, and the first item its list held: it stays
    // visible for a moment (stale) until the router swaps pages or refills that same element.
    let visibleAtNavigation: Element | null = null;
    let visibleContentAtNavigation = '';
    let snapshotHash: string | null = null;
    // The page the router showed. On Back it fires before popstate, so it is remembered with the
    // hash it was shown for rather than reset by the navigation that follows.
    let shownView: HTMLElement | null = null;
    let shownViewHash: string | null = null;
    let currentAbortController: AbortController | null = null;
    let currentRenderingPageKey: string | null = null;
    let keepAttachedSequence = 0;
    let initialized = false;
    let disposed = false;
    let pendingFrame = 0;
    const disposers: Array<() => void> = [];

    // ---- Pagination state (dual-feed + client-paged) --------------------------
    let isLoading = false;
    let hasMorePages = true;
    const scrollState: ScrollState = { activeScrollObserver: null };
    const cursors: Record<FeedKind, FeedCursor> = { tv: newCursor(), movie: newCursor() };
    // Items fetched vs cards rendered (after library/hidden/dedup filtering); sizes parallel loads.
    const yieldStats: YieldStats = { fetched: 0, rendered: 0 };
    let lastBatchPages = 0;
    let lastBatchRendered = -1;
    // Bumped on every sort / filter change and cleanup: an older batch must not write counters.
    let loadGeneration = 0;
    // isLoading belongs to whichever load set it last; a stale finally must not release a newer flag.
    let loadingOwner = 0;
    const takeLoading = () => { isLoading = true; return ++loadingOwner; };
    const releaseLoading = (owner: number) => { if (loadingOwner === owner) isLoading = false; };
    let currentFeeds: ResolvedFeeds | null = null;
    let cachedTvResults: SeerrResult[] = [];
    let cachedMovieResults: SeerrResult[] = [];
    // What the section shows, so TMDB's overlapping pages render once. Marked after rendering:
    // a batch that fails to build must come back on retry.
    const shownResults = new Set<string>();
    // client-paged: one cached list, chunk-rendered.
    let clientListActive = false;
    let cachedAllResults: SeerrResult[] = [];
    let currentPagedResults: SeerrResult[] = [];
    let renderedCount = 0;
    // Bumped when the client-paged list re-renders from the top: a chunk being built is dropped.
    let renderEpoch = 0;

    const managed = (path: string, options?: ManagedFetchOptions) => filter().fetchWithManagedRequest(path, key, options);
    const itemsContainerNow = () => document.querySelector<HTMLElement>(`${sectionSelector} .itemsContainer`);

    function rememberShownView(event: Event): void {
        if (!(event.target instanceof HTMLElement)) return;
        shownView = event.target;
        shownViewHash = window.location.hash;
    }
    function currentShownView(): HTMLElement | null {
        return shownView?.isConnected && !shownView.classList.contains('hide') && shownViewHash === window.location.hash
            ? shownView : null;
    }
    function isEnabled(): boolean {
        const value = JE.pluginConfig?.[spec.configKey];
        return spec.defaultEnabled === false ? !!value : value !== false;
    }
    function resetPagination(): void {
        resetCursor(cursors.tv);
        resetCursor(cursors.movie);
        yieldStats.fetched = 0;
        yieldStats.rendered = 0;
        lastBatchPages = 0;
        lastBatchRendered = -1;
    }
    function endMeasurement(): void {
        if (JE.requestManager?.metrics?.enabled) JE.requestManager.endMeasurement?.(`${key}-discovery`);
    }
    function markProcessed(pageKey: string): void {
        processedPages.add(pageKey);
        endMeasurement();
    }

    // ---- dual-feed ------------------------------------------------------------
    /** One feed page. `tolerant` turns a failure into a failed empty page (initial render only). */
    async function fetchFeedPage(kind: FeedKind, feedId: number, page: number, signal: AbortSignal | undefined,
        tolerant = false): Promise<FeedPage> {
        try {
            throwIfAborted(signal);
            if (spec.mode !== 'dual-feed' || !currentFeeds) throw abortError();
            const sortBy = kind === 'tv' ? filter().getTvSortMode(key) : filter().getSortMode(key);
            let path = `${spec.buildDiscoverPath(kind, feedId, currentFeeds)}?page=${page}`;
            if (sortBy) path += `&sortBy=${encodeURIComponent(sortBy)}`;
            const response = await managed(path, { signal });
            throwIfAborted(signal);
            return decodeFeedPage(response);
        } catch (error) {
            if (isAbortError(error) || !tolerant) throw error;
            // The caller keeps the feed open so the engine re-fetches page 1 instead of ending it.
            return { results: [], failed: true };
        }
    }
    /** Warms the request cache; errors surface (with retry) when the page is actually needed. */
    function prefetchAhead(filterMode: string, pagesPerFeed: number, signal: AbortSignal | undefined): void {
        const feeds = currentFeeds;
        if (!feeds) return;
        const count = Math.max(1, Math.min(MAX_PREFETCH_PER_FEED, pagesPerFeed));
        const warm = (kind: FeedKind, id: number) => {
            for (const page of pageRange(cursors[kind].page + 1, count, cursors[kind].total)) {
                void fetchFeedPage(kind, id, page, signal).catch(() => { /* retried on demand */ });
            }
        };
        if (feeds.tvId && (filterMode === 'mixed' || filterMode === 'tv') && cursors.tv.hasMore) warm('tv', feeds.tvId);
        if (feeds.movieId && (filterMode === 'mixed' || filterMode === 'movies') && cursors.movie.hasMore) warm('movie', feeds.movieId);
    }
    function updateHasMorePages(mode: string): void {
        if (mode === 'tv') hasMorePages = cursors.tv.hasMore;
        else if (mode === 'movies') hasMorePages = cursors.movie.hasMore;
        else hasMorePages = cursors.tv.hasMore || cursors.movie.hasMore;
    }
    /** Page 1 renders every type: the filter hides by class, and All must not find a type missing. */
    const interleavedResults = () => filter().interleaveArrays(cachedTvResults, cachedMovieResults);
    function pageOneFetches(feeds: ResolvedFeeds, signal: AbortSignal): Array<Promise<TypedPage>> {
        const fetches: Array<Promise<TypedPage>> = [];
        if (feeds.tvId) {
            fetches.push(fetchFeedPage('tv', feeds.tvId, 1, signal, true).then(data => ({ kind: 'tv', data })));
        }
        if (feeds.movieId) {
            fetches.push(fetchFeedPage('movie', feeds.movieId, 1, signal, true).then(data => ({ kind: 'movie', data })));
        }
        return fetches;
    }
    /**
     * Applies page 1 of each feed. One that failed stays at page 0 with more pages, so the engine's
     * first fill fetches page 1 again with backoff (and then a retry button) rather than ending it.
     * @returns Whether any feed failed
     */
    function commitPageOne(pages: readonly TypedPage[]): boolean {
        let anyFailed = false;
        for (const { kind, data } of pages) {
            const cursor = cursors[kind];
            if (kind === 'tv') cachedTvResults = data.results;
            else cachedMovieResults = data.results;
            if (data.failed) {
                anyFailed = true;
                cursor.page = 0;
                cursor.hasMore = true;
            } else {
                cursor.total = clampPages(data.totalPages);
                cursor.hasMore = 1 < cursor.total;
            }
        }
        return anyFailed;
    }

    // ---- client-paged ---------------------------------------------------------
    function pagedResults(mode: string): SeerrResult[] {
        const facade = filter();
        const sorted = sortResults(cachedAllResults, facade.getSortMode(key));
        if (mode === 'movies' || mode === 'tv') return facade.filterByMediaType(sorted, mode);
        // Mixed mode interleaves TV and movies for a balanced display.
        return facade.interleaveArrays(sorted.filter(item => item.mediaType === 'tv'),
            sorted.filter(item => item.mediaType === 'movie'));
    }
    /** The result set for a mode, falling back to everything when the mode has nothing. */
    function pagedResultsForMode(mode: string): SeerrResult[] {
        const results = pagedResults(mode);
        return results.length === 0 && cachedAllResults.length > 0 ? cachedAllResults : results;
    }
    const createCardsFragment = (results: SeerrResult[]) => filter().createCardsFragment(results, { cardClass });
    function markShown(results: readonly SeerrResult[]): void {
        for (const item of results) shownResults.add(resultKey(item));
    }
    /** Rebuilds the list from the top for a filter or sort change. */
    function restartChunks(itemsContainer: HTMLElement, mode: string): void {
        renderEpoch++;
        JE.jellyseerrUI?.releasePosters?.(itemsContainer);
        itemsContainer.replaceChildren();
        renderedCount = 0;
        currentPagedResults = pagedResultsForMode(mode);
        const nextChunk = currentPagedResults.slice(0, pageSize);
        if (nextChunk.length === 0) { hasMorePages = false; return; }
        const fragment = createCardsFragment(nextChunk);
        if (fragment.childNodes.length > 0) itemsContainer.appendChild(fragment);
        renderedCount = nextChunk.length;
        hasMorePages = renderedCount < currentPagedResults.length;
    }
    /**
     * The next chunk, the cards in view at once and the rest in slices. The chunk counts as consumed
     * only once it is in: a card that fails to build takes the chunk out again and the retry renders
     * the same chunk instead of skipping it.
     */
    async function renderChunkInSlices(itemsContainer: HTMLElement | null, mode: string, chunkSize: number,
        signal: AbortSignal | undefined): Promise<void> {
        if (!itemsContainer) return;
        currentPagedResults = pagedResultsForMode(mode);
        const nextChunk = currentPagedResults.slice(renderedCount, renderedCount + chunkSize);
        if (nextChunk.length === 0) { hasMorePages = false; return; }
        const epoch = renderEpoch;
        const isCurrent = () => epoch === renderEpoch && !signal?.aborted;
        await filter().appendCards(itemsContainer, nextChunk, { cardClass, isCurrent });
        // A reset or navigation during the build owns the pagination state now.
        if (!isCurrent()) return;
        renderedCount += nextChunk.length;
        hasMorePages = renderedCount < currentPagedResults.length;
    }
    async function loadMoreClientPaged(hint?: ScrollHint): Promise<ScrollResult | void> {
        if (isLoading || !hasMorePages || !clientListActive) return undefined;
        isLoading = true;
        const epoch = renderEpoch;
        try {
            const itemsContainer = itemsContainerNow();
            const chunk = Math.max(pageSize, JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, pageSize) || pageSize);
            const before = renderedCount;
            await renderChunkInSlices(itemsContainer, filter().getFilterMode(key), chunk, currentAbortController?.signal);
            return { pages: 1, rendered: renderedCount - before };
        } catch (error) {
            if (isAbortError(error)) return undefined;
            console.error(`${logPrefix} Error loading more items:`, error);
            throw error; // Re-throw for the scroll engine's retry handling.
        } finally {
            isLoading = false;
            // A filter / sort change re-armed the engine during the build, found isLoading set and stopped.
            if (epoch !== renderEpoch) scrollState.fill?.();
        }
    }
    /**
     * Fetches the next server page(s) for the active mode, several per feed in parallel when the
     * buffer deficit (or a low post-filter yield) calls for it, then prefetches the ones after.
     */
    async function loadMoreDualFeed(hint?: ScrollHint): Promise<ScrollResult | void> {
        const feeds = currentFeeds;
        if (isLoading || !hasMorePages || !feeds || (!feeds.tvId && !feeds.movieId)) return undefined;
        const filterMode = filter().getFilterMode(key);
        const generation = loadGeneration;
        const owner = takeLoading();
        const previous = {
            tv: { ...cursors.tv }, movie: { ...cursors.movie }, tvResults: cachedTvResults, movieResults: cachedMovieResults
        };
        try {
            const signal = currentAbortController?.signal;
            const itemsContainer = itemsContainerNow();
            const needTv = !!feeds.tvId && (filterMode === 'mixed' || filterMode === 'tv') && cursors.tv.hasMore;
            let needMovies = !!feeds.movieId && (filterMode === 'mixed' || filterMode === 'movies') && cursors.movie.hasMore;
            // With less budget left than feeds, fetch one so the empty-page valve is exact.
            const pageBudget = Number.isFinite(hint?.pageBudget) ? Math.max(0, hint?.pageBudget ?? 0) : Infinity;
            if (needTv && needMovies && pageBudget < 2) needMovies = false;
            const feedCount = (needTv ? 1 : 0) + (needMovies ? 1 : 0);
            if (feedCount === 0) { hasMorePages = false; return undefined; }

            const wantCards = JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, 40) || 40;
            const yieldRatio = estimateYield(yieldStats, LOAD_YIELD_COLD, LOAD_YIELD_FLOOR);
            const pagesPerFeed = planPagesPerFeed({ wantCards, feedCount, yieldRatio, lastBatchRendered, lastBatchPages, pageBudget });
            console.debug(`${logPrefix} load: deficit=${Math.round(hint?.deficitPx || 0)}px want=${wantCards} yield=${yieldRatio.toFixed(2)} pagesPerFeed=${pagesPerFeed} budget=${pageBudget}`);

            const tvPages = needTv ? pageRange(cursors.tv.page + 1, pagesPerFeed, cursors.tv.total) : [];
            const moviePages = needMovies ? pageRange(cursors.movie.page + 1, pagesPerFeed, cursors.movie.total) : [];
            if (tvPages.length === 0 && moviePages.length === 0) {
                cursors.tv.hasMore &&= cursors.tv.page < cursors.tv.total;
                cursors.movie.hasMore &&= cursors.movie.page < cursors.movie.total;
                updateHasMorePages(filterMode);
                return { pages: 0, rendered: 0 };
            }
            const pagesFetched = tvPages.length + moviePages.length;
            const fetchAll = (kind: FeedKind, id: number | null, pages: readonly number[]) =>
                Promise.allSettled(id ? pages.map(page => fetchFeedPage(kind, id, page, signal)) : []);
            const [tvSettled, movieSettled] = await Promise.all([
                fetchAll('tv', feeds.tvId, tvPages), fetchAll('movie', feeds.movieId, moviePages)
            ]);
            if (signal?.aborted) return undefined;
            // Sort / filter changed in flight: the pages are cached for reuse, the bookkeeping is stale.
            if (generation !== loadGeneration) return undefined;

            // Commit each feed's pages in order up to its first failure: a flaky upstream must not
            // throw away the pages that arrived. The cursor stops before it, so it is re-fetched next.
            const failures: unknown[] = [];
            let committedPages = 0;
            const commit = (kind: FeedKind, settled: Array<PromiseSettledResult<FeedPage>>, pages: readonly number[]) => {
                const rows: SeerrResult[] = [];
                const cursor = cursors[kind];
                for (const [index, outcome] of settled.entries()) {
                    if (outcome.status !== 'fulfilled') {
                        if (isAbortError(outcome.reason)) throw outcome.reason;
                        failures.push(outcome.reason);
                        break;
                    }
                    rows.push(...outcome.value.results);
                    cursor.total = clampPages(outcome.value.totalPages);
                    cursor.page = pages[index] ?? cursor.page;
                    cursor.hasMore = cursor.page < cursor.total;
                    committedPages++;
                }
                return rows;
            };
            const newTvResults = commit('tv', tvSettled, tvPages);
            if (newTvResults.length > 0) cachedTvResults = [...cachedTvResults, ...newTvResults];
            const newMovieResults = commit('movie', movieSettled, moviePages);
            if (newMovieResults.length > 0) cachedMovieResults = [...cachedMovieResults, ...newMovieResults];
            if (failures.length > 0) {
                if (committedPages === 0) throw failures[0]; // Nothing arrived: the engine retries with backoff.
                console.debug(`${logPrefix} ${committedPages} of ${pagesFetched} page(s) arrived; the rest will be retried on the next load`, failures[0]);
            }

            updateHasMorePages(filterMode);
            lastBatchPages = pagesPerFeed;
            let itemsToAdd: SeerrResult[] = filterMode === 'tv' ? newTvResults
                : filterMode === 'movies' ? newMovieResults
                : filter().interleaveArrays(newTvResults, newMovieResults);
            yieldStats.fetched += itemsToAdd.length;
            lastBatchRendered = 0;
            itemsToAdd = unseenResults(itemsToAdd, shownResults);

            if (itemsContainer && itemsToAdd.length > 0) {
                // Resolves (and the engine measures) only once every card is in; a sort change or
                // navigation aborts the signal and drops the cards not in yet.
                const rendering = filter().appendCards(itemsContainer, itemsToAdd, {
                    cardClass, isCurrent: () => !signal?.aborted
                });
                ensureFilterControl(itemsContainer);
                const rendered = await rendering;
                markShown(itemsToAdd);
                if (signal?.aborted) return undefined;
                // A filter change during the build started fresh statistics; these counts are the old mode's.
                if (generation !== loadGeneration) return { pages: committedPages, rendered };
                yieldStats.rendered += rendered;
                lastBatchRendered = rendered;
            }
            // Keep the cache warm: twice as deep after a productive batch; after an empty one only
            // what the remaining empty-page budget still allows.
            const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pagesFetched);
            const prefetchPerFeed = lastBatchRendered > 0
                ? pagesPerFeed * 2
                : Math.min(pagesPerFeed, Math.floor(remainingBudget / feedCount));
            if (prefetchPerFeed > 0) prefetchAhead(filterMode, prefetchPerFeed, signal);
            return { pages: committedPages, rendered: lastBatchRendered };
        } catch (error) {
            if (generation === loadGeneration) {
                // Roll the batch back so the retry fetches and renders the same pages.
                Object.assign(cursors.tv, previous.tv);
                Object.assign(cursors.movie, previous.movie);
                cachedTvResults = previous.tvResults;
                cachedMovieResults = previous.movieResults;
                updateHasMorePages(filterMode);
            }
            if (isAbortError(error)) return undefined;
            console.error(`${logPrefix} Error loading more items:`, error);
            throw error; // Re-throw for the scroll engine's retry handling.
        } finally {
            releaseLoading(owner);
            // A filter change re-armed the engine during this load, found isLoading true and stopped.
            if (generation !== loadGeneration) scrollState.fill?.();
        }
    }
    const loadMoreItems = (hint?: ScrollHint) => isClientPaged ? loadMoreClientPaged(hint) : loadMoreDualFeed(hint);
    function setupInfiniteScroll(): void {
        filter().setupInfiniteScroll(scrollState, sectionSelector, loadMoreItems, () => hasMorePages, () => isLoading);
    }
    function cleanupScrollObserver(): void { filter().cleanupScrollObserver(scrollState); }

    function createSectionContainer(title: string, showFilter: boolean): HTMLElement {
        const section = document.createElement('div');
        section.className = isDualFeed
            ? `verticalSection jellyseerr-${key}-discovery-section padded-left padded-right`
            : `verticalSection jellyseerr-${key}-discovery-section`;
        section.setAttribute(`data-jellyseerr-${key}-discovery`, 'true');
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';
        section.appendChild(filter().createSectionHeader(title, key, showFilter, handleFilterChange, () => { void handleSortChange(); }));
        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = isDualFeed ? 'vertical-wrap itemsContainer centered' : 'itemsContainer padded-right vertical-wrap';
        section.appendChild(itemsContainer);
        return section;
    }

    /** dual-feed re-fetches page 1 with the new sortBy; client-paged re-sorts its cached list. */
    async function handleSortChange(): Promise<void> {
        const itemsContainer = itemsContainerNow();
        if (isClientPaged) {
            if (!itemsContainer) return;
            restartChunks(itemsContainer, filter().getFilterMode(key));
            cleanupScrollObserver();
            if (hasMorePages) setupInfiniteScroll();
            return;
        }
        const feeds = currentFeeds;
        if (!itemsContainer || !feeds || (!feeds.tvId && !feeds.movieId)) return;
        JE.jellyseerrUI?.releasePosters?.(itemsContainer);
        itemsContainer.replaceChildren();
        cleanupScrollObserver();

        loadGeneration++;
        resetPagination();
        // This re-fetch owns the loading flag until its page 1 lands, so a filter change meanwhile
        // can't start page 2 ahead of it. Its own staleness is its abort signal; the generation only
        // says whether a filter change means the engine needs waking afterwards.
        const generation = loadGeneration;
        let owner = 0;
        cachedTvResults = [];
        cachedMovieResults = [];
        shownResults.clear();

        currentAbortController?.abort();
        const controller = new AbortController();
        bindToSession(JE, controller);
        currentAbortController = controller;
        const { signal } = controller;
        const fetches = pageOneFetches(feeds, signal);
        try {
            owner = takeLoading();
            const results = await Promise.all(fetches);
            // Superseded (another sort change, navigation): nothing here is ours.
            if (signal.aborted) return;
            // Read the filter at commit time; it may have changed meanwhile.
            const filterMode = filter().getFilterMode(key);
            commitPageOne(results);
            updateHasMorePages(filterMode);
            const displayResults = interleavedResults();
            if (displayResults.length > 0) {
                const fragment = createCardsFragment(displayResults);
                yieldStats.fetched += displayResults.length;
                yieldStats.rendered += fragment.childNodes.length;
                itemsContainer.appendChild(fragment);
                markShown(displayResults);
            }
            filter().applyFilterVisibility(itemsContainer, filterMode);
            if (hasMorePages) setupInfiniteScroll();
        } catch (error) {
            if (!isAbortError(error)) console.error(`${logPrefix} Sort change error:`, error);
        } finally {
            releaseLoading(owner);
            // A filter change re-armed the engine while page 1 was in flight; wake it.
            if (generation !== loadGeneration) scrollState.fill?.();
        }
    }
    function handleFilterChange(newMode: FilterMode): void {
        const itemsContainer = itemsContainerNow();
        if (!itemsContainer) return;
        if (isClientPaged) {
            restartChunks(itemsContainer, newMode);
            cleanupScrollObserver();
            if (hasMorePages) setupInfiniteScroll();
            return;
        }
        filter().applyFilterVisibility(itemsContainer, newMode);
        // A batch still in flight belongs to the old mode: retire its bookkeeping.
        loadGeneration++;
        yieldStats.fetched = 0;
        yieldStats.rendered = 0;
        lastBatchPages = 0;
        lastBatchRendered = -1;
        updateHasMorePages(newMode);
        if (hasMorePages) setupInfiniteScroll();
    }
    /** dual-feed targets list pages, the other modes detail pages. */
    function waitForPageReady(signal?: AbortSignal): Promise<HTMLElement | null> {
        return filter().waitForPageReady(signal, {
            type: isDualFeed ? 'list' : 'detail',
            getView: currentShownView,
            isStalePage: page => !!page && page === visibleAtNavigation && listSignature(page) === visibleContentAtNavigation
        });
    }
    /** Adds the All / Movies / Series control once both media types have appeared. */
    function ensureFilterControl(itemsContainer: HTMLElement): void {
        if (!isDualFeed) return;
        const header = itemsContainer.closest(sectionSelector)?.querySelector('.jellyseerr-discovery-header');
        if (!header || header.querySelector('.jellyseerr-discovery-filter')) return;
        if (!filter().hasBothTypes(cachedTvResults, cachedMovieResults)) return;
        header.querySelector('.sectionTitle')?.after(filter().createFilterControl(key, handleFilterChange));
    }
    /**
     * The list page may still be settling when the section goes in (as soon as the container
     * exists, not once it is full). If a re-render drops the section in the first seconds, put it back.
     */
    function keepAttached(section: HTMLElement, listPage: HTMLElement, signal: AbortSignal): void {
        // Unique id per call: a stale handle unsubscribing a shared id would drop the successor's.
        const handle = JE.helpers?.onBodyMutation?.(`jellyseerr-${key}-discovery-keepattached-${++keepAttachedSequence}`, () => {
            if (signal.aborted) return;
            const detached = !section.isConnected;
            if (!detached && !section.closest('.page.hide')) return;
            const container = currentShownView()?.querySelector('.itemsContainer') ??
                document.querySelector('.page:not(.hide) .itemsContainer') ??
                document.querySelector('.libraryPage:not(.hide) .itemsContainer') ?? listPage;
            const parent = container.closest('.verticalSection') ?? container.parentElement;
            if (parent?.parentElement && !parent.parentElement.contains(section)) parent.parentElement.appendChild(section);
        });
        if (!handle) return;
        const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); handle.unsubscribe(); };
        const timer = setTimeout(stop, KEEP_ATTACHED_MS);
        signal.addEventListener('abort', stop, { once: true });
    }
    async function renderDualFeed(id: string, signal: AbortSignal, pageKey: string): Promise<void> {
        if (spec.mode !== 'dual-feed') return;
        // The page wait runs alongside the resolution on its own controller: an early exit must
        // stop its polling rather than leave it running until the next navigation.
        const pageReadyAbort = new AbortController();
        const stopPageWait = () => pageReadyAbort.abort();
        signal.addEventListener('abort', stopPageWait, { once: true });
        const pageReadyPromise = waitForPageReady(pageReadyAbort.signal);

        const resolved = await spec.resolveFeeds({ id, signal });
        if (signal.aborted) return;
        if (!resolved || (!resolved.tvId && !resolved.movieId)) { stopPageWait(); return; }

        resetPagination();
        isLoading = false;
        hasMorePages = true;
        loadGeneration++;
        const feeds: ResolvedFeeds = { ...resolved, tvId: resolved.tvId || null, movieId: resolved.movieId || null };
        currentFeeds = feeds;
        cachedTvResults = [];
        cachedMovieResults = [];
        shownResults.clear();

        // (No prefetch alongside page 1: extra requests slow it down at Seerr, and the engine's
        // first fill fetches pages 2-3 the moment page 1 has rendered.)
        const fetches = pageOneFetches(feeds, signal);
        // A navigation aborting the render returns before Promise.all handles these; without this
        // their AbortError surfaced as an unhandled rejection (only an abort can reject them).
        fetches.forEach(fetch => { fetch.catch(() => { /* handled by Promise.all below */ }); });

        // Show the section as soon as the page can hold it: the header goes in now and the cards
        // stream in when page 1 lands, so the first visit doesn't sit on a blank page.
        const listPage = await pageReadyPromise;
        signal.removeEventListener('abort', stopPageWait);
        if (signal.aborted) return;
        let section: HTMLElement | null = null;
        let itemsContainer: HTMLElement | null = null;
        if (listPage) {
            document.querySelector(sectionSelector)?.remove();
            const built = createSectionContainer(resolved.title, false);
            const parent = (listPage.closest('.verticalSection') ?? listPage.parentElement)?.parentElement;
            if (parent) {
                section = built;
                itemsContainer = built.querySelector<HTMLElement>('.itemsContainer');
                parent.appendChild(built);
                keepAttached(built, listPage, signal);
            }
        }
        // A failure here tears the section down only while this render still owns it: an abort means
        // a sort change took it over or a cleanup removed it, and removing it would delete a successor's.
        let fetchResults: TypedPage[];
        try {
            fetchResults = await Promise.all(fetches);
        } catch (error) {
            if (!signal.aborted) section?.remove();
            throw error;
        }
        if (signal.aborted) return;

        const anyFailed = commitPageOne(fetchResults);
        // Always start each section on defaults instead of persisting the previous choice.
        filter().resetFilterMode(key);
        filter().resetSortMode(key);
        updateHasMorePages(filter().getFilterMode(key));
        const displayResults = interleavedResults();
        if (!section || !itemsContainer) return;
        // An empty page 1 is not an empty feed: the parental, in-library and hidden filters can strip
        // a page bare while later pages hold titles. Give up only when the feed says nothing is left.
        const fragment = createCardsFragment(displayResults);
        if (fragment.childNodes.length === 0 && !anyFailed && !hasMorePages) {
            section.remove();
            return;
        }
        ensureFilterControl(itemsContainer);
        yieldStats.fetched += displayResults.length;
        yieldStats.rendered += fragment.childNodes.length;
        itemsContainer.appendChild(fragment);
        markShown(displayResults);
        if (hasMorePages) setupInfiniteScroll();
        markProcessed(pageKey);
    }
    async function renderClientPaged(id: string, signal: AbortSignal, pageKey: string): Promise<void> {
        if (spec.mode !== 'client-paged') return;
        const resolved = await spec.resolveItems({ id, signal });
        if (signal.aborted) return;
        if (!resolved || resolved.items.length === 0) return;
        cachedAllResults = resolved.items;
        clientListActive = true;
        const hasBoth = filter().resultHasBothTypes(cachedAllResults);
        filter().resetFilterMode(key);
        filter().resetSortMode(key);
        const displayResults = pagedResultsForMode(filter().getFilterMode(key));

        const detailSection = await waitForPageReady(signal);
        if (signal.aborted) return;
        if (!detailSection) {
            console.debug(`${logPrefix} Could not find detail section to insert into`);
            return;
        }
        document.querySelector(sectionSelector)?.remove();
        const section = createSectionContainer(resolved.title, hasBoth);
        const itemsContainer = section.querySelector<HTMLElement>('.itemsContainer');
        // Seed the first chunk that yields a card: a run of owned or hidden titles at the top of a
        // filmography is not an empty filmography. The scroll engine loads the rest.
        let consumed = 0;
        let fragment = document.createDocumentFragment();
        while (fragment.childNodes.length === 0 && consumed < displayResults.length) {
            const chunk = displayResults.slice(consumed, consumed + pageSize);
            fragment = createCardsFragment(chunk);
            consumed += chunk.length;
        }
        if (!itemsContainer || fragment.childNodes.length === 0) {
            console.debug(`${logPrefix} No cards created from results`);
            return;
        }
        const cardCount = fragment.childNodes.length;
        itemsContainer.appendChild(fragment);
        currentPagedResults = displayResults;
        renderedCount = consumed;
        hasMorePages = renderedCount < currentPagedResults.length;
        detailSection.appendChild(section);
        console.debug(`${logPrefix} Section added with ${cardCount} cards`);
        if (hasMorePages) setupInfiniteScroll();
        markProcessed(pageKey);
    }
    /** Offers a retry when a full-list discovery fails before the scroll engine has cards to offer one on. */
    async function showClientPagedRetry(signal: AbortSignal): Promise<void> {
        const detailSection = await waitForPageReady(signal);
        if (signal.aborted || !detailSection) return;
        document.querySelector(sectionSelector)?.remove();
        const section = document.createElement('div');
        section.className = `verticalSection jellyseerr-${key}-discovery-section je-retry-row`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'raised emby-button';
        button.textContent = '⟳ Tap to retry';
        button.addEventListener('click', () => {
            if (signal.aborted || button.disabled) return;
            button.disabled = true;
            // render() starts a fresh controller and repeats the lookup; failures were not cached as empty.
            void render().finally(() => section.remove());
        }, { signal });
        section.appendChild(button);
        detailSection.appendChild(section);
        signal.addEventListener('abort', () => section.remove(), { once: true });
    }
    async function render(): Promise<void> {
        const id = disposed ? null : spec.getIdFromUrl();
        if (!id) return;
        const pageKey = spec.pageKey ? spec.pageKey(id) : `${key}-${id}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;
        if (currentRenderingPageKey === pageKey) return;
        if (!isEnabled()) return;
        currentRenderingPageKey = pageKey;
        currentAbortController?.abort();
        const controller = new AbortController();
        bindToSession(JE, controller);
        currentAbortController = controller;
        const { signal } = controller;
        if (JE.requestManager?.metrics?.enabled) JE.requestManager.startMeasurement?.(`${key}-discovery`);
        try {
            if (spec.mode === 'dual-feed') {
                await renderDualFeed(id, signal, pageKey);
            } else if (spec.mode === 'client-paged') {
                await renderClientPaged(id, signal, pageKey);
            } else {
                const rendered = await spec.renderOneShot({ id, pageKey, signal, waitForPageReady });
                if (signal.aborted) return;
                if (rendered) markProcessed(pageKey);
            }
        } catch (error) {
            // Not marked as processed, so a retry is possible.
            if (isAbortError(error)) {
                console.debug(`${logPrefix} Request aborted`);
                return;
            }
            console.error(`${logPrefix} Error rendering ${key} discovery:`, error);
            if (isClientPaged && !signal.aborted) await showClientPagedRetry(signal);
        } finally {
            // An aborted render can settle after its successor started and must not clear its key.
            if (currentAbortController === controller) {
                currentRenderingPageKey = null;
                // Only the session ends a render without replacing it: nothing of it may stay.
                if (signal.aborted) cleanup();
            }
        }
    }
    /** Aborts in-flight work and resets state. Runs on every navigation and identity change. */
    function cleanup(): void {
        loadGeneration++;
        // Leaving the route: take the section along, so a page element the router reuses for the
        // next route never shows the previous one's.
        document.querySelectorAll(sectionSelector).forEach(element => element.remove());
        currentAbortController?.abort();
        currentAbortController = null;
        // The section is gone; the root-less call sweeps every poster no longer in the document.
        JE.jellyseerrUI?.releasePosters?.();
        if (spec.mode !== 'one-shot') cleanupScrollObserver();
        processedPages.clear();
        isLoading = false;
        hasMorePages = true;
        resetPagination();
        currentFeeds = null;
        clientListActive = false;
        currentPagedResults = [];
        renderedCount = 0;
        currentRenderingPageKey = null;
        cachedTvResults = [];
        cachedMovieResults = [];
        cachedAllResults = [];
        shownResults.clear();
        if (spec.mode !== 'one-shot') {
            filter().resetFilterMode(key);
            filter().resetSortMode(key);
        }
        spec.onCleanup?.();
    }
    /**
     * Renders when the URL matches. Called from the navigate pipeline with no arguments, and from
     * the view pipeline as (view, element); the element is the page shown, the section's anchor.
     */
    function handlePageNavigation(_view?: unknown, element?: unknown): void {
        if (disposed || !spec.getIdFromUrl()) return;
        if (element instanceof HTMLElement) {
            shownView = element;
            shownViewHash = window.location.hash;
        }
        pendingFrame = requestAnimationFrame(() => { void render(); });
    }
    /**
     * Records the page showing the moment a navigation is announced, on the raw events before the
     * router reacts: the deduplicated navigate callback can run after pages were already swapped.
     */
    function snapshotVisiblePage(): void {
        if (window.location.hash === snapshotHash) return; // Same navigation, second event.
        snapshotHash = window.location.hash;
        visibleAtNavigation = document.querySelector('.page:not(.hide)');
        visibleContentAtNavigation = listSignature(visibleAtNavigation);
    }
    /** Lifecycle teardown goes first: cleanup always runs before handlePageNavigation on a navigation. */
    function initialize(): void {
        if (initialized || disposed) return;
        const core = JE.core;
        if (!core?.lifecycle || !core.navigation) throw new Error('Discovery needs the core lifecycle and navigation');
        initialized = true;
        const lifecycle = core.lifecycle.register(`jellyseerr-${key}-discovery`);
        lifecycle.onTeardown(cleanup);
        disposers.push(lifecycle.teardownOn('navigate'));
        for (const type of ['je:navigate', 'hashchange', 'popstate']) {
            window.addEventListener(type, snapshotVisiblePage, true);
            disposers.push(() => window.removeEventListener(type, snapshotVisiblePage, true));
        }
        document.addEventListener('viewshow', rememberShownView, true);
        disposers.push(() => document.removeEventListener('viewshow', rememberShownView, true));
        const navigated = () => handlePageNavigation();
        disposers.push(core.navigation.onNavigate(navigated));
        handlePageNavigation();
        disposers.push(core.navigation.onViewPage(handlePageNavigation));
    }
    function start(): void {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
        else initialize();
    }
    /** Removes everything this controller installed; a replacement starts from nothing. */
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('DOMContentLoaded', initialize);
        cancelAnimationFrame(pendingFrame);
        disposers.splice(0).forEach(stop => stop());
        cleanup();
    }
    // Cached Seerr results carry per-user availability and request state. Navigation normally runs
    // cleanup before a logout can complete; this covers every other identity transition.
    const stopSession = JE.session?.onUserChange(`discovery-${key}`, cleanup);
    if (stopSession) disposers.push(stopSession);

    return { initialize, cleanup, render, handlePageNavigation, start, dispose };
}
