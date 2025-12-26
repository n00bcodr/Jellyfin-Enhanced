// /js/genretags.js
(function(JE) {
    'use strict';

    JE.initializeGenreTags = function() {
        if (!JE.currentSettings.genreTagsEnabled) {
            console.log('🪼 Jellyfin Enhanced: Genre Tags: Feature is disabled in settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Genre Tags:';
        const containerClass = 'genre-overlay-container';
        const tagClass = 'genre-tag';
        const CACHE_KEY = 'JellyfinEnhanced-genreTagsCache';
        const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-genreTagsCacheTimestamp';
        const CACHE_TTL = (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
        const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season']);

        // CSS selectors for elements that should NOT have genre tags applied.
        // This is used to ignore certain views like the cast & crew list.
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

        // Add search page to ignore list if configured (Gelato compatibility) (although this is not needed, adding it for consistency)
        if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
            IGNORE_SELECTORS.push('#searchPage .cardImageContainer');
        }

        // const MEDIA_TYPES = new Set(['Movie', 'Series']);
        let genreCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
        // Shared in-memory hot cache
        const Hot = (JE._hotCache = JE._hotCache || {
            ttl: CACHE_TTL,
            quality: new Map(),
            genre: new Map()
        });
        let processedElements = new WeakSet();
        let requestQueue = [];
        let isProcessingQueue = false;
        const queuedItemIds = new Set();
        let mutationDebounceTimer = null;

        const genreIconMap = {
            // Default
            'default': 'theaters',

            // English
            'action': 'sports_martial_arts', 'adventure': 'explore', 'animation': 'animation',
            'comedy': 'mood', 'crime': 'local_police', 'documentary': 'article',
            'drama': 'theater_comedy', 'family': 'family_restroom', 'fantasy': 'auto_awesome',
            'history': 'history_edu', 'horror': 'skull', 'music': 'music_note',
            'mystery': 'psychology_alt', 'romance': 'favorite', 'science fiction': 'science',
            'sci-fi': 'science', 'tv movie': 'tv', 'thriller': 'psychology', 'war': 'military_tech',
            'western': 'landscape', 'superhero': 'domino_mask', 'musical': 'music_video',
            'biography': 'menu_book', 'sport': 'sports_soccer', 'game-show': 'quiz',
            'reality-tv': 'live_tv',

            // French (fr)
            'aventure': 'explore', 'comédie': 'mood', 'drame': 'theater_comedy', 'fantastique': 'auto_awesome',
            'histoire': 'history_edu', 'horreur': 'skull', 'musique': 'music_note', 'mystère': 'psychology_alt',
            'science-fiction': 'science', 'téléfilm': 'tv', 'guerre': 'military_tech', 'comédie musicale': 'music_video',
            'biographie': 'menu_book', 'familial': 'family_restroom', 'historique': 'history_edu',
            'jeu-concours': 'quiz', 'télé-réalité': 'live_tv',

            // Spanish (es)
            'acción': 'sports_martial_arts', 'aventura': 'explore', 'animación': 'animation', 'comedia': 'mood',
            'crimen': 'local_police', 'documental': 'article', 'familiar': 'family_restroom', 'fantasía': 'auto_awesome',
            'historia': 'history_edu', 'terror': 'skull', 'música': 'music_note', 'misterio': 'psychology_alt',
            'ciencia ficción': 'science', 'película de tv': 'tv', 'suspense': 'psychology', 'bélica': 'military_tech',
            'superhéroes': 'domino_mask', 'biografía': 'menu_book', 'deporte': 'sports_soccer',
            'concurso': 'quiz', 'telerrealidad': 'live_tv',

            // German (de)
            'abenteuer': 'explore', 'komödie': 'mood', 'krimi': 'local_police', 'dokumentarfilm': 'article',
            'familienfilm': 'family_restroom', 'geschichte': 'history_edu', 'kriegsfilm': 'military_tech',
            'musikfilm': 'music_video', 'liebesfilm': 'favorite', 'fernsehfilm': 'tv',
            'spielshow': 'quiz', 'reality-tv': 'live_tv',

            // Italian (it)
            'azione': 'sports_martial_arts', 'avventura': 'explore', 'animazione': 'animation', 'commedia': 'mood',
            'crimine': 'local_police', 'documentario': 'article', 'drammatico': 'theater_comedy', 'famiglia': 'family_restroom',
            'fantastico': 'auto_awesome', 'storico': 'history_edu', 'orrore': 'skull', 'musica': 'music_note',
            'mistero': 'psychology_alt', 'romantico': 'favorite', 'fantascienza': 'science', 'film per la tv': 'tv',
            'guerra': 'military_tech', 'biografico': 'menu_book', 'sportivo': 'sports_soccer',
            'game show': 'quiz', 'reality tv': 'live_tv',

            // Danish (da)
            'eventyr': 'explore', 'komedie': 'mood', 'krimi': 'local_police', 'dokumentar': 'article',
            'familie': 'family_restroom', 'historie': 'history_edu', 'gyser': 'skull', 'musik': 'music_note',
            'mysterie': 'psychology_alt', 'romantik': 'favorite', 'krig': 'military_tech', 'tv-film': 'tv',
            'spilshow': 'quiz', 'reality-tv': 'live_tv',

            // Swedish (sv)
            'äventyr': 'explore', 'komedi': 'mood', 'brott': 'local_police', 'dokumentär': 'article',
            'familj': 'family_restroom', 'historia': 'history_edu', 'skräck': 'skull', 'musik': 'music_note',
            'mysterium': 'psychology_alt', 'romantik': 'favorite', 'krigs': 'military_tech',
            'spelshow': 'quiz', 'reality-tv': 'live_tv',

            // Hungarian (hu)
            'akció': 'sports_martial_arts', 'kaland': 'explore', 'animációs': 'animation', 'vígjáték': 'mood',
            'bűnügyi': 'local_police', 'dokumentum': 'article', 'dráma': 'theater_comedy', 'családi': 'family_restroom',
            'történelmi': 'history_edu', 'horror': 'skull', 'zenei': 'music_note', 'misztikus': 'psychology_alt',
            'romantikus': 'favorite', 'sci-fi': 'science', 'tv film': 'tv', 'háborús': 'military_tech',
            'életrajzi': 'menu_book', 'játékshow': 'quiz', 'valóság-tv': 'live_tv',

            // Russian (ru)
            'боевик': 'sports_martial_arts', 'приключения': 'explore', 'мультфильм': 'animation',
            'комедия': 'mood', 'криминал': 'local_police', 'документальный': 'article',
            'драма': 'theater_comedy', 'семейный': 'family_restroom', 'фэнтези': 'auto_awesome',
            'история': 'history_edu', 'ужасы': 'skull', 'музыка': 'music_note',
            'детектив': 'psychology_alt', 'мелодрама': 'favorite', 'фантастика': 'science',
            'НФ и Фэнтези': 'science', 'телевизионный фильм': 'tv', 'триллер': 'psychology', 'военный': 'military_tech',
            'вестерн': 'landscape', 'реалити-шоу': 'live_tv'
        };

        const visibilityObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    visibilityObserver.unobserve(entry.target);
                    processElement(entry.target, true);
                }
            });
        }, { rootMargin: '200px', threshold: 0.1 });

        function saveCache() {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(genreCache));
            } catch (e) {
                console.warn(`${logPrefix} Failed to save cache`, e);
            }
        }

        function cleanupOldCaches() {
            // Remove old version-based cache keys and legacy cache keys
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('genreTagsCache-') || key === 'genreTagsCache' || key === 'genreTagsCacheTimestamp') && key !== CACHE_KEY && key !== CACHE_TIMESTAMP_KEY) {
                    console.log(`${logPrefix} Removing old cache: ${key}`);
                    localStorage.removeItem(key);
                }
            }

            // Check if server has triggered a cache clear
            const serverClearTimestamp = JE.pluginConfig?.ClearLocalStorageTimestamp || 0;
            const localCacheTimestamp = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || '0', 10);

            if (serverClearTimestamp > localCacheTimestamp) {
                console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
                localStorage.removeItem(CACHE_KEY);
                localStorage.setItem(CACHE_TIMESTAMP_KEY, serverClearTimestamp.toString());
                genreCache = {};
                // Clear hot cache too
                if (JE._hotCache?.genre) JE._hotCache.genre.clear();
            }
        }

        function getUserId() {
            return ApiClient.getCurrentUserId();
        }

        async function fetchFirstEpisode(userId, seriesId) {
            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items', {
                        ParentId: seriesId,
                        IncludeItemTypes: 'Episode',
                        Recursive: true,
                        SortBy: 'PremiereDate',
                        SortOrder: 'Ascending',
                        Limit: 1,
                        Fields: 'Genres',
                        userId: userId
                    }),
                    dataType: 'json'
                });
                return response.Items?.[0] || null;
            } catch {
                return null;
            }
        }

        async function fetchItemGenres(userId, itemId) {
            try {
                const item = await ApiClient.getItem(userId, itemId);
                if (!item || !MEDIA_TYPES.has(item.Type)) return null;

                let sourceItem = item;

                // For Season, get genres from the parent Series
                if (item.Type === 'Season' && item.SeriesId) {
                    try {
                        const series = await ApiClient.getItem(userId, item.SeriesId);
                        if (series && series.Genres && series.Genres.length > 0) {
                            sourceItem = series;
                        }
                    } catch {
                        // If we can't get the series, fall through to use episode
                    }
                }

                // For Series, try to use genres from the item itself first
                // Only fall back to fetching first episode if the Series has no genres
                if (item.Type === 'Series' && (!sourceItem.Genres || sourceItem.Genres.length === 0)) {
                    const episode = await fetchFirstEpisode(userId, item.Id);
                    if (episode) {
                        sourceItem = episode;
                    } else {
                        return null; // No episodes found
                    }
                }

                if (sourceItem.Genres && sourceItem.Genres.length > 0) {
                    const genres = sourceItem.Genres.slice(0, 3);
                    genreCache[itemId] = { genres, timestamp: Date.now() };
                    Hot.genre.set(itemId, { genres, timestamp: Date.now() });
                    if (JE._cacheManager) JE._cacheManager.markDirty();
                    return genres;
                }
                return null;
            } catch (error) {
                console.warn(`${logPrefix} API request failed for item ${itemId}`, error);
                throw error;
            }
        }

        async function processRequestQueue() {
            if (isProcessingQueue || requestQueue.length === 0) return;
            isProcessingQueue = true;

            // Use requestIdleCallback for initial batch to defer work
            const processBatch = async () => {
                const batch = requestQueue.splice(0, 3);
                const promises = batch.map(async ({ element, itemId, userId }) => {
                    try {
                        const genres = await fetchItemGenres(userId, itemId);
                    if (genres) {
                        insertGenreTags(element, genres);
                    }
                } catch (error) {}
                finally {
                    queuedItemIds.delete(itemId);
                }
            });

            await Promise.allSettled(promises);
            isProcessingQueue = false;

            if (requestQueue.length > 0) {
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => processRequestQueue(), { timeout: 400 });
                } else {
                    setTimeout(processRequestQueue, 400);
                }
            }
            };

            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => processBatch(), { timeout: 200 });
            } else {
                processBatch();
            }
        }

        function insertGenreTags(container, genres) {
            if (!container || processedElements.has(container)) return;

            const existing = container.querySelector(`.${containerClass}`);
            if (existing) existing.remove();

            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            const genreContainer = document.createElement('div');
            genreContainer.className = containerClass;

            genres.forEach(genreName => {
                const genreKey = genreName.toLowerCase();
                const iconName = genreIconMap[genreKey] || genreIconMap['default'];
                const tag = document.createElement('div');
                tag.className = tagClass;
                tag.title = genreName;
                tag.innerHTML = `<span class="material-symbols-outlined">${iconName}</span><span class="genre-text">${genreName}</span>`;
                genreContainer.appendChild(tag);
            });

            container.appendChild(genreContainer);
            processedElements.add(container);
        }

        function getItemIdFromElement(el) {
            if (el.style && el.style.backgroundImage) {
                const match = el.style.backgroundImage.match(/Items\/([a-f0-9]{32})\//i);
                if (match && match[1]) return match[1];
            }
            // Try href pattern ...id=<ID>
            if (el.href) {
                try {
                    const url = new URL(el.href, window.location.origin);
                    const idParam = url.searchParams.get('id');
                    if (idParam) return idParam;
                } catch {}
                const m = el.href.match(/[?#&]id=([^&#]+)/);
                if (m && m[1]) return m[1];
            }
            if (el.dataset?.itemid) return el.dataset.itemid;
            let parent = el.closest('[data-itemid]');
            if (parent) return parent.dataset.itemid;
            // Fallback to data-id (but only if it's a valid 32-char hex ID)
            let parent2 = el.closest('[data-id]');
            if (parent2 && parent2.dataset.id && /^[a-f0-9]{32}$/i.test(parent2.dataset.id)) {
                return parent2.dataset.id;
            }
            return null;
        }

        function shouldIgnoreElement(el) {
            return IGNORE_SELECTORS.some(selector => {
                try {
                    if (el.matches(selector)) return true;
                    return el.closest(selector) !== null;
                } catch {
                    return false; // Silently handle potential errors with complex selectors
                }
            });
        }

        function processElement(element, isPriority = false) {
            if (shouldIgnoreElement(element) || processedElements.has(element)) return;

            // Check for standard .card parent (poster/card view)
            const card = element.closest('.card');
            if (card && card.dataset.type && !MEDIA_TYPES.has(card.dataset.type)) {
                processedElements.add(element);
                return;
            }

            // Check for .listItem parent (list/episode view)
            const listItem = element.closest('.listItem');
            if (listItem && listItem.dataset.type && !MEDIA_TYPES.has(listItem.dataset.type)) {
                processedElements.add(element);
                return;
            }

            // If neither card nor listItem, check if it's a cardImageContainer (InPlayerEpisodePreview)
            if (!card && !listItem) {
                const hasCardClass = element.classList.contains('cardImageContainer');
                const hasItemId = getItemIdFromElement(element);
                if (!hasCardClass || !hasItemId) {
                    processedElements.add(element);
                    return;
                }
            }

            const itemId = getItemIdFromElement(element);
            if (!itemId) return;

            // Hot cache first
            const hot = Hot.genre.get(itemId);
            if (hot && (Date.now() - hot.timestamp) < Hot.ttl) {
                insertGenreTags(element, hot.genres);
                return;
            }
            // Persisted cache fallback
            const cached = genreCache[itemId];
            if (cached) {
                Hot.genre.set(itemId, cached);
                insertGenreTags(element, cached.genres);
                return;
            }

            const userId = getUserId();
            if (!userId) return;

            if (queuedItemIds.has(itemId)) return;
            queuedItemIds.add(itemId);
            const request = { element, itemId, userId };
            if (isPriority) {
                requestQueue.unshift(request);
            } else {
                requestQueue.push(request);
            }

            if (!isProcessingQueue) {
                setTimeout(processRequestQueue, 0);
            }
        }

        function scanAndProcess() {
            const elements = Array.from(document.querySelectorAll(
                '.cardImageContainer, div.listItemImage'
            ));
            elements.forEach(el => {
                // Avoid re-observing if already processed
                if (!processedElements.has(el)) {
                    visibilityObserver.observe(el);
                    // Also directly process visible elements for immediate rendering
                    processElement(el, false);
                }
            });
        }

        function debouncedScan() {
            if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
            mutationDebounceTimer = setTimeout(scanAndProcess, 300);
        }

        function injectCss() {
            const styleId = 'genre-tags-styles';
            // Remove existing style to allow updates
            const existingStyle = document.getElementById(styleId);
            if (existingStyle) existingStyle.remove();

            const style = document.createElement('style');
            style.id = styleId;
            const pos = (window.JellyfinEnhanced?.currentSettings?.genreTagsPosition || window.JellyfinEnhanced?.pluginConfig?.GenreTagsPosition || 'top-right');
            const isTop = pos.includes('top');
            const isLeft = pos.includes('left');
            const topVal = isTop ? '6px' : 'auto';
            const bottomVal = isTop ? 'auto' : '6px';
            const leftVal = isLeft ? '6px' : 'auto';
            const rightVal = isLeft ? 'auto' : '6px';
            style.textContent = `
                .${containerClass} {
                    position: absolute;
                    top: ${topVal};
                    right: ${rightVal};
                    bottom: ${bottomVal};
                    left: ${leftVal};
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    align-items: ${isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: hidden;
                }
                .${tagClass} {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: clamp(22px, 4.5vw, 30px);
                    width: clamp(22px, 4.5vw, 30px);
                    border-radius: 50%;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    overflow: hidden;
                    background-color: rgba(10, 10, 10, 0.8);
                    color: #E0E0E0;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    backdrop-filter: blur(10px);
                    flex-shrink: 0;
                    transition: all 0.2s ease;
                }
                .${tagClass} .material-symbols-outlined {
                    font-size: clamp(1em, 2.8vw, 1.4em);
                    line-height: 1;
                }
                .${tagClass} .genre-text {
                    display: none;
                    white-space: nowrap;
                    font-size: clamp(9px, 1.7vw, 11px);
                    font-weight: 500;
                    margin-left: 5px;
                    margin-right: 8px;
                    text-transform: capitalize;
                }
                .card:hover .${tagClass} {
                    width: auto;
                    border-radius: 15px;
                    padding-left: 6px;
                }
                .card:hover .${tagClass} .genre-text {
                    display: inline;
                }
                .layout-mobile .${containerClass} { gap: 2px; }
                .layout-mobile .${tagClass} {
                    height: clamp(20px, 4vw, 26px);
                    width: clamp(20px, 4vw, 26px);
                }
                .layout-mobile .${tagClass} .material-symbols-outlined {
                    font-size: clamp(0.95em, 2.4vw, 1.25em);
                }
                /* On mobile keep icons only — no expand/text */
                .layout-mobile .card:hover .${tagClass} {
                    width: clamp(20px, 4vw, 26px);
                    border-radius: 50%;
                    padding-left: 0;
                }
                .layout-mobile .card:hover .${tagClass} .genre-text { display: none; }
                @media (max-width: 768px) {
                    .${containerClass} {
                        gap: 2px;
                    }
                    .${tagClass} {
                        height: clamp(21px, 4vw, 26px);
                        width: clamp(21px, 4vw, 26px);
                    }
                    .card:hover .${tagClass} {
                        width: clamp(21px, 4vw, 26px);
                        border-radius: 50%;
                        padding-left: 0;
                    }
                    .card:hover .${tagClass} .genre-text { display: none; }
                }
                @media (max-width: 480px) {
                    .${containerClass} {
                        gap: 2px;
                        max-height: 85%;
                    }
                    .${tagClass} {
                        height: clamp(20px, 3.6vw, 24px);
                        width: clamp(20px, 3.6vw, 24px);
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                    .${tagClass} .material-symbols-outlined {
                        font-size: clamp(0.85em, 2.2vw, 1.1em);
                    }
                    /* Ensure smallest view remains icon-only */
                    .card:hover .${tagClass} {
                        width: clamp(20px, 3.6vw, 24px);
                        border-radius: 50%;
                        padding-left: 0;
                    }
                    .card:hover .${tagClass} .genre-text { display: none; }
                }
            `;
            document.head.appendChild(style);
        }

        function initialize() {
            cleanupOldCaches();
            injectCss();
            // Initial scan
            setTimeout(scanAndProcess, 500);
            // Observe DOM mutations to discover new cards without polling
            const mo = new MutationObserver(() => {
                // Check if feature is still enabled before processing
                if (!JE.currentSettings?.genreTagsEnabled) {
                    return;
                }
                debouncedScan();
            });
            mo.observe(document.body, { childList: true, subtree: true });
            // Periodic persistence and cleanup hooks
            window.addEventListener('beforeunload', () => {
                saveCache();
                mo.disconnect();
                visibilityObserver.disconnect();
            });
            // Register with unified cache manager instead of setInterval
            if (JE._cacheManager) {
                JE._cacheManager.register(saveCache);
            }
        }

        initialize();
        if (!document.getElementById('mat-sym')) {
            const link = document.createElement('link');
            link.id = 'mat-sym';
            link.rel = 'stylesheet';
            link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0';
            document.head.appendChild(link);
        }
        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Re-initializes the Genre Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeGenreTags = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Genre Tags:';
        console.log(`${logPrefix} Re-initializing...`);

        // Always remove existing tags first
        document.querySelectorAll('.genre-overlay-container').forEach(el => el.remove());

        if (!JE.currentSettings.genreTagsEnabled) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        // Trigger a fresh initialization which will set up everything with current settings
        JE.initializeGenreTags();
    };

})(window.JellyfinEnhanced);