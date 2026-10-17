using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;
using O = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListOrder;

namespace JE.Tests;

// Review round 1 (track a2): MoveItemAsync coordinates with hidden/dangling rows (F2) and mutations racing a list
// deletion (F5).
[Collection("Plugin singleton")]
public class ListsReviewR1a2Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public void FindMovesReplaysJellyfinsMoveIncludingRowsTheMoverCannotSee()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var h = Guid.NewGuid();
        var c = Guid.NewGuid();
        var raw = new[] { a, b, h, c }.Select(id => new RawEntry(id, true)).ToList();
        bool Visible(Guid id) => id != h;

        // Drag A to the end: Jellyfin only appends when newIndex reaches the raw count, so the visible count (2) is wrong.
        Assert.Equal(new[] { 3 }, O.FindMoves(raw, a, new[] { E(b), E(h), E(c), E(a) }, Visible));
        Assert.Equal(new[] { b, h, c, a }, O.SimulateMove(raw, a, 3, Visible)!.Select(r => r.ItemId!.Value));
        Assert.Equal(new[] { b, h, a, c }, O.SimulateMove(raw, a, 2, Visible)!.Select(r => r.ItemId!.Value));

        // No single index puts C between B and H; a detour through the top does.
        Assert.Equal(new[] { 0 }, O.FindMoves(raw, c, new[] { E(c), E(a), E(b), E(h) }, Visible));
        Assert.Equal(new[] { 0, 2 }, O.FindMoves(raw, c, new[] { E(a), E(b), E(c), E(h) }, Visible));
        Assert.Empty(O.FindMoves(raw, c, new[] { E(a), E(b), E(h), E(c) }, Visible)!);

        // Behind two rows the mover can't see, the end is out of reach (newIndex - 1 must stay inside the visible rows).
        var hidden2 = Guid.NewGuid();
        var behind = new[] { a, h, hidden2, c }.Select(id => new RawEntry(id, true)).ToList();
        Assert.Null(O.FindMoves(behind, a, new[] { E(h), E(hidden2), E(c), E(a) }, id => id != h && id != hidden2));

        // Jellyfin throws (newIndex - 1 beyond its visible rows) or ignores a move of an item that isn't there.
        Assert.Null(O.SimulateMove(raw, a, 4, Visible));
        Assert.Null(O.SimulateMove(raw, Guid.NewGuid(), 1, Visible));
    }

    [Fact]
    public void FindMovesAccountsForDanglingLinksBeforeTheAnchor()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var c = Guid.NewGuid();
        var d = Guid.NewGuid();
        var x = Guid.NewGuid();
        var raw = new List<RawEntry> { new(a, true), new(Guid.NewGuid(), false), new(b, true), new(c, true), new(d, true), new(x, true) };

        // X after B: B is visible row 1, but the dangling link before it makes Jellyfin need newIndex 3, not 2.
        Assert.Equal(new[] { 3 }, O.FindMoves(raw, x, new[] { E(a), E(b), E(x), E(c), E(d) }, _ => true));
        Assert.Equal(new[] { a, x, b, c, d }, O.SimulateMove(raw, x, 2, _ => true)!.Where(r => r.Resolved).Select(r => r.ItemId!.Value));
    }

    [Fact]
    public void FindMovesAgreesWithAnExhaustiveReplayOfJellyfin()
    {
        // Random playlists with duplicates, dangling links and hidden rows: every order one or two moves of an item can
        // produce must be found, the plan must replay to it, and null must mean no such plan exists.
        var random = new Random(4242);
        var pool = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid()).ToArray();
        for (var round = 0; round < 400; round++)
        {
            var raw = Enumerable.Range(0, random.Next(1, 8))
                .Select(_ => random.Next(6) == 0 ? new RawEntry(Guid.NewGuid(), false) : new RawEntry(pool[random.Next(pool.Length)], true))
                .ToList();
            var hidden = pool.Where(_ => random.Next(4) == 0).ToHashSet();
            bool Visible(Guid id) => !hidden.Contains(id);
            var resolved = raw.Where(r => r.Resolved).Select(r => r.ItemId!.Value).Distinct().ToList();
            if (resolved.Count == 0)
            {
                continue;
            }

            var item = resolved[random.Next(resolved.Count)];
            var reachable = Reachable(raw, item, Visible);
            foreach (var target in reachable.Concat(new[] { Shuffle(RealIds(raw), random) }))
            {
                var tokens = O.BuildRealTokens(target);
                var plan = O.FindMoves(raw, item, tokens, Visible);
                var expectReachable = RealIds(raw).SequenceEqual(target) || reachable.Any(r => r.SequenceEqual(target));
                Assert.Equal(expectReachable, plan != null);
                if (plan == null)
                {
                    continue;
                }

                Assert.True(plan.Count <= 2);
                var replay = raw;
                foreach (var newIndex in plan)
                {
                    replay = O.SimulateMove(replay, item, newIndex, Visible)!;
                    Assert.NotNull(replay);
                }

                Assert.Equal(target, RealIds(replay));
            }
        }
    }

    [Fact]
    public async Task MovingARowPastARowTheMoverCannotSeeLandsWhereRequested()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var hidden = h.Host.AddItem();
        var c = h.Host.AddItem();
        h.Host.Hide(hidden, owner);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { a, b, hidden, c }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, owner);

        var view = Ok<ListViewDto>(await h.Service.ReorderAsync(access, 0, new[] { E(b), E(c), E(a) }, E(a), null, None));

        Assert.Contains($"move:{FakeListHost.Short(a)}->3", h.Host.Calls);
        Assert.Equal(new[] { b, hidden, c, a }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(b), E(c), E(a) }, view.Order);
    }

    [Fact]
    public async Task MovingToTheTopKeepsLeadingRowsTheMoverCannotSeeInFront()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var hidden1 = h.Host.AddItem();
        var hidden2 = h.Host.AddItem();
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var c = h.Host.AddItem();
        h.Host.Hide(hidden1, owner);
        h.Host.Hide(hidden2, owner);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { hidden1, hidden2, a, b, c }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, owner);

        var view = Ok<ListViewDto>(await h.Service.ReorderAsync(access, 0, new[] { E(c), E(a), E(b) }, E(c), null, None));

        // newIndex 0 alone would land C between the hidden rows: Jellyfin needs a second move.
        var m = FakeListHost.Short(c);
        Assert.Equal(new[] { $"move:{m}->0", $"move:{m}->1" }, h.Host.Calls);
        Assert.Equal(new[] { hidden1, hidden2, c, a, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(c), E(a), E(b) }, view.Order);
    }

    [Fact]
    public async Task AMoveJellyfinCannotMakeWithoutShiftingHiddenRowsIsRefusedBeforeChangingJellyfin()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var hidden1 = h.Host.AddItem();
        var hidden2 = h.Host.AddItem();
        var b = h.Host.AddItem();
        h.Host.Hide(hidden1, owner);
        h.Host.Hide(hidden2, owner);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { a, hidden1, hidden2, b }.Select(id => new RawEntry(id, true)));
        var access = h.AccessFor(playlist, owner);

        var outcome = await h.Service.ReorderAsync(access, 0, new[] { E(b), E(a) }, E(a), null, None);

        var error = Error(outcome, 409, "move_unsupported");
        Assert.Empty(h.Host.Calls);
        Assert.Equal(new[] { a, hidden1, hidden2, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(b) }, error.View!.Order);
    }

    [Fact]
    public async Task Jf10PlacementMovesNewItemsPastDanglingLinksBeforeTheAnchor()
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var c = h.Host.AddItem();
        var d = h.Host.AddItem();
        var inLibrary = h.Host.AddItem(tmdb: 100);
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(Guid.NewGuid(), false), new RawEntry(b, true), new RawEntry(c, true), new RawEntry(d, true) });
        var access = h.AccessFor(playlist, owner);

        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(100) }, new PositionDto { AfterToken = E(b) }, null, null, None));

        Assert.Equal(new[] { a, b, inLibrary, c, d }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(b), E(inLibrary), E(c), E(d) }, result.View!.Order);
        Assert.Equal(new[] { $"add:{FakeListHost.Short(inLibrary)}@end", $"move:{FakeListHost.Short(inLibrary)}->3" }, h.Host.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnAddRacingTheListsDeletionAnswersNotFoundAndWritesNoOrphan(bool libraryItem)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        h.Host.AddItem(tmdb: 100);
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);

        // The owner deletes the playlist after the request was authorised but before it takes the list lock.
        h.Host.Lists.Remove(playlist.Info.Id);
        h.Store.Delete(access.ListIdN);

        var outcome = await h.Service.AddPlaceholdersAsync(access, new[] { Movie(libraryItem ? 100 : 200) }, null, null, null, None);

        Error(outcome, 404, "not_found");
        Assert.Null(h.Store.Load(access.ListIdN));
        Assert.DoesNotContain(access.ListIdN, h.Store.EnumerateListIds());
        Assert.Empty(h.Host.Calls);
    }

    [Fact]
    public async Task EditsOfADeletedListAnswerNotFoundWithoutRecreatingItsDocument()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var placeholder = Movie(1);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { placeholder }, null, null, null, None));
        var rev = added.View!.Rev;

        h.Host.Lists.Remove(playlist.Info.Id);
        h.Store.Delete(access.ListIdN);

        Error(await h.Service.PatchAsync(access, placeholder.Id, rev, "note", null, null, None), 404, "not_found");
        Error(await h.Service.DeleteAsync(access, placeholder.Id, rev, null, None), 404, "not_found");
        Error(await h.Service.ReorderAsync(access, rev, new[] { P(placeholder.Id) }, null, null, None), 404, "not_found");
        Assert.Null(h.Store.Load(access.ListIdN));
    }

    private static List<Guid> RealIds(IEnumerable<RawEntry> raw) => raw.Where(r => r.Resolved).Select(r => r.ItemId!.Value).ToList();

    private static List<Guid> Shuffle(List<Guid> ids, Random random) => ids.OrderBy(_ => random.Next()).ToList();

    // Every real order one or two Jellyfin moves of the item can produce (naive replay of each index).
    private static List<List<Guid>> Reachable(List<RawEntry> raw, Guid item, Func<Guid, bool> visible)
    {
        var result = new List<List<Guid>>();
        foreach (var first in Results(raw))
        {
            result.Add(RealIds(first));
            result.AddRange(Results(first).Select(RealIds));
        }

        return result;

        IEnumerable<List<RawEntry>> Results(List<RawEntry> from)
        {
            for (var newIndex = 0; newIndex <= from.Count + 1; newIndex++)
            {
                if (O.SimulateMove(from, item, newIndex, visible) is { } moved)
                {
                    yield return moved;
                }
            }
        }
    }
}
