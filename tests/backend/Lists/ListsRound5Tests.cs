using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsRound5Tests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ARevokeDuringRecoveredCreateValidationAnswersWithoutListIdentity(bool recoveredByMarker)
    {
        using var h = new ListsHarness(seerr: true);
        var creator = h.NewUser("creator", collections: true, maxRating: 10);
        var entries = new[] { new ApplyEntry(0, null, Movie(900)) };
        if (recoveredByMarker) h.Host.AfterCreate = _ => throw new IOException("stopped before recording");
        else h.Host.FailFinishes = 1;
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(creator, ListKinds.Collection, "Mine", false, entries, K("recover"), default));
        h.Host.AfterCreate = null;
        var made = Assert.Single(h.Host.Lists.Values);
        var pending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reading = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        h.ReplyAsync = async (_, _) =>
        {
            reading.TrySetResult();
            await pending.Task;
            return IntegrationTransport.Response("{\"id\":900,\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"PG\",\"type\":3}]}]}}");
        };

        var retry = h.Service.CreateListAsync(creator, ListKinds.Collection, "Mine", false, entries, K("recover"), default);
        await reading.Task.WaitAsync(TimeSpan.FromSeconds(10));
        h.Host.ListHiddenFrom[creator.Id] = new HashSet<Guid> { made.Info.Id };
        pending.SetResult();

        var error = Error(await retry.WaitAsync(TimeSpan.FromSeconds(10)), 404, "not_found");
        Assert.Null(error.ListId);
        Assert.Null(error.ListKind);
        Assert.Empty(made.Raw);
        Assert.Null(h.Store.Load(made.Info.Id.ToString("N")));
    }

    [Theory]
    [InlineData(ListKinds.Playlist, false)]
    [InlineData(ListKinds.Collection, false)]
    [InlineData(ListKinds.Playlist, true)]
    [InlineData(ListKinds.Collection, true)]
    public async Task DeletionCleanupKeepsACreateRetryFromRecreatingTheList(string kind, bool unfinished)
    {
        using var h = new ListsHarness();
        var creator = h.NewUser("creator", collections: true);
        var entries = new[] { new ApplyEntry(0, h.Host.AddItem(), null) };
        if (unfinished)
        {
            h.Host.FailFinishes = 1;
            await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(creator, kind, "Mine", false, entries, K("create"), default));
        }
        else Ok<CreateListResultDto>(await h.Service.CreateListAsync(creator, kind, "Mine", false, entries, K("create"), default));
        var made = Assert.Single(h.Host.Lists.Values);
        h.Host.Lists.Remove(made.Info.Id);
        using var lifecycle = new ListLifecycle(Mock.Of<ILibraryManager>(), h.Store, h.Host, h.Plugin.Core.Logger, operations: h.Operations);
        await lifecycle.DeleteForRemovedListAsync(made.Info.Id);

        for (var attempt = 0; attempt < 2; attempt++)
        {
            var error = Error(await h.Service.CreateListAsync(creator, kind, "Mine", false, entries, K("create"), default), 404, "not_found");
            Assert.Null(error.ListId);
            Assert.Null(error.ListKind);
        }

        Assert.Empty(h.Host.Lists);
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-", StringComparison.Ordinal));
        Assert.True(h.Operations.Begin(creator.Id, "create-" + kind, "create", "create", "fp", DateTimeOffset.UtcNow).Replayed);
        Error(await h.Service.CreateListAsync(creator, kind, "Mine", false, entries, K("create", "other"), default), 409, "idempotency_conflict");
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(creator, kind, "Mine", false, entries, K("new-create"), default));
    }

    [Fact]
    public void DeletedCreateOperationsExpireWithTheOrdinaryRetentionAndOtherListOperationsGo()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("creator");
        var list = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var create = h.Operations.Begin(user.Id, "create-playlist", "create", "create", "fp", now).Operation!;
        h.Operations.SetList(create.Id, list, now);
        h.Operations.Finish(create.Id, true, 200, "{}", now);
        h.Operations.Begin(user.Id, list, "apply", "apply", "fp", now);

        Assert.Equal(1, h.Operations.Purge(now, new[] { list }));
        Assert.True(h.Operations.Begin(user.Id, "create-playlist", "create", "create", "fp", now).Replayed);
        Assert.Equal(0, h.Operations.Purge(now + ListOperations.Retention - TimeSpan.FromSeconds(1), new[] { list }));
        Assert.Equal(1, h.Operations.Purge(now + ListOperations.Retention + TimeSpan.FromSeconds(1)));
        Assert.False(h.Operations.Begin(user.Id, "create-playlist", "create", "create", "fp", now + ListOperations.Retention).Replayed);
    }

    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ADeletedCreateIsNeverReplayedOntoAReusedJellyfinItemId(string kind)
    {
        using var h = new ListsHarness();
        var creator = h.NewUser("creator", collections: true);
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(creator, kind, "Mine", false, Array.Empty<ApplyEntry>(), K("create"), default));
        var made = Assert.Single(h.Host.Lists.Values);
        h.Host.Lists.Remove(made.Info.Id);
        using var lifecycle = new ListLifecycle(Mock.Of<ILibraryManager>(), h.Store, h.Host, h.Plugin.Core.Logger, operations: h.Operations);
        await lifecycle.DeleteForRemovedListAsync(made.Info.Id);
        // Jellyfin's folder scan can resurrect a collection under its old id. It is not the deleted create's list.
        made.Info = made.Info with { Name = "Re-added by Jellyfin" };
        h.Host.Lists[made.Info.Id] = made;
        var operation = h.Operations.Begin(creator.Id, "create-" + kind, "create", "create", "fp", DateTimeOffset.UtcNow).Operation!;
        // An in-flight completion/claim must not overwrite the deletion marker either.
        h.Operations.Finish(operation.Id, true, 200, "{}", DateTimeOffset.UtcNow);

        var error = Error(await h.Service.CreateListAsync(creator, kind, "Mine", false, Array.Empty<ApplyEntry>(), K("create"), default), 404, "not_found");
        Assert.Null(error.ListId);
        Assert.Null(error.ListKind);
        Assert.False(h.Operations.ClaimList(operation.Id, made.Info.Id.ToString("N"), DateTimeOffset.UtcNow));
        Assert.Equal("Re-added by Jellyfin", made.Info.Name);
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-", StringComparison.Ordinal));
    }
}
