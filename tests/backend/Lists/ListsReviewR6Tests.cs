using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 6: server-side fixes (rights checked again under the list lock for DELETE / reorder / unlink / sync now,
// collection seasons whose Season item was replaced, trims of aliased episode keys, Seerr season posters).
[Collection("Plugin singleton")]
public class ListsReviewR6Tests
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
        using var h = new ListsHarness();
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

    // Not ported here (source/sync track): R6-3 AnUnlinkByAnEditorWhoLostTheirRightsKeepsTheLink, R6-4
    // SyncNowByAnEditorWhoLostTheListMeanwhileReturnsNoView, R6-5 AliasKeysOfOneEpisodeTrimItOnceAndLaterEpisodesStillLeave.

    // R6-2: the Season item a collection season's fills count through is replaced while the episodes keep their items
    // (episodes in the series root, the empty "Season 1" folder renamed): the new Season item goes in, and the fills
    // count through it from then on.
    [Fact]
    public async Task ACollectionSeasonWhoseSeasonItemAloneWasReplacedPutsTheNewSeasonItemIn()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":160,\"seasonNumber\":1,\"title\":\"Show S1\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        await h.Consent(access); // D29: this list's editor turned automatic swap-in on
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

    private static Placeholder? Stored(ListsHarness h, string listIdN, string id) =>
        h.Store.Load(listIdN)!.Items.SingleOrDefault(p => p.Id == id);
}
