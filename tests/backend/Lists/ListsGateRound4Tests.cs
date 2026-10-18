using System.Collections.Concurrent;
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 4 (4c1):
// - security-1 / behaviour-1: a create cancelled while it waits for a lock releases only the locks it holds, and a person's
//   own create lock is always released, whatever happens to the destination's.
// - security-3: a create recovered after a crash is renamed only while its creator can still see and edit the list.
// - behaviour-2: a list's chosen name counts as given only once Jellyfin saved it, not when its cached item shows it.
[Collection("Plugin singleton")]
public class ListsGateRound4Tests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static ApplyEntry[] Entries(Guid item) => new[] { new ApplyEntry(0, item, null) };

    // Another person's create of the same collection waits for the destination the first one holds, and is cancelled
    // there. The first create finishes, and afterwards both people's locks and the destination's are free.
    [Fact]
    public async Task ACancelledCreateWaitingForTheDestinationReleasesNoLockItNeverHad()
    {
        using var h = new ListsHarness();
        var first = h.NewUser("first", collections: true);
        var second = h.NewUser("second", collections: true);
        var third = h.NewUser("third", collections: true);
        var x = h.Host.AddItem();
        Task<ListOutcome>? queued = null;
        var waited = false;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before" && queued == null)
            {
                using var cancel = new CancellationTokenSource();
                queued = h.Service.CreateListAsync(second, ListKinds.Collection, "Heist", false, Entries(h.Host.AddItem()), K("second-1"), cancel.Token);
                waited = !queued.IsCompleted;
                cancel.Cancel();
                ((IAsyncResult)queued).AsyncWaitHandle.WaitOne(Patience);
            }
        };

        var mine = await h.Service.CreateListAsync(first, ListKinds.Collection, "Heist", false, Entries(x), K("first-1"), None);
        h.Host.OnAwait = null;

        Assert.True(waited, "the second create didn't wait for the destination");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => queued!);
        var made = Ok<CreateListResultDto>(mine);
        Assert.Equal(new[] { x }, h.Host.Resolved(Guid.Parse(made.ListId)));
        // The first person's lock is free, and the destination admits one create at a time again.
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(first, ListKinds.Collection, "Another", false, Entries(h.Host.AddItem()), K("first-2"), None).WaitAsync(Patience));
        Error(await h.Service.CreateListAsync(third, ListKinds.Collection, "Heist", false, Entries(h.Host.AddItem()), K("third-1"), None).WaitAsync(Patience), 409, "name_taken");
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(second, ListKinds.Collection, "Theirs", false, Entries(h.Host.AddItem()), K("second-2"), None).WaitAsync(Patience));
    }

    // While the destination is held, a third create queues behind the cancelled one: it gets the destination only after the
    // first create named its list, never alongside it.
    [Fact]
    public async Task ACancelledWaiterNeverLetsTheNextWaiterInWhileTheDestinationIsHeld()
    {
        using var h = new ListsHarness();
        var first = h.NewUser("first", collections: true);
        var second = h.NewUser("second", collections: true);
        var third = h.NewUser("third", collections: true);
        Task<ListOutcome>? queued = null;
        Task<ListOutcome>? next = null;
        var inside = 0;
        var overlapped = false;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before")
            {
                overlapped |= Interlocked.Increment(ref inside) > 1;
                if (queued == null)
                {
                    using var cancel = new CancellationTokenSource();
                    queued = h.Service.CreateListAsync(second, ListKinds.Collection, "Heist", false, Entries(h.Host.AddItem()), K("second-1"), cancel.Token);
                    cancel.Cancel();
                    ((IAsyncResult)queued).AsyncWaitHandle.WaitOne(Patience);
                    next = Task.Run(() => h.Service.CreateListAsync(third, ListKinds.Collection, "Heist", false, Entries(h.Host.AddItem()), K("third-1"), None));
                    next.Wait(TimeSpan.FromMilliseconds(500));
                }
            }
            else if (where == "finish:after")
            {
                Interlocked.Decrement(ref inside);
            }
        };

        var mine = await h.Service.CreateListAsync(first, ListKinds.Collection, "Heist", false, Entries(h.Host.AddItem()), K("first-1"), None);
        var theirs = await next!.WaitAsync(Patience);
        h.Host.OnAwait = null;

        Assert.False(overlapped, "two creates of one destination ran at once");
        Ok<CreateListResultDto>(mine);
        Error(theirs, 409, "name_taken");
    }

    // A person's second create waits for their first and is cancelled: the first finishes and the person can create again.
    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ACancelledCreateWaitingForThePersonsOwnTurnLeavesItFree(string kind)
    {
        using var h = new ListsHarness();
        var person = h.NewUser("person", collections: true);
        Task<ListOutcome>? queued = null;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before" && queued == null)
            {
                using var cancel = new CancellationTokenSource();
                queued = h.Service.CreateListAsync(person, kind, "Second", false, Entries(h.Host.AddItem()), K("create-2"), cancel.Token);
                cancel.Cancel();
                ((IAsyncResult)queued).AsyncWaitHandle.WaitOne(Patience);
            }
        };

        var mine = await h.Service.CreateListAsync(person, kind, "First", false, Entries(h.Host.AddItem()), K("create-1"), None);
        h.Host.OnAwait = null;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => queued!);
        Ok<CreateListResultDto>(mine);
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(person, kind, "Third", false, Entries(h.Host.AddItem()), K("create-3"), None).WaitAsync(Patience));
    }

    // Whatever goes wrong releasing the destination (here a release the create can't make: someone else's stray release
    // filled the destination's lock), the person's own create lock is released: their next create runs.
    [Fact]
    public async Task APersonsCreateLockIsReleasedEvenWhenReleasingTheDestinationFails()
    {
        using var h = new ListsHarness();
        var person = h.NewUser("person", collections: true);
        var destinations = (ConcurrentDictionary<string, SemaphoreSlim>)typeof(ListService)
            .GetField("_destinationLocks", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(h.Service)!;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before")
            {
                h.Host.OnAwait = null;
                Assert.Single(destinations.Values).Release();
            }
        };

        try
        {
            await h.Service.CreateListAsync(person, ListKinds.Collection, "Heist", false, Entries(h.Host.AddItem()), K("create-1"), None);
        }
        catch (SemaphoreFullException)
        {
            // the destination's release failed; that is all it may do
        }

        Ok<CreateListResultDto>(await h.Service.CreateListAsync(person, ListKinds.Playlist, "Next", false, Entries(h.Host.AddItem()), K("create-2"), None).WaitAsync(Patience));
    }

    // Jellyfin's rename changes the cached item before it saves it. A save that fails after that leaves the list showing
    // its chosen name with nothing kept: the retry renames it again until the name is saved.
    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ARenameThatFailedAfterTheCachedNameChangedIsRetriedUntilItIsSaved(string kind)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner", collections: true);
        var item = h.Host.AddItem();
        h.Host.FailFinishesAfterRename = 2;

        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(owner, kind, "Watch next", false, Entries(item), K("create-1"), None));
        var made = Assert.Single(h.Host.Lists.Values);
        Assert.Equal("Watch next", made.Info.Name); // the cached item shows it
        Assert.NotEqual("Watch next", made.SavedName); // nothing kept it

        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(owner, kind, "Watch next", false, Entries(item), K("create-1"), None));
        Assert.NotEqual("Watch next", made.SavedName);
        Assert.Empty(h.Host.Resolved(made.Info.Id)); // nothing applied to a list without its name

        var retry = Ok<CreateListResultDto>(await h.Service.CreateListAsync(owner, kind, "Watch next", false, Entries(item), K("create-1"), None));

        Assert.Equal(made.Info.Id.ToString("N"), retry.ListId);
        Assert.Equal("Watch next", h.Host.Lists[made.Info.Id].SavedName);
        Assert.Equal(3, h.Host.Calls.Count(c => c.StartsWith("finish:", StringComparison.Ordinal)));
        Assert.Equal(new[] { item }, h.Host.Resolved(made.Info.Id));
        Assert.Single(h.Host.Lists);

        // Done: a replay renames nothing.
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(owner, kind, "Watch next", false, Entries(item), K("create-1"), None));
        Assert.Equal(3, h.Host.Calls.Count(c => c.StartsWith("finish:", StringComparison.Ordinal)));
    }

    // After a failed rename the person renames the list themselves: the retry leaves their name alone.
    [Fact]
    public async Task ARetryNeverRenamesAListThePersonRenamedMeanwhile()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var item = h.Host.AddItem();
        h.Host.FailFinishesAfterRename = 1;
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(owner, ListKinds.Playlist, "Watch next", false, Entries(item), K("create-1"), None));
        var made = Assert.Single(h.Host.Lists.Values);
        made.Info = made.Info with { Name = "My own name" };
        made.SavedName = "My own name";

        var retry = Ok<CreateListResultDto>(await h.Service.CreateListAsync(owner, ListKinds.Playlist, "Watch next", false, Entries(item), K("create-1"), None));

        Assert.Equal("My own name", retry.Name);
        Assert.Equal("My own name", made.SavedName);
        Assert.Equal(new[] { item }, h.Host.Resolved(made.Info.Id));
    }

    // The create died after Jellyfin made the collection, before it was recorded; then the creator lost sight of it (they
    // still manage collections). The retry finds it by its marker, but never renames it: 404, the list untouched.
    [Fact]
    public async Task ARecoveredCreateIsNeverRenamedAfterTheCreatorLostTheList()
    {
        using var h = new ListsHarness();
        var manager = h.NewUser("manager", collections: true);
        var item = h.Host.AddItem();
        h.Host.AfterCreate = _ => throw new IOException("the server stopped");
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(manager, ListKinds.Collection, "Heist", false, Entries(item), K("create-1"), None));
        h.Host.AfterCreate = null;
        var made = Assert.Single(h.Host.Lists.Values);
        var marked = made.Info.Name;
        Assert.NotEqual("Heist", marked);
        h.Host.ListHiddenFrom[manager.Id] = new HashSet<Guid> { made.Info.Id };

        Error(await h.Service.CreateListAsync(manager, ListKinds.Collection, "Heist", false, Entries(item), K("create-1"), None), 404, "not_found");

        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("finish", StringComparison.Ordinal));
        Assert.Equal(marked, made.Info.Name);
        Assert.Equal(marked, made.SavedName);
        Assert.Empty(made.Raw);
    }

    // Found along the way: the create recorded its list, its rename failed, and before the retry the list changed hands or
    // was deleted. The retry made a second list (a playlist, or a collection under the name carrying the marker), could
    // not record it and answered 409, leaving that list behind. Now it answers 404 and makes nothing; nothing is renamed.
    [Theory]
    [InlineData(ListKinds.Playlist, "handed")]
    [InlineData(ListKinds.Playlist, "deleted")]
    [InlineData(ListKinds.Collection, "deleted")]
    public async Task ARetryWhoseRecordedListIsNoLongerThePersonsMakesNothing(string kind, string change)
    {
        using var h = new ListsHarness();
        var creator = h.NewUser("creator", collections: true);
        var heir = h.NewUser("heir");
        var item = h.Host.AddItem();
        h.Host.FailFinishes = 1;
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(creator, kind, "Mine", false, Entries(item), K("create-1"), None));
        var made = Assert.Single(h.Host.Lists.Values);
        var marked = made.Info.Name;
        if (change == "handed")
        {
            made.Info = made.Info with { OwnerId = heir.Id };
        }
        else
        {
            h.Host.Lists.Remove(made.Info.Id);
        }

        Error(await h.Service.CreateListAsync(creator, kind, "Mine", false, Entries(item), K("create-1"), None), 404, "not_found");

        Assert.Equal(change == "handed" ? 1 : 0, h.Host.Lists.Count);
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-", StringComparison.Ordinal));
        Assert.Single(h.Host.Calls, c => c.StartsWith("finish:", StringComparison.Ordinal));
        Assert.Equal(marked, made.Info.Name);
        Assert.Empty(made.Raw);
    }
}
