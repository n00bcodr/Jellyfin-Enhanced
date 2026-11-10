import type { TagRuntimeBridge } from '../../host';
import { members, memberText, record } from '../../pipeline/dto';
import type { TagCtx, TagSpec } from '../../pipeline/contract';
import { genreIconMap, genreLabelOfIcon, genreOtherLabel } from './genre-table';

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);
// /js/tags/genretags.js
// Genre icon overlays — a spec over the core tag-renderer factory
// (js/core/tag-renderer-base.js), which owns the cache/ignore/tagged/CSS/
// reinitialize plumbing. This module supplies only the genre-specific parts:
// the genre→icon map (generated from genre-icons.json, which native posters
// share), genre extraction fallbacks and the icon-chip markup.
export function createGenreTags(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced: Genre Tags:';
    const containerClass = 'genre-overlay-container';
    const tagClass = 'genre-tag';


    /**
     * The glyph a genre draws: its lowercased name in the table, else the default.
     * */
    function iconFor(genreName: string): string {
        // tests/fixtures/genre-styles.json pins the plain lookup, inherited members included.
        return genreIconMap[genreName.toLowerCase()] || genreIconMap['default'] || 'theaters';
    }

    /**
     * The Tag Styles label of a glyph: the canonical English genre it stands
     * for (so every alias shares one label), else Other. Native posters
     * resolve the same way (GenreIcons.LabelOfIcon).
     * @param iconName - What iconFor returned (an inherited object member for "constructor").
     * */
    function labelOfIcon(iconName: unknown): string {
        return (typeof iconName === 'string' && has(genreLabelOfIcon, iconName) ? genreLabelOfIcon[iconName] : undefined) ?? genreOtherLabel;
    }

    /**
     * Whether the genre cap shows no more than the three genres older
     * versions kept in the local cache (so such an entry is still complete
     * enough). Without the layout controller the old limit of three applies.
     * */
    function genreCapFitsTruncated(): boolean {
        const cap = JE.core.tagLayout?.resolveLayout(null).caps.genre;
        return cap === undefined || (cap > 0 && cap <= 3);
    }

    /**
     * Create and insert genre icon tags into a card container.
     * @param ctx - Factory context (tagged/overlay helpers).
     * @param container - The card scalable or image container element.
     * @param genres - Array of genre names to display.
     * */
    function insertGenreTags(ctx: TagCtx, container: HTMLElement, genres: readonly unknown[]): void {
        if (!container) return;

        ctx.removeExistingOverlay(container);

        // Ensure container is positioned (avoids forced reflow from getComputedStyle,
        // and a style write per card when it already is)
        if (container.style.position !== 'relative') container.style.position = 'relative';

        const genreContainer = document.createElement('div');
        genreContainer.className = containerClass;

        genres.forEach(function(member) {
            const genreName = memberText(member);
            const iconName = iconFor(genreName);
            const tag = document.createElement('div');
            tag.className = tagClass;
            tag.title = genreName;
            // Tag Styles colour each genre by this label (tags/tag-styles.js).
            tag.dataset.jeGenre = labelOfIcon(iconName);
            const iconSpan = document.createElement('span');
            iconSpan.className = 'je-msym-outlined';
            iconSpan.textContent = iconName;
            tag.appendChild(iconSpan);
            // The name is always part of the group: the summary and minimal
            // reveals show it whatever Hide Tags on Hover says; where it shows
            // elsewhere is up to the layout stylesheet.
            const textSpan = document.createElement('span');
            textSpan.className = 'genre-text';
            textSpan.textContent = genreName;
            tag.appendChild(textSpan);
            genreContainer.appendChild(tag);
        });

        ctx.commitOverlay(container, genreContainer);
    }

    /** Factory spec — everything genre-specific lives here. */
    const spec: TagSpec = {
        logPrefix,
        settingKey: 'genreTagsEnabled',
        containerClass,
        taggedAttr: 'jeGenreTagged',
        styleId: 'genre-tags-styles',
        position: { userKey: 'genreTagsPosition', pluginKey: 'GenreTagsPosition', fallback: 'top-right' },
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
            // Placement, and which side the hover names float to, come from
            // the layout stylesheet (tags/tag-layout-styles.js).
            return `
                .je-msym-outlined {
                    font-family: 'JE Material Symbols Outlined';
                    font-weight: normal;
                    font-style: normal;
                    font-size: calc(24px * var(--je-tag-scale, 1));
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }

                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-end;
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: visible;
                }
                .${tagClass} {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: calc(clamp(22px, 4.5vw, 30px) * var(--je-tag-scale, 1));
                    width: calc(clamp(22px, 4.5vw, 30px) * var(--je-tag-scale, 1));
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
                .${tagClass} .je-msym-outlined {
                    font-size: calc(clamp(1em, 2.8vw, 1.4em) * var(--je-tag-scale, 1));
                    line-height: 1;
                }
                .${tagClass} .genre-text {
                    /* Absolutely positioned label = no layout reflow when shown/hidden.
                       Appears beside the icon on hover via opacity (GPU-composited).
                       Direction depends on the slot (layout stylesheet): icons on the
                       right → label floats left, on the left → floats right. */
                    position: absolute;
                    right: calc(100% + 4px);
                    top: 50%;
                    transform: translateY(-50%);
                    white-space: nowrap;
                    font-size: calc(clamp(9px, 1.7vw, 11px) * var(--je-tag-scale, 1));
                    font-weight: 500;
                    text-transform: capitalize;
                    background: rgba(10, 10, 10, 0.85);
                    color: #E0E0E0;
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    border-radius: 4px;
                    box-sizing: border-box;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.12s ease;
                }
                /* Bounded when the card is revealed (core/tag-layout.js fitReveal): no room left beside the icon. */
                .${tagClass} .genre-text[data-je-genre-fit="hidden"] { display: none; }
                .card:hover .${tagClass} .genre-text,
                .je-tag-reveal .${tagClass} .genre-text {
                    opacity: 1;
                }
                .layout-mobile .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                .layout-mobile .${tagClass} {
                    height: calc(clamp(20px, 4vw, 26px) * var(--je-tag-scale, 1));
                    min-width: calc(clamp(20px, 4vw, 26px) * var(--je-tag-scale, 1));
                }
                .layout-mobile .${tagClass} .je-msym-outlined {
                    font-size: calc(clamp(0.95em, 2.4vw, 1.25em) * var(--je-tag-scale, 1));
                }
                @media (max-width: 768px) {
                    .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    .${tagClass} {
                        height: calc(clamp(21px, 4vw, 26px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(21px, 4vw, 26px) * var(--je-tag-scale, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); max-height: 85%; }
                    .${tagClass} {
                        height: calc(clamp(20px, 3.6vw, 24px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(20px, 3.6vw, 24px) * var(--je-tag-scale, 1));
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                    .${tagClass} .je-msym-outlined {
                        font-size: calc(clamp(0.85em, 2.2vw, 1.1em) * var(--je-tag-scale, 1));
                    }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: true,
            needsParentSeries: true,
            render(ctx: TagCtx, el, item, extras) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;

                const own = members(item.Genres);
                const parent = members(extras.parentSeries?.Genres);
                const episode = members(extras.firstEpisode?.Genres);
                let genres = own;

                // A Season shows its own genres, else its parent Series' (as the server cache does)
                if (item.Type === 'Season' && own.length === 0 && parent.length > 0) {
                    genres = parent;
                }
                // For Series without genres, fall back to first episode
                else if (item.Type === 'Series' && own.length === 0 && episode.length > 0) {
                    genres = episode;
                }

                // Every genre is cached and committed; the layout's genre cap
                // (3 by default) decides how many show. `full` marks an entry
                // that holds them all (older entries were cut to three).
                const itemId = item.Id;
                if (itemId) {
                    ctx.setPersistent(String(itemId), { genres: genres.slice(), full: true, timestamp: Date.now() });
                }

                insertGenreTags(ctx, el, genres);
            },
            renderFromCache(ctx: TagCtx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                const cached = ctx.hot?.get(itemId) || ctx.getPersistent(itemId);
                if (cached) {
                    const entry = record(cached);
                    const stored = Array.isArray(cached) ? cached : entry.genres;
                    if (Array.isArray(stored)) {
                        const genres: readonly unknown[] = stored;
                        // An entry cut to three by an older version can't fill a
                        // larger (or unlimited) cap: treat it as a miss so it refills.
                        if (genres.length >= 3 && !entry.full && !genreCapFitsTruncated()) return false;
                        if (genres.length) insertGenreTags(ctx, el, genres);
                        return true;
                    }
                }
                return false;
            },
            renderFromServerCache(ctx: TagCtx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                const genres = members(entry.Genres);
                if (genres.length > 0) {
                    insertGenreTags(ctx, el, genres);
                }
            },
        },
    };

    /** Genre lookups for other modules (the settings panel's preview chips). */
    JE.genreTags = {
        iconFor,
        /**
         * A genre's Tag Styles label, as its chip's data-je-genre.
         * */
        labelFor: (genreName: string): string => labelOfIcon(iconFor(String(genreName))),
    };

    JE.initializeGenreTags = function() {
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

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);
}
