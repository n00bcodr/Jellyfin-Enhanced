import { invalidate, lifetime, own, disposeCalendar } from './lifetime';
import { calendarHost } from './host';
// /js/arr/calendar/calendar-page-init.js
// Calendar Page — initialization, navigation interception, page show/hide
// and the public JE.calendarPage surface (split from calendar-page.js).
// The navigation-watcher fallback interval is tracked with JE.core.lifecycle.
(function () {
  "use strict";

  const { JE, ctx, P } = calendarHost();

  const state = P.state;
  const injectStyles = P.injectStyles;
  const loadSettings = P.loadSettings;
  const createPageContainer = P.createPageContainer;
  const renderPage = P.renderPage;
  const loadAllData = P.loadAllData;
  const handleEventClick = P.handleEventClick;

  // Feature-scoped resource registry (interval fallback, unsubscribe fns).
  const lifecycle = JE.core.lifecycle.register('arr-calendar-page');

  const sidebar = document.querySelector<HTMLElement>('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector<HTMLElement>(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
  );

  const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

  /**
   * Initialize calendar page
   */
  function initialize() {
    if (lifetime(ctx).initialized) return;
    console.log(`${logPrefix} Initializing calendar page module`);

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) {
      console.log(`${logPrefix} Calendar page is disabled`);
      return;
    }

    lifetime(ctx).initialized = true;
    lifecycle.track(() => disposeCalendar(ctx));
    injectStyles();
    loadSettings();

    const usingPluginPages = pluginPagesExists && config.CalendarUsePluginPages;
    if (usingPluginPages) {
      console.log(`${logPrefix} Calendar page is injected via Plugin Pages`);
      return;
    }

    // Page-specific setup for custom tabs or dedicated page mode
    // Inject navigation and set up one-time re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Setup event listeners
    lifecycle.addListener(window, "hashchange", interceptNavigation, true);
    lifecycle.addListener(window, "popstate", interceptNavigation, true);
    lifecycle.addListener(document, "viewshow", handleViewShow);
    lifecycle.addListener(document, "click", handleNavClick);
    lifecycle.addListener(document, "click", handleEventClick);

    startLocationWatcher();

    // Check location on init
    handleNavigation();

    console.log(`${logPrefix} Calendar page module initialized`);
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
            const t = setInterval(check, 150);
            return () => clearInterval(t);
          })(),
    );
  }

  /**
   * Intercept hash/popstate changes for our route before Jellyfin router
   */
  function interceptNavigation(e: Event) {
    const url = e instanceof HashChangeEvent ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash.startsWith("#/calendar") || path === "/calendar";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  function stopLocationWatcher() {
    if (state.locationUnsubscribe) {
      lifecycle.untrack(state.locationUnsubscribe);
      state.locationUnsubscribe();
      state.locationUnsubscribe = null;
    }
  }

  /**
   * Show page
   */
  function showPage() {
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;

    invalidate(ctx);
    state._customTabContainer = null;
    state.pageVisible = true;
    loadSettings();
    startLocationWatcher();

    injectStyles();
    const page = createPageContainer();

    if (window.location.hash !== "#/calendar") {
      history.pushState({ page: "calendar" }, "Calendar", "#/calendar");
    }

    const activePage = document.querySelector<HTMLElement>(".mainAnimatedPage:not(.hide):not(#je-calendar-page)");
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

    // Only load data once (guard against showPage retries)
    if (!state.isLoading) {
      loadAllData();
    }
  }

  /**
   * Hide page
   */
  function hidePage() {
    if (!state.pageVisible) return;
    invalidate(ctx);

    const page = document.getElementById("je-calendar-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "custom" },
        }),
      );
    }

    // Restore the previous page if Jellyfin's router hasn't already shown another page
    if (state.previousPage && !document.querySelector<HTMLElement>(".mainAnimatedPage:not(.hide):not(#je-calendar-page)")) {
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
    stopLocationWatcher();
  }

  /**
   * Handle navigation
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash === "#/calendar" || path === "/calendar") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  /**
   * Handle viewshow events
   */
  function handleViewShow(e: Event) {
    const targetPage = e.target instanceof Element ? e.target : null;
    if (!targetPage || targetPage.id === "je-calendar-page") return;
    if (state.pageVisible) hidePage();
    // Jellyfin's router answers an in-app visit to our route with "Page not found"; once that has shown, show ours over it as a full load does.
    queueMicrotask(handleNavigation);
  }

  /**
   * Handle nav click
   */
  function handleNavClick(e: Event) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!state.pageVisible) return;

    const btn = target.closest<HTMLElement>(".headerTabs button, .navMenuOption, .headerButton");
    if (btn && !btn.classList.contains("je-nav-calendar-item")) {
      hidePage();
    }
  }

  /**
   * Inject navigation item into sidebar
   */
  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;
    if (config.CalendarUseCustomTabs) return; // Skip if using custom tabs
    if (config.CalendarUseNativeTab) return; // Skip if using the native tab

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector<HTMLElement>(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    // Check if already exists
    if (document.querySelector<HTMLElement>(".je-nav-calendar-item")) {
      return;
    }

    const jellyfinEnhancedSection = document.querySelector<HTMLElement>('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-calendar-item";
      navItem.href = "#";
      navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">calendar_today</span>
        <span class="sectionName navMenuOptionText">${JE.t("calendar_title")}</span>
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
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;
    if (config.CalendarUseCustomTabs) return; // Don't watch if using custom tabs
    if (config.CalendarUseNativeTab) return; // Don't watch if using the native tab

    // Shared watcher (helpers.onSidebarRebuilt): runs only when the link is
    // gone and the section exists, instead of a document-wide observer.
    own(ctx, 'sidebar', JE.helpers.onSidebarRebuilt('calendar', '.je-nav-calendar-item', () => {
      // Re-check config each time to avoid injecting when settings change
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.CalendarUseCustomTabs) return;
      if (currentConfig.CalendarUseNativeTab) return;
      if (pluginPagesExists && currentConfig.CalendarUsePluginPages) return;
      console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
      injectNavigation();
    }));
  }

  /**
   * Render content for custom tabs (without page state management).
   * @param {HTMLElement} [targetContainer] - Optional container element to
   *   render into, avoiding global getElementById lookups.
   */
  function renderForCustomTab(targetContainer?: HTMLElement) {
    if (state._customTabContainer !== targetContainer) invalidate(ctx);
    injectStyles();
    loadSettings();
    renderPage(targetContainer);
    loadAllData();
  }

  // Export to JE namespace
  JE.calendarPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    setViewMode: P.setViewMode,
    shiftPeriod: P.shiftPeriod,
    goToday: P.goToday,
    toggleFilter: P.toggleFilter,
    toggleShowUnmonitored: P.toggleShowUnmonitored,
    toggleCollapseEpisodes: P.toggleCollapseEpisodes,
    renderPage,
    renderForCustomTab,
    injectStyles,
    loadSettings,
    handleEventClick,
    setDisplayMode: P.setDisplayMode
  };

  ctx.own.initializeCalendarPage = initialize;
})();
