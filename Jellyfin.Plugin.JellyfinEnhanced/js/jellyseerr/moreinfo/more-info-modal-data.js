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
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
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

  // client/src/features/seerr/details/domain/media.ts
  function clearPhantom4k(details, available, unknown) {
    const info = isRecord(details) ? record(details.mediaInfo) : null;
    if (!info || info.status4k !== available) return;
    const distinct = filled(info.jellyfinMediaId4k) && info.jellyfinMediaId4k !== info.jellyfinMediaId;
    if (!distinct) info.status4k = unknown;
  }
  function pickByRegion(entries, region2) {
    return entries.find((entry) => entry.iso_3166_1 === region2) ?? entries.find((entry) => entry.iso_3166_1 === "US") ?? entries[0];
  }
  function contentRating(details, mediaType, region2) {
    if (mediaType === "movie") {
      const results2 = record(details.releases)?.results;
      if (!Array.isArray(results2)) return "N/A";
      const dates = records(pickByRegion(records(results2), region2)?.release_dates);
      if (!dates.length) return "N/A";
      const release = dates.find((date) => date.type === 3 && filled(date.certification)) ?? dates.find((date) => filled(date.certification));
      return filled(release?.certification) ?? "N/A";
    }
    const results = record(details.contentRatings)?.results;
    if (!Array.isArray(results)) return "N/A";
    return filled(pickByRegion(records(results), region2)?.rating) ?? "N/A";
  }

  // client/src/features/seerr/details/moreinfo/data-entry.ts
  var JE = bridge();
  var internal = moreInfoRegistry(JE);
  var logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
  async function fetchRatings(tmdbId, mediaType, details, signal) {
    try {
      const client = apiClient();
      const endpoint = mediaType === "tv" ? `/tv/${tmdbId}/ratings` : `/movie/${tmdbId}/ratingscombined`;
      const url = client.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`);
      const followUp = JE.jellyseerrAPI?.followUpOptions?.(details)?.headers;
      let response;
      if (JE.requestManager) {
        const userId = client.getCurrentUserId() ?? "";
        const reply = await JE.requestManager.fetchWithRetry(url, {
          method: "GET",
          headers: {
            "X-Jellyfin-User-Id": userId,
            Authorization: `MediaBrowser Token="${client.accessToken()}"`,
            "X-Emby-Token": client.accessToken(),
            Accept: "application/json",
            ...followUp
          },
          ...signal ? { signal } : {}
        });
        response = await reply.json();
      } else {
        response = await client.ajax({
          type: "GET",
          url,
          dataType: "json",
          headers: { "X-Jellyfin-User-Id": client.getCurrentUserId() ?? "", ...followUp }
        });
      }
      if (mediaType === "tv") return response ? { rt: response } : null;
      return response;
    } catch (error) {
      console.warn(`${logPrefix} Failed to fetch ratings for ${mediaType} ${tmdbId}:`, error);
      return null;
    }
  }
  async function fetchMediaDetails(tmdbId, mediaType) {
    try {
      let data;
      const api = JE.jellyseerrAPI;
      if (api) {
        data = mediaType === "movie" ? await api.fetchMovieDetails(tmdbId, { skipCache: true }) : await api.fetchTvShowDetails(tmdbId, { skipCache: true });
      } else {
        const client = apiClient();
        data = await client.ajax({
          type: "GET",
          dataType: "json",
          url: client.getUrl(`/JellyfinEnhanced/jellyseerr/${mediaType === "movie" ? "movie" : "tv"}/${tmdbId}`),
          headers: { "X-Jellyfin-User-Id": client.getCurrentUserId() ?? "" }
        });
      }
      const media = JE.seerrStatus?.MEDIA;
      if (media) clearPhantom4k(data, media.AVAILABLE, media.UNKNOWN);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch ${mediaType} details for TMDB ID ${tmdbId}:`, error);
      throw error;
    }
  }
  function region() {
    return (JE.userConfig?.elsewhere?.Region || JE.pluginConfig?.DEFAULT_REGION || "US").toUpperCase();
  }
  function getContentRating(details, mediaType) {
    return isRecord(details) ? contentRating(details, mediaType, region()) : "N/A";
  }
  function showError(message) {
    console.error(message);
    alert(message);
  }
  function formatCurrency(amount) {
    const value = num(amount);
    if (!value) return null;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
  }
  internal.fetchRatings = fetchRatings;
  internal.fetchMediaDetails = fetchMediaDetails;
  internal.getContentRating = getContentRating;
  internal.showError = showError;
  internal.formatCurrency = formatCurrency;
})();
})();
//# sourceMappingURL=more-info-modal-data.js.map
