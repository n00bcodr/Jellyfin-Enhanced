// /js/jellyseerr/person-discovery.js
// Adds "More from [Actor]" section to person detail pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Person Discovery:';
    const MODULE_NAME = 'person';

    // Cache for person ID mappings (personName -> TMDB personId)
    const personIdCache = new Map();
    const personInfoCache = new Map();
    const processedPages = new Set();

    // Pagination state
    let isLoading = false;
    let hasMorePages = true;
    let currentPersonId = null;
    let currentPagedResults = [];
    let renderedCount = 0;
    const PAGE_SIZE = 40;

    // Cached results for filter switching (avoid refetch)
    let cachedAllResults = [];

    // Abort controller for cancellation
    let currentAbortController = null;

    // Track current rendering to prevent duplicate renders
    let currentRenderingPageKey = null;

    // State object for scroll observer (used by shared utilities)
    const scrollState = { activeScrollObserver: null };

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'person', options);

    /**
     * Extracts person ID from the current URL (detail page)
     */
    function getPersonIdFromUrl() {
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
     * Gets person information from Jellyfin (with caching)
     * @param {string} personId
     * @param {AbortSignal} [signal]
     */
    async function getPersonInfo(personId, signal) {
        if (personInfoCache.has(personId)) {
            return personInfoCache.get(personId);
        }
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/person/${personId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                personInfoCache.set(personId, response);
            }
            return response;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return null;
        }
    }

    /**
     * Check if current page is a Person detail page
     * @param {string} itemId
     * @param {AbortSignal} [signal]
     */
    async function isPersonPage(itemId, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            return item && item.Type === 'Person';
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return false;
        }
    }

    /**
     * Searches for TMDB person ID by name
     * @param {string} personName
     * @param {AbortSignal} [signal]
     */
    async function searchTmdbPerson(personName, signal) {
        const cacheKey = personName.toLowerCase().trim();
        if (personIdCache.has(cacheKey)) {
            return personIdCache.get(cacheKey);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/tmdb/search/person?query=${encodeURIComponent(personName)}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response?.results?.length > 0) {
                const personResults = response.results.filter(r => r.mediaType === 'person');
                if (personResults.length > 0) {
                    // Filter to exact name matches first
                    const exactMatches = personResults.filter(r =>
                        r.name?.toLowerCase() === personName.toLowerCase()
                    );

                    // Score matches: prefer those with profile images and more known works
                    const scored = (exactMatches.length > 0 ? exactMatches : personResults).map(r => ({
                        ...r,
                        score: (r.profilePath ? 2 : 0) + Math.min(r.knownFor?.length || 0, 3)
                    }));

                    scored.sort((a, b) => b.score - a.score);

                    if (scored.length === 0) return null;
                    const personId = scored[0].id;

                    personIdCache.set(cacheKey, personId);
                    return personId;
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // Silent fail
        }
        return null;
    }

    /**
     * Fetches person credits from Jellyseerr
     * @param {number} personId
     * @param {AbortSignal} [signal]
     */
    async function fetchPersonCredits(personId, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/jellyseerr/person/${personId}/combined_credits`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            return response || { cast: [], crew: [] };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error(`${logPrefix} Error fetching credits:`, error);
            return { cast: [], crew: [] };
        }
    }

    /**
     * Gets filtered results based on current filter mode
     * @param {string} mode - 'mixed', 'movies', or 'tv'
     * @returns {Array}
     */
    function getFilteredResults(mode) {
        const filter = JE.discoveryFilter;
        if (!filter) {
            return cachedAllResults;
        }

        if (mode === filter.MODES.MOVIES) {
            return filter.filterByMediaType(cachedAllResults, mode);
        }
        if (mode === filter.MODES.TV) {
            return filter.filterByMediaType(cachedAllResults, mode);
        }

        // Mixed mode - interleave TV and Movies for balanced display
        const tvResults = cachedAllResults.filter(item => item.mediaType === 'tv');
        const movieResults = cachedAllResults.filter(item => item.mediaType === 'movie');
        return filter.interleaveArrays(tvResults, movieResults);
    }

    /**
     * Checks if cached results have both movie and TV content
     * @returns {boolean}
     */
    function hasBothMediaTypes() {
        return JE.discoveryFilter?.resultHasBothTypes(cachedAllResults) || false;
    }

    /**
     * Creates cards using shared utility (overflowPortraitCard for person page)
     */
    function createCardsFragment(results) {
        return JE.discoveryFilter.createCardsFragment(results, { cardClass: 'overflowPortraitCard' });
    }

    /**
     * Creates the section container with optional filter control
     * @param {string} title
     * @param {boolean} showFilter
     * @param {Function} onFilterChange
     */
    function createSectionContainer(title, showFilter, onFilterChange) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-person-discovery-section';
        section.setAttribute('data-jellyseerr-person-discovery', 'true');
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

        // Match native container: itemsContainer padded-right vertical-wrap
        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'itemsContainer padded-right vertical-wrap';
        section.appendChild(itemsContainer);

        return section;
    }

    /**
     * Re-renders the section with the new filter mode
     * @param {string} newMode
     */
    function handleFilterChange(newMode) {
        const itemsContainer = document.querySelector('.jellyseerr-person-discovery-section .itemsContainer');
        if (!itemsContainer) return;

        // Person credits are a non-paginated endpoint, so we page client-side.
        // Rebuild the visible list for the selected mode and reset paging.
        renderChunk(itemsContainer, newMode, true);
        cleanupScrollObserver();
        if (hasMorePages) {
            setupInfiniteScroll();
        }
    }

    function getPagedResultsForMode(mode) {
        let results = getFilteredResults(mode);
        if (results.length === 0 && cachedAllResults.length > 0) {
            results = cachedAllResults;
        }
        return results;
    }

    function renderChunk(itemsContainer, mode, reset = false) {
        if (!itemsContainer) return;

        if (reset) {
            itemsContainer.innerHTML = '';
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
     * Loads more items for infinite scroll
     */
    async function loadMoreItems() {
        if (isLoading || !hasMorePages || !currentPersonId) return;

        isLoading = true;

        try {
            const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';
            const itemsContainer = document.querySelector('.jellyseerr-person-discovery-section .itemsContainer');
            renderChunk(itemsContainer, filterMode, false);
        } catch (error) {
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
            '.jellyseerr-person-discovery-section',
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
     * Wait for the page to be ready using shared utility (detail page type)
     * @param {AbortSignal} [signal]
     */
    function waitForPageReady(signal) {
        return JE.discoveryFilter.waitForPageReady(signal, { type: 'detail' });
    }

    /**
     * Main function to render the person discovery section
     */
    async function renderPersonDiscovery() {
        const itemId = getPersonIdFromUrl();
        if (!itemId) return;

        const pageKey = `person-${itemId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;

        // Prevent re-entry if already rendering this same page
        if (currentRenderingPageKey === pageKey) return;

        if (JE.pluginConfig?.JellyseerrShowPersonDiscovery === false) return;

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
            JE.requestManager.startMeasurement('person-discovery');
        }

        try {
            // Check if this is a person page
            const isPerson = await isPersonPage(itemId, signal);
            if (signal.aborted) return;
            if (!isPerson) return;

            const personInfoPromise = getPersonInfo(itemId, signal);
            const statusPromise = JE.jellyseerrAPI?.checkUserStatus();

            const [personInfo, status] = await Promise.all([personInfoPromise, statusPromise]);

            if (signal.aborted) return;

            if (!status?.active || !personInfo?.name) return;

            // Get TMDB person ID
            const tmdbPersonId = personInfo.tmdbId
                ? parseInt(personInfo.tmdbId)
                : await searchTmdbPerson(personInfo.name, signal);

            if (signal.aborted) return;

            if (!tmdbPersonId) return;

            // Store for reference
            currentPersonId = tmdbPersonId;


            // Fetch credits
            const credits = await fetchPersonCredits(tmdbPersonId, signal);
            if (signal.aborted) return;

            const allResults = [...(credits.cast || []), ...(credits.crew || [])];
            const dedupedResults = [];
            const seenItems = new Set();
            for (const item of allResults) {
                const key = `${item?.mediaType}-${item?.id}`;
                if (!item?.id || !item?.mediaType || seenItems.has(key)) continue;
                seenItems.add(key);
                dedupedResults.push(item);
            }

            console.debug(`${logPrefix} Fetched ${dedupedResults.length} credits for ${personInfo.name}`);

            if (dedupedResults.length === 0) return;

            // Store all results for filter switching
            cachedAllResults = dedupedResults;

            // Check if we have both media types
            const hasBoth = hasBothMediaTypes();

            // Always start each section on "All" (mixed) instead of persisting previous choice.
            JE.discoveryFilter?.resetFilterMode?.(MODULE_NAME);
            // Get current filter mode
            const filterMode = JE.discoveryFilter?.getFilterMode(MODULE_NAME) || 'mixed';

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
            const existing = document.querySelector('.jellyseerr-person-discovery-section');
            if (existing) existing.remove();

            // Create and insert section
            const sectionTitle = JE.t('discovery_more_from_person', { person: personInfo.name });
            const section = createSectionContainer(sectionTitle, hasBoth, handleFilterChange);
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
                JE.requestManager.endMeasurement('person-discovery');
            }

        } catch (error) {
            // Don't mark as processed on failure so retry is possible
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted`);
                return;
            }
            console.error(`${logPrefix} Error rendering person discovery:`, error);
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
        isLoading = false;
        hasMorePages = true;
        currentPersonId = null;
        currentPagedResults = [];
        renderedCount = 0;

        currentRenderingPageKey = null;

        // Clear cached results
        cachedAllResults = [];
        JE.discoveryFilter?.resetFilterMode?.(MODULE_NAME);
    }

    /**
     * Handles page navigation
     */
    function handlePageNavigation() {
        const itemId = getPersonIdFromUrl();
        if (itemId) {
            requestAnimationFrame(() => renderPersonDiscovery());
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
