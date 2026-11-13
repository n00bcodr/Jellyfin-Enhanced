import { isRecord, type JsonRecord, record, stringList } from './dto';
import { type AccessOutcome, cursorOf, entryPairs, type EntryPairs, logPrefix, MEMORY_SOFT_CAP, type PipelineFns, type PipelineState, servedAtOf, textOrEmpty } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';
import type { SnapshotBase } from './tag-cache-store';

// Minimum spacing between the `?since=` deltas that navigations trigger.
// Each delta is a full walk of the server's cache for this user, and a
// browsing burst (a few pages in quick succession) can't have new library
// items on every step: one delta per 20 s picks them up within a page or
// two of being added, while rapid navigation collapses to a single
// request. Explicit refreshes (invalidation, user switch, a cache that was
// empty at startup) are not spaced out — see the navigation handler.
const NAV_REFRESH_MIN_INTERVAL_MS = 20000;

/**
 * Navigation-triggered refreshes, `?since=` deltas, access reconciliation and entry lookups against the server cache.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createDeltaSync(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    /**
     * Key identifying the page the current URL shows, for telling a page
     * change from the search page rewriting its `query` parameter: path and
     * hash route plus every query parameter except `query`, which only the
     * search box uses (a details page's identity lives in `id`, a list's in
     * `parentId`/`genreId`/..., so those still count as a change).
     * */
    function navigationRoute(): string {
        const url = new URL(window.location.href);
        const [hashPath, hashQuery = ''] = url.hash.split('?');
        const params = new URLSearchParams(hashQuery);
        for (const [name, value] of url.searchParams) params.append(name, value);
        params.delete('query');
        params.sort();
        return `${url.pathname}${hashPath}?${params}`;
    }


    /**
     * The navigation-triggered delta, at most once per
     * NAV_REFRESH_MIN_INTERVAL_MS: a navigation inside the interval arms one
     * trailing delta for when it ends, so every navigation is still followed
     * by a delta within the interval. Not spaced out while the server cache
     * is not loaded (empty at startup): that path retries the full load, and
     * each navigation is its chance to do so.
     * */
    function scheduleNavigationRefresh(): void {
        // Every tag type is off: nothing reads the cache until one is turned on.
        if (!deps.anyTagTypeEnabled()) return;
        // Monotonic: a system clock change must not stretch the interval.
        const now = performance.now();
        const elapsed = now - s.lastNavRefreshAt;
        if (!s.serverCache || elapsed >= NAV_REFRESH_MIN_INTERVAL_MS) {
            if (s.navRefreshTimer) { clearTimeout(s.navRefreshTimer); s.navRefreshTimer = null; }
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
        // If server cache was never loaded (e.g. cache was empty at startup),
        // retry the full load — the scheduled task may have built it since then.
        if (!s.serverCache) {
            // A load already in flight (boot, user switch) brings the cache and
            // its own delta.
            if (s.loadInFlight) return;
            await deps.loadServerCache();
            if (s.serverCache) {
                // Cache is now available — rescan cards to render from it
                s.processedCards = new WeakSet();
                deps.runScan();
            }
            return;
        }
        await fetchDelta();
    }


    /**
     * Fetch what changed since the cursor and apply it; shared by concurrent
     * callers. Never waits for a load or a refresh (both wait for this), so
     * they can't deadlock. Also the confirmation step for a restored copy:
     * whatever the outcome, the store gate is released at the end.
     * */
    function fetchDelta(): Promise<void> {
        // Only share a fetch made for this session and this memory: one from
        // before a sign-out or a restore answers for a cursor that's gone (and
        // can't confirm the new copy), so it's left to discard its own result.
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        if (s.deltaInFlight && s.deltaInFlight.epoch === epoch && s.deltaInFlight.generation === s.cacheGeneration) {
            return s.deltaInFlight.promise;
        }
        const entry = { epoch, generation: s.cacheGeneration, promise: fetchDeltaCore() };
        s.deltaInFlight = entry;
        entry.promise.finally(() => { if (s.deltaInFlight === entry) s.deltaInFlight = null; });
        return entry.promise;
    }


    /**
     * Apply a delta whose only filter change is access, when it can correct the copy: the response
     * carries the same filter base and every id the user can see (`visible`), and the copy already
     * holds each of them (a newly visible item needs a full download). Entries the user can no
     * longer see are dropped from memory and the stored copy; the cursor and filter move on.
     * @param resp - The delta response.
     * @param base - What the delta was requested against.
     * @param generation - cacheGeneration when the delta was requested.
     * @returns whether the copy was reconciled (false: the caller replaces it)
     */
    /**
     * Which delta entries did not change, asked only for the cards on the page
     * (refreshVisibleCards): a delta can carry thousands of entries, and comparing
     * each one costs more than the cards it would spare. For a user under
     * Spoiler Guard every guarded entry rides along with each delta, mostly
     * unchanged; their cards must not be torn down and redrawn every time.
     * An entry memory did not hold (a restored copy not yet read) counts as changed.
     * @param before - Each delta entry's id: what memory held before the delta, and what the delta brought.
     */
    function unchangedEntries(before: Map<string, [JsonRecord | undefined, JsonRecord]>): (id: string) => boolean {
        return (id) => {
            const [held, entry] = before.get(id) || [];
            if (!held || !entry) return false;
            try { return JSON.stringify(held) === JSON.stringify(entry); } catch { return false; }
        };
    }

    async function reconcileAccess(resp: JsonRecord, base: SnapshotBase, generation: number): Promise<boolean> {
        const revision = textOrEmpty(resp.filterRevision);
        if (!Array.isArray(resp.visible) || !s.serverFilterBase || resp.filterBase !== s.serverFilterBase || !revision || !s.serverCache) return false;
        const visible = new Set(stringList(resp.visible));
        const newEntries = entryPairs(resp.items);
        const carried = record(resp.items);
        const removed = stringList(resp.removed).filter(id => !(id in carried));
        const next = { timestamp: cursorOf(resp), servedAt: servedAtOf(resp), filterRevision: revision, filterBase: s.serverFilterBase };
        let dropped: string[];
        if (s.serverCacheComplete) {
            const held = new Set(s.serverCache.keys());
            for (const [id] of newEntries) held.add(id);
            for (const id of visible) if (!held.has(id)) return false;
            dropped = [...s.serverCache.keys()].filter(id => !visible.has(id));
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
            // A restored copy lives in the store: it decides, in one transaction, after any write still queued.
            const scope = s.storeScope;
            if (!scope || !JE.tagCacheStore?.available()) return false;
            const store = JE.tagCacheStore;
            const outcome = await new Promise<AccessOutcome>((resolve) => {
                deps.queuePersist(async () => {
                    try { resolve(await store.reconcileAccess(scope, base, next, newEntries, removed, visible)); }
                    catch (err) { resolve({ applied: false, dropped: [] }); throw err; }
                });
            });
            if (!outcome.applied || generation !== s.cacheGeneration || !s.serverCache) return false;
            dropped = [...new Set([...outcome.dropped, ...[...s.serverCache.keys()].filter(id => !visible.has(id))])];
        }
        for (const id of dropped) {
            deps.forgetItemFacts(id);
            s.serverCache.delete(id);
            s.deltaIds.delete(id);
            s.storeMisses.add(id);
        }
        const before = new Map<string, [JsonRecord | undefined, JsonRecord]>();
        for (const [id, entry] of newEntries) {
            before.set(id, [s.serverCache.get(id), entry]);
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
        const changedIds = newEntries.map(e => e[0]).concat(removed, dropped);
        if (changedIds.length > 0) {
            for (const [, renderer] of s.renderers) {
                if (renderer.onServerCacheRefresh) {
                    try { renderer.onServerCacheRefresh(changedIds); } catch {}
                }
            }
            deps.refreshVisibleCards(changedIds, dropped, unchangedEntries(before));
        }
        console.log(`${logPrefix} Access changed: +${newEntries.length} items, -${removed.length + dropped.length} no longer visible`);
        return true;
    }


    async function fetchDeltaCore() {
        const gate = s.storeGate;
        const confirming = !!gate;
        const startGeneration = s.cacheGeneration;
        // Set once the restored copy is confirmed current or replaced; any
        // other exit drops the unconfirmed copy from memory (finally below).
        let settled = false;
        try {
            if (!s.serverCache || !s.serverCacheTimestamp) return;
            const userId = deps.apiClient().getCurrentUserId();
            if (!userId) return;

            // Same identity guard as loadServerCache: incremental entries are
            // spoiler-stripped for the user that requested them.
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const generation = s.cacheGeneration;
            const base = { timestamp: s.serverCacheTimestamp, version: s.serverCacheVersion, filterRevision: s.serverFilterRevision };
            const requestedAt = performance.now();
            const resp = await deps.apiClient().ajax({
                type: 'GET',
                url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-cache/${userId}?since=${base.timestamp}&known=${encodeURIComponent(base.filterRevision || '')}`),
                dataType: 'json'
            });
            if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
            // Memory was replaced while this was in flight (full download,
            // invalidation): the answer is relative to a cursor that's gone.
            if (!isRecord(resp) || !resp.items || !s.serverCache || generation !== s.cacheGeneration) return;

            deps.applyReviewRatings(resp, requestedAt);

            // Full rebuild (a new generation, or more removals than the server
            // keeps for deltas), or this user's filter changed since memory was made
            // (library access revoked, Spoiler Guard list or policy changed,
            // possibly on another device): the copy can't be patched — replace it.
            const revision = textOrEmpty(resp.filterRevision);
            // A cursor older than the one asked about means the server's cache
            // went back (restored from an older save or backup): entries this
            // copy got since may disagree with it, and a delta can't say which.
            const rolledBack = typeof resp.timestamp === 'number' && resp.timestamp < base.timestamp;
            // Only access changed (an item this user cannot see was added, or one they could see was
            // hidden): drop what they can no longer see instead of downloading everything again.
            if (resp.version === s.serverCacheVersion && !rolledBack && revision !== s.serverFilterRevision
                && await reconcileAccess(resp, base, generation)) {
                settled = true;
                if (confirming) console.log(`${logPrefix} Stored copy confirmed current after an access change`);
                return;
            }
            if (resp.version !== s.serverCacheVersion || revision !== s.serverFilterRevision || rolledBack) {
                const why = resp.version !== s.serverCacheVersion ? 'Cache version changed'
                    : rolledBack ? 'Server cache went back in time' : 'Access or Spoiler Guard filter changed';
                if (confirming) {
                    // A restored copy that never rendered: download instead.
                    // Cards may still show what the batch fallback drew while
                    // the copy was being restored, so this is a replacement
                    // under them too.
                    console.log(`${logPrefix} ${why}; replacing the stored copy with a full download`);
                    // Only a replacement settles the copy: if none arrived, its strip stays unconfirmed.
                    settled = await deps.downloadFullCache({ fresh: true });
                    for (const [, renderer] of s.renderers) {
                        if (renderer.onServerCacheRefresh) {
                            try { renderer.onServerCacheRefresh(null, { replaced: true }); } catch {}
                        }
                    }
                    deps.refreshVisibleCards();
                } else if (revision !== s.serverFilterRevision) {
                    // Cards already show entries stripped the old way: the full
                    // invalidation also removes their overlays. Not awaited — it
                    // runs its own load, which may wait for this delta.
                    console.log(`${logPrefix} ${why}; reloading the full cache`);
                    setTimeout(() => { deps.api.invalidateServerCache().catch(() => {}); }, 0);
                } else {
                    console.log(`${logPrefix} ${why}, reloading full cache`);
                    await deps.downloadFullCache({ fresh: true });
                    // Clear derived caches and redraw cards from the replacement.
                    for (const [, renderer] of s.renderers) {
                        if (renderer.onServerCacheRefresh) {
                            try { renderer.onServerCacheRefresh(null, { replaced: true }); } catch {}
                        }
                    }
                    deps.refreshVisibleCards();
                }
                return;
            }

            const newEntries = entryPairs(resp.items);
            // Items removed after the cursor (the server leaves out any stored again since).
            const carried = record(resp.items);
            const removed = stringList(resp.removed).filter(id => !(id in carried));
            if (newEntries.length > 0 || removed.length > 0) {
                const before = new Map<string, [JsonRecord | undefined, JsonRecord]>();
                for (const [id, entry] of newEntries) {
                    before.set(id, [s.serverCache.get(id), entry]);
                    deps.forgetItemFacts(id);
                    s.serverCache.set(id, entry);
                    s.storeMisses.delete(id);
                    s.deltaIds.add(id);
                }
                for (const id of removed) {
                    deps.forgetItemFacts(id);
                    s.serverCache.delete(id);
                    s.deltaIds.delete(id);
                    // Never read back from the stored copy, which may not have the removal yet.
                    s.storeMisses.add(id);
                }
                s.serverCacheTimestamp = cursorOf(resp);
                deps.persistDelta(newEntries, base, cursorOf(resp), servedAtOf(resp), removed);
                // Notify renderers to invalidate derived caches for updated and removed items
                const changedIds = newEntries.map(e => e[0]).concat(removed);
                for (const [, renderer] of s.renderers) {
                    if (renderer.onServerCacheRefresh) {
                        try { renderer.onServerCacheRefresh(changedIds); } catch {}
                    }
                }
                deps.refreshVisibleCards(changedIds, [], unchangedEntries(before));
                console.log(`${logPrefix} Server cache updated: +${newEntries.length} items, -${removed.length} removed`);
            }
            settled = true;
            if (confirming) console.log(`${logPrefix} Stored copy confirmed current`);
        } catch (err) {
            console.warn(`${logPrefix} Failed to refresh server cache:`, err);
        } finally {
            if (confirming) {
                // Unconfirmed (request failed, empty answer, signed out): its
                // strip may be stale, so drop it from memory and let cards use
                // the batch path. The copy itself stays for the next page load
                // to confirm. Memory someone else replaced meanwhile is theirs.
                if (!settled && s.cacheGeneration === startGeneration) deps.dropServerCache();
                deps.releaseStoreGate(gate);
            }
        }
    }


    /**
     * Server cache entries for a set of item ids: from memory, then from the
     * stored copy for ids memory hasn't seen. Ids without an entry are absent
     * from the result. Returns the Map itself when no IndexedDB read is needed
     * (the common case once entries are in memory) so the caller can render
     * synchronously, and a Promise of it otherwise.
     * */
    function lookupServerEntries(ids: readonly string[]): Map<string, JsonRecord>|Promise<Map<string, JsonRecord>> {
        // A restored copy renders nothing until the delta confirms it.
        if (s.storeGate) return s.storeGate.then(() => lookupServerEntries(ids));
        const found = new Map<string, JsonRecord>();
        if (!s.serverCache) return found;
        let missing: string[] | null = null;
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
            // Memory was replaced (user switch, full download, invalidation)
            // while reading: what was read may predate it. Answer again from
            // the current state instead.
            if (s.storeScope !== scope || !s.serverCache || generation !== s.cacheGeneration) {
                return lookupServerEntries(ids);
            }
            // Only use the stored entries while the stored snapshot is the one
            // this page confirmed (same version and filter revision, complete):
            // another tab may be rewriting it or may have replaced it with data
            // filtered differently. Anything else counts as not stored.
            // Never captured before the snapshot this page restored (older
            // entries could miss updates its deltas already skipped).
            const usable = !!meta && !meta.pending
                && meta.version === s.serverCacheVersion
                && meta.filterRevision === s.serverFilterRevision
                && Number(meta.servedAt || 0) >= s.storeBaseServedAt;
            const stored = usable ? read : new Map<string, JsonRecord>();
            if (s.serverCache.size + stored.size > MEMORY_SOFT_CAP) {
                // Reset, but keep what deltas installed: the stored copy may
                // not have those yet (its write is queued, or another tab owns it).
                const keep: EntryPairs = [];
                for (const id of s.deltaIds) {
                    const entry = s.serverCache.get(id);
                    if (entry) keep.push([id, entry]);
                }
                s.serverCache.clear();
                for (const [id, entry] of keep) s.serverCache.set(id, entry);
            }
            for (const id of wanted) {
                // A delta that landed while reading is newer than the copy.
                const current = s.serverCache.get(id);
                if (current) {
                    found.set(id, current);
                    continue;
                }
                // So is a removal that landed while reading.
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
