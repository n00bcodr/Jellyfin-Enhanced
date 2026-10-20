using System.Globalization;
using System.Text.Json.Nodes;
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

// Track 4c2a review round 8 (D53, 8th round: the contract's "Valid" was SYNTACTIC while its consumers applied SEMANTIC rules,
// and its reach stopped at some readers, caches and addresses).
// 1. Parse once into typed facts: the contract reads every declared field with the parser its consumers use (a date, a
//    poster path, a positive id, an IMDb id), and a field the consumer can't use makes the answer Partial (never clears,
//    never kept). 4c2-R8-1: a release date "not-a-date" or a poster "https://bad.test/p.jpg" read Valid, the consumer made
//    them null, Apply CLEARED the stored value and the answer was kept.
// 2. Only complete reads are cached: 4c2-R8-2: a partial list-source read (a row without an id) was kept for 5 minutes, so
//    the corrected source wasn't asked again.
// 3. Every provider row through the contract: 4c2-R8-3: an MDBList batch row whose TMDB id is "broken-id", 0 or −7 passed,
//    and every title asked about was recorded as having no MDBList data for 3 days.
// 4. Every Seerr call honours the address list: 4c2-R8-4: list-source reads through Seerr used only the first address (A's
//    404 while B has the collection → not_found).
[Collection("Plugin singleton")]
public class ListsSourceReviewR8FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;

    // ── 1. The generated model, extended: every TYPED field × values of its JSON type that its consumer can't use ──

    // Values of the right JSON type that the field's parser refuses (a date that isn't one, a poster path that isn't a TMDB
    // image path, an id that isn't a positive integer, a count below zero, an IMDb id that isn't one).
    private static readonly Dictionary<string, string[]> SemanticValues = new()
    {
        ["date"] = new[] { "\"not-a-date\"", "\"2013-13-45\"", "\"12/06/2013\"", "\"2013-06-12junk\"" },
        ["poster"] = new[] { "\"https://bad.test/p.jpg\"", "\"p.jpg\"", "\"/../p.jpg\"", "\"/p.gif\"" },
        ["id"] = new[] { "-7", "2.5", "4294967296" },
        ["count"] = new[] { "-1", "2.5" },
        ["imdb"] = new[] { "\"nm0770828\"", "\"tt12\"" },
    };

    // THE ORACLE for a typed field holding a value its parser refuses, by the field's role: a required field (the resource
    // itself; a row key) → M; an identity id → M (a wrong id is never "proven absent"); a fact a consumer derives from → P
    // (unknown: used for the rest, never kept, never clears); a display field → P (the value is dropped). A row JE can't read
    // makes a search Partial (other titles are used). Placeholder metadata of a season and the TMDB poster read use a
    // non-Valid answer like a failed read (the r7 model's convention: "M").
    private static readonly Dictionary<string, (string Path, string Type, char Expected)[]> TypedFields = new()
    {
        ["tmdb details movie"] = new[]
        {
            ("id", "id", 'M'), ("release_date", "date", 'P'), ("poster_path", "poster", 'P'), ("vote_count", "count", 'P'),
            ("imdb_id", "imdb", 'M'), ("external_ids.imdb_id", "imdb", 'M'),
        },
        ["tmdb details tv"] = new[]
        {
            ("id", "id", 'M'), ("first_air_date", "date", 'P'), ("poster_path", "poster", 'P'), ("vote_count", "count", 'P'),
            ("external_ids.imdb_id", "imdb", 'M'), ("external_ids.tvdb_id", "id", 'M'), ("seasons[0].season_number", "count", 'M'),
            ("seasons[0].episode_count", "count", 'P'), ("seasons[0].air_date", "date", 'P'),
        },
        ["tmdb season"] = new[] { ("episodes[0].episode_number", "count", 'M'), ("episodes[0].season_number", "count", 'P'), ("episodes[0].air_date", "date", 'P') },
        ["tmdb episode find"] = new[]
        {
            ("tv_episode_results[0].show_id", "id", 'M'), ("tv_episode_results[0].season_number", "count", 'M'),
            ("tv_episode_results[0].episode_number", "count", 'M'), ("tv_episode_results[0].air_date", "date", 'P'),
        },
        ["tmdb multi search"] = new[]
        {
            ("results[0].id", "id", 'P'), ("results[0].release_date", "date", 'P'), ("results[0].poster_path", "poster", 'P'), ("results[0].vote_count", "count", 'P'),
        },
        ["tmdb find"] = new[] { ("movie_results[0].id", "id", 'P'), ("movie_results[0].release_date", "date", 'P') },
        ["seerr details movie"] = new[]
        {
            ("id", "id", 'M'), ("releaseDate", "date", 'P'), ("posterPath", "poster", 'P'), ("voteCount", "count", 'P'),
            ("imdbId", "imdb", 'M'), ("externalIds.imdbId", "imdb", 'M'),
        },
        ["seerr details tv"] = new[]
        {
            ("id", "id", 'M'), ("firstAirDate", "date", 'P'), ("posterPath", "poster", 'P'), ("externalIds.imdbId", "imdb", 'M'),
            ("externalIds.tvdbId", "id", 'M'), ("seasons[0].seasonNumber", "count", 'M'), ("seasons[0].episodeCount", "count", 'P'), ("seasons[0].airDate", "date", 'P'),
        },
        ["seerr season"] = new[] { ("episodes[0].episodeNumber", "count", 'M'), ("episodes[0].airDate", "date", 'P') },
        ["seerr search"] = new[] { ("results[0].id", "id", 'P'), ("results[0].releaseDate", "date", 'P'), ("results[0].posterPath", "poster", 'P') },
        ["seerr metadata movie"] = new[]
        {
            ("id", "id", 'M'), ("releaseDate", "date", 'P'), ("posterPath", "poster", 'P'), ("imdbId", "imdb", 'M'), ("externalIds.imdbId", "imdb", 'M'),
        },
        ["seerr metadata series"] = new[]
        {
            ("id", "id", 'M'), ("firstAirDate", "date", 'P'), ("posterPath", "poster", 'P'), ("externalIds.imdbId", "imdb", 'M'), ("externalIds.tvdbId", "id", 'M'),
            ("seasons[0].seasonNumber", "count", 'M'), ("seasons[0].episodeCount", "count", 'P'), ("seasons[0].airDate", "date", 'P'),
            ("lastEpisodeToAir.seasonNumber", "count", 'M'), ("lastEpisodeToAir.episodeNumber", "count", 'M'), ("lastEpisodeToAir.airDate", "date", 'P'),
        },
        ["seerr metadata season"] = new[]
        {
            ("episodes[0].episodeNumber", "count", 'M'), ("episodes[0].airDate", "date", 'M'), ("airDate", "date", 'M'), ("posterPath", "poster", 'M'),
        },
        ["tmdb metadata movie"] = new[] { ("release_date", "date", 'P'), ("poster_path", "poster", 'P'), ("imdb_id", "imdb", 'M') },
        ["tmdb metadata series"] = new[]
        {
            ("first_air_date", "date", 'P'), ("poster_path", "poster", 'P'), ("seasons[0].episode_count", "count", 'P'), ("last_episode_to_air.air_date", "date", 'P'),
        },
        ["tmdb metadata season"] = new[] { ("episodes[0].air_date", "date", 'M'), ("poster_path", "poster", 'M') },
        ["tmdb poster"] = new[] { ("poster_path", "poster", 'M') },
    };

    public static IEnumerable<object[]> SemanticCells() =>
        from kind in TypedFields.Keys
        from field in TypedFields[kind]
        from value in SemanticValues[field.Type]
        select new object[] { kind, field.Path, value };

    [Theory]
    [MemberData(nameof(SemanticCells))]
    public async Task AFieldItsConsumerCantUseIsNeverValid(string kindName, string path, string value)
    {
        var kind = R7.Kinds.Single(k => k.Name == kindName);
        var expected = TypedFields[kindName].Single(f => f.Path == path).Expected;
        using var w = new World();
        var body = Set(kind.Body, path, value);
        var seen = await kind.Read(w, body);
        output.WriteLine(kindName + " | " + path + " = " + value + " → expected " + expected + ", saw " + seen + "\n" + body);

        if (expected == 'P')
        {
            Assert.True(seen.Used, "partial: still used");
            Assert.False(seen.Kept, "partial: never kept");
            Assert.False(seen.Cleared, "partial: never clears a value the entry has");
        }
        else
        {
            Assert.False(seen.Used, "malformed: not used");
            Assert.False(seen.Kept, "malformed: never kept");
            Assert.False(seen.Cleared, "malformed: never clears a value the entry has");
        }
    }

    // Controls: a date the parser accepts (a plain date, or one with a time part, read as its date) is used and kept, and
    // "" (TMDB's and Seerr's "no date yet") is a proven answer that does set the entry's date to none.
    [Theory]
    [InlineData("seerr metadata movie", "releaseDate", "\"2010-07-16\"", "2010-07-16")]
    [InlineData("seerr metadata movie", "releaseDate", "\"2010-07-16T00:00:00.000Z\"", "2010-07-16")]
    [InlineData("seerr metadata movie", "releaseDate", "\"\"", null)]
    public async Task AValidTypedFieldIsUsedAndKept(string kindName, string path, string value, string? release)
    {
        var kind = R7.Kinds.Single(k => k.Name == kindName);
        using var w = new World();
        var seen = await kind.Read(w, Set(kind.Body, path, value));
        Assert.True(seen.Used && seen.Kept, "valid: used and kept (" + seen + ")");

        var entry = R7.Prefilled(PlaceholderKinds.Movie);
        w.Answer(R7.SeerrA + "movie/10", Set(kind.Body, path, value));
        var metadata = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).FetchAsync(entry, TimeSpan.FromHours(12), new DateTime(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc), None);
        ListMetadataService.Apply(entry, metadata!);
        Assert.Equal(release, entry.ReleaseDate);
    }

    // The list-row model, extended: a row key of the right JSON type that isn't a usable id (0, negative, fractional; an
    // IMDb key that isn't a title id) never stands for a title and the snapshot is never complete; a display date that
    // isn't one only loses its year.
    private static readonly Dictionary<string, (string Path, string[] Values, string Role)[]> RowTypedFields = new()
    {
        ["tmdb list"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required"), ("release_date", new[] { "\"not-a-date\"" }, "display") },
        ["tmdb trending"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required"), ("release_date", new[] { "\"not-a-date\"" }, "display") },
        ["tmdb collection"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required"), ("release_date", new[] { "\"not-a-date\"" }, "display") },
        ["seerr trending"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required"), ("releaseDate", new[] { "\"not-a-date\"" }, "display") },
        ["seerr collection"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required"), ("releaseDate", new[] { "\"not-a-date\"" }, "display") },
        ["trakt list"] = new[] { ("movie.ids.tmdb", new[] { "0", "-7", "2.5" }, "required") },
        ["trakt chart"] = new[] { ("movie.ids.tmdb", new[] { "0", "-7", "2.5" }, "required") },
        ["trakt box office"] = new[] { ("movie.ids.tmdb", new[] { "0", "-7", "2.5" }, "required") },
        ["imdb list"] = new[] { ("node.item.id", new[] { "\"nm0000001\"", "\"tt12\"" }, "required") },
        ["imdb chart"] = new[] { ("node.item.id", new[] { "\"nm0000001\"", "\"tt12\"" }, "required") },
        ["mdblist public"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required") },
        ["mdblist official"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required") },
        ["mdblist api"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required") },
        ["chronolists"] = new[] { ("id", new[] { "0", "-7", "2.5" }, "required"), ("rd", new[] { "\"not-a-date\"" }, "display") },
    };

    public static IEnumerable<object[]> RowSemanticCells() =>
        from provider in RowTypedFields.Keys
        from field in RowTypedFields[provider]
        from value in field.Values
        select new object[] { provider, field.Path, value };

    [Theory]
    [MemberData(nameof(RowSemanticCells))]
    public async Task AListRowKeyItsReaderCantUseIsNeverAKey(string provider, string path, string value)
    {
        var shape = ListsSourceReviewR3FixTests.Shapes().Single(s => s.Provider == provider);
        var role = RowTypedFields[provider].Single(f => f.Path == path).Role;
        var rows = new[] { Set(shape.Valid(1), path, value), shape.Valid(2), shape.Valid(3) };
        using var net = new Net();
        var (url, options) = shape.Arrange(net, rows);

        var result = await net.Fetch(url, options);
        output.WriteLine(provider + " | " + path + " = " + value + ": ok " + result.Ok + ", complete " + IsComplete(result) + ", items " + result.Items?.Count + "\n" + rows[0]);

        Assert.True(result.Ok, result.ErrorCode);
        if (role == "required")
        {
            Assert.False(IsComplete(result), "a row without a usable key: never a complete snapshot");
            Assert.DoesNotContain(result.Items, i => i.TmdbId is 1 or 0 or -7 || i.ImdbId is "tt1000001" or "tt12" or "nm0000001");
        }
        else
        {
            Assert.True(IsComplete(result), "a row's display field never decides completeness");
        }
    }

    // ── 2. Only complete reads are cached (4c2-R8-2) ──

    private static SourceFetchOptions Cached(SourceFetchOptions? options) => new()
    {
        AllowMdblistApi = options?.AllowMdblistApi ?? false,
        Provider = options?.Provider,
        Fresh = false,
    };

    public static IEnumerable<object[]> Providers() => ListsSourceReviewR3FixTests.Shapes().Select(s => new object[] { s.Provider });

    [Theory]
    [MemberData(nameof(Providers))]
    public async Task APartialListReadIsNeverKeptSoTheCorrectedSourceIsReadAgain(string provider)
    {
        var shape = ListsSourceReviewR3FixTests.Shapes().Single(s => s.Provider == provider);
        using var net = new Net();
        var (url, options) = shape.Arrange(net, new[] { shape.Malformed, shape.Valid(2), shape.Valid(3) });
        var first = await net.Fetch(url, Cached(options));
        Assert.True(first.Ok, first.ErrorCode);
        Assert.False(IsComplete(first), "the arranged read is partial");

        // The source is corrected; an ordinary (not fresh) read follows within the cache's lifetime.
        shape.Arrange(net, new[] { shape.Valid(1), shape.Valid(2), shape.Valid(3) });
        var sent = net.Requests.Count;
        var second = await net.Fetch(url, Cached(options));
        output.WriteLine(provider + ": first complete " + IsComplete(first) + ", second complete " + IsComplete(second) + ", requests " + (net.Requests.Count - sent));

        Assert.True(net.Requests.Count > sent, "a partial read was answered from the cache: the corrected source was never asked");
        Assert.True(IsComplete(second));
        Assert.Contains(second.Items, i => i.TmdbId == 1 || i.ImdbId == "tt1000001");
    }

    [Theory]
    [MemberData(nameof(Providers))]
    public async Task ACompleteListReadIsKept(string provider)
    {
        var shape = ListsSourceReviewR3FixTests.Shapes().Single(s => s.Provider == provider);
        using var net = new Net();
        var (url, options) = shape.Arrange(net, new[] { shape.Valid(1), shape.Valid(2), shape.Valid(3) });
        Assert.True(IsComplete(await net.Fetch(url, Cached(options))));
        var sent = net.Requests.Count;
        var second = await net.Fetch(url, Cached(options));
        Assert.Equal(sent, net.Requests.Count); // control: a complete read is kept (preview → apply → link reads once)
        Assert.True(IsComplete(second));
    }

    [Fact]
    public async Task ATruncatedListReadIsNeverKept()
    {
        using var net = new Net();
        net.Config.TMDB_API_KEY = "tmdb-key";
        var parts = string.Join(',', Enumerable.Range(1, ListSourceFetcher.MaxItems + 1).Select(i => "{\"id\":" + i + ",\"media_type\":\"movie\",\"title\":\"M" + i + "\"}"));
        net.Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{\"name\":\"C\",\"parts\":[" + parts + "]}");
        var first = await net.Fetch("https://www.themoviedb.org/collection/10", Cached(null));
        Assert.True(first.Ok && first.Truncated, "arranged: more than the cap");
        var sent = net.Requests.Count;
        await net.Fetch("https://www.themoviedb.org/collection/10", Cached(null));
        Assert.True(net.Requests.Count > sent, "a truncated read was kept");
    }

    // ── 3. Every MDBList batch row through the row contract (4c2-R8-3) ──

    [Theory]
    [InlineData("\"broken-id\"")]
    [InlineData("0")]
    [InlineData("-7")]
    [InlineData("2.5")]
    [InlineData("4294967296")]
    [InlineData("null")]
    [InlineData("\"\"")]
    [InlineData("\"-7\"")]
    [InlineData("true")]
    [InlineData("{}")]
    public async Task AnMdblistBatchRowWithoutAUsableTmdbIdFailsTheBatchAndRecordsNoMiss(string tmdb)
    {
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[{\"ids\":{\"tmdb\":42},\"ratings\":[]},{\"ids\":{\"tmdb\":" + tmdb + ",\"imdb\":\"tt0000001\"},\"ratings\":[]}]");

        var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42", "43" }, None);
        output.WriteLine(tmdb + ": " + (batch == null ? "failed" : string.Join(',', batch.Keys) + " matched"));

        Assert.Null(batch); // the chunk is asked again next run
        Assert.Null(net.Quota.GetCachedEntry("movie", "42"));
        Assert.Null(net.Quota.GetCachedEntry("movie", "43"));
    }

    [Theory]
    [InlineData("43", "43")]
    [InlineData("\"43\"", "43")]
    public async Task AnMdblistBatchRowWithAPositiveTmdbIdIsUsed(string tmdb, string key)
    {
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json("[{\"ids\":{\"tmdb\":42},\"ratings\":[]},{\"ids\":{\"tmdb\":" + tmdb + "},\"ratings\":[]}]");
        var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42", "43", "44" }, None);
        Assert.NotNull(batch);
        Assert.Equal(new[] { "42", key }, batch!.Keys.OrderBy(k => k, StringComparer.Ordinal));
        net.Quota.MergeMediaBatchIntoCache("movie", new[] { "42", "43", "44" }, batch);
        Assert.True(net.Quota.GetCachedEntry("movie", "44")!.Confirmed); // control: a whole answer without 44 does say "no data"
    }

    // The sweep (rule 2): the other MDBList records. A single title's ratings answer is kept (7 days found, 3 days "no data")
    // only when it is that title's (its ids.tmdb, by the same row contract) or MDBList's explicit "no match"; anything else
    // is a failed lookup (retried after the short retry time, never confirmed).
    [Theory]
    [InlineData("{}", false)]
    [InlineData("{\"ratings\":[{\"source\":\"imdb\",\"value\":7.1}]}", false)]
    [InlineData("{\"ids\":{\"tmdb\":99},\"ratings\":[]}", false)]
    [InlineData("{\"ids\":{\"tmdb\":\"broken-id\"},\"ratings\":[]}", false)]
    [InlineData("[]", false)]
    [InlineData("{\"response\":false,\"error\":\"Not found\"}", true)]
    [InlineData("{\"ids\":{\"tmdb\":42,\"imdb\":\"tt0000042\"},\"ratings\":[]}", true)]
    public async Task AnMdblistRatingsAnswerIsKeptOnlyWhenItIsTheTitlesOwn(string answer, bool kept)
    {
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/tmdb/movie/42"] = _ => Json(answer);
        var entry = await net.Quota.GetRatingsAsync("movie", "42", None);
        output.WriteLine(answer + ": found " + entry.Found + ", confirmed " + entry.Confirmed);
        Assert.Equal(kept, entry.Confirmed);
        if (!kept)
        {
            Assert.False(entry.Found);
        }
    }

    // The quota's balance (held 3 minutes) is held only when MDBList's /user answer carries its counts; otherwise it is
    // unknown (read again next time; an unknown balance fails open as it always has), never a balance of 0.
    [Theory]
    [InlineData("{}")]
    [InlineData("{\"plan\":\"free\",\"rate_limit\":1000}")]
    [InlineData("{\"plan\":\"free\",\"rate_limit\":1000,\"rate_limit_remaining\":\"x\"}")]
    [InlineData("{\"plan\":\"free\",\"rate_limit\":1000,\"rate_limit_remaining\":-5}")]
    public async Task AnMdblistBalanceWithoutItsCountsIsNeverHeld(string answer)
    {
        using var net = MdblistApiNet(() => 900);
        var first = true;
        net.Routes["https://api.mdblist.com/user"] = _ =>
        {
            var body = first ? answer : Status(900);
            first = false;
            return Json(body);
        };

        Assert.Null(await net.Quota.GetAccountStatusAsync(None));
        Assert.Null(net.Quota.RemainingQuota());
        Assert.Equal(900, (await net.Quota.GetAccountStatusAsync(None))!.RateLimitRemaining);
        Assert.Equal(2, net.Sent("https://api.mdblist.com/user"));
    }

    // ── 4. Every Seerr call honours the address list (4c2-R8-4) ──

    private const string A = "http://seerr-a.test/api/v1/";
    private const string B = "http://seerr-b.test/api/v1/";

    private static Net SeerrPair(MetadataCallLimiter? limiter = null, string urls = "http://seerr-a.test\nhttp://seerr-b.test")
    {
        var net = new Net(limiter: limiter);
        net.Config.TMDB_API_KEY = string.Empty;
        net.Config.JellyseerrEnabled = true;
        net.Config.JellyseerrUrls = urls;
        net.Config.JellyseerrApiKey = "seerr-key";
        return net;
    }

    private static string Parts(params int[] ids) => "{\"name\":\"C\",\"parts\":[" + string.Join(',', ids.Select(i => "{\"id\":" + i + ",\"mediaType\":\"movie\",\"title\":\"M" + i + "\",\"releaseDate\":\"2001-01-01\"}")) + "]}";

    private static string TrendingPage(int page, int pages, params int[] ids) =>
        "{\"page\":" + page + ",\"totalPages\":" + pages + ",\"totalResults\":" + (pages * ids.Length) + ",\"results\":["
        + string.Join(',', ids.Select(i => "{\"id\":" + i + ",\"mediaType\":\"movie\",\"title\":\"M" + i + "\",\"releaseDate\":\"2001-01-01\"}")) + "]}";

    private static Func<HttpRequestMessage, HttpResponseMessage> Answer(string a) => a switch
    {
        "404" => _ => Json("{\"message\":\"Not Found\"}", 404),
        "500" => _ => Json("{\"message\":\"Unable to retrieve collection.\"}", 500),
        "503" => _ => Json("{\"message\":\"down\"}", 503),
        "refused" => _ => throw new HttpRequestException("connection refused"),
        "redirect" => _ => new HttpResponseMessage(System.Net.HttpStatusCode.Found) { Headers = { Location = new Uri("http://elsewhere.test/") } },
        "{}" => _ => Json("{}"),
        _ => _ => Json(a),
    };

    [Theory]
    [InlineData("404")]
    [InlineData("500")]
    [InlineData("503")]
    [InlineData("refused")]
    [InlineData("redirect")]
    [InlineData("{}")]
    public async Task ASeerrCollectionTheFirstAddressLacksIsReadFromTheNext(string a)
    {
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        using var net = SeerrPair(limiter);
        net.Routes[A + "collection/10"] = Answer(a);
        net.Routes[B + "collection/10"] = _ => Json(Parts(1, 2, 3));

        var result = await net.Fetch("https://www.themoviedb.org/collection/10");
        output.WriteLine("A " + a + ": ok " + result.Ok + " " + result.ErrorCode + ", provider " + result.Provider + ", items " + result.Items.Count + ", sent A " + net.Sent(A) + " B " + net.Sent(B));

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal("seerr", result.Provider);
        Assert.Equal(new[] { 1, 2, 3 }, result.Items.Select(i => i.TmdbId ?? 0));
        Assert.True(IsComplete(result));
        Assert.Equal(1, net.Sent(B));
        Assert.Equal(2, net.Admission.Admitted.Count(p => p == "seerr")); // each address's request: its own admission
        Assert.Equal(2, limiter.Stats().Total); // … and its own turn at the shared metadata limiter
    }

    [Theory]
    [InlineData("404", "404", "not_found")]
    [InlineData("404", "500", "not_found")]
    [InlineData("404", "503", "upstream_error")]
    [InlineData("404", "refused", "upstream_error")]
    [InlineData("503", "404", "upstream_error")]
    public async Task ASeerrCollectionIsNotFoundOnlyWhenEveryAddressSaysSo(string a, string b, string code)
    {
        using var net = SeerrPair();
        net.Routes[A + "collection/10"] = Answer(a);
        net.Routes[B + "collection/10"] = Answer(b);
        var result = await net.Fetch("https://www.themoviedb.org/collection/10");
        output.WriteLine(a + "/" + b + ": " + result.ErrorCode + ", sent A " + net.Sent(A) + " B " + net.Sent(B));
        Assert.False(result.Ok);
        Assert.Equal(1, net.Sent(B)); // B is always asked when A doesn't answer with the collection
        Assert.Equal(code, result.ErrorCode);
    }

    [Theory]
    [InlineData("503", false)]
    [InlineData("refused", false)]
    [InlineData("page 2 fails", true)]
    public async Task ASeerrChartTheFirstAddressCantServeIsReadWholeFromTheNext(string a, bool firstPageServed)
    {
        using var net = SeerrPair();
        net.Routes[A + "discover/trending"] = a == "page 2 fails"
            ? request => Page(request) == 1 ? Json(TrendingPage(1, 2, 1, 2)) : Json("{\"message\":\"down\"}", 503)
            : Answer(a);
        net.Routes[B + "discover/trending"] = request => Json(Page(request) == 1 ? TrendingPage(1, 2, 11, 12) : TrendingPage(2, 2, 13, 14));

        var result = await net.Fetch("https://www.themoviedb.org/trending/all/week");
        output.WriteLine("A " + a + ": ok " + result.Ok + " " + result.ErrorCode + ", items " + string.Join(',', result.Items.Select(i => i.TmdbId)) + ", complete " + IsComplete(result));

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal(new[] { 11, 12, 13, 14 }, result.Items.Select(i => i.TmdbId ?? 0)); // one server's chart, never a mix
        Assert.True(IsComplete(result));
        Assert.Equal(firstPageServed, net.Sent(A) >= 2);
    }

    // The fetcher's cache identity is the whole address list: a result read through one set of addresses is never reused
    // for another.
    [Fact]
    public async Task ASeerrListReadIsKeptPerAddressList()
    {
        using var net = SeerrPair();
        net.Routes[A + "collection/10"] = Answer("503");
        net.Routes[B + "collection/10"] = _ => Json(Parts(1, 2));
        net.Routes["http://seerr-c.test/api/v1/collection/10"] = _ => Json(Parts(7, 8, 9));
        var first = await net.Fetch("https://www.themoviedb.org/collection/10", Cached(null));
        Assert.True(first.Ok, first.ErrorCode);

        net.Config.JellyseerrUrls = "http://seerr-a.test\nhttp://seerr-c.test";
        var second = await net.Fetch("https://www.themoviedb.org/collection/10", Cached(null));
        Assert.True(second.Ok, second.ErrorCode);
        Assert.Equal(new[] { 7, 8, 9 }, second.Items.Select(i => i.TmdbId ?? 0));
    }

    // The sweep: every Seerr-backed read of the lists area takes the same address list (blank lines, spaces and a trailing
    // slash included) in order, and reaches the second address when the first lacks the resource.
    public static IEnumerable<object[]> SeerrPaths() => new[]
    {
        "lookup details", "lookup season", "lookup search", "metadata movie", "metadata series", "metadata season",
        "list collection", "list trending",
    }.Select(p => new object[] { p });

    [Theory]
    [MemberData(nameof(SeerrPaths))]
    public async Task EverySeerrReadOfTheListsAreaHonoursTheAddressList(string path)
    {
        const string Urls = "  http://seerr-a.test/  \n\n http://seerr-b.test \r\n";
        if (path.StartsWith("list", StringComparison.Ordinal))
        {
            using var net = SeerrPair(urls: Urls);
            net.Routes[A + "collection/10"] = Answer("404");
            net.Routes[A + "discover/trending"] = Answer("404");
            net.Routes[B + "collection/10"] = _ => Json(Parts(1, 2));
            net.Routes[B + "discover/trending"] = _ => Json(TrendingPage(1, 1, 1, 2));
            var result = await net.Fetch(path == "list collection" ? "https://www.themoviedb.org/collection/10" : "https://www.themoviedb.org/trending/all/week");
            output.WriteLine(path + ": " + result.Ok + " " + result.ErrorCode);
            Assert.True(result.Ok, result.ErrorCode);
            Assert.Equal(new[] { 1, 2 }, result.Items.Select(i => i.TmdbId ?? 0));
            return;
        }

        using var w = new World();
        w.Plugin.Plugin.Configuration.JellyseerrUrls = Urls;
        var (at, body) = path switch
        {
            "lookup details" => ("tv/1412", R7.Camel(R7.ShowBody)),
            "lookup season" => ("tv/1412/season/1", R7.Camel(R7.SeasonBody)),
            "lookup search" => ("search", R7.Camel(R7.MultiBody)),
            "metadata movie" => ("movie/10", R7.MetaMovieBody),
            "metadata series" => ("tv/1412", R7.MetaShowBody),
            _ => ("tv/1412/season/1", R7.MetaSeasonBody),
        };
        w.Answer(R7.SeerrA + at, "{\"message\":\"Not Found\"}", 404);
        w.Answer(R7.SeerrB + at, body);
        if (path == "metadata season")
        {
            w.Answer(R7.SeerrA + "tv/1412", R7.MetaShowBody);
        }

        object? read = path switch
        {
            "lookup details" => (await w.SeerrLookup.GetDetailsAsync("tv", 1412, w.Context, None)).Value?.Seasons.Count,
            "lookup season" => (await w.SeerrLookup.GetSeasonAsync(1412, 1, w.Context, None)).Value?.Count,
            "lookup search" => (await w.SeerrLookup.SearchAsync("Man of Steel", w.Context, None)).Value?.Count,
            _ => await Metadata(w, path),
        };
        output.WriteLine(path + ": " + read);
        Assert.Equal(path switch
        {
            "lookup details" => (object)2,
            "lookup season" => 2,
            "lookup search" => 2,
            "metadata movie" => "2010-07-16",
            "metadata series" => 3,
            _ => 2,
        }, read);
    }

    private static async Task<object?> Metadata(World w, string path)
    {
        var entry = R7.Prefilled(path == "metadata movie" ? PlaceholderKinds.Movie : path == "metadata series" ? PlaceholderKinds.Series : PlaceholderKinds.Season);
        var metadata = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).FetchAsync(entry, TimeSpan.FromHours(12), new DateTime(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc), None);
        return path == "metadata movie" ? metadata?.ReleaseDate : metadata?.Expected?.Count;
    }

    // ── JSON helper: one field set to a raw JSON value ──

    private static string Set(string body, string path, string json)
    {
        var root = JsonNode.Parse(body)!;
        var segments = path.Split('.');
        JsonNode node = root;
        foreach (var segment in segments[..^1])
        {
            node = R7.Step(node, segment)!;
        }

        ((JsonObject)node)[segments[^1]] = JsonNode.Parse(json);
        return root.ToJsonString();
    }
}
