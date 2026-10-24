using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 6 (4c1-r6-security-1..3), the three findings as reported; ListsContinuationTests injects the same changes
// at every await of every create and swap path.
[Collection("Plugin singleton")]
public class ListsRound6Tests
{
    [Theory]
    [InlineData(ListKinds.Playlist, false)]
    [InlineData(ListKinds.Collection, false)]
    [InlineData(ListKinds.Playlist, true)]
    [InlineData(ListKinds.Collection, true)]
    public async Task ARevokeDuringTheInsertNeverIdentifiesTheCreatedList(string kind, bool recovery)
    {
        using var h = new ListsHarness();
        var user = h.NewUser("creator", collections: true);
        var entries = new[] { new ApplyEntry(0, h.Host.AddItem(), null) };
        if (recovery)
        {
            h.Host.FailFinishes = 1;
            await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(user, kind, "Mine", false, entries, K("create"), default));
        }
        void Revoke(Guid id) => h.Host.ListHiddenFrom[user.Id] = new HashSet<Guid> { id };
        h.Host.AfterAdd = Revoke;
        h.Host.AfterCollectionAdd = Revoke;
        var answer = await h.Service.CreateListAsync(user, kind, "Mine", false, entries, K("create"), default);
        var error = Error(answer, 404, "not_found");
        Assert.Null(error.ListId);
        Assert.Null(error.ListKind);
        Assert.DoesNotContain("Mine", JsonSerializer.Serialize(answer));
    }

    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ADeletedUnclaimedCreateCannotMakeOrAdoptAnotherList(string kind)
    {
        using var h = new ListsHarness();
        var user = h.NewUser("creator", collections: true);
        h.Host.AfterCreate = _ => throw new IOException("crash before claim");
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(user, kind, "Mine", false, Array.Empty<ApplyEntry>(), K("create"), default));
        h.Host.AfterCreate = null;
        var made = Assert.Single(h.Host.Lists.Values);
        var library = new Mock<ILibraryManager>();
        using var lifecycle = new ListLifecycle(library.Object, h.Store, h.Host, h.Plugin.Core.Logger, operations: h.Operations);
        await lifecycle.StartAsync(default);
        MediaBrowser.Controller.Entities.BaseItem removed = kind == ListKinds.Playlist
            ? new MediaBrowser.Controller.Playlists.Playlist() : new MediaBrowser.Controller.Entities.Movies.BoxSet();
        removed.Id = made.Info.Id;
        removed.Path = made.Path;
        h.Host.Lists.Remove(made.Info.Id);
        h.TrackRemovedListCleanup(made.Info.Id);
        library.Raise(l => l.ItemRemoved += null, library.Object, new ItemChangeEventArgs { Item = removed });
        var until = DateTime.UtcNow + TimeSpan.FromSeconds(2);
        while (DateTime.UtcNow < until)
        {
            var op = h.Operations.Begin(user.Id, "create-" + kind, "create", "create", "fp", DateTimeOffset.UtcNow).Operation!;
            if (op.State == "deleted") break;
            await Task.Delay(10);
        }
        foreach (var readd in new[] { false, true })
        {
            if (readd) h.Host.Lists[made.Info.Id] = made;
            var error = Error(await h.Service.CreateListAsync(user, kind, "Mine", false, Array.Empty<ApplyEntry>(), K("create"), default), 404, "not_found");
            Assert.Null(error.ListId);
            Assert.Single(h.Host.Calls, c => c.StartsWith("create-", StringComparison.Ordinal));
        }
        await lifecycle.StopAsync(default);
    }

    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ACreateThatWasDeletedWhileNamingNeverFillsAReaddedId(string kind)
    {
        using var h = new ListsHarness();
        var user = h.NewUser("creator", collections: true);
        var entries = new[] { new ApplyEntry(0, h.Host.AddItem(), null) };
        using var lifecycle = new ListLifecycle(Mock.Of<ILibraryManager>(), h.Store, h.Host, h.Plugin.Core.Logger, operations: h.Operations);
        Task? cleanup = null;
        h.Host.OnAwait = point =>
        {
            if (point != "finish:after") return;
            var made = Assert.Single(h.Host.Lists.Values);
            h.Host.Lists.Remove(made.Info.Id);
            cleanup = lifecycle.DeleteForRemovedListAsync(made.Info.Id);
            made.Info = made.Info with { Name = "Re-added" };
            h.Host.Lists[made.Info.Id] = made;
        };
        var error = Error(await h.Service.CreateListAsync(user, kind, "Mine", false, entries, K("create"), default), 404, "not_found");
        await cleanup!.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(error.ListId);
        Assert.Empty(Assert.Single(h.Host.Lists.Values).Raw);
        Assert.Null(h.Store.Load(Assert.Single(h.Host.Lists.Keys).ToString("N")));
    }
}
