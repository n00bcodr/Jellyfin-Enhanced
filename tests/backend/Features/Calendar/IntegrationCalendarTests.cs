using Jellyfin.Data;
using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Calendar;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests.Features.Calendar;

[Collection("Plugin singleton")]
public class IntegrationCalendarTests
{
    internal sealed class CalendarDatabase : IDbContextFactory<JellyfinDbContext>
    {
        private readonly DbContextOptions<JellyfinDbContext> options = new DbContextOptionsBuilder<JellyfinDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        public JellyfinDbContext CreateDbContext()
        {
            var locking = new Mock<IEntityFrameworkCoreLockingBehavior>();
            locking.Setup(l => l.OnSaveChanges(It.IsAny<JellyfinDbContext>(), It.IsAny<Action>())).Callback<JellyfinDbContext, Action>((_, save) => save());
            return new JellyfinDbContext(options, NullLogger<JellyfinDbContext>.Instance, Mock.Of<IJellyfinDatabaseProvider>(), locking.Object);
        }
        public Task<JellyfinDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(CreateDbContext());
    }
    // Without a parental filter of its own, a test gets one that finds no limit on its users.
    private static JeCalendarController Calendar(CoreFixture core, params object[] services)
        => (JeCalendarController)ApiAssetTests.Controller(typeof(JeCalendarController), core, services.OfType<Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental.SeerrParentalFilter>().Any() ? services
            : [.. services, new Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental.SeerrParentalFilter(Mock.Of<IHttpClientFactory>(), services.OfType<IUserManager>().FirstOrDefault() ?? Mock.Of<IUserManager>(),
                Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(), core.Logger)]);
    private static (List<ArrItem> Events, JsonElement Errors) Unpack(IActionResult result)
    {
        var root = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value);
        return (JsonSerializer.Deserialize<List<ArrItem>>(root.GetProperty("events"))!, root.GetProperty("errors"));
    }
    private static void Configure(ApiPluginFixture f)
    {
        f.Plugin.Configuration.ShokoUrl = "http://127.0.0.1/shoko";
        f.Plugin.Configuration.ShokoApiKey = "shoko-secret";
        f.Plugin.Configuration.CalendarFilterByLibraryAccess = false;
        f.Plugin.Configuration.CalendarPageEnabled = true;
    }
    private static string Episode(string type, int number, int id) => JsonSerializer.Serialize(new { Type = type, AirDate = "2026-10-10T12:00:00Z", SeriesTitle = "Same anime", Title = "Episode " + number, Number = number, IDs = new { ShokoSeries = 7, ShokoEpisode = id } });

    [Theory]
    [InlineData("Episode")][InlineData("Special")][InlineData("Credits")][InlineData("Trailer")][InlineData("Parody")][InlineData("Other")]
    public async Task EachEpisodeTypeToggleIncludesOnlyItsTypeAndExcludesRestrictedUpstreamEntries(string type)
    {
        using var f = new ApiPluginFixture(); Configure(f);
        var c = f.Plugin.Configuration;
        c.ShokoShowEpisodes = type == "Episode"; c.ShokoShowSpecials = type == "Special";
        c.ShokoShowCredits = type == "Credits"; c.ShokoShowTrailers = type == "Trailer";
        c.ShokoShowParodies = type == "Parody"; c.ShokoShowOther = type == "Other";
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Equal("shoko-secret", Assert.Single(request.Headers.GetValues("apikey")));
            Assert.False(request.Headers.Contains("X-Api-Key"));
            Assert.Contains("includeMissing=false&includeRestricted=false", request.RequestUri!.Query);
            Assert.Contains("startDate=2026-10-01&endDate=2026-11-01", request.RequestUri.Query);
            return Task.FromResult(IntegrationTransport.Response("[" + string.Join(",", new[] { "Episode", "Special", "Credits", "Trailer", "Parody", "Other" }.Select((t, i) => Episode(t, i, i + 1))) + "]"));
        });
        var controller = Calendar(f.Core, transport, new CalendarDatabase());
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(type, Assert.Single(result.Events).Subtitle!.Split(' ')[0]);
        Assert.Equal(0, result.Errors.GetArrayLength());
        Assert.Null(result.Events[0].ItemId);
        Assert.Null(result.Events[0].PosterUrl);
    }

    [Theory]
    [InlineData(401, "{}", "authentication failed")]
    [InlineData(500, "{}", "HTTP 500")]
    [InlineData(200, "{", "invalid response")]
    public async Task BrokenShokoPreservesOtherProviderEvents(int status, string body, string error)
    {
        using var f = new ApiPluginFixture(); Configure(f);
        f.Plugin.Configuration.SonarrUrl = "http://127.0.0.1/sonarr";
        f.Plugin.Configuration.SonarrApiKey = "arr-secret";
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.Contains("/shoko/") ? IntegrationTransport.Response(body, status) : IntegrationTransport.Response("[{\"airDateUtc\":\"2026-10-10\",\"title\":\"Episode\",\"series\":{\"title\":\"Unaffected series\"}}]")));
        var controller = Calendar(f.Core, transport);
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal("Sonarr", Assert.Single(result.Events).Source);
        Assert.Equal("Shoko", result.Errors[0].GetProperty("source").GetString());
        Assert.Contains(error, result.Errors[0].GetProperty("reason").GetString());
    }

    [Fact]
    public async Task ShokofinMappingResolvesSeriesAndEpisodeAndRetainsSonarrDuplicate()
    {
        using var f = new ApiPluginFixture(); Configure(f);
        f.Plugin.Configuration.SonarrUrl = "http://127.0.0.1/sonarr";
        f.Plugin.Configuration.SonarrApiKey = "arr-secret";
        var database = new CalendarDatabase();
        var seriesId = Guid.NewGuid(); var episodeId = Guid.NewGuid();
        using (var db = database.CreateDbContext())
        {
            db.BaseItemProviders.AddRange(new BaseItemProvider { Item = null!, ItemId = seriesId, ProviderId = "Shoko Series", ProviderValue = "7" }, new BaseItemProvider { Item = null!, ItemId = episodeId, ProviderId = "Shoko Episode", ProviderValue = "42" });
            db.SaveChanges();
        }
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(request.RequestUri!.AbsolutePath.Contains("/shoko/") ? "[" + Episode("Episode", 1, 42) + "]" : "[{\"airDateUtc\":\"2026-10-10T12:00:00Z\",\"title\":\"Episode 1\",\"episodeNumber\":1,\"series\":{\"title\":\"Same anime\"}}]")));
        var controller = Calendar(f.Core, transport, database);
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(2, result.Events.Count);
        var shoko = Assert.Single(result.Events, e => e.Source == "Shoko");
        Assert.Equal(seriesId, shoko.ItemId);
        Assert.Equal(episodeId, shoko.ItemEpisodeId);
        Assert.Single(result.Events, e => e.Source == "Sonarr");
    }

    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task LibraryAccessFilterHidesMappedAnimeFromRestrictedUser(bool allowed)
    {
        using var f = new ApiPluginFixture(); Configure(f);
        f.Plugin.Configuration.CalendarFilterByLibraryAccess = true;
        var database = new CalendarDatabase();
        var seriesId = Guid.NewGuid();
        using (var db = database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = seriesId, ProviderId = "Shoko Series", ProviderValue = "7" });
            db.SaveChanges();
        }
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById<BaseItem>(seriesId, user)).Returns(allowed ? new MediaBrowser.Controller.Entities.TV.Series { Id = seriesId } : null);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("[" + Episode("Episode", 1, 42) + "]")));
        var controller = Calendar(f.Core, transport, database, users.Object, library.Object);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.Id.ToString())], "test"));
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(allowed ? 1 : 0, result.Events.Count);
    }

    [Fact]
    public async Task ThreeSourcesMergeAndMalformedDatesAreSkipped()
    {
        using var f = new ApiPluginFixture(); Configure(f);
        f.Plugin.Configuration.SonarrUrl = "http://127.0.0.1/sonarr";
        f.Plugin.Configuration.SonarrApiKey = "arr-secret";
        f.Plugin.Configuration.RadarrUrl = "http://127.0.0.1/radarr";
        f.Plugin.Configuration.RadarrApiKey = "arr-secret";
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath.Contains("/shoko/") ? "[" + Episode("Episode", 1, 42) + ",{\"Type\":\"Episode\",\"AirDate\":\"invalid\"}]" :
            request.RequestUri.AbsolutePath.Contains("/radarr/") ? "[{\"id\":1,\"title\":\"Movie\",\"digitalRelease\":\"2026-10-10\"}]" :
            "[{\"airDateUtc\":\"2026-10-10\",\"series\":{\"title\":\"TV\"}}]")));
        var controller = Calendar(f.Core, transport, new CalendarDatabase());
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(new[] { "Radarr", "Shoko", "Sonarr" }, result.Events.Select(e => e.Source).OrderBy(x => x));
        Assert.Equal(0, result.Errors.GetArrayLength());
        Assert.Equal(3, transport.Calls);
    }

    [Fact]
    public async Task RangeIsParsedAndSentAsGregorianDatesUnderNonGregorianCulture()
    {
        using var f = new ApiPluginFixture(); Configure(f);
        f.Plugin.Configuration.SonarrUrl = "http://127.0.0.1/sonarr";
        f.Plugin.Configuration.SonarrApiKey = "arr-secret";
        f.Plugin.Configuration.RadarrUrl = "http://127.0.0.1/radarr";
        f.Plugin.Configuration.RadarrApiKey = "arr-secret";
        var queries = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            lock (queries) queries.Add(request.RequestUri!.AbsolutePath + request.RequestUri.Query);
            return Task.FromResult(IntegrationTransport.Response(
                request.RequestUri!.AbsolutePath.Contains("/shoko/") ? "[" + Episode("Episode", 1, 42) + "]" :
                request.RequestUri.AbsolutePath.Contains("/radarr/") ? "[{\"id\":1,\"title\":\"Movie\",\"digitalRelease\":\"2026-10-10\"}]" :
                "[{\"airDateUtc\":\"2026-10-10\",\"series\":{\"title\":\"TV\"}}]"));
        });
        var old = CultureInfo.CurrentCulture;
        try
        {
            // th-TH uses the Buddhist calendar: culture-sensitive parsing reads 2026 as a Buddhist year.
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("th-TH");
            var controller = Calendar(f.Core, transport, new CalendarDatabase());
            controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
            var result = Unpack(await controller.GetCalendarEvents());
            Assert.Equal(new[] { "Radarr", "Shoko", "Sonarr" }, result.Events.Select(e => e.Source).OrderBy(x => x));
            Assert.Equal(0, result.Errors.GetArrayLength());
        }
        finally { CultureInfo.CurrentCulture = old; }
        Assert.Contains(queries, q => q.Contains("/shoko/") && q.Contains("startDate=2026-10-01&endDate=2026-11-01"));
        Assert.Contains(queries, q => q.Contains("/sonarr/") && q.Contains("start=2026-10-01T00"));
    }

    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task PartialConfigurationReturnsErrorWithoutSendingRequest(bool urlOnly)
    {
        using var f = new ApiPluginFixture(); Configure(f);
        if (urlOnly) f.Plugin.Configuration.ShokoApiKey = ""; else f.Plugin.Configuration.ShokoUrl = "";
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Must not fetch partial configuration"));
        var result = Unpack(await Calendar(f.Core, transport).GetCalendarEvents());
        Assert.Empty(result.Events);
        Assert.Equal(1, result.Errors.GetArrayLength());
        Assert.Equal(0, transport.Calls);
    }

    // Two upcoming movies, neither in the library yet, from one Radarr root folder; Seerr answers the
    // caller's own requests (TMDB 2 only) and each title's certification (1 is R, 2 is PG).
    private sealed class UpcomingMovies : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public User Caller { get; } = new("viewer", "default", "default") { Id = Guid.NewGuid() };
        public bool SeerrFails { get; set; }
        public IntegrationTransport Transport { get; }
        public UpcomingMovies()
        {
            Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches.ClearAllSeerrCachesOnConfigChange();
            var c = F.Plugin.Configuration;
            c.CalendarPageEnabled = true;
            c.CalendarFilterByLibraryAccess = false;
            c.RadarrUrl = "http://127.0.0.1/radarr";
            c.RadarrApiKey = "arr-secret";
            c.JellyseerrEnabled = true;
            c.JellyseerrAutoImportUsers = false;
            c.JellyseerrUrls = "http://127.0.0.1/seerr";
            c.JellyseerrApiKey = "seerr-secret";
            Transport = new IntegrationTransport((request, _) =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path.StartsWith("/radarr/"))
                    return Task.FromResult(IntegrationTransport.Response("[{\"id\":1,\"title\":\"Rated R\",\"tmdbId\":1,\"digitalRelease\":\"2026-10-10\",\"path\":\"/movies/Rated R\"},"
                        + "{\"id\":2,\"title\":\"Rated PG\",\"tmdbId\":2,\"digitalRelease\":\"2026-10-11\",\"path\":\"/movies/Rated PG\"}]"));
                if (SeerrFails) return Task.FromResult(IntegrationTransport.Response("{}", 500));
                if (path == "/seerr/api/v1/user")
                    return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = Caller.Id.ToString("N"), permissions = 32 } } })));
                if (path == "/seerr/api/v1/request")
                {
                    Assert.Contains("requestedBy=27", request.RequestUri.Query);
                    return Task.FromResult(IntegrationTransport.Response("{\"pageInfo\":{\"pages\":1,\"results\":1},\"results\":[{\"type\":\"movie\",\"media\":{\"tmdbId\":2,\"mediaType\":\"movie\"},\"requestedBy\":{\"id\":27}}]}"));
                }
                var cert = path.EndsWith("/movie/1") ? "R" : "PG";
                return Task.FromResult(IntegrationTransport.Response("{\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"type\":3,\"certification\":\"" + cert + "\"}]}]}}"));
            });
        }
        public async Task<IActionResult> Get(bool admin = false)
        {
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(Caller.Id)).Returns(Caller);
            var localization = new Mock<MediaBrowser.Model.Globalization.ILocalizationManager>();
            localization.Setup(l => l.GetRatingScore("R", It.IsAny<string>())).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(17, null));
            localization.Setup(l => l.GetRatingScore("PG", It.IsAny<string>())).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(10, null));
            var serverConfig = new Mock<MediaBrowser.Controller.Configuration.IServerConfigurationManager>();
            serverConfig.Setup(s => s.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration { MetadataCountryCode = "US" });
            var parental = new Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental.SeerrParentalFilter(Transport, users.Object, localization.Object, serverConfig.Object, F.Core.Logger);
            var controller = Calendar(F.Core, Transport, new CalendarDatabase(), users.Object, new Mock<ILibraryManager>().Object, parental);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", Caller.Id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
            return await controller.GetCalendarEvents();
        }
        public static List<int?> TmdbIds(IActionResult result) => Unpack(result).Events.Select(e => e.TmdbId).Order().ToList();
        public void Dispose() { Transport.Dispose(); Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches.ClearAllSeerrCachesOnConfigChange(); F.Dispose(); }
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task CalendarPageOffAnswersOnlyAdministrators(bool admin)
    {
        using var m = new UpcomingMovies();
        m.F.Plugin.Configuration.CalendarPageEnabled = false;
        var result = await m.Get(admin);
        if (admin) Assert.Equal(new int?[] { 1, 2 }, UpcomingMovies.TmdbIds(result));
        else Assert.IsType<NotFoundResult>(result);
    }

    [Theory]
    [InlineData(false, false, false)][InlineData(true, false, true)][InlineData(false, true, true)]
    public async Task UpcomingTitleFromAnUnknownRootFolderIsShownOnlyToCallersWhoSeeEveryLibrary(bool allFolders, bool admin, bool shown)
    {
        using var m = new UpcomingMovies();
        m.F.Plugin.Configuration.CalendarFilterByLibraryAccess = true;
        m.Caller.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, allFolders);
        m.Caller.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator, admin);
        Assert.Equal(shown ? new int?[] { 1, 2 } : Array.Empty<int?>(), UpcomingMovies.TmdbIds(await m.Get(admin)));
    }

    [Theory]
    [InlineData(false, false)][InlineData(true, false)][InlineData(false, true)]
    public async Task ParentalLimitHidesUpcomingTitlesAboveItAndTitlesThatCannotBeChecked(bool seerrFails, bool admin)
    {
        using var m = new UpcomingMovies { SeerrFails = seerrFails };
        m.Caller.MaxParentalRatingScore = 10;
        m.Caller.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator, admin);
        var expected = admin ? new int?[] { 1, 2 } : seerrFails ? Array.Empty<int?>() : new int?[] { 2 };
        Assert.Equal(expected, UpcomingMovies.TmdbIds(await m.Get(admin)));
    }

    [Theory]
    [InlineData(false, false)][InlineData(true, false)][InlineData(false, true)]
    public async Task ForceOnlyRequestedLeavesNonAdministratorsOnlyTheirOwnRequests(bool seerrFails, bool admin)
    {
        using var m = new UpcomingMovies { SeerrFails = seerrFails };
        m.F.Plugin.Configuration.CalendarForceOnlyRequested = true;
        var result = await m.Get(admin);
        var expected = admin ? new int?[] { 1, 2 } : seerrFails ? Array.Empty<int?>() : new int?[] { 2 };
        Assert.Equal(expected, UpcomingMovies.TmdbIds(result));
        // A failed lookup is reported, not shown as "nothing requested".
        Assert.Equal(seerrFails && !admin ? 1 : 0, Unpack(result).Errors.GetArrayLength());
    }
}
