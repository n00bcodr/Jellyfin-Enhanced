import { errorStatus, finite, isRecord, type JsonRecord } from './dto';
import { cursorOf, entryPairs, type EntryPairs, type FullLoad, logPrefix, MEMORY_SOFT_CAP, type PipelineFns, type PipelineState, servedAtOf, type StoredStream, textOrEmpty } from './state';
import type { TagRuntimeBridge, UrlParams } from './tag-pipeline';
import type { SnapshotBase } from './tag-cache-store';

// waitForServerCache: milliseconds before each delta (about five minutes in
// all; the server's background warm is rate-limited, so a large library
// takes a while).
const SERVER_CACHE_WAIT_DELAYS = [2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000, 30000, 30000, 30000, 60000, 60000];
const PERSIST_SLICE = 250; // entries per idle-slice write (each put clones its entry on this thread)
const PERSIST_START_DELAY_MS = 1500; // let the page's first tag scans have the idle time before persisting
// A full load comes in pages of this many entries (GET tag-cache?limit=&after=): no response, parse or
// string holds the whole library. A server without paging answers the first request in full.
const FULL_LOAD_PAGE = 2000;
// Every page must come from one cache generation and filter; a load that saw them change starts over at
// most this many times (after a short pause), then leaves the cards to the batch route until the next
// navigation tries again. It never asks for the whole cache in one response.
const FULL_LOAD_RESTARTS = 2;
const FULL_LOAD_RESTART_DELAYS = [0, 1500, 4000];

/**
 * The server tag cache in memory and its stored copy: persist, restore, full (paged) download, streaming and the wait for a warming server.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createServerCache(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    // ── Server Cache ───────────────────────────────────────────────────

    /**
     * Storage scope of the signed-in user's cache copy.
     * @returns `${serverId}:${userId}`, or null before sign-in.
     */
    function cacheScope(): string|null {
        const userId = JE.session?.getUserId() || deps.apiClient().getCurrentUserId();
        if (!userId) return null;
        return `${JE.session?.getServerId() || ''}:${userId}`;
    }


    /**
     * Take the review rating averages that ride on a tag-cache response
     * (full or delta). Absent (chips off, or an older server) means the user
     * review tags ask /reviews/ratings themselves. A response whose request
     * started before the one behind the current map is older data and is
     * ignored; the start time also tells the review tags whether the map can
     * reflect a review the viewer just edited (see getReviewRatingsRequestedAt).
     * @param resp - Tag-cache response body.
     * @param requestedAt - performance.now() when its request started.
     */
    function applyReviewRatings(resp: JsonRecord, requestedAt: number) {
        if (requestedAt < s.reviewRatingsRequestedAt) return;
        s.reviewRatingsRequestedAt = requestedAt;
        const previous = s.reviewRatings;
        const raw = resp.reviewRatings;
        if (!isRecord(raw)) {
            s.reviewRatings = null;
        } else {
            const map = new Map<string, number>();
            for (const key in raw) {
                const value = raw[key];
                if (isRecord(value) && typeof value.average === 'number' && Number.isFinite(value.average)) {
                    map.set(key, value.average);
                }
            }
            s.reviewRatings = map;
        }
        notifyReviewRatingsChanged(previous, s.reviewRatings);
    }


    /**
     * Tell the review tags a newer averages map was accepted and which of its
     * values changed, so chips already on cards are updated in place. Called
     * even when no value changed: the newer map can still supersede values the
     * review tags looked up on their own (they decide; usually nothing to do).
     */
    function notifyReviewRatingsChanged(previous: Map<string, number>|null, next: Map<string, number>|null) {
        if (s.reviewRatingsListeners.size === 0 || (!previous && !next)) return;
        let changed: Set<string> | null = null; // null = every key (one side unavailable)
        if (previous && next) {
            changed = new Set();
            for (const [key, value] of next) {
                if (previous.get(key) !== value) changed.add(key);
            }
            for (const key of previous.keys()) {
                if (!next.has(key)) changed.add(key);
            }
        }
        for (const listener of s.reviewRatingsListeners) {
            try { listener(changed); } catch (err) { console.warn(`${logPrefix} review ratings listener failed:`, err); }
        }
    }


    /**
     * Forget the server cache (memory and the stored copy as a lookup source).
     * Queued stored-copy writes stop at their next slice.
     */
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


    /**
     * Let lookups waiting on a restored copy proceed (it was confirmed,
     * replaced or dropped).
     */
    function releaseStoreGate(gate?: Promise<void> | null): void {
        // A confirmation only ever releases the gate it was confirming.
        if (gate !== undefined && gate !== s.storeGate) return;
        const open = s.openStoreGate;
        s.storeGate = null;
        s.openStoreGate = null;
        if (open) open();
    }


    /**
     * Queue a stored-copy write after the ones already queued. A failure gives
     * up on persistence (the store marks itself unavailable); memory is
     * unaffected either way.
     */
    function queuePersist(work: () => Promise<void>) {
        s.persistChain = s.persistChain.then(work).catch((err) => {
            console.warn(`${logPrefix} Could not persist the server cache; keeping it in memory only:`, err);
        });
    }


    /**
     * Write a freshly downloaded full cache to the stored copy in idle slices:
     * clear the scope, put the entries a slice at a time, then the meta record
     * (its presence is what marks the stored copy complete, so an interrupted
     * write is never restored). Memory already holds everything, so nothing
     * waits for this.
     * @param resp - Full tag-cache response body.
     */
    function persistFullCache(scope: string, resp: JsonRecord, entries: EntryPairs): void {
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
            savedAt: Date.now(),
        };
        s.storeScope = scope;
        const generation = ++s.persistGeneration;
        queuePersist(async () => {
            // Not urgent: the page's own tag scans get the idle slices first.
            // A page closed before this runs simply downloads in full next time.
            await new Promise((resolve) => setTimeout(resolve, PERSIST_START_DELAY_MS));
            if (generation !== s.persistGeneration) return;
            // Claim the scope; another tab rewriting it later takes it over and
            // this write stops (every slice and the final meta check the claim).
            const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            // Another tab already stored newer data: keep it.
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


    /**
     * Once the stored copy holds everything memory holds, a large library need not stay in memory: keep at
     * most MEMORY_SOFT_CAP entries (those deltas installed, then the most recently read) and read the rest
     * from the stored copy on demand, exactly as after a restore. Small libraries stay whole in memory.
     * @param scope - The stored copy's scope, just committed.
     * @param servedAt - Its capture time.
     */
    function releaseCompleteMemory(scope: string, servedAt: number) {
        if (!s.serverCacheComplete || !s.serverCache || s.serverCache.size <= MEMORY_SOFT_CAP || s.storeScope !== scope) return;
        const keep = new Map();
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


    /**
     * Write delta entries to the stored copy and advance its cursor. Runs after
     * any full persist still queued, and applies only on top of exactly the
     * copy the delta was fetched against (see tagCacheStore.applyDelta): if
     * another tab moved the copy on, or a rewrite is in progress, nothing is
     * written and memory alone carries this delta.
     * @param entries - [itemId, entry] pairs
     * @param base - What the delta was requested against.
     * @param timestamp - The delta response's timestamp.
     * @param servedAt - When the server captured the delta (ms, server clock).
     */
    function persistDelta(entries: EntryPairs, base: SnapshotBase, timestamp: number, servedAt: number, removed: readonly string[] = []): void {
        const scope = s.storeScope;
        if (!scope || !JE.tagCacheStore?.available()) return;
        const store = JE.tagCacheStore;
        const generation = s.persistGeneration;
        queuePersist(async () => {
            if (generation !== s.persistGeneration) return;
            await store.applyDelta(scope, base, entries, timestamp, servedAt, removed);
        });
    }


    /**
     * Restore the stored copy for the current user, if there is a complete one
     * (other users' copies are deleted on the way). Lookups then read from it;
     * the caller fetches the delta.
     * @returns true when lookups now run against the stored copy
     */
    async function restoreStoredCache(): Promise<boolean> {
        const store = JE.tagCacheStore;
        if (!store?.available() || s.skipStoreThisSession) return false;
        const scope = cacheScope();
        if (!scope) return false;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        try {
            const meta = await store.getMeta(scope);
            // Other users' copies go in the background (queued ahead of any
            // persist, and only ever touching keys outside this scope), so a
            // first load isn't held up by a second transaction before its
            // full download can start.
            queuePersist(() => store.clearOtherScopes(scope));
            if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;
            // Complete copies only (a pending record is a rewrite in progress),
            // written with a filter revision and capture time (older copies
            // predate them).
            const storedCursor = meta ? finite(meta.timestamp) : null;
            const storedFilter = meta?.filterRevision;
            const storedAt = meta?.servedAt;
            if (!meta || meta.pending || !(Number(meta.count) > 0) || !storedCursor
                || typeof storedFilter !== 'string' || typeof storedAt !== 'number') return false;
            // Entries stored before the entry fields last changed (server
            // schema) lack fields the renderers and tag look rules read.
            if (meta.entrySchema !== store.ENTRY_SCHEMA) return false;
            // The admin's "Clear All Client Caches" applies to this copy too.
            const clearStamp = Number(JE.pluginConfig?.ClearLocalStorageTimestamp || 0);
            if (clearStamp > Number(meta.clearStamp || 0)) {
                console.log(`${logPrefix} Server triggered cache clear; dropping the stored copy`);
                await store.clearScope(scope);
                return false;
            }
            // Written under an older entry shape (missing fields a renderer reads).
            if (meta.schema !== s.STORED_ENTRY_SCHEMA) {
                console.log(`${logPrefix} Stored copy has entry schema ${String(meta.schema ?? 'none')}, expected ${s.STORED_ENTRY_SCHEMA}; dropping it`);
                await store.clearScope(scope);
                return false;
            }
            s.serverCache = new Map();
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
            // Nothing renders from the copy until the first delta confirms its
            // strip revision and version (fetchDelta releases the gate).
            releaseStoreGate();
            s.storeGate = new Promise<void>((resolve) => { s.openStoreGate = resolve; });
            console.log(`${logPrefix} Server cache restored from IndexedDB: ${String(meta.count)} items (v${String(meta.version)}), awaiting confirmation`);
            return true;
        } catch (err) {
            console.warn(`${logPrefix} Could not read the stored server cache:`, err);
            return false;
        }
    }


    /**
     * Download the whole cache for the current user and make it the live copy.
     * Up to MEMORY_SOFT_CAP entries memory holds every entry and the stored
     * copy is rewritten in the background; a larger library is streamed into
     * the stored copy as it arrives and read from there as cards ask (see
     * fetchFullPages). Resolves once lookups can be answered.
     * @param [options] - fresh bypasses HTTP revalidation (always done when IndexedDB is available).
     * @returns true when the server had entries
     */
    async function downloadFullCache(options?: {fresh?: boolean}): Promise<boolean> {
        const userId = deps.apiClient().getCurrentUserId();
        if (!userId) return false;
        const scope = cacheScope();

        // The response is spoiler-stripped for THIS user — drop it if the
        // signed-in user changed while the request was in flight.
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const requestedAt = performance.now();
        // A download that will be persisted must carry a current capture time
        // (servedAt): revalidating the browser's HTTP-cached body (304) hands
        // back the capture time of an identical older response, and a stored
        // copy (complete or an interrupted write) could look newer and refuse
        // it on every reload. With IndexedDB, full downloads are rare (first
        // load, replacements), so they always bypass revalidation; without it
        // the cache downloads on every page load and revalidation still pays.
        const fresh = (options?.fresh || JE.tagCacheStore?.available()) ? Date.now() : 0;
        const loaded = await fetchFullPages(userId, fresh, requestEpoch, scope);
        if (!loaded) return false;
        // The account changed while the load ran (its last page, or the stored copy's commit, was still on its
        // way): nothing it read or wrote may become the incoming account's memory, review averages or fallback.
        // A copy it committed stays in the outgoing account's own scope.
        if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;
        if (loaded.unbounded) {
            // More than MEMORY_SOFT_CAP entries and no stored copy to put them in (private mode, storage
            // refused or full): holding the whole library would be unbounded, so cards ask per batch instead
            // for the rest of this session.
            console.log(`${logPrefix} Server cache too large to hold without a stored copy; tags load per card this session`);
            dropServerCache();
            s.perCardThisSession = true;
            return false;
        }
        const { resp, entries, pages } = loaded;

        applyReviewRatings(resp, requestedAt);
        if (loaded.stored) {
            // Streamed into the stored copy as it arrived: memory starts empty and fills from the copy as cards
            // ask, exactly as after a restore (the copy is this page's own, so no confirmation is needed).
            s.persistGeneration++;
            s.itemFacts.clear();
            s.seasonFactIds.clear();
            s.serverCache = new Map();
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
            if (pages > 1) deps.fetchDelta().catch(() => {});
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
        // Memory is complete and current: nothing needs the stored copy now.
        releaseStoreGate();
        console.log(`${logPrefix} Server cache loaded: ${s.serverCache.size} items (v${String(s.serverCacheVersion)}${pages > 1 ? `, ${pages} pages` : ''})`);
        if (scope) persistFullCache(scope, resp, entries);
        // Entries changed or removed while later pages were read come with a delta since the first page.
        if (pages > 1) deps.fetchDelta().catch(() => {});
        return true;
    }


    /**
     * Read the whole cache in pages of FULL_LOAD_PAGE (one response when the server does not page).
     * Every page must carry the first page's version and filter revision; otherwise the generation or
     * the user's filter changed underneath and the load starts over (at most FULL_LOAD_RESTARTS times,
     * after FULL_LOAD_RESTART_DELAYS; then null, and the cards use the batch route). Memory is bounded
     * throughout: pages accumulate up to MEMORY_SOFT_CAP entries, then the load streams what it holds and
     * every later page into the stored copy (a claimed rewrite, committed after the last page) and holds
     * none of them; without a usable stored copy it stops there ({unbounded: true}). The result carries
     * the first page's cursor (timestamp, capture time), so the caller's delta since then picks up whatever
     * changed during the load.
     * @param fresh - Cache-busting stamp (0: allow HTTP revalidation).
     * @param requestEpoch - Session epoch the load belongs to.
     * @param scope - The stored copy's scope for this user, if any.
     *   null when the user changed or every try saw the cache change.
     */
    async function fetchFullPages(userId: string, fresh: number, requestEpoch: number, scope: string | null): Promise<FullLoad | null> {
        const get = async (params: UrlParams): Promise<JsonRecord | null> => {
            const resp = await deps.apiClient().ajax({ type: 'GET', url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-cache/${userId}`, params), dataType: 'json' });
            return (JE.session && !JE.session.isCurrent(requestEpoch)) || !isRecord(resp) ? null : resp;
        };
        const base = fresh ? { fresh } : {};
        for (let attempt = 0; attempt <= FULL_LOAD_RESTARTS; attempt++) {
            if (FULL_LOAD_RESTART_DELAYS[attempt]) await new Promise((resolve) => setTimeout(resolve, FULL_LOAD_RESTART_DELAYS[attempt]));
            let entries: EntryPairs = [];
            // The stored copy this load writes into, once past the cap.
            let stream: StoredStream | null = null;
            let first: JsonRecord | null = null;
            let last: JsonRecord | null = null;
            let pages = 0;
            let after = '';
            let consistent = true;
            for (;;) {
                const resp = await get({ ...base, limit: FULL_LOAD_PAGE, ...(after ? { after } : {}) });
                if (resp === null) return null;
                pages++;
                if (!first) first = resp;
                else if (resp.version !== first.version || resp.filterRevision !== first.filterRevision) { consistent = false; break; }
                last = resp;
                const pairs = entryPairs(resp.items);
                if (stream) {
                    if (!await streamEntries(stream, pairs)) return { unbounded: true };
                } else {
                    for (const pair of pairs) entries.push(pair);
                    if (entries.length > MEMORY_SOFT_CAP) {
                        // Past the cap: what memory holds goes into the stored copy, and so does every later page.
                        stream = await beginStream(scope, first);
                        if (!stream || !await streamEntries(stream, entries)) return { unbounded: true };
                        entries = [];
                    }
                }
                if (typeof resp.next !== 'string' || !resp.next) break;
                after = resp.next;
            }
            if (!consistent) continue;
            // The first page's cursor; the review averages of the last page read.
            const head: JsonRecord = first ?? {};
            const resp = { ...head, items: null, count: stream ? stream.count : entries.length, reviewRatings: last?.reviewRatings ?? first?.reviewRatings };
            if (!stream) return { resp, entries, pages };
            const committed = await commitStream(stream, head);
            if (!committed) return { unbounded: true };
            return { resp, entries: [], pages, stored: { scope: stream.scope, servedAt: servedAtOf(head), count: stream.count } };
        }
        return null;
    }


    /**
     * Claim the stored copy for a full load streamed into it (pending until commitStream), after any write
     * already queued; writes queued for older memory stop. Null when there is no usable stored copy, or
     * another tab has stored newer data.
     * @param first - The load's first page.
     * */
    async function beginStream(scope: string | null, first: JsonRecord): Promise<StoredStream | null> {
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


    /**
     * Put entries into the claimed stored copy, PERSIST_SLICE at a time.
     * @returns false when the claim was lost or the write failed (quota).
     */
    async function streamEntries(stream: StoredStream, pairs: EntryPairs): Promise<boolean> {
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


    /**
     * Commit a streamed full load: the meta record that makes the stored copy complete and restorable.
     * @param first - The load's first page (its cursor and capture time).
     * */
    async function commitStream(stream: StoredStream, first: JsonRecord): Promise<boolean> {
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
                savedAt: Date.now(),
            });
            if (ok) console.log(`${logPrefix} Server cache persisted: ${stream.count} items`);
            return ok;
        } catch (err) {
            console.warn(`${logPrefix} Could not commit the stored copy:`, err);
            return false;
        }
    }


    /**
     * Load the pre-computed tag cache from the server: restore the stored copy
     * and catch up with a delta, or download it in full. Tags then render
     * entirely from the cache with zero batch API calls; falls back to the
     * existing batch POST pipeline if the cache is empty or unavailable.
     * Concurrent callers share one load, unless the one in flight was started
     * for another user or the caller needs a full download; then it is
     * allowed to finish (its identity guards discard its result) before the
     * new one starts, rather than racing it.
     * @param [options] - forceDownload skips the
     *   stored copy (its per-user strip may be stale, e.g. after a Spoiler
     *   Guard toggle) and rewrites it from a full download.
     * */
    function loadServerCache(options?: {forceDownload?: boolean}): Promise<void> {
        if (!JE.pluginConfig?.TagCacheServerMode) {
            console.log(`${logPrefix} Server cache mode disabled`);
            return Promise.resolve();
        }
        // A large library without a stored copy: cards ask per batch until the session changes.
        if (s.perCardThisSession) return Promise.resolve();
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        if (s.loadInFlight && !options?.forceDownload && s.loadInFlightEpoch === epoch) return s.loadInFlight;
        const previous = s.loadInFlight;
        const load = (async () => {
            if (previous) await previous; // never rejects
            try {
                if (!deps.apiClient().getCurrentUserId()) return;
                if (!options?.forceDownload && await restoreStoredCache()) {
                    // Cards render from the stored copy once the delta confirms
                    // it (what changed since, and the review ratings, come with
                    // it). The delta is fetched directly, never through
                    // refreshServerCache: a refresh may itself be waiting for
                    // this load.
                    await deps.fetchDelta();
                    return;
                }
                // A forced download replaces a copy (a Spoiler Guard toggle, a
                // filter change noticed mid-session): it needs a current servedAt.
                await downloadFullCache({ fresh: !!options?.forceDownload });
            } catch (err) {
                releaseStoreGate();
                console.warn(`${logPrefix} Failed to load server cache, using batch fallback:`, err);
                if (!s.serverCache) s.skipStoreThisSession = true;
                // Server-side cache switched off (404): the stored copy has
                // nothing to catch up to any more, so don't keep it around.
                if (errorStatus(err) === 404 && JE.tagCacheStore?.available()) {
                    const scope = cacheScope();
                    if (scope) JE.tagCacheStore.clearScope(scope).catch(() => {});
                }
            }
        })();
        s.loadInFlight = load;
        s.loadInFlightEpoch = epoch;
        load.finally(() => { if (s.loadInFlight === load) s.loadInFlight = null; });
        return load;
    }


    /**
     * Fetch incremental server cache updates since last load (navigation).
     * */
    function refreshServerCache(): Promise<void> {
        if (s.refreshInFlight) return s.refreshInFlight;
        const refresh = deps.refreshServerCacheCore();
        s.refreshInFlight = refresh;
        refresh.finally(() => { if (s.refreshInFlight === refresh) s.refreshInFlight = null; });
        return refresh;
    }


    /**
     * Wait until the server tag cache in memory satisfies `ready`, fetching a
     * delta now and then (a full download when the server's cache version
     * moved): for data the server fills in after a setting changed, such as
     * the logos it looks up and republishes once the first user turns the
     * Logos group on. Bounded by SERVER_CACHE_WAIT_DELAYS; a later call or
     * stopWaitingForServerCache() ends an earlier wait, and so does a user
     * switch. Nothing is redrawn here: the caller decides.
     * @param ready - Checked after each delta.
     * @param [options] - Milliseconds before each delta (tests).
     * @returns True once `ready` holds; false when the server
     *   cache is off, the wait ended, or the bound ran out.
     */
    async function waitForServerCache(ready: (entries: Iterable<JsonRecord>) => boolean, options?: { delays?: readonly number[] }): Promise<boolean> {
        if (!JE.pluginConfig?.TagCacheServerMode) return false;
        const wait = ++s.serverCacheWait;
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        const ended = () => wait !== s.serverCacheWait || (JE.session && !JE.session.isCurrent(epoch));
        for (const delay of options?.delays || SERVER_CACHE_WAIT_DELAYS) {
            await new Promise(resolve => setTimeout(resolve, delay));
            if (ended()) return false;
            try { await refreshServerCache(); } catch { /* the next attempt retries */ }
            if (ended()) return false;
            if (s.serverCache && ready(s.serverCache.values())) return true;
        }
        return false;
    }

    return { applyReviewRatings, dropServerCache, releaseStoreGate, queuePersist, persistDelta, downloadFullCache, loadServerCache, refreshServerCache, waitForServerCache };
}
