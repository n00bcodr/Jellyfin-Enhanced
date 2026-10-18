using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using MediaBrowser.Common.Configuration;
using Moq;

namespace JE.Tests;

// Track 4c2a review round 1 (server): paging never stops early as "complete" (4c2-B2: a missing continuation, an empty
// page before the last one or a missing page count is partial; a page limit reached with pages left is truncated, for
// IMDb, TMDB lists and charts, Seerr charts and Trakt), the snapshot describes what the reply carries after every cap
// (4c2-B3), source reads (TMDB included) go over the source transport and a redirect is a typed failure (4C2-SEC-03),
// every caller whose view can be narrower than the list gets counts hidden whatever left entries out (4C2-SEC-05), and
// every transmission, a 429 retry included, is charged to the provider's admission and the MDBList quota (4C2-SEC-06).
[Collection("Plugin singleton")]
public class ListsImportReviewR1FixTests
{
    private const string SourceClient = "JellyfinEnhanced.ListSources";

    /// <summary>Counts every admission and refuses after <see cref="Allow"/>.</summary>
    private sealed class CountingAdmission : ISourceReadAdmission
    {
        public List<string> Admitted { get; } = new();
        public int Allow { get; set; } = int.MaxValue;

        public bool TryAdmit(string provider, bool background, out int retryAfterSeconds)
        {
            lock (Admitted)
            {
                if (Admitted.Count >= Allow)
                {
                    retryAfterSeconds = 60;
                    return false;
                }

                Admitted.Add(provider);
                retryAfterSeconds = 0;
                return true;
            }
        }
    }

    /// <summary>A client factory that records the client names asked for.</summary>
    private sealed class NamedFactory(IntegrationTransport transport) : IHttpClientFactory
    {
        public List<string> Names { get; } = new();

        public HttpClient CreateClient(string name)
        {
            lock (Names)
            {
                Names.Add(name);
            }

            return transport.CreateClient(name);
        }
    }

    private sealed class Net : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<HttpRequestMessage> Requests { get; } = new();
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);
        public IntegrationTransport Transport { get; }
        public NamedFactory Factory { get; }
        public TmdbResponseCache Tmdb { get; }
        public CountingAdmission Admission { get; } = new();
        public MdblistService Quota { get; }
        public ListSourceFetcher Fetcher { get; }

        public Net()
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Requests)
                {
                    Requests.Add(request);
                }

                var key = request.RequestUri!.GetLeftPart(UriPartial.Path);
                return Task.FromResult(Routes.TryGetValue(key, out var route) ? route(request) : IntegrationTransport.Response("{\"message\":\"not found\"}", 404));
            });
            Factory = new NamedFactory(Transport);
            Tmdb = new TmdbResponseCache(Factory, TimeProvider.System);
            ImportTestFlags.AllOn(Plugin.Plugin.Configuration);
            // The REAL quota (review round 2): its account status read goes through the fetcher's gate.
            Quota = new MdblistService(Factory, Mock.Of<IApplicationPaths>(p => p.PluginsPath == Path.Combine(Path.GetTempPath(), "je-4c2-quota-" + Guid.NewGuid().ToString("N"))), Plugin.Core.Logger);
            Fetcher = new ListSourceFetcher(Factory, Tmdb, Quota, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger, null, Admission);
        }

        public Task<SourceFetchResult> Fetch(string url, SourceFetchOptions? options = null)
        {
            Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
            return Fetcher.FetchAsync(source!, options ?? new SourceFetchOptions { Fresh = true }, CancellationToken.None);
        }

        public void Dispose()
        {
            Tmdb.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static HttpResponseMessage Json(string body, int status = 200) => IntegrationTransport.Response(body, status);

    private static HttpResponseMessage Limited(int seconds)
    {
        var response = Json("{\"error\":\"slow down\"}", 429);
        response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(seconds));
        return response;
    }

    private static string Query(HttpRequestMessage request, string name) => System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)[name] ?? string.Empty;

    private static string ImdbMovie(int n) => "{\"node\":{\"item\":{\"id\":\"tt" + (1000000 + n) + "\",\"titleText\":{\"text\":\"M" + n + "\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":2001}}}}";

    private static string ImdbList(string edges, string pageInfo, int? total = null) =>
        "{\"data\":{\"list\":{\"name\":{\"originalText\":\"Mine\"},\"items\":{" + (total is int t ? "\"total\":" + t + "," : string.Empty) + "\"edges\":[" + edges + "],\"pageInfo\":" + pageInfo + "}}}}";

    // ── B2: paging ──────────────────────────────────────────────────────

    [Fact]
    public async Task AnImdbPageThatSaysMoreFollowButHasNoCursorIsPartialNeverComplete()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(ImdbList(ImdbMovie(1) + "," + ImdbMovie(2), "{\"hasNextPage\":true,\"endCursor\":null}"));

        var result = await net.Fetch("https://www.imdb.com/list/ls000000003/");

        Assert.True(result.Ok);
        Assert.Equal(2, result.Items.Count);
        Assert.True(result.Partial, "more pages were announced but couldn't be read");
        Assert.NotEqual(SnapshotState.Complete, SourceSnapshots.Classify(result, new[] { "imdb|tt1000003||" }).State);
        Assert.Single(net.Requests);
    }

    [Fact]
    public async Task AnImdbListStillContinuingAtThePageLimitIsTruncated()
    {
        using var net = new Net();
        var n = 0;
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(ImdbList(ImdbMovie(Interlocked.Increment(ref n)), "{\"hasNextPage\":true,\"endCursor\":\"c" + n + "\"}"));

        var result = await net.Fetch("https://www.imdb.com/list/ls000000004/");

        Assert.True(result.Ok);
        Assert.Equal(10, net.Requests.Count); // the page limit
        Assert.True(result.Truncated, "pages were left when the limit was reached");
        Assert.Equal(SnapshotState.Truncated, SourceSnapshots.Classify(result, null).State);
    }

    [Fact]
    public async Task AnImdbListWithFewerRowsThanItsTotalAndNoNextPageIsPartial()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(ImdbList(ImdbMovie(1) + "," + ImdbMovie(2), "{\"hasNextPage\":false,\"endCursor\":null}", total: 5));

        var result = await net.Fetch("https://www.imdb.com/list/ls000000005/");

        Assert.True(result.Ok);
        Assert.True(result.Partial);
    }

    private static Net Tmdb()
    {
        var net = new Net();
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        return net;
    }

    private static string TmdbRow(int id) => "{\"id\":" + id + ",\"media_type\":\"movie\",\"title\":\"M" + id + "\",\"release_date\":\"2001-01-01\"}";

    [Fact]
    public async Task ATmdbListWithAnEmptyPageBeforeItsLastIsPartial()
    {
        using var net = Tmdb();
        net.Routes["https://api.themoviedb.org/3/list/7"] = request => Json(Query(request, "page") == "1"
            ? "{\"name\":\"L\",\"total_pages\":3,\"items\":[" + TmdbRow(1) + "]}"
            : "{\"total_pages\":3,\"items\":[]}");

        var result = await net.Fetch("https://www.themoviedb.org/list/7");

        Assert.True(result.Ok);
        Assert.True(result.Partial, "page 2 of 3 came back empty");
    }

    [Fact]
    public async Task ATmdbListWithoutAPageCountIsPartial()
    {
        using var net = Tmdb();
        net.Routes["https://api.themoviedb.org/3/list/8"] = _ => Json("{\"name\":\"L\",\"items\":[" + TmdbRow(1) + "," + TmdbRow(2) + "]}");

        var result = await net.Fetch("https://www.themoviedb.org/list/8");

        Assert.True(result.Ok);
        Assert.True(result.Partial);
    }

    [Fact]
    public async Task ATmdbListStillContinuingAtThePageLimitIsTruncated()
    {
        using var net = Tmdb();
        net.Routes["https://api.themoviedb.org/3/list/9"] = request => Json("{\"name\":\"L\",\"total_pages\":150,\"items\":[" + TmdbRow(int.Parse(Query(request, "page"), System.Globalization.CultureInfo.InvariantCulture)) + "]}");

        var result = await net.Fetch("https://www.themoviedb.org/list/9");

        Assert.True(result.Ok);
        Assert.Equal(100, result.Items.Count);
        Assert.True(result.Truncated, "50 pages were left");
    }

    [Fact]
    public async Task ATmdbOrSeerrChartWithoutAPageCountIsPartial()
    {
        using var net = Tmdb();
        net.Routes["https://api.themoviedb.org/3/movie/popular"] = _ => Json("{\"results\":[" + string.Join(',', Enumerable.Range(1, 20).Select(TmdbRow)) + "]}");
        var tmdb = await net.Fetch("https://www.themoviedb.org/movie");
        Assert.True(tmdb.Ok);
        Assert.Equal(20, tmdb.Items.Count);
        Assert.True(tmdb.Partial);

        var config = net.Plugin.Plugin.Configuration;
        config.TMDB_API_KEY = string.Empty;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";
        net.Routes["http://seerr.test/api/v1/discover/trending"] = _ => Json("{\"page\":1,\"results\":[{\"id\":1061474,\"mediaType\":\"movie\",\"title\":\"Superman\",\"releaseDate\":\"2025-07-09\"}]}");
        var seerr = await net.Fetch("https://www.themoviedb.org/trending/movie/week");
        Assert.Equal(("seerr", true), (seerr.Provider, seerr.Partial));
    }

    private static string TraktRow(int id) => "{\"id\":" + id + ",\"type\":\"movie\",\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}";

    private static HttpResponseMessage TraktPage(IEnumerable<int> ids, int? pages = null, int? items = null)
    {
        var response = Json("[" + string.Join(',', ids.Select(TraktRow)) + "]");
        if (pages is int p)
        {
            response.Headers.Add("X-Pagination-Page-Count", p.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        if (items is int i)
        {
            response.Headers.Add("X-Pagination-Item-Count", i.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        return response;
    }

    [Fact]
    public async Task ATraktFullPageWithoutPaginationHeadersIsPartial()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrListTraktApiKey = "trakt-client";
        net.Routes["https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode"] = _ => TraktPage(Enumerable.Range(1, 100));

        var result = await net.Fetch("https://trakt.tv/users/me/lists/mine");

        Assert.True(result.Ok);
        Assert.True(result.Partial, "a full page with no page count may have more after it");
    }

    [Fact]
    public async Task ATraktChartWithAnEmptyPageBeforeItsLastIsPartial()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrListTraktApiKey = "trakt-client";
        net.Routes["https://api.trakt.tv/movies/popular"] = request => Query(request, "page") == "1" ? TraktPage(Enumerable.Range(1, 10), pages: 3) : TraktPage(Array.Empty<int>(), pages: 3);

        var result = await net.Fetch("https://trakt.tv/movies/popular");

        Assert.True(result.Ok);
        Assert.True(result.Partial);
    }

    [Fact]
    public async Task ATraktListStillContinuingAtThePageLimitIsTruncated()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrListTraktApiKey = "trakt-client";
        // One row per page; the drift probe (limit=1, page=n) reads row n, the last row of page n.
        net.Routes["https://api.trakt.tv/users/me/lists/long/items/movie,show,season,episode"] = request =>
            TraktPage(new[] { int.Parse(Query(request, "page"), System.Globalization.CultureInfo.InvariantCulture) }, pages: 50, items: 50);

        var result = await net.Fetch("https://trakt.tv/users/me/lists/long");

        Assert.True(result.Ok);
        Assert.Equal(20, result.Items.Count);
        Assert.False(result.Partial);
        Assert.True(result.Truncated, "30 pages were left");
    }

    // ── B3: the snapshot describes the reply ───────────────────────────

    [Fact]
    public async Task AGroupedReviewCappedAtTheEntryLimitDescribesOnlyWhatItCarries()
    {
        using var h = new ImportHarness();
        var owner = h.NewUser("owner");
        h.Fetcher.Exact = true;
        h.Fetcher.Provider = "chronolists";
        h.Fetcher.Items = Enumerable.Range(1, ListStore.MaxPlaceholders + 1)
            .Select(i => new SourceItem("movie", i, null, null, "M" + i, 2001, null, null, null) { Details = new SourceItemDetails(null, "2001-01-01", null, null, null) })
            .ToList();

        var response = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(owner, "https://chronolists.com/mcu", CancellationToken.None));

        Assert.True(response.Truncated);
        Assert.Equal(ListStore.MaxPlaceholders, response.SnapshotKeys!.Count);
        Assert.Equal("truncated", response.Snapshot!.State);
        Assert.Equal(SourceSnapshots.Digest(response.SnapshotKeys), response.Snapshot.Digest);
    }

    // ── SEC-05: counts hidden for every narrower view ──────────────────

    private static ImportHarness JeHousehold()
    {
        var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        return h;
    }

    private static void Rate(ImportHarness h, int tmdb, string certification) =>
        h.Tmdb["/3/movie/" + tmdb + "/release_dates"] = "{\"id\":" + tmdb + ",\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"" + certification + "\",\"type\":3}]}]}";

    [Fact]
    public async Task ARestrictedViewerGetsNoCountsEvenWhenOnlyIdLessOrAdultRowsWereLeftOut()
    {
        using var h = JeHousehold();
        var kid = h.NewUser("kid", maxRating: 10);
        Rate(h, 1, "PG");
        // Every titled entry is allowed; the list's adult row (an id-less gap) was dropped before the parental filter.
        h.Fetcher.Items = new List<SourceItem>
        {
            new("movie", 1, null, null, "One", 2001, null, null, null),
            new("movie", null, null, null, null, null, null, null, null),
        };

        var forKid = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(kid, "https://mdblist.com/lists/a/b", CancellationToken.None));

        Assert.Equal(new[] { 1 }, forKid.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.True(forKid.CountsHidden);
        Assert.Equal((0, 0), (forKid.Total, forKid.Dropped));
        Assert.Null(forKid.Snapshot);
    }

    [Fact]
    public async Task AViewerWithoutEveryLibraryGetsNoCountsOrSnapshot()
    {
        using var h = new ImportHarness();
        var limited = h.NewUser("limited");
        limited.SetPermission(PermissionKind.EnableAllFolders, false);
        var everyone = h.NewUser("everyone");
        h.Fetcher.Items = new List<SourceItem> { new("movie", 1, null, null, "One", 2001, null, null, null) };

        var forLimited = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(limited, "https://mdblist.com/lists/a/b", CancellationToken.None));
        var forEveryone = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(everyone, "https://mdblist.com/lists/a/b", CancellationToken.None));

        Assert.Equal((true, 0, (SourceSnapshotDto?)null), (forLimited.CountsHidden == true, forLimited.Total, forLimited.Snapshot));
        Assert.Null(forEveryone.CountsHidden);
        Assert.Equal(("complete", 1), (forEveryone.Snapshot!.State, forEveryone.Total));
    }

    // ── SEC-06: every transmission is charged ──────────────────────────

    private const string MdbJson = "https://mdblist.com/lists/me/mine/json";
    private const string OneMovie = "[{\"id\":49521,\"title\":\"Man of Steel\",\"mediatype\":\"movie\",\"release_year\":2013}]";

    [Fact]
    public async Task ARetryAfterA429IsChargedToTheProvidersAdmission()
    {
        using var net = new Net();
        var calls = 0;
        net.Routes[MdbJson] = _ => Interlocked.Increment(ref calls) == 1 ? Limited(1) : Json(OneMovie);

        var result = await net.Fetch("https://mdblist.com/lists/me/mine");

        Assert.True(result.Ok);
        Assert.Equal(2, net.Requests.Count);
        Assert.Equal(new[] { "mdblist", "mdblist" }, net.Admission.Admitted);
    }

    [Fact]
    public async Task ARetryWithoutAReadReservationIsNeverSent()
    {
        using var net = new Net();
        net.Admission.Allow = 1;
        net.Routes[MdbJson] = _ => Limited(1);

        var result = await net.Fetch("https://mdblist.com/lists/me/mine");

        Assert.Equal((false, SourceFailures.ReadBudgetExhausted), (result.Ok, result.ErrorCode));
        Assert.Single(net.Requests);
    }

    [Fact]
    public async Task EveryMdblistApiTransmissionTakesOneRequestOfTheDailyQuota()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.MdblistApiKey = "mdb-key";
        net.Plugin.Plugin.Configuration.ArrPhase4ListMdblistApiEnabled = true;
        net.Routes["https://api.mdblist.com/user"] = _ => Json("{\"rate_limit\":1000,\"rate_limit_remaining\":900}");
        var calls = 0;
        net.Routes["https://api.mdblist.com/lists/me/mine/items"] = _ => Interlocked.Increment(ref calls) % 2 == 1 ? Limited(1) : Json("{\"items\":[{\"ids\":{\"tmdb\":10193},\"title\":\"Toy Story 3\",\"mediatype\":\"movie\"}]}");
        var api = new SourceFetchOptions { AllowMdblistApi = true, Fresh = true };

        var charged = await net.Fetch("https://mdblist.com/lists/me/mine", api);
        Assert.True(charged.Ok);
        Assert.Equal(2, calls);
        Assert.Equal(898, net.Quota.RemainingQuota()); // the real quota: both transmissions charged
        // A retry the quota refuses is never sent: ListsImportReviewR2FixTests.TheRealQuotaRefusesARetryAtTheSafetyMargin.
    }

    // ── SEC-03: the source transport for every read, redirects typed ──

    [Fact]
    public async Task TmdbSourceReadsGoOverTheSourceTransportAndARedirectIsATypedFailure()
    {
        using var net = Tmdb();
        net.Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{\"id\":10,\"name\":\"Star Wars Collection\",\"parts\":[" + TmdbRow(11) + "]}");
        net.Routes["https://api.themoviedb.org/3/collection/11"] = _ =>
        {
            var redirect = new HttpResponseMessage(HttpStatusCode.Found) { Content = new StringContent(string.Empty) };
            redirect.Headers.Location = new Uri("http://169.254.169.254/latest/meta-data");
            return redirect;
        };

        Assert.True((await net.Fetch("https://www.themoviedb.org/collection/10")).Ok);
        Assert.All(net.Factory.Names, name => Assert.Equal(SourceClient, name)); // never TmdbResponseCache's default client
        Assert.NotEmpty(net.Factory.Names);

        var moved = await net.Fetch("https://www.themoviedb.org/collection/11");
        Assert.Equal((false, "source_redirected"), (moved.Ok, moved.ErrorCode));
        Assert.Equal(502, SourceOutcomes.FetchFailure(moved).StatusCode);
        Assert.DoesNotContain(net.Requests, r => r.RequestUri!.Host == "169.254.169.254");

        // The same for every other provider.
        net.Routes["https://mdblist.com/lists/me/moved/json"] = _ => new HttpResponseMessage(HttpStatusCode.MovedPermanently) { Content = new StringContent(string.Empty), Headers = { Location = new Uri("http://127.0.0.1/") } };
        Assert.Equal("source_redirected", (await net.Fetch("https://mdblist.com/lists/me/moved")).ErrorCode);
        Assert.All(net.Factory.Names, name => Assert.Equal(SourceClient, name));
    }
}
