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
  function hashParams(hash) {
    try {
      return new URLSearchParams(hash.split("?")[1]);
    } catch {
      return null;
    }
  }
  function parseTagName(hash) {
    if (!hash.includes("/list") || !hash.includes("type=tag") || !hash.includes("tag=")) return null;
    const params = hashParams(hash);
    if (params?.get("type") !== "tag") return null;
    const tag = params.get("tag") || "";
    try {
      return decodeURIComponent(tag);
    } catch {
      return tag;
    }
  }
  function rowsOf(value) {
    return isRecord(value) && Array.isArray(value.results) ? value.results : [];
  }
  function isPositiveInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
  }
  function isUserActive(status) {
    return isRecord(status) && !!status.active;
  }
  function namedRows(value) {
    return rowsOf(value).filter((row) => isRecord(row) && typeof row.id === "number" && typeof row.name === "string");
  }
  var sameName = (row, name) => row.name.toLowerCase() === name.toLowerCase();
  function pickKeyword(response, name) {
    const rows = namedRows(response);
    return (rows.find((row) => sameName(row, name)) ?? rows[0])?.id;
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

  // client/src/features/seerr/discovery/tag-discovery.ts
  function start(JE) {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, "tag");
    const keywordCache = filter.createSessionCache("keyword-id", isPositiveInt);
    function searchTmdbKeyword(tagName, signal) {
      const cacheKey = tagName.toLowerCase().trim();
      const cache = keywordCache.scope();
      const cached = cache.get(cacheKey);
      if (cached) return Promise.resolve(cached);
      return tolerant(signal, async () => {
        const response = await fetchManaged(`/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(tagName)}`, { signal });
        const keywordId = pickKeyword(response, tagName);
        if (keywordId === void 0) return null;
        if (!signal.aborted) cache.set(cacheKey, keywordId);
        return keywordId;
      });
    }
    async function resolveFeeds({ id: tagName, signal }) {
      const status = await JE.jellyseerrAPI?.checkUserStatus?.();
      if (signal.aborted || !isUserActive(status)) return null;
      const keywordId = await searchTmdbKeyword(tagName, signal);
      if (signal.aborted || !keywordId) return null;
      return { tvId: keywordId, movieId: keywordId, title: translate(JE, "discovery_more_with_tag", { tag: tagName }), name: tagName };
    }
    base.createDiscovery({
      key: "tag",
      mode: "dual-feed",
      logLabel: "Tag Discovery",
      configKey: "JellyseerrShowTagDiscovery",
      getIdFromUrl: () => parseTagName(window.location.hash),
      resolveFeeds,
      buildDiscoverPath: (kind, id) => kind === "tv" ? `/JellyfinEnhanced/jellyseerr/discover/tv/keyword/${id}` : `/JellyfinEnhanced/jellyseerr/discover/movies/keyword/${id}`
    }).start();
  }
  (function() {
    "use strict";
    start(discoveryHost().JE);
  })();
})();
})();
//# sourceMappingURL=tag-discovery.js.map
