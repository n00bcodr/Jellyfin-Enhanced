(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-discovery.ts
  function discoveryHost() {
    const host = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
  }
  function filterOf(JE) {
    if (!JE.discoveryFilter) throw new Error("Discovery filter utilities are not loaded");
    return JE.discoveryFilter;
  }
  function baseOf(JE) {
    if (!JE.discoveryBase) throw new Error("Discovery base is not loaded");
    return JE.discoveryBase;
  }
  function translate(JE, key, params) {
    return JE.t?.(key, params) ?? key;
  }

  // client/src/features/seerr/discovery/domain.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAbortError(error) {
    return isRecord(error) && error.name === "AbortError";
  }
  function abortError(message = "Aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }
  function rowsOf(value) {
    return isRecord(value) && Array.isArray(value.results) ? value.results : [];
  }
  function isNamedTmdbInfo(value) {
    return isRecord(value) && typeof value.name === "string" && (value.tmdbId === null || value.tmdbId === void 0 || typeof value.tmdbId === "string");
  }
  function decodeNamedInfo(value) {
    if (!isRecord(value) || typeof value.name !== "string") return null;
    const id = value.tmdbId;
    return { name: value.name, tmdbId: typeof id === "string" ? id : typeof id === "number" ? String(id) : null };
  }
  function positiveInt(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  function isPositiveInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
  }
  function isNullablePositiveInt(value) {
    return value === null || isPositiveInt(value);
  }
  function isUserActive(status) {
    return isRecord(status) && !!status.active;
  }
  function namedRows(value) {
    return rowsOf(value).filter((row) => isRecord(row) && typeof row.id === "number" && typeof row.name === "string");
  }
  function bestOf(rows, score) {
    return [...rows].sort((a, b) => score(b) - score(a))[0]?.id;
  }
  var sameName = (row, name) => row.name.toLowerCase() === name.toLowerCase();
  function pickCompany(response, name) {
    const rows = namedRows(response);
    if (rows.length === 0) return void 0;
    const exact = rows.filter((row) => sameName(row, name));
    if (exact.length === 0 && name.includes("+")) return null;
    return bestOf(
      exact.length > 0 ? exact : rows,
      (row) => (row.origin_country === "US" ? 2 : 0) + (row.logo_path ? 1 : 0)
    );
  }
  var TV_NETWORKS = /* @__PURE__ */ new Map([
    ["netflix", 213],
    ["hbo", 49],
    ["hbo max", 3186],
    ["max", 3186],
    ["amazon", 1024],
    ["amazon prime video", 1024],
    ["prime video", 1024],
    ["apple tv+", 2552],
    ["apple tv", 2552],
    ["disney+", 2739],
    ["disney plus", 2739],
    ["hulu", 453],
    ["paramount+", 4330],
    ["paramount plus", 4330],
    ["peacock", 3353],
    ["fx", 88],
    ["fx networks", 88],
    ["amc", 174],
    ["showtime", 67],
    ["starz", 318],
    ["abc", 2],
    ["nbc", 6],
    ["cbs", 16],
    ["fox", 19],
    ["the cw", 71],
    ["cw", 71],
    ["bbc", 4],
    ["bbc one", 4],
    ["bbc two", 332],
    ["itv", 9],
    ["channel 4", 26],
    ["sky", 1063],
    ["syfy", 77],
    ["usa network", 30],
    ["tnt", 41],
    ["tbs", 68],
    ["a&e", 129],
    ["history", 65],
    ["discovery", 64],
    ["national geographic", 43],
    ["nat geo", 43],
    ["adult swim", 80],
    ["cartoon network", 56],
    ["nickelodeon", 13],
    ["comedy central", 47],
    ["mtv", 33],
    ["bet", 24],
    ["espn", 29],
    ["crunchyroll", 1112],
    ["anime network", 171],
    ["funimation", 102],
    ["youtube", 247],
    ["youtube premium", 1436]
  ]);
  var isWordCharacter = (character) => character !== void 0 && /[\p{L}\p{N}]/u.test(character);
  function containsWords(haystack, needle) {
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      if (!isWordCharacter(haystack[at - 1]) && !isWordCharacter(haystack[at + needle.length])) return true;
    }
    return false;
  }
  function getKnownNetworkId(networkName) {
    const key = networkName.toLowerCase().trim();
    if (!key) return null;
    const exact = TV_NETWORKS.get(key);
    if (exact) return exact;
    for (const [name, id] of TV_NETWORKS) {
      if (containsWords(key, name) || containsWords(name, key)) return id;
    }
    return null;
  }

  // client/src/features/seerr/discovery/lookups.ts
  function managedFetch(JE, prefix) {
    return (path, options) => filterOf(JE).fetchWithManagedRequest(path, prefix, options);
  }
  async function tolerant(signal, fetch) {
    try {
      throwIfAborted(signal);
      const value = await fetch();
      throwIfAborted(signal);
      return value;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  // client/src/features/seerr/discovery/network-discovery.ts
  function start(JE) {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, "network");
    const companyCache = filter.createSessionCache("company-id", isNullablePositiveInt);
    const studioCache = filter.createSessionCache("studio-info", isNamedTmdbInfo);
    function getStudioInfo(studioId, signal) {
      const cache = studioCache.scope();
      const cached = cache.get(studioId);
      if (cached) return Promise.resolve(cached);
      return tolerant(signal, async () => {
        const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/studio/${studioId}`, { signal }));
        if (info && !signal.aborted) cache.set(studioId, info);
        return info;
      });
    }
    function searchTmdbCompany(name, signal) {
      const cacheKey = name.toLowerCase().trim();
      const cache = companyCache.scope();
      if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey) ?? null);
      return tolerant(signal, async () => {
        const response = await fetchManaged(`/JellyfinEnhanced/tmdb/search/company?query=${encodeURIComponent(name)}`, { signal });
        const companyId = pickCompany(response, name);
        if (companyId !== void 0 && !signal.aborted) cache.set(cacheKey, companyId);
        return companyId ?? null;
      });
    }
    async function resolveFeeds({ id: studioId, signal }) {
      const [studioInfo, status] = await Promise.all([getStudioInfo(studioId, signal), JE.jellyseerrAPI?.checkUserStatus?.()]);
      if (signal.aborted) return null;
      if (!isUserActive(status) || !studioInfo?.name) return null;
      const tvNetworkId = getKnownNetworkId(studioInfo.name);
      const companyId = positiveInt(studioInfo.tmdbId) ?? await searchTmdbCompany(studioInfo.name, signal);
      if (signal.aborted) return null;
      if (!tvNetworkId && !companyId) return null;
      const tvByCompany = !tvNetworkId && !!companyId && !!JE.pluginConfig?.TmdbEnabled;
      return {
        tvId: tvNetworkId || (tvByCompany ? companyId : null),
        movieId: companyId,
        tvSource: tvNetworkId ? "network" : "company",
        title: translate(JE, "discovery_more_from_studio", { studio: studioInfo.name }),
        name: studioInfo.name
      };
    }
    base.createDiscovery({
      key: "network",
      mode: "dual-feed",
      logLabel: "Network Discovery",
      configKey: "JellyseerrShowNetworkDiscovery",
      // Unlike the other discovery sections, network discovery is opt-in.
      defaultEnabled: false,
      getIdFromUrl: base.idFromListParam("studioId"),
      // Historical page-key format: no 'network-' prefix.
      pageKey: (id) => `${id}-${window.location.hash}`,
      resolveFeeds,
      buildDiscoverPath(kind, id, feeds) {
        if (kind !== "tv") return `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${id}`;
        return feeds.tvSource === "company" ? `/JellyfinEnhanced/jellyseerr/discover/tv/studio/${id}` : `/JellyfinEnhanced/jellyseerr/discover/tv/network/${id}`;
      }
    }).start();
  }
  (function() {
    "use strict";
    start(discoveryHost().JE);
  })();
})();
})();
//# sourceMappingURL=network-discovery.js.map
