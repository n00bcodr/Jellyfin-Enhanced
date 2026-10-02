/**
 * @file Unified tag pipeline for Jellyfin Enhanced
 * Replaces the 5 independent scan/fetch/queue loops in the tag systems with a single
 * pipeline: ONE scan → ONE batch fetch → shared first-episode/series cache → fan out to renderers.
 *
 * Each tag module (genre, language, quality, rating) registers a pure renderer function.
 * The pipeline handles all scanning, fetching, caching, and scheduling.
 */
(function(JE) {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────

    const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season', 'BoxSet', 'Video']);
    const FETCH_DEBOUNCE_MS = 150; // Debounce only the batch API call, not the scan
    const logPrefix = '🪼 Jellyfin Enhanced [TagPipeline]:';

    // ── Server cache state ─────────────────────────────────────────────
    //
    // Entries come from the server's pre-computed cache and live in two places:
    // `serverCache` in memory and, when the browser allows it, a per-user copy
    // in IndexedDB (tags/tag-cache-store.js). The first load downloads the
    // whole cache — memory then holds every entry (serverCacheComplete) — and
    // persists it in idle slices. Every later page load restores from the
    // stored copy instead: memory starts empty and fills from IndexedDB as
    // cards ask for entries, while a `?since=` request fetches only what
    // changed. The stored copy is scoped to server + user because the payload
    // is filtered (library access) and spoiler-stripped for the user who
    // fetched it, and it records the filter revision it was made under: a
    // restored copy renders nothing until that first `?since=` answer confirms
    // the revision (and version) still match — access or Spoiler Guard changed
    // (possibly elsewhere) means a full download instead, so a stale filter or
    // strip never reaches a card. Without IndexedDB
    // (private mode, quota, errors) this is exactly the old behaviour: one full
    // download per page load, memory only.

    let serverCache = null;          // Map<itemId, TagCacheEntry>; null = not in use (batch fallback)
    let serverCacheComplete = false; // memory holds every entry the server has for this user
    let serverCacheVersion = 0;
    let serverCacheTimestamp = 0;
    let serverFilterRevision = null; // filter revision memory was made under (access + Spoiler Guard, from the server)
    let cacheGeneration = 0;         // bumped whenever memory is replaced or dropped
    let storeGate = null;            // Promise while a restored copy awaits confirmation; lookups wait on it
    let openStoreGate = null;        // resolves storeGate
    const deltaIds = new Set();      // ids memory holds from a delta (newer than the stored copy until persisted)
    let deltaInFlight = null;        // { promise, epoch, generation } of the running fetchDelta(), shared by load and refresh
    let storeBaseServedAt = 0;       // capture time of the stored snapshot this page restored and confirmed
    let storeScope = null;           // `${serverId}:${userId}` while the stored copy backs lookups/writes
    let persistGeneration = 0;       // bumped whenever queued stored-copy writes must stop
    let persistChain = Promise.resolve(); // stored-copy writes run one after another
    const storeMisses = new Set();   // ids the stored copy has no entry for (never ask IndexedDB twice)
    let skipStoreThisSession = false; // server answered empty or disabled: don't restore a stored copy
    let loadInFlight = null;         // Promise of the running loadServerCache(), shared by concurrent callers
    let loadInFlightEpoch = 0;       // session epoch that load was started for
    let refreshInFlight = null;      // Promise of the running refreshServerCache()
    let reviewRatings = null;        // Map<"mediaType:tmdbKey", average> from the payload; null = unavailable
    let reviewRatingsRequestedAt = 0; // performance.now() when the request behind reviewRatings started
    const reviewRatingsListeners = new Set(); // called with the changed keys (Set, or null = all) when averages change
    const PERSIST_SLICE = 250;       // entries per idle-slice write (each put clones its entry on this thread)
    const PERSIST_START_DELAY_MS = 1500; // let the page's first tag scans have the idle time before persisting
    const MEMORY_SOFT_CAP = 20000;   // entries kept in memory on the stored-copy path before it is reset

    // ── State ──────────────────────────────────────────────────────────

    const renderers = new Map();        // name → { render, isEnabled, needsFirstEpisode, needsParentSeries }
    let processedCards = new WeakSet(); // let, not const — needs reassignment on reinit
    const firstEpisodeCache = new Map(); // seriesId → Promise<item|null>
    const parentSeriesCache = new Map(); // seriesId → Promise<item|null>
    let fetchTimer = null;
    let isProcessing = false;
    let batchGeneration = 0; // Incremented on navigation to cancel stale in-flight batches
    let requestQueue = [];               // { el, itemId, itemType }

    // ── Pipeline-level exclusions ─────────────────────────────────────
    // Elements matching these selectors are skipped before any renderer runs.
    // This catches contexts where tags should never appear regardless of which
    // renderers are enabled, and avoids the cardScalable vs cardImageContainer
    // mismatch that can cause renderer-level shouldIgnoreElement to miss.
    const PIPELINE_SKIP_SELECTORS = [
        '.chapterCardImageContainer',           // Scenes / chapters
        '#indexPage .verticalSection.MyMedia .cardImageContainer', // My Media row
        '.formDialog .cardImageContainer',       // Modal dialogs
        '#pluginsPage .cardImageContainer',      // Admin pages
        '#pluginCatalogPage .cardImageContainer',
        '#devicesPage .cardImageContainer',
        '#mediaLibraryPage .cardImageContainer',
        '.listItemImage:not(.listItemImage-large)', // Small list rows (Playlists, Albums); listItemImage-large (e.g. episode lists) is big enough for overlays
    ];
    // One ancestor walk per card: closest() with a selector list matches the
    // element itself or any ancestor against every selector in one pass, which
    // is what matches()||closest() per selector did in eight passes.
    const PIPELINE_SKIP_SELECTOR = PIPELINE_SKIP_SELECTORS.join(', ');

    /**
     * Check if an element should be skipped by the pipeline entirely.
     * @param {HTMLElement} el - The cardImageContainer element.
     * @returns {boolean}
     */
    function shouldSkipElement(el) {
        return el.closest(PIPELINE_SKIP_SELECTOR) !== null;
    }

    // ── Renderer Registration ──────────────────────────────────────────

    /**
     * Register a tag renderer with the pipeline.
     * @param {string} name - Unique renderer name (e.g., 'genre', 'quality')
     * @param {Object} config
     * @param {Function} config.render - (el, item, extras) => void. Renders the overlay.
     *   `extras` contains: { firstEpisode, parentSeries }
     * @param {Function} config.isEnabled - () => boolean. Checked before rendering.
     * @param {Function} [config.renderFromCache] - (el, itemId) => boolean. Try to render from
     *   localStorage/hot cache without any API call. Returns true if rendered successfully.
     *   This is called BEFORE any batch fetch to handle revisited pages instantly.
     * @param {boolean} [config.needsFirstEpisode=false] - Whether Series/Season items need first episode data.
     * @param {boolean} [config.needsParentSeries=false] - Whether Season items need parent Series data.
     * @param {Function} [config.injectCss] - Called once on registration to inject styles.
     * @param {Function} [config.cleanup] - Called to clean up old overlays before re-render.
     */
    function registerRenderer(name, config) {
        renderers.set(name, {
            render: config.render,
            renderFromCache: config.renderFromCache || null,
            renderFromServerCache: config.renderFromServerCache || null,
            onServerCacheRefresh: config.onServerCacheRefresh || null,
            isEnabled: config.isEnabled,
            needsFirstEpisode: config.needsFirstEpisode || false,
            needsParentSeries: config.needsParentSeries || false,
            injectCss: config.injectCss || null,
            cleanup: config.cleanup || null,
        });
        if (config.injectCss) {
            try { config.injectCss(); } catch (e) {
                console.warn(`${logPrefix} Failed to inject CSS for ${name}:`, e);
            }
        }
        console.log(`${logPrefix} Renderer registered: ${name} (total: ${renderers.size})`);

        // If cards are already on the page (renderer registered after initial scan),
        // clear processed set and rescan so existing cards get this renderer's tags.
        if (processedCards && typeof scheduleScan === 'function') {
            processedCards = new WeakSet();
            scheduleScan();
        }
    }

    // ── Shared Data Fetching ───────────────────────────────────────────

    /**
     * Get the first episode of a series/season (cached, shared across all renderers).
     * @param {string} userId The user ID.
     * @param {string} parentId The series or season ID.
     * @param {string|null} [firstEpisodeId=null] Known first episode ID, when available.
     * @returns {Promise<object|null>} The first episode item or null.
     */
    async function getFirstEpisode(userId, parentId, firstEpisodeId = null) {
        if (firstEpisodeCache.has(parentId)) return firstEpisodeCache.get(parentId);

        const promise = (async () => {
            // /tag-data already returns the first episode ID for Series/Season.
            // Use it directly so the normal path stays entirely inside the
            // region-aware Enhanced projection and avoids an extra /Items call.
            if (firstEpisodeId) {
                try {
                    const enriched = await ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
                        data: JSON.stringify([firstEpisodeId]),
                        contentType: 'application/json',
                        dataType: 'json'
                    });

                    const episode = enriched?.Items?.[0];
                    if (episode) return episode;
                } catch {
                    // Fall through to the native Jellyfin lookup below.
                }
            }

            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items', {
                        ParentId: parentId,
                        IncludeItemTypes: 'Episode',
                        IsVirtualItem: false,
                        Recursive: true,
                        SortBy: 'PremiereDate',
                        SortOrder: 'Ascending',
                        Limit: 1,
                        Fields: 'MediaStreams,MediaSources,Genres',
                        userId: userId
                    }),
                    dataType: 'json'
                });

                const episode = response?.Items?.[0] || null;
                if (!episode?.Id) return episode;

                // Native Jellyfin may have reduced an explicit Matroska BCP-47
                // language to its base ISO-639 code. Enrich it when possible.
                try {
                    const enriched = await ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
                        data: JSON.stringify([episode.Id]),
                        contentType: 'application/json',
                        dataType: 'json'
                    });

                    return enriched?.Items?.[0] || episode;
                } catch {
                    return episode;
                }
            } catch {
                return null;
            }
        })();

        firstEpisodeCache.set(parentId, promise);
        return promise;
    }

    /**
     * Get the parent series item (cached, shared across all renderers).
     */
    async function getParentSeries(userId, seriesId) {
        if (parentSeriesCache.has(seriesId)) return parentSeriesCache.get(seriesId);

        const promise = (async () => {
            try {
                return JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(seriesId, { userId })
                    : await ApiClient.getItem(userId, seriesId);
            } catch {
                return null;
            }
        })();

        parentSeriesCache.set(seriesId, promise);
        return promise;
    }

    // ── Server Cache ───────────────────────────────────────────────────

    /**
     * Storage scope of the signed-in user's cache copy.
     * @returns {string|null} `${serverId}:${userId}`, or null before sign-in.
     */
    function cacheScope() {
        const userId = JE.session?.getUserId() || ApiClient.getCurrentUserId();
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
     * @param {object} resp - Tag-cache response body.
     * @param {number} requestedAt - performance.now() when its request started.
     */
    function applyReviewRatings(resp, requestedAt) {
        if (requestedAt < reviewRatingsRequestedAt) return;
        reviewRatingsRequestedAt = requestedAt;
        const previous = reviewRatings;
        const raw = resp && resp.reviewRatings;
        if (!raw || typeof raw !== 'object') {
            reviewRatings = null;
        } else {
            const map = new Map();
            for (const key in raw) {
                const value = raw[key];
                if (value && typeof value.average === 'number' && Number.isFinite(value.average)) {
                    map.set(key, value.average);
                }
            }
            reviewRatings = map;
        }
        notifyReviewRatingsChanged(previous, reviewRatings);
    }

    /**
     * Tell the review tags a newer averages map was accepted and which of its
     * values changed, so chips already on cards are updated in place. Called
     * even when no value changed: the newer map can still supersede values the
     * review tags looked up on their own (they decide; usually nothing to do).
     * @param {Map<string, number>|null} previous
     * @param {Map<string, number>|null} next
     */
    function notifyReviewRatingsChanged(previous, next) {
        if (reviewRatingsListeners.size === 0 || (!previous && !next)) return;
        let changed = null; // null = every key (one side unavailable)
        if (previous && next) {
            changed = new Set();
            for (const [key, value] of next) {
                if (previous.get(key) !== value) changed.add(key);
            }
            for (const key of previous.keys()) {
                if (!next.has(key)) changed.add(key);
            }
        }
        for (const listener of reviewRatingsListeners) {
            try { listener(changed); } catch (err) { console.warn(`${logPrefix} review ratings listener failed:`, err); }
        }
    }

    /**
     * Forget the server cache (memory and the stored copy as a lookup source).
     * Queued stored-copy writes stop at their next slice.
     */
    function dropServerCache() {
        serverCache = null;
        serverCacheComplete = false;
        serverCacheVersion = 0;
        serverCacheTimestamp = 0;
        serverFilterRevision = null;
        cacheGeneration++;
        storeBaseServedAt = 0;
        storeScope = null;
        storeMisses.clear();
        deltaIds.clear();
        persistGeneration++;
        releaseStoreGate();
    }

    /**
     * Let lookups waiting on a restored copy proceed (it was confirmed,
     * replaced or dropped).
     */
    function releaseStoreGate(gate) {
        // A confirmation only ever releases the gate it was confirming.
        if (gate !== undefined && gate !== storeGate) return;
        const open = openStoreGate;
        storeGate = null;
        openStoreGate = null;
        if (open) open();
    }

    /**
     * Queue a stored-copy write after the ones already queued. A failure gives
     * up on persistence (the store marks itself unavailable); memory is
     * unaffected either way.
     * @param {() => Promise<void>} work
     */
    function queuePersist(work) {
        persistChain = persistChain.then(work).catch((err) => {
            console.warn(`${logPrefix} Could not persist the server cache; keeping it in memory only:`, err);
        });
    }

    /**
     * Write a freshly downloaded full cache to the stored copy in idle slices:
     * clear the scope, put the entries a slice at a time, then the meta record
     * (its presence is what marks the stored copy complete, so an interrupted
     * write is never restored). Memory already holds everything, so nothing
     * waits for this.
     * @param {string} scope
     * @param {object} resp - Full tag-cache response body.
     */
    function persistFullCache(scope, resp) {
        const servedAt = typeof resp.servedAt === 'number' ? resp.servedAt : 0;
        if (!JE.tagCacheStore?.available()) return;
        const store = JE.tagCacheStore;
        const entries = Object.entries(resp.items);
        const meta = {
            version: resp.version,
            timestamp: resp.timestamp,
            filterRevision: typeof resp.filterRevision === 'string' ? resp.filterRevision : '',
            count: entries.length,
            clearStamp: JE.pluginConfig?.ClearLocalStorageTimestamp || 0,
            servedAt,
            savedAt: Date.now(),
        };
        storeScope = scope;
        const generation = ++persistGeneration;
        queuePersist(async () => {
            // Not urgent: the page's own tag scans get the idle slices first.
            // A page closed before this runs simply downloads in full next time.
            await new Promise((resolve) => setTimeout(resolve, PERSIST_START_DELAY_MS));
            if (generation !== persistGeneration) return;
            // Claim the scope; another tab rewriting it later takes it over and
            // this write stops (every slice and the final meta check the claim).
            const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            // Another tab already stored newer data: keep it.
            if (!await store.beginFullWrite(scope, token, { servedAt })) return;
            for (let i = 0; i < entries.length; i += PERSIST_SLICE) {
                await idleYield();
                if (generation !== persistGeneration) return;
                if (!await store.putManyIfOwner(scope, token, entries.slice(i, i + PERSIST_SLICE))) return;
            }
            if (generation !== persistGeneration) return;
            if (await store.commitFullWrite(scope, token, meta)) {
                console.log(`${logPrefix} Server cache persisted: ${entries.length} items`);
            }
        });
    }

    /**
     * Write delta entries to the stored copy and advance its cursor. Runs after
     * any full persist still queued, and applies only on top of exactly the
     * copy the delta was fetched against (see tagCacheStore.applyDelta): if
     * another tab moved the copy on, or a rewrite is in progress, nothing is
     * written and memory alone carries this delta.
     * @param {Array<[string, object]>} entries - [itemId, entry] pairs
     * @param {{timestamp: number, version: number, filterRevision: string}} base - What the delta was requested against.
     * @param {number} timestamp - The delta response's timestamp.
     * @param {number} servedAt - When the server captured the delta (ms, server clock).
     */
    function persistDelta(entries, base, timestamp, servedAt) {
        const scope = storeScope;
        if (!scope || !JE.tagCacheStore?.available()) return;
        const store = JE.tagCacheStore;
        const generation = persistGeneration;
        queuePersist(async () => {
            if (generation !== persistGeneration) return;
            await store.applyDelta(scope, base, entries, timestamp, servedAt);
        });
    }

    /**
     * Restore the stored copy for the current user, if there is a complete one
     * (other users' copies are deleted on the way). Lookups then read from it;
     * the caller fetches the delta.
     * @returns {Promise<boolean>} true when lookups now run against the stored copy
     */
    async function restoreStoredCache() {
        const store = JE.tagCacheStore;
        if (!store?.available() || skipStoreThisSession) return false;
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
            if (!meta || meta.pending || !(meta.count > 0) || !meta.timestamp
                || typeof meta.filterRevision !== 'string' || typeof meta.servedAt !== 'number') return false;
            // The admin's "Clear All Client Caches" applies to this copy too.
            const clearStamp = JE.pluginConfig?.ClearLocalStorageTimestamp || 0;
            if (clearStamp > (meta.clearStamp || 0)) {
                console.log(`${logPrefix} Server triggered cache clear; dropping the stored copy`);
                await store.clearScope(scope);
                return false;
            }
            serverCache = new Map();
            serverCacheComplete = false;
            serverCacheVersion = meta.version;
            serverCacheTimestamp = meta.timestamp;
            storeBaseServedAt = meta.servedAt || 0;
            serverFilterRevision = meta.filterRevision;
            cacheGeneration++;
            storeScope = scope;
            storeMisses.clear();
            deltaIds.clear();
            // Nothing renders from the copy until the first delta confirms its
            // strip revision and version (fetchDelta releases the gate).
            releaseStoreGate();
            storeGate = new Promise((resolve) => { openStoreGate = resolve; });
            console.log(`${logPrefix} Server cache restored from IndexedDB: ${meta.count} items (v${meta.version}), awaiting confirmation`);
            return true;
        } catch (err) {
            console.warn(`${logPrefix} Could not read the stored server cache:`, err);
            return false;
        }
    }

    /**
     * Download the whole cache for the current user and make it the live copy:
     * memory holds every entry, and the stored copy is rewritten in the
     * background. Resolves once memory is ready.
     * @param {{fresh?: boolean}} [options] - fresh bypasses HTTP revalidation (always done when IndexedDB is available).
     * @returns {Promise<boolean>} true when the server had entries
     */
    async function downloadFullCache(options) {
        const userId = ApiClient.getCurrentUserId();
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
        const fresh = (options?.fresh || JE.tagCacheStore?.available()) ? `?fresh=${Date.now()}` : '';
        const resp = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/tag-cache/${userId}${fresh}`),
            dataType: 'json'
        });
        if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;

        applyReviewRatings(resp, requestedAt);
        if (!(resp && resp.items && resp.count > 0)) {
            console.log(`${logPrefix} Server cache empty, using batch fallback`);
            dropServerCache();
            skipStoreThisSession = true;
            return false;
        }

        persistGeneration++;
        serverCache = new Map(Object.entries(resp.items));
        serverCacheComplete = true;
        serverCacheVersion = resp.version;
        serverCacheTimestamp = resp.timestamp;
        serverFilterRevision = typeof resp.filterRevision === 'string' ? resp.filterRevision : '';
        cacheGeneration++;
        storeMisses.clear();
        deltaIds.clear();
        skipStoreThisSession = false;
        // Memory is complete and current: nothing needs the stored copy now.
        releaseStoreGate();
        console.log(`${logPrefix} Server cache loaded: ${serverCache.size} items (v${serverCacheVersion})`);
        if (scope) persistFullCache(scope, resp);
        return true;
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
     * @param {{forceDownload?: boolean}} [options] - forceDownload skips the
     *   stored copy (its per-user strip may be stale, e.g. after a Spoiler
     *   Guard toggle) and rewrites it from a full download.
     * @returns {Promise<void>}
     */
    function loadServerCache(options) {
        if (!JE.pluginConfig?.TagCacheServerMode) {
            console.log(`${logPrefix} Server cache mode disabled`);
            return Promise.resolve();
        }
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        if (loadInFlight && !options?.forceDownload && loadInFlightEpoch === epoch) return loadInFlight;
        const previous = loadInFlight;
        const load = (async () => {
            if (previous) await previous; // never rejects
            try {
                if (!ApiClient.getCurrentUserId()) return;
                if (!options?.forceDownload && await restoreStoredCache()) {
                    // Cards render from the stored copy once the delta confirms
                    // it (what changed since, and the review ratings, come with
                    // it). The delta is fetched directly, never through
                    // refreshServerCache: a refresh may itself be waiting for
                    // this load.
                    await fetchDelta();
                    return;
                }
                // A forced download replaces a copy (a Spoiler Guard toggle, a
                // filter change noticed mid-session): it needs a current servedAt.
                await downloadFullCache({ fresh: !!options?.forceDownload });
            } catch (err) {
                releaseStoreGate();
                console.warn(`${logPrefix} Failed to load server cache, using batch fallback:`, err);
                if (!serverCache) skipStoreThisSession = true;
                // Server-side cache switched off (404): the stored copy has
                // nothing to catch up to any more, so don't keep it around.
                if (err && err.status === 404 && JE.tagCacheStore?.available()) {
                    const scope = cacheScope();
                    if (scope) JE.tagCacheStore.clearScope(scope).catch(() => {});
                }
            }
        })();
        loadInFlight = load;
        loadInFlightEpoch = epoch;
        load.finally(() => { if (loadInFlight === load) loadInFlight = null; });
        return load;
    }

    /**
     * Fetch incremental server cache updates since last load (navigation).
     * @returns {Promise<void>}
     */
    function refreshServerCache() {
        if (refreshInFlight) return refreshInFlight;
        const refresh = refreshServerCacheCore();
        refreshInFlight = refresh;
        refresh.finally(() => { if (refreshInFlight === refresh) refreshInFlight = null; });
        return refresh;
    }

    async function refreshServerCacheCore() {
        // If server cache was never loaded (e.g. cache was empty at startup),
        // retry the full load — the scheduled task may have built it since then.
        if (!serverCache) {
            // A load already in flight (boot, user switch) brings the cache and
            // its own delta.
            if (loadInFlight) return;
            await loadServerCache();
            if (serverCache) {
                // Cache is now available — rescan cards to render from it
                processedCards = new WeakSet();
                runScan();
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
     * @returns {Promise<void>}
     */
    function fetchDelta() {
        // Only share a fetch made for this session and this memory: one from
        // before a sign-out or a restore answers for a cursor that's gone (and
        // can't confirm the new copy), so it's left to discard its own result.
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        if (deltaInFlight && deltaInFlight.epoch === epoch && deltaInFlight.generation === cacheGeneration) {
            return deltaInFlight.promise;
        }
        const entry = { promise: null, epoch, generation: cacheGeneration };
        entry.promise = fetchDeltaCore();
        deltaInFlight = entry;
        entry.promise.finally(() => { if (deltaInFlight === entry) deltaInFlight = null; });
        return entry.promise;
    }

    async function fetchDeltaCore() {
        const gate = storeGate;
        const confirming = !!gate;
        const startGeneration = cacheGeneration;
        // Set once the restored copy is confirmed current or replaced; any
        // other exit drops the unconfirmed copy from memory (finally below).
        let settled = false;
        try {
            if (!serverCache || !serverCacheTimestamp) return;
            const userId = ApiClient.getCurrentUserId();
            if (!userId) return;

            // Same identity guard as loadServerCache: incremental entries are
            // spoiler-stripped for the user that requested them.
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const generation = cacheGeneration;
            const base = { timestamp: serverCacheTimestamp, version: serverCacheVersion, filterRevision: serverFilterRevision };
            const requestedAt = performance.now();
            const resp = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tag-cache/${userId}?since=${base.timestamp}`),
                dataType: 'json'
            });
            if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
            // Memory was replaced while this was in flight (full download,
            // invalidation): the answer is relative to a cursor that's gone.
            if (!resp || !resp.items || !serverCache || generation !== cacheGeneration) return;

            applyReviewRatings(resp, requestedAt);

            // Full rebuild (entries may have been removed, which a delta can't
            // express), or this user's filter changed since memory was made
            // (library access revoked, Spoiler Guard list or policy changed,
            // possibly on another device): the copy can't be patched — replace it.
            const revision = typeof resp.filterRevision === 'string' ? resp.filterRevision : '';
            // A cursor older than the one asked about means the server's cache
            // went back (restored from an older save or backup): entries this
            // copy got since may disagree with it, and a delta can't say which.
            const rolledBack = typeof resp.timestamp === 'number' && resp.timestamp < base.timestamp;
            if (resp.version !== serverCacheVersion || revision !== serverFilterRevision || rolledBack) {
                const why = resp.version !== serverCacheVersion ? 'Cache version changed'
                    : rolledBack ? 'Server cache went back in time' : 'Access or Spoiler Guard filter changed';
                if (confirming) {
                    // A restored copy that never rendered: download instead.
                    console.log(`${logPrefix} ${why}; replacing the stored copy with a full download`);
                    await downloadFullCache({ fresh: true });
                    settled = true;
                    for (const [, renderer] of renderers) {
                        if (renderer.onServerCacheRefresh) {
                            try { renderer.onServerCacheRefresh(null); } catch {}
                        }
                    }
                } else if (revision !== serverFilterRevision) {
                    // Cards already show entries stripped the old way: the full
                    // invalidation also removes their overlays. Not awaited — it
                    // runs its own load, which may wait for this delta.
                    console.log(`${logPrefix} ${why}; reloading the full cache`);
                    setTimeout(() => { JE.tagPipeline.invalidateServerCache().catch(() => {}); }, 0);
                } else {
                    console.log(`${logPrefix} ${why}, reloading full cache`);
                    await downloadFullCache({ fresh: true });
                    // Clear all derived caches on full rebuild
                    for (const [, renderer] of renderers) {
                        if (renderer.onServerCacheRefresh) {
                            try { renderer.onServerCacheRefresh(null); } catch {}
                        }
                    }
                }
                return;
            }

            const newEntries = Object.entries(resp.items);
            if (newEntries.length > 0) {
                for (const [id, entry] of newEntries) {
                    serverCache.set(id, entry);
                    storeMisses.delete(id);
                    deltaIds.add(id);
                }
                serverCacheTimestamp = resp.timestamp;
                persistDelta(newEntries, base, resp.timestamp, typeof resp.servedAt === 'number' ? resp.servedAt : 0);
                // Notify renderers to invalidate derived caches for updated items
                for (const [, renderer] of renderers) {
                    if (renderer.onServerCacheRefresh) {
                        try { renderer.onServerCacheRefresh(newEntries.map(e => e[0])); } catch {}
                    }
                }
                console.log(`${logPrefix} Server cache updated: +${newEntries.length} items`);
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
                if (!settled && cacheGeneration === startGeneration) dropServerCache();
                releaseStoreGate(gate);
            }
        }
    }

    /**
     * Server cache entries for a set of item ids: from memory, then from the
     * stored copy for ids memory hasn't seen. Ids without an entry are absent
     * from the result. Returns the Map itself when no IndexedDB read is needed
     * (the common case once entries are in memory) so the caller can render
     * synchronously, and a Promise of it otherwise.
     * @param {string[]} ids
     * @returns {Map<string, object>|Promise<Map<string, object>>}
     */
    function lookupServerEntries(ids) {
        // A restored copy renders nothing until the delta confirms it.
        if (storeGate) return storeGate.then(() => lookupServerEntries(ids));
        const found = new Map();
        if (!serverCache) return found;
        let missing = null;
        for (const id of ids) {
            const entry = serverCache.get(id);
            if (entry) {
                found.set(id, entry);
            } else if (!serverCacheComplete && storeScope && !storeMisses.has(id)) {
                (missing = missing || []).push(id);
            }
        }
        if (!missing) return found;

        const scope = storeScope;
        const generation = cacheGeneration;
        return JE.tagCacheStore.getMany(scope, missing).then(({ entries: read, meta }) => {
            // Memory was replaced (user switch, full download, invalidation)
            // while reading: what was read may predate it. Answer again from
            // the current state instead.
            if (storeScope !== scope || !serverCache || generation !== cacheGeneration) {
                return lookupServerEntries(ids);
            }
            // Only use the stored entries while the stored snapshot is the one
            // this page confirmed (same version and filter revision, complete):
            // another tab may be rewriting it or may have replaced it with data
            // filtered differently. Anything else counts as not stored.
            // Never captured before the snapshot this page restored (older
            // entries could miss updates its deltas already skipped).
            const usable = !!meta && !meta.pending
                && meta.version === serverCacheVersion
                && meta.filterRevision === serverFilterRevision
                && (meta.servedAt || 0) >= storeBaseServedAt;
            const stored = usable ? read : new Map();
            if (serverCache.size + stored.size > MEMORY_SOFT_CAP) {
                // Reset, but keep what deltas installed: the stored copy may
                // not have those yet (its write is queued, or another tab owns it).
                const keep = [];
                for (const id of deltaIds) {
                    const entry = serverCache.get(id);
                    if (entry) keep.push([id, entry]);
                }
                serverCache.clear();
                for (const [id, entry] of keep) serverCache.set(id, entry);
            }
            for (const id of missing) {
                // A delta that landed while reading is newer than the copy.
                const current = serverCache.get(id);
                if (current) {
                    found.set(id, current);
                    continue;
                }
                const entry = stored.get(id);
                if (entry) {
                    found.set(id, entry);
                    serverCache.set(id, entry);
                } else {
                    storeMisses.add(id);
                }
            }
            return found;
        }).catch((err) => {
            console.warn(`${logPrefix} Stored server cache read failed:`, err);
            return found;
        });
    }

    // ── Card Scanning ──────────────────────────────────────────────────

    /**
     * Check whether at least one registered renderer is currently enabled.
     * @returns {boolean} True if any renderer reports enabled.
     */
    function hasAnyEnabledRenderer() {
        for (const [, r] of renderers) {
            if (r.isEnabled()) return true;
        }
        return false;
    }

    let scanScheduled = false;
    // Cards per idle slice are sized from the measured render cost so a slice
    // stays around CHUNK_BUDGET_MS on this device: a fast desktop renders
    // dozens per slice, a slow phone a handful. The first slice assumes the
    // pre-measurement cost.
    const CHUNK_BUDGET_MS = 8;
    const CHUNK_MIN_CARDS = 4;
    const CHUNK_MAX_CARDS = 40;
    let msPerCard = 1.5;
    // Separate, much larger threshold for yielding during batch render (see processBatch).
    const RENDER_YIELD_CHUNK = 40;
    let scanGeneration = 0; // Incremented on each new scan to cancel stale chunk chains

    /**
     * Schedule scan. Coalesces multiple mutations into a single scan start.
     */
    // Use requestIdleCallback for all tag work so it never competes with
    // user interactions (hover, scroll, click). Falls back to setTimeout
    // for browsers without requestIdleCallback support.
    const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 500 })
        : (fn) => setTimeout(fn, 16);

    /**
     * Resolves on the next idle slot. Used to break up long synchronous
     * render loops (e.g. a batch fetch response covering many search
     * results) so they don't block the main thread in one tick.
     * @returns {Promise<void>}
     */
    function idleYield() {
        return new Promise((resolve) => scheduleIdle(resolve));
    }

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        scheduleIdle(() => {
            scanScheduled = false;
            runScan();
        });
    }

    /**
     * Fold a measured per-card render cost into the running estimate that
     * sizes the next slice.
     * @param {number} elapsedMs
     * @param {number} cards
     */
    function recordRenderCost(elapsedMs, cards) {
        if (cards <= 0) return;
        msPerCard = msPerCard * 0.5 + (elapsedMs / cards) * 0.5;
    }

    /**
     * Render one classified card from its server entry, or from the local
     * caches with a batch-fetch fallback. The host is collected for one
     * corner-stacking pass over the whole slice instead of a layout per card.
     * @param {{el: HTMLElement, itemId: string, itemType: string|null}} card
     * @param {object|undefined} serverEntry
     * @param {HTMLElement[]} hosts
     */
    function renderCard(card, serverEntry, hosts) {
        const { el, itemId, itemType } = card;
        const renderTarget = resolveRenderTarget(el);

        // Server cache first (all tag data pre-computed in one object)
        if (serverEntry) {
            for (const [, renderer] of renderers) {
                if (!renderer.isEnabled()) continue;
                if (renderer.renderFromServerCache) {
                    try { renderer.renderFromServerCache(renderTarget, serverEntry, itemId); } catch {}
                }
            }
            hosts.push(renderTarget);
            return; // Fully rendered from server cache, skip queue
        }

        // Fall back to localStorage/hot cache, then batch fetch for misses
        let allCacheHits = true;
        for (const [, renderer] of renderers) {
            if (!renderer.isEnabled()) continue;
            if (renderer.renderFromCache) {
                if (!renderer.renderFromCache(renderTarget, itemId)) allCacheHits = false;
            } else {
                allCacheHits = false;
            }
        }
        hosts.push(renderTarget);

        if (!allCacheHits) {
            requestQueue.push({ el, renderTarget, itemId, itemType });
        }
    }

    /**
     * Scan all unprocessed cards. Uses chunked processing to avoid jank:
     * each idle slice classifies a chunk of cards (cheap DOM reads), looks up
     * their server entries (synchronously from memory, or from the stored copy)
     * and renders them, then yields. A generation counter ensures stale chunk
     * chains from previous scans are cancelled when a new scan starts (e.g.,
     * rapid page changes); a chain cancelled while waiting for the stored copy
     * releases its cards so the newer scan picks them up.
     */
    let isInvalidating = false;
    function runScan() {
        // While a server-cache invalidation is in flight (after a Spoiler Guard
        // toggle), suppress concurrent scans so cards aren't processed against a
        // half-loaded cache and marked done before the fresh data arrives.
        if (isInvalidating) return;
        if (!hasAnyEnabledRenderer()) return;
        if (typeof ApiClient === 'undefined') return;

        const elements = document.querySelectorAll('.cardImageContainer, div.listItemImage');
        const unprocessed = [];
        for (const el of elements) {
            if (!processedCards.has(el)) unprocessed.push(el);
        }
        if (unprocessed.length === 0) return;

        // Cancel any in-progress chunk chain from a previous scan
        const myGeneration = ++scanGeneration;
        let index = 0;

        /** Continue with the next slice, or schedule the batch fetch once every card is done. */
        function continueScan() {
            if (index < unprocessed.length) {
                // More cards to process — yield and continue when browser is idle
                scheduleIdle(processChunk);
            } else {
                // All cards processed — schedule batch fetch for cache misses
                if (requestQueue.length > 0 && !isProcessing) {
                    if (fetchTimer) clearTimeout(fetchTimer);
                    fetchTimer = setTimeout(() => {
                        fetchTimer = null;
                        processQueue();
                    }, FETCH_DEBOUNCE_MS);
                }
            }
        }

        /**
         * Render a classified chunk from the looked-up entries.
         * @param {Array<{el: HTMLElement, itemId: string, itemType: string|null}>} chunk
         * @param {Map<string, object>} entries
         */
        function renderChunk(chunk, entries) {
            const started = performance.now();
            const hosts = [];
            for (const card of chunk) {
                // Gone since classification (page changed): release it in case
                // it comes back, exactly like a card skipped before marking.
                if (!card.el.isConnected) {
                    processedCards.delete(card.el);
                    continue;
                }
                renderCard(card, entries.get(card.itemId), hosts);
            }
            // One coalesced layout pass for the slice instead of one per card.
            JE.core.tagRenderer.applyCornerStacking(hosts);
            recordRenderCost(performance.now() - started, chunk.length);
            continueScan();
        }

        function processChunk() {
            // Abort if a newer scan has started
            if (myGeneration !== scanGeneration) return;

            const limit = Math.max(CHUNK_MIN_CARDS, Math.min(CHUNK_MAX_CARDS, Math.floor(CHUNK_BUDGET_MS / Math.max(msPerCard, 0.05))));
            const chunk = [];
            const ids = [];

            for (; index < unprocessed.length && chunk.length < limit; index++) {
                const el = unprocessed[index];
                if (processedCards.has(el)) continue;
                // Skip elements no longer in the DOM (page changed)
                if (!el.isConnected) continue;

                const card = el.closest('.card');
                if (card && card.classList.contains('je-hidden')) continue;
                const listItem = el.closest('.listItem');
                if (listItem && listItem.classList.contains('je-hidden')) continue;

                // Skip contexts that should never have tags
                if (shouldSkipElement(el)) {
                    processedCards.add(el);
                    continue;
                }

                const itemId = getItemId(el);
                if (!itemId) continue;

                const itemType = getItemType(el);
                if (itemType && !MEDIA_TYPES.has(itemType)) {
                    processedCards.add(el);
                    continue;
                }

                processedCards.add(el);
                chunk.push({ el, itemId, itemType });
                ids.push(itemId);
            }

            if (chunk.length === 0) {
                continueScan();
                return;
            }

            const lookup = lookupServerEntries(ids);
            if (lookup instanceof Map) {
                renderChunk(chunk, lookup);
                return;
            }
            lookup.then((entries) => {
                if (myGeneration !== scanGeneration) {
                    // Superseded while waiting: release the cards and scan again.
                    // The newer scan took its snapshot while these were still
                    // marked processed, so it won't pick them up by itself.
                    for (const card of chunk) processedCards.delete(card.el);
                    scheduleScan();
                    return;
                }
                renderChunk(chunk, entries);
            });
        }

        processChunk();
    }

    /**
     * Resolves the element tags should render into for a given card: a
     * `.je-tag-host` div inserted before the card's hover-overlay container
     * (so Jellyfin's own overlay naturally covers tags in DOM order), falling
     * back to `.cardScalable` or the card element itself when no overlay
     * container exists. Never render into `.cardImageContainer` directly —
     * it triggers Jellyfin's lazy-load to reset opacity:0, breaking the image.
     * Cheap (a couple of DOM queries) and idempotent, so it's safe to call
     * again later to re-resolve a card whose subtree Jellyfin rebuilt.
     * @param {HTMLElement} el - Card image container element.
     * @returns {HTMLElement} The element to render tags into.
     */
    function resolveRenderTarget(el) {
        const scalable = el.closest('.cardScalable');
        if (!scalable) return el;
        const overlay = scalable.querySelector('.cardOverlayContainer');
        if (!overlay) return scalable;
        let tagHost = scalable.querySelector('.je-tag-host');
        if (!tagHost) {
            tagHost = document.createElement('div');
            tagHost.className = 'je-tag-host';
            scalable.insertBefore(tagHost, overlay);
        }
        return tagHost;
    }

    /**
     * Extract the Jellyfin item ID from a card element.
     * @param {HTMLElement} el - Card image container element.
     * @returns {string|null} The item ID or null if not found.
     */
    function getItemId(el) {
        // From background image URL
        if (el.style?.backgroundImage) {
            const match = el.style.backgroundImage.match(/Items\/([a-f0-9]{32})\//i);
            if (match) return match[1];
        }
        // From parent data-id or data-itemid attribute (normalize to 32-char lowercase hex)
        const parent = el.closest('[data-id]') || el.closest('[data-itemid]');
        const attrId = parent?.getAttribute('data-id') || parent?.getAttribute('data-itemid');
        return attrId ? attrId.replace(/-/g, '').toLowerCase() : null;
    }

    /**
     * Extract the item type from a card element's data-type attribute.
     * @param {HTMLElement} el - Card image container element.
     * @returns {string|null} The item type or null if not found.
     */
    function getItemType(el) {
        const parent = el.closest('[data-type]');
        return parent?.getAttribute('data-type') || null;
    }

    // ── Queue Processing ───────────────────────────────────────────────

    const SERVER_BATCH_LIMIT = 200;

    /**
     * Drain the request queue in SERVER_BATCH_LIMIT-sized chunks.
     * @returns {Promise<void>}
     */
    async function processQueue() {
        if (isProcessing || requestQueue.length === 0) return;
        isProcessing = true;

        try {
            const myGeneration = batchGeneration;

            // Chunk into batches of SERVER_BATCH_LIMIT to avoid 400 errors
            while (requestQueue.length > 0) {
                if (myGeneration !== batchGeneration) break; // navigation happened
                const batch = requestQueue.splice(0, SERVER_BATCH_LIMIT)
                    // Drop cards removed from the DOM since they were queued (e.g. a
                    // page like search re-renders its whole result set on every
                    // keystroke, on the same generation). Skipping them here avoids
                    // fetching and rendering tag data nobody will ever see.
                    .filter((entry) => entry.el.isConnected);
                if (batch.length === 0) continue;
                await processBatch(batch, myGeneration);
            }
        } finally {
            isProcessing = false;
        }
    }

    /**
     * Fetch item data for a batch of cards and fan out to all enabled renderers.
     * @param {Array<{el: HTMLElement, renderTarget: HTMLElement, itemId: string, itemType: string}>} batch - Queued card entries.
     * @param {number} generation - Batch generation counter to detect stale navigations.
     * @returns {Promise<void>}
     */
    async function processBatch(batch, generation) {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) return;

        // Use arrays per ID to handle duplicate items (same movie in multiple rows)
        const elMap = new Map();
        for (const b of batch) {
            if (!elMap.has(b.itemId)) elMap.set(b.itemId, []);
            elMap.get(b.itemId).push(b);
        }
        const ids = [...elMap.keys()];

        try {
            // Single API call for ALL cache-miss items via POST (no URL length limit)
            const response = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
                data: JSON.stringify(ids),
                contentType: 'application/json',
                dataType: 'json'
            });

            const items = response?.Items || [];

            // Abort if navigation happened while we were waiting for the API response
            if (generation !== batchGeneration) return;

            // Build parent series lookup for rating fallback
            const parentSeriesNeeded = new Set();
            for (const item of items) {
                if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId &&
                    !item.CommunityRating && !item.CriticRating) {
                    parentSeriesNeeded.add(item.SeriesId);
                }
                // Genre also needs parent series for Season items
                if (item.Type === 'Season' && item.SeriesId) {
                    parentSeriesNeeded.add(item.SeriesId);
                }
            }

            // Batch-fetch any parent series items we need (these are likely already in the same response)
            const parentSeriesMap = new Map();
            for (const item of items) {
                parentSeriesMap.set(item.Id.toString().replace(/-/g, '').toLowerCase(), item);
            }
            // For parent series not in this batch, fetch individually
            for (const seriesId of parentSeriesNeeded) {
                const normalizedId = seriesId.toString().replace(/-/g, '').toLowerCase();
                if (!parentSeriesMap.has(normalizedId)) {
                    try {
                        const parent = await getParentSeries(userId, seriesId);
                        if (parent) parentSeriesMap.set(normalizedId, parent);
                    } catch {}
                }
            }

            // Render each item as soon as its data is ready.
            // Items that DON'T need first-episode data (Movies, Episodes) render immediately.
            // Items that DO (Series, Season) render after their first-episode fetch completes.
            // This way a slow first-episode lookup doesn't block everything else.

            // Hosts rendered since the last corner-stacking pass: measured once
            // per yield chunk (below) rather than once per card.
            let pendingHosts = [];
            const stackPendingHosts = () => {
                if (pendingHosts.length === 0) return;
                JE.core.tagRenderer.applyCornerStacking(pendingHosts);
                pendingHosts = [];
            };

            const renderItem = (item, firstEpisode) => {
                // Re-check per render: first-episode/parent-series awaits can
                // span a navigation OR a user switch (clearProcessed bumps the
                // generation) — stale data must not be rendered or persisted.
                if (generation !== batchGeneration) return;
                const itemId = item.Id.toString().replace(/-/g, '').toLowerCase();
                const batchEntries = elMap.get(itemId);
                if (!batchEntries || batchEntries.length === 0) return;
                if (!MEDIA_TYPES.has(item.Type)) return;

                let parentSeries = null;
                let ratingParentSeries = null;
                if (item.SeriesId) {
                    const parentId = item.SeriesId.toString().replace(/-/g, '').toLowerCase();
                    parentSeries = parentSeriesMap.get(parentId) || null;
                    if ((item.Type === 'Season' || item.Type === 'Episode') &&
                        !item.CommunityRating && !item.CriticRating) {
                        ratingParentSeries = parentSeries;
                    }
                }

                // Render to ALL cards with this ID (same item can appear in multiple rows)
                for (const entry of batchEntries) {
                    let { el, renderTarget } = entry;
                    // The queued renderTarget can go stale between scan and render
                    // (Series/Season wait on a first-episode fetch first, giving
                    // Jellyfin time to rebuild the card's subtree). Re-resolve from
                    // the still-tracked card element rather than dropping the tag —
                    // resolveRenderTarget is a couple of cheap DOM queries, not a fetch.
                    if (!renderTarget.isConnected) {
                        if (!el.isConnected) continue; // card itself is gone
                        renderTarget = resolveRenderTarget(el);
                    }
                    const extras = { firstEpisode, parentSeries, ratingParentSeries, renderTarget };
                    for (const [name, renderer] of renderers) {
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

            // Check if ANY enabled renderer actually needs first-episode data
            let anyNeedsFirstEp = false;
            for (const [, r] of renderers) {
                if (r.isEnabled() && r.needsFirstEpisode) { anyNeedsFirstEp = true; break; }
            }

            // Process all items: render immediately what we can, fetch first episodes in parallel.
            // Yield every RENDER_YIELD_CHUNK items so a large batch (e.g. a
            // broad search) can't block the main thread in one long synchronous stretch.
            const pendingFirstEps = [];
            let renderedSinceYield = 0;
            for (const item of items) {
                if (anyNeedsFirstEp && item.FirstEpisode?.NeedsStreamFetch) {
                    // Series/Season: fetch first episode in background, render when ready.
                    // These land one at a time, so their hosts are stacked in one
                    // batched frame rather than measured individually.
                    pendingFirstEps.push(
                        getFirstEpisode(userId, item.Id, item.FirstEpisode.Id)
                            .then(ep => renderItem(item, ep))
                            .catch(() => renderItem(item, null))
                            .then(() => {
                                for (const host of pendingHosts) JE.core.tagRenderer.scheduleCornerStacking(host);
                                pendingHosts = [];
                            })
                    );
                } else {
                    // Movies, Episodes, etc: render immediately (no extra fetch needed)
                    renderItem(item, item.FirstEpisode || null);
                    if (++renderedSinceYield >= RENDER_YIELD_CHUNK) {
                        renderedSinceYield = 0;
                        stackPendingHosts();
                        await idleYield();
                        if (generation !== batchGeneration) return; // navigation or user switch while yielded
                    }
                }
            }
            stackPendingHosts();

            // Wait for all first-episode renders to complete before marking batch done
            if (pendingFirstEps.length > 0) {
                await Promise.all(pendingFirstEps);
            }
        } catch (err) {
            console.warn(`${logPrefix} Batch fetch failed, falling back to individual fetches:`, err);
            // Fallback: process items individually
            for (const { el, renderTarget: queuedRenderTarget, itemId } of batch) {
                if (generation !== batchGeneration) break; // navigation or user switch
                try {
                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId, { userId })
                        : await ApiClient.getItem(userId, itemId);
                    if (!item || !MEDIA_TYPES.has(item.Type)) continue;

                    const firstEpisode = (item.Type === 'Series' || item.Type === 'Season')
                        ? await getFirstEpisode(userId, item.Id) : null;
                    if (generation !== batchGeneration) break; // switched during the awaits above
                    let renderTarget = queuedRenderTarget;
                    if (!renderTarget.isConnected) {
                        if (!el.isConnected) continue; // card itself is gone
                        renderTarget = resolveRenderTarget(el);
                    }
                    const extras = { firstEpisode, parentSeries: null, ratingParentSeries: null, renderTarget };

                    for (const [, renderer] of renderers) {
                        if (!renderer.isEnabled()) continue;
                        try { renderer.render(renderTarget, item, extras); } catch {}
                    }
                    JE.core.tagRenderer.applyCornerStacking(renderTarget);
                } catch {}
            }
        }
    }

    // ── Indicator Offset ────────────────────────────────────────────────

    /**
     * Build CSS rules that offset top-right tag containers below Jellyfin's
     * card indicators (unwatched count, played badge). Only tags configured
     * for the top-right corner get the offset. Other positions are untouched.
     * @returns {string} CSS rules string
     */
    function buildIndicatorOffsetCSS() {
        const posMap = {
            'genre-overlay-container': JE.currentSettings?.genreTagsPosition || JE.pluginConfig?.GenreTagsPosition || 'top-right',
            'quality-overlay-container': JE.currentSettings?.qualityTagsPosition || JE.pluginConfig?.QualityTagsPosition || 'top-left',
            'language-overlay-container': JE.currentSettings?.languageTagsPosition || JE.pluginConfig?.LanguageTagsPosition || 'bottom-left',
            'rating-overlay-container': JE.currentSettings?.ratingTagsPosition || JE.pluginConfig?.RatingTagsPosition || 'bottom-right',
            'age-rating-overlay-container': JE.currentSettings?.ageRatingTagsPosition || JE.pluginConfig?.AgeRatingTagsPosition || 'bottom-right',
        };
        const topRightContainers = Object.entries(posMap)
            .filter(([, pos]) => pos === 'top-right')
            .map(([cls]) => `.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host > .${cls}`)
            .join(',\n                ');

        if (!topRightContainers) return '';
        return `${topRightContainers} { margin-top: clamp(20px, 3vw, 30px); }`;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Initialize the tag pipeline: register mutation observer, navigation handler, and inject base CSS.
     * @returns {void}
     */
    function initialize() {
        if (!JE.helpers?.onBodyMutation) {
            console.warn(`${logPrefix} helpers.onBodyMutation not available, retrying...`);
            setTimeout(initialize, 100);
            return;
        }

        // Register as body mutation subscriber at priority 0 (after hidden-content and prefetch).
        // Only trigger scans when nodes were actually added to the DOM — ignore attribute
        // changes, text changes, and hover/focus effects which cause jank if we scan on each.
        JE.helpers.onBodyMutation('tag-pipeline', (mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length > 0) {
                    scheduleScan();
                    return;
                }
            }
        }, { priority: 0 });

        // Also trigger on navigation
        if (JE.helpers.onNavigate) {
            JE.helpers.onNavigate(() => {
                // Invalidate any in-flight batch processing (don't reset isProcessing
                // directly — let stale batches finish naturally and discard results)
                batchGeneration++;
                firstEpisodeCache.clear();
                parentSeriesCache.clear();
                requestQueue = [];
                // Pick up any new items added since last load
                refreshServerCache();
                scheduleScan();
            });
        }

        // Inject CSS containment for all tag overlay containers.
        // This tells the browser these elements are independent from the rest of the
        // card layout, so hover transforms don't trigger re-layout/re-paint of overlays.
        // will-change:transform promotes each container to its own compositor layer.
        if (JE.helpers?.addCSS) {
            // Base CSS: tag host and containment
            JE.helpers.addCSS('je-tag-pipeline-perf', `
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
                .je-tag-host .age-rating-overlay-container {
                    contain: layout style;
                    pointer-events: none;
                    z-index: auto !important;
                }
                /* Offset top-right positioned tag containers when card has visible indicators
                   (unwatched count badge, played checkmark). Indicators are always top-right in Jellyfin.
                   Only affects containers configured for the top-right position. */
                ${buildIndicatorOffsetCSS()}
            `);

            // Card-width sizing; mobile layout and browsers without container queries keep the per-tag rules.
            JE.helpers.addCSS('je-tag-card-scale', `
                @supports (container-type: inline-size) {
                    .je-tag-host { container-type: inline-size; }
                    html:not(.layout-mobile) .je-tag-host .quality-overlay-container { gap: clamp(1px, 1.8cqw, 4px); }
                    html:not(.layout-mobile) .je-tag-host .quality-overlay-label {
                        font-size: clamp(9px, 6.6cqw, 13.6px);
                        padding: clamp(0px, 0.6cqw, 2px) clamp(4px, 4.2cqw, 10px);
                        border-radius: clamp(2px, 2.4cqw, 5px);
                    }
                    html:not(.layout-mobile) .je-tag-host .language-overlay-container { gap: clamp(1px, 1.8cqw, 3px); }
                    html:not(.layout-mobile) .je-tag-host .language-flag { width: clamp(16px, 15cqw, 32px); }
                    html:not(.layout-mobile) .je-tag-host .rating-overlay-container { gap: clamp(2px, 1.8cqw, 3px); }
                    html:not(.layout-mobile) .je-tag-host .rating-tag {
                        font-size: clamp(9px, 6.8cqw, 13px);
                        padding: clamp(2px, 2cqw, 4px) clamp(4px, 4.5cqw, 8px);
                        gap: clamp(2px, 2.2cqw, 4px);
                    }
                    html:not(.layout-mobile) .je-tag-host .rating-star-icon { font-size: clamp(9px, 7cqw, 14px) !important; }
                    html:not(.layout-mobile) .je-tag-host .rating-tomato-icon { width: clamp(9px, 7cqw, 14px); height: clamp(9px, 7cqw, 14px); }
                    html:not(.layout-mobile) .je-tag-host .genre-overlay-container { gap: clamp(2px, 1.8cqw, 4px); }
                    html:not(.layout-mobile) .je-tag-host .genre-tag {
                        width: clamp(18px, 15cqw, 30px);
                        height: clamp(18px, 15cqw, 30px);
                        min-width: clamp(18px, 15cqw, 30px);
                    }
                    html:not(.layout-mobile) .je-tag-host .genre-tag .material-symbols-outlined { font-size: clamp(11px, 9.5cqw, 20px); }
                }
            `);

            // "Hide Tags on Hover" setting: fully hides the tag layer on hover.
            // Without this, Jellyfin's overlay already covers tags (they're behind it).
            // This setting makes them completely invisible for users who want zero clutter.
            JE.helpers.addCSS('je-tag-hover-fade', `
                body.je-tags-hide-on-hover .card:hover .je-tag-host {
                    opacity: 0 !important;
                    transition: opacity 0.15s ease;
                }
            `);
            // Apply the class based on current setting
            if (JE.currentSettings?.tagsHideOnHover) {
                document.body.classList.add('je-tags-hide-on-hover');
            }
        }

        // Load server cache then do initial scan.
        // Cards may have been processed during the async load (via mutation observer),
        // so clear processedCards after load to rescan with the server cache available.
        loadServerCache().then(() => {
            processedCards = new WeakSet();
            runScan();
        });

        console.log(`${logPrefix} Initialized`);
    }

    // ── Expose API ─────────────────────────────────────────────────────

    JE.tagPipeline = {
        registerRenderer,
        initialize,
        getFirstEpisode,
        getParentSeries,
        /** @param {string} name - Renderer name (e.g. 'quality'). */
        getRenderer(name) { return renderers.get(name); },
        /**
         * Review rating averages that came with the server cache, once the
         * load or refresh in flight has settled: Map<"mediaType:tmdbKey",
         * average>, or null when the server cache (or the poster chips) is
         * off — the user review tags then ask /reviews/ratings themselves.
         * @returns {Promise<Map<string, number>|null>}
         */
        getReviewRatings() {
            return (loadInFlight || refreshInFlight || Promise.resolve()).then(() => reviewRatings);
        },
        /**
         * The review rating averages already at hand, without waiting.
         * @returns {Map<string, number>|null}
         */
        peekReviewRatings() { return reviewRatings; },
        /** @returns {number} Bumped each time the review rating averages are replaced. */
        /** @returns {number} performance.now() when the request behind the current review averages started (0 = none). */
        getReviewRatingsRequestedAt() { return reviewRatingsRequestedAt; },
        /**
         * Subscribe to accepted review averages maps.
         * @param {(changed: Set<string>|null) => void} listener - Receives the "mediaType:tmdbKey" keys whose value changed (possibly none), or null for all.
         */
        onReviewRatingsChanged(listener) { reviewRatingsListeners.add(listener); },
        // For reinitialize support
        clearProcessed() {
            processedCards = new WeakSet(); // Create fresh WeakSet so all cards get re-scanned
            requestQueue = [];
            batchGeneration++;
            scanGeneration++; // a scan chain waiting on the stored copy would render into the old set
            firstEpisodeCache.clear();
            parentSeriesCache.clear();
        },
        // Bust the server cache so the next scan re-fetches everything through the
        // spoiler-strip pipeline. Used after toggling Spoiler Guard so newly-eligible
        // items lose their cached unstripped tag data.
        /**
         * @param {{reuseStored?: boolean}} [options] - reuseStored keeps the
         *   browser's stored copy as the source (a user switch: the incoming
         *   user's own copy is still theirs); by default the copy is dropped
         *   and rewritten from a full download, because its per-user strip is
         *   what a Spoiler Guard toggle just changed.
         */
        async invalidateServerCache(options) {
            // Hold a flag for the duration of the reload so concurrent scheduleScan()
            // calls (from the body MutationObserver during the await) no-op instead of
            // processing cards against the empty cache. processedCards is reset a
            // SECOND time after load so cards partially marked during await re-scan.
            isInvalidating = true;
            try {
                dropServerCache();
                processedCards = new WeakSet();
                requestQueue = [];
                batchGeneration++;
                scanGeneration++;
                firstEpisodeCache.clear();
                parentSeriesCache.clear();
                // Clear each renderer's derived cache (e.g. quality's serverQualityCache)
                // so it recomputes from the refreshed, spoiler-stripped server data.
                for (const [, renderer] of renderers) {
                    if (renderer.onServerCacheRefresh) {
                        try { renderer.onServerCacheRefresh(null); } catch {}
                    }
                }
                // Remove overlays ALREADY in the DOM and clear the per-card "tagged"
                // markers. Without this the re-scan skips cards it considers processed,
                // so genre/quality/rating overlays inserted BEFORE Spoiler Guard was
                // enabled linger on unwatched-episode cards until a full page reload.
                // Mirrors what each feature's own reinitialize does.
                try {
                    document.querySelectorAll(
                        '.quality-overlay-container, .rating-overlay-container, '
                        + '.genre-overlay-container, .language-overlay-container, '
                        + '.age-rating-overlay-container'
                    ).forEach(function (el) { el.remove(); });
                    document.querySelectorAll(
                        '[data-je-quality-tagged], [data-je-rating-tagged], '
                        + '[data-je-genre-tagged], [data-je-language-tagged], '
                        + '[data-je-age-rating-tagged]'
                    ).forEach(function (el) {
                        delete el.dataset.jeQualityTagged;
                        delete el.dataset.jeRatingTagged;
                        delete el.dataset.jeGenreTagged;
                        delete el.dataset.jeLanguageTagged;
                        delete el.dataset.jeAgeRatingTagged;
                    });
                } catch (domErr) {
                    console.warn(`${logPrefix} overlay cleanup during invalidate failed:`, domErr);
                }
                await loadServerCache({ forceDownload: !options?.reuseStored });
                processedCards = new WeakSet();
            } catch (e) {
                console.warn(`${logPrefix} invalidateServerCache failed:`, e);
            } finally {
                isInvalidating = false;
            }
            try {
                runScan();
            } catch (e) {
                console.warn(`${logPrefix} post-invalidate scan failed:`, e);
            }
        },
        scheduleScan,
    };

    // The server tag cache is fetched per user (spoiler-stripped for that
    // user), so it must not survive a user switch. Reset synchronously here;
    // the full invalidate-and-reload (which also strips stale DOM overlays)
    // runs once the new user's data is live — reloading at reset time would
    // race the credential swap. The stored copy is per user as well: the
    // outgoing user's is deleted when the incoming user's opens.
    JE.session?.onUserChange('tag-pipeline', () => {
        dropServerCache();
        reviewRatings = null;
        reviewRatingsRequestedAt = 0;
        skipStoreThisSession = false;
        JE.tagPipeline.clearProcessed();
    });
    document.addEventListener('je:user-data-loaded', () => {
        JE.tagPipeline.invalidateServerCache({ reuseStored: true }).catch(() => {});
    });

    console.log(`${logPrefix} Module loaded`);

})(window.JellyfinEnhanced);
