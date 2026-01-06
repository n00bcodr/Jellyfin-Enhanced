// /js/jellyseerr/genre-discovery.js
// Adds "More [Genre]" section to genre list pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Genre Discovery:';

    const genreInfoCache = new Map();
    const processedPages = new Set();

    // TMDB Genre ID mappings (name -> { tv: id, movie: id })
    const KNOWN_GENRES = {
        'action': { tv: 10759, movie: 28 },
        'action & adventure': { tv: 10759, movie: 28 },
        'adventure': { tv: 10759, movie: 12 },
        'animation': { tv: 16, movie: 16 },
        'comedy': { tv: 35, movie: 35 },
        'crime': { tv: 80, movie: 80 },
        'documentary': { tv: 99, movie: 99 },
        'drama': { tv: 18, movie: 18 },
        'family': { tv: 10751, movie: 10751 },
        'fantasy': { tv: 10765, movie: 14 },
        'history': { tv: 36, movie: 36 },
        'horror': { tv: 9648, movie: 27 },
        'kids': { tv: 10762, movie: 10751 },
        'music': { tv: 10402, movie: 10402 },
        'mystery': { tv: 9648, movie: 9648 },
        'news': { tv: 10763, movie: null },
        'reality': { tv: 10764, movie: null },
        'romance': { tv: 10749, movie: 10749 },
        'sci-fi': { tv: 10765, movie: 878 },
        'sci-fi & fantasy': { tv: 10765, movie: 878 },
        'science fiction': { tv: 10765, movie: 878 },
        'soap': { tv: 10766, movie: null },
        'talk': { tv: 10767, movie: null },
        'thriller': { tv: 10768, movie: 53 },
        'tv movie': { tv: null, movie: 10770 },
        'war': { tv: 10768, movie: 10752 },
        'war & politics': { tv: 10768, movie: 10752 },
        'western': { tv: 37, movie: 37 }
    };

    // Pagination state
    let currentPage = 1;
    let isLoading = false;
    let hasMorePages = true;
    let currentGenreIds = null;
    let currentGenreName = null;

    /**
     * Extracts genre ID from the current URL
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
     */
    async function getGenreInfo(genreId) {
        if (genreInfoCache.has(genreId)) {
            return genreInfoCache.get(genreId);
        }
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/genre/${genreId}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            if (response) {
                genreInfoCache.set(genreId, response);
            }
            return response;
        } catch (error) {
            return null;
        }
    }

    /**
     * Gets TMDB genre IDs from genre name
     */
    function getTmdbGenreIds(genreName) {
        const cacheKey = genreName.toLowerCase().trim();
        if (KNOWN_GENRES[cacheKey]) {
            return KNOWN_GENRES[cacheKey];
        }
        // Try partial matches
        for (const [key, ids] of Object.entries(KNOWN_GENRES)) {
            if (cacheKey.includes(key) || key.includes(cacheKey)) {
                return ids;
            }
        }
        return null;
    }

    /**
     * Fetches discover results by genre
     */
    async function fetchGenreDiscover(genreIds, page = 1) {
        const promises = [];

        if (genreIds.tv) {
            promises.push(
                ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/tv/genre/${genreIds.tv}?page=${page}`),
                    headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                    dataType: 'json'
                }).catch(() => ({ results: [], totalPages: 1 }))
            );
        }

        if (genreIds.movie) {
            promises.push(
                ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/movies/genre/${genreIds.movie}?page=${page}`),
                    headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                    dataType: 'json'
                }).catch(() => ({ results: [], totalPages: 1 }))
            );
        }

        const results = await Promise.all(promises);
        return {
            results: results.flatMap(r => r?.results || []),
            totalPages: Math.max(...results.map(r => r?.totalPages || 1))
        };
    }

    /**
     * Creates cards and returns a DocumentFragment
     */
    function createCardsFragment(results) {
        const fragment = document.createDocumentFragment();
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        const seen = new Set();

        for (let i = 0; i < results.length; i++) {
            const item = results[i];

            const key = `${item.mediaType}-${item.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) {
                continue;
            }

            const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
            if (!card) continue;

            const classList = card.classList;
            classList.remove('overflowPortraitCard');
            classList.add('portraitCard');

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
     * Creates the section container
     */
    function createSectionContainer(title) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-genre-discovery-section padded-left padded-right';
        section.setAttribute('data-jellyseerr-genre-discovery', 'true');
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
        if (isLoading || !hasMorePages || !currentGenreIds) return;

        isLoading = true;
        currentPage++;

        try {
            const discoverResults = await fetchGenreDiscover(currentGenreIds, currentPage);
            hasMorePages = currentPage < discoverResults.totalPages;

            if (discoverResults.results.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            const itemsContainer = document.querySelector('.jellyseerr-genre-discovery-section .itemsContainer');
            if (itemsContainer) {
                const fragment = createCardsFragment(discoverResults.results);
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
        const section = document.querySelector('.jellyseerr-genre-discovery-section');
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
     * Main function to render the genre discovery section
     */
    async function renderGenreDiscovery() {
        const genreId = getGenreIdFromUrl();
        if (!genreId) return;

        const pageKey = `genre-${genreId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;
        processedPages.add(pageKey);

        if (JE.pluginConfig?.JellyseerrShowGenreDiscovery === false) return;

        const genreInfoPromise = getGenreInfo(genreId);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
        const pageReadyPromise = waitForPageReady();

        const [genreInfo, status] = await Promise.all([genreInfoPromise, statusPromise]);

        if (!status?.active || !genreInfo?.name) return;

        const tmdbGenreIds = getTmdbGenreIds(genreInfo.name);
        if (!tmdbGenreIds || (!tmdbGenreIds.tv && !tmdbGenreIds.movie)) return;

        // Reset pagination state
        currentPage = 1;
        isLoading = false;
        hasMorePages = true;
        currentGenreIds = tmdbGenreIds;
        currentGenreName = genreInfo.name;

        const discoverPromise = fetchGenreDiscover(tmdbGenreIds);
        const [discoverResults] = await Promise.all([discoverPromise, pageReadyPromise]);

        hasMorePages = currentPage < discoverResults.totalPages;

        if (discoverResults.results.length === 0) return;

        // Find container only on ACTIVE page (not hidden)
        const listPage = document.querySelector('.page:not(.hide) .itemsContainer') ||
                         document.querySelector('.libraryPage:not(.hide) .itemsContainer');
        if (!listPage) return;

        const existing = document.querySelector('.jellyseerr-genre-discovery-section');
        if (existing) existing.remove();

        const section = createSectionContainer(`More ${genreInfo.name}`);
        const itemsContainer = section.querySelector('.itemsContainer');

        const fragment = createCardsFragment(discoverResults.results.slice(0, 20));
        if (fragment.childNodes.length === 0) return;

        itemsContainer.appendChild(fragment);

        const parentContainer = listPage.closest('.verticalSection') || listPage.parentElement;
        if (parentContainer?.parentElement) {
            parentContainer.parentElement.appendChild(section);

            if (hasMorePages) {
                setupInfiniteScroll();
            }
        }
    }

    /**
     * Wait for the page to be ready (active page only, not hidden)
     */
    function waitForPageReady() {
        return new Promise((resolve) => {
            const listContainer = document.querySelector('.page:not(.hide) .itemsContainer') ||
                                  document.querySelector('.libraryPage:not(.hide) .itemsContainer');
            if (listContainer?.children.length > 0) {
                resolve();
                return;
            }

            const observer = new MutationObserver((mutations, obs) => {
                const container = document.querySelector('.page:not(.hide) .itemsContainer') ||
                                  document.querySelector('.libraryPage:not(.hide) .itemsContainer');
                if (container?.children.length > 0) {
                    obs.disconnect();
                    resolve();
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
        });
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
            processedPages.clear();
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
