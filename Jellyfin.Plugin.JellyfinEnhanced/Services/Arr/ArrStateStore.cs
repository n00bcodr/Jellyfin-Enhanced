using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
    public sealed class ArrStateStore : IDisposable
    {
        /// <summary>Folder (inside the JE data folder) for the warm-start cache files.</summary>
        public const string CacheFolderName = "arr-state";

        private const int RangeCacheSize = 8;
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

        /// <summary>The store for a Jellyfin installation (DI).</summary>
        public ArrStateStore(ArrClientFactory factory, IApplicationPaths paths, Logger logger)
            : this(factory, Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", CacheFolderName), logger, null, null)
        {
        }

        /// <summary>A store with explicit dependencies (tests). A null cache directory disables the warm start.</summary>
        internal ArrStateStore(ArrClientFactory factory, string? cacheDirectory, Logger? logger, Func<DateTimeOffset>? now, Func<PluginConfiguration?>? config)
        {
            _factory = factory;
            _cacheDirectory = cacheDirectory;
            _logger = logger;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <summary>How long a request waits for a calendar range outside the window (the read keeps running after that). Tests shorten it.</summary>
        internal TimeSpan RangeWait { get; set; } = TimeSpan.FromSeconds(15);

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
            => ReadAsync(instance, s => s.Library, cancellationToken);

        /// <summary>The whole download queue.</summary>
        public Task<ArrSnapshotRead<ArrQueueSnapshot>> GetQueueAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.Queue, cancellationToken);

        /// <summary>Recent history (newest first).</summary>
        public Task<ArrSnapshotRead<ArrHistorySnapshot>> GetHistoryAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.History, cancellationToken);

        /// <summary>System status, health, disk space, root folders and quality profiles.</summary>
        public Task<ArrSnapshotRead<ArrSystemSnapshot>> GetSystemAsync(ArrConnection instance, CancellationToken cancellationToken)
            => ReadAsync(instance, s => s.System, cancellationToken);

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
            await state.Library.StartRefresh(_backgroundCalls, _now, _shutdown.Token).WaitAsync(cancellationToken).ConfigureAwait(false);
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

                foreach (var slot in state.Slots)
                {
                    if (slot.Inflight != null) continue;
                    var requested = slot.RequestDue(now);
                    if (!requested)
                    {
                        if (slot.InBackoff(now)) continue;
                        var policy = PolicyFor(slot.Kind, state, now);
                        if (now - slot.LastRead > policy.Interest) continue;
                        if (slot.HasValue && now - slot.LoadedAt < policy.Interval) continue;
                    }
                    started.Add(slot.StartRefresh(_backgroundCalls, _now, _shutdown.Token));
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
                });
            }
            return new ArrStateReport
            {
                Instances = instances,
                BackgroundCalls = _backgroundCalls.Calls,
                Routes = _routes.OrderBy(r => r.Key, StringComparer.Ordinal).ToDictionary(r => r.Key, r => r.Value.Snapshot()),
            };
        }

        /// <summary>Stops background refreshes.</summary>
        public void Dispose()
        {
            try
            {
                _shutdown.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // already disposed
            }
            _shutdown.Dispose();
        }

        internal void Record(string route, long calls, bool waited)
        {
            var stats = _routes.GetOrAdd(route, _ => new ArrRouteStats());
            stats.Add(calls, waited);
        }

        private Task<ArrSnapshotRead<T>> ReadAsync<T>(ArrConnection instance, Func<InstanceState, ArrSnapshotSlot<T>> pick, CancellationToken cancellationToken)
            where T : class
        {
            var state = StateFor(instance, out var notUsable);
            if (state == null) return Task.FromResult(new ArrSnapshotRead<T> { Error = notUsable });
            return ReadSlotAsync(state, pick(state), cancellationToken);
        }

        private async Task<ArrSnapshotRead<T>> ReadSlotAsync<T>(InstanceState state, ArrSnapshotSlot<T> slot, CancellationToken cancellationToken)
            where T : class
        {
            var now = _now();
            slot.Touch(now);
            var policy = PolicyFor(slot.Kind, state, now);
            var peek = slot.Peek();
            if (peek.Value != null && now - peek.LoadedAt <= policy.Fresh)
            {
                return new ArrSnapshotRead<T> { Value = peek.Value, LoadedAt = peek.LoadedAt, Error = peek.Error };
            }

            // Past its freshness target: refresh in the background (unless backing off after failures).
            var refresh = slot.InBackoff(now) ? slot.Inflight : slot.StartRefresh(_backgroundCalls, _now, _shutdown.Token);
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
            return new ArrSnapshotRead<T>
            {
                Value = peek.Value,
                LoadedAt = peek.Value != null ? peek.LoadedAt : null,
                Error = peek.Error,
                Stale = peek.Value != null && _now() - peek.LoadedAt > policy.Fresh,
            };
        }

        private async Task WaitForRefreshAsync<T>(ArrSnapshotSlot<T> slot, TimeSpan wait, CancellationToken cancellationToken)
            where T : class
        {
            ArrRequestScope.MarkWaited();
            await WaitAsync(slot.StartRefresh(_backgroundCalls, _now, _shutdown.Token), wait, cancellationToken).ConfigureAwait(false);
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
            var name = client.Connection.Name;
            void Log(ArrSnapshotKind kind, ArrError? error)
            {
                if (error != null)
                    _logger?.Warning($"Arr state: {name} {kind.ToString().ToLowerInvariant()} can't be read ({error.Kind}: {error.Message.TrimEnd('.')}); pages keep what was read before (if anything), retrying with backoff.");
                else
                    _logger?.Info($"Arr state: {name} {kind.ToString().ToLowerInvariant()} can be read again.");
            }
            state.Library.HealthChanged += Log;
            state.Queue.HealthChanged += Log;
            state.History.HealthChanged += Log;
            state.Calendar.HealthChanged += Log;
            state.System.HealthChanged += Log;
            return state;
        }

        private TimeSpan ColdWait(ArrSnapshotKind kind) => PolicyFor(kind, null, _now()).ColdWait;

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
                        MaxServe: kind == ArrSnapshotKind.Queue ? TimeSpan.FromMinutes(10) : TimeSpan.FromMinutes(30),
                        Interest: TimeSpan.FromMinutes(15),
                        ColdWait: TimeSpan.FromSeconds(15));
                }
                case ArrSnapshotKind.Calendar:
                    return new Policy(TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15), TimeSpan.FromHours(6), TimeSpan.FromHours(1), TimeSpan.FromSeconds(15));
                case ArrSnapshotKind.System:
                    return new Policy(TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5), TimeSpan.FromHours(1), TimeSpan.FromMinutes(15), TimeSpan.FromSeconds(10));
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
                if (cache == null || cache.Version != 1 || cache.Fingerprint != Fingerprint(state.Client.Connection)) return;
                state.Library.Seed(new ArrLibrarySnapshot(cache.Movies ?? new List<ArrMovieEntry>(), cache.Series ?? new List<ArrSeriesEntry>(), cache.Tags ?? new Dictionary<int, string>()), cache.SavedAt);
                state.LastCacheWrite = cache.SavedAt;
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                _logger?.Warning($"Arr state: ignoring the cached library of {state.Client.Connection.Name} ({ex.GetType().Name}); it is read again from the instance.");
            }
        }

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
                Directory.CreateDirectory(_cacheDirectory!);
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using (var stream = new FileStream(temp, options))
                {
                    JsonSerializer.Serialize(stream, new LibraryCacheFile
                    {
                        Version = 1,
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
                Library = new ArrSnapshotSlot<ArrLibrarySnapshot>(ArrSnapshotKind.Library, (_, ct) => ArrStateLoaders.LoadLibraryAsync(client, ct));
                Queue = new ArrSnapshotSlot<ArrQueueSnapshot>(ArrSnapshotKind.Queue, (_, ct) => ArrStateLoaders.LoadQueueAsync(client, ct));
                History = new ArrSnapshotSlot<ArrHistorySnapshot>(ArrSnapshotKind.History, (prev, ct) => ArrStateLoaders.LoadHistoryAsync(client, prev, store._now(), ct));
                Calendar = new ArrSnapshotSlot<ArrCalendarSnapshot>(ArrSnapshotKind.Calendar, (_, ct) =>
                {
                    var (start, end) = ArrStateLoaders.CalendarWindow(store._now());
                    return ArrStateLoaders.LoadCalendarAsync(client, start, end, ct);
                });
                System = new ArrSnapshotSlot<ArrSystemSnapshot>(ArrSnapshotKind.System, (_, ct) => ArrStateLoaders.LoadSystemAsync(client, ct));
                Slots = new IArrSnapshotSlot[] { Library, Queue, History, Calendar, System };
                Ranges = new CalendarRangeCache(client, store._backgroundCalls, store._now, store._shutdown.Token);
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
            private readonly object _lock = new();
            private readonly Dictionary<(DateTime, DateTime), Entry> _entries = new();

            public CalendarRangeCache(ArrClient client, ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown)
            {
                _client = client;
                _background = background;
                _now = now;
                _shutdown = shutdown;
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
                using (ExecutionContext.SuppressFlow())
                {
                    // Not part of any request's flow: background calls, never the request's counter.
                    entry.Task = Task.Run(() => LoadAsync(from, to, cancel.Token));
                }
                entry.Task.ContinueWith(
                    _ =>
                    {
                        lock (_lock)
                        {
                            entry.FinishedAt = _now();
                            entry.Disposed = true;
                            cancel.Dispose();
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.None,
                    TaskScheduler.Default);
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
    }
}
