// /js/jellyseerr/person-discovery.js
// Adds "More from [Actor]" section using Jellyseerr API
// Fixes missing Shows/Episodes sections (jellyfin-web ItemCounts bug workaround)
(function(JE) {
    'use strict';

    const LOG_PREFIX = '🪼 JE Person:';
    const ITEMS_PER_PAGE = 40;

    // Caches
    const personIdCache = new Map();
    const personInfoCache = new Map();
    const processedPages = new Set();
    const fixProcessedPages = new Set();

    // Pagination state for infinite scroll
    let isLoading = false;
    let hasMoreItems = true;
    let allPersonCredits = [];
    let currentDisplayCount = 0;

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    function getPersonIdFromUrl() {
        const hash = window.location.hash;
        if (!hash.includes('/details') || !hash.includes('id=')) return null;
        try {
            return new URLSearchParams(hash.split('?')[1]).get('id');
        } catch {
            return null;
        }
    }

    function getServerIdFromUrl() {
        try {
            return new URLSearchParams(window.location.hash.split('?')[1]).get('serverId');
        } catch {
            return null;
        }
    }

    async function isPersonPage(itemId) {
        try {
            const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
            return item?.Type === 'Person';
        } catch {
            return false;
        }
    }

    function waitForPageReady() {
        return new Promise((resolve) => {
            const selector = '.itemDetailPage:not(.hide) .detailPageContent, .itemDetailPage:not(.hide)';
            if (document.querySelector(selector)) {
                resolve();
                return;
            }

            const observer = new MutationObserver((_, obs) => {
                if (document.querySelector(selector)) {
                    obs.disconnect();
                    resolve();
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
        });
    }

    // =========================================================================
    // API FUNCTIONS
    // =========================================================================

    async function getPersonInfo(personId) {
        if (personInfoCache.has(personId)) return personInfoCache.get(personId);

        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/person/${personId}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
            if (response) personInfoCache.set(personId, response);
            return response;
        } catch {
            return null;
        }
    }

    async function searchTmdbPerson(personName) {
        const cacheKey = personName.toLowerCase().trim();
        if (personIdCache.has(cacheKey)) return personIdCache.get(cacheKey);

        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tmdb/search/person?query=${encodeURIComponent(personName)}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });

            const personResults = response?.results?.filter(r => r.mediaType === 'person') || [];
            if (personResults.length > 0) {
                const exactMatch = personResults.find(r => r.name?.toLowerCase() === personName.toLowerCase());
                const personId = exactMatch?.id || personResults[0].id;
                personIdCache.set(cacheKey, personId);
                return personId;
            }
        } catch {}
        return null;
    }

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
            console.error(`${LOG_PREFIX} Error fetching credits:`, error);
            return { cast: [], crew: [] };
        }
    }

    async function queryItemsByPerson(personId, itemTypes) {
        try {
            const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                PersonIds: personId,
                IncludeItemTypes: itemTypes,
                Recursive: true,
                Fields: 'PrimaryImageAspectRatio',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Limit: 100
            });
            return result?.Items || [];
        } catch (error) {
            console.error(`${LOG_PREFIX} Error querying ${itemTypes}:`, error);
            return [];
        }
    }

    // =========================================================================
    // JELLYSEERR PERSON DISCOVERY SECTION
    // =========================================================================

    function interleaveArrays(arr1, arr2) {
        const result = [];
        const maxLen = Math.max(arr1.length, arr2.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < arr1.length) result.push(arr1[i]);
            if (i < arr2.length) result.push(arr2[i]);
        }
        return result;
    }

    function createCardsFragment(results) {
        const fragment = document.createDocumentFragment();
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        const seen = new Set();

        for (const item of results) {
            const key = `${item.mediaType}-${item.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) continue;

            const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
            if (!card) continue;

            card.classList.remove('portraitCard');
            card.classList.add('overflowPortraitCard');

            const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
            if (jellyfinMediaId) {
                card.setAttribute('data-library-item', 'true');
                card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
                card.classList.add('jellyseerr-card-in-library');

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

    function createDiscoverySection(title) {
        const section = document.createElement('div');
        section.className = 'verticalSection jellyseerr-person-discovery-section';
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

        const h2 = document.createElement('h2');
        h2.className = 'sectionTitle sectionTitle-cards';
        h2.textContent = title;
        h2.style.marginBottom = '1em';
        section.appendChild(h2);

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'itemsContainer padded-right vertical-wrap';
        section.appendChild(itemsContainer);

        return section;
    }

    function loadMoreItems() {
        if (isLoading || !hasMoreItems || !allPersonCredits.length) return;

        isLoading = true;
        const container = document.querySelector('.jellyseerr-person-discovery-section .itemsContainer');
        if (!container) {
            isLoading = false;
            return;
        }

        const nextBatch = allPersonCredits.slice(currentDisplayCount, currentDisplayCount + ITEMS_PER_PAGE);
        if (!nextBatch.length) {
            hasMoreItems = false;
            isLoading = false;
            return;
        }

        const fragment = createCardsFragment(nextBatch);
        if (fragment.childNodes.length) {
            container.appendChild(fragment);
            currentDisplayCount += nextBatch.length;
        }

        hasMoreItems = currentDisplayCount < allPersonCredits.length;
        isLoading = false;
    }

    function setupInfiniteScroll() {
        const section = document.querySelector('.jellyseerr-person-discovery-section');
        if (!section) return;

        section.querySelector('.jellyseerr-scroll-sentinel')?.remove();

        const sentinel = document.createElement('div');
        sentinel.className = 'jellyseerr-scroll-sentinel';
        sentinel.style.cssText = 'height:20px;width:100%';
        section.appendChild(sentinel);

        new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMoreItems && !isLoading) {
                loadMoreItems();
            }
        }, { rootMargin: '200px' }).observe(sentinel);
    }

    async function renderPersonDiscovery() {
        const itemId = getPersonIdFromUrl();
        if (!itemId) return;

        const pageKey = `discovery-${itemId}`;
        if (processedPages.has(pageKey)) return;
        processedPages.add(pageKey);

        if (JE.pluginConfig?.JellyseerrShowPersonDiscovery === false) return;
        if (!await isPersonPage(itemId)) return;

        const [personInfo, status] = await Promise.all([
            getPersonInfo(itemId),
            JE.jellyseerrAPI?.checkUserStatus()
        ]);

        if (!status?.active || !personInfo?.name) return;

        const tmdbPersonId = personInfo.tmdbId
            ? parseInt(personInfo.tmdbId)
            : await searchTmdbPerson(personInfo.name);

        if (!tmdbPersonId) return;

        const credits = await fetchPersonCredits(tmdbPersonId);
        const allCredits = [...(credits.cast || []), ...(credits.crew || [])];
        const movies = allCredits.filter(c => c.mediaType === 'movie');
        const tvShows = allCredits.filter(c => c.mediaType === 'tv');

        allPersonCredits = interleaveArrays(movies, tvShows);
        currentDisplayCount = 0;
        hasMoreItems = allPersonCredits.length > ITEMS_PER_PAGE;

        console.log(`${LOG_PREFIX} ${allPersonCredits.length} credits (${movies.length} movies, ${tvShows.length} TV) for ${personInfo.name}`);

        if (!allPersonCredits.length) return;

        await waitForPageReady();

        const detailSection = document.querySelector('.itemDetailPage:not(.hide) .detailPageContent') ||
                             document.querySelector('.itemDetailPage:not(.hide)');
        if (!detailSection) return;

        document.querySelector('.jellyseerr-person-discovery-section')?.remove();

        const section = createDiscoverySection(JE.t('discovery_more_from_person', { person: personInfo.name }));
        const container = section.querySelector('.itemsContainer');

        const firstBatch = allPersonCredits.slice(0, ITEMS_PER_PAGE);
        const fragment = createCardsFragment(firstBatch);
        if (!fragment.childNodes.length) return;

        currentDisplayCount = firstBatch.length;
        container.appendChild(fragment);
        detailSection.appendChild(section);

        if (hasMoreItems) setupInfiniteScroll();
    }

    // =========================================================================
    // NATIVE SECTIONS FIX (Shows/Episodes)
    // =========================================================================

    function nativeSectionExists(type) {
        const section = document.querySelector(`.verticalSection[data-type="${type}"]`);
        return section && !section.classList.contains('hide');
    }

    function createNativeSection(title, type, items, personId, serverId) {
        const section = document.createElement('div');
        section.className = 'verticalSection';
        section.setAttribute('data-type', type);
        section.setAttribute('data-je-fix', 'true');

        const titleContainer = document.createElement('div');
        titleContainer.className = 'sectionTitleContainer sectionTitleContainer-cards';

        const h2 = document.createElement('h2');
        h2.className = 'sectionTitle sectionTitle-cards';
        h2.textContent = title;
        titleContainer.appendChild(h2);

        if (items.length >= 10) {
            const moreLink = document.createElement('a');
            moreLink.setAttribute('is', 'emby-linkbutton');
            moreLink.className = 'clearLink';
            moreLink.style.cssText = 'margin-left:1em;vertical-align:middle;';
            moreLink.href = `#!/list?type=${type}&personId=${personId}&serverId=${serverId}`;

            const moreButton = document.createElement('button');
            moreButton.setAttribute('is', 'emby-button');
            moreButton.type = 'button';
            moreButton.className = 'raised more raised-mini noIcon';
            moreButton.textContent = 'More';
            moreLink.appendChild(moreButton);
            titleContainer.appendChild(moreLink);
        }

        section.appendChild(titleContainer);

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'itemsContainer padded-right vertical-wrap';

        const displayItems = items.slice(0, 10);
        const cardBuilder = window.cardBuilder || window.CardBuilder;

        if (cardBuilder?.getCardsHtml) {
            try {
                itemsContainer.innerHTML = cardBuilder.getCardsHtml({
                    items: displayItems,
                    shape: type === 'Episode' ? 'overflowBackdrop' : 'overflowPortrait',
                    showTitle: true,
                    showYear: type === 'Series',
                    showParentTitle: type === 'Episode',
                    centerText: true,
                    overlayMoreButton: type === 'Series',
                    overlayPlayButton: type === 'Episode'
                });
            } catch {
                itemsContainer.innerHTML = createFallbackCards(displayItems, type);
            }
        } else {
            itemsContainer.innerHTML = createFallbackCards(displayItems, type);
        }

        section.appendChild(itemsContainer);
        window.imageLoader?.lazyChildren(itemsContainer);

        return section;
    }

    function createFallbackCards(items, type) {
        const isEpisode = type === 'Episode';
        const cardClass = isEpisode ? 'overflowBackdropCard backdropCard' : 'overflowPortraitCard portraitCard';
        const padderClass = isEpisode ? 'cardPadder-backdrop' : 'cardPadder-portrait';

        return items.map(item => {
            const imageTag = item.ImageTags?.Primary || item.SeriesPrimaryImageTag;
            const imageId = item.ImageTags?.Primary ? item.Id : item.SeriesId;
            const imgUrl = imageTag && imageId
                ? ApiClient.getScaledImageUrl(imageId, { type: 'Primary', maxWidth: isEpisode ? 300 : 200, tag: imageTag })
                : '';

            const title = item.Name || '';
            const subtitle = isEpisode ? (item.SeriesName || '') : (item.ProductionYear || '');
            const imgHtml = imgUrl
                ? `<div class="cardImageContainer cardImageContainer-dynamic" style="background-image:url('${imgUrl}')"></div>`
                : `<div class="cardImageContainer cardImageContainer-dynamic defaultCardBackground"></div>`;

            return `
                <a href="#!/details?id=${item.Id}&serverId=${item.ServerId}" class="card ${cardClass}" data-id="${item.Id}">
                    <div class="cardBox">
                        <div class="cardScalable">
                            <div class="cardPadder ${padderClass}"></div>
                            <div class="cardContent">${imgHtml}</div>
                        </div>
                        <div class="cardFooter">
                            <div class="cardText cardTextCentered">${title}</div>
                            ${subtitle ? `<div class="cardText cardText-secondary cardTextCentered">${subtitle}</div>` : ''}
                        </div>
                    </div>
                </a>`;
        }).join('');
    }

    function findContentArea() {
        return document.querySelector('.itemDetailPage:not(.hide) #childrenContent') ||
               document.querySelector('.itemDetailPage:not(.hide) .detailPageContent');
    }

    function insertSection(contentArea, section, afterType) {
        const afterSection = contentArea.querySelector(`.verticalSection[data-type="${afterType}"]`);
        if (afterSection?.nextSibling) {
            contentArea.insertBefore(section, afterSection.nextSibling);
        } else if (afterSection) {
            contentArea.appendChild(section);
        } else {
            contentArea.insertBefore(section, contentArea.firstChild);
        }
    }

    async function fixMissingPersonSections(personId) {
        const fixKey = `fix-${personId}`;
        if (fixProcessedPages.has(fixKey)) return;
        fixProcessedPages.add(fixKey);

        if (!await isPersonPage(personId)) return;

        await waitForPageReady();
        await new Promise(resolve => setTimeout(resolve, 300));

        const contentArea = findContentArea();
        if (!contentArea) return;

        const serverId = getServerIdFromUrl();

        // Fix Shows section
        if (!nativeSectionExists('Series')) {
            const items = await queryItemsByPerson(personId, 'Series');
            if (items.length) {
                console.log(`${LOG_PREFIX} Injecting Shows section (${items.length} items)`);
                const section = createNativeSection('Shows', 'Series', items, personId, serverId || items[0]?.ServerId);
                insertSection(contentArea, section, 'Movie');
            }
        }

        // Fix Episodes section
        if (!nativeSectionExists('Episode')) {
            const items = await queryItemsByPerson(personId, 'Episode');
            if (items.length) {
                console.log(`${LOG_PREFIX} Injecting Episodes section (${items.length} items)`);
                const section = createNativeSection('Episodes', 'Episode', items, personId, serverId || items[0]?.ServerId);
                insertSection(contentArea, section, 'Series');
            }
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function handlePageNavigation() {
        const itemId = getPersonIdFromUrl();
        if (itemId) {
            requestAnimationFrame(() => {
                renderPersonDiscovery();
                fixMissingPersonSections(itemId);
            });
        }
    }

    function initialize() {
        window.addEventListener('hashchange', () => {
            processedPages.clear();
            fixProcessedPages.clear();
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
