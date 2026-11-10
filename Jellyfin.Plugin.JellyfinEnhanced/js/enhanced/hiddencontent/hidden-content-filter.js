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

  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
  function getApi() {
    const api = browser.ApiClient;
    if (!api) throw new Error("Hidden Content API unavailable");
    return api;
  }
  function registry(JE, name) {
    const internals = JE.internals ?? (JE.internals = {});
    if (name === "features") return internals.features ?? (internals.features = {});
    if (name === "hiddenContentPage") return internals.hiddenContentPage ?? (internals.hiddenContentPage = {});
    const surface = internals.hiddenContent ?? (internals.hiddenContent = {});
    return new Proxy(surface, { get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const value = Reflect.get(target, key);
      if (value === void 0) throw new Error(`Missing hidden-content loader dependency: ${key}`);
      return value;
    } });
  }
  function runtime(JE) {
    const internals = JE.internals ?? (JE.internals = {});
    if (internals.hiddenContentRuntime) return internals.hiddenContentRuntime;
    const state = { modules: /* @__PURE__ */ new Set(), view: 0, policy: 0, queues: /* @__PURE__ */ new Map(), cleanups: /* @__PURE__ */ new Set(), identityCleanups: /* @__PURE__ */ new Set() };
    internals.hiddenContentRuntime = state;
    const invalidate = () => {
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    window.addEventListener("hashchange", invalidate);
    window.addEventListener("popstate", invalidate);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", invalidateIdentity);
    JE.session?.onUserChange("hidden-content-runtime", invalidateIdentity);
    return state;
  }
  function installOnce(JE, name) {
    const modules = runtime(JE).modules;
    if (modules.has(name)) return false;
    modules.add(name);
    return true;
  }
  function lease(JE, view = false) {
    JE.session?.checkNow?.("hidden-content-operation");
    const state = runtime(JE), version = state.view, api = getApi();
    const epoch = JE.session?.getEpoch(), userId = api.getCurrentUserId(), root = api.getUrl("/"), token = api.accessToken?.(), route = location.hash;
    return { api, destination: JSON.stringify([root, userId]), current: () => {
      try {
        return browser.ApiClient === api && (epoch === void 0 || JE.session?.isCurrent(epoch) === true) && api.getCurrentUserId() === userId && api.getUrl("/") === root && api.accessToken?.() === token && (!view || location.hash === route && state.view === version);
      } catch {
        return false;
      }
    } };
  }
  function policyLease(JE) {
    const token = lease(JE, true), state = runtime(JE), policy = state.policy;
    return { current: () => token.current() && state.policy === policy };
  }

  // client/generated-shared/stub/client/src/features/hidden-content/model.ts
  var shared = /* @__PURE__ */ sharedModule("features/hidden-content/model");
  var export3 = /* @__PURE__ */ sharedExport(shared, "decodeLibraryItem");
  var export11 = /* @__PURE__ */ sharedExport(shared, "record");

  // client/src/features/hidden-content/hidden-content-filter.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-filter")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const { hiddenIdSet, normalizeId, getSettings, shouldFilterSurface, getHiddenData, getHiddenCount } = internal;
    const addLibraryHideButtons = () => internal.addLibraryHideButtons();
    const parentSeriesCache = /* @__PURE__ */ new Map();
    const parentSeriesRequestMap = /* @__PURE__ */ new Map();
    host.JellyfinEnhanced.session?.onUserChange("hidden-content-filter", () => {
      parentSeriesCache.clear();
      parentSeriesRequestMap.clear();
      try {
        document.querySelectorAll(".je-hidden").forEach((el) => el.classList.remove("je-hidden"));
        document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
          el.removeAttribute(PROCESSED_ATTR);
          el.removeAttribute(HIDDEN_PARENT_ATTR);
          el.removeAttribute(HIDDEN_DIRECT_ATTR);
        });
      } catch (e) {
        console.warn("🪼 Jellyfin Enhanced: hidden-content DOM reset on user switch failed", e);
      }
    });
    const sectionSurfaceCache = /* @__PURE__ */ new WeakMap();
    const DETAIL_RESCAN_DELAY_MS = 500;
    const DETAIL_FINAL_RESCAN_DELAY_MS = 1200;
    const NATIVE_FILTER_DEBOUNCE_MS = 50;
    const PROCESSED_ATTR = "data-je-hidden-checked";
    const HIDDEN_PARENT_ATTR = "data-je-hidden-parent-series-id";
    const HIDDEN_DIRECT_ATTR = "data-je-hidden-direct";
    const CARD_SEL = ".card[data-id], .card[data-itemid], .listItem[data-id]";
    const CARD_SEL_NEW = ".card[data-id]:not([data-je-hidden-checked]), .card[data-itemid]:not([data-je-hidden-checked]), .listItem[data-id]:not([data-je-hidden-checked])";
    async function getParentSeriesId(itemId) {
      if (parentSeriesCache.has(itemId)) {
        return parentSeriesCache.get(itemId);
      }
      if (parentSeriesRequestMap.has(itemId)) {
        return parentSeriesRequestMap.get(itemId);
      }
      const requestToken = lease(JE, true), api = requestToken.api;
      const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
      const request = (async () => {
        try {
          const userId = api.getCurrentUserId();
          const item = await api.ajax({
            type: "GET",
            url: api.getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: "SeriesId" }),
            dataType: "json"
          });
          if (!requestToken.current() || JE.session && !JE.session.isCurrent(requestEpoch)) return null;
          const seriesId = normalizeId(export3(item).SeriesId) || null;
          parentSeriesCache.set(itemId, seriesId);
          return seriesId;
        } catch (e) {
          if (!requestToken.current() || JE.session && !JE.session.isCurrent(requestEpoch)) return null;
          console.warn("🪼 Jellyfin Enhanced: Failed to fetch parent series for", itemId, e);
          return null;
        } finally {
          if (!JE.session || JE.session.isCurrent(requestEpoch)) parentSeriesRequestMap.delete(itemId);
        }
      })();
      parentSeriesRequestMap.set(itemId, request);
      return request;
    }
    function getCardSurface(card) {
      if (typeof JE.detectCardRowSurface === "function") return JE.detectCardRowSurface(card);
      const section = card.closest(".section, .verticalSection, .homeSection");
      if (!section) return null;
      if (sectionSurfaceCache.has(section)) return sectionSurfaceCache.get(section) ?? null;
      const titleEl = section.querySelector(".sectionTitle, h2, .headerText, .sectionTitle-sectionTitle");
      const title = (titleEl?.textContent || "").toLowerCase();
      let surface = null;
      if (title.includes("next up")) surface = "nextup";
      else if (title.includes("continue watching")) surface = "continuewatching";
      sectionSurfaceCache.set(section, surface);
      return surface;
    }
    function isHiddenOnSurface(itemId, surface) {
      if (!itemId) return false;
      const settings = getSettings();
      if (!settings.enabled) return false;
      const data = getHiddenData();
      const items = data.items || {};
      const wanted = normalizeId(itemId);
      for (const key of Object.keys(items)) {
        const item = items[key];
        if (!item) continue;
        if (normalizeId(item.itemId) !== wanted) continue;
        const scope = (item.hideScope || "global").toLowerCase();
        if (scope === "global") return true;
        if (scope === surface) return true;
        if (scope === "homesections" && (surface === "nextup" || surface === "continuewatching")) return true;
      }
      return false;
    }
    function getCardItemId(el) {
      if (el.dataset && el.dataset.id) return normalizeId(el.dataset.id);
      if (el.dataset && el.dataset.itemid) return normalizeId(el.dataset.itemid);
      return null;
    }
    function getCurrentNativeSurface() {
      const hash = (window.location.hash || "").toLowerCase();
      if (hash.indexOf("/details") !== -1) return "details";
      if (hash.indexOf("/search") !== -1) return "search";
      if (hash.indexOf("/upcoming") !== -1) return "upcoming";
      return "library";
    }
    function checkAndHideByParentSeries(card, itemId) {
      if (!card || !itemId) return;
      if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
      if (hiddenIdSet.size === 0) return;
      const requestToken = lease(JE, true), api = requestToken.api;
      const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
      getParentSeriesId(itemId).then((seriesId) => {
        if (!requestToken.current() || JE.session && !JE.session.isCurrent(requestEpoch)) return;
        if (!seriesId) return;
        if (!card.isConnected || getCardItemId(card) !== normalizeId(itemId)) return;
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
        if (hiddenIdSet.has(seriesId)) {
          card.classList.add("je-hidden");
          card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
          card.removeAttribute(HIDDEN_DIRECT_ATTR);
        } else if (card.getAttribute(HIDDEN_PARENT_ATTR) === seriesId && card.classList.contains("je-hidden")) {
          card.classList.remove("je-hidden");
          card.removeAttribute(HIDDEN_PARENT_ATTR);
        }
      }).catch((e) => {
        console.warn("🪼 Jellyfin Enhanced: Parent series check failed for", itemId, e);
      });
    }
    async function batchCheckParentSeries(cardEntries) {
      if (!cardEntries || cardEntries.length === 0) return;
      if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
      if (hiddenIdSet.size === 0) return;
      const requestToken = lease(JE, true), api = requestToken.api;
      const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
      const canApply = () => requestToken.current() && (!JE.session || JE.session.isCurrent(requestEpoch)) && getSettings().enabled && shouldFilterSurface(getCurrentNativeSurface());
      const cached = [];
      const uncached = [];
      for (const entry of cardEntries) {
        if (parentSeriesCache.has(entry.itemId)) {
          cached.push({ ...entry, seriesId: parentSeriesCache.get(entry.itemId) });
        } else {
          uncached.push(entry);
        }
      }
      if (cached.length > 0) {
        requestAnimationFrame(() => {
          if (!canApply()) return;
          for (const { card, itemId, seriesId } of cached) {
            if (!card.isConnected || getCardItemId(card) !== normalizeId(itemId) || !seriesId) continue;
            if (hiddenIdSet.has(seriesId)) {
              card.classList.add("je-hidden");
              card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
              card.removeAttribute(HIDDEN_DIRECT_ATTR);
            }
          }
        });
      }
      if (uncached.length === 0) return;
      const BATCH_SIZE = 50;
      const userId = api.getCurrentUserId();
      for (let start = 0; start < uncached.length; start += BATCH_SIZE) {
        if (!canApply()) return;
        const chunk = uncached.slice(start, start + BATCH_SIZE);
        const ids = chunk.map((e) => e.itemId).join(",");
        try {
          const result = await api.ajax({
            type: "GET",
            url: api.getUrl(`/Users/${userId}/Items`, { Ids: ids, Fields: "SeriesId" }),
            dataType: "json"
          });
          if (!canApply()) return;
          const itemsById = /* @__PURE__ */ new Map();
          const responseItems = export11(result).Items;
          if (!Array.isArray(responseItems)) throw new Error("Invalid item list");
          for (let i = 0; i < responseItems.length; i++) {
            const item = export3(responseItems[i]);
            if (!item.Id) throw new Error("Missing parent lookup item ID");
            const itemId = normalizeId(item.Id);
            const seriesId = normalizeId(item.SeriesId) || null;
            itemsById.set(itemId, seriesId);
            parentSeriesCache.set(itemId, seriesId);
          }
          for (const entry of chunk) {
            if (!itemsById.has(entry.itemId)) {
              parentSeriesCache.set(entry.itemId, null);
            }
          }
          requestAnimationFrame(() => {
            if (!canApply()) return;
            for (const { card, itemId } of chunk) {
              if (!card.isConnected || getCardItemId(card) !== normalizeId(itemId)) continue;
              const seriesId = parentSeriesCache.get(itemId);
              if (seriesId && hiddenIdSet.has(seriesId)) {
                card.classList.add("je-hidden");
                card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
              }
            }
          });
        } catch (e) {
          if (!canApply()) return;
          console.warn("🪼 Jellyfin Enhanced: Batch parent series check failed", e);
          for (const entry of chunk) {
            checkAndHideByParentSeries(entry.card, entry.itemId);
          }
        }
      }
    }
    function restoreNativeCardsForIds(idsToRestore) {
      if (!idsToRestore || idsToRestore.size === 0) return;
      const wanted = /* @__PURE__ */ new Set();
      idsToRestore.forEach((id) => {
        const norm = normalizeId(id);
        if (norm) wanted.add(norm);
      });
      if (wanted.size === 0) return;
      document.querySelectorAll(CARD_SEL).forEach((card) => {
        card.removeAttribute(PROCESSED_ATTR);
        const cardId = getCardItemId(card);
        const hiddenBySeriesId = normalizeId(card.getAttribute(HIDDEN_PARENT_ATTR));
        if (hiddenBySeriesId && wanted.has(hiddenBySeriesId) && card.classList.contains("je-hidden")) {
          card.classList.remove("je-hidden");
          card.removeAttribute(HIDDEN_PARENT_ATTR);
          card.removeAttribute(HIDDEN_DIRECT_ATTR);
        } else if (cardId && wanted.has(cardId) || card.getAttribute(HIDDEN_DIRECT_ATTR) === "1") {
          card.classList.remove("je-hidden");
          card.removeAttribute(HIDDEN_DIRECT_ATTR);
        }
      });
    }
    function refreshNativeCardVisibility() {
      const frameToken = policyLease(JE);
      if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) {
        document.querySelectorAll(CARD_SEL).forEach((card) => {
          card.classList.remove("je-hidden");
          card.removeAttribute(HIDDEN_DIRECT_ATTR);
          card.removeAttribute(HIDDEN_PARENT_ATTR);
          card.removeAttribute(PROCESSED_ATTR);
        });
        JE.hideEmptyHomeSections?.();
        return;
      }
      requestAnimationFrame(() => {
        if (!frameToken.current()) return;
        filterAllNativeCards();
      });
    }
    function filterNativeCards() {
      const frameToken = policyLease(JE);
      const nativeSurface = getCurrentNativeSurface();
      if (!shouldFilterSurface(nativeSurface)) return;
      const settings = getSettings();
      if (!settings.enabled) return;
      if (getHiddenCount() === 0) return;
      const isDetailPage = nativeSurface === "details";
      const toHide = [];
      const toShow = [];
      const pendingParentChecks = [];
      const cards = document.querySelectorAll(CARD_SEL_NEW);
      for (const card of cards) {
        if (card.hasAttribute("data-imagetype")) continue;
        const itemId = getCardItemId(card);
        card.setAttribute(PROCESSED_ATTR, "1");
        card.removeAttribute(HIDDEN_PARENT_ATTR);
        if (!itemId) continue;
        const cardSurface = getCardSurface(card);
        if (cardSurface) {
          if (shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
            toHide.push({ card, itemId });
            card.setAttribute(HIDDEN_DIRECT_ATTR, "1");
            continue;
          }
        }
        if (hiddenIdSet.has(itemId)) {
          toHide.push({ card, itemId });
          card.setAttribute(HIDDEN_DIRECT_ATTR, "1");
        } else {
          if (card.getAttribute(HIDDEN_DIRECT_ATTR) === "1" && card.classList.contains("je-hidden")) {
            toShow.push({ card, itemId });
            card.removeAttribute(HIDDEN_DIRECT_ATTR);
          }
          if (!isDetailPage) {
            const cardType = card.dataset.type || "";
            if (cardType === "Episode" || cardType === "Season") {
              pendingParentChecks.push({ card, itemId });
            }
          }
        }
      }
      if (toHide.length > 0 || toShow.length > 0) {
        requestAnimationFrame(() => {
          if (!frameToken.current()) return;
          for (const { card, itemId } of toHide) if (card.isConnected && getCardItemId(card) === itemId) card.classList.add("je-hidden");
          for (const { card, itemId } of toShow) if (card.isConnected && getCardItemId(card) === itemId) card.classList.remove("je-hidden");
          JE.hideEmptyHomeSections?.();
        });
      }
      if (pendingParentChecks.length > 0) {
        batchCheckParentSeries(pendingParentChecks);
      }
    }
    function filterAllNativeCards() {
      const frameToken = policyLease(JE);
      const nativeSurface = getCurrentNativeSurface();
      if (!shouldFilterSurface(nativeSurface)) return;
      const settings = getSettings();
      if (!settings.enabled) return;
      const isDetailPage = nativeSurface === "details";
      const toHide = [];
      const toShow = [];
      const pendingParentChecks = [];
      const cards = document.querySelectorAll(CARD_SEL);
      for (const card of cards) {
        const itemId = getCardItemId(card);
        card.setAttribute(PROCESSED_ATTR, "1");
        card.removeAttribute(HIDDEN_PARENT_ATTR);
        if (!itemId) continue;
        const cardSurface = getCardSurface(card);
        let hiddenByScope = false;
        if (cardSurface && shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
          toHide.push({ card, itemId });
          card.setAttribute(HIDDEN_DIRECT_ATTR, "1");
          hiddenByScope = true;
        }
        if (!hiddenByScope) {
          if (hiddenIdSet.has(itemId)) {
            toHide.push({ card, itemId });
            card.setAttribute(HIDDEN_DIRECT_ATTR, "1");
          } else {
            if (card.classList.contains("je-hidden")) {
              toShow.push({ card, itemId });
              card.removeAttribute(HIDDEN_DIRECT_ATTR);
            }
            if (!isDetailPage) {
              const cardType = card.dataset.type || "";
              if (cardType === "Episode" || cardType === "Season") {
                pendingParentChecks.push({ card, itemId });
              }
            }
          }
        }
      }
      if (toHide.length > 0 || toShow.length > 0) {
        requestAnimationFrame(() => {
          if (!frameToken.current()) return;
          for (const { card, itemId } of toHide) if (card.isConnected && getCardItemId(card) === itemId) card.classList.add("je-hidden");
          for (const { card, itemId } of toShow) if (card.isConnected && getCardItemId(card) === itemId) card.classList.remove("je-hidden");
          JE.hideEmptyHomeSections?.();
        });
      }
      if (pendingParentChecks.length > 0) {
        batchCheckParentSeries(pendingParentChecks);
      }
    }
    const debouncedFilterNative = JE.helpers?.debounce ? JE.helpers.debounce(() => {
      requestAnimationFrame(filterNativeCards);
    }, NATIVE_FILTER_DEBOUNCE_MS) : filterNativeCards;
    let observerInstalled = false;
    function setupNativeObserver() {
      if (observerInstalled) return;
      observerInstalled = true;
      if (JE.helpers?.onViewPage) {
        JE.helpers.onViewPage(() => {
          if (getCurrentNativeSurface() === "details") {
            const rescan = () => {
              refreshNativeCardVisibility();
              if (getSettings().showButtonLibrary) addLibraryHideButtons();
            };
            setTimeout(rescan, DETAIL_RESCAN_DELAY_MS);
            setTimeout(rescan, DETAIL_FINAL_RESCAN_DELAY_MS);
          }
        });
      }
      if (typeof JE?.helpers?.onBodyMutation === "function") {
        JE.helpers.onBodyMutation("hidden-content", (mutations) => {
          const settings = getSettings();
          if (!settings.enabled) return;
          const shouldFilter = getHiddenCount() > 0;
          const shouldAddButtons = settings.showHideButtons && settings.showButtonLibrary;
          if (!shouldFilter && !shouldAddButtons) return;
          let hasNewItems = false;
          for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i]?.addedNodes;
            if (!added) continue;
            for (let j = 0; j < added.length; j++) {
              const node = added[j];
              if (node instanceof Element && (node.classList?.contains("card") || node.classList?.contains("listItem") || node.querySelector?.(".card[data-id], .listItem[data-id]"))) {
                hasNewItems = true;
                break;
              }
            }
            if (hasNewItems) break;
          }
          if (hasNewItems) {
            if (shouldFilter) debouncedFilterNative();
            if (shouldAddButtons) addLibraryHideButtons();
          }
        }, { priority: 10 });
      }
    }
    Object.assign(internal, {
      getCardSurface,
      getCardItemId,
      isHiddenOnSurface,
      restoreNativeCardsForIds,
      refreshNativeCardVisibility,
      filterNativeCards,
      filterAllNativeCards,
      setupNativeObserver
    });
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-filter.js.map
