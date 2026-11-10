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
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");

  // client/src/features/media-tags/pipeline/tag-cache-store.ts
  function createTagCacheStore() {
    const logPrefix = "🪼 Jellyfin Enhanced [TagCacheStore]:";
    const DB_NAME = "JellyfinEnhanced";
    const DB_VERSION = 3;
    const META_STORE = "tagCacheMeta";
    const ITEM_STORE = "tagCacheItems";
    const COLOUR_STORE = "posterColours";
    const DIRECT_PLAY_STORE = "directPlay";
    const KEY_SEP = "|";
    const ENTRY_SCHEMA = 52;
    let dbPromise = null;
    let unavailable = false;
    function available() {
      if (unavailable) return false;
      try {
        return typeof indexedDB !== "undefined" && indexedDB !== null;
      } catch {
        return false;
      }
    }
    function markUnavailable(err) {
      if (unavailable) return;
      unavailable = true;
      dbPromise = null;
      console.warn(`${logPrefix} IndexedDB unavailable, keeping the tag cache in memory only:`, err);
    }
    function openDb() {
      if (!available()) return Promise.reject(new Error("IndexedDB unavailable"));
      if (dbPromise) return dbPromise;
      const opening = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (err) {
          reject(err);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "scope" });
          if (!db.objectStoreNames.contains(ITEM_STORE)) db.createObjectStore(ITEM_STORE);
          if (!db.objectStoreNames.contains(COLOUR_STORE)) db.createObjectStore(COLOUR_STORE);
          if (!db.objectStoreNames.contains(DIRECT_PLAY_STORE)) db.createObjectStore(DIRECT_PLAY_STORE);
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
        request.onblocked = () => reject(new Error("IndexedDB open blocked"));
      });
      dbPromise = opening;
      opening.catch((err) => {
        dbPromise = null;
        markUnavailable(err);
      });
      return opening;
    }
    function settle(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
      });
    }
    function committed(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      }).catch((err) => {
        markUnavailable(err);
        throw err;
      });
    }
    function scopeRange(scope) {
      return IDBKeyRange.bound(scope + KEY_SEP, scope + KEY_SEP + "￿");
    }
    async function getMeta(scope) {
      const db = await openDb();
      const tx = db.transaction(META_STORE, "readonly");
      const meta = await settle(tx.objectStore(META_STORE).get(scope));
      return export42(meta) ? meta : null;
    }
    async function getMany(scope, ids) {
      const found = /* @__PURE__ */ new Map();
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE], "readonly");
      const metaRequest = tx.objectStore(META_STORE).get(scope);
      const store = tx.objectStore(ITEM_STORE);
      const prefix = scope + KEY_SEP;
      for (const id of ids) {
        const request = store.get(prefix + id);
        request.onsuccess = () => {
          const entry = request.result;
          if (export42(entry)) found.set(id, entry);
        };
      }
      await committed(tx);
      const meta = metaRequest.result;
      return { entries: found, meta: export42(meta) ? meta : null };
    }
    function isNewer(a, b) {
      return Number(a.servedAt || 0) > (b.servedAt || 0);
    }
    async function beginFullWrite(scope, token, snapshot) {
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE], "readwrite");
      const metaStore = tx.objectStore(META_STORE);
      const request = metaStore.get(scope);
      let claimed = false;
      request.onsuccess = () => {
        const meta = request.result;
        if (export42(meta) && isNewer(meta, snapshot)) return;
        claimed = true;
        tx.objectStore(ITEM_STORE).delete(scopeRange(scope));
        metaStore.put({ scope, pending: token, servedAt: snapshot.servedAt });
      };
      await committed(tx);
      return claimed;
    }
    async function putManyIfOwner(scope, token, entries) {
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE], "readwrite");
      const request = tx.objectStore(META_STORE).get(scope);
      let owned = false;
      request.onsuccess = () => {
        const claim = request.result;
        owned = export42(claim) && claim.pending === token;
        if (!owned) return;
        const items = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        for (const [id, entry] of entries) items.put(entry, prefix + id);
      };
      await committed(tx);
      return owned;
    }
    async function commitFullWrite(scope, token, meta) {
      const db = await openDb();
      const tx = db.transaction(META_STORE, "readwrite");
      const store = tx.objectStore(META_STORE);
      const request = store.get(scope);
      let owned = false;
      request.onsuccess = () => {
        const claim = request.result;
        owned = export42(claim) && claim.pending === token;
        if (owned) store.put({ ...meta, scope, entrySchema: ENTRY_SCHEMA });
      };
      await committed(tx);
      return owned;
    }
    async function applyDelta(scope, base, entries, timestamp, servedAt, removed = []) {
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE], "readwrite");
      const metaStore = tx.objectStore(META_STORE);
      const request = metaStore.get(scope);
      let applied = false;
      request.onsuccess = () => {
        const meta = request.result;
        if (!export42(meta) || meta.pending || meta.timestamp !== base.timestamp || meta.version !== base.version || meta.filterRevision !== base.filterRevision) {
          return;
        }
        applied = true;
        const items = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        for (const [id, entry] of entries) items.put(entry, prefix + id);
        for (const id of removed) items.delete(prefix + id);
        metaStore.put({ ...meta, timestamp, servedAt: Math.max(Number(meta.servedAt || 0), servedAt || 0), savedAt: Date.now() });
      };
      await committed(tx);
      return applied;
    }
    async function reconcileAccess(scope, base, next, entries, removed, visible) {
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE], "readwrite");
      const metaStore = tx.objectStore(META_STORE);
      const items = tx.objectStore(ITEM_STORE);
      const prefix = scope + KEY_SEP;
      const meta = await settle(metaStore.get(scope));
      const result = { applied: false, dropped: [] };
      if (export42(meta) && !meta.pending && meta.timestamp === base.timestamp && meta.version === base.version && meta.filterRevision === base.filterRevision) {
        const held = new Set((await settle(items.getAllKeys(scopeRange(scope)))).map((key) => String(key).slice(prefix.length)));
        for (const [id] of entries) held.add(id);
        let complete = true;
        for (const id of visible) {
          if (!held.has(id)) {
            complete = false;
            break;
          }
        }
        if (complete) {
          result.applied = true;
          for (const id of held) {
            if (!visible.has(id)) {
              items.delete(prefix + id);
              result.dropped.push(id);
            }
          }
          for (const [id, entry] of entries) items.put(entry, prefix + id);
          for (const id of removed) items.delete(prefix + id);
          metaStore.put({
            ...meta,
            timestamp: next.timestamp,
            servedAt: Math.max(Number(meta.servedAt || 0), next.servedAt || 0),
            filterRevision: next.filterRevision,
            filterBase: next.filterBase,
            count: held.size - result.dropped.length,
            savedAt: Date.now()
          });
        }
      }
      await committed(tx);
      return result;
    }
    async function clearScope(scope) {
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE], "readwrite");
      tx.objectStore(META_STORE).delete(scope);
      tx.objectStore(ITEM_STORE).delete(scopeRange(scope));
      await committed(tx);
    }
    async function clearOtherScopes(scope) {
      const db = await openDb();
      const tx = db.transaction([META_STORE, ITEM_STORE, COLOUR_STORE, DIRECT_PLAY_STORE], "readwrite");
      const meta = tx.objectStore(META_STORE);
      const keys = await settle(meta.getAllKeys());
      for (const key of keys) {
        if (key !== scope) meta.delete(key);
      }
      for (const store of [tx.objectStore(ITEM_STORE), tx.objectStore(COLOUR_STORE), tx.objectStore(DIRECT_PLAY_STORE)]) {
        store.delete(IDBKeyRange.upperBound(scope + KEY_SEP, true));
        store.delete(IDBKeyRange.lowerBound(scope + KEY_SEP + "￿", true));
      }
      await committed(tx);
    }
    async function dropOldest(store, scope, cap) {
      const range = scopeRange(scope);
      const keys = await settle(store.getAllKeys(range));
      if (keys.length <= cap) return;
      const values = await settle(store.getAll(range));
      keys.map((key, i) => {
        const value = values[i];
        return { key, t: export42(value) ? Number(value.t) || 0 : 0 };
      }).sort((a, b) => a.t - b.t).slice(0, keys.length - cap).forEach(({ key }) => store.delete(key));
    }
    async function getPosterColours(scope, algorithm) {
      const prefix = `${scope}${KEY_SEP}${algorithm}${KEY_SEP}`;
      const db = await openDb();
      const tx = db.transaction(COLOUR_STORE, "readonly");
      const range = IDBKeyRange.bound(prefix, prefix + "￿");
      const store = tx.objectStore(COLOUR_STORE);
      const keysRequest = store.getAllKeys(range);
      const valuesRequest = store.getAll(range);
      await committed(tx);
      const out = /* @__PURE__ */ new Map();
      keysRequest.result.forEach((key, i) => {
        const value = valuesRequest.result[i];
        if (!export42(value)) return;
        const colour = readColour(value.d);
        if (colour !== void 0) out.set(String(key).slice(prefix.length), colour);
      });
      return out;
    }
    async function putPosterColours(scope, algorithm, colours, cap) {
      const prefix = `${scope}${KEY_SEP}${algorithm}${KEY_SEP}`;
      const db = await openDb();
      const tx = db.transaction(COLOUR_STORE, "readwrite");
      const store = tx.objectStore(COLOUR_STORE);
      const now = Date.now();
      for (const [key, d] of colours) store.put({ d, t: now }, prefix + key);
      await dropOldest(store, scope, cap);
      await committed(tx);
    }
    async function getDirectPlay(scope, hash) {
      const prefix = `${scope}${KEY_SEP}${hash}${KEY_SEP}`;
      const db = await openDb();
      const tx = db.transaction(DIRECT_PLAY_STORE, "readonly");
      const range = IDBKeyRange.bound(prefix, prefix + "￿");
      const store = tx.objectStore(DIRECT_PLAY_STORE);
      const keysRequest = store.getAllKeys(range);
      const valuesRequest = store.getAll(range);
      await committed(tx);
      const out = /* @__PURE__ */ new Map();
      keysRequest.result.forEach((key, i) => {
        const value = valuesRequest.result[i];
        if (!export42(value) || !export42(value.r) || typeof value.t !== "number") return;
        out.set(String(key).slice(prefix.length), { ...value, r: value.r, t: value.t });
      });
      return out;
    }
    async function putDirectPlay(scope, hash, answers, cap) {
      const prefix = `${scope}${KEY_SEP}${hash}${KEY_SEP}`;
      const db = await openDb();
      const tx = db.transaction(DIRECT_PLAY_STORE, "readwrite");
      const store = tx.objectStore(DIRECT_PLAY_STORE);
      for (const [id, value] of answers) store.put({ r: value.r, t: value.t, m: value.m }, prefix + id);
      await dropOldest(store, scope, cap);
      await committed(tx);
    }
    return {
      ENTRY_SCHEMA,
      available,
      getMeta,
      getMany,
      beginFullWrite,
      putManyIfOwner,
      commitFullWrite,
      applyDelta,
      reconcileAccess,
      clearScope,
      clearOtherScopes,
      getPosterColours,
      putPosterColours,
      getDirectPlay,
      putDirectPlay
    };
  }
  function readColour(value) {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length !== 3) return void 0;
    const [r, g, b] = value;
    return typeof r === "number" && typeof g === "number" && typeof b === "number" ? [r, g, b] : void 0;
  }

  // client/src/features/media-tags/pipeline/tag-cache-store-entry.ts
  export4().tagCacheStore = createTagCacheStore();
})();
})();
//# sourceMappingURL=tag-cache-store.js.map
