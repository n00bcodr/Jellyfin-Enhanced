using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using MediaBrowser.Common.Configuration;
using Moq;

namespace JE.Tests;

// Track 4c2a review round 2 (server, the fetcher). D53 rule 1: a read is Complete only when every fact that proves the
// whole list was read holds (an explicit end, consistent page/count totals, no empty interior page, no error); a
// table per provider where only the explicit end is Complete (4c2-R2-B2: a chart with an empty interior page, direct
// TMDB and the Seerr fallback; 4c2-R2-B3: IMDb pageInfo={} or no total). D53 rule 3: every transmission (the MDBList
// quota status read, each retry, every page) passes one gate that re-checks the provider switch, charges admission and
// quota and uses the source transport (4C2-R2-SEC-01: the status read over SourceHttp, with the REAL quota; 4C2-R2-SEC-02:
// IMDb switched off during a Retry-After or between pages → nothing more is sent, imdb_disabled).
[Collection("Plugin singleton")]
public class ListsImportReviewR2FixTests
{
    private const string SourceClient = "JellyfinEnhanced.ListSources";
    private const string SeerrClient = "JellyfinEnhancedSeerr";

    internal sealed class CountingAdmission : ISourceReadAdmission
    {
        public List<string> Admitted { get; } = new();

        public bool TryAdmit(string provider, bool background, out int retryAfterSeconds)
        {
            lock (Admitted)
            {
                Admitted.Add(provider);
            }

            retryAfterSeconds = 0;
            return true;
        }
    }

    /// <summary>Hands out clients over one transport and records the names asked for.</summary>
    internal sealed class NamedFactory(Func<string, HttpClient> create) : IHttpClientFactory
    {
        public List<string> Names { get; } = new();

        public HttpClient CreateClient(string name)
        {
            lock (Names)
            {
                Names.Add(name);
            }

            return create(name);
        }
    }

    /// <summary>The production fetcher with the REAL MDBList quota (MdblistService) over a scripted network.</summary>
    internal sealed class Net : IDisposable
    {
        private readonly string _cache = Path.Combine(Path.GetTempPath(), "je-4c2r2-" + Guid.NewGuid().ToString("N"));

        public ApiPluginFixture Plugin { get; } = new();
        public List<HttpRequestMessage> Requests { get; } = new();
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);
        public IntegrationTransport Transport { get; }
        public NamedFactory Factory { get; }
        public CountingAdmission Admission { get; } = new();
        public MdblistService Quota { get; }
        public TmdbResponseCache Tmdb { get; }
        public ListSourceFetcher Fetcher { get; }

        public Net(Func<string, HttpClient>? clients = null, MetadataCallLimiter? limiter = null)
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Requests)
                {
                    Requests.Add(request);
                }

                var key = request.RequestUri!.GetLeftPart(UriPartial.Path);
                var response = Routes.TryGetValue(key, out var route) ? route(request) : IntegrationTransport.Response("{\"message\":\"not found\"}", 404);
                return Task.FromResult(RealShapes ? RealProviders.Shape(request, response) : response);
            });
            Factory = new NamedFactory(clients ?? (name => Transport.CreateClient(name)));
            ImportTestFlags.AllOn(Plugin.Plugin.Configuration);
            Quota = new MdblistService(Factory, Mock.Of<IApplicationPaths>(p => p.PluginsPath == _cache), Plugin.Core.Logger);
            Tmdb = new TmdbResponseCache(Factory, TimeProvider.System);
            Fetcher = new ListSourceFetcher(Factory, Tmdb, Quota, limiter ?? new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger, null, Admission);
        }

        public Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration Config => Plugin.Plugin.Configuration;

        /// <summary>Answers in the providers' real shape (RealProviders); off for a test that removes an echo on purpose.</summary>
        public bool RealShapes { get; set; } = true;

        public int Sent(string pathStart) => Requests.Count(r => r.RequestUri!.GetLeftPart(UriPartial.Path).StartsWith(pathStart, StringComparison.Ordinal));

        public Task<SourceFetchResult> Fetch(string url, SourceFetchOptions? options = null)
        {
            Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
            return Fetcher.FetchAsync(source!, options ?? new SourceFetchOptions { Fresh = true }, CancellationToken.None);
        }

        public void Dispose()
        {
            Quota.Dispose();
            Tmdb.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    internal static HttpResponseMessage Json(string body, int status = 200) => IntegrationTransport.Response(body, status);

    internal static HttpResponseMessage Limited(int seconds)
    {
        var response = Json("{\"error\":\"slow down\"}", 429);
        response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(seconds));
        return response;
    }

    internal static string Query(HttpRequestMessage request, string name) => System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)[name] ?? string.Empty;

    internal static int Page(HttpRequestMessage request) => int.Parse(Query(request, "page"), CultureInfo.InvariantCulture);

    internal static string Rows(Func<int, string> row, int from, int count) => string.Join(',', Enumerable.Range(from, count).Select(row));

    internal static bool IsComplete(SourceFetchResult result) => result.Ok && SourceSnapshots.Classify(result, null).State == SnapshotState.Complete;

    // ── Fixtures per provider ───────────────────────────────────────────

    private static string ImdbMovie(int n) => "{\"node\":{\"item\":{\"id\":\"tt" + (1000000 + n) + "\",\"titleText\":{\"text\":\"M" + n + "\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":2001}}}}";

    private static string ImdbPage(string edges, string? pageInfo, int? total, string? errors = null) =>
        "{" + (errors == null ? string.Empty : "\"errors\":" + errors + ",") + "\"data\":{\"list\":{\"name\":{\"originalText\":\"Mine\"},\"items\":{"
        + (total is int t ? "\"total\":" + t + "," : string.Empty) + "\"edges\":[" + edges + "]" + (pageInfo == null ? string.Empty : ",\"pageInfo\":" + pageInfo) + "}}}}";

    internal static string ImdbAfter(HttpRequestMessage request)
    {
        using var doc = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
        var after = doc.RootElement.GetProperty("variables").GetProperty("after");
        return after.ValueKind == JsonValueKind.String ? after.GetString()! : string.Empty;
    }

    private static string TmdbRow(int id) => "{\"id\":" + id + ",\"media_type\":\"movie\",\"title\":\"M" + id + "\",\"release_date\":\"2001-01-01\"}";

    private static string SeerrRow(int id) => "{\"id\":" + id + ",\"mediaType\":\"movie\",\"title\":\"M" + id + "\",\"releaseDate\":\"2001-01-01\"}";

    private static string TraktRow(int id) => "{\"id\":" + id + ",\"type\":\"movie\",\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}";

    private static HttpResponseMessage TraktPage(int from, int count, int? pages, int? items)
    {
        var response = Json("[" + Rows(TraktRow, from, count) + "]");
        if (pages is int p)
        {
            response.Headers.Add("X-Pagination-Page-Count", p.ToString(CultureInfo.InvariantCulture));
        }

        if (items is int i)
        {
            response.Headers.Add("X-Pagination-Item-Count", i.ToString(CultureInfo.InvariantCulture));
        }

        return response;
    }

    private static string MdbRow(int id) => "{\"id\":" + id + ",\"title\":\"M" + id + "\",\"mediatype\":\"movie\",\"release_year\":2001}";

    // One scenario of a provider: sets up the routes and returns the URL (and options) to fetch.
    private sealed record Case(string Provider, string Scenario, Func<Net, (string Url, SourceFetchOptions? Options)> Arrange)
    {
        public override string ToString() => Provider + ": " + Scenario;
    }

    private const string Explicit = "explicit end";

    private static IEnumerable<Case> Cases()
    {
        // IMDb (cursor pages): hasNextPage=false on the last page, a total on every page equal to the edges read.
        const string Imdb = "https://api.graphql.imdb.com/";
        (string, SourceFetchOptions?) ImdbPages(Net net, Func<HttpResponseMessage> page2) { net.Routes[Imdb] = r => ImdbAfter(r) == string.Empty ? Json(ImdbPage(ImdbMovie(1) + "," + ImdbMovie(2), "{\"hasNextPage\":true,\"endCursor\":\"c1\"}", 3)) : page2(); return ("https://www.imdb.com/list/ls000000101/", null); }
        (string, SourceFetchOptions?) ImdbTwo(Net net, string page2) => ImdbPages(net, () => Json(page2));
        yield return new("imdb", Explicit, net => ImdbTwo(net, ImdbPage(ImdbMovie(3), "{\"hasNextPage\":false,\"endCursor\":null}", 3)));
        yield return new("imdb", "end marker missing (pageInfo={})", net => ImdbTwo(net, ImdbPage(ImdbMovie(3), "{}", 3)));
        yield return new("imdb", "end marker missing (no pageInfo)", net => ImdbTwo(net, ImdbPage(ImdbMovie(3), null, 3)));
        yield return new("imdb", "no total (pageInfo={})", net => { net.Routes[Imdb] = _ => Json(ImdbPage(ImdbMovie(1) + "," + ImdbMovie(2), "{}", null)); return ("https://www.imdb.com/list/ls000000102/", null); });
        yield return new("imdb", "no total (explicit end)", net => { net.Routes[Imdb] = _ => Json(ImdbPage(ImdbMovie(1) + "," + ImdbMovie(2), "{\"hasNextPage\":false}", null)); return ("https://www.imdb.com/list/ls000000103/", null); });
        yield return new("imdb", "counts inconsistent (total moved)", net => ImdbTwo(net, ImdbPage(ImdbMovie(3), "{\"hasNextPage\":false,\"endCursor\":null}", 4)));
        yield return new("imdb", "interior empty", net => { net.Routes[Imdb] = r => Json(ImdbAfter(r) == string.Empty ? ImdbPage(string.Empty, "{\"hasNextPage\":true,\"endCursor\":\"c1\"}", 1) : ImdbPage(ImdbMovie(1), "{\"hasNextPage\":false}", 1)); return ("https://www.imdb.com/list/ls000000104/", null); });
        yield return new("imdb", "error mid-way (GraphQL errors)", net => ImdbTwo(net, ImdbPage(ImdbMovie(3), "{\"hasNextPage\":false,\"endCursor\":null}", 3, "[{\"message\":\"boom\"}]")));
        yield return new("imdb", "error mid-way (HTTP 500)", net => ImdbPages(net, () => Json("{}", 500)));

        // TMDB list (offset pages): total_pages reached, item_count on every page and equal to the rows read.
        Net Key(Net net) { net.Config.TMDB_API_KEY = "tmdb-key"; return net; }
        const string List = "https://api.themoviedb.org/3/list/7";
        (string, SourceFetchOptions?) TmdbList(Net net, Func<int, string> page) { Key(net).Routes[List] = r => Json(page(Page(r))); return ("https://www.themoviedb.org/list/7", null); }
        yield return new("tmdb list", Explicit, net => TmdbList(net, p => p == 1 ? "{\"name\":\"L\",\"total_pages\":2,\"item_count\":3,\"items\":[" + Rows(TmdbRow, 1, 2) + "]}" : "{\"total_pages\":2,\"item_count\":3,\"items\":[" + TmdbRow(3) + "]}"));
        yield return new("tmdb list", "end marker missing", net => TmdbList(net, _ => "{\"name\":\"L\",\"item_count\":2,\"items\":[" + Rows(TmdbRow, 1, 2) + "]}"));
        yield return new("tmdb list", "no item count", net => TmdbList(net, _ => "{\"name\":\"L\",\"total_pages\":1,\"items\":[" + Rows(TmdbRow, 1, 2) + "]}"));
        yield return new("tmdb list", "counts inconsistent", net => TmdbList(net, p => p == 1 ? "{\"name\":\"L\",\"total_pages\":2,\"item_count\":5,\"items\":[" + Rows(TmdbRow, 1, 2) + "]}" : "{\"total_pages\":2,\"item_count\":5,\"items\":[" + TmdbRow(3) + "]}"));
        yield return new("tmdb list", "interior empty", net => TmdbList(net, p => p == 1 ? "{\"name\":\"L\",\"total_pages\":2,\"item_count\":1,\"items\":[]}" : "{\"total_pages\":2,\"item_count\":1,\"items\":[" + TmdbRow(1) + "]}"));
        yield return new("tmdb list", "error mid-way", net => { Key(net).Routes[List] = r => Page(r) == 1 ? Json("{\"name\":\"L\",\"total_pages\":2,\"item_count\":3,\"items\":[" + Rows(TmdbRow, 1, 2) + "]}") : Json("{}", 500); return ("https://www.themoviedb.org/list/7", null); });

        // TMDB chart (its first pages): total_pages and total_results on every page and constant, no empty page, and
        // when the whole chart was read, the rows read equal total_results.
        const string Chart = "https://api.themoviedb.org/3/movie/popular";
        (string, SourceFetchOptions?) TmdbChart(Net net, Func<int, HttpResponseMessage> page) { Key(net).Routes[Chart] = r => page(Page(r)); return ("https://www.themoviedb.org/movie", null); }
        string ChartPage(int p, int pages, int? results, int rows) => "{\"page\":" + p + ",\"total_pages\":" + pages + (results is int n ? ",\"total_results\":" + n : string.Empty) + ",\"results\":[" + Rows(TmdbRow, (p * 100) + 1, rows) + "]}";
        yield return new("tmdb chart", Explicit, net => TmdbChart(net, p => Json(ChartPage(p, 2, 30, p == 1 ? 20 : 10))));
        yield return new("tmdb chart", "explicit end (window of a long chart)", net => TmdbChart(net, p => Json(ChartPage(p, 500, 10000, 20))));
        yield return new("tmdb chart", "end marker missing", net => TmdbChart(net, p => Json("{\"page\":" + p + ",\"total_results\":20,\"results\":[" + Rows(TmdbRow, 1, 20) + "]}")));
        yield return new("tmdb chart", "counts inconsistent (rows ≠ total_results)", net => TmdbChart(net, p => Json(ChartPage(p, 2, 35, p == 1 ? 20 : 10))));
        yield return new("tmdb chart", "counts inconsistent (total_pages moved)", net => TmdbChart(net, p => Json(ChartPage(p, p == 1 ? 3 : 2, 50, 20))));
        yield return new("tmdb chart", "interior empty (B2: page 2 of 5)", net => TmdbChart(net, p => Json(ChartPage(p, 5, 100, p == 2 ? 0 : 20))));
        yield return new("tmdb chart", "error mid-way", net => TmdbChart(net, p => p == 1 ? Json(ChartPage(p, 5, 100, 20)) : Json("{}", 500)));

        // Seerr chart (the TMDB fallback without a key): totalPages and totalResults, the same rule.
        const string Trending = "http://seerr.test/api/v1/discover/trending";
        (string, SourceFetchOptions?) SeerrChart(Net net, Func<int, HttpResponseMessage> page)
        {
            net.Config.JellyseerrEnabled = true;
            net.Config.JellyseerrUrls = "http://seerr.test";
            net.Config.JellyseerrApiKey = "seerr-key";
            net.Routes[Trending] = r => page(Page(r));
            return ("https://www.themoviedb.org/trending/movie/week", null);
        }

        string SeerrPage(int p, int pages, int? results, int rows) => "{\"page\":" + p + ",\"totalPages\":" + pages + (results is int n ? ",\"totalResults\":" + n : string.Empty) + ",\"results\":[" + Rows(SeerrRow, (p * 100) + 1, rows) + "]}";
        yield return new("seerr chart", Explicit, net => SeerrChart(net, p => Json(SeerrPage(p, 2, 30, p == 1 ? 20 : 10))));
        yield return new("seerr chart", "end marker missing", net => SeerrChart(net, p => Json("{\"page\":" + p + ",\"results\":[" + Rows(SeerrRow, 1, 20) + "]}")));
        yield return new("seerr chart", "counts inconsistent", net => SeerrChart(net, p => Json(SeerrPage(p, 2, 31, p == 1 ? 20 : 10))));
        yield return new("seerr chart", "interior empty (B2: page 2 of 5)", net => SeerrChart(net, p => Json(SeerrPage(p, 5, 100, p == 2 ? 0 : 20))));
        yield return new("seerr chart", "error mid-way", net => SeerrChart(net, p => p == 1 ? Json(SeerrPage(p, 5, 100, 20)) : Json("{}", 500)));

        // Trakt list (offset pages + the drift probe): both pagination headers on every page, the last page reached,
        // the rows read equal to the item count.
        Net Trakt(Net net) { net.Config.ArrListTraktApiKey = "trakt-client"; return net; }
        const string TraktList = "https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode";
        (string, SourceFetchOptions?) TraktListCase(Net net, Func<int, HttpResponseMessage> page)
        {
            // limit=1 is the drift probe: row n of the list (n = its page number).
            Trakt(net).Routes[TraktList] = r => Query(r, "limit") == "1" ? Json("[" + TraktRow(Page(r)) + "]") : page(Page(r));
            return ("https://trakt.tv/users/me/lists/mine", null);
        }

        yield return new("trakt list", Explicit, net => TraktListCase(net, p => p == 1 ? TraktPage(1, 100, 2, 105) : TraktPage(101, 5, 2, 105)));
        yield return new("trakt list", "end marker missing (a short page, no headers)", net => TraktListCase(net, _ => TraktPage(1, 5, null, null)));
        yield return new("trakt list", "no item count", net => TraktListCase(net, _ => TraktPage(1, 5, 1, null)));
        yield return new("trakt list", "counts inconsistent", net => TraktListCase(net, p => p == 1 ? TraktPage(1, 100, 2, 110) : TraktPage(101, 5, 2, 110)));
        yield return new("trakt list", "interior empty", net => TraktListCase(net, p => p == 1 ? TraktPage(1, 0, 2, 5) : TraktPage(1, 5, 2, 5)));
        yield return new("trakt list", "error mid-way", net => TraktListCase(net, p => p == 1 ? TraktPage(1, 100, 2, 105) : Json("{}", 500)));

        // Trakt chart (its first page of 100).
        const string Popular = "https://api.trakt.tv/movies/popular";
        (string, SourceFetchOptions?) TraktChart(Net net, Func<int, HttpResponseMessage> page) { Trakt(net).Routes[Popular] = r => page(Page(r)); return ("https://trakt.tv/movies/popular", null); }
        yield return new("trakt chart", Explicit, net => TraktChart(net, _ => TraktPage(1, 40, 1, 40)));
        yield return new("trakt chart", "explicit end (window of a long chart)", net => TraktChart(net, _ => TraktPage(1, 100, 10, 1000)));
        yield return new("trakt chart", "end marker missing", net => TraktChart(net, _ => TraktPage(1, 40, null, null)));
        yield return new("trakt chart", "counts inconsistent", net => TraktChart(net, _ => TraktPage(1, 40, 1, 50)));
        yield return new("trakt chart", "interior empty", net => TraktChart(net, _ => TraktPage(1, 0, 3, 250)));
        yield return new("trakt chart", "error mid-way", net => TraktChart(net, _ => Json("{}", 500)));

        // MDBList public JSON (one answer by the endpoint's contract): the list array, below the entry cap.
        const string MdbJson = "https://mdblist.com/lists/me/mine/json";
        yield return new("mdblist public", Explicit, net => { net.Routes[MdbJson] = _ => Json("[" + Rows(MdbRow, 1, 3) + "]"); return ("https://mdblist.com/lists/me/mine", null); });
        yield return new("mdblist public", "error answer", net => { net.Routes[MdbJson] = _ => Json("{\"error\":\"nope\"}"); return ("https://mdblist.com/lists/me/mine", null); });
        yield return new("mdblist public", "more announced (X-Has-More)", net => { net.Routes[MdbJson] = _ => { var r = Json("[" + Rows(MdbRow, 1, 3) + "]"); r.Headers.Add("X-Has-More", "true"); return r; }; return ("https://mdblist.com/lists/me/mine", null); });

        // MDBList API (one page of up to 1000): has_more=false, or a page shorter than the limit asked for.
        const string MdbApi = "https://api.mdblist.com/lists/me/mine/items";
        (string, SourceFetchOptions?) Api(Net net, string body)
        {
            net.Config.MdblistApiKey = "mdb-key";
            net.Config.ArrPhase4ListMdblistApiEnabled = true;
            net.Routes["https://api.mdblist.com/user"] = _ => Json("{\"rate_limit\":1000,\"rate_limit_remaining\":900}");
            net.Routes[MdbApi] = _ => Json(body);
            return ("https://mdblist.com/lists/me/mine", new SourceFetchOptions { AllowMdblistApi = true, Fresh = true });
        }

        yield return new("mdblist api", Explicit, net => Api(net, "{\"items\":[" + Rows(MdbRow, 1, 3) + "],\"pagination\":{\"has_more\":false}}"));
        yield return new("mdblist api", "end marker missing (a full page)", net => Api(net, "{\"items\":[" + Rows(MdbRow, 1, 1000) + "]}"));
        yield return new("mdblist api", "more announced", net => Api(net, "{\"items\":[" + Rows(MdbRow, 1, 3) + "],\"pagination\":{\"has_more\":true,\"next_cursor\":\"x\"}}"));
        yield return new("mdblist api", "error answer", net => Api(net, "{\"error\":\"Invalid API key\"}"));

        // Collections (one answer): the parts array.
        yield return new("tmdb collection", Explicit, net => { Key(net).Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{\"id\":10,\"name\":\"C\",\"parts\":[" + Rows(TmdbRow, 1, 3) + "]}"); return ("https://www.themoviedb.org/collection/10", null); });
        yield return new("tmdb collection", "error answer (no parts)", net => { Key(net).Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{\"status_message\":\"nope\"}"); return ("https://www.themoviedb.org/collection/10", null); });
    }

    public static IEnumerable<object[]> CompletenessCases() => Cases().Select(c => new object[] { c.Provider + " | " + c.Scenario });

    [Theory]
    [MemberData(nameof(CompletenessCases))]
    public async Task OnlyAnExplicitEndWithConsistentCountsIsComplete(string name)
    {
        var @case = Cases().Single(c => c.Provider + " | " + c.Scenario == name);
        using var net = new Net();
        var (url, options) = @case.Arrange(net);

        var result = await net.Fetch(url, options);

        if (@case.Scenario.StartsWith(Explicit, StringComparison.Ordinal))
        {
            Assert.True(result.Ok, result.ErrorCode);
            Assert.False(result.Partial, "partial");
            Assert.False(result.Truncated, "truncated");
            Assert.Equal(SnapshotState.Complete, SourceSnapshots.Classify(result, null).State);
        }
        else
        {
            Assert.False(IsComplete(result), $"{name}: {result.Items.Count} entries read as complete");
        }
    }

    // ── R2-B2 / R2-B3 as reported ───────────────────────────────────────

    [Fact]
    public async Task AFivePageChartWithAnEmptySecondPageIsPartialDirectAndThroughSeerr()
    {
        using var net = new Net();
        net.Config.TMDB_API_KEY = "tmdb-key";
        net.Routes["https://api.themoviedb.org/3/movie/popular"] = r => Json("{\"page\":" + Page(r) + ",\"total_pages\":5,\"total_results\":100,\"results\":[" + (Page(r) == 2 ? string.Empty : Rows(TmdbRow, (Page(r) * 100) + 1, 20)) + "]}");
        var direct = await net.Fetch("https://www.themoviedb.org/movie");
        Assert.True(direct.Ok);
        Assert.NotEqual(SnapshotState.Complete, SourceSnapshots.Classify(direct, new[] { "movie|1||" }).State);

        net.Config.TMDB_API_KEY = string.Empty;
        net.Config.JellyseerrEnabled = true;
        net.Config.JellyseerrUrls = "http://seerr.test";
        net.Config.JellyseerrApiKey = "seerr-key";
        net.Routes["http://seerr.test/api/v1/discover/movies/upcoming"] = r => Json("{\"page\":" + Page(r) + ",\"totalPages\":5,\"totalResults\":100,\"results\":[" + (Page(r) == 2 ? string.Empty : Rows(SeerrRow, (Page(r) * 100) + 1, 20)) + "]}");
        var seerr = await net.Fetch("https://www.themoviedb.org/movie/upcoming");
        Assert.Equal("seerr", seerr.Provider);
        Assert.NotEqual(SnapshotState.Complete, SourceSnapshots.Classify(seerr, new[] { "movie|1||" }).State);
    }

    [Fact]
    public async Task AnImdbAnswerWithAnEmptyPageInfoAndNoTotalIsNeverComplete()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(ImdbPage(ImdbMovie(1) + "," + ImdbMovie(2), "{}", null));

        var result = await net.Fetch("https://www.imdb.com/list/ls000000105/");

        Assert.False(IsComplete(result));
        Assert.Single(net.Requests);
    }

    // ── R2-SEC-01: the quota status read is a source transmission ──────

    private static Net MdblistApi(Func<string, HttpClient>? clients = null, int remaining = 900)
    {
        var net = new Net(clients);
        net.Config.MdblistApiKey = "mdb-key";
        net.Config.ArrPhase4ListMdblistApiEnabled = true;
        net.Routes["https://api.mdblist.com/user"] = _ => Json("{\"plan\":\"free\",\"rate_limit\":1000,\"rate_limit_remaining\":" + remaining + ",\"rate_limit_reset\":0}");
        net.Routes["https://api.mdblist.com/lists/me/mine/items"] = _ => Json("{\"items\":[{\"ids\":{\"tmdb\":10193},\"title\":\"Toy Story 3\",\"mediatype\":\"movie\"}],\"pagination\":{\"has_more\":false}}");
        return net;
    }

    private static readonly SourceFetchOptions ApiRead = new() { AllowMdblistApi = true, Fresh = true };

    [Fact]
    public async Task TheQuotaStatusReadGoesThroughTheGateOverTheSourceTransport()
    {
        using var net = MdblistApi();

        var result = await net.Fetch("https://mdblist.com/lists/me/mine", ApiRead);

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal(1, net.Sent("https://api.mdblist.com/user"));
        Assert.All(net.Factory.Names, name => Assert.Equal(SourceClient, name)); // never the unnamed default client
        Assert.Equal(new[] { "mdblist-api", "mdblist-api" }, net.Admission.Admitted); // the status read and the list read
        Assert.Equal(899, net.Quota.RemainingQuota()); // the REAL quota: one request charged
    }

    [Fact]
    public async Task AQuotaStatusAnswerThatRedirectsIsATypedFailureAndTheListIsNeverRead()
    {
        using var net = MdblistApi();
        net.Routes["https://api.mdblist.com/user"] = _ =>
        {
            var redirect = new HttpResponseMessage(HttpStatusCode.Found) { Content = new StringContent(string.Empty) };
            redirect.Headers.Location = new Uri("http://169.254.169.254/latest/meta-data");
            return redirect;
        };

        var result = await net.Fetch("https://mdblist.com/lists/me/mine", ApiRead);

        Assert.Equal((false, SourceFailures.Redirected), (result.Ok, result.ErrorCode));
        Assert.Equal(0, net.Sent("https://api.mdblist.com/lists/"));
        Assert.DoesNotContain(net.Requests, r => r.RequestUri!.Host == "169.254.169.254");
    }

    [Fact]
    public async Task AQuotaStatusHostResolvingToAPrivateAddressIsNeverConnectedTo()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            using var guarded = SourceHttp.CreateHandler((_, _) => ValueTask.FromResult(new[] { IPAddress.Loopback }), new WebProxy());
            // Any other client is what split DNS would give an unchecked one: a connection to the server's own network.
            using var open = new SocketsHttpHandler
            {
                UseProxy = false,
                ConnectCallback = async (_, ct) =>
                {
                    var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                    await socket.ConnectAsync(IPAddress.Loopback, port, ct);
                    return new NetworkStream(socket, true);
                },
            };
            using var net = MdblistApi(name => new HttpClient(name == SourceClient ? guarded : open, false) { Timeout = TimeSpan.FromSeconds(5) });

            var result = await net.Fetch("https://mdblist.com/lists/me/mine", ApiRead);

            Assert.Equal((false, SourceFailures.AddressBlocked), (result.Ok, result.ErrorCode));
            Assert.False(listener.Pending(), "something connected to the private address");
            Assert.All(net.Factory.Names, name => Assert.Equal(SourceClient, name));
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public async Task TheRealQuotaRefusesARetryAtTheSafetyMargin()
    {
        using var net = MdblistApi(remaining: MdblistService.SafetyMargin + 1);
        net.Routes["https://api.mdblist.com/lists/me/mine/items"] = _ => Limited(1);

        var result = await net.Fetch("https://mdblist.com/lists/me/mine", ApiRead);

        Assert.Equal((false, "quota_exhausted"), (result.Ok, result.ErrorCode));
        Assert.Equal(1, net.Sent("https://api.mdblist.com/lists/")); // the retry had no reservation: never sent
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    // ── R2-SEC-02 and the gate per provider: a switch turned off stops the next transmission ──

    [Fact]
    public async Task ImdbTurnedOffDuringARetryAfterIsNeverSentAgain()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = _ =>
        {
            net.Config.ArrPhase4ListImdbEnabled = false; // the administrator, during the wait
            return Limited(1);
        };

        var result = await net.Fetch("https://www.imdb.com/list/ls000000106/");

        Assert.Equal((false, SourceFailures.ImdbDisabled), (result.Ok, result.ErrorCode));
        Assert.Single(net.Requests);
    }

    [Fact]
    public async Task ImdbTurnedOffBetweenPagesIsNeverSentAgain()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = _ =>
        {
            net.Config.ArrPhase4ListImdbEnabled = false;
            return Json(ImdbPage(ImdbMovie(1), "{\"hasNextPage\":true,\"endCursor\":\"c1\"}", 2));
        };

        var result = await net.Fetch("https://www.imdb.com/list/ls000000107/");

        Assert.Equal((false, SourceFailures.ImdbDisabled), (result.Ok, result.ErrorCode));
        Assert.Single(net.Requests);
    }

    public static IEnumerable<object[]> GatedProviders() => new[]
    {
        new object[] { "mdblist" }, new object[] { "mdblist-api" }, new object[] { "tmdb" }, new object[] { "seerr" },
        new object[] { "trakt" }, new object[] { "imdb" }, new object[] { "chronolists" },
    };

    [Theory]
    [MemberData(nameof(GatedProviders))]
    public async Task AProviderTurnedOffDuringARetryAfterIsNeverSentAgain(string provider)
    {
        using var net = new Net();
        var config = net.Config;
        config.TMDB_API_KEY = "tmdb-key";
        config.ArrListTraktApiKey = "trakt-client";
        config.MdblistApiKey = "mdb-key";
        config.ArrPhase4ListMdblistApiEnabled = true;
        net.Routes["https://api.mdblist.com/user"] = _ => Json("{\"rate_limit\":1000,\"rate_limit_remaining\":900}");
        var (route, url, off, options) = provider switch
        {
            "mdblist" => ("https://mdblist.com/lists/me/mine/json", "https://mdblist.com/lists/me/mine", (Action)(() => config.ArrPhase4ListMdblistEnabled = false), (SourceFetchOptions?)null),
            "mdblist-api" => ("https://api.mdblist.com/lists/me/mine/items", "https://mdblist.com/lists/me/mine", () => config.ArrPhase4ListMdblistApiEnabled = false, ApiRead),
            "tmdb" => ("https://api.themoviedb.org/3/list/7", "https://www.themoviedb.org/list/7", () => config.ArrPhase4ListTmdbEnabled = false, null),
            "seerr" => ("http://seerr.test/api/v1/collection/10", "https://www.themoviedb.org/collection/10", () => config.ArrPhase4ListTmdbEnabled = false, null),
            "trakt" => ("https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode", "https://trakt.tv/users/me/lists/mine", () => config.ArrPhase4ListTraktEnabled = false, null),
            "imdb" => ("https://api.graphql.imdb.com/", "https://www.imdb.com/list/ls000000108/", () => config.ArrPhase4ListImdbEnabled = false, null),
            _ => ("https://chronolists.com/mcu", "https://chronolists.com/mcu", () => config.ArrPhase4ListChronolistsEnabled = false, null),
        };
        if (provider == "seerr")
        {
            config.TMDB_API_KEY = string.Empty;
            config.JellyseerrEnabled = true;
            config.JellyseerrUrls = "http://seerr.test";
            config.JellyseerrApiKey = "seerr-key";
        }

        net.Routes[route] = _ =>
        {
            off();
            return Limited(1);
        };

        var result = await net.Fetch(url, options);

        Assert.False(result.Ok);
        Assert.Equal(provider == "imdb" ? SourceFailures.ImdbDisabled : SourceFailures.ProviderDisabled, result.ErrorCode);
        Assert.Equal(1, net.Sent(route));
        Assert.All(net.Factory.Names, name => Assert.Contains(name, new[] { SourceClient, SeerrClient }));
    }

    [Fact]
    public async Task TheMdblistApiTurnedOffAfterTheQuotaStatusReadSendsNoListRead()
    {
        using var net = MdblistApi();
        net.Routes["https://api.mdblist.com/user"] = _ =>
        {
            net.Config.ArrPhase4ListMdblistApiEnabled = false;
            return Json("{\"rate_limit\":1000,\"rate_limit_remaining\":900}");
        };

        var result = await net.Fetch("https://mdblist.com/lists/me/mine", ApiRead);

        Assert.Equal((false, SourceFailures.ProviderDisabled), (result.Ok, result.ErrorCode));
        Assert.Equal(0, net.Sent("https://api.mdblist.com/lists/"));
    }
}
