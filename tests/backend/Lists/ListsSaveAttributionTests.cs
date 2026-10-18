using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsSaveAttributionTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task FailedUnrelatedInsertNeverAdvancesAnotherIntentsProof(bool positional, bool cancelled)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) }); list.Persist();
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist); doc.Order = new() { E(a), E(b), E(c) };
        var pending = new SwapIntent { ByUserId = owner.Id.ToString("N"), ItemIds = new() { c.ToString("N") }, Anchor = E(a), Index = 1,
            CreatedAt = "pending", NativeOrder = new() { E(a), E(b), E(c) }, StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id) };
        var active = new SwapIntent { ItemIds = new() { d.ToString("N") }, CreatedAt = "active" };
        doc.Intents.AddRange(new[] { pending, active }); var proof = pending.StoredSaveStamp;
        h.Host.BeforeAdd = async (_, _, _) =>
        {
            await Task.Yield();
            await h.Host.NativeMoveAsync(list.Info.Id, c, 1, owner.Id);
            await h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id);
            if (cancelled) throw new OperationCanceledException();
            throw new IOException("unrelated insert failed before saving");
        };
        await Assert.ThrowsAnyAsync<Exception>(() => ListPlaylistPlacement.PlaceAsync(h.Host, h.Plugin.Core.Logger, list.Info.Id, access.ListIdN,
            owner, new[] { d }, E(c), new() { E(a), E(b), E(c), E(d) }, new[] { E(d) },
            (kind, ids) => new ListWrite(list.Info.Id, owner.Id, kind), (before, after) => ListPlaylistPlacement.RecordSave(doc, active, before, after)));
        Assert.Equal(proof, pending.StoredSaveStamp); Assert.Null(active.StoredSaveStamp);
        doc.Intents.Remove(active); h.Store.Save(doc); h.Store.InvalidateAll(); h.Host.BeforeAdd = null; h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Host.Calls);
        await Receipt(h, access, "superseded_by_reorder");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task FailedApplyWithLandedAppendAndNativeRoundTripClearsActiveProof(bool positional, bool cancelled)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        h.Host.AfterAdd = _ =>
        {
            list.Raw.Clear(); list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) }); list.Persist();
            h.Host.NativeMoveAsync(list.Info.Id, c, 1, owner.Id).GetAwaiter().GetResult();
            h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id).GetAwaiter().GetResult();
            if (cancelled) throw new OperationCanceledException();
            throw new IOException("save landed, completion lost after native round trip");
        };
        Assert.Equal(500, (await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        Assert.Null(Assert.Single(h.Store.Load(access.ListIdN)!.Intents).StoredSaveStamp);
        h.Host.AfterAdd = null; h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Host.Calls);
        await Receipt(h, access, "placement_evidence_missing");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SuccessfulSaveStillRecordsProofAndCorrectsOnlyJeDisplacement(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        var intent = new SwapIntent { ByUserId = owner.Id.ToString("N"), ItemIds = new() { c.ToString("N") }, Anchor = E(a), Index = 1,
            CreatedAt = "successful-save", NativeOrder = new() { E(a), E(b), E(c) } };
        doc.Intents.Add(intent); doc.Order = new() { E(a), E(b) };
        // Capture an acknowledged append through the actual placement observer. The saved plan still asks C after A;
        // restart before its next move can use that successful save, with no native writer involved.
        await ListPlaylistPlacement.PlaceAsync(h.Host, h.Plugin.Core.Logger, list.Info.Id, access.ListIdN, owner,
            new[] { c }, E(b), new() { E(a), E(b), E(c) }, new[] { E(c) },
            (kind, ids) => new ListWrite(list.Info.Id, owner.Id, kind),
            (before, after) => ListPlaylistPlacement.RecordSave(doc, intent, before, after));
        Assert.Equal(h.Host.GetStoredSaveStamp(list.Info.Id), intent.StoredSaveStamp); h.Store.Save(doc);
        h.Host.AfterAdd = null; h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, c, b }, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
        Assert.Empty(h.Store.Load(access.ListIdN)!.AbandonedPlacements);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SwapFailureCannotImmediatelySettleOverTheNativeRoundTrip(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        var ph = Movie(15151);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { ph }, new PositionDto { AfterToken = E(a) }, null, null, None));
        await h.Consent(access); var c = h.Host.AddItem(tmdb: 15151);
        h.Host.AfterAdd = _ =>
        {
            list.Raw.Clear(); list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) }); list.Persist();
            h.Host.NativeMoveAsync(list.Info.Id, c, 1, owner.Id).GetAwaiter().GetResult();
            h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id).GetAwaiter().GetResult();
            throw new IOException("lost swap completion");
        };
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id));
        Assert.DoesNotContain(h.Host.Calls, call => call.StartsWith("move:"));
        await Receipt(h, access, "placement_evidence_missing");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedRecoveryMoveClearsPreviouslySuccessfulProof(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) }); list.Persist();
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist); doc.Order = new() { E(a), E(b), E(c) };
        doc.Intents.Add(new SwapIntent { ByUserId = owner.Id.ToString("N"), ItemIds = new() { c.ToString("N") }, Anchor = E(a), Index = 1,
            CreatedAt = "recover", NativeOrder = new() { E(a), E(b), E(c) }, StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id) }); h.Store.Save(doc);
        h.Host.OnAwait = stage =>
        {
            if (stage != "move:after") return;
            h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id).GetAwaiter().GetResult();
            throw new IOException("move completion lost");
        };
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        var saved = h.Store.Load(access.ListIdN)!;
        var evidence = saved.Intents.Concat(saved.AbandonedPlacements).Single(); Assert.Null(evidence.StoredSaveStamp);
        h.Host.OnAwait = null; h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Host.Calls);
        await Receipt(h, access, "placement_evidence_missing");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SuccessfulProofIsCapturedBeforeTheContinuationCanObserveANativeRoundTrip(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        var continuation = new ListContinuation(h.Store, () => null);
        DateTime? successfulStamp = null;
        h.Host.AfterAdd = _ =>
        {
            list.Raw.Clear(); list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) }); list.Persist();
            successfulStamp = h.Host.GetStoredSaveStamp(list.Info.Id);
        };
        h.Store.Awaited = site =>
        {
            if (!site.StartsWith("ObserveSaveAsync:", StringComparison.Ordinal)) return;
            h.Host.NativeMoveAsync(list.Info.Id, c, 1, owner.Id).GetAwaiter().GetResult();
            h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id).GetAwaiter().GetResult();
            throw new IOException("outer continuation interrupted after successful capture");
        };
        Assert.Equal(500, (await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        h.Store.Awaited = null; continuation.Dispose(); h.Host.AfterAdd = null;
        Assert.NotNull(successfulStamp);
        Assert.Equal(successfulStamp, Assert.Single(h.Store.Load(access.ListIdN)!.Intents).StoredSaveStamp);
        Assert.NotEqual(successfulStamp, h.Host.GetStoredSaveStamp(list.Info.Id));
        h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Host.Calls);
        await Receipt(h, access, "superseded_by_reorder");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RefusedObservationOfAnAlreadyStartedNativeTaskClearsOldProof(bool positional)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        var doc = new ListDoc(); var intent = new SwapIntent { StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id) }; doc.Intents.Add(intent);
        var refused = false;
        using var continuation = new ListContinuation(h.Store, () => refused ? ListContinuation.NotFound() : null);
        h.Host.AfterAdd = _ => refused = true; // The native task started; its continuation can no longer observe it.
        await Assert.ThrowsAsync<ListAccessLostException>(() => ListPlaylistPlacement.PlaceAsync(h.Host, h.Plugin.Core.Logger,
            list.Info.Id, access.ListIdN, owner, new[] { c }, E(a), new() { E(a), E(c), E(b) }, new[] { E(c) },
            (kind, ids) => new ListWrite(list.Info.Id, owner.Id, kind),
            (before, after) => ListPlaylistPlacement.RecordSave(doc, intent, before, after)));
        Assert.Null(intent.StoredSaveStamp);
    }

    private static async Task Receipt(ListsHarness h, ListAccess access, string reason)
    {
        var doc = h.Store.Load(access.ListIdN)!; Assert.Empty(doc.Intents);
        Assert.Equal(reason, Assert.Single(doc.AbandonedPlacements).AbandonedReason);
        var view = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(access, None));
        Assert.Equal(reason, Assert.Single(view.GetProperty("placements").EnumerateArray()).GetProperty("reason").GetString());
        Assert.Contains("reason=" + reason, File.ReadAllText(h.Plugin.Core.Logger.CurrentLogFilePath));
    }
}
