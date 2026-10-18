using Jellyfin.Data;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsPlacementRecoveryTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Theory]
    [InlineData(false, "native-back")]
    [InlineData(true, "native-back")]
    [InlineData(false, "je-only")]
    [InlineData(true, "je-only")]
    [InlineData(false, "legacy-stamp")]
    [InlineData(true, "legacy-stamp")]
    public async Task RecoveryRequiresAnUnchangedStoredSaveStampEvenWhenNativeOrderMatches(bool positional, string scenario)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var editor = h.NewUser("editor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) }); list.Persist();
        // A native insert lands, but completion dies before the desired C-after-A move can settle.
        h.Host.AfterAdd = _ =>
        {
            list.Raw.Clear(); list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) });
            list.Persist();
        };
        var interrupted = InterruptAfterObservedSave(h);
        Assert.Equal(500, (await h.Service.ApplyAsync(h.AccessFor(list, editor), new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        h.Store.Awaited = null; interrupted.Dispose();
        h.Host.AfterAdd = null;
        var stamp = h.Host.GetStoredSaveStamp(list.Info.Id);
        var pending = Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        Assert.Equal(new[] { E(a), E(b), E(c) }, pending.NativeOrder);
        if (scenario == "native-back")
        {
            // Use the native manager algorithm twice, with no JE reorder journal involved.
            await h.Host.NativeMoveAsync(list.Info.Id, c, 1, owner.Id);
            Assert.Equal(new[] { a, c, b }, h.Host.Resolved(list.Info.Id));
            await h.Host.NativeMoveAsync(list.Info.Id, c, 2, owner.Id);
            Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id));
            Assert.True(h.Host.GetStoredSaveStamp(list.Info.Id) > stamp);
        }
        if (scenario == "legacy-stamp")
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            var json = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(doc.Intents[0]))!.AsObject();
            json.Remove("storedSaveStamp");
            doc.Intents[0] = JsonSerializer.Deserialize<SwapIntent>(json.ToJsonString())!; h.Store.Save(doc);
        }
        h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        var final = h.Store.Load(access.ListIdN)!;
        Assert.Empty(final.Intents);
        if (scenario == "je-only")
        {
            Assert.Equal(new[] { a, c, b }, h.Host.Resolved(list.Info.Id));
            Assert.Contains(h.Host.Calls, call => call.StartsWith("move:"));
            Assert.Empty(final.AbandonedPlacements);
        }
        else
        {
            Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id));
            Assert.Empty(h.Host.Calls);
            var reason = scenario == "native-back" ? "superseded_by_reorder" : "placement_evidence_missing";
            Assert.Equal(reason, Assert.Single(final.AbandonedPlacements).AbandonedReason);
            Assert.Contains("reason=" + reason, File.ReadAllText(h.Plugin.Core.Logger.CurrentLogFilePath));
            var view = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(access, None));
            Assert.Equal(reason, Assert.Single(view.GetProperty("placements").EnumerateArray()).GetProperty("reason").GetString());
        }
    }

    [Theory]
    [InlineData(false, "displaced")]
    [InlineData(true, "displaced")]
    [InlineData(false, "native")]
    [InlineData(true, "native")]
    [InlineData(false, "je")]
    [InlineData(true, "je")]
    [InlineData(false, "je-back")]
    [InlineData(true, "je-back")]
    [InlineData(false, "settled")]
    [InlineData(true, "settled")]
    public async Task FailedCompletionVerifiesPlacementAndRespectsLaterReorders(bool positional, string scenario)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner"); var editor = h.NewUser("editor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var x = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        if (scenario == "displaced" && positional)
        {
            // Jellyfin receives the previously computed raw index after a concurrent insertion shifts A.
            h.Host.BeforeAdd = (_, _, _) => { list.Raw.Insert(0, new RawEntry(x, true)); return Task.CompletedTask; };
        }
        h.Host.AfterAdd = _ =>
        {
            if (scenario != "displaced")
            {
                list.Raw.Clear();
                list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(c, true), new RawEntry(b, true) });
            }
            list.Persist();

        };
        var interrupted = InterruptAfterObservedSave(h);
        Assert.Equal(500, (await h.Service.ApplyAsync(h.AccessFor(list, editor), new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        h.Store.Awaited = null; interrupted.Dispose();
        Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        h.Host.BeforeAdd = null; h.Host.AfterAdd = null;
        if (scenario == "native")
        {
            list.Raw.Clear();
            list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) });
            list.Persist();
        }
        if (scenario is "je" or "je-back")
        {
            var doc = h.Store.Load(access.ListIdN)!;
            Ok<ListViewDto>(await h.Service.ReorderAsync(access, doc.Rev, new[] { E(a), E(b), E(c) }, E(c), null, None));
            if (scenario == "je-back")
                Ok<ListViewDto>(await h.Service.ReorderAsync(access, h.Store.Load(access.ListIdN)!.Rev, new[] { E(a), E(c), E(b) }, E(c), null, None));
        }
        // An unrelated later native append must not be mistaken for a person's reorder.
        if (scenario == "displaced" && !positional) list.Raw.Add(new RawEntry(x, true));
        h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        var final = h.Store.Load(access.ListIdN)!;
        Assert.Empty(final.Intents);
        var superseded = scenario is "native" or "je" or "je-back";
        var expected = scenario is "native" or "je" ? new[] { a, b, c } : scenario == "displaced"
            ? positional ? new[] { x, a, c, b } : new[] { a, c, b, x }
            : new[] { a, c, b };
        Assert.Equal(expected, h.Host.Resolved(list.Info.Id));
        Assert.Equal(expected.Select(id => E(id)), final.Order);
        if (scenario == "displaced") Assert.Contains(h.Host.Calls, call => call.StartsWith("move:"));
        else Assert.Empty(h.Host.Calls);
        if (superseded)
        {
            Assert.Equal("superseded_by_reorder", Assert.Single(final.AbandonedPlacements).AbandonedReason);
            var audit = File.ReadAllText(h.Plugin.Core.Logger.CurrentLogFilePath);
            Assert.Contains("reason=superseded_by_reorder", audit);
            var view = await h.Service.GetViewAsync(access, None);
            Assert.Equal("superseded_by_reorder", JsonSerializer.SerializeToElement(view).GetProperty("placements")[0].GetProperty("reason").GetString());
        }
        else
        {
            Assert.Empty(final.AbandonedPlacements);
            Assert.Contains("placement_settled", File.ReadAllText(h.Plugin.Core.Logger.CurrentLogFilePath));
        }
    }

    [Theory]
    [InlineData(false, "hidden")]
    [InlineData(true, "hidden")]
    [InlineData(false, "hidden-limit")]
    [InlineData(true, "hidden-limit")]
    [InlineData(false, "legacy")]
    [InlineData(true, "legacy")]
    [InlineData(false, "anchor")]
    [InlineData(true, "anchor")]
    public async Task RecoveryRetiresOnlyVerifiedPlacementOrARecordedReason(bool positional, string scenario)
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        h.Host.AfterAdd = _ =>
        {
            list.Raw.Clear(); list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) });
            list.Persist();
        };
        var interrupted = InterruptAfterObservedSave(h);
        Assert.Equal(500, (await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        h.Store.Awaited = null; interrupted.Dispose();
        h.Host.AfterAdd = null;
        if (scenario.StartsWith("hidden", StringComparison.Ordinal)) h.Host.Hide(c, owner); // Native moves cannot reach the target.
        if (scenario == "legacy")
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            Assert.Single(doc.Intents).NativeOrder = null; h.Store.Save(doc);
        }
        if (scenario == "anchor") list.Raw.RemoveAt(0);
        h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        var recovered = h.Store.Load(access.ListIdN)!;
        if (scenario.StartsWith("hidden", StringComparison.Ordinal))
        {
            Assert.Equal(1, Assert.Single(recovered.Intents).Attempts);
            Assert.Empty(recovered.AbandonedPlacements);
            if (scenario == "hidden-limit")
            {
                // Repeated gate refusals start no native save and keep the last known successful proof.
                await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
                await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
                var final = h.Store.Load(access.ListIdN)!; Assert.Empty(final.Intents);
                Assert.Equal("placement_retry_limit", Assert.Single(final.AbandonedPlacements).AbandonedReason);
                Assert.Equal(3, final.AbandonedPlacements[0].Attempts);
                Assert.Equal(new[] { a, b, c }, h.Host.Resolved(list.Info.Id));
                return;
            }
            h.Host.HiddenFrom.Clear();
            await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
            Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
            Assert.Equal(new[] { a, c, b }, h.Host.Resolved(list.Info.Id));
        }
        else
        {
            Assert.Empty(recovered.Intents); Assert.Empty(h.Host.Calls);
            Assert.Equal(scenario == "anchor" ? "anchor_removed" : "placement_evidence_missing", Assert.Single(recovered.AbandonedPlacements).AbandonedReason);
            Assert.Equal(scenario == "anchor" ? new[] { b, c } : new[] { a, b, c }, h.Host.Resolved(list.Info.Id));
        }
    }

    // Native positional inserts can also lose their acknowledgement after membership lands. Both targets exercise
    // both seams, with an on-disk reload between the failed apply and recovery.
    [Theory]
    [InlineData(false, "revoked")]
    [InlineData(false, "deleted")]
    [InlineData(false, "disabled")]
    [InlineData(true, "revoked")]
    [InlineData(true, "deleted")]
    [InlineData(true, "disabled")]
    public async Task LostActorAbandonsWithoutMovingAndOwnerApplyAndOtherSwapsContinue(bool positional, string loss)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var ph = Movie(9911);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(ph); doc.Order = new() { E(a), E(b), P(ph.Id) };
        doc.Source = new ListSource { Owned = new() { ["kept"] = new SourceOwnership { ItemIds = new() { c.ToString("N") } } } };
        h.Store.Save(doc);
        await h.Consent(access);
        h.Host.FailMoves = 10;
        if (positional) { h.Host.FailAdds = new IOException("lost acknowledgement"); h.Host.FailAfterMutating = true; }
        var failed = await h.Service.ApplyAsync(h.AccessFor(list, editor), new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None);
        Assert.Equal(500, failed.StatusCode);
        Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        var before = h.Host.Resolved(list.Info.Id).ToArray();
        Assert.Equal(positional ? new[] { a, c, b } : new[] { a, b, c }, before);
        h.Host.FailAdds = null; h.Host.FailMoves = 0;
        if (loss == "revoked") list.Info = list.Info with { Shares = Array.Empty<ListShare>() };
        if (loss == "deleted") h.Users.Setup(u => u.GetUserById(editor.Id)).Returns((User?)null);
        if (loss == "disabled") editor.SetPermission(PermissionKind.IsDisabled, true);
        h.Store.InvalidateAll(); h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Equal(before, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Host.Calls);
        var recovered = h.Store.Load(access.ListIdN)!;
        Assert.Empty(recovered.Intents);
        var receipt = JsonSerializer.SerializeToElement(recovered).GetProperty("abandonedPlacements")[0];
        Assert.Equal("actor_" + loss, receipt.GetProperty("abandonedReason").GetString());
        Assert.Equal(editor.Id.ToString("N"), receipt.GetProperty("byUserId").GetString());
        var audit = File.ReadAllText(h.Plugin.Core.Logger.CurrentLogFilePath);
        Assert.Contains("placement_abandoned", audit);
        Assert.Contains("reason=actor_" + loss, audit);
        Assert.Contains(c.ToString("N"), recovered.Source!.Owned["kept"].ItemIds);
        var view = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(access, None));
        Assert.Equal("actor_" + loss, Assert.Single(view.GetProperty("placements").EnumerateArray()).GetProperty("reason").GetString());
        Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, d, null) }, null, null, null, None));
        var arrived = h.Host.AddItem(tmdb: 9911);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Contains(arrived, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
        Assert.Equal(before, h.Host.Resolved(list.Info.Id).Where(id => id == a || id == b || id == c));
        // Restoring the original identity/access must not resurrect an abandoned placement.
        h.Users.Setup(u => u.GetUserById(editor.Id)).Returns(editor);
        editor.SetPermission(PermissionKind.IsDisabled, false);
        list.Info = list.Info with { Shares = new[] { new ListShare(editor.Id, true) } };
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Empty(h.Host.Calls);
    }

    [Fact]
    public async Task UnknownFailedMoveRetiresConservativelyAndOtherEntriesContinue()
    {
        using var h = new ListsHarness(); h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner"); var list = h.Host.AddPlaylist(owner); var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        h.Host.FailMoves = 100;
        Assert.Equal(500, (await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        Assert.Null(Assert.Single(h.Store.Load(access.ListIdN)!.Intents).StoredSaveStamp);
        Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, d, null) }, null, null, null, None));
        var final = h.Store.Load(access.ListIdN)!; Assert.Empty(final.Intents);
        Assert.Equal("placement_evidence_missing", Assert.Single(final.AbandonedPlacements).AbandonedReason);
        Assert.Equal(new[] { a, b, c, d }, h.Host.Resolved(list.Info.Id));
        var ph = Movie(9913); Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { ph }, null, null, null, None));
        await h.Consent(access); var arrived = h.Host.AddItem(tmdb: 9913);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Contains(arrived, h.Host.Resolved(list.Info.Id)); Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
        h.Host.FailMoves = 0; h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None); Assert.Empty(h.Host.Calls);
    }

    // The native save was acknowledged and observed; only the outer JE continuation is interrupted. This is
    // distinct from a failed/unknown native save, which now has no recovery proof (ListsSaveAttributionTests).
    private static IDisposable InterruptAfterObservedSave(ListsHarness h)
    {
        h.Store.Awaited = site =>
        {
            if (site.StartsWith("ObserveSaveAsync:", StringComparison.Ordinal)) throw new IOException("JE continuation interrupted after observed successful save");
        };
        return new ListContinuation(h.Store, () => null);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OtherPlaceholdersSwapWhileAnAuthorizedPlacementIsStillPending(bool swapIntent)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner"); var editor = h.NewUser("editor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(c, true) });
        var ph = Movie(9914); var waiting = Movie(9915);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        if (swapIntent) doc.Items.Add(waiting);
        doc.Items.Add(ph);
        doc.Order = swapIntent ? new() { E(a), P(waiting.Id), E(b), E(c), P(ph.Id) } : new() { E(a), E(b), E(c), P(ph.Id) };
        doc.Intents.Add(new SwapIntent { ByUserId = swapIntent ? null : editor.Id.ToString("N"), PhId = swapIntent ? waiting.Id : "",
            ItemIds = new() { c.ToString("N") }, Anchor = E(a), Index = 1, CreatedAt = "test", NativeOrder = new() { E(a), E(b), E(c) }, StoredSaveStamp = h.Host.GetStoredSaveStamp(list.Info.Id), OccurrenceCountsBefore = new() { [c.ToString("N")] = 0 } });
        doc.Source = new ListSource { Owned = new() { ["waiting"] = new SourceOwnership { PhId = waiting.Id } } };
        h.Store.Save(doc); await h.Consent(access);
        h.Host.FailMoves = 100;
        var arrived = h.Host.AddItem(tmdb: 9914);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        Assert.Contains(arrived, h.Host.Resolved(list.Info.Id));
        Assert.DoesNotContain(h.Store.Load(access.ListIdN)!.Items, p => p.Id == ph.Id);
        Assert.Equal(new[] { a, b, c, arrived }, h.Host.Resolved(list.Info.Id));
        // Exhaustion settles provenance of a landed swap without moving it; the source still owns C.
        if (swapIntent)
        {
            await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
            await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
            var final = h.Store.Load(access.ListIdN)!;
            Assert.Empty(final.Intents);
            Assert.Contains(c.ToString("N"), final.Source!.Owned["waiting"].ItemIds);
        }
        // A share editor cannot read actor/placement operational history; neither can a restricted owner see hidden tokens.
        var other = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(h.AccessFor(list, editor), None));
        Assert.Empty(other.GetProperty("placements").EnumerateArray());
        h.Host.Hide(c, owner);
        var hidden = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(access, None));
        Assert.Empty(hidden.GetProperty("placements").EnumerateArray());
    }

}
