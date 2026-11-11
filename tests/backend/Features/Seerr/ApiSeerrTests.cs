using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Calendar;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Downloads;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Identity;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;

namespace JE.Tests.Features.Seerr;

[Collection("Plugin singleton")]
public class ApiSeerrTests
{
    internal sealed class SeerrFixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Guid UserId { get; } = Guid.NewGuid();
        public Guid OtherUserId { get; } = Guid.NewGuid();
        public JellyseerrPermission Permissions { get; set; } = JellyseerrPermission.REQUEST;
        public ConcurrentQueue<(string Path, string Method, string? User, string? Body)> Calls { get; } = new();
        public Func<HttpRequestMessage, HttpResponseMessage> Reply { get; set; } = _ => IntegrationTransport.Response("{\"id\":99}");
        public IntegrationTransport Transport { get; }
        public JeSeerrController Controller { get; }
        private readonly object[] services;
        public SeerrFixture(Func<SeerrFixture, IUserManager, object[]>? extraServices = null)
        {
            SeerrCaches.ClearAllSeerrCachesOnConfigChange();
            Plugin.Plugin.Configuration.JellyseerrEnabled = true;
            Plugin.Plugin.Configuration.JellyseerrAutoImportUsers = false;
            Plugin.Plugin.Configuration.JellyseerrUrls = "http://private-seerr.invalid";
            Plugin.Plugin.Configuration.JellyseerrApiKey = "test-secret";
            Plugin.Plugin.Configuration.SpoilerAutoEnableOnSeerrRequest = false;
            Transport = new IntegrationTransport(async (request, _) =>
            {
                var path = request.RequestUri!.PathAndQuery;
                var body = request.Content == null ? null : await request.Content.ReadAsStringAsync();
                var user = request.Headers.TryGetValues("X-Api-User", out var values) ? values.Single() : null;
                Calls.Enqueue((path, request.Method.Method, user, body));
                Assert.Equal("test-secret", Assert.Single(request.Headers.GetValues("X-Api-Key")));
                if (path.StartsWith("/api/v1/user?")) return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] {
                    new { id = 27, jellyfinUserId = UserId.ToString("N"), permissions = (int)Permissions },
                    new { id = 38, jellyfinUserId = OtherUserId.ToString("N"), permissions = (int)Permissions }
                } }));
                return Reply(request);
            });
            var users = Mock.Of<IUserManager>();
            var filter = new SeerrParentalFilter(Transport, users, Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), Plugin.Core.Logger);
            var services = new List<object> { Transport, users, filter };
            if (extraServices != null) services.AddRange(extraServices(this, users));
            this.services = services.ToArray();
            Controller = (JeSeerrController)ApiAssetTests.Controller(typeof(JeSeerrController), Plugin.Core, this.services);
            SetUser(UserId);
        }
        // The calendar actions live on JeCalendarController (restructure S2.5); same services, same HTTP context.
        public JeCalendarController Calendar()
        {
            var calendar = (JeCalendarController)ApiAssetTests.Controller(typeof(JeCalendarController), Plugin.Core, services);
            calendar.ControllerContext = Controller.ControllerContext;
            return calendar;
        }
        // The SpoilerGuard actions live on JeSpoilerGuardController (restructure S2.13); same services, same HTTP context.
        public JeSpoilerGuardController SpoilerGuard()
        {
            var spoiler = (JeSpoilerGuardController)ApiAssetTests.Controller(typeof(JeSpoilerGuardController), Plugin.Core, services);
            spoiler.ControllerContext = Controller.ControllerContext;
            return spoiler;
        }
        // The DetailsProviders actions live on JeDetailsProvidersController (restructure S2.12); same services, same HTTP context.
        public JeDetailsProvidersController DetailsProviders()
        {
            var details = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), Plugin.Core, services);
            details.ControllerContext = Controller.ControllerContext;
            return details;
        }
        // The Downloads actions live on JeDownloadsController (restructure S2.10); same services, same HTTP context.
        public JeDownloadsController Downloads()
        {
            var downloads = (JeDownloadsController)ApiAssetTests.Controller(typeof(JeDownloadsController), Plugin.Core, services);
            downloads.ControllerContext = Controller.ControllerContext;
            return downloads;
        }
        public void SetUser(Guid user, bool admin = false) => Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        public void Dispose() { Transport.Dispose(); SeerrCaches.ClearAllSeerrCachesOnConfigChange(); Plugin.Dispose(); }
    }
    private static JsonElement Body(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    [Theory]
    [InlineData(JellyseerrPermission.REQUEST, false, false)]
    [InlineData(JellyseerrPermission.REQUEST_MOVIE, false, false)]
    [InlineData(JellyseerrPermission.REQUEST_TV, false, false)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_ADVANCED, false, true)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.MANAGE_REQUESTS, false, true)]
    [InlineData(JellyseerrPermission.ADMIN, false, true)]
    [InlineData(JellyseerrPermission.NONE, true, true)]
    public async Task RequestsUsePrincipalIdentityPreserveSeasonSelectionAndGateAdvancedOptions(JellyseerrPermission permissions, bool jellyfinAdmin, bool advanced)
    {
        using var f = new SeerrFixture { Permissions = permissions };
        f.SetUser(f.UserId, jellyfinAdmin);
        f.Controller.Request.Headers["X-Api-User"] = "1";
        f.Controller.Request.Headers["X-Emby-UserId"] = f.OtherUserId.ToString();
        var result = await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"tv\",\"mediaId\":101,\"seasons\":[1,3],\"is4k\":false,\"serverId\":9,\"profileId\":8,\"rootFolder\":\"/media\",\"languageProfileId\":7,\"tags\":[6]}"));
        Assert.IsType<ContentResult>(result);
        var call = Assert.Single(f.Calls, c => c.Method == "POST");
        Assert.Equal("/api/v1/request", call.Path);
        Assert.Equal("27", call.User);
        using var request = JsonDocument.Parse(call.Body!);
        Assert.Equal(new[] { 1, 3 }, request.RootElement.GetProperty("seasons").EnumerateArray().Select(v => v.GetInt32()));
        Assert.Equal(101, request.RootElement.GetProperty("mediaId").GetInt32());
        foreach (var field in new[] { "serverId", "profileId", "rootFolder", "languageProfileId", "tags" })
            Assert.Equal(advanced, request.RootElement.TryGetProperty(field, out _));
        Assert.Single(f.Calls, c => c.Path.StartsWith("/api/v1/user?"));
    }

    // Seerr 3.5 and Jellyseerr 2.7 let only their admins read override rules (GET /api/v1/overrideRule is
    // isAuthenticated(Permission.ADMIN)), and apply the rules themselves when a request is created. The proxy
    // acts as the linked Seerr user, so for anyone else Seerr answered 403 and the client logged an error.
    private static Func<HttpRequestMessage, HttpResponseMessage> SeerrGatesOverrideRules(SeerrFixture f) => request =>
        request.RequestUri!.AbsolutePath != "/api/v1/overrideRule" ? IntegrationTransport.Response("{\"id\":99}")
        : (f.Permissions & JellyseerrPermission.ADMIN) != 0 ? IntegrationTransport.Response("[{\"id\":4,\"profileId\":7}]")
        : IntegrationTransport.Response("{\"message\":\"You do not have permission to access this endpoint.\"}", 403);

    [Theory]
    [InlineData(JellyseerrPermission.REQUEST, false)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_ADVANCED, false)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.MANAGE_REQUESTS, false)]
    [InlineData(JellyseerrPermission.REQUEST, true)]
    public async Task OverrideRulesAreNotAskedOfSeerrForAUserWhoMayNotReadThem(JellyseerrPermission permissions, bool jellyfinAdmin)
    {
        using var f = new SeerrFixture { Permissions = permissions };
        f.Reply = SeerrGatesOverrideRules(f);
        f.SetUser(f.UserId, jellyfinAdmin);
        var result = Assert.IsType<ContentResult>(await f.Controller.GetOverrideRules());
        Assert.Equal("[]", result.Content);
        Assert.DoesNotContain(f.Calls, c => c.Path.StartsWith("/api/v1/overrideRule"));
    }

    [Fact]
    public async Task ASeerrAdminStillReadsTheOverrideRulesFromSeerr()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.ADMIN };
        f.Reply = SeerrGatesOverrideRules(f);
        var result = Assert.IsType<ContentResult>(await f.Controller.GetOverrideRules());
        Assert.Equal(4, Body(result.Content!)[0].GetProperty("id").GetInt32());
        Assert.Equal("27", Assert.Single(f.Calls, c => c.Path == "/api/v1/overrideRule").User);
    }

    // Upstream 2e1f123d (#1032): POST jellyseerr/watchlist.
    [Fact]
    public async Task AddingToTheSeerrWatchlistSendsOnlyTheTwoFieldsAsTheCallingUser()
    {
        using var f = new SeerrFixture();
        f.Plugin.Plugin.Configuration.AddRequestedMediaToWatchlist = true;
        f.Controller.Request.Headers["X-Api-User"] = "1"; // a client-supplied identity must be ignored
        var result = await f.Controller.AddJellyseerrWatchlist(Body("{\"tmdbId\":603,\"mediaType\":\"movie\",\"title\":\"ignored\",\"extra\":true}"));
        Assert.IsType<ContentResult>(result);
        var call = Assert.Single(f.Calls, c => c.Method == "POST");
        Assert.Equal("/api/v1/watchlist", call.Path);
        Assert.Equal("27", call.User);
        Assert.Equal("{\"tmdbId\":603,\"mediaType\":\"movie\"}", call.Body);
    }

    [Fact]
    public async Task AddingToTheSeerrWatchlistFailsBeforeCallingSeerrWhenOffOrInvalid()
    {
        using var f = new SeerrFixture();
        f.Plugin.Plugin.Configuration.AddRequestedMediaToWatchlist = false;
        var off = Assert.IsType<BadRequestObjectResult>(await f.Controller.AddJellyseerrWatchlist(Body("{\"tmdbId\":603,\"mediaType\":\"movie\"}")));
        Assert.Contains("watchlist_disabled", JsonSerializer.Serialize(off.Value));

        f.Plugin.Plugin.Configuration.AddRequestedMediaToWatchlist = true;
        foreach (var body in new[] { "{}", "[]", "{\"tmdbId\":0,\"mediaType\":\"movie\"}", "{\"tmdbId\":\"603\",\"mediaType\":\"movie\"}", "{\"tmdbId\":603,\"mediaType\":\"person\"}", "{\"tmdbId\":603}" })
        {
            var bad = Assert.IsType<BadRequestObjectResult>(await f.Controller.AddJellyseerrWatchlist(Body(body)));
            Assert.Contains("invalid_watchlist_item", JsonSerializer.Serialize(bad.Value));
        }
        Assert.Empty(f.Calls);
    }

    [Fact]
    public async Task MissingRequestPermissionFailsBeforePostingAndMissingIdentityFailsBeforeLookup()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.NONE };
        var denied = Assert.IsType<ObjectResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":5}")));
        Assert.Equal(403, denied.StatusCode);
        Assert.Contains("no_request_permission", JsonSerializer.Serialize(denied.Value));
        Assert.DoesNotContain(f.Calls, c => c.Method == "POST");
        f.Calls.Clear();
        f.Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity());
        Assert.IsType<ForbidResult>(await f.Controller.JellyseerrRequest(Body("{}")));
        Assert.Empty(f.Calls);
    }

    [Theory]
    [InlineData(403)]
    [InlineData(409)]
    [InlineData(429)]
    [InlineData(500)]
    public async Task RequestErrorsPreserveStatusDoNotRetryWritesOrExposePrivateUpstream(int status)
    {
        using var f = new SeerrFixture();
        f.Reply = _ => IntegrationTransport.Response("{\"error\":\"upstream details\"}", status);
        var result = Assert.IsType<ObjectResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":5}")));
        Assert.Equal(status, result.StatusCode);
        Assert.Single(f.Calls, c => c.Method == "POST");
        var json = JsonSerializer.Serialize(result.Value);
        Assert.DoesNotContain("private-seerr", json);
        Assert.DoesNotContain("test-secret", json);
        Assert.DoesNotContain("upstream details", json);
    }

    [Fact]
    public async Task DetailCacheIsPerUserAndSuccessfulRequestInvalidatesMatchingTitleForEveryUser()
    {
        using var f = new SeerrFixture();
        var sequence = 0;
        f.Reply = request => IntegrationTransport.Response(JsonSerializer.Serialize(new { sequence = ++sequence, user = request.Headers.GetValues("X-Api-User").Single() }));
        var first = Assert.IsType<ContentResult>(await f.Controller.GetTvSeason(101, 1)).Content;
        Assert.Equal(first, Assert.IsType<ContentResult>(await f.Controller.GetTvSeason(101, 1)).Content);
        f.SetUser(f.OtherUserId);
        var second = Assert.IsType<ContentResult>(await f.Controller.GetTvSeason(101, 1)).Content;
        Assert.NotEqual(first, second);
        Assert.Contains("38", second!);
        Assert.Equal(2, f.Calls.Count(c => c.Path == "/api/v1/tv/101/season/1"));
        var unrelated = Assert.IsType<ContentResult>(await f.Controller.GetTvShow(1010)).Content;
        await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"tv\",\"mediaId\":101,\"seasons\":[1]}"));
        Assert.NotEqual(second, Assert.IsType<ContentResult>(await f.Controller.GetTvSeason(101, 1)).Content);
        f.SetUser(f.UserId);
        Assert.NotEqual(first, Assert.IsType<ContentResult>(await f.Controller.GetTvSeason(101, 1)).Content);
        f.SetUser(f.OtherUserId);
        Assert.Equal(unrelated, Assert.IsType<ContentResult>(await f.Controller.GetTvShow(1010)).Content);
        Assert.Equal(4, f.Calls.Count(c => c.Path == "/api/v1/tv/101/season/1"));
        Assert.Single(f.Calls, c => c.Path == "/api/v1/tv/1010");
    }

    [Fact]
    public async Task QuotaResetUsesOldestNondeclinedRequestInsideWindowAndCurrentUser()
    {
        using var f = new SeerrFixture();
        var created = DateTime.UtcNow.AddDays(-2);
        f.Reply = request => request.RequestUri!.AbsolutePath.EndsWith("/quota")
            ? IntegrationTransport.Response("{\"movie\":{\"limit\":4,\"used\":2,\"days\":7},\"tv\":null}")
            : IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] {
                new { status = 2, createdAt = created.ToString("o") },
                new { status = 3, createdAt = created.AddDays(-1).ToString("o") },
                new { status = 2, createdAt = created.AddDays(-20).ToString("o") },
                new { status = 2, createdAt = created.AddDays(1).ToString("o") }
            } }));
        var result = Assert.IsType<ContentResult>(await f.Controller.GetJellyseerrQuota());
        using var quota = JsonDocument.Parse(result.Content!);
        Assert.Equal(created.AddDays(7), quota.RootElement.GetProperty("movie").GetProperty("nextResetAt").GetDateTime());
        Assert.Equal(JsonValueKind.Null, quota.RootElement.GetProperty("tv").ValueKind);
        Assert.Contains(f.Calls, c => c.Path == "/api/v1/user/27/quota" && c.User == "27");
        Assert.Contains(f.Calls, c => c.Path.Contains("requestedBy=27") && c.Path.Contains("mediaType=movie") && c.User == "27");
    }

    [Theory]
    [InlineData("{\"movie\":null,\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":0,\"used\":9,\"days\":7},\"tv\":{\"limit\":2,\"used\":0,\"days\":7}}")]
    public async Task UnlimitedAndUnusedQuotasDoNotFetchHistory(string body)
    {
        using var f = new SeerrFixture();
        f.Reply = _ => IntegrationTransport.Response(body);
        var result = Assert.IsType<ContentResult>(await f.Controller.GetJellyseerrQuota());
        Assert.Equal(body, result.Content);
        Assert.DoesNotContain(f.Calls, c => c.Path.StartsWith("/api/v1/request"));
    }

    [Theory]
    [InlineData(JellyseerrPermission.NONE, false)]
    [InlineData(JellyseerrPermission.VIEW_ISSUES, false)]
    [InlineData(JellyseerrPermission.CREATE_ISSUES, false)]
    [InlineData(JellyseerrPermission.AUTO_APPROVE, false)]
    [InlineData(JellyseerrPermission.REQUEST, true)]
    [InlineData(JellyseerrPermission.REQUEST_ADVANCED, true)]
    [InlineData(JellyseerrPermission.ADMIN, true)]
    public async Task ServiceReadRequiresRequestOrAdvancedPermission(JellyseerrPermission permission, bool allowed)
    {
        using var f = new SeerrFixture { Permissions = permission };
        var result = await f.Controller.GetSonarrInstances();
        if (allowed) Assert.IsType<ContentResult>(result);
        else Assert.Equal(403, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Equal(allowed, f.Calls.Any(c => c.Path == "/api/v1/service/sonarr"));
        var invalid = Assert.IsType<BadRequestObjectResult>(await f.Controller.GetServiceDetails("../settings", 1));
        Assert.Equal(400, invalid.StatusCode);
    }
    [Theory]
    [InlineData(JellyseerrPermission.NONE, false, false)]
    [InlineData(JellyseerrPermission.CREATE_ISSUES, false, true)]
    [InlineData(JellyseerrPermission.VIEW_ISSUES, true, false)]
    [InlineData(JellyseerrPermission.MANAGE_ISSUES, true, true)]
    [InlineData(JellyseerrPermission.ADMIN, true, true)]
    public async Task IssueReadAndWritePermissionsAreIndependentIncludingDirectId(JellyseerrPermission permission, bool read, bool write)
    {
        using var f = new SeerrFixture { Permissions = permission };
        var detail = await f.Controller.GetJellyseerrIssueById(42);
        if (read) Assert.IsType<ContentResult>(detail);
        else Assert.Equal(403, Assert.IsType<ObjectResult>(detail).StatusCode);
        var report = await f.Controller.ReportJellyseerrIssue(Body("{\"issueType\":1,\"mediaId\":42,\"message\":\"test\"}"));
        if (write) Assert.IsType<ContentResult>(report);
        else Assert.Equal(403, Assert.IsType<ObjectResult>(report).StatusCode);
        Assert.Equal(read, f.Calls.Any(c => c.Path == "/api/v1/issue/42"));
        Assert.Equal(write, f.Calls.Any(c => c.Path == "/api/v1/issue" && c.Method == "POST"));
        Assert.IsType<BadRequestObjectResult>(await f.Controller.GetJellyseerrIssueById(0));
        Assert.IsType<BadRequestObjectResult>(await f.Controller.GetJellyseerrIssueById(-1));
    }

    [Fact]
    public async Task SecretBearingArrSettingsRequireJellyfinAdministratorEvenForSeerrAdmin()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.ADMIN };
        Assert.IsType<ForbidResult>(await f.Controller.GetJellyseerrArrSettings("sonarr"));
        Assert.Empty(f.Calls);
        f.SetUser(f.UserId, admin: true);
        Assert.IsType<BadRequestObjectResult>(await f.Controller.GetJellyseerrArrSettings("../users"));
        Assert.Empty(f.Calls);
        f.Reply = _ => IntegrationTransport.Response("[{\"apiKey\":\"expected-admin-secret\"}]");
        var result = Assert.IsType<ContentResult>(await f.Controller.GetJellyseerrArrSettings("sonarr"));
        Assert.Contains("expected-admin-secret", result.Content!);
        Assert.Single(f.Calls, c => c.Path == "/api/v1/settings/sonarr");
    }

    [Fact]
    public async Task BrowserDisconnectCancelsReadsButRequestWritesStillComplete()
    {
        using var f = new SeerrFixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        f.Controller.HttpContext.RequestAborted = cancellation.Token;
        var read = Assert.IsType<StatusCodeResult>(await f.Controller.GetTvShow(333));
        Assert.Equal(499, read.StatusCode);
        var write = await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"tv\",\"mediaId\":333,\"seasons\":[1]}"));
        Assert.IsType<ContentResult>(write);
        Assert.Single(f.Calls, c => c.Method == "POST");
    }

    private const string TmdbBody = "{\"id\":603,\"title\":\"Film\",\"overview\":\"Secret plot\"}";

    internal static SeerrFixture GuardedSeerr(out Guid movieId)
    {
        var library = new Mock<ILibraryManager>();
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() };
        movie.ProviderIds["Tmdb"] = "603";
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        movieId = movie.Id;
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        series.ProviderIds["Tmdb"] = "1433"; series.ProviderIds["Tvdb"] = "71663";
        library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        var f = new SeerrFixture((fixture, users) =>
        {
            var identities = new RequestIdentityService(Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), users,
                new SpoilerIdentityService(users, fixture.Plugin.Core.Logger), fixture.Plugin.Core.Logger);
            var resolver = new SpoilerUserResolver(fixture.Plugin.Core.Manager, library.Object, fixture.Plugin.Core.Logger, identities);
            return [resolver, new JE.Tests.Features.Calendar.IntegrationCalendarTests.CalendarDatabase(), new SpoilerSeerrRedactor(resolver, library.Object, users, Mock.Of<IUserDataManager>(), new SpoilerNextUnwatchedService(library.Object, users, Mock.Of<IUserDataManager>(), fixture.Plugin.Core.Logger)), new TmdbResponseCache(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(TmdbBody))), TimeProvider.System)];
        });
        f.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
        state.Movies[movie.Id.ToString("N")] = new();
        state.Series[series.Id.ToString("N")] = new();
        f.Plugin.Core.Manager.SaveUserConfiguration(f.UserId.ToString("N"), "spoilerblur.json", state);
        f.Plugin.Plugin.Configuration.SonarrInstances = JsonSerializer.Serialize(new[] { new { Name = "Sonarr", Url = "http://sonarr.invalid", ApiKey = "test-secret", Enabled = true } });
        return f;
    }

    // The response cache is keyed on the Seerr path and shared, so redaction has to run on the way out of it.
    [Fact]
    public async Task SpoilerGuardRedactsPerUserOnTopOfTheSharedResponseCache()
    {
        using var f = GuardedSeerr(out _);
        f.Reply = _ => IntegrationTransport.Response("{\"id\":603,\"title\":\"Film\",\"overview\":\"Secret plot\",\"tagline\":\"Secret\"}");
        var guarded = Body(Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!);
        Assert.Equal("Spoiler Guard activated", guarded.GetProperty("overview").GetString());
        Assert.False(guarded.TryGetProperty("tagline", out _));
        f.SetUser(f.OtherUserId);
        var other = Body(Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!);
        Assert.Equal("Secret plot", other.GetProperty("overview").GetString());
        f.SetUser(f.UserId);
        var again = Body(Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!);
        Assert.Equal("Spoiler Guard activated", again.GetProperty("overview").GetString());
    }

    [Fact]
    public async Task SpoilerGuardReachesTheListRoutes()
    {
        using var f = GuardedSeerr(out _);
        f.Reply = _ => IntegrationTransport.Response("{\"results\":[{\"mediaType\":\"movie\",\"id\":603,\"overview\":\"Secret plot\"}]}");
        var result = Assert.IsType<ContentResult>(await f.Controller.JellyseerrSearch("film"));
        Assert.Equal("Spoiler Guard activated", Body(result.Content!).GetProperty("results")[0].GetProperty("overview").GetString());
    }

    [Fact]
    public async Task MdblistAnswersNotFoundForAGuardedTitleWithoutLookingItUp()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.MdblistRatingsEnabled = true;
        var ok = Assert.IsType<OkObjectResult>(await f.DetailsProviders().GetMdblistRatings("movie", "603", CancellationToken.None));
        var body = Body(JsonSerializer.Serialize(ok.Value));
        Assert.False(body.GetProperty("Found").GetBoolean());
        // Not confirmed, so no cache keeps it past the guard.
        Assert.False(body.GetProperty("Confirmed").GetBoolean());
        Assert.False(f.Controller.Response.Headers.ContainsKey("Cache-Control"));
    }

    // The ETag describes the raw body, so honouring it would hand back a copy from before the guard.
    [Fact]
    public async Task TmdbPassthroughIgnoresARawCopysETagForAGuardedTitle()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        f.SetUser(f.OtherUserId);
        var raw = Assert.IsType<ContentResult>(await f.Controller.ProxyTmdbRequest("movie/603"));
        Assert.Contains("Secret plot", raw.Content);
        var etag = f.Controller.Response.Headers["ETag"].ToString();
        Assert.False(string.IsNullOrEmpty(etag));

        // Control: the same validator earns another user a 304.
        f.Controller.Request.Headers["If-None-Match"] = etag;
        Assert.Equal(304, Assert.IsType<StatusCodeResult>(await f.Controller.ProxyTmdbRequest("movie/603")).StatusCode);

        f.SetUser(f.UserId);
        f.Controller.Response.Headers.Remove("ETag");
        var guarded = Assert.IsType<ContentResult>(await f.Controller.ProxyTmdbRequest("movie/603"));
        Assert.Equal("Spoiler Guard activated", Body(guarded.Content!).GetProperty("overview").GetString());
        Assert.Equal("no-store", f.Controller.Response.Headers["Cache-Control"].ToString());
        Assert.False(f.Controller.Response.Headers.ContainsKey("ETag"));
    }

    [Fact]
    public void SpoilerMovieScopeAnswersForTheCallersOwnStateAndValidatesTheId()
    {
        using var f = GuardedSeerr(out var movieId);
        var ok = Assert.IsType<OkObjectResult>(f.SpoilerGuard().GetSpoilerMovieScope(movieId.ToString("N")));
        Assert.True(Body(JsonSerializer.Serialize(ok.Value)).GetProperty("inScope").GetBoolean());
        f.SetUser(f.OtherUserId);
        var other = Assert.IsType<OkObjectResult>(f.SpoilerGuard().GetSpoilerMovieScope(movieId.ToString("N")));
        Assert.False(Body(JsonSerializer.Serialize(other.Value)).GetProperty("inScope").GetBoolean());
        Assert.IsType<BadRequestObjectResult>(f.SpoilerGuard().GetSpoilerMovieScope("not-a-guid"));
        Assert.IsType<BadRequestObjectResult>(f.SpoilerGuard().GetSpoilerMovieScope(Guid.Empty.ToString("N")));
    }

    internal static JsonElement Rows(IActionResult result, string name) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value).GetProperty(name);

    [Fact]
    public async Task CalendarHidesGuardedEpisodeTitlesAndKeepsTheirDates()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.CalendarFilterByLibraryAccess = false;
        f.Reply = _ => IntegrationTransport.Response("[{\"id\":1,\"seriesId\":3,\"seasonNumber\":2,\"episodeNumber\":5,\"title\":\"Secret title\",\"overview\":\"Secret plot\",\"airDateUtc\":\"2026-11-10T00:00:00Z\",\"series\":{\"title\":\"Show\",\"tvdbId\":71663}},"
            + "{\"id\":2,\"seriesId\":4,\"seasonNumber\":1,\"episodeNumber\":1,\"title\":\"Open title\",\"airDateUtc\":\"2026-11-10T00:00:00Z\",\"series\":{\"title\":\"Other\",\"tvdbId\":7}}]");
        var calendar = f.Calendar();
        calendar.Request.QueryString = new Microsoft.AspNetCore.Http.QueryString("?start=2026-11-01&end=2026-11-30");
        var events = Rows(await calendar.GetCalendarEvents(), "events").EnumerateArray().ToList();
        var guarded = events.Single(e => e.GetProperty("title").GetString() == "Show");
        Assert.Equal("S02E05", guarded.GetProperty("subtitle").GetString());
        Assert.False(string.IsNullOrEmpty(guarded.GetProperty("releaseDate").GetString()));
        Assert.Equal("S01E01 - Open title", events.Single(e => e.GetProperty("title").GetString() == "Other").GetProperty("subtitle").GetString());
    }
}
