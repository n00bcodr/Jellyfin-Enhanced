using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;

namespace JE.Tests.Features.MediaTags;

// The trending list is one static, server-wide cache; tests drop it first.
[Collection("Plugin singleton")]
public class IntegrationStatusTagsTrendingTests
{
    private const string SeerrPage = "{\"results\":[{\"id\":7,\"mediaType\":\"movie\"},{\"id\":8,\"mediaType\":\"tv\"}]}";

    private static async Task<TrendingSnapshot> Fetch(Func<HttpRequestMessage, HttpResponseMessage> tmdb, bool withSeerr)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(
            request.RequestUri!.Host == "seerr.test" ? IntegrationTransport.Response(SeerrPage) : tmdb(request)));
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        var config = new PluginConfiguration
        {
            TMDB_API_KEY = "key",
            JellyseerrEnabled = withSeerr,
            JellyseerrUrls = withSeerr ? "http://seerr.test" : string.Empty,
            JellyseerrApiKey = withSeerr ? "seerr-key" : string.Empty,
        };
        StatusTagsTrendingService.Invalidate();
        try
        {
            return await new StatusTagsTrendingService(transport, tmdbCache, env.Logger).GetAsync(config, CancellationToken.None);
        }
        finally
        {
            StatusTagsTrendingService.Invalidate();
        }
    }

    private sealed class NativeClock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task NativeRanksFollowTheWebPolicyTmdbDailyThenSeerrWeeklyForThirtyMinutes()
    {
        using var env = new IntegrationEnvironment();
        var clock = new NativeClock { Now = DateTimeOffset.Parse("2026-10-30T23:59:00Z") };
        var tmdbDown = false;
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(request.RequestUri!.Host == "seerr.test"
            ? IntegrationTransport.Response(SeerrPage)
            : tmdbDown ? IntegrationTransport.Response("{}", 503) : IntegrationTransport.Response("{\"results\":[{\"id\":2,\"media_type\":\"movie\"}]}")));
        using var cache = new TmdbResponseCache(transport, clock);
        var service = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var config = new PluginConfiguration { StatusTagsEnabled = true, TMDB_API_KEY = "key", JellyseerrEnabled = true, JellyseerrUrls = "http://seerr.test", JellyseerrApiKey = "key" };

        // TMDB answers: the same daily ranks the web serves, kept 30 minutes (across UTC midnight too).
        var first = await service.GetNativeAsync(config, default);
        Assert.Equal(("tmdb-day", 1), (first.Source, first.Movies["2"]));
        var calls = transport.Calls;
        clock.Now = clock.Now.AddMinutes(29);
        Assert.Same(first, await service.GetNativeAsync(config, default));
        Assert.Equal(calls, transport.Calls);

        // TMDB fails after expiry: the Seerr weekly list, as on the web.
        tmdbDown = true;
        clock.Now = clock.Now.AddDays(1);
        var fallback = await service.GetNativeAsync(config, default);
        Assert.Equal(("seerr-week", 1), (fallback.Source, fallback.Movies["7"]));

        // Seerr alone is enough, without a TMDB key.
        var seerrOnly = new PluginConfiguration { StatusTagsEnabled = true, JellyseerrEnabled = true, JellyseerrUrls = "http://seerr.test", JellyseerrApiKey = "key" };
        Assert.Equal("seerr-week", (await service.GetNativeAsync(seerrOnly, default)).Source);
        Assert.True(PosterTagSettings.FromUserSettings(new() { StatusTagsEnabled = true }, seerrOnly, null).StatusTrending);

        // Neither source: nothing, and no request.
        calls = transport.Calls;
        Assert.Empty((await service.GetNativeAsync(new PluginConfiguration { StatusTagsEnabled = true }, default)).Movies);
        Assert.Equal(calls, transport.Calls);
    }

    [Fact]
    public async Task NativeEmptyRetryBypassesTheLongerResponseCache()
    {
        using var env = new IntegrationEnvironment();
        var clock = new NativeClock();
        bool recovered = false;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(recovered
            ? "{\"results\":[{\"id\":2,\"media_type\":\"movie\"}]}" : "{\"results\":[]}")));
        using var cache = new TmdbResponseCache(transport, clock);
        var service = new StatusTagsTrendingService(transport, cache, env.Logger, clock);
        var config = new PluginConfiguration { StatusTagsEnabled = true, TMDB_API_KEY = "key" };
        Assert.Empty((await service.GetNativeAsync(config, default)).Movies);
        recovered = true;
        clock.Now = clock.Now.AddMinutes(5);
        Assert.Equal(1, (await service.GetNativeAsync(config, default)).Movies["2"]);
    }

    private static string Page(HttpRequestMessage request) => System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["page"] ?? "";

    [Fact]
    public async Task TmdbRanksMoviesAndSeriesSkippingPeople()
    {
        var snapshot = await Fetch(request => IntegrationTransport.Response(Page(request) == "1"
            ? "{\"results\":[{\"id\":1,\"media_type\":\"person\"},{\"id\":2,\"media_type\":\"movie\"},{\"id\":3,\"media_type\":\"tv\"}]}"
            : "{\"results\":[]}"), withSeerr: true);
        Assert.Equal("tmdb-day", snapshot.Source);
        Assert.Equal(1, snapshot.Movies["2"]);
        Assert.Equal(2, snapshot.Series["3"]);
    }

    [Fact]
    public async Task TmdbAnsweringWithNoResultsFallsBackToSeerr()
    {
        var snapshot = await Fetch(_ => IntegrationTransport.Response("{\"results\":[]}"), withSeerr: true);
        Assert.Equal("seerr-week", snapshot.Source);
        Assert.Equal(1, snapshot.Movies["7"]);
        Assert.Equal(2, snapshot.Series["8"]);
    }

    [Fact]
    public async Task TmdbPageOfOnlyPeopleThenAFailureFallsBackToSeerr()
    {
        var snapshot = await Fetch(request => Page(request) == "1"
            ? IntegrationTransport.Response("{\"results\":[{\"id\":1,\"media_type\":\"person\"}]}")
            : IntegrationTransport.Response("{}", 503), withSeerr: true);
        Assert.Equal("seerr-week", snapshot.Source);
    }

    [Fact]
    public async Task TmdbWithNoResultsAndNoSeerrIsTheEmptyList()
    {
        // Source null: kept for the short empty-result interval, and the client retries sooner.
        var snapshot = await Fetch(_ => IntegrationTransport.Response("{\"results\":[]}"), withSeerr: false);
        Assert.Null(snapshot.Source);
        Assert.Empty(snapshot.Movies);
        Assert.Empty(snapshot.Series);
    }

    [Fact]
    public async Task RetryAfterAnEmptyAnswerAsksTmdbAgainPastTheResponseCache()
    {
        // TmdbResponseCache keeps a successful page (even an empty one) for 30
        // minutes, longer than the empty list is kept, so a retry that read the
        // cached page would stay empty after TMDB recovered.
        using var env = new IntegrationEnvironment();
        var recovered = false;
        var upstreamCalls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            upstreamCalls++;
            return Task.FromResult(IntegrationTransport.Response(recovered
                ? "{\"results\":[{\"id\":5,\"media_type\":\"movie\"}]}"
                : "{\"results\":[]}"));
        });
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        var config = new PluginConfiguration { TMDB_API_KEY = "key" };
        var service = new StatusTagsTrendingService(transport, tmdbCache, env.Logger);
        StatusTagsTrendingService.Invalidate();
        try
        {
            var empty = await service.GetAsync(config, CancellationToken.None);
            Assert.Null(empty.Source);
            var callsAfterEmpty = upstreamCalls;

            recovered = true;
            // Stands in for the empty list's short lifetime running out.
            StatusTagsTrendingService.Invalidate();
            var retried = await service.GetAsync(config, CancellationToken.None);
            Assert.Equal("tmdb-day", retried.Source);
            Assert.Equal(1, retried.Movies["5"]);
            Assert.True(upstreamCalls > callsAfterEmpty, "the retry must go upstream, not read the cached empty page");

            // A good list is read from the response cache again on the next fetch.
            StatusTagsTrendingService.Invalidate();
            var callsAfterGood = upstreamCalls;
            var cached = await service.GetAsync(config, CancellationToken.None);
            Assert.Equal("tmdb-day", cached.Source);
            Assert.Equal(callsAfterGood, upstreamCalls);
        }
        finally
        {
            StatusTagsTrendingService.Invalidate();
        }
    }
}
