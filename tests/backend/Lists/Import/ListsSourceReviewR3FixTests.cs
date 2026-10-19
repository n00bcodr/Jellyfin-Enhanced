using System.Globalization;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using static JE.Tests.ListsImportReviewR2FixTests;

namespace JE.Tests;

// Track 4c2a review round 3 (server, the fetcher), D53 rules 1 and 3 moved to the level their invariants live at.
// Rule 1: a read is Complete only when the provider's positive end holds AND every announced row is represented by exactly
// one distinct usable key or a counted exclusion (a deliberately unsupported type): a malformed row or a repeated row or
// cursor is never complete (4c2-R3-4: a malformed row dropped by parsing let raw counts satisfy completeness; 4c2-R3-5: an
// IMDb page repeating a row). Rule 3: the gate is the last step before bytes leave (every wait first, then the final
// check of the switch and credentials, then the send) and it bounds what comes back (4c2-R3-1: a Seerr read queued behind
// the metadata limiter was sent after Seerr was turned off; 4c2-R3-3: the Seerr fallback buffered a 16 MiB answer;
// 4c2-R3-2: two concurrent quota refreshes overwrote each other's consumption).
[Collection("Plugin singleton")]
public class ListsSourceReviewR3FixTests
{
    private const int Cap = 8 * 1024 * 1024;

    internal static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 500 && !condition(); i++)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), "timed out");
    }

    private static void SeerrOnly(Net net)
    {
        net.Config.TMDB_API_KEY = string.Empty;
        net.Config.JellyseerrEnabled = true;
        net.Config.JellyseerrUrls = "http://seerr.test";
        net.Config.JellyseerrApiKey = "seerr-key";
    }

    // ── Rule 3: the final check is the last step before the send ───────

    [Theory]
    [InlineData("switch off")]
    [InlineData("key cleared")]
    [InlineData("key changed")]
    [InlineData("address changed")]
    public async Task AQueuedSeerrReadIsNeverSentWhenSeerrChangesWhileItWaits(string change)
    {
        var limiter = new MetadataCallLimiter(1, TimeSpan.Zero, TimeProvider.System);
        using var net = new Net(limiter: limiter);
        SeerrOnly(net);
        net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Json("{\"name\":\"C\",\"parts\":[" + Rows(SeerrRowOf, 1, 2) + "]}");
        net.Routes["http://other.test/api/v1/collection/10"] = net.Routes["http://seerr.test/api/v1/collection/10"];
        var held = await limiter.AcquireAsync("someone else", false, CancellationToken.None);

        var fetch = Task.Run(() => net.Fetch("https://www.themoviedb.org/collection/10"));
        await WaitUntil(() => { lock (net.Admission.Admitted) { return net.Admission.Admitted.Contains("seerr"); } });
        await Task.Delay(150); // queued behind the limiter
        switch (change)
        {
            case "switch off": net.Config.ArrPhase4ListTmdbEnabled = false; break;
            case "key cleared": net.Config.JellyseerrApiKey = string.Empty; break;
            case "key changed": net.Config.JellyseerrApiKey = "another-key"; break;
            default: net.Config.JellyseerrUrls = "http://other.test"; break;
        }

        held.Dispose();
        var result = await fetch;

        Assert.False(result.Ok, change + ": the queued read was sent");
        Assert.Equal(SourceFailures.ProviderDisabled, result.ErrorCode);
        Assert.Empty(net.Requests);
    }

    private static string SeerrRowOf(int id) => "{\"id\":" + id + ",\"mediaType\":\"movie\",\"title\":\"M" + id + "\",\"releaseDate\":\"2001-01-01\"}";

    // ── Rule 3: the gate bounds what comes back ─────────────────────────

    /// <summary>A body of a given size served lazily (no length unless asked for), counting the bytes read from it.</summary>
    private sealed class BigBody(string head, long size, string tail) : Stream
    {
        private readonly byte[] _head = Encoding.UTF8.GetBytes(head);
        private readonly byte[] _tail = Encoding.UTF8.GetBytes(tail);
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
                buffer[offset + n] = p < _head.Length ? _head[p] : p >= size - _tail.Length ? _tail[p - (size - _tail.Length)] : (byte)'a';
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
    }

    private static HttpResponseMessage Big(BigBody body, bool withLength, long size)
    {
        var content = new StreamContent(body);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        if (withLength)
        {
            content.Headers.ContentLength = size;
        }

        return new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = content };
    }

    public static IEnumerable<object[]> BigAnswers() =>
        from provider in new[] { "seerr", "tmdb", "trakt", "imdb", "mdblist", "mdblist-api", "mdblist-status", "chronolists" }
        from withLength in new[] { false, true }
        select new object[] { provider, withLength };

    [Theory]
    [MemberData(nameof(BigAnswers))]
    public async Task AnAnswerOverTheCapIsTooLargeAndIsNotReadFurther(string provider, bool withLength)
    {
        const long Size = 16L * 1024 * 1024;
        using var net = new Net();
        net.Config.TMDB_API_KEY = "tmdb-key";
        net.Config.ArrListTraktApiKey = "trakt-client";
        net.Config.MdblistApiKey = "mdb-key";
        net.Config.ArrPhase4ListMdblistApiEnabled = true;
        var api = new SourceFetchOptions { AllowMdblistApi = true, Fresh = true };
        net.Routes["https://api.mdblist.com/user"] = _ => Json("{\"rate_limit\":1000,\"rate_limit_remaining\":900}");
        var (route, url, options, head, tail) = provider switch
        {
            "seerr" => ("http://seerr.test/api/v1/collection/10", "https://www.themoviedb.org/collection/10", (SourceFetchOptions?)null, "{\"name\":\"C\",\"parts\":[" + SeerrRowOf(1) + "],\"pad\":\"", "\"}"),
            "tmdb" => ("https://api.themoviedb.org/3/collection/10", "https://www.themoviedb.org/collection/10", null, "{\"name\":\"C\",\"parts\":[" + SeerrRowOf(1) + "],\"pad\":\"", "\"}"),
            "trakt" => ("https://api.trakt.tv/movies/boxoffice", "https://trakt.tv/movies/boxoffice", null, "[{\"pad\":\"", "\"}]"),
            "imdb" => ("https://api.graphql.imdb.com/", "https://www.imdb.com/list/ls000000301/", null, "{\"pad\":\"", "\"}"),
            "mdblist" => ("https://mdblist.com/lists/me/mine/json", "https://mdblist.com/lists/me/mine", null, "[{\"pad\":\"", "\"}]"),
            "mdblist-api" => ("https://api.mdblist.com/lists/me/mine/items", "https://mdblist.com/lists/me/mine", api, "{\"items\":[],\"pad\":\"", "\"}"),
            "mdblist-status" => ("https://api.mdblist.com/user", "https://mdblist.com/lists/me/mine", api, "{\"rate_limit\":1000,\"rate_limit_remaining\":900,\"pad\":\"", "\"}"),
            _ => ("https://chronolists.com/mcu", "https://chronolists.com/mcu", null, "<html><body>", "</body></html>"),
        };
        if (provider == "seerr")
        {
            SeerrOnly(net);
        }

        var body = new BigBody(head, Size, tail);
        net.Routes[route] = _ => Big(body, withLength, Size);

        var result = await net.Fetch(url, options);

        Assert.False(result.Ok, provider + ": a 16 MiB answer was accepted");
        Assert.Equal("too_large", result.ErrorCode);
        Assert.True(body.Served <= Cap + (256 * 1024), provider + ": read " + body.Served.ToString(CultureInfo.InvariantCulture) + " bytes of a 16 MiB answer");
    }

    // ── Rule 3: the quota reserves against the current balance ─────────

    internal static Net MdblistApiNet(Func<int> remaining)
    {
        var net = new Net();
        net.Config.MdblistApiKey = "mdb-key";
        net.Config.ArrPhase4ListMdblistApiEnabled = true;
        net.Routes["https://api.mdblist.com/user"] = _ => Json(Status(remaining()));
        foreach (var list in new[] { "a", "b", "c", "d" })
        {
            net.Routes["https://api.mdblist.com/lists/me/" + list + "/items"] = _ => Json("{\"items\":[{\"ids\":{\"tmdb\":10193},\"title\":\"Toy Story 3\",\"mediatype\":\"movie\"}],\"pagination\":{\"has_more\":false}}");
        }

        return net;
    }

    internal static string Status(int remaining) => "{\"plan\":\"free\",\"rate_limit\":1000,\"rate_limit_remaining\":" + remaining.ToString(CultureInfo.InvariantCulture) + ",\"rate_limit_reset\":0}";

    internal static readonly SourceFetchOptions ApiRead = new() { AllowMdblistApi = true, Fresh = true };

    [Fact]
    public async Task TwoConcurrentQuotaRefreshesNeverSpendBelowTheSafetyMargin()
    {
        var reads = 0;
        using var net = MdblistApiNet(() => MdblistService.SafetyMargin + 1 - Volatile.Read(ref reads));
        var arrived = 0;
        using var both = new ManualResetEventSlim();
        var status = net.Routes["https://api.mdblist.com/user"];
        net.Routes["https://api.mdblist.com/user"] = r =>
        {
            if (Interlocked.Increment(ref arrived) >= 2)
            {
                both.Set();
            }

            both.Wait(TimeSpan.FromSeconds(2)); // both refreshes in flight at once, when two are made
            return status(r);
        };
        foreach (var list in new[] { "a", "b" })
        {
            var answer = net.Routes["https://api.mdblist.com/lists/me/" + list + "/items"];
            net.Routes["https://api.mdblist.com/lists/me/" + list + "/items"] = r => { Interlocked.Increment(ref reads); return answer(r); };
        }

        var results = await Task.WhenAll(
            Task.Run(() => net.Fetch("https://mdblist.com/lists/me/a", ApiRead)),
            Task.Run(() => net.Fetch("https://mdblist.com/lists/me/b", ApiRead)));

        Assert.Equal(1, net.Sent("https://api.mdblist.com/lists/")); // 6 remaining, margin 5: one list read
        Assert.Single(results, r => r.Ok);
        Assert.Single(results, r => r.ErrorCode == "quota_exhausted");
        Assert.Equal(1, net.Sent("https://api.mdblist.com/user")); // one refresh in flight at a time
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Fact]
    public async Task ALateStatusRefreshNeverOverwritesConsumption()
    {
        var served = 0; // list reads MDBList has counted
        using var net = MdblistApiNet(() => 8 - Volatile.Read(ref served));
        foreach (var list in new[] { "a", "b", "c", "d" })
        {
            var answer = net.Routes["https://api.mdblist.com/lists/me/" + list + "/items"];
            net.Routes["https://api.mdblist.com/lists/me/" + list + "/items"] = r => { Interlocked.Increment(ref served); return answer(r); };
        }

        Assert.True((await net.Fetch("https://mdblist.com/lists/me/a", ApiRead)).Ok); // status 8, one reserved: 7

        // A status refresh (the ratings path's) is answered as MDBList counts NOW (7), but arrives only after two more reads.
        var status = net.Routes["https://api.mdblist.com/user"];
        var arrived = false;
        using var release = new ManualResetEventSlim();
        net.Routes["https://api.mdblist.com/user"] = r =>
        {
            var answer = status(r);
            Volatile.Write(ref arrived, true);
            release.Wait(TimeSpan.FromSeconds(10));
            return answer;
        };
        var refresh = Task.Run(() => net.Quota.GetAccountStatusAsync(CancellationToken.None, forceRefresh: true));
        await WaitUntil(() => Volatile.Read(ref arrived));
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/b", ApiRead)).Ok); // 7 → 6
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/c", ApiRead)).Ok); // 6 → 5 (MDBList: 5)
        release.Set();
        await refresh;

        var late = await net.Fetch("https://mdblist.com/lists/me/d", ApiRead);

        Assert.Equal((false, "quota_exhausted"), (late.Ok, late.ErrorCode)); // the late "7" never undid the two reads
        Assert.Equal(3, Volatile.Read(ref served));
        Assert.True(net.Quota.RemainingQuota() <= MdblistService.SafetyMargin);
    }

    // ── Rule 1: every announced row is one distinct usable key or a counted exclusion ──

    // Review round 4 (D53 rule 2, classification before keying): every shape also carries a row of a type the provider
    // declares deliberately unsupported (Excludes: a counted exclusion in this context; else malformed, a typed context
    // that never holds one), a row of a type JE doesn't know, a row with no declared type (Infers: the context fixes
    // the type reliably; else malformed) and, for a typed context, a row declaring the other supported type (changed).
    internal sealed record Shape(string Provider, Func<Net, string[], (string Url, SourceFetchOptions? Options)> Arrange, Func<int, string> Valid, string Malformed, Func<int, string>? Unsupported,
        Func<int, string>? Explicit = null, bool Excludes = false, Func<int, string>? Unknown = null, Func<int, string>? Untyped = null, bool Infers = false, Func<int, string>? Changed = null)
    {
        public override string ToString() => Provider;
    }

    private static string TmdbRowOf(int id) => "{\"id\":" + id + ",\"media_type\":\"movie\",\"title\":\"M" + id + "\",\"release_date\":\"2001-01-01\"}";

    private static string TraktRowOf(int listId, int id) => "{\"id\":" + listId + ",\"type\":\"movie\",\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}";

    private static string ImdbRowOf(int n) => "{\"node\":{\"item\":{\"id\":\"tt" + (1000000 + n) + "\",\"titleText\":{\"text\":\"M" + n + "\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":2001}}}}";

    private static string MdbRowOf(int id) => "{\"id\":" + id + ",\"title\":\"M" + id + "\",\"mediatype\":\"movie\",\"release_year\":2001}";

    internal static IEnumerable<Shape> Shapes()
    {
        Net Key(Net net) { net.Config.TMDB_API_KEY = "tmdb-key"; return net; }
        Net Trakt(Net net) { net.Config.ArrListTraktApiKey = "trakt-client"; return net; }
        string Join(string[] rows) => string.Join(',', rows);
        HttpResponseMessage TraktAnswer(string[] rows)
        {
            var response = Json("[" + Join(rows) + "]");
            response.Headers.Add("X-Pagination-Page-Count", "1");
            response.Headers.Add("X-Pagination-Item-Count", rows.Length.ToString(CultureInfo.InvariantCulture));
            return response;
        }

        // The Trakt list-item id of row n is 900 + its position, so a repeated title is two distinct list rows.
        var traktRow = 0;
        string TraktValid(int id) => TraktRowOf(900 + Interlocked.Increment(ref traktRow), id);

        string TmdbPerson(int id) => "{\"id\":" + id + ",\"media_type\":\"person\",\"name\":\"P\"}";
        string TmdbUnknown(int id) => "{\"id\":" + id + ",\"media_type\":\"collection\",\"name\":\"C\"}";
        string TmdbUntyped(int id) => "{\"id\":" + id + ",\"title\":\"M" + id + "\",\"release_date\":\"2001-01-01\"}";
        string TmdbShow(int id) => "{\"id\":" + id + ",\"media_type\":\"tv\",\"name\":\"S" + id + "\",\"first_air_date\":\"2001-01-01\"}";
        string SeerrPerson(int id) => "{\"id\":" + id + ",\"mediaType\":\"person\",\"name\":\"P\"}";
        string SeerrUnknown(int id) => "{\"id\":" + id + ",\"mediaType\":\"collection\",\"name\":\"C\"}";
        string SeerrUntyped(int id) => "{\"id\":" + id + ",\"title\":\"M" + id + "\",\"releaseDate\":\"2001-01-01\"}";
        string SeerrShow(int id) => "{\"id\":" + id + ",\"mediaType\":\"tv\",\"name\":\"S" + id + "\",\"firstAirDate\":\"2001-01-01\"}";
        string ImdbTyped(int n, string type) => "{\"node\":{\"item\":{\"id\":\"tt" + (2000000 + n) + "\",\"titleType\":{\"id\":\"" + type + "\"},\"titleText\":{\"text\":\"T" + n + "\"},\"releaseYear\":{\"year\":2001}}}}";
        string ImdbUntyped(int n) => "{\"node\":{\"item\":{\"id\":\"tt" + (2000000 + n) + "\",\"titleText\":{\"text\":\"T" + n + "\"},\"releaseYear\":{\"year\":2001}}}}";
        string MdbTyped(int id, string type) => "{\"id\":" + id + ",\"title\":\"T" + id + "\",\"mediatype\":\"" + type + "\",\"release_year\":2001}";
        string MdbUntyped(int id) => "{\"id\":" + id + ",\"title\":\"T" + id + "\",\"release_year\":2001}";
        string ChronoMovie(int id) => "{\"t\":\"movie\",\"id\":" + id + ",\"n\":\"M" + id + "\",\"rd\":\"2001-01-01\"}";
        string ChronoTyped(int id, string type) => "{\"t\":\"" + type + "\",\"id\":" + id + ",\"n\":\"T" + id + "\",\"rd\":\"2001-01-01\"}";
        HttpResponseMessage Chronolists(string[] rows)
        {
            // Twenty more movies, so one unreadable entry stays under the share that means "the page format changed".
            var all = rows.Concat(Enumerable.Range(500, 20).Select(ChronoMovie));
            var page = "<html><body><script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"universe\":{\"id\":\"t\",\"name\":\"U\",\"list\":{\"l\":["
                + string.Join(',', all) + "],\"m\":{}}}}},\"page\":\"/[universe]\"}</script></body></html>";
            return IntegrationTransport.Response(page, 200, "text/html");
        }

        yield return new("tmdb list", (net, rows) => { Key(net).Routes["https://api.themoviedb.org/3/list/7"] = _ => Json("{\"name\":\"L\",\"total_pages\":1,\"item_count\":" + rows.Length + ",\"items\":[" + Join(rows) + "]}"); return ("https://www.themoviedb.org/list/7", null); },
            TmdbRowOf, "{\"media_type\":\"movie\",\"title\":\"No id\"}", TmdbPerson,
            Explicit: TmdbPerson, Excludes: true, Unknown: TmdbUnknown, Untyped: TmdbUntyped);
        yield return new("tmdb trending", (net, rows) => { Key(net).Routes["https://api.themoviedb.org/3/trending/all/week"] = _ => Json("{\"page\":1,\"total_pages\":1,\"total_results\":" + rows.Length + ",\"results\":[" + Join(rows) + "]}"); return ("https://www.themoviedb.org/trending/all/week", null); },
            TmdbRowOf, "{\"media_type\":\"movie\",\"title\":\"No id\"}", TmdbPerson,
            Explicit: TmdbPerson, Excludes: true, Unknown: TmdbUnknown, Untyped: TmdbUntyped);
        yield return new("tmdb chart", (net, rows) => { Key(net).Routes["https://api.themoviedb.org/3/movie/popular"] = _ => Json("{\"page\":1,\"total_pages\":1,\"total_results\":" + rows.Length + ",\"results\":[" + Join(rows) + "]}"); return ("https://www.themoviedb.org/movie", null); },
            TmdbUntyped, "{\"title\":\"No id\"}", null,
            Explicit: TmdbPerson, Unknown: TmdbUnknown, Untyped: TmdbUntyped, Infers: true, Changed: TmdbShow);
        yield return new("tmdb collection", (net, rows) => { Key(net).Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{\"name\":\"C\",\"parts\":[" + Join(rows) + "]}"); return ("https://www.themoviedb.org/collection/10", null); },
            TmdbRowOf, "{\"media_type\":\"movie\",\"title\":\"No id\"}", null,
            Explicit: TmdbPerson, Unknown: TmdbUnknown, Untyped: TmdbUntyped, Infers: true, Changed: TmdbShow);
        yield return new("seerr trending", (net, rows) => { SeerrOnly(net); net.Routes["http://seerr.test/api/v1/discover/trending"] = _ => Json("{\"page\":1,\"totalPages\":1,\"totalResults\":" + rows.Length + ",\"results\":[" + Join(rows) + "]}"); return ("https://www.themoviedb.org/trending/all/week", null); },
            SeerrRowOf, "{\"mediaType\":\"movie\",\"title\":\"No id\"}", SeerrPerson,
            Explicit: SeerrPerson, Excludes: true, Unknown: SeerrUnknown, Untyped: SeerrUntyped);
        yield return new("seerr collection", (net, rows) => { SeerrOnly(net); net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Json("{\"name\":\"C\",\"parts\":[" + Join(rows) + "]}"); return ("https://www.themoviedb.org/collection/10", null); },
            SeerrRowOf, "{\"mediaType\":\"movie\",\"title\":\"No id\"}", null,
            Explicit: SeerrPerson, Unknown: SeerrUnknown, Untyped: SeerrUntyped, Infers: true, Changed: SeerrShow);
        yield return new("trakt list", (net, rows) => { Trakt(net).Routes["https://api.trakt.tv/users/me/lists/mine/items/movie,show,season,episode"] = _ => TraktAnswer(rows); return ("https://trakt.tv/users/me/lists/mine", null); },
            TraktValid, "{\"id\":899,\"type\":\"movie\",\"movie\":{\"title\":\"No ids\",\"ids\":{\"trakt\":5}}}", _ => "{\"id\":898,\"type\":\"person\",\"person\":{\"name\":\"P\",\"ids\":{\"trakt\":5}}}",
            Explicit: _ => "{\"id\":898,\"type\":\"person\",\"person\":{\"name\":\"P\",\"ids\":{\"trakt\":5}}}", Excludes: true,
            Unknown: id => "{\"id\":897,\"type\":\"network\",\"network\":{\"name\":\"N\",\"ids\":{\"tmdb\":" + id + "}}}",
            Untyped: id => "{\"id\":896,\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}");
        yield return new("trakt chart", (net, rows) => { Trakt(net).Routes["https://api.trakt.tv/movies/trending"] = _ => TraktAnswer(rows); return ("https://trakt.tv/movies/trending", null); },
            id => "{\"watchers\":1,\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}", "{\"watchers\":1,\"movie\":{\"title\":\"No ids\",\"ids\":{\"trakt\":5}}}", null,
            Explicit: _ => "{\"watchers\":1,\"person\":{\"name\":\"P\",\"ids\":{\"trakt\":5}}}",
            Unknown: id => "{\"watchers\":1,\"type\":\"network\",\"network\":{\"name\":\"N\",\"ids\":{\"tmdb\":" + id + "}}}",
            Untyped: id => "{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}", Infers: true,
            Changed: id => "{\"watchers\":1,\"show\":{\"title\":\"S" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}");
        yield return new("trakt box office", (net, rows) => { Trakt(net).Routes["https://api.trakt.tv/movies/boxoffice"] = _ => Json("[" + Join(rows) + "]"); return ("https://trakt.tv/movies/boxoffice", null); },
            id => "{\"revenue\":1,\"movie\":{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}", "{\"revenue\":1,\"movie\":{\"title\":\"No ids\",\"ids\":{\"trakt\":5}}}", null,
            Explicit: _ => "{\"revenue\":1,\"person\":{\"name\":\"P\",\"ids\":{\"trakt\":5}}}",
            Unknown: id => "{\"revenue\":1,\"type\":\"network\",\"network\":{\"name\":\"N\",\"ids\":{\"tmdb\":" + id + "}}}",
            Untyped: id => "{\"title\":\"M" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}", Infers: true,
            Changed: id => "{\"revenue\":1,\"show\":{\"title\":\"S" + id + "\",\"year\":2001,\"ids\":{\"tmdb\":" + id + "}}}");
        yield return new("imdb list", (net, rows) => { net.Routes["https://api.graphql.imdb.com/"] = _ => Json("{\"data\":{\"list\":{\"name\":{\"originalText\":\"L\"},\"items\":{\"total\":" + rows.Length + ",\"edges\":[" + Join(rows) + "],\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}}}}"); return ("https://www.imdb.com/list/ls000000302/", null); },
            ImdbRowOf, "{\"node\":{\"item\":{\"id\":\"nm0000001\",\"titleType\":{\"id\":\"movie\"},\"titleText\":{\"text\":\"Bad id\"}}}}", n => ImdbTyped(n, "videoGame"),
            Explicit: n => ImdbTyped(n, "videoGame"), Excludes: true, Unknown: n => ImdbTyped(n, "radioSeries"), Untyped: ImdbUntyped);
        yield return new("imdb chart", (net, rows) => { net.Routes["https://api.graphql.imdb.com/"] = _ => Json("{\"data\":{\"chartTitles\":{\"total\":" + rows.Length + ",\"edges\":[" + Join(rows) + "],\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}}}"); return ("https://www.imdb.com/chart/top/", null); },
            ImdbRowOf, "{\"node\":{\"item\":{\"id\":\"nm0000001\",\"titleType\":{\"id\":\"movie\"},\"titleText\":{\"text\":\"Bad id\"}}}}", null,
            Explicit: n => ImdbTyped(n, "videoGame"), Unknown: n => ImdbTyped(n, "radioSeries"), Untyped: ImdbUntyped, Changed: n => ImdbTyped(n, "tvSeries"));
        yield return new("mdblist public", (net, rows) => { net.Routes["https://mdblist.com/lists/me/mine/json"] = _ => Json("[" + Join(rows) + "]"); return ("https://mdblist.com/lists/me/mine", null); },
            MdbRowOf, "{\"title\":\"No ids\",\"mediatype\":\"movie\"}", id => "{\"id\":" + id + ",\"title\":\"A\",\"mediatype\":\"movie\",\"adult\":1}",
            Explicit: id => MdbTyped(id, "person"), Excludes: true, Unknown: id => MdbTyped(id, "game"), Untyped: MdbUntyped);
        yield return new("mdblist official", (net, rows) => { net.Routes["https://mdblist.com/lists/official/movies/top/json"] = _ => Json("[" + Join(rows) + "]"); return ("https://mdblist.com/lists/official/movies/top", null); },
            MdbRowOf, "{\"title\":\"No ids\",\"mediatype\":\"movie\"}", id => "{\"id\":" + id + ",\"title\":\"A\",\"mediatype\":\"movie\",\"adult\":1}",
            Explicit: id => MdbTyped(id, "person"), Unknown: id => MdbTyped(id, "game"), Untyped: MdbUntyped, Infers: true, Changed: id => MdbTyped(id, "show"));
        yield return new("mdblist api", (net, rows) =>
            {
                net.Config.MdblistApiKey = "mdb-key";
                net.Config.ArrPhase4ListMdblistApiEnabled = true;
                net.Routes["https://api.mdblist.com/user"] = _ => Json(Status(900));
                net.Routes["https://api.mdblist.com/lists/me/mine/items"] = _ => Json("{\"items\":[" + Join(rows) + "],\"pagination\":{\"has_more\":false}}");
                return ("https://mdblist.com/lists/me/mine", ApiRead);
            },
            MdbRowOf, "{\"title\":\"No ids\",\"mediatype\":\"movie\"}", id => "{\"id\":" + id + ",\"title\":\"A\",\"mediatype\":\"movie\",\"adult\":1}",
            Explicit: id => MdbTyped(id, "person"), Excludes: true, Unknown: id => MdbTyped(id, "game"), Untyped: MdbUntyped);
        yield return new("chronolists", (net, rows) => { net.Routes["https://chronolists.com/mcu"] = _ => Chronolists(rows); return ("https://chronolists.com/mcu", null); },
            ChronoMovie, "{\"t\":\"movie\",\"n\":\"No id\",\"rd\":\"2001-01-01\"}", null,
            Explicit: id => ChronoTyped(id, "person"), Unknown: id => ChronoTyped(id, "game"), Untyped: id => "{\"id\":" + id + ",\"n\":\"M" + id + "\",\"rd\":\"2001-01-01\"}");
    }

    public static IEnumerable<object[]> RowCases() =>
        from shape in Shapes()
        from row in new[] { "valid", "malformed", "duplicate", "unsupported", "explicit-unsupported", "unknown-type", "untyped", "changed-type" }
        where row switch
        {
            "unsupported" => shape.Unsupported != null,
            "explicit-unsupported" => shape.Explicit != null,
            "unknown-type" => shape.Unknown != null,
            "untyped" => shape.Untyped != null,
            "changed-type" => shape.Changed != null,
            _ => true,
        }
        select new object[] { shape.Provider, row };

    [Theory]
    [MemberData(nameof(RowCases))]
    public async Task OnlyValidAndCountedUnsupportedRowsAreComplete(string provider, string row)
    {
        var shape = Shapes().Single(s => s.Provider == provider);
        var rows = row switch
        {
            "valid" => new[] { shape.Valid(1), shape.Valid(2), shape.Valid(3) },
            "malformed" => new[] { shape.Valid(1), shape.Malformed, shape.Valid(2) },
            "duplicate" => new[] { shape.Valid(1), shape.Valid(2), shape.Valid(1) },
            "unsupported" => new[] { shape.Valid(1), shape.Unsupported!(77), shape.Valid(2) },
            "explicit-unsupported" => new[] { shape.Valid(1), shape.Explicit!(77), shape.Valid(2) },
            "unknown-type" => new[] { shape.Valid(1), shape.Unknown!(77), shape.Valid(2) },
            "untyped" => new[] { shape.Valid(1), shape.Untyped!(77), shape.Valid(2) },
            _ => new[] { shape.Valid(1), shape.Changed!(77), shape.Valid(2) },
        };
        using var net = new Net();
        var (url, options) = shape.Arrange(net, rows);

        var result = await net.Fetch(url, options);

        // Review round 4: the declared type decides before any key does. A deliberately unsupported row is a counted
        // exclusion where the provider declares it (never a key: 4c2-R4-2's MDBList person read as movie|77); in a typed
        // context, an unknown, missing-where-declared or changed type is malformed.
        var complete = row switch
        {
            "valid" or "unsupported" => true,
            "explicit-unsupported" => shape.Excludes,
            "untyped" => shape.Infers,
            _ => false,
        };
        if (complete)
        {
            Assert.True(result.Ok, result.ErrorCode);
            Assert.True(IsComplete(result), provider + " " + row + ": not complete");
            if (row is "unsupported" or "explicit-unsupported")
            {
                Assert.Equal(1, result.Excluded);
                Assert.Equal(2, SourceSnapshots.Keys(result).Count);
            }
        }
        else
        {
            Assert.False(IsComplete(result), provider + " " + row + ": " + result.Items.Count + " entries read as complete (" + string.Join(", ", result.Items.Select(i => i.Key)) + ")");
        }
    }

    [Fact]
    public async Task AMalformedRowNeverLetsItsTitleBeRemoved()
    {
        using var net = new Net();
        net.Config.TMDB_API_KEY = "tmdb-key";
        // A and B were in the last complete snapshot; B's row now comes without its id.
        net.Routes["https://api.themoviedb.org/3/list/7"] = _ => Json("{\"name\":\"L\",\"total_pages\":1,\"item_count\":2,\"items\":[" + TmdbRowOf(1) + ",{\"media_type\":\"movie\",\"title\":\"B\"}]}");

        var result = await net.Fetch("https://www.themoviedb.org/list/7");
        var last = new[] { "movie|1||", "movie|2||" };
        var verdict = SourceSnapshots.Classify(result, last);
        var (_, drop) = SourceSnapshots.Plan(result, verdict, last, new HashSet<string>(last), new HashSet<string>(), new HashSet<string>(last));

        Assert.Empty(drop);
        Assert.NotEqual(SnapshotState.Complete, verdict.State);
    }

    [Fact]
    public async Task AnImdbPageRepeatingARowIsNeverComplete()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = r => Json(ImdbAfter(r) == string.Empty
            ? "{\"data\":{\"list\":{\"name\":{\"originalText\":\"L\"},\"items\":{\"total\":2,\"edges\":[" + ImdbRowOf(1) + "],\"pageInfo\":{\"hasNextPage\":true,\"endCursor\":\"c1\"}}}}}"
            : "{\"data\":{\"list\":{\"items\":{\"total\":2,\"edges\":[" + ImdbRowOf(1) + "],\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}}}}");

        var result = await net.Fetch("https://www.imdb.com/list/ls000000303/");

        Assert.True(result.Ok, result.ErrorCode);
        Assert.False(IsComplete(result), "page 2 repeated A: read as complete");
    }

    [Fact]
    public async Task AnImdbRepeatedCursorIsNeverCompleteAndStopsTheRead()
    {
        using var net = new Net();
        net.Routes["https://api.graphql.imdb.com/"] = r => Json(ImdbAfter(r) == string.Empty
            ? "{\"data\":{\"list\":{\"name\":{\"originalText\":\"L\"},\"items\":{\"total\":3,\"edges\":[" + ImdbRowOf(1) + "],\"pageInfo\":{\"hasNextPage\":true,\"endCursor\":\"c1\"}}}}}"
            : "{\"data\":{\"list\":{\"items\":{\"total\":3,\"edges\":[" + ImdbRowOf(2) + "],\"pageInfo\":{\"hasNextPage\":true,\"endCursor\":\"c1\"}}}}}");

        var result = await net.Fetch("https://www.imdb.com/list/ls000000304/");

        Assert.False(IsComplete(result), "a repeated cursor read as complete");
        Assert.Equal(2, net.Requests.Count); // the cursor came back: no third request for the same page
    }

    [Theory]
    [InlineData("tmdb trending")]
    [InlineData("trakt list")]
    [InlineData("imdb list")]
    [InlineData("mdblist public")]
    public async Task AnUnsupportedRowIsCountedSeparatelyAndNeverAKey(string provider)
    {
        var shape = Shapes().Single(s => s.Provider == provider);
        using var net = new Net();
        var (url, options) = shape.Arrange(net, new[] { shape.Valid(1), shape.Unsupported!(77), shape.Valid(2) });

        var result = await net.Fetch(url, options);

        Assert.True(IsComplete(result), result.ErrorCode);
        Assert.Equal(1, result.Excluded);
        Assert.Equal(2, SourceSnapshots.Keys(result).Count);
    }

    [Fact]
    public void AChronolistsOrderWithAnEntryReadTwiceIsNeverComplete()
    {
        static SourceItem Movie(int id) => new("movie", id, null, null, "M" + id, 2001, null, null, null);
        SourceVerdict Verdict(params SourceItem[] items)
        {
            var read = new SourceRead();
            foreach (var item in items)
            {
                read.Row(SourceRow.Of(item));
            }

            return SourceCompleteness.Chronolists(new ChronolistsList("U", items, items.Length, 0, false), read);
        }

        Assert.True(Verdict(Movie(1), Movie(2)).Complete);
        Assert.False(Verdict(Movie(1), Movie(2), Movie(1)).Complete);
        Assert.False(Verdict(Movie(1), new SourceItem("movie", null, null, null, null, null, null, null, null)).Complete); // a keyless entry
    }
}
