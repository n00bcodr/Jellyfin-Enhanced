using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Microsoft.AspNetCore.Http;
using MediaBrowser.Controller.Entities.Movies;
using SkiaSharp;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;

namespace JE.Tests.Features.MediaTags;

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

    [Fact]
    public async Task Hosted_stop_during_page_one_prevents_later_pages_and_snapshot_publication()
    {
        using var plugin = new ApiPluginFixture();
        var clock = new Clock();
        var config = plugin.Plugin.Configuration;
        config.NativePosterTagsEnabled = config.StatusTagsEnabled = true;
        config.TMDB_API_KEY = "fixture";
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken httpToken = default;
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            httpToken = token;
            started.TrySetResult();
            await release.Task;
            return IntegrationTransport.Response("{\"results\":[{\"id\":2,\"media_type\":\"movie\"}]}");
        });
        using var cache = new TmdbResponseCache(transport, clock);
        var trending = new StatusTagsTrendingService(transport, cache, plugin.Core.Logger, clock);
        var series = new StatusTagsSeriesService(cache, plugin.Core.Logger, clock, 4, 35, TimeSpan.FromSeconds(10));
        using var worker = new NativeStatusRefreshService(trending, series, plugin.Core.Logger, clock);
        await worker.StartAsync(default);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // Join the worker's native flight before stopping so no replacement
        // refresh can obscure continued pagination or stale publication.
        var nativeFlight = trending.GetNativeAsync(config, default);
        var sharedPage = cache.GetAsync("trending/all/day", "?page=1", "fixture", default);
        try
        {
            await worker.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(1, transport.Calls);
            Assert.False(httpToken.IsCancellationRequested); // shared HTTP still belongs to the cache
            release.TrySetResult();
            Assert.True((await sharedPage.WaitAsync(TimeSpan.FromSeconds(5))).IsSuccess);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => nativeFlight.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(1, transport.Calls);
            Assert.False(trending.TryGetNative(config, out _));
        }
        finally
        {
            release.TrySetResult();
            await worker.StopAsync(default);
        }
    }

    [Fact]
    public async Task Individual_native_waiter_cancellation_does_not_cancel_worker_pagination()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, _) =>
        {
            started.TrySetResult();
            await release.Task;
            return IntegrationTransport.Response("{\"results\":[{\"id\":2,\"media_type\":\"movie\"}]}");
        });
        using var cache = new TmdbResponseCache(transport, clock);
        var trending = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var config = new PluginConfiguration { StatusTagsEnabled = true, TMDB_API_KEY = "fixture" };
        using var lifetime = new CancellationTokenSource();
        var owner = trending.GetNativeAsync(config, default, lifetime.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var waiterToken = new CancellationTokenSource();
        var waiter = trending.GetNativeAsync(config, waiterToken.Token);
        waiterToken.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiter);
        release.TrySetResult();
        Assert.Equal(1, (await owner.WaitAsync(TimeSpan.FromSeconds(5))).Movies["2"]);
        Assert.Equal(3, transport.Calls);
        Assert.True(trending.TryGetNative(config, out _));
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
    public async Task Queued_schedules_refresh_in_parallel_batches_under_the_series_limit()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        var active = 0;
        var peak = 0;
        var gate = new object();
        var fourActive = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            lock (gate)
            {
                peak = Math.Max(peak, ++active);
                if (active == 4) fourActive.TrySetResult();
            }
            try { await release.Task.WaitAsync(token); }
            finally { lock (gate) active--; }
            return IntegrationTransport.Response("{\"status\":\"Returning Series\",\"next_episode_to_air\":{\"air_date\":\"2026-11-02\",\"season_number\":2,\"episode_number\":1}}");
        });
        using var cache = new TmdbResponseCache(transport, clock);
        var trending = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var series = new StatusTagsSeriesService(cache, env.Logger, clock, 4, 1000, TimeSpan.FromSeconds(10));
        using var worker = new NativeStatusRefreshService(trending, series, env.Logger, clock);
        var config = new PluginConfiguration { NativePosterTagsEnabled = true, StatusTagsEnabled = true, StatusTagsTrending = false, TMDB_API_KEY = "fixture" };
        var ids = Enumerable.Range(100, 50).Select(id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        foreach (var id in ids) Assert.Null(worker.GetSeries(config, id));
        var refresh = worker.RefreshAsync(config, default);
        await fourActive.Task.WaitAsync(TimeSpan.FromSeconds(5)); // four lookups at once, not one
        release.SetResult();
        await refresh.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(4, peak); // never above the series service's in-flight limit
        Assert.Equal(50, transport.Calls);
        Assert.All(ids, id => Assert.NotNull(worker.GetSeries(config, id)));
    }

    [Fact]
    public async Task Stopping_mid_batch_leaves_its_series_queued_for_the_next_pass()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, _) =>
        {
            started.TrySetResult();
            await release.Task;
            return IntegrationTransport.Response("{\"status\":\"Returning Series\",\"next_episode_to_air\":{\"air_date\":\"2026-11-02\",\"season_number\":2,\"episode_number\":1}}");
        });
        using var cache = new TmdbResponseCache(transport, clock);
        var trending = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var series = new StatusTagsSeriesService(cache, env.Logger, clock, 4, 1000, TimeSpan.FromSeconds(10));
        using var worker = new NativeStatusRefreshService(trending, series, env.Logger, clock);
        var config = new PluginConfiguration { NativePosterTagsEnabled = true, StatusTagsEnabled = true, StatusTagsTrending = false, TMDB_API_KEY = "fixture" };
        var ids = Enumerable.Range(100, 20).Select(id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        foreach (var id in ids) Assert.Null(worker.GetSeries(config, id));
        using var stop = new CancellationTokenSource();
        var refresh = worker.RefreshAsync(config, stop.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        stop.Cancel();
        // Lookups already in flight keep their slots until their shared request returns.
        release.SetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => refresh.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Null(worker.GetSeries(config, "100")); // the stopped batch published nothing
        // No five-minute failure stamp: the next pass refreshes every queued series straight away.
        await worker.RefreshAsync(config, default).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.All(ids, id => Assert.NotNull(worker.GetSeries(config, id)));
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
