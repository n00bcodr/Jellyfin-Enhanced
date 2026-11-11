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

  // client/src/features/hidden-content/hidden-content-page-init.ts
  (function() {
    if (!installOnce(host.JellyfinEnhanced, "hidden-content-page-init")) return;
    "use strict";
    const JE = host.JellyfinEnhanced;
    const internal = registry(JE, "hiddenContentPage");
    const {
      state,
      pluginPagesExists,
      injectStyles,
      renderPage,
      showPage,
      hidePage,
      interceptNavigation,
      handleNavigation,
      handleViewShow,
      handleNavClick,
      injectNavigation,
      setupNavigationWatcher,
      renderForCustomTab
    } = internal;
    const logPrefix = "🪼 Jellyfin Enhanced: Hidden Content Page:";
    let initialized = false;
    function initialize() {
      if (initialized) return;
      console.log(`${logPrefix} Initializing hidden content page module`);
      const config = JE.pluginConfig || {};
      if (!config.HiddenContentEnabled) {
        console.log(`${logPrefix} Hidden content is disabled`);
        return;
      }
      if (!JE.hiddenContent) {
        console.log(`${logPrefix} Hidden content not initialized, skipping page module`);
        return;
      }
      initialized = true;
      injectStyles();
      window.addEventListener("je-hidden-content-changed", () => {
        if (state.adminIsAdmin === true && !state.selectedAdminUserId) {
          state.adminUsers = null;
        }
        const container = state._customTabContainer || document.getElementById("je-hidden-content-container");
        if (container && document.contains(container) && !state.selectedAdminUserId) {
          renderPage(container);
        }
      });
      const usingPluginPages = pluginPagesExists && config.HiddenContentUsePluginPages;
      if (usingPluginPages) {
        console.log(`${logPrefix} Hidden content page is injected via Plugin Pages`);
        return;
      }
      injectNavigation();
      setupNavigationWatcher();
      window.addEventListener("hashchange", interceptNavigation, true);
      window.addEventListener("popstate", interceptNavigation, true);
      document.addEventListener("viewshow", handleViewShow);
      document.addEventListener("click", handleNavClick);
      window.addEventListener("hashchange", handleNavigation);
      window.addEventListener("popstate", handleNavigation);
      handleNavigation();
      console.log(`${logPrefix} Hidden content page module initialized`);
    }
    JE.hiddenContentPage = {
      initialize,
      showPage,
      hidePage,
      renderPage,
      renderForCustomTab,
      injectStyles
    };
    JE.initializeHiddenContentPage = initialize;
  })();
})();
})();
//# sourceMappingURL=hidden-content-page-init.js.map
