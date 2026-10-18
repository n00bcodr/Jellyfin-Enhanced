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
    public async Task PendingMoveIsEntryScopedAndThreeRecoveryFailuresAbandonItDurably()
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner"); var editor = h.NewUser("editor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(list, owner);
        var a = h.Host.AddItem(); var b = h.Host.AddItem(); var c = h.Host.AddItem(); var d = h.Host.AddItem();
        list.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        h.Host.FailMoves = 100;
        Assert.Equal(500, (await h.Service.ApplyAsync(h.AccessFor(list, editor), new[] { new ApplyEntry(0, c, null) }, new PositionDto { AfterToken = E(a) }, null, null, None)).StatusCode);
        // First recovery fails, but the owner's unrelated append still succeeds.
        Ok<ApplyResultDto>(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, d, null) }, null, null, null, None));
        Assert.Single(h.Store.Load(access.ListIdN)!.Intents);
        // A refused write anchored to C does not mutate the list or consume a recovery attempt.
        Error(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(9912) }, new PositionDto { AfterToken = E(c) }, null, null, None), 409, "placement_pending");
        Assert.Equal(1, Assert.Single(h.Store.Load(access.ListIdN)!.Intents).Attempts);
        // A different placeholder swaps at the end while that intent is still pending.
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        var ph = Movie(9913); doc.Items.Add(ph); doc.Order.Add(P(ph.Id)); h.Store.Save(doc);
        await h.Consent(access);
        var arrived = h.Host.AddItem(tmdb: 9913);
        h.Store.InvalidateAll();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(2, Assert.Single(h.Store.Load(access.ListIdN)!.Intents).Attempts);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items); // the other swap already completed while C waits
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        var final = h.Store.Load(access.ListIdN)!;
        Assert.Empty(final.Intents); Assert.Empty(final.Items);
        Assert.Equal(new[] { a, b, c, d, arrived }, h.Host.Resolved(list.Info.Id));
        var receipt = JsonSerializer.SerializeToElement(final).GetProperty("abandonedPlacements")[0];
        Assert.Equal("placement_retry_limit", receipt.GetProperty("abandonedReason").GetString());
        Assert.Equal(3, receipt.GetProperty("attempts").GetInt32());
        var view = JsonSerializer.SerializeToElement(await h.Service.GetViewAsync(access, None));
        Assert.Equal("abandoned", view.GetProperty("placements")[0].GetProperty("state").GetString());
        h.Host.FailMoves = 0; h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Empty(h.Host.Calls);
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
            ItemIds = new() { c.ToString("N") }, Anchor = E(a), Index = 1, CreatedAt = "test", OccurrenceCountsBefore = new() { [c.ToString("N")] = 0 } });
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
