using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// The list operations against an in-memory Jellyfin that reproduces the real playlist add/move algorithms.
[Collection("Plugin singleton")]
public class ListPlaceholdersServiceTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AddingPutsLibraryMoviesInAsRealItemsAtThePositionInBothCoordinateSystems(bool positional)
    {
        using var h = new ListPlaceholdersHarness();
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
        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(100), missing }, new PositionDto { AfterToken = E(a) }, null, "req-1", None));

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
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.AddRange(Enumerable.Range(1, ListPlaceholderStore.MaxPlaceholders - 1).Select(i => Movie(10000 + i)));
        h.Store.Save(doc);

        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(10001), Movie(5), Movie(5), Movie(6) }, null, null, null, None));

        Assert.Equal(new[] { (0, "duplicate"), (2, "duplicate"), (3, "listFull") }, result.Skipped.Select(s => (s.Index, s.Reason)));
        Assert.Single(result.Added);
        Assert.Equal(ListPlaceholderStore.MaxPlaceholders, h.Store.Load(access.ListIdN)!.Items.Count);
    }

    [Fact]
    public async Task StaleAnchorsAndRevsAreConflictsWithAFreshView()
    {
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
        var owner = h.NewUser("owner");
        var other = h.NewUser("other");
        var item = h.Host.AddItem(tmdb: 77);
        var playlist = h.Host.AddPlaylist(owner, shares: new ListShare(other.Id, true));
        var access = h.AccessFor(playlist, owner);

        var first = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(77), Movie(78) }, null, null, "same-id", None);
        var second = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(77), Movie(78) }, null, null, "same-id", None);

        Assert.Equal(200, second.StatusCode);
        Assert.NotNull(second.RawJson);
        Assert.Equal(System.Text.Json.JsonSerializer.Deserialize<ApplyResultDto>(second.RawJson!)!.Added, Ok<ApplyResultDto>(first).Added);
        Assert.Single(h.Host.Calls);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
        Assert.Equal(1, h.Store.Load(access.ListIdN)!.Rev);
        _ = item;

        // Another user with the same request id is not replayed.
        var otherAccess = h.AccessFor(playlist, other);
        var third = await h.Service.AddPlaceholdersAsync(otherAccess, new[] { Movie(79) }, null, null, "same-id", None);
        Assert.Null(third.RawJson);
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Items.Count);
    }

    [Fact]
    public async Task PlaceholderOnlyReorderIsPersistedWithoutTouchingJellyfin()
    {
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
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
    public async Task JellyfinMisplacingAMoveIsReportedWithItsActualOrder()
    {
        // 12.2/10.11 insert the moved row by its index among RESOLVED rows into the RAW array, so a leading dangling
        // link shifts it. JE must notice and report the real order instead of trusting the request.
        using var h = new ListPlaceholdersHarness();
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

        var error = Error(outcome, 409, "move_mismatch");
        Assert.Equal(new[] { c, a, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(c), E(a), E(b), P(placeholder.Id) }, error.View!.Order);
        Assert.Equal(new[] { E(c), E(a), E(b), P(placeholder.Id) }, h.Store.Load(access.ListIdN)!.Order);
    }

    [Fact]
    public async Task OnlyTheFirstCopyOfADuplicatedItemCanBeMoved()
    {
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness();
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
        using var h = new ListPlaceholdersHarness(seerr: true);
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

    [Fact]
    public async Task ViewsCarrySeerrStatusPerKindOnceTheIndexIsReady()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        h.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/media"
            ? IntegrationTransport.Response("{\"results\":[{\"mediaType\":\"movie\",\"tmdbId\":1,\"status\":3},{\"mediaType\":\"tv\",\"tmdbId\":7,\"status\":4,\"seasons\":[{\"seasonNumber\":1,\"status\":5},{\"seasonNumber\":2,\"status\":2}]}]}")
            : IntegrationTransport.Response("{}", 404);
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

        Assert.True(view.SeerrEnabled);
        Assert.True(view.SeerrStatusReady);
        Assert.Equal(new int?[] { 3, 1, 4, 2, 1, null }, view.Placeholders.Select(p => p.Status));
        Assert.Equal(new[] { true, false, false, false, false, false }, view.Placeholders.Select(p => p.Released));
    }

    [Fact]
    public async Task CreatingAPlaylistAppliesEntriesAndReplaysByRequestId()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("user");
        var item = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, item, null), new ApplyEntry(1, null, Movie(5)) };

        var created = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, "create-1", None));
        var replay = await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, "create-1", None);

        Assert.Equal("DCEU", created.Name);
        Assert.Equal(new[] { item.ToString("N") }, created.Result.AddedAsItems);
        Assert.Single(created.Result.Added);
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-playlist", StringComparison.Ordinal));
        Assert.Contains(created.ListId, replay.RawJson!);
        var listId = Guid.Parse(created.ListId);
        Assert.Equal(new[] { item }, h.Host.Resolved(listId));
        Assert.Equal(user.Id, h.Host.Lists[listId].Info.OwnerId);

        var collection = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Collection, "Set", false, Array.Empty<ApplyEntry>(), null, None));
        Assert.Equal(ListKinds.Collection, collection.ListKind);
    }

    [Fact]
    public void EditableListsMirrorJellyfinsPickerPlusAdminAndCollectionRights()
    {
        using var h = new ListPlaceholdersHarness();
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
    public async Task AJellyfinFailureKeepsTheDocumentConsistentWithWhatHappened()
    {
        using var h = new ListPlaceholdersHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var item = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        h.Host.BeforeAdd = (_, _, _) => throw new InvalidOperationException("boom");
        var placeholder = Movie(1);

        var outcome = await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, null, placeholder), new ApplyEntry(1, item, null) }, null, null, "fail-1", None);

        var error = Error(outcome, 500, "list_update_failed");
        Assert.Equal(new[] { E(a), P(placeholder.Id) }, error.View!.Order);
        Assert.Equal(new[] { E(a), P(placeholder.Id) }, h.Store.Load(access.ListIdN)!.Order);
        // Failures are not replayed: a retry runs again (and now skips the existing placeholder).
        h.Host.BeforeAdd = null;
        var retry = Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, null, placeholder), new ApplyEntry(1, item, null) }, null, null, "fail-1", None));
        Assert.Equal((0, "duplicate"), (retry.Skipped.Single().Index, retry.Skipped.Single().Reason));
        Assert.Equal(new[] { a, item }, h.Host.Resolved(playlist.Info.Id));
    }

    [Fact]
    public async Task ARestrictedCallerNeverSeesAPlaceholderAddedAfterItsParentalCheck()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
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
    public async Task CreatingAListReportsAFailedApplyAndARetryReusesTheList()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("user");
        var item = h.Host.AddItem();
        var placeholder = Movie(5);
        var entries = new[] { new ApplyEntry(0, item, null), new ApplyEntry(1, null, placeholder) };
        h.Host.BeforeAdd = (_, _, _) => throw new InvalidOperationException("disk full");

        var failed = Error(await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, "create-f", None), 500, "list_update_failed");
        Assert.Equal(ListKinds.Playlist, failed.ListKind);
        var listId = Guid.Parse(failed.ListId!);
        Assert.Equal(new[] { P(placeholder.Id) }, failed.View!.Order);
        Assert.Empty(h.Host.Resolved(listId));

        // Not replayed as a success: the retry re-applies to the SAME list.
        h.Host.BeforeAdd = null;
        var retry = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Playlist, "DCEU", false, entries, "create-f", None));
        Assert.Equal(failed.ListId, retry.ListId);
        Assert.Equal(new[] { item.ToString("N") }, retry.Result.AddedAsItems);
        Assert.Equal((1, "duplicate"), (retry.Result.Skipped.Single().Index, retry.Result.Skipped.Single().Reason));
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-playlist", StringComparison.Ordinal));
        Assert.Equal(new[] { item }, h.Host.Resolved(listId));

        // An apply that throws (request aborted after the list was created) is retried against the same list too.
        using var cts = new CancellationTokenSource();
        h.Host.AfterCreate = _ => cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => h.Service.CreateListAsync(user, ListKinds.Playlist, "Aborted", false, entries, "create-a", cts.Token));
        h.Host.AfterCreate = null;
        var resumed = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Playlist, "Aborted", false, entries, "create-a", None));
        Assert.Equal(2, h.Host.Calls.Count(c => c.StartsWith("create-playlist", StringComparison.Ordinal)));
        Assert.Equal(new[] { item }, h.Host.Resolved(Guid.Parse(resumed.ListId)));
        Assert.Single(resumed.Result.Added);
    }

    [Fact]
    public async Task DuringASeerrOutageViewsDontWaitForStatusRetries()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var mediaCalls = 0;
        h.Reply = request =>
        {
            if (request.RequestUri!.AbsolutePath != "/api/v1/media")
            {
                return IntegrationTransport.Response("{}", 404);
            }

            if (Interlocked.Increment(ref mediaCalls) > 1)
            {
                Thread.Sleep(2000); // a retry would hang like a timing-out Seerr
            }

            throw new HttpRequestException("connect timeout");
        };
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(1) }, null, null, null, None));

        Assert.False((await h.Service.GetViewAsync(access, None)).SeerrStatusReady);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var second = await h.Service.GetViewAsync(access, None);
        var third = await h.Service.GetViewAsync(access, None);
        Assert.True(watch.ElapsedMilliseconds < 1000, $"views waited {watch.ElapsedMilliseconds} ms");
        Assert.False(second.SeerrStatusReady || third.SeerrStatusReady);
        Assert.Null(third.Placeholders.Single().Status);
        Assert.Equal(1, mediaCalls);
    }

    private static void AddUnderHeldLock(ListPlaceholdersHarness h, string listIdN, Placeholder placeholder)
    {
        var doc = h.Store.LoadForUpdate(listIdN, ListKinds.Playlist);
        doc.Items.Add(placeholder);
        doc.Order.Add(P(placeholder.Id));
        h.Store.Save(doc);
    }
}
