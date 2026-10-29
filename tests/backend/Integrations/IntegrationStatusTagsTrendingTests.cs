using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

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
