(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/seerr/host-details.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Seerr details loaded before Jellyfin Enhanced");
    return host.JellyfinEnhanced;
  }
  function apiClient() {
    const host = window;
    if (!host.ApiClient) throw new Error("Jellyfin ApiClient unavailable");
    return host.ApiClient;
  }
  var detailsContexts = /* @__PURE__ */ new WeakMap();
  function seerrDetailsContext(JE2) {
    let ctx = detailsContexts.get(JE2);
    if (!ctx) {
      ctx = featureContext("seerr", JE2, {
        internalSlots: ["moreInfoModal"],
        internalsObject: () => JE2.internals ?? (JE2.internals = {})
      });
      detailsContexts.set(JE2, ctx);
    }
    return ctx;
  }
  function moreInfoRegistry(JE2) {
    const own = seerrDetailsContext(JE2).own;
    return own.moreInfoModal ?? (own.moreInfoModal = { state: { currentModal: null } });
  }
  function translator(JE2) {
    return (key, fallback = "", params) => {
      const text = params ? JE2.t?.(key, params) : JE2.t?.(key);
      return text || fallback;
    };
  }
  function escaper(JE2) {
    return (value) => {
      if (JE2.escapeHtml) return JE2.escapeHtml(value);
      return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    };
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/dates.ts
  var ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
  function isIsoDate(value) {
    return ISO_DATE.test(value);
  }
  function calendarYear(value) {
    if (isIsoDate(value)) return Number(value.slice(0, 4));
    const year = new Date(value).getFullYear();
    return Number.isNaN(year) ? void 0 : year;
  }

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
  }
  function str(value) {
    return typeof value === "string" ? value : void 0;
  }
  function filled(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  function records(value) {
    return list(value).filter(isRecord);
  }
  function idText(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return filled(value);
  }

  // client/src/features/seerr/details/domain/links.ts
  function urlSafePath(path) {
    return path.replace(/[\s'"()\\<>]/g, (character) => encodeURIComponent(character).replace(
      /[()']/g,
      (escaped) => `%${escaped.charCodeAt(0).toString(16).toUpperCase()}`
    ));
  }
  function tmdbImage(size, path) {
    const value = str(path);
    return value ? `https://image.tmdb.org/t/p/${size}${urlSafePath(value)}` : "";
  }
  function isPosterPath(value) {
    return typeof value === "string" && /^\/[a-zA-Z0-9._-]+\.[a-zA-Z]+$/.test(value);
  }
  function detailsHref(itemId) {
    return `#!/details?id=${encodeURIComponent(itemId)}`;
  }

  // client/src/features/seerr/details/domain/seasons.ts
  function seasonNumberOf(season) {
    return num(season.seasonNumber);
  }
  function seasonStatus(details, seasonNumber) {
    if (!seasonNumber) return null;
    return records(record(record(details)?.mediaInfo)?.seasons).find((season) => Number(season.seasonNumber) === Number(seasonNumber)) ?? null;
  }
  function seasonJellyfinId(season, is4k = false) {
    if (!season) return null;
    return is4k ? filled(season.jellyfinMediaId4k) ?? filled(season.jellyfinSeasonId4k) ?? filled(season.jellyfinId4k) : filled(season.jellyfinMediaId) ?? filled(season.jellyfinSeasonId) ?? filled(season.jellyfinId);
  }
  function seasonDisplayName(season, specials, numbered) {
    const number = seasonNumberOf(season) ?? 0;
    const trimmed = (str(season.name) ?? "").trim();
    const numericOnly = trimmed === String(number) || /^0*\d+$/.test(trimmed);
    if (trimmed && !numericOnly) return trimmed;
    return number === 0 ? specials : numbered(number);
  }
  function seasonYear(season) {
    const guarded = idText(season.jeYear);
    if (guarded) return guarded;
    const date = str(season.airDate);
    return date && isIsoDate(date) ? date.slice(0, 4) : "";
  }
  function mergeSeasonStatuses(requests, tmdbId, mediaSeasons) {
    const statuses = /* @__PURE__ */ new Map();
    const note = (season) => {
      const number = num(season.seasonNumber);
      if (number === void 0) return;
      const status = num(season.status);
      const previous = statuses.get(number);
      if (!previous || status !== void 0 && status > previous) statuses.set(number, status);
    };
    for (const request of records(requests)) {
      const media = record(request.media);
      if (request.type !== "tv" || !media || String(media.tmdbId) !== String(tmdbId)) continue;
      records(request.seasons).forEach(note);
    }
    records(mediaSeasons).forEach(note);
    return statuses;
  }
  function requestableSeasons(details) {
    const numbers = [];
    for (const season of records(details.seasons)) {
      const number = num(season.seasonNumber);
      if (number !== void 0 && number > 0 && (num(season.episodeCount) ?? 0) > 0) numbers.push(number);
    }
    return numbers;
  }
  function jellyfinSeasonMap(reply) {
    const map = {};
    for (const season of records(record(reply)?.Items)) {
      const number = Number(season.IndexNumber);
      const id = filled(season.Id);
      if (id && Number.isFinite(number) && number > 0) map[number] = { id, name: filled(season.Name) };
    }
    return map;
  }
  function seasonPresence(reply) {
    const presence = {};
    for (const season of list(record(reply)?.Items)) {
      const number = Number(record(season)?.IndexNumber);
      if (Number.isFinite(number) && number >= 0) presence[number] = true;
    }
    return presence;
  }

  // client/src/features/seerr/details/moreinfo/scope.ts
  function isLive(state2, modal) {
    return modal !== null && state2.currentModal === modal && modal._isClosing !== true;
  }

  // client/src/features/seerr/details/moreinfo/seasons-entry.ts
  var JE = bridge();
  var internal = moreInfoRegistry(JE);
  var { state } = internal;
  var logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
  var escapeHtml = escaper(JE);
  var t = translator(JE);
  async function lookupSeason(tmdbId, seasonNumber, options) {
    try {
      const detail = await JE.jellyseerrAPI?.fetchTvSeasonDetails?.(tmdbId, seasonNumber, options);
      const first = records(record(detail)?.episodes)[0];
      return { seasonNumber, firstEpDate: filled(first?.airDate) ?? "", firstEpYear: idText(first?.jeYear) ?? "", detail };
    } catch {
      return { seasonNumber, firstEpDate: "", firstEpYear: "", detail: void 0 };
    }
  }
  function backfillCard(card, season, details, tmdbSeason, own, episode) {
    const ownName = filled(own?.name);
    if (ownName && ownName !== season.name) {
      season.name = ownName;
      const nameEl = card.querySelector(".season-name");
      if (nameEl) nameEl.textContent = ownName;
    }
    if (!season.posterPath) {
      const candidate = filled(tmdbSeason?.poster_path) ?? filled(own?.posterPath);
      const fallback = isPosterPath(candidate) ? candidate : details.posterPath;
      if (isPosterPath(fallback)) {
        season.posterPath = fallback;
        const posterEl = card.querySelector(".season-poster");
        if (posterEl) {
          const source = tmdbImage("w185", fallback);
          const existing = posterEl.querySelector("img");
          if (existing) {
            if (existing.src !== source) existing.src = source;
          } else {
            const image = document.createElement("img");
            image.src = source;
            image.alt = card.querySelector(".season-name")?.textContent ?? "";
            posterEl.appendChild(image);
          }
        }
      }
    }
    const overview = filled(tmdbSeason?.overview) ?? filled(own?.overview);
    if (!season.overview && overview) {
      season.overview = overview;
      const infoEl = card.querySelector(".season-info");
      if (infoEl && !infoEl.querySelector(".season-overview")) {
        const overviewEl = document.createElement("div");
        overviewEl.className = "season-overview";
        overviewEl.textContent = overview;
        infoEl.appendChild(overviewEl);
      }
    }
    if (!season.airDate) {
      const episodeDate = episode?.firstEpDate && isIsoDate(episode.firstEpDate) ? episode.firstEpDate : "";
      const tmdbDate = filled(tmdbSeason?.air_date) ?? "";
      const best = episodeDate || (isIsoDate(tmdbDate) ? tmdbDate : "");
      const year = best ? calendarYear(best) : idText(season.jeYear) ?? (episode?.firstEpYear || idText(tmdbSeason?.jeYear));
      if (best) season.airDate = best;
      if (year) {
        const metaEl = card.querySelector(".season-meta");
        if (metaEl && !(metaEl.textContent ?? "").includes(String(year))) {
          metaEl.textContent = `${num(season.episodeCount) ?? 0} Episodes • ${year}`;
        }
      }
    }
  }
  async function backfillSeasonMetadata(tmdbId, details) {
    try {
      const modal = state.currentModal;
      if (!modal || !isRecord(details) || !Array.isArray(details.seasons)) return;
      const api = JE.jellyseerrAPI;
      const followUp = api?.followUpOptions?.(details);
      const seasons = records(details.seasons);
      const missing = seasons.filter((season) => (num(season.episodeCount) ?? 0) > 0 && (!season.airDate || !season.posterPath || !season.overview));
      if (missing.length === 0) return;
      const tmdbLookup = JE.pluginConfig?.TmdbEnabled && api?.fetchTmdbTvDetails ? api.fetchTmdbTvDetails(tmdbId, followUp).catch(() => null) : Promise.resolve(null);
      const episodeLookups = api?.fetchTvSeasonDetails ? missing.map((season) => lookupSeason(tmdbId, seasonNumberOf(season) ?? 0, followUp)) : [];
      const [tmdbData, episodes] = await Promise.all([tmdbLookup, Promise.all(episodeLookups)]);
      if (state.currentModal !== modal || modal._isClosing || String(modal.dataset?.tmdbId) !== String(tmdbId)) return;
      const tmdbSeasons = /* @__PURE__ */ new Map();
      for (const season of records(record(tmdbData)?.seasons)) {
        const number = num(season.season_number);
        if (number !== void 0) tmdbSeasons.set(number, season);
      }
      const episodesBySeason = new Map(episodes.map((result) => [result.seasonNumber, result]));
      for (const season of seasons) {
        const number = seasonNumberOf(season);
        if (number === void 0) continue;
        const card = modal.querySelector(`.season-card[data-season-number="${CSS.escape(String(number))}"]`);
        if (!card) continue;
        const episode = episodesBySeason.get(number);
        backfillCard(card, season, details, tmdbSeasons.get(number), details.jeSpoilerGuard ? record(episode?.detail) : null, episode);
      }
    } catch (error) {
      console.debug(`${logPrefix} Failed to backfill season metadata:`, error);
    }
  }
  function linkChip(className, itemId, label) {
    return `<a is="emby-linkbutton" class="season-link-chip ${className}" href="${escapeHtml(detailsHref(itemId))}">${label}</a>`;
  }
  function buildSeasonAvailabilityLinks(season, seasonId = null, seasonId4k = null) {
    const media = JE.seerrStatus?.MEDIA;
    const status = num(season?.status);
    const status4k = num(season?.status4k);
    const available = status === media?.AVAILABLE && !!seasonId || status === media?.PARTIALLY_AVAILABLE || !status && !!seasonId;
    const available4k = status4k === media?.AVAILABLE && !!seasonId4k || status4k === media?.PARTIALLY_AVAILABLE || !status4k && !!seasonId4k;
    const pills = [];
    if (available) pills.push(seasonId ? linkChip("available", seasonId, "Available") : '<span class="season-link-chip available">Available</span>');
    if (available4k) {
      const target = seasonId4k ?? seasonId;
      pills.push(target ? linkChip("available-4k", target, "4K Available") : '<span class="season-link-chip available-4k">4K Available</span>');
    }
    return pills.length ? `<div class="season-links">${pills.join("")}</div>` : "";
  }
  async function fetchJellyfinSeasonMap(seriesId) {
    const client = apiClient();
    const userId = client.getCurrentUserId();
    if (!userId || !seriesId) return {};
    try {
      const reply = await client.ajax({
        type: "GET",
        dataType: "json",
        url: client.getUrl(`/Users/${userId}/Items`, { ParentId: seriesId, IncludeItemTypes: "Season", Recursive: false, Fields: "ParentIndexNumber,IndexNumber,Name" })
      });
      return jellyfinSeasonMap(reply);
    } catch (error) {
      console.debug(`${logPrefix} Could not load Jellyfin season links:`, error);
      return {};
    }
  }
  var seasonMaps = /* @__PURE__ */ new WeakMap();
  async function enrichSeasonCardsWithJellyfinLinks(details, modal = state.currentModal, options = {}) {
    if (!modal || !isRecord(details) || details.mediaType === "movie") return;
    const seriesId = filled(record(details.mediaInfo)?.jellyfinMediaId);
    if (!seriesId || !modal.querySelector("[data-season-number]")) return;
    let known = options.refresh ? void 0 : seasonMaps.get(details);
    if (!known) {
      known = await fetchJellyfinSeasonMap(seriesId);
      if (Object.keys(known).length > 0) seasonMaps.set(details, known);
      else seasonMaps.delete(details);
      if (!isLive(state, modal)) return;
    }
    const map = known;
    modal.querySelectorAll("[data-season-number]").forEach((card) => {
      const number = Number(card.dataset.seasonNumber);
      const mount = card.querySelector("[data-season-links]");
      if (!mount || !Number.isFinite(number)) return;
      const season = seasonStatus(details, number);
      const entry = map[number];
      mount.innerHTML = buildSeasonAvailabilityLinks(season, entry?.id ?? seasonJellyfinId(season), seasonJellyfinId(season, true));
      if (entry?.name) {
        const nameEl = card.querySelector(".season-name");
        if (nameEl) nameEl.textContent = entry.name;
      }
    });
  }
  async function checkForUnrequestedSeasons(details, signal) {
    if (!isRecord(details)) return false;
    const seasons = requestableSeasons(details);
    if (seasons.length === 0) return false;
    const seerrStatus = JE.seerrStatus;
    const coreApi = JE.core?.api;
    try {
      if (!seerrStatus || !coreApi) throw new Error("Seerr status or core API unavailable");
      const signalOption = signal ? { signal } : {};
      const reply = await coreApi.plugin("/jellyseerr/request?take=500&skip=0&filter=all", { skipRetry: true, ...signalOption });
      const mediaInfo = record(details.mediaInfo);
      const statuses = mergeSeasonStatuses(records(record(reply)?.results), details.id, mediaInfo?.seasons);
      const jellyfinMediaId = filled(mediaInfo?.jellyfinMediaId);
      let presence = null;
      if (jellyfinMediaId) {
        try {
          const client = apiClient();
          const userId = client.getCurrentUserId();
          if (userId) {
            presence = seasonPresence(await coreApi.fetch(client.getUrl(`/Users/${userId}/Items`, {
              ParentId: jellyfinMediaId,
              IncludeItemTypes: "Season",
              Recursive: false,
              Fields: "IndexNumber"
            }), { skipRetry: true, ...signalOption }));
          }
        } catch {
        }
      }
      return seasons.some((number) => seerrStatus.isRequestable(seerrStatus.effectiveMediaStatus(statuses.get(number), jellyfinMediaId, presence, number)));
    } catch (error) {
      if (signal?.aborted) return false;
      console.error("[More Info Modal] Error checking unrequested seasons:", error);
      return false;
    }
  }
  function buildSeasonCard(details, season) {
    const number = seasonNumberOf(season) ?? 0;
    const status = seasonStatus(details, number);
    const poster = filled(season.posterPath) ?? (isPosterPath(details.posterPath) ? details.posterPath : null);
    const posterUrl = poster ? tmdbImage("w185", poster) : "";
    const name = seasonDisplayName(season, t("jellyseerr_season_specials"), (value) => t("jellyseerr_season_name", "", { number: value }));
    const year = seasonYear(season);
    return `
                        <div class="season-card" data-season-number="${escapeHtml(String(number))}">
                            <div class="season-poster">
                                ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(name)}" />` : ""}
                            </div>
                            <div class="season-info">
                                <div class="season-name">${escapeHtml(name)}</div>
                                <div class="season-meta">
                                    ${escapeHtml(num(season.episodeCount) ?? 0)} Episodes
                                    ${year ? ` • ${escapeHtml(year)}` : ""}
                                </div>
                                <div data-season-links>${buildSeasonAvailabilityLinks(status, seasonJellyfinId(status), seasonJellyfinId(status, true))}</div>
                                ${season.overview ? `<div class="season-overview">${escapeHtml(str(season.overview))}</div>` : ""}
                            </div>
                        </div>
                    `;
  }
  function buildSeasonsSection(details) {
    if (!isRecord(details)) return "";
    const seasons = records(details.seasons);
    if (!seasons.length) return "";
    return `
        <div class="seasons-section">
            <h3>Seasons</h3>
            <div class="seasons-grid">
                ${seasons.map((season) => buildSeasonCard(details, season)).join("")}
            </div>
        </div>
    `;
  }
  internal.backfillSeasonMetadata = backfillSeasonMetadata;
  internal.getSeasonStatusInfo = seasonStatus;
  internal.getSeasonJellyfinId = seasonJellyfinId;
  internal.buildSeasonAvailabilityLinks = buildSeasonAvailabilityLinks;
  internal.fetchJellyfinSeasonMap = fetchJellyfinSeasonMap;
  internal.enrichSeasonCardsWithJellyfinLinks = enrichSeasonCardsWithJellyfinLinks;
  internal.checkForUnrequestedSeasons = checkForUnrequestedSeasons;
  internal.buildSeasonsSection = buildSeasonsSection;
})();
})();
//# sourceMappingURL=more-info-modal-seasons.js.map
