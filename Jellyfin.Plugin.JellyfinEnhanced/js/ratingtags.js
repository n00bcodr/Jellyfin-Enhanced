// /js/ratingtags.js
// Jellyfin Rating Tags - Display TMDB and Rotten Tomato ratings on posters
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

        function normalizeCriticPercent(raw) {
            if (raw === null || raw === undefined) return null;
            const num = Number(raw);
            if (!Number.isFinite(num)) return null;
            const percent = num <= 10 ? Math.round(num * 10) : Math.round(num);
            return Math.max(0, Math.min(100, percent));
        }

        function getCachedEntry(itemId) {
            const entry = ratingCache[itemId] ?? Hot.rating.get(itemId);
            if (!entry) return null;
            if (typeof entry === 'string' || typeof entry === 'number') {
                return { tmdb: String(entry), critic: null };
            }
            if (typeof entry === 'object') {
                return {
                    tmdb: entry.tmdb ?? null,
                    critic: entry.critic ?? null
                };
            }
            return null;
        }

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

        async function fetchItemRatings(userId, itemId, itemType) {
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
                if (!item) return { tmdb: null, critic: null };

                // For Series/Season/Episode, get the rating from the series itself when available
                let sourceItem = item;
                if ((itemType === 'Season' || itemType === 'Episode') && item.SeriesId) {
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
                        console.warn(`${logPrefix} Failed to fetch series rating for ${itemType.toLowerCase()}`, e);
                    }
                }

                const tmdbRating = sourceItem.CommunityRating != null
                    ? parseFloat(sourceItem.CommunityRating).toFixed(1)
                    : null;

                const criticPercent = normalizeCriticPercent(sourceItem.CriticRating);

                return {
                    tmdb: tmdbRating,
                    critic: criticPercent
                };
            } catch (e) {
                console.warn(`${logPrefix} Failed to fetch rating for ${itemId}`, e);
                return { tmdb: null, critic: null };
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
            const cached = getCachedEntry(itemId);
            if (cached) {
                if (cached.tmdb || cached.critic !== null) {
                    applyRatingTag(el, cached);
                }
                if (cached.critic !== null && cached.tmdb) {
                    return;
                }
                // fall through to fetch to upgrade missing critic/tmdb
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
                const rating = await fetchItemRatings(userId, itemId, itemType);

                ratingCache[itemId] = rating;
                Hot.rating.set(itemId, rating);

                if (rating.tmdb || rating.critic !== null) {
                    applyRatingTag(el, rating);
                }
            }));

            if (JE._cacheManager) JE._cacheManager.markDirty();
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
            if (!rating || (!rating.tmdb && rating.critic === null)) return;

            const existingContainer = el.querySelector(`.${containerClass}`);
            if (existingContainer) existingContainer.remove();

            const container = document.createElement('div');
            container.className = containerClass;

            if (rating.critic !== null) {
                const criticTag = document.createElement('div');
                criticTag.className = `${tagClass} rating-tag-critic`;

                const icon = document.createElement('span');
                icon.className = `rating-tomato-icon ${rating.critic < 60 ? 'rotten' : 'fresh'}`;
                const text = document.createElement('span');
                text.className = 'rating-text';
                text.textContent = `${rating.critic}%`;

                criticTag.appendChild(icon);
                criticTag.appendChild(text);
                container.appendChild(criticTag);
            }

            if (rating.tmdb) {
                const tmdbTag = document.createElement('div');
                tmdbTag.className = `${tagClass} rating-tag-tmdb`;

                const starIcon = document.createElement('span');
                starIcon.className = 'material-icons rating-star-icon';
                starIcon.textContent = 'star';

                const ratingText = document.createElement('span');
                ratingText.className = 'rating-text';
                ratingText.textContent = rating.tmdb;

                tmdbTag.appendChild(starIcon);
                tmdbTag.appendChild(ratingText);
                container.appendChild(tmdbTag);
            }

            if (container.children.length > 0) {
                el.appendChild(container);
            }
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
            // Register with unified cache manager instead of setInterval
            if (JE._cacheManager) {
                JE._cacheManager.register(saveCache);
            }
        }

        function injectCSS() {
            const position = JE.currentSettings?.ratingTagsPosition || JE.pluginConfig?.RatingTagsPosition || 'bottom-right';
            const isTop = position.includes('top');
            const isLeft = position.includes('left');
            const topVal = isTop ? '6px' : 'auto';
            const bottomVal = isTop ? 'auto' : '6px';
            const leftVal = isLeft ? '6px' : 'auto';
            const rightVal = isLeft ? 'auto' : '6px';
            const needsTopRightOffset = isTop && !isLeft; // top-right

            const existing = document.getElementById('jellyfin-enhanced-rating-tags-css');
            if (existing) existing.remove();

            const style = document.createElement('style');
            style.id = 'jellyfin-enhanced-rating-tags-css';
            style.textContent = `
                .${containerClass} {
                    position: absolute;
                    top: ${topVal};
                    right: ${rightVal};
                    bottom: ${bottomVal};
                    left: ${leftVal};
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    align-items: ${isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                ${needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(18px, 3vw, 28px); }` : ''}
                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px 8px;
                    background: rgba(0, 0, 0, 0.8);
                    color: #ffc107;
                    font-size: 13px;
                    font-weight: 600;
                    border-radius: 4px;
                    backdrop-filter: blur(4px);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    line-height: 1;
                    pointer-events: none;
                }

                .${tagClass}.rating-tag-critic { color: #ffffff; }
                .${tagClass}.rating-tag-tmdb { background: rgba(0, 0, 0, 0.85); color: #ffc107; }

                .rating-star-icon { color: #ffc107 !important; font-size: 14px; line-height: 1; }
                .rating-tomato-icon { width: 14px; height: 14px; flex-shrink: 0; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
                .rating-tomato-icon.fresh { background-image: url(assets/img/fresh.svg); }
                .rating-tomato-icon.rotten { background-image: url(assets/img/rotten.svg); }
                .rating-text { line-height: 1; }

                .layout-mobile .${tagClass} {
                    padding: 2px 6px;
                    font-size: 11px;
                    border-radius: 3px;
                }
                .layout-mobile .${containerClass} { gap: 3px; }
                .layout-mobile .rating-star-icon { font-size: 12px !important; }
                .layout-mobile .rating-tomato-icon { width: 12px; height: 12px; }

                @media (max-width: 768px) {
                    .${tagClass} { padding: 3px 6px; font-size: 12px; }
                    .${containerClass} { gap: 3px; }
                }

                @media (max-width: 480px) {
                    .${containerClass} { top: ${isTop ? '4px' : 'auto'}; bottom: ${isTop ? 'auto' : '4px'}; left: ${isLeft ? '4px' : 'auto'}; right: ${isLeft ? 'auto' : '4px'}; gap: 2px; }
                    .${tagClass} { padding: 2px 4px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                    .rating-star-icon { font-size: clamp(10px, 2.5vw, 11px) !important; }
                    .rating-tomato-icon { width: clamp(10px, 2.5vw, 11px); height: clamp(10px, 2.5vw, 11px); }
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
