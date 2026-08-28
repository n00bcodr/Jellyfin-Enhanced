using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Holds the current reporting period's feature-usage counters in memory
    /// (one int per feature_key, e.g. "rating.half_star_used"), persisted to
    /// usage-counters.json with the same debounced atomic-write pattern as
    /// WikidataAwardsService/TagCacheService.
    ///
    /// Counters are cumulative SNAPSHOTS for the current period, not deltas.
    /// AnalyticsReportingService sends the full current value each cycle, and
    /// the backend merges with GREATEST, so a retried/duplicate send can never
    /// double-count. Counters only reset (to start a new period) after a
    /// successful report, see ResetForNewPeriod.
    /// </summary>
    public class UsageEventCounterService : IDisposable
    {
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan SaveMaxWait = TimeSpan.FromMinutes(2);
        private const int CurrentSchemaVersion = 1;

        private readonly IApplicationPaths _applicationPaths;
        private readonly Logger _logger;

        private readonly ConcurrentDictionary<string, int> _counters = new();
        private readonly object _saveLock = new();
        private string _periodStart;
        private volatile bool _dirty;
        private long _firstDirtyTicks;
        private Timer? _debounceSaveTimer;
        private volatile bool _disposed;

        public UsageEventCounterService(IApplicationPaths applicationPaths, Logger logger)
        {
            _applicationPaths = applicationPaths;
            _logger = logger;
            _periodStart = DateTime.UtcNow.ToString("yyyy-MM-dd");
            LoadFromDisk();
        }

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "usage-counters.json");

        /// <summary>Only letters/digits/dot/underscore, so a stray client can't spam arbitrary feature_key rows.</summary>
        public static bool IsValidKey(string key) =>
            !string.IsNullOrEmpty(key) && key.Length <= 64 &&
            System.Text.RegularExpressions.Regex.IsMatch(key, @"^[a-z0-9_.]+$");

        public void Increment(string key)
        {
            if (!IsValidKey(key)) return;
            _counters.AddOrUpdate(key, 1, (_, v) => v + 1);
            ScheduleDebouncedSave();
        }

        /// <summary>Current period start (yyyy-MM-dd) and a point-in-time snapshot of every counter.</summary>
        public (string PeriodStart, Dictionary<string, int> Counters) GetSnapshot() =>
            (_periodStart, new Dictionary<string, int>(_counters));

        /// <summary>
        /// Called after a successful report send: clears every counter and starts
        /// a fresh period. Saved immediately (not debounced) since this only runs
        /// once per reporting cycle at most.
        /// </summary>
        public void ResetForNewPeriod(string newPeriodStart)
        {
            _counters.Clear();
            _periodStart = newPeriodStart;
            SaveToDisk();
        }

        private void LoadFromDisk()
        {
            var path = CacheFilePath;
            if (!File.Exists(path)) return;

            try
            {
                using var stream = File.OpenRead(path);
                var data = JsonSerializer.Deserialize<UsageCounterDiskFormat>(stream);
                if (data == null || data.SchemaVersion != CurrentSchemaVersion) return;

                if (!string.IsNullOrEmpty(data.PeriodStart)) _periodStart = data.PeriodStart;
                foreach (var kvp in data.Counters) _counters[kvp.Key] = kvp.Value;
                _logger.Info($"[Analytics] Loaded {_counters.Count} usage counter(s) for period {_periodStart}");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Analytics] Failed to load usage counters from disk: {ex.Message}");
            }
        }

        private void SaveToDisk()
        {
            lock (_saveLock)
            {
                _dirty = false;
                Interlocked.Exchange(ref _firstDirtyTicks, 0);

                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    var data = new UsageCounterDiskFormat
                    {
                        SchemaVersion = CurrentSchemaVersion,
                        PeriodStart = _periodStart,
                        Counters = new Dictionary<string, int>(_counters),
                    };

                    var tempPath = CacheFilePath + ".tmp";
                    using (var stream = File.Create(tempPath))
                    {
                        JsonSerializer.Serialize(stream, data, new JsonSerializerOptions { WriteIndented = false });
                    }
                    File.Move(tempPath, CacheFilePath, overwrite: true);
                }
                catch (Exception ex)
                {
                    _dirty = true;
                    _logger.Error($"[Analytics] Failed to save usage counters to disk: {ex.Message}");
                }
            }
        }

        private void ScheduleDebouncedSave()
        {
            _dirty = true;
            Interlocked.CompareExchange(ref _firstDirtyTicks, DateTime.UtcNow.Ticks, 0);

            if (_disposed)
            {
                SaveToDisk();
                return;
            }

            var due = ComputeDelay(Interlocked.Read(ref _firstDirtyTicks));
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
            if (old != null && !ReferenceEquals(old, timer)) old.Dispose();

            if (_disposed)
            {
                var orphan = Interlocked.Exchange(ref _debounceSaveTimer, null);
                orphan?.Dispose();
                SaveToDisk();
            }
        }

        private static TimeSpan ComputeDelay(long firstDirtyTicks)
        {
            if (firstDirtyTicks == 0) return SaveDebounce;
            var elapsed = DateTime.UtcNow - new DateTime(firstDirtyTicks, DateTimeKind.Utc);
            var remainingCap = SaveMaxWait - elapsed;
            if (remainingCap < TimeSpan.Zero) return TimeSpan.Zero;
            return remainingCap < SaveDebounce ? remainingCap : SaveDebounce;
        }

        public void Dispose()
        {
            _disposed = true;
            var timer = Interlocked.Exchange(ref _debounceSaveTimer, null);
            timer?.Dispose();
            if (_dirty) SaveToDisk();
        }
    }
}
