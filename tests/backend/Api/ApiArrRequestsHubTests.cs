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
        }

        // OK'd, and Seerr says the 4K copy is available (since two hours ago): Ready, arrived then.
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
            var ready = Find(Root(await Hub(rig, rig.Sam)), "ready", "movie:tmdb:45745");
            Assert.NotNull(ready);
            Assert.Equal(availableAt, ready!.Value.GetProperty("readyAt").GetDateTime().ToUniversalTime());
        }
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
        rig2.View.AddEpisode(fourKItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = arrived });
        rig2.View.Rev++;
        var ready = Find(Root(await Hub(rig2, rig2.Emma)), "ready", firefly);
        Assert.NotNull(ready);
        Assert.Equal(arrived, ready!.Value.GetProperty("readyAt").GetDateTime().ToUniversalTime());
        Assert.Equal(fourKItem.ToString("N"), ready.Value.GetProperty("itemId").GetString());
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
    public async Task TheDeletionOfTheLastRequestForATitleStillReachesThoseWhoFollowedIt()
    {
        // The kid asked for Kid Film (666) and Sam for Sam Film (777); neither is in Jellyfin or an arr.
        using var rig = await Ready();
        var kid = new User("kid", "default", "default") { Id = rig.Kid.UserId, MaxParentalRatingScore = 10 };
        var emma = new User("emma", "default", "default") { Id = rig.Emma.UserId };
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
        users.Setup(m => m.GetUserById(member.Id)).Returns(member);
        facts.Setup(f => f.RequestedLately(It.Is<TitleKey>(k => k.ToString() == "movie:tmdb:5"))).Returns(true);
        Assert.Equal(new[] { "movie:tmdb:5" }, audience.Visible(member.Id, false, changes.Skip(2).ToList()));
        Assert.Empty(audience.Visible(other.Id, false, changes.Skip(2).ToList()));
        // Administrators hear about every title but not other people's request lists.
        var adminId = Guid.NewGuid();
        Assert.Equal(new[] { "movie:tmdb:5", "movie:tmdb:6" }, audience.Visible(adminId, true, changes));
    }
}
