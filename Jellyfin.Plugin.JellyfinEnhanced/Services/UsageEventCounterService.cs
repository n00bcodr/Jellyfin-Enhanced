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
    /// (one int per feature_key, e.g. "seerr.request_submitted"), persisted to
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
            // InvariantCulture is load-bearing: the host culture can render a
            // non-Gregorian year (e.g. Thai Buddhist "2569-08-30"), which the
            // dashboard's future-period filter would then drop as forged.
            _periodStart = DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            LoadFromDisk();
        }

        private string CacheFilePath =>
            Path.Join(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "usage-counters.json");

        /// <summary>Only letters/digits/dot/underscore, so a stray client can't spam arbitrary feature_key rows.</summary>
        public static bool IsValidKey(string key) =>
            !string.IsNullOrEmpty(key) && key.Length <= 64 &&
            System.Text.RegularExpressions.Regex.IsMatch(key, @"^[a-z0-9_.]+$");

        /// <summary>
        /// The finite set of per-period action counters the plugin actually
        /// emits (client-side via /usage/track, server-side from event
        /// handlers). The track endpoint rejects anything not listed here, so
        /// an arbitrary authenticated client can't mint unbounded distinct
        /// counter rows (unbounded memory/disk/payload growth), forge
        /// "total.*" snapshot keys next to the real ones, or place invented
        /// key text on the public dashboard. Add a key here in the same change
        /// that starts emitting it.
        /// </summary>
        private static readonly HashSet<string> KnownKeys = new(StringComparer.Ordinal)
        {
            "seerr.request_submitted",
            "continue_watching.auto_removed",
        };

        public static bool IsKnownKey(string key) => KnownKeys.Contains(key);

        public void Increment(string key)
        {
            // The consent gate lives here, not only in the HTTP endpoint, so
            // server-side callers (event handlers) can't accumulate
            // pre-opt-in data either: with analytics or the usage-counts
            // category off, nothing is counted or written to disk at all.
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AnalyticsEnabled || !config.AnalyticsShareUsageCounts) return;
            if (!IsValidKey(key)) return;
            _counters.AddOrUpdate(key, 1, (_, v) => v + 1);
            ScheduleDebouncedSave();
        }

        /// <summary>Current period start (yyyy-MM-dd) and a point-in-time snapshot of every counter.</summary>
        public (string PeriodStart, Dictionary<string, int> Counters) GetSnapshot() =>
            (_periodStart, new Dictionary<string, int>(_counters));

        /// <summary>
        /// Starts a fresh period. With a snapshot of what was just sent, only
        /// the sent amounts are subtracted, so increments that landed between
        /// the payload snapshot and the send completing carry into the new
        /// period instead of being silently dropped. With no snapshot (the
        /// opt-in consent boundary), every counter is cleared outright. Saved
        /// immediately (not debounced) since this runs at most once per
        /// reporting cycle.
        /// </summary>
        public void ResetForNewPeriod(string newPeriodStart, IReadOnlyDictionary<string, int>? sentCounters = null)
        {
            if (sentCounters == null)
            {
                _counters.Clear();
            }
            else
            {
                foreach (var kvp in sentCounters)
                {
                    // Math.Max(0, ...): if a consent-boundary Clear interleaved
                    // with an in-flight send, subtracting the sent snapshot
                    // could otherwise go negative — and a negative count must
                    // never persist or ship in a payload.
                    var remaining = _counters.AddOrUpdate(kvp.Key, 0, (_, v) => Math.Max(0, v - kvp.Value));
                    if (remaining <= 0)
                    {
                        // Pair-remove is atomic on (key, value): a concurrent
                        // Increment between the update above and this remove
                        // changes the value and the remove correctly no-ops.
                        ((ICollection<KeyValuePair<string, int>>)_counters)
                            .Remove(new KeyValuePair<string, int>(kvp.Key, remaining));
                    }
                }
            }

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

                // Filter loaded keys through the same allowlist Increment
                // enforces: a file written by a pre-allowlist build can carry
                // keys any authenticated user minted through the then-open
                // track endpoint — including forged "total.*" snapshot keys
                // that would ship next to (and GREATEST-merge over) the real
                // totals. Also drop non-positive counts defensively.
                var dropped = 0;
                foreach (var kvp in data.Counters)
                {
                    if (!IsValidKey(kvp.Key) || !IsKnownKey(kvp.Key) || kvp.Value <= 0) { dropped++; continue; }
                    _counters[kvp.Key] = kvp.Value;
                }
                if (dropped > 0)
                {
                    _logger.Warning($"[Analytics] Dropped {dropped} unknown/invalid persisted usage counter(s) from a previous build.");
                }
                _logger.Info($"[Analytics] Loaded {_counters.Count} usage counter(s) for period {_periodStart}");
            }
            catch (IOException ex)
            {
                _logger.Warning($"[Analytics] Failed to load usage counters from disk: {ex.Message}");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Warning($"[Analytics] Failed to load usage counters from disk: {ex.Message}");
            }
            catch (JsonException ex)
            {
                _logger.Warning($"[Analytics] Failed to load usage counters from disk: corrupt file ({ex.Message})");
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
                catch (IOException ex)
                {
                    _dirty = true;
                    _logger.Error($"[Analytics] Failed to save usage counters to disk: {ex.Message}");
                }
                catch (UnauthorizedAccessException ex)
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
