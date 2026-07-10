// /js/tags/ratingtags.js
// Jellyfin Rating Tags - Display TMDB and Rotten Tomato ratings on posters
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Rating Tags:';
    const containerClass = 'rating-overlay-container';
    const tagClass = 'rating-tag';
    const TAGGED_ATTR = 'jeRatingTagged';
    const CACHE_KEY = 'JellyfinEnhanced-ratingTagsCache';
    const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-ratingTagsCacheTimestamp';
    const ENABLE_LOCAL_STORAGE_FALLBACK =
        JE.pluginConfig?.TagCacheServerMode === false ||
        JE.pluginConfig?.EnableTagsLocalStorageFallback === true;

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

    let ratingCache = {};

    /**
     * Normalize a raw critic rating to a 0-100 integer percentage.
     * @param {*} raw - Raw critic rating value (may be on a 0-10 or 0-100 scale).
     * @returns {number|null} Normalized percentage or null if invalid.
     */
    function normalizeCriticPercent(raw) {
        if (raw === null || raw === undefined) return null;
        const num = Number(raw);
        if (!Number.isFinite(num)) return null;
        const percent = num <= 10 ? Math.round(num * 10) : Math.round(num);
        return Math.max(0, Math.min(100, percent));
    }

    /**
     * True when the community/critic rating tag must be SUPPRESSED because the
     * item is (or belongs to) a Spoiler-Guarded series and ratings are being
     * hidden for this user. Series suppress their own card; Seasons and unwatched
     * Episodes would otherwise leak the series rating via the parent-series
     * fallback (the server strips their own rating). Watched episodes reveal
     * normally, matching the server strip which only strips unwatched. Gated on
     * ratings actually being stripped (SpoilerStripRatings !== false and
     * HideRatings !== false) and on the master switch + JE.spoilerBlur being
     * present; everything else returns false.
     * @param {object} item - Jellyfin item DTO (or synthetic {Type, Id, SeriesId, UserData}).
     * @returns {boolean}
     */
    function shouldSuppressRatingTag(item) {
        try {
            if (!item) return false;
            if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return false;
            // Only when ratings are truly being hidden for this user.
            if (JE.pluginConfig.SpoilerStripRatings === false) return false;
            const sg = JE.spoilerBlur;
            if (!sg || typeof sg.isEnabledFor !== 'function') return false;
            if (typeof sg.getUserPrefs === 'function') {
                var prefs = sg.getUserPrefs() || {};
                if (prefs.HideRatings === false) return false; // user opted to keep ratings
            }
            // Fail CLOSED while Spoiler Guard state hasn't authoritatively loaded
            // (initial GET in flight or failed): the enabled-series set isn't
            // trustworthy yet, so suppress on any guardable surface rather than
            // flash a guarded show's rating. Mirrors reviews.js isLoadOk gate.
            var stateReady = typeof sg.isLoadOk === 'function' ? sg.isLoadOk() === true : true;
            if (item.Type === 'Series') {
                if (!item.Id) return false;
                return stateReady ? sg.isEnabledFor(item.Id) === true : true;
            }
            if (item.Type === 'Season') {
                if (!item.SeriesId) return false;
                return stateReady ? sg.isEnabledFor(item.SeriesId) === true : true;
            }
            if (item.Type === 'Episode') {
                // Watched episode is no longer a spoiler — reveal its rating.
                if (item.UserData && item.UserData.Played === true) return false;
                if (!item.SeriesId) return false;
                return stateReady ? sg.isEnabledFor(item.SeriesId) === true : true;
            }
            return false;
        } catch (e) {
            // Unexpected failure: fail CLOSED when Spoiler Guard is enabled
            // (suppress) rather than risk revealing a guarded rating.
            return !!(JE.pluginConfig && JE.pluginConfig.SpoilerBlurEnabled === true);
        }
    }

    /**
     * Retrieve a cached rating entry from localStorage or hot cache.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {{tmdb: string|null, critic: number|null}|null} Cached rating or null.
     */
    function getCachedEntry(itemId) {
        const Hot = JE._hotCache;
        const entry = ratingCache[itemId] ?? (Hot?.rating ? Hot.rating.get(itemId) : undefined);
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

    /**
     * Store a rating entry in both localStorage cache and hot cache.
     * @param {string} itemId - Jellyfin item ID.
     * @param {{tmdb: string|null, critic: number|null}} rating - Rating data to cache.
     * @returns {void}
     */
    function setCachedEntry(itemId, rating) {
        ratingCache[itemId] = rating;
        const Hot = JE._hotCache;
        if (Hot?.rating) Hot.rating.set(itemId, rating);
        if (JE._cacheManager) JE._cacheManager.markDirty();
    }

    /**
     * Persist the rating cache to localStorage.
     * @returns {void}
     */
    function saveCache() {
        if (!ENABLE_LOCAL_STORAGE_FALLBACK) return;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(ratingCache)); }
        catch (e) { console.warn(`${logPrefix} Failed to save cache`, e); }
    }

    /**
     * Remove legacy cache keys and honor server-triggered cache clears.
     * @returns {void}
     */
    function cleanupOldCaches() {
        if (!ENABLE_LOCAL_STORAGE_FALLBACK) return;
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

    /**
     * Check whether an element matches any selector that should be excluded from tagging.
     * @param {HTMLElement} el - Element to test.
     * @returns {boolean} True if the element should be skipped.
     */
    function shouldIgnoreElement(el) {
        return IGNORE_SELECTORS.some(sel => el.matches(sel) || el.closest(sel));
    }

    /**
     * Check whether a card already has a rating overlay applied.
     * @param {HTMLElement} el - Element inside the card.
     * @returns {boolean} True if the card is already tagged.
     */
    function isCardAlreadyTagged(el) {
        const card = el.closest('.card');
        if (!card) return false;
        const hasAttr = card.dataset?.[TAGGED_ATTR] === '1';
        const hasOverlay = !!card.querySelector(`.${containerClass}`);
        return hasAttr && hasOverlay;
    }

    /**
     * Mark a card element as tagged to prevent duplicate rating overlays.
     * @param {HTMLElement} el - Element inside the card.
     * @returns {void}
     */
    function markCardTagged(el) {
        const card = el.closest('.card');
        if (card) card.dataset[TAGGED_ATTR] = '1';
    }

    /**
     * Create and append TMDB and/or critic rating tag elements to a card.
     * @param {HTMLElement} el - The card container to receive the rating overlay.
     * @param {{tmdb: string|null, critic: number|null}} rating - Rating data to display.
     * @returns {void}
     */
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
            // Show a dash instead of "0.0" — a zero rating means no data, not a genuine score
            const displayRating = parseFloat(rating.tmdb) === 0 ? '—' : rating.tmdb;

            const tmdbTag = document.createElement('div');
            tmdbTag.className = `${tagClass} rating-tag-tmdb`;

            const starIcon = document.createElement('span');
            starIcon.className = 'material-icons rating-star-icon';
            starIcon.textContent = 'star';

            const ratingText = document.createElement('span');
            ratingText.className = 'rating-text';
            ratingText.textContent = displayRating;

            tmdbTag.appendChild(starIcon);
            tmdbTag.appendChild(ratingText);
            container.appendChild(tmdbTag);
        }

        if (container.children.length > 0) {
            el.appendChild(container);
            markCardTagged(el);
        }
    }

    /**
     * Inject or replace the rating tags stylesheet based on current position settings.
     * @returns {void}
     */
    function injectCss() {
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

            ${needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
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
                /* backdrop-filter removed — blur causes jank during hover animations */
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

    JE.initializeRatingTags = function() {
        console.log(`${logPrefix} Starting...`);

        const CACHE_TTL = (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;

        // Add search page to ignore list if configured (Gelato compatibility)
        if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
            if (!IGNORE_SELECTORS.includes('#searchPage .cardImageContainer')) {
                IGNORE_SELECTORS.push('#searchPage .cardImageContainer');
            }
        }

        // Initialize caches
        ratingCache = ENABLE_LOCAL_STORAGE_FALLBACK
            ? JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
            : {};
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.rating = Hot.rating || new Map();

        cleanupOldCaches();
        injectCss();

        // Register with unified cache manager for periodic persistence
        if (ENABLE_LOCAL_STORAGE_FALLBACK && JE._cacheManager) {
            JE._cacheManager.register(saveCache);
        }

        if (JE.tagPipeline) {
            JE.tagPipeline.registerRenderer('rating', {
                render: function(el, item, extras) {
                    if (shouldIgnoreElement(el)) return;
                    if (isCardAlreadyTagged(el)) return;
                    if (el.closest('.je-hidden')) return;

                    const itemId = item.Id;

                    // Spoiler Guard: suppress the rating tag for guarded
                    // series/seasons/unwatched-episodes. Checked BEFORE the
                    // hot-cache path so a rating cached before the show was
                    // guarded can't replay onto the card. Keep the user's own
                    // rating — it isn't a spoiler.
                    if (shouldSuppressRatingTag(item)) {
                        markCardTagged(el);
                        if (typeof JE.appendUserRatingToContainer === 'function') {
                            JE.appendUserRatingToContainer(el, item, extras);
                        }
                        return;
                    }

                    // Check hot cache
                    const cached = getCachedEntry(itemId);
                    if (cached && cached.tmdb !== undefined) {
                        if (cached.tmdb || cached.critic !== null) {
                            applyRatingTag(el, cached);
                        }
                        // Still need to append user rating even on cache hit
                        if (typeof JE.appendUserRatingToContainer === 'function') {
                            JE.appendUserRatingToContainer(el, item, extras);
                        }
                        return;
                    }

                    // Extract ratings from item, falling back to parent series for
                    // Season/Episode. (Guarded items already returned above, so the
                    // fallback here only runs for non-guarded cards.)
                    var sourceItem = item;
                    if (extras.ratingParentSeries && !item.CommunityRating && !item.CriticRating) {
                        sourceItem = extras.ratingParentSeries;
                    }

                    const tmdb = sourceItem.CommunityRating != null
                        ? parseFloat(sourceItem.CommunityRating).toFixed(1)
                        : null;
                    const critic = sourceItem.CriticRating != null
                        ? normalizeCriticPercent(sourceItem.CriticRating)
                        : null;

                    const rating = { tmdb, critic };
                    // Store tmdbId in cache entry so renderFromCache can call appendUserRatingToContainer.
                    // Also store the Jellyfin series id / type / played so renderFromCache can
                    // re-evaluate Spoiler-Guard suppression without the full item DTO.
                    const tmdbId = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || null;
                    const seriesTmdbId = extras?.parentSeries?.ProviderIds?.Tmdb || extras?.parentSeries?.ProviderIds?.tmdb || null;
                    const tmdbMediaType = item.Type === 'Series' ? 'tv' : 'movie';
                    setCachedEntry(itemId, { ...rating, tmdbId, seriesTmdbId, tmdbMediaType,
                        seasonNumber: item.IndexNumber ?? null,
                        episodeNumber: item.Type === 'Episode' ? item.IndexNumber : null,
                        parentSeasonNumber: item.Type === 'Episode' ? item.ParentIndexNumber : null,
                        sgType: item.Type,
                        sgSeriesId: item.SeriesId || (item.Type === 'Series' ? item.Id : null),
                        sgPlayed: item.UserData ? item.UserData.Played === true : false });

                    if (tmdb || critic !== null) {
                        applyRatingTag(el, rating);
                        if (typeof JE.appendUserRatingToContainer === 'function') {
                            JE.appendUserRatingToContainer(el, item, extras);
                        }
                    } else if (typeof JE.appendUserRatingToContainer === 'function') {
                        JE.appendUserRatingToContainer(el, item, extras);
                    }
                },
                renderFromCache: function(el, itemId) {
                    if (isCardAlreadyTagged(el)) return true;
                    if (shouldIgnoreElement(el)) return true;
                    if (el.closest('.je-hidden')) return true;
                    const cached = getCachedEntry(itemId);
                    if (!cached) return false;
                    // Re-evaluate Spoiler-Guard suppression from the guard fields
                    // stashed at cache time — a rating cached before the show was
                    // guarded must not replay onto the card. Keep the user rating.
                    if (shouldSuppressRatingTag({ Type: cached.sgType, Id: itemId, SeriesId: cached.sgSeriesId, UserData: { Played: cached.sgPlayed } })) {
                        markCardTagged(el);
                        if (typeof JE.appendUserRatingToContainer === 'function' && (cached.tmdbId || cached.seriesTmdbId)) {
                            JE.appendUserRatingToContainer(el, { Type: cached.sgType, ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {}, SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {} });
                        }
                        return true;
                    }
                    if (cached.tmdb || cached.critic !== null) {
                        applyRatingTag(el, cached);
                    }
                    if (typeof JE.appendUserRatingToContainer === 'function' && (cached.tmdbId || cached.seriesTmdbId)) {
                        const syntheticItem = {
                            Type: cached.tmdbMediaType === 'tv' ? 'Series' : 'Movie',
                            ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {},
                            SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {},
                            IndexNumber: cached.seasonNumber,
                            ParentIndexNumber: cached.parentSeasonNumber,
                        };
                        // Refine Type for Season/Episode based on available data
                        if (cached.seriesTmdbId && cached.episodeNumber != null) {
                            syntheticItem.Type = 'Episode';
                            syntheticItem.IndexNumber = cached.episodeNumber;
                            syntheticItem.ParentIndexNumber = cached.parentSeasonNumber;
                        } else if (cached.seriesTmdbId && cached.seasonNumber != null) {
                            syntheticItem.Type = 'Season';
                            syntheticItem.IndexNumber = cached.seasonNumber;
                        }
                        JE.appendUserRatingToContainer(el, syntheticItem);
                    }
                    return !!(cached.tmdb || cached.critic !== null);
                },
                renderFromServerCache: function(el, entry) {
                    if (isCardAlreadyTagged(el)) return;
                    if (shouldIgnoreElement(el)) return;
                    // Series / Season guard: a guarded show's season entry can
                    // carry the series-fallback rating (seasons have none of
                    // their own; the server strip exempts S0/S1), so suppress it.
                    // Episodes are intentionally NOT gated here: this path has no
                    // Played info and the server strip is watched-aware, so
                    // suppressing would wrongly hide a WATCHED episode's rating.
                    if ((entry.Type === 'Series' || entry.Type === 'Season')
                        && shouldSuppressRatingTag({ Type: entry.Type, Id: entry.Id, SeriesId: entry.SeriesId })) {
                        markCardTagged(el);
                        return;
                    }
                    const tmdb = entry.CommunityRating != null
                        ? parseFloat(entry.CommunityRating).toFixed(1)
                        : null;
                    const critic = entry.CriticRating != null
                        ? normalizeCriticPercent(entry.CriticRating)
                        : null;
                    if (tmdb || critic !== null) {
                        applyRatingTag(el, { tmdb, critic });
                    }
                    if (typeof JE.appendUserRatingToContainer === 'function') {
                        // Build a synthetic item so resolveTmdbKey can derive the correct key
                        // for Movie/Series (TmdbId) and Season/Episode (SeriesTmdbId + numbers)
                        const syntheticItem = {
                            Type: entry.Type,
                            ProviderIds: entry.TmdbId ? { Tmdb: entry.TmdbId } : {},
                            SeriesProviderIds: entry.SeriesTmdbId ? { Tmdb: entry.SeriesTmdbId } : {},
                            IndexNumber: entry.SeasonNumber,
                            ParentIndexNumber: entry.SeasonNumber,
                            // For Episode, SeasonNumber is ParentIndexNumber and EpisodeNumber is IndexNumber
                            ...(entry.Type === 'Episode' ? { ParentIndexNumber: entry.SeasonNumber, IndexNumber: entry.EpisodeNumber } : {})
                        };
                        if (entry.TmdbId || entry.SeriesTmdbId) {
                            JE.appendUserRatingToContainer(el, syntheticItem, null);
                        }
                    }                },
                isEnabled: function() { return !!JE.currentSettings?.ratingTagsEnabled; },
                needsFirstEpisode: false,
                needsParentSeries: false,
                injectCss: injectCss,
            });
        }

        console.log(`${logPrefix} Initialized successfully.`);
    };

    JE.reinitializeRatingTags = function() {
        console.log(`${logPrefix} Re-initializing...`);

        // Always remove existing tags first
        document.querySelectorAll('.rating-overlay-container').forEach(el => el.remove());

        // Clear tagged state so cards can be re-processed
        document.querySelectorAll(`[data-${TAGGED_ATTR.toLowerCase()}]`).forEach(el => {
            delete el.dataset[TAGGED_ATTR];
        });

        if (!JE.currentSettings.ratingTagsEnabled) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        // Re-inject CSS with current settings (position may have changed)
        injectCss();

        // Schedule a fresh scan via the unified pipeline
        if (JE.tagPipeline) {
            JE.tagPipeline.clearProcessed();
            JE.tagPipeline.scheduleScan();
        }
    };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
