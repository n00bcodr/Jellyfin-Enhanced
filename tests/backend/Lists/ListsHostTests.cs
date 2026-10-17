using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;
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
        var host = new JellyfinListHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<ICollectionManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());

        Assert.Equal(copies[5].Id, host.FindMovieByTmdb(10193, new[] { caller, owner }));
        Assert.Equal(copies[0].Id, host.FindMovieByTmdb(10193, new[] { caller }));
        Assert.Null(host.FindMovieByTmdb(10193, Array.Empty<Jellyfin.Database.Implementations.Entities.User>()));
    }

    // Review round 2 (4c1-r2-security-1): the create marker is part of Jellyfin's own create write (a playlist share for
    // the marker id, a collection provider id), a retry finds the list by it, and the playlist's share comes off again.
    [Fact]
    public async Task CreatesCarryTheirMarkerInJellyfinsOwnWriteAndAPlaylistsComesOffAgain()
    {
        var owner = FakeListHost.MakeUser("owner");
        var marker = Guid.NewGuid();
        var playlist = new Playlist { Id = Guid.NewGuid(), OwnerUserId = owner.Id, Name = "Mine", SortName = "Mine" };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Heist", SortName = "Heist", Path = "/config/data/collections/Heist [boxset]" };
        PlaylistCreationRequest? created = null;
        PlaylistUpdateRequest? updated = null;
        CollectionCreationOptions? options = null;
        var playlists = new Mock<IPlaylistManager>();
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>()))
            .Callback((PlaylistCreationRequest r) => { created = r; playlist.Shares = r.Users; })
            .ReturnsAsync(new PlaylistCreationResult(playlist.Id.ToString("N")));
        playlists.Setup(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>())).Callback((PlaylistUpdateRequest r) => updated = r).Returns(Task.CompletedTask);
        var collections = new Mock<ICollectionManager>();
        collections.Setup(c => c.CreateCollectionAsync(It.IsAny<CollectionCreationOptions>()))
            .Callback((CollectionCreationOptions o) => { options = o; box.ProviderIds = o.ProviderIds; })
            .ReturnsAsync(box);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(playlist.Id)).Returns(playlist);
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Playlist)))).Returns(new BaseItem[] { playlist });
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.BoxSet)))).Returns(new BaseItem[] { box });
        var files = new Mock<MediaBrowser.Model.IO.IFileSystem>();
        files.Setup(f => f.GetValidFilename(It.IsAny<string>())).Returns((string name) => name.Replace(":", " ", StringComparison.Ordinal));
        var host = new JellyfinListHost(library.Object, playlists.Object, collections.Object, files.Object);

        Assert.Equal(playlist.Id, await host.CreatePlaylistAsync(new ListWrite(Guid.Empty, owner.Id, ListWriteKind.Create), "Mine", false, marker));
        Assert.Equal(owner.Id, created!.UserId);
        Assert.Equal(marker, Assert.Single(created.Users).UserId);
        Assert.False(created.Users[0].CanEdit);
        Assert.Equal(playlist.Id, host.FindCreated(ListKinds.Playlist, marker, owner.Id)!.Id);
        Assert.Null(host.FindCreated(ListKinds.Playlist, marker, Guid.NewGuid()));
        Assert.Null(host.FindCreated(ListKinds.Playlist, Guid.NewGuid(), owner.Id));

        await host.ClearCreateMarkerAsync(new ListWrite(playlist.Id, owner.Id, ListWriteKind.ClearMarker), marker);
        Assert.Equal(owner.Id, updated!.UserId);
        Assert.Empty(updated.Users!);

        Assert.Equal(box.Id, await host.CreateCollectionAsync(new ListWrite(Guid.Empty, owner.Id, ListWriteKind.Create), "Heist", marker));
        Assert.Equal(marker.ToString("N"), options!.ProviderIds[JellyfinListHost.CreateMarkerKey]);
        Assert.Equal(box.Id, host.FindCreated(ListKinds.Collection, marker, Guid.Empty)!.Id);

        // Jellyfin's folder per collection name: "Heist" (any case) is taken, "Heists" isn't.
        Assert.True(host.CollectionNameTaken("heist"));
        Assert.False(host.CollectionNameTaken("Heists"));
    }

    // A grant is for one write of one list: a second use, another list or another kind of write throws before Jellyfin is asked.
    [Fact]
    public async Task AWriteGrantIsSpentOnceForItsOwnListAndKind()
    {
        var playlists = new Mock<IPlaylistManager>();
        var host = new JellyfinListHost(Mock.Of<ILibraryManager>(), playlists.Object, Mock.Of<ICollectionManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        var list = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var grant = new ListWrite(list, owner, ListWriteKind.Move);

        await host.MoveInPlaylistAsync(grant, Guid.NewGuid(), 0);
        await Assert.ThrowsAsync<InvalidOperationException>(() => host.MoveInPlaylistAsync(grant, Guid.NewGuid(), 0));
        await Assert.ThrowsAsync<InvalidOperationException>(() => host.AddToPlaylistAsync(new ListWrite(list, owner, ListWriteKind.Move), new[] { Guid.NewGuid() }, null));
        Assert.Throws<InvalidOperationException>(() => new ListWrite(list, owner, ListWriteKind.Insert).Spend(Guid.NewGuid(), ListWriteKind.Insert));
        playlists.Verify(p => p.MoveItemAsync(list.ToString("N"), It.IsAny<string>(), 0, owner), Times.Once);
    }
}
