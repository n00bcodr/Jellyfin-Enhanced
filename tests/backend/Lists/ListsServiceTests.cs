using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// The list operations against an in-memory Jellyfin that reproduces the real playlist add/move algorithms.
[Collection("Plugin singleton")]
public class ListsServiceTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AddingPutsLibraryMoviesInAsRealItemsAtThePositionInBothCoordinateSystems(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var inLibrary = h.Host.AddItem(tmdb: 100);
        var playlist = h.Host.AddPlaylist(owner);
        // A dangling link sits between A and B: it occupies a raw slot (jf12 position) but has no token.
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(Guid.NewGuid(), false), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);

        var missing = Movie(200);
        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(100), missing }, new PositionDto { AfterToken = E(a) }, null, K("req-1"), None));

        Assert.Equal(new[] { inLibrary.ToString("N") }, result.AddedAsItems);
        Assert.Equal(new[] { missing.Id }, result.Added);
        Assert.Empty(result.Skipped);
        Assert.Equal(new[] { a, inLibrary, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(inLibrary), P(missing.Id), E(b) }, result.View!.Order);
        Assert.Equal(new[] { E(a), E(inLibrary), P(missing.Id), E(b) }, h.Store.Load(access.ListIdN)!.Order);
        Assert.Equal(1, result.View.Rev);
        Assert.Equal(
            positional ? new[] { $"add:{FakeListHost.Short(inLibrary)}@1" } : new[] { $"add:{FakeListHost.Short(inLibrary)}@end", $"move:{FakeListHost.Short(inLibrary)}->1" },
            h.Host.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ApplyKeepsEntryOrderAcrossItemRunsAndPlaceholders(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var z = h.Host.AddItem();
        var x = h.Host.AddItem();
        var y = h.Host.AddItem(BaseItemKind.Episode);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(z, true) });
        var access = h.AccessFor(playlist, owner);
        var p1 = Movie(1);
        var p2 = Movie(2);

        var entries = new[]
        {
            new ApplyEntry(0, null, p1),
            new ApplyEntry(1, x, null),
            new ApplyEntry(2, null, p2),
            new ApplyEntry(3, y, null),
        };
        var result = Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, entries, new PositionDto { AtStart = true }, null, null, None));

        Assert.Equal(new[] { x, y, a, z }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { P(p1.Id), E(x), P(p2.Id), E(y), E(a), E(z) }, result.View!.Order);
        Assert.Equal(new[] { x.ToString("N"), y.ToString("N") }, result.AddedAsItems);
        // One Jellyfin insert for the whole run, however the entries interleave with placeholders.
        var add = $"add:{FakeListHost.Short(x)},{FakeListHost.Short(y)}";
        Assert.Equal(
            positional ? new[] { add + "@0" } : new[] { add + "@end", $"move:{FakeListHost.Short(x)}->0", $"move:{FakeListHost.Short(y)}->1" },
            h.Host.Calls);
    }

    [Fact]
    public async Task ApplyRevalidatesEveryItemForCallerAndOwner()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var admin = h.NewUser("admin", admin: true);
        var ok = h.Host.AddItem();
        var hiddenFromOwner = h.Host.AddItem();
        var hiddenFromAdmin = h.Host.AddItem();
        var series = h.Host.AddItem(BaseItemKind.Series);
        var present = h.Host.AddItem();
        h.Host.Hide(hiddenFromOwner, owner);
        h.Host.Hide(hiddenFromAdmin, admin);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(present, true));
        var access = h.AccessFor(playlist, admin);
        Assert.True(access.Permissions.CanEdit);
        Assert.False(access.Permissions.NativeCanEdit);

        var entries = new[]
        {
            new ApplyEntry(0, Guid.NewGuid(), null),
            new ApplyEntry(1, series, null),
            new ApplyEntry(2, hiddenFromOwner, null),
            new ApplyEntry(3, hiddenFromAdmin, null),
            new ApplyEntry(4, present, null),
            new ApplyEntry(5, ok, null),
            new ApplyEntry(6, ok, null),
        };
        var result = Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, entries, null, null, null, None));

        Assert.Equal(
            new[] { (0, "notFound"), (1, "unsupportedType"), (2, "notVisible"), (3, "notVisible"), (4, "alreadyInList"), (6, "alreadyInList") },
            result.Skipped.Select(s => (s.Index, s.Reason)));
        Assert.Equal(new[] { present, ok }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { ok.ToString("N") }, result.AddedAsItems);
        // A real item added on its own leaves no document behind when the list has no placeholders.
        Assert.Null(h.Store.Load(access.ListIdN));
    }

    [Fact]
    public async Task DuplicatePlaceholdersAndAFullListAreSkipped()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.AddRange(Enumerable.Range(1, ListStore.MaxPlaceholders - 1).Select(i => Movie(10000 + i)));
        h.Store.Save(doc);

        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(10001), Movie(5), Movie(5), Movie(6) }, null, null, null, None));

        Assert.Equal(new[] { (0, "duplicate"), (2, "duplicate"), (3, "listFull") }, result.Skipped.Select(s => (s.Index, s.Reason)));
        // A repeat of an earlier entry of the same request says which; one already in the list doesn't.
        Assert.Equal(new int?[] { null, 1, null }, result.Skipped.Select(s => s.SameAs));
        Assert.Single(result.Added);
        Assert.Equal(ListStore.MaxPlaceholders, h.Store.Load(access.ListIdN)!.Items.Count);
    }

    [Fact]
    public async Task TwoImportRowsWithTheSameTitleKeepTheFirstRowsSlotAndNoteAndNameTheRepeat()
    {
        // The DC guide's Deathstroke: Knights & Dragons series line and its movie line, both resolved to the movie.
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        var first = Movie(703771);
        first.Note = "Short-series release; the film expands it.";
        var repeat = Movie(703771);
        repeat.Note = "The movie.";
        var after = Movie(5);

        var result = Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, new[]
        {
            new ApplyEntry(0, null, first), new ApplyEntry(1, null, repeat), new ApplyEntry(2, null, after), new ApplyEntry(3, a, null),
        }, null, null, null, None));

        Assert.Equal(new[] { (1, "duplicate", (int?)0), (3, "alreadyInList", (int?)null) }, result.Skipped.Select(s => (s.Index, s.Reason, s.SameAs)));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Equal(new[] { E(a), P(first.Id), P(after.Id) }, doc.Order);
        Assert.Equal("Short-series release; the film expands it.", doc.Items.Single(p => p.TmdbId == 703771).Note);
    }

    [Fact]
    public async Task StaleAnchorsAndRevsAreConflictsWithAFreshView()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);

        var stale = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, new PositionDto { AfterToken = E(Guid.NewGuid()) }, null, null, None);
        Assert.Equal(new[] { E(a) }, Error(stale, 409, "stale_anchor").View!.Order);

        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, null, 0, null, None));
        var conflict = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(2) }, null, 0, null, None);
        Assert.Equal(1, Error(conflict, 409, "rev_conflict").View!.Rev);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task RetriedRequestsReplayTheFirstResultWithoutApplyingTwice()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var other = h.NewUser("other");
        var item = h.Host.AddItem(tmdb: 77);
        var playlist = h.Host.AddPlaylist(owner, shares: new ListShare(other.Id, true));
        var access = h.AccessFor(playlist, owner);

        var first = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(77), Movie(78) }, null, null, K("same-id"), None);
        var second = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(77), Movie(78) }, null, null, K("same-id"), None);

        // Durable replay (ListOperations): the first result's identity, with the list re-projected for the caller now.
        Assert.Equal(200, second.StatusCode);
        Assert.Null(second.RawJson);
        var replayed = Ok<ApplyResultDto>(second);
        Assert.Equal(Ok<ApplyResultDto>(first).Added, replayed.Added);
        Assert.Equal(Ok<ApplyResultDto>(first).AddedAsItems, replayed.AddedAsItems);
        Assert.Equal(1, replayed.View!.Rev);
        Assert.Single(h.Host.Calls);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
        Assert.Equal(1, h.Store.Load(access.ListIdN)!.Rev);
        _ = item;

        // Another user with the same request id is not replayed.
        var otherAccess = h.AccessFor(playlist, other);
        var third = await h.Service.AddPlaceholdersAsync(otherAccess, new[] { Movie(79) }, null, null, K("same-id"), None);
        Assert.Single(Ok<ApplyResultDto>(third).Added);
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Items.Count);

        // The same id for a different request (another fingerprint) is a conflict, not a replay; nothing is applied.
        var reused = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(80) }, null, null, K("same-id", "other-request"), None);
        Assert.Null(Error(reused, 409, "idempotency_conflict").View);
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Items.Count);

        // Durable: a fresh service over the same database (a restart) still replays it.
        var restarted = new ListService(h.Store, h.Access, h.Host, h.Users.Object, h.Plugin.Core.Logger, h.Resolver, h.Metadata, h.Swap, new ListOperations(h.Database));
        var afterRestart = Ok<ApplyResultDto>(await restarted.AddPlaceholdersAsync(access, new[] { Movie(77), Movie(78) }, null, null, K("same-id"), None));
        Assert.Equal(Ok<ApplyResultDto>(first).Added, afterRestart.Added);
        Assert.Single(h.Host.Calls);
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Items.Count);
    }

    [Fact]
    public async Task AReplayIsProjectedForTheCallerNowAndRefusedOnceTheyLostTheList()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(owner, shares: new ListShare(editor.Id, true));
        var access = h.AccessFor(playlist, editor);
        var first = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, null, null, K("r"), None));

        // The owner adds another entry: the replay shows the list as it is now, not the stored first view.
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(h.AccessFor(playlist, owner), new[] { Movie(2) }, null, null, null, None));
        var replay = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, null, null, K("r"), None));
        Assert.Equal(first.Added, replay.Added);
        Assert.Equal(2, replay.View!.Placeholders.Count);
        Assert.Equal(2, replay.View.Rev);

        // The share is removed: nothing privileged is replayed from storage.
        playlist.Info = playlist.Info with { Shares = Array.Empty<ListShare>() };
        Error(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, null, null, K("r"), None), 404, "not_found");
    }

    [Fact]
    public async Task PlaceholderOnlyReorderIsPersistedWithoutTouchingJellyfin()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var p1 = Movie(1);
        var p2 = Movie(2);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { p1, p2 }, new PositionDto { AfterToken = E(a) }, null, null, None));
        Assert.Equal(new[] { E(a), P(p1.Id), P(p2.Id), E(b) }, added.View!.Order);

        var view = Ok<ListViewDto>(await h.Service.ReorderAsync(access, 1, new[] { P(p2.Id), E(a), E(b), P(p1.Id) }, null, null, None));

        Assert.Equal(new[] { P(p2.Id), E(a), E(b), P(p1.Id) }, view.Order);
        Assert.Equal(2, view.Rev);
        Assert.Equal(new[] { P(p2.Id), P(p1.Id) }, view.Placeholders.Select(p => p.Token));
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("move", StringComparison.Ordinal));
        Assert.Equal(new[] { a, b }, h.Host.Resolved(playlist.Info.Id));

        var wrong = await h.Service.ReorderAsync(access, 2, new[] { E(b), E(a), P(p2.Id), P(p1.Id) }, null, null, None);
        Error(wrong, 409, "real_order_changed");
        Error(await h.Service.ReorderAsync(access, 1, view.Order!, null, null, None), 409, "rev_conflict");
    }

    [Fact]
    public async Task AnAdminMovesARealRowAsTheOwnerInTheOwnersVisibleCoordinates()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var admin = h.NewUser("admin", admin: true);
        var a = h.Host.AddItem();
        var hidden = h.Host.AddItem();
        var b = h.Host.AddItem();
        var c = h.Host.AddItem();
        h.Host.Hide(hidden, owner);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { a, hidden, b, c }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, admin);
        var placeholder = Movie(1);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { placeholder }, new PositionDto { AfterToken = E(c) }, null, null, None));

        var view = Ok<ListViewDto>(await h.Service.ReorderAsync(access, 1, new[] { E(a), E(c), P(placeholder.Id), E(hidden), E(b) }, E(c), null, None));

        // The owner can't see "hidden", so C goes to visible row 1 of [A, B, C].
        Assert.Contains($"move:{FakeListHost.Short(c)}->1", h.Host.Calls);
        Assert.Equal(new[] { a, c, hidden, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(c), P(placeholder.Id), E(hidden), E(b) }, view.Order);
        Assert.Equal(2, view.Rev);
    }

    [Fact]
    public async Task AMoveALeadingDanglingLinkWouldShiftTakesTwoMoves()
    {
        // 12.2/10.11 insert the moved row by its index among RESOLVED rows into the RAW array, so a leading dangling
        // link shifts it: no single index puts C between A and B. JE replays Jellyfin's algorithm and moves it twice.
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var c = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(Guid.NewGuid(), false));
        playlist.Raw.AddRange(new[] { a, b, c }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, owner);
        var placeholder = Movie(1);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { placeholder }, new PositionDto { AfterToken = E(b) }, null, null, None));

        var outcome = await h.Service.ReorderAsync(access, 1, new[] { E(a), E(c), E(b), P(placeholder.Id) }, E(c), null, None);

        var view = Ok<ListViewDto>(outcome);
        Assert.Equal(new[] { $"move:{FakeListHost.Short(c)}->0", $"move:{FakeListHost.Short(c)}->2" }, h.Host.Calls.Where(call => call.StartsWith("move:", StringComparison.Ordinal)));
        Assert.Equal(new[] { a, c, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(c), E(b), P(placeholder.Id) }, view.Order);
        Assert.Equal(new[] { E(a), E(c), E(b), P(placeholder.Id) }, h.Store.Load(access.ListIdN)!.Order);
    }

    [Fact]
    public async Task OnlyTheFirstCopyOfADuplicatedItemCanBeMoved()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { a, b, a }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, owner);

        Error(await h.Service.ReorderAsync(access, 0, new[] { E(a, 1), E(a, 0), E(b) }, E(a, 1), null, None), 409, "duplicate_copy");
        Assert.Empty(h.Host.Calls);

        // Moving the first copy below the second relabels the copies by their new position.
        var view = Ok<ListViewDto>(await h.Service.ReorderAsync(access, 0, new[] { E(b), E(a, 1), E(a, 0) }, E(a, 0), null, None));
        Assert.Equal(new[] { b, a, a }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(b), E(a, 0), E(a, 1) }, view.Order);
    }

    [Fact]
    public async Task ViewsReconcileAfterNativeEditsAndPersistOnlyRealChanges()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { a, b }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, owner);
        var placeholder = Movie(1);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { placeholder }, new PositionDto { AfterToken = E(a) }, null, null, None));

        var unchanged = await h.Service.GetViewAsync(access, None);
        Assert.Equal(1, unchanged.Rev);

        playlist.Raw.RemoveAt(0); // A removed in Jellyfin
        var view = await h.Service.GetViewAsync(access, None);
        Assert.Equal(new[] { P(placeholder.Id), E(b) }, view.Order);
        Assert.Equal(2, view.Rev);
        Assert.Equal(2, (await h.Service.GetViewAsync(access, None)).Rev);
    }

    [Fact]
    public async Task PatchAndDeleteNeedTheCurrentRevAndLinkOnlyCustomEntries()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Clayface\",\"note\":\"TBA\"}", access.UserIdN);
        var movie = Movie(5);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { custom, movie }, null, null, null, None));

        Error(await h.Service.PatchAsync(access, custom.Id, 0, "x", null, null, None), 409, "rev_conflict");
        Error(await h.Service.PatchAsync(access, "0123456789abcdef0123456789abcdef", 1, "x", null, null, None), 404, "not_found");
        var link = Ph("{\"kind\":\"movie\",\"tmdbId\":1035259,\"title\":\"Clayface\",\"releaseDate\":\"2026-10-23\"}");
        Error(await h.Service.PatchAsync(access, movie.Id, 1, null, link, null, None), 400, "not_custom");
        Error(await h.Service.PatchAsync(access, custom.Id, 1, null, Movie(5), null, None), 409, "duplicate");

        var linked = Ok<ListViewDto>(await h.Service.PatchAsync(access, custom.Id, 1, null, link, null, None));
        var dto = linked.Placeholders.Single(p => p.Id == custom.Id);
        Assert.Equal(("movie", 1035259, "2026-10-23", "TBA"), (dto.Kind, dto.TmdbId!.Value, dto.ReleaseDate, dto.Note));
        Assert.Equal(custom.Id, Assert.Single(h.Store.FindByTmdb("movie", 1035259)).PlaceholderId);

        var cleared = Ok<ListViewDto>(await h.Service.PatchAsync(access, custom.Id, 2, string.Empty, null, null, None));
        Assert.Null(cleared.Placeholders.Single(p => p.Id == custom.Id).Note);

        Error(await h.Service.DeleteAsync(access, movie.Id, 2, null, None), 409, "rev_conflict");
        var deleted = Ok<ListViewDto>(await h.Service.DeleteAsync(access, movie.Id, 3, null, None));
        Assert.Equal(new[] { custom.Id }, deleted.Placeholders.Select(p => p.Id));
        Assert.Equal(new[] { P(custom.Id) }, deleted.Order);
        Error(await h.Service.DeleteAsync(access, movie.Id, 4, null, None), 404, "not_found");
    }

    [Fact]
    public async Task DeletingASyncAddedPlaceholderRemembersTheUserRemoval()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var placeholder = Movie(9);
        placeholder.SourceKey = "movie|9||";
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(placeholder);
        doc.Source = new ListSource { Kind = "tmdb", Url = "https://www.themoviedb.org/list/1", Owned = { ["movie|9||"] = new SourceOwnership { PhId = placeholder.Id } } };
        h.Store.Save(doc);

        Ok<ListViewDto>(await h.Service.DeleteAsync(access, placeholder.Id, 1, null, None));

        var source = h.Store.Load(access.ListIdN)!.Source!;
        Assert.Empty(source.Owned);
        Assert.True(source.UserRemovedKeys.ContainsKey("movie|9||"));
    }

    [Fact]
    public async Task CollectionsGetDistinctRealItemsAndDateSortedPlaceholders()
    {
        using var h = new ListsHarness();
        var manager = h.NewUser("manager", collections: true);
        var movie = h.Host.AddItem(tmdb: 300);
        var series = h.Host.AddItem(BaseItemKind.Series);
        var boxSet = h.Host.AddItem(BaseItemKind.BoxSet);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, manager);
        Assert.True(access.Permissions.CanEdit);

        var later = Movie(1, "2027-01-01");
        var tba = Movie(2);
        var earlier = Movie(3, "2001-05-01");
        var entries = new[]
        {
            new ApplyEntry(0, movie, null),
            new ApplyEntry(1, null, later),
            new ApplyEntry(2, series, null),
            new ApplyEntry(3, movie, null),
            new ApplyEntry(4, boxSet, null),
            new ApplyEntry(5, null, tba),
            new ApplyEntry(6, null, earlier),
        };
        var result = Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, entries, new PositionDto { AtStart = true }, null, null, None));

        Assert.Equal(new[] { $"collection:{FakeListHost.Short(movie)},{FakeListHost.Short(series)}" }, h.Host.Calls);
        Assert.Equal(new[] { (3, "alreadyInList"), (4, "unsupportedType") }, result.Skipped.Select(s => (s.Index, s.Reason)));
        Assert.Null(result.View!.Order);
        Assert.Equal(new[] { earlier.Id, later.Id, tba.Id }, result.View.Placeholders.Select(p => p.Id));

        // POST /items turns a library movie into the real item for collections too.
        h.Host.Calls.Clear();
        var other = h.Host.AddItem(tmdb: 301);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(301) }, null, null, null, None));
        Assert.Equal(new[] { other.ToString("N") }, added.AddedAsItems);
    }

    [Fact]
    public async Task RestrictedUsersOnlySeeVerifiedTitlesAndTheirOwnCustomEntries()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[1] = "PG";
        h.MovieCertifications[2] = "R";
        var admin = h.NewUser("admin", admin: true);
        var kid = h.NewUser("kid", maxRating: 10);
        var playlist = h.Host.AddPlaylist(kid);
        var kidAccess = h.AccessFor(playlist, kid);
        var adminAccess = h.AccessFor(playlist, admin);
        var allowed = Movie(1);
        var blocked = Movie(2);
        var adminsCustom = Ph("{\"kind\":\"custom\",\"title\":\"Admin note\"}", adminAccess.UserIdN);
        var kidsCustom = Ph("{\"kind\":\"custom\",\"title\":\"Kid note\"}", kidAccess.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(adminAccess, new[] { allowed, blocked, adminsCustom }, null, null, null, None));

        // The restricted caller can't add a blocked title.
        var kidAdd = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(kidAccess, new[] { Movie(2), kidsCustom }, null, null, null, None));
        Assert.Equal((0, "blocked"), (kidAdd.Skipped.Single().Index, kidAdd.Skipped.Single().Reason));

        var kidView = await h.Service.GetViewAsync(kidAccess, None);
        Assert.Equal(new[] { allowed.Id, kidsCustom.Id }, kidView.Placeholders.Select(p => p.Id));
        Assert.Equal(new[] { P(allowed.Id), P(kidsCustom.Id) }, kidView.Order);
        var adminView = await h.Service.GetViewAsync(adminAccess, None);
        Assert.Equal(4, adminView.Placeholders.Count);

        // Hidden placeholders can't be touched and keep their anchors when the kid reorders.
        Error(await h.Service.DeleteAsync(kidAccess, blocked.Id, kidView.Rev, null, None), 404, "not_found");
        var reordered = Ok<ListViewDto>(await h.Service.ReorderAsync(kidAccess, kidView.Rev, new[] { P(kidsCustom.Id), P(allowed.Id) }, null, null, None));
        Assert.Equal(new[] { P(kidsCustom.Id), P(allowed.Id) }, reordered.Order);
        Assert.Equal(new[] { P(kidsCustom.Id), P(allowed.Id), P(blocked.Id), P(adminsCustom.Id) }, h.Store.Load(kidAccess.ListIdN)!.Order);
    }

    // #936 ViewsCarrySeerrStatusPerKindOnceTheIndexIsReady: the Seerr status index is gone; a view carries the caller's
    // shared request status per title key (IListStatusSource), only while the admin switch and the caller's preference
    // show it. Released stays per placeholder.
    [Fact]
    public async Task AnExactEpisodeEntrysStatusIsThoseEpisodesNeverTheWholeSeasons()
    {
        using var h = new ListsHarness(status: true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
        var show = TitleKey.ForSeries(null, "7", null)!;
        h.Status.ByKey[ListStatusKeys.SeasonId(show, 2)] = "{\"stage\":\"downloading\"}";
        h.Status.ByKey["tv:tmdb:7:s2:e1"] = "{\"stage\":\"ready\"}";
        h.Status.ByKey["tv:tmdb:7:s2:e2"] = "{\"stage\":\"asked\"}";
        h.Status.ByKey["tv:tmdb:7:s2:e1,2"] = "{\"stage\":\"looking\"}";
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(
            access,
            new[]
            {
                Ph("{\"kind\":\"season\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":2}"),
                Ph("{\"kind\":\"episodes\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":2,\"episodes\":[{\"s\":2,\"e\":1}]}"),
                Ph("{\"kind\":\"episodes\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":2,\"episodes\":[{\"s\":2,\"e\":2}]}"),
                Ph("{\"kind\":\"episodes\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":2,\"episodes\":[{\"s\":2,\"e\":2},{\"s\":2,\"e\":1}]}"),
            },
            null,
            null,
            null,
            None));

        var view = await h.Service.GetViewAsync(access, None);

        // Two entries for different episodes of one season keep their own statuses; the season entry has the season's.
        Assert.Equal(
            new[] { "downloading", "ready", "asked", "looking" },
            view.Placeholders.Select(p => p.Status is { } status ? status.GetProperty("stage").GetString() : null));
    }

    [Fact]
    public async Task ViewsCarryTheCallersRequestStatusPerTitleKey()
    {
        using var h = new ListsHarness(status: true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
        h.Status.ByKey["movie:tmdb:1"] = "{\"stage\":\"available\"}";
        h.Status.ByKey["tv:tmdb:7"] = "{\"stage\":\"available\"}"; // the series card: Ready once any season is in
        var show = TitleKey.ForSeries(null, "7", null)!;
        h.Status.ByKey[ListStatusKeys.SeasonId(show, 2)] = "{\"stage\":\"downloading\"}";
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var placeholders = new[]
        {
            Movie(1, "2020-01-01"),
            Movie(99, "2999-01-01"),
            Ph("{\"kind\":\"series\",\"tmdbId\":7,\"title\":\"S\"}"),
            Ph("{\"kind\":\"season\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":2}"),
            Ph("{\"kind\":\"episodes\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":3,\"episodes\":[{\"s\":3,\"e\":1}]}"),
            Ph("{\"kind\":\"custom\",\"title\":\"C\"}"),
        };
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, placeholders, null, null, null, None));

        var view = await h.Service.GetViewAsync(access, None);

        Assert.True(view.StatusShown);
        // A season entry gets its season's status, never the series card's; an episodes entry its episodes' (none yet).
        Assert.Equal(
            new[] { "available", null, "available", "downloading", null, null },
            view.Placeholders.Select(p => p.Status is { } status ? status.GetProperty("stage").GetString() : null));
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:99", "tv:tmdb:7", "tv:tmdb:7", "tv:tmdb:7", null }, view.Placeholders.Select(p => p.TitleKey));
        Assert.Equal(new[] { true, false, false, false, false, false }, view.Placeholders.Select(p => p.Released));
        // One status read per view, each title key once, for the caller.
        var call = Assert.Single(h.Status.Calls);
        Assert.Equal(owner.Id, call.User);
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:99", "tv:tmdb:7" }, call.Keys);
        var seasonCall = Assert.Single(h.Status.SeasonCalls);
        Assert.Equal(new[] { ListStatusKeys.SeasonId(show, 2) }, seasonCall.Seasons);
        Assert.Equal(new[] { "tv:tmdb:7:s3:e1" }, Assert.Single(h.Status.PartCalls).Parts);

        // The caller hides status: no status read, nothing shown.
        h.Preferences.ByUser[owner.Id] = (null, false, true);
        var hidden = await h.Service.GetViewAsync(access, None);
        Assert.False(hidden.StatusShown);
        Assert.All(hidden.Placeholders, p => Assert.Null(p.Status));
        Assert.Single(h.Status.Calls);

        // The admin switch off: the same, whatever the preference.
        h.Preferences.ByUser[owner.Id] = (null, true, true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = false;
        Assert.False((await h.Service.GetViewAsync(access, None)).StatusShown);
        Assert.Single(h.Status.Calls);
        Assert.Single(h.Status.SeasonCalls);
    }

    // New in the list core: views carry what the caller may do, decided on the server from the switches, the caller's
    // rights and their request capabilities.
    [Fact]
    public async Task ViewsListOnlyTheActionsTheSwitchesRightsAndCapabilitiesAllow()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var viewer = h.NewUser("viewer");
        var playlist = h.Host.AddPlaylist(owner, openAccess: true);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(1);
        var uhd = Ph("{\"kind\":\"movie\",\"tmdbId\":2,\"title\":\"Movie 2\",\"edition\":\"4k\"}");
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":7,\"title\":\"S\",\"seasonNumber\":1}");
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"C\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie, uhd, season, custom }, null, null, null, None));

        // Authoring and swap-in on, requests off.
        var view = await h.Service.GetViewAsync(access, None);
        Assert.Equal(new[] { "edit", "reorder", "swapIn" }, view.Actions);
        Assert.All(view.Placeholders.Take(3), p => Assert.Equal(new[] { "remove", "note" }, p.Actions));
        Assert.Equal(new[] { "remove", "note", "link" }, view.Placeholders[3].Actions);
        var viewerView = await h.Service.GetViewAsync(h.AccessFor(playlist, viewer), None);
        Assert.Empty(viewerView.Actions);
        Assert.All(viewerView.Placeholders, p => Assert.Empty(p.Actions));

        // Requests on: the caller's capabilities decide which entries can be asked for (4K needs its own right).
        h.Plugin.Plugin.Configuration.ArrPhase4ListRequestsEnabled = true;
        h.Capabilities[owner.Id] = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestCapabilities { CanRequest = true, CanRequestMovies = true, CanRequestSeries = false };
        view = await h.Service.GetViewAsync(access, None);
        Assert.Equal(new[] { "edit", "reorder", "request", "swapIn" }, view.Actions);
        Assert.Equal(new[] { "request", "remove", "note" }, view.Placeholders[0].Actions);
        Assert.DoesNotContain("request", view.Placeholders[1].Actions); // 4K movie without the 4K right
        Assert.DoesNotContain("request", view.Placeholders[2].Actions); // series not allowed
        Assert.DoesNotContain("request", view.Placeholders[3].Actions); // custom entries are never asked for

        h.Plugin.Plugin.Configuration.ArrPhase4ListRequestAllEnabled = true;
        h.Capabilities[owner.Id] = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestCapabilities { CanRequest = true, CanRequestMovies = true, CanRequestSeries = true, Can4kMovies = true };
        view = await h.Service.GetViewAsync(access, None);
        Assert.Equal(new[] { "edit", "reorder", "request", "requestAll", "swapIn" }, view.Actions);
        Assert.Equal(new[] { true, true, true, false }, view.Placeholders.Select(p => p.Actions.Contains("request")));

        // Authoring and swap-in off: read-only for everyone.
        h.Plugin.Plugin.Configuration.ArrPhase4ListAuthoringEnabled = false;
        h.Plugin.Plugin.Configuration.ArrPhase4ListSwapInEnabled = false;
        view = await h.Service.GetViewAsync(access, None);
        Assert.Equal(new[] { "request", "requestAll" }, view.Actions);
        Assert.All(view.Placeholders, p => Assert.DoesNotContain("remove", p.Actions));
    }

    [Fact]
    public async Task CreatingAPlaylistAppliesEntriesAndReplaysByRequestId()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("user");
        var item = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, item, null), new ApplyEntry(1, null, Movie(5)) };

        var created = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, K("create-1"), None));
        var replay = await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, K("create-1"), None);

        Assert.Equal("DCEU", created.Name);
        Assert.Equal(new[] { item.ToString("N") }, created.Result.AddedAsItems);
        Assert.Single(created.Result.Added);
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-playlist", StringComparison.Ordinal));
        Assert.Equal(created.ListId, Ok<CreateListResultDto>(replay).ListId);
        Assert.Equal(created.Result.Added, Ok<CreateListResultDto>(replay).Result.Added);
        var listId = Guid.Parse(created.ListId);
        Assert.Equal(new[] { item }, h.Host.Resolved(listId));
        Assert.Equal(user.Id, h.Host.Lists[listId].Info.OwnerId);

        var collection = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Collection, "Set", false, Array.Empty<ApplyEntry>(), null, None));
        Assert.Equal(ListKinds.Collection, collection.ListKind);
    }

    [Fact]
    public void EditableListsMirrorJellyfinsPickerPlusAdminAndCollectionRights()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("user");
        var owner = h.NewUser("owner");
        var admin = h.NewUser("admin", admin: true);
        var manager = h.NewUser("manager", collections: true);
        var own = h.Host.AddPlaylist(user);
        var editShare = h.Host.AddPlaylist(owner, shares: new ListShare(user.Id, true));
        h.Host.AddPlaylist(owner, shares: new ListShare(user.Id, false));
        h.Host.AddPlaylist(owner, openAccess: true);
        var collection = h.Host.AddCollection("Cars");

        var mine = h.Service.GetEditableLists(user);
        Assert.Equal(new[] { own.Info.Id.ToString("N"), editShare.Info.Id.ToString("N") }, mine.Playlists.Select(p => p.Id));
        Assert.True(mine.Playlists[0].IsOwn);
        Assert.False(mine.Playlists[1].IsOwn);
        Assert.True(mine.Playlists[1].NativeCanEdit);
        Assert.Empty(mine.Collections);
        Assert.False(mine.CanManageCollections);

        var admins = h.Service.GetEditableLists(admin);
        Assert.Equal(4, admins.Playlists.Count);
        Assert.All(admins.Playlists, p => Assert.False(p.NativeCanEdit));
        Assert.Contains(admins.Playlists, p => p.OwnerName == "owner");
        Assert.Equal(collection.Info.Id.ToString("N"), Assert.Single(admins.Collections).Id);

        var managers = h.Service.GetEditableLists(manager);
        Assert.Empty(managers.Playlists);
        Assert.Single(managers.Collections);
        Assert.True(managers.CanManageCollections);
    }

    [Fact]
    public void EditableListsListAPlaylistWithoutOwnerForAdmins()
    {
        // Jellyfin can hold a playlist with an empty owner id; looking that user up throws ("Guid can't be empty").
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var admin = h.NewUser("admin", admin: true);
        h.Users.Setup(u => u.GetUserById(Guid.Empty)).Throws(new ArgumentException("Guid can't be empty", "id"));
        var ownerless = h.Host.AddPlaylist(owner, openAccess: true);
        ownerless.Info = ownerless.Info with { OwnerId = Guid.Empty };
        var owned = h.Host.AddPlaylist(owner);

        var lists = h.Service.GetEditableLists(admin);
        var listed = lists.Playlists.Single(p => p.Id == ownerless.Info.Id.ToString("N"));
        Assert.Null(listed.OwnerName);
        Assert.False(listed.IsOwn);
        Assert.Equal("owner", lists.Playlists.Single(p => p.Id == owned.Info.Id.ToString("N")).OwnerName);
    }

    [Fact]
    public void EditableListsAreInJellyfinsSortNameOrderWithOwnPlaylistsFirst()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var admin = h.NewUser("admin", admin: true);
        // SortName as Jellyfin stores it: lower case, leading "The" removed, numbers padded; a forced sort name wins.
        FakeListHost.FakeList Playlist(bool admins, string name, string? sortName)
        {
            var list = h.Host.AddPlaylist(admins ? admin : owner);
            list.Info = list.Info with { Name = name, SortName = sortName };
            return list;
        }

        FakeListHost.FakeList Collection(string name, string? sortName)
        {
            var list = h.Host.AddCollection(name);
            list.Info = list.Info with { SortName = sortName };
            return list;
        }

        var tinkerBell = Playlist(true, "Tinker Bell", "tinker bell");
        var batman = Playlist(true, "The Batman saga", "batman saga");
        var forced = Playlist(true, "Zorro", "aaa first");
        var unsorted = Playlist(true, "Cars", null);
        var others = Playlist(false, "An Arrowverse order", "arrowverse order");
        var theCars = Collection("The Cars Collection", "cars collection");
        var alien = Collection("Alien Collection", "alien collection");
        var batmanSet = Collection("Batman Collection", "batman collection");

        var lists = h.Service.GetEditableLists(admin);
        Assert.Equal(
            new[] { forced, batman, unsorted, tinkerBell, others }.Select(l => l.Info.Id.ToString("N")),
            lists.Playlists.Select(p => p.Id));
        Assert.Equal(new[] { "Zorro", "The Batman saga", "Cars", "Tinker Bell", "An Arrowverse order" }, lists.Playlists.Select(p => p.Name));
        Assert.Equal(
            new[] { alien, batmanSet, theCars }.Select(l => l.Info.Id.ToString("N")),
            lists.Collections.Select(c => c.Id));
    }

    [Fact]
    public void EditableListsSortLikeJellyfinsBinarySqliteOrder()
    {
        // Jellyfin orders by SortName, then Name, in SQLite with no collation (BINARY): punctuation between 'Z' and 'a'
        // ('[', '_') comes before letters, upper case before lower case, and an empty sort name first.
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        FakeListHost.FakeList Playlist(string name, string? sortName)
        {
            var list = h.Host.AddPlaylist(admin);
            list.Info = list.Info with { Name = name, SortName = sortName };
            return list;
        }

        FakeListHost.FakeList Collection(string name, string? sortName)
        {
            var list = h.Host.AddCollection(name);
            list.Info = list.Info with { SortName = sortName };
            return list;
        }

        var dceu = Playlist("DCEU", "dceu");
        var dcChrono = Playlist("DC_Chronological", "dc_chronological");
        var arrowverse = Playlist("Arrowverse", "arrowverse");
        var watchlist = Playlist("_Watchlist", "_watchlist");
        var kids = Playlist("[Kids] Movies", "[kids] movies");
        var lowerBatman = Playlist("batman", "batman");
        var theBatman = Playlist("The Batman", "batman");
        var dashes = Playlist("The --", string.Empty);
        var unknown = Playlist("Zebra", null);
        var apple = Collection("apple", "same");
        var zorro = Collection("Zorro", "same");
        var underscored = Collection("_Extras", "_extras");

        var lists = h.Service.GetEditableLists(admin);
        Assert.Equal(
            new[] { "The --", "[Kids] Movies", "_Watchlist", "Arrowverse", "The Batman", "batman", "DC_Chronological", "DCEU", "Zebra" },
            lists.Playlists.Select(p => p.Name));
        Assert.Equal(
            new[] { dashes, kids, watchlist, arrowverse, theBatman, lowerBatman, dcChrono, dceu, unknown }.Select(l => l.Info.Id.ToString("N")),
            lists.Playlists.Select(p => p.Id));
        Assert.Equal(
            new[] { underscored, zorro, apple }.Select(l => l.Info.Id.ToString("N")),
            lists.Collections.Select(c => c.Id));
    }

    [Fact]
    public async Task AJellyfinFailureKeepsTheDocumentConsistentWithWhatHappened()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var item = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        h.Host.BeforeAdd = (_, _, _) => throw new InvalidOperationException("boom");
        var placeholder = Movie(1);

        var outcome = await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, null, placeholder), new ApplyEntry(1, item, null) }, null, null, K("fail-1"), None);

        var error = Error(outcome, 500, "list_update_failed");
        // The real item never reached Jellyfin, so the placeholder of the same apply isn't kept either (review round 7:
        // kept alone, the retry would skip it and put the real item after it).
        Assert.Equal(new[] { E(a) }, error.View!.Order);
        Assert.Empty(h.Store.Load(access.ListIdN)?.Items ?? new List<Placeholder>());
        // Failures are not replayed: a retry runs again and applies the whole run in its order.
        h.Host.BeforeAdd = null;
        var retry = Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, null, placeholder), new ApplyEntry(1, item, null) }, null, null, K("fail-1"), None));
        Assert.Empty(retry.Skipped);
        Assert.Equal(new[] { placeholder.Id }, retry.Added);
        Assert.Equal(new[] { a, item }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), P(placeholder.Id), E(item) }, retry.View!.Order);
    }

    [Fact]
    public async Task ARestrictedCallerNeverSeesAPlaceholderAddedAfterItsParentalCheck()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[1] = "PG";
        h.MovieCertifications[2] = "R";
        h.MovieCertifications[3] = "R";
        var owner = h.NewUser("owner");
        var kid = h.NewUser("kid", maxRating: 10);
        var playlist = h.Host.AddPlaylist(owner, shares: new ListShare(kid.Id, true));
        var ownerAccess = h.AccessFor(playlist, owner);
        var kidAccess = h.AccessFor(playlist, kid);
        Assert.True(kidAccess.Permissions.CanEdit);
        var allowed = Movie(1);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(ownerAccess, new[] { allowed }, null, null, null, None));
        var rev = (await h.Service.GetViewAsync(kidAccess, None)).Rev;

        // The kid's DELETE takes its snapshot and parental check, then waits for the list lock while the owner adds an
        // R-rated title. The 409 view is built from the newer document: the new title must stay hidden.
        var rated = Movie(2);
        Task<ListOutcome> delete;
        using (await h.Store.LockAsync(kidAccess.ListIdN))
        {
            delete = h.Service.DeleteAsync(kidAccess, allowed.Id, rev, null, None);
            AddUnderHeldLock(h, kidAccess.ListIdN, rated);
        }

        var conflict = Error(await delete, 409, "rev_conflict");
        Assert.Equal(new[] { allowed.Id }, conflict.View!.Placeholders.Select(p => p.Id));
        Assert.Equal(new[] { P(allowed.Id) }, conflict.View.Order);

        // Same for the 200 view of an add without rev: the kid's own new entry is shown, the owner's racing one isn't.
        var kidsCustom = Ph("{\"kind\":\"custom\",\"title\":\"Kid note\"}", kidAccess.UserIdN);
        var racing = Movie(3);
        Task<ListOutcome> add;
        using (await h.Store.LockAsync(kidAccess.ListIdN))
        {
            add = h.Service.AddPlaceholdersAsync(kidAccess, new[] { kidsCustom }, null, null, null, None);
            AddUnderHeldLock(h, kidAccess.ListIdN, racing);
        }

        var added = Ok<ApplyResultDto>(await add);
        Assert.Equal(new[] { allowed.Id, kidsCustom.Id }, added.View!.Placeholders.Select(p => p.Id));
        Assert.Equal(new[] { P(allowed.Id), P(kidsCustom.Id) }, added.View.Order);

        // Placeholders the kid's check never covered can't be edited through a stale snapshot either.
        var fresh = await h.Service.GetViewAsync(kidAccess, None);
        Assert.Equal(new[] { allowed.Id, kidsCustom.Id }, fresh.Placeholders.Select(p => p.Id));
        Error(await h.Service.PatchAsync(kidAccess, racing.Id, fresh.Rev, "x", null, null, None), 404, "not_found");
        Assert.Equal(4, (await h.Service.GetViewAsync(ownerAccess, None)).Placeholders.Count);
    }

    [Fact]
    public async Task ARestrictedCallerNeverSeesItsCustomEntryOnceAnotherEditorLinkedItToABlockedTitle()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[1] = "PG";
        h.MovieCertifications[2] = "R";
        var admin = h.NewUser("admin", admin: true);
        var kid = h.NewUser("kid", maxRating: 10);
        var playlist = h.Host.AddPlaylist(kid);
        var kidAccess = h.AccessFor(playlist, kid);
        var adminAccess = h.AccessFor(playlist, admin);
        var allowed = Movie(1);
        var kidsCustom = Ph("{\"kind\":\"custom\",\"title\":\"Kid note\"}", kidAccess.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(kidAccess, new[] { allowed, kidsCustom }, null, null, null, None));
        var rev = (await h.Service.GetViewAsync(kidAccess, None)).Rev;

        // The kid's POST /items checks visibility (custom entry: its own, visible), then waits for the lock while the
        // admin links that entry to an R-rated title. The 200 view must not carry the linked title.
        var second = Ph("{\"kind\":\"custom\",\"title\":\"Kid second\"}", kidAccess.UserIdN);
        Task<ListOutcome> add;
        using (await h.Store.LockAsync(kidAccess.ListIdN))
        {
            add = h.Service.AddPlaceholdersAsync(kidAccess, new[] { second }, null, null, null, None);
            LinkUnderHeldLock(h, kidAccess.ListIdN, kidsCustom.Id, 2);
        }

        var added = Ok<ApplyResultDto>(await add);
        Assert.Equal(new[] { allowed.Id, second.Id }, added.View!.Placeholders.Select(p => p.Id));
        Assert.Equal(new[] { P(allowed.Id), P(second.Id) }, added.View.Order);

        // Same for a 409 view (stale rev) and for edits through the stale snapshot.
        using (await h.Store.LockAsync(kidAccess.ListIdN))
        {
            var reset = h.Store.LoadForUpdate(kidAccess.ListIdN, ListKinds.Playlist);
            var entry = reset.Items.Single(p => p.Id == kidsCustom.Id);
            (entry.Kind, entry.TmdbId) = (PlaceholderKinds.Custom, null);
            h.Store.Save(reset);
        }

        var current = await h.Service.GetViewAsync(kidAccess, None);
        Assert.Contains(kidsCustom.Id, current.Placeholders.Select(p => p.Id));
        Task<ListOutcome> delete;
        Task<ListOutcome> patch;
        using (await h.Store.LockAsync(kidAccess.ListIdN))
        {
            delete = h.Service.DeleteAsync(kidAccess, allowed.Id, rev, null, None);
            // The link saves once (rev + 1), so this PATCH passes the rev check and reaches the visibility check.
            patch = h.Service.PatchAsync(kidAccess, kidsCustom.Id, current.Rev + 1, "x", null, null, None);
            LinkUnderHeldLock(h, kidAccess.ListIdN, kidsCustom.Id, 2);
        }

        var conflict = Error(await delete, 409, "rev_conflict");
        Assert.Equal(new[] { allowed.Id, second.Id }, conflict.View!.Placeholders.Select(p => p.Id));
        Assert.DoesNotContain(P(kidsCustom.Id), conflict.View.Order!);
        Error(await patch, 404, "not_found");

        // A fresh view agrees (the real parental check hides it); the admin still sees it.
        Assert.DoesNotContain(kidsCustom.Id, (await h.Service.GetViewAsync(kidAccess, None)).Placeholders.Select(p => p.Id));
        Assert.Contains(kidsCustom.Id, (await h.Service.GetViewAsync(adminAccess, None)).Placeholders.Select(p => p.Id));
    }

    [Fact]
    public async Task LinkingACustomEntryKeepsItInTheRestrictedEditorsOwnView()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[1] = "PG";
        var kid = h.NewUser("kid", maxRating: 10);
        var playlist = h.Host.AddPlaylist(kid);
        var access = h.AccessFor(playlist, kid);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Movie 1\"}", access.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { custom }, null, null, null, None));
        var rev = (await h.Service.GetViewAsync(access, None)).Rev;

        var view = Ok<ListViewDto>(await h.Service.PatchAsync(access, custom.Id, rev, null, Movie(1), null, None));

        var linked = Assert.Single(view.Placeholders);
        Assert.Equal((custom.Id, 1), (linked.Id, linked.TmdbId));
        Assert.Equal(new[] { P(custom.Id) }, view.Order);
    }

    [Fact]
    public async Task CreatingAListReportsAFailedApplyAndARetryReusesTheList()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("user");
        var item = h.Host.AddItem();
        var placeholder = Movie(5);
        var entries = new[] { new ApplyEntry(0, item, null), new ApplyEntry(1, null, placeholder) };
        h.Host.BeforeAdd = (_, _, _) => throw new InvalidOperationException("disk full");

        var failed = Error(await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, K("create-f"), None), 500, "list_update_failed");
        Assert.Equal(ListKinds.Playlist, failed.ListKind);
        var listId = Guid.Parse(failed.ListId!);
        // Nothing landed: the placeholder of the failed apply isn't kept (review round 7).
        Assert.Empty(failed.View!.Order!);
        Assert.Empty(h.Host.Resolved(listId));

        // Not replayed as a success: the retry re-applies to the SAME list, in the request's order.
        h.Host.BeforeAdd = null;
        var retry = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, K("create-f"), None));
        Assert.Equal(failed.ListId, retry.ListId);
        Assert.Equal(new[] { item.ToString("N") }, retry.Result.AddedAsItems);
        Assert.Equal(new[] { placeholder.Id }, retry.Result.Added);
        Assert.Empty(retry.Result.Skipped);
        Assert.Equal(new[] { E(item), P(placeholder.Id) }, retry.Result.View!.Order);
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-playlist", StringComparison.Ordinal));
        Assert.Equal(new[] { item }, h.Host.Resolved(listId));

        // An apply that throws (request aborted after the list was created) is retried against the same list too.
        using var cts = new CancellationTokenSource();
        h.Host.AfterCreate = _ => cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => h.Service.CreateListAsync(user, ListKinds.Playlist, "Aborted", false, entries, K("create-a"), cts.Token));
        h.Host.AfterCreate = null;
        var resumed = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Playlist, "Aborted", false, entries, K("create-a"), None));
        Assert.Equal(2, h.Host.Calls.Count(c => c.StartsWith("create-playlist", StringComparison.Ordinal)));
        Assert.Equal(new[] { item }, h.Host.Resolved(Guid.Parse(resumed.ListId)));
        Assert.Single(resumed.Result.Added);
    }

    // #936 DuringASeerrOutageViewsDontWaitForStatusRetries: status now comes from the shared status service; when it
    // fails, the view still answers at once, without statuses.
    [Fact]
    public async Task WhenTheStatusSourceFailsViewsStillAnswerWithoutStatus()
    {
        using var h = new ListsHarness(status: true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
        h.Status.Fail = new HttpRequestException("connect timeout");
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, null, null, null, None));

        var watch = System.Diagnostics.Stopwatch.StartNew();
        var second = await h.Service.GetViewAsync(access, None);
        var third = await h.Service.GetViewAsync(access, None);
        Assert.True(watch.ElapsedMilliseconds < 1000, $"views waited {watch.ElapsedMilliseconds} ms");
        Assert.Null(second.Placeholders.Single().Status);
        Assert.Null(third.Placeholders.Single().Status);
        Assert.Equal(2, h.Status.Calls.Count(c => c.User == owner.Id));
    }

    private static void AddUnderHeldLock(ListsHarness h, string listIdN, Placeholder placeholder)
    {
        var doc = h.Store.LoadForUpdate(listIdN, ListKinds.Playlist);
        doc.Items.Add(placeholder);
        doc.Order.Add(P(placeholder.Id));
        h.Store.Save(doc);
    }

    // What PatchAsync's link path does to a custom entry (same id and author, new TMDB title), done by another editor.
    private static void LinkUnderHeldLock(ListsHarness h, string listIdN, string placeholderId, int tmdbId)
    {
        var doc = h.Store.LoadForUpdate(listIdN, ListKinds.Playlist);
        var placeholder = doc.Items.Single(p => p.Id == placeholderId);
        placeholder.Kind = PlaceholderKinds.Movie;
        placeholder.MediaType = "movie";
        placeholder.TmdbId = tmdbId;
        placeholder.Title = "Rated";
        h.Store.Save(doc);
    }
}
