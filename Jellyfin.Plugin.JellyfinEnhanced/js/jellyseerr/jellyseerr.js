// /js/jellyseerr/jellyseerr.js
(function(JE) {
    'use strict';

    /**
     * Main initialization function for Seerr search integration.
     * This function sets up the state, observers, and event listeners.
     */
    JE.initializeJellyseerrScript = function() {
        // Early exit if Seerr is disabled in plugin settings
        if (!JE.pluginConfig.JellyseerrEnabled) {
            console.log('🪼 Jellyfin Enhanced: Seerr Search: Integration is disabled in plugin settings.');
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
        let refreshInterval = null;

        // Infinite scroll pagination state
        let searchCurrentPage = 0;
        let searchTotalPages = 0;
        let searchIsLoading = false;
        let searchHasMore = false;
        const searchScrollState = {};
        let searchDeduplicator = null;


        // Destructure modules for easy access
        const { checkUserStatus, search, requestMedia } = JE.jellyseerrAPI;
        const {
            addMainStyles, addSeasonModalStyles, updateJellyseerrIcon,
            renderJellyseerrResults, showMovieRequestModal, showSeasonSelectionModal,
            showCollectionRequestModal, hideHoverPopover, toggleHoverPopoverLock, updateJellyseerrResults,
            createJellyseerrCard
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
                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                if (noResultsMessage) noResultsMessage.classList.add('section-hidden');

                JE.toast(JE.t('jellyseerr_toast_filter_on'), 3000);

            } else {
                hiddenSections.forEach(section => section.classList.remove('section-hidden'));
                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection && jellyseerrOriginalPosition?.parentNode) {
                    jellyseerrOriginalPosition.parentNode.insertBefore(jellyseerrSection, jellyseerrOriginalPosition);
                    jellyseerrOriginalPosition.remove();
                    jellyseerrOriginalPosition = null;
                }
                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                if (noResultsMessage) noResultsMessage.classList.remove('section-hidden');

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
            if (searchDeduplicator) searchDeduplicator.clear();
            JE.seamlessScroll?.cleanupInfiniteScroll(searchScrollState);
        }

        /**
         * Fetches and renders search results (page 1), then sets up infinite scroll.
         * @param {string} query The search query.
         */
        async function fetchAndRenderResults(query) {
            resetSearchPagination();
            searchDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

            const data = await search(query, 1);
            let results = data.results || [];
            searchCurrentPage = data.page || 1;
            searchTotalPages = data.totalPages || 1;
            searchHasMore = searchCurrentPage < searchTotalPages;

            if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
            if (searchDeduplicator) searchDeduplicator.filter(results);

            if (results.length > 0) {
                renderJellyseerrResults(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);

                // Enrich with collections in the background, then re-render
                prepareResultsWithCollections(results).then(enrichedResults => {
                    if (lastProcessedQuery !== query) return;
                    if (JE.hiddenContent) enrichedResults = JE.hiddenContent.filterJellyseerrResults(enrichedResults, 'search');
                    if (enrichedResults.length > results.length) {
                        renderJellyseerrResults(enrichedResults, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
                    }
                }).catch(() => {});

                // Set up infinite scroll if more pages exist
                if (searchHasMore) {
                    setupSearchInfiniteScroll(query);
                }
            }
        }

        /**
         * Loads the next page of search results and appends cards to the container.
         * @param {string} query The current search query.
         */
        async function loadMoreSearchResults(query) {
            if (searchIsLoading || !searchHasMore || lastProcessedQuery !== query) return;

            searchIsLoading = true;
            const nextPage = searchCurrentPage + 1;

            try {
                const data = await search(query, nextPage);
                if (lastProcessedQuery !== query) return; // query changed during fetch

                let results = data.results || [];
                searchCurrentPage = data.page || nextPage;
                searchTotalPages = data.totalPages || searchTotalPages;
                searchHasMore = searchCurrentPage < searchTotalPages;

                if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
                if (searchDeduplicator) results = searchDeduplicator.filter(results);

                if (results.length > 0) {
                    const itemsContainer = document.querySelector('.jellyseerr-section .itemsContainer');
                    if (itemsContainer) {
                        const fragment = document.createDocumentFragment();
                        results.forEach(item => {
                            const card = createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
                            fragment.appendChild(card);
                        });
                        itemsContainer.appendChild(fragment);
                    }
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.warn(`${logPrefix} Failed to load more search results:`, error);
                    // Roll back page on failure
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
                () => loadMoreSearchResults(query),
                () => searchHasMore,
                () => searchIsLoading
            );
        }

        /**
         * Adds collection data and synthetic collection cards to a raw result set.
         * @param {Array} rawResults Raw search results from Seerr.
         * @returns {Promise<Array>} Enriched results including collections and badges.
         */
        async function prepareResultsWithCollections(rawResults) {
            let results = rawResults || [];
            if (JE.pluginConfig.ShowCollectionsInSearch === false) {
                return results;
            }

            try {
                results = await JE.jellyseerrAPI.addCollections(results);
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

                const data = await search(query, 1);
                let results = await prepareResultsWithCollections(data.results || []);
                if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');

                searchCurrentPage = data.page || 1;
                searchTotalPages = data.totalPages || 1;
                searchHasMore = searchCurrentPage < searchTotalPages;
                if (searchDeduplicator) searchDeduplicator.filter(results);

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
                console.warn(`${logPrefix} Failed to refresh Seerr data:`, error);
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
                            document.querySelectorAll('.jellyseerr-section').forEach(el => el.remove());
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
                        document.querySelectorAll('.jellyseerr-section').forEach(el => el.remove());
                        fetchAndRenderResults(latestQuery);
                    }, 300);
                } else {
                    clearTimeout(debounceTimeout);
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false;
                    resetSearchPagination();
                    document.querySelectorAll('.jellyseerr-section').forEach(el => el.remove());
                }
            };

            // Listen for manual refresh events from the UI
            document.addEventListener('jellyseerr-manual-refresh', function(e) {
                const searchInput = document.querySelector('#searchPage #searchTextInput');
                const query = searchInput ? searchInput.value : null;
                manualRefreshJellyseerrData(query);
            });

            const observer = new MutationObserver(() => {
                updateJellyseerrIcon(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, toggleJellyseerrOnlyMode);

                const searchInput = document.querySelector('#searchPage #searchTextInput');
                if (searchInput && !searchInput.dataset.jellyseerrListener) {
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
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }

        /**
         * Waits for the user session to be available before initializing the main logic.
         */
        function waitForUserAndInitialize() {
            const startTime = Date.now();
            const timeout = 20000;

            const checkForUser = async () => {
                if (ApiClient.getCurrentUserId()) {
                    console.log(`${logPrefix} User session found. Initializing...`);
                    const status = await checkUserStatus();
                    isJellyseerrActive = status.active;
                    jellyseerrUserFound = status.userFound;
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
        document.addEventListener('scroll', () => hideHoverPopover(), true);

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

                if (action === 'request4k' && tmdbId) {
                    const popup = item.closest('.jellyseerr-4k-popup');
                    item.disabled = true;
                    item.innerHTML = `<span>Requesting...</span><span class="jellyseerr-button-spinner"></span>`;

                    // Find the original item data from the card
                    const card = event.target.closest('.jellyseerr-card');
                    const titleText = card?.querySelector('.cardText-first bdi')?.textContent || 'this movie';
                    const button = card?.querySelector('.jellyseerr-request-button');
                    const searchResultItem = button?.dataset.searchResultItem ? JSON.parse(button.dataset.searchResultItem) : null;

                    try {
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
                                setTimeout(() => fetchAndRenderResults(query), 1000);
                            }
                        }
                    } catch (error) {
                        let errorMessage = 'Failed to request 4K version';
                        if (error.status === 404) {
                            errorMessage = 'User not found';
                        } else if (error.responseJSON?.message) {
                            errorMessage = error.responseJSON.message;
                        }
                        // Escape API error before display to prevent reflected XSS
                        JE.toast(escapeHtml(errorMessage), 4000);
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
            const card = button.closest('.jellyseerr-card');
            const titleText = card?.querySelector('.cardText-first bdi')?.textContent || (mediaType === 'movie' ? 'this movie' : mediaType === 'collection' ? 'this collection' : 'this show');
            const searchResultItem = button.dataset.searchResultItem ? JSON.parse(button.dataset.searchResultItem) : null;

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
                        let errorMessage = JE.t('jellyseerr_btn_error');
                        if (error.status === 404) {
                            errorMessage = JE.t('jellyseerr_btn_user_not_found');
                        } else if (error.responseJSON?.message) {
                            errorMessage = error.responseJSON.message;
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
