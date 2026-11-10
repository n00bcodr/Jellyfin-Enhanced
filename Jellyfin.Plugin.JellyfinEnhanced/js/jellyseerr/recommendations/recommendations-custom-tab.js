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
  var PAGE_ID = "je-recommendations-page";
  var CATEGORY_PAGE_ID = "je-recommendations-category-page";
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

  // client/src/features/seerr/recommendations/recommendations-custom-tab.ts
  var CONTAINER_SELECTOR = ".jellyfinenhanced.recommendations";
  var READY_POLL_MS = 100;
  var READY_MAX_POLLS = 300;
  (function() {
    "use strict";
    const { JE, P } = recommendationsHost();
    const config = JE.pluginConfig;
    if (!config?.RecommendationsPageEnabled) return;
    if (!config.RecommendationsUseCustomTabs && !config.RecommendationsUseNativeTab) return;
    if (config.RecommendationsUseNativeTab) {
      JE.nativeTabs?.register("recommendations", translate(JE, "recommendations_title"), (panel) => {
        const marker = document.createElement("div");
        marker.className = "jellyfinenhanced recommendations";
        panel.appendChild(marker);
      }, "auto_awesome");
    }
    const style = document.createElement("style");
    style.textContent = [
      ".backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.recommendations) {",
      "  background: rgba(0, 0, 0, 0.7) !important;",
      "  opacity: 1 !important;",
      "}"
    ].join("\n");
    document.head.appendChild(style);
    let mounted = null;
    function unmount() {
      if (!mounted) return;
      part(P, "disposeRender")(mounted.child);
      mounted.container.replaceChildren();
      mounted = null;
    }
    const isOnHomePage = () => /^(?:#\/home(?:\.html)?(?:\?.*)?)?$/.test(window.location.hash);
    function findActiveContainer() {
      const all = [...document.querySelectorAll(CONTAINER_SELECTOR)];
      return all.reverse().find((element) => JE.helpers?.isActiveTabContainer?.(element)) ?? null;
    }
    function reconcile() {
      const container = isOnHomePage() ? findActiveContainer() : null;
      if (!container) {
        unmount();
        return;
      }
      if (container === mounted?.container && mounted.child.isConnected) return;
      unmount();
      container.classList.remove("hide");
      container.style.display = "";
      const child = document.createElement("div");
      child.id = "je-recommendations-container-tab";
      container.replaceChildren(child);
      mounted = { container, child };
      JE.recommendationsPage?.renderForCustomTab(child);
    }
    function watch() {
      reconcile();
      JE.helpers?.observeTabContainers?.("recommendations-custom-tab", CONTAINER_SELECTOR, reconcile);
    }
    JE.session?.onUserChange("recommendations-custom-tab", unmount);
    if (JE.recommendationsPage) {
      watch();
      return;
    }
    let attempts = 0;
    const waiting = setInterval(() => {
      if (++attempts > READY_MAX_POLLS) {
        clearInterval(waiting);
        return;
      }
      if (!JE.recommendationsPage) return;
      clearInterval(waiting);
      watch();
    }, READY_POLL_MS);
  })();
})();
})();
//# sourceMappingURL=recommendations-custom-tab.js.map
