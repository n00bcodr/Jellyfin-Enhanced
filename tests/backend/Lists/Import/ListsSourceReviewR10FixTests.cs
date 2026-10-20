using System.Globalization;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Xunit.Abstractions;
using static JE.Tests.ListsImportReviewR2FixTests;
using static JE.Tests.ListsSourceReviewR3FixTests;
using R7 = JE.Tests.ListsSourceReviewR7FixTests;
using R9 = JE.Tests.ListsSourceReviewR9FixTests;
using World = JE.Tests.ListsSourceReviewR6FixTests.World;

namespace JE.Tests;

// Track 4c2a review round 10 (D53, 10th round: r9's "contracts take the request" held where each contract DECLARED the check;
// every r10 finding is a contract × request-fact pair nobody declared, an absence derived from "no data", or provider text in
// a diagnostic).
// 1. Derived request bindings: every answer is bound to the request's facts (the list, universe, explicit search id, media
//    type, poster identity, page and its occupancy); another request's answer is never used, kept or clearing, and an answer
//    without its echo is unbound: never definitive (4c2-R10-1…5). ContractBindingsTests enumerates the (contract × fact) table.
// 2. Absence is a positive fact: "not found" only from a provider's documented affirmative signal (4c2-R10-7 and the audit).
// 3. Diagnostics are codes: no provider value or member name reaches the log (4c2-R10-6; the real logger's file).
// 4. The generated model: every (contract × fact) mismatch and unbound variant, every absence producer's non-affirmative
//    inputs, and a sentinel sweep of every reader, through the production readers.
[Collection("Plugin singleton")]
public class ListsSourceReviewR10FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly DateTime Today = new(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly SourceFetchOptions Kept = new() { Fresh = false };

    private static string MovieRow(int id) => "{\"id\":" + id + ",\"media_type\":\"movie\",\"mediaType\":\"movie\",\"title\":\"M" + id + "\",\"release_date\":\"2001-01-01\"}";

    private static string MovieRows => string.Join(',', new[] { 1, 2, 3 }.Select(MovieRow));

    private static string ImdbEdge(int n) => "{\"node\":{\"item\":{\"id\":\"tt" + (1000000 + n) + "\",\"titleText\":{\"text\":\"M" + n + "\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":2001}}}}";

    private static string ImdbList(string head) => "{\"data\":{\"list\":{" + head + "\"name\":{\"originalText\":\"L\"},\"items\":{\"total\":3,\"edges\":["
        + string.Join(',', new[] { 1, 2, 3 }.Select(ImdbEdge)) + "],\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}}}}";

    // A read of a list source twice (the second may come from the fetcher's cache): the first result and whether the second sent nothing.
    private static async Task<(SourceFetchResult First, bool Kept)> ReadTwice(Net net, string url)
    {
        var first = await net.Fetch(url, Kept);
        var sent = net.Requests.Count;
        await net.Fetch(url, Kept);
        return (first, net.Requests.Count == sent);
    }

    // ── 4C2-R10-1: list pages are bound to the list (TMDB list id, IMDb list id) and the universe (Chronolists) ──

    [Theory]
    [InlineData("another list", "\"id\":999,\"page\":1,")]
    [InlineData("no list id", "\"page\":1,")]
    [InlineData("control", "\"id\":7,\"page\":1,")]
    public async Task ATmdbListPageOfAnotherListOrWithoutItsIdIsNeverCompleteOrKept(string variant, string head)
    {
        using var net = new Net { RealShapes = false }; // the echo is the case under test
        net.Config.TMDB_API_KEY = "tmdb-key";
        net.Routes["https://api.themoviedb.org/3/list/7"] = _ => Json("{" + head + "\"name\":\"L\",\"total_pages\":1,\"item_count\":3,\"items\":[" + MovieRows + "]}");
        var (first, kept) = await ReadTwice(net, "https://www.themoviedb.org/list/7");
        output.WriteLine(variant + ": ok " + first.Ok + " " + first.ErrorCode + ", complete " + IsComplete(first) + ", kept " + kept);
        if (variant == "control")
        {
            Assert.True(IsComplete(first) && kept);
            return;
        }

        Assert.False(IsComplete(first), "another list's page (or one that names none) was taken as the list asked for");
        Assert.False(kept);
        if (variant == "another list")
        {
            Assert.Equal("upstream_error", first.ErrorCode);
        }
    }

    [Theory]
    [InlineData("dctv", "chronolists-mcu-2026-10.html", "another universe")]
    [InlineData("mcu", "chronolists-dctv-2026-10.html", "another universe")]
    [InlineData("mcu", "chronolists-mcu-2026-10.html", "no universe id")]
    [InlineData("mcu", "chronolists-mcu-2026-10.html", "next's query names another")]
    [InlineData("mcu", "chronolists-mcu-2026-10.html", "control")]
    [InlineData("dctv", "chronolists-dctv-2026-10.html", "control")]
    public async Task AChronolistsPageOfAnotherUniverseIsNeverCompleteOrKept(string slug, string fixture, string variant)
    {
        using var net = new Net { RealShapes = false }; // the echo is the case under test
        var page = ImportFixtures.Read(fixture);
        page = variant switch
        {
            "no universe id" => Once(page, "\"universe\":{\"id\":\"mcu\",", "\"universe\":{"),
            "next's query names another" => Once(page, "\"query\":{\"universe\":\"mcu\"}", "\"query\":{\"universe\":\"dctv\"}"),
            _ => page,
        };
        net.Routes["https://chronolists.com/" + slug] = _ => IntegrationTransport.Response(page, 200, "text/html");
        var (first, kept) = await ReadTwice(net, "https://chronolists.com/" + slug);
        output.WriteLine(slug + " ← " + fixture + " (" + variant + "): ok " + first.Ok + " " + first.ErrorCode + ", " + first.Items.Count + " entries, complete " + IsComplete(first) + ", kept " + kept);
        if (variant == "control")
        {
            Assert.True(IsComplete(first) && kept);
            return;
        }

        Assert.False(IsComplete(first), "another universe's watch order was taken as /" + slug);
        Assert.False(kept);
        if (variant != "no universe id")
        {
            Assert.Equal("upstream_error", first.ErrorCode);
        }
    }

    [Theory]
    [InlineData("another list", "\"id\":\"ls999999999\",")]
    [InlineData("no list id", "")]
    [InlineData("control", "\"id\":\"ls000000302\",")]
    public async Task AnImdbListPageOfAnotherListIsNeverCompleteOrKept(string variant, string head)
    {
        using var net = new Net { RealShapes = false }; // the echo is the case under test
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(ImdbList(head));
        var (first, kept) = await ReadTwice(net, "https://www.imdb.com/list/ls000000302/");
        output.WriteLine(variant + ": ok " + first.Ok + " " + first.ErrorCode + ", complete " + IsComplete(first) + ", kept " + kept);
        Assert.Equal(variant == "control", IsComplete(first) && kept);
        if (variant == "another list")
        {
            Assert.Equal("upstream_error", first.ErrorCode);
        }
    }

    // ── 4C2-R10-2: an explicit-id Seerr search is bound to its id ──

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnExplicitIdSeerrSearchAnsweredWithAnotherIdAsksTheNextServerAndIsNeverKept(bool bHasIt)
    {
        using var w = new World();
        w.Answer(R7.SeerrA + "search", "{\"page\":1,\"totalPages\":1,\"totalResults\":1,\"results\":[{\"id\":999,\"mediaType\":\"movie\",\"title\":\"Other\"}]}");
        if (bHasIt)
        {
            // Seerr's real tmdb:N answer: the movie and the person of that id (seen live on Seerr 3.3.0).
            w.Answer(R7.SeerrB + "search", "{\"page\":1,\"totalPages\":1,\"totalResults\":2,\"results\":[{\"id\":49521,\"mediaType\":\"movie\",\"title\":\"Man of Steel\"},{\"id\":49521,\"mediaType\":\"person\",\"name\":\"P\"}]}");
        }
        else
        {
            w.Answer(R7.SeerrB + "search", "{\"message\":\"down\"}", 503);
        }

        var first = await w.SeerrLookup.SearchAsync("tmdb:49521", w.Context, None);
        var calls = w.Total;
        await w.SeerrLookup.SearchAsync("tmdb:49521", w.Context, None);
        output.WriteLine("B " + (bHasIt ? "has it" : "down") + ": " + first.Status + " " + string.Join(',', (first.Value ?? Array.Empty<TitleHit>()).Select(h => h.TmdbId)) + ", calls " + calls + " → " + w.Total);
        Assert.Contains(w.Calls, c => c.At == "seerr-b.test/api/v1/search");
        Assert.DoesNotContain(first.Value ?? Array.Empty<TitleHit>(), h => h.TmdbId == 999);
        if (bHasIt)
        {
            Assert.Equal(LookupStatus.Ok, first.Status);
            Assert.Contains(first.Value!, h => h.TmdbId == 49521);
        }
        else
        {
            Assert.Equal(LookupStatus.Transient, first.Status);
            Assert.True(w.Total > calls, "another id's answer was kept");
        }
    }

    // ── 4C2-R10-3: placeholder metadata is bound to the media type asked for ──

    [Theory]
    [InlineData("mediaType", "\"tv\"", true)]
    [InlineData("mediaType", "\"tv\"", false)]
    [InlineData("mediaInfo", "{\"mediaType\":\"tv\"}", false)]
    public async Task MetadataOfAnotherMediaTypeNeverClearsAndTheNextServerIsAsked(string field, string value, bool bHasIt)
    {
        using var w = new World();
        w.Answer(R7.SeerrA + "movie/10", R9.Set(R9.Set(R9.Set(R7.MetaMovieBody, field, value), "releaseDate", "null"), "posterPath", "null"));
        if (bHasIt)
        {
            w.Answer(R7.SeerrB + "movie/10", R9.Set(R7.MetaMovieBody, "releaseDate", "\"2011-02-02\""));
        }
        else
        {
            w.Answer(R7.SeerrB + "movie/10", "{\"message\":\"down\"}", 503);
        }

        var service = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        var entry = R7.Prefilled(PlaceholderKinds.Movie);
        var metadata = await service.FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
        if (metadata != null)
        {
            ListMetadataService.Apply(entry, metadata);
        }

        var calls = w.Total;
        await service.FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
        output.WriteLine(field + "=" + value + ", B " + (bHasIt ? "has it" : "down") + ": date " + entry.ReleaseDate + ", poster " + entry.PosterPath + ", calls " + calls + " → " + w.Total);
        Assert.Equal(bHasIt ? "2011-02-02" : "2001-01-01", entry.ReleaseDate);
        Assert.NotNull(entry.PosterPath);
        Assert.Contains(w.Calls, c => c.At == "seerr-b.test/api/v1/movie/10");
        Assert.Equal(!bHasIt, w.Total > calls);
    }

    [Fact]
    public async Task JeModeMetadataOfAnotherMediaTypeIsUnknown()
    {
        using var w = new World();
        ImportTestFlags.AllOn(w.Plugin.Plugin.Configuration);
        w.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
        w.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        w.Answer(R7.Tmdb + "movie/10", "{\"id\":10,\"media_type\":\"tv\",\"title\":\"Other\",\"release_date\":null,\"poster_path\":null,\"imdb_id\":null,\"external_ids\":{\"imdb_id\":null}}");
        var je = await new TmdbListMetadataSource(w.Cache, w.Plugin.Core.Logger).FetchAsync(R7.Prefilled(PlaceholderKinds.Movie), TimeSpan.FromHours(12), Today, None);
        Assert.Null(je);
    }

    // ── 4C2-R10-4: a poster answer is bound to the title or season (and its show) asked for ──

    [Theory]
    [InlineData("movie", "no id", "{\"poster_path\":null}", false)]
    [InlineData("movie", "control", "{\"id\":10,\"poster_path\":null}", true)]
    [InlineData("season", "no season number", "{\"poster_path\":null,\"episodes\":[{\"episode_number\":1,\"show_id\":1412}]}", false)]
    [InlineData("season", "another show's season", "{\"season_number\":1,\"poster_path\":null,\"episodes\":[{\"episode_number\":1,\"show_id\":999}]}", false)]
    [InlineData("season", "episodes without their show", "{\"season_number\":1,\"poster_path\":null,\"episodes\":[{\"episode_number\":1}]}", false)]
    [InlineData("season", "control", "{\"id\":3572,\"season_number\":1,\"poster_path\":\"/s1.jpg\",\"episodes\":[{\"episode_number\":1,\"season_number\":1,\"show_id\":1412}]}", true)]
    public async Task APosterAnswerWithoutTheIdentityAskedForIsNeverAnAnswer(string kind, string variant, string body, bool answered)
    {
        using var w = new World();
        var movie = kind == "movie";
        w.Answer(R7.Tmdb + (movie ? "movie/10" : "tv/1412/season/1"), body);
        w.Answer(R7.Tmdb + "tv/1412", "{\"id\":1412,\"poster_path\":\"/show.jpg\"}");
        var entry = R7.Prefilled(movie ? PlaceholderKinds.Movie : PlaceholderKinds.Season);
        var read = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).ReadTmdbPosterAsync(entry, None);
        output.WriteLine(kind + " " + variant + ": answered " + read.Answered + ", poster " + read.Poster);
        Assert.Equal(answered, read.Answered);
        if (!answered)
        {
            Assert.Null(read.Poster); // never "no poster", and the show's poster never stands in for an unbound season
        }
        else if (!movie)
        {
            Assert.Equal("/s1.jpg", read.Poster);
        }
    }

    // ── 4C2-R10-5: an empty page is "no titles" only when its total says so ──

    [Theory]
    [InlineData("tmdb", "{\"page\":1,\"total_pages\":1,\"total_results\":20,\"results\":[]}", false)]
    [InlineData("tmdb", "{\"page\":1,\"results\":[]}", false)]
    [InlineData("tmdb", "{\"page\":1,\"total_pages\":1,\"total_results\":0,\"results\":[]}", true)]
    [InlineData("seerr", "{\"page\":1,\"totalPages\":1,\"totalResults\":20,\"results\":[]}", false)]
    [InlineData("seerr", "{\"page\":1,\"results\":[]}", false)]
    [InlineData("seerr", "{\"page\":1,\"totalPages\":1,\"totalResults\":0,\"results\":[]}", true)]
    public async Task AnEmptySearchPageIsNoTitlesOnlyWhenItsTotalSaysSo(string lookup, string body, bool absent)
    {
        using var w = new World();
        if (lookup == "tmdb")
        {
            w.Answer(R7.Tmdb + "search/multi", body);
        }
        else
        {
            w.Answer(R7.SeerrA + "search", body);
            w.Answer(R7.SeerrB + "search", "{\"message\":\"down\"}", 503);
        }

        var first = await w.Lookup(lookup).SearchAsync("Arrival", w.Context, None);
        var calls = w.Total;
        await w.Lookup(lookup).SearchAsync("Arrival", w.Context, None);
        output.WriteLine(lookup + " " + body + ": " + first.Status + " " + first.Verdict + ", calls " + calls + " → " + w.Total);
        if (absent)
        {
            Assert.Equal(LookupStatus.Ok, first.Status);
            Assert.Empty(first.Value!);
            return;
        }

        Assert.Equal(LookupStatus.Transient, first.Status);
        Assert.True(w.Total > calls, "an empty page whose total says otherwise was kept as \"no titles\"");
    }

    // ── 4C2-R10-6: no provider value or member name reaches the log (the real logger's file) ──

    private const string Sentinel = "JEr10Sentinel";

    private const string Record42 = "{\"title\":\"T\",\"year\":2010,\"type\":\"movie\",\"score\":86,\"ids\":{\"imdb\":\"tt0000042\",\"tmdb\":42,\"trakt\":5,\"mal\":null},"
        + "\"ratings\":[{\"source\":\"imdb\",\"value\":8.1,\"score\":81,\"votes\":673852,\"url\":5}]}";

    public static IEnumerable<object[]> MdblistLogCells() =>
        from path in new[] { "single", "batch" }
        from planted in new[] { "rating source", "ids member", "type" }
        select new object[] { path, planted };

    [Theory]
    [MemberData(nameof(MdblistLogCells))]
    public async Task AnMdblistRecordsDiagnosticNamesNoProviderText(string path, string planted)
    {
        using var net = MdblistApiNet(() => 900);
        var record = planted switch
        {
            "rating source" => R9.Set(R9.Set(Record42, "ratings[0]", "{\"source\":\"" + Sentinel + "src\",\"value\":999,\"score\":81}"), "title", "\"" + Sentinel + "title\""),
            "ids member" => R9.Set(Record42, "ids." + Sentinel + "member", "{\"x\":1}"),
            _ => R9.Set(Record42, "type", "\"" + Sentinel + "type\""),
        };
        net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(record);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[" + record + "]");
        if (path == "single")
        {
            var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
            Assert.False(entry.Confirmed);
        }
        else
        {
            await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None);
        }

        var log = ReadLog(net.Plugin.Core.Logger);
        output.WriteLine(string.Join('\n', log.Split('\n').Where(l => l.Contains("MDBList", StringComparison.Ordinal))));
        Assert.Contains("[MDBList]", log, StringComparison.Ordinal); // the failure was logged…
        Assert.DoesNotContain(Sentinel, log, StringComparison.Ordinal); // …by fixed codes and declared paths only
    }

    internal static string ReadLog(Jellyfin.Plugin.JellyfinEnhanced.Logger logger) =>
        File.Exists(logger.CurrentLogFilePath) ? File.ReadAllText(logger.CurrentLogFilePath) : string.Empty;

    // ── 4C2-R10-7 (and the IMDb absence audit): "not found" only from IMDb's affirmative error on the queried root ──

    private const string ListMissing = "{\"errors\":[{\"message\":\"RESOURCE_NOT_FOUND exception code while fetching data (/list/name)\",\"path\":[\"list\",\"name\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\"}},"
        + "{\"message\":\"RESOURCE_NOT_FOUND\",\"path\":[\"list\",\"id\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\"}}],\"data\":{\"list\":null}}";

    public static IEnumerable<object[]> ImdbAbsenceCells() => new[]
    {
        new object[] { "list", "INTERNAL_SERVER_ERROR, list null", "{\"errors\":[{\"message\":\"boom\",\"path\":[\"list\"],\"extensions\":{\"code\":\"INTERNAL_SERVER_ERROR\"}}],\"data\":{\"list\":null}}", "upstream_error" },
        new object[] { "list", "data {}", "{\"data\":{}}", "upstream_error" },
        new object[] { "list", "data null", "{\"data\":null}", "upstream_error" },
        new object[] { "list", "SERVICE_UNAVAILABLE_ERROR, list null", "{\"errors\":[{\"message\":\"x\",\"path\":[\"list\"],\"extensions\":{\"code\":\"SERVICE_UNAVAILABLE_ERROR\"}}],\"data\":{\"list\":null}}", "upstream_error" },
        new object[] { "list", "not found on another path, list null", "{\"errors\":[{\"message\":\"x\",\"path\":[\"title\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\"}}],\"data\":{\"list\":null}}", "upstream_error" },
        // Review round 11 (4c2-R11-1): every error must be the affirmative absence on the root; an internal error beside it is an error answer.
        new object[] { "list", "INTERNAL_SERVER_ERROR first, then not found", "{\"errors\":[{\"message\":\"x\",\"path\":[\"list\",\"items\"],\"extensions\":{\"code\":\"INTERNAL_SERVER_ERROR\"}},{\"message\":\"y\",\"path\":[\"list\"],\"extensions\":{\"code\":\"RESOURCE_NOT_FOUND\"}}],\"data\":{\"list\":null}}", "upstream_error" },
        new object[] { "list", "control: the list doesn't exist (IMDb's real answer)", ListMissing, "not_found" },
        new object[] { "list", "control: forbidden", "{\"errors\":[{\"message\":\"x\",\"path\":[\"list\"],\"extensions\":{\"code\":\"FORBIDDEN\"}}],\"data\":{\"list\":null}}", "not_found" },
        new object[] { "watchlist", "control: a private watchlist (IMDb's real answer)", "{\"errors\":[{\"message\":\"FORBIDDEN\",\"path\":[\"predefinedList\"],\"extensions\":{\"code\":\"FORBIDDEN\"}}],\"data\":{\"predefinedList\":null}}", "not_found" },
        new object[] { "watchlist", "SERVICE_UNAVAILABLE_ERROR (IMDb's real answer for an unknown user)", "{\"errors\":[{\"message\":\"x\",\"path\":[\"predefinedList\"],\"extensions\":{\"code\":\"SERVICE_UNAVAILABLE_ERROR\"}}],\"data\":{\"predefinedList\":null}}", "upstream_error" },
        new object[] { "profile", "INTERNAL_SERVER_ERROR (IMDb's real answer for a missing profile)", "{\"errors\":[{\"message\":\"x\",\"path\":[\"userProfile\"],\"extensions\":{\"code\":\"INTERNAL_SERVER_ERROR\"}}],\"data\":{\"userProfile\":null}}", "upstream_error" },
        new object[] { "profile", "control: not found", "{\"errors\":[{\"message\":\"x\",\"path\":[\"userProfile\"],\"extensions\":{\"code\":\"NOT_FOUND\"}}],\"data\":{\"userProfile\":null}}", "not_found" },
    };

    [Theory]
    [MemberData(nameof(ImdbAbsenceCells))]
    public async Task AnImdbListIsMissingOnlyWhenImdbSaysSoOnTheQueriedRoot(string shape, string variant, string answer, string code)
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(answer);
        var url = shape switch
        {
            "list" => "https://www.imdb.com/list/ls000000302/",
            "watchlist" => "https://www.imdb.com/user/ur12345678/watchlist",
            _ => "https://www.imdb.com/user/p.abcdefgh/watchlist",
        };
        var result = await net.Fetch(url);
        output.WriteLine(shape + " | " + variant + ": " + result.ErrorCode);
        Assert.False(result.Ok);
        Assert.Equal(code, result.ErrorCode);
    }

    // ── Rule 4a. The binding model: every (contract × fact) mismatch and unbound variant, through the production readers ──

    // Lookups and metadata (R7's kinds: the production entry point of each answer kind). Variant "mismatch" (another request's
    // value: never used, kept or clearing; for a page, P: used, never kept), "unbound" (the echo removed: P, never kept or
    // clearing), "occupancy" (an empty page whose total says otherwise: never "no titles").
    internal static readonly (string Kind, string Contract, string Fact, string Variant, string Path, string Json)[] KindCells =
    {
        ("tmdb details movie", "tmdb movie details", "Id", "mismatch", "id", "999"),
        ("tmdb details movie", "tmdb movie details", "Id", "unbound", "id", "<missing>"),
        ("tmdb details tv", "tmdb tv details", "Id", "unbound", "id", "<missing>"),
        ("seerr details movie", "seerr movie details", "Id", "unbound", "id", "<missing>"),
        ("seerr details tv", "seerr tv details", "Id", "unbound", "id", "<missing>"),
        ("seerr metadata movie", "metadata movie", "Id", "unbound", "id", "<missing>"),
        ("seerr metadata series", "metadata show", "Id", "unbound", "id", "<missing>"),
        ("tmdb details movie", "tmdb movie details", "MediaType", "mismatch", "media_type", "\"tv\""),
        ("tmdb details tv", "tmdb tv details", "Id", "mismatch", "id", "999"),
        ("tmdb details tv", "tmdb tv details", "MediaType", "mismatch", "media_type", "\"movie\""),
        ("seerr details movie", "seerr movie details", "Id", "mismatch", "id", "999"),
        ("seerr details movie", "seerr movie details", "MediaType", "mismatch", "mediaType", "\"tv\""),
        ("seerr details tv", "seerr tv details", "Id", "mismatch", "id", "999"),
        ("seerr details tv", "seerr tv details", "MediaType", "mismatch", "mediaType", "\"movie\""),
        ("tmdb season", "tmdb season", "Season", "mismatch", "season_number", "2"),
        ("tmdb season", "tmdb season", "Season", "unbound", "season_number", "<missing>"),
        ("tmdb season", "tmdb season", "Season", "row mismatch", "episodes[0].season_number", "2"),
        ("tmdb season", "tmdb season", "Show", "mismatch", "episodes[0].show_id", "999"),
        ("tmdb season", "tmdb season", "Show", "unbound", "episodes[0].show_id", "<missing>"),
        ("seerr season", "seerr season", "Season", "mismatch", "seasonNumber", "2"),
        ("seerr season", "seerr season", "Season", "unbound", "seasonNumber", "<missing>"),
        ("seerr season", "seerr season", "Season", "row mismatch", "episodes[0].seasonNumber", "2"),
        ("seerr season", "seerr season", "Show", "mismatch", "episodes[0].showId", "999"),
        ("seerr season", "seerr season", "Show", "unbound", "episodes[0].showId", "<missing>"),
        ("tmdb multi search", "tmdb search", "Page", "mismatch", "page", "2"),
        ("tmdb multi search", "tmdb search", "Page", "unbound", "page", "<missing>"),
        ("tmdb multi search", "tmdb search", "Page", "occupancy", "results", "[]"),
        ("seerr search", "seerr search", "Page", "mismatch", "page", "2"),
        ("seerr search", "seerr search", "Page", "unbound", "page", "<missing>"),
        ("seerr search", "seerr search", "Page", "occupancy", "results", "[]"),
        ("seerr metadata movie", "metadata movie", "Id", "mismatch", "id", "99"),
        ("seerr metadata movie", "metadata movie", "MediaType", "mismatch", "mediaType", "\"tv\""),
        ("seerr metadata movie", "metadata movie", "MediaType", "mismatch", "mediaInfo", "{\"mediaType\":\"tv\"}"),
        ("seerr metadata series", "metadata show", "Id", "mismatch", "id", "99"),
        ("seerr metadata series", "metadata show", "MediaType", "mismatch", "mediaType", "\"movie\""),
        ("seerr metadata season", "metadata season", "Season", "mismatch", "seasonNumber", "2"),
        ("seerr metadata season", "metadata season", "Season", "unbound", "seasonNumber", "<missing>"),
        ("seerr metadata season", "metadata season", "Season", "row mismatch", "episodes[0].seasonNumber", "2"),
        ("seerr metadata season", "metadata season", "Show", "mismatch", "episodes[0].showId", "999"),
        ("seerr metadata season", "metadata season", "Show", "unbound", "episodes[0].showId", "<missing>"),
        ("tmdb metadata movie", "metadata movie", "Id", "mismatch", "id", "99"),
        ("tmdb metadata movie", "metadata movie", "MediaType", "mismatch", "media_type", "\"tv\""),
        ("tmdb metadata series", "metadata show", "Id", "mismatch", "id", "99"),
        ("tmdb metadata season", "metadata season", "Season", "mismatch", "season_number", "2"),
        ("tmdb metadata season", "metadata season", "Season", "unbound", "season_number", "<missing>"),
        ("tmdb metadata season", "metadata season", "Show", "mismatch", "episodes[0].show_id", "999"),
        ("tmdb metadata season", "metadata season", "Show", "unbound", "episodes[0].show_id", "<missing>"),
        ("tmdb poster", "tmdb poster", "Id", "mismatch", "id", "99"),
        ("tmdb poster", "tmdb poster", "Id", "unbound", "id", "<missing>"),
    };

    public static IEnumerable<object[]> KindBindingCells() => KindCells.Select(c => new object[] { c.Kind, c.Fact, c.Variant, c.Path });

    [Theory]
    [MemberData(nameof(KindBindingCells))]
    public async Task AnAnswerToAnotherRequestOrWithoutItsEchoIsNeverDefinitive(string kindName, string fact, string variant, string path)
    {
        var cell = KindCells.Single(c => c.Kind == kindName && c.Fact == fact && c.Variant == variant && c.Path == path);
        var kind = R7.Kinds.Single(k => k.Name == kindName);
        using var w = new World();
        var body = R9.Set(kind.Body, path, cell.Json);
        var seen = await kind.Read(w, body);
        output.WriteLine(kindName + " | " + fact + " " + variant + " (" + path + " = " + cell.Json + "): " + seen);
        Assert.False(seen.Kept, "an answer to another request (or without its echo) was kept");
        Assert.False(seen.Cleared, "it cleared a value the entry has");
        if (variant is "mismatch" or "row mismatch" or "occupancy" && fact != "Page" || variant == "occupancy")
        {
            Assert.False(seen.Used, "another request's answer was used");
        }
    }

    // The control: every kind's answer as the fixtures give it (the real shapes: seasons name their show) is definitive.
    public static IEnumerable<object[]> BoundKinds() => KindCells.Select(c => c.Kind).Distinct().Select(k => new object[] { k });

    [Theory]
    [MemberData(nameof(BoundKinds))]
    public async Task AnAnswerBoundToItsRequestIsDefinitive(string kindName)
    {
        var kind = R7.Kinds.Single(k => k.Name == kindName);
        using var w = new World();
        var seen = await kind.Read(w, kind.Body);
        Assert.True(seen.Used && seen.Kept, kindName + ": " + seen);
    }

    // List sources: the production fetcher over each provider's answer with its echo changed or removed.
    internal static readonly (string Provider, string Contract, string Fact, string Variant)[] SourceCells =
    {
        ("tmdb list", "tmdb list page", "ListId", "mismatch"), ("tmdb list", "tmdb list page", "ListId", "unbound"),
        ("tmdb list", "tmdb list page", "Page", "mismatch"), ("tmdb list", "tmdb list page", "Page", "unbound"),
        ("tmdb trending", "tmdb chart page", "Page", "mismatch"), ("tmdb trending", "tmdb chart page", "Page", "unbound"),
        ("tmdb collection", "tmdb collection", "Id", "mismatch"), ("tmdb collection", "tmdb collection", "Id", "unbound"),
        ("seerr collection", "seerr collection", "Id", "mismatch"), ("seerr collection", "seerr collection", "Id", "unbound"),
        ("seerr trending", "seerr chart page", "Page", "mismatch"), ("seerr trending", "seerr chart page", "Page", "unbound"),
        ("trakt list", "trakt page", "Page", "mismatch"), ("trakt list", "trakt page", "Page", "unbound"),
        ("imdb list", "imdb list page", "ListId", "mismatch"), ("imdb list", "imdb list page", "ListId", "unbound"),
        ("chronolists", "chronolists universe", "Universe", "mismatch"), ("chronolists", "chronolists universe", "Universe", "unbound"),
        ("chronolists", "chronolists universe", "Universe", "optional mismatch"),
        ("tmdb list", "tmdb list page", "control", "control"), ("tmdb trending", "tmdb chart page", "control", "control"), ("tmdb collection", "tmdb collection", "control", "control"),
        ("seerr collection", "seerr collection", "control", "control"), ("seerr trending", "seerr chart page", "control", "control"), ("trakt list", "trakt page", "control", "control"),
        ("imdb list", "imdb list page", "control", "control"), ("chronolists", "chronolists universe", "control", "control"),
    };

    public static IEnumerable<object[]> SourceBindingCells() => SourceCells.Select(c => new object[] { c.Provider, c.Fact, c.Variant });

    [Theory]
    [MemberData(nameof(SourceBindingCells))]
    public async Task AListAnswerToAnotherRequestOrWithoutItsEchoIsNeverComplete(string provider, string fact, string variant)
    {
        using var net = new Net { RealShapes = false }; // the echo is the case under test
        var bad = variant != "control";
        string Field(string name, string asked, string other) => !bad || fact != name ? asked : variant == "mismatch" || variant == "optional mismatch" ? other : null!;
        string Member(string json, string name, string? value) => value == null ? string.Empty : "\"" + json + "\":" + value + ",";
        string url;
        switch (provider)
        {
            case "tmdb list":
                net.Config.TMDB_API_KEY = "tmdb-key";
                net.Routes["https://api.themoviedb.org/3/list/7"] = _ => Json("{" + Member("id", "id", Field("ListId", "7", "999")) + Member("page", "page", Field("Page", "1", "2"))
                    + "\"name\":\"L\",\"total_pages\":1,\"item_count\":3,\"items\":[" + MovieRows + "]}");
                url = "https://www.themoviedb.org/list/7";
                break;
            case "tmdb trending":
                net.Config.TMDB_API_KEY = "tmdb-key";
                net.Routes["https://api.themoviedb.org/3/trending/all/week"] = _ => Json("{" + Member("page", "page", Field("Page", "1", "2")) + "\"total_pages\":1,\"total_results\":3,\"results\":[" + MovieRows + "]}");
                url = "https://www.themoviedb.org/trending/all/week";
                break;
            case "tmdb collection":
                net.Config.TMDB_API_KEY = "tmdb-key";
                net.Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{" + Member("id", "id", Field("Id", "10", "11")) + "\"name\":\"C\",\"parts\":[" + MovieRows + "]}");
                url = "https://www.themoviedb.org/collection/10";
                break;
            case "seerr collection":
            case "seerr trending":
                net.Config.TMDB_API_KEY = string.Empty;
                net.Config.JellyseerrEnabled = true;
                net.Config.JellyseerrUrls = "http://seerr.test";
                net.Config.JellyseerrApiKey = "seerr-key";
                if (provider == "seerr collection")
                {
                    net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Json("{" + Member("id", "id", Field("Id", "10", "11")) + "\"name\":\"C\",\"parts\":[" + MovieRows + "]}");
                    url = "https://www.themoviedb.org/collection/10";
                }
                else
                {
                    net.Routes["http://seerr.test/api/v1/discover/trending"] = _ => Json("{" + Member("page", "page", Field("Page", "1", "2")) + "\"totalPages\":1,\"totalResults\":3,\"results\":[" + MovieRows + "]}");
                    url = "https://www.themoviedb.org/trending/all/week";
                }

                break;
            case "trakt list":
                net.Config.ArrListTraktApiKey = "trakt-client";
                net.Routes["https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode"] = _ =>
                {
                    var response = Json("[" + string.Join(',', new[] { 1, 2, 3 }.Select(i => "{\"id\":" + (900 + i) + ",\"type\":\"movie\",\"movie\":{\"title\":\"M" + i + "\",\"year\":2001,\"ids\":{\"tmdb\":" + i + "}}}")) + "]");
                    if (Field("Page", "1", "2") is { } page)
                    {
                        response.Headers.Add("X-Pagination-Page", page);
                    }

                    response.Headers.Add("X-Pagination-Page-Count", "1");
                    response.Headers.Add("X-Pagination-Item-Count", "3");
                    return response;
                };
                url = "https://trakt.tv/users/me/lists/mine";
                break;
            case "imdb list":
                net.Routes["https://api.graphql.imdb.com/"] = _ => Json(ImdbList(Member("id", "id", Field("ListId", "\"ls000000302\"", "\"ls999999999\""))));
                url = "https://www.imdb.com/list/ls000000302/";
                break;
            default:
                var page = ImportFixtures.Read("chronolists-mcu-2026-10.html");
                page = variant switch
                {
                    "mismatch" => Once(page, "\"universe\":{\"id\":\"mcu\",", "\"universe\":{\"id\":\"dctv\","),
                    "unbound" => Once(page, "\"universe\":{\"id\":\"mcu\",", "\"universe\":{"),
                    "optional mismatch" => Once(page, "\"query\":{\"universe\":\"mcu\"}", "\"query\":{\"universe\":\"dctv\"}"),
                    _ => page,
                };
                net.Routes["https://chronolists.com/mcu"] = _ => IntegrationTransport.Response(page, 200, "text/html");
                url = "https://chronolists.com/mcu";
                break;
        }

        var (first, kept) = await ReadTwice(net, url);
        output.WriteLine(provider + " | " + fact + " " + variant + ": ok " + first.Ok + " " + first.ErrorCode + ", complete " + IsComplete(first) + ", kept " + kept);
        if (!bad)
        {
            Assert.True(IsComplete(first) && kept, "a bound answer is complete and kept");
            return;
        }

        Assert.False(IsComplete(first), "an answer to another request (or without its echo) was complete");
        Assert.False(kept, "it was kept");
        if (variant is "mismatch" or "optional mismatch" && fact != "Page")
        {
            Assert.False(first.Ok, "another resource's answer was used");
        }
    }

    // MDBList records (single title and batch rows): the title(s) and the type asked for (r9's contract, now the shared binder).
    public static IEnumerable<object[]> MdblistBindingCells() => new[]
    {
        new object[] { "single", "Id", "mismatch" }, new object[] { "single", "Id", "unbound" }, new object[] { "single", "MediaType", "mismatch" }, new object[] { "single", "MediaType", "unbound" },
        new object[] { "batch", "IdSet", "mismatch" }, new object[] { "batch", "IdSet", "unbound" }, new object[] { "batch", "MediaType", "mismatch" }, new object[] { "batch", "MediaType", "unbound" },
        new object[] { "single", "control", "control" }, new object[] { "batch", "control", "control" },
    };

    [Theory]
    [MemberData(nameof(MdblistBindingCells))]
    public async Task AnMdblistRecordOfAnotherTitleOrTypeIsNeverConfirmed(string path, string fact, string variant)
    {
        using var net = MdblistApiNet(() => 900);
        var record = (fact, variant) switch
        {
            ("Id" or "IdSet", "mismatch") => R9.Set(Record42, "ids.tmdb", "43"),
            ("Id" or "IdSet", "unbound") => R9.Set(Record42, "ids.tmdb", "<missing>"),
            ("MediaType", "mismatch") => R9.Set(Record42, "type", "\"show\""),
            ("MediaType", "unbound") => R9.Set(Record42, "type", "<missing>"),
            _ => Record42,
        };
        net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(record);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[" + record + "]");
        if (path == "single")
        {
            var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
            Assert.Equal(variant == "control", entry.Found && entry.Confirmed);
        }
        else
        {
            var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None);
            Assert.Equal(variant == "control", batch != null);
        }
    }

    // ── Rule 4b. Absence producers: every non-affirmative input is a failure, never "not found" ──

    private const string TmdbMissing = "{\"success\":false,\"status_code\":34,\"status_message\":\"The resource you requested could not be found.\"}";
    private const string ProxyPage = "<html><body><h1>404 Not Found</h1></body></html>";

    public static IEnumerable<object[]> TmdbSourceAbsenceCells() =>
        from source in new[] { "list", "collection" }
        from answer in new[] { "tmdb 404", "a proxy's 404 page", "404 {}", "404 status_code 7" }
        select new object[] { source, answer };

    [Theory]
    [MemberData(nameof(TmdbSourceAbsenceCells))]
    public async Task ATmdbListOrCollectionIsMissingOnlyOnTmdbsOwn404(string source, string answer)
    {
        using var net = new Net();
        net.Config.TMDB_API_KEY = "tmdb-key";
        var path = source == "list" ? "list/7" : "collection/10";
        net.Routes["https://api.themoviedb.org/3/" + path] = _ => answer switch
        {
            "tmdb 404" => Json(TmdbMissing, 404),
            "a proxy's 404 page" => IntegrationTransport.Response(ProxyPage, 404, "text/html"),
            "404 {}" => Json("{}", 404),
            _ => Json("{\"status_code\":7,\"status_message\":\"Invalid API key\"}", 404),
        };
        var result = await net.Fetch("https://www.themoviedb.org/" + path);
        output.WriteLine(source + " | " + answer + ": " + result.ErrorCode);
        Assert.False(result.Ok);
        Assert.Equal(answer == "tmdb 404" ? "not_found" : "upstream_error", result.ErrorCode);
    }

    [Theory]
    [InlineData("details", "tmdb 404")]
    [InlineData("details", "a proxy's 404 page")]
    [InlineData("season", "tmdb 404")]
    [InlineData("season", "a proxy's 404 page")]
    [InlineData("find", "tmdb 404")]
    [InlineData("find", "a proxy's 404 page")]
    public async Task ATmdbLookupIsNoSuchIdOnlyOnTmdbsOwn404(string kind, string answer)
    {
        using var w = new World();
        var at = kind switch { "details" => "movie/49521", "season" => "tv/1412/season/9", _ => "find/tt0770828" };
        w.Answer(R7.Tmdb + at, answer == "tmdb 404" ? TmdbMissing : ProxyPage, 404);
        async Task<LookupStatus> Read() => kind switch
        {
            "details" => (await w.TmdbLookup.GetDetailsAsync("movie", 49521, w.Context, None)).Status,
            "season" => (await w.TmdbLookup.GetSeasonAsync(1412, 9, w.Context, None)).Status,
            _ => (await w.TmdbLookup.SearchAsync("imdb:tt0770828", w.Context, None)).Status,
        };
        var first = await Read();
        output.WriteLine(kind + " | " + answer + ": " + first);
        if (answer == "tmdb 404")
        {
            Assert.Equal(kind == "find" ? LookupStatus.Ok : LookupStatus.NotFound, first); // find's 404 is "no titles"
        }
        else
        {
            Assert.Equal(LookupStatus.Transient, first);
        }
    }

    [Theory]
    [InlineData("tmdb 404", true)]
    [InlineData("a proxy's 404 page", false)]
    public async Task ASeasonPosterLetsTheShowsStandInOnlyOnTmdbsOwn404(string answer, bool showStandsIn)
    {
        using var w = new World();
        w.Answer(R7.Tmdb + "tv/1412/season/1", answer == "tmdb 404" ? TmdbMissing : ProxyPage, 404);
        w.Answer(R7.Tmdb + "tv/1412", "{\"id\":1412,\"poster_path\":\"/show.jpg\"}");
        var read = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).ReadTmdbPosterAsync(R7.Prefilled(PlaceholderKinds.Season), None);
        Assert.Equal(showStandsIn, read.Answered);
        Assert.Equal(showStandsIn ? "/show.jpg" : null, read.Poster);
    }

    // Seerr answers a missing title, season or collection with 500 (seen live); its 404 is its unknown-route answer, so no Seerr
    // answer is an absence (ProviderAbsence.Seerr).
    [Theory]
    [InlineData("lookup details")]
    [InlineData("metadata movie")]
    [InlineData("collection")]
    public async Task NoSeerrAnswerIsAnAbsence(string reader)
    {
        const string NotARoute = "{\"message\":\"not found\",\"errors\":[]}";
        if (reader == "collection")
        {
            using var net = new Net();
            net.Config.TMDB_API_KEY = string.Empty;
            net.Config.JellyseerrEnabled = true;
            net.Config.JellyseerrUrls = "http://seerr-a.test\nhttp://seerr-b.test";
            net.Config.JellyseerrApiKey = "seerr-key";
            net.Routes["http://seerr-a.test/api/v1/collection/10"] = _ => Json(NotARoute, 404);
            net.Routes["http://seerr-b.test/api/v1/collection/10"] = _ => Json(NotARoute, 404);
            var result = await net.Fetch("https://www.themoviedb.org/collection/10");
            Assert.Equal("upstream_error", result.ErrorCode);
            return;
        }

        using var w = new World();
        var path = reader == "lookup details" ? "movie/49521" : "movie/10";
        w.Answer(R7.SeerrA + path, NotARoute, 404);
        w.Answer(R7.SeerrB + path, NotARoute, 404);
        if (reader == "lookup details")
        {
            var first = await w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None);
            Assert.Equal(LookupStatus.Transient, first.Status);
            return;
        }

        var service = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        await service.FetchAsync(R7.Prefilled(PlaceholderKinds.Movie), TimeSpan.FromHours(12), Today, None);
        var calls = w.Total;
        await service.FetchAsync(R7.Prefilled(PlaceholderKinds.Movie), TimeSpan.FromHours(12), Today, None);
        Assert.True(w.Total > calls, "Seerr's 404s were remembered as \"no such title\"");
    }

    public static IEnumerable<object[]> MdblistApiAbsenceCells() => new[]
    {
        new object[] { 404, "{\"error\":\"Not found\"}", "not_found" },
        new object[] { 403, "{\"error\":\"Permission denied\"}", "not_found" },
        new object[] { 401, "{\"error\":\"Invalid API key\"}", "upstream_error" },
        new object[] { 404, ProxyPage, "upstream_error" },
        new object[] { 403, "{}", "upstream_error" },
    };

    [Theory]
    [MemberData(nameof(MdblistApiAbsenceCells))]
    public async Task AnMdblistApiListIsMissingOnlyOnMdblistsOwnErrorObject(int status, string body, string code)
    {
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/lists/me/mine/items"] = _ => body.StartsWith('<') ? IntegrationTransport.Response(body, status, "text/html") : Json(body, status);
        var result = await net.Fetch("https://mdblist.com/lists/me/mine", ApiRead);
        output.WriteLine(status + " " + body + ": " + result.ErrorCode);
        Assert.Equal(code, result.ErrorCode);
    }

    [Theory]
    [InlineData("{\"response\":false,\"error\":\"Movie not found\"}", true)]
    [InlineData("{\"response\":false}", false)]
    [InlineData("{\"response\":false,\"error\":{\"code\":1}}", false)]
    public async Task AnMdblistMissIsConfirmedOnlyOnItsNoMatchAnswer(string body, bool confirmed)
    {
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(body);
        var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
        Assert.False(entry.Found);
        Assert.Equal(confirmed, entry.Confirmed);
    }

    // The status-only producers (the site's own answer: the source transport follows no redirects) stay absences.
    [Theory]
    [InlineData("https://trakt.tv/users/me/lists/mine", "https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode", "not_found")]
    [InlineData("https://chronolists.com/zzqq", "https://chronolists.com/zzqq", "not_found")]
    [InlineData("https://mdblist.com/lists/me/mine", "https://mdblist.com/lists/me/mine/json", "mdblist_not_public")]
    public async Task AProvidersOwnNotFoundStaysAnAbsence(string url, string at, string code)
    {
        using var net = new Net();
        net.Config.ArrListTraktApiKey = "trakt-client";
        net.Routes[at] = _ => IntegrationTransport.Response("<html>Page Not Found</html>", 404, "text/html");
        var result = await net.Fetch(url);
        Assert.Equal(code, result.ErrorCode);
    }

    // ── Rule 4c. The sentinel sweep: a sentinel planted in every provider string, or as every member name, never reaches the log ──

    private static readonly string[] Plantings = { "values", "names", "extra members" };

    public static IEnumerable<object[]> SentinelCells() =>
        from reader in R7.Kinds.Select(k => k.Name).Concat(new[] { "tmdb list", "tmdb trending", "trakt list", "imdb list", "mdblist public", "chronolists", "seerr collection" })
        from planting in Plantings
        select new object[] { reader, planting };

    [Theory]
    [MemberData(nameof(SentinelCells))]
    public async Task NoProviderTextReachesTheLog(string reader, string planting)
    {
        string log;
        if (R7.Kinds.FirstOrDefault(k => k.Name == reader) is { } kind)
        {
            using var w = new World();
            await kind.Read(w, Plant(kind.Body, planting));
            log = ReadLog(w.Plugin.Core.Logger);
        }
        else
        {
            using var net = new Net();
            string url;
            switch (reader)
            {
                case "tmdb list":
                    net.Config.TMDB_API_KEY = "tmdb-key";
                    net.Routes["https://api.themoviedb.org/3/list/7"] = _ => Json(Plant("{\"id\":7,\"page\":1,\"name\":\"L\",\"total_pages\":1,\"item_count\":3,\"items\":[" + MovieRows + "]}", planting));
                    url = "https://www.themoviedb.org/list/7";
                    break;
                case "tmdb trending":
                    net.Config.TMDB_API_KEY = "tmdb-key";
                    net.Routes["https://api.themoviedb.org/3/trending/all/week"] = _ => Json(Plant("{\"page\":1,\"total_pages\":1,\"total_results\":3,\"results\":[" + MovieRows + "]}", planting));
                    url = "https://www.themoviedb.org/trending/all/week";
                    break;
                case "trakt list":
                    net.Config.ArrListTraktApiKey = "trakt-client";
                    net.Routes["https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode"] = _ =>
                    {
                        var response = Json(Plant("[" + string.Join(',', new[] { 1, 2 }.Select(i => "{\"id\":" + (900 + i) + ",\"type\":\"movie\",\"notes\":\"n\",\"movie\":{\"title\":\"M\",\"year\":2001,\"ids\":{\"tmdb\":" + i + "}}}")) + "]", planting));
                        response.Headers.Add("X-Pagination-Page", "1");
                        response.Headers.Add("X-Pagination-Page-Count", "1");
                        response.Headers.Add("X-Pagination-Item-Count", "2");
                        return response;
                    };
                    url = "https://trakt.tv/users/me/lists/mine";
                    break;
                case "imdb list":
                    net.Routes["https://api.graphql.imdb.com/"] = _ => Json(Plant(ImdbList("\"id\":\"ls000000302\","), planting));
                    url = "https://www.imdb.com/list/ls000000302/";
                    break;
                case "mdblist public":
                    net.Routes["https://mdblist.com/lists/me/mine/json"] = _ => Json(Plant("[{\"id\":1,\"title\":\"M\",\"mediatype\":\"movie\",\"release_year\":2001,\"imdb_id\":\"tt0000001\"}]", planting));
                    url = "https://mdblist.com/lists/me/mine";
                    break;
                case "seerr collection":
                    net.Config.TMDB_API_KEY = string.Empty;
                    net.Config.JellyseerrEnabled = true;
                    net.Config.JellyseerrUrls = "http://seerr.test";
                    net.Config.JellyseerrApiKey = "seerr-key";
                    net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Json(Plant("{\"id\":10,\"name\":\"C\",\"parts\":[" + MovieRows + "]}", planting));
                    url = "https://www.themoviedb.org/collection/10";
                    break;
                default:
                    var page = ImportFixtures.Read("chronolists-dctv-2026-10.html");
                    var start = page.IndexOf('>', page.IndexOf("id=\"__NEXT_DATA__\"", StringComparison.Ordinal)) + 1;
                    var end = page.IndexOf("</script>", start, StringComparison.Ordinal);
                    page = page[..start] + Plant(page[start..end], planting) + page[end..];
                    net.Routes["https://chronolists.com/dctv"] = _ => IntegrationTransport.Response(page, 200, "text/html");
                    url = "https://chronolists.com/dctv";
                    break;
            }

            var result = await net.Fetch(url);
            output.WriteLine(reader + " | " + planting + ": ok " + result.Ok + " " + result.ErrorCode);
            log = ReadLog(net.Plugin.Core.Logger);
        }

        output.WriteLine(string.Join('\n', log.Split('\n').TakeLast(6)));
        Assert.DoesNotContain(Sentinel, log, StringComparison.Ordinal);
    }

    // Every string value + the sentinel; every member name + the sentinel; or a sentinel-named member (with a sentinel value)
    // added to every object.
    internal static string Plant(string json, string planting)
    {
        JsonNode? Walk(JsonNode? node) => node switch
        {
            JsonObject o => Extra(new JsonObject(o.Select(p => KeyValuePair.Create(planting == "names" ? p.Key + Sentinel : p.Key, Walk(p.Value))))),
            JsonArray a => new JsonArray(a.Select(Walk).ToArray()),
            JsonValue v when planting == "values" && v.TryGetValue<string>(out var text) => JsonValue.Create(text + Sentinel),
            null => null,
            _ => node.DeepClone(),
        };

        JsonObject Extra(JsonObject o)
        {
            if (planting == "extra members")
            {
                o[Sentinel + "m"] = new JsonObject { [Sentinel + "n"] = Sentinel + "v" };
            }

            return o;
        }

        return Walk(JsonNode.Parse(json))!.ToJsonString();
    }

    private static string Once(string text, string what, string with)
    {
        var at = text.IndexOf(what, StringComparison.Ordinal);
        Assert.True(at >= 0 && text.IndexOf(what, at + 1, StringComparison.Ordinal) < 0, "fixture text " + what);
        return text[..at] + with + text[(at + what.Length)..];
    }
}
