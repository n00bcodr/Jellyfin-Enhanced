using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// In-memory snapshots of every Sonarr/Radarr instance (library index with provider ids,
    /// queue, recent history, calendar window, system facts), kept current by
    /// <see cref="ArrStateReconciler"/> and served to the Downloads, Calendar and link routes
    /// without calling the arrs per request.
    /// <list type="bullet">
    /// <item><description>Lazy: nothing is read until a route asks; a snapshot nobody has read for a
    /// while stops being refreshed (see the per-kind policy).</description></item>
    /// <item><description>Reads return the in-memory value. A value past its freshness target is
    /// still served while a background refresh runs; only a missing (cold) or very old value
    /// makes the caller wait, for a bounded time.</description></item>
    /// <item><description>Refreshes are single-flight per snapshot, back off after failures, and run
    /// outside the request's flow, so <see cref="ArrRequestScope"/> can prove a request made no
    /// upstream call.</description></item>
    /// <item><description>Bounded (spike S4): slim projections only; history is a ring; queue messages
    /// are capped; calendar ranges outside the window use a small LRU.</description></item>
    /// <item><description>The library index is warm-started from a slim cache file after a restart.</description></item>
    /// </list>
    /// </summary>
    public sealed partial class ArrStateStore : IDisposable
    {
        /// <summary>Folder (inside the JE data folder) for the warm-start cache files.</summary>
        public const string CacheFolderName = "arr-state";

        private const int RangeCacheSize = 8;
        private const int EpisodeSeriesPerInstance = 64;
        private const int CacheFileVersion = 2;
        private static readonly TimeSpan DepartureMemory = TimeSpan.FromMinutes(10);

        /// <summary>
        /// How old a complete queue read may be and still be kept over a read during which rows moved
        /// between pages (<see cref="ArrQueueSnapshot.Incomplete"/>). Past it, the incomplete read is
        /// shown (its rows are live) rather than progress frozen for long.
        /// </summary>
        internal static readonly TimeSpan QueueKeepHeld = TimeSpan.FromMinutes(2);

        private static readonly TimeSpan QueueMaxServe = TimeSpan.FromMinutes(10);

        // Rows the departure baseline may hold across partial queue reads before it starts over.
        private const int QueueBaselineMax = 2 * ArrStateLoaders.QueueMaxRecords;
        private const int RangeLoadsPerInstance = 2;
        private static readonly TimeSpan RangeTtl = TimeSpan.FromMinutes(15);
        private static readonly TimeSpan RangeFailureRetry = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan CacheWriteInterval = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan DebounceDelay = TimeSpan.FromSeconds(2);
        private static readonly JsonSerializerOptions CacheJson = new() { PropertyNameCaseInsensitive = true };

        private readonly ArrClientFactory _factory;
        private readonly Logger? _logger;
        private readonly string? _cacheDirectory;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<PluginConfiguration?> _config;
        private readonly ConcurrentDictionary<string, InstanceState> _states = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, ArrRouteStats> _routes = new(StringComparer.Ordinal);
        private readonly CancellationTokenSource _shutdown = new();
        private readonly ArrCallCounter _backgroundCalls = new();
        private readonly CancellationToken _shutdownToken;
        private readonly object _backgroundGate = new();
        private readonly Dictionary<Task, Task> _backgroundTasks = new();
        private Task? _stopped;
        private int _stopWaitExpired;

        /// <summary>The store for a Jellyfin installation (DI).</summary>
        public ArrStateStore(ArrClientFactory factory, IApplicationPaths paths, Logger logger)
            : this(factory, Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", CacheFolderName), logger, null, null)
        {
        }

        /// <summary>A store with explicit dependencies (tests). A null cache directory disables the warm start.</summary>
        internal ArrStateStore(ArrClientFactory factory, string? cacheDirectory, Logger? logger, Func<DateTimeOffset>? now, Func<PluginConfiguration?>? config)
        {
            _factory = factory;
            _shutdownToken = _shutdown.Token;
            _cacheDirectory = cacheDirectory;
            _logger = logger;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <summary>How long a request waits for a calendar range outside the window (the read keeps running after that). Tests shorten it.</summary>
        internal TimeSpan RangeWait { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>Maximum synchronous disposal wait; tests shorten it when holding a writer.</summary>
        internal TimeSpan DisposeWait { get; set; } = TimeSpan.FromSeconds(5);

        /// <summary>The instance registry the store follows.</summary>
        public ArrInstanceRegistry Registry => _factory.Registry;

        /// <summary>Upstream calls made by background refreshes (not by user requests).</summary>
        public long BackgroundCalls => _backgroundCalls.Calls;

        /// <summary>
        /// Enabled, non-retired instances of a kind that have an API key, in configured order (rows
        /// without a key are left out, as the instance list always did).
        /// </summary>
        public IReadOnlyList<ArrConnection> Instances(ArrKind kind)
            => _factory.Registry.Usable(kind).Where(c => !string.IsNullOrEmpty(_factory.Registry.ResolveApiKey(c))).ToList();

        /// <summary>
        /// Starts counting the upstream calls made while serving one request of <paramref name="route"/>;
        /// dispose at the end of the request to record them.
        /// </summary>
        public ArrRequestScope BeginRequest(string route) => new(this, route);

        /// <summary>The library index (movies or series with provider ids, tags).</summary>
        public Task<ArrSnapshotRead<ArrLibrarySnapshot>> GetLibraryAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.Library, false, cancellationToken);

        /// <summary>The whole download queue.</summary>
        public Task<ArrSnapshotRead<ArrQueueSnapshot>> GetQueueAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.Queue, false, cancellationToken);

        /// <summary>Recent history (newest first).</summary>
        public Task<ArrSnapshotRead<ArrHistorySnapshot>> GetHistoryAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.History, false, cancellationToken);

        /// <summary>System status, health, disk space, root folders and quality profiles.</summary>
        public Task<ArrSnapshotRead<ArrSystemSnapshot>> GetSystemAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.System, false, cancellationToken);

        /// <summary>
        /// Starts a read of an instance's system facts when none is in memory or the one held is
        /// older than its longest serve time (an hour), and returns at once: the caller answers from
        /// what is in memory now (<see cref="PeekSystem"/>). The read doesn't count as anyone watching
        /// (the reconciler doesn't keep the snapshot fresh for it); nothing new starts while a read
        /// is running or the instance is backing off after failures. Returns the running read, or
        /// null when none is needed or the instance can't be used.
        /// </summary>
        public Task? WarmSystem(ArrConnection instance)
        {
            var state = StateFor(instance, out _);
            if (state == null) return null;
            var now = _now();
            var peek = state.System.Peek();
            if (peek.Value != null && now - peek.LoadedAt <= PolicyFor(ArrSnapshotKind.System, state, now).MaxServe) return null;
            if (state.System.InBackoff(now)) return state.System.Inflight;
            return state.System.StartRefresh(_backgroundCalls, _now, _shutdownToken);
        }

        /// <summary>
        /// The library, queue, history and system snapshots for a background reader that runs on its
        /// own clock (the administrators' alert check, every minute), not for a page: what is in
        /// memory is served as it is (up to each snapshot's longest serve time; a cold or too old one
        /// is loaded and waited for, like a page's first read). The queue, history and system stay
        /// in the reconciler's interest at their idle pace (queue and history every 5 minutes, every
        /// poll interval while downloads are active), but the read never counts as someone watching,
        /// so it doesn't hold them at the Downloads page's pace; the library is not kept warm by it
        /// at all (pages, live events and the warm start do that).
        /// </summary>
        public async Task<ArrBackgroundRead> ReadInBackgroundAsync(ArrConnection instance, CancellationToken cancellationToken)
        {
            var library = await ReadAsync(instance, s => s.Library, true, cancellationToken).ConfigureAwait(false);
            var queue = await ReadAsync(instance, s => s.Queue, true, cancellationToken).ConfigureAwait(false);
            var history = await ReadAsync(instance, s => s.History, true, cancellationToken).ConfigureAwait(false);
            var system = await ReadAsync(instance, s => s.System, true, cancellationToken).ConfigureAwait(false);
            return new ArrBackgroundRead(library, queue, history, system);
        }

        /// <summary>
        /// The episodes of one Sonarr series. Read on demand (the first read of a series waits for the
        /// background load, like any cold snapshot), kept fresh while pages read it, and refreshed soon
        /// after a download of the series leaves the queue. At most
        /// <see cref="EpisodeSeriesPerInstance"/> series are kept per instance (least recently read go first).
        /// </summary>
        public Task<ArrSnapshotRead<ArrEpisodesSnapshot>> GetEpisodesAsync(ArrConnection instance, int seriesId, CancellationToken cancellationToken)
        {
            if (instance.Kind != ArrKind.Sonarr)
                return Task.FromResult(new ArrSnapshotRead<ArrEpisodesSnapshot> { Error = new ArrError(ArrErrorKind.Internal, "Episodes are read from Sonarr only.") });
            var state = StateFor(instance, out var notUsable);
            if (state == null) return Task.FromResult(new ArrSnapshotRead<ArrEpisodesSnapshot> { Error = notUsable });
            var slot = state.EpisodesFor(seriesId, _now());
            EpisodeSlotPicked?.Invoke(seriesId);
            if (slot == null)
                return Task.FromResult(new ArrSnapshotRead<ArrEpisodesSnapshot> { Error = new ArrError(ArrErrorKind.Timeout, "Still loading other series from the instance; try again in a moment.") });
            return ReadSlotAsync(state, slot, cancellationToken);
        }

        /// <summary>Test seam: called after a read picked (or failed to pick) a series' episodes slot, before reading it.</summary>
        internal Action<int>? EpisodeSlotPicked { get; set; }

        /// <summary>Tests: called on a queue refresh's thread after it was published, before its other observers.</summary>
        internal Action<ArrConnection, ArrQueueSnapshot>? QueueRefreshedHook { get; set; }

        /// <summary>
        /// The episodes of one Sonarr series if they are already in memory, without loading or
        /// waiting (null otherwise). Counts as a read, so a held series stays fresh.
        /// </summary>
        public ArrSnapshotRead<ArrEpisodesSnapshot>? PeekEpisodes(ArrConnection instance, int seriesId)
        {
            if (instance.Kind != ArrKind.Sonarr) return null;
            var state = StateFor(instance, out _);
            var slot = state?.ExistingEpisodes(seriesId);
            if (slot == null) return null;
            slot.Touch(_now());
            var peek = slot.Peek();
            return peek.Value == null ? null : new ArrSnapshotRead<ArrEpisodesSnapshot> { Value = peek.Value, LoadedAt = peek.LoadedAt, Error = peek.Error };
        }

        /// <summary>
        /// Calendar entries for [<paramref name="start"/>, <paramref name="end"/>]. Ranges inside the
        /// window kept in memory (the previous month to today + 100 d) are served from it; other ranges
        /// are read in the background by whole months (at most two at a time per instance, waited for
        /// up to 15 seconds, kept for 15 minutes, failures retried after 30 seconds) and the read is
        /// stopped when every request waiting for it has gone. The returned snapshot may hold more than
        /// the range; callers filter by date.
        /// </summary>
        public async Task<ArrSnapshotRead<ArrCalendarSnapshot>> GetCalendarAsync(ArrConnection instance, DateTime start, DateTime end, CancellationToken cancellationToken)
        {
            var state = StateFor(instance, out var notUsable);
            if (state == null) return new ArrSnapshotRead<ArrCalendarSnapshot> { Error = notUsable };

            var now = _now();
            var (windowStart, windowEnd) = ArrStateLoaders.CalendarWindow(now);
            if (start >= windowStart && end <= windowEnd)
            {
                var read = await ReadSlotAsync(state, state.Calendar, cancellationToken).ConfigureAwait(false);
                if (read.Value == null || read.Value.Covers(start, end)) return read;

                // The window moved on (a new day) since the last refresh: refresh now and wait.
                await WaitForRefreshAsync(state.Calendar, ColdWait(ArrSnapshotKind.Calendar), cancellationToken).ConfigureAwait(false);
                var peek = state.Calendar.Peek();
                if (peek.Value != null && peek.Value.Covers(start, end))
                {
                    return new ArrSnapshotRead<ArrCalendarSnapshot> { Value = peek.Value, LoadedAt = peek.LoadedAt, Error = peek.Error };
                }
            }

            return await state.Ranges.GetAsync(start, end, now, RangeWait, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Refreshes a library index now (ignoring freshness and backoff) and returns the result; used by
        /// scheduled tasks that need current data. A refresh already running is joined instead.
        /// </summary>
        public async Task<ArrResult<ArrLibrarySnapshot>> RefreshLibraryNowAsync(ArrConnection instance, CancellationToken cancellationToken)
        {
            var state = StateFor(instance, out var notUsable);
            if (state == null) return ArrResult<ArrLibrarySnapshot>.Failure(notUsable!);
            state.Library.Touch(_now());
            await state.Library.StartRefresh(_backgroundCalls, _now, _shutdownToken).WaitAsync(cancellationToken).ConfigureAwait(false);
            var peek = state.Library.Peek();
            if (peek.Error != null || peek.Value == null)
                return ArrResult<ArrLibrarySnapshot>.Failure(peek.Error ?? new ArrError(ArrErrorKind.Internal, "The library could not be read."));
            return ArrResult<ArrLibrarySnapshot>.Success(peek.Value);
        }

        /// <summary>
        /// Asks for a refresh of one snapshot (debounced: several requests within two seconds make
        /// one refresh). Returns false when the instance is unknown or not usable.
        /// </summary>
        public bool RequestRefresh(string instanceId, ArrSnapshotKind kind)
        {
            var connection = _factory.Registry.Get(instanceId);
            if (connection == null) return false;
            var state = StateFor(connection, out _);
            if (state == null) return false;
            if (kind == ArrSnapshotKind.Episodes)
            {
                // Every series held for this instance.
                foreach (var episodes in state.EpisodeSlots()) episodes.Request(_now() + DebounceDelay);
                return true;
            }
            var slot = state.Slot(kind);
            slot.Request(_now() + DebounceDelay);
            return true;
        }

        /// <summary>
        /// One reconciler pass: drops state of removed/changed instances and starts every refresh
        /// that is due (interval reached for a snapshot read recently, or a debounced request).
        /// Returns the refreshes started.
        /// </summary>
        public IReadOnlyList<Task> Tick()
        {
            var started = new List<Task>();
            var now = _now();
            var usable = _factory.Registry.All().Where(c => c.Usable).ToDictionary(c => c.Id, StringComparer.OrdinalIgnoreCase);
            foreach (var (id, state) in _states)
            {
                if (!usable.ContainsKey(id))
                {
                    _states.TryRemove(new KeyValuePair<string, InstanceState>(id, state));
                    continue;
                }
                if (StateFor(usable[id], out _) is not { } current || !ReferenceEquals(current, state)) continue;

                var expired = PipelineExpired(state, now);
                if (expired != state.PipelineExpired)
                {
                    state.PipelineExpired = expired;
                    var handlers = PipelineChanged;
                    if (handlers != null)
                    {
                        foreach (var handler in handlers.GetInvocationList().Cast<Action<ArrConnection, bool>>())
                        {
                            try
                            {
                                handler(state.Client.Connection, expired);
                            }
                            catch (Exception ex)
                            {
                                _logger?.Warning($"Arr state: an expiry observer failed ({ex.GetType().Name}).");
                            }
                        }
                    }
                }

                foreach (var slot in state.Slots.Concat(state.EpisodeSlots()))
                {
                    if (slot.Inflight != null || slot.Retired) continue;
                    var requested = slot.RequestDue(now);
                    if (!requested)
                    {
                        if (slot.InBackoff(now)) continue;
                        var policy = PolicyFor(slot.Kind, state, now);
                        if (now - slot.LastInterest > policy.Interest) continue;
                        if (slot.HasValue && now - slot.CheckedAt < policy.Interval) continue;
                    }
                    started.Add(slot.StartRefresh(_backgroundCalls, _now, _shutdownToken));
                }
            }
            return started;
        }

        /// <summary>Removes warm-start files of instances that are no longer configured.</summary>
        public void PruneCacheFiles()
        {
            // No configuration loaded (yet): nothing can be judged unused.
            if (_cacheDirectory == null || _config() == null || !Directory.Exists(_cacheDirectory)) return;
            var ids = _factory.Registry.All().Select(c => c.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var file in Directory.EnumerateFiles(_cacheDirectory, "*.library.json"))
            {
                var id = Path.GetFileName(file)[..^".library.json".Length];
                if (ids.Contains(id)) continue;
                try
                {
                    File.Delete(file);
                }
                catch (IOException)
                {
                    // best effort
                }
                catch (UnauthorizedAccessException)
                {
                    // best effort
                }
            }
        }

        /// <summary>Diagnostics for the admin state route.</summary>
        public ArrStateReport Describe()
        {
            var now = _now();
            var instances = new List<ArrInstanceReport>();
            foreach (var connection in _factory.Registry.All())
            {
                _states.TryGetValue(connection.Id, out var state);
                instances.Add(new ArrInstanceReport
                {
                    Id = connection.Id,
                    Name = connection.Name,
                    Kind = connection.Kind,
                    Usable = connection.Usable,
                    Snapshots = state == null
                        ? Array.Empty<ArrSlotReport>()
                        : new[]
                        {
                            state.Library.Report(now, state.Library.Peek().Value is { } l ? l.Movies.Count + l.Series.Count : null),
                            state.Queue.Report(now, state.Queue.Peek().Value?.Records.Count),
                            state.History.Report(now, state.History.Peek().Value?.Records.Count),
                            state.Calendar.Report(now, state.Calendar.Peek().Value?.Entries.Count),
                            state.System.Report(now, state.System.Peek().Value?.Health.Count),
                        },
                    CachedCalendarRanges = state?.Ranges.Count ?? 0,
                    CachedEpisodeSeries = state?.EpisodeSlots().Count ?? 0,
                });
            }
            return new ArrStateReport
            {
                Instances = instances,
                BackgroundCalls = _backgroundCalls.Calls,
                Routes = _routes.OrderBy(r => r.Key, StringComparer.Ordinal).ToDictionary(r => r.Key, r => r.Value.Snapshot()),
            };
        }

        /// <summary>
        /// Cancels background reads and waits for their complete tasks, including cache writes and
        /// health/change observers. Refuses new work and also drains replaced instance states.
        /// </summary>
        public Task StopAsync()
        {
            TaskCompletionSource completion;
            Task[] pending;
            lock (_backgroundGate)
            {
                if (_stopped != null) return _stopped;
                completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                _stopped = completion.Task;
                pending = _backgroundTasks.Values.ToArray();
            }
            // Cancellation callbacks can block too: the shutdown caller only waits on this task.
            using (ExecutionContext.SuppressFlow()) _ = Task.Run(() => DrainAsync(pending, completion));
            return completion.Task;
        }

        /// <summary>Starts the same drain, waiting only until the host's stop deadline fires.</summary>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            try
            {
                await StopAsync().WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Interlocked.Exchange(ref _stopWaitExpired, 1);
                LogShutdown("the host stop deadline elapsed; background draining continues.");
            }
        }

        /// <summary>Starts shutdown and waits at most five seconds, or returns after an expired host deadline.</summary>
        public void Dispose()
        {
            var drain = StopAsync();
            if (Volatile.Read(ref _stopWaitExpired) != 0) return;
            try
            {
                drain.WaitAsync(DisposeWait).GetAwaiter().GetResult();
            }
            catch (TimeoutException)
            {
                Interlocked.Exchange(ref _stopWaitExpired, 1);
                LogShutdown("the disposal wait elapsed; background draining continues.");
            }
        }

        // The slot clears Inflight before its observers run, and a replaced state leaves _states.
        // Own the scheduled task instead of trying to discover work from the current slots at stop.
        private bool TrackBackground(Task task)
        {
            lock (_backgroundGate)
            {
                if (_stopped != null) return false;
                // The observation/logging continuation is part of shutdown ownership too. Removing
                // only the raw task would permit its diagnostic to write after the drain returned.
                var observed = task.ContinueWith(done =>
                {
                    try
                    {
                        if (done.IsFaulted) LogShutdown($"background work failed ({done.Exception!.GetBaseException().GetType().Name}).");
                        else if (done.IsCanceled) LogShutdown("background work was cancelled.");
                    }
                    finally
                    {
                        lock (_backgroundGate) _backgroundTasks.Remove(done);
                    }
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                _backgroundTasks.Add(task, observed);
            }
            return true;
        }

        // Schedule detached helpers with the same ownership as snapshot refreshes.
        /// <summary>Schedules an owned helper; tests also exercise unexpected fault/cancellation outcomes.</summary>
        internal Task<T> StartBackground<T>(Func<Task<T>> action, T stoppedResult)
        {
            Task<Task<T>> outer;
            using (ExecutionContext.SuppressFlow()) outer = new Task<Task<T>>(action);
            var task = outer.Unwrap();
            if (!TrackBackground(task)) return Task.FromResult(stoppedResult);
            outer.Start(TaskScheduler.Default);
            return task;
        }

        private async Task DrainAsync(Task[] pending, TaskCompletionSource completion)
        {
            try
            {
                try
                {
                    await _shutdown.CancelAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // A faulty cancellation callback cannot skip draining the admitted writes.
                    LogShutdown($"a shutdown cancellation callback failed ({ex.GetType().Name}).");
                }
                try
                {
                    await Task.WhenAll(pending).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    LogShutdown($"background draining failed ({ex.GetType().Name}).");
                }
            }
            finally
            {
                // Only this one drain owns cancellation-source disposal; deadline/dispose callers
                // leave it alive while tasks or cancellation callbacks still hold its token.
                _shutdown.Dispose();
                completion.TrySetResult();
            }
        }

        private void LogShutdown(string message)
        {
            try { _logger?.Debug("Arr state: " + message); }
            catch (Exception) { /* A diagnostic must never fail shutdown. */ }
        }

        internal void Record(string route, long calls, bool waited)
        {
            var stats = _routes.GetOrAdd(route, _ => new ArrRouteStats());
            stats.Add(calls, waited);
        }

        private Task<ArrSnapshotRead<T>> ReadAsync<T>(ArrConnection instance, Func<InstanceState, ArrSnapshotSlot<T>> pick, bool background, CancellationToken cancellationToken)
            where T : class
        {
            var state = StateFor(instance, out var notUsable);
            if (state == null) return Task.FromResult(new ArrSnapshotRead<T> { Error = notUsable });
            return ReadSlotAsync(state, pick(state), cancellationToken, background);
        }

        private async Task<ArrSnapshotRead<T>> ReadSlotAsync<T>(InstanceState state, ArrSnapshotSlot<T> slot, CancellationToken cancellationToken, bool background = false)
            where T : class
        {
            var now = _now();
            if (!background) slot.Touch(now);
            else if (slot.Kind != ArrSnapshotKind.Library) slot.TouchBackground(now);
            var policy = PolicyFor(slot.Kind, state, now);
            var peek = slot.Peek();
            // A background reader takes what is held (the reconciler keeps it at the idle pace); a
            // page wants it within the snapshot's freshness target. A value kept over an incomplete
            // read was checked then (CheckedAt), so it isn't read again at once; it says its age.
            if (peek.Value != null && now - slot.CheckedAt <= (background ? policy.MaxServe : policy.Fresh))
            {
                return new ArrSnapshotRead<T> { Value = peek.Value, LoadedAt = peek.LoadedAt, Error = peek.Error, Stale = !background && now - peek.LoadedAt > policy.Fresh };
            }

            // Past its freshness target: refresh in the background (unless backing off after failures).
            var refresh = slot.InBackoff(now) ? slot.Inflight : slot.StartRefresh(_backgroundCalls, _now, _shutdownToken);
            if (peek.Value != null && now - peek.LoadedAt <= policy.MaxServe)
            {
                return new ArrSnapshotRead<T> { Value = peek.Value, LoadedAt = peek.LoadedAt, Error = peek.Error, Stale = true };
            }

            // Cold (nothing loaded yet) or too old to show: wait for the refresh, for a bounded time.
            if (refresh != null)
            {
                ArrRequestScope.MarkWaited();
                await WaitAsync(refresh, policy.ColdWait, cancellationToken).ConfigureAwait(false);
            }
            peek = slot.Peek();
            if (peek.Value == null && peek.Error == null)
            {
                return new ArrSnapshotRead<T> { Error = new ArrError(ArrErrorKind.Timeout, "Still loading from the instance; try again in a moment.") };
            }
            var age = _now() - peek.LoadedAt;
            return new ArrSnapshotRead<T>
            {
                Value = peek.Value,
                LoadedAt = peek.Value != null ? peek.LoadedAt : null,
                Error = peek.Error,
                Stale = peek.Value != null && age > policy.Fresh,
                // Still too old after the wait, and the latest read failed: a queue or history that old
                // says nothing about now (the library, calendar and system stay served as they are).
                Expired = peek.Value != null && peek.Error != null && age > policy.MaxServe && Expires(slot.Kind),
            };
        }

        private async Task WaitForRefreshAsync<T>(ArrSnapshotSlot<T> slot, TimeSpan wait, CancellationToken cancellationToken)
            where T : class
        {
            ArrRequestScope.MarkWaited();
            await WaitAsync(slot.StartRefresh(_backgroundCalls, _now, _shutdownToken), wait, cancellationToken).ConfigureAwait(false);
        }

        private static async Task WaitAsync(Task refresh, TimeSpan wait, CancellationToken cancellationToken)
        {
            try
            {
                await refresh.WaitAsync(wait, cancellationToken).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                // Serve what is there; the refresh keeps running in the background.
            }
        }

        private InstanceState? StateFor(ArrConnection instance, out ArrError? notUsable)
        {
            lock (_backgroundGate)
            {
                if (_stopped != null)
                {
                    notUsable = new ArrError(ArrErrorKind.Internal, "Jellyfin is shutting down.");
                    return null;
                }
            }
            var client = _factory.For(instance.Id);
            if (!client.Ok)
            {
                notUsable = client.Error;
                return null;
            }
            notUsable = null;
            var c = client.Value!;
            return _states.AddOrUpdate(
                instance.Id,
                _ => NewState(c),
                (_, existing) => ReferenceEquals(existing.Client, c) ? existing : NewState(c));
        }

        private InstanceState NewState(ArrClient client)
        {
            var state = new InstanceState(client, this);
            LoadLibraryCache(state);
            state.Library.Refreshed += (_, value) => { if (value != null) SaveLibraryCache(state, value); };
            state.Queue.Refreshed += (_, value) =>
            {
                if (value == null) return;
                QueueRefreshedHook?.Invoke(client.Connection, value);
            };
            // Publish rows, their suspect/departure decisions and first-seen clocks in one order,
            // before any reader can observe the new snapshot without its retained rows.
            state.Queue.Publishing = (_, after) =>
            {
                OnQueueRefreshed(state, after);
                StampQueue(state, after);
            };
            state.Queue.Kept += read => OnQueueReadKept(state, read);
            var name = client.Connection.Name;
            void Log(ArrSnapshotKind kind, ArrError? error)
            {
                if (error != null)
                    _logger?.Warning($"Arr state: {name} {kind.ToString().ToLowerInvariant()} can't be read ({error.Kind}: {error.Message.TrimEnd('.')}); pages keep what was read before (if anything), retrying with backoff.");
                else
                    _logger?.Info($"Arr state: {name} {kind.ToString().ToLowerInvariant()} can be read again.");
            }
            WireLiveChanges(state);
            state.Library.HealthChanged += Log;
            state.Queue.HealthChanged += Log;
            state.Queue.HealthChanged += (_, error) => RaiseQueueHealthChanged(client.Connection, error != null);
            state.History.HealthChanged += Log;
            state.Calendar.HealthChanged += Log;
            state.System.HealthChanged += Log;
            return state;
        }

        private TimeSpan ColdWait(ArrSnapshotKind kind) => PolicyFor(kind, null, _now()).ColdWait;

        /// <summary>The snapshots whose value expires (past its longest serve time it is unknown, not shown as live).</summary>
        private static bool Expires(ArrSnapshotKind kind) => kind is ArrSnapshotKind.Queue or ArrSnapshotKind.History;

        /// <summary>
        /// True when the instance's queue or history is held but older than its longest serve time
        /// and its latest read failed, or was never read and its read failed: what it is downloading
        /// is unknown. (One nobody has read for a while, so not refreshed, isn't: the next read
        /// refreshes it.) From memory only.
        /// </summary>
        public bool PipelineExpired(ArrConnection instance)
            => _states.TryGetValue(instance.Id, out var state) && PipelineExpired(state, _now());

        private bool PipelineExpired(InstanceState state, DateTimeOffset now)
        {
            return Expired(state.Queue, state, now) || Expired(state.History, state, now);
        }

        private bool Expired<T>(ArrSnapshotSlot<T> slot, InstanceState state, DateTimeOffset now)
            where T : class
        {
            var peek = slot.Peek();
            if (peek.Error == null) return false;
            // Never read and the read failed, or held past its longest serve time with the latest read failed.
            return peek.Value == null || now - peek.LoadedAt > PolicyFor(slot.Kind, state, now).MaxServe;
        }

        /// <summary>
        /// Raised (from the reconciler's pass) when an instance's queue or history expires (true) or
        /// is read again after it had (false): every status built on it changes, though no snapshot did.
        /// </summary>
        public event Action<ArrConnection, bool>? PipelineChanged;

        /// <summary>
        /// Raised when an instance's queue reads start failing (true) or succeed again (false). Inside
        /// its longest serve time the queue is still shown, but no longer as fresh (no time left is
        /// given): the statuses of its downloads change though no snapshot did.
        /// </summary>
        public event Action<ArrConnection, bool>? QueueHealthChanged;

        private void RaiseQueueHealthChanged(ArrConnection connection, bool failing)
        {
            var handlers = QueueHealthChanged;
            if (handlers == null) return;
            foreach (var handler in handlers.GetInvocationList().Cast<Action<ArrConnection, bool>>())
            {
                try
                {
                    handler(connection, failing);
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Arr state: a queue health observer failed ({ex.GetType().Name}).");
                }
            }
        }

        /// <summary>
        /// When JE first saw a queue row of the instance in its current class, and in any problem
        /// class (<see cref="ArrQueueSeen"/>). A row not stamped yet (read between a refresh and its
        /// stamping), or whose class changed since, is answered as first seen now. From memory only.
        /// </summary>
        public ArrQueueSeen QueueSeen(ArrConnection instance, ArrQueueEntry row)
        {
            var now = _now().UtcDateTime;
            var cls = ArrQueueStates.Classify(row);
            ArrQueueSeen? held = null;
            if (_states.TryGetValue(instance.Id, out var state))
            {
                lock (state.SeenGate) state.Seen.TryGetValue(SeenKey(row), out held);
            }
            return Advance(held, cls, now);
        }

        /// <summary>The clock of a row whose class is <paramref name="cls"/> now, from what was held (null: first seen now).</summary>
        internal static ArrQueueSeen Advance(ArrQueueSeen? held, ArrQueueClass cls, DateTime now)
        {
            if (held == null) return new ArrQueueSeen(cls, now, ArrQueueStates.IsProblem(cls) ? now : null);
            if (held.Class == cls) return held;
            // One problem turning into another (stalled, then blocked) is the same trouble: its clocks
            // carry on. Anything else starts the reason's clock again; leaving the problems clears it.
            if (ArrQueueStates.IsProblem(cls) && ArrQueueStates.IsProblem(held.Class)) return new ArrQueueSeen(cls, held.ReasonSince, held.AttentionSince ?? now);
            return new ArrQueueSeen(cls, now, ArrQueueStates.IsProblem(cls) ? now : null);
        }

        /// <summary>A queue row's identity for its clock: the download (or row) and the movie or episode, never the title.</summary>
        private static string SeenKey(ArrQueueEntry row)
            => (string.IsNullOrEmpty(row.DownloadId) ? "r:" + row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) : "d:" + row.DownloadId)
                + "|" + (row.MovieId is int m ? "m" + m.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : row.EpisodeId is int e ? "e" + e.ToString(System.Globalization.CultureInfo.InvariantCulture) : "-");

        /// <summary>
        /// Stamps the clocks of every row of a queue as published (a refresh or a live patch): rows
        /// seen for the first time start now, a changed class moves on (<see cref="Advance"/>), and
        /// confirmed departures are forgotten while missed/partial rows retain their clocks. Runs inside
        /// the slot's lock as the queue is published (<see cref="ArrSnapshotSlot{T}.Publishing"/>), so every publication is stamped, in
        /// order (lock order: the slot's, then SeenGate; <see cref="QueueSeen"/> takes SeenGate alone).
        /// </summary>
        private void StampQueue(InstanceState state, ArrQueueSnapshot queue)
        {
            var now = _now().UtcDateTime;
            lock (state.SeenGate)
            {
                var next = new Dictionary<string, ArrQueueSeen>(StringComparer.Ordinal);
                foreach (var row in queue.Records)
                {
                    var key = SeenKey(row);
                    if (next.ContainsKey(key)) continue;
                    state.Seen.TryGetValue(key, out var held);
                    next[key] = Advance(held, ArrQueueStates.Classify(row), now);
                }
                // Retain clocks of suspects and partial-read baseline rows after the departure
                // decision. A confirmed departure is in neither set, so its clock is forgotten.
                foreach (var row in (state.QueueRows?.Values.Select(r => r.Row) ?? Enumerable.Empty<ArrQueueEntry>())
                    .Concat(state.QueueSuspects?.Values.Select(s => s.Row) ?? Enumerable.Empty<ArrQueueEntry>()))
                {
                    var key = SeenKey(row);
                    if (state.Seen.TryGetValue(key, out var held)) next.TryAdd(key, held);
                }
                state.Seen.Clear();
                foreach (var (key, value) in next) state.Seen[key] = value;
            }
        }

        private static string? DepartureKey(ArrQueueEntry row)
            => row.MovieId is int movie ? "m" + movie.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : row.EpisodeId is int episode ? "e" + episode.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;

        /// <summary>
        /// When a download of this movie (Radarr movie id) or episode (Sonarr episode id) left the
        /// queue within the last few minutes, or null. Until the library (or episodes) snapshot has
        /// been read again after that moment, the download is most likely being imported: callers
        /// show "almost ready" instead of falling back to "looking".
        /// </summary>
        public DateTimeOffset? LeftQueueAt(ArrConnection instance, int? movieId, int? episodeId)
        {
            if (!_states.TryGetValue(instance.Id, out var state)) return null;
            var key = movieId is int m ? "m" + m.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : episodeId is int e ? "e" + e.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
            return key != null && state.Departures.TryGetValue(key, out var at) && _now() - at <= DepartureMemory ? at : null;
        }

        /// <summary>
        /// Queue rows the last complete read over more than one page lacked and that no later read
        /// has shown leaving yet: a row moving between pages while they were read is missed, so it
        /// counts as gone only once the next complete read lacks it too (see
        /// <see cref="OnQueueRefreshed"/>), or a published partial read omitted. Until then statuses keep showing its last queue state
        /// (still downloading), not "looking" — and not "almost ready", which only a real departure
        /// earns. Empty when there are none still inside their serving limit.
        /// </summary>
        public IReadOnlyList<ArrQueueEntry> MissedQueueRows(ArrConnection instance)
            => MissedQueueState(instance).Current;

        /// <summary>
        /// Retained rows keep their own last-sighting age, not the age of a newer queue read that
        /// missed them. Expired rows still await departure proof but cannot decide a current state.
        /// </summary>
        internal (IReadOnlyList<ArrQueueEntry> Current, IReadOnlyList<ArrQueueEntry> Expired) MissedQueueState(ArrConnection instance)
        {
            if (!_states.TryGetValue(instance.Id, out var state) || state.QueueSuspects is not { Count: > 0 } suspects)
                return (Array.Empty<ArrQueueEntry>(), Array.Empty<ArrQueueEntry>());
            var now = _now();
            return (suspects.Values.Where(s => now - s.SeenAt <= QueueMaxServe).Select(s => s.Row).ToArray(),
                suspects.Values.Where(s => now - s.SeenAt > QueueMaxServe).Select(s => s.Row).ToArray());
        }

        /// <summary>
        /// A download that left the queue was most likely imported (or removed, or failed): the
        /// library entry (<c>hasFile</c>, a series' file counts), the history (the import or failure
        /// event) and the episodes of its series are asked for again soon (debounced), instead of
        /// waiting for their own, slower interval — per departed row, so one episode importing while
        /// another of the same series still downloads counts too. A row missing from a paged queue
        /// (more than 500 rows; Sonarr lists each episode of a season pack as its own row) needs two
        /// complete reads in a row without it, or a one-page read, before it counts as gone: its
        /// departure is seen one poll later, and meanwhile it keeps its last queue state
        /// (<see cref="MissedQueueRows"/>). A read that shows it again, even one that is not
        /// published (<see cref="OnQueueReadKept"/>), starts that count over.
        /// A download that joined the queue (a grab) refreshes the history for the journey's
        /// "grabbed" date. Only while "Requests &amp;
        /// downloads" phase 1 is on (checked when the queue is read, so switching it takes effect at
        /// once); with it off the snapshots keep their own intervals, as before.
        /// </summary>
        private void OnQueueRefreshed(InstanceState state, ArrQueueSnapshot queue)
        {
            var titles = new HashSet<int>();
            var now = _now();
            var rows = new Dictionary<string, QueueKnownRow>(StringComparer.Ordinal);
            foreach (var row in queue.Records)
            {
                if (TitleOf(row) is int t) titles.Add(t);
                if (DepartureKey(row) is { } key) rows[key] = new QueueKnownRow(row, now);
            }
            var previous = state.QueueTitles;
            var previousRows = state.QueueRows;
            // A queue cut at the row cap, or read while rows moved between pages, holds only part of
            // the queue: a row missing from it may be past the cap or merely missed, so nothing counts
            // as having left. The baseline the next complete read is compared with keeps every row
            // seen since the last complete read (this read's rows are all real), so a row that leaves
            // meanwhile, or was hidden past the cap, is still found leaving then. The cap is on the
            // distinct rows kept: reads of the same queue mostly share their rows.
            var partial = queue.Truncated || queue.Incomplete;
            Dictionary<string, QueueKnownRow>? merged = null;
            if (partial && previous != null && previousRows != null)
            {
                merged = new Dictionary<string, QueueKnownRow>(previousRows, StringComparer.Ordinal);
                foreach (var (key, row) in rows) merged[key] = row;
            }
            if (merged != null && previous != null && merged.Count <= QueueBaselineMax)
            {
                state.QueueTitles = new HashSet<int>(previous.Concat(titles));
                state.QueueRows = merged;
            }
            else
            {
                state.QueueTitles = titles;
                state.QueueRows = rows;
            }
            foreach (var (key, at) in state.Departures)
            {
                if (now - at > DepartureMemory) state.Departures.TryRemove(key, out _);
            }
            if (previous == null)
            {
                state.QueueSuspects = null;
                return;
            }
            var affected = new HashSet<int>();
            // The suspects are replaced, never changed in place: statuses read them on other threads.
            var before = state.QueueSuspects;
            if (partial)
            {
                // Missing baseline rows remain status knowledge, with their original sighting age.
                // Newly retained rows have no complete-read miss yet. Existing suspects keep
                // the evidence already established by complete reads; this read adds none.
                var kept = (before ?? new Dictionary<string, QueueSuspect>(StringComparer.Ordinal))
                    .Where(kv => !rows.ContainsKey(kv.Key))
                    .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);
                foreach (var (key, row) in previousRows ?? new Dictionary<string, QueueKnownRow>(StringComparer.Ordinal))
                {
                    if (!rows.ContainsKey(key)) kept.TryAdd(key, new QueueSuspect(row.Row, true, row.SeenAt));
                }
                state.QueueSuspects = kept.Count > 0 ? kept : null;
            }
            else
            {
                Dictionary<string, QueueSuspect>? suspects = null;
                List<ArrQueueEntry>? confirmed = null;
                foreach (var (key, suspect) in before ?? new Dictionary<string, QueueSuspect>(StringComparer.Ordinal))
                {
                    if (rows.ContainsKey(key)) continue;
                    if (suspect.SeenSince && queue.Paged)
                    {
                        // A read that wasn't published showed it after it was first missed: this is
                        // a first miss again, not the second in a row.
                        (suspects ??= new Dictionary<string, QueueSuspect>(StringComparer.Ordinal))[key] = suspect with { SeenSince = false };
                        continue;
                    }
                    state.Departures[key] = now;
                    if (TitleOf(suspect.Row) is int t) affected.Add(t);
                    (confirmed ??= new List<ArrQueueEntry>()).Add(suspect.Row);
                }
                affected.UnionWith(previous.Where(t => !titles.Contains(t)));
                foreach (var (key, row) in previousRows ?? new Dictionary<string, QueueKnownRow>(StringComparer.Ordinal))
                {
                    if (rows.ContainsKey(key)) continue;
                    if (queue.Paged)
                    {
                        (suspects ??= new Dictionary<string, QueueSuspect>(StringComparer.Ordinal))[key] = new QueueSuspect(row.Row, false, row.SeenAt);
                    }
                    else
                    {
                        state.Departures[key] = now;
                        if (TitleOf(row.Row) is int t) affected.Add(t);
                    }
                }
                state.QueueSuspects = suspects;
                // This read's own row diff can't show them leaving (the read before lacked them too):
                // the change feed is told with the snapshot change that follows.
                if (confirmed != null) state.ConfirmedDepartures.Add(queue, confirmed);
            }
            // A row that joined is real even in a partial read (a grab: the history has news).
            var joined = titles.Any(t => !previous.Contains(t)) || (previousRows != null && rows.Keys.Any(k => !previousRows.ContainsKey(k)));
            if (_config() is not { ArrIntegrationEnabled: true, ArrPhase1Enabled: true }) return;
            var due = now + DebounceDelay;
            if (affected.Count > 0)
            {
                state.Library.Request(due);
                if (state.Client.Connection.Kind == ArrKind.Sonarr)
                {
                    foreach (var seriesId in affected) state.ExistingEpisodes(seriesId)?.Request(due);
                }
            }
            if (affected.Count > 0 || joined) state.History.Request(due);
        }

        /// <summary>
        /// A queue read that was not published (an incomplete read kept behind a recent complete
        /// one) still saw real rows: a suspect among them is no longer missed in a row, so the next
        /// complete paged read that lacks it is its first miss again. Nothing else changes — no
        /// baseline, no departure, no reads.
        /// </summary>
        private static void OnQueueReadKept(InstanceState state, ArrQueueSnapshot read)
        {
            var before = state.QueueSuspects;
            if (before == null) return;
            Dictionary<string, QueueSuspect>? after = null;
            foreach (var row in read.Records)
            {
                if (DepartureKey(row) is not { } key || !before.TryGetValue(key, out var suspect) || suspect.SeenSince) continue;
                after ??= new Dictionary<string, QueueSuspect>(before, StringComparer.Ordinal);
                after[key] = suspect with { SeenSince = true };
            }
            if (after != null) state.QueueSuspects = after;
        }

        private static int? TitleOf(ArrQueueEntry row) => row.MovieId ?? row.SeriesId;

        /// <summary>A retained queue row and its sighting age; SeenSince means the next paged miss cannot confirm departure.</summary>
        private sealed record QueueSuspect(ArrQueueEntry Row, bool SeenSince, DateTimeOffset SeenAt);

        /// <summary>A baseline row and the last publication that actually saw it.</summary>
        private sealed record QueueKnownRow(ArrQueueEntry Row, DateTimeOffset SeenAt);

        /// <summary>Freshness and refresh policy per snapshot kind.</summary>
        private Policy PolicyFor(ArrSnapshotKind kind, InstanceState? state, DateTimeOffset now)
        {
            switch (kind)
            {
                case ArrSnapshotKind.Queue:
                case ArrSnapshotKind.History:
                {
                    // The Downloads page's own poll interval. While a page is polling (read within two
                    // intervals) or downloads are active, refresh at that interval; otherwise every 5 minutes.
                    var poll = TimeSpan.FromSeconds(Math.Clamp(_config()?.DownloadsPollIntervalSeconds ?? 30, 5, 300));
                    var watched = state != null && now - state.Slot(kind).LastRead <= poll + poll + TimeSpan.FromSeconds(5);
                    var active = watched || (state?.Queue.Peek().Value?.Records.Count ?? 0) > 0;
                    return new Policy(
                        Fresh: poll + TimeSpan.FromSeconds(5),
                        Interval: active ? poll : TimeSpan.FromMinutes(5),
                        MaxServe: kind == ArrSnapshotKind.Queue ? QueueMaxServe : TimeSpan.FromMinutes(30),
                        Interest: TimeSpan.FromMinutes(15),
                        ColdWait: TimeSpan.FromSeconds(15));
                }
                case ArrSnapshotKind.Calendar:
                    return new Policy(TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15), TimeSpan.FromHours(6), TimeSpan.FromHours(1), TimeSpan.FromSeconds(15));
                case ArrSnapshotKind.System:
                    return new Policy(TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5), TimeSpan.FromHours(1), TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(10));
                case ArrSnapshotKind.Episodes:
                    return new Policy(TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5), TimeSpan.FromHours(6), TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(15));
                default:
                    return new Policy(TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15), TimeSpan.FromDays(7), TimeSpan.FromHours(2), TimeSpan.FromSeconds(20));
            }
        }

        private string? CacheFile(ArrConnection connection)
            => _cacheDirectory == null ? null : Path.Combine(_cacheDirectory, connection.Id + ".library.json");

        private static string Fingerprint(ArrConnection connection) => connection.Kind + "|" + connection.Url.Trim().TrimEnd('/').ToLowerInvariant();

        private void LoadLibraryCache(InstanceState state)
        {
            var file = CacheFile(state.Client.Connection);
            if (file == null || !File.Exists(file)) return;
            try
            {
                if (new FileInfo(file).Length > 128L * 1024 * 1024) return;
                using var stream = File.OpenRead(file);
                var cache = JsonSerializer.Deserialize<LibraryCacheFile>(stream, CacheJson);
                if (cache == null || cache.Version != CacheFileVersion || cache.Fingerprint != Fingerprint(state.Client.Connection)) return;
                state.Library.Seed(new ArrLibrarySnapshot(cache.Movies ?? new List<ArrMovieEntry>(), cache.Series ?? new List<ArrSeriesEntry>(), cache.Tags ?? new Dictionary<int, string>()), cache.SavedAt);
                state.LastCacheWrite = cache.SavedAt;
                // Served at once, but (with "Requests & downloads" phase 1 on, whose statuses depend on
                // it) read again right away: titles added while Jellyfin was down (or since the file was
                // written) would otherwise be missing for up to 15 minutes. With it off, as before.
                if (_config() is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true }) state.Library.Request(_now());
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                _logger?.Warning($"Arr state: ignoring the cached library of {state.Client.Connection.Name} ({ex.GetType().Name}); it is read again from the instance.");
            }
        }

        /// <summary>Test seam: called before an admitted library cache write creates its files.</summary>
        internal Action? LibraryCacheWritingHook { get; set; }

        private void SaveLibraryCache(InstanceState state, ArrLibrarySnapshot value)
        {
            var file = CacheFile(state.Client.Connection);
            if (file == null) return;
            var now = _now();
            if (now - state.LastCacheWrite < CacheWriteInterval) return;
            state.LastCacheWrite = now;
            var temp = file + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                LibraryCacheWritingHook?.Invoke();
                Directory.CreateDirectory(_cacheDirectory!);
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using (var stream = new FileStream(temp, options))
                {
                    JsonSerializer.Serialize(stream, new LibraryCacheFile
                    {
                        Version = CacheFileVersion,
                        Fingerprint = Fingerprint(state.Client.Connection),
                        SavedAt = state.Library.LoadedAt,
                        Movies = value.Movies.ToList(),
                        Series = value.Series.ToList(),
                        Tags = value.Tags.ToDictionary(t => t.Key, t => t.Value),
                    });
                }
                File.Move(temp, file, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
            {
                _logger?.Warning($"Arr state: could not write the library cache for {state.Client.Connection.Name}: {ex.Message}");
            }
            finally
            {
                try
                {
                    if (File.Exists(temp)) File.Delete(temp);
                }
                catch (IOException)
                {
                    // best effort
                }
            }
        }

        private sealed record Policy(TimeSpan Fresh, TimeSpan Interval, TimeSpan MaxServe, TimeSpan Interest, TimeSpan ColdWait);

        private sealed class LibraryCacheFile
        {
            public int Version { get; set; }

            public string? Fingerprint { get; set; }

            public DateTimeOffset SavedAt { get; set; }

            public List<ArrMovieEntry>? Movies { get; set; }

            public List<ArrSeriesEntry>? Series { get; set; }

            public Dictionary<int, string>? Tags { get; set; }
        }

        /// <summary>All snapshots of one instance, tied to one client (a changed URL or key starts over).</summary>
        private sealed class InstanceState
        {
            public InstanceState(ArrClient client, ArrStateStore store)
            {
                Client = client;
                _trackBackground = store.TrackBackground;
                Library = new ArrSnapshotSlot<ArrLibrarySnapshot>(ArrSnapshotKind.Library, (_, ct) => ArrStateLoaders.LoadLibraryAsync(client, ct), trackBackground: store.TrackBackground);
                Queue = new ArrSnapshotSlot<ArrQueueSnapshot>(ArrSnapshotKind.Queue, (_, ct) => ArrStateLoaders.LoadQueueAsync(client, ct), q => q.Incomplete, QueueKeepHeld, trackBackground: store.TrackBackground);
                History = new ArrSnapshotSlot<ArrHistorySnapshot>(ArrSnapshotKind.History, (prev, ct) => ArrStateLoaders.LoadHistoryAsync(client, prev, store._now(), ct), trackBackground: store.TrackBackground);
                Calendar = new ArrSnapshotSlot<ArrCalendarSnapshot>(ArrSnapshotKind.Calendar, (_, ct) =>
                {
                    var (start, end) = ArrStateLoaders.CalendarWindow(store._now());
                    return ArrStateLoaders.LoadCalendarAsync(client, start, end, ct);
                }, trackBackground: store.TrackBackground);
                System = new ArrSnapshotSlot<ArrSystemSnapshot>(ArrSnapshotKind.System, (_, ct) => ArrStateLoaders.LoadSystemAsync(client, store._config() is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase2Enabled: true }, ct), trackBackground: store.TrackBackground);
                Slots = new IArrSnapshotSlot[] { Library, Queue, History, Calendar, System };
                Ranges = new CalendarRangeCache(client, store._backgroundCalls, store._now, store._shutdownToken, store.TrackBackground);
            }

            public ArrClient Client { get; }

            public ArrSnapshotSlot<ArrLibrarySnapshot> Library { get; }

            public ArrSnapshotSlot<ArrQueueSnapshot> Queue { get; }

            public ArrSnapshotSlot<ArrHistorySnapshot> History { get; }

            public ArrSnapshotSlot<ArrCalendarSnapshot> Calendar { get; }

            public ArrSnapshotSlot<ArrSystemSnapshot> System { get; }

            public IReadOnlyList<IArrSnapshotSlot> Slots { get; }

            public CalendarRangeCache Ranges { get; }

            public DateTimeOffset LastCacheWrite { get; set; } = DateTimeOffset.MinValue;

            /// <summary>Movie/series ids in the queue at the last refresh (null before the first).</summary>
            public HashSet<int>? QueueTitles { get; set; }

            /// <summary>Movie ("m…") and episode ("e…") keys in the queue at the last refresh, with their row.</summary>
            public Dictionary<string, QueueKnownRow>? QueueRows { get; set; }

            /// <summary>
            /// Rows the last complete paged read lacked, with their last queue state. They count as
            /// having left only when the next complete read lacks them too. Replaced, never changed
            /// in place (statuses read it on other threads).
            /// </summary>
            public IReadOnlyDictionary<string, QueueSuspect>? QueueSuspects { get; set; }

            /// <summary>
            /// Suspects each published queue read confirmed gone. Keyed by its snapshot so a delayed
            /// change observer cannot take a later read's departures; weak keys retain no old reads.
            /// </summary>
            public ConditionalWeakTable<ArrQueueSnapshot, List<ArrQueueEntry>> ConfirmedDepartures { get; } = new();

            /// <summary>When each recently departed movie/episode left the queue.</summary>
            public ConcurrentDictionary<string, DateTimeOffset> Departures { get; } = new(StringComparer.Ordinal);

            /// <summary>Guards <see cref="Seen"/>.</summary>
            public object SeenGate { get; } = new();

            /// <summary>The first-seen clocks of the queue rows held (see <see cref="QueueSeen"/>).</summary>
            public Dictionary<string, ArrQueueSeen> Seen { get; } = new(StringComparer.Ordinal);

            /// <summary>The queue or history was expired at the reconciler's last pass.</summary>
            public bool PipelineExpired { get; set; }

            private readonly Func<Task, bool> _trackBackground;
            private readonly object _episodesLock = new();
            private readonly Dictionary<int, ArrSnapshotSlot<ArrEpisodesSnapshot>> _episodes = new();

            /// <summary>
            /// The episodes slot of a series, created on first use (evicting the least recently read
            /// idle one when full) and marked read under the same lock. Null when every slot is still
            /// loading: a slot being loaded is never dropped (its load would carry on unowned and a
            /// later read would start a second one), and a dropped slot is retired in the same step
            /// (<see cref="ArrSnapshotSlot{T}.TryRetire"/>), so a reader still holding it can't start
            /// a load either: the number of loads per instance stays bounded.
            /// </summary>
            public ArrSnapshotSlot<ArrEpisodesSnapshot>? EpisodesFor(int seriesId, DateTimeOffset now)
            {
                lock (_episodesLock)
                {
                    if (_episodes.TryGetValue(seriesId, out var slot))
                    {
                        slot.Touch(now);
                        return slot;
                    }
                    while (_episodes.Count >= EpisodeSeriesPerInstance)
                    {
                        var evicted = false;
                        foreach (var (id, candidate) in _episodes.Where(e => e.Value.Inflight == null).OrderBy(e => e.Value.LastRead).ToList())
                        {
                            if (!candidate.TryRetire()) continue; // started loading meanwhile
                            _episodes.Remove(id);
                            evicted = true;
                            break;
                        }
                        if (!evicted) return null;
                    }
                    var client = Client;
                    slot = new ArrSnapshotSlot<ArrEpisodesSnapshot>(ArrSnapshotKind.Episodes, (_, ct) => ArrStateLoaders.LoadEpisodesAsync(client, seriesId, ct), trackBackground: _trackBackground);
                    slot.Replaced += (before, after) => EpisodesReplaced?.Invoke(before, after);
                    slot.Touch(now);
                    _episodes[seriesId] = slot;
                    return slot;
                }
            }

            /// <summary>Raised when a series' episodes were read again (before: null on the first read).</summary>
            public Action<ArrEpisodesSnapshot?, ArrEpisodesSnapshot>? EpisodesReplaced { get; set; }

            /// <summary>The episodes slot of a series if one exists.</summary>
            public ArrSnapshotSlot<ArrEpisodesSnapshot>? ExistingEpisodes(int seriesId)
            {
                lock (_episodesLock) return _episodes.TryGetValue(seriesId, out var slot) ? slot : null;
            }

            /// <summary>Every episodes slot held.</summary>
            public IReadOnlyList<ArrSnapshotSlot<ArrEpisodesSnapshot>> EpisodeSlots()
            {
                lock (_episodesLock) return _episodes.Values.ToList();
            }

            /// <summary>Guards <see cref="TitleStamps"/> and the library patches that set them.</summary>
            public object TitleGate { get; } = new();

            /// <summary>Arr id → stamp of the newest live patch of that title (see PatchLibrary).</summary>
            public Dictionary<int, long> TitleStamps { get; } = new();

            public IArrSnapshotSlot Slot(ArrSnapshotKind kind) => kind switch
            {
                ArrSnapshotKind.Queue => Queue,
                ArrSnapshotKind.History => History,
                ArrSnapshotKind.Calendar => Calendar,
                ArrSnapshotKind.System => System,
                _ => Library,
            };
        }

        /// <summary>
        /// Calendar ranges outside the in-memory window (an older month or one far ahead): read by whole
        /// UTC months (so neighbouring views share one read), in the background like the snapshots
        /// (counted as background calls, stopped on shutdown), single-flight, kept 15 minutes, at most
        /// <see cref="RangeCacheSize"/> per instance and <see cref="RangeLoadsPerInstance"/> running at
        /// once (so they never take every connection the instance's other reads need). A read nobody
        /// waits for any more (every waiting request was abandoned) or that is evicted is cancelled; a
        /// failed one is retried after <see cref="RangeFailureRetry"/>, not on every request.
        /// </summary>
        private sealed class CalendarRangeCache
        {
            private readonly ArrClient _client;
            private readonly ArrCallCounter _background;
            private readonly Func<DateTimeOffset> _now;
            private readonly CancellationToken _shutdown;
            private readonly Func<Task, bool> _trackBackground;
            private readonly object _lock = new();
            private readonly Dictionary<(DateTime, DateTime), Entry> _entries = new();

            public CalendarRangeCache(ArrClient client, ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown, Func<Task, bool> trackBackground)
            {
                _client = client;
                _background = background;
                _now = now;
                _shutdown = shutdown;
                _trackBackground = trackBackground;
            }

            public int Count
            {
                get { lock (_lock) return _entries.Count; }
            }

            /// <summary>The whole UTC months covering [start, end].</summary>
            internal static (DateTime From, DateTime To) Bucket(DateTime start, DateTime end)
            {
                var s = start.ToUniversalTime();
                var e = end.ToUniversalTime();
                var from = new DateTime(s.Year, s.Month, 1, 0, 0, 0, DateTimeKind.Utc);
                var to = new DateTime(e.Year, e.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(1).AddTicks(-1);
                return (from, to);
            }

            public async Task<ArrSnapshotRead<ArrCalendarSnapshot>> GetAsync(DateTime start, DateTime end, DateTimeOffset now, TimeSpan wait, CancellationToken cancellationToken)
            {
                var key = Bucket(start, end);
                Entry entry;
                var started = false;
                lock (_lock)
                {
                    if (!_entries.TryGetValue(key, out var existing) || !Reusable(existing, now))
                    {
                        if (_entries.Values.Count(e => !e.Task.IsCompleted) >= RangeLoadsPerInstance)
                        {
                            return new ArrSnapshotRead<ArrCalendarSnapshot> { Error = new ArrError(ArrErrorKind.Timeout, "Other calendar months are still loading from the instance; try again in a moment.") };
                        }
                        existing = Start(key.From, key.To, now);
                        started = true;
                        _entries[key] = existing;
                        Evict();
                    }
                    entry = existing;
                    entry.Waiters++;
                }

                var abandoned = false;
                try
                {
                    if (started || !entry.Task.IsCompleted) ArrRequestScope.MarkWaited();
                    var result = await entry.Task.WaitAsync(wait, cancellationToken).ConfigureAwait(false);
                    return result.Ok
                        ? new ArrSnapshotRead<ArrCalendarSnapshot> { Value = result.Value, LoadedAt = entry.At }
                        : new ArrSnapshotRead<ArrCalendarSnapshot> { Error = result.Error };
                }
                catch (TimeoutException)
                {
                    // The read keeps running; the next request for this month joins it.
                    return new ArrSnapshotRead<ArrCalendarSnapshot> { Error = new ArrError(ArrErrorKind.Timeout, "Still loading this month from the instance; try again in a moment.") };
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    abandoned = true;
                    throw;
                }
                finally
                {
                    lock (_lock)
                    {
                        entry.Waiters--;
                        if (abandoned && entry.Waiters == 0 && !entry.Task.IsCompleted)
                        {
                            // Nobody waits for it any more: stop the read and forget it.
                            CancelLocked(entry);
                            if (_entries.TryGetValue(key, out var current) && ReferenceEquals(current, entry)) _entries.Remove(key);
                        }
                    }
                }
            }

            // Running, or finished and still within its time to live (15 minutes; 30 seconds for a failure).
            private static bool Reusable(Entry entry, DateTimeOffset now)
            {
                if (!entry.Task.IsCompleted) return true;
                return entry.Task.Result.Ok ? now - entry.At <= RangeTtl : now - entry.FinishedAt <= RangeFailureRetry;
            }

            private Entry Start(DateTime from, DateTime to, DateTimeOffset now)
            {
                var cancel = CancellationTokenSource.CreateLinkedTokenSource(_shutdown);
                var entry = new Entry(cancel, now);
                Task<Task<ArrResult<ArrCalendarSnapshot>>> outer;
                using (ExecutionContext.SuppressFlow())
                {
                    // Include cleanup in the owned task, not a detached continuation after it.
                    outer = new Task<Task<ArrResult<ArrCalendarSnapshot>>>(async () =>
                    {
                        try
                        {
                            return await LoadAsync(from, to, cancel.Token).ConfigureAwait(false);
                        }
                        finally
                        {
                            lock (_lock)
                            {
                                entry.FinishedAt = _now();
                                entry.Disposed = true;
                                cancel.Dispose();
                            }
                        }
                    });
                }
                entry.Task = outer.Unwrap();
                if (_trackBackground(entry.Task)) outer.Start(TaskScheduler.Default);
                else
                {
                    cancel.Dispose();
                    entry.Disposed = true;
                    entry.FinishedAt = now;
                    entry.Task = Task.FromResult(ArrResult<ArrCalendarSnapshot>.Failure(ArrErrorKind.Timeout, "The calendar read was stopped."));
                }
                return entry;
            }

            private async Task<ArrResult<ArrCalendarSnapshot>> LoadAsync(DateTime from, DateTime to, CancellationToken ct)
            {
                ArrCallCounter.Current.Value = _background;
                try
                {
                    return await ArrStateLoaders.LoadCalendarAsync(_client, from, to, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return ArrResult<ArrCalendarSnapshot>.Failure(ArrErrorKind.Timeout, "The calendar read was stopped.");
                }
                catch (Exception ex)
                {
                    return ArrResult<ArrCalendarSnapshot>.Failure(ArrErrorKind.Internal, "Reading the calendar failed: " + ex.Message);
                }
            }

            // Oldest finished entries go first; a running one is only evicted (and cancelled) when
            // nothing else can go.
            private void Evict()
            {
                while (_entries.Count > RangeCacheSize)
                {
                    var oldest = _entries.OrderBy(e => e.Value.Task.IsCompleted ? 0 : 1).ThenBy(e => e.Value.At).First();
                    CancelLocked(oldest.Value);
                    _entries.Remove(oldest.Key);
                }
            }

            private static void CancelLocked(Entry entry)
            {
                if (!entry.Disposed && !entry.Task.IsCompleted) entry.Cancel.Cancel();
            }

            private sealed class Entry
            {
                public Entry(CancellationTokenSource cancel, DateTimeOffset at)
                {
                    Cancel = cancel;
                    At = at;
                }

                public CancellationTokenSource Cancel { get; }

                public DateTimeOffset At { get; }

                public Task<ArrResult<ArrCalendarSnapshot>> Task { get; set; } = null!;

                public DateTimeOffset FinishedAt { get; set; }

                public bool Disposed { get; set; }

                public int Waiters { get; set; }
            }
        }
    }

    /// <summary>
    /// Counts the upstream arr calls made while serving one request (and whether it had to wait for a
    /// cold snapshot). Created by <see cref="ArrStateStore.BeginRequest"/>; dispose to record.
    /// </summary>
    public sealed class ArrRequestScope : IDisposable
    {
        private static readonly AsyncLocal<ArrRequestScope?> CurrentScope = new();
        private readonly ArrStateStore _store;
        private readonly string _route;
        private readonly ArrCallCounter _calls = new();
        private readonly ArrCallCounter? _previousCounter;
        private readonly ArrRequestScope? _previousScope;
        private bool _waited;
        private bool _disposed;

        internal ArrRequestScope(ArrStateStore store, string route)
        {
            _store = store;
            _route = route;
            _previousCounter = ArrCallCounter.Current.Value;
            _previousScope = CurrentScope.Value;
            ArrCallCounter.Current.Value = _calls;
            CurrentScope.Value = this;
        }

        /// <summary>Upstream calls made on this request so far.</summary>
        public long UpstreamCalls => _calls.Calls;

        /// <summary>True when the request waited for a cold snapshot to load.</summary>
        public bool Waited => _waited;

        /// <summary>Records the request in the store's per-route statistics.</summary>
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            ArrCallCounter.Current.Value = _previousCounter;
            CurrentScope.Value = _previousScope;
            _store.Record(_route, _calls.Calls, _waited);
        }

        internal static void MarkWaited()
        {
            if (CurrentScope.Value is { } scope) scope._waited = true;
        }
    }

    /// <summary>Per-route counters (admin diagnostics; the "zero upstream calls per request" check).</summary>
    public sealed class ArrRouteStats
    {
        private long _requests;
        private long _withUpstream;
        private long _upstreamCalls;
        private long _waited;

        internal void Add(long calls, bool waited)
        {
            Interlocked.Increment(ref _requests);
            if (calls > 0)
            {
                Interlocked.Increment(ref _withUpstream);
                Interlocked.Add(ref _upstreamCalls, calls);
            }
            if (waited) Interlocked.Increment(ref _waited);
        }

        internal ArrRouteStatsReport Snapshot() => new()
        {
            Requests = Interlocked.Read(ref _requests),
            RequestsWithUpstreamCalls = Interlocked.Read(ref _withUpstream),
            UpstreamCalls = Interlocked.Read(ref _upstreamCalls),
            RequestsThatWaitedForALoad = Interlocked.Read(ref _waited),
        };
    }

    /// <summary>Counters of one route.</summary>
    public sealed class ArrRouteStatsReport
    {
        /// <summary>Requests served.</summary>
        public long Requests { get; init; }

        /// <summary>Requests that made at least one upstream arr call themselves.</summary>
        public long RequestsWithUpstreamCalls { get; init; }

        /// <summary>Upstream arr calls made by requests themselves.</summary>
        public long UpstreamCalls { get; init; }

        /// <summary>Requests that waited for a snapshot's first (cold) load, done by a background refresh.</summary>
        public long RequestsThatWaitedForALoad { get; init; }
    }

    /// <summary>Admin diagnostics of the store.</summary>
    public sealed class ArrStateReport
    {
        /// <summary>Every registered instance.</summary>
        public IReadOnlyList<ArrInstanceReport> Instances { get; init; } = Array.Empty<ArrInstanceReport>();

        /// <summary>Upstream calls made by background refreshes since start.</summary>
        public long BackgroundCalls { get; init; }

        /// <summary>Per-route request counters since start.</summary>
        public IReadOnlyDictionary<string, ArrRouteStatsReport> Routes { get; init; } = new Dictionary<string, ArrRouteStatsReport>();
    }

    /// <summary>Diagnostics of one instance.</summary>
    public sealed class ArrInstanceReport
    {
        /// <summary>Instance id.</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary>Name.</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public ArrKind Kind { get; init; }

        /// <summary>Enabled and not retired.</summary>
        public bool Usable { get; init; }

        /// <summary>The snapshots (empty until something read this instance).</summary>
        public IReadOnlyList<ArrSlotReport> Snapshots { get; init; } = Array.Empty<ArrSlotReport>();

        /// <summary>Calendar ranges outside the window held in the LRU.</summary>
        public int CachedCalendarRanges { get; init; }

        /// <summary>Series whose episodes are held in memory.</summary>
        public int CachedEpisodeSeries { get; init; }
    }
}
