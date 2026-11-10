(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
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
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/spoiler-guard/ownership.ts
  var ownership_exports = {};
  __export(ownership_exports, {
    own: () => own
  });
  function own(JE2, name, navigation = true) {
    let controller = new AbortController();
    let disposed = false;
    const resources = /* @__PURE__ */ new Set();
    function reset() {
      controller.abort();
      controller = new AbortController();
      for (const dispose of resources) dispose();
      resources.clear();
    }
    const unregister = JE2.session?.onUserChange(`spoilerguard-${name}-ownership`, reset);
    const life = JE2.core?.lifecycle?.register(`spoiler-guard-${name}`);
    if (navigation) life?.teardownOn("navigate");
    life?.onTeardown(reset);
    function lease() {
      const signal = controller.signal;
      const epoch = JE2.session?.getEpoch();
      const sessionLease = JE2.session?.createLease?.();
      const current = () => !disposed && !signal.aborted && (sessionLease ? sessionLease.isCurrent() : epoch === void 0 || JE2.session?.isCurrent(epoch) === true);
      return { signal, current, check() {
        if (!current()) throw new DOMException("Stale Spoiler Guard operation", "AbortError");
      } };
    }
    function track(dispose) {
      resources.add(dispose);
      return () => {
        resources.delete(dispose);
        dispose();
      };
    }
    function later(callback, ms) {
      const token = lease();
      const timer = window.setTimeout(() => {
        resources.delete(cancel);
        if (token.current()) callback();
      }, ms);
      const cancel = () => window.clearTimeout(timer);
      resources.add(cancel);
      return () => {
        resources.delete(cancel);
        cancel();
      };
    }
    function listen(target, event, callback, capture = false) {
      target.addEventListener(event, callback, capture);
      return track(() => target.removeEventListener(event, callback, capture));
    }
    return { lease, reset, track, later, listen, dispose() {
      disposed = true;
      reset();
      unregister?.();
    } };
  }

  // client/generated-shared/publish/js/enhanced/spoilerguard/state.js.ts
  publishSharedModules({ "features/spoiler-guard/ownership": ownership_exports });

  // client/src/features/spoiler-guard/ids-logic.ts
  function normalizeId(id) {
    if (!id) return "";
    if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") return "";
    return String(id).replace(/-/g, "").toLowerCase();
  }
  function pendingKey(mediaType, tmdbId) {
    const type = typeof mediaType === "string" ? mediaType.toLowerCase() : "";
    const id = typeof tmdbId === "string" || typeof tmdbId === "number" ? String(tmdbId).trim() : "";
    if (!id || type !== "tv" && type !== "movie") return "";
    return `${type}:${id}`;
  }

  // client/src/features/spoiler-guard/wire.ts
  function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Spoiler Guard object");
    return Object.fromEntries(Object.entries(value));
  }
  function decodePrefs(value) {
    const input = record(value);
    const result = {};
    for (const [key, field] of Object.entries(input)) {
      if (typeof field !== "boolean" && field !== null) throw new Error("Invalid Spoiler Guard preference");
      if (key === "SkipDisableConfirm" && field === null) throw new Error("Invalid confirmation preference");
      Object.defineProperty(result, key, { value: field, enumerable: true, writable: true });
    }
    return result;
  }
  function decodeState(value) {
    const input = record(value);
    function ids(key) {
      const entries = record(input[key]);
      for (const item of Object.values(entries)) record(item);
      return entries;
    }
    return { Series: ids("Series"), Movies: ids("Movies"), Collections: ids("Collections"), PendingTmdb: ids("PendingTmdb"), Prefs: decodePrefs(input.Prefs) };
  }
  function decodeMutation(value) {
    const input = record(value);
    const result = {};
    for (const key of ["promoted", "removedFrom", "jellyfinId"]) {
      const field = input[key];
      if (key === "jellyfinId" && field === null) continue;
      if (field !== void 0) {
        if (typeof field !== "string") throw new Error("Invalid Spoiler Guard mutation");
        result[key] = field;
      }
    }
    if (result.promoted !== void 0 && !["pending", "series", "movie"].includes(result.promoted)) throw new Error("Invalid promotion");
    if (result.removedFrom !== void 0 && !["none", "pending", "series", "movie"].includes(result.removedFrom)) throw new Error("Invalid removal kind");
    if ((result.promoted === "series" || result.promoted === "movie" || result.removedFrom === "series" || result.removedFrom === "movie") && !result.jellyfinId) throw new Error("Missing promoted Jellyfin ID");
    if (input.removed !== void 0) {
      if (typeof input.removed !== "boolean") throw new Error("Invalid removed verdict");
      result.removed = input.removed;
    }
    if (input.prefs !== void 0) result.prefs = decodePrefs(input.prefs);
    return result;
  }

  // client/generated-shared/stub/client/src/features/spoiler-guard/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/spoiler-guard/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "spoilerHost");

  // client/src/features/spoiler-guard/state.ts
  var { JE, internal, ctx } = export0();
  var owner = own(JE, "state", false);
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  var enabledSeries = /* @__PURE__ */ new Set();
  var enabledMovies = /* @__PURE__ */ new Set();
  var enabledCollections = /* @__PURE__ */ new Set();
  var enabledPendingTmdb = /* @__PURE__ */ new Set();
  var tmdbToJellyfin = /* @__PURE__ */ new Map();
  var userPrefs = {};
  var loaded = false;
  var loadOk = false;
  var statePromise = null;
  function invalidateGuardedResponses() {
    const manager = JE.core.api.manager;
    ["jellyseerr", "tmdb", "mdblist-ratings"].forEach((pattern) => manager?.clearCacheMatching?.(pattern));
    window.dispatchEvent(new CustomEvent("je:spoiler-state-changed"));
  }
  function request(path, options) {
    const token = owner.lease();
    token.check();
    const response = JE.core.api.plugin(path, { ...options, signal: token.signal });
    if (!options?.method || options.method === "GET") return response;
    return response.then(function(result) {
      if (token.current()) invalidateGuardedResponses();
      return result;
    });
  }
  internal.loadState = function() {
    if (statePromise) return statePromise;
    const requestToken = owner.lease();
    const prefetchedState = JE.takePrefetched?.("SpoilerBlurSeries");
    statePromise = (prefetchedState ? Promise.resolve(prefetchedState) : request("/spoiler-blur/series")).then(function(data) {
      if (!requestToken.current()) return;
      const value = decodeState(data);
      enabledSeries.clear();
      enabledMovies.clear();
      enabledCollections.clear();
      enabledPendingTmdb.clear();
      tmdbToJellyfin.clear();
      Object.keys(value.Series || {}).forEach((key) => enabledSeries.add(normalizeId(key)));
      Object.keys(value.Movies || {}).forEach((key) => enabledMovies.add(normalizeId(key)));
      Object.keys(value.Collections || {}).forEach((key) => enabledCollections.add(normalizeId(key)));
      Object.keys(value.PendingTmdb || {}).forEach((key) => enabledPendingTmdb.add(String(key).toLowerCase()));
      userPrefs = value.Prefs || {};
      loaded = true;
      loadOk = true;
      try {
        ctx.peer("tagPipeline")?.clearProcessed?.();
        ctx.peer("tagPipeline")?.scheduleScan?.();
      } catch (e) {
        console.warn(`${logPrefix} post-load tag rescan failed:`, e);
      }
    }).catch(function(err) {
      if (!requestToken.current()) return;
      console.error(`${logPrefix} state load failed; downstream consumers will fail closed:`, err);
      loaded = true;
      loadOk = false;
      try {
        ctx.peer("tagPipeline")?.clearProcessed?.();
        ctx.peer("tagPipeline")?.scheduleScan?.();
      } catch (e) {
        console.warn(`${logPrefix} post-failure tag rescan failed:`, e);
      }
    });
    return statePromise;
  };
  internal.whenLoaded = function() {
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return Promise.resolve();
    if (loaded) return Promise.resolve();
    return statePromise || internal.loadState();
  };
  internal.isStateLoaded = function() {
    return loaded;
  };
  internal.isLoadOk = function() {
    return loadOk;
  };
  internal.isLoaded = function() {
    return loaded;
  };
  internal.isEnabledFor = function(id) {
    return enabledSeries.has(normalizeId(id));
  };
  internal.isMovieEnabledFor = function(id) {
    return enabledMovies.has(normalizeId(id));
  };
  internal.isCollectionEnabledFor = function(id) {
    return enabledCollections.has(normalizeId(id));
  };
  internal.isMovieInScope = async function(id) {
    const scopeToken = owner.lease();
    await internal.whenLoaded();
    scopeToken.check();
    if (!internal.isLoadOk()) throw new Error("Spoiler Guard state unavailable");
    if (internal.isMovieEnabledFor(id)) return true;
    if (enabledCollections.size === 0) return false;
    const token = owner.lease();
    const result = await request(`/spoiler-blur/movies/${encodeURIComponent(normalizeId(id))}/in-scope`);
    token.check();
    const value = record(result);
    if (typeof value.inScope !== "boolean") throw new Error("Invalid scope verdict");
    return value.inScope;
  };
  internal.hasAnyState = function() {
    return enabledSeries.size > 0 || enabledMovies.size > 0 || enabledCollections.size > 0 || enabledPendingTmdb.size > 0;
  };
  internal.isEnabledForKind = function(kind, id) {
    if (kind === "movie") return internal.isMovieEnabledFor(id);
    if (kind === "collection") return internal.isCollectionEnabledFor(id);
    return internal.isEnabledFor(id);
  };
  internal.enableForSeries = function(id) {
    const requestToken = owner.lease();
    const normalized = normalizeId(id);
    return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: "POST", skipRetry: true }).then(function() {
      if (!requestToken.current()) return;
      enabledSeries.add(normalized);
    });
  };
  internal.disableForSeries = function(id) {
    const requestToken = owner.lease();
    const normalized = normalizeId(id);
    return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: "DELETE", skipRetry: true }).then(function() {
      if (!requestToken.current()) return;
      enabledSeries.delete(normalized);
    });
  };
  internal.enableForMovie = function(id, name) {
    const requestToken = owner.lease();
    const normalized = normalizeId(id);
    return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, {
      method: "POST",
      body: { MovieName: name || "" },
      skipRetry: true
    }).then(function() {
      if (!requestToken.current()) return;
      enabledMovies.add(normalized);
    });
  };
  internal.disableForMovie = function(id) {
    const requestToken = owner.lease();
    const normalized = normalizeId(id);
    return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, { method: "DELETE", skipRetry: true }).then(function() {
      if (!requestToken.current()) return;
      enabledMovies.delete(normalized);
    });
  };
  internal.enableForCollection = function(id, name) {
    const requestToken = owner.lease();
    const normalized = normalizeId(id);
    return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, {
      method: "POST",
      body: { CollectionName: name || "" },
      skipRetry: true
    }).then(function() {
      if (!requestToken.current()) return;
      enabledCollections.add(normalized);
    });
  };
  internal.disableForCollection = function(id) {
    const requestToken = owner.lease();
    const normalized = normalizeId(id);
    return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, { method: "DELETE", skipRetry: true }).then(function() {
      if (!requestToken.current()) return;
      enabledCollections.delete(normalized);
    });
  };
  internal.isTmdbPending = function(mediaType, tmdbId) {
    const key = pendingKey(mediaType, tmdbId);
    return !!key && enabledPendingTmdb.has(key);
  };
  internal.isTmdbEnabled = function(mediaType, tmdbId, jellyfinMediaId) {
    const key = pendingKey(mediaType, tmdbId);
    if (key && enabledPendingTmdb.has(key)) return true;
    const jellyfinId = jellyfinMediaId || (key ? tmdbToJellyfin.get(key) : null);
    if (!jellyfinId) return false;
    if (mediaType === "movie") return internal.isMovieEnabledFor(jellyfinId);
    if (mediaType === "tv") return internal.isEnabledFor(jellyfinId);
    return false;
  };
  internal.enableForTmdb = function(mediaType, tmdbId, displayName) {
    const requestToken = owner.lease();
    const type = String(mediaType || "").toLowerCase();
    const id = String(tmdbId || "").trim();
    if (!id || type !== "tv" && type !== "movie") return Promise.reject(new Error("invalid mediaType/tmdbId"));
    const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : "";
    return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: "POST", skipRetry: true }).then(function(raw) {
      const response = decodeMutation(raw);
      if (!requestToken.current()) return response;
      const key = pendingKey(type, id);
      if (response?.promoted === "pending") {
        if (key) enabledPendingTmdb.add(key);
      } else if (response?.promoted === "series" && response.jellyfinId) {
        const jellyfinId = normalizeId(response.jellyfinId);
        enabledSeries.add(jellyfinId);
        if (key) {
          enabledPendingTmdb.delete(key);
          tmdbToJellyfin.set(key, jellyfinId);
        }
      } else if (response?.promoted === "movie" && response.jellyfinId) {
        const jellyfinId = normalizeId(response.jellyfinId);
        enabledMovies.add(jellyfinId);
        if (key) {
          enabledPendingTmdb.delete(key);
          tmdbToJellyfin.set(key, jellyfinId);
        }
      }
      return response;
    });
  };
  internal.disableForTmdb = function(mediaType, tmdbId) {
    const requestToken = owner.lease();
    const type = String(mediaType || "").toLowerCase();
    const id = String(tmdbId || "").trim();
    if (!id || type !== "tv" && type !== "movie") return Promise.reject(new Error("invalid mediaType/tmdbId"));
    return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: "DELETE", skipRetry: true }).then(function(raw) {
      const response = decodeMutation(raw);
      if (!requestToken.current()) return response;
      const key = pendingKey(type, id);
      if (key) {
        enabledPendingTmdb.delete(key);
        tmdbToJellyfin.delete(key);
      }
      if (response?.removedFrom === "series" && response.jellyfinId) {
        enabledSeries.delete(normalizeId(response.jellyfinId));
      } else if (response?.removedFrom === "movie" && response.jellyfinId) {
        enabledMovies.delete(normalizeId(response.jellyfinId));
      }
      return response;
    });
  };
  internal.getUserPrefs = function() {
    return Object.assign({}, userPrefs);
  };
  internal.setUserPrefs = function(next) {
    const requestToken = owner.lease();
    const payload = decodePrefs(next || {});
    return request("/spoiler-blur/user-prefs", { method: "POST", body: payload, skipRetry: true }).then(function(raw) {
      const response = decodeMutation(raw);
      if (!requestToken.current()) return {};
      userPrefs = Object.assign({}, response.prefs || payload);
      return response?.prefs || userPrefs;
    }).catch(function(err) {
      if (requestToken.current()) console.error(`${logPrefix} setUserPrefs failed:`, err);
      throw err;
    });
  };
  function resetState() {
    statePromise = null;
    loaded = false;
    loadOk = false;
    enabledSeries.clear();
    enabledMovies.clear();
    enabledCollections.clear();
    enabledPendingTmdb.clear();
    tmdbToJellyfin.clear();
    userPrefs = {};
  }
  JE.session?.onUserChange("spoilerguard-state", resetState);
  JE.core?.lifecycle?.register("spoiler-guard-state").onTeardown(resetState);
})();
})();
//# sourceMappingURL=state.js.map
