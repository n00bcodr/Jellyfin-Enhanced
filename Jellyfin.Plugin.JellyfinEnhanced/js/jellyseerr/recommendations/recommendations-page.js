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

  // client/src/features/seerr/recommendations/recommendations-page.ts
  var HASH = "#/recommendations";
  var CONTAINER_ID = "je-recommendations-container";
  (function() {
    "use strict";
    const { JE, P } = recommendationsHost();
    const title = () => translate(JE, "recommendations_title");
    function createPageContainer() {
      const existing = document.getElementById(PAGE_ID);
      if (existing) return existing;
      const page = document.createElement("div");
      page.id = PAGE_ID;
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", title());
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", HASH);
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-recommendations-page">
            <div id="${CONTAINER_ID}" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;
      (document.querySelector(".mainAnimatedPages") ?? document.body).appendChild(page);
      return page;
    }
    function showPage() {
      const state = part(P, "state");
      if (state.categoryPageVisible) part(P, "hideCategoryPage")();
      if (state.pageVisible) return;
      const config = JE.pluginConfig;
      if (!config?.RecommendationsPageEnabled) return;
      if (P.pluginPagesExists && config.RecommendationsUsePluginPages) return;
      state.pageVisible = true;
      const page = createPageContainer();
      if (window.location.hash !== HASH) history.pushState({ page: "recommendations" }, title(), HASH);
      const activePage = document.querySelector(`.mainAnimatedPage:not(.hide):not(#${PAGE_ID})`);
      if (activePage) {
        state.previousPage = activePage;
        activePage.classList.add("hide");
        activePage.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "interior" } }));
      }
      page.classList.remove("hide");
      page.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "custom", isRestored: false, options: {} } }));
      page.dispatchEvent(new CustomEvent("pageshow", { bubbles: true, detail: {} }));
      const container = page.querySelector(`#${CONTAINER_ID}`);
      if (container) {
        Promise.resolve(part(P, "renderInto")(container)).catch((error) => console.error(`${LOG_PREFIX} Failed to render`, error));
      }
    }
    function hidePage() {
      const state = part(P, "state");
      if (!state.pageVisible) return;
      state.pageVisible = false;
      const page = document.getElementById(PAGE_ID);
      if (page) {
        page.classList.add("hide");
        page.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "custom" } }));
      }
      const previous = state.previousPage;
      state.previousPage = null;
      if (previous && !document.querySelector(OTHER_PAGE)) {
        previous.classList.remove("hide");
        previous.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "interior", isRestored: true } }));
      }
      state.currentAbortController?.abort();
      const container = page?.querySelector(`#${CONTAINER_ID}`);
      if (container) P.disposeRender?.(container);
    }
    P.createPageContainer = createPageContainer;
    P.showPage = showPage;
    P.hidePage = hidePage;
  })();
})();
})();
//# sourceMappingURL=recommendations-page.js.map
