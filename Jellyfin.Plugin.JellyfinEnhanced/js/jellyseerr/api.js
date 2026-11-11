(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared2 = core.core?.featureContext;
    if (typeof shared2 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared2(feature, core, slots);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE) {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE.internals || (JE.internals = {})
      });
      coreContexts.set(JE, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export0 = /* @__PURE__ */ sharedExport(shared, "SeerrDecodeError");
  var export1 = /* @__PURE__ */ sharedExport(shared, "decodeAdvancedData");
  var export2 = /* @__PURE__ */ sharedExport(shared, "decodeBelongsToCollection");
  var export4 = /* @__PURE__ */ sharedExport(shared, "decodeFolders");
  var export5 = /* @__PURE__ */ sharedExport(shared, "decodeIssuePage");
  var export6 = /* @__PURE__ */ sharedExport(shared, "decodeOverrideRules");
  var export7 = /* @__PURE__ */ sharedExport(shared, "decodeProfiles");
  var export8 = /* @__PURE__ */ sharedExport(shared, "decodeRelatedPage");
  var export9 = /* @__PURE__ */ sharedExport(shared, "decodeRequestSettings");
  var export10 = /* @__PURE__ */ sharedExport(shared, "decodeSearchPage");
  var export11 = /* @__PURE__ */ sharedExport(shared, "decodeSonarrCandidates");
  var export14 = /* @__PURE__ */ sharedExport(shared, "isCollectionRef");
  var export17 = /* @__PURE__ */ sharedExport(shared, "isMovieCollection");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export21 = /* @__PURE__ */ sharedExport(shared, "isServiceListing");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");
  var export23 = /* @__PURE__ */ sharedExport(shared, "isUserQuota");
  var export24 = /* @__PURE__ */ sharedExport(shared, "isUserStatus");

  // client/src/features/seerr/core/override-rules.ts
  function ruleMedia(value) {
    if (!export19(value)) return { originalLanguage: null, genreIds: void 0, genreNames: [], keywordNames: void 0 };
    const names = (list) => Array.isArray(list) ? list.map((entry) => export19(entry) && export22(entry.name) ? entry.name.toLowerCase() : "") : [];
    const keywords = value.jeRuleKeywords || value.keywords;
    return {
      originalLanguage: export22(value.originalLanguage) && value.originalLanguage ? value.originalLanguage : null,
      genreIds: Array.isArray(value.genreIds) ? value.genreIds.filter((id) => export18(id) || export22(id)).map(String) : void 0,
      genreNames: names(value.genres),
      // A non-list keyword field matches no keyword rule.
      keywordNames: keywords ? names(keywords) : void 0
    };
  }
  var split = (value, separator) => value.split(separator).map((part) => part.trim());
  function ruleTags(tags) {
    if (Array.isArray(tags)) return tags.map((tag) => export18(tag) ? tag : parseInt(tag, 10)).filter((tag) => !Number.isNaN(tag));
    if (export22(tags)) return split(tags, "|").map((tag) => parseInt(tag, 10)).filter((tag) => !Number.isNaN(tag));
    if (export18(tags)) return [tags];
    return void 0;
  }
  async function matchOverrideRule(rules, media, mediaType, currentUser) {
    const serviceIdKey = mediaType === "movie" ? "radarrServiceId" : "sonarrServiceId";
    for (const rule of rules) {
      const serviceId = rule[serviceIdKey];
      if (serviceId === null || serviceId === void 0) continue;
      if (rule.language && media.originalLanguage) {
        const allowed = split(rule.language, "|").map((language) => language.toLowerCase());
        if (!allowed.includes(media.originalLanguage.toLowerCase())) continue;
      }
      if (rule.genre && media.genreIds) {
        const ruleGenres = split(rule.genre, "|").map((genre) => genre.toLowerCase());
        const ids = media.genreIds;
        if (!ruleGenres.some((genre) => media.genreNames.includes(genre) || ids.includes(genre))) continue;
      }
      if (rule.keywords && media.keywordNames) {
        const ruleKeywords = split(rule.keywords, "|").map((keyword) => keyword.toLowerCase());
        const names = media.keywordNames;
        if (!ruleKeywords.some((keyword) => names.includes(keyword))) continue;
      }
      if (rule.users) {
        const user = await currentUser();
        if (!user || !split(rule.users, ",").includes(user)) continue;
      }
      const settings = { serverId: serviceId };
      if (rule.profileId !== null && rule.profileId !== void 0) settings.profileId = rule.profileId;
      if (rule.rootFolder) settings.rootFolder = rule.rootFolder;
      const tags = rule.tags ? ruleTags(rule.tags) : void 0;
      if (tags) settings.tags = tags;
      return { rule, settings };
    }
    return null;
  }

  // client/src/features/seerr/core/runtime.ts
  function groupInternals(JE) {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE, name) {
    const internals = groupInternals(JE);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }
  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  function escapeWith(JE) {
    return (value) => {
      const escape = JE.escapeHtml;
      if (typeof escape === "function") return escape(value);
      return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
    };
  }
  function text(read) {
    try {
      const value = read();
      return export22(value) && value ? value : null;
    } catch {
      return null;
    }
  }
  function captureOrigin(host) {
    const session = host.JE.session;
    const epoch = session ? session.getEpoch() : null;
    const user = () => text(() => host.apiClient()?.getCurrentUserId?.());
    const server = () => text(() => {
      const client = host.apiClient();
      const id = client?.serverId;
      return typeof id === "function" ? Reflect.apply(id, client, []) : id;
    });
    const startClient = host.apiClient();
    const root = () => text(() => host.apiClient()?.getUrl("/"));
    const token = () => text(() => host.apiClient()?.accessToken?.());
    const startRoot = root();
    const startToken = token();
    const startUser = user();
    const startServer = server();
    return {
      epoch,
      current: () => host.apiClient() === startClient && root() === startRoot && token() === startToken && (!session || epoch === null || session.isCurrent(epoch)) && user() === startUser && server() === startServer
    };
  }
  function thrownProperty(error, key) {
    if (typeof error !== "object" || error === null) return void 0;
    const value = Reflect.get(error, key);
    return value;
  }
  function isAbortError(error) {
    return thrownProperty(error, "name") === "AbortError";
  }
  function errorStatus(error) {
    const status = thrownProperty(error, "status");
    return export18(status) ? status : null;
  }
  function errorBody(error) {
    const body = thrownProperty(error, "responseJSON");
    if (!export19(body)) return { message: null, code: null, requestOutcome: null };
    return {
      message: export22(body.message) && body.message ? body.message : null,
      code: export22(body.code) && body.code ? body.code : null,
      requestOutcome: body.requestOutcome === "unknown" || body.requestOutcome === "rejected" || body.requestOutcome === "not_sent" ? body.requestOutcome : null
    };
  }
  var RequestNotSentError = class extends Error {
    constructor(reason, detail) {
      super(detail);
      this.reason = reason;
      this.name = "SeerrRequestNotSent";
    }
  };
  function classifyFailure(error, quotaEnabled) {
    if (error instanceof RequestNotSentError || error instanceof Error && error.name === "SeerrRequestNotSent") return "not-sent";
    const status = errorStatus(error);
    const { message, requestOutcome } = errorBody(error);
    if (requestOutcome === "unknown") return "uncertain";
    if (requestOutcome === "not_sent") return "not-sent";
    if (status === null || status >= 500 && requestOutcome !== "rejected") return "uncertain";
    if (status === 403 && quotaEnabled && /quota\s+exceeded/i.test(message || "")) return "quota";
    if (status === 404) return "user-not-found";
    if (status === 403) return "permission";
    return "rejected";
  }
  var OUTCOME_LIMIT = 50;
  function recordOutcome(JE, outcome) {
    const internals = groupInternals(JE);
    const outcomes = internals.outcomes || (internals.outcomes = []);
    outcomes.push(outcome);
    if (outcomes.length > OUTCOME_LIMIT) outcomes.splice(0, outcomes.length - OUTCOME_LIMIT);
  }

  // client/src/features/seerr/core/api.ts
  var LOG = "🪼 Jellyfin Enhanced: Seerr API:";
  var NEGATIVE_USER_STATUS_TTL_MS = 60 * 1e3;
  var OVERRIDE_RULES_TTL_MS = 5 * 60 * 1e3;
  var MOVIE_COLLECTIONS_TTL_MS = 30 * 60 * 1e3;
  var MOVIE_COLLECTIONS_MAX_ENTRIES = 1e3;
  var MOVIE_COLLECTIONS_IDS_PER_REQUEST = 40;
  var BANNER_REASONS = {
    blocked: "Your administrator has disabled Seerr for your account.",
    unlinked: "Your Seerr account isn't linked yet. Sign in to Seerr once to enable requests.",
    unreachable: "Can't reach Seerr right now. Please try again in a moment.",
    no_user: "Couldn't load your account. Try signing out and back in."
  };
  var SETTING_KEYS = ["serverId", "profileId", "rootFolder", "languageProfileId", "tags", "is4k"];
  var segment = (value) => encodeURIComponent(String(value));
  function readOptions(options) {
    const out = {};
    if (!options) return out;
    if (options.signal) out.signal = options.signal;
    if (options.skipCache) out.skipCache = true;
    if (options.skipRetry) out.skipRetry = true;
    if (options.headers) out.headers = options.headers;
    return out;
  }
  function forwardedSettings(value) {
    const out = {};
    for (const key of SETTING_KEYS) {
      const entry = Reflect.get(value, key);
      if (key === "rootFolder") {
        if (export22(entry)) out.rootFolder = entry;
      } else if (key === "is4k") {
        if (typeof entry === "boolean") out.is4k = entry;
      } else if (key === "tags") {
        if (Array.isArray(entry)) out.tags = entry.filter(export18);
      } else if (export18(entry)) out[key] = entry;
    }
    return out;
  }
  function positiveInteger(value) {
    const number = export18(value) ? value : export22(value) ? parseInt(value, 10) : NaN;
    return Number.isInteger(number) && number > 0 ? number : null;
  }
  function installApi(host) {
    const { JE } = host;
    if (!firstInstall(JE, "api")) return;
    const escapeHtml = escapeWith(JE);
    let cachedUserStatus = null;
    let cachedUserStatusAt = 0;
    let cachedOverrideRules = null;
    let overrideRulesCachedAt = 0;
    let lastRequestSettings = null;
    const movieCollections = /* @__PURE__ */ new Map();
    const coreApi = () => {
      const api2 = JE.core?.api;
      if (!api2) throw new Error("Seerr API used before the core API client");
      return api2;
    };
    const url = (path) => {
      const client = host.apiClient();
      if (!client) throw new Error("Jellyfin ApiClient is unavailable");
      return client.getUrl(path);
    };
    function get(path, options = {}) {
      const fetchOptions = { ...options };
      if (!options.skipCache) fetchOptions.cacheKey = `jellyseerr:${path}`;
      return coreApi().fetch(url(`/JellyfinEnhanced/jellyseerr${path}`), fetchOptions);
    }
    function tmdbGet(path, options = {}) {
      const fetchOptions = { ...options };
      if (!options.skipCache) fetchOptions.cacheKey = `tmdb:${path}`;
      return coreApi().fetch(url(`/JellyfinEnhanced/tmdb${path}`), fetchOptions);
    }
    function post(path, body) {
      return coreApi().plugin(`/jellyseerr${path}`, { method: "POST", body, skipRetry: true });
    }
    const detailsOrNull = (value) => export19(value) ? value : null;
    function recallMovieCollection(tmdbId) {
      const entry = movieCollections.get(tmdbId);
      if (!entry) return void 0;
      if (Date.now() - entry.at >= MOVIE_COLLECTIONS_TTL_MS) {
        movieCollections.delete(tmdbId);
        return void 0;
      }
      return entry.collection;
    }
    function rememberMovieCollection(tmdbId, collection) {
      movieCollections.delete(tmdbId);
      if (movieCollections.size >= MOVIE_COLLECTIONS_MAX_ENTRIES) {
        const oldest = movieCollections.keys().next();
        if (!oldest.done) movieCollections.delete(oldest.value);
      }
      movieCollections.set(tmdbId, { collection, at: Date.now() });
    }
    function invalidateRequestCaches(tmdbId, mediaType) {
      const manager = JE.requestManager;
      if (!manager?.clearCacheMatching) return;
      const id = String(tmdbId);
      const type = mediaType.toLowerCase();
      if (!id || type !== "movie" && type !== "tv") return;
      const patterns = [
        `jellyseerr:/${type}/${id}`,
        "jellyseerr:/search?",
        "jellyseerr:/discover/",
        "jellyseerr:/request?",
        "jellyseerr:/watchlist?",
        "jellyseerr:/quota"
      ];
      if (type === "movie") patterns.push(`tmdb:/movie/${id}`);
      for (const pattern of patterns) manager.clearCacheMatching(pattern);
    }
    function emitMediaRequested(tmdbId, mediaType, is4k) {
      const type = mediaType.toLowerCase();
      host.document.dispatchEvent(new CustomEvent("jellyseerr-media-requested", { detail: { tmdbId: String(tmdbId), mediaType: type, is4k } }));
      if (type === "tv") host.document.dispatchEvent(new CustomEvent("jellyseerr-tv-requested", { detail: { tmdbId: String(tmdbId), mediaType: "tv" } }));
    }
    async function submitRequest(tmdbIdValue, mediaType, advancedSettings, is4k, mediaData, extraBody, tvdbId) {
      const origin = captureOrigin(host);
      const tmdbId = positiveInteger(tmdbIdValue);
      const outcomeBase = { mediaType, tmdbId: tmdbId ?? 0, is4k };
      if (tmdbId === null || mediaType !== "movie" && mediaType !== "tv") {
        recordOutcome(JE, { ...outcomeBase, kind: "not-sent", stale: false });
        throw new RequestNotSentError("invalid-input", `Invalid Seerr request target: ${mediaType} ${String(tmdbIdValue)}`);
      }
      const supplied = export19(advancedSettings) ? advancedSettings : {};
      let settings = forwardedSettings(supplied);
      if (Object.keys(supplied).length === 0 && mediaData) {
        const override = await api.evaluateOverrideRules(mediaData, mediaType, is4k);
        if (override) {
          console.debug(`${LOG} Applying override rule settings:`, override);
          settings = forwardedSettings(override);
        }
      }
      if (!origin.current()) {
        recordOutcome(JE, { ...outcomeBase, kind: "not-sent", stale: true });
        throw new RequestNotSentError("identity-changed", "The signed-in account changed before the request was sent");
      }
      const body = { mediaType, mediaId: tmdbId };
      if (extraBody && Array.isArray(extraBody.seasons)) Object.assign(body, extraBody, settings);
      else Object.assign(body, settings, extraBody ?? {});
      if (mediaType === "tv" && tvdbId) body.tvdbId = tvdbId;
      if (is4k) body.is4k = true;
      let result;
      try {
        result = await post("/request", body);
      } catch (error) {
        const status = errorStatus(error);
        const failure = classifyFailure(error, true);
        recordOutcome(JE, {
          ...outcomeBase,
          kind: failure === "uncertain" ? "uncertain" : failure === "not-sent" ? "not-sent" : "rejected",
          stale: !origin.current(),
          ...status === null ? {} : { status }
        });
        throw error;
      }
      const stale = !origin.current();
      recordOutcome(JE, { ...outcomeBase, kind: "acknowledged", stale });
      if (result) {
        try {
          invalidateRequestCaches(tmdbId, mediaType);
        } catch (error) {
          console.warn(`${LOG} Cache invalidation failed:`, error);
        }
        if (!stale) {
          try {
            emitMediaRequested(tmdbId, mediaType, is4k);
          } catch (error) {
            console.warn(`${LOG} Request event failed:`, error);
          }
          try {
            JE.helpers?.trackUsage?.("seerr.request_submitted");
          } catch (error) {
            console.debug(`${LOG} Usage tracking failed:`, error);
          }
          try {
            await api.addToWatchlist(tmdbId, mediaType);
          } catch (error) {
            console.warn(`${LOG} Failed to add to watchlist:`, error);
          }
        }
      }
      return result;
    }
    async function fetchRelated(mediaType, tmdbId, relation, pageOrOptions = 1) {
      const page = typeof pageOrOptions === "number" ? pageOrOptions : pageOrOptions.page || 1;
      const options = typeof pageOrOptions === "object" ? readOptions(pageOrOptions) : {};
      try {
        return export8(await get(`/${mediaType}/${segment(tmdbId)}/${relation}?page=${page}`, options));
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.error(`${LOG} Failed to fetch ${relation} ${mediaType} for TMDB ID ${tmdbId}:`, error);
        return { results: [], page: 1, totalPages: 0, totalResults: 0 };
      }
    }
    const api = {
      followUpOptions(details) {
        if (!export19(details) || !details.jeSpoilerGuard) return void 0;
        const items = Array.isArray(details.jeSpoilerGuardItems) ? details.jeSpoilerGuardItems.filter(export22) : [];
        return { skipCache: true, headers: { "X-JE-Spoiler-Guarded": items.length ? items.join(",") : "1" } };
      },
      async checkUserStatus() {
        if (cachedUserStatus !== null) {
          if (cachedUserStatus.active && cachedUserStatus.userFound) return cachedUserStatus;
          if (Date.now() - cachedUserStatusAt < NEGATIVE_USER_STATUS_TTL_MS) return cachedUserStatus;
        }
        const origin = captureOrigin(host);
        try {
          const prefetched = JE.takePrefetched?.("SeerrUserStatus");
          const raw = export24(prefetched) ? prefetched : await get("/user-status", { skipCache: true });
          if (!export24(raw)) throw new export0("user status");
          if (origin.current()) {
            cachedUserStatus = raw;
            cachedUserStatusAt = Date.now();
            api.surfaceUserStatusBanner(raw);
          }
          return raw;
        } catch (error) {
          console.warn(`${LOG} Status check failed:`, error);
          const body = errorBody(error);
          const reason = body.code || (errorStatus(error) === 401 ? "no_user" : "unreachable");
          const fallback = { active: false, userFound: false, reason };
          if (body.message) fallback.message = body.message;
          if (origin.current()) {
            cachedUserStatus = fallback;
            cachedUserStatusAt = Date.now();
            api.surfaceUserStatusBanner(fallback);
          }
          return fallback;
        }
      },
      surfaceUserStatusBanner(status) {
        try {
          if (!export19(status) || status.active && status.userFound) return;
          const reason = export22(status.reason) ? status.reason : void 0;
          if (reason === "disabled") return;
          if (host.window.__JE_userStatusBannerShown === reason) return;
          host.window.__JE_userStatusBannerShown = reason ?? null;
          const raw = export22(status.message) && status.message || reason && BANNER_REASONS[reason] || "Seerr is unavailable right now.";
          if (typeof JE.toast === "function") JE.toast(`Seerr: ${escapeHtml(raw)}`, 6e3);
          else console.warn(`${LOG} ${raw}`);
        } catch (error) {
          console.debug(`${LOG} surfaceUserStatusBanner threw:`, error);
        }
      },
      shouldShowAdvanced() {
        return !!JE.pluginConfig?.JellyseerrShowAdvanced && cachedUserStatus?.canRequestAdvanced === true;
      },
      clearUserStatusCache() {
        cachedUserStatus = null;
        cachedUserStatusAt = 0;
      },
      async search(query, page = 1, options = {}) {
        const { skipCache = false, signal, throwOnError = false } = options;
        try {
          const browserLanguage = (navigator.language || "").split("-")[0] || "";
          const language = /^[a-z]{2,3}$/i.test(browserLanguage) ? browserLanguage : "en";
          const fetchOptions = { skipCache };
          if (signal) fetchOptions.signal = signal;
          const data = await get(`/search?query=${encodeURIComponent(query)}&page=${page}&language=${language}`, fetchOptions);
          return export10(data);
        } catch (error) {
          if (isAbortError(error) || throwOnError) throw error;
          console.error('%s Search failed for query "%s":', LOG, query, error);
          return { results: [], totalResults: 0 };
        }
      },
      async fetchMovieCollection(tmdbId, options = {}) {
        const signal = options.signal || void 0;
        const fetchOptions = signal ? { signal } : {};
        try {
          const seerr = await get(`/movie/${segment(tmdbId)}`, fetchOptions);
          const c = export19(seerr) && export14(seerr.collection) ? seerr.collection : null;
          if (c?.id) return { id: c.id, name: c.name ?? null, posterPath: c.posterPath ?? null, backdropPath: c.backdropPath ?? null };
          if (JE.pluginConfig?.TmdbEnabled) return export2(await tmdbGet(`/movie/${segment(tmdbId)}`, fetchOptions));
          return null;
        } catch (error) {
          if (isAbortError(error)) throw error;
          console.debug(`${LOG} No collection found for movie ${tmdbId}:`, error);
          return null;
        }
      },
      async addCollections(results, options = {}) {
        if (!results || results.length === 0) return results;
        const signal = options.signal || void 0;
        const out = results.slice();
        const unknownIds = /* @__PURE__ */ new Set();
        for (const item of results) {
          const id = Number(item.id);
          if (item.mediaType === "movie" && Number.isInteger(id) && id > 0 && recallMovieCollection(id) === void 0) unknownIds.add(id);
        }
        const ids = Array.from(unknownIds);
        const origin = captureOrigin(host);
        const answered = /* @__PURE__ */ new Map();
        try {
          for (let c = 0; c < ids.length; c += MOVIE_COLLECTIONS_IDS_PER_REQUEST) {
            const chunk = ids.slice(c, c + MOVIE_COLLECTIONS_IDS_PER_REQUEST);
            const fetchOptions = { skipCache: true };
            if (signal) fetchOptions.signal = signal;
            const data = await get(`/movie-collections?ids=${chunk.join(",")}`, fetchOptions);
            const answers = export19(data) && export19(data.results) ? data.results : {};
            for (const [key, collection] of Object.entries(answers)) {
              const id = Number(key);
              if (!Number.isInteger(id)) continue;
              if (!collection) answered.set(id, null);
              else if (export17(collection)) answered.set(id, collection);
            }
          }
        } catch (error) {
          if (!isAbortError(error)) console.debug(`${LOG} Collection lookup failed:`, error);
        }
        if (origin.current()) answered.forEach((collection, id) => rememberMovieCollection(id, collection));
        results.forEach((item, i) => {
          if (item.mediaType !== "movie") return;
          const id = Number(item.id);
          const collection = answered.has(id) ? answered.get(id) : recallMovieCollection(id);
          if (collection) out[i] = { ...item, collection };
        });
        return out;
      },
      async fetchTvShowDetails(tmdbId, options) {
        try {
          return detailsOrNull(await get(`/tv/${segment(tmdbId)}`, readOptions(options)));
        } catch (error) {
          console.error(`${LOG} Failed to fetch TV show details for TMDB ID ${tmdbId}:`, error);
          return null;
        }
      },
      async fetchSonarrLookup(tmdbId) {
        return export11(await get(`/sonarr/lookup/${segment(tmdbId)}`));
      },
      async fetchTvSeasonDetails(tmdbId, seasonNumber, options) {
        try {
          return detailsOrNull(await get(`/tv/${segment(tmdbId)}/season/${segment(seasonNumber)}`, readOptions(options)));
        } catch (error) {
          console.debug(`${LOG} Failed to fetch season ${seasonNumber} for TMDB ID ${tmdbId}:`, error);
          return null;
        }
      },
      async fetchTmdbTvDetails(tmdbId, options) {
        try {
          return detailsOrNull(await tmdbGet(`/tv/${segment(tmdbId)}`, readOptions(options)));
        } catch (error) {
          console.debug(`${LOG} Failed to fetch TMDB TV details for ID ${tmdbId}:`, error);
          return null;
        }
      },
      async fetchOverrideRules() {
        if (cachedOverrideRules !== null && Date.now() - overrideRulesCachedAt < OVERRIDE_RULES_TTL_MS) return cachedOverrideRules;
        const origin = captureOrigin(host);
        try {
          const rules = export6(await get("/overrideRule"));
          if (origin.current()) {
            cachedOverrideRules = rules;
            overrideRulesCachedAt = Date.now();
          }
          return rules;
        } catch (error) {
          console.error(`${LOG} Failed to fetch override rules:`, error);
          return cachedOverrideRules || [];
        }
      },
      async getCurrentJellyseerrUserId() {
        try {
          const status = await api.checkUserStatus();
          const id = status?.jellyseerrUserId;
          return id || id === 0 ? String(id) : null;
        } catch (error) {
          console.warn(`${LOG} Failed to get current Seerr user ID:`, error);
          return null;
        }
      },
      async evaluateOverrideRules(mediaData, mediaType) {
        try {
          const rules = await api.fetchOverrideRules();
          if (!rules || rules.length === 0) {
            console.debug(`${LOG} No override rules configured`);
            return null;
          }
          const match = await matchOverrideRule(rules, ruleMedia(mediaData), mediaType, () => api.getCurrentJellyseerrUserId());
          if (!match) {
            console.debug(`${LOG} No matching override rules found`);
            return null;
          }
          const { rule, settings } = match;
          console.debug(`${LOG} Matched override rule ${String(rule.id)}:`, {
            language: rule.language,
            genre: rule.genre,
            profileId: rule.profileId,
            rootFolder: rule.rootFolder
          });
          return settings;
        } catch (error) {
          console.error(`${LOG} Error evaluating override rules:`, error);
          return null;
        }
      },
      requestMedia(tmdbId, mediaType, advancedSettings = {}, is4k = false, mediaData = null, tvdbId = null) {
        return submitRequest(
          tmdbId,
          mediaType,
          advancedSettings,
          !!is4k,
          mediaData,
          mediaType === "tv" ? { seasons: "all" } : null,
          positiveInteger(tvdbId)
        );
      },
      requestTvSeasons(tmdbId, seasonNumbers, advancedSettings = {}, mediaData = null, is4k = false, tvdbId = null) {
        const seasons = Array.isArray(seasonNumbers) ? seasonNumbers.filter((n) => Number.isInteger(n) && n >= 0) : [];
        if (seasons.length === 0 || seasons.length !== seasonNumbers.length) {
          const id = positiveInteger(tmdbId) ?? 0;
          recordOutcome(JE, { kind: "not-sent", mediaType: "tv", tmdbId: id, is4k: !!is4k, stale: false });
          return Promise.reject(new RequestNotSentError("invalid-input", "Season numbers must be non-negative integers"));
        }
        return submitRequest(tmdbId, "tv", advancedSettings, !!is4k, mediaData, { seasons }, positiveInteger(tvdbId));
      },
      async fetchIssuesForMedia(tmdbId, mediaType, options = {}) {
        const { take = 20, skip = 0, filter = "open", sort = "added" } = options;
        const query = new URLSearchParams({ take: String(take), skip: String(skip), filter, sort });
        const page = export5(await get(`/issue?${query.toString()}`));
        const results = page.results.filter((issue) => {
          const media = issue.media || {};
          const tmdbMatch = !!media.tmdbId && Number(media.tmdbId) === Number(tmdbId);
          const typeMatch = (media.mediaType || "").toLowerCase() === (mediaType || "").toLowerCase();
          return tmdbMatch && typeMatch;
        });
        return { ...page, results };
      },
      async fetchIssueById(issueId) {
        try {
          return detailsOrNull(await get(`/issue/${segment(issueId)}`));
        } catch (error) {
          console.warn(`${LOG} Failed to fetch issue ${issueId}:`, error);
          return null;
        }
      },
      async fetchAdvancedRequestData(mediaType) {
        const serverType = mediaType === "movie" ? "radarr" : "sonarr";
        const listed = await get(`/${serverType}`);
        const serverList = Array.isArray(listed) ? listed : [listed];
        const servers = await Promise.all(serverList.filter(export21).map(async (server) => {
          try {
            const details = await get(`/${serverType}/${server.id}`);
            const record = export19(details) ? details : {};
            return { ...server, qualityProfiles: export7(record.profiles), rootFolders: export4(record.rootFolders) };
          } catch (error) {
            console.error(`${LOG} Could not fetch details for ${serverType} server ID ${server.id}:`, error);
            return { ...server, qualityProfiles: [], rootFolders: [] };
          }
        }));
        return export1({ servers, tags: [] });
      },
      async fetchUserQuota(options = {}) {
        if (host.liveBridge()?.pluginConfig?.JellyseerrShowQuotaInfo === false) return null;
        try {
          const quota = await get("/quota", readOptions(options));
          if (export23(quota)) return quota;
          console.warn(`${LOG} Quota response was not a quota document`);
          return null;
        } catch (error) {
          const status = errorStatus(error);
          if (status === 404 || status === 503) console.debug(`${LOG} Quota fetch failed:`, error);
          else console.warn(`${LOG} Quota fetch failed:`, error);
          return null;
        }
      },
      async fetchRequestSettings() {
        try {
          const settings = export9(await get("/settings/partial-requests", { skipCache: true }));
          lastRequestSettings = settings;
          return settings;
        } catch (error) {
          console.warn(`${LOG} Failed to fetch request settings:`, error);
          return lastRequestSettings || { partialRequestsEnabled: false, enableSpecialEpisodes: false };
        }
      },
      async addToWatchlist(tmdbId, mediaType) {
        try {
          const config = host.liveBridge()?.pluginConfig;
          if (!config) {
            console.debug(`${LOG} Plugin config not loaded yet`);
            return false;
          }
          if (!config.AddRequestedMediaToWatchlist || !config.JellyseerrEnabled) {
            console.debug(`${LOG} Watchlist auto-add is disabled (AddRequestedMediaToWatchlist: ${String(config.AddRequestedMediaToWatchlist)}, JellyseerrEnabled: ${String(config.JellyseerrEnabled)})`);
            return false;
          }
          const id = parseInt(String(tmdbId), 10);
          if (!(id > 0) || mediaType !== "movie" && mediaType !== "tv") return false;
          try {
            await post("/watchlist", { tmdbId: id, mediaType });
          } catch (error) {
            if (errorStatus(error) === 409) return true;
            throw error;
          }
          return true;
        } catch (error) {
          console.error(`${LOG} Error adding the request to the Seerr watchlist:`, error);
          return false;
        }
      },
      async reportIssue(mediaId, mediaType, problemType, message = "", problemSeason = 0, problemEpisode = 0) {
        const origin = captureOrigin(host);
        try {
          const issueType = parseInt(String(problemType), 10) || 4;
          let details = null;
          if (mediaType === "movie") details = await get(`/movie/${segment(mediaId)}`);
          else if (mediaType === "tv") details = await get(`/tv/${segment(mediaId)}`);
          const mediaInfo = export19(details) && export19(details.mediaInfo) ? details.mediaInfo : null;
          const internalId = mediaInfo ? positiveInteger(mediaInfo.id) : null;
          if (!internalId) throw new Error(`Could not find Jellyseerr media id (mediaInfo.id) for TMDB id ${mediaId} (${mediaType})`);
          if (!origin.current()) throw new RequestNotSentError("identity-changed", "The signed-in account changed before the issue was sent");
          console.debug(`${LOG} Retrieved internal media id for issue report:`, internalId);
          const body = {
            mediaId: internalId,
            issueType,
            problemSeason: parseInt(String(problemSeason), 10) || 0,
            problemEpisode: parseInt(String(problemEpisode), 10) || 0,
            message: message || ""
          };
          console.debug(`${LOG} Sending issue report with body:`, body);
          const result = await post("/issue", body);
          console.debug(`${LOG} Issue reported for Seerr media ID ${internalId} (TMDB ${mediaId}, ${mediaType}): ${String(problemType)}`);
          return result;
        } catch (error) {
          console.error(`${LOG} Failed to report issue for TMDB ID ${mediaId}:`, error);
          throw error;
        }
      },
      fetchSimilarMovies: (tmdbId, pageOrOptions) => fetchRelated("movie", tmdbId, "similar", pageOrOptions),
      fetchRecommendedMovies: (tmdbId, pageOrOptions) => fetchRelated("movie", tmdbId, "recommendations", pageOrOptions),
      fetchSimilarTvShows: (tmdbId, pageOrOptions) => fetchRelated("tv", tmdbId, "similar", pageOrOptions),
      fetchRecommendedTvShows: (tmdbId, pageOrOptions) => fetchRelated("tv", tmdbId, "recommendations", pageOrOptions),
      async fetchMovieDetails(tmdbId, options) {
        try {
          return detailsOrNull(await get(`/movie/${segment(tmdbId)}`, readOptions(options)));
        } catch (error) {
          console.error(`${LOG} Failed to fetch movie details for TMDB ID ${tmdbId}:`, error);
          return null;
        }
      },
      async fetchCollectionDetails(collectionId) {
        try {
          return detailsOrNull(await get(`/collection/${segment(collectionId)}`));
        } catch (error) {
          console.error(`${LOG} Failed to fetch collection details for ID ${collectionId}:`, error);
          return null;
        }
      },
      async fetchGenreSlider(mediaType) {
        const type = mediaType === "movie" ? "movie" : "tv";
        try {
          const slider = await get(`/discover/genreslider/${type}`);
          return Array.isArray(slider) ? slider : [];
        } catch (error) {
          console.error(`${LOG} Failed to fetch genre slider for ${type}:`, error);
          return [];
        }
      },
      resolveJellyseerrBaseUrl() {
        const config = JE.pluginConfig;
        let baseUrl = "";
        if (config?.JellyseerrUrlMappings) {
          const client = host.apiClient();
          const address = client?.serverAddress ? client.serverAddress() : host.window.location.origin;
          const currentUrl = String(address).replace(/\/+$/, "").toLowerCase();
          const mappings = String(config.JellyseerrUrlMappings).split("\n").map((line) => line.trim()).filter(Boolean);
          for (const mapping of mappings) {
            const [jellyfinUrl, seerrUrl] = mapping.split("|").map((part) => part.trim());
            if (!jellyfinUrl || !seerrUrl) continue;
            if (currentUrl === jellyfinUrl.replace(/\/+$/, "").toLowerCase()) {
              baseUrl = seerrUrl.replace(/\/$/, "");
              break;
            }
          }
        }
        if (!baseUrl && config?.JellyseerrBaseUrl) baseUrl = String(config.JellyseerrBaseUrl).trim().replace(/\/$/, "");
        return baseUrl;
      }
    };
    JE.session?.onUserChange("jellyseerr-movie-collections", () => movieCollections.clear());
    JE.session?.onUserChange("jellyseerr-api", () => {
      cachedUserStatus = null;
      cachedUserStatusAt = 0;
      cachedOverrideRules = null;
      overrideRulesCachedAt = 0;
      lastRequestSettings = null;
      host.window.__JE_userStatusBannerShown = null;
    });
    JE.jellyseerrAPI = api;
  }

  // client/src/features/seerr/core/api-entry.ts
  installApi(seerrCoreHost());
})();
})();
//# sourceMappingURL=api.js.map
