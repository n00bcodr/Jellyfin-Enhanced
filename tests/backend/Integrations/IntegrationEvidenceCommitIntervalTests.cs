using Microsoft.AspNetCore.Hosting;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationEvidenceCommitIntervalTests
{
    private sealed class Lifecycle : HttpResponseFeature
    {
        private readonly List<(Func<object, Task> Callback, object State)> _completed = new();
        public override void OnCompleted(Func<object, Task> callback, object state) => _completed.Add((callback, state));
        public async Task Complete()
        {
            foreach (var entry in _completed.AsEnumerable().Reverse()) await entry.Callback(entry.State);
        }
    }

    private sealed class Response : IDisposable
    {
        internal readonly Lifecycle Lifecycle = new();
        internal readonly CancellationTokenSource Abort = new();
        internal HttpContext Http { get; }
        internal PrivacyResponseGuard Guard { get; }
        internal Response(Stream? transport = null)
        {
            var http = new DefaultHttpContext();
            http.Features.Set<IHttpResponseFeature>(Lifecycle);
            http.Features.Set<IHttpResponseBodyFeature>(new StreamResponseBodyFeature(transport ?? new MemoryStream()));
            http.RequestAborted = Abort.Token;
            Http = http;
            Guard = PrivacyResponseGuard.Of(http);
            PrivacyResponseGuard.Publication(http, new EvidencePublication(() => EvidenceRevision.Current.ToString(), Guid.NewGuid()));
        }
        internal async Task Commit()
        {
            await Http.Response.Body.WriteAsync("title"u8.ToArray());
            await PrivacyResponseGuard.CommitAsync(Http);
        }
        public void Dispose() { Guard.Dispose(); Abort.Dispose(); }
    }

    [Theory]
    [InlineData("completed")] [InlineData("abort")] [InlineData("dispose")] [InlineData("stream-dispose")]
    [InlineData("stream-dispose-async")] [InlineData("exception")] [InlineData("mvc-exception")]
    public async Task TokenLivesThroughCommitAndNeverOutlivesItsRequest(string ending)
    {
        Assert.Equal(0, EvidenceRevision.Outstanding);
        using var r = new Response(ending == "exception" ? new BrokenTransport() : null);
        if (ending == "exception") await Assert.ThrowsAsync<IOException>(r.Commit);
        else
        {
            await r.Commit();
            Assert.Equal(1, EvidenceRevision.Outstanding);
            switch (ending)
            {
                case "completed": await r.Lifecycle.Complete(); break;
                case "abort": r.Abort.Cancel(); break;
                case "dispose": r.Guard.Dispose(); break;
                case "stream-dispose": r.Http.Response.Body.Dispose(); break;
                case "stream-dispose-async": await r.Http.Response.Body.DisposeAsync(); break;
                case "mvc-exception":
                    var context = new ActionContext(r.Http, new(), new());
                    await Assert.ThrowsAsync<IOException>(() => new PrivacyCommitFilter().OnResourceExecutionAsync(
                        new ResourceExecutingContext(context, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>()),
                        () => throw new IOException("result failed after a declared-length commit")));
                    break;
            }
        }
        await r.Lifecycle.Complete(); // completion after abort/disposal is idempotent
        r.Guard.Dispose();
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    private sealed class BrokenTransport : MemoryStream
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> bytes, CancellationToken ct = default) => throw new IOException("client disconnected");
    }

    [Fact]
    public async Task AlreadyAbortedRequestCannotTakeAToken()
    {
        using var r = new Response();
        r.Abort.Cancel();
        await r.Commit();
        Assert.True(r.Guard.Stopped);
        Assert.Equal(503, r.Http.Response.StatusCode);
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    [Fact]
    public async Task AdvanceBlocksNewTokensAndWaitsForOnCompleted()
    {
        using var r = new Response();
        await r.Commit();
        var before = EvidenceRevision.Current;
        var changed = false;
        var writer = Task.Run(() => EvidenceRevision.Advance(() => changed = true));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1000));
            using var later = new Response();
            await later.Commit();
            Assert.True(later.Guard.Stopped);
            Assert.Equal(503, later.Http.Response.StatusCode);
            Assert.False(changed);
            Assert.Equal(before, EvidenceRevision.Current);
        }
        finally { await r.Lifecycle.Complete(); }
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(changed);
        Assert.True(EvidenceRevision.Current > before);
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    [Fact]
    public async Task HungResponseExpiresTheDrainBoundAndLogsTheOutstandingCount()
    {
        using var f = new ApiPluginFixture();
        using var r = new Response();
        await r.Commit();
        var before = EvidenceRevision.Current;
        var clock = Stopwatch.StartNew();
        EvidenceRevision.Advance(() => { }, f.Core.Logger);
        Assert.InRange(clock.ElapsedMilliseconds, EvidenceRevision.DrainMilliseconds - 50, EvidenceRevision.DrainMilliseconds + 1500);
        Assert.True(EvidenceRevision.Current > before);
        Assert.False(EvidenceRevision.Advancing);
        Assert.Equal(1, EvidenceRevision.Outstanding); // expiry does not fabricate response completion
        Assert.Contains("outstanding responses: 1", File.ReadAllText(f.Core.Logger.CurrentLogFilePath));
        await r.Lifecycle.Complete();
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    [Theory]
    [InlineData("save")] [InlineData("replace")] [InlineData("patch")] [InlineData("restore")] [InlineData("secret")] [InlineData("rollback")]
    public async Task EveryPluginConfigurationWriterEntersBeforeItsMutation(string path)
    {
        using var f = new ApiPluginFixture();
        using var r = new Response();
        await r.Commit();
        var before = EvidenceRevision.Current;
        var replacement = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        replacement.TMDB_API_KEY = "replacement-test-value";
        var writer = Task.Run(() =>
        {
            switch (path)
            {
                case "save": f.Plugin.SaveConfiguration(); break;
                case "replace": f.Plugin.UpdateConfiguration(replacement); break;
                case "patch": f.Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { ["TMDB_API_KEY"] = JsonDocument.Parse("\"patch-test-value\"").RootElement.Clone() } }); break;
                case "restore": f.Plugin.RestoreConfiguration(replacement, Array.Empty<string>()); break;
                case "secret": f.Plugin.Secrets.Set("TMDB_API_KEY", "secret-test-value"); break;
                case "rollback": f.Plugin.RollbackSecretsToConfiguration(); break;
            }
        });
        try
        {
            Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1000));
            await Task.Delay(75);
            Assert.False(writer.IsCompleted);
            Assert.Equal(before, EvidenceRevision.Current);
        }
        finally { await r.Lifecycle.Complete(); }
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(EvidenceRevision.Current > before);
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

#if JF12
    // These run Jellyfin 12.2's own host code (the pinned release's Emby.Server.Implementations and Jellyfin.Api, .NET 10);
    // a 10.11 build cannot load them.
    [Fact]
    public async Task PinnedJellyfinCountryReplacementUsesTheSameWriterBarrier()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrRequestBackend = "je";
        var host = Assembly.LoadFrom(JellyfinApiAssembly.Pinned("jf12").Path.Replace("Jellyfin.Api.dll", "Emby.Server.Implementations.dll"));
        var paths = Activator.CreateInstance(host.GetType("Emby.Server.Implementations.ServerApplicationPaths", true)!,
            Enumerable.Range(0, 5).Select(i => (object)Path.Combine(f.Core.Root, "host-" + i)).ToArray());
        var xml = new Mock<IXmlSerializer>();
        var manager = (IServerConfigurationManager)Activator.CreateInstance(host.GetType("Emby.Server.Implementations.Configuration.ServerConfigurationManager", true)!, paths, NullLoggerFactory.Instance, xml.Object)!;
        manager.Configuration.MetadataCountryCode = "US";
        _ = new SeerrParentalFilter(Mock.Of<IHttpClientFactory>(), Mock.Of<IUserManager>(), Mock.Of<ILocalizationManager>(), manager, f.Core.Logger);
        using var r = new Response();
        await r.Commit();
        var writer = Task.Run(() => manager.ReplaceConfiguration(new ServerConfiguration { MetadataCountryCode = "AU" }));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1000));
            Assert.Equal("US", manager.Configuration.MetadataCountryCode);
            Assert.False(writer.IsCompleted);
        }
        finally { await r.Lifecycle.Complete(); }
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("AU", manager.Configuration.MetadataCountryCode);
        Assert.True(SpinWait.SpinUntil(() => !EvidenceRevision.Advancing, 1500));
    }

    [Fact]
    public async Task FailedHostReplacementCanRetryTheSameConfigurationAfterCleanup()
    {
        using var f = new ApiPluginFixture();
        var host = Assembly.LoadFrom(JellyfinApiAssembly.Pinned("jf12").Path.Replace("Jellyfin.Api.dll", "Emby.Server.Implementations.dll"));
        var paths = Activator.CreateInstance(host.GetType("Emby.Server.Implementations.ServerApplicationPaths", true)!,
            Enumerable.Range(0, 5).Select(i => (object)Path.Combine(f.Core.Root, "retry-host-" + i)).ToArray());
        var manager = (IServerConfigurationManager)Activator.CreateInstance(host.GetType("Emby.Server.Implementations.Configuration.ServerConfigurationManager", true)!, paths, NullLoggerFactory.Instance, Mock.Of<IXmlSerializer>())!;
        manager.Configuration.MetadataCountryCode = "US";
        _ = new SeerrParentalFilter(Mock.Of<IHttpClientFactory>(), Mock.Of<IUserManager>(), Mock.Of<ILocalizationManager>(), manager, f.Core.Logger);
        var incoming = new ServerConfiguration { MetadataCountryCode = "AU", CachePath = Path.Combine(f.Core.Root, "does-not-exist") };
        Assert.Throws<DirectoryNotFoundException>(() => manager.ReplaceConfiguration(incoming));
        Assert.Equal("US", manager.Configuration.MetadataCountryCode);
        Assert.True(EvidenceRevision.Advancing);
        await Task.Delay(EvidenceRevision.DrainMilliseconds + 150);
        Assert.False(EvidenceRevision.Advancing);
        // The old weak-table key may still be live in a caller. Its expired lease must not discard the retry's new lease.
        var observe = new EventHandler<Jellyfin.Data.Events.GenericEventArgs<ServerConfiguration>>((_, _) =>
        {
            Assert.True(EvidenceRevision.Advancing, "Retry reopened token admission before the host actually replaced the country.");
            Assert.Equal("US", manager.Configuration.MetadataCountryCode);
        });
        manager.GetType().GetEvent("ConfigurationUpdating")!.AddEventHandler(manager, observe);
        incoming.CachePath = string.Empty;
        manager.ReplaceConfiguration(incoming);
        Assert.Equal("AU", manager.Configuration.MetadataCountryCode);
        Assert.True(SpinWait.SpinUntil(() => !EvidenceRevision.Advancing, 1500));
    }

    [Fact]
    public async Task PinnedLegacyStartupCountryWriterIsBracketedBeforeItsInPlaceMutation()
    {
        using var f = new ApiPluginFixture();
        var api = Assembly.LoadFrom(JellyfinApiAssembly.Pinned("jf12").Path);
        var controllerType = api.GetType("Jellyfin.Api.Controllers.StartupController", true)!;
        var server = new ServerConfiguration { MetadataCountryCode = "US" };
        var manager = new Mock<IServerConfigurationManager>(); manager.SetupGet(m => m.Configuration).Returns(server);
        var controller = Activator.CreateInstance(controllerType, manager.Object, Mock.Of<IUserManager>())!;
        var dto = Activator.CreateInstance(api.GetType("Jellyfin.Api.Models.StartupDtos.StartupConfigurationDto", true)!)!;
        dto.GetType().GetProperty("MetadataCountryCode")!.SetValue(dto, "AU");
        var http = new DefaultHttpContext(); http.Request.Method = "POST";
        var action = new ActionContext(http, new(), new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
        { ControllerName = "Startup", ActionName = "UpdateInitialConfiguration", ControllerTypeInfo = controllerType.GetTypeInfo() });
        var filters = new List<IFilterMetadata>();
        var context = new ActionExecutingContext(action, filters, new Dictionary<string, object?>(), controller);
        using var response = new Response();
        await response.Commit();
        var writer = Task.Run(() => new HostConfigurationRouteFilter(null, f.Core.Logger).OnActionExecutionAsync(context, () =>
        {
            controllerType.GetMethod("UpdateInitialConfiguration")!.Invoke(controller, new[] { dto });
            return Task.FromResult(new ActionExecutedContext(action, filters, controller));
        }));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1000));
            Assert.Equal("US", server.MetadataCountryCode);
            Assert.False(writer.IsCompleted);
        }
        finally { await response.Lifecycle.Complete(); }
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("AU", server.MetadataCountryCode);
        Assert.False(EvidenceRevision.Advancing);
    }
#endif

    [Fact]
    public async Task NestedThrowingAndOverlappingWritersReopenAdmissions()
    {
        using var r = new Response();
        await r.Commit();
        var first = Task.Run(() => EvidenceRevision.Advance(() => EvidenceRevision.Advance(() => throw new IOException("save failed"))));
        var second = Task.Run(() => EvidenceRevision.Advance(() => { }));
        try { Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1000)); }
        finally { await r.Lifecycle.Complete(); }
        await Assert.ThrowsAsync<IOException>(() => first);
        await second;
        Assert.False(EvidenceRevision.Advancing);
        Assert.Equal(0, EvidenceRevision.Outstanding);
        using var next = new Response();
        await next.Commit();
        Assert.Equal(1, EvidenceRevision.Outstanding);
    }

    [Theory]
    [InlineData(504)] [InlineData(429)]
    public async Task RegeneratedTitleFreeTransientTakesNoToken(int status)
    {
        using var r = new Response();
        var context = new ResultExecutingContext(new ActionContext(r.Http, new(), new()), new List<IFilterMetadata>(),
            new ObjectResult(new Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.ListErrorDto { Code = "parental_pending", Message = "discard private title" }) { StatusCode = status }, new object());
        Assert.False(PrivacyResponseGuard.BeforeResult(context));
        await r.Commit();
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    [Fact]
    public async Task BodylessSuccessfulWriteAcknowledgementTakesNoTokenWhileWriterIsPending()
    {
        using var r = new Response();
        r.Http.Request.Method = "POST";
        using var writer = EvidenceRevision.Advance();
        var action = new ActionContext(r.Http, new(), new());
        var context = new ResultExecutingContext(action, new List<IFilterMetadata>(), new NoContentResult(), new object());
        Assert.True(PrivacyResponseGuard.BeforeResult(context));
        r.Http.Response.StatusCode = 204;
        await PrivacyResponseGuard.CommitAsync(r.Http);
        Assert.Equal(204, r.Http.Response.StatusCode);
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    [Fact]
    public async Task LongPollHasNoIdleTokenAndRechecksEachMessage()
    {
        using var r = new Response();
        Assert.Equal(0, EvidenceRevision.Outstanding);
        EvidenceRevision.Advance(() => { }); // country/source changes while waiting for a message
        Assert.False(r.Guard.Holds());
        PrivacyResponseGuard.BeginMessage(r.Http);
        Assert.True(r.Guard.Holds());
        Assert.Equal(0, EvidenceRevision.Outstanding);
        await r.Commit();
        Assert.Equal(1, EvidenceRevision.Outstanding); // only the bounded final batch, never the idle poll
        await r.Lifecycle.Complete();
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    [Fact]
    public async Task RealKestrelClientDisconnectReleasesBeforeTheRequestUnwinds()
    {
        var committed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var aborted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var unwind = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var server = new Microsoft.AspNetCore.Hosting.WebHostBuilder().UseKestrel().UseUrls("http://127.0.0.1:0")
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                var guard = PrivacyResponseGuard.Of(http);
                PrivacyResponseGuard.Publication(http, new EvidencePublication(() => EvidenceRevision.Current.ToString()));
                http.Response.ContentLength = 10000;
                await http.Response.Body.WriteAsync("part"u8.ToArray());
                await PrivacyResponseGuard.CommitAsync(http);
                committed.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, http.RequestAborted); }
                catch (OperationCanceledException) { aborted.TrySetResult(); }
                await unwind.Task.WaitAsync(TimeSpan.FromSeconds(5));
            })).Build();
        await server.StartAsync();
        var address = server.ServerFeatures.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient();
        try
        {
            var response = await client.GetAsync(address, HttpCompletionOption.ResponseHeadersRead);
            await committed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(1, EvidenceRevision.Outstanding);
            response.Dispose();
            await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(0, EvidenceRevision.Outstanding);
            Assert.False(unwind.Task.IsCompleted);
        }
        finally { unwind.TrySetResult(); }
    }

    [Fact]
    public async Task AbandonedHostUpdateHasBoundedCleanup()
    {
        using var f = new ApiPluginFixture();
        var clock = Stopwatch.StartNew();
        using var writer = EvidenceRevision.Advance(f.Core.Logger, hostUpdate: true);
        Assert.True(EvidenceRevision.Advancing);
        await Task.Delay(EvidenceRevision.DrainMilliseconds + 150);
        Assert.False(EvidenceRevision.Advancing);
        Assert.InRange(clock.ElapsedMilliseconds, EvidenceRevision.DrainMilliseconds, EvidenceRevision.DrainMilliseconds + 1500);
        Assert.Contains("bounded cleanup", File.ReadAllText(f.Core.Logger.CurrentLogFilePath));
    }
}
