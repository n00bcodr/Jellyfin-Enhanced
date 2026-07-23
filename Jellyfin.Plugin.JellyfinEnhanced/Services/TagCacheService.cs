using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Manages a server-side pre-computed tag cache for all library items.
    /// The cache is stored in memory (ConcurrentDictionary) and persisted to disk as JSON.
    /// Clients fetch the full cache in one GET request instead of making per-page batch calls.
    /// </summary>
    public class TagCacheService : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IApplicationPaths _applicationPaths;
        private readonly Logger _logger;
        private volatile ConcurrentDictionary<string, TagCacheEntry> _cache = new();
        private readonly object _saveLock = new();

        // Guards the {_cacheReleased, _cache, _version, _lastModified} generation
        // as one unit for readers. Publish/release sites mutate all four inside
        // this lock (nested within _saveLock, always in that order), and snapshot
        // readers (GetCacheForUser) take ONLY this lock — its critical sections
        // are a handful of field accesses, so readers never stall behind a
        // multi-second SaveToDisk serialization the way they would on _saveLock.
        private readonly object _publishLock = new();
        private readonly SemaphoreSlim _rebuildLock = new(1, 1);
        private long _version;
        private long _lastModified;
        private long _lastReconciledUtcTicks;
        private Timer? _debounceSaveTimer;
        private volatile bool _dirty;
        private long _firstDirtyTicks; // 0 = nothing dirty since the last disk save

        // Disk-save cadence: a save runs 30s after the last applied change, but under
        // sustained change (a metadata refresh where values really do change on every
        // item) the trailing debounce would keep pushing the save out — so cap the
        // deferral at 5 minutes from the first unsaved change. Worst case is one
        // full-cache write per 5 minutes instead of one per flush cycle (~30s).
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan SaveMaxWait = TimeSpan.FromMinutes(5);

        // Incremental cache maintenance. Library-scan events are recorded here (O(1),
        // no DB/probe work) and drained by a debounced background worker so scans are
        // never blocked and repeated hits on the same id coalesce to one rebuild.
        private readonly TagCachePendingChanges _pending = new();
        private Timer? _flushTimer;
        private long _firstPendingTicks; // 0 = nothing pending since last flush
        private int _flushing;           // 0/1 non-reentrancy guard for the worker
        private volatile bool _disposed; // set in Dispose; stops timer resurrection after teardown
        private static readonly TimeSpan FlushDebounce = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan FlushMaxWait = TimeSpan.FromSeconds(30);

        // Bump whenever a TagCacheEntry field the STRIP paths depend on is added,
        // so a cache serialized by an older build is discarded and rebuilt. v2
        // added SeriesId, which the Spoiler Guard tag-strip requires: a v1 cache
        // has null SeriesId on every episode, so the strip skips them and unstripped
        // ratings leak onto guarded cards via renderFromServerCache. Discarding
        // starts empty (client falls back to the live/per-batch strip) until rebuild.
        private const int CurrentCacheSchemaVersion = 2;

        // Page size for hydrating library items during full builds and
        // reconciliation. Fetching the whole library with one GetItemList call
        // materializes every BaseItem (full metadata, people, streams) at once,
        // which on very large libraries (tens of thousands of items) can exceed
        // the server's memory and OOM-kill Jellyfin. Fetching ids first and then
        // hydrating in fixed-size pages bounds peak memory to one page of items
        // regardless of library size. The resulting TagCacheEntry objects are
        // small (a few hundred bytes) so the cache itself stays cheap.
        private const int HydrationPageSize = 500;

        // User access cache: avoids expensive GetItemIds query on every request
        private readonly ConcurrentDictionary<string, (HashSet<string> Ids, DateTime CachedAt)> _userAccessCache = new();
        private static readonly TimeSpan UserAccessCacheTtl = TimeSpan.FromSeconds(60);

        public static readonly HashSet<BaseItemKind> TaggableTypes = new()
        {
            BaseItemKind.Movie,
            BaseItemKind.Episode,
            BaseItemKind.Series,
            BaseItemKind.Season,
            BaseItemKind.BoxSet,
        };

        public TagCacheService(ILibraryManager libraryManager, IApplicationPaths applicationPaths, Logger logger)
        {
            _libraryManager = libraryManager;
            _applicationPaths = applicationPaths;
            _logger = logger;

            // The service is a DI singleton; expose it so the plugin's
            // UpdateConfiguration override can reach the running instance when the
            // admin toggles the Server-Side Tag Cache setting (same pattern as
            // JellyfinEnhanced.Instance — the plugin class has no DI access).
            Instance = this;
        }

        /// <summary>
        /// The running singleton, for the config-save transition hook in
        /// <see cref="JellyfinEnhanced.UpdateConfiguration"/>. Null until DI
        /// constructs the service (and again after disposal).
        /// </summary>
        internal static TagCacheService? Instance { get; private set; }

        /// <summary>
        /// Live read of the admin "Server-Side Tag Cache" setting. Long-running
        /// builds re-check this at page boundaries so an admin turning the cache
        /// off (e.g. under memory pressure) actually stops the work instead of
        /// only preventing the next run.
        /// </summary>
        private static bool ServerModeEnabled => JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode == true;

        /// <summary>
        /// Shared abort condition for every expensive or state-publishing cache
        /// phase (build pages, reconcile rebuild/sweep loops, publishes, saves):
        /// stop when the admin turned the setting off OR the service is being
        /// torn down. Checked mid-run, not just at entry, so neither a disable
        /// nor a shutdown has to wait behind a large-library operation.
        /// </summary>
        private bool ShouldAbortCacheWork => _disposed || !ServerModeEnabled;

        // True whenever the in-memory cache is NOT a published complete state:
        // from construction until the first successful LoadFromDisk/full-build
        // publish, and again between OnServerModeDisabled releasing the cache and
        // the next publish. Distinguishes "empty/placeholder" from "has real
        // entries": an incremental flush landing while unpublished (e.g. after a
        // failed startup build, or in the release->re-enable window) would make
        // the cache non-empty with a stray entry, and gating full builds and
        // snapshot reloads on IsEmpty alone would then mistake that near-empty
        // cache for a complete one — delta-reconciling and even persisting it.
        // While true: flushes defer, SaveToDisk refuses, reconcile full-builds.
        private volatile bool _cacheReleased = true;

        // Serializes server-mode transitions (and orders them after one another)
        // off the config-save thread. ContinueWith chaining keeps strict FIFO
        // order for rapid toggles; each queued transition re-reads the CURRENT
        // setting when it runs, so intermediate flips converge on the final state
        // instead of racing each other's release/reload work.
        private Task _transitionQueue = Task.CompletedTask;
        private readonly object _transitionQueueLock = new();

        public long Version => Interlocked.Read(ref _version);
        public long LastModified => Interlocked.Read(ref _lastModified);
        public int Count => _cache.Count;

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "tag-cache.json");

        /// <summary>
        /// Build the complete tag cache for all library items.
        /// Called by the scheduled task on startup and periodically.
        /// </summary>
        public void BuildFullCache(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            _rebuildLock.Wait(cancellationToken);
            try
            {
                BuildFullCacheCore(progress, cancellationToken, DateTime.UtcNow);
            }
            finally
            {
                _rebuildLock.Release();
            }
        }

        private void BuildFullCacheCore(IProgress<double>? progress, CancellationToken cancellationToken, DateTime reconciliationStartedUtc)
        {
            _logger.Info("[TagCache] Starting full cache build...");
            var sw = System.Diagnostics.Stopwatch.StartNew();

            // Ids only — a Guid list is tiny even for huge libraries. The heavy
            // BaseItem hydration happens page by page below so the build never
            // holds more than HydrationPageSize full items at a time.
            var allIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                IsVirtualItem = false,
                Recursive = true
            });

            _logger.Info($"[TagCache] Found {allIds.Count} taggable items");

            var newCache = new ConcurrentDictionary<string, TagCacheEntry>();
            var processed = 0;

            foreach (var page in HydrateInPages(allIds, cancellationToken))
            {
                // Stop promptly if the admin turned the cache off (or the server
                // is shutting down) mid-build; the partial result is discarded,
                // not published.
                if (ShouldAbortCacheWork)
                {
                    _logger.Info("[TagCache] Full build aborted (setting disabled or server shutting down); nothing published.");
                    return;
                }

                foreach (var item in page)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var entry = BuildEntryForItem(item);
                    if (entry != null)
                    {
                        var key = item.Id.ToString("N").ToLowerInvariant();
                        newCache[key] = entry;
                    }
                }

                // An item deleted between the id query and its page hydration just
                // doesn't come back, so advance by the page's actual size.
                processed += page.Count;
                progress?.Report((double)processed / allIds.Count * 100);
            }

            // Final gate before publishing (the loop check can't run when the
            // setting flips after the last page). The swap below happens while
            // this thread holds _rebuildLock and OnServerModeDisabled also runs
            // under that lock, so a disable can't interleave with the publish —
            // it either aborts the build here or releases the published cache
            // afterwards.
            if (ShouldAbortCacheWork)
            {
                _logger.Info("[TagCache] Full build aborted (setting disabled or server shutting down); nothing published.");
                return;
            }

            // Atomic reference swap — readers see old or new cache, never partial.
            // Flag, swap AND version/timestamp under _saveLock: a stale-armed save
            // timer can't observe the cleared flag with the placeholder still in
            // _cache, and a snapshot read (GetCacheForUser) can't pair the new
            // dictionary with the previous generation's version/timestamp — a
            // request stamped with a pre-first-publish timestamp of 0 would
            // permanently disable that client's delta refresh.
            lock (_saveLock)
            {
                lock (_publishLock)
                {
                    _cacheReleased = false;
                    _cache = newCache;
                    Interlocked.Increment(ref _version);
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                }
            }

            Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciliationStartedUtc.Ticks);
            // Invalidate user access cache since items may have changed
            _userAccessCache.Clear();
            progress?.Report(100);

            sw.Stop();
            _logger.Info($"[TagCache] Full cache build complete: {_cache.Count} entries in {sw.Elapsed.TotalSeconds:F1}s");

            SaveToDisk();
        }

        /// <summary>
        /// Reconcile the persisted tag cache with Jellyfin's saved-item timestamps.
        /// Rebuilds only items saved since the previous successful run, then sweeps
        /// cached IDs that no longer exist in the live library.
        /// </summary>
        public void ReconcileCache(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            _rebuildLock.Wait(cancellationToken);
            try
            {
                ReconcileCacheCore(progress, cancellationToken);
            }
            finally
            {
                _rebuildLock.Release();
            }
        }

        private void ReconcileCacheCore(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            var reconciliationStartedUtc = DateTime.UtcNow;
            var previousTicks = Interlocked.Read(ref _lastReconciledUtcTicks);

            // _cacheReleased also forces the full path: after a release, "has a
            // few entries" (e.g. from any stray incremental work) must not be
            // mistaken for a complete cache — a delta reconcile of it would serve
            // a near-empty library as if whole.
            if (_cacheReleased || _cache.IsEmpty)
            {
                _logger.Info("[TagCache] Cache is empty; running full build");
                BuildFullCacheCore(progress, cancellationToken, reconciliationStartedUtc);
                return;
            }

            if (previousTicks <= 0)
            {
                previousTicks = reconciliationStartedUtc.Ticks;
                Interlocked.Exchange(ref _lastReconciledUtcTicks, previousTicks);
                _logger.Info("[TagCache] No previous reconciliation marker; seeding marker and running delta reconciliation");
            }

            var changedSinceUtc = new DateTime(previousTicks, DateTimeKind.Utc).Subtract(TimeSpan.FromMinutes(2));
            _logger.Info($"[TagCache] Reconciling changes since {changedSinceUtc:O}");

            // Same paged hydration as the full build: after a sweeping change
            // (e.g. a full metadata refresh) this delta can cover most of the
            // library, so materializing it with one GetItemList call has the
            // same OOM potential as the unpaged full build.
            var changedIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                IsVirtualItem = false,
                Recursive = true,
                MinDateLastSaved = changedSinceUtc
            });

            var idsToRebuild = new HashSet<Guid>();
            foreach (var page in HydrateInPages(changedIds, cancellationToken))
            {
                // Same mid-run gate as the full build: stop when the admin turns
                // the cache off instead of finishing expensive work they opted out of.
                if (ShouldAbortCacheWork)
                {
                    _logger.Info("[TagCache] Reconciliation aborted (setting disabled or server shutting down).");
                    return;
                }

                foreach (var item in page)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    idsToRebuild.Add(item.Id);

                    if (item is MediaBrowser.Controller.Entities.TV.Episode episode)
                    {
                        if (episode.SeriesId != Guid.Empty)
                        {
                            idsToRebuild.Add(episode.SeriesId);
                        }

                        if (episode.SeasonId != Guid.Empty)
                        {
                            idsToRebuild.Add(episode.SeasonId);
                        }
                    }
                }
            }

            var changed = false;
            var rebuilt = 0;
            foreach (var id in idsToRebuild)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // After a sweeping change (full metadata refresh) this loop can
                // cover most of the library, so it needs the same mid-run abort
                // as the hydration pages — otherwise a disable mid-reconcile
                // keeps doing per-item probe work the admin just opted out of.
                if (ShouldAbortCacheWork)
                {
                    _logger.Info("[TagCache] Reconciliation aborted (setting disabled or server shutting down).");
                    return;
                }

                changed |= RebuildEntry(id);
                rebuilt++;
                progress?.Report(idsToRebuild.Count == 0 ? 50 : (double)rebuilt / idsToRebuild.Count * 80);
            }

            var currentIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                IsVirtualItem = false,
                Recursive = true
            });

            var liveKeys = currentIds
                .Select(id => id.ToString("N").ToLowerInvariant())
                .ToHashSet(StringComparer.Ordinal);

            // Collect the keys to sweep WITHOUT mutating the cache: entry updates
            // above are idempotent and safe to abort mid-way (the marker didn't
            // advance, so the next run redoes them), but removals are not — a
            // removed entry takes its stored SeriesId with it, so an abort after
            // partial removals could persist a cache whose deleted entries can
            // never get their parent repair, with no version bump to make
            // delta-polling clients drop them.
            var keysToSweep = new List<string>();
            foreach (var cachedKey in _cache.Keys)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (!liveKeys.Contains(cachedKey))
                {
                    keysToSweep.Add(cachedKey);
                }
            }

            // Single commit gate. Everything after it — removals, parent Series/
            // Season repairs, version bump, marker advance, disk save — runs as
            // one unit with no further abort points, so the swept state is only
            // ever observed (and persisted) complete. A disable landing during
            // the commit waits on _rebuildLock for the bounded remainder.
            if (ShouldAbortCacheWork)
            {
                _logger.Info("[TagCache] Reconciliation aborted before commit (setting disabled or server shutting down); nothing saved.");
                return;
            }

            // Parents of swept entries. Removals that happened while the monitor
            // wasn't listening (server-mode-off window, plugin stopped) never
            // enqueued their parent Series rebuild, so a Series entry can keep
            // serving first-episode data derived from a deleted item. The swept
            // entry's stored SeriesId lets the sweep queue that repair here.
            var parentSeriesToRebuild = new HashSet<Guid>();
            foreach (var key in keysToSweep)
            {
                if (_cache.TryRemove(key, out var removedEntry))
                {
                    changed = true;
                    if (removedEntry?.SeriesId != null && Guid.TryParse(removedEntry.SeriesId, out var seriesId))
                    {
                        parentSeriesToRebuild.Add(seriesId);
                    }
                }
            }

            // Log-and-continue on every repair step, never throw: the removals
            // above are already applied, so an exception escaping this loop would
            // skip the version bump and save below — delta-polling clients would
            // then keep the removed (phantom) entries until some unrelated change
            // bumps the version. Failed steps are requeued by their own id via
            // the incremental pipeline (EnqueueUpdate is O(1) and never throws;
            // the flush retries once this lock frees), so a transient failure
            // doesn't strand a parent entry either.
            foreach (var seriesId in parentSeriesToRebuild)
            {
                try
                {
                    changed |= RebuildEntry(seriesId);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[TagCache] Failed to repair series entry {seriesId}: {ex.Message}");
                    EnqueueUpdate(seriesId);
                }

                // The removed entry only records its SeriesId, so the deleted
                // item's former Season can't be identified directly — but Season
                // entries also derive first-episode data, so rebuild all of the
                // affected series' seasons (a handful of items) rather than leave
                // one serving streams from a deleted file indefinitely.
                IReadOnlyList<BaseItem> seasons;
                try
                {
                    seasons = GetSeasonsOfSeries(seriesId);
                }
                catch (Exception ex)
                {
                    // Season ids are unknowable without this query, so they can't
                    // be requeued individually — the one residual staleness gap.
                    _logger.Warning($"[TagCache] Failed to get seasons for series {seriesId}: {ex.Message}");
                    continue;
                }

                foreach (var season in seasons)
                {
                    try
                    {
                        changed |= RebuildEntry(season.Id);
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[TagCache] Failed to repair season entry {season.Id}: {ex.Message}");
                        EnqueueUpdate(season.Id);
                    }
                }
            }

            if (changed)
            {
                // Under both locks so a snapshot read pairs the bumped version
                // with the swept cache state (see the build-publish comment).
                lock (_saveLock)
                {
                    lock (_publishLock)
                    {
                        Interlocked.Increment(ref _version);
                        Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    }
                }

                _userAccessCache.Clear();
            }

            Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciliationStartedUtc.Ticks);
            progress?.Report(100);
            SaveToDisk();

            _logger.Info($"[TagCache] Reconciliation complete: {changedIds.Count} changed items, {idsToRebuild.Count} entries checked");
        }

        /// <summary>
        /// Queue an item to be (re)built in the cache. Called by TagCacheMonitor on
        /// ItemAdded/ItemUpdated. This only records the id and arms a debounced
        /// background flush — it performs NO database query and NO media probe, so it
        /// is safe to call on Jellyfin's synchronous library-scan thread. The heavy
        /// BuildEntryForItem work happens off-thread in <see cref="FlushPending"/>,
        /// and a burst of events for the same id collapses to a single rebuild.
        /// </summary>
        public void EnqueueUpdate(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            _pending.Record(itemId, removed: false); // O(1) record-and-defer, safe on the scan thread
            ScheduleFlush();
        }

        /// <summary>
        /// Queue an item to be removed from the cache. Called by TagCacheMonitor on
        /// ItemRemoved. Like <see cref="EnqueueUpdate"/>, this does no work on the
        /// caller's thread beyond recording the id.
        /// </summary>
        public void EnqueueRemoval(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            _pending.Record(itemId, removed: true);
            ScheduleFlush();
        }

        /// <summary>
        /// Stamp the first-pending time (if unset) and arm the debounced background flush.
        /// </summary>
        private void ScheduleFlush()
        {
            Interlocked.CompareExchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks, 0);
            ArmFlushTimer(ComputeFlushDelay());
        }

        /// <summary>
        /// Arm (or reset) the single flush timer to fire once after <paramref name="due"/>.
        /// </summary>
        private void ArmFlushTimer(TimeSpan due)
        {
            // Never resurrect a timer after Dispose: a concurrent FlushPending's finally
            // re-arm (or a late library event) could otherwise create a live Timer after
            // Dispose already nulled/disposed it, leaking a callback into a torn-down service.
            if (_disposed) return;

            var existing = _flushTimer;
            if (existing != null)
            {
                try
                {
                    existing.Change(due, Timeout.InfiniteTimeSpan);
                    return;
                }
                catch (ObjectDisposedException) { }
            }

            var timer = new Timer(_ => FlushPending(), null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _flushTimer, timer);
            if (old != null && !ReferenceEquals(old, timer))
            {
                old.Dispose();
            }

            // Close the check-then-create race with Dispose: if Dispose set _disposed after we
            // passed the guard above but our timer was already published, reclaim and dispose it
            // so we never leave a live callback on a torn-down service.
            if (_disposed)
            {
                var orphan = Interlocked.Exchange(ref _flushTimer, null);
                orphan?.Dispose();
            }
        }

        private TimeSpan ComputeFlushDelay() =>
            ComputeFlushDelay(Interlocked.Read(ref _firstPendingTicks), DateTime.UtcNow, FlushDebounce, FlushMaxWait);

        /// <summary>
        /// Debounced due-time with a hard cap: normally <paramref name="debounce"/> after the last
        /// change, but never later than <paramref name="maxWait"/> after the first pending change,
        /// so a continuous scan that keeps resetting the debounce still flushes periodically. Pure
        /// (clock passed in) so the cap math is unit-testable without wall-clock waits.
        /// </summary>
        internal static TimeSpan ComputeFlushDelay(long firstPendingTicks, DateTime nowUtc, TimeSpan debounce, TimeSpan maxWait)
        {
            if (firstPendingTicks == 0) return debounce;

            var elapsed = nowUtc - new DateTime(firstPendingTicks, DateTimeKind.Utc);
            var remainingCap = maxWait - elapsed;
            if (remainingCap <= TimeSpan.Zero) return TimeSpan.Zero;
            return remainingCap < debounce ? remainingCap : debounce;
        }

        /// <summary>
        /// Drain the pending set and apply each change on a background thread. Never
        /// runs on the scan thread. Non-reentrant: an overlapping timer tick re-arms
        /// instead of running a second concurrent flush.
        /// </summary>
        private void FlushPending()
        {
            // Non-reentrant: if a flush already owns the batch, retry after the debounce.
            // (Retry via ArmFlushTimer, NOT ScheduleFlush: once the first pending change is older
            // than FlushMaxWait, ScheduleFlush would compute a zero delay and busy-spin the timer
            // until the running flush exits.)
            if (Interlocked.Exchange(ref _flushing, 1) == 1)
            {
                ArmFlushTimer(FlushDebounce);
                return;
            }

            var retryLater = false;
            try
            {
                // A full build/reconcile (or a server-mode transition) owns the
                // cache: applying the batch now would write into a dictionary
                // about to be swapped away — after having been drained from
                // _pending. Defer instead; the queued ids apply to the NEW cache
                // once the lock is free. (Wait(0): never block the timer thread
                // for the duration of a large-library build.)
                if (!_rebuildLock.Wait(0))
                {
                    // Restart the cap clock while deferring: the cap exists to stop
                    // a busy scan from starving flushes, but flushes CANNOT run
                    // while a rebuild owns the lock — leaving the stamp past the
                    // cap would make every library event fire a zero-delay timer
                    // tick for the whole build.
                    Interlocked.Exchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks);
                    retryLater = true;
                    return;
                }

                try
                {
                    // Mode check UNDER the lock (transitions also hold it), so the
                    // observation can't race a concurrent release: applying a batch
                    // into a released cache would repopulate memory the admin just
                    // freed and mark it dirty for persistence. Discarding is safe —
                    // the re-enable transition reconciles by item save timestamps,
                    // which covers every id dropped here.
                    if (!ServerModeEnabled)
                    {
                        Interlocked.Exchange(ref _firstPendingTicks, 0);
                        _pending.Drain();
                        return;
                    }

                    // Mode is ON but the cache is still the released placeholder:
                    // an enable catch-up is queued or between its load/reconcile
                    // steps. Applying now would seed a near-empty cache that the
                    // reconcile would then mistake for a live one. Keep the ids
                    // pending instead — they apply after the catch-up publishes.
                    if (_cacheReleased)
                    {
                        Interlocked.Exchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks);
                        retryLater = true;
                        return;
                    }

                    Interlocked.Exchange(ref _firstPendingTicks, 0);
                    if (ApplyBatch(_pending.Drain(), RebuildEntry, RemoveEntry))
                    {
                        Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                        ScheduleDebouncedSave();
                    }
                }
                finally
                {
                    _rebuildLock.Release();
                }
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
                if (retryLater)
                {
                    // Fixed debounce, NOT ScheduleFlush: the cap window has often
                    // already elapsed here, and a zero-delay reschedule would
                    // busy-spin the timer for the whole build.
                    ArmFlushTimer(FlushDebounce);
                }
                else if (!_pending.IsEmpty)
                {
                    // Ids recorded while we were draining/applying: run again (cap-aware).
                    ScheduleFlush();
                }
            }
        }

        /// <summary>
        /// Apply a drained batch: removals -> <paramref name="remove"/>, updates -> <paramref name="rebuild"/>.
        /// A failing entry is logged and skipped, never aborting the rest of the batch. Returns true if any
        /// change modified the cache. The host lookups live behind the delegates so the dispatch, resilience
        /// and change-aggregation can be unit-tested without a live library.
        /// </summary>
        internal bool ApplyBatch(IReadOnlyList<(Guid Id, bool Removed)> batch, Func<Guid, bool> rebuild, Func<Guid, bool> remove)
        {
            var changed = false;
            foreach (var (id, removed) in batch)
            {
                try
                {
                    changed |= removed ? remove(id) : rebuild(id);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[TagCache] Failed to apply pending change for {id}: {ex.Message}");
                }
            }

            return changed;
        }

        /// <summary>
        /// Resolve an id to its live library item and (re)build its cache entry.
        /// Returns true if the cache was modified. Runs on the flush worker only.
        /// </summary>
        private bool RebuildEntry(Guid id)
        {
            var item = _libraryManager.GetItemById<BaseItem>(id);
            if (item == null) return false; // gone before we processed it; ItemRemoved cleans up

            var kind = item.GetBaseItemKind();
            if (!TaggableTypes.Contains(kind)) return false;

            var entry = BuildEntryForItem(item);
            if (entry == null) return false;

            var key = id.ToString("N").ToLowerInvariant();

            // No-op guard: Jellyfin raises ItemUpdated for every item a nightly
            // library scan (or chapter/trickplay task) re-saves, whether or not any
            // tag-relevant data changed. Reporting those rebuilds as changes made
            // every scan re-serialize the entire cache to disk every ~30s for the
            // scan's duration. Keeping the existing entry also preserves its
            // LastUpdated stamp, so delta requests (?since=) correctly skip it.
            if (_cache.TryGetValue(key, out var existing) && TagCacheEntry.ContentEquals(existing, entry))
            {
                return false;
            }

            _cache[key] = entry;
            return true;
        }

        private bool RemoveEntry(Guid id)
        {
            var key = id.ToString("N").ToLowerInvariant();
            if (!_cache.TryRemove(key, out _)) return false;

            // Removals are the one mutation the ?since delta protocol cannot express
            // (a deleted key simply stops appearing), so clients only purge a removed
            // entry when the version changes and they do a full reload. Bump it here:
            // with the no-op rebuild guard, a quiet night no longer bumps the version
            // via reconciliation, which used to mask this gap.
            Interlocked.Increment(ref _version);
            return true;
        }

        /// <summary>
        /// Get cache entries filtered by a user's library access, together with
        /// the version and timestamp belonging to the SAME cache generation.
        /// User access IDs are cached for 60 seconds to avoid expensive DB queries.
        /// Optionally returns only entries modified after a given timestamp.
        /// The out values must come from the same _publishLock-guarded capture as
        /// the dictionary reference: pairing a freshly published cache with the
        /// previous generation's version/timestamp would let a client store a
        /// pre-first-publish timestamp of 0 (which disables its delta refresh)
        /// or a version the next poll can't detect a rebuild against.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetCacheForUser(JUser user, out long version, out long timestamp, long? since = null)
        {
            ConcurrentDictionary<string, TagCacheEntry> cache;
            lock (_publishLock)
            {
                version = Interlocked.Read(ref _version);
                timestamp = Interlocked.Read(ref _lastModified);
                cache = _cache;

                // A request that passed the controller's mode gate can still land
                // here after a disable released the caches; running the expensive
                // per-user GetItemIds then would park a large accessible-id set in
                // _userAccessCache for the whole off window (nothing evicts it
                // while the endpoint 404s). Serve empty instead — the client falls
                // back to batch mode, exactly as if it had hit the 404.
                if (!ServerModeEnabled || _cacheReleased)
                {
                    return new Dictionary<string, TagCacheEntry>();
                }
            }

            var userKey = user.Id.ToString("N");

            // Check user access cache
            HashSet<string> accessibleSet;
            if (_userAccessCache.TryGetValue(userKey, out var cached) && DateTime.UtcNow - cached.CachedAt < UserAccessCacheTtl)
            {
                accessibleSet = cached.Ids;
            }
            else
            {
                var accessibleIds = _libraryManager.GetItemIds(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = TaggableTypes.ToArray(),
                    Recursive = true
                });
                accessibleSet = new HashSet<string>(
                    accessibleIds.Select(id => id.ToString("N").ToLowerInvariant())
                );

                // Store under _publishLock with the released flag re-checked:
                // the entry bail above is check-then-act, and a disable can
                // complete while the GetItemIds query runs. The disable clears
                // _userAccessCache inside the same lock as it sets the flag, so
                // this store either lands before the clear (and is cleared) or
                // sees the flag and skips — it can never repopulate the access
                // cache for the off window.
                lock (_publishLock)
                {
                    if (ServerModeEnabled && !_cacheReleased)
                    {
                        _userAccessCache[userKey] = (accessibleSet, DateTime.UtcNow);
                    }
                }
            }

            var result = new Dictionary<string, TagCacheEntry>();
            foreach (var kvp in cache)
            {
                if (!accessibleSet.Contains(kvp.Key)) continue;
                if (since.HasValue && kvp.Value.LastUpdated <= since.Value) continue;
                result[kvp.Key] = kvp.Value;
            }

            return result;
        }

        /// <summary>
        /// Queue a server-mode transition after the admin saved a config where
        /// the "Server-Side Tag Cache" setting flipped. Runs on a background
        /// continuation — the config save must never block behind cache work —
        /// and transitions are strictly serialized in save order, with each one
        /// re-reading the CURRENT setting when it actually runs. Rapid toggles
        /// therefore converge on the final state instead of an enable's snapshot
        /// reload racing a later disable's release (both hooks are idempotent).
        /// </summary>
        internal void QueueServerModeTransition()
        {
            lock (_transitionQueueLock)
            {
                _transitionQueue = _transitionQueue.ContinueWith(
                    _ => RunServerModeTransition(),
                    CancellationToken.None,
                    TaskContinuationOptions.None,
                    TaskScheduler.Default);
            }
        }

        private void RunServerModeTransition()
        {
            if (_disposed) return;

            try
            {
                if (ServerModeEnabled)
                {
                    // Subscribe the monitor FIRST so items changed during the
                    // (potentially long) catch-up queue as pending ids — the
                    // flush defers while the rebuild lock is held and applies
                    // them to the new cache after the swap.
                    TagCacheMonitor.Instance?.EnsureSubscribed();
                    OnServerModeEnabled();
                }
                else
                {
                    OnServerModeDisabled();
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[TagCache] Server-mode transition failed (tags fall back to batch mode until the next refresh): {ex.Message}");
            }
        }

        /// <summary>
        /// Transition to OFF. Persists any unsaved changes first — so the on-disk
        /// snapshot stays current for a later re-enable — then releases the
        /// in-memory cache and discards queued ids. Freeing memory on the running
        /// server is precisely why an admin disables this on a memory-constrained
        /// system, so "off" must mean the memory is actually returned, not just
        /// that the endpoint 404s. Runs under _rebuildLock: an in-flight
        /// build/reconcile sees the flipped setting at its next gate and aborts,
        /// this then waits for that abort, so no rebuild or flush can repopulate
        /// the released cache or overwrite the snapshot afterwards (their gates
        /// and the save timer all re-check the setting).
        /// </summary>
        internal void OnServerModeDisabled()
        {
            _rebuildLock.Wait();
            try
            {
                _pending.Drain();
                Interlocked.Exchange(ref _firstPendingTicks, 0);

                // _saveLock makes save-then-release atomic against the debounce
                // save timer: a timer save either completes here first (and
                // snapshots the still-full cache) or runs after the release and
                // is rejected by SaveToDisk's _cacheReleased guard. (Monitor
                // locks are reentrant, so the nested SaveToDisk is fine.)
                lock (_saveLock)
                {
                    if (_dirty) SaveToDisk();

                    // The user-access clear sits INSIDE _publishLock so it is
                    // atomic with the flag: GetCacheForUser stores into
                    // _userAccessCache only under this lock with the flag
                    // re-checked, so no request can repopulate it post-release.
                    lock (_publishLock)
                    {
                        _cacheReleased = true;
                        _cache = new ConcurrentDictionary<string, TagCacheEntry>();
                        _userAccessCache.Clear();
                    }
                }
            }
            finally
            {
                _rebuildLock.Release();
            }

            _logger.Info("[TagCache] Server-Side Tag Cache disabled; in-memory cache released (snapshot kept on disk for re-enable).");
        }

        /// <summary>
        /// Transition to ON. Restores the last persisted snapshot for instant
        /// serving, then reconciles by item save timestamps (a full paged build
        /// if no usable snapshot exists), so changes made during the off window
        /// are caught up immediately instead of waiting for the daily task.
        /// Reloads on _cacheReleased as well as IsEmpty: a single incremental
        /// flush landing between release and re-enable would otherwise make the
        /// cache "non-empty" and skip the reload, serving a near-empty cache as
        /// if complete (the reload replaces such stray entries; the reconcile
        /// re-covers them via their save timestamps).
        /// </summary>
        internal void OnServerModeEnabled()
        {
            if (_cacheReleased || _cache.IsEmpty)
            {
                LoadFromDisk();
            }

            ReconcileCache(null, CancellationToken.None);
        }

        /// <summary>
        /// Load the cache from disk (startup, or the re-enable transition).
        /// Runs under _rebuildLock so the publish can't interleave with a
        /// build's swap or a disable's release, and re-checks the setting under
        /// the lock so a load racing a disable can't resurrect the cache the
        /// disable just released.
        /// </summary>
        public void LoadFromDisk()
        {
            _rebuildLock.Wait();
            try
            {
                if (ShouldAbortCacheWork) return;
                LoadFromDiskCore();
            }
            finally
            {
                _rebuildLock.Release();
            }
        }

        private void LoadFromDiskCore()
        {
            var path = CacheFilePath;
            if (!File.Exists(path))
            {
                _logger.Info("[TagCache] No cache file found, starting empty");
                return;
            }

            try
            {
                // Deserialize straight from the file stream: on very large
                // libraries the serialized cache is tens of MB, and reading it
                // into an intermediate string would transiently double the load
                // cost (UTF-16 string + object graph) for no benefit.
                TagCacheDiskFormat? data;
                using (var stream = File.OpenRead(path))
                {
                    data = JsonSerializer.Deserialize<TagCacheDiskFormat>(stream);
                }

                if (data?.Items != null)
                {
                    // Discard a cache written by an older schema (e.g. predating
                    // SeriesId) rather than serving entries the strip paths can't
                    // process. Starting empty is safe — the refresh task rebuilds it.
                    if (data.SchemaVersion != CurrentCacheSchemaVersion)
                    {
                        _logger.Info($"[TagCache] On-disk cache schema v{data.SchemaVersion} != current v{CurrentCacheSchemaVersion}; discarding {data.Items.Count} entries and rebuilding on next scan.");
                        return;
                    }
                    // Re-gate right before publishing: deserializing a large
                    // snapshot takes long enough for the admin to flip the
                    // setting off mid-load, and publishing then would park the
                    // full cache in memory while the mode is off.
                    if (ShouldAbortCacheWork)
                    {
                        _logger.Info("[TagCache] Disk load aborted (setting disabled or server shutting down); discarding.");
                        return;
                    }

                    var loaded = new ConcurrentDictionary<string, TagCacheEntry>(data.Items);

                    // Same _saveLock discipline as the build publish: flag, swap
                    // and version/timestamp change together or not at all from a
                    // saver's or snapshot-reader's view.
                    lock (_saveLock)
                    {
                        lock (_publishLock)
                        {
                            _cacheReleased = false;
                            _cache = loaded;
                            Interlocked.Exchange(ref _version, data.Version);
                            Interlocked.Exchange(ref _lastModified, data.LastModified);
                        }
                    }
                    var reconciledTicks = data.LastReconciledUtcTicks;
                    if (reconciledTicks <= 0 && data.Items.Count > 0)
                    {
                        reconciledTicks = File.GetLastWriteTimeUtc(path).Ticks;
                        _logger.Info($"[TagCache] On-disk cache has no reconciliation marker; using cache file timestamp {new DateTime(reconciledTicks, DateTimeKind.Utc):O}");
                    }
                    Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciledTicks);
                    _logger.Info($"[TagCache] Loaded {_cache.Count} entries from disk (v{data.Version}, schema v{data.SchemaVersion})");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to load cache from disk: {ex.Message}");
            }
        }

        /// <summary>
        /// Persist the cache to disk using atomic write (temp file + rename).
        /// </summary>
        public void SaveToDisk()
        {
            lock (_saveLock)
            {
                // Released cache must never reach disk: a save timer that passed
                // its dirty/mode check just before the release would otherwise
                // block on this lock and then snapshot the swapped-in empty
                // dictionary, overwriting the good snapshot. The release itself
                // saves BEFORE setting _cacheReleased (under this same lock), and
                // re-enable clears the flag before anything new needs saving.
                if (_cacheReleased)
                {
                    return;
                }
                // Clear the dirty state BEFORE snapshotting, not after the write: a change
                // applied while serialization is in progress isn't in the snapshot, and
                // clearing afterwards would wipe its flag — the armed save timer would then
                // see _dirty == false and skip, leaving that change unpersisted until the
                // next event. Cleared first, a concurrent ScheduleDebouncedSave re-marks
                // dirty and its timer performs a follow-up save that includes the change.
                _dirty = false;
                var previousStamp = Interlocked.Exchange(ref _firstDirtyTicks, 0);

                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    var data = new TagCacheDiskFormat
                    {
                        SchemaVersion = CurrentCacheSchemaVersion,
                        Version = Interlocked.Read(ref _version),
                        LastModified = Interlocked.Read(ref _lastModified),
                        LastReconciledUtcTicks = Interlocked.Read(ref _lastReconciledUtcTicks),
                        Items = new Dictionary<string, TagCacheEntry>(_cache)
                    };

                    // Serialize straight to the temp file: building the whole
                    // payload as one string first would transiently hold tens of
                    // MB of UTF-16 on large libraries (see LoadFromDisk).
                    var tempPath = CacheFilePath + ".tmp";
                    using (var stream = File.Create(tempPath))
                    {
                        JsonSerializer.Serialize(stream, data, new JsonSerializerOptions { WriteIndented = false });
                    }

                    File.Move(tempPath, CacheFilePath, overwrite: true);

                    _logger.Info($"[TagCache] Saved {_cache.Count} entries to disk");
                }
                catch (Exception ex)
                {
                    // Failed write: restore the dirty state so Dispose's final
                    // `if (_dirty) SaveToDisk()` and the next debounce cycle retry it.
                    // Intentionally NOT re-arming the save timer here: with the cap
                    // window already elapsed the due time would be zero, and a
                    // persistent disk failure would spin fire-fail-rearm. The next
                    // library event, shutdown, or daily reconcile retries instead.
                    // Restore the ORIGINAL first-dirty stamp (not "now"): re-seeding
                    // with the current time would restart the SaveMaxWait cap window
                    // on every failed attempt and stretch the retry cadence. If a
                    // concurrent ScheduleDebouncedSave already stamped a newer window,
                    // keep that one — a slightly later cap is harmless.
                    _dirty = true;
                    if (previousStamp != 0)
                    {
                        Interlocked.CompareExchange(ref _firstDirtyTicks, previousStamp, 0);
                    }

                    _logger.Error($"[TagCache] Failed to save cache to disk: {ex.Message}");
                }
            }
        }

        private void ScheduleDebouncedSave()
        {
            _dirty = true;
            Interlocked.CompareExchange(ref _firstDirtyTicks, DateTime.UtcNow.Ticks, 0);
            // During/after shutdown, persist synchronously instead of arming a timer that a
            // torn-down service would never fire. This is what keeps a flush that finishes
            // AFTER Dispose's (bounded) wait from losing its applied changes — it saves them
            // now rather than relying on a debounce timer that will never run.
            if (_disposed)
            {
                if (ServerModeEnabled) SaveToDisk();
                return;
            }

            // Trailing debounce with a hard cap (same math as the flush timer): 30s after
            // the last change, but never more than 5 minutes after the first unsaved one,
            // so sustained real changes can't starve persistence NOR write every cycle.
            var due = ComputeFlushDelay(Interlocked.Read(ref _firstDirtyTicks), DateTime.UtcNow, SaveDebounce, SaveMaxWait);

            // Reuse existing timer if possible, otherwise create a new one.
            // Change() resets the countdown without creating a new object.
            var existing = _debounceSaveTimer;
            if (existing != null)
            {
                try
                {
                    existing.Change(due, Timeout.InfiniteTimeSpan);
                    return;
                }
                catch (ObjectDisposedException) { }
            }
            var timer = new Timer(_ =>
            {
                // The mode gate keeps a save armed before a disable from writing
                // the post-release (near-empty) cache over the good snapshot;
                // OnServerModeDisabled does its own explicit save-if-dirty first.
                if (_dirty && ServerModeEnabled) SaveToDisk();
            }, null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _debounceSaveTimer, timer);
            if (old != null && !ReferenceEquals(old, timer))
            {
                old.Dispose();
            }

            // Same check-then-create/Dispose race guard as ArmFlushTimer: reclaim a timer
            // published concurrently with Dispose so none is left live after teardown, and
            // persist now since that reclaimed timer will never fire the save.
            if (_disposed)
            {
                var orphan = Interlocked.Exchange(ref _debounceSaveTimer, null);
                orphan?.Dispose();
                if (ServerModeEnabled) SaveToDisk();
            }
        }

        public void Dispose()
        {
            // Mark disposed first so any concurrent flush re-arm / late library event is a no-op
            // (ArmFlushTimer and ScheduleDebouncedSave both bail on _disposed) instead of
            // resurrecting a timer after teardown.
            _disposed = true;

            if (ReferenceEquals(Instance, this))
            {
                Instance = null;
            }

            var flush = Interlocked.Exchange(ref _flushTimer, null);
            flush?.Dispose(); // stops future callbacks; an in-flight one may still be applying

            // Take ownership of the flush guard before persisting. Timer.Dispose() does not wait
            // for a running callback, so without this Dispose could drain an already-emptied
            // _pending, skip the save, and lose the in-flight flush's applied batch (it only
            // schedules a debounced save that never fires during shutdown). Waiting for _flushing
            // to release means that flush has finished and set _dirty, so the save below catches it.
            var acquired = false;
            for (var i = 0; i < 500; i++) // ~5s cap, well under the shutdown grace period
            {
                if (Interlocked.CompareExchange(ref _flushing, 1, 0) == 0)
                {
                    acquired = true;
                    break;
                }

                Thread.Sleep(10);
            }

            // Apply anything still queued in the debounce window so a change made moments before
            // shutdown is persisted — matching the old synchronous handler, which applied to the
            // cache inline and let the trailing SaveToDisk() flush it. Without this, queued-but-
            // unflushed changes (and the fact that startup only rebuilds when the cache is empty)
            // would leave those items stale until the next event or the daily rebuild.
            try
            {
                // Only when the cache is actually in service: while the setting is
                // off (or the cache is an unpublished placeholder) the entries
                // would be applied into a dictionary whose save is refused anyway
                // — guaranteed-discarded per-item probe work that can only delay
                // shutdown. The dropped ids are re-covered by the next full build
                // or timestamp reconcile.
                if (ServerModeEnabled && !_cacheReleased)
                {
                    if (ApplyBatch(_pending.Drain(), RebuildEntry, RemoveEntry))
                    {
                        Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                        _dirty = true;
                    }
                }
                else
                {
                    _pending.Drain();
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to flush pending changes on dispose: {ex.Message}");
            }
            finally
            {
                if (acquired) Interlocked.Exchange(ref _flushing, 0);
            }

            var timer = Interlocked.Exchange(ref _debounceSaveTimer, null);
            timer?.Dispose();
            if (_dirty && ServerModeEnabled) SaveToDisk();
        }

        /// <summary>
        /// Build a TagCacheEntry for a single library item.
        /// For Series/Season, resolves first-episode data server-side.
        /// </summary>
        private TagCacheEntry? BuildEntryForItem(BaseItem item)
        {
            try
            {
                var kind = item.GetBaseItemKind();
                var isContainer = kind == BaseItemKind.Series || kind == BaseItemKind.Season;

                // Capture parent series ID for Episodes/Seasons so the Spoiler
                // Guard filter can strip unwatched-episode entries without a
                // library lookup per entry on every GetTagCache request.
                string? seriesIdN = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode tcEp)
                {
                    if (tcEp.SeriesId != Guid.Empty) seriesIdN = tcEp.SeriesId.ToString("N");
                }
                else if (item is MediaBrowser.Controller.Entities.TV.Season tcSeason)
                {
                    if (tcSeason.SeriesId != Guid.Empty) seriesIdN = tcSeason.SeriesId.ToString("N");
                }

                var entry = new TagCacheEntry
                {
                    Type = kind.ToString(),
                    TmdbId = item.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true ? tmdbId : null,
                    Genres = item.Genres,
                    CommunityRating = item.CommunityRating,
                    CriticRating = item.CriticRating,
                    LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    SeriesId = seriesIdN,
                };

                if (isContainer)
                {
                    var firstEp = GetFirstEpisode(item);
                    if (firstEp != null)
                    {
                        if (entry.Genres == null || entry.Genres.Length == 0)
                        {
                            entry.Genres = firstEp.Genres;
                        }

                        var (streams, sources, languages) = ExtractMediaData(firstEp);
                        entry.StreamData = new TagStreamData
                        {
                            Streams = streams,
                            Sources = sources,
                            ItemName = firstEp.Name,
                            ItemPath = string.IsNullOrEmpty(firstEp.Path) ? null : Path.GetFileName(firstEp.Path)
                        };
                        entry.AudioLanguages = languages;
                    }

                    if (kind == BaseItemKind.Season && entry.CommunityRating == null)
                    {
                        var series = GetParentSeries(item);
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                            if (entry.Genres == null || entry.Genres.Length == 0)
                            {
                                entry.Genres = series.Genres;
                            }
                        }
                    }

                    // For Season: store parent series TMDB ID + season number for user review key
                    if (kind == BaseItemKind.Season && item is MediaBrowser.Controller.Entities.TV.Season season)
                    {
                        var series = GetParentSeries(item);
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = season.IndexNumber;
                    }
                }
                else
                {
                    var (streams, sources, languages) = ExtractMediaData(item);
                    entry.StreamData = new TagStreamData
                    {
                        Streams = streams,
                        Sources = sources,
                        ItemName = item.Name,
                        ItemPath = string.IsNullOrEmpty(item.Path) ? null : Path.GetFileName(item.Path)
                    };
                    entry.AudioLanguages = languages;

                    if (kind == BaseItemKind.Episode && entry.CommunityRating == null)
                    {
                        var series = GetParentSeries(item);
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                        }
                    }

                    // For Episode: store parent series TMDB ID + season/episode numbers for user review key
                    if (kind == BaseItemKind.Episode && item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    {
                        var series = GetParentSeries(item);
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = ep.ParentIndexNumber;
                        entry.EpisodeNumber = ep.IndexNumber;
                    }
                }

                return entry;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to build entry for {item.Id}: {ex.Message}");
                return null;
            }
        }

        private (List<TagMediaStream>, List<TagMediaSource>, string[]) ExtractMediaData(BaseItem item)
        {
            var streams = new List<TagMediaStream>();
            var sources = new List<TagMediaSource>();
            var languages = new HashSet<string>();

            try
            {
                var mediaSources = item.GetMediaSources(false);
                foreach (var source in mediaSources)
                {
                    sources.Add(new TagMediaSource
                    {
                        Path = string.IsNullOrEmpty(source.Path) ? null : Path.GetFileName(source.Path),
                        Name = source.Name
                    });

                    if (source.MediaStreams == null) continue;
                    foreach (var s in source.MediaStreams)
                    {
                        if (s.Type != MediaStreamType.Video && s.Type != MediaStreamType.Audio)
                            continue;

                        streams.Add(new TagMediaStream
                        {
                            Type = s.Type.ToString(),
                            Language = s.Language,
                            Codec = s.Codec,
                            CodecTag = s.CodecTag,
                            Profile = s.Profile,
                            Height = s.Height,
                            Channels = s.Channels,
                            ChannelLayout = s.ChannelLayout,
                            VideoRangeType = s.VideoRangeType.ToString(),
                            DisplayTitle = s.DisplayTitle
                        });

                        if (s.Type == MediaStreamType.Audio && !string.IsNullOrEmpty(s.Language))
                        {
                            var lang = s.Language.ToLowerInvariant();
                            if (lang != "und" && lang != "root")
                            {
                                languages.Add(lang);
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to extract media data for {item.Id}: {ex.Message}");
            }

            return (streams, sources, languages.ToArray());
        }

        /// <summary>
        /// Hydrate library items for the given ids in fixed-size pages
        /// (<see cref="HydrationPageSize"/>). Only one page of full BaseItems is
        /// referenced at a time, which keeps full builds and reconciliation
        /// memory-bounded on arbitrarily large libraries. An id that no longer
        /// resolves (deleted between the id query and its page) is simply absent
        /// from the returned page.
        /// </summary>
        private IEnumerable<IReadOnlyList<BaseItem>> HydrateInPages(IReadOnlyList<Guid> ids, CancellationToken cancellationToken)
        {
            for (var offset = 0; offset < ids.Count; offset += HydrationPageSize)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var count = Math.Min(HydrationPageSize, ids.Count - offset);
                var pageIds = new Guid[count];
                for (var i = 0; i < count; i++)
                {
                    pageIds[i] = ids[offset + i];
                }

                yield return _libraryManager.GetItemList(new InternalItemsQuery { ItemIds = pageIds });
            }
        }

        private BaseItem? GetFirstEpisode(BaseItem container)
        {
            try
            {
                var epQuery = new InternalItemsQuery
                {
                    ParentId = container.Id,
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    Limit = 1,
                    OrderBy = new[] { (ItemSortBy.PremiereDate, JSortOrder.Ascending) }
                };
                return _libraryManager.GetItemList(epQuery).FirstOrDefault();
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to get first episode for {container.Id}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// All Season items of a series, for the reconcile sweep's parent repair.
        /// Query failures propagate — the caller logs them and requeues what it
        /// can, so swallowing here would silently disable that retry path.
        /// </summary>
        private IReadOnlyList<BaseItem> GetSeasonsOfSeries(Guid seriesId)
        {
            // IsVirtualItem must match the build/sweep queries: including a
            // virtual season here would add an entry the next sweep's live-id
            // set (virtual-excluded) doesn't contain, so it would be removed,
            // trigger this repair again, and churn the cache version forever.
            return _libraryManager.GetItemList(new InternalItemsQuery
            {
                ParentId = seriesId,
                IncludeItemTypes = new[] { BaseItemKind.Season },
                IsVirtualItem = false,
                Recursive = true
            });
        }

        private BaseItem? GetParentSeries(BaseItem item)
        {
            try
            {
                Guid? seriesId = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    seriesId = ep.SeriesId;
                else if (item is MediaBrowser.Controller.Entities.TV.Season season)
                    seriesId = season.SeriesId;

                if (seriesId.HasValue && seriesId.Value != Guid.Empty)
                {
                    return _libraryManager.GetItemById<BaseItem>(seriesId.Value);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to get parent series for {item.Id}: {ex.Message}");
            }
            return null;
        }

        private class TagCacheDiskFormat
        {
            // On-disk entry schema. Absent (0) in caches written before this
            // field existed, so they read as != CurrentCacheSchemaVersion and
            // are discarded + rebuilt. Distinct from Version (content revision).
            public int SchemaVersion { get; set; }
            public long Version { get; set; }
            public long LastModified { get; set; }
            public long LastReconciledUtcTicks { get; set; }
            public Dictionary<string, TagCacheEntry> Items { get; set; } = new();
        }
    }
}
