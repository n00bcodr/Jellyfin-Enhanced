using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Live-updates routes: the anonymous webhook receiver (secret, constant-time compare, size cap,
/// rate limits, payload only selects re-reads, replays coalesce), the long-poll change feed
/// (bootstrap, waits, wake-ups, key filter, resets, per-user caps, per-user visibility), the
/// feed's audience rules, and the admin webhook set-up (consent, idempotent create/update,
/// duplicates, removal, copy-paste) — never a secret or key in a response or log except the
/// explicit copy-paste route.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrLiveRoutesTests
{
    private const string RadarrKey = "RADARR-ROUTE-KEY-0123456789abcd";

    private sealed class Audience : IArrFeedAudience
    {
        public HashSet<string> Hidden { get; } = new();
        public IReadOnlyCollection<string> Visible(Guid userId, bool isAdmin, IReadOnlyList<ArrFeedChange> changes, IReadOnlySet<string>? askedFor = null, ICollection<string>? absent = null)
            => changes.Select(c => c.Key).Where(k => isAdmin || !Hidden.Contains(k)).ToList();
    }

    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host? Sonarr { get; }
        public ArrStateStore Store { get; }
        public ArrChangeFeed Feed { get; } = new();
        public ArrFeedLimits Limits { get; } = new();
        public Audience Audience { get; } = new();
        public ArrLiveRouter Router { get; }
        public ArrWebhookReceiver Receiver { get; }
        public ArrAuditLog Audit { get; }
        public ArrWebhookProvisioner Provisioner { get; }
        public ArrLiveService Live { get; }
        public SeerrRequestReadModel Requests { get; }
        public ArrConnection Instance => Arr.Instance("Movies");
        public Guid UserId { get; } = Guid.NewGuid();
        public string AuditPath => Path.Combine(Arr.Plugin.Core.Root, ArrAuditLog.FileName);

        /// <param name="sonarr">Also a Sonarr instance.</param>
        /// <param name="coalesce">The router's coalescing window (10 ms unless a test counts reads across several hints).</param>
        public Rig(bool sonarr = false, TimeSpan? coalesce = null)
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Radarr.Movies.Add(FakeArr.Movie(1, 101, "Alpha", hasFile: false));
            if (sonarr)
            {
                // Series 1 (TVDB 100) with one episode, for the episode-pace tests.
                Sonarr = Arr.Add("sonarr.lan", "Sonarr");
                Sonarr.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
                Sonarr.Episodes.Add(FakeArr.Episode(11, "2026-01-01T00:00:00Z"));
                Arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", RadarrKey), ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-ROUTE-KEY-0123456789abcd"));
            }
            else
            {
                Arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", RadarrKey));
            }
            var config = Arr.Plugin.Plugin.Configuration;
            config.ArrIntegrationEnabled = true;
            config.ArrPhase1Enabled = true;
            config.ArrWebhookJellyfinUrl = "http://je.lan:8096/";
            Arr.Now = DateTimeOffset.UtcNow;
            Store = Arr.Store();
            Router = new ArrLiveRouter(Store, Arr.Plugin.Core.Logger, coalesce ?? TimeSpan.FromMilliseconds(10));
            Receiver = new ArrWebhookReceiver(Arr.Registry, () => Arr.Plugin.Plugin.Secrets, Router, null);
            Audit = new ArrAuditLog(AuditPath, 1024 * 1024, 2);
            Provisioner = new ArrWebhookProvisioner(Arr.Factory, new ArrActionRunner(Audit, new ArrConfirmationTokens()), Receiver);
            var tracker = new ArrChangeTracker(Store, Feed, Router, null, null, () => Arr.Plugin.Plugin.Configuration);
            tracker.Start();
            Requests = new SeerrRequestReadModel(new IntegrationTransport((_, _) => throw new InvalidOperationException("no Seerr in these tests")), Feed, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Live = new ArrLiveService(Store, Router, tracker, null, () => Arr.Plugin.Plugin.Configuration, (_, _, _) => throw new ArrLiveConnectException("not in tests"), null, null);
            // The fake arr sends its Test event to JE when a webhook is saved or tested, like the real ones.
            Radarr.OnNotificationTest = n => Receiver.Receive(Instance.Id, HeaderOf(n), Encoding.UTF8.GetBytes("{\"eventType\":\"Test\",\"instanceName\":\"x\"}"), "arr") == ArrWebhookOutcome.Accepted ? null : "Unable to send test message";
        }

        public static string? HeaderOf(JsonObject n)
            => (n["fields"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(f => (string?)f["name"] == "headers")?["value"]?.AsArray().OfType<JsonObject>()
                .FirstOrDefault(h => (string?)h["key"] == ArrWebhookReceiver.SecretHeader)?["value"]?.GetValue<string>();

        public TestCallers Callers { get; } = new();

        public ArrLiveController Controller(bool admin = true, Guid? user = null)
        {
            var controller = new ArrLiveController(Feed, Limits, Audience, Receiver, Provisioner, Live, Router, Store, Audit, Callers.Users.Object, Arr.Plugin.Core.Logger, Requests)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            controller.HttpContext.User = Callers.Person(admin, user ?? UserId);
            return controller;
        }

        public async Task<IActionResult> Hook(string? secret, string body, string? instanceId = null, string source = "10.0.0.5")
        {
            var c = Controller();
            c.HttpContext.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
            if (secret != null) c.HttpContext.Request.Headers[ArrWebhookReceiver.SecretHeader] = secret;
            c.HttpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(source);
            return await c.ReceiveWebhook(instanceId ?? Instance.Id, default);
        }

        public string Logs() => string.Join("\n", Directory.GetFiles(Arr.Plugin.Core.Root, "JellyfinEnhanced_*.log").Select(File.ReadAllText));

        public void Dispose()
        {
            Requests.Dispose();
            Arr.Dispose();
        }
    }

    private sealed class KestrelLimitStream : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => throw new Microsoft.AspNetCore.Http.BadHttpRequestException("Request body too large.", 413);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => throw new Microsoft.AspNetCore.Http.BadHttpRequestException("Request body too large.", 413);
    }

    private static int Status(IActionResult r) => r switch
    {
        StatusCodeResult s => s.StatusCode,
        ObjectResult o => o.StatusCode ?? 200,
        _ => -1,
    };

    private static JsonElement Body(IActionResult r) => JsonSerializer.SerializeToElement(Assert.IsAssignableFrom<ObjectResult>(r).Value);

    private static async Task Until(Func<bool> condition)
    {
        var start = DateTime.UtcNow;
        while (!condition())
        {
            if (DateTime.UtcNow - start > TimeSpan.FromSeconds(10)) throw new TimeoutException();
            await Task.Delay(10);
        }
    }

    // ---------------------------------------------------------------- webhook receiver

    [Fact]
    public async Task TheWebhookNeedsTheFeatureTheInstanceAndItsSecret()
    {
        using var rig = new Rig();
        Assert.Equal(401, Status(await rig.Hook("anything", "{\"eventType\":\"Test\"}")));             // no secret set up yet
        var secret = rig.Receiver.EnsureSecret(rig.Instance.Id);
        Assert.Equal(secret, rig.Receiver.EnsureSecret(rig.Instance.Id));                               // stable
        Assert.True(secret.Length >= 43);
        Assert.Equal(401, Status(await rig.Hook(null, "{\"eventType\":\"Test\"}")));
        Assert.Equal(401, Status(await rig.Hook(secret + "x", "{\"eventType\":\"Test\"}")));
        Assert.Equal(401, Status(await rig.Hook(secret, "{\"eventType\":\"Test\"}", "00000000-0000-0000-0000-000000000000")));
        Assert.Equal(401, Status(await rig.Hook(secret, "{\"eventType\":\"Test\"}", "../../etc")));
        var ok = await rig.Hook(secret, "{\"eventType\":\"Test\",\"instanceName\":\"Somebody else\"}");
        Assert.IsType<NoContentResult>(ok);
        var stats = rig.Receiver.Stats(rig.Instance.Id);
        Assert.Equal((1L, 3L, "Test"), (stats.Accepted, stats.Refused, stats.LastEventType));   // unknown ids are not counted anywhere
        Assert.NotNull(stats.LastTestAt);
        Assert.Equal(400, Status(await rig.Hook(secret, "not json")));
        Assert.Equal(400, Status(await rig.Hook(secret, "[1,2]")));
        Assert.Equal(400, Status(await rig.Hook(secret, "{\"no\":\"type\"}")));
        var tooLarge = await rig.Hook(secret, "{\"eventType\":\"Test\",\"pad\":\"" + new string('x', ArrWebhookReceiver.MaxBodyBytes) + "\"}");
        Assert.Equal((413, "payload_too_large"), (Status(tooLarge), Body(tooLarge).GetProperty("code").GetString()));
        // Kestrel's own limit tripping on a chunked body is the same structured answer, never an exception (a 500 behind Jellyfin).
        var c = rig.Controller();
        c.HttpContext.Request.Body = new KestrelLimitStream();
        c.HttpContext.Request.Headers[ArrWebhookReceiver.SecretHeader] = secret;
        var kestrel = await c.ReceiveWebhook(rig.Instance.Id, default);
        Assert.Equal((413, "payload_too_large"), (Status(kestrel), Body(kestrel).GetProperty("code").GetString()));

        rig.Arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = false;
        Assert.IsType<NotFoundResult>(await rig.Hook(secret, "{\"eventType\":\"Test\"}"));

        Assert.True(ArrWebhookReceiver.SecretsMatch("abc", "abc"));
        Assert.False(ArrWebhookReceiver.SecretsMatch("abd", "abc"));
        Assert.False(ArrWebhookReceiver.SecretsMatch("", "abc"));
        Assert.False(ArrWebhookReceiver.SecretsMatch("abcd", "abc"));
    }

    [Fact]
    public async Task WebhookPayloadsOnlyChooseWhatToReReadAndReplaysCoalesce()
    {
        // A window the ten replays below always fall in, however slow the machine (10 ms didn't under load).
        using var rig = new Rig(coalesce: TimeSpan.FromSeconds(2));
        var secret = rig.Receiver.EnsureSecret(rig.Instance.Id);
        Assert.NotNull((await rig.Store.GetQueueAsync(rig.Instance, default)).Value);
        Assert.NotNull((await rig.Store.GetHistoryAsync(rig.Instance, default)).Value);
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.Instance, default)).Value);
        var before = (Queue: rig.Arr.CallCount("radarr.lan", "/queue"), History: rig.Arr.CallCount("radarr.lan", "/history"), Movie: rig.Arr.CallCount("radarr.lan", "/api/v3/movie/1"));

        // A Download for movie 1 whose payload claims things (title, hasFile, a path): none of it is
        // kept; the arr is asked. Ten replays of it cost one read of each.
        rig.Radarr.Movies[0]["hasFile"] = true;
        var payload = "{\"eventType\":\"Download\",\"instanceName\":\"Evil\",\"movie\":{\"id\":1,\"title\":\"Pwned\",\"folderPath\":\"/etc\",\"tmdbId\":666},\"isUpgrade\":false}";
        for (var i = 0; i < 10; i++) Assert.IsType<NoContentResult>(await rig.Hook(secret, payload));
        await Until(() => rig.Store.PeekLibrary(rig.Instance.Id)!.MovieById(1)!.HasFile);
        await Task.Delay(100);
        Assert.Equal(before.Queue + 1, rig.Arr.CallCount("radarr.lan", "/queue"));
        Assert.Equal(before.History + 1, rig.Arr.CallCount("radarr.lan", "/history"));
        Assert.Equal(before.Movie + 1, rig.Arr.CallCount("radarr.lan", "/api/v3/movie/1"));
        var alpha = rig.Store.PeekLibrary(rig.Instance.Id)!.MovieById(1)!;
        Assert.Equal(("Alpha", 101), (alpha.Title, alpha.TmdbId!.Value));
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > 0);
        Assert.Equal(0, rig.Feed.Revision("movie:tmdb:666"));

        // Which snapshots each event type re-reads.
        Assert.True(ArrWebhookReceiver.TryReadHint(ArrKind.Radarr, Encoding.UTF8.GetBytes("{\"eventType\":\"Grab\",\"movie\":{\"id\":3}}"), out _, out var kinds, out var ids));
        Assert.Equal((ArrLiveKinds.Queue | ArrLiveKinds.History, 0), (kinds, ids.Count));
        Assert.True(ArrWebhookReceiver.TryReadHint(ArrKind.Sonarr, Encoding.UTF8.GetBytes("{\"eventType\":\"SeriesDelete\",\"series\":{\"id\":\"7\"}}"), out _, out kinds, out ids));
        Assert.Equal((ArrLiveKinds.None, 0), (kinds, ids.Count));   // a non-numeric id is ignored
        Assert.True(ArrWebhookReceiver.TryReadHint(ArrKind.Sonarr, Encoding.UTF8.GetBytes("{\"eventType\":\"EpisodeFileDelete\",\"series\":{\"id\":7}}"), out _, out kinds, out ids));
        Assert.Equal((ArrLiveKinds.History, 7), (kinds, ids.Single()));
        Assert.True(ArrWebhookReceiver.TryReadHint(ArrKind.Radarr, Encoding.UTF8.GetBytes("{\"eventType\":\"Health\"}"), out var type, out kinds, out _));
        Assert.Equal(("Health", ArrLiveKinds.System), (type, kinds));
        Assert.False(ArrWebhookReceiver.TryReadHint(ArrKind.Radarr, Encoding.UTF8.GetBytes(new string('[', 100) + new string(']', 100)), out _, out _, out _));
    }

    [Fact]
    public async Task WebhooksAreRateLimitedPerInstanceAndFailuresPerSource()
    {
        using var rig = new Rig();
        var secret = rig.Receiver.EnsureSecret(rig.Instance.Id);
        // Wrong secrets from one address: after ten, wrong ones get 429 from there, but the arr
        // (the right secret) behind the same address (a proxy) still gets through.
        for (var i = 0; i < 10; i++) Assert.Equal(401, Status(await rig.Hook("wrong", "{\"eventType\":\"Test\"}", source: "10.0.0.66")));
        Assert.Equal(429, Status(await rig.Hook("wrong", "{\"eventType\":\"Test\"}", source: "10.0.0.66")));
        Assert.IsType<NoContentResult>(await rig.Hook(secret, "{\"eventType\":\"Test\"}", source: "10.0.0.66"));
        Assert.IsType<NoContentResult>(await rig.Hook(secret, "{\"eventType\":\"Test\"}", source: "10.0.0.67"));

        // Accepted events per instance: a burst of 60, then 429 with Retry-After.
        var accepted = 2;
        IActionResult last = new OkResult();
        for (var i = 0; i < 70; i++)
        {
            last = await rig.Hook(secret, "{\"eventType\":\"Test\"}", source: "10.0.0.68");
            if (last is NoContentResult) accepted++;
        }
        Assert.InRange(accepted, 60, 62);
        Assert.Equal(429, Status(last));
    }

    [Fact]
    public void RotatingAddressesNeverResetAnotherAddresssFailureBudget()
    {
        using var rig = new Rig();
        var now = DateTimeOffset.UtcNow;
        var receiver = new ArrWebhookReceiver(rig.Arr.Registry, () => rig.Arr.Plugin.Plugin.Secrets, rig.Router, () => now);
        var secret = receiver.EnsureSecret(rig.Instance.Id);
        var body = Encoding.UTF8.GetBytes("{\"eventType\":\"Test\"}");
        for (var i = 0; i < 10; i++) Assert.Equal(ArrWebhookOutcome.Unauthorized, receiver.Receive(rig.Instance.Id, "wrong", body, "victim"));
        Assert.Equal(ArrWebhookOutcome.RateLimited, receiver.Receive(rig.Instance.Id, "wrong", body, "victim"));
        // An attacker fails once from each of more addresses than are tracked.
        for (var i = 0; i < ArrWebhookReceiver.MaxFailureSources + 10; i++) receiver.Receive(rig.Instance.Id, "wrong", body, "rotating-" + i);
        now += TimeSpan.FromSeconds(4);   // the overall budget refills; the victim's has not
        Assert.Equal(ArrWebhookOutcome.RateLimited, receiver.Receive(rig.Instance.Id, "wrong", body, "victim"));
        Assert.Equal(ArrWebhookOutcome.RateLimited, receiver.Receive(rig.Instance.Id, "wrong", body, "one-more"));   // map full: no new entry
        Assert.Equal(ArrWebhookOutcome.Accepted, receiver.Receive(rig.Instance.Id, secret, body, "victim"));
        // Once budgets have refilled, their sources are forgotten and new ones are tracked again.
        now += TimeSpan.FromMinutes(2);
        Assert.Equal(ArrWebhookOutcome.Unauthorized, receiver.Receive(rig.Instance.Id, "wrong", body, "one-more"));
    }

    [Fact]
    public async Task ConcurrentCallersGetTheSameNewSecret()
    {
        for (var round = 0; round < 5; round++)
        {
            using var rig = new Rig();
            using var start = new ManualResetEventSlim();
            var tasks = Enumerable.Range(0, 16).Select(_ => Task.Run(() => { start.Wait(); return rig.Receiver.EnsureSecret(rig.Instance.Id); })).ToList();
            start.Set();
            var secrets = await Task.WhenAll(tasks);
            Assert.Single(secrets.Distinct());
            Assert.Equal(secrets[0], rig.Arr.Plugin.Plugin.Secrets.Get(ArrWebhookReceiver.SecretName(rig.Instance.Id)));
        }
    }

    // ---------------------------------------------------------------- change feed

    private static async Task<JsonElement> Changes(ArrLiveController c, string? epoch, long? cursor, int wait, params string[] keys)
        => Body(await c.GetChanges(new ArrChangesRequest { Epoch = epoch, Cursor = cursor, Wait = wait, Keys = keys.ToList() }, default));

    [Fact]
    public async Task AnOpenRequestsPageKeepsSeerrOnTheFastRefreshThroughItsFeedPolls()
    {
        using var rig = new Rig();
        var epoch = Body(await rig.Controller(admin: false).GetChanges(new ArrChangesRequest(), default)).GetProperty("epoch").GetString();
        // Other pages (titles only, another user's list key, or the caller's own list key, which
        // Seerr's more-info modal follows for a series known only by TMDB) don't count as the Requests page.
        await Changes(rig.Controller(admin: false), epoch, 0, 0, "movie:tmdb:101", ArrTitleKey.UserRequests(Guid.NewGuid()));
        await Changes(rig.Controller(admin: false), epoch, 0, 0, "tv:tmdb:5", ArrTitleKey.UserRequests(rig.UserId));
        Assert.Null(rig.Requests.WatchedAt);
        // The Requests page follows the request-list state key: every poll renews the watch.
        rig.Arr.Now = new DateTimeOffset(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        await Changes(rig.Controller(admin: false), epoch, 0, 0, "movie:tmdb:101", ArrTitleKey.UserRequests(rig.UserId), ArrTitleKey.RequestsState);
        Assert.Equal(rig.Arr.Now, rig.Requests.WatchedAt);
        rig.Arr.Now += TimeSpan.FromMinutes(5);
        await Changes(rig.Controller(admin: false), epoch, 0, 0, ArrTitleKey.RequestsState);
        Assert.Equal(rig.Arr.Now, rig.Requests.WatchedAt);
    }

    [Fact]
    public async Task AFeedPollNamingASeriesKeepsItsEpisodesOnTheOpenPageMinutePace()
    {
        using var rig = new Rig(sonarr: true);
        var tv = rig.Arr.Instance("TV");
        await rig.Store.GetLibraryAsync(tv, default);
        await rig.Store.GetEpisodesAsync(tv, 1, default);
        var reads = rig.Arr.CallCount("sonarr.lan", "/api/v3/episode");
        var epoch = Body(await rig.Controller(admin: false).GetChanges(new ArrChangesRequest(), default)).GetProperty("epoch").GetString();
        // A page about another title doesn't hold this series' pace.
        rig.Arr.Now += TimeSpan.FromSeconds(25);
        await Changes(rig.Controller(admin: false), epoch, 0, 0, "movie:tmdb:101", "tv:tvdb:200");
        rig.Arr.Now += TimeSpan.FromSeconds(40);
        await Task.WhenAll(rig.Store.Tick());
        Assert.Equal(reads, rig.Arr.CallCount("sonarr.lan", "/api/v3/episode"));
        // The series page's poll (an episode key of it is enough): its episodes are read again within the minute.
        await Changes(rig.Controller(admin: false), epoch, 0, 0, "tv:tvdb:100:s1:e1");
        rig.Arr.Now += TimeSpan.FromSeconds(5);
        await Task.WhenAll(rig.Store.Tick());
        Assert.Equal(reads + 1, rig.Arr.CallCount("sonarr.lan", "/api/v3/episode"));
    }

    [Fact]
    public async Task TheFeedBootstrapsWaitsWakesFiltersAndResets()
    {
        using var rig = new Rig();
        var c = rig.Controller(admin: false);
        var boot = Body(await c.GetChanges(new ArrChangesRequest(), default));
        var epoch = boot.GetProperty("epoch").GetString();
        Assert.Equal(0, boot.GetProperty("cursor").GetInt64());
        Assert.Equal("no-store", c.Response.Headers.CacheControl.ToString());

        // Nothing changes: the wait ends empty, at the same cursor.
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var idle = await Changes(rig.Controller(admin: false), epoch, 0, 1, "movie:tmdb:101");
        Assert.True(sw.ElapsedMilliseconds >= 900);
        Assert.Equal((0, 0), (idle.GetProperty("cursor").GetInt64(), idle.GetProperty("keys").GetArrayLength()));

        // A change to an asked-for key wakes the wait at once; others are skipped past.
        var waiting = rig.Controller(admin: false).GetChanges(new ArrChangesRequest { Epoch = epoch, Cursor = 0, Wait = 20, Keys = ["movie:tmdb:101", "bogus key"] }, default);
        await Task.Delay(50);
        rig.Feed.Bump(["movie:tmdb:999"]);
        await Task.Delay(50);
        Assert.False(waiting.IsCompleted);
        sw.Restart();
        rig.Feed.Bump(["movie:tmdb:101", "movie:tmdb:102"]);
        var woke = Body(await waiting.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(sw.ElapsedMilliseconds < 2000);
        Assert.Equal(new[] { "movie:tmdb:101" }, woke.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
        Assert.Equal(3, woke.GetProperty("cursor").GetInt64());

        // No keys asked: everything the caller may see. Hidden keys never leave the server.
        rig.Audience.Hidden.Add("movie:tmdb:103");
        rig.Feed.Bump(["movie:tmdb:103", "movie:tmdb:104"]);
        var all = await Changes(rig.Controller(admin: false), epoch, 3, 0);
        Assert.Equal(new[] { "movie:tmdb:104" }, all.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
        var admin = await Changes(rig.Controller(admin: true), epoch, 3, 0);
        Assert.Equal(new[] { "movie:tmdb:103", "movie:tmdb:104" }, admin.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));

        // More keys than one read serves: refused, never answered for part of the list (the
        // cursor would skip past changes to the dropped keys).
        var many = Enumerable.Range(1, ArrChangeFeed.MaxKeysPerRead + 1).Select(i => "movie:tmdb:" + i).ToList();
        var tooMany = await rig.Controller(admin: false).GetChanges(new ArrChangesRequest { Epoch = epoch, Cursor = 3, Wait = 0, Keys = many }, default);
        Assert.Equal(400, Status(tooMany));
        Assert.Equal("too_many_keys", Body(tooMany).GetProperty("code").GetString());
        var exactly = await Changes(rig.Controller(admin: false), epoch, 3, 0, many.Skip(1).ToArray());
        Assert.Equal(new[] { "movie:tmdb:104" }, exactly.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));

        // A change only hidden keys: the caller keeps waiting (and its cursor moves past them).
        rig.Feed.Bump(["movie:tmdb:103"]);
        var hiddenOnly = await Changes(rig.Controller(admin: false), epoch, 5, 0);
        Assert.Equal((6, 0), (hiddenOnly.GetProperty("cursor").GetInt64(), hiddenOnly.GetProperty("keys").GetArrayLength()));

        // Another epoch (a restart) or a cursor from the future: reset.
        Assert.True((await Changes(rig.Controller(admin: false), "old-epoch", 2, 0)).GetProperty("reset").GetBoolean());
        Assert.True((await Changes(rig.Controller(admin: false), epoch, 99, 0)).GetProperty("reset").GetBoolean());

        // The feed never calls an arr, and a waiting browser counts as someone watching.
        var stats = rig.Store.Describe().Routes["acquire/changes"];
        Assert.True(stats.Requests >= 6);
        Assert.Equal(0, stats.UpstreamCalls);
        Assert.Empty(rig.Arr.Calls);
        Assert.NotNull(rig.Store.Describe().Instances.Single().Snapshots.Single(s => s.Kind == ArrSnapshotKind.Queue).LastReadSecondsAgo);
    }

    [Fact]
    public async Task LongPollsAreCappedPerUserAndTheFeedFollowsTheSwitches()
    {
        using var rig = new Rig();
        var epoch = rig.Feed.Epoch;
        using var cancel = new CancellationTokenSource();
        var held = Enumerable.Range(0, ArrFeedLimits.PerUser)
            .Select(_ => rig.Controller(admin: false).GetChanges(new ArrChangesRequest { Epoch = epoch, Cursor = 0, Wait = 25 }, cancel.Token))
            .ToList();
        await Until(() => rig.Limits.Waiting == ArrFeedLimits.PerUser);
        var refused = await rig.Controller(admin: false).GetChanges(new ArrChangesRequest { Epoch = epoch, Cursor = 0, Wait = 25 }, default);
        Assert.Equal(429, Status(refused));
        // Someone else is not affected.
        var other = rig.Controller(admin: false, user: Guid.NewGuid()).GetChanges(new ArrChangesRequest { Epoch = epoch, Cursor = 0, Wait = 0 }, default);
        Assert.Equal(200, Status(await other));
        cancel.Cancel();
        await Task.WhenAll(held);
        Assert.Equal(0, rig.Limits.Waiting);

        rig.Arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = false;
        var off = await rig.Controller(admin: false).GetChanges(new ArrChangesRequest(), default);
        Assert.Equal(403, Status(off));
        Assert.Equal("feature_disabled", Body(off).GetProperty("code").GetString());
    }

    [Fact]
    public async Task TheAudienceShowsTitlesOnlyToPeopleWhoMayOpenThem()
    {
        var visibleTo = new HashSet<string>();   // provider ids / "part" keys signed-in users can open
        var exists = new HashSet<string>();      // ... that are in Jellyfin at all
        var seriesIds = new Dictionary<Guid, string>();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            string key;
            // Any of the ids asked for (Jellyfin matches items carrying any of them).
            if (q.HasAnyProviderId is { Count: > 0 } ids) key = ids.Values.FirstOrDefault(v => (q.User != null ? visibleTo : exists).Contains(v)) ?? ids.Values.First();
            else
            {
                // A season or the episodes of one season of a series (by its Jellyfin id).
                var series = seriesIds[Assert.Single(q.AncestorIds)];
                if (q.IncludeItemTypes.Single() == BaseItemKind.Episode)
                {
                    Assert.Null(q.IndexNumber);
                    var prefix = $"{series}:s{q.ParentIndexNumber}:e";
                    return (q.User != null ? visibleTo : exists).Where(k => k.StartsWith(prefix, StringComparison.Ordinal))
                        .Select(k => (BaseItem)new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = int.Parse(k[prefix.Length..], System.Globalization.CultureInfo.InvariantCulture) }).ToList();
                }
                key = $"{series}:s{q.IndexNumber}";
            }
            var hit = q.User != null ? visibleTo.Contains(key) : exists.Contains(key);
            if (!hit) return new List<BaseItem>();
            if (q.IncludeItemTypes.Single() == BaseItemKind.Series)
            {
                var id = Guid.NewGuid();
                seriesIds[id] = key;
                return new List<BaseItem> { new MediaBrowser.Controller.Entities.TV.Series { Id = id } };
            }
            return new List<BaseItem> { new Movie { Id = Guid.NewGuid() } };
        });
        var users = new Mock<IUserManager>();
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        viewer.SetPermission(PermissionKind.EnableAllFolders, true);
        var kid = new User("kid", "default", "default") { Id = Guid.NewGuid(), MaxParentalRatingScore = 10 };
        var tagged = new User("tagged", "default", "default") { Id = Guid.NewGuid() };
        tagged.SetPreference(PreferenceKind.BlockedTags, ["horror"]);
        var allowList = new User("allow-list", "default", "default") { Id = Guid.NewGuid() };
        allowList.SetPreference(PreferenceKind.AllowedTags, ["kids"]);
        var blockedFolder = new User("blocked-folder", "default", "default") { Id = Guid.NewGuid() };
        blockedFolder.SetPreference(PreferenceKind.BlockedMediaFolders, [Guid.NewGuid().ToString("N")]);
        var limited = new User("limited", "default", "default") { Id = Guid.NewGuid() };
        limited.SetPermission(PermissionKind.EnableAllFolders, false);
        var libA = Guid.NewGuid();
        limited.SetPreference(PreferenceKind.EnabledFolders, [Guid.NewGuid().ToString("N")]);
        foreach (var u in new[] { viewer, kid, tagged, allowList, blockedFolder, limited }) users.Setup(m => m.GetUserById(u.Id)).Returns(u);

        // "Movies" (linked to library A) holds tmdb 3 and 5; "Movies 4K" (no linked library) holds
        // tmdb 5 too; "TV" (no linked library) holds tvdb 4 and 40.
        using var arr = new FakeArr();
        var radarr = arr.Add("radarr.lan", "Radarr");
        radarr.Movies.Add(FakeArr.Movie(1, 3, "Absent"));
        radarr.Movies.Add(FakeArr.Movie(2, 5, "Absent too"));
        var radarr4k = arr.Add("radarr4k.lan", "Radarr");
        radarr4k.Movies.Add(FakeArr.Movie(1, 5, "Absent too"));
        var sonarr = arr.Add("sonarr.lan", "Sonarr");
        sonarr.Series.Add(FakeArr.SeriesRow(1, 4, "Absent show"));
        sonarr.Series.Add(FakeArr.SeriesRow(2, 40, "Show"));
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", RadarrKey), ("Movies 4K", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-ROUTE-KEY-0123456789abc"), ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-ROUTE-KEY-0123456789abcd"));
        var config = arr.Plugin.Plugin.Configuration;
        var rows = ArrRegistryMigration.Parse(config.RadarrInstances)!;
        rows[0].LinkedLibraryIds = [libA.ToString("N")];
        config.RadarrInstances = ArrRegistryMigration.Serialize(rows);
        config.ArrIntegrationEnabled = true;
        var instance = arr.Instance("Movies").Id;
        var instance4k = arr.Instance("Movies 4K").Id;
        var store = arr.Store();
        Assert.NotNull((await store.GetLibraryAsync(arr.Instance("Movies"), default)).Value);
        Assert.NotNull((await store.GetLibraryAsync(arr.Instance("Movies 4K"), default)).Value);
        Assert.NotNull((await store.GetLibraryAsync(arr.Instance("TV"), default)).Value);

        var audience = new ArrFeedAudience(library.Object, users.Object, store);
        visibleTo.Add("1"); exists.Add("1");     // in Jellyfin, users can open it
        exists.Add("2");                          // in Jellyfin, users can't (another library, rating...)
        visibleTo.Add("40"); exists.Add("40");   // a series users can open ...
        visibleTo.Add("40:s1:e1"); exists.Add("40:s1:e1");
        exists.Add("40:s1:e5");                   // ... with an episode Jellyfin hides from them (its own rating or tag)
        exists.Add("40:s3");                      // ... and a hidden season
        var changes = new List<ArrFeedChange>
        {
            new("movie:tmdb:1", 1, instance), new("movie:tmdb:2", 2, instance),
            new("movie:tmdb:3", 3, null),           // a Jellyfin change (no instance) of a title only "Movies" holds
            new("movie:tmdb:9", 4, null),           // a Jellyfin change of a title no instance holds
            new("tv:tvdb:4:s1:e2", 5, null),        // held by "TV" (open to all), not in Jellyfin
            new("tv:tvdb:40:s1:e1", 6, null), new("tv:tvdb:40:s1:e5", 7, null), new("tv:tvdb:40:s2:e1", 8, null), new("tv:tvdb:40:s3", 9, null),
        };

        Assert.Equal(changes.Count, audience.Visible(Guid.NewGuid(), isAdmin: true, changes).Count);
        // Episodes and seasons Jellyfin has are checked themselves; one it doesn't have yet follows its series.
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:3", "tv:tvdb:4:s1:e2", "tv:tvdb:40:s1:e1", "tv:tvdb:40:s2:e1" }, audience.Visible(viewer.Id, false, changes));
        // Any content limit (rating, blocked tags, an allow-list of tags, blocked folders): titles
        // not in Jellyfin are not announced (their rating and tags are unknown).
        var inJellyfinOnly = new[] { "movie:tmdb:1", "tv:tvdb:40:s1:e1", "tv:tvdb:40:s2:e1" };
        Assert.Equal(inJellyfinOnly, audience.Visible(kid.Id, false, changes));
        Assert.Equal(inJellyfinOnly, audience.Visible(tagged.Id, false, changes));
        Assert.Equal(inJellyfinOnly, audience.Visible(allowList.Id, false, changes));
        Assert.Equal(inJellyfinOnly, audience.Visible(blockedFolder.Id, false, changes));
        // A user who can't open the library "Movies" is linked to: its absent titles stay hidden,
        // also when the change came from Jellyfin (no instance) and only "Movies" holds the title.
        Assert.Equal(inJellyfinOnly, audience.Visible(limited.Id, false, changes));
        Assert.Empty(audience.Visible(limited.Id, false, new List<ArrFeedChange> { new("movie:tmdb:5", 5, instance) }));
        // A key changed in two Radarrs: the unlinked, unresolved 4K copy does not bypass library restrictions.
        var feed = new ArrChangeFeed();
        feed.Bump(new[] { "movie:tmdb:5" }, instance4k);
        feed.Bump(new[] { "movie:tmdb:5" }, instance);
        var both = feed.Read(feed.Epoch, 0).Changes;
        Assert.Equal(instance, Assert.Single(both).InstanceId);
        Assert.Empty(audience.Visible(limited.Id, false, both));

        // The same audience (its answers are cached) follows a policy change at once, both ways.
        limited.SetPreference(PreferenceKind.EnabledFolders, [libA.ToString("N")]);
        Assert.Single(audience.Visible(limited.Id, false, new List<ArrFeedChange> { new("movie:tmdb:5", 5, instance) }));
        Assert.Single(audience.Visible(limited.Id, false, new List<ArrFeedChange> { new("movie:tmdb:3", 3, null) }));
        limited.SetPreference(PreferenceKind.EnabledFolders, [Guid.NewGuid().ToString("N")]);
        Assert.Empty(audience.Visible(limited.Id, false, new List<ArrFeedChange> { new("movie:tmdb:5", 5, instance) }));
        // ... and removing linked libraries makes an unresolved instance visible only to users with every library.
        rows[0].LinkedLibraryIds = [];
        config.RadarrInstances = ArrRegistryMigration.Serialize(rows);
        Assert.Empty(audience.Visible(limited.Id, false, new List<ArrFeedChange> { new("movie:tmdb:5", 5, instance) }));
        Assert.Empty(audience.Visible(Guid.NewGuid(), false, changes));   // unknown user

        // Answers are cached while nothing they depend on changes ...
        Assert.DoesNotContain("movie:tmdb:2", audience.Visible(viewer.Id, false, changes));
        visibleTo.Add("2");
        Assert.DoesNotContain("movie:tmdb:2", audience.Visible(viewer.Id, false, changes));
        // ... and decided afresh once Jellyfin's library changed (an item added, updated or removed).
        library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = new Movie { Id = Guid.NewGuid() } });
        Assert.Contains("movie:tmdb:2", audience.Visible(viewer.Id, false, changes));

        // A Jellyfin copy known only by its IMDb id (tt5, as Radarr knows tmdb 5) decides for it:
        // a user with a rating limit hears about it when they can open that copy.
        exists.Add("tt5"); visibleTo.Add("tt5");
        library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = new Movie { Id = Guid.NewGuid() } });
        Assert.Equal(new[] { "movie:tmdb:5" }, audience.Visible(kid.Id, false, new List<ArrFeedChange> { new("movie:tmdb:5", 11, instance) }));
    }

    [Fact]
    public void EpisodesAreCheckedOnlyInTheSeriesCopiesTheUserCanOpen()
    {
        // tvdb 50 is in two libraries: "TV" (the viewer can open it) and "TV 4K" (they can't).
        // With ancestors set, Jellyfin doesn't limit a user's query to their libraries (rating and
        // tags still apply), so this mock answers part lookups that way too.
        var open = Guid.NewGuid();
        var closed = Guid.NewGuid();
        var parts = new Dictionary<Guid, Dictionary<string, bool>>   // part -> hidden by its own tag or rating
        {
            [open] = new() { ["s1:e1"] = false, ["s1:e5"] = true },
            [closed] = new() { ["s1:e5"] = false, ["s3:e1"] = false, ["s3"] = false },
        };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (q.HasAnyProviderId is { Count: > 0 } ids)
            {
                if (ids.Values.Single() != "50") return new List<BaseItem>();
                var copies = q.User != null ? new[] { open } : new[] { open, closed };
                return copies.Select(id => (BaseItem)new MediaBrowser.Controller.Entities.TV.Series { Id = id }).ToList();
            }
            if (q.IncludeItemTypes.Single() == BaseItemKind.Episode)
            {
                // One season's episodes under the copies asked about (the user's: not those hidden from them).
                Assert.Null(q.IndexNumber);
                var prefix = $"s{q.ParentIndexNumber}:e";
                return q.AncestorIds.SelectMany(a => parts[a].Where(p => p.Key.StartsWith(prefix, StringComparison.Ordinal) && (q.User == null || !p.Value)))
                    .Select(p => (BaseItem)new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = int.Parse(p.Key[prefix.Length..], System.Globalization.CultureInfo.InvariantCulture) }).ToList();
            }
            var key = $"s{q.IndexNumber}";
            var hit = q.AncestorIds.Any(a => parts[a].TryGetValue(key, out var hidden) && (q.User == null || !hidden));
            return hit ? new List<BaseItem> { new Movie { Id = Guid.NewGuid() } } : new List<BaseItem>();
        });
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(viewer.Id)).Returns(viewer);
        using var arr = new FakeArr();
        var audience = new ArrFeedAudience(library.Object, users.Object, arr.Store());

        var changes = new List<ArrFeedChange>
        {
            new("tv:tvdb:50:s1:e1", 1, null),   // in their copy, visible
            new("tv:tvdb:50:s1:e5", 2, null),   // hidden in their copy, open in the 4K copy
            new("tv:tvdb:50:s3:e1", 3, null),   // only in the 4K copy
            new("tv:tvdb:50:s3", 4, null),      // only in the 4K copy
            new("tv:tvdb:50:s2:e1", 5, null),   // in no copy yet: follows the series
        };
        Assert.Equal(new[] { "tv:tvdb:50:s1:e1", "tv:tvdb:50:s2:e1" }, audience.Visible(viewer.Id, false, changes));
    }

    // ---------------------------------------------------------------- provisioning

    [Fact]
    public async Task SettingUpTheWebhookNeedsAnAdminConsentAndAnAddress()
    {
        using var rig = new Rig();
        var id = rig.Instance.Id;
        Assert.IsType<ForbidResult>(await rig.Controller(admin: false).ProvisionWebhook(id, new ArrWebhookRequest { Consent = true }, default));
        Assert.IsType<ForbidResult>(await rig.Controller(admin: false).RemoveWebhook(id, new ArrWebhookRequest { Consent = true }, default));
        Assert.IsType<ForbidResult>(rig.Controller(admin: false).ManualWebhook(id, new ArrWebhookRequest()));
        Assert.IsType<ForbidResult>(await rig.Controller(admin: false).GetWebhook(id, default));
        Assert.IsType<ForbidResult>(rig.Controller(admin: false).GetLiveStatus());
        Assert.Equal("consent_required", Body(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = false }, default)).GetProperty("error").GetString());
        Assert.Equal("consent_required", Body(await rig.Controller().RemoveWebhook(id, null, default)).GetProperty("error").GetString());
        foreach (var bad in new[] { "ftp://je.lan", "http://user:pw@je.lan", "http://je.lan/?x=1", "not a url", "http://je.lan#x" })
            Assert.Equal("invalid_jellyfin_url", Body(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, JellyfinUrl = bad }, default)).GetProperty("error").GetString());
        Assert.Equal("unknown_instance", Body(await rig.Controller().ProvisionWebhook("nope", new ArrWebhookRequest { Consent = true }, default)).GetProperty("error").GetString());
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = false;
        Assert.Equal(404, Status(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true }, default)));
        Assert.Equal(200, Status(rig.Controller().GetLiveStatus()));   // status and removal stay available
        rig.Arr.Plugin.Plugin.Configuration.ArrIntegrationEnabled = false;
        Assert.Equal(404, Status(rig.Controller().GetLiveStatus()));
        Assert.Empty(rig.Radarr.Writes);
    }

    [Fact]
    public async Task ProvisioningIsIdempotentRepairsDuplicatesAndIsRemovable()
    {
        using var rig = new Rig();
        var id = rig.Instance.Id;
        var c = rig.Controller();

        var first = Body(await c.ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "click-1" }, default));
        Assert.Equal(("Succeeded", true), (first.GetProperty("status").ToString(), first.GetProperty("confirmed").GetBoolean()));
        Assert.Contains("test event reached Jellyfin", first.GetProperty("readBack").GetString());
        var hook = Assert.Single(rig.Radarr.Notifications);
        var secret = rig.Receiver.EnsureSecret(id);
        Assert.Equal("Jellyfin Enhanced", (string?)hook["name"]);
        Assert.Equal($"http://je.lan:8096/JellyfinEnhanced/arr/hook/{id}", (string?)hook["fields"]![0]!["value"]);
        Assert.Equal(1, (int)hook["fields"]![1]!["value"]!);
        Assert.Equal(secret, Rig.HeaderOf(hook));
        Assert.True((bool)hook["onGrab"]! && (bool)hook["onDownload"]! && (bool)hook["onMovieFileDelete"]! && (bool)hook["onManualInteractionRequired"]!);
        Assert.False((bool)hook["includeHealthWarnings"]!);

        // The same click again: the first outcome, nothing sent. A new click: updated in place.
        Assert.True(Body(await c.ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "click-1" }, default)).GetProperty("replayed").GetBoolean());
        var writes = rig.Radarr.Writes.Count;
        var again = Body(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "click-2" }, default));
        Assert.Equal("Succeeded", again.GetProperty("status").ToString());
        Assert.Contains("test event reached Jellyfin", again.GetProperty("readBack").GetString());   // unchanged, so JE asked for a test
        Assert.Single(rig.Radarr.Notifications);
        Assert.Contains(rig.Radarr.Writes.Skip(writes), w => w.Method == "PUT" && w.Path == "/api/v3/notification/1");
        Assert.Contains(rig.Radarr.Writes.Skip(writes), w => w.Method == "POST" && w.Path == "/api/v3/notification/test");
        Assert.Equal(secret, rig.Receiver.EnsureSecret(id));   // the secret is kept

        // Duplicates (an earlier manual copy) are removed; someone else's "Jellyfin Enhanced" is left alone.
        var copy = (JsonObject)hook.DeepClone();
        copy["id"] = 7;
        rig.Radarr.Notifications.Add(copy);
        rig.Radarr.Notifications.Add(new JsonObject { ["id"] = 8, ["name"] = "Other", ["implementation"] = "Discord", ["fields"] = new JsonArray() });
        await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "click-3" }, default);
        Assert.Equal(new[] { 1, 8 }, rig.Radarr.Notifications.Select(n => (int)n["id"]!));

        var state = Body(await rig.Controller().GetWebhook(id, default));
        Assert.True(state.GetProperty("secretSet").GetBoolean());
        Assert.True(state.GetProperty("webhooks")[0].GetProperty("secretMatches").GetBoolean());

        var removed = Body(await rig.Controller().RemoveWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "rm-1" }, default));
        Assert.Equal(("Succeeded", true), (removed.GetProperty("status").ToString(), removed.GetProperty("confirmed").GetBoolean()));
        Assert.Equal(new[] { 8 }, rig.Radarr.Notifications.Select(n => (int)n["id"]!));
        Assert.False(rig.Receiver.HasSecret(id));
        Assert.Equal(401, Status(await rig.Hook(secret, "{\"eventType\":\"Test\"}")));
        // Removing again finds nothing to remove and still succeeds.
        Assert.Equal("Succeeded", Body(await rig.Controller().RemoveWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "rm-2" }, default)).GetProperty("status").ToString());

        // Set up again (a new secret), then a late retry of the first removal: the runner replays
        // its outcome without touching the arr, and the new secret is kept.
        Assert.Equal("Succeeded", Body(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "click-4" }, default)).GetProperty("status").ToString());
        var renewed = rig.Receiver.EnsureSecret(id);
        Assert.NotEqual(secret, renewed);
        Assert.True(Body(await rig.Controller().RemoveWebhook(id, new ArrWebhookRequest { Consent = true, IdempotencyKey = "rm-1" }, default)).GetProperty("replayed").GetBoolean());
        Assert.True(rig.Receiver.HasSecret(id));
        Assert.Equal(renewed, Rig.HeaderOf(Assert.Single(rig.Radarr.Notifications, n => (string?)n["implementation"] == "Webhook")));
        Assert.IsType<NoContentResult>(await rig.Hook(renewed, "{\"eventType\":\"Test\"}"));

        var audit = File.ReadAllText(rig.AuditPath);
        Assert.Contains("webhook.provision", audit);
        Assert.Contains("webhook.remove", audit);
        foreach (var text in new[] { audit, rig.Logs() })
        {
            Assert.DoesNotContain(secret, text);
            Assert.DoesNotContain(RadarrKey, text);
        }
    }

    [Fact]
    public async Task AWebhookTheArrCantDeliverIsReportedAndNameClashesAvoided()
    {
        using var rig = new Rig();
        var id = rig.Instance.Id;
        rig.Radarr.Notifications.Add(new JsonObject { ["id"] = 3, ["name"] = "Jellyfin Enhanced", ["implementation"] = "Webhook", ["fields"] = new JsonArray(new JsonObject { ["name"] = "url", ["value"] = "http://other-server:8096/JellyfinEnhanced/arr/hook/another-id" }) });
        rig.Radarr.OnNotificationTest = _ => "Unable to send test message: connection refused";
        var failed = Body(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true }, default));
        Assert.Equal("Failed", failed.GetProperty("status").ToString());
        Assert.Contains("Unable to send test message", failed.GetProperty("message").GetString());
        Assert.Single(rig.Radarr.Notifications);

        rig.Radarr.OnNotificationTest = null;
        var ok = Body(await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true, JellyfinUrl = "https://jf.example/base/" }, default));
        Assert.Equal("Succeeded", ok.GetProperty("status").ToString());
        Assert.Contains("did not reach Jellyfin", ok.GetProperty("readBack").GetString());
        var ours = rig.Radarr.Notifications.Single(n => (int)n["id"]! != 3);
        Assert.Equal("Jellyfin Enhanced (jf.example)", (string?)ours["name"]);
        Assert.Equal($"https://jf.example/base/JellyfinEnhanced/arr/hook/{id}", (string?)ours["fields"]![0]!["value"]);
    }

    [Fact]
    public async Task OnlyTheCopyPasteRouteRevealsTheSecretAndItIsAudited()
    {
        using var rig = new Rig();
        var id = rig.Instance.Id;
        await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true }, default);
        var secret = rig.Receiver.EnsureSecret(id);
        await rig.Hook(secret, "{\"eventType\":\"Grab\"}");

        var status = rig.Controller().GetLiveStatus();
        var webhookState = await rig.Controller().GetWebhook(id, default);
        var provision = await rig.Controller().ProvisionWebhook(id, new ArrWebhookRequest { Consent = true }, default);
        foreach (var r in new[] { status, webhookState, provision })
        {
            var json = JsonSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(r).Value);
            Assert.DoesNotContain(secret, json);
            Assert.DoesNotContain(RadarrKey, json);
            Assert.DoesNotContain("radarr.lan", json);
        }
        var live = Body(status);
        Assert.Equal("Grab", live.GetProperty("instances")[0].GetProperty("webhook").GetProperty("lastEventType").GetString());
        Assert.Equal("Off", live.GetProperty("instances")[0].GetProperty("signalR").GetProperty("state").ToString());

        var manual = rig.Controller().ManualWebhook(id, new ArrWebhookRequest());
        var m = Body(manual);
        Assert.Equal(secret, m.GetProperty("headerValue").GetString());
        Assert.Equal(ArrWebhookReceiver.SecretHeader, m.GetProperty("headerName").GetString());
        Assert.Equal($"http://je.lan:8096/JellyfinEnhanced/arr/hook/{id}", m.GetProperty("url").GetString());
        Assert.Contains("On Grab", m.GetProperty("triggers").EnumerateArray().Select(t => t.GetString()));
        var audit = File.ReadAllText(rig.AuditPath);
        Assert.Contains("webhook.manual-setup-shown", audit);
        Assert.DoesNotContain(secret, audit);
        Assert.DoesNotContain(secret, rig.Logs());
    }
}
