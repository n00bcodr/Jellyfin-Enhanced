using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class TaskAutoRequestTests
{
    [Theory]
    [InlineData(2, false, false, 0)]
    [InlineData(3, false, false, 0)]
    [InlineData(5, false, false, 0)]
    [InlineData(1, true, false, 0)]
    [InlineData(1, false, false, 1)]
    [InlineData(1, false, true, 2)]
    public async Task MovieCollectionDecisionsDeduplicateSuccessAndRetryFailure(int status, bool futureRelease, bool failFirst, int expectedPosts)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-seerr";
        config.AutoMovieRequestCheckReleaseDate = true;
        config.AutoMovieRequestQualityMode = "custom";
        config.AutoMovieRequestCustomServerId = 0;
        config.AutoMovieRequestCustomProfileId = 7;
        config.AutoMovieRequestCustomRootFolder = "/movies";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var posts = new List<(string? Identity, string Body)>();
        var lookups = 0;
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/3/movie/123": return IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}");
                case "/api/v1/collection/9": return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate = futureRelease ? "2999-01-01" : "2001-01-01", mediaInfo = new { status } } } }));
                case "/api/v1/user":
                    lookups++;
                    return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N").ToUpperInvariant() } } }));
                case "/api/v1/request":
                    posts.Add((request.Headers.GetValues("X-Api-User").Single(), await request.Content!.ReadAsStringAsync(ct)));
                    return IntegrationTransport.Response("{}", failFirst && posts.Count == 1 ? 500 : 201);
                default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            }
        });
        var service = new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        Assert.Equal(expectedPosts, posts.Count);
        Assert.Equal(expectedPosts > 0 ? 1 : 0, lookups);
        foreach (var post in posts)
        {
            Assert.Equal("22", post.Identity);
            using var payload = JsonDocument.Parse(post.Body);
            Assert.Equal("movie", payload.RootElement.GetProperty("mediaType").GetString());
            Assert.Equal(124, payload.RootElement.GetProperty("mediaId").GetInt32());
            Assert.Equal(0, payload.RootElement.GetProperty("serverId").GetInt32());
            Assert.Equal(7, payload.RootElement.GetProperty("profileId").GetInt32());
            Assert.Equal("/movies", payload.RootElement.GetProperty("rootFolder").GetString());
        }
        if (expectedPosts == 1)
        {
            service.ClearRequestCache();
            await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
            Assert.Equal(2, posts.Count);
            Assert.Equal(1, lookups);
        }
    }

    [Theory]
    [InlineData(false, true)][InlineData(true, false)]
    public async Task DisabledAutomaticRequestsDoNotConsultUsersOrNetwork(bool feature, bool seerr)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AutoMovieRequestEnabled = feature;
        f.Plugin.Configuration.AutoSeasonRequestEnabled = feature;
        f.Plugin.Configuration.JellyseerrEnabled = seerr;
        await new AutoMovieRequestService(null!, f.Core.Logger, null!, null!).CheckMovieForCollectionRequestAsync(new Movie(), Guid.NewGuid());
        await new AutoSeasonRequestService(null!, f.Core.Logger, null!, null!, null!).CheckEpisodeCompletionAsync(new Episode(), Guid.NewGuid());
    }
    [Theory]
    [InlineData(7, 10, 1, false, 0)]
    [InlineData(8, 10, 1, false, 1)]
    [InlineData(10, 0, 1, false, 0)]
    [InlineData(10, 10, 5, false, 0)]
    [InlineData(10, 10, 1, true, 0)]
    [InlineData(8, 10, 1, false, 0, true, false)]
    [InlineData(8, 10, 1, false, 1, true, true)]
    [InlineData(8, 10, 1, false, 2, false, false, true)]
    public async Task SeasonThresholdAvailabilityAndExistingRequestsControlAutomaticRequest(int episodeNumber, int nextEpisodeCount, int nextStatus, bool existingRequest, int expectedPosts, bool requireWatched = false, bool priorPlayed = false, bool failFirst = false)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoSeasonRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test";
        config.AutoSeasonRequestThresholdValue = 2;
        config.AutoSeasonRequestRequireAllWatched = requireWatched;
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var series = new Series { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "42" } };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = episodeNumber };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        var priorEpisode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };
        library.Setup(l => l.GetItemsResult(It.IsAny<InternalItemsQuery>())).Returns(new MediaBrowser.Model.Querying.QueryResult<BaseItem> { Items = new BaseItem[] { priorEpisode, episode } });
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(user, priorEpisode)).Returns(new UserItemData { Key = "prior", Played = priorPlayed });
        var previousLibrary = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            var posts = new List<string>();
            using var transport = new IntegrationTransport(async (request, ct) =>
            {
                if (request.RequestUri!.AbsolutePath == "/api/v1/tv/42")
                    return IntegrationTransport.Response(JsonSerializer.Serialize(new
                    {
                        numberOfSeasons = 2,
                        seasons = new[] { new { seasonNumber = 1, episodeCount = 10, status = 5 }, new { seasonNumber = 2, episodeCount = nextEpisodeCount, status = nextStatus } },
                        mediaInfo = new { requests = existingRequest ? new[] { new { seasons = new[] { new { seasonNumber = 2 } } } } : Array.Empty<object>() }
                    }));
                if (request.RequestUri.AbsolutePath == "/api/v1/user")
                    return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString() } } }));
                if (request.Method == HttpMethod.Post)
                {
                    posts.Add(await request.Content!.ReadAsStringAsync(ct));
                    return IntegrationTransport.Response("{}", failFirst && posts.Count == 1 ? 500 : 201);
                }
                throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            });
            var service = new AutoSeasonRequestService(transport, f.Core.Logger, users.Object, data.Object, library.Object);
            await service.CheckEpisodeCompletionAsync(episode, user.Id);
            await service.CheckEpisodeCompletionAsync(episode, user.Id);
            Assert.Equal(expectedPosts, posts.Count);
            foreach (var post in posts)
            {
                using var payload = JsonDocument.Parse(post);
                Assert.Equal("tv", payload.RootElement.GetProperty("mediaType").GetString());
                Assert.Equal(42, payload.RootElement.GetProperty("mediaId").GetInt32());
                Assert.Equal(2, Assert.Single(payload.RootElement.GetProperty("seasons").EnumerateArray()).GetInt32());
            }
        }
        finally { BaseItem.LibraryManager = previousLibrary; }
    }

}
