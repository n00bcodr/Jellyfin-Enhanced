using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.AspNetCore.Routing;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class NativeDetailsStageTimingsFilterTests
{
    /// <summary>A response that keeps its start/completion callbacks so a test runs them as the host would (start: last registered first).</summary>
    private sealed class Callbacks : HttpResponseFeature
    {
        public List<(Func<object, Task> Run, object State)> Starting { get; } = new();
        public List<(Func<object, Task> Run, object State)> Completed { get; } = new();
        public override void OnStarting(Func<object, Task> callback, object state) => Starting.Add((callback, state));
        public override void OnCompleted(Func<object, Task> callback, object state) => Completed.Add((callback, state));
        public async Task StartAsync()
        {
            for (var i = Starting.Count - 1; i >= 0; i--) await Starting[i].Run(Starting[i].State);
        }
        public async Task CompleteAsync()
        {
            for (var i = Completed.Count - 1; i >= 0; i--) await Completed[i].Run(Completed[i].State);
        }
    }

    private static async Task<(HttpContext Http, Callbacks Response, StageTimings? Inside, Guid Viewer)> Run(ApiPluginFixture plugin, bool admin, string path, string template, Action? stages = null, string? cacheControl = "private, no-store")
    {
        var http = new DefaultHttpContext();
        var response = new Callbacks();
        http.Features.Set<IHttpResponseFeature>(response);
        var viewer = Guid.NewGuid();
        http.User = TestCallers.Principal(viewer, admin);
        http.Request.Method = "GET";
        http.Request.Path = path;
        var action = new ActionContext(http, new RouteData(), new ActionDescriptor { AttributeRouteInfo = new AttributeRouteInfo { Template = template } });
        var filters = new List<IFilterMetadata>();
        var context = new ResourceExecutingContext(action, filters, new List<IValueProviderFactory>());
        StageTimings? inside = null;
        await Task.Run(() => new StageTimingsFilter(plugin.Core.Logger).OnResourceExecutionAsync(context, () =>
        {
            inside = StageTimings.Current;
            stages?.Invoke();
            // The answer's own owner decides its cacheability (JE's private answers say private, no-store).
            if (cacheControl != null) http.Response.Headers.CacheControl = cacheControl;
            // A response owner registered inside the action starts its own check before the header is written.
            var recorder = StageTimings.Current;
            http.Response.OnStarting(() => { recorder?.Add(Stage.Publish, 0); return Task.CompletedTask; });
            return Task.FromResult(new ResourceExecutedContext(action, filters));
        }));
        await response.StartAsync();
        await response.CompleteAsync();
        return (http, response, inside, viewer);
    }

    [Theory]
    [InlineData(true, "/JellyfinEnhanced/title-actions/movie/693134", "JellyfinEnhanced/title-actions/{type}/{tmdbId}", true)]
    [InlineData(false, "/JellyfinEnhanced/title-actions/movie/693134", "JellyfinEnhanced/title-actions/{type}/{tmdbId}", false)]
    [InlineData(true, "/Sessions/Playing", "Sessions/Playing", false)]
    [InlineData(true, "/Users/0f1e/Items/abcd", "Users/{userId}/Items/{itemId}", false)]
    public async Task StageTimingsHeaderIsForAdministratorsOnJellyfinEnhancedAnswers(bool admin, string path, string template, bool header)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.StageTimingsEnabled = true;
        // Only Jellyfin Enhanced's own route records an absent-title stage; the others see just the guard's publish check.
        var (http, _, inside, _) = await Run(plugin, admin, path, template, path.StartsWith("/JellyfinEnhanced", StringComparison.Ordinal) ? () => StageTimings.Count(Stage.Policy) : null);
        Assert.NotNull(inside);
        Assert.Equal(header, http.Response.Headers.ContainsKey("Server-Timing"));
        if (header)
        {
            var value = http.Response.Headers["Server-Timing"].ToString();
            Assert.Matches("^total;dur=[0-9]+\\.[0-9], policy;dur=[0-9]+\\.[0-9];desc=\"n=1\", publish;dur=[0-9]+\\.[0-9];desc=\"n=1\"$", value);
        }
    }

    [Fact]
    public async Task StageTimingsAnnotateAFacadeAnswerThatRecordedAStage()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.StageTimingsEnabled = true;
        var (http, _, _, _) = await Run(plugin, true, "/Users/0f1e/Items/abcd", "Users/{userId}/Items/{itemId}", () => StageTimings.Count(Stage.TmdbHit));
        Assert.Contains("tmdb-hit;dur=", http.Response.Headers["Server-Timing"].ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("private, no-store", true)]
    [InlineData("no-store", true)]
    [InlineData("private, no-cache", true)]
    [InlineData("private", true)]
    [InlineData("public, max-age=31536000, immutable", false)]
    [InlineData("max-age=3600", false)]
    [InlineData("no-cache", false)]
    [InlineData("private=\"Set-Cookie\", max-age=60", false)]
    [InlineData(null, false)]
    public async Task StageTimingsNeverAnnotateAnAnswerASharedCacheMayKeep(string? cacheControl, bool header)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.StageTimingsEnabled = true;
        var (http, _, _, _) = await Run(plugin, true, "/JellyfinEnhanced/title-actions/movie/693134", "JellyfinEnhanced/title-actions/{type}/{tmdbId}",
            () => StageTimings.Count(Stage.Policy), cacheControl);
        Assert.Equal(header, http.Response.Headers.ContainsKey("Server-Timing"));
        // Cacheability is never widened or otherwise touched by the diagnostics.
        Assert.Equal(cacheControl ?? string.Empty, http.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public async Task StageTimingsOffRegisterNothingAndRecordNothing()
    {
        using var plugin = new ApiPluginFixture();
        Assert.False(plugin.Plugin.Configuration.StageTimingsEnabled);
        var (http, response, inside, _) = await Run(plugin, true, "/JellyfinEnhanced/title-actions/movie/693134", "JellyfinEnhanced/title-actions/{type}/{tmdbId}");
        Assert.Null(inside);
        Assert.False(http.Response.Headers.ContainsKey("Server-Timing"));
        Assert.Single(response.Starting);
        Assert.Empty(response.Completed);
    }

    [Fact]
    public async Task StageTimingsLogLineNamesTheRoutePatternNeverItsValuesOrTheViewer()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.StageTimingsEnabled = true;
        var (http, _, _, viewer) = await Run(plugin, false, "/JellyfinEnhanced/title-actions/movie/693134", "JellyfinEnhanced/title-actions/{type}/{tmdbId}", () => StageTimings.Count(Stage.Policy));
        var log = File.ReadAllText(plugin.Core.Logger.CurrentLogFilePath);
        var line = Assert.Single(log.Split('\n'), l => l.Contains("Stage timings:", StringComparison.Ordinal));
        Assert.Contains("GET JellyfinEnhanced/title-actions/{type}/{tmdbId} 200: total;dur=", line, StringComparison.Ordinal);
        Assert.Contains("policy;dur=", line, StringComparison.Ordinal);
        Assert.DoesNotContain("693134", line, StringComparison.Ordinal);
        Assert.DoesNotContain("movie", line, StringComparison.Ordinal);
        Assert.DoesNotContain(viewer.ToString("N"), line, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(viewer.ToString(), line, StringComparison.OrdinalIgnoreCase);
        Assert.False(http.Response.Headers.ContainsKey("Server-Timing"));
    }
}
