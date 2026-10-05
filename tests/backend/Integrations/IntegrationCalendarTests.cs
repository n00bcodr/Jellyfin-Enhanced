using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
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
    private sealed class CalendarDatabase : IDbContextFactory<JellyfinDbContext>
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
        var controller = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase());
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
        var controller = ApiAssetTests.Controller(f.Core, transport);
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
        var controller = ApiAssetTests.Controller(f.Core, transport, database);
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
        var controller = ApiAssetTests.Controller(f.Core, transport, database, users.Object, library.Object);
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
        var controller = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase());
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        var result = Unpack(await controller.GetCalendarEvents());
        Assert.Equal(new[] { "Radarr", "Shoko", "Sonarr" }, result.Events.Select(e => e.Source).OrderBy(x => x));
        Assert.Equal(0, result.Errors.GetArrayLength());
        Assert.Equal(3, transport.Calls);
    }

    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task PartialConfigurationReturnsErrorWithoutSendingRequest(bool urlOnly)
    {
        using var f = new ApiPluginFixture(); Configure(f);
        if (urlOnly) f.Plugin.Configuration.ShokoApiKey = ""; else f.Plugin.Configuration.ShokoUrl = "";
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Must not fetch partial configuration"));
        var result = Unpack(await ApiAssetTests.Controller(f.Core, transport).GetCalendarEvents());
        Assert.Empty(result.Events);
        Assert.Equal(1, result.Errors.GetArrayLength());
        Assert.Equal(0, transport.Calls);
    }
}
