using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;

namespace JE.Tests;

/// <summary>
/// What a Ready playlist holds (C96, D44): through EditionAvailability per person, then the exact version's final check.
/// Edition (standard, 4K, a generic follow), Hidden Content, access to the exact version, virtual and placeholder items, a
/// version that no longer qualifies, a stable order however Jellyfin enumerates, dedupe of one version for several
/// interests while standard and 4K stay apart, a season in episode order, arrivals before the interest, watched, expiry
/// and an upgrade that neither duplicates nor restarts an entry's lifetime.
/// </summary>
public class ReadySelectorTests
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Tears = TitleKey.Parse("movie:tmdb:133701")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;
    private static readonly DateTime Arrived = ReadyWorld.Since.AddDays(2);

    private static ReadySelection Select(ReadyWorld w, StatusViewer viewer, IReadOnlyList<ReadyEntryRow>? rows = null, ReadyHides? hides = null)
        => w.Selector.Select(viewer, w.Interests.For(viewer.UserId)!, hides ?? ReadyHides.None, rows ?? Array.Empty<ReadyEntryRow>(), w.Now, 30);

    [Fact]
    public void AStandardRequestTakesTheExactStandardVersionAndAFourKRequestWaitsForA4kSource()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (item, versions) = w.Movie(Sintel, Arrived, null, (1920, 1080));
        w.Interests.Add(emma.UserId, "w:std", ReadyInterestKind.Request, Sintel);
        w.Interests.Add(emma.UserId, "w:4k", ReadyInterestKind.Request, Sintel, fourK: true);

        var first = Select(w, emma);
        Assert.Equal(new[] { versions[0] }, first.Desired);
        Assert.Equal("w:std", Assert.Single(first.Candidates).Interest.Id);

        // The 4K version arrives as a second version of the same item: the 4K request takes exactly it, the standard
        // request keeps the HD one, and both stay (distinct versions for distinct interests).
        var uhd = w.View.AddSource(item, 3840, 2160, "/media/sintel-2160p.mkv", Arrived.AddDays(1)).BackingItemId;
        var second = Select(w, emma);
        Assert.Equal(2, second.Desired.Count);
        Assert.Contains(versions[0], second.Desired);
        Assert.Contains(uhd, second.Desired);
        Assert.Equal(uhd, second.Candidates.Single(c => c.Interest.Id == "w:4k").PlayableItemId);
        Assert.All(second.Candidates, c => Assert.Equal(item, c.LogicalItemId));
    }

    [Fact]
    public void AnHdFileNeverSatisfiesAFourKRequestAndAnUnprobedFileNeitherWithTheStrictSwitch()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived, null, (1920, 1080), (null, null));
        w.Interests.Add(emma.UserId, "w:4k", ReadyInterestKind.Request, Sintel, fourK: true);
        Assert.Empty(Select(w, emma).Desired);

        w.Config.ArrStandardNeedsNonFourK = true;
        w.Interests.Of.Remove(emma.UserId);
        w.Interests.Add(emma.UserId, "w:std", ReadyInterestKind.Request, Tears);
        w.Movie(Tears, Arrived, null, (null, null));
        Assert.Empty(Select(w, emma).Desired);
    }

    [Fact]
    public void AGenericFollowPrefersAKnownStandardVersionThenFourK()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        // The provider lists 4K first, then an unprobed file, then HD.
        var (_, versions) = w.Movie(Sintel, Arrived, null, (3840, 2160), (null, null), (1920, 1080));
        w.Interests.Add(emma.UserId, "f:movie:tmdb:45745", ReadyInterestKind.Follow, Sintel, any: true);
        Assert.Equal(new[] { versions[2] }, Select(w, emma).Desired);

        // With the HD version gone the follow takes the 4K one (never the unprobed one first).
        w.View.SourcesByItem.Values.Single().RemoveAt(2);
        Assert.Equal(new[] { versions[0] }, Select(w, emma).Desired);
    }

    [Fact]
    public void TheChoiceIsTheSameHoweverJellyfinEnumeratesTheCopies()
    {
        using var a = new ReadyWorld();
        using var b = new ReadyWorld();
        var ea = a.User();
        var eb = b.View.AddUser(admin: false);
        // Two HD copies in two libraries (two logical items), added in opposite orders.
        var first = Guid.Parse("00000000-0000-0000-0000-0000000000a1");
        var second = Guid.Parse("00000000-0000-0000-0000-0000000000b2");
        foreach (var (world, order) in new[] { (a, new[] { first, second }), (b, new[] { second, first }) })
        {
            foreach (var id in order)
            {
                world.View.AddItem(new JfItemRef { ItemId = id, Kind = "movie", Key = Sintel, Path = "/m/" + id, DateCreated = Arrived });
                world.View.AddCopy(Sintel, new JfCopy { ItemId = id, Path = "/m/" + id, DateCreated = Arrived });
                world.View.AddSource(id, 1920, 1080, "/m/" + id + ".mkv", Arrived);
            }
        }

        a.Interests.Add(ea.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        b.Interests.Add(eb.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        Assert.Equal(new[] { first }, Select(a, ea).Desired);
        Assert.Equal(new[] { first }, Select(b, eb).Desired);
    }

    [Fact]
    public void AVersionThePersonCantOpenIsSkippedForTheNextEquivalentNeverTheLogicalItem()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var sam = w.User();
        // One item, two HD versions; the first version's own item is only open to Sam (a restricted backing item).
        var (item, versions) = w.Movie(Sintel, Arrived, null, (1920, 1080), (1280, 720));
        var preferred = versions.OrderBy(v => v.ToString("N"), StringComparer.Ordinal).First();
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        Assert.Equal(new[] { preferred }, Select(w, emma).Desired);
        w.Library.OpenTo[preferred] = new HashSet<Guid> { sam.UserId };
        Assert.Equal(versions.Where(v => v != preferred), Select(w, emma).Desired);

        // Neither version open: nothing at all (the logical item is never put in instead).
        foreach (var v in versions) w.Library.OpenTo[v] = new HashSet<Guid> { sam.UserId };
        Assert.Empty(Select(w, emma).Desired);
        Assert.DoesNotContain(item, Select(w, emma).Desired);
    }

    [Fact]
    public void ACopyInALibraryThePersonCantOpenNeverCounts()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var sam = w.User();
        w.Movie(Sintel, Arrived, new[] { sam.UserId }, (3840, 2160));
        w.Interests.Add(emma.UserId, "w:4k", ReadyInterestKind.Request, Sintel, fourK: true);
        Assert.Empty(Select(w, emma).Desired);
    }

    [Fact]
    public void VirtualEpisodesPlaceholdersAndNonInsertableItemsAreNeverChosen()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var series = w.Series(Firefly, Arrived);
        // A virtual (missing) episode: no file at all.
        var missing = Guid.NewGuid();
        w.View.AddItem(new JfItemRef { ItemId = missing, Kind = "episode", Key = Firefly.WithEpisode(1, 1), SeriesId = series, Season = 1, Episode = 1, Virtual = true });
        w.View.AddEpisode(series, new JfEpisode { ItemId = missing, Season = 1, Episode = 1, Virtual = true });
        var e2 = w.View.AddEpisodeFile(series, Firefly, 1, 2, 1920, 1080, Arrived);
        var e3 = w.View.AddEpisodeFile(series, Firefly, 1, 3, 1920, 1080, Arrived);
        w.Library.NotPhysical.Add(e2);      // a placeholder Jellyfin lists with a file
        w.Library.NotInsertable.Add(e3);    // e.g. an extra
        w.Interests.Add(emma.UserId, "w:s1", ReadyInterestKind.Request, Firefly, whole: false, seasons: new[] { 1 });
        var selection = Select(w, emma);
        Assert.Empty(selection.Desired);
        Assert.DoesNotContain(series, selection.Desired);
    }

    [Fact]
    public void ASeasonInsertsItsEpisodesInSeasonAndEpisodeOrderAndAnExactEpisodeOnlyItself()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var series = w.Series(Firefly, Arrived);
        var e3 = w.View.AddEpisodeFile(series, Firefly, 1, 3, 1920, 1080, Arrived);
        var e1 = w.View.AddEpisodeFile(series, Firefly, 1, 1, 1920, 1080, Arrived);
        var e2 = w.View.AddEpisodeFile(series, Firefly, 1, 2, 1920, 1080, Arrived);
        var s2e1 = w.View.AddEpisodeFile(series, Firefly, 2, 1, 1920, 1080, Arrived);
        w.Interests.Add(emma.UserId, "w:s1", ReadyInterestKind.Request, Firefly, whole: false, seasons: new[] { 1 });
        Assert.Equal(new[] { e1, e2, e3 }, Select(w, emma).Desired);
        Assert.All(Select(w, emma).Candidates, c => Assert.Equal(series, c.SeriesId));

        w.Interests.Of.Remove(emma.UserId);
        w.Interests.Add(emma.UserId, "w:e", ReadyInterestKind.Request, Firefly, whole: false, episodes: new[] { (2, 1) });
        Assert.Equal(new[] { s2e1 }, Select(w, emma).Desired);
    }

    [Fact]
    public void AMultiEpisodeFileIsHeldOnceForBothEpisodes()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var series = w.Series(Firefly, Arrived);
        var both = w.View.AddEpisodeFile(series, Firefly, 1, 1, 1920, 1080, Arrived, episodeEnd: 2);
        w.Interests.Add(emma.UserId, "w:e", ReadyInterestKind.Request, Firefly, whole: false, episodes: new[] { (1, 1), (1, 2) });
        Assert.Equal(new[] { both }, Select(w, emma).Desired);
    }

    [Fact]
    public void HiddenContentLeavesATitleOutAndAnUnhideBringsItBack()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (item, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        Assert.Empty(Select(w, emma, hides: new ReadyHides(new[] { item }, Array.Empty<Guid>(), Array.Empty<string>())).Desired);
        // A TMDB rule made on the absent title (D46) still hides it after it arrived.
        Assert.Empty(Select(w, emma, hides: new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { "movie:tmdb:45745" })).Desired);
        Assert.Equal(versions, Select(w, emma).Desired);

        var series = w.Series(Firefly, Arrived);
        var e1 = w.View.AddEpisodeFile(series, Firefly, 1, 1, 1920, 1080, Arrived);
        w.Interests.Add(emma.UserId, "w:s1", ReadyInterestKind.Request, Firefly, whole: false, seasons: new[] { 1 });
        Assert.DoesNotContain(e1, Select(w, emma, hides: new ReadyHides(Array.Empty<Guid>(), new[] { series }, Array.Empty<string>())).Desired);
    }

    [Fact]
    public void OneVersionForSeveralInterestsIsHeldOnce()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived, null, (3840, 2160));
        // A standard request (any copy), a 4K request, a follow and an imported list want: one 4K-only file.
        w.Interests.Add(emma.UserId, "w:std", ReadyInterestKind.Request, Sintel);
        w.Interests.Add(emma.UserId, "w:4k", ReadyInterestKind.Request, Sintel, fourK: true);
        w.Interests.Add(emma.UserId, "f:movie:tmdb:45745", ReadyInterestKind.Follow, Sintel, any: true);
        w.Interests.Add(emma.UserId, "w:list", ReadyInterestKind.Request, Sintel);
        var selection = Select(w, emma);
        Assert.Equal(versions, selection.Desired);
        Assert.Equal(4, selection.Candidates.Count);
        Assert.Equal(4, selection.Rows.Count);
    }

    [Fact]
    public void SomeoneElsesInterestNeverBecomesAnEntry()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var sam = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(sam.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        Assert.Empty(w.Selector.Select(emma, w.Interests.For(sam.UserId)!, ReadyHides.None, Array.Empty<ReadyEntryRow>(), w.Now, 30).Desired);
        Assert.Throws<ArgumentException>(() => w.Selector.Select(StatusViewer.Library, w.Interests.For(sam.UserId)!, ReadyHides.None, Array.Empty<ReadyEntryRow>(), w.Now, 30));
    }

    [Fact]
    public void ContentThatArrivedBeforeTheInterestIsNotReadyForIt()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var series = w.Series(Firefly, ReadyWorld.Since.AddDays(-100));
        w.View.AddEpisodeFile(series, Firefly, 1, 1, 1920, 1080, ReadyWorld.Since.AddDays(-100));
        var fresh = w.View.AddEpisodeFile(series, Firefly, 1, 2, 1920, 1080, Arrived);
        // A follow made today doesn't dump the old backlog; the episode that arrived after it is in.
        w.Interests.Add(emma.UserId, "f:tv:tvdb:78874", ReadyInterestKind.Follow, Firefly, any: true);
        Assert.Equal(new[] { fresh }, Select(w, emma).Desired);
    }

    [Fact]
    public void WatchedAndExpiredEntriesLeaveForGoodForThatInterest()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (item, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        var first = Select(w, emma);
        Assert.Equal(versions, first.Desired);

        w.Library.Watched.Add((emma.UserId, item));
        var watched = Select(w, emma, first.Rows);
        Assert.Empty(watched.Desired);
        Assert.Equal(ReadyDisposition.Watched, Assert.Single(watched.Rows).Disposition);

        // Marked unplayed (or upgraded) later: the watched row keeps it out without a new interest.
        w.Library.Watched.Clear();
        Assert.Empty(Select(w, emma, watched.Rows).Desired);

        // A new interest (a new request) brings it back.
        w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Sintel, since: Arrived.AddDays(-1));
        Assert.Equal(versions, Select(w, emma, watched.Rows).Desired);

        // Expiry: 30 days after it became ready.
        using var x = new ReadyWorld();
        var sam = x.User();
        var (_, v2) = x.Movie(Tears, Arrived);
        x.Interests.Add(sam.UserId, "w:1", ReadyInterestKind.Request, Tears);
        x.Now = new DateTimeOffset(Arrived.AddDays(31));
        var expired = Select(x, sam);
        Assert.Empty(expired.Desired);
        Assert.Equal(ReadyDisposition.Expired, Assert.Single(expired.Rows).Disposition);
        _ = v2;
    }

    [Fact]
    public void AnUpgradeSwapsTheVersionWithoutADuplicateOrANewLifetime()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (item, versions) = w.Movie(Sintel, Arrived, null, (1920, 1080));
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        var first = Select(w, emma);
        var row = Assert.Single(first.Rows);

        // Radarr replaced the HD file with a 4K one: the HD version is gone, the 4K one arrived today.
        var list = w.View.SourcesByItem[item];
        list.Clear();
        var uhd = w.View.AddSource(item, 3840, 2160, "/media/sintel-2160p.mkv", Arrived.AddDays(10)).BackingItemId;
        var after = Select(w, emma, first.Rows);
        Assert.Equal(new[] { uhd }, after.Desired);
        var updated = Assert.Single(after.Rows);
        Assert.Equal(row.ReadyAt, updated.ReadyAt);
        Assert.Equal(row.ExpiresAt, updated.ExpiresAt);
        _ = versions;
    }

    [Fact]
    public void AnInterestThatWentAwayHasItsRowsRemoved()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        var rows = Select(w, emma).Rows;
        w.Interests.Of.Remove(emma.UserId);
        var after = Select(w, emma, rows);
        Assert.Empty(after.Desired);
        Assert.Equal(new[] { ("w:1", "m") }, after.Removed);
    }

    // ------------------------------------------------------------------ 4f review round 1 (behaviour-2)

    // Two accessible copies of one movie (two libraries), the same standard fit: which ranks first is by version id.
    private static (Guid FirstItem, Guid FirstVersion, Guid SecondItem, Guid SecondVersion) TwoCopies(ReadyWorld w)
    {
        var (a, av) = w.Movie(Sintel, Arrived);
        var (b, bv) = w.Movie(Sintel, Arrived);
        return string.CompareOrdinal(ReadyPlaylistStore.Id(av[0]), ReadyPlaylistStore.Id(bv[0])) < 0 ? (a, av[0], b, bv[0]) : (b, bv[0], a, av[0]);
    }

    [Fact]
    public void ARuleOnOneCopyLetsTheOtherCopyThrough()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (firstItem, firstVersion, _, secondVersion) = TwoCopies(w);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        Assert.Equal(new[] { firstVersion }, Select(w, emma).Desired);
        // The copy's own item hidden (as a library card of that copy), or that exact version.
        Assert.Equal(new[] { secondVersion }, Select(w, emma, hides: new ReadyHides(new[] { firstItem }, Array.Empty<Guid>(), Array.Empty<string>())).Desired);
        Assert.Equal(new[] { secondVersion }, Select(w, emma, hides: new ReadyHides(new[] { firstVersion }, Array.Empty<Guid>(), Array.Empty<string>())).Desired);
    }

    [Theory]
    [InlineData("tmdb")]
    [InlineData("movie_rule")]
    public void ATitleLevelRuleHidesEveryCopy(string rule)
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (firstItem, _, _, _) = TwoCopies(w);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        var doc = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent();
        doc.Settings.Enabled = true;
        doc.Settings.FilterLibrary = true;
        doc.Items[rule] = rule == "tmdb"
            ? new Jellyfin.Plugin.JellyfinEnhanced.Configuration.HiddenContentItem { ItemId = "", Type = "Movie", TmdbId = "45745" }
            // A movie's own card hidden (Hidden Content keys a movie rule to the title: every copy, D46).
            : new Jellyfin.Plugin.JellyfinEnhanced.Configuration.HiddenContentItem { ItemId = firstItem.ToString("N"), Type = "Movie" };
        Assert.Empty(Select(w, emma, hides: JellyfinReadyPrivacy.From(doc)).Desired);
    }

    [Fact]
    public void AnEpisodeRuleOnOneCopyLetsTheOtherSeriesCopyThrough()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var hd = w.Series(Firefly, Arrived);
        var other = w.Series(Firefly, Arrived);
        var e1 = w.View.AddEpisodeFile(hd, Firefly, 1, 1, 1920, 1080, Arrived);
        var e1b = w.View.AddEpisodeFile(other, Firefly, 1, 1, 1920, 1080, Arrived);
        w.Interests.Add(emma.UserId, "w:s1", ReadyInterestKind.Request, Firefly, whole: false, seasons: new[] { 1 });
        var chosen = Assert.Single(Select(w, emma).Desired);
        var hiddenCopy = chosen;
        var otherCopy = chosen == e1 ? e1b : e1;
        var doc = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent();
        doc.Settings.Enabled = true;
        doc.Settings.FilterLibrary = true;
        doc.Items["ep"] = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.HiddenContentItem { ItemId = hiddenCopy.ToString("N"), Type = "Episode" };
        Assert.Equal(new[] { otherCopy }, Select(w, emma, hides: JellyfinReadyPrivacy.From(doc)).Desired);
    }

    // 4f round 2b (found live on 12.2): a series rule made on one physical copy (another library) hides the title, also for
    // an episode only the other copy has, in the selection and at the last check before the membership write.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ASeriesRuleOnAnotherCopyHidesEpisodesOnlyTheOtherCopyHas(bool atTheWrite)
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var copyA = w.Series(Firefly, Arrived);
        var copyB = w.Series(Firefly, Arrived);
        var e2 = w.View.AddEpisodeFile(copyB, Firefly, 1, 2, 1920, 1080, Arrived);
        w.Interests.Add(emma.UserId, "w:f", ReadyInterestKind.Follow, Firefly);
        var rule = new ReadyHides(new[] { copyA }, new[] { copyA }, Array.Empty<string>(), new[] { copyA });
        var open = Select(w, emma);
        Assert.Equal(new[] { e2 }, open.Desired);
        if (atTheWrite) Assert.False(w.Selector.StillChosen(emma.UserId, rule, Assert.Single(open.Candidates)));
        else Assert.Empty(Select(w, emma, hides: rule).Desired);
    }
}
