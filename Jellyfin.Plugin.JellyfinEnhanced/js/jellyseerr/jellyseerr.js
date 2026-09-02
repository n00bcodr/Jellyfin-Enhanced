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
         * Warms the request cache with the next `count` result pages so the
         * following load-more is served instantly. Fire-and-forget.
         * @param {string} query
         * @param {number} count
         * @param {AbortSignal|null} signal
         */
        function prefetchSearchPages(query, count, signal) {
            if (!searchHasMore || signal?.aborted || JE.pluginConfig?.JellyseerrSeamlessScrollPrefetch === false) return;
            const last = Math.min(searchTotalPages, searchCurrentPage + Math.max(1, count));
            for (let p = searchCurrentPage + 1; p <= last; p++) {
                search(query, p, { signal }).catch(() => {});
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
         * Fetches and renders search results (page 1), then sets up infinite scroll.
         * @param {string} query The search query.
         */
        async function fetchAndRenderResults(query, options = {}) {
            const { skipCache = false } = options;
            lastProcessedQuery = query;
            resetSearchPagination();
            searchDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

            // Cancel any still-in-flight search/collection requests from the
            // previous keystroke instead of letting them queue up.
            const signal = JE.requestManager?.getAbortSignal('jellyseerr-search') || null;
            searchSignal = signal;

            let data;
            try {
                data = await search(query, 1, { skipCache, signal });
            } catch (error) {
                if (error.name === 'AbortError') return; // superseded by a newer search
                throw error;
            }
            if (lastProcessedQuery !== query) return; // superseded by a newer search while this was in flight

            let results = data.results || [];
            searchCurrentPage = data.page || 1;
            searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
            searchHasMore = searchCurrentPage < searchTotalPages;

            searchYield.fetched += results.length;
            if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
            if (searchDeduplicator) searchDeduplicator.filter(results);
            searchYield.rendered += results.length;

            if (results.length > 0) {
                renderJellyseerrResults(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);

                // Set up infinite scroll if more pages exist (it fills the row
                // buffer immediately, so start it before the collection lookups
                // compete for request slots).
                if (searchHasMore) {
                    setupSearchInfiniteScroll(query);
                }

                // Enrich with collections in the background, then slot the
                // collection cards into the existing row.
                prepareResultsWithCollections(results, { signal }).then(enrichedResults => {
                    if (lastProcessedQuery !== query) return;
                    if (JE.hiddenContent) enrichedResults = JE.hiddenContent.filterJellyseerrResults(enrichedResults, 'search');
                    if (enrichedResults.length > results.length) {
                        insertCollectionCards(enrichedResults);
                    }
                }).catch(() => {});
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
            if (searchSignal?.aborted) {
                const visibleInput = document.querySelector('#searchPage:not(.hide) #searchTextInput');
                if (!visibleInput || visibleInput.value !== query) {
                    searchHasMore = false;
                    return;
                }
                searchSignal = JE.requestManager?.getAbortSignal('jellyseerr-search') || null;
            }
            searchIsLoading = true;
            const signal = searchSignal || undefined;
            const firstPage = searchCurrentPage + 1;

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

                const responses = await Promise.all(pages.map(p => search(query, p, { signal, throwOnError: true })));
                if (lastProcessedQuery !== query) return; // query changed during fetch

                let results = [];
                responses.forEach((data, i) => {
                    results.push(...(data.results || []));
                    searchCurrentPage = data.page || pages[i];
                    if (data.totalPages) searchTotalPages = Math.min(data.totalPages, TMDB_MAX_PAGE);
                });
                searchHasMore = searchCurrentPage < searchTotalPages;

                searchYield.fetched += results.length;
                if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
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
                    const fragment = document.createDocumentFragment();
                    results.forEach(item => {
                        const card = createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
                        fragment.appendChild(card);
                    });
                    itemsContainer.appendChild(fragment);
                }
                return { pages: pages.length, rendered: results.length };
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
                resetSearchPagination();
                searchDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

                const signal = JE.requestManager?.getAbortSignal('jellyseerr-search') || null;
                searchSignal = signal;
                const data = await search(query, 1, { signal, skipCache: true });
                let results = await prepareResultsWithCollections(data.results || [], { signal });
                if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');

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

                if (isSearchPage && currentQuery?.trim()) {
                    clearTimeout(debounceTimeout);
                    debounceTimeout = setTimeout(() => {
                        if (!isJellyseerrActive) {
                            clearInjectedSearchResults();
                            return;
                        }
                        const latestQuery = searchInput.value;
                        if (latestQuery === lastProcessedQuery) return;

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
                    }, 200);
                } else {
                    clearTimeout(debounceTimeout);
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
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false;
                    resetSearchPagination();
                    clearInjectedSearchResults();
                    return;
                }
                tryAttachSearchListener();
                // The row itself was removed (e.g. by a view re-render) while the
                // query is unchanged: handleSearch would skip it as already
                // processed, so rebuild it here.
                if (isJellyseerrActive && searchInput.value.trim() && searchInput.value === lastProcessedQuery
                    && !document.querySelector('.jellyseerr-section')) {
                    resetSearchPagination();
                    fetchAndRenderResults(searchInput.value);
                }
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
                    if (isJellyseerrActive && JE.pluginConfig?.JellyseerrShowGenreDiscovery !== false) {
                        Promise.all([
                            JE.discoveryFilter?.fetchWithManagedRequest?.('/JellyfinEnhanced/tmdb/genres/tv', 'genre', {})?.catch(() => {}),
                            JE.discoveryFilter?.fetchWithManagedRequest?.('/JellyfinEnhanced/tmdb/genres/movie', 'genre', {})?.catch(() => {})
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

                        if (JE.pluginConfig.JellyseerrShowAdvanced) {
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
                if (JE.pluginConfig.JellyseerrShowAdvanced) {
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
