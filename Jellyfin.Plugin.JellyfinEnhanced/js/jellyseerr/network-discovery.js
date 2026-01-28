// /js/jellyseerr/network-discovery.js
// Adds "More from [Network]" section to studio/network list pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Network Discovery:';
    const MODULE_NAME = 'network';

    // Cache for network ID mappings (studioName -> TMDB networkId)
    const networkIdCache = new Map();

    // Cache for studio info (studioId -> studioInfo)
    const studioInfoCache = new Map();

    // Track processed pages to avoid duplicate renders
    const processedPages = new Set();

    // Pagination state
    let isLoading = false;
    let hasMorePages = true;
    let currentTvNetworkId = null;
    let currentCompanyId = null;

    // Separate page tracking for TV and Movies
    let tvCurrentPage = 1;
    let movieCurrentPage = 1;
    let tvHasMorePages = true;
    let movieHasMorePages = true;

    // Cached results for filter switching (avoid refetch)
    let cachedTvResults = [];
    let cachedMovieResults = [];

    // Deduplicator for infinite scroll (prevents duplicate cards)
    let itemDeduplicator = null;

    // Abort controller for cancellation
    let currentAbortController = null;

    // Track current rendering to prevent duplicate renders
    let currentRenderingPageKey = null;

    // State object for scroll observer (used by shared utilities)
    const scrollState = { activeScrollObserver: null };

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'network', options);

    // TMDB TV Network IDs (these are different from company/studio IDs)
    const TV_NETWORKS = {
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
     * @param {string} studioId
     * @param {AbortSignal} [signal]
     */
    async function getStudioInfo(studioId, signal) {
        if (studioInfoCache.has(studioId)) {
            return studioInfoCache.get(studioId);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/studio/${studioId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                studioInfoCache.set(studioId, response);
            }
            return response;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return null;
        }
    }

    /**
     * Gets TMDB TV network ID from known networks list
     */
    function getKnownNetworkId(networkName) {
        const key = networkName.toLowerCase().trim();
        if (TV_NETWORKS[key]) return TV_NETWORKS[key];

        for (const [name, id] of Object.entries(TV_NETWORKS)) {
            if (key.includes(name) || name.includes(key)) {
                return id;
            }
        }
        return null;
    }

    /**
     * Gets TMDB company ID by searching TMDB (for movie studios)
     * @param {string} networkName
     * @param {AbortSignal} [signal]
     */
    async function searchTmdbCompany(networkName, signal) {
        const cacheKey = networkName.toLowerCase().trim();

        if (networkIdCache.has(cacheKey)) {
            return networkIdCache.get(cacheKey);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/tmdb/search/company?query=${encodeURIComponent(networkName)}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response?.results?.length > 0) {
                // Filter to exact name matches first
                const exactMatches = response.results.filter(r =>
                    r.name.toLowerCase() === networkName.toLowerCase()
                );

                // Score matches: prefer US origin + logo, then US origin, then any logo
                const scored = (exactMatches.length > 0 ? exactMatches : response.results).map(r => ({
                    ...r,
                    score: (r.origin_country === 'US' ? 2 : 0) + (r.logo_path ? 1 : 0)
                }));

                // Sort by score descending, pick highest
                scored.sort((a, b) => b.score - a.score);

                if (scored.length === 0) return null;
                const companyId = scored[0].id;

                networkIdCache.set(cacheKey, companyId);
                return companyId;
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // Silent fail
        }

        return null;
    }

    /**
     * Fetches discover results from Jellyseerr for a network (TV)
     * @param {number} networkId
     * @param {number} page
     * @param {AbortSignal} [signal]
     */
    async function fetchNetworkDiscover(networkId, page = 1, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/jellyseerr/discover/tv/network/${networkId}?page=${page}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            return response || { results: [], totalPages: 1 };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return { results: [], totalPages: 1 };
        }
    }

    /**
     * Fetches discover results from Jellyseerr for a movie studio
     * @param {number} studioId
     * @param {number} page
     * @param {AbortSignal} [signal]
     */
    async function fetchStudioDiscover(studioId, page = 1, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${studioId}?page=${page}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            return response || { results: [], totalPages: 1 };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return { results: [], totalPages: 1 };
        }
    }

    /**
     * Gets filtered/interleaved results based on current filter mode
     * @param {string} mode - 'mixed', 'movies', or 'tv'
     * @returns {Array}
     */
    function getFilteredResults(mode) {
        const filter = JE.discoveryFilter;
        if (!filter) {
            // Fallback if utility not loaded
            return [...cachedTvResults, ...cachedMovieResults];
        }

        if (mode === filter.MODES.MOVIES) {
            return cachedMovieResults;
        }
        if (mode === filter.MODES.TV) {
            return cachedTvResults;
        }
        // Mixed mode - interleave
        return filter.interleaveArrays(cachedTvResults, cachedMovieResults);
    }

    /**
     * Creates cards using shared utility
     */
    function createCardsFragment(results) {
        return JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' });
    }

    /**
     * Creates the section container with optional filter control
     * @param {string} title
     * @param {boolean} showFilter
     * @param {Function} onFilterChange
     */
    function createSectionContainer(title, showFilter, onFilterChange) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-network-discovery-section padded-left padded-right';
        section.setAttribute('data-jellyseerr-network-discovery', 'true');
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

        // Use shared header helper if available, otherwise create basic header
        if (JE.discoveryFilter?.createSectionHeader) {
            const header = JE.discoveryFilter.createSectionHeader(title, MODULE_NAME, showFilter, onFilterChange);
            section.appendChild(header);
        } else {
            const titleElement = document.createElement('h2');
            titleElement.className = 'sectionTitle sectionTitle-cards';
            titleElement.textContent = title;
            titleElement.style.marginBottom = '1em';
            section.appendChild(titleElement);
        }

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'vertical-wrap itemsContainer centered';
        section.appendChild(itemsContainer);

        return section;
    }

    /**
     * Re-renders the section with the new filter mode
     * @param {string} newMode
     */
    function handleFilterChange(newMode) {
        const itemsContainer = document.querySelector('.jellyseerr-network-discovery-section .itemsContainer');
        if (!itemsContainer) return;

        // Use fast CSS-based visibility (no DOM rebuild)
        JE.discoveryFilter.applyFilterVisibility(itemsContainer, newMode);

        // Update hasMorePages based on filter mode
        updateHasMorePages(newMode);

        // Re-setup infinite scroll if needed
        if (hasMorePages) {
            setupInfiniteScroll();
        }
    }

    /**
     * Updates hasMorePages based on current filter mode
     * @param {string} mode
     */
    function updateHasMorePages(mode) {
        const filter = JE.discoveryFilter;
        if (!filter) {
            hasMorePages = tvHasMorePages || movieHasMorePages;
            return;
        }

        if (mode === filter.MODES.TV) {
            hasMorePages = tvHasMorePages;
        } else if (mode === filter.MODES.MOVIES) {
            hasMorePages = movieHasMorePages;
        } else {
            hasMorePages = tvHasMorePages || movieHasMorePages;
        }
    }

    /**
     * Loads more items for infinite scroll
     */
    async function loadMoreItems() {
        if (isLoading || !hasMorePages || (!currentTvNetworkId && !currentCompanyId)) {
            return;
        }

        const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';

        isLoading = true;

        try {
            const signal = currentAbortController?.signal;
            const promises = [];

            // Determine which endpoints to fetch based on filter mode and available IDs
            const needTv = currentTvNetworkId && (filterMode === 'mixed' || filterMode === 'tv') && tvHasMorePages;
            const needMovies = currentCompanyId && (filterMode === 'mixed' || filterMode === 'movies') && movieHasMorePages;

            if (needTv) {
                tvCurrentPage++;
                promises.push(
                    fetchNetworkDiscover(currentTvNetworkId, tvCurrentPage, signal)
                        .then(r => ({ type: 'tv', data: r }))
                );
            }
            if (needMovies) {
                movieCurrentPage++;
                promises.push(
                    fetchStudioDiscover(currentCompanyId, movieCurrentPage, signal)
                        .then(r => ({ type: 'movie', data: r }))
                );
            }

            if (promises.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            const results = await Promise.all(promises);

            if (signal?.aborted) { isLoading = false; return; }

            let newTvResults = [];
            let newMovieResults = [];

            results.forEach(r => {
                if (r.type === 'tv') {
                    newTvResults = r.data.results || [];
                    tvHasMorePages = tvCurrentPage < (r.data.totalPages || 1);
                    cachedTvResults = [...cachedTvResults, ...newTvResults];
                } else {
                    newMovieResults = r.data.results || [];
                    movieHasMorePages = movieCurrentPage < (r.data.totalPages || 1);
                    cachedMovieResults = [...cachedMovieResults, ...newMovieResults];
                }
            });

            updateHasMorePages(filterMode);

            // Get items to add based on filter mode
            let itemsToAdd;
            if (filterMode === 'tv') {
                itemsToAdd = newTvResults;
            } else if (filterMode === 'movies') {
                itemsToAdd = newMovieResults;
            } else {
                // Mixed - interleave the new results
                itemsToAdd = JE.discoveryFilter?.interleaveArrays(newTvResults, newMovieResults) ||
                             [...newTvResults, ...newMovieResults];
            }

            if (itemsToAdd.length === 0) {
                isLoading = false;
                return;
            }

            // Deduplicate items using deduplicator (if available)
            if (itemDeduplicator) {
                itemsToAdd = itemDeduplicator.filter(itemsToAdd);
                if (itemsToAdd.length === 0) {
                    isLoading = false;
                    return;
                }
            }

            const itemsContainer = document.querySelector('.jellyseerr-network-discovery-section .itemsContainer');
            if (itemsContainer) {
                const fragment = createCardsFragment(itemsToAdd);
                if (fragment.childNodes.length > 0) {
                    itemsContainer.appendChild(fragment);
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error(`${logPrefix} Error loading more items:`, error);
            throw error; // Re-throw for seamlessScroll retry handling
        }

        isLoading = false;
    }

    /**
     * Sets up infinite scroll observer using shared utility
     */
    function setupInfiniteScroll() {
        JE.discoveryFilter.setupInfiniteScroll(
            scrollState,
            '.jellyseerr-network-discovery-section',
            loadMoreItems,
            () => hasMorePages,
            () => isLoading
        );
    }

    /**
     * Cleanup scroll observer using shared utility
     */
    function cleanupScrollObserver() {
        JE.discoveryFilter.cleanupScrollObserver(scrollState);
    }

    /**
     * Wait for the page to be ready using shared utility
     * @param {AbortSignal} [signal]
     */
    function waitForPageReady(signal) {
        return JE.discoveryFilter.waitForPageReady(signal, { type: 'list' });
    }

    /**
     * Main function to render the network discovery section
     */
    async function renderNetworkDiscovery() {
        const studioId = getStudioIdFromUrl();
        if (!studioId) return;

        const pageKey = `${studioId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;

        // Prevent re-entry if already rendering this same page
        if (currentRenderingPageKey === pageKey) return;

        if (!JE.pluginConfig?.JellyseerrShowNetworkDiscovery) return;

        // Set rendering key before potentially aborting
        currentRenderingPageKey = pageKey;

        // Cancel any previous requests (for different pages)
        if (currentAbortController) {
            currentAbortController.abort();
        }
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;

        // Start metrics if enabled
        if (JE.requestManager?.metrics?.enabled) {
            JE.requestManager.startMeasurement('network-discovery');
        }

        try {
            const studioInfoPromise = getStudioInfo(studioId, signal);
            const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
            const pageReadyPromise = waitForPageReady(signal);

            const [studioInfo, status] = await Promise.all([studioInfoPromise, statusPromise]);

            if (signal.aborted) return;

            if (!status?.active || !studioInfo?.name) return;

            // TV network IDs are different from company IDs in TMDB
            // Always use name lookup for TV networks
            const tvNetworkId = getKnownNetworkId(studioInfo.name);

            // For movie studios, use stored tmdbId if available, otherwise search
            const companyId = studioInfo.tmdbId
                ? parseInt(studioInfo.tmdbId)
                : await searchTmdbCompany(studioInfo.name, signal);

            if (signal.aborted) return;

            if (!tvNetworkId && !companyId) return;

            // Reset pagination state
            tvCurrentPage = 1;
            movieCurrentPage = 1;
            isLoading = false;
            hasMorePages = true;
            tvHasMorePages = true;
            movieHasMorePages = true;
            currentTvNetworkId = tvNetworkId;
            currentCompanyId = companyId;


            // Clear cached results
            cachedTvResults = [];
            cachedMovieResults = [];

            // Initialize deduplicator for infinite scroll
            itemDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

            // Fetch TV and Movies separately (only if IDs available)
            const fetchPromises = [];
            if (tvNetworkId) {
                fetchPromises.push(
                    fetchNetworkDiscover(tvNetworkId, 1, signal)
                        .then(r => ({ type: 'tv', data: r }))
                );
            }
            if (companyId) {
                fetchPromises.push(
                    fetchStudioDiscover(companyId, 1, signal)
                        .then(r => ({ type: 'movie', data: r }))
                );
            }

            const [fetchResults, listPage] = await Promise.all([
                Promise.all(fetchPromises),
                pageReadyPromise
            ]);

            if (signal.aborted) return;

            // Process results
            fetchResults.forEach(r => {
                if (r.type === 'tv') {
                    cachedTvResults = r.data.results || [];
                    tvHasMorePages = 1 < (r.data.totalPages || 1);
                } else {
                    cachedMovieResults = r.data.results || [];
                    movieHasMorePages = 1 < (r.data.totalPages || 1);
                }
            });

            // Determine if we have both types (only show filter if BOTH have results)
            const hasBoth = JE.discoveryFilter?.hasBothTypes(cachedTvResults, cachedMovieResults) || false;

            // Get current filter mode
            const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';

            // Update hasMorePages
            updateHasMorePages(filterMode);

            // Get results based on filter mode
            let displayResults = getFilteredResults(filterMode);

            // If filtered results are empty but we have some content, fall back to showing all
            if (displayResults.length === 0 && (cachedTvResults.length > 0 || cachedMovieResults.length > 0)) {
                displayResults = [...cachedTvResults, ...cachedMovieResults];
            }

            if (displayResults.length === 0) return;

            if (!listPage) return;

            const existing = document.querySelector('.jellyseerr-network-discovery-section');
            if (existing) existing.remove();

            const sectionTitle = JE.t('discovery_more_from_studio', { studio: studioInfo.name });
            const section = createSectionContainer(sectionTitle, hasBoth, handleFilterChange);
            const itemsContainer = section.querySelector('.itemsContainer');

            const fragment = createCardsFragment(displayResults);
            if (fragment.childNodes.length === 0) return;

            itemsContainer.appendChild(fragment);

            // Seed deduplicator with initial items to prevent duplicates on scroll
            if (itemDeduplicator) {
                displayResults.forEach(item => itemDeduplicator.add(item));
            }

            const parentContainer = listPage.closest('.verticalSection') || listPage.parentElement;
            if (parentContainer?.parentElement) {
                parentContainer.parentElement.appendChild(section);

                if (hasMorePages) {
                    setupInfiniteScroll();
                }

                // Mark as successfully processed AFTER successful render
                processedPages.add(pageKey);
            }

            // End metrics
            if (JE.requestManager?.metrics?.enabled) {
                JE.requestManager.endMeasurement('network-discovery');
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted`);
                return;
            }
            console.error(`${logPrefix} Error rendering network discovery:`, error);
        } finally {
            // Clear rendering key after completion (success, abort, or failure)
            // processedPages guards against duplicate successful renders
            currentRenderingPageKey = null;
        }
    }

    /**
     * Cleanup function
     */
    function cleanup() {
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        cleanupScrollObserver();
        processedPages.clear();

        // Reset pagination state
        tvCurrentPage = 1;
        movieCurrentPage = 1;
        isLoading = false;
        hasMorePages = true;
        tvHasMorePages = true;
        movieHasMorePages = true;
        currentTvNetworkId = null;
        currentCompanyId = null;

        currentRenderingPageKey = null;

        // Clear cached results
        cachedTvResults = [];
        cachedMovieResults = [];

        // Clear deduplicator
        if (itemDeduplicator) {
            itemDeduplicator.clear();
        }
        itemDeduplicator = null;
    }

    /**
     * Handles page navigation
     */
    function handlePageNavigation() {
        const studioId = getStudioIdFromUrl();
        if (studioId) {
            requestAnimationFrame(() => {
                renderNetworkDiscovery();
            });
        }
    }

    /**
     * Initialize
     */
    function initialize() {
        window.addEventListener('hashchange', () => {
            cleanup();
            handlePageNavigation();
        });

        handlePageNavigation();
        document.addEventListener('viewshow', handlePageNavigation);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(window.JellyfinEnhanced);
