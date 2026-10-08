using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Moq;

namespace JE.Tests;

public class CoreAwardsTests
{
    private sealed class Handler(string body, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public int Calls;
        /// <summary>When set, every request waits for it, so concurrent callers overlap for real.</summary>
        public TaskCompletionSource? Release;
        public readonly SemaphoreSlim Entered = new(0);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            Assert.Equal("query.wikidata.org", request.RequestUri!.Host);
            Assert.Contains("application/sparql-results+json", request.Headers.Accept.ToString());
            Entered.Release();
            if (Release != null) await Release.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }
    private static Mock<IHttpClientFactory> Factory(Handler handler)
    {
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(handler, false));
        return factory;
    }

    [Fact]
    public async Task ConfirmedEmptyResultCoalescesAndPersistsAcrossRestart()
    {
        using var f = new CoreFixture();
        using var handler = new Handler("{\"results\":{\"bindings\":[]}}") { Release = new(TaskCreationOptions.RunContinuationsAsynchronously) };
        var factory = Factory(handler);
        using (var service = new WikidataAwardsService(factory.Object, f.Paths.Object, f.Logger))
        {
            // Hold the first request open while the other 19 callers arrive; none may start its own.
            var pending = Enumerable.Range(0, 20).Select(_ => service.GetAwardsAsync("movie", "123", default)).ToArray();
            Assert.True(await handler.Entered.WaitAsync(TimeSpan.FromSeconds(15)));
            Assert.False(await handler.Entered.WaitAsync(TimeSpan.FromMilliseconds(250)));
            handler.Release.SetResult();
            var results = await Task.WhenAll(pending);
            Assert.All(results, r => { Assert.False(r.Found); Assert.True(r.Confirmed); });
            Assert.Equal(1, handler.Calls);
        }
        using var reopened = new WikidataAwardsService(factory.Object, f.Paths.Object, f.Logger);
        Assert.True((await reopened.GetAwardsAsync("movie", "123", default)).Confirmed);
        Assert.Equal(1, handler.Calls);
        await reopened.GetAwardsAsync("tv", "123", default);
        Assert.Equal(2, handler.Calls);
    }

    [Theory]
    [InlineData("broken", 200)][InlineData("{}", 200)][InlineData("{}", 429)][InlineData("{}", 503)]
    public async Task ProviderFailuresAreUnconfirmedAndCachedBriefly(string body, int status)
    {
        using var f = new CoreFixture();
        using var handler = new Handler(body, (HttpStatusCode)status);
        using var service = new WikidataAwardsService(Factory(handler).Object, f.Paths.Object, f.Logger);
        var result = await service.GetAwardsAsync("person", "1", default);
        Assert.False(result.Found);
        Assert.False(result.Confirmed);
        await service.GetAwardsAsync("person", "1", default);
        Assert.Equal(1, handler.Calls);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{\"Found\":true,\"FetchedAtUnixMs\":9223372036854775807}")]
    public async Task InvalidPersistedEntriesAreRefetchedInsteadOfCrashing(string entry)
    {
        using var f = new CoreFixture();
        File.WriteAllText(Path.Combine(f.ConfigRoot, "awards.json"), "{\"SchemaVersion\":1,\"Items\":{\"movie-1\":" + entry + "}}");
        using var handler = new Handler("{\"results\":{\"bindings\":[]}}");
        using var service = new WikidataAwardsService(Factory(handler).Object, f.Paths.Object, f.Logger);
        Assert.True((await service.GetAwardsAsync("movie", "1", default)).Confirmed);
        Assert.Equal(1, handler.Calls);
    }
}
