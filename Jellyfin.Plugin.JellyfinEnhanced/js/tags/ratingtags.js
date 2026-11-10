(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export2 = /* @__PURE__ */ sharedExport(shared, "mediaTagsContext");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export22 = /* @__PURE__ */ sharedExport(shared2, "finite");
  var export4 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "own");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/src/features/media-tags/types/ratings/ratingtags.ts
  var SCOPE_OF_KEY = {
    ratingTagsOnMovies: "movies",
    ratingTagsOnSeries: "series",
    ratingTagsOnSeasons: "seasons",
    ratingTagsOnEpisodes: "episodes",
    ratingTagsOnContinueWatching: "continueWatching",
    ratingTagsOnNextUp: "nextUp"
  };
  function createRatingTags(ctx) {
    const JE = ctx.core;
    const logPrefix = "🪼 Jellyfin Enhanced: Rating Tags:";
    const containerClass = "rating-overlay-container";
    const tagClass = "rating-tag";
    const PENDING_RETRY_MS = 60 * 1e3;
    function normalizeCriticPercent(raw) {
      if (raw === null || raw === void 0) return null;
      const num = Number(raw);
      if (!Number.isFinite(num)) return null;
      return Math.max(0, Math.min(100, Math.round(num)));
    }
    const ITEM_TYPE_SCOPES = {
      Movie: { userKey: "ratingTagsOnMovies", pluginKey: "RatingTagsOnMovies" },
      Series: { userKey: "ratingTagsOnSeries", pluginKey: "RatingTagsOnSeries" },
      Season: { userKey: "ratingTagsOnSeasons", pluginKey: "RatingTagsOnSeasons" },
      Episode: { userKey: "ratingTagsOnEpisodes", pluginKey: "RatingTagsOnEpisodes" }
    };
    const HOME_ROW_SCOPES = {
      continuewatching: { userKey: "ratingTagsOnContinueWatching", pluginKey: "RatingTagsOnContinueWatching" },
      nextup: { userKey: "ratingTagsOnNextUp", pluginKey: "RatingTagsOnNextUp" }
    };
    const HOME_ROW_SCOPE_LIST = Object.values(HOME_ROW_SCOPES);
    function isScopeEnabled(scope) {
      const id = export9(SCOPE_OF_KEY, scope.userKey);
      if (id && JE.core?.tagScopes) return JE.core.tagScopes.allows("rating", id);
      const u = JE.currentSettings?.[scope.userKey];
      if (typeof u === "boolean") return u;
      const a = JE.pluginConfig?.[scope.pluginKey];
      return typeof a === "boolean" ? a : true;
    }
    function isExcludedByScope(el, type) {
      const itemType = el.closest("[data-type]")?.getAttribute("data-type") || (typeof type === "string" ? type : null);
      const typeScope = itemType ? export9(ITEM_TYPE_SCOPES, itemType) : null;
      if (typeScope && !isScopeEnabled(typeScope)) return true;
      if (typeof JE.detectCardRowSurface === "function" && HOME_ROW_SCOPE_LIST.some((scope) => !isScopeEnabled(scope))) {
        const rowScope = export9(HOME_ROW_SCOPES, JE.detectCardRowSurface(el));
        if (rowScope && !isScopeEnabled(rowScope)) return true;
      }
      return false;
    }
    JE.isRatingTagExcludedByScope = isExcludedByScope;
    function isSuppressionPending() {
      try {
        const sg = ctx.peer("spoilerBlur");
        if (!sg || JE.pluginConfig?.SpoilerBlurEnabled !== true) return false;
        if (typeof sg.isLoaded === "function") return sg.isLoaded() !== true;
        return typeof sg.isLoadOk === "function" && sg.isLoadOk() !== true;
      } catch {
        return false;
      }
    }
    function shouldSuppressRatingTag(item) {
      try {
        if (!item) return false;
        if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return false;
        if (JE.pluginConfig.SpoilerStripRatings === false) return false;
        const sg = ctx.peer("spoilerBlur");
        if (!sg || typeof sg.isEnabledFor !== "function") return false;
        if (typeof sg.getUserPrefs === "function") {
          if (sg.getUserPrefs()?.HideRatings === false) return false;
        }
        const stateReady = typeof sg.isLoadOk === "function" ? sg.isLoadOk() === true : true;
        if (item.Type === "Series") {
          if (!item.Id) return false;
          return stateReady ? sg.isEnabledFor(item.Id) === true : true;
        }
        if (item.Type === "Season") {
          if (!item.SeriesId) return false;
          return stateReady ? sg.isEnabledFor(item.SeriesId) === true : true;
        }
        if (item.Type === "Episode") {
          if (export10(item.UserData).Played === true) return false;
          if (!item.SeriesId) return false;
          return stateReady ? sg.isEnabledFor(item.SeriesId) === true : true;
        }
        return false;
      } catch (e) {
        return !!(JE.pluginConfig && JE.pluginConfig.SpoilerBlurEnabled === true);
      }
    }
    function getCachedEntry(ctx2, itemId) {
      const entry = ctx2.getPersistent(itemId) ?? ctx2.hot?.get(itemId);
      if (!entry) return null;
      const refreshAt = export4(entry) ? export22(entry.refreshAt) : null;
      if (refreshAt !== null && Date.now() >= refreshAt) return null;
      if (typeof entry === "string" || typeof entry === "number") {
        return { tmdb: String(entry), critic: null };
      }
      if (export4(entry)) {
        return {
          ...entry,
          tmdb: entry.tmdb ?? null,
          critic: entry.critic ?? null
        };
      }
      return null;
    }
    function setCachedEntry(ctx2, itemId, rating) {
      ctx2.setPersistent(itemId, rating);
      ctx2.hot?.set(itemId, rating);
    }
    function applyRatingTag(ctx2, el, rating) {
      if (!rating) return;
      const facts = JE.ratingSources.resolve(rating.tmdb, rating.critic, rating.ratings);
      ctx2.removeExistingOverlay(el);
      if (!facts.length) return;
      const container = document.createElement("div");
      container.className = containerClass;
      for (const fact of facts) container.appendChild(JE.ratingSources.chip(fact));
      ctx2.commitOverlay(el, container);
    }
    const spec = {
      logPrefix,
      settingKey: "ratingTagsEnabled",
      containerClass,
      taggedAttr: "jeRatingTagged",
      styleId: "jellyfin-enhanced-rating-tags-css",
      position: { userKey: "ratingTagsPosition", pluginKey: "RatingTagsPosition", fallback: "bottom-right" },
      cache: {
        key: "JellyfinEnhanced-ratingTagsCache",
        legacyPrefix: "ratingTagsCache",
        hotBucket: "rating",
        // Pre-factory ratingtags only saved via the cache manager (no
        // beforeunload hook) — preserved.
        saveOnUnload: false
      },
      buildCss() {
        return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-end;
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: calc(4px * var(--je-tag-scale, 1));
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    background: rgba(0, 0, 0, 0.8);
                    color: #ffc107;
                    font-size: calc(13px * var(--je-tag-scale, 1));
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

                .rating-star-icon { color: #ffc107 !important; font-size: calc(14px * var(--je-tag-scale, 1)); line-height: 1; }
                .rating-tomato-icon { width: calc(14px * var(--je-tag-scale, 1)); height: calc(14px * var(--je-tag-scale, 1)); flex-shrink: 0; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
                .rating-tomato-icon.fresh { background-image: url(assets/img/fresh.svg); }
                .rating-tomato-icon.rotten { background-image: url(assets/img/rotten.svg); }
                .rating-text { line-height: 1; }
                .je-rating-source-logo { display: inline-flex; width: calc(14px * var(--je-tag-scale, 1)); height: calc(14px * var(--je-tag-scale, 1)); flex-shrink: 0; }
                .je-rating-source-logo :is(svg, img) { width: 100%; height: 100%; display: block; object-fit: contain; }
                .rating-tag--source { color: #fff; }
                .rating-tag[data-je-rating-compact] > :first-child { display: none; }
                .rating-tag[data-je-rating-compact]::before { content: ''; width: calc(2px * var(--je-tag-scale, 1)); height: calc(2px * var(--je-tag-scale, 1)); border-radius: 50%; background: var(--je-rating-source-color); }


                .layout-mobile .${tagClass} {
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    font-size: calc(11px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }
                .layout-mobile .${containerClass} { gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                .layout-mobile .rating-star-icon { font-size: calc(12px * var(--je-tag-scale, 1)) !important; }
                .layout-mobile .rating-tomato-icon { width: calc(12px * var(--je-tag-scale, 1)); height: calc(12px * var(--je-tag-scale, 1)); }

                @media (max-width: 768px) {
                    .${tagClass} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                    .${containerClass} { gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                }

                @media (max-width: 480px) {
                    .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                    .rating-star-icon { font-size: calc(clamp(10px, 2.5vw, 11px) * var(--je-tag-scale, 1)) !important; }
                    .rating-tomato-icon { width: calc(clamp(10px, 2.5vw, 11px) * var(--je-tag-scale, 1)); height: calc(clamp(10px, 2.5vw, 11px) * var(--je-tag-scale, 1)); }
                }
            `;
      },
      pipeline: {
        needsFirstEpisode: false,
        needsParentSeries: false,
        render(ctx2, el, item, extras) {
          if (ctx2.shouldIgnore(el)) return;
          if (ctx2.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          if (isExcludedByScope(el, item.Type)) {
            ctx2.markTagged(el);
            return;
          }
          const itemId = String(item.Id);
          if (shouldSuppressRatingTag(item)) {
            ctx2.markTagged(el);
            if (!isSuppressionPending() && typeof JE.appendUserRatingToContainer === "function") {
              JE.appendUserRatingToContainer(el, item, extras);
            }
            return;
          }
          const cached = getCachedEntry(ctx2, itemId);
          if (cached && cached.tmdb !== void 0) {
            if (cached.tmdb || cached.critic !== null || cached.ratings) {
              applyRatingTag(ctx2, el, cached);
            }
            if (typeof JE.appendUserRatingToContainer === "function") {
              JE.appendUserRatingToContainer(el, item, extras);
            }
            return;
          }
          let sourceItem = item;
          if (extras.ratingParentSeries && !item.CommunityRating && !item.CriticRating) {
            sourceItem = extras.ratingParentSeries;
          }
          const tmdb = sourceItem.CommunityRating != null ? parseFloat(String(sourceItem.CommunityRating)).toFixed(1) : null;
          const critic = sourceItem.CriticRating != null ? normalizeCriticPercent(sourceItem.CriticRating) : null;
          const rating = { tmdb, critic, ratings: item.Ratings ?? extras.ratingParentSeries?.Ratings };
          const providers = export10(item.ProviderIds);
          const seriesProviders = export10(extras?.parentSeries?.ProviderIds);
          const tmdbId = providers.Tmdb || providers.tmdb || null;
          const seriesTmdbId = seriesProviders.Tmdb || seriesProviders.tmdb || null;
          const tmdbMediaType = item.Type === "Series" ? "tv" : "movie";
          const serverRefreshAt = export22(item.RatingsRefreshAt);
          const refreshAt = item.RatingsPending === true ? Date.now() + PENDING_RETRY_MS : serverRefreshAt !== null ? Math.max(serverRefreshAt, Date.now() + PENDING_RETRY_MS) : null;
          setCachedEntry(ctx2, itemId, {
            ...rating,
            ...refreshAt !== null ? { refreshAt } : {},
            tmdbId,
            seriesTmdbId,
            tmdbMediaType,
            seasonNumber: item.IndexNumber ?? null,
            episodeNumber: item.Type === "Episode" ? item.IndexNumber : null,
            parentSeasonNumber: item.Type === "Episode" ? item.ParentIndexNumber : null,
            sgType: item.Type,
            sgSeriesId: item.SeriesId || (item.Type === "Series" ? item.Id : null),
            sgPlayed: export10(item.UserData).Played === true
          });
          if (tmdb || critic !== null || rating.ratings) {
            applyRatingTag(ctx2, el, rating);
            if (typeof JE.appendUserRatingToContainer === "function") {
              JE.appendUserRatingToContainer(el, item, extras);
            }
          } else if (typeof JE.appendUserRatingToContainer === "function") {
            JE.appendUserRatingToContainer(el, item, extras);
          }
        },
        renderFromCache(ctx2, el, itemId) {
          if (ctx2.isTagged(el)) return true;
          if (ctx2.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          const cached = getCachedEntry(ctx2, itemId);
          if (isExcludedByScope(el, cached?.sgType)) {
            ctx2.markTagged(el);
            return true;
          }
          if (!cached) return false;
          if (shouldSuppressRatingTag({
            Type: cached.sgType,
            Id: itemId,
            SeriesId: cached.sgSeriesId,
            UserData: { Played: cached.sgPlayed === true }
          })) {
            ctx2.markTagged(el);
            if (isSuppressionPending()) return true;
            if (typeof JE.appendUserRatingToContainer === "function" && (cached.tmdbId || cached.seriesTmdbId)) {
              JE.appendUserRatingToContainer(el, {
                Type: cached.sgType,
                ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {},
                SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {}
              });
            }
            return true;
          }
          if (cached.tmdb || cached.critic !== null || cached.ratings) {
            applyRatingTag(ctx2, el, cached);
          }
          if (typeof JE.appendUserRatingToContainer === "function" && (cached.tmdbId || cached.seriesTmdbId)) {
            const syntheticItem = {
              Type: cached.tmdbMediaType === "tv" ? "Series" : "Movie",
              ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {},
              SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {},
              IndexNumber: cached.seasonNumber,
              ParentIndexNumber: cached.parentSeasonNumber
            };
            if (cached.seriesTmdbId && cached.episodeNumber != null) {
              syntheticItem.Type = "Episode";
              syntheticItem.IndexNumber = cached.episodeNumber;
              syntheticItem.ParentIndexNumber = cached.parentSeasonNumber;
            } else if (cached.seriesTmdbId && cached.seasonNumber != null) {
              syntheticItem.Type = "Season";
              syntheticItem.IndexNumber = cached.seasonNumber;
            }
            JE.appendUserRatingToContainer(el, syntheticItem);
          }
          return true;
        },
        renderFromServerCache(ctx2, el, entry, itemId) {
          if (ctx2.isTagged(el)) return;
          if (ctx2.shouldIgnore(el)) return;
          if (isExcludedByScope(el, entry.Type)) {
            ctx2.markTagged(el);
            return;
          }
          const suppressed = (entry.Type === "Series" || entry.Type === "Season") && shouldSuppressRatingTag({
            Type: entry.Type,
            Id: itemId,
            SeriesId: entry.SeriesId
          });
          if (suppressed) {
            ctx2.markTagged(el);
            if (isSuppressionPending()) return;
          } else {
            const tmdb = entry.CommunityRating != null ? parseFloat(String(entry.CommunityRating)).toFixed(1) : null;
            const critic = entry.CriticRating != null ? normalizeCriticPercent(entry.CriticRating) : null;
            if (tmdb || critic !== null || entry.Ratings) {
              applyRatingTag(ctx2, el, { tmdb, critic, ratings: entry.Ratings });
            }
          }
          if (typeof JE.appendUserRatingToContainer === "function") {
            const syntheticItem = {
              Type: entry.Type,
              ProviderIds: entry.TmdbId ? { Tmdb: entry.TmdbId } : {},
              SeriesProviderIds: entry.SeriesTmdbId ? { Tmdb: entry.SeriesTmdbId } : {},
              IndexNumber: entry.SeasonNumber,
              ParentIndexNumber: entry.SeasonNumber,
              // For Episode, SeasonNumber is ParentIndexNumber and EpisodeNumber is IndexNumber
              ...entry.Type === "Episode" ? { ParentIndexNumber: entry.SeasonNumber, IndexNumber: entry.EpisodeNumber } : {}
            };
            if (entry.TmdbId || entry.SeriesTmdbId) {
              JE.appendUserRatingToContainer(el, syntheticItem, null);
            }
          }
        }
      }
    };
    JE.initializeRatingTags = function() {
      console.log(`${logPrefix} Starting...`);
      const ctx2 = JE.core.tagRenderer.register("rating", spec);
      ctx2.injectCss();
      console.log(`${logPrefix} Initialized successfully.`);
    };
    JE.reinitializeRatingTags = function() {
      JE.core.tagRenderer.reinitialize("rating", spec);
    };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/ratings/ratingtags-entry.ts
  createRatingTags(export2());
})();
})();
//# sourceMappingURL=ratingtags.js.map
