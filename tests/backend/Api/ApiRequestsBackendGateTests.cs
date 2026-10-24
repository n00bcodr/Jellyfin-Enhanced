using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;
using Microsoft.Extensions.Options;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiRequestsBackendGateTests
{
    [Theory]
    [InlineData(0, "je")][InlineData(0, "seerr")][InlineData(0, "status_only")][InlineData(0, "unknown")]
    [InlineData(1, "je")][InlineData(1, "seerr")][InlineData(1, "status_only")][InlineData(1, "unknown")]
    [InlineData(2, "je")][InlineData(-1, "seerr")]
    public void GateMatrixIsIndependentOfRequestFlagsAndDormantConnections(int version, string mode)
    {
        foreach (var flags in Enumerable.Range(0, 16))
        foreach (var connection in new[] { false, true })
        {
            var c = new PluginConfiguration { ArrBackendIsolationVersion = version, ArrRequestBackend = mode,
                ArrIntegrationEnabled = (flags & 1) != 0, ArrPhase1Enabled = (flags & 2) != 0,
                ArrPhase3Enabled = (flags & 4) != 0, JellyseerrEnabled = (flags & 8) != 0,
                JellyseerrUrls = connection ? "http://seerr.invalid" : "", JellyseerrApiKey = connection ? "test" : "" };
            var gate = new EffectiveRequestsBackend(() => c);
            var seerrAllowed = version == 0 || version == 1 && mode == "seerr";
            foreach (var use in Enum.GetValues<SeerrUse>()) Assert.Equal(seerrAllowed, gate.CheckSeerr(use).Allowed);
            Assert.Equal(seerrAllowed, gate.Current.AllowSeerrTransport);
            Assert.Equal(version is 0 or 1 && mode == "je" && (flags & 7) == 7, gate.CheckDirectRequest().Allowed);
            Assert.Equal(version == 1 && mode == "je", gate.Current.StrictJe);
        }
    }

    [Fact]
    public void MissingIsolationPropertyNeverAdoptsOnJsonXmlOrOrdinarySave()
    {
        var json = JsonSerializer.Deserialize<PluginConfiguration>("{\"ArrRequestBackend\":\"je\",\"JellyseerrEnabled\":true}")!;
        var xml = (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(new StringReader("<PluginConfiguration><ArrRequestBackend>je</ArrRequestBackend><JellyseerrEnabled>true</JellyseerrEnabled></PluginConfiguration>"))!;
        foreach (var c in new[] { new PluginConfiguration(), json, xml })
        {
            Assert.Equal(0, c.ArrBackendIsolationVersion);
            Assert.True(EffectiveRequestsBackend.AllowsSeerr(c));
            var again = JsonSerializer.Deserialize<PluginConfiguration>(JsonSerializer.Serialize(c))!;
            Assert.Equal(0, again.ArrBackendIsolationVersion);
        }
        using var f = new ApiPluginFixture();
        f.Plugin.UpdateConfiguration(json);
        Assert.Equal(0, f.Plugin.Configuration.ArrBackendIsolationVersion);
        Assert.True(f.Plugin.Configuration.JellyseerrEnabled);
    }

    internal sealed class Trap : HttpMessageHandler
    {
        public int Calls;
        public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? OnSend;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        { Calls++; return OnSend?.Invoke(request, ct) ?? Task.FromResult(IntegrationTransport.Response()); }
    }

    [Theory]
    [InlineData("GET")][InlineData("HEAD")][InlineData("POST")][InlineData("PATCH")][InlineData("DELETE")]
    public async Task ExplicitAndUnmarkedSeerrCannotReachTransportWhileTmdbAndCoHostedArrStillWork(string method)
    {
        var c = new PluginConfiguration { ArrRequestBackend = "je", ArrBackendIsolationVersion = 1, JellyseerrUrls = "http://shared.test/seerr\nhttp://backup.test" };
        var backend = new EffectiveRequestsBackend(() => c);
        using var trap = new Trap();
        using var http = new HttpClient(new SeerrIsolationTransportHandler(backend, () => c) { InnerHandler = trap });
        foreach (var target in new[] { "http://shared.test/seerr/api/v1/status", "http://backup.test/avatar.png" })
            Assert.Equal("backend_disabled", (await Assert.ThrowsAsync<BackendDisabledException>(() => http.SendAsync(new(new HttpMethod(method), target)))).Reason);
        using var tagged = new HttpRequestMessage(new HttpMethod(method), "http://not-retained.test/api/v1/status");
        SeerrIsolationTransportHandler.Mark(tagged, SeerrUse.Diagnostics);
        await Assert.ThrowsAsync<BackendDisabledException>(() => http.SendAsync(tagged));
        Assert.Equal(0, trap.Calls);
        foreach (var target in new[] { "http://shared.test/sonarr/api/v3/series", "https://api.themoviedb.org/3/movie/603", "http://jellyfin.test/System/Info/Public" })
            Assert.True((await http.GetAsync(target)).IsSuccessStatusCode);
        Assert.Equal(3, trap.Calls);
        c.ArrBackendIsolationVersion = 0;
        Assert.True((await http.GetAsync("http://shared.test/seerr/api/v1/status")).IsSuccessStatusCode);
        Assert.Equal(4, trap.Calls);
    }

    [Fact]
    public async Task AdmissionTransitionDrainsBeforeCommitAndRejectsLateResponsesAndRetries()
    {
        var c = new PluginConfiguration { ArrRequestBackend = "seerr", ArrBackendIsolationVersion = 1 };
        var backend = new EffectiveRequestsBackend(() => c);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var trap = new Trap { OnSend = async (_, ct) => { entered.SetResult(); using var registration = ct.Register(() => cancelled.SetResult()); await release.Task; return IntegrationTransport.Response(); } };
        using var http = new HttpClient(new SeerrIsolationTransportHandler(backend, () => c) { InnerHandler = trap });
        using var req = new HttpRequestMessage(HttpMethod.Get, "http://seerr.test/api/v1/request");
        SeerrIsolationTransportHandler.Mark(req, SeerrUse.RequestRead);
        var send = http.SendAsync(req);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var committed = false;
        var transition = backend.TransitionAsync(() => { c.ArrRequestBackend = "je"; committed = true; }, default);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(committed);
        Assert.False(backend.CheckSeerr(SeerrUse.Status).Allowed);
        release.SetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => send);
        await transition.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(committed);
        using var retry = new HttpRequestMessage(HttpMethod.Get, "http://seerr.test/api/v1/request");
        SeerrIsolationTransportHandler.Mark(retry, SeerrUse.RequestRead);
        await Assert.ThrowsAsync<BackendDisabledException>(() => http.SendAsync(retry));
        Assert.Equal(1, trap.Calls);
    }

    [Fact]
    public async Task RegisteredNamedDefaultAndDirectListSeerrClientAreGuardedBeforeTheirTerminalHandler()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrRequestBackend = "je"; f.Plugin.Configuration.ArrBackendIsolationVersion = 1;
        f.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
        var services = new ServiceCollection();
        new PluginServiceRegistrator().RegisterServices(services, null!);
        services.AddSingleton(f.Core.Logger);
        var trap = new Trap();
        foreach (var name in new[] { "", SeerrHttpHelper.NamedClient })
            services.AddHttpClient(name).ConfigurePrimaryHttpMessageHandler(() => trap);
        using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();
        foreach (var name in new[] { "", SeerrHttpHelper.NamedClient })
        {
            using var client = factory.CreateClient(name);
            await Assert.ThrowsAsync<BackendDisabledException>(() => client.GetAsync("http://seerr.test/avatar.png"));
        }
        Assert.Equal(0, trap.Calls);
        var fallback = new Mock<IHttpClientFactory>();
        fallback.Setup(f => f.CreateClient(SeerrHttpHelper.NamedClient)).Throws(new InvalidOperationException("named unavailable"));
        fallback.Setup(f => f.CreateClient("")).Returns(() => factory.CreateClient(""));
        using var unnamed = SeerrHttpHelper.CreateClient(fallback.Object);
        await Assert.ThrowsAsync<BackendDisabledException>(() => unnamed.GetAsync("http://seerr.test/api/v1/status"));
        Assert.Equal(0, trap.Calls);
    }

    [Fact]
    public async Task EveryDeclaredLegacySeerrActionRefusesBeforeItRunsIncludingMisnamedTmdbRoutes()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrRequestBackend = "je"; f.Plugin.Configuration.ArrBackendIsolationVersion = 1;
        var filter = new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, f.Core.Logger);
        var actions = typeof(JellyfinEnhancedController).Assembly.GetTypes().Where(t => typeof(ControllerBase).IsAssignableFrom(t))
            .SelectMany(t => t.GetMethods().Select(m => new ControllerActionDescriptor { ControllerTypeInfo = t.GetTypeInfo(), MethodInfo = m }))
            .Where(SeerrIsolationActionFilter.IsSeerrAction).ToList();
        Assert.True(actions.Count >= 60, "Inventory lost a Seerr entry point");
        foreach (var action in actions)
        {
            var context = new ActionExecutingContext(new(new DefaultHttpContext(), new RouteData(), action), new List<IFilterMetadata>(), new Dictionary<string, object?>(), new object());
            await filter.OnActionExecutionAsync(context, () => throw new Xunit.Sdk.XunitException("A disabled Seerr action ran: " + action.MethodInfo.Name));
            Assert.Equal(409, Assert.IsType<ObjectResult>(context.Result).StatusCode);
        }
    }

    [Fact]
    public async Task ManualTasksImportReaderAndScanStayDormantWithAllRetainedSeerrFlags()
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.ArrRequestBackend = "je"; c.ArrBackendIsolationVersion = 1;
        c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.JellyseerrEnabled = true;
        c.JellyseerrAutoImportUsers = c.SyncJellyseerrWatchlist = c.SyncJellyfinWatchlistToSeerr = c.TriggerSeerrScanOnItemAdded = true;
        c.JellyseerrUrls = "http://first.test\nhttp://second.test"; c.JellyseerrApiKey = "test";
        using var transport = new IntegrationTransport((_, _) => throw new Xunit.Sdk.XunitException("Seerr terminal dispatch"));
        var users = Mock.Of<IUserManager>(); var library = Mock.Of<ILibraryManager>(); var data = Mock.Of<IUserDataManager>();
        var parts = new object[] { users, library, data, transport, f.Core.Logger, f.Core.Manager };
        await Wiring.Make<JellyseerrUserImportTask>(parts).ExecuteAsync(new Progress<double>(), default);
        await Wiring.Make<JellyseerrWatchlistSyncTask>(parts).ExecuteAsync(new Progress<double>(), default);
        await Wiring.Make<JellyfinToSeerrWatchlistSyncTask>(parts).ExecuteAsync(new Progress<double>(), default);
        var result = await JellyseerrUserImportHelper.BulkImportAsync(new() { Guid.NewGuid().ToString("N") }, new[] { "http://first.test" }, "test", transport, f.Core.Logger);
        Assert.Contains("backend_disabled", result.Errors);
        using var model = new SeerrRequestReadModel(transport, new ArrChangeFeed(), null, () => c, () => DateTimeOffset.UtcNow);
        model.Touch(); model.RequestRefresh();
        Assert.False(model.Active); Assert.Null(model.WatchedAt); Assert.Null(model.RequestedAt);
        Assert.False(await model.RefreshAsync(default));
        using var scan = new SeerrScanTriggerService(library, transport, f.Core.Logger, new RequestOutboxEvents(), () => DateTimeOffset.UtcNow, () => c);
        scan.Nudge(SeerrScanTriggerService.ScanJobId);
        await scan.FireAsync(SeerrScanTriggerService.ScanJobId);
        Assert.Empty(await scan.TriggerNowAsync());
        Assert.Equal(0, transport.Calls);
    }
    [Theory]
    [InlineData(0, false)][InlineData(1, true)]
    public async Task AdmissionCoversResponseBodyAndLegacySharedRedirectCandidates(int version, bool marked)
    {
        var c = new PluginConfiguration { ArrRequestBackend = "seerr", ArrBackendIsolationVersion = version };
        var backend = new EffectiveRequestsBackend(() => c);
        using var trap = new Trap();
        using var client = new HttpClient(new SeerrIsolationTransportHandler(backend, () => c) { InnerHandler = trap });
        using var request = new HttpRequestMessage(HttpMethod.Get, "http://shared.test/resource");
        if (marked) SeerrIsolationTransportHandler.Mark(request, SeerrUse.RequestRead);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        using var stream = await response.Content.ReadAsStreamAsync();
        var committed = false;
        var transition = backend.TransitionAsync(() => { c.ArrRequestBackend = "je"; c.ArrBackendIsolationVersion = 1; committed = true; }, default);
        Assert.False(committed);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await stream.ReadAsync(new byte[4]));
        await transition.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(committed);
        Assert.Equal(1, trap.Calls);
    }

    [Fact]
    public async Task DormantLinkedAccountCacheCannotEscapeStrictJeEntryChecks()
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration; c.ArrRequestBackend = "je";
        var type = typeof(JellyfinEnhancedController);
        var cache = (Dictionary<string, (string, DateTime)>)type.GetField("_userIdCache", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
        var id = Guid.NewGuid().ToString("N"); cache[id] = ("7", DateTime.UtcNow);
        var read = type.GetMethod("TryGetCachedJellyseerrUserId", BindingFlags.NonPublic | BindingFlags.Static)!;
        try
        {
            Assert.Equal("7", read.Invoke(null, new object[] { id }));
            c.ArrBackendIsolationVersion = 1;
            Assert.Null(read.Invoke(null, new object[] { id }));
            var controller = ApiAssetTests.Controller(f.Core);
            var lookup = type.GetMethod("GetJellyseerrUserId", BindingFlags.NonPublic | BindingFlags.Instance)!;
            Assert.Null(await (Task<string?>)lookup.Invoke(controller, new object[] { id })!);
        }
        finally { cache.Remove(id); }
    }

    [Fact]
    public async Task BufferedProxyCannotPublishCacheOrReturnProviderDataAfterAdoption()
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.JellyseerrEnabled = true; c.JellyseerrUrls = "http://seerr.test"; c.JellyseerrApiKey = "test";
        var user = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>(); users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var cacheLock = typeof(JellyfinEnhancedController).GetField("_responseCacheLock", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        var cache = (System.Collections.IDictionary)typeof(JellyfinEnhancedController).GetField("_responseCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        var blocked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        Task? holder = null;
        using var transport = new IntegrationTransport(async (request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user") return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = user.Id.ToString("N"), permissions = 2 } } }));
            holder = Task.Run(() => { lock (cacheLock) { blocked.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException(); } });
            await blocked.Task;
            return IntegrationTransport.Response("{\"id\":989988,\"title\":\"old-provider-publication-sentinel\"}");
        });
        var parental = new SeerrParentalFilter(transport, users.Object, Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(), f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, transport, users.Object, parental);
        controller.HttpContext.User = TestCallers.Principal(user.Id, true);
        var method = typeof(JellyfinEnhancedController).GetMethod("ProxyJellyseerrRequestCore", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var run = Task.Run(async () => await (Task<IActionResult>)method.Invoke(controller, new object?[] { "/api/v1/movie/989988", HttpMethod.Get, null, null })!);
        await blocked.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrRequestBackend = "je"; c.ArrBackendIsolationVersion = 1; }, default);
        release.Set();
        var result = await run.WaitAsync(TimeSpan.FromSeconds(10));
        await transition.WaitAsync(TimeSpan.FromSeconds(10));
        await holder!;
        lock (cacheLock) Assert.DoesNotContain(cache.Keys.Cast<string>(), key => key.EndsWith(":/api/v1/movie/989988", StringComparison.Ordinal));
        Assert.Equal(409, Assert.IsType<ObjectResult>(result).StatusCode);
    }

    [Fact]
    public void EarlyBuilderDenialIsSafeAndBounded()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrBackendIsolationVersion = 1; f.Plugin.Configuration.ArrRequestBackend = "je";
        var logger = new Mock<Microsoft.Extensions.Logging.ILogger<EffectiveRequestsBackend>>();
        EffectiveRequestsBackend.Shared.WithLogger(logger.Object);
        try
        {
            for (var i = 0; i < 2; i++) Assert.Throws<BackendDisabledException>(() => SeerrHttpHelper.BuildRequest(HttpMethod.Get, "http://private-connection.test", "private-credential"));
            var entry = Assert.Single(logger.Invocations.Where(i => i.Method.Name == "Log"));
            Assert.Equal(Microsoft.Extensions.Logging.LogLevel.Information, entry.Arguments[0]);
            var message = entry.Arguments[2].ToString()!;
            Assert.Contains(nameof(EarlyBuilderDenialIsSafeAndBounded)[..20], message);
            Assert.Contains("backend=je", message); Assert.Contains("version=1", message); Assert.Contains("reason=backend_disabled", message);
            Assert.DoesNotContain("private-connection", message); Assert.DoesNotContain("private-credential", message);
        }
        finally { EffectiveRequestsBackend.Shared.WithLogger(Microsoft.Extensions.Logging.Abstractions.NullLogger<EffectiveRequestsBackend>.Instance); }
    }

    private sealed class PublicationBarrierResponse(TaskCompletionSource parsed, ManualResetEventSlim release) : HttpResponseMessage(System.Net.HttpStatusCode.OK)
    {
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                parsed.TrySetResult();
                if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            }
            base.Dispose(disposing);
        }
    }

    [Fact]
    public async Task ReturnedProviderSettingsCannotCrossAdoptionAfterBodyWasBuffered()
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab();
        var parsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult<HttpResponseMessage>(new PublicationBarrierResponse(parsed, release)
        { Content = new StringContent("{\"partialRequestsEnabled\":false}", System.Text.Encoding.UTF8, "application/json") }));
        var backend = new SeerrBackend(transport, lab.Model, null, () => lab.Config, () => lab.Now);
        var read = Task.Run(() => backend.WholeSeriesOnlyAsync(default));
        await parsed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => { lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 1; }, default);
        release.Set();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await read.WaitAsync(TimeSpan.FromSeconds(10)));
        await transition.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Null(backend.FourKServer(true));
    }

}
