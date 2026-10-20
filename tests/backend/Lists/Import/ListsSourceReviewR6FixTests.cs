using System.Diagnostics;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Xunit.Abstractions;
using static JE.Tests.ListsImportReviewR2FixTests;
using static JE.Tests.ListsSourceReviewR3FixTests;

namespace JE.Tests;

// Track 4c2a review round 6 (D53: a stored or counted fact is bound to the exact evidence it rests on).
// Rule 1, NotFound = proven absence: only a valid, definitive negative from EVERY source asked is NotFound (or an empty
// answer) and remembered; a malformed, missing or wrongly typed result, an unusable row, or a mix with any transient or
// unreadable answer is Transient and never remembered (4c2-R6-1: a TMDB episode find answering {} was a cached NotFound;
// 4c2-R6-2: one Seerr server's 404 made a NotFound while another failed). Rule 2, accounting per account: MDBList's quota
// status, counters and leases belong to one API key; a new key starts a fresh account whose status is read before it
// spends, and the old account's late answers and completions never touch it (4c2-R6-3). Rule 3, one admission per
// upstream request: every real call (each search leg, each fallback, each page) takes its own limiter admission
// (4c2-R6-4: `tmdb:<id>` sent two TMDB calls on one admission).
[Collection("Plugin singleton")]
public class ListsSourceReviewR6FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;

    private const string Tmdb = "api.themoviedb.org/3/";

    /// <summary>The TMDB (JE's key) and Seerr (two servers) lookups over one counting transport and one limiter.</summary>
    internal sealed class World : IDisposable
    {
        public World(TimeSpan? spacing = null)
        {
            var config = Plugin.Plugin.Configuration;
            config.TMDB_API_KEY = "tmdb-key";
            config.JellyseerrEnabled = true;
            config.JellyseerrUrls = "http://seerr-a.test\nhttp://seerr-b.test";
            config.JellyseerrApiKey = "seerr-key";
            Transport = new IntegrationTransport((request, _) =>
            {
                var at = request.RequestUri!.Host + request.RequestUri.AbsolutePath;
                lock (Calls)
                {
                    Calls.Add((at, Stopwatch.GetTimestamp()));
                }

                return Task.FromResult(Routes.TryGetValue(at, out var route) ? route(request) : Json("{\"status_code\":34,\"message\":\"not found\"}", 404));
            });
            Limiter = new MetadataCallLimiter(4, spacing ?? TimeSpan.Zero, TimeProvider.System);
            Cache = new TmdbResponseCache(Transport, TimeProvider.System);
            TmdbLookup = new TmdbImportLookup(Cache, Limiter, Plugin.Core.Logger);
            SeerrLookup = new SeerrImportLookup(Transport, Limiter, Cache, Plugin.Core.Logger);
        }

        public ApiPluginFixture Plugin { get; } = new();

        /// <summary>Answers by host + path (no query).</summary>
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);

        public List<(string At, long Timestamp)> Calls { get; } = new();

        public IntegrationTransport Transport { get; }

        public MetadataCallLimiter Limiter { get; }

        public TmdbResponseCache Cache { get; }

        public TmdbImportLookup TmdbLookup { get; }

        public SeerrImportLookup SeerrLookup { get; }

        public ImportCallContext Context { get; } = new("r6", false);

        public int Total
        {
            get
            {
                lock (Calls)
                {
                    return Calls.Count;
                }
            }
        }

        public long Admissions => Limiter.Stats().Total;

        public IImportLookup Lookup(string name) => name == "tmdb" ? TmdbLookup : SeerrLookup;

        public void Answer(string at, string body, int status = 200) => Routes[at] = _ => Answer(body, status);

        public void Dispose()
        {
            Cache.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }

        // "refused" stands for a server that doesn't answer at all.
        private static HttpResponseMessage Answer(string body, int status) => status < 0 ? throw new HttpRequestException("connection refused") : Json(body, status);
    }

    // ── Rule 1: an IMDb episode find is NotFound only on a valid empty answer (4c2-R6-1) ──

    private const string Episode = "{\"show_id\":1412,\"season_number\":1,\"episode_number\":2,\"name\":\"Honor Thy Father\",\"air_date\":\"2012-10-17\"}";

    private static readonly Dictionary<string, (string Body, int Status)> FindAnswers = new()
    {
        ["valid empty"] = ("{\"movie_results\":[],\"tv_results\":[],\"tv_episode_results\":[]}", 200),
        ["404"] = ("{\"status_code\":34}", 404),
        ["{}"] = ("{}", 200),
        ["null"] = ("{\"movie_results\":[],\"tv_results\":[],\"tv_episode_results\":null}", 200),
        ["wrong type"] = ("{\"movie_results\":[],\"tv_results\":[],\"tv_episode_results\":{\"show_id\":1412}}", 200),
        ["unusable row"] = ("{\"movie_results\":[],\"tv_results\":[],\"tv_episode_results\":[{\"show_id\":1412,\"name\":\"no coordinates\"}]}", 200),
        ["not an object"] = ("[]", 200),
        ["503"] = ("{\"status_code\":11}", 503),
    };

    public static IEnumerable<object[]> FindCells() =>
        from lookup in new[] { "tmdb", "seerr" } from answer in FindAnswers.Keys select new object[] { lookup, answer };

    [Theory]
    [MemberData(nameof(FindCells))]
    public async Task AnEpisodeFindIsNotFoundOnlyOnAValidEmptyAnswerAndAnythingElseIsAskedAgain(string lookup, string answer)
    {
        using var w = new World();
        var (body, status) = FindAnswers[answer];
        var repaired = false;
        w.Routes[Tmdb + "find/tt2338304"] = _ => Volatile.Read(ref repaired)
            ? Json("{\"movie_results\":[],\"tv_results\":[],\"tv_episode_results\":[" + Episode + "]}")
            : Json(body, status);

        var first = await w.Lookup(lookup).FindImdbEpisodeAsync("tt2338304", w.Context, None);
        Volatile.Write(ref repaired, true); // TMDB answers properly from now on
        var second = await w.Lookup(lookup).FindImdbEpisodeAsync("tt2338304", w.Context, None);
        output.WriteLine(lookup + " " + answer + ": " + first.Status + " then " + second.Status + ", " + w.Total + " call(s)");

        if (answer is "valid empty" or "404")
        {
            Assert.Equal(LookupStatus.NotFound, first.Status);
            Assert.Equal(LookupStatus.NotFound, second.Status); // a proven absence is remembered
            Assert.Equal(1, w.Total);
        }
        else
        {
            Assert.Equal(LookupStatus.Transient, first.Status);
            Assert.Equal(LookupStatus.Ok, second.Status); // never remembered: the next review finds the episode
            Assert.Equal((1412, 1, 2), (second.Value!.ShowTmdbId, second.Value.Season, second.Value.Episode));
            Assert.Equal(2, w.Total);
        }
    }

    // ── Rule 1: every TMDB search form (each "no titles" answer) ──

    private const string ManOfSteel = "{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\"}";

    // Whole details (round 7: details without their external ids are Partial, never kept).
    private const string ManOfSteelDetails = "{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"imdb_id\":\"tt0770828\",\"external_ids\":{\"imdb_id\":\"tt0770828\"}}";

    private static readonly string[] Shapes = { "valid empty", "dropped rows", "{}", "null", "wrong type", "unusable row", "mixed" };

    // The routes of one search form answering in one shape, or (shape "found") with Man of Steel.
    private static (string Query, Dictionary<string, (string Body, int Status)> Routes) SearchForm(string form, string shape)
    {
        string Find() => shape switch
        {
            "valid empty" => "{\"movie_results\":[],\"tv_results\":[]}",
            "dropped rows" => "{\"movie_results\":[{\"id\":1,\"title\":\"Adult\",\"adult\":true}],\"tv_results\":[]}",
            "{}" => "{}",
            "null" => "{\"movie_results\":null,\"tv_results\":null}",
            "wrong type" => "{\"movie_results\":{},\"tv_results\":\"x\"}",
            "unusable row" => "{\"movie_results\":[{\"id\":49521}],\"tv_results\":[]}",
            "mixed" => "{\"movie_results\":[],\"tv_results\":null}",
            _ => "{\"movie_results\":[" + ManOfSteel + "],\"tv_results\":[]}",
        };

        return form switch
        {
            "imdb" => ("imdb:tt0770828", new() { [Tmdb + "find/tt0770828"] = (Find(), 200) }),
            "tvdb" => ("tvdb:257655", new() { [Tmdb + "find/257655"] = (Find(), 200) }),
            "tmdb" => ("tmdb:49521", new()
            {
                [Tmdb + "movie/49521"] = shape switch
                {
                    "valid empty" or "mixed" => ("{\"status_code\":34}", 404),
                    "dropped rows" => ("{\"id\":49521,\"title\":\"Adult\",\"adult\":true}", 200),
                    "{}" => ("{}", 200),
                    "null" => ("null", 200),
                    "wrong type" => ("[]", 200),
                    "unusable row" => ("{\"id\":49521}", 200),
                    _ => (ManOfSteel, 200),
                },
                [Tmdb + "tv/49521"] = shape == "mixed" ? ("{\"status_code\":11}", 503) : ("{\"status_code\":34}", 404),
            }),
            "year" => ("Man of Steel year:2013", new()
            {
                [Tmdb + "search/movie"] = (shape switch
                {
                    "valid empty" or "mixed" => "{\"results\":[]}",
                    "dropped rows" => "{\"results\":[{\"id\":1,\"title\":\"Adult\",\"adult\":true}]}",
                    "{}" => "{}",
                    "null" => "{\"results\":null}",
                    "wrong type" => "{\"results\":{}}",
                    "unusable row" => "{\"results\":[{\"id\":5}]}",
                    _ => "{\"results\":[" + ManOfSteel + "]}",
                }, 200),
                [Tmdb + "search/tv"] = shape == "mixed" ? ("{}", 200) : ("{\"results\":[]}", 200),
            }),
            _ => ("Man of Steel", new()
            {
                [Tmdb + "search/multi"] = (shape switch
                {
                    "valid empty" => "{\"results\":[]}",
                    "dropped rows" => "{\"results\":[{\"media_type\":\"person\",\"id\":3,\"name\":\"Henry Cavill\"},{\"media_type\":\"movie\",\"id\":4,\"title\":\"Adult\",\"adult\":true}]}",
                    "{}" => "{}",
                    "null" => "{\"results\":null}",
                    "wrong type" => "{\"results\":\"x\"}",
                    "unusable row" => "{\"results\":[{\"id\":5,\"title\":\"No type\"}]}",
                    "mixed" => "{\"results\":[{\"media_type\":\"person\",\"id\":3,\"name\":\"Henry Cavill\"},{\"media_type\":\"movie\",\"id\":6}]}",
                    _ => "{\"results\":[{\"media_type\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\"}]}",
                }, 200),
            }),
        };
    }

    public static IEnumerable<object[]> SearchCells() =>
        from form in new[] { "imdb", "tvdb", "tmdb", "year", "multi" } from shape in Shapes select new object[] { form, shape };

    [Theory]
    [MemberData(nameof(SearchCells))]
    public async Task ASearchFindsNoTitlesOnlyOnAValidAnswerAndAnUnreadableOneIsAskedAgain(string form, string shape)
    {
        using var w = new World();
        var (query, routes) = SearchForm(form, shape);
        foreach (var (at, (body, status)) in routes)
        {
            w.Answer(at, body, status);
        }

        var first = await w.TmdbLookup.SearchAsync(query, w.Context, None);
        var calls = w.Total;
        foreach (var (at, (body, status)) in SearchForm(form, "found").Routes)
        {
            w.Answer(at, body, status); // TMDB answers properly from now on
        }

        if (shape == "mixed" && form is "tmdb" or "year")
        {
            // Two requests, one valid (kept) and one failed: only the failed one is asked again, and it finds the show.
            w.Answer(form == "tmdb" ? Tmdb + "tv/49521" : Tmdb + "search/tv", form == "tmdb" ? "{\"id\":49521,\"name\":\"Man of Steel\"}" : "{\"results\":[{\"id\":49521,\"name\":\"Man of Steel\"}]}");
        }

        var second = await w.TmdbLookup.SearchAsync(query, w.Context, None);
        output.WriteLine(form + " " + shape + ": " + first.Status + "/" + first.Value?.Count + " then " + second.Status + "/" + second.Value?.Count + ", calls " + calls + " then " + w.Total);

        if (shape is "valid empty" or "dropped rows")
        {
            Assert.Equal(LookupStatus.Ok, first.Status);
            Assert.Empty(first.Value!);
            Assert.Empty(second.Value!); // a valid "no titles" is remembered
            Assert.Equal(calls, w.Total);
        }
        else
        {
            Assert.Equal(LookupStatus.Transient, first.Status);
            Assert.Equal(LookupStatus.Ok, second.Status); // never remembered (nor kept by the response cache): asked again
            Assert.Equal(49521, Assert.Single(second.Value!).TmdbId);
            Assert.True(w.Total > calls);
        }
    }

    [Theory]
    [InlineData("tmdb")]
    [InlineData("seerr")]
    public async Task ATitleFoundBesideAnUnusableRowIsUsedButNeverRemembered(string lookup)
    {
        using var w = new World();
        w.Answer(Tmdb + "search/multi", "{\"results\":[{\"media_type\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\"},{\"media_type\":\"tv\",\"id\":9}]}");
        w.Answer("seerr-a.test/api/v1/search", "{\"results\":[{\"mediaType\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\"},{\"mediaType\":\"tv\",\"id\":9}]}");

        var first = await w.Lookup(lookup).SearchAsync("Man of Steel", w.Context, None);
        var second = await w.Lookup(lookup).SearchAsync("Man of Steel", w.Context, None);

        Assert.Equal(49521, Assert.Single(first.Value!).TmdbId);
        Assert.Equal(LookupStatus.Ok, second.Status);
        // The answer was incomplete: not remembered (round 7: Seerr's partial answer also asks the next server, which
        // has nothing here, so each search sends two requests).
        Assert.Equal(lookup == "tmdb" ? 2 : 4, w.Total);
    }

    [Fact]
    public async Task ASeerrSearchOfOnlyUnusableRowsIsTransientNotEmpty()
    {
        using var w = new World();
        w.Answer("seerr-a.test/api/v1/search", "{\"results\":[{\"mediaType\":\"movie\",\"id\":5},{\"id\":6,\"title\":\"No type\"}]}");
        Assert.Equal(LookupStatus.Transient, (await w.SeerrLookup.SearchAsync("Man of Steel", w.Context, None)).Status);

        w.Answer("seerr-a.test/api/v1/search", "{\"results\":[{\"mediaType\":\"person\",\"id\":3,\"name\":\"Henry Cavill\"}]}"); // control: valid
        var valid = await w.SeerrLookup.SearchAsync("Man of Steel", w.Context, None);
        Assert.Equal(LookupStatus.Ok, valid.Status);
        Assert.Empty(valid.Value!);
    }

    // ── Rule 1: the derived negatives (an episode missing from a season, a season missing from a show) ──

    public static IEnumerable<object[]> ListCells() =>
        from lookup in new[] { "tmdb", "seerr" } from kind in new[] { "season", "details" } from shape in new[] { "valid", "valid empty", "unusable row" }
        select new object[] { lookup, kind, shape };

    [Theory]
    [MemberData(nameof(ListCells))]
    public async Task ASeasonOrShowWithAnUnusableRowIsNeverTakenAsTheWholeList(string lookup, string kind, string shape)
    {
        using var w = new World();
        var tmdb = lookup == "tmdb";
        string Row(int n) => tmdb
            ? (kind == "season" ? "{\"episode_number\":" + n + ",\"season_number\":1}" : "{\"season_number\":" + n + ",\"episode_count\":8}")
            : (kind == "season" ? "{\"episodeNumber\":" + n + ",\"seasonNumber\":1}" : "{\"seasonNumber\":" + n + ",\"episodeCount\":8}");
        var rows = shape switch
        {
            "valid" => Row(1) + "," + Row(2),
            "valid empty" => string.Empty,
            _ => Row(1) + ",{\"name\":\"no number\"}",
        };
        var at = (tmdb ? Tmdb : "seerr-a.test/api/v1/") + (kind == "season" ? "tv/1412/season/1" : "tv/1412");
        var ids = tmdb ? ",\"external_ids\":{\"imdb_id\":null,\"tvdb_id\":null}" : ",\"externalIds\":{\"imdbId\":null,\"tvdbId\":null}";
        w.Answer(at, kind == "season" ? "{\"episodes\":[" + rows + "]}" : "{\"id\":1412,\"name\":\"Arrow\"" + ids + ",\"seasons\":[" + rows + "]}");

        async Task<(LookupStatus Status, int? Count)> Read()
        {
            if (kind == "season")
            {
                var season = await w.Lookup(lookup).GetSeasonAsync(1412, 1, w.Context, None);
                return (season.Status, season.Value?.Count);
            }

            var details = await w.Lookup(lookup).GetDetailsAsync("tv", 1412, w.Context, None);
            return (details.Status, details.Value?.Seasons.Count);
        }

        var first = await Read();
        var second = await Read();
        output.WriteLine(lookup + " " + kind + " " + shape + ": " + first + " then " + second + ", " + w.Total + " call(s)");
        if (shape == "unusable row")
        {
            Assert.Equal(LookupStatus.Transient, first.Status); // a list missing a row would make an episode or season "missing"
            Assert.Equal(LookupStatus.Transient, second.Status);
            Assert.True(w.Total >= 2);
        }
        else
        {
            Assert.Equal((LookupStatus.Ok, shape == "valid" ? 2 : 0), first);
            Assert.Equal(first, second);
            Assert.Equal(1, w.Total);
        }
    }

    // ── Rule 1: Seerr is NotFound only when EVERY server proved it (4c2-R6-2) ──

    public static IEnumerable<object[]> ServerCells() =>
        from kind in new[] { "details", "season" }
        from pair in new[] { "404 404", "404 503", "503 404", "404 refused", "refused 404", "unreadable valid", "404 unreadable", "404 valid" }
        select new object[] { kind, pair };

    [Theory]
    [MemberData(nameof(ServerCells))]
    public async Task ASeerrNotFoundNeedsEveryServersProofAndAFailedServerIsAskedAgain(string kind, string pair)
    {
        using var w = new World();
        var path = kind == "details" ? "api/v1/tv/1412" : "api/v1/tv/1412/season/1";
        var valid = kind == "details" ? "{\"id\":1412,\"name\":\"Arrow\",\"externalIds\":{\"imdbId\":null,\"tvdbId\":null},\"seasons\":[]}" : "{\"episodes\":[{\"episodeNumber\":1,\"seasonNumber\":1}]}";
        void Serve(string host, string outcome) => w.Answer(host + "/" + path, outcome switch
        {
            "valid" => valid,
            "unreadable" => "{\"unexpected\":true}",
            _ => "{\"message\":\"x\"}",
        }, outcome switch { "404" => 404, "503" => 503, "refused" => -1, _ => 200 });

        var outcomes = pair.Split(' ');
        Serve("seerr-a.test", outcomes[0]);
        Serve("seerr-b.test", outcomes[1]);
        async Task<LookupStatus> Read() => kind == "details"
            ? (await w.SeerrLookup.GetDetailsAsync("tv", 1412, w.Context, None)).Status
            : (await w.SeerrLookup.GetSeasonAsync(1412, 1, w.Context, None)).Status;

        var first = await Read();
        var calls = w.Total;
        Serve("seerr-a.test", outcomes[0] == "404" ? "404" : "valid");
        Serve("seerr-b.test", "valid"); // the failed server recovers
        var second = await Read();
        output.WriteLine(kind + " " + pair + ": " + first + " then " + second + ", calls " + calls + " then " + w.Total);

        var expected = pair switch
        {
            "404 404" => LookupStatus.NotFound,
            "unreadable valid" or "404 valid" => LookupStatus.Ok,
            _ => LookupStatus.Transient,
        };
        Assert.Equal(expected, first);
        Assert.Equal(2, calls); // both servers asked
        if (expected == LookupStatus.Transient)
        {
            Assert.Equal(LookupStatus.Ok, second); // never remembered: asked again and found
            Assert.True(w.Total > calls);
        }
        else
        {
            Assert.Equal(expected, second);
            Assert.Equal(calls, w.Total); // a proven answer is remembered
        }
    }

    [Theory]
    [InlineData("404 valid", true)]
    [InlineData("404 404", false)]
    [InlineData("503 valid", true)]
    public async Task ListMetadataTakesASeerrNotFoundOnlyWhenEveryServerSaidSo(string pair, bool found)
    {
        using var w = new World();
        w.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        var outcomes = pair.Split(' ');
        foreach (var (host, outcome) in new[] { ("seerr-a.test", outcomes[0]), ("seerr-b.test", outcomes[1]) })
        {
            w.Answer(host + "/api/v1/movie/10", outcome == "valid" ? "{\"id\":10,\"releaseDate\":\"2010-07-16\"}" : "{\"message\":\"x\"}", outcome == "valid" ? 200 : int.Parse(outcome, System.Globalization.CultureInfo.InvariantCulture));
        }

        var metadata = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        var read = await metadata.FetchAsync(ListsHarness.Movie(10), TimeSpan.FromHours(1), DateTime.UtcNow, None);
        Assert.Equal(found, read?.ReleaseDate == "2010-07-16");
        Assert.Equal(2, w.Total); // the second server was asked
    }

    [Theory]
    [InlineData("{}", false)]
    [InlineData("[]", false)]
    [InlineData("{\"id\":10,\"poster_path\":null}", true)]
    [InlineData("{\"id\":10,\"poster_path\":\"/p.jpg\"}", true)]
    public async Task AListPosterIsAnsweredOnlyByAValidTmdbAnswer(string body, bool answered)
    {
        using var w = new World();
        w.Answer(Tmdb + "movie/10", body);
        var metadata = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);

        var first = await metadata.ReadTmdbPosterAsync(ListsHarness.Movie(10), None);
        await metadata.ReadTmdbPosterAsync(ListsHarness.Movie(10), None);

        Assert.Equal(answered, first.Answered);
        Assert.Equal(answered ? 1 : 2, w.Total); // an unreadable answer is never remembered as "no poster"
    }

    // ── Rule 2: MDBList accounting per account (4c2-R6-3) ──

    private const string KeyA = "mdb-key"; // MdblistApiNet's
    private const string KeyB = "mdb-key-b";
    private const string BatchRoute = "https://api.mdblist.com/tmdb/movie/";
    private static readonly string[] Lists = { "a", "b", "c", "d" };

    // One ratings lookup per list letter (a → 40, b → 41, …): each is a title of its own, so the ratings cache never answers.
    private static string RatingsId(string list) => (40 + Array.IndexOf(Lists, list)).ToString(System.Globalization.CultureInfo.InvariantCulture);

    // Two MDBList accounts behind one API, each counting a request when it answers it.
    private sealed class Accounts : IDisposable
    {
        private int _a;
        private int _b;

        public Accounts(int a, int b)
        {
            Net = MdblistApiNet(() => a);
            Net.Routes["https://api.mdblist.com/user"] = r => Json(Status(Key(r) == KeyB ? b - Volatile.Read(ref _b) : a - Volatile.Read(ref _a)));
            var routes = new[] { BatchRoute }.Concat(Lists.Select(l => "https://api.mdblist.com/lists/me/" + l + "/items")).Concat(Lists.Select(l => BatchRoute + RatingsId(l))).ToArray();
            foreach (var route in routes)
            {
                var answer = Net.Routes.TryGetValue(route, out var list) ? list : _ => Json(route == BatchRoute ? "[]" : "{\"ratings\":[],\"ids\":{\"tmdb\":42}}");
                Net.Routes[route] = r =>
                {
                    Hold?.Invoke(r);
                    var response = answer(r);
                    if (Key(r) == KeyB)
                    {
                        Interlocked.Increment(ref _b);
                    }
                    else
                    {
                        Interlocked.Increment(ref _a);
                    }

                    return response;
                };
            }
        }

        public Net Net { get; }

        public Action<HttpRequestMessage>? Hold { get; set; }

        public static string Key(HttpRequestMessage request) => Query(request, "apikey");

        // What every request carrying `key` asked for, in order ("user" or the path).
        public string[] Sent(string key)
        {
            lock (Net.Requests)
            {
                return Net.Requests.Where(r => Key(r) == key).Select(r => r.RequestUri!.AbsolutePath == "/user" ? "user" : r.RequestUri.AbsolutePath).ToArray();
            }
        }

        public void Dispose() => Net.Dispose();
    }

    private static async Task<bool> SpendAsync(Net net, string kind, string list = "b") => kind switch
    {
        "list" => (await net.Fetch("https://mdblist.com/lists/me/" + list, ApiRead)).Ok,
        "single" => await SingleSentAsync(net, list),
        _ => await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None) != null,
    };

    private static async Task<bool> SingleSentAsync(Net net, string list)
    {
        var route = "https://api.mdblist.com/tmdb/movie/" + RatingsId(list);
        var before = net.Sent(route);
        await net.Quota.GetRatingsAsync("movie", RatingsId(list), None);
        return net.Sent(route) > before;
    }

    [Theory]
    [InlineData("list")]
    [InlineData("single")]
    [InlineData("batch")]
    [InlineData("status")]
    public async Task ANewMdblistKeyIsAFreshAccountWhoseStatusIsReadBeforeItSpends(string kind)
    {
        using var accounts = new Accounts(a: 20, b: MdblistService.SafetyMargin);
        var net = accounts.Net;
        Assert.True(await SpendAsync(net, "list", "a")); // key A: 20 → 19
        net.Config.MdblistApiKey = KeyB; // the admin replaces the key: B has only the margin left

        if (kind == "status")
        {
            var status = await net.Quota.GetAccountStatusAsync(None);
            Assert.Equal(MdblistService.SafetyMargin, status!.RateLimitRemaining); // B's answer, not A's held one
        }
        else
        {
            Assert.False(await SpendAsync(net, kind, "b"), kind + " was sent with key B on key A's balance");
        }

        output.WriteLine("A: " + string.Join(",", accounts.Sent(KeyA)) + "; B: " + string.Join(",", accounts.Sent(KeyB)));
        Assert.Equal(new[] { "user" }, accounts.Sent(KeyB)); // B's status was read, and nothing was spent
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Theory]
    [InlineData("list")]
    [InlineData("single")]
    [InlineData("batch")]
    public async Task AnOldAccountsLateCompletionNeverTouchesTheNewOne(string kind)
    {
        using var accounts = new Accounts(a: 20, b: MdblistService.SafetyMargin + 2);
        var net = accounts.Net;
        var arrived = false;
        using var release = new ManualResetEventSlim();
        accounts.Hold = r =>
        {
            if (Accounts.Key(r) == KeyA && r.RequestUri!.AbsolutePath.EndsWith("/a/items", StringComparison.Ordinal))
            {
                Volatile.Write(ref arrived, true);
                release.Wait(TimeSpan.FromSeconds(10)); // A's request is on its way
            }
        };

        var a = Task.Run(() => net.Fetch("https://mdblist.com/lists/me/a", ApiRead));
        await WaitUntil(() => Volatile.Read(ref arrived));
        net.Config.MdblistApiKey = KeyB; // replaced while A's request (and its lease) is outstanding

        var first = await SpendAsync(net, kind, "b"); // B: 7 → 6
        release.Set();
        Assert.True((await a).Ok); // A's late completion
        var second = await SpendAsync(net, kind, "c"); // B: 6 → 5
        var third = await SpendAsync(net, kind, "d"); // B at the margin

        output.WriteLine(kind + ": " + first + ", " + second + ", " + third + "; B sent " + string.Join(",", accounts.Sent(KeyB)) + "; remaining " + net.Quota.RemainingQuota());
        Assert.Equal((true, true, false), (first, second, third));
        Assert.Equal("user", accounts.Sent(KeyB)[0]); // B's status before B's first request
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Fact]
    public async Task AnOldAccountsLateStatusAnswerIsNeverHeldForTheNewOne()
    {
        using var accounts = new Accounts(a: 20, b: MdblistService.SafetyMargin + 1);
        var net = accounts.Net;
        Assert.True(await SpendAsync(net, "list", "a")); // A's status held: 20 → 19
        var status = net.Routes["https://api.mdblist.com/user"];
        var arrived = false;
        using var release = new ManualResetEventSlim();
        net.Routes["https://api.mdblist.com/user"] = r =>
        {
            if (Accounts.Key(r) == KeyA)
            {
                Volatile.Write(ref arrived, true);
                release.Wait(TimeSpan.FromSeconds(10)); // A's refresh is slow
            }

            return status(r);
        };

        var refresh = Task.Run(() => net.Quota.GetAccountStatusAsync(None, forceRefresh: true)); // asked with A
        await WaitUntil(() => Volatile.Read(ref arrived));
        net.Config.MdblistApiKey = KeyB;
        var spent = await SpendAsync(net, "list", "b"); // B: 6 → 5
        release.Set();
        var late = await refresh; // A's answer arrives after the switch

        Assert.True(spent);
        Assert.Equal(19, late!.RateLimitRemaining); // A's own figures
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota()); // B's balance untouched by A's answer
        Assert.False(await SpendAsync(net, "list", "c"));
        Assert.Equal(MdblistService.SafetyMargin, (await net.Quota.GetAccountStatusAsync(None))!.RateLimitRemaining);
    }

    [Fact] // control, green before and after: the same key keeps its account (one status read for several requests)
    public async Task TheSameKeyKeepsItsAccount()
    {
        using var accounts = new Accounts(a: 20, b: 0);
        var net = accounts.Net;
        Assert.True(await SpendAsync(net, "list", "a"));
        Assert.True(await SpendAsync(net, "single", "b"));
        Assert.True(await SpendAsync(net, "batch", "c"));
        Assert.Equal(1, accounts.Sent(KeyA).Count(s => s == "user"));
        Assert.Equal(17, net.Quota.RemainingQuota());
    }

    private static string PluginRoot([System.Runtime.CompilerServices.CallerFilePath] string caller = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(caller)!, "..", "..", "..", "..", "Jellyfin.Plugin.JellyfinEnhanced"));

    [Fact]
    public void TheQuotaIsKeptPerAccountAndNoKeyIsEverLogged()
    {
        var code = File.ReadAllText(Path.Combine(PluginRoot(), "Services", "MdblistService.cs"));
        foreach (Match log in Regex.Matches(code, @"_logger\.\w+\(\$?""[^;]*;"))
        {
            Assert.DoesNotMatch(@"\{\s*(?:apiKey|key|account\.Key)\b", log.Value); // a fingerprint at most
        }

        Assert.DoesNotMatch(@"private\s+MdblistAccountStatus\?\s+_accountStatus\b|private\s+int\s+_outstanding\b", code); // no global balance
    }

    // ── Rule 3: one admission per upstream request (4c2-R6-4) ──

    public static IEnumerable<object[]> AdmissionCells() => new[]
    {
        new object[] { "tmdb id (movie + tv)", 2 },
        new object[] { "year search (movie + tv)", 2 },
        new object[] { "multi search", 1 },
        new object[] { "imdb find", 1 },
        new object[] { "details", 1 },
        new object[] { "season", 1 },
        new object[] { "episode find (tmdb)", 1 },
        new object[] { "episode find (seerr)", 1 },
        new object[] { "seerr details, one server", 1 },
        new object[] { "seerr details, fallback", 2 },
        new object[] { "seerr season, fallback", 2 },
        new object[] { "seerr search, fallback", 2 },
        new object[] { "answered by the response cache", 0 },
        new object[] { "answered by the lookup cache", 0 },
    };

    [Theory]
    [MemberData(nameof(AdmissionCells))]
    public async Task EveryUpstreamRequestTakesItsOwnAdmission(string path, int expected)
    {
        using var w = new World();
        w.Answer(Tmdb + "movie/49521", ManOfSteelDetails);
        w.Answer(Tmdb + "search/movie", "{\"results\":[" + ManOfSteel + "]}");
        w.Answer(Tmdb + "search/tv", "{\"results\":[]}");
        w.Answer(Tmdb + "search/multi", "{\"results\":[{\"media_type\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\"}]}");
        w.Answer(Tmdb + "find/tt0770828", "{\"movie_results\":[" + ManOfSteel + "],\"tv_results\":[]}");
        w.Answer(Tmdb + "tv/1412/season/1", "{\"episodes\":[{\"episode_number\":1}]}");
        w.Answer(Tmdb + "find/tt2338304", "{\"tv_episode_results\":[" + Episode + "]}");
        w.Answer("seerr-a.test/api/v1/movie/49521", "{\"id\":49521,\"title\":\"Man of Steel\",\"imdbId\":null}");
        w.Answer("seerr-a.test/api/v1/tv/1412", "{}", 503);
        w.Answer("seerr-b.test/api/v1/tv/1412", "{\"id\":1412,\"name\":\"Arrow\",\"seasons\":[]}");
        w.Answer("seerr-a.test/api/v1/tv/1412/season/1", "{}", 503);
        w.Answer("seerr-b.test/api/v1/tv/1412/season/1", "{\"episodes\":[]}");
        w.Answer("seerr-a.test/api/v1/search", "{}", 503);
        w.Answer("seerr-b.test/api/v1/search", "{\"results\":[{\"mediaType\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\"}]}");
        if (path == "answered by the response cache")
        {
            await w.Cache.GetAsync("movie/49521", "?append_to_response=external_ids", "tmdb-key", None); // another feature read it
        }
        else if (path == "answered by the lookup cache")
        {
            await w.TmdbLookup.GetDetailsAsync("movie", 49521, w.Context, None);
        }

        var (calls, admissions) = (w.Total, w.Admissions);
        Task task = path switch
        {
            "tmdb id (movie + tv)" => w.TmdbLookup.SearchAsync("tmdb:49521", w.Context, None),
            "year search (movie + tv)" => w.TmdbLookup.SearchAsync("Man of Steel year:2013", w.Context, None),
            "multi search" => w.TmdbLookup.SearchAsync("Man of Steel", w.Context, None),
            "imdb find" => w.TmdbLookup.SearchAsync("imdb:tt0770828", w.Context, None),
            "season" => w.TmdbLookup.GetSeasonAsync(1412, 1, w.Context, None),
            "episode find (tmdb)" => w.TmdbLookup.FindImdbEpisodeAsync("tt2338304", w.Context, None),
            "episode find (seerr)" => w.SeerrLookup.FindImdbEpisodeAsync("tt2338304", w.Context, None),
            "seerr details, one server" => w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None),
            "seerr details, fallback" => w.SeerrLookup.GetDetailsAsync("tv", 1412, w.Context, None),
            "seerr season, fallback" => w.SeerrLookup.GetSeasonAsync(1412, 1, w.Context, None),
            "seerr search, fallback" => w.SeerrLookup.SearchAsync("Man of Steel", w.Context, None),
            _ => w.TmdbLookup.GetDetailsAsync("movie", 49521, w.Context, None),
        };
        await task;

        var sent = w.Total - calls;
        var admitted = w.Admissions - admissions;
        output.WriteLine(path + ": " + sent + " call(s), " + admitted + " admission(s), counted " + w.Context.Calls);
        Assert.Equal(expected, sent);
        Assert.Equal(sent, admitted);
    }

    [Theory]
    [InlineData("tmdb id")]
    [InlineData("year search")]
    [InlineData("seerr fallback")]
    public async Task TheLimiterSpacesEveryRealCall(string path)
    {
        var spacing = TimeSpan.FromMilliseconds(80);
        using var w = new World(spacing);
        w.Answer(Tmdb + "movie/49521", ManOfSteel);
        w.Answer(Tmdb + "search/movie", "{\"results\":[]}");
        w.Answer(Tmdb + "search/tv", "{\"results\":[]}");
        w.Answer("seerr-a.test/api/v1/movie/49521", "{}", 503);
        w.Answer("seerr-b.test/api/v1/movie/49521", "{\"id\":49521,\"title\":\"Man of Steel\"}");

        await (path switch
        {
            "tmdb id" => (Task)w.TmdbLookup.SearchAsync("tmdb:49521", w.Context, None),
            "year search" => w.TmdbLookup.SearchAsync("Man of Steel year:2013", w.Context, None),
            _ => w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None),
        });

        var starts = w.Calls.Select(c => c.Timestamp).ToArray();
        Assert.Equal(2, starts.Length);
        var gap = Stopwatch.GetElapsedTime(starts[0], starts[1]);
        output.WriteLine(path + ": the two calls started " + gap.TotalMilliseconds.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " ms apart");
        Assert.True(gap >= spacing - TimeSpan.FromMilliseconds(15), path + ": the second call started " + gap.TotalMilliseconds + " ms after the first");
    }

    [Fact] // control, green before and after: the list fetcher's Seerr fallback takes an admission per attempt (a retry too)
    public async Task TheFetchersSeerrFallbackTakesAnAdmissionPerAttempt()
    {
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        using var net = new Net(limiter: limiter);
        net.Config.TMDB_API_KEY = string.Empty;
        net.Config.JellyseerrEnabled = true;
        net.Config.JellyseerrUrls = "http://seerr.test";
        net.Config.JellyseerrApiKey = "seerr-key";
        var attempts = 0;
        net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Interlocked.Increment(ref attempts) == 1
            ? Limited(1)
            : Json("{\"id\":10,\"name\":\"C\",\"parts\":[{\"id\":1,\"mediaType\":\"movie\",\"title\":\"M1\",\"releaseDate\":\"2001-01-01\"}]}");

        var result = await net.Fetch("https://www.themoviedb.org/collection/10");

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal(2, attempts);
        Assert.Equal(2, limiter.Stats().Total);
    }
}
