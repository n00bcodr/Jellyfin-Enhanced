using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

// The part of #936's ListSourceProvenance tests that list core keeps (ListSourceOwnership.OnSwapped: the swap-in hook).
// Keys are set up the way the sync's RecordAdded writes them (a key owning a placeholder); detecting removals,
// KeysToAdd, drop planning and AttachCovered belong to the source track and are not ported here.
public class ListsOwnershipTests
{
    private static string N(Guid id) => id.ToString("N");

    private static (ListDoc Doc, Placeholder Owned, Placeholder Present) Doc()
    {
        var owned = ListsHarness.Movie(1);
        owned.SourceKey = "movie|1||";
        var present = ListsHarness.Movie(2);
        present.SourceKey = "movie|2||";
        var doc = new ListDoc
        {
            Items = new List<Placeholder> { owned, present },
            Source = new ListSource { Url = "https://mdblist.com/lists/a/b", RemoveDropped = true, LastSnapshotKeys = new List<string> { "movie|1||", "movie|2||" } },
        };
        doc.Source.Owned["movie|1||"] = new SourceOwnership { PhId = owned.Id };
        return (doc, owned, present);
    }

    [Fact]
    public void SwapInMovesOwnershipToTheItemsAndOnlyForOwnedPlaceholders()
    {
        var (doc, owned, present) = Doc();
        var episode1 = Guid.NewGuid();
        var episode2 = Guid.NewGuid();

        // Partly filled (season placeholder still showing): items join, the placeholder stays owned.
        Assert.True(ListSourceOwnership.OnSwapped(doc, owned, new[] { N(episode1) }));
        Assert.Equal(owned.Id, doc.Source!.Owned["movie|1||"].PhId);
        Assert.Equal(new[] { N(episode1) }, doc.Source.Owned["movie|1||"].ItemIds);

        // Retired: the key now owns only the items; a repeated id isn't duplicated; dashed ids are normalised.
        doc.Items.Remove(owned);
        Assert.True(ListSourceOwnership.OnSwapped(doc, owned, new[] { episode1.ToString("D"), N(episode2) }));
        Assert.Null(doc.Source.Owned["movie|1||"].PhId);
        Assert.Equal(new[] { N(episode1), N(episode2) }, doc.Source.Owned["movie|1||"].ItemIds);

        // A placeholder that was only "present" (added by hand) stays unowned.
        Assert.False(ListSourceOwnership.OnSwapped(doc, present, new[] { N(Guid.NewGuid()) }));
        Assert.False(doc.Source.Owned.ContainsKey("movie|2||"));
        Assert.False(ListSourceOwnership.OnSwapped(new ListDoc(), owned, new[] { N(episode1) }));
    }

    [Fact]
    public void SwapInOfASharedPlaceholderMovesEveryOwnerToTheItems()
    {
        var (doc, owned, _) = Doc();
        doc.Source!.Owned["imdb|tt0000001||"] = new SourceOwnership { PhId = owned.Id };
        var item = Guid.NewGuid();
        doc.Items.Remove(owned);

        Assert.True(ListSourceOwnership.OnSwapped(doc, owned, new[] { N(item) }));

        foreach (var key in new[] { "movie|1||", "imdb|tt0000001||" })
        {
            Assert.Null(doc.Source.Owned[key].PhId);
            Assert.Equal(new[] { N(item) }, doc.Source.Owned[key].ItemIds);
        }

        // (#936 also checked DetectUserRemovals here: source track.)
    }

    [Fact]
    public void AFilledEpisodeGoesToItsOwnKeyAndToWiderScopesButNotToAnotherEpisodesKey()
    {
        var season = new Placeholder { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Season, MediaType = "tv", TmdbId = 9, Title = "Show", SeasonNumber = 1 };
        var doc = new ListDoc { Items = new List<Placeholder> { season }, Source = new ListSource { Url = "https://mdblist.com/lists/a/b" } };
        doc.Source.Owned["tv|9|1|"] = new SourceOwnership { PhId = season.Id };
        doc.Source.Owned["tv|9|1|1"] = new SourceOwnership { PhId = season.Id };
        var e2 = Guid.NewGuid();
        season.Filled.Add(new FilledEpisode { ItemId = N(e2), S = 1, E = 2 });

        Assert.True(ListSourceOwnership.OnSwapped(doc, season, new[] { N(e2) }));

        Assert.Equal(new[] { N(e2) }, doc.Source.Owned["tv|9|1|"].ItemIds);
        Assert.Empty(doc.Source.Owned["tv|9|1|1"].ItemIds);

        // The episode's own key takes its item once that episode is filled. (#936's AttachCovered part: source track.)
        var e1 = Guid.NewGuid();
        season.Filled.Add(new FilledEpisode { ItemId = N(e1), S = 1, E = 1 });
        Assert.True(ListSourceOwnership.OnSwapped(doc, season, new[] { N(e1) }));
        Assert.Equal(new[] { N(e1) }, doc.Source.Owned["tv|9|1|1"].ItemIds);
        Assert.Equal(new[] { N(e2), N(e1) }, doc.Source.Owned["tv|9|1|"].ItemIds);
    }
}
