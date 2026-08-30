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

        let lastProcessedQuery = null;
        let searchGeneration = 0;
        let debounceTimeout = null;
        let isJellyseerrActive = false;
        let jellyseerrUserFound = false;

        const { checkUserStatus, search, requestMedia } = JE.jellyseerrAPI;
        const {
            addMainStyles, addSeasonModalStyles, updateJellyseerrIcon,
            renderJellyseerrResults, showMovieRequestModal, showSeasonSelectionModal,
            showCollectionRequestModal, hideHoverPopover, toggleHoverPopoverLock, updateJellyseerrResults
        } = JE.jellyseerrUI;

        function closeJellyseerrSearch() {
            const host = document.getElementById('jellyseerr-search-host');
            if (host) { host.classList.remove('is-open'); host.replaceChildren(); }
            JE.jellyseerrUI.clearJellyseerrSearchSpace?.();
            lastProcessedQuery = null;
        }

        async function fetchAndRenderResults(query, options = {}) {
            const normalized = String(query || '').trim();
            const generation = options.generation ?? ++searchGeneration;
            if (!normalized) {
                closeJellyseerrSearch();
                return;
            }
            const { skipCache = false } = options;
            // Cancel any still-in-flight search/collection requests from the
            // previous keystroke instead of letting them queue up.
            const signal = JE.requestManager?.getAbortSignal('jellyseerr-search');

            let data;
            try {
                if (options.generation == null) lastProcessedQuery = normalized;
                data = await search(normalized, 1, { skipCache, signal });
            } catch (error) {
                if (error.name === 'AbortError') return; // superseded by a newer search
                throw error;
            }
            if (generation !== searchGeneration || lastProcessedQuery !== normalized) return;
            let results = await prepareResultsWithCollections(data.results || [], { signal });
            if (generation !== searchGeneration) return;
            if (JE.hiddenContent) results = JE.hiddenContent.filterJellyseerrResults(results, 'search');
            if (generation !== searchGeneration) return;
            renderJellyseerrResults(results, normalized, true, isJellyseerrActive, jellyseerrUserFound);
        }

        function bindNativeSearchInput() {
            const jellyfinInput = document.querySelector('#searchTextInput');
            if (!jellyfinInput) return;
            JE.jellyseerrUI.ensureJellyseerrSearchSpace?.();
            if (jellyfinInput.dataset.jellyseerrBound === 'true') return;
            jellyfinInput.dataset.jellyseerrBound = 'true';
            jellyfinInput.addEventListener('input', () => {
                const query = jellyfinInput.value;
                const normalized = query.trim();
                const generation = ++searchGeneration;
                lastProcessedQuery = normalized || null;
                clearTimeout(debounceTimeout);
                if (!normalized) {
                    closeJellyseerrSearch();
                    return;
                }
                debounceTimeout = setTimeout(() => fetchAndRenderResults(query, { generation }), 300);
            });
            if (jellyfinInput.value.trim()) fetchAndRenderResults(jellyfinInput.value);
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

        function initializePageObserver() {
            const ensureNativeBinding = () => bindNativeSearchInput();
            JE.helpers.onBodyMutation('jellyseerr-native-search', ensureNativeBinding);
            ensureNativeBinding();
            document.addEventListener('jellyseerr-manual-refresh', () => {
                clearTimeout(debounceTimeout);
                debounceTimeout = null;
                const query = document.querySelector('#searchTextInput')?.value;
                if (query) fetchAndRenderResults(query, { skipCache: true });
            });
            if (JE.helpers?.onNavigate) {
                JE.helpers.onNavigate(() => {
                    clearTimeout(debounceTimeout);
                    debounceTimeout = null;
                    searchGeneration++;
                    closeJellyseerrSearch();
                    setTimeout(ensureNativeBinding, 200);
                });
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
