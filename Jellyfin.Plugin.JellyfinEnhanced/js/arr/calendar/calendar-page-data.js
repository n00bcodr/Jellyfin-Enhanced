// /js/arr/calendar/calendar-page-data.js
// Calendar Page — state, settings and data access (split from calendar-page.js).
// The former raw fetch() calls with hand-built auth headers are routed through
// JE.core.api.plugin (same /JellyfinEnhanced/arr endpoints, core auth headers).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.calendarPage = JE.internals.calendarPage || {});

  // calendar-page-render-views.js loads after this module — resolve renderPage at
  // call time. Forwards arguments: renderPage(targetContainer) is used by
  // custom-tab mode to render into a container other than the standalone page.
  const renderPage = (...args) => P.renderPage(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';
  const STORAGE_KEYS = {
    showUnmonitored: "je.calendar.showUnmonitored",
  };

  /**
   * Per-user storage key for the show-unmonitored toggle. The unscoped legacy
   * key leaked the preference across SPA user switches; its value is adopted
   * into the current user's scoped key once (preserving the pre-upgrade
   * choice), then removed so it can't shadow the scoped value.
   * @returns {string}
   */
  function showUnmonitoredKey() {
    const scoped = JE.session
      ? JE.session.userScopedKey(STORAGE_KEYS.showUnmonitored)
      : `${STORAGE_KEYS.showUnmonitored}:anonymous`;
    try {
      const legacy = window.localStorage?.getItem(STORAGE_KEYS.showUnmonitored);
      if (legacy !== null && legacy !== undefined) {
        if (window.localStorage?.getItem(scoped) === null) {
          window.localStorage?.setItem(scoped, legacy);
        }
        window.localStorage?.removeItem(STORAGE_KEYS.showUnmonitored);
      }
    } catch (_) { /* best effort */ }
    return scoped;
  }

  function getStoredShowUnmonitored() {
    try {
      const stored = window.localStorage?.getItem(showUnmonitoredKey());
      if (stored === null) return null;
      return stored === "true";
    } catch (error) {
      return null;
    }
  }

  function setStoredShowUnmonitored(value) {
    try {
      window.localStorage?.setItem(showUnmonitoredKey(), String(!!value));
    } catch (error) {
    }
  }

  /**
   * Get default view mode from settings, defaults to agenda
   */
  function getDefaultViewMode() {
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    const configuredDefault = (JE.currentSettings.calendarDefaultViewMode || "agenda").toLowerCase();
    if (configuredDefault === "month" || configuredDefault === "week" || configuredDefault === "agenda" || configuredDefault === "day"){
      return configuredDefault;
    }

    // Default to agenda if no valid setting
    return "agenda";
  }

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
    sidebarCollapsed: null,
    settings: {
      firstDayOfWeek: "Monday",
      timeFormat: "5pm/5:30pm",
      highlightFavorites: false,
      highlightWatchedSeries: false,
      showUnmonitored: false,
      showOnlyRequested: false,
      forceOnlyRequested: false,
    },
    userDataMap: new Map(),
    activeFilters: new Set(), // Track active filters
    filterMatchMode: "any",
    filterInvert: false,
    requestedItems: new Set(),
    requestedLoaded: false,
    requestedLoading: false,
    locationSignature: null,
    locationUnsubscribe: null,
    _customTabContainer: null,
  };

  // Watched state, favorites and requested-item highlighting are per-user —
  // clear them on a user switch so the calendar re-derives everything for
  // the new user on its next render.
  JE.session?.onUserChange('calendar-page', () => {
    state.userDataMap.clear();
    state.requestedItems.clear();
    state.requestedLoaded = false;
    state.requestedLoading = false;
  });

  // Status color mapping
  const STATUS_COLORS = {
    CinemaRelease: "#2196f3",
    DigitalRelease: "#9c27b0",
    PhysicalRelease: "#ff5722",
    Episode: "#4caf50",
    Anime: "#e91e63",
  };

  // Load calendar settings from plugin config
  function loadSettings() {
    const config = JE.pluginConfig || {};
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    const storedShowUnmonitored = getStoredShowUnmonitored();
    const forceOnlyRequested = config.CalendarForceOnlyRequested || false;
    state.settings = {
      firstDayOfWeek: config.CalendarFirstDayOfWeek || "Monday",
      timeFormat: config.CalendarTimeFormat || "5pm/5:30pm",
      highlightFavorites: config.CalendarHighlightFavorites || false,
      highlightWatchedSeries: config.CalendarHighlightWatchedSeries || false,
      showUnmonitored: storedShowUnmonitored ?? false,
      displayMode: JE.currentSettings.calendarDisplayMode || "list",
      filterByLibraryAccess: config.CalendarFilterByLibraryAccess !== false,
      showOnlyRequested: config.CalendarShowOnlyRequested || false,
      forceOnlyRequested,
    };

    // If show only requested is enabled, set Requests as active by default
    if (!state.settings.forceOnlyRequested && state.settings.showOnlyRequested && state.activeFilters.size === 0) {
      state.activeFilters.add("Requests");
    }

    // Force-only mode handles request filtering globally, so the Requests chip/filter
    // should not remain active in the interactive filter set.
    if (state.settings.forceOnlyRequested) {
      state.activeFilters.delete("Requests");
    }
  }

  /**
   * Fetch calendar events from backend
   */
  async function fetchCalendarEvents(startDate, endDate) {
    try {
      const query = new URLSearchParams({
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });
      const data = await JE.core.api.plugin(`/arr/calendar?${query.toString()}`);
      state.events = (data.events || []).filter((evt) => evt && evt.releaseDate);
      // Surface per-instance errors from the backend envelope so a misconfigured or
      // unreachable arr instance doesn't silently leave the calendar looking fine.
      surfaceCalendarErrors(data.errors);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch calendar events:`, error);
      state.events = [];
      return null;
    }
  }

  // Once-per-session dedup so a permanently-misconfigured instance doesn't toast on every
  // calendar refresh. Self-heals: when an error stops appearing the memo entry is dropped
  // so a future reoccurrence re-toasts.
  const _toastedCalendarErrors = new Set();
  // Alias the shared HTML-escape helper to keep toast concatenations short. JE.toast uses
  // innerHTML so admin-set instance names + upstream error reasons must be escaped.
  // The inline fallback is a real escaper so XSS is blocked even if helpers.js
  // hasn't loaded yet (e.g. a load-order race on first init).
  const esc = (s) => {
    if (window.JellyfinEnhanced?.helpers?.escHtml) return window.JellyfinEnhanced.helpers.escHtml(s);
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  function surfaceCalendarErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      // All previously-failing instances have recovered — drop the memo so future errors re-toast.
      _toastedCalendarErrors.clear();
      return;
    }
    const seenThisTick = new Set();
    errors.forEach(function(err) {
      const key = (err.source || "") + "|" + (err.instanceName || "") + "|" + (err.reason || "");
      seenThisTick.add(key);
      if (_toastedCalendarErrors.has(key)) return;
      _toastedCalendarErrors.add(key);
      if (typeof window.JellyfinEnhanced?.toast === "function") {
        window.JellyfinEnhanced.toast(
          "⚠ " + esc(err.source || "Arr") + " calendar instance \"" +
          esc(err.instanceName || "unknown") + "\" failed: " + esc(err.reason)
        );
      }
      console.warn(`${logPrefix} ${err.source || "Arr"} instance "${err.instanceName}" error: ${err.reason}`);
    });
    // Drop memo entries for errors that didn't reappear — lets future occurrences re-toast.
    Array.from(_toastedCalendarErrors).forEach(function(k) {
      if (!seenThisTick.has(k)) _toastedCalendarErrors.delete(k);
    });
  }

  /**
   * Fetch user data (favorite/watched status) for calendar events
   * Uses POST endpoint to only check specific calendar events, not entire library
   */
  async function fetchUserData() {
    // Favorites/watched state is per-user — drop a response that resolves
    // after a user switch instead of refilling the freshly reset map.
    const epoch = JE.session ? JE.session.getEpoch() : 0;
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
        itemId: evt.itemId,
        itemEpisodeId: evt.itemEpisodeId,
        tvdbId: evt.tvdbId,
        imdbId: evt.imdbId,
        tmdbId: evt.tmdbId,
        seasonNumber: evt.seasonNumber,
        episodeNumber: evt.episodeNumber,
      }));

      const data = await JE.core.api.plugin("/arr/calendar/user-data", {
        method: "POST",
        body: { events: eventsToCheck },
      });
      if (JE.session && !JE.session.isCurrent(epoch)) return;

      // Build Map for O(1) lookup by event ID
      state.userDataMap = new Map();
      (data.results || []).forEach((result) => {
        state.userDataMap.set(result.id, {
          isFavorite: result.isFavorite,
          isWatched: result.isWatched,
        });
      });
    } catch (error) {
      // Silently handle error - highlighting is optional. Stale failures
      // (from before a user switch) must not clear the new user's map.
      if (!JE.session || JE.session.isCurrent(epoch)) state.userDataMap = new Map();
    }
  }

  async function fetchUserRequests() {
    if (!JE.pluginConfig?.JellyseerrEnabled) {
      state.requestedItems = new Set();
      state.requestedLoaded = true;
      state.requestedLoading = false;
      return;
    }

    state.requestedLoading = true;
    // Same per-user guard: the finally below must not install the previous
    // user's requested-set (or mark it loaded) after a switch.
    const epoch = JE.session ? JE.session.getEpoch() : 0;
    const requested = new Set();
    const pageSize = 200;
    let page = 1;
    let totalPages = 1;

    try {
      while (page <= totalPages) {
        const skip = (page - 1) * pageSize;
        const query = new URLSearchParams({
          take: String(pageSize),
          skip: String(skip),
          userOnly: "true",
        });

        const data = await JE.core.api.plugin(`/arr/requests?${query.toString()}`);
        totalPages = data.totalPages || 1;
        (data.requests || []).forEach((req) => {
          const tmdbId = req?.tmdbId;
          const type = (req?.type || "").toLowerCase();
          if (!tmdbId || !type) return;
          requested.add(`${type}:${tmdbId}`);
        });

        page += 1;
      }
    } catch (error) {
      console.warn(`${logPrefix} Failed to fetch user requests:`, error);
    } finally {
      if (!JE.session || JE.session.isCurrent(epoch)) {
        state.requestedItems = requested;
        state.requestedLoaded = true;
        state.requestedLoading = false;
        if (state.pageVisible) {
          renderPage();
        }
      }
      // Stale run: leave the state alone entirely — the reset already
      // cleared the latch, and the current user's own fetch owns it now.
    }
  }

  async function ensureRequestData() {
    if (state.requestedLoading || state.requestedLoaded) return;
    await fetchUserRequests();
  }

  /**
   * Filter events based on active filters
   */
  function filterEvents(events) {
    // First, filter by monitored status if showUnmonitored is false
    let filteredEvents = events;
    if (!state.settings.showUnmonitored) {
      filteredEvents = events.filter((event) => {
        // Filter out unmonitored items from both Sonarr and Radarr
        return event.monitored !== false;
      });
    }

    // Defense-in-depth: hide events the user cannot access.
    // If user-data was fetched, events with an itemId but no user-data
    // entry are from inaccessible libraries. (Primary filtering is server-side.)
    if (state.settings.filterByLibraryAccess && state.userDataMap && state.userDataMap.size > 0) {
      const checkedEventIds = new Set(state.userDataMap.keys());
      filteredEvents = filteredEvents.filter(
        (event) => !event.itemId || checkedEventIds.has(event.id),
      );
    }

    const getRequestKey = (event) => {
      const tmdbId = event?.tmdbId;
      if (!tmdbId) return null;
      const type = event.type === "Series" ? "tv" : "movie";
      return `${type}:${tmdbId}`;
    };

    const isRequestedEvent = (event) => {
      const key = getRequestKey(event);
      return key ? state.requestedItems.has(key) : false;
    };

    // Hard-enforced mode: always scope to requested items regardless of interactive filters.
    if (state.settings.forceOnlyRequested) {
      filteredEvents = filteredEvents.filter((event) => isRequestedEvent(event));
    }

    // Then apply user-selected filters
    if (state.activeFilters.size == 0) return filteredEvents;

    const filters = Array.from(state.activeFilters);

      return filteredEvents.filter((event) => {
        const userData = state.userDataMap?.get(event.id);
        const matchesFilter = (filterType) => {
          if (filterType === 'Watchlist') return !!userData?.isFavorite;
          if (filterType === 'Watched') return !!userData?.isWatched;
          if (filterType === 'Available') return !!event.hasFile;
          if (filterType === 'Requests') return isRequestedEvent(event);
          return event.releaseType === filterType;
        };

      const matched = state.filterMatchMode === 'all'
        ? filters.every(matchesFilter)
        : filters.some(matchesFilter);

      return state.filterInvert ? !matched : matched;
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

  /**
   * Search for an item by provider IDs using the server endpoint.
   * @param {Object} event - Calendar event with provider IDs
   * @returns {Promise<string|null>} Item ID or null if not found
   */
  async function searchFromProviders(event, options = {}) {
    const preferSeries = !!options.preferSeries;
    const episodeProviders = {};
    const seriesProviders = {};
    if (event.episodeImdbId) episodeProviders.Imdb = event.episodeImdbId;
    if (event.episodeTvdbId) episodeProviders.Tvdb = String(event.episodeTvdbId);
    if (event.shokoEpisodeId) episodeProviders["Shoko Episode"] = String(event.shokoEpisodeId);
    if (event.imdbId) seriesProviders.Imdb = event.imdbId;
    if (event.tvdbId) seriesProviders.Tvdb = String(event.tvdbId);
    if (event.tmdbId) seriesProviders.Tmdb = String(event.tmdbId);
    if (event.shokoSeriesId) seriesProviders["Shoko Series"] = String(event.shokoSeriesId);

    const hasEpisodeProviders = Object.keys(episodeProviders).length > 0;
    const hasSeriesProviders = Object.keys(seriesProviders).length > 0;
    if (!hasEpisodeProviders && !hasSeriesProviders) return null;

    try {
      const lookup = async (providers) => {
        const params = new URLSearchParams();
        Object.entries(providers).forEach(([key, value]) => {
          params.append(`providers[${key}]`, value);
        });

        try {
          const itemId = await JE.core.api.plugin(`/items/by-providers?${params.toString()}`);
          return itemId || null;
        } catch (error) {
          // An HTTP error (e.g. 404) means "not found" — fall through to the
          // next provider lookup, matching the pre-core `!response.ok` path.
          if (error?.status) return null;
          throw error;
        }
      };

      if (hasEpisodeProviders && !preferSeries) {
        const episodeItemId = await lookup(episodeProviders);
        if (episodeItemId) return episodeItemId;
      }

      if (hasSeriesProviders) {
        return await lookup(seriesProviders);
      }

      return null;
    } catch (error) {
      console.error(`${logPrefix} Provider search failed:`, error);
      return null;
    }
  }

  P.state = state;
  P.STATUS_COLORS = STATUS_COLORS;
  P.setStoredShowUnmonitored = setStoredShowUnmonitored;
  P.loadSettings = loadSettings;
  P.fetchCalendarEvents = fetchCalendarEvents;
  P.fetchUserData = fetchUserData;
  P.ensureRequestData = ensureRequestData;
  P.filterEvents = filterEvents;
  P.groupEventsByDate = groupEventsByDate;
  P.searchFromProviders = searchFromProviders;
})();
