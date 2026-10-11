using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 6: server-side fixes (rights checked again under the list lock for DELETE / reorder / unlink / sync now,
// collection seasons whose Season item was replaced, trims of aliased episode keys, Seerr season posters).
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR6Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // R6-1: DELETE and PUT /order run the parental lookups and wait for the list lock before writing; an editor whose
    // share was removed (or made read-only) meanwhile must not remove a placeholder or move a real row as the owner.
    [Theory]
    [InlineData(false, false, 404)]
    [InlineData(false, true, 403)]
    [InlineData(true, false, 404)]
    [InlineData(true, true, 403)]
    public async Task DeletesAndReordersByAnEditorWhoLostTheirRightsWriteNothing(bool reorder, bool keepViewShare, int expected)
    {
        using var h = new ListPlaceholdersHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        playlist.Raw.AddRange(new[] { a, b }.Select(id => new RawEntry(id, true)));
        var listId = playlist.Info.Id.ToString("N");
        var placeholder = Movie(10);
        var rev = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(h.AccessFor(playlist, owner), new[] { placeholder }, null, null, null, None)).View!.Rev;
        var stale = h.AccessFor(playlist, editor);
        Assert.True(stale.Permissions.CanEdit);
        var order = h.Store.Load(listId)!.Order.ToList();
        h.Host.Calls.Clear();

        // The owner removes the share (or makes it read-only) while the request is on its way to the lock.
        playlist.Info = playlist.Info with { Shares = keepViewShare ? new[] { new ListShare(editor.Id, false) } : Array.Empty<ListShare>() };

        var outcome = reorder
            ? await h.Service.ReorderAsync(stale, rev, new[] { E(b), E(a), P(placeholder.Id) }, E(a), null, None)
            : await h.Service.DeleteAsync(stale, placeholder.Id, rev, null, None);

        Assert.Equal(expected, outcome.StatusCode);
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("move:", StringComparison.Ordinal));
        Assert.Equal(new[] { a, b }, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(listId)!;
        Assert.Equal(placeholder.Id, Assert.Single(doc.Items).Id);
        Assert.Equal(order, doc.Order);
        Assert.Equal(rev, doc.Rev);
    }

    private static async Task<(ListPlaceholdersHarness H, FakeListHost.FakeList List, Jellyfin.Database.Implementations.Entities.User Editor)> LinkedSharedList()
    {
        var h = new ListPlaceholdersHarness();
        h.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        h.Lookup.Details[("movie", 1)] = new TitleDetails(FakeImportLookup.Movie(1, "Movie 1", "2020-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
        h.Fetcher.Items = new List<SourceItem> { new("movie", 1, null, null, "Movie 1", 2020, null, null, null) };
        Assert.Equal(200, (await h.Sources.LinkAsync(h.AccessFor(playlist, owner), new LinkSourceRequest { Url = "https://mdblist.com/lists/me/dc", SyncEnabled = true }, None)).StatusCode);
        return (h, playlist, editor);
    }

    // R6-3: DELETE /source waits for the list lock (a sync or swap pass may hold it); an editor whose share was removed
    // or made read-only meanwhile must not drop the link and its provenance.
    [Theory]
    [InlineData(false, 404)]
    [InlineData(true, 403)]
    public async Task AnUnlinkByAnEditorWhoLostTheirRightsKeepsTheLink(bool keepViewShare, int expected)
    {
        var (h, playlist, editor) = await LinkedSharedList();
        using var lease = h;
        var stale = h.AccessFor(playlist, editor);
        Assert.True(stale.Permissions.CanEdit);
        playlist.Info = playlist.Info with { Shares = keepViewShare ? new[] { new ListShare(editor.Id, false) } : Array.Empty<ListShare>() };

        var outcome = await h.Sources.UnlinkAsync(stale, "unlink-1", None);

        Assert.Equal(expected, outcome.StatusCode);
        Assert.NotNull(h.Store.Load(stale.ListIdN)!.Source);
    }

    // R6-4: "Sync now" waits up to SyncNowWait for the sync; a caller who lost view rights meanwhile gets no view (and
    // nothing is remembered for a replay).
    [Fact]
    public async Task SyncNowByAnEditorWhoLostTheListMeanwhileReturnsNoView()
    {
        var (h, playlist, editor) = await LinkedSharedList();
        using var lease = h;
        var stale = h.AccessFor(playlist, editor);
        h.Fetcher.OnFetch = () =>
        {
            playlist.Info = playlist.Info with { Shares = Array.Empty<ListShare>() };
            return Task.CompletedTask;
        };

        var outcome = await h.Sources.SyncNowAsync(stale, "sync-1", None);

        Error(outcome, 404, "not_found");
        Assert.Single(h.Store.Load(stale.ListIdN)!.Items); // the sync itself (run as the linker) still ran
        Assert.False(h.Store.TryGetReplay(stale.ListIdN + "-sync", "sync-1", stale.UserIdN, out _));

        // Read-only now: the caller still sees the list, so the result comes with their view.
        playlist.Info = playlist.Info with { Shares = new[] { new ListShare(editor.Id, false) } };
        h.Fetcher.OnFetch = null;
        var again = await h.Sources.SyncNowAsync(h.AccessFor(playlist, editor), "sync-2", None);
        Assert.NotNull(Ok<SourceSyncResultDto>(again).View);
    }

    // R6-5: two departing keys for the same episode (tvdb|… and tv|…) count as one trim; a later distinct episode that
    // left the source is still taken out of the run.
    [Fact]
    public void AliasKeysOfOneEpisodeTrimItOnceAndLaterEpisodesStillLeave()
    {
        var run = Ph("{\"kind\":\"episodes\",\"tmdbId\":123,\"seasonNumber\":1,\"title\":\"Show\",\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2},{\"s\":1,\"e\":3}]}");
        var doc = new ListDoc { Items = new List<Placeholder> { run }, Order = new List<string> { P(run.Id) }, Source = new ListSource { RemoveDropped = true } };
        foreach (var key in new[] { "tvdb|456|1|1", "tv|123|1|1", "tv|123|1|2", "tv|123|1|3" })
        {
            ListSourceProvenance.RecordAdded(doc.Source, key, run.Id, null);
        }

        doc.Source.LastSnapshotKeys = doc.Source.Owned.Keys.ToList();
        var plan = ListSourceProvenance.PlanDrops(doc, new[] { "tv|123|1|3" }, new Dictionary<string, int>());

        Assert.Equal(new[] { (run.Id, 1, 1), (run.Id, 1, 2) }, plan.Trims);
        Assert.Equal(2, ListSourceProvenance.ApplyDrops(doc, plan, Array.Empty<string>()));
        Assert.Equal(new[] { 3 }, Assert.Single(doc.Items).Episodes.Select(e => e.E));
        Assert.Equal(new[] { "tv|123|1|3" }, doc.Source.Owned.Keys);
    }

    // R6-2: the Season item a collection season's fills count through is replaced while the episodes keep their items
    // (episodes in the series root, the empty "Season 1" folder renamed): the new Season item goes in, and the fills
    // count through it from then on.
    [Fact]
    public async Task ACollectionSeasonWhoseSeasonItemAloneWasReplacedPutsTheNewSeasonItemIn()
    {
        using var h = new ListPlaceholdersHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":160,\"seasonNumber\":1,\"title\":\"Show S1\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        var series = h.Host.AddSeries(tmdb: 160);
        var episodes = Enumerable.Range(1, 3).Select(e => h.Host.AddEpisode(series, 1, e)).ToList();
        episodes.ForEach(h.Swap.NotifyItemChanged);
        await h.Swap.DrainAsync(None);
        var oldSeason = h.Host.Seasons[(series, 1)].Id;
        Assert.Equal(new[] { oldSeason }, h.Host.Resolved(collection.Info.Id));

        // "Season 1" -> "Season 01": a new path-based Season item; the old one is deleted and its link dangles.
        h.Host.Items.Remove(oldSeason);
        var newSeason = Guid.NewGuid();
        h.Host.Items[newSeason] = Jellyfin.Data.Enums.BaseItemKind.Season;
        h.Host.Seasons[(series, 1)] = (newSeason, false);
        var link = collection.Raw.FindIndex(r => r.ItemId == oldSeason);
        collection.Raw[link] = new RawEntry(oldSeason, false);
        h.Swap.NotifyItemChanged(newSeason);
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { newSeason }, h.Host.Resolved(collection.Info.Id));
        var stored = Stored(h, access.ListIdN, season.Id)!;
        Assert.Equal(episodes.Select(id => id.ToString("N")), stored.Filled.Select(f => f.ItemId));
        Assert.All(stored.Filled, f => Assert.Equal(newSeason.ToString("N"), f.Via));

        // Taken out of the collection by hand afterwards (the item still exists): it stays out.
        collection.Raw.RemoveAll(r => r.ItemId == newSeason);
        h.Swap.NotifyItemChanged(newSeason);
        await h.Swap.DrainAsync(None);
        Assert.Empty(h.Host.Resolved(collection.Info.Id));
    }

    private static Placeholder? Stored(ListPlaceholdersHarness h, string listIdN, string id) =>
        h.Store.Load(listIdN)!.Items.SingleOrDefault(p => p.Id == id);
}
