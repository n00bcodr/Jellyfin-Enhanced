// /js/jellyseerr/item-details.js
// Adds Similar and Recommended sections to item details pages using Jellyseerr API.
// Also adds a "Request More" button next to the Seasons section heading on
// Series detail pages when the show has unrequested seasons in Seerr.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr Recommendations:';
    const requestMoreLogPrefix = '🪼 Jellyfin Enhanced: Series Request More:';

    // Track processed items to avoid duplicate renders
    const processedItems = new Set();
    const processedRequestMoreItems = new Set();

    // CSS class used to mark and dedupe the injected Request More button
    const REQUEST_MORE_BTN_CLASS = 'je-series-request-more-btn';

    // Current abort controllers for cancellation. Separate controllers prevent
    // the slower similar/recommended fetch from cancelling the Request More
    // check (and vice versa) when the user navigates between detail pages.
    let currentAbortController = null;
    let requestMoreAbortController = null;

    /**
     * Gets the TMDB ID from a Jellyfin item
     * @param {string} itemId - Jellyfin item ID
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<{tmdbId: number|null, type: string|null}>}
     */
    async function getTmdbIdFromItem(itemId, signal) {
        try {
            // Check for abort before making request
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const userId = ApiClient.getCurrentUserId();
            const item = JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId, { userId })
                : await ApiClient.getItem(userId, itemId);

            // Check for abort after request
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (!item) {
                console.warn(`${logPrefix} Item not found:`, itemId);
                return { tmdbId: null, type: null };
            }

            // Check if item is Movie or Series
            const itemType = item.Type;
            if (itemType !== 'Movie' && itemType !== 'Series') {
                return { tmdbId: null, type: null };
            }

            // Get TMDB ID from provider IDs
            const tmdbId = item.ProviderIds?.Tmdb;
            if (!tmdbId) {
                console.warn(`${logPrefix} No TMDB ID found for item:`, item.Name);
                return { tmdbId: null, type: null };
            }

            const type = itemType === 'Movie' ? 'movie' : 'tv';
            return { tmdbId: parseInt(tmdbId), type };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error(`${logPrefix} Error getting TMDB ID:`, error);
            return { tmdbId: null, type: null };
        }
    }

    /**
     * Wait for the detail page content to be ready
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForDetailPageReady(signal) {
        return new Promise((resolve) => {
            // Check for abort
            if (signal?.aborted) {
                resolve(null);
                return;
            }

            const checkPage = () => {
                const activePage = document.querySelector('.libraryPage:not(.hide)');
                if (!activePage) return null;

                const detailPageContent = activePage.querySelector('.detailPageContent');
                const moreLikeThisSection = detailPageContent?.querySelector('#similarCollapsible');

                if (detailPageContent && moreLikeThisSection) {
                    return { detailPageContent, moreLikeThisSection };
                }
                return null;
            };

            // Try immediately
            const immediate = checkPage();
            if (immediate) {
                resolve(immediate);
                return;
            }

            // Set up observer
            let observerHandle = null;
            let timeoutId = null;

            const cleanup = () => {
                if (observerHandle) {
                    observerHandle.unsubscribe();
                    observerHandle = null;
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };

            // Handle abort
            if (signal) {
                signal.addEventListener('abort', () => {
                    cleanup();
                    resolve(null);
                }, { once: true });
            }

            observerHandle = JE.helpers.onBodyMutation('jellyseerr-item-details-page-detect', () => {
                const result = checkPage();
                if (result) {
                    cleanup();
                    resolve(result);
                }
            });

            // Timeout fallback (3 seconds)
            timeoutId = setTimeout(() => {
                cleanup();
                const result = checkPage();
                resolve(result);
            }, 3000);
        });
    }

    /**
     * Creates a Jellyseerr section similar to search results
     * @param {Array} results - Array of Jellyseerr items
     * @param {string} title - Section title (already translated)
     * @returns {HTMLElement} - Section element
     */
    function createJellyseerrSection(results, title) {
        if (!results || results.length === 0) {
            return null;
        }

        // Filter out library items if configured
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        let filteredResults = results;

        if (excludeLibraryItems) {
            filteredResults = results.filter(item => !item.mediaInfo?.jellyfinMediaId);
        }
        if (JE.hiddenContent) {
            filteredResults = JE.hiddenContent.filterJellyseerrResults(filteredResults, 'recommendations');
        }

        if (filteredResults.length === 0) {
            return null;
        }

        const section = document.createElement('div');
        section.className = 'verticalSection emby-scroller-container jellyseerr-details-section';
        section.setAttribute('data-jellyseerr-section', 'true');

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-right';
        titleElement.textContent = title || 'Recommended';
        section.appendChild(titleElement);

        const scrollerContainer = document.createElement('div');
        scrollerContainer.setAttribute('is', 'emby-scroller');
        scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale no-padding emby-scroller';
        scrollerContainer.dataset.horizontal = "true";
        scrollerContainer.dataset.centerfocus = "card";
        scrollerContainer.dataset.scrollModeX = "custom";

        // Enable smooth native horizontal touch scrolling (from KefinTweaks)
        scrollerContainer.style.scrollSnapType = 'none';
        scrollerContainer.style.touchAction = 'auto';
        scrollerContainer.style.overscrollBehaviorX = 'contain';
        scrollerContainer.style.overscrollBehaviorY = 'auto';
        scrollerContainer.style.webkitOverflowScrolling = 'touch';

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider animatedScrollX';
        itemsContainer.style.whiteSpace = 'nowrap';

        // Use DocumentFragment for batch DOM insertion
        const fragment = document.createDocumentFragment();

        // Add items to container
        for (const item of filteredResults) {
            const card = JE.jellyseerrUI && JE.jellyseerrUI.createJellyseerrCard
                ? JE.jellyseerrUI.createJellyseerrCard(item, true, true)
                : null;
            if (card) {
                const titleLink = card.querySelector('.cardText-first a');

                // If item exists in library, link to library item
                const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
                if (jellyfinMediaId) {
                    card.setAttribute('data-library-item', 'true');
                    card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
                    card.classList.add('jellyseerr-card-in-library');
                    // Update title link to point to library item
                    if (titleLink) {
                        const itemName = item.title || item.name;
                        titleLink.textContent = itemName;
                        titleLink.title = itemName;
                        titleLink.href = `#!/details?id=${jellyfinMediaId}`;
                        titleLink.removeAttribute('target');
                        titleLink.removeAttribute('rel');
                    }
                }
                fragment.appendChild(card);
            }
        }

        itemsContainer.appendChild(fragment);
        scrollerContainer.appendChild(itemsContainer);
        section.appendChild(scrollerContainer);
        return section;
    }

    /**
     * Renders Similar and Recommended sections for an item
     * @param {string} itemId - Jellyfin item ID
     */
    async function renderSimilarAndRecommended(itemId) {
        // Prevent duplicate renders (check only - add after success)
        if (processedItems.has(itemId)) {
            return;
        }

        // Cancel any previous in-flight requests
        if (currentAbortController) {
            currentAbortController.abort();
        }
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;

        // Start metrics if enabled
        if (JE.requestManager?.metrics?.enabled) {
            JE.requestManager.startMeasurement('similar-recommended');
        }

        try {
            // Check configuration settings early
            const showSimilar = JE.pluginConfig?.JellyseerrShowSimilar === true;
            const showRecommended = JE.pluginConfig?.JellyseerrShowRecommended === true;

            if (!showSimilar && !showRecommended) {
                console.debug(`${logPrefix} Both similar and recommended sections are disabled in settings`);
                return;
            }

            // Check if Jellyseerr is active
            const status = await JE.jellyseerrAPI.checkUserStatus();
            if (signal.aborted) return;

            if (!status || !status.active) {
                console.debug(`${logPrefix} Jellyseerr is not active, skipping`);
                return;
            }

            // Get TMDB ID and type
            const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
            if (signal.aborted) return;

            if (!tmdbId || !type) {
                console.debug(`${logPrefix} No valid TMDB ID found for item, skipping`);
                return;
            }

            console.debug(`${logPrefix} Fetching similar and recommended content for TMDB ID ${tmdbId} (${type})`);

            // Fetch only the data that's enabled, passing signal for cancellation
            const fetchOptions = { signal };
            const promises = [];

            if (showSimilar) {
                promises.push(
                    type === 'movie'
                        ? JE.jellyseerrAPI.fetchSimilarMovies(tmdbId, fetchOptions)
                        : JE.jellyseerrAPI.fetchSimilarTvShows(tmdbId, fetchOptions)
                );
            } else {
                promises.push(Promise.resolve({ results: [] }));
            }

            if (showRecommended) {
                promises.push(
                    type === 'movie'
                        ? JE.jellyseerrAPI.fetchRecommendedMovies(tmdbId, fetchOptions)
                        : JE.jellyseerrAPI.fetchRecommendedTvShows(tmdbId, fetchOptions)
                );
            } else {
                promises.push(Promise.resolve({ results: [] }));
            }

            // Wait for page to be ready in parallel with data fetch
            const [similarData, recommendedData, pageReady] = await Promise.all([
                ...promises,
                waitForDetailPageReady(signal)
            ]);

            if (signal.aborted) return;

            const similarResults = similarData?.results || [];
            const recommendedResults = recommendedData?.results || [];

            if (similarResults.length === 0 && recommendedResults.length === 0) {
                console.debug(`${logPrefix} No similar or recommended content to display`);
                return;
            }

            // Check page readiness
            if (!pageReady) {
                console.warn(`${logPrefix} Page not ready for insertion`);
                return;
            }

            const { detailPageContent, moreLikeThisSection } = pageReady;

            // Filter items if configured to exclude library items or blocklisted items (status 6)
            const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
            const excludeBlocklistedItems = JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true;

            const filteredSimilarResults = similarResults.filter(item => {
                if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) return false;
                if (excludeBlocklistedItems && item.mediaInfo?.status === 6) return false; // Status 6 = Blocklisted
                return true;
            });

            const filteredRecommendedResults = recommendedResults.filter(item => {
                if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) return false;
                if (excludeBlocklistedItems && item.mediaInfo?.status === 6) return false; // Status 6 = Blocklisted
                return true;
            });

            if (filteredSimilarResults.length === 0 && filteredRecommendedResults.length === 0) {
                console.debug(`${logPrefix} No content to display after filtering library items`);
                return;
            }

            // Final abort check before DOM manipulation
            if (signal.aborted) return;

            // Remove any existing Jellyseerr sections to avoid duplicates
            detailPageContent.querySelectorAll('.jellyseerr-details-section').forEach(el => el.remove());

            // Create and insert sections
            if (filteredRecommendedResults.length > 0) {
                const recommendedTitle = JE.t ? (JE.t('jellyseerr_recommended_title') || 'Recommended') : 'Recommended';
                const recommendedSection = createJellyseerrSection(
                    filteredRecommendedResults.slice(0, 20),
                    recommendedTitle
                );
                if (recommendedSection) {
                    moreLikeThisSection.after(recommendedSection);
                    console.debug(`${logPrefix} Added Recommended section with ${filteredRecommendedResults.length} items`);
                }
            }

            if (filteredSimilarResults.length > 0) {
                const similarTitle = JE.t ? (JE.t('jellyseerr_similar_title') || 'Similar') : 'Similar';
                const similarSection = createJellyseerrSection(
                    filteredSimilarResults.slice(0, 20),
                    similarTitle
                );
                if (similarSection) {
                    const lastJellyseerrSection = detailPageContent.querySelector('.jellyseerr-details-section:last-of-type');
                    if (lastJellyseerrSection) {
                        lastJellyseerrSection.after(similarSection);
                    } else {
                        moreLikeThisSection.after(similarSection);
                    }
                    console.debug(`${logPrefix} Added Similar section with ${filteredSimilarResults.length} items`);
                }
            }

            // Mark as successfully processed AFTER successful render
            processedItems.add(itemId);

            // End metrics
            if (JE.requestManager?.metrics?.enabled) {
                JE.requestManager.endMeasurement('similar-recommended');
            }

        } catch (error) {
            // Silently ignore abort errors (don't mark as processed so retry is possible)
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted for item ${itemId}`);
                return;
            }
            console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
        }
    }

    /**
     * Waits for the Seasons section heading on a Series detail page to become
     * visible. On a Series page Jellyfin renders the seasons list inside
     * #listChildrenCollapsible (NOT #childrenCollapsible — that variant is
     * used for non-Series item types and stays hidden). The heading inside
     * is an h2.sectionTitle.sectionTitle-cards with a child <span> whose
     * text reads "Series" once Jellyfin has populated it.
     * Returns the h2 element when ready, or null on abort/timeout.
     * @param {AbortSignal} [signal]
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForSeasonsHeading(signal) {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(null);
                return;
            }

            const findHeading = () => {
                const activePage = document.querySelector('.libraryPage:not(.hide)');
                if (!activePage) return null;
                const collapsible = activePage.querySelector('#listChildrenCollapsible');
                if (!collapsible || collapsible.classList.contains('hide')) {
                    return null;
                }
                const heading = collapsible.querySelector('h2.sectionTitle.sectionTitle-cards');
                if (!heading || heading.classList.contains('hide')) {
                    return null;
                }
                // Wait until Jellyfin has populated the title span (initially empty)
                const span = heading.querySelector('span');
                if (!span || !span.textContent.trim()) {
                    return null;
                }
                return heading;
            };

            const immediate = findHeading();
            if (immediate) {
                resolve(immediate);
                return;
            }

            let observerHandle = null;
            let timeoutId = null;
            const cleanup = () => {
                if (observerHandle) {
                    observerHandle.unsubscribe();
                    observerHandle = null;
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };

            if (signal) {
                signal.addEventListener('abort', () => {
                    cleanup();
                    resolve(null);
                }, { once: true });
            }

            observerHandle = JE.helpers.onBodyMutation('jellyseerr-request-more-heading-detect', () => {
                const heading = findHeading();
                if (heading) {
                    cleanup();
                    resolve(heading);
                }
            });

            // Timeout fallback. Jellyfin usually populates the heading within
            // a few hundred ms; allow up to 5s for slow connections.
            timeoutId = setTimeout(() => {
                cleanup();
                resolve(findHeading());
            }, 5000);
        });
    }

    /**
     * Builds the Request More button DOM. Reuses the .jellyseerr-request-button
     * styling already injected by ui.js so visuals match the rest of Seerr UI.
     * Uses textContent / DOM construction (no innerHTML) for safety.
     * @param {object} tvDetails - TV show details from Seerr
     * @returns {HTMLButtonElement}
     */
    function buildSeriesRequestMoreButton(tvDetails) {
        // Defensive: i18n table may not be initialized yet on first navigation;
        // match the fallback pattern used elsewhere in this file.
        const labelText = (JE.t && JE.t('jellyseerr_btn_request_more')) || 'Request More';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `jellyseerr-request-button jellyseerr-button-request ${REQUEST_MORE_BTN_CLASS}`;
        button.title = labelText;
        // Inline overrides so the button sits comfortably next to the h2 text
        // without inheriting the heading's font size or block layout.
        button.style.display = 'inline-flex';
        button.style.alignItems = 'center';
        button.style.verticalAlign = 'middle';
        button.style.fontSize = '0.85rem';
        button.style.padding = '0.4em 0.9em';
        button.style.marginLeft = '1em';

        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'download';
        icon.style.marginRight = '0.4em';
        icon.style.fontSize = '1.1em';

        const labelSpan = document.createElement('span');
        labelSpan.textContent = labelText;

        button.appendChild(icon);
        button.appendChild(labelSpan);

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (JE.jellyseerrUI?.showSeasonSelectionModal) {
                JE.jellyseerrUI.showSeasonSelectionModal(
                    tvDetails.id,
                    'tv',
                    tvDetails.name || tvDetails.title,
                    tvDetails
                );
            }
        });

        return button;
    }

    /**
     * Renders a "Request More" button next to the Seasons section heading on
     * a Series detail page when the show has unrequested seasons in Seerr.
     * Reuses checkForUnrequestedSeasons from more-info-modal.js so the
     * detection logic stays in one place.
     * @param {string} itemId - Jellyfin item ID
     */
    async function renderSeriesRequestMoreButton(itemId) {
        if (processedRequestMoreItems.has(itemId)) return;

        // Cancel any in-flight Request More check from a previous navigation.
        if (requestMoreAbortController) {
            requestMoreAbortController.abort();
        }
        requestMoreAbortController = new AbortController();
        const signal = requestMoreAbortController.signal;

        try {
            if (!JE.pluginConfig?.JellyseerrEnabled) return;
            if (JE.pluginConfig?.JellyseerrShowRequestMoreOnSeries === false) return;

            const status = await JE.jellyseerrAPI.checkUserStatus();
            if (signal.aborted) return;
            if (!status?.active) return;

            const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
            if (signal.aborted) return;
            if (!tmdbId || type !== 'tv') return;

            const tvDetails = await JE.jellyseerrAPI.fetchTvShowDetails(tmdbId);
            if (signal.aborted) return;
            if (!tvDetails) return;

            const checker = JE.jellyseerrMoreInfo?.checkForUnrequestedSeasons;
            if (typeof checker !== 'function') {
                console.warn(`${requestMoreLogPrefix} checkForUnrequestedSeasons unavailable, skipping`);
                return;
            }
            const hasUnrequested = await checker(tvDetails);
            if (signal.aborted) return;
            if (!hasUnrequested) {
                // Dedupe negative results too. Each call to checker() runs an
                // HTTP request to /JellyfinEnhanced/jellyseerr/request, so we
                // don't want to repeat it on every viewshow for the same item.
                // cleanup() clears this set on real navigation.
                processedRequestMoreItems.add(itemId);
                console.debug(`${requestMoreLogPrefix} No unrequested seasons for "${tvDetails.name || tvDetails.title}"`);
                return;
            }

            const heading = await waitForSeasonsHeading(signal);
            if (signal.aborted) return;
            if (!heading) {
                console.debug(`${requestMoreLogPrefix} Seasons heading not found, skipping`);
                return;
            }

            // Dedup: bail if we already injected a button into this heading.
            if (heading.querySelector(`.${REQUEST_MORE_BTN_CLASS}`)) {
                processedRequestMoreItems.add(itemId);
                return;
            }

            // Lay the button out inline next to the heading text via a class
            // (instead of mutating heading.style directly) so the override is
            // discoverable in CSS, easy to remove, and doesn't permanently
            // overwrite Jellyfin's inline display value on the heading.
            heading.classList.add('je-series-request-more-heading');

            const button = buildSeriesRequestMoreButton(tvDetails);
            heading.appendChild(button);

            processedRequestMoreItems.add(itemId);
            console.debug(`${requestMoreLogPrefix} Added Request More button for "${tvDetails.name || tvDetails.title}"`);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.debug(`${requestMoreLogPrefix} Aborted for item ${itemId}`);
                return;
            }
            console.error(`${requestMoreLogPrefix} Error rendering button:`, error);
        }
    }

    /**
     * Handles item details page navigation
     */
    function handleItemDetailsPage() {
        // Get item ID from URL
        const hash = window.location.hash;
        if (!hash.includes('/details?id=')) {
            return;
        }

        try {
            const itemId = new URLSearchParams(hash.split('?')[1]).get('id');
            if (itemId) {
                // Use requestAnimationFrame instead of fixed timeout
                // This ensures we're in sync with the rendering cycle
                requestAnimationFrame(() => {
                    renderSimilarAndRecommended(itemId);
                    renderSeriesRequestMoreButton(itemId);
                });
            }
        } catch (error) {
            console.error(`${logPrefix} Error parsing item ID from URL:`, error);
        }
    }

    /**
     * Cleanup function for navigation
     */
    function cleanup() {
        // Abort any in-flight requests
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        if (requestMoreAbortController) {
            requestMoreAbortController.abort();
            requestMoreAbortController = null;
        }
        // Clear processed items caches
        processedItems.clear();
        processedRequestMoreItems.clear();
    }

    /**
     * Injects the CSS used by the Series "Request More" button. Kept tiny so
     * it can live alongside the JS module instead of needing a separate file.
     */
    function injectRequestMoreStyles() {
        if (document.getElementById('je-series-request-more-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-series-request-more-styles';
        style.textContent = `
            h2.sectionTitle.sectionTitle-cards.je-series-request-more-heading {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Initializes the item details handler
     */
    function initialize() {
        console.debug(`${logPrefix} Initializing Recommendations and Similar sections`);
        injectRequestMoreStyles();

        // Listen for hash changes (navigation)
        window.addEventListener('hashchange', () => {
            cleanup();
            handleItemDetailsPage();
        });

        // Check current page on load
        handleItemDetailsPage();

        // Also listen for viewshow events (Jellyfin's custom event)
        document.addEventListener('viewshow', () => {
            handleItemDetailsPage();
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(window.JellyfinEnhanced);
