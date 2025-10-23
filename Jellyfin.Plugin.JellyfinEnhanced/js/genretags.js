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
            'biography': 'menu_book', 'sport': 'sports_soccer',

            // French (fr)
            'aventure': 'explore', 'comédie': 'mood', 'drame': 'theater_comedy', 'fantastique': 'auto_awesome',
            'histoire': 'history_edu', 'horreur': 'skull', 'musique': 'music_note', 'mystère': 'psychology_alt',
            'science-fiction': 'science', 'téléfilm': 'tv', 'guerre': 'military_tech', 'comédie musicale': 'music_video',
            'biographie': 'menu_book', 'familial': 'family_restroom', 'historique': 'history_edu',

            // Spanish (es)
            'acción': 'sports_martial_arts', 'aventura': 'explore', 'animación': 'animation', 'comedia': 'mood',
            'crimen': 'local_police', 'documental': 'article', 'familiar': 'family_restroom', 'fantasía': 'auto_awesome',
            'historia': 'history_edu', 'terror': 'skull', 'música': 'music_note', 'misterio': 'psychology_alt',
            'ciencia ficción': 'science', 'película de tv': 'tv', 'suspense': 'psychology', 'bélica': 'military_tech',
            'superhéroes': 'domino_mask', 'biografía': 'menu_book', 'deporte': 'sports_soccer',

            // German (de)
            'abenteuer': 'explore', 'komödie': 'mood', 'krimi': 'local_police', 'dokumentarfilm': 'article',
            'familienfilm': 'family_restroom', 'geschichte': 'history_edu', 'kriegsfilm': 'military_tech',
            'musikfilm': 'music_video', 'liebesfilm': 'favorite', 'fernsehfilm': 'tv',

            // Italian (it)
            'azione': 'sports_martial_arts', 'avventura': 'explore', 'animazione': 'animation', 'commedia': 'mood',
            'crimine': 'local_police', 'documentario': 'article', 'drammatico': 'theater_comedy', 'famiglia': 'family_restroom',
            'fantastico': 'auto_awesome', 'storico': 'history_edu', 'orrore': 'skull', 'musica': 'music_note',
            'mistero': 'psychology_alt', 'romantico': 'favorite', 'fantascienza': 'science', 'film per la tv': 'tv',
            'guerra': 'military_tech', 'biografico': 'menu_book', 'sportivo': 'sports_soccer',

            // Danish (da)
            'eventyr': 'explore', 'komedie': 'mood', 'krimi': 'local_police', 'dokumentar': 'article',
            'familie': 'family_restroom', 'historie': 'history_edu', 'gyser': 'skull', 'musik': 'music_note',
            'mysterie': 'psychology_alt', 'romantik': 'favorite', 'krig': 'military_tech', 'tv-film': 'tv',

            // Swedish (sv)
            'äventyr': 'explore', 'komedi': 'mood', 'brott': 'local_police', 'dokumentär': 'article',
            'familj': 'family_restroom', 'historia': 'history_edu', 'skräck': 'skull', 'musik': 'music_note',
            'mysterium': 'psychology_alt', 'romantik': 'favorite', 'krigs': 'military_tech',

            // Hungarian (hu)
            'akció': 'sports_martial_arts', 'kaland': 'explore', 'animációs': 'animation', 'vígjáték': 'mood',
            'bűnügyi': 'local_police', 'dokumentum': 'article', 'dráma': 'theater_comedy', 'családi': 'family_restroom',
            'történelmi': 'history_edu', 'horror': 'skull', 'zenei': 'music_note', 'misztikus': 'psychology_alt',
            'romantikus': 'favorite', 'sci-fi': 'science', 'tv film': 'tv', 'háborús': 'military_tech',
            'életrajzi': 'menu_book'
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

            const card = element.closest('.card');
            // Only process elements that are inside a card with a data-type of Movie or Series.
            if (!card || !card.dataset.type || !MEDIA_TYPES.has(card.dataset.type)) {
                processedElements.add(element);
                return;
            }

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
            const elements = Array.from(document.querySelectorAll(
                'a.cardImageContainer, div.listItemImage'
            ));
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
                    overflow: hidden;
                    background-color: rgba(10, 10, 10, 0.8);
                    color: #E0E0E0;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    backdrop-filter: blur(10px);
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