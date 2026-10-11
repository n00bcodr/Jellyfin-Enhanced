using System.Globalization;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// chronolists.com watch orders (track p5c): URL recognition, reading the page's embedded data (trimmed real pages in
// Fixtures/), grouping episode runs, prepared entries, per-episode provenance on run placeholders, and the import →
// sync round trip.
[Collection("Plugin singleton")]
public class ListPlaceholdersChronolistsTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string DctvUrl = "https://chronolists.com/dctv";

    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "ListPlaceholders", "Fixtures", name));

    private static ChronolistsList Read(string html)
    {
        Assert.True(ChronolistsPage.TryRead(html, out var list, out var error), error);
        return list!;
    }

    private static List<(SourceItem Item, int Position)> Positioned(IReadOnlyList<SourceItem> items) => items.Select((item, i) => (item, i)).ToList();

    private static List<SourceGroup> Group(IReadOnlyList<SourceItem> items) => ListSourceGroups.Group(Positioned(items), ListFacts(items));

    // TMDB's episode count of every season as the list has it (E1 to its highest episode): TMDB agrees with the list.
    private static Dictionary<(int Show, int Season), int> ListedSeasons(IEnumerable<SourceItem> items) =>
        items.Where(i => i.MediaType == "tv" && i.TmdbId is > 0 && i.Season is > 0 && i.Episode.HasValue)
            .GroupBy(i => (i.TmdbId!.Value, i.Season!.Value))
            .ToDictionary(g => g.Key, g => g.Max(i => i.Episode!.Value));

    // The list's facts with TMDB agreeing with the list's seasons (review r1 F23: whole seasons need TMDB's count).
    private static SourceListFacts ListFacts(IReadOnlyList<SourceItem> items)
    {
        var facts = ListSourceGroups.Facts(items);
        foreach (var (key, count) in ListedSeasons(items))
        {
            facts.SeasonEpisodes[key] = count;
        }

        return facts;
    }

    // A page with the given list JSON (l, m) in the chronolists shape.
    private static string Page(string list, string page = "/[universe]", string name = "Test Universe") =>
        "<html><head><script src=\"/x.js\"></script></head><body><script id=\"__NEXT_DATA__\" type=\"application/json\">"
        + "{\"props\":{\"pageProps\":{\"universe\":{\"id\":\"t\",\"name\":\"" + name + "\",\"list\":" + list + "}}},\"page\":\"" + page + "\"}"
        + "</script></body></html>";

    private static string Ep(int sid, object s, object e, string date = "2020-01-01", string? name = null) =>
        "{\"t\":\"tv\",\"s\":" + JsonSerializer.Serialize(s) + ",\"e\":" + JsonSerializer.Serialize(e) + ",\"en\":\"" + (name ?? $"Ep {e}") + "\",\"rd\":\"" + date + "\",\"sid\":" + sid.ToString(CultureInfo.InvariantCulture) + "}";

    private static string Show(int sid, int id, string name, string season = "Season 1") =>
        "\"" + sid.ToString(CultureInfo.InvariantCulture) + "\":{\"n\":\"" + name + "\",\"sn\":\"" + season + "\",\"i\":\"/p" + sid.ToString(CultureInfo.InvariantCulture) + ".jpg\",\"id\":" + id.ToString(CultureInfo.InvariantCulture) + ",\"imdb\":\"tt0000" + id.ToString("000", CultureInfo.InvariantCulture) + "\",\"tvdb\":" + (id + 1000).ToString(CultureInfo.InvariantCulture) + "}";

    // ── URLs ────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("https://chronolists.com/dctv", "https://chronolists.com/dctv")]
    [InlineData("chronolists.com/MCU/", "https://chronolists.com/mcu")]
    [InlineData("https://www.chronolists.com/star-wars?utm=1#top", "https://chronolists.com/star-wars")]
    [InlineData("http://chronolists.com/doctor-who", "https://chronolists.com/doctor-who")]
    public void ChronolistsUrlsAreRecognisedAndCanonicalised(string url, string canonical)
    {
        Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
        Assert.Equal((SourceKinds.Chronolists, "universe", canonical), (source!.Kind, source.Shape, source.CanonicalUrl));
    }

    [Theory]
    [InlineData("https://chronolists.com/", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://chronolists.com/dctv/episodes", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://chronolists.com/_next/data", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://chronolists.com/dctv%2F..%2Fadmin", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://chronolists.com.evil.test/dctv", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://evilchronolists.com/dctv", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://chronolists.com:8443/dctv", ListSourceUrl.InvalidUrl)]
    [InlineData("https://me@chronolists.com/dctv", ListSourceUrl.InvalidUrl)]
    public void OtherChronolistsAddressesAreRejectedBeforeAnyRequest(string url, string code)
    {
        Assert.False(ListSourceUrl.TryParse(url, out var source, out var error));
        Assert.Null(source);
        Assert.Equal(code, error);
    }

    // ── Reading the page ────────────────────────────────────────────────

    [Fact]
    public void TheDctvPageGivesEpisodesWithExactIdsAndMetadata()
    {
        var list = Read(Fixture("chronolists-dctv.html"));

        Assert.Equal(("DC Arrowverse", 60, 60, 0, false), (list.Title, list.Items.Count, list.Total, list.Unusable, list.Truncated));
        var pilot = list.Items[0];
        Assert.Equal(("tv", 1412, "tt2193021", 257655, "Arrow", 2012, 1, 1), (pilot.MediaType, pilot.TmdbId, pilot.ImdbId, pilot.TvdbId, pilot.Title, pilot.Year, pilot.Season, pilot.Episode));
        Assert.Equal("tv|1412|1|1", pilot.Key);
        Assert.Equal(new SourceItemDetails("Pilot", "2012-10-10", "/pAdZsHyk7ROQqHzzK8QIM8OnR5f.jpg", null, "Season 1"), pilot.Details);
        Assert.Equal("tv|60735|1|1", list.Items[46].Key); // The Flash 1x01 after Arrow S1–S2
        Assert.All(list.Items, i => Assert.True(SourceKeys.IsValid(i.Key)));
        Assert.Equal(60, list.Items.Select(i => i.Key).Distinct().Count());
    }

    [Fact]
    public void TheMcuPageMixesMoviesAndEpisodes()
    {
        var list = Read(Fixture("chronolists-mcu.html"));

        Assert.Equal(("Marvel Cinematic Universe", 40), (list.Title, list.Items.Count));
        var movie = list.Items.First(i => i.MediaType == "movie");
        Assert.Equal(("movie|1771||", "Captain America: The First Avenger", 2011, "tt0458339"), (movie.Key, movie.Title, movie.Year, movie.ImdbId));
        Assert.Equal(("2011-07-22", "/vSNxAJTlD0r02V9sPYpOjqDZXUK.jpg"), (movie.Details!.Date, movie.Details.PosterPath));
        Assert.StartsWith("During World War II", movie.Details.Overview, StringComparison.Ordinal);
        Assert.Equal(8, list.Items.Count(i => i.MediaType == "movie"));
    }

    [Fact]
    public void KeysAreStableAcrossReadsAndDontDependOnTheEntrysPlace()
    {
        var html = Fixture("chronolists-dctv.html");
        var first = Read(html).Items.Select(i => i.Key).ToList();
        Assert.Equal(first, Read(html).Items.Select(i => i.Key).ToList());

        // The same episodes in another order (an upstream re-sort) keep their keys: keys are ids, never ranks.
        var reversed = Read(Page("{\"l\":[" + Ep(7, "2", "5") + "," + Ep(7, 2, 4) + "],\"m\":{" + Show(7, 77, "Show") + "}}")).Items.Select(i => i.Key);
        Assert.Equal(new[] { "tv|77|2|5", "tv|77|2|4" }, reversed);
    }

    [Theory]
    [InlineData("<html><body>No data here</body></html>")]
    [InlineData("<script id=\"__NEXT_DATA__\" type=\"application/json\">{not json</script>")]
    [InlineData("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{}},\"page\":\"/[universe]\"}</script>")]
    [InlineData("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"universe\":{\"list\":{\"l\":{},\"m\":{}}}}}}</script>")]
    [InlineData("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"universe\":{\"list\":{\"entries\":[]}}}}}</script>")]
    [InlineData("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"universe\":{\"list\":{\"l\":[{\"t\":\"tv\",\"season\":1}],\"m\":{}}}}}}</script>")]
    [InlineData("<script id=\"__NEXT_DATA__\" type=\"application/json\">[1,2,3]</script>")]
    public void AChangedPageShapeIsReportedNotGuessedAt(string html)
    {
        Assert.False(ChronolistsPage.TryRead(html, out var list, out var error));
        Assert.Null(list);
        Assert.Equal(ChronolistsPage.FormatChanged, error);
    }

    [Fact]
    public void APageThatIsNotAWatchOrderIsNotFoundAndUnreadableEntriesMakeItPartial()
    {
        Assert.False(ChronolistsPage.TryRead("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{}},\"page\":\"/help\"}</script>", out _, out var error));
        Assert.Equal(ChronolistsPage.NotAWatchOrder, error);

        // One entry of an unknown type and one pointing at a missing season among 20: kept as keyless gaps at their
        // places (never guessed), counted; the bad poster/IMDb id of a readable movie are dropped.
        var many = string.Join(",", Enumerable.Range(2, 17).Select(e => Ep(7, 1, e)));
        var list = Read(Page("{\"l\":[" + Ep(7, 1, 1) + ",{\"t\":\"short\",\"id\":5}," + Ep(8, 1, 1) + ",{\"t\":\"movie\",\"id\":603,\"n\":\"The Matrix\",\"rd\":\"1999-03-31\",\"i\":\"../evil.jpg\",\"imdb\":\"nope\"}," + many + "],\"m\":{" + Show(7, 77, "Show") + "}}"));
        Assert.Equal((21, 21, 2), (list.Items.Count, list.Total, list.Unusable));
        Assert.Equal(new string?[] { "tv|77|1|1", null, null, "movie|603||" }, list.Items.Take(4).Select(i => i.Key));
        var matrix = list.Items[3];
        Assert.Equal(("movie|603||", null, null), (matrix.Key, matrix.ImdbId, matrix.Details!.PosterPath)); // bad poster/imdb dropped
    }

    [Fact]
    public void APartlyChangedShapeIsAFormatChangeNotASilentlySmallerList()
    {
        var episodes = string.Join(",", Enumerable.Range(1, 60).Select(e => Ep(7, 1, e)));
        string Movie(int id, string idField = "id") => "{\"t\":\"movie\",\"" + idField + "\":" + id + ",\"n\":\"Movie " + id + "\",\"rd\":\"2010-01-01\"}";
        var shows = "\"m\":{" + Show(7, 77, "Show") + "}}";

        // Every movie moved its id elsewhere while the episodes kept their shape (5 movies among 60 episodes, < 10%).
        var moved = string.Join(",", Enumerable.Range(1, 5).Select(i => Movie(i, "tmdbId")));
        Assert.False(ChronolistsPage.TryRead(Page("{\"l\":[" + episodes + "," + moved + "]," + shows), out _, out var error));
        Assert.Equal(ChronolistsPage.FormatChanged, error);

        // More than 10% of the entries unreadable (here an unknown entry type).
        var unknown = string.Join(",", Enumerable.Range(1, 7).Select(i => "{\"t\":\"film\",\"id\":" + i + "}"));
        Assert.False(ChronolistsPage.TryRead(Page("{\"l\":[" + episodes + "," + unknown + "]," + shows), out _, out error));
        Assert.Equal(ChronolistsPage.FormatChanged, error);

        // A few broken entries (2 of 62, and the movies that remain readable) are a partial page, not a change.
        var some = Movie(1) + "," + Movie(2, "tmdbId") + "," + Movie(3) + ",{\"t\":\"film\",\"id\":9}";
        var list = Read(Page("{\"l\":[" + episodes + "," + some + "]," + shows));
        Assert.Equal((64, 2), (list.Items.Count, list.Unusable));
    }

    [Fact]
    public async Task UnreadableEntriesAreCountedAsDroppedAndTheFetchSaysItIsPartial()
    {
        using var w = new World();
        var page = Read(Page("{\"l\":[" + string.Join(",", Enumerable.Range(1, 12).Select(e => Ep(7, 1, e))) + ",{\"t\":\"film\",\"id\":9}],\"m\":{" + Show(7, 77, "Show") + "}}"));
        w.H.Fetcher.Items = page.Items.ToList();
        w.H.Fetcher.Partial = page.Unusable > 0;

        var fetched = await w.FetchAsync();

        Assert.Equal((1, true, 12), (fetched.Dropped, fetched.Partial, fetched.SnapshotKeys!.Count));
        Assert.Contains("\"partial\":true", JsonSerializer.Serialize(fetched), StringComparison.Ordinal);
        w.H.Fetcher.Partial = false;
        Assert.DoesNotContain("\"partial\"", JsonSerializer.Serialize(await w.FetchAsync()), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnreadableEntryBreaksARunSoItsPlaceIsKeptForWhenItIsFixed()
    {
        using var w = new World();
        // Another show's 9 episodes, then Show 88 1x01, a movie without its id, 1x02 (1 of 12 unreadable: partial).
        var before = string.Join(",", Enumerable.Range(1, 9).Select(e => Ep(7, 1, e))) + ",";
        const string Broken = "{\"t\":\"movie\",\"n\":\"Crossover\",\"rd\":\"2020-02-01\"}";
        const string Fixed = "{\"t\":\"movie\",\"id\":4242,\"n\":\"Crossover\",\"rd\":\"2020-02-01\"}";
        string Html(string movie) => Page("{\"l\":[" + before + Ep(8, 1, 1) + "," + movie + "," + Ep(8, 1, 2) + "],\"m\":{" + Show(7, 77, "Show") + "," + Show(8, 88, "Other") + "}}");
        var partial = Read(Html(Broken));
        Assert.Equal(1, partial.Unusable);
        w.H.Fetcher.Items = partial.Items.ToList();
        w.H.Fetcher.Partial = true;

        // Show 88 S1 has two episodes in the list, adjacent apart from the gap: two entries, not one season.
        var fetched = await w.FetchAsync();
        Assert.Equal(new[] { "season", "episodes", "episodes" }, fetched.Entries.Select(e => e.Prepared!.Kind));
        await w.Import(fetched, sendGroupKeys: true);

        // Fixed upstream: the movie lands between the two episodes.
        w.H.Fetcher.Items = Read(Html(Fixed)).Items.ToList();
        w.H.Fetcher.Partial = false;
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "77:S1", "88:S1E1", "4242", "88:S1E2" }, w.Order());
    }

    // ── Fetching ────────────────────────────────────────────────────────

    private sealed class Net : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<HttpRequestMessage> Requests { get; } = new();
        public Func<HttpRequestMessage, HttpResponseMessage> Reply { get; set; } = _ => IntegrationTransport.Response("not found", 404, "text/html");
        public IntegrationTransport Transport { get; }
        public ListSourceFetcher Fetcher { get; }

        public Net()
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Requests)
                {
                    Requests.Add(request);
                }

                return Task.FromResult(Reply(request));
            });
            Fetcher = new ListSourceFetcher(Transport, null, new SeerrCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger);
        }

        public Task<SourceFetchResult> Fetch(string url)
        {
            Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
            return Fetcher.FetchAsync(source!, new SourceFetchOptions { Fresh = true }, None);
        }

        public void Dispose()
        {
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    [Fact]
    public async Task TheFetcherReadsOnlyTheCanonicalPageWithAClearUserAgent()
    {
        using var net = new Net();
        net.Reply = _ => IntegrationTransport.Response(Fixture("chronolists-dctv.html"), 200, "text/html");

        var result = await net.Fetch("https://www.chronolists.com/DCTV/");

        Assert.True(result.Ok, result.Message);
        Assert.Equal(("chronolists", "chronolists", DctvUrl, "DC Arrowverse", 60, true, false, false), (result.Kind, result.Provider, result.CanonicalUrl, result.Title, result.Items.Count, result.Exact, result.Partial, result.Truncated));
        var request = Assert.Single(net.Requests);
        Assert.Equal(DctvUrl, request.RequestUri!.ToString());
        Assert.Contains("text/html", request.Headers.Accept.ToString(), StringComparison.Ordinal);
        Assert.Contains("JellyfinEnhanced", request.Headers.UserAgent.ToString(), StringComparison.Ordinal);
        Assert.True(net.Fetcher.Providers().Chronolists);
    }

    [Fact]
    public async Task FetchErrorsAreClearCodesNeverExceptions()
    {
        using var net = new Net();

        Assert.Equal("not_found", (await net.Fetch("https://chronolists.com/nope")).ErrorCode); // 404

        net.Reply = _ => IntegrationTransport.Response("<html>moved</html>", 301, "text/html");
        Assert.Equal("upstream_error", (await net.Fetch("https://chronolists.com/dctv")).ErrorCode); // redirects aren't followed
        Assert.Equal(2, net.Requests.Count);

        net.Reply = _ => IntegrationTransport.Response("<html><body>a redesigned page</body></html>", 200, "text/html");
        var changed = await net.Fetch("https://chronolists.com/dctv");
        Assert.Equal((false, ChronolistsPage.FormatChanged), (changed.Ok, changed.ErrorCode));

        net.Reply = _ => IntegrationTransport.Response("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{}},\"page\":\"/help\"}</script>", 200, "text/html");
        Assert.Equal("not_found", (await net.Fetch("https://chronolists.com/help")).ErrorCode);

        var episodes = string.Join(",", Enumerable.Range(1, 12).Select(e => Ep(7, 1, e)));
        net.Reply = _ => IntegrationTransport.Response(Page("{\"l\":[" + episodes + ",{\"t\":\"game\"}],\"m\":{" + Show(7, 77, "Show") + "}}"), 200, "text/html");
        var partial = await net.Fetch("https://chronolists.com/dctv");
        Assert.Equal((true, true, 12), (partial.Ok, partial.Partial, partial.Items.Count(i => i.Key != null))); // read, but never trusted for removals
    }

    [Fact]
    public async Task AChangedPageIsA502WithItsCodeThroughTheService()
    {
        using var h = new ListPlaceholdersHarness();
        var admin = h.NewUser("admin", admin: true);
        h.Fetcher.FailCode = ChronolistsPage.FormatChanged;

        var outcome = await h.Sources.FetchAsync(admin, DctvUrl, None);

        Error(outcome, 502, ChronolistsPage.FormatChanged);
    }

    // ── Grouping ────────────────────────────────────────────────────────

    [Fact]
    public void RunsOfASeasonBecomeOneEntryAndWholeSeasonsBecomeSeasonPlaceholders()
    {
        var groups = Group(Read(Fixture("chronolists-dctv.html")).Items);

        Assert.Equal(16, groups.Count);
        Assert.Equal((PlaceholderKinds.Season, 23, "tv|1412|1|1"), (groups[0].Kind, groups[0].Keys.Count, groups[0].Key));
        Assert.Equal((PlaceholderKinds.Season, 23, "tv|1412|2|1"), (groups[1].Kind, groups[1].Keys.Count, groups[1].Key));
        // Then the crossover era alternates shows episode by episode: one-episode entries in watch order.
        Assert.Equal(
            new[] { "tv|60735|1|1", "tv|1412|3|1", "tv|60735|1|2", "tv|1412|3|2", "tv|60735|1|3", "tv|1412|3|3", "tv|60743|1|1" },
            groups.Skip(2).Take(7).Select(g => g.Key));
        Assert.All(groups.Skip(2), g => Assert.Equal((PlaceholderKinds.Episodes, 1), (g.Kind, g.Keys.Count)));
        Assert.Equal(60, groups.Sum(g => g.Keys.Count));
    }

    [Fact]
    public void TheMcuGroupsMoviesSeasonsAndPartialRuns()
    {
        var groups = Group(Read(Fixture("chronolists-mcu.html")).Items);

        Assert.Equal(
            new[] { "season", "movie", "season", "season", "movie", "movie", "movie", "movie", "movie", "movie", "episodes", "movie", "episodes" },
            groups.Select(g => g.Kind));
        // Agents of S.H.I.E.L.D. S1: E1–E7, then Thor: The Dark World, then E8–E10.
        Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7 }, groups[10].Items.Select(i => i.Episode!.Value));
        Assert.Equal(new[] { 8, 9, 10 }, groups[12].Items.Select(i => i.Episode!.Value));
    }

    [Fact]
    public void LongRunsAreSplitAtOneHundredSpecialsNeverBecomeSeasonsAndGapsBreakRuns()
    {
        SourceItem E(int show, int season, int episode) => new("tv", show, null, null, "Show " + show.ToString(CultureInfo.InvariantCulture), 2020, season, episode, null)
        {
            Details = new SourceItemDetails("E" + episode.ToString(CultureInfo.InvariantCulture), "2020-01-01", null, null, null),
        };

        // A whole 150-episode season is ONE season placeholder (no episode list to cap).
        var whole = Group(Enumerable.Range(1, 150).Select(e => E(1, 1, e)).ToList());
        Assert.Equal((PlaceholderKinds.Season, 150), (Assert.Single(whole).Kind, whole[0].Keys.Count));

        // Episodes 2–250 (not the whole season): episodes placeholders of at most 100.
        var partial = Group(Enumerable.Range(2, 249).Select(e => E(1, 1, e)).ToList());
        Assert.Equal(new[] { 100, 100, 49 }, partial.Select(g => g.Keys.Count));
        Assert.All(partial, g => Assert.Equal(PlaceholderKinds.Episodes, g.Kind));

        // Specials (season 0) are never "the whole season"; a skipped number or another show breaks the run.
        Assert.Equal(PlaceholderKinds.Episodes, Assert.Single(Group(new[] { E(1, 0, 1), E(1, 0, 2) })).Kind);
        Assert.Equal(new[] { 1, 1, 1 }, Group(new[] { E(1, 2, 1), E(1, 2, 3), E(2, 2, 4) }).Select(g => g.Keys.Count));

        // Entries are only grouped when adjacent in the whole source (a sync adding E5 and E6 around a present E7… no).
        var items = new[] { E(1, 3, 5), E(1, 3, 6) };
        var apart = ListSourceGroups.Group(new List<(SourceItem, int)> { (items[0], 4), (items[1], 9) }, ListSourceGroups.Facts(items));
        Assert.Equal(2, apart.Count);
    }

    [Fact]
    public void PreparedEntriesBuildTheSamePlaceholdersAsTheImportReview()
    {
        var items = Read(Fixture("chronolists-mcu.html")).Items;
        var facts = ListFacts(items);
        var groups = ListSourceGroups.Group(Positioned(items), facts);

        var season = ListSourceGroups.Placeholder(groups[2], facts)!;
        Assert.Equal(("season", "tv", 61550, "Marvel's Agent Carter", 1, 8, "2015-01-06", 2015, "tt3475734", 281485), (season.Kind, season.MediaType, season.TmdbId!.Value, season.Title, season.SeasonNumber!.Value, season.EpisodeTotal!.Value, season.ReleaseDate, season.Year!.Value, season.ImdbId, season.TvdbId!.Value));
        Assert.Equal("/gqyjmfFOrKY8iouNTXWj9KW7cC5.jpg", season.PosterPath);

        var run = ListSourceGroups.Placeholder(groups[12], facts)!;
        Assert.Equal(("episodes", 1, "2013-11-19", 2013), (run.Kind, run.SeasonNumber!.Value, run.ReleaseDate, run.Year!.Value)); // year = the show's first air year in the list
        Assert.Equal(new[] { 8, 9, 10 }, run.Episodes!.Select(e => e.E));
        Assert.All(run.Episodes!, e => Assert.False(string.IsNullOrEmpty(e.Title)));

        var movie = ListSourceGroups.Placeholder(groups[1], facts)!;
        Assert.Equal(("movie", 1771, "2011-07-22", 2011), (movie.Kind, movie.TmdbId!.Value, movie.ReleaseDate, movie.Year!.Value));
        Assert.All(groups, g => Assert.True(PlaceholderRules.TryCreate(ListSourceGroups.Placeholder(g, facts), "u", DateTime.UtcNow, out _, out var why), why));

        // The fetched entry carries every key and a high-confidence prepared result whose candidate yields that body.
        var entry = ListSourceGroups.Entry(groups[12], 12, facts, null);
        Assert.Equal("tv|1403|1|8", entry.SourceKey);
        Assert.Equal(new[] { "tv|1403|1|8", "tv|1403|1|9", "tv|1403|1|10" }, entry.SourceKeys);
        Assert.Equal((12, "ok", "high", "episodes"), (entry.Prepared!.Index, entry.Prepared.State, entry.Prepared.Confidence, entry.Prepared.Kind));
        Assert.NotNull(entry.Prepared.Match);
        Assert.Empty(entry.Prepared.Candidates); // the match isn't repeated (response size)
        var fromCandidate = ImportPlaceholders.FromCandidate(entry.Prepared.Match!, entry.Prepared.Kind, entry.Season, entry.Episodes!.Select(e => e.E).ToList(), null)!;
        Assert.Equal(JsonSerializer.Serialize(run), JsonSerializer.Serialize(fromCandidate));
    }

    // ── Fetch for the import review ─────────────────────────────────────

    private sealed class World : IDisposable
    {
        public ListPlaceholdersHarness H { get; }

        public User Owner { get; }

        public FakeListHost.FakeList List { get; }

        public World(bool realLibrary = false)
        {
            // realLibrary: "in library" comes from the production adapter over the fake host, as the apply's C1 does.
            H = new ListPlaceholdersHarness(realLibrary: realLibrary);
            H.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
            Owner = H.NewUser("owner");
            List = H.Host.AddPlaylist(Owner);
            H.Fetcher.Exact = true;
            H.Fetcher.Provider = "chronolists";
        }

        public ListAccess Access => H.AccessFor(List, Owner);

        public string Id => Access.ListIdN;

        public ListDoc Doc => H.Store.Load(Id)!;

        public void Page(string fixture) => H.Fetcher.Items = Read(Fixture(fixture)).Items.ToList();

        public async Task<SourceFetchResponse> FetchAsync()
        {
            TmdbAgrees();
            return Ok<SourceFetchResponse>(await H.Sources.FetchAsync(Owner, DctvUrl, None));
        }

        public Task<SourceSyncResultDto> Sync()
        {
            TmdbAgrees();
            return H.Sources.SyncAsync(Id, background: true, None);
        }

        // Seerr knows every show of the fetched list with the seasons as the list has them (first time only, so a later
        // upstream episode doesn't grow TMDB's season).
        public void TmdbAgrees()
        {
            foreach (var group in ListedSeasons(H.Fetcher.Items).GroupBy(e => e.Key.Show))
            {
                H.Lookup.Details.TryAdd(("tv", group.Key), new TitleDetails(FakeImportLookup.Tv(group.Key, "Show " + group.Key, "2020-01-01"), null, null, null, null, group.Select(e => new SeasonFacts(e.Key.Season, e.Value, null, null)).ToList()));
            }
        }

        // What an exact source asks Seerr: only shows' season episode counts.
        public void AssertOnlySeasonCountLookups() => Assert.All(H.Lookup.Log, call => Assert.StartsWith("details:tv/", call, StringComparison.Ordinal));

        // What the import review sends for the fetched entries (prepared → placeholder bodies, every key).
        public async Task<ApplyResultDto> Import(SourceFetchResponse fetched, bool sendGroupKeys, Func<int, bool>? skip = null, bool removeDropped = true)
        {
            var dtos = new List<ApplyEntryDto>();
            foreach (var entry in fetched.Entries.Where(e => skip == null || !skip(e.Index!.Value)))
            {
                var match = entry.Prepared!.Match!;
                if (match.InLibrary is { Kind: "movie" } library)
                {
                    dtos.Add(new ApplyEntryDto { Type = "item", ItemId = library.ItemId, SourceKey = entry.SourceKey, SourceKeys = sendGroupKeys ? entry.SourceKeys : null });
                    continue;
                }

                var body = ImportPlaceholders.FromCandidate(match, entry.Prepared.Kind, entry.Season, entry.Episodes?.Select(e => e.E).ToList(), null);
                dtos.Add(new ApplyEntryDto { Type = "placeholder", Placeholder = body, SourceKey = entry.SourceKey, SourceKeys = sendGroupKeys ? entry.SourceKeys : null });
            }

            var entries = dtos.Select((d, i) => d.Type == "item"
                ? new ApplyEntry(i, Guid.Parse(d.ItemId!), null)
                : new ApplyEntry(i, null, Placeholder(d))).ToList();
            TmdbAgrees();
            var (spec, error) = await H.Sources.PrepareLinkAsync(Owner, DctvUrl, true, removeDropped, None);
            Assert.Null(error);
            // The client as built (5i): snapshot = every fetched entry's sourceKey (first keys) unless it sends snapshotKeys.
            var snapshot = sendGroupKeys ? fetched.SnapshotKeys! : fetched.Entries.Select(e => e.SourceKey!).ToList();
            var plan = ListSourceService.PlanImportKeys(
                spec!,
                entries,
                dtos.Select((d, i) => (d, i)).ToDictionary(x => x.i, x => x.d.SourceKey!),
                dtos.Select((d, i) => (d, i)).Where(x => x.d.SourceKeys != null).ToDictionary(x => x.i, x => (IReadOnlyList<string>)x.d.SourceKeys!),
                snapshot);
            var hooks = ListSourceService.ImportHooks(spec!, Owner.Id.ToString("N"), plan.EntryKeys, plan.SnapshotKeys);
            return Ok<ApplyResultDto>(await H.Service.ApplyAsync(Access, entries, null, null, "import-" + Guid.NewGuid().ToString("N"), None, hooks));

            Placeholder Placeholder(ApplyEntryDto dto)
            {
                Assert.True(PlaceholderRules.TryCreate(dto.Placeholder, Owner.Id.ToString("N"), DateTime.UtcNow, out var placeholder, out var why), why);
                placeholder.SourceKey = dto.SourceKey;
                return placeholder;
            }
        }

        public List<string> Order() => Doc.Order.Select(t => ListPlaceholderOrder.PlaceholderIdOf(t) is { } id ? Describe(Doc.Items.First(p => p.Id == id)) : "REAL").ToList();

        public static string Describe(Placeholder p) => p.Kind switch
        {
            PlaceholderKinds.Season => $"{p.TmdbId}:S{p.SeasonNumber}",
            PlaceholderKinds.Episodes => $"{p.TmdbId}:S{p.SeasonNumber}E{string.Join(",", p.Episodes.Select(e => e.E))}",
            _ => $"{p.TmdbId}",
        };

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public async Task TheFetchReturnsGroupedPreparedEntriesWithEveryKeyAndLibraryMatches()
    {
        using var w = new World();
        w.Page("chronolists-mcu.html");
        var ironMan = w.H.Host.AddItem(tmdb: 1726);
        w.H.Library.Matches[("movie", 1726)] = new LibraryMatch(ironMan, "movie", Array.Empty<Guid>(), true);

        var fetched = await w.FetchAsync();

        Assert.Equal((true, 13, 40, 40), (fetched.Grouped, fetched.Entries.Count, fetched.SnapshotKeys!.Count, fetched.Total));
        Assert.Equal(Enumerable.Range(0, 13), fetched.Entries.Select(e => e.Index!.Value));
        Assert.Equal(fetched.Entries.SelectMany(e => e.SourceKeys!), fetched.SnapshotKeys);
        Assert.Equal(ironMan.ToString("N"), fetched.Entries[5].Prepared!.Match!.InLibrary!.ItemId);
        Assert.Null(fetched.Entries[6].Prepared!.Match!.InLibrary);
        // No show of the list is in the library: one series lookup per show, no per-run lookups.
        var tvLookups = w.H.Library.Calls.Where(c => c.Scope.TmdbId is 241388 or 61550 or 1403).ToList();
        Assert.Equal(3, tvLookups.Count);
        Assert.All(tvLookups, c => Assert.Equal(PlaceholderKinds.Series, c.Scope.Kind));
        w.AssertOnlySeasonCountLookups(); // no title lookups

        // The wire shape: prepared + sourceKeys present on grouped entries, absent (not null) elsewhere.
        var json = JsonSerializer.Serialize(fetched);
        Assert.Contains("\"prepared\":{", json, StringComparison.Ordinal);
        Assert.Contains("\"grouped\":true", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"sourceKeys\":null", JsonSerializer.Serialize(SourceListEntryWithoutGroups()), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunsAreOnlyLookedUpInTheLibraryWhenTheirShowAndSeasonAreThere()
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        var arrow = Guid.NewGuid();
        var arrowEpisode = Guid.NewGuid();
        w.H.Library.Matches[("series", 1412)] = new LibraryMatch(arrow, "series", Array.Empty<Guid>(), false);
        w.H.Library.Matches[("season", 1412)] = new LibraryMatch(arrow, "season", new[] { arrowEpisode }, false);
        w.H.Library.Matches[("episodes", 1412)] = new LibraryMatch(arrowEpisode, "episodes", new[] { arrowEpisode }, true);

        var fetched = await w.FetchAsync();

        // Arrow: one series lookup, one per season (S1, S2, S3), and the S3 runs themselves; other shows: series only.
        var arrowCalls = w.H.Library.Calls.Where(c => c.Scope.TmdbId == 1412).Select(c => c.Scope.Kind).ToList();
        Assert.Equal(1, arrowCalls.Count(k => k == "series"));
        Assert.Equal(3, arrowCalls.Count(k => k == "season"));
        Assert.Equal(6, arrowCalls.Count(k => k == "episodes")); // Arrow 3x01–3x06 are six one-episode runs
        Assert.Equal("season", fetched.Entries[0].Prepared!.Match!.InLibrary!.Kind); // a whole season answers with the season match
        Assert.Equal("episodes", fetched.Entries[3].Prepared!.Match!.InLibrary!.Kind);
        Assert.All(w.H.Library.Calls.Where(c => c.Scope.TmdbId != 1412), c => Assert.Equal("series", c.Scope.Kind));
    }

    private static ImportEntryDto SourceListEntryWithoutGroups() => ListSourceService.ToEntry(new SourceItem("movie", 1, null, null, "M", 2020, null, null, null), 0);

    [Fact]
    public async Task RestrictedViewersGetOnlyTheShowsTheyMaySeeCheckedOncePerTitle()
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        var viewer = w.H.NewUser("kid", maxRating: 10);
        var checks = new List<string>();
        w.H.Reply = request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            lock (checks)
            {
                checks.Add(path);
            }

            // Constantine is TV-MA, the rest TV-PG.
            return path.StartsWith("/api/v1/tv/", StringComparison.Ordinal)
                ? IntegrationTransport.Response("{\"contentRatings\":{\"results\":[{\"iso_3166_1\":\"US\",\"rating\":\"" + (path.EndsWith("/60743", StringComparison.Ordinal) ? "R" : "PG") + "\"}]}}")
                : IntegrationTransport.Response("{\"pageInfo\":{\"pages\":1},\"results\":[]}");
        };
        w.H.Plugin.Plugin.Configuration.JellyseerrEnabled = true;
        w.H.Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
        w.H.Plugin.Plugin.Configuration.JellyseerrApiKey = "k";

        var fetched = Ok<SourceFetchResponse>(await w.H.Sources.FetchAsync(viewer, DctvUrl, None));

        Assert.DoesNotContain(fetched.Entries, e => e.Ids!.Tmdb == 60743);
        Assert.Equal(13, fetched.Entries.Count);
        Assert.Equal(57, fetched.SnapshotKeys!.Count);
        Assert.Equal(3, checks.Count(c => c.StartsWith("/api/v1/tv/", StringComparison.Ordinal))); // 3 shows, not 60 episodes
    }

    // ── Import → sync ───────────────────────────────────────────────────

    [Theory]
    [InlineData(true)]
    [InlineData(false)] // the import UI as built: only each entry's first key; the server expands groups itself
    public async Task AnImportedWatchOrderSyncsAsANoOpWithEveryEpisodeOwned(bool sendGroupKeys)
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        var fetched = await w.FetchAsync();

        var applied = await w.Import(fetched, sendGroupKeys);

        Assert.Equal(16, applied.Added.Count);
        var source = w.Doc.Source!;
        Assert.Equal(("chronolists", "chronolists", DctvUrl), (source.Kind, source.Provider, source.Url));
        Assert.Equal(60, source.Owned.Count);
        Assert.Equal(60, source.LastSnapshotKeys.Count);
        var arrowS1 = w.Doc.Items.First(p => p.Kind == PlaceholderKinds.Season && p.SeasonNumber == 1);
        Assert.Equal("tv|1412|1|1", arrowS1.SourceKey);
        Assert.All(Enumerable.Range(1, 23), e => Assert.Equal(arrowS1.Id, source.Owned[$"tv|1412|1|{e}"].PhId));
        Assert.Equal(new[] { "1412:S1", "1412:S2", "60735:S1E1", "1412:S3E1" }, w.Order().Take(4));

        var sync = await w.Sync();
        Assert.Equal(("ok", 0, 0, 0), (sync.State, sync.Added, sync.Removed, sync.Unresolved));
        Assert.Equal(16, w.Doc.Items.Count);
        w.AssertOnlySeasonCountLookups(); // exact source: never a title lookup
    }

    [Fact]
    public async Task SkippingAGroupInReviewDeclinesEveryEpisodeOfIt()
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        var fetched = await w.FetchAsync();

        await w.Import(fetched, sendGroupKeys: false, skip: i => i == 1); // Arrow S2 skipped

        Assert.All(Enumerable.Range(1, 23), e => Assert.True(w.Doc.Source!.UserRemovedKeys.ContainsKey($"tv|1412|2|{e}")));
        Assert.Equal(0, (await w.Sync()).Added); // never added back
        Assert.DoesNotContain("1412:S2", w.Order());
    }

    [Fact]
    public async Task ASyncWithoutAnImportBuildsTheGroupsItselfWithoutSeerr()
    {
        using var w = new World();
        w.Page("chronolists-mcu.html");
        var ironMan = w.H.Host.AddItem(tmdb: 1726);
        w.H.Library.Matches[("movie", 1726)] = new LibraryMatch(ironMan, "movie", Array.Empty<Guid>(), true);
        w.H.Lookup.IsConfigured = false;
        Assert.False(w.H.ImportResolver.IsAvailable); // no Seerr at all
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);

        var sync = await w.Sync();

        Assert.Equal(("ok", 13), (sync.State, sync.Added));
        // Without Seerr nothing confirms a whole season (review r1 F23): every run is an episodes placeholder.
        Assert.Equal(new[] { "241388:S1E1,2,3,4", "1771", "61550:S1E1,2,3,4,5,6,7,8", "61550:S2E1,2,3,4,5,6,7,8,9,10", "299537", "REAL", "10138", "1724", "10195", "24428", "1403:S1E1,2,3,4,5,6,7", "76338", "1403:S1E8,9,10" }, w.Order());
        Assert.Equal(new[] { ironMan.ToString("N") }, w.Doc.Source!.Owned["movie|1726||"].ItemIds);
        Assert.Equal(40, w.Doc.Source.Owned.Count);
        Assert.Equal(0, (await w.Sync()).Added);
    }

    // Phase 5 merge (C1): a run whose episodes are partly in the library goes in as those real episodes, in place, plus
    // the run's placeholder for the rest; each real episode is owned by its own key and the placeholder by every key of
    // the run, so a key that leaves takes exactly its own episode with it.
    [Theory]
    [InlineData(true)] // URL import (the review sends every key of each entry)
    [InlineData(false)] // a sync without an import
    public async Task ARunPartlyInTheLibraryGoesInAsRealEpisodesPlusItsPlaceholderEachEpisodeOwnedByItsKey(bool viaImport)
    {
        using var w = new World(realLibrary: true);
        // Show 88 1x01, Show 77 3x01, then Show 88 1x02–1x04 (one run), then 77 3x02. The library has 88 1x02 and 1x03.
        var episodes = new[] { Ep(8, 1, 1, "2020-01-01"), Ep(7, 3, 1, "2020-01-02"), Ep(8, 1, 2, "2020-01-08"), Ep(8, 1, 3, "2020-01-15"), Ep(8, 1, 4, "2020-01-22"), Ep(7, 3, 2, "2020-01-23") };
        string Html(IEnumerable<string> list) => Page("{\"l\":[" + string.Join(",", list) + "],\"m\":{" + Show(7, 77, "Seventy", "Season 3") + "," + Show(8, 88, "Eighty") + "}}");
        w.H.Fetcher.Items = Read(Html(episodes)).Items.ToList();
        var show = w.H.Host.AddSeries(tmdb: 88, tvdb: 1088);
        var e2 = w.H.Host.AddEpisode(show, 1, 2);
        var e3 = w.H.Host.AddEpisode(show, 1, 3);

        if (viaImport)
        {
            var fetched = await w.FetchAsync();
            var library = fetched.Entries[2].Prepared!.Match!.InLibrary!;
            Assert.Equal(("episodes", false), (library.Kind, library.Complete));
            Assert.Equal(new[] { e2.ToString("N"), e3.ToString("N") }, library.EpisodeItemIds);
            w.H.Host.LibraryQueries = 0;
            await w.Import(fetched, sendGroupKeys: true);
            // The apply's C1 expansion looks each show up once and each (show, season) once, not once per entry: show 77
            // (not in the library), show 88 and its season 1 (without the memo: 6 queries for these 4 entries).
            Assert.Equal(3, w.H.Host.LibraryQueries);
        }
        else
        {
            Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true, RemoveDropped = true }, None)).StatusCode);
            var first = await w.Sync();
            Assert.Equal(("ok", 6), (first.State, first.Added)); // 4 placeholders + 2 real episodes
        }

        Assert.Equal(new[] { "88:S1E1", "77:S3E1", "REAL", "REAL", "88:S1E2,3,4", "77:S3E2" }, w.Order());
        Assert.Equal(new[] { e2, e3 }, w.H.Host.Resolved(w.List.Info.Id));
        var run = w.Doc.Items.Single(p => p.Kind == PlaceholderKinds.Episodes && p.Episodes.Count == 3);
        Assert.Equal(new[] { (1, 2), (1, 3) }, run.Filled.Select(f => (f.S, f.E)));
        var owned = w.Doc.Source!.Owned;
        Assert.All(new[] { 2, 3, 4 }, e => Assert.Equal(run.Id, owned[$"tv|88|1|{e}"].PhId));
        Assert.Equal(new[] { e2.ToString("N") }, owned["tv|88|1|2"].ItemIds);
        Assert.Equal(new[] { e3.ToString("N") }, owned["tv|88|1|3"].ItemIds);
        Assert.Empty(owned["tv|88|1|4"].ItemIds);
        Assert.Equal(6, owned.Count);

        var again = await w.Sync();
        Assert.Equal(("ok", 0, 0, 0), (again.State, again.Added, again.Removed, again.Unresolved));
        w.AssertOnlySeasonCountLookups(); // exact source: never a title lookup

        // 1x03 leaves the watch order: its own episode goes and it is taken out of the run; 1x02 and the rest stay.
        w.H.Fetcher.Items = Read(Html(episodes.Where((_, i) => i != 3))).Items.ToList();
        var dropped = await w.Sync();
        Assert.Equal(("ok", 0, 2), (dropped.State, dropped.Added, dropped.Removed));
        Assert.Equal(new[] { e2 }, w.H.Host.Resolved(w.List.Info.Id));
        run = w.Doc.Items.Single(p => p.Id == run.Id);
        Assert.Equal(new[] { 2, 4 }, run.Episodes.Select(e => e.E));
        Assert.Equal(new[] { (1, 2) }, run.Filled.Select(f => (f.S, f.E)));
        Assert.False(w.Doc.Source!.Owned.ContainsKey("tv|88|1|3"));
        Assert.Empty(w.Doc.Source.UserRemovedKeys); // left the source: may come back
        Assert.Equal(new[] { e2.ToString("N") }, w.Doc.Source.Owned["tv|88|1|2"].ItemIds);
    }

    // ── Ordered insertion (all ordered sources) ─────────────────────────

    [Fact]
    public async Task NewEpisodesInTheMiddleOfTheWatchOrderLandBetweenTheirNeighbours()
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        await w.Import(await w.FetchAsync(), sendGroupKeys: true);
        var before = w.Order();

        // Upstream inserts a newly listed crossover episode between The Flash 1x02 and Arrow 3x02, and a new movie at
        // the very start.
        var items = w.H.Fetcher.Items;
        var flash102 = items.FindIndex(i => i.Key == "tv|60735|1|2");
        items.Insert(flash102 + 1, new SourceItem("tv", 89247, null, null, "Batwoman", 2019, 1, 9, null) { Details = new SourceItemDetails("Crisis", "2019-12-08", null, null, "Season 1") });
        items.Insert(0, new SourceItem("movie", 209112, null, null, "Batman v Superman", 2016, null, null, null) { Details = new SourceItemDetails(null, "2016-03-23", null, null, null) });

        var sync = await w.Sync();

        Assert.Equal(2, sync.Added);
        var after = w.Order();
        Assert.Equal("209112", after[0]); // no preceding entry in the list: before the nearest following one
        Assert.Equal(new[] { "60735:S1E2", "89247:S1E9", "1412:S3E2" }, after.Skip(after.IndexOf("60735:S1E2")).Take(3));
        Assert.Equal(before, after.Where(t => t is not ("209112" or "89247:S1E9")));
        Assert.Equal(w.Doc.Order.Count, w.Doc.Order.Distinct().Count());
    }

    [Fact]
    public async Task ARealItemAddedBySyncGoesToItsSpotInJellyfinsOrderToo()
    {
        using var w = new World();
        w.H.Fetcher.Exact = false; // any ordered source (here: a TMDB-style movie list resolved through Seerr)
        w.H.Plugin.Plugin.Configuration.JellyseerrEnabled = true;
        w.H.Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
        w.H.Plugin.Plugin.Configuration.JellyseerrApiKey = "k";
        foreach (var id in new[] { 1, 2, 3, 862 })
        {
            w.H.Lookup.Details[("movie", id)] = new TitleDetails(FakeImportLookup.Movie(id, "Movie " + id, "2020-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
        }

        var toyStory = w.H.Host.AddItem(tmdb: 862);
        w.H.Library.Matches[("movie", 862)] = new LibraryMatch(toyStory, "movie", Array.Empty<Guid>(), true);
        var existing = w.H.Host.AddItem(tmdb: 3);
        w.H.Library.Matches[("movie", 3)] = new LibraryMatch(existing, "movie", Array.Empty<Guid>(), true);
        SourceItem M(int id) => new("movie", id, null, null, "Movie " + id, 2020, null, null, null);
        w.H.Fetcher.Items = new List<SourceItem> { M(1), M(3), M(2) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = "https://mdblist.com/lists/me/order", SyncEnabled = true }, None)).StatusCode);
        Assert.Equal(3, (await w.Sync()).Added);
        Assert.Equal(new[] { existing }, w.H.Host.Resolved(w.List.Info.Id));

        // Toy Story (in the library) is new upstream between Movie 1 and Movie 3.
        w.H.Fetcher.Items = new List<SourceItem> { M(1), M(862), M(3), M(2) };
        Assert.Equal(1, (await w.Sync()).Added);

        Assert.Equal(new[] { "1", "REAL", "REAL", "2" }, w.Order());
        Assert.Equal(new[] { toyStory, existing }, w.H.Host.Resolved(w.List.Info.Id)); // Jellyfin's own order agrees
    }

    [Fact]
    public void AnchorsUseOwnedTokensThenEquivalentPlaceholdersAndFallBackToTheEnd()
    {
        var owned = Movie(1);
        var handAdded = Movie(3);
        var item = Guid.NewGuid();
        var doc = new ListDoc { Items = new List<Placeholder> { owned, handAdded }, Source = new ListSource() };
        ListSourceProvenance.RecordAdded(doc.Source, "movie|1||", owned.Id, null);
        ListSourceProvenance.RecordAdded(doc.Source, "movie|2||", null, item.ToString("N"));
        var order = new List<string> { E(item), P(handAdded.Id), P(owned.Id) }; // an editor reordered the list
        var keys = new[] { "movie|9||", "movie|1||", "movie|8||", "movie|2||", "movie|3||", "movie|7||" };

        var anchors = ListSourcePlacement.Anchors(doc, order, keys, new Dictionary<int, int> { [0] = 0, [1] = 2, [2] = 5 });

        Assert.Equal(new EntryAnchor(null, P(owned.Id)), anchors[0]); // first in the source: before the next present one
        Assert.Equal(new EntryAnchor(P(owned.Id), null), anchors[1]); // after its preceding source entry, wherever it is
        Assert.Equal(new EntryAnchor(P(handAdded.Id), null), anchors[2]); // movie|3 is present through an equivalent placeholder
        Assert.Empty(ListSourcePlacement.Anchors(new ListDoc(), new List<string>(), keys, new Dictionary<int, int> { [0] = 0 }));
    }

    // ── Per-episode provenance on run placeholders ──────────────────────

    private static (ListDoc Doc, Placeholder Run, Placeholder Season) RunDoc()
    {
        var run = Ph("{\"kind\":\"episodes\",\"tmdbId\":1412,\"title\":\"Arrow\",\"seasonNumber\":3,\"episodes\":[{\"s\":3,\"e\":1,\"airDate\":\"2014-10-08\"},{\"s\":3,\"e\":2,\"airDate\":\"2014-10-15\"},{\"s\":3,\"e\":3,\"airDate\":\"2014-10-22\"}],\"releaseDate\":\"2014-10-08\"}");
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":60735,\"title\":\"The Flash\",\"seasonNumber\":2,\"episodeTotal\":2}");
        var doc = new ListDoc { Items = new List<Placeholder> { run, season }, Source = new ListSource { RemoveDropped = true } };
        foreach (var e in new[] { 1, 2, 3 })
        {
            ListSourceProvenance.RecordAdded(doc.Source, $"tv|1412|3|{e}", run.Id, null);
        }

        ListSourceProvenance.RecordAdded(doc.Source, "tv|60735|2|1", season.Id, null);
        ListSourceProvenance.RecordAdded(doc.Source, "tv|60735|2|2", season.Id, null);
        doc.Source.LastSnapshotKeys = doc.Source.Owned.Keys.ToList();
        return (doc, run, season);
    }

    [Fact]
    public void AnEpisodeThatLeavesIsTakenOutOfItsRunAndARunWhoseEpisodesAllLeftIsRemoved()
    {
        var (doc, run, season) = RunDoc();

        // Arrow 3x02 left; 3x01 and 3x03 stay. The Flash S2E2 left: the season placeholder stays (shared) but now stands
        // for S2E1 only (review round: else swap-in would bring S2E2 back), the key is released.
        var plan = ListSourceProvenance.PlanDrops(doc, new[] { "tv|1412|3|1", "tv|1412|3|3", "tv|60735|2|1" }, new Dictionary<string, int>());
        Assert.Empty(plan.PlaceholderIds);
        Assert.Equal(new[] { (run.Id, 3, 2) }, plan.Trims);
        Assert.Equal(new[] { "tv|1412|3|2", "tv|60735|2|2" }, plan.Released.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal(season.Id, Assert.Single(plan.Narrowings).PhId);

        Assert.Equal(2, ListSourceProvenance.ApplyDrops(doc, plan, Array.Empty<string>()));
        Assert.Equal(new[] { 1, 3 }, run.Episodes.Select(e => e.E));
        Assert.Contains(season, doc.Items);
        Assert.Equal((PlaceholderKinds.Episodes, (int?)null), (season.Kind, season.EpisodeTotal));
        Assert.Equal(new[] { (2, 1) }, season.Episodes.Select(e => (e.S, e.E)));
        Assert.Equal(season.Id, doc.Source!.Owned["tv|60735|2|1"].PhId);
        Assert.False(doc.Source!.Owned.ContainsKey("tv|1412|3|2"));
        Assert.False(doc.Source.Owned.ContainsKey("tv|60735|2|2"));
        Assert.Empty(doc.Source.UserRemovedKeys); // left the source ≠ removed by an editor

        // Everything of the run left: the placeholder goes, once.
        var all = ListSourceProvenance.PlanDrops(doc, new[] { "tv|60735|2|1" }, new Dictionary<string, int>());
        Assert.Equal(new[] { run.Id }, all.PlaceholderIds);
        Assert.Empty(all.Trims);
        ListSourceProvenance.ApplyDrops(doc, all, Array.Empty<string>());
        Assert.DoesNotContain(run, doc.Items);
    }

    [Fact]
    public void SwapInGivesEachEpisodeKeyItsOwnItemAndAnEditorRemovalTombstonesOnlyThatEpisode()
    {
        var (doc, run, season) = RunDoc();
        var ep1 = Guid.NewGuid();
        var ep2 = Guid.NewGuid();

        // Phase 3 records the fill, then calls the hook (partly filled: the run placeholder stays).
        run.Filled.Add(new FilledEpisode { ItemId = ep1.ToString("N"), S = 3, E = 1 });
        Assert.True(ListSourceProvenance.OnSwapped(doc, run, new[] { ep1.ToString("N") }));
        Assert.Equal(new[] { ep1.ToString("N") }, doc.Source!.Owned["tv|1412|3|1"].ItemIds);
        Assert.Empty(doc.Source.Owned["tv|1412|3|2"].ItemIds);
        Assert.Equal(run.Id, doc.Source.Owned["tv|1412|3|2"].PhId);

        // Retired with the explicit flag (the swap service's call shape): every key lets go of the placeholder.
        run.Filled.Add(new FilledEpisode { ItemId = ep2.ToString("N"), S = 3, E = 2 });
        Assert.True(ListSourceProvenance.OnSwapped(doc, run, new[] { ep2.ToString("N") }, retired: true));
        Assert.All(new[] { 1, 2, 3 }, e => Assert.Null(doc.Source.Owned[$"tv|1412|3|{e}"].PhId));
        Assert.Equal(new[] { ep2.ToString("N") }, doc.Source.Owned["tv|1412|3|2"].ItemIds);

        // An item without a recorded episode (a collection's Season item) belongs to every key of the placeholder.
        var seasonItem = Guid.NewGuid();
        ListSourceProvenance.OnSwapped(doc, season, new[] { seasonItem.ToString("N") });
        Assert.Equal(new[] { seasonItem.ToString("N") }, doc.Source.Owned["tv|60735|2|2"].ItemIds);

        // The editor removes episode 1 from the playlist: only that episode is tombstoned.
        doc.Items.Remove(run);
        var removed = ListSourceProvenance.DetectUserRemovals(doc, new Dictionary<string, int> { [ep2.ToString("N")] = 1, [seasonItem.ToString("N")] = 1 }, DateTime.UtcNow);
        Assert.Equal(2, removed); // 3x01 (its item is gone) and 3x03 (never filled, placeholder retired)
        Assert.True(doc.Source.UserRemovedKeys.ContainsKey("tv|1412|3|1"));
        Assert.False(doc.Source.UserRemovedKeys.ContainsKey("tv|1412|3|2"));
    }

    [Fact]
    public async Task ANewEpisodeOfASeasonAlreadyInTheListIsAttachedNotDuplicated()
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        await w.Import(await w.FetchAsync(), sendGroupKeys: true);
        var arrowS1 = w.Doc.Items.First(p => p.Kind == PlaceholderKinds.Season && p.SeasonNumber == 1);

        // Upstream lists a 24th episode of Arrow season 1 (right after 1x23).
        var items = w.H.Fetcher.Items;
        items.Insert(23, new SourceItem("tv", 1412, null, null, "Arrow", 2013, 1, 24, null) { Details = new SourceItemDetails("Bonus", "2013-05-16", null, null, "Season 1") });

        var sync = await w.Sync();

        Assert.Equal((0, 0), (sync.Added, sync.Unresolved));
        Assert.Equal(16, w.Doc.Items.Count);
        Assert.Equal(arrowS1.Id, w.Doc.Source!.Owned["tv|1412|1|24"].PhId);
        Assert.Contains("tv|1412|1|24", w.Doc.Source.LastSnapshotKeys);
    }

    [Fact]
    public async Task RemoveDroppedTrimsARunInTheListAndKeepsTheRest()
    {
        using var w = new World();
        var items = new List<SourceItem>();
        foreach (var e in new[] { 1, 2, 3 })
        {
            items.Add(new SourceItem("tv", 1412, null, null, "Arrow", 2014, 3, e, null) { Details = new SourceItemDetails("E" + e, "2014-10-0" + e, null, null, "Season 3") });
        }

        items.Add(new SourceItem("movie", 5, null, null, "Movie 5", 2020, null, null, null) { Details = new SourceItemDetails(null, "2020-01-01", null, null, null) });
        items.Add(new SourceItem("tv", 1412, null, null, "Arrow", 2014, 3, 4, null) { Details = new SourceItemDetails("E4", "2014-10-29", null, null, "Season 3") });
        w.H.Fetcher.Items = items;
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true, RemoveDropped = true }, None)).StatusCode);
        Assert.Equal(3, (await w.Sync()).Added);
        Assert.Equal(new[] { "1412:S3E1,2,3", "5", "1412:S3E4" }, w.Order());

        w.H.Fetcher.Items = items.Where(i => i.Key != "tv|1412|3|2").ToList();
        var sync = await w.Sync();

        Assert.Equal((0, 1), (sync.Added, sync.Removed));
        Assert.Equal(new[] { "1412:S3E1,3", "5", "1412:S3E4" }, w.Order());
        Assert.False(w.Doc.Source!.Owned.ContainsKey("tv|1412|3|2"));

        // It comes back later: a new single-episode entry between 3x01 and 3x03, which splits their run (review round 7).
        w.H.Fetcher.Items = items;
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "1412:S3E1", "1412:S3E2", "1412:S3E3", "5", "1412:S3E4" }, w.Order());
    }

    // ── Review round ────────────────────────────────────────────────────

    private static SourceItem Arrow(int season, int e) => new("tv", 1412, null, null, "Arrow", 2014, season, e, null) { Details = new SourceItemDetails("E" + e, "2014-10-" + (10 + e).ToString(CultureInfo.InvariantCulture), null, null, "Season " + season) };

    private static SourceItem Film(int id) => new("movie", id, null, null, "Movie " + id, 2020, null, null, null) { Details = new SourceItemDetails(null, "2020-01-01", null, null, null) };

    [Fact]
    public async Task EntriesThatAreInThePlaylistAsUnownedRealItemsAnchorNewNeighbours()
    {
        using var w = new World();
        // A hand-made playlist already holds the library movies A (1) and B (2); the source lists [A, B].
        var a = w.H.Host.AddItem(tmdb: 1);
        var b = w.H.Host.AddItem(tmdb: 2);
        w.H.Library.Matches[("movie", 1)] = new LibraryMatch(a, "movie", Array.Empty<Guid>(), true);
        w.H.Library.Matches[("movie", 2)] = new LibraryMatch(b, "movie", Array.Empty<Guid>(), true);
        w.List.Raw.Add(new RawEntry(a, true));
        w.List.Raw.Add(new RawEntry(b, true));
        w.H.Fetcher.Items = new List<SourceItem> { Film(1), Film(2) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);
        Assert.Equal(0, (await w.Sync()).Added); // both already in the list: accounted, never owned
        Assert.Empty(w.Doc.Source!.Owned);

        // Upstream: [A, X, B]. X goes between them, not to the end.
        w.H.Fetcher.Items = new List<SourceItem> { Film(1), Film(3), Film(2) };
        Assert.Equal(1, (await w.Sync()).Added);

        Assert.Equal(new[] { "REAL", "3", "REAL" }, w.Order());
        Assert.Equal(new[] { a, b }, w.H.Host.Resolved(w.List.Info.Id));
    }

    [Fact]
    public void AnchorsFindUnownedRealEpisodesAndSeasonsThroughTheLibrary()
    {
        var ep1 = Guid.NewGuid();
        var ep3 = Guid.NewGuid();
        var season2 = Guid.NewGuid();
        var identities = new Dictionary<Guid, IReadOnlyList<string>>
        {
            [ep1] = new[] { "tv|5|1|1" },
            [ep3] = new[] { "tv|5|1|3" },
            [season2] = new[] { "tv|5|2|" },
        };
        var asked = new List<Guid>();
        IReadOnlyList<string> KeysOf(Guid id)
        {
            asked.Add(id);
            return identities[id];
        }

        var order = new List<string> { E(ep1), E(ep3), E(season2) };
        var keys = new[] { "tv|5|1|1", "tv|5|1|2", "tv|5|1|3", "tv|5|2|1", "tv|5|2|2", "movie|9||" };
        var doc = new ListDoc { Source = new ListSource() };

        var anchors = ListSourcePlacement.Anchors(doc, order, keys, new Dictionary<int, int> { [0] = 1, [1] = 5 }, KeysOf);

        Assert.Equal(new EntryAnchor(E(ep1), null), anchors[0]); // 1x02 right after the real 1x01
        Assert.Equal(new EntryAnchor(E(season2), null), anchors[1]); // after the season item that stands for 2x01/2x02
        Assert.Equal(3, asked.Count); // each real item asked once
        Assert.Empty(ListSourcePlacement.Anchors(doc, order, keys, new Dictionary<int, int> { [0] = 1 })); // without the library: nothing to anchor on
    }

    [Fact]
    public void AReleasedEpisodeKeepsItsOwnItemWhenJellyfinDidNotRemoveItAndTheNextSyncRetries()
    {
        var (doc, run, _) = RunDoc();
        var item = Guid.NewGuid();
        var itemN = item.ToString("N");
        run.Filled.Add(new FilledEpisode { ItemId = itemN, S = 3, E = 2 });
        ListSourceProvenance.OnSwapped(doc, run, new[] { itemN });
        var staying = new[] { "tv|1412|3|1", "tv|1412|3|3", "tv|60735|2|1", "tv|60735|2|2" };
        var occurrences = new Dictionary<string, int> { [itemN] = 1 };

        // 3x02 left the source: it is trimmed out of the run and its own item is to be removed — which fails.
        var plan = ListSourceProvenance.PlanDrops(doc, staying, occurrences);
        Assert.Equal(new[] { item }, plan.ItemIds);
        Assert.Equal(new[] { "tv|1412|3|2" }, plan.Released);
        Assert.Equal(1, ListSourceProvenance.ApplyDrops(doc, plan, Array.Empty<string>())); // the trim only
        var owned = doc.Source!.Owned["tv|1412|3|2"];
        Assert.Null(owned.PhId);
        Assert.Equal(new[] { itemN }, owned.ItemIds); // still owns its item

        // The next sync removes it.
        var retry = ListSourceProvenance.PlanDrops(doc, staying, occurrences);
        Assert.Equal(new[] { item }, retry.ItemIds);
        Assert.Empty(retry.Released);
        Assert.Equal(1, ListSourceProvenance.ApplyDrops(doc, retry, new[] { itemN }));
        Assert.False(doc.Source.Owned.ContainsKey("tv|1412|3|2"));
        Assert.Empty(doc.Source.UserRemovedKeys);
    }

    [Fact]
    public async Task APlaceholderAnEditorAddsWhileTheSyncFetchesIsNotDuplicated()
    {
        using var w = new World();
        w.H.Fetcher.Items = new List<SourceItem> { Arrow(3, 2), Arrow(3, 3), Film(5) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);
        Assert.Equal(2, (await w.Sync()).Added);

        // Upstream lists Arrow 4x02; while the sync fetches, an editor adds an Arrow season 4 placeholder.
        w.H.Fetcher.Items = new List<SourceItem> { Arrow(3, 2), Arrow(3, 3), Arrow(4, 2), Film(5) };
        w.H.Fetcher.OnFetch = async () =>
        {
            w.H.Fetcher.OnFetch = null;
            var season = Ph("{\"kind\":\"season\",\"tmdbId\":1412,\"title\":\"Arrow\",\"seasonNumber\":4}");
            Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, new List<ApplyEntry> { new(0, null, season) }, null, null, null, None));
        };

        var sync = await w.Sync();

        Assert.Equal((0, 0), (sync.Added, sync.Unresolved));
        Assert.Equal(new[] { "1412:S3E2,3", "5", "1412:S4" }, w.Order()); // no 4x02 placeholder next to the season
        Assert.False(w.Doc.Source!.Owned.ContainsKey("tv|1412|4|2")); // the editor's placeholder: present, not owned
        Assert.Contains("tv|1412|4|2", w.Doc.Source.LastSnapshotKeys);
        Assert.Equal(0, (await w.Sync()).Added);
    }

    private static SourceItem Eighty(int e) => new("tv", 88, null, 1088, "Eighty", 2020, 1, e, null) { Details = new SourceItemDetails("Ep " + e, "2020-01-" + e.ToString("00", CultureInfo.InvariantCulture), null, null, "Season 1") };

    // Review round: a new entry whose preceding source entry is an episode in the list as its own real item goes right
    // after that episode, not after the run's placeholder that every episode of the run shares.
    [Fact]
    public async Task ANewEntryAfterAFilledEpisodeOfARunGoesRightAfterThatEpisode()
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 88, tvdb: 1088);
        var e1 = w.H.Host.AddEpisode(show, 1, 1);
        var e2 = w.H.Host.AddEpisode(show, 1, 2);
        var movie = w.H.Host.AddItem(tmdb: 500);
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);
        await w.Sync();
        Assert.Equal(new[] { "REAL", "REAL", "88:S1", "6" }, w.Order());
        var season = w.Doc.Items.Single(p => p.Kind == PlaceholderKinds.Season);
        Assert.All(new[] { 1, 2, 3 }, e => Assert.Equal(season.Id, w.Doc.Source!.Owned[$"tv|88|1|{e}"].PhId));

        // Upstream: the library movie 500 between 1x01 and 1x02, and movie 7 (not in the library) between 1x02 and 1x03.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Film(500), Eighty(2), Film(7), Eighty(3), Film(6) };
        Assert.Equal(2, (await w.Sync()).Added);

        Assert.Equal(new[] { "REAL", "REAL", "REAL", "7", "88:S1", "6" }, w.Order());
        Assert.Equal(new[] { e1, movie, e2 }, w.H.Host.Resolved(w.List.Info.Id)); // Jellyfin's own order agrees
    }

    // Review round 7: a new entry between two unfilled episodes of one run placeholder splits the run, so it goes
    // between them rather than after the whole run (which would play it after every episode of the run).
    [Fact]
    public async Task ANewEntryBetweenUnfilledEpisodesOfARunSplitsTheRun()
    {
        using var w = new World(realLibrary: true);
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);
        await w.Sync();
        Assert.Equal(new[] { "88:S1", "6" }, w.Order());
        var runId = w.Doc.Items.Single(p => p.Kind == PlaceholderKinds.Season).Id;

        // Upstream: movie 7 between 1x01 and 1x02.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Film(7), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(1, (await w.Sync()).Added);

        Assert.Equal(new[] { "88:S1E1", "7", "88:S1E2,3", "6" }, w.Order());
        var owned = w.Doc.Source!.Owned;
        Assert.Equal(runId, owned["tv|88|1|1"].PhId);
        var secondId = owned["tv|88|1|2"].PhId;
        Assert.NotEqual(runId, secondId);
        Assert.Equal(secondId, owned["tv|88|1|3"].PhId);
        Assert.Equal("tv|88|1|2", w.Doc.Items.Single(p => p.Id == secondId).SourceKey);
        Assert.Equal(0, (await w.Sync()).Added);

        // An episodes run: movie 8 between 3x02 and 3x03 splits it the same way.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Film(7), Eighty(2), Eighty(3), Film(6), Arrow(3, 2), Arrow(3, 3), Arrow(3, 4) };
        Assert.Equal(1, (await w.Sync()).Added);
        var before = w.Order();
        Assert.Equal("1412:S3E2,3,4", before[^1]);
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Film(7), Eighty(2), Eighty(3), Film(6), Arrow(3, 2), Arrow(3, 3), Film(8), Arrow(3, 4) };
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "88:S1E1", "7", "88:S1E2,3", "6", "1412:S3E2,3", "8", "1412:S3E4" }, w.Order());
    }

    // Review round 8: a run whose later episode was already swapped in (it sits before the run's token) is split with
    // the first half's token moved before that episode, so the episodes arriving later still play in source order.
    [Fact]
    public async Task SplittingARunWithASwappedInLaterEpisodeKeepsTheSourceOrder()
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 88, tvdb: 1088);
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);
        await w.Sync();
        Assert.Equal(new[] { "88:S1", "6" }, w.Order());

        var e3 = w.H.Host.AddEpisode(show, 1, 3);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { "REAL", "88:S1", "6" }, w.Order());

        // Upstream: movie 7 between 1x01 and 1x02.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Film(7), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "88:S1E1", "7", "REAL", "88:S1E2,3", "6" }, w.Order());

        var e1 = w.H.Host.AddEpisode(show, 1, 1);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        var e2 = w.H.Host.AddEpisode(show, 1, 2);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { e1, e2, e3 }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(new[] { "REAL", "7", "REAL", "REAL", "6" }, w.Order());
    }

    // Review round 8: fills on both sides of the cut (1x01 and 1x04 swapped in) keep their order through the split.
    [Fact]
    public async Task SplittingARunWithFillsOnBothSidesKeepsTheSourceOrder()
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 88, tvdb: 1088);
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Eighty(3), Eighty(4), Film(6) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true }, None)).StatusCode);
        await w.Sync();
        var e4 = w.H.Host.AddEpisode(show, 1, 4);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        var e1 = w.H.Host.AddEpisode(show, 1, 1);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { e1, e4 }, w.H.Host.Resolved(w.List.Info.Id));

        // Upstream: movie 7 between 1x02 and 1x03.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Film(7), Eighty(3), Eighty(4), Film(6) };
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "REAL", "88:S1E1,2", "7", "REAL", "88:S1E3,4", "6" }, w.Order());

        var e2 = w.H.Host.AddEpisode(show, 1, 2);
        var e3 = w.H.Host.AddEpisode(show, 1, 3);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { e1, e2, e3, e4 }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(new[] { "REAL", "REAL", "7", "REAL", "REAL", "6" }, w.Order());
    }

    // Review round 8: when a filled episode of the first half sits after the second half's earliest fill, the halves
    // can't be ordered without moving real items: nothing is split.
    [Fact]
    public void ARunIsNotSplitWhenItsFillsCannotBeOrderedAroundTheCut()
    {
        var run = Ph("{\"kind\":\"episodes\",\"tmdbId\":88,\"title\":\"Eighty\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2},{\"s\":1,\"e\":3}]}");
        var (r1, r3) = (Guid.NewGuid(), Guid.NewGuid());
        run.Filled.Add(new FilledEpisode { ItemId = r1.ToString("N"), S = 1, E = 1 });
        run.Filled.Add(new FilledEpisode { ItemId = r3.ToString("N"), S = 1, E = 3 });
        ListDoc Doc(params string[] order)
        {
            var doc = new ListDoc { ListKind = ListKinds.Playlist, Items = new List<Placeholder> { Copy(run) }, Order = order.ToList(), Source = new ListSource() };
            foreach (var e in new[] { 1, 2, 3 })
            {
                ListSourceProvenance.RecordAdded(doc.Source, $"tv|88|1|{e}", run.Id, null);
            }

            doc.Source.Owned["tv|88|1|1"].ItemIds.Add(r1.ToString("N"));
            doc.Source.Owned["tv|88|1|3"].ItemIds.Add(r3.ToString("N"));
            return doc;
        }

        var keys = new List<string> { "tv|88|1|1", "tv|88|1|2", "movie|7||", "tv|88|1|3" };
        string R(Guid id) => ListPlaceholderOrder.RealToken(id, 0);

        // 1x03 before 1x01: no split, the order untouched.
        var crossed = Doc(R(r3), R(r1), P(run.Id));
        var order = crossed.Order.ToList();
        Assert.False(ListSourceProvenance.SplitRunsAround(crossed, order, keys, new[] { 2 }));
        Assert.Equal(crossed.Order, order);
        Assert.Single(crossed.Items);

        // In order: split, the first half's token just before 1x03.
        var straight = Doc(R(r1), R(r3), P(run.Id));
        order = straight.Order.ToList();
        Assert.True(ListSourceProvenance.SplitRunsAround(straight, order, keys, new[] { 2 }));
        Assert.Equal(new[] { R(r1), P(run.Id), R(r3), P(straight.Items[1].Id) }, order);
        Assert.Equal(new[] { 1 }, straight.Items[0].Filled.Select(f => f.E));
        Assert.Equal(new[] { 3 }, straight.Items[1].Filled.Select(f => f.E));

        static Placeholder Copy(Placeholder p) => System.Text.Json.JsonSerializer.Deserialize<Placeholder>(System.Text.Json.JsonSerializer.Serialize(p))!;
    }

    // Review round 9: only the run's own block of fills right before its token moves the first half's token. A second-half
    // fill elsewhere in the list (dragged to the top, or a presence fill) leaves the first half at the run's spot.
    [Fact]
    public void AFarAwayFillOfTheSecondHalfDoesNotMoveTheFirstHalf()
    {
        var run = Ph("{\"kind\":\"episodes\",\"tmdbId\":88,\"title\":\"Eighty\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2},{\"s\":1,\"e\":3},{\"s\":1,\"e\":4}]}");
        var (r3, r4, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        run.Filled.Add(new FilledEpisode { ItemId = r3.ToString("N"), S = 1, E = 3 });
        run.Filled.Add(new FilledEpisode { ItemId = r4.ToString("N"), S = 1, E = 4 });
        string R(Guid id) => ListPlaceholderOrder.RealToken(id, 0);
        ListDoc Doc(params string[] order)
        {
            var doc = new ListDoc { ListKind = ListKinds.Playlist, Items = new List<Placeholder> { Copy(run) }, Order = order.ToList(), Source = new ListSource() };
            foreach (var e in new[] { 1, 2, 3, 4 })
            {
                ListSourceProvenance.RecordAdded(doc.Source, $"tv|88|1|{e}", run.Id, null);
            }

            doc.Source.Owned["tv|88|1|3"].ItemIds.Add(r3.ToString("N"));
            doc.Source.Owned["tv|88|1|4"].ItemIds.Add(r4.ToString("N"));
            return doc;
        }

        // Source [A, E1, X, E2, E3, E4, B] (X new); the user dragged 1x03 to the top: [E3, A, E4, T, B].
        var keys = new List<string> { "movie|1||", "tv|88|1|1", "movie|7||", "tv|88|1|2", "tv|88|1|3", "tv|88|1|4", "movie|2||" };
        var dragged = Doc(R(r3), R(a), R(r4), P(run.Id), R(b));
        var order = dragged.Order.ToList();
        Assert.True(ListSourceProvenance.SplitRunsAround(dragged, order, keys, new[] { 2 }));
        Assert.Equal(new[] { R(r3), R(a), P(run.Id), R(r4), P(dragged.Items[1].Id), R(b) }, order);

        // A fill away from the token with nothing of the run's right before it: the halves stay at the run's spot.
        var away = Doc(R(r4), R(a), P(run.Id), R(b));
        order = away.Order.ToList();
        Assert.True(ListSourceProvenance.SplitRunsAround(away, order, keys, new[] { 2 }));
        Assert.Equal(new[] { R(r4), R(a), P(run.Id), P(away.Items[1].Id), R(b) }, order);

        static Placeholder Copy(Placeholder p) => System.Text.Json.JsonSerializer.Deserialize<Placeholder>(System.Text.Json.JsonSerializer.Serialize(p))!;
    }

    // Review round 9: a season narrowed into several chunks orders the chunks' tokens around the season's fills, so an
    // arrival of an earlier chunk goes before the fills of later chunks.
    [Fact]
    public void ANarrowedLongSeasonOrdersItsChunksAroundItsFills()
    {
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":5,\"title\":\"Soap\",\"seasonNumber\":1,\"episodeTotal\":150}");
        var (r5, r120, x) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        string R(Guid id) => ListPlaceholderOrder.RealToken(id, 0);
        var episodeKeys = Enumerable.Range(1, 150).Select(e => $"tv|5|1|{e}").ToList();
        var staying = episodeKeys.Where(k => k != "tv|5|1|7").ToList();
        ListDoc Doc(int[] filledEpisodes, params string[] order)
        {
            var ph = System.Text.Json.JsonSerializer.Deserialize<Placeholder>(System.Text.Json.JsonSerializer.Serialize(season))!;
            foreach (var e in filledEpisodes)
            {
                ph.Filled.Add(new FilledEpisode { ItemId = (e == 5 ? r5 : r120).ToString("N"), S = 1, E = e });
            }

            var doc = new ListDoc { ListKind = ListKinds.Playlist, Items = new List<Placeholder> { ph }, Order = order.ToList(), Source = new ListSource { RemoveDropped = true } };
            foreach (var key in episodeKeys)
            {
                ListSourceProvenance.RecordAdded(doc.Source, key, ph.Id, null);
            }

            return doc;
        }

        void Narrow(ListDoc doc)
        {
            ListSourceProvenance.ApplyDrops(doc, ListSourceProvenance.PlanDrops(doc, staying, new Dictionary<string, int>()), Array.Empty<string>());
            Assert.Equal(2, doc.Items.Count);
        }

        // [E120, T] -> [T1, E120, T2].
        var one = Doc(new[] { 120 }, R(x), R(r120), P(season.Id));
        Narrow(one);
        Assert.Equal(new[] { R(x), P(season.Id), R(r120), P(one.Items[1].Id) }, one.Order);

        // [E5, E120, T] -> [E5, T1, E120, T2].
        var both = Doc(new[] { 5, 120 }, R(r5), R(r120), P(season.Id));
        Narrow(both);
        Assert.Equal(new[] { R(r5), P(season.Id), R(r120), P(both.Items[1].Id) }, both.Order);

        // Crossed fills (E120 before E5) can't be ordered without moving real items: the tokens stay after them.
        var crossed = Doc(new[] { 5, 120 }, R(r120), R(r5), P(season.Id));
        Narrow(crossed);
        Assert.Equal(new[] { R(r120), R(r5), P(season.Id), P(crossed.Items[1].Id) }, crossed.Order);
    }

    // Review round 9, end to end: 1x120 is in the list, 1x07 leaves a 150-episode season, then 1x01 arrives: it plays
    // before 1x120.
    [Fact]
    public async Task AnEarlyEpisodeArrivingAfterALongSeasonIsNarrowedPlaysBeforeLaterOnes()
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 5, tvdb: 1005);
        static SourceItem Soap(int e) => new("tv", 5, null, 1005, "Soap", 2020, 1, e, null) { Details = new SourceItemDetails("Ep " + e, "2020-01-01", null, null, "Season 1") };
        var all = Enumerable.Range(1, 150).Select(Soap).ToList();
        w.H.Fetcher.Items = all.Append(Film(6)).ToList();
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true, RemoveDropped = true }, None)).StatusCode);
        await w.Sync();
        Assert.Equal(new[] { "5:S1", "6" }, w.Order());
        var e120 = w.H.Host.AddEpisode(show, 1, 120);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { "REAL", "5:S1", "6" }, w.Order());

        w.H.Fetcher.Items = all.Where(i => i.Episode != 7).Append(Film(6)).ToList();
        Assert.Equal(1, (await w.Sync()).Removed);
        var order = w.Order();
        Assert.Equal(4, order.Count);
        Assert.StartsWith("5:S1E1,2,3,4,5,6,8,", order[0], StringComparison.Ordinal);
        Assert.Equal("REAL", order[1]);
        Assert.StartsWith("5:S1E102,", order[2], StringComparison.Ordinal);

        var e1 = w.H.Host.AddEpisode(show, 1, 1);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { e1, e120 }, w.H.Host.Resolved(w.List.Info.Id));
    }

    // Review round: with removeDropped, an episode that left a whole-season run must not come back through the season
    // placeholder once it arrives in the library: the placeholder is narrowed to the episodes still listed.
    [Fact]
    public async Task AnEpisodeThatLeftAWholeSeasonRunIsNotSwappedInWhenItArrivesLater()
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 88, tvdb: 1088);
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(200, (await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = DctvUrl, SyncEnabled = true, RemoveDropped = true }, None)).StatusCode);
        Assert.Equal(2, (await w.Sync()).Added);
        Assert.Equal(new[] { "88:S1", "6" }, w.Order());
        var phId = w.Doc.Items.Single(p => p.Kind == PlaceholderKinds.Season).Id;

        // 1x02 leaves the watch order.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(3), Film(6) };
        var dropped = await w.Sync();
        Assert.Equal(("ok", 0, 1), (dropped.State, dropped.Added, dropped.Removed));
        Assert.Equal(new[] { "88:S1E1,3", "6" }, w.Order());
        var narrowed = w.Doc.Items.Single(p => p.Id == phId);
        Assert.Equal(new[] { ("Ep 1", "2020-01-01"), ("Ep 3", "2020-01-03") }, narrowed.Episodes.Select(e => (e.Title!, e.AirDate!)));
        Assert.Equal("2020-01-01", narrowed.ReleaseDate);
        Assert.Equal(new[] { "movie|6||", "tv|88|1|1", "tv|88|1|3" }, w.Doc.Source!.Owned.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.All(new[] { 1, 3 }, e => Assert.Equal(phId, w.Doc.Source.Owned[$"tv|88|1|{e}"].PhId));

        // 1x02 and 1x03 arrive in the library: only 1x03 goes in.
        var e2 = w.H.Host.AddEpisode(show, 1, 2);
        var e3 = w.H.Host.AddEpisode(show, 1, 3);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { e3 }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(new[] { e3.ToString("N") }, w.Doc.Source!.Owned["tv|88|1|3"].ItemIds);
        Assert.Equal(0, (await w.Sync()).Added);
        Assert.DoesNotContain(e2, w.H.Host.Resolved(w.List.Info.Id));

        // It comes back upstream: added again (it isn't tombstoned), as the library episode.
        w.H.Fetcher.Items = new List<SourceItem> { Eighty(1), Eighty(2), Eighty(3), Film(6) };
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Contains(e2, w.H.Host.Resolved(w.List.Info.Id));
    }

    [Fact]
    public void ASeasonPlaceholderIsOnlyNarrowedInPlaylistsWhenEpisodeKeysAloneStillOwnItAndLongSeasonsAreSplit()
    {
        Placeholder Season() => Ph("{\"kind\":\"season\",\"tmdbId\":5,\"title\":\"Soap\",\"seasonNumber\":1,\"episodeTotal\":150}");
        ListDoc Doc(Placeholder season, string kind, IEnumerable<string> keys)
        {
            var doc = new ListDoc { ListKind = kind, Items = new List<Placeholder> { season }, Order = new List<string> { P(season.Id), "x" }, Source = new ListSource { RemoveDropped = true } };
            foreach (var key in keys)
            {
                ListSourceProvenance.RecordAdded(doc.Source, key, season.Id, null);
            }

            return doc;
        }

        var episodeKeys = Enumerable.Range(1, 150).Select(e => $"tv|5|1|{e}").ToList();
        var staying = episodeKeys.Where(k => k != "tv|5|1|7").ToList();

        // A season key still owns it: the whole season is still listed.
        var withSeasonKey = Season();
        var doc = Doc(withSeasonKey, ListKinds.Playlist, episodeKeys.Append("tv|5|1|"));
        Assert.Empty(ListSourceProvenance.PlanDrops(doc, staying.Append("tv|5|1|").ToList(), new Dictionary<string, int>()).Narrowings);

        // A collection holds the season as one Season item: nothing to narrow.
        var inCollection = Season();
        Assert.Empty(ListSourceProvenance.PlanDrops(Doc(inCollection, ListKinds.Collection, episodeKeys), staying, new Dictionary<string, int>()).Narrowings);

        // A playlist: 149 episodes stay → one placeholder of 100 and one of 49 right after it, each owned by its keys,
        // fills carried over to the placeholder of their episode.
        var season = Season();
        var filledItem = Guid.NewGuid().ToString("N");
        season.Filled.Add(new FilledEpisode { ItemId = filledItem, S = 1, E = 120 });
        doc = Doc(season, ListKinds.Playlist, episodeKeys);
        var plan = ListSourceProvenance.PlanDrops(doc, staying, new Dictionary<string, int>());
        Assert.Equal(1, ListSourceProvenance.ApplyDrops(doc, plan, Array.Empty<string>()));
        Assert.Equal(2, doc.Items.Count);
        var (first, second) = (doc.Items[0], doc.Items[1]);
        Assert.Equal(season.Id, first.Id);
        Assert.Equal(new[] { P(first.Id), P(second.Id), "x" }, doc.Order);
        Assert.All(doc.Items, p => Assert.Equal(PlaceholderKinds.Episodes, p.Kind));
        Assert.Equal(100, first.Episodes.Count);
        Assert.DoesNotContain(first.Episodes, e => e.E == 7);
        Assert.Equal(Enumerable.Range(102, 49), second.Episodes.Select(e => e.E));
        Assert.Empty(first.Filled);
        Assert.Equal(new[] { 120 }, second.Filled.Select(f => f.E));
        Assert.Equal(("tv|5|1|1", "tv|5|1|102"), (first.SourceKey, second.SourceKey));
        Assert.Equal(first.Id, doc.Source!.Owned["tv|5|1|101"].PhId);
        Assert.Equal(second.Id, doc.Source.Owned["tv|5|1|102"].PhId);
        Assert.False(doc.Source.Owned.ContainsKey("tv|5|1|7"));
        Assert.All(doc.Items, p => Assert.True(PlaceholderRules.TryCreate(Body(p), "u", DateTime.UtcNow, out _, out var why), why));

        static NewPlaceholderDto Body(Placeholder p) => new() { Kind = p.Kind, MediaType = p.MediaType, TmdbId = p.TmdbId, Title = p.Title, SeasonNumber = p.SeasonNumber, Episodes = p.Episodes };
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ARunThatGrewUpstreamBetweenReviewAndApplyIsNeitherDeclinedNorWronglyOwned(bool sendGroupKeys)
    {
        using var w = new World();
        w.H.Fetcher.Items = new List<SourceItem> { Film(5), Arrow(3, 5), Arrow(3, 6), Arrow(3, 7), Film(6) };
        var reviewed = await w.FetchAsync();
        Assert.Equal(new[] { "movie|5||", "tv|1412|3|5", "movie|6||" }, reviewed.Entries.Select(e => e.SourceKey));

        // While the editor reviews, upstream lists 3x08 right after 3x07; the apply's own fetch sees the longer run.
        w.H.Fetcher.Items = new List<SourceItem> { Film(5), Arrow(3, 5), Arrow(3, 6), Arrow(3, 7), Arrow(3, 8), Film(6) };
        await w.Import(reviewed, sendGroupKeys);

        var source = w.Doc.Source!;
        Assert.False(source.UserRemovedKeys.ContainsKey("tv|1412|3|8")); // not something the editor skipped
        Assert.False(source.Owned.ContainsKey("tv|1412|3|8")); // the 3x05–07 placeholder doesn't stand for it
        Assert.Equal(new[] { "tv|1412|3|5", "tv|1412|3|6", "tv|1412|3|7" }, source.Owned.Where(o => o.Value.PhId != null && o.Key.StartsWith("tv|", StringComparison.Ordinal)).Select(o => o.Key).OrderBy(k => k, StringComparer.Ordinal));

        // The next sync adds it, right after its run.
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "5", "1412:S3E5,6,7", "1412:S3E8", "6" }, w.Order());
    }
}
