/**
 * @file Hidden Content Page — initialization and the frozen public surface
 * (JE.hiddenContentPage / JE.initializeHiddenContentPage).
 * Split from hidden-content-page.js (code motion; bodies verbatim). Loads
 * last among the hidden-content-page-* modules.
 */
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const internal = JE.internals.hiddenContentPage = JE.internals.hiddenContentPage || {};

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
    renderForCustomTab,
  } = internal;

  const logPrefix = '🪼 Jellyfin Enhanced: Hidden Content Page:';

  // ============================================================
  // Initialization & Setup
  // ============================================================

  /**
   * Initializes the hidden content page module.
   * Injects styles, navigation item, and sets up all event listeners.
   */
  function initialize() {
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

    injectStyles();

    // Re-render listener runs in BOTH native and Plugin-Pages modes; gated on container presence (state.pageVisible isn't set in Plugin-Pages mode).
    window.addEventListener('je-hidden-content-changed', () => {
      // This event fires only for the ADMIN's own hidden-content changes. Invalidate the cached
      // admin user list so the dropdown picks up new/emptied users on the next render.
      // Only when on the admin's own view: while viewing another user, nulling the cache would strip
      // the dropdown on the next admin-edit render until it re-fetches (a visible flicker).
      if (state.adminIsAdmin === true && !state.selectedAdminUserId) {
        state.adminUsers = null;
      }
      const container = document.getElementById('je-hidden-content-container');
      // Don't repaint while viewing another user — the admin's own change must not clobber that
      // read-only view with own-list data under the wrong badge.
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

  // ============================================================
  // Public API
  // ============================================================

  JE.hiddenContentPage = {
    initialize,
    showPage,
    hidePage,
    renderPage,
    renderForCustomTab,
    injectStyles,
  };

  JE.initializeHiddenContentPage = initialize;

})();
