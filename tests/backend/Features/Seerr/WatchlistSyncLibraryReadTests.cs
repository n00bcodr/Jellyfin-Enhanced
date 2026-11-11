using System.Linq.Expressions;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests.Features.Seerr;

[Collection("Plugin singleton")]
public class WatchlistSyncLibraryReadTests
{
    private static Mock<IUserManager> Users(params User[] users)
    {
        var mock = new Mock<IUserManager>();
        var p = Expression.Parameter(typeof(IUserManager), "u");
        var method = typeof(IUserManager).GetMethod("GetUsers", Type.EmptyTypes);
        Expression body = method != null ? Expression.Call(p, method) : Expression.Property(p, "Users");
        mock.Setup(Expression.Lambda<Func<IUserManager, IEnumerable<User>>>(body, p)).Returns(users);
        return mock;
    }

    [Fact]
    public async Task InboundSyncReadsTheLibraryOncePerMediaTypeNotOncePerTitle()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test";
        config.PreventWatchlistReAddition = false;
        config.AddRequestedMediaToWatchlist = false;
        var first = new User("first", "default", "default") { Id = Guid.NewGuid() };
        var second = new User("second", "default", "default") { Id = Guid.NewGuid() };
        var library = Enumerable.Range(1, 30).Select(i => (BaseItem)new Movie { Id = Guid.NewGuid(), Name = $"Movie {i}", ProviderIds = new() { ["Tmdb"] = i.ToString() } })
            .Concat(Enumerable.Range(101, 10).Select(i => (BaseItem)new Series { Id = Guid.NewGuid(), Name = $"Show {i}", ProviderIds = new() { ["Tmdb"] = i.ToString() } }))
            .ToArray();
        var libraryReads = 0;
        var libraryManager = new Mock<ILibraryManager>();
        libraryManager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Callback(() => libraryReads++)
            .Returns((InternalItemsQuery q) => library.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind())).ToArray());
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>())).Returns(() => new UserItemData { Key = "fixture", Likes = false });
        var watchlist = JsonSerializer.Serialize(new
        {
            page = 1,
            totalPages = 1,
            totalResults = 40,
            results = Enumerable.Range(1, 30).Select(i => new { tmdbId = i, mediaType = "movie" })
                .Concat(Enumerable.Range(101, 10).Select(i => new { tmdbId = i, mediaType = "tv" })),
        });
        using var seerr = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath == "/api/v1/user"
                ? JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = first.Id.ToString("N") }, new { id = 28, jellyfinUserId = second.Id.ToString("N") } } })
                : watchlist)));
        var task = new JellyseerrWatchlistSyncTask(libraryManager.Object, Users(first, second).Object, data.Object, seerr, f.Core.Manager, f.Core.Logger);

        var summary = await task.RunAsync(null, default);

        Assert.Equal(80, summary!.ItemsAdded);
        Assert.Equal(2, libraryReads);
    }
}
