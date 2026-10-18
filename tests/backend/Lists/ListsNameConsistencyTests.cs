using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
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
    public async Task FailedFinishThenNativeRenamePreservesNameAndDefersEveryMutationUntilConsistent(string kind, string mutation, bool shared)
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
        if (!shared)
        {
            if (outcome != null)
            {
                Assert.Equal(409, outcome.StatusCode);
                Assert.Equal("list_name_conflict", Assert.IsType<ListErrorDto>(outcome.Value).Code);
            }
            Assert.Equal(before, list.Raw);
            var deferred = h.Store.Load(access.ListIdN)!;
            Assert.Equal("name_conflict", deferred.Reconcile);
            Assert.Contains(deferred.Items, p => p.Id == placeholder.Id && p.Note != "Changed");
            // Repeated maintenance must keep the reconciliation marker, with no entry/fill/intent loss.
            await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.Maintenance, None);
            Assert.Equal("name_conflict", h.Store.Load(access.ListIdN)!.Reconcile);
            Assert.Equal(before, list.Raw);
            // Jellyfin itself eventually materialises a current instance (e.g. restart); JE never publishes a snapshot.
            list.Info = list.Info with { Name = list.SavedName! };
            outcome = await Mutate();
        }
        if (outcome != null) Assert.Equal(200, outcome.StatusCode);
        if (mutation == "add") Assert.Contains(extra, h.Host.Resolved(list.Info.Id));
        if (mutation == "move") Assert.Equal(second, h.Host.Resolved(list.Info.Id)[0]);
        if (mutation is "swap" or "maintenance") Assert.Contains(arrived, h.Host.Resolved(list.Info.Id));
        if (mutation == "remove") Assert.DoesNotContain(h.Store.Load(access.ListIdN)!.Items, p => p.Id == placeholder.Id);
        Assert.Equal(NativeName, list.SavedName);
        Assert.Single(h.Host.Lists);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ANameChangedAfterInsertionDefersPlacementWithoutLosingTheLandedEntry(bool swap, bool healsDuringCheck)
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
        doc.Items.Add(placeholder);
        doc.Order = new() { E(first), P(placeholder.Id), E(second) };
        h.Store.Save(doc);
        await h.Consent(access);
        var arrived = h.Host.AddItem(tmdb: 9099);
        h.Host.AfterAdd = _ =>
        {
            list.SavedName = NativeName; // detached native rename between add and placement
            if (healsDuringCheck)
            {
                // The move reads the old cached name, then the durable read overlaps Jellyfin refreshing its cache.
                // That write is still deferred; its saved intent must survive until the next consistent pass.
                h.Host.OnStoredNameRead = _ =>
                {
                    list.Info = list.Info with { Name = NativeName };
                    h.Host.OnStoredNameRead = null;
                };
            }
        };
        if (swap)
            await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        else
        {
            var result = await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, arrived, null) }, new PositionDto { AfterToken = E(first) }, null, null, None);
            Assert.Equal(409, result.StatusCode);
        }
        Assert.Equal(NativeName, list.SavedName);
        Assert.Equal(new[] { first, second, arrived }, h.Host.Resolved(list.Info.Id));
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("move:", StringComparison.Ordinal));
        Assert.Equal("name_conflict", h.Store.Load(access.ListIdN)!.Reconcile);
        if (swap)
        {
            Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
            Assert.Contains(h.Store.Load(access.ListIdN)!.Items, p => p.Id == placeholder.Id);
            list.Info = list.Info with { Name = NativeName };
            h.Host.AfterAdd = null;
            await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
            Assert.Single(h.Host.Resolved(list.Info.Id), id => id == arrived);
            Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
            Assert.DoesNotContain(h.Store.Load(access.ListIdN)!.Items, p => p.Id == placeholder.Id);
            Assert.Equal(NativeName, list.SavedName);
        }
    }

    [Theory]
    [InlineData("add")]
    [InlineData("move")]
    [InlineData("collection")]
    public async Task ProductionHostRefusesStaleNameBeforeCallingAnyNativeEntryManager(string mutation)
    {
        var id = Guid.NewGuid();
        BaseItem cached = mutation == "collection" ? new BoxSet { Id = id, Name = "JE name" } : new Playlist { Id = id, Name = "JE name" };
        BaseItem stored = mutation == "collection" ? new BoxSet { Id = id, Name = NativeName } : new Playlist { Id = id, Name = NativeName };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(id)).Returns(cached);
        library.Setup(l => l.RetrieveItem(id)).Returns(stored);
        var playlists = new Mock<IPlaylistManager>(MockBehavior.Strict);
        var collections = new Mock<ICollectionManager>(MockBehavior.Strict);
        var host = new JellyfinListHost(library.Object, playlists.Object, collections.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        var item = Guid.NewGuid();
        var kind = mutation == "collection" ? ListWriteKind.CollectionAdd : mutation == "move" ? ListWriteKind.Move : ListWriteKind.Insert;
        var write = new ListWrite(id, Guid.NewGuid(), kind);
        var error = await Record.ExceptionAsync(() => mutation == "collection" ? host.AddToCollectionAsync(write, new[] { item })
            : mutation == "move" ? host.MoveInPlaylistAsync(write, item, 0) : host.AddToPlaylistAsync(write, new[] { item }, null));
        Assert.IsType<ListNameConflictException>(error);
        playlists.VerifyNoOtherCalls();
        collections.VerifyNoOtherCalls();
        Assert.Equal(NativeName, stored.Name);
        Assert.Equal("JE name", cached.Name);
        library.Verify(l => l.RegisterItem(It.IsAny<BaseItem>()), Times.Never);
    }
}
