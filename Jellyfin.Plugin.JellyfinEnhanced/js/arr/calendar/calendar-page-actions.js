(() => {
"use strict";
(() => {
  // client/src/features/calendar/lifetime.ts
  function lifetime(ctx) {
    var _a;
    return (_a = ctx.own).calendarLifetime || (_a.calendarLifetime = { view: 0, navigation: 0, refresh: 0, events: 0, userData: 0, requests: 0, initialized: false, disposers: /* @__PURE__ */ new Map() });
  }
  function lease(ctx, channel) {
    const JE = ctx.core, owner = lifetime(ctx), view = owner.view, epoch = JE.session?.getEpoch(), session = JE.session?.createLease?.();
    const serial = channel ? ++owner[channel] : 0;
    const container = ctx.own.calendarPage?.state?._customTabContainer;
    return () => owner.view === view && (!channel || owner[channel] === serial) && (epoch === void 0 || JE.session?.isCurrent(epoch) === true) && (!session || session.isCurrent()) && (!container || container.isConnected && JE.helpers.isActiveTabContainer(container));
  }
  function cancelNavigation(ctx) {
    lifetime(ctx).navigation++;
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

  // client/src/features/calendar/calendar-page-actions.ts
  (function() {
    "use strict";
    const { JE, ctx, P } = export0();
    const state = P.state;
    const renderPage = P.renderPage;
    const getRangeForView = P.getRangeForView;
    const fetchCalendarEvents = P.fetchCalendarEvents;
    const fetchUserData = P.fetchUserData;
    const ensureRequestData = P.ensureRequestData;
    const setStoredShowUnmonitored = P.setStoredShowUnmonitored;
    const saveFilters = P.saveFilters;
    const setStoredCollapse = P.setStoredCollapse;
    const searchFromProviders = P.searchFromProviders;
    const toggleSidebarCollapsed = P.toggleSidebarCollapsed;
    const syncPageModeClasses = P.syncPageModeClasses;
    const updateDisplayModeButtons = P.updateDisplayModeButtons;
    const logPrefix = "🪼 Jellyfin Enhanced: Calendar Page:";
    async function loadAllData() {
      cancelNavigation(ctx);
      const current = lease(ctx, "refresh");
      if (!current()) return;
      P.loadSettings();
      state.isLoading = true;
      renderPage();
      const { start, end } = getRangeForView(state.currentDate, state.viewMode);
      state.rangeStart = start;
      state.rangeEnd = end;
      await fetchCalendarEvents(start, end);
      if (!current()) return;
      await fetchUserData();
      if (!current()) return;
      if (state.activeFilters.has("Requests") || state.settings.forceOnlyRequested) {
        await ensureRequestData();
      }
      if (!current()) return;
      state.isLoading = false;
      renderPage();
    }
    function setViewMode(mode) {
      const current = lease(ctx);
      if (state.viewMode === mode) return;
      state.viewMode = mode;
      syncPageModeClasses();
      JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
      JE.currentSettings.calendarDefaultViewMode = mode;
      if (typeof JE.saveUserSettings === "function") {
        Promise.resolve(JE.saveUserSettings("settings.json", JE.currentSettings)).catch(() => {
          if (current()) JE.toast?.("Calendar preference could not be saved.");
        });
      }
      loadAllData();
    }
    function setDisplayMode(mode) {
      const current = lease(ctx);
      if (!mode || state.settings.displayMode === mode) return;
      cancelNavigation(ctx);
      state.settings.displayMode = mode;
      syncPageModeClasses();
      JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
      JE.currentSettings.calendarDisplayMode = mode;
      if (typeof JE.saveUserSettings === "function") {
        Promise.resolve(JE.saveUserSettings("settings.json", JE.currentSettings)).catch(() => {
          if (current()) JE.toast?.("Calendar preference could not be saved.");
        });
      }
      if (state.viewMode === "agenda") {
        updateDisplayModeButtons();
        return;
      }
      renderPage();
    }
    function shiftPeriod(direction) {
      const delta = direction === "next" ? 1 : -1;
      const current = new Date(state.currentDate);
      if (state.viewMode === "month") {
        current.setDate(1);
        current.setMonth(current.getMonth() + delta);
      } else if (state.viewMode === "week") {
        current.setDate(current.getDate() + delta * 7);
      } else if (state.viewMode === "day") {
        current.setDate(current.getDate() + delta);
      } else {
        current.setDate(current.getDate() + delta * 30);
      }
      state.currentDate = current;
      loadAllData();
    }
    function goToday() {
      state.currentDate = /* @__PURE__ */ new Date();
      loadAllData();
    }
    function toggleFilter(filterType) {
      if (state.settings.forceOnlyRequested && filterType === "Requests") {
        return;
      }
      cancelNavigation(ctx);
      if (state.activeFilters.has(filterType)) {
        state.activeFilters.delete(filterType);
      } else {
        state.activeFilters.add(filterType);
        if (filterType === "Requests") {
          ensureRequestData();
        }
      }
      saveFilters();
      renderPage();
    }
    function setFilterMatchMode(mode) {
      if (!mode || mode !== "any" && mode !== "all") return;
      if (state.activeFilters.size < 2) return;
      if (state.filterMatchMode === mode) return;
      cancelNavigation(ctx);
      state.filterMatchMode = mode;
      saveFilters();
      renderPage();
    }
    function toggleFilterInvert() {
      if (state.activeFilters.size === 0) return;
      cancelNavigation(ctx);
      state.filterInvert = !state.filterInvert;
      saveFilters();
      renderPage();
    }
    function toggleCollapseEpisodes() {
      cancelNavigation(ctx);
      state.settings.collapseEpisodes = !state.settings.collapseEpisodes;
      setStoredCollapse(state.settings.collapseEpisodes);
      renderPage();
    }
    function toggleShowUnmonitored() {
      cancelNavigation(ctx);
      state.settings.showUnmonitored = !state.settings.showUnmonitored;
      setStoredShowUnmonitored(state.settings.showUnmonitored);
      renderPage();
    }
    async function navigateToJellyfinItem(event, options = {}) {
      const current = lease(ctx, "navigation");
      if (!current()) return;
      const preferSeries = !!options.preferSeries;
      const isMovie = event.type === "Movie";
      if (!event.hasFile && (!preferSeries || isMovie)) return;
      const itemId = preferSeries || isMovie ? event.itemId : event.itemEpisodeId;
      if (itemId) {
        window.location.hash = `#/details?id=${itemId}`;
        return;
      }
      if (event.itemEpisodeId && !preferSeries) {
        window.location.hash = `#/details?id=${event.itemEpisodeId}`;
        return;
      }
      try {
        const providerItemId = await searchFromProviders(event, { preferSeries });
        if (!current()) return;
        if (providerItemId) {
          window.location.hash = `#/details?id=${providerItemId}`;
          return;
        }
      } catch (error) {
        console.error(`${logPrefix} Navigation failed:`, error);
      }
    }
    function handleEventClick(e) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const sidebarToggle = target.closest(".je-calendar-sidebar-toggle");
      if (sidebarToggle) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleSidebarCollapsed();
        return;
      }
      const filterModeBtn = target.closest(".je-calendar-filter-btn");
      if (filterModeBtn) {
        const mode = filterModeBtn.dataset.filterMode;
        if (mode) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setFilterMatchMode(mode);
        }
        return;
      }
      const filterInvertBtn = target.closest(".je-calendar-filter-invert");
      if (filterInvertBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleFilterInvert();
        return;
      }
      const modeBtn = target.closest(".je-calendar-mode-btn");
      if (modeBtn) {
        const mode = modeBtn.dataset.mode;
        if (mode) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setDisplayMode(mode);
        }
        return;
      }
      const groupBtn = target.closest(".je-calendar-group-toggle");
      if (groupBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const key = groupBtn.dataset.groupKey;
        if (!key) return;
        cancelNavigation(ctx);
        if (!state.expandedGroups.delete(key)) state.expandedGroups.add(key);
        renderPage();
        return;
      }
      const playBtn = target.closest(".je-calendar-play-btn");
      if (playBtn) {
        const playEventId = playBtn.dataset.eventId;
        const playEvent = state.events.find((ev) => ev.id === playEventId);
        if (!playEvent) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        navigateToJellyfinItem(playEvent, { preferSeries: false });
        return;
      }
      const timePill = target.closest(".je-calendar-card-time");
      if (timePill) {
        const cardEl = timePill.closest(".je-calendar-card");
        const timeEventId = cardEl?.dataset.eventId;
        const timeEvent = timeEventId ? state.events.find((ev) => ev.id === timeEventId) : null;
        if (timeEvent?.hasFile) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          navigateToJellyfinItem(timeEvent, { preferSeries: false });
          return;
        }
      }
      const eventEl = target.closest(".je-calendar-event, .je-calendar-agenda-event, .je-calendar-card");
      if (!eventEl) return;
      const eventId = eventEl.dataset.eventId;
      if (!eventId) return;
      const event = state.events.find((ev) => ev.id === eventId);
      if (!event) return;
      e.preventDefault();
      e.stopPropagation();
      navigateToJellyfinItem(event, { preferSeries: true });
    }
    P.loadAllData = loadAllData;
    P.setViewMode = setViewMode;
    P.setDisplayMode = setDisplayMode;
    P.shiftPeriod = shiftPeriod;
    P.goToday = goToday;
    P.toggleFilter = toggleFilter;
    P.toggleShowUnmonitored = toggleShowUnmonitored;
    P.toggleCollapseEpisodes = toggleCollapseEpisodes;
    P.handleEventClick = handleEventClick;
  })();
})();
})();
//# sourceMappingURL=calendar-page-actions.js.map
