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
        }

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

            var allItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                IsVirtualItem = false,
                Recursive = true
            }).ToList();

            _logger.Info($"[TagCache] Found {allItems.Count} taggable items");

            var newCache = new ConcurrentDictionary<string, TagCacheEntry>();
            var processed = 0;

            foreach (var item in allItems)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var entry = BuildEntryForItem(item);
                if (entry != null)
                {
                    var key = item.Id.ToString("N").ToLowerInvariant();
                    newCache[key] = entry;
                }

                processed++;
                if (processed % 500 == 0)
                {
                    progress?.Report((double)processed / allItems.Count * 100);
                }
            }

            // Atomic reference swap — readers see old or new cache, never partial
            _cache = newCache;
            Interlocked.Increment(ref _version);
            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
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

            if (_cache.IsEmpty)
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

            var changedItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                IsVirtualItem = false,
                Recursive = true,
                MinDateLastSaved = changedSinceUtc
            }).ToList();

            var idsToRebuild = new HashSet<Guid>();
            foreach (var item in changedItems)
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

            var changed = false;
            var processed = 0;
            foreach (var id in idsToRebuild)
            {
                cancellationToken.ThrowIfCancellationRequested();

                changed |= RebuildEntry(id);
                processed++;
                progress?.Report(idsToRebuild.Count == 0 ? 50 : (double)processed / idsToRebuild.Count * 80);
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

            foreach (var cachedKey in _cache.Keys)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (!liveKeys.Contains(cachedKey) && _cache.TryRemove(cachedKey, out _))
                {
                    changed = true;
                }
            }

            if (changed)
            {
                Interlocked.Increment(ref _version);
                Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                _userAccessCache.Clear();
            }

            Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciliationStartedUtc.Ticks);
            progress?.Report(100);
            SaveToDisk();

            _logger.Info($"[TagCache] Reconciliation complete: {changedItems.Count} changed items, {idsToRebuild.Count} entries checked");
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

            try
            {
                Interlocked.Exchange(ref _firstPendingTicks, 0);
                if (ApplyBatch(_pending.Drain(), RebuildEntry, RemoveEntry))
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    ScheduleDebouncedSave();
                }
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
                // Ids recorded while we were draining/applying: run again (cap-aware).
                if (!_pending.IsEmpty) ScheduleFlush();
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
        /// Get cache entries filtered by a user's library access.
        /// User access IDs are cached for 60 seconds to avoid expensive DB queries.
        /// Optionally returns only entries modified after a given timestamp.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetCacheForUser(JUser user, long? since = null)
        {
            // Capture local reference for thread safety (cache reference may be swapped)
            var cache = _cache;
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
                _userAccessCache[userKey] = (accessibleSet, DateTime.UtcNow);
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
        /// Load the cache from disk on startup.
        /// </summary>
        public void LoadFromDisk()
        {
            var path = CacheFilePath;
            if (!File.Exists(path))
            {
                _logger.Info("[TagCache] No cache file found, starting empty");
                return;
            }

            try
            {
                var json = File.ReadAllText(path);
                var data = JsonSerializer.Deserialize<TagCacheDiskFormat>(json);
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
                    var loaded = new ConcurrentDictionary<string, TagCacheEntry>(data.Items);
                    _cache = loaded;
                    Interlocked.Exchange(ref _version, data.Version);
                    Interlocked.Exchange(ref _lastModified, data.LastModified);
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

                    var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = false });
                    var tempPath = CacheFilePath + ".tmp";
                    File.WriteAllText(tempPath, json);
                    File.Move(tempPath, CacheFilePath, overwrite: true);

                    _logger.Info($"[TagCache] Saved {_cache.Count} entries to disk");
                }
                catch (Exception ex)
                {
                    // Failed write: restore the dirty state so Dispose's final
                    // `if (_dirty) SaveToDisk()` and the next debounce cycle retry it.
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
                SaveToDisk();
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
                if (_dirty) SaveToDisk();
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
                SaveToDisk();
            }
        }

        public void Dispose()
        {
            // Mark disposed first so any concurrent flush re-arm / late library event is a no-op
            // (ArmFlushTimer and ScheduleDebouncedSave both bail on _disposed) instead of
            // resurrecting a timer after teardown.
            _disposed = true;

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
                if (ApplyBatch(_pending.Drain(), RebuildEntry, RemoveEntry))
                {
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    _dirty = true;
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
            if (_dirty) SaveToDisk();
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
