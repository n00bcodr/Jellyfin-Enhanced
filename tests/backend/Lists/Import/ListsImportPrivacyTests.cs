using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// The review uses the viewer's current policy (track 4c2a, D46): a restricted viewer's answer never holds a candidate,
// alternative, library id, count or key of a title their parental controls hide (also an unrated or unverifiable one:
// unknown fails closed), shared caches never carry one viewer's projection to another (account switch), library matches
// are only copies every library user can open, Hidden Content marks (never pre-selects) and Spoiler Guard strips.
[Collection("Plugin singleton")]
public class ListsImportPrivacyTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static async Task<ResolveResponse> Resolve(ImportHarness h, User user, IReadOnlyList<User>? libraryUsers, params ImportEntryDto[] entries) =>
        (await h.ImportResolver.ResolveAsync(entries, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = libraryUsers ?? new[] { user },
            Context = new ImportCallContext(user.Id.ToString("N"), false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
        }, None)).Response;

    private static ImportEntryDto Line(string title, int? year = null, string? type = null) => new() { Title = title, Year = year, TypeHint = type };

    // A JE-only household: no Seerr; the parental filter reads certifications from TMDB with JE's key.
    private static ImportHarness JeHousehold()
    {
        var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        return h;
    }

    private static void Rate(ImportHarness h, int tmdb, string? certification) =>
        h.Tmdb["/3/movie/" + tmdb + "/release_dates"] = certification == null
            ? "{\"id\":" + tmdb + ",\"results\":[]}"
            : "{\"id\":" + tmdb + ",\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"" + certification + "\",\"type\":3}]}]}";

    [Fact]
    public async Task ARestrictedViewersAnswerHasNoTraceOfAHiddenTitle()
    {
        using var h = JeHousehold();
        var kid = h.NewUser("kid", maxRating: 10);
        Rate(h, 293660, "R");
        Rate(h, 558144, "PG");
        Rate(h, 777001, null); // unrated: unknown, hidden like blocked
        h.Lookup.AddSearch("Deadpool", Movie(293660, "Deadpool", "2016-02-09", 30000), Movie(558144, "Deadpool: No Good Deed", "2017-03-03", 200), Movie(777001, "Deadpool Fan Cut", "2018-01-01", 3));
        var rItem = h.Host.AddMovie(tmdb: 293660);
        h.Library.Matches[("movie", 293660)] = new LibraryMatch(rItem, "movie", Array.Empty<Guid>(), true);
        var alternatives = Line("Deadpool or Deadpool: No Good Deed", 2016, "movie");
        alternatives.Alternatives = new List<ImportAlternativeDto> { new() { Title = "Deadpool", Year = 2016 }, new() { Title = "Deadpool: No Good Deed", Year = 2017 } };

        var response = await Resolve(h, kid, null, Line("Deadpool", 2016, "movie"), alternatives);

        var json = JsonSerializer.Serialize(response);
        Assert.DoesNotContain("293660", json, StringComparison.Ordinal);
        Assert.DoesNotContain("777001", json, StringComparison.Ordinal);
        Assert.DoesNotContain(rItem.ToString("N"), json, StringComparison.Ordinal);
        Assert.Equal(new[] { 558144 }, response.Results[0].Candidates.Select(c => c.TmdbId));
        Assert.Equal(ImportScoring.Levels.Low, response.Results[0].Confidence); // the best title was removed: review it
        Assert.Equal(new[] { 558144 }, response.Results[1].Candidates.Select(c => c.TmdbId).Distinct()); // the hidden alternative is gone
    }

    [Fact]
    public async Task SwitchingAccountsNeverCarriesOneViewersAnswerToAnother()
    {
        using var h = JeHousehold();
        var adult = h.NewUser("adult");
        var kid = h.NewUser("kid", maxRating: 10);
        Rate(h, 293660, "R");
        h.Lookup.AddSearch("Deadpool", Movie(293660, "Deadpool", "2016-02-09", 30000));

        var first = await Resolve(h, adult, null, Line("Deadpool", 2016, "movie"));
        var second = await Resolve(h, kid, null, Line("Deadpool", 2016, "movie"));
        var third = await Resolve(h, adult, null, Line("Deadpool", 2016, "movie"));

        Assert.Equal(293660, first.Results[0].Match!.TmdbId);
        Assert.Null(second.Results[0].Match);
        Assert.Empty(second.Results[0].Candidates);
        Assert.Equal(ImportScoring.Levels.None, second.Results[0].Confidence);
        Assert.Equal(293660, third.Results[0].Match!.TmdbId); // the kid's projection didn't stick to anything shared
    }

    [Fact]
    public async Task InLibraryOnlyNamesCopiesEveryLibraryUserCanOpen()
    {
        using var h = new ImportHarness(realLibrary: true);
        var viewer = h.NewUser("viewer");
        var owner = h.NewUser("owner");
        var admin = h.NewUser("admin", admin: true);
        h.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 16680));
        var copy = h.Host.AddMovie(tmdb: 49521);
        h.Host.Hide(copy, viewer);

        var forAdmin = await Resolve(h, admin, null, Line("Man of Steel", 2013, "movie"));
        var forViewer = await Resolve(h, viewer, null, Line("Man of Steel", 2013, "movie"));
        var forOwnersPlaylist = await Resolve(h, admin, new[] { admin, viewer }, Line("Man of Steel", 2013, "movie"));

        Assert.Equal(copy.ToString("N"), forAdmin.Results[0].Match!.InLibrary!.ItemId);
        Assert.Null(forViewer.Results[0].Match!.InLibrary);
        Assert.DoesNotContain(copy.ToString("N"), JsonSerializer.Serialize(forViewer), StringComparison.Ordinal);
        Assert.Null(forOwnersPlaylist.Results[0].Match!.InLibrary); // a playlist the viewer owns: they must see it too
        _ = owner;
    }

    [Fact]
    public async Task AFetchedListShowsARestrictedViewerNoHiddenEntryOrCount()
    {
        using var h = JeHousehold();
        var kid = h.NewUser("kid", maxRating: 10);
        var adult = h.NewUser("adult");
        Rate(h, 1, "PG");
        Rate(h, 2, "R");
        Rate(h, 3, "PG");
        h.Fetcher.Items = new List<SourceItem>
        {
            new("movie", 1, null, null, "One", 2001, null, null, null),
            new("movie", 2, null, null, "Two", 2002, null, null, null),
            new("movie", 3, null, null, "Three", 2003, null, null, null),
            new("movie", null, null, null, "No id", null, null, null, null),
        };

        var forKid = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(kid, "https://mdblist.com/lists/a/b", None));
        var forAdult = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(adult, "https://mdblist.com/lists/a/b", None));

        Assert.Equal(new[] { 1, 3 }, forKid.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.True(forKid.CountsHidden);
        Assert.Equal((0, 0), (forKid.Total, forKid.Dropped));
        Assert.Null(forKid.Snapshot); // its digest would tell the full list apart
        var json = JsonSerializer.Serialize(forKid);
        Assert.DoesNotContain("\"Two\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("movie|2||", json, StringComparison.Ordinal);

        Assert.Equal(new[] { 1, 2, 3 }, forAdult.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.Null(forAdult.CountsHidden);
        Assert.Equal((4, 1), (forAdult.Total, forAdult.Dropped));
        Assert.NotNull(forAdult.Snapshot);
    }

    [Fact]
    public async Task AnUnverifiableTitleIsHiddenFromARestrictedViewerNotShown()
    {
        using var h = JeHousehold();
        var kid = h.NewUser("kid", maxRating: 10);
        // No certification anywhere (the TMDB read fails): unknown, so hidden; a typed retry only when checks run out of time.
        h.Lookup.AddSearch("Mystery", Movie(424242, "Mystery", "2020-01-01", 500));

        var response = await Resolve(h, kid, null, Line("Mystery", 2020, "movie"));

        Assert.Empty(response.Results[0].Candidates);
        Assert.DoesNotContain("424242", JsonSerializer.Serialize(response), StringComparison.Ordinal);
    }

    [Fact]
    public async Task HiddenContentMarksAndNeverPreselectsForThatViewerOnly()
    {
        using var h = new ImportHarness();
        var hider = h.NewUser("hider");
        var other = h.NewUser("other");
        h.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 16680));
        h.Viewer.Hide(hider, "movie", 49521);

        var hidden = (await Resolve(h, hider, null, Line("Man of Steel", 2013, "movie"))).Results[0];
        var shown = (await Resolve(h, other, null, Line("Man of Steel", 2013, "movie"))).Results[0];

        Assert.True(hidden.Match!.Hidden);
        Assert.Equal(ImportScoring.Levels.Low, hidden.Confidence); // the viewer's own rule: it waits for their choice
        Assert.Contains("hidden", hidden.Reasons);
        Assert.Null(shown.Match!.Hidden);
        Assert.Equal(ImportScoring.Levels.High, shown.Confidence);
        Assert.DoesNotContain("\"hidden\"", JsonSerializer.Serialize(shown.Match), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SpoilerGuardStripsEpisodeTitlesAndOverviewsForTheGuardingViewer()
    {
        using var h = new ImportHarness();
        var guarded = h.NewUser("guarded");
        var other = h.NewUser("other");
        var show = new TitleHit("tv", 1399, "Game of Thrones", null, "2011-04-17", null, "Seven noble families fight.", 90, 25000);
        h.Lookup.AddSearch("Game of Thrones", show);
        h.Lookup.AddShow(show, new SeasonFacts(1, 10, "2011-04-17", "Season 1"));
        h.Lookup.Seasons[(1399, 1)] = Enumerable.Range(1, 10).Select(e => new EpisodeFacts(1, e, "Episode name " + e, "2011-04-17")).ToList();
        h.Viewer.Guard(guarded, "tv", 1399);
        var line = new ImportEntryDto { Title = "Game of Thrones", Year = 2011, TypeHint = "tv", Season = 1, Episodes = new List<ImportEpisodeDto> { new() { S = 1, E = 9 } } };

        var forGuarded = (await Resolve(h, guarded, null, line)).Results[0].Match!;
        var forOther = (await Resolve(h, other, null, line)).Results[0].Match!;

        Assert.True(forGuarded.SpoilerGuarded);
        Assert.Null(forGuarded.Overview);
        Assert.All(forGuarded.Episodes!, e => Assert.Null(e.Title));
        Assert.Equal(9, Assert.Single(forGuarded.Episodes!).E); // the coordinates stay: the entry is still exact
        Assert.Equal("Episode name 9", Assert.Single(forOther.Episodes!).Title);
        Assert.Equal("Seven noble families fight.", forOther.Overview);
    }

    [Fact]
    public async Task PreparedWatchOrderEntriesGetTheSamePolicy()
    {
        using var h = new ImportHarness();
        var guarded = h.NewUser("guarded");
        h.Fetcher.Exact = true;
        h.Fetcher.Provider = "chronolists";
        h.Fetcher.Items = Enumerable.Range(1, 3).Select(e => new SourceItem("tv", 1412, null, null, "Arrow", 2012, 1, e, null) { Details = new SourceItemDetails("Spoiler " + e, "2012-10-1" + e, null, null, "Season 1") }).ToList();
        h.Viewer.Guard(guarded, "tv", 1412);
        h.Viewer.Hide(guarded, "tv", 1412);

        var fetched = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(guarded, "https://chronolists.com/dctv", None));

        var prepared = Assert.Single(fetched.Entries).Prepared!;
        Assert.True(prepared.Match!.SpoilerGuarded);
        Assert.True(prepared.Match.Hidden);
        Assert.All(prepared.Match.Episodes!, e => Assert.Null(e.Title));
        Assert.DoesNotContain("Spoiler", JsonSerializer.Serialize(fetched), StringComparison.Ordinal);
        Assert.Equal(ImportScoring.Levels.Low, prepared.Confidence);
    }
}
