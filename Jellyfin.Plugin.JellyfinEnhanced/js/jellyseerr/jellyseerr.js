(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared2 = core.core?.featureContext;
    if (typeof shared2 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared2(feature, core, slots);
  }
  function publishSharedModules(modules) {
    const JE = window.JellyfinEnhanced;
    if (!JE) return;
    const core = JE.core ?? (JE.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/core/ui/icon-markup.ts
  var icon_markup_exports = {};
  __export(icon_markup_exports, {
    ICONS: () => ICONS
  });
  var ICONS = Object.freeze({
    star: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="color:#ffc107;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path></svg>',
    available: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><polygon points="20.13,5.41 18.72,4 9.53,13.19 5.28,8.95 3.87,10.36 9.53,16.02"/><rect height="2" width="14" x="5" y="18"/></svg>',
    error: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M12 7c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1s-1-.45-1-1V8c0-.55.45-1 1-1zm-.01-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm1-3h-2v-2h2v2z"/></svg>',
    cloud_off: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2L21 20.73 4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73z"></path></svg>',
    person_off: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M8.65,5.82C9.36,4.72,10.6,4,12,4c2.21,0,4,1.79,4,4c0,1.4-0.72,2.64-1.82,3.35L8.65,5.82z M20,17.17 c-0.02-1.1-0.63-2.11-1.61-2.62c-0.54-0.28-1.13-0.54-1.77-0.76L20,17.17z M20.49,20.49L3.51,3.51c-0.39-0.39-1.02-0.39-1.41,0l0,0 c-0.39,0.39-0.39,1.02,0,1.41l8.18,8.18c-1.82,0.23-3.41,0.8-4.7,1.46C4.6,15.08,4,16.11,4,17.22L4,20h13.17l1.9,1.9 c0.39,0.39,1.02,0.39,1.41,0l0,0C20.88,21.51,20.88,20.88,20.49,20.49z"/></svg>',
    pending: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M12,2C6.48,2,2,6.48,2,12c0,5.52,4.48,10,10,10s10-4.48,10-10C22,6.48,17.52,2,12,2z M12,20c-4.42,0-8-3.58-8-8 c0-4.42,3.58-8,8-8s8,3.58,8,8C20,16.42,16.42,20,12,20z"/><circle cx="7" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="17" cy="12" r="1.5"/></svg>',
    requested: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 000-1.5h-3.75V6z" clip-rule="evenodd"></path></svg>',
    partially_available: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M9.71 11.29a1 1 0 0 0-1.42 1.42l3 3A1 1 0 0 0 12 16a1 1 0 0 0 .72-.34l7-8a1 1 0 0 0-1.5-1.32L12 13.54z"/><path d="M21 11a1 1 0 0 0-1 1 8 8 0 0 1-8 8A8 8 0 0 1 6.33 6.36 7.93 7.93 0 0 1 12 4a8.79 8.79 0 0 1 1.9.22 1 1 0 1 0 .47-1.94A10.54 10.54 0 0 0 12 2a10 10 0 0 0-7 17.09A9.93 9.93 0 0 0 12 22a10 10 0 0 0 10-10 1 1 0 0 0-1-1z"/></svg>',
    cancel: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"></path></svg>',
    request: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-right:0.5em;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>'
  });

  // client/generated-shared/publish/js/jellyseerr/jellyseerr.js.ts
  publishSharedModules({ "features/seerr/core/ui/icon-markup": icon_markup_exports });

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE) {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE.internals || (JE.internals = {})
      });
      coreContexts.set(JE, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");
  var export26 = /* @__PURE__ */ sharedExport(shared, "parseItemAttribute");

  // client/src/features/seerr/core/search-query.ts
  function parseYearedQuery(raw) {
    const match = raw.match(/^(.*\S)\s*\((\d{4})\)\s*$/);
    return match && match[1] && match[2] ? { title: match[1], year: match[2] } : { title: raw, year: null };
  }
  function resultYear(item) {
    return item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || null;
  }
  function filterResultsByYear(results, year) {
    return year ? results.filter((item) => resultYear(item) === year) : results;
  }
  var TMDB_MAX_PAGE = 500;
  var MAX_SEARCH_PAGES_PER_LOAD = 4;
  function pagesToLoad(wantCards, fetched, rendered, remainingPages, pageBudget) {
    const yieldRatio = fetched >= 20 ? Math.min(1, Math.max(0.1, rendered / fetched)) : 0.9;
    return Math.min(
      MAX_SEARCH_PAGES_PER_LOAD,
      Math.max(1, remainingPages),
      pageBudget,
      Math.max(1, Math.ceil(wantCards / (20 * yieldRatio)))
    );
  }
  function withCollectionCards(results) {
    const out = results.slice();
    const cards = /* @__PURE__ */ new Map();
    results.forEach((item, position) => {
      const collection = item.mediaType === "movie" ? item.collection : null;
      if (!collection || !collection.id) return;
      const key = String(collection.id);
      if (cards.has(key)) return;
      cards.set(key, { position, card: {
        id: collection.id,
        mediaType: "collection",
        title: collection.name ?? null,
        name: collection.name ?? null,
        posterPath: collection.posterPath || null,
        backdropPath: collection.backdropPath || null,
        overview: `${collection.name ?? ""} Collection`,
        voteAverage: null,
        releaseDate: null
      } });
    });
    for (const { card, position } of [...cards.values()].sort((a, b) => b.position - a.position)) out.splice(position + 1, 0, card);
    return out;
  }

  // client/src/features/seerr/core/runtime.ts
  function groupInternals(JE) {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE, name) {
    const internals = groupInternals(JE);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }
  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  function escapeWith(JE) {
    return (value) => {
      const escape = JE.escapeHtml;
      if (typeof escape === "function") return escape(value);
      return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
    };
  }
  function translated(JE, key, fallback, params) {
    const text2 = params ? JE.t(key, params) : JE.t(key);
    return text2 && text2 !== key ? text2 : fallback;
  }
  function text(read) {
    try {
      const value = read();
      return export22(value) && value ? value : null;
    } catch {
      return null;
    }
  }
  function captureOrigin(host) {
    const session = host.JE.session;
    const epoch = session ? session.getEpoch() : null;
    const user = () => text(() => host.apiClient()?.getCurrentUserId?.());
    const server = () => text(() => {
      const client = host.apiClient();
      const id = client?.serverId;
      return typeof id === "function" ? Reflect.apply(id, client, []) : id;
    });
    const startClient = host.apiClient();
    const root = () => text(() => host.apiClient()?.getUrl("/"));
    const token = () => text(() => host.apiClient()?.accessToken?.());
    const startRoot = root();
    const startToken = token();
    const startUser = user();
    const startServer = server();
    return {
      epoch,
      current: () => host.apiClient() === startClient && root() === startRoot && token() === startToken && (!session || epoch === null || session.isCurrent(epoch)) && user() === startUser && server() === startServer
    };
  }
  function isViewCurrent(host, element) {
    const owners = groupInternals(host.JE).viewOrigins;
    for (let node = element; node; node = node.parentElement) {
      if (owners?.get(node)?.current() === false) return false;
    }
    return true;
  }
  function thrownProperty(error, key) {
    if (typeof error !== "object" || error === null) return void 0;
    const value = Reflect.get(error, key);
    return value;
  }
  function isAbortError(error) {
    return thrownProperty(error, "name") === "AbortError";
  }
  function errorStatus(error) {
    const status = thrownProperty(error, "status");
    return export18(status) ? status : null;
  }
  function errorBody(error) {
    const body = thrownProperty(error, "responseJSON");
    if (!export19(body)) return { message: null, code: null, requestOutcome: null };
    return {
      message: export22(body.message) && body.message ? body.message : null,
      code: export22(body.code) && body.code ? body.code : null,
      requestOutcome: body.requestOutcome === "unknown" || body.requestOutcome === "rejected" || body.requestOutcome === "not_sent" ? body.requestOutcome : null
    };
  }
  var RequestNotSentError = class extends Error {
    constructor(reason, detail) {
      super(detail);
      this.reason = reason;
      this.name = "SeerrRequestNotSent";
    }
  };
  function classifyFailure(error, quotaEnabled) {
    if (error instanceof RequestNotSentError || error instanceof Error && error.name === "SeerrRequestNotSent") return "not-sent";
    const status = errorStatus(error);
    const { message, requestOutcome } = errorBody(error);
    if (requestOutcome === "unknown") return "uncertain";
    if (requestOutcome === "not_sent") return "not-sent";
    if (status === null || status >= 500 && requestOutcome !== "rejected") return "uncertain";
    if (status === 403 && quotaEnabled && /quota\s+exceeded/i.test(message || "")) return "quota";
    if (status === 404) return "user-not-found";
    if (status === 403) return "permission";
    return "rejected";
  }
  function uncertainMessage(JE) {
    return translated(JE, "jellyseerr_request_outcome_unknown", "Request status unknown. Check Seerr before requesting again.");
  }
  function hashQuery(location) {
    const query = location.hash.split("?")[1];
    return new URLSearchParams(query).get("query");
  }

  // client/src/features/seerr/core/search.ts
  var LOG = "🪼 Jellyfin Enhanced: Seerr:";
  var COLLECTION_SETTLE_MS = 300;
  var SEARCH_DEBOUNCE_MS = 200;
  var TYPING_GAP_MAX_MS = 450;
  var RENDER_HOLD_MARGIN_MS = 30;
  var USER_WAIT_TIMEOUT_MS = 2e4;
  function installSearch(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "search")) return;
    const seerr = seerrCoreContext(JE);
    let initialized = false;
    JE.initializeJellyseerrScript = function initializeJellyseerrScript() {
      if (!JE.pluginConfig?.JellyseerrEnabled) {
        console.log("🪼 Jellyfin Enhanced: Seerr Search: Integration is disabled in plugin settings.");
        return;
      }
      if (JE.pluginConfig.JellyseerrShowSearchResults === false) {
        console.log("🪼 Jellyfin Enhanced: Seerr Search: Search results are disabled in plugin settings.");
        return;
      }
      if (initialized) return;
      const api0 = JE.jellyseerrAPI;
      const ui0 = JE.jellyseerrUI;
      if (!api0 || !ui0) {
        console.warn(`${LOG} Seerr API/UI not loaded; search integration unavailable.`);
        return;
      }
      initialized = true;
      start(api0, ui0);
    };
    function start(api, ui) {
      console.log(`${LOG} Initializing...`);
      const escapeHtml = escapeWith(JE);
      const internals = groupInternals(JE);
      const icons = () => internals.icons ?? ICONS;
      const session = JE.session;
      const epochNow = () => session ? session.getEpoch() : 0;
      const epochCurrent = (epoch) => !session || session.isCurrent(epoch);
      let lastProcessedQuery = null;
      let fetchingQuery = null;
      let pendingRender = null;
      let pendingRenderTimer = null;
      let lastInputAt = 0;
      let lastInputGapMs = 0;
      let typingGapMs = 0;
      let collectionsSettleAt = 0;
      let collectionQueue = Promise.resolve();
      let collectionRowId = 0;
      let unfinishedCollections = [];
      let batchRendering = null;
      let debounceTimeout = null;
      let isJellyseerrActive = false;
      let jellyseerrUserFound = false;
      let isJellyseerrOnlyMode = false;
      let hiddenSections = [];
      let originalPosition = null;
      let movedSection = null;
      let generation = 0;
      let searchCurrentPage = 0;
      let searchTotalPages = 0;
      let searchIsLoading = false;
      let searchHasMore = false;
      const searchScrollState = {};
      let searchDeduplicator = null;
      let searchSignal = null;
      let searchSuspended = false;
      let navigateSettleTimer = null;
      const searchYield = { fetched: 0, rendered: 0 };
      const clearTimer = (timer) => {
        if (timer !== null) window2.clearTimeout(timer);
      };
      const searchInput = (visibleOnly = false) => {
        const input = document2.querySelector(visibleOnly ? "#searchPage:not(.hide) #searchTextInput" : "#searchPage #searchTextInput");
        return input instanceof HTMLInputElement ? input : null;
      };
      const updateIcon = () => ui.updateJellyseerrIcon?.(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, toggleJellyseerrOnlyMode);
      const hidden = (items) => {
        const hiddenContent = seerr.peer("hiddenContent");
        return hiddenContent?.filterJellyseerrResults ? hiddenContent.filterJellyseerrResults(items, "search") : items;
      };
      const abortSignal = () => JE.requestManager?.getAbortSignal?.("jellyseerr-search") || null;
      const createCard = (item) => ui.createJellyseerrCard?.(item, isJellyseerrActive, jellyseerrUserFound) ?? null;
      function restoreNativeResults() {
        hiddenSections.forEach((section) => section.classList.remove("section-hidden"));
        hiddenSections = [];
        if (movedSection?.parentNode && originalPosition?.parentNode) {
          originalPosition.parentNode.insertBefore(movedSection, originalPosition);
        }
        originalPosition?.remove();
        originalPosition = null;
        movedSection = null;
        isJellyseerrOnlyMode = false;
      }
      function toggleJellyseerrOnlyMode() {
        const searchPage = document2.querySelector("#searchPage");
        if (!searchPage) {
          restoreNativeResults();
          updateIcon();
          return;
        }
        if (!isJellyseerrOnlyMode) {
          isJellyseerrOnlyMode = true;
          const sections = searchPage.querySelectorAll(".verticalSection:not(.jellyseerr-section), .noItemsMessage");
          hiddenSections = Array.from(sections).filter((section) => !section.classList.contains("section-hidden"));
          hiddenSections.forEach((section) => section.classList.add("section-hidden"));
          const seerrSection = searchPage.querySelector(".jellyseerr-section");
          const results = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
          if (seerrSection?.parentNode && results) {
            originalPosition = document2.createElement("div");
            originalPosition.id = "jellyseerr-placeholder";
            movedSection = seerrSection;
            seerrSection.parentNode.insertBefore(originalPosition, seerrSection);
            results.insertBefore(seerrSection, results.firstChild);
          }
          JE.toast?.(JE.t("jellyseerr_toast_filter_on"), 3e3);
        } else {
          restoreNativeResults();
          JE.toast?.(JE.t("jellyseerr_toast_filter_off"), 3e3);
        }
        const title = searchPage.querySelector(".jellyseerr-section .sectionTitle");
        if (title) {
          const text2 = isJellyseerrOnlyMode ? JE.t("jellyseerr_results_title") : JE.t("jellyseerr_discover_title");
          const node = title.firstChild;
          if (node && node.nodeType === Node.TEXT_NODE) node.nodeValue = text2;
          else title.insertBefore(document2.createTextNode(text2), title.firstChild);
        }
        updateIcon();
      }
      function resetSearchPagination() {
        searchCurrentPage = 0;
        searchTotalPages = 0;
        searchIsLoading = false;
        searchHasMore = false;
        searchYield.fetched = 0;
        searchYield.rendered = 0;
        searchDeduplicator?.clear();
        JE.seamlessScroll?.cleanupInfiniteScroll(searchScrollState);
      }
      function filterLibraryItems(results) {
        if (JE.pluginConfig?.JellyseerrSearchExcludeLibraryItems !== true) return results;
        return results.filter((item) => !ui.isInLibrary?.(item));
      }
      const applyFilters = (results) => filterLibraryItems(hidden(results));
      function prefetchSearchPages(query, count, signal) {
        if (!searchHasMore || signal?.aborted) return;
        const { title } = parseYearedQuery(query);
        const last = Math.min(searchTotalPages, searchCurrentPage + Math.max(1, count));
        for (let page = searchCurrentPage + 1; page <= last; page++) api.search(title, page, { signal }).catch(() => void 0);
      }
      function insertCollectionCards(enriched) {
        const container = document2.querySelector(".jellyseerr-section .itemsContainer");
        if (!container) return;
        enriched.forEach((item, i) => {
          if (item.mediaType !== "collection") return;
          if (searchDeduplicator && !searchDeduplicator.add(item)) return;
          const prev = enriched[i - 1];
          const anchor = prev ? container.querySelector(`.jellyseerr-more-info-link[data-tmdb-id="${prev.id}"][data-media-type="${escapeHtml(prev.mediaType)}"]`)?.closest(".card") : null;
          const card = () => createCard(item);
          if (anchor) {
            const built = card();
            if (built) anchor.after(built);
          } else if (batchRendering) {
            const rowId = collectionRowId;
            const append = () => {
              const built = rowId === collectionRowId && container.isConnected ? card() : null;
              if (built) container.appendChild(built);
            };
            batchRendering.then(append, append);
          } else {
            const built = card();
            if (built) container.appendChild(built);
          }
        });
      }
      function noteTyping() {
        const now = performance.now();
        const gap = now - lastInputAt;
        const steadyGap = gap <= TYPING_GAP_MAX_MS ? gap : 0;
        typingGapMs = steadyGap && lastInputGapMs ? Math.max(steadyGap, lastInputGapMs) : steadyGap;
        lastInputGapMs = steadyGap;
        lastInputAt = now;
      }
      function renderHoldRemaining() {
        if (!typingGapMs) return 0;
        return Math.max(0, lastInputAt + typingGapMs + RENDER_HOLD_MARGIN_MS - performance.now());
      }
      function renderWhenQuiet(query, apply) {
        pendingRender = { query, apply };
        flushPendingRender();
      }
      function flushPendingRender() {
        clearTimer(pendingRenderTimer);
        pendingRenderTimer = null;
        const pending = pendingRender;
        if (!pending) return;
        if (lastProcessedQuery !== pending.query) {
          pendingRender = null;
          return;
        }
        let wait = renderHoldRemaining();
        const input = searchInput();
        if (input && input.value !== pending.query) wait = Math.max(wait, lastInputAt + SEARCH_DEBOUNCE_MS + RENDER_HOLD_MARGIN_MS - performance.now());
        if (wait > 0) {
          pendingRenderTimer = window2.setTimeout(flushPendingRender, wait);
          return;
        }
        pendingRender = null;
        pending.apply();
      }
      function dropPendingRender() {
        clearTimer(pendingRenderTimer);
        pendingRenderTimer = null;
        pendingRender = null;
      }
      function isRowMissing(query) {
        return fetchingQuery !== query && pendingRender?.query !== query && !document2.querySelector(".jellyseerr-section");
      }
      function liveSearchSignal(query) {
        if (!searchSignal?.aborted) return searchSignal;
        const visible = searchInput(true);
        if (!visible || visible.value !== query) return false;
        searchSignal = abortSignal();
        return searchSignal;
      }
      function enrichWithCollections(results, query) {
        if (JE.pluginConfig?.ShowCollectionsInSearch === false || !results.some((item) => item.mediaType === "movie")) return;
        queueCollectionLookup({ results, query, rowId: collectionRowId, epoch: epochNow(), generation }, collectionsSettleAt);
      }
      function queueCollectionLookup(batch, settleAt) {
        collectionQueue = collectionQueue.then(async () => {
          const wait = Math.min(COLLECTION_SETTLE_MS, settleAt - performance.now());
          if (wait > 0) await new Promise((resolve) => window2.setTimeout(resolve, wait));
          await lookUpCollections(batch);
        }).catch(() => void 0);
      }
      function isCollectionRowCurrent(batch) {
        return batch.rowId === collectionRowId && lastProcessedQuery === batch.query && batch.generation === generation && epochCurrent(batch.epoch);
      }
      async function lookUpCollections(batch) {
        if (!isCollectionRowCurrent(batch)) return;
        unfinishedCollections = unfinishedCollections.filter(isCollectionRowCurrent);
        const visible = searchInput(true);
        if (visible && visible.value !== batch.query || searchSuspended || unfinishedCollections.length > 0) {
          unfinishedCollections.push(batch);
          return;
        }
        const signal = liveSearchSignal(batch.query);
        if (signal === false) return;
        let enriched = await prepareResultsWithCollections(batch.results, signal);
        if (!isCollectionRowCurrent(batch)) return;
        if (signal?.aborted) {
          unfinishedCollections.push(batch);
          return;
        }
        enriched = hidden(enriched);
        if (enriched.length > batch.results.length) insertCollectionCards(enriched);
      }
      function resumeCollections() {
        if (unfinishedCollections.length === 0) return;
        const visible = searchInput(true);
        if (!visible || visible.value !== lastProcessedQuery) return;
        const batches = unfinishedCollections;
        unfinishedCollections = [];
        for (const batch of batches) queueCollectionLookup(batch, 0);
      }
      function forgetCollections() {
        collectionRowId++;
        unfinishedCollections = [];
      }
      async function prepareResultsWithCollections(raw, signal) {
        let results = raw || [];
        if (JE.pluginConfig?.ShowCollectionsInSearch === false) return results;
        try {
          results = await api.addCollections(results, { signal });
        } catch (error) {
          console.debug(`${LOG} Collection addition failed:`, error);
        }
        return withCollectionCards(results);
      }
      JE.jellyseerr = {
        async fetchAndRenderResults(query, options = {}) {
          if (!isJellyseerrActive || !searchInput(true) || searchInput(true)?.value !== query) return;
          await fetchAndRenderResults(query, options);
        }
      };
      async function fetchAndRenderResults(query, options = {}) {
        const { skipCache = false } = options;
        lastProcessedQuery = query;
        fetchingQuery = query;
        dropPendingRender();
        forgetCollections();
        resetSearchPagination();
        searchDeduplicator = JE.seamlessScroll?.createDeduplicator?.() || null;
        const { title, year } = parseYearedQuery(query);
        const signal = abortSignal();
        searchSignal = signal;
        const startedGeneration = generation;
        let data;
        try {
          data = await api.search(title, 1, { skipCache, signal });
        } catch (error) {
          if (isAbortError(error)) return;
          throw error;
        } finally {
          if (fetchingQuery === query) fetchingQuery = null;
        }
        if (lastProcessedQuery !== query || startedGeneration !== generation) return;
        renderWhenQuiet(query, () => renderFirstPage(query, data, year));
      }
      function renderFirstPage(query, data, yearFilter) {
        let results = filterResultsByYear(data.results || [], yearFilter);
        searchCurrentPage = data.page || 1;
        searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
        searchHasMore = searchCurrentPage < searchTotalPages;
        searchYield.fetched += results.length;
        results = applyFilters(results);
        if (searchDeduplicator) results = searchDeduplicator.filter(results);
        searchYield.rendered += results.length;
        if (results.length > 0 || searchHasMore) ui.renderJellyseerrResults?.(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
        if (results.length > 0) {
          collectionsSettleAt = performance.now() + COLLECTION_SETTLE_MS;
          collectionQueue = Promise.resolve();
          enrichWithCollections(results, query);
        }
        if (searchHasMore) setupSearchInfiniteScroll(query);
      }
      async function loadMoreSearchResults(query, hint) {
        if (searchIsLoading || !searchHasMore || lastProcessedQuery !== query) return void 0;
        if (searchSuspended) return void 0;
        const liveSignal = liveSearchSignal(query);
        if (liveSignal === false) {
          searchHasMore = false;
          return void 0;
        }
        searchIsLoading = true;
        const signal = liveSignal || null;
        const firstPage = searchCurrentPage + 1;
        const { title, year } = parseYearedQuery(query);
        const startedGeneration = generation;
        try {
          const found = document2.querySelector(".jellyseerr-section .itemsContainer");
          const itemsContainer = found instanceof HTMLElement ? found : null;
          const wantCards = JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, 20) || 20;
          const budget = hint?.pageBudget;
          const pageBudget = typeof budget === "number" && Number.isFinite(budget) ? Math.max(1, budget) : Infinity;
          const count = pagesToLoad(wantCards, searchYield.fetched, searchYield.rendered, searchTotalPages - searchCurrentPage, pageBudget);
          const pages = [];
          for (let page = firstPage; page < firstPage + count; page++) pages.push(page);
          const settled = await Promise.allSettled(pages.map((page) => api.search(title, page, { signal, throwOnError: true })));
          if (lastProcessedQuery !== query || startedGeneration !== generation) return void 0;
          let results = [];
          let committed = 0;
          let firstError = null;
          for (let i = 0; i < settled.length; i++) {
            const outcome = settled[i];
            if (!outcome) break;
            if (outcome.status !== "fulfilled") {
              if (isAbortError(outcome.reason)) throw outcome.reason;
              firstError = outcome.reason;
              break;
            }
            results.push(...outcome.value.results || []);
            searchCurrentPage = outcome.value.page || pages[i] || searchCurrentPage;
            if (outcome.value.totalPages) searchTotalPages = Math.min(outcome.value.totalPages, TMDB_MAX_PAGE);
            committed++;
          }
          if (firstError && committed === 0) throw firstError;
          searchHasMore = searchCurrentPage < searchTotalPages;
          results = filterResultsByYear(results, year);
          searchYield.fetched += results.length;
          results = applyFilters(results);
          if (searchDeduplicator) results = searchDeduplicator.filter(results);
          searchYield.rendered += results.length;
          if (hint?.engaged) {
            const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pages.length);
            const prefetch = results.length > 0 ? count : Math.min(count, remainingBudget);
            if (prefetch > 0) prefetchSearchPages(query, prefetch, signal);
          }
          if (results.length > 0 && itemsContainer) {
            const slices = JE.discoveryFilter?.appendInSlices;
            if (slices) {
              const rowId = collectionRowId;
              const isCurrent = () => rowId === collectionRowId && lastProcessedQuery === query && itemsContainer.isConnected && startedGeneration === generation;
              const rendering = slices(itemsContainer, results, createCard, {
                syncCount: JE.discoveryFilter?.cardsInView?.(itemsContainer, { horizontal: true }) ?? 0,
                isCurrent
              });
              batchRendering = rendering;
              try {
                await rendering;
              } finally {
                if (batchRendering === rendering) batchRendering = null;
              }
              if (!isCurrent()) return void 0;
            } else {
              const fragment = document2.createDocumentFragment();
              for (const item of results) {
                const card = createCard(item);
                if (card) fragment.appendChild(card);
              }
              itemsContainer.appendChild(fragment);
            }
            enrichWithCollections(results, query);
          }
          return { pages: committed, rendered: itemsContainer ? results.length : 0 };
        } catch (error) {
          if (!isAbortError(error)) {
            console.warn(`${LOG} Failed to load more search results:`, error);
            searchCurrentPage = firstPage - 1;
            searchHasMore = true;
          }
          throw error;
        } finally {
          searchIsLoading = false;
        }
      }
      function setupSearchInfiniteScroll(query) {
        JE.seamlessScroll?.setupInfiniteScroll(
          searchScrollState,
          ".jellyseerr-section",
          (hint) => loadMoreSearchResults(query, hint),
          () => searchHasMore && !searchSuspended,
          () => searchIsLoading,
          { horizontal: true, trackSelector: ".itemsContainer", scrollerSelector: ".emby-scroller" }
        );
      }
      async function manualRefreshJellyseerrData(query) {
        const section = document2.querySelector(".jellyseerr-section");
        const itemsContainer = section?.querySelector(".itemsContainer");
        if (!query || !(itemsContainer instanceof HTMLElement)) return;
        console.log(`${LOG} Refreshing data for query: "${query}"`);
        const startedGeneration = generation;
        try {
          forgetCollections();
          resetSearchPagination();
          searchDeduplicator = JE.seamlessScroll?.createDeduplicator?.() || null;
          const signal = abortSignal();
          searchSignal = signal;
          const { title, year } = parseYearedQuery(query);
          const data = await api.search(title, 1, { signal, skipCache: true });
          let results = await prepareResultsWithCollections(filterResultsByYear(data.results || [], year), signal);
          if (startedGeneration !== generation || !itemsContainer.isConnected) return;
          results = applyFilters(results);
          searchCurrentPage = data.page || 1;
          searchTotalPages = Math.min(data.totalPages || 1, TMDB_MAX_PAGE);
          searchHasMore = searchCurrentPage < searchTotalPages;
          searchDeduplicator?.filter(results);
          ui.releasePosters?.(itemsContainer);
          while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
          for (const item of results) {
            const card = createCard(item);
            if (card) itemsContainer.appendChild(card);
          }
          ui.updateJellyseerrResults?.(results, isJellyseerrActive, jellyseerrUserFound, itemsContainer);
          if (searchHasMore) setupSearchInfiniteScroll(query);
        } catch (error) {
          if (!isAbortError(error)) console.warn(`${LOG} Failed to refresh Seerr data:`, error);
        }
      }
      function teardownRow() {
        clearTimer(debounceTimeout);
        debounceTimeout = null;
        dropPendingRender();
        forgetCollections();
        lastProcessedQuery = null;
        restoreNativeResults();
        resetSearchPagination();
        ui.clearInjectedSearchResults?.();
        updateIcon();
      }
      function initializePageObserver() {
        const handleSearch = () => {
          const input = searchInput();
          const currentQuery = input ? input.value : null;
          noteTyping();
          if (fetchingQuery !== null && fetchingQuery !== currentQuery) JE.requestManager?.abortRequest?.("jellyseerr-search");
          if (input && currentQuery?.trim()) {
            clearTimer(debounceTimeout);
            debounceTimeout = window2.setTimeout(() => {
              if (!isJellyseerrActive) {
                teardownRow();
                return;
              }
              const latestQuery = input.value;
              if (latestQuery === lastProcessedQuery && !isRowMissing(latestQuery)) {
                resumeCollections();
                return;
              }
              if (isJellyseerrOnlyMode) {
                restoreNativeResults();
                updateIcon();
              }
              lastProcessedQuery = latestQuery;
              resetSearchPagination();
              ui.clearInjectedSearchResults?.();
              void fetchAndRenderResults(latestQuery).catch((error) => console.warn(`${LOG} Search failed:`, error));
            }, SEARCH_DEBOUNCE_MS);
          } else {
            teardownRow();
          }
        };
        const tryAttachSearchListener = () => {
          updateIcon();
          const input = searchInput();
          if (!input || input.dataset.jellyseerrListener) return;
          console.debug(`${LOG} Search input found, attaching listener.`);
          input.addEventListener("input", handleSearch);
          input.dataset.jellyseerrListener = "true";
          document2.querySelector(".alphaPicker")?.addEventListener("click", () => window2.setTimeout(handleSearch, 100));
          handleSearch();
        };
        const handleNavigate = () => {
          const input = searchInput(true);
          if (!input) {
            teardownRow();
            return;
          }
          tryAttachSearchListener();
          if (isJellyseerrActive && input.value.trim() && input.value === lastProcessedQuery && isRowMissing(input.value)) {
            resetSearchPagination();
            void fetchAndRenderResults(input.value).catch((error) => console.warn(`${LOG} Search failed:`, error));
            return;
          }
          resumeCollections();
        };
        document2.addEventListener("jellyseerr-manual-refresh", () => {
          void manualRefreshJellyseerrData(searchInput()?.value ?? null);
        });
        JE.helpers?.onBodyMutation?.("jellyseerr-search-listener", tryAttachSearchListener);
        tryAttachSearchListener();
        const onNav = () => {
          searchSuspended = true;
          clearTimer(navigateSettleTimer);
          navigateSettleTimer = window2.setTimeout(() => {
            searchSuspended = false;
            handleNavigate();
            searchScrollState.fill?.();
          }, 200);
        };
        if (JE.helpers?.onNavigate) {
          JE.helpers.onNavigate(onNav);
        } else {
          window2.addEventListener("popstate", onNav);
          window2.addEventListener("hashchange", onNav);
        }
      }
      async function refreshStatus() {
        const startedGeneration = generation;
        const status = await api.checkUserStatus();
        if (startedGeneration !== generation) return;
        isJellyseerrActive = status.active;
        jellyseerrUserFound = status.userFound;
        console.debug(`${LOG} Status: active=${isJellyseerrActive}, userFound=${jellyseerrUserFound}`);
      }
      function waitForUserAndInitialize() {
        const startTime = Date.now();
        const checkForUser = async () => {
          const client = host.apiClient();
          if (client?.getCurrentUserId?.() && client.accessToken?.()) {
            console.log(`${LOG} User session found. Initializing...`);
            await refreshStatus();
            initializePageObserver();
            if (isJellyseerrActive && JE.pluginConfig?.JellyseerrShowGenreDiscovery !== false) {
              void Promise.all([
                JE.discoveryFilter?.fetchTmdbGenreList?.("tv", {})?.catch(() => void 0),
                JE.discoveryFilter?.fetchTmdbGenreList?.("movie", {})?.catch(() => void 0)
              ]).catch(() => void 0);
            }
          } else if (Date.now() - startTime > USER_WAIT_TIMEOUT_MS) {
            console.warn(`${LOG} Timed out waiting for user session. Features may be limited.`);
            initializePageObserver();
          } else {
            window2.setTimeout(() => {
              void checkForUser();
            }, 300);
          }
        };
        void checkForUser();
      }
      session?.onUserChange("jellyseerr-search", () => {
        generation++;
        isJellyseerrActive = false;
        jellyseerrUserFound = false;
        teardownRow();
        window2.setTimeout(() => {
          void refreshStatus().then(() => {
            updateIcon();
            const input = searchInput(true);
            if (isJellyseerrActive && input?.value.trim()) void fetchAndRenderResults(input.value).catch(() => void 0);
          });
        }, 0);
      });
      ui.addMainStyles?.();
      ui.addSeasonModalStyles?.();
      waitForUserAndInitialize();
      document2.addEventListener("touchstart", (event) => {
        if (!(event.target instanceof Element) || !event.target.closest(".jellyseerr-request-button")) {
          ui.toggleHoverPopoverLock?.(false);
          ui.hideHoverPopover?.();
        }
      }, { passive: true });
      document2.addEventListener("scroll", () => {
        ui.toggleHoverPopoverLock?.(false);
        ui.hideHoverPopover?.();
      }, true);
      document2.body.addEventListener("touchstart", (event) => {
        if (!(event.target instanceof Element) || !event.target.closest(".jellyseerr-card")) {
          document2.querySelectorAll(".jellyseerr-card.is-touch").forEach((card) => card.classList.remove("is-touch"));
        }
      }, { passive: true });
      document2.body.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest(".jellyseerr-button-group") && !target?.closest(".jellyseerr-4k-popup")) document2.querySelector(".jellyseerr-4k-popup")?.remove();
      });
      const titleFor = (card, item, fallback) => card?.querySelector(".cardText-first bdi")?.textContent || item?.name || item?.title || item?.originalName || item?.originalTitle || fallback;
      const failureText = (error, fallback, userNotFound) => {
        const kind = classifyFailure(error, JE.pluginConfig?.JellyseerrShowQuotaInfo !== false);
        if (kind === "uncertain") return uncertainMessage(JE);
        if (errorStatus(error) === 404) return userNotFound;
        return errorBody(error).message || fallback;
      };
      async function onPopupItem(item, event) {
        if (!isViewCurrent(host, item)) return;
        const action = item.dataset.action;
        const tmdbId = item.dataset.tmdbId;
        const mediaType = String(item.dataset.mediaType || "movie").toLowerCase();
        if (action !== "request4k" || !tmdbId) return;
        const popup = item.closest(".jellyseerr-4k-popup");
        item.disabled = true;
        item.innerHTML = '<span>Requesting...</span><span class="jellyseerr-button-spinner"></span>';
        const card = event.target instanceof Element ? event.target.closest(".jellyseerr-card") : null;
        const resultItem = export26(card?.querySelector(".jellyseerr-request-button")?.dataset.searchResultItem);
        const title = titleFor(card, resultItem, mediaType === "tv" ? "this show" : "this movie");
        if (mediaType === "tv") {
          popup?.remove();
          void ui.showSeasonSelectionModal?.(tmdbId, "tv", title, resultItem, true);
          return;
        }
        if (api.shouldShowAdvanced()) {
          popup?.remove();
          void ui.showMovieRequestModal?.(tmdbId, title, resultItem, true);
          return;
        }
        const origin = captureOrigin(host);
        try {
          const response = await api.requestMedia(tmdbId, "movie", {}, true, resultItem);
          if (!origin.current()) return;
          console.debug(`${LOG} Seerr 4K request response:`, response);
          JE.toast?.("4K request submitted successfully!", 3e3);
          popup?.remove();
          const query = hashQuery(window2.location);
          if (query) {
            window2.setTimeout(() => {
              if (origin.current() && searchInput(true)?.value === query) void fetchAndRenderResults(query, { skipCache: true }).catch(() => void 0);
            }, 1e3);
          }
        } catch (error) {
          if (!origin.current()) return;
          if (ui.isQuotaError?.(error)) await ui.showQuotaErrorDialog?.(error, "movie");
          else JE.toast?.(escapeHtml(failureText(error, "Failed to request 4K version", "User not found")), 4e3);
          item.disabled = false;
          item.innerHTML = "<span>Request in 4K</span>";
        }
      }
      async function onRequestButton(button) {
        if (!isViewCurrent(host, button)) return;
        const mediaType = button.dataset.mediaType;
        const tmdbId = button.dataset.tmdbId;
        const collectionId = button.dataset.collectionId;
        const resultItem = export26(button.dataset.searchResultItem);
        const card = button.closest(".jellyseerr-card");
        const title = titleFor(card, resultItem, mediaType === "movie" ? "this movie" : mediaType === "collection" ? "this collection" : "this show");
        if (mediaType === "collection" && collectionId) {
          void ui.showCollectionRequestModal?.(collectionId, title, resultItem);
          return;
        }
        if (mediaType === "tv" && tmdbId) {
          void ui.showSeasonSelectionModal?.(tmdbId, mediaType, title, resultItem);
          return;
        }
        if (mediaType !== "movie" || !tmdbId) return;
        if (api.shouldShowAdvanced()) {
          void ui.showMovieRequestModal?.(tmdbId, title, resultItem);
          return;
        }
        const origin = captureOrigin(host);
        button.disabled = true;
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_requesting")}</span><span class="jellyseerr-button-spinner"></span>`;
        const idle = () => `${icons().request}<span>${JE.t("jellyseerr_btn_request")}</span>`;
        try {
          await api.requestMedia(tmdbId, mediaType, {}, false, resultItem);
          if (!origin.current()) {
            button.disabled = false;
            button.innerHTML = idle();
            return;
          }
          button.innerHTML = `<span>${JE.t("jellyseerr_btn_requested")}</span>${icons().requested}`;
          button.classList.remove("jellyseerr-button-request");
          button.classList.add("jellyseerr-button-pending");
        } catch (error) {
          button.disabled = false;
          if (!origin.current()) {
            button.innerHTML = idle();
            return;
          }
          if (ui.isQuotaError?.(error)) {
            await ui.showQuotaErrorDialog?.(error, "movie");
            button.innerHTML = idle();
            return;
          }
          const message = failureText(error, JE.t("jellyseerr_btn_error"), JE.t("jellyseerr_btn_user_not_found"));
          button.innerHTML = `<span>${escapeHtml(message)}</span>${icons().error}`;
          button.classList.add("jellyseerr-button-error");
        }
      }
      document2.body.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const popupItem = target.closest(".jellyseerr-4k-popup-item");
        if (popupItem) {
          if (popupItem instanceof HTMLButtonElement) void onPopupItem(popupItem, event);
          return;
        }
        const button = target.closest(".jellyseerr-request-button");
        if (button instanceof HTMLButtonElement && !button.disabled) void onRequestButton(button);
      });
      console.log(`${LOG} Initialization complete.`);
    }
  }

  // client/src/features/seerr/core/search-entry.ts
  installSearch(seerrCoreHost());
})();
})();
//# sourceMappingURL=jellyseerr.js.map
