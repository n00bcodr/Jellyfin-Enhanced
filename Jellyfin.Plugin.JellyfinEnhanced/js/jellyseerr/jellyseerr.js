// /js/jellyseerr/jellyseerr.js
(function(JE) {
    'use strict';

    /**
     * Main initialization function for Jellyseerr search integration.
     * This function sets up the state, observers, and event listeners.
     */
    JE.initializeJellyseerrScript = function() {
        // Early exit if Jellyseerr is disabled in plugin settings
        if (!JE.pluginConfig.JellyseerrEnabled) {
            console.log('🪼 Jellyfin Enhanced: Jellyseerr Search: Integration is disabled in plugin settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr:';
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


        // Destructure modules for easy access
        const { checkUserStatus, search, requestMedia } = JE.jellyseerrAPI;
        const {
            addMainStyles, addSeasonModalStyles, updateJellyseerrIcon,
            renderJellyseerrResults, showMovieRequestModal, showSeasonSelectionModal,
            hideHoverPopover, toggleHoverPopoverLock, updateJellyseerrResults
        } = JE.jellyseerrUI;

        /**
         * Toggles between showing all search results vs only Jellyseerr results.
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
         * Fetches and renders search results.
         * @param {string} query The search query.
         */
        async function fetchAndRenderResults(query) {
            const data = await search(query);
            if (data.results && data.results.length > 0) {
                renderJellyseerrResults(data.results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
            }
        }

        /**
         * Fetches fresh data and updates the existing UI elements.
         * @param {string} query The current search query.
         */
        async function refreshJellyseerrData(query) {
            if (!query || !document.querySelector('.jellyseerr-section')) return;

            console.log(`${logPrefix} Refreshing data for query: "${query}"`);
            try {
                const data = await search(query);
                if (data.results) {
                    updateJellyseerrResults(data.results, isJellyseerrActive, jellyseerrUserFound);
                }
            } catch (error) {
                console.warn(`${logPrefix} Failed to refresh Jellyseerr data:`, error);
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
                    if (refreshInterval) clearInterval(refreshInterval);
                    refreshInterval = setInterval(() => refreshJellyseerrData(currentQuery), 15000); // Refresh every 15 seconds
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
                        document.querySelectorAll('.jellyseerr-section').forEach(el => el.remove());
                        fetchAndRenderResults(latestQuery);
                    }, 1000);
                } else {
                    clearTimeout(debounceTimeout);
                    if (refreshInterval) clearInterval(refreshInterval);
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false;
                    document.querySelectorAll('.jellyseerr-section').forEach(el => el.remove());
                }
            };

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

        // Main click handler for request buttons
        document.body.addEventListener('click', async function(event) {
            const button = event.target.closest('.jellyseerr-request-button');
            if (!button || button.disabled) return;

            const mediaType = button.dataset.mediaType;
            const tmdbId = button.dataset.tmdbId;
            const card = button.closest('.jellyseerr-card');
            const titleText = card?.querySelector('.cardText-first bdi')?.textContent || (mediaType === 'movie' ? 'this movie' : 'this show');
            const searchResultItem = button.dataset.searchResultItem ? JSON.parse(button.dataset.searchResultItem) : null;

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
                        await requestMedia(tmdbId, mediaType);
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
                        button.innerHTML = `<span>${errorMessage}</span>${JE.jellyseerrUI.icons.error}`;
                        button.classList.add('jellyseerr-button-error');
                    }
                }
            }
        });

        console.log(`${logPrefix} Initialization complete.`);
    };

})(window.JellyfinEnhanced);