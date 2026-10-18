using System.Globalization;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// The Requests page and the Manage drawer (Requests &amp; downloads, phase 1): the switches; each
/// member sees only their own requests, grouped (waiting for an OK, on the way, not out yet, said
/// no; coming soon; ready) with their status; a route scan of every non-admin response; per-user
/// cache isolation; no arr or Seerr call on the request path; a member with content limits still
/// follows what they asked for; a new Seerr request reaching the page through the feed; the
/// Manage drawer (administrators only: explanation, versions across instances, timeline, Seerr's
/// requests) and Search now through the audited action runner; the feed audience for request-list
/// keys and for titles a restricted user asked for.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrRequestsHubTests
{
    private const string Forbidden = "RadarrMainZ|Radarr4kZ|SonarrZ|radarr.lan|radarr4k.lan|sonarr.lan|KEY-0123456789|/data/|Mock SABnzbd|Bluray-1080p|-GRP|SamTheRequester|Approver Name|seerr.lan|SEERR-KEY|\"admin\"";
    private static readonly DateTime Asked = new(2026, 10, 10, 9, 0, 0, DateTimeKind.Utc);

    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Radarr4k { get; }
        public FakeArr.Host Sonarr { get; }
        public FakeSeerr Seerr { get; } = new();
        public ArrStateStore Store { get; }
        public FakeJellyfinView View { get; } = new();
        public SeerrRequestReadModel Requests { get; }
        public ArrStatusService Service { get; }
        public RequestsHubService Hub { get; }
        public ArrManageService Manage { get; }
        public ArrAuditLog Audit { get; }
        public ArrChangeFeed Feed { get; } = new();
        public StatusViewer Admin { get; }
        public StatusViewer Emma { get; }
        public StatusViewer Sam { get; }
        public StatusViewer Kid { get; }
        public Guid Sintel { get; } = Guid.NewGuid();
        public Guid Firefly { get; } = Guid.NewGuid();

        public Rig()
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Radarr4k = Arr.Add("radarr4k.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Arr.Configure(
                ("RadarrMainZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
                ("Radarr4kZ", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"),
                ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            var c = Arr.Plugin.Plugin.Configuration;
            var radarrRows = JsonNode.Parse(c.RadarrInstances)!.AsArray();
            foreach (var row in radarrRows)
            {
                if ((string?)row!["Name"] == "Radarr4kZ") row["Role"] = "4k";
            }
            c.RadarrInstances = radarrRows.ToJsonString();
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrHouseholdContactName = "Dad";
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            c.DownloadsPageEnabled = true;
            c.CalendarPageEnabled = false;

            // Radarr: Sintel on disk; Dune downloading (50 %, Mock SABnzbd, Bluray-1080p); Agent 327 not
            // out until the 20th, with history (added, grabbed). Radarr 4K has none of them.
            Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", path: "/data/movies/Sintel (2010)"));
            Radarr.Movies.Add(FakeArr.Movie(2, 693134, "Dune Part Two", hasFile: false, path: "/data/movies/Dune Part Two (2024)"));
            var agent = FakeArr.Movie(3, 457784, "Agent 327", hasFile: false, digital: "2026-10-20T00:00:00Z");
            agent["isAvailable"] = false;
            agent["added"] = "2026-10-11T08:00:00Z";
            Radarr.Movies.Add(agent);
            var dune = FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two");
            dune["downloadClient"] = "Mock SABnzbd";
            dune["quality"] = new JsonObject { ["quality"] = new JsonObject { ["name"] = "Bluray-1080p" } };
            Radarr.Queue.Add(dune);
            Radarr.History.Add(FakeArr.HistoryRow(2, "grabbed", new DateTime(2026, 10, 12, 10, 0, 0, DateTimeKind.Utc), "dl2", 693134, "Dune Part Two"));
            Sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly"));
            Sonarr.Episodes.Add(new JsonObject { ["id"] = 104, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 4, ["airDateUtc"] = "2002-10-11T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });

            Store = Arr.Store();
            Requests = new SeerrRequestReadModel(Seerr.Transport, Feed, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Service = new ArrStatusService(Store, View, Requests, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, Feed);
            Hub = new RequestsHubService(Service, Requests, () => Arr.Plugin.Plugin.Configuration);
            Audit = new ArrAuditLog(Path.Combine(Arr.Plugin.Core.Root, ArrAuditLog.FileName), 1024 * 1024, 2);
            Manage = new ArrManageService(Service, Arr.Factory, new ArrActionRunner(Audit, new ArrConfirmationTokens()), Audit, Requests, null, Feed, () => Arr.Plugin.Plugin.Configuration, (_, _) => Task.CompletedTask);

            Admin = View.AddUser(admin: true, policy: "same");
            Emma = View.AddUser(admin: false, policy: "same");
            Sam = View.AddUser(admin: false, policy: "same");
            Kid = View.AddUser(admin: false, policy: "kid", parental: true);

            var sintelKey = TitleKey.Parse("movie:tmdb:45745")!;
            View.AddItem(new JfItemRef { ItemId = Sintel, Kind = "movie", Key = sintelKey, Path = "/media/movies/Sintel (2010)/Sintel.mkv", DateCreated = Arr.Now.UtcDateTime.AddDays(-2) });
            View.AddCopy(sintelKey, new JfCopy { ItemId = Sintel, Path = "/media/movies/Sintel (2010)/Sintel.mkv", LibraryName = "Movies", DateCreated = Arr.Now.UtcDateTime.AddDays(-2) });
            var fireflyKey = TitleKey.Parse("tv:tvdb:78874")!;
            View.AddItem(new JfItemRef { ItemId = Firefly, Kind = "series", Key = fireflyKey });
            View.AddCopy(fireflyKey, new JfCopy { ItemId = Firefly, Path = "/media/tv/Firefly", LibraryName = "Shows", DateCreated = Arr.Now.UtcDateTime.AddDays(-60) });
            // Season 1 has been here for a day.
            View.AddEpisode(Firefly, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = Arr.Now.UtcDateTime.AddDays(-1) });

            // Emma: waiting (999), on the way (Dune), not out yet (Agent 327), ready (Sintel), said no (888).
            // Sam: one of his own (777). The kid: a title not in Jellyfin (666).
            Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 999, 1, Emma.UserId, Asked.AddHours(4)));
            Seerr.Requests.Add(FakeSeerr.Request(2, "movie", 693134, 2, Emma.UserId, Asked, Asked.AddHours(1)));
            Seerr.Requests.Add(FakeSeerr.Request(3, "movie", 457784, 2, Emma.UserId, Asked.AddHours(2), Asked.AddHours(3)));
            Seerr.Requests.Add(FakeSeerr.Request(4, "movie", 45745, 5, Emma.UserId, Asked.AddDays(-3), Asked, mediaStatus: 5));
            Seerr.Requests.Add(FakeSeerr.Request(5, "movie", 888, 3, Emma.UserId, Asked.AddHours(1), Asked.AddHours(5)));
            Seerr.Requests.Add(FakeSeerr.Request(6, "movie", 777, 1, Sam.UserId, Asked, userName: "SamTheRequester"));
            Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 666, 1, Kid.UserId, Asked));
            Seerr.Requests.Add(FakeSeerr.Request(8, "tv", 1437, 2, Admin.UserId, Asked, tvdb: 78874, seasons: [1]));
            foreach (var (tmdb, title) in new[] { (999, "Waiting Film"), (693134, "Dune: Part Two"), (457784, "Agent 327"), (45745, "Sintel"), (888, "Said No Film"), (777, "Sam Film"), (666, "Kid Film") })
                Seerr.Movies[tmdb] = new JsonObject { ["title"] = title, ["releaseDate"] = "2024-01-01", ["posterPath"] = $"/p{tmdb}.jpg" };
        }

        public RequestsHubController Controller(StatusViewer? viewer)
        {
            var controller = new RequestsHubController(Hub, Manage) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = viewer == null
                ? new ClaimsPrincipal(new ClaimsIdentity(Array.Empty<Claim>(), "test"))
                : new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.UserId.ToString()), new Claim(ClaimTypes.Role, viewer.IsAdmin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public ArrStatusController StatusController(StatusViewer viewer)
        {
            var controller = new ArrStatusController(Service) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.UserId.ToString())], "test"));
            return controller;
        }

        public void Dispose()
        {
            Requests.Dispose();
            Seerr.Dispose();
            Arr.Dispose();
        }
    }

    private sealed record Reply(int Status, string Body, string? ETag);

    private static async Task<Reply> Send(ControllerBase controller, Func<Task<IActionResult>> call, string? ifNoneMatch = null)
    {
        if (ifNoneMatch != null) controller.HttpContext.Request.Headers["If-None-Match"] = ifNoneMatch;
        var result = await call();
        string? etag = controller.HttpContext.Response.Headers.TryGetValue("ETag", out var e) ? e.ToString() : null;
        return result switch
        {
            FileContentResult file => new Reply(200, Encoding.UTF8.GetString(file.FileContents), etag),
            ObjectResult obj => new Reply(obj.StatusCode ?? 200, JsonSerializer.Serialize(obj.Value), etag),
            StatusCodeResult code => new Reply(code.StatusCode, string.Empty, etag),
            ForbidResult => new Reply(403, string.Empty, etag),
            _ => throw new InvalidOperationException(result.GetType().Name),
        };
    }

    private static Task<Reply> Hub(Rig rig, StatusViewer? viewer, string? ifNoneMatch = null)
    {
        var c = rig.Controller(viewer);
        return Send(c, () => c.GetHub(default), ifNoneMatch);
    }

    private static async Task<Rig> Ready(Action<Rig>? setup = null)
    {
        var rig = new Rig();
        setup?.Invoke(rig);
        Assert.True(await rig.Requests.RefreshAsync(default));
        // Warm the snapshots (the first request waits for background loads, never its own arr calls).
        await Hub(rig, rig.Admin);
        return rig;
    }

    private static JsonElement Root(Reply reply) => JsonDocument.Parse(reply.Body).RootElement;

    private static List<(string Title, string Group, string Stage)> Entries(JsonElement list)
        => list.EnumerateArray().Select(e => (e.GetProperty("title").GetString()!, e.GetProperty("group").GetString()!, e.GetProperty("status").GetProperty("stage").GetString()!)).ToList();

    [Fact]
    public async Task TheHubIsBehindItsSwitchesAndNeedsAUser()
    {
        using var rig = await Ready();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.ArrRequestsHubEnabled = false;
        Assert.Equal(403, (await Hub(rig, rig.Emma)).Status);
        c.ArrRequestsHubEnabled = true;
        c.ArrPhase1Enabled = false;
        Assert.Equal(403, (await Hub(rig, rig.Emma)).Status);
        c.ArrPhase1Enabled = true;
        var anonymous = await Hub(rig, null);
        Assert.Equal((403, "user_required"), (anonymous.Status, Root(anonymous).GetProperty("code").GetString()));
        Assert.Equal(200, (await Hub(rig, rig.Emma)).Status);
    }

    [Fact]
    public async Task EachMemberSeesOnlyTheirOwnRequestsGroupedWithTheirStatus()
    {
        using var rig = await Ready();
        var emma = await Hub(rig, rig.Emma);
        Assert.Equal(200, emma.Status);
        var root = Root(emma);
        Assert.Equal(
            new[] { ("Waiting Film", "needsOk", "asked"), ("Dune: Part Two", "onTheWay", "downloading"), ("Agent 327", "notOut", "notOut"), ("Said No Film", "declined", "notHere") },
            Entries(root.GetProperty("mine")));
        var dune = root.GetProperty("mine")[1];
        Assert.Equal(50, dune.GetProperty("status").GetProperty("progress").GetProperty("percent").GetInt32());
        Assert.Equal("/p693134.jpg", dune.GetProperty("poster").GetString());
        Assert.Equal("approved", dune.GetProperty("request").GetString());
        // Coming soon: Agent 327 on the 20th. Ready: Sintel, with the item to play.
        var soon = root.GetProperty("soon");
        Assert.Equal(("Agent 327", "2026-10-20T00:00:00Z"), (soon[0].GetProperty("title").GetString(), soon[0].GetProperty("nextDate").GetString()));
        var ready = root.GetProperty("ready");
        Assert.Equal(("Sintel", rig.Sintel.ToString("N")), (ready[0].GetProperty("title").GetString(), ready[0].GetProperty("itemId").GetString()));
        Assert.Equal("Dad", root.GetProperty("contact").GetString());
        Assert.False(root.TryGetProperty("admin", out _));

        // Sam sees his own request only; nobody's name or the arrs' details reach either of them.
        var sam = await Hub(rig, rig.Sam);
        Assert.Equal(new[] { ("Sam Film", "needsOk", "asked") }, Entries(Root(sam).GetProperty("mine")));
        foreach (var reply in new[] { emma, sam })
        {
            foreach (var word in Forbidden.Split('|')) Assert.DoesNotContain(word, reply.Body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(rig.Admin.UserId.ToString("N"), reply.Body);
        }
        Assert.DoesNotContain("Sam Film", emma.Body);
        Assert.DoesNotContain("Waiting Film", sam.Body);
    }

    [Fact]
    public async Task TheHubSaysWhenJellyfinEnhancedsOwnRequestListIsTheRequestBackend()
    {
        using var rig = await Ready();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        Assert.False(Root(await Hub(rig, rig.Emma)).GetProperty("seerr").GetProperty("ledger").GetBoolean());
        c.ArrPhase3Enabled = true;
        c.ArrRequestBackend = "je";
        try
        {
            // JE mode: the page doesn't call a missing Seerr a problem (requests come from the ledger).
            Assert.True(Root(await Hub(rig, rig.Emma)).GetProperty("seerr").GetProperty("ledger").GetBoolean());
            c.ArrRequestBackend = "seerr";
            Assert.False(Root(await Hub(rig, rig.Emma)).GetProperty("seerr").GetProperty("ledger").GetBoolean());
        }
        finally
        {
            c.ArrPhase3Enabled = false;
            c.ArrRequestBackend = "seerr";
        }
    }

    [Fact]
    public async Task AdminsGetTheirOwnRequestsPlusTheAdminTabsAndTheReadState()
    {
        using var rig = await Ready();
        var admin = Root(await Hub(rig, rig.Admin));
        Assert.Equal("tv:tvdb:78874", Assert.Single(admin.GetProperty("ready").EnumerateArray()).GetProperty("key").GetString());
        var block = admin.GetProperty("admin");
        Assert.True(block.GetProperty("downloads").GetBoolean());
        Assert.False(block.GetProperty("calendar").GetBoolean());
        Assert.Equal(8, block.GetProperty("seerr").GetProperty("requests").GetInt32());
    }

    [Fact]
    public async Task HubBodiesAreNeverSharedAcrossUsersAndRevalidateWithTheirOwnETag()
    {
        using var rig = await Ready();
        var emma = await Hub(rig, rig.Emma);
        var sam = await Hub(rig, rig.Sam);
        var admin = await Hub(rig, rig.Admin);
        Assert.Equal(3, new[] { emma.ETag, sam.ETag, admin.ETag }.Distinct().Count());
        Assert.Equal(304, (await Hub(rig, rig.Emma, emma.ETag)).Status);
        Assert.Equal(200, (await Hub(rig, rig.Sam, emma.ETag)).Status);
        Assert.Equal(200, (await Hub(rig, rig.Admin, emma.ETag)).Status);
    }

    [Fact]
    public async Task TheHubNeverCallsAnArrOrSeerr()
    {
        using var rig = await Ready();
        await Hub(rig, rig.Emma);
        var arrCalls = rig.Arr.Transport.Calls;
        var seerrCalls = rig.Seerr.Calls.Count;
        for (var i = 0; i < 3; i++)
        {
            await Hub(rig, rig.Emma);
            await Hub(rig, rig.Admin);
            await Hub(rig, rig.Kid);
        }
        Assert.Equal(arrCalls, rig.Arr.Transport.Calls);
        Assert.Equal(seerrCalls, rig.Seerr.Calls.Count);
        var route = rig.Store.Describe().Routes["acquire/hub"];
        Assert.True(route.Requests >= 9);
        Assert.Equal((0L, 0L), (route.RequestsWithUpstreamCalls, route.UpstreamCalls));
    }

    [Fact]
    public async Task AMemberWithContentLimitsFollowsWhatTheyAskedForButLearnsNothingElseByKey()
    {
        using var rig = await Ready();
        var kid = Root(await Hub(rig, rig.Kid));
        Assert.Equal(new[] { ("Kid Film", "needsOk", "asked") }, Entries(kid.GetProperty("mine")));

        async Task<int> Count(string keys, bool detail = false)
        {
            var c = rig.StatusController(rig.Kid);
            var reply = await Send(c, () => c.GetStatuses(null, keys, default, detail));
            return Root(reply).GetProperty("items").GetArrayLength();
        }
        Assert.Equal(1, await Count("movie:tmdb:666"));
        Assert.Equal(1, await Count("movie:tmdb:666", detail: true));
        Assert.Equal(0, await Count("movie:tmdb:777"));
        Assert.Equal(0, await Count("movie:tmdb:777", detail: true));
    }

    [Fact]
    public async Task TheKeyDetailRouteGivesAMovieItsJourneyAndTakesOneKey()
    {
        using var rig = await Ready();
        var c = rig.StatusController(rig.Emma);
        var reply = await Send(c, () => c.GetStatuses(null, "movie:tmdb:693134", default, true));
        var dune = Root(reply).GetProperty("items")[0];
        var journey = dune.GetProperty("journey").EnumerateArray().ToList();
        Assert.Equal("asked", journey[0].GetProperty("stage").GetString());
        Assert.True(journey[0].GetProperty("byYou").GetBoolean());
        Assert.Contains(journey, s => s.GetProperty("stage").GetString() == "downloading" && s.GetProperty("state").GetString() == "current");
        // Sam sees that someone else asked.
        var samC = rig.StatusController(rig.Sam);
        var sam = Root(await Send(samC, () => samC.GetStatuses(null, "movie:tmdb:693134", default, true))).GetProperty("items")[0];
        Assert.False(sam.GetProperty("journey")[0].GetProperty("byYou").GetBoolean());

        var two = rig.StatusController(rig.Emma);
        Assert.Equal(400, (await Send(two, () => two.GetStatuses(null, "movie:tmdb:1,movie:tmdb:2", default, true))).Status);
        var withIds = rig.StatusController(rig.Emma);
        Assert.Equal(400, (await Send(withIds, () => withIds.GetStatuses(rig.Sintel.ToString("N"), "movie:tmdb:1", default, true))).Status);
    }

    [Fact]
    public async Task ANewSeerrRequestReachesTheHubThroughTheFeed()
    {
        using var rig = await Ready();
        var before = await Hub(rig, rig.Emma);
        var cursor = rig.Feed.Cursor;
        rig.Seerr.Requests.Add(FakeSeerr.Request(9, "movie", 45745, 1, rig.Emma.UserId, Asked.AddHours(9)));
        rig.Arr.Now += TimeSpan.FromMinutes(6);
        await rig.Requests.RefreshAsync(default);
        var keys = rig.Feed.Read(rig.Feed.Epoch, cursor).Changes.Select(c => c.Key).ToList();
        Assert.Contains(ArrTitleKey.UserRequests(rig.Emma.UserId), keys);
        Assert.Contains("movie:tmdb:45745", keys);
        Assert.DoesNotContain(ArrTitleKey.UserRequests(rig.Sam.UserId), keys);
        var after = await Hub(rig, rig.Emma);
        Assert.NotEqual(before.ETag, after.ETag);
    }

    private static JsonElement? Find(JsonElement root, string group, string key)
    {
        foreach (var e in root.GetProperty(group).EnumerateArray())
        {
            if (e.GetProperty("key").GetString() == key) return e;
        }
        return null;
    }

    [Fact]
    public async Task ARequestForANewSeasonOfASeriesAlreadyHereFollowsThatSeasonNotTheSeries()
    {
        // Firefly has been in Jellyfin for 60 days (Season 1 since yesterday); Sonarr monitors
        // Season 1 only. Emma asks for Season 2.
        using var rig = await Ready(r =>
        {
            r.Sonarr.Series[0]["seasons"] = new JsonArray(
                new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 1, ["totalEpisodeCount"] = 1 } },
                new JsonObject { ["seasonNumber"] = 2, ["monitored"] = false, ["statistics"] = new JsonObject { ["episodeCount"] = 0, ["episodeFileCount"] = 0, ["totalEpisodeCount"] = 3 } });
            r.Seerr.Requests.Add(FakeSeerr.Request(20, "tv", 1437, 1, r.Emma.UserId, Asked.AddHours(6), tvdb: 78874, seasons: [2]));
            // Sam asked for Seasons 1 and 2 (OK'd): one of them here isn't enough.
            r.Seerr.Requests.Add(FakeSeerr.Request(22, "tv", 1437, 2, r.Sam.UserId, Asked.AddHours(6), Asked.AddHours(7), tvdb: 78874, seasons: [1, 2]));
            r.Seerr.Shows[1437] = new JsonObject { ["name"] = "Firefly", ["firstAirDate"] = "2002-09-20" };
        });
        const string firefly = "tv:tvdb:78874";
        var pending = Root(await Hub(rig, rig.Emma));
        var waiting = Find(pending, "mine", firefly);
        Assert.NotNull(waiting);
        Assert.Equal(("needsOk", "asked"), (waiting!.Value.GetProperty("group").GetString(), waiting.Value.GetProperty("status").GetProperty("stage").GetString()));
        Assert.Null(Find(pending, "ready", firefly));
        var sam = Root(await Hub(rig, rig.Sam));
        Assert.Equal("onTheWay", Find(sam, "mine", firefly)!.Value.GetProperty("group").GetString());
        Assert.Null(Find(sam, "ready", firefly));

        // OK'd, Sonarr not on it yet: on the way, not ready.
        rig.Seerr.Requests.Single(r => (int)r["id"]! == 20)["status"] = 2;
        rig.Seerr.Requests.Single(r => (int)r["id"]! == 20)["updatedAt"] = Asked.AddHours(7).ToString("o");
        rig.Arr.Now += TimeSpan.FromMinutes(6);
        await rig.Requests.RefreshAsync(default);
        var approved = Root(await Hub(rig, rig.Emma));
        var onTheWay = Find(approved, "mine", firefly);
        Assert.NotNull(onTheWay);
        Assert.Equal(("onTheWay", "approved"), (onTheWay!.Value.GetProperty("group").GetString(), onTheWay.Value.GetProperty("status").GetProperty("stage").GetString()));
        Assert.Null(Find(approved, "ready", firefly));

        // Season 2 arrives an hour ago: Ready, arrived when Season 2 did (not 60 days ago).
        var arrived = rig.Arr.Now.UtcDateTime.AddHours(-1);
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = arrived });
        rig.View.Rev++;
        var here = Root(await Hub(rig, rig.Emma));
        var ready = Find(here, "ready", firefly);
        Assert.NotNull(ready);
        Assert.Equal(arrived, ready!.Value.GetProperty("readyAt").GetDateTime().ToUniversalTime());
        Assert.Null(Find(here, "mine", firefly));
        Assert.NotNull(Find(Root(await Hub(rig, rig.Sam)), "ready", firefly));
    }

    [Fact]
    public async Task AFourKRequestForAMovieHereInStandardQualityFollowsTheFourKCopy()
    {
        // Sintel is in Jellyfin in standard quality; Sam asks for it in 4K. Radarr 4K doesn't have it.
        using (var rig = await Ready(r => r.Seerr.Requests.Add(FakeSeerr.Request(21, "movie", 45745, 1, r.Sam.UserId, Asked.AddHours(6), is4k: true))))
        {
            var sam = Root(await Hub(rig, rig.Sam));
            var entry = Find(sam, "mine", "movie:tmdb:45745");
            Assert.NotNull(entry);
            Assert.Equal(("needsOk", "asked"), (entry!.Value.GetProperty("group").GetString(), entry.Value.GetProperty("status").GetProperty("stage").GetString()));
            Assert.Null(Find(sam, "ready", "movie:tmdb:45745"));
            // The 4K card never links to the standard copy (Play would open the HD item).
            Assert.False(entry.Value.TryGetProperty("itemId", out _));
            // Emma's own (standard) Sintel request is still ready for her.
            Assert.NotNull(Find(Root(await Hub(rig, rig.Emma)), "ready", "movie:tmdb:45745"));
        }

        // Radarr 4K has it and Jellyfin has the 4K copy since three hours ago: Ready, arrived then.
        DateTime fourKAt = default;
        var fourKItem = Guid.NewGuid();
        using (var rig = await Ready(r =>
        {
            fourKAt = r.Arr.Now.UtcDateTime.AddHours(-3);
            r.Radarr4k.Movies.Add(FakeArr.Movie(9, 45745, "Sintel", path: "/data/movies4k/Sintel (2010)"));
            var key = TitleKey.Parse("movie:tmdb:45745")!;
            r.View.AddCopy(key, new JfCopy { ItemId = fourKItem, Path = "/media/movies4k/Sintel (2010)/Sintel.mkv", LibraryName = "Movies 4K", DateCreated = fourKAt });
            r.View.AddSource(fourKItem, 3840, 2160, created: fourKAt);
            r.Seerr.Requests.Add(FakeSeerr.Request(21, "movie", 45745, 2, r.Sam.UserId, Asked.AddHours(6), Asked.AddHours(7), is4k: true));
        }))
        {
            var ready = Find(Root(await Hub(rig, rig.Sam)), "ready", "movie:tmdb:45745");
            Assert.NotNull(ready);
            Assert.Equal(fourKAt, ready!.Value.GetProperty("readyAt").GetDateTime().ToUniversalTime());
            // Play opens the 4K copy, not the standard one listed first.
            Assert.Equal(fourKItem.ToString("N"), ready.Value.GetProperty("itemId").GetString());
        }
    }

    [Fact]
    public async Task AFourKListEntryFollowsTheFourKCopyNotTheStandardOneJellyfinHas()
    {
        // Sintel is in Jellyfin (and the standard Radarr) in standard quality, from Emma's standard request; Radarr 4K
        // doesn't have it and nobody asked for 4K.
        using var rig = await Ready();
        var lists = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ArrListStatusSource(rig.Service, rig.View);
        var key = TitleKey.Parse("movie:tmdb:45745")!;
        var fourK = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusPart(key, null, true);

        var standard = await lists.StatusesAsync(rig.Emma.UserId, new[] { key }, default);
        Assert.Equal("ready", standard[key.ToString()].GetProperty("stage").GetString());
        var part = (await lists.PartStatusesAsync(rig.Emma.UserId, new[] { fourK }, default))[fourK.Id];
        Assert.NotEqual(key.ToString(), fourK.Id);
        Assert.NotEqual("ready", part.GetProperty("stage").GetString());
        // Her fulfilled standard request says nothing about the 4K copy.
        Assert.NotEqual("ready", part.GetProperty("reason").GetProperty("code").GetString());
    }

    [Fact]
    public async Task AFourKListEntryFollowsTheFourKAskOnly()
    {
        // Sam asks for Sintel in 4K: the 4K entry waits for its OK; the standard entry stays Ready.
        using var rig = await Ready(r => r.Seerr.Requests.Add(FakeSeerr.Request(21, "movie", 45745, 1, r.Sam.UserId, Asked.AddHours(6), is4k: true)));
        var lists = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ArrListStatusSource(rig.Service, rig.View);
        var key = TitleKey.Parse("movie:tmdb:45745")!;
        var fourK = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusPart(key, null, true);

        var part = (await lists.PartStatusesAsync(rig.Sam.UserId, new[] { fourK }, default))[fourK.Id];
        Assert.Equal("asked", part.GetProperty("stage").GetString());
        Assert.Equal("ready", (await lists.StatusesAsync(rig.Sam.UserId, new[] { key }, default))[key.ToString()].GetProperty("stage").GetString());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AFourKListEntryReadsSeerrsAvailabilityLikeTheRequestsPageWithNoFourKInstance(bool fourKSource)
    {
        // No 4K Radarr in Jellyfin Enhanced; Sam's 4K Sintel request is OK'd and Seerr says the 4K copy is available,
        // matched to a Jellyfin item Sam can open. A 4K copy is one with a 4K source (D44, the edition core): with its
        // 2160p file the Requests page shows it ready, without one it doesn't. The 4K list entry must say the same.
        var fourKItem = Guid.NewGuid();
        using var rig = await Ready(r =>
        {
            Roles(r, radarr4k: false, sonarr4k: false);
            var request = FakeSeerr.Request(21, "movie", 45745, 2, r.Sam.UserId, Asked.AddHours(6), Asked.AddHours(7), is4k: true);
            request["media"]!["status4k"] = 5;
            request["media"]!["jellyfinMediaId4k"] = fourKItem.ToString("N");
            r.Seerr.Requests.Add(request);
            r.View.AddCopy(TitleKey.Parse("movie:tmdb:45745")!, new JfCopy { ItemId = fourKItem, Path = "/media/movies4k/Sintel (2010)/Sintel.mkv", LibraryName = "Movies 4K", DateCreated = Asked.AddHours(7) });
            if (fourKSource) r.View.AddSource(fourKItem, 3840, 2160, created: Asked.AddHours(7));
        });
        var page = Root(await Hub(rig, rig.Sam));
        var row = Find(page, "ready", "movie:tmdb:45745");
        var lists = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ArrListStatusSource(rig.Service, rig.View);
        var key = TitleKey.Parse("movie:tmdb:45745")!;
        var fourK = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusPart(key, null, true);

        var part = (await lists.PartStatusesAsync(rig.Sam.UserId, new[] { fourK }, default))[fourK.Id];

        if (fourKSource)
        {
            Assert.NotNull(row);
            Assert.Equal(row!.Value.GetProperty("status").GetProperty("stage").GetString(), part.GetProperty("stage").GetString());
            Assert.Equal("ready", part.GetProperty("stage").GetString());
        }
        else
        {
            Assert.Null(row);
            var mine = Find(page, "mine", "movie:tmdb:45745");
            Assert.NotNull(mine);
            Assert.Equal(mine!.Value.GetProperty("status").GetProperty("stage").GetString(), part.GetProperty("stage").GetString());
            Assert.NotEqual("ready", part.GetProperty("stage").GetString());
        }
    }

    [Fact]
    public async Task AnExactEpisodeListEntryFollowsThoseEpisodesOnly()
    {
        // Firefly: S1E1 is in Jellyfin; S1E4 is monitored in Sonarr with no file yet.
        using var rig = await Ready();
        var lists = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ArrListStatusSource(rig.Service, rig.View);
        var key = TitleKey.Parse("tv:tvdb:78874")!;
        var first = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusPart(key, null, false, new[] { (1, 1) });
        var fourth = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusPart(key, null, false, new[] { (1, 4) });

        var statuses = await lists.PartStatusesAsync(rig.Admin.UserId, new[] { first, fourth }, default);

        Assert.Equal(("tv:tvdb:78874:s1:e1", "tv:tvdb:78874:s1:e4"), (first.Id, fourth.Id));
        Assert.Equal("ready", statuses[first.Id].GetProperty("stage").GetString());
        Assert.NotEqual("ready", statuses[fourth.Id].GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AListSeasonEntryOfAShowNoSonarrHoldsIsOutOnceItsEpisodesAired()
    {
        // Game of Thrones is in no Sonarr and not in Jellyfin; its first season aired in 2011.
        using var rig = await Ready();
        var lists = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ArrListStatusSource(rig.Service, rig.View);
        var key = TitleKey.Parse("tv:tvdb:121361")!;
        var aired = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusSeason(key, 1399, 1, new (int, DateTime?)[] { (1, new DateTime(2011, 4, 17)), (2, new DateTime(2011, 4, 24)) }, Released: true);
        var unknown = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusSeason(key, 1399, 2, Array.Empty<(int, DateTime?)>(), Released: true);
        var future = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusSeason(key, 1399, 9, new (int, DateTime?)[] { (1, new DateTime(2099, 1, 1)) }, Released: false);

        var statuses = await lists.SeasonStatusesAsync(rig.Admin.UserId, new[] { aired, unknown, future }, default);

        var first = statuses[Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusKeys.SeasonId(key, 1)];
        Assert.NotEqual("notOut", first.GetProperty("stage").GetString());
        Assert.Equal(2, first.GetProperty("summary").GetProperty("aired").GetInt32());
        // A season that premiered but whose episodes aren't known yet has no status rather than "not out yet".
        Assert.False(statuses.ContainsKey(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusKeys.SeasonId(key, 2)));
        Assert.Equal("notOut", statuses[Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListStatusKeys.SeasonId(key, 9)].GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AFourKRequestAfterTheStandardCopyArrivedIsItsOwnEditionNotShownReadyByTheStandardCopy()
    {
        // Emma's standard Sintel is here (Ready); she then asks Seerr for the 4K copy, which Radarr 4K doesn't have.
        using var rig = await Ready(r => r.Seerr.Requests.Add(FakeSeerr.Request(22, "movie", 45745, 1, r.Emma.UserId, Asked.AddHours(6), is4k: true)));
        var emma = Root(await Hub(rig, rig.Emma));
        // Each edition keeps its row: standard Ready and 4K waiting, without the standard copy's Play.
        Assert.NotNull(Find(emma, "ready", "movie:tmdb:45745"));
        var entry = Find(emma, "mine", "movie:tmdb:45745");
        Assert.NotNull(entry);
        Assert.Equal(("needsOk", "asked", true), (entry!.Value.GetProperty("group").GetString(), entry.Value.GetProperty("status").GetProperty("stage").GetString(), entry.Value.GetProperty("is4k").GetBoolean()));
        Assert.False(entry.Value.TryGetProperty("itemId", out _));
        Assert.Single(emma.GetProperty("mine").EnumerateArray(), e => e.GetProperty("key").GetString() == "movie:tmdb:45745");

    }

    [Fact]
    public async Task AnOkdFourKRequestNoFourKRadarrHoldsIsFlaggedOnTheCardAndListedInNeedsAttention()
    {
        // Sintel: in the standard Radarr (and Jellyfin); the admin's 4K request was OK'd two days
        // ago and the 4K Radarr never got it. Phase 2 on.
        using var rig = await Ready(r =>
        {
            r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
            r.Seerr.Requests.Add(FakeSeerr.Request(21, "movie", 45745, 2, r.Admin.UserId, Asked.AddHours(6), Asked.AddHours(7), is4k: true, userName: "AdminAsks"));
        });
        var card = Find(Root(await Hub(rig, rig.Admin)), "mine", "movie:tmdb:45745");
        Assert.NotNull(card);
        var status = card!.Value.GetProperty("status");
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, status.GetProperty("reason").GetProperty("code").GetString());
        Assert.True(status.GetProperty("admin").GetProperty("approvedNotIn4k").GetBoolean());
        Assert.True(status.GetProperty("admin").TryGetProperty("approvedNotInArrSince", out _));

        // The Overview lists it too, as a 4K row (the standard Radarr holding the title doesn't count).
        var hub = new ArrAdminHubService(rig.Store, null!, rig.Requests, null, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now);
        var handoff = Assert.Single(hub.Handoffs(rig.Arr.Now.UtcDateTime, TimeSpan.FromMinutes(15)), h => h.Key == "movie:tmdb:45745");
        Assert.True(handoff.FourK);
        var row = Assert.Single(NeedsAttention.Derive(rig.Arr.Now.UtcDateTime, 10, 10, Array.Empty<AttentionInstance>(), Array.Empty<BridgeMissing>(), new[] { handoff }));
        Assert.Equal("4k", row.Params!["variant"]);
    }

    [Fact]
    public async Task AnOkdSeriesRequestIsNotFlaggedWhenNoSonarrIsSetUpInJellyfinEnhanced()
    {
        // Seerr sends TV to a Sonarr of its own; Jellyfin Enhanced has only Radarr instances.
        using var rig = await Ready(r =>
        {
            r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
            r.Arr.Configure(
                ("RadarrMainZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
                ("Radarr4kZ", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"));
            r.Seerr.Requests.Add(FakeSeerr.Request(31, "tv", 1399, 2, r.Admin.UserId, Asked, Asked.AddHours(1), tvdb: 121361, seasons: [1]));
        });
        var card = Find(Root(await Hub(rig, rig.Admin)), "mine", "tv:tvdb:121361");
        Assert.NotNull(card);
        Assert.Equal(StatusReasonCode.Approved, card!.Value.GetProperty("status").GetProperty("reason").GetProperty("code").GetString());
        var hub = new ArrAdminHubService(rig.Store, null!, rig.Requests, null, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now);
        Assert.DoesNotContain(hub.Handoffs(rig.Arr.Now.UtcDateTime, TimeSpan.FromMinutes(15)), h => h.Key == "tv:tvdb:121361");
    }

    [Fact]
    public async Task EachVariantOfARequestIsJudgedOnItsOwnInstances()
    {
        // The Matrix: only the 4K Radarr holds it. Emma's standard request (OK'd two days ago) is in
        // no standard Radarr: listed, as a standard row. Sam's 4K request is held: not listed.
        // Agent 327's standard request is in the standard Radarr, but its 4K request (OK'd) is in no
        // 4K Radarr: the finished standard request doesn't hide the stuck 4K one.
        using var rig = await Ready(r =>
        {
            r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
            r.Radarr4k.Movies.Add(FakeArr.Movie(5, 603, "The Matrix", path: "/data/movies4k/The Matrix (1999)"));
            r.Seerr.Requests.Add(FakeSeerr.Request(51, "movie", 603, 2, r.Emma.UserId, Asked, Asked.AddHours(1), userName: "EmmaAsks"));
            r.Seerr.Requests.Add(FakeSeerr.Request(52, "movie", 603, 2, r.Sam.UserId, Asked, Asked.AddHours(1), is4k: true));
            r.Seerr.Requests.Add(FakeSeerr.Request(53, "movie", 457784, 2, r.Sam.UserId, Asked, Asked.AddHours(1), is4k: true, userName: "SamAsks"));
        });
        await Hub(rig, rig.Emma);   // reads both Radarr libraries
        var hub = new ArrAdminHubService(rig.Store, null!, rig.Requests, null, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now);
        var handoffs = hub.Handoffs(rig.Arr.Now.UtcDateTime, TimeSpan.FromMinutes(15));
        Assert.Contains(handoffs, h => h.Key == "movie:tmdb:603" && !h.FourK);
        Assert.DoesNotContain(handoffs, h => h.Key == "movie:tmdb:603" && h.FourK);
        Assert.Contains(handoffs, h => h.Key == "movie:tmdb:457784" && h.FourK);
        Assert.DoesNotContain(handoffs, h => h.Key == "movie:tmdb:457784" && !h.FourK);
        // The rows of one title's two variants are two rows with their own ids; the 4K one says so.
        var items = NeedsAttention.Derive(rig.Arr.Now.UtcDateTime, 10, 10, Array.Empty<AttentionInstance>(), Array.Empty<BridgeMissing>(), new[]
        {
            new HandoffFact("movie:tmdb:1", "X", null, true, rig.Arr.Now.UtcDateTime, null),
            new HandoffFact("movie:tmdb:1", "X", null, true, rig.Arr.Now.UtcDateTime, null, FourK: true),
        });
        Assert.Equal(2, items.Select(i => i.Id).Distinct().Count());
        Assert.Equal("4k", Assert.Single(items, i => i.Params != null).Params!["variant"]);
    }

    [Fact]
    public async Task AnOkdFourKSeriesRequestIsJudgedOnTheFourKSonarrOnTheCardAndInNeedsAttention()
    {
        // Spaced: in the standard Sonarr, not in the 4K one; the admin's 4K request for Season 1 was
        // OK'd two days ago. Phase 2 on.
        using var rig = await Ready(r =>
        {
            Roles(r, radarr4k: true, sonarr4k: true);
            r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
            r.Sonarr.Series.Add(FakeArr.SeriesRow(2, 72658, "Spaced"));
            r.Seerr.Requests.Add(FakeSeerr.Request(41, "tv", 4000, 2, r.Admin.UserId, Asked, Asked.AddHours(1), tvdb: 72658, is4k: true, seasons: [1], userName: "AdminAsks"));
        });
        var card = Find(Root(await Hub(rig, rig.Admin)), "mine", "tv:tvdb:72658");
        Assert.NotNull(card);
        var status = card!.Value.GetProperty("status");
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, status.GetProperty("reason").GetProperty("code").GetString());
        Assert.True(status.GetProperty("admin").GetProperty("approvedNotIn4k").GetBoolean());

        // The Overview lists the same 4K row (the standard Sonarr holding the series doesn't count).
        var hub = new ArrAdminHubService(rig.Store, null!, rig.Requests, null, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now);
        var handoff = Assert.Single(hub.Handoffs(rig.Arr.Now.UtcDateTime, TimeSpan.FromMinutes(15)), h => h.Key == "tv:tvdb:72658");
        Assert.True(handoff.FourK);

        // The standard Sonarr's latest read fails: that says nothing about the 4K copy, so the card
        // and the Overview still agree.
        rig.Sonarr.FailWith = 503;
        Assert.False((await rig.Store.RefreshLibraryNowAsync(rig.Arr.Instance("SonarrZ"), default)).Ok);
        var again = Find(Root(await Hub(rig, rig.Admin)), "mine", "tv:tvdb:72658")!.Value.GetProperty("status");
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, again.GetProperty("reason").GetProperty("code").GetString());
        Assert.True(again.GetProperty("admin").GetProperty("approvedNotIn4k").GetBoolean());
        Assert.Contains(hub.Handoffs(rig.Arr.Now.UtcDateTime, TimeSpan.FromMinutes(15)), h => h.Key == "tv:tvdb:72658" && h.FourK);
    }

    [Fact]
    public async Task AnOkdFourKRequestWithNoFourKRadarrSetUpCarriesNoHandoffLineAndNoNeedsAttentionRow()
    {
        // Only standard Radarrs in Jellyfin Enhanced, neither has The Matrix; the admin's 4K request
        // was OK'd two days ago. The standard Radarr says nothing about the 4K copy.
        using var rig = await Ready(r =>
        {
            Roles(r, radarr4k: false, sonarr4k: false);
            r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
            r.Seerr.Requests.Add(FakeSeerr.Request(42, "movie", 603, 2, r.Admin.UserId, Asked, Asked.AddHours(1), is4k: true, userName: "AdminAsks"));
        });
        var card = Find(Root(await Hub(rig, rig.Admin)), "mine", "movie:tmdb:603");
        Assert.NotNull(card);
        var status = card!.Value.GetProperty("status");
        Assert.Equal(StatusReasonCode.Approved, status.GetProperty("reason").GetProperty("code").GetString());
        Assert.False(status.TryGetProperty("admin", out var admin) && admin.ValueKind == JsonValueKind.Object && admin.TryGetProperty("approvedNotInArrSince", out var since) && since.ValueKind != JsonValueKind.Null);
        var hub = new ArrAdminHubService(rig.Store, null!, rig.Requests, null, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now);
        Assert.DoesNotContain(hub.Handoffs(rig.Arr.Now.UtcDateTime, TimeSpan.FromMinutes(15)), h => h.Key == "movie:tmdb:603");
    }

    /// <summary>Sintel's (standard) Jellyfin copy arrived <paramref name="days"/> days from now.</summary>
    private static void SintelSince(Rig r, int days)
    {
        var old = r.View.CopiesByKey["movie:tmdb:45745"][0].Copy;
        r.View.CopiesByKey["movie:tmdb:45745"][0] = (new JfCopy { ItemId = old.ItemId, Path = old.Path, LibraryName = old.LibraryName, DateCreated = r.Arr.Now.UtcDateTime.AddDays(days) }, null);
    }

    /// <summary>Firefly S1E1 arrived in Jellyfin <paramref name="days"/> days from now.</summary>
    private static void FireflyS1Since(Rig r, int days)
    {
        var old = r.View.EpisodesBySeries[r.Firefly][0].Episode;
        r.View.EpisodesBySeries[r.Firefly][0] = (new JfEpisode { ItemId = old.ItemId, Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(days) }, null);
    }

    /// <summary>Sets the instances' roles (and adds a 4K Sonarr when asked) before anything is read.</summary>
    private static FakeArr.Host? Roles(Rig r, bool radarr4k, bool sonarr4k)
    {
        FakeArr.Host? host = null;
        var rows = new List<(string, ArrKind, string, string)>
        {
            ("RadarrMainZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
            ("Radarr4kZ", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"),
            ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"),
        };
        if (sonarr4k)
        {
            host = r.Arr.Add("sonarr4k.lan", "Sonarr");
            rows.Add(("Sonarr4kZ", ArrKind.Sonarr, "http://sonarr4k.lan:8989", "SONARR4K-KEY-0123456789"));
        }
        r.Arr.Configure(rows.ToArray());
        var c = r.Arr.Plugin.Plugin.Configuration;
        string Role(string json, string name, bool fourK)
        {
            var list = JsonNode.Parse(json)!.AsArray();
            foreach (var row in list)
            {
                if ((string?)row!["Name"] == name) row["Role"] = fourK ? "4k" : "standard";
            }
            return list.ToJsonString();
        }
        c.RadarrInstances = Role(c.RadarrInstances, "Radarr4kZ", radarr4k);
        if (sonarr4k) c.SonarrInstances = Role(c.SonarrInstances, "Sonarr4kZ", true);
        return host;
    }

    [Fact]
    public async Task AFourKRequestWithNoFourKInstanceSetUpFollowsTheRequestNotTheStandardCopy()
    {
        // Seerr has a 4K Radarr, Jellyfin Enhanced only standard ones. Sintel has been in Jellyfin
        // in HD for 60 days; Sam's 4K request for it waits for an OK.
        using (var rig = await Ready(r =>
        {
            Roles(r, radarr4k: false, sonarr4k: false);
            SintelSince(r, -60);
            r.Seerr.Requests.Add(FakeSeerr.Request(21, "movie", 45745, 1, r.Sam.UserId, Asked.AddHours(6), is4k: true));
        }))
        {
            var sam = Root(await Hub(rig, rig.Sam));
            var entry = Find(sam, "mine", "movie:tmdb:45745");
            Assert.NotNull(entry);
            Assert.Equal(("needsOk", "asked"), (entry!.Value.GetProperty("group").GetString(), entry.Value.GetProperty("status").GetProperty("stage").GetString()));
            Assert.Null(Find(sam, "ready", "movie:tmdb:45745"));
            Assert.False(entry.Value.TryGetProperty("itemId", out _));
        }

        // OK'd, and Seerr says the 4K copy is available, but the only copy Sam can open is the HD one: not Ready
        // (D44: a 4K request needs a 4K source the viewer can open; Seerr's word alone is not one).
        DateTime availableAt = default;
        using (var rig = await Ready(r =>
        {
            Roles(r, radarr4k: false, sonarr4k: false);
            availableAt = r.Arr.Now.UtcDateTime.AddHours(-2);
            SintelSince(r, -60);
            var request = FakeSeerr.Request(21, "movie", 45745, 2, r.Sam.UserId, Asked.AddHours(6), availableAt, is4k: true);
            request["media"]!["status4k"] = 5;
            r.Seerr.Requests.Add(request);
        }))
        {
            var sam = Root(await Hub(rig, rig.Sam));
            Assert.Null(Find(sam, "ready", "movie:tmdb:45745"));
            // Never the standard copy's Play.
            Assert.False(Find(sam, "mine", "movie:tmdb:45745")!.Value.TryGetProperty("itemId", out _));
        }

        // The 4K copy is in Jellyfin (Movies 4K, a 2160p file since three hours ago): Ready, arrived then, Play opens it
        // although Seerr names no item.
        var fourK = Guid.NewGuid();
        DateTime fourKAt = default;
        using (var rig = await Ready(r =>
        {
            Roles(r, radarr4k: false, sonarr4k: false);
            availableAt = r.Arr.Now.UtcDateTime.AddHours(-2);
            fourKAt = r.Arr.Now.UtcDateTime.AddHours(-3);
            SintelSince(r, -60);
            r.View.AddCopy(TitleKey.Parse("movie:tmdb:45745")!, new JfCopy { ItemId = fourK, Path = "/media/movies4k/Sintel (2010)/Sintel.mkv", LibraryName = "Movies 4K", DateCreated = fourKAt });
            r.View.AddSource(fourK, 3840, 2160, created: fourKAt);
            var request = FakeSeerr.Request(21, "movie", 45745, 2, r.Sam.UserId, Asked.AddHours(6), availableAt, is4k: true);
            request["media"]!["status4k"] = 5;
            r.Seerr.Requests.Add(request);
        }))
        {
            var ready = Find(Root(await Hub(rig, rig.Sam)), "ready", "movie:tmdb:45745");
            Assert.NotNull(ready);
            Assert.Equal(fourKAt, ready!.Value.GetProperty("readyAt").GetDateTime().ToUniversalTime());
            Assert.Equal(fourK.ToString("N"), ready.Value.GetProperty("itemId").GetString());
        }
    }

    [Fact]
    public async Task PlayOnAFourKCardOpensACopyWithA4kSourceTheViewerCanOpenSeerrsFirst()
    {
        var fourK = Guid.NewGuid();
        // No 4K instance in Jellyfin Enhanced; Seerr says the 4K copy is available (and may name its item). A 4K copy
        // is one with a 4K source (D44): Movies 4K's 2160p file, or Sintel's own item once it holds a 2160p version.
        async Task<JsonElement?> ReadyFor(Guid? seerrItem, bool visible, bool is4k = true, bool mergedWithSintel = false)
        {
            using var rig = await Ready(r =>
            {
                if (mergedWithSintel)
                {
                    seerrItem = r.Sintel;
                    r.View.AddSource(r.Sintel, 1920, 1080);
                    r.View.AddSource(r.Sintel, 3840, 2160);
                }
                Roles(r, radarr4k: false, sonarr4k: false);
                SintelSince(r, -60);
                r.View.AddCopy(TitleKey.Parse("movie:tmdb:45745")!, new JfCopy { ItemId = fourK, Path = "/media/movies4k/Sintel (2010)/Sintel.mkv", LibraryName = "Movies 4K", DateCreated = r.Arr.Now.UtcDateTime.AddHours(-2) }, visible ? Array.Empty<Guid>() : new[] { r.Admin.UserId });
                r.View.AddSource(fourK, 3840, 2160);
                var request = FakeSeerr.Request(21, "movie", 45745, 2, r.Sam.UserId, Asked.AddHours(6), r.Arr.Now.UtcDateTime.AddHours(-2), is4k: is4k);
                request["media"]![is4k ? "status4k" : "status"] = 5;
                if (seerrItem is Guid id) request["media"]![is4k ? "jellyfinMediaId4k" : "jellyfinMediaId"] = id.ToString();
                r.Seerr.Requests.Add(request);
            });
            return Find(Root(await Hub(rig, rig.Sam)), "ready", "movie:tmdb:45745");
        }
        // A separate 4K copy the viewer can open: Play opens it.
        Assert.Equal(fourK.ToString("N"), (await ReadyFor(fourK, visible: true))!.Value.GetProperty("itemId").GetString());
        // Merged versions (Seerr names the one item that holds both): that item, before the other 4K copy.
        var merged = await ReadyFor(null, visible: true, mergedWithSintel: true);
        Assert.NotEqual(fourK.ToString("N"), merged!.Value.GetProperty("itemId").GetString());
        // Seerr names no item: the copy with the 4K source.
        Assert.Equal(fourK.ToString("N"), (await ReadyFor(null, visible: true))!.Value.GetProperty("itemId").GetString());
        // The only 4K copy is in a library the viewer can't open: not Ready for them, and never the HD copy's Play.
        Assert.Null(await ReadyFor(fourK, visible: false));
        // An id Seerr names that isn't a copy of the title: ignored; the copy with the 4K source is opened.
        Assert.Equal(fourK.ToString("N"), (await ReadyFor(Guid.NewGuid(), visible: true))!.Value.GetProperty("itemId").GetString());
    }

    [Fact]
    public void SeerrsJellyfinItemOfTheVariantAskedForIsRead()
    {
        var item = Guid.NewGuid();
        var std = Guid.NewGuid();
        var json = FakeSeerr.Request(1, "movie", 603, 2, Guid.NewGuid(), Asked, is4k: true);
        json["media"]!["jellyfinMediaId"] = std.ToString("N");
        json["media"]!["jellyfinMediaId4k"] = item.ToString();
        var fourK = SeerrRequestReadModel.Parse(JsonDocument.Parse(json.ToJsonString()).RootElement)!;
        Assert.Equal(item, fourK.JellyfinItemId);
        json["is4k"] = false;
        Assert.Equal(std, SeerrRequestReadModel.Parse(JsonDocument.Parse(json.ToJsonString()).RootElement)!.JellyfinItemId);
        json["media"]!["jellyfinMediaId"] = "not-a-guid";
        Assert.Null(SeerrRequestReadModel.Parse(JsonDocument.Parse(json.ToJsonString()).RootElement)!.JellyfinItemId);
        // Part of the request's signature: a change of the matched item is a change.
        json["media"]!["jellyfinMediaId"] = std.ToString("N");
        var a = SeerrRequestReadModel.Parse(JsonDocument.Parse(json.ToJsonString()).RootElement)!;
        json["media"]!["jellyfinMediaId"] = Guid.NewGuid().ToString("N");
        Assert.NotEqual(a.Signature, SeerrRequestReadModel.Parse(JsonDocument.Parse(json.ToJsonString()).RootElement)!.Signature);
    }

    [Fact]
    public async Task AMemberWithLimitsNoLongerSeesTheirOwnRequestOnceJellyfinHasTheTitleAndHidesIt()
    {
        var kidFilm = TitleKey.Parse("movie:tmdb:666")!;
        var copy = Guid.NewGuid();
        using var rig = await Ready(r => r.View.AddCopy(kidFilm, new JfCopy { ItemId = copy, Path = "/media/movies/Kid Film/kid.mkv", LibraryName = "Movies" }, r.Admin.UserId));
        // The kid's request: Jellyfin has the film and hides it from them (their limits judged it).
        var kid = Root(await Hub(rig, rig.Kid));
        Assert.Empty(kid.GetProperty("mine").EnumerateArray());
        Assert.Empty(kid.GetProperty("ready").EnumerateArray());
        var c = rig.StatusController(rig.Kid);
        Assert.Equal(0, Root(await Send(c, () => c.GetStatuses(null, "movie:tmdb:666", default, false))).GetProperty("items").GetArrayLength());
        Assert.False(rig.Service.MayFollow(rig.Kid, kidFilm));
        var etag = (await Hub(rig, rig.Kid)).ETag;
        // The limit is loosened (the copy becomes visible): it comes back, under a new ETag.
        rig.View.CopiesByKey[kidFilm.ToString()][0] = (rig.View.CopiesByKey[kidFilm.ToString()][0].Copy, null);
        rig.View.Rev++;
        var again = await Hub(rig, rig.Kid);
        Assert.NotEqual(etag, again.ETag);
        Assert.Single(Root(again).GetProperty("mine").EnumerateArray().Concat(Root(again).GetProperty("ready").EnumerateArray()));
        Assert.True(rig.Service.MayFollow(rig.Kid, kidFilm));
    }

    [Fact]
    public async Task JellyfinCopiesAreFoundByEveryIdTheTitleIsKnownBy()
    {
        // Dune is in Jellyfin known only by its IMDb id (Radarr knows both): asked about by its TMDB
        // key, the copy is found (Ready); a copy hidden from the viewer stays hidden.
        var dune = Guid.NewGuid();
        using var rig = await Ready(r => r.View.AddCopy(TitleKey.Parse("movie:imdb:tt693134")!, new JfCopy { ItemId = dune, Path = "/media/movies/Dune/Dune.mkv", LibraryName = "Movies", DateCreated = r.Arr.Now.UtcDateTime.AddHours(-1) }));
        var status = await rig.Service.ForBatchAsync(rig.Emma, Array.Empty<Guid>(), new[] { TitleKey.Parse("movie:tmdb:693134")! }, default);
        Assert.Equal("ready", JsonDocument.Parse(status.Json).RootElement.GetProperty("items")[0].GetProperty("stage").GetString());
        Assert.Contains(rig.View.CopyQueries, q => q.Contains("movie:tmdb:693134") && q.Contains("movie:imdb:tt693134") && q.All(k => k.StartsWith("movie:", StringComparison.Ordinal)));
        Assert.Equal(dune.ToString("N"), Find(Root(await Hub(rig, rig.Emma)), "ready", "movie:tmdb:693134")!.Value.GetProperty("itemId").GetString());
        // Firefly (TVDB 78874) in Jellyfin only by its TMDB id 1437: Sonarr knows both.
        rig.Sonarr.Series[0]["tmdbId"] = 1437;
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("SonarrZ").Id, ArrSnapshotKind.Library, force: true);
        var tmdbOnly = Guid.NewGuid();
        rig.View.CopiesByKey.Remove("tv:tvdb:78874");
        rig.View.AddCopy(TitleKey.Parse("tv:tmdb:1437")!, new JfCopy { ItemId = tmdbOnly, Path = "/media/tv/Firefly", LibraryName = "Shows" }, rig.Admin.UserId);
        rig.View.Rev++;
        var c = rig.StatusController(rig.Emma);
        var emma = Root(await Send(c, () => c.GetStatuses(null, "tv:tvdb:78874", default, false)));
        // The copy is found, but Emma can't open it: the answer of a title nobody has (not Ready).
        Assert.NotEqual("ready", emma.GetProperty("items")[0].GetProperty("stage").GetString());
        var admin = rig.Service.CopiesOf(TitleKey.Parse("tv:tvdb:78874")!, rig.Admin);
        Assert.Equal(tmdbOnly, Assert.Single(admin).ItemId);
    }

    [Fact]
    public async Task OldOpenRequestsSurviveTheCapAndThePageSaysWhenThereAreMore()
    {
        using var rig = await Ready(r =>
        {
            // 30 old requests still waiting for an OK, then 220 newer ones Seerr says are available.
            for (var i = 0; i < 30; i++)
                r.Seerr.Requests.Add(FakeSeerr.Request(1000 + i, "movie", 50000 + i, 1, r.Sam.UserId, Asked.AddDays(-20).AddMinutes(i)));
            for (var i = 0; i < 220; i++)
                r.Seerr.Requests.Add(FakeSeerr.Request(2000 + i, "movie", 60000 + i, 5, r.Sam.UserId, Asked.AddMinutes(i), Asked.AddMinutes(i), mediaStatus: 5));
            // And one declined 40 days ago: not listed (nor counted against the cap).
            r.Seerr.Requests.Add(FakeSeerr.Request(3000, "movie", 70000, 3, r.Sam.UserId, Asked.AddDays(-41), Asked.AddDays(-40)));
        });
        var sam = Root(await Hub(rig, rig.Sam));
        var waiting = sam.GetProperty("mine").EnumerateArray().Count(e => e.GetProperty("group").GetString() == "needsOk");
        Assert.Equal(31, waiting);      // his 30 old ones and Sam Film
        Assert.True(sam.GetProperty("more").GetBoolean());
        Assert.False(Root(await Hub(rig, rig.Emma)).GetProperty("more").GetBoolean());
    }

    [Fact]
    public async Task AReleaseDayStaysInComingSoonThroughThatDayWhereverTheViewerIs()
    {
        // Waiting Film (no arr has it): Seerr's (TMDB's) release date is today, a calendar day. At
        // 14:00 UTC it is still today west of UTC: it stays in Coming soon, as a day.
        using var rig = await Ready(r => r.Seerr.Movies[999]["releaseDate"] = r.Arr.Now.UtcDateTime.ToString("yyyy-MM-dd"));
        rig.Arr.Now = rig.Arr.Now.UtcDateTime.Date.AddHours(14);
        var entry = Find(Root(await Hub(rig, rig.Emma)), "soon", "movie:tmdb:999");
        Assert.NotNull(entry);
        Assert.Equal(rig.Arr.Now.UtcDateTime.ToString("yyyy-MM-dd"), entry!.Value.GetProperty("nextDay").GetString());
        // The day is over everywhere (36 h after it began): gone.
        rig.Arr.Now = rig.Arr.Now.UtcDateTime.Date.AddHours(37);
        Assert.Null(Find(Root(await Hub(rig, rig.Emma)), "soon", "movie:tmdb:999"));
        // An arr's release date is a day too.
        var agent = Find(Root(await Hub(rig, rig.Emma)), "mine", "movie:tmdb:457784");
        Assert.Equal("2026-10-20", agent!.Value.GetProperty("nextDay").GetString());
        // ... and stays one past midnight UTC (Seerr has no date for it): at 1 AM UTC on the 20th it
        // is still the 19th west of UTC, so Agent 327 is still coming, as that day.
        rig.Arr.Now = new DateTimeOffset(2026, 10, 20, 1, 0, 0, TimeSpan.Zero);
        var due = Find(Root(await Hub(rig, rig.Emma)), "soon", "movie:tmdb:457784");
        Assert.NotNull(due);
        Assert.Equal("2026-10-20", due!.Value.GetProperty("nextDay").GetString());
        rig.Arr.Now = new DateTimeOffset(2026, 10, 21, 13, 0, 0, TimeSpan.Zero);
        Assert.Null(Find(Root(await Hub(rig, rig.Emma)), "soon", "movie:tmdb:457784"));
    }

    [Fact]
    public async Task ACinemaOnlyReleaseStaysInComingSoonThroughItsCalendarDay()
    {
        using var rig = await Ready(r =>
        {
            var movie = r.Radarr.Movies[2];
            movie["digitalRelease"] = null;
            movie["inCinemas"] = "2026-10-20T00:00:00Z";
            r.Seerr.Movies[457784]["releaseDate"] = null;
        });
        rig.Arr.Now = new DateTimeOffset(2026, 10, 20, 1, 0, 0, TimeSpan.Zero);
        var entry = Find(Root(await Hub(rig, rig.Emma)), "soon", "movie:tmdb:457784");
        Assert.NotNull(entry);
        Assert.Equal("2026-10-20", entry!.Value.GetProperty("nextDay").GetString());
        Assert.Equal("not_released", entry.Value.GetProperty("status").GetProperty("reason").GetProperty("code").GetString());
        rig.Arr.Now = new DateTimeOffset(2026, 10, 21, 13, 0, 0, TimeSpan.Zero);
        var later = Root(await Hub(rig, rig.Emma));
        Assert.Null(Find(later, "soon", "movie:tmdb:457784"));
        Assert.Equal("in_cinemas", Find(later, "mine", "movie:tmdb:457784")!.Value.GetProperty("status").GetProperty("reason").GetProperty("code").GetString());
    }

    [Fact]
    public async Task ThePageSaysSoWhenASonarrOrRadarrsDownloadsCantBeRead()
    {
        using var rig = await Ready();
        Assert.False(Root(await Hub(rig, rig.Emma)).GetProperty("arr").GetProperty("unavailable").GetBoolean());
        rig.Radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await Hub(rig, rig.Emma);
        for (var i = 0; i < 300 && !rig.Store.PipelineExpired(rig.Arr.Instance("RadarrMainZ")); i++)
        {
            await Task.Delay(10);
            await Hub(rig, rig.Emma);
        }
        var emma = await Hub(rig, rig.Emma);
        var root = Root(emma);
        Assert.True(root.GetProperty("arr").GetProperty("unavailable").GetBoolean());
        // Dune isn't "Downloading 50 %" any more, and no instance name reaches the family body.
        var dune = Find(root, "mine", "movie:tmdb:693134");
        Assert.Equal("service_down", dune!.Value.GetProperty("status").GetProperty("reason").GetProperty("code").GetString());
        Assert.False(dune.Value.GetProperty("status").TryGetProperty("progress", out _));
        foreach (var word in Forbidden.Split('|')) Assert.DoesNotContain(word, emma.Body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AFourKSeasonRequestFollowsTheFourKSeriesNotTheStandardSeason()
    {
        const string firefly = "tv:tvdb:78874";
        // Season 1 of Firefly has been here in standard quality for two months; Emma asks for it in
        // 4K. With no 4K Sonarr set up in Jellyfin Enhanced: the request decides.
        using (var rig = await Ready(r =>
        {
            Roles(r, radarr4k: true, sonarr4k: false);
            FireflyS1Since(r, -60);
            r.Seerr.Requests.Add(FakeSeerr.Request(23, "tv", 1437, 1, r.Emma.UserId, Asked.AddHours(6), tvdb: 78874, is4k: true, seasons: [1]));
        }))
        {
            var emma = Root(await Hub(rig, rig.Emma));
            var entry = Find(emma, "mine", firefly);
            Assert.NotNull(entry);
            Assert.Equal(("needsOk", "asked"), (entry!.Value.GetProperty("group").GetString(), entry.Value.GetProperty("status").GetProperty("stage").GetString()));
        }

        // With a 4K Sonarr: its copy decides (monitored, nothing on disk: still waiting for the OK),
        // then the 4K copy arrives in its own Jellyfin library: Ready, arrived then, Play opens it.
        var fourKItem = Guid.NewGuid();
        using var rig2 = await Ready(r =>
        {
            var sonarr4k = Roles(r, radarr4k: true, sonarr4k: true)!;
            var row = FakeArr.SeriesRow(1, 78874, "Firefly");
            row["path"] = "/data/tv4k/Firefly";
            row["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 0, ["totalEpisodeCount"] = 1 } });
            sonarr4k.Series.Add(row);
            r.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 1, ["totalEpisodeCount"] = 1 } });
            FireflyS1Since(r, -60);
            r.Seerr.Requests.Add(FakeSeerr.Request(23, "tv", 1437, 1, r.Emma.UserId, Asked.AddHours(6), tvdb: 78874, is4k: true, seasons: [1]));
        });
        var pending = Find(Root(await Hub(rig2, rig2.Emma)), "mine", firefly);
        Assert.NotNull(pending);
        Assert.Equal("needsOk", pending!.Value.GetProperty("group").GetString());
        Assert.NotEqual("ready", pending.Value.GetProperty("status").GetProperty("stage").GetString());

        var arrived = rig2.Arr.Now.UtcDateTime.AddHours(-3);
        rig2.View.AddCopy(TitleKey.Parse(firefly)!, new JfCopy { ItemId = fourKItem, Path = "/media/tv4k/Firefly", LibraryName = "Shows 4K", DateCreated = arrived });
        var episode = Guid.NewGuid();
        rig2.View.AddEpisode(fourKItem, new JfEpisode { ItemId = episode, Season = 1, Episode = 1, DateCreated = arrived });
        rig2.View.AddSource(episode, 3840, 2160, created: arrived);
        rig2.View.Rev++;
        var ready = Find(Root(await Hub(rig2, rig2.Emma)), "ready", firefly);
        Assert.NotNull(ready);
        Assert.Equal(arrived, ready!.Value.GetProperty("readyAt").GetDateTime().ToUniversalTime());
        Assert.Equal(fourKItem.ToString("N"), ready.Value.GetProperty("itemId").GetString());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task AFourKSeriesRequestWithoutSeasonsNeverFollowsTheStandardCopy(bool hasFourKSeries, bool monitored)
    {
        const string firefly = "tv:tvdb:78874";
        using var rig = await Ready(r =>
        {
            var sonarr4k = Roles(r, radarr4k: true, sonarr4k: true)!;
            r.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 1, ["totalEpisodeCount"] = 1 } });
            r.Sonarr.Episodes[0]["episodeNumber"] = 1;
            r.Sonarr.Episodes[0]["hasFile"] = true;
            FireflyS1Since(r, -1);
            r.View.CopiesByKey[firefly].Clear();
            r.View.AddCopy(TitleKey.Parse(firefly)!, new JfCopy { ItemId = r.Firefly, Path = "/media/tv/Firefly", LibraryName = "Shows", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-1) });
            if (hasFourKSeries)
            {
                var row = FakeArr.SeriesRow(1, 78874, "Firefly");
                row["path"] = "/data/tv4k/Firefly";
                row["statistics"]!["episodeFileCount"] = 0;
                row["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = monitored, ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 0, ["totalEpisodeCount"] = 1 } });
                sonarr4k.Series.Add(row);
            }
            r.Seerr.Requests.Add(FakeSeerr.Request(23, "tv", 1437, 2, r.Emma.UserId, Asked.AddHours(6), Asked.AddHours(7), tvdb: 78874, is4k: true, seasons: []));
        });
        var root = Root(await Hub(rig, rig.Emma));
        Assert.Null(Find(root, "ready", firefly));
        var entry = Find(root, "mine", firefly);
        Assert.NotNull(entry);
        Assert.Equal(monitored ? "looking" : "approved", entry!.Value.GetProperty("status").GetProperty("stage").GetString());
        Assert.False(entry.Value.TryGetProperty("itemId", out var id) && id.ValueKind == JsonValueKind.String);
        if (monitored) Assert.Equal(1, entry.Value.GetProperty("status").GetProperty("summary").GetProperty("missing").GetInt32());
    }

    [Fact]
    public async Task AFourKSeasonRequestHeldOnlyByTheFourKSonarrNeverOpensTheStandardCopy()
    {
        const string firefly = "tv:tvdb:78874";
        // Only the 4K Sonarr has Firefly (root /data/tv4k, no links or mappings); Jellyfin has the
        // standard copy only (Season 1 for two months). Emma's 4K request for Season 1 was OK'd.
        using var rig = await Ready(r =>
        {
            var sonarr4k = Roles(r, radarr4k: true, sonarr4k: true)!;
            var row = FakeArr.SeriesRow(1, 78874, "Firefly");
            row["path"] = "/data/tv4k/Firefly";
            row["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 0, ["totalEpisodeCount"] = 1 } });
            sonarr4k.Series.Add(row);
            r.Sonarr.Series.Clear();
            r.Sonarr.Episodes.Clear();
            FireflyS1Since(r, -60);
            r.Seerr.Requests.Add(FakeSeerr.Request(23, "tv", 1437, 2, r.Emma.UserId, Asked.AddHours(6), Asked.AddHours(7), tvdb: 78874, is4k: true, seasons: [1]));
        });
        var emma = Root(await Hub(rig, rig.Emma));
        Assert.Null(Find(emma, "ready", firefly));
        var entry = Find(emma, "mine", firefly);
        Assert.NotNull(entry);
        Assert.NotEqual("ready", entry!.Value.GetProperty("status").GetProperty("stage").GetString());
        Assert.False(entry.Value.TryGetProperty("itemId", out var id) && id.ValueKind == JsonValueKind.String);
    }

    [Fact]
    public async Task AnOldRequestWhoseTitleArrivedYesterdayIsListedAsReady()
    {
        // OK'd 40 days ago; Seerr's media sync marked it available without touching the request;
        // Jellyfin got it yesterday. It is ready since yesterday, not finished long ago.
        var item = Guid.NewGuid();
        using var rig = await Ready(r =>
        {
            var old = r.Arr.Now.UtcDateTime.AddDays(-40);
            r.Seerr.Requests.Add(FakeSeerr.Request(60, "movie", 4242, 2, r.Sam.UserId, old, old, mediaStatus: 5));
            r.Seerr.Movies[4242] = new JsonObject { ["title"] = "Late Film", ["releaseDate"] = "2024-01-01", ["posterPath"] = "/p4242.jpg" };
            var key = TitleKey.Parse("movie:tmdb:4242")!;
            r.View.AddItem(new JfItemRef { ItemId = item, Kind = "movie", Key = key, Path = "/media/movies/Late Film (2024)/Late.mkv", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-1) });
            r.View.AddCopy(key, new JfCopy { ItemId = item, Path = "/media/movies/Late Film (2024)/Late.mkv", LibraryName = "Movies", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-1) });
        });
        var ready = Find(Root(await Hub(rig, rig.Sam)), "ready", "movie:tmdb:4242");
        Assert.NotNull(ready);
        Assert.Equal(item.ToString("N"), ready!.Value.GetProperty("itemId").GetString());
    }

    [Fact]
    public async Task ASpecialsOnlyRequestFollowsSeasonZero()
    {
        // Firefly has been here for two months (Season 1 too); Emma asks for the specials only.
        using var rig = await Ready(r =>
        {
            FireflyS1Since(r, -30);
            r.Seerr.Requests.Add(FakeSeerr.Request(24, "tv", 1437, 1, r.Emma.UserId, Asked.AddHours(6), tvdb: 78874, seasons: [0]));
        });
        var entry = Find(Root(await Hub(rig, rig.Emma)), "mine", "tv:tvdb:78874");
        Assert.NotNull(entry);
        Assert.Equal(("needsOk", "asked"), (entry!.Value.GetProperty("group").GetString(), entry.Value.GetProperty("status").GetProperty("stage").GetString()));
    }

    [Fact]
    public async Task ARequestedSeasonInALibraryTheMemberCantOpenTellsThemNothingAboutTheFiles()
    {
        // Black Books' Season 2 was asked for by Emma, OK'd, and Sonarr imported it into a library
        // only the administrator can open.
        const string key = "tv:tvdb:79216";
        using var rig = await Ready(r =>
        {
            var row = FakeArr.SeriesRow(2, 79216, "Black Books");
            row["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 2, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 3, ["episodeFileCount"] = 3, ["totalEpisodeCount"] = 3 } });
            r.Sonarr.Series.Add(row);
            r.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/adults/Black Books", LibraryName = "TV (adults)", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-1) }, r.Admin.UserId);
            r.Seerr.Requests.Add(FakeSeerr.Request(25, "tv", 1914, 2, r.Emma.UserId, Asked.AddHours(6), Asked.AddHours(7), tvdb: 79216, seasons: [2]));
        });
        var entry = Find(Root(await Hub(rig, rig.Emma)), "mine", key);
        Assert.NotNull(entry);
        var status = entry!.Value.GetProperty("status");
        Assert.Equal(("onTheWay", "approved"), (entry.Value.GetProperty("group").GetString(), status.GetProperty("stage").GetString()));
        Assert.False(status.TryGetProperty("summary", out _));
    }

    [Fact]
    public async Task AnEntryIsComposedWithTheViewersOwnRequestsNotTheHouseholds()
    {
        // Emma's standard request for Waiting Film (999) waits for an OK; Sam's 4K request for it was OK'd.
        using var rig = await Ready(r => r.Seerr.Requests.Add(FakeSeerr.Request(26, "movie", 999, 2, r.Sam.UserId, Asked.AddHours(5), Asked.AddHours(6), is4k: true)));
        var entry = Find(Root(await Hub(rig, rig.Emma)), "mine", "movie:tmdb:999");
        Assert.NotNull(entry);
        Assert.Equal(("needsOk", "asked", "pending"), (entry!.Value.GetProperty("group").GetString(), entry.Value.GetProperty("status").GetProperty("stage").GetString(), entry.Value.GetProperty("request").GetString()));
    }

    private static Task<Reply> Manage(Rig rig, StatusViewer viewer, string? itemId, string? key)
    {
        var c = rig.Controller(viewer);
        return Send(c, () => c.GetManage(itemId, key, default));
    }

    [Fact]
    public async Task AnAdministratorDemotedWhileTheManageDrawerIsReadGetsNoOverview()
    {
        using var rig = await Ready();
        Assert.Equal(200, (await Manage(rig, rig.Admin, null, "movie:tmdb:693134")).Status);
        // The administrator permission is taken away while the drawer reads the arrs.
        var done = false;
        rig.View.OnCopies = () =>
        {
            if (done) return;
            done = true;
            rig.View.Revoke(rig.Admin, admin: false);
        };
        Assert.Equal(403, (await Manage(rig, rig.Admin, null, "movie:tmdb:693134")).Status);
    }

    [Fact]
    public async Task AViewerRemovedOrChangingWhileTheirRequestsPageIsPreparedGetsNoErrorAndNothingElsesPage()
    {
        using var rig = await Ready();
        Assert.Equal(200, (await Hub(rig, rig.Emma)).Status);
        // Emma is deleted while her page reads the arrs: the answer for someone who isn't there, not a server error.
        var done = false;
        rig.View.OnCopies = () =>
        {
            if (done) return;
            done = true;
            rig.View.Users.Remove(rig.Emma.UserId);
        };
        var gone = await Hub(rig, rig.Emma);
        Assert.Equal((403, "user_required"), (gone.Status, Root(gone).GetProperty("code").GetString()));

        // Sam's policy changes during every preparation: after its attempts, the same answer.
        rig.View.OnCopies = () => rig.View.Revoke(rig.View.Users[rig.Sam.UserId]);
        var changing = await Hub(rig, rig.Sam);
        Assert.Equal((403, "user_required"), (changing.Status, Root(changing).GetProperty("code").GetString()));
        rig.View.OnCopies = null;
        Assert.Equal(200, (await Hub(rig, rig.View.Users[rig.Sam.UserId])).Status);
    }

    [Fact]
    public async Task TheManageDrawerIsForAdministratorsOnly()
    {
        using var rig = await Ready();
        Assert.Equal(403, (await Manage(rig, rig.Emma, null, "movie:tmdb:693134")).Status);
        Assert.Equal(403, (await Manage(rig, rig.Kid, rig.Sintel.ToString("N"), null)).Status);
        var c = rig.Controller(rig.Emma);
        Assert.Equal(403, (await Send(c, () => c.Search(new ManageSearchRequest { InstanceId = rig.Arr.Instance("RadarrMainZ").Id, Key = "movie:tmdb:693134", IdempotencyKey = "k" }, default))).Status);
        Assert.Empty(rig.Radarr.Writes);

        rig.Arr.Plugin.Plugin.Configuration.ArrManageDrawerEnabled = false;
        Assert.Equal(403, (await Manage(rig, rig.Admin, null, "movie:tmdb:693134")).Status);
        rig.Arr.Plugin.Plugin.Configuration.ArrManageDrawerEnabled = true;
        Assert.Equal(400, (await Manage(rig, rig.Admin, null, "movie:nope:1")).Status);
        Assert.Equal(400, (await Manage(rig, rig.Admin, "not-a-guid", null)).Status);
        Assert.Equal(404, (await Manage(rig, rig.Admin, Guid.NewGuid().ToString("N"), null)).Status);
    }

    [Fact]
    public async Task TheDrawerSaysHowManyMoreQueueRowsAndDownloadsThereAreThanItLists()
    {
        // Firefly: a 60-episode season pack (one download) and 25 single-episode downloads.
        using var rig = await Ready(r =>
        {
            r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
            for (var e = 1; e <= 60; e++)
            {
                var row = FakeArr.SonarrQueueRow(100 + e, "pack", 1, e, "Firefly", 78874);
                r.Sonarr.Queue.Add(row);
            }
            for (var d = 1; d <= 25; d++) r.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(500 + d, "single" + d, 2, d, "Firefly", 78874));
        });
        var root = Root(await Manage(rig, rig.Admin, null, "tv:tvdb:78874"));
        var sonarr = root.GetProperty("instances").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "SonarrZ");
        Assert.Equal((50, 85), (sonarr.GetProperty("queue").GetArrayLength(), sonarr.GetProperty("queueTotal").GetInt32()));
        Assert.Equal((20, 26), (sonarr.GetProperty("downloads").GetArrayLength(), sonarr.GetProperty("downloadsTotal").GetInt32()));
    }

    [Fact]
    public async Task TheDrawerOffersNoDownloadsFromAQueueThatCantBeReadAndSaysWhenItWasLastRead()
    {
        using var rig = await Ready(r => r.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true);
        static JsonElement Main(JsonElement root) => root.GetProperty("instances").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "RadarrMainZ");
        static bool Has(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null;
        var live = Main(Root(await Manage(rig, rig.Admin, null, "movie:tmdb:693134")));
        Assert.Equal((1, 1, false, false), (live.GetProperty("queue").GetArrayLength(), live.GetProperty("downloads").GetArrayLength(), Has(live, "queueAsOf"), live.GetProperty("queueExpired").GetBoolean()));
        // Radarr stops answering for longer than the queue's serving limit (10 minutes).
        rig.Radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await Manage(rig, rig.Admin, null, "movie:tmdb:693134");
        for (var i = 0; i < 300 && !rig.Store.PipelineExpired(rig.Arr.Instance("RadarrMainZ")); i++)
        {
            await Task.Delay(10);
            await Manage(rig, rig.Admin, null, "movie:tmdb:693134");
        }
        var gone = Main(Root(await Manage(rig, rig.Admin, null, "movie:tmdb:693134")));
        Assert.Equal((0, 0, 0, 0), (gone.GetProperty("queue").GetArrayLength(), gone.GetProperty("queueTotal").GetInt32(), gone.GetProperty("downloads").GetArrayLength(), gone.GetProperty("downloadsTotal").GetInt32()));
        Assert.True(gone.GetProperty("queueExpired").GetBoolean());
        Assert.True(Has(gone, "queueAsOf"));
    }

    [Fact]
    public async Task TheOverviewExplainsListsVersionsTimelineAndRequests()
    {
        using var rig = await Ready();
        var reply = await Manage(rig, rig.Admin, null, "movie:tmdb:693134");
        Assert.Equal(200, reply.Status);
        var root = Root(reply);
        Assert.Equal(("movie:tmdb:693134", "movie", 693134), (root.GetProperty("key").GetString(), root.GetProperty("kind").GetString(), root.GetProperty("tmdbId").GetInt32()));
        Assert.Equal("downloading", root.GetProperty("status").GetProperty("stage").GetString());
        Assert.True(root.GetProperty("status").TryGetProperty("admin", out _));
        var instances = root.GetProperty("instances").EnumerateArray().ToList();
        var main = instances.Single(i => i.GetProperty("name").GetString() == "RadarrMainZ");
        var fourK = instances.Single(i => i.GetProperty("name").GetString() == "Radarr4kZ");
        Assert.True(main.GetProperty("inArr").GetBoolean());
        Assert.Equal(2, main.GetProperty("arrId").GetInt32());
        Assert.Equal("http://radarr.lan:7878", main.GetProperty("url").GetString());
        Assert.Equal(50, main.GetProperty("queue")[0].GetProperty("percent").GetInt32());
        Assert.Contains(main.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("event").GetString() == "grabbed");
        // Versions: the 4K instance is readable and doesn't have it (so the drawer offers to add it there).
        Assert.Equal((true, false), (fourK.GetProperty("readable").GetBoolean(), fourK.GetProperty("inArr").GetBoolean()));
        Assert.Equal("4k", fourK.GetProperty("role").GetString());
        var request = Assert.Single(root.GetProperty("requests").EnumerateArray());
        Assert.Equal("approved", request.GetProperty("status").GetString());
        Assert.False(reply.Body.Contains("KEY-0123456789", StringComparison.Ordinal));

        // On a Jellyfin item: its copy is matched to the instance.
        var sintel = Root(await Manage(rig, rig.Admin, rig.Sintel.ToString("N"), null));
        var sintelMain = sintel.GetProperty("instances").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "RadarrMainZ");
        Assert.Equal(("Movies", rig.Sintel.ToString("N")), (sintelMain.GetProperty("library").GetString(), sintelMain.GetProperty("itemId").GetString()));
    }

    [Fact]
    public async Task ASeasonOrEpisodeKeyIsExplainedForThatSeasonOrEpisodeNotTheSeries()
    {
        // Firefly S1E1 is in Jellyfin; S1E4 isn't (Sonarr is looking for it). The series reads Ready.
        var e1 = Guid.Empty;
        using var rig = await Ready(r => r.View.AddItem(new JfItemRef
        {
            ItemId = e1 = r.View.EpisodesBySeries[r.Firefly].Single().Episode.ItemId, Kind = "episode", Key = TitleKey.Parse("tv:tvdb:78874:s1:e1"), SeriesId = r.Firefly, Season = 1, Episode = 1,
            DateCreated = r.Arr.Now.UtcDateTime.AddDays(-1),
        }));
        JsonElement Status(JsonElement root) => root.GetProperty("status");

        var e4 = Root(await Manage(rig, rig.Admin, null, "tv:tvdb:78874:s1:e4"));
        Assert.Equal(("tv:tvdb:78874:s1:e4", 1, 4), (e4.GetProperty("key").GetString(), e4.GetProperty("season").GetInt32(), e4.GetProperty("episode").GetInt32()));
        Assert.Equal(("episode", "looking", "tv:tvdb:78874:s1:e4"), (Status(e4).GetProperty("kind").GetString(), Status(e4).GetProperty("stage").GetString(), Status(e4).GetProperty("key").GetString()));
        Assert.False(Status(e4).TryGetProperty("itemId", out _));

        var season = Status(Root(await Manage(rig, rig.Admin, null, "tv:tvdb:78874:s1")));
        Assert.Equal(("season", "looking"), (season.GetProperty("kind").GetString(), season.GetProperty("stage").GetString()));

        // An episode Jellyfin has: its own item, as if opened on its page.
        var here = Root(await Manage(rig, rig.Admin, null, "tv:tvdb:78874:s1:e1"));
        Assert.Equal(e1.ToString("N"), here.GetProperty("itemId").GetString());
        Assert.Equal(("episode", "ready"), (Status(here).GetProperty("kind").GetString(), Status(here).GetProperty("stage").GetString()));

        // The series key still explains the series.
        Assert.Equal(("series", "ready"), (Status(Root(await Manage(rig, rig.Admin, null, "tv:tvdb:78874"))).GetProperty("kind").GetString(), Status(Root(await Manage(rig, rig.Admin, null, "tv:tvdb:78874"))).GetProperty("stage").GetString()));
    }

    [Fact]
    public async Task SearchNowRunsTheRightCommandThroughTheAuditedRunner()
    {
        using var rig = await Ready();
        var radarr = rig.Arr.Instance("RadarrMainZ").Id;
        var sonarr = rig.Arr.Instance("SonarrZ").Id;
        async Task<JsonElement> Search(string instance, string key, string? idem = "click-1")
        {
            var c = rig.Controller(rig.Admin);
            var reply = await Send(c, () => c.Search(new ManageSearchRequest { InstanceId = instance, Key = key, IdempotencyKey = idem }, default));
            return reply.Status == 200 ? Root(reply) : JsonDocument.Parse($"{{\"http\":{reply.Status}}}").RootElement;
        }

        var movie = await Search(radarr, "movie:tmdb:693134");
        Assert.Equal("Succeeded", movie.GetProperty("status").GetString());
        Assert.Contains("Search finished", movie.GetProperty("readBack").GetString());
        var write = Assert.Single(rig.Radarr.Writes);
        Assert.Equal(("POST", "/api/v3/command"), (write.Method, write.Path));
        var command = JsonNode.Parse(write.Body)!;
        Assert.Equal(("MoviesSearch", 2), ((string?)command["name"], (int)command["movieIds"]![0]!));
        // The same click again is the same action (no second search).
        Assert.True((await Search(radarr, "movie:tmdb:693134")).GetProperty("replayed").GetBoolean());
        Assert.Single(rig.Radarr.Writes);
        // Audited, and the drawer's timeline shows it.
        Assert.Contains(rig.Audit.ReadRecent(10), a => a.Action == "movie.search" && a.Target == "movie:2" && a.Outcome == "succeeded");
        var overview = Root(await Manage(rig, rig.Admin, null, "movie:tmdb:693134"));
        var main = overview.GetProperty("instances").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "RadarrMainZ");
        Assert.Contains(main.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("event").GetString() == "audit" && e.GetProperty("text").GetString()!.Contains("movie.search"));

        // An episode: EpisodeSearch with Sonarr's episode id.
        var episode = await Search(sonarr, "tv:tvdb:78874:s1:e4", "click-2");
        Assert.Equal("Succeeded", episode.GetProperty("status").GetString());
        var sonarrCommand = JsonNode.Parse(Assert.Single(rig.Sonarr.Writes).Body)!;
        Assert.Equal(("EpisodeSearch", 104), ((string?)sonarrCommand["name"], (int)sonarrCommand["episodeIds"]![0]!));

        // Refused before any call: the wrong kind of instance, a title it doesn't have, no click key.
        Assert.Equal("Rejected", (await Search(sonarr, "movie:tmdb:693134", "click-3")).GetProperty("status").GetString());
        Assert.Equal("Rejected", (await Search(rig.Arr.Instance("Radarr4kZ").Id, "movie:tmdb:693134", "click-4")).GetProperty("status").GetString());
        Assert.Equal(400, (await Search(radarr, "movie:tmdb:693134", null)).GetProperty("http").GetInt32());
        Assert.Empty(rig.Radarr4k.Writes);
        Assert.Single(rig.Radarr.Writes);
    }

    [Fact]
    public async Task SearchNowSaysWhetherTheSearchFoundACopy()
    {
        using var rig = await Ready();
        var radarr = rig.Arr.Instance("RadarrMainZ").Id;
        var sonarr = rig.Arr.Instance("SonarrZ").Id;
        var started = new DateTime(2026, 10, 12, 12, 0, 0, DateTimeKind.Utc);
        rig.Radarr.CommandStarted = started.ToString("o", CultureInfo.InvariantCulture);
        rig.Sonarr.CommandStarted = started.ToString("o", CultureInfo.InvariantCulture);
        static JsonObject Grab(string field, int id, DateTime at, int? episodeId = null, int? season = null, string eventType = "grabbed")
            => new() { [field] = id, ["eventType"] = eventType, ["date"] = at.ToString("o", CultureInfo.InvariantCulture), ["episodeId"] = episodeId, ["seasonNumber"] = season };
        async Task<JsonElement> Search(string instance, string key, string idem)
        {
            var c = rig.Controller(rig.Admin);
            return Root(await Send(c, () => c.Search(new ManageSearchRequest { InstanceId = instance, Key = key, IdempotencyKey = idem }, default)));
        }
        static bool? Found(JsonElement reply) => reply.GetProperty("found").ValueKind == JsonValueKind.Null ? null : reply.GetProperty("found").GetBoolean();

        // Nothing grabbed since the search started (an older grab and a later import don't count).
        rig.Radarr.TitleHistory.Add(Grab("movieId", 2, started.AddDays(-3)));
        rig.Radarr.TitleHistory.Add(Grab("movieId", 2, started.AddSeconds(30), eventType: "downloadFolderImported"));
        Assert.False(Found(await Search(radarr, "movie:tmdb:693134", "found-1")));
        // A grab of the movie during the search: found.
        rig.Radarr.TitleHistory.Add(Grab("movieId", 2, started.AddSeconds(4)));
        Assert.True(Found(await Search(radarr, "movie:tmdb:693134", "found-2")));
        // Still running when the read-back stopped watching, or no start time: not known.
        rig.Radarr.CommandStatus = "started";
        Assert.Null(Found(await Search(radarr, "movie:tmdb:693134", "found-3")));
        rig.Radarr.CommandStatus = "completed";
        rig.Radarr.CommandStarted = null;
        Assert.Null(Found(await Search(radarr, "movie:tmdb:693134", "found-4")));

        // An episode: only a grab of that episode counts (Sonarr's history of the season is read).
        rig.Sonarr.TitleHistory.Add(Grab("seriesId", 1, started.AddSeconds(5), episodeId: 105, season: 1));
        Assert.False(Found(await Search(sonarr, "tv:tvdb:78874:s1:e4", "found-5")));
        rig.Sonarr.TitleHistory.Add(Grab("seriesId", 1, started.AddSeconds(6), episodeId: 104, season: 1));
        Assert.True(Found(await Search(sonarr, "tv:tvdb:78874:s1:e4", "found-6")));
        Assert.Contains(rig.Arr.Calls, c => c.Contains("/api/v3/history/series", StringComparison.Ordinal) && c.Contains("seasonNumber=1", StringComparison.Ordinal));
        // A refused search says nothing about finding.
        Assert.Equal(JsonValueKind.Null, (await Search(sonarr, "movie:tmdb:693134", "found-7")).GetProperty("found").ValueKind);
    }

    [Fact]
    public async Task SearchForEveryoneRunsTheArrsSearchAgainOnlyForWhatRequestsAlreadySent()
    {
        // Firefly S1E4 is monitored in Sonarr with nothing grabbed; Seerr's OK of season 1 was two days ago.
        using var rig = await Ready();
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;   // family Search is phase 3's (the request clock too)
        rig.Sonarr.CommandStarted = rig.Arr.Now.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var policy = new IntegrationRequestLedgerTests.Policy();
        foreach (var (viewer, role) in new[] { (rig.Emma, "Member"), (rig.Kid, "Kid"), (rig.Sam, "Watcher") })
            policy.People[viewer.UserId] = new(viewer.UserId, role, role != "Watcher", false, false, true, "r1", "je", "", "", 7, 7, 0, "null");
        using var db = new AcquireDatabase(Path.Combine(rig.Arr.Plugin.Core.Root, "family-search.db"));
        var ledger = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestLedger(db);
        var requests = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var search = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchService(requests, rig.Manage, () => rig.Arr.Now);
        async Task<(int Status, JsonElement Body)> Press(StatusViewer? viewer, string key, string idem)
        {
            var c = new AcquireRequestsController(requests, null, search) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = viewer == null ? TestCallers.Unknown() : TestCallers.Principal(viewer.UserId, viewer.IsAdmin);
            var reply = await Send(c, () => c.Search(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchBody(key, idem), default));
            return (reply.Status, Root(reply));
        }
        int Searches() => rig.Sonarr.Writes.Count(w => w.Path == "/api/v3/command" && w.Body.Contains("EpisodeSearch", StringComparison.Ordinal));
        const string E4 = "tv:tvdb:78874:s1:e4";

        // Nothing went out through a request yet: the caller asks for it instead (no arr call).
        var first = await Press(rig.Emma, E4, "p1");
        Assert.Equal((200, "skipped", "not_requested"), (first.Status, first.Body.GetProperty("outcome").GetString(), first.Body.GetProperty("reason").GetString()));
        Assert.Equal(0, Searches());

        // Emma's ask for that episode goes out.
        var input = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestEpisode(1, 4) } };
        Assert.Equal(201, (await requests.CreateAsync(rig.Emma.UserId, new("ask-e4", input), default)).HttpStatus);
        await new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(),
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestTitleLocks(), rig.Feed, rig.Audit, () => rig.Arr.Now).TickAsync(default);
        Assert.Equal("sent", ledger.List(rig.Emma.UserId, false).Single().Status);

        // Not missing for long enough yet (a 30-day "still looking" period): nothing to search, the page asks instead.
        rig.Arr.Plugin.Plugin.Configuration.ArrStatusLookingHours = 720;
        var fresh = await Press(rig.Emma, E4, "p1b");
        Assert.Equal((200, "skipped", "not_searchable"), (fresh.Status, fresh.Body.GetProperty("outcome").GetString(), fresh.Body.GetProperty("reason").GetString()));
        Assert.Equal(0, Searches());
        rig.Arr.Plugin.Plugin.Configuration.ArrStatusLookingHours = 24;

        // Seen live: Sonarr's address or key changed after the send (a new connection generation of the same instance).
        // What was sent still counts: the Search searches, it doesn't ask (and charge) again.
        foreach (var viewer in new[] { rig.Emma, rig.Kid })
            policy.People[viewer.UserId] = policy.People[viewer.UserId] with { ConnectionGeneration = "g2" };

        // Missing for a long while: Emma's Search runs Sonarr's search for exactly that episode; nothing grabbed.
        var searched = await Press(rig.Emma, E4, "p2");
        Assert.Equal(200, searched.Status);
        Assert.Equal(("accepted", "searched", false), (searched.Body.GetProperty("outcome").GetString(), searched.Body.GetProperty("reason").GetString(), searched.Body.GetProperty("found").GetBoolean()));
        Assert.Equal(1, Searches());
        var command = JsonNode.Parse(rig.Sonarr.Writes.Last(w => w.Path == "/api/v3/command").Body)!;
        Assert.Equal(104, (int)command["episodeIds"]![0]!);
        Assert.DoesNotContain("sonarr.lan", searched.Body.GetRawText(), StringComparison.OrdinalIgnoreCase);
        // No new request, nothing charged.
        Assert.Single(ledger.List(rig.Emma.UserId, false));
        Assert.Empty(ledger.List(rig.Kid.UserId, false));

        // Once per looking period for the whole household: the kid's press right after is refused.
        var again = await Press(rig.Kid, E4, "p3");
        Assert.Equal((429, "searched_recently"), (again.Status, again.Body.GetProperty("reason").GetString()));
        Assert.Equal(1, Searches());
        // Watchers can't, and neither can callers who aren't a person.
        var watcher = await Press(rig.Sam, E4, "p4");
        Assert.Equal((403, "requests_create_required"), (watcher.Status, watcher.Body.GetProperty("reason").GetString()));
        Assert.Equal(403, (await Press(null, E4, "p5")).Status);
        // A season or series key searches its episodes missing for a long while: E4 (its only one) was just
        // searched, so nothing is left to search in this period. An episode 0 isn't a part; a movie nobody's
        // request sent is asked for instead.
        foreach (var whole in new[] { "tv:tvdb:78874:s1", "tv:tvdb:78874" })
            Assert.Equal((429, "searched_recently"), ((await Press(rig.Emma, whole, "p6-" + whole)).Status, (await Press(rig.Emma, whole, "p6b-" + whole)).Body.GetProperty("reason").GetString()));
        Assert.Equal(1, Searches());
        Assert.Equal(400, (await Press(rig.Emma, "tv:tvdb:78874:s1:e0", "p6")).Status);
        Assert.Equal("not_requested", (await Press(rig.Emma, "movie:tmdb:693134", "p7")).Body.GetProperty("reason").GetString());

        // The next looking period: the kid (who may see Firefly) may search again.
        rig.Arr.Now += TimeSpan.FromHours(25);
        var later = await Press(rig.Kid, E4, "p8");
        Assert.Equal(200, later.Status);
        Assert.Equal(2, Searches());
        Assert.Empty(ledger.List(rig.Kid.UserId, false));

        // The drive of the series' own folder is nearly full: the download couldn't be imported, so the Search is
        // refused with the storage reason (blocked, like an ask), and nothing reaches Sonarr.
        rig.Arr.Now += TimeSpan.FromHours(25);
        policy.Adjust = (_, _, facts) => facts with { Refusal = "low_disk" };
        var full = await Press(rig.Emma, E4, "p9");
        Assert.Equal((403, "blocked", "low_disk"), (full.Status, full.Body.GetProperty("outcome").GetString(), full.Body.GetProperty("reason").GetString()));
        Assert.Equal(2, Searches());
        policy.Adjust = null;
    }

    [Fact]
    public async Task FamilySearchSearchesOnlyTheStandardCopyOnTheRequestTargetAndOnlyWhatSeerrOkd()
    {
        // Dune: the standard copy is downloading; an admin's separate 4K copy has been missing for a month.
        // Firefly S1E4: Seerr holds the household's season 1 request but hasn't OK'd it.
        using var rig = await Ready(r =>
        {
            var dune4k = FakeArr.Movie(2, 693134, "Dune Part Two", hasFile: false, path: "/data/movies4k/Dune Part Two (2024)");
            dune4k["added"] = r.Arr.Now.UtcDateTime.AddDays(-30).ToString("o", CultureInfo.InvariantCulture);
            dune4k["isAvailable"] = true;
            r.Radarr4k.Movies.Add(dune4k);
            var firefly = r.Seerr.Requests.Single(q => (int)q["id"]! == 8);
            firefly["status"] = 1;
        });
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        rig.Sonarr.CommandStarted = rig.Arr.Now.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        rig.Radarr4k.CommandStarted = rig.Sonarr.CommandStarted;
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.People[rig.Emma.UserId] = new(rig.Emma.UserId, "Member", true, false, false, true, "r1", "je", "", "", 7, 7, 0, "null");
        // In Seerr mode the request goes out as Emma's Seerr account.
        policy.Adjust = (_, _, facts) => facts.Backend == "seerr" ? facts with { SeerrSource = "seerr-src", SeerrUser = 7, BackendQuota = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.QuotaProjection(0, null, null, null, 0) } : facts;
        using var db = new AcquireDatabase(Path.Combine(rig.Arr.Plugin.Core.Root, "family-search-target.db"));
        var ledger = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestLedger(db);
        var requests = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var search = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchService(requests, rig.Manage, () => rig.Arr.Now);
        async Task<JsonElement> Press(string key, string idem)
        {
            var c = new AcquireRequestsController(requests, null, search) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = TestCallers.Principal(rig.Emma.UserId, false);
            return Root(await Send(c, () => c.Search(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchBody(key, idem), default)));
        }
        async Task Sent(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput input, string client)
        {
            Assert.Equal(201, (await requests.CreateAsync(rig.Emma.UserId, new(client, input), default)).HttpStatus);
            await new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(),
                new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestTitleLocks(), rig.Feed, rig.Audit, () => rig.Arr.Now).TickAsync(default);
        }
        int Commands(FakeArr.Host host) => host.Writes.Count(w => w.Path == "/api/v3/command");

        // Emma's standard Dune request went out. Her Search never reaches the 4K copy she asked nothing of.
        await Sent(new() { Key = "movie:tmdb:693134" }, "dune");
        var dune = await Press("movie:tmdb:693134", "d1");
        Assert.Equal(("skipped", "not_searchable"), (dune.GetProperty("outcome").GetString(), dune.GetProperty("reason").GetString()));
        Assert.Equal(0, Commands(rig.Radarr4k));
        Assert.Equal(0, Commands(rig.Radarr));

        // Seerr mode: Seerr accepted her season 1 ask but it waits for an OK there. Search doesn't go around that.
        policy.Configuration.ArrRequestBackend = "seerr";
        await Sent(new() { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 1 } }, "s1");
        Assert.Equal("sent", ledger.List(rig.Emma.UserId, false).Single(w => w.Input.Key == "tv:tvdb:78874").Status);
        var waiting = await Press("tv:tvdb:78874:s1:e4", "e1");
        Assert.Equal(("skipped", "not_requested"), (waiting.GetProperty("outcome").GetString(), waiting.GetProperty("reason").GetString()));
        Assert.Equal(0, Commands(rig.Sonarr));
        // Once Seerr OKs it (and it has been missing for a long while since), Search runs Sonarr's search.
        var ok = rig.Seerr.Requests.Single(q => (int)q["id"]! == 8);
        ok["status"] = 2;
        ok["updatedAt"] = rig.Arr.Now.UtcDateTime.AddHours(-30).ToString("o", CultureInfo.InvariantCulture);
        Assert.True(await rig.Requests.RefreshAsync(default));
        var searched = await Press("tv:tvdb:78874:s1:e4", "e2");
        Assert.Equal(("accepted", "searched"), (searched.GetProperty("outcome").GetString(), searched.GetProperty("reason").GetString()));
        Assert.Equal(1, Commands(rig.Sonarr));
    }

    [Fact]
    public async Task FamilySearchOfASeriesOrSeasonSearchesExactlyItsSentEpisodesMissingForALongWhile()
    {
        // Firefly in Sonarr: S1E1 here; S1E2, S1E4 and S2E1 monitored, out for years, nothing grabbed; S1E3 not
        // monitored; a special (S0E1) missing too. Seerr's OK of season 1 was two days ago. A 4K Sonarr holds Firefly
        // too, with S1E2 missing there. Jellyfin hides season 2 from the kid.
        FakeArr.Host? fourK = null;
        using var rig = await Ready(r =>
        {
            fourK = Roles(r, radarr4k: true, sonarr4k: true)!;
            JsonObject Ep(int id, int season, int episode, bool monitored = true, bool hasFile = false)
                => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["airDateUtc"] = $"{2002 + season}-10-{10 + episode}T00:00:00Z", ["hasFile"] = hasFile, ["monitored"] = monitored };
            r.Sonarr.Episodes.Add(Ep(101, 1, 1, hasFile: true));
            r.Sonarr.Episodes.Add(Ep(102, 1, 2));
            r.Sonarr.Episodes.Add(Ep(103, 1, 3, monitored: false));
            r.Sonarr.Episodes.Add(Ep(201, 2, 1));
            r.Sonarr.Episodes.Add(Ep(1, 0, 1));
            var row = FakeArr.SeriesRow(1, 78874, "Firefly");
            row["path"] = "/data/tv4k/Firefly";
            fourK.Series.Add(row);
            fourK.Episodes.Add(Ep(902, 1, 2));
            r.View.AddSeason(r.Firefly, new JfSeason { ItemId = Guid.NewGuid(), Season = 1 });
            r.View.AddSeason(r.Firefly, new JfSeason { ItemId = Guid.NewGuid(), Season = 2 }, r.Admin.UserId, r.Emma.UserId);
            r.Sonarr.Series.Add(FakeArr.SeriesRow(2, 81189, "Breaking Bad"));
            r.Sonarr.Episodes.Add(new JsonObject { ["id"] = 301, ["seriesId"] = 2, ["seasonNumber"] = 1, ["episodeNumber"] = 1, ["airDateUtc"] = "2008-01-20T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        });
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        rig.Sonarr.CommandStarted = rig.Arr.Now.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var policy = new IntegrationRequestLedgerTests.Policy();
        foreach (var viewer in new[] { rig.Emma, rig.Kid })
            policy.People[viewer.UserId] = new(viewer.UserId, "Member", true, false, false, true, "r1", "je", "", "", 7, 7, 0, "null");
        using var db = new AcquireDatabase(Path.Combine(rig.Arr.Plugin.Core.Root, "family-search-series.db"));
        var ledger = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestLedger(db);
        var requests = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var search = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchService(requests, rig.Manage, () => rig.Arr.Now);
        async Task<(int Status, JsonElement Body)> Press(StatusViewer viewer, string key, string idem)
        {
            var c = new AcquireRequestsController(requests, null, search) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = TestCallers.Principal(viewer.UserId, viewer.IsAdmin);
            var reply = await Send(c, () => c.Search(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchBody(key, idem), default));
            return (reply.Status, Root(reply));
        }
        static (int, string?, string?) Said((int Status, JsonElement Body) r) => (r.Status, r.Body.GetProperty("outcome").GetString(), r.Body.GetProperty("reason").GetString());
        List<int[]> Searched() => rig.Sonarr.Writes.Where(w => w.Path == "/api/v3/command").Select(w => JsonNode.Parse(w.Body)!)
            .Where(c => (string?)c["name"] == "EpisodeSearch").Select(c => c["episodeIds"]!.AsArray().Select(i => (int)i!).ToArray()).ToList();
        const string Series = "tv:tvdb:78874";
        const string Season1 = "tv:tvdb:78874:s1";

        // Nothing went out through a request yet: the caller asks for the season instead (no arr call).
        Assert.Equal((200, "skipped", "not_requested"), Said(await Press(rig.Emma, Season1, "a1")));
        Assert.Empty(Searched());

        // Emma's ask for seasons 1 and 2 goes out.
        var input = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = Series, Scope = "seasons", Seasons = new[] { 1, 2 } };
        Assert.Equal(201, (await requests.CreateAsync(rig.Emma.UserId, new("ask-s12", input), default)).HttpStatus);
        await new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(),
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestTitleLocks(), rig.Feed, rig.Audit, () => rig.Arr.Now).TickAsync(default);
        Assert.Equal("sent", ledger.List(rig.Emma.UserId, false).Single().Status);

        // Season 1's episodes are still fresh in a 30-day "still looking" period (Seerr's OK two days ago): nothing to search.
        rig.Arr.Plugin.Plugin.Configuration.ArrStatusLookingHours = 720;
        Assert.Equal((200, "skipped", "not_searchable"), Said(await Press(rig.Emma, Season1, "a2")));
        Assert.Empty(Searched());
        rig.Arr.Plugin.Plugin.Configuration.ArrStatusLookingHours = 24;

        // The kid's Search of the whole series: one EpisodeSearch for exactly the episodes missing for a long while
        // that they can see (S1E2, S1E4): not the one here, the unmonitored one, the special, the hidden season 2,
        // nor the 4K copy. No new request, nothing charged.
        var kid = await Press(rig.Kid, Series, "a3");
        Assert.Equal((200, "accepted", "searched"), Said(kid));
        Assert.Equal(new[] { 102, 104 }, Assert.Single(Searched()));
        Assert.Empty(fourK!.Writes);
        Assert.Contains(rig.Audit.ReadRecent(20), a => a.Action == "episode.search" && a.Target == "episode-of:1:102,104" && a.UserId == rig.Kid.UserId.ToString("N"));
        // Nor can they search the hidden episode by its own key (nothing in Sonarr's queue for it either).
        Assert.Equal((200, "skipped", "not_searchable"), Said(await Press(rig.Kid, "tv:tvdb:78874:s2:e1", "a3b")));
        Assert.Single(Searched());

        // Emma's Search of the series right after: only what nobody searched in this period (S2E1).
        Assert.Equal((200, "accepted", "searched"), Said(await Press(rig.Emma, Series, "a4")));
        Assert.Equal(new[] { 201 }, Searched().Last());
        // Nothing left: the series, season 1 and its episodes were all searched a little while ago.
        foreach (var key in new[] { Series, Season1, "tv:tvdb:78874:s1:e2" })
            Assert.Equal((429, "blocked", "searched_recently"), Said(await Press(rig.Emma, key, "a5" + key)));
        Assert.Equal(2, Searched().Count);
        Assert.Single(ledger.List(rig.Emma.UserId, false));
        Assert.Empty(ledger.List(rig.Kid.UserId, false));

        // The next looking period: season 1 alone searches S1E2 and S1E4 again.
        rig.Arr.Now += TimeSpan.FromHours(25);
        Assert.Equal((200, "accepted", "searched"), Said(await Press(rig.Emma, Season1, "a6")));
        Assert.Equal(new[] { 102, 104 }, Searched().Last());
        Assert.Empty(fourK.Writes);

        // A series Jellyfin doesn't have yet (Breaking Bad: Sonarr has it, nothing grabbed for years): once Emma's ask
        // for it went out, her Search of the series searches its episodes the same way.
        Assert.Equal((200, "skipped", "not_requested"), Said(await Press(rig.Emma, "tv:tvdb:81189", "b1")));
        var absent = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = "tv:tvdb:81189", Scope = "seasons", Seasons = new[] { 1 } };
        Assert.Equal(201, (await requests.CreateAsync(rig.Emma.UserId, new("ask-bb", absent), default)).HttpStatus);
        await new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(),
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestTitleLocks(), rig.Feed, rig.Audit, () => rig.Arr.Now).TickAsync(default);
        Assert.Equal((200, "accepted", "searched"), Said(await Press(rig.Emma, "tv:tvdb:81189", "b2")));
        Assert.Equal(new[] { 301 }, Searched().Last());
    }

    [Fact]
    public async Task FamilySearchOfALongSeriesSearchesTheNextEpisodesNobodySearchedYetNotTheSameFirstOnes()
    {
        // Breaking Bad in Sonarr (not in Jellyfin yet): 65 episodes of season 1, monitored, out for years, nothing
        // grabbed. One Search covers at most RequestSearchService.MaxEpisodes (50) of them.
        var ids = Enumerable.Range(1, 65).Select(e => 2000 + e).ToArray();
        using var rig = await Ready(r =>
        {
            r.Sonarr.Series.Add(FakeArr.SeriesRow(2, 81189, "Breaking Bad"));
            foreach (var e in Enumerable.Range(1, 65))
                r.Sonarr.Episodes.Add(new JsonObject { ["id"] = 2000 + e, ["seriesId"] = 2, ["seasonNumber"] = 1, ["episodeNumber"] = e, ["airDateUtc"] = "2008-01-20T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        });
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        rig.Arr.Plugin.Plugin.Configuration.ArrStatusLookingHours = 24;
        rig.Sonarr.CommandStarted = rig.Arr.Now.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.People[rig.Emma.UserId] = new(rig.Emma.UserId, "Member", true, false, false, true, "r1", "je", "", "", 7, 7, 0, "null");
        using var db = new AcquireDatabase(Path.Combine(rig.Arr.Plugin.Core.Root, "family-search-long.db"));
        var ledger = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestLedger(db);
        var requests = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var search = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchService(requests, rig.Manage, () => rig.Arr.Now);
        async Task<(int Status, JsonElement Body)> Press(string key, string idem)
        {
            var c = new AcquireRequestsController(requests, null, search) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = TestCallers.Principal(rig.Emma.UserId, false);
            var reply = await Send(c, () => c.Search(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchBody(key, idem), default));
            return (reply.Status, Root(reply));
        }
        static (int, string?, string?) Said((int Status, JsonElement Body) r) => (r.Status, r.Body.GetProperty("outcome").GetString(), r.Body.GetProperty("reason").GetString());
        List<int[]> Searched() => rig.Sonarr.Writes.Where(w => w.Path == "/api/v3/command").Select(w => JsonNode.Parse(w.Body)!)
            .Where(c => (string?)c["name"] == "EpisodeSearch").Select(c => c["episodeIds"]!.AsArray().Select(i => (int)i!).ToArray()).ToList();
        const string Series = "tv:tvdb:81189";

        // Emma's ask for season 1 goes out.
        var input = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = Series, Scope = "seasons", Seasons = new[] { 1 } };
        Assert.Equal(201, (await requests.CreateAsync(rig.Emma.UserId, new("ask-bb-long", input), default)).HttpStatus);
        await new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(),
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestTitleLocks(), rig.Feed, rig.Audit, () => rig.Arr.Now).TickAsync(default);
        Assert.Equal("sent", ledger.List(rig.Emma.UserId, false).Single().Status);

        // The first Search: the first 50 episodes.
        Assert.Equal((200, "accepted", "searched"), Said(await Press(Series, "l1")));
        Assert.Equal(ids.Take(50).ToArray(), Assert.Single(Searched()));
        // The next press in the same period: the 15 nobody searched yet, not the same 50 again (a season too).
        Assert.Equal((200, "accepted", "searched"), Said(await Press(Series, "l2")));
        Assert.Equal(ids.Skip(50).ToArray(), Searched().Last());
        // Now every one of them was searched a little while ago.
        foreach (var key in new[] { Series, Series + ":s1" })
            Assert.Equal((429, "blocked", "searched_recently"), Said(await Press(key, "l3" + key)));
        Assert.Equal(2, Searched().Count);
        Assert.Single(ledger.List(rig.Emma.UserId, false));

        // The next looking period: the first 50 again.
        rig.Arr.Now += TimeSpan.FromHours(25);
        Assert.Equal((200, "accepted", "searched"), Said(await Press(Series + ":s1", "l4")));
        Assert.Equal(ids.Take(50).ToArray(), Searched().Last());
    }

    [Fact]
    public async Task AFamilySearchWhoseCallerWentAwayBeforeItRanLeavesItsEpisodesFreeForTheNextPress()
    {
        // Breaking Bad in Sonarr (not in Jellyfin yet): S1E1 and S1E2 monitored, out for years, nothing grabbed.
        using var rig = await Ready(r =>
        {
            r.Sonarr.Series.Add(FakeArr.SeriesRow(2, 81189, "Breaking Bad"));
            foreach (var e in new[] { 1, 2 })
                r.Sonarr.Episodes.Add(new JsonObject { ["id"] = 300 + e, ["seriesId"] = 2, ["seasonNumber"] = 1, ["episodeNumber"] = e, ["airDateUtc"] = "2008-01-20T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        });
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        rig.Arr.Plugin.Plugin.Configuration.ArrStatusLookingHours = 24;
        rig.Sonarr.CommandStarted = rig.Arr.Now.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.People[rig.Emma.UserId] = new(rig.Emma.UserId, "Member", true, false, false, true, "r1", "je", "", "", 7, 7, 0, "null");
        using var db = new AcquireDatabase(Path.Combine(rig.Arr.Plugin.Core.Root, "family-search-gone.db"));
        var ledger = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestLedger(db);
        var requests = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var search = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestSearchService(requests, rig.Manage, () => rig.Arr.Now);
        int Searches() => rig.Sonarr.Writes.Count(w => w.Path == "/api/v3/command" && w.Body.Contains("EpisodeSearch", StringComparison.Ordinal));
        const string Series = "tv:tvdb:81189";
        var input = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = Series, Scope = "seasons", Seasons = new[] { 1 } };
        Assert.Equal(201, (await requests.CreateAsync(rig.Emma.UserId, new("ask-bb-gone", input), default)).HttpStatus);
        await new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(),
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestTitleLocks(), rig.Feed, rig.Audit, () => rig.Arr.Now).TickAsync(default);
        Assert.Equal("sent", ledger.List(rig.Emma.UserId, false).Single().Status);

        // Emma's page goes away while the search reads the series' episodes from Sonarr, after its episodes were
        // claimed for this period and before the search command was sent: nothing reaches Sonarr.
        using var gone = new CancellationTokenSource();
        rig.Store.EpisodeSlotPicked = _ =>
        {
            if (Environment.StackTrace.Contains("SearchCoreAsync", StringComparison.Ordinal)) gone.Cancel();
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => search.SearchAsync(rig.Emma, Series, "g1", gone.Token));
        rig.Store.EpisodeSlotPicked = null;
        Assert.True(gone.IsCancellationRequested);
        Assert.Equal(0, Searches());

        // Her next press searches those episodes: they weren't searched, so they aren't "searched a little while ago".
        var again = await search.SearchAsync(rig.Emma, Series, "g2", default);
        Assert.Equal(("accepted", "searched"), (again.Outcome.Outcome, again.Outcome.Reason));
        Assert.Equal(1, Searches());
        Assert.Equal(new[] { 301, 302 }, JsonNode.Parse(rig.Sonarr.Writes.Last(w => w.Path == "/api/v3/command").Body)!["episodeIds"]!.AsArray().Select(i => (int)i!).ToArray());
        // Now they were: the press after is refused.
        Assert.Equal("searched_recently", (await search.SearchAsync(rig.Emma, Series, "g3", default)).Outcome.Reason);
    }

    [Fact]
    public async Task TheRequestClockIsPhaseThreesOnlyAnOkInSeerrLeavesTheStatusAsBeforeWithItOff()
    {
        // A movie Radarr has listed for a month with nothing grabbed; Seerr OK'd a request for it an hour ago.
        using var rig = await Ready(r =>
        {
            var old = FakeArr.Movie(9, 9001, "Old Film", hasFile: false);
            old["added"] = r.Arr.Now.UtcDateTime.AddDays(-30).ToString("o", CultureInfo.InvariantCulture);
            old["isAvailable"] = true;
            r.Radarr.Movies.Add(old);
            r.Seerr.Requests.Add(FakeSeerr.Request(31, "movie", 9001, 2, r.Emma.UserId, r.Arr.Now.UtcDateTime.AddHours(-2), r.Arr.Now.UtcDateTime.AddHours(-1)));
        });
        Assert.True(await rig.Requests.RefreshAsync(default));
        async Task<string> Reason()
        {
            var c = rig.StatusController(rig.Emma);
            return Root(await Send(c, () => c.GetStatuses(null, "movie:tmdb:9001", default))).GetProperty("items")[0].GetProperty("reason").GetProperty("code").GetString()!;
        }
        // Phase 3 off: missing for a long while, as before (the clock counts from Radarr's own dates).
        Assert.Equal(StatusReasonCode.NoReleaseYet, await Reason());
        // Phase 3 on: the OK an hour ago restarted it.
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        Assert.Equal(StatusReasonCode.Looking, await Reason());
    }

    [Fact]
    public async Task TheDeletionOfTheLastRequestForATitleStillReachesThoseWhoFollowedIt()
    {
        // The kid asked for Kid Film (666) and Sam for Sam Film (777); neither is in Jellyfin or an arr.
        using var rig = await Ready();
        var kid = new User("kid", "default", "default") { Id = rig.Kid.UserId, MaxParentalRatingScore = 10 };
        var emma = new User("emma", "default", "default") { Id = rig.Emma.UserId };
        emma.SetPermission(PermissionKind.EnableAllFolders, true);
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(kid.Id)).Returns(kid);
        users.Setup(m => m.GetUserById(emma.Id)).Returns(emma);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        var audience = new ArrFeedAudience(library.Object, users.Object, rig.Store, () => rig.Arr.Now, rig.View, rig.Requests);
        var changes = new List<ArrFeedChange> { new("movie:tmdb:666", 1, null), new("movie:tmdb:777", 2, null) };
        Assert.Equal(new[] { "movie:tmdb:666" }, audience.Visible(kid.Id, false, changes));
        Assert.Equal(new[] { "movie:tmdb:666", "movie:tmdb:777" }, audience.Visible(emma.Id, false, changes));

        // Both requests are deleted in Seerr. The read model swaps its list before it announces the
        // titles, so the announcement is decided when nobody has a request for them any more: the
        // requester (whatever their limits) and the unrestricted members still hear about it.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! is 6 or 7);
        rig.Arr.Now += TimeSpan.FromMinutes(6);
        Assert.True(await rig.Requests.RefreshAsync(default));
        Assert.False(rig.Requests.AskedBy(TitleKey.Parse("movie:tmdb:666")!, kid.Id));
        Assert.Equal(new[] { "movie:tmdb:666" }, audience.Visible(kid.Id, false, changes));
        Assert.Equal(new[] { "movie:tmdb:666", "movie:tmdb:777" }, audience.Visible(emma.Id, false, changes));

        // Only for a few minutes: later changes to those titles are nobody's business.
        rig.Arr.Now += TimeSpan.FromMinutes(11);
        Assert.Empty(audience.Visible(kid.Id, false, changes));
        Assert.Empty(audience.Visible(emma.Id, false, changes));
    }

    [Fact]
    public void RequestListKeysReachTheirOwnerOnlyAndARestrictedUserHearsAboutWhatTheyAskedFor()
    {
        var kid = new User("kid", "default", "default") { Id = Guid.NewGuid(), MaxParentalRatingScore = 10 };
        var other = new User("other", "default", "default") { Id = Guid.NewGuid(), MaxParentalRatingScore = 10 };
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(kid.Id)).Returns(kid);
        users.Setup(m => m.GetUserById(other.Id)).Returns(other);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());   // nothing is in Jellyfin
        var facts = new Mock<IArrRequestFacts>();
        facts.SetupGet(f => f.Revision).Returns(1);
        facts.Setup(f => f.AskedLatelyBy(It.Is<TitleKey>(k => k.ToString() == "movie:tmdb:5"), kid.Id)).Returns(true);
        using var arr = new FakeArr();
        var audience = new ArrFeedAudience(library.Object, users.Object, arr.Store(), null, new FakeJellyfinView(), facts.Object);
        var changes = new List<ArrFeedChange>
        {
            new(ArrTitleKey.UserRequests(kid.Id), 1, null),
            new(ArrTitleKey.UserRequests(other.Id), 2, null),
            new("movie:tmdb:5", 3, null),
            new("movie:tmdb:6", 4, null),
        };
        Assert.Equal(new[] { ArrTitleKey.UserRequests(kid.Id), "movie:tmdb:5" }, audience.Visible(kid.Id, false, changes));
        Assert.Empty(audience.Visible(other.Id, false, changes.Skip(2).ToList()));
        Assert.Equal(new[] { ArrTitleKey.UserRequests(other.Id) }, audience.Visible(other.Id, false, changes.Take(2).ToList()));
        // The shared request-list state key reaches everyone (it says nothing about anyone).
        var state = new List<ArrFeedChange> { new(ArrTitleKey.RequestsState, 5, null) };
        Assert.Equal(new[] { ArrTitleKey.RequestsState }, audience.Visible(kid.Id, false, state));
        Assert.Equal(new[] { ArrTitleKey.RequestsState }, audience.Visible(other.Id, false, state));
        Assert.Equal(new[] { ArrTitleKey.RequestsState }, audience.Visible(Guid.NewGuid(), true, state));
        // A member without content limits hears about request changes (no instance) to a title only
        // Seerr knows, which they can read by key ("asked by someone in your household"); not
        // about titles nobody asked for, nor arr changes of instances.
        var member = new User("member", "default", "default") { Id = Guid.NewGuid() };
        member.SetPermission(PermissionKind.EnableAllFolders, true);
        users.Setup(m => m.GetUserById(member.Id)).Returns(member);
        facts.Setup(f => f.RequestedLately(It.Is<TitleKey>(k => k.ToString() == "movie:tmdb:5"))).Returns(true);
        Assert.Equal(new[] { "movie:tmdb:5" }, audience.Visible(member.Id, false, changes.Skip(2).ToList()));
        Assert.Empty(audience.Visible(other.Id, false, changes.Skip(2).ToList()));
        // Administrators hear about every title but not other people's request lists.
        var adminId = Guid.NewGuid();
        Assert.Equal(new[] { "movie:tmdb:5", "movie:tmdb:6" }, audience.Visible(adminId, true, changes));
    }
}
