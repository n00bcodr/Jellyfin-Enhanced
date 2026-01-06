// /js/jellyseerr/network-discovery.js
// Adds "More from [Network]" section to studio/network list pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Network Discovery:';

    // Cache for network ID mappings (studioName -> TMDB networkId)
    const networkIdCache = new Map();

    // Cache for studio info (studioId -> studioInfo)
    const studioInfoCache = new Map();

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
            return null;
        }
    }

    /**
     * Gets studio information from Jellyfin (with caching)
     * @param {string} studioId - The Jellyfin studio ID
     * @returns {Promise<{id: string, name: string, tmdbId: string|null}|null>}
     */
    async function getStudioInfo(studioId) {
        // Check cache first
        if (studioInfoCache.has(studioId)) {
            return studioInfoCache.get(studioId);
        }

        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/studio/${studioId}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            if (response) {
                studioInfoCache.set(studioId, response);
            }
            return response;
        } catch (error) {
            return null;
        }
    }

    /**
     * Gets TMDB network ID (synchronous for known networks, async fallback)
     * @param {string} networkName - The network name to search for
     * @returns {Promise<number|null>} - The TMDB network ID or null if not found
     */
    async function getTmdbNetworkId(networkName) {
        const cacheKey = networkName.toLowerCase().trim();

        // Check cache first (instant)
        if (networkIdCache.has(cacheKey)) {
            return networkIdCache.get(cacheKey);
        }

        // Check known networks (instant)
        if (KNOWN_NETWORKS[cacheKey]) {
            const id = KNOWN_NETWORKS[cacheKey];
            networkIdCache.set(cacheKey, id);
            return id;
        }

        // Search TMDB for the network (async fallback)
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tmdb/search/company?query=${encodeURIComponent(networkName)}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });

            if (response?.results?.length > 0) {
                const exactMatch = response.results.find(r =>
                    r.name.toLowerCase() === networkName.toLowerCase()
                );
                const networkId = exactMatch ? exactMatch.id : response.results[0].id;
                networkIdCache.set(cacheKey, networkId);
                return networkId;
            }
        } catch (error) {
            // Silent fail
        }

        return null;
    }

    /**
     * Fetches discover results from Jellyseerr for a network
     * @param {number} networkId - The TMDB network ID
     * @param {number} page - Page number (default: 1)
     * @returns {Promise<{results: Array, totalPages: number}>}
     */
    async function fetchNetworkDiscover(networkId, page = 1) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/tv/network/${networkId}?page=${page}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            return response || { results: [], totalPages: 1 };
        } catch (error) {
            return { results: [], totalPages: 1 };
        }
    }

    /**
     * Fetches discover results from Jellyseerr for a movie studio
     * @param {number} studioId - The TMDB studio/company ID
     * @param {number} page - Page number (default: 1)
     * @returns {Promise<{results: Array, totalPages: number}>}
     */
    async function fetchStudioDiscover(studioId, page = 1) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/movies/studio/${studioId}?page=${page}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            return response || { results: [], totalPages: 1 };
        } catch (error) {
            return { results: [], totalPages: 1 };
        }
    }

    /**
     * Creates cards and returns a DocumentFragment for batch DOM insertion
     * @param {Array} results - Array of Jellyseerr items
     * @returns {DocumentFragment} - Fragment containing all cards
     */
    function createCardsFragment(results) {
        const fragment = document.createDocumentFragment();
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;

        for (let i = 0; i < results.length; i++) {
            const item = results[i];

            // Skip library items if configured
            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) {
                continue;
            }

            const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
            if (!card) continue;

            // Batch class changes (read then write pattern)
            const classList = card.classList;
            classList.remove('overflowPortraitCard');
            classList.add('portraitCard');

            // Handle library items
            const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
            if (jellyfinMediaId) {
                card.setAttribute('data-library-item', 'true');
                card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
                classList.add('jellyseerr-card-in-library');

                const titleLink = card.querySelector('.cardText-first a');
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

        return fragment;
    }

    /**
     * Creates the section container (without cards)
     * @param {string} title - Section title
     * @returns {HTMLElement} - Section element
     */
    function createSectionContainer(title) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-network-discovery-section padded-left padded-right';
        section.setAttribute('data-jellyseerr-network-discovery', 'true');
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards';
        titleElement.textContent = title;
        titleElement.style.marginBottom = '1em';
        section.appendChild(titleElement);

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'vertical-wrap itemsContainer centered';
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

        try {
            // Fetch next page (parallel requests)
            const [tvResults, movieResults] = await Promise.all([
                fetchNetworkDiscover(currentNetworkId, currentPage),
                fetchStudioDiscover(currentNetworkId, currentPage)
            ]);

            const allResults = [
                ...(tvResults.results || []),
                ...(movieResults.results || [])
            ];

            // Update pagination state
            const tvTotalPages = tvResults.totalPages || 1;
            const movieTotalPages = movieResults.totalPages || 1;
            hasMorePages = currentPage < Math.max(tvTotalPages, movieTotalPages);

            if (allResults.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            // Find container and batch append
            const itemsContainer = document.querySelector('.jellyseerr-network-discovery-section .itemsContainer');
            if (itemsContainer) {
                const fragment = createCardsFragment(allResults);
                if (fragment.childNodes.length > 0) {
                    itemsContainer.appendChild(fragment);
                }
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
        const section = document.querySelector('.jellyseerr-network-discovery-section');
        if (!section) return;

        const sentinel = document.createElement('div');
        sentinel.className = 'jellyseerr-scroll-sentinel';
        sentinel.style.cssText = 'height:20px;width:100%';
        section.appendChild(sentinel);

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMorePages && !isLoading) {
                loadMoreItems();
            }
        }, { rootMargin: '200px' });

        observer.observe(sentinel);
    }

    /**
     * Main function to render the network discovery section
     */
    async function renderNetworkDiscovery() {
        const studioId = getStudioIdFromUrl();
        if (!studioId) return;

        // Prevent duplicate processing
        const pageKey = `${studioId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;
        processedPages.add(pageKey);

        // Check if feature is enabled (sync check)
        if (!JE.pluginConfig?.JellyseerrShowNetworkDiscovery) return;

        // Start ALL async operations in parallel for maximum speed
        const studioInfoPromise = getStudioInfo(studioId);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
        const pageReadyPromise = waitForPageReady();

        // Wait for studio info and status first (needed for network ID)
        const [studioInfo, status] = await Promise.all([studioInfoPromise, statusPromise]);

        if (!status?.active || !studioInfo?.name) return;

        // Get TMDB network ID (instant for known networks)
        const tmdbNetworkId = studioInfo.tmdbId
            ? parseInt(studioInfo.tmdbId)
            : await getTmdbNetworkId(studioInfo.name);

        if (!tmdbNetworkId) return;

        // Reset pagination state
        currentPage = 1;
        isLoading = false;
        hasMorePages = true;
        currentNetworkId = tmdbNetworkId;
        currentStudioName = studioInfo.name;

        // Fetch discover results in parallel (start immediately after getting network ID)
        const discoverPromise = Promise.all([
            fetchNetworkDiscover(tmdbNetworkId),
            fetchStudioDiscover(tmdbNetworkId)
        ]);

        // Wait for page and discover results in parallel
        const [[tvResults, movieResults]] = await Promise.all([discoverPromise, pageReadyPromise]);

        // Update pagination state
        const tvTotalPages = tvResults.totalPages || 1;
        const movieTotalPages = movieResults.totalPages || 1;
        hasMorePages = currentPage < Math.max(tvTotalPages, movieTotalPages);

        // Combine results
        const allResults = [
            ...(tvResults.results || []),
            ...(movieResults.results || [])
        ];

        if (allResults.length === 0) return;

        const listPage = document.querySelector('.itemsContainer');
        if (!listPage) return;

        // Remove existing sections
        const existing = document.querySelector('.jellyseerr-network-discovery-section');
        if (existing) existing.remove();

        // Create section with cards
        const section = createSectionContainer(`More from ${studioInfo.name}`);
        const itemsContainer = section.querySelector('.itemsContainer');

        // Batch insert cards using DocumentFragment
        const fragment = createCardsFragment(allResults.slice(0, 20));
        if (fragment.childNodes.length === 0) return;

        itemsContainer.appendChild(fragment);

        // Insert section into DOM (single reflow)
        const parentContainer = listPage.closest('.verticalSection') || listPage.parentElement;
        if (parentContainer?.parentElement) {
            parentContainer.parentElement.appendChild(section);

            // Setup infinite scroll if needed
            if (hasMorePages) {
                setupInfiniteScroll();
            }
        }
    }

    /**
     * Wait for the page to be ready (optimized)
     * @returns {Promise<void>}
     */
    function waitForPageReady() {
        return new Promise((resolve) => {
            // Check immediately first
            const listContainer = document.querySelector('.itemsContainer');
            if (listContainer?.children.length > 0) {
                resolve();
                return;
            }

            // Use MutationObserver for efficient DOM watching
            const observer = new MutationObserver((mutations, obs) => {
                const container = document.querySelector('.itemsContainer');
                if (container?.children.length > 0) {
                    obs.disconnect();
                    resolve();
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // Fallback timeout
            setTimeout(() => {
                observer.disconnect();
                resolve();
            }, 3000);
        });
    }

    /**
     * Handles page navigation
     */
    function handlePageNavigation() {
        const studioId = getStudioIdFromUrl();
        if (studioId) {
            // Use requestAnimationFrame for smoother integration with render cycle
            requestAnimationFrame(() => {
                renderNetworkDiscovery();
            });
        }
    }

    /**
     * Initializes the network discovery handler
     */
    function initialize() {
        // Listen for hash changes (navigation)
        window.addEventListener('hashchange', () => {
            processedPages.clear();
            handlePageNavigation();
        });

        // Check current page on load
        handlePageNavigation();

        // Also listen for viewshow events (Jellyfin's custom event)
        document.addEventListener('viewshow', handlePageNavigation);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(window.JellyfinEnhanced);
