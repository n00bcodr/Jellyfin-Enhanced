using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// D29 (new in the list core): automatic swap-in needs the admin switch, the list's recorded consent, and the consenting
// person (still there, enabled) agreeing in their own settings and still able to edit the list. Without it a pass only
// reads metadata and settles interrupted swaps by Jellyfin's real membership: no inserts, no moves. Also the restore
// reconciliation marker.
[Collection("Plugin singleton")]
public class ListsConsentTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Past = "2020-01-01";
    private const string Future = "2099-01-01";

    private static Placeholder Season(int tmdb, int season) =>
        Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show S{season}\"}}");

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WithoutConsentAnArrivalIsNeitherInsertedNorMovedAndTurningItOnSwapsItIn(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(500);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, new PositionDto { AfterToken = E(a) }, null, null, None));
        Assert.Null(h.Store.Load(access.ListIdN)!.SwapIn); // off by default

        var arrived = h.Host.AddItem(tmdb: 500);
        h.Host.Calls.Clear();
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(None);
        Assert.Equal(default, await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));

        Assert.Empty(h.Host.Calls);
        Assert.Equal(new[] { a, b }, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Equal(movie.Id, Assert.Single(doc.Items).Id);
        Assert.Empty(doc.Intents);
        Assert.Equal(new[] { E(a), P(movie.Id), E(b) }, doc.Order);
        var view = await h.Service.GetViewAsync(access, None);
        Assert.False(view.SwapIn);
        Assert.Contains("swapIn", view.Actions); // the editor may turn it on

        // The editor turns it on: the pass the switch queues swaps the title in at the entry's spot.
        var on = Ok<ListViewDto>(await h.Service.SetSwapInAsync(access, doc.Rev, true, K("swap-on"), None));
        Assert.True(on.SwapIn);
        Assert.Equal(access.UserIdN, h.Store.Load(access.ListIdN)!.SwapIn!.ByUserId);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { a, arrived, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);

        // And off again: recorded consent removed.
        var off = Ok<ListViewDto>(await h.Service.SetSwapInAsync(access, h.Store.Load(access.ListIdN)!.Rev, false, null, None));
        Assert.False(off.SwapIn);
        Assert.Null(h.Store.Load(access.ListIdN)!.SwapIn);
    }

    [Theory]
    [InlineData("switch")]
    [InlineData("preferenceOff")]
    [InlineData("preferenceUnset")]
    [InlineData("lostEdit")]
    [InlineData("disabled")]
    [InlineData("deleted")]
    public async Task RecordedConsentOnlyCountsWhileTheConsentingEditorStillAgreesAndMayEdit(string missing)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(playlist, editor);
        var movie = Movie(510);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        await h.Consent(access); // the editor (not the owner) turned it on
        var arrived = h.Host.AddItem(tmdb: 510);

        Action restore = missing switch
        {
            "switch" => Set(() => h.Plugin.Plugin.Configuration.ArrPhase4ListSwapInEnabled = false, () => h.Plugin.Plugin.Configuration.ArrPhase4ListSwapInEnabled = true),
            "preferenceOff" => Set(() => h.Preferences.ByUser[editor.Id] = (null, null, false), () => h.Preferences.ByUser.Remove(editor.Id)),
            "preferenceUnset" => Set(() => h.Preferences.ByUser[editor.Id] = (true, true, null), () => h.Preferences.ByUser.Remove(editor.Id)),
            "lostEdit" => Set(
                () => playlist.Info = playlist.Info with { Shares = new[] { new ListShare(editor.Id, false) } },
                () => playlist.Info = playlist.Info with { Shares = new[] { new ListShare(editor.Id, true) } }),
            "disabled" => Set(() => editor.SetPermission(PermissionKind.IsDisabled, true), () => editor.SetPermission(PermissionKind.IsDisabled, false)),
            "deleted" => Set(() => h.Users.Setup(u => u.GetUserById(editor.Id)).Returns((User?)null), () => h.Users.Setup(u => u.GetUserById(editor.Id)).Returns(editor)),
            _ => throw new ArgumentOutOfRangeException(nameof(missing)),
        };

        Assert.False(h.Swap.InsertsAllowed(playlist.Info, h.Store.Load(access.ListIdN)!));
        Assert.Equal(default, await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));
        Assert.Empty(h.Host.Calls);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);

        // Control: with that one condition back, the same pass swaps it in.
        restore();
        Assert.True(h.Swap.InsertsAllowed(playlist.Info, h.Store.Load(access.ListIdN)!));
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task TheTestSeamStillNeedsTheSwitchAndTheListsConsent()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(520) }, null, null, null, None));
        var asked = new List<Guid>();
        h.Swap.InsertsAllowedForTest = user =>
        {
            asked.Add(user);
            return true;
        };

        Assert.False(h.Swap.InsertsAllowed(playlist.Info, h.Store.Load(access.ListIdN)!)); // no recorded consent
        await h.Consent(access);
        h.Plugin.Plugin.Configuration.ArrPhase4ListSwapInEnabled = false;
        Assert.False(h.Swap.InsertsAllowed(playlist.Info, h.Store.Load(access.ListIdN)!));
        Assert.Empty(asked);
        h.Plugin.Plugin.Configuration.ArrPhase4ListSwapInEnabled = true;
        Assert.True(h.Swap.InsertsAllowed(playlist.Info, h.Store.Load(access.ListIdN)!));
        Assert.Equal(new[] { owner.Id }, asked);
    }

    [Fact]
    public async Task WithoutConsentMetadataIsStillReadButNothingGoesIn()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[530] = "{\"id\":530,\"name\":\"Show\",\"firstAirDate\":\"" + Past + "\",\"status\":\"Returning Series\",\"inProduction\":true," +
            "\"externalIds\":{\"tvdbId\":1530},\"lastEpisodeToAir\":{\"seasonNumber\":1,\"episodeNumber\":2,\"airDate\":\"" + Past + "\"}," +
            "\"nextEpisodeToAir\":{\"seasonNumber\":1,\"episodeNumber\":3,\"airDate\":\"" + Future + "\"}," +
            "\"seasons\":[{\"seasonNumber\":1,\"episodeCount\":3,\"airDate\":\"" + Past + "\"}]}";
        h.SeasonDetails[(530, 1)] = "{\"seasonNumber\":1,\"airDate\":\"" + Past + "\",\"episodes\":[" +
            "{\"episodeNumber\":1,\"seasonNumber\":1,\"airDate\":\"" + Past + "\"},{\"episodeNumber\":2,\"seasonNumber\":1,\"airDate\":\"" + Past + "\"}," +
            "{\"episodeNumber\":3,\"seasonNumber\":1,\"airDate\":\"" + Future + "\"}]}";
        var season = Season(530, 1);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        await h.Swap.DrainAsync(None);

        var stored = h.Store.Load(access.ListIdN)!.Items.Single();
        Assert.Equal(3, stored.Expected.Count);
        Assert.Equal(1530, stored.TvdbId);
        Assert.True(stored.InProduction);

        var series = h.Host.AddSeries(tmdb: 530);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        h.Swap.NotifyItemChanged(e1);
        await h.Swap.DrainAsync(None);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.Force, None);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items.Single().Filled);
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("add:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task WithoutConsentAnInterruptedSwapKeepsPlacementIntentWithoutAnyMove()
    {
        // As ListsReviewR1b2Tests.AnInterruptedTenElevenSwapIsMovedNextToItsAnchorOnRecovery, but the consent was turned off
        // between the crash and the recovery: the landed item stays where Jellyfin put it, with its placement plan kept until consent resumes.
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var done = Movie(540);
        var notDone = Movie(541);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { done, notDone }, new PositionDto { AfterToken = E(a) }, null, null, None));
        var landed = h.Host.AddItem(tmdb: 540);
        var pending = h.Host.AddItem(tmdb: 541);

        // A 10.11 append that landed (not moved yet) and one that never reached Jellyfin, both with their intents saved.
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Intents.Add(new SwapIntent { PhId = done.Id, ItemIds = { landed.ToString("N") }, Anchor = E(a), Index = 1, OccurrenceCountsBefore = { [landed.ToString("N")] = 0 }, CreatedAt = "x1", NativeOrder = new() { E(a), E(b), E(landed) }, StoredSaveStamp = h.Host.GetStoredSaveStamp(playlist.Info.Id) });
            doc.Intents.Add(new SwapIntent { PhId = notDone.Id, ItemIds = { pending.ToString("N") }, Anchor = E(a), Index = 2, OccurrenceCountsBefore = { [pending.ToString("N")] = 0 }, CreatedAt = "x2" });
            h.Store.Save(doc);
        }

        playlist.Raw.Add(new RawEntry(landed, true));
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Empty(h.Host.Calls); // no move of the landed item, no insert of the pending one
        Assert.Equal(new[] { a, b, landed }, h.Host.Resolved(playlist.Info.Id));
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Single(after.Intents); // the landed run has not finished its planned placement
        Assert.Contains(after.Items, p => p.Id == done.Id);
        Assert.Contains(after.Items, p => p.Id == notDone.Id); // unlanded intent rolled back, no fresh insert
        await h.Consent(access);
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
        Assert.DoesNotContain(h.Store.Load(access.ListIdN)!.Items, p => p.Id == done.Id);
        Assert.Equal(new[] { a, landed, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("add:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARestoreMarksListsForReconciliationWhichAPassSettlesAndClears()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        var done = Movie(550);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { done }, null, null, null, None));
        await h.Consent(access);
        var landed = h.Host.AddItem(tmdb: 550);

        // The restored document (written behind the store's back) holds an intent whose item already landed.
        var restored = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        restored.Intents.Add(new SwapIntent { PhId = done.Id, ItemIds = { landed.ToString("N") }, Anchor = E(a), OccurrenceCountsBefore = { [landed.ToString("N")] = 0 }, CreatedAt = "x" });
        restored.Rev += 5;
        File.WriteAllText(Path.Combine(h.Store.DirectoryPath, access.ListIdN + ".json"), System.Text.Json.JsonSerializer.Serialize(restored));
        playlist.Raw.Add(new RawEntry(landed, true));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Intents); // the cache still has the old document

        using var lifecycle = new ListLifecycle(new Mock<ILibraryManager>().Object, h.Store, h.Host, h.Plugin.Core.Logger, operations: h.Operations, events: h.Events);
        Assert.Equal(1, await lifecycle.ReconcileAfterRestoreAsync());

        var marked = h.Store.Load(access.ListIdN)!;
        Assert.Equal("restore", marked.Reconcile);
        Assert.Single(marked.Intents); // read from disk again
        Assert.Equal(restored.Rev + 1, marked.Rev);
        Assert.True((await h.Service.GetViewAsync(access, None)).Reconciling);
        Assert.Equal(0, await lifecycle.ReconcileAfterRestoreAsync()); // already waiting: not marked twice

        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Null(after.Reconcile);
        Assert.Empty(after.Intents);
        Assert.Empty(after.Items); // completed from the intent: no second copy
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("add:", StringComparison.Ordinal));
        Assert.Equal(new[] { a, landed }, h.Host.Resolved(playlist.Info.Id));
        Assert.False((await h.Service.GetViewAsync(access, None)).Reconciling);
    }

    [Fact]
    public async Task AReconcilingListWithoutConsentIsClearedWithoutInserting()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(560);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Reconcile = "import";
            h.Store.Save(doc);
        }

        h.Host.AddItem(tmdb: 560);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Null(after.Reconcile);
        Assert.Single(after.Items);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
    }

    [Fact]
    public async Task AnEditShareRemovedWhileAPassWaitsForTheListInsertsNothing()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(owner, true, new ListShare(editor.Id, true));
        var access = h.AccessFor(playlist, editor);
        var movie = Movie(520);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        await h.Consent(access);
        h.Host.AddItem(tmdb: 520);
        h.Host.Calls.Clear();

        // The pass reads the list, then waits for the lock; meanwhile the consenting editor's share is removed (the
        // public playlist stays visible to them).
        Task<SwapPassResult> pass;
        using (await h.Store.LockAsync(access.ListIdN))
        {
            pass = h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
            playlist.Info = playlist.Info with { Shares = Array.Empty<ListShare>() };
        }

        Assert.Equal(default, await pass);
        Assert.Empty(h.Host.Calls);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task AnEditShareRemovedBetweenTwoSwapsStopsThePassBeforeTheSecondInsert()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var access = h.AccessFor(playlist, editor);
        var first = Movie(521);
        var second = Movie(522);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { first, second }, null, null, null, None));
        await h.Consent(access);
        var firstCopy = h.Host.AddItem(tmdb: 521);
        h.Host.AddItem(tmdb: 522);
        // Jellyfin takes the first title, then the editor's share is made read-only.
        h.Host.AfterAdd = _ => playlist.Info = playlist.Info with { Shares = new[] { new ListShare(editor.Id, false) } };

        var result = await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(1, result.Inserted);
        Assert.Equal(new[] { firstCopy }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(second.Id, Assert.Single(h.Store.Load(access.ListIdN)!.Items).Id);
    }

    private static Action Set(Action apply, Action restore)
    {
        apply();
        return restore;
    }
}
