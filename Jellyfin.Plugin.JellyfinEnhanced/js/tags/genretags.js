// /js/tags/genretags.js
// Genre icon overlays — a spec over the core tag-renderer factory
// (js/core/tag-renderer-base.js), which owns the cache/ignore/tagged/CSS/
// reinitialize plumbing. This module supplies only the genre-specific parts:
// the genre→icon map, genre extraction fallbacks and the icon-chip markup.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Genre Tags:';
    const containerClass = 'genre-overlay-container';
    const tagClass = 'genre-tag';

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
        'eventyr': 'explore', 'komedie': 'mood', 'dokumentar': 'article',
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

    /**
     * Create and insert genre icon tags into a card container.
     * @param {Object} ctx - Factory context (tagged/overlay helpers).
     * @param {HTMLElement} container - The card scalable or image container element.
     * @param {string[]} genres - Array of genre names to display.
     * @returns {void}
     */
    function insertGenreTags(ctx, container, genres) {
        if (!container) return;

        ctx.removeExistingOverlay(container);

        // Ensure container is positioned (avoids forced reflow from getComputedStyle)
        container.style.position = 'relative';

        const genreContainer = document.createElement('div');
        genreContainer.className = containerClass;

        const hideOnHover = !!JE.currentSettings?.tagsHideOnHover;
        genres.forEach(function(genreName) {
            const genreKey = genreName.toLowerCase();
            const iconName = genreIconMap[genreKey] || genreIconMap['default'];
            const tag = document.createElement('div');
            tag.className = tagClass;
            tag.title = genreName;
            const iconSpan = document.createElement('span');
            iconSpan.className = 'material-symbols-outlined';
            iconSpan.textContent = iconName;
            tag.appendChild(iconSpan);
            // Skip text labels when tags are hidden on hover — they'd never be visible
            if (!hideOnHover) {
                const textSpan = document.createElement('span');
                textSpan.className = 'genre-text';
                textSpan.textContent = genreName;
                tag.appendChild(textSpan);
            }
            genreContainer.appendChild(tag);
        });

        ctx.commitOverlay(container, genreContainer);
    }

    /** @type {Object} Factory spec — everything genre-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'genreTagsEnabled',
        containerClass,
        taggedAttr: 'jeGenreTagged',
        styleId: 'genre-tags-styles',
        cache: {
            key: 'JellyfinEnhanced-genreTagsCache',
            legacyPrefix: 'genreTagsCache',
            hotBucket: 'genre',
        },
        // Genre uses container-level selectors (not .cardImageContainer-scoped)
        // and adds a video-player check — kept as a module-specific override.
        ignoreSelectors: [
            '.je-hidden',
            '#itemDetailPage .infoWrapper',
            '#itemDetailPage #castCollapsible',
            '#indexPage .verticalSection.MyMedia',
            '.formDialog',
            '#itemDetailPage .chapterCardImageContainer',
            '#pluginsPage, #pluginCatalogPage, #devicesPage, #mediaLibraryPage'
        ],
        searchPageIgnoreSelector: '#searchPage',
        shouldIgnore(el, defaultMatcher) {
            if (document.querySelector('.videoPlayerContainer')) return true;
            return defaultMatcher(el);
        },
        buildCss() {
            const pos = JE.core.tagRenderer.resolvePosition('genreTagsPosition', 'GenreTagsPosition', 'top-right');
            return `
                .${containerClass} {
                    position: absolute;
                    top: ${pos.topVal};
                    right: ${pos.rightVal};
                    bottom: ${pos.bottomVal};
                    left: ${pos.leftVal};
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    align-items: ${pos.isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: visible;
                }
                ${pos.needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
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
                       Appears beside the icon on hover via opacity (GPU-composited).
                       Direction depends on tag position: icons on right → label floats left,
                       icons on left → label floats right (so it stays inside the card). */
                    position: absolute;
                    ${pos.isLeft ? 'left: calc(100% + 4px)' : 'right: calc(100% + 4px)'};
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
        },
        pipeline: {
            needsFirstEpisode: true,
            needsParentSeries: true,
            render(ctx, el, item, extras) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;

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
                    ctx.setPersistent(itemId, { genres: sliced, timestamp: Date.now() });
                }

                insertGenreTags(ctx, el, sliced);
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                var hot = ctx.hot?.get(itemId);
                var cached = hot || ctx.getPersistent(itemId);
                if (cached) {
                    var genres = Array.isArray(cached) ? cached : cached.genres;
                    if (genres && genres.length > 0) {
                        insertGenreTags(ctx, el, genres.slice(0, 3));
                        return true;
                    }
                }
                return false;
            },
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                var genres = entry.Genres;
                if (genres && genres.length > 0) {
                    insertGenreTags(ctx, el, genres.slice(0, 3));
                }
            },
        },
    };

    JE.initializeGenreTags = function() {
        // Ensure Material Symbols font is loaded
        if (!document.getElementById('mat-sym')) {
            const link = document.createElement('link');
            link.id = 'mat-sym';
            link.rel = 'stylesheet';
            // Served locally: the plugin proxies the Google Fonts css2 sheet and rewrites
            // its @font-face URLs to the local gfont route, so no request reaches Google.
            link.href = JE.cdn.url('gfontcss', 'material-symbols-outlined');
            document.head.appendChild(link);
        }

        JE.core.tagRenderer.register('genre', spec);
        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Re-initializes the Genre Tags feature.
     * Cleans up existing tags and triggers a pipeline rescan.
     */
    JE.reinitializeGenreTags = function() {
        JE.core.tagRenderer.reinitialize('genre', spec);
    };

})(window.JellyfinEnhanced);
