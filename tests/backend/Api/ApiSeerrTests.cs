using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiSeerrTests
{
    private sealed class SeerrFixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Guid UserId { get; } = Guid.NewGuid();
        public Guid OtherUserId { get; } = Guid.NewGuid();
        public bool Importable { get; set; }
        public JellyseerrPermission Permissions { get; set; } = JellyseerrPermission.REQUEST;
        public ConcurrentQueue<(string Path, string Method, string? User, string? Body)> Calls { get; } = new();
        public Func<HttpRequestMessage, HttpResponseMessage> Reply { get; set; } = _ => IntegrationTransport.Response("{\"id\":99}");
        public IntegrationTransport Transport { get; }
        public JellyfinEnhancedController Controller { get; }
        public SeerrFixture(ILibraryManager? library = null, IUserManager? jellyfinUsers = null)
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
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
                if (Importable && path.StartsWith("/api/v1/user?")) return IntegrationTransport.Response("{\"results\":[]}");
                if (Importable && path == "/api/v1/user/import-from-jellyfin") return IntegrationTransport.Response(JsonSerializer.Serialize(new[] { new { id = 27, jellyfinUserId = UserId.ToString("N"), permissions = (int)Permissions } }));
                if (path.StartsWith("/api/v1/user?")) return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] {
                    new { id = 27, jellyfinUserId = UserId.ToString("N"), permissions = (int)Permissions },
                    new { id = 38, jellyfinUserId = OtherUserId.ToString("N"), permissions = (int)Permissions }
                } }));
                return Reply(request);
            });
            var users = jellyfinUsers ?? Mock.Of<IUserManager>();
            var filter = new SeerrParentalFilter(Transport, users, Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), Plugin.Core.Logger);
            Controller = library == null
                ? ApiAssetTests.Controller(Plugin.Core, Transport, users, filter)
                : ApiAssetTests.Controller(Plugin.Core, Transport, users, filter, library);
            SetUser(UserId);
        }
        public void SetUser(Guid user, bool admin = false) => Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        public void Dispose() { Transport.Dispose(); JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange(); Plugin.Dispose(); }
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

    [Theory]
    [InlineData(true, true, true, true)]
    [InlineData(true, false, true, false)]
    [InlineData(true, true, false, false)]
    [InlineData(false, true, true, false)]
    public async Task LegacyMovieAndSeasonsRoutesShareTheServer4kGateEvenForJellyfinAdmins(bool editionSwitch, bool setting, bool permission, bool allowed)
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.REQUEST | (permission ? JellyseerrPermission.REQUEST_4K : JellyseerrPermission.NONE) };
        f.SetUser(f.UserId, admin: true);
        f.Plugin.Plugin.Configuration.ArrIntegrationEnabled = true;
        f.Plugin.Plugin.Configuration.ArrPhase1Enabled = true;
        f.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        f.Plugin.Plugin.Configuration.ArrRequest4kMoviesEnabled = editionSwitch;
        f.Plugin.Plugin.Configuration.ArrRequest4kSeriesEnabled = editionSwitch;
        f.Plugin.Plugin.Configuration.JellyseerrEnable4KRequests = editionSwitch;
        f.Plugin.Plugin.Configuration.JellyseerrEnable4KTvRequests = editionSwitch;
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/settings/main"
            ? IntegrationTransport.Response(JsonSerializer.Serialize(new { movie4kEnabled = setting, series4kEnabled = setting }))
            : IntegrationTransport.Response("{\"id\":99}");
        var movie = await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":101,\"is4k\":true}"));
        var tv = await f.Controller.RequestTvSeasons(101, Body("{\"mediaType\":\"tv\",\"mediaId\":101,\"seasons\":[1],\"is4k\":true}"));
        if (allowed) { Assert.IsType<ContentResult>(movie); Assert.IsType<ContentResult>(tv); Assert.Equal(2, f.Calls.Count(c => c.Method == "POST")); }
        else { Assert.Equal(403, Assert.IsType<ObjectResult>(movie).StatusCode); Assert.Equal(403, Assert.IsType<ObjectResult>(tv).StatusCode); Assert.DoesNotContain(f.Calls, c => c.Method == "POST"); }
    }

    [Theory]
    [InlineData(false, true, true, false)]
    [InlineData(true, false, true, false)]
    [InlineData(true, true, false, false)]
    [InlineData(false, true, true, true)]
    [InlineData(true, false, true, true)]
    [InlineData(true, true, false, true)]
    public async Task R2DisabledPhasePreservesLegacyMovieAndSeasonsAdminProxy(bool integration, bool phase1, bool phase3, bool settingsFail)
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.ADMIN };
        var config = f.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = integration; config.ArrPhase1Enabled = phase1; config.ArrPhase3Enabled = phase3;
        config.JellyseerrEnable4KRequests = false; config.JellyseerrEnable4KTvRequests = false;
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/settings/main" && settingsFail
            ? IntegrationTransport.Response("{}", 503) : IntegrationTransport.Response("{\"id\":99}");
        foreach (var admin in new[] { false, true })
        {
            f.SetUser(f.UserId, admin);
            Assert.IsType<ContentResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":101,\"is4k\":true}")));
            Assert.IsType<ContentResult>(await f.Controller.RequestTvSeasons(101, Body("{\"mediaType\":\"tv\",\"mediaId\":101,\"seasons\":[1],\"is4k\":true}")));
        }
        Assert.Equal(4, f.Calls.Count(c => c.Method == "POST"));
        Assert.DoesNotContain(f.Calls, c => c.Path == "/api/v1/settings/main");
    }

    [Fact]
    public async Task R2EnabledPhaseRecognizesSeerrAdminAsHolding4k()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.ADMIN };
        var config = f.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true;
        config.ArrRequest4kMoviesEnabled = true; config.ArrRequest4kSeriesEnabled = true;
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/settings/main"
            ? IntegrationTransport.Response("{\"movie4kEnabled\":true,\"series4kEnabled\":true}") : IntegrationTransport.Response("{\"id\":99}");
        Assert.IsType<ContentResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":101,\"is4k\":true}")));
        Assert.IsType<ContentResult>(await f.Controller.RequestTvSeasons(101, Body("{\"mediaType\":\"tv\",\"mediaId\":101,\"seasons\":[1],\"is4k\":true}")));
        Assert.Equal(2, f.Calls.Count(c => c.Method == "POST"));
    }

    [Theory]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(false, false, false)]
    public async Task S5DisabledPhaseKeepsLegacyAdminAutoImportAndCachedApproveDecline(bool integration, bool phase1, bool phase3)
    {
        using var f = new SeerrFixture { Importable = true };
        f.SetUser(f.UserId, admin: true);
        var config = f.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = integration; config.ArrPhase1Enabled = phase1; config.ArrPhase3Enabled = phase3;
        config.JellyseerrAutoImportUsers = true; config.DownloadsPageEnabled = true;
        f.Controller.Request.Path = "/JellyfinEnhanced/arr/requests/99/approve";
        Assert.IsType<OkObjectResult>(await f.Controller.ActOnRequest(99));
        f.Controller.Request.Path = "/JellyfinEnhanced/arr/requests/99/decline";
        Assert.IsType<OkObjectResult>(await f.Controller.ActOnRequest(99));
        Assert.Single(f.Calls, c => c.Path.StartsWith("/api/v1/user?"));
        Assert.Single(f.Calls, c => c.Path == "/api/v1/user/import-from-jellyfin");
        Assert.Equal("27", Assert.Single(f.Calls, c => c.Path.EndsWith("/99/approve")).User);
        Assert.Equal("27", Assert.Single(f.Calls, c => c.Path.EndsWith("/99/decline")).User);
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true;
        Assert.IsType<NotFoundObjectResult>(await f.Controller.ActOnRequest(99));
        Assert.Equal(2, f.Calls.Count(c => c.Path.StartsWith("/api/v1/user?")));
        Assert.Single(f.Calls, c => c.Path == "/api/v1/user/import-from-jellyfin");
    }

    [Fact]
    public async Task AStringEditionCannotBypassTheBoolean4kGate()
    {
        using var f = new SeerrFixture(); f.SetUser(f.UserId, admin: true);
        f.Plugin.Plugin.Configuration.ArrIntegrationEnabled = true;
        f.Plugin.Plugin.Configuration.ArrPhase1Enabled = true;
        f.Plugin.Plugin.Configuration.ArrPhase3Enabled = true;
        var response = Assert.IsType<BadRequestObjectResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":101,\"is4k\":\"true\"}")));
        Assert.Equal(400, response.StatusCode); Assert.DoesNotContain(f.Calls, c => c.Method == "POST");
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
    [InlineData(404, true)]
    [InlineData(500, false)]
    public async Task ASeriesRottenTomatoesDoesNotKnowHasNoRatingsRatherThanAFailedRequest(int status, bool none)
    {
        using var f = new SeerrFixture();
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/tv/1849/ratings"
            ? IntegrationTransport.Response("{\"message\":\"Rotten Tomatoes ratings not found.\"}", status)
            : IntegrationTransport.Response("{}");
        var result = await f.Controller.GetTvRatingsCombined(1849);
        if (none)
        {
            var content = Assert.IsType<ContentResult>(result);
            Assert.Equal("null", content.Content);
            Assert.Equal("application/json", content.ContentType);
        }
        else
        {
            Assert.Equal(status, Assert.IsType<ObjectResult>(result).StatusCode);
        }

        f.Reply = _ => IntegrationTransport.Response("{\"criticsScore\":96}");
        Assert.Contains("96", Assert.IsType<ContentResult>(await f.Controller.GetTvRatingsCombined(83867)).Content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OnlySeerrsOwnNotFoundMeansASeriesHasNoRatings()
    {
        using var f = new SeerrFixture();
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/tv/1849/ratings"
            ? IntegrationTransport.Response("{\"message\":\"Rotten Tomatoes ratings not found.\"}", 404)
            : IntegrationTransport.Response("{}");
        // A viewer without a Seerr account keeps the proxy's own 404 ("unlinked"), not "no ratings".
        f.SetUser(Guid.NewGuid());
        var unlinked = Assert.IsAssignableFrom<ObjectResult>(await f.Controller.GetTvRatingsCombined(1849));
        Assert.Equal(404, unlinked.StatusCode);
        Assert.Equal("unlinked", Body(JsonSerializer.Serialize(unlinked.Value)).GetProperty("code").GetString());
        Assert.DoesNotContain(f.Calls, call => call.Path.EndsWith("/ratings", StringComparison.Ordinal));
        // A linked viewer's upstream 404 is still "no ratings".
        f.SetUser(f.UserId);
        Assert.Equal("null", Assert.IsType<ContentResult>(await f.Controller.GetTvRatingsCombined(1849)).Content);
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
        f.Reply = _ => IntegrationTransport.Response("[{\"hostname\":\"sonarr.lan\",\"port\":8989,\"useSsl\":false,\"apiKey\":\"expected-admin-secret\"}]");
        var result = Assert.IsType<ContentResult>(await f.Controller.GetJellyseerrArrSettings("sonarr"));
        // Even for admins the real key stays on the server: the browser gets a handle that only
        // the save (or a Test of that same server) can resolve.
        Assert.DoesNotContain("expected-admin-secret", result.Content!);
        var handle = JsonSerializer.Deserialize<JsonElement>(result.Content!)[0].GetProperty("apiKey").GetString();
        Assert.Equal("expected-admin-secret", f.Plugin.Plugin.Secrets.ResolvePending(handle, "http://sonarr.lan:8989"));
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


    [Fact]
    public async Task NonAdminsGetDownloadRowsWithoutReleaseNamesOnFreshAndCachedAnswersAndAdminsGetSeerrsOwn()
    {
        using var f = new SeerrFixture();
        f.Reply = _ => IntegrationTransport.Response(PrivacySeerrDownloadStatusTests.Details());
        var fresh = Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!;
        var cached = Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!;
        Assert.Single(f.Calls, c => c.Path == "/api/v1/movie/603");
        foreach (var body in new[] { fresh, cached })
        {
            Assert.DoesNotContain("MOCKHD", body, StringComparison.Ordinal);
            Assert.DoesNotContain("SABnzbd", body, StringComparison.Ordinal);
            Assert.Contains("\"group\":\"g1\"", body, StringComparison.Ordinal);
            Assert.DoesNotContain("radarr.lan", body, StringComparison.Ordinal);
        }
        f.SetUser(f.UserId, admin: true);
        var admin = Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!;
        Assert.Contains("The.Matrix.1999.1080p.BluRay.x264-MOCKHD", admin, StringComparison.Ordinal);
        Assert.Contains("radarr.lan", admin, StringComparison.Ordinal);
        // The cache still holds Seerr's own body: the next non-admin answer is projected again.
        f.SetUser(f.UserId);
        Assert.DoesNotContain("MOCKHD", Assert.IsType<ContentResult>(await f.Controller.GetMovie(603)).Content!, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("je", true)]
    [InlineData("seerr", false)]
    public async Task AfterTheHandOverToJeNoRequestWriteReachesSeerr(string backend, bool refused)
    {
        using var f = new SeerrFixture();
        var c = f.Plugin.Plugin.Configuration;
        c.ArrIntegrationEnabled = true; c.ArrPhase1Enabled = true; c.ArrPhase3Enabled = true; c.ArrRequestBackend = backend; c.DownloadsPageEnabled = true;
        var write = await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":603,\"is4k\":false}"));
        var act = await f.Controller.ActOnRequest(12);
        if (refused)
        {
            foreach (var result in new[] { write, act })
            {
                var conflict = Assert.IsType<ObjectResult>(result);
                Assert.Equal(409, conflict.StatusCode);
                Assert.Contains("requests_in_je", JsonSerializer.Serialize(conflict.Value), StringComparison.Ordinal);
            }
            Assert.Empty(f.Calls);                                   // not even a user lookup
            Assert.IsType<ContentResult>(await f.Controller.GetMovie(603));   // reads still work
        }
        else
        {
            Assert.Contains(f.Calls, call => call.Method == "POST" && call.Path == "/api/v1/request");
        }
    }

    [Fact]
    public async Task AMoveFromSeerrWaitsForJesSeerrWritesInFlightAndRefusesNewOnesUntilItEnds()
    {
        using var f = new SeerrFixture();
        var c = f.Plugin.Plugin.Configuration;
        c.ArrIntegrationEnabled = true; c.ArrPhase1Enabled = true; c.ArrPhase3Enabled = true; c.ArrRequestBackend = "seerr"; c.DownloadsPageEnabled = true;
        var fence = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.SeerrRequestWriteFence();
        f.Controller.HttpContext.RequestServices = new ServiceCollection().AddSingleton(fence).BuildServiceProvider();
        var posted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Reply = r =>
        {
            if (r.Method == HttpMethod.Post) { posted.TrySetResult(); release.Task.Wait(TimeSpan.FromSeconds(10)); }
            return IntegrationTransport.Response("{\"id\":99}");
        };
        // A request write is on its way to Seerr when the move starts: the move waits for it.
        var write = Task.Run(() => f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":603,\"is4k\":false}")));
        await posted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var move = fence.BeginMoveAsync(TimeSpan.FromSeconds(10), CancellationToken.None);
        await Task.Delay(150);
        Assert.False(move.IsCompleted);
        // New writes are refused at once, before any Seerr call, while the move waits and while it runs.
        var calls = f.Calls.Count;
        var busy = Assert.IsType<ObjectResult>(await f.Controller.ActOnRequest(12));
        Assert.Equal(409, busy.StatusCode);
        Assert.Contains("migration_busy", JsonSerializer.Serialize(busy.Value), StringComparison.Ordinal);
        Assert.Equal(calls, f.Calls.Count);
        release.SetResult();
        Assert.IsType<ContentResult>(await write);
        var pass = await move.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotNull(pass);
        Assert.Contains("migration_busy", JsonSerializer.Serialize(Assert.IsType<ObjectResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":604,\"is4k\":false}"))).Value), StringComparison.Ordinal);
        pass!.Dispose();
        // The move ended without a switch (still Seerr mode): writes reach Seerr again.
        Assert.IsType<ContentResult>(await f.Controller.JellyseerrRequest(Body("{\"mediaType\":\"movie\",\"mediaId\":605,\"is4k\":false}")));
        Assert.Equal(2, f.Calls.Count(call => call.Method == "POST" && call.Path == "/api/v1/request"));
    }

    [Fact]
    public async Task LibraryLinksInProxiedSeerrAnswersAreKeptToWhatTheCallerCanOpenOnFreshAndCachedAnswers()
    {
        // A person's credits and a discover page name two library copies: one in a library the viewer can
        // open, one in a library they can't. Seerr names both, whoever asks.
        // The fixture's Seerr links its two Jellyfin users (27 and 38).
        Jellyfin.Database.Implementations.Entities.User viewer = null!, admin = null!;
        var open = new MediaBrowser.Controller.Entities.Movies.Movie { Id = PrivacySeerrLibraryAccessTests.Open };
        var hidden = new MediaBrowser.Controller.Entities.TV.Series { Id = PrivacySeerrLibraryAccessTests.Hidden };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => id == open.Id ? open : id == hidden.Id ? hidden : null);
        library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(It.IsAny<Guid>(), It.IsAny<Jellyfin.Database.Implementations.Entities.User?>()))
            .Returns((Guid id, Jellyfin.Database.Implementations.Entities.User? u) => id == open.Id ? open : id == hidden.Id && u?.Id == admin.Id ? hidden : null);
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns(new List<MediaBrowser.Controller.Entities.BaseItem>());
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => id == viewer.Id ? viewer : id == admin.Id ? admin : null);
        using var f = new SeerrFixture(library.Object, users.Object);
        viewer = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = f.UserId };
        admin = new Jellyfin.Database.Implementations.Entities.User("admin", "default", "default") { Id = f.OtherUserId };
        string Media(Guid id, int tmdb, string type) => "{\"tmdbId\":" + tmdb + ",\"mediaType\":\"" + type + "\",\"status\":5,\"jellyfinMediaId\":\"" + id.ToString("N") + "\"}";
        var credits = "{\"cast\":[{\"id\":603,\"mediaType\":\"movie\",\"title\":\"Open Movie\",\"mediaInfo\":" + Media(open.Id, 603, "movie") + "},"
            + "{\"id\":1433,\"mediaType\":\"tv\",\"name\":\"Hidden Show\",\"mediaInfo\":" + Media(hidden.Id, 1433, "tv") + "}],\"crew\":[]}";
        var discover = "{\"page\":1,\"totalPages\":1,\"results\":[{\"id\":1433,\"name\":\"Hidden Show\",\"mediaInfo\":" + Media(hidden.Id, 1433, "tv") + "},{\"id\":99,\"name\":\"Absent Show\"}]}";
        f.Reply = request => IntegrationTransport.Response(request.RequestUri!.PathAndQuery.Contains("combined_credits") ? credits : discover);
        string Read(IActionResult result) => Assert.IsType<ContentResult>(result).Content!;
        async Task<(string Credits, string Discover)> AsCaller(Jellyfin.Database.Implementations.Entities.User who, bool isAdmin)
        {
            f.SetUser(who.Id, isAdmin);
            return (Read(await f.Controller.GetJellyseerrPersonCredits(287)), Read(await f.Controller.DiscoverTvByGenre(18)));
        }
        var upstream = new List<int>();
        foreach (var round in new[] { "fresh", "cached" })
        {
            var (c, d) = await AsCaller(viewer, false);
            Assert.DoesNotContain(hidden.Id.ToString("N"), c + d, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Hidden Show", c + d, StringComparison.Ordinal);
            Assert.Contains(open.Id.ToString("N"), c, StringComparison.Ordinal);
            Assert.Contains("Absent Show", d, StringComparison.Ordinal);
            var (ac, ad) = await AsCaller(admin, true);
            Assert.Contains(hidden.Id.ToString("N"), ac, StringComparison.Ordinal);
            Assert.Contains("Hidden Show", ad, StringComparison.Ordinal);
            upstream.Add(f.Calls.Count(c => c.Path.Contains("combined_credits") || c.Path.Contains("discover")));
        }
        Assert.Equal(upstream[0], upstream[1]);        // the second round came from the cache (Seerr's own body), projected again
    }

    [Fact]
    public async Task TheRequestsListNamesARequestsJellyfinItemOnlyWhenTheCallerCanOpenIt()
    {
        Jellyfin.Database.Implementations.Entities.User viewer = null!;
        var open = new MediaBrowser.Controller.Entities.Movies.Movie { Id = PrivacySeerrLibraryAccessTests.Open };
        var hidden = new MediaBrowser.Controller.Entities.TV.Series { Id = PrivacySeerrLibraryAccessTests.Hidden };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => id == open.Id ? open : id == hidden.Id ? hidden : null);
        library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(It.IsAny<Guid>(), It.IsAny<Jellyfin.Database.Implementations.Entities.User?>()))
            .Returns((Guid id, Jellyfin.Database.Implementations.Entities.User? _) => id == open.Id ? open : null);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => id == viewer?.Id ? viewer : null);
        using var f = new SeerrFixture(library.Object, users.Object);
        viewer = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = f.UserId };
        f.Plugin.Plugin.Configuration.DownloadsPageEnabled = true;
        f.Permissions = JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_VIEW;   // everyone's requests
        string Request(int id, string type, int tmdb, Guid item) => "{\"id\":" + id + ",\"type\":\"" + type + "\",\"status\":2,\"createdAt\":\"2026-10-01T00:00:00Z\","
            + "\"media\":{\"tmdbId\":" + tmdb + ",\"status\":5,\"jellyfinMediaId\":\"" + item.ToString("N") + "\"},\"requestedBy\":{\"displayName\":\"Someone\"}}";
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/request"
            ? IntegrationTransport.Response("{\"pageInfo\":{\"pages\":1,\"results\":2},\"results\":[" + Request(1, "movie", 603, open.Id) + "," + Request(2, "tv", 1433, hidden.Id) + "]}")
            : IntegrationTransport.Response("{}");
        var body = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(await f.Controller.GetRequests()).Value);
        Assert.Contains(open.Id.ToString("N"), body, StringComparison.Ordinal);
        Assert.DoesNotContain(hidden.Id.ToString("N"), body, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(2, JsonSerializer.Deserialize<JsonElement>(body).GetProperty("requests").GetArrayLength());   // the request itself stays
    }

    [Theory]
    [InlineData(JellyseerrPermission.NONE, false, false)]
    [InlineData(JellyseerrPermission.REQUEST, false, false)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.CREATE_ISSUES, false, false)]
    [InlineData(JellyseerrPermission.VIEW_ISSUES, false, true)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.VIEW_ISSUES, false, true)]
    [InlineData(JellyseerrPermission.MANAGE_ISSUES, false, true)]
    [InlineData(JellyseerrPermission.ADMIN, false, true)]
    [InlineData(JellyseerrPermission.REQUEST, true, true)]
    public async Task TheUserStatusSaysWhetherIssuesMayBeReadSoTheClientDoesntAskForA403(JellyseerrPermission permissions, bool jellyfinAdmin, bool canView)
    {
        using var f = new SeerrFixture { Permissions = permissions };
        f.SetUser(f.UserId, jellyfinAdmin);
        f.Reply = request => IntegrationTransport.Response("{}");
        foreach (var round in new[] { "lookup", "cached" })
        {
            var status = Body(JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(await f.Controller.GetJellyseerrUserStatus()).Value));
            Assert.True(status.GetProperty("userFound").GetBoolean(), round);
            Assert.Equal(canView, status.GetProperty("canViewIssues").GetBoolean());
        }
        // And the proxy agrees: an issue read is refused exactly when the status says so.
        var read = await f.Controller.GetJellyseerrIssues(null);
        Assert.Equal(canView, read is not ObjectResult { StatusCode: 403 });
    }
}
