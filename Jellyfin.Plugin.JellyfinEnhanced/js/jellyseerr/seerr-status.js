(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }
  function publishSharedModules(modules) {
    const JE2 = window.JellyfinEnhanced;
    if (!JE2) return;
    const core = JE2.core ?? (JE2.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }

  // client/src/features/seerr/core/status.ts
  var status_exports = {};
  __export(status_exports, {
    DISPLAY: () => DISPLAY,
    MEDIA: () => MEDIA,
    REQUEST: () => REQUEST,
    createStatusFacade: () => createStatusFacade,
    effectiveMediaStatus: () => effectiveMediaStatus,
    getBadgeConfig: () => getBadgeConfig,
    getButtonConfig: () => getButtonConfig,
    getChipConfig: () => getChipConfig,
    getDisplayInfo: () => getDisplayInfo,
    hasStatus: () => hasStatus,
    isRequestable: () => isRequestable,
    resolveDisplayStatus: () => resolveDisplayStatus
  });
  var MEDIA = Object.freeze({
    UNKNOWN: 1,
    PENDING: 2,
    PROCESSING: 3,
    PARTIALLY_AVAILABLE: 4,
    AVAILABLE: 5,
    BLOCKED: 6,
    DELETED: 7
  });
  var REQUEST = Object.freeze({
    PENDING: 1,
    APPROVED: 2,
    DECLINED: 3,
    FAILED: 4,
    COMPLETED: 5
  });
  var DISPLAY = Object.freeze({
    AVAILABLE: "available",
    AVAILABLE_UPDATING: "available-updating",
    PENDING: "pending",
    PROCESSING: "processing",
    REQUESTED: "requested",
    PARTIAL: "partial",
    BLOCKED: "blocked",
    DELETED: "deleted",
    NONE: "none"
  });
  function isRequestable(mediaStatus) {
    return !mediaStatus || mediaStatus === MEDIA.UNKNOWN || mediaStatus === MEDIA.DELETED;
  }
  function hasStatus(mediaStatus) {
    return !!mediaStatus && mediaStatus !== MEDIA.UNKNOWN;
  }
  function effectiveMediaStatus(rawStatus, jellyfinId, jellyfinSeasonMap = null, seasonNumber = null) {
    const status = rawStatus ?? MEDIA.UNKNOWN;
    if (status !== MEDIA.AVAILABLE) return status;
    if (jellyfinSeasonMap !== null && seasonNumber !== null) return jellyfinSeasonMap[seasonNumber] ? MEDIA.AVAILABLE : MEDIA.DELETED;
    return jellyfinId ? MEDIA.AVAILABLE : MEDIA.DELETED;
  }
  function resolveDisplayStatus(status, hasActiveDownloads = false) {
    switch (status) {
      case MEDIA.AVAILABLE:
        return hasActiveDownloads ? DISPLAY.AVAILABLE_UPDATING : DISPLAY.AVAILABLE;
      case MEDIA.PENDING:
        return DISPLAY.PENDING;
      case MEDIA.PROCESSING:
        return hasActiveDownloads ? DISPLAY.PROCESSING : DISPLAY.REQUESTED;
      case MEDIA.PARTIALLY_AVAILABLE:
        return DISPLAY.PARTIAL;
      case MEDIA.BLOCKED:
        return DISPLAY.BLOCKED;
      case MEDIA.DELETED:
        return DISPLAY.DELETED;
      default:
        return DISPLAY.NONE;
    }
  }
  function getButtonConfig(displayStatus) {
    switch (displayStatus) {
      case DISPLAY.AVAILABLE:
        return { labelKey: "jellyseerr_btn_available", cssClass: "jellyseerr-button-available", disabled: true, showSpinner: false, iconKey: "available" };
      case DISPLAY.AVAILABLE_UPDATING:
        return { labelKey: "jellyseerr_btn_available", cssClass: "jellyseerr-button-available-updating", disabled: true, showSpinner: true, iconKey: "available" };
      case DISPLAY.PENDING:
        return { labelKey: "jellyseerr_btn_pending", cssClass: "jellyseerr-button-pending", disabled: true, showSpinner: false, iconKey: "pending" };
      case DISPLAY.PROCESSING:
        return { labelKey: "jellyseerr_btn_processing", cssClass: "jellyseerr-button-processing", disabled: true, showSpinner: true, iconKey: "" };
      case DISPLAY.REQUESTED:
        return { labelKey: "jellyseerr_btn_requested", cssClass: "jellyseerr-button-pending", disabled: true, showSpinner: false, iconKey: "requested" };
      case DISPLAY.PARTIAL:
        return { labelKey: "jellyseerr_btn_partially_available", cssClass: "jellyseerr-button-partially-available", disabled: true, showSpinner: false, iconKey: "partially_available" };
      case DISPLAY.BLOCKED:
        return { labelKey: "jellyseerr_btn_blocklisted", cssClass: "jellyseerr-button-blocklisted", disabled: true, showSpinner: false, iconKey: "cancel" };
      default:
        return { labelKey: "jellyseerr_btn_request", cssClass: "jellyseerr-button-request", disabled: false, showSpinner: false, iconKey: "request" };
    }
  }
  var AVAILABLE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>`;
  var BADGE_ICONS = {
    [DISPLAY.AVAILABLE]: AVAILABLE_ICON,
    [DISPLAY.AVAILABLE_UPDATING]: AVAILABLE_ICON,
    [DISPLAY.PENDING]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M5.25 9a6.75 6.75 0 0113.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 01-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 11-7.48 0 24.585 24.585 0 01-4.831-1.244.75.75 0 01-.298-1.205A8.217 8.217 0 005.25 9.75V9zm4.502 8.9a2.25 2.25 0 104.496 0 25.057 25.057 0 01-4.496 0z" clip-rule="evenodd" /></svg>`,
    [DISPLAY.PROCESSING]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`,
    [DISPLAY.REQUESTED]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 000-1.5h-3.75V6z" clip-rule="evenodd"></path></svg>`,
    [DISPLAY.PARTIAL]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clip-rule="evenodd" /></svg>`,
    [DISPLAY.BLOCKED]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" /></svg>`,
    [DISPLAY.DELETED]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" /></svg>`
  };
  var BADGE_CSS = {
    [DISPLAY.AVAILABLE]: "status-available",
    [DISPLAY.AVAILABLE_UPDATING]: "status-available",
    [DISPLAY.PENDING]: "status-pending",
    [DISPLAY.PROCESSING]: "status-processing",
    [DISPLAY.REQUESTED]: "status-requested",
    [DISPLAY.PARTIAL]: "status-partially-available",
    [DISPLAY.BLOCKED]: "status-blocklisted",
    [DISPLAY.DELETED]: "status-deleted"
  };
  function getBadgeConfig(displayStatus) {
    const icon = BADGE_ICONS[displayStatus];
    const cssClass = BADGE_CSS[displayStatus];
    if (!icon || !cssClass) return null;
    return { icon, cssClass };
  }
  function getDisplayInfo(mediaStatus, hasActiveDownloads = false) {
    switch (mediaStatus) {
      case MEDIA.PENDING:
      case MEDIA.PROCESSING:
        return { labelKey: hasActiveDownloads ? "jellyseerr_season_status_processing" : "jellyseerr_season_status_requested", cssClass: "processing" };
      case MEDIA.PARTIALLY_AVAILABLE:
        return { labelKey: "jellyseerr_season_status_partial", cssClass: "partially-available" };
      case MEDIA.AVAILABLE:
        return { labelKey: "jellyseerr_season_status_available", cssClass: "available" };
      case MEDIA.BLOCKED:
        return { labelKey: "jellyseerr_status_blocked", cssClass: "blocked" };
      default:
        return { labelKey: "jellyseerr_season_status_not_requested", cssClass: "not-requested" };
    }
  }
  function getChipConfig(displayStatus) {
    switch (displayStatus) {
      case DISPLAY.AVAILABLE:
      case DISPLAY.AVAILABLE_UPDATING:
        return { labelKey: "jellyseerr_btn_available", cssClass: "chip-available" };
      case DISPLAY.PARTIAL:
        return { labelKey: "jellyseerr_btn_partially_available", cssClass: "chip-partial" };
      case DISPLAY.PROCESSING:
        return { labelKey: "jellyseerr_btn_processing", cssClass: "chip-processing" };
      case DISPLAY.PENDING:
      case DISPLAY.REQUESTED:
        return { labelKey: "jellyseerr_btn_requested", cssClass: "chip-requested" };
      case DISPLAY.BLOCKED:
        return { labelKey: "jellyseerr_btn_blocklisted", cssClass: "chip-blocklisted" };
      case DISPLAY.DELETED:
        return { labelKey: "jellyseerr_btn_deleted", cssClass: "chip-deleted" };
      default:
        return { labelKey: "jellyseerr_btn_requested", cssClass: "chip-requested" };
    }
  }
  function createStatusFacade() {
    return {
      MEDIA,
      REQUEST,
      DISPLAY,
      isRequestable,
      hasStatus,
      effectiveMediaStatus,
      resolveDisplayStatus,
      getButtonConfig,
      getBadgeConfig,
      getDisplayInfo,
      getChipConfig
    };
  }

  // client/src/features/seerr/core/decode.ts
  var decode_exports = {};
  __export(decode_exports, {
    SeerrDecodeError: () => SeerrDecodeError,
    decodeAdvancedData: () => decodeAdvancedData,
    decodeBelongsToCollection: () => decodeBelongsToCollection,
    decodeCollectionParts: () => decodeCollectionParts,
    decodeFolders: () => decodeFolders,
    decodeIssuePage: () => decodeIssuePage,
    decodeOverrideRules: () => decodeOverrideRules,
    decodeProfiles: () => decodeProfiles,
    decodeRelatedPage: () => decodeRelatedPage,
    decodeRequestSettings: () => decodeRequestSettings,
    decodeSearchPage: () => decodeSearchPage,
    decodeSonarrCandidates: () => decodeSonarrCandidates,
    decodeTvDetails: () => decodeTvDetails,
    isBoolean: () => isBoolean,
    isCollectionRef: () => isCollectionRef,
    isMediaInfo: () => isMediaInfo,
    isMediaItem: () => isMediaItem,
    isMovieCollection: () => isMovieCollection,
    isNumber: () => isNumber,
    isRecord: () => isRecord,
    isSafeTmdbImagePath: () => isSafeTmdbImagePath,
    isServiceListing: () => isServiceListing,
    isString: () => isString,
    isUserQuota: () => isUserQuota,
    isUserStatus: () => isUserStatus,
    mediaItems: () => mediaItems,
    parseItemAttribute: () => parseItemAttribute
  });
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  var isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  var isString = (value) => typeof value === "string";
  var isSafeTmdbImagePath = (path) => typeof path === "string" && /^\/[A-Za-z0-9_\-.]+\.(jpg|jpeg|png|webp|avif)$/i.test(path);
  var isBoolean = (value) => typeof value === "boolean";
  var optional = (check) => (value) => value === void 0 || check(value);
  var nullable = (check) => (value) => value === void 0 || value === null || check(value);
  var listOf = (check) => (value) => Array.isArray(value) && value.every(check);
  var either = (...checks) => (value) => checks.some((check) => check(value));
  function matches(value, checks) {
    if (!isRecord(value)) return false;
    const table = checks;
    for (const [key, check] of Object.entries(table)) {
      if (!check(value[key])) return false;
    }
    return true;
  }
  var seasonStatusChecks = {
    seasonNumber: optional(isNumber),
    status: nullable(isNumber),
    status4k: nullable(isNumber)
  };
  var isSeasonStatus = (value) => matches(value, seasonStatusChecks);
  var downloadChecks = {
    title: nullable(isString),
    status: nullable(isString),
    size: nullable(isNumber),
    sizeLeft: nullable(isNumber),
    estimatedCompletionTime: nullable(isString),
    episode: nullable((value) => matches(value, { seasonNumber: nullable(isNumber) }))
  };
  var isDownload = (value) => matches(value, downloadChecks);
  var requestSummaryChecks = {
    is4k: nullable(isBoolean),
    seasons: nullable(listOf((value) => matches(value, {
      seasonNumber: optional(isNumber),
      status: nullable(isNumber)
    })))
  };
  var mediaInfoChecks = {
    id: nullable(isNumber),
    tvdbId: nullable(isNumber),
    status: nullable(isNumber),
    status4k: nullable(isNumber),
    jellyfinMediaId: nullable(isString),
    jellyfinMediaId4k: nullable(isString),
    seasons: nullable(listOf(isSeasonStatus)),
    downloadStatus: nullable(listOf(isDownload)),
    downloadStatus4k: nullable(listOf(isDownload)),
    requests: nullable(listOf((value) => matches(value, requestSummaryChecks)))
  };
  var isMediaInfo = (value) => matches(value, mediaInfoChecks);
  var collectionChecks = {
    id: nullable(isNumber),
    name: nullable(isString),
    posterPath: nullable(isString),
    backdropPath: nullable(isString)
  };
  var isCollectionRef = (value) => matches(value, collectionChecks);
  var mediaItemChecks = {
    id: isNumber,
    mediaType: isString,
    title: nullable(isString),
    name: nullable(isString),
    originalTitle: nullable(isString),
    originalName: nullable(isString),
    posterPath: nullable(isString),
    backdropPath: nullable(isString),
    overview: nullable(isString),
    voteAverage: nullable(isNumber),
    releaseDate: nullable(isString),
    firstAirDate: nullable(isString),
    mediaInfo: nullable(isMediaInfo),
    collection: nullable(isCollectionRef)
  };
  var isMediaItem = (value) => matches(value, mediaItemChecks);
  function mediaItems(value) {
    if (!Array.isArray(value)) return { items: [], dropped: 0 };
    const items = [];
    let dropped = 0;
    for (const entry of value) {
      if (isMediaItem(entry)) items.push(entry);
      else dropped++;
    }
    return { items, dropped };
  }
  var SeerrDecodeError = class extends Error {
    constructor(what) {
      super(`Seerr response did not match the expected ${what}`);
      this.name = "SeerrDecodeError";
    }
  };
  function decodeSearchPage(value) {
    if (!isRecord(value)) throw new SeerrDecodeError("search page");
    if (value.results !== void 0 && !Array.isArray(value.results)) throw new SeerrDecodeError("search results");
    const raw = Array.isArray(value.results) ? value.results : [];
    const { items } = mediaItems(raw.filter((entry) => !(isRecord(entry) && entry.mediaType === "person")));
    const page = { totalResults: items.length, results: items };
    if (isNumber(value.page)) page.page = value.page;
    if (isNumber(value.totalPages)) page.totalPages = value.totalPages;
    return page;
  }
  function decodeRelatedPage(value) {
    if (!isRecord(value)) throw new SeerrDecodeError("related page");
    const { items } = mediaItems(value.results);
    return {
      page: isNumber(value.page) ? value.page : 1,
      totalPages: isNumber(value.totalPages) ? value.totalPages : 0,
      totalResults: isNumber(value.totalResults) ? value.totalResults : items.length,
      results: items
    };
  }
  var userStatusChecks = {
    active: isBoolean,
    userFound: isBoolean,
    reason: optional(isString),
    message: optional(isString),
    jellyseerrUserId: optional(either(isString, isNumber)),
    canRequestAdvanced: optional(isBoolean)
  };
  var isUserStatus = (value) => matches(value, userStatusChecks);
  var quotaSideChecks = {
    limit: nullable(isNumber),
    used: nullable(isNumber),
    remaining: nullable(isNumber),
    days: nullable(isNumber),
    restricted: nullable(isBoolean),
    nextResetAt: nullable(isString)
  };
  var quotaChecks = {
    movie: nullable((value) => matches(value, quotaSideChecks)),
    tv: nullable((value) => matches(value, quotaSideChecks))
  };
  var isUserQuota = (value) => matches(value, quotaChecks);
  function decodeRequestSettings(value) {
    if (!isRecord(value)) throw new SeerrDecodeError("request settings");
    return { partialRequestsEnabled: value.partialRequestsEnabled === true, enableSpecialEpisodes: value.enableSpecialEpisodes === true };
  }
  var overrideRuleChecks = {
    id: nullable(either(isNumber, isString)),
    radarrServiceId: nullable(isNumber),
    sonarrServiceId: nullable(isNumber),
    language: nullable(isString),
    genre: nullable(isString),
    keywords: nullable(isString),
    users: nullable(isString),
    profileId: nullable(isNumber),
    rootFolder: nullable(isString),
    tags: nullable(either(listOf(either(isNumber, isString)), isNumber, isString))
  };
  function decodeOverrideRules(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((rule) => matches(rule, overrideRuleChecks));
  }
  var profileChecks = { id: isNumber, name: nullable(isString) };
  var folderChecks = { path: isString, freeSpace: nullable(isNumber) };
  function decodeProfiles(value) {
    return Array.isArray(value) ? value.filter((entry) => matches(entry, profileChecks)) : [];
  }
  function decodeFolders(value) {
    return Array.isArray(value) ? value.filter((entry) => matches(entry, folderChecks)) : [];
  }
  var serviceChecks = {
    id: isNumber,
    name: nullable(isString),
    isDefault: nullable(isBoolean),
    is4k: nullable(isBoolean),
    activeProfileId: nullable(isNumber),
    activeDirectory: nullable(isString)
  };
  var isServiceListing = (value) => matches(value, serviceChecks);
  function decodeAdvancedData(value) {
    if (!isRecord(value) || !Array.isArray(value.servers)) return { servers: [], tags: [] };
    const servers = [];
    for (const entry of value.servers) {
      if (!isServiceListing(entry)) continue;
      servers.push({ ...entry, qualityProfiles: decodeProfiles(entry.qualityProfiles), rootFolders: decodeFolders(entry.rootFolders) });
    }
    return { servers, tags: Array.isArray(value.tags) ? value.tags.filter(isNumber) : [] };
  }
  var candidateChecks = {
    tvdbId: isNumber,
    title: nullable(isString),
    year: nullable(either(isNumber, isString)),
    overview: nullable(isString),
    remotePoster: nullable(isString)
  };
  function decodeSonarrCandidates(value) {
    return Array.isArray(value) ? value.filter((entry) => matches(entry, candidateChecks)) : [];
  }
  var movieCollectionChecks = {
    id: isNumber,
    name: nullable(isString),
    posterPath: nullable(isString),
    backdropPath: nullable(isString)
  };
  var isMovieCollection = (value) => matches(value, movieCollectionChecks);
  var issueChecks = {
    id: nullable(isNumber),
    media: nullable((value) => matches(value, {
      tmdbId: nullable(either(isNumber, isString)),
      mediaType: nullable(isString)
    }))
  };
  function decodeIssuePage(value) {
    if (!isRecord(value)) return { results: [] };
    const results = Array.isArray(value.results) ? value.results.filter((issue) => matches(issue, issueChecks)) : [];
    return { ...value, results };
  }
  var tvSeasonChecks = {
    seasonNumber: isNumber,
    name: nullable(isString),
    episodeCount: nullable(isNumber),
    airDate: nullable(isString),
    jeYear: nullable(isString)
  };
  var isTvSeason = (value) => matches(value, tvSeasonChecks);
  function decodeTvDetails(value) {
    if (!isRecord(value) || !Array.isArray(value.seasons)) return null;
    const externalIds = value.externalIds;
    const externalTvdbId = isRecord(externalIds) && isNumber(externalIds.tvdbId) && externalIds.tvdbId > 0 ? externalIds.tvdbId : null;
    const view = {
      seasons: value.seasons.filter(isTvSeason),
      externalTvdbId,
      mediaInfo: isMediaInfo(value.mediaInfo) ? value.mediaInfo : null
    };
    if (isString(value.name)) view.name = value.name;
    if (isString(value.title)) view.title = value.title;
    if (isString(value.backdropPath)) view.backdropPath = value.backdropPath;
    if (value.jeSpoilerGuard === true) view.jeSpoilerGuard = true;
    return view;
  }
  function decodeBelongsToCollection(value) {
    if (!isRecord(value)) return null;
    const belongs = isRecord(value.belongs_to_collection) ? value.belongs_to_collection : isRecord(value.belongsToCollection) ? value.belongsToCollection : null;
    if (!belongs) return null;
    const id = isNumber(belongs.id) && belongs.id ? belongs.id : isNumber(belongs.tmdbId) && belongs.tmdbId ? belongs.tmdbId : null;
    if (id === null) return null;
    const pick = (a, b) => isString(a) && a ? a : isString(b) && b ? b : null;
    return {
      id,
      name: isString(belongs.name) ? belongs.name : null,
      posterPath: pick(belongs.poster_path, belongs.posterPath),
      backdropPath: pick(belongs.backdrop_path, belongs.backdropPath)
    };
  }
  function parseItemAttribute(raw) {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return isMediaItem(value) ? value : null;
    } catch {
      return null;
    }
  }
  var collectionPartChecks = {
    id: isNumber,
    title: nullable(isString),
    posterPath: nullable(isString),
    releaseDate: nullable(isString),
    mediaInfo: nullable(isMediaInfo)
  };
  function decodeCollectionParts(details) {
    if (!isRecord(details) || !Array.isArray(details.parts)) return [];
    return details.parts.filter((part) => matches(part, collectionPartChecks));
  }

  // client/generated-shared/publish/js/jellyseerr/seerr-status.js.ts
  publishSharedModules({ "features/seerr/core/status": status_exports, "features/seerr/core/decode": decode_exports });

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE2) {
    let ctx = coreContexts.get(JE2);
    if (!ctx) {
      ctx = featureContext("seerr", JE2, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE2.internals || (JE2.internals = {})
      });
      coreContexts.set(JE2, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE2 = host.JellyfinEnhanced;
    if (!JE2) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE: JE2, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/src/features/seerr/core/runtime.ts
  function groupInternals(JE2) {
    const own = seerrCoreContext(JE2).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE2, name) {
    const internals = groupInternals(JE2);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }

  // client/src/features/seerr/core/status-entry.ts
  var { JE } = seerrCoreHost();
  if (firstInstall(JE, "status")) JE.seerrStatus = createStatusFacade();
})();
})();
//# sourceMappingURL=seerr-status.js.map
