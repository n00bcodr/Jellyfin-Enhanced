using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// POST /resolve's resolver (design §7, E1–E5, C5) against an in-memory Seerr: search order, year rules, season/episode
// verification, confidence, retries, transient/partial results, alternatives, TBA, explicit ids, library, parental.
[Collection("Plugin singleton")]
public class ListPlaceholdersImportResolverTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static ImportEntryDto E(string title, int? year = null, string? type = null, int? season = null, string? status = null, params (int S, int E)[] episodes) => new()
    {
        Title = title,
        Year = year,
        TypeHint = type,
        Season = season,
        Status = status,
        Episodes = episodes.Length == 0 ? null : episodes.Select(e => new ImportEpisodeDto { S = e.S, E = e.E }).ToList(),
    };

    private static async Task<ResolveResponse> Resolve(ListPlaceholdersHarness h, User user, ImportEntryDto[] entries, TimeSpan? deadline = null, IReadOnlyList<User>? libraryUsers = null) =>
        (await h.ImportResolver.ResolveAsync(entries, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = libraryUsers ?? new[] { user },
            Context = new ImportCallContext("test", false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(5),
            Deadline = deadline ?? TimeSpan.FromSeconds(20),
        }, None)).Response;

    private static List<string> Searches(ListPlaceholdersHarness h) => h.Lookup.Log.Where(l => l.StartsWith("search:", StringComparison.Ordinal)).ToList();

    [Fact]
    public async Task TheYearSeparatesSameNamedFilmsAndUndatedStubsLose()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Suicide Squad", Movie(297761, "Suicide Squad", "2016-08-03", 20000), Movie(436969, "The Suicide Squad", "2021-07-28", 9000));
        h.Lookup.AddSearch("The Suicide Squad", Movie(436969, "The Suicide Squad", "2021-07-28", 9000), Movie(297761, "Suicide Squad", "2016-08-03", 20000));
        h.Lookup.AddSearch("Birds of Prey", Movie(1125037, "Birds of Prey", null, 0), Movie(495764, "Birds of Prey (and the Fantabulous Emancipation of One Harley Quinn)", "2020-02-05", 10000), Tv(1469, "Birds of Prey", "2002-10-09", 300));

        var response = await Resolve(h, user, new[] { E("Suicide Squad", 2016, "movie"), E("The Suicide Squad", 2021, "movie"), E("Birds of Prey", 2020, "movie") });

        Assert.True(response.Complete);
        Assert.Equal((297761, "high"), (response.Results[0].Match!.TmdbId, response.Results[0].Confidence));
        Assert.Equal((436969, "high"), (response.Results[1].Match!.TmdbId, response.Results[1].Confidence));
        Assert.Equal(495764, response.Results[2].Match!.TmdbId);
        Assert.Equal("medium", response.Results[2].Confidence); // a prefix match is never auto-accepted
        Assert.DoesNotContain(response.Results[2].Candidates, c => c.MediaType == "tv"); // type filter
    }

    [Fact]
    public async Task PlainSearchComesFirstAndTheYearPassOnlyRunsWhenItDidntSettleIt()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Superman", Movie(1061474, "Superman", "2025-07-09", 3000), Movie(1924, "Superman", "1978-12-14", 4000));
        h.Lookup.AddSearch("Clayface", Movie(17111, "Clayface", "1994-01-01", 3));
        h.Lookup.AddSearch("Clayface year:2026", Movie(1400940, "Clayface", "2026-10-21", 10));

        var response = await Resolve(h, user, new[] { E("Superman", 2025, "movie"), E("Clayface", 2026, "movie") });

        Assert.Equal(1061474, response.Results[0].Match!.TmdbId);
        Assert.Equal("high", response.Results[0].Confidence);
        Assert.Equal(1400940, response.Results[1].Match!.TmdbId);
        Assert.Equal("high", response.Results[1].Confidence);
        var searches = Searches(h);
        Assert.Contains("search:Superman", searches);
        Assert.DoesNotContain("search:Superman year:2025", searches);
        Assert.Contains("search:Clayface", searches);
        Assert.Contains("search:Clayface year:2026", searches);
        Assert.True(searches.IndexOf("search:Clayface") < searches.IndexOf("search:Clayface year:2026"));
    }

    [Fact]
    public async Task SeasonLinesNeverUseYearAndAreCheckedAgainstTheSeasonsAirYear()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var peacemaker = Tv(110492, "Peacemaker", "2022-01-13", 3500);
        var other = Tv(108886, "Peacemaker", "2020-03-01", 20);
        h.Lookup.AddSearch("Peacemaker", peacemaker, other);
        h.Lookup.AddShow(peacemaker, new SeasonFacts(1, 8, "2022-01-13", "Season 1"), new SeasonFacts(2, 8, "2025-08-21", "Season 2"));
        h.Lookup.AddShow(other, new SeasonFacts(1, 6, "2020-03-01", "Season 1"));

        var response = await Resolve(h, user, new[] { E("Peacemaker", 2025, "tv", season: 2), E("Peacemaker", 2022, "tv", season: 1) });

        var s2 = response.Results[0];
        Assert.Equal("season", s2.Kind);
        Assert.Equal((110492, "high"), (s2.Match!.TmdbId, s2.Confidence));
        Assert.Equal(2, s2.Match.Season!.SeasonNumber);
        Assert.Equal(8, s2.Match.Season.EpisodeCount);
        Assert.Equal(8, s2.Match.EpisodeTotal);
        Assert.Equal("2025-08-21", s2.Match.Season.AirDate);
        Assert.Equal(110492, response.Results[1].Match!.TmdbId);
        Assert.DoesNotContain(Searches(h), s => s.Contains("year:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task EpisodesUseTheEpisodesAirYearAndMissingEpisodesGoToReview()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var flash = Tv(60735, "The Flash", "2014-10-07", 12000);
        var old = Tv(236, "The Flash", "1990-09-20", 400);
        h.Lookup.AddSearch("Flash", flash, old);
        h.Lookup.AddShow(flash, new SeasonFacts(1, 23, "2014-10-07", "Season 1"), new SeasonFacts(8, 20, "2021-11-16", "Season 8"));
        h.Lookup.AddShow(old, new SeasonFacts(1, 22, "1990-09-20", "Season 1"));
        h.Lookup.Seasons[(60735, 1)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(1, e, "Ep " + e, e == 8 ? "2014-12-02" : "2014-11-01")).ToList();
        h.Lookup.Seasons[(236, 1)] = Enumerable.Range(1, 22).Select(e => new EpisodeFacts(1, e, "Old " + e, "1990-11-01")).ToList();
        h.Lookup.Seasons[(60735, 8)] = Enumerable.Range(1, 3).Select(e => new EpisodeFacts(8, e, "Armageddon " + e, "2021-11-16")).ToList();

        var response = await Resolve(h, user, new[] { E("Flash", 2014, null, null, null, (1, 8)), E("Flash", 2021, null, null, null, (8, 1), (8, 2), (8, 3), (8, 4), (8, 5)) });

        var crossover = response.Results[0];
        Assert.Equal("episodes", crossover.Kind);
        Assert.Equal((60735, "high"), (crossover.Match!.TmdbId, crossover.Confidence));
        var episode = Assert.Single(crossover.Match.Episodes!);
        Assert.Equal((1, 8, "Ep 8", "2014-12-02"), (episode.S, episode.E, episode.Title, episode.AirDate));

        var armageddon = response.Results[1];
        Assert.Equal(60735, armageddon.Match!.TmdbId);
        Assert.Equal("low", armageddon.Confidence);
        Assert.Contains("episodeMissing", armageddon.Reasons);
        Assert.Equal(3, armageddon.Match.Episodes!.Count);
    }

    [Fact]
    public async Task AnEmptySearchIsRetriedOnceAndNeverBelievedTheFirstTime()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Black Adam", Movie(436270, "Black Adam", "2022-10-19", 8000));
        h.Lookup.AddSearch("Nothing", Array.Empty<Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import.TitleHit>());
        h.Lookup.EmptyFirst("Black Adam");

        var response = await Resolve(h, user, new[] { E("Black Adam", 2022, "movie"), E("Nothing", null, "movie") });

        Assert.Equal(436270, response.Results[0].Match!.TmdbId);
        Assert.Equal(2, Searches(h).Count(s => s == "search:Black Adam"));
        Assert.Equal("none", response.Results[1].Confidence);
        Assert.Contains("noMatch", response.Results[1].Reasons);
        Assert.Equal(2, Searches(h).Count(s => s == "search:Nothing")); // one retry, no more
    }

    [Fact]
    public async Task TransientLookupsAndTheDeadlineGivePartialResults()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Aquaman", Movie(297802, "Aquaman", "2018-12-07"));
        h.Lookup.TransientQueries.Add("Aquaman");
        var response = await Resolve(h, user, new[] { E("Aquaman", 2018, "movie") });
        Assert.Equal("transient", response.Results[0].State);
        Assert.False(response.Complete);

        h.Lookup.TransientQueries.Clear();
        h.Lookup.Delay = TimeSpan.FromSeconds(5);
        var slow = await Resolve(h, user, new[] { E("Aquaman", 2018, "movie") }, deadline: TimeSpan.FromMilliseconds(100));
        Assert.Equal("transient", slow.Results[0].State);
        Assert.False(slow.Complete);
    }

    [Fact]
    public async Task AlternativesResolveEveryChoiceAndAlwaysGoToReview()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Justice League", Movie(141052, "Justice League", "2017-11-15", 13000), Tv(2954, "Justice League", "2001-11-17", 900));
        h.Lookup.AddSearch("Zack Snyder's Justice League", Movie(791373, "Zack Snyder's Justice League", "2021-03-18", 9000));
        var entry = E("Justice League", 2017);
        entry.Alternatives = new List<ImportAlternativeDto>
        {
            new() { Title = "Justice League", Year = 2017 },
            new() { Title = "Zack Snyder's Justice League", Year = 2021 },
        };

        var result = (await Resolve(h, user, new[] { entry })).Results[0];

        Assert.True(result.Alternatives);
        Assert.Equal("low", result.Confidence);
        Assert.Contains("alternatives", result.Reasons);
        Assert.Equal(new[] { (141052, 0), (791373, 1) }, result.Candidates.Take(2).Select(c => (c.TmdbId, c.Alternative!.Value)));
        Assert.Equal(141052, result.Match!.TmdbId);
    }

    [Fact]
    public async Task TbaLinesPreferUndatedTitlesAndOnlyAnExactUndatedOneIsALikelyMatch()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Swamp Thing", Movie(17918, "Swamp Thing", "1982-02-19", 600), Movie(999001, "Swamp Thing", null, 0));
        h.Lookup.AddSearch("Mister Miracle", Tv(293696, "Mister Miracle", null, 0));
        h.Lookup.AddSearch("Wonder Woman", Movie(297762, "Wonder Woman", "2017-05-30", 20000), Movie(1495964, "Untitled Wonder Woman Film", null, 0));
        h.Lookup.AddSearch("Paradise Lost", Tv(96195, "Paradise Lost", null, 5), Tv(21950, "Paradise Lost", null, 5));

        var response = await Resolve(h, user, new[]
        {
            E("Swamp Thing", null, "movie", status: "tba"), E("Mister Miracle", null, "tv", status: "tba"),
            E("Wonder Woman", null, "movie", status: "tba"), E("Paradise Lost", null, "tv", status: "tba"),
        });

        // An announced title: TMDB's exact, undated entry is pre-selected as a likely match ("unreleased"), not "tba".
        Assert.Equal((999001, "medium"), (response.Results[0].Match!.TmdbId, response.Results[0].Confidence));
        Assert.Equal(new[] { "unreleased" }, response.Results[0].Reasons);
        Assert.Equal((293696, "medium"), (response.Results[1].Match!.TmdbId, response.Results[1].Confidence));
        // Only an old release with that title (and an inexact undated one): never more than low, and the client keeps the line.
        Assert.Equal((297762, "low"), (response.Results[2].Match!.TmdbId, response.Results[2].Confidence));
        Assert.Contains("tba", response.Results[2].Reasons);
        // Two exact undated titles: a tie to review.
        Assert.Equal("low", response.Results[3].Confidence);
        Assert.Contains("tie", response.Results[3].Reasons);
    }

    [Fact]
    public async Task AnExactTitleWithTheLinesYearStaysSureNextToANamesakeAYearOff()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        // The DC guide's "The Flash (2023)": TMDB also has a 2022 "The Flash" (s 130 vs 166 = margin 36 < 40).
        h.Lookup.AddSearch("The Flash", Movie(298618, "The Flash", "2023-06-13", 5000, 40), Movie(1401184, "The Flash", "2022-01-01", 0, 0), Movie(1155289, "The Flash: Saga of the Scarlet Speedster", "2023-05-01", 0, 1));
        h.Lookup.AddSearch("Joker", Movie(475557, "Joker", "2019-10-01", 26000, 50), Movie(999002, "Joker", "2019-03-01", 3, 1));

        var response = await Resolve(h, user, new[] { E("The Flash", 2023, "movie"), E("Joker", 2019, "movie") });

        Assert.Equal((298618, "high"), (response.Results[0].Match!.TmdbId, response.Results[0].Confidence));
        // Another exact title from the same year still counts: not sure (only an obscure one, so one click: medium).
        Assert.Equal("medium", response.Results[1].Confidence);
        Assert.Contains("closeMatch", response.Results[1].Reasons);
    }

    [Fact]
    public async Task EveryLikelyOrUnsureMatchSaysWhy()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("The Death of Superman", Movie(487670, "The Death of Superman", "2019-07-23", 700, 10));
        h.Lookup.AddSearch("Super Friends", Tv(936, "Super Friends", "1973-09-08", 164, 30));
        h.Lookup.AddSearch("Birds of Prey", Movie(495764, "Birds of Prey (and the Fantabulous Emancipation of One Harley Quinn)", "2020-02-05", 10000, 30));
        h.Lookup.AddSearch("Batman: Knightfall Part 3: KnightsEnd", Movie(1389764, "Batman: Knightfall Part 3: KnightsEnd", null, 0, 0));
        h.Lookup.AddSearch("Clayface", Movie(1400940, "Clayface", "2026-10-21", 10, 5));

        var response = await Resolve(h, user, new[]
        {
            E("The Death of Superman", 2018, "movie"), E("Super Friends", 1980, "tv"), E("Birds of Prey", 2020, "movie"),
            E("Batman: Knightfall Part 3: KnightsEnd", 2027, "movie", status: "scheduled"), E("Clayface", null, "movie"),
        });

        var why = response.Results.Select(r => r.Confidence + ":" + string.Join('+', r.Reasons)).ToList();
        // Exact title, TMDB has no date yet and the line says it isn't out (KnightsEnd): a likely match, not "Weak title match".
        Assert.Equal(new[] { "medium:yearOff", "low:otherYear", "medium:lowScore", "medium:unreleased", "medium:noYear" }, why);
    }

    [Fact]
    public async Task AnAnnouncedSeasonOfAKnownShowIsALikelyMatch()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var show = Tv(219543, "Creature Commandos", "2024-12-05", 396, 22);
        h.Lookup.AddSearch("Creature Commandos", show);
        h.Lookup.AddShow(show, new SeasonFacts(1, 7, "2024-12-05", "Season 1"), new SeasonFacts(2, 1, null, "Season 2"));

        var response = await Resolve(h, user, new[] { E("Creature Commandos", null, "tv", season: 2, status: "tba") });

        // The show started in 2024, but the TBA line is about season 2, which has no date: not an "old release".
        var result = response.Results[0];
        Assert.Equal(("medium", 2), (result.Confidence, result.Match!.Season!.SeasonNumber));
        Assert.Equal(new[] { "unreleased" }, result.Reasons);
    }

    [Fact]
    public async Task ATitleTheSearchCantFindIsRetriedWithVariantsThatKeepOnlyResemblingTitles()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        // TMDB wants every word: "Star Crossed" never finds "Starcrossed", but the last word is matched as a prefix.
        h.Lookup.AddSearch("Justice League", Tv(1618, "Justice League", "2001-11-17", 600, 20), Movie(141052, "Justice League", "2017-11-15", 14000, 30));
        h.Lookup.AddSearch("Justice League: Star", Movie(268899, "Justice League: Starcrossed - The Movie", "2004-07-13", 125, 3));
        h.Lookup.AddSearch("The Kid Hour With Shazam!", Tv(11093, "The Kid Super Power Hour with Shazam!", "1981-09-12", 7, 2));
        h.Lookup.AddSearch("The New", Tv(1424, "Orange Is the New Black", "2013-07-11", 4000, 40));

        var response = await Resolve(h, user, new[]
        {
            E("Justice League: Star Crossed", 2004), E("The Kid Superpower Hour With Shazam!", 1981), E("The New Shazam!", 1981, "tv"),
        });

        Assert.Equal((268899, "medium"), (response.Results[0].Match!.TmdbId, response.Results[0].Confidence));
        Assert.Equal((11093, "high"), (response.Results[1].Match!.TmdbId, response.Results[1].Confidence));
        // Shorter queries find unrelated titles: those are never offered.
        Assert.Equal("none", response.Results[2].Confidence);
        Assert.Empty(response.Results[2].Candidates);
        var searches = Searches(h);
        Assert.True(searches.IndexOf("search:Justice League") < searches.IndexOf("search:Justice League: Star"));
        Assert.DoesNotContain("search:League: Star Crossed", searches); // stops once a likely match is found
    }

    [Fact]
    public async Task ExplicitIdsSkipTitleSearch()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var got = Tv(1399, "Game of Thrones", "2011-04-17");
        h.Lookup.AddShow(got, new SeasonFacts(1, 10, "2011-04-17", "Season 1"));
        h.Lookup.Details[("movie", 1924)] = new TitleDetails(Movie(1924, "Superman", "1978-12-14"), "tt0078346", null, "Released", null, Array.Empty<SeasonFacts>());
        h.Lookup.Details[("tv", 1924)] = new TitleDetails(Tv(1924, "Survival of the Richest", "2010-01-01"), null, null, "Ended", false, Array.Empty<SeasonFacts>());
        var bb = Tv(1396, "Breaking Bad", "2008-01-20");
        h.Lookup.AddShow(bb, new SeasonFacts(1, 7, "2008-01-20", "Season 1"));
        h.Lookup.Seasons[(1396, 1)] = new List<EpisodeFacts> { new(1, 1, "Pilot", "2008-01-20") };
        h.Lookup.ImdbEpisodes["tt0959621"] = new ImdbEpisodeFind(1396, 1, 1, "Pilot", "2008-01-20");

        var typed = new ImportEntryDto { Ids = new ImportIdsDto { Tmdb = 1399, TmdbType = "tv" }, Season = 1 };
        var untyped = new ImportEntryDto { Ids = new ImportIdsDto { Tmdb = 1924 } };
        var episodeId = new ImportEntryDto { Title = "Pilot", TypeHint = "tv", Ids = new ImportIdsDto { Imdb = "tt0959621" }, ImdbEpisode = true };

        h.Lookup.CanFindImdbEpisodes = false;
        var without = (await Resolve(h, user, new[] { episodeId })).Results[0];
        Assert.Contains("episodeIdUnsupported", without.Reasons);

        h.Lookup.CanFindImdbEpisodes = true;
        var response = await Resolve(h, user, new[] { typed, untyped, episodeId });
        Assert.Equal(("season", 1399, "high"), (response.Results[0].Kind, response.Results[0].Match!.TmdbId, response.Results[0].Confidence));
        Assert.Equal(10, response.Results[0].Match!.Season!.EpisodeCount);
        Assert.Equal("low", response.Results[1].Confidence); // tmdb:1924 is a movie AND a show
        Assert.Contains("tie", response.Results[1].Reasons);
        Assert.Equal(2, response.Results[1].Candidates.Count);
        var episode = response.Results[2];
        Assert.Equal(("episodes", 1396, "high"), (episode.Kind, episode.Match!.TmdbId, episode.Confidence));
        Assert.Equal((1, 1), (episode.Match.Episodes![0].S, episode.Match.Episodes[0].E));
        Assert.DoesNotContain(Searches(h), s => s == "search:Pilot");
    }

    [Fact]
    public async Task AWrongTypeEverywhereIsOfferedForReviewOnly()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Waller", Movie(272877, "Waller's Last Trip", "1989-01-01", 2));
        h.Lookup.AddSearch("The Flash", Tv(60735, "The Flash", "2014-10-07", 12000), Movie(298618, "The Flash", "2023-06-13", 6000));

        var response = await Resolve(h, user, new[] { E("Waller", null, "tv"), E("The Flash", 2023, "movie") });

        Assert.Contains("typeMismatch", response.Results[0].Reasons);
        Assert.Equal("low", response.Results[0].Confidence);
        Assert.Equal((298618, "high"), (response.Results[1].Match!.TmdbId, response.Results[1].Confidence));
        Assert.All(response.Results[1].Candidates, c => Assert.Equal("movie", c.MediaType));
    }

    [Fact]
    public async Task LibraryMatchesAreLookedUpForEveryCandidateAsEveryLibraryUser()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var owner = h.NewUser("owner");
        h.Lookup.AddSearch("Toy Story", Movie(862, "Toy Story", "1995-11-22", 18000), Movie(213121, "Toy Story of Terror!", "2013-10-16", 900));
        var got = Tv(1399, "Game of Thrones", "2011-04-17", 25000);
        h.Lookup.AddSearch("Game of Thrones", got);
        h.Lookup.AddShow(got, new SeasonFacts(1, 10, "2011-04-17", "Season 1"));
        var movieItem = Guid.NewGuid();
        var seasonItem = Guid.NewGuid();
        h.Library.Matches[("movie", 862)] = new LibraryMatch(movieItem, "movie", Array.Empty<Guid>(), true);
        h.Library.Matches[("season", 1399)] = new LibraryMatch(seasonItem, "season", new[] { Guid.NewGuid() }, false);

        var response = await Resolve(h, user, new[] { E("Toy Story", 1995), E("Game of Thrones", 2011, "tv", season: 1) }, libraryUsers: new[] { user, owner });

        Assert.Equal(movieItem.ToString("N"), response.Results[0].Match!.InLibrary!.ItemId);
        Assert.True(response.Results[0].Match!.InLibrary!.Complete);
        Assert.Null(response.Results[0].Candidates[1].InLibrary);
        var season = response.Results[1].Match!.InLibrary!;
        Assert.Equal(("season", false), (season.Kind, season.Complete));
        Assert.Single(season.EpisodeItemIds!);
        Assert.All(h.Library.Calls, c => Assert.Equal(new[] { user.Id, owner.Id }, c.Users.Select(u => u.Id)));
        var seasonCall = h.Library.Calls.Single(c => c.Scope.Kind == "season");
        Assert.Equal((1399, 1), (seasonCall.Scope.TmdbId, seasonCall.Scope.Season!.Value));
    }

    [Fact]
    public async Task InLibraryComesFromTheGranularityResolverSoItMatchesWhatTheApplyInserts()
    {
        using var h = new ListPlaceholdersHarness(realLibrary: true);
        var user = h.NewUser("u");
        var owner = h.NewUser("owner");
        var show = Tv(110492, "Peacemaker", "2022-01-13", 5000);
        h.Lookup.AddSearch("Peacemaker", show);
        h.Lookup.AddShow(show, new SeasonFacts(1, 8, "2022-01-13", "Season 1"));
        h.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 15000));
        var series = h.Host.AddSeries(tmdb: 110492);
        var e2 = h.Host.AddEpisode(series, 1, 2);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        var hidden = h.Host.AddEpisode(series, 1, 3);
        h.Host.Hide(hidden, owner);
        var movie = h.Host.AddMovie(tmdb: 49521);

        var response = await Resolve(h, user, new[] { E("Peacemaker", 2022, "tv", season: 1), E("Man of Steel", 2013) }, libraryUsers: new[] { user, owner });

        var season = response.Results[0].Match!.InLibrary!;
        Assert.Equal(("season", h.Host.Seasons[(series, 1)].Id.ToString("N"), false), (season.Kind, season.ItemId, season.Complete));
        Assert.Equal(new[] { e1.ToString("N"), e2.ToString("N") }, season.EpisodeItemIds); // in order; E3 isn't visible to the owner
        var film = response.Results[1].Match!.InLibrary!;
        Assert.Equal(("movie", movie.ToString("N"), true, null), (film.Kind, film.ItemId, film.Complete, film.EpisodeItemIds));

        var alone = await Resolve(h, user, new[] { E("Peacemaker", 2022, "tv", season: 1) });
        Assert.Equal(3, alone.Results[0].Match!.InLibrary!.EpisodeItemIds!.Count);
    }

    [Fact]
    public async Task RestrictedCallersNeverSeeBlockedCandidates()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var kid = h.NewUser("kid", maxRating: 10);
        h.MovieCertifications[293660] = "R";
        h.MovieCertifications[558144] = "PG";
        h.Lookup.AddSearch("Deadpool", Movie(293660, "Deadpool", "2016-02-09", 30000), Movie(558144, "Deadpool: No Good Deed", "2017-03-03", 200));

        var restricted = (await Resolve(h, kid, new[] { E("Deadpool", 2016, "movie") })).Results[0];
        Assert.Equal(new[] { 558144 }, restricted.Candidates.Select(c => c.TmdbId));
        Assert.Equal("low", restricted.Confidence);

        var adult = h.NewUser("adult");
        var unrestricted = (await Resolve(h, adult, new[] { E("Deadpool", 2016, "movie") })).Results[0];
        Assert.Equal(293660, unrestricted.Match!.TmdbId);
    }

    [Fact]
    public async Task InvalidEntriesAreReportedNotResolved()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var crossSeason = E("Show", null, null, null, null, (1, 9), (2, 1));
        var tooLong = E(new string('x', 201));
        var empty = new ImportEntryDto();
        var tooManyAlternatives = E("A");
        tooManyAlternatives.Alternatives = Enumerable.Range(0, 5).Select(i => new ImportAlternativeDto { Title = "A" + i }).ToList();

        var response = await Resolve(h, user, new[] { crossSeason, tooLong, empty, tooManyAlternatives });

        Assert.All(response.Results, r => Assert.Equal("invalid", r.State));
        Assert.Empty(h.Lookup.Log);
    }

    [Fact]
    public async Task ClientIndexesAreEchoedAndCallsCounted()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Aquaman", Movie(297802, "Aquaman", "2018-12-07"));
        var entry = E("Aquaman", 2018, "movie");
        entry.Index = 41;

        var response = await Resolve(h, user, new[] { entry });

        Assert.Equal(41, response.Results[0].Index);
        Assert.Equal(1, response.SeerrCalls);
    }

    // ── Review round ────────────────────────────────────────────────────

    [Fact]
    public async Task EachAlternativeKeepsItsOwnSeasonForTheCandidateAndTheLibraryLookup()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var show = Tv(100, "Show", "2020-01-01");
        h.Lookup.AddSearch("Show", show);
        h.Lookup.AddShow(show, new SeasonFacts(1, 10, "2020-01-01", "Season 1"), new SeasonFacts(2, 8, "2021-01-01", "Season 2"));
        var other = Tv(200, "Other Show", "2019-01-01");
        h.Lookup.AddSearch("Other Show", other);
        h.Lookup.AddShow(other, new SeasonFacts(1, 6, "2019-01-01", "Season 1"));

        var seasons = E("Show", null, "tv", 1);
        seasons.Alternatives = new List<ImportAlternativeDto> { new() { Title = "Show", Season = 1 }, new() { Title = "Show", Season = 2 } };
        var mixed = E("Show", null, "tv", 2);
        mixed.Alternatives = new List<ImportAlternativeDto> { new() { Title = "Show", Season = 2 }, new() { Title = "Other Show", TypeHint = "tv" } };

        var response = await Resolve(h, user, new[] { seasons, mixed });

        var bySeason = response.Results[0].Candidates;
        Assert.Equal(new[] { (0, 1), (1, 2) }, bySeason.Select(c => (c.Alternative!.Value, c.Season!.SeasonNumber)));
        Assert.Contains(h.Library.Calls, c => c.Scope.TmdbId == 100 && c.Scope.Kind == "season" && c.Scope.Season == 2);
        // "Show Season 2 or Other Show": the other show as a whole, not its (missing) season 2.
        var otherCandidate = response.Results[1].Candidates.Single(c => c.TmdbId == 200);
        Assert.Null(otherCandidate.Season);
        Assert.Contains(h.Library.Calls, c => c.Scope.TmdbId == 200 && c.Scope.Kind == "series" && c.Scope.Season == null);
        Assert.DoesNotContain(h.Library.Calls, c => c.Scope.TmdbId == 200 && c.Scope.Season != null);
    }

    [Fact]
    public async Task AnExactTieStaysLowEvenWhenOneTitleIsFarBetterKnown()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        h.Lookup.AddSearch("Hero", Movie(1, "Hero", "2002-10-24", 3000), Movie(2, "Hero", "2002-05-01", 100));

        var result = (await Resolve(h, user, new[] { E("Hero", 2002, "movie") })).Results[0];

        Assert.Equal(1, result.Match!.TmdbId);
        Assert.Contains("tie", result.Reasons);
        Assert.Equal("low", result.Confidence);
    }

    [Fact]
    public async Task AnOpenEndedEpisodeRangeRunsToTheEndOfItsSeason()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var show = Tv(57243, "Doctor Who", "2005-03-26");
        h.Lookup.AddSearch("Doctor Who", show);
        h.Lookup.AddShow(show, new SeasonFacts(1, 8, "2005-03-26", "Series 1"), new SeasonFacts(2, 6, "2006-04-15", "Series 2"));
        h.Lookup.Seasons[(57243, 1)] = Enumerable.Range(1, 8).Select(e => new EpisodeFacts(1, e, "Episode " + e, "2005-04-01")).ToList();
        var range = E("Doctor Who", null, "tv", null, null, (1, 5));
        range.OpenEnded = true;
        var unknown = E("Doctor Who", null, "tv", null, null, (2, 3));
        unknown.OpenEnded = true; // season 2's episodes can't be read

        var response = await Resolve(h, user, new[] { range, unknown });

        var filled = response.Results[0];
        Assert.Equal(new[] { 5, 6, 7, 8 }, filled.Match!.Episodes!.Select(e => e.E));
        Assert.DoesNotContain("openEnded", filled.Reasons);
        Assert.Contains(h.Library.Calls, c => c.Scope.TmdbId == 57243 && c.Scope.Episodes != null && c.Scope.Episodes.SequenceEqual(new[] { 5, 6, 7, 8 }));
        Assert.Equal("low", response.Results[1].Confidence);
    }
}
