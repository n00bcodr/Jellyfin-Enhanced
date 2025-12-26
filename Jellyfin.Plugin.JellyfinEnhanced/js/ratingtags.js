// /js/ratingtags.js
// Jellyfin Rating Tags - Display IMDB ratings on posters
(function(JE) {
    'use strict';

    JE.initializeRatingTags = function() {
        if (!JE.currentSettings.ratingTagsEnabled) {
            console.log('🪼 Jellyfin Enhanced: Rating tags are off in settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Rating Tags:';
        const containerClass = 'rating-overlay-container';
        const tagClass = 'rating-tag';
        const CACHE_KEY = 'JellyfinEnhanced-ratingTagsCache';
        const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-ratingTagsCacheTimestamp';
        const CACHE_TTL = (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
        const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season']);
        const MUTATION_DEBOUNCE = 400;

        // CSS selectors for elements that should NOT have rating tags applied.
        const IGNORE_SELECTORS = [
            '#itemDetailPage .infoWrapper .cardImageContainer',
            '#itemDetailPage #castCollapsible .cardImageContainer',
            '#indexPage .verticalSection.MyMedia .cardImageContainer',
            '.formDialog .cardImageContainer',
            '#itemDetailPage .chapterCardImageContainer',
            // Admin/dashboard pages
            '#pluginsPage .cardImageContainer',
            '#pluginsPage .card',
            '#pluginCatalogPage .cardImageContainer',
            '#pluginCatalogPage .card',
            '#devicesPage .cardImageContainer',
            '#devicesPage .card',
            '#mediaLibraryPage .cardImageContainer',
            '#mediaLibraryPage .card'
        ];

        // Add search page to ignore list if configured (Gelato compatibility)
        if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
            IGNORE_SELECTORS.push('#searchPage .cardImageContainer');
        }

        let ratingCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.rating = Hot.rating || new Map();

        let processedElements = new WeakSet();
        let requestQueue = [];
        let isProcessingQueue = false;
        const queuedItemIds = new Set();
        let mutationDebounceTimer = null;

        const visibilityObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => { if (entry.isIntersecting) processElement(entry.target, true); });
        }, { rootMargin: '200px', threshold: 0.1 });

        function saveCache() {
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(ratingCache)); }
            catch (e) { console.warn(`${logPrefix} Failed to save cache`, e); }
        }

        function cleanupOldCaches() {
            // Clean up old cache keys
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('ratingTagsCache-') || key === 'ratingTagsCache' || key === 'ratingTagsCacheTimestamp')) {
                    if (key !== CACHE_KEY && key !== CACHE_TIMESTAMP_KEY) {
                        keysToRemove.push(key);
                    }
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));

            const serverClearTimestamp = JE.pluginConfig?.ClearLocalStorageTimestamp || 0;
            const localCacheTimestamp = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || '0', 10);
            if (serverClearTimestamp > localCacheTimestamp) {
                console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
                localStorage.removeItem(CACHE_KEY);
                localStorage.setItem(CACHE_TIMESTAMP_KEY, serverClearTimestamp.toString());
                ratingCache = {};
                if (JE._hotCache?.rating) JE._hotCache.rating.clear();
            }
        }

        function getUserId() { return ApiClient.getCurrentUserId(); }

        async function fetchItemRating(userId, itemId, itemType) {
            try {
                const result = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                        Ids: itemId,
                        Fields: 'CommunityRating,CriticRating'
                    }),
                    dataType: 'json'
                });
                const item = result?.Items?.[0];
                if (!item) return null;

                // For Series/Season, get the rating from the series itself
                let sourceItem = item;
                if (itemType === 'Season' && item.SeriesId) {
                    try {
                        const seriesResult = await ApiClient.ajax({
                            type: 'GET',
                            url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                                Ids: item.SeriesId,
                                Fields: 'CommunityRating,CriticRating'
                            }),
                            dataType: 'json'
                        });
                        sourceItem = seriesResult?.Items?.[0] || item;
                    } catch (e) {
                        console.warn(`${logPrefix} Failed to fetch series rating for season`, e);
                    }
                }

                // Use CommunityRating (IMDB) if available, otherwise CriticRating
                const rating = sourceItem.CommunityRating || sourceItem.CriticRating;
                return rating ? parseFloat(rating).toFixed(1) : null;
            } catch (e) {
                console.warn(`${logPrefix} Failed to fetch rating for ${itemId}`, e);
                return null;
            }
        }

        function shouldIgnoreElement(el) {
            return IGNORE_SELECTORS.some(sel => el.matches(sel) || el.closest(sel));
        }

        function getItemIdFromElement(el) {
            const card = el.closest('[data-id]');
            return card?.getAttribute('data-id') || null;
        }

        function getItemTypeFromElement(el) {
            const card = el.closest('[data-type]');
            return card?.getAttribute('data-type') || null;
        }

        async function processElement(el, isVisible = false) {
            if (processedElements.has(el)) return;
            if (shouldIgnoreElement(el)) return;

            const itemId = getItemIdFromElement(el);
            const itemType = getItemTypeFromElement(el);

            if (!itemId || !itemType || !MEDIA_TYPES.has(itemType)) return;

            processedElements.add(el);

            // Always process, regardless of visibility
            // Check hot cache first
            if (ratingCache[itemId]) {
                applyRatingTag(el, ratingCache[itemId]);
                return;
            }

            // Queue for fetching
            if (!queuedItemIds.has(itemId)) {
                queuedItemIds.add(itemId);
                requestQueue.push({ el, itemId, itemType });
                if (!isProcessingQueue) {
                    processQueue();
                }
            }
        }

        async function processQueue() {
            if (isProcessingQueue || requestQueue.length === 0) return;
            isProcessingQueue = true;

            const batch = requestQueue.splice(0, 5); // Process 5 at a time
            const userId = getUserId();

            await Promise.all(batch.map(async ({ el, itemId, itemType }) => {
                const rating = await fetchItemRating(userId, itemId, itemType);

                ratingCache[itemId] = rating;
                Hot.rating.set(itemId, rating);

                if (rating) {
                    applyRatingTag(el, rating);
                }
            }));

            saveCache();
            isProcessingQueue = false;

            if (requestQueue.length > 0) {
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => processQueue(), { timeout: 100 });
                } else {
                    setTimeout(processQueue, 100);
                }
            }
        }

        function applyRatingTag(el, rating) {
            if (!rating) return;

            // Remove existing tag if present
            const existingContainer = el.querySelector(`.${containerClass}`);
            if (existingContainer) {
                existingContainer.remove();
            }

            const container = document.createElement('div');
            container.className = containerClass;

            const tag = document.createElement('div');
            tag.className = tagClass;

            // Create star icon and rating text
            const starIcon = document.createElement('span');
            starIcon.className = 'material-icons rating-star-icon';
            starIcon.textContent = 'star';
            starIcon.style.fontSize = '14px';
            starIcon.style.marginRight = '2px';
            starIcon.style.verticalAlign = 'middle';

            const ratingText = document.createElement('span');
            ratingText.textContent = rating;
            ratingText.style.verticalAlign = 'middle';

            tag.appendChild(starIcon);
            tag.appendChild(ratingText);
            container.appendChild(tag);

            el.appendChild(container);
        }

        function debouncedScan() {
            if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
            mutationDebounceTimer = setTimeout(scanAndProcess, MUTATION_DEBOUNCE);
        }

        function scanAndProcess() {
            // Check if feature is still enabled before processing
            if (!JE.currentSettings?.ratingTagsEnabled) {
                return;
            }
            document.querySelectorAll('.cardImageContainer').forEach(el => processElement(el));
        }

        function observeDOM() {
            const observer = new MutationObserver(() => {
                // Check if feature is still enabled before processing
                if (!JE.currentSettings?.ratingTagsEnabled) {
                    return;
                }
                debouncedScan();
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // Periodic cache persistence
            setInterval(saveCache, 120000);
        }

        function injectCSS() {
            const position = JE.pluginConfig?.RatingTagsPosition || 'bottom-right';
            const style = document.createElement('style');
            style.id = 'jellyfin-enhanced-rating-tags-css';
            style.textContent = `
                .${containerClass} {
                    position: absolute;
                    ${position.includes('top') ? 'top: 8px;' : 'bottom: 8px;'}
                    ${position.includes('left') ? 'left: 8px;' : 'right: 8px;'}
                    z-index: 10;
                    pointer-events: none;
                }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    padding: 4px 8px;
                    background: rgba(0, 0, 0, 0.8);
                    color: #ffc107;
                    font-size: 13px;
                    font-weight: 600;
                    border-radius: 4px;
                    backdrop-filter: blur(4px);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                }

                .rating-star-icon {
                    color: #ffc107 !important;
                }

                .layout-mobile .${tagClass} {
                    padding: 2px 5px;
                    font-size: 8px;
                }
                .layout-mobile .${tagClass} .rating-star-icon {
                    font-size: 10px !important;
                    margin-right: 1px !important;
                }

                @media (max-width: 768px) {
                    .${tagClass} {
                        padding: 3px 6px;
                        font-size: 12px;
                    }
                    .${tagClass} .rating-star-icon {
                        font-size: 12px !important;
                        margin-right: 1px !important;
                    }
                }

                @media (max-width: 480px) {
                    .${containerClass} {
                        ${position.includes('top') ? 'top: 4px;' : 'bottom: 4px;'}
                        ${position.includes('left') ? 'left: 4px;' : 'right: 4px;'}
                    }
                    .${tagClass} {
                        padding: 2px 4px;
                        font-size: clamp(10px, 2vw, 11px);
                        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
                    }
                    .${tagClass} .rating-star-icon {
                        font-size: clamp(10px, 2.5vw, 11px) !important;
                        margin-right: 0.5px !important;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        function initialize() {
            console.log(`${logPrefix} Starting...`);
            cleanupOldCaches();
            injectCSS();

            // Initial scan with delay to allow DOM to settle
            setTimeout(scanAndProcess, 500);

            // Observe for new elements
            observeDOM();

            console.log(`${logPrefix} Initialized successfully.`);
        }

        initialize();
    };

    JE.reinitializeRatingTags = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Rating Tags:';
        console.log(`${logPrefix} Re-initializing...`);

        // Always remove existing tags first
        document.querySelectorAll('.rating-overlay-container').forEach(el => el.remove());

        if (!JE.currentSettings.ratingTagsEnabled) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        // Trigger a fresh initialization which will set up everything with current settings
        JE.initializeRatingTags();
    };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
