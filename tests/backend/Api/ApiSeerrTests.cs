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
        public JellyseerrPermission Permissions { get; set; } = JellyseerrPermission.REQUEST;
        public ConcurrentQueue<(string Path, string Method, string? User, string? Body)> Calls { get; } = new();
        public Func<HttpRequestMessage, HttpResponseMessage> Reply { get; set; } = _ => IntegrationTransport.Response("{\"id\":99}");
        public IntegrationTransport Transport { get; }
        public JellyfinEnhancedController Controller { get; }
        public SeerrFixture()
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
                if (path.StartsWith("/api/v1/user?")) return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] {
                    new { id = 27, jellyfinUserId = UserId.ToString("N"), permissions = (int)Permissions },
                    new { id = 38, jellyfinUserId = OtherUserId.ToString("N"), permissions = (int)Permissions }
                } }));
                return Reply(request);
            });
            var users = Mock.Of<IUserManager>();
            var filter = new SeerrParentalFilter(Transport, users, Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), Plugin.Core.Logger);
            Controller = ApiAssetTests.Controller(Plugin.Core, Transport, users, filter);
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

}
