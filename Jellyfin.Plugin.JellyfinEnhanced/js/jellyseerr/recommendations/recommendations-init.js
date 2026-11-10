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
  function translate(JE, key, params) {
    return JE.t?.(key, params) ?? key;
  }

  // client/src/features/seerr/recommendations/stage.ts
  var LOG_PREFIX = "🪼 Jellyfin Enhanced: Recommendations:";
  var PAGE_ID = "je-recommendations-page";
  var CATEGORY_PAGE_ID = "je-recommendations-category-page";
  var PLUGIN_PAGE_LINK = 'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]';
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

  // client/src/features/seerr/recommendations/recommendations-init.ts
  (function() {
    "use strict";
    const { JE, P } = recommendationsHost();
    const state = part(P, "state");
    const showPage = () => part(P, "showPage")();
    const hidePage = () => part(P, "hidePage")();
    const hideCategoryPage = () => part(P, "hideCategoryPage")();
    function handleNavigation() {
      part(P, "sweepRenders")();
      if (state.categoryPageVisible) hideCategoryPage();
      if (window.location.hash === "#/recommendations") showPage();
      else if (state.pageVisible) hidePage();
    }
    function handleViewShow(event) {
      if (!(event.target instanceof Element)) return;
      const { id } = event.target;
      if (id === PAGE_ID || id === CATEGORY_PAGE_ID) return;
      if (state.pageVisible) hidePage();
      if (state.categoryPageVisible) hideCategoryPage();
    }
    function linkHidden() {
      const config = JE.pluginConfig;
      return !!(P.pluginPagesExists && config?.RecommendationsUsePluginPages) || !!config?.RecommendationsUseCustomTabs || !!config?.RecommendationsUseNativeTab;
    }
    function injectNavigation() {
      if (!JE.pluginConfig?.RecommendationsPageEnabled || linkHidden()) return;
      const pluginLink = P.sidebar?.querySelector(PLUGIN_PAGE_LINK);
      pluginLink?.style.setProperty("display", "none", "important");
      if (document.querySelector(".je-nav-recommendations-item")) return;
      const section = document.querySelector(".jellyfinEnhancedSection");
      if (!section) {
        console.log(`${LOG_PREFIX} jellyfinEnhancedSection not found, will wait for it`);
        return;
      }
      const navItem = document.createElement("a");
      navItem.setAttribute("is", "emby-linkbutton");
      navItem.className = "navMenuOption lnkMediaFolder emby-button je-nav-recommendations-item";
      navItem.href = "#";
      const icon = document.createElement("span");
      icon.className = "navMenuOptionIcon material-icons";
      icon.textContent = "auto_awesome";
      const label = document.createElement("span");
      label.className = "sectionName navMenuOptionText";
      label.textContent = translate(JE, "recommendations_title");
      navItem.append(icon, label);
      navItem.addEventListener("click", (event) => {
        event.preventDefault();
        showPage();
      });
      section.appendChild(navItem);
      console.log(`${LOG_PREFIX} Navigation item injected`);
    }
    function setupNavigationWatcher() {
      if (!JE.pluginConfig?.RecommendationsPageEnabled || linkHidden()) return;
      JE.helpers?.onSidebarRebuilt?.("recommendations", ".je-nav-recommendations-item", () => {
        if (linkHidden()) return;
        console.log(`${LOG_PREFIX} Sidebar rebuilt, re-injecting navigation`);
        injectNavigation();
      });
    }
    function init() {
      if (!JE.pluginConfig?.RecommendationsPageEnabled) return;
      injectNavigation();
      setupNavigationWatcher();
      document.addEventListener("viewshow", handleViewShow);
      JE.helpers?.onNavigate?.(handleNavigation);
      handleNavigation();
    }
    P.handleNavigation = handleNavigation;
    P.handleViewShow = handleViewShow;
    P.injectNavigation = injectNavigation;
    P.setupNavigationWatcher = setupNavigationWatcher;
    JE.recommendationsPage = { renderForCustomTab: (element) => part(P, "renderForCustomTab")(element), showPage, hidePage };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
  })();
})();
})();
//# sourceMappingURL=recommendations-init.js.map
