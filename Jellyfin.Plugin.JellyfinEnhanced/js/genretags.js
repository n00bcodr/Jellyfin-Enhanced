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
        const CACHE_KEY = `genreTagsCache-${JE.pluginVersion || 'static_fallback'}`;
        const MEDIA_TYPES = new Set(['Movie', 'Series']);
        let genreCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
        let processedElements = new WeakSet();
        let requestQueue = [];
        let isProcessingQueue = false;

        const genreIconMap = {
            'action': 'sports_martial_arts', 'adventure': 'explore', 'animation': 'animation',
            'comedy': 'mood', 'crime': 'local_police', 'documentary': 'article',
            'drama': 'theater_comedy', 'family': 'family_restroom', 'fantasy': 'auto_awesome',
            'history': 'history_edu', 'horror': 'skull', 'music': 'music_note',
            'mystery': 'psychology_alt', 'romance': 'favorite', 'science fiction': 'science',
            'sci-fi': 'science', 'tv movie': 'tv', 'thriller': 'psychology', 'war': 'military_tech',
            'western': 'landscape', 'superhero': 'domino_mask', 'musical': 'music_video',
            'biography': 'menu_book', 'sport': 'sports_soccer', 'default': 'theaters'
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

        function getUserId() {
            return ApiClient.getCurrentUserId();
        }

        async function fetchItemGenres(userId, itemId) {
            try {
                const item = await ApiClient.getItem(userId, itemId);
                if (item && MEDIA_TYPES.has(item.Type) && item.Genres && item.Genres.length > 0) {
                    const genres = item.Genres.slice(0, 3);
                    genreCache[itemId] = { genres, timestamp: Date.now() };
                    saveCache();
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

            const batch = requestQueue.splice(0, 5);
            const promises = batch.map(async ({ element, itemId, userId }) => {
                try {
                    const genres = await fetchItemGenres(userId, itemId);
                    if (genres) {
                        insertGenreTags(element, genres);
                    }
                } catch (error) {}
            });

            await Promise.allSettled(promises);
            isProcessingQueue = false;

            if (requestQueue.length > 0) {
                setTimeout(processRequestQueue, 500);
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
            let parent = el.closest('[data-id]');
            return parent ? parent.dataset.id : null;
        }

        function processElement(element, isPriority = false) {
            if (processedElements.has(element)) return;
            const itemId = getItemIdFromElement(element);
            if (!itemId) return;

            const cached = genreCache[itemId];
            if (cached) {
                insertGenreTags(element, cached.genres);
                return;
            }

            const userId = getUserId();
            if (!userId) return;

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
            const elements = document.querySelectorAll('.card .cardImageContainer:not([data-genres-processed])');
            elements.forEach(el => {
                el.dataset.genresProcessed = true;
                visibilityObserver.observe(el);
            });
        }

        function injectCss() {
            const styleId = 'genre-tags-styles';
            if (document.getElementById(styleId)) return;
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .${containerClass} {
                    position: absolute;
                    top: 6px;
                    right: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    align-items: flex-end;
                    z-index: 101;
                    pointer-events: none;
                }
                .${tagClass} {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 30px;
                    width: 30px;
                    border-radius: 50%;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.4);
                    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                    overflow: hidden;
                    background-color: rgba(20, 20, 20, 0.8);
                    color: #E0E0E0;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(4px);
                }
                .${tagClass} .material-symbols-outlined {
                    font-size: 1.4em;
                    line-height: 1;
                }
                .${tagClass} .genre-text {
                    display: none;
                    white-space: nowrap;
                    font-size: 13px;
                    font-weight: 500;
                    margin-left: 6px;
                    margin-right: 10px;
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
            `;
            document.head.appendChild(style);
        }

        function initialize() {
            injectCss();
            setInterval(scanAndProcess, 2000);
            scanAndProcess();
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

})(window.JellyfinEnhanced);