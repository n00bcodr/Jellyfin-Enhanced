using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiBackendPublicationRound2Tests
{
    [Theory]
    [InlineData(0)][InlineData(1)]
    public async Task EveryGuardedActionFencesItsFinalResultIncludingCachedAndNonProxyActions(int version)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        var filter = new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, f.Core.Logger);
        var actions = typeof(JellyfinEnhancedController).Assembly.GetTypes().Where(t => typeof(ControllerBase).IsAssignableFrom(t))
            .SelectMany(t => t.GetMethods().Select(m => new ControllerActionDescriptor { ControllerTypeInfo = t.GetTypeInfo(), MethodInfo = m }))
            .Where(SeerrIsolationActionFilter.IsSeerrAction).ToArray();
        Assert.True(actions.Length >= 60);
        foreach (var action in actions)
        {
            config.ArrRequestBackend = "seerr"; config.ArrBackendIsolationVersion = version;
            var context = new ActionExecutingContext(new(new DefaultHttpContext(), new RouteData(), action), new List<IFilterMetadata>(), new Dictionary<string, object?>(), new object());
            ActionExecutedContext? executed = null;
            await filter.OnActionExecutionAsync(context, async () =>
            {
                await EffectiveRequestsBackend.Shared.TransitionAsync(() => { config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 1; }, default);
                executed = new ActionExecutedContext(context, new List<IFilterMetadata>(), context.Controller) { Result = new OkObjectResult(new { active = true }) };
                return executed;
            });
            Assert.Equal(409, Assert.IsType<ObjectResult>(executed!.Result).StatusCode);
        }
    }

    private sealed class BarrierResponse(TaskCompletionSource parsed, ManualResetEventSlim release) : HttpResponseMessage(HttpStatusCode.OK)
    {
        protected override void Dispose(bool disposing)
        {
            if (disposing) { parsed.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException(); }
            base.Dispose(disposing);
        }
    }

    [Theory]
    [InlineData(0, "reader")][InlineData(1, "reader")]
    [InlineData(0, "enrichment")][InlineData(1, "enrichment")]
    [InlineData(0, "probe")][InlineData(1, "probe")]
    public async Task BufferedReadHelpersFencePublicationOutsideControllerFilter(int version, string path)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.ArrBackendIsolationVersion = version;
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test"; config.JellyseerrApiKey = "test";
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        var parsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var trap = new ApiRequestsBackendGateTests.Trap { OnSend = (_, _) => Task.FromResult<HttpResponseMessage>(new BarrierResponse(parsed, release)
        { Content = new StringContent("{\"title\":\"old-provider-sentinel\",\"version\":\"1\"}", Encoding.UTF8, "application/json") }) };
        using var handler = new SeerrIsolationTransportHandler(EffectiveRequestsBackend.Shared, () => f.Plugin.Configuration) { InnerHandler = trap };
        var factory = new Mock<IHttpClientFactory>(); factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(handler, false));
        var controller = ApiAssetTests.Controller(f.Core, factory.Object);
        using var reader = new SeerrRequestReadModel(factory.Object, new ArrChangeFeed(), f.Core.Logger, new RequestOutboxEvents());
        object owner = path == "reader" ? reader : controller;
        var name = path switch { "reader" => "GetJsonAsync", "enrichment" => "EnrichWithTmdbData", _ => "ProbeJellyseerrStatusAsync" };
        using var client = factory.Object.CreateClient("");
        object?[] args = path switch
        {
            "reader" => ["http://seerr.test/api/v1/request", "test", CancellationToken.None],
            "enrichment" => [client, 989987, "movie", "http://seerr.test", "test", typeof(JellyfinEnhancedController).GetField("_seerrResponseGeneration", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null), DateTime.UtcNow],
            _ => [],
        };
        var method = owner.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
        var read = Task.Run(async () => { var task = (Task)method.Invoke(owner, args)!; await task; return task.GetType().GetProperty("Result")!.GetValue(task); });
        await parsed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            await EffectiveRequestsBackend.Shared.TransitionAsync(() =>
            {
                config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 1;
                JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
            }, default).WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally { release.Set(); }
        if (path == "reader")
        {
            var result = ((JsonElement? Json, string? Error, bool NotFound))(await read)!;
            Assert.Null(result.Json); Assert.Equal("backend_disabled", result.Error);
        }
        else await Assert.ThrowsAsync<BackendDisabledException>(() => read);
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_tmdbEnrichmentCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        Assert.Empty(cache);
    }

    [Theory]
    [InlineData("movie")][InlineData("season")][InlineData("scan")][InlineData("import")]
    public async Task LegacyBackgroundHelpersDrainProcessingAndRejectResultOnAdoption(string path)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test"; config.JellyseerrApiKey = "test";
        var parsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult<HttpResponseMessage>(new BarrierResponse(parsed, release)
        { Content = new StringContent(path == "scan" ? "[]" : path == "import" ? "[]" : "{\"results\":[],\"numberOfSeasons\":2,\"seasons\":[]}", Encoding.UTF8, "application/json") }));
        var library = Mock.Of<ILibraryManager>(); var users = Mock.Of<IUserManager>();
        using var scan = new SeerrScanTriggerService(library, transport, f.Core.Logger);
        object owner = path switch
        {
            "movie" => new AutoMovieRequestService(transport, f.Core.Logger, users, library),
            "season" => new AutoSeasonRequestService(transport, f.Core.Logger, users, Mock.Of<IUserDataManager>(), library),
            _ => scan,
        };
        var methodName = path switch { "movie" => "GetOriginalMovieQualityProfileAsync", "season" => "GetSeriesDetailsJsonAsync", _ => "IsRunningAsync" };
        var read = Task.Run(async () =>
        {
            if (path == "import") { await JellyseerrUserImportHelper.BulkImportAsync(new() { Guid.NewGuid().ToString("N") }, new[] { "http://seerr.test" }, "test", transport, f.Core.Logger); return; }
            var method = owner.GetType().GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Instance)!;
            await (Task)method.Invoke(owner, path == "scan" ? new object[] { "http://seerr.test", "test", SeerrScanTriggerService.ScanJobId } : new object[] { "603" })!;
        });
        await parsed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var committed = false;
        var transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => { config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 1; committed = true; }, default);
        var committedBeforeProcessing = committed;
        release.Set();
        await transition.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.False(committedBeforeProcessing);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
    }
    [Fact]
    public void BootstrapDiscardsCachedProviderFactsIfAdoptionCommitsDuringSharedPrefetch()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.JellyseerrEnabled = config.JellyseerrShowReportButton = config.ActiveStreamsEnabled = true;
        config.JellyseerrUrls = "http://seerr.test"; config.JellyseerrApiKey = "test";
        typeof(JellyfinEnhancedController).GetField("_seerrStatusCache", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, ((bool, DateTime)?)(true, DateTime.UtcNow));
        var sessions = new Mock<MediaBrowser.Controller.Session.ISessionManager>();
        sessions.SetupGet(x => x.Sessions).Returns(() =>
        {
            EffectiveRequestsBackend.Shared.TransitionAsync(() =>
            {
                config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 1;
                JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
            }, default).GetAwaiter().GetResult();
            return Array.Empty<MediaBrowser.Controller.Session.SessionInfo>();
        });
        var controller = ApiAssetTests.Controller(f.Core, sessions.Object);
        var result = typeof(JellyfinEnhancedController).GetMethod("BuildBootstrapPrefetched", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(controller, new object[] { config, Guid.NewGuid(), "viewer", true });
        var json = JsonSerializer.SerializeToElement(result);
        Assert.Equal(JsonValueKind.Null, json.GetProperty("SeerrStatus").ValueKind);
        Assert.Equal(JsonValueKind.Null, json.GetProperty("SeerrUserStatus").ValueKind);
    }

    [Theory]
    [InlineData(0)][InlineData(1)]
    public async Task IdentifyUrlCannotReturnASeerrResultAfterItsBufferedResponseIsDisposed(int version)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.ArrBackendIsolationVersion = version;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.test"; config.JellyseerrApiKey = "test";
        var parsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var trap = new ApiRequestsBackendGateTests.Trap { OnSend = (r, _) => Task.FromResult<HttpResponseMessage>(r.RequestUri!.AbsolutePath == "/api/v1/status"
            ? new BarrierResponse(parsed, release) { Content = new StringContent("{}", Encoding.UTF8, "application/json") }
            : new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") }) };
        using var handler = new SeerrIsolationTransportHandler(EffectiveRequestsBackend.Shared, () => config) { InnerHandler = trap };
        var factory = new Mock<IHttpClientFactory>(); factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(handler, false));
        var controller = ApiAssetTests.Controller(f.Core, factory.Object);
        controller.HttpContext.User = TestCallers.Principal(Guid.NewGuid(), true);
        var read = Task.Run(() => controller.IdentifyUrl("http://seerr.test"));
        await parsed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try { await EffectiveRequestsBackend.Shared.TransitionAsync(() => { config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 1; }, default).WaitAsync(TimeSpan.FromSeconds(5)); }
        finally { release.Set(); }
        Assert.Equal(409, Assert.IsType<ObjectResult>(await read.WaitAsync(TimeSpan.FromSeconds(10))).StatusCode);
    }

    [Theory]
    [InlineData(0)][InlineData(1)]
    public async Task MigrationReadCannotReturnCompleteProviderSnapshotAfterAdoption(int version)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.ArrBackendIsolationVersion = version;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.test"; config.JellyseerrApiKey = "test";
        var parsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var transport = new IntegrationTransport((r, _) => Task.FromResult<HttpResponseMessage>(r.RequestUri!.AbsolutePath == "/api/v1/user"
            ? new BarrierResponse(parsed, release) { Content = new StringContent("{\"pageInfo\":{\"results\":0},\"results\":[]}", Encoding.UTF8, "application/json") }
            : IntegrationTransport.Response(r.RequestUri!.AbsolutePath == "/api/v1/settings/main" ? "{\"defaultPermissions\":0}" : "{\"pageInfo\":{\"results\":0},\"results\":[]}")));
        var read = Task.Run(() => new SeerrMigrationReader(transport).ReadAsync(config, default));
        await parsed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try { await EffectiveRequestsBackend.Shared.TransitionAsync(() => { config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 1; }, default).WaitAsync(TimeSpan.FromSeconds(5)); }
        finally { release.Set(); }
        await Assert.ThrowsAsync<BackendDisabledException>(() => read);
    }

}
