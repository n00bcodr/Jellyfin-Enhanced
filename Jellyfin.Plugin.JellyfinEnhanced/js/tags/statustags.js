(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "apiClient");
  var export1 = /* @__PURE__ */ sharedExport(shared, "hasApiClient");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export2 = /* @__PURE__ */ sharedExport(shared2, "finite");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "own");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "records");
  var export12 = /* @__PURE__ */ sharedExport(shared2, "stringList");
  var export13 = /* @__PURE__ */ sharedExport(shared2, "text");

  // client/src/features/media-tags/types/status/status-facts.ts
  var MAX_DATE_MS = 864e13;
  function readLeaving(raw) {
    if (!export42(raw)) return null;
    const deleteAt = toMs(raw.DeleteAt ?? raw.deleteAt ?? null);
    return { deleteAt: deleteAt !== null && Math.abs(deleteAt) <= MAX_DATE_MS ? deleteAt : null };
  }
  function toMs(value) {
    if (value === null || value === void 0 || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function toInt(value) {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  }
  function normId(id) {
    if (id === null || id === void 0 || id === "") return null;
    return String(id).replace(/-/g, "").toLowerCase();
  }
  function readFacts(src) {
    const index = export10(src.LatestEpisodeIndex);
    const premiere = export10(src.SeasonPremiere);
    const span = export10(src.SeasonAddedSpan);
    const season = toInt(index.Season);
    const episode = toInt(index.Episode);
    const premiereSeason = toInt(premiere.Season);
    const aired = toMs(premiere.Aired);
    const first = toMs(span.First);
    const last = toMs(span.Last);
    const count = toInt(span.Count);
    const isLast = export10(src.EpisodeIndex).IsLast;
    return {
      scenes: export42(src.Scenes) ? src.Scenes : null,
      status: typeof src.Status === "string" && src.Status ? src.Status : null,
      latestAired: toMs(src.LatestEpisodeAired),
      isLast: typeof isLast === "boolean" ? isLast : null,
      latestIndex: season !== null && episode !== null ? { s: season, e: episode, isLast: index.IsLast === true } : null,
      seasonPremiere: premiereSeason !== null && aired !== null ? { s: premiereSeason, aired } : null,
      addedSpan: first !== null && last !== null && count !== null ? { first, last, count, coveredThrough: toInt(span.CoveredThrough) } : null
    };
  }
  function fromServerEntry(entry, itemId, inputs) {
    const type = export13(entry.Type);
    const tmdb = entry.TmdbId ? String(entry.TmdbId) : null;
    const index = export10(entry.EpisodeIndex);
    const stream = export10(entry.StreamData);
    return {
      type,
      tmdb,
      created: toMs(entry.DateCreated),
      premiere: toMs(entry.PremiereDate),
      latest: toMs(entry.LatestEpisodeAdded),
      ...readFacts(entry),
      season: toInt(index.Season ?? entry.SeasonNumber),
      episode: type === "Episode" ? toInt(index.Episode ?? entry.EpisodeNumber) : null,
      episodeEnd: type === "Episode" ? toInt(index.EpisodeEnd) : null,
      seriesId: type === "Series" ? normId(itemId) : normId(entry.SeriesId),
      // The cache records the series' TMDB id on its seasons and episodes,
      // so a missing one means the series has none.
      seriesTmdb: type === "Series" ? tmdb : entry.SeriesTmdbId ? String(entry.SeriesTmdbId) : null,
      leaving: readLeaving(entry.Leaving),
      probed: probedOf(stream.Streams, stream.Sources),
      media: mediaKeyOf(stream.Streams, stream.Sources, inputs),
      versions: versionIds(stream.Sources),
      // The cache keeps the file name in ItemPath only when no source names it.
      strm: isStrm([stream.ItemPath, ...sourcePaths(stream.Sources)])
    };
  }
  function fromItem(item, inputs) {
    const type = export13(item.Type);
    const index = export10(item.EpisodeIndex);
    const tmdbRaw = export10(item.ProviderIds).Tmdb || item.TmdbId;
    const tmdb = tmdbRaw ? String(tmdbRaw) : null;
    return {
      type,
      tmdb,
      created: toMs(item.DateCreated),
      premiere: toMs(item.PremiereDate),
      latest: toMs(item.LatestEpisodeAdded),
      ...readFacts(item),
      season: type === "Episode" ? toInt(index.Season ?? item.ParentIndexNumber) : type === "Season" ? toInt(item.IndexNumber) : null,
      episode: type === "Episode" ? toInt(index.Episode ?? item.IndexNumber) : null,
      episodeEnd: type === "Episode" ? toInt(index.EpisodeEnd ?? item.IndexNumberEnd) : null,
      seriesId: type === "Series" ? normId(item.Id) : normId(item.SeriesId),
      // A season/episode item does not say whether its series has a TMDB
      // id; the server answers only for those that do.
      seriesTmdb: type === "Series" ? tmdb : void 0,
      leaving: readLeaving(item.Leaving),
      probed: probedOf(item.MediaStreams, item.MediaSources),
      media: mediaKeyOf(item.MediaStreams, item.MediaSources, inputs),
      versions: versionIds(item.MediaSources),
      strm: isStrm([item.Path, ...sourcePaths(item.MediaSources)])
    };
  }
  function probedOf(streams, sources) {
    if (!Array.isArray(streams)) return null;
    const first = Array.isArray(sources) ? export10(sources[0]).Id : null;
    const all = export11(streams);
    const ofFirst = first && all.some((stream) => stream.SourceId) ? all.filter((stream) => stream.SourceId === first) : all;
    return ofFirst.some((stream) => stream.Type === "Video");
  }
  function mediaKeyOf(streams, sources, inputs) {
    const parts = [];
    const list = (Array.isArray(sources) ? sources : []).map(export10);
    const revised = list.length > 0 && list.every((source) => typeof source.Revision === "string" && source.Revision);
    for (const source of list) {
      parts.push(revised ? `${String(source.Id || "")}:${String(source.Path || "")}:${String(source.Revision)}` : inputs.source.map((field) => source[field] ?? "").join(","));
    }
    for (const stream of revised || !Array.isArray(streams) ? [] : streams.map(export10)) {
      parts.push([stream.SourceId, ...inputs.stream.map((field) => stream[field])].map((v) => v ?? "").join(","));
    }
    let hash = 2166136261;
    for (const char of parts.join("|")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return hash.toString(36);
  }
  function versionIds(sources) {
    return export11(sources).map((source) => source.Id).filter((id) => typeof id === "string" && !!id);
  }
  function sourcePaths(sources) {
    return Array.isArray(sources) ? sources.map((source) => export10(source).Path) : [];
  }
  function isStrm(paths) {
    return paths.some((path) => typeof path === "string" && path.toLowerCase().endsWith(".strm"));
  }

  // client/src/features/media-tags/types/status/statustags.ts
  function createStatusTags(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: Status Tags:";
    const containerClass = "status-overlay-container";
    const tagClass = "status-tag";
    const vocabulary = JE.statusVocabulary;
    const badgeDefinitions = vocabulary.badges;
    const DAY_MS = vocabulary.thresholds.dayMs;
    const CACHE_FRESH_MS = 60 * 60 * 1e3;
    const CACHE_ENTRY_VERSION = 6;
    const TRENDING_TTL_MS = 30 * 60 * 1e3;
    const TRENDING_RETRY_MS = 5 * 60 * 1e3;
    const SERIES_TTL_MS = 60 * 60 * 1e3;
    const SERIES_RETRY_MS = 5 * 60 * 1e3;
    const SERIES_BATCH = 50;
    const SERIES_FLUSH_MS = 30;
    const PARENT_FACTS_BATCH = 200;
    const AIRS_WITHIN_DAYS = vocabulary.thresholds.airsWithinDays;
    const WEEKDAY_WITHIN_DAYS = vocabulary.thresholds.weekdayWithinDays;
    const RETURN_GAP_DAYS = vocabulary.thresholds.returnGapDays;
    const RETURNS_WITHIN_DAYS = vocabulary.thresholds.returnsWithinDays;
    const RANK_TOKEN = "";
    const COMPACT_LABEL_KEYS = Object.fromEntries(Object.entries(badgeDefinitions).flatMap(([key, badge]) => badge.compact ? [[key, badge.compact]] : []));
    const TMDB_ENDED = /* @__PURE__ */ new Set(["Ended", "Canceled"]);
    const BADGE_SCOPES = {
      trending: { userKey: "statusTagsTrending", pluginKey: "StatusTagsTrending", fallback: true },
      newRelease: { userKey: "statusTagsNewRelease", pluginKey: "StatusTagsNewRelease", fallback: true },
      justAdded: { userKey: "statusTagsJustAdded", pluginKey: "StatusTagsJustAdded", fallback: true },
      schedule: { userKey: "statusTagsSchedule", pluginKey: "StatusTagsSchedule", fallback: true },
      milestones: { userKey: "statusTagsMilestones", pluginKey: "StatusTagsMilestones", fallback: true },
      scenes: { userKey: "statusTagsScenes", pluginKey: "StatusTagsScenes", fallback: false },
      seriesStatus: { userKey: "statusTagsSeriesStatus", pluginKey: "StatusTagsSeriesStatus", fallback: false },
      leaving: { userKey: "statusTagsLeaving", pluginKey: "StatusTagsLeaving", fallback: false },
      directPlay: { userKey: "statusTagsDirectPlay", pluginKey: "StatusTagsDirectPlay", fallback: false }
    };
    const LEAVING_TYPES = /* @__PURE__ */ new Set(["Movie", "Series", "Season", "Episode"]);
    const PLAYABLE_TYPES = /* @__PURE__ */ new Set(["Movie", "Episode", "Video", "MusicVideo"]);
    const trending = { data: null, fetchedAt: 0, retryAt: 0, promise: null };
    const seriesInfo = /* @__PURE__ */ new Map();
    const seriesQueue = /* @__PURE__ */ new Set();
    const parentFactsQueue = /* @__PURE__ */ new Set();
    const parentFactsLoads = /* @__PURE__ */ new Set();
    let parentFactsTimer = null;
    let parentFactsLoading = false;
    let seriesTimer = null;
    let seriesRetryTimer = null;
    let seriesEpoch = 0;
    let midnightTimer = null;
    let renderedDay = null;
    let calendarEventsRegistered = false;
    let statusActive = false;
    let seriesObserver = null;
    let intersectingCards = /* @__PURE__ */ new WeakSet();
    const observedSeriesCards = /* @__PURE__ */ new Set();
    let seriesTargetObserver = null;
    const liveCards = /* @__PURE__ */ new WeakMap();
    let trackRev = 0;
    let staleBelowRev = 0;
    const replacedAt = /* @__PURE__ */ new Map();
    const REPLACED_AT_CAP = 2e3;
    const LIVE_ATTR = "jeStatusLive";
    const LIVE_SELECTOR = "[data-je-status-live]";
    function isScopeEnabled(scope) {
      const u = JE.currentSettings?.[scope.userKey];
      if (typeof u === "boolean") return u;
      const a = JE.pluginConfig?.[scope.pluginKey];
      return typeof a === "boolean" ? a : scope.fallback;
    }
    function isTrendingWanted() {
      return JE.pluginConfig?.StatusTagsEnabled === true && JE.pluginConfig?.StatusTagsTrending !== false && isScopeEnabled(BADGE_SCOPES.trending);
    }
    function isLeavingWanted() {
      return JE.pluginConfig?.LeavingSoonAvailable === true && isScopeEnabled(BADGE_SCOPES.leaving);
    }
    function wantsDirectPlay(data) {
      return !!JE.tagDirectPlay && PLAYABLE_TYPES.has(data.type || "") && data.probed !== false && !data.strm && isScopeEnabled(BADGE_SCOPES.directPlay);
    }
    function wantsSeriesFacts(data) {
      if (JE.pluginConfig?.StatusTagsEnabled !== true || JE.pluginConfig?.TmdbEnabled !== true) return false;
      if (!data.seriesId || data.seriesTmdb === null) return false;
      if (data.type === "Series") {
        return isScopeEnabled(BADGE_SCOPES.schedule) || isScopeEnabled(BADGE_SCOPES.milestones) || isScopeEnabled(BADGE_SCOPES.seriesStatus);
      }
      return (data.type === "Season" || data.type === "Episode") && isScopeEnabled(BADGE_SCOPES.milestones);
    }
    function label(key, params) {
      return JE.t(key, params);
    }
    function windowMs(pluginKey, fallback) {
      const raw = parseInt(String(JE.pluginConfig?.[pluginKey]), 10);
      const days = Number.isFinite(raw) ? Math.min(vocabulary.thresholds.maxWindowDays, Math.max(vocabulary.thresholds.minWindowDays, raw)) : fallback;
      return days * DAY_MS;
    }
    function mediaInputs() {
      return JE.tagDirectPlay?.INPUTS || { source: ["Id", "Path"], stream: [] };
    }
    function versionOf(data, itemId) {
      const picked = JE.selectedMediaSource?.(itemId) || "";
      return picked && (data.versions || []).includes(picked) ? picked : "";
    }
    function isWithin(ms, now, windowLength) {
      return ms !== null && ms <= now + DAY_MS && now - ms <= windowLength;
    }
    function localDay(ms) {
      const d = new Date(ms);
      return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
    }
    function airDay(date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
      return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS) : null;
    }
    function dateLocale() {
      let uiLanguage = null;
      try {
        const userId = JE.session?.getUserId?.();
        if (userId) uiLanguage = localStorage.getItem(`${userId}-language`);
      } catch {
      }
      const candidates = [uiLanguage, JE.currentSettings?.displayLanguage, document.documentElement?.getAttribute("lang")];
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || !candidate) continue;
        try {
          if (Intl.DateTimeFormat.supportedLocalesOf(candidate).length > 0) return candidate;
        } catch {
        }
      }
      return void 0;
    }
    JE.getStatusDateContext = function() {
      const options = new Intl.DateTimeFormat(dateLocale()).resolvedOptions();
      return { locale: options.locale, timeZone: options.timeZone };
    };
    function formatAirDay(day, daysAhead) {
      if (daysAhead === 1) return label("calendar_tomorrow");
      const date = new Date(day * DAY_MS);
      const options = daysAhead <= WEEKDAY_WITHIN_DAYS ? { weekday: "long", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" };
      try {
        return new Intl.DateTimeFormat(dateLocale(), options).format(date);
      } catch {
        return new Intl.DateTimeFormat("en", options).format(date);
      }
    }
    function trendingRank(data) {
      const list = trending.data;
      if (!list || !data.tmdb) return null;
      const map = data.type === "Movie" ? list.movies : data.type === "Series" ? list.series : null;
      const rank = map ? export9(map, data.tmdb) : null;
      return typeof rank === "number" && rank > 0 ? rank : null;
    }
    function seriesFactsFor(data) {
      return data.seriesId ? seriesInfo.get(data.seriesId)?.facts ?? null : null;
    }
    function seasonComplete(data, facts) {
      const season = data.season ?? data.latestIndex?.s ?? null;
      const expected = season !== null ? toInt(facts?.seasonEpisodes?.[season]) : null;
      if (season === null || !facts || !expected || expected <= 0) return false;
      if (facts.next && facts.next.season !== null && facts.next.season <= season) return false;
      const last = facts.last;
      if (!last || last.season === null || last.season < season || last.season === season && (last.episode ?? 0) < expected) return false;
      return (data.addedSpan?.coveredThrough ?? 0) >= expected;
    }
    function lastAiredEndsSeason(facts, isLast) {
      const last = facts.last;
      if (!last) return false;
      if (last.type) return last.type === "finale";
      return isLast === true && (!facts.next || facts.next.season !== null && last.season !== null && facts.next.season > last.season);
    }
    function badgeDefinition(key) {
      const definition = export9(badgeDefinitions, key);
      if (!definition) throw new Error(`Unknown status badge ${key}`);
      return definition;
    }
    function makeBadge(key, params) {
      const definition = badgeDefinition(key);
      const badge = { kind: definition.kind, key, label: label(definition.label, params) };
      const compact = export9(COMPACT_LABEL_KEYS, key);
      if (compact) badge.compact = label(compact, params);
      return badge;
    }
    function leavingBadge(leaving, now) {
      if (leaving.deleteAt === null) return makeBadge("leaving_soon");
      const days = localDay(leaving.deleteAt) - localDay(now);
      if (days < 0) return makeBadge("leaving_soon");
      if (days === 0) return makeBadge("leaving_today");
      if (days === 1) return makeBadge("leaving_tomorrow");
      return makeBadge("leaving_days", { days });
    }
    function directPlayBadge(data, itemId) {
      const player = JE.tagDirectPlay;
      if (!player || !itemId || !wantsDirectPlay(data)) return null;
      const result = player.peek(String(itemId), data.media || "", versionOf(data, String(itemId)));
      if (!result || result.directPlay) return null;
      const badge = makeBadge(result.remux ? "direct_play_remux" : "direct_play_transcode");
      badge.title = player.describe(result, badge.label);
      return badge;
    }
    function finalRegularEpisode(data, facts) {
      if (!facts) return null;
      const seriesId = data.seriesId;
      const parent = seriesId ? JE.tagPipeline?.peekItemFacts?.(seriesId) || JE.tagPipeline?.peekServerEntry?.(seriesId) : null;
      const aggregate = parent ? readFacts(parent) : data.type === "Series" ? data : readFacts({});
      const counts = facts.seasonEpisodes || {};
      const lastSeason = Math.max(0, ...Object.keys(counts).map(Number).filter(Number.isFinite));
      const regular = (local) => {
        if (!local.latestIndex || !(local.latestIndex.s > 0) || local.latestAired === null) return null;
        if (local.latestIndex.s !== lastSeason || toInt(counts[lastSeason]) !== local.latestIndex.e) return null;
        const date = new Date(local.latestAired);
        const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
        return { date: day, season: local.latestIndex.s, episode: local.latestIndex.e, type: null };
      };
      const regularSeason = (episode) => (episode?.season ?? 0) > 0 ? episode : null;
      return regularSeason(facts.last) || regularSeason(facts.regular) || regular(aggregate) || regular(readFacts((seriesId && data.season !== null ? JE.tagPipeline?.peekSeasonFacts?.(seriesId, data.season) : null) || {})) || regular(data);
    }
    function pickBadge(data, itemId) {
      const normalizedId = normId(itemId);
      const current = normalizedId ? JE.tagPipeline?.peekItemFacts?.(normalizedId) : null;
      if (current) {
        Object.assign(data, readFacts(current), { latest: toMs(current.LatestEpisodeAdded) });
      }
      const now = Date.now();
      const today = localDay(now);
      const justAddedMs = windowMs("StatusTagsJustAddedDays", vocabulary.thresholds.justAddedDays);
      const newReleaseMs = windowMs("StatusTagsNewReleaseDays", vocabulary.thresholds.newReleaseDays);
      const showNew = isScopeEnabled(BADGE_SCOPES.newRelease);
      const showAdded = isScopeEnabled(BADGE_SCOPES.justAdded);
      const showSchedule = isScopeEnabled(BADGE_SCOPES.schedule);
      const showMilestones = isScopeEnabled(BADGE_SCOPES.milestones);
      const showStatus = isScopeEnabled(BADGE_SCOPES.seriesStatus);
      const facts = wantsSeriesFacts(data) ? seriesFactsFor(data) : null;
      if (data.leaving && LEAVING_TYPES.has(data.type || "") && isLeavingWanted()) return leavingBadge(data.leaving, now);
      const finalRegular = finalRegularEpisode(data, facts);
      const finalDay = airDay(finalRegular?.date);
      const finalAiredRecently = finalDay !== null && finalDay <= today && (today - finalDay) * DAY_MS <= newReleaseMs;
      const premiereDay = (ms) => ms === null || ms === void 0 ? null : Math.floor(ms / DAY_MS);
      const airedWithin = (ms, windowMs2) => {
        const day = premiereDay(ms);
        return day !== null && day <= today && (today - day) * DAY_MS <= windowMs2;
      };
      const isNewRelease = airedWithin(data.premiere, newReleaseMs);
      const releaseDay = premiereDay(data.premiere);
      const comingSoon = releaseDay !== null && releaseDay > today;
      const addedRecently = isWithin(data.created, now, justAddedMs);
      const newEpisode = isWithin(data.latest, now, justAddedMs) && data.created !== null && now - data.created > justAddedMs;
      const nextDay = airDay(facts?.next?.date);
      const lastDay = airDay(facts?.last?.date);
      const daysToNext = nextDay === null ? null : nextDay - today;
      const lastAiredRecently = lastDay !== null && lastDay <= today && (today - lastDay) * DAY_MS <= newReleaseMs;
      if ((data.type === "Movie" || data.type === "Series") && isTrendingWanted()) {
        const rank = trendingRank(data);
        if (rank !== null) {
          const key = trending.data?.source === "seerr-week" ? "trending_week" : "trending_today";
          return { kind: "trending", key, label: label(badgeDefinition(key).label, { rank: RANK_TOKEN }), rank };
        }
      }
      switch (data.type) {
        case "Movie":
          if (showSchedule && comingSoon) return makeBadge("coming_soon");
          if (showNew && isNewRelease) return makeBadge("new_movie");
          break;
        case "Series": {
          if (showSchedule && daysToNext === 0) return makeBadge("airing_today");
          if (showMilestones && finalRegular && TMDB_ENDED.has(facts?.status || "") && finalAiredRecently && data.latestIndex && data.latestIndex.s === finalRegular.season && data.latestIndex.e === finalRegular.episode) {
            return makeBadge("series_finale");
          }
          const sp = data.seasonPremiere;
          if (showMilestones && sp && sp.s > 1 && airedWithin(sp.aired, newReleaseMs)) return makeBadge("new_season");
          if (showSchedule && nextDay !== null && daysToNext !== null && daysToNext >= 1 && daysToNext <= AIRS_WITHIN_DAYS) {
            return makeBadge("airs_date", { date: formatAirDay(nextDay, daysToNext) });
          }
          if (showSchedule && nextDay !== null && daysToNext !== null && daysToNext >= 1 && daysToNext <= RETURNS_WITHIN_DAYS && lastDay !== null && nextDay - lastDay > RETURN_GAP_DAYS) {
            return makeBadge("returns_date", { date: formatAirDay(nextDay, daysToNext) });
          }
          if (showNew && newEpisode) return makeBadge("new_episode");
          if (showSchedule && comingSoon) return makeBadge("coming_soon");
          if (showNew && isNewRelease) return makeBadge("new_series");
          break;
        }
        case "Season": {
          const span = data.addedSpan;
          if (showMilestones && span && span.count > 0 && span.first <= span.last && isWithin(span.first, now, justAddedMs) && isWithin(span.last, now, justAddedMs) && seasonComplete(data, facts)) {
            return makeBadge("complete_season");
          }
          if (showMilestones && data.seasonPremiere && airedWithin(data.seasonPremiere.aired, newReleaseMs)) {
            return makeBadge("season_premiere");
          }
          const season = data.season ?? data.seasonPremiere?.s ?? data.latestIndex?.s ?? null;
          if (showMilestones && facts?.last && lastAiredRecently && season !== null && facts.last.season === season && data.latestIndex && data.latestIndex.s === season && data.latestIndex.e === facts.last.episode && lastAiredEndsSeason(facts, data.latestIndex.isLast)) {
            return makeBadge("season_finale");
          }
          if (showNew && newEpisode) return makeBadge("new_episode");
          break;
        }
        case "Episode": {
          const airedRecently = releaseDay !== null && releaseDay <= today;
          if (showMilestones && airedRecently && data.episode === 1 && data.season !== null && data.season > 0 && airedWithin(data.premiere, justAddedMs)) {
            return makeBadge("season_premiere");
          }
          const holds = (number) => data.episode !== null && typeof number === "number" && number >= data.episode && number <= (data.episodeEnd ?? data.episode);
          if (showMilestones && airedRecently && finalRegular && finalAiredRecently && data.season === finalRegular.season && holds(finalRegular.episode) && TMDB_ENDED.has(facts?.status || "")) return makeBadge("series_finale");
          if (showMilestones && airedRecently && facts?.last && lastAiredRecently && data.season === facts.last.season && holds(facts.last.episode)) {
            if (lastAiredEndsSeason(facts, data.isLast)) return makeBadge("season_finale");
          }
          if (showNew && (airedWithin(data.premiere, justAddedMs) || addedRecently)) return makeBadge("new_episode");
          break;
        }
        case "BoxSet":
        case "Video":
          break;
        default:
          return null;
      }
      if (showAdded && addedRecently) return makeBadge("just_added");
      if (data.type === "Movie" && isScopeEnabled(BADGE_SCOPES.scenes)) {
        if (data.scenes?.PostCredits === true) return makeBadge("post_credits");
        if (data.scenes?.MidCredits === true) return makeBadge("mid_credits");
      }
      if (data.type === "Series" && showStatus) return seriesStatusBadge(data, facts);
      return directPlayBadge(data, itemId);
    }
    function seriesStatusBadge(data, facts) {
      if (data.status === "Continuing") return makeBadge("returning");
      if (data.status === "Ended") return makeBadge(facts?.status === "Canceled" ? "cancelled" : "ended");
      switch (facts?.status || "") {
        case "Returning Series":
          return makeBadge("returning");
        case "Ended":
          return makeBadge("ended");
        case "Canceled":
          return makeBadge("cancelled");
        default:
          break;
      }
      return null;
    }
    function getCachedEntry(ctx, itemId) {
      const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
      if (!export42(entry) || entry.v !== CACHE_ENTRY_VERSION) return null;
      if (typeof entry.timestamp !== "number" || Date.now() - entry.timestamp > CACHE_FRESH_MS) return null;
      return {
        fetchedAt: entry.timestamp,
        type: export13(entry.t),
        tmdb: export13(entry.m),
        created: export2(entry.c),
        premiere: export2(entry.p),
        latest: export2(entry.l),
        status: export13(entry.st),
        scenes: export42(entry.sc) ? entry.sc : null,
        latestAired: export2(entry.la),
        isLast: typeof entry.il === "boolean" ? entry.il : null,
        latestIndex: Array.isArray(entry.li) ? { s: Number(entry.li[0]), e: Number(entry.li[1]), isLast: entry.li[2] === true } : null,
        seasonPremiere: Array.isArray(entry.sp) ? { s: Number(entry.sp[0]), aired: Number(entry.sp[1]) } : null,
        addedSpan: Array.isArray(entry.as) ? { first: Number(entry.as[0]), last: Number(entry.as[1]), count: Number(entry.as[2]), coveredThrough: export2(entry.as[3]) } : null,
        season: export2(entry.sn),
        episode: export2(entry.en),
        episodeEnd: export2(entry.ee),
        media: export13(entry.mk) ?? "",
        // Whether a direct-play lookup may probe this item, and which versions it can ask about.
        probed: typeof entry.pr === "boolean" ? entry.pr : null,
        strm: entry.sm === true,
        versions: export12(entry.vs),
        seriesId: export13(entry.si),
        // Stored only when known (null and undefined both mean "unknown" here).
        seriesTmdb: export13(entry.stm) ?? (entry.t === "Series" ? null : void 0),
        leaving: Array.isArray(entry.lv) ? readLeaving({ DeleteAt: typeof entry.lv[0] === "number" ? entry.lv[0] : null }) : null
      };
    }
    function setCachedEntry(ctx, itemId, data) {
      const entry = { v: CACHE_ENTRY_VERSION, t: data.type, timestamp: data.fetchedAt ?? Date.now() };
      if (data.tmdb) entry.m = data.tmdb;
      if (data.created !== null) entry.c = data.created;
      if (data.premiere !== null) entry.p = data.premiere;
      if (data.latest !== null) entry.l = data.latest;
      if (data.status) entry.st = data.status;
      if (data.scenes) entry.sc = data.scenes;
      if (data.latestAired !== null) entry.la = data.latestAired;
      if (data.isLast !== null) entry.il = data.isLast;
      if (data.latestIndex) entry.li = [data.latestIndex.s, data.latestIndex.e, data.latestIndex.isLast];
      if (data.seasonPremiere) entry.sp = [data.seasonPremiere.s, data.seasonPremiere.aired];
      if (data.addedSpan) entry.as = [data.addedSpan.first, data.addedSpan.last, data.addedSpan.count, data.addedSpan.coveredThrough];
      if (data.season !== null) entry.sn = data.season;
      if (data.episode !== null) entry.en = data.episode;
      if (data.episodeEnd != null) entry.ee = data.episodeEnd;
      if (data.media) entry.mk = data.media;
      if (typeof data.probed === "boolean") entry.pr = data.probed;
      if (data.strm) entry.sm = true;
      if (data.versions?.length) entry.vs = data.versions;
      if (data.seriesId) entry.si = data.seriesId;
      if (data.seriesTmdb) entry.stm = data.seriesTmdb;
      if (data.leaving) entry.lv = [data.leaving.deleteAt];
      ctx.setPersistent(itemId, entry);
      ctx.hot?.set(itemId, entry);
    }
    function applyStatusTag(ctx, el, badge) {
      if (!badge) return;
      ctx.removeExistingOverlay(el);
      const container = document.createElement("div");
      container.className = containerClass;
      const tag = document.createElement("div");
      tag.className = `${tagClass} ${tagClass}--${badge.kind}`;
      const status = badgeDefinition(badge.key).style;
      tag.dataset.jeStatus = status;
      if (badge.compact) tag.dataset.jeCompact = badge.compact;
      if (badge.title) {
        tag.title = badge.title;
        tag.setAttribute("aria-label", badge.title);
        tag.dataset.jeDp = "1";
      }
      if (badge.kind === "trending") {
        const [before = "", after = ""] = badge.label.split(RANK_TOKEN);
        const hash = before.endsWith("#") ? "#" : "";
        const rank = document.createElement("span");
        rank.className = `${tagClass}-rank`;
        rank.textContent = `${hash}${badge.rank}`;
        tag.append(before.slice(0, before.length - hash.length), rank, after);
      } else {
        tag.textContent = badge.label;
      }
      container.appendChild(tag);
      ctx.commitOverlay(el, container);
    }
    function badgeKey(badge) {
      return `${localDay(Date.now())}|${badge ? `${badge.kind}|${badge.key}|${badge.label}|${badge.rank ?? ""}|${badge.title ?? ""}` : ""}`;
    }
    function trendingKey(list) {
      if (!list || !list.source) return "";
      return JSON.stringify([list.source, list.movies, list.series]);
    }
    function renderData(ctx, el, data, itemId) {
      activateStatus(ctx);
      ensureTrending(ctx);
      const readsSeries = wantsSeriesFacts(data);
      const badge = pickBadge(data, itemId);
      const previous = liveCards.get(el);
      if (!readsSeries || previous && (previous.id !== normId(itemId) || previous.domId !== cardIdentity(el))) {
        unobserveSeriesCard(el);
      }
      liveCards.set(el, { domId: cardIdentity(el), id: normId(itemId), data, shown: badgeKey(badge), rev: trackRev });
      el.dataset[LIVE_ATTR] = "1";
      if (readsSeries) observeSeriesCard(ctx, el);
      if (wantsDirectPlay(data) && itemId && (!badge || badge.kind === "playback")) JE.tagDirectPlay?.track(el, String(itemId), onDirectPlayAnswer, data.media || "", versionOf(data, String(itemId)));
      else JE.tagDirectPlay?.untrack(el);
      applyStatusTag(ctx, el, badge);
    }
    function observeSeriesCard(ctx, el) {
      if (!seriesObserver && typeof IntersectionObserver !== "undefined") {
        const observer = new IntersectionObserver((entries) => {
          if (seriesObserver !== observer) return;
          for (const { target, isIntersecting } of entries) {
            if (!(target instanceof HTMLElement)) continue;
            const host = target;
            if (!observedSeriesCards.has(host)) continue;
            const card2 = liveCards.get(host);
            if (!host.isConnected || card2?.domId !== cardIdentity(host)) {
              forgetSeriesCard(host);
              continue;
            }
            if (isIntersecting) intersectingCards.add(host);
            else intersectingCards.delete(host);
            if (isIntersecting && eligibleSeriesCard(host, card2)) {
              requestSeries(ctx, card2.data.seriesId);
              armSeriesRetry(ctx);
            }
          }
        });
        seriesObserver = observer;
        seriesTargetObserver = new MutationObserver(() => {
          for (const host of observedSeriesCards) {
            const card2 = liveCards.get(host);
            if (!host.isConnected || card2?.domId !== cardIdentity(host)) forgetSeriesCard(host);
          }
        });
        seriesTargetObserver.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-id", "data-itemid"]
        });
      }
      if (seriesObserver && !observedSeriesCards.has(el)) {
        observedSeriesCards.add(el);
        seriesObserver.observe(el);
      }
      const card = liveCards.get(el);
      if (eligibleSeriesCard(el, card)) requestSeries(ctx, card.data.seriesId);
    }
    function cardIdentity(el) {
      const card = el.closest("[data-id], [data-itemid]");
      return card?.getAttribute("data-id") || card?.getAttribute("data-itemid") || null;
    }
    function unobserveSeriesCard(el) {
      seriesObserver?.unobserve(el);
      observedSeriesCards.delete(el);
      intersectingCards.delete(el);
    }
    function forgetSeriesCard(el) {
      unobserveSeriesCard(el);
      liveCards.delete(el);
      delete el.dataset[LIVE_ATTR];
    }
    function releaseSeriesObservers() {
      for (const el of observedSeriesCards) forgetSeriesCard(el);
      seriesObserver?.disconnect();
      seriesObserver = null;
      seriesTargetObserver?.disconnect();
      seriesTargetObserver = null;
      intersectingCards = /* @__PURE__ */ new WeakSet();
    }
    function eligibleSeriesCard(el, card) {
      return el.isConnected && intersectingCards.has(el) && !!card && isCurrentRecord(card) && card.domId === cardIdentity(el) && !el.closest(".je-hidden") && wantsSeriesFacts(card.data);
    }
    function hasVisibleSeries(id) {
      return [...document.querySelectorAll(LIVE_SELECTOR)].some((el) => {
        const card = liveCards.get(el);
        return card?.data.seriesId === id && eligibleSeriesCard(el, card);
      });
    }
    function isCurrentRecord(card) {
      if (card.rev < staleBelowRev) return false;
      if (card.id === null) return true;
      const replaced = replacedAt.get(card.id);
      return replaced === void 0 || replaced <= card.rev;
    }
    function onCacheReplaced(ctx, updatedIds, info) {
      trackRev++;
      if (updatedIds) {
        for (const id of updatedIds) {
          ctx.deletePersistent(String(id));
          ctx.hot?.delete(String(id));
        }
        if (replacedAt.size + updatedIds.length > REPLACED_AT_CAP) {
          staleBelowRev = trackRev;
          replacedAt.clear();
          return;
        }
        for (const id of updatedIds) replacedAt.set(normId(id) ?? "", trackRev);
        return;
      }
      staleBelowRev = trackRev;
      replacedAt.clear();
      seriesEpoch++;
      seriesInfo.clear();
      seriesQueue.clear();
      parentFactsQueue.clear();
      parentFactsLoads.clear();
      ctx.clearPersistent();
      ctx.hot?.clear();
      if (info?.replaced && JE.currentSettings?.statusTagsEnabled) reinitializeStatusTags();
    }
    function applyLivePass(ctx) {
      if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
      renderedDay = localDay(Date.now());
      const hosts = [];
      document.querySelectorAll(LIVE_SELECTOR).forEach((el) => {
        const card = liveCards.get(el);
        if (!card || ctx.shouldIgnore(el) || el.closest(".je-hidden")) return;
        if (!isCurrentRecord(card) || card.domId !== cardIdentity(el)) {
          forgetSeriesCard(el);
          return;
        }
        const badge = pickBadge(card.data, card.id);
        const key = badgeKey(badge);
        if (key === card.shown) return;
        card.shown = key;
        if (badge) applyStatusTag(ctx, el, badge);
        else ctx.removeExistingOverlay(el);
        hosts.push(el);
      });
      if (hosts.length > 0 && !JE.core.tagLayout) JE.core.tagRenderer.applyCornerStacking(hosts);
    }
    function ensureTrending(ctx) {
      if (!isTrendingWanted() || trending.promise) return;
      const now = Date.now();
      if (now < trending.retryAt) return;
      if (trending.data?.source && now - trending.fetchedAt < TRENDING_TTL_MS) return;
      if (!export1()) return;
      const previous = trendingKey(trending.data);
      trending.promise = (async () => {
        try {
          const response = export10(await export0().ajax({
            type: "GET",
            url: export0().getUrl("JellyfinEnhanced/status-tags/trending"),
            dataType: "json"
          }));
          const movies = export10(response.movies);
          const series = export10(response.series);
          trending.data = { source: typeof response.source === "string" ? response.source : null, movies, series };
          trending.fetchedAt = Date.now();
          trending.retryAt = trending.data.source ? 0 : trending.fetchedAt + TRENDING_RETRY_MS;
        } catch (e) {
          console.warn(`${logPrefix} Could not load the trending list; showing date badges only.`, e);
          trending.data = trending.data || { source: null, movies: {}, series: {} };
          trending.retryAt = Date.now() + TRENDING_RETRY_MS;
        } finally {
          trending.promise = null;
        }
        if (trendingKey(trending.data) !== previous) applyLivePass(ctx);
      })();
    }
    function requestSeries(ctx, seriesId) {
      if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
      const known = seriesInfo.get(seriesId);
      if (known && (known.loading || Date.now() < known.expires)) {
        if (!known.loading && TMDB_ENDED.has(known.facts?.status ?? "") && JE.tagPipeline?.lookupItemFacts && !JE.tagPipeline.peekItemFacts(seriesId) && !parentFactsLoads.has(seriesId)) {
          parentFactsLoads.add(seriesId);
          parentFactsQueue.add(seriesId);
          scheduleParentFacts(ctx);
        }
        return;
      }
      if (seriesQueue.has(seriesId) || !export1()) return;
      seriesInfo.set(seriesId, { facts: known?.facts ?? null, expires: known?.expires ?? 0, loading: true });
      seriesQueue.add(seriesId);
      if (!seriesTimer) seriesTimer = setTimeout(() => {
        flushSeries(ctx);
      }, SERIES_FLUSH_MS);
    }
    function scheduleParentFacts(ctx) {
      if (parentFactsLoading || parentFactsTimer !== null || !parentFactsQueue.size || !statusActive) return;
      parentFactsTimer = setTimeout(() => {
        flushParentFacts(ctx);
      }, SERIES_FLUSH_MS);
    }
    async function flushParentFacts(ctx) {
      parentFactsTimer = null;
      const epoch = seriesEpoch;
      parentFactsLoading = true;
      try {
        while (parentFactsQueue.size && statusActive && epoch === seriesEpoch) {
          const ids = [...parentFactsQueue].slice(0, PARENT_FACTS_BATCH);
          for (const id of ids) parentFactsQueue.delete(id);
          const visible = /* @__PURE__ */ new Set();
          for (const el of observedSeriesCards) {
            const card = liveCards.get(el);
            if (eligibleSeriesCard(el, card)) visible.add(card.data.seriesId);
          }
          const batch = ids.filter((id) => visible.has(id));
          if (batch.length) await JE.tagPipeline?.lookupItemFacts(batch);
          if (epoch !== seriesEpoch) return;
          for (const id of ids) parentFactsLoads.delete(id);
          if (batch.some((id) => JE.tagPipeline?.peekItemFacts(id))) applyLivePass(ctx);
        }
      } finally {
        parentFactsLoading = false;
        scheduleParentFacts(ctx);
      }
    }
    function readSeriesFacts(raw) {
      if (!export42(raw)) return null;
      const episode = (ep, withType) => export42(ep) && airDay(ep.date) !== null ? { date: String(ep.date), season: toInt(ep.season), episode: toInt(ep.episode), ...withType ? { type: typeof ep.type === "string" ? ep.type : null } : {} } : null;
      return {
        status: typeof raw.status === "string" ? raw.status : null,
        last: episode(raw.lastAired, true),
        regular: episode(raw.lastRegularAired, true),
        next: episode(raw.nextAired, false),
        seasonEpisodes: export42(raw.seasonEpisodes) ? raw.seasonEpisodes : null
      };
    }
    async function flushSeries(ctx) {
      seriesTimer = null;
      const epoch = seriesEpoch;
      const ids = [...seriesQueue];
      seriesQueue.clear();
      let changed = false;
      for (let i = 0; i < ids.length; i += SERIES_BATCH) {
        const batch = ids.slice(i, i + SERIES_BATCH).filter((id) => {
          if (hasVisibleSeries(id)) return true;
          const known = seriesInfo.get(id);
          if (known) known.loading = false;
          return false;
        });
        if (batch.length === 0) continue;
        for (const id of batch) {
          const known = seriesInfo.get(id);
          seriesInfo.set(id, { facts: known?.facts ?? null, expires: known?.expires ?? 0, loading: true });
        }
        let answer = null;
        let ok = false;
        try {
          answer = await export0().ajax({
            type: "GET",
            url: export0().getUrl("JellyfinEnhanced/status-tags/series", { ids: batch.join(",") }),
            dataType: "json"
          });
          ok = true;
        } catch (e) {
          console.warn(`${logPrefix} Could not load series schedules; showing library badges only.`, e);
        }
        if (epoch !== seriesEpoch) return;
        const byId = /* @__PURE__ */ new Map();
        for (const [key, value] of Object.entries(export10(answer))) byId.set(normId(key), value);
        const now = Date.now();
        for (const id of batch) {
          const previous = seriesInfo.get(id)?.facts ?? null;
          const failed = !ok || export10(byId.get(id)).retry === true;
          const facts = failed ? previous : readSeriesFacts(byId.get(id));
          seriesInfo.set(id, { facts, expires: now + (failed ? SERIES_RETRY_MS : SERIES_TTL_MS), retry: failed });
          if (JSON.stringify(previous) !== JSON.stringify(facts)) changed = true;
        }
        const endedIds = batch.filter((id) => TMDB_ENDED.has(seriesInfo.get(id)?.facts?.status ?? ""));
        if (endedIds.length) {
          if (JE.tagPipeline?.lookupItemFacts) await JE.tagPipeline.lookupItemFacts(endedIds);
          else await JE.tagPipeline?.lookupServerEntries?.(endedIds);
        }
        if (epoch !== seriesEpoch) return;
      }
      if (changed || renderedDay !== localDay(Date.now())) applyLivePass(ctx);
      armSeriesRetry(ctx);
    }
    function armSeriesRetry(ctx) {
      if (seriesRetryTimer) clearTimeout(seriesRetryTimer);
      seriesRetryTimer = null;
      if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
      const due = [...seriesInfo].filter(([id, value]) => value.retry && !value.loading && hasVisibleSeries(id)).map(([, value]) => value.expires);
      if (!due.length) return;
      seriesRetryTimer = setTimeout(() => {
        seriesRetryTimer = null;
        for (const [id, value] of seriesInfo) {
          if (value.retry && Date.now() >= value.expires && hasVisibleSeries(id)) requestSeries(ctx, id);
        }
      }, Math.max(0, Math.min(...due) - Date.now()));
    }
    function armMidnight(ctx) {
      if (midnightTimer) clearTimeout(midnightTimer);
      midnightTimer = null;
      if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
      const now = Date.now();
      const next = new Date(now);
      next.setHours(24, 0, 0, 0);
      midnightTimer = setTimeout(() => {
        midnightTimer = null;
        applyLivePass(ctx);
        armMidnight(ctx);
      }, Math.max(1, next.getTime() - now));
    }
    function refreshCalendar(ctx) {
      if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
      applyLivePass(ctx);
      for (const [id] of seriesInfo) if (hasVisibleSeries(id)) requestSeries(ctx, id);
      armMidnight(ctx);
      armSeriesRetry(ctx);
    }
    function stopStatus() {
      statusActive = false;
      seriesEpoch++;
      for (const timer of [midnightTimer, seriesTimer, seriesRetryTimer, parentFactsTimer]) {
        if (timer !== null) clearTimeout(timer);
      }
      midnightTimer = seriesTimer = seriesRetryTimer = parentFactsTimer = null;
      seriesQueue.clear();
      parentFactsQueue.clear();
      parentFactsLoads.clear();
      for (const value of seriesInfo.values()) value.loading = false;
      releaseSeriesObservers();
      document.querySelectorAll(LIVE_SELECTOR).forEach((el) => {
        liveCards.delete(el);
        delete el.dataset[LIVE_ATTR];
      });
      renderedDay = null;
    }
    function activateStatus(ctx) {
      if (statusActive || !JE.currentSettings?.statusTagsEnabled) return;
      statusActive = true;
      armMidnight(ctx);
    }
    function onDirectPlayAnswer() {
      if (statusCtx) applyLivePass(statusCtx);
    }
    const spec = {
      logPrefix,
      settingKey: "statusTagsEnabled",
      containerClass,
      taggedAttr: "jeStatusTagged",
      styleId: "jellyfin-enhanced-status-tags-css",
      position: { userKey: "statusTagsPosition", pluginKey: "StatusTagsPosition", fallback: "top-right" },
      cache: {
        key: "JellyfinEnhanced-statusTagsCache",
        legacyPrefix: "statusTagsCache",
        hotBucket: "status",
        pruneOnSave: true,
        saveOnUnload: false
      },
      buildCss() {
        return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25em;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(10px * var(--je-tag-scale, 1));
                    background-color: rgba(15, 15, 15, 0.72);
                    -webkit-backdrop-filter: blur(6px);
                    backdrop-filter: blur(6px);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    border-radius: 6px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 600;
                    line-height: 1.15;
                    letter-spacing: 0.01em;
                    text-transform: none;
                    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                    pointer-events: none;
                }
                .${tagClass}--trending .${tagClass}-rank { color: #ffd166; }
                /* Only the direct-play warning takes hover, for its tooltip. */
                .${tagClass}[data-je-dp] { pointer-events: auto; cursor: help; }

                /* Card-width sizing, matching the rating tag rules in tag-pipeline.js */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(5px, 5cqw, 10px) * var(--je-tag-scale, 1));
                        border-radius: clamp(4px, 3cqw, 6px);
                    }
                }

                .layout-mobile .${tagClass} {
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(7px * var(--je-tag-scale, 1));
                    font-size: calc(11px * var(--je-tag-scale, 1));
                    border-radius: 5px;
                }

                @media (max-width: 768px) {
                    .${tagClass} { padding: calc(3px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }

                @media (max-width: 480px) {
                    .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }
            `;
      },
      pipeline: {
        needsFirstEpisode: false,
        needsParentSeries: false,
        // Series/Season "New Episode" and the schedule/milestone facts on
        // the /tag-data fallback path.
        needsLatestEpisode: true,
        render(ctx, el, item) {
          if (ctx.shouldIgnore(el)) return;
          if (ctx.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          const itemId = String(item.Id);
          JE.tagPipeline?.rememberItemFacts?.(item);
          const data = { ...fromItem(item, mediaInputs()), fetchedAt: Date.now() };
          setCachedEntry(ctx, itemId, data);
          renderData(ctx, el, data, itemId);
        },
        renderFromCache(ctx, el, itemId) {
          if (ctx.isTagged(el)) return true;
          if (ctx.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          const cached = getCachedEntry(ctx, itemId);
          if (!cached) return false;
          if ((cached.type === "Series" || cached.type === "Season") && JE.tagPipeline?.rememberItemFacts && !JE.tagPipeline.peekItemFacts(itemId)) {
            JE.tagPipeline.rememberItemFacts({
              Type: cached.type,
              SeriesId: cached.seriesId,
              SeasonNumber: cached.season,
              Status: cached.status,
              LatestEpisodeAdded: cached.latest,
              LatestEpisodeAired: cached.latestAired,
              LatestEpisodeIndex: cached.latestIndex ? {
                Season: cached.latestIndex.s,
                Episode: cached.latestIndex.e,
                IsLast: cached.latestIndex.isLast
              } : null,
              SeasonPremiere: cached.seasonPremiere ? { Season: cached.seasonPremiere.s, Aired: cached.seasonPremiere.aired } : null,
              SeasonAddedSpan: cached.addedSpan ? {
                First: cached.addedSpan.first,
                Last: cached.addedSpan.last,
                Count: cached.addedSpan.count,
                CoveredThrough: cached.addedSpan.coveredThrough
              } : null
            }, itemId, cached.fetchedAt);
            if (!JE.tagPipeline.peekItemFacts(itemId)) return false;
          }
          renderData(ctx, el, cached, itemId);
          return true;
        },
        renderFromServerCache(ctx, el, entry, itemId) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          if (el.closest(".je-hidden")) return;
          renderData(ctx, el, fromServerEntry(entry, itemId, mediaInputs()), itemId);
        },
        cleanup() {
          stopStatus();
          JE.tagDirectPlay?.reset();
        },
        onServerCacheRefresh(ctx, updatedIds, info) {
          onCacheReplaced(ctx, updatedIds, info);
        }
      }
    };
    let statusCtx = null;
    let userChangeRegistered = false;
    JE.initializeStatusTags = function() {
      console.log(`${logPrefix} Starting...`);
      stopStatus();
      if (!userChangeRegistered) {
        userChangeRegistered = true;
        JE.session?.onUserChange?.("status-tags", () => {
          trackRev++;
          staleBelowRev = trackRev;
          replacedAt.clear();
          stopStatus();
          seriesInfo.clear();
        });
      }
      const registered = JE.core.tagRenderer.register("status", spec);
      statusCtx = registered;
      registered.injectCss();
      activateStatus(registered);
      ensureTrending(registered);
      if (!calendarEventsRegistered) {
        calendarEventsRegistered = true;
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden && statusCtx) refreshCalendar(statusCtx);
        });
        window.addEventListener("focus", () => {
          if (statusCtx) refreshCalendar(statusCtx);
        });
        window.addEventListener("pagehide", stopStatus);
        window.addEventListener("pageshow", () => reinitializeStatusTags());
      }
      console.log(`${logPrefix} Initialized successfully.`);
    };
    function reinitializeStatusTags() {
      JE.core.tagRenderer.reinitialize("status", spec);
      if (statusCtx && JE.currentSettings?.statusTagsEnabled) {
        activateStatus(statusCtx);
        ensureTrending(statusCtx);
      }
    }
    JE.reinitializeStatusTags = reinitializeStatusTags;
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/status/statustags-entry.ts
  createStatusTags(export4());
})();
})();
//# sourceMappingURL=statustags.js.map
