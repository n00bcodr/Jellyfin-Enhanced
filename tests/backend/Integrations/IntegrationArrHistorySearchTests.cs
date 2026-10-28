using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Searching the administrator's Activity history (Requests &amp; downloads): words, an event kind,
/// one instance and a page over every record the server holds (not only the newest 100), at most
/// 50 rows a page, with the counts, each instance's coverage ("the newest N of M since …") and the
/// filters echoed; the arr's message on history rows and in the Manage drawer's timeline; the
/// unfiltered answer unchanged; administrators only.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrHistorySearchTests
{
    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Sonarr { get; }
        public FakeSeerr Seerr { get; } = new();
        public ArrStateStore Store { get; }
        public FakeJellyfinView View { get; } = new();
        public SeerrFacts Requests { get; }
        public ArrStatusService Status { get; }
        public ArrManageService Manage { get; }
        public ArrActionRunner Runner { get; }
        public JellyfinBridge Bridge { get; }
        public ArrAdminHubService Admin { get; }
        public ArrQueueActionService Queue { get; }
        public ArrChangeFeed Feed { get; } = new();
        public StatusViewer AdminUser { get; }
        public StatusViewer Member { get; }

        public Rig(int radarrRows = 150, int sonarrRows = 20)
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("Shows", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            var c = Arr.Plugin.Plugin.Configuration;
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrPhase2Enabled = true;
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;

            Radarr.Movies.Add(FakeArr.Movie(1, 438631, "Dune", hasFile: false));
            var start = Arr.Now.UtcDateTime;
            // Radarr: newest first every minute; every third a grab, every fifth an import, every
            // seventh a failure with a message (the rest are grabs too).
            for (var i = 1; i <= radarrRows; i++)
            {
                var kind = i % 7 == 0 ? "downloadFailed" : i % 5 == 0 ? "downloadFolderImported" : "grabbed";
                var row = FakeArr.HistoryRow(i, kind, start.AddMinutes(-i), title: "Movie " + i.ToString("000", System.Globalization.CultureInfo.InvariantCulture));
                row["sourceTitle"] = "Movie." + i + ".2010.1080p.WEB-DL-GROUP";
                if (kind == "downloadFailed") row["data"] = new JsonObject { ["message"] = "Download client says: unpack error " + i };
                Radarr.History.Add(row);
            }
            // Sonarr: imports of one show, half a minute after each Radarr minute.
            for (var i = 1; i <= sonarrRows; i++)
            {
                var row = FakeArr.HistoryRow(10_000 + i, "episodeFileImported", start.AddMinutes(-i).AddSeconds(-30), title: "Peacemaker", season: 2, episode: i);
                Sonarr.History.Add(row);
            }

            Store = Arr.Store();
            Requests = new SeerrFacts(Seerr.Transport, Feed, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Status = new ArrStatusService(Store, View, Requests, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, Feed);
            var audit = new ArrAuditLog(Path.Combine(Arr.Plugin.Core.Root, ArrAuditLog.FileName), 1024 * 1024, 2);
            Runner = new ArrActionRunner(audit, new ArrConfirmationTokens());
            Manage = new ArrManageService(Status, Arr.Factory, Runner, audit, Requests, null, Feed, () => Arr.Plugin.Plugin.Configuration, (_, _) => Task.CompletedTask);
            Bridge = new JellyfinBridge(Store, new FakeLibraryAccess(), null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, null);
            Admin = new ArrAdminHubService(Store, Bridge, Requests, null, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Queue = new ArrQueueActionService(Store, Arr.Factory, Runner, audit, Feed);
            AdminUser = View.AddUser(admin: true);
            Member = View.AddUser(admin: false);
        }

        public string Id(string name) => Arr.Instance(name).Id;

        public ArrAdminHubController Controller(StatusViewer? viewer, bool apiKey = false)
        {
            var controller = new ArrAdminHubController(Admin, Queue, Bridge, Runner, Status, Manage) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            var claims = new List<Claim>();
            if (viewer != null) claims.Add(new Claim("Jellyfin-UserId", viewer.UserId.ToString()));
            if (viewer?.IsAdmin == true || apiKey) claims.Add(new Claim(ClaimTypes.Role, "Administrator"));
            if (apiKey) claims.Add(new Claim("Jellyfin-IsApiKey", "true"));
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
            return controller;
        }

        public async Task Warm()
        {
            foreach (var name in new[] { "Movies", "Shows" })
            {
                var c = Arr.Instance(name);
                await Store.GetLibraryAsync(c, default);
                await Store.GetQueueAsync(c, default);
                await Store.GetSystemAsync(c, default);
                await Store.GetHistoryAsync(c, default);
            }
        }

        public async Task<(int Status, JsonElement Body)> Activity(string? q = null, string? kind = null, string? instance = null, int? page = null, StatusViewer? viewer = null)
        {
            var result = await Controller(viewer ?? AdminUser).GetActivity(q, kind, instance, page, default);
            return result switch
            {
                FileContentResult file => (200, JsonDocument.Parse(Encoding.UTF8.GetString(file.FileContents)).RootElement.Clone()),
                ObjectResult obj => (obj.StatusCode ?? 200, JsonDocument.Parse(JsonSerializer.Serialize(obj.Value)).RootElement.Clone()),
                ForbidResult => (403, default),
                _ => throw new InvalidOperationException(result.GetType().Name),
            };
        }

        public void Dispose()
        {
            Bridge.Dispose();
            Requests.Dispose();
            Seerr.Dispose();
            Arr.Dispose();
        }
    }

    private static List<string> Titles(JsonElement body) => body.GetProperty("history").EnumerateArray().Select(h => h.GetProperty("title").GetString()!).ToList();

    private static List<DateTime> Dates(JsonElement body) => body.GetProperty("history").EnumerateArray().Select(h => h.GetProperty("date").GetDateTime()).ToList();

    [Fact]
    public async Task WithNoQueryTheAnswerIsTodaysNewest100WithTheArrsMessageAndNoSearchBlock()
    {
        using var rig = new Rig();
        await rig.Warm();
        var (status, body) = await rig.Activity();
        Assert.Equal(200, status);
        Assert.False(body.TryGetProperty("historyPage", out _));
        var rows = body.GetProperty("history").EnumerateArray().ToList();
        Assert.Equal(100, rows.Count);
        Assert.Equal("Movie 001", rows[0].GetProperty("title").GetString());
        Assert.Equal(Dates(body).OrderByDescending(d => d), Dates(body));
        // Movie 007 failed: its row carries the arr's message; a grab carries none.
        var failed = rows.Single(r => r.GetProperty("title").GetString() == "Movie 007");
        Assert.Equal("Download client says: unpack error 7", failed.GetProperty("message").GetString());
        Assert.False(rows.Single(r => r.GetProperty("title").GetString() == "Movie 001").TryGetProperty("message", out _));
        // The newest 100 of both instances together: Movie 140 is too old to be among them.
        Assert.DoesNotContain("Movie 140", Titles(body));
    }

    [Fact]
    public async Task WordsAreLookedForInEveryRecordHeldCaseInsensitivelyInTitleReleaseAndMessage()
    {
        using var rig = new Rig();
        await rig.Warm();
        // A title older than the newest 100.
        var (_, body) = await rig.Activity(q: "movie 140");
        Assert.Equal(new[] { "Movie 140" }, Titles(body));
        var page = body.GetProperty("historyPage");
        Assert.Equal(("movie 140", 1, 1, 1), (page.GetProperty("q").GetString(), page.GetProperty("page").GetInt32(), page.GetProperty("pages").GetInt32(), page.GetProperty("total").GetInt32()));
        // The release name.
        (_, body) = await rig.Activity(q: "MOVIE.133.2010");
        Assert.Equal(new[] { "Movie 133" }, Titles(body));
        // The message (only failures carry one).
        (_, body) = await rig.Activity(q: "Unpack Error 14");
        Assert.Equal(new[] { "Movie 014", "Movie 140", "Movie 147" }, Titles(body).OrderBy(x => x, StringComparer.Ordinal));
        // Surrounding spaces are trimmed; text only of spaces filters nothing (and still pages).
        (_, body) = await rig.Activity(q: "   ");
        Assert.Equal(170, body.GetProperty("historyPage").GetProperty("total").GetInt32());
        Assert.False(body.GetProperty("historyPage").TryGetProperty("q", out _));
        (_, body) = await rig.Activity(q: "  Peacemaker ");
        Assert.Equal(20, body.GetProperty("historyPage").GetProperty("total").GetInt32());
        Assert.Equal("Peacemaker", body.GetProperty("historyPage").GetProperty("q").GetString());
        // Nothing matching: an empty page, not an error.
        (_, body) = await rig.Activity(q: "no such title");
        Assert.Empty(Titles(body));
        Assert.Equal((0, 1, 1), (body.GetProperty("historyPage").GetProperty("total").GetInt32(), body.GetProperty("historyPage").GetProperty("page").GetInt32(), body.GetProperty("historyPage").GetProperty("pages").GetInt32()));
    }

    [Fact]
    public async Task EventKindsFilterByFamilyAndAnUnknownKindIsRefused()
    {
        using var rig = new Rig();
        await rig.Warm();
        var (_, body) = await rig.Activity(kind: "failed", page: 1);
        Assert.Equal(150 / 7, body.GetProperty("historyPage").GetProperty("total").GetInt32());
        Assert.All(body.GetProperty("history").EnumerateArray(), h => Assert.Equal("downloadFailed", h.GetProperty("event").GetString()));
        Assert.Equal("failed", body.GetProperty("historyPage").GetProperty("event").GetString());
        // "imported" is every "…Imported" event of both kinds of arr.
        (_, body) = await rig.Activity(kind: "Imported");
        var events = body.GetProperty("history").EnumerateArray().Select(h => h.GetProperty("event").GetString()).Distinct().OrderBy(x => x).ToArray();
        Assert.Equal(new[] { "downloadFolderImported", "episodeFileImported" }, events);
        Assert.Equal(20 + 150 / 5 - 150 / 35, body.GetProperty("historyPage").GetProperty("total").GetInt32());
        // Words and a kind together.
        (_, body) = await rig.Activity(q: "peacemaker", kind: "grabbed");
        Assert.Equal(0, body.GetProperty("historyPage").GetProperty("total").GetInt32());
        Assert.Equal(400, (await rig.Activity(kind: "exploded")).Status);
        Assert.Equal("invalid_request", (await rig.Activity(kind: "exploded")).Body.GetProperty("code").GetString());
        Assert.Equal(new[] { "grabbed", "imported", "failed", "deleted", "renamed", "ignored", "other" }, AdminHistoryQuery.EventKinds);
        Assert.Equal("deleted", ArrAdminHubService.EventKind("episodeFileDeleted"));
        Assert.Equal("renamed", ArrAdminHubService.EventKind("movieFileRenamed"));
        Assert.Equal("ignored", ArrAdminHubService.EventKind("downloadIgnored"));
        Assert.Equal("other", ArrAdminHubService.EventKind("seriesFolderMoved"));
        Assert.Equal("other", ArrAdminHubService.EventKind(null));
    }

    [Fact]
    public async Task AnInstanceFilterIsCheckedAgainstTheRegistryAndNarrowsRowsAndCoverage()
    {
        using var rig = new Rig();
        await rig.Warm();
        var shows = rig.Id("Shows");
        var (status, body) = await rig.Activity(instance: shows.ToUpperInvariant());
        Assert.Equal(200, status);
        Assert.All(body.GetProperty("history").EnumerateArray(), h => Assert.Equal(shows, h.GetProperty("instanceId").GetString()));
        Assert.Equal(20, body.GetProperty("historyPage").GetProperty("total").GetInt32());
        // The registry's id is echoed, and only that instance's coverage is given.
        Assert.Equal(shows, body.GetProperty("historyPage").GetProperty("instance").GetString());
        Assert.Equal(new[] { shows }, body.GetProperty("historyPage").GetProperty("coverage").EnumerateArray().Select(c => c.GetProperty("instanceId").GetString()));
        // The queue and the instance cards are still every instance's.
        Assert.Equal(2, body.GetProperty("instances").GetArrayLength());

        foreach (var bad in new[] { "nope", new string('a', 65) })
        {
            var refused = await rig.Activity(instance: bad);
            Assert.Equal(400, refused.Status);
            Assert.Equal("unknown_instance", refused.Body.GetProperty("code").GetString());
        }
        // A disabled instance is not searchable.
        var config = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(config.SonarrInstances)!.AsArray();
        foreach (var row in rows)
        {
            var key = row!.AsObject().Select(p => p.Key).Single(k => string.Equals(k, "Enabled", StringComparison.OrdinalIgnoreCase));
            row[key] = false;
        }
        config.SonarrInstances = rows.ToJsonString();
        Assert.False(rig.Arr.Registry.Get(shows)!.Usable);
        Assert.Equal(400, (await rig.Activity(instance: shows)).Status);
    }

    [Fact]
    public async Task PagesHoldFiftyRowsNewestFirstWithoutOverlapAndAPageTooFarShowsTheLast()
    {
        using var rig = new Rig();
        await rig.Warm();
        var seen = new List<string>();
        for (var p = 1; p <= 4; p++)
        {
            var (_, body) = await rig.Activity(page: p);
            var page = body.GetProperty("historyPage");
            Assert.Equal((p, 4, 170, AdminHistoryQuery.PageSize), (page.GetProperty("page").GetInt32(), page.GetProperty("pages").GetInt32(), page.GetProperty("total").GetInt32(), page.GetProperty("pageSize").GetInt32()));
            Assert.Equal(p < 4 ? 50 : 20, body.GetProperty("history").GetArrayLength());
            Assert.Equal(Dates(body).OrderByDescending(d => d), Dates(body));
            seen.AddRange(body.GetProperty("history").EnumerateArray().Select(h => h.GetProperty("instanceId").GetString() + h.GetProperty("date").GetDateTime().Ticks));
        }
        Assert.Equal(170, seen.Distinct().Count());
        // Interleaved across instances: Movie 001 (−1 min), then Peacemaker E1 (−1.5 min).
        var first = (await rig.Activity(page: 1)).Body;
        Assert.Equal(new[] { "Movie 001", "Peacemaker", "Movie 002" }, Titles(first).Take(3));

        var far = (await rig.Activity(page: 99)).Body;
        Assert.Equal(4, far.GetProperty("historyPage").GetProperty("page").GetInt32());
        Assert.Equal(20, far.GetProperty("history").GetArrayLength());
        var huge = (await rig.Activity(page: int.MaxValue)).Body;
        Assert.Equal(4, huge.GetProperty("historyPage").GetProperty("page").GetInt32());
        foreach (var bad in new[] { 0, -3 })
        {
            var refused = await rig.Activity(page: bad);
            Assert.Equal((400, "invalid_request"), (refused.Status, refused.Body.GetProperty("code").GetString()));
        }
    }

    [Fact]
    public async Task TextOverOneHundredCharactersIsRefused()
    {
        using var rig = new Rig();
        await rig.Warm();
        Assert.Equal(200, (await rig.Activity(q: new string('x', AdminHistoryQuery.MaxQueryLength))).Status);
        var refused = await rig.Activity(q: new string('x', AdminHistoryQuery.MaxQueryLength + 1));
        Assert.Equal((400, "invalid_request"), (refused.Status, refused.Body.GetProperty("code").GetString()));
    }

    [Fact]
    public async Task CoverageSaysWhatEachRingHoldsOfTheArrsWholeHistory()
    {
        using var rig = new Rig();
        // Radarr reports 5,000 records; the full read takes the newest 150 the fake holds.
        rig.Radarr.ReportedTotal = (path, count) => path.EndsWith("/history", StringComparison.Ordinal) ? 5000 : count;
        await rig.Warm();
        var (_, body) = await rig.Activity(page: 1);
        var coverage = body.GetProperty("historyPage").GetProperty("coverage").EnumerateArray().ToDictionary(c => c.GetProperty("instance").GetString()!);
        Assert.Equal(2, coverage.Count);
        var movies = coverage["Movies"];
        Assert.Equal((150, 5000, false, false), (movies.GetProperty("held").GetInt32(), movies.GetProperty("total").GetInt32(), movies.GetProperty("complete").GetBoolean(), movies.GetProperty("unread").GetBoolean()));
        Assert.Equal(rig.Arr.Now.UtcDateTime.AddMinutes(-150), movies.GetProperty("since").GetDateTime().ToUniversalTime());
        var shows = coverage["Shows"];
        Assert.Equal((20, 20, true), (shows.GetProperty("held").GetInt32(), shows.GetProperty("total").GetInt32(), shows.GetProperty("complete").GetBoolean()));
        Assert.Equal(rig.Arr.Now.UtcDateTime.AddMinutes(-20).AddSeconds(-30), shows.GetProperty("since").GetDateTime().ToUniversalTime());
    }

    [Fact]
    public async Task AnInstanceWhoseHistoryWasNeverReadIsCoveredAsUnread()
    {
        using var rig = new Rig();
        rig.Sonarr.FailWith = 500;
        await rig.Warm();
        var (status, body) = await rig.Activity(page: 1);
        Assert.Equal(200, status);
        var shows = body.GetProperty("historyPage").GetProperty("coverage").EnumerateArray().Single(c => c.GetProperty("instance").GetString() == "Shows");
        Assert.Equal((0, true, false), (shows.GetProperty("held").GetInt32(), shows.GetProperty("unread").GetBoolean(), shows.GetProperty("complete").GetBoolean()));
        Assert.False(shows.TryGetProperty("since", out _));
        Assert.Equal(150, body.GetProperty("historyPage").GetProperty("total").GetInt32());
    }

    [Fact]
    public void TheArrsTotalFollowsFullReadsAndGrowsByTheRecordsNewToTheRing()
    {
        var t0 = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
        ArrHistoryEntry E(int id) => new() { Id = id, EventType = "grabbed", Date = t0.AddMinutes(id) };
        var full = ArrStateLoaders.BuildHistory(new[] { E(1), E(2), E(3) }, null, DateTimeOffset.UnixEpoch, arrTotal: 900);
        Assert.Equal(900, full.ArrTotal);
        // An incremental read: one record already held, two new ones.
        var next = ArrStateLoaders.BuildHistory(new[] { E(3), E(4), E(5) }, full, full.FullReadAt);
        Assert.Equal(902, next.ArrTotal);
        // Never fewer than the ring holds (the arr reported fewer than it gave).
        Assert.Equal(3, ArrStateLoaders.BuildHistory(new[] { E(1), E(2), E(3) }, null, DateTimeOffset.UnixEpoch, arrTotal: 1).ArrTotal);
        // Unknown until a full read reports it.
        Assert.Null(ArrStateLoaders.BuildHistory(new[] { E(1) }, null, DateTimeOffset.UnixEpoch).ArrTotal);
        Assert.Null(ArrStateLoaders.BuildHistory(new[] { E(2) }, ArrStateLoaders.BuildHistory(new[] { E(1) }, null, DateTimeOffset.UnixEpoch), DateTimeOffset.UnixEpoch).ArrTotal);
    }

    [Fact]
    public async Task TheSearchIsForAdministratorsOnlyAndOffWithPhaseTwo()
    {
        using var rig = new Rig();
        await rig.Warm();
        Assert.Equal(403, (await rig.Activity(q: "movie", viewer: rig.Member)).Status);
        var anonymous = await rig.Controller(null).GetActivity("movie", null, null, 1, default);
        Assert.IsType<ForbidResult>(anonymous);
        var apiKey = await rig.Controller(null, apiKey: true).GetActivity("movie", null, null, 1, default);
        Assert.IsType<ForbidResult>(apiKey);
        // Refused before any input is looked at.
        Assert.Equal(403, (await rig.Activity(kind: "exploded", viewer: rig.Member)).Status);
        Assert.True(typeof(ArrAdminHubController).IsDefined(typeof(PrivateResponseAttribute), inherit: true));
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = false;
        var off = await rig.Activity(q: "movie");
        Assert.Equal((403, "feature_disabled"), (off.Status, off.Body.GetProperty("code").GetString()));
    }

    [Fact]
    public async Task TheManageDrawersTimelineCarriesTheArrsMessage()
    {
        using var rig = new Rig(radarrRows: 0, sonarrRows: 0);
        var failed = FakeArr.HistoryRow(1, "downloadFailed", rig.Arr.Now.UtcDateTime.AddHours(-1), tmdb: 438631, title: "Dune");
        failed["movieId"] = 1;
        failed["data"] = new JsonObject { ["message"] = "Indexer returned an invalid file" };
        rig.Radarr.History.Add(failed);
        var grab = FakeArr.HistoryRow(2, "grabbed", rig.Arr.Now.UtcDateTime.AddHours(-2), tmdb: 438631, title: "Dune");
        grab["movieId"] = 1;
        rig.Radarr.History.Add(grab);
        await rig.Warm();
        var drawer = await rig.Manage.OverviewAsync(rig.AdminUser, TitleKey.Parse("movie:tmdb:438631")!, null, default);
        var timeline = drawer.Instances.Single(i => i.Name == "Movies").Timeline;
        Assert.Equal("Indexer returned an invalid file", timeline.Single(e => e.Event == "downloadFailed").Message);
        Assert.Null(timeline.Single(e => e.Event == "grabbed").Message);
    }
}
