using Microsoft.AspNetCore.Mvc;
using MediaBrowser.Controller.Session;
using System.Security.Claims;
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
    public async Task OverlappingBulkAndIncrementalBatchesNeverCrossTheReserve()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.MdblistApiKey = "fixture-key";
        config.MdblistRatingsEnabled = true;
        config.MdblistRatingsFetchEnabled = true;
        config.MdblistFetchReserve = 400;
        var firstBatch = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var batches = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            if (request.RequestUri!.AbsolutePath == "/user") return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":401}");
            if (Interlocked.Increment(ref batches) == 1)
            {
                firstBatch.SetResult();
                await release.Task.WaitAsync(token);
            }
            return IntegrationTransport.Response("[]");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "1" } } });
        var bulk = new Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks.MdblistRatingsFetchTask(library.Object, service, f.Core.Logger).ExecuteAsync(new Progress<double>(), default);
        var incremental = service.WarmTagRatingsAsync(new[] { ("movie", "2") }, default, 400);
        int overlapping;
        try
        {
            await firstBatch.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // Give the other caller time to pass a stale "401 > 400" check and send its own batch.
            await Task.Delay(300);
            overlapping = Volatile.Read(ref batches);
        }
        finally { release.TrySetResult(); }
        await Task.WhenAll(bulk, incremental).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, overlapping);
        Assert.Equal(1, batches);
        Assert.Equal(400, service.RemainingQuota());
        Assert.True(service.NeedsFetch("movie", "1") != service.NeedsFetch("movie", "2"));
    }

    [Fact]
    public async Task LateAccountStatusFromTheBulkRunnerNeverRestoresSpentQuota()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.MdblistApiKey = "fixture-key";
        config.MdblistRatingsEnabled = true;
        config.MdblistRatingsFetchEnabled = true;
        config.MdblistFetchReserve = 400;
        var firstUser = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseUser = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var users = 0;
        var batches = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            if (request.RequestUri!.AbsolutePath == "/user")
            {
                // The runner's own /user (the first) answers 401 only after the warmer has spent one request.
                if (Interlocked.Increment(ref users) == 1)
                {
                    firstUser.SetResult();
                    await releaseUser.Task.WaitAsync(token);
                }
                return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":401}");
            }
            Interlocked.Increment(ref batches);
            return IntegrationTransport.Response("[]");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "1" } } });
        var bulk = new Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks.MdblistRatingsFetchTask(library.Object, service, f.Core.Logger).ExecuteAsync(new Progress<double>(), default);
        await firstUser.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await service.WarmTagRatingsAsync(new[] { ("movie", "2") }, default, 400);
            Assert.Equal(400, service.RemainingQuota());
        }
        finally { releaseUser.TrySetResult(); }
        await bulk.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, batches);
        Assert.Equal(400, service.RemainingQuota());
        Assert.True(service.NeedsFetch("movie", "1"));
    }

    [Fact]
    public async Task ForcedAccountStatusRefreshStartedBeforeABatchIsReconciledWithItsSpend()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        var forcedUser = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseUser = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var users = 0;
        var batches = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            if (request.RequestUri!.AbsolutePath == "/user")
            {
                if (Interlocked.Increment(ref users) == 2)
                {
                    forcedUser.SetResult();
                    await releaseUser.Task.WaitAsync(token);
                }
                return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":401}");
            }
            Interlocked.Increment(ref batches);
            return IntegrationTransport.Response("[]");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        Assert.Equal(401, (await service.GetAccountStatusAsync(default))!.RateLimitRemaining);
        // As the settings page's status check does: a forced refresh of the saved key, answered late.
        var forced = service.GetAccountStatusAsync(default, forceRefresh: true);
        await forcedUser.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await service.WarmTagRatingsAsync(new[] { ("movie", "1") }, default, 400);
            Assert.Equal(400, service.RemainingQuota());
        }
        finally { releaseUser.TrySetResult(); }
        Assert.Equal(400, (await forced.WaitAsync(TimeSpan.FromSeconds(5)))!.RateLimitRemaining);
        Assert.Equal(400, service.RemainingQuota());
        await service.WarmTagRatingsAsync(new[] { ("movie", "2") }, default, 400);
        Assert.Equal(1, batches);
        Assert.True(service.NeedsFetch("movie", "2"));
    }

    [Theory]
    [InlineData(503)]
    [InlineData(429)]
    public async Task UnknownQuotaStatusSkipsBackgroundEnrichmentAndLeavesTitlesRetryable(int userStatus)
    {
        using var fixture = new ApiPluginFixture(); fixture.Plugin.Configuration.MdblistApiKey = "fixture-key";
        var requests = 0;
        using var transport = new IntegrationTransport((request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response("{}", userStatus));
            requests++;
            return Task.FromResult(IntegrationTransport.Response("[{\"ids\":{\"tmdb\":1},\"ratings\":[{\"source\":\"imdb\",\"score\":81}]}]"));
        });
        using var service = new MdblistService(transport, fixture.Core.Paths.Object, fixture.Core.Logger);
        await service.WarmTagRatingsAsync(new[] { ("movie", "1") }, default, 400);
        await service.WarmTagRatingsAsync(new[] { ("movie", "1") }, default);
        Assert.Equal(0, requests);
        Assert.Null(service.GetCachedEntry("movie", "1"));
        Assert.True(service.NeedsFetch("movie", "1"));
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

    [Fact]
    public void SourceDemandReadsUsersSettingsOncePerIntervalAndAUserSaveFlipsItAtOnce()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        f.Plugin.Configuration.RatingTagsEnabled = true;
        f.Plugin.Configuration.RatingTagsSources = null;
        var ids = Enumerable.Range(0, 20).Select(_ => Guid.NewGuid().ToString("N")).ToArray();
        foreach (var id in ids)
            f.Core.Write(id, JsonSerializer.Serialize(new JellyfinEnhancedUserSettings { RatingTagsEnabled = true, RatingTagsSources = ["community", "critic"] }));
        var requests = 0;
        using var transport = new IntegrationTransport((request, _) => {
            requests++;
            return Task.FromResult(IntegrationTransport.Response(request.RequestUri!.AbsolutePath == "/user"
                ? "{\"rate_limit\":1000,\"rate_limit_remaining\":1000}" : "[]"));
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var library = new Mock<ILibraryManager>();
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), service);
        for (var i = 0; i < 50; i++) cache.WarmSourceRatingsForItems([movie], default);
        Assert.Equal(0, requests);
        Assert.Equal(1, cache.UserSourceRatingDemandScans);

        // The first user naming a source saves through the real endpoint: the next call enriches.
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", ids[3])], "test"));
        var saved = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(ids[3], "settings.json");
        saved.RatingTagsSources = ["imdb"];
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(ids[3], saved));
        cache.WarmSourceRatingsForItems([movie], default);
        Assert.True(requests > 0, "enriched right after the save");
        Assert.Equal(2, cache.UserSourceRatingDemandScans);

        // Reset puts every user back on the administrator's (community/critic) sources: demand ends at once.
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", ids[0]), new Claim(ClaimTypes.Role, "Administrator")], "test"));
        Assert.IsType<OkObjectResult>(controller.ResetAllUsersSettings());
        Assert.Empty(f.Plugin.Configuration.RatingTagsSources ?? []);
        var before = requests;
        cache.WarmSourceRatingsForItems([new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "456" } }], default);
        Assert.Equal(before, requests);
    }

    [Theory]
    [InlineData(20, 1)]
    [InlineData(160, 2)]
    public void FlushWarmsTheChangedTitlesInBatchesOutsideTheRebuildLock(int titles, int expectedBatches)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        f.Plugin.Configuration.RatingTagsEnabled = true;
        f.Plugin.Configuration.RatingTagsSources = ["imdb"];
        TagCacheService? cache = null;
        var batches = new List<int>();
        var lockHeld = new List<bool>();
        using var transport = new IntegrationTransport(async (request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}");
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var ids = body.RootElement.GetProperty("ids").EnumerateArray().Select(v => v.GetInt64()).ToArray();
            batches.Add(ids.Length);
            var rebuildLock = (SemaphoreSlim)typeof(TagCacheService).GetField("_rebuildLock", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(cache)!;
            lockHeld.Add(rebuildLock.CurrentCount == 0);
            return IntegrationTransport.Response(JsonSerializer.Serialize(ids.Select(id => new { ids = new { tmdb = id }, ratings = new[] { new { source = "imdb", score = 81 } } })));
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var movies = Enumerable.Range(1, titles).Select(i => new Movie { Id = Guid.NewGuid(), Name = $"m{i}", ProviderIds = new() { ["Tmdb"] = (1000 + i).ToString() } }).ToArray();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<Guid>());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<BaseItem>());
        foreach (var movie in movies) library.Setup(l => l.GetItemById<BaseItem>(movie.Id)).Returns(movie);
        cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), service);
        using (cache)
        {
            cache.BuildFullCache(null, default);
            foreach (var movie in movies) cache.EnqueueUpdate(movie.Id);
            typeof(TagCacheService).GetMethod("FlushPending", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(cache, null);
            Assert.Equal(expectedBatches, batches.Count);
            Assert.Equal(titles, batches.Sum());
            Assert.DoesNotContain(true, lockHeld);
            Assert.All(movies, movie => Assert.Equal(8.1, Assert.IsType<TagCacheEntry>(cache.TryGetEntry(movie.Id, out var entry) ? entry : null).Ratings!.Imdb));
        }
    }

    [Fact]
    public async Task OnDemandBuildNeverWaitsForMdblistAndTheBackgroundWarmRetiresTheNativeMemo()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        f.Plugin.Configuration.RatingTagsEnabled = true;
        f.Plugin.Configuration.RatingTagsSources = ["imdb"];
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var batches = 0;
        using var transport = new IntegrationTransport(async (request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}");
            Interlocked.Increment(ref batches);
            await gate.Task;
            return IntegrationTransport.Response("[{\"ids\":{\"tmdb\":123},\"ratings\":[{\"source\":\"imdb\",\"score\":81}]}]");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), service);
        cache.RatingWarmDelay = TimeSpan.Zero;
        var warmed = new List<Guid>();
        cache.SourceRatingsWarmed += ids => { lock (warmed) warmed.AddRange(ids); };
        using var native = new PosterTagDataProvider(cache, Mock.Of<ILibraryManager>(), null!, null!, null!, f.Core.Logger);
        Task<TagCacheEntry?> Native() => (Task<TagCacheEntry?>)typeof(PosterTagDataProvider).GetMethod("GetOrBuildAsync", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(native, [movie, CancellationToken.None])!;
        var build = Native();
        Assert.True(build.Wait(TimeSpan.FromSeconds(5)), "the native on-demand build does not wait for MDBList");
        Assert.Null(build.Result!.Ratings);
        // The same title asked again while queued is not queued twice.
        cache.BuildEntryOnDemand(movie);
        gate.SetResult();
        await cache.RatingWarmQueue.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, batches);
        Assert.Equal([movie.Id], warmed);
        var after = await Native();
        Assert.NotSame(build.Result, after);
        Assert.Equal(8.1, after!.Ratings!.Imdb);
        await cache.RatingWarmQueue.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, batches);
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

    [Theory]
    [InlineData("/user")]
    [InlineData("/tmdb/movie/")]
    public async Task CancelledEnrichmentDoesNotCacheFailureAndCanRetryImmediately(string cancelPath)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancel = true;
        var batches = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            var path = request.RequestUri!.AbsolutePath;
            if (path != "/user") batches++;
            if (cancel && path == cancelPath)
            {
                started.SetResult();
                await Task.Delay(Timeout.Infinite, token);
            }
            return IntegrationTransport.Response(path == "/user" ? "{\"rate_limit\":1000,\"rate_limit_remaining\":1000}"
                : "[{\"ids\":{\"tmdb\":123},\"ratings\":[{\"source\":\"imdb\",\"score\":81}]}]");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var pending = service.WarmTagRatingsAsync(new[] { ("movie", "123") }, cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Null(service.GetCachedEntry("movie", "123"));
        Assert.True(service.NeedsFetch("movie", "123"));
        cancel = false;
        await service.WarmTagRatingsAsync(new[] { ("movie", "123") }, default);
        Assert.Equal(cancelPath == "/user" ? 1 : 2, batches);
        Assert.Equal(8.1, TagSourceRatings.FromMdblist(service.GetCachedEntry("movie", "123"))!.Imdb);
    }

    [Theory]
    [InlineData("single")]
    [InlineData("warmer")]
    public async Task CancelledSingleTitleFetchPublishesNothingAndRetriesImmediately(string retry)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancel = true;
        var mediaRequests = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/user") return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}");
            mediaRequests++;
            if (cancel)
            {
                started.SetResult();
                await Task.Delay(Timeout.Infinite, token);
            }
            return IntegrationTransport.Response(request.Method == HttpMethod.Post
                ? "[{\"ids\":{\"tmdb\":123},\"ratings\":[{\"source\":\"imdb\",\"score\":81}]}]"
                : "{\"ids\":{\"tmdb\":123},\"ratings\":[{\"source\":\"imdb\",\"score\":81}]}");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var pending = service.GetRatingsAsync("movie", "123", cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Null(service.GetCachedEntry("movie", "123"));
        Assert.True(service.NeedsFetch("movie", "123"));
        cancel = false;
        if (retry == "single") Assert.True((await service.GetRatingsAsync("movie", "123", default)).Found);
        else await service.WarmTagRatingsAsync(new[] { ("movie", "123") }, default);
        Assert.Equal(2, mediaRequests);
        Assert.Equal(8.1, TagSourceRatings.FromMdblist(service.GetCachedEntry("movie", "123"))!.Imdb);
    }

    [Fact]
    public async Task AvailabilityRefreshWaitsForRebuildAndPreservesNewerMetadata()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Cache-only"));
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        service.MergeMediaBatchIntoCache("movie", ["123"], new Dictionary<string, MdblistCacheEntry> { ["123"] = new() { Found = true, Ratings = [new() { Source = "imdb", Score = 81 }] } });
        var movie = new Movie { Id = Guid.NewGuid(), CommunityRating = 7, ProviderIds = new() { ["Tmdb"] = "123" } };
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var rebuilding = false;
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => {
            if (rebuilding) { entered.Set(); Assert.True(release.Wait(TimeSpan.FromSeconds(5))); }
            return q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie) ? new[] { movie.Id } : Array.Empty<Guid>();
        });
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), service);
        cache.BuildFullCache(null, default);
        Assert.True(cache.TryGetEntry(movie.Id, out var original));
        Assert.NotNull(original.Ratings);

        // Availability changes are a complete in-place write pass: one store epoch and one closing epoch.
        f.Plugin.Configuration.MdblistApiKey = "";
        var epoch = typeof(TagCacheService).GetField("_mutationEpoch", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var before = (long)epoch.GetValue(cache)!;
        cache.RefreshRatingSourceAvailability();
        Assert.Equal(before + 2, (long)epoch.GetValue(cache)!);
        Assert.NotNull(original.Ratings);
        Assert.True(cache.TryGetEntry(movie.Id, out var stripped));
        Assert.Null(stripped.Ratings);
        f.Plugin.Configuration.MdblistApiKey = "fixture-key";
        cache.RefreshRatingSourceAvailability();

        movie.CommunityRating = 9;
        rebuilding = true;
        var build = Task.Run(() => cache.BuildFullCache(null, default));
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        f.Plugin.Configuration.MdblistApiKey = "";
        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresh = Task.Run(() => { refreshStarted.SetResult(); cache.RefreshRatingSourceAvailability(); });
        bool finishedDuringBuild;
        try
        {
            await refreshStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            finishedDuringBuild = await Task.WhenAny(refresh, Task.Delay(150)) == refresh;
        }
        finally { release.Set(); }
        await Task.WhenAll(build, refresh).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(finishedDuringBuild);
        Assert.True(cache.TryGetEntry(movie.Id, out var latest));
        Assert.Equal(9, latest.CommunityRating);
        Assert.Null(latest.Ratings);
        Assert.Equal(7, original.CommunityRating);
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
