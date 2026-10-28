using System.Net;
using Jellyfin.Data;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiSeerrFactBoundaryTests
{
    private sealed class ParsedResponse(TaskCompletionSource parsed, ManualResetEventSlim release) : HttpResponseMessage(HttpStatusCode.OK)
    {
        protected override void Dispose(bool disposing)
        {
            if (disposing) { parsed.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(15))) throw new TimeoutException(); }
            base.Dispose(disposing);
        }
    }

    [Theory]
    [InlineData(0)][InlineData(1)]
    public async Task OwnershipReaderRejectsAListParsedBeforeAdoptionButReturnedAfterIt(int version)
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.ArrRequestBackend = "seerr"; c.ArrBackendIsolationVersion = version;
        c.JellyseerrEnabled = true; c.JellyseerrUrls = "http://seerr.test"; c.JellyseerrApiKey = "test";
        var parsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var request = FakeSeerr.Request(1, "movie", 45745, 2, Guid.NewGuid(), DateTime.UtcNow);
        request["requestedBy"]!["id"] = 7;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult<HttpResponseMessage>(new ParsedResponse(parsed, release)
        { Content = new StringContent("{\"results\":[" + request.ToJsonString() + "]}", System.Text.Encoding.UTF8, "application/json") }));
        var controller = ApiAssetTests.Controller(f.Core, transport);
        var method = typeof(JellyfinEnhancedController).GetMethod("GetJellyseerrRequestsForUser", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var read = Task.Run(async () => await (Task)method.Invoke(controller, ["7"])!);
        await parsed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try { await EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je"; JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange(); }, default).WaitAsync(TimeSpan.FromSeconds(5)); }
        finally { release.Set(); }
        await Assert.ThrowsAsync<BackendDisabledException>(() => read);
    }

    [Theory]
    [InlineData(false, 0)][InlineData(true, 0)][InlineData(false, 1)][InlineData(true, 1)]
    public async Task MixedDownloadAnswerRejectsOwnershipConsumedBeforeALaterArrAwait(bool history, int version)
    {
        using var arr = new FakeArr();
        var radarr = arr.Add("radarr.lan", "Radarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "test"));
        var c = arr.Plugin.Plugin.Configuration;
        c.ArrRequestBackend = "seerr"; c.ArrBackendIsolationVersion = version;
        c.DownloadsPageEnabled = c.ShowDownloadsInRequests = c.DownloadsShowHistory = true;
        c.DownloadsHistoryAdminOnly = false; c.DownloadsFilterByUserRequests = true;
        c.JellyseerrEnabled = true; c.JellyseerrUrls = FakeSeerr.Url; c.JellyseerrApiKey = FakeSeerr.Key;
        var person = Guid.NewGuid();
        var identityCache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        identityCache[person.ToString()] = SeerrSeeds.Id(person.ToString(), "7");
        using var seerr = new FakeSeerr();
        seerr.Users.Add(new System.Text.Json.Nodes.JsonObject { ["id"] = 7, ["jellyfinUserId"] = person.ToString() });
        var request = FakeSeerr.Request(1, "movie", 45745, 2, person, DateTime.UtcNow);
        request["requestedBy"]!["id"] = 7;
        seerr.Requests.Add(request);
        radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", arr.Now.UtcDateTime, "dl", 45745, "Sintel"));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        radarr.Before = async (path, _) => { if (path.Contains(history ? "history" : "queue", StringComparison.Ordinal)) { entered.TrySetResult(); await release.Task; } };
        var store = arr.Store();
        var controller = ApiAssetTests.Controller(arr.Plugin.Core, seerr.Transport, store, arr.Factory, new ApiArrRoutesTests.KeyAudience());
        controller.HttpContext.User = TestCallers.Principal(person, false);
        var action = new ControllerActionDescriptor { ControllerTypeInfo = typeof(JellyfinEnhancedController).GetTypeInfo(), MethodInfo = typeof(JellyfinEnhancedController).GetMethod(history ? "GetDownloadHistory" : "GetDownloadQueue")! };
        var context = new ActionExecutingContext(new(controller.HttpContext, new RouteData(), action), [], new Dictionary<string, object?>(), controller);
        ActionExecutedContext? executed = null;
        var filter = new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, arr.Plugin.Core.Logger);
        var read = filter.OnActionExecutionAsync(context, async () =>
        {
            var result = history ? await controller.GetDownloadHistory() : await controller.GetDownloadQueue();
            return executed = new(context, [], controller) { Result = result };
        });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains(seerr.Calls, x => x.Contains("/api/v1/request", StringComparison.Ordinal));
        try { await EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je"; JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange(); }, default); }
        finally { release.TrySetResult(); }
        await read.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(409, Assert.IsType<ObjectResult>(executed!.Result).StatusCode);
        Assert.DoesNotContain("Sintel", JsonSerializer.Serialize(((ObjectResult)executed.Result).Value));
    }
}

// Lazy asked proof has a separate cached handout: no request-list HTTP call is needed on a hit.
[Collection("Plugin singleton")]
public class ApiSeerrLazyProofBoundaryTests
{
    private sealed class AdoptingAudience(Action adopt) : Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.IArrFeedAudience
    {
        public int WithProof;
        public IReadOnlyCollection<string> Visible(Guid userId, bool admin, IReadOnlyList<Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrFeedChange> changes, IReadOnlySet<string>? askedFor = null, ICollection<string>? absent = null)
        {
            if (askedFor is { Count: > 0 }) { WithProof++; adopt(); return changes.Select(c => c.Key).ToArray(); }
            foreach (var c in changes) absent?.Add(c.Key);
            return Array.Empty<string>();
        }
    }
    [Theory]
    [InlineData(false, false, 0)][InlineData(true, false, 0)][InlineData(false, true, 0)][InlineData(true, true, 0)]
    [InlineData(false, false, 1)][InlineData(true, false, 1)][InlineData(false, true, 1)][InlineData(true, true, 1)]
    public async Task LazyOwnershipProofHitAndMissBothOwnTheFinalMixedAnswer(bool history, bool warm, int version)
    {
        using var arr = new FakeArr(); using var seerr = new FakeSeerr();
        var radarr = arr.Add("radarr.lan", "Radarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "test"));
        var c = arr.Plugin.Plugin.Configuration;
        c.ArrRequestBackend = "seerr"; c.ArrBackendIsolationVersion = version;
        c.DownloadsPageEnabled = c.ShowDownloadsInRequests = c.DownloadsShowHistory = true;
        c.DownloadsHistoryAdminOnly = c.DownloadsFilterByUserRequests = c.ArrPhase1Enabled = false;
        c.JellyseerrEnabled = true; c.JellyseerrUrls = FakeSeerr.Url; c.JellyseerrApiKey = FakeSeerr.Key;
        var person = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        person.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        var users = new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>(); users.Setup(u => u.GetUserById(person.Id)).Returns(person);
        var identity = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_userIdCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        identity[person.Id.ToString()] = SeerrSeeds.Id(person.Id.ToString(), "7");
        var request = FakeSeerr.Request(1, "movie", 45745, 2, person.Id, DateTime.UtcNow); request["requestedBy"]!["id"] = 7; seerr.Requests.Add(request);
        radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", arr.Now.UtcDateTime, "dl", 45745, "Sintel"));
        var store = arr.Store();
        var audience = new AdoptingAudience(() => EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je"; JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange(); }, default).GetAwaiter().GetResult());
        var controller = ApiAssetTests.Controller(arr.Plugin.Core, seerr.Transport, users.Object, store, arr.Factory, audience);
        controller.HttpContext.User = TestCallers.Principal(person.Id, false);
        if (warm)
        {
            var get = typeof(JellyfinEnhancedController).GetMethod("GetAskedProofAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var read = (Task<IReadOnlySet<(int, string)>?>)get.Invoke(controller, [c, person])!;
            Assert.Contains((45745, "movie"), (await read)!);
        }
        var reads = seerr.CallCount("/api/v1/request");
        var action = new ControllerActionDescriptor { ControllerTypeInfo = typeof(JellyfinEnhancedController).GetTypeInfo(), MethodInfo = typeof(JellyfinEnhancedController).GetMethod(history ? "GetDownloadHistory" : "GetDownloadQueue")! };
        var context = new ActionExecutingContext(new(controller.HttpContext, new RouteData(), action), [], new Dictionary<string, object?>(), controller);
        ActionExecutedContext? executed = null;
        await new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, arr.Plugin.Core.Logger).OnActionExecutionAsync(context, async () =>
        {
            var result = history ? await controller.GetDownloadHistory() : await controller.GetDownloadQueue();
            return executed = new(context, [], controller) { Result = result };
        });
        Assert.Equal(1, audience.WithProof);
        Assert.Equal(warm ? reads : reads + 1, seerr.CallCount("/api/v1/request"));
        Assert.Equal(409, Assert.IsType<ObjectResult>(executed!.Result).StatusCode);
    }
}
