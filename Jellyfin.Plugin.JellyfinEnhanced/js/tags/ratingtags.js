// /js/tags/ratingtags.js
// Jellyfin Rating Tags - Display TMDB and Rotten Tomato ratings on posters.
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. This module
// supplies only the rating-specific parts: rating normalization, the chip
// markup, and the synthetic items handed to the user-review tag module.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Rating Tags:';
    const containerClass = 'rating-overlay-container';
    const tagClass = 'rating-tag';

    /**
     * Normalize a raw critic rating to a 0-100 integer percentage.
     * @param {*} raw - Raw critic rating value.
     * @returns {number|null} Normalized percentage or null if invalid.
     */
    function normalizeCriticPercent(raw) {
        if (raw === null || raw === undefined) return null;
        const num = Number(raw);
        if (!Number.isFinite(num)) return null;
        return Math.max(0, Math.min(100, Math.round(num)));
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
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {Object|null} Cached rating or null.
     */
    function getCachedEntry(ctx, itemId) {
        const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
        if (!entry) return null;
        if (typeof entry === 'string' || typeof entry === 'number') {
            return { tmdb: String(entry), critic: null };
        }
        if (typeof entry === 'object') {
            return {
                ...entry,
                tmdb: entry.tmdb ?? null,
                critic: entry.critic ?? null
            };
        }
        return null;
    }

    /**
     * Store a rating entry in both localStorage cache and hot cache.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @param {Object} rating - Rating data to cache.
     * @returns {void}
     */
    function setCachedEntry(ctx, itemId, rating) {
        ctx.setPersistent(itemId, rating);
        ctx.hot?.set(itemId, rating);
    }

    /**
     * Create and append TMDB and/or critic rating tag elements to a card.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card container to receive the rating overlay.
     * @param {{tmdb: string|null, critic: number|null}} rating - Rating data to display.
     * @returns {void}
     */
    function applyRatingTag(ctx, el, rating) {
        if (!rating || (!rating.tmdb && rating.critic === null)) return;

        ctx.removeExistingOverlay(el);

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

        ctx.commitOverlay(el, container);
    }

    /** @type {Object} Factory spec — everything rating-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'ratingTagsEnabled',
        containerClass,
        taggedAttr: 'jeRatingTagged',
        styleId: 'jellyfin-enhanced-rating-tags-css',
        position: { userKey: 'ratingTagsPosition', pluginKey: 'RatingTagsPosition', fallback: 'bottom-right' },
        cache: {
            key: 'JellyfinEnhanced-ratingTagsCache',
            legacyPrefix: 'ratingTagsCache',
            hotBucket: 'rating',
            // Pre-factory ratingtags only saved via the cache manager (no
            // beforeunload hook) — preserved.
            saveOnUnload: false,
        },
        buildCss() {
            const pos = JE.core.tagRenderer.resolvePosition('ratingTagsPosition', 'RatingTagsPosition', 'bottom-right');
            return `
                .${containerClass} {
                    position: absolute;
                    top: ${pos.topVal};
                    right: ${pos.rightVal};
                    bottom: ${pos.bottomVal};
                    left: ${pos.leftVal};
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    align-items: ${pos.isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                ${pos.needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
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
                    .${containerClass} { top: ${pos.isTop ? '4px' : 'auto'}; bottom: ${pos.isTop ? 'auto' : '4px'}; left: ${pos.isLeft ? '4px' : 'auto'}; right: ${pos.isLeft ? 'auto' : '4px'}; gap: 2px; }
                    .${tagClass} { padding: 2px 4px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                    .rating-star-icon { font-size: clamp(10px, 2.5vw, 11px) !important; }
                    .rating-tomato-icon { width: clamp(10px, 2.5vw, 11px); height: clamp(10px, 2.5vw, 11px); }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;

                const itemId = item.Id;

                // Suppress before consulting the cache: a rating cached before
                // Spoiler Guard was enabled must never flash back onto a card.
                if (shouldSuppressRatingTag(item)) {
                    ctx.markTagged(el);
                    if (typeof JE.appendUserRatingToContainer === 'function') {
                        JE.appendUserRatingToContainer(el, item, extras);
                    }
                    return;
                }

                // Check hot cache
                const cached = getCachedEntry(ctx, itemId);
                if (cached && cached.tmdb !== undefined) {
                    if (cached.tmdb || cached.critic !== null) {
                        applyRatingTag(ctx, el, cached);
                    }
                    // Still need to append user rating even on cache hit
                    if (typeof JE.appendUserRatingToContainer === 'function') {
                        JE.appendUserRatingToContainer(el, item, extras);
                    }
                    return;
                }

                // Extract ratings from item, falling back to parent series for Season/Episode
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
                // Store tmdbId in cache entry so renderFromCache can call appendUserRatingToContainer
                const tmdbId = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || null;
                const seriesTmdbId = extras?.parentSeries?.ProviderIds?.Tmdb || extras?.parentSeries?.ProviderIds?.tmdb || null;
                const tmdbMediaType = item.Type === 'Series' ? 'tv' : 'movie';
                setCachedEntry(ctx, itemId, { ...rating, tmdbId, seriesTmdbId, tmdbMediaType,
                    seasonNumber: item.IndexNumber ?? null,
                    episodeNumber: item.Type === 'Episode' ? item.IndexNumber : null,
                    parentSeasonNumber: item.Type === 'Episode' ? item.ParentIndexNumber : null,
                    sgType: item.Type,
                    sgSeriesId: item.SeriesId || (item.Type === 'Series' ? item.Id : null),
                    sgPlayed: item.UserData?.Played === true });

                if (tmdb || critic !== null) {
                    applyRatingTag(ctx, el, rating);
                    if (typeof JE.appendUserRatingToContainer === 'function') {
                        JE.appendUserRatingToContainer(el, item, extras);
                    }
                } else if (typeof JE.appendUserRatingToContainer === 'function') {
                    JE.appendUserRatingToContainer(el, item, extras);
                }
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = getCachedEntry(ctx, itemId);
                if (!cached) return false;
                if (shouldSuppressRatingTag({
                    Type: cached.sgType,
                    Id: itemId,
                    SeriesId: cached.sgSeriesId,
                    UserData: { Played: cached.sgPlayed === true }
                })) {
                    ctx.markTagged(el);
                    if (typeof JE.appendUserRatingToContainer === 'function' && (cached.tmdbId || cached.seriesTmdbId)) {
                        JE.appendUserRatingToContainer(el, {
                            Type: cached.sgType,
                            ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {},
                            SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {}
                        });
                    }
                    return true;
                }
                if (cached.tmdb || cached.critic !== null) {
                    applyRatingTag(ctx, el, cached);
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
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                // Server-cache episode entries lack Played state, so only apply
                // the parent-series suppression where it is authoritative.
                if ((entry.Type === 'Series' || entry.Type === 'Season')
                    && shouldSuppressRatingTag({
                        Type: entry.Type,
                        Id: entry.Id,
                        SeriesId: entry.SeriesId
                    })) {
                    ctx.markTagged(el);
                    return;
                }
                const tmdb = entry.CommunityRating != null
                    ? parseFloat(entry.CommunityRating).toFixed(1)
                    : null;
                const critic = entry.CriticRating != null
                    ? normalizeCriticPercent(entry.CriticRating)
                    : null;
                if (tmdb || critic !== null) {
                    applyRatingTag(ctx, el, { tmdb, critic });
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
                }
            },
        },
    };

    JE.initializeRatingTags = function() {
        console.log(`${logPrefix} Starting...`);

        const ctx = JE.core.tagRenderer.register('rating', spec);
        ctx.injectCss();

        console.log(`${logPrefix} Initialized successfully.`);
    };

    JE.reinitializeRatingTags = function() {
        JE.core.tagRenderer.reinitialize('rating', spec);
    };

})(window.JellyfinEnhanced);
