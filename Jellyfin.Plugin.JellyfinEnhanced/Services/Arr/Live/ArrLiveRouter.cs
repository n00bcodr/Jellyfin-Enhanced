using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>Snapshots a live hint asks to re-read.</summary>
    [Flags]
    public enum ArrLiveKinds
    {
        /// <summary>Nothing.</summary>
        None = 0,
        /// <summary>The download queue.</summary>
        Queue = 1,
        /// <summary>Recent history (history/since).</summary>
        History = 2,
        /// <summary>The whole library index.</summary>
        Library = 4,
        /// <summary>The calendar window.</summary>
        Calendar = 8,
        /// <summary>Health, disk, root folders, profiles.</summary>
        System = 16,
    }

    /// <summary>The feature switches live updates follow.</summary>
    public static class ArrLiveFlags
    {
        /// <summary>
        /// True when "Requests &amp; downloads (new)" and its phase 1 (status and live updates) are both on.
        /// </summary>
        public static bool Enabled(PluginConfiguration? config)
            => config != null && config.ArrIntegrationEnabled && config.ArrPhase1Enabled;
    }

    /// <summary>
    /// Turns live hints (SignalR messages, webhook events, reconnects, history events) into
    /// re-reads of the arr: snapshot refreshes and single-title re-reads. Hints for one instance
    /// are coalesced for <see cref="CoalesceDelay"/>, so a burst (a season pack's dozen events, a
    /// replayed webhook) costs one refresh per snapshot. Pending work per instance is bounded (too
    /// many titles become one library refresh), and single titles are re-read by one reader per
    /// instance at a time. A hint is never data: the arr is read again. Work still waiting when
    /// live updates are switched off is dropped, not run.
    /// </summary>
    public sealed class ArrLiveRouter
    {
        /// <summary>How long hints for one instance are gathered before the re-reads start.</summary>
        public static readonly TimeSpan CoalesceDelay = TimeSpan.FromMilliseconds(250);

        private const int MaxPendingTitles = 200;

        private readonly ArrStateStore _store;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly ConcurrentDictionary<string, Pending> _pending = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, Counters> _counters = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Creates the router.</summary>
        public ArrLiveRouter(ArrStateStore store, Logger logger)
            : this(store, (Logger?)logger, null)
        {
        }

        /// <summary>Creates the router with an explicit delay and configuration (tests).</summary>
        internal ArrLiveRouter(ArrStateStore store, Logger? logger, TimeSpan? delay, Func<PluginConfiguration?>? config = null)
        {
            _store = store;
            _logger = logger;
            Delay = delay ?? CoalesceDelay;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <summary>The coalescing delay in use.</summary>
        internal TimeSpan Delay { get; }

        /// <summary>The store the router refreshes.</summary>
        public ArrStateStore Store => _store;

        /// <summary>
        /// Asks for re-reads of <paramref name="kinds"/> and of single titles (arr ids) of one
        /// instance. <paramref name="force"/> refreshes even snapshots that are backing off (the arr
        /// just proved it is reachable). Returns at once; the work runs in the background.
        /// </summary>
        public void Hint(string instanceId, ArrLiveKinds kinds, IEnumerable<int>? titleIds = null, bool force = false)
        {
            if (string.IsNullOrWhiteSpace(instanceId)) return;
            var pending = _pending.GetOrAdd(instanceId, _ => new Pending());
            var counters = _counters.GetOrAdd(instanceId, _ => new Counters());
            Interlocked.Increment(ref counters.Hints);
            bool schedule;
            lock (pending)
            {
                pending.Kinds |= kinds;
                pending.Force |= force;
                foreach (var id in titleIds ?? Enumerable.Empty<int>())
                {
                    if (id <= 0) continue;
                    if (pending.Titles.Count >= MaxPendingTitles)
                    {
                        pending.Titles.Clear();
                        pending.Kinds |= ArrLiveKinds.Library;
                        break;
                    }
                    pending.Titles.Add(id);
                }
                schedule = !pending.Scheduled;
                pending.Scheduled = true;
            }
            if (!schedule) return;
            using (ExecutionContext.SuppressFlow())
            {
                _ = Task.Run(() => FlushLaterAsync(instanceId, pending));
            }
        }

        /// <summary>Hints and flushes per instance (diagnostics).</summary>
        public (long Hints, long Flushes) Stats(string instanceId)
            => _counters.TryGetValue(instanceId, out var c) ? (Interlocked.Read(ref c.Hints), Interlocked.Read(ref c.Flushes)) : (0, 0);

        private async Task FlushLaterAsync(string instanceId, Pending pending)
        {
            try
            {
                await Task.Delay(Delay).ConfigureAwait(false);
                ArrLiveKinds kinds;
                List<int>? titles = null;
                bool force;
                lock (pending)
                {
                    kinds = pending.Kinds;
                    force = pending.Force;
                    pending.Kinds = ArrLiveKinds.None;
                    pending.Force = false;
                    pending.Scheduled = false;
                    // Switched off while the hints gathered: nothing is read for them.
                    if (!ArrLiveFlags.Enabled(_config()))
                    {
                        if (!pending.TitlesRunning) pending.Titles.Clear();
                        return;
                    }
                    // A library refresh covers the titles; otherwise they go to the instance's one
                    // title reader (started here if it isn't running; a running one takes them next).
                    if (kinds.HasFlag(ArrLiveKinds.Library)) pending.Titles.Clear();
                    else if (pending.Titles.Count > 0 && !pending.TitlesRunning)
                    {
                        titles = pending.Titles.ToList();
                        pending.Titles.Clear();
                        pending.TitlesRunning = true;
                    }
                }
                if (titles != null)
                {
                    using (ExecutionContext.SuppressFlow())
                    {
                        _ = Task.Run(() => DrainTitlesAsync(instanceId, pending, titles));
                    }
                }
                Interlocked.Increment(ref _counters.GetOrAdd(instanceId, _ => new Counters()).Flushes);

                // Snapshot refreshes are single-flight in the store (a hint during one runs one more after it).
                var work = new List<Task>();
                foreach (var (flag, kind) in Map)
                {
                    if (kinds.HasFlag(flag)) work.Add(_store.RefreshForEventAsync(instanceId, kind, force));
                }
                await Task.WhenAll(work).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Arr live: re-reading after a live event failed ({ex.GetType().Name}).");
            }
        }

        /// <summary>
        /// The one title reader of an instance: re-reads the titles waiting in <paramref name="pending"/>
        /// batch after batch until none are left, so batches never pile up or overlap.
        /// </summary>
        private async Task DrainTitlesAsync(string instanceId, Pending pending, List<int> batch)
        {
            while (true)
            {
                if (!ArrLiveFlags.Enabled(_config()))
                {
                    lock (pending)
                    {
                        pending.Titles.Clear();
                        pending.TitlesRunning = false;
                    }
                    return;
                }
                try
                {
                    await _store.RefreshTitlesAsync(instanceId, batch, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Arr live: re-reading titles after a live event failed ({ex.GetType().Name}).");
                }
                lock (pending)
                {
                    if (pending.Titles.Count == 0)
                    {
                        pending.TitlesRunning = false;
                        return;
                    }
                    batch = pending.Titles.ToList();
                    pending.Titles.Clear();
                }
            }
        }

        private static readonly (ArrLiveKinds Flag, ArrSnapshotKind Kind)[] Map =
        {
            (ArrLiveKinds.Queue, ArrSnapshotKind.Queue),
            (ArrLiveKinds.History, ArrSnapshotKind.History),
            (ArrLiveKinds.Library, ArrSnapshotKind.Library),
            (ArrLiveKinds.Calendar, ArrSnapshotKind.Calendar),
            (ArrLiveKinds.System, ArrSnapshotKind.System),
        };

        private sealed class Pending
        {
            public ArrLiveKinds Kinds;
            public bool Force;
            public bool Scheduled;
            public bool TitlesRunning;
            public HashSet<int> Titles { get; } = new();
        }

        private sealed class Counters
        {
            public long Hints;
            public long Flushes;
        }
    }
}
