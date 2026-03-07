// /js/jellyseerr/genre-discovery.js
// Adds "More [Genre]" section to genre list pages using Seerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Genre Discovery:';
    const MODULE_NAME = 'genre';

    const genreInfoCache = new Map();
    const processedPages = new Set();

    // Dynamic genre cache (populated from TMDB API)
    let tmdbGenreCache = null;

    // Pagination state
    let isLoading = false;
    let hasMorePages = true;
    let currentGenreIds = null;

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
        JE.discoveryFilter.fetchWithManagedRequest(path, 'genre', options);

    /**
     * Fetches TMDB genre lists and caches them
     * @param {AbortSignal} [signal] - Optional abort signal
     */
    async function fetchTmdbGenres(signal) {
        if (tmdbGenreCache) return tmdbGenreCache;

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const fetchOptions = { signal };
            const [tvResponse, movieResponse] = await Promise.all([
                fetchWithManagedRequest('/JellyfinEnhanced/tmdb/genres/tv', fetchOptions).catch(() => []),
                fetchWithManagedRequest('/JellyfinEnhanced/tmdb/genres/movie', fetchOptions).catch(() => [])
            ]);

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // Build lookup map by genre name (lowercase for matching)
            tmdbGenreCache = {};
            (tvResponse || []).forEach(g => {
                const key = g.name.toLowerCase();
                if (!tmdbGenreCache[key]) tmdbGenreCache[key] = { tv: null, movie: null };
                tmdbGenreCache[key].tv = g.id;
            });
            (movieResponse || []).forEach(g => {
                const key = g.name.toLowerCase();
                if (!tmdbGenreCache[key]) tmdbGenreCache[key] = { tv: null, movie: null };
                tmdbGenreCache[key].movie = g.id;
            });

            return tmdbGenreCache;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return {};
        }
    }

    /**
     * Extracts genre ID from the current URL
     * @returns {string|null} The genre ID or null if not on a genre page
     */
    function getGenreIdFromUrl() {
        const hash = window.location.hash;
        if (!hash.includes('/list') || !hash.includes('genreId=')) {
            return null;
        }
        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            return params.get('genreId');
        } catch (error) {
            return null;
        }
    }

    /**
     * Gets genre information from Jellyfin
     * @param {string} genreId
     * @param {AbortSignal} [signal]
     * @returns {Promise<Object|null>} Genre info object or null
     */
    async function getGenreInfo(genreId, signal) {
        if (genreInfoCache.has(genreId)) {
            return genreInfoCache.get(genreId);
        }
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/genre/${genreId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                genreInfoCache.set(genreId, response);
            }
            return response;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return null;
        }
    }

    /**
     * Gets TMDB genre IDs from genre name (fetches from TMDB API)
     * @param {string} genreName
     * @param {AbortSignal} [signal]
     * @returns {Promise<{tv: number|null, movie: number|null}|null>} Genre IDs or null
     */
    async function getTmdbGenreIds(genreName, signal) {
        const cacheKey = genreName.toLowerCase().trim();
        const genres = await fetchTmdbGenres(signal);

        // Start with exact match result (if any)
        const result = { tv: null, movie: null };

        if (genres[cacheKey]) {
            result.tv = genres[cacheKey].tv;
            result.movie = genres[cacheKey].movie;
        }

        // Also check partial matches and merge (e.g., "adventure" also matches "action & adventure")
        // This handles cases where TV and Movie genres have different names
        for (const [key, ids] of Object.entries(genres)) {
            if (key === cacheKey) continue; // Skip exact match already processed
            if (cacheKey.includes(key) || key.includes(cacheKey)) {
                // Merge: only fill in missing IDs
                if (!result.tv && ids.tv) result.tv = ids.tv;
                if (!result.movie && ids.movie) result.movie = ids.movie;
            }
        }

        // Return null if nothing found
        if (!result.tv && !result.movie) return null;
        return result;
    }

    /**
     * Fetches TV discover results by genre
     * @param {number} genreId
     * @param {number} page
     * @param {AbortSignal} [signal]
     */
    async function fetchTvDiscover(genreId, page = 1, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const sortBy = JE.discoveryFilter?.getTvSortMode(MODULE_NAME) || '';
            let path = `/JellyfinEnhanced/jellyseerr/discover/tv/genre/${genreId}?page=${page}`;
            if (sortBy) path += `&sortBy=${encodeURIComponent(sortBy)}`;
            const response = await fetchWithManagedRequest(path, { signal });
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
     * Fetches Movie discover results by genre
     * @param {number} genreId
     * @param {number} page
     * @param {AbortSignal} [signal]
     */
    async function fetchMovieDiscover(genreId, page = 1, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const sortBy = JE.discoveryFilter?.getSortMode(MODULE_NAME) || '';
            let path = `/JellyfinEnhanced/jellyseerr/discover/movies/genre/${genreId}?page=${page}`;
            if (sortBy) path += `&sortBy=${encodeURIComponent(sortBy)}`;
            const response = await fetchWithManagedRequest(path, { signal });
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
     * Creates a document fragment of media cards from results
     * @param {Array} results - Array of media result objects
     * @returns {DocumentFragment} Fragment containing rendered card elements
     */
    function createCardsFragment(results) {
        return JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' });
    }

    /**
     * Creates the section container with optional filter and sort controls
     * @param {string} title - Section heading text
     * @param {boolean} showFilter - Whether to show the All/Movies/Series filter
     * @param {Function} onFilterChange - Callback when filter changes: (newMode) => void
     * @param {Function} [onSortChange] - Callback when sort changes: () => void
     * @returns {HTMLElement} The section element
     */
    function createSectionContainer(title, showFilter, onFilterChange, onSortChange) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-genre-discovery-section padded-left padded-right';
        section.setAttribute('data-jellyseerr-genre-discovery', 'true');
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

        // Use shared header helper if available, otherwise create basic header
        if (JE.discoveryFilter?.createSectionHeader) {
            const header = JE.discoveryFilter.createSectionHeader(title, MODULE_NAME, showFilter, onFilterChange, onSortChange);
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
     * Handles sort change: clears results and re-fetches with new sort order.
     * Resets pagination, clears the card container, fetches page 1 with the
     * new sortBy param, and re-renders the results.
     */
    async function handleSortChange() {
        const itemsContainer = document.querySelector('.jellyseerr-genre-discovery-section .itemsContainer');
        if (!itemsContainer || !currentGenreIds) return;

        // Clear existing cards and scroll observer
        while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
        cleanupScrollObserver();

        // Reset pagination state for fresh fetch
        tvCurrentPage = 1;
        movieCurrentPage = 1;
        tvHasMorePages = true;
        movieHasMorePages = true;
        isLoading = false;
        cachedTvResults = [];
        cachedMovieResults = [];
        if (itemDeduplicator) itemDeduplicator.clear();

        // Abort previous requests and create a fresh controller to prevent race conditions
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;
        const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';

        // Build fetch promises for available media types
        const fetchPromises = [];
        if (currentGenreIds.tv) {
            fetchPromises.push(
                fetchTvDiscover(currentGenreIds.tv, 1, signal).then(r => ({ type: 'tv', data: r }))
            );
        }
        if (currentGenreIds.movie) {
            fetchPromises.push(
                fetchMovieDiscover(currentGenreIds.movie, 1, signal).then(r => ({ type: 'movie', data: r }))
            );
        }

        try {
            const results = await Promise.all(fetchPromises);
            if (signal.aborted) return;

            results.forEach(r => {
                if (r.type === 'tv') {
                    cachedTvResults = r.data.results || [];
                    tvHasMorePages = 1 < (r.data.totalPages || 1);
                } else {
                    cachedMovieResults = r.data.results || [];
                    movieHasMorePages = 1 < (r.data.totalPages || 1);
                }
            });

            updateHasMorePages(filterMode);

            let displayResults = getFilteredResults(filterMode);
            if (displayResults.length === 0 && (cachedTvResults.length > 0 || cachedMovieResults.length > 0)) {
                displayResults = [...cachedTvResults, ...cachedMovieResults];
            }

            if (displayResults.length > 0) {
                const fragment = createCardsFragment(displayResults);
                itemsContainer.appendChild(fragment);
                if (itemDeduplicator) {
                    displayResults.forEach(item => itemDeduplicator.add(item));
                }
            }

            JE.discoveryFilter.applyFilterVisibility(itemsContainer, filterMode);

            if (hasMorePages) {
                setupInfiniteScroll();
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(`${logPrefix} Sort change error:`, error);
            }
        }
    }

    /**
     * Re-renders the section with the new filter mode
     * @param {string} newMode
     */
    function handleFilterChange(newMode) {
        const itemsContainer = document.querySelector('.jellyseerr-genre-discovery-section .itemsContainer');
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
     * Loads more items for infinite scroll.
     * Fetches the next page of TV and/or movie results based on the current
     * filter mode, then appends new cards to the container.
     */
    async function loadMoreItems() {
        if (isLoading || !hasMorePages || !currentGenreIds) return;

        const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';

        isLoading = true;

        // Track page state before increment so we can roll back on failure
        const prevTvPage = tvCurrentPage;
        const prevMoviePage = movieCurrentPage;

        try {
            const signal = currentAbortController?.signal;
            const promises = [];

            // Determine which endpoints to fetch based on filter mode
            const needTv = (filterMode === 'mixed' || filterMode === 'tv') && tvHasMorePages && currentGenreIds.tv;
            const needMovies = (filterMode === 'mixed' || filterMode === 'movies') && movieHasMorePages && currentGenreIds.movie;

            if (needTv) {
                tvCurrentPage++;
                promises.push(
                    fetchTvDiscover(currentGenreIds.tv, tvCurrentPage, signal)
                        .then(r => ({ type: 'tv', data: r }))
                );
            }
            if (needMovies) {
                movieCurrentPage++;
                promises.push(
                    fetchMovieDiscover(currentGenreIds.movie, movieCurrentPage, signal)
                        .then(r => ({ type: 'movie', data: r }))
                );
            }

            if (promises.length === 0) {
                hasMorePages = false;
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
                itemsToAdd = JE.discoveryFilter?.interleaveArrays(newTvResults, newMovieResults) ||
                             [...newTvResults, ...newMovieResults];
            }

            if (itemsToAdd.length === 0) return;

            // Deduplicate items using deduplicator (if available)
            if (itemDeduplicator) {
                itemsToAdd = itemDeduplicator.filter(itemsToAdd);
                if (itemsToAdd.length === 0) return;
            }

            const itemsContainer = document.querySelector('.jellyseerr-genre-discovery-section .itemsContainer');
            if (itemsContainer) {
                const fragment = createCardsFragment(itemsToAdd);
                if (fragment.childNodes.length > 0) {
                    itemsContainer.appendChild(fragment);
                }
            }
        } catch (error) {
            // Roll back page counters on failure so retry fetches the same page
            tvCurrentPage = prevTvPage;
            movieCurrentPage = prevMoviePage;
            if (error.name === 'AbortError') return;
            console.error(`${logPrefix} Error loading more items:`, error);
            throw error; // Re-throw for seamlessScroll retry handling
        } finally {
            isLoading = false;
        }
    }

    /**
     * Sets up infinite scroll observer using shared utility
     */
    function setupInfiniteScroll() {
        JE.discoveryFilter.setupInfiniteScroll(
            scrollState,
            '.jellyseerr-genre-discovery-section',
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
     * Main function to render the genre discovery section
     */
    async function renderGenreDiscovery() {
        const genreId = getGenreIdFromUrl();
        if (!genreId) return;

        const pageKey = `genre-${genreId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;

        // Prevent re-entry if already rendering this same page
        if (currentRenderingPageKey === pageKey) return;

        if (JE.pluginConfig?.JellyseerrShowGenreDiscovery === false) return;

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
            JE.requestManager.startMeasurement('genre-discovery');
        }

        try {
            // Fetch genre info, user status, TMDB genres, and page ready all in parallel
            const genreInfoPromise = getGenreInfo(genreId, signal);
            const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
            const tmdbGenresPromise = fetchTmdbGenres(signal);
            const pageReadyPromise = waitForPageReady(signal);

            const [genreInfo, status] = await Promise.all([genreInfoPromise, statusPromise, tmdbGenresPromise]);

            if (signal.aborted) return;

            if (!status?.active || !genreInfo?.name) return;

            // TMDB genres are already cached from the parallel fetch above
            const tmdbGenreIds = await getTmdbGenreIds(genreInfo.name, signal);
            if (signal.aborted) return;

            if (!tmdbGenreIds || (!tmdbGenreIds.tv && !tmdbGenreIds.movie)) return;

            // Reset pagination state
            tvCurrentPage = 1;
            movieCurrentPage = 1;
            isLoading = false;
            hasMorePages = true;
            tvHasMorePages = true;
            movieHasMorePages = true;
            currentGenreIds = tmdbGenreIds;


            // Clear cached results
            cachedTvResults = [];
            cachedMovieResults = [];

            // Initialize deduplicator for infinite scroll
            itemDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

            // Fetch TV and Movies separately
            const fetchPromises = [];
            if (tmdbGenreIds.tv) {
                fetchPromises.push(
                    fetchTvDiscover(tmdbGenreIds.tv, 1, signal)
                        .then(r => ({ type: 'tv', data: r }))
                );
            }
            if (tmdbGenreIds.movie) {
                fetchPromises.push(
                    fetchMovieDiscover(tmdbGenreIds.movie, 1, signal)
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

            // Determine if we have both types
            const hasBoth = JE.discoveryFilter?.hasBothTypes(cachedTvResults, cachedMovieResults) || false;

            // Always start each section on defaults instead of persisting previous choice.
            JE.discoveryFilter?.resetFilterMode?.(MODULE_NAME);
            JE.discoveryFilter?.resetSortMode?.(MODULE_NAME);
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

            const existing = document.querySelector('.jellyseerr-genre-discovery-section');
            if (existing) existing.remove();

            const sectionTitle = JE.t('discovery_more_with_genre', { genre: genreInfo.name });
            const section = createSectionContainer(sectionTitle, hasBoth, handleFilterChange, handleSortChange);
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
                JE.requestManager.endMeasurement('genre-discovery');
            }

        } catch (error) {
            // Don't mark as processed on failure so retry is possible
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted`);
                return;
            }
            console.error(`${logPrefix} Error rendering genre discovery:`, error);
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
        currentGenreIds = null;

        currentRenderingPageKey = null;

        // Clear cached results
        cachedTvResults = [];
        cachedMovieResults = [];

        // Clear deduplicator
        if (itemDeduplicator) {
            itemDeduplicator.clear();
        }
        itemDeduplicator = null;
        JE.discoveryFilter?.resetFilterMode?.(MODULE_NAME);
        JE.discoveryFilter?.resetSortMode?.(MODULE_NAME);
    }

    /**
     * Handles page navigation
     */
    function handlePageNavigation() {
        const genreId = getGenreIdFromUrl();
        if (genreId) {
            requestAnimationFrame(() => renderGenreDiscovery());
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
