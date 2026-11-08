using System.Net.Http.Headers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

public class IntegrationMdblistTests
{
    [Fact]
    public async Task TestingUnsavedKeyParsesAccountButCannotPolluteSavedQuota()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Equal("/user", request.RequestUri!.AbsolutePath);
            Assert.Contains("apikey=a%26b", request.RequestUri.Query);
            return Task.FromResult(IntegrationTransport.Response("{\"plan\":\"supporter\",\"is_supporter\":true,\"rate_limit\":1000,\"rate_limit_remaining\":42,\"rate_limit_reset\":1800000000}"));
        });
        using var service = new MdblistService(transport, env.Paths.Object, env.Logger);
        var result = await service.GetAccountStatusAsync(default, apiKeyOverride: "a&b");
        Assert.Equal(42, result!.RateLimitRemaining);
        Assert.Equal(1000, result.RateLimit);
        Assert.True(result.IsSupporter);
        Assert.Equal("supporter", result.Plan);
        Assert.Equal(1800000000, result.RateLimitResetUnixSeconds);
        Assert.Null(service.RemainingQuota());
        await service.GetAccountStatusAsync(default, apiKeyOverride: "a&b");
        Assert.Equal(2, transport.Calls);
    }

    [Theory]
    [InlineData(401, "{}")]
    [InlineData(429, "{}")]
    [InlineData(500, "{}")]
    [InlineData(200, "{")]
    [InlineData(200, "null")]
    public async Task AccountFailuresAreSafeAndDoNotInventQuota(int status, string body)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body, status)));
        using var service = new MdblistService(transport, env.Paths.Object, env.Logger);
        Assert.Null(await service.GetAccountStatusAsync(default, apiKeyOverride: "test-key"));
        Assert.Null(service.RemainingQuota());
    }

    [Fact]
    public void BatchMergePersistsConfirmedMissesSeparatesMediaTypesAndIsIdempotent()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No network required"));
        var entry = new MdblistCacheEntry { Found = true, Confirmed = true, FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Ratings = [new() { Source = "tmdb", Score = 78 }], Ids = new() { ["imdb"] = "tt1" } };
        using (var service = new MdblistService(transport, env.Paths.Object, env.Logger))
        {
            for (var i = 0; i < 2; i++) service.MergeMediaBatchIntoCache("movie", ["1", "2"], new Dictionary<string, MdblistCacheEntry> { ["1"] = entry });
            Assert.Same(entry, service.GetCachedEntry("movie", "1"));
            Assert.False(service.GetCachedEntry("movie", "2")!.Found);
            Assert.True(service.GetCachedEntry("movie", "2")!.Confirmed);
            Assert.False(service.NeedsFetch("movie", "2"));
            Assert.True(service.NeedsFetch("tv", "1"));
        }
        using var reloaded = new MdblistService(transport, env.Paths.Object, env.Logger);
        Assert.Equal("tt1", reloaded.GetCachedEntry("movie", "1")!.Ids["imdb"]);
        Assert.Equal(7.8, MdblistService.GetCommunityRating(reloaded.GetCachedEntry("movie", "1")!));
        Assert.False(reloaded.NeedsFetch("movie", "2"));
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData(true, true, 6, false)]
    [InlineData(true, true, 8, true)]
    [InlineData(false, true, 2, false)]
    [InlineData(false, true, 4, true)]
    [InlineData(false, false, 0.02, false)]
    [InlineData(false, false, 0.05, true)]
    public void RetryTtlDistinguishesFailuresFromConfirmedNegativeAndPositive(bool found, bool confirmed, double days, bool needsFetch)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException());
        using var service = new MdblistService(transport, env.Paths.Object, env.Logger);
        service.MergeMediaBatchIntoCache("movie", ["1"], new Dictionary<string, MdblistCacheEntry> { ["1"] = new() { Found = found, Confirmed = confirmed, FetchedAtUnixMs = DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeMilliseconds() } });
        Assert.Equal(needsFetch, service.NeedsFetch("movie", "1"));
    }

    [Theory]
    [InlineData(80.0, 6.0, 8.0)]
    [InlineData(null, 60.0, 6.0)]
    [InlineData(0.0, 60.0, 0.0)]
    [InlineData(null, null, null)]
    public void NativeRatingPrefersScorePreservesZeroAndScalesTmdb(double? score, double? value, double? expected)
    {
        var entry = new MdblistCacheEntry { Ratings = [new() { Source = "tmdb", Score = score, Value = value }, new() { Source = "tomatoes", Score = 92 }] };
        Assert.Equal(expected, MdblistService.GetCommunityRating(entry));
        Assert.Equal(92, MdblistService.GetCriticRating(entry));
        Assert.Null(MdblistService.GetCommunityRating(new()));
    }
}

[Collection("Plugin singleton")]
public class IntegrationMdblistSavedKeyTests
{
    [Fact]
    public async Task TestingAnUnsavedKeyBypassesTheSavedKeysCachedStatus()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "saved";
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.Query.Contains("apikey=saved", StringComparison.Ordinal)
                ? "{\"plan\":\"free\",\"rate_limit\":100,\"rate_limit_remaining\":7}"
                : "{\"plan\":\"supporter\",\"rate_limit\":1000,\"rate_limit_remaining\":42}")));
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        Assert.Equal(7, (await service.GetAccountStatusAsync(default))!.RateLimitRemaining);
        Assert.Equal(7, (await service.GetAccountStatusAsync(default))!.RateLimitRemaining);
        Assert.Equal(1, transport.Calls); // the saved key's status is cached
        var tested = await service.GetAccountStatusAsync(default, apiKeyOverride: "unsaved");
        Assert.Equal(42, tested!.RateLimitRemaining);
        Assert.Equal("supporter", tested.Plan);
        Assert.Equal(2, transport.Calls);
        Assert.Equal(7, service.RemainingQuota());
    }
}

[Collection("Plugin singleton")]
public class IntegrationMdblistRateLimitTests
{
    private const string Quota = "{\"rate_limit\":1000,\"rate_limit_remaining\":900}";

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-11-09T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    /// <summary>MDBList fake: /user always answers; other calls take the next queued status (then 200).</summary>
    private sealed class Mdblist : IDisposable
    {
        private readonly Queue<(int Status, Action<HttpResponseHeaders>? Headers)> _answers = new();
        public int Requests;
        public IntegrationTransport Transport { get; }
        public Mdblist(string success)
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response(Quota));
                Interlocked.Increment(ref Requests);
                (int Status, Action<HttpResponseHeaders>? Headers) next;
                lock (_answers) next = _answers.Count > 0 ? _answers.Dequeue() : (200, null);
                var response = IntegrationTransport.Response(next.Status == 200 ? success : "{\"error\":\"Too Many Requests\"}", next.Status);
                next.Headers?.Invoke(response.Headers);
                return Task.FromResult(response);
            });
        }
        public void Then(int status, Action<HttpResponseHeaders>? headers = null) { lock (_answers) _answers.Enqueue((status, headers)); }
        public void Dispose() => Transport.Dispose();
    }

    private static Action<HttpResponseHeaders> RetryAfter(int seconds) => h => h.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(seconds));

    private static int Warnings(ApiPluginFixture f) =>
        File.Exists(f.Core.Logger.CurrentLogFilePath)
            ? File.ReadAllLines(f.Core.Logger.CurrentLogFilePath).Count(l => l.Contains("[WARN] [MDBList] Rate limited (429)", StringComparison.Ordinal))
            : 0;

    [Fact]
    public async Task BatchTooManyRequestsWithRetryAfterPausesForThatLongThenResumes()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-only";
        var clock = new Clock();
        using var mdblist = new Mdblist("[]");
        mdblist.Then(429, RetryAfter(120));
        using var service = new MdblistService(mdblist.Transport, f.Core.Paths.Object, f.Core.Logger, clock);

        var refused = await service.GetMediaBatchWithinReserveAsync("movie", ["1"], 5, default);
        Assert.Equal(MdblistReservedBatchStatus.RateLimited, refused.Status);
        Assert.Equal(TimeSpan.FromSeconds(120), refused.RetryAfter);
        Assert.Equal(1, mdblist.Requests);

        clock.Now = clock.Now.AddSeconds(119);
        var paused = await service.GetMediaBatchWithinReserveAsync("movie", ["2"], 5, default);
        Assert.Equal(MdblistReservedBatchStatus.RateLimited, paused.Status);
        Assert.Equal(TimeSpan.FromSeconds(1), paused.RetryAfter);
        await service.WarmTagRatingsAsync([("movie", "3")], default);
        Assert.Null(await service.GetAwardListWithinReserveAsync("123", 5, default));
        Assert.Equal(1, mdblist.Requests);
        // A pause writes nothing, so the titles are fetched once it ends rather than after RetryTtl.
        Assert.Null(service.GetCachedEntry("movie", "1"));
        Assert.True(service.NeedsFetch("movie", "3"));

        clock.Now = clock.Now.AddSeconds(2);
        Assert.Equal(MdblistReservedBatchStatus.Sent, (await service.GetMediaBatchWithinReserveAsync("movie", ["1"], 5, default)).Status);
        Assert.Equal(2, mdblist.Requests);
        Assert.Equal(1, Warnings(f));
    }

    [Fact]
    public async Task RetryAfterAsAnHttpDateIsHonoured()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-only";
        var clock = new Clock();
        using var mdblist = new Mdblist("[]");
        mdblist.Then(429, h => h.RetryAfter = new RetryConditionHeaderValue(clock.Now.AddSeconds(240)));
        using var service = new MdblistService(mdblist.Transport, f.Core.Paths.Object, f.Core.Logger, clock);
        Assert.Equal(TimeSpan.FromSeconds(240), (await service.GetMediaBatchWithinReserveAsync("movie", ["1"], 5, default)).RetryAfter);
        Assert.Equal(TimeSpan.FromSeconds(240), service.RateLimitWait());
    }

    [Fact]
    public async Task TooManyRequestsWithoutRetryAfterKeepsTheExistingFailureHandling()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-only";
        using var mdblist = new Mdblist("[]");
        mdblist.Then(429);
        mdblist.Then(429);
        using var service = new MdblistService(mdblist.Transport, f.Core.Paths.Object, f.Core.Logger, new Clock());

        Assert.Equal(MdblistReservedBatchStatus.Failed, (await service.GetMediaBatchWithinReserveAsync("movie", ["1"], 5, default)).Status);
        Assert.Null(service.RateLimitWait());

        var entry = await service.GetRatingsAsync("movie", "2", default);
        Assert.False(entry.Found);
        Assert.False(entry.Confirmed);
        Assert.Null(entry.RetryAfterUnixMs);
        Assert.Equal(entry.FetchedAtUnixMs + (long)TimeSpan.FromHours(1).TotalMilliseconds, service.RefreshAtUnixMs("movie", "2"));
        Assert.False(service.NeedsFetch("movie", "2"));

        Assert.Equal(MdblistReservedBatchStatus.Sent, (await service.GetMediaBatchWithinReserveAsync("movie", ["1"], 5, default)).Status);
        Assert.Equal(3, mdblist.Requests);
        Assert.Equal(0, Warnings(f));
    }

    [Fact]
    public async Task SingleTitleTooManyRequestsRetriesWhenThePauseEndsAndSkipsOthersMeanwhile()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-only";
        var clock = new Clock();
        using var mdblist = new Mdblist("{\"ratings\":[{\"source\":\"tmdb\",\"score\":70}],\"ids\":{\"tmdb\":5}}");
        mdblist.Then(429, RetryAfter(300));
        using var service = new MdblistService(mdblist.Transport, f.Core.Paths.Object, f.Core.Logger, clock);

        var refused = await service.GetRatingsAsync("movie", "4", default);
        Assert.False(refused.Found);
        Assert.Equal(refused.FetchedAtUnixMs + 300_000, service.RefreshAtUnixMs("movie", "4"));

        var skipped = await service.GetRatingsAsync("tv", "5", default);
        Assert.False(skipped.Found);
        Assert.Equal(1, mdblist.Requests);
        Assert.Equal(1, Warnings(f));

        clock.Now = clock.Now.AddSeconds(301);
        Assert.True((await service.GetRatingsAsync("tv", "6", default)).Found);
        Assert.Equal(2, mdblist.Requests);
    }

    [Fact]
    public async Task KeptRatingsWaitForThePauseNotRetryTtl()
    {
        var previous = new MdblistCacheEntry { Found = true, Confirmed = true, FetchedAtUnixMs = 1_000, Ratings = [new() { Source = "tmdb", Score = 70 }] };
        var kept = MdblistService.KeepLastGood(previous, new MdblistCacheEntry { FetchedAtUnixMs = 5_000, RetryAfterUnixMs = 65_000 });
        Assert.True(kept.Found);
        Assert.Equal(65_000, kept.RetryAfterUnixMs);
        Assert.Equal(5_000 + (long)TimeSpan.FromHours(1).TotalMilliseconds,
            MdblistService.KeepLastGood(previous, new MdblistCacheEntry { FetchedAtUnixMs = 5_000 }).RetryAfterUnixMs);
        await Task.CompletedTask;
    }

    private static Mock<ILibraryManager> Library(int movies)
    {
        var library = new Mock<ILibraryManager>();
        var items = Enumerable.Range(1, movies)
            .Select(i => (BaseItem)new Movie { Id = Guid.NewGuid(), ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = i.ToString() } })
            .ToList();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(items);
        return library;
    }

    [Theory]
    [InlineData(90, 1, new[] { 90 }, 2, true)]          // pause, then the same chunk goes through
    [InlineData(3600, 1, new int[0], 1, false)]         // longer than a 5-minute window: stop, no pause
    [InlineData(60, 4, new[] { 60, 60, 60 }, 4, false)] // refused again after three pauses: stop
    public async Task FetchRunnerPausesForRetryAfterAndNeverSpins(int retryAfter, int refusals, int[] expectedPauses, int expectedRequests, bool fetched)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-only";
        var clock = new Clock();
        using var mdblist = new Mdblist("[]");
        for (var i = 0; i < refusals; i++) mdblist.Then(429, RetryAfter(retryAfter));
        using var service = new MdblistService(mdblist.Transport, f.Core.Paths.Object, f.Core.Logger, clock);
        var pauses = new List<int>();

        await MdblistRatingsFetchRunner.RunAsync(Library(2).Object, service, f.Core.Logger, 5, null, (wait, _) =>
        {
            pauses.Add((int)wait.TotalSeconds);
            clock.Now += wait;
            return Task.CompletedTask;
        }, default);

        Assert.Equal(expectedPauses, pauses);
        Assert.Equal(expectedRequests, mdblist.Requests);
        Assert.Equal(!fetched, service.NeedsFetch("movie", "1"));
        Assert.Equal(refusals, Warnings(f));
    }
}
