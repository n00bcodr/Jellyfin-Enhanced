using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>A search an arr is running for some titles (from its <c>command</c> messages).</summary>
    public sealed class ArrSearchActivity
    {
        /// <summary>The arr's command id.</summary>
        [JsonPropertyName("commandId")]
        public int CommandId { get; init; }

        /// <summary>Command name (MoviesSearch, SeriesSearch, SeasonSearch, EpisodeSearch, ...).</summary>
        [JsonPropertyName("name")]
        public string Name { get; init; } = string.Empty;

        /// <summary>queued or started.</summary>
        [JsonPropertyName("status")]
        public string Status { get; init; } = string.Empty;

        /// <summary>Radarr movie ids or the Sonarr series id it searches for.</summary>
        [JsonPropertyName("titleIds")]
        public IReadOnlyList<int> TitleIds { get; init; } = Array.Empty<int>();

        /// <summary>When JE first saw it.</summary>
        [JsonPropertyName("since")]
        public DateTimeOffset Since { get; init; }
    }

    /// <summary>
    /// Runs one SignalR connection per usable Sonarr/Radarr instance while phase 1 is on (and the
    /// instance's live updates aren't switched off), and turns their messages into re-reads:
    /// <list type="bullet">
    /// <item><description><c>queue</c>, <c>queue/details</c>, <c>queue/status</c> → queue refresh;</description></item>
    /// <item><description><c>movie</c>/<c>series</c> updated or deleted → the library index is patched with the resource;</description></item>
    /// <item><description><c>moviefile</c>/<c>episodefile</c> → the title is re-read, history refreshed;</description></item>
    /// <item><description><c>episode</c> (Sonarr grab hint), <c>calendar</c>, <c>wanted/*</c> → queue + history (Radarr grabs are
    /// learnt this way and from the queue, never from a <c>movie</c> message);</description></item>
    /// <item><description><c>health</c>, <c>rootfolder</c>, <c>qualityprofile</c> → system facts; <c>command</c> → running searches.</description></item>
    /// </list>
    /// Every (re)connect re-reads the queue, history and library (the arrs don't replay what was
    /// missed; library reads are spaced by <see cref="ArrLiveTiming.LibraryResyncGap"/>). The service follows configuration changes within a few seconds.
    /// </summary>
    public sealed class ArrLiveService : IHostedService, IDisposable
    {
        private static readonly TimeSpan ReconcileInterval = TimeSpan.FromSeconds(5);
        private static readonly TimeSpan SearchTtl = TimeSpan.FromMinutes(30);
        private const int MaxSearchesPerInstance = 50;

        private static readonly HashSet<string> SearchCommands = new(StringComparer.OrdinalIgnoreCase)
        {
            "MoviesSearch", "MovieSearch", "SeriesSearch", "SeasonSearch", "EpisodeSearch",
        };

        private readonly ArrStateStore _store;
        private readonly ArrLiveRouter _router;
        private readonly ArrChangeTracker _tracker;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly ArrLiveTiming _timing;
        private readonly Func<DateTimeOffset> _now;
        private readonly ArrSocketConnector? _connectorOverride;
        private readonly ConcurrentDictionary<string, ArrSignalRConnection> _connections = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, DateTimeOffset> _libraryResyncAt = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, byte> _libraryResyncDeferred = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<int, ArrSearchActivity>> _searches = new(StringComparer.OrdinalIgnoreCase);
        private readonly SemaphoreSlim _reconcileGate = new(1, 1);
        private HttpMessageInvoker? _invoker;
        private CancellationTokenSource? _stop;
        private Task? _loop;

        /// <summary>Creates the service (DI).</summary>
        public ArrLiveService(ArrStateStore store, ArrLiveRouter router, ArrChangeTracker tracker, Logger logger)
            : this(store, router, tracker, logger, () => JellyfinEnhanced.Instance?.Configuration, null, null, null)
        {
        }

        /// <summary>Creates the service with explicit parts (tests).</summary>
        internal ArrLiveService(ArrStateStore store, ArrLiveRouter router, ArrChangeTracker tracker, Logger? logger, Func<PluginConfiguration?> config, ArrSocketConnector? connector, ArrLiveTiming? timing, Func<DateTimeOffset>? now)
        {
            _store = store;
            _router = router;
            _tracker = tracker;
            _logger = logger;
            _config = config;
            _connectorOverride = connector;
            _timing = timing ?? ArrLiveTiming.Default;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _stop = new CancellationTokenSource();
            var token = _stop.Token;
            _loop = Task.Run(() => RunAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            _stop?.Cancel();
            if (_loop != null)
            {
                try
                {
                    await _loop.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // stopping
                }
            }
            await Task.WhenAll(_connections.Values.Select(c => c.StopAsync())).ConfigureAwait(false);
            foreach (var c in _connections.Values) c.Dispose();
            _connections.Clear();
        }

        /// <inheritdoc />
        public void Dispose()
        {
            _stop?.Dispose();
            _invoker?.Dispose();
            _reconcileGate.Dispose();
        }

        /// <summary>The live connection state of an instance (Off when none runs).</summary>
        public ArrLiveConnectionStatus ConnectionStatus(string instanceId)
            => _connections.TryGetValue(instanceId, out var c) ? c.Status() : new ArrLiveConnectionStatus { State = ArrLiveState.Off };

        /// <summary>Searches the instance is running right now, as its SignalR messages report them.</summary>
        public IReadOnlyList<ArrSearchActivity> ActiveSearches(string instanceId)
        {
            if (!_searches.TryGetValue(instanceId, out var map)) return Array.Empty<ArrSearchActivity>();
            var now = _now();
            return map.Values.Where(s => now - s.Since < SearchTtl).OrderBy(s => s.Since).ToList();
        }

        /// <summary>
        /// Starts connections for usable instances that should have one and stops the rest (phase 1
        /// off, live updates off, instance removed or disabled, URL or key changed).
        /// </summary>
        internal async Task ReconcileAsync()
        {
            await _reconcileGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var wanted = new Dictionary<string, (ArrConnection Connection, string Key, string Fingerprint)>(StringComparer.OrdinalIgnoreCase);
                if (ArrLiveFlags.Enabled(_config()))
                {
                    foreach (var kind in Enum.GetValues<ArrKind>())
                    {
                        foreach (var c in _store.Instances(kind))
                        {
                            if (string.Equals(c.LiveUpdates, "off", StringComparison.OrdinalIgnoreCase)) continue;
                            var key = _store.Registry.ResolveApiKey(c);
                            if (string.IsNullOrEmpty(key)) continue;
                            wanted[c.Id] = (c, key, Fingerprint(c, key));
                        }
                    }
                }

                foreach (var (id, running) in _connections)
                {
                    if (wanted.TryGetValue(id, out var w) && w.Fingerprint == running.Fingerprint) continue;
                    if (_connections.TryRemove(id, out var gone))
                    {
                        await gone.StopAsync().ConfigureAwait(false);
                        gone.Dispose();
                        _searches.TryRemove(id, out _);
                    }
                }

                foreach (var (id, w) in wanted)
                {
                    if (_connections.ContainsKey(id)) continue;
                    var connection = new ArrSignalRConnection(w.Connection, w.Key, w.Fingerprint, Connector(), HandleMessage, OnConnected, _logger, _timing, _now);
                    if (_connections.TryAdd(id, connection)) connection.Start();
                    else connection.Dispose();
                }
            }
            finally
            {
                _reconcileGate.Release();
            }
        }

        /// <summary>Handles one hub message of an instance (internal for tests).</summary>
        internal void HandleMessage(ArrConnection instance, ArrHubMessage message)
        {
            var id = instance.Id;
            switch (message.Name.ToLowerInvariant())
            {
                case "queue":
                case "queue/details":
                case "queue/status":
                    _router.Hint(id, ArrLiveKinds.Queue);
                    break;
                case "movie":
                    if (instance.Kind == ArrKind.Radarr) PatchTitle(instance, message);
                    break;
                case "series":
                    if (instance.Kind == ArrKind.Sonarr) PatchTitle(instance, message);
                    break;
                case "moviefile":
                case "episodefile":
                {
                    var titleId = message.HasResource ? Int(message.Resource, instance.Kind == ArrKind.Radarr ? "movieId" : "seriesId") : null;
                    _router.Hint(id, ArrLiveKinds.History | ArrLiveKinds.Queue, titleId is > 0 ? new[] { titleId.Value } : null);
                    break;
                }
                case "episode":
                case "calendar":
                case "wanted/missing":
                case "wanted/cutoff":
                    _router.Hint(id, ArrLiveKinds.Queue | ArrLiveKinds.History);
                    break;
                case "health":
                case "rootfolder":
                case "qualityprofile":
                    _router.Hint(id, ArrLiveKinds.System);
                    break;
                case "tag":
                    _router.Hint(id, ArrLiveKinds.Library);
                    break;
                case "command":
                    TrackCommand(instance, message);
                    break;
            }
        }

        // Every connect re-reads what the arr may have changed while JE wasn't listening (the arrs
        // don't replay): queue and history at once, the library too (at most once per
        // LibraryResyncGap; a reconnect inside the gap gets its library read when the gap ends).
        private void OnConnected(ArrConnection instance, bool first, TimeSpan downFor)
        {
            var kinds = ArrLiveKinds.Queue | ArrLiveKinds.History;
            var now = _now();
            var gap = _timing.LibraryResyncGap;
            if (!_libraryResyncAt.TryGetValue(instance.Id, out var last) || now - last >= gap)
            {
                _libraryResyncAt[instance.Id] = now;
                kinds |= ArrLiveKinds.Library;
            }
            else if (_libraryResyncDeferred.TryAdd(instance.Id, 0))
            {
                var due = last + gap - now;
                var token = StopToken();
                using (ExecutionContext.SuppressFlow())
                {
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            await Task.Delay(due, token).ConfigureAwait(false);
                            // Live updates may have been switched off meanwhile: no read then.
                            if (!StillLive(instance.Id)) return;
                            _libraryResyncAt[instance.Id] = _now();
                            _router.Hint(instance.Id, ArrLiveKinds.Library, null, force: true);
                        }
                        catch (OperationCanceledException)
                        {
                            // stopping
                        }
                        finally
                        {
                            _libraryResyncDeferred.TryRemove(instance.Id, out _);
                        }
                    });
                }
            }
            _router.Hint(instance.Id, kinds, null, force: true);
        }

        // Phase 1 is still on and the instance still has a live connection with live updates on.
        private bool StillLive(string instanceId)
            => ArrLiveFlags.Enabled(_config())
               && _connections.ContainsKey(instanceId)
               && _store.Registry.Get(instanceId) is { } c
               && c.Usable
               && !string.Equals(c.LiveUpdates, "off", StringComparison.OrdinalIgnoreCase);

        private CancellationToken StopToken()
        {
            try
            {
                return _stop?.Token ?? CancellationToken.None;
            }
            catch (ObjectDisposedException)
            {
                return new CancellationToken(true);
            }
        }

        private void PatchTitle(ArrConnection instance, ArrHubMessage message)
        {
            if (!message.HasResource) return;
            var arrId = Int(message.Resource, "id");
            if (arrId is not > 0) return;
            if (string.Equals(message.Action, "deleted", StringComparison.OrdinalIgnoreCase))
            {
                _store.PatchLibrary(instance.Id, Array.Empty<ArrMovieEntry>(), Array.Empty<ArrSeriesEntry>(), new[] { arrId.Value });
                return;
            }
            if (!string.Equals(message.Action, "updated", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(message.Action, "created", StringComparison.OrdinalIgnoreCase)) return;
            var library = _store.PeekLibrary(instance.Id);
            if (library == null) return;
            try
            {
                if (instance.Kind == ArrKind.Radarr)
                {
                    var wire = message.Resource.Deserialize<ArrWireMovie>(ArrClient.JsonOptions);
                    if (wire == null || wire.Id <= 0) return;
                    _store.PatchLibrary(instance.Id, new[] { ArrStateLoaders.MergeMovie(library.MovieById(wire.Id), wire) }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>());
                }
                else
                {
                    var wire = message.Resource.Deserialize<ArrWireSeries>(ArrClient.JsonOptions);
                    if (wire == null || wire.Id <= 0) return;
                    _store.PatchLibrary(instance.Id, Array.Empty<ArrMovieEntry>(), new[] { ArrStateLoaders.MergeSeries(library.SeriesById(wire.Id), wire) }, Array.Empty<int>());
                }
            }
            catch (JsonException)
            {
                // A resource JE can't read: let the next library refresh bring it.
                _router.Hint(instance.Id, ArrLiveKinds.None, new[] { arrId.Value });
            }
        }

        private void TrackCommand(ArrConnection instance, ArrHubMessage message)
        {
            if (!message.HasResource) return;
            var r = message.Resource;
            var commandId = Int(r, "id");
            var name = Str(r, "name") ?? Str(r, "commandName") ?? string.Empty;
            name = name.Replace(" ", string.Empty, StringComparison.Ordinal);
            if (commandId is not > 0 || !SearchCommands.Contains(name)) return;
            var status = (Str(r, "status") ?? string.Empty).ToLowerInvariant();
            var titleIds = new List<int>();
            if (r.TryGetProperty("body", out var body) && body.ValueKind == JsonValueKind.Object)
            {
                if (Int(body, "seriesId") is > 0 and var sid) titleIds.Add(sid);
                if (body.TryGetProperty("movieIds", out var ids) && ids.ValueKind == JsonValueKind.Array)
                {
                    foreach (var e in ids.EnumerateArray().Take(100))
                    {
                        if (e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var v) && v > 0) titleIds.Add(v);
                    }
                }
            }

            var map = _searches.GetOrAdd(instance.Id, _ => new ConcurrentDictionary<int, ArrSearchActivity>());
            var active = status is "queued" or "started";
            bool changed;
            if (active)
            {
                var existed = map.TryGetValue(commandId.Value, out var previous);
                changed = !existed || previous!.Status != status;
                if (map.Count >= MaxSearchesPerInstance && !existed) PruneSearches(map);
                map[commandId.Value] = new ArrSearchActivity { CommandId = commandId.Value, Name = name, Status = status, TitleIds = titleIds, Since = previous?.Since ?? _now() };
            }
            else
            {
                changed = map.TryRemove(commandId.Value, out _);
                // A finished search may have grabbed something.
                _router.Hint(instance.Id, ArrLiveKinds.Queue | ArrLiveKinds.History);
            }
            if (changed && titleIds.Count > 0) _tracker.BumpTitles(instance.Id, titleIds);
        }

        private void PruneSearches(ConcurrentDictionary<int, ArrSearchActivity> map)
        {
            var now = _now();
            foreach (var old in map.Values.Where(s => now - s.Since >= SearchTtl).ToList()) map.TryRemove(old.CommandId, out _);
            while (map.Count >= MaxSearchesPerInstance)
            {
                var oldest = map.Values.OrderBy(s => s.Since).First();
                map.TryRemove(oldest.CommandId, out _);
            }
        }

        private async Task RunAsync(CancellationToken stop)
        {
            using var timer = new PeriodicTimer(ReconcileInterval);
            try
            {
                do
                {
                    try
                    {
                        await ReconcileAsync().ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger?.Warning($"Arr live: {ex.GetType().Name} while updating live connections.");
                    }
                }
                while (await timer.WaitForNextTickAsync(stop).ConfigureAwait(false));
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }

        private ArrSocketConnector Connector()
        {
            if (_connectorOverride != null) return _connectorOverride;
            if (_invoker == null)
            {
                var handler = ArrHttp.CreateHandler();
                handler.AutomaticDecompression = System.Net.DecompressionMethods.None;
                Interlocked.CompareExchange(ref _invoker, new HttpMessageInvoker(handler, disposeHandler: true), null);
            }
            return ArrSignalRConnection.CreateConnector(_invoker!);
        }

        private static string Fingerprint(ArrConnection c, string key)
            => c.Kind + "|" + c.Url.Trim().TrimEnd('/') + "|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 8);

        private static int? Int(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

        private static string? Str(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }
}
