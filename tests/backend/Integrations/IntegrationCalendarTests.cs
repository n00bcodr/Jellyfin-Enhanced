using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

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
    // Sonarr/Radarr rows (registry v2, keys in the secrets store) on 127.0.0.1/sonarr and /radarr.
    private static void Arrs(ApiPluginFixture f, bool sonarr = true, bool radarr = false)
    {
        var c = f.Plugin.Configuration;
        c.SonarrInstances = sonarr ? "[{\"Name\":\"Sonarr\",\"Url\":\"http://127.0.0.1/sonarr\",\"ApiKey\":\"arr-secret\"}]" : "[]";
        c.RadarrInstances = radarr ? "[{\"Name\":\"Radarr\",\"Url\":\"http://127.0.0.1/radarr\",\"ApiKey\":\"arr-secret\"}]" : "[]";
        SecretsMigration.MigrateStored(c, f.Plugin.Secrets);
    }
    // The arr state store over a test transport, with its clock in 2030 so the 2026 ranges these
    // tests ask for are outside its in-memory window and read for the exact days requested.
    private static ArrStateStore Store(IntegrationTransport transport)
        => new(new ArrClientFactory(transport, new ArrInstanceRegistry()), null, null, () => new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero), null);
    private static HttpResponseMessage Status(HttpRequestMessage request)
        => IntegrationTransport.Response(request.RequestUri!.AbsolutePath.Contains("/radarr/") ? "{\"appName\":\"Radarr\",\"version\":\"6.0.0\"}" : "{\"appName\":\"Sonarr\",\"version\":\"4.0.0\"}");
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
        using var store = Store(transport);
        var controller = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase(), store);
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
        Arrs(f);
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.Contains("/shoko/") ? IntegrationTransport.Response(body, status)
            : request.RequestUri.AbsolutePath.EndsWith("/system/status") ? Status(request)
            : IntegrationTransport.Response("[{\"airDateUtc\":\"2026-10-10\",\"title\":\"Episode\",\"series\":{\"title\":\"Unaffected series\"}}]")));
        using var store = Store(transport);
        var controller = ApiAssetTests.Controller(f.Core, transport, store);
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal("Sonarr", Assert.Single(result.Events).Source);
        Assert.Equal("Shoko", result.Errors[0].GetProperty("source").GetString());
        Assert.Contains(error, result.Errors[0].GetProperty("reason").GetString());
    }

    [Fact]
    public async Task ShokofinMappingResolvesSeriesAndEpisodeAndRetainsSonarrDuplicate()
    {
        using var f = new ApiPluginFixture(); Configure(f);
        Arrs(f);
        var database = new CalendarDatabase();
        var seriesId = Guid.NewGuid(); var episodeId = Guid.NewGuid();
        using (var db = database.CreateDbContext())
        {
            db.BaseItemProviders.AddRange(new BaseItemProvider { Item = null!, ItemId = seriesId, ProviderId = "Shoko Series", ProviderValue = "7" }, new BaseItemProvider { Item = null!, ItemId = episodeId, ProviderId = "Shoko Episode", ProviderValue = "42" });
            db.SaveChanges();
        }
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith("/system/status") ? Status(request) : IntegrationTransport.Response(request.RequestUri!.AbsolutePath.Contains("/shoko/") ? "[" + Episode("Episode", 1, 42) + "]" : "[{\"airDateUtc\":\"2026-10-10T12:00:00Z\",\"title\":\"Episode 1\",\"episodeNumber\":1,\"series\":{\"title\":\"Same anime\"}}]")));
        using var store = Store(transport);
        var controller = ApiAssetTests.Controller(f.Core, transport, database, store);
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
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
        using var store = Store(transport);
        var controller = ApiAssetTests.Controller(f.Core, transport, database, users.Object, library.Object, store);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.Id.ToString())], "test"));
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(allowed ? 1 : 0, result.Events.Count);
    }

    [Fact]
    public async Task ThreeSourcesMergeAndMalformedDatesAreSkipped()
    {
        using var f = new ApiPluginFixture(); Configure(f);
        Arrs(f, sonarr: true, radarr: true);
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith("/system/status") ? Status(request) : IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath.Contains("/shoko/") ? "[" + Episode("Episode", 1, 42) + ",{\"Type\":\"Episode\",\"AirDate\":\"invalid\"}]" :
            request.RequestUri.AbsolutePath.Contains("/radarr/") ? "[{\"id\":1,\"title\":\"Movie\",\"digitalRelease\":\"2026-10-10\"}]" :
            "[{\"airDateUtc\":\"2026-10-10\",\"series\":{\"title\":\"TV\"}}]")));
        using var store = Store(transport);
        var controller = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase(), store);
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(new[] { "Radarr", "Shoko", "Sonarr" }, result.Events.Select(e => e.Source).OrderBy(x => x));
        Assert.Equal(0, result.Errors.GetArrayLength());
        // Shoko once; each arr: status + calendar for the requested days.
        Assert.Equal(5, transport.Calls);
        var again = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase(), store);
        again.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        Assert.Equal(3, Unpack(await again.GetCalendarEvents()).Events.Count);
        Assert.Equal(6, transport.Calls);   // only Shoko again: the arr range is kept
    }

    [Fact]
    public async Task RangeIsParsedAndSentAsGregorianDatesUnderNonGregorianCulture()
    {
        using var f = new ApiPluginFixture(); Configure(f);
        Arrs(f, sonarr: true, radarr: true);
        var queries = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            lock (queries) queries.Add(request.RequestUri!.AbsolutePath + request.RequestUri.Query);
            if (request.RequestUri.AbsolutePath.EndsWith("/system/status")) return Task.FromResult(Status(request));
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
            using var store = Store(transport);
            var controller = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase(), store);
            controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
            var result = Unpack(await controller.GetCalendarEvents());
            Assert.Equal(new[] { "Radarr", "Shoko", "Sonarr" }, result.Events.Select(e => e.Source).OrderBy(x => x));
            Assert.Equal(0, result.Errors.GetArrayLength());
        }
        finally { CultureInfo.CurrentCulture = old; }
        Assert.Contains(queries, q => q.Contains("/shoko/") && q.Contains("startDate=2026-10-01&endDate=2026-11-01"));
        // Outside the in-memory window, the whole days of the range are read (Gregorian dates).
        Assert.Contains(queries, q => q.Contains("/sonarr/") && q.Contains("start=2026-10-01T00"));
    }

    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task PartialConfigurationReturnsErrorWithoutSendingRequest(bool urlOnly)
    {
        using var f = new ApiPluginFixture(); Configure(f);
        if (urlOnly) f.Plugin.Configuration.ShokoApiKey = ""; else f.Plugin.Configuration.ShokoUrl = "";
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Must not fetch partial configuration"));
        using var store = Store(transport);
        var result = Unpack(await ApiAssetTests.Controller(f.Core, transport, store).GetCalendarEvents());
        Assert.Empty(result.Events);
        Assert.Equal(1, result.Errors.GetArrayLength());
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task TheRouteIsRefusedWhenTheCalendarPageIsOff()
    {
        using var f = new ApiPluginFixture(); Configure(f); Arrs(f);
        f.Plugin.Configuration.CalendarPageEnabled = false;
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No requests allowed"));
        using var store = Store(transport);
        var controller = ApiAssetTests.Controller(f.Core, transport, store);
        var refused = Assert.IsType<ObjectResult>(await controller.GetCalendarEvents());
        Assert.Equal(403, refused.StatusCode);
        Assert.Contains("feature_disabled", JsonSerializer.Serialize(refused.Value));
        Assert.Equal(403, Assert.IsType<ObjectResult>(controller.GetCalendarUserDataForEvents(new Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController.CalendarUserDataRequest())).StatusCode);
        Assert.Equal(0, transport.Calls);
    }
}
