using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

/// <summary>
/// Live updates (phase 1): the SignalR hub client against an in-process fake hub (handshake,
/// messages split across frames, pings, reconnect with backoff, resync on connect, no key in the
/// URL or the log), message handling (patches and targeted re-reads), the change detector and
/// feed (ordering, resets, waits), coalescing of hints, and Jellyfin library events.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrLiveTests
{
    private const string RadarrKey = "RADARR-LIVE-KEY-0123456789abcdef";
    private const string SonarrKey = "SONARR-LIVE-KEY-0123456789abcdef";
    private static readonly ArrLiveTiming Fast = new(TimeSpan.FromMilliseconds(40), TimeSpan.FromMilliseconds(400), TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));

    // ---------------------------------------------------------------- fake hub

    /// <summary>An in-process SignalR hub: each connect gets a real loopback WebSocket pair.</summary>
    private sealed class FakeHub : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        public List<(Uri Uri, string Key)> Connects { get; } = new();
        public Channel<HubPeer> Peers { get; } = Channel.CreateUnbounded<HubPeer>();
        /// <summary>Non-null: attempt n (1-based) throws this instead of connecting.</summary>
        public Func<int, Exception?>? Fail { get; set; }

        public FakeHub() => listener.Start();

        public ArrSocketConnector Connector => async (uri, key, ct) =>
        {
            int attempt;
            lock (Connects) { Connects.Add((uri, key)); attempt = Connects.Count; }
            if (Fail?.Invoke(attempt) is { } error) throw error;
            var client = new TcpClient();
            var accept = listener.AcceptTcpClientAsync(ct).AsTask();
            await client.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port, ct);
            var server = await accept;
            var clientSocket = WebSocket.CreateFromStream(client.GetStream(), new WebSocketCreationOptions { IsServer = false, KeepAliveInterval = TimeSpan.Zero });
            var serverSocket = WebSocket.CreateFromStream(server.GetStream(), new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.Zero });
            Peers.Writer.TryWrite(new HubPeer(serverSocket, server, client));
            return clientSocket;
        };

        public async Task<HubPeer> NextAsync()
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            return await Peers.Reader.ReadAsync(cts.Token);
        }

        public void Dispose() => listener.Stop();
    }

    /// <summary>The server end of one connection.</summary>
    private sealed class HubPeer(WebSocket socket, TcpClient server, TcpClient client)
    {
        public WebSocket Socket { get; } = socket;
        private readonly StringBuilder pending = new();

        public Task SendAsync(string text) => Socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

        public static string Message(string name, string action, object? resource = null)
        {
            var body = new JsonObject { ["action"] = action };
            if (resource != null) body["resource"] = JsonSerializer.SerializeToNode(resource);
            return new JsonObject { ["type"] = 1, ["target"] = "receiveMessage", ["arguments"] = new JsonArray(new JsonObject { ["body"] = body, ["name"] = name }) }.ToJsonString() + "\u001e";
        }

        /// <summary>The next complete record the client sent.</summary>
        public async Task<string> ReceiveRecordAsync()
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var buffer = new byte[4096];
            while (true)
            {
                var text = pending.ToString();
                var end = text.IndexOf('\u001e');
                if (end >= 0)
                {
                    pending.Remove(0, end + 1);
                    return text[..end];
                }
                var r = await Socket.ReceiveAsync(buffer, cts.Token);
                if (r.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("closed");
                pending.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
            }
        }

        /// <summary>Completes the handshake (and announces the version, as the arrs do).</summary>
        public async Task AcceptAsync(string version = "6.0.4.10291")
        {
            Assert.Equal("{\"protocol\":\"json\",\"version\":1}", await ReceiveRecordAsync());
            await SendAsync("{}\u001e" + Message("version", "", null).Replace("\"action\":\"\"", "\"version\":\"" + version + "\""));
        }

        public void Drop()
        {
            server.Close();
            client.Close();
        }
    }

    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Sonarr { get; }
        public ArrStateStore Store { get; }
        public ArrChangeFeed Feed { get; } = new();
        public ArrLiveRouter Router { get; }
        public ArrChangeTracker Tracker { get; }
        public ArrConnection RadarrConn => Arr.Instance("Movies");
        public ArrConnection SonarrConn => Arr.Instance("TV");

        public Rig()
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Radarr.Movies.Add(FakeArr.Movie(1, 101, "Alpha", hasFile: false));
            Radarr.Movies.Add(FakeArr.Movie(2, 102, "Beta"));
            Sonarr.Series.Add(FakeArr.SeriesRow(7, 700, "Show"));
            Arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", RadarrKey), ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", SonarrKey));
            var config = Arr.Plugin.Plugin.Configuration;
            config.ArrIntegrationEnabled = true;
            config.ArrPhase1Enabled = true;
            Arr.Now = DateTimeOffset.UtcNow;
            Store = Arr.Store();
            Router = new ArrLiveRouter(Store, Arr.Plugin.Core.Logger, TimeSpan.FromMilliseconds(10));
            Tracker = new ArrChangeTracker(Store, Feed, Router, null, Arr.Plugin.Core.Logger, () => Arr.Plugin.Plugin.Configuration);
            Tracker.Start();
        }

        public ArrLiveService Service(FakeHub hub, ArrLiveTiming? timing = null) => new(Store, Router, Tracker, Arr.Plugin.Core.Logger, () => Arr.Plugin.Plugin.Configuration, hub.Connector, timing ?? Fast, null);

        public async Task LoadAsync(ArrConnection c, params ArrSnapshotKind[] kinds)
        {
            foreach (var k in kinds)
            {
                switch (k)
                {
                    case ArrSnapshotKind.Library: Assert.NotNull((await Store.GetLibraryAsync(c, default)).Value); break;
                    case ArrSnapshotKind.Queue: Assert.NotNull((await Store.GetQueueAsync(c, default)).Value); break;
                    case ArrSnapshotKind.History: Assert.NotNull((await Store.GetHistoryAsync(c, default)).Value); break;
                }
            }
        }

        public string Log() => string.Join("\n", Directory.GetFiles(Arr.Plugin.Core.Root, "JellyfinEnhanced_*.log").Select(File.ReadAllText));

        public void Dispose() => Arr.Dispose();
    }

    private static async Task Until(Func<bool> condition, int timeoutMs = 10000)
    {
        var start = DateTime.UtcNow;
        while (!condition())
        {
            if ((DateTime.UtcNow - start).TotalMilliseconds > timeoutMs) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }

    // ---------------------------------------------------------------- protocol

    [Fact]
    public void HubRecordsAreSplitOnTheSeparatorAndPartialTailsKept()
    {
        var buffer = new StringBuilder("{}\u001e{\"type\":6}\u001e{\"type\":1,");
        Assert.Equal(new[] { "{}", "{\"type\":6}" }, ArrHubProtocol.TakeRecords(buffer));
        Assert.Equal("{\"type\":1,", buffer.ToString());
        buffer.Append("\"target\":\"receiveMessage\",\"arguments\":[{\"body\":{\"action\":\"sync\"},\"name\":\"queue\"}]}\u001e");
        var record = Assert.Single(ArrHubProtocol.TakeRecords(buffer));
        Assert.Equal(0, buffer.Length);
        var (type, message, _) = ArrHubProtocol.Parse(record);
        Assert.Equal(1, type);
        Assert.Equal(("queue", "sync", false), (message!.Name, message.Action, message.HasResource));

        Assert.Equal((0, (ArrHubMessage?)null, (string?)null), ArrHubProtocol.Parse("{}"));
        Assert.Equal("bad", ArrHubProtocol.Parse("{\"error\":\"bad\"}").Error);
        Assert.Equal(6, ArrHubProtocol.Parse("{\"type\":6}").Type);
        Assert.Equal(7, ArrHubProtocol.Parse("{\"type\":7,\"error\":\"x\"}").Type);
        Assert.Equal(-1, ArrHubProtocol.Parse("not json").Type);
        Assert.Equal(-1, ArrHubProtocol.Parse("{\"type\":\"1\"}").Type);
        Assert.Null(ArrHubProtocol.Parse("{\"type\":1,\"target\":\"other\",\"arguments\":[]}").Message);
    }

    [Fact]
    public void TheHubAddressComesFromTheInstanceUrlAndNeverCarriesTheKey()
    {
        Assert.Equal("ws://radarr.lan:7878/signalr/messages", ArrSignalRConnection.HubUri("http://radarr.lan:7878/")!.ToString());
        Assert.Equal("wss://arr.example/radarr/signalr/messages", ArrSignalRConnection.HubUri("https://arr.example/radarr")!.ToString());
        Assert.Null(ArrSignalRConnection.HubUri("ftp://radarr.lan"));
        Assert.Null(ArrSignalRConnection.HubUri("http://169.254.169.254"));
    }

    // ---------------------------------------------------------------- connection

    [Fact]
    public async Task TheConsumerHandshakesForwardsMessagesAcrossFramesAndPings()
    {
        using var hub = new FakeHub();
        var messages = Channel.CreateUnbounded<ArrHubMessage>();
        var connected = new List<bool>();
        var conn = new ArrSignalRConnection(new ArrConnection { Id = "i1", Name = "Movies", Kind = ArrKind.Radarr, Url = "http://radarr.lan:7878" }, RadarrKey, "fp",
            hub.Connector, (_, m) => messages.Writer.TryWrite(m), (_, first, _) => { lock (connected) connected.Add(first); }, null, Fast);
        conn.Start();
        try
        {
            var peer = await hub.NextAsync();
            Assert.Equal("ws://radarr.lan:7878/signalr/messages", hub.Connects[0].Uri.ToString());
            Assert.Equal(RadarrKey, hub.Connects[0].Key);
            await peer.AcceptAsync();
            await Until(() => conn.Status().State == ArrLiveState.Connected && conn.Status().Version == "6.0.4.10291");
            Assert.Equal(new[] { true }, connected);

            // One message split over two frames, then a ping and two messages in one frame.
            var queue = HubPeer.Message("queue", "sync");
            await peer.SendAsync(queue[..20]);
            await peer.SendAsync(queue[20..] + "{\"type\":6}\u001e" + HubPeer.Message("movie", "updated", new { id = 1, hasFile = true }) + HubPeer.Message("health", "sync"));
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var got = new List<ArrHubMessage>();
            while (got.Count < 4) got.Add(await messages.Reader.ReadAsync(cts.Token));
            Assert.Equal(new[] { "version", "queue", "movie", "health" }, got.Select(m => m.Name));
            Assert.True(got[2].HasResource);
            Assert.Equal(4, conn.Status().Messages);

            // JE pings the hub (the protocol's keep-alive).
            Assert.Equal("{\"type\":6}", await peer.ReceiveRecordAsync());
        }
        finally
        {
            await conn.StopAsync();
        }
        Assert.Equal(ArrLiveState.Off, conn.Status().State);
    }

    [Fact]
    public async Task ADroppedConnectionReconnectsWithBackoffAndEveryConnectIsReported()
    {
        using var hub = new FakeHub();
        var connects = new List<(bool First, TimeSpan Down)>();
        var conn = new ArrSignalRConnection(new ArrConnection { Id = "i1", Name = "Movies", Kind = ArrKind.Radarr, Url = "http://radarr.lan:7878" }, RadarrKey, "fp",
            hub.Connector, (_, _) => { }, (_, first, down) => { lock (connects) connects.Add((first, down)); }, null, Fast);
        conn.Start();
        try
        {
            var first = await hub.NextAsync();
            await first.AcceptAsync();
            await Until(() => conn.Status().State == ArrLiveState.Connected);
            first.Drop();
            var second = await hub.NextAsync();
            await second.AcceptAsync();
            await Until(() => conn.Status().State == ArrLiveState.Connected && conn.Status().Reconnects == 1);
            lock (connects)
            {
                Assert.Equal(new[] { true, false }, connects.Select(c => c.First));
                Assert.True(connects[1].Down > TimeSpan.Zero);
            }
            // A clean close (type 7) also reconnects.
            await second.SendAsync("{\"type\":7}\u001e");
            var third = await hub.NextAsync();
            await third.AcceptAsync();
            await Until(() => conn.Status().Reconnects == 2);
        }
        finally
        {
            await conn.StopAsync();
        }
    }

    [Fact]
    public async Task FailedAttemptsBackOffReportAPlainReasonAndNeverLogTheKey()
    {
        using var rig = new Rig();
        using var hub = new FakeHub { Fail = n => n <= 3 ? new ArrLiveConnectException("The API key was rejected.") : null };
        var times = new List<DateTime>();
        var connector = hub.Connector;
        ArrSocketConnector timed = (uri, key, ct) => { lock (times) times.Add(DateTime.UtcNow); return connector(uri, key, ct); };
        var conn = new ArrSignalRConnection(rig.RadarrConn, RadarrKey, "fp", timed, (_, _) => { }, (_, _, _) => { }, rig.Arr.Plugin.Core.Logger, Fast);
        conn.Start();
        try
        {
            await Until(() => conn.Status().FailuresInARow >= 2);
            var status = conn.Status();
            Assert.Equal(ArrLiveState.Waiting, status.State);
            Assert.Equal("The API key was rejected.", status.LastError);
            Assert.NotNull(status.NextAttemptAt);
            var peer = await hub.NextAsync();
            await peer.AcceptAsync();
            await Until(() => conn.Status().State == ArrLiveState.Connected);
            Assert.Null(conn.Status().LastError);
            lock (times)
            {
                // 40 ms, 80 ms, 160 ms (±20 %): each wait is longer than the one before.
                var gaps = times.Zip(times.Skip(1), (a, b) => (b - a).TotalMilliseconds).ToList();
                Assert.True(gaps[1] > gaps[0] && gaps[2] > gaps[1], string.Join(",", gaps));
            }
        }
        finally
        {
            await conn.StopAsync();
        }
        var log = rig.Log();
        Assert.Contains("Movies live updates unavailable (The API key was rejected)", log);
        Assert.Single(log.Split('\n'), l => l.Contains("live updates unavailable"));   // one line per outage
        Assert.DoesNotContain(RadarrKey, log);
    }

    [Fact]
    public async Task AHandshakeRefusalIsAFailureNotAConnection()
    {
        using var hub = new FakeHub();
        var connected = 0;
        var conn = new ArrSignalRConnection(new ArrConnection { Id = "i1", Name = "Movies", Kind = ArrKind.Radarr, Url = "http://radarr.lan:7878" }, RadarrKey, "fp",
            hub.Connector, (_, _) => { }, (_, _, _) => Interlocked.Increment(ref connected), null, Fast);
        conn.Start();
        try
        {
            var peer = await hub.NextAsync();
            await peer.ReceiveRecordAsync();
            await peer.SendAsync("{\"error\":\"Requested protocol 'json' is not available.\"}\u001e");
            await Until(() => conn.Status().FailuresInARow >= 1);
            Assert.Equal("The instance refused the live-updates handshake.", conn.Status().LastError);
            Assert.Equal(0, connected);
        }
        finally
        {
            await conn.StopAsync();
        }
    }

    // ---------------------------------------------------------------- service

    [Fact]
    public async Task ConnectionsFollowTheSwitchesTheInstanceSettingAndKeyChanges()
    {
        using var rig = new Rig();
        using var hub = new FakeHub();
        using var service = rig.Service(hub);
        var config = rig.Arr.Plugin.Plugin.Configuration;
        try
        {
            config.ArrPhase1Enabled = false;
            await service.ReconcileAsync();
            Assert.Empty(hub.Connects);
            Assert.Equal(ArrLiveState.Off, service.ConnectionStatus(rig.RadarrConn.Id).State);

            config.ArrPhase1Enabled = true;
            await service.ReconcileAsync();
            await Until(() => hub.Connects.Count == 2);
            Assert.Equal(new[] { RadarrKey, SonarrKey }.OrderBy(k => k), hub.Connects.Select(c => c.Key).OrderBy(k => k));

            // Live updates off for one instance: its connection stops; the other stays.
            var rows = ArrRegistryMigration.Parse(config.SonarrInstances)!;
            rows[0].LiveUpdates = "off";
            config.SonarrInstances = ArrRegistryMigration.Serialize(rows);
            await service.ReconcileAsync();
            Assert.Equal(ArrLiveState.Off, service.ConnectionStatus(rig.SonarrConn.Id).State);
            Assert.NotEqual(ArrLiveState.Off, service.ConnectionStatus(rig.RadarrConn.Id).State);

            // A new URL means a new connection.
            var radarr = ArrRegistryMigration.Parse(config.RadarrInstances)!;
            radarr[0].Url = "http://radarr2.lan:7878";
            config.RadarrInstances = ArrRegistryMigration.Serialize(radarr);
            await service.ReconcileAsync();
            await Until(() => hub.Connects.Any(c => c.Uri.Host == "radarr2.lan"));

            config.ArrIntegrationEnabled = false;
            await service.ReconcileAsync();
            Assert.Equal(ArrLiveState.Off, service.ConnectionStatus(rig.RadarrConn.Id).State);
        }
        finally
        {
            await service.StopAsync(default);
        }
    }

    [Fact]
    public async Task EveryConnectResyncsQueueHistoryAndLibraryEvenAfterABriefDrop()
    {
        using var rig = new Rig();
        using var hub = new FakeHub();
        using var service = rig.Service(hub, Fast with { LibraryResyncGap = TimeSpan.FromMilliseconds(300) });
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library, ArrSnapshotKind.Queue, ArrSnapshotKind.History);
        rig.Arr.Plugin.Plugin.Configuration.SonarrInstances = "[]";
        var before = (Queue: rig.Arr.CallCount("radarr.lan", "/queue"), History: rig.Arr.CallCount("radarr.lan", "/history"), Library: rig.Arr.CallCount("radarr.lan", "/api/v3/movie"));
        try
        {
            await service.ReconcileAsync();
            var peer = await hub.NextAsync();
            await peer.AcceptAsync();
            await Until(() => rig.Arr.CallCount("radarr.lan", "/queue") > before.Queue
                && rig.Arr.CallCount("radarr.lan", "/history") > before.History
                && rig.Arr.CallCount("radarr.lan", "/api/v3/movie") > before.Library);

            // A drop of a moment: whatever changed in the library meanwhile (a title unmonitored, a
            // profile changed: nothing a queue or history read shows) is read again too, once the
            // gap since the last library read is over.
            var library = rig.Arr.CallCount("radarr.lan", "/api/v3/movie");
            var queue = rig.Arr.CallCount("radarr.lan", "/queue");
            peer.Drop();
            var again = await hub.NextAsync();
            await again.AcceptAsync();
            await Until(() => rig.Arr.CallCount("radarr.lan", "/queue") > queue);
            await Until(() => rig.Arr.CallCount("radarr.lan", "/api/v3/movie") > library);
        }
        finally
        {
            await service.StopAsync(default);
        }
    }

    [Fact]
    public async Task ADeferredLibraryResyncIsDroppedWhenLiveUpdatesAreSwitchedOffMeanwhile()
    {
        using var rig = new Rig();
        using var hub = new FakeHub();
        var gap = TimeSpan.FromMilliseconds(800);
        using var service = rig.Service(hub, Fast with { LibraryResyncGap = gap });
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library, ArrSnapshotKind.Queue, ArrSnapshotKind.History);
        rig.Arr.Plugin.Plugin.Configuration.SonarrInstances = "[]";
        var library = rig.Arr.CallCount("radarr.lan", "/api/v3/movie");
        try
        {
            await service.ReconcileAsync();
            var peer = await hub.NextAsync();
            await peer.AcceptAsync();
            await Until(() => rig.Arr.CallCount("radarr.lan", "/api/v3/movie") > library);

            // A drop inside the gap defers the library read; phase 1 is then switched off.
            library = rig.Arr.CallCount("radarr.lan", "/api/v3/movie");
            var queue = rig.Arr.CallCount("radarr.lan", "/queue");
            peer.Drop();
            var again = await hub.NextAsync();
            await again.AcceptAsync();
            await Until(() => rig.Arr.CallCount("radarr.lan", "/queue") > queue);
            rig.Arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = false;
            await service.ReconcileAsync();
            Assert.Equal(ArrLiveState.Off, service.ConnectionStatus(c.Id).State);

            await Task.Delay(gap + TimeSpan.FromMilliseconds(700));
            Assert.Equal(library, rig.Arr.CallCount("radarr.lan", "/api/v3/movie"));
        }
        finally
        {
            await service.StopAsync(default);
        }
    }

    [Fact]
    public async Task MessagesBecomeTargetedReadsAndPatchesAndChangesReachTheFeed()
    {
        using var rig = new Rig();
        using var hub = new FakeHub();
        using var service = rig.Service(hub);
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library, ArrSnapshotKind.Queue, ArrSnapshotKind.History);
        var movieCalls = rig.Arr.CallCount("radarr.lan", "/api/v3/movie");

        // queue sync → the queue is read again; a new row bumps the movie.
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 101, "Alpha"));
        service.HandleMessage(c, new ArrHubMessage("queue", "sync", default));
        await Until(() => rig.Feed.Revision("movie:tmdb:101") > 0);
        var rev = rig.Feed.Revision("movie:tmdb:101");

        // movie updated with its resource → patched in place (no library read), bumped.
        var resource = JsonSerializer.SerializeToElement(new { id = 1, tmdbId = 101, title = "Alpha", hasFile = true, monitored = true, sizeOnDisk = 5000 });
        service.HandleMessage(c, new ArrHubMessage("movie", "updated", resource));
        Assert.True(rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile);
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > rev);
        Assert.Equal(movieCalls, rig.Arr.CallCount("radarr.lan", "/api/v3/movie"));

        // A partial resource doesn't reset facts it doesn't carry.
        service.HandleMessage(c, new ArrHubMessage("movie", "updated", JsonSerializer.SerializeToElement(new { id = 1, monitored = false })));
        var alpha = rig.Store.PeekLibrary(c.Id)!.MovieById(1)!;
        Assert.Equal((false, true, 101, 5000L), (alpha.Monitored, alpha.HasFile, alpha.TmdbId!.Value, alpha.SizeOnDisk));

        // moviefile → that movie alone is re-read from the arr; deleted movie → removed.
        rig.Radarr.Movies[1]["hasFile"] = false;
        service.HandleMessage(c, new ArrHubMessage("moviefile", "deleted", JsonSerializer.SerializeToElement(new { id = 9, movieId = 2 })));
        await Until(() => rig.Store.PeekLibrary(c.Id)!.MovieById(2)!.HasFile == false);
        Assert.Equal(1, rig.Arr.CallCount("radarr.lan", "/api/v3/movie/2"));
        Assert.True(rig.Feed.Revision("movie:tmdb:102") > 0);
        service.HandleMessage(c, new ArrHubMessage("movie", "deleted", JsonSerializer.SerializeToElement(new { id = 2 })));
        Assert.Null(rig.Store.PeekLibrary(c.Id)!.MovieById(2));

        // A movie message on a Sonarr instance (or without a resource) changes nothing.
        service.HandleMessage(rig.SonarrConn, new ArrHubMessage("movie", "updated", resource));
        service.HandleMessage(c, new ArrHubMessage("movie", "updated", default));
    }

    [Fact]
    public async Task SearchCommandsAreTrackedAndTheirTitlesBumped()
    {
        using var rig = new Rig();
        using var hub = new FakeHub();
        using var service = rig.Service(hub);
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library);
        JsonElement Command(string status) => JsonSerializer.SerializeToElement(new { id = 55, name = "MoviesSearch", status, body = new { movieIds = new[] { 1 } } });
        service.HandleMessage(c, new ArrHubMessage("command", "updated", Command("started")));
        var search = Assert.Single(service.ActiveSearches(c.Id));
        Assert.Equal(new[] { 1 }, search.TitleIds);
        var rev = rig.Feed.Revision("movie:tmdb:101");
        Assert.True(rev > 0);
        service.HandleMessage(c, new ArrHubMessage("command", "updated", Command("started")));
        Assert.Equal(rev, rig.Feed.Revision("movie:tmdb:101"));   // no change, no bump
        service.HandleMessage(c, new ArrHubMessage("command", "updated", Command("completed")));
        Assert.Empty(service.ActiveSearches(c.Id));
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > rev);
        // Other commands are not searches.
        service.HandleMessage(c, new ArrHubMessage("command", "updated", JsonSerializer.SerializeToElement(new { id = 56, name = "RefreshMonitoredDownloads", status = "started" })));
        Assert.Empty(service.ActiveSearches(c.Id));
    }

    // ---------------------------------------------------------------- router

    [Fact]
    public async Task ABurstOfHintsCostsOneReadPerSnapshotAndAReadRunningDuringTheEventIsFollowedByAnother()
    {
        using var rig = new Rig();
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Queue, ArrSnapshotKind.History);
        var queue = rig.Arr.CallCount("radarr.lan", "/queue");
        for (var i = 0; i < 25; i++) rig.Router.Hint(c.Id, ArrLiveKinds.Queue | ArrLiveKinds.History);
        await Until(() => rig.Router.Stats(c.Id).Flushes >= 1 && rig.Arr.CallCount("radarr.lan", "/queue") > queue);
        await Task.Delay(100);
        Assert.Equal(queue + 1, rig.Arr.CallCount("radarr.lan", "/queue"));
        Assert.Equal((25L, 1L), rig.Router.Stats(c.Id));

        // A refresh already running when the event arrives may have read too early: one more runs after it.
        var release = new TaskCompletionSource();
        var entered = new TaskCompletionSource();
        rig.Radarr.Before = async (path, ct) => { if (path.EndsWith("/queue")) { entered.TrySetResult(); await release.Task.WaitAsync(ct); } };
        var calls = rig.Arr.CallCount("radarr.lan", "/queue");
        var running = rig.Store.RefreshForEventAsync(c.Id, ArrSnapshotKind.Queue);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var follow = rig.Store.RefreshForEventAsync(c.Id, ArrSnapshotKind.Queue);
        release.SetResult();
        Assert.True(await running);
        Assert.True(await follow);
        Assert.Equal(calls + 2, rig.Arr.CallCount("radarr.lan", "/queue"));   // the running read, then one after it
        rig.Radarr.Before = null;
    }

    [Fact]
    public async Task SnapshotsNobodyUsesAreNotReadForHints()
    {
        using var rig = new Rig();
        var c = rig.RadarrConn;
        Assert.False(await rig.Store.RefreshForEventAsync(c.Id, ArrSnapshotKind.Queue));
        Assert.Equal(0, rig.Arr.CallCount("radarr.lan", "/queue"));
        Assert.False(await rig.Store.RefreshForEventAsync("no-such-instance", ArrSnapshotKind.Queue));
    }

    [Fact]
    public async Task APatchMadeWhileAReadRunsSurvivesThatRead()
    {
        using var rig = new Rig();
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library);
        var release = new TaskCompletionSource();
        var entered = new TaskCompletionSource();
        rig.Radarr.Before = async (path, ct) => { if (path == "/api/v3/movie") { entered.TrySetResult(); await release.Task.WaitAsync(ct); } };
        var refresh = rig.Store.RefreshForEventAsync(c.Id, ArrSnapshotKind.Library);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // The arr (read before the change) still says hasFile=false for Alpha; the live patch says true.
        Assert.True(rig.Store.PatchLibrary(c.Id, new[] { new ArrMovieEntry { Id = 1, TmdbId = 101, Title = "Alpha", HasFile = true, Monitored = true } }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>()));
        release.SetResult();
        await refresh;
        Assert.True(rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile);
        Assert.NotNull(rig.Store.PeekLibrary(c.Id)!.MovieById(2));
        rig.Radarr.Before = null;
        // Patching nothing new changes nothing.
        Assert.False(rig.Store.PatchLibrary(c.Id, new[] { rig.Store.PeekLibrary(c.Id)!.MovieById(1)! }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>()));
    }

    [Fact]
    public async Task TitleReReadsRunOneAtATimeAndNeverUndoANewerPatch()
    {
        using var rig = new Rig();
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library);
        var release = new TaskCompletionSource();
        var entered = new TaskCompletionSource();
        var running = 0;
        var most = 0;
        rig.Radarr.Before = async (path, ct) =>
        {
            if (!path.StartsWith("/api/v3/movie/", StringComparison.Ordinal)) return;
            var now = Interlocked.Increment(ref running);
            lock (rig) most = Math.Max(most, now);
            try
            {
                if (path == "/api/v3/movie/1")
                {
                    entered.TrySetResult();
                    await release.Task.WaitAsync(ct);
                }
                else
                {
                    await Task.Delay(20, ct);
                }
            }
            finally
            {
                Interlocked.Decrement(ref running);
            }
        };

        // A re-read of Alpha starts and stalls; the arr still says hasFile=false when it answers.
        rig.Router.Hint(c.Id, ArrLiveKinds.None, new[] { 1 });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // Meanwhile a live message says Alpha has its file now, and more hints arrive.
        Assert.True(rig.Store.PatchLibrary(c.Id, new[] { new ArrMovieEntry { Id = 1, TmdbId = 101, Title = "Alpha", HasFile = true, Monitored = true } }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>()));
        for (var i = 0; i < 5; i++)
        {
            rig.Router.Hint(c.Id, ArrLiveKinds.None, new[] { 2 });
            await Task.Delay(30);
        }
        Assert.Equal(0, rig.Arr.CallCount("radarr.lan", "/api/v3/movie/2"));   // waits for the running reader
        release.SetResult();
        await Until(() => rig.Arr.CallCount("radarr.lan", "/api/v3/movie/2") == 1);
        await Task.Delay(100);
        Assert.Equal(1, most);                                                   // never two readers at once
        Assert.Equal(1, rig.Arr.CallCount("radarr.lan", "/api/v3/movie/2"));    // the hints for it coalesced
        Assert.True(rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile);        // the older read did not undo the patch
        rig.Radarr.Before = null;

        // A read that started after the last patch is applied as usual.
        rig.Router.Hint(c.Id, ArrLiveKinds.None, new[] { 1 });
        await Until(() => rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile == false);
    }

    [Fact]
    public async Task ATitleReadOlderThanARunningLibraryReadDoesNotOverwriteItsResult()
    {
        using var rig = new Rig();
        var c = rig.RadarrConn;
        await rig.LoadAsync(c, ArrSnapshotKind.Library);
        var titleEntered = new TaskCompletionSource();
        var titleRelease = new TaskCompletionSource();
        var libraryEntered = new TaskCompletionSource();
        var libraryRelease = new TaskCompletionSource();
        rig.Radarr.Before = async (path, ct) =>
        {
            if (path == "/api/v3/movie/1") { titleEntered.TrySetResult(); await titleRelease.Task.WaitAsync(ct); }
            else if (path == "/api/v3/movie") { libraryEntered.TrySetResult(); await libraryRelease.Task.WaitAsync(ct); }
        };

        // The title read of Alpha starts (it will say hasFile=true) ...
        rig.Radarr.Movies[0]["hasFile"] = true;
        var title = rig.Store.RefreshTitlesAsync(c.Id, new[] { 1 }, default);
        await titleEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // ... then a whole-library read starts, later ...
        rig.Arr.Now += TimeSpan.FromSeconds(1);
        var library = rig.Store.RefreshForEventAsync(c.Id, ArrSnapshotKind.Library);
        await libraryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // ... the title read lands first (applied at once: newer than what is in memory) ...
        titleRelease.SetResult();
        Assert.Equal(1, await title);
        Assert.True(rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile);
        // ... and the library read, which saw the file deleted again, lands after it and stands.
        rig.Radarr.Movies[0]["hasFile"] = false;
        libraryRelease.SetResult();
        Assert.True(await library);
        Assert.False(rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile);
        rig.Radarr.Before = null;
    }

    // ---------------------------------------------------------------- detector

    private static ArrQueueSnapshot Queue(params ArrQueueEntry[] rows) => new() { Records = rows, TotalRecords = rows.Length };

    private static ArrQueueEntry Row(int id, int tmdb, double left, string state = "downloading", string? timeLeft = "00:01:00", string? error = null)
        => new() { Id = id, DownloadId = "d" + id, TmdbId = tmdb, MovieId = id, Size = 1000, SizeLeft = left, TrackedDownloadState = state, TrackedDownloadStatus = "ok", Status = "downloading", TimeLeft = timeLeft, ErrorMessage = error };

    [Fact]
    public void QueueChangesAreProgressInWholePercentStateMessagesAndRowsComingAndGoing()
    {
        var a = Queue(Row(1, 101, 500), Row(2, 102, 900));
        Assert.Empty(ArrChangeDetector.Queue(ArrKind.Radarr, null, a, null));                                         // first load: baseline
        Assert.Empty(ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 500, timeLeft: "00:00:59"), Row(2, 102, 900)), null)); // seconds left only
        Assert.Empty(ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 499.5), Row(2, 102, 900)), null));  // < 1 %
        Assert.Equal(new[] { "movie:tmdb:101" }, ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 480), Row(2, 102, 900)), null));
        Assert.Equal(new[] { "movie:tmdb:102" }, ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 500), Row(2, 102, 900, "importPending")), null));
        Assert.Equal(new[] { "movie:tmdb:102" }, ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 500)), null));
        Assert.Equal(new[] { "movie:tmdb:103" }, ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 500), Row(2, 102, 900), Row(3, 103, 1000)), null));
        Assert.Equal(new[] { "movie:tmdb:101" }, ArrChangeDetector.Queue(ArrKind.Radarr, a, Queue(Row(1, 101, 500, error: "boom"), Row(2, 102, 900)), null));

        // A row without the movie object is matched through the library index.
        var library = new ArrLibrarySnapshot(new[] { new ArrMovieEntry { Id = 9, TmdbId = 109 } }, Array.Empty<ArrSeriesEntry>(), new Dictionary<int, string>());
        var bare = new ArrQueueEntry { Id = 4, MovieId = 9, Size = 10, SizeLeft = 5 };
        Assert.Equal(new[] { "movie:tmdb:109" }, ArrChangeDetector.Queue(ArrKind.Radarr, Queue(), Queue(bare), library));

        // Sonarr: an episode change also reaches its season and series.
        var ep = new ArrQueueEntry { Id = 5, TvdbId = 700, SeasonNumber = 2, EpisodeNumber = 3, Size = 10, SizeLeft = 5 };
        Assert.Equal(new[] { "tv:tvdb:700:s2:e3", "tv:tvdb:700:s2", "tv:tvdb:700" }, ArrChangeDetector.Queue(ArrKind.Sonarr, Queue(), Queue(ep), null));
    }

    [Fact]
    public void LibraryAndHistoryChangesNameTheTitlesAndTheFilesThatChanged()
    {
        var tags = new Dictionary<int, string>();
        var before = new ArrLibrarySnapshot(new[] { new ArrMovieEntry { Id = 1, TmdbId = 101 }, new ArrMovieEntry { Id = 2, TmdbId = 102 } }, Array.Empty<ArrSeriesEntry>(), tags);
        var after = new ArrLibrarySnapshot(new[] { new ArrMovieEntry { Id = 1, TmdbId = 101, HasFile = true }, new ArrMovieEntry { Id = 3, TmdbId = 103 } }, Array.Empty<ArrSeriesEntry>(), tags);
        Assert.Equal(new[] { "movie:tmdb:101", "movie:tmdb:102", "movie:tmdb:103" }, ArrChangeDetector.Library(before, after).OrderBy(k => k));
        Assert.Equal(new[] { "movie:tmdb:101" }, ArrChangeDetector.Library(before, after, new[] { 1 }));
        Assert.Empty(ArrChangeDetector.Library(null, after));
        var series = new ArrLibrarySnapshot(Array.Empty<ArrMovieEntry>(), new[] { new ArrSeriesEntry { Id = 7, TvdbId = 700, EpisodeFileCount = 1 } }, tags);
        var series2 = new ArrLibrarySnapshot(Array.Empty<ArrMovieEntry>(), new[] { new ArrSeriesEntry { Id = 7, TvdbId = 700, EpisodeFileCount = 2 } }, tags);
        Assert.Equal(new[] { "tv:tvdb:700" }, ArrChangeDetector.Library(series, series2));

        var t0 = new DateTime(2026, 10, 12, 12, 0, 0, DateTimeKind.Utc);
        var h1 = new ArrHistorySnapshot { Records = new[] { new ArrHistoryEntry { Id = 10, EventType = "grabbed", Date = t0, TmdbId = 101, MovieId = 1 } }, Watermark = t0 };
        var h2 = new ArrHistorySnapshot
        {
            Records = new[]
            {
                new ArrHistoryEntry { Id = 12, EventType = "downloadFolderImported", Date = t0.AddMinutes(2), TmdbId = 101, MovieId = 1 },
                new ArrHistoryEntry { Id = 10, EventType = "grabbed", Date = t0, TmdbId = 101, MovieId = 1 },
                new ArrHistoryEntry { Id = 3, EventType = "movieFileDeleted", Date = t0.AddDays(-3), TmdbId = 104, MovieId = 4 },   // old record back in the ring
            },
            Watermark = t0.AddMinutes(2),
        };
        var (keys, reread) = ArrChangeDetector.History(ArrKind.Radarr, h1, h2, null);
        Assert.Equal(new[] { "movie:tmdb:101" }, keys);
        Assert.Equal(new[] { 1 }, reread);
        Assert.Empty(ArrChangeDetector.History(ArrKind.Radarr, null, h2, null).Keys);
        Assert.True(ArrChangeDetector.ChangesFiles("episodeFileRenamed"));
        Assert.False(ArrChangeDetector.ChangesFiles("grabbed"));
    }

    [Fact]
    public void TitleKeysAreStrict()
    {
        Assert.Equal("movie:tmdb:5", ArrTitleKey.Movie(5));
        Assert.Equal("tv:tvdb:7:s0:e12", ArrTitleKey.Episode(7, 0, 12));
        foreach (var bad in new[] { "", "movie:tmdb:0", "movie:tmdb:01", "movie:imdb:5", "tv:tvdb:7:e1", "tv:tvdb:7:s1:e1:x", "movie:tmdb:1234567890", "MOVIE:tmdb:5", "tv:tvdb:7:s-1" })
            Assert.False(ArrTitleKey.IsValid(bad), bad);
        Assert.True(ArrTitleKey.TryParse("tv:tvdb:7:s2:e3", out var type, out var id, out var s, out var e));
        Assert.Equal(("tv", 7, 2, 3), (type, id, s!.Value, e!.Value));
        Assert.Equal("tv:tvdb:7", ArrTitleKey.TitleOf("tv:tvdb:7:s2:e3"));
        Assert.Null(ArrTitleKey.TitleOf("nope"));
    }

    // ---------------------------------------------------------------- feed

    [Fact]
    public async Task TheFeedIsOrderedDeduplicatedResetWhenItCantServeAndWakesWaiters()
    {
        var now = DateTimeOffset.UtcNow;
        var feed = new ArrChangeFeed(() => now);
        Assert.Equal(0, feed.Cursor);
        Assert.Equal(2, feed.Bump(new[] { "movie:tmdb:1", "movie:tmdb:2", "movie:tmdb:1", "junk" }, "i"));
        feed.Bump(new[] { "movie:tmdb:3" });
        feed.Bump(new[] { "movie:tmdb:1" });
        var read = feed.Read(feed.Epoch, 0);
        Assert.False(read.Reset);
        Assert.Equal(4, read.Cursor);
        // Oldest first, one entry per key with its newest revision.
        Assert.Equal(new[] { ("movie:tmdb:1", 4L), ("movie:tmdb:2", 2L), ("movie:tmdb:3", 3L) }, read.Changes.Select(c => (c.Key, c.Cursor)));
        Assert.Equal("i", read.Changes[0].InstanceId);
        Assert.Equal(new[] { "movie:tmdb:1" }, feed.Read(feed.Epoch, 3).Changes.Select(c => c.Key));
        Assert.Empty(feed.Read(feed.Epoch, 4).Changes);
        Assert.Equal(4, feed.Revision("movie:tmdb:1"));
        Assert.Equal(0, feed.Revision("movie:tmdb:9"));

        Assert.True(feed.Read("other-epoch", 0).Reset);
        Assert.True(feed.Read(feed.Epoch, 99).Reset);
        Assert.True(feed.Read(feed.Epoch, -1).Reset);

        // Older than the retention: reset.
        now += ArrChangeFeed.Retention + TimeSpan.FromMinutes(1);
        Assert.True(feed.Read(feed.Epoch, 0).Reset);

        // Overflowing the ring: the earliest cursors are reset, the newest still served.
        var big = new ArrChangeFeed();
        for (var i = 1; i <= ArrChangeFeed.Capacity + 10; i++) big.Bump(new[] { ArrTitleKey.Movie(i) });
        Assert.True(big.Read(big.Epoch, 5).Reset);
        Assert.Equal(ArrTitleKey.Movie(ArrChangeFeed.Capacity + 10), Assert.Single(big.Read(big.Epoch, big.Cursor - 1).Changes).Key);

        // A waiter wakes on the next change; one with nothing new times out quietly.
        var wait = feed.WaitAsync(feed.Cursor, TimeSpan.FromSeconds(10), default);
        Assert.False(wait.IsCompleted);
        feed.Bump(new[] { "movie:tmdb:4" });
        await wait.WaitAsync(TimeSpan.FromSeconds(5));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await feed.WaitAsync(feed.Cursor, TimeSpan.FromMilliseconds(80), default);
        Assert.True(sw.ElapsedMilliseconds >= 60);
        await feed.WaitAsync(feed.Cursor - 1, TimeSpan.FromSeconds(10), default);   // already behind: returns at once
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => feed.WaitAsync(feed.Cursor, TimeSpan.FromSeconds(10), new CancellationToken(true)));
    }

    // ---------------------------------------------------------------- tracker

    [Fact]
    public async Task JellyfinLibraryAddsBumpOnlyTitlesTheArrsKnowAndNothingWhileOff()
    {
        using var rig = new Rig();
        await rig.LoadAsync(rig.RadarrConn, ArrSnapshotKind.Library);
        await rig.LoadAsync(rig.SonarrConn, ArrSnapshotKind.Library);
        var library = new Mock<ILibraryManager>();
        var tracker = new ArrChangeTracker(rig.Store, rig.Feed, rig.Router, library.Object, null, () => rig.Arr.Plugin.Plugin.Configuration);
        await tracker.StartAsync(default);
        try
        {
            BaseItem Movie(string tmdb) { var m = new Movie { Id = Guid.NewGuid() }; m.SetProviderId(MetadataProvider.Tmdb, tmdb); return m; }
            BaseItem Series(string tvdb) { var s = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() }; s.SetProviderId(MetadataProvider.Tvdb, tvdb); return s; }
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = Movie("101") });
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = Movie("999") });   // not in any arr
            library.Raise(l => l.ItemRemoved += null, library.Object, new ItemChangeEventArgs { Item = Series("700") });
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = new Folder { Id = Guid.NewGuid() } });
            Assert.Equal(2, tracker.FlushItems());
            Assert.True(rig.Feed.Revision("movie:tmdb:101") > 0);
            Assert.True(rig.Feed.Revision("tv:tvdb:700") > 0);
            Assert.Equal(0, rig.Feed.Revision("movie:tmdb:999"));

            rig.Arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = false;
            var cursor = rig.Feed.Cursor;
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = Movie("101") });
            Assert.Equal(0, tracker.FlushItems());
            rig.Tracker.OnSnapshotChanged(new ArrSnapshotChange(rig.RadarrConn, ArrSnapshotKind.Queue, Queue(), Queue(Row(1, 101, 5)), null));
            Assert.Equal(cursor, rig.Feed.Cursor);
        }
        finally
        {
            await tracker.StopAsync(default);
            tracker.Dispose();
        }
    }

    [Fact]
    public async Task AnItemAddedDuringABigScanStillHasItsLateIdsCountedWhenTheTrackerIsFull()
    {
        using var rig = new Rig();
        await rig.LoadAsync(rig.RadarrConn, ArrSnapshotKind.Library);
        var library = new Mock<ILibraryManager>();
        var now = new DateTimeOffset(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        // The timer never flushes on its own: which caller drains the queue is the test's to decide.
        var tracker = new ArrChangeTracker(rig.Store, rig.Feed, rig.Router, library.Object, null, () => rig.Arr.Plugin.Plugin.Configuration, () => now, Timeout.InfiniteTimeSpan);
        await tracker.StartAsync(default);
        try
        {
            void Add(BaseItem item) => library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = item });
            for (var i = 0; i < 4990; i++) Add(new Movie { Id = Guid.NewGuid() });
            now = now.AddSeconds(1);
            // Alpha arrives without its ids (read a moment later), then the scan goes on.
            var alpha = new Movie { Id = Guid.NewGuid() };
            Add(alpha);
            now = now.AddSeconds(1);
            for (var i = 0; i < 1000; i++) Add(new Movie { Id = Guid.NewGuid() });
            Assert.True(tracker.RecentlyAdded.Count <= 5000);
            tracker.FlushItems();
            alpha.SetProviderId(MetadataProvider.Tmdb, "101");
            var before = rig.Feed.Revision("movie:tmdb:101");
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = alpha });
            Assert.Equal(1, tracker.FlushItems());
            Assert.True(rig.Feed.Revision("movie:tmdb:101") > before);
            // Past the arrival window, metadata alone does not publish; the stamp feeder owns upgrades.
            rig.Arr.Plugin.Plugin.Configuration.ArrPhase4Enabled = true;
            rig.Arr.Plugin.Plugin.Configuration.ArrPhase4AcquisitionBadgesEnabled = true;
            now = now.AddMinutes(11);
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = alpha });
            Assert.Equal(0, tracker.FlushItems());
        }
        finally
        {
            await tracker.StopAsync(default);
            tracker.Dispose();
        }
    }

    // Integration rebuild, stage 1 fix round 2 (D53): Jellyfin can read a new file's dimensions after the ten minutes its
    // updates count as part of the arrival; that is when a 4K request's copy becomes known. With acquisition badges off no
    // stamp feeder publishes it, so the update of a movie or episode that is still a fresh arrival (3 days) is published;
    // an old item's metadata refresh still isn't, and with badges on the feeder stays the owner.
    [Fact]
    public async Task AFreshVideosLateProbeIsPublishedWhenNoStampFeederOwnsIt()
    {
        using var rig = new Rig();
        await rig.LoadAsync(rig.RadarrConn, ArrSnapshotKind.Library);
        var library = new Mock<ILibraryManager>();
        var now = new DateTimeOffset(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        var tracker = new ArrChangeTracker(rig.Store, rig.Feed, rig.Router, library.Object, null, () => rig.Arr.Plugin.Plugin.Configuration, () => now, Timeout.InfiniteTimeSpan);
        await tracker.StartAsync(default);
        try
        {
            var fresh = new Movie { Id = Guid.NewGuid(), DateCreated = now.UtcDateTime };
            fresh.SetProviderId(MetadataProvider.Tmdb, "101");
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = fresh });
            tracker.FlushItems();
            now = now.AddMinutes(12);
            var before = rig.Feed.Revision("movie:tmdb:101");
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = fresh });   // the probe
            Assert.Equal(1, tracker.FlushItems());
            Assert.True(rig.Feed.Revision("movie:tmdb:101") > before);

            var old = new Movie { Id = Guid.NewGuid(), DateCreated = now.UtcDateTime.AddDays(-10) };
            old.SetProviderId(MetadataProvider.Tmdb, "101");
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = old });
            Assert.Equal(0, tracker.FlushItems());
        }
        finally
        {
            await tracker.StopAsync(default);
            tracker.Dispose();
        }
    }

    [Fact]
    public void RecentArrivalsDropStaleEntriesFirstThenTheOldestTenthAndKeepTheirWindow()
    {
        var now = new DateTimeOffset(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        var arrivals = new RecentArrivals(TimeSpan.FromMinutes(10), 100, () => now);
        var stale = Enumerable.Range(0, 30).Select(_ => Guid.NewGuid()).ToList();
        foreach (var id in stale) arrivals.Add(id);
        now = now.AddMinutes(11);
        var old = Enumerable.Range(0, 70).Select(_ => Guid.NewGuid()).ToList();
        foreach (var id in old) arrivals.Add(id);
        Assert.Equal(100, arrivals.Count);
        // Full: the 30 past their window go, nothing fresh.
        var fresh = Guid.NewGuid();
        now = now.AddSeconds(1);
        arrivals.Add(fresh);
        Assert.Equal(71, arrivals.Count);
        Assert.All(old, id => Assert.True(arrivals.IsRecent(id)));
        Assert.All(stale, id => Assert.False(arrivals.IsRecent(id)));
        // Full of fresh entries: the oldest tenth goes, never the newest.
        for (var i = 0; i < 29; i++) arrivals.Add(Guid.NewGuid());
        now = now.AddSeconds(1);
        var newest = Guid.NewGuid();
        arrivals.Add(newest);
        Assert.Equal(91, arrivals.Count);
        Assert.True(arrivals.IsRecent(newest));
        Assert.True(arrivals.IsRecent(fresh));
        Assert.Equal(10, old.Count(id => !arrivals.IsRecent(id)));
        // Past the window: an entry is no longer recent, and pruning removes what is left of them.
        now = now.AddMinutes(10).AddSeconds(-1.5);
        Assert.Equal(60, arrivals.Prune());
        Assert.Equal(31, arrivals.Count);
        Assert.All(old, id => Assert.False(arrivals.IsRecent(id)));
        Assert.True(arrivals.IsRecent(newest));
        Assert.True(arrivals.IsRecent(fresh));
    }

    [Fact]
    public async Task NewImportsInHistoryReReadTheirTitles()
    {
        using var rig = new Rig();
        var c = rig.RadarrConn;
        var t0 = DateTime.UtcNow.AddMinutes(-5);
        rig.Radarr.History.Add(FakeArr.HistoryRow(1, "grabbed", t0, "dl1", 101, "Alpha"));
        await rig.LoadAsync(c, ArrSnapshotKind.Library, ArrSnapshotKind.History);
        rig.Radarr.Movies[0]["hasFile"] = true;
        rig.Radarr.History.Add(FakeArr.HistoryRow(2, "downloadFolderImported", t0.AddMinutes(1), "dl1", 101, "Alpha"));
        // HistoryRow puts the movie id = record id; point it at Alpha (arr id 1).
        rig.Radarr.History[1]["movie"]!["id"] = 1;
        rig.Radarr.History[1]["movieId"] = 1;
        Assert.True(await rig.Store.RefreshForEventAsync(c.Id, ArrSnapshotKind.History));
        await Until(() => rig.Store.PeekLibrary(c.Id)!.MovieById(1)!.HasFile);
        Assert.Equal(1, rig.Arr.CallCount("radarr.lan", "/api/v3/movie/1"));
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > 0);
    }
}
