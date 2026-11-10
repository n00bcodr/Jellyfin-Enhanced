(() => {
"use strict";
(() => {
  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
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

  // client/src/features/hidden-content/hidden-content-init.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-init")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const {
      injectCSS,
      setupNativeObserver,
      filterAllNativeCards,
      resetFromUserConfig,
      isHidden,
      isHiddenByTmdbId,
      isHiddenOnSurface,
      hideItem,
      unhideItem,
      confirmAndHide,
      getSettings,
      updateSettings,
      getAllHiddenItems,
      getHiddenCount,
      filterJellyseerrResults,
      filterCalendarEvents,
      filterRequestItems,
      filterNativeCards,
      showUndoToast,
      showManagementPanel,
      createItemCard,
      unhideAll,
      addLibraryHideButtons,
      removeLibraryHideButtons,
      refresh,
      markScopedHidden,
      flushPendingSave,
      fetchHiddenContentUsers,
      fetchUserHiddenItemsForAdmin,
      adminUnhideForUser,
      adminHideForUser
    } = internal;
    const INIT_FILTER_DELAY_MS = 150;
    let observerInstalled = false;
    JE.initializeHiddenContent = function() {
      resetFromUserConfig();
      injectCSS();
      if (!observerInstalled) {
        setupNativeObserver();
        observerInstalled = true;
      }
      if (getHiddenCount() > 0) {
        setTimeout(filterAllNativeCards, INIT_FILTER_DELAY_MS);
      }
      JE.hiddenContent = {
        isLoadOk: internal.isLoadOk,
        isHidden,
        isHiddenByTmdbId,
        isHiddenOnSurface,
        hideItem,
        unhideItem,
        confirmAndHide,
        getSettings,
        updateSettings,
        getAllHiddenItems,
        getHiddenCount,
        filterJellyseerrResults,
        filterCalendarEvents,
        filterRequestItems,
        filterNativeCards,
        showUndoToast,
        showManagementPanel,
        createItemCard,
        unhideAll,
        addLibraryHideButtons,
        removeLibraryHideButtons,
        refresh,
        markScopedHidden,
        flushPendingSave,
        // Admin-only cross-user visibility + editing
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser
      };
      console.log(`🪼 Jellyfin Enhanced: Hidden Content initialized (${getHiddenCount()} items hidden)`);
    };
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-init.js.map
