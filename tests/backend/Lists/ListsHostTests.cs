using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Moq;

namespace JE.Tests;

// The production Jellyfin seam (JellyfinListHost) over mocked managers.
public class ListsHostTests
{
    [Fact]
    public void FindMovieByTmdbChecksEveryCopyUntilOneIsVisibleToAllUsers()
    {
        var caller = FakeListHost.MakeUser("admin", admin: true);
        var owner = FakeListHost.MakeUser("owner");
        // Six copies of one TMDB id in per-user libraries; only the last is in a library the owner can see.
        var copies = Enumerable.Range(0, 6).Select(_ => new Movie { Id = Guid.NewGuid() }).ToArray();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery q) => copies.Take(q.Limit ?? int.MaxValue).Cast<BaseItem>().ToArray());
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), caller))
            .Returns((Guid id, Jellyfin.Database.Implementations.Entities.User? _) => copies.FirstOrDefault(c => c.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), owner))
            .Returns((Guid id, Jellyfin.Database.Implementations.Entities.User? _) => id == copies[5].Id ? copies[5] : null);
        var host = new JellyfinListHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<ICollectionManager>());

        Assert.Equal(copies[5].Id, host.FindMovieByTmdb(10193, new[] { caller, owner }));
        Assert.Equal(copies[0].Id, host.FindMovieByTmdb(10193, new[] { caller }));
        Assert.Null(host.FindMovieByTmdb(10193, Array.Empty<Jellyfin.Database.Implementations.Entities.User>()));
    }
}
