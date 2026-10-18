using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Controller.Playlists;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsNameConsistencyTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string NativeName = "The person's name";

    public static IEnumerable<object[]> Mutations()
    {
        foreach (var kind in new[] { ListKinds.Playlist, ListKinds.Collection })
        foreach (var mutation in new[] { "retry", "add", "remove", "patch", "swap", "maintenance" })
        foreach (var shared in new[] { false, true })
            yield return new object[] { kind, mutation, shared };
        foreach (var shared in new[] { false, true })
            yield return new object[] { ListKinds.Playlist, "move", shared };
    }

    // ItemUpdateController renames the shared cached instance; PlaylistManager.UpdatePlaylist materialises through
    // GetItemList instead. Also defend collections against detached saves, without claiming their metadata API does it.
    [Theory]
    [MemberData(nameof(Mutations))]
    public async Task FailedFinishThenNativeRenamePreservesNameAndEveryMutationProgresses(string kind, string mutation, bool shared)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner", collections: true);
        h.Host.FailFinishesAfterRename = 1;
        var first = h.Host.AddItem();
        var second = h.Host.AddItem();
        var extra = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, first, null) };
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(owner, kind, "JE name", false, entries, K("create"), None));
        var list = Assert.Single(h.Host.Lists.Values);
        Assert.Equal("JE name", list.Info.Name);
        Assert.NotEqual("JE name", list.SavedName);
        list.SavedName = NativeName;
        if (shared) list.Info = list.Info with { Name = NativeName };
        var access = h.AccessFor(list, owner);
        list.Raw.AddRange(new[] { new RawEntry(first, true), new RawEntry(second, true) });
        var placeholder = Ph("{\"kind\":\"movie\",\"tmdbId\":9099,\"title\":\"Later\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, kind);
        doc.Items.Add(placeholder);
        if (kind == ListKinds.Playlist)
            doc.Order = new() { E(first), E(second), P(placeholder.Id) };
        h.Store.Save(doc);
        await h.Consent(access);
        var arrived = h.Host.AddItem(tmdb: 9099);
        var before = list.Raw.ToArray();

        async Task<ListOutcome?> Mutate()
        {
            var rev = h.Store.Load(access.ListIdN)!.Rev;
            switch (mutation)
            {
                case "retry": return await h.Service.CreateListAsync(owner, kind, "JE name", false, entries, K("create"), None);
                case "add": return await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, extra, null) }, null, null, null, None);
                case "remove": return await h.Service.DeleteAsync(access, placeholder.Id, rev, null, None);
                case "patch": return await h.Service.PatchAsync(access, placeholder.Id, rev, "Changed", null, null, None);
                case "move": return await h.Service.ReorderAsync(access, rev, new[] { E(second), E(first), P(placeholder.Id) }, E(second), null, None);
                default:
                    await h.Swap.RunListPassAsync(access.ListIdN, null, mutation == "maintenance" ? MetadataMode.Maintenance : MetadataMode.None, None);
                    return null;
            }
        }

        var outcome = await Mutate();
        Assert.Equal(NativeName, list.SavedName);
        if (outcome != null) Assert.Equal(200, outcome.StatusCode);
        if (mutation == "add") Assert.Contains(extra, h.Host.Resolved(list.Info.Id));
        if (mutation == "move") Assert.Equal(second, h.Host.Resolved(list.Info.Id)[0]);
        if (mutation is "swap" or "maintenance") Assert.Contains(arrived, h.Host.Resolved(list.Info.Id));
        if (mutation == "remove") Assert.DoesNotContain(h.Store.Load(access.ListIdN)!.Items, p => p.Id == placeholder.Id);
        Assert.Equal(NativeName, list.SavedName);
        Assert.Single(h.Host.Lists);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedPlacementRetainsIntentUntilRetrySettlesWithoutAnotherInsert(bool swap)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner");
        var list = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        var first = h.Host.AddItem();
        var second = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(first, true), new RawEntry(second, true) });
        var placeholder = Ph("{\"kind\":\"movie\",\"tmdbId\":9099,\"title\":\"Later\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        if (swap) doc.Items.Add(placeholder);
        doc.Order = swap ? new() { E(first), P(placeholder.Id), E(second) } : new() { E(first), E(second) };
        h.Store.Save(doc);
        if (swap) await h.Consent(access);
        var arrived = h.Host.AddItem(tmdb: 9099);
        h.Host.BeforeAdd = (_, _, _) =>
        {
            var intent = Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
            Assert.Equal(E(first), intent.Anchor);
            Assert.Equal(new[] { arrived.ToString("N") }, intent.ItemIds);
            Assert.Equal(0, intent.OccurrenceCountsBefore[arrived.ToString("N")]);
            return Task.CompletedTask;
        };
        h.Host.FailMoves = 10;
        h.Host.AfterAdd = _ => list.SavedName = NativeName;
        async Task Mutate()
        {
            if (swap) await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
            else await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, arrived, null) }, new PositionDto { AfterToken = E(first) }, null, null, None);
        }
        await Mutate();
        Assert.Equal(new[] { first, second, arrived }, h.Host.Resolved(list.Info.Id));
        Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        h.Store.InvalidateAll(); // recovery reads the durable intent
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Single(h.Store.Load(access.ListIdN)!.Intents); // the second failed move cannot consume intent
        if (swap) Assert.Contains(h.Store.Load(access.ListIdN)!.Items, p => p.Id == placeholder.Id);
        h.Host.FailMoves = 0;
        await Mutate();
        Assert.Equal(new[] { first, arrived, second }, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
        Assert.Single(h.Host.Calls, c => c.StartsWith("add:", StringComparison.Ordinal));
        Assert.Equal(NativeName, list.SavedName);
    }

    [Theory]
    [InlineData("add")]
    [InlineData("move")]
    [InlineData("collection")]
    public async Task ProductionHostHealsDetachedNativeMetadataBeforeCallingTheEntryManager(string mutation)
    {
        var id = Guid.NewGuid();
        BaseItem cached = mutation == "collection" ? new BoxSet { Id = id, Name = "JE name" } : new Playlist { Id = id, Name = "JE name" };
        BaseItem stored = mutation == "collection" ? new BoxSet { Id = id, Name = NativeName } : new Playlist { Id = id, Name = NativeName };
        stored.Overview = "A person's overview";
        stored.ForcedSortName = "Their sorting";
        stored.Tags = new[] { "Their tag" };
        stored.ProviderIds = new() { ["Imdb"] = "tt1234567" };
        stored.LockedFields = new[] { MediaBrowser.Model.Entities.MetadataField.Name };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(id)).Returns(cached);
        library.Setup(l => l.RetrieveItem(id)).Returns(stored);
        var playlists = new Mock<IPlaylistManager>();
        var collections = new Mock<ICollectionManager>();
        var calls = 0;
        void Save()
        {
            Assert.Equal(NativeName, cached.Name);
            Assert.Equal(stored.Overview, cached.Overview);
            Assert.Equal(stored.ForcedSortName, cached.ForcedSortName);
            Assert.Equal(stored.Tags, cached.Tags);
            Assert.Equal(stored.ProviderIds, cached.ProviderIds);
            Assert.Equal(stored.LockedFields, cached.LockedFields);
            calls++;
        }
#if NET9_0
        playlists.Setup(p => p.AddItemToPlaylistAsync(id, It.IsAny<Guid[]>(), It.IsAny<Guid>())).Callback(Save).Returns(Task.CompletedTask);
#else
        playlists.Setup(p => p.AddItemToPlaylistAsync(id, It.IsAny<Guid[]>(), It.IsAny<int?>(), It.IsAny<Guid>())).Callback(Save).Returns(Task.CompletedTask);
#endif
        playlists.Setup(p => p.MoveItemAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<int>(), It.IsAny<Guid>())).Callback(Save).Returns(Task.CompletedTask);
        collections.Setup(c => c.AddToCollectionAsync(id, It.IsAny<Guid[]>())).Callback(Save).Returns(Task.CompletedTask);
        var host = new JellyfinListHost(library.Object, playlists.Object, collections.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        var item = Guid.NewGuid();
        var kind = mutation == "collection" ? ListWriteKind.CollectionAdd : mutation == "move" ? ListWriteKind.Move : ListWriteKind.Insert;
        var write = new ListWrite(id, Guid.NewGuid(), kind);
        await (mutation == "collection" ? host.AddToCollectionAsync(write, new[] { item })
            : mutation == "move" ? host.MoveInPlaylistAsync(write, item, 0) : host.AddToPlaylistAsync(write, new[] { item }, null));
        Assert.Equal(1, calls);
        library.Verify(l => l.RegisterItem(It.IsAny<BaseItem>()), Times.Never);
    }

    [Fact]
    public void MembershipGrantsReadDurableNativePlaylistPermissionsBeforeHealingTheCachedItem()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var formerEditor = Guid.NewGuid();
        var cached = new Playlist { Id = id, Name = "Old", SortName = "Old", OwnerUserId = owner,
            Shares = new[] { new PlaylistUserPermissions(formerEditor, true) } };
        var stored = new Playlist { Id = id, Name = NativeName, SortName = "Native", OwnerUserId = owner,
            Shares = Array.Empty<PlaylistUserPermissions>() };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(id)).Returns(cached);
        library.Setup(l => l.RetrieveItem(id)).Returns(stored);
        var host = new JellyfinListHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<ICollectionManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        var current = host.GetList(id)!;
        Assert.Empty(current.Shares);
        Assert.Equal(NativeName, current.Name);
        Assert.Single(cached.Shares); // projecting access does not publish or change the cached entity
    }

    [Theory]
    [InlineData(ListKinds.Playlist, true)]
    [InlineData(ListKinds.Playlist, false)]
    [InlineData(ListKinds.Collection, true)]
    [InlineData(ListKinds.Collection, false)]
    public async Task FinishCreateWritesTheChosenNameOnlyWhileTheDurableOperationMarkerRemains(string kind, bool marked)
    {
        var id = Guid.NewGuid();
        var marker = Guid.NewGuid();
        var markedName = ListService.CreateName("JE name", marker);
        BaseItem cached = kind == ListKinds.Collection ? new BoxSet { Id = id, Name = markedName } : new Playlist { Id = id, Name = markedName };
        cached.Path = "/config/data/" + markedName;
        BaseItem stored = kind == ListKinds.Collection ? new BoxSet { Id = id, Name = marked ? markedName : NativeName } : new Playlist { Id = id, Name = marked ? markedName : NativeName };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(id)).Returns(cached);
        library.Setup(l => l.RetrieveItem(id)).Returns(stored);
        var playlists = new Mock<IPlaylistManager>();
        var host = new JellyfinListHost(library.Object, playlists.Object, Mock.Of<ICollectionManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        await host.FinishCreateAsync(new ListWrite(id, Guid.NewGuid(), ListWriteKind.FinishCreate), "JE name");
        playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), kind == ListKinds.Playlist && marked ? Times.Once() : Times.Never());
        library.Verify(l => l.UpdateItemAsync(It.IsAny<BaseItem>(), It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>()), kind == ListKinds.Collection && marked ? Times.Once() : Times.Never());
        Assert.Equal(marked ? markedName : NativeName, stored.Name);
    }
}
