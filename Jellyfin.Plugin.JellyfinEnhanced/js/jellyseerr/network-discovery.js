// /js/jellyseerr/network-discovery.js
// Adds "More from [Network]" section to studio/network list pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Network Discovery:';

    // Cache for network ID mappings (studioName -> TMDB networkId)
    const networkIdCache = new Map();

    // Track processed pages to avoid duplicate renders
    const processedPages = new Set();

    // Pagination state
    let currentPage = 1;
    let isLoading = false;
    let hasMorePages = true;
    let currentNetworkId = null;
    let currentStudioName = null;

    // Common TV networks mapping (name -> TMDB network ID)
    // This provides instant lookup for the most popular networks
    const KNOWN_NETWORKS = {
        'netflix': 213,
        'hbo': 49,
        'hbo max': 3186,
        'max': 3186,
        'amazon': 1024,
        'amazon prime video': 1024,
        'prime video': 1024,
        'apple tv+': 2552,
        'apple tv': 2552,
        'disney+': 2739,
        'disney plus': 2739,
        'hulu': 453,
        'paramount+': 4330,
        'paramount plus': 4330,
        'peacock': 3353,
        'fx': 88,
        'fx networks': 88,
        'amc': 174,
        'showtime': 67,
        'starz': 318,
        'abc': 2,
        'nbc': 6,
        'cbs': 16,
        'fox': 19,
        'the cw': 71,
        'cw': 71,
        'bbc': 4,
        'bbc one': 4,
        'bbc two': 332,
        'itv': 9,
        'channel 4': 26,
        'sky': 1063,
        'syfy': 77,
        'usa network': 30,
        'tnt': 41,
        'tbs': 68,
        'a&e': 129,
        'history': 65,
        'discovery': 64,
        'national geographic': 43,
        'nat geo': 43,
        'adult swim': 80,
        'cartoon network': 56,
        'nickelodeon': 13,
        'comedy central': 47,
        'mtv': 33,
        'bet': 24,
        'espn': 29,
        'crunchyroll': 1112,
        'anime network': 171,
        'funimation': 102,
        'youtube': 247,
        'youtube premium': 1436
    };

    /**
     * Extracts studio ID from the current URL
     * @returns {string|null} - The studio ID or null if not on a studio page
     */
    function getStudioIdFromUrl() {
        const hash = window.location.hash;
        if (!hash.includes('/list') || !hash.includes('studioId=')) {
            return null;
        }

        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            return params.get('studioId');
        } catch (error) {
            console.warn(`${logPrefix} Failed to parse studioId from URL:`, error);
            return null;
        }
    }

    /**
     * Gets studio information from Jellyfin
     * @param {string} studioId - The Jellyfin studio ID
     * @returns {Promise<{id: string, name: string, tmdbId: string|null}|null>}
     */
    async function getStudioInfo(studioId) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/studio/${studioId}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            return response;
        } catch (error) {
            console.warn(`${logPrefix} Failed to get studio info:`, error);
            return null;
        }
    }

    /**
     * Searches TMDB for a network by name
     * @param {string} networkName - The network name to search for
     * @returns {Promise<number|null>} - The TMDB network ID or null if not found
     */
    async function searchTmdbNetwork(networkName) {
        // Check cache first
        const cacheKey = networkName.toLowerCase().trim();
        if (networkIdCache.has(cacheKey)) {
            return networkIdCache.get(cacheKey);
        }

        // Check known networks
        if (KNOWN_NETWORKS[cacheKey]) {
            const id = KNOWN_NETWORKS[cacheKey];
            networkIdCache.set(cacheKey, id);
            return id;
        }

        // Search TMDB for the network
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tmdb/search/company?query=${encodeURIComponent(networkName)}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });

            if (response && response.results && response.results.length > 0) {
                // Find the best match - prioritize exact matches
                const exactMatch = response.results.find(r =>
                    r.name.toLowerCase() === networkName.toLowerCase()
                );
                const networkId = exactMatch ? exactMatch.id : response.results[0].id;
                networkIdCache.set(cacheKey, networkId);
                return networkId;
            }
        } catch (error) {
            console.warn(`${logPrefix} TMDB search failed for "${networkName}":`, error);
        }

        return null;
    }

    /**
     * Fetches discover results from Jellyseerr for a network
     * @param {number} networkId - The TMDB network ID
     * @param {number} page - Page number (default: 1)
     * @returns {Promise<{results: Array}>}
     */
    async function fetchNetworkDiscover(networkId, page = 1) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/tv/network/${networkId}?page=${page}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            return response || { results: [] };
        } catch (error) {
            console.warn(`${logPrefix} Failed to fetch network discover:`, error);
            return { results: [] };
        }
    }

    /**
     * Fetches discover results from Jellyseerr for a movie studio
     * @param {number} studioId - The TMDB studio/company ID
     * @param {number} page - Page number (default: 1)
     * @returns {Promise<{results: Array}>}
     */
    async function fetchStudioDiscover(studioId, page = 1) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/movies/studio/${studioId}?page=${page}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            return response || { results: [] };
        } catch (error) {
            console.warn(`${logPrefix} Failed to fetch studio discover:`, error);
            return { results: [] };
        }
    }

    /**
     * Creates a Jellyseerr section with vertical grid layout
     * @param {Array} results - Array of Jellyseerr items
     * @param {string} title - Section title
     * @returns {HTMLElement|null} - Section element or null if no results
     */
    function createDiscoverSection(results, title) {
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
        section.className = 'verticalSection jellyseerr-network-discovery-section';
        section.setAttribute('data-jellyseerr-network-discovery', 'true');
        section.style.marginTop = '2em';
        section.style.paddingTop = '1em';
        section.style.borderTop = '1px solid rgba(255,255,255,0.1)';

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards padded-left padded-right';
        titleElement.textContent = title;
        titleElement.style.marginBottom = '1em';
        section.appendChild(titleElement);

        // Use exact same container structure as native Jellyfin list pages
        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'itemsContainer vertical-wrap padded-left padded-right';

        // Add items to container using Jellyseerr UI card creator
        filteredResults.forEach(item => {
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

        section.appendChild(itemsContainer);
        return section;
    }

    /**
     * Loads more items for infinite scroll
     */
    async function loadMoreItems() {
        if (isLoading || !hasMorePages || !currentNetworkId) {
            return;
        }

        isLoading = true;
        currentPage++;

        console.log(`${logPrefix} Loading page ${currentPage} for network ${currentStudioName}`);

        try {
            // Fetch next page
            const [tvResults, movieResults] = await Promise.all([
                fetchNetworkDiscover(currentNetworkId, currentPage),
                fetchStudioDiscover(currentNetworkId, currentPage)
            ]);

            const allResults = [
                ...(tvResults.results || []),
                ...(movieResults.results || [])
            ];

            // Check if we have more pages
            const tvTotalPages = tvResults.totalPages || 1;
            const movieTotalPages = movieResults.totalPages || 1;
            hasMorePages = currentPage < Math.max(tvTotalPages, movieTotalPages);

            if (allResults.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            // Filter out library items if configured
            const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
            let filteredResults = allResults;
            if (excludeLibraryItems) {
                filteredResults = allResults.filter(item => !item.mediaInfo?.jellyfinMediaId);
            }

            // Find the existing container and append new items
            const itemsContainer = document.querySelector('.jellyseerr-network-discovery-section .itemsContainer');
            if (itemsContainer && filteredResults.length > 0) {
                filteredResults.forEach(item => {
                    const card = JE.jellyseerrUI && JE.jellyseerrUI.createJellyseerrCard
                        ? JE.jellyseerrUI.createJellyseerrCard(item, true, true)
                        : null;
                    if (card) {
                        const titleLink = card.querySelector('.cardText-first a');
                        const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
                        if (jellyfinMediaId) {
                            card.setAttribute('data-library-item', 'true');
                            card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
                            card.classList.add('jellyseerr-card-in-library');
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
                console.log(`${logPrefix} Added ${filteredResults.length} more items (page ${currentPage})`);
            }
        } catch (error) {
            console.error(`${logPrefix} Error loading more items:`, error);
        }

        isLoading = false;
    }

    /**
     * Sets up infinite scroll observer
     */
    function setupInfiniteScroll() {
        // Create a sentinel element at the bottom
        const sentinel = document.createElement('div');
        sentinel.className = 'jellyseerr-scroll-sentinel';
        sentinel.style.height = '20px';
        sentinel.style.width = '100%';

        const section = document.querySelector('.jellyseerr-network-discovery-section');
        if (section) {
            section.appendChild(sentinel);

            // Use Intersection Observer for efficient scroll detection
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && hasMorePages && !isLoading) {
                        loadMoreItems();
                    }
                });
            }, {
                rootMargin: '200px' // Start loading before user reaches the bottom
            });

            observer.observe(sentinel);
        }
    }

    /**
     * Main function to render the network discovery section
     */
    async function renderNetworkDiscovery() {
        const studioId = getStudioIdFromUrl();
        if (!studioId) {
            return;
        }

        // Prevent duplicate processing
        const pageKey = `${studioId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) {
            return;
        }
        processedPages.add(pageKey);

        // Check if feature is enabled
        if (!JE.pluginConfig?.JellyseerrShowNetworkDiscovery) {
            console.debug(`${logPrefix} Network discovery is disabled in settings`);
            return;
        }

        // Check if Jellyseerr is active
        const status = await JE.jellyseerrAPI?.checkUserStatus();
        if (!status || !status.active) {
            console.debug(`${logPrefix} Jellyseerr is not active, skipping`);
            return;
        }

        // Get studio info from Jellyfin
        const studioInfo = await getStudioInfo(studioId);
        if (!studioInfo || !studioInfo.name) {
            console.warn(`${logPrefix} Could not get studio info for ID: ${studioId}`);
            return;
        }

        console.log(`${logPrefix} Processing studio/network: ${studioInfo.name}`);

        // Try to get TMDB network ID
        let tmdbNetworkId = null;

        // First check if Jellyfin has the TMDB ID
        if (studioInfo.tmdbId) {
            tmdbNetworkId = parseInt(studioInfo.tmdbId);
        } else {
            // Search TMDB for the network
            tmdbNetworkId = await searchTmdbNetwork(studioInfo.name);
        }

        if (!tmdbNetworkId) {
            console.warn(`${logPrefix} Could not find TMDB ID for: ${studioInfo.name}`);
            return;
        }

        console.log(`${logPrefix} Found TMDB network ID ${tmdbNetworkId} for: ${studioInfo.name}`);

        // Reset pagination state for new network
        currentPage = 1;
        isLoading = false;
        hasMorePages = true;
        currentNetworkId = tmdbNetworkId;
        currentStudioName = studioInfo.name;

        // Fetch discover results - try both TV network and movie studio endpoints
        const [tvResults, movieResults] = await Promise.all([
            fetchNetworkDiscover(tmdbNetworkId),
            fetchStudioDiscover(tmdbNetworkId)
        ]);

        // Check total pages for pagination
        const tvTotalPages = tvResults.totalPages || 1;
        const movieTotalPages = movieResults.totalPages || 1;
        hasMorePages = currentPage < Math.max(tvTotalPages, movieTotalPages);

        // Combine results, preferring TV shows for networks
        const allResults = [
            ...(tvResults.results || []),
            ...(movieResults.results || [])
        ];

        if (allResults.length === 0) {
            console.debug(`${logPrefix} No discover results for: ${studioInfo.name}`);
            return;
        }

        // Wait for the page to be ready
        await waitForPageReady();

        // Find the insertion point - look for the main content area
        const listPage = document.querySelector('.itemsContainer');
        if (!listPage) {
            console.warn(`${logPrefix} Could not find list page content area`);
            return;
        }

        // Remove any existing network discovery sections
        document.querySelectorAll('.jellyseerr-network-discovery-section').forEach(el => el.remove());

        // Create section title - use simple string replacement since JE.t may not support params
        const sectionTitle = `More from ${studioInfo.name}`;

        // Create and insert the section
        const section = createDiscoverSection(allResults.slice(0, 20), sectionTitle);
        if (section) {
            // Find the parent container and insert AFTER the existing content
            const parentContainer = listPage.closest('.verticalSection') || listPage.parentElement;
            if (parentContainer && parentContainer.parentElement) {
                // Insert after the parent container (at the bottom)
                parentContainer.parentElement.appendChild(section);
                console.log(`${logPrefix} Added "More from ${studioInfo.name}" section with ${Math.min(allResults.length, 20)} items`);

                // Setup infinite scroll if there are more pages
                if (hasMorePages) {
                    setupInfiniteScroll();
                }
            }
        }
    }

    /**
     * Wait for the page to be ready
     * @returns {Promise<void>}
     */
    function waitForPageReady() {
        return new Promise((resolve) => {
            const checkReady = () => {
                const listContainer = document.querySelector('.itemsContainer');
                if (listContainer && listContainer.children.length > 0) {
                    resolve();
                } else {
                    setTimeout(checkReady, 100);
                }
            };
            // Initial delay to let the page start loading
            setTimeout(checkReady, 500);
        });
    }

    /**
     * Handles page navigation
     */
    function handlePageNavigation() {
        const studioId = getStudioIdFromUrl();
        if (studioId) {
            // Small delay to ensure page is loaded
            setTimeout(() => {
                renderNetworkDiscovery();
            }, 800);
        }
    }

    /**
     * Initializes the network discovery handler
     */
    function initialize() {
        console.log(`${logPrefix} Initializing Network Discovery`);

        // Listen for hash changes (navigation)
        window.addEventListener('hashchange', () => {
            processedPages.clear();
            handlePageNavigation();
        });

        // Check current page on load
        handlePageNavigation();

        // Also listen for viewshow events (Jellyfin's custom event)
        document.addEventListener('viewshow', () => {
            handlePageNavigation();
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(window.JellyfinEnhanced);
