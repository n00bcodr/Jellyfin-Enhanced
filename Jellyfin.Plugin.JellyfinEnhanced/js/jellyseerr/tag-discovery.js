// /js/jellyseerr/tag-discovery.js
// Adds "More [Tag]" section to tag list pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Tag Discovery:';
    const MODULE_NAME = 'tag';

    const keywordIdCache = new Map();
    const processedPages = new Set();

    // Pagination state
    let isLoading = false;
    let hasMorePages = true;
    let currentKeywordId = null;
    let currentTagName = null;

    // Separate page tracking for TV and Movies
    let tvCurrentPage = 1;
    let movieCurrentPage = 1;
    let tvHasMorePages = true;
    let movieHasMorePages = true;

    // Cached results for filter switching (avoid refetch)
    let cachedTvResults = [];
    let cachedMovieResults = [];

    // Global deduplicator for cross-page uniqueness
    let itemDeduplicator = null;

    // Abort controller for cancellation
    let currentAbortController = null;

    // Track current rendering to prevent duplicate renders
    let currentRenderingPageKey = null;

    // State object for scroll observer (used by shared utilities)
    const scrollState = { activeScrollObserver: null };

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'tag', options);

    /**
     * Extracts tag name from the current URL
     */
    function getTagFromUrl() {
        const hash = window.location.hash;
        if (!hash.includes('/list') || !hash.includes('type=tag') || !hash.includes('tag=')) {
            return null;
        }
        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            if (params.get('type') !== 'tag') return null;
            return decodeURIComponent(params.get('tag') || '');
        } catch (error) {
            return null;
        }
    }

    /**
     * Searches for TMDB keyword ID by name (cached)
     * @param {string} tagName
     * @param {AbortSignal} [signal]
     */
    async function searchTmdbKeyword(tagName, signal) {
        const cacheKey = tagName.toLowerCase().trim();
        if (keywordIdCache.has(cacheKey)) {
            return keywordIdCache.get(cacheKey);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(tagName)}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response?.results?.length > 0) {
                const exactMatch = response.results.find(r =>
                    r.name.toLowerCase() === tagName.toLowerCase()
                );
                const keywordId = exactMatch ? exactMatch.id : response.results[0].id;
                keywordIdCache.set(cacheKey, keywordId);
                return keywordId;
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // Silent fail
        }

        return null;
    }

    /**
     * Fetches TV discover results by keyword
     * @param {number} keywordId
     * @param {number} page
     * @param {AbortSignal} [signal]
     */
    async function fetchTvDiscover(keywordId, page = 1, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/jellyseerr/discover/tv/keyword/${keywordId}?page=${page}`,
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
     * Fetches Movie discover results by keyword
     * @param {number} keywordId
     * @param {number} page
     * @param {AbortSignal} [signal]
     */
    async function fetchMovieDiscover(keywordId, page = 1, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/jellyseerr/discover/movies/keyword/${keywordId}?page=${page}`,
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
        section.className = 'verticalSection jellyseerr-tag-discovery-section padded-left padded-right';
        section.setAttribute('data-jellyseerr-tag-discovery', 'true');
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
        const itemsContainer = document.querySelector('.jellyseerr-tag-discovery-section .itemsContainer');
        if (!itemsContainer) return;

        // Clear existing cards safely
        while (itemsContainer.firstChild) {
            itemsContainer.removeChild(itemsContainer.firstChild);
        }

        // Reset deduplicator for fresh filter view
        if (itemDeduplicator) {
            itemDeduplicator.clear();
        }

        // Get filtered results - show ALL cached results, not just first 20
        const filtered = getFilteredResults(newMode);

        // Render all cached cards
        const fragment = createCardsFragment(filtered);
        if (fragment.childNodes.length > 0) {
            itemsContainer.appendChild(fragment);
        }

        // Seed deduplicator with all displayed items
        if (itemDeduplicator) {
            filtered.forEach(item => itemDeduplicator.add(item));
        }

        // Update hasMorePages based on filter mode
        updateHasMorePages(newMode);

        // Re-setup infinite scroll if there are more API pages to fetch
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
        if (isLoading || !hasMorePages || !currentKeywordId) return;

        const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';

        isLoading = true;

        try {
            const signal = currentAbortController?.signal;
            const promises = [];

            // Determine which endpoints to fetch based on filter mode
            const needTv = (filterMode === 'mixed' || filterMode === 'tv') && tvHasMorePages;
            const needMovies = (filterMode === 'mixed' || filterMode === 'movies') && movieHasMorePages;

            if (needTv) {
                tvCurrentPage++;
                promises.push(
                    fetchTvDiscover(currentKeywordId, tvCurrentPage, signal)
                        .then(r => ({ type: 'tv', data: r }))
                );
            }
            if (needMovies) {
                movieCurrentPage++;
                promises.push(
                    fetchMovieDiscover(currentKeywordId, movieCurrentPage, signal)
                        .then(r => ({ type: 'movie', data: r }))
                );
            }

            if (promises.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            const results = await Promise.all(promises);

            if (signal?.aborted) return;

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

            // Deduplicate items across pages using global deduplicator
            if (itemDeduplicator) {
                itemsToAdd = itemDeduplicator.filter(itemsToAdd);
                if (itemsToAdd.length === 0) {
                    console.debug(`${logPrefix} All items were duplicates, skipping render`);
                    isLoading = false;
                    return;
                }
            }

            const itemsContainer = document.querySelector('.jellyseerr-tag-discovery-section .itemsContainer');
            if (itemsContainer) {
                const fragment = createCardsFragment(itemsToAdd);
                if (fragment.childNodes.length > 0) {
                    itemsContainer.appendChild(fragment);
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error(`${logPrefix} Error loading more items:`, error);
            throw error; // Re-throw so seamless scroll can handle retry
        }

        isLoading = false;
    }

    /**
     * Sets up infinite scroll observer using shared utility
     */
    function setupInfiniteScroll() {
        JE.discoveryFilter.setupInfiniteScroll(
            scrollState,
            '.jellyseerr-tag-discovery-section',
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
     * Main function to render the tag discovery section
     */
    async function renderTagDiscovery() {
        const tagName = getTagFromUrl();
        if (!tagName) return;

        const pageKey = `tag-${tagName}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;

        // Prevent re-entry if already rendering this same page
        if (currentRenderingPageKey === pageKey) return;

        if (JE.pluginConfig?.JellyseerrShowTagDiscovery === false) return;

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
            JE.requestManager.startMeasurement('tag-discovery');
        }

        try {
            const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
            const pageReadyPromise = waitForPageReady(signal);

            const status = await statusPromise;

            if (signal.aborted) return;

            if (!status?.active) return;

            // Search for TMDB keyword
            const keywordId = await searchTmdbKeyword(tagName, signal);
            if (signal.aborted) return;

            if (!keywordId) return;

            // Reset pagination state
            tvCurrentPage = 1;
            movieCurrentPage = 1;
            isLoading = false;
            hasMorePages = true;
            tvHasMorePages = true;
            movieHasMorePages = true;
            currentKeywordId = keywordId;
            currentTagName = tagName;

            // Clear cached results
            cachedTvResults = [];
            cachedMovieResults = [];

            // Initialize deduplicator for cross-page uniqueness
            itemDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

            // Fetch TV and Movies separately
            const [tvResponse, movieResponse, listPage] = await Promise.all([
                fetchTvDiscover(keywordId, 1, signal),
                fetchMovieDiscover(keywordId, 1, signal),
                pageReadyPromise
            ]);

            if (signal.aborted) return;

            // Store results separately
            cachedTvResults = tvResponse.results || [];
            cachedMovieResults = movieResponse.results || [];
            tvHasMorePages = 1 < (tvResponse.totalPages || 1);
            movieHasMorePages = 1 < (movieResponse.totalPages || 1);

            // Determine if we have both types
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

            const existing = document.querySelector('.jellyseerr-tag-discovery-section');
            if (existing) existing.remove();

            const sectionTitle = JE.t('discovery_more_with_tag', { tag: tagName });
            const section = createSectionContainer(sectionTitle, hasBoth, handleFilterChange);
            const itemsContainer = section.querySelector('.itemsContainer');

            // Show all results from initial fetch (not sliced - page 1 is already limited by API)
            const fragment = createCardsFragment(displayResults);
            if (fragment.childNodes.length === 0) return;

            itemsContainer.appendChild(fragment);

            // Seed deduplicator with initially displayed items to prevent duplicates on scroll
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
                JE.requestManager.endMeasurement('tag-discovery');
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted`);
                return;
            }
            console.error(`${logPrefix} Error rendering tag discovery:`, error);
        } finally {
            // Clear rendering key after completion (success, abort, or failure)
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
        currentKeywordId = null;
        currentTagName = null;
        currentRenderingPageKey = null;

        // Clear cached results
        cachedTvResults = [];
        cachedMovieResults = [];

        // Reset deduplicator
        if (itemDeduplicator) {
            itemDeduplicator.clear();
        }
        itemDeduplicator = null;
    }

    /**
     * Handles page navigation
     */
    function handlePageNavigation() {
        const tagName = getTagFromUrl();
        if (tagName) {
            requestAnimationFrame(() => renderTagDiscovery());
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
