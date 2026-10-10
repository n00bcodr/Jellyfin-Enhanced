using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Moq;

namespace JE.Tests;

// A8: a deleted list's document goes away (event + confirmed sweep); nothing else is touched.
public class ListPlaceholdersLifecycleTests
{
    private sealed class Fixture : IDisposable
    {
        public CoreFixture Core { get; } = new();
        public FakeListHost Host { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public ListPlaceholderStore Store { get; }
        public ListPlaceholderLifecycle Lifecycle { get; }

        public Fixture()
        {
            Store = new ListPlaceholderStore(Core.Paths.Object, Core.Logger);
            Lifecycle = new ListPlaceholderLifecycle(Library.Object, Store, Host, Core.Logger);
        }

        public string Doc(Guid listId, string kind = ListKinds.Playlist)
        {
            var id = listId.ToString("N");
            var doc = Store.LoadForUpdate(id, kind);
            doc.Items.Add(new Placeholder { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = 1, Title = "x" });
            Store.Save(doc);
            return id;
        }

        public void Dispose()
        {
            Lifecycle.Dispose();
            Core.Dispose();
        }
    }

    [Fact]
    public async Task TheSweepRemovesOnlyDocumentsOfListsThatStayMissing()
    {
        using var f = new Fixture();
        var owner = FakeListHost.MakeUser("owner");
        var kept = f.Host.AddPlaylist(owner);
        var keptId = f.Doc(kept.Info.Id);
        var goneId = f.Doc(Guid.NewGuid());
        var backId = Guid.NewGuid();
        var back = f.Doc(backId, ListKinds.Collection);

        // "back" is missing on the first check but exists again before the confirmation check.
        var sweep = f.Lifecycle.CollectOrphansAsync(TimeSpan.FromMilliseconds(200), CancellationToken.None);
        f.Host.Lists[backId] = new FakeListHost.FakeList { Info = new ListInfo(backId, ListKinds.Collection, "Back", Guid.Empty, false, Array.Empty<ListShare>()) };
        Assert.Equal(1, await sweep);

        Assert.Equal(new[] { keptId, back }.OrderBy(x => x), f.Store.EnumerateListIds().OrderBy(x => x));
        Assert.Null(f.Store.Load(goneId));
        Assert.Equal(0, await f.Lifecycle.CollectOrphansAsync(TimeSpan.Zero, CancellationToken.None));
    }

    [Fact]
    public async Task RemovingAPlaylistOrCollectionDeletesItsDocument()
    {
        using var f = new Fixture();
        var playlistId = Guid.NewGuid();
        var collectionId = Guid.NewGuid();
        var playlistDoc = f.Doc(playlistId);
        var collectionDoc = f.Doc(collectionId, ListKinds.Collection);
        await f.Lifecycle.StartAsync(CancellationToken.None);
        f.Library.VerifyAdd(l => l.ItemRemoved += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);

        f.Library.Raise(l => l.ItemRemoved += null, f.Library.Object, new ItemChangeEventArgs { Item = new Playlist { Id = playlistId } });
        f.Library.Raise(l => l.ItemRemoved += null, f.Library.Object, new ItemChangeEventArgs { Item = new BoxSet { Id = collectionId } });
        f.Library.Raise(l => l.ItemRemoved += null, f.Library.Object, new ItemChangeEventArgs { Item = new Movie { Id = Guid.NewGuid() } });
        for (var i = 0; i < 100 && f.Store.EnumerateListIds().Count > 0; i++)
        {
            await Task.Delay(20);
        }

        Assert.Empty(f.Store.EnumerateListIds());
        Assert.Null(f.Store.Load(playlistDoc));
        Assert.Null(f.Store.Load(collectionDoc));
        Assert.False(await f.Lifecycle.DeleteForRemovedListAsync(playlistId));

        await f.Lifecycle.StopAsync(CancellationToken.None);
        f.Library.VerifyRemove(l => l.ItemRemoved -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.AtLeastOnce);
    }
}
