// /js/arr/calendar/calendar-page-actions.js
// Calendar Page — user actions: data refresh, view/display mode switching,
// filter toggles and event-click navigation (split from calendar-page.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.calendarPage = JE.internals.calendarPage || {});

  const state = P.state;
  const renderPage = P.renderPage;
  const getRangeForView = P.getRangeForView;
  const fetchCalendarEvents = P.fetchCalendarEvents;
  const fetchUserData = P.fetchUserData;
  const ensureRequestData = P.ensureRequestData;
  const setStoredShowUnmonitored = P.setStoredShowUnmonitored;
  const searchFromProviders = P.searchFromProviders;
  const toggleSidebarCollapsed = P.toggleSidebarCollapsed;
  const syncPageModeClasses = P.syncPageModeClasses;
  const updateDisplayModeButtons = P.updateDisplayModeButtons;

  const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

  /**
   * Load all data
   */
  async function loadAllData() {
    state.isLoading = true;
    renderPage();

    const { start, end } = getRangeForView(state.currentDate, state.viewMode);
    state.rangeStart = start;
    state.rangeEnd = end;

    // First fetch calendar events
    await fetchCalendarEvents(start, end);

    // Then fetch user data for those specific events
    await fetchUserData();

    if (state.activeFilters.has("Requests") || state.settings.forceOnlyRequested) {
      await ensureRequestData();
    }

    state.isLoading = false;
    renderPage();
  }

  /**
   * Reads the events again after a failed load (the error box's Try again). Ignored while a load is
   * already running, so repeated clicks start one read.
   * @returns {Promise<void>|undefined}
   */
  function retry() {
    if (state.isLoading) return undefined;
    return loadAllData();
  }

  // Switch between month/week/agenda views
  function setViewMode(mode) {
    if (state.viewMode === mode) return;
    state.viewMode = mode;
    syncPageModeClasses();

    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDefaultViewMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      JE.saveUserSettings('settings.json', JE.currentSettings, { origin: JE.core.userWrite.origin() });
    }

    loadAllData();
  }

  function setDisplayMode(mode) {
    if (!mode || state.settings.displayMode === mode) return;
    state.settings.displayMode = mode;
    syncPageModeClasses();
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDisplayMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      JE.saveUserSettings('settings.json', JE.currentSettings, { origin: JE.core.userWrite.origin() });
    }

    if (state.viewMode === "agenda") {
      updateDisplayModeButtons();
      return;
    }

    renderPage();
  }

  // Navigate forward or backward
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

  // Jump to today's date
  function goToday() {
    state.currentDate = new Date();
    loadAllData();
  }

  // Toggle filter on/off
  function toggleFilter(filterType) {
    if (state.settings.forceOnlyRequested && filterType === "Requests") {
      return;
    }

    if (state.activeFilters.has(filterType)) {
      state.activeFilters.delete(filterType);
    } else {
      state.activeFilters.add(filterType);
      if (filterType === "Requests") {
        ensureRequestData();
      }
    }
    renderPage();
  }

  function setFilterMatchMode(mode) {
    if (!mode || (mode !== 'any' && mode !== 'all')) return;
    if (state.activeFilters.size < 2) return;
    if (state.filterMatchMode === mode) return;
    state.filterMatchMode = mode;
    renderPage();
  }

  function toggleFilterInvert() {
    if (state.activeFilters.size === 0) return;
    state.filterInvert = !state.filterInvert;
    renderPage();
  }

  // Toggle show unmonitored series on/off
  function toggleShowUnmonitored() {
    state.settings.showUnmonitored = !state.settings.showUnmonitored;
    setStoredShowUnmonitored(state.settings.showUnmonitored);
    renderPage();
  }

  /**
   * The title key of a calendar event (movie by TMDB/IMDb, series by TVDB/TMDB), or null.
   * @param {Object} event Calendar event.
   * @returns {string|null} Key.
   */
  function titleKeyOf(event) {
    if (event.type === "Movie") {
      if (Number(event.tmdbId) > 0) return `movie:tmdb:${Number(event.tmdbId)}`;
      return /^tt\d+$/.test(String(event.imdbId || "")) ? `movie:imdb:${event.imdbId}` : null;
    }
    if (Number(event.tvdbId) > 0) return `tv:tvdb:${Number(event.tvdbId)}`;
    return Number(event.tmdbId) > 0 ? `tv:tmdb:${Number(event.tmdbId)}` : null;
  }

  /**
   * A title that isn't in the library (or not for this viewer): its native details page — the
   * episode's when the event names one — through the navigator, which takes a copy the viewer can
   * open first. Returns false when native details aren't offered.
   * @param {Object} event Calendar event.
   * @param {boolean} preferSeries Open the series rather than the episode.
   * @returns {Promise<boolean>} Opened.
   */
  async function openAbsent(event, preferSeries) {
    if (JE.titleDetails?.available?.() !== true) return false;
    const key = titleKeyOf(event);
    if (!key) return false;
    const isMovie = event.type === "Movie";
    const scoped = !isMovie && !preferSeries && Number.isInteger(event.seasonNumber) && Number.isInteger(event.episodeNumber);
    return JE.titleDetails.openKey(key, {
      mediaType: isMovie ? "movie" : "tv",
      tmdbId: Number(event.tmdbId) > 0 ? Number(event.tmdbId) : undefined,
      season: scoped ? event.seasonNumber : undefined,
      episode: scoped ? event.episodeNumber : undefined,
    });
  }

  /**
   * Navigate to Jellyfin item by provider IDs (or, with native details on, to the title's page when
   * it isn't in the library).
   */
  async function navigateToJellyfinItem(event, options = {}) {
    const preferSeries = !!options.preferSeries;
    const isMovie = event.type === "Movie";

    if (!event.hasFile && (!preferSeries || isMovie)) {
      await openAbsent(event, preferSeries);
      return;
    }

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
      if (providerItemId) {
        window.location.hash = `#/details?id=${providerItemId}`;
        return;
      }
      await openAbsent(event, preferSeries);
    } catch (error) {
      console.error(`${logPrefix} Navigation failed:`, error);
    }
  }

  /**
   * Handle click on calendar event
   */
  function handleEventClick(e) {
    const sidebarToggle = e.target.closest(".je-calendar-sidebar-toggle");
    if (sidebarToggle) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleSidebarCollapsed();
      return;
    }

    const filterModeBtn = e.target.closest(".je-calendar-filter-btn");
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

    const filterInvertBtn = e.target.closest(".je-calendar-filter-invert");
    if (filterInvertBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleFilterInvert();
      return;
    }

    const modeBtn = e.target.closest(".je-calendar-mode-btn");
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

    const playBtn = e.target.closest(".je-calendar-play-btn");
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

    const timePill = e.target.closest(".je-calendar-card-time");
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

    const eventEl = e.target.closest(".je-calendar-event, .je-calendar-agenda-event, .je-calendar-card");
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
  P.retry = retry;
  P.setViewMode = setViewMode;
  P.setDisplayMode = setDisplayMode;
  P.shiftPeriod = shiftPeriod;
  P.goToday = goToday;
  P.toggleFilter = toggleFilter;
  P.toggleShowUnmonitored = toggleShowUnmonitored;
  P.handleEventClick = handleEventClick;
})();
