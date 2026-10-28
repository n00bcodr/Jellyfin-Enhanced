using System.Text;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationBackendEvidenceJoinTests
{
    private sealed class StartingBody(Stream stream, Action start) : StreamResponseBodyFeature(stream)
    {
        public override Task StartAsync(CancellationToken cancellationToken = default) { start(); return Task.CompletedTask; }
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task BothConfigurationBranchesDrainResponsesBeforeMutationWithoutHoldingOtherMonitors(bool drain)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr";
        config.ArrBackendIsolationVersion = 0;
        var backend = new EffectiveRequestsBackend(() => config);
        _ = backend.Current;
        var evidence = EvidenceRevision.Current;
        var facts = UserCacheRegistry.Begin().Generation;
        using var response = EvidenceRevision.TryAcquire(() => true);
        Assert.NotNull(response);
        var mutated = false;
        var writer = Task.Run(() => backend.TransitionAsync(() =>
        {
            config.ArrRequestBackend = "je";
            config.ArrBackendIsolationVersion = drain ? 1 : 0;
            mutated = true;
        }, default, () => drain));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1500));
            Assert.False(mutated);
            Assert.Equal(evidence, EvidenceRevision.Current);
            Assert.Equal(facts, UserCacheRegistry.Begin().Generation);
            // A completion callback can inspect backend/configuration while the transition serializer waits.
            var callback = Task.Run(() =>
            {
                Assert.Equal("seerr", backend.Current.Mode.ToString().ToLowerInvariant());
                lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock) Assert.False(mutated);
            });
            await callback.WaitAsync(TimeSpan.FromSeconds(1));
        }
        finally { response!.Dispose(); }
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(mutated);
        Assert.True(EvidenceRevision.Current > evidence);
        Assert.True(UserCacheRegistry.Begin().Generation > facts);
        Assert.False(EvidenceRevision.Advancing);
        Assert.Equal(0, EvidenceRevision.Outstanding);
    }

    private sealed class RedirectSink : HttpMessageHandler
    {
        internal int Sends;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Sends++;
            var response = new HttpResponseMessage(Sends == 1 ? System.Net.HttpStatusCode.Found : System.Net.HttpStatusCode.OK);
            if (Sends == 1) response.Headers.Location = new Uri("https://redirect-target.invalid/final");
            return Task.FromResult(response);
        }
    }

    [Theory]
    [InlineData(0, 2)] [InlineData(1, 1)]
    public async Task OwnedFallbackRedirectsRetainLegacyBehaviorAndRespectIsolation(int version, int sends)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrBackendIsolationVersion = version;
        using var sink = new RedirectSink();
        using var client = new HttpClient(new TmdbRedirectHandler { InnerHandler = sink });
        using var response = await client.GetAsync("https://source.invalid/start");
        Assert.Equal(sends, sink.Sends);
        Assert.Equal(version == 0 ? System.Net.HttpStatusCode.OK : System.Net.HttpStatusCode.Found, response.StatusCode);
    }

    [Fact]
    public async Task EmptyBackendCompositionLeavesTheRawTransportUnwrapped()
    {
        using var f = new ApiPluginFixture();
        var http = new DefaultHttpContext();
        using var original = new MemoryStream();
        http.Response.Body = original;
        var descriptor = new ControllerActionDescriptor { ControllerName = "JellyfinEnhanced", ActionName = nameof(JellyfinEnhancedController.IdentifyUrl), ControllerTypeInfo = typeof(JellyfinEnhancedController).GetTypeInfo(), MethodInfo = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.IdentifyUrl))! };
        var action = new ActionExecutingContext(new(http, new(), descriptor), new List<IFilterMetadata>(), new Dictionary<string, object?>(), new object());
        await new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, f.Core.Logger).OnActionExecutionAsync(action,
            () => Task.FromResult(new ActionExecutedContext(action, new List<IFilterMetadata>(), action.Controller) { Result = new EmptyResult() }));
        Assert.Null(PrivacyResponseGuard.Find(http));
        Assert.Same(original, http.Response.Body);
    }

    [Theory]
    [InlineData("serialization", true)] [InlineData("starting", true)]
    [InlineData("serialization", false)] [InlineData("starting", false)]
    public async Task OriginalBackendDependencyReachesTheOneHttpCommitOwner(string timing, bool backendChange)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.ArrBackendIsolationVersion = 1;
        using var bytes = new MemoryStream();
        var http = new DefaultHttpContext(); http.Request.Method = "GET";
        void Change()
        {
            if (backendChange) config.ArrRequestBackend = "je"; // Simulate an uncoordinated late host input.
            else EvidenceRevision.Advance(() => { });
        }
        http.Features.Set<IHttpResponseBodyFeature>(new StartingBody(bytes, () => { if (timing == "starting") Change(); }));
        using var guard = PrivacyResponseGuard.Of(http);
        PrivacyResponseGuard.Publication(http, new EvidencePublication(() => EvidenceRevision.Current.ToString(), Guid.NewGuid()));
        var descriptor = new ControllerActionDescriptor { ControllerName = "JellyfinEnhanced", ActionName = nameof(JellyfinEnhancedController.IdentifyUrl), ControllerTypeInfo = typeof(JellyfinEnhancedController).GetTypeInfo(), MethodInfo = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.IdentifyUrl))! };
        var action = new ActionExecutingContext(new(http, new(), descriptor), new List<IFilterMetadata>(), new Dictionary<string, object?>(), new object());
        await new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, f.Core.Logger).OnActionExecutionAsync(action, () =>
        {
            using var publication = SeerrFacts.BeginPublication();
            publication.EnlistEffective(EffectiveRequestsBackend.Shared.Current);
            publication.Publish(() => true);
            return Task.FromResult(new ActionExecutedContext(action, new List<IFilterMetadata>(), action.Controller) { Result = new OkObjectResult(new { title = "old-backend-sentinel" }) });
        });
        http.Response.Headers.ETag = "old-validator";
        http.Response.Headers.LastModified = "old-date";
        await http.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("old-backend-sentinel"));
        if (timing == "serialization") Change();
        await PrivacyResponseGuard.CommitAsync(http);
        Assert.True(guard.Stopped);
        Assert.Equal(backendChange ? 409 : 503, http.Response.StatusCode);
        Assert.False(http.Response.Headers.ContainsKey("ETag"));
        Assert.False(http.Response.Headers.ContainsKey("Last-Modified"));
        var body = Encoding.UTF8.GetString(bytes.ToArray());
        Assert.DoesNotContain("old-backend-sentinel", body);
        if (backendChange)
        {
            using var json = JsonDocument.Parse(body);
            Assert.Equal("configuration_changed", json.RootElement.GetProperty("code").GetString());
        }
        else Assert.Empty(body);
    }
}
