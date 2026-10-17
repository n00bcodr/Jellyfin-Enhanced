using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 1 (b2): swap intents finish placements where they were planned (F8), collection swap-ins are
// intent-protected (F9) and credit only what Jellyfin added (F10), and stale "being added" matches are pruned (F11).
[Collection("Plugin singleton")]
public class ListsReviewR1b2Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static Placeholder Season(int tmdb, int season) =>
        Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show S{season}\"}}");

    // Adds the entries and (D29) turns automatic swap-in on for the list as the caller, so the passes below may insert.
    private static async Task Add(ListsHarness h, ListAccess access, PositionDto? position, params Placeholder[] placeholders)
    {
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, placeholders, position, null, null, None));
        await h.Consent(access);
    }

    // What a crash right after Jellyfin's write leaves behind: the document on disk (with its intent) and the entries.
    private sealed class CrashPoint
    {
        public ListDoc? Doc { get; set; }

        public List<RawEntry>? Raw { get; set; }

        public void Capture(ListsHarness h, FakeListHost.FakeList list, string listIdN)
        {
            if (Doc == null)
            {
                Doc = h.Store.LoadForUpdate(listIdN, list.Info.Kind);
                Raw = list.Raw.ToList();
            }
        }

        public async Task RestoreAsync(ListsHarness h, FakeListHost.FakeList list, string listIdN)
        {
            Assert.NotNull(Doc);
            list.Raw.Clear();
            list.Raw.AddRange(Raw!);
            using (await h.Store.LockAsync(listIdN))
            {
                h.Store.Save(Doc!);
            }
        }
    }

    private static async Task MakeSyncOwned(ListsHarness h, ListAccess access, string kind, Placeholder placeholder, string key)
    {
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, kind);
            doc.Items.Single(p => p.Id == placeholder.Id).SourceKey = key;
            doc.Source = new ListSource { Kind = "tmdb", Url = "https://www.themoviedb.org/list/1" };
            doc.Source.Owned[key] = new SourceOwnership { PhId = placeholder.Id };
            h.Store.Save(doc);
        }
    }

    // F8: 10.11 appends, then moves; a crash in between left the movie at the end. Recovery finishes the move.
    [Fact]
    public async Task AnInterruptedTenElevenSwapIsMovedNextToItsAnchorOnRecovery()
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(801);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, movie);

        var arrived = h.Host.AddItem(tmdb: 801);
        var crash = new CrashPoint();
        h.Host.AfterAdd = _ => crash.Capture(h, playlist, access.ListIdN);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.AfterAdd = null;
        await crash.RestoreAsync(h, playlist, access.ListIdN);
        Assert.Equal(new[] { a, b, arrived }, h.Host.Resolved(playlist.Info.Id));
        Assert.Single(crash.Doc!.Intents);

        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None); // intents only

        Assert.Equal(new[] { a, arrived, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { $"move:{FakeListHost.Short(arrived)}->1" }, h.Host.Calls);
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Intents);
        Assert.Empty(doc.Items);
        Assert.Equal(new[] { E(a), E(arrived), E(b) }, doc.Order);
    }

    // F8: recovery puts the landed episode at the planned spot — after the placeholders before it, before its own
    // placeholder — instead of letting reconcile hang the placeholder in front of its fill.
    [Fact]
    public async Task AnInterruptedSeasonSwapPutsItsEpisodeAtThePlannedSpotOnRecovery()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var other = Movie(802);
        var season = Season(803, 1);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, other, season);
        Assert.Equal(new[] { E(a), P(other.Id), P(season.Id), E(b) }, h.Store.Load(access.ListIdN)!.Order);

        var series = h.Host.AddSeries(tmdb: 803);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        var crash = new CrashPoint();
        h.Host.AfterAdd = _ => crash.Capture(h, playlist, access.ListIdN);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.AfterAdd = null;
        await crash.RestoreAsync(h, playlist, access.ListIdN);
        Assert.Equal(new[] { a, e1, b }, h.Host.Resolved(playlist.Info.Id));

        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);

        Assert.Empty(h.Host.Calls);
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Intents);
        Assert.Equal(new[] { E(a), P(other.Id), E(e1), P(season.Id), E(b) }, doc.Order);
        Assert.Equal(new[] { e1.ToString("N") }, doc.Items.Single(p => p.Id == season.Id).Filled.Select(f => f.ItemId));
    }

    // F8: Jellyfin wrote the episode and then threw: the fill still goes before its placeholder.
    [Fact]
    public async Task AThrowAfterJellyfinsWriteKeepsTheSeasonPlaceholderAfterItsEpisode()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var season = Season(804, 1);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, season);
        var series = h.Host.AddSeries(tmdb: 804);
        var e1 = h.Host.AddEpisode(series, 1, 1);

        h.Host.FailAdds = new InvalidOperationException("event subscriber failed");
        h.Host.FailAfterMutating = true;
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(new[] { a, e1, b }, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Intents);
        Assert.Equal(new[] { E(a), E(e1), P(season.Id), E(b) }, doc.Order);
        Assert.Single(doc.Items.Single().Filled);
    }

    // F8: a 10.11 move that throws once is retried, so the movie doesn't stay at the end.
    [Fact]
    public async Task AFailedTenElevenMoveIsRetriedOnceBeforeFallingBackToJellyfinsOrder()
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = false;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(805);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, movie);
        var arrived = h.Host.AddItem(tmdb: 805);

        h.Host.FailMoves = 1;
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(new[] { a, arrived, b }, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Intents);
        Assert.Empty(doc.Items);
        Assert.Equal(new[] { E(a), E(arrived), E(b) }, doc.Order);

        // When the retry fails too, Jellyfin's order stands (no loop).
        var c = h.Host.AddItem();
        playlist.Raw.Add(new RawEntry(c, true));
        var second = Movie(806);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, second);
        var arrived2 = h.Host.AddItem(tmdb: 806);
        h.Host.FailMoves = 2;
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(2, h.Host.Calls.Count(call => call.StartsWith("move:", StringComparison.Ordinal)));
        Assert.Equal(new[] { a, arrived, b, c, arrived2 }, h.Host.Resolved(playlist.Info.Id));
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Empty(after.Items);
        Assert.Equal(new[] { E(a), E(arrived), E(b), E(c), E(arrived2) }, after.Order);
    }

    // F9: a crash right after Jellyfin's collection write: the persisted intent still makes the item sync-owned.
    [Fact]
    public async Task ACollectionSwapInterruptedAfterJellyfinsWriteStillBecomesSyncOwned()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var movie = Movie(811);
        await Add(h, access, null, movie);
        await MakeSyncOwned(h, access, ListKinds.Collection, movie, "movie|811||");

        var arrived = h.Host.AddItem(tmdb: 811);
        var crash = new CrashPoint();
        h.Host.AfterCollectionAdd = _ => crash.Capture(h, collection, access.ListIdN);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.AfterCollectionAdd = null;
        await crash.RestoreAsync(h, collection, access.ListIdN);
        Assert.Single(crash.Doc!.Intents);
        Assert.Single(crash.Doc.Items);

        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Empty(h.Host.Calls);
        Assert.Equal(new[] { arrived }, h.Host.Resolved(collection.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Intents);
        Assert.Empty(doc.Items);
        Assert.Equal(new[] { arrived.ToString("N") }, doc.Source!.Owned["movie|811||"].ItemIds);
    }

    // F9: Jellyfin wrote the member and then threw (e.g. an ItemsAddedToCollection subscriber): still sync-owned.
    [Fact]
    public async Task ACollectionAddThatThrowsAfterJellyfinsWriteStillBecomesSyncOwned()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var movie = Movie(812);
        await Add(h, access, null, movie);
        await MakeSyncOwned(h, access, ListKinds.Collection, movie, "movie|812||");

        var arrived = h.Host.AddItem(tmdb: 812);
        h.Host.FailAdds = new InvalidOperationException("subscriber threw");
        h.Host.FailAfterMutating = true;
        var result = await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.FailAdds = null;
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(new SwapPassResult(1, 1), result);
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Intents);
        Assert.Empty(doc.Items);
        Assert.Equal(new[] { arrived.ToString("N") }, doc.Source!.Owned["movie|812||"].ItemIds);
    }

    // F10: an id Jellyfin didn't actually add is neither counted nor sync-owned, and the placeholder waits for it.
    [Fact]
    public async Task ACollectionItemJellyfinDidNotAddIsNeitherCountedNorOwned()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var movie = Movie(821);
        await Add(h, access, null, movie);
        await MakeSyncOwned(h, access, ListKinds.Collection, movie, "movie|821||");

        var arrived = h.Host.AddItem(tmdb: 821);
        h.Host.CollectionDrops.Add(arrived);
        var result = await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(default, result);
        Assert.Empty(h.Host.Resolved(collection.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Single(doc.Items);
        Assert.Empty(doc.Intents);
        Assert.Empty(doc.Source!.Owned["movie|821||"].ItemIds);

        h.Host.CollectionDrops.Clear();
        Assert.Equal(new SwapPassResult(1, 1), await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));
        Assert.Equal(new[] { arrived.ToString("N") }, h.Store.Load(access.ListIdN)!.Source!.Owned["movie|821||"].ItemIds);
    }

    // F11: a match whose placeholder went away is never settled by a pass; it's pruned once its grace has ended.
    [Fact]
    public async Task MatchesOfPlaceholdersThatWentAwayArePrunedOnceTheirGraceEnds()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(831);
        var other = Movie(832);
        await Add(h, access, null, movie, other);

        // The owner can't see the arrival yet: the match stays "being added".
        var arrived = h.Host.AddItem(tmdb: 831);
        h.Host.Hide(arrived, owner);
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(None);
        Assert.Equal(arrived, h.Swap.GetPendingMatch(access.ListIdN, movie.Id));
        Assert.Equal(1, h.Swap.PendingMatchCount);

        // The placeholder is deleted; passes never look at it again.
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Items.RemoveAll(p => p.Id == movie.Id);
            doc.Order.Remove(P(movie.Id));
            h.Store.Save(doc);
        }

        var start = DateTime.UtcNow;
        h.Swap.UtcNow = () => start + TimeSpan.FromSeconds(30);
        h.Swap.QueuePass(access.ListIdN, null, MetadataMode.None);
        await h.Swap.DrainAsync(None);
        Assert.Equal(1, h.Swap.PendingMatchCount); // still within the grace

        h.Swap.UtcNow = () => start + ListSwapService.PendingMatchGrace + TimeSpan.FromMinutes(1);
        h.Swap.QueuePass(access.ListIdN, null, MetadataMode.None);
        await h.Swap.DrainAsync(None);
        Assert.Equal(0, h.Swap.PendingMatchCount);
    }
}
