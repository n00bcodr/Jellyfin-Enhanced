using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsPlacementTupleTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    public static IEnumerable<object[]> RecoveryOrders()
    {
        foreach (var positional in new[] { false, true })
        foreach (var consent in new[] { false, true })
        foreach (var order in new[] { "012", "021", "102", "120", "201", "210" })
            yield return new object[] { positional, consent, order };
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public async Task TwoInterruptedPlacementsAdvanceTheWholeSiblingTuple(bool positional, bool consent, bool nativeReorder)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        if (consent) await h.Consent(access);
        await PendingPlacement(h, access, c, E(a), consent);
        await PendingPlacement(h, access, d, null, consent);
        // Recover only C; D stays pending because its owner cannot currently move it. The gate refusal starts no save.
        h.Host.Hide(d, owner); h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, c, b, d }, h.Host.Resolved(list.Info.Id));
        var remaining = Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        Assert.Equal(h.Host.GetStoredSaveStamp(list.Info.Id), remaining.StoredSaveStamp);
        Assert.Equal(new[] { E(a), E(c), E(b), E(d) }, remaining.NativeOrder);
        if (nativeReorder)
        {
            // An away/back native edit leaves the same order but a newer stamp, so it still retires D.
            await h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id);
            await h.Host.NativeMoveAsync(list.Info.Id, c, 1, owner.Id);
        }
        h.Host.HiddenFrom.Clear(); h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        var doc = h.Store.Load(access.ListIdN)!; Assert.Empty(doc.Intents);
        Assert.Equal(nativeReorder ? new[] { a, c, b, d } : new[] { d, a, c, b }, h.Host.Resolved(list.Info.Id));
        if (nativeReorder)
        {
            Assert.Empty(h.Host.Calls);
            Assert.Equal("superseded_by_reorder", Assert.Single(doc.AbandonedPlacements).AbandonedReason);
            var view = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(access, None));
            Assert.Equal("superseded_by_reorder", Assert.Single(view.GetProperty("placements").EnumerateArray()).GetProperty("reason").GetString());
        }
        else Assert.Empty(doc.AbandonedPlacements);
    }

    [Theory]
    [MemberData(nameof(RecoveryOrders))]
    public async Task ThreePendingPlacementsRecoverInEveryOrder(bool positional, bool consent, string recoveryOrder)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem(); var e = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        if (consent) await h.Consent(access);
        var ids = new[] { c, d, e }; var anchors = new[] { E(a), null, E(b) };
        foreach (var i in recoveryOrder.Select(ch => ch - '0'))
            await PendingPlacement(h, access, ids[i], anchors[i], consent);
        // Document iteration order is the recovery order. Each successful move must advance all still-pending tuples.
        h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { d, a, c, b, e }, h.Host.Resolved(list.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!; Assert.Empty(doc.Intents); Assert.Empty(doc.AbandonedPlacements);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SuccessfulSaveWithUnexpectedStoredOrderCannotMintOrAdvanceProof(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        var doc = new ListDoc(); var sibling = new SwapIntent { StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id), NativeOrder = new() { E(a), E(b) } };
        var active = new SwapIntent(); doc.Intents.AddRange(new[] { sibling, active }); var oldStamp = sibling.StoredSaveStamp;
        h.Host.AfterAdd = _ =>
        {
            list.Raw.Clear(); list.Raw.AddRange(new[] { new RawEntry(b, true), new RawEntry(a, true), new RawEntry(c, true) }); list.Persist();
        };
        using var continuation = new ListContinuation(h.Store, () => null);
        h.Store.Awaited = site =>
        {
            if (site.StartsWith("ObserveSaveAsync:", StringComparison.Ordinal)) throw new IOException("interrupt before any corrective save");
        };
        await Assert.ThrowsAsync<IOException>(() => ListPlaylistPlacement.PlaceAsync(h.Host, h.Plugin.Core.Logger, list.Info.Id, access.ListIdN, owner, new[] { c }, E(b),
            new() { E(a), E(b), E(c) }, new[] { E(c) }, (kind, ids) => new ListWrite(list.Info.Id, owner.Id, kind),
            (before, after) => ListPlaylistPlacement.RecordSave(doc, active, before, after)));
        h.Store.Awaited = null;
        Assert.Null(active.StoredSaveStamp); Assert.Null(active.NativeOrder);
        Assert.Equal(oldStamp, sibling.StoredSaveStamp); Assert.Equal(new[] { E(a), E(b) }, sibling.NativeOrder);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SiblingMustMatchBothPreSaveComponents(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        var doc = new ListDoc(); var sibling = new SwapIntent { StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id), NativeOrder = new() { E(b), E(a) } };
        var active = new SwapIntent(); doc.Intents.AddRange(new[] { sibling, active }); var oldStamp = sibling.StoredSaveStamp;
        await ListPlaylistPlacement.PlaceAsync(h.Host, h.Plugin.Core.Logger, list.Info.Id, access.ListIdN, owner, new[] { c }, E(b),
            new() { E(a), E(b), E(c) }, new[] { E(c) }, (kind, ids) => new ListWrite(list.Info.Id, owner.Id, kind),
            (before, after) => ListPlaylistPlacement.RecordSave(doc, active, before, after));
        Assert.Equal(oldStamp, sibling.StoredSaveStamp); Assert.Equal(new[] { E(b), E(a) }, sibling.NativeOrder);
        Assert.Equal(h.Host.GetStoredSaveStamp(list.Info.Id), active.StoredSaveStamp); Assert.Equal(new[] { E(a), E(b), E(c) }, active.NativeOrder);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ApplyRecoveryPreservesTwoInterruptedPlacementPlans(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        async Task Interrupt(Guid item, PositionDto position)
        {
            using var continuation = new ListContinuation(h.Store, () => null);
            h.Store.Awaited = site =>
            {
                if (site.StartsWith("ObserveSaveAsync:", StringComparison.Ordinal)) throw new IOException("outer apply continuation interrupted");
            };
            try { Assert.Equal(500, (await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, item, null) }, position, null, null, None)).StatusCode); }
            finally { h.Store.Awaited = null; }
        }
        await Interrupt(c, new PositionDto { AfterToken = E(a) });
        h.Host.Hide(c, owner);
        await Interrupt(d, new PositionDto { AtStart = true });
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Intents.Count);
        h.Host.SupportsPositionalInsert = positional; h.Host.HiddenFrom.Clear(); h.Host.Hide(d, owner); h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, c, b, d }, h.Host.Resolved(list.Info.Id));
        h.Host.HiddenFrom.Clear(); h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { d, a, c, b }, h.Host.Resolved(list.Info.Id));
        var final = h.Store.Load(access.ListIdN)!; Assert.Empty(final.Intents); Assert.Empty(final.AbandonedPlacements);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InterruptedIntermediateMoveAdvancesTheActualDetourTuple(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var hidden = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(hidden, true) }); list.Persist();
        await PendingPlacement(h, access, c, E(b), false); await PendingPlacement(h, access, d, null, false);
        h.Host.Hide(hidden, owner); h.Host.Hide(d, owner);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist); var active = doc.Intents[0]; var sibling = doc.Intents[1];
        using (var continuation = new ListContinuation(h.Store, () => null))
        {
            h.Store.Awaited = site =>
            {
                if (site.StartsWith("ObserveSaveAsync:", StringComparison.Ordinal)) throw new IOException("interrupt after first detour save");
            };
            await Assert.ThrowsAsync<IOException>(() => ListPlaylistPlacement.MoveAfterAnchorAsync(h.Host, h.Plugin.Core.Logger,
                list.Info.Id, owner, E(b), new[] { E(c) }, (kind, ids) => new ListWrite(list.Info.Id, owner.Id, kind),
                (before, after) => ListPlaylistPlacement.RecordSave(doc, active, before, after)));
            h.Store.Awaited = null;
        }
        Assert.Equal(new[] { c, a, b, hidden, d }, h.Host.Resolved(list.Info.Id));
        Assert.Equal(new[] { E(c), E(a), E(b), E(hidden), E(d) }, active.NativeOrder);
        Assert.Equal(active.NativeOrder, sibling.NativeOrder); Assert.Equal(active.StoredSaveStamp, sibling.StoredSaveStamp);
        h.Store.Save(doc); h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, b, c, hidden, d }, h.Host.Resolved(list.Info.Id));
        h.Host.HiddenFrom.Clear(); h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { d, a, b, c, hidden }, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.AbandonedPlacements);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InterruptedPositionalCThenDAtStartSettleWithoutAnotherMove(bool consent)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = true;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        if (consent) await h.Consent(access);
        await PendingPlacement(h, access, c, E(a), consent, append: false);
        await PendingPlacement(h, access, d, null, consent, append: false);
        // A positional host already landed both requested positions. Recovery must retire both without a move.
        Assert.Equal(new[] { d, a, c, b }, h.Host.Resolved(list.Info.Id));
        h.Host.Calls.Clear(); h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { d, a, c, b }, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Host.Calls);
        var final = h.Store.Load(access.ListIdN)!; Assert.Empty(final.Intents); Assert.Empty(final.AbandonedPlacements);
    }

    // Observe acknowledged appends (or normal positional inserts for already-placed controls), then interrupt only
    // the outer continuation. The durable intent keeps the placement recovery must finish. No native failure is
    // reinterpreted as success; every proof comes from the production observer, never a fixture stamp.
    private static async Task PendingPlacement(ListsHarness h, ListAccess access, Guid item, string? anchor, bool consent, bool append = true)
    {
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        var raw = ListOrder.BuildRealTokens(h.Host.GetRawEntries(access.List.Id));
        var writeAnchor = append ? raw.LastOrDefault() : anchor;
        var desired = raw.ToList(); desired.Insert(writeAnchor == null ? 0 : raw.IndexOf(writeAnchor) + 1, E(item));
        var intent = new SwapIntent { ByUserId = consent ? null : access.User.Id.ToString("N"), ItemIds = new() { item.ToString("N") },
            Anchor = anchor, Index = anchor == null ? 0 : raw.IndexOf(anchor) + 1, CreatedAt = Guid.NewGuid().ToString("N"),
            NativeOrder = desired.ToList() };
        doc.Intents.Add(intent); doc.Order = desired; h.Store.Save(doc);
        using var continuation = new ListContinuation(h.Store, () => null);
        h.Store.Awaited = site =>
        {
            if (site.StartsWith("ObserveSaveAsync:", StringComparison.Ordinal)) throw new IOException("interrupt outer continuation after acknowledged placement");
        };
        try
        {
            await Assert.ThrowsAsync<IOException>(() => ListPlaylistPlacement.PlaceAsync(h.Host, h.Plugin.Core.Logger, access.List.Id,
                access.ListIdN, access.Owner!, new[] { item }, writeAnchor, doc.Order, new[] { E(item) },
                (kind, ids) => new ListWrite(access.List.Id, access.Owner!.Id, kind),
                (before, after) => ListPlaylistPlacement.RecordSave(doc, intent, before, after)));
        }
        finally { h.Store.Awaited = null; }
        h.Store.Save(doc);
    }
}
