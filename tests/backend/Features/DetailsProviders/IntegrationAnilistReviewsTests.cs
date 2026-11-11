using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;

namespace JE.Tests.Features.DetailsProviders;

public class IntegrationAnilistReviewsTests
{
    private static string Media(string body = "Great. ~!Hidden twist!~ Done. img(https://x/y.png)") => JsonSerializer.Serialize(new
    {
        data = new
        {
            Media = new
            {
                siteUrl = "https://anilist.co/anime/1",
                                reviews = new { nodes = new[] { new { summary = "Sum", score = 85, rating = 3, ratingAmount = 4, createdAt = 1540043261, siteUrl = "https://anilist.co/review/1", user = new { name = "Ann" }, body } } },
            },
        },
    });

    [Fact]
    public async Task IdLookupReturnsCleanedReviewsAndIsCached()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Contains("Media(id:$v", request.Content!.ReadAsStringAsync().Result);
            return Task.FromResult(IntegrationTransport.Response(Media()));
        });
        var service = new AnilistReviewsService(transport, env.Logger);
        var result = await service.GetReviewsAsync(269, default);
        var review = Assert.Single(result.Reviews);
        Assert.Equal("Ann", review.Author);
        Assert.Equal(85, review.Score);
        Assert.Equal("Great. [spoiler hidden] Done.", review.Content);
        Assert.Same(result, await service.GetReviewsAsync(269, default));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task CacheIsCappedAndDropsTheEntryThatExpiresFirst()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(
            request.Content!.ReadAsStringAsync().Result.Contains("\"v\":1}") ? IntegrationTransport.Response("{}", 404) : IntegrationTransport.Response(Media())));
        var service = new AnilistReviewsService(transport, env.Logger);
        // id 1 is a miss (2 h), so it expires before every found entry (12 h) and goes first.
        for (var id = 1; id <= AnilistReviewsService.MaxCacheEntries + 1; id++)
        {
            await service.GetReviewsAsync(id, default);
        }

        Assert.Equal(AnilistReviewsService.MaxCacheEntries + 1, transport.Calls);
        await service.GetReviewsAsync(AnilistReviewsService.MaxCacheEntries + 1, default);
        await service.GetReviewsAsync(2, default);
        Assert.Equal(AnilistReviewsService.MaxCacheEntries + 1, transport.Calls);
        await service.GetReviewsAsync(1, default);
        Assert.Equal(AnilistReviewsService.MaxCacheEntries + 2, transport.Calls);
    }

    [Fact]
    public async Task NotFoundIsAnEmptyResultAndServerErrorsThrow()
    {
        using var env = new IntegrationEnvironment();
        using var missing = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404)));
        Assert.Empty((await new AnilistReviewsService(missing, env.Logger).GetReviewsAsync(1, default)).Reviews);
        using var down = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 503)));
        await Assert.ThrowsAsync<HttpRequestException>(() => new AnilistReviewsService(down, env.Logger).GetReviewsAsync(1, default));
    }
}
