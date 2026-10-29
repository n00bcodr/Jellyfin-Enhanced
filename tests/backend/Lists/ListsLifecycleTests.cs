using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Moq;

namespace JE.Tests;

// A8: a deleted list's document goes away (event + confirmed sweep); nothing else is touched.
public class ListsLifecycleTests
{
    private sealed class Fixture : IDisposable
    {
        public CoreFixture Core { get; } = new();
        public FakeListHost Host { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public ListStore Store { get; }
        public ListLifecycle Lifecycle { get; }

        public Fixture()
        {
            Store = new ListStore(Core.Paths.Object, Core.Logger);
            Lifecycle = new ListLifecycle(Library.Object, Store, Host, Core.Logger);
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

    // A collage marker the importer copied, left behind by a list deleted before markers went with their list (no
    // document any more): the sweep removes it once the list stays missing, so it can't stand for a list made again under
    // that id. A marker of a list that exists stays.
    [Fact]
    public async Task TheSweepRemovesACollageMarkerLeftBehindByADeletedList()
    {
        using var f = new Fixture();
        var owner = FakeListHost.MakeUser("owner");
        var kept = f.Host.AddPlaylist(owner);
        var keptId = kept.Info.Id.ToString("N");
        var goneId = Guid.NewGuid().ToString("N");
        var markers = Path.Combine(f.Store.DirectoryPath, ListStore.LegacyCollagesFolder);
        Directory.CreateDirectory(markers);
        File.WriteAllText(Path.Combine(markers, keptId + ".json"), "{}");
        File.WriteAllText(Path.Combine(markers, goneId + ".json"), "{}");

        await f.Lifecycle.CollectOrphansAsync(TimeSpan.Zero, CancellationToken.None);

        Assert.True(File.Exists(Path.Combine(markers, keptId + ".json")));
        Assert.False(File.Exists(Path.Combine(markers, goneId + ".json")));
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
        // The deletions run off the event thread. Wait for each to finish (the store raises Changed once its cache has let
        // go of the document, after the file is gone): the files alone vanish first, and Load still served the cached copy.
        var deleted = new[] { playlistDoc, collectionDoc }.ToDictionary(id => id, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        f.Store.Changed += id => { if (deleted.TryGetValue(id, out var done)) done.TrySetResult(); };

        f.Library.Raise(l => l.ItemRemoved += null, f.Library.Object, new ItemChangeEventArgs { Item = new Playlist { Id = playlistId } });
        f.Library.Raise(l => l.ItemRemoved += null, f.Library.Object, new ItemChangeEventArgs { Item = new BoxSet { Id = collectionId } });
        f.Library.Raise(l => l.ItemRemoved += null, f.Library.Object, new ItemChangeEventArgs { Item = new Movie { Id = Guid.NewGuid() } });
        // The timeout only stops a hang (a deletion that never runs) from blocking the run; it orders nothing.
        await Task.WhenAll(deleted.Values.Select(d => d.Task)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Empty(f.Store.EnumerateListIds());
        Assert.Null(f.Store.Load(playlistDoc));
        Assert.Null(f.Store.Load(collectionDoc));
        Assert.False(await f.Lifecycle.DeleteForRemovedListAsync(playlistId));

        await f.Lifecycle.StopAsync(CancellationToken.None);
        f.Library.VerifyRemove(l => l.ItemRemoved -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.AtLeastOnce);
    }
}
