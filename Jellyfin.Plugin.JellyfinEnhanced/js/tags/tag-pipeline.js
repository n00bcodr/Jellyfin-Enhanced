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
  var export12 = /* @__PURE__ */ sharedExport(shared2, "errorStatus");
  var export2 = /* @__PURE__ */ sharedExport(shared2, "finite");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "idText");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export5 = /* @__PURE__ */ sharedExport(shared2, "memberRecord");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "members");
  var export8 = /* @__PURE__ */ sharedExport(shared2, "normalizeItemId");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "records");
  var export122 = /* @__PURE__ */ sharedExport(shared2, "stringList");

  // client/src/features/media-tags/pipeline/state.ts
  function entryPairs(items) {
    return Object.entries(export10(items)).filter((pair) => export42(pair[1]));
  }
  var servedAtOf = (resp) => typeof resp.servedAt === "number" ? resp.servedAt : 0;
  var textOrEmpty = (value) => typeof value === "string" ? value : "";
  var cursorOf = (resp) => export2(resp.timestamp) ?? 0;
  function firstItem(response) {
    const first = Array.isArray(response.Items) ? response.Items[0] : null;
    return export42(first) ? first : null;
  }
  var MEDIA_TYPES = /* @__PURE__ */ new Set(["Movie", "Episode", "Series", "Season", "BoxSet", "Video"]);
  var isMediaType = (type) => typeof type === "string" && MEDIA_TYPES.has(type);
  var logPrefix = "🪼 Jellyfin Enhanced [TagPipeline]:";
  var MEMORY_SOFT_CAP = 2e4;
  function createPipelineState(JE) {
    const STORED_ENTRY_SCHEMA = JE.tagCacheStore?.ENTRY_SCHEMA ?? 52;
    let prefetchedStripRevision;
    try {
      prefetchedStripRevision = JE.takePrefetched?.("TagStripRevision");
    } catch {
    }
    return {
      serverCache: null,
      serverCacheComplete: false,
      serverCacheVersion: 0,
      serverCacheTimestamp: 0,
      serverFilterRevision: null,
      serverFilterBase: "",
      cacheGeneration: 0,
      storeGate: null,
      openStoreGate: null,
      deltaIds: /* @__PURE__ */ new Set(),
      deltaInFlight: null,
      storeBaseServedAt: 0,
      storeScope: null,
      persistGeneration: 0,
      persistChain: Promise.resolve(),
      storeMisses: /* @__PURE__ */ new Set(),
      skipStoreThisSession: false,
      perCardThisSession: false,
      loadInFlight: null,
      loadInFlightEpoch: 0,
      refreshInFlight: null,
      serverCacheWait: 0,
      lastNavigationRoute: null,
      lastNavRefreshAt: -Infinity,
      navRefreshTimer: null,
      reviewRatings: null,
      reviewRatingsRequestedAt: 0,
      reviewRatingsListeners: /* @__PURE__ */ new Set(),
      STORED_ENTRY_SCHEMA,
      renderers: /* @__PURE__ */ new Map(),
      processedCards: /* @__PURE__ */ new WeakSet(),
      firstEpisodeCache: /* @__PURE__ */ new Map(),
      seasonFactIds: /* @__PURE__ */ new Map(),
      itemFacts: /* @__PURE__ */ new Map(),
      parentSeriesCache: /* @__PURE__ */ new Map(),
      fetchTimer: null,
      pipelineStarted: false,
      startWhenRendererRegisters: false,
      deferredLoad: null,
      loadStartedForEpoch: null,
      isProcessing: false,
      batchGeneration: 0,
      cancelBatchWait: null,
      activeBatch: [],
      requestQueue: [],
      cardReuse: /* @__PURE__ */ new WeakMap(),
      tagStripRevision: typeof prefetchedStripRevision === "string" ? prefetchedStripRevision : null,
      scanScheduled: false,
      msPerCard: 1.5,
      scanGeneration: 0,
      lookFacts: null,
      lookFactsSaveRegistered: false,
      isInvalidating: false
    };
  }

  // client/src/features/media-tags/pipeline/delta-sync.ts
  var NAV_REFRESH_MIN_INTERVAL_MS = 2e4;
  function createDeltaSync(s, JE, deps) {
    function navigationRoute() {
      const url = new URL(window.location.href);
      const [hashPath, hashQuery = ""] = url.hash.split("?");
      const params = new URLSearchParams(hashQuery);
      for (const [name, value] of url.searchParams) params.append(name, value);
      params.delete("query");
      params.sort();
      return `${url.pathname}${hashPath}?${params}`;
    }
    function scheduleNavigationRefresh() {
      if (!deps.anyTagTypeEnabled()) return;
      const now = performance.now();
      const elapsed = now - s.lastNavRefreshAt;
      if (!s.serverCache || elapsed >= NAV_REFRESH_MIN_INTERVAL_MS) {
        if (s.navRefreshTimer) {
          clearTimeout(s.navRefreshTimer);
          s.navRefreshTimer = null;
        }
        s.lastNavRefreshAt = now;
        deps.refreshServerCache();
        return;
      }
      if (s.navRefreshTimer) return;
      s.navRefreshTimer = setTimeout(() => {
        s.navRefreshTimer = null;
        if (!deps.anyTagTypeEnabled()) return;
        s.lastNavRefreshAt = performance.now();
        deps.refreshServerCache();
      }, Math.min(NAV_REFRESH_MIN_INTERVAL_MS, NAV_REFRESH_MIN_INTERVAL_MS - elapsed));
    }
    async function refreshServerCacheCore() {
      if (!s.serverCache) {
        if (s.loadInFlight) return;
        await deps.loadServerCache();
        if (s.serverCache) {
          s.processedCards = /* @__PURE__ */ new WeakSet();
          deps.runScan();
        }
        return;
      }
      await fetchDelta();
    }
    function fetchDelta() {
      const epoch = JE.session ? JE.session.getEpoch() : 0;
      if (s.deltaInFlight && s.deltaInFlight.epoch === epoch && s.deltaInFlight.generation === s.cacheGeneration) {
        return s.deltaInFlight.promise;
      }
      const entry = { epoch, generation: s.cacheGeneration, promise: fetchDeltaCore() };
      s.deltaInFlight = entry;
      entry.promise.finally(() => {
        if (s.deltaInFlight === entry) s.deltaInFlight = null;
      });
      return entry.promise;
    }
    function entryChanged(held, entry) {
      if (!held) return true;
      try {
        return JSON.stringify(held) !== JSON.stringify(entry);
      } catch {
        return true;
      }
    }
    async function reconcileAccess(resp, base, generation) {
      const revision = textOrEmpty(resp.filterRevision);
      if (!Array.isArray(resp.visible) || !s.serverFilterBase || resp.filterBase !== s.serverFilterBase || !revision || !s.serverCache) return false;
      const visible = new Set(export122(resp.visible));
      const newEntries = entryPairs(resp.items);
      const carried = export10(resp.items);
      const removed = export122(resp.removed).filter((id) => !(id in carried));
      const next = { timestamp: cursorOf(resp), servedAt: servedAtOf(resp), filterRevision: revision, filterBase: s.serverFilterBase };
      let dropped;
      if (s.serverCacheComplete) {
        const held = new Set(s.serverCache.keys());
        for (const [id] of newEntries) held.add(id);
        for (const id of visible) if (!held.has(id)) return false;
        dropped = [...s.serverCache.keys()].filter((id) => !visible.has(id));
        const scope = s.storeScope;
        if (scope && JE.tagCacheStore?.available()) {
          const store = JE.tagCacheStore;
          const persistAt = s.persistGeneration;
          deps.queuePersist(async () => {
            if (persistAt !== s.persistGeneration) return;
            await store.reconcileAccess(scope, base, next, newEntries, removed, visible);
          });
        }
      } else {
        const scope = s.storeScope;
        if (!scope || !JE.tagCacheStore?.available()) return false;
        const store = JE.tagCacheStore;
        const outcome = await new Promise((resolve) => {
          deps.queuePersist(async () => {
            try {
              resolve(await store.reconcileAccess(scope, base, next, newEntries, removed, visible));
            } catch (err) {
              resolve({ applied: false, dropped: [] });
              throw err;
            }
          });
        });
        if (!outcome.applied || generation !== s.cacheGeneration || !s.serverCache) return false;
        dropped = [.../* @__PURE__ */ new Set([...outcome.dropped, ...[...s.serverCache.keys()].filter((id) => !visible.has(id))])];
      }
      for (const id of dropped) {
        deps.forgetItemFacts(id);
        s.serverCache.delete(id);
        s.deltaIds.delete(id);
        s.storeMisses.add(id);
      }
      const redrawn = [];
      for (const [id, entry] of newEntries) {
        if (entryChanged(s.serverCache.get(id), entry)) redrawn.push(id);
        deps.forgetItemFacts(id);
        s.serverCache.set(id, entry);
        s.storeMisses.delete(id);
        s.deltaIds.add(id);
      }
      for (const id of removed) {
        deps.forgetItemFacts(id);
        s.serverCache.delete(id);
        s.deltaIds.delete(id);
        s.storeMisses.add(id);
      }
      s.serverCacheTimestamp = cursorOf(resp);
      s.serverFilterRevision = revision;
      const changedIds = newEntries.map((e) => e[0]).concat(removed, dropped);
      if (changedIds.length > 0) {
        for (const [, renderer] of s.renderers) {
          if (renderer.onServerCacheRefresh) {
            try {
              renderer.onServerCacheRefresh(changedIds);
            } catch {
            }
          }
        }
        deps.refreshVisibleCards(redrawn.concat(removed, dropped), dropped);
      }
      console.log(`${logPrefix} Access changed: +${newEntries.length} items, -${removed.length + dropped.length} no longer visible`);
      return true;
    }
    async function fetchDeltaCore() {
      const gate = s.storeGate;
      const confirming = !!gate;
      const startGeneration = s.cacheGeneration;
      let settled = false;
      try {
        if (!s.serverCache || !s.serverCacheTimestamp) return;
        const userId = deps.apiClient().getCurrentUserId();
        if (!userId) return;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const generation = s.cacheGeneration;
        const base = { timestamp: s.serverCacheTimestamp, version: s.serverCacheVersion, filterRevision: s.serverFilterRevision };
        const requestedAt = performance.now();
        const resp = await deps.apiClient().ajax({
          type: "GET",
          url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-cache/${userId}?since=${base.timestamp}&known=${encodeURIComponent(base.filterRevision || "")}`),
          dataType: "json"
        });
        if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
        if (!export42(resp) || !resp.items || !s.serverCache || generation !== s.cacheGeneration) return;
        deps.applyReviewRatings(resp, requestedAt);
        const revision = textOrEmpty(resp.filterRevision);
        const rolledBack = typeof resp.timestamp === "number" && resp.timestamp < base.timestamp;
        if (resp.version === s.serverCacheVersion && !rolledBack && revision !== s.serverFilterRevision && await reconcileAccess(resp, base, generation)) {
          settled = true;
          if (confirming) console.log(`${logPrefix} Stored copy confirmed current after an access change`);
          return;
        }
        if (resp.version !== s.serverCacheVersion || revision !== s.serverFilterRevision || rolledBack) {
          const why = resp.version !== s.serverCacheVersion ? "Cache version changed" : rolledBack ? "Server cache went back in time" : "Access or Spoiler Guard filter changed";
          if (confirming) {
            console.log(`${logPrefix} ${why}; replacing the stored copy with a full download`);
            settled = await deps.downloadFullCache({ fresh: true });
            for (const [, renderer] of s.renderers) {
              if (renderer.onServerCacheRefresh) {
                try {
                  renderer.onServerCacheRefresh(null, { replaced: true });
                } catch {
                }
              }
            }
            deps.refreshVisibleCards();
          } else if (revision !== s.serverFilterRevision) {
            console.log(`${logPrefix} ${why}; reloading the full cache`);
            setTimeout(() => {
              deps.api.invalidateServerCache().catch(() => {
              });
            }, 0);
          } else {
            console.log(`${logPrefix} ${why}, reloading full cache`);
            await deps.downloadFullCache({ fresh: true });
            for (const [, renderer] of s.renderers) {
              if (renderer.onServerCacheRefresh) {
                try {
                  renderer.onServerCacheRefresh(null, { replaced: true });
                } catch {
                }
              }
            }
            deps.refreshVisibleCards();
          }
          return;
        }
        const newEntries = entryPairs(resp.items);
        const carried = export10(resp.items);
        const removed = export122(resp.removed).filter((id) => !(id in carried));
        if (newEntries.length > 0 || removed.length > 0) {
          const redrawn = [];
          for (const [id, entry] of newEntries) {
            if (entryChanged(s.serverCache.get(id), entry)) redrawn.push(id);
            deps.forgetItemFacts(id);
            s.serverCache.set(id, entry);
            s.storeMisses.delete(id);
            s.deltaIds.add(id);
          }
          for (const id of removed) {
            deps.forgetItemFacts(id);
            s.serverCache.delete(id);
            s.deltaIds.delete(id);
            s.storeMisses.add(id);
          }
          s.serverCacheTimestamp = cursorOf(resp);
          deps.persistDelta(newEntries, base, cursorOf(resp), servedAtOf(resp), removed);
          const changedIds = newEntries.map((e) => e[0]).concat(removed);
          for (const [, renderer] of s.renderers) {
            if (renderer.onServerCacheRefresh) {
              try {
                renderer.onServerCacheRefresh(changedIds);
              } catch {
              }
            }
          }
          deps.refreshVisibleCards(redrawn.concat(removed));
          console.log(`${logPrefix} Server cache updated: +${newEntries.length} items, -${removed.length} removed`);
        }
        settled = true;
        if (confirming) console.log(`${logPrefix} Stored copy confirmed current`);
      } catch (err) {
        console.warn(`${logPrefix} Failed to refresh server cache:`, err);
      } finally {
        if (confirming) {
          if (!settled && s.cacheGeneration === startGeneration) deps.dropServerCache();
          deps.releaseStoreGate(gate);
        }
      }
    }
    function lookupServerEntries(ids) {
      if (s.storeGate) return s.storeGate.then(() => lookupServerEntries(ids));
      const found = /* @__PURE__ */ new Map();
      if (!s.serverCache) return found;
      let missing = null;
      for (const id of ids) {
        const entry = s.serverCache.get(id);
        if (entry) {
          found.set(id, entry);
        } else if (!s.serverCacheComplete && s.storeScope && !s.storeMisses.has(id)) {
          (missing = missing || []).push(id);
        }
      }
      if (!missing) return found;
      const scope = s.storeScope;
      const store = JE.tagCacheStore;
      const generation = s.cacheGeneration;
      if (!scope || !store) return found;
      const wanted = missing;
      return store.getMany(scope, wanted).then(({ entries: read, meta }) => {
        if (s.storeScope !== scope || !s.serverCache || generation !== s.cacheGeneration) {
          return lookupServerEntries(ids);
        }
        const usable = !!meta && !meta.pending && meta.version === s.serverCacheVersion && meta.filterRevision === s.serverFilterRevision && Number(meta.servedAt || 0) >= s.storeBaseServedAt;
        const stored = usable ? read : /* @__PURE__ */ new Map();
        if (s.serverCache.size + stored.size > MEMORY_SOFT_CAP) {
          const keep = [];
          for (const id of s.deltaIds) {
            const entry = s.serverCache.get(id);
            if (entry) keep.push([id, entry]);
          }
          s.serverCache.clear();
          for (const [id, entry] of keep) s.serverCache.set(id, entry);
        }
        for (const id of wanted) {
          const current = s.serverCache.get(id);
          if (current) {
            found.set(id, current);
            continue;
          }
          if (s.storeMisses.has(id)) continue;
          const entry = stored.get(id);
          if (entry) {
            found.set(id, entry);
            s.serverCache.set(id, entry);
          } else {
            s.storeMisses.add(id);
          }
        }
        return found;
      }).catch((err) => {
        console.warn(`${logPrefix} Stored server cache read failed:`, err);
        return found;
      });
    }
    return { navigationRoute, scheduleNavigationRefresh, refreshServerCacheCore, fetchDelta, lookupServerEntries };
  }

  // client/src/features/media-tags/pipeline/item-facts.ts
  var ITEM_FACTS_TTL_MS = 10 * 60 * 1e3;
  function createItemFacts(s, JE, deps) {
    function advanceBatchGeneration() {
      s.batchGeneration++;
      s.cancelBatchWait?.();
    }
    function forgetItemFacts(id) {
      const saved = s.itemFacts.get(id);
      if (saved?.seasonKey && s.seasonFactIds.get(saved.seasonKey) === id) s.seasonFactIds.delete(saved.seasonKey);
      s.itemFacts.delete(id);
    }
    function rememberItemFacts(entry, id = entry.Id, fetchedAt = Date.now()) {
      if (!id || entry.Type !== "Series" && entry.Type !== "Season") return;
      const itemId = export8(id);
      if (!Number.isFinite(fetchedAt) || fetchedAt + ITEM_FACTS_TTL_MS <= Date.now() || (s.itemFacts.get(itemId)?.fetchedAt ?? -Infinity) > fetchedAt) return;
      forgetItemFacts(itemId);
      const seriesId = entry.SeriesId ? export8(entry.SeriesId) : null;
      const seasonKey = entry.Type === "Season" && seriesId ? `${seriesId}:${entry.SeasonNumber ?? entry.IndexNumber}` : null;
      if (seasonKey) {
        const previousId = s.seasonFactIds.get(seasonKey);
        if (previousId) forgetItemFacts(previousId);
        s.seasonFactIds.set(seasonKey, itemId);
      }
      s.itemFacts.set(itemId, { entry, fetchedAt, expires: fetchedAt + ITEM_FACTS_TTL_MS, seasonKey });
      for (const oldest of s.itemFacts.keys()) {
        if (s.itemFacts.size <= MEMORY_SOFT_CAP) break;
        forgetItemFacts(oldest);
      }
      for (const [key, seasonId] of s.seasonFactIds) {
        if (s.seasonFactIds.size <= MEMORY_SOFT_CAP) break;
        s.seasonFactIds.delete(key);
        forgetItemFacts(seasonId);
      }
    }
    function peekItemFacts(id) {
      const entry = s.serverCache?.get(id);
      if (entry) return entry;
      const saved = s.itemFacts.get(id);
      if (saved && saved.expires > Date.now()) return saved.entry;
      forgetItemFacts(id);
      return null;
    }
    async function lookupItemFacts(ids) {
      const generation = s.cacheGeneration;
      const epoch = JE.session ? JE.session.getEpoch() : 0;
      await deps.lookupServerEntries(ids);
      if (generation !== s.cacheGeneration || JE.session && !JE.session.isCurrent(epoch)) return;
      const missing = [...new Set(ids)].filter((id) => !peekItemFacts(id));
      const userId = deps.apiClient().getCurrentUserId();
      if (!userId) return;
      for (let i = 0; i < missing.length; i += 200) {
        try {
          const response = export10(await deps.apiClient().ajax({
            type: "POST",
            url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`, { latestEpisode: true }),
            data: JSON.stringify(missing.slice(i, i + 200)),
            contentType: "application/json",
            dataType: "json"
          }));
          if (generation !== s.cacheGeneration || JE.session && !JE.session.isCurrent(epoch)) return;
          for (const entry of export7(response.Items)) rememberItemFacts(export5(entry));
        } catch {
        }
      }
    }
    function peekSeasonFacts(seriesId, season) {
      const id = s.seasonFactIds.get(`${seriesId}:${season}`);
      return id ? peekItemFacts(id) : null;
    }
    return { advanceBatchGeneration, forgetItemFacts, rememberItemFacts, peekItemFacts, lookupItemFacts, peekSeasonFacts };
  }

  // client/src/features/media-tags/pipeline/look-facts.ts
  var LOOK_FACTS_KEY = "JE_tagLookFacts";
  var LOOK_FACTS_MAX = 3e3;
  var LOOK_FACT_FIELDS = ["Type", "SeriesId", "LibraryId", "Genres", "OfficialRating"];
  function createLookFacts(s, JE, deps) {
    function lookFactsPersist() {
      return JE.pluginConfig?.TagCacheServerMode === false || JE.pluginConfig?.EnableTagsLocalStorageFallback === true;
    }
    function lookFactsMap() {
      if (s.lookFacts) return s.lookFacts;
      s.lookFacts = /* @__PURE__ */ new Map();
      if (!lookFactsPersist()) return s.lookFacts;
      try {
        const ownerKey = `${LOOK_FACTS_KEY}:identity-owner`;
        const userId = JE.session?.getUserId?.() || (deps.hasApiClient() ? deps.apiClient().getCurrentUserId?.() : null) || "";
        const owner = `${JE.session?.getServerId?.() || ""}:${userId}`;
        if (localStorage.getItem(ownerKey) !== owner) {
          localStorage.removeItem(LOOK_FACTS_KEY);
          localStorage.setItem(ownerKey, owner);
          return s.lookFacts;
        }
        const stored = JSON.parse(localStorage.getItem(LOOK_FACTS_KEY) || "{}");
        const clearedAt = Number(JE.pluginConfig?.ClearLocalStorageTimestamp || 0);
        if (export42(stored)) {
          for (const [id, facts] of Object.entries(stored)) {
            if (export42(facts) && Number(facts.at) > clearedAt) s.lookFacts.set(id, facts);
          }
          if (s.lookFacts.size !== Object.keys(stored).length) saveLookFacts();
        }
      } catch (err) {
        console.warn(`${logPrefix} Ignoring unreadable tag look facts`, err);
      }
      return s.lookFacts;
    }
    function saveLookFacts() {
      if (!s.lookFacts || !lookFactsPersist()) return;
      try {
        localStorage.setItem(LOOK_FACTS_KEY, JSON.stringify(Object.fromEntries(s.lookFacts)));
      } catch (err) {
        console.warn(`${logPrefix} Failed to save tag look facts`, err);
      }
    }
    function rememberLookFacts(itemId, item, source = "tag-data") {
      if (!itemId || !item) return;
      const facts = { at: Date.now(), source };
      for (const field of LOOK_FACT_FIELDS) {
        if (item[field] !== void 0 && item[field] !== null) facts[field] = item[field];
      }
      const map = lookFactsMap();
      map.delete(itemId);
      map.set(itemId, facts);
      for (const oldest of map.keys()) {
        if (map.size <= LOOK_FACTS_MAX) break;
        map.delete(oldest);
      }
      if (!lookFactsPersist() || !JE._cacheManager) return;
      if (!s.lookFactsSaveRegistered) {
        JE._cacheManager.register(saveLookFacts);
        s.lookFactsSaveRegistered = true;
      }
      JE._cacheManager.markDirty();
    }
    function enrichedLookFacts(facts) {
      return !!facts && (facts.source === "tag-data" || facts.source == null && /^[a-f0-9]{32}$/i.test(String(facts.LibraryId || "")));
    }
    function needsLibraryFacts() {
      return !!JE.core.tagLook?.read().rules.some((rule) => rule.enabled && rule.when.some((cond) => cond.field === "library"));
    }
    async function itemLookFacts(itemId) {
      const serverEntry = s.serverCache?.get(itemId);
      if (serverEntry) return serverEntry;
      const known = lookFactsMap().get(itemId);
      if (known && enrichedLookFacts(known)) return known;
      const userId = deps.apiClient().getCurrentUserId();
      const epoch = JE.session?.getEpoch?.();
      const response = export10(await deps.apiClient().ajax({
        type: "POST",
        // With the episode and collection-member dates: the Status renderer draws (and keeps) this answer.
        url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`, { latestEpisode: true }),
        data: JSON.stringify([itemId]),
        contentType: "application/json",
        dataType: "json"
      }));
      if (userId !== deps.apiClient().getCurrentUserId() || epoch !== JE.session?.getEpoch?.()) return null;
      const item = export11(response.Items).find((i) => export8(i.Id ?? "") === itemId) || null;
      if (item) rememberLookFacts(itemId, item);
      return item;
    }
    return { lookFactsMap, rememberLookFacts, enrichedLookFacts, needsLibraryFacts, itemLookFacts };
  }

  // client/src/features/media-tags/pipeline/queue.ts
  var FETCH_DEBOUNCE_MS = 150;
  var RENDER_YIELD_CHUNK = 40;
  var SERVER_BATCH_LIMIT = 200;
  function createQueue(s, JE, deps) {
    function scheduleFetch() {
      if (s.requestQueue.length === 0 || s.isProcessing) return;
      if (s.fetchTimer) clearTimeout(s.fetchTimer);
      s.fetchTimer = setTimeout(() => {
        s.fetchTimer = null;
        processQueue();
      }, FETCH_DEBOUNCE_MS);
    }
    async function processQueue() {
      if (s.isProcessing || s.requestQueue.length === 0) return;
      s.isProcessing = true;
      let cancel = () => {
      };
      const cancelled = new Promise((resolve) => {
        cancel = resolve;
      });
      s.cancelBatchWait = cancel;
      try {
        const myGeneration = s.batchGeneration;
        while (s.requestQueue.length > 0) {
          if (myGeneration !== s.batchGeneration) break;
          const batch = s.requestQueue.splice(0, SERVER_BATCH_LIMIT).filter((entry) => entry.el.isConnected && deps.stillShows(entry));
          if (batch.length === 0) continue;
          s.activeBatch = batch;
          await Promise.race([processBatch(batch, myGeneration), cancelled]);
          if (myGeneration !== s.batchGeneration) break;
          s.activeBatch = [];
          for (const entry of batch) {
            if (entry.awaiting) JE.core.tagLayout?.releaseCardContext?.(entry.renderTarget, entry.awaiting);
          }
        }
      } finally {
        if (s.cancelBatchWait === cancel) s.cancelBatchWait = null;
        s.activeBatch = [];
        s.isProcessing = false;
        scheduleFetch();
      }
    }
    async function processBatch(batch, generation) {
      const userId = deps.apiClient().getCurrentUserId();
      if (!userId) return;
      const epoch = JE.session?.getEpoch?.();
      const isCurrent = () => generation === s.batchGeneration && userId === deps.apiClient().getCurrentUserId() && epoch === JE.session?.getEpoch?.();
      const elMap = /* @__PURE__ */ new Map();
      for (const b of batch) {
        const sameItem = elMap.get(b.itemId);
        if (sameItem) sameItem.push(b);
        else elMap.set(b.itemId, [b]);
      }
      const ids = [...elMap.keys()];
      let needsLatestEpisode = false;
      for (const [, r] of s.renderers) {
        if (r.isEnabled() && r.needsLatestEpisode) {
          needsLatestEpisode = true;
          break;
        }
      }
      try {
        const response = export10(await deps.apiClient().ajax({
          type: "POST",
          url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`, needsLatestEpisode ? { latestEpisode: true } : void 0),
          data: JSON.stringify(ids),
          contentType: "application/json",
          dataType: "json"
        }));
        const answered = export7(response.Items);
        if (!isCurrent()) return;
        if (needsLatestEpisode) answered.forEach((item) => deps.rememberItemFacts(export5(item)));
        const items = answered.map(export5);
        const stripRevision = typeof response.StripRevision === "string" ? response.StripRevision : null;
        s.tagStripRevision = stripRevision;
        const parentSeriesNeeded = /* @__PURE__ */ new Set();
        for (const item of items) {
          const seriesId = export3(item.SeriesId);
          if ((item.Type === "Season" || item.Type === "Episode") && seriesId && !item.CommunityRating && !item.CriticRating) {
            parentSeriesNeeded.add(seriesId);
          }
          if (item.Type === "Season" && seriesId) {
            parentSeriesNeeded.add(seriesId);
          }
        }
        const parentSeriesMap = /* @__PURE__ */ new Map();
        for (const item of items) {
          if (item.Id === void 0 || item.Id === null) throw new TypeError("A tag-data item has no id");
          parentSeriesMap.set(export8(item.Id), item);
        }
        for (const seriesId of parentSeriesNeeded) {
          const normalizedId = export8(seriesId);
          if (!parentSeriesMap.has(normalizedId)) {
            try {
              const parent = await deps.getParentSeries(userId, seriesId);
              if (!isCurrent()) return;
              if (parent) parentSeriesMap.set(normalizedId, parent);
            } catch {
            }
          }
        }
        let pendingHosts = [];
        const stackPendingHosts = () => {
          if (pendingHosts.length === 0) return;
          JE.core.tagRenderer.applyCornerStacking(pendingHosts);
          pendingHosts = [];
        };
        const renderItem = (item, firstEpisode) => {
          if (!isCurrent()) return;
          const itemId = export8(item.Id);
          const batchEntries = elMap.get(itemId);
          if (!batchEntries || batchEntries.length === 0) return;
          if (!isMediaType(item.Type)) return;
          deps.rememberLookFacts(itemId, item);
          let parentSeries = null;
          let ratingParentSeries = null;
          if (item.SeriesId) {
            const parentId = export8(item.SeriesId);
            parentSeries = parentSeriesMap.get(parentId) || null;
            if ((item.Type === "Season" || item.Type === "Episode") && !item.CommunityRating && !item.CriticRating) {
              ratingParentSeries = parentSeries;
            }
          }
          for (const entry of batchEntries) {
            let { el, renderTarget } = entry;
            if (!deps.stillShows(entry)) continue;
            if (!renderTarget.isConnected) {
              if (!el.isConnected) continue;
              renderTarget = deps.resolveRenderTarget(el);
            }
            const extras = { firstEpisode, parentSeries, ratingParentSeries, renderTarget, stripRevision };
            if (JE.core.tagLayout?.setCardContext?.(renderTarget, item, itemId, entry.cardId) === false) continue;
            for (const [name, renderer] of s.renderers) {
              if (!renderer.isEnabled()) continue;
              try {
                renderer.render(renderTarget, item, extras);
              } catch (err) {
                console.warn(`${logPrefix} Renderer "${name}" failed for item ${itemId}:`, err);
              }
            }
            pendingHosts.push(renderTarget);
          }
        };
        let anyNeedsFirstEp = false;
        for (const [, r] of s.renderers) {
          if (r.isEnabled() && r.needsFirstEpisode) {
            anyNeedsFirstEp = true;
            break;
          }
        }
        const pendingFirstEps = [];
        let renderedSinceYield = 0;
        for (const item of items) {
          const firstEpisode = export42(item.FirstEpisode) ? item.FirstEpisode : null;
          if (anyNeedsFirstEp && firstEpisode?.NeedsStreamFetch) {
            pendingFirstEps.push(
              deps.getFirstEpisode(userId, String(item.Id), export3(firstEpisode.Id)).then((ep) => renderItem(item, ep)).catch(() => renderItem(item, null)).then(() => {
                for (const host of pendingHosts) JE.core.tagRenderer.scheduleCornerStacking(host);
                pendingHosts = [];
              })
            );
          } else {
            renderItem(item, firstEpisode);
            if (++renderedSinceYield >= RENDER_YIELD_CHUNK) {
              renderedSinceYield = 0;
              stackPendingHosts();
              await deps.idleYield();
              if (!isCurrent()) return;
            }
          }
        }
        stackPendingHosts();
        if (pendingFirstEps.length > 0) {
          await Promise.all(pendingFirstEps);
        }
      } catch (err) {
        if (!isCurrent()) return;
        console.warn(`${logPrefix} Batch fetch failed, falling back to individual fetches:`, err);
        for (const queued of batch) {
          const { el, renderTarget: queuedRenderTarget, itemId, cardId } = queued;
          if (!isCurrent()) break;
          try {
            const item = JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId, { userId }) : await deps.apiClient().getItem(userId, itemId);
            if (!isCurrent()) return;
            if (!export42(item) || !isMediaType(item.Type)) continue;
            deps.rememberLookFacts(itemId, item, "item");
            const firstEpisode = item.Type === "Series" || item.Type === "Season" ? await deps.getFirstEpisode(userId, String(item.Id)) : null;
            if (!isCurrent()) break;
            if (!deps.stillShows(queued)) continue;
            let renderTarget = queuedRenderTarget;
            if (!renderTarget.isConnected) {
              if (!el.isConnected) continue;
              renderTarget = deps.resolveRenderTarget(el);
            }
            const extras = { firstEpisode, parentSeries: null, ratingParentSeries: null, renderTarget, stripRevision: null };
            const layout = JE.core.tagLayout;
            if (layout?.cardIdentity && layout.cardIdentity(renderTarget) !== cardId) continue;
            if (!deps.needsLibraryFacts() && layout?.setCardContext?.(renderTarget, item, itemId, cardId) === false) continue;
            for (const [, renderer] of s.renderers) {
              if (!renderer.isEnabled()) continue;
              try {
                renderer.render(renderTarget, item, extras);
              } catch {
              }
            }
            JE.core.tagRenderer.applyCornerStacking(renderTarget);
          } catch {
          }
        }
      }
    }
    return { scheduleFetch };
  }

  // client/src/features/media-tags/pipeline/renderers.ts
  var TAG_SETTING_KEYS = ["qualityTagsEnabled", "genreTagsEnabled", "ratingTagsEnabled", "ageRatingTagsEnabled", "statusTagsEnabled", "languageTagsEnabled", "awardsTagsEnabled", "logoTagsEnabled", "customTagsEnabled"];
  var PIPELINE_SKIP_SELECTORS = [
    ".chapterCardImageContainer",
    // Scenes / chapters
    "#indexPage .verticalSection.MyMedia .cardImageContainer",
    // My Media row
    ".formDialog .cardImageContainer",
    // Modal dialogs
    "#pluginsPage .cardImageContainer",
    // Admin pages
    "#pluginCatalogPage .cardImageContainer",
    "#devicesPage .cardImageContainer",
    "#mediaLibraryPage .cardImageContainer",
    ".listItemImage:not(.listItemImage-large)",
    // Small list rows (Playlists, Albums); listItemImage-large (e.g. episode lists) is big enough for overlays
    ".jellyseerr-card .cardImageContainer"
    // Seerr cards (search, discovery, recommendations): TMDB posters, no Jellyfin item id, so they can never get tags — mark them processed instead of re-walking them on every scan
  ];
  var PIPELINE_SKIP_SELECTOR = PIPELINE_SKIP_SELECTORS.join(", ");
  function createRenderers(s, JE, deps) {
    function shouldSkipElement(el) {
      return el.closest(PIPELINE_SKIP_SELECTOR) !== null;
    }
    function registerRenderer(name, config) {
      s.renderers.set(name, {
        render: config.render,
        renderFromCache: config.renderFromCache || null,
        renderFromServerCache: config.renderFromServerCache || null,
        onServerCacheRefresh: config.onServerCacheRefresh || null,
        isEnabled: config.isEnabled,
        needsFirstEpisode: config.needsFirstEpisode || false,
        needsParentSeries: config.needsParentSeries || false,
        needsLatestEpisode: config.needsLatestEpisode || false,
        injectCss: config.injectCss || null,
        cleanup: config.cleanup || null
      });
      if (config.injectCss) {
        try {
          config.injectCss();
        } catch (e) {
          console.warn(`${logPrefix} Failed to inject CSS for ${name}:`, e);
        }
      }
      console.log(`${logPrefix} Renderer registered: ${name} (total: ${s.renderers.size})`);
      if (s.startWhenRendererRegisters && anyTagTypeEnabled()) {
        s.loadStartedForEpoch = JE.session?.getEpoch?.() ?? null;
        deps.initialize();
        return;
      }
      if (s.deferredLoad && anyTagTypeEnabled()) {
        const { forceDownload } = s.deferredLoad;
        s.deferredLoad = null;
        s.loadStartedForEpoch = JE.session?.getEpoch?.() ?? null;
        deps.api.invalidateServerCache({ reuseStored: !forceDownload }).catch(() => {
        });
        return;
      }
      s.processedCards = /* @__PURE__ */ new WeakSet();
      deps.scheduleScan();
    }
    function anyTagTypeEnabled() {
      return TAG_SETTING_KEYS.some((key) => !!JE.currentSettings?.[key]) || hasAnyEnabledRenderer();
    }
    function hasAnyEnabledRenderer() {
      for (const [, r] of s.renderers) {
        if (r.isEnabled()) return true;
      }
      return false;
    }
    return { shouldSkipElement, registerRenderer, anyTagTypeEnabled, hasAnyEnabledRenderer };
  }

  // client/src/features/media-tags/pipeline/scan.ts
  var CHUNK_BUDGET_MS = 8;
  var CHUNK_MIN_CARDS = 4;
  var CHUNK_MAX_CARDS = 40;
  var CARD_IMAGE_SELECTOR = ".cardImageContainer, div.listItemImage";
  function createScan(s, JE, deps) {
    const scheduleIdle = typeof requestIdleCallback === "function" ? (fn) => requestIdleCallback(fn, { timeout: 500 }) : (fn) => setTimeout(fn, 16);
    function idleYield() {
      return new Promise((resolve) => scheduleIdle(resolve));
    }
    function scheduleScan() {
      if (s.scanScheduled) return;
      s.scanScheduled = true;
      scheduleIdle(() => {
        s.scanScheduled = false;
        runScan();
      });
    }
    function recordRenderCost(elapsedMs, cards) {
      if (cards <= 0) return;
      s.msPerCard = s.msPerCard * 0.5 + elapsedMs / cards * 0.5;
    }
    function renderCard(card, serverEntry, hosts) {
      const { el, itemId, itemType } = card;
      const renderTarget = resolveRenderTarget(el);
      const layout = JE.core.tagLayout;
      const cardId = layout?.cardIdentity?.(renderTarget) ?? "";
      const remembered = deps.lookFactsMap().get(itemId);
      const known = serverEntry || (!deps.needsLibraryFacts() || deps.enrichedLookFacts(remembered) ? remembered : null);
      let awaiting = false;
      if (known) layout?.setCardContext?.(renderTarget, known, itemId, cardId);
      else awaiting = layout?.awaitCardContext?.(renderTarget, cardId, itemType);
      JE.core.tagLayout?.prepareCard(renderTarget);
      if (serverEntry) {
        for (const [, renderer] of s.renderers) {
          if (!renderer.isEnabled()) continue;
          if (renderer.renderFromServerCache) {
            try {
              renderer.renderFromServerCache(renderTarget, serverEntry, itemId);
            } catch {
            }
          }
        }
        hosts.push(renderTarget);
        return;
      }
      let allCacheHits = true;
      for (const [, renderer] of s.renderers) {
        if (!renderer.isEnabled()) continue;
        if (renderer.renderFromCache) {
          if (!renderer.renderFromCache(renderTarget, itemId)) allCacheHits = false;
        } else {
          allCacheHits = false;
        }
      }
      hosts.push(renderTarget);
      if (!allCacheHits || awaiting) {
        s.requestQueue.push({ el, renderTarget, itemId, itemType, cardId, awaiting, reuse: card.reuse });
      }
    }
    function runScan() {
      if (s.isInvalidating) return;
      if (!deps.hasAnyEnabledRenderer()) return;
      if (!deps.hasApiClient()) return;
      const elements = document.querySelectorAll(".cardImageContainer, div.listItemImage");
      const unprocessed = [];
      for (const el of elements) {
        if (!s.processedCards.has(el)) unprocessed.push(el);
        else JE.core.tagLayout?.resumePresentation?.(el.closest(".cardScalable") || el);
      }
      if (unprocessed.length === 0) return;
      const myGeneration = ++s.scanGeneration;
      let index = 0;
      function continueScan() {
        if (index < unprocessed.length) {
          scheduleIdle(processChunk);
        } else {
          deps.scheduleFetch();
        }
      }
      function renderChunk(chunk, entries) {
        const started = performance.now();
        const hosts = [];
        for (const card of chunk) {
          if (!card.el.isConnected) {
            s.processedCards.delete(card.el);
            continue;
          }
          if (!stillShows(card)) continue;
          renderCard(card, entries.get(card.itemId), hosts);
        }
        JE.core.tagRenderer.applyCornerStacking(hosts);
        recordRenderCost(performance.now() - started, chunk.length);
        continueScan();
      }
      function processChunk() {
        if (myGeneration !== s.scanGeneration) return;
        const limit = Math.max(CHUNK_MIN_CARDS, Math.min(CHUNK_MAX_CARDS, Math.floor(CHUNK_BUDGET_MS / Math.max(s.msPerCard, 0.05))));
        const chunk = [];
        const ids = [];
        for (; index < unprocessed.length && chunk.length < limit; index++) {
          const el = unprocessed[index];
          if (!el || s.processedCards.has(el)) continue;
          if (!el.isConnected) continue;
          const card = el.closest(".card");
          if (card && card.classList.contains("je-hidden")) continue;
          const listItem = el.closest(".listItem");
          if (listItem && listItem.classList.contains("je-hidden")) continue;
          if (deps.shouldSkipElement(el)) {
            s.processedCards.add(el);
            continue;
          }
          const itemId = getItemId(el);
          if (!itemId) continue;
          const itemType = getItemType(el);
          if (itemType && !isMediaType(itemType)) {
            s.processedCards.add(el);
            continue;
          }
          s.processedCards.add(el);
          chunk.push({ el, itemId, itemType, reuse: s.cardReuse.get(el) || 0 });
          ids.push(itemId);
        }
        if (chunk.length === 0) {
          continueScan();
          return;
        }
        const lookup = deps.lookupServerEntries(ids);
        if (lookup instanceof Map) {
          renderChunk(chunk, lookup);
          return;
        }
        lookup.then((entries) => {
          if (myGeneration !== s.scanGeneration) {
            for (const card of chunk) if (stillShows(card)) s.processedCards.delete(card.el);
            scheduleScan();
            return;
          }
          renderChunk(chunk, entries);
        });
      }
      processChunk();
    }
    function resolveRenderTarget(el) {
      const scalable = el.closest(".cardScalable");
      if (!scalable) return el;
      const overlay = scalable.querySelector(".cardOverlayContainer");
      if (!overlay) return scalable;
      let tagHost = scalable.querySelector(".je-tag-host");
      if (!tagHost) {
        tagHost = document.createElement("div");
        tagHost.className = "je-tag-host";
        scalable.insertBefore(tagHost, overlay);
      }
      return tagHost;
    }
    function stillShows(card) {
      return (s.cardReuse.get(card.el) || 0) === card.reuse;
    }
    function imageItemId(text) {
      const match = text ? /Items\/([a-f0-9]{32})\//i.exec(text) : null;
      return match?.[1] ? match[1].toLowerCase() : "";
    }
    function isIdentityChange(record) {
      const target = record.target;
      if (!(target instanceof Element) || !record.attributeName) return false;
      if (record.attributeName === "style") {
        if (!target.matches(CARD_IMAGE_SELECTOR)) return false;
        const before = imageItemId(record.oldValue);
        const after = imageItemId(target.getAttribute("style"));
        return !!before && !!after && before !== after;
      }
      const norm = (value) => (value || "").replace(/-/g, "").toLowerCase();
      return norm(target.getAttribute(record.attributeName)) !== norm(record.oldValue);
    }
    function releaseReusedCards(mutations) {
      let released = false;
      for (const record of mutations) {
        if (!isIdentityChange(record)) continue;
        const target = record.target;
        if (!(target instanceof HTMLElement)) continue;
        const images = target.matches(CARD_IMAGE_SELECTOR) ? [target] : Array.from(target.querySelectorAll(CARD_IMAGE_SELECTOR));
        for (const el of images) {
          const owner = el.closest(".cardScalable") || el;
          const hasHost = Array.from(owner.children).some((c) => c.classList.contains("je-tag-host"));
          if (!s.processedCards.has(el) && !hasHost) continue;
          s.processedCards.delete(el);
          s.cardReuse.set(el, (s.cardReuse.get(el) || 0) + 1);
          JE.core.tagLayout?.clearCard(owner);
          released = true;
        }
      }
      if (released) scheduleScan();
    }
    function refreshVisibleCards(updatedIds = null, hiddenIds = []) {
      const changed = updatedIds ? new Set(updatedIds) : null;
      const hidden = new Set(hiddenIds);
      let released = false;
      for (const el of document.querySelectorAll(CARD_IMAGE_SELECTOR)) {
        const itemId = getItemId(el);
        if (!itemId || changed && !changed.has(itemId)) continue;
        s.cardReuse.set(el, (s.cardReuse.get(el) || 0) + 1);
        JE.core.tagLayout?.clearCard(el.closest(".cardScalable") || el);
        if (hidden.has(itemId)) s.processedCards.add(el);
        else {
          s.processedCards.delete(el);
          released = true;
        }
      }
      if (released) scheduleScan();
    }
    function getItemId(el) {
      const parent = el.closest("[data-id]") || el.closest("[data-itemid]");
      const attrId = parent?.getAttribute("data-id") || parent?.getAttribute("data-itemid");
      const itemId = attrId ? attrId.replace(/-/g, "").toLowerCase() : null;
      if (itemId && /^[a-f0-9]{32}$/.test(itemId)) return itemId;
      return imageItemId(el.style?.backgroundImage) || itemId;
    }
    function getItemType(el) {
      const parent = el.closest("[data-type]");
      return parent?.getAttribute("data-type") || null;
    }
    return { idleYield, scheduleScan, runScan, resolveRenderTarget, stillShows, releaseReusedCards, refreshVisibleCards };
  }

  // client/src/features/media-tags/pipeline/series-lookup.ts
  function createSeriesLookup(s, JE, deps) {
    async function getFirstEpisode(userId, parentId, firstEpisodeId = null) {
      const cached = s.firstEpisodeCache.get(parentId);
      if (cached) return cached;
      const promise = (async () => {
        if (firstEpisodeId) {
          try {
            const enriched = export10(await deps.apiClient().ajax({
              type: "POST",
              url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
              data: JSON.stringify([firstEpisodeId]),
              contentType: "application/json",
              dataType: "json"
            }));
            const episode = firstItem(enriched);
            if (episode) return episode;
          } catch {
          }
        }
        try {
          const response = export10(await deps.apiClient().ajax({
            type: "GET",
            url: deps.apiClient().getUrl("/Items", {
              ParentId: parentId,
              IncludeItemTypes: "Episode",
              IsVirtualItem: false,
              Recursive: true,
              SortBy: "PremiereDate",
              SortOrder: "Ascending",
              Limit: 1,
              Fields: "MediaStreams,MediaSources,Genres",
              userId
            }),
            dataType: "json"
          }));
          const episode = firstItem(response);
          if (!episode?.Id) return episode;
          try {
            const enriched = export10(await deps.apiClient().ajax({
              type: "POST",
              url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
              data: JSON.stringify([episode.Id]),
              contentType: "application/json",
              dataType: "json"
            }));
            return firstItem(enriched) || episode;
          } catch {
            return episode;
          }
        } catch {
          return null;
        }
      })();
      s.firstEpisodeCache.set(parentId, promise);
      return promise;
    }
    async function getParentSeries(userId, seriesId) {
      const cached = s.parentSeriesCache.get(seriesId);
      if (cached) return cached;
      const promise = (async () => {
        try {
          const item = JE.helpers?.getItemCached ? await JE.helpers.getItemCached(seriesId, { userId }) : await deps.apiClient().getItem(userId, seriesId);
          return export42(item) ? item : null;
        } catch {
          return null;
        }
      })();
      s.parentSeriesCache.set(seriesId, promise);
      return promise;
    }
    return { getFirstEpisode, getParentSeries };
  }

  // client/src/features/media-tags/pipeline/server-cache.ts
  var SERVER_CACHE_WAIT_DELAYS = [2e3, 3e3, 5e3, 5e3, 1e4, 1e4, 15e3, 15e3, 3e4, 3e4, 3e4, 3e4, 6e4, 6e4];
  var PERSIST_SLICE = 250;
  var PERSIST_START_DELAY_MS = 1500;
  var FULL_LOAD_PAGE = 2e3;
  var FULL_LOAD_RESTARTS = 2;
  var FULL_LOAD_RESTART_DELAYS = [0, 1500, 4e3];
  function createServerCache(s, JE, deps) {
    function cacheScope() {
      const userId = JE.session?.getUserId() || deps.apiClient().getCurrentUserId();
      if (!userId) return null;
      return `${JE.session?.getServerId() || ""}:${userId}`;
    }
    function applyReviewRatings(resp, requestedAt) {
      if (requestedAt < s.reviewRatingsRequestedAt) return;
      s.reviewRatingsRequestedAt = requestedAt;
      const previous = s.reviewRatings;
      const raw = resp.reviewRatings;
      if (!export42(raw)) {
        s.reviewRatings = null;
      } else {
        const map = /* @__PURE__ */ new Map();
        for (const key in raw) {
          const value = raw[key];
          if (export42(value) && typeof value.average === "number" && Number.isFinite(value.average)) {
            map.set(key, value.average);
          }
        }
        s.reviewRatings = map;
      }
      notifyReviewRatingsChanged(previous, s.reviewRatings);
    }
    function notifyReviewRatingsChanged(previous, next) {
      if (s.reviewRatingsListeners.size === 0 || !previous && !next) return;
      let changed = null;
      if (previous && next) {
        changed = /* @__PURE__ */ new Set();
        for (const [key, value] of next) {
          if (previous.get(key) !== value) changed.add(key);
        }
        for (const key of previous.keys()) {
          if (!next.has(key)) changed.add(key);
        }
      }
      for (const listener of s.reviewRatingsListeners) {
        try {
          listener(changed);
        } catch (err) {
          console.warn(`${logPrefix} review ratings listener failed:`, err);
        }
      }
    }
    function dropServerCache() {
      s.itemFacts.clear();
      s.seasonFactIds.clear();
      s.serverCache = null;
      s.serverCacheComplete = false;
      s.serverCacheVersion = 0;
      s.serverCacheTimestamp = 0;
      s.serverFilterRevision = null;
      s.cacheGeneration++;
      s.storeBaseServedAt = 0;
      s.storeScope = null;
      s.storeMisses.clear();
      s.deltaIds.clear();
      s.persistGeneration++;
      releaseStoreGate();
    }
    function releaseStoreGate(gate) {
      if (gate !== void 0 && gate !== s.storeGate) return;
      const open = s.openStoreGate;
      s.storeGate = null;
      s.openStoreGate = null;
      if (open) open();
    }
    function queuePersist(work) {
      s.persistChain = s.persistChain.then(work).catch((err) => {
        console.warn(`${logPrefix} Could not persist the server cache; keeping it in memory only:`, err);
      });
    }
    function persistFullCache(scope, resp, entries) {
      const servedAt = servedAtOf(resp);
      if (!JE.tagCacheStore?.available()) return;
      const store = JE.tagCacheStore;
      const memoryGeneration = s.cacheGeneration;
      const meta = {
        schema: s.STORED_ENTRY_SCHEMA,
        version: resp.version,
        timestamp: resp.timestamp,
        filterRevision: textOrEmpty(resp.filterRevision),
        filterBase: textOrEmpty(resp.filterBase),
        count: entries.length,
        clearStamp: JE.pluginConfig?.ClearLocalStorageTimestamp || 0,
        servedAt,
        savedAt: Date.now()
      };
      s.storeScope = scope;
      const generation = ++s.persistGeneration;
      queuePersist(async () => {
        await new Promise((resolve) => setTimeout(resolve, PERSIST_START_DELAY_MS));
        if (generation !== s.persistGeneration) return;
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        if (!await store.beginFullWrite(scope, token, { servedAt })) return;
        for (let i = 0; i < entries.length; i += PERSIST_SLICE) {
          await deps.idleYield();
          if (generation !== s.persistGeneration) return;
          if (!await store.putManyIfOwner(scope, token, entries.slice(i, i + PERSIST_SLICE))) return;
        }
        if (generation !== s.persistGeneration) return;
        if (await store.commitFullWrite(scope, token, meta)) {
          console.log(`${logPrefix} Server cache persisted: ${entries.length} items`);
          if (generation === s.persistGeneration && memoryGeneration === s.cacheGeneration) releaseCompleteMemory(scope, servedAt);
        }
      });
    }
    function releaseCompleteMemory(scope, servedAt) {
      if (!s.serverCacheComplete || !s.serverCache || s.serverCache.size <= MEMORY_SOFT_CAP || s.storeScope !== scope) return;
      const keep = /* @__PURE__ */ new Map();
      for (const id of s.deltaIds) {
        const entry = s.serverCache.get(id);
        if (entry) keep.set(id, entry);
      }
      s.serverCache = keep;
      s.serverCacheComplete = false;
      s.storeBaseServedAt = servedAt;
      s.storeMisses.clear();
      console.log(`${logPrefix} Server cache kept in the stored copy; memory holds ${keep.size} entries`);
    }
    function persistDelta(entries, base, timestamp, servedAt, removed = []) {
      const scope = s.storeScope;
      if (!scope || !JE.tagCacheStore?.available()) return;
      const store = JE.tagCacheStore;
      const generation = s.persistGeneration;
      queuePersist(async () => {
        if (generation !== s.persistGeneration) return;
        await store.applyDelta(scope, base, entries, timestamp, servedAt, removed);
      });
    }
    async function restoreStoredCache() {
      const store = JE.tagCacheStore;
      if (!store?.available() || s.skipStoreThisSession) return false;
      const scope = cacheScope();
      if (!scope) return false;
      const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
      try {
        const meta = await store.getMeta(scope);
        queuePersist(() => store.clearOtherScopes(scope));
        if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;
        const storedCursor = meta ? export2(meta.timestamp) : null;
        const storedFilter = meta?.filterRevision;
        const storedAt = meta?.servedAt;
        if (!meta || meta.pending || !(Number(meta.count) > 0) || !storedCursor || typeof storedFilter !== "string" || typeof storedAt !== "number") return false;
        if (meta.entrySchema !== store.ENTRY_SCHEMA) return false;
        const clearStamp = Number(JE.pluginConfig?.ClearLocalStorageTimestamp || 0);
        if (clearStamp > Number(meta.clearStamp || 0)) {
          console.log(`${logPrefix} Server triggered cache clear; dropping the stored copy`);
          await store.clearScope(scope);
          return false;
        }
        if (meta.schema !== s.STORED_ENTRY_SCHEMA) {
          console.log(`${logPrefix} Stored copy has entry schema ${String(meta.schema ?? "none")}, expected ${s.STORED_ENTRY_SCHEMA}; dropping it`);
          await store.clearScope(scope);
          return false;
        }
        s.serverCache = /* @__PURE__ */ new Map();
        s.serverCacheComplete = false;
        s.serverCacheVersion = meta.version;
        s.serverCacheTimestamp = storedCursor;
        s.storeBaseServedAt = storedAt || 0;
        s.serverFilterRevision = storedFilter;
        s.serverFilterBase = textOrEmpty(meta.filterBase);
        s.cacheGeneration++;
        s.storeScope = scope;
        s.storeMisses.clear();
        s.deltaIds.clear();
        releaseStoreGate();
        s.storeGate = new Promise((resolve) => {
          s.openStoreGate = resolve;
        });
        console.log(`${logPrefix} Server cache restored from IndexedDB: ${String(meta.count)} items (v${String(meta.version)}), awaiting confirmation`);
        return true;
      } catch (err) {
        console.warn(`${logPrefix} Could not read the stored server cache:`, err);
        return false;
      }
    }
    async function downloadFullCache(options) {
      const userId = deps.apiClient().getCurrentUserId();
      if (!userId) return false;
      const scope = cacheScope();
      const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
      const requestedAt = performance.now();
      const fresh = options?.fresh || JE.tagCacheStore?.available() ? Date.now() : 0;
      const loaded = await fetchFullPages(userId, fresh, requestEpoch, scope);
      if (!loaded) return false;
      if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;
      if (loaded.unbounded) {
        console.log(`${logPrefix} Server cache too large to hold without a stored copy; tags load per card this session`);
        dropServerCache();
        s.perCardThisSession = true;
        return false;
      }
      const { resp, entries, pages } = loaded;
      applyReviewRatings(resp, requestedAt);
      if (loaded.stored) {
        s.persistGeneration++;
        s.itemFacts.clear();
        s.seasonFactIds.clear();
        s.serverCache = /* @__PURE__ */ new Map();
        s.serverCacheComplete = false;
        s.serverCacheVersion = resp.version;
        s.serverCacheTimestamp = cursorOf(resp);
        s.serverFilterRevision = textOrEmpty(resp.filterRevision);
        s.serverFilterBase = textOrEmpty(resp.filterBase);
        s.storeScope = loaded.stored.scope;
        s.storeBaseServedAt = loaded.stored.servedAt;
        s.cacheGeneration++;
        s.storeMisses.clear();
        s.deltaIds.clear();
        s.skipStoreThisSession = false;
        releaseStoreGate();
        console.log(`${logPrefix} Server cache loaded into the stored copy: ${loaded.stored.count} items (v${String(s.serverCacheVersion)}, ${pages} pages); memory holds what cards read`);
        if (pages > 1) deps.fetchDelta().catch(() => {
        });
        return true;
      }
      if (!(entries.length > 0)) {
        console.log(`${logPrefix} Server cache empty, using batch fallback`);
        dropServerCache();
        s.skipStoreThisSession = true;
        return false;
      }
      s.persistGeneration++;
      s.itemFacts.clear();
      s.seasonFactIds.clear();
      s.serverCache = new Map(entries);
      s.serverCacheComplete = true;
      s.serverCacheVersion = resp.version;
      s.serverCacheTimestamp = cursorOf(resp);
      s.serverFilterRevision = textOrEmpty(resp.filterRevision);
      s.serverFilterBase = textOrEmpty(resp.filterBase);
      s.cacheGeneration++;
      s.storeMisses.clear();
      s.deltaIds.clear();
      s.skipStoreThisSession = false;
      releaseStoreGate();
      console.log(`${logPrefix} Server cache loaded: ${s.serverCache.size} items (v${String(s.serverCacheVersion)}${pages > 1 ? `, ${pages} pages` : ""})`);
      if (scope) persistFullCache(scope, resp, entries);
      if (pages > 1) deps.fetchDelta().catch(() => {
      });
      return true;
    }
    async function fetchFullPages(userId, fresh, requestEpoch, scope) {
      const get = async (params) => {
        const resp = await deps.apiClient().ajax({ type: "GET", url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-cache/${userId}`, params), dataType: "json" });
        return JE.session && !JE.session.isCurrent(requestEpoch) || !export42(resp) ? null : resp;
      };
      const base = fresh ? { fresh } : {};
      for (let attempt = 0; attempt <= FULL_LOAD_RESTARTS; attempt++) {
        if (FULL_LOAD_RESTART_DELAYS[attempt]) await new Promise((resolve) => setTimeout(resolve, FULL_LOAD_RESTART_DELAYS[attempt]));
        let entries = [];
        let stream = null;
        let first = null;
        let last = null;
        let pages = 0;
        let after = "";
        let consistent = true;
        for (; ; ) {
          const resp2 = await get({ ...base, limit: FULL_LOAD_PAGE, ...after ? { after } : {} });
          if (resp2 === null) return null;
          pages++;
          if (!first) first = resp2;
          else if (resp2.version !== first.version || resp2.filterRevision !== first.filterRevision) {
            consistent = false;
            break;
          }
          last = resp2;
          const pairs = entryPairs(resp2.items);
          if (stream) {
            if (!await streamEntries(stream, pairs)) return { unbounded: true };
          } else {
            for (const pair of pairs) entries.push(pair);
            if (entries.length > MEMORY_SOFT_CAP) {
              stream = await beginStream(scope, first);
              if (!stream || !await streamEntries(stream, entries)) return { unbounded: true };
              entries = [];
            }
          }
          if (typeof resp2.next !== "string" || !resp2.next) break;
          after = resp2.next;
        }
        if (!consistent) continue;
        const head = first ?? {};
        const resp = { ...head, items: null, count: stream ? stream.count : entries.length, reviewRatings: last?.reviewRatings ?? first?.reviewRatings };
        if (!stream) return { resp, entries, pages };
        const committed = await commitStream(stream, head);
        if (!committed) return { unbounded: true };
        return { resp, entries: [], pages, stored: { scope: stream.scope, servedAt: servedAtOf(head), count: stream.count } };
      }
      return null;
    }
    async function beginStream(scope, first) {
      const store = JE.tagCacheStore;
      if (!scope || !store?.available() || s.skipStoreThisSession) return null;
      s.persistGeneration++;
      await s.persistChain;
      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      try {
        return await store.beginFullWrite(scope, token, { servedAt: servedAtOf(first) }) ? { scope, token, count: 0 } : null;
      } catch (err) {
        console.warn(`${logPrefix} Could not start the stored copy:`, err);
        return null;
      }
    }
    async function streamEntries(stream, pairs) {
      try {
        for (let i = 0; i < pairs.length; i += PERSIST_SLICE) {
          if (!await JE.tagCacheStore?.putManyIfOwner(stream.scope, stream.token, pairs.slice(i, i + PERSIST_SLICE))) return false;
        }
        stream.count += pairs.length;
        return true;
      } catch (err) {
        console.warn(`${logPrefix} Could not write the stored copy:`, err);
        return false;
      }
    }
    async function commitStream(stream, first) {
      const servedAt = servedAtOf(first);
      try {
        const ok = !!await JE.tagCacheStore?.commitFullWrite(stream.scope, stream.token, {
          schema: s.STORED_ENTRY_SCHEMA,
          version: first.version,
          timestamp: first.timestamp,
          filterRevision: textOrEmpty(first.filterRevision),
          filterBase: textOrEmpty(first.filterBase),
          count: stream.count,
          clearStamp: JE.pluginConfig?.ClearLocalStorageTimestamp || 0,
          servedAt,
          savedAt: Date.now()
        });
        if (ok) console.log(`${logPrefix} Server cache persisted: ${stream.count} items`);
        return ok;
      } catch (err) {
        console.warn(`${logPrefix} Could not commit the stored copy:`, err);
        return false;
      }
    }
    function loadServerCache(options) {
      if (!JE.pluginConfig?.TagCacheServerMode) {
        console.log(`${logPrefix} Server cache mode disabled`);
        return Promise.resolve();
      }
      if (s.perCardThisSession) return Promise.resolve();
      const epoch = JE.session ? JE.session.getEpoch() : 0;
      if (s.loadInFlight && !options?.forceDownload && s.loadInFlightEpoch === epoch) return s.loadInFlight;
      const previous = s.loadInFlight;
      const load = (async () => {
        if (previous) await previous;
        try {
          if (!deps.apiClient().getCurrentUserId()) return;
          if (!options?.forceDownload && await restoreStoredCache()) {
            await deps.fetchDelta();
            return;
          }
          await downloadFullCache({ fresh: !!options?.forceDownload });
        } catch (err) {
          releaseStoreGate();
          console.warn(`${logPrefix} Failed to load server cache, using batch fallback:`, err);
          if (!s.serverCache) s.skipStoreThisSession = true;
          if (export12(err) === 404 && JE.tagCacheStore?.available()) {
            const scope = cacheScope();
            if (scope) JE.tagCacheStore.clearScope(scope).catch(() => {
            });
          }
        }
      })();
      s.loadInFlight = load;
      s.loadInFlightEpoch = epoch;
      load.finally(() => {
        if (s.loadInFlight === load) s.loadInFlight = null;
      });
      return load;
    }
    function refreshServerCache() {
      if (s.refreshInFlight) return s.refreshInFlight;
      const refresh = deps.refreshServerCacheCore();
      s.refreshInFlight = refresh;
      refresh.finally(() => {
        if (s.refreshInFlight === refresh) s.refreshInFlight = null;
      });
      return refresh;
    }
    async function waitForServerCache(ready, options) {
      if (!JE.pluginConfig?.TagCacheServerMode) return false;
      const wait = ++s.serverCacheWait;
      const epoch = JE.session ? JE.session.getEpoch() : 0;
      const ended = () => wait !== s.serverCacheWait || JE.session && !JE.session.isCurrent(epoch);
      for (const delay of options?.delays || SERVER_CACHE_WAIT_DELAYS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (ended()) return false;
        try {
          await refreshServerCache();
        } catch {
        }
        if (ended()) return false;
        if (s.serverCache && ready(s.serverCache.values())) return true;
      }
      return false;
    }
    return { applyReviewRatings, dropServerCache, releaseStoreGate, queuePersist, persistDelta, downloadFullCache, loadServerCache, refreshServerCache, waitForServerCache };
  }

  // client/src/features/media-tags/pipeline/tag-pipeline.ts
  function createTagPipeline(JE) {
    const s = createPipelineState(JE);
    const deps = {};
    Object.assign(
      deps,
      { apiClient: export0, hasApiClient: export1 },
      createItemFacts(s, JE, deps),
      createRenderers(s, JE, deps),
      createSeriesLookup(s, JE, deps),
      createServerCache(s, JE, deps),
      createDeltaSync(s, JE, deps),
      createLookFacts(s, JE, deps),
      createScan(s, JE, deps),
      createQueue(s, JE, deps)
    );
    function initialize() {
      if (!JE.helpers?.onBodyMutation) {
        console.warn(`${logPrefix} helpers.onBodyMutation not available, retrying...`);
        setTimeout(initialize, 100);
        return;
      }
      if (s.pipelineStarted) return;
      if (!deps.anyTagTypeEnabled()) {
        s.startWhenRendererRegisters = true;
        console.log(`${logPrefix} No tag renderers enabled; idle until one is`);
        return;
      }
      s.startWhenRendererRegisters = false;
      s.pipelineStarted = true;
      JE.helpers.onBodyMutation("tag-pipeline", (mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          if (mutations[i]?.addedNodes.length) {
            deps.scheduleScan();
            return;
          }
        }
      }, { priority: 0 });
      const createObserver = JE.core?.dom?.createObserver || JE.helpers?.createObserver;
      if (typeof createObserver === "function") {
        createObserver("tag-pipeline-card-identity", deps.releaseReusedCards, document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ["data-id", "data-itemid", "style"],
          attributeOldValue: true
        });
      }
      if (JE.helpers.onNavigate) {
        s.lastNavigationRoute = deps.navigationRoute();
        JE.helpers.onNavigate(() => {
          const route = deps.navigationRoute();
          if (route === s.lastNavigationRoute) return;
          s.lastNavigationRoute = route;
          deps.advanceBatchGeneration();
          s.scanGeneration++;
          for (const entry of [...s.requestQueue, ...s.activeBatch]) s.processedCards.delete(entry.el);
          s.firstEpisodeCache.clear();
          s.parentSeriesCache.clear();
          s.requestQueue = [];
          if (s.fetchTimer) clearTimeout(s.fetchTimer);
          s.fetchTimer = null;
          deps.scheduleNavigationRefresh();
          deps.scheduleScan();
        });
      }
      if (JE.helpers?.addCSS) {
        JE.helpers.addCSS("je-tag-pipeline-perf", `
                .je-tag-host {
                    position: absolute !important;
                    top: 0; left: 0; right: 0; bottom: 0;
                    pointer-events: none;
                    overflow: visible;
                    z-index: 0;
                }
                .je-tag-host .genre-overlay-container,
                .je-tag-host .quality-overlay-container,
                .je-tag-host .language-overlay-container,
                .je-tag-host .rating-overlay-container,
                .je-tag-host .age-rating-overlay-container,
                .je-tag-host .status-overlay-container,
                .je-tag-host .logo-overlay-container {
                    contain: layout style;
                    pointer-events: none;
                    z-index: auto !important;
                }
                /* The top-right indicator offset (unwatched count, played check) is a
                   stable slot rule in tags/tag-layout-styles.js. */
            `);
        const scaleCss = `
                @supports (container-type: inline-size) {
                    .je-tag-host { container-type: inline-size; }
                    html:not(.layout-mobile) .je-tag-host .quality-overlay-container { gap: calc(clamp(1px, 1.8cqw, 4px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host :is(.quality-overlay-label, .language-chip) {
                        font-size: calc(clamp(9px, 6.6cqw, 13.6px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(0px, 0.6cqw, 2px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.2cqw, 10px) * var(--je-tag-scale, 1));
                        border-radius: calc(clamp(2px, 2.4cqw, 5px) * var(--je-tag-scale, 1));
                    }
                    html:not(.layout-mobile) .je-tag-host .language-overlay-container { gap: calc(clamp(1px, 1.8cqw, 3px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host .language-flag { width: calc(clamp(16px, 15cqw, 32px) * var(--je-tag-scale, 1)); }
                    html:not(.layout-mobile) .je-tag-host .rating-overlay-container { gap: calc(clamp(2px, 1.8cqw, 3px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host .rating-tag {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                        gap: calc(clamp(2px, 2.2cqw, 4px) * var(--je-tag-scale, 1));
                    }
                    html:not(.layout-mobile) .je-tag-host .rating-star-icon { font-size: calc(clamp(9px, 7cqw, 14px) * var(--je-tag-scale, 1)) !important; }
                    html:not(.layout-mobile) .je-tag-host .rating-tomato-icon { width: calc(clamp(9px, 7cqw, 14px) * var(--je-tag-scale, 1)); height: calc(clamp(9px, 7cqw, 14px) * var(--je-tag-scale, 1)); }
                    html:not(.layout-mobile) .je-tag-host .genre-overlay-container { gap: calc(clamp(2px, 1.8cqw, 4px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host .genre-tag {
                        width: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1));
                        height: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1));
                    }
                    html:not(.layout-mobile) .je-tag-host .genre-tag .je-msym-outlined { font-size: calc(clamp(11px, 9.5cqw, 20px) * var(--je-tag-scale, 1)); }
                }
            `;
        JE.helpers.addCSS("je-tag-card-scale", JE.core.tagLayout?.preserveLegacySizing?.(scaleCss) || scaleCss);
        JE.helpers.addCSS("je-tag-hover-fade", `
                body.je-tags-hide-on-hover .card:hover .je-tag-host:not([data-je-layout="summary"]):not([data-je-layout="minimal"]) {
                    opacity: 0 !important;
                    transition: opacity 0.15s ease;
                }
            `);
        if (JE.currentSettings?.tagsHideOnHover) {
          document.body.classList.add("je-tags-hide-on-hover");
        }
      }
      deps.loadServerCache().then(() => {
        s.processedCards = /* @__PURE__ */ new WeakSet();
        deps.runScan();
      });
      console.log(`${logPrefix} Initialized`);
    }
    const api = {
      registerRenderer: deps.registerRenderer,
      initialize,
      getFirstEpisode: deps.getFirstEpisode,
      getParentSeries: deps.getParentSeries,
      lookupServerEntries: deps.lookupServerEntries,
      rememberItemFacts: deps.rememberItemFacts,
      peekItemFacts: deps.peekItemFacts,
      lookupItemFacts: deps.lookupItemFacts,
      peekSeasonFacts: deps.peekSeasonFacts,
      /**
       * The caller-filtered server tag-cache entry already in memory for an
       * item, without fetching (the status renderer reads parent facts, the
       * tag look lock reads an item's library and genres). The shared entry
       * is read-only; a memory miss is null.
       * @param itemId - Normalised item id.
       * */
      peekServerEntry(itemId) {
        return s.serverCache?.get(itemId) || null;
      },
      /** @param name - Renderer name (e.g. 'quality'). */
      getRenderer(name) {
        return s.renderers.get(name);
      },
      /** The item data an item's cards are matched on by tag look rules (server entry, remembered, else fetched). */
      itemLookFacts: deps.itemLookFacts,
      /**
       * Every server tag-cache entry in memory (empty without one).
       * */
      serverEntries() {
        return s.serverCache ? s.serverCache.values() : [];
      },
      waitForServerCache: deps.waitForServerCache,
      /** End the running waitForServerCache() (it resolves false). */
      stopWaitingForServerCache() {
        s.serverCacheWait++;
      },
      /**
       * Review rating averages that came with the server cache, once the
       * load or refresh in flight has settled: Map<"mediaType:tmdbKey",
       * average>, or null when the server cache (or the poster chips) is
       * off — the user review tags then ask /reviews/ratings themselves.
       * */
      getReviewRatings() {
        return (s.loadInFlight || s.refreshInFlight || Promise.resolve()).then(() => s.reviewRatings);
      },
      /**
       * The review rating averages already at hand, without waiting.
       * */
      peekReviewRatings() {
        return s.reviewRatings;
      },
      /** @returns Bumped each time the review rating averages are replaced. */
      /** @returns performance.now() when the request behind the current review averages started (0 = none). */
      getReviewRatingsRequestedAt() {
        return s.reviewRatingsRequestedAt;
      },
      /**
       * What Spoiler Guard's Hide tags strips from this user's /tag-data
       * answers: "none" for nothing, another string for a guard set, null
       * while unknown (before the first answer when the bootstrap did not
       * say, and after a user switch or Spoiler Guard change).
       * */
      tagStripRevision() {
        return s.tagStripRevision;
      },
      /**
       * Subscribe to accepted review averages maps.
       * @param listener - Receives the "mediaType:tmdbKey" keys whose value changed (possibly none), or null for all.
       */
      onReviewRatingsChanged(listener) {
        s.reviewRatingsListeners.add(listener);
      },
      // For reinitialize support
      clearProcessed() {
        s.processedCards = /* @__PURE__ */ new WeakSet();
        s.requestQueue = [];
        deps.advanceBatchGeneration();
        s.scanGeneration++;
        s.firstEpisodeCache.clear();
        s.parentSeriesCache.clear();
      },
      // Bust the server cache so the next scan re-fetches everything through the
      // spoiler-strip pipeline. Used after toggling Spoiler Guard so newly-eligible
      // items lose their cached unstripped tag data.
      /**
       * @param [options] - reuseStored keeps the
       *   browser's stored copy as the source (a user switch: the incoming
       *   user's own copy is still theirs); by default the copy is dropped
       *   and rewritten from a full download, because its per-user strip is
       *   what a Spoiler Guard toggle just changed.
       */
      async invalidateServerCache(options) {
        s.tagStripRevision = null;
        if (!s.pipelineStarted) return;
        s.isInvalidating = true;
        try {
          deps.dropServerCache();
          s.tagStripRevision = null;
          s.processedCards = /* @__PURE__ */ new WeakSet();
          s.requestQueue = [];
          deps.advanceBatchGeneration();
          s.scanGeneration++;
          s.firstEpisodeCache.clear();
          s.parentSeriesCache.clear();
          for (const [, renderer] of s.renderers) {
            if (renderer.onServerCacheRefresh) {
              try {
                renderer.onServerCacheRefresh(null);
              } catch {
              }
            }
          }
          try {
            document.querySelectorAll(
              ".quality-overlay-container, .rating-overlay-container, .genre-overlay-container, .language-overlay-container, .age-rating-overlay-container, .status-overlay-container, .awards-overlay-container, .logo-overlay-container, .custom-overlay-container"
            ).forEach(function(el) {
              el.remove();
            });
            document.querySelectorAll(
              "[data-je-quality-tagged], [data-je-rating-tagged], [data-je-genre-tagged], [data-je-language-tagged], [data-je-age-rating-tagged], [data-je-status-tagged], [data-je-awards-tagged], [data-je-logo-tagged], [data-je-custom-tagged]"
            ).forEach(function(el) {
              delete el.dataset.jeQualityTagged;
              delete el.dataset.jeRatingTagged;
              delete el.dataset.jeGenreTagged;
              delete el.dataset.jeLanguageTagged;
              delete el.dataset.jeAgeRatingTagged;
              delete el.dataset.jeStatusTagged;
              delete el.dataset.jeAwardsTagged;
              delete el.dataset.jeLogoTagged;
              delete el.dataset.jeCustomTagged;
            });
            JE.core.tagLayout?.clearAll();
          } catch (domErr) {
            console.warn(`${logPrefix} overlay cleanup during invalidate failed:`, domErr);
          }
          const forceDownload = !options?.reuseStored;
          if (deps.anyTagTypeEnabled()) {
            s.deferredLoad = null;
            await deps.loadServerCache({ forceDownload });
            s.processedCards = /* @__PURE__ */ new WeakSet();
          } else {
            s.deferredLoad = { forceDownload: forceDownload || !!s.deferredLoad?.forceDownload };
          }
        } catch (e) {
          console.warn(`${logPrefix} invalidateServerCache failed:`, e);
        } finally {
          s.isInvalidating = false;
        }
        try {
          deps.runScan();
        } catch (e) {
          console.warn(`${logPrefix} post-invalidate scan failed:`, e);
        }
      },
      scheduleScan: deps.scheduleScan
    };
    Object.assign(deps, { initialize, api });
    JE.tagPipeline = api;
    JE.session?.onUserChange("tag-pipeline", () => {
      deps.dropServerCache();
      s.tagStripRevision = null;
      s.lookFacts = null;
      s.reviewRatings = null;
      s.reviewRatingsRequestedAt = 0;
      s.skipStoreThisSession = false;
      s.perCardThisSession = false;
      api.clearProcessed();
    });
    document.addEventListener("je:user-data-loaded", () => {
      JE.reinitializeTagLayout?.();
      const startedThisSwitch = s.loadStartedForEpoch !== null && s.loadStartedForEpoch === JE.session?.getEpoch?.();
      s.loadStartedForEpoch = null;
      if (startedThisSwitch) return;
      api.invalidateServerCache({ reuseStored: true }).catch(() => {
      });
    });
    console.log(`${logPrefix} Module loaded`);
  }

  // client/src/features/media-tags/pipeline/tag-pipeline-entry.ts
  createTagPipeline(export4());
})();
})();
//# sourceMappingURL=tag-pipeline.js.map
