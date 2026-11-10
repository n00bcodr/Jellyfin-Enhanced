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
  function identityKey(JE) {
    const session = JE.session;
    if (!session) return "";
    return `${session.getServerId?.() ?? ""}:${session.getUserId?.() ?? ""}:${session.getEpoch()}`;
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
  function isNamedTmdbInfo(value) {
    return isRecord(value) && typeof value.name === "string" && (value.tmdbId === null || value.tmdbId === void 0 || typeof value.tmdbId === "string");
  }
  function decodeNamedInfo(value) {
    if (!isRecord(value) || typeof value.name !== "string") return null;
    const id = value.tmdbId;
    return { name: value.name, tmdbId: typeof id === "string" ? id : typeof id === "number" ? String(id) : null };
  }
  function isUserActive(status) {
    return isRecord(status) && !!status.active;
  }
  function buildGenreMap(tv, movies) {
    const map = /* @__PURE__ */ new Map();
    const add = (entry, kind) => {
      const key = entry.name.toLowerCase();
      const ids = map.get(key) ?? { tv: null, movie: null };
      ids[kind] = entry.id;
      map.set(key, ids);
    };
    tv.forEach((entry) => add(entry, "tv"));
    movies.forEach((entry) => add(entry, "movie"));
    return map;
  }
  function resolveGenreIds(map, genreName) {
    const name = genreName.toLowerCase().trim();
    const result = { ...map.get(name) ?? { tv: null, movie: null } };
    for (const [key, ids] of map) {
      if (key === name || !(name.includes(key) || key.includes(name))) continue;
      result.tv || (result.tv = ids.tv);
      result.movie || (result.movie = ids.movie);
    }
    return result.tv || result.movie ? result : null;
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

  // client/src/features/seerr/discovery/genre-discovery.ts
  function start(JE) {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, "genre");
    const genreInfoCache = filter.createSessionCache("genre-info", isNamedTmdbInfo);
    let genreMap = null;
    async function fetchTmdbGenres(signal) {
      const identity = identityKey(JE);
      if (genreMap?.identity === identity) return genreMap.map;
      const list = (kind) => filter.fetchTmdbGenreList(kind, { signal }).catch(() => null);
      const [tv, movies] = await Promise.all([list("tv"), list("movie")]);
      throwIfAborted(signal);
      const map = buildGenreMap(tv ?? [], movies ?? []);
      if (tv?.length && movies?.length && identityKey(JE) === identity) genreMap = { identity, map };
      return map;
    }
    function getGenreInfo(genreId, signal) {
      const cache = genreInfoCache.scope();
      const cached = cache.get(genreId);
      if (cached) return Promise.resolve(cached);
      return tolerant(signal, async () => {
        const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/genre/${genreId}`, { signal }));
        if (info && !signal.aborted) cache.set(genreId, info);
        return info;
      });
    }
    async function resolveFeeds({ id: genreId, signal }) {
      const [genreInfo, status, genres] = await Promise.all([
        getGenreInfo(genreId, signal),
        JE.jellyseerrAPI?.checkUserStatus?.(),
        fetchTmdbGenres(signal)
      ]);
      if (signal.aborted) return null;
      if (!isUserActive(status) || !genreInfo?.name) return null;
      const ids = resolveGenreIds(genres, genreInfo.name);
      if (!ids) return null;
      return {
        tvId: ids.tv,
        movieId: ids.movie,
        title: translate(JE, "discovery_more_with_genre", { genre: genreInfo.name })
      };
    }
    base.createDiscovery({
      key: "genre",
      mode: "dual-feed",
      logLabel: "Genre Discovery",
      configKey: "JellyseerrShowGenreDiscovery",
      getIdFromUrl: base.idFromListParam("genreId"),
      resolveFeeds,
      buildDiscoverPath: (kind, id) => kind === "tv" ? `/JellyfinEnhanced/jellyseerr/discover/tv/genre/${id}` : `/JellyfinEnhanced/jellyseerr/discover/movies/genre/${id}`
    }).start();
  }
  (function() {
    "use strict";
    start(discoveryHost().JE);
  })();
})();
})();
//# sourceMappingURL=genre-discovery.js.map
