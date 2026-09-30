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
// Several tabs can share one copy. Every write that depends on what is stored
// checks it inside the same transaction: each snapshot records when its data
// was fetched (fetchedAt), a full rewrite only replaces an older snapshot and
// claims the scope with a token (a "pending" meta record) that each of its
// slices and its final meta check, and a delta only applies on top of exactly
// the cursor, version and filter revision it was fetched against. A tab
// holding older data therefore can never roll the copy back, and readers get
// the meta record with their entries to check they match what they confirmed.
//
// Every operation resolves to "nothing stored" or rejects on failure, and the
// first failure (no IndexedDB, private mode, quota, corrupt database) marks the
// store unavailable for the rest of the session — the pipeline then behaves
// exactly as it did before this module existed: one full download per page
// load, held in memory only.
//
// Public surface: JE.tagCacheStore { available, getMeta, getMany,
// beginFullWrite, putManyIfOwner, commitFullWrite, applyDelta, clearScope,
// clearOtherScopes }.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced [TagCacheStore]:';
    const DB_NAME = 'JellyfinEnhanced';
    const DB_VERSION = 1;
    // One record per scope: { scope, version, timestamp, filterRevision, count,
    // clearStamp, fetchedAt, savedAt } once complete, or { scope, pending,
    // fetchedAt } while a full rewrite owns it (never restored).
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
     * Read the entries for the given item ids, and the scope's meta record, in
     * one transaction (so the caller can check the entries belong to the
     * snapshot it confirmed). Ids with no stored entry are simply absent.
     * @param {string} scope
     * @param {string[]} ids
     * @returns {Promise<{entries: Map<string, object>, meta: object|null}>}
     */
    async function getMany(scope, ids) {
        const found = new Map();
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readonly');
        const metaRequest = tx.objectStore(META_STORE).get(scope);
        const store = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        for (const id of ids) {
            const request = store.get(prefix + id);
            request.onsuccess = () => {
                if (request.result) found.set(id, request.result);
            };
        }
        await committed(tx);
        return { entries: found, meta: metaRequest.result || null };
    }

    /**
     * Start a full rewrite of a scope with data fetched at `fetchedAt`: in one
     * transaction, unless the stored snapshot (complete or being written) was
     * fetched later, delete its entries and claim the scope with `token` (a
     * pending meta record, which restore ignores). A later claim by a writer
     * with newer data takes the scope over.
     * @param {string} scope
     * @param {string} token - Unique to this writer.
     * @param {number} fetchedAt - When this writer's data was fetched (ms).
     * @returns {Promise<boolean>} false when a newer snapshot is already stored
     */
    async function beginFullWrite(scope, token, fetchedAt) {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const metaStore = tx.objectStore(META_STORE);
        const request = metaStore.get(scope);
        let claimed = false;
        request.onsuccess = () => {
            const meta = request.result;
            if (meta && (meta.fetchedAt || 0) > fetchedAt) return;
            claimed = true;
            tx.objectStore(ITEM_STORE).delete(scopeRange(scope));
            metaStore.put({ scope, pending: token, fetchedAt });
        };
        await committed(tx);
        return claimed;
    }

    /**
     * Write one slice of a full rewrite, only while `token` still owns the
     * scope (checked in the same transaction). Each put clones its entry on
     * the calling thread, so the pipeline writes a full cache in idle slices.
     * @param {string} scope
     * @param {string} token
     * @param {Array<[string, object]>} entries - [itemId, entry] pairs
     * @returns {Promise<boolean>} false when another writer took the scope over
     */
    async function putManyIfOwner(scope, token, entries) {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const request = tx.objectStore(META_STORE).get(scope);
        let owned = false;
        request.onsuccess = () => {
            owned = !!request.result && request.result.pending === token;
            if (!owned) return;
            const items = tx.objectStore(ITEM_STORE);
            const prefix = scope + KEY_SEP;
            for (const [id, entry] of entries) items.put(entry, prefix + id);
        };
        await committed(tx);
        return owned;
    }

    /**
     * Finish a full rewrite: replace the pending record with the complete meta
     * record, only while `token` still owns the scope. Its presence is what
     * marks the stored copy restorable.
     * @param {string} scope
     * @param {string} token
     * @param {object} meta - version, timestamp, filterRevision, count, clearStamp, savedAt
     * @returns {Promise<boolean>} false when another writer took the scope over
     */
    async function commitFullWrite(scope, token, meta) {
        const db = await openDb();
        const tx = db.transaction(META_STORE, 'readwrite');
        const store = tx.objectStore(META_STORE);
        const request = store.get(scope);
        let owned = false;
        request.onsuccess = () => {
            owned = !!request.result && request.result.pending === token;
            if (owned) store.put({ ...meta, scope });
        };
        await committed(tx);
        return owned;
    }

    /**
     * Apply delta entries and advance the cursor, in one transaction and only
     * when the complete stored copy is exactly the one the delta was fetched
     * against (same cursor, version and strip revision). Otherwise nothing is
     * written: another tab moved the copy on, or a rewrite is in progress.
     * @param {string} scope
     * @param {{timestamp: number, version: number, filterRevision: string}} base - What the delta was requested against.
     * @param {Array<[string, object]>} entries - [itemId, entry] pairs
     * @param {number} timestamp - The delta response's timestamp (the new cursor).
     * @param {number} fetchedAt - When the delta was fetched (ms).
     * @returns {Promise<boolean>} whether the delta was applied
     */
    async function applyDelta(scope, base, entries, timestamp, fetchedAt) {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const metaStore = tx.objectStore(META_STORE);
        const request = metaStore.get(scope);
        let applied = false;
        request.onsuccess = () => {
            const meta = request.result;
            if (!meta || meta.pending
                || meta.timestamp !== base.timestamp
                || meta.version !== base.version
                || meta.filterRevision !== base.filterRevision) {
                return;
            }
            applied = true;
            const items = tx.objectStore(ITEM_STORE);
            const prefix = scope + KEY_SEP;
            for (const [id, entry] of entries) items.put(entry, prefix + id);
            metaStore.put({ ...meta, timestamp, fetchedAt: Math.max(meta.fetchedAt || 0, fetchedAt), savedAt: Date.now() });
        };
        await committed(tx);
        return applied;
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
        getMany,
        beginFullWrite,
        putManyIfOwner,
        commitFullWrite,
        applyDelta,
        clearScope,
        clearOtherScopes,
    };

})(window.JellyfinEnhanced);
