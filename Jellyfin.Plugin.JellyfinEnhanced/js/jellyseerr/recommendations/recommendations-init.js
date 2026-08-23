// /js/jellyseerr/recommendations/recommendations-init.js
// Recommendations Page — sidebar link injection, navigation wiring, public
// surface and bootstrap (split from recommendations.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

  const logPrefix = '🪼 Jellyfin Enhanced: Recommendations:';
  const state = P.state;
  const sidebar = P.sidebar;
  const pluginPagesExists = P.pluginPagesExists;
  const showPage = P.showPage;
  const hidePage = P.hidePage;
  const hideCategoryPage = P.hideCategoryPage;

  // --- Navigation ---

  function handleNavigation() {
    const hash = window.location.hash;

    if (state.categoryPageVisible) hideCategoryPage();

    if (hash === "#/recommendations") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  function handleViewShow(e) {
    const targetPage = e.target;
    if (!targetPage) return;
    if (state.pageVisible && targetPage.id !== "je-recommendations-page" && targetPage.id !== "je-recommendations-category-page") {
      hidePage();
    }
    if (state.categoryPageVisible && targetPage.id !== "je-recommendations-category-page" && targetPage.id !== "je-recommendations-page") {
      hideCategoryPage();
    }
  }

  // --- Sidebar link injection ---

  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;
    if (pluginPagesExists && config.RecommendationsUsePluginPages) return;
    if (config.RecommendationsUseCustomTabs) return;
    if (config.RecommendationsUseNativeTab) return;

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]'
    );
    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    if (document.querySelector(".je-nav-recommendations-item")) return;

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
    if (!jellyfinEnhancedSection) {
      console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
      return;
    }

    const navItem = document.createElement("a");
    navItem.setAttribute('is', 'emby-linkbutton');
    navItem.className = "navMenuOption lnkMediaFolder emby-button je-nav-recommendations-item";
    navItem.href = "#";
    navItem.innerHTML = `
      <span class="navMenuOptionIcon material-icons">auto_awesome</span>
      <span class="sectionName navMenuOptionText">${JE.t("recommendations_title")}</span>
    `;
    navItem.addEventListener("click", (e) => {
      e.preventDefault();
      showPage();
    });

    jellyfinEnhancedSection.appendChild(navItem);
    console.log(`${logPrefix} Navigation item injected`);
  }

  function setupNavigationWatcher() {
    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;
    if (pluginPagesExists && config.RecommendationsUsePluginPages) return;
    if (config.RecommendationsUseCustomTabs) return;
    if (config.RecommendationsUseNativeTab) return;

    const observer = new MutationObserver(() => {
      const currentConfig = JE.pluginConfig || {};
      if (pluginPagesExists && currentConfig.RecommendationsUsePluginPages) return;
      if (currentConfig.RecommendationsUseCustomTabs) return;
      if (currentConfig.RecommendationsUseNativeTab) return;

      if (!document.querySelector('.je-nav-recommendations-item')) {
        const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
        if (jellyfinEnhancedSection) {
          console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
          injectNavigation();
        }
      }
    });

    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
      observer.observe(navDrawer, { childList: true, subtree: true });
    }
  }

  function init() {
    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;

    injectNavigation();
    setupNavigationWatcher();

    document.addEventListener("viewshow", handleViewShow);
    JE.helpers.onNavigate(handleNavigation);
    handleNavigation();
  }

  P.handleNavigation = handleNavigation;
  P.handleViewShow = handleViewShow;
  P.injectNavigation = injectNavigation;
  P.setupNavigationWatcher = setupNavigationWatcher;

  window.JellyfinEnhanced.recommendationsPage = {
    renderForCustomTab: P.renderForCustomTab,
    showPage,
    hidePage,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
