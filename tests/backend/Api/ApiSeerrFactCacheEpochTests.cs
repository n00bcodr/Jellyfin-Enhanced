using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiSeerrFactCacheEpochTests
{
    private static async Task<T> Call<T>(JellyfinEnhancedController controller, string method, params object?[] args)
        => await (Task<T>)typeof(JellyfinEnhancedController).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(controller, args)!;

    [Theory]
    [InlineData("status")][InlineData("account")][InlineData("ownership")]
    public async Task CachedFactsRetainTheirOriginalEpochAcrossAdoptionAndReturnToTheSameSeerr(string kind)
    {
        using var f = new ApiPluginFixture(); using var seerr = new FakeSeerr();
        var c = f.Plugin.Configuration;
        c.ArrRequestBackend = "seerr"; c.ArrBackendIsolationVersion = 1;
        c.JellyseerrEnabled = true; c.JellyseerrUrls = FakeSeerr.Url; c.JellyseerrApiKey = FakeSeerr.Key;
        var person = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        seerr.Users.Add(new System.Text.Json.Nodes.JsonObject { ["id"] = 7, ["jellyfinUserId"] = person.Id.ToString("N") });
        var request = FakeSeerr.Request(1, "movie", 45745, 2, person.Id, DateTime.UtcNow); request["requestedBy"]!["id"] = 7; seerr.Requests.Add(request);
        using var status = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"version\":\"fixture\"}", seerr.FailWith == 0 ? 200 : 503)));
        var controller = ApiAssetTests.Controller(f.Core, kind == "status" ? status : seerr.Transport);
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        if (kind == "status") Assert.True(await Call<bool>(controller, "IsSeerrReachableCached"));
        else if (kind == "account") Assert.Equal("7", await Call<string?>(controller, "GetJellyseerrUserId", person.Id.ToString("N")));
        else Assert.Contains((45745, "movie"), (await Call<IReadOnlySet<(int, string)>?>(controller, "GetAskedProofAsync", c, person))!);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je"; }, default);
        // Deliberately omit external cache clearing: an accessor must enforce the stored epoch itself.
        seerr.Users[0]["id"] = 8; seerr.Requests.Clear(); seerr.FailWith = kind == "status" ? 503 : 0;
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => c.ArrRequestBackend = "seerr", default);
        if (kind == "status") Assert.False(await Call<bool>(controller, "IsSeerrReachableCached"));
        else if (kind == "account") Assert.Equal("8", await Call<string?>(controller, "GetJellyseerrUserId", person.Id.ToString("N")));
        else Assert.Empty((await Call<IReadOnlySet<(int, string)>?>(controller, "GetAskedProofAsync", c, person))!);
    }

    [Fact]
    public async Task SnapshotsMetadataAndRecentProofsDoNotAcquireANewEpochMerelyByBeingRead()
    {
        using var r = new IntegrationNotificationsTests.Rig();
        r.Config.ArrRequestBackend = "seerr"; r.Config.ArrBackendIsolationVersion = 1;
        r.Request(1, 693134, r.Emma);
        Assert.True(await r.Requests.RefreshAsync(default));
        var key = TitleKey.Parse("movie:tmdb:693134")!;
        Assert.NotNull(r.Requests.Meta(true, 693134));
        r.Seerr.Requests.Clear(); r.Arr.Now = r.Arr.Now.AddMinutes(31);
        Assert.True(await r.Requests.RefreshAsync(default));
        Assert.True(r.Requests.RequestedLately(key));
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Config.ArrRequestBackend = "je", default);
        Assert.Empty(r.Requests.All); Assert.Null(r.Requests.Meta(true, 693134)); Assert.False(r.Requests.Loaded);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Config.ArrRequestBackend = "seerr", default);
        Assert.False(r.Requests.Loaded); Assert.False(r.Requests.RequestedLately(key)); Assert.Null(r.Requests.Meta(true, 693134));
        Assert.True(await r.Requests.RefreshAsync(default));
        Assert.False(r.Requests.RequestedLately(key)); Assert.False(r.Requests.AskedLatelyBy(key, r.Emma.UserId));
    }
}
