// /js/arr/requests/requests-page-init.js
// Requests Page — initialization, navigation interception, page show/hide,
// polling and the public JE.downloadsPage surface (split from requests-page.js).
// The poll interval and the navigation-watcher fallback interval are tracked
// with a JE.core.lifecycle handle.
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

  const state = P.state;
  const injectStyles = P.injectStyles;
  const createPageContainer = P.createPageContainer;
  const renderPage = P.renderPage;
  const loadAllData = P.loadAllData;
  const clearAvatarObjectUrlCache = P.clearAvatarObjectUrlCache;

  // Feature-scoped resource registry (poll interval, unsubscribe fns).
  const lifecycle = JE.core.lifecycle.register('arr-requests-page');

  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.DownloadsPage"]',
  );

  const logPrefix = '🪼 Jellyfin Enhanced: Requests Page:';

  /**
   * Show the downloads page with proper Jellyfin integration
   */
  function showPage() {
    if (state.pageVisible) return;

    state.pageVisible = true;

    // Ensure page exists first
    const page = createPageContainer();
    if (!page) {
      console.error(`${logPrefix} Failed to create page container`);
      state.pageVisible = false;
      return;
    }

    if (window.location.hash !== "#/downloads") {
      history.pushState({ page: "downloads" }, "Requests", "#/downloads");
    }

    // Hide other Jellyfin pages - but track which one was active so we can restore it
    const activePage = document.querySelector(
      ".mainAnimatedPage:not(.hide):not(#je-downloads-page)",
    );
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      // Dispatch viewhide for the page we're leaving
      activePage.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "interior" },
        }),
      );
    }

    // Show our page
    page.classList.remove("hide");

    // Dispatch viewshow event so Jellyfin's libraryMenu updates header/back button
    page.dispatchEvent(
      new CustomEvent("viewshow", {
        bubbles: true,
        detail: {
          type: "custom",
          isRestored: false,
          options: {},
        },
      }),
    );

    // Also dispatch pageshow for other integrations
    page.dispatchEvent(
      new CustomEvent("pageshow", {
        bubbles: true,
        detail: {
          type: "custom",
          isRestored: false,
        },
      }),
    );

    // Only load data once (guard against showPage retries)
    if (!state.isLoading) {
      loadAllData();
      startPolling();
    }
  }

  /**
   * Hide the downloads page and clean up header state
   */
  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-downloads-page");
    if (page) {
      page.classList.add("hide");

      // Dispatch viewhide event so Jellyfin knows we're leaving
      page.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "custom" },
        }),
      );
    }

    // Restore the previous page if Jellyfin's router hasn't already shown another page
    // This handles the case where user clicks browser back button
    // But NOT when clicking header tabs (Jellyfin handles those via viewshow events)
    if (
      state.previousPage &&
      !document.querySelector(
        ".mainAnimatedPage:not(.hide):not(#je-downloads-page)",
      )
    ) {
      state.previousPage.classList.remove("hide");
      // Dispatch viewshow so the page re-initializes properly
      state.previousPage.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: { type: "interior", isRestored: true },
        }),
      );
    }

    state.pageVisible = false;
    state.previousPage = null;
    clearAvatarObjectUrlCache(true);
    stopPolling();
    stopLocationWatcher();
  }

  /**
   * Start polling for updates
   */
  function startPolling() {
    stopPolling();
    const config = JE.pluginConfig || {};

    // Check if polling is enabled
    if (!config.DownloadsPagePollingEnabled) {
      return;
    }

    const intervalSeconds = config.DownloadsPollIntervalSeconds !== undefined
      ? config.DownloadsPollIntervalSeconds
      : 30;


    // Check visibility across all view modes: normal page, plugin pages, or custom tabs
    const isVisible = state.pageVisible || state._pluginPageVisible || state._customTabMode;
    if (!isVisible) {
      return;
    }

    const interval = intervalSeconds * 1000;
    // Tracked with the feature lifecycle so teardownAll() can dispose it.
    state.pollTimer = lifecycle.track(setInterval(() => {
      // Stop the timer entirely if the page is no longer visible in any mode —
      // this catches navigation away via custom tabs / plugin pages where hidePage()
      // is never called and the timer would otherwise run indefinitely.
      const currentlyVisible = state.pageVisible || state._pluginPageVisible || state._customTabMode;
      if (!currentlyVisible) {
        stopPolling();
        return;
      }
      // Also skip if the browser tab is hidden (user switched tabs / minimised)
      if (document.visibilityState === 'hidden') return;
      if (!state.isLoading) {
        loadAllData();
      }
    }, interval));

  }

  /**
   * Stop polling
   */
  function stopPolling() {
    if (state.pollTimer) {
      lifecycle.untrack(state.pollTimer);
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /**
   * Inject navigation item into sidebar
   */
  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) return;
    if (pluginPagesExists && config.DownloadsUsePluginPages) return;
    if (config.DownloadsUseCustomTabs) return; // Skip sidebar injection if using custom tabs
    if (config.DownloadsUseNativeTab) return; // Skip sidebar injection if using the native tab

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.DownloadsPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    // Check if already exists
    if (document.querySelector(".je-nav-downloads-item")) {
      return;
    }

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-downloads-item";
      navItem.href = "#";
      const labelRequests = (JE.t && JE.t('requests_requests')) || 'Requests';
      navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">download</span>
        <span class="sectionName navMenuOptionText">${labelRequests}</span>
      `;
      navItem.addEventListener("click", (e) => {
        e.preventDefault();
        showPage();
      });

      jellyfinEnhancedSection.appendChild(navItem);
      console.log(`${logPrefix} Navigation item injected`);
    } else {
      console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
    }
  }

  /**
   * Setup navigation watcher - observes only when link is missing
   */
  function setupNavigationWatcher() {
    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) return;
    if (pluginPagesExists && config.DownloadsUsePluginPages) return;
    if (config.DownloadsUseCustomTabs) return; // Don't watch if using custom tabs
    if (config.DownloadsUseNativeTab) return; // Don't watch if using the native tab

    // Use MutationObserver to watch for sidebar changes, but disconnect after re-injection
    const observer = new MutationObserver(() => {
      // Re-check config each time to avoid injecting when settings change
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.DownloadsUseCustomTabs) return;
      if (currentConfig.DownloadsUseNativeTab) return;
      if (pluginPagesExists && currentConfig.DownloadsUsePluginPages) return;

      if (!document.querySelector('.je-nav-downloads-item')) {
        const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
        if (jellyfinEnhancedSection) {
          console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
          injectNavigation();
        }
      }
    });

    // Observe the main drawer
    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
      observer.observe(navDrawer, { childList: true, subtree: true });
    }
  }

  /**
   * Handle URL hash changes
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash === "#/downloads" || path === "/downloads") {
      console.log(`${logPrefix} handleNavigation matched downloads (hash=${hash} path=${path})`);
      // Show page to win races against Jellyfin's router rendering 404
      showPage();
    } else if (state.pageVisible || state._pluginPageVisible) {
      // Stop polling immediately when navigating away in any mode
      console.log(`${logPrefix} handleNavigation hiding page (hash=${hash} path=${path})`);
      hidePage();
    }
  }

  /**
   * Initialize the downloads page module
   */
  function initialize() {
    console.log(`${logPrefix} Initializing downloads page module`);

    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) {
      console.log(`${logPrefix} Downloads page is disabled`);
      return;
    }

    injectStyles();

    const usingPluginPages = pluginPagesExists && config.DownloadsUsePluginPages;
    if (usingPluginPages) {
      console.log(`${logPrefix} Downloads page is injected via Plugin Pages`);
      return;
    }

    // Page-specific setup for custom tabs or dedicated page mode
    createPageContainer();

    // Inject navigation and set up one-time re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Intercept router changes before Jellyfin handles them
    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);

    // Listen for hash changes - handles browser back/forward and direct URL changes
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    startLocationWatcher();

    // Listen for Jellyfin's viewshow events - hide our page when other pages show
    document.addEventListener("viewshow", (e) => {
      const targetPage = e.target;
      if (
        state.pageVisible &&
        targetPage &&
        targetPage.id !== "je-downloads-page"
      ) {
        hidePage();
      }
    });

    // Listen for clicks on header navigation buttons (Home, Favorites, etc.)
    // These buttons use Jellyfin's internal router and may not change the hash immediately
    document.addEventListener(
      "click",
      (e) => {
        if (!state.pageVisible) return;

        // Handle play button clicks
        const playBtn = e.target.closest(".je-request-watch-btn");
        if (playBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const mediaId = playBtn.getAttribute("data-media-id");
          if (mediaId && window.Emby?.Page?.showItem) {
            window.Emby.Page.showItem(mediaId);
          }
          return;
        }

        const btn = e.target.closest(
          ".headerTabs button, .navMenuOption, .headerButton",
        );
        if (btn && !btn.classList.contains("je-nav-downloads-item")) {
          // Hide our page immediately - don't try to manage other pages
          // Jellyfin's router will handle showing the correct page
          hidePage();
        }
      },
      true,
    );

    // Check current URL on init
    handleNavigation();

    console.log(`${logPrefix} Downloads page module initialized`);
  }

  /**
   * Intercept hash/popstate changes for our route before Jellyfin router
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash === "#/downloads" || path === "/downloads";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  // Use event-based navigation detection (pushState/hashchange/popstate via je:navigate)
  function startLocationWatcher() {
    if (state.locationUnsubscribe) return;

    state.locationSignature = `${window.location.pathname}${window.location.hash}`;

    const check = () => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    };

    // Tracked with the feature lifecycle so teardownAll() can dispose it.
    state.locationUnsubscribe = lifecycle.track(
      JE.helpers?.onNavigate
        ? JE.helpers.onNavigate(check)
        : (() => {
            // Fallback: narrow poller if helpers not yet available
            const t = setInterval(check, 150);
            return () => clearInterval(t);
          })(),
    );
  }

  function stopLocationWatcher() {
    if (state.locationUnsubscribe) {
      lifecycle.untrack(state.locationUnsubscribe);
      state.locationUnsubscribe();
      state.locationUnsubscribe = null;
    }
  }

  /**
   * Render content for custom tabs (without page state management).
   * @param {HTMLElement} [targetContainer] - Optional container element to
   *   render into, avoiding global getElementById lookups.
   */
  function renderForCustomTab(targetContainer) {
    state._customTabMode = true;
    injectStyles();
    renderPage(targetContainer);
    loadAllData();
    startPolling();
  }

  // Export to JE namespace
  JE.downloadsPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    startPolling,
    stopPolling,
    filterDownloads: P.filterDownloads,
    searchDownloads: P.searchDownloads,
    filterRequests: P.filterRequests,
    filterIssues: P.filterIssues,
    nextPage: P.nextPage,
    prevPage: P.prevPage,
    nextIssuesPage: P.nextIssuesPage,
    prevIssuesPage: P.prevIssuesPage,
    nextHistoryPage: P.nextHistoryPage,
    prevHistoryPage: P.prevHistoryPage,
    renderPage,
    renderForCustomTab,
    injectStyles,
    _state: state
  };

  JE.initializeDownloadsPage = initialize;
})();
