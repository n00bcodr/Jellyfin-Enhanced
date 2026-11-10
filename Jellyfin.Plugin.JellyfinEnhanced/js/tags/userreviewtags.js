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
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/src/features/media-tags/types/ratings/userreviewtags.ts
  function createUserReviewTags(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: User Review Tags:";
    const _reviewCache = /* @__PURE__ */ new Map();
    const _reviewCacheAt = /* @__PURE__ */ new Map();
    const _inFlight = /* @__PURE__ */ new Map();
    const _failedUntil = /* @__PURE__ */ new Map();
    const FAILURE_BACKOFF_MS = 60 * 1e3;
    const _staleInMap = /* @__PURE__ */ new Map();
    let _staleAllAt = -1;
    const BATCH_MAX_KEYS = 200;
    const BATCH_WINDOW_MS = 30;
    const TMDB_KEY_RE = /^\d+(:s\d+(:e\d+)?)?$/;
    const _queue = /* @__PURE__ */ new Map();
    let _flushTimer = null;
    const _batchControllers = /* @__PURE__ */ new Set();
    async function flushQueue() {
      if (_flushTimer !== null) {
        clearTimeout(_flushTimer);
        _flushTimer = null;
      }
      if (_queue.size === 0) return;
      const batch = Array.from(_queue.entries());
      _queue.clear();
      const epoch = JE.session ? JE.session.getEpoch() : 0;
      const isCurrent = () => !JE.session || JE.session.isCurrent(epoch);
      const controller = new AbortController();
      _batchControllers.add(controller);
      const requestedAt = performance.now();
      const settle = (cacheKey, entry, value, cacheable) => {
        if (isCurrent()) {
          if (cacheable && value !== void 0) {
            _reviewCache.set(cacheKey, value);
            _reviewCacheAt.set(cacheKey, requestedAt);
            _failedUntil.delete(cacheKey);
          }
          if (_inFlight.get(cacheKey) === entry.promise) _inFlight.delete(cacheKey);
        }
        entry.resolve(isCurrent() ? value : void 0);
      };
      try {
        const keys = batch.map(([cacheKey]) => cacheKey).join(",");
        const data = await JE.core.api.plugin(`/reviews/ratings?keys=${encodeURIComponent(keys)}`, {
          signal: controller.signal,
          priority: "low"
        });
        const ratings = export10(export10(data).ratings);
        for (const [cacheKey, entry] of batch) {
          const hit = export10(Object.prototype.hasOwnProperty.call(ratings, cacheKey) ? ratings[cacheKey] : null);
          const avg = typeof hit.average === "number" && Number.isFinite(hit.average) ? hit.average : null;
          settle(cacheKey, entry, avg, true);
        }
      } catch (e) {
        const aborted = export42(e) && e.name === "AbortError";
        if (!aborted) {
          console.warn(`${logPrefix} rating batch failed; retrying these ratings after ${FAILURE_BACKOFF_MS / 1e3}s.`, e);
          if (isCurrent()) {
            const until = Date.now() + FAILURE_BACKOFF_MS;
            for (const [cacheKey] of batch) _failedUntil.set(cacheKey, until);
          }
        }
        for (const [cacheKey, entry] of batch) settle(cacheKey, entry, aborted ? void 0 : null, false);
      } finally {
        _batchControllers.delete(controller);
      }
    }
    JE.session?.onUserChange("user-review-tags", () => {
      for (const controller of _batchControllers) controller.abort();
      _batchControllers.clear();
      if (_flushTimer !== null) {
        clearTimeout(_flushTimer);
        _flushTimer = null;
      }
      const orphaned = Array.from(_queue.values());
      _queue.clear();
      _reviewCache.clear();
      _reviewCacheAt.clear();
      _inFlight.clear();
      _failedUntil.clear();
      _staleInMap.clear();
      _staleAllAt = -1;
      for (const entry of orphaned) entry.resolve(void 0);
    });
    function hasFreshCached(cacheKey) {
      if (!_reviewCache.has(cacheKey)) return false;
      const pipeline = JE.tagPipeline;
      if (usableRatingMap(cacheKey) && typeof pipeline?.getReviewRatingsRequestedAt === "function" && pipeline.getReviewRatingsRequestedAt() > (_reviewCacheAt.get(cacheKey) ?? 0)) {
        _reviewCache.delete(cacheKey);
        _reviewCacheAt.delete(cacheKey);
        return false;
      }
      return true;
    }
    function usableRatingMap(cacheKey) {
      const pipeline = JE.tagPipeline;
      if (!pipeline || typeof pipeline.peekReviewRatings !== "function") return null;
      const map = pipeline.peekReviewRatings();
      if (!map) return null;
      const requestedAt = pipeline.getReviewRatingsRequestedAt();
      const staleAt = _staleInMap.get(cacheKey);
      if (requestedAt <= _staleAllAt || staleAt !== void 0 && requestedAt <= staleAt) return null;
      return map;
    }
    function peekUserRating(tmdbKey, mediaType) {
      if (!JE.pluginConfig?.ShowUserReviews) return null;
      const cacheKey = `${mediaType}:${tmdbKey}`;
      if (hasFreshCached(cacheKey)) return _reviewCache.get(cacheKey) ?? null;
      if (mediaType !== "movie" && mediaType !== "tv" || !TMDB_KEY_RE.test(tmdbKey)) return null;
      const map = usableRatingMap(cacheKey);
      if (map) return map.get(cacheKey) ?? null;
      return void 0;
    }
    async function fetchUserRating(tmdbKey, mediaType) {
      if (!JE.pluginConfig?.ShowUserReviews) return null;
      const cacheKey = `${mediaType}:${tmdbKey}`;
      if (hasFreshCached(cacheKey)) return _reviewCache.get(cacheKey) ?? null;
      if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
      const failedUntil = _failedUntil.get(cacheKey);
      if (failedUntil !== void 0) {
        if (Date.now() < failedUntil) return null;
        _failedUntil.delete(cacheKey);
      }
      if (mediaType !== "movie" && mediaType !== "tv" || !TMDB_KEY_RE.test(tmdbKey)) {
        _reviewCache.set(cacheKey, null);
        _reviewCacheAt.set(cacheKey, Infinity);
        return null;
      }
      if (typeof JE.tagPipeline?.getReviewRatings === "function") {
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        try {
          await JE.tagPipeline.getReviewRatings();
        } catch {
        }
        if (JE.session && !JE.session.isCurrent(epoch)) return void 0;
        const map = usableRatingMap(cacheKey);
        if (map) return map.get(cacheKey) ?? null;
        if (hasFreshCached(cacheKey)) return _reviewCache.get(cacheKey) ?? null;
        if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
      }
      const entry = { promise: null, resolve: () => {
      } };
      _queue.set(cacheKey, entry);
      const pending = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      entry.promise = pending;
      _inFlight.set(cacheKey, pending);
      if (_queue.size >= BATCH_MAX_KEYS) {
        flushQueue();
      } else if (_flushTimer === null) {
        _flushTimer = setTimeout(flushQueue, BATCH_WINDOW_MS);
      }
      return pending;
    }
    function appendUserRatingChip(container, rating) {
      container.querySelector(".je-userreview-tag")?.remove();
      const showDash = JE.pluginConfig?.ShowUserRatingDash !== false;
      if (rating === null && !showDash) return;
      const raw = rating !== null ? rating * 2 : null;
      const localNumber = JE.core?.mediaLanguage?.formatNumberText;
      const number = raw === null ? "" : Number.isInteger(raw) ? `${raw}` : `${raw.toFixed(1)}`;
      const displayText = raw === null ? "—" : localNumber ? localNumber(number) : number;
      const tag = document.createElement("div");
      tag.className = "rating-tag rating-tag-userreview je-userreview-tag";
      const icon = document.createElement("span");
      icon.className = "je-userreview-icon";
      icon.textContent = "person_heart";
      const text = document.createElement("span");
      text.className = "rating-text";
      text.textContent = displayText;
      tag.appendChild(icon);
      tag.appendChild(text);
      container.appendChild(tag);
    }
    function applyChipToGroup(layout, target, rating) {
      const existing = layout.getGroup(target, "rating");
      if (rating === null && JE.pluginConfig?.ShowUserRatingDash === false) {
        const stale = existing?.querySelector(".je-userreview-tag");
        if (!existing || !stale) return;
        stale.remove();
        if (existing.childElementCount === 0) layout.removeGroup(target, "rating");
        else layout.commitGroup(target, "rating", existing);
        return;
      }
      let master = existing;
      if (!master) {
        master = document.createElement("div");
        master.className = "rating-overlay-container";
      }
      appendUserRatingChip(master, rating);
      layout.commitGroup(target, "rating", master);
    }
    function applyChip(containerOrEl, rating, restack) {
      if (!containerOrEl.isConnected) return;
      const layout = JE.core?.tagLayout;
      if (layout && !containerOrEl.classList.contains("rating-overlay-container")) {
        applyChipToGroup(layout, containerOrEl, rating);
        return;
      }
      if (rating === null && JE.pluginConfig?.ShowUserRatingDash === false) {
        const stale = containerOrEl.classList.contains("je-userreview-tag") ? containerOrEl : containerOrEl.querySelector(".je-userreview-tag");
        if (!stale) return;
        const staleContainer = stale.closest(".rating-overlay-container");
        const host = staleContainer?.parentElement || null;
        stale.remove();
        if (staleContainer && staleContainer.childElementCount === 0) staleContainer.remove();
        if (restack && host && typeof JE.core?.tagRenderer?.scheduleCornerStacking === "function") {
          JE.core.tagRenderer.scheduleCornerStacking(host);
        }
        return;
      }
      let container = containerOrEl;
      if (!container.classList.contains("rating-overlay-container")) {
        container = containerOrEl.querySelector(".rating-overlay-container");
        if (!container) {
          container = document.createElement("div");
          container.className = "rating-overlay-container";
          const pos = JE.core?.tagRenderer?.resolvePosition?.("ratingTagsPosition", "RatingTagsPosition", "bottom-right");
          if (pos) container.dataset.jeCorner = pos.pos;
          containerOrEl.appendChild(container);
        }
      }
      appendUserRatingChip(container, rating);
      if (restack) {
        const host = container.parentElement;
        if (host && typeof JE.core?.tagRenderer?.scheduleCornerStacking === "function") {
          JE.core.tagRenderer.scheduleCornerStacking(host);
        }
      }
    }
    const _renderGeneration = /* @__PURE__ */ new WeakMap();
    const _reviewKeyOwner = /* @__PURE__ */ new WeakMap();
    function cardIdentity(el) {
      const holder = el.closest("[data-id]") || el.closest("[data-itemid]");
      const raw = holder?.getAttribute("data-id") || holder?.getAttribute("data-itemid") || "";
      return raw.replace(/-/g, "").toLowerCase();
    }
    function reviewKeyBelongs(el) {
      return _reviewKeyOwner.get(el) === cardIdentity(el);
    }
    function resolveTmdbKey(item, extras) {
      const type = item.Type || "";
      const providers = export10(item.ProviderIds);
      if (type === "Movie") {
        const id = providers.Tmdb || providers.tmdb;
        return id ? { tmdbKey: String(id), mediaType: "movie" } : null;
      }
      if (type === "Series") {
        const id = providers.Tmdb || providers.tmdb;
        return id ? { tmdbKey: String(id), mediaType: "tv" } : null;
      }
      if (type === "Season" || type === "Episode") {
        const series = export10(extras?.parentSeries?.ProviderIds);
        const own = export10(item.SeriesProviderIds);
        const seriesTmdbId = series.Tmdb || series.tmdb || own.Tmdb || own.tmdb;
        if (typeof seriesTmdbId !== "string" && typeof seriesTmdbId !== "number") return null;
        if (!seriesTmdbId) return null;
        if (type === "Season") {
          if (item.IndexNumber == null) return null;
          return { tmdbKey: `${seriesTmdbId}:s${String(item.IndexNumber)}`, mediaType: "tv" };
        } else {
          if (item.ParentIndexNumber == null || item.IndexNumber == null) return null;
          return { tmdbKey: `${seriesTmdbId}:s${String(item.ParentIndexNumber)}:e${String(item.IndexNumber)}`, mediaType: "tv" };
        }
      }
      return null;
    }
    JE.initializeUserReviewTags = function() {
      if (!JE.pluginConfig?.ShowUserReviews) {
        console.log(`${logPrefix} User reviews disabled, skipping.`);
        return;
      }
      if (!JE.pluginConfig?.ShowUserRatingOnPosters) {
        console.log(`${logPrefix} User rating on posters disabled, skipping.`);
        return;
      }
      if (!JE.currentSettings?.ratingTagsEnabled) {
        console.log(`${logPrefix} Rating tags disabled, skipping.`);
        return;
      }
      const css = `
            .je-userreview-tag { color: #e91e8c !important; }
            .je-userreview-icon {
                font-family: 'JE Material Symbols Rounded';
                font-size: calc(14px * var(--je-tag-scale, 1)) !important;
                font-weight: normal;
                font-style: normal;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
                color: #e91e8c !important;
                vertical-align: middle;
            }
        `;
      JE.core.ui.injectCss("je-userreview-tags-css", JE.core.tagLayout?.preserveLegacySizing?.(css) || css);
      if (!_listening && typeof JE.tagPipeline?.onReviewRatingsChanged === "function") {
        _listening = true;
        JE.tagPipeline.onReviewRatingsChanged(refreshChangedChips);
      }
      console.log(`${logPrefix} Initialized.`);
    };
    let _listening = false;
    function refreshChangedChips(changed) {
      if (!JE.pluginConfig?.ShowUserReviews || !JE.pluginConfig?.ShowUserRatingOnPosters || !JE.currentSettings?.ratingTagsEnabled) return;
      let keys = changed;
      if (keys) {
        for (const key of Array.from(_reviewCache.keys())) {
          if (!hasFreshCached(key)) keys.add(key);
        }
        if (keys.size === 0) return;
      }
      const hosts = document.querySelectorAll("[data-je-review-key]");
      for (const host of hosts) {
        const key = host.dataset.jeReviewKey;
        if (key === void 0 || keys && !keys.has(key)) continue;
        if (!reviewKeyBelongs(host)) {
          delete host.dataset.jeReviewKey;
          continue;
        }
        if (typeof JE.isRatingTagExcludedByScope === "function" && JE.isRatingTagExcludedByScope(host, null)) continue;
        const sep = key.indexOf(":");
        const rating = peekUserRating(key.slice(sep + 1), key.slice(0, sep));
        if (rating === void 0) continue;
        applyChip(host, rating, true);
      }
    }
    JE.appendUserRatingToContainer = function(containerOrEl, item, extras) {
      if (!JE.pluginConfig?.ShowUserReviews) return;
      if (!JE.pluginConfig?.ShowUserRatingOnPosters) return;
      if (!JE.currentSettings?.ratingTagsEnabled) return;
      const generation = (_renderGeneration.get(containerOrEl) || 0) + 1;
      _renderGeneration.set(containerOrEl, generation);
      const resolved = resolveTmdbKey(item, extras);
      if (!resolved) {
        delete containerOrEl.dataset.jeReviewKey;
        return;
      }
      const { tmdbKey, mediaType } = resolved;
      const reviewKey = `${mediaType}:${tmdbKey}`;
      containerOrEl.dataset.jeReviewKey = reviewKey;
      _reviewKeyOwner.set(containerOrEl, cardIdentity(containerOrEl));
      const known = peekUserRating(tmdbKey, mediaType);
      if (known !== void 0) {
        applyChip(containerOrEl, known, false);
        return;
      }
      fetchUserRating(tmdbKey, mediaType).then((rating) => {
        if (rating === void 0) return;
        if (_renderGeneration.get(containerOrEl) !== generation || containerOrEl.dataset.jeReviewKey !== reviewKey || !reviewKeyBelongs(containerOrEl)) return;
        const current = peekUserRating(tmdbKey, mediaType);
        applyChip(containerOrEl, current !== void 0 ? current : rating, true);
      });
    };
    JE.invalidateUserReviewTagCache = function(tmdbKey, mediaType) {
      const now = performance.now();
      if (!tmdbKey) {
        _reviewCache.clear();
        _reviewCacheAt.clear();
        _failedUntil.clear();
        _staleAllAt = now;
        return;
      }
      for (const type of mediaType ? [mediaType] : ["movie", "tv"]) {
        _reviewCache.delete(`${type}:${tmdbKey}`);
        _reviewCacheAt.delete(`${type}:${tmdbKey}`);
        _failedUntil.delete(`${type}:${tmdbKey}`);
        _staleInMap.set(`${type}:${tmdbKey}`, now);
      }
    };
  }

  // client/src/features/media-tags/types/ratings/userreviewtags-entry.ts
  createUserReviewTags(export4());
})();
})();
//# sourceMappingURL=userreviewtags.js.map
