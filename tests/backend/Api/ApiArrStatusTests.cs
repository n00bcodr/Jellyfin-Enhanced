using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// The status routes (phase 1 of "Requests &amp; downloads"): flags and validation, items the caller
/// can't see left out, a route scan of every non-admin response (no instance, URL, path, key,
/// client, release or arr words), per-user cache isolation (admin and member with the same library
/// access never share a body or an ETag), private ETags with 304s, zero arr calls on the request
/// path, and fresh statuses after the snapshots change (a download moving to Ready after import and scan).
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrStatusTests
{
    private const string Forbidden = "RadarrMainZ|Radarr4kZ|SonarrZ|radarr.lan|radarr4k.lan|sonarr.lan|KEY-0123456789|/data/|Mock SABnzbd|Bluray-1080p|-GRP|Sample|Manual Import|\"admin\"";

    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Radarr4k { get; }
        public FakeArr.Host Sonarr { get; }
        public ArrStateStore Store { get; }
        public FakeJellyfinView View { get; } = new();
        public ArrStatusService Service { get; }
        public StatusViewer Admin { get; }
        public StatusViewer Member { get; }
        public StatusViewer Member2 { get; }
        public StatusViewer Kid { get; }
        public StatusViewer ShowsMissing { get; }
        public Guid Sintel { get; } = Guid.NewGuid();
        public Guid Firefly { get; } = Guid.NewGuid();
        public Guid Season1 { get; } = Guid.NewGuid();
        public Guid Episode1 { get; } = Guid.NewGuid();
        public Guid Episode3 { get; } = Guid.NewGuid();
        public Guid AdminOnly { get; } = Guid.NewGuid();

        public Rig(IArrRequestFacts? requests = null)
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

            // Radarr: Sintel on disk; Dune downloading (42 %). Radarr 4K: Sintel downloading.
            Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", path: "/data/movies/Sintel (2010)"));
            Radarr.Movies.Add(FakeArr.Movie(2, 693134, "Dune Part Two", hasFile: false, path: "/data/movies/Dune Part Two (2024)"));
            Radarr.Queue.Add(WithClient(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two")));
            Radarr4k.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", hasFile: false, path: "/data/movies4k/Sintel (2010)"));
            Radarr4k.Queue.Add(WithClient(FakeArr.RadarrQueueRow(1, 45745, "Sintel")));
            // Sonarr: Firefly; S1E1 on disk, S1E2 missing, S1E3 downloading (import blocked message on E4).
            Sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly"));
            Sonarr.Episodes.Add(Episode(101, 1, 1, "2002-09-20T00:00:00Z", hasFile: true));
            Sonarr.Episodes.Add(Episode(102, 1, 2, "2002-09-27T00:00:00Z"));
            Sonarr.Episodes.Add(Episode(103, 1, 3, "2002-10-04T00:00:00Z"));
            Sonarr.Episodes.Add(Episode(104, 1, 4, "2002-10-11T00:00:00Z"));
            var e3 = FakeArr.SonarrQueueRow(103, "dl103", 1, 3, "Firefly", 78874);
            e3["episodeId"] = 103;
            Sonarr.Queue.Add(WithClient(e3));
            var e4 = FakeArr.SonarrQueueRow(104, "dl104", 1, 4, "Firefly", 78874);
            e4["episodeId"] = 104;
            e4["status"] = "completed";
            e4["trackedDownloadState"] = "importBlocked";
            e4["trackedDownloadStatus"] = "warning";
            e4["statusMessages"] = new JsonArray(new JsonObject { ["title"] = "x", ["messages"] = new JsonArray("Manual Import required.") });
            Sonarr.Queue.Add(WithClient(e4));

            Store = Arr.Store();
            Service = new ArrStatusService(Store, View, requests ?? new NoRequestFacts(), () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);

            Admin = View.AddUser(admin: true, policy: "same");
            Member = View.AddUser(admin: false, policy: "same");
            Member2 = View.AddUser(admin: false, policy: "same");
            Kid = View.AddUser(admin: false, policy: "kid", parental: true);
            ShowsMissing = View.AddUser(admin: false, policy: "missing", missing: true);

            var sintelKey = TitleKey.Parse("movie:tmdb:45745")!;
            var fireflyKey = TitleKey.Parse("tv:tvdb:78874")!;
            View.AddItem(new JfItemRef { ItemId = Sintel, Kind = "movie", Key = sintelKey, Path = "/media/movies/Sintel (2010)/Sintel (2010) Bluray-1080p.mkv", DateCreated = Arr.Now.UtcDateTime.AddDays(-30) });
            View.AddCopy(sintelKey, new JfCopy { ItemId = Sintel, Path = "/media/movies/Sintel (2010)/Sintel (2010) Bluray-1080p.mkv", LibraryName = "Movies", DateCreated = Arr.Now.UtcDateTime.AddDays(-30) });
            View.AddItem(new JfItemRef { ItemId = Firefly, Kind = "series", Key = fireflyKey });
            View.AddCopy(fireflyKey, new JfCopy { ItemId = Firefly, Path = "/media/tv/Firefly", LibraryName = "TV" });
            View.AddItem(new JfItemRef { ItemId = Season1, Kind = "season", Key = fireflyKey.WithSeason(1), SeriesId = Firefly, Season = 1 });
            View.AddItem(new JfItemRef { ItemId = Episode1, Kind = "episode", Key = fireflyKey.WithEpisode(1, 1), SeriesId = Firefly, Season = 1, Episode = 1 });
            View.AddItem(new JfItemRef { ItemId = Episode3, Kind = "episode", Key = fireflyKey.WithEpisode(1, 3), SeriesId = Firefly, Season = 1, Episode = 3, Virtual = true });
            View.AddItem(new JfItemRef { ItemId = AdminOnly, Kind = "movie", Key = TitleKey.Parse("movie:tmdb:693134") }, Admin.UserId);
            View.AddEpisode(Firefly, new JfEpisode { ItemId = Episode1, Season = 1, Episode = 1 });
            View.AddEpisode(Firefly, new JfEpisode { ItemId = Episode3, Season = 1, Episode = 3, Virtual = true });
        }

        private static JsonObject WithClient(JsonObject row)
        {
            row["downloadClient"] = "Mock SABnzbd";
            row["quality"] = new JsonObject { ["quality"] = new JsonObject { ["name"] = "Bluray-1080p" } };
            return row;
        }

        private static JsonObject Episode(int id, int season, int number, string air, bool hasFile = false)
            => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = season, ["episodeNumber"] = number, ["airDateUtc"] = air, ["hasFile"] = hasFile, ["monitored"] = true };

        public ArrStatusController Controller(StatusViewer? viewer)
        {
            var controller = new ArrStatusController(Service) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = viewer == null
                ? new ClaimsPrincipal(new ClaimsIdentity(Array.Empty<Claim>(), "test"))
                : new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.UserId.ToString()), new Claim(ClaimTypes.Role, viewer.IsAdmin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public string Ids(params Guid[] ids) => string.Join(",", ids.Select(i => i.ToString("N")));

        public void Dispose() => Arr.Dispose();
    }

    private sealed record Reply(int Status, string Body, string? ETag, string? CacheControl);

    private static async Task<Reply> Call(Rig rig, StatusViewer? viewer, Func<ArrStatusController, Task<IActionResult>> call, string? ifNoneMatch = null)
    {
        var controller = rig.Controller(viewer);
        if (ifNoneMatch != null) controller.HttpContext.Request.Headers["If-None-Match"] = ifNoneMatch;
        var result = await call(controller);
        var headers = controller.HttpContext.Response.Headers;
        string? etag = headers.TryGetValue("ETag", out var e) ? e.ToString() : null;
        string? cache = headers.TryGetValue("Cache-Control", out var cc) ? cc.ToString() : null;
        return result switch
        {
            FileContentResult file => new Reply(200, Encoding.UTF8.GetString(file.FileContents), etag, cache),
            ObjectResult obj => new Reply(obj.StatusCode ?? 200, JsonSerializer.Serialize(obj.Value), etag, cache),
            StatusCodeResult code => new Reply(code.StatusCode, string.Empty, etag, cache),
            _ => throw new InvalidOperationException(result.GetType().Name),
        };
    }

    private static Task<Reply> Batch(Rig rig, StatusViewer? viewer, string? ids, string? keys = null, string? ifNoneMatch = null)
        => Call(rig, viewer, c => c.GetStatuses(ids, keys, CancellationToken.None), ifNoneMatch);

    private static Task<Reply> Item(Rig rig, StatusViewer? viewer, Guid id, string? ifNoneMatch = null)
        => Call(rig, viewer, c => c.GetItemStatus(id.ToString("N"), CancellationToken.None), ifNoneMatch);

    private static JsonElement Items(Reply reply) => JsonDocument.Parse(reply.Body).RootElement.GetProperty("items");

    [Fact]
    public async Task TheRoutesAreBehindBothSwitchesNeedAUserAndValidateTheirInput()
    {
        using var rig = new Rig();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.ArrPhase1Enabled = false;
        Assert.Equal((403, "feature_disabled"), await Code(Batch(rig, rig.Member, rig.Ids(rig.Sintel))));
        c.ArrPhase1Enabled = true;
        c.ArrIntegrationEnabled = false;
        Assert.Equal((403, "feature_disabled"), await Code(Item(rig, rig.Admin, rig.Sintel)));
        c.ArrIntegrationEnabled = true;

        Assert.Equal((403, "user_required"), await Code(Batch(rig, null, rig.Ids(rig.Sintel))));
        Assert.Equal((400, "invalid_id"), await Code(Batch(rig, rig.Member, "not-a-guid")));
        Assert.Equal((400, "invalid_key"), await Code(Batch(rig, rig.Member, null, "movie:tvdb:1")));
        Assert.Equal((400, "invalid_key"), await Code(Batch(rig, rig.Member, null, "tv:tvdb:1:s1")));
        Assert.Equal((400, "too_many"), await Code(Batch(rig, rig.Member, string.Join(",", Enumerable.Range(0, 101).Select(_ => Guid.NewGuid().ToString("N"))))));
        Assert.Equal((400, "invalid_id"), await Code(Call(rig, rig.Member, ctl => ctl.GetItemStatus("x", CancellationToken.None))));
        // Non-ASCII digits match \d but not int.Parse: refused, never a server error.
        Assert.Equal((400, "invalid_key"), await Code(Batch(rig, rig.Member, null, "tv:tvdb:5:s\u0661")));
        Assert.Equal((400, "invalid_key"), await Code(Batch(rig, rig.Member, null, "movie:tmdb:\u0661")));
        Assert.Equal(200, (await Batch(rig, rig.Member, rig.Ids(rig.Sintel))).Status);

        static async Task<(int, string?)> Code(Task<Reply> reply)
        {
            var r = await reply;
            return (r.Status, JsonDocument.Parse(r.Body).RootElement.GetProperty("code").GetString());
        }
    }

    [Fact]
    public async Task ItemsTheCallerCannotSeeAreLeftOut()
    {
        using var rig = new Rig();
        var member = await Batch(rig, rig.Member, rig.Ids(rig.Sintel, rig.AdminOnly, Guid.NewGuid()));
        Assert.Equal(new[] { rig.Sintel.ToString("N") }, Items(member).EnumerateArray().Select(i => i.GetProperty("itemId").GetString()).ToArray());
        // The item route: an empty list, the same as for an id that doesn't exist (no 404 to tell them apart).
        var hidden = await Item(rig, rig.Member, rig.AdminOnly);
        var unknown = await Item(rig, rig.Member, Guid.NewGuid());
        Assert.Equal((200, 0, 200, 0), (hidden.Status, Items(hidden).GetArrayLength(), unknown.Status, Items(unknown).GetArrayLength()));
        Assert.Equal(304, (await Item(rig, rig.Member, rig.AdminOnly, hidden.ETag)).Status);
        Assert.Equal(2, Items(await Batch(rig, rig.Admin, rig.Ids(rig.Sintel, rig.AdminOnly))).GetArrayLength());
    }

    [Fact]
    public async Task NoNonAdminResponseCarriesInstancesUrlsPathsKeysClientsReleasesOrArrWords()
    {
        using var rig = new Rig();
        var all = rig.Ids(rig.Sintel, rig.Firefly, rig.Season1, rig.Episode1, rig.Episode3, rig.AdminOnly);
        const string keys = "movie:tmdb:693134,movie:tmdb:45745,tv:tvdb:78874,movie:tmdb:1";
        var replies = new List<Reply> { await Batch(rig, rig.Member, all, keys) };
        foreach (var id in new[] { rig.Sintel, rig.Firefly, rig.Season1, rig.Episode1, rig.Episode3 }) replies.Add(await Item(rig, rig.Member, id));
        foreach (var reply in replies)
        {
            Assert.Equal(200, reply.Status);
            foreach (var word in Forbidden.Split('|')) Assert.DoesNotContain(word, reply.Body, StringComparison.OrdinalIgnoreCase);
        }
        // Something real was said: Dune downloading 42 % by key, the episode chips on the season.
        var batch = Items(replies[0]).EnumerateArray().ToList();
        var dune = batch.Single(i => i.GetProperty("key").GetString() == "movie:tmdb:693134");
        Assert.Equal(("downloading", 50), (dune.GetProperty("stage").GetString(), dune.GetProperty("progress").GetProperty("percent").GetInt32()));
        var season = Items(replies[3])[0];
        Assert.Equal(4, season.GetProperty("episodes").GetArrayLength());
        Assert.Equal("Dad", JsonDocument.Parse(replies[0].Body).RootElement.GetProperty("contact").GetString());

        // The admin gets the instance detail for the same requests.
        var adminSeason = await Item(rig, rig.Admin, rig.Season1);
        Assert.Contains("SonarrZ", adminSeason.Body);
        Assert.Contains("Manual Import required.", adminSeason.Body);
        Assert.Contains("Mock SABnzbd", adminSeason.Body);
        var adminSintel = await Item(rig, rig.Admin, rig.Sintel);
        Assert.Contains("Radarr4kZ", adminSintel.Body);
        foreach (var reply in new[] { adminSeason, adminSintel }) Assert.DoesNotContain("KEY-0123456789", reply.Body);
    }

    [Fact]
    public async Task AnAdminAndAMemberWithTheSameAccessNeverShareABodyOrAnETag()
    {
        using var rig = new Rig();
        var member = await Item(rig, rig.Member, rig.Sintel);
        var admin = await Item(rig, rig.Admin, rig.Sintel);
        var member2 = await Item(rig, rig.Member2, rig.Sintel);
        Assert.NotEqual(member.Body, admin.Body);
        Assert.Contains("\"admin\"", admin.Body);
        Assert.DoesNotContain("\"admin\"", member.Body);
        Assert.NotEqual(member.ETag, admin.ETag);
        // Two members with the same policy get the same words but never each other's validator.
        Assert.Equal(member.Body, member2.Body);
        Assert.NotEqual(member.ETag, member2.ETag);

        // The member's validator never revalidates someone else's body.
        Assert.Equal(200, (await Item(rig, rig.Admin, rig.Sintel, member.ETag)).Status);
        Assert.Equal(200, (await Item(rig, rig.Member2, rig.Sintel, member.ETag)).Status);
        var again = await Item(rig, rig.Admin, rig.Sintel);
        Assert.Contains("\"admin\"", again.Body);

        // Same for the batch route.
        var batchMember = await Batch(rig, rig.Member, rig.Ids(rig.Sintel, rig.Firefly));
        var batchAdmin = await Batch(rig, rig.Admin, rig.Ids(rig.Sintel, rig.Firefly));
        Assert.NotEqual(batchMember.ETag, batchAdmin.ETag);
        Assert.DoesNotContain("\"admin\"", batchMember.Body);
    }

    [Fact]
    public async Task ResponsesArePrivateAndRevalidateWithTheirOwnETag()
    {
        using var rig = new Rig();
        var first = await Item(rig, rig.Member, rig.Sintel);
        Assert.Equal("private, no-cache", first.CacheControl);
        Assert.StartsWith("\"", first.ETag);
        var revalidated = await Item(rig, rig.Member, rig.Sintel, first.ETag);
        Assert.Equal((304, first.ETag), (revalidated.Status, revalidated.ETag));
        var batch = await Batch(rig, rig.Member, rig.Ids(rig.Sintel));
        Assert.Equal(304, (await Batch(rig, rig.Member, rig.Ids(rig.Sintel), null, batch.ETag)).Status);
    }

    [Fact]
    public async Task UserRequestsNeverCallAnArr()
    {
        using var rig = new Rig();
        // Cold: the requests wait for the background loads, which are not theirs.
        await Batch(rig, rig.Member, rig.Ids(rig.Sintel, rig.Firefly, rig.Season1, rig.Episode3), "movie:tmdb:693134");
        await Item(rig, rig.Admin, rig.Season1);
        var warm = rig.Arr.Transport.Calls;
        for (var i = 0; i < 3; i++)
        {
            await Batch(rig, rig.Member, rig.Ids(rig.Sintel, rig.Firefly, rig.Season1, rig.Episode3), "movie:tmdb:693134");
            await Item(rig, rig.Admin, rig.Season1);
            await Item(rig, rig.Member, rig.Sintel);
            await Item(rig, rig.Kid, rig.Episode3);
        }
        Assert.Equal(warm, rig.Arr.Transport.Calls);
        var routes = rig.Store.Describe().Routes;
        foreach (var route in new[] { "acquire/status", "acquire/status/item" })
        {
            Assert.True(routes[route].Requests >= 4);
            Assert.Equal((0L, 0L), (routes[route].RequestsWithUpstreamCalls, routes[route].UpstreamCalls));
        }
        // The season page read the series' episodes once, in the background.
        Assert.Equal(1, rig.Arr.CallCount("sonarr.lan", "/api/v3/episode"));
    }

    [Fact]
    public async Task ADownloadMovesToAlmostReadyOnImportAndToReadyOnceJellyfinHasIt()
    {
        using var rig = new Rig();
        var radarr = rig.Arr.Instance("RadarrMainZ");
        async Task<JsonElement> Dune(StatusViewer viewer) => Items(await Batch(rig, viewer, null, "movie:tmdb:693134"))[0];
        async Task Refresh()
        {
            rig.Arr.Now += TimeSpan.FromSeconds(3);
            await Task.WhenAll(rig.Store.Tick());
            rig.Arr.Now += TimeSpan.FromSeconds(3);
            await Task.WhenAll(rig.Store.Tick());
        }

        var before = await Batch(rig, rig.Member, null, "movie:tmdb:693134");
        Assert.Equal("downloading", Items(before)[0].GetProperty("stage").GetString());

        // Progress moves: a new body and a new validator.
        rig.Radarr.Queue[0]["sizeleft"] = 200.0;
        rig.Store.RequestRefresh(radarr.Id, ArrSnapshotKind.Queue);
        await Refresh();
        var moved = await Batch(rig, rig.Member, null, "movie:tmdb:693134");
        Assert.Equal(90, Items(moved)[0].GetProperty("progress").GetProperty("percent").GetInt32());
        Assert.NotEqual(before.ETag, moved.ETag);

        // Imported: the row leaves the queue, Radarr has the file. Leaving the queue asks for the
        // library (and history) again without waiting for their own interval.
        var movieCalls = rig.Arr.CallCount("radarr.lan", "/api/v3/movie");
        rig.Radarr.Queue.Clear();
        rig.Radarr.Movies[1]["hasFile"] = true;
        rig.Store.RequestRefresh(radarr.Id, ArrSnapshotKind.Queue);
        rig.Arr.Now += TimeSpan.FromSeconds(3);
        await Task.WhenAll(rig.Store.Tick());
        // Between the queue read and the library read: "almost ready", never back to "looking".
        var between = await Dune(rig.Member);
        Assert.Equal(("almostReady", "importing"), (between.GetProperty("stage").GetString(), between.GetProperty("reason").GetProperty("code").GetString()));
        rig.Arr.Now += TimeSpan.FromSeconds(3);
        await Task.WhenAll(rig.Store.Tick());
        Assert.True(rig.Arr.CallCount("radarr.lan", "/api/v3/movie") > movieCalls);
        var imported = await Dune(rig.Member);
        Assert.Equal(("almostReady", "library_pending"), (imported.GetProperty("stage").GetString(), imported.GetProperty("reason").GetProperty("code").GetString()));

        // Jellyfin scans it in: Ready (a playable item this user can open).
        var duneKey = TitleKey.Parse("movie:tmdb:693134")!;
        rig.View.AddCopy(duneKey, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/movies/Dune Part Two (2024)/Dune.mkv", LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        Assert.Equal("ready", (await Dune(rig.Member)).GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AViewerWithParentalLimitsLearnsNothingAboutTitlesTheyCannotOpen()
    {
        using var rig = new Rig();
        var kid = Items(await Batch(rig, rig.Kid, null, "movie:tmdb:693134,movie:tmdb:45745"));
        Assert.Equal(new[] { "movie:tmdb:45745" }, kid.EnumerateArray().Select(i => i.GetProperty("key").GetString()).ToArray());
        Assert.Equal(2, Items(await Batch(rig, rig.Member, null, "movie:tmdb:693134,movie:tmdb:45745")).GetArrayLength());
    }

    [Fact]
    public async Task TheSeasonRouteGivesRowsChipsAndBannerEntriesForTheViewer()
    {
        using var rig = new Rig();
        Dictionary<int, JsonElement> Episodes(JsonElement season) => season.GetProperty("episodes").EnumerateArray().ToDictionary(e => e.GetProperty("episode").GetInt32());
        // A member who doesn't show missing episodes: only the real episode has a row; the rest go to the banner.
        var season = Items(await Item(rig, rig.Member, rig.Season1))[0];
        var episodes = Episodes(season);
        Assert.Equal(("ready", true), (episodes[1].GetProperty("stage").GetString(), episodes[1].GetProperty("row").GetBoolean()));
        Assert.Equal(("looking", false), (episodes[2].GetProperty("stage").GetString(), episodes[2].GetProperty("row").GetBoolean()));
        Assert.Equal(("downloading", false), (episodes[3].GetProperty("stage").GetString(), episodes[3].GetProperty("row").GetBoolean()));
        Assert.Equal(("almostReady", true), (episodes[4].GetProperty("stage").GetString(), episodes[4].GetProperty("attention").GetBoolean()));
        Assert.Equal("downloading", season.GetProperty("stage").GetString());
        // One who shows missing episodes has a (virtual) row for E3, so its chip goes there instead.
        var withRows = Episodes(Items(await Item(rig, rig.ShowsMissing, rig.Season1))[0]);
        Assert.Equal((true, rig.Episode3.ToString("N")), (withRows[3].GetProperty("row").GetBoolean(), withRows[3].GetProperty("itemId").GetString()));
    }

    [Fact]
    public async Task AMemberLearnsNothingAboutATitleOnlyInALibraryTheyCannotOpen()
    {
        using var rig = new Rig();
        // Dune is downloading in Radarr and already has a copy in "Adults", which only the admin can open.
        var dune = TitleKey.Parse("movie:tmdb:693134")!;
        rig.View.AddCopy(dune, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/adults/Dune Part Two (2024)/Dune.mkv", LibraryId = "adults", LibraryName = "Adults" }, rig.Admin.UserId);
        rig.View.Rev++;
        var items = Items(await Batch(rig, rig.Member, null, "movie:tmdb:693134,movie:tmdb:424242")).EnumerateArray().ToList();
        string Shape(JsonElement e) => e.ToString()!.Replace(e.GetProperty("key").GetString()!, "KEY", StringComparison.Ordinal);
        Assert.Equal(2, items.Count);
        // Exactly the answer of a title no arr and no library has.
        Assert.Equal(Shape(items[1]), Shape(items[0]));
        Assert.DoesNotContain("not_visible_to_user", items[0].ToString());
        // The admin is told where it is.
        var admin = Items(await Batch(rig, rig.Admin, null, "movie:tmdb:693134"))[0];
        Assert.Equal("ready", admin.GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AMemberWhoCannotOpenThe4kLibraryStillSeesTheStandardDownload()
    {
        using var rig = new Rig();
        // Mock 01: Radarr 4K has Dune and it is in "Movies 4K", which only the admin can open;
        // Radarr (standard) is downloading it.
        rig.Radarr4k.Movies.Add(FakeArr.Movie(2, 693134, "Dune Part Two", path: "/data/movies4k/Dune Part Two (2024)"));
        var dune = TitleKey.Parse("movie:tmdb:693134")!;
        rig.View.AddCopy(dune, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/movies4k/Dune Part Two (2024)/Dune.mkv", LibraryId = "movies4k", LibraryName = "Movies 4K" }, rig.Admin.UserId);
        rig.View.Rev++;

        var member = await Batch(rig, rig.Member, null, "movie:tmdb:693134");
        var status = Items(member)[0];
        Assert.Equal(("downloading", "downloading", 50), (status.GetProperty("stage").GetString(), status.GetProperty("reason").GetProperty("code").GetString(), status.GetProperty("progress").GetProperty("percent").GetInt32()));
        // The 4K copy stays invisible: no trace of it, or of a copy they can't open.
        Assert.DoesNotMatch("not_visible_to_user|4[kK]|Movies 4K|movies4k|" + Forbidden, member.Body);
        // The admin's headline is the copy they can open.
        var admin = Items(await Batch(rig, rig.Admin, null, "movie:tmdb:693134"))[0];
        Assert.Equal("ready", admin.GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AnEpisodeHiddenFromAViewerIsLeftOutOfTheirSeason()
    {
        using var rig = new Rig();
        // S1E2 is in Jellyfin but only the admin may see it (its own rating); Sonarr has no file for it.
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2 }, rig.Admin.UserId);
        rig.View.Rev++;
        var kid = Items(await Item(rig, rig.Kid, rig.Season1))[0];
        var episodes = kid.GetProperty("episodes").EnumerateArray().Select(e => e.GetProperty("episode").GetInt32()).ToArray();
        Assert.Equal(new[] { 1, 3, 4 }, episodes);
        Assert.DoesNotContain("s1e2", kid.ToString());
        Assert.Equal(0, kid.GetProperty("summary").TryGetProperty("missing", out var missing) ? missing.GetInt32() : 0);
        // The admin sees it as ready.
        var admin = Items(await Item(rig, rig.Admin, rig.Season1))[0].GetProperty("episodes").EnumerateArray().Single(e => e.GetProperty("episode").GetInt32() == 2);
        Assert.Equal("ready", admin.GetProperty("stage").GetString());
    }
    // ------------------------------------------------------------------ review round 2

    /// <summary>Firefly's E1 (on disk) only the admin may see; Jellyfin's season 1 item is visible to everyone.</summary>
    private static void HideEpisode1FromAllButTheAdmin(Rig rig)
    {
        var episodes = rig.View.EpisodesBySeries[rig.Firefly];
        var i = episodes.FindIndex(e => e.Episode.ItemId == rig.Episode1);
        episodes[i] = (episodes[i].Episode, new HashSet<Guid> { rig.Admin.UserId });
        rig.View.AddSeason(rig.Firefly, new JfSeason { ItemId = rig.Season1, Season = 1 });
        rig.View.Rev++;
    }

    [Fact]
    public async Task AVisibleSeasonStaysOnTheSeriesPageWhenItsOnlyImportedEpisodeIsHidden()
    {
        using var rig = new Rig();
        rig.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject
        {
            ["seasonNumber"] = 1, ["monitored"] = true,
            ["statistics"] = new JsonObject { ["episodeFileCount"] = 1, ["episodeCount"] = 4, ["totalEpisodeCount"] = 4 },
        });
        HideEpisode1FromAllButTheAdmin(rig);
        var kid = Items(await Item(rig, rig.Kid, rig.Firefly))[0];
        var season = Assert.Single(kid.GetProperty("seasons").EnumerateArray().ToList());
        Assert.Equal((1, rig.Season1.ToString("N")), (season.GetProperty("season").GetInt32(), season.GetProperty("itemId").GetString()));
        Assert.Equal(1, season.GetProperty("summary").GetProperty("downloading").GetInt32());
        Assert.Equal(("downloading", 1), (kid.GetProperty("stage").GetString(), kid.GetProperty("summary").GetProperty("downloading").GetInt32()));
        // The season page agrees, without E1.
        var page = Items(await Item(rig, rig.Kid, rig.Season1))[0];
        Assert.Equal(new[] { 2, 3, 4 }, page.GetProperty("episodes").EnumerateArray().Select(e => e.GetProperty("episode").GetInt32()).ToArray());
    }

    [Fact]
    public async Task AnEpisodeListSonarrCannotAnswerTellsAdministratorsAndLeavesTheSeasonToSonarrsCounts()
    {
        using var rig = new Rig();
        rig.Sonarr.EpisodesFailWith = 503;
        var admin = Items(await Item(rig, rig.Admin, rig.Season1))[0];
        Assert.Contains(admin.GetProperty("admin").GetProperty("unreadable").EnumerateArray(), u => u.GetString()!.Contains("episode list", StringComparison.Ordinal));
        // Viewers get the season as before, with no administrator detail.
        var kid = Items(await Item(rig, rig.Kid, rig.Season1))[0];
        Assert.False(kid.TryGetProperty("admin", out var a) && a.ValueKind == JsonValueKind.Object);
    }

    [Fact]
    public async Task SeriesCardsAndKeysLeaveOutDownloadsOfEpisodesHiddenFromTheViewer()
    {
        using var rig = new Rig();
        // The only download of Firefly is an upgrade of E1, which the kid may not see.
        rig.Sonarr.Queue.Clear();
        var upgrade = FakeArr.SonarrQueueRow(101, "dl101", 1, 1, "Firefly", 78874);
        upgrade["episodeId"] = 101;
        rig.Sonarr.Queue.Add(upgrade);
        HideEpisode1FromAllButTheAdmin(rig);
        rig.View.AddCopy(TitleKey.Parse("tv:tvdb:78874")!, new JfCopy { ItemId = rig.Firefly, Path = "/media/tv/Firefly", LibraryName = "TV" });
        rig.View.Rev++;

        var card = Items(await Batch(rig, rig.Kid, rig.Ids(rig.Firefly), "tv:tvdb:78874")).EnumerateArray().ToList();
        Assert.Equal(2, card.Count);
        foreach (var status in card)
        {
            Assert.Equal("ready", status.GetProperty("stage").GetString());
            Assert.False(status.TryGetProperty("progress", out _));
        }
        Assert.True(card[0].GetProperty("quiet").GetBoolean());
        // The admin plays E1, so its download is an upgrade: Ready on both, as the series page says (edition r11, D53). For
        // the kid, who doesn't play it, only the hidden-parts rule keeps it from reading as a download.
        var admin = Items(await Batch(rig, rig.Admin, rig.Ids(rig.Firefly), "tv:tvdb:78874")).EnumerateArray().ToList();
        Assert.Equal(("ready", true), (admin[0].GetProperty("stage").GetString(), admin[0].GetProperty("quiet").GetBoolean()));
        Assert.False(admin[0].TryGetProperty("progress", out _));
        Assert.Equal("ready", admin[1].GetProperty("stage").GetString());
    }

    /// <summary>Absent-title pages by id (the native details resolver of the Jellyfin 12 build).</summary>
    private sealed class FakePages : IAbsentTitlePages
    {
        public Dictionary<Guid, AbsentPageResult> Pages { get; } = new();

        public Task<AbsentPageResult> ResolveAsync(Guid viewerId, Guid id, CancellationToken ct)
            => Task.FromResult(Pages.TryGetValue(id, out var page) ? page : AbsentPageResult.NotAbsent);
    }

    private static Task<Reply> AbsentItem(Rig rig, StatusViewer viewer, FakePages pages, Guid id)
        => Call(rig, viewer, c =>
        {
            var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
            Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton<IAbsentTitlePages>(services, pages);
            c.HttpContext.RequestServices = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
            return c.GetItemStatus(id.ToString("N"), CancellationToken.None);
        });

    private static AbsentPageResult Found(AbsentTitle title) => new(AbsentLookup.Found, title);

    [Fact]
    public async Task AnAbsentTitlesPageIsComposedByKeyNeverAsACopy()
    {
        using var rig = new Rig();
        var pages = new FakePages();
        // Not in any arr or library: not here, no item id, nothing to open.
        var absentMovie = Guid.NewGuid();
        pages.Pages[absentMovie] = Found(new AbsentTitle { PageId = absentMovie, Kind = "movie", Title = TitleKey.Parse("movie:tmdb:438631")!, TmdbId = 438631 });
        var movie = Items(await AbsentItem(rig, rig.Member, pages, absentMovie))[0];
        Assert.Equal(("notHere", "not_in_arr"), (movie.GetProperty("stage").GetString(), movie.GetProperty("reason").GetProperty("code").GetString()));
        Assert.False(movie.TryGetProperty("itemId", out _));
        Assert.False(movie.TryGetProperty("openItemId", out _));
        // Downloading in Radarr while Jellyfin has no copy for this member: the arr's state, still nothing to open.
        var dune = Guid.NewGuid();
        pages.Pages[dune] = Found(new AbsentTitle { PageId = dune, Kind = "movie", Title = TitleKey.Parse("movie:tmdb:693134")!, TmdbId = 693134 });
        var downloading = Items(await AbsentItem(rig, rig.Member, pages, dune))[0];
        Assert.Equal("downloading", downloading.GetProperty("stage").GetString());
        Assert.False(downloading.TryGetProperty("openItemId", out _));
        // A copy the viewer can open arrived: Open names it (the page id is never a copy).
        var sintel = Guid.NewGuid();
        pages.Pages[sintel] = Found(new AbsentTitle { PageId = sintel, Kind = "movie", Title = TitleKey.Parse("movie:tmdb:45745")!, TmdbId = 45745 });
        var arrived = Items(await AbsentItem(rig, rig.Member, pages, sintel))[0];
        Assert.Equal(rig.Sintel.ToString("N"), arrived.GetProperty("openItemId").GetString());
        Assert.NotEqual(sintel.ToString("N"), arrived.TryGetProperty("itemId", out var own) ? own.GetString() : null);
        // A page the viewer may not open (or whose metadata is down): the empty list of an unseen item.
        var refused = Guid.NewGuid();
        pages.Pages[refused] = AbsentPageResult.Refused;
        Assert.Equal(0, Items(await AbsentItem(rig, rig.Member, pages, refused)).GetArrayLength());
        var down = Guid.NewGuid();
        pages.Pages[down] = AbsentPageResult.Unavailable;
        Assert.Equal(0, Items(await AbsentItem(rig, rig.Member, pages, down)).GetArrayLength());
        // Ordinary ids still go to the library item.
        Assert.Equal(rig.Sintel.ToString("N"), Items(await AbsentItem(rig, rig.Member, pages, rig.Sintel))[0].GetProperty("itemId").GetString());
    }

    [Fact]
    public async Task AnAbsentSeriesAndItsSeasonsComeFromPublicMetadataWhenNoSonarrHoldsThem()
    {
        using var rig = new Rig();
        var pages = new FakePages();
        var key = TitleKey.Parse("tv:tvdb:393189")!;
        Guid seriesPage = Guid.NewGuid(), s1 = Guid.NewGuid(), s2 = Guid.NewGuid(), seasonPage = Guid.NewGuid(), e1 = Guid.NewGuid(), e2 = Guid.NewGuid(), e3 = Guid.NewGuid();
        var now = rig.Arr.Now.UtcDateTime;
        pages.Pages[seriesPage] = Found(new AbsentTitle
        {
            PageId = seriesPage, Kind = "series", Title = key, TmdbId = 83867,
            Seasons = new[] { new AbsentSeason(0, 2, 2, null, Guid.NewGuid()), new AbsentSeason(1, 3, 3, now.AddYears(-3), s1), new AbsentSeason(2, 12, 0, now.AddDays(30), s2) },
        });
        var series = Items(await AbsentItem(rig, rig.Member, pages, seriesPage))[0];
        Assert.Equal(("series", "notHere"), (series.GetProperty("kind").GetString(), series.GetProperty("stage").GetString()));
        var seasons = series.GetProperty("seasons").EnumerateArray().ToList();
        // Specials left out; the next season not out yet; nothing counted as missing or ready.
        Assert.Equal(new[] { 1, 2 }, seasons.Select(x => x.GetProperty("season").GetInt32()));
        Assert.Equal((s1.ToString("N"), "notHere", 3, 0), (seasons[0].GetProperty("itemId").GetString(), seasons[0].GetProperty("stage").GetString(), seasons[0].GetProperty("summary").GetProperty("aired").GetInt32(), seasons[0].GetProperty("summary").GetProperty("missing").GetInt32()));
        Assert.Equal("notOut", seasons[1].GetProperty("stage").GetString());

        AbsentTitle Season(bool rows) => new()
        {
            PageId = seasonPage, Kind = "season", Title = key, TmdbId = 83867, Season = 1, SeriesPageId = seriesPage, Rows = rows,
            Episodes = new[] { new AbsentEpisode(1, 1, now.AddDays(-9), e1), new AbsentEpisode(1, 2, now.AddDays(-2), e2), new AbsentEpisode(1, 3, now.AddDays(5), e3) },
        };
        pages.Pages[seasonPage] = Found(Season(rows: false));
        var banner = Items(await AbsentItem(rig, rig.Member, pages, seasonPage))[0];
        var episodes = banner.GetProperty("episodes").EnumerateArray().ToList();
        Assert.Equal(new[] { "notHere", "notHere", "notOut" }, episodes.Select(e => e.GetProperty("stage").GetString()));
        // The viewer doesn't show missing episodes: no rows, so the banner lists them.
        Assert.All(episodes, e => Assert.False(e.GetProperty("row").GetBoolean()));
        Assert.All(episodes, e => Assert.False(e.TryGetProperty("itemId", out _)));
        Assert.Equal((2, 3), (banner.GetProperty("summary").GetProperty("aired").GetInt32(), banner.GetProperty("summary").GetProperty("nextEpisode").GetInt32()));
        Assert.Equal("tv:tvdb:393189:s1", banner.GetProperty("key").GetString());
        // One who shows them: each episode is a row of the page, named by its page id.
        pages.Pages[seasonPage] = Found(Season(rows: true));
        var rows = Items(await AbsentItem(rig, rig.ShowsMissing, pages, seasonPage))[0].GetProperty("episodes").EnumerateArray().ToList();
        Assert.Equal(new[] { e1, e2, e3 }.Select(g => g.ToString("N")), rows.Select(e => e.GetProperty("itemId").GetString()));
        Assert.All(rows, e => Assert.True(e.GetProperty("row").GetBoolean()));
    }

    /// <summary>Request facts by title and by episode (the ledger's answers, set per test).</summary>
    private sealed class FakeRequests : IArrRequestFacts
    {
        public RequestFacts? Title { get; set; }
        public Dictionary<(int Season, int Episode), RequestFacts> Episodes { get; } = new();
        public Dictionary<int, RequestFacts> Seasons { get; } = new();
        public long Revision { get; set; }
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer) => Title;
        public RequestFacts? ForEpisode(TitleKey seriesKey, int season, int episode, StatusViewer viewer) => Episodes.GetValueOrDefault((season, episode));
        public RequestFacts? ForSeason(TitleKey seriesKey, int season, StatusViewer viewer) => Seasons.GetValueOrDefault(season);
        public bool AskedBy(TitleKey titleKey, Guid userId) => false;
        public bool Requested(TitleKey titleKey) => false;
        public bool AskedLatelyBy(TitleKey titleKey, Guid userId) => false;
        public bool RequestedLately(TitleKey titleKey) => false;
    }

    [Fact]
    public async Task AnAbsentSeasonFollowsTheAsksForThatWholeSeasonAndADateOnlyAirDayIsADay()
    {
        var requests = new FakeRequests();
        using var rig = new Rig(requests);
        var pages = new FakePages();
        var key = TitleKey.Parse("tv:tvdb:393189")!;
        var now = rig.Arr.Now.UtcDateTime;
        var today = now.Date;
        AbsentTitle Season(int season, DateTime air, AbsentRowSpoilers? spoilers = null) => new()
        {
            PageId = Guid.NewGuid(), Kind = "season", Title = key, TmdbId = 83867, Season = season, SeriesPageId = Guid.NewGuid(), Spoilers = spoilers,
            Episodes = new[] { new AbsentEpisode(season, 1, today.AddDays(-9), Guid.NewGuid()), new AbsentEpisode(season, 2, air, Guid.NewGuid()) },
        };
        async Task<JsonElement> Status(AbsentTitle page)
        {
            pages.Pages[page.PageId] = Found(page);
            return Items(await AbsentItem(rig, rig.Member, pages, page.PageId))[0];
        }

        string[] Stages(JsonElement s) => s.GetProperty("episodes").EnumerateArray().Select(e => e.GetProperty("stage").GetString()!).ToArray();

        // Nothing asked: not here (Get Season N).
        Assert.Equal("notHere", (await Status(Season(1, today.AddDays(-7)))).GetProperty("stage").GetString());
        // Asks for the series as a whole or for another season never mark this season as asked.
        requests.Title = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        requests.Seasons[2] = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal("notHere", (await Status(Season(1, today.AddDays(-7)))).GetProperty("stage").GetString());
        // An ask for this season waiting for an OK: the season and its aired episodes read as asked, on every read.
        requests.Seasons[1] = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        requests.Revision++;
        var asked = await Status(Season(1, today.AddDays(-7)));
        Assert.Equal(("asked", "awaiting_approval"), (asked.GetProperty("stage").GetString(), asked.GetProperty("reason").GetProperty("code").GetString()));
        Assert.Equal(new[] { "asked", "asked" }, Stages(asked));
        Assert.Equal("asked", (await Status(Season(1, today.AddDays(-7)))).GetProperty("stage").GetString());
        // OK'd: approved; declined: not here, saying so.
        requests.Seasons[1] = new RequestFacts { ApprovedAt = now.AddHours(-1), AskedAt = now.AddHours(-2), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal("approved", (await Status(Season(1, today.AddDays(-7)))).GetProperty("stage").GetString());
        // OK'd but Sonarr doesn't list the season yet (checked again on its own): "Not aired yet", not "Getting started".
        requests.Seasons[1] = new RequestFacts { ApprovedAt = now.AddHours(-1), AskedAt = now.AddHours(-2), AskedByViewer = true, NotListed = true };
        requests.Revision++;
        var notListed = await Status(Season(1, today.AddDays(-7)));
        Assert.Equal(("approved", "not_aired"), (notListed.GetProperty("stage").GetString(), notListed.GetProperty("reason").GetProperty("code").GetString()));
        // OK'd but held until a person sorts it out (no 4K instance now, say): taking longer, not "Getting started".
        requests.Seasons[1] = new RequestFacts { ApprovedAt = now.AddHours(-1), AskedAt = now.AddHours(-2), AskedByViewer = true, HeldAfterOk = true };
        requests.Revision++;
        var held = await Status(Season(1, today.AddDays(-7)));
        Assert.Equal(("approved", "approved_not_in_arr", true), (held.GetProperty("stage").GetString(), held.GetProperty("reason").GetProperty("code").GetString(), held.GetProperty("attention").GetBoolean()));
        requests.Seasons[1] = new RequestFacts { Declined = true, AskedAt = now.AddHours(-2), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal(("notHere", "declined"), ((await Status(Season(1, today.AddDays(-7)))).GetProperty("stage").GetString(), (await Status(Season(1, today.AddDays(-7)))).GetProperty("reason").GetProperty("code").GetString()));

        // Spoiler Guard on the title with its air-date switch: the rows name no air dates.
        requests.Seasons.Clear();
        requests.Revision++;
        bool Dated(JsonElement s) => s.GetProperty("episodes").EnumerateArray().Any(e => e.TryGetProperty("airDate", out var d) && d.ValueKind == JsonValueKind.String);
        Assert.True(Dated(await Status(Season(1, today.AddDays(-7)))));
        Assert.False(Dated(await Status(Season(1, today.AddDays(-7), new AbsentRowSpoilers(true, true, true)))));
        Assert.True(Dated(await Status(Season(1, today.AddDays(-7), new AbsentRowSpoilers(true, true, false)))));

        // A date-only air day (TMDB's) is "not out yet" while it is still that day somewhere, as for a
        // Sonarr copy: the whole day it airs and up to 36 hours after its start, then not here.
        requests.Seasons.Clear();
        requests.Revision++;
        var airing = await Status(Season(3, today));
        Assert.Equal(new[] { "notHere", "notOut" }, Stages(airing));
        Assert.Equal(1, airing.GetProperty("summary").GetProperty("aired").GetInt32());
        AbsentTitle Episode(DateTime air)
        {
            var id = Guid.NewGuid();
            return new() { PageId = id, Kind = "episode", Title = key, TmdbId = 83867, Season = 3, Episode = 2, SeriesPageId = Guid.NewGuid(), Episodes = new[] { new AbsentEpisode(3, 2, air, id) } };
        }

        Assert.Equal("notOut", (await Status(Episode(today))).GetProperty("stage").GetString());
        rig.Arr.Now = new DateTimeOffset(today.AddHours(35), TimeSpan.Zero);
        Assert.Equal(new[] { "notHere", "notOut" }, Stages(await Status(Season(3, today))));
        Assert.Equal("notOut", (await Status(Episode(today))).GetProperty("stage").GetString());
        rig.Arr.Now = new DateTimeOffset(today.AddHours(37), TimeSpan.Zero);
        var aired = await Status(Season(3, today));
        Assert.Equal(new[] { "notHere", "notHere" }, Stages(aired));
        Assert.Equal(2, aired.GetProperty("summary").GetProperty("aired").GetInt32());
        Assert.Equal("notHere", (await Status(Episode(today))).GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AnAbsentEpisodeIsNotOutUntilItAirsAndFollowsTheAsksThatCoverIt()
    {
        var requests = new FakeRequests();
        using var rig = new Rig(requests);
        var pages = new FakePages();
        var key = TitleKey.Parse("tv:tvdb:393189")!;
        var now = rig.Arr.Now.UtcDateTime;
        Guid e2 = Guid.NewGuid(), e3 = Guid.NewGuid();
        var episodes = new[] { new AbsentEpisode(1, 2, now.AddDays(-2), e2), new AbsentEpisode(1, 3, now.AddDays(5), e3) };
        AbsentTitle Page(Guid id, int number) => new()
        {
            PageId = id, Kind = "episode", Title = key, TmdbId = 83867, Season = 1, Episode = number, SeriesPageId = Guid.NewGuid(), Episodes = episodes,
        };
        pages.Pages[e2] = Found(Page(e2, 2));
        pages.Pages[e3] = Found(Page(e3, 3));
        async Task<JsonElement> Status(Guid id) => Items(await AbsentItem(rig, rig.Member, pages, id))[0];

        // Not aired yet: not out, with its day (no Get it).
        var later = await Status(e3);
        Assert.Equal(("episode", "notOut", "not_aired"), (later.GetProperty("kind").GetString(), later.GetProperty("stage").GetString(), later.GetProperty("reason").GetProperty("code").GetString()));
        Assert.Equal(now.AddDays(5).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), later.GetProperty("nextDay").GetString());
        Assert.Equal("tv:tvdb:393189:s1:e3", later.GetProperty("key").GetString());
        // Aired, nothing asked: not here.
        Assert.Equal("notHere", (await Status(e2)).GetProperty("stage").GetString());
        // A request for another part of the series doesn't mark this episode as asked.
        requests.Title = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal("notHere", (await Status(e2)).GetProperty("stage").GetString());
        // An ask that covers it and waits for an OK: asked, after a reload too.
        requests.Episodes[(1, 2)] = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        var asked = await Status(e2);
        Assert.Equal(("asked", "awaiting_approval"), (asked.GetProperty("stage").GetString(), asked.GetProperty("reason").GetProperty("code").GetString()));
        // Declined: not here again, saying so.
        requests.Episodes[(1, 2)] = new RequestFacts { Declined = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        Assert.Equal(("notHere", "declined"), ((await Status(e2)).GetProperty("stage").GetString(), (await Status(e2)).GetProperty("reason").GetProperty("code").GetString()));
    }

    [Fact]
    public async Task ASeasonPageOfASeriesSonarrHoldsGetsSonarrsEpisodeStatesAndOpenOnceThereIsACopy()
    {
        using var rig = new Rig();
        var pages = new FakePages();
        var key = TitleKey.Parse("tv:tvdb:78874")!;
        Guid seasonPage = Guid.NewGuid(), e2 = Guid.NewGuid(), e3 = Guid.NewGuid();
        pages.Pages[seasonPage] = Found(new AbsentTitle
        {
            PageId = seasonPage, Kind = "season", Title = key, TmdbId = 1437, Season = 1, SeriesPageId = Guid.NewGuid(), Rows = true,
            Episodes = new[] { new AbsentEpisode(1, 2, null, e2), new AbsentEpisode(1, 3, null, e3) },
        });
        var season = Items(await AbsentItem(rig, rig.ShowsMissing, pages, seasonPage))[0];
        // Nothing of this season is in Jellyfin's season list yet: no Open.
        Assert.False(season.TryGetProperty("openItemId", out _));
        rig.View.AddSeason(rig.Firefly, new JfSeason { ItemId = rig.Season1, Season = 1 });
        rig.View.Rev++;
        season = Items(await AbsentItem(rig, rig.ShowsMissing, pages, seasonPage))[0];
        var episodes = season.GetProperty("episodes").EnumerateArray().ToDictionary(e => e.GetProperty("episode").GetInt32());
        // Sonarr: E2 missing (monitored), E3 downloading; the page's rows carry the page ids.
        Assert.Equal(("looking", e2.ToString("N")), (episodes[2].GetProperty("stage").GetString(), episodes[2].GetProperty("itemId").GetString()));
        Assert.Equal("downloading", episodes[3].GetProperty("stage").GetString());
        // Jellyfin has the series and this season for the viewer: Open goes to the season.
        Assert.Equal(rig.Season1.ToString("N"), season.GetProperty("openItemId").GetString());
    }

    [Fact]
    public async Task ASonarrHeldAbsentPageLeavesOutTheSeasonsAndEpisodesTheLibraryHidesFromTheViewer()
    {
        using var rig = new Rig();
        // Sonarr also has a season 2 (aired, monitored, nothing on disk).
        rig.Sonarr.Series[0]["seasons"] = new JsonArray(
            new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeFileCount"] = 1, ["episodeCount"] = 4, ["totalEpisodeCount"] = 4 } },
            new JsonObject { ["seasonNumber"] = 2, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeFileCount"] = 0, ["episodeCount"] = 2, ["totalEpisodeCount"] = 2 } });
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 201, ["seriesId"] = 1, ["seasonNumber"] = 2, ["episodeNumber"] = 1, ["airDateUtc"] = "2003-01-01T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 202, ["seriesId"] = 1, ["seasonNumber"] = 2, ["episodeNumber"] = 2, ["airDateUtc"] = "2003-01-08T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        var pages = new FakePages();
        var key = TitleKey.Parse("tv:tvdb:78874")!;
        var now = rig.Arr.Now.UtcDateTime;
        // Jellyfin hides season 2 and S1E2 from the kid (a custom rating, a blocked tag): the page left them out.
        AbsentTitle Series(bool hidden) => new()
        {
            PageId = Guid.NewGuid(), Kind = "series", Title = key, TmdbId = 1437,
            Seasons = new[] { new AbsentSeason(1, 4, 4, now.AddYears(-20), Guid.NewGuid()) },
            HiddenSeasons = hidden ? new[] { 2 } : Array.Empty<int>(),
            HiddenSeriesEpisodes = hidden ? new[] { (1, 2) } : Array.Empty<(int, int)>(),
        };
        AbsentTitle Season(bool hidden, bool rows) => new()
        {
            PageId = Guid.NewGuid(), Kind = "season", Title = key, TmdbId = 1437, Season = 1, SeriesPageId = Guid.NewGuid(), Rows = rows,
            Episodes = new[] { 1, 3, 4 }.Select(n => new AbsentEpisode(1, n, now.AddYears(-20), Guid.NewGuid())).ToArray(),
            HiddenEpisodes = hidden ? new[] { 2 } : Array.Empty<int>(),
        };
        async Task<JsonElement> Status(AbsentTitle page)
        {
            pages.Pages[page.PageId] = Found(page);
            return Items(await AbsentItem(rig, rig.Kid, pages, page.PageId))[0];
        }

        int Count(JsonElement summary, string name) => summary.TryGetProperty(name, out var n) ? n.GetInt32() : 0;

        // Without the markers Sonarr's numbers would bring the hidden parts back (season 2, S1E2 missing).
        var leaky = await Status(Series(hidden: false));
        Assert.Equal(new[] { 1, 2 }, leaky.GetProperty("seasons").EnumerateArray().Select(x => x.GetProperty("season").GetInt32()));
        var series = await Status(Series(hidden: true));
        var seasons = series.GetProperty("seasons").EnumerateArray().ToList();
        Assert.Equal(new[] { 1 }, seasons.Select(x => x.GetProperty("season").GetInt32()));
        Assert.Equal(3, seasons[0].GetProperty("summary").GetProperty("aired").GetInt32());
        Assert.Equal(0, Count(seasons[0].GetProperty("summary"), "missing"));
        Assert.Equal((3, 0), (series.GetProperty("summary").GetProperty("aired").GetInt32(), Count(series.GetProperty("summary"), "missing")));
        Assert.True(Count(leaky.GetProperty("summary"), "missing") > 0);

        // The season page: no entry, count or state for S1E2, with rows or the banner.
        foreach (var rows in new[] { false, true })
        {
            Assert.Contains(2, (await Status(Season(hidden: false, rows))).GetProperty("episodes").EnumerateArray().Select(e => e.GetProperty("episode").GetInt32()));
            var season = await Status(Season(hidden: true, rows));
            Assert.Equal(new[] { 1, 3, 4 }, season.GetProperty("episodes").EnumerateArray().Select(e => e.GetProperty("episode").GetInt32()));
            Assert.DoesNotContain("78874:s1:e2", season.ToString());
            Assert.Equal((3, 0), (season.GetProperty("summary").GetProperty("aired").GetInt32(), Count(season.GetProperty("summary"), "missing")));
        }
    }

    [Fact]
    public async Task AnAbsentSeriesPageReadsEachSeasonWhereTheAsksForThatSeasonHaveGot()
    {
        var requests = new FakeRequests();
        using var rig = new Rig(requests);
        var pages = new FakePages();
        var now = rig.Arr.Now.UtcDateTime;
        var page = new AbsentTitle
        {
            PageId = Guid.NewGuid(), Kind = "series", Title = TitleKey.Parse("tv:tvdb:393189")!, TmdbId = 83867,
            Seasons = new[] { new AbsentSeason(1, 12, 12, now.AddYears(-3), Guid.NewGuid()), new AbsentSeason(2, 12, 12, now.AddYears(-1), Guid.NewGuid()), new AbsentSeason(3, 12, 0, now.AddDays(30), Guid.NewGuid()) },
        };
        pages.Pages[page.PageId] = Found(page);
        async Task<(string Title, string Seasons)> Stages()
        {
            var status = Items(await AbsentItem(rig, rig.Member, pages, page.PageId))[0];
            return (status.GetProperty("stage").GetString()!, string.Join(",", status.GetProperty("seasons").EnumerateArray().Select(x => x.GetProperty("stage").GetString())));
        }

        Assert.Equal(("notHere", "notHere,notHere,notOut"), await Stages());
        // Season 1 asked (waiting for an OK): the series reads asked and season 1 isn't offered again; season 2 still is.
        requests.Title = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        requests.Seasons[1] = new RequestFacts { Pending = true, AskedAt = now.AddHours(-1), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal(("asked", "asked,notHere,notOut"), await Stages());
        // OK'd: approved; declined: not here (it may be asked for again).
        requests.Seasons[1] = new RequestFacts { ApprovedAt = now.AddHours(-1), AskedAt = now.AddHours(-2), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal("approved,notHere,notOut", (await Stages()).Seasons);
        requests.Seasons[1] = new RequestFacts { Declined = true, AskedAt = now.AddHours(-2), AskedByViewer = true };
        requests.Revision++;
        Assert.Equal("notHere,notHere,notOut", (await Stages()).Seasons);
    }

    [Fact]
    public async Task SpoilerGuardsAirDateSwitchTakesEveryAirDateOutOfAnAbsentPagesStatus()
    {
        using var rig = new Rig();
        var pages = new FakePages();
        var now = rig.Arr.Now.UtcDateTime;
        var later = now.Date.AddDays(20);
        string Day(DateTime d) => d.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        // Sonarr's Firefly gets an episode that airs later (S1E5).
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 105, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 5, ["airDateUtc"] = later.AddHours(20).ToString("o"), ["hasFile"] = false, ["monitored"] = true });
        var guarded = new AbsentRowSpoilers(false, false, true);
        AbsentTitle Page(string key, string kind, int? episode, AbsentRowSpoilers? spoilers)
        {
            var id = Guid.NewGuid();
            return new()
            {
                PageId = id, Kind = kind, Title = TitleKey.Parse(key)!, TmdbId = 83867, Season = 1, Episode = episode, SeriesPageId = Guid.NewGuid(), Spoilers = spoilers,
                Episodes = new[] { new AbsentEpisode(1, 4, now.AddYears(-20), Guid.NewGuid()), new AbsentEpisode(1, 5, later, kind == "episode" ? id : Guid.NewGuid()) },
            };
        }

        async Task<string> Body(AbsentTitle page)
        {
            pages.Pages[page.PageId] = Found(page);
            return Items(await AbsentItem(rig, rig.Member, pages, page.PageId))[0].ToString();
        }

        // No Sonarr (a series nobody holds) and Sonarr's Firefly; the season and the episode that airs later.
        foreach (var key in new[] { "tv:tvdb:393189", "tv:tvdb:78874" })
        {
            foreach (var (kind, episode) in new[] { ("season", (int?)null), ("episode", (int?)5) })
            {
                Assert.Contains(Day(later), await Body(Page(key, kind, episode, null)));
                var body = await Body(Page(key, kind, episode, guarded));
                Assert.DoesNotContain(Day(later), body);
                Assert.DoesNotContain("\"date\"", body);
                Assert.DoesNotContain("\"nextAir\"", body);
                Assert.DoesNotContain("\"airDate\"", body);
                // Still not out: the stage stays, without its day.
                Assert.Contains("\"notOut\"", body);
            }
        }

        // An aired episode Sonarr is looking for: its journey's Looking stop is its air day (S1E4, 2002-10-11).
        AbsentTitle Aired(AbsentRowSpoilers? spoilers)
        {
            var id = Guid.NewGuid();
            return new()
            {
                PageId = id, Kind = "episode", Title = TitleKey.Parse("tv:tvdb:78874")!, TmdbId = 1437, Season = 1, Episode = 4, SeriesPageId = Guid.NewGuid(), Spoilers = spoilers,
                Episodes = new[] { new AbsentEpisode(1, 4, new DateTime(2002, 10, 11, 0, 0, 0, DateTimeKind.Utc), id) },
            };
        }

        rig.Sonarr.Queue.Clear();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(10);
        await Task.WhenAll(rig.Store.Tick());
        Assert.Contains("2002-10-11", await Body(Aired(null)));
        Assert.DoesNotContain("2002-10-11", await Body(Aired(guarded)));

        // The other Spoiler Guard switches leave the dates alone.
        Assert.Contains(Day(later), await Body(Page("tv:tvdb:393189", "season", null, new AbsentRowSpoilers(true, true, false))));
    }

#if !NET9_0
    [Fact]
    public async Task TheNavigatorOpensACopyTheViewerCanOpenFirstElseTheNativePage()
    {
        using var rig = new Rig();
        const string server = "0202511b0eac4284ab045b3ba556d72e";
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.NativeAbsentDetailsEnabled = true;
        c.TMDB_API_KEY = "tmdb-test";
        using var tmdbTransport = new IntegrationTransport((req, _) => Task.FromResult(IntegrationTransport.Response(
            req.RequestUri!.AbsolutePath.EndsWith("/find/78874", StringComparison.Ordinal) ? """{"tv_results":[{"id":1437}],"movie_results":[]}""" : """{"tv_results":[],"movie_results":[]}""")));
        using var tmdb = new Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbResponseCache(tmdbTransport, TimeProvider.System);
        var host = new Moq.Mock<MediaBrowser.Controller.IServerApplicationHost>();
        host.SetupGet(h => h.SystemId).Returns(server);
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsController Controller(StatusViewer? viewer)
        {
            var controller = new Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsController(rig.Service, host.Object, new TitleAliases(rig.Store, null), tmdb)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            controller.HttpContext.User = rig.Controller(viewer).HttpContext.User;
            return controller;
        }

        async Task<(int Status, string Body)> Resolve(StatusViewer? viewer, string? key, string? id = null, int? season = null, int? episode = null)
        {
            var result = await Controller(viewer).Resolve(key, id, season, episode, CancellationToken.None);
            return result is ObjectResult o ? (o.StatusCode ?? 200, JsonSerializer.Serialize(o.Value)) : throw new InvalidOperationException(result.GetType().Name);
        }

        string Syn(Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.SyntheticId id) => id.Format(server);
        // A copy the viewer can open wins; a title that isn't here opens its native page.
        Assert.Equal((200, $$"""{"itemId":"{{rig.Sintel:N}}"}"""), await Resolve(rig.Member, "movie:tmdb:45745"));
        Assert.Equal((200, $$"""{"id":"{{Syn(Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.SyntheticId.Movie(438631))}}"}"""), await Resolve(rig.Member, "movie:tmdb:438631"));
        // A deep link to a title that is here now goes to it.
        Assert.Equal((200, $$"""{"itemId":"{{rig.Sintel:N}}"}"""), await Resolve(rig.Member, null, Syn(Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.SyntheticId.Movie(45745))));
        // A season the series copy hasn't got: the season's native page, its TMDB id found by TVDB id.
        Assert.Equal((200, $$"""{"id":"{{Syn(Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.SyntheticId.SeasonOf(1437, 1))}}"}"""), await Resolve(rig.Member, "tv:tvdb:78874", season: 1));
        rig.View.AddSeason(rig.Firefly, new JfSeason { ItemId = rig.Season1, Season = 1 });
        rig.View.Rev++;
        Assert.Equal((200, $$"""{"itemId":"{{rig.Season1:N}}"}"""), await Resolve(rig.Member, "tv:tvdb:78874:s1"));
        Assert.Equal((200, $$"""{"itemId":"{{rig.Firefly:N}}"}"""), await Resolve(rig.Member, "tv:tvdb:78874"));
        // An episode with a file opens it; a missing (virtual) one the library lists is no copy: its native page.
        Assert.Equal((200, $$"""{"itemId":"{{rig.Episode1:N}}"}"""), await Resolve(rig.Member, "tv:tvdb:78874", season: 1, episode: 1));
        Assert.Equal((200, $$"""{"id":"{{Syn(Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.SyntheticId.EpisodeOf(1437, 1, 3))}}"}"""), await Resolve(rig.Member, "tv:tvdb:78874", season: 1, episode: 3));
        // Bad input, no person, switched off.
        Assert.Equal(400, (await Resolve(rig.Member, "nonsense")).Status);
        Assert.Equal(400, (await Resolve(rig.Member, "movie:tmdb:1", season: 1)).Status);
        Assert.Equal(400, (await Resolve(rig.Member, null, Guid.NewGuid().ToString("N"))).Status);
        Assert.Equal(404, (await Resolve(rig.Member, "tv:tvdb:5")).Status);
        Assert.Equal(403, (await Resolve(null, "movie:tmdb:45745")).Status);
        c.NativeAbsentDetailsEnabled = false;
        Assert.Equal(403, (await Resolve(rig.Member, "movie:tmdb:45745")).Status);
    }
#endif

    private static Task<Reply> Arrival(Rig rig, StatusViewer? viewer, string? key, Guid? itemId = null, Guid? seriesId = null)
        => Call(rig, viewer, c => Task.FromResult(c.GetArrival(key, itemId?.ToString("N"), seriesId?.ToString("N"))));

    private static string? ArrivedId(Reply reply)
    {
        Assert.Equal(200, reply.Status);
        var id = JsonDocument.Parse(reply.Body).RootElement.GetProperty("itemId");
        return id.ValueKind == JsonValueKind.Null ? null : id.GetString();
    }

    [Fact]
    public async Task AMissingEpisodeWhoseFileArrivedReadsAsTheEpisodeJellyfinAddedForItAndNamesIt()
    {
        using var rig = new Rig();
        // Before: the virtual S1E3 shows where Sonarr has got to; nothing to open.
        var before = Items(await Item(rig, rig.Member, rig.Episode3))[0];
        Assert.NotEqual("ready", before.GetProperty("stage").GetString());
        Assert.False(before.TryGetProperty("openItemId", out _));

        // Jellyfin adds the file's episode under a new id and keeps the virtual one until its next
        // series refresh (seen live on 12.2 when the season folder already existed).
        var arrived = Guid.NewGuid();
        var key = TitleKey.Parse("tv:tvdb:78874:s1:e3")!;
        rig.View.AddItem(new JfItemRef { ItemId = arrived, Kind = "episode", Key = key, SeriesId = rig.Firefly, Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = arrived, Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        var after = Items(await Item(rig, rig.Member, rig.Episode3))[0];
        Assert.Equal("ready", after.GetProperty("stage").GetString());
        Assert.Equal(arrived.ToString("N"), after.GetProperty("openItemId").GetString());
        Assert.Equal(key.ToString(), after.GetProperty("key").GetString());
        // The physical episode's own page names nothing to move to.
        Assert.False(Items(await Item(rig, rig.Member, arrived))[0].TryGetProperty("openItemId", out _));
    }

    [Fact]
    public async Task AMissingEpisodesNewFileTheViewerMayNotOpenIsNotNamed()
    {
        using var rig = new Rig();
        var arrived = Guid.NewGuid();
        var key = TitleKey.Parse("tv:tvdb:78874:s1:e3")!;
        rig.View.AddItem(new JfItemRef { ItemId = arrived, Kind = "episode", Key = key, SeriesId = rig.Firefly, Season = 1, Episode = 3 }, rig.Admin.UserId);
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = arrived, Season = 1, Episode = 3 }, rig.Admin.UserId);
        rig.View.Rev++;
        var member = Items(await Item(rig, rig.Member, rig.Episode3))[0];
        Assert.NotEqual("ready", member.GetProperty("stage").GetString());
        Assert.False(member.TryGetProperty("openItemId", out _));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key.ToString())));
        Assert.Equal(arrived.ToString("N"), Items(await Item(rig, rig.Admin, rig.Episode3))[0].GetProperty("openItemId").GetString());
    }

    [Fact]
    public async Task TheArrivalRouteNamesTheItemAViewerCanOpenForAPagesScope()
    {
        using var rig = new Rig();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        // Movie and series: their copy. Season: its season item once Jellyfin lists it.
        Assert.Equal(rig.Sintel.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "movie:tmdb:45745")));
        Assert.Equal(rig.Firefly.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874")));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1")));
        rig.View.AddSeason(rig.Firefly, new JfSeason { ItemId = rig.Season1, Season = 1 });
        rig.View.Rev++;
        Assert.Equal(rig.Season1.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1")));

        // An episode: only one with a file. The virtual S1E3 is listed first and is no arrival.
        var key = "tv:tvdb:78874:s1:e3";
        Assert.Equal(rig.Episode1.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1:e1")));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key, rig.Episode3)));
        var arrived = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = arrived, Kind = "episode", Key = TitleKey.Parse(key), SeriesId = rig.Firefly, Season = 1, Episode = 3 });
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = arrived, Season = 1, Episode = 3 });
        rig.View.Rev++;
        Assert.Equal(arrived.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, rig.Episode3)));
        // Jellyfin deleted the virtual episode the page showed: the same answer by key alone.
        rig.View.Items.Remove(rig.Episode3);
        rig.View.EpisodesBySeries[rig.Firefly].RemoveAll(e => e.Episode.ItemId == rig.Episode3);
        rig.View.Rev++;
        Assert.Equal(arrived.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, rig.Episode3)));

        // A multi-episode file covers the episode asked for.
        var double45 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = double45, Kind = "episode", Key = TitleKey.Parse("tv:tvdb:78874:s1:e4"), SeriesId = rig.Firefly, Season = 1, Episode = 4, EpisodeEnd = 5 });
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = double45, Season = 1, Episode = 4, EpisodeEnd = 5 });
        rig.View.Rev++;
        Assert.Equal(double45.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1:e5")));

        // A movie in two libraries: the copy the page shows stays the one named while the viewer can open it.
        var other = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse("movie:tmdb:45745")!, new JfCopy { ItemId = other, Path = "/media/movies4k/Sintel (2010)/Sintel.mkv", LibraryName = "Movies 4K" });
        Assert.Equal(other.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "movie:tmdb:45745", other)));
        Assert.Equal(rig.Sintel.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "movie:tmdb:45745", Guid.NewGuid())));

        // Nothing the viewer can't open, and nothing about a title they can't see.
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, "movie:tmdb:693134")));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, "movie:tmdb:999")));

        // Validation, a person only, both switches.
        Assert.Equal(400, (await Arrival(rig, rig.Member, null)).Status);
        Assert.Equal(400, (await Arrival(rig, rig.Member, "nonsense")).Status);
        Assert.Equal(400, (await Call(rig, rig.Member, ctl => Task.FromResult(ctl.GetArrival("movie:tmdb:45745", "x")))).Status);
        Assert.Equal(400, (await Call(rig, rig.Member, ctl => Task.FromResult(ctl.GetArrival("tv:tvdb:78874:s1", null, "x")))).Status);
        Assert.Equal(403, (await Arrival(rig, null, "movie:tmdb:45745")).Status);
        c.ArrPhase1Enabled = false;
        Assert.Equal(403, (await Arrival(rig, rig.Member, "movie:tmdb:45745")).Status);
    }

    [Fact]
    public async Task TheArrivalAnswerIsNeverStored()
    {
        using var rig = new Rig();
        // It names what one person may open now: no browser or proxy keeps it.
        var reply = await Arrival(rig, rig.Member, "movie:tmdb:45745");
        Assert.Equal(200, reply.Status);
        Assert.Equal("private, no-store", reply.CacheControl);
        Assert.Equal("private, no-store", (await Arrival(rig, rig.Member, "tv:tvdb:78874:s1:e3", rig.Episode3)).CacheControl);
    }

    [Theory]
    [InlineData("/media/tv4k/Firefly", "TV 4K")]
    [InlineData("/media/tv2/Firefly", "TV 2")]
    public async Task AMissingEpisodesSuccessorIsFoundInTheSeriesCopyThePageShows(string path, string library)
    {
        // Firefly twice: the rig's copy in "TV" (listed first) and a second series item, the 4K copy or the
        // same series in another library. Each has its own missing S1E3.
        using var rig = new Rig();
        var fireflyKey = TitleKey.Parse("tv:tvdb:78874")!;
        var key = fireflyKey.WithEpisode(1, 3);
        var firefly2 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = firefly2, Kind = "series", Key = fireflyKey });
        rig.View.AddCopy(fireflyKey, new JfCopy { ItemId = firefly2, Path = path, LibraryName = library, LibraryId = library });
        var missing2 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = missing2, Kind = "episode", Key = key, SeriesId = firefly2, Season = 1, Episode = 3, Virtual = true });
        rig.View.AddEpisode(firefly2, new JfEpisode { ItemId = missing2, Season = 1, Episode = 3, Virtual = true });

        // The first copy's file arrives: only the first copy's missing episode moves to it.
        var file1 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = file1, Kind = "episode", Key = key, SeriesId = rig.Firefly, Season = 1, Episode = 3 });
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = file1, Season = 1, Episode = 3 });
        rig.View.Rev++;
        Assert.Equal(file1.ToString("N"), Items(await Item(rig, rig.Member, rig.Episode3))[0].GetProperty("openItemId").GetString());
        var stays = Items(await Item(rig, rig.Member, missing2))[0];
        Assert.False(stays.TryGetProperty("openItemId", out _), "the second copy's page never jumps to the first copy's file");
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key.ToString(), missing2)));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key.ToString(), null, firefly2)));

        // The second copy's own file arrives: its page moves there, also by key once Jellyfin deleted
        // the missing episode (the page names the series it showed).
        var file2 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = file2, Kind = "episode", Key = key, SeriesId = firefly2, Season = 1, Episode = 3 });
        rig.View.AddEpisode(firefly2, new JfEpisode { ItemId = file2, Season = 1, Episode = 3 });
        rig.View.Rev++;
        Assert.Equal(file2.ToString("N"), Items(await Item(rig, rig.Member, missing2))[0].GetProperty("openItemId").GetString());
        Assert.Equal(file2.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), missing2)));
        rig.View.Items.Remove(missing2);
        rig.View.EpisodesBySeries[firefly2].RemoveAll(e => e.Episode.ItemId == missing2);
        rig.View.Rev++;
        Assert.Equal(file2.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), missing2, firefly2)));
        Assert.Equal(file1.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), rig.Episode3, rig.Firefly)));
        // A page that named no series (an older page): the first copy, as before.
        Assert.Equal(file1.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), missing2)));

        // Season and series pages keep their copy too.
        var season2 = Guid.NewGuid();
        rig.View.AddSeason(rig.Firefly, new JfSeason { ItemId = rig.Season1, Season = 1 });
        rig.View.AddSeason(firefly2, new JfSeason { ItemId = season2, Season = 1 });
        rig.View.AddItem(new JfItemRef { ItemId = season2, Kind = "season", Key = fireflyKey.WithSeason(1), SeriesId = firefly2, Season = 1 });
        rig.View.Rev++;
        Assert.Equal(season2.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1", null, firefly2)));
        Assert.Equal(rig.Season1.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1", null, rig.Firefly)));
        Assert.Equal(firefly2.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874", firefly2)));
        Assert.Equal(firefly2.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874", null, firefly2)));

        // A copy the viewer can't open is never named, and never swapped for another copy.
        var adminCopy = Guid.NewGuid();
        var file3 = Guid.NewGuid();
        rig.View.AddCopy(fireflyKey, new JfCopy { ItemId = adminCopy, Path = "/media/private/Firefly", LibraryName = "Private" }, rig.Admin.UserId);
        rig.View.AddEpisode(adminCopy, new JfEpisode { ItemId = file3, Season = 1, Episode = 3 }, rig.Admin.UserId);
        rig.View.AddItem(new JfItemRef { ItemId = file3, Kind = "episode", Key = key, SeriesId = adminCopy, Season = 1, Episode = 3 }, rig.Admin.UserId);
        rig.View.Rev++;
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key.ToString(), null, adminCopy)));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874", null, adminCopy)));
        Assert.Equal(file3.ToString("N"), ArrivedId(await Arrival(rig, rig.Admin, key.ToString(), null, adminCopy)));
        // A series id of another title is no copy of this one.
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key.ToString(), null, rig.Sintel)));
    }
    /// <summary>
    /// Firefly as two series items in one library with automatic series grouping on: the rig's copy and a
    /// "4K" folder of the same series, sharing Jellyfin's presentation key. Jellyfin's own season and episode
    /// lists of either hold both folders' children (the other copy's first). Each copy has its own missing S1E3.
    /// </summary>
    private static (Guid Series, Guid Missing) GroupedFirefly(Rig rig)
    {
        var fireflyKey = TitleKey.Parse("tv:tvdb:78874")!;
        var copy = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = copy, Kind = "series", Key = fireflyKey });
        rig.View.AddCopy(fireflyKey, new JfCopy { ItemId = copy, Path = "/media/tv/Firefly 4K", LibraryName = "TV", LibraryId = "TV" });
        var missing = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = missing, Kind = "episode", Key = fireflyKey.WithEpisode(1, 3), SeriesId = copy, Season = 1, Episode = 3, Virtual = true });
        rig.View.AddEpisode(copy, new JfEpisode { ItemId = missing, Season = 1, Episode = 3, Virtual = true });
        rig.View.GroupSeries(rig.Firefly, copy);
        rig.View.Rev++;
        return (copy, missing);
    }

    private static Guid AddEpisodeFile(Rig rig, Guid series, int season, int episode)
    {
        var id = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = id, Kind = "episode", Key = TitleKey.Parse("tv:tvdb:78874")!.WithEpisode(season, episode), SeriesId = series, Season = season, Episode = episode, Path = $"/media/{series:N}/S{season:00}E{episode:00}.mkv" });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = id, Season = season, Episode = episode });
        rig.View.Rev++;
        return id;
    }

    [Fact]
    public async Task UnderSeriesGroupingAMissingEpisodeNeverMovesToTheOtherFoldersFile()
    {
        // Only the other copy (the 4K folder) gets S1E3; Jellyfin's grouped lists of the rig's copy hold it.
        using var rig = new Rig();
        var (copy, missing) = GroupedFirefly(rig);
        var key = "tv:tvdb:78874:s1:e3";
        var other = AddEpisodeFile(rig, copy, 1, 3);

        var page = Items(await Item(rig, rig.Member, rig.Episode3))[0];
        Assert.False(page.TryGetProperty("openItemId", out _), "the rig copy's missing S1E3 stays: the file is the 4K folder's");
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key, rig.Episode3)));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, key, null, rig.Firefly)));
        // The other copy's own page does move to its file.
        Assert.Equal(other.ToString("N"), Items(await Item(rig, rig.Member, missing))[0].GetProperty("openItemId").GetString());
        Assert.Equal(other.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, null, copy)));

        // A season only the other folder has: never the rig copy's successor.
        var season2 = Guid.NewGuid();
        rig.View.AddSeason(copy, new JfSeason { ItemId = season2, Season = 2 });
        rig.View.AddItem(new JfItemRef { ItemId = season2, Kind = "season", Key = TitleKey.Parse("tv:tvdb:78874:s2"), SeriesId = copy, Season = 2 });
        rig.View.Rev++;
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s2", null, rig.Firefly)));
        Assert.Equal(season2.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s2", null, copy)));
    }

    [Fact]
    public async Task UnderSeriesGroupingEachFoldersMissingEpisodeMovesToItsOwnFile()
    {
        // Both copies get S1E3, the 4K folder's first; Jellyfin lists the 4K one first for either copy.
        using var rig = new Rig();
        var (copy, missing) = GroupedFirefly(rig);
        var key = "tv:tvdb:78874:s1:e3";
        var other = AddEpisodeFile(rig, copy, 1, 3);
        var own = AddEpisodeFile(rig, rig.Firefly, 1, 3);

        Assert.Equal(own.ToString("N"), Items(await Item(rig, rig.Member, rig.Episode3))[0].GetProperty("openItemId").GetString());
        Assert.Equal(other.ToString("N"), Items(await Item(rig, rig.Member, missing))[0].GetProperty("openItemId").GetString());
        Assert.Equal(own.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, rig.Episode3)));
        Assert.Equal(other.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, missing)));
        // Jellyfin deleted both missing episodes: by series alone, each copy keeps its own.
        rig.View.Items.Remove(rig.Episode3);
        rig.View.Items.Remove(missing);
        rig.View.Rev++;
        Assert.Equal(own.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, rig.Episode3, rig.Firefly)));
        Assert.Equal(other.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key, missing, copy)));
        // Season pages too.
        var season1b = Guid.NewGuid();
        rig.View.AddSeason(copy, new JfSeason { ItemId = season1b, Season = 1 });
        rig.View.AddItem(new JfItemRef { ItemId = season1b, Kind = "season", Key = TitleKey.Parse("tv:tvdb:78874:s1"), SeriesId = copy, Season = 1 });
        rig.View.AddSeason(rig.Firefly, new JfSeason { ItemId = rig.Season1, Season = 1 });
        rig.View.Rev++;
        Assert.Equal(rig.Season1.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1", null, rig.Firefly)));
        Assert.Equal(season1b.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1", null, copy)));
    }

    [Fact]
    public async Task AnEpisodeListedUnderASeriesThatBelongsToAnotherSeriesItemIsNeverItsSuccessor()
    {
        // Jellyfin lists an episode under the rig's copy whose own series is another item (an episode outside
        // a season folder can carry another grouped copy's season): its SeriesId says whose it is.
        using var rig = new Rig();
        var (copy, _) = GroupedFirefly(rig);
        var stray = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = stray, Kind = "episode", Key = TitleKey.Parse("tv:tvdb:78874:s1:e3"), SeriesId = copy, Season = 1, Episode = 3, Path = "/media/tv/Firefly 4K/x.mkv" });
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = stray, Season = 1, Episode = 3 });
        rig.View.Rev++;
        Assert.False(Items(await Item(rig, rig.Member, rig.Episode3))[0].TryGetProperty("openItemId", out _));
        Assert.Null(ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1:e3", rig.Episode3)));
    }
    [Fact]
    public async Task AMovieOrEpisodeStatusSaysHowManyVersionsJellyfinPlaysItFrom()
    {
        using var rig = new Rig();
        var sintel = rig.View.Items[rig.Sintel].Ref;
        rig.View.AddItem(new JfItemRef { ItemId = rig.Sintel, Kind = "movie", Key = sintel.Key, Path = sintel.Path, DateCreated = sintel.DateCreated, Versions = 1 });
        rig.View.Rev++;
        Assert.Equal(1, Items(await Item(rig, rig.Member, rig.Sintel))[0].GetProperty("versions").GetInt32());
        // Jellyfin adds a second file of the movie to the same item (its version picker).
        rig.View.AddItem(new JfItemRef { ItemId = rig.Sintel, Kind = "movie", Key = sintel.Key, Path = sintel.Path, DateCreated = sintel.DateCreated, Versions = 2 });
        rig.View.Rev++;
        Assert.Equal(2, Items(await Item(rig, rig.Member, rig.Sintel))[0].GetProperty("versions").GetInt32());
        // An episode too; never a season or series, a missing episode, or an item Jellyfin gave no count.
        var e1 = rig.View.Items[rig.Episode1].Ref;
        rig.View.AddItem(new JfItemRef { ItemId = rig.Episode1, Kind = "episode", Key = e1.Key, SeriesId = e1.SeriesId, Season = 1, Episode = 1, Versions = 3 });
        rig.View.Rev++;
        Assert.Equal(3, Items(await Item(rig, rig.Admin, rig.Episode1))[0].GetProperty("versions").GetInt32());
        Assert.False(Items(await Item(rig, rig.Member, rig.Firefly))[0].TryGetProperty("versions", out _));
        Assert.False(Items(await Item(rig, rig.Member, rig.Episode3))[0].TryGetProperty("versions", out _));
        rig.View.AddItem(new JfItemRef { ItemId = rig.Sintel, Kind = "movie", Key = sintel.Key, Path = sintel.Path, DateCreated = sintel.DateCreated });
        rig.View.Rev++;
        Assert.False(Items(await Item(rig, rig.Member, rig.Sintel))[0].TryGetProperty("versions", out _));
    }

    [Fact]
    public async Task AMovieWhoseFileJellyfinNowKeepsAsAVersionOfANewItemNamesThatItem()
    {
        // Jellyfin 12: a 2160p file lands next to the 1080p one; the 2160p file becomes the movie item (a new id)
        // and the 1080p item stays as its version (owned by it; Jellyfin's lists no longer show it).
        using var rig = new Rig();
        var key = TitleKey.Parse("movie:tmdb:45745")!;
        var uhd = Guid.NewGuid();
        var old = rig.View.Items[rig.Sintel].Ref;
        rig.View.AddItem(new JfItemRef { ItemId = uhd, Kind = "movie", Key = key, Path = "/media/movies/Sintel (2010)/Sintel (2010) - 2160p.mkv", Versions = 2 });
        rig.View.AddItem(new JfItemRef { ItemId = rig.Sintel, Kind = "movie", Key = key, Path = old.Path, Versions = 2, PrimaryId = uhd });
        rig.View.CopiesByKey[key.ToString()].Clear();
        rig.View.AddCopy(key, new JfCopy { ItemId = uhd, Path = "/media/movies/Sintel (2010)/Sintel (2010) - 2160p.mkv", LibraryName = "Movies" });
        rig.View.Rev++;

        var page = Items(await Item(rig, rig.Member, rig.Sintel))[0];
        Assert.Equal(uhd.ToString("N"), page.GetProperty("openItemId").GetString());
        Assert.Equal("ready", page.GetProperty("stage").GetString());
        Assert.Equal(2, page.GetProperty("versions").GetInt32());
        Assert.Equal(uhd.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), rig.Sintel)));
        // The new item's own page names nothing to move to.
        Assert.False(Items(await Item(rig, rig.Member, uhd))[0].TryGetProperty("openItemId", out _));

        // An episode the same way (Jellyfin 12 groups an episode's files in its season folder): the page moves to
        // the episode item of the same series that keeps its file now.
        var e1 = rig.View.Items[rig.Episode1].Ref;
        var e1uhd = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = e1uhd, Kind = "episode", Key = e1.Key, SeriesId = rig.Firefly, Season = 1, Episode = 1, Versions = 2, Path = "/media/tv/Firefly/S01E01 - 2160p.mkv" });
        rig.View.AddItem(new JfItemRef { ItemId = rig.Episode1, Kind = "episode", Key = e1.Key, SeriesId = rig.Firefly, Season = 1, Episode = 1, Versions = 2, PrimaryId = e1uhd });
        rig.View.EpisodesBySeries[rig.Firefly].RemoveAll(x => x.Episode.ItemId == rig.Episode1);
        rig.View.AddEpisode(rig.Firefly, new JfEpisode { ItemId = e1uhd, Season = 1, Episode = 1 });
        rig.View.Rev++;
        Assert.Equal(e1uhd.ToString("N"), Items(await Item(rig, rig.Member, rig.Episode1))[0].GetProperty("openItemId").GetString());
        Assert.Equal(e1uhd.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, "tv:tvdb:78874:s1:e1", rig.Episode1)));

        // A viewer who can't open the new item is never sent there.
        var hidden = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = hidden, Kind = "movie", Key = key, Versions = 2 }, rig.Admin.UserId);
        rig.View.AddItem(new JfItemRef { ItemId = rig.Sintel, Kind = "movie", Key = key, Path = old.Path, Versions = 2, PrimaryId = hidden });
        rig.View.Rev++;
        Assert.False(Items(await Item(rig, rig.Member, rig.Sintel))[0].TryGetProperty("openItemId", out _));
    }

    [Fact]
    public async Task AMovieItemJellyfinDeletedWhenItsFileBecameAVersionIsFollowedToTheItemThatKeepsItNotAnotherCopy()
    {
        // Jellyfin 10.11 deletes the 1080p movie item once a 2160p file joins it (the new item keeps it as a version
        // under another id). The same movie is also in a "Movies 4K" library, listed first.
        using var rig = new Rig();
        var key = TitleKey.Parse("movie:tmdb:45745")!;
        var copy4k = Guid.NewGuid();
        var uhd = Guid.NewGuid();
        rig.View.CopiesByKey[key.ToString()].Clear();
        rig.View.AddItem(new JfItemRef { ItemId = copy4k, Kind = "movie", Key = key, Versions = 1 });
        rig.View.AddCopy(key, new JfCopy { ItemId = copy4k, Path = "/media/movies4k/Sintel (2010)/Sintel (2010) - 2160p.mkv", LibraryName = "Movies 4K" });
        rig.View.AddItem(new JfItemRef { ItemId = uhd, Kind = "movie", Key = key, Versions = 2 });
        rig.View.AddCopy(key, new JfCopy { ItemId = uhd, Path = "/media/movies/Sintel (2010)/Sintel (2010) - 2160p.mkv", LibraryName = "Movies" });
        rig.View.Items.Remove(rig.Sintel);
        rig.View.FormerItemsOf[uhd] = new HashSet<Guid> { rig.Sintel };
        rig.View.Rev++;
        Assert.Equal(uhd.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), rig.Sintel)));
        // With nothing keeping it, the first copy as before.
        Assert.Equal(copy4k.ToString("N"), ArrivedId(await Arrival(rig, rig.Member, key.ToString(), Guid.NewGuid())));
    }
}
