using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;

namespace JE.Tests;

// The pure provenance rules of linked lists (F1–F2), incl. the swap-in hook the swap service calls.
public class ListPlaceholdersProvenanceTests
{
    private static readonly DateTime Now = new(2026, 10, 10, 12, 0, 0, DateTimeKind.Utc);

    private static string N(Guid id) => id.ToString("N");

    private static (ListDoc Doc, Placeholder Owned, Placeholder Present) Doc()
    {
        var owned = ListPlaceholdersHarness.Movie(1);
        owned.SourceKey = "movie|1||";
        var present = ListPlaceholdersHarness.Movie(2);
        present.SourceKey = "movie|2||";
        var doc = new ListDoc
        {
            Items = new List<Placeholder> { owned, present },
            Source = new ListSource { Url = "https://mdblist.com/lists/a/b", RemoveDropped = true, LastSnapshotKeys = new List<string> { "movie|1||", "movie|2||" } },
        };
        ListSourceProvenance.RecordAdded(doc.Source, "movie|1||", owned.Id, null);
        return (doc, owned, present);
    }

    [Fact]
    public void SwapInMovesOwnershipToTheItemsAndOnlyForOwnedPlaceholders()
    {
        var (doc, owned, present) = Doc();
        var episode1 = Guid.NewGuid();
        var episode2 = Guid.NewGuid();

        // Partly filled (season placeholder still showing): items join, the placeholder stays owned.
        Assert.True(ListSourceProvenance.OnSwapped(doc, owned, new[] { N(episode1) }));
        Assert.Equal(owned.Id, doc.Source!.Owned["movie|1||"].PhId);
        Assert.Equal(new[] { N(episode1) }, doc.Source.Owned["movie|1||"].ItemIds);

        // Retired: the key now owns only the items; a repeated id isn't duplicated; dashed ids are normalised.
        doc.Items.Remove(owned);
        Assert.True(ListSourceProvenance.OnSwapped(doc, owned, new[] { episode1.ToString("D"), N(episode2) }));
        Assert.Null(doc.Source.Owned["movie|1||"].PhId);
        Assert.Equal(new[] { N(episode1), N(episode2) }, doc.Source.Owned["movie|1||"].ItemIds);

        // A placeholder that was only "present" (added by hand) stays unowned.
        Assert.False(ListSourceProvenance.OnSwapped(doc, present, new[] { N(Guid.NewGuid()) }));
        Assert.False(doc.Source.Owned.ContainsKey("movie|2||"));
        Assert.False(ListSourceProvenance.OnSwapped(new ListDoc(), owned, new[] { N(episode1) }));
    }

    [Fact]
    public void EditorRemovalsAreTombstonedAndNeverReAdded()
    {
        var (doc, owned, _) = Doc();
        doc.Items.Remove(owned);
        Assert.Equal(1, ListSourceProvenance.DetectUserRemovals(doc, new Dictionary<string, int>(), Now));
        Assert.True(doc.Source!.UserRemovedKeys.ContainsKey("movie|1||"));
        Assert.False(doc.Source.Owned.ContainsKey("movie|1||"));
        Assert.Empty(ListSourceProvenance.KeysToAdd(doc.Source, new[] { "movie|1||", "movie|2||" }));

        // A real item the sync added and an editor removed natively counts the same.
        var item = Guid.NewGuid();
        ListSourceProvenance.RecordAdded(doc.Source, "movie|3||", null, N(item));
        Assert.Equal(0, ListSourceProvenance.DetectUserRemovals(doc, new Dictionary<string, int> { [N(item)] = 1 }, Now));
        Assert.Equal(1, ListSourceProvenance.DetectUserRemovals(doc, new Dictionary<string, int>(), Now));
        Assert.True(doc.Source.UserRemovedKeys.ContainsKey("movie|3||"));
    }

    [Fact]
    public void KeysToAddSkipsHandledOwnedAndTombstonedKeysAndKeepsSourceOrder()
    {
        var source = new ListSource { LastSnapshotKeys = new List<string> { "movie|1||" } };
        ListSourceProvenance.RecordAdded(source, "movie|2||", "ph", null);
        ListSourceProvenance.Decline(source, new[] { "movie|3||" }, Now);
        Assert.Equal(new[] { "tv|9|1|", "movie|4||" }, ListSourceProvenance.KeysToAdd(source, new[] { "tv|9|1|", "movie|1||", "movie|2||", "movie|3||", "movie|4||", "tv|9|1|" }));

        // Re-adding later (e.g. an editor adds it by hand) clears the tombstone.
        ListSourceProvenance.RecordAdded(source, "movie|3||", "ph3", null);
        Assert.False(source.UserRemovedKeys.ContainsKey("movie|3||"));
        // Declining an owned key does nothing.
        ListSourceProvenance.Decline(source, new[] { "movie|3||" }, Now);
        Assert.False(source.UserRemovedKeys.ContainsKey("movie|3||"));
    }

    [Fact]
    public void RemoveDroppedRemovesOwnedPlaceholdersAndSingleCopyOwnedItemsOnly()
    {
        var (doc, owned, present) = Doc();
        var single = Guid.NewGuid();
        var twice = Guid.NewGuid();
        ListSourceProvenance.RecordAdded(doc.Source!, "movie|5||", null, N(single));
        ListSourceProvenance.RecordAdded(doc.Source!, "movie|6||", null, N(twice));
        doc.Source!.LastSnapshotKeys.AddRange(new[] { "movie|5||", "movie|6||", "movie|7||" });
        var occurrences = new Dictionary<string, int> { [N(single)] = 1, [N(twice)] = 2 };

        // Everything left the source except movie|2 (present, not owned) and movie|7 (present, not owned, left too).
        var plan = ListSourceProvenance.PlanDrops(doc, new[] { "movie|2||" }, occurrences);
        Assert.Equal(new[] { owned.Id }, plan.PlaceholderIds);
        Assert.Equal(new[] { single }, plan.ItemIds);
        Assert.Equal(2, plan.Kept); // movie|7 (hand-added) + the twice-present item
        Assert.True(plan.Any);

        Assert.Equal(2, ListSourceProvenance.ApplyDrops(doc, plan, new[] { N(single) }));
        Assert.Equal(new[] { present.Id }, doc.Items.Select(p => p.Id));
        Assert.False(doc.Source.Owned.ContainsKey("movie|1||"));
        Assert.False(doc.Source.Owned.ContainsKey("movie|5||"));
        Assert.True(doc.Source.Owned.ContainsKey("movie|6||")); // kept: occurs twice
        Assert.Empty(doc.Source.UserRemovedKeys); // left the source ≠ removed by an editor: may come back

        // With removeDropped off nothing is planned, everything is reported as kept.
        var (doc2, _, _) = Doc();
        doc2.Source!.RemoveDropped = false;
        var off = ListSourceProvenance.PlanDrops(doc2, Array.Empty<string>(), new Dictionary<string, int>());
        Assert.False(off.Any);
        Assert.Equal(2, off.Kept);
    }

    [Fact]
    public void SharedOwnershipKeepsWhatAKeyStillInTheSourceOwnsAndReleasesItFromTheLeavingKey()
    {
        // Review round: "Show S1" and "Show S1E1" both own E1 (and two ids of one title share a placeholder).
        var (doc, owned, _) = Doc();
        var e1 = Guid.NewGuid();
        var e2 = Guid.NewGuid();
        var source = doc.Source!;
        ListSourceProvenance.RecordAdded(source, "tv|9|1|", null, N(e1));
        ListSourceProvenance.RecordAdded(source, "tv|9|1|", null, N(e2));
        ListSourceProvenance.RecordAdded(source, "tv|9|1|1", null, N(e1));
        ListSourceProvenance.RecordAdded(source, "imdb|tt0000001||", owned.Id, null);
        var occurrences = new Dictionary<string, int> { [N(e1)] = 1, [N(e2)] = 1 };

        // The season and the IMDb key leave; the episode and movie|1 stay.
        var plan = ListSourceProvenance.PlanDrops(doc, new[] { "tv|9|1|1", "movie|1||", "movie|2||" }, occurrences);
        Assert.Equal(new[] { e2 }, plan.ItemIds);
        Assert.Empty(plan.PlaceholderIds);
        Assert.Equal(0, plan.Kept);
        Assert.Equal(2, plan.Released.Count);

        Assert.Equal(1, ListSourceProvenance.ApplyDrops(doc, plan, new[] { N(e2) }));
        Assert.False(source.Owned.ContainsKey("tv|9|1|"));
        Assert.False(source.Owned.ContainsKey("imdb|tt0000001||"));
        Assert.Equal(new[] { N(e1) }, source.Owned["tv|9|1|1"].ItemIds);
        Assert.Contains(doc.Items, p => p.Id == owned.Id);
        Assert.Empty(source.UserRemovedKeys); // left the source: no tombstones

        // Now the last owner leaves too: the entry goes.
        var last = ListSourceProvenance.PlanDrops(doc, Array.Empty<string>(), new Dictionary<string, int> { [N(e1)] = 1 });
        Assert.Equal(new[] { e1 }, last.ItemIds);
        Assert.Equal(new[] { owned.Id }, last.PlaceholderIds);
    }

    [Fact]
    public void SwapInOfASharedPlaceholderMovesEveryOwnerToTheItems()
    {
        var (doc, owned, _) = Doc();
        ListSourceProvenance.RecordAdded(doc.Source!, "imdb|tt0000001||", owned.Id, null);
        var item = Guid.NewGuid();
        doc.Items.Remove(owned);

        Assert.True(ListSourceProvenance.OnSwapped(doc, owned, new[] { N(item) }));

        foreach (var key in new[] { "movie|1||", "imdb|tt0000001||" })
        {
            Assert.Null(doc.Source!.Owned[key].PhId);
            Assert.Equal(new[] { N(item) }, doc.Source.Owned[key].ItemIds);
        }

        // Neither is seen as removed by an editor while the item is in the list.
        Assert.Equal(0, ListSourceProvenance.DetectUserRemovals(doc, new Dictionary<string, int> { [N(item)] = 1 }, Now));
    }

    [Fact]
    public void TombstonesExpireAfterNinetyDaysAndAreCapped()
    {
        var source = new ListSource();
        source.UserRemovedKeys["movie|1||"] = Now.AddDays(-91).ToString("o");
        source.UserRemovedKeys["movie|2||"] = Now.AddDays(-89).ToString("o");
        source.UserRemovedKeys["movie|3||"] = "garbage";
        ListSourceProvenance.Prune(source, Now);
        Assert.Equal(new[] { "movie|2||" }, source.UserRemovedKeys.Keys);

        for (var i = 0; i < ListSourceProvenance.MaxUserRemovedKeys + 10; i++)
        {
            source.UserRemovedKeys[$"movie|{1000 + i}||"] = Now.AddMinutes(-i).ToString("o");
        }

        ListSourceProvenance.Prune(source, Now);
        Assert.Equal(ListSourceProvenance.MaxUserRemovedKeys, source.UserRemovedKeys.Count);
        Assert.True(source.UserRemovedKeys.ContainsKey("movie|1000||")); // newest kept
        Assert.False(source.UserRemovedKeys.ContainsKey("movie|2||")); // oldest dropped first
    }

    [Fact]
    public void OccurrencesCountResolvedEntriesOnly()
    {
        var a = Guid.NewGuid();
        var counts = ListSourceProvenance.Occurrences(new[] { new Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.RawEntry(a, true), new(a, true), new(Guid.NewGuid(), false) });
        Assert.Equal(new Dictionary<string, int> { [N(a)] = 2 }, counts);
    }
}
