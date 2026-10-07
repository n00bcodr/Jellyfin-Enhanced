using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class TaskMetadataTests
{
    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task RatingsSyncFillsMissingPreservesOrOverwritesExistingAndIsIdempotent(bool overwrite)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistRatingsEnabled = true;
        f.Plugin.Configuration.MdblistRatingsAutoSyncEnabled = true;
        f.Plugin.Configuration.MdblistRatingsOverwriteExisting = overwrite;
        // One movie has only a community rating, the other only a critic rating: each existing
        // value is preserved without overwrite while the missing one is filled.
        var movie = new Movie { Id = Guid.NewGuid(), CommunityRating = 4, ProviderIds = new() { ["Tmdb"] = "123" } };
        var critic = new Movie { Id = Guid.NewGuid(), CriticRating = 50, ProviderIds = new() { ["Tmdb"] = "124" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie, critic });
        var writes = 0;
        library.Setup(l => l.UpdateItemAsync(It.IsAny<BaseItem>(), It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>())).Callback(() => writes++).Returns(Task.CompletedTask);
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Sync must be offline"));
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        MdblistCacheEntry Ratings() => new() { Found = true, Confirmed = true, FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Ratings = [new() { Source = "tmdb", Score = 82 }, new() { Source = "tomatoes", Score = 91 }] };
        service.MergeMediaBatchIntoCache("movie", ["123", "124"], new Dictionary<string, MdblistCacheEntry> { ["123"] = Ratings(), ["124"] = Ratings() });
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            var task = new MdblistRatingsSyncTask(library.Object, service, f.Core.Logger);
            await task.ExecuteAsync(new Progress<double>(), default);
            Assert.Equal(overwrite ? 8.2f : 4f, movie.CommunityRating);
            Assert.Equal(91f, movie.CriticRating);
            Assert.Equal(8.2f, critic.CommunityRating);
            Assert.Equal(overwrite ? 91f : 50f, critic.CriticRating);
            Assert.Equal(2, writes);
            await task.ExecuteAsync(new Progress<double>(), default);
            Assert.Equal(2, writes);
            Assert.Equal(0, transport.Calls);
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    [Theory]
    [InlineData(400, 0)][InlineData(1000, 1)]
    [InlineData(401, 1, 151)][InlineData(1000, 2, 151)]
    public async Task RatingsFetchHonorsReserveDeduplicatesAndSkipsWarmCache(int remaining, int expectedBatches, int itemCount = 1)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.MdblistRatingsEnabled = true;
        config.MdblistRatingsFetchEnabled = true;
        config.MdblistApiKey = "test";
        config.MdblistFetchReserve = 400;
        var library = new Mock<ILibraryManager>();
        var movies = Enumerable.Range(123, itemCount).Select(id => (BaseItem)new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = id.ToString() } })
            .Concat(new BaseItem[] { new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } }, new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "invalid" } } }).ToArray();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(movies);
        var batches = new List<string>();
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            if (request.RequestUri!.AbsolutePath == "/user")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { rate_limit = 1000, rate_limit_remaining = remaining, rate_limit_reset = 1800000000 }));
            batches.Add(await request.Content!.ReadAsStringAsync(ct));
            return IntegrationTransport.Response("[]");
        });
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        var task = new MdblistRatingsFetchTask(library.Object, service, f.Core.Logger);
        await task.ExecuteAsync(new Progress<double>(), default);
        await task.ExecuteAsync(new Progress<double>(), default);
        Assert.Equal(expectedBatches, batches.Count);
        if (expectedBatches > 0)
        {
            var requestedIds = new List<int>();
            foreach (var batch in batches)
            {
                using var body = JsonDocument.Parse(batch);
                var ids = body.RootElement.GetProperty("ids").EnumerateArray().Select(id => id.GetInt32()).ToArray();
                Assert.InRange(ids.Length, 1, 150);
                requestedIds.AddRange(ids);
            }
            Assert.Equal(Math.Min(itemCount, expectedBatches * 150), requestedIds.Count);
            Assert.Equal(requestedIds.Count, requestedIds.Distinct().Count());
            Assert.Equal(Math.Min(itemCount, expectedBatches * 150), Enumerable.Range(123, itemCount).Count(id => !service.NeedsFetch("movie", id.ToString())));
            Assert.False(service.NeedsFetch("movie", "123"));
            Assert.True(service.GetCachedEntry("movie", "123")!.Confirmed);
        }
        else Assert.True(service.NeedsFetch("movie", "123"));
        library.Verify(l => l.UpdateItemAsync(It.IsAny<BaseItem>(), It.IsAny<BaseItem>(), It.IsAny<ItemUpdateType>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ArrSyncPreservesUnrelatedTagsFiltersLabelsAndDoesNotRewriteIdenticalResults()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.ArrTagsSyncEnabled = true;
        config.ArrTagsClearOldTags = true;
        config.ArrTagsPrefix = "Arr: ";
        config.ArrTagsSyncFilter = "alice";
        config.RadarrInstances = "[{\"Name\":\"Test\",\"Url\":\"http://radarr.test\",\"ApiKey\":\"test\",\"Enabled\":true}]";
        var movie = new Movie { Id = Guid.NewGuid(), Tags = ["Keep", "Arr: stale"], ProviderIds = new() { ["Tmdb"] = "123" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        var writes = 0;
        library.Setup(l => l.UpdateItemAsync(movie, It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>())).Callback(() => writes++).Returns(Task.CompletedTask);
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath.EndsWith("/tag") ? "[{\"id\":1,\"label\":\"alice\"},{\"id\":2,\"label\":\"bob\"}]" : "[{\"tmdbId\":123,\"tags\":[1,2]}]")));
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            var task = new ArrTagsSyncTask(library.Object, transport, f.Core.Logger);
            await task.ExecuteAsync(new Progress<double>(), default);
            Assert.Equal(new[] { "Keep", "Arr: alice" }, movie.Tags);
            Assert.Equal(1, writes);
            await task.ExecuteAsync(new Progress<double>(), default);
            Assert.Equal(1, writes);
        }
        finally { BaseItem.LibraryManager = previous; }
    }
    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task RatingsTasksCancelBeforeWritingOrFetchingMedia(bool fetch)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.MdblistRatingsEnabled = true;
        config.MdblistRatingsFetchEnabled = true;
        config.MdblistRatingsAutoSyncEnabled = true;
        config.MdblistApiKey = "test";
        using var cts = new CancellationTokenSource();
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Callback(() => cts.Cancel()).Returns(new BaseItem[] { movie });
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000,\"rate_limit_reset\":1800000000}")));
        using var service = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        MediaBrowser.Model.Tasks.IScheduledTask task = fetch
            ? new MdblistRatingsFetchTask(library.Object, service, f.Core.Logger)
            : new MdblistRatingsSyncTask(library.Object, service, f.Core.Logger);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task.ExecuteAsync(new Progress<double>(), cts.Token));
        Assert.Equal(fetch ? 1 : 0, transport.Calls);
        Assert.Null(movie.CommunityRating);
        Assert.Null(movie.CriticRating);
        library.Verify(l => l.UpdateItemAsync(It.IsAny<BaseItem>(), It.IsAny<BaseItem>(), It.IsAny<ItemUpdateType>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AudioLanguageSyncReplacesStalePrefixedTagsAndIsIdempotent()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AudioLanguageTagSyncEnabled = true;
        var movie = new AudioItems.Movie { Id = Guid.NewGuid(), Tags = ["Keep", "Audio: Stale"] };
        f.Plugin.Configuration.AudioLanguageTagPrefix = "Audio: ";
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        var writes = 0;
        library.Setup(l => l.UpdateItemAsync(movie, It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>())).Callback(() => writes++).Returns(Task.CompletedTask);
        var localization = new Mock<MediaBrowser.Model.Globalization.ILocalizationManager>();
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, localization.Object, f.Core.Logger);
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            var task = new AudioLanguageTagsSyncTask(library.Object, localization.Object, cache, f.Core.Logger);
            await task.ExecuteAsync(new Progress<double>(), default);
            Assert.Equal(new[] { "Keep", "Audio: ENG" }, movie.Tags);
            Assert.Equal(1, writes);
            await task.ExecuteAsync(new Progress<double>(), default);
            Assert.Equal(1, writes);
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    private static class AudioItems
    {
        public sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
        {
            public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
                => [new() { MediaStreams = new List<MediaBrowser.Model.Entities.MediaStream> { new() { Type = MediaBrowser.Model.Entities.MediaStreamType.Audio, Language = "eng" } } }];
        }
    }

}
