using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Xunit.Abstractions;
using static JE.Tests.ListsImportReviewR2FixTests;
using static JE.Tests.ListsSourceReviewR3FixTests;
using R7 = JE.Tests.ListsSourceReviewR7FixTests;
using World = JE.Tests.ListsSourceReviewR6FixTests.World;

namespace JE.Tests;

// Track 4c2a review round 11 (D53, 11th round: r10's request binding held; the leaks sit one layer down, in the transport
// envelope).
// 1. Absence targets the queried root exactly (4c2-R11-1): IMDb's not-found on a title INSIDE the list (a descendant of the
//    queried root) or a null propagated from a field that isn't the root's identity is an error answer, never "private or
//    missing". Every GraphQL root JE queries (list, predefinedList, chartTitles, userProfile) × nested paths.
// 2. Composite reads carry one verdict (4c2-R11-2): a read made of steps (a `p.` profile → its watchlist → pages; a list's
//    pages; a Trakt read's drift probe) is complete only when every step's envelope is clean; a malformed envelope (errors
//    that aren't a list of error objects) fails; a partial step blocks completeness AND the fetcher's cache.
// 3. Every HTTP read is bounded (4c2-R11-3): each read site of the list and metadata code (list sources, Seerr metadata and
//    lookups, TMDB posters and lookups, MDBList ratings, batch and account status) through its production entry point with a
//    9 MiB answer, a success's or an error's, announced or not: never used, and nothing past the cap is read. A source scan
//    fails on any other body read in that code.
[Collection("Plugin singleton")]
public class ListsSourceReviewR11FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly DateTime Today = new(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly SourceFetchOptions Kept = new() { Fresh = false };

    // ── GraphQL fixtures ──

    private static string Error(string code, params object[] path) =>
        "{\"message\":\"m\",\"path\":[" + string.Join(',', path.Select(p => p is int n ? n.ToString(CultureInfo.InvariantCulture) : "\"" + p + "\"")) + "],\"extensions\":{\"code\":\"" + code + "\"}}";

    private static string Nulled(string root, params string[] errors) => "{\"errors\":[" + string.Join(',', errors) + "],\"data\":{\"" + root + "\":null}}";

    private static string Title(int n) => "{\"id\":\"tt" + (1000000 + n) + "\",\"titleText\":{\"text\":\"M" + n + "\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":2001}}";

    private static string Edges(int from, int count, bool item = true) =>
        string.Join(',', Enumerable.Range(from, count).Select(n => "{\"node\":" + (item ? "{\"item\":" + Title(n) + "}" : Title(n)) + "}"));

    private static string Connection(int from, int count, int total, string? next) =>
        "{\"total\":" + total + ",\"edges\":[" + Edges(from, count) + "],\"pageInfo\":{\"hasNextPage\":" + (next != null ? "true" : "false") + ",\"endCursor\":" + (next != null ? "\"" + next + "\"" : "null") + "}}";

    private static string ListPage(int from, int count, int total, string? next, string errors = "") =>
        "{" + errors + "\"data\":{\"list\":{\"id\":\"ls000000302\",\"name\":{\"originalText\":\"L\"},\"items\":" + Connection(from, count, total, next) + "}}}";

    private static string WatchlistPage(string errors = "") => "{" + errors + "\"data\":{\"predefinedList\":{\"items\":" + Connection(1, 3, 3, null) + "}}}";

    private static string ChartPage(string errors = "") =>
        "{" + errors + "\"data\":{\"chartTitles\":{\"total\":3,\"edges\":[" + Edges(1, 3, item: false) + "],\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}}}";

    private static string Profile(string errors = "") => "{" + errors + "\"data\":{\"userProfile\":{\"userId\":\"ur12345678\"}}}";

    // A GraphQL request's query and variables (the IMDb route answers by what was asked).
    private static (string Query, JsonElement Variables) Asked(HttpRequestMessage request)
    {
        using var doc = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
        return (doc.RootElement.GetProperty("query").GetString()!, doc.RootElement.GetProperty("variables").Clone());
    }

    private const string Imdb = "https://api.graphql.imdb.com/";

    // A read of a list source twice (the second may come from the fetcher's cache): the first result and whether the second sent nothing.
    private static async Task<(SourceFetchResult First, bool Kept)> ReadTwice(Net net, string url)
    {
        var first = await net.Fetch(url, Kept);
        var sent = net.Requests.Count;
        await net.Fetch(url, Kept);
        return (first, net.Requests.Count == sent);
    }

    // ── 4C2-R11-1: absence targets the queried root exactly (every GraphQL root × nested paths) ──

    // IMDb's real answer for a missing list (api.graphql.imdb.com, 2026-10-21, ls000000001 with JE's query): errors on the list's
    // own fields (id, name, items), never on ["list"] itself.
    internal const string RealMissingList = "{\"errors\":["
        + "{\"message\":\"RESOURCE_NOT_FOUND exception code while fetching data (/list/name)\",\"path\":[\"list\",\"name\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\",\"errorType\":\"CLIENT\",\"isRetryable\":false,\"path\":[\"list\",\"name\"]}},"
        + "{\"message\":\"RESOURCE_NOT_FOUND exception code while fetching data (/list/id)\",\"path\":[\"list\",\"id\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\",\"errorType\":\"CLIENT\",\"isRetryable\":false,\"path\":[\"list\",\"id\"]}},"
        + "{\"message\":\"RESOURCE_NOT_FOUND exception code while fetching data (/list/items)\",\"path\":[\"list\",\"items\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\",\"errorType\":\"CLIENT\",\"isRetryable\":false,\"path\":[\"list\",\"items\"]}}],"
        + "\"data\":{\"list\":null}}";

    // Each root JE queries: the URL that queries it, a descendant under its connection (a title of it), and a field of its own
    // that isn't its identity.
    private static readonly (string Name, string Url, string Root, object[] Descendant, string OwnField)[] Roots =
    {
        ("list", "https://www.imdb.com/list/ls000000302/", "list", new object[] { "list", "items", "edges", 0, "node", "item" }, "items"),
        ("watchlist", "https://www.imdb.com/user/ur12345678/watchlist", "predefinedList", new object[] { "predefinedList", "items", "edges", 0, "node", "item" }, "items"),
        ("chart", "https://www.imdb.com/chart/top/", "chartTitles", new object[] { "chartTitles", "edges", 0, "node" }, "edges"),
        ("profile", "https://www.imdb.com/user/p.abcdefgh/watchlist", "userProfile", new object[] { "userProfile", "userId", 0 }, "userId"), // the query selects no deeper field: a path below its own
    };

    public static IEnumerable<object[]> AbsenceCells()
    {
        foreach (var (name, _, root, deep, own) in Roots)
        {
            yield return new object[] { name, "NOT_FOUND on a descendant (a title of it), root null", Nulled(root, Error("NOT_FOUND", deep)), "upstream_error" };
            yield return new object[] { name, "FORBIDDEN on a descendant, root null", Nulled(root, Error("FORBIDDEN", deep)), "upstream_error" };
            yield return new object[] { name, "RESOURCE_NOT_FOUND on a field that isn't its identity (null propagated)", Nulled(root, Error("RESOURCE_NOT_FOUND", root, own)), "upstream_error" };
            yield return new object[] { name, "NOT_FOUND on the root AND on a descendant", Nulled(root, Error("NOT_FOUND", root), Error("NOT_FOUND", deep)), "upstream_error" };
            yield return new object[] { name, "NOT_FOUND on the root beside INTERNAL_SERVER_ERROR", Nulled(root, Error("NOT_FOUND", root), Error("INTERNAL_SERVER_ERROR", root)), "upstream_error" };
            yield return new object[] { name, "null propagated to data", "{\"errors\":[" + Error("NOT_FOUND", root) + "],\"data\":null}", "upstream_error" };
            yield return new object[] { name, "an error whose path isn't a list", "{\"errors\":[{\"message\":\"m\",\"path\":\"" + root + "\",\"extensions\":{\"code\":\"NOT_FOUND\"}}],\"data\":{\"" + root + "\":null}}", "upstream_error" };
            yield return new object[] { name, "control: NOT_FOUND on the root", Nulled(root, Error("NOT_FOUND", root)), "not_found" };
        }

        yield return new object[] { "list", "control: IMDb's real answer for a missing list (id, name, items)", RealMissingList, "not_found" };
        yield return new object[] { "list", "control: RESOURCE_NOT_FOUND on the list's id", Nulled("list", Error("RESOURCE_NOT_FOUND", "list", "id")), "not_found" };
        yield return new object[] { "list", "the real answer without its identity error (name, items)", Nulled("list", Error("RESOURCE_NOT_FOUND", "list", "name"), Error("RESOURCE_NOT_FOUND", "list", "items")), "upstream_error" };
        yield return new object[] { "list", "the real answer and a descendant", RealMissingList.Replace("],\"data\"", "," + Error("NOT_FOUND", "list", "items", "edges", 0, "node", "item") + "],\"data\"", StringComparison.Ordinal), "upstream_error" };
    }

    [Theory]
    [MemberData(nameof(AbsenceCells))]
    public async Task AnImdbAbsenceTargetsTheQueriedRootExactly(string root, string variant, string answer, string code)
    {
        using var net = new Net();
        var url = Roots.Single(r => r.Name == root).Url;
        net.Routes[Imdb] = _ => Json(answer);
        var result = await net.Fetch(url);
        output.WriteLine(root + " | " + variant + ": " + result.ErrorCode);
        Assert.False(result.Ok);
        Assert.Equal(code, result.ErrorCode);
    }

    // ── 4C2-R11-2: composite reads carry one verdict ──

    // A composite read: its steps answered as the cell says (one step changed per cell), read twice. Expected: "complete" (and
    // kept), "partial" (answered, never complete, never kept) or a failure code (never kept).
    public static IEnumerable<object[]> CompositeCells() => new[]
    {
        new object[] { "imdb p. watchlist", "profile: errors next to its userId (partial)", "partial" },
        new object[] { "imdb p. watchlist", "profile: errors is an object", "upstream_error" },
        new object[] { "imdb p. watchlist", "profile: errors is null", "upstream_error" },
        new object[] { "imdb p. watchlist", "profile: an error that isn't an object", "upstream_error" },
        new object[] { "imdb p. watchlist", "page: errors next to its data (partial)", "partial" },
        new object[] { "imdb p. watchlist", "page: errors is an object", "upstream_error" },
        new object[] { "imdb p. watchlist", "control", "complete" },
        new object[] { "imdb list (2 pages)", "page 2: errors next to its data (partial)", "partial" },
        new object[] { "imdb list (2 pages)", "page 2: errors is an object", "upstream_error" },
        new object[] { "imdb list (2 pages)", "page 1: errors is an object", "upstream_error" },
        new object[] { "imdb list (2 pages)", "control", "complete" },
        new object[] { "imdb chart", "page: errors is an object", "upstream_error" },
        new object[] { "imdb chart", "page: an error that isn't an object", "upstream_error" },
        new object[] { "imdb chart", "control", "complete" },
        new object[] { "tmdb list (2 pages)", "page 2: without its list id (unbound)", "partial" },
        new object[] { "tmdb list (2 pages)", "control", "complete" },
        new object[] { "trakt list (2 pages + drift probe)", "probe: not a list of rows", "partial" },
        new object[] { "trakt list (2 pages + drift probe)", "control", "complete" },
    };

    [Theory]
    [MemberData(nameof(CompositeCells))]
    public async Task ACompositeReadIsCompleteOnlyWhenEveryStepIsClean(string read, string variant, string expected)
    {
        using var net = new Net();
        string url;
        switch (read)
        {
            case "imdb p. watchlist":
                url = "https://www.imdb.com/user/p.abcdefgh/watchlist";
                net.Routes[Imdb] = request => Asked(request).Query.Contains("userProfile", StringComparison.Ordinal)
                    ? Json(variant switch
                    {
                        "profile: errors next to its userId (partial)" => Profile("\"errors\":[" + Error("INTERNAL_SERVER_ERROR", "userProfile", "watchlist") + "],"),
                        "profile: errors is an object" => Profile("\"errors\":{\"message\":\"m\"},"),
                        "profile: errors is null" => Profile("\"errors\":null,"),
                        "profile: an error that isn't an object" => Profile("\"errors\":[\"boom\"],"),
                        _ => Profile(),
                    })
                    : Json(variant switch
                    {
                        "page: errors next to its data (partial)" => WatchlistPage("\"errors\":[" + Error("NOT_FOUND", "predefinedList", "items", "edges", 3, "node", "item") + "],"),
                        "page: errors is an object" => WatchlistPage("\"errors\":{\"message\":\"m\"},"),
                        _ => WatchlistPage(),
                    });
                break;
            case "imdb list (2 pages)":
                url = "https://www.imdb.com/list/ls000000302/";
                net.Routes[Imdb] = request =>
                {
                    var second = Asked(request).Variables.GetProperty("after").ValueKind == JsonValueKind.String;
                    var errors = (second, variant) switch
                    {
                        (true, "page 2: errors next to its data (partial)") => "\"errors\":[" + Error("NOT_FOUND", "list", "items", "edges", 3, "node", "item") + "],",
                        (true, "page 2: errors is an object") or (false, "page 1: errors is an object") => "\"errors\":{\"message\":\"m\"},",
                        _ => string.Empty,
                    };
                    return Json(second ? ListPage(4, 3, 6, null, errors) : ListPage(1, 3, 6, "c1", errors));
                };
                break;
            case "imdb chart":
                url = "https://www.imdb.com/chart/top/";
                net.Routes[Imdb] = _ => Json(ChartPage(variant switch
                {
                    "page: errors is an object" => "\"errors\":{\"message\":\"m\"},",
                    "page: an error that isn't an object" => "\"errors\":[42],",
                    _ => string.Empty,
                }));
                break;
            case "tmdb list (2 pages)":
                url = "https://www.themoviedb.org/list/7";
                net.RealShapes = false; // the echo is the case under test
                net.Config.TMDB_API_KEY = "tmdb-key";
                net.Routes["https://api.themoviedb.org/3/list/7"] = request =>
                {
                    var page = Page(request);
                    var head = page == 2 && variant != "control" ? "\"page\":2," : "\"id\":7,\"page\":" + page + ",";
                    return Json("{" + head + "\"name\":\"L\",\"total_pages\":2,\"item_count\":4,\"items\":[" + TmdbRows(page == 1 ? 1 : 3, 2) + "]}");
                };
                break;
            default:
                url = "https://trakt.tv/users/me/lists/mine";
                net.Config.ArrListTraktApiKey = "trakt-client";
                net.Routes["https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode"] = request =>
                {
                    if (Query(request, "limit") == "1")
                    {
                        return Json(variant == "control" ? "[" + TraktRow(Page(request)) + "]" : "{\"message\":\"m\"}");
                    }

                    var page = Page(request);
                    var response = Json("[" + string.Join(',', Enumerable.Range(page == 1 ? 1 : 3, 2).Select(TraktRow)) + "]");
                    response.Headers.Add("X-Pagination-Page-Count", "2");
                    response.Headers.Add("X-Pagination-Item-Count", "4");
                    return response;
                };
                break;
        }

        var (first, kept) = await ReadTwice(net, url);
        output.WriteLine(read + " | " + variant + ": ok " + first.Ok + " " + first.ErrorCode + ", partial " + first.Partial + ", complete " + IsComplete(first) + ", kept " + kept);
        switch (expected)
        {
            case "complete":
                Assert.True(IsComplete(first) && kept, "a read whose every step was clean wasn't complete and kept");
                break;
            case "partial":
                Assert.True(first.Ok, "a partial step failed the whole read: " + first.ErrorCode);
                Assert.False(IsComplete(first), "a read with a partial step was complete");
                Assert.False(kept, "a read with a partial step was kept");
                break;
            default:
                Assert.False(first.Ok, "a malformed step was read as data");
                Assert.Equal(expected, first.ErrorCode);
                Assert.False(kept);
                break;
        }
    }

    private static string TmdbRows(int from, int count) =>
        string.Join(',', Enumerable.Range(from, count).Select(n => "{\"id\":" + n + ",\"media_type\":\"movie\",\"title\":\"M" + n + "\",\"release_date\":\"2001-01-01\"}"));

    private static string TraktRow(int id) => "{\"id\":" + id + ",\"type\":\"movie\",\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}";

    // ── 4C2-R11-3: every HTTP read is bounded ──

    private const long Over = 9L * 1024 * 1024; // the finding's 9 MiB
    private const long Cap = 8L * 1024 * 1024;
    private const long Slack = 256 * 1024; // the reader's last chunk and the transport's own buffers

    /// <summary>A valid JSON answer padded with whitespace to a size, served lazily, counting the bytes read from it.</summary>
    internal sealed class Padded(string json, long size) : Stream
    {
        private readonly byte[] _json = Encoding.UTF8.GetBytes(json);
        private long _position;

        public long Served => Interlocked.Read(ref _position);

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => _position; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = 0;
            while (n < count && _position < size)
            {
                var p = _position;
                buffer[offset + n] = p < _json.Length - 1 ? _json[p] : p == size - 1 ? _json[^1] : (byte)' ';
                n++;
                Interlocked.Increment(ref _position);
            }

            return n;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public HttpResponseMessage Response(int status, bool announced)
        {
            var content = new StreamContent(this);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            if (announced)
            {
                content.Headers.ContentLength = size;
            }

            return new HttpResponseMessage((System.Net.HttpStatusCode)status) { Content = content };
        }
    }

    // Every read site of the list and metadata code, through its production entry point, with a 9 MiB answer (a valid answer
    // padded with whitespace: read whole it would be used), announced (Content-Length) or not.
    public static IEnumerable<object[]> BoundedCells() =>
        from site in new[]
        {
            "tmdb poster (success)", "tmdb season poster (TMDB's 404 body)", "seerr metadata (success)", "seerr lookup (success)",
            "seerr lookup (error body)", "tmdb lookup (success)", "tmdb lookup (404 body)", "mdblist ratings (success)",
            "mdblist batch (success)", "mdblist account status (success)", "list source gate (TMDB's 404 body)", "seerr list fallback (success)",
        }
        from announced in new[] { false, true }
        select new object[] { site, announced };

    [Theory]
    [MemberData(nameof(BoundedCells))]
    public async Task EveryHttpReadOfTheListAndMetadataCodeIsBounded(string site, bool announced)
    {
        string outcome;
        Padded body;
        if (site.StartsWith("mdblist", StringComparison.Ordinal))
        {
            using var net = MdblistApiNet(() => 900);
            const string Record = "{\"title\":\"T\",\"year\":2010,\"type\":\"movie\",\"score\":86,\"ids\":{\"imdb\":\"tt0000042\",\"tmdb\":42,\"trakt\":5,\"mal\":null},\"ratings\":[{\"source\":\"imdb\",\"value\":8.1,\"score\":81,\"votes\":673852,\"url\":5}]}";
            switch (site)
            {
                case "mdblist ratings (success)":
                    body = new Padded(Record, Over);
                    net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => body.Response(200, announced);
                    var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
                    outcome = "found " + entry.Found + ", confirmed " + entry.Confirmed;
                    Assert.False(entry.Found, "a 9 MiB ratings answer was used");
                    Assert.False(entry.Confirmed);
                    break;
                case "mdblist batch (success)":
                    body = new Padded("[" + Record + "]", Over);
                    net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => body.Response(200, announced);
                    var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None);
                    outcome = "batch " + (batch == null ? "failed" : batch.Count + " rows");
                    Assert.Null(batch); // a failed batch (retried next run), never its rows
                    break;
                default:
                    body = new Padded(Status(900), Over);
                    net.Routes["https://api.mdblist.com/user"] = _ => body.Response(200, announced);
                    net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(Record);
                    var looked = await net.Quota.GetRatingsAsync("movie", "42", None); // the status read fails open: the lookup still runs
                    outcome = "ratings found " + looked.Found;
                    break;
            }
        }
        else if (site.StartsWith("list source", StringComparison.Ordinal) || site.StartsWith("seerr list", StringComparison.Ordinal))
        {
            using var net = new Net();
            net.Config.TMDB_API_KEY = site.StartsWith("seerr", StringComparison.Ordinal) ? string.Empty : "tmdb-key";
            if (site.StartsWith("seerr", StringComparison.Ordinal))
            {
                net.Config.JellyseerrEnabled = true;
                net.Config.JellyseerrUrls = "http://seerr-a.test";
                net.Config.JellyseerrApiKey = "seerr-key";
                body = new Padded("{\"id\":10,\"name\":\"C\",\"parts\":[{\"id\":1,\"mediaType\":\"movie\",\"title\":\"M1\",\"releaseDate\":\"2001-01-01\"}]}", Over);
                net.Routes["http://seerr-a.test/api/v1/collection/10"] = _ => body.Response(200, announced);
            }
            else
            {
                body = new Padded("{\"success\":false,\"status_code\":34,\"status_message\":\"The resource you requested could not be found.\"}", Over);
                net.Routes["https://api.themoviedb.org/3/collection/10"] = _ => body.Response(404, announced);
            }

            var result = await net.Fetch("https://www.themoviedb.org/collection/10");
            outcome = "ok " + result.Ok + " " + result.ErrorCode;
            Assert.False(result.Ok, "a 9 MiB answer was read as the list");
            Assert.NotEqual("not_found", result.ErrorCode); // an absence needs the body it couldn't read
        }
        else
        {
            using var w = new World();
            switch (site)
            {
                case "tmdb poster (success)":
                    body = new Padded("{\"id\":10,\"poster_path\":\"/p.jpg\"}", Over);
                    w.Routes[R7.Tmdb + "movie/10"] = _ => body.Response(200, announced);
                    var poster = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).ReadTmdbPosterAsync(R7.Prefilled(PlaceholderKinds.Movie), None);
                    outcome = "answered " + poster.Answered + ", poster " + poster.Poster;
                    Assert.False(poster.Answered, "a 9 MiB poster answer was used");
                    Assert.Null(poster.Poster);
                    break;
                case "tmdb season poster (TMDB's 404 body)":
                    body = new Padded("{\"success\":false,\"status_code\":34,\"status_message\":\"The resource you requested could not be found.\"}", Over);
                    w.Routes[R7.Tmdb + "tv/1412/season/1"] = _ => body.Response(404, announced);
                    w.Answer(R7.Tmdb + "tv/1412", "{\"id\":1412,\"poster_path\":\"/show.jpg\"}");
                    var season = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).ReadTmdbPosterAsync(R7.Prefilled(PlaceholderKinds.Season), None);
                    outcome = "answered " + season.Answered + ", poster " + season.Poster;
                    Assert.False(season.Answered, "an unread 404 let the show's poster stand in");
                    break;
                case "seerr metadata (success)":
                    body = new Padded("{\"id\":10,\"mediaType\":\"movie\",\"title\":\"Inception\",\"releaseDate\":\"2010-07-15\",\"posterPath\":\"/p.jpg\"}", Over);
                    w.Routes[R7.SeerrA + "movie/10"] = _ => body.Response(200, announced);
                    w.Answer(R7.SeerrB + "movie/10", "{}", 503);
                    var metadata = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).FetchAsync(R7.Prefilled(PlaceholderKinds.Movie), TimeSpan.FromHours(12), Today, None);
                    outcome = "metadata " + (metadata == null ? "none" : metadata.ReleaseDate);
                    Assert.Null(metadata);
                    break;
                case "seerr lookup (success)":
                case "seerr lookup (error body)":
                    var success = site.EndsWith("(success)", StringComparison.Ordinal);
                    body = new Padded(success ? "{\"id\":49521,\"title\":\"Man of Steel\",\"releaseDate\":\"2013-06-12\"}" : "{\"message\":\"Unable to retrieve movie.\"}", Over);
                    w.Routes[R7.SeerrA + "movie/49521"] = _ => body.Response(success ? 200 : 500, announced);
                    w.Answer(R7.SeerrB + "movie/49521", "{}", 503);
                    var details = await w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None);
                    outcome = details.Status.ToString();
                    Assert.Equal(LookupStatus.Transient, details.Status);
                    break;
                default:
                    var found = site.EndsWith("(success)", StringComparison.Ordinal);
                    body = new Padded(found ? "{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\"}" : "{\"success\":false,\"status_code\":34,\"status_message\":\"The resource you requested could not be found.\"}", Over);
                    w.Routes[R7.Tmdb + "movie/49521"] = _ => body.Response(found ? 200 : 404, announced);
                    var tmdb = await w.TmdbLookup.GetDetailsAsync("movie", 49521, w.Context, None);
                    outcome = tmdb.Status.ToString();
                    Assert.Equal(LookupStatus.Transient, tmdb.Status); // never the title, never "no such id"
                    break;
            }
        }

        output.WriteLine(site + (announced ? " (announced)" : " (unannounced)") + ": " + outcome + "; read " + body.Served.ToString(CultureInfo.InvariantCulture) + " of " + Over.ToString(CultureInfo.InvariantCulture) + " bytes");
        Assert.True(body.Served <= Cap + Slack, site + ": read " + body.Served.ToString(CultureInfo.InvariantCulture) + " bytes of a 9 MiB answer");
    }

    // The finding's own case (4C2-R11-3): a valid poster answer followed by 9 MiB of whitespace, through the maintenance pass's
    // reader: refused, the entry's poster untouched.
    [Fact]
    public async Task ANineMebibytePosterIsRefused()
    {
        using var w = new World();
        var body = new Padded("{\"id\":10,\"poster_path\":\"/nine.jpg\"}", Over);
        w.Routes[R7.Tmdb + "movie/10"] = _ => body.Response(200, announced: false);
        var read = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).ReadTmdbPosterAsync(R7.Prefilled(PlaceholderKinds.Movie), None);
        Assert.NotEqual("/nine.jpg", read.Poster);
        Assert.False(read.Answered);
    }

    private static string Root([System.Runtime.CompilerServices.CallerFilePath] string caller = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(caller)!, "..", "..", "..", "..", "Jellyfin.Plugin.JellyfinEnhanced"));

    // A source scan: the body of an HTTP answer is read nowhere in the list and metadata code but by the one bounded reader
    // (BoundedBody), every send leaves the body unread (headers first) and the shared Seerr helper's own reader isn't used.
    // The behaviour is proven above through the production entry points; this guards the structure against a new site.
    [Fact]
    public void NoHttpBodyIsReadOutsideTheBoundedReader()
    {
        var root = Root();
        var files = Directory.EnumerateFiles(Path.Combine(root, "Services", "Acquire", "Lists"), "*.cs", SearchOption.AllDirectories)
            .Append(Path.Combine(root, "Services", "MdblistService.cs"))
            .Append(Path.Combine(root, "Services", "TmdbResponseCache.cs"))
            .Where(f => Path.GetFileName(f) != "BoundedBody.cs")
            .ToList();
        Assert.True(files.Count > 30, "the scan found the list and metadata code");
        var forbidden = new Regex(@"\b(ReadAsStringAsync|ReadAsByteArrayAsync|ReadAsStreamAsync|ReadFromJsonAsync|GetFromJsonAsync|GetStringAsync|GetByteArrayAsync|GetStreamAsync|LoadIntoBufferAsync|ReadResponseAsync|MaxResponseContentBufferSize|ResponseContentRead)\b"
            + @"|\b\w*[cC]lient\s*\.\s*(GetAsync|PostAsync|PutAsync|PatchAsync|DeleteAsync|SendAsync)\s*\(");
        var found = new List<string>();
        foreach (var file in files)
        {
            var code = ListsSourceTransmissionScanTests.Code(File.ReadAllText(file));
            found.AddRange(forbidden.Matches(code).Select(m => Path.GetFileName(file) + ": " + m.Value));
            if (code.Contains("CreateClient(", StringComparison.Ordinal) && !code.Contains("BoundedBody.SendAsync(", StringComparison.Ordinal))
            {
                found.Add(Path.GetFileName(file) + ": makes a client but never sends through BoundedBody.SendAsync");
            }
        }

        foreach (var site in found)
        {
            output.WriteLine(site);
        }

        Assert.Empty(found);
    }
}
