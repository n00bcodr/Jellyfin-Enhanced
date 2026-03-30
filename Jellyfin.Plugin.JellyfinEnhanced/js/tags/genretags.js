// /js/tags/genretags.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Genre Tags:';
    const containerClass = 'genre-overlay-container';
    const tagClass = 'genre-tag';
    const TAGGED_ATTR = 'jeGenreTagged';
    const CACHE_KEY = 'JellyfinEnhanced-genreTagsCache';
    const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-genreTagsCacheTimestamp';

    let genreCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};

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
        'spielshow': 'quiz',

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
        'spilshow': 'quiz',

        // Swedish (sv)
        'äventyr': 'explore', 'komedi': 'mood', 'brott': 'local_police', 'dokumentär': 'article',
        'familj': 'family_restroom', 'skräck': 'skull',
        'mysterium': 'psychology_alt', 'krigs': 'military_tech',
        'spelshow': 'quiz',

        // Hungarian (hu)
        'akció': 'sports_martial_arts', 'kaland': 'explore', 'animációs': 'animation', 'vígjáték': 'mood',
        'bűnügyi': 'local_police', 'dokumentum': 'article', 'dráma': 'theater_comedy', 'családi': 'family_restroom',
        'történelmi': 'history_edu', 'zenei': 'music_note', 'misztikus': 'psychology_alt',
        'romantikus': 'favorite', 'tv film': 'tv', 'háborús': 'military_tech',
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

    function isCardAlreadyTagged(el) {
        const card = el.closest('.card');
        if (!card) return false;
        const hasAttr = card.dataset?.[TAGGED_ATTR] === '1';
        const hasOverlay = !!card.querySelector(`.${containerClass}`);
        return hasAttr && hasOverlay;
    }

    function markCardTagged(el) {
        const card = el.closest('.card');
        if (card) card.dataset[TAGGED_ATTR] = '1';
    }

    function insertGenreTags(container, genres) {
        if (!container) return;

        const existing = container.querySelector(`.${containerClass}`);
        if (existing) existing.remove();

        // Ensure container is positioned (avoids forced reflow from getComputedStyle)
        container.style.position = 'relative';

        const genreContainer = document.createElement('div');
        genreContainer.className = containerClass;

        genres.forEach(function(genreName) {
            const genreKey = genreName.toLowerCase();
            const iconName = genreIconMap[genreKey] || genreIconMap['default'];
            const tag = document.createElement('div');
            tag.className = tagClass;
            tag.title = genreName;
            const iconSpan = document.createElement('span');
            iconSpan.className = 'material-symbols-outlined';
            iconSpan.textContent = iconName;
            const textSpan = document.createElement('span');
            textSpan.className = 'genre-text';
            textSpan.textContent = genreName;
            tag.appendChild(iconSpan);
            tag.appendChild(textSpan);
            genreContainer.appendChild(tag);
        });

        container.appendChild(genreContainer);
        markCardTagged(container);
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
        const needsTopRightOffset = isTop && !isLeft; // top-right
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
            ${needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
            .${tagClass} {
                display: flex;
                align-items: center;
                justify-content: center;
                height: clamp(22px, 4.5vw, 30px);
                width: clamp(22px, 4.5vw, 30px);
                border-radius: 50%;
                box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                overflow: visible;
                background-color: rgba(10, 10, 10, 0.8);
                color: #E0E0E0;
                border: 1px solid rgba(255, 255, 255, 0.2);
                flex-shrink: 0;
                contain: style;
                position: relative;
            }
            .${tagClass} .material-symbols-outlined {
                font-size: clamp(1em, 2.8vw, 1.4em);
                line-height: 1;
            }
            .${tagClass} .genre-text {
                /* Absolutely positioned label = no layout reflow when shown/hidden.
                   Appears beside the icon on hover via opacity (GPU-composited). */
                position: absolute;
                left: calc(100% + 4px);
                top: 50%;
                transform: translateY(-50%);
                white-space: nowrap;
                font-size: clamp(9px, 1.7vw, 11px);
                font-weight: 500;
                text-transform: capitalize;
                background: rgba(10, 10, 10, 0.85);
                color: #E0E0E0;
                padding: 2px 6px;
                border-radius: 4px;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.12s ease;
            }
            .card:hover .${tagClass} .genre-text {
                opacity: 1;
            }
            .layout-mobile .${containerClass} { gap: 2px; }
            .layout-mobile .${tagClass} {
                height: clamp(20px, 4vw, 26px);
                min-width: clamp(20px, 4vw, 26px);
            }
            .layout-mobile .${tagClass} .material-symbols-outlined {
                font-size: clamp(0.95em, 2.4vw, 1.25em);
            }
            @media (max-width: 768px) {
                .${containerClass} { gap: 2px; }
                .${tagClass} {
                    height: clamp(21px, 4vw, 26px);
                    min-width: clamp(21px, 4vw, 26px);
                }
            }
            @media (max-width: 480px) {
                .${containerClass} { gap: 2px; max-height: 85%; }
                .${tagClass} {
                    height: clamp(20px, 3.6vw, 24px);
                    min-width: clamp(20px, 3.6vw, 24px);
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                }
                .${tagClass} .material-symbols-outlined {
                    font-size: clamp(0.85em, 2.2vw, 1.1em);
                }
            }
        `;
        document.head.appendChild(style);
    }

    JE.initializeGenreTags = function() {
        cleanupOldCaches();

        // Ensure Material Symbols font is loaded
        if (!document.getElementById('mat-sym')) {
            const link = document.createElement('link');
            link.id = 'mat-sym';
            link.rel = 'stylesheet';
            link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0';
            document.head.appendChild(link);
        }

        // Register with unified cache manager for periodic persistence
        if (JE._cacheManager) {
            JE._cacheManager.register(saveCache);
        }
        window.addEventListener('beforeunload', saveCache);

        if (JE.tagPipeline) {
            JE.tagPipeline.registerRenderer('genre', {
                render: function(el, item, extras) {
                    if (isCardAlreadyTagged(el)) return;

                    var genres = null;

                    // For Season, prefer genres from the parent Series
                    if (item.Type === 'Season' && extras.parentSeries && extras.parentSeries.Genres && extras.parentSeries.Genres.length > 0) {
                        genres = extras.parentSeries.Genres;
                    }
                    // For Series without genres, fall back to first episode
                    else if (item.Type === 'Series' && (!item.Genres || item.Genres.length === 0) && extras.firstEpisode && extras.firstEpisode.Genres && extras.firstEpisode.Genres.length > 0) {
                        genres = extras.firstEpisode.Genres;
                    }
                    // Default: use item's own genres
                    else {
                        genres = item.Genres;
                    }

                    if (!genres || genres.length === 0) return;

                    var sliced = genres.slice(0, 3);

                    // Update localStorage genre cache
                    var itemId = item.Id;
                    if (itemId) {
                        genreCache[itemId] = { genres: sliced, timestamp: Date.now() };
                        if (JE._cacheManager) JE._cacheManager.markDirty();
                    }

                    insertGenreTags(el, sliced);
                },
                renderFromCache: function(el, itemId) {
                    if (isCardAlreadyTagged(el)) return true;
                    var Hot = JE._hotCache;
                    var hot = Hot && Hot.genre ? Hot.genre.get(itemId) : undefined;
                    var cached = hot || genreCache[itemId];
                    if (cached) {
                        var genres = Array.isArray(cached) ? cached : cached.genres;
                        if (genres && genres.length > 0) {
                            insertGenreTags(el, genres.slice(0, 3));
                            return true;
                        }
                    }
                    return false;
                },
                isEnabled: function() {
                    return !!JE.currentSettings?.genreTagsEnabled;
                },
                needsFirstEpisode: true,
                needsParentSeries: true,
                injectCss: injectCss,
            });
        }

        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Re-initializes the Genre Tags feature.
     * Cleans up existing tags and triggers a pipeline rescan.
     */
    JE.reinitializeGenreTags = function() {
        console.log(`${logPrefix} Re-initializing...`);

        // Always remove existing tags first
        document.querySelectorAll('.genre-overlay-container').forEach(function(el) { el.remove(); });

        // Re-inject CSS in case position settings changed
        injectCss();

        if (!JE.currentSettings.genreTagsEnabled) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        // Ask the pipeline to rescan the DOM
        JE.tagPipeline?.scheduleScan();
    };

})(window.JellyfinEnhanced);