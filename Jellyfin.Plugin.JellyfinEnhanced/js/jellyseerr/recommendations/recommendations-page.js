// /js/jellyseerr/recommendations/recommendations-page.js
// Recommendations Page — the standalone (sidebar-link) page container and its
// show/hide lifecycle (split from recommendations.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

  const state = P.state;
  const pluginPagesExists = P.pluginPagesExists;
  const renderInto = P.renderInto;

  // recommendations-category.js loads after this module — resolve at call time.
  const hideCategoryPage = (...args) => P.hideCategoryPage(...args);

  function createPageContainer() {
    let page = document.getElementById("je-recommendations-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-recommendations-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", JE.t("recommendations_title"));
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/recommendations");
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-recommendations-page">
            <div id="je-recommendations-container" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;

      const mainContent = document.querySelector(".mainAnimatedPages");
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }
    return page;
  }

  function showPage() {
    if (state.categoryPageVisible) hideCategoryPage();
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;
    if (pluginPagesExists && config.RecommendationsUsePluginPages) return;

    state.pageVisible = true;

    const page = createPageContainer();

    if (window.location.hash !== "#/recommendations") {
      history.pushState({ page: "recommendations" }, JE.t("recommendations_title"), "#/recommendations");
    }

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-page)");
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "interior" } }));
    }

    page.classList.remove("hide");
    page.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "custom", isRestored: false, options: {} } }));
    page.dispatchEvent(new CustomEvent("pageshow", { bubbles: true, detail: {} }));

    const container = document.getElementById("je-recommendations-container");
    if (container) renderInto(container);
  }

  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-recommendations-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "custom" } }));
    }

    if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-page):not(#je-recommendations-category-page)")) {
      state.previousPage.classList.remove("hide");
      state.previousPage.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "interior", isRestored: true } }));
    }

    state.pageVisible = false;
    state.previousPage = null;
    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }
  }

  P.createPageContainer = createPageContainer;
  P.showPage = showPage;
  P.hidePage = hidePage;
})();
