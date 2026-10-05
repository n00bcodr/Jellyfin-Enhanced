using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationTmdbTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task CacheSeparatesCredentialsQueryAndPathAndExpiresAtBoundary()
    {
        var clock = new Clock();
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response("{\"url\":\"" + request.RequestUri + "\"}")));
        using var cache = new TmdbResponseCache(transport, clock);
        var first = await cache.GetAsync("search/movie", "?query=a", "key", default);
        Assert.Same(first, await cache.GetAsync("search/movie", "?query=a", "key", default));
        await cache.GetAsync("search/movie", "?query=b", "key", default);
        await cache.GetAsync("search/tv", "?query=a", "key", default);
        await cache.GetAsync("search/movie", "?query=a", "other", default);
        Assert.Equal(4, transport.Calls);
        clock.Now += TimeSpan.FromMinutes(30);
        Assert.NotSame(first, await cache.GetAsync("search/movie", "?query=a", "key", default));
        Assert.Equal(5, transport.Calls);
    }

    [Theory]
    [InlineData(200, "application/json", true)]
    [InlineData(404, "application/json", true)]
    [InlineData(401, "application/json", false)]
    [InlineData(429, "application/json", false)]
    [InlineData(503, "application/json", false)]
    [InlineData(200, "text/html", false)]
    public async Task OnlySuccessfulJsonAndNotFoundAreCached(int status, string type, bool cached)
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", status, type)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        Assert.Equal(status, (await cache.GetAsync("movie/1", "", "key", default)).StatusCode);
        await cache.GetAsync("movie/1", "", "key", default);
        Assert.Equal(cached ? 1 : 2, transport.Calls);
    }

    [Fact]
    public async Task ConcurrentMissesShareFetchAndOneCancelledWaiterCannotCancelOthers()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, ct) => { await release.Task.WaitAsync(ct); return IntegrationTransport.Response(); });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        using var cancelled = new CancellationTokenSource();
        var abandoned = cache.GetAsync("person/1", "", "key", cancelled.Token);
        var waiters = Enumerable.Range(0, 15).Select(_ => cache.GetAsync("person/1", "", "key", default)).ToArray();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
        release.SetResult();
        var results = await Task.WhenAll(waiters);
        Assert.All(results, result => Assert.Equal("{}", result.Content));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task FailedInFlightCallIsRemovedAndRetried()
    {
        var calls = 0;
        using var transport = new IntegrationTransport((_, _) => ++calls == 1 ? throw new HttpRequestException("offline") : Task.FromResult(IntegrationTransport.Response()));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        await Assert.ThrowsAsync<HttpRequestException>(() => cache.GetAsync("movie/1", "", "key", default));
        Assert.True((await cache.GetAsync("movie/1", "", "key", default)).IsSuccess);
        Assert.Equal(2, transport.Calls);
    }

    [Fact]
    public async Task MovieBundlePopulatesIndependentResourcesAndDoesNotLeakSiblingsIntoTitle()
    {
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Contains("append_to_response=", request.RequestUri!.Query);
            return Task.FromResult(IntegrationTransport.Response("{\"id\":12,\"title\":\"test\",\"release_dates\":{\"results\":[]},\"watch/providers\":{\"results\":{}},\"reviews\":{\"results\":[],\"page\":1}}"));
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var title = await cache.GetAsync("movie/12", "", "key", default, true);
        Assert.DoesNotContain("watch/providers", title.Content);
        Assert.Contains("test", title.Content);
        var reviews = await cache.GetAsync("movie/12/reviews", "?language=en-US&page=1", "key", default, true);
        Assert.Contains("page", reviews.Content);
        Assert.DoesNotContain("title", reviews.Content);
        await cache.GetAsync("movie/12/watch/providers", "", "key", default);
        await cache.GetAsync("movie/12/release_dates", "", "key", default);
        Assert.Equal(1, transport.Calls);
    }

    [Theory]
    [InlineData("*", true)]
    [InlineData("\"tag\"", true)]
    [InlineData("W/\"tag\"", true)]
    [InlineData("\"other\", W/\"tag\"", true)]
    [InlineData("tag", false)]
    [InlineData("\"other\"", false)]
    [InlineData("", false)]
    public void ConditionalGetUsesWeakComparisonAndRejectsMalformedValidators(string header, bool matches) =>
        Assert.Equal(matches, TmdbResponseCache.IfNoneMatchMatches(header, "\"tag\""));

    [Theory]
    [InlineData("{")]
    [InlineData("{\"V\":1,\"Entries\":null}")]
    [InlineData("{\"V\":1,\"Entries\":[null]}")]
    [InlineData("{\"V\":1,\"Entries\":[{\"K\":\"key\",\"C\":null,\"E\":1800000000000}]}")]
    [InlineData("{\"V\":1,\"Entries\":[{\"K\":\"key\",\"S\":200,\"C\":\"{}\",\"E\":9223372036854775807}]}")]
    public async Task CorruptPersistedCacheCannotPreventStartup(string persisted)
    {
        using var env = new IntegrationEnvironment();
        var path = Path.Combine(env.Root, "configurations/Jellyfin.Plugin.JellyfinEnhanced/tmdb-cache.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, persisted);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var cache = new TmdbResponseCache(transport, env.Paths.Object, env.Logger);
        Assert.True((await cache.GetAsync("movie/1", "", "key", default)).IsSuccess);
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task CorruptRecordDoesNotDiscardLaterValidPersistedResponse()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"id\":1}")));
        using (var cache = new TmdbResponseCache(transport, env.Paths.Object, env.Logger))
            await cache.GetAsync("movie/1", "", "key", default);
        var path = Path.Combine(env.Root, "configurations/Jellyfin.Plugin.JellyfinEnhanced/tmdb-cache.json");
        var file = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(path))!;
        file["Entries"]!.AsArray().Insert(0, System.Text.Json.Nodes.JsonNode.Parse("{\"K\":\"broken\",\"C\":\"{}\",\"E\":9223372036854775807}"));
        File.WriteAllText(path, file.ToJsonString());
        using var reloaded = new TmdbResponseCache(transport, env.Paths.Object, env.Logger);
        Assert.Equal("{\"id\":1}", (await reloaded.GetAsync("movie/1", "", "key", default)).Content);
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task DisposePersistsResponsesAcrossRestartWithoutPlaintextApiKey()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"id\":1}")));
        using (var first = new TmdbResponseCache(transport, env.Paths.Object, env.Logger))
            await first.GetAsync("movie/1", "", "top-secret-key", default);
        var persisted = File.ReadAllText(Path.Combine(env.Root, "configurations/Jellyfin.Plugin.JellyfinEnhanced/tmdb-cache.json"));
        Assert.DoesNotContain("top-secret-key", persisted);
        using var reloaded = new TmdbResponseCache(transport, env.Paths.Object, env.Logger);
        Assert.Equal("{\"id\":1}", (await reloaded.GetAsync("movie/1", "", "top-secret-key", default)).Content);
        Assert.Equal(1, transport.Calls);
    }
}
