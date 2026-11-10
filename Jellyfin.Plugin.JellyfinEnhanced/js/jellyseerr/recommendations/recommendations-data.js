(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/seerr/host-discovery.ts
  function discoveryHost() {
    const host = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
  }
  var discoveryContexts = /* @__PURE__ */ new WeakMap();
  function discoveryContext(JE) {
    let ctx = discoveryContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["recommendationsPage"],
        internalsObject: () => JE.internals ?? (JE.internals = {})
      });
      discoveryContexts.set(JE, ctx);
    }
    return ctx;
  }
  function filterOf(JE) {
    if (!JE.discoveryFilter) throw new Error("Discovery filter utilities are not loaded");
    return JE.discoveryFilter;
  }
  function identityKey(JE) {
    const session = JE.session;
    if (!session) return "";
    return `${session.getServerId?.() ?? ""}:${session.getUserId?.() ?? ""}:${session.getEpoch()}`;
  }

  // client/src/features/seerr/discovery/domain.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSeerrResult(value) {
    return isRecord(value);
  }
  function decodeError(what) {
    const error = new Error(`Unexpected ${what} response`);
    error.name = "DecodeError";
    return error;
  }
  function decodeFeedPage(value) {
    if (value === null || value === void 0) return { results: [] };
    if (!isRecord(value)) throw decodeError("feed page");
    const rows = value.results;
    if (rows !== null && rows !== void 0 && !Array.isArray(rows)) throw decodeError("feed page");
    const results = Array.isArray(rows) ? rows.filter(isSeerrResult) : [];
    const total = Number(value.totalPages);
    return total > 0 ? { results, totalPages: total } : { results };
  }
  function decodeGenreSlider(value) {
    if (!Array.isArray(value)) return [];
    const entries = [];
    for (const row of value) {
      if (!isRecord(row) || typeof row.id !== "number" || typeof row.name !== "string") continue;
      const backdrops = Array.isArray(row.backdrops) ? row.backdrops.filter((b) => typeof b === "string") : [];
      entries.push({ id: row.id, name: row.name, backdrops });
    }
    return entries;
  }

  // client/src/features/seerr/recommendations/stage.ts
  var LOG_PREFIX = "🪼 Jellyfin Enhanced: Recommendations:";
  var PAGE_ID = "je-recommendations-page";
  var CATEGORY_PAGE_ID = "je-recommendations-category-page";
  var PLUGIN_PAGE_LINK = 'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]';
  var SORT_MODULE = "recommendationsCategory";
  var FILTER_MODULE = "recommendationsTrending";
  var OTHER_PAGE = `.mainAnimatedPage:not(.hide):not(#${PAGE_ID}):not(#${CATEGORY_PAGE_ID})`;
  function recommendationsHost() {
    const { JE } = discoveryHost();
    const own = discoveryContext(JE).own;
    return { JE, P: own.recommendationsPage ?? (own.recommendationsPage = {}) };
  }
  function part(P, key) {
    const value = P[key];
    if (value === void 0 || value === null) throw new Error(`Recommendations module "${key}" is not loaded`);
    return value;
  }

  // client/src/features/seerr/recommendations/recommendations-data.ts
  var EMPTY_SLIDER_RETRY_MS = 60 * 1e3;
  var idleCategory = () => ({
    activeScrollObserver: null,
    isLoading: false,
    filtered: false,
    feeds: [],
    controller: null,
    yieldStats: { fetched: 0, rendered: 0 },
    shown: /* @__PURE__ */ new Set()
  });
  (function() {
    "use strict";
    const { JE, P } = recommendationsHost();
    const sidebar = document.querySelector(".mainDrawer-scrollContainer");
    const state = {
      pageVisible: false,
      previousPage: null,
      currentAbortController: null,
      categoryPageVisible: false,
      categoryPreviousPage: null,
      categoryReturnsToPage: false,
      categoryState: idleCategory(),
      renders: /* @__PURE__ */ new Map()
    };
    const fetchWithManagedRequest = (path, options) => filterOf(JE).fetchWithManagedRequest(path, "recommendations", options);
    function fetchAllRows(signal) {
      const load = async (row) => {
        try {
          return { row, results: decodeFeedPage(await fetchWithManagedRequest(`${row.path}?page=1`, { signal })).results, failed: false };
        } catch {
          return { row, results: [], failed: true };
        }
      };
      return Promise.all(part(P, "ROWS").map(load));
    }
    const genreSliders = /* @__PURE__ */ new Map();
    function fetchGenreSlider(mediaType) {
      const key = `${identityKey(JE)}|${mediaType}`;
      const cached = genreSliders.get(key);
      if (cached && Date.now() < cached.retryAt) return cached.promise;
      const entry = { promise: Promise.resolve([]), retryAt: Date.now() + EMPTY_SLIDER_RETRY_MS };
      entry.promise = Promise.resolve().then(() => JE.jellyseerrAPI?.fetchGenreSlider?.(mediaType)).then(decodeGenreSlider).catch(() => []).then((list) => {
        if (list.length > 0) entry.retryAt = Infinity;
        return list;
      });
      genreSliders.set(key, entry);
      return entry.promise;
    }
    function disposeRender(container) {
      const owner = state.renders.get(container);
      if (!owner) return;
      state.renders.delete(container);
      owner.controller.abort();
      if (state.currentAbortController === owner.controller) state.currentAbortController = null;
      owner.disposers.splice(0).forEach((stop) => stop());
      JE.jellyseerrUI?.releasePosters?.(container);
      container.replaceChildren();
    }
    function sweepRenders() {
      for (const container of [...state.renders.keys()]) if (!container.isConnected) disposeRender(container);
    }
    function resetIdentity() {
      P.hideCategoryPage?.();
      P.hidePage?.();
      for (const container of [...state.renders.keys()]) disposeRender(container);
      genreSliders.clear();
      P.MOVIE_GENRES = [];
      P.TV_GENRES = [];
      JE.discoveryFilter?.resetFilterMode(FILTER_MODULE);
      JE.discoveryFilter?.resetSortMode(SORT_MODULE);
    }
    JE.session?.onUserChange("recommendations-page", resetIdentity);
    P.logPrefix = LOG_PREFIX;
    P.sidebar = sidebar;
    P.pluginPagesExists = !!sidebar?.querySelector(PLUGIN_PAGE_LINK);
    P.state = state;
    P.fetchWithManagedRequest = fetchWithManagedRequest;
    P.fetchAllRows = fetchAllRows;
    P.fetchGenreSlider = fetchGenreSlider;
    P.disposeRender = disposeRender;
    P.sweepRenders = sweepRenders;
  })();
})();
})();
//# sourceMappingURL=recommendations-data.js.map
