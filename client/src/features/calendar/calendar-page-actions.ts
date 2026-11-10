import { lease, cancelNavigation } from './lifetime';
import { calendarHost } from './host';
import type { CalendarEvent } from './types';
// /js/arr/calendar/calendar-page-actions.js
// Calendar Page — user actions: data refresh, view/display mode switching,
// filter toggles and event-click navigation (split from calendar-page.js).
(function () {
  "use strict";

  const { JE, ctx, P } = calendarHost();

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

  const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

  /**
   * Load all data
   */
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

    // First fetch calendar events
    await fetchCalendarEvents(start, end);
    if (!current()) return;

    // Then fetch user data for those specific events
    await fetchUserData();
    if (!current()) return;

    if (state.activeFilters.has("Requests") || state.settings.forceOnlyRequested) {
      await ensureRequestData();
    }

    if (!current()) return;
    state.isLoading = false;
    renderPage();
  }

  // Switch between month/week/agenda views
  function setViewMode(mode: string) {
    const current = lease(ctx);
    if (state.viewMode === mode) return;
    state.viewMode = mode;
    syncPageModeClasses();

    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDefaultViewMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      Promise.resolve(JE.saveUserSettings('settings.json', JE.currentSettings)).catch(() => {
        if (current()) JE.toast?.('Calendar preference could not be saved.');
      });
    }

    loadAllData();
  }

  function setDisplayMode(mode: string) {
    const current = lease(ctx);
    if (!mode || state.settings.displayMode === mode) return;
    cancelNavigation(ctx);
    state.settings.displayMode = mode;
    syncPageModeClasses();
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDisplayMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      Promise.resolve(JE.saveUserSettings('settings.json', JE.currentSettings)).catch(() => {
        if (current()) JE.toast?.('Calendar preference could not be saved.');
      });
    }

    if (state.viewMode === "agenda") {
      updateDisplayModeButtons();
      return;
    }

    renderPage();
  }

  // Navigate forward or backward
  function shiftPeriod(direction: string) {
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

  // Jump to today's date
  function goToday() {
    state.currentDate = new Date();
    loadAllData();
  }

  // Toggle filter on/off
  function toggleFilter(filterType: string) {
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

  function setFilterMatchMode(mode: string) {
    if (!mode || (mode !== 'any' && mode !== 'all')) return;
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

  // Toggle show unmonitored series on/off
  function toggleShowUnmonitored() {
    cancelNavigation(ctx);
    state.settings.showUnmonitored = !state.settings.showUnmonitored;
    setStoredShowUnmonitored(state.settings.showUnmonitored);
    renderPage();
  }

  /**
   * Navigate to Jellyfin item by provider IDs
   */
  async function navigateToJellyfinItem(event: CalendarEvent, options: {preferSeries?: boolean} = {}) {
    const current = lease(ctx, "navigation");
    if (!current()) return;
    const preferSeries = !!options.preferSeries;
    const isMovie = event.type === "Movie";

    if (!event.hasFile && (!preferSeries || isMovie)) return;

    const itemId = (preferSeries || isMovie)
      ? event.itemId
      : event.itemEpisodeId;

    // No need to search if itemId is already provided
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

  /**
   * Handle click on calendar event
   */
  function handleEventClick(e: Event) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const sidebarToggle = target.closest<HTMLElement>(".je-calendar-sidebar-toggle");
    if (sidebarToggle) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleSidebarCollapsed();
      return;
    }

    const filterModeBtn = target.closest<HTMLElement>(".je-calendar-filter-btn");
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

    const filterInvertBtn = target.closest<HTMLElement>(".je-calendar-filter-invert");
    if (filterInvertBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleFilterInvert();
      return;
    }

    const modeBtn = target.closest<HTMLElement>(".je-calendar-mode-btn");
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

    const groupBtn = target.closest<HTMLElement>(".je-calendar-group-toggle");
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

    const playBtn = target.closest<HTMLElement>(".je-calendar-play-btn");
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

    const timePill = target.closest<HTMLElement>(".je-calendar-card-time");
    if (timePill) {
      const cardEl = timePill.closest<HTMLElement>(".je-calendar-card");
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

    const eventEl = target.closest<HTMLElement>(".je-calendar-event, .je-calendar-agenda-event, .je-calendar-card");
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
