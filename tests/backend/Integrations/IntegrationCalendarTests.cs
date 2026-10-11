using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
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
            var controller = ApiAssetTests.Controller(f.Core, transport, new CalendarDatabase());
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
        var result = Unpack(await ApiAssetTests.Controller(f.Core, transport).GetCalendarEvents());
        Assert.Empty(result.Events);
        Assert.Equal(1, result.Errors.GetArrayLength());
        Assert.Equal(0, transport.Calls);
    }

    // CalendarForceOnlyRequested (design A6): enforced by GET arr/calendar for every caller,
    // from the caller's own Seerr requests, whatever the query string says.
    private sealed class RequestedOnly : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Guid ViewerId { get; } = Guid.NewGuid();
        public Guid AdminId { get; } = Guid.NewGuid();
        public Guid UnlinkedId { get; } = Guid.NewGuid();
        public System.Collections.Concurrent.ConcurrentQueue<string> SeerrCalls { get; } = new();
        // Seerr /api/v1/request reply by host + query (requestedBy/skip); null = default lists below.
        public Func<string, string, HttpResponseMessage?> RequestReply { get; set; } = (_, _) => null;
        public IntegrationTransport Transport { get; }
        public Mock<IUserManager> Users { get; } = new();
        public SeerrParentalFilter ParentalFilter { get; }
        public RequestedOnly()
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
            Configure(Plugin);
            var c = Plugin.Plugin.Configuration;
            c.SonarrUrl = "http://127.0.0.1/sonarr"; c.SonarrApiKey = "arr-secret";
            c.RadarrUrl = "http://127.0.0.1/radarr"; c.RadarrApiKey = "arr-secret";
            c.JellyseerrEnabled = true;
            c.JellyseerrAutoImportUsers = false;
            c.JellyseerrUrls = "http://seerr.invalid";
            c.JellyseerrApiKey = "seerr-secret";
            c.CalendarForceOnlyRequested = true;
            Transport = new IntegrationTransport((request, _) =>
            {
                var uri = request.RequestUri!;
                if (uri.AbsolutePath.StartsWith("/api/v1/"))
                {
                    SeerrCalls.Enqueue(uri.Host + uri.PathAndQuery);
                    Assert.Equal("seerr-secret", Assert.Single(request.Headers.GetValues("X-Api-Key")));
                }
                if (uri.AbsolutePath == "/api/v1/user") return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] {
                    new { id = 27, jellyfinUserId = ViewerId.ToString("N"), permissions = 32 },
                    new { id = 38, jellyfinUserId = AdminId.ToString("N"), permissions = 2 } } })));
                if (uri.AbsolutePath == "/api/v1/request")
                {
                    var custom = RequestReply(uri.Host, uri.Query);
                    if (custom != null) return Task.FromResult(custom);
                    var mine = uri.Query.Contains("requestedBy=27") ? new[] { ("movie", 100), ("tv", 200) }
                        : uri.Query.Contains("requestedBy=38") ? new[] { ("movie", 101) } : [];
                    return Task.FromResult(IntegrationTransport.Response(SeerrRequests(mine, mine.Length)));
                }
                // Title details for the parental filter: no certification, i.e. unrated.
                if (uri.AbsolutePath.StartsWith("/api/v1/movie/") || uri.AbsolutePath.StartsWith("/api/v1/tv/")) return Task.FromResult(IntegrationTransport.Response("{}"));
                if (uri.AbsolutePath.Contains("/shoko/")) return Task.FromResult(IntegrationTransport.Response("[" + Episode("Episode", 1, 42) + "]"));
                if (uri.AbsolutePath.Contains("/radarr/")) return Task.FromResult(IntegrationTransport.Response(
                    "[" + string.Join(",", new[] { 100, 101, 300 }.Select(id => $"{{\"id\":{id},\"title\":\"Movie {id}\",\"tmdbId\":{id},\"digitalRelease\":\"2026-10-10\"}}")) + "]"));
                // Series 100 shares a TMDB id with the requested movie 100: a type mismatch, never a match.
                return Task.FromResult(IntegrationTransport.Response(
                    "[" + string.Join(",", new[] { 200, 201, 100 }.Select(id => $"{{\"id\":{id},\"airDateUtc\":\"2026-10-10\",\"title\":\"Episode\",\"series\":{{\"title\":\"Series {id}\",\"tmdbId\":{id}}}}}")) + "]"));
            });
            var server = new Mock<IServerConfigurationManager>();
            server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration());
            ParentalFilter = new SeerrParentalFilter(Transport, Users.Object, Mock.Of<ILocalizationManager>(), server.Object, Plugin.Core.Logger);
        }
        public static string SeerrRequests(IEnumerable<(string Type, int TmdbId)> rows, int total) => JsonSerializer.Serialize(new
        {
            pageInfo = new { pages = 1, pageSize = 500, results = total, page = 1 },
            results = rows.Select(r => new { type = r.Type, media = new { tmdbId = r.TmdbId } }),
        });
        public async Task<(List<ArrItem> Events, JsonElement Errors)> Get(Guid? user, bool admin = false, string query = "?start=2026-10-01&end=2026-11-01")
        {
            var controller = ApiAssetTests.Controller(Plugin.Core, Transport, new CalendarDatabase(), Users.Object, ParentalFilter);
            controller.Request.QueryString = new QueryString(query);
            controller.HttpContext.User = user == null ? new ClaimsPrincipal(new ClaimsIdentity()) : new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", user.Value.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return Unpack(await controller.GetCalendarEvents());
        }
        public void Dispose() { Transport.Dispose(); JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange(); Plugin.Dispose(); }
    }
    private static string[] Keys(List<ArrItem> events) => events.Select(e => e.Source + ":" + (e.TmdbId?.ToString(CultureInfo.InvariantCulture) ?? "-")).OrderBy(k => k, StringComparer.Ordinal).ToArray();

    [Theory]
    [InlineData("?start=2026-10-01&end=2026-11-01")]
    [InlineData("?start=2026-10-01&end=2026-11-01&forceOnlyRequested=false&onlyRequested=false&requestedBy=38&userOnly=false")]
    public async Task ForceOnlyRequestedReturnsOnlyTheNonAdminCallersRequestsWhateverTheQuery(string query)
    {
        using var f = new RequestedOnly();
        var result = await f.Get(f.ViewerId, query: query);
        Assert.Equal(new[] { "Radarr:100", "Sonarr:200" }, Keys(result.Events));
        Assert.Equal("Series", Assert.Single(result.Events, e => e.Source == "Sonarr").Type);
        Assert.Equal(0, result.Errors.GetArrayLength());
        var requestCall = Assert.Single(f.SeerrCalls, c => c.Contains("/api/v1/request?"));
        Assert.Contains("requestedBy=27", requestCall);
        Assert.DoesNotContain("requestedBy=38", requestCall);
    }

    [Fact]
    public async Task ForceOnlyRequestedOffReturnsEveryEventWithoutAskingSeerr()
    {
        using var f = new RequestedOnly();
        f.Plugin.Plugin.Configuration.CalendarForceOnlyRequested = false;
        var result = await f.Get(f.ViewerId);
        Assert.Equal(new[] { "Radarr:100", "Radarr:101", "Radarr:300", "Shoko:-", "Sonarr:100", "Sonarr:200", "Sonarr:201" }, Keys(result.Events));
        Assert.Empty(f.SeerrCalls);
    }

    [Fact]
    public async Task ForceOnlyRequestedAppliesToAdminsWithTheirOwnRequests()
    {
        using var f = new RequestedOnly();
        var result = await f.Get(f.AdminId, admin: true);
        Assert.Equal(new[] { "Radarr:101" }, Keys(result.Events));
        Assert.Contains(f.SeerrCalls, c => c.Contains("/api/v1/request?") && c.Contains("requestedBy=38"));
    }

    [Theory]
    [InlineData("seerr-disabled")]
    [InlineData("seerr-unconfigured")]
    [InlineData("unlinked-user")]
    [InlineData("no-identity")]
    [InlineData("seerr-error")]
    [InlineData("seerr-html")]
    public async Task ForceOnlyRequestedFailsClosedWhenMembershipCannotBeRead(string scenario)
    {
        using var f = new RequestedOnly();
        var c = f.Plugin.Plugin.Configuration;
        Guid? user = f.ViewerId;
        switch (scenario)
        {
            case "seerr-disabled": c.JellyseerrEnabled = false; break;
            case "seerr-unconfigured": c.JellyseerrApiKey = ""; break;
            case "unlinked-user": user = f.UnlinkedId; break;
            case "no-identity": user = null; break;
            case "seerr-error": f.RequestReply = (_, _) => IntegrationTransport.Response("{\"message\":\"boom\"}", 500); break;
            case "seerr-html": f.RequestReply = (_, _) => IntegrationTransport.Response("<html></html>", 200, "text/html"); break;
        }
        var result = await f.Get(user);
        Assert.Empty(result.Events);
        // Arr errors are reported as before; a Seerr problem adds none (the page never toasted it).
        Assert.Equal(0, result.Errors.GetArrayLength());
        if (scenario is "seerr-disabled" or "seerr-unconfigured" or "no-identity")
            Assert.Empty(f.SeerrCalls);
    }

    [Fact]
    public async Task ForceOnlyRequestedReadsEveryPageOfTheCallersRequests()
    {
        using var f = new RequestedOnly();
        f.RequestReply = (_, query) => query.Contains("skip=0")
            ? IntegrationTransport.Response(RequestedOnly.SeerrRequests(Enumerable.Range(1000, 500).Select(id => ("movie", id)), 501))
            : query.Contains("skip=500") ? IntegrationTransport.Response(RequestedOnly.SeerrRequests(new[] { ("tv", 200) }, 501))
            : IntegrationTransport.Response("{}", 500);
        var result = await f.Get(f.ViewerId);
        Assert.Equal(new[] { "Sonarr:200" }, Keys(result.Events));
        Assert.Equal(2, f.SeerrCalls.Count(c => c.Contains("/api/v1/request?")));
    }

    [Fact]
    public async Task ForceOnlyRequestedFallsBackToTheNextSeerrUrl()
    {
        using var f = new RequestedOnly();
        f.Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-a.invalid\nhttp://seerr-b.invalid";
        f.RequestReply = (host, _) => host == "seerr-a.invalid" ? IntegrationTransport.Response("{}", 502) : null;
        var result = await f.Get(f.ViewerId);
        Assert.Equal(new[] { "Radarr:100", "Sonarr:200" }, Keys(result.Events));
        Assert.Contains(f.SeerrCalls, c => c.StartsWith("seerr-b.invalid/api/v1/request?"));
    }

    [Theory]
    [InlineData("dns")]
    [InlineData("timeout")]
    public async Task ForceOnlyRequestedFallsBackToTheNextSeerrUrlWhenTheFirstThrows(string failure)
    {
        using var f = new RequestedOnly();
        f.Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-a.invalid\nhttp://seerr-b.invalid";
        f.RequestReply = (host, _) => host != "seerr-a.invalid" ? null
            : failure == "dns" ? throw new HttpRequestException("Name or service not known")
            : throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout");
        var result = await f.Get(f.ViewerId);
        Assert.Equal(new[] { "Radarr:100", "Sonarr:200" }, Keys(result.Events));
        Assert.Contains(f.SeerrCalls, c => c.StartsWith("seerr-b.invalid/api/v1/request?"));
    }

    [Theory]
    [InlineData("throws")]
    [InlineData("malformed")]
    public async Task ForceOnlyRequestedKeepsTheEarlierPagesWhenALaterPageFails(string failure)
    {
        using var f = new RequestedOnly();
        f.RequestReply = (_, query) => query.Contains("skip=0")
            ? IntegrationTransport.Response(RequestedOnly.SeerrRequests(new[] { ("tv", 200) }.Concat(Enumerable.Range(1000, 499).Select(id => ("movie", id))), 501))
            : failure == "throws" ? throw new HttpRequestException("Connection reset")
            : IntegrationTransport.Response("{\"results\":", 200);
        var result = await f.Get(f.ViewerId);
        Assert.Equal(new[] { "Sonarr:200" }, Keys(result.Events));
    }

    [Fact]
    public async Task ForceOnlyRequestedSkipsMalformedRequestRows()
    {
        using var f = new RequestedOnly();
        f.RequestReply = (_, _) => IntegrationTransport.Response(
            "{\"pageInfo\":{\"results\":4},\"results\":[{\"type\":\"movie\",\"media\":null},{\"type\":{\"x\":1},\"media\":{\"tmdbId\":101}},{\"type\":\"movie\",\"media\":{\"tmdbId\":\"abc\"}},{\"type\":\"tv\",\"media\":{\"tmdbId\":200}}]}");
        var result = await f.Get(f.ViewerId);
        Assert.Equal(new[] { "Sonarr:200" }, Keys(result.Events));
    }

    [Fact]
    public async Task ForceOnlyRequestedAppliesTheCallersParentalLimitLikeThePage()
    {
        using var f = new RequestedOnly();
        // A rating-limited viewer: the page's arr/requests drops rows the parental filter refuses.
        f.Users.Setup(u => u.GetUserById(f.ViewerId)).Returns(new User("viewer", "default", "default") { Id = f.ViewerId, MaxParentalRatingScore = 10 });
        f.RequestReply = (_, _) => IntegrationTransport.Response(
            "{\"pageInfo\":{\"results\":2},\"results\":[{\"type\":\"movie\",\"media\":{\"tmdbId\":100,\"mediaType\":\"movie\",\"adult\":true}},{\"type\":\"tv\",\"media\":{\"tmdbId\":200,\"mediaType\":\"tv\"}}]}");
        var result = await f.Get(f.ViewerId);
        // Movie 100 is refused (adult); series 200 has no rating and unrated titles are allowed.
        Assert.Equal(new[] { "Sonarr:200" }, Keys(result.Events));
        Assert.Contains(f.SeerrCalls, c => c.StartsWith("seerr.invalid/api/v1/tv/200"));
    }

    [Theory]
    [InlineData("Movie", 5, "movie:5")]
    [InlineData("Series", 5, "tv:5")]
    [InlineData("Series", 0, null)]
    [InlineData("Series", null, null)]
    public void CalendarRequestKeyMatchesTheCalendarPage(string type, int? tmdbId, string? expected)
    {
        Assert.Equal(expected, JellyfinEnhancedController.CalendarRequestKey(new ArrItem { Type = type, TmdbId = tmdbId }));
    }
}
