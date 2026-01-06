// /js/jellyseerr/tag-discovery.js
// Adds "More [Tag]" section to tag list pages using Jellyseerr API keywords
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Tag Discovery:';

    const keywordIdCache = new Map();
    const processedPages = new Set();

    // Pagination state
    let currentPage = 1;
    let isLoading = false;
    let hasMorePages = true;
    let currentKeywordId = null;
    let currentTagName = null;

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
            return params.get('tag');
        } catch (error) {
            return null;
        }
    }

    /**
     * Searches for TMDB keyword ID by name
     */
    async function searchTmdbKeyword(keywordName) {
        const cacheKey = keywordName.toLowerCase().trim();
        if (keywordIdCache.has(cacheKey)) {
            return keywordIdCache.get(cacheKey);
        }

        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(keywordName)}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });

            if (response?.results?.length > 0) {
                const exactMatch = response.results.find(r =>
                    r.name?.toLowerCase() === keywordName.toLowerCase()
                );
                const keywordId = exactMatch ? exactMatch.id : response.results[0].id;
                keywordIdCache.set(cacheKey, keywordId);
                return keywordId;
            }
        } catch (error) {
            // Silent fail
        }
        return null;
    }

    /**
     * Fetches discover results by keyword
     */
    async function fetchKeywordDiscover(keywordId, page = 1) {
        try {
            const [tvResponse, movieResponse] = await Promise.all([
                ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/tv/keyword/${keywordId}?page=${page}`),
                    headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                    dataType: 'json'
                }).catch(() => ({ results: [], totalPages: 1 })),
                ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/discover/movies/keyword/${keywordId}?page=${page}`),
                    headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                    dataType: 'json'
                }).catch(() => ({ results: [], totalPages: 1 }))
            ]);

            return {
                results: [
                    ...(tvResponse?.results || []),
                    ...(movieResponse?.results || [])
                ],
                totalPages: Math.max(tvResponse?.totalPages || 1, movieResponse?.totalPages || 1)
            };
        } catch (error) {
            return { results: [], totalPages: 1 };
        }
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
        section.className = 'verticalSection jellyseerr-tag-discovery-section padded-left padded-right';
        section.setAttribute('data-jellyseerr-tag-discovery', 'true');
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
        if (isLoading || !hasMorePages || !currentKeywordId) return;

        isLoading = true;
        currentPage++;

        try {
            const discoverResults = await fetchKeywordDiscover(currentKeywordId, currentPage);
            hasMorePages = currentPage < discoverResults.totalPages;

            if (discoverResults.results.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            const itemsContainer = document.querySelector('.jellyseerr-tag-discovery-section .itemsContainer');
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
        const section = document.querySelector('.jellyseerr-tag-discovery-section');
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
     * Main function to render the tag discovery section
     */
    async function renderTagDiscovery() {
        const tagName = getTagFromUrl();
        if (!tagName) return;

        const pageKey = `tag-${tagName}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;
        processedPages.add(pageKey);

        if (JE.pluginConfig?.JellyseerrShowTagDiscovery === false) return;

        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
        const pageReadyPromise = waitForPageReady();

        const status = await statusPromise;
        if (!status?.active) return;

        // Search for TMDB keyword ID
        const tmdbKeywordId = await searchTmdbKeyword(tagName);
        if (!tmdbKeywordId) return;

        // Reset pagination state
        currentPage = 1;
        isLoading = false;
        hasMorePages = true;
        currentKeywordId = tmdbKeywordId;
        currentTagName = tagName;

        const discoverPromise = fetchKeywordDiscover(tmdbKeywordId);
        const [discoverResults] = await Promise.all([discoverPromise, pageReadyPromise]);

        hasMorePages = currentPage < discoverResults.totalPages;

        if (discoverResults.results.length === 0) return;

        // Find container only on ACTIVE page (not hidden)
        const listPage = document.querySelector('.page:not(.hide) .itemsContainer') ||
                         document.querySelector('.libraryPage:not(.hide) .itemsContainer');
        if (!listPage) return;

        const existing = document.querySelector('.jellyseerr-tag-discovery-section');
        if (existing) existing.remove();

        // Capitalize tag name for display
        const displayName = tagName.charAt(0).toUpperCase() + tagName.slice(1);
        const section = createSectionContainer(`More "${displayName}"`);
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
