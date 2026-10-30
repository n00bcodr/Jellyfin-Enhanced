using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class RatingSourceTests
{
    [Fact]
    public void MapsNormalizedAndRawNativeValuesWithoutInventingMissingScores()
    {
        var entry = new MdblistCacheEntry { Found = true, Ratings = [
            new() { Source = "imdb", Score = 81, Value = 8.2 }, new() { Source = "tmdb", Value = 81 },
            new() { Source = "tomatoes", Score = 92 }, new() { Source = "popcorn", Value = 88 },
            new() { Source = "metacritic", Value = 74 }, new() { Source = "letterboxd", Score = 82 }, new() { Source = "trakt", Value = 85 }] };
        var ratings = TagSourceRatings.FromMdblist(entry)!;
        Assert.Equal(8.1, ratings.Imdb); Assert.Equal(81, ratings.Tmdb);
        Assert.Equal(92, ratings.RtCritic); Assert.Equal(88, ratings.RtAudience);
        Assert.Equal(74, ratings.Metacritic); Assert.Equal(4.1, ratings.Letterboxd); Assert.Equal(85, ratings.Trakt);
        Assert.Null(TagSourceRatings.FromMdblist(new() { Found = false }));
        Assert.Null(TagSourceRatings.FromMdblist(new() { Found = true, Ratings = [new() { Source = "imdb", Value = double.NaN }] }));
        Assert.Equal(0, TagSourceRatings.FromMdblist(new() { Found = true, Ratings = [new() { Source = "imdb", Value = 0 }] })!.Imdb);
        var json = JsonSerializer.Serialize(ratings);
        Assert.Contains("\"rtCritic\":92", json); Assert.DoesNotContain("apikey", json);
    }

    [Fact]
    public void NormalizesPreferencesAndPreservesLegacyAndEmptyLists()
    {
        Assert.Null(RatingSourceSettings.NormalizeSources(null));
        Assert.Empty(RatingSourceSettings.NormalizeSources([])!);
        Assert.Equal(new[] { "trakt", "imdb" }, RatingSourceSettings.NormalizeSources(["trakt", "invalid", "imdb", "trakt"]));
        Assert.Equal(0, RatingSourceSettings.NormalizeMinimum(double.NaN));
        Assert.Equal(10, RatingSourceSettings.NormalizeMinimum(90));
        Assert.Equal(new[] { "community", "critic" }, RatingSourceSettings.Defaults(new PluginConfiguration()));
        Assert.Null(new JellyfinEnhancedUserSettings().RatingTagsSources);
        Assert.Equal(new[] { "critic" }, RatingSourceSettings.Defaults(new PluginConfiguration { RatingTagsShowCommunity = false }));
    }

    [Fact]
    public void CacheCloneComparisonAndNativeHashesIncludeEverySourceFact()
    {
        var original = new TagCacheEntry { Type = "Movie", Ratings = new() { Imdb = 8.1 } };
        var copy = original.Clone();
        Assert.Same(original.Ratings, copy.Ratings);
        Assert.True(TagCacheEntry.ContentEquals(original, copy));
        var firstHash = PosterTagDataProvider.ContentHash(original);
        copy.Ratings = copy.Ratings! with { RtAudience = 90 };
        Assert.False(TagCacheEntry.ContentEquals(original, copy));
        Assert.NotEqual(firstHash, PosterTagDataProvider.ContentHash(copy));
    }

    [Fact]
    public void NativeSourcesFollowOrderMinimumCapStylesAndDigest()
    {
        var user = new JellyfinEnhancedUserSettings { RatingTagsEnabled = true, RatingTagsSources = ["letterboxd", "metacritic", "imdb", "tmdb"], RatingTagsMinScore = 8, RatingTagsColorByScore = true,
            TagLayoutSettingsVersion = 1, TagGroupCaps = new() { Rating = 2 } };
        var settings = PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(user), new PluginConfiguration());
        var entry = new TagCacheEntry { Type = "Movie", Ratings = new() { Letterboxd = 4.1, Metacritic = 74, Imdb = 8.1, Tmdb = 81 } };
        var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)!;
        var tags = Assert.Single(layout.Groups).Tags.Cast<RatingTag>().ToArray();
        Assert.Equal(new[] { "letterboxd", "imdb" }, tags.Select(tag => tag.SourceId));
        Assert.Equal(new[] { "4.1", "8.1" }, tags.Select(tag => tag.Text));
        Assert.All(tags, tag => Assert.Equal("#66bb6a", tag.ScoreColor));
        foreach (var id in RatingSourceSettings.SourceIds.Skip(2)) Assert.Contains(TagStyleKeys.RatingLabels, label => label.Key == id);
        using var assets = PosterTagAssets.Load();
        foreach (var id in RatingSourceSettings.SourceIds.Skip(2)) Assert.NotNull(assets.GetVectorIcon("rating-" + id));
        user.RatingTagsSources = ["imdb", "letterboxd"];
        Assert.NotEqual(settings.Digest, PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(user), new PluginConfiguration()).Digest);
        user.RatingTagsSources = [];
        Assert.Null(PosterTagResolver.Resolve(entry, PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(user), new PluginConfiguration()), new("Movie", false, null, null, null), false));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NativeRendererDrawsEverySourceLogoOrCompactDotAndKeepsTileColoursDistinct(bool compact)
    {
        using var renderer = new PosterTagRenderer();
        using var source = new SkiaSharp.SKBitmap(360, 540); source.Erase(SkiaSharp.SKColors.Gray);
        foreach (var id in RatingSourceSettings.SourceIds.Skip(2))
        {
            var kind = Enum.Parse<PosterRatingSource>(id, true);
            PosterTagLayout Layout(string colour) => new([new(PosterTagGroup.Rating, PosterTagCorner.BottomRight,
                [new RatingTag(kind, "8.1", true, colour, compact)])], false, false);
            var plan = renderer.Plan(360, 540, Layout("#ef5350"));
            var chip = Assert.Single(Assert.Single(plan.Groups).Items);
            Assert.Equal(compact ? 2 : 14, chip.IconWidth);
            using var red = renderer.Render(source, Layout("#ef5350"));
            using var green = renderer.Render(source, Layout("#66bb6a"));
            Assert.NotNull(red); Assert.NotNull(green); Assert.NotEqual(red.Pixels, green.Pixels);
        }
    }

    [Fact]
    public async Task BatchesAreBoundedShareFreshCacheAndStopAtQuotaFloor()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.MdblistApiKey = "fixture-key";
        var batchSizes = new List<int>();
        using var transport = new IntegrationTransport(async (request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}");
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var ids = body.RootElement.GetProperty("ids").EnumerateArray().Select(v => v.GetInt64()).ToArray();
            batchSizes.Add(ids.Length);
            return IntegrationTransport.Response(JsonSerializer.Serialize(ids.Select(id => new { ids = new { tmdb = id }, ratings = new[] { new { source = "imdb", score = 81 } } })));
        });
        using var service = new MdblistService(transport, fixture.Core.Paths.Object, fixture.Core.Logger);
        var titles = Enumerable.Range(1, 151).Select(id => ("movie", id.ToString())).ToArray();
        await Task.WhenAll(service.WarmTagRatingsAsync(titles, default), service.WarmTagRatingsAsync(titles, default));
        Assert.Equal(new[] { 150, 1 }, batchSizes);
        Assert.False(service.NeedsFetch("movie", "1"));
        Assert.Equal(8.1, TagSourceRatings.FromMdblist(service.GetCachedEntry("movie", "1"))!.Imdb);
    }

    [Theory]
    [InlineData(.45f, 59.5f, "0.5", "60%", true)]
    [InlineData(.0000001f, 59.500001f, "—", "60%", true)]
    public void LegacyFloatProjectionMatchesBatchAndBrowserRounding(float community, float critic, string communityText, string criticText, bool fresh)
    {
        var settings = PosterTagSettings.FromSettingsJson("{ratingTagsEnabled:true}", new PluginConfiguration());
        var entry = new TagCacheEntry { Type = "Movie", CommunityRating = community, CriticRating = critic };
        var tags = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)!.Groups.Single().Tags.Cast<RatingTag>().ToArray();
        Assert.Equal(criticText, tags[0].Text); Assert.Equal(fresh, tags[0].Fresh); Assert.Equal(communityText, tags[1].Text);
    }

    [Theory]
    [InlineData(5, 200)]
    [InlineData(1000, 500)]
    public async Task QuotaExhaustionAndFailedBatchesUseShortRetryWithoutRepeatedUpstreamCalls(int remaining, int status)
    {
        using var fixture = new ApiPluginFixture(); fixture.Plugin.Configuration.MdblistApiKey = "fixture-key";
        var requests = 0;
        using var transport = new IntegrationTransport((request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response($"{{\"rate_limit\":1000,\"rate_limit_remaining\":{remaining}}}"));
            requests++;
            return Task.FromResult(IntegrationTransport.Response("{}", status));
        });
        using var service = new MdblistService(transport, fixture.Core.Paths.Object, fixture.Core.Logger);
        await service.WarmTagRatingsAsync(new[] { ("movie", "1") }, default);
        await service.WarmTagRatingsAsync(new[] { ("movie", "1") }, default);
        Assert.Equal(remaining <= 5 ? 0 : 1, requests);
        if (remaining <= 5)
        {
            Assert.Null(service.GetCachedEntry("movie", "1"));
            Assert.True(service.NeedsFetch("movie", "1"));
        }
        else
        {
            Assert.False(service.GetCachedEntry("movie", "1")!.Confirmed);
            Assert.False(service.NeedsFetch("movie", "1"));
        }
    }

    [Fact]
    public void RemovingTheConfiguredKeyDropsCachedAndMemoizedSourceFactsWithoutMutatingTheSharedEntry()
    {
        using var fixture = new ApiPluginFixture();
        var entry = new TagCacheEntry { Type = "Movie", Ratings = new() { Imdb = 8.1 }, CommunityRating = 8 };
        fixture.Plugin.Configuration.MdblistApiKey = "fixture-key";
        Assert.Same(entry, TagCacheService.ApplySourceRatingAvailability(entry));
        fixture.Plugin.Configuration.MdblistApiKey = "";
        var unavailable = TagCacheService.ApplySourceRatingAvailability(entry);
        Assert.NotSame(entry, unavailable); Assert.Null(unavailable.Ratings); Assert.NotNull(entry.Ratings);
        Assert.Equal(entry.CommunityRating, unavailable.CommunityRating);
    }

    [Fact]
    public void CacheProjectionUsesSeriesForChildrenAndRequiresKey()
    {
        using var fixture = new ApiPluginFixture();
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No network"));
        using var service = new MdblistService(transport, fixture.Core.Paths.Object, fixture.Core.Logger);
        service.MergeMediaBatchIntoCache("tv", ["123"], new Dictionary<string, MdblistCacheEntry> { ["123"] = new() { Found = true, Ratings = [new() { Source = "imdb", Score = 81 }] } });
        var series = new Series { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var episode = new Episode { SeriesId = series.Id };
        var library = new Mock<ILibraryManager>(); library.Setup(l => l.GetItemById<BaseItem>(series.Id)).Returns(series);
        using var cache = new TagCacheService(library.Object, fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger, new MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger), service);
        Assert.Null(cache.GetSourceRatings(episode));
        fixture.Plugin.Configuration.MdblistApiKey = "fixture-key";
        Assert.Equal(8.1, cache.GetSourceRatings(episode)!.Imdb);
        Assert.Equal(cache.GetSourceRatings(series), cache.GetSourceRatings(new Season { SeriesId = series.Id }));
    }
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    public void EnrichmentRequiresEnabledNamedSourceDemand(bool adminOn, bool userOn, bool fetches)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        f.Plugin.Configuration.RatingTagsEnabled = adminOn;
        f.Plugin.Configuration.RatingTagsSources = ["imdb"];
        f.Core.Write(Guid.NewGuid().ToString("N"), JsonSerializer.Serialize(new JellyfinEnhancedUserSettings { RatingTagsEnabled = userOn, RatingTagsSources = ["imdb"] }));
        var requests = 0;
        using var transport = new IntegrationTransport((request, _) => {
            requests++;
            return Task.FromResult(IntegrationTransport.Response(request.RequestUri!.AbsolutePath == "/user"
                ? "{\"rate_limit\":1000,\"rate_limit_remaining\":1000}" : "[]"));
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<Guid>());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), service);
        cache.BuildFullCache(null, default);
        cache.WarmSourceRatingsForItems([movie], default);
        cache.BuildEntryOnDemand(movie);
        Assert.Equal(fetches ? 2 : 0, requests);
        if (!fetches)
        {
            f.Plugin.Configuration.RatingTagsEnabled = true;
            f.Plugin.Configuration.RatingTagsSources = ["community", "critic"];
            cache.BuildFullCache(null, default);
            cache.WarmSourceRatingsForItems([movie], default);
            Assert.Equal(0, requests);
        }
    }

    [Theory]
    [InlineData("reconcile", 399, 0)]
    [InlineData("update", 399, 0)]
    [InlineData("update", 400, 0)]
    [InlineData("update", 401, 1)]
    public void BackgroundReconciliationAndUpdatesRespectConfiguredReserve(string caller, int remaining, int expectedRequests)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        f.Plugin.Configuration.MdblistFetchReserve = 400;
        f.Plugin.Configuration.RatingTagsSources = ["imdb"];
        var requests = 0;
        using var transport = new IntegrationTransport((request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response($"{{\"rate_limit\":1000,\"rate_limit_remaining\":{remaining}}}"));
            requests++;
            return Task.FromResult(IntegrationTransport.Response("[]"));
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie) ? new[] { movie.Id } : Array.Empty<Guid>());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        library.Setup(l => l.GetItemById<BaseItem>(movie.Id)).Returns(movie);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), service);
        cache.BuildFullCache(null, default);
        Assert.True(cache.TryGetEntry(movie.Id, out _));
        f.Plugin.Configuration.RatingTagsEnabled = true;
        if (caller == "reconcile") cache.ReconcileCache(null, default);
        else
        {
            cache.EnqueueUpdate(movie.Id);
            typeof(TagCacheService).GetMethod("FlushPending", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(cache, null);
        }
        Assert.Equal(expectedRequests, requests);
        if (expectedRequests == 0) Assert.True(service.NeedsFetch("movie", "123"));
    }

    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => [];
    }

    [Fact]
    public void BatchEndpointIncludesRatingsAndNeverReturnsInaccessibleItems()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.MdblistApiKey = "fixture-key";
        var user = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Fresh cache needs no network"));
        using var service = new MdblistService(transport, fixture.Core.Paths.Object, fixture.Core.Logger);
        service.MergeMediaBatchIntoCache("movie", ["123"], new Dictionary<string, MdblistCacheEntry> { ["123"] = new() { Found = true, FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Ratings = [new() { Source = "imdb", Score = 81 }] } });
        var library = new Mock<ILibraryManager>(); library.Setup(l => l.GetItemById<BaseItem>(movie.Id, user)).Returns(movie);
        var users = new Mock<IUserManager>(); users.Setup(m => m.GetUserById(user.Id)).Returns(user);
        using var cache = new TagCacheService(library.Object, fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger, new MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger), service);
        var controller = ApiAssetTests.Controller(fixture.Core, cache, library.Object, users.Object);
        controller.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user.Id, false);
        var result = Assert.IsType<Microsoft.AspNetCore.Mvc.OkObjectResult>(controller.GetTagData(user.Id, [movie.Id.ToString(), Guid.NewGuid().ToString()]));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
        var item = Assert.Single(json.RootElement.GetProperty("Items").EnumerateArray());
        Assert.Equal(8.1, item.GetProperty("Ratings").GetProperty("imdb").GetDouble());
        Assert.DoesNotContain("fixture-key", json.RootElement.GetRawText());
        Assert.Equal(8.1, cache.BuildEntryOnDemand(movie)!.Ratings!.Imdb);
    }

}
