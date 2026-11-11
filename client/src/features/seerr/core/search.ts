import { seerrCoreContext, type Deduplicator, type ScrollHint, type ScrollState, type SeerrCoreHost } from '../host-core';
import type { SeerrApiFacade, SeerrUiFacade } from './contract';
import { parseItemAttribute } from './decode';
import {
    TMDB_MAX_PAGE, filterResultsByYear, pagesToLoad, parseYearedQuery, withCollectionCards
} from './search-query';
import type { SearchPage, SeerrMediaItem } from './types';
import {
    isViewCurrent, captureOrigin, classifyFailure, errorBody, errorStatus, escapeWith, firstInstall, groupInternals, hashQuery,
    isAbortError, uncertainMessage
} from './runtime';
import { ICONS } from './ui/icon-markup';

const LOG = '🪼 Jellyfin Enhanced: Seerr:';
// How long a rendered query must stand before its collection lookup starts.
const COLLECTION_SETTLE_MS = 300;
// A search starts once the box has been quiet this long.
const SEARCH_DEBOUNCE_MS = 200;
// Page-1 results wait for the viewer's own key gap plus this margin; a longer gap is a pause.
const TYPING_GAP_MAX_MS = 450;
const RENDER_HOLD_MARGIN_MS = 30;
const USER_WAIT_TIMEOUT_MS = 20000;

interface CollectionBatch { results: SeerrMediaItem[]; query: string; rowId: number; epoch: number; generation: number }

/**
 * The Seerr search integration (JE.initializeJellyseerrScript). The facades
 * (JE.jellyseerrAPI, JE.jellyseerrUI) are read when used, as before, so the
 * UI group may load after this entry.
 */
export function installSearch(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'search')) return;
    const seerr = seerrCoreContext(JE);
    let initialized = false;

    JE.initializeJellyseerrScript = function initializeJellyseerrScript(): void {
        if (!JE.pluginConfig?.JellyseerrEnabled) {
            console.log('🪼 Jellyfin Enhanced: Seerr Search: Integration is disabled in plugin settings.');
            return;
        }
        if (JE.pluginConfig.JellyseerrShowSearchResults === false) {
            console.log('🪼 Jellyfin Enhanced: Seerr Search: Search results are disabled in plugin settings.');
            return;
        }
        // One integration per page: a second call would duplicate every listener.
        if (initialized) return;
        const api0 = JE.jellyseerrAPI;
        const ui0 = JE.jellyseerrUI;
        if (!api0 || !ui0) {
            console.warn(`${LOG} Seerr API/UI not loaded; search integration unavailable.`);
            return;
        }
        initialized = true;
        start(api0, ui0);
    };

    function start(api: SeerrApiFacade, ui: Partial<SeerrUiFacade>): void {
        console.log(`${LOG} Initializing...`);
        const escapeHtml = escapeWith(JE);
        const internals = groupInternals(JE);
        const icons = () => internals.icons ?? ICONS;
        const session = JE.session;
        const epochNow = () => session ? session.getEpoch() : 0;
        const epochCurrent = (epoch: number) => !session || session.isCurrent(epoch);

        let lastProcessedQuery: string | null = null;
        // The query whose page-1 fetch is in flight, so a navigation rebuild does not search it twice.
        let fetchingQuery: string | null = null;
        let pendingRender: { query: string; apply: () => void } | null = null;
        let pendingRenderTimer: number | null = null;
        let lastInputAt = 0;
        let lastInputGapMs = 0;
        let typingGapMs = 0;
        let collectionsSettleAt = 0;
        let collectionQueue: Promise<void> = Promise.resolve();
        // The row a collection lookup belongs to: bumped whenever a search starts or the row is rebuilt.
        let collectionRowId = 0;
        let unfinishedCollections: CollectionBatch[] = [];
        let batchRendering: Promise<number> | null = null;
        let debounceTimeout: number | null = null;
        let isJellyseerrActive = false;
        let jellyseerrUserFound = false;
        let isJellyseerrOnlyMode = false;
        let hiddenSections: Element[] = [];
        let originalPosition: HTMLElement | null = null;
        let movedSection: Element | null = null;
        // Bumped on every account change: no answer from before it renders afterwards.
        let generation = 0;

        let searchCurrentPage = 0;
        let searchTotalPages = 0;
        let searchIsLoading = false;
        let searchHasMore = false;
        const searchScrollState: ScrollState = {};
        let searchDeduplicator: Deduplicator | null = null;
        let searchSignal: AbortSignal | null = null;
        // From a navigation's start until its settle check ran: no search load may start or re-arm.
        let searchSuspended = false;
        let navigateSettleTimer: number | null = null;
        const searchYield = { fetched: 0, rendered: 0 };

        const clearTimer = (timer: number | null) => { if (timer !== null) window.clearTimeout(timer); };
        const searchInput = (visibleOnly = false): HTMLInputElement | null => {
            const input = document.querySelector(visibleOnly ? '#searchPage:not(.hide) #searchTextInput' : '#searchPage #searchTextInput');
            return input instanceof HTMLInputElement ? input : null;
        };
        const updateIcon = () => ui.updateJellyseerrIcon?.(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, toggleJellyseerrOnlyMode);
        const hidden = <T>(items: T[]): T[] => {
            const hiddenContent = seerr.peer('hiddenContent');
            return hiddenContent?.filterJellyseerrResults ? hiddenContent.filterJellyseerrResults(items, 'search') : items;
        };
        const abortSignal = (): AbortSignal | null => JE.requestManager?.getAbortSignal?.('jellyseerr-search') || null;
        const createCard = (item: SeerrMediaItem) => ui.createJellyseerrCard?.(item, isJellyseerrActive, jellyseerrUserFound) ?? null;

        /** Restore only classes/placement owned by this filter, even after its row disappears. */
        function restoreNativeResults(): void {
            hiddenSections.forEach(section => section.classList.remove('section-hidden'));
            hiddenSections = [];
            if (movedSection?.parentNode && originalPosition?.parentNode) {
                originalPosition.parentNode.insertBefore(movedSection, originalPosition);
            }
            originalPosition?.remove();
            originalPosition = null;
            movedSection = null;
            isJellyseerrOnlyMode = false;
        }

        /** Double-click on the Seerr icon: only Seerr's results, or every section again. */
        function toggleJellyseerrOnlyMode(): void {
            const searchPage = document.querySelector('#searchPage');
            if (!searchPage) { restoreNativeResults(); updateIcon(); return; }
            if (!isJellyseerrOnlyMode) {
                isJellyseerrOnlyMode = true;
                const sections = searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section), .noItemsMessage');
                hiddenSections = Array.from(sections).filter(section => !section.classList.contains('section-hidden'));
                hiddenSections.forEach(section => section.classList.add('section-hidden'));
                const seerrSection = searchPage.querySelector('.jellyseerr-section');
                const results = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                if (seerrSection?.parentNode && results) {
                    originalPosition = document.createElement('div');
                    originalPosition.id = 'jellyseerr-placeholder';
                    movedSection = seerrSection;
                    seerrSection.parentNode.insertBefore(originalPosition, seerrSection);
                    results.insertBefore(seerrSection, results.firstChild);
                }
                JE.toast?.(JE.t('jellyseerr_toast_filter_on'), 3000);
            } else {
                restoreNativeResults();
                JE.toast?.(JE.t('jellyseerr_toast_filter_off'), 3000);
            }
            const title = searchPage.querySelector('.jellyseerr-section .sectionTitle');
            if (title) {
                // The title also holds the refresh button: replace only its text.
                const text = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');
                const node = title.firstChild;
                if (node && node.nodeType === Node.TEXT_NODE) node.nodeValue = text;
                else title.insertBefore(document.createTextNode(text), title.firstChild);
            }
            updateIcon();
        }

        function resetSearchPagination(): void {
            searchCurrentPage = 0;
            searchTotalPages = 0;
            searchIsLoading = false;
            searchHasMore = false;
            searchYield.fetched = 0;
            searchYield.rendered = 0;
            searchDeduplicator?.clear();
            JE.seamlessScroll?.cleanupInfiniteScroll(searchScrollState);
        }
        /** "Exclude search items already in library": drops the cards that would show "in library". */
        function filterLibraryItems(results: SeerrMediaItem[]): SeerrMediaItem[] {
            if (JE.pluginConfig?.JellyseerrSearchExcludeLibraryItems !== true) return results;
            return results.filter(item => !ui.isInLibrary?.(item));
        }
        const applyFilters = (results: SeerrMediaItem[]): SeerrMediaItem[] => filterLibraryItems(hidden(results));
        /** Warms the cache with the next pages (fire-and-forget). */
        function prefetchSearchPages(query: string, count: number, signal: AbortSignal | null): void {
            if (!searchHasMore || signal?.aborted) return;
            const { title } = parseYearedQuery(query);
            const last = Math.min(searchTotalPages, searchCurrentPage + Math.max(1, count));
            for (let page = searchCurrentPage + 1; page <= last; page++) api.search(title, page, { signal }).catch(() => undefined);
        }
        /** Slots collection cards into the existing row after their movies (no rebuild). */
        function insertCollectionCards(enriched: SeerrMediaItem[]): void {
            const container = document.querySelector('.jellyseerr-section .itemsContainer');
            if (!container) return;
            enriched.forEach((item, i) => {
                if (item.mediaType !== 'collection') return;
                if (searchDeduplicator && !searchDeduplicator.add(item)) return;
                const prev = enriched[i - 1];
                const anchor = prev
                    ? container.querySelector(`.jellyseerr-more-info-link[data-tmdb-id="${prev.id}"][data-media-type="${escapeHtml(prev.mediaType)}"]`)?.closest('.card')
                    : null;
                const card = () => createCard(item);
                if (anchor) {
                    const built = card();
                    if (built) anchor.after(built);
                } else if (batchRendering) {
                    // A batch still being built goes in first, as one appended in one go would have.
                    const rowId = collectionRowId;
                    const append = () => {
                        const built = rowId === collectionRowId && container.isConnected ? card() : null;
                        if (built) container.appendChild(built);
                    };
                    batchRendering.then(append, append);
                } else {
                    const built = card();
                    if (built) container.appendChild(built);
                }
            });
        }
        function noteTyping(): void {
            const now = performance.now();
            const gap = now - lastInputAt;
            const steadyGap = gap <= TYPING_GAP_MAX_MS ? gap : 0;
            // The longer of the last two gaps; a pause resets it.
            typingGapMs = steadyGap && lastInputGapMs ? Math.max(steadyGap, lastInputGapMs) : steadyGap;
            lastInputGapMs = steadyGap;
            lastInputAt = now;
        }
        function renderHoldRemaining(): number {
            if (!typingGapMs) return 0;
            return Math.max(0, lastInputAt + typingGapMs + RENDER_HOLD_MARGIN_MS - performance.now());
        }
        function renderWhenQuiet(query: string, apply: () => void): void {
            pendingRender = { query, apply };
            flushPendingRender();
        }
        function flushPendingRender(): void {
            clearTimer(pendingRenderTimer);
            pendingRenderTimer = null;
            const pending = pendingRender;
            if (!pending) return;
            if (lastProcessedQuery !== pending.query) { pendingRender = null; return; }
            let wait = renderHoldRemaining();
            // Moved on since: its debounce replaces these results, or keeps them if typed back.
            const input = searchInput();
            if (input && input.value !== pending.query) wait = Math.max(wait, lastInputAt + SEARCH_DEBOUNCE_MS + RENDER_HOLD_MARGIN_MS - performance.now());
            if (wait > 0) { pendingRenderTimer = window.setTimeout(flushPendingRender, wait); return; }
            pendingRender = null;
            pending.apply();
        }
        function dropPendingRender(): void {
            clearTimer(pendingRenderTimer);
            pendingRenderTimer = null;
            pendingRender = null;
        }
        function isRowMissing(query: string): boolean {
            return fetchingQuery !== query && pendingRender?.query !== query && !document.querySelector('.jellyseerr-section');
        }
        /**
         * The signal follow-up requests (more pages, collection lookups) run under,
         * re-armed after a navigation abort while the visible page still shows the
         * query; false once it does not (the row is stale and must stop).
         */
        function liveSearchSignal(query: string): AbortSignal | null | false {
            if (!searchSignal?.aborted) return searchSignal;
            const visible = searchInput(true);
            if (!visible || visible.value !== query) return false;
            searchSignal = abortSignal();
            return searchSignal;
        }
        function enrichWithCollections(results: SeerrMediaItem[], query: string): void {
            if (JE.pluginConfig?.ShowCollectionsInSearch === false || !results.some(item => item.mediaType === 'movie')) return;
            queueCollectionLookup({ results, query, rowId: collectionRowId, epoch: epochNow(), generation }, collectionsSettleAt);
        }
        function queueCollectionLookup(batch: CollectionBatch, settleAt: number): void {
            collectionQueue = collectionQueue.then(async () => {
                const wait = Math.min(COLLECTION_SETTLE_MS, settleAt - performance.now());
                if (wait > 0) await new Promise<void>(resolve => window.setTimeout(resolve, wait));
                await lookUpCollections(batch);
            }).catch(() => undefined);
        }
        function isCollectionRowCurrent(batch: CollectionBatch): boolean {
            return batch.rowId === collectionRowId && lastProcessedQuery === batch.query
                && batch.generation === generation && epochCurrent(batch.epoch);
        }
        async function lookUpCollections(batch: CollectionBatch): Promise<void> {
            if (!isCollectionRowCurrent(batch)) return;
            // Typed past (or a navigation settling, or an earlier batch kept): keep it for later, in order.
            unfinishedCollections = unfinishedCollections.filter(isCollectionRowCurrent);
            const visible = searchInput(true);
            if ((visible && visible.value !== batch.query) || searchSuspended || unfinishedCollections.length > 0) {
                unfinishedCollections.push(batch);
                return;
            }
            const signal = liveSearchSignal(batch.query);
            if (signal === false) return;
            let enriched = await prepareResultsWithCollections(batch.results, signal);
            if (!isCollectionRowCurrent(batch)) return;
            // A navigation abort cut it short while the row stands: retry later (answers are remembered).
            if (signal?.aborted) { unfinishedCollections.push(batch); return; }
            enriched = hidden(enriched);
            if (enriched.length > batch.results.length) insertCollectionCards(enriched);
        }
        function resumeCollections(): void {
            if (unfinishedCollections.length === 0) return;
            const visible = searchInput(true);
            if (!visible || visible.value !== lastProcessedQuery) return;
            const batches = unfinishedCollections;
            unfinishedCollections = [];
            for (const batch of batches) queueCollectionLookup(batch, 0);
        }
        function forgetCollections(): void {
            collectionRowId++;
            unfinishedCollections = [];
        }
        async function prepareResultsWithCollections(raw: SeerrMediaItem[], signal: AbortSignal | null): Promise<SeerrMediaItem[]> {
            let results = raw || [];
            if (JE.pluginConfig?.ShowCollectionsInSearch === false) return results;
            try {
                results = await api.addCollections(results, { signal });
            } catch (error) {
                console.debug(`${LOG} Collection addition failed:`, error);
            }
            return withCollectionCards(results);
        }

        // Public modal refresh path. Restrict it to the mounted active query;
        // closing a request modal after leaving search cannot restart that search.
        JE.jellyseerr = {
            async fetchAndRenderResults(query, options = {}) {
                if (!isJellyseerrActive || !searchInput(true) || searchInput(true)?.value !== query) return;
                await fetchAndRenderResults(query, options);
            }
        };

        /** Page 1 for a query, rendered once the viewer pauses typing. */
        async function fetchAndRenderResults(query: string, options: { skipCache?: boolean } = {}): Promise<void> {
            const { skipCache = false } = options;
            lastProcessedQuery = query;
            fetchingQuery = query;
            dropPendingRender();
            forgetCollections();
            resetSearchPagination();
            searchDeduplicator = JE.seamlessScroll?.createDeduplicator?.() || null;
            const { title, year } = parseYearedQuery(query);
            // Cancels the previous keystroke's search and collection requests.
            const signal = abortSignal();
            searchSignal = signal;
            const startedGeneration = generation;
            let data: SearchPage;
            try {
                data = await api.search(title, 1, { skipCache, signal });
            } catch (error) {
                if (isAbortError(error)) return;
                throw error;
            } finally {
                if (fetchingQuery === query) fetchingQuery = null;
            }
            if (lastProcessedQuery !== query || startedGeneration !== generation) return;
            renderWhenQuiet(query, () => renderFirstPage(query, data, year));
        }
        function renderFirstPage(query: string, data: SearchPage, yearFilter: string | null): void {
            let results = filterResultsByYear(data.results || [], yearFilter);
            searchCurrentPage = data.page || 1;
            searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
            searchHasMore = searchCurrentPage < searchTotalPages;
            searchYield.fetched += results.length;
            results = applyFilters(results);
            if (searchDeduplicator) results = searchDeduplicator.filter(results);
            searchYield.rendered += results.length;
            // Even an empty first page gets a row while pages remain: filtering may have removed it all.
            if (results.length > 0 || searchHasMore) ui.renderJellyseerrResults?.(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
            if (results.length > 0) {
                collectionsSettleAt = performance.now() + COLLECTION_SETTLE_MS;
                collectionQueue = Promise.resolve();
                enrichWithCollections(results, query);
            }
            // The engine fills the row buffer at once, so it starts before the collection lookups compete.
            if (searchHasMore) setupSearchInfiniteScroll(query);
        }
        /** The next page(s), several in parallel when the row's deficit or a low yield calls for it. */
        async function loadMoreSearchResults(query: string, hint?: ScrollHint): Promise<{ pages: number; rendered: number } | undefined> {
            if (searchIsLoading || !searchHasMore || lastProcessedQuery !== query) return undefined;
            if (searchSuspended) return undefined;
            const liveSignal = liveSearchSignal(query);
            if (liveSignal === false) { searchHasMore = false; return undefined; }
            searchIsLoading = true;
            const signal = liveSignal || null;
            const firstPage = searchCurrentPage + 1;
            const { title, year } = parseYearedQuery(query);
            const startedGeneration = generation;
            try {
                const found = document.querySelector('.jellyseerr-section .itemsContainer');
                const itemsContainer = found instanceof HTMLElement ? found : null;
                const wantCards = JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, 20) || 20;
                const budget = hint?.pageBudget;
                const pageBudget = typeof budget === 'number' && Number.isFinite(budget) ? Math.max(1, budget) : Infinity;
                const count = pagesToLoad(wantCards, searchYield.fetched, searchYield.rendered, searchTotalPages - searchCurrentPage, pageBudget);
                const pages: number[] = [];
                for (let page = firstPage; page < firstPage + count; page++) pages.push(page);
                const settled = await Promise.allSettled(pages.map(page => api.search(title, page, { signal, throwOnError: true })));
                if (lastProcessedQuery !== query || startedGeneration !== generation) return undefined;
                // Pages commit in order up to the first failure; a flaky page does not discard the others.
                let results: SeerrMediaItem[] = [];
                let committed = 0;
                let firstError: unknown = null;
                for (let i = 0; i < settled.length; i++) {
                    const outcome = settled[i];
                    if (!outcome) break;
                    if (outcome.status !== 'fulfilled') {
                        if (isAbortError(outcome.reason)) throw outcome.reason;
                        firstError = outcome.reason;
                        break;
                    }
                    results.push(...(outcome.value.results || []));
                    searchCurrentPage = outcome.value.page || pages[i] || searchCurrentPage;
                    if (outcome.value.totalPages) searchTotalPages = Math.min(outcome.value.totalPages, TMDB_MAX_PAGE);
                    committed++;
                }
                if (firstError && committed === 0) throw firstError;
                searchHasMore = searchCurrentPage < searchTotalPages;
                results = filterResultsByYear(results, year);
                searchYield.fetched += results.length;
                results = applyFilters(results);
                if (searchDeduplicator) results = searchDeduplicator.filter(results);
                searchYield.rendered += results.length;
                // Keep the cache warm once the viewer reads the row, within the empty-page budget.
                if (hint?.engaged) {
                    const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pages.length);
                    const prefetch = results.length > 0 ? count : Math.min(count, remainingBudget);
                    if (prefetch > 0) prefetchSearchPages(query, prefetch, signal);
                }
                if (results.length > 0 && itemsContainer) {
                    const slices = JE.discoveryFilter?.appendInSlices;
                    if (slices) {
                        // Cards in view go in at once; the rest in short slices, dropped by a new search.
                        const rowId = collectionRowId;
                        const isCurrent = () => rowId === collectionRowId && lastProcessedQuery === query && itemsContainer.isConnected && startedGeneration === generation;
                        const rendering = slices(itemsContainer, results, createCard, {
                            syncCount: JE.discoveryFilter?.cardsInView?.(itemsContainer, { horizontal: true }) ?? 0,
                            isCurrent
                        });
                        batchRendering = rendering;
                        try {
                            await rendering;
                        } finally {
                            if (batchRendering === rendering) batchRendering = null;
                        }
                        if (!isCurrent()) return undefined;
                    } else {
                        const fragment = document.createDocumentFragment();
                        for (const item of results) {
                            const card = createCard(item);
                            if (card) fragment.appendChild(card);
                        }
                        itemsContainer.appendChild(fragment);
                    }
                    enrichWithCollections(results, query);
                }
                return { pages: committed, rendered: itemsContainer ? results.length : 0 };
            } catch (error) {
                if (!isAbortError(error)) {
                    console.warn(`${LOG} Failed to load more search results:`, error);
                    // Roll back so the retry fetches the same pages.
                    searchCurrentPage = firstPage - 1;
                    searchHasMore = true;
                }
                throw error; // seamlessScroll's retry handling
            } finally {
                searchIsLoading = false;
            }
        }
        function setupSearchInfiniteScroll(query: string): void {
            JE.seamlessScroll?.setupInfiniteScroll(searchScrollState, '.jellyseerr-section',
                hint => loadMoreSearchResults(query, hint), () => searchHasMore && !searchSuspended, () => searchIsLoading,
                { horizontal: true, trackSelector: '.itemsContainer', scrollerSelector: '.emby-scroller' });
        }
        /** The refresh button: fresh page 1, cards rebuilt in place. */
        async function manualRefreshJellyseerrData(query: string | null): Promise<void> {
            const section = document.querySelector('.jellyseerr-section');
            const itemsContainer = section?.querySelector('.itemsContainer');
            if (!query || !(itemsContainer instanceof HTMLElement)) return;
            console.log(`${LOG} Refreshing data for query: "${query}"`);
            const startedGeneration = generation;
            try {
                // The rebuilt row carries page 1's collections itself.
                forgetCollections();
                resetSearchPagination();
                searchDeduplicator = JE.seamlessScroll?.createDeduplicator?.() || null;
                const signal = abortSignal();
                searchSignal = signal;
                const { title, year } = parseYearedQuery(query);
                const data = await api.search(title, 1, { signal, skipCache: true });
                let results = await prepareResultsWithCollections(filterResultsByYear(data.results || [], year), signal);
                if (startedGeneration !== generation || !itemsContainer.isConnected) return;
                results = applyFilters(results);
                searchCurrentPage = data.page || 1;
                searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
                searchHasMore = searchCurrentPage < searchTotalPages;
                searchDeduplicator?.filter(results);
                ui.releasePosters?.(itemsContainer);
                while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
                for (const item of results) {
                    const card = createCard(item);
                    if (card) itemsContainer.appendChild(card);
                }
                ui.updateJellyseerrResults?.(results, isJellyseerrActive, jellyseerrUserFound, itemsContainer);
                if (searchHasMore) setupSearchInfiniteScroll(query);
            } catch (error) {
                if (!isAbortError(error)) console.warn(`${LOG} Failed to refresh Seerr data:`, error);
            }
        }

        /** Leaves the search row empty and idle (navigation away, emptied box, account change). */
        function teardownRow(): void {
            clearTimer(debounceTimeout);
            debounceTimeout = null;
            dropPendingRender();
            forgetCollections();
            lastProcessedQuery = null;
            restoreNativeResults();
            resetSearchPagination();
            ui.clearInjectedSearchResults?.();
            updateIcon();
        }
        function initializePageObserver(): void {
            const handleSearch = () => {
                const input = searchInput();
                const currentQuery = input ? input.value : null;
                noteTyping();
                // Typed past a query whose first page is on its way: abort it now.
                if (fetchingQuery !== null && fetchingQuery !== currentQuery) JE.requestManager?.abortRequest?.('jellyseerr-search');
                if (input && currentQuery?.trim()) {
                    clearTimer(debounceTimeout);
                    debounceTimeout = window.setTimeout(() => {
                        if (!isJellyseerrActive) {
                            teardownRow();
                            return;
                        }
                        const latestQuery = input.value;
                        // Already processed and its row is here or on its way: finish its skipped collections.
                        if (latestQuery === lastProcessedQuery && !isRowMissing(latestQuery)) {
                            resumeCollections();
                            return;
                        }
                        if (isJellyseerrOnlyMode) {
                            restoreNativeResults();
                            updateIcon();
                        }
                        lastProcessedQuery = latestQuery;
                        resetSearchPagination();
                        ui.clearInjectedSearchResults?.();
                        void fetchAndRenderResults(latestQuery).catch(error => console.warn(`${LOG} Search failed:`, error));
                    }, SEARCH_DEBOUNCE_MS);
                } else {
                    teardownRow();
                }
            };
            /** Attaches the input listener once per search input (idempotent). */
            const tryAttachSearchListener = () => {
                updateIcon();
                const input = searchInput();
                if (!input || input.dataset.jellyseerrListener) return;
                console.debug(`${LOG} Search input found, attaching listener.`);
                input.addEventListener('input', handleSearch);
                input.dataset.jellyseerrListener = 'true';
                // The alphabet picker updates the box shortly after its click.
                document.querySelector('.alphaPicker')?.addEventListener('click', () => window.setTimeout(handleSearch, 100));
                // A page that loads with a query already in the box.
                handleSearch();
            };
            /** Every navigation: tear the row down off the (visible) search page, else rebuild a lost row. */
            const handleNavigate = () => {
                const input = searchInput(true);
                if (!input) { teardownRow(); return; }
                tryAttachSearchListener();
                // A view re-render removed the row while the query is unchanged: no input event rebuilds it.
                if (isJellyseerrActive && input.value.trim() && input.value === lastProcessedQuery && isRowMissing(input.value)) {
                    resetSearchPagination();
                    void fetchAndRenderResults(input.value).catch(error => console.warn(`${LOG} Search failed:`, error));
                    return;
                }
                resumeCollections();
            };
            document.addEventListener('jellyseerr-manual-refresh', () => {
                void manualRefreshJellyseerrData(searchInput()?.value ?? null);
            });
            JE.helpers?.onBodyMutation?.('jellyseerr-search-listener', tryAttachSearchListener);
            // The search page may already be rendered (direct navigation before init).
            tryAttachSearchListener();
            const onNav = () => {
                searchSuspended = true;
                // Only the latest of overlapping navigations settles.
                clearTimer(navigateSettleTimer);
                navigateSettleTimer = window.setTimeout(() => {
                    searchSuspended = false;
                    handleNavigate();
                    searchScrollState.fill?.();
                }, 200);
            };
            if (JE.helpers?.onNavigate) {
                JE.helpers.onNavigate(onNav);
            } else {
                window.addEventListener('popstate', onNav);
                window.addEventListener('hashchange', onNav);
            }
        }

        /** Seerr reachability and the account link for the current user; a stale answer is dropped. */
        async function refreshStatus(): Promise<void> {
            const startedGeneration = generation;
            const status = await api.checkUserStatus();
            if (startedGeneration !== generation) return;
            isJellyseerrActive = status.active;
            jellyseerrUserFound = status.userFound;
            console.debug(`${LOG} Status: active=${isJellyseerrActive}, userFound=${jellyseerrUserFound}`);
        }
        function waitForUserAndInitialize(): void {
            const startTime = Date.now();
            const checkForUser = async () => {
                const client = host.apiClient();
                if (client?.getCurrentUserId?.() && client.accessToken?.()) {
                    console.log(`${LOG} User session found. Initializing...`);
                    await refreshStatus();
                    initializePageObserver();
                    // Genre lists for instant discovery (no request when this tab keeps fresh copies).
                    if (isJellyseerrActive && JE.pluginConfig?.JellyseerrShowGenreDiscovery !== false) {
                        void Promise.all([
                            JE.discoveryFilter?.fetchTmdbGenreList?.('tv', {})?.catch(() => undefined),
                            JE.discoveryFilter?.fetchTmdbGenreList?.('movie', {})?.catch(() => undefined)
                        ]).catch(() => undefined);
                    }
                } else if (Date.now() - startTime > USER_WAIT_TIMEOUT_MS) {
                    console.warn(`${LOG} Timed out waiting for user session. Features may be limited.`);
                    initializePageObserver();
                } else {
                    window.setTimeout(() => { void checkForUser(); }, 300);
                }
            };
            void checkForUser();
        }
        // Another account (or server): the row, the filter and the Seerr status are not its own.
        session?.onUserChange('jellyseerr-search', () => {
            generation++;
            isJellyseerrActive = false;
            jellyseerrUserFound = false;
            teardownRow();
            // After the transition completes (leases taken inside the reset callback are already stale).
            window.setTimeout(() => {
                void refreshStatus().then(() => {
                    updateIcon();
                    const input = searchInput(true);
                    if (isJellyseerrActive && input?.value.trim()) void fetchAndRenderResults(input.value).catch(() => undefined);
                });
            }, 0);
        });

        ui.addMainStyles?.();
        ui.addSeasonModalStyles?.();
        waitForUserAndInitialize();

        // Touching outside a request button, or scrolling, hides (and unlocks) the popover.
        document.addEventListener('touchstart', event => {
            if (!(event.target instanceof Element) || !event.target.closest('.jellyseerr-request-button')) {
                ui.toggleHoverPopoverLock?.(false);
                ui.hideHoverPopover?.();
            }
        }, { passive: true });
        document.addEventListener('scroll', () => {
            ui.toggleHoverPopoverLock?.(false);
            ui.hideHoverPopover?.();
        }, true);
        document.body.addEventListener('touchstart', event => {
            if (!(event.target instanceof Element) || !event.target.closest('.jellyseerr-card')) {
                document.querySelectorAll('.jellyseerr-card.is-touch').forEach(card => card.classList.remove('is-touch'));
            }
        }, { passive: true });
        document.body.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest('.jellyseerr-button-group') && !target?.closest('.jellyseerr-4k-popup')) document.querySelector('.jellyseerr-4k-popup')?.remove();
        });

        const titleFor = (card: Element | null, item: SeerrMediaItem | null, fallback: string): string =>
            card?.querySelector('.cardText-first bdi')?.textContent || item?.name || item?.title || item?.originalName || item?.originalTitle || fallback;
        /** The failure text of a request a body-level button made (the server's message escaped by the caller). */
        const failureText = (error: unknown, fallback: string, userNotFound: string): string => {
            const kind = classifyFailure(error, JE.pluginConfig?.JellyseerrShowQuotaInfo !== false);
            if (kind === 'uncertain') return uncertainMessage(JE);
            if (errorStatus(error) === 404) return userNotFound;
            return errorBody(error).message || fallback;
        };
        async function onPopupItem(item: HTMLButtonElement, event: MouseEvent): Promise<void> {
            if (!isViewCurrent(host, item)) return;
            const action = item.dataset.action;
            const tmdbId = item.dataset.tmdbId;
            const mediaType = String(item.dataset.mediaType || 'movie').toLowerCase();
            if (action !== 'request4k' || !tmdbId) return;
            const popup = item.closest('.jellyseerr-4k-popup');
            item.disabled = true;
            item.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
            const card = event.target instanceof Element ? event.target.closest('.jellyseerr-card') : null;
            const resultItem = parseItemAttribute(card?.querySelector<HTMLElement>('.jellyseerr-request-button')?.dataset.searchResultItem);
            const title = titleFor(card, resultItem, mediaType === 'tv' ? 'this show' : 'this movie');
            if (mediaType === 'tv') {
                popup?.remove();
                void ui.showSeasonSelectionModal?.(tmdbId, 'tv', title, resultItem, true);
                return;
            }
            if (api.shouldShowAdvanced()) {
                popup?.remove();
                void ui.showMovieRequestModal?.(tmdbId, title, resultItem, true);
                return;
            }
            const origin = captureOrigin(host);
            try {
                const response = await api.requestMedia(tmdbId, 'movie', {}, true, resultItem);
                if (!origin.current()) return;
                console.debug(`${LOG} Seerr 4K request response:`, response);
                JE.toast?.('4K request submitted successfully!', 3000);
                popup?.remove();
                // The results row shows the new 4K status once the box still shows this query.
                const query = hashQuery(window.location);
                if (query) {
                    window.setTimeout(() => {
                        if (origin.current() && searchInput(true)?.value === query) void fetchAndRenderResults(query, { skipCache: true }).catch(() => undefined);
                    }, 1000);
                }
            } catch (error) {
                if (!origin.current()) return;
                if (ui.isQuotaError?.(error)) await ui.showQuotaErrorDialog?.(error, 'movie');
                else JE.toast?.(escapeHtml(failureText(error, 'Failed to request 4K version', 'User not found')), 4000);
                item.disabled = false;
                item.innerHTML = `<span>${JE.t('jellyseerr_btn_request_4k')}</span>`;
            }
        }
        async function onRequestButton(button: HTMLButtonElement): Promise<void> {
            if (!isViewCurrent(host, button)) return;
            const mediaType = button.dataset.mediaType;
            const tmdbId = button.dataset.tmdbId;
            const collectionId = button.dataset.collectionId;
            const resultItem = parseItemAttribute(button.dataset.searchResultItem);
            const card = button.closest('.jellyseerr-card');
            const title = titleFor(card, resultItem, mediaType === 'movie' ? 'this movie' : mediaType === 'collection' ? 'this collection' : 'this show');
            if (mediaType === 'collection' && collectionId) { void ui.showCollectionRequestModal?.(collectionId, title, resultItem); return; }
            if (mediaType === 'tv' && tmdbId) { void ui.showSeasonSelectionModal?.(tmdbId, mediaType, title, resultItem); return; }
            if (mediaType !== 'movie' || !tmdbId) return;
            if (api.shouldShowAdvanced()) { void ui.showMovieRequestModal?.(tmdbId, title, resultItem); return; }
            const origin = captureOrigin(host);
            button.disabled = true;
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
            const idle = () => `${icons().request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
            try {
                await api.requestMedia(tmdbId, mediaType, {}, false, resultItem);
                if (!origin.current()) { button.disabled = false; button.innerHTML = idle(); return; }
                button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons().requested}`;
                button.classList.remove('jellyseerr-button-request');
                button.classList.add('jellyseerr-button-pending');
            } catch (error) {
                button.disabled = false;
                if (!origin.current()) { button.innerHTML = idle(); return; }
                if (ui.isQuotaError?.(error)) {
                    await ui.showQuotaErrorDialog?.(error, 'movie');
                    button.innerHTML = idle();
                    return;
                }
                const message = failureText(error, JE.t('jellyseerr_btn_error'), JE.t('jellyseerr_btn_user_not_found'));
                button.innerHTML = `<span>${escapeHtml(message)}</span>${icons().error}`;
                button.classList.add('jellyseerr-button-error');
            }
        }
        // Request buttons without a handler of their own (TV, collections) and 4K popup items.
        document.body.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;
            const popupItem = target.closest('.jellyseerr-4k-popup-item');
            if (popupItem) {
                if (popupItem instanceof HTMLButtonElement) void onPopupItem(popupItem, event);
                return;
            }
            const button = target.closest('.jellyseerr-request-button');
            if (button instanceof HTMLButtonElement && !button.disabled) void onRequestButton(button);
        });
        console.log(`${LOG} Initialization complete.`);
    }
}
