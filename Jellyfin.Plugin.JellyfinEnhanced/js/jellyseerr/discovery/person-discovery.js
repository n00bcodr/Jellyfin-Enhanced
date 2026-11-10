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
  function isSeerrResult(value) {
    return isRecord(value);
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
  function decodeError(what) {
    const error = new Error(`Unexpected ${what} response`);
    error.name = "DecodeError";
    return error;
  }
  var resultKey = (item) => `${String(item.mediaType)}-${String(item.id)}`;
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
  function isUserActive(status) {
    return isRecord(status) && !!status.active;
  }
  function hasItemType(item, type) {
    return isRecord(item) && item.Type === type;
  }
  function decodeCredits(value) {
    if (value === null || value === void 0) return [];
    if (!isRecord(value)) throw decodeError("credits");
    const rows = [value.cast, value.crew].flatMap((list) => Array.isArray(list) ? list : []);
    const seen = /* @__PURE__ */ new Set();
    const results = [];
    for (const row of rows) {
      if (!isSeerrResult(row) || !row.id || !row.mediaType) continue;
      const key = resultKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
    }
    return results;
  }
  function namedRows(value) {
    return rowsOf(value).filter((row) => isRecord(row) && typeof row.id === "number" && typeof row.name === "string");
  }
  function bestOf(rows, score) {
    return [...rows].sort((a, b) => score(b) - score(a))[0]?.id;
  }
  var sameName = (row, name) => row.name.toLowerCase() === name.toLowerCase();
  function pickPerson(response, name) {
    const people = namedRows(response).filter((row) => row.mediaType === "person");
    const exact = people.filter((row) => sameName(row, name));
    return bestOf(exact.length > 0 ? exact : people, (row) => (row.profilePath ? 2 : 0) + Math.min(Array.isArray(row.knownFor) ? row.knownFor.length : 0, 3));
  }

  // client/src/features/seerr/discovery/lookups.ts
  function managedFetch(JE, prefix) {
    return (path, options) => filterOf(JE).fetchWithManagedRequest(path, prefix, options);
  }
  async function isItemType(JE, itemId, type, signal) {
    try {
      throwIfAborted(signal);
      const client = discoveryHost().api();
      const item = JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId) : await client?.getItem?.(client.getCurrentUserId(), itemId);
      throwIfAborted(signal);
      return hasItemType(item, type);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return false;
    }
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

  // client/src/features/seerr/discovery/person-discovery.ts
  var logPrefix = "🪼 Jellyfin Enhanced: Person Discovery:";
  function start(JE) {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, "person");
    const personIdCache = filter.createSessionCache("person-id", isPositiveInt);
    const personInfoCache = filter.createSessionCache("person-info", isNamedTmdbInfo);
    function getPersonInfo(personId, signal) {
      const cache = personInfoCache.scope();
      const cached = cache.get(personId);
      if (cached) return Promise.resolve(cached);
      return tolerant(signal, async () => {
        const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/person/${personId}`, { signal }));
        if (info && !signal.aborted) cache.set(personId, info);
        return info;
      });
    }
    function searchTmdbPerson(name, signal) {
      const cacheKey = name.toLowerCase().trim();
      const cache = personIdCache.scope();
      const cached = cache.get(cacheKey);
      if (cached) return Promise.resolve(cached);
      return tolerant(signal, async () => {
        const response = await fetchManaged(`/JellyfinEnhanced/tmdb/search/person?query=${encodeURIComponent(name)}`, { signal });
        const personId = pickPerson(response, name);
        if (personId === void 0) return null;
        if (!signal.aborted) cache.set(cacheKey, personId);
        return personId;
      });
    }
    async function fetchPersonCredits(personId, signal) {
      try {
        throwIfAborted(signal);
        const credits = decodeCredits(await fetchManaged(`/JellyfinEnhanced/jellyseerr/person/${personId}/combined_credits`, { signal }));
        throwIfAborted(signal);
        return credits;
      } catch (error) {
        if (!isAbortError(error)) console.error(`${logPrefix} Error fetching credits:`, error);
        throw error;
      }
    }
    async function resolveItems({ id: itemId, signal }) {
      const isPerson = await isItemType(JE, itemId, "Person", signal);
      if (signal.aborted || !isPerson) return null;
      const [personInfo, status] = await Promise.all([getPersonInfo(itemId, signal), JE.jellyseerrAPI?.checkUserStatus?.()]);
      if (signal.aborted) return null;
      if (!isUserActive(status) || !personInfo?.name) return null;
      const tmdbPersonId = positiveInt(personInfo.tmdbId) ?? await searchTmdbPerson(personInfo.name, signal);
      if (signal.aborted || !tmdbPersonId) return null;
      const items = await fetchPersonCredits(tmdbPersonId, signal);
      if (signal.aborted) return null;
      console.debug(`${logPrefix} Fetched ${items.length} credits for ${personInfo.name}`);
      return { items, title: translate(JE, "discovery_more_from_person", { person: personInfo.name }) };
    }
    base.createDiscovery({
      key: "person",
      mode: "client-paged",
      logLabel: "Person Discovery",
      configKey: "JellyseerrShowPersonDiscovery",
      getIdFromUrl: base.idFromDetailUrl,
      pageSize: 40,
      resolveItems
    }).start();
  }
  (function() {
    "use strict";
    start(discoveryHost().JE);
  })();
})();
})();
//# sourceMappingURL=person-discovery.js.map
