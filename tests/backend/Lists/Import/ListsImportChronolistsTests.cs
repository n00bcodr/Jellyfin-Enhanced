using System.Globalization;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using static JE.Tests.ImportHarness;

namespace JE.Tests;

// chronolists.com watch orders (track p5c): URL recognition, reading the page's embedded data (trimmed real pages in
// Fixtures/), grouping episode runs, prepared entries, per-episode provenance on run placeholders, and the import →
// sync round trip.
[Collection("Plugin singleton")]
public class ListsImportChronolistsTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string DctvUrl = "https://chronolists.com/dctv";

    private static string Fixture(string name) => File.ReadAllText(ImportFixtures.Path(name));

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

        // Fixed upstream: the movie sits between the two episodes in the fetched order (where 4c2b's sync inserts it).
        w.H.Fetcher.Items = Read(Html(Fixed)).Items.ToList();
        w.H.Fetcher.Partial = false;
        var repaired = await w.FetchAsync();
        Assert.Equal(new[] { "season", "episodes", "movie", "episodes" }, repaired.Entries.Select(e => e.Prepared!.Kind));
        Assert.Equal(4242, repaired.Entries[2].Ids!.Tmdb);
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
            ImportTestFlags.AllOn(Plugin.Plugin.Configuration);
            Fetcher = new ListSourceFetcher(Transport, null, null, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger, null, null);
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
        Assert.True(net.Fetcher.Providers(FakeListHost.MakeUser("viewer", false, false)).Chronolists);
    }

    [Fact]
    public async Task FetchErrorsAreClearCodesNeverExceptions()
    {
        using var net = new Net();

        Assert.Equal("not_found", (await net.Fetch("https://chronolists.com/nope")).ErrorCode); // 404

        net.Reply = _ => IntegrationTransport.Response("<html>moved</html>", 301, "text/html");
        Assert.Equal("source_redirected", (await net.Fetch("https://chronolists.com/dctv")).ErrorCode); // redirects aren't followed (a typed failure)
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
        using var h = new ImportHarness();
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
        Assert.All(groups, g => Assert.True(ListRules.TryCreate(ListSourceGroups.Placeholder(g, facts), "u", DateTime.UtcNow, out _, out var why), why));

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
        public ImportHarness H { get; }

        public User Owner { get; }

        public FakeListHost.FakeList List { get; }

        public World(bool realLibrary = false)
        {
            // realLibrary: "in library" comes from the production adapter over the fake host, as the apply's C1 does.
            H = new ImportHarness(realLibrary: realLibrary);
            Owner = H.NewUser("owner");
            List = H.Host.AddPlaylist(Owner);
            H.Fetcher.Exact = true;
            H.Fetcher.Provider = "chronolists";
        }

        public void Page(string fixture) => H.Fetcher.Items = Read(Fixture(fixture)).Items.ToList();

        public async Task<SourceFetchResponse> FetchAsync()
        {
            TmdbAgrees();
            return Ok<SourceFetchResponse>(await H.Sources.FetchAsync(Owner, DctvUrl, None));
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

    private static ImportEntryDto SourceListEntryWithoutGroups() => ListSourcePreview.ToEntry(new SourceItem("movie", 1, null, null, "M", 2020, null, null, null), 0);

    [Fact]
    public async Task RestrictedViewersGetOnlyTheShowsTheyMaySeeCheckedOncePerTitle()
    {
        using var w = new World();
        w.Page("chronolists-dctv.html");
        var viewer = w.H.NewUser("kid", maxRating: 10);
        var checks = new List<string>();
        w.H.Lists.Reply = request =>
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
}
