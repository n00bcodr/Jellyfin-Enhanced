using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

/// <summary>Stage timings never reach another user through a shared HTTP cache, and cost nothing while off (STR-1, STR-2).</summary>
[Collection("Plugin singleton")]
public class NativeDetailsStageTimingsCacheTests
{
    // A single-entry shared HTTP cache outside the origin pipeline: it sees the final wire headers (as a proxy does) and keeps
    // a public, fresh answer without Vary, then serves it to the next caller without asking the origin.
    private sealed class SharedCache(HttpMessageHandler origin) : DelegatingHandler(origin)
    {
        private HttpResponseMessage? _saved;
        private Uri? _address;
        private DateTimeOffset _until;

        private static HttpResponseMessage Copy(HttpResponseMessage source, byte[] bytes)
        {
            var result = new HttpResponseMessage(source.StatusCode) { Content = new ByteArrayContent(bytes) };
            foreach (var header in source.Headers) result.Headers.TryAddWithoutValidation(header.Key, header.Value);
            foreach (var header in source.Content.Headers) result.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            return result;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (_saved != null && _address == request.RequestUri && DateTimeOffset.UtcNow < _until)
                return Copy(_saved, await _saved.Content.ReadAsByteArrayAsync(ct));
            var response = await base.SendAsync(request, ct);
            if (request.Method == HttpMethod.Get && response.IsSuccessStatusCode
                && response.Headers.CacheControl is { Public: true, Private: false, NoStore: false, MaxAge: { } age }
                && response.Headers.Vary.Count == 0 && !response.Headers.Contains("Set-Cookie"))
            {
                _saved?.Dispose();
                _saved = Copy(response, await response.Content.ReadAsByteArrayAsync(ct));
                _address = request.RequestUri;
                _until = DateTimeOffset.UtcNow + age;
            }
            return response;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _saved?.Dispose();
            base.Dispose(disposing);
        }
    }

    private sealed class Assets(CoreFixture fixture, Action onCreate) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            onCreate();
            var controller = ApiAssetTests.Controller(fixture);
            controller.ControllerContext = context;
            return controller;
        }

        public void Release(ControllerContext context, object controller) { }
    }

    [Fact]
    public async Task StageTimingsOfAnAdministratorNeverReachAViewerThroughASharedCache()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.StageTimingsEnabled = true;
        var origins = 0;
        using var server = new TestServer(new WebHostBuilder().ConfigureServices(s =>
        {
            s.AddLogging();
            s.AddRouting();
            s.AddAuthorization();
            s.AddControllers(o =>
            {
                o.Filters.Add(new StageTimingsFilter());
                o.Filters.Add(new PrivacyCommitFilter());
            }).AddApplicationPart(typeof(Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController).Assembly);
            s.AddSingleton<IControllerActivator>(new Assets(plugin.Core, () => origins++));
        }).Configure(app =>
        {
            app.Use(async (http, next) =>
            {
                http.User = TestCallers.Principal(Guid.NewGuid(), http.Request.Headers["X-Test-Role"] == "admin");
                await next();
            });
            app.UseRouting();
            app.UseAuthorization();
            app.UseEndpoints(e => e.MapControllers());
        }));
        using var client = new HttpClient(new SharedCache(server.CreateHandler())) { BaseAddress = new Uri("http://localhost") };
        using var adminRequest = new HttpRequestMessage(HttpMethod.Get, "/JellyfinEnhanced/fonts/materialsymbolsrounded-subset.woff2");
        adminRequest.Headers.Add("X-Test-Role", "admin");
        using var admin = await client.SendAsync(adminRequest);
        using var viewer = await client.GetAsync(adminRequest.RequestUri);

        // The public asset stays exactly as cacheable as before, and the shared cache still serves it once fetched...
        Assert.True(admin.IsSuccessStatusCode);
        Assert.True(admin.Headers.CacheControl!.Public);
        Assert.Equal(1, origins);
        // ...but it never carried the administrator's timings, so there is nothing to replay to the viewer.
        Assert.False(admin.Headers.Contains("Server-Timing"));
        Assert.False(viewer.Headers.Contains("Server-Timing"));
    }

    [Fact]
    public async Task StageTimingsOffHandTheRequestOnWithoutAllocating()
    {
        using var plugin = new ApiPluginFixture();
        Assert.False(plugin.Plugin.Configuration.StageTimingsEnabled);
        var filter = new StageTimingsFilter();
        var action = new ActionContext(new DefaultHttpContext(), new RouteData(), new ActionDescriptor { AttributeRouteInfo = new AttributeRouteInfo { Template = "Items/{itemId}" } });
        var filters = new List<IFilterMetadata>();
        var before = new ResourceExecutingContext(action, filters, new List<IValueProviderFactory>());
        var finished = Task.FromResult(new ResourceExecutedContext(action, filters));
        ResourceExecutionDelegate done = () => finished;
        var pending = new TaskCompletionSource<ResourceExecutedContext>(TaskCreationOptions.RunContinuationsAsynchronously);
        ResourceExecutionDelegate waiting = () => pending.Task;

        // The downstream task itself is returned: no wrapper, state machine or continuation of the filter's own.
        Assert.Same(pending.Task, filter.OnResourceExecutionAsync(before, waiting));
        Assert.Same(finished, filter.OnResourceExecutionAsync(before, done));
        for (var i = 0; i < 1000; i++) _ = filter.OnResourceExecutionAsync(before, done);
        var start = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 1000; i++) _ = filter.OnResourceExecutionAsync(before, done);
        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - start);
        pending.SetResult(new ResourceExecutedContext(action, filters));
        await pending.Task;
    }
}
