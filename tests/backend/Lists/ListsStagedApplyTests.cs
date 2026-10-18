using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsStagedApplyTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PendingPredecessorRefusesPlaceholderWithoutSavingAndRetryKeepsItsSpot(bool abandon)
    {
        using var h = new ListsHarness();
        var (list, access, a, b, c, d, p) = Pending(h);
        var q = Movie(9922);
        var before = Stored(h, access);
        Error(await h.Service.AddPlaceholdersAsync(access, new[] { q }, new PositionDto { AfterToken = P(p.Id) }, null, null, None), 409, "placement_pending");
        Assert.Equal(before, Stored(h, access));
        Assert.Equal(new[] { a, b, c, d }, h.Host.Resolved(list.Info.Id));
        // Recovery is independent of a refused apply. Settle or abandon the original plan, then retry unchanged.
        h.Host.FailMoves = 0;
        if (abandon) list.Info = list.Info with { Shares = Array.Empty<ListShare>() };
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { q }, new PositionDto { AfterToken = P(p.Id) }, null, null, None));
        var final = h.Store.Load(access.ListIdN)!;
        Assert.Equal(new[] { p.Id, q.Id }, final.Items.Select(x => x.Id));
        Assert.Equal(abandon ? new[] { E(a), E(b), E(c), P(p.Id), P(q.Id), E(d) }
            : new[] { E(a), E(c), E(b), P(p.Id), P(q.Id), E(d) }, final.Order);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MixedSegmentsAreAllValidatedBeforeAnyNativeOrDocumentWrite(bool validSegmentLast)
    {
        using var h = new ListsHarness();
        var (list, access, a, b, c, d, p) = Pending(h);
        var real = h.Host.AddItem(); var q = Movie(9923); var r = Movie(9924);
        var before = Stored(h, access);
        var hooks = new ApplyHooks
        {
            Regroup = (doc, _, _) => { doc.Reconcile = "staged-only"; return true; },
            Place = (_, _) => new Dictionary<int, EntryAnchor>
            {
                [0] = new(validSegmentLast ? E(d) : E(a), null),
                [1] = new(P(p.Id), null),
                [2] = new(validSegmentLast ? E(d) : E(a), null),
            },
        };
        Error(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, real, null), new ApplyEntry(1, null, q), new ApplyEntry(2, null, r) }, null, null, null, None, hooks), 409, "placement_pending");
        Assert.Equal(new[] { a, b, c, d }, h.Host.Resolved(list.Info.Id));
        Assert.Equal(before, Stored(h, access));
        Assert.DoesNotContain(h.Host.Calls, x => x.StartsWith("add", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task HiddenPendingAnchorHasExactlyTheAbsentAnchorResponse(bool perEntry)
    {
        using var h = new ListsHarness();
        var (list, access, _, _, c, _, _) = Pending(h);
        var editor = h.NewUser("restricted-editor");
        list.Info = list.Info with { Shares = list.Info.Shares.Concat(new[] { new ListShare(editor.Id, true) }).ToArray() };
        h.Host.Hide(c, editor);
        var viewer = h.AccessFor(list, editor);
        var before = Stored(h, access);
        Task<ListOutcome> Apply(string anchor) => h.Service.ApplyAsync(viewer, new[] { new ApplyEntry(0, null, Movie(9925)) },
            perEntry ? null : new PositionDto { AfterToken = anchor }, null, null, None,
            perEntry ? new ApplyHooks { Place = (_, _) => new Dictionary<int, EntryAnchor> { [0] = new(anchor, null) } } : null);
        var absent = await Apply(E(Guid.NewGuid()));
        var hidden = await Apply(E(c));
        Error(absent, 409, "stale_anchor");
        Error(hidden, absent.StatusCode, "stale_anchor");
        Assert.Equal(JsonSerializer.Serialize(absent.Value), JsonSerializer.Serialize(hidden.Value));
        Assert.Equal(before, Stored(h, access));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task VisiblePendingAnchorStillRefusesWithoutSaving(bool perEntry)
    {
        using var h = new ListsHarness();
        var (_, access, _, _, c, _, _) = Pending(h);
        var before = Stored(h, access);
        Error(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, null, Movie(9926)) },
            perEntry ? null : new PositionDto { AfterToken = E(c) }, null, null, None,
            perEntry ? new ApplyHooks { Place = (_, _) => new Dictionary<int, EntryAnchor> { [0] = new(E(c), null) } } : null), 409, "placement_pending");
        Assert.Equal(before, Stored(h, access));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task HiddenEffectiveRealAnchorIsStaleRegardlessOfPendingState(bool pending)
    {
        using var h = new ListsHarness();
        var (list, access, _, _, c, _, p) = Pending(h);
        var editor = h.NewUser("restricted-editor");
        list.Info = list.Info with { Shares = list.Info.Shares.Concat(new[] { new ListShare(editor.Id, true) }).ToArray() };
        h.Host.Hide(c, editor);
        if (!pending)
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Intents.Clear(); h.Store.Save(doc);
        }

        var before = Stored(h, access);
        Error(await h.Service.AddPlaceholdersAsync(h.AccessFor(list, editor), new[] { Movie(9927) }, new PositionDto { AfterToken = P(p.Id) }, null, null, None), 409, "stale_anchor");
        Assert.Equal(before, Stored(h, access));
    }

    private static string Stored(ListsHarness h, ListAccess access)
    {
        h.Store.InvalidateAll();
        return File.ReadAllText(Path.Combine(h.Store.DirectoryPath, access.ListIdN + ".json"));
    }

    private static (FakeListHost.FakeList List, ListAccess Access, Guid A, Guid B, Guid C, Guid D, Placeholder P) Pending(ListsHarness h)
    {
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner"); var actor = h.NewUser("pending-actor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(actor.Id, true));
        var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true), new RawEntry(d, true) });
        var p = Movie(9921);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order = new() { E(a), E(b), E(c), P(p.Id), E(d) };
        doc.Intents.Add(new SwapIntent { ByUserId = actor.Id.ToString("N"), ItemIds = new() { c.ToString("N") },
            Anchor = E(a), Index = 1, CreatedAt = "pending-test", NativeOrder = new() { E(a), E(b), E(c), E(d) }, StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id), OccurrenceCountsBefore = new() { [c.ToString("N")] = 0 } });
        h.Store.Save(doc);
        h.Host.FailMoves = 100; h.Host.Calls.Clear();
        return (list, access, a, b, c, d, p);
    }
}
