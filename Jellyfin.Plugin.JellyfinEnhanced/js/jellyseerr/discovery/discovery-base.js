// @ts-check
// /js/jellyseerr/discovery/discovery-base.js
//
// Shared state machine for the Seerr discovery sections (genre, tag,
// network, person, collection). Owns the chassis every module used to
// re-declare — processed-page dedup, re-entry guard, AbortController swap,
// metrics, error handling, lifecycle/navigation wiring — plus the
// pagination machines:
//
//   mode 'dual-feed'    server-paginated TV + Movie feeds fetched page by
//                       page with interleaving, filter/sort controls and
//                       infinite scroll (genre / tag / network)
//   mode 'client-paged' one fetched result list chunk-rendered client-side
//                       with filter/sort and infinite scroll (person)
//   mode 'one-shot'     single render, no pagination (collection)
//
// This module is deliberately jellyseerr-scoped (not js/core/): everything
// it orchestrates — JE.discoveryFilter, JE.seamlessScroll, JE.jellyseerrAPI,
// JE.jellyseerrUI cards, JE.requestManager metrics — is Seerr plumbing and
// nothing outside js/jellyseerr consumes it.
//
// Public surface: JE.discoveryBase { createDiscovery, idFromDetailUrl, idFromListParam }.
(function(JE) {
    'use strict';

    /**
     * Extracts the item id from a detail-page URL (#!/details?id=...).
     * @returns {string|null}
     */
    function idFromDetailUrl() {
        const hash = window.location.hash;
        if (!hash.includes('/details') || !hash.includes('id=')) {
            return null;
        }
        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            return params.get('id');
        } catch (error) {
            return null;
        }
    }

    /**
     * Builds a parser that extracts a query param from a list-page URL
     * (#!/list?<param>=...).
     * @param {string} param - e.g. 'genreId', 'studioId'
     * @returns {() => string|null}
     */
    function idFromListParam(param) {
        return function() {
            const hash = window.location.hash;
            if (!hash.includes('/list') || !hash.includes(param + '=')) {
                return null;
            }
            try {
                const params = new URLSearchParams(hash.split('?')[1]);
                return params.get(param);
            } catch (error) {
                return null;
            }
        };
    }

    /**
     * @typedef {object} DiscoverySpec
     * @property {string} key - Module key ('genre', 'tag', 'network', 'person',
     *   'collection'). Drives the section CSS class, request-cache prefix,
     *   metrics key, filter/sort state key and lifecycle feature name.
     * @property {'dual-feed'|'client-paged'|'one-shot'} mode
     * @property {string} logLabel - Human label for log prefixes, e.g. 'Genre Discovery'.
     * @property {string} configKey - JE.pluginConfig gate key.
     * @property {boolean} [defaultEnabled=true] - true: render unless the config
     *   key is explicitly false. false: render only when the key is truthy.
     * @property {() => string|null} getIdFromUrl - URL/hash contract: returns the
     *   page's id (or name) when the module applies to the current page.
     * @property {(id: string) => string} [pageKey] - Override the processed-page
     *   key. Default: `${key}-${id}-${location.hash}`.
     * @property {(ctx: {id: string, signal: AbortSignal}) => Promise<{tvId?: (number|null), movieId?: (number|null), title: string}|null>} [resolveFeeds]
     *   dual-feed only: check user status and resolve TMDB feed ids + section
     *   title. Return null (or no ids) to skip rendering.
     * @property {(kind: 'tv'|'movie', id: number) => string} [buildDiscoverPath]
     *   dual-feed only: API path for a feed page, before ?page/&sortBy.
     * @property {(ctx: {id: string, signal: AbortSignal}) => Promise<{items: Array<any>, title: string}|null>} [resolveItems]
     *   client-paged only: check user status and fetch the full (deduped)
     *   result list + section title. Return null to skip rendering.
     * @property {(ctx: {id: string, pageKey: string, signal: AbortSignal, waitForPageReady: (signal?: AbortSignal) => Promise<HTMLElement|null>}) => Promise<boolean|undefined>} [renderOneShot]
     *   one-shot only: perform the full render. Return true to mark the page
     *   as processed (and end metrics).
     * @property {number} [pageSize] - client-paged chunk size (default 40).
     * @property {() => void} [onCleanup] - Extra per-module cleanup (cache clears).
     */

    /**
     * Creates a discovery section controller from a spec.
     * @param {DiscoverySpec} spec
     * @returns {{initialize: () => void, cleanup: () => void, render: () => Promise<void>, handlePageNavigation: () => void, start: () => void}}
     */
    function createDiscovery(spec) {
        const key = spec.key;
        const logPrefix = `🪼 Jellyfin Enhanced: ${spec.logLabel}:`;
        const sectionSelector = `.jellyseerr-${key}-discovery-section`;
        const isDualFeed = spec.mode === 'dual-feed';
        const isClientPaged = spec.mode === 'client-paged';
        const cardClass = isDualFeed ? 'portraitCard' : 'overflowPortraitCard';
        const PAGE_SIZE = spec.pageSize || 40;

        // ---- Chassis state (all modes) -------------------------------------
        const processedPages = new Set();
        /** @type {AbortController|null} */
        let currentAbortController = null;
        /** @type {string|null} */
        let currentRenderingPageKey = null;

        // ---- Pagination state (dual-feed + client-paged) --------------------
        let isLoading = false;
        let hasMorePages = true;
        const scrollState = { activeScrollObserver: null };

        // dual-feed: separate page tracking for TV and Movies
        let tvCurrentPage = 1;
        let movieCurrentPage = 1;
        let tvHasMorePages = true;
        let movieHasMorePages = true;
        /** @type {{tvId: (number|null), movieId: (number|null)}|null} */
        let currentFeeds = null;
        /** @type {Array<any>} */
        let cachedTvResults = [];
        /** @type {Array<any>} */
        let cachedMovieResults = [];
        /** @type {{add: Function, filter: Function, clear: Function}|null} */
        let itemDeduplicator = null;

        // client-paged: one cached list, chunk-rendered
        let clientListActive = false;
        /** @type {Array<any>} */
        let cachedAllResults = [];
        /** @type {Array<any>} */
        let currentPagedResults = [];
        let renderedCount = 0;

        /**
         * Managed fetch through the shared request manager (cache prefix = key).
         * @param {string} path
         * @param {object} [options]
         */
        const fetchWithManagedRequest = (path, options) =>
            JE.discoveryFilter.fetchWithManagedRequest(path, key, options);

        /**
         * Whether the module is enabled by plugin config.
         * @returns {boolean}
         */
        function isEnabled() {
            if (spec.defaultEnabled === false) {
                return !!JE.pluginConfig?.[spec.configKey];
            }
            return JE.pluginConfig?.[spec.configKey] !== false;
        }

        /**
         * Fetches one discover feed page (dual-feed), appending page/sortBy
         * query params exactly as the modules always did.
         * @param {'tv'|'movie'} kind
         * @param {number} feedId
         * @param {number} page
         * @param {AbortSignal} [signal]
         * @returns {Promise<{results: Array<any>, totalPages: number}>}
         */
        async function fetchFeedPage(kind, feedId, page = 1, signal) {
            try {
                if (signal?.aborted) {
                    throw new DOMException('Aborted', 'AbortError');
                }
                const sortBy = kind === 'tv'
                    ? (JE.discoveryFilter?.getTvSortMode(key) || '')
                    : (JE.discoveryFilter?.getSortMode(key) || '');
                let path = `${spec.buildDiscoverPath(kind, feedId)}?page=${page}`;
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
         * Sorts results client-side based on current sort mode (client-paged).
         * @param {Array<any>} results
         * @returns {Array<any>} new sorted array
         */
        function applySortOrder(results) {
            const sortBy = JE.discoveryFilter?.getSortMode(key) || '';
            if (!sortBy) return results; // default order from API (popularity)

            const sorted = [...results];
            if (sortBy === 'vote_average.desc') {
                sorted.sort((a, b) => (b.voteAverage || 0) - (a.voteAverage || 0));
            } else if (sortBy === 'release_date.desc') {
                sorted.sort((a, b) => {
                    const dateA = a.releaseDate || a.firstAirDate || '';
                    const dateB = b.releaseDate || b.firstAirDate || '';
                    return dateB.localeCompare(dateA);
                });
            } else if (sortBy === 'release_date.asc') {
                sorted.sort((a, b) => {
                    const dateA = a.releaseDate || a.firstAirDate || '';
                    const dateB = b.releaseDate || b.firstAirDate || '';
                    return dateA.localeCompare(dateB);
                });
            }
            return sorted;
        }

        /**
         * Gets filtered/interleaved results based on current filter mode.
         * @param {string} mode - 'mixed', 'movies', or 'tv'
         * @returns {Array<any>}
         */
        function getFilteredResults(mode) {
            const filter = JE.discoveryFilter;

            if (isClientPaged) {
                const sorted = applySortOrder(cachedAllResults);
                if (!filter) {
                    return sorted;
                }
                if (mode === filter.MODES.MOVIES || mode === filter.MODES.TV) {
                    return filter.filterByMediaType(sorted, mode);
                }
                // Mixed mode - interleave TV and Movies for balanced display
                const tvResults = sorted.filter(item => item.mediaType === 'tv');
                const movieResults = sorted.filter(item => item.mediaType === 'movie');
                return filter.interleaveArrays(tvResults, movieResults);
            }

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
         * Creates a document fragment of media cards from results.
         * @param {Array<any>} results
         * @returns {DocumentFragment}
         */
        function createCardsFragment(results) {
            return JE.discoveryFilter.createCardsFragment(results, { cardClass });
        }

        /**
         * Creates the section container with optional filter and sort controls.
         * @param {string} title - Section heading text
         * @param {boolean} showFilter - Whether to show the All/Movies/Series filter
         * @param {Function} onFilterChange - Callback when filter changes: (newMode) => void
         * @param {Function} [onSortChange] - Callback when sort changes: () => void
         * @returns {HTMLElement} The section element
         */
        function createSectionContainer(title, showFilter, onFilterChange, onSortChange) {
            const section = document.createElement('div');
            section.className = isDualFeed
                ? `verticalSection jellyseerr-${key}-discovery-section padded-left padded-right`
                : `verticalSection jellyseerr-${key}-discovery-section`;
            section.setAttribute(`data-jellyseerr-${key}-discovery`, 'true');
            section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

            // Use shared header helper if available, otherwise create basic header
            if (JE.discoveryFilter?.createSectionHeader) {
                const header = JE.discoveryFilter.createSectionHeader(title, key, showFilter, onFilterChange, onSortChange);
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
            itemsContainer.className = isDualFeed
                ? 'vertical-wrap itemsContainer centered'
                : 'itemsContainer padded-right vertical-wrap';
            section.appendChild(itemsContainer);

            return section;
        }

        /**
         * Updates hasMorePages based on current filter mode (dual-feed).
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
         * Gets the full result set for a filter mode, falling back to all
         * results if the filtered set is empty (client-paged).
         * @param {string} mode
         * @returns {Array<any>}
         */
        function getPagedResultsForMode(mode) {
            let results = getFilteredResults(mode);
            if (results.length === 0 && cachedAllResults.length > 0) {
                results = cachedAllResults;
            }
            return results;
        }

        /**
         * Renders the next PAGE_SIZE chunk of results into the container
         * (client-paged pagination of the full fetched list).
         * @param {HTMLElement|null} itemsContainer
         * @param {string} mode - Current filter mode
         * @param {boolean} [reset=false] - Clear existing cards and reset counter
         */
        function renderChunk(itemsContainer, mode, reset = false) {
            if (!itemsContainer) return;

            if (reset) {
                while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
                renderedCount = 0;
            }

            currentPagedResults = getPagedResultsForMode(mode);
            const nextChunk = currentPagedResults.slice(renderedCount, renderedCount + PAGE_SIZE);
            if (nextChunk.length === 0) {
                hasMorePages = false;
                return;
            }

            const fragment = createCardsFragment(nextChunk);
            if (fragment.childNodes.length > 0) {
                itemsContainer.appendChild(fragment);
            }

            renderedCount += nextChunk.length;
            hasMorePages = renderedCount < currentPagedResults.length;
        }

        /**
         * Loads more items for infinite scroll. dual-feed fetches the next
         * server page(s) for the active filter mode; client-paged renders the
         * next local chunk.
         */
        async function loadMoreItems() {
            if (isClientPaged) {
                if (isLoading || !hasMorePages || !clientListActive) return;

                isLoading = true;
                try {
                    const filterMode = JE.discoveryFilter?.getFilterMode(key) || 'mixed';
                    const itemsContainer = document.querySelector(`${sectionSelector} .itemsContainer`);
                    renderChunk(/** @type {HTMLElement|null} */ (itemsContainer), filterMode, false);
                } catch (error) {
                    if (error.name === 'AbortError') return;
                    console.error(`${logPrefix} Error loading more items:`, error);
                    throw error; // Re-throw for seamlessScroll retry handling
                } finally {
                    isLoading = false;
                }
                return;
            }

            if (isLoading || !hasMorePages || !currentFeeds || (!currentFeeds.tvId && !currentFeeds.movieId)) {
                return;
            }

            const filterMode = JE.discoveryFilter?.getFilterMode(key) || 'mixed';

            isLoading = true;

            // Track page state before increment so we can roll back on failure
            const prevTvPage = tvCurrentPage;
            const prevMoviePage = movieCurrentPage;

            try {
                const signal = currentAbortController?.signal;
                const promises = [];

                // Determine which endpoints to fetch based on filter mode and available IDs
                const needTv = currentFeeds.tvId && (filterMode === 'mixed' || filterMode === 'tv') && tvHasMorePages;
                const needMovies = currentFeeds.movieId && (filterMode === 'mixed' || filterMode === 'movies') && movieHasMorePages;

                if (needTv) {
                    tvCurrentPage++;
                    promises.push(
                        fetchFeedPage('tv', currentFeeds.tvId, tvCurrentPage, signal)
                            .then(r => ({ type: 'tv', data: r }))
                    );
                }
                if (needMovies) {
                    movieCurrentPage++;
                    promises.push(
                        fetchFeedPage('movie', currentFeeds.movieId, movieCurrentPage, signal)
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

                const itemsContainer = document.querySelector(`${sectionSelector} .itemsContainer`);
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
         * Handles sort change. dual-feed re-fetches page 1 with the new
         * sortBy param; client-paged re-sorts the cached list and re-renders.
         */
        async function handleSortChange() {
            const itemsContainer = /** @type {HTMLElement|null} */ (
                document.querySelector(`${sectionSelector} .itemsContainer`));

            if (isClientPaged) {
                const filterMode = JE.discoveryFilter?.getFilterMode(key) || 'mixed';
                if (!itemsContainer) return;

                renderChunk(itemsContainer, filterMode, true);
                cleanupScrollObserver();
                if (hasMorePages) {
                    setupInfiniteScroll();
                }
                return;
            }

            if (!itemsContainer || !currentFeeds || (!currentFeeds.tvId && !currentFeeds.movieId)) return;

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
            const filterMode = JE.discoveryFilter?.getFilterMode(key) || 'mixed';

            // Build fetch promises for available media types
            const fetchPromises = [];
            if (currentFeeds.tvId) {
                fetchPromises.push(
                    fetchFeedPage('tv', currentFeeds.tvId, 1, signal).then(r => ({ type: 'tv', data: r }))
                );
            }
            if (currentFeeds.movieId) {
                fetchPromises.push(
                    fetchFeedPage('movie', currentFeeds.movieId, 1, signal).then(r => ({ type: 'movie', data: r }))
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
         * Re-renders/refilters the section for the new filter mode.
         * @param {string} newMode
         */
        function handleFilterChange(newMode) {
            const itemsContainer = /** @type {HTMLElement|null} */ (
                document.querySelector(`${sectionSelector} .itemsContainer`));
            if (!itemsContainer) return;

            if (isClientPaged) {
                // Non-paginated endpoint: rebuild the visible list for the
                // selected mode and reset client-side paging.
                renderChunk(itemsContainer, newMode, true);
                cleanupScrollObserver();
                if (hasMorePages) {
                    setupInfiniteScroll();
                }
                return;
            }

            // Use fast CSS-based visibility (no DOM rebuild)
            JE.discoveryFilter.applyFilterVisibility(itemsContainer, newMode);

            // Update hasMorePages based on filter mode
            updateHasMorePages(newMode);

            // Re-setup infinite scroll if needed
            if (hasMorePages) {
                setupInfiniteScroll();
            }
        }

        /** Sets up infinite scroll observer using the shared utility. */
        function setupInfiniteScroll() {
            JE.discoveryFilter.setupInfiniteScroll(
                scrollState,
                sectionSelector,
                loadMoreItems,
                () => hasMorePages,
                () => isLoading
            );
        }

        /** Cleanup scroll observer using the shared utility. */
        function cleanupScrollObserver() {
            JE.discoveryFilter.cleanupScrollObserver(scrollState);
        }

        /**
         * Wait for the page to be ready using the shared utility. dual-feed
         * targets list pages, the other modes detail pages.
         * @param {AbortSignal} [signal]
         * @returns {Promise<HTMLElement|null>}
         */
        function waitForPageReady(signal) {
            return JE.discoveryFilter.waitForPageReady(signal, { type: isDualFeed ? 'list' : 'detail' });
        }

        /**
         * Renders the dual-feed section body (genre / tag / network).
         * @param {string} id
         * @param {AbortSignal} signal
         * @param {string} pageKey
         */
        async function renderDualFeed(id, signal, pageKey) {
            const pageReadyPromise = waitForPageReady(signal);

            const resolved = await spec.resolveFeeds({ id, signal });
            if (signal.aborted) return;
            if (!resolved || (!resolved.tvId && !resolved.movieId)) return;

            // Reset pagination state
            tvCurrentPage = 1;
            movieCurrentPage = 1;
            isLoading = false;
            hasMorePages = true;
            tvHasMorePages = true;
            movieHasMorePages = true;
            currentFeeds = { tvId: resolved.tvId || null, movieId: resolved.movieId || null };

            // Clear cached results
            cachedTvResults = [];
            cachedMovieResults = [];

            // Initialize deduplicator for infinite scroll
            itemDeduplicator = JE.seamlessScroll?.createDeduplicator() || null;

            // Fetch TV and Movies separately (only if IDs available)
            const fetchPromises = [];
            if (currentFeeds.tvId) {
                fetchPromises.push(
                    fetchFeedPage('tv', currentFeeds.tvId, 1, signal)
                        .then(r => ({ type: 'tv', data: r }))
                );
            }
            if (currentFeeds.movieId) {
                fetchPromises.push(
                    fetchFeedPage('movie', currentFeeds.movieId, 1, signal)
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

            // Always start each section on defaults instead of persisting previous choice.
            JE.discoveryFilter?.resetFilterMode?.(key);
            JE.discoveryFilter?.resetSortMode?.(key);
            // Get current filter mode
            const filterMode = JE.discoveryFilter?.getFilterMode(key) || 'mixed';

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

            const existing = document.querySelector(sectionSelector);
            if (existing) existing.remove();

            const section = createSectionContainer(resolved.title, hasBoth, handleFilterChange, handleSortChange);
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
                JE.requestManager.endMeasurement(`${key}-discovery`);
            }
        }

        /**
         * Renders the client-paged section body (person).
         * @param {string} id
         * @param {AbortSignal} signal
         * @param {string} pageKey
         */
        async function renderClientPaged(id, signal, pageKey) {
            const resolved = await spec.resolveItems({ id, signal });
            if (signal.aborted) return;
            if (!resolved || !resolved.items || resolved.items.length === 0) return;

            // Store all results for filter switching
            cachedAllResults = resolved.items;
            clientListActive = true;

            // Check if we have both media types
            const hasBoth = JE.discoveryFilter?.resultHasBothTypes(cachedAllResults) || false;

            // Always start each section on defaults instead of persisting previous choice.
            JE.discoveryFilter?.resetFilterMode?.(key);
            JE.discoveryFilter?.resetSortMode?.(key);
            // Get current filter mode
            const filterMode = JE.discoveryFilter?.getFilterMode(key) || 'mixed';

            // Get filtered results
            let displayResults = getFilteredResults(filterMode);

            // If filtered results are empty but we have some content, fall back to showing all
            if (displayResults.length === 0 && cachedAllResults.length > 0) {
                displayResults = cachedAllResults;
            }

            // Wait for page content
            const detailSection = await waitForPageReady(signal);
            if (signal.aborted) return;

            if (!detailSection) {
                console.debug(`${logPrefix} Could not find detail section to insert into`);
                return;
            }

            // Remove existing section
            const existing = document.querySelector(sectionSelector);
            if (existing) existing.remove();

            // Create and insert section
            const section = createSectionContainer(resolved.title, hasBoth, handleFilterChange, handleSortChange);
            const itemsContainer = section.querySelector('.itemsContainer');

            // Seed first page and let seamless scroll load the rest.
            const initialItems = displayResults.slice(0, PAGE_SIZE);
            const fragment = createCardsFragment(initialItems);
            if (fragment.childNodes.length === 0) {
                console.debug(`${logPrefix} No cards created from results`);
                return;
            }

            itemsContainer.appendChild(fragment);
            currentPagedResults = displayResults;
            renderedCount = initialItems.length;
            hasMorePages = renderedCount < currentPagedResults.length;

            detailSection.appendChild(section);
            console.debug(`${logPrefix} Section added with ${fragment.childNodes.length} cards`);

            if (hasMorePages) {
                setupInfiniteScroll();
            }

            // Mark as successfully processed AFTER successful render
            processedPages.add(pageKey);

            // End metrics
            if (JE.requestManager?.metrics?.enabled) {
                JE.requestManager.endMeasurement(`${key}-discovery`);
            }
        }

        /**
         * Main render entry — chassis shared by every mode: page-key dedup,
         * re-entry guard, config gate, abort-controller swap, metrics and
         * error handling.
         */
        async function render() {
            const id = spec.getIdFromUrl();
            if (!id) return;

            const pageKey = spec.pageKey
                ? spec.pageKey(id)
                : `${key}-${id}-${window.location.hash}`;
            if (processedPages.has(pageKey)) return;

            // Prevent re-entry if already rendering this same page
            if (currentRenderingPageKey === pageKey) return;

            if (!isEnabled()) return;

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
                JE.requestManager.startMeasurement(`${key}-discovery`);
            }

            try {
                if (isDualFeed) {
                    await renderDualFeed(id, signal, pageKey);
                } else if (isClientPaged) {
                    await renderClientPaged(id, signal, pageKey);
                } else {
                    const rendered = await spec.renderOneShot({
                        id,
                        pageKey,
                        signal,
                        waitForPageReady
                    });
                    if (signal.aborted) return;
                    if (rendered) {
                        // Mark as processed
                        processedPages.add(pageKey);

                        // End metrics
                        if (JE.requestManager?.metrics?.enabled) {
                            JE.requestManager.endMeasurement(`${key}-discovery`);
                        }
                    }
                }
            } catch (error) {
                // Don't mark as processed on failure so retry is possible
                if (error.name === 'AbortError') {
                    console.debug(`${logPrefix} Request aborted`);
                    return;
                }
                console.error(`${logPrefix} Error rendering ${key} discovery:`, error);
            } finally {
                // Clear rendering key after completion (success, abort, or failure)
                currentRenderingPageKey = null;
            }
        }

        /** Cleanup function — aborts in-flight requests and resets state. */
        function cleanup() {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
            if (spec.mode !== 'one-shot') {
                cleanupScrollObserver();
            }
            processedPages.clear();

            // Reset pagination state
            isLoading = false;
            hasMorePages = true;
            tvCurrentPage = 1;
            movieCurrentPage = 1;
            tvHasMorePages = true;
            movieHasMorePages = true;
            currentFeeds = null;
            clientListActive = false;
            currentPagedResults = [];
            renderedCount = 0;

            currentRenderingPageKey = null;

            // Clear cached results
            cachedTvResults = [];
            cachedMovieResults = [];
            cachedAllResults = [];

            // Clear deduplicator
            if (itemDeduplicator) {
                itemDeduplicator.clear();
            }
            itemDeduplicator = null;

            if (spec.mode !== 'one-shot') {
                JE.discoveryFilter?.resetFilterMode?.(key);
                JE.discoveryFilter?.resetSortMode?.(key);
            }

            if (spec.onCleanup) {
                spec.onCleanup();
            }
        }

        // Cached Seerr results carry per-user availability/request state.
        // Navigation normally runs cleanup() before a logout can complete,
        // but run it on the identity transition too so no path leaks user A's
        // results into user B's session.
        JE.session?.onUserChange(`discovery-${key}`, cleanup);

        /** Handles page navigation — renders when the URL matches the module. */
        function handlePageNavigation() {
            const id = spec.getIdFromUrl();
            if (id) {
                requestAnimationFrame(() => render());
            }
        }

        /** Initialize navigation listeners + lifecycle teardown wiring. */
        function initialize() {
            // Lifecycle: run cleanup() on EVERY navigation — hashchange, popstate
            // AND the pushState transitions the old raw hashchange listener
            // missed. Registration order matters: the teardown wiring is
            // registered first so cleanup always runs before handlePageNavigation
            // on a navigation.
            const lifecycle = JE.core.lifecycle.register(`jellyseerr-${key}-discovery`);
            lifecycle.onTeardown(cleanup);
            lifecycle.teardownOn('navigate');
            JE.core.navigation.onNavigate(handlePageNavigation);

            handlePageNavigation();
            JE.core.navigation.onViewPage(handlePageNavigation);
        }

        /** Run initialize now, or on DOMContentLoaded if still loading. */
        function start() {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', initialize);
            } else {
                initialize();
            }
        }

        return { initialize, cleanup, render, handlePageNavigation, start };
    }

    JE.discoveryBase = {
        createDiscovery,
        idFromDetailUrl,
        idFromListParam
    };

})(window.JellyfinEnhanced);
