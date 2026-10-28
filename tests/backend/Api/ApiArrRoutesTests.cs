using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// The existing Downloads, history and link routes on the arr state store: all queue rows, history
/// errors reported, links from the library index (no call per id), server-side feature gates,
/// non-admin error text without detail, and the admin-only state route.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrRoutesTests
{
    /// <summary>
    /// The change feed's audience as the routes see it: every key but the hidden ones (per instance,
    /// or everywhere) and the absent ones (shown only when the caller passes their movie / series key
    /// as asked for), with the questions it was asked.
    /// </summary>
    internal sealed class KeyAudience : IArrFeedAudience
    {
        public HashSet<string> Hidden { get; } = new(StringComparer.Ordinal);
        public HashSet<(string Key, string Instance)> HiddenIn { get; } = new();
        public Dictionary<string, string> Absent { get; } = new(StringComparer.Ordinal);   // key -> its movie / series key
        public List<(Guid User, bool Admin, ArrFeedChange Change)> Asked { get; } = new();
        public List<IReadOnlySet<string>?> AskedFor { get; } = new();

        public IReadOnlyCollection<string> Visible(Guid userId, bool isAdmin, IReadOnlyList<ArrFeedChange> changes, IReadOnlySet<string>? askedFor = null, ICollection<string>? absent = null)
        {
            lock (Asked)
            {
                Asked.AddRange(changes.Select(c => (userId, isAdmin, c)));
                AskedFor.Add(askedFor);
            }
            var shown = new List<string>();
            foreach (var c in changes)
            {
                if (!isAdmin && (Hidden.Contains(c.Key) || HiddenIn.Contains((c.Key, c.InstanceId ?? "")))) continue;
                if (!isAdmin && Absent.TryGetValue(c.Key, out var title) && askedFor?.Contains(title) != true)
                {
                    absent?.Add(c.Key);
                    continue;
                }
                shown.Add(c.Key);
            }
            return shown;
        }
    }

    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public KeyAudience Audience { get; } = new();
        public Guid Member { get; } = Guid.NewGuid();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Radarr4k { get; }
        public FakeArr.Host Sonarr { get; }
        public ArrStateStore Store { get; }

        public Rig()
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Radarr4k = Arr.Add("radarr4k.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Arr.Configure(
                ("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
                ("Movies 4K", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"),
                ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            var c = Arr.Plugin.Plugin.Configuration;
            c.DownloadsPageEnabled = true;
            c.CalendarPageEnabled = true;
            c.ArrLinksEnabled = true;
            c.DownloadsFilterByUserRequests = false;
            Store = Arr.Store();
        }

        public JellyfinEnhancedController Controller(bool admin, IArrFeedAudience? audience = null, object? first = null)
        {
            var services = new List<object>();
            if (first != null) services.Add(first);
            services.AddRange([Arr.Plugin.Core, Arr.Transport, Store, Arr.Factory, audience ?? Audience]);
            var c = ApiAssetTests.Controller(Arr.Plugin.Core, services.ToArray());
            c.HttpContext.User = TestCallers.Principal(admin ? Guid.NewGuid() : Member, admin);
            return c;
        }

        public void Dispose() => Arr.Dispose();
    }

    private static JsonElement Json(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value);

    [Fact]
    public async Task ExpiredQueueRowsAreHiddenWhileStaleRowsAndPastHistoryRemainWithErrors()
    {
        using var rig = new Rig();
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        rig.Radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1), "dl", 45745, "Sintel"));
        var controller = rig.Controller(admin: false);
        Assert.Single(Json(await controller.GetDownloadQueue()).GetProperty("items").EnumerateArray());
        Assert.Single(Json(await controller.GetDownloadHistory()).GetProperty("items").EnumerateArray());
        rig.Radarr.FailWith = 503;
        rig.Arr.Now += TimeSpan.FromMinutes(9);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("Movies").Id, ArrSnapshotKind.Queue, force: true);
        var stale = Json(await controller.GetDownloadQueue());
        Assert.Equal(50, Assert.Single(stale.GetProperty("items").EnumerateArray()).GetProperty("progress").GetDouble());
        Assert.Single(stale.GetProperty("errors").EnumerateArray());
        rig.Arr.Now += TimeSpan.FromMinutes(22);
        var expired = Json(await controller.GetDownloadQueue());
        Assert.Empty(expired.GetProperty("items").EnumerateArray());
        Assert.Single(expired.GetProperty("errors").EnumerateArray());
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("Movies").Id, ArrSnapshotKind.History, force: true);
        Assert.Single(Json(await controller.GetDownloadHistory()).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task TheHistoryRouteFiltersRequestsBeforeVisibleImportsFillItsWindow()
    {
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var config = rig.Arr.Plugin.Plugin.Configuration;
        config.DownloadsFilterByUserRequests = true;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = FakeSeerr.Url;
        config.JellyseerrApiKey = FakeSeerr.Key;
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetValue(null)!;
        cache[rig.Member.ToString()] = SeerrSeeds.Id(rig.Member.ToString(), "7");
        try
        {
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 45745, 2, rig.Member, DateTime.UtcNow.AddDays(-1)));
            for (var i = 1; i <= 299; i++) rig.Radarr.History.Add(FakeArr.HistoryRow(i, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddMinutes(-i), "dl" + i, 9000 + i, "Theirs"));
            rig.Radarr.History.Add(FakeArr.HistoryRow(300, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddDays(-1), "mine", 45745, "Sintel"));
            var response = Json(await rig.Controller(admin: false, first: seerr.Transport).GetDownloadHistory());
            Assert.Equal("Sintel", Assert.Single(response.GetProperty("items").EnumerateArray()).GetProperty("title").GetString());
            Assert.Equal(1, response.GetProperty("totalPages").GetInt32());
        }
        finally { cache.Remove(rig.Member.ToString()); }
    }

    [Fact]
    public async Task TheQueueRouteReturnsEveryRowAndReportsAFailingInstanceWithDetailOnlyForAdmins()
    {
        using var rig = new Rig();
        for (var i = 1; i <= 1200; i++) rig.Arr.Hosts["sonarr.lan"].Queue.Add(FakeArr.SonarrQueueRow(i, "p" + (i / 50), 1, i));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        rig.Radarr4k.FailWith = 401;

        var admin = Json(await rig.Controller(admin: true).GetDownloadQueue());
        Assert.Equal(1201, admin.GetProperty("items").GetArrayLength());
        Assert.Equal("Sonarr", admin.GetProperty("items")[0].GetProperty("source").GetString());   // Sonarr first, as before
        var error = Assert.Single(admin.GetProperty("errors").EnumerateArray());
        Assert.Equal("Movies 4K", error.GetProperty("instanceName").GetString());
        Assert.Equal("authentication failed (401)", error.GetProperty("reason").GetString());
        Assert.True(error.TryGetProperty("detail", out _));

        var calls = rig.Arr.Transport.Calls;
        var viewer = Json(await rig.Controller(admin: false).GetDownloadQueue());
        Assert.Equal(1201, viewer.GetProperty("items").GetArrayLength());
        Assert.False(viewer.GetProperty("errors")[0].TryGetProperty("detail", out _));
        Assert.Equal(calls, rig.Arr.Transport.Calls);     // served from memory (the 4K instance is backing off)
        var stats = rig.Store.Describe().Routes["arr/queue"];
        Assert.Equal((2L, 0L), (stats.Requests, stats.UpstreamCalls));
        var json = admin.GetRawText();
        Assert.DoesNotContain("KEY-0123456789", json);

        // A row without a key is left out quietly, as before (no error entry for it).
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.RadarrInstances = c.RadarrInstances.TrimEnd(']') + ",{\"Id\":\"6d0b7d1c-0000-4000-8000-000000000001\",\"Name\":\"No key\",\"Url\":\"http://nokey.lan:7878\",\"ApiKey\":\"\",\"Enabled\":true}]";
        var again = Json(await rig.Controller(admin: true).GetDownloadQueue());
        Assert.DoesNotContain("No key", again.GetRawText());
        Assert.Equal(0, rig.Arr.CallCount("nokey.lan"));
    }

    [Fact]
    public async Task HistoryNoLongerHidesAnInstanceThatCannotBeRead()
    {
        using var rig = new Rig();
        rig.Radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1), "d", 45745, "Sintel"));
        rig.Sonarr.FailWith = 500;

        var body = Json(await rig.Controller(admin: false).GetDownloadHistory());

        Assert.Equal("Sintel", Assert.Single(body.GetProperty("items").EnumerateArray()).GetProperty("title").GetString());
        var error = Assert.Single(body.GetProperty("errors").EnumerateArray());
        Assert.Equal(("TV", "HTTP 500"), (error.GetProperty("instanceName").GetString(), error.GetProperty("reason").GetString()));
        Assert.True(body.GetProperty("visible").GetBoolean());
    }

    [Fact]
    public void AnotherUsersNewerHistoryNeverPushesYoursOutOfTheWindow()
    {
        var now = new DateTime(2026, 10, 12, 12, 0, 0, DateTimeKind.Utc);
        var items = Enumerable.Range(0, 300)
            .Select(i => new ArrLegacyHistoryItem { Source = "Radarr", Title = "Theirs " + i, TmdbId = 9000 + i, Date = now.AddMinutes(-i) })
            .Concat(Enumerable.Range(0, 3).Select(i => new ArrLegacyHistoryItem { Source = "Radarr", Title = "Mine " + i, TmdbId = 603, Date = now.AddDays(-1).AddMinutes(-i) }))
            .ToList();
        var mine = JellyfinEnhancedController.HistoryWindow(items, new HashSet<(int, string)> { (603, "movie") });
        Assert.Equal(new[] { "Mine 0", "Mine 1", "Mine 2" }, mine.Select(x => x.Title));
        // Unfiltered (administrators, filter off): the newest 200.
        var all = JellyfinEnhancedController.HistoryWindow(items, null);
        Assert.Equal((200, "Theirs 0"), (all.Count, all[0].Title));
    }

    [Fact]
    public void CalendarDateOnlyReleasesAreKeptByTheViewersDaysAndSaySo()
    {
        var radarr = new ArrConnection { Id = "r", Kind = ArrKind.Radarr, Name = "Movies", Url = "http://radarr.lan" };
        var sonarr = new ArrConnection { Id = "s", Kind = ArrKind.Sonarr, Name = "TV", Url = "http://sonarr.lan" };
        var movies = new ArrCalendarSnapshot { Entries = new[] { new ArrCalendarEntry { Id = 1, Title = "Dune", Releases = new Dictionary<string, DateTime> { ["DigitalRelease"] = new(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) } } } };
        // Los Angeles asks for 1–31 October: from 07:00 UTC on the 1st. A release dated the 1st (midnight
        // UTC on the wire) is still on the 1st there.
        var start = new DateTime(2026, 10, 1, 7, 0, 0, DateTimeKind.Utc);
        var end = new DateTime(2026, 11, 1, 6, 59, 0, DateTimeKind.Utc);
        var item = Assert.Single(ArrLegacyViews.CalendarItems(radarr, movies, start, end, "2026-10-01", "2026-10-31"));
        Assert.Equal((true, "2026-10-01"), (item.DateOnly, item.ReleaseDateLocal));
        // Outside the viewer's days: not listed.
        Assert.Empty(ArrLegacyViews.CalendarItems(radarr, movies, start, end, "2026-10-02", "2026-10-31"));
        // An episode with an air time stays an instant in the range; one without is a day.
        var episodes = new ArrCalendarSnapshot { Entries = new[]
        {
            new ArrCalendarEntry { Id = 2, Title = "Show", AirDateUtc = new DateTime(2026, 10, 1, 2, 0, 0, DateTimeKind.Utc) },
            new ArrCalendarEntry { Id = 3, Title = "Show", AirDateUtc = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc), AirDateIsDay = true },
        } };
        var listed = ArrLegacyViews.CalendarItems(sonarr, episodes, start, end, "2026-10-01", "2026-10-31").ToList();
        Assert.Equal(new[] { "sonarr|s|3" }, listed.Select(i => i.Id));
        Assert.True(listed[0].DateOnly);
        Assert.DoesNotContain("dateOnly", JsonSerializer.Serialize(ArrLegacyViews.CalendarItems(sonarr, episodes, start.AddHours(-6), end, null, null).Single(i => i.Id == "sonarr|s|2")));
    }

    [Fact]
    public async Task LinksComeFromTheLibraryIndexWithoutACallPerId()
    {
        using var rig = new Rig();
        rig.Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", path: "/data/movies/Sintel (2010)"));
        rig.Radarr4k.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", hasFile: false));
        rig.Sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly"));
        rig.Sonarr.Series.Add(FakeArr.SeriesRow(2, 75932, "No slug", slug: ""));
        var ids = string.Join(",", Enumerable.Range(1, 60).Append(45745));

        var body = Json(await rig.Controller(admin: true).GetArrLinks(ids, "78874,75932,1"));

        var sintel = body.GetProperty("movies").GetProperty("45745").GetProperty("matches");
        Assert.Equal(new[] { "Movies", "Movies 4K" }, sintel.EnumerateArray().Select(m => m.GetProperty("instanceName").GetString()));
        Assert.Equal("/data/movies", sintel[0].GetProperty("rootFolderPath").GetString());
        Assert.Equal(0, body.GetProperty("movies").GetProperty("1").GetProperty("matches").GetArrayLength());
        Assert.Equal("firefly", body.GetProperty("series").GetProperty("78874").GetProperty("matches")[0].GetProperty("titleSlug").GetString());
        Assert.Equal(0, body.GetProperty("series").GetProperty("75932").GetProperty("matches").GetArrayLength());
        // One library read per instance (status, tags, list), not one call per id and instance.
        Assert.Equal(1, rig.Arr.CallCount("radarr.lan", "/api/v3/movie"));
        Assert.Equal(1, rig.Arr.CallCount("sonarr.lan", "/api/v3/series"));
        Assert.Equal(9, rig.Arr.Transport.Calls);

        var single = Json(await rig.Controller(admin: true).GetMovieInstances(45745));
        Assert.Equal(2, single.GetProperty("matches").GetArrayLength());
        var slug = Assert.IsType<OkObjectResult>(await rig.Controller(admin: true).GetSeriesSlug(78874));
        Assert.Contains("firefly", JsonSerializer.Serialize(slug.Value));
        Assert.IsType<NotFoundObjectResult>(await rig.Controller(admin: true).GetSeriesSlug(75932));
        Assert.Equal(9, rig.Arr.Transport.Calls);
    }

    [Fact]
    public async Task ALinkLookupServedFromAnOlderIndexStillReportsTheInstancesLatestError()
    {
        using var rig = new Rig();
        rig.Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        Assert.Empty(Json(await rig.Controller(admin: true).GetMovieInstances(45745)).GetProperty("errors").EnumerateArray());

        // The key is revoked in Radarr; the next refresh fails, the index read before stays.
        rig.Radarr.FailWith = 401;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(20);
        await rig.Controller(admin: true).GetMovieInstances(45745);
        for (var i = 0; i < 200 && rig.Store.Describe().Instances.Any(x => x.Snapshots.Any(s => s.Refreshing)); i++) await Task.Delay(10);

        var body = Json(await rig.Controller(admin: true).GetMovieInstances(45745));
        Assert.Contains("Movies", body.GetProperty("matches").EnumerateArray().Select(m => m.GetProperty("instanceName").GetString()));
        var error = Assert.Single(body.GetProperty("errors").EnumerateArray());
        Assert.Equal(("Movies", "authentication failed (401)"), (error.GetProperty("instanceName").GetString(), error.GetProperty("reason").GetString()));
        var links = Json(await rig.Controller(admin: true).GetArrLinks("45745", null));
        Assert.Single(links.GetProperty("movies").GetProperty("45745").GetProperty("errors").EnumerateArray());
    }

    [Fact]
    public async Task EveryArrPageRouteIsRefusedWhenItsFeatureIsOff()
    {
        using var rig = new Rig();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.DownloadsPageEnabled = false;
        c.CalendarPageEnabled = false;
        c.ArrLinksEnabled = false;
        var admin = rig.Controller(admin: true);
        var viewer = rig.Controller(admin: false);

        foreach (var result in new IActionResult[]
        {
            await viewer.GetDownloadQueue(), await viewer.GetDownloadHistory(), await viewer.GetRequests(),
            await viewer.ActOnRequest(1), await viewer.GetCalendarEvents(),
            await admin.GetArrLinks("1", null), await admin.GetMovieInstances(1), await admin.GetSeriesSlugs(1), await admin.GetSeriesSlug(1),
        })
        {
            var refused = Assert.IsType<ObjectResult>(result);
            Assert.Equal(403, refused.StatusCode);
            Assert.Contains("feature_disabled", JsonSerializer.Serialize(refused.Value));
        }
        Assert.Equal(0, rig.Arr.Transport.Calls);

        // The downloads display switch hides the queue and history the page wouldn't show.
        c.DownloadsPageEnabled = true;
        c.ShowDownloadsInRequests = false;
        Assert.Equal(0, Json(await viewer.GetDownloadQueue()).GetProperty("items").GetArrayLength());
        Assert.False(Json(await viewer.GetDownloadHistory()).GetProperty("visible").GetBoolean());
        // The request list also needs Seerr itself switched on (not only a URL and key).
        c.JellyseerrEnabled = false;
        c.JellyseerrUrls = "http://seerr.lan";
        c.JellyseerrApiKey = "seerr-key";
        Assert.Equal(0, Json(await viewer.GetRequests()).GetProperty("totalResults").GetInt32());
        Assert.Equal(0, rig.Arr.Transport.Calls);
    }

    [Fact]
    public async Task ARequestIsOnlyCalledMissingFromTheArrsWhenEveryIndexReadAfterItsGracePeriodLacksIt()
    {
        using var rig = new Rig();
        rig.Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var controller = rig.Controller(admin: true);
        string Created(TimeSpan ago) => rig.Arr.Now.Subtract(ago).ToString("o");

        // Index read now; request made an hour ago (grace ended 50 minutes ago).
        Assert.False(await controller.IsMissingFromArrAsync("movie", 45745, null, Created(TimeSpan.FromHours(1)), default));   // it's there
        Assert.True(await controller.IsMissingFromArrAsync("movie", 999, null, Created(TimeSpan.FromHours(1)), default));
        var calls = rig.Arr.Transport.Calls;
        for (var i = 0; i < 50; i++) await controller.IsMissingFromArrAsync("movie", 1000 + i, null, Created(TimeSpan.FromHours(1)), default);
        Assert.Equal(calls, rig.Arr.Transport.Calls);    // one index read per instance, not one call per row

        // A request newer than the index read (minus the grace period) can't be judged yet.
        Assert.False(await controller.IsMissingFromArrAsync("movie", 999, null, Created(TimeSpan.FromMinutes(-5)), default));
        Assert.False(await controller.IsMissingFromArrAsync("movie", 999, null, "not a date", default));
        Assert.False(await controller.IsMissingFromArrAsync("tv", null, null, Created(TimeSpan.FromHours(1)), default));

        // An instance that can't be read makes the answer "don't know".
        rig.Radarr4k.FailWith = 500;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(20);
        await Task.WhenAll(rig.Store.Tick());
        Assert.False(await controller.IsMissingFromArrAsync("movie", 999, null, Created(TimeSpan.FromHours(1)), default));
    }

    [Fact]
    public async Task TheStateRouteIsAdminOnlyAndValidatesRefreshRequests()
    {
        using var rig = new Rig();
        rig.Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        await rig.Store.GetLibraryAsync(rig.Arr.Instance("Movies"), default);
        var callers = new TestCallers();
        ArrStateController Make(bool admin, ClaimsPrincipal? caller = null)
        {
            var c = new ArrStateController(rig.Store, callers.Users.Object);
            c.ControllerContext = new ControllerContext { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext() };
            c.HttpContext.User = caller ?? callers.Person(admin);
            return c;
        }

        Assert.IsType<ForbidResult>(Make(false).GetState());
        Assert.IsType<ForbidResult>(Make(false, TestCallers.ApiKey()).GetState());
        Assert.IsType<ForbidResult>(Make(false, TestCallers.Unknown()).GetState());
        Assert.IsType<ForbidResult>(Make(false).RequestRefresh(rig.Arr.Instance("Movies").Id, "library"));
        var state = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(Make(true).GetState()).Value);
        Assert.Contains("\"Records\":1", state);
        Assert.DoesNotContain("KEY-0123456789", state);
        Assert.IsType<BadRequestObjectResult>(Make(true).RequestRefresh(rig.Arr.Instance("Movies").Id, "everything"));
        Assert.IsType<NotFoundObjectResult>(Make(true).RequestRefresh("nope", "library"));
        Assert.IsType<AcceptedResult>(Make(true).RequestRefresh(rig.Arr.Instance("Movies").Id, "Queue"));
    }

    // ---------------------------------------------------------------- who sees which downloads (C19)

    [Fact]
    public async Task WithTheRequestFilterOffMembersSeeOnlyTitlesTheAudienceLetsThemSee()
    {
        using var rig = new Rig();
        // Sonarr: a season pack of tvdb 100 (episodes 1-3, the member may not see episode 2) and a
        // row of another series the member may not see at all; Radarr: Sintel (visible), a title
        // in a hidden library, and a row without a TMDB id.
        foreach (var e in new[] { 1, 2, 3 }) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(e, "pack", 1, e, "Show", 100));
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(4, "other", 1, 1, "Hidden show", 555));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 666, "Hidden library"));
        var noId = FakeArr.RadarrQueueRow(3, 0, "No id");
        noId["movie"]!.AsObject().Remove("tmdbId");
        rig.Radarr.Queue.Add(noId);
        rig.Audience.Hidden.UnionWith(["tv:tvdb:100:s1:e2", "tv:tvdb:555:s1:e1", "movie:tmdb:666"]);

        var admin = Json(await rig.Controller(admin: true).GetDownloadQueue());
        Assert.Equal(7, admin.GetProperty("items").GetArrayLength());     // administrators: unchanged
        Assert.DoesNotContain(rig.Audience.Asked, a => !a.Admin && a.User != rig.Member);

        var calls = rig.Arr.Transport.Calls;
        var member = Json(await rig.Controller(admin: false).GetDownloadQueue());
        var titles = member.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString() + "|" + i.GetProperty("subtitle").GetString()).ToList();
        Assert.Equal(new[] { "Show|S01E01 - Episode 1", "Show|S01E03 - Episode 3", "Sintel|2010" }, titles);
        Assert.Equal(calls, rig.Arr.Transport.Calls);                      // decided from memory and Jellyfin, no arr call
        // One question per title key and instance, asked for this member, never as an administrator.
        var asked = rig.Audience.Asked.Where(a => a.User == rig.Member).ToList();
        Assert.All(asked, a => Assert.False(a.Admin));
        Assert.Equal(rig.Arr.Instance("TV").Id, asked.Single(a => a.Change.Key == "tv:tvdb:100:s1:e2").Change.InstanceId);
        Assert.Equal(rig.Arr.Instance("Movies").Id, asked.Single(a => a.Change.Key == "movie:tmdb:45745").Change.InstanceId);
        Assert.DoesNotContain(asked, a => a.Change.Key.Contains("tmdb:0", StringComparison.Ordinal));

        // The same title through another instance is decided for that instance (its own linked libraries).
        rig.Radarr4k.Queue.Add(FakeArr.RadarrQueueRow(9, 45745, "Sintel"));
        rig.Audience.HiddenIn.Add(("movie:tmdb:45745", rig.Arr.Instance("Movies 4K").Id));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(10);
        await Task.WhenAll(rig.Store.Tick());
        var both = Json(await rig.Controller(admin: false).GetDownloadQueue());
        Assert.Equal(new[] { "Movies" }, both.GetProperty("items").EnumerateArray().Where(i => i.GetProperty("title").GetString() == "Sintel").Select(i => i.GetProperty("instanceName").GetString()));

        // No person (no user id) or no audience service: nothing for a member, rather than everything.
        var noPerson = rig.Controller(admin: false);
        noPerson.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        Assert.Equal(0, Json(await noPerson.GetDownloadQueue()).GetProperty("items").GetArrayLength());
        var noAudience = ApiAssetTests.Controller(rig.Arr.Plugin.Core, rig.Arr.Transport, rig.Store, rig.Arr.Factory);
        noAudience.HttpContext.User = TestCallers.Principal(rig.Member, admin: false);
        Assert.Equal(0, Json(await noAudience.GetDownloadQueue()).GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task HistoryDropsHiddenEpisodesBeforeGroupingAndPagesWhatIsLeft()
    {
        using var rig = new Rig();
        var t = rig.Arr.Now.UtcDateTime.AddHours(-1);
        foreach (var e in new[] { 1, 2, 3 }) rig.Sonarr.History.Add(FakeArr.HistoryRow(e, "downloadFolderImported", t.AddSeconds(e), "pack", 200, "Show", 1, e));
        for (var i = 0; i < 6; i++) rig.Radarr.History.Add(FakeArr.HistoryRow(10 + i, "downloadFolderImported", t.AddMinutes(-i), "m" + i, 1000 + i, "Movie " + i));
        rig.Audience.Hidden.UnionWith(["tv:tvdb:100:s1:e2", "movie:tmdb:1001", "movie:tmdb:1003", "movie:tmdb:1005"]);

        var admin = Json(await rig.Controller(admin: true).GetDownloadHistory(take: 2));
        Assert.Equal(4, admin.GetProperty("totalPages").GetInt32());       // 7 items: the pack and 6 movies
        var page = Json(await rig.Controller(admin: false).GetDownloadHistory(take: 2));
        Assert.Equal(2, page.GetProperty("totalPages").GetInt32());        // 4 items: the pack and 3 movies
        var pack = page.GetProperty("items")[0];
        Assert.Equal(("Show", 2, "S01 · E01-E03"), (pack.GetProperty("title").GetString(), pack.GetProperty("episodeCount").GetInt32(), pack.GetProperty("subtitle").GetString()));
        var rest = Json(await rig.Controller(admin: false).GetDownloadHistory(take: 2, skip: 2)).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString());
        Assert.Equal(new[] { "Movie 2", "Movie 4" }, rest);
    }

    [Fact]
    public async Task WithTheRequestFilterOnAMemberSeesTitlesTheyAskedForThatTheAudienceAlsoAllows()
    {
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.DownloadsFilterByUserRequests = true;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = FakeSeerr.Url;
        c.JellyseerrApiKey = FakeSeerr.Key;
        // The member is Seerr user 7 (cached link) and asked for Sintel and the hidden-library title.
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetValue(null)!;
        cache[rig.Member.ToString()] = SeerrSeeds.Id(rig.Member.ToString(), "7");
        try
        {
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 45745, 2, rig.Member, DateTime.UtcNow.AddDays(-1)));
            seerr.Requests.Add(FakeSeerr.Request(2, "movie", 666, 2, rig.Member, DateTime.UtcNow.AddDays(-1)));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 666, "Hidden library"));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(3, 27205, "Not asked for"));
            rig.Audience.Hidden.Add("movie:tmdb:666");

            var member = Json(await rig.Controller(admin: false, first: seerr.Transport).GetDownloadQueue());
            Assert.Equal(new[] { "Sintel" }, member.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()));
            var admin = Json(await rig.Controller(admin: true, first: seerr.Transport).GetDownloadQueue());
            Assert.Equal(3, admin.GetProperty("items").GetArrayLength());
        }
        finally
        {
            cache.Remove(rig.Member.ToString());
        }
    }

    [Fact]
    public async Task TheRealAudienceHidesHiddenLibrariesAndShowsKidsOnlyTheAbsentTitlesTheyAskedFor()
    {
        // Jellyfin has tmdb 1 (everyone may open it) and tmdb 2 (in a library the users can't open);
        // tmdb 3 and 4 aren't in Jellyfin yet; the kid (a rating limit) asked for tmdb 3.
        var visibleTo = new HashSet<string> { "1" };
        var exists = new HashSet<string> { "1", "2" };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) =>
        {
            var id = q.HasAnyProviderId?.Values.FirstOrDefault();
            var hit = id != null && (q.User == null ? exists.Contains(id) : visibleTo.Contains(id));
            return hit ? new List<MediaBrowser.Controller.Entities.BaseItem> { new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() } } : new List<MediaBrowser.Controller.Entities.BaseItem>();
        });
        var callers = new TestCallers();
        using var rig = new Rig();
        var member = callers.Register(rig.Member, admin: false);
        member.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, true);
        var kidId = Guid.NewGuid();
        var kid = callers.Register(kidId, admin: false);
        kid.MaxParentalRatingScore = 10;
        var facts = new Mock<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IArrRequestFacts>();
        facts.Setup(f => f.AskedLatelyBy(It.Is<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.TitleKey>(k => k.ToString() == "movie:tmdb:3"), kidId)).Returns(true);
        foreach (var (id, tmdb) in new[] { (1, 1), (2, 2), (3, 3), (4, 4) }) rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(id, tmdb, "T" + tmdb));
        var audience = new ArrFeedAudience(library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), facts.Object);

        string[] Titles(JsonElement body) => body.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()!).ToArray();
        Assert.Equal(new[] { "T1", "T3", "T4" }, Titles(Json(await rig.Controller(admin: false, audience: audience).GetDownloadQueue())));
        var asKid = rig.Controller(admin: false, audience: audience);
        asKid.HttpContext.User = TestCallers.Principal(kidId, admin: false);
        Assert.Equal(new[] { "T1", "T3" }, Titles(Json(await asKid.GetDownloadQueue())));

        // "Movies" linked to a library the member can't open: its titles not in Jellyfin go; T1 (Jellyfin's own check) stays.
        var config = rig.Arr.Plugin.Plugin.Configuration;
        var rows = ArrRegistryMigration.Parse(config.RadarrInstances)!;
        rows.Single(r => r.Name == "Movies").LinkedLibraryIds = [Guid.NewGuid().ToString("N")];
        config.RadarrInstances = ArrRegistryMigration.Serialize(rows);
        member.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        Assert.Equal(new[] { "T1" }, Titles(Json(await rig.Controller(admin: false, audience: audience).GetDownloadQueue())));
    }

    [Fact]
    public async Task ANewArrAliasInvalidatesTheAudienceBeforeAnAskedForTitleCanBeMistakenForAbsent()
    {
        using var rig = new Rig();
        var callers = new TestCallers();
        callers.Register(rig.Member, admin: false).SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, true);
        rig.Sonarr.Series.Add(FakeArr.SeriesRow(1, 100, "Show", tmdb: 200, imdb: "tt100"));
        await rig.Store.GetLibraryAsync(rig.Arr.Instance("TV"), default);
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) =>
            q.User == null && q.HasAnyProviderId?.Values.Contains("tt101") == true
                ? new List<MediaBrowser.Controller.Entities.BaseItem> { series } : new List<MediaBrowser.Controller.Entities.BaseItem>());
        var audience = new ArrFeedAudience(library.Object, callers.Users.Object, rig.Store, () => rig.Arr.Now, new FakeJellyfinView());
        var change = new ArrFeedChange("tv:tvdb:100", 1, rig.Arr.Instance("TV").Id);
        var asked = new HashSet<string> { change.Key };
        Assert.Equal(new[] { change.Key }, audience.Visible(rig.Member, false, new[] { change }, asked));
        rig.Sonarr.Series[0]["imdbId"] = "tt101";
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("TV").Id, ArrSnapshotKind.Library, force: true);
        // Same viewer, clock and request revision: the new alias alone proves Jellyfin has a
        // hidden copy. Own-request proof can no longer make it visible as an absent title.
        Assert.Empty(audience.Visible(rig.Member, false, new[] { change }, asked));
    }

    [Fact]
    public async Task AHiddenCombinedEpisodeHidesEveryCoveredQueueRowAndShrinksTheHistoryPack()
    {
        using var rig = new Rig();
        var callers = new TestCallers();
        callers.Register(rig.Member, admin: false);
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        var combined = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1, IndexNumberEnd = 2 };
        var visible = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 3 };
        var visible4 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 4 };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) =>
        {
            if (q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Series))
                return new List<MediaBrowser.Controller.Entities.BaseItem> { series };
            if (q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Episode) && q.AncestorIds.Contains(series.Id) && q.ParentIndexNumber == 1)
                return q.User == null ? new List<MediaBrowser.Controller.Entities.BaseItem> { combined, visible, visible4 } : new List<MediaBrowser.Controller.Entities.BaseItem> { visible, visible4 };
            return new List<MediaBrowser.Controller.Entities.BaseItem>();
        });
        var audience = new ArrFeedAudience(library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        var t = rig.Arr.Now.UtcDateTime.AddHours(-1);
        // Queue rows and a season pack of E01-E04: Jellyfin has E01-E02 as one combined item the
        // member may not open, E03 and E04 as items they may.
        for (var e = 1; e <= 4; e++)
        {
            rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(e, "dl" + e, 1, e));
            rig.Sonarr.History.Add(FakeArr.HistoryRow(e, "downloadFolderImported", t.AddSeconds(e), "pack", 200, "Show", 1, e));
        }

        var member = rig.Controller(admin: false, audience: audience);
        var queue = Json(await member.GetDownloadQueue()).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(new[] { 3, 4 }, queue.Select(q => q.GetProperty("episodeNumber").GetInt32()).OrderBy(n => n));
        var pack = Assert.Single(Json(await member.GetDownloadHistory()).GetProperty("items").EnumerateArray());
        Assert.Equal((2, "S01 · E03-E04"), (pack.GetProperty("episodeCount").GetInt32(), pack.GetProperty("subtitle").GetString()));
        Assert.Equal(4, Json(await rig.Controller(admin: true, audience: audience).GetDownloadQueue()).GetProperty("items").GetArrayLength());
        var adminPack = Assert.Single(Json(await rig.Controller(admin: true, audience: audience).GetDownloadHistory()).GetProperty("items").EnumerateArray());
        Assert.Equal(4, adminPack.GetProperty("episodeCount").GetInt32());
        var changes = Enumerable.Range(1, 4).Select(e => new ArrFeedChange($"tv:tvdb:100:s1:e{e}", e, rig.Arr.Instance("TV").Id)).ToList();
        Assert.Equal(new[] { "tv:tvdb:100:s1:e3", "tv:tvdb:100:s1:e4" }, audience.Visible(rig.Member, false, changes));
        Assert.Equal(changes.Select(c => c.Key), audience.Visible(Guid.NewGuid(), true, changes));
    }

    /// <summary>A hidden combined file covers long ranges for queue, history and live changes.</summary>
    [Fact]
    public async Task AHiddenLongCombinedEpisodeHidesEveryCoveredQueueHistoryAndChangeFeedRow()
    {
        using var rig = new Rig();
        var callers = new TestCallers();
        callers.Register(rig.Member, admin: false);
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        var combined = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1, IndexNumberEnd = 60 };
        var visible = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 61 };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) =>
        {
            if (q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Series))
                return new List<MediaBrowser.Controller.Entities.BaseItem> { series };
            if (q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Episode) && q.AncestorIds.Contains(series.Id) && q.ParentIndexNumber == 1)
                return q.User == null ? new List<MediaBrowser.Controller.Entities.BaseItem> { combined, visible } : new List<MediaBrowser.Controller.Entities.BaseItem> { visible };
            return new List<MediaBrowser.Controller.Entities.BaseItem>();
        });
        var audience = new ArrFeedAudience(library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        foreach (var e in new[] { 2, 55, 61 })
        {
            rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(e, "dl" + e, 1, e));
            rig.Sonarr.History.Add(FakeArr.HistoryRow(e, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1).AddSeconds(e), "pack", 200, "Show", 1, e));
        }

        var member = rig.Controller(admin: false, audience: audience);
        var queue = Json(await member.GetDownloadQueue()).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(new[] { 61 }, queue.Select(q => q.GetProperty("episodeNumber").GetInt32()));
        var pack = Assert.Single(Json(await member.GetDownloadHistory()).GetProperty("items").EnumerateArray());
        Assert.Equal("S01E61 - Ep 61", pack.GetProperty("subtitle").GetString());
        Assert.Equal(3, Json(await rig.Controller(admin: true, audience: audience).GetDownloadQueue()).GetProperty("items").GetArrayLength());
        var adminPack = Assert.Single(Json(await rig.Controller(admin: true, audience: audience).GetDownloadHistory()).GetProperty("items").EnumerateArray());
        Assert.Equal(3, adminPack.GetProperty("episodeCount").GetInt32());
        var changes = new[] { 2, 55, 61 }.Select(e => new ArrFeedChange($"tv:tvdb:100:s1:e{e}", e, rig.Arr.Instance("TV").Id)).ToList();
        Assert.Equal(new[] { "tv:tvdb:100:s1:e61" }, audience.Visible(rig.Member, false, changes));
        Assert.Equal(changes.Select(c => c.Key), audience.Visible(Guid.NewGuid(), true, changes));
    }

    // A Jellyfin library for the real audience: movies by TMDB id ("in Jellyfin" / "users may open
    // it"), series tvdb 100 (everyone may open it) with every episode of every season, and a count
    // of the queries asked.
    private sealed class AudienceLibrary
    {
        public HashSet<string> Exists { get; } = new();
        public HashSet<string> VisibleTo { get; } = new();
        public int Queries;
        public Mock<ILibraryManager> Library { get; } = new();

        public AudienceLibrary()
        {
            var series = Guid.NewGuid();
            Library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) =>
            {
                Interlocked.Increment(ref Queries);
                if (q.HasAnyProviderId is { Count: > 0 } ids)
                {
                    if (q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Series))
                        return ids.Values.Contains("100") ? new List<MediaBrowser.Controller.Entities.BaseItem> { new MediaBrowser.Controller.Entities.TV.Series { Id = series } } : new List<MediaBrowser.Controller.Entities.BaseItem>();
                    var id = ids.Values.FirstOrDefault();
                    var hit = id != null && (q.User == null ? Exists.Contains(id) : VisibleTo.Contains(id));
                    return hit ? new List<MediaBrowser.Controller.Entities.BaseItem> { new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() } } : new List<MediaBrowser.Controller.Entities.BaseItem>();
                }
                if (q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Episode))
                    return Enumerable.Range(1, 100).Select(n => (MediaBrowser.Controller.Entities.BaseItem)new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = n }).ToList();
                return new List<MediaBrowser.Controller.Entities.BaseItem>();
            });
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConfirmedQueueDeparturesUseTheSharedAliasesAndAudience(bool visible)
    {
        using var rig = new Rig();
        var callers = new TestCallers();
        callers.Register(rig.Member, admin: false);
        var arrMovie = FakeArr.Movie(1, 101, "Alpha");
        arrMovie["imdbId"] = "tt101";
        rig.Radarr.Movies.Add(arrMovie);
        var instance = rig.Arr.Instance("Movies");
        var librarySnapshot = (await rig.Store.GetLibraryAsync(instance, default)).Value!;
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() };
        movie.ProviderIds = new() { ["Imdb"] = "tt101" };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) =>
            q.HasAnyProviderId?.Values.Contains("tt101") == true && (q.User == null || visible)
                ? new List<MediaBrowser.Controller.Entities.BaseItem> { movie } : new List<MediaBrowser.Controller.Entities.BaseItem>());
        var audience = new ArrFeedAudience(library.Object, callers.Users.Object, rig.Store, () => rig.Arr.Now, new FakeJellyfinView());
        // Neither snapshot holds the row: H4's explicit departure payload is the only diff.
        var keys = ArrChangeDetector.Queue(ArrKind.Radarr, new ArrQueueSnapshot(), new ArrQueueSnapshot(), librarySnapshot,
            new[] { new ArrQueueEntry { MovieId = 1, TmdbId = 101 } });
        Assert.Equal(new[] { "movie:tmdb:101" }, keys);
        var changes = keys.Select(k => new ArrFeedChange(k, 1, instance.Id)).ToArray();
        var shown = audience.Visible(rig.Member, false, changes, new HashSet<string>(keys));
        Assert.Equal(visible ? keys : Array.Empty<string>(), shown);
        Assert.Equal(keys, audience.Visible(Guid.NewGuid(), true, changes));
    }

    [Fact]
    public async Task WithPhaseOneOffAMemberWithLimitsStillSeesTheAbsentTitlesTheyAskedForButNotOnesJellyfinHides()
    {
        // The request read model is off (integration / phase 1 off, the upstream default), so it
        // can't say who asked for what. The kid (a rating limit) asked in Seerr for tmdb 3 (not in
        // Jellyfin yet), tmdb 2 (in Jellyfin, hidden from them) and the series tvdb 100 / tmdb 200
        // (its episode not in Jellyfin's season); tmdb 1 is in Jellyfin and theirs; tmdb 4 isn't in
        // Jellyfin and nobody asked for it.
        var jf = new AudienceLibrary();
        jf.Exists.UnionWith(["1", "2"]);
        jf.VisibleTo.Add("1");
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = FakeSeerr.Url;
        c.JellyseerrApiKey = FakeSeerr.Key;
        c.ArrIntegrationEnabled = false;
        c.ArrPhase1Enabled = false;
        var callers = new TestCallers();
        callers.Register(rig.Member, admin: false).SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, true); // every library, no limits
        var kidId = Guid.NewGuid();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;
        var readModel = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts(seerr.Transport, new ArrChangeFeed(), null, () => c, () => rig.Arr.Now);
        Assert.False(readModel.Active);
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), readModel);
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetValue(null)!;
        cache[kidId.ToString()] = SeerrSeeds.Id(kidId.ToString(), "7");
        try
        {
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 3, 2, kidId, DateTime.UtcNow.AddDays(-1)));
            seerr.Requests.Add(FakeSeerr.Request(2, "movie", 2, 2, kidId, DateTime.UtcNow.AddDays(-1)));
            seerr.Requests.Add(FakeSeerr.Request(3, "tv", 200, 2, kidId, DateTime.UtcNow.AddDays(-1), tvdb: 100));
            foreach (var tmdb in new[] { 1, 2, 3, 4 }) rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(tmdb, tmdb, "T" + tmdb));
            rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(9, "pack", 7, 1, "Show", 100, 200));       // season 7 isn't in Jellyfin
            var t = rig.Arr.Now.UtcDateTime.AddHours(-1);
            rig.Radarr.History.Add(FakeArr.HistoryRow(10, "downloadFolderImported", t, null, 3, "T3"));
            rig.Radarr.History.Add(FakeArr.HistoryRow(11, "downloadFolderImported", t, null, 4, "T4"));

            JellyfinEnhancedController As(Guid user)
            {
                var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, seerr.Transport, callers.Users.Object, rig.Arr.Transport, rig.Store, rig.Arr.Factory, audience);
                controller.HttpContext.User = TestCallers.Principal(user, admin: false);
                return controller;
            }
            static string[] Titles(IActionResult result) => Json(result).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()!).OrderBy(x => x, StringComparer.Ordinal).ToArray();

            // Request filter off: their own absent titles and Jellyfin's verdict for the rest.
            Assert.Equal(new[] { "Show", "T1", "T3" }, Titles(await As(kidId).GetDownloadQueue()));
            Assert.Equal(new[] { "T3" }, Titles(await As(kidId).GetDownloadHistory()));
            // A member without limits sees every absent title anyway, and their page reads nothing from Seerr.
            var seerrCalls = seerr.Calls.Count;
            Assert.Equal(new[] { "Show", "T1", "T3", "T4" }, Titles(await As(rig.Member).GetDownloadQueue()));
            Assert.Equal(seerrCalls, seerr.Calls.Count);

            // Request filter on: what they asked for, still without what Jellyfin hides (tmdb 2).
            c.DownloadsFilterByUserRequests = true;
            Assert.Equal(new[] { "Show", "T3" }, Titles(await As(kidId).GetDownloadQueue()));
        }
        finally
        {
            cache.Remove(kidId.ToString());
        }
    }

    [Fact]
    public async Task WithPhaseOneOffSeerrIsReadOnlyWhenARowWaitsOnTheProofAndOncePerPollInterval()
    {
        // Flags off (no request read model), request filter off, Seerr set up. tmdb 1 is in Jellyfin
        // and visible to everyone; tmdb 3 isn't in Jellyfin and the kid asked for it.
        var jf = new AudienceLibrary();
        jf.Exists.Add("1");
        jf.VisibleTo.Add("1");
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = FakeSeerr.Url;
        c.JellyseerrApiKey = FakeSeerr.Key;
        c.ArrIntegrationEnabled = false;
        c.ArrPhase1Enabled = false;
        c.DownloadsFilterByUserRequests = false;
        var callers = new TestCallers();
        var kidId = Guid.NewGuid();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;               // a rating limit
        var someId = Guid.NewGuid();
        var some = callers.Register(someId, admin: false);                                 // not every library, no limits
        some.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        var readModel = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts(seerr.Transport, new ArrChangeFeed(), null, () => c, () => rig.Arr.Now);
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), readModel);
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetValue(null)!;
        cache[kidId.ToString()] = SeerrSeeds.Id(kidId.ToString(), "7");
        cache[someId.ToString()] = SeerrSeeds.Id(someId.ToString(), "7");
        try
        {
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 3, 2, kidId, DateTime.UtcNow.AddDays(-1)));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 1, "T1"));
            rig.Radarr.History.Add(FakeArr.HistoryRow(10, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1), null, 1, "T1"));
            JellyfinEnhancedController As(Guid user)
            {
                var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, seerr.Transport, callers.Users.Object, rig.Arr.Transport, rig.Store, rig.Arr.Factory, audience);
                controller.HttpContext.User = TestCallers.Principal(user, admin: false);
                return controller;
            }
            static string[] Titles(IActionResult result) => Json(result).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()!).OrderBy(x => x, StringComparer.Ordinal).ToArray();
            int Reads() => seerr.CallCount("/api/v1/request");

            // No row waits on proof (everything in Jellyfin and theirs, or open to them anyway):
            // no Seerr read, for the kid or for a member without every library.
            Assert.Equal(new[] { "T1" }, Titles(await As(kidId).GetDownloadQueue()));
            Assert.Equal(new[] { "T1" }, Titles(await As(kidId).GetDownloadHistory()));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(3, 3, "T3"));
            rig.Radarr.History.Add(FakeArr.HistoryRow(11, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddMinutes(-30), null, 3, "T3"));
            rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
            await Task.WhenAll(rig.Store.Tick());
            Assert.Equal(new[] { "T1", "T3" }, Titles(await As(someId).GetDownloadQueue()));   // unresolved: their cached Seerr identity proves their own request
            Assert.Equal(new[] { "T1", "T3" }, Titles(await As(someId).GetDownloadHistory()));
            Assert.Equal(1, Reads());

            // The kid also needs proof: one read for that user, then shared by the next poll and
            // the history inside the poll interval.
            Assert.Equal(new[] { "T1", "T3" }, Titles(await As(kidId).GetDownloadQueue()));
            Assert.Equal(2, Reads());
            Assert.Equal(new[] { "T1", "T3" }, Titles(await As(kidId).GetDownloadQueue()));
            Assert.Equal(new[] { "T1", "T3" }, Titles(await As(kidId).GetDownloadHistory()));
            Assert.Equal(2, Reads());
        }
        finally
        {
            cache.Remove(kidId.ToString());
            cache.Remove(someId.ToString());
        }
    }

    [Fact]
    public async Task AHangingSeerrNeverHoldsUpTheLegacyQueue()
    {
        var jf = new AudienceLibrary();
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = FakeSeerr.Url;
        c.JellyseerrApiKey = FakeSeerr.Key;
        c.ArrIntegrationEnabled = false;
        c.ArrPhase1Enabled = false;
        var callers = new TestCallers();
        var kidId = Guid.NewGuid();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetValue(null)!;
        cache[kidId.ToString()] = SeerrSeeds.Id(kidId.ToString(), "7");
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reads = 0;
        seerr.Before = () =>
        {
            Interlocked.Increment(ref reads);
            return gate.Task;
        };
        try
        {
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 3, 2, kidId, DateTime.UtcNow.AddDays(-1)));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(3, 3, "T3"));
            async Task<string[]> Queue()
            {
                var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, seerr.Transport, callers.Users.Object, rig.Arr.Transport, rig.Store, rig.Arr.Factory, audience);
                controller.HttpContext.User = TestCallers.Principal(kidId, admin: false);
                var result = await controller.GetDownloadQueue().WaitAsync(TimeSpan.FromSeconds(8));
                return Json(result).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()!).ToArray();
            }

            // Seerr doesn't answer: the poll answers without the proof after a short wait ...
            var watch = System.Diagnostics.Stopwatch.StartNew();
            Assert.Empty(await Queue());
            Assert.InRange(watch.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(6));
            // ... and the next one doesn't start another read while that one is still running.
            Assert.Empty(await Queue());
            Assert.Equal(1, Volatile.Read(ref reads));
            // Once Seerr answers, the read already made shows the title.
            gate.SetResult();
            string[] titles = [];
            for (var i = 0; i < 50 && titles.Length == 0; i++)
            {
                await Task.Delay(50);
                titles = await Queue();
            }
            Assert.Equal(new[] { "T3" }, titles);
            Assert.Equal(1, seerr.CallCount("/api/v1/request"));
        }
        finally
        {
            gate.TrySetResult();
            cache.Remove(kidId.ToString());
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AReadModelSourceChangeClearsLegacyUserAndProofCachesAndItsTitleMetadata(bool useDue)
    {
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var config = rig.Arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.JellyseerrEnabled = true;
        config.JellyseerrUrls = FakeSeerr.Url;
        config.JellyseerrApiKey = FakeSeerr.Key;
        seerr.Requests.Add(FakeSeerr.Request(1, "tv", 9501, 2, rig.Member, rig.Arr.Now.UtcDateTime));
        seerr.Shows[9501] = new System.Text.Json.Nodes.JsonObject
        {
            ["name"] = "Old server's title", ["externalIds"] = new System.Text.Json.Nodes.JsonObject { ["tvdbId"] = 501 },
        };
        using var model = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts(seerr.Transport, null, null, () => config, () => rig.Arr.Now);
        Assert.True(await model.RefreshAsync(default));
        Assert.Equal(501, model.All.Single().TvdbId);
        var fields = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", fields)!.GetValue(null)!;
        var userKey = rig.Member.ToString();
        cache[userKey] = SeerrSeeds.Id(userKey, "7");
        var proof = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.Shared;
        var proofKey = userKey + "|" + FakeSeerr.Url;
        Assert.NotNull(await proof.GetAsync(proofKey, () => Task.FromResult<IReadOnlySet<(int, string)>?>(new HashSet<(int, string)> { (9501, "tv") })));
        config.JellyseerrUrls = "http://replacement-seerr.lan:5055";
        seerr.FailWith = 503;
        if (useDue) Assert.True(model.Due());
        else Assert.False(await model.RefreshAsync(default));
        Assert.False(cache.Contains(userKey));
        Assert.Null(model.Meta(false, 9501));
        Assert.Empty(model.All);
        // The proof must be read again; a failure cannot return the previous server's answer.
        Assert.Null(await proof.GetAsync(proofKey, () => Task.FromResult<IReadOnlySet<(int, string)>?>(null)));
        seerr.FailWith = 0;
        seerr.Shows[9501]["externalIds"]!["tvdbId"] = 502;
        Assert.True(await model.RefreshAsync(default));
        Assert.Equal(502, model.All.Single().TvdbId);
        proof.Clear();
    }

    /// <summary>A lookup finishing after a settings save cannot restore either Seerr user cache.</summary>
    [Fact]
    public async Task SavingSeerrSettingsFencesAnInFlightBlockedUserLookup()
    {
        var jf = new AudienceLibrary();
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var saved = (c.JellyseerrEnabled, c.JellyseerrUrls, c.JellyseerrApiKey, c.ArrIntegrationEnabled, c.ArrPhase1Enabled,
            c.DownloadsFilterByUserRequests, c.JellyseerrImportBlockedUsers, c.JellyseerrDisableCache);
        var callers = new TestCallers();
        var kidId = Guid.NewGuid();
        var userKey = kidId.ToString();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        var fields = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", fields)!.GetValue(null)!;
        var cacheLock = SeerrFactTestAccess.Gate;
        var users = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userCache", fields)!.GetValue(null)!;
        var usersLock = SeerrFactTestAccess.Gate;
        var proof = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.Shared;
        JellyfinEnhancedController AsMember()
        {
            var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, seerr.Transport, callers.Users.Object, rig.Arr.Transport, rig.Store, rig.Arr.Factory, audience);
            controller.HttpContext.User = TestCallers.Principal(kidId, admin: false);
            return controller;
        }
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task? inflight = null;
        seerr.BeforeRequest = uri =>
        {
            if (uri.AbsolutePath != "/api/v1/user") return Task.CompletedTask;
            entered.TrySetResult();
            return gate.Task;
        };
        try
        {
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            c.ArrIntegrationEnabled = false;
            c.ArrPhase1Enabled = false;
            c.DownloadsFilterByUserRequests = false;
            c.JellyseerrDisableCache = false;
            c.JellyseerrImportBlockedUsers = "";
            lock (cacheLock) Assert.False(cache.Contains(userKey));
            seerr.Users.Add(new System.Text.Json.Nodes.JsonObject { ["id"] = 7, ["jellyfinUserId"] = kidId.ToString("N"), ["displayName"] = "Member" });
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 3, 2, kidId, DateTime.UtcNow.AddDays(-1)));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(3, 3, "T3"));
            rig.Radarr.History.Add(FakeArr.HistoryRow(3, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1), null, 3, "T3"));

            Assert.Empty(Json(await AsMember().GetDownloadQueue().WaitAsync(TimeSpan.FromSeconds(8))).GetProperty("items").EnumerateArray());
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // Await the actual background read after releasing Seerr, so both cache assertions run
            // after its writes, rather than depending on a sleep or observing an HTTP call early.
            var entries = (System.Collections.IDictionary)SeerrFactTestAccess.OwnershipEntries(proof);
            var entry = entries[SeerrSeeds.ProofKey(userKey, FakeSeerr.Url)]!;
            lock (entry) inflight = (Task)entry.GetType().GetProperty("Inflight")!.GetValue(entry)!;
            c.JellyseerrImportBlockedUsers = kidId.ToString("N");
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
            gate.SetResult();
            await inflight.WaitAsync(TimeSpan.FromSeconds(5));

            lock (cacheLock) Assert.False(cache.Contains(userKey));
            lock (usersLock) Assert.False(users.Contains(userKey));
            Assert.Equal(1, seerr.CallCount("/api/v1/user"));
            Assert.Equal(1, seerr.CallCount("/api/v1/request"));
            for (var i = 0; i < 3; i++)
            {
                // Drop even the fresh failed proof: each poll must refuse the blocked user afresh.
                proof.Clear();
                Assert.Empty(Json(await AsMember().GetDownloadQueue()).GetProperty("items").EnumerateArray());
                Assert.Empty(Json(await AsMember().GetDownloadHistory()).GetProperty("items").EnumerateArray());
            }
            Assert.Equal(1, seerr.CallCount("/api/v1/request"));
            Assert.Equal(2, seerr.Calls.Count);
        }
        finally
        {
            try
            {
                if (inflight == null)
                {
                    var entries = (System.Collections.IDictionary)SeerrFactTestAccess.OwnershipEntries(proof);
                    if (entries[SeerrSeeds.ProofKey(userKey, FakeSeerr.Url)] is { } entry)
                        lock (entry) inflight = (Task?)entry.GetType().GetProperty("Inflight")!.GetValue(entry);
                }
                gate.TrySetResult();
                if (inflight != null) await inflight.WaitAsync(TimeSpan.FromSeconds(5));
            }
            finally
            {
                lock (cacheLock) cache.Remove(userKey);
                lock (usersLock) users.Remove(userKey);
                proof.Clear();
                (c.JellyseerrEnabled, c.JellyseerrUrls, c.JellyseerrApiKey, c.ArrIntegrationEnabled, c.ArrPhase1Enabled,
                    c.DownloadsFilterByUserRequests, c.JellyseerrImportBlockedUsers, c.JellyseerrDisableCache) = saved;
            }
        }
    }

    /// <summary>An import-blocked member cannot use a cached Seerr id as asked-for proof.</summary>
    [Fact]
    public async Task AnImportBlockedUserWithACachedSeerrIdCannotReadQueueOrHistoryProof()
    {
        var jf = new AudienceLibrary();
        using var rig = new Rig();
        using var seerr = new FakeSeerr();
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var saved = (c.JellyseerrEnabled, c.JellyseerrUrls, c.JellyseerrApiKey, c.ArrIntegrationEnabled, c.ArrPhase1Enabled,
            c.DownloadsFilterByUserRequests, c.JellyseerrImportBlockedUsers, c.JellyseerrDisableCache);
        var callers = new TestCallers();
        var kidId = Guid.NewGuid();
        var userKey = kidId.ToString();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        var fields = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", fields)!.GetValue(null)!;
        var cacheLock = SeerrFactTestAccess.Gate;
        var users = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userCache", fields)!.GetValue(null)!;
        var usersLock = SeerrFactTestAccess.Gate;
        var proof = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.Shared;
        JellyfinEnhancedController AsMember()
        {
            var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, seerr.Transport, callers.Users.Object, rig.Arr.Transport, rig.Store, rig.Arr.Factory, audience);
            controller.HttpContext.User = TestCallers.Principal(kidId, admin: false);
            return controller;
        }
        try
        {
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            c.ArrIntegrationEnabled = false;
            c.ArrPhase1Enabled = false;
            c.DownloadsFilterByUserRequests = false;
            c.JellyseerrDisableCache = false;
            c.JellyseerrImportBlockedUsers = kidId.ToString("N");
            lock (cacheLock) cache[userKey] = SeerrSeeds.Id(userKey, "7");
            seerr.Users.Add(new System.Text.Json.Nodes.JsonObject { ["id"] = 7, ["jellyfinUserId"] = kidId.ToString("N"), ["displayName"] = "Member" });
            seerr.Requests.Add(FakeSeerr.Request(1, "movie", 3, 2, kidId, DateTime.UtcNow.AddDays(-1)));
            rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(3, 3, "T3"));
            rig.Radarr.History.Add(FakeArr.HistoryRow(3, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1), null, 3, "T3"));

            Assert.Empty(Json(await AsMember().GetDownloadQueue()).GetProperty("items").EnumerateArray());
            Assert.Empty(Json(await AsMember().GetDownloadHistory()).GetProperty("items").EnumerateArray());
            Assert.Empty(seerr.Calls);
        }
        finally
        {
            lock (cacheLock) cache.Remove(userKey);
            lock (usersLock) users.Remove(userKey);
            proof.Clear();
            (c.JellyseerrEnabled, c.JellyseerrUrls, c.JellyseerrApiKey, c.ArrIntegrationEnabled, c.ArrPhase1Enabled,
                c.DownloadsFilterByUserRequests, c.JellyseerrImportBlockedUsers, c.JellyseerrDisableCache) = saved;
        }
    }

    [Fact]
    public async Task TheAskedForCacheReusesFreshAnswersServesStaleOnesAtOnceAndDoesntRetryAFailureRightAway()
    {
        var now = new DateTimeOffset(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        var cache = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache(() => now.UtcTicks, TimeSpan.FromSeconds(5));
        var reads = 0;
        IReadOnlySet<(int, string)>? answer = new HashSet<(int, string)> { (3, "movie") };
        Task<IReadOnlySet<(int TmdbId, string MediaType)>?> Read()
        {
            Interlocked.Increment(ref reads);
            return Task.FromResult(answer);
        }

        Assert.Contains((3, "movie"), (await cache.GetAsync("u", Read))!);
        now += TimeSpan.FromSeconds(20);
        await cache.GetAsync("u", Read);
        Assert.Equal(1, reads);                                             // fresh: reused
        // Past the fresh time: the old answer at once, a new read behind it.
        now += TimeSpan.FromSeconds(20);
        answer = new HashSet<(int, string)> { (4, "movie") };
        Assert.Contains((3, "movie"), (await cache.GetAsync("u", Read))!);
        for (var i = 0; i < 100 && !(await cache.GetAsync("u", Read))!.Contains((4, "movie")); i++) await Task.Delay(10);
        Assert.Equal(2, reads);
        // A failed read (Seerr down): no answer, and no new read within the fresh time.
        answer = null;
        Assert.Null(await cache.GetAsync("v", Read));
        Assert.Null(await cache.GetAsync("v", Read));
        Assert.Equal(3, reads);
        now += Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.Fresh;
        answer = new HashSet<(int, string)>();
        Assert.Empty((await cache.GetAsync("v", Read))!);
        Assert.Equal(4, reads);
        // Too old to serve: read again and waited for.
        now += Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.MaxStale;
        answer = new HashSet<(int, string)> { (5, "tv") };
        Assert.Contains((5, "tv"), (await cache.GetAsync("u", Read))!);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ClearingAskedForProofDropsFreshAndStaleAnswers(bool stale)
    {
        var now = new DateTimeOffset(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        var cache = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache(() => now.UtcTicks, TimeSpan.FromSeconds(5));
        var key = Guid.NewGuid().ToString();
        var reads = 0;
        IReadOnlySet<(int, string)>? answer = new HashSet<(int, string)> { (3, "movie") };
        Task<IReadOnlySet<(int TmdbId, string MediaType)>?> Read()
        {
            Interlocked.Increment(ref reads);
            return Task.FromResult(answer);
        }
        Assert.Contains((3, "movie"), (await cache.GetAsync(key, Read))!);
        if (stale) now += Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.Fresh;

        cache.Clear();
        answer = stale ? null : new HashSet<(int, string)> { (4, "movie") };
        var after = await cache.GetAsync(key, Read);
        if (stale) Assert.Null(after);
        else Assert.Contains((4, "movie"), after!);
        Assert.Equal(2, reads);
    }

    [Fact]
    public async Task AnAskedForReadStartedBeforeClearCantPutItsAnswerBack()
    {
        var cache = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache(wait: TimeSpan.FromSeconds(5));
        var key = Guid.NewGuid().ToString();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new TaskCompletionSource<IReadOnlySet<(int TmdbId, string MediaType)>?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var before = cache.GetAsync(key, () =>
        {
            started.TrySetResult();
            return gate.Task;
        });
        try
        {
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cache.Clear();
            gate.SetResult(new HashSet<(int, string)> { (3, "movie") });
            Assert.Null(await before);
            var reads = 0;
            var after = await cache.GetAsync(key, () =>
            {
                Interlocked.Increment(ref reads);
                return Task.FromResult<IReadOnlySet<(int, string)>?>(new HashSet<(int, string)> { (4, "movie") });
            });
            Assert.Contains((4, "movie"), after!);
            Assert.Equal(1, reads);
        }
        finally
        {
            gate.TrySetResult(null);
        }
    }

    [Fact]
    public async Task SavingSeerrSettingsClearsTheSharedAskedForProofCache()
    {
        var cache = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.OwnershipCache.Shared;
        var key = Guid.NewGuid().ToString();
        var reads = 0;
        IReadOnlySet<(int, string)>? answer = new HashSet<(int, string)> { (3, "movie") };
        Task<IReadOnlySet<(int TmdbId, string MediaType)>?> Read()
        {
            Interlocked.Increment(ref reads);
            return Task.FromResult<IReadOnlySet<(int TmdbId, string MediaType)>?>(answer);
        }
        Assert.Contains((3, "movie"), (await cache.GetAsync(key, Read))!);

        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        answer = new HashSet<(int, string)> { (4, "movie") };
        Assert.Contains((4, "movie"), (await cache.GetAsync(key, Read))!);
        Assert.Equal(2, reads);
    }

    [Fact]
    public async Task HistoryDecidesOnlyWhatItsWindowCanShowAndALongRingCostsAFewLibraryQueries()
    {
        // A full 2000-record Sonarr ring (each of 1000 episodes grabbed, then imported) for a member
        // with a rating limit, whose episodes are therefore each checked in Jellyfin.
        var jf = new AudienceLibrary();
        using var rig = new Rig();
        var callers = new TestCallers();
        var kidId = Guid.NewGuid();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        var t0 = rig.Arr.Now.UtcDateTime.AddDays(-3);
        void Episodes(int from, int to)
        {
            for (var k = from; k < to; k++)
            {
                rig.Sonarr.History.Add(FakeArr.HistoryRow(2 * k + 1, "grabbed", t0.AddMinutes(k), "dl" + k, 200, "Show", k / 100 + 1, k % 100 + 1));
                rig.Sonarr.History.Add(FakeArr.HistoryRow(2 * k + 2, "downloadFolderImported", t0.AddMinutes(k).AddSeconds(30), null, 200, "Show", k / 100 + 1, k % 100 + 1));
            }
        }
        Episodes(0, 500);
        await rig.Controller(admin: true).GetDownloadHistory();
        Assert.Equal(1000, rig.Store.PeekHistory(rig.Arr.Instance("TV").Id)!.Records.Count);
        Episodes(500, 1000);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(10);
        await Task.WhenAll(rig.Store.Tick());
        Assert.Equal(2000, rig.Store.PeekHistory(rig.Arr.Instance("TV").Id)!.Records.Count);

        string Page(IActionResult result) => string.Join(";", Json(result).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("subtitle").GetString()));
        var asKid = rig.Controller(admin: false, audience: audience);
        asKid.HttpContext.User = TestCallers.Principal(kidId, admin: false);
        jf.Queries = 0;
        var kidFirst = await asKid.GetDownloadHistory(take: 50);
        // The window's 200 newest imports (four pages), as an administrator sees them ...
        Assert.Equal(4, Json(kidFirst).GetProperty("totalPages").GetInt32());
        Assert.Equal(Page(await rig.Controller(admin: true).GetDownloadHistory(take: 50)), Page(kidFirst));
        Assert.Equal(Page(await rig.Controller(admin: true).GetDownloadHistory(take: 50, skip: 150)), Page(await asKid.GetDownloadHistory(take: 50, skip: 150)));
        // ... decided with a handful of queries (the series, its copies, the episodes of the two or
        // three seasons the window reaches), not several per episode of the ring.
        Assert.InRange(jf.Queries, 1, 12);
    }

    [Fact]
    public async Task ASeasonPackAtTheEdgeOfTheHistoryWindowKeepsItsOlderEpisodes()
    {
        // 199 single imports, then a five-episode pack whose newest import is the window's 200th
        // item and whose other four are older than 200 more single imports.
        var jf = new AudienceLibrary();
        using var rig = new Rig();
        var callers = new TestCallers();
        var kidId = Guid.NewGuid();
        callers.Register(kidId, admin: false).MaxParentalRatingScore = 10;
        var audience = new ArrFeedAudience(jf.Library.Object, callers.Users.Object, rig.Store, null, new FakeJellyfinView(), null);
        var t = rig.Arr.Now.UtcDateTime.AddHours(-1);
        var id = 0;
        for (var i = 1; i <= 199; i++) rig.Sonarr.History.Add(FakeArr.HistoryRow(++id, "downloadFolderImported", t.AddSeconds(-10 * i), null, 200, "Show", 1, i));
        rig.Sonarr.History.Add(FakeArr.HistoryRow(++id, "downloadFolderImported", t.AddSeconds(-1995), "pack", 200, "Show", 2, 1));
        for (var i = 0; i < 200; i++) rig.Sonarr.History.Add(FakeArr.HistoryRow(++id, "downloadFolderImported", t.AddSeconds(-3000 - i), null, 200, "Show", 3, i % 100 + 1));
        for (var e = 2; e <= 5; e++) rig.Sonarr.History.Add(FakeArr.HistoryRow(++id, "downloadFolderImported", t.AddHours(-5).AddSeconds(e), "pack", 200, "Show", 2, e));

        var asKid = rig.Controller(admin: false, audience: audience);
        asKid.HttpContext.User = TestCallers.Principal(kidId, admin: false);
        var kid = Json(await asKid.GetDownloadHistory(take: 50, skip: 150)).GetProperty("items").EnumerateArray().ToList();
        var pack = Assert.Single(kid, i => i.TryGetProperty("episodeCount", out var n) && n.ValueKind == JsonValueKind.Number && n.GetInt32() > 1);
        Assert.Equal((5, "S02 · E01-E05"), (pack.GetProperty("episodeCount").GetInt32(), pack.GetProperty("subtitle").GetString()));
        var admin = Json(await rig.Controller(admin: true).GetDownloadHistory(take: 50, skip: 150)).GetProperty("items").EnumerateArray().Select(i => i.GetRawText());
        Assert.Equal(admin, kid.Select(i => i.GetRawText()));
    }
}
