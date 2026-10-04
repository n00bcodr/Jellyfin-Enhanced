// /js/jellyseerr/jellyseerr.js
(function(JE) {
    'use strict';

    /**
     * Main initialization function for Seerr search integration.
     * This function sets up the state, observers, and event listeners.
     */
    JE.initializeJellyseerrScript = function() {
        // Early exit if Seerr integration or search results are disabled in plugin settings
        if (!JE.pluginConfig.JellyseerrEnabled) {
            console.log('🪼 Jellyfin Enhanced: Seerr Search: Integration is disabled in plugin settings.');
            return;
        }
        if (JE.pluginConfig.JellyseerrShowSearchResults === false) {
            console.log('🪼 Jellyfin Enhanced: Seerr Search: Search results are disabled in plugin settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Seerr:';
        const escapeHtml = JE.escapeHtml;
        console.log(`${logPrefix} Initializing...`);

        // ================================
        // STATE MANAGEMENT VARIABLES
        // ================================
        let lastProcessedQuery = null;
        // Query whose page-1 fetch is in flight (null once its response is in,
        // or it was dropped): the navigation-settle rebuild must not start a second
        // search for a query the input handler is already fetching.
        let fetchingQuery = null;
        // Page-1 results that arrived while the viewer was still typing, held
        // until they pause (see renderWhenQuiet); null when nothing is held.
        /** @type {{query: string, apply: Function}|null} */
        let pendingRender = null;
        let pendingRenderTimer = null;
        // The viewer's typing rhythm (see noteTyping): when the box last
        // changed, the gap before that change, and the longer of the last two
        // gaps (0 after a pause).
        let lastInputAt = 0;
        let lastInputGapMs = 0;
        let typingGapMs = 0;
        // When the rendered query's collection lookups may start, and the chain
        // that runs them one rendered batch after another.
        let collectionsSettleAt = 0;
        let collectionQueue = Promise.resolve();
        // The row a collection lookup belongs to: bumped whenever a search
        // starts or the row is torn down or rebuilt, so a lookup only ever
        // inserts into the row it was queued for.
        let collectionRowId = 0;
        // That row's batches whose lookup hasn't completed because the box was
        // off its query when their turn came (or a navigation abort cut them
        // short), in render order; resumeCollections runs them once the box
        // has settled back on the query.
        /** @type {Array<{results: Array, query: string, rowId: number, epoch: number}>} */
        let unfinishedCollections = [];
        let debounceTimeout = null;
        let isJellyseerrActive = false;
        let jellyseerrUserFound = false;
        let isJellyseerrOnlyMode = false;
        let hiddenSections = [];
        let jellyseerrOriginalPosition = null;

        // Infinite scroll pagination state
        let searchCurrentPage = 0;
        let searchTotalPages = 0;
        let searchIsLoading = false;
        let searchHasMore = false;
        const searchScrollState = {};
        let searchDeduplicator = null;
        /** @type {AbortSignal|null} */
        let searchSignal = null;
        // True from the moment a navigation starts until the delayed teardown
        // check has run; no search load may start or re-arm in that window.
        // Exposed through the engine's hasMore check so the pause is never
        // mistaken for a run of empty pages.
        let searchSuspended = false;
        let navigateSettleTimer = null;
        // Items fetched vs cards rendered for the current query (after hidden
        // content + dedup filtering); sizes the parallel page batches.
        const searchYield = { fetched: 0, rendered: 0 };
        const MAX_SEARCH_PAGES_PER_LOAD = 4;
        // TMDB refuses search pages beyond 500; never ask for them.
        const TMDB_MAX_PAGE = 500;
        // How long a rendered query must stand before its collection lookup
        // (one batched request per rendered batch of results) starts. A query
        // the viewer rendered and then typed on from is replaced within this
        // time and its lookup would only be aborted half-way; a settled query
        // loses this much on its collection cards.
        const COLLECTION_SETTLE_MS = 300;
        // A search starts once the box has been quiet this long.
        const SEARCH_DEBOUNCE_MS = 200;
        // Page-1 results replace the row only once the box has been quiet for
        // the viewer's own gap between keys plus RENDER_HOLD_MARGIN_MS, so a
        // viewer typing slower than the debounce no longer gets a full row
        // rebuild (plus its next pages) for every prefix. A gap longer than
        // TYPING_GAP_MAX_MS is a pause, not typing, and holds nothing. The
        // search itself still starts after SEARCH_DEBOUNCE_MS and the hold runs
        // during its round trip, so a settled query only waits for whatever
        // part of (gap + margin - debounce) the round trip didn't cover: none
        // for keys up to 170 ms apart, at most 130 ms at 300 ms per key.
        const TYPING_GAP_MAX_MS = 450;
        const RENDER_HOLD_MARGIN_MS = 30;


        // Destructure modules for easy access
        const { checkUserStatus, search, requestMedia } = JE.jellyseerrAPI;
        const {
            addMainStyles, addSeasonModalStyles, updateJellyseerrIcon,
            renderJellyseerrResults, showMovieRequestModal, showSeasonSelectionModal,
            showCollectionRequestModal, hideHoverPopover, toggleHoverPopoverLock, updateJellyseerrResults,
            createJellyseerrCard, clearInjectedSearchResults
        } = JE.jellyseerrUI;

        /**
         * Toggles between showing all search results vs only Seerr results.
         */
        function toggleJellyseerrOnlyMode() {
            isJellyseerrOnlyMode = !isJellyseerrOnlyMode;

            const searchPage = document.querySelector('#searchPage');
            if (!searchPage) return;

            if (isJellyseerrOnlyMode) {
                const allSections = searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)');
                hiddenSections = Array.from(allSections);
                allSections.forEach(section => section.classList.add('section-hidden'));

                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection) {
                    jellyseerrOriginalPosition = document.createElement('div');
                    jellyseerrOriginalPosition.id = 'jellyseerr-placeholder';
                    jellyseerrSection.parentNode.insertBefore(jellyseerrOriginalPosition, jellyseerrSection);
                    const searchResults = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                    if (searchResults) {
                        searchResults.insertBefore(jellyseerrSection, searchResults.firstChild);
                    }
                }
                searchPage.querySelectorAll('.noItemsMessage').forEach(el => el.classList.add('section-hidden'));

                JE.toast(JE.t('jellyseerr_toast_filter_on'), 3000);

            } else {
                hiddenSections.forEach(section => section.classList.remove('section-hidden'));
                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection && jellyseerrOriginalPosition?.parentNode) {
                    jellyseerrOriginalPosition.parentNode.insertBefore(jellyseerrSection, jellyseerrOriginalPosition);
                    jellyseerrOriginalPosition.remove();
                    jellyseerrOriginalPosition = null;
                }
                searchPage.querySelectorAll('.noItemsMessage').forEach(el => el.classList.remove('section-hidden'));

                hiddenSections = [];
                JE.toast(JE.t('jellyseerr_toast_filter_off'), 3000);
            }

            const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
            if (jellyseerrSection) {
                const titleElement = jellyseerrSection.querySelector('.sectionTitle');
                if (titleElement) {
                    titleElement.textContent = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');
                }
            }
            updateJellyseerrIcon(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, toggleJellyseerrOnlyMode);
        }

        /**
         * Resets search pagination state for a new query.
         */
        function resetSearchPagination() {
            searchCurrentPage = 0;
            searchTotalPages = 0;
            searchIsLoading = false;
            searchHasMore = false;
            searchYield.fetched = 0;
            searchYield.rendered = 0;
            if (searchDeduplicator) searchDeduplicator.clear();
            JE.seamlessScroll?.cleanupInfiniteScroll(searchScrollState);
        }

        /**
         * Drops results that are already in the Jellyfin library (the cards
         * that would show the "available" tick, including partially available
         * shows) when "Exclude search items already in library" is enabled.
         * @param {Array} results Seerr search results.
         * @returns {Array} The results to render.
         */
        function filterLibraryItems(results) {
            if (JE.pluginConfig?.JellyseerrSearchExcludeLibraryItems !== true) return results;
            return results.filter(item => !JE.jellyseerrUI.isInLibrary(item));
        }

        /**
         * Splits a "Title (YYYY)" query - the same year convention shown on
         * every result card - into a plain-text title for the search API and
         * the year to filter results by. The year only takes effect once the
         * closing paren is typed, so it never mangles the query mid-keystroke.
         * @param {string} raw The raw search box value.
         * @returns {{ title: string, year: string|null }}
         */
        function parseYearedQuery(raw) {
            const match = raw.match(/^(.*\S)\s*\((\d{4})\)\s*$/);
            return match ? { title: match[1], year: match[2] } : { title: raw, year: null };
        }

        /**
         * @param {Object} item A Seerr search result.
         * @returns {string|null} The result's 4-digit release year, matching the one shown on its card.
         */
        function getResultYear(item) {
            return item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || null;
        }

        /**
         * @param {Array} results
         * @param {string|null} year
         * @returns {Array} Results narrowed to the given release year, unfiltered when year is null.
         */
        function filterResultsByYear(results, year) {
            return year ? results.filter(item => getResultYear(item) === year) : results;
        }

        /**
         * Warms the request cache with the next `count` result pages so the
         * following load-more is served instantly. Fire-and-forget.
         * @param {string} query
         * @param {number} count
         * @param {AbortSignal|null} signal
         */
        function prefetchSearchPages(query, count, signal) {
            if (!searchHasMore || signal?.aborted) return;
            const { title: apiQuery } = parseYearedQuery(query);
            const last = Math.min(searchTotalPages, searchCurrentPage + Math.max(1, count));
            for (let p = searchCurrentPage + 1; p <= last; p++) {
                search(apiQuery, p, { signal }).catch(() => {});
            }
        }

        /**
         * Inserts synthetic collection cards into the existing results row,
         * each right after the movie it belongs to, without rebuilding the
         * section (a rebuild would drop the pages appended by infinite scroll
         * and detach its sentinel).
         * @param {Array} enrichedResults Results with collection cards spliced in.
         */
        function insertCollectionCards(enrichedResults) {
            const container = document.querySelector('.jellyseerr-section .itemsContainer');
            if (!container) return;
            for (let i = 0; i < enrichedResults.length; i++) {
                const item = enrichedResults[i];
                if (item.mediaType !== 'collection') continue;
                if (searchDeduplicator && !searchDeduplicator.add(item)) continue;
                const prev = enrichedResults[i - 1];
                const anchor = prev
                    ? container.querySelector(`.jellyseerr-more-info-link[data-tmdb-id="${prev.id}"][data-media-type="${prev.mediaType}"]`)?.closest('.card')
                    : null;
                const card = createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
                if (anchor) anchor.after(card); else container.appendChild(card);
            }
        }

        /**
         * Records a change of the search box (a key, or an alphabet-picker
         * letter) for renderHoldRemaining: when it happened and the viewer's
         * current gap between changes.
         */
        function noteTyping() {
            const now = performance.now();
            const gap = now - lastInputAt;
            const steadyGap = gap <= TYPING_GAP_MAX_MS ? gap : 0;
            // The longer of the last two gaps, so one quick pair of keys does
            // not shorten the hold; a pause resets it.
            typingGapMs = steadyGap && lastInputGapMs ? Math.max(steadyGap, lastInputGapMs) : steadyGap;
            lastInputGapMs = steadyGap;
            lastInputAt = now;
        }

        /**
         * How much longer page-1 results must wait before they replace the
         * row: while the viewer types at a steady rhythm, until the box has
         * been quiet a little longer than their gap between keys, so a prefix
         * they are about to type past is never rendered.
         * @returns {number} Milliseconds still to wait; 0 to render now.
         */
        function renderHoldRemaining() {
            if (!typingGapMs) return 0;
            return Math.max(0, lastInputAt + typingGapMs + RENDER_HOLD_MARGIN_MS - performance.now());
        }

        /**
         * Applies a query's page-1 results now, or once the viewer has paused
         * (renderHoldRemaining). A newer search drops them (dropPendingRender).
         * @param {string} query The query the results belong to.
         * @param {Function} apply Renders them.
         */
        function renderWhenQuiet(query, apply) {
            pendingRender = { query, apply };
            flushPendingRender();
        }

        /**
         * Renders the held page-1 results if the box is still quiet and on
         * their query; otherwise checks again when it may be.
         */
        function flushPendingRender() {
            clearTimeout(pendingRenderTimer);
            pendingRenderTimer = null;
            const pending = pendingRender;
            if (!pending) return;
            if (lastProcessedQuery !== pending.query) {
                pendingRender = null;
                return;
            }
            let wait = renderHoldRemaining();
            // The box has moved on since this search: its debounce is about to
            // replace these results, or keep them if the viewer typed back to
            // this query (handleSearch leaves a held query alone).
            const searchInput = document.querySelector('#searchPage #searchTextInput');
            if (searchInput && searchInput.value !== pending.query) {
                wait = Math.max(wait, lastInputAt + SEARCH_DEBOUNCE_MS + RENDER_HOLD_MARGIN_MS - performance.now());
            }
            if (wait > 0) {
                pendingRenderTimer = setTimeout(flushPendingRender, wait);
                return;
            }
            pendingRender = null;
            pending.apply();
        }

        /**
         * Forgets held page-1 results (a newer search started, or the search
         * box was emptied or left).
         */
        function dropPendingRender() {
            clearTimeout(pendingRenderTimer);
            pendingRenderTimer = null;
            pendingRender = null;
        }

        /**
         * Whether the row for a processed query is missing with nothing on its
         * way: its search is neither running nor held for a pause, and no row
         * is on the page (a view re-render removed it, or its search was
         * aborted when the viewer typed past the query and then back to it).
         * @param {string} query
         * @returns {boolean}
         */
        function isRowMissing(query) {
            return fetchingQuery !== query && pendingRender?.query !== query
                && !document.querySelector('.jellyseerr-section');
        }

        /**
         * The signal the rendered query's follow-up requests (more pages,
         * collection lookups) run under. The global navigation abort cancels it
         * whenever the URL changes, even if the search page still shows this
         * very query (jellyfin-web rewrote the URL's query param, or a key was
         * typed and deleted again); it is re-armed then.
         * @param {string} query The rendered query.
         * @returns {AbortSignal|null|false} False when the visible search page
         *   no longer shows this query: the row is stale and must stop.
         */
        function liveSearchSignal(query) {
            if (!searchSignal?.aborted) return searchSignal;
            const visibleInput = document.querySelector('#searchPage:not(.hide) #searchTextInput');
            if (!visibleInput || visibleInput.value !== query) return false;
            searchSignal = JE.requestManager?.getAbortSignal('jellyseerr-search') || null;
            return searchSignal;
        }

        /**
         * Slots the collection cards for one rendered batch of results (page 1,
         * or a batch infinite scroll appended) into the row: one batched lookup
         * for the batch's movies, once the query has stood for
         * COLLECTION_SETTLE_MS. Batches run in the order they were rendered, so
         * a collection spanning several pages keeps its card after its first
         * movie.
         * @param {Array} results The batch as rendered (already filtered).
         * @param {string} query The query it belongs to.
         */
        function enrichWithCollections(results, query) {
            if (JE.pluginConfig.ShowCollectionsInSearch === false || !results.some(item => item.mediaType === 'movie')) return;
            const epoch = JE.session ? JE.session.getEpoch() : 0;
            queueCollectionLookup({ results, query, rowId: collectionRowId, epoch }, collectionsSettleAt);
        }

        /**
         * Appends one batch's collection lookup to the row's chain.
         * @param {{results: Array, query: string, rowId: number, epoch: number}} batch
         * @param {number} settleAt Time (Date.now) before which it must not start.
         */
        function queueCollectionLookup(batch, settleAt) {
            collectionQueue = collectionQueue.then(async () => {
                const wait = settleAt - Date.now();
                if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
                await lookUpCollections(batch);
            }).catch(() => {});
        }

        /**
         * Whether a batch's row is still the one on the page: same search, not
         * torn down since, and the same signed-in user.
         * @param {{query: string, rowId: number, epoch: number}} batch
         * @returns {boolean}
         */
        function isCollectionRowCurrent(batch) {
            return batch.rowId === collectionRowId && lastProcessedQuery === batch.query
                && (!JE.session || JE.session.isCurrent(batch.epoch));
        }

        /**
         * Runs one batch's collection lookup and inserts its cards, or keeps
         * the batch in unfinishedCollections when it can't complete now but
         * its row may still want it.
         * @param {{results: Array, query: string, rowId: number, epoch: number}} batch
         */
        async function lookUpCollections(batch) {
            if (!isCollectionRowCurrent(batch)) return;
            // Typed on from since it rendered: its successor is about to replace
            // it, unless the viewer types back to it before the debounce runs,
            // so keep the batch for then. Likewise while a navigation settles
            // (nothing may re-arm the search signal then; handleNavigate
            // resumes or drops it). An earlier batch already kept means this
            // one waits behind it (render order decides card placement).
            unfinishedCollections = unfinishedCollections.filter(isCollectionRowCurrent);
            const visibleInput = document.querySelector('#searchPage:not(.hide) #searchTextInput');
            if ((visibleInput && visibleInput.value !== batch.query) || searchSuspended || unfinishedCollections.length > 0) {
                unfinishedCollections.push(batch);
                return;
            }
            const signal = liveSearchSignal(batch.query);
            if (signal === false) return;
            let enrichedResults = await prepareResultsWithCollections(batch.results, { signal });
            if (!isCollectionRowCurrent(batch)) return;
            // A navigation abort (jellyfin-web rewrites the URL as the viewer
            // types) cut the lookup short while the row still stands: keep it.
            // The movies it did answer are remembered, so the retry only asks
            // for the rest.
            if (signal?.aborted) {
                unfinishedCollections.push(batch);
                return;
            }
            if (JE.hiddenContent) enrichedResults = JE.hiddenContent.filterJellyseerrResults(enrichedResults, 'search');
            if (enrichedResults.length > batch.results.length) {
                insertCollectionCards(enrichedResults);
            }
        }

        /**
         * Runs the rendered row's unfinished collection lookups again, in render
         * order, now that the box has settled back on its query (the search
         * debounce found the row already there, or a navigation settled on it).
         */
        function resumeCollections() {
            if (unfinishedCollections.length === 0) return;
            const visibleInput = document.querySelector('#searchPage:not(.hide) #searchTextInput');
            if (!visibleInput || visibleInput.value !== lastProcessedQuery) return;
            const batches = unfinishedCollections;
            unfinishedCollections = [];
            // Each re-checks its row as it runs, and any the box moves off again
            // goes back into unfinishedCollections, still in order.
            batches.forEach(batch => queueCollectionLookup(batch, 0));
        }

        /**
         * Detaches every queued or kept collection lookup from the row (a new
         * search started, or the row was torn down or rebuilt): none of them
         * inserts anything after this.
         */
        function forgetCollections() {
            collectionRowId++;
            unfinishedCollections = [];
        }

        /**
         * Fetches search results (page 1) and renders them once the viewer has
         * stopped typing (renderWhenQuiet).
         * @param {string} query The search query.
         */
        async function fetchAndRenderResults(query, options = {}) {
            const { skipCache = false } = options;
            lastProcessedQuery = query;
            fetchingQuery = query;
            dropPendingRender();
            forgetCollections();
            resetSearchPagination();
            searchDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;
            const { title: apiQuery, year: yearFilter } = parseYearedQuery(query);

            // Cancel any still-in-flight search/collection requests from the
            // previous keystroke instead of letting them queue up.
            const signal = JE.requestManager?.getAbortSignal('jellyseerr-search') || null;
            searchSignal = signal;

            let data;
            try {
                data = await search(apiQuery, 1, { skipCache, signal });
            } catch (error) {
                if (error.name === 'AbortError') return; // superseded by a newer search
                throw error;
            } finally {
                // The hold below is registered synchronously, so nothing can slip in between.
                if (fetchingQuery === query) fetchingQuery = null;
            }
            if (lastProcessedQuery !== query) return; // superseded by a newer search while this was in flight

            // A prefix the viewer types past is never rendered, nor are its
            // next pages or collections fetched: the results wait for a pause.
            renderWhenQuiet(query, () => renderFirstPage(query, data, yearFilter));
        }

        /**
         * Renders a query's page-1 results, then starts its collection lookups
         * and infinite scroll.
         * @param {string} query The search query.
         * @param {Object} data The page-1 search response.
         * @param {string|null} yearFilter Release year from a "Title (YYYY)" query.
         */
        function renderFirstPage(query, data, yearFilter) {
            let results = filterResultsByYear(data.results || [], yearFilter);
            searchCurrentPage = data.page || 1;
            searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
            searchHasMore = searchCurrentPage < searchTotalPages;

            searchYield.fetched += results.length;
            if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
            results = filterLibraryItems(results);
            if (searchDeduplicator) results = searchDeduplicator.filter(results);
            searchYield.rendered += results.length;

            // Even an empty first page needs a section for the scroll engine:
            // parental/hidden-content filtering can remove every card while
            // later pages still contain results. Without a row, setup exits
            // before it can fetch those pages.
            if (results.length > 0 || searchHasMore) {
                renderJellyseerrResults(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
            }

            if (results.length > 0) {
                // Enrich with collections in the background once the query has
                // stood for COLLECTION_SETTLE_MS, then slot the collection cards
                // into the existing row. Later batches (infinite scroll) queue
                // behind this one.
                collectionsSettleAt = Date.now() + COLLECTION_SETTLE_MS;
                collectionQueue = Promise.resolve();
                enrichWithCollections(results, query);
            }

            // Start the engine whenever pages remain, even if this page rendered
            // nothing (everything filtered out): later pages may still have titles,
            // and the engine's empty-page valve decides when to stop. It fills the
            // row buffer immediately, so start it before the collection lookups
            // compete for request slots.
            if (searchHasMore) {
                setupSearchInfiniteScroll(query);
            }
        }

        /**
         * Loads the next page(s) of search results and appends cards to the
         * container. Several pages are fetched in parallel when the row buffer
         * deficit (or a low post-filter yield) calls for it, and the pages
         * after those are prefetched into the cache.
         * @param {string} query The current search query.
         * @param {{deficitPx?: number, horizontal?: boolean}} [hint] From the scroll engine.
         */
        async function loadMoreSearchResults(query, hint) {
            if (searchIsLoading || !searchHasMore || lastProcessedQuery !== query) return;

            // The global navigation abort cancels the query's signal. If the
            // search page is still visible with this very query (e.g. jellyfin-web
            // rewrote the URL's query param), re-arm a fresh signal for it;
            // otherwise the row is stale and must stop, not carry on unabortable.
            if (searchSuspended) return;
            const liveSignal = liveSearchSignal(query);
            if (liveSignal === false) {
                searchHasMore = false;
                return;
            }
            searchIsLoading = true;
            const signal = liveSignal || undefined;
            const firstPage = searchCurrentPage + 1;
            const { title: apiQuery, year: yearFilter } = parseYearedQuery(query);

            try {
                const itemsContainer = document.querySelector('.jellyseerr-section .itemsContainer');
                const wantCards = JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, 20) || 20;
                const yieldRatio = searchYield.fetched >= 20
                    ? Math.min(1, Math.max(0.1, searchYield.rendered / searchYield.fetched))
                    : 0.9;
                const remaining = Math.max(1, searchTotalPages - searchCurrentPage);
                const pageBudget = Number.isFinite(hint?.pageBudget) ? Math.max(1, hint.pageBudget) : Infinity;
                const count = Math.min(MAX_SEARCH_PAGES_PER_LOAD, remaining, pageBudget, Math.max(1, Math.ceil(wantCards / (20 * yieldRatio))));
                const pages = [];
                for (let p = firstPage; p < firstPage + count; p++) pages.push(p);

                const settled = await Promise.allSettled(pages.map(p => search(apiQuery, p, { signal, throwOnError: true })));
                if (lastProcessedQuery !== query) return; // query changed during fetch

                // Commit pages in order up to the first failure; a flaky page must
                // not discard the ones that arrived (they are re-fetched next load).
                let results = [];
                let committed = 0;
                let firstError = null;
                for (let i = 0; i < settled.length; i++) {
                    const s = settled[i];
                    if (s.status !== 'fulfilled') {
                        if (s.reason?.name === 'AbortError') throw s.reason;
                        firstError = s.reason;
                        break;
                    }
                    const data = s.value;
                    results.push(...(data.results || []));
                    searchCurrentPage = data.page || pages[i];
                    if (data.totalPages) searchTotalPages = Math.min(data.totalPages, TMDB_MAX_PAGE);
                    committed++;
                }
                if (firstError && committed === 0) throw firstError;
                searchHasMore = searchCurrentPage < searchTotalPages;

                results = filterResultsByYear(results, yearFilter);
                searchYield.fetched += results.length;
                if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
                results = filterLibraryItems(results);
                if (searchDeduplicator) results = searchDeduplicator.filter(results);
                searchYield.rendered += results.length;

                // Keep the cache warm for the next load while this one renders —
                // only once the viewer has actually started reading the row (a row
                // that is merely displayed costs no extra Seerr searches), and never
                // beyond the empty-page budget after a batch that rendered nothing.
                if (hint?.engaged) {
                    const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pages.length);
                    const prefetch = results.length > 0 ? count : Math.min(count, remainingBudget);
                    if (prefetch > 0) prefetchSearchPages(query, prefetch, signal);
                }

                if (results.length > 0 && itemsContainer) {
                    const createCard = item => createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
                    const slices = JE.discoveryFilter?.appendInSlices;
                    if (slices) {
                        // The cards in view go in at once; the rest of the batch
                        // (off to the right of the row) is built in short slices
                        // and goes in after them. The load resolves once every
                        // card is in; a new search or a rebuilt row drops the rest.
                        const rowId = collectionRowId;
                        await slices(itemsContainer, results, createCard, {
                            syncCount: JE.discoveryFilter.cardsInView(itemsContainer, { horizontal: true }),
                            isCurrent: () => rowId === collectionRowId && lastProcessedQuery === query && itemsContainer.isConnected
                        });
                    } else {
                        const fragment = document.createDocumentFragment();
                        results.forEach(item => fragment.appendChild(createCard(item)));
                        itemsContainer.appendChild(fragment);
                    }
                    // This batch's collection cards, one lookup for the batch.
                    enrichWithCollections(results, query);
                }
                return { pages: committed, rendered: itemsContainer ? results.length : 0 };
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.warn(`${logPrefix} Failed to load more search results:`, error);
                    // Roll back so the retry fetches the same pages
                    searchCurrentPage = firstPage - 1;
                    searchHasMore = true;
                }
                throw error; // Re-throw for seamlessScroll retry handling
            } finally {
                searchIsLoading = false;
            }
        }

        /**
         * Sets up the infinite scroll observer for search results.
         * @param {string} query The current search query.
         */
        function setupSearchInfiniteScroll(query) {
            if (!JE.seamlessScroll) return;

            JE.seamlessScroll.setupInfiniteScroll(
                searchScrollState,
                '.jellyseerr-section',
                (hint) => loadMoreSearchResults(query, hint),
                () => searchHasMore && !searchSuspended,
                () => searchIsLoading,
                { horizontal: true, trackSelector: '.itemsContainer', scrollerSelector: '.emby-scroller' }
            );
        }

        /**
         * Adds collection data and synthetic collection cards to a raw result set.
         * @param {Array} rawResults Raw search results from Seerr.
         * @returns {Promise<Array>} Enriched results including collections and badges.
         */
        async function prepareResultsWithCollections(rawResults, options = {}) {
            let results = rawResults || [];
            if (JE.pluginConfig.ShowCollectionsInSearch === false) {
                return results;
            }

            try {
                results = await JE.jellyseerrAPI.addCollections(results, options);
            } catch (e) {
                console.debug(`${logPrefix} Collection addition failed:`, e);
            }

            try {
                const collectionsMap = new Map();
                const collectionPositions = new Map();

                for (let i = 0; i < results.length; i++) {
                    const item = results[i];
                    if (item.mediaType === 'movie' && item.collection && item.collection.id) {
                        const key = String(item.collection.id);
                        if (!collectionsMap.has(key)) {
                            collectionsMap.set(key, {
                                id: item.collection.id,
                                mediaType: 'collection',
                                title: item.collection.name,
                                name: item.collection.name,
                                posterPath: item.collection.posterPath || null,
                                backdropPath: item.collection.backdropPath || null,
                                overview: `${item.collection.name} Collection`,
                                voteAverage: null,
                                releaseDate: null
                            });
                            collectionPositions.set(key, i);
                        }
                    }
                }

                if (collectionsMap.size > 0) {
                    const sortedCollections = Array.from(collectionPositions.entries())
                        .sort((a, b) => b[1] - a[1]);

                    for (const [collectionId, position] of sortedCollections) {
                        const collectionCard = collectionsMap.get(collectionId);
                        results.splice(position + 1, 0, collectionCard);
                    }
                }
            } catch (e) {
                console.debug(`${logPrefix} Failed injecting collections:`, e);
            }

            return results;
        }

        /**
         * Fetches fresh data and updates the existing UI elements.
         * @param {string} query The current search query.
         */
        // Manual refresh handler
        async function manualRefreshJellyseerrData(query) {
            const section = document.querySelector('.jellyseerr-section');
            const itemsContainer = section?.querySelector('.itemsContainer');
            if (!query || !itemsContainer) return;

            console.log(`${logPrefix} Refreshing data for query: "${query}"`);
            try {
                // The rebuilt row carries page 1's collections itself.
                forgetCollections();
                resetSearchPagination();
                searchDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

                const signal = JE.requestManager?.getAbortSignal('jellyseerr-search') || null;
                searchSignal = signal;
                const { title: apiQuery, year: yearFilter } = parseYearedQuery(query);
                const data = await search(apiQuery, 1, { signal, skipCache: true });
                let results = await prepareResultsWithCollections(filterResultsByYear(data.results || [], yearFilter), { signal });
                if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
                results = filterLibraryItems(results);

                searchCurrentPage = data.page || 1;
                searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
                searchHasMore = searchCurrentPage < searchTotalPages;
                if (searchDeduplicator) searchDeduplicator.filter(results);

                JE.jellyseerrUI?.releasePosters?.(itemsContainer);
                while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
                results.forEach(item => {
                    const card = createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
                    itemsContainer.appendChild(card);
                });
                updateJellyseerrResults(results, isJellyseerrActive, jellyseerrUserFound);

                if (searchHasMore) {
                    setupSearchInfiniteScroll(query);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.warn(`${logPrefix} Failed to refresh Seerr data:`, error);
                }
            }
        }

        /**
         * Sets up DOM observation for search page changes.
         */
        function initializePageObserver() {
            const handleSearch = () => {
                const searchInput = document.querySelector('#searchPage #searchTextInput');
                const isSearchPage = searchInput !== null;
                const currentQuery = isSearchPage ? searchInput.value : null;
                noteTyping();
                // The viewer typed past a query whose first page is still on
                // its way: abort it now instead of when the next search starts
                // (jellyfin-web 12 also aborts it by rewriting the URL; a search
                // page that doesn't rewrite it would otherwise let it finish).
                if (fetchingQuery !== null && fetchingQuery !== currentQuery) {
                    JE.requestManager?.abortRequest?.('jellyseerr-search');
                }

                if (isSearchPage && currentQuery?.trim()) {
                    clearTimeout(debounceTimeout);
                    debounceTimeout = setTimeout(() => {
                        if (!isJellyseerrActive) {
                            dropPendingRender();
                            forgetCollections();
                            clearInjectedSearchResults();
                            return;
                        }
                        const latestQuery = searchInput.value;
                        // Already processed and its row is on the page or on its
                        // way (held results render once the box is quiet). One
                        // whose search was aborted as the viewer typed past it,
                        // and which they then typed back to, is searched again.
                        // A row kept this way finishes the collection lookups
                        // it skipped while the box was off its query.
                        if (latestQuery === lastProcessedQuery && !isRowMissing(latestQuery)) {
                            resumeCollections();
                            return;
                        }

                        if (isJellyseerrOnlyMode) {
                            isJellyseerrOnlyMode = false;
                            hiddenSections = [];
                            jellyseerrOriginalPosition = null;
                            updateJellyseerrIcon(isJellyseerrActive, jellyseerrUserFound, false, toggleJellyseerrOnlyMode);
                        }
                        lastProcessedQuery = latestQuery;
                        resetSearchPagination();
                        clearInjectedSearchResults();
                        fetchAndRenderResults(latestQuery);
                    }, SEARCH_DEBOUNCE_MS);
                } else {
                    clearTimeout(debounceTimeout);
                    dropPendingRender();
                    forgetCollections();
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false;
                    resetSearchPagination();
                    clearInjectedSearchResults();
                }
            };

            /**
             * Attempts to attach the search input listener if the search page is visible.
             * Called by the MutationObserver, navigation events, and on initial setup.
             * Idempotent — sets data-jellyseerr-listener on the input to prevent
             * duplicate attachment, and adds a permanent 'input' event handler.
             */
            function tryAttachSearchListener() {
                updateJellyseerrIcon(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, toggleJellyseerrOnlyMode);

                const searchInput = document.querySelector('#searchPage #searchTextInput');
                if (searchInput && !searchInput.dataset.jellyseerrListener) {
                    console.debug(`${logPrefix} Search input found, attaching listener.`);
                    searchInput.addEventListener('input', handleSearch);
                    searchInput.dataset.jellyseerrListener = 'true';

                    // Add a click listener for the alphabet picker
                    const alphaPicker = document.querySelector('.alphaPicker');
                    if (alphaPicker) {
                        alphaPicker.addEventListener('click', () => {
                            // Use a short delay to ensure the input value has updated before we read it
                            setTimeout(handleSearch, 100);
                        });
                    }

                    // Also handle the case where the page loads with a query already in the box
                    handleSearch();
                }
            }

            /**
             * Called on every SPA navigation. If we've navigated away from the search
             * page entirely, tear down pagination/infinite-scroll state so stale
             * scroll listeners don't keep hitting the search endpoint from other pages.
             * Otherwise, (re)attach the search listener as usual.
             */
            function handleNavigate() {
                // Only a *visible* search page keeps the row alive; jellyfin-web may
                // keep the view in the DOM with .hide after navigating away.
                const searchInput = document.querySelector('#searchPage:not(.hide) #searchTextInput');
                if (!searchInput) {
                    clearTimeout(debounceTimeout);
                    dropPendingRender();
                    forgetCollections();
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false;
                    resetSearchPagination();
                    clearInjectedSearchResults();
                    return;
                }
                tryAttachSearchListener();
                // The row itself was removed (e.g. by a view re-render) while the
                // query is unchanged: no input event comes to rebuild it, so
                // rebuild it here. Not while the input handler's
                // own fetch for this query is still in flight or its results are
                // held for a pause — jellyfin-web rewrites the URL on each
                // keystroke, so this settle timer and the input debounce fire
                // together, and the row simply isn't rendered yet.
                if (isJellyseerrActive && searchInput.value.trim() && searchInput.value === lastProcessedQuery
                    && isRowMissing(searchInput.value)) {
                    resetSearchPagination();
                    fetchAndRenderResults(searchInput.value);
                    return;
                }
                // Still on the rendered query: collection lookups the
                // navigation's abort cut short pick up again.
                resumeCollections();
            }

            // Listen for manual refresh events from the UI
            document.addEventListener('jellyseerr-manual-refresh', function(e) {
                const searchInput = document.querySelector('#searchPage #searchTextInput');
                const query = searchInput ? searchInput.value : null;
                manualRefreshJellyseerrData(query);
            });

            JE.helpers.onBodyMutation('jellyseerr-search-listener', tryAttachSearchListener);

            // Immediately check if the search page is already rendered (handles the
            // case where the observer was set up after the search page loaded, e.g.
            // when the user navigates directly to /search before plugin init completes).
            tryAttachSearchListener();

            // Listen for SPA navigation events as a backup — MutationObserver may
            // miss the search page if no further DOM mutations occur after render.
            // Uses the shared je:navigate event (from helpers.js) which already
            // patches pushState/replaceState, plus popstate and hashchange.
            const onNav = () => {
                searchSuspended = true;
                // One timer for overlapping navigations: only the latest one settles.
                clearTimeout(navigateSettleTimer);
                navigateSettleTimer = setTimeout(() => {
                    searchSuspended = false;
                    handleNavigate();
                    // Still on the same search: resume filling where we paused.
                    if (searchScrollState.fill) searchScrollState.fill();
                }, 200);
            };
            if (JE.helpers?.onNavigate) {
                JE.helpers.onNavigate(onNav);
            } else {
                // Fallback if helpers.js hasn't loaded yet — may double-fire with
                // onNavigate if helpers loads later, but tryAttachSearchListener is
                // idempotent (guarded by dataset.jellyseerrListener) so this is safe.
                window.addEventListener('popstate', onNav);
                window.addEventListener('hashchange', onNav);
            }
        }

        /**
         * Waits for the user session to be available before initializing the main logic.
         */
        function waitForUserAndInitialize() {
            const startTime = Date.now();
            const timeout = 20000;

            const checkForUser = async () => {
                if (ApiClient.getCurrentUserId() && ApiClient.accessToken()) {
                    console.log(`${logPrefix} User session found. Initializing...`);
                    const status = await checkUserStatus();
                    isJellyseerrActive = status.active;
                    jellyseerrUserFound = status.userFound;
                    console.debug(`${logPrefix} Status: active=${isJellyseerrActive}, userFound=${jellyseerrUserFound}`);
                    initializePageObserver();

                    // Prefetch TMDB genres in the background for instant discovery
                    // (no request when this tab already keeps fresh copies in
                    // sessionStorage, e.g. after a reload)
                    if (isJellyseerrActive && JE.pluginConfig?.JellyseerrShowGenreDiscovery !== false) {
                        Promise.all([
                            JE.discoveryFilter?.fetchTmdbGenreList?.('tv', {})?.catch(() => {}),
                            JE.discoveryFilter?.fetchTmdbGenreList?.('movie', {})?.catch(() => {})
                        ]).catch(() => {});
                    }
                } else if (Date.now() - startTime > timeout) {
                    console.warn(`${logPrefix} Timed out waiting for user session. Features may be limited.`);
                    initializePageObserver();
                } else {
                    setTimeout(checkForUser, 300);
                }
            };
            checkForUser();
        }

        // ================================
        // MAIN INITIALIZATION & EVENT LISTENERS
        // ================================

        addMainStyles();
        addSeasonModalStyles();
        waitForUserAndInitialize();

        // Hide popover when touching outside request buttons or scrolling
        document.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.jellyseerr-request-button')) {
                toggleHoverPopoverLock(false);
                hideHoverPopover();
            }
        }, { passive: true });
        // Scrolling moves the button away from the fixed-position popover, so a
        // tap-locked popover must unlock too or it would float at stale coordinates.
        document.addEventListener('scroll', () => {
            toggleHoverPopoverLock(false);
            hideHoverPopover();
        }, true);

        // Remove touch overlay when touching outside cards
        document.body.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.jellyseerr-card')) {
                document.querySelectorAll('.jellyseerr-card.is-touch').forEach(card => card.classList.remove('is-touch'));
            }
        }, { passive: true });

        // Close 4K popup when clicking outside
        document.body.addEventListener('click', (e) => {
            if (!e.target.closest('.jellyseerr-button-group') && !e.target.closest('.jellyseerr-4k-popup')) {
                const popup = document.querySelector('.jellyseerr-4k-popup');
                if (popup) popup.remove();
            }
        });

        // Main click handler for request buttons and 4K popup items
        document.body.addEventListener('click', async function(event) {
            // Handle 4K popup item clicks
            if (event.target.closest('.jellyseerr-4k-popup-item')) {
                const item = event.target.closest('.jellyseerr-4k-popup-item');
                const action = item.dataset.action;
                const tmdbId = item.dataset.tmdbId;
                const mediaType = String(item.dataset.mediaType || 'movie').toLowerCase();

                if (action === 'request4k' && tmdbId) {
                    const popup = item.closest('.jellyseerr-4k-popup');
                    item.disabled = true;
                    item.innerHTML = `<span>Requesting...</span><span class="jellyseerr-button-spinner"></span>`;

                    // Find the original item data from the card
                    const card = event.target.closest('.jellyseerr-card');
                    const button = card?.querySelector('.jellyseerr-request-button');
                    const searchResultItem = button?.dataset.searchResultItem ? JSON.parse(button.dataset.searchResultItem) : null;
                    const titleText = card?.querySelector('.cardText-first bdi')?.textContent
                        || searchResultItem?.name
                        || searchResultItem?.title
                        || searchResultItem?.originalName
                        || searchResultItem?.originalTitle
                        || (mediaType === 'tv' ? 'this show' : 'this movie');

                    try {
                        if (mediaType === 'tv') {
                            if (popup) popup.remove();
                            showSeasonSelectionModal(tmdbId, 'tv', titleText, searchResultItem, true);
                            return;
                        }

                        if (JE.jellyseerrAPI.shouldShowAdvanced()) {
                            // Close popup and show advanced modal
                            if (popup) popup.remove();
                            showMovieRequestModal(tmdbId, titleText, searchResultItem, true);
                        } else {
                            const response = await requestMedia(tmdbId, 'movie', {}, true, searchResultItem); // true for 4K, pass searchResultItem for override rules
                            console.debug(`${logPrefix} Seerr 4K request response:`, response);
                            if (searchResultItem) {
                                if (!searchResultItem.mediaInfo) searchResultItem.mediaInfo = {};
                                searchResultItem.mediaInfo.status4k = 3;
                            }
                            JE.toast('4K request submitted successfully!', 3000);
                            if (popup) popup.remove();

                            // Refresh the results to update the UI
                            const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                            if (query) {
                                setTimeout(() => fetchAndRenderResults(query, { skipCache: true }), 1000);
                            }
                        }
                    } catch (error) {
                        // Quota errors get a themed dialog with usage + reset info.
                        if (JE.jellyseerrUI?.isQuotaError?.(error)) {
                            await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie');
                        } else {
                            let errorMessage = 'Failed to request 4K version';
                            if (error.status === 404) {
                                errorMessage = 'User not found';
                            } else if (error.responseJSON?.message) {
                                errorMessage = error.responseJSON.message;
                            }
                            // Escape API error before display to prevent reflected XSS
                            JE.toast(escapeHtml(errorMessage), 4000);
                        }
                        item.disabled = false;
                        item.innerHTML = `<span>Request in 4K</span>`;
                    }
                }
                return;
            }

            const button = event.target.closest('.jellyseerr-request-button');
            if (!button || button.disabled) return;

            const mediaType = button.dataset.mediaType;
            const tmdbId = button.dataset.tmdbId;
            const collectionId = button.dataset.collectionId;
            const searchResultItem = button.dataset.searchResultItem ? JSON.parse(button.dataset.searchResultItem) : null;
            const card = button.closest('.jellyseerr-card');
            const titleText = card?.querySelector('.cardText-first bdi')?.textContent
                || searchResultItem?.name
                || searchResultItem?.title
                || searchResultItem?.originalName
                || searchResultItem?.originalTitle
                || (mediaType === 'movie' ? 'this movie' : mediaType === 'collection' ? 'this collection' : 'this show');

            if (mediaType === 'collection' && collectionId) {
                showCollectionRequestModal(collectionId, titleText, searchResultItem);
                return;
            }

            if (mediaType === 'tv') {
                showSeasonSelectionModal(tmdbId, mediaType, titleText, searchResultItem);
                return;
            }

            if (mediaType === 'movie') {
                if (JE.jellyseerrAPI.shouldShowAdvanced()) {
                    showMovieRequestModal(tmdbId, titleText, searchResultItem);
                } else {
                    button.disabled = true;
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
                    try {
                        await requestMedia(tmdbId, mediaType, {}, false, searchResultItem); // Pass searchResultItem for override rules
                        button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${JE.jellyseerrUI.icons.requested}`;
                        button.classList.remove('jellyseerr-button-request');
                        button.classList.add('jellyseerr-button-pending');
                    } catch (error) {
                        button.disabled = false;
                        // Quota errors get a themed dialog; restore button to idle.
                        if (JE.jellyseerrUI?.isQuotaError?.(error)) {
                            await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie');
                            button.innerHTML = `${JE.jellyseerrUI.icons.request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
                            return;
                        }
                        let errorMessage;
                        if (error.status === 404) {
                            errorMessage = JE.t('jellyseerr_btn_user_not_found');
                        } else if (error.responseJSON?.message) {
                            errorMessage = error.responseJSON.message;
                        } else {
                            errorMessage = JE.t('jellyseerr_btn_error');
                        }
                        // Escape API error before innerHTML to prevent reflected XSS
                        button.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${JE.jellyseerrUI.icons.error}`;
                        button.classList.add('jellyseerr-button-error');
                    }
                }
            }
        });

        console.log(`${logPrefix} Initialization complete.`);
    };

})(window.JellyfinEnhanced);
