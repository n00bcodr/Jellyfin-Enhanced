// /js/jellyseerr/item-details.js
// Adds Similar and Recommended sections to item details pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr Recommendations:';

    // Track processed items to avoid duplicate renders
    const processedItems = new Set();

    /**
     * Gets the TMDB ID from a Jellyfin item
     * @param {string} itemId - Jellyfin item ID
     * @returns {Promise<{tmdbId: number|null, type: string|null}>}
     */
    async function getTmdbIdFromItem(itemId) {
        try {
            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.getItem(userId, itemId);

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
            console.error(`${logPrefix} Error getting TMDB ID:`, error);
            return { tmdbId: null, type: null };
        }
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

        // Add items to container
        results.forEach(item => {
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
                itemsContainer.appendChild(card);
            }
        });

        scrollerContainer.appendChild(itemsContainer);
        section.appendChild(scrollerContainer);
        return section;
    }



    /**
     * Renders Similar and Recommended sections for an item
     * @param {string} itemId - Jellyfin item ID
     */
    async function renderSimilarAndRecommended(itemId) {
        // Prevent duplicate renders
        if (processedItems.has(itemId)) {
            // console.debug(`${logPrefix} Item already processed:`, itemId);
            return;
        }

        processedItems.add(itemId);

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
            if (!status || !status.active) {
                console.debug(`${logPrefix} Jellyseerr is not active, skipping`);
                return;
            }

            // Get TMDB ID and type
            const { tmdbId, type } = await getTmdbIdFromItem(itemId);
            if (!tmdbId || !type) {
                console.debug(`${logPrefix} No valid TMDB ID found for item, skipping`);
                return;
            }

            console.log(`${logPrefix} Fetching similar and recommended content for TMDB ID ${tmdbId} (${type})`);

            // Fetch only the data that's enabled
            const promises = [];
            if (showSimilar) {
                promises.push(
                    type === 'movie'
                        ? JE.jellyseerrAPI.fetchSimilarMovies(tmdbId)
                        : JE.jellyseerrAPI.fetchSimilarTvShows(tmdbId)
                );
            } else {
                promises.push(Promise.resolve({ results: [] }));
            }

            if (showRecommended) {
                promises.push(
                    type === 'movie'
                        ? JE.jellyseerrAPI.fetchRecommendedMovies(tmdbId)
                        : JE.jellyseerrAPI.fetchRecommendedTvShows(tmdbId)
                );
            } else {
                promises.push(Promise.resolve({ results: [] }));
            }

            const [similarData, recommendedData] = await Promise.all(promises);

            const similarResults = similarData?.results || [];
            const recommendedResults = recommendedData?.results || [];

            if (similarResults.length === 0 && recommendedResults.length === 0) {
                console.debug(`${logPrefix} No similar or recommended content to display`);
                return;
            }

            // Filter items if configured to exclude library items
            const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
            const filteredSimilarResults = excludeLibraryItems
                ? similarResults.filter(item => !item.mediaInfo?.jellyfinMediaId)
                : similarResults;
            const filteredRecommendedResults = excludeLibraryItems
                ? recommendedResults.filter(item => !item.mediaInfo?.jellyfinMediaId)
                : recommendedResults;

            if (filteredSimilarResults.length === 0 && filteredRecommendedResults.length === 0) {
                console.debug(`${logPrefix} No content to display after filtering library items`);
                return;
            }

            // Find the insertion point
            const activePage = document.querySelector('.libraryPage:not(.hide)');
            if (!activePage) {
                console.warn(`${logPrefix} Active page not found`);
                return;
            }

            const detailPageContent = activePage.querySelector('.detailPageContent');
            if (!detailPageContent) {
                console.warn(`${logPrefix} detailPageContent not found`);
                return;
            }

            // Find insertion point: always after "More Like This" section
            const moreLikeThisSection = detailPageContent.querySelector('#similarCollapsible');
            if (!moreLikeThisSection) {
                console.warn(`${logPrefix} "More Like This" section not found, cannot insert sections`);
                return;
            }

            // Remove any existing Jellyseerr sections to avoid duplicates
            detailPageContent.querySelectorAll('.jellyseerr-details-section').forEach(el => el.remove());

            // Create and insert sections
            if (filteredRecommendedResults.length > 0) {
                // Ensure title is properly translated
                const recommendedTitle = JE.t ? (JE.t('jellyseerr_recommended_title') || 'Recommended') : 'Recommended';
                const recommendedSection = createJellyseerrSection(
                    filteredRecommendedResults.slice(0, 20),
                    recommendedTitle
                );
                if (recommendedSection) {
                    moreLikeThisSection.after(recommendedSection);
                    console.log(`${logPrefix} Added Recommended section with ${filteredRecommendedResults.length} items`);
                }
            }

            if (filteredSimilarResults.length > 0) {
                // Ensure title is properly translated
                const similarTitle = JE.t ? (JE.t('jellyseerr_similar_title') || 'Similar') : 'Similar';
                const similarSection = createJellyseerrSection(
                    filteredSimilarResults.slice(0, 20),
                    similarTitle
                );
                if (similarSection) {
                    // Insert after the recommended section if it was created, otherwise after "More Like This"
                    const lastJellyseerrSection = detailPageContent.querySelector('.jellyseerr-details-section:last-of-type');
                    if (lastJellyseerrSection) {
                        lastJellyseerrSection.after(similarSection);
                    } else {
                        moreLikeThisSection.after(similarSection);
                    }
                    console.log(`${logPrefix} Added Similar section with ${filteredSimilarResults.length} items`);
                }
            }

        } catch (error) {
            console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
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
                // Small delay to ensure page is fully loaded
                setTimeout(() => {
                    renderSimilarAndRecommended(itemId);
                }, 500);
            }
        } catch (error) {
            console.error(`${logPrefix} Error parsing item ID from URL:`, error);
        }
    }

    /**
     * Initializes the item details handler
     */
    function initialize() {
        console.log(`${logPrefix} Initializing Recommendations and Similar sections`);

        // Listen for hash changes (navigation)
        window.addEventListener('hashchange', () => {
            processedItems.clear(); // Clear cache on navigation
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
