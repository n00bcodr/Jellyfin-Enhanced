/**
 * @file Hidden Content Page — standalone page container, show/hide,
 * navigation interception, sidebar nav item, and custom-tab rendering.
 * Split from hidden-content-page.js (code motion; bodies verbatim).
 */
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const internal = JE.internals.hiddenContentPage = JE.internals.hiddenContentPage || {};

  const { state, sidebar, pluginPagesExists, injectStyles } = internal;
  const renderPage = (...args) => internal.renderPage(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Hidden Content Page:';

  /** Polling interval for detecting pushState navigations. */
  const LOCATION_WATCH_INTERVAL_MS = 150;

  // ============================================================
  // Navigation & Page Management
  // ============================================================

  /**
   * Intercepts hash/popstate changes for the hidden-content route before
   * Jellyfin's native router can handle them.
   * @param {HashChangeEvent|PopStateEvent} e The navigation event.
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash.startsWith("#/hidden-content") || path === "/hidden-content";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  /**
   * Starts polling for pushState-based navigation changes.
   * Jellyfin's router uses pushState which doesn't fire popstate/hashchange.
   */
  function startLocationWatcher() {
    if (state.locationTimer) return;
    state.locationSignature = `${window.location.pathname}${window.location.hash}`;
    state.locationTimer = setInterval(() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    }, LOCATION_WATCH_INTERVAL_MS);
  }

  /**
   * Stops the location polling interval.
   */
  function stopLocationWatcher() {
    if (state.locationTimer) {
      clearInterval(state.locationTimer);
      state.locationTimer = null;
    }
  }

  /**
   * Creates or retrieves the hidden-content page container element.
   * Inserts it into Jellyfin's animated-pages container on first call.
   * @returns {HTMLElement} The page container element.
   */
  function createPageContainer() {
    let page = document.getElementById("je-hidden-content-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-hidden-content-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", "Hidden Content");
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/hidden-content");
      page.setAttribute("data-type", "custom");

      const contentWrapper = document.createElement("div");
      contentWrapper.setAttribute("data-role", "content");

      const contentPrimary = document.createElement("div");
      contentPrimary.className = "content-primary je-hidden-content-page";

      const container = document.createElement("div");
      container.id = "je-hidden-content-container";
      container.style.cssText = "padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;";

      contentPrimary.appendChild(container);
      contentWrapper.appendChild(contentPrimary);
      page.appendChild(contentWrapper);

      const mainContent = document.querySelector(".mainAnimatedPages");
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }

    return page;
  }

  // ============================================================
  // Page Show/Hide
  // ============================================================

  /**
   * Shows the hidden content page, hiding the currently active Jellyfin page.
   */
  function showPage() {
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
    if (config.HiddenContentUseCustomTabs) return;
    if (config.HiddenContentUseNativeTab) return;

    state.pageVisible = true;

    startLocationWatcher();
    injectStyles();
    const page = createPageContainer();

    const expectedHash = '#/hidden-content';
    if (window.location.hash !== expectedHash) {
      history.pushState({ page: "hidden-content" }, "Hidden Content", expectedHash);
    }

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-hidden-content-page)");
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "interior" },
        }),
      );
    }

    page.classList.remove("hide");

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

    page.dispatchEvent(
      new CustomEvent("pageshow", {
        bubbles: true,
        detail: {},
      }),
    );

    renderPage();
  }

  /**
   * Hides the hidden content page and restores the previous Jellyfin page.
   */
  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-hidden-content-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "custom" },
        }),
      );
    }

    if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-hidden-content-page)")) {
      state.previousPage.classList.remove("hide");
      state.previousPage.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: { type: "interior", isRestored: true },
        }),
      );
    }

    state.pageVisible = false;
    state.previousPage = null;
    state.searchQuery = '';
    // Reset admin cross-user view so re-opening the page starts on the admin's own
    // list rather than a stale "Viewing: <user>" snapshot, and the dropdown re-initialises fresh.
    // Bumping adminLoadToken invalidates any in-flight cross-user fetch so a late completion can't
    // repopulate adminItems after the page has been left.
    state.adminLoadToken++;
    state.selectedAdminUserId = null;
    state.adminEditMode = false;
    state.adminItems = null;
    state.adminItemsUserId = null;
    state.adminLoadError = false;
    state.adminUserName = '';
    state.scopedOnly = false;
    state.adminUsers = null;
    // Clear the loading flag too: an in-flight user-list fetch now discards its result via the token
    // check, so re-opening the page must be free to start a fresh fetch.
    state.adminUsersLoading = false;
    stopLocationWatcher();
  }

  // ============================================================
  // Event Handlers
  // ============================================================

  /**
   * Handles navigation events — shows or hides the page based on the URL.
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash.startsWith("#/hidden-content") || path === "/hidden-content") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  /**
   * Handles viewshow events from Jellyfin's page system.
   * Hides our page when Jellyfin shows a different page.
   * @param {CustomEvent} e The viewshow event.
   */
  function handleViewShow(e) {
    const targetPage = e.target;
    if (state.pageVisible && targetPage && targetPage.id !== "je-hidden-content-page") {
      hidePage();
    }
  }

  /**
   * Handles clicks on Jellyfin navigation elements.
   * Hides our page when the user clicks a nav button that isn't ours.
   * @param {MouseEvent} e The click event.
   */
  function handleNavClick(e) {
    if (!state.pageVisible) return;

    const btn = e.target.closest(".headerTabs button, .navMenuOption, .headerButton");
    if (btn && !btn.classList.contains("je-nav-hidden-content-item")) {
      hidePage();
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
  }

  /**
   * Injects the "Hidden Content" navigation item into the sidebar.
   * Inserts after the Calendar nav item if present, otherwise appends at end.
   */
  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.HiddenContentEnabled) return;
    if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
    if (config.HiddenContentUseCustomTabs) return;
    if (config.HiddenContentUseNativeTab) return;

    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    if (document.querySelector(".je-nav-hidden-content-item")) return;

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-hidden-content-item";
      navItem.href = "#";

      const iconSpan = document.createElement("span");
      iconSpan.className = "navMenuOptionIcon material-icons";
      iconSpan.textContent = "visibility_off";
      navItem.appendChild(iconSpan);

      const textSpan = document.createElement("span");
      textSpan.className = "sectionName navMenuOptionText";
      textSpan.textContent = JE.t("hidden_content_manage_title");
      navItem.appendChild(textSpan);

      navItem.addEventListener("click", (e) => {
        e.preventDefault();
        showPage();
      });

      const calendarNavItem = jellyfinEnhancedSection.querySelector('.je-nav-calendar-item');
      if (calendarNavItem && calendarNavItem.nextSibling) {
        jellyfinEnhancedSection.insertBefore(navItem, calendarNavItem.nextSibling);
      } else if (calendarNavItem) {
        jellyfinEnhancedSection.appendChild(navItem);
      } else {
        jellyfinEnhancedSection.appendChild(navItem);
      }
      console.log(`${logPrefix} Navigation item injected`);
    } else {
      console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
    }
  }

  /**
   * Sets up a MutationObserver to re-inject the navigation item when
   * Jellyfin rebuilds the sidebar.
   */
  function setupNavigationWatcher() {
    const config = JE.pluginConfig || {};
    if (!config.HiddenContentEnabled) return;
    if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
    if (config.HiddenContentUseCustomTabs) return;
    if (config.HiddenContentUseNativeTab) return;

    const observer = new MutationObserver(() => {
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.HiddenContentUseCustomTabs) return;
      if (currentConfig.HiddenContentUseNativeTab) return;
      if (pluginPagesExists && currentConfig.HiddenContentUsePluginPages) return;

      if (!document.querySelector('.je-nav-hidden-content-item')) {
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

  Object.assign(internal, {
    createPageContainer,
    showPage,
    hidePage,
    interceptNavigation,
    handleNavigation,
    handleViewShow,
    handleNavClick,
    injectNavigation,
    setupNavigationWatcher,
    renderForCustomTab,
  });

})();
