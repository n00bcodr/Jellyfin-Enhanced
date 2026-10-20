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
using World = JE.Tests.ListsSourceReviewR6FixTests.World;

namespace JE.Tests;

// Track 4c2a review round 9 (D53, 9th round: r8's typed parse-once held for SYNTAX, but every answer was still accepted without
// being checked against the REQUEST that produced it).
// 1. Contracts take the request: an answer is the one asked for (id, media type, season, show, page), its rows are unique, its
//    numbers within their domain, and its declared types from a closed allowlist (4c2-R9-1, -2, -5, -6).
// 2. One fallback table for every multi-server (Seerr) read: Valid → use; Partial → fallback; Malformed, 5xx, timeout → next;
//    404 → next; "not found" only when every server said so (4c2-R9-7).
// 3. MDBList records are whole: the title and type asked for, the ratings resource whole and in its domain; a batch is admitted
//    (its misses included) only when every row is an asked title of the asked type, once (4c2-R9-3, -4).
// 4. The generated semantic model: request-relative mutations per answer kind, all server-state pairs of the fallback, the
//    paging domain of every paged list provider and the MDBList record.
[Collection("Plugin singleton")]
public class ListsSourceReviewR9FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly DateTime Today = new(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);

    // ── 4C2-R9-1: details are bound to the requested identity ──

    [Theory]
    [InlineData("tmdb", "movie")]
    [InlineData("tmdb", "tv")]
    [InlineData("seerr", "movie")]
    [InlineData("seerr", "tv")]
    public async Task DetailsOfAnotherTitleAreNeverUsedOrKept(string provider, string type)
    {
        using var w = new World();
        var (id, body) = type == "movie" ? (49521, R7.MovieBody) : (1412, R7.ShowBody);
        var wrong = Set(body, "id", "999");
        var path = type + "/" + id.ToString(CultureInfo.InvariantCulture);
        if (provider == "tmdb")
        {
            w.Answer(R7.Tmdb + path, wrong);
        }
        else
        {
            w.Answer(R7.SeerrA + path, R7.Camel(wrong));
            w.Answer(R7.SeerrB + path, "{\"message\":\"down\"}", 503);
        }

        var first = await w.Lookup(provider).GetDetailsAsync(type, id, w.Context, None);
        var calls = w.Total;
        await w.Lookup(provider).GetDetailsAsync(type, id, w.Context, None);
        output.WriteLine(provider + " " + type + ": " + first.Status + ", calls " + calls + " → " + w.Total);
        Assert.Equal(LookupStatus.Transient, first.Status);
        Assert.True(w.Total > calls, "another title's details were kept");
    }

    [Fact]
    public async Task SeerrDetailsOfAnotherTitleAskTheNextServer()
    {
        using var w = new World();
        w.Answer(R7.SeerrA + "movie/49521", R7.Camel(Set(R7.MovieBody, "id", "999")));
        w.Answer(R7.SeerrB + "movie/49521", R7.Camel(R7.MovieBody));
        var read = await w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None);
        Assert.Equal(LookupStatus.Ok, read.Status);
        Assert.Equal(ResponseVerdict.Valid, read.Verdict);
        Assert.Equal(49521, read.Value!.Hit.TmdbId);
    }

    // Seerr movie/10 answering id 99 with a null date and poster: the entry keeps both, nothing is kept, and B is asked.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MetadataOfAnotherTitleNeverClearsAndTheNextServerIsAsked(bool bHasIt)
    {
        using var w = new World();
        w.Answer(R7.SeerrA + "movie/10", Set(Set(Set(R7.MetaMovieBody, "id", "99"), "releaseDate", "null"), "posterPath", "null"));
        if (bHasIt)
        {
            w.Answer(R7.SeerrB + "movie/10", Set(R7.MetaMovieBody, "releaseDate", "\"2011-02-02\""));
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
        output.WriteLine("B " + (bHasIt ? "has it" : "down") + ": date " + entry.ReleaseDate + ", poster " + entry.PosterPath + ", calls " + calls + " → " + w.Total);
        Assert.Equal(bHasIt ? "2011-02-02" : "2001-01-01", entry.ReleaseDate);
        Assert.NotNull(entry.PosterPath);
        Assert.Contains(w.Calls, c => c.At == "seerr-b.test/api/v1/movie/10"); // A's answer is another title's: B is asked
        Assert.Equal(!bHasIt, w.Total > calls); // B's whole answer is kept; nothing of A's is
    }

    [Fact]
    public async Task JeModeMetadataAndPostersOfAnotherTitleAreUnknown()
    {
        using var w = new World();
        ImportTestFlags.AllOn(w.Plugin.Plugin.Configuration);
        w.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
        w.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        w.Answer(R7.Tmdb + "movie/10", "{\"id\":99,\"title\":\"Other\",\"release_date\":null,\"poster_path\":null,\"imdb_id\":null,\"external_ids\":{\"imdb_id\":null}}");
        var je = await new TmdbListMetadataSource(w.Cache, w.Plugin.Core.Logger).FetchAsync(R7.Prefilled(PlaceholderKinds.Movie), TimeSpan.FromHours(12), Today, None);
        var poster = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).ReadTmdbPosterAsync(ListsHarness.Movie(10), None);
        Assert.Null(je);
        Assert.False(poster.Answered);
    }

    // ── 4C2-R9-2: season answers are bound to the requested season (membership) and list each episode once ──

    public static IEnumerable<object[]> SeasonViolations() => new[] { "season 2 episodes", "a repeated episode" }.SelectMany(v => new[]
    {
        new object[] { "seerr metadata", v }, new object[] { "tmdb metadata", v }, new object[] { "tmdb lookup", v }, new object[] { "seerr lookup", v },
    });

    [Theory]
    [MemberData(nameof(SeasonViolations))]
    public async Task ASeasonAnswerOfAnotherSeasonOrWithARepeatedEpisodeIsNeverUsedOrKept(string reader, string violation)
    {
        using var w = new World();
        var episodes = violation == "season 2 episodes"
            ? "[{\"episodeNumber\":1,\"seasonNumber\":2,\"airDate\":\"2013-10-09\"},{\"episodeNumber\":2,\"seasonNumber\":2,\"airDate\":\"2013-10-16\"}]"
            : "[{\"episodeNumber\":1,\"seasonNumber\":1,\"airDate\":\"2012-10-10\"},{\"episodeNumber\":1,\"seasonNumber\":1,\"airDate\":\"2012-10-10\"}]";
        var season = Set(R7.MetaSeasonBody, "episodes", episodes);
        var tmdb = reader.StartsWith("tmdb", StringComparison.Ordinal);
        if (reader.EndsWith("metadata", StringComparison.Ordinal))
        {
            Placeholder entry = R7.Prefilled(PlaceholderKinds.Season);
            Func<Task<PlaceholderMetadata?>> fetch;
            if (tmdb)
            {
                ImportTestFlags.AllOn(w.Plugin.Plugin.Configuration);
                w.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
                w.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
                w.Answer(R7.Tmdb + "tv/1412", Snake(R7.MetaShowBody));
                w.Answer(R7.Tmdb + "tv/1412/season/1", Snake(season));
                var je = new TmdbListMetadataSource(w.Cache, w.Plugin.Core.Logger);
                fetch = () => je.FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
            }
            else
            {
                w.Answer(R7.SeerrA + "tv/1412", R7.MetaShowBody);
                w.Answer(R7.SeerrA + "tv/1412/season/1", season);
                w.Answer(R7.SeerrB + "tv/1412/season/1", "{\"message\":\"down\"}", 503);
                var service = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
                fetch = () => service.FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
            }

            var metadata = await fetch();
            ListMetadataService.Apply(entry, metadata!);
            var calls = w.Total;
            await fetch();
            output.WriteLine(reader + " " + violation + ": partial " + metadata!.Partial + ", expected " + entry.Expected?.Count + ", calls " + calls + " → " + w.Total);
            Assert.True(metadata.Partial, "a season answer that isn't the season asked for is used like a failed season read");
            Assert.Equal(3, entry.Expected!.Count); // the stored expected episodes are kept
            Assert.True(w.Total > calls, "the season answer was kept");
            return;
        }

        var lookup = tmdb ? (IImportLookup)w.TmdbLookup : w.SeerrLookup;
        if (tmdb)
        {
            w.Answer(R7.Tmdb + "tv/1412/season/1", Snake(season));
        }
        else
        {
            w.Answer(R7.SeerrA + "tv/1412/season/1", season);
            w.Answer(R7.SeerrB + "tv/1412/season/1", "{\"message\":\"down\"}", 503);
        }

        var first = await lookup.GetSeasonAsync(1412, 1, w.Context, None);
        var before = w.Total;
        await lookup.GetSeasonAsync(1412, 1, w.Context, None);
        Assert.Equal(LookupStatus.Transient, first.Status);
        Assert.True(w.Total > before, "the season answer was kept");
    }

    // ── 4C2-R9-3/4: MDBList records are whole, batches are the request's ──

    private const string Record42 = "{\"title\":\"T\",\"year\":2010,\"type\":\"movie\",\"score\":86,\"ids\":{\"imdb\":\"tt0000042\",\"tmdb\":42,\"trakt\":5,\"mal\":null},"
        + "\"ratings\":[{\"source\":\"imdb\",\"value\":8.1,\"score\":81,\"votes\":673852,\"url\":5},{\"source\":\"tomatoes\",\"value\":97,\"score\":97,\"votes\":102,\"url\":\"/m/t\",\"fresh\":1},"
        + "{\"source\":\"metacriticuser\",\"value\":null,\"score\":null,\"votes\":null,\"url\":null}]}";

    private static string Record(int id, string type = "movie") => Set(Set(Set(Record42, "ids.tmdb", id.ToString(CultureInfo.InvariantCulture)), "ids.imdb", "\"tt00000" + id.ToString(CultureInfo.InvariantCulture) + "\""), "type", "\"" + type + "\"");

    // THE ORACLE of the MDBList record (W whole; F the record isn't whole: that title's failed lookup, never confirmed; I the
    // identity isn't the request's: a single answer is a failed lookup, a batch fails whole and records no miss).
    private static readonly (string Path, string Value, char Expected)[] RecordCells =
    {
        ("ratings", "<missing>", 'F'), ("ratings", "null", 'F'), ("ratings", "{}", 'F'), ("ratings", "\"x\"", 'F'), ("ratings", "[]", 'W'),
        ("ratings[0]", "\"x\"", 'F'), ("ratings[0].source", "<missing>", 'F'), ("ratings[0].source", "\"\"", 'F'), ("ratings[0].source", "5", 'F'),
        ("ratings[0].value", "\"8.1\"", 'F'), ("ratings[0].value", "999", 'F'), ("ratings[0].value", "-1", 'F'), ("ratings[0].value", "null", 'W'), ("ratings[0].value", "<missing>", 'W'),
        ("ratings[0].score", "999", 'F'), ("ratings[0].score", "-0.5", 'F'), ("ratings[0].score", "null", 'W'),
        ("ratings[0].votes", "-7", 'F'), ("ratings[0].votes", "2.5", 'F'), ("ratings[0].votes", "\"10\"", 'F'), ("ratings[0].votes", "null", 'W'),
        ("ratings[1].fresh", "2", 'F'), ("ratings[1].fresh", "\"yes\"", 'F'), ("ratings[1].fresh", "0", 'W'), ("ratings[1].fresh", "null", 'W'),
        ("ratings[0].url", "{}", 'F'), ("ratings[0].url", "\"tt0000042\"", 'W'), ("ratings[0].url", "null", 'W'),
        ("score", "999", 'F'), ("score", "\"86\"", 'F'), ("score", "null", 'W'), ("score", "<missing>", 'W'),
        ("ids.imdb", "{}", 'F'), ("ids.imdb", "null", 'W'),
        ("type", "\"show\"", 'I'), ("type", "<missing>", 'I'), ("type", "\"movvie\"", 'I'), ("type", "null", 'I'),
        ("ids.tmdb", "43", 'I'), ("ids.tmdb", "\"broken\"", 'I'), ("ids", "<missing>", 'I'),
    };

    public static IEnumerable<object[]> MdblistRecordCells() => RecordCells.Select(c => new object[] { c.Path, c.Value });

    [Theory]
    [MemberData(nameof(MdblistRecordCells))]
    public async Task AnMdblistRatingsAnswerIsConfirmedOnlyWhenItIsTheTitlesWholeRecord(string path, string value)
    {
        var expected = RecordCells.Single(c => c.Path == path && c.Value == value).Expected;
        using var net = MdblistApiNet(() => 900);
        var body = Set(Record42, path, value);
        net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(body);
        var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
        output.WriteLine(path + " = " + value + " → " + expected + ": found " + entry.Found + ", confirmed " + entry.Confirmed);
        Assert.Equal(expected == 'W', entry.Confirmed);
        Assert.Equal(expected == 'W', entry.Found);
    }

    [Theory]
    [MemberData(nameof(MdblistRecordCells))]
    public async Task AnMdblistBatchIsAdmittedOnlyWhenEveryRowIsAnAskedTitleOnceAndConfirmsOnlyWholeRecords(string path, string value)
    {
        var expected = RecordCells.Single(c => c.Path == path && c.Value == value).Expected;
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[" + Set(Record42, path, value) + "," + Record(43) + "]");
        var asked = new[] { "42", "43", "44" };
        var batch = await net.Quota.GetMediaBatchAsync("movie", asked, None);
        output.WriteLine(path + " = " + value + " → " + expected + ": " + (batch == null ? "batch failed" : string.Join(',', batch.Select(b => b.Key + (b.Value.Confirmed ? "✓" : "?")))));
        if (expected == 'I')
        {
            Assert.Null(batch);
            return;
        }

        Assert.NotNull(batch);
        net.Quota.MergeMediaBatchIntoCache("movie", asked, batch!);
        Assert.Equal(expected == 'W', net.Quota.GetCachedEntry("movie", "42")!.Confirmed);
        Assert.True(net.Quota.GetCachedEntry("movie", "43")!.Found);
        Assert.True(net.Quota.GetCachedEntry("movie", "44")!.Confirmed); // a batch of the request's rows does prove 44's miss
    }

    // 4C2-R9-4 as found: a row of the wrong declared type stored under movie:42, a repeated id overwrote, and the other
    // requested id became a confirmed miss.
    [Theory]
    [InlineData("a show row in a movie batch")]
    [InlineData("a repeated id")]
    [InlineData("an id that wasn't asked")]
    public async Task AnMdblistBatchOfAnotherTypeOrWithARepeatedOrUnaskedIdRecordsNothing(string violation)
    {
        using var net = MdblistApiNet(() => 900);
        var rows = violation switch
        {
            "a show row in a movie batch" => new[] { Record(42, "show") },
            "a repeated id" => new[] { Record(42), Record(42) },
            _ => new[] { Record(42), Record(77) },
        };
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[" + string.Join(',', rows) + "]");
        var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42", "43" }, None);
        Assert.Null(batch);
        Assert.Null(net.Quota.GetCachedEntry("movie", "42"));
        Assert.Null(net.Quota.GetCachedEntry("movie", "43"));
    }

    // A violation never clears a stored record: the single lookup and the batch keep the title's stored ratings.
    [Theory]
    [InlineData("single")]
    [InlineData("batch")]
    public async Task ARecordThatIsntWholeNeverClearsTheStoredOne(string path)
    {
        using var net = MdblistApiNet(() => 900);
        var old = DateTimeOffset.UtcNow.AddDays(-8).ToUnixTimeMilliseconds();
        net.Quota.MergeMediaBatchIntoCache("movie", new[] { "42" }, new Dictionary<string, MdblistCacheEntry>
        {
            ["42"] = new() { Found = true, Confirmed = true, FetchedAtUnixMs = old, Ratings = { new MdblistRatingSource { Source = "imdb", Score = 81 } } },
        });
        var broken = Set(Record42, "ratings[0].score", "999");
        net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(broken);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[" + broken + "]");
        if (path == "single")
        {
            var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
            Assert.True(entry.Found);
            var sent = net.Sent("https://api.mdblist.com/tmdb/movie/42");
            await net.Quota.GetRatingsAsync("movie", "42", None);
            Assert.Equal(sent, net.Sent("https://api.mdblist.com/tmdb/movie/42")); // retried after the retry time, not on every view
        }
        else
        {
            var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None);
            net.Quota.MergeMediaBatchIntoCache("movie", new[] { "42" }, batch!);
        }

        var stored = net.Quota.GetCachedEntry("movie", "42")!;
        Assert.True(stored.Found && stored.Confirmed);
        Assert.Equal(81, stored.Ratings.Single().Score);
    }

    // ── 4C2-R9-5 and the paging model: every paged provider's paging facts within their domain and the request ──

    private static readonly string[] PagingMutations = { "control", "page count -7", "total -1", "page 2 for page 1", "total below the rows", "no page for a total" };
    private static readonly string[] PagingProviders = { "tmdb list", "tmdb trending", "tmdb chart", "seerr trending", "trakt list" };

    public static IEnumerable<object[]> PagingCells() =>
        from provider in PagingProviders
        from mutation in PagingMutations
        select new object[] { provider, mutation };

    [Theory]
    [MemberData(nameof(PagingCells))]
    public async Task APagedReadWhosePagingBreaksItsDomainOrTheRequestIsNeverCompleteOrKept(string provider, string mutation)
    {
        var (page, pages, total) = mutation switch
        {
            "page count -7" => (1, -7, 3),
            "total -1" => (1, 1, -1),
            "page 2 for page 1" => (2, 1, 3),
            "total below the rows" => (1, 1, 2),
            "no page for a total" => (1, 0, 3),
            _ => (1, 1, 3),
        };
        using var net = new Net();
        var rows = string.Join(',', new[] { 1, 2, 3 }.Select(i => "{\"id\":" + i + ",\"media_type\":\"movie\",\"mediaType\":\"movie\",\"title\":\"M" + i + "\"}"));
        string url;
        switch (provider)
        {
            case "tmdb list":
                net.Config.TMDB_API_KEY = "tmdb-key";
                net.Routes["https://api.themoviedb.org/3/list/7"] = _ => Json("{\"name\":\"L\",\"page\":" + page + ",\"total_pages\":" + pages + ",\"item_count\":" + total + ",\"items\":[" + rows + "]}");
                url = "https://www.themoviedb.org/list/7";
                break;
            case "tmdb trending":
            case "tmdb chart":
                net.Config.TMDB_API_KEY = "tmdb-key";
                net.Routes[provider == "tmdb chart" ? "https://api.themoviedb.org/3/movie/popular" : "https://api.themoviedb.org/3/trending/all/week"] =
                    _ => Json("{\"page\":" + page + ",\"total_pages\":" + pages + ",\"total_results\":" + total + ",\"results\":[" + rows + "]}");
                url = provider == "tmdb chart" ? "https://www.themoviedb.org/movie" : "https://www.themoviedb.org/trending/all/week";
                break;
            case "seerr trending":
                net.Config.TMDB_API_KEY = string.Empty;
                net.Config.JellyseerrEnabled = true;
                net.Config.JellyseerrUrls = "http://seerr.test";
                net.Config.JellyseerrApiKey = "seerr-key";
                net.Routes["http://seerr.test/api/v1/discover/trending"] = _ => Json("{\"page\":" + page + ",\"totalPages\":" + pages + ",\"totalResults\":" + total + ",\"results\":[" + rows + "]}");
                url = "https://www.themoviedb.org/trending/all/week";
                break;
            default:
                net.Config.ArrListTraktApiKey = "trakt-client";
                net.Routes["https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode"] = _ =>
                {
                    var response = Json("[" + string.Join(',', new[] { 1, 2, 3 }.Select(i => "{\"id\":" + (900 + i) + ",\"type\":\"movie\",\"movie\":{\"title\":\"M" + i + "\",\"year\":2001,\"ids\":{\"tmdb\":" + i + "}}}")) + "]");
                    response.Headers.Add("X-Pagination-Page", page.ToString(CultureInfo.InvariantCulture));
                    response.Headers.Add("X-Pagination-Page-Count", pages.ToString(CultureInfo.InvariantCulture));
                    response.Headers.Add("X-Pagination-Item-Count", total.ToString(CultureInfo.InvariantCulture));
                    return response;
                };
                url = "https://trakt.tv/users/me/lists/mine";
                break;
        }

        var cached = new SourceFetchOptions { Fresh = false };
        var first = await net.Fetch(url, cached);
        var sent = net.Requests.Count;
        await net.Fetch(url, cached);
        output.WriteLine(provider + " | " + mutation + ": ok " + first.Ok + " " + first.ErrorCode + ", complete " + IsComplete(first) + ", requests " + sent + " → " + net.Requests.Count);
        Assert.True(first.Ok, first.ErrorCode);
        Assert.True(sent <= 6, "a bad page count made the read walk " + sent + " pages");
        if (mutation == "control")
        {
            Assert.True(IsComplete(first));
            Assert.Equal(sent, net.Requests.Count);
        }
        else
        {
            Assert.False(IsComplete(first), "paging outside its domain certified a complete snapshot");
            Assert.True(net.Requests.Count > sent, "a read with broken paging was kept");
        }
    }

    // ── 4C2-R9-6: search media types are a closed allowlist ──

    [Theory]
    [InlineData("tmdb", "movvie", false)]
    [InlineData("seerr", "movvie", false)]
    [InlineData("tmdb", "movvie", true)]
    [InlineData("seerr", "movvie", true)]
    [InlineData("tmdb", "person", false)]
    [InlineData("seerr", "person", false)]
    [InlineData("seerr", "collection", false)]
    public async Task AnUnknownSearchRowTypeIsNeverAProvenAbsence(string provider, string type, bool beside)
    {
        using var w = new World();
        var unknown = "{\"media_type\":\"" + type + "\",\"id\":5,\"title\":\"X\",\"name\":\"X\"}";
        var hit = "{\"media_type\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\"}";
        var body = "{\"page\":1,\"total_pages\":1,\"total_results\":" + (beside ? 2 : 1) + ",\"results\":[" + unknown + (beside ? "," + hit : string.Empty) + "]}";
        if (provider == "tmdb")
        {
            w.Answer(R7.Tmdb + "search/multi", body);
        }
        else
        {
            w.Answer(R7.SeerrA + "search", R7.Camel(body));
            w.Answer(R7.SeerrB + "search", "{\"message\":\"down\"}", 503);
        }

        var first = await w.Lookup(provider).SearchAsync("Man of Steel", w.Context, None);
        var calls = w.Total;
        await w.Lookup(provider).SearchAsync("Man of Steel", w.Context, None);
        output.WriteLine(provider + " " + type + (beside ? " beside a hit" : string.Empty) + ": " + first.Status + " " + first.Verdict + " " + first.Value?.Count + ", kept " + (w.Total == calls));
        if (type == "movvie")
        {
            Assert.Equal(beside ? LookupStatus.Ok : LookupStatus.Transient, first.Status);
            Assert.True(w.Total > calls, "an answer with a row of an unknown type was kept");
        }
        else
        {
            // Controls: a deliberately excluded type is a valid row left out ("no titles" is proven).
            Assert.Equal(LookupStatus.Ok, first.Status);
            Assert.Equal(ResponseVerdict.Valid, first.Verdict);
            Assert.Empty(first.Value!);
        }
    }

    // ── 4C2-R9-7 and the fallback model: all server-state pairs, through every multi-server reader ──

    private static readonly string[] States = { "valid", "partial", "malformed", "500", "timeout", "404" };

    public static IEnumerable<object[]> FallbackCells() =>
        from reader in new[] { "list collection", "lookup details", "metadata movie" }
        from a in States
        from b in States
        select new object[] { reader, a, b };

    // THE ORACLE of the fallback table, restated here (never the production table): per server Valid → use and stop;
    // Partial → the fallback; Malformed, 5xx, timeout → next; 404 → next. Outcome: the first Valid; else the first Partial;
    // else "not found" only when every server said 404; else unavailable.
    private enum Server { Valid, Partial, Malformed, Unavailable, NotFound }

    private enum Outcome { Valid, Partial, NotFound, Unavailable }

    private static Server StateOf(string answer) => answer switch
    {
        "valid" => Server.Valid,
        "partial" => Server.Partial,
        "malformed" => Server.Malformed,
        "404" => Server.NotFound,
        _ => Server.Unavailable,
    };

    private static Outcome Expect(Server[] asked) =>
        asked.Contains(Server.Valid) ? Outcome.Valid
        : asked.Contains(Server.Partial) ? Outcome.Partial
        : asked.All(s => s == Server.NotFound) ? Outcome.NotFound
        : Outcome.Unavailable;

    [Theory]
    [MemberData(nameof(FallbackCells))]
    public async Task EveryMultiServerReadFollowsTheOneFallbackTable(string reader, string a, string b)
    {
        // The table's outcome, and whose answer it carries: the first Valid server's, else the first Partial one's.
        var states = StateOf(a) == Server.Valid ? new[] { StateOf(a) } : new[] { StateOf(a), StateOf(b) };
        var expected = Expect(states);
        var carried = expected == Outcome.Valid ? Server.Valid : Server.Partial;
        var winner = StateOf(a) == carried ? "A" : "B";
        var bAsked = StateOf(a) != Server.Valid;
        output.WriteLine(reader + " | A " + a + ", B " + b + " → " + expected + (expected is Outcome.Valid or Outcome.Partial ? " (" + winner + ")" : string.Empty));

        switch (reader)
        {
            case "list collection":
            {
                using var net = new Net();
                net.Config.TMDB_API_KEY = string.Empty;
                net.Config.JellyseerrEnabled = true;
                net.Config.JellyseerrUrls = "http://seerr-a.test\nhttp://seerr-b.test";
                net.Config.JellyseerrApiKey = "seerr-key";
                net.Routes["http://seerr-a.test/api/v1/collection/10"] = ListAnswer(a, 0);
                net.Routes["http://seerr-b.test/api/v1/collection/10"] = ListAnswer(b, 10);
                var cached = new SourceFetchOptions { Fresh = false };
                var result = await net.Fetch("https://www.themoviedb.org/collection/10", cached);
                var sent = net.Requests.Count;
                await net.Fetch("https://www.themoviedb.org/collection/10", cached);
                output.WriteLine("ok " + result.Ok + " " + result.ErrorCode + ", items " + string.Join(',', result.Items.Select(i => i.TmdbId)) + ", complete " + IsComplete(result));
                Assert.Equal(bAsked, net.Sent("http://seerr-b.test/") > 0);
                switch (expected)
                {
                    case Outcome.Valid:
                        Assert.True(IsComplete(result));
                        Assert.Equal(winner == "A" ? 1 : 11, result.Items.First().TmdbId);
                        Assert.Equal(sent, net.Requests.Count); // kept
                        break;
                    case Outcome.Partial:
                        Assert.True(result.Ok && !IsComplete(result));
                        Assert.Contains(result.Items, i => i.TmdbId == (winner == "A" ? 2 : 12));
                        Assert.True(net.Requests.Count > sent, "a partial read was kept");
                        break;
                    case Outcome.NotFound:
                        Assert.Equal("not_found", result.ErrorCode);
                        break;
                    default:
                        Assert.False(result.Ok);
                        Assert.NotEqual("not_found", result.ErrorCode);
                        break;
                }

                break;
            }

            case "lookup details":
            {
                using var w = new World();
                w.Routes["seerr-a.test/api/v1/movie/49521"] = LookupAnswer(a, "A");
                w.Routes["seerr-b.test/api/v1/movie/49521"] = LookupAnswer(b, "B");
                var read = await w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None);
                var calls = w.Total;
                await w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None);
                output.WriteLine(read.Status + " " + read.Verdict + " " + read.Value?.Hit.Title);
                Assert.Equal(bAsked, w.Calls.Any(c => c.At.StartsWith("seerr-b.test", StringComparison.Ordinal)));
                switch (expected)
                {
                    case Outcome.Valid:
                        Assert.Equal(ResponseVerdict.Valid, read.Verdict);
                        Assert.Equal("Man of Steel " + winner, read.Value!.Hit.Title);
                        Assert.Equal(calls, w.Total);
                        break;
                    case Outcome.Partial:
                        Assert.Equal(LookupStatus.Ok, read.Status);
                        Assert.Equal(ResponseVerdict.Partial, read.Verdict);
                        Assert.Equal("Man of Steel " + winner, read.Value!.Hit.Title);
                        Assert.True(w.Total > calls, "a partial answer was kept");
                        break;
                    case Outcome.NotFound:
                        Assert.Equal(LookupStatus.NotFound, read.Status);
                        break;
                    default:
                        Assert.Equal(LookupStatus.Transient, read.Status);
                        Assert.True(w.Total > calls, "an unknown answer was kept");
                        break;
                }

                break;
            }

            default:
            {
                using var w = new World();
                w.Routes["seerr-a.test/api/v1/movie/10"] = MetadataAnswer(a, "2010-07-16");
                w.Routes["seerr-b.test/api/v1/movie/10"] = MetadataAnswer(b, "2011-02-02");
                var entry = R7.Prefilled(PlaceholderKinds.Movie);
                var service = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
                var metadata = await service.FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
                if (metadata != null)
                {
                    ListMetadataService.Apply(entry, metadata);
                }

                var calls = w.Total;
                await service.FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
                output.WriteLine("metadata " + (metadata == null ? "unknown" : (metadata.Partial ? "partial " : "whole ") + metadata.ReleaseDate) + ", entry " + entry.ReleaseDate + " " + entry.PosterPath);
                Assert.Equal(bAsked, w.Calls.Any(c => c.At.StartsWith("seerr-b.test", StringComparison.Ordinal)));
                Assert.NotNull(entry.ReleaseDate); // nothing ever clears it
                Assert.NotNull(entry.PosterPath);
                switch (expected)
                {
                    case Outcome.Valid:
                        Assert.Equal(winner == "A" ? "2010-07-16" : "2011-02-02", entry.ReleaseDate);
                        Assert.Equal(calls, w.Total);
                        break;
                    case Outcome.Partial:
                        Assert.True(metadata!.Partial);
                        Assert.Equal("2001-01-01", entry.ReleaseDate);
                        Assert.True(w.Total > calls, "partial metadata was kept");
                        break;
                    default:
                        Assert.Null(metadata);
                        Assert.Equal("2001-01-01", entry.ReleaseDate);
                        break;
                }

                break;
            }
        }
    }

    // 4C2-R9-7 as found: a partial answer from A returned at once (B never asked), and Seerr's 500 read as "no such collection".
    [Theory]
    [InlineData("partial", "valid", "B's whole collection")]
    [InlineData("500", "404", "unavailable")]
    [InlineData("404", "500", "unavailable")]
    [InlineData("500", "500", "unavailable")]
    [InlineData("404", "404", "not_found")]
    public async Task ASeerrListReadAsksEveryServerAndNeverTakesA500ForNotFound(string a, string b, string outcome)
    {
        using var net = new Net();
        net.Config.TMDB_API_KEY = string.Empty;
        net.Config.JellyseerrEnabled = true;
        net.Config.JellyseerrUrls = "http://seerr-a.test\nhttp://seerr-b.test";
        net.Config.JellyseerrApiKey = "seerr-key";
        net.Routes["http://seerr-a.test/api/v1/collection/10"] = ListAnswer(a, 0);
        net.Routes["http://seerr-b.test/api/v1/collection/10"] = ListAnswer(b, 10);
        var result = await net.Fetch("https://www.themoviedb.org/collection/10");
        output.WriteLine(a + "/" + b + ": ok " + result.Ok + " " + result.ErrorCode);
        Assert.Equal(1, net.Sent("http://seerr-b.test/"));
        switch (outcome)
        {
            case "B's whole collection":
                Assert.True(IsComplete(result));
                Assert.Equal(new[] { 11, 12, 13 }, result.Items.Select(i => i.TmdbId ?? 0));
                break;
            case "not_found":
                Assert.Equal("not_found", result.ErrorCode);
                break;
            default:
                Assert.False(result.Ok);
                Assert.NotEqual("not_found", result.ErrorCode);
                break;
        }
    }

    // A server answer by state: the list collection (ids from `base` + 1..3; partial: one row without an id).
    private static Func<HttpRequestMessage, HttpResponseMessage> ListAnswer(string state, int @base)
    {
        string Row(int i) => "{\"id\":" + (@base + i) + ",\"mediaType\":\"movie\",\"title\":\"M" + (@base + i) + "\"}";
        return state switch
        {
            "valid" => _ => Json("{\"id\":10,\"name\":\"C\",\"parts\":[" + Row(1) + "," + Row(2) + "," + Row(3) + "]}"),
            "partial" => _ => Json("{\"id\":10,\"name\":\"C\",\"parts\":[{\"mediaType\":\"movie\",\"title\":\"No id\"}," + Row(2) + "," + Row(3) + "]}"),
            "malformed" => _ => Json("{\"id\":99,\"name\":\"Another\",\"parts\":[" + Row(1) + "]}"), // another collection's answer
            _ => Failure(state),
        };
    }

    // The lookup's movie details (title "Man of Steel <server>"; partial: a date that isn't one; malformed: another title).
    private static Func<HttpRequestMessage, HttpResponseMessage> LookupAnswer(string state, string server)
    {
        var body = R7.Camel(Set(R7.MovieBody, "title", "\"Man of Steel " + server + "\""));
        return state switch
        {
            "valid" => _ => Json(body),
            "partial" => _ => Json(Set(body, "releaseDate", "\"not-a-date\"")),
            "malformed" => _ => Json(Set(body, "id", "999")),
            _ => Failure(state),
        };
    }

    // Placeholder metadata of movie/10 (partial: a date that isn't one; malformed: another title with no date or poster).
    private static Func<HttpRequestMessage, HttpResponseMessage> MetadataAnswer(string state, string date)
    {
        var body = Set(R7.MetaMovieBody, "releaseDate", "\"" + date + "\"");
        return state switch
        {
            "valid" => _ => Json(body),
            "partial" => _ => Json(Set(body, "releaseDate", "\"not-a-date\"")),
            "malformed" => _ => Json(Set(Set(Set(body, "id", "99"), "releaseDate", "null"), "posterPath", "null")),
            _ => Failure(state),
        };
    }

    private static Func<HttpRequestMessage, HttpResponseMessage> Failure(string state) => state switch
    {
        "500" => _ => Json("{\"message\":\"Unable to retrieve.\"}", 500),
        "timeout" => _ => throw new TaskCanceledException("the request timed out"),
        _ => _ => Json("{\"message\":\"Not Found\"}", 404),
    };

    // ── The generated semantic model: request-relative mutations per answer kind (r7's kinds, r8's production readers) ──

    // THE ORACLE: a value that makes the answer another resource's (another id, media type, season or show), or a row key
    // listed twice, is M (never used, kept, proof of an absence, or allowed to clear a value); a search row of an unknown type,
    // or paging outside its domain or the request, is P (used, never kept, never "no titles"). A season answer that isn't
    // Valid is used like a failed season read (r7's convention: M).
    private static readonly Dictionary<string, (string Path, string Value, char Expected)[]> RequestCells = new()
    {
        ["tmdb details movie"] = new[] { ("id", "999", 'M'), ("media_type", "\"tv\"", 'M') },
        ["tmdb details tv"] = new[] { ("id", "999", 'M'), ("media_type", "\"movie\"", 'M'), ("seasons[1].season_number", "1", 'M') },
        ["tmdb season"] = new[] { ("episodes[0].season_number", "2", 'M'), ("season_number", "2", 'M'), ("episodes[1].episode_number", "1", 'M'), ("episodes[0].show_id", "999", 'M') },
        ["tmdb episode find"] = new[] { ("tv_episode_results", "<two rows>", 'M'), ("tv_episode_results", "<the row twice>", 'M') },
        ["tmdb multi search"] = new[] { ("results[0].media_type", "\"movvie\"", 'P'), ("total_results", "-1", 'P'), ("total_results", "1", 'P'), ("page", "2", 'P'), ("total_pages", "0", 'P') },
        ["seerr details movie"] = new[] { ("id", "999", 'M'), ("mediaType", "\"tv\"", 'M') },
        ["seerr details tv"] = new[] { ("id", "999", 'M'), ("seasons[1].seasonNumber", "1", 'M') },
        ["seerr season"] = new[] { ("episodes[0].seasonNumber", "2", 'M'), ("seasonNumber", "2", 'M'), ("episodes[1].episodeNumber", "1", 'M'), ("episodes[0].showId", "999", 'M') },
        ["seerr search"] = new[] { ("results[0].mediaType", "\"movvie\"", 'P'), ("totalResults", "-1", 'P'), ("totalResults", "1", 'P'), ("page", "2", 'P') },
        ["seerr metadata movie"] = new[] { ("id", "99", 'M') },
        ["seerr metadata series"] = new[] { ("id", "99", 'M'), ("seasons", "<a season twice>", 'M') },
        ["seerr metadata season"] = new[] { ("episodes[0].seasonNumber", "2", 'M'), ("seasonNumber", "2", 'M'), ("episodes[1].episodeNumber", "1", 'M'), ("episodes[0].showId", "999", 'M') },
        ["tmdb metadata movie"] = new[] { ("id", "99", 'M') },
        ["tmdb metadata series"] = new[] { ("id", "99", 'M'), ("seasons", "<a season twice>", 'M') },
        ["tmdb metadata season"] = new[] { ("episodes[0].season_number", "2", 'M'), ("season_number", "2", 'M'), ("episodes[1].episode_number", "1", 'M') },
        ["tmdb poster"] = new[] { ("id", "99", 'M') },
    };

    public static IEnumerable<object[]> RequestModelCells() =>
        from kind in RequestCells.Keys
        from cell in RequestCells[kind]
        select new object[] { kind, cell.Path, cell.Value };

    [Theory]
    [MemberData(nameof(RequestModelCells))]
    public async Task AnAnswerToAnotherRequestIsNeverValid(string kindName, string path, string value)
    {
        var kind = R7.Kinds.Single(k => k.Name == kindName);
        var expected = RequestCells[kindName].Single(c => c.Path == path && c.Value == value).Expected;
        using var w = new World();
        var body = value switch
        {
            "<two rows>" => Set(kind.Body, path, "[" + Row0(kind.Body, path) + "," + Set(Row0(kind.Body, path), "episode_number", "3") + "]"),
            "<the row twice>" => Set(kind.Body, path, "[" + Row0(kind.Body, path) + "," + Row0(kind.Body, path) + "]"),
            "<a season twice>" => Set(kind.Body, path, "[" + Row0(kind.Body, path) + "," + Row0(kind.Body, path) + "]"),
            _ => Set(kind.Body, path, value),
        };
        var seen = await kind.Read(w, body);
        output.WriteLine(kindName + " | " + path + " = " + value + " → expected " + expected + ", saw " + seen + "\n" + body);
        if (expected == 'P')
        {
            Assert.True(seen.Used, "partial: still used");
            Assert.False(seen.Kept, "partial: never kept");
        }
        else
        {
            Assert.False(seen.Used, "another request's answer: never used");
            Assert.False(seen.Kept, "another request's answer: never kept");
        }

        Assert.False(seen.Cleared, "never clears a value the entry has");
    }

    // Controls: the request's own answer (each kind's valid body) is used and kept (r7's EveryKindsValidAnswerIsDefinitive
    // covers every kind); explicit empty lists and legitimate nulls stay valid.
    [Theory]
    [InlineData("tmdb season", "episodes", "[]")]
    [InlineData("seerr metadata movie", "posterPath", "null")]
    [InlineData("tmdb details movie", "imdb_id", "null")]
    [InlineData("tmdb multi search", "results", "[]")]
    public async Task ExplicitEmptyListsAndLegitimateNullsStayValid(string kindName, string path, string value)
    {
        var kind = R7.Kinds.Single(k => k.Name == kindName);
        using var w = new World();
        var body = Set(kind.Body, path, value);
        if (kindName == "tmdb multi search")
        {
            body = Set(Set(body, "total_results", "0"), "total_pages", "1");
        }

        var seen = await kind.Read(w, body);
        Assert.True(seen.Used && seen.Kept, kindName + " " + path + " = " + value + ": " + seen);
    }

    // ── JSON helpers ──

    private static string Row0(string body, string path) => JsonNode.Parse(body)![path.Split('.')[^1]]![0]!.ToJsonString();

    // One field set to a raw JSON value ("<missing>" removes it); the last segment may index a list ("ratings[0]").
    internal static string Set(string body, string path, string json)
    {
        var root = JsonNode.Parse(body)!;
        var segments = path.Split('.');
        JsonNode node = root;
        foreach (var segment in segments[..^1])
        {
            node = R7.Step(node, segment)!;
        }

        var last = segments[^1];
        var open = last.IndexOf('[', StringComparison.Ordinal);
        if (open >= 0)
        {
            var list = (JsonArray)node[last[..open]]!;
            list[int.Parse(last[(open + 1)..^1], CultureInfo.InvariantCulture)] = JsonNode.Parse(json);
        }
        else if (json == "<missing>")
        {
            ((JsonObject)node).Remove(last);
        }
        else
        {
            ((JsonObject)node)[last] = JsonNode.Parse(json);
        }

        return root.ToJsonString();
    }

    private static string Snake(string body)
    {
        static string Name(string name) => string.Concat(name.Select(c => char.IsUpper(c) ? "_" + char.ToLowerInvariant(c) : c.ToString()));
        static JsonNode? Walk(JsonNode? node) => node switch
        {
            JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(Name(p.Key), Walk(p.Value)))),
            JsonArray a => new JsonArray(a.Select(Walk).ToArray()),
            null => null,
            _ => node.DeepClone(),
        };

        return Walk(JsonNode.Parse(body))!.ToJsonString();
    }
}
