// /js/jellyseerr/person-discovery.js
// Adds "More from [Actor]" section to person detail pages using Jellyseerr API
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Person Discovery:';

    // Cache for person ID mappings (personName -> TMDB personId)
    const personIdCache = new Map();
    const personInfoCache = new Map();
    const processedPages = new Set();

    // Pagination state
    let currentPage = 1;
    let isLoading = false;
    let hasMorePages = true;
    let currentPersonId = null;
    let currentPersonName = null;

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
     */
    async function getPersonInfo(personId) {
        if (personInfoCache.has(personId)) {
            return personInfoCache.get(personId);
        }
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/person/${personId}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            if (response) {
                personInfoCache.set(personId, response);
            }
            return response;
        } catch (error) {
            return null;
        }
    }

    /**
     * Check if current page is a Person detail page
     */
    async function isPersonPage(itemId) {
        try {
            const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
            return item && item.Type === 'Person';
        } catch {
            return false;
        }
    }

    /**
     * Searches for TMDB person ID by name
     */
    async function searchTmdbPerson(personName) {
        const cacheKey = personName.toLowerCase().trim();
        if (personIdCache.has(cacheKey)) {
            return personIdCache.get(cacheKey);
        }

        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tmdb/search/person?query=${encodeURIComponent(personName)}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });

            if (response?.results?.length > 0) {
                // Find person results
                const personResults = response.results.filter(r => r.mediaType === 'person');
                if (personResults.length > 0) {
                    const exactMatch = personResults.find(r =>
                        r.name?.toLowerCase() === personName.toLowerCase()
                    );
                    const personId = exactMatch ? exactMatch.id : personResults[0].id;
                    personIdCache.set(cacheKey, personId);
                    return personId;
                }
            }
        } catch (error) {
            // Silent fail
        }
        return null;
    }

    /**
     * Fetches person credits from Jellyseerr
     */
    async function fetchPersonCredits(personId) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/person/${personId}/combined_credits`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            return response || { cast: [], crew: [] };
        } catch (error) {
            console.error(`${logPrefix} Error fetching credits:`, error);
            return { cast: [], crew: [] };
        }
    }

    /**
     * Creates cards and returns a DocumentFragment for batch DOM insertion
     */
    function createCardsFragment(results) {
        const fragment = document.createDocumentFragment();
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        const excludeRejectedItems = JE.pluginConfig?.JellyseerrExcludeRejectedItems === true;
        const seen = new Set();

        for (let i = 0; i < results.length; i++) {
            const item = results[i];

            // Deduplicate by TMDB ID
            const key = `${item.mediaType}-${item.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // Skip library items if configured
            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) {
                continue;
            }

            // Skip rejected items if configured
            if (excludeRejectedItems && item.mediaInfo?.status === 6) {
                continue;
            }

            const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
            if (!card) continue;

            // Use overflowPortraitCard to match native person page card sizing
            const classList = card.classList;
            classList.remove('portraitCard');
            classList.add('overflowPortraitCard');

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
     * Creates the section container - matching native Jellyfin person page styling
     */
    function createSectionContainer(title) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-person-discovery-section';
        section.setAttribute('data-jellyseerr-person-discovery', 'true');
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards';
        titleElement.textContent = title;
        titleElement.style.marginBottom = '1em';
        section.appendChild(titleElement);

        // Match native container: itemsContainer padded-right vertical-wrap
        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'itemsContainer padded-right vertical-wrap';
        section.appendChild(itemsContainer);

        return section;
    }

    /**
     * Loads more items for infinite scroll
     */
    async function loadMoreItems() {
        if (isLoading || !hasMorePages || !currentPersonId) return;

        isLoading = true;
        currentPage++;

        try {
            const credits = await fetchPersonCredits(currentPersonId, currentPage);
            const allResults = [...(credits.cast || []), ...(credits.crew || [])];

            hasMorePages = allResults.length >= 20;

            if (allResults.length === 0) {
                hasMorePages = false;
                isLoading = false;
                return;
            }

            const itemsContainer = document.querySelector('.jellyseerr-person-discovery-section .itemsContainer');
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
        const section = document.querySelector('.jellyseerr-person-discovery-section');
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
     * Main function to render the person discovery section
     */
    async function renderPersonDiscovery() {
        const itemId = getPersonIdFromUrl();
        if (!itemId) return;

        const pageKey = `person-${itemId}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;
        processedPages.add(pageKey);

        if (JE.pluginConfig?.JellyseerrShowPersonDiscovery === false) return;

        // Check if this is a person page
        const isPerson = await isPersonPage(itemId);
        if (!isPerson) return;

        const personInfoPromise = getPersonInfo(itemId);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();

        const [personInfo, status] = await Promise.all([personInfoPromise, statusPromise]);

        if (!status?.active || !personInfo?.name) return;

        // Get TMDB person ID
        const tmdbPersonId = personInfo.tmdbId
            ? parseInt(personInfo.tmdbId)
            : await searchTmdbPerson(personInfo.name);

        if (!tmdbPersonId) return;

        // Store for reference
        currentPersonId = tmdbPersonId;
        currentPersonName = personInfo.name;

        // Fetch credits
        const credits = await fetchPersonCredits(tmdbPersonId);
        const allResults = [...(credits.cast || []), ...(credits.crew || [])];

        console.log(`${logPrefix} Fetched ${allResults.length} credits for ${personInfo.name}`);

        if (allResults.length === 0) return;

        // Wait for page content
        await waitForPageReady();

        // Find insertion point (after the existing content) - only on ACTIVE page (not hidden)
        const detailSection = document.querySelector('.itemDetailPage:not(.hide) .detailPageContent') ||
                             document.querySelector('.itemDetailPage:not(.hide)') ||
                             document.querySelector('.page:not(.hide) .detailPageContent');

        if (!detailSection) {
            console.log(`${logPrefix} Could not find detail section to insert into`);
            return;
        }

        // Remove existing section
        const existing = document.querySelector('.jellyseerr-person-discovery-section');
        if (existing) existing.remove();

        // Create and insert section
        const sectionTitle = JE.t('discovery_more_from_person', { person: personInfo.name });
        const section = createSectionContainer(sectionTitle);
        const itemsContainer = section.querySelector('.itemsContainer');

        // Show up to 40 items (no pagination for person credits API)
        const fragment = createCardsFragment(allResults.slice(0, 40));
        if (fragment.childNodes.length === 0) {
            console.log(`${logPrefix} No cards created from results`);
            return;
        }

        itemsContainer.appendChild(fragment);
        detailSection.appendChild(section);
        console.log(`${logPrefix} Section added with ${fragment.childNodes.length} cards`);
    }

    /**
     * Wait for the page to be ready (active page only, not hidden)
     */
    function waitForPageReady() {
        return new Promise((resolve) => {
            const detailContent = document.querySelector('.itemDetailPage:not(.hide) .detailPageContent') ||
                                  document.querySelector('.itemDetailPage:not(.hide)');
            if (detailContent) {
                resolve();
                return;
            }

            const observer = new MutationObserver((mutations, obs) => {
                const content = document.querySelector('.itemDetailPage:not(.hide) .detailPageContent') ||
                               document.querySelector('.itemDetailPage:not(.hide)');
                if (content) {
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
