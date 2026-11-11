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
    let counted = location.href;
    const invalidate = () => {
      counted = location.href;
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    const navigated = () => {
      if (location.href !== counted) invalidate();
    };
    window.addEventListener("hashchange", navigated);
    window.addEventListener("popstate", navigated);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", (event) => {
      if ((event.target === window || event.target === document) && !event.persisted) invalidateIdentity();
    });
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
  function invalidatePolicy(JE) {
    runtime(JE).policy++;
  }

  // client/generated-shared/stub/client/src/features/hidden-content/model.ts
  var shared = /* @__PURE__ */ sharedModule("features/hidden-content/model");
  var export0 = /* @__PURE__ */ sharedExport(shared, "aliasMetadata");
  var export1 = /* @__PURE__ */ sharedExport(shared, "decodeDocument");
  var export8 = /* @__PURE__ */ sharedExport(shared, "earliestHiddenAt");
  var export9 = /* @__PURE__ */ sharedExport(shared, "mergeHomeScope");
  var export10 = /* @__PURE__ */ sharedExport(shared, "normalizeId");
  var export12 = /* @__PURE__ */ sharedExport(shared, "sameValue");
  var export13 = /* @__PURE__ */ sharedExport(shared, "settingsFor");
  var export14 = /* @__PURE__ */ sharedExport(shared, "widestScope");
  var export15 = /* @__PURE__ */ sharedExport(shared, "withChanges");

  // client/src/features/hidden-content/hidden-content-data.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-data")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const debouncedSave = (...args) => internal.debouncedSave(...args);
    const showUndoToast = (...args) => internal.showUndoToast(...args);
    const refreshNativeCardVisibility = (...args) => internal.refreshNativeCardVisibility(...args);
    const restoreNativeCardsForIds = (...args) => internal.restoreNativeCardsForIds(...args);
    const hiddenIdSet = /* @__PURE__ */ new Set();
    const hiddenTmdbIdSet = /* @__PURE__ */ new Set();
    let hiddenData = null;
    let storedCopy = { items: {}, settings: {} };
    let loadValid = true;
    let dataOwner = null;
    let editSequence = 0;
    let policyRevision = 0;
    let refreshSequence = 0;
    const itemEdits = /* @__PURE__ */ new Map();
    const itemIntents = /* @__PURE__ */ new Map();
    let intentReset = 0;
    function noteItemChanges(before, after, forced = [], scopedMirror = false) {
      for (const key of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after), ...forced])) {
        if (!forced.includes(key) && export12(before[key], after[key])) continue;
        const version = ++editSequence;
        itemEdits.set(key, version);
        if (!scopedMirror) for (const id of [before[key]?.itemId, after[key]?.itemId, key]) {
          if (id) itemIntents.set(export10(id), version);
        }
      }
    }
    function captureItemIntent(itemId) {
      getHiddenData();
      const id = export10(itemId), version = itemIntents.get(id), reset = intentReset;
      return { current: () => reset === intentReset && version === itemIntents.get(id) };
    }
    function getHiddenData() {
      if (!hiddenData) {
        resetFromUserConfig();
      }
      return hiddenData ?? { items: {}, settings: {} };
    }
    function assertWritable() {
      getHiddenData();
      if (!loadValid || !dataOwner?.current()) throw new Error("Hidden Content policy unavailable; reload before editing");
    }
    function getSettings() {
      const data = getHiddenData();
      return export13(data);
    }
    function rebuildSets() {
      hiddenIdSet.clear();
      hiddenTmdbIdSet.clear();
      const data = getHiddenData();
      const items = data.items || {};
      for (const key of Object.keys(items)) {
        const item = items[key];
        if (!item) continue;
        const scope = (item.hideScope || "global").toLowerCase();
        if (scope !== "global") continue;
        if (item.itemId) hiddenIdSet.add(export10(item.itemId));
        if (item.tmdbId) hiddenTmdbIdSet.add(String(item.tmdbId));
      }
    }
    function shouldFilterSurface(surface) {
      const settings = getSettings();
      if (!settings.enabled) return false;
      switch (surface) {
        case "details":
          return settings.filterLibrary;
        case "library":
          return settings.filterLibrary;
        case "discovery":
          return settings.filterDiscovery;
        case "search":
          return settings.filterSearch;
        case "upcoming":
          return settings.filterUpcoming;
        case "calendar":
          return settings.filterCalendar;
        case "recommendations":
          return settings.filterRecommendations;
        case "requests":
          return settings.filterRequests;
        case "nextup":
          return settings.filterNextUp;
        case "continuewatching":
          return settings.filterContinueWatching;
        default:
          return true;
      }
    }
    function emitChange() {
      policyRevision++;
      invalidatePolicy(JE);
      try {
        window.dispatchEvent(new CustomEvent("je-hidden-content-changed"));
      } catch (e) {
        console.warn("🪼 Jellyfin Enhanced: Failed to emit hidden-content-changed event", e);
      }
    }
    async function refresh() {
      const before = JSON.stringify(hiddenData);
      const revision = policyRevision, requestId = ++refreshSequence;
      const requestToken = lease(JE), api = requestToken.api;
      const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
      try {
        const userId = api.getCurrentUserId();
        if (!userId) return false;
        const fresh = await api.ajax({
          type: "GET",
          url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
          dataType: "json"
        });
        if (!requestToken.current() || JE.session && !JE.session.isCurrent(requestEpoch)) return false;
        if (revision !== policyRevision || requestId !== refreshSequence || before !== JSON.stringify(hiddenData)) return false;
        const camelCased = export1(fresh);
        loadValid = true;
        JE.userConfig = JE.userConfig || {};
        JE.userConfig.hiddenContent = camelCased || { items: {}, settings: {} };
        noteItemChanges(hiddenData?.items ?? {}, camelCased.items);
        hiddenData = camelCased;
        storedCopy = camelCased;
        dataOwner = requestToken;
        rebuildSets();
        emitChange();
        refreshNativeCardVisibility();
        return true;
      } catch (e) {
        console.warn("🪼 Jellyfin Enhanced: Failed to refresh hidden-content", e);
        return false;
      }
    }
    function markScopedHidden(itemId, scope, storedOnly = false) {
      if (!itemId) return;
      if (!storedOnly) markScopedHidden(itemId, scope, true);
      const _scope = (scope || "continuewatching").toLowerCase();
      const local = getHiddenData(), data = storedOnly ? storedCopy : local;
      const items = data.items || {};
      const noHyphen = itemId.replace(/-/g, "");
      const hyphenated = noHyphen.length === 32 ? `${noHyphen.slice(0, 8)}-${noHyphen.slice(8, 12)}-${noHyphen.slice(12, 16)}-${noHyphen.slice(16, 20)}-${noHyphen.slice(20)}` : itemId;
      const variants = [items[itemId], items[hyphenated], items[noHyphen]].filter((item) => item !== void 0);
      const widestExisting = variants.reduce((acc, e) => export14(acc, e.hideScope || "global"), "");
      const finalScope = export9(widestExisting, _scope);
      const existing = export0(variants);
      const altPresent = hyphenated !== itemId && items[hyphenated] || noHyphen !== itemId && items[noHyphen];
      if (items[itemId] && items[itemId]?.hideScope === finalScope && !altPresent) return;
      const merged = {
        ...existing,
        itemId,
        name: existing?.name || "",
        type: existing?.type || "",
        tmdbId: existing?.tmdbId || "",
        hiddenAt: export8(variants),
        posterPath: existing?.posterPath || "",
        seriesId: existing?.seriesId || "",
        seriesName: existing?.seriesName || "",
        seasonNumber: existing?.seasonNumber ?? null,
        episodeNumber: existing?.episodeNumber ?? null,
        hideScope: finalScope
      };
      const nextItems = { ...items, [itemId]: merged };
      if (hyphenated !== itemId) delete nextItems[hyphenated];
      if (noHyphen !== itemId) delete nextItems[noHyphen];
      if (storedOnly) {
        storedCopy = { ...data, items: nextItems };
        return;
      }
      noteItemChanges(data.items, nextItems, [], true);
      hiddenData = { ...data, items: nextItems };
      JE.userConfig = JE.userConfig || {};
      JE.userConfig.hiddenContent = hiddenData;
      rebuildSets();
      emitChange();
    }
    function isHidden(jellyfinItemId) {
      if (!jellyfinItemId) return false;
      const settings = getSettings();
      if (!settings.enabled) return false;
      return hiddenIdSet.has(export10(jellyfinItemId));
    }
    function isHiddenByTmdbId(tmdbId) {
      if (!tmdbId) return false;
      const settings = getSettings();
      if (!settings.enabled) return false;
      return hiddenTmdbIdSet.has(String(tmdbId));
    }
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }) {
      assertWritable();
      const data = getHiddenData();
      if (!itemId && !tmdbId) throw new Error("Hidden item needs a Jellyfin or TMDB identity");
      const requestedKey = itemId || `tmdb-${tmdbId}`;
      const aliases = Object.entries(data.items).filter(([key2, value]) => key2 === requestedKey || !!itemId && export10(value.itemId) === export10(itemId));
      const key = aliases.find(([key2]) => key2 === requestedKey)?.[0] ?? aliases[0]?.[0] ?? requestedKey;
      const variants = aliases.map(([, value]) => value);
      const previous = data.items[key];
      const metadata = export0(previous ? [previous, ...variants.filter((item) => item !== previous)] : variants);
      const newItem = {
        ...metadata,
        itemId: previous?.itemId || itemId || "",
        name: name ?? metadata.name ?? "",
        type: type ?? metadata.type ?? "",
        tmdbId: tmdbId != null ? String(tmdbId) : metadata.tmdbId ?? "",
        hiddenAt: export8(variants),
        posterPath: posterPath ?? metadata.posterPath ?? "",
        seriesId: seriesId ?? metadata.seriesId ?? "",
        seriesName: seriesName ?? metadata.seriesName ?? "",
        seasonNumber: seasonNumber !== void 0 ? seasonNumber : metadata.seasonNumber ?? null,
        episodeNumber: episodeNumber !== void 0 ? episodeNumber : metadata.episodeNumber ?? null,
        hideScope: variants.reduce((scope, item) => export14(scope, item.hideScope || "global"), hideScope || "global")
      };
      const items = { ...data.items };
      for (const [alias] of aliases) delete items[alias];
      items[key] = newItem;
      const affected = [.../* @__PURE__ */ new Set([...aliases.map(([alias]) => alias), key])];
      noteItemChanges(data.items, items, affected);
      const appliedVersions = new Map(affected.map((key2) => [key2, itemEdits.get(key2)]));
      hiddenData = { ...data, items };
      JE.userConfig.hiddenContent = hiddenData;
      rebuildSets();
      debouncedSave();
      emitChange();
      showUndoToast(name || "Item", key, () => {
        assertWritable();
        const current = getHiddenData();
        if (affected.some((key2) => itemEdits.get(key2) !== appliedVersions.get(key2) || !export12(current.items[key2], items[key2]))) return;
        const restored = { ...current.items };
        for (const key2 of affected) {
          if (data.items[key2]) restored[key2] = data.items[key2];
          else delete restored[key2];
        }
        noteItemChanges(current.items, restored, affected);
        hiddenData = { ...current, items: restored };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        refreshNativeCardVisibility();
      });
      refreshNativeCardVisibility();
    }
    function unhideItem(itemId) {
      assertWritable();
      const data = getHiddenData();
      const newItems = { ...data.items };
      let restoredJellyfinId = "";
      const direct = newItems[itemId];
      const wanted = export10(direct?.itemId || (itemId.startsWith("tmdb-") ? "" : itemId));
      for (const [key, item] of Object.entries(newItems)) {
        if (key === itemId || wanted && export10(item.itemId) === wanted) {
          restoredJellyfinId = item.itemId || restoredJellyfinId;
          delete newItems[key];
        }
      }
      noteItemChanges(data.items, newItems, [itemId]);
      hiddenData = { ...data, items: newItems };
      JE.userConfig.hiddenContent = hiddenData;
      rebuildSets();
      debouncedSave();
      emitChange();
      const idsToRestore = /* @__PURE__ */ new Set();
      if (restoredJellyfinId) idsToRestore.add(restoredJellyfinId);
      else if (itemId && !String(itemId).startsWith("tmdb-")) idsToRestore.add(itemId);
      restoreNativeCardsForIds(idsToRestore);
      refreshNativeCardVisibility();
    }
    function updateSettings(partial) {
      assertWritable();
      const data = getHiddenData();
      hiddenData = {
        ...data,
        settings: { ...data.settings, ...partial }
      };
      JE.userConfig.hiddenContent = hiddenData;
      debouncedSave();
      emitChange();
      refreshNativeCardVisibility();
    }
    function getAllHiddenItems() {
      const data = getHiddenData();
      const items = data.items || {};
      return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
    }
    function getHiddenCount() {
      const data = getHiddenData();
      return Object.keys(data.items || {}).length;
    }
    function filterJellyseerrResults(results, surface) {
      if (!shouldFilterSurface(surface)) return results;
      if (!Array.isArray(results)) return results;
      return results.filter((item) => {
        const tmdbId = item.id || item.tmdbId;
        return !hiddenTmdbIdSet.has(String(tmdbId));
      });
    }
    function filterCalendarEvents(events) {
      if (!shouldFilterSurface("calendar")) return events;
      if (!Array.isArray(events)) return events;
      const hiddenNames = /* @__PURE__ */ new Set();
      const items = getHiddenData().items || {};
      for (const key of Object.keys(items)) {
        if ((items[key]?.hideScope || "global") !== "global") continue;
        const name = items[key]?.name;
        if (name) {
          const lower = name.toLowerCase();
          hiddenNames.add(lower);
          const stripped = lower.replace(/\s*\([^)]*\)\s*$/, "");
          if (stripped !== lower) hiddenNames.add(stripped);
        }
      }
      return events.filter((event) => {
        if (event.tmdbId && hiddenTmdbIdSet.has(String(event.tmdbId))) return false;
        if (event.itemId && hiddenIdSet.has(export10(event.itemId))) return false;
        if (event.title && hiddenNames.has(event.title.toLowerCase())) return false;
        return true;
      });
    }
    function filterRequestItems(items) {
      if (!shouldFilterSurface("requests")) return items;
      if (!Array.isArray(items)) return items;
      return items.filter((item) => {
        const tmdbId = item.tmdbId || item.id;
        if (tmdbId && hiddenTmdbIdSet.has(String(tmdbId))) return false;
        if (item.jellyfinMediaId && hiddenIdSet.has(export10(item.jellyfinMediaId))) return false;
        return true;
      });
    }
    function unhideAll() {
      assertWritable();
      const oldHiddenIds = new Set(hiddenIdSet);
      const data = getHiddenData();
      intentReset++;
      noteItemChanges(data.items, {});
      hiddenData = { ...data, items: {} };
      JE.userConfig.hiddenContent = hiddenData;
      rebuildSets();
      debouncedSave();
      emitChange();
      restoreNativeCardsForIds(oldHiddenIds);
      refreshNativeCardVisibility();
    }
    function resetFromUserConfig() {
      policyRevision++;
      intentReset++;
      itemIntents.clear();
      try {
        const next = JE.userConfig?.hiddenContent == null ? { items: {}, settings: {} } : export1(JE.userConfig.hiddenContent);
        hiddenData = next;
        storedCopy = next;
        dataOwner = lease(JE);
        itemEdits.clear();
        loadValid = JE.userConfig?.hiddenContent != null;
        rebuildSets();
      } catch (error) {
        hiddenData ?? (hiddenData = { items: {}, settings: {} });
        loadValid = false;
        console.warn("Invalid hidden-content policy", error);
      }
    }
    function rebaseOnto(stored) {
      assertWritable();
      const owner = dataOwner, sent = getHiddenData(), merged = export15(storedCopy, sent, stored);
      return { merged, saved() {
        if (dataOwner !== owner) return;
        const local = getHiddenData(), next = export15(sent, local, merged), changed = !export12(local, next);
        if (changed) noteItemChanges(local.items, next.items);
        storedCopy = merged;
        hiddenData = next;
        JE.userConfig.hiddenContent = next;
        if (changed) {
          rebuildSets();
          emitChange();
          refreshNativeCardVisibility();
        }
      } };
    }
    JE.session?.onUserChange("hidden-content-data", () => {
      policyRevision++;
      intentReset++;
      itemIntents.clear();
      hiddenData = { items: {}, settings: {} };
      storedCopy = hiddenData;
      loadValid = false;
      dataOwner = null;
      itemEdits.clear();
      hiddenIdSet.clear();
      hiddenTmdbIdSet.clear();
    });
    document.addEventListener("je:user-data-loaded", () => {
      resetFromUserConfig();
      emitChange();
      refreshNativeCardVisibility();
    });
    Object.assign(internal, {
      assertWritable,
      captureItemIntent,
      isLoadOk: () => loadValid,
      hiddenIdSet,
      normalizeId: export10,
      getHiddenData,
      getSettings,
      rebuildSets,
      shouldFilterSurface,
      emitChange,
      refresh,
      markScopedHidden,
      isHidden,
      isHiddenByTmdbId,
      hideItem,
      unhideItem,
      updateSettings,
      getAllHiddenItems,
      getHiddenCount,
      filterJellyseerrResults,
      filterCalendarEvents,
      filterRequestItems,
      unhideAll,
      resetFromUserConfig,
      rebaseOnto
    });
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-data.js.map
