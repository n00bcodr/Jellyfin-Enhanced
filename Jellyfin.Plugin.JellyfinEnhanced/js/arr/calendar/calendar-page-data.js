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
  function invalidate(ctx) {
    const owner = lifetime(ctx);
    owner.view++;
    const state = ctx.own.calendarPage?.state;
    if (state) {
      state.isLoading = false;
      state.requestedLoading = false;
    }
  }
  function preferenceKey(JE, storage, base) {
    const legacyUser = JE.session?.userScopedKey(base) ?? `${base}:anonymous`;
    const server = JE.session?.getServerId?.();
    const scoped = server ? `${legacyUser}:server:${encodeURIComponent(server)}` : legacyUser;
    for (const old of [.../* @__PURE__ */ new Set([legacyUser, base])]) {
      if (old === scoped) continue;
      try {
        const value = storage.getItem(old);
        if (value === null) continue;
        if (storage.getItem(scoped) === null) storage.setItem(scoped, value);
        storage.removeItem(old);
      } catch {
      }
    }
    return scoped;
  }

  // client/src/features/calendar/domain.ts
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function text(row, key) {
    const value = row[key];
    if (value == null) return void 0;
    if (typeof value !== "string") throw new TypeError(`Invalid calendar ${key}`);
    return value;
  }
  function number(row, key) {
    const value = row[key];
    if (value == null) return void 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid calendar ${key}`);
    return value;
  }
  function boolean(row, key) {
    const value = row[key];
    if (value == null) return void 0;
    if (typeof value !== "boolean") throw new TypeError(`Invalid calendar ${key}`);
    return value;
  }
  function releaseDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y = 0, m = 0, d = 0] = value.split("-").map(Number);
      const result = new Date(y, m - 1, d);
      if (result.getFullYear() !== y || result.getMonth() !== m - 1 || result.getDate() !== d) return /* @__PURE__ */ new Date(NaN);
      return result;
    }
    return new Date(value);
  }
  function calendarResponse(value) {
    if (!record(value) || !Array.isArray(value.events) && !Array.isArray(value.errors)) throw new TypeError("Invalid calendar response");
    if (value.events !== void 0 && !Array.isArray(value.events)) throw new TypeError("Invalid calendar events");
    if (value.errors !== void 0 && !Array.isArray(value.errors)) throw new TypeError("Invalid calendar errors");
    const events = [];
    for (const row of Array.isArray(value.events) ? value.events : []) {
      if (row === null || record(row) && row.releaseDate == null) continue;
      if (!record(row)) throw new TypeError("Invalid calendar event");
      const date = text(row, "releaseDate"), id = text(row, "id");
      if (!date || !id || !Number.isFinite(releaseDate(date).getTime())) throw new TypeError("Invalid calendar event identity/date");
      const also = row.alsoInInstances;
      if (also != null && (!Array.isArray(also) || !also.every((v) => typeof v === "string"))) throw new TypeError("Invalid calendar instances");
      events.push({
        id,
        releaseDate: date,
        title: text(row, "title") ?? "",
        type: text(row, "type") ?? "",
        releaseType: text(row, "releaseType") ?? "",
        source: text(row, "source") ?? "",
        subtitle: text(row, "subtitle"),
        instanceName: text(row, "instanceName"),
        alsoInInstances: Array.isArray(also) ? also.filter((v) => typeof v === "string") : void 0,
        itemId: text(row, "itemId"),
        itemEpisodeId: text(row, "itemEpisodeId"),
        imdbId: text(row, "imdbId"),
        episodeImdbId: text(row, "episodeImdbId"),
        tvdbId: number(row, "tvdbId"),
        tmdbId: number(row, "tmdbId"),
        episodeTvdbId: number(row, "episodeTvdbId"),
        shokoSeriesId: number(row, "shokoSeriesId"),
        shokoEpisodeId: number(row, "shokoEpisodeId"),
        seasonNumber: number(row, "seasonNumber"),
        episodeNumber: number(row, "episodeNumber"),
        monitored: boolean(row, "monitored"),
        hasFile: boolean(row, "hasFile"),
        posterUrl: text(row, "posterUrl"),
        backdropUrl: text(row, "backdropUrl"),
        finaleType: text(row, "finaleType")
      });
    }
    const errors = (Array.isArray(value.errors) ? value.errors : []).map((row) => {
      if (!record(row)) throw new TypeError("Invalid calendar instance error");
      return { source: text(row, "source"), instanceName: text(row, "instanceName"), reason: text(row, "reason") };
    });
    return { events, errors };
  }
  function userDataResponse(value) {
    if (!record(value) || !Array.isArray(value.results)) throw new TypeError("Invalid calendar user data");
    return value.results.map((row) => {
      if (!record(row) || typeof row.id !== "string") throw new TypeError("Invalid calendar user data item");
      return { id: row.id, isFavorite: boolean(row, "isFavorite") ?? false, isWatched: boolean(row, "isWatched") ?? false };
    });
  }
  function requestsResponse(value) {
    if (!record(value) || !Array.isArray(value.requests)) throw new TypeError("Invalid calendar requests");
    const totalPages = number(value, "totalPages") ?? 1;
    if (totalPages > 1e4) throw new TypeError("Invalid calendar request pagination");
    const requests = value.requests.map((row) => {
      if (!record(row)) throw new TypeError("Invalid calendar request");
      return { type: text(row, "type") ?? "", tmdbId: number(row, "tmdbId") };
    });
    return { requests, totalPages };
  }
  function savedFilters(value) {
    if (!record(value)) return null;
    return { filters: Array.isArray(value.filters) ? value.filters.filter((v) => typeof v === "string") : [], mode: value.mode === "all" ? "all" : "any", invert: value.invert === true };
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

  // client/src/features/calendar/calendar-page-data.ts
  (function() {
    "use strict";
    const { JE, ctx, P } = export0();
    if (P.state) return;
    const renderPage = (target) => P.renderPage(target);
    const logPrefix = "🪼 Jellyfin Enhanced: Calendar Page:";
    const STORAGE_KEYS = {
      showUnmonitored: "je.calendar.showUnmonitored",
      filters: "je.calendar.filters",
      collapse: "je.calendar.collapseEpisodes"
    };
    function showUnmonitoredKey() {
      return preferenceKey(JE, window.localStorage, STORAGE_KEYS.showUnmonitored);
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
    function collapseKey() {
      return preferenceKey(JE, window.localStorage, STORAGE_KEYS.collapse);
    }
    function getStoredCollapse() {
      try {
        return window.localStorage?.getItem(collapseKey()) !== "false";
      } catch (error) {
        return true;
      }
    }
    function setStoredCollapse(value) {
      try {
        window.localStorage?.setItem(collapseKey(), String(!!value));
      } catch (error) {
      }
    }
    function filtersKey() {
      return preferenceKey(JE, window.localStorage, STORAGE_KEYS.filters);
    }
    function saveFilters() {
      try {
        window.localStorage?.setItem(filtersKey(), JSON.stringify({
          filters: Array.from(state.activeFilters),
          mode: state.filterMatchMode,
          invert: state.filterInvert
        }));
      } catch (error) {
      }
    }
    function restoreFilters() {
      try {
        const saved = savedFilters(JSON.parse(window.localStorage?.getItem(filtersKey()) || "null"));
        if (!saved) return;
        state.activeFilters = new Set(Array.isArray(saved.filters) ? saved.filters : []);
        state.filterMatchMode = saved.mode === "all" ? "all" : "any";
        state.filterInvert = !!saved.invert;
      } catch (error) {
      }
    }
    function getDefaultViewMode() {
      JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
      const configuredDefault = (JE.currentSettings.calendarDefaultViewMode || "agenda").toLowerCase();
      if (configuredDefault === "month" || configuredDefault === "week" || configuredDefault === "agenda" || configuredDefault === "day") {
        return configuredDefault;
      }
      return "agenda";
    }
    const state = {
      events: [],
      isLoading: false,
      pageVisible: false,
      previousPage: null,
      currentDate: /* @__PURE__ */ new Date(),
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
        forceOnlyRequested: false
      },
      userDataMap: /* @__PURE__ */ new Map(),
      activeFilters: /* @__PURE__ */ new Set(),
      // Track active filters
      expandedGroups: /* @__PURE__ */ new Set(),
      // Collapsed-episode groups the user expanded
      filterMatchMode: "any",
      filterInvert: false,
      requestedItems: /* @__PURE__ */ new Set(),
      requestedLoaded: false,
      requestedLoading: false,
      locationSignature: null,
      locationUnsubscribe: null,
      _customTabContainer: null
    };
    JE.session?.onUserChange("calendar-page", () => {
      invalidate(ctx);
      state.activeFilters.clear();
      state.expandedGroups.clear();
      state.filtersRestored = false;
      state.filterMatchMode = "any";
      state.filterInvert = false;
      state.error = null;
      state.requestError = null;
      state._customTabContainer?.replaceChildren();
      document.getElementById("je-calendar-container")?.replaceChildren();
      _toastedCalendarErrors.clear();
      state.events = [];
      state.userDataMap.clear();
      state.requestedItems.clear();
      state.requestedLoaded = false;
      state.requestedLoading = false;
    });
    const STATUS_COLORS = {
      CinemaRelease: "#2196f3",
      DigitalRelease: "#9c27b0",
      PhysicalRelease: "#ff5722",
      Episode: "#4caf50",
      Anime: "#e91e63"
    };
    function loadSettings() {
      state.viewMode = getDefaultViewMode();
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
        collapseEpisodes: getStoredCollapse(),
        displayMode: JE.currentSettings.calendarDisplayMode || "list",
        filterByLibraryAccess: config.CalendarFilterByLibraryAccess !== false,
        showOnlyRequested: config.CalendarShowOnlyRequested || false,
        forceOnlyRequested
      };
      if (!state.filtersRestored) {
        state.filtersRestored = true;
        restoreFilters();
      }
      if (!state.settings.forceOnlyRequested && state.settings.showOnlyRequested && state.activeFilters.size === 0) {
        state.activeFilters.add("Requests");
      }
      if (state.settings.forceOnlyRequested) {
        state.activeFilters.delete("Requests");
      }
    }
    async function fetchCalendarEvents(startDate, endDate) {
      const current = lease(ctx, "events");
      try {
        const query = new URLSearchParams({
          start: startDate.toISOString(),
          end: endDate.toISOString()
        });
        const data = calendarResponse(await JE.core.api.plugin(`/arr/calendar?${query.toString()}`));
        if (!current()) return null;
        state.events = data.events;
        state.error = data.errors.length ? "Some calendar sources failed. Check instance errors." : null;
        surfaceCalendarErrors(data.errors);
        return data;
      } catch (error) {
        (error instanceof TypeError ? console.warn : console.error)(`${logPrefix} Failed to fetch calendar events:`, error);
        if (current()) {
          state.events = [];
          state.error = "Calendar could not be loaded. Please retry.";
        }
        return null;
      }
    }
    const _toastedCalendarErrors = /* @__PURE__ */ new Set();
    const esc = (s) => {
      if (JE?.helpers?.escHtml) return JE.helpers.escHtml(s);
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    function surfaceCalendarErrors(errors) {
      if (!Array.isArray(errors) || errors.length === 0) {
        _toastedCalendarErrors.clear();
        return;
      }
      const seenThisTick = /* @__PURE__ */ new Set();
      errors.forEach(function(err) {
        const key = (err.source || "") + "|" + (err.instanceName || "") + "|" + (err.reason || "");
        seenThisTick.add(key);
        if (_toastedCalendarErrors.has(key)) return;
        _toastedCalendarErrors.add(key);
        if (typeof JE?.toast === "function") {
          JE.toast(
            "⚠ " + esc(err.source || "Arr") + ' calendar instance "' + esc(err.instanceName || "unknown") + '" failed: ' + esc(err.reason)
          );
        }
        console.warn(`${logPrefix} ${err.source || "Arr"} instance "${err.instanceName}" error: ${err.reason}`);
      });
      Array.from(_toastedCalendarErrors).forEach(function(k) {
        if (!seenThisTick.has(k)) _toastedCalendarErrors.delete(k);
      });
    }
    async function fetchUserData() {
      const current = lease(ctx, "userData");
      if (!state.settings.highlightFavorites && !state.settings.highlightWatchedSeries) {
        state.userDataMap = /* @__PURE__ */ new Map();
        return;
      }
      if (!state.events?.length) {
        state.userDataMap = /* @__PURE__ */ new Map();
        return;
      }
      try {
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
          episodeNumber: evt.episodeNumber
        }));
        const data = userDataResponse(await JE.core.api.plugin("/arr/calendar/user-data", {
          method: "POST",
          body: { events: eventsToCheck }
        }));
        if (!current()) return;
        state.userDataMap = /* @__PURE__ */ new Map();
        data.forEach((result) => {
          state.userDataMap.set(result.id, {
            isFavorite: result.isFavorite,
            isWatched: result.isWatched
          });
        });
      } catch (error) {
        if (current()) state.userDataMap = /* @__PURE__ */ new Map();
      }
    }
    async function fetchUserRequests() {
      if (!JE.pluginConfig?.JellyseerrEnabled) {
        state.requestedItems = /* @__PURE__ */ new Set();
        state.requestedLoaded = true;
        state.requestedLoading = false;
        return;
      }
      state.requestedLoading = true;
      const current = lease(ctx, "requests");
      let succeeded = false;
      const requested = /* @__PURE__ */ new Set();
      const pageSize = 200;
      let page = 1;
      let totalPages = 1;
      try {
        while (page <= totalPages) {
          const skip = (page - 1) * pageSize;
          const query = new URLSearchParams({
            take: String(pageSize),
            skip: String(skip),
            userOnly: "true"
          });
          const data = requestsResponse(await JE.core.api.plugin(`/arr/requests?${query.toString()}`));
          if (!current()) return;
          totalPages = data.totalPages || 1;
          (data.requests || []).forEach((req) => {
            const tmdbId = req?.tmdbId;
            const type = (req?.type || "").toLowerCase();
            if (!tmdbId || !type) return;
            requested.add(`${type}:${tmdbId}`);
          });
          page += 1;
        }
        succeeded = true;
      } catch (error) {
        console.warn(`${logPrefix} Failed to fetch user requests:`, error);
      } finally {
        if (current()) {
          state.requestedItems = succeeded ? requested : /* @__PURE__ */ new Set();
          state.requestedLoaded = succeeded;
          state.requestError = succeeded ? null : "Requests could not be loaded. Please retry.";
          state.requestedLoading = false;
          if (state.pageVisible || state._customTabContainer) {
            renderPage();
          }
        }
      }
    }
    async function ensureRequestData() {
      if (state.requestedLoading || state.requestedLoaded) return;
      await fetchUserRequests();
    }
    function filterEvents(events) {
      let filteredEvents = events;
      if (!state.settings.showUnmonitored) {
        filteredEvents = events.filter((event) => {
          return event.monitored !== false;
        });
      }
      if (state.settings.filterByLibraryAccess && state.userDataMap && state.userDataMap.size > 0) {
        const checkedEventIds = new Set(state.userDataMap.keys());
        filteredEvents = filteredEvents.filter(
          (event) => !event.itemId || checkedEventIds.has(event.id)
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
      if (state.settings.forceOnlyRequested) {
        filteredEvents = filteredEvents.filter((event) => isRequestedEvent(event));
      }
      if (state.activeFilters.size == 0) return filteredEvents;
      const filters = Array.from(state.activeFilters);
      return filteredEvents.filter((event) => {
        const userData = state.userDataMap?.get(event.id);
        const matchesFilter = (filterType) => {
          if (filterType === "Watchlist") return !!userData?.isFavorite;
          if (filterType === "Watched") return !!userData?.isWatched;
          if (filterType === "Available") return !!event.hasFile;
          if (filterType === "Requests") return isRequestedEvent(event);
          return event.releaseType === filterType;
        };
        const matched = state.filterMatchMode === "all" ? filters.every(matchesFilter) : filters.some(matchesFilter);
        return state.filterInvert ? !matched : matched;
      });
    }
    function groupEventsByDate(events) {
      const grouped = {};
      events.forEach((event) => {
        if (!event.releaseDate) {
          return;
        }
        const date = releaseDate(event.releaseDate);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const dateKey2 = `${year}-${month}-${day}`;
        if (!grouped[dateKey2]) {
          grouped[dateKey2] = [];
        }
        grouped[dateKey2].push(event);
      });
      return grouped;
    }
    async function searchFromProviders(event, options = {}) {
      const current = lease(ctx);
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
        const lookup = async (providers, types) => {
          const params = new URLSearchParams();
          Object.entries(providers).forEach(([key, value]) => {
            params.append(`providers[${key}]`, value);
          });
          if (types) params.append("types", types);
          try {
            const itemId = await JE.core.api.plugin(`/items/by-providers?${params.toString()}`);
            if (!current()) return null;
            if (itemId == null || itemId === "") return null;
            if (typeof itemId !== "string") throw new Error("Invalid provider lookup response");
            return itemId;
          } catch (error) {
            if (record(error) && error.status === 404) return null;
            throw error;
          }
        };
        if (hasEpisodeProviders && !preferSeries) {
          const episodeItemId = await lookup(episodeProviders, "Episode");
          if (episodeItemId) return episodeItemId;
        }
        if (!current()) return null;
        if (hasSeriesProviders) {
          return await lookup(seriesProviders, event.type === "Movie" ? "Movie" : "Series");
        }
        return null;
      } catch (error) {
        console.error(`${logPrefix} Provider search failed:`, error);
        return null;
      }
    }
    P.state = state;
    P.STATUS_COLORS = STATUS_COLORS;
    P.saveFilters = saveFilters;
    P.setStoredCollapse = setStoredCollapse;
    P.setStoredShowUnmonitored = setStoredShowUnmonitored;
    P.loadSettings = loadSettings;
    P.fetchCalendarEvents = fetchCalendarEvents;
    P.fetchUserData = fetchUserData;
    P.ensureRequestData = ensureRequestData;
    P.filterEvents = filterEvents;
    P.groupEventsByDate = groupEventsByDate;
    P.searchFromProviders = searchFromProviders;
  })();
})();
})();
//# sourceMappingURL=calendar-page-data.js.map
