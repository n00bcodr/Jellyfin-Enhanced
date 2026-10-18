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

    // Review rounds 2 and 3 (4c1-r2-security-1, 4c1-r3-behaviour-2): a create carries its marker in Jellyfin's own create
    // write, as the name it runs under (Jellyfin makes the list's folder from it) and, on a collection, a provider id. A
    // playlist gets no share (Jellyfin hands a deleted owner's playlist to its first share). A retry finds the list by its
    // marker, also after the list got its chosen name, which keeps the folder.
    [Fact]
    public async Task CreatesCarryTheirMarkerInJellyfinsOwnWriteAndGetTheirNameAfter()
    {
        var owner = FakeListHost.MakeUser("owner");
        var marker = Guid.NewGuid();
        var playlistName = ListService.CreateName("Mine", marker);
        var collectionName = ListService.CreateName("Heist", marker);
        var playlist = new Playlist { Id = Guid.NewGuid(), OwnerUserId = owner.Id, Name = playlistName, SortName = "Mine", Path = "/config/data/playlists/" + playlistName };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = collectionName, SortName = "Heist", Path = "/config/data/collections/" + collectionName + " [boxset]", ParentId = Guid.NewGuid() };
        PlaylistCreationRequest? created = null;
        PlaylistUpdateRequest? updated = null;
        CollectionCreationOptions? options = null;
        var playlists = new Mock<IPlaylistManager>();
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>()))
            .Callback((PlaylistCreationRequest r) => { created = r; playlist.Shares = r.Users; })
            .ReturnsAsync(new PlaylistCreationResult(playlist.Id.ToString("N")));
        playlists.Setup(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>())).Callback((PlaylistUpdateRequest r) => { updated = r; playlist.Name = r.Name; playlist.SortName = r.Name; }).Returns(Task.CompletedTask);
        var collections = new Mock<ICollectionManager>();
        collections.Setup(c => c.CreateCollectionAsync(It.IsAny<CollectionCreationOptions>()))
            .Callback((CollectionCreationOptions o) => { options = o; box.ProviderIds = o.ProviderIds; })
            .ReturnsAsync(box);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(playlist.Id)).Returns(playlist);
        library.Setup(l => l.GetItemById(box.Id)).Returns(box);
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Playlist)))).Returns(new BaseItem[] { playlist });
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.BoxSet)))).Returns(new BaseItem[] { box });
        var files = new Mock<MediaBrowser.Model.IO.IFileSystem>();
        files.Setup(f => f.GetValidFilename(It.IsAny<string>())).Returns((string name) => name.Replace(":", " ", StringComparison.Ordinal));
        var host = new JellyfinListHost(library.Object, playlists.Object, collections.Object, files.Object);

        Assert.Equal(playlist.Id, await host.CreatePlaylistAsync(new ListWrite(Guid.Empty, owner.Id, ListWriteKind.Create), playlistName, false));
        Assert.Equal(owner.Id, created!.UserId);
        Assert.Equal(playlistName, created.Name);
        Assert.Empty(created.Users);
        Assert.Equal(playlist.Id, host.FindCreated(ListKinds.Playlist, marker, owner.Id)!.Id);
        Assert.Null(host.FindCreated(ListKinds.Playlist, marker, Guid.NewGuid()));
        Assert.Null(host.FindCreated(ListKinds.Playlist, Guid.NewGuid(), owner.Id));

        await host.FinishCreateAsync(new ListWrite(playlist.Id, owner.Id, ListWriteKind.FinishCreate), "Mine");
        Assert.Equal(owner.Id, updated!.UserId);
        Assert.Equal("Mine", updated.Name);
        Assert.Null(updated.Users);
        Assert.Equal(playlist.Id, host.FindCreated(ListKinds.Playlist, marker, owner.Id)!.Id);

        Assert.Equal(box.Id, await host.CreateCollectionAsync(new ListWrite(Guid.Empty, owner.Id, ListWriteKind.Create), collectionName, marker));
        Assert.Equal(collectionName, options!.Name);
        Assert.Equal(marker.ToString("N"), options.ProviderIds[JellyfinListHost.CreateMarkerKey]);
        Assert.Equal(box.Id, host.FindCreated(ListKinds.Collection, marker, Guid.Empty)!.Id);
        await host.FinishCreateAsync(new ListWrite(box.Id, owner.Id, ListWriteKind.FinishCreate), "Heist");
        Assert.Equal("Heist", box.Name);
        library.Verify(l => l.UpdateItemAsync(box, It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>()), Times.Once);
        // Review round 4 (4c1-r4-behaviour-2): a finish always saves, also when the cached item already shows the name (an
        // earlier save may have failed after Jellyfin changed it); the service asks only until a save succeeded.
        await host.FinishCreateAsync(new ListWrite(box.Id, owner.Id, ListWriteKind.FinishCreate), "Heist");
        library.Verify(l => l.UpdateItemAsync(box, It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    // Review round 4 (4c1-r4-behaviour-2): Jellyfin's rename changes the cached item, then saves it. When the save fails the
    // cached item gets its old name back, so nothing shows a name that was never kept.
    [Fact]
    public async Task AFailedRenameLeavesTheCachedItemWithItsOldName()
    {
        var owner = FakeListHost.MakeUser("owner");
        var marker = Guid.NewGuid();
        var playlistName = ListService.CreateName("Mine", marker);
        var collectionName = ListService.CreateName("Heist", marker);
        var playlist = new Playlist { Id = Guid.NewGuid(), OwnerUserId = owner.Id, Name = playlistName, Path = "/config/data/playlists/" + playlistName };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = collectionName, Path = "/config/data/collections/" + collectionName + " [boxset]", ParentId = Guid.NewGuid() };
        var playlists = new Mock<IPlaylistManager>();
        // PlaylistManager.UpdatePlaylist (10.11 / 12.2): sets the name on the cached playlist, then saves it.
        playlists.Setup(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()))
            .Callback((PlaylistUpdateRequest r) => playlist.Name = r.Name)
            .ThrowsAsync(new IOException("database is locked"));
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(playlist.Id)).Returns(playlist);
        library.Setup(l => l.GetItemById(box.Id)).Returns(box);
        library.Setup(l => l.UpdateItemAsync(box, It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("database is locked"));
        var host = new JellyfinListHost(library.Object, playlists.Object, Mock.Of<ICollectionManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());

        await Assert.ThrowsAsync<IOException>(() => host.FinishCreateAsync(new ListWrite(playlist.Id, owner.Id, ListWriteKind.FinishCreate), "Mine"));
        await Assert.ThrowsAsync<IOException>(() => host.FinishCreateAsync(new ListWrite(box.Id, owner.Id, ListWriteKind.FinishCreate), "Heist"));

        Assert.Equal(playlistName, playlist.Name);
        Assert.Equal(collectionName, box.Name);
    }

    // Review round 3 (4c1-r3-behaviour-3): a collection name is taken only by a collection where Jellyfin's create would put
    // it (inside its own collections folder: kept there, named so it would be, or its folder there exists), compared
    // without case; never by an unrelated "[boxset]" folder of the same name in some library.
    [Fact]
    public async Task ACollectionNameIsTakenOnlyAtItsDestinationInJellyfinsCollectionsFolder()
    {
        var items = new List<BaseItem> { new BoxSet { Id = Guid.NewGuid(), Name = "Heist", Path = "/media/other-library/Heist [boxset]" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(() => items.ToList());
        var collections = new Mock<ICollectionManager>();
        collections.Setup(c => c.GetCollectionsFolder(true)).ReturnsAsync(new Folder { Path = "/config/data/collections/" });
        var folders = new HashSet<string>();
        var files = new Mock<MediaBrowser.Model.IO.IFileSystem>();
        files.Setup(f => f.GetValidFilename(It.IsAny<string>())).Returns((string name) => name.Replace(":", " ", StringComparison.Ordinal));
        files.Setup(f => f.DirectoryExists(It.IsAny<string>())).Returns((string path) => folders.Contains(path));
        var host = new JellyfinListHost(library.Object, Mock.Of<IPlaylistManager>(), collections.Object, files.Object);

        var destination = await host.CollectionDestinationAsync("Heist");
        Assert.Equal("/config/data/collections/Heist [boxset]", destination);
        Assert.False(host.CollectionNameTaken(destination!));

        // Its folder exists (a create in Jellyfin itself has started, or one was left behind).
        folders.Add(destination!);
        Assert.True(host.CollectionNameTaken(destination!));
        folders.Clear();

        // A collection kept there, in another case.
        items.Add(new BoxSet { Id = Guid.NewGuid(), Name = "heist", Path = "/config/data/collections/heist [boxset]" });
        Assert.True(host.CollectionNameTaken(destination!));
        items.RemoveAt(1);

        // A collection JE made (kept in the folder of the name its create ran under) that has the name now.
        items.Add(new BoxSet { Id = Guid.NewGuid(), Name = "HEIST", Path = "/config/data/collections/" + ListService.CreateName("Heist", Guid.NewGuid()) + " [boxset]" });
        Assert.True(host.CollectionNameTaken(destination!));
        Assert.False(host.CollectionNameTaken((await host.CollectionDestinationAsync("Heists"))!));
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
