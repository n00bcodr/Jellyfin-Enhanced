// /js/arr/calendar-page.js
// Calendar Page - Shows upcoming releases from Sonarr and Radarr
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
  );

  // State management
  const state = {
    events: [],
    isLoading: false,
    pageVisible: false,
    previousPage: null,
    currentDate: new Date(),
    viewMode: getDefaultViewMode(),
    rangeStart: null,
    rangeEnd: null,
    settings: {
      firstDayOfWeek: "Monday",
      timeFormat: "5pm/5:30pm",
      highlightFavorites: false,
      highlightWatchedSeries: false,
    },
    userDataMap: new Map(),
    activeFilters: new Set(), // Track active filters
    locationSignature: null,
    locationTimer: null,
  };

  // Status color mapping
  const STATUS_COLORS = {
    CinemaRelease: "#2196f3",
    DigitalRelease: "#9c27b0",
    PhysicalRelease: "#ff5722",
    Episode: "#4caf50",
  };

  const SONARR_ICON_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg";
  const RADARR_ICON_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg";

  // CSS Styles
  const CSS_STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200');

    .je-calendar-page {
      padding: 2em;
      max-width: 95vw;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    .je-calendar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2em;
      padding-top: 2em;
      flex-wrap: wrap;
      gap: 1em;
    }

    .je-calendar-title {
      font-size: 2em;
      font-weight: 600;
      margin: 0;
    }

    .je-calendar-actions {
      display: flex;
      gap: 1em;
      align-items: center;
      flex-wrap: wrap;
    }

    .je-calendar-nav {
      display: inline-flex;
      gap: 0.5em;
      align-items: center;
    }

    .je-calendar-nav-btn,
    .je-calendar-view-btn {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: inherit;
      padding: 0.45em 0.9em;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-weight: 600;
    }

    .je-calendar-nav-btn:hover,
    .je-calendar-view-btn:hover {
      background: rgba(255,255,255,0.14);
    }

    .je-calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 1em;
      margin-bottom: 2em;
    }

    .je-calendar-day {
      background: rgba(128,128,128,0.05);
      border-radius: 0.5em;
      padding: 1em;
      min-height: 150px;
      border: 1px solid rgba(128,128,128,0.2);
    }

    .je-calendar-day-header {
      font-weight: 600;
      text-align: center;
      margin-bottom: 0.5em;
      padding-bottom: 0.5em;
      border-bottom: 1px solid rgba(128,128,128,0.2);
    }

    .je-calendar-day-number {
      display: inline-block;
      font-size: 1.2em;
      font-weight: 700;
    }

    .je-calendar-day-name {
      display: block;
      font-size: 0.85em;
      opacity: 0.7;
      margin-top: 0.25em;
    }

    .je-calendar-events-list {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }

    .je-calendar-event {
      padding: 0.5em;
      border-radius: 0.25em;
      font-size: 0.85em;
      cursor: pointer;
      transition: all 0.2s;
      border-left: 3px solid;
      padding-left: 0.7em;
      position: relative;
    }

    .je-calendar-event:hover {
      transform: translateX(2px);
      opacity: 0.9;
    }

    .je-calendar-event.je-has-file::after {
      content: "✓";
      position: absolute;
      top: 0.3em;
      right: 0.4em;
      font-size: 0.7em;
      font-weight: bold;
      color: #4caf50;
      opacity: 0.9;
    }

    .je-calendar-event.je-has-file:hover {
      box-shadow: 0 0 8px rgba(76, 175, 80, 0.4);
    }

    /* Watchlist indicator - bookmark icon */
    .je-calendar-event.je-watchlist::before {
      content: "bookmark";
      font-family: 'Material Symbols Rounded';
      position: absolute;
      top: 0.15em;
      right: 1.1em;
      font-size: 0.9em;
      font-weight: normal;
      color: #ffd700;
      opacity: 0.9;
    }

    /* Watched indicator - visibility icon (shifts left if watchlist is present) */
    .je-calendar-event.je-watched::before {
      content: "visibility";
      font-family: 'Material Symbols Rounded';
      position: absolute;
      top: 0.15em ;
      right: 1.1em;
      font-size: 0.9em;
      font-weight: normal;
      color: #64b5f6;
      opacity: 0.9;
    }

    /* When both watchlist and watched, show both icons side by side */
    .je-calendar-event.je-watchlist.je-watched::before {
      content: "bookmark visibility";
      letter-spacing: 0.5em;
      right: 1.1em;
      background: linear-gradient(to right, #ffd700 0%, #ffd700 45%, #64b5f6 55%, #64b5f6 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    /* Adjust checkmark position when indicators are present */
    .je-calendar-event.je-has-file.je-watchlist::after,
    .je-calendar-event.je-has-file.je-watched::after {
      right: 0.4em;
    }

    .je-calendar-event.je-has-file.je-watchlist.je-watched::after {
      right: 0.4em;
    }

    .je-calendar-event-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    .je-calendar-event-subtitle {
      font-size: 0.8em;
      opacity: 0.75;
      display: block;
      margin-top: 0.2em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .je-calendar-event-type {
      font-size: 0.75em;
      opacity: 0.85;
      margin-top: 0.35em;
      display: flex;
      align-items: center;
      gap: 0.5em;
      flex-wrap: wrap;
    }

    .je-calendar-event-type img {
      width: 12px;
      height: 12px;
      object-fit: contain;
    }

    .je-calendar-event-time {
      font-weight: 600;
      opacity: 0.95;
    }

    .je-calendar-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5em;
      margin-top: 2em;
      padding: 1em;
      background: rgba(128,128,128,0.1);
      border-radius: 0.5em;
    }

    .je-calendar-legend-item {
      display: flex;
      align-items: center;
      gap: 0.5em;
      font-size: 0.9em;
      padding: 0.5em 0.75em;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
      border: 2px solid transparent;
    }

    .je-calendar-legend-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .je-calendar-legend-item.active {
      background: rgba(255, 255, 255, 0.12);
    }

    .je-calendar-legend-item.inactive {
      opacity: 0.4;
    }

    .je-calendar-empty {
      text-align: center;
      padding: 2em;
      opacity: 0.7;
    }

    .je-calendar-agenda {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding-left: 1em;
    }

    .je-calendar-agenda-row {
      display: flex;
      border-bottom: 1px solid rgba(128,128,128,0.15);
      padding: 0.75em 0;
      align-items: flex-start;
      gap: 0.5em;
    }

    .je-calendar-agenda-row:hover {
      background: rgba(128,128,128,0.05);
    }

    .je-calendar-agenda-date {
      min-width: 140px;
      flex-shrink: 0;
      padding: 0.5em;
      font-weight: 600;
      font-size: 0.95em;
      opacity: 0.85;
    }

    .je-calendar-agenda-events {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.75em;
    }

    .je-calendar-agenda-event {
      display: flex;
      align-items: center;
      gap: 0.75em;
      cursor: default;
    }

    .je-calendar-agenda-event.je-has-file {
      cursor: pointer;
    }

    .je-calendar-agenda-event.je-has-file:hover {
      background: rgba(76, 175, 80, 0.1);
      border-radius: 4px;
      padding: 0.5em;
      margin: -0.5em;
    }

    .je-calendar-agenda-indicators {
      display: flex;
      align-items: center;
      gap: 0.25em;
      min-width: 70px;
      flex-shrink: 0;
    }

    .je-calendar-agenda-event.je-has-file .je-available-indicator {
      color: #4caf50;
      font-size: 20px;
    }

    .je-available-indicator {
      font-size: 20px;
    }

    .je-watchlist-indicator-agenda {
      color: #ffd700;
      font-size: 20px;
    }

    .je-watched-indicator-agenda {
      color: #64b5f6;
      font-size: 20px;
    }

    .je-calendar-agenda-event-marker {
      width: 4px;
      height: 24px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .je-calendar-agenda-event-content {
      flex: 1;
      min-width: 0;
    }

    .je-calendar-agenda-event-title {
      font-weight: 600;
      font-size: 1em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 0.5em;
    }

    .je-calendar-agenda-event-meta {
      display: flex;
      align-items: center;
      gap: 0.5em;
      margin-top: 0.25em;
      font-size: 0.85em;
      opacity: 0.8;
    }

    .je-calendar-agenda-event-meta img {
      width: 14px;
      height: 14px;
      object-fit: contain;
    }

    @media (max-width: 1024px) {
      .je-calendar-page {
        padding: 1em;
      }

      .je-calendar-header {
        flex-direction: column;
        align-items: flex-start;
      }

      .je-calendar-title {
        font-size: 1.5em;
      }

      .je-calendar-actions {
        width: 100%;
        flex-direction: column;
      }

      .je-calendar-nav {
        width: 100%;
        justify-content: center;
      }

      .je-calendar-grid {
        gap: 0.5em;
      }

      .je-calendar-day {
        min-height: 120px;
        padding: 0.5em;
      }

      .je-calendar-legend {
        gap: 1em;
      }
    }

    @media (max-width: 768px) {
      .je-calendar-page {
        padding: 0.25em;
        max-width: 100vw;
        overflow-x: hidden;
      }

      .je-calendar-title {
        font-size: 1.1em;
      }

      .je-calendar-nav-btn,
      .je-calendar-view-btn {
        padding: 0.35em 0.6em;
        font-size: 0.85em;
      }

      .je-calendar-grid {
        grid-template-columns: repeat(7, 1fr);
        gap: 0.15em;
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
      }

      .je-calendar-day {
        min-height: 80px;
        min-width: 0;
        padding: 0.15em;
        font-size: 0.8em;
      }

      .je-calendar-day-header {
        font-size: 0.7em;
        padding-bottom: 0.2em;
        margin-bottom: 0.2em;
      }

      .je-calendar-day-number {
        font-size: 0.9em;
      }

      .je-calendar-day-name {
        display: none;
      }

      .je-calendar-events-list {
        gap: 0.2em;
      }

      .je-calendar-event {
        font-size: 0.65em;
        padding: 0.2em;
        padding-left: 0.4em;
        border-left-width: 2px;
      }

      .je-calendar-event-title {
        font-size: 0.85em;
        line-height: 1.2;
      }

      .je-calendar-event-subtitle {
        font-size: 0.75em;
        margin-top: 0.15em;
      }

      .je-calendar-event-type {
        font-size: 0.7em;
        margin-top: 0.25em;
      }

      .je-calendar-event-type img {
        width: 10px;
        height: 10px;
      }

      .je-calendar-agenda-row {
        flex-direction: column;
        gap: 0.5em;
      }

      .je-calendar-agenda-date {
        min-width: auto;
      }

      .je-calendar-agenda-event {
        gap: 0.5em;
      }

      .je-calendar-legend {
        gap: 0.5em;
        font-size: 0.8em;
        padding: 0.75em;
      }

      .je-calendar-legend-item {
        flex: 1 1 45%;
      }
    }
  `;

  const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

  /**
   * Get default view mode based on URL hash or mobile detection
   */
  function getDefaultViewMode() {
    // Check URL hash first (e.g., #/calendar/agenda)
    const hash = window.location.hash;
    const viewMatch = hash.match(/#\/calendar\/(month|week|agenda)/);
    if (viewMatch) {
      return viewMatch[1];
    }

    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    const configuredDefault = (JE.currentSettings.calendarDefaultViewMode || "auto").toLowerCase();
    if (configuredDefault === "month" || configuredDefault === "week" || configuredDefault === "agenda") {
      return configuredDefault;
    }

    // Auto: default to agenda on mobile, month on desktop
    const isMobile = window.innerWidth <= 768;
    return isMobile ? "agenda" : "month";
  }

  /**
   * Initialize calendar page
   */
  function initialize() {
    console.log(`${logPrefix} Initializing calendar page module`);

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled || (pluginPagesExists && config.CalendarUsePluginPages)) {
      if (pluginPagesExists && config.CalendarUsePluginPages) {
        console.log(`${logPrefix} Calendar page is injected via Plugin Pages`);
      } else {
        console.log(`${logPrefix} Calendar page is disabled`);
      }
      return;
    }

    injectStyles();
    loadSettings();

    // Inject navigation and set up one-time re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Setup event listeners
    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);
    document.addEventListener("viewshow", handleViewShow);
    document.addEventListener("click", handleNavClick);
    document.addEventListener("click", handleEventClick);
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    startLocationWatcher();

    // Check URL on init
    handleNavigation();

    console.log(`${logPrefix} Calendar page module initialized`);
  }

  /**
   * Intercept hash/popstate changes for our route before Jellyfin router
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash.startsWith("#/calendar") || path === "/calendar";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();

      // Check if view mode changed in URL
      const viewMatch = hash.match(/#\/calendar\/(month|week|agenda)/);
      if (viewMatch && viewMatch[1] !== state.viewMode) {
        state.viewMode = viewMatch[1];
        if (state.pageVisible) {
          loadAllData();
        }
      }

      showPage();
    }
  }

  // Poll location because Jellyfin's router uses pushState (no popstate/hashchange fired for pushState)
  function startLocationWatcher() {
    if (state.locationTimer) return;
    state.locationSignature = `${window.location.pathname}${window.location.hash}`;
    state.locationTimer = setInterval(() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    }, 150);
  }

  function stopLocationWatcher() {
    if (state.locationTimer) {
      clearInterval(state.locationTimer);
      state.locationTimer = null;
    }
  }

  // Load calendar settings from plugin config
  function loadSettings() {
    const config = JE.pluginConfig || {};
    state.settings = {
      firstDayOfWeek: config.CalendarFirstDayOfWeek || "Monday",
      timeFormat: config.CalendarTimeFormat || "5pm/5:30pm",
      highlightFavorites: config.CalendarHighlightFavorites || false,
      highlightWatchedSeries: config.CalendarHighlightWatchedSeries || false,
    };
  }

  // Inject CSS styles into page
  function injectStyles() {
    if (document.getElementById("je-calendar-styles")) return;
    const style = document.createElement("style");
    style.id = "je-calendar-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);

    // Inject dynamic theme colors
    injectThemeColors();
  }

  // Inject dynamic theme colors
  function injectThemeColors() {
    const existingThemeStyle = document.getElementById("je-calendar-theme-colors");
    if (existingThemeStyle) {
      existingThemeStyle.remove();
    }

    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    const themeStyle = document.createElement("style");
    themeStyle.id = "je-calendar-theme-colors";
    themeStyle.textContent = `
      .je-calendar-view-btn.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-calendar-legend-item.active {
        border-color: ${primaryAccent} !important;
      }
    `;
    document.head.appendChild(themeStyle);
  }

  /**
   * Get API authentication headers
   */
  function getAuthHeaders() {
    const token = ApiClient.accessToken ? ApiClient.accessToken() : "";
    return {
      "X-MediaBrowser-Token": token,
      "Content-Type": "application/json",
    };
  }

  /**
   * Fetch calendar events from backend
   */
  async function fetchCalendarEvents(startDate, endDate) {
    try {
      const response = await fetch(
        ApiClient.getUrl("/JellyfinEnhanced/arr/calendar", {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        }),
        { headers: getAuthHeaders() },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.events = (data.events || []).filter((evt) => evt && evt.releaseDate);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch calendar events:`, error);
      state.events = [];
      return null;
    }
  }

  /**
   * Fetch user data (favorite/watched status) for calendar events
   * Uses POST endpoint to only check specific calendar events, not entire library
   */
  async function fetchUserData() {
    if (!state.settings.highlightFavorites && !state.settings.highlightWatchedSeries) {
      state.userDataMap = new Map();
      return;
    }

    if (!state.events?.length) {
      state.userDataMap = new Map();
      return;
    }

    try {
      // Send only the events we need to check
      const eventsToCheck = state.events.map((evt) => ({
        id: evt.id,
        type: evt.type,
        title: evt.title,
        tvdbId: evt.tvdbId,
        imdbId: evt.imdbId,
        tmdbId: evt.tmdbId,
        seasonNumber: evt.seasonNumber,
        episodeNumber: evt.episodeNumber,
      }));

      const response = await fetch(
        ApiClient.getUrl("/JellyfinEnhanced/arr/calendar/user-data"),
        {
          method: "POST",
          headers: {
            ...getAuthHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ events: eventsToCheck }),
        }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      // Build Map for O(1) lookup by event ID
      state.userDataMap = new Map();
      (data.results || []).forEach((result) => {
        state.userDataMap.set(result.id, {
          isFavorite: result.isFavorite,
          isWatched: result.isWatched,
        });
      });
    } catch (error) {
      // Silently handle error - highlighting is optional
      state.userDataMap = new Map();
    }
  }

  /**
   * Get highlight CSS classes for an event
   */
  function getHighlightClasses(event) {
    let classes = "";
    const userData = state.userDataMap?.get(event.id);
    if (state.settings.highlightFavorites && userData?.isFavorite) {
      classes += " je-favorite";
    }
    if (state.settings.highlightWatchedSeries && userData?.isWatched) {
      classes += " je-watched";
    }
    return classes;
  }

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

    state.isLoading = false;
    renderPage();
  }

  /**
   * Filter events based on active filters
   */
  function filterEvents(events) {
    if (state.activeFilters.size === 0) return events;

    return events.filter((event) => {
      // Check release type filters
      const releaseTypeMatch =
        state.activeFilters.has('CinemaRelease') && event.releaseType === 'CinemaRelease' ||
        state.activeFilters.has('DigitalRelease') && event.releaseType === 'DigitalRelease' ||
        state.activeFilters.has('PhysicalRelease') && event.releaseType === 'PhysicalRelease' ||
        state.activeFilters.has('Episode') && event.releaseType === 'Episode';

      // Check user data filters
      const userData = state.userDataMap?.get(event.id);
      const watchlistMatch = state.activeFilters.has('Watchlist') && userData?.isFavorite;
      const watchedMatch = state.activeFilters.has('Watched') && userData?.isWatched;

      // Count how many filter types are active
      const hasReleaseTypeFilters = ['CinemaRelease', 'DigitalRelease', 'PhysicalRelease', 'Episode'].some(f => state.activeFilters.has(f));
      const hasUserDataFilters = state.activeFilters.has('Watchlist') || state.activeFilters.has('Watched');

      // If only release type filters are active, match those
      if (hasReleaseTypeFilters && !hasUserDataFilters) {
        return releaseTypeMatch;
      }

      // If only user data filters are active, match those
      if (!hasReleaseTypeFilters && hasUserDataFilters) {
        return watchlistMatch || watchedMatch;
      }

      // If both types of filters are active, must match at least one from each category
      if (hasReleaseTypeFilters && hasUserDataFilters) {
        return releaseTypeMatch && (watchlistMatch || watchedMatch);
      }

      return false;
    });
  }

  /**
   * Group events by date
   */
  function groupEventsByDate(events) {
    const grouped = {};

    events.forEach((event) => {
      if (!event.releaseDate) {
        return;
      }
      // Convert UTC timestamp to user's local date
      const date = new Date(event.releaseDate);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;

      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }

      grouped[dateKey].push(event);
    });

    return grouped;
  }

  // Get start and end dates for current view
  function getRangeForView(anchorDate, viewMode) {
    const start = new Date(Date.UTC(
      anchorDate.getUTCFullYear(),
      anchorDate.getUTCMonth(),
      anchorDate.getUTCDate(),
      0, 0, 0, 0
    ));

    if (viewMode === "month") {
      start.setUTCDate(1);
      const end = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth() + 1,
        0,
        23, 59, 59, 999
      ));
      return { start, end };
    }

    if (viewMode === "week") {
      const daysOfWeek = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const firstDayIndex = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
      const currentDayIndex = start.getUTCDay();
      const diff = (currentDayIndex - firstDayIndex + 7) % 7;
      start.setUTCDate(start.getUTCDate() - diff);

      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 6);
      end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    }

    const endAgenda = new Date(start);
    endAgenda.setUTCDate(start.getUTCDate() + 29);
    endAgenda.setUTCHours(23, 59, 59, 999);
    return { start, end: endAgenda };
  }

  /**
   * Get days in month
   */
  function getDaysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  /**
   * Get first day of month
   */
  function getFirstDayOfMonth(date) {
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    const dayOfWeek = firstDay.getDay();

    // Convert based on first day of week setting
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const firstDayOfWeek = daysOfWeek.indexOf(state.settings.firstDayOfWeek);

    return (dayOfWeek - firstDayOfWeek + 7) % 7;
  }

  /**
   * Get event color
   */
  function getEventColor(event) {
    const map = {
      CinemaRelease: STATUS_COLORS.CinemaRelease,
      DigitalRelease: STATUS_COLORS.DigitalRelease,
      PhysicalRelease: STATUS_COLORS.PhysicalRelease,
      Episode: STATUS_COLORS.Episode,
    };

    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';
    return map[event.releaseType] || primaryAccent;
  }

  // Get translated release type label
  function formatReleaseLabel(event) {
    const JE = window.JellyfinEnhanced;
    if (event.releaseType === "CinemaRelease") return JE.t("calendar_cinema_release");
    if (event.releaseType === "DigitalRelease") return JE.t("calendar_digital_release");
    if (event.releaseType === "PhysicalRelease") return JE.t("calendar_physical_release");
    if (event.releaseType === "Episode") return JE.t("calendar_episode");
    return "Release";
  }

  // Format event time for display
  function formatEventTime(releaseDate) {
    if (!releaseDate) return null;
    const date = new Date(releaseDate);
    if (Number.isNaN(date.getTime())) return null;

    if (date.getHours() === 0 && date.getMinutes() === 0) return null;

    const hour12 = state.settings.timeFormat === "5pm/5:30pm";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });
  }

  // Format date range label for header
  function formatRangeLabel() {
    if (!state.rangeStart || !state.rangeEnd) {
      return new Date(state.currentDate).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    if (state.viewMode === "month") {
      return new Date(state.currentDate).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    const startLabel = state.rangeStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = state.rangeEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" });

    if (state.viewMode === "week") {
      return `${startLabel} – ${endLabel}`;
    }

    return `${window.JellyfinEnhanced.t("calendar_agenda")} • ${startLabel} → ${endLabel}`;
  }

  // Switch between month/week/agenda views
  function setViewMode(mode) {
    if (state.viewMode === mode) return;
    state.viewMode = mode;

    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDefaultViewMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      JE.saveUserSettings('settings.json', JE.currentSettings);
    }

    const config = JE.pluginConfig || {};
    // Update URL hash to reflect view mode
    const newHash = `#/calendar/${mode}`;
    if (window.location.hash !== newHash && !(pluginPagesExists && config.CalendarUsePluginPages)) {
      history.replaceState({ page: "calendar", view: mode }, "Calendar", newHash);
    }

    loadAllData();
  }

  // Navigate forward or backward
  function shiftPeriod(direction) {
    const delta = direction === "next" ? 1 : -1;
    const current = new Date(state.currentDate);

    if (state.viewMode === "month") {
      current.setMonth(current.getMonth() + delta);
    } else if (state.viewMode === "week") {
      current.setDate(current.getDate() + delta * 7);
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
    if (state.activeFilters.has(filterType)) {
      state.activeFilters.delete(filterType);
    } else {
      state.activeFilters.add(filterType);
    }
    renderPage();
  }

  /**
   * Build tooltip text for calendar event
   */
  function buildEventTooltip(event) {
    let tooltip = event.title;

    // Add episode info for series (e.g., "S01E05 - Episode Title")
    if (event.type === "Series" && event.subtitle) {
      tooltip += ` ${event.subtitle}`;
    }

    // Add availability indicator
    if (event.hasFile) {
      tooltip += ` ✓`;
    }

    return tooltip;
  }

  /**
   * Render calendar event
   */
  function renderEvent(event) {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = event.source;
    const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : "je-calendar-radarr-icon";
    const subtitle = event.subtitle ? `<span class="je-calendar-event-subtitle">${escapeHtml(event.subtitle)}</span>` : "";
    const timeLabel = formatEventTime(event.releaseDate);
    const hasFileClass = event.hasFile ? " je-has-file" : "";
    const tooltip = buildEventTooltip(event);

    // Get user data indicators
    const userData = state.userDataMap?.get(event.id);
    const isWatchlist = state.settings.highlightFavorites && userData?.isFavorite;
    const isWatched = state.settings.highlightWatchedSeries && userData?.isWatched;

    // Build CSS classes for indicators (will show via ::before/::after pseudo-elements)
    const watchlistClass = isWatchlist ? " je-watchlist" : "";
    const watchedClass = isWatched ? " je-watched" : "";

    return `
      <div class="je-calendar-event${hasFileClass}${watchlistClass}${watchedClass}" style="border-left-color: ${color}; background: ${color}20" title="${escapeHtml(tooltip)}" data-event-id="${escapeHtml(event.id)}">
        <span class="je-calendar-event-title">${escapeHtml(event.title)}</span>
        ${subtitle}
        <div class="je-calendar-event-type">
          <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
          <span>${releaseTypeLabel} • <span class="je-arr-badge" title="${escapeHtml(sourceLabel)}">${sourceLabel}</span></span>
          ${timeLabel ? `<span class="je-calendar-event-time">${escapeHtml(timeLabel)}</span>` : ""}
        </div>
      </div>
    `;
  }

  // Render month grid view
  function renderMonthView() {
    const anchor = new Date(state.currentDate);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(1);

    const daysInMonth = getDaysInMonth(anchor);
    const firstDay = getFirstDayOfMonth(anchor);
    let filteredEvents = filterEvents(state.events);
    if (JE.hiddenContent) filteredEvents = JE.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);

    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const firstDayOfWeekIndex = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
    const orderedDaysOfWeek = [...daysOfWeek.slice(firstDayOfWeekIndex), ...daysOfWeek.slice(0, firstDayOfWeekIndex)];

    let html = '<div class="je-calendar-grid">';

    orderedDaysOfWeek.forEach((day) => {
      html += `<div class="je-calendar-day je-calendar-day-header" style="text-align: center; background: transparent; border: none; min-height: auto; padding: 0.5em;">${day.substring(0, 3)}</div>`;
    });

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="je-calendar-day" style="opacity: 0.3;"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const year = anchor.getFullYear();
      const month = String(anchor.getMonth() + 1).padStart(2, '0');
      const dayStr = String(day).padStart(2, '0');
      const dateStr = `${year}-${month}-${dayStr}`;

      const dayEvents = groupedEvents[dateStr] || [];
      dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

      html += `
        <div class="je-calendar-day">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${day}</span>
          </div>
          <div class="je-calendar-events-list">
            ${dayEvents.map((event) => renderEvent(event)).join("")}
          </div>
        </div>
      `;
    }

    html += "</div>";
    return html;
  }

  // Render week grid view
  function renderWeekView() {
    const { start } = getRangeForView(state.currentDate, "week");
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let filteredEvents = filterEvents(state.events);
    if (JE.hiddenContent) filteredEvents = JE.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);

    let html = '<div class="je-calendar-grid">';

    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const year = day.getFullYear();
      const month = String(day.getMonth() + 1).padStart(2, '0');
      const dayNum = String(day.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${dayNum}`;
      const dayEvents = groupedEvents[dateKey] || [];
      dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

      html += `
        <div class="je-calendar-day">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${day.getDate()}</span>
            <span class="je-calendar-day-name">${daysOfWeek[day.getDay()].substring(0, 3)}</span>
          </div>
          <div class="je-calendar-events-list">
            ${dayEvents.map((event) => renderEvent(event)).join("")}
          </div>
        </div>
      `;
    }

    html += "</div>";
    return html;
  }

  // Render agenda list view
  function renderAgendaView() {
    let filteredEvents = filterEvents(state.events);
    if (JE.hiddenContent) filteredEvents = JE.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    const dates = Object.keys(groupedEvents).sort();

    if (dates.length === 0) {
      return `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_no_releases")}</div>`;
    }

    let html = '<div class="je-calendar-agenda">';
    dates.forEach((dateKey) => {
      const [year, month, day] = dateKey.split('-');
      const dateObj = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      const weekday = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
      const monthDay = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

      const dayEvents = groupedEvents[dateKey] || [];
      dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

      html += `
        <div class="je-calendar-agenda-row">
          <div class="je-calendar-agenda-date">
            <div>${weekday}, ${monthDay}</div>
          </div>
          <div class="je-calendar-agenda-events">
            ${dayEvents.map((event) => renderAgendaEvent(event)).join("")}
          </div>
        </div>
      `;
    });

    html += "</div>";
    return html;
  }

  // Render single event in agenda view
  function renderAgendaEvent(event) {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = event.source;
    const iconClass = event.source === "Sonarr" ? "je-sonarr-icon" : "je-radarr-icon";
    const subtitle = event.subtitle || "";
    const timeLabel = formatEventTime(event.releaseDate);
    const hasFileClass = event.hasFile ? " je-has-file" : "";

    // Get user data indicators
    const userData = state.userDataMap?.get(event.id);
    const isWatchlist = state.settings.highlightFavorites && userData?.isFavorite;
    const isWatched = state.settings.highlightWatchedSeries && userData?.isWatched;

    // Build indicators array (only add if they exist)
    const indicators = [];
    if (event.hasFile) {
      indicators.push(`<span class="je-available-indicator material-symbols-rounded" title="${window.JellyfinEnhanced.t("jellyseerr_btn_available") || "Available"}">check_circle</span>`);
    }
    if (isWatchlist) {
      indicators.push(`<span class="je-watchlist-indicator-agenda material-symbols-rounded" title="Watchlist">bookmark</span>`);
    }
    if (isWatched) {
      indicators.push(`<span class="je-watched-indicator-agenda material-symbols-rounded" title="Watched">visibility</span>`);
    }

    // Get material icon based on release type
    let materialIcon = "movie";
    if (event.releaseType === "CinemaRelease") materialIcon = "local_movies";
    else if (event.releaseType === "DigitalRelease") materialIcon = "ondemand_video";
    else if (event.releaseType === "PhysicalRelease") materialIcon = "album";
    else if (event.releaseType === "Episode") materialIcon = "tv_guide";

    return `
      <div class="je-calendar-agenda-event${hasFileClass}" data-event-id="${escapeHtml(event.id)}">
        <div class="je-calendar-agenda-indicators">
          ${indicators.join('')}
        </div>
        <span class="material-symbols-rounded" style="font-size: 20px;">${materialIcon}</span>
        <div class="je-calendar-agenda-event-marker" style="background: ${color};"></div>
        <div class="je-calendar-agenda-event-content">
          <div class="je-calendar-agenda-event-title">${escapeHtml(event.title)}${subtitle ? ` • ${escapeHtml(subtitle)}` : ""}</div>
          <div class="je-calendar-agenda-event-meta">
            <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
            <span>${releaseTypeLabel}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${escapeHtml(sourceLabel)}">${sourceLabel}</span>
            ${timeLabel ? `<span>• ${escapeHtml(timeLabel)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  // Render calendar based on current view mode
  function renderCalendar() {
    if (state.viewMode === "week") return renderWeekView();
    if (state.viewMode === "agenda") return renderAgendaView();
    return renderMonthView();
  }

  // Render color legend
  function renderLegend() {
    const JE = window.JellyfinEnhanced;
    const hasActiveFilters = state.activeFilters.size > 0;
    const getItemClass = (filterType) => {
      if (!hasActiveFilters) return '';
      return state.activeFilters.has(filterType) ? 'active' : 'inactive';
    };

    const watchlistLegend = state.settings.highlightFavorites
      ? `<div class="je-calendar-legend-item ${getItemClass('Watchlist')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watchlist'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #ffd700; font-size: 18px;">bookmark</span>
          <span>${JE.t("calendar_watchlist")}</span>
        </div>`
      : "";

    const watchedLegend = state.settings.highlightWatchedSeries
      ? `<div class="je-calendar-legend-item ${getItemClass('Watched')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watched'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #64b5f6; font-size: 18px;">visibility</span>
          <span>${JE.t("calendar_watched")}</span>
        </div>`
      : "";

    return `
      <div class="je-calendar-legend">
        <div class="je-calendar-legend-item ${getItemClass('CinemaRelease')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('CinemaRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.CinemaRelease}; font-size: 18px;">local_movies</span>
          <span>${JE.t("calendar_cinema_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('DigitalRelease')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('DigitalRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.DigitalRelease}; font-size: 18px;">ondemand_video</span>
          <span>${JE.t("calendar_digital_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('PhysicalRelease')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('PhysicalRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.PhysicalRelease}; font-size: 18px;">album</span>
          <span>${JE.t("calendar_physical_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('Episode')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Episode'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.Episode}; font-size: 18px;">tv_guide</span>
          <span>${JE.t("calendar_episode")}</span>
        </div>
        ${watchlistLegend}
        ${watchedLegend}
      </div>
    `;
  }

  // Create or get page container element
  function createPageContainer() {
    let page = document.getElementById("je-calendar-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-calendar-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", "Calendar");
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/calendar");
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-calendar-page">
            <div id="je-calendar-container" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
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

  /**
   * Render the full page
   */
  function renderPage() {
    const page = createPageContainer();
    const container = document.getElementById("je-calendar-container");
    if (!page || !container) return;

    container.innerHTML = `
      <div class="je-calendar-header">
        <h1 class="je-calendar-title">${formatRangeLabel()}</h1>
        <div class="je-calendar-actions">
          <div class="je-calendar-nav">
            <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('prev'); event.stopPropagation();">‹</button>
            <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.goToday(); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_today")}</button>
            <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('next'); event.stopPropagation();">›</button>
          </div>
          <div class="je-calendar-nav">
            <button class="je-calendar-view-btn ${state.viewMode === 'month' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('month'); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_month")}</button>
            <button class="je-calendar-view-btn ${state.viewMode === 'week' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('week'); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_week")}</button>
            <button class="je-calendar-view-btn ${state.viewMode === 'agenda' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('agenda'); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_agenda")}</button>
          </div>
        </div>
      </div>

      ${state.isLoading ? `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_loading")}</div>` : ""}

      ${!state.isLoading ? renderCalendar() : ""}

      ${
        !state.isLoading && state.events.length === 0
          ? `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_no_releases")}</div>`
          : ""
      }

      ${renderLegend()}
    `;
  }

  /**
   * Show page
   */
  function showPage() {
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;

    state.pageVisible = true;

    injectStyles();
    const page = createPageContainer();

    const expectedHash = `#/calendar/${state.viewMode}`;
    if (window.location.hash !== expectedHash && !window.location.hash.startsWith("#/calendar/")) {
      history.pushState({ page: "calendar", view: state.viewMode }, "Calendar", expectedHash);
    }

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-calendar-page)");
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
    if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-calendar-page)")) {
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
    if (hash.startsWith("#/calendar") || path === "/calendar") {
      // Check if view mode changed in URL
      const viewMatch = hash.match(/#\/calendar\/(month|week|agenda)/);
      if (viewMatch && viewMatch[1] !== state.viewMode) {
        state.viewMode = viewMatch[1];
        if (state.pageVisible) {
          loadAllData();
        }
      }
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  /**
   * Handle viewshow events
   */
  function handleViewShow(e) {
    const targetPage = e.target;
    if (state.pageVisible && targetPage && targetPage.id !== "je-calendar-page") {
      hidePage();
    }
  }

  /**
   * Handle nav click
   */
  function handleNavClick(e) {
    if (!state.pageVisible) return;

    const btn = e.target.closest(".headerTabs button, .navMenuOption, .headerButton");
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

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    // Check if already exists
    if (document.querySelector(".je-nav-calendar-item")) {
      return;
    }

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-calendar-item";
      navItem.href = "#";
      navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">calendar_today</span>
        <span class="sectionName navMenuOptionText">${window.JellyfinEnhanced.t("calendar_title")}</span>
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

    // Use MutationObserver to watch for sidebar changes, but disconnect after re-injection
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.je-nav-calendar-item')) {
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

  // Escape HTML characters
  function escapeHtml(text) {
    if (text === null || text === undefined) {
      return "";
    }
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
  }


  /**
   * Helper to search Jellyfin items using fetch API
   */
  async function searchJellyfinItems(params) {
    const userId = ApiClient.getCurrentUserId();
    const token = ApiClient.accessToken();
    const queryString = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${ApiClient.serverAddress()}/Users/${userId}/Items?${queryString}`;

    const response = await fetch(url, {
      headers: {
        "X-MediaBrowser-Token": token,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Strip year suffix from title (e.g., "Invincible (2021)" -> "Invincible")
   * @param {string} title - Title that may contain year suffix
   * @returns {string} Title without year suffix
   */
  function stripYearFromTitle(title) {
    return title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  }

  /**
   * Search for an item, with fallback to title without year suffix
   * @param {string} itemType - Jellyfin item type ("Movie" or "Series")
   * @param {string} title - Title to search for
   * @param {Object} event - Calendar event with provider IDs for validation
   * @returns {Promise<Object|null>} Matched item or null
   */
  async function searchWithYearFallback(itemType, title, event) {
    // First try with full title
    let response = await searchJellyfinItems({
      Recursive: true,
      IncludeItemTypes: itemType,
      SearchTerm: title,
      Limit: 10,
      Fields: "ProviderIds",
    });

    let item = findMatchingItem(response?.Items, event);
    if (item) return item;

    // If not found and title has year suffix, try without it
    const titleWithoutYear = stripYearFromTitle(title);
    if (titleWithoutYear !== title) {
      response = await searchJellyfinItems({
        Recursive: true,
        IncludeItemTypes: itemType,
        SearchTerm: titleWithoutYear,
        Limit: 10,
        Fields: "ProviderIds",
      });
      item = findMatchingItem(response?.Items, event);
    }

    return item;
  }

  /**
   * Search for an item by provider IDs using the server endpoint.
   * @param {Object} event - Calendar event with provider IDs
   * @returns {Promise<string|null>} Item ID or null if not found
   */
  async function searchFromProviders(event) {
    const providers = {};
    const hasEpisodeProviders = !!(event.episodeImdbId || event.episodeTvdbId);
    if (hasEpisodeProviders) {
      if (event.episodeImdbId) providers.Imdb = event.episodeImdbId;
      if (event.episodeTvdbId) providers.Tvdb = String(event.episodeTvdbId);
    } else {
      if (event.imdbId) providers.Imdb = event.imdbId;
      if (event.tvdbId) providers.Tvdb = String(event.tvdbId);
      if (event.tmdbId) providers.Tmdb = String(event.tmdbId);
    }

    if (Object.keys(providers).length === 0) return null;

    try {
      const baseUrl = ApiClient.getUrl("/JellyfinEnhanced/items/by-providers");
      const params = new URLSearchParams();
      Object.entries(providers).forEach(([key, value]) => {
        params.append(`providers[${key}]`, value);
      });
      const url = `${baseUrl}?${params.toString()}`;

      const response = await fetch(url, { headers: getAuthHeaders() });
      if (!response.ok) return null;

      const itemId = await response.json();
      return itemId || null;
    } catch (error) {
      console.error(`${logPrefix} Provider search failed:`, error);
      return null;
    }
  }

  /**
   * Navigate to Jellyfin item by searching title and validating with provider IDs
   * Note: AnyProviderIdEquals parameter does NOT work in Jellyfin (only Emby)
   * See: https://github.com/jellyfin/jellyfin/issues/1990
   */
  async function navigateToJellyfinItem(event) {
    if (!event.hasFile) return;

    // No need to search if itemId is already provided
    if (event.itemId) {
      window.location.hash = `#/details?id=${event.itemId}`;
      return;
    }

    try {
      // Try provider-based lookup first
      const providerItemId = await searchFromProviders(event);
      if (providerItemId) {
        window.location.hash = `#/details?id=${providerItemId}`;
        return;
      }

      // For movies, search directly
      if (event.type !== "Series") {
        const item = await searchWithYearFallback("Movie", event.title, event);
        if (item) {
          window.location.hash = `#/details?id=${item.Id}`;
        }
        return;
      }

      // For series/episodes: first find the series
      const series = await searchWithYearFallback("Series", event.title, event);
      if (!series) return;

      // If no season/episode info, navigate to series
      if (!event.seasonNumber || !event.episodeNumber) {
        window.location.hash = `#/details?id=${series.Id}`;
        return;
      }

      // Find the specific episode within the series
      const episodeResponse = await searchJellyfinItems({
        ParentId: series.Id,
        IncludeItemTypes: "Episode",
        Recursive: true,
        Fields: "ParentIndexNumber,IndexNumber",
      });

      // Match by season and episode number
      const episode = episodeResponse?.Items?.find(
        (ep) =>
          ep.ParentIndexNumber === event.seasonNumber &&
          ep.IndexNumber === event.episodeNumber
      );

      if (episode) {
        window.location.hash = `#/details?id=${episode.Id}`;
      } else {
        // Fallback to series if episode not found
        window.location.hash = `#/details?id=${series.Id}`;
      }
    } catch (error) {
      console.error(`${logPrefix} Navigation failed:`, error);
    }
  }

  /**
   * Find matching item by provider IDs or exact title match
   * @param {Array} items - Jellyfin search results
   * @param {Object} event - Calendar event with provider IDs and title
   * @returns {Object|null} Matched item or null if no confident match
   */
  function findMatchingItem(items, event) {
    if (!items?.length) return null;

    // First try to match by provider IDs (most reliable)
    for (const item of items) {
      const ids = item.ProviderIds || {};
      if (
        (event.tvdbId && ids.Tvdb === String(event.tvdbId)) ||
        (event.imdbId && ids.Imdb === event.imdbId) ||
        (event.tmdbId && ids.Tmdb === String(event.tmdbId))
      ) {
        return item;
      }
    }

    // Fallback to exact title match only (don't guess with items[0])
    return items.find(
      (item) => item.Name?.toLowerCase() === event.title.toLowerCase()
    ) || null;
  }

  /**
   * Handle click on calendar event
   */
  function handleEventClick(e) {
    const eventEl = e.target.closest(".je-calendar-event, .je-calendar-agenda-event");
    if (!eventEl) return;

    const eventId = eventEl.dataset.eventId;
    if (!eventId) return;

    const event = state.events.find((ev) => ev.id === eventId);
    if (!event || !event.hasFile) return;

    e.preventDefault();
    e.stopPropagation();
    navigateToJellyfinItem(event);
  }

  // Export to JE namespace
  JE.calendarPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    setViewMode,
    shiftPeriod,
    goToday,
    toggleFilter,
    renderPage,
    injectStyles,
    loadSettings,
    handleEventClick
  };

  JE.initializeCalendarPage = initialize;
})();
