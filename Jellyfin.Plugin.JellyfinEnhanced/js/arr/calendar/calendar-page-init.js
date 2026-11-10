(() => {
"use strict";
(() => {
  // client/src/features/calendar/lifetime.ts
  function lifetime(ctx) {
    var _a;
    return (_a = ctx.own).calendarLifetime || (_a.calendarLifetime = { view: 0, navigation: 0, refresh: 0, events: 0, userData: 0, requests: 0, initialized: false, disposers: /* @__PURE__ */ new Map() });
  }
  function invalidate(ctx) {
    const owner = lifetime(ctx);
    owner.view++;
    const state = ctx.own.calendarPage?.state;
    if (state) {
      state.isLoading = false;
      state.requestedLoading = false;
    }
  }
  function own(ctx, key, dispose) {
    const owner = lifetime(ctx);
    owner.disposers.get(key)?.();
    owner.disposers.set(key, dispose);
  }
  function disposeCalendar(ctx) {
    invalidate(ctx);
    const owner = lifetime(ctx);
    for (const dispose of owner.disposers.values()) dispose();
    owner.disposers.clear();
    owner.initialized = false;
    const state = ctx.own.calendarPage?.state;
    if (state) {
      state._customTabContainer = null;
      state.pageVisible = false;
      state.locationUnsubscribe = null;
    }
  }

  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/calendar/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/calendar/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "calendarHost");

  // client/src/features/calendar/calendar-page-init.ts
  (function() {
    "use strict";
    const { JE, ctx, P } = export0();
    const state = P.state;
    const injectStyles = P.injectStyles;
    const loadSettings = P.loadSettings;
    const createPageContainer = P.createPageContainer;
    const renderPage = P.renderPage;
    const loadAllData = P.loadAllData;
    const handleEventClick = P.handleEventClick;
    const lifecycle = JE.core.lifecycle.register("arr-calendar-page");
    const sidebar = document.querySelector(".mainDrawer-scrollContainer");
    const pluginPagesExists = !!sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
    );
    const logPrefix = "🪼 Jellyfin Enhanced: Calendar Page:";
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
      injectNavigation();
      setupNavigationWatcher();
      lifecycle.addListener(window, "hashchange", interceptNavigation, true);
      lifecycle.addListener(window, "popstate", interceptNavigation, true);
      lifecycle.addListener(document, "viewshow", handleViewShow);
      lifecycle.addListener(document, "click", handleNavClick);
      lifecycle.addListener(document, "click", handleEventClick);
      startLocationWatcher();
      handleNavigation();
      console.log(`${logPrefix} Calendar page module initialized`);
    }
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
      state.locationUnsubscribe = lifecycle.track(
        JE.helpers?.onNavigate ? JE.helpers.onNavigate(check) : (() => {
          const t = setInterval(check, 150);
          return () => clearInterval(t);
        })()
      );
    }
    function interceptNavigation(e) {
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
      const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-calendar-page)");
      if (activePage) {
        state.previousPage = activePage;
        activePage.classList.add("hide");
        activePage.dispatchEvent(
          new CustomEvent("viewhide", {
            bubbles: true,
            detail: { type: "interior" }
          })
        );
      }
      page.classList.remove("hide");
      page.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: {
            type: "custom",
            isRestored: false,
            options: {}
          }
        })
      );
      page.dispatchEvent(
        new CustomEvent("pageshow", {
          bubbles: true,
          detail: {}
        })
      );
      if (!state.isLoading) {
        loadAllData();
      }
    }
    function hidePage() {
      if (!state.pageVisible) return;
      invalidate(ctx);
      const page = document.getElementById("je-calendar-page");
      if (page) {
        page.classList.add("hide");
        page.dispatchEvent(
          new CustomEvent("viewhide", {
            bubbles: true,
            detail: { type: "custom" }
          })
        );
      }
      if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-calendar-page)")) {
        state.previousPage.classList.remove("hide");
        state.previousPage.dispatchEvent(
          new CustomEvent("viewshow", {
            bubbles: true,
            detail: { type: "interior", isRestored: true }
          })
        );
      }
      state.pageVisible = false;
      state.previousPage = null;
      stopLocationWatcher();
    }
    function handleNavigation() {
      const hash = window.location.hash;
      const path = window.location.pathname;
      if (hash === "#/calendar" || path === "/calendar") {
        showPage();
      } else if (state.pageVisible) {
        hidePage();
      }
    }
    function handleViewShow(e) {
      const targetPage = e.target instanceof Element ? e.target : null;
      if (state.pageVisible && targetPage && targetPage.id !== "je-calendar-page") {
        hidePage();
      }
    }
    function handleNavClick(e) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!state.pageVisible) return;
      const btn = target.closest(".headerTabs button, .navMenuOption, .headerButton");
      if (btn && !btn.classList.contains("je-nav-calendar-item")) {
        hidePage();
      }
    }
    function injectNavigation() {
      const config = JE.pluginConfig || {};
      if (!config.CalendarPageEnabled) return;
      if (pluginPagesExists && config.CalendarUsePluginPages) return;
      if (config.CalendarUseCustomTabs) return;
      if (config.CalendarUseNativeTab) return;
      const pluginPageItem = sidebar?.querySelector(
        'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
      );
      if (pluginPageItem) {
        pluginPageItem.style.setProperty("display", "none", "important");
      }
      if (document.querySelector(".je-nav-calendar-item")) {
        return;
      }
      const jellyfinEnhancedSection = document.querySelector(".jellyfinEnhancedSection");
      if (jellyfinEnhancedSection) {
        const navItem = document.createElement("a");
        navItem.setAttribute("is", "emby-linkbutton");
        navItem.className = "navMenuOption lnkMediaFolder emby-button je-nav-calendar-item";
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
    function setupNavigationWatcher() {
      const config = JE.pluginConfig || {};
      if (!config.CalendarPageEnabled) return;
      if (pluginPagesExists && config.CalendarUsePluginPages) return;
      if (config.CalendarUseCustomTabs) return;
      if (config.CalendarUseNativeTab) return;
      own(ctx, "sidebar", JE.helpers.onSidebarRebuilt("calendar", ".je-nav-calendar-item", () => {
        const currentConfig = JE.pluginConfig || {};
        if (currentConfig.CalendarUseCustomTabs) return;
        if (currentConfig.CalendarUseNativeTab) return;
        if (pluginPagesExists && currentConfig.CalendarUsePluginPages) return;
        console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
        injectNavigation();
      }));
    }
    function renderForCustomTab(targetContainer) {
      if (state._customTabContainer !== targetContainer) invalidate(ctx);
      injectStyles();
      loadSettings();
      renderPage(targetContainer);
      loadAllData();
    }
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
})();
})();
//# sourceMappingURL=calendar-page-init.js.map
