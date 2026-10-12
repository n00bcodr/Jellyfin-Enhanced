using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
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
    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
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

        public JellyfinEnhancedController Controller(bool admin)
        {
            var c = ApiAssetTests.Controller(Arr.Plugin.Core, Arr.Transport, Store, Arr.Factory);
            c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return c;
        }

        public void Dispose() => Arr.Dispose();
    }

    private static JsonElement Json(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value);

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
        Assert.Equal(new[] { "3" }, listed.Select(i => i.Id));
        Assert.True(listed[0].DateOnly);
        Assert.DoesNotContain("dateOnly", JsonSerializer.Serialize(ArrLegacyViews.CalendarItems(sonarr, episodes, start.AddHours(-6), end, null, null).Single(i => i.Id == "2")));
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
        var users = new Mock<IUserManager>();
        ArrStateController Make(bool admin)
        {
            var c = new ArrStateController(rig.Store, users.Object);
            c.ControllerContext = new ControllerContext { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext() };
            c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return c;
        }

        Assert.IsType<ForbidResult>(Make(false).GetState());
        Assert.IsType<ForbidResult>(Make(false).RequestRefresh(rig.Arr.Instance("Movies").Id, "library"));
        var state = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(Make(true).GetState()).Value);
        Assert.Contains("\"Records\":1", state);
        Assert.DoesNotContain("KEY-0123456789", state);
        Assert.IsType<BadRequestObjectResult>(Make(true).RequestRefresh(rig.Arr.Instance("Movies").Id, "everything"));
        Assert.IsType<NotFoundObjectResult>(Make(true).RequestRefresh("nope", "library"));
        Assert.IsType<AcceptedResult>(Make(true).RequestRefresh(rig.Arr.Instance("Movies").Id, "Queue"));
    }
}
