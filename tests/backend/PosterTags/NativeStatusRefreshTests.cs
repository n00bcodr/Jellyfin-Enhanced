using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Microsoft.AspNetCore.Http;
using MediaBrowser.Controller.Entities.Movies;
using SkiaSharp;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class NativeStatusRefreshTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task Cold_and_expired_image_render_is_cache_only_and_queues_one_background_refresh()
    {
        using var plugin = new ApiPluginFixture();
        var clock = new Clock();
        var config = plugin.Plugin.Configuration;
        config.NativePosterTagsEnabled = config.StatusTagsEnabled = true;
        config.TMDB_API_KEY = "fixture";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            await release.Task.WaitAsync(token);
            return IntegrationTransport.Response("{\"results\":[{\"id\":2,\"media_type\":\"movie\"}]}");
        });
        using var cache = new TmdbResponseCache(transport, clock);
        var trending = new StatusTagsTrendingService(transport, cache, plugin.Core.Logger, clock);
        var series = new StatusTagsSeriesService(cache, plugin.Core.Logger, clock, 4, 35, TimeSpan.FromSeconds(10));
        using var worker = new NativeStatusRefreshService(trending, series, plugin.Core.Logger, clock);
        var provider = new PosterTagStatusProvider(worker, null!, null!);
        var settings = PosterTagSettings.FromSettingsJson("{statusTagsEnabled:true}", config);
        var entry = new TagCacheEntry { Type = "Movie", TmdbId = "2", DateCreated = DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds() };
        var user = new User("fixture", "default", "default");
        using var renderer = new PosterTagRenderer();
        using var image = new SKBitmap(360, 540);
        async Task Render()
        {
            var status = await provider.GetAsync(new DefaultHttpContext(), new Movie(), user, entry, settings, default).WaitAsync(TimeSpan.FromSeconds(1));
            Assert.Null(status.Rank);
            var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null, status), false)!;
            using var result = renderer.Render(image, layout);
            Assert.NotNull(result);
        }
        await Render();
        await Render();
        Assert.Equal(0, transport.Calls);
        var refresh = worker.RefreshAsync(config, default);
        Assert.False(refresh.IsCompleted);
        await Render(); // Upstream is blocked, but image composition still completes.
        release.SetResult();
        await refresh;
        Assert.Equal(3, transport.Calls); // one three-page refresh, despite repeated misses
        Assert.Equal(1, worker.GetTrending(config).Movies["2"]);
        clock.Now = clock.Now.AddDays(1);
        await Render();
        Assert.Equal(3, transport.Calls);
        await worker.RefreshAsync(config, default);
        Assert.Equal(6, transport.Calls);
    }

    [Theory]
    [InlineData(200)]
    [InlineData(503)]
    public async Task Series_misses_and_errors_never_fetch_on_image_read_and_failures_back_off(int status)
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", status)));
        using var cache = new TmdbResponseCache(transport, clock);
        var trending = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var series = new StatusTagsSeriesService(cache, env.Logger, clock, 4, 35, TimeSpan.FromSeconds(10));
        using var worker = new NativeStatusRefreshService(trending, series, env.Logger, clock);
        var config = new PluginConfiguration { NativePosterTagsEnabled = true, StatusTagsEnabled = true, StatusTagsTrending = false, TMDB_API_KEY = "fixture" };
        for (var i = 0; i < 10; i++) Assert.Null(worker.GetSeries(config, "100"));
        Assert.Equal(0, transport.Calls);
        await worker.RefreshAsync(config, default);
        Assert.Equal(1, transport.Calls);
        for (var i = 0; i < 10; i++) Assert.Null(worker.GetSeries(config, "100"));
        await worker.RefreshAsync(config, default);
        Assert.Equal(1, transport.Calls);
        clock.Now = clock.Now.AddMinutes(5);
        Assert.Null(worker.GetSeries(config, "100"));
        Assert.Equal(1, transport.Calls);
        await worker.RefreshAsync(config, default);
        Assert.Equal(status == 503 ? 2 : 1, transport.Calls); // shared success body remains fresh
    }

    [Fact]
    public async Task Cold_native_trending_reuses_fresh_web_pages_in_the_shared_cache()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"results\":[{\"id\":2,\"media_type\":\"movie\"}]}")));
        using var cache = new TmdbResponseCache(transport, clock);
        for (int page = 1; page <= 3; page++) await cache.GetAsync("trending/all/day", "?page=" + page, "key", default);
        var trending = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var config = new PluginConfiguration { StatusTagsEnabled = true, TMDB_API_KEY = "key" };
        Assert.Equal(1, (await trending.GetNativeAsync(config, default)).Movies["2"]);
        Assert.Equal(3, transport.Calls);
    }
}
