import { isRecord, type JsonRecord } from './dto';

export type Colour = readonly [number, number, number];
/** The cursor a delta was requested against. */
export interface SnapshotBase { timestamp: number; version: unknown; filterRevision: string | null }
export interface SnapshotNext { timestamp: number; servedAt: number; filterRevision: string; filterBase: string }
export type EntryPair = readonly [string, unknown];
export interface DirectPlayRecord { r: JsonRecord; t: number; m?: unknown }
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
// checks it inside the same transaction: snapshots are ordered by when the
// server captured them (servedAt, the server's clock — the cache version can
// go back after a restart restores an older on-disk cache, the capture time
// doesn't); a full rewrite only replaces a snapshot that isn't newer and
// claims the scope with a token (a "pending" meta record) that
// each of its slices and its final meta check, and a delta only applies on top
// of exactly the cursor, version and filter revision it was fetched against. A
// tab holding older data therefore can never roll the copy back, and readers
// get the meta record with their entries to check they match what they confirmed.
//
// Every operation resolves to "nothing stored" or rejects on failure, and the
// first failure (no IndexedDB, private mode, quota, corrupt database) marks the
// store unavailable for the rest of the session — the pipeline then behaves
// exactly as it did before this module existed: one full download per page
// load, held in memory only.
//
// It also keeps the Poster Tag Styles preset's artwork colours
// (tags/tag-poster-colours.js) and the direct-play answers
// (tags/tag-direct-play.js): one small record per artwork or item and device
// profile, in the same scopes, capped, and cleared with the other scopes' data.
//
// Public surface: JE.tagCacheStore { ENTRY_SCHEMA, available, getMeta, getMany,
// beginFullWrite, putManyIfOwner, commitFullWrite, applyDelta, reconcileAccess, clearScope,
// clearOtherScopes, getPosterColours, putPosterColours, getDirectPlay,
// putDirectPlay }.
export function createTagCacheStore() {

    const logPrefix = '🪼 Jellyfin Enhanced [TagCacheStore]:';
    const DB_NAME = 'JellyfinEnhanced';
    // 2 added the poster colour store, 3 the direct-play store (older databases upgrade in place).
    const DB_VERSION = 3;
    // One record per scope: { scope, version, timestamp, filterRevision, count,
    // clearStamp, servedAt, savedAt } once complete, or { scope, pending,
    // servedAt } while a full rewrite owns it (never restored).
    const META_STORE = 'tagCacheMeta';
    // One record per entry, keyed `${scope}|${itemId}` so a scope is one key range.
    const ITEM_STORE = 'tagCacheItems';
    // Poster preset colours: { d: [r, g, b] | null, t: savedAt }, keyed
    // `${scope}|${algorithm}|${artwork key}`.
    const COLOUR_STORE = 'posterColours';
    // Direct-play answers: { r: result, t: savedAt }, keyed
    // `${scope}|${profile hash}|${itemId}`.
    const DIRECT_PLAY_STORE = 'directPlay';
    const KEY_SEP = '|';
    // The server's tag-cache entry schema (TagCacheService
    // CurrentCacheSchemaVersion) the stored entries were written with; a copy
    // from another schema is never restored.
    const ENTRY_SCHEMA = 52;
    let dbPromise: Promise<IDBDatabase>|null = null;
    let unavailable = false;

    /**
     * Whether the store can be used at all: IndexedDB exists and nothing has
     * failed yet this session.
     * */
    function available(): boolean {
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
     */
    function markUnavailable(err: unknown): void {
        if (unavailable) return;
        unavailable = true;
        dbPromise = null;
        console.warn(`${logPrefix} IndexedDB unavailable, keeping the tag cache in memory only:`, err);
    }

    /**
     * Open (and on first use create) the database.
     * */
    function openDb(): Promise<IDBDatabase> {
        if (!available()) return Promise.reject(new Error('IndexedDB unavailable'));
        if (dbPromise) return dbPromise;
        const opening = new Promise<IDBDatabase>((resolve, reject) => {
            let request: IDBOpenDBRequest;
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
                if (!db.objectStoreNames.contains(COLOUR_STORE)) db.createObjectStore(COLOUR_STORE);
                if (!db.objectStoreNames.contains(DIRECT_PLAY_STORE)) db.createObjectStore(DIRECT_PLAY_STORE);
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
        dbPromise = opening;
        opening.catch((err) => {
            dbPromise = null;
            markUnavailable(err);
        });
        return opening;
    }

    /**
     * Promise wrapper for one IDBRequest.
     * */
    function settle<T>(request: IDBRequest<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
        });
    }

    /**
     * Resolve when a transaction commits; reject when it aborts (a quota error
     * surfaces here). A failure marks the store unavailable.
     * */
    function committed(tx: IDBTransaction): Promise<void> {
        return new Promise<void>((resolve, reject) => {
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
     * */
    function scopeRange(scope: string): IDBKeyRange {
        return IDBKeyRange.bound(scope + KEY_SEP, scope + KEY_SEP + '￿');
    }

    /**
     * The scope's meta record, or null when nothing (complete) is stored.
     * */
    async function getMeta(scope: string): Promise<JsonRecord|null> {
        const db = await openDb();
        const tx = db.transaction(META_STORE, 'readonly');
        const meta: unknown = await settle(tx.objectStore(META_STORE).get(scope));
        return isRecord(meta) ? meta : null;
    }

    /**
     * Read the entries for the given item ids, and the scope's meta record, in
     * one transaction (so the caller can check the entries belong to the
     * snapshot it confirmed). Ids with no stored entry are simply absent.
     * */
    async function getMany(scope: string, ids: readonly string[]): Promise<{entries: Map<string, JsonRecord>, meta: JsonRecord|null}> {
        const found = new Map<string, JsonRecord>();
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readonly');
        const metaRequest = tx.objectStore(META_STORE).get(scope);
        const store = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        for (const id of ids) {
            const request = store.get(prefix + id);
            request.onsuccess = () => {
                const entry: unknown = request.result;
                if (isRecord(entry)) found.set(id, entry);
            };
        }
        await committed(tx);
        const meta: unknown = metaRequest.result;
        return { entries: found, meta: isRecord(meta) ? meta : null };
    }

    /**
     * Whether snapshot `a` was captured by the server strictly after `b`.
     * Neither arrival time (a slow response carries older data) nor the cache
     * version (it can go back after a server restart) can order them.
     * */
    function isNewer(a: JsonRecord, b: { servedAt: number }): boolean {
        return Number(a.servedAt || 0) > (b.servedAt || 0);
    }

    /**
     * Start a full rewrite of a scope with the given snapshot: in one
     * transaction, unless the stored snapshot (complete or being written) is
     * newer, delete its entries and claim the scope with `token` (a pending
     * meta record, which restore ignores). A later claim by a writer with
     * newer data takes the scope over.
     * @param token - Unique to this writer.
     * @param snapshot - When the server captured this writer's data.
     * @returns false when a newer snapshot is already stored
     */
    async function beginFullWrite(scope: string, token: string, snapshot: {servedAt: number}): Promise<boolean> {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const metaStore = tx.objectStore(META_STORE);
        const request = metaStore.get(scope);
        let claimed = false;
        request.onsuccess = () => {
            const meta: unknown = request.result;
            if (isRecord(meta) && isNewer(meta, snapshot)) return;
            claimed = true;
            tx.objectStore(ITEM_STORE).delete(scopeRange(scope));
            metaStore.put({ scope, pending: token, servedAt: snapshot.servedAt });
        };
        await committed(tx);
        return claimed;
    }

    /**
     * Write one slice of a full rewrite, only while `token` still owns the
     * scope (checked in the same transaction). Each put clones its entry on
     * the calling thread, so the pipeline writes a full cache in idle slices.
     * @param entries - [itemId, entry] pairs
     * @returns false when another writer took the scope over
     */
    async function putManyIfOwner(scope: string, token: string, entries: readonly EntryPair[]): Promise<boolean> {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const request = tx.objectStore(META_STORE).get(scope);
        let owned = false;
        request.onsuccess = () => {
            const claim: unknown = request.result;
            owned = isRecord(claim) && claim.pending === token;
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
     * @param meta - version, timestamp, filterRevision, count, clearStamp, savedAt
     * @returns false when another writer took the scope over
     */
    async function commitFullWrite(scope: string, token: string, meta: JsonRecord): Promise<boolean> {
        const db = await openDb();
        const tx = db.transaction(META_STORE, 'readwrite');
        const store = tx.objectStore(META_STORE);
        const request = store.get(scope);
        let owned = false;
        request.onsuccess = () => {
            const claim: unknown = request.result;
            owned = isRecord(claim) && claim.pending === token;
            if (owned) store.put({ ...meta, scope, entrySchema: ENTRY_SCHEMA });
        };
        await committed(tx);
        return owned;
    }

    /**
     * Apply delta entries and advance the cursor, in one transaction and only
     * when the complete stored copy is exactly the one the delta was fetched
     * against (same cursor, version and strip revision). Otherwise nothing is
     * written: another tab moved the copy on, or a rewrite is in progress.
     * @param base - What the delta was requested against.
     * @param entries - [itemId, entry] pairs
     * @param timestamp - The delta response's timestamp (the new cursor).
     * @param servedAt - When the server captured the delta (ms, server clock).
     * @param [removed] - Item ids the delta removes.
     * @returns whether the delta was applied
     */
    async function applyDelta(scope: string, base: SnapshotBase, entries: readonly EntryPair[], timestamp: number, servedAt: number, removed: readonly string[] = []): Promise<boolean> {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const metaStore = tx.objectStore(META_STORE);
        const request = metaStore.get(scope);
        let applied = false;
        request.onsuccess = () => {
            const meta: unknown = request.result;
            if (!isRecord(meta) || meta.pending
                || meta.timestamp !== base.timestamp
                || meta.version !== base.version
                || meta.filterRevision !== base.filterRevision) {
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

    /**
     * Apply a delta whose only filter change is access (see tag-pipeline.js
     * reconcileAccess), in one transaction and only on exactly the copy it was
     * fetched against: drop every stored entry the user can no longer see,
     * apply the delta, and record the new filter revision. Nothing is written
     * when the copy moved on, or when the user can now see an item the copy
     * lacks (only a full download brings that).
     * @param base - What the delta was requested against.
     * @param next - The delta response's cursor and filter.
     * @param entries - [itemId, entry] pairs
     * @param removed - Item ids the delta removes.
     * @param visible - Every item id the user can see now.
     * */
    async function reconcileAccess(scope: string, base: SnapshotBase, next: SnapshotNext, entries: readonly EntryPair[], removed: readonly string[], visible: ReadonlySet<string>): Promise<{applied: boolean, dropped: string[]}> {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
        const metaStore = tx.objectStore(META_STORE);
        const items = tx.objectStore(ITEM_STORE);
        const prefix = scope + KEY_SEP;
        const meta: unknown = await settle(metaStore.get(scope));
        const result: { applied: boolean; dropped: string[] } = { applied: false, dropped: [] };
        if (isRecord(meta) && !meta.pending && meta.timestamp === base.timestamp && meta.version === base.version
            && meta.filterRevision === base.filterRevision) {
            const held = new Set((await settle(items.getAllKeys(scopeRange(scope)))).map(key => String(key).slice(prefix.length)));
            for (const [id] of entries) held.add(id);
            let complete = true;
            for (const id of visible) {
                if (!held.has(id)) { complete = false; break; }
            }
            if (complete) {
                result.applied = true;
                for (const id of held) {
                    if (!visible.has(id)) { items.delete(prefix + id); result.dropped.push(id); }
                }
                for (const [id, entry] of entries) items.put(entry, prefix + id);
                for (const id of removed) items.delete(prefix + id);
                metaStore.put({ ...meta, timestamp: next.timestamp, servedAt: Math.max(Number(meta.servedAt || 0), next.servedAt || 0),
                    filterRevision: next.filterRevision, filterBase: next.filterBase, count: held.size - result.dropped.length, savedAt: Date.now() });
            }
        }
        await committed(tx);
        return result;
    }

    /**
     * Delete a scope's entries and meta record.
     * */
    async function clearScope(scope: string): Promise<void> {
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
     * @param scope - The scope to keep.
     * */
    async function clearOtherScopes(scope: string): Promise<void> {
        const db = await openDb();
        const tx = db.transaction([META_STORE, ITEM_STORE, COLOUR_STORE, DIRECT_PLAY_STORE], 'readwrite');
        const meta = tx.objectStore(META_STORE);
        const keys = await settle(meta.getAllKeys());
        for (const key of keys) {
            if (key !== scope) meta.delete(key);
        }
        // Everything before and after this scope's own key range.
        for (const store of [tx.objectStore(ITEM_STORE), tx.objectStore(COLOUR_STORE), tx.objectStore(DIRECT_PLAY_STORE)]) {
            store.delete(IDBKeyRange.upperBound(scope + KEY_SEP, true));
            store.delete(IDBKeyRange.lowerBound(scope + KEY_SEP + '￿', true));
        }
        await committed(tx);
    }

    /** Drop a scope's oldest records beyond the cap, in the caller's transaction. */
    async function dropOldest(store: IDBObjectStore, scope: string, cap: number): Promise<void> {
        const range = scopeRange(scope);
        const keys = await settle(store.getAllKeys(range));
        if (keys.length <= cap) return;
        const values: unknown[] = await settle(store.getAll(range));
        keys.map((key, i) => {
            const value = values[i];
            return { key, t: isRecord(value) ? Number(value.t) || 0 : 0 };
        }).sort((a, b) => a.t - b.t)
            .slice(0, keys.length - cap)
            .forEach(({ key }) => store.delete(key));
    }

    /**
     * The Poster preset colours stored for a scope and algorithm version.
     * @param algorithm - tags/tag-poster-colours.js ALGORITHM.
     * @returns Artwork key → dominant colour.
     */
    async function getPosterColours(scope: string, algorithm: number): Promise<Map<string, Colour|null>> {
        const prefix = `${scope}${KEY_SEP}${algorithm}${KEY_SEP}`;
        const db = await openDb();
        const tx = db.transaction(COLOUR_STORE, 'readonly');
        const range = IDBKeyRange.bound(prefix, prefix + '￿');
        const store = tx.objectStore(COLOUR_STORE);
        const keysRequest = store.getAllKeys(range);
        const valuesRequest = store.getAll(range);
        await committed(tx);
        const out = new Map<string, Colour|null>();
        keysRequest.result.forEach((key, i) => {
            const value: unknown = valuesRequest.result[i];
            if (!isRecord(value)) return;
            const colour = readColour(value.d);
            if (colour !== undefined) out.set(String(key).slice(prefix.length), colour);
        });
        return out;
    }

    /**
     * Store Poster preset colours, then drop the oldest of the scope beyond
     * the cap (one transaction).
     * @param colours - Artwork key → dominant colour.
     * @param cap - Most records kept for the scope.
     * */
    async function putPosterColours(scope: string, algorithm: number, colours: ReadonlyMap<string, Colour|null>, cap: number): Promise<void> {
        const prefix = `${scope}${KEY_SEP}${algorithm}${KEY_SEP}`;
        const db = await openDb();
        const tx = db.transaction(COLOUR_STORE, 'readwrite');
        const store = tx.objectStore(COLOUR_STORE);
        const now = Date.now();
        for (const [key, d] of colours) store.put({ d, t: now }, prefix + key);
        await dropOldest(store, scope, cap);
        await committed(tx);
    }

    /**
     * The direct-play answers stored for a scope and device profile.
     * @param hash - tags/tag-direct-play.js profile hash.
     * @returns Item id → answer.
     */
    async function getDirectPlay(scope: string, hash: string): Promise<Map<string, DirectPlayRecord>> {
        const prefix = `${scope}${KEY_SEP}${hash}${KEY_SEP}`;
        const db = await openDb();
        const tx = db.transaction(DIRECT_PLAY_STORE, 'readonly');
        const range = IDBKeyRange.bound(prefix, prefix + '￿');
        const store = tx.objectStore(DIRECT_PLAY_STORE);
        const keysRequest = store.getAllKeys(range);
        const valuesRequest = store.getAll(range);
        await committed(tx);
        const out = new Map<string, DirectPlayRecord>();
        keysRequest.result.forEach((key, i) => {
            const value: unknown = valuesRequest.result[i];
            if (!isRecord(value) || !isRecord(value.r) || typeof value.t !== 'number') return;
            out.set(String(key).slice(prefix.length), { ...value, r: value.r, t: value.t });
        });
        return out;
    }

    /**
     * Store direct-play answers, then drop the oldest of the scope beyond the
     * cap (one transaction).
     * @param answers - Item id → answer.
     * @param cap - Most records kept for the scope.
     * */
    async function putDirectPlay(scope: string, hash: string, answers: ReadonlyMap<string, { r: unknown; t: number; m?: unknown }>, cap: number): Promise<void> {
        const prefix = `${scope}${KEY_SEP}${hash}${KEY_SEP}`;
        const db = await openDb();
        const tx = db.transaction(DIRECT_PLAY_STORE, 'readwrite');
        const store = tx.objectStore(DIRECT_PLAY_STORE);
        // The media fingerprint travels with the answer: a reloaded answer without it could never match.
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
        putDirectPlay,
    };
}
export type TagCacheStore = ReturnType<typeof createTagCacheStore>;
/** A stored colour: undefined when unreadable, null when the artwork had none. */
function readColour(value: unknown): Colour | null | undefined {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const [r, g, b]: unknown[] = value;
    return typeof r === 'number' && typeof g === 'number' && typeof b === 'number' ? [r, g, b] : undefined;
}
