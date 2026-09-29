// /js/tags/tag-cache-store.js
// Persisted copy of the server tag cache, in IndexedDB, so a page load renders
// tags from the browser's own copy and only fetches what changed since
// (tags/tag-pipeline.js owns the loading and refresh logic; this module is the
// storage). Entries are stored one record per item under a scope of
// `${serverId}:${userId}`: the server strips the payload for the user who
// fetched it (Spoiler Guard), so one user's copy must never serve another, and
// other scopes are deleted when a scope opens so a shared browser doesn't keep
// another account's data around.
//
// Every operation resolves to "nothing stored" or rejects on failure, and the
// first failure (no IndexedDB, private mode, quota, corrupt database) marks the
// store unavailable for the rest of the session — the pipeline then behaves
// exactly as it did before this module existed: one full download per page
// load, held in memory only.
//
// Public surface: JE.tagCacheStore { available, getMeta, setMeta, getMany,
// putMany, clearScope, clearOtherScopes }.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced [TagCacheStore]:';
    const DB_NAME = 'JellyfinEnhanced';
    const DB_VERSION = 1;
    // One record per scope: { scope, version, timestamp, count, clearStamp, savedAt }.
    const META_STORE = 'tagCacheMeta';
    // One record per entry, keyed `${scope}|${itemId}` so a scope is one key range.
    const ITEM_STORE = 'tagCacheItems';
    const KEY_SEP = '|';

    /** @type {Promise<IDBDatabase>|null} */
    let dbPromise = null;
    let unavailable = false;

    /**
     * Whether the store can be used at all: IndexedDB exists and nothing has
     * failed yet this session.
     * @returns {boolean}
     */
    function available() {
        if (unavailable) return false;
        try {
            return typeof indexedDB !== 'undefined' && indexedDB !== null;
        } catch {
            return false;
        }
    }

    /**
     * Give up on the store for this session. Logged once; callers fall back to
     * memory-only behaviour from here on.
     * @param {*} err
     */
    function markUnavailable(err) {
        if (unavailable) return;
        unavailable = true;
        dbPromise = null;
        console.warn(`${logPrefix} IndexedDB unavailable, keeping the tag cache in memory only:`, err);
    }

    /**
     * Open (and on first use create) the database.
     * @returns {Promise<IDBDatabase>}
     */
    function openDb() {
        if (!available()) return Promise.reject(new Error('IndexedDB unavailable'));
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            let request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (err) {
                reject(err);
                return;
            }
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'scope' });
                if (!db.objectStoreNames.contains(ITEM_STORE)) db.createObjectStore(ITEM_STORE);
            };
            request.onsuccess = () => {
                const db = request.result;
                // Another tab upgrading the schema: let go of this connection so
                // it can; the next call reopens.
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
            request.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
        dbPromise.catch((err) => {
            dbPromise = null;
            markUnavailable(err);
        });
        return dbPromise;
    }

    /**
     * Promise wrapper for one IDBRequest.
     * @param {IDBRequest} request
     * @returns {Promise<*>}
     */
    function settle(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
        });
    }

    /**
     * Resolve when a transaction commits; reject when it aborts (a quota error
     * surfaces here). A failure marks the store unavailable.
     * @param {IDBTransaction} tx
     * @returns {Promise<void>}
     */
    function committed(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        }).catch((err) => {
            markUnavailable(err);
            throw err;
        });
    }

    /**
     * Key range covering every entry of one scope.
     * @param {string} scope
     * @returns {IDBKeyRange}
     */
    function scopeRange(scope) {
        return IDBKeyRange.bound(scope + KEY_SEP, scope + KEY_SEP + '￿');
    }

    /**
     * The scope's meta record, or null when nothing (complete) is stored.
     * @param {string} scope
     * @returns {Promise<object|null>}
     */
    async function getMeta(scope) {
        const db = await openDb();
        const tx = db.transaction(META_STORE, 'readonly');
        const meta = await settle(tx.objectStore(META_STORE).get(scope));
        return meta || null;
    }

    /**
     * Write the scope's meta record. Written last by a full persist, so its
     * presence means the entries are complete.
     * @param {string} scope
     * @param {object} meta - version, timestamp, count, clearStamp, savedAt
     * @returns {Promise<void>}
     */
    async function setMeta(scope, meta) {
        const db = await openDb();
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put({ ...meta, scope });
        await committed(tx);
    }

    /**
     * Read the entries for the given item ids in one transaction. Ids with no
     * stored entry are simply absent from the result.
     * @param {string} scope
     * @param {string[]} ids
     * @returns {Promise<Map<string, object>>}
     */
    async function getMany(scope, ids) {
        const found = new Map();
        if (ids.length === 0) return found;
        const db = await openDb();
        const tx = db.transaction(ITEM_STORE, 'readonly');
        const store = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        for (const id of ids) {
            const request = store.get(prefix + id);
            request.onsuccess = () => {
                if (request.result) found.set(id, request.result);
            };
        }
        await committed(tx);
        return found;
    }

    /**
     * Write (insert or replace) entries in one transaction. Each put clones its
     * entry on the calling thread, so the pipeline writes a full cache in idle
     * slices rather than in one call.
     * @param {string} scope
     * @param {Array<[string, object]>} entries - [itemId, entry] pairs
     * @returns {Promise<void>}
     */
    async function putMany(scope, entries) {
        if (entries.length === 0) return;
        const db = await openDb();
        const tx = db.transaction(ITEM_STORE, 'readwrite');
        const store = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        for (const [id, entry] of entries) store.put(entry, prefix + id);
        await committed(tx);
    }

    /**
     * Delete a scope's entries and meta record.
     * @param {string} scope
     * @returns {Promise<void>}
     */
    async function clearScope(scope) {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        tx.objectStore(META_STORE).delete(scope);
        tx.objectStore(ITEM_STORE).delete(scopeRange(scope));
        await committed(tx);
    }

    /**
     * Delete everything stored for scopes other than the given one (all other
     * users and servers), including entries left by an interrupted write that
     * never got a meta record.
     * @param {string} scope - The scope to keep.
     * @returns {Promise<void>}
     */
    async function clearOtherScopes(scope) {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const meta = tx.objectStore(META_STORE);
        const keys = await settle(meta.getAllKeys());
        for (const key of keys) {
            if (key !== scope) meta.delete(key);
        }
        const items = tx.objectStore(ITEM_STORE);
        // Everything before and after this scope's own key range.
        items.delete(IDBKeyRange.upperBound(scope + KEY_SEP, true));
        items.delete(IDBKeyRange.lowerBound(scope + KEY_SEP + '￿', true));
        await committed(tx);
    }

    JE.tagCacheStore = {
        available,
        getMeta,
        setMeta,
        getMany,
        putMany,
        clearScope,
        clearOtherScopes,
    };

})(window.JellyfinEnhanced);
