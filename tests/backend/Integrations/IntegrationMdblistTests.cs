using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

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
