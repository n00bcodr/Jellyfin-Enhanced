using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;

namespace JE.Tests;

// List URL sources (5b): URL recognition + SSRF guard, and every fetcher against a fake internet (MDBList public/API,
// TMDB with/without key incl. the Seerr fallback, Trakt, IMDb gated off by default, Retry-After, redirects, caps).
[Collection("Plugin singleton")]
public class ListPlaceholdersSourceTests
{
    [Theory]
    [InlineData("https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week", "mdblist", "user", "https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week")]
    [InlineData("mdblist.com/lists/LinasPurinis/top-watched-movies-of-the-week/json/", "mdblist", "user", "https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week")]
    [InlineData("https://www.mdblist.com/lists/chazlarson/external/2868", "mdblist", "external", "https://mdblist.com/lists/chazlarson/external/2868")]
    [InlineData("https://mdblist.com/lists/official/shows/justwatch-streaming-charts", "mdblist", "official", "https://mdblist.com/lists/official/shows/justwatch-streaming-charts")]
    [InlineData("https://www.themoviedb.org/list/8136-the-entire-star-wars-collection", "tmdb", "list", "https://www.themoviedb.org/list/8136")]
    [InlineData("https://www.themoviedb.org/collection/10-star-wars-collection?language=en", "tmdb", "collection", "https://www.themoviedb.org/collection/10")]
    [InlineData("https://www.themoviedb.org/movie/top-rated", "tmdb", "chart", "https://www.themoviedb.org/movie/top-rated")]
    [InlineData("https://www.themoviedb.org/tv", "tmdb", "chart", "https://www.themoviedb.org/tv")]
    [InlineData("https://www.themoviedb.org/trending/movie/week", "tmdb", "trending", "https://www.themoviedb.org/trending/movie/week")]
    [InlineData("https://trakt.tv/users/justin/lists/imdb-top-rated-movies", "trakt", "list", "https://trakt.tv/users/justin/lists/imdb-top-rated-movies")]
    [InlineData("https://app.trakt.tv/users/justin/watchlist", "trakt", "watchlist", "https://trakt.tv/users/justin/watchlist")]
    [InlineData("https://trakt.tv/lists/official/marvel-cinematic-universe", "trakt", "listid", "https://trakt.tv/lists/official/marvel-cinematic-universe")]
    [InlineData("https://trakt.tv/lists/2142753", "trakt", "listid", "https://trakt.tv/lists/2142753")]
    [InlineData("https://trakt.tv/movies/watched/weekly", "trakt", "chart", "https://trakt.tv/movies/watched/weekly")]
    [InlineData("https://www.imdb.com/list/ls055592025/", "imdb", "list", "https://www.imdb.com/list/ls055592025/")]
    [InlineData("https://m.imdb.com/user/ur12345678/watchlist", "imdb", "watchlist", "https://www.imdb.com/user/ur12345678/watchlist/")]
    [InlineData("https://www.imdb.com/de/chart/toptv/?ref_=nv", "imdb", "chart", "https://www.imdb.com/chart/toptv/")]
    public void SupportedUrlsAreRecognisedAndCanonicalised(string url, string kind, string shape, string canonical)
    {
        Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
        Assert.Equal((kind, shape, canonical), (source!.Kind, source.Shape, source.CanonicalUrl));
    }

    [Theory]
    [InlineData("https://letterboxd.com/dave/list/official-top-250/", ListSourceUrl.LetterboxdUnsupported)]
    [InlineData("https://boxd.it/abc", ListSourceUrl.LetterboxdUnsupported)]
    [InlineData("http://127.0.0.1:8096/JellyfinEnhanced/x", ListSourceUrl.InvalidUrl)]
    [InlineData("https://mdblist.com:8443/lists/a/b", ListSourceUrl.InvalidUrl)]
    [InlineData("https://user:pass@mdblist.com/lists/a/b", ListSourceUrl.InvalidUrl)]
    [InlineData("file:///etc/passwd", ListSourceUrl.InvalidUrl)]
    [InlineData("ftp://mdblist.com/lists/a/b", ListSourceUrl.InvalidUrl)]
    [InlineData("https://evil.test/lists/a/b", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://mdblist.com.evil.test/lists/a/b", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://mdblist.com/lists/a/../../admin", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://mdblist.com/lists/a%2F..%2Fb/c", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://trakt.tv/shows/boxoffice", ListSourceUrl.UnsupportedUrl)]
    [InlineData("https://www.imdb.com/title/tt0111161/", ListSourceUrl.UnsupportedUrl)]
    [InlineData("", ListSourceUrl.InvalidUrl)]
    public void EverythingElseIsRejectedBeforeAnyRequest(string url, string code)
    {
        Assert.False(ListSourceUrl.TryParse(url, out var source, out var error));
        Assert.Null(source);
        Assert.Equal(code, error);
    }

    [Fact]
    public void SourceKeysUseIdsNeverRank()
    {
        Assert.Equal("movie|49521||", new SourceItem("movie", 49521, "tt0770828", null, "Man of Steel", 2013, null, null, null).Key);
        Assert.Equal("tv|110492|1|", new SourceItem("tv", 110492, null, 391153, "Peacemaker", null, 1, null, null).Key);
        Assert.Equal("tv|60735|1|8", new SourceItem("tv", 60735, null, null, "The Flash", null, 1, 8, null).Key);
        Assert.Equal("imdb|tt0903747|1|1", new SourceItem("tv", null, "tt0903747", null, null, null, 1, 1, null).Key);
        Assert.Equal("tvdb|391153||", new SourceItem("tv", null, null, 391153, null, null, null, null, null).Key);
        Assert.Null(new SourceItem("movie", null, null, 5, "no usable id", null, null, null, null).Key);
        Assert.True(SourceKeys.IsValid("movie|1||"));
        Assert.False(SourceKeys.IsValid("movie|1"));
        Assert.False(SourceKeys.IsValid("person|1||"));
        Assert.False(SourceKeys.IsValid(null));
    }

    // ── Fetchers ────────────────────────────────────────────────────────

    private sealed class Net : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<HttpRequestMessage> Requests { get; } = new();
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
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
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            Fetcher = new ListSourceFetcher(Transport, Tmdb, new SeerrCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger);
        }

        public Task<SourceFetchResult> Fetch(string url, SourceFetchOptions? options = null)
        {
            Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
            return Fetcher.FetchAsync(source!, options ?? new SourceFetchOptions(), CancellationToken.None);
        }

        public void Dispose()
        {
            Tmdb.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static HttpResponseMessage Json(string body, int status = 200) => IntegrationTransport.Response(body, status);

    [Fact]
    public async Task MdblistUsesThePublicJsonAndOnlyAdminsFallBackToTheApi()
    {
        using var net = new Net();
        net.Routes["https://mdblist.com/lists/me/mine/json"] = _ => Json("[{\"id\":985939,\"rank\":6,\"title\":\"Fall\",\"tvdbid\":338363,\"imdb_id\":\"tt15325794\",\"mediatype\":\"movie\",\"release_year\":2022},"
            + "{\"id\":95350,\"rank\":2,\"title\":\"Lanterns\",\"imdb_id\":\"tt26545992\",\"mediatype\":\"show\",\"release_year\":2026},{\"id\":0,\"title\":\"no id\",\"mediatype\":\"movie\"}]");
        var result = await net.Fetch("https://mdblist.com/lists/me/mine");
        Assert.True(result.Ok);
        Assert.Equal("mdblist", result.Provider);
        Assert.Equal(new[] { "movie|985939||", "tv|95350||", null }, result.Items.Select(i => i.Key));
        Assert.Equal((95350, null, "tt26545992"), (result.Items[1].TmdbId, result.Items[1].TvdbId, result.Items[1].ImdbId));

        // A private list: 404 publicly. Without admin rights or a key there is no fallback.
        var none = await net.Fetch("https://mdblist.com/lists/me/private");
        Assert.Equal("not_found", none.ErrorCode);
        net.Plugin.Plugin.Configuration.MdblistApiKey = "mdb-key";
        Assert.Equal("not_found", (await net.Fetch("https://mdblist.com/lists/me/private")).ErrorCode);
        Assert.DoesNotContain(net.Requests, r => r.RequestUri!.Host == "api.mdblist.com");

        net.Routes["https://api.mdblist.com/lists/me/private/items"] = request =>
        {
            Assert.Contains("apikey=mdb-key", request.RequestUri!.Query, StringComparison.Ordinal);
            Assert.Contains("unified=true", request.RequestUri.Query, StringComparison.Ordinal);
            return Json("{\"items\":[{\"ids\":{\"tmdb\":10193,\"imdb\":\"tt0435761\"},\"title\":\"Toy Story 3\",\"mediatype\":\"movie\",\"release_year\":2010}]}");
        };
        var api = await net.Fetch("https://mdblist.com/lists/me/private", new SourceFetchOptions { AllowMdblistApi = true });
        Assert.True(api.Ok);
        Assert.Equal("mdblist-api", api.Provider);
        Assert.Equal("movie|10193||", Assert.Single(api.Items).Key);
    }

    [Fact]
    public async Task TmdbListsAndExactChartsNeedTheKeyWhileCollectionsAndTrendingFallBackToSeerr()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        Assert.Equal("tmdb_key_required", (await net.Fetch("https://www.themoviedb.org/list/8136")).ErrorCode);
        Assert.Equal("tmdb_key_required", (await net.Fetch("https://www.themoviedb.org/movie/top-rated")).ErrorCode);

        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";
        net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Json("{\"id\":10,\"name\":\"Star Wars Collection\",\"parts\":[{\"id\":11,\"mediaType\":\"movie\",\"title\":\"Star Wars\",\"releaseDate\":\"1977-05-25\"},{\"id\":1891,\"mediaType\":\"movie\",\"title\":\"The Empire Strikes Back\",\"releaseDate\":\"1980-05-20\"}]}");
        net.Routes["http://seerr.test/api/v1/discover/trending"] = request =>
        {
            Assert.Contains("mediaType=movie&timeWindow=week", request.RequestUri!.Query, StringComparison.Ordinal);
            return Json("{\"page\":1,\"totalPages\":1,\"results\":[{\"id\":1061474,\"mediaType\":\"movie\",\"title\":\"Superman\",\"releaseDate\":\"2025-07-09\"},{\"id\":5,\"mediaType\":\"person\",\"name\":\"x\"}]}");
        };
        var collection = await net.Fetch("https://www.themoviedb.org/collection/10");
        Assert.Equal(("seerr", "Star Wars Collection", 2), (collection.Provider, collection.Title, collection.Items.Count));
        var trending = await net.Fetch("https://www.themoviedb.org/trending/movie/week");
        Assert.Equal(("seerr", "movie|1061474||"), (trending.Provider, Assert.Single(trending.Items).Key));
        Assert.Equal("tmdb_key_required", (await net.Fetch("https://www.themoviedb.org/list/8136")).ErrorCode);

        config.TMDB_API_KEY = "tmdb-key";
        var page = 0;
        net.Routes["https://api.themoviedb.org/3/list/8136"] = request =>
        {
            Assert.Contains("api_key=tmdb-key", request.RequestUri!.Query, StringComparison.Ordinal);
            page++;
            return Json(page == 1
                ? "{\"name\":\"The Entire Star Wars Collection\",\"item_count\":3,\"total_pages\":2,\"items\":[{\"id\":1893,\"media_type\":\"movie\",\"title\":\"Episode I\",\"release_date\":\"1999-05-19\"},{\"id\":4194,\"media_type\":\"tv\",\"name\":\"The Clone Wars\",\"first_air_date\":\"2008-10-03\"}]}"
                : "{\"total_pages\":2,\"items\":[{\"id\":1894,\"media_type\":\"movie\",\"title\":\"Episode II\",\"release_date\":\"2002-05-15\"}]}");
        };
        var list = await net.Fetch("https://www.themoviedb.org/list/8136");
        Assert.True(list.Ok);
        Assert.Equal(("tmdb", "The Entire Star Wars Collection", 3), (list.Provider, list.Title, list.Total));
        Assert.Equal(new[] { "movie|1893||", "tv|4194||", "movie|1894||" }, list.Items.Select(i => i.Key));

        // A link pinned to Seerr stays on Seerr; one pinned to TMDB fails instead of switching when the key goes away.
        var pinned = await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions { Provider = "seerr", Fresh = true });
        Assert.Equal("seerr", pinned.Provider);
        config.TMDB_API_KEY = string.Empty;
        Assert.Equal("tmdb_key_required", (await net.Fetch("https://www.themoviedb.org/trending/movie/week", new SourceFetchOptions { Provider = "tmdb", Fresh = true })).ErrorCode);
    }

    [Fact]
    public async Task TraktNeedsAClientIdAndKeepsSeasonAndEpisodeGranularity()
    {
        using var net = new Net();
        Assert.Equal("trakt_not_configured", (await net.Fetch("https://trakt.tv/users/justin/lists/dc")).ErrorCode);
        Assert.Empty(net.Requests);

        net.Plugin.Plugin.Configuration.TraktClientId = "trakt-client";
        var rows = new[]
        {
            "{\"rank\":1,\"type\":\"movie\",\"notes\":\"start here\",\"movie\":{\"title\":\"Man of Steel\",\"year\":2013,\"ids\":{\"trakt\":1,\"imdb\":\"tt0770828\",\"tmdb\":49521}}}",
            "{\"rank\":2,\"type\":\"season\",\"season\":{\"number\":1,\"ids\":{\"tmdb\":163789}},\"show\":{\"title\":\"Peacemaker\",\"year\":2022,\"ids\":{\"tmdb\":110492,\"tvdb\":391153}}}",
            "{\"rank\":3,\"type\":\"episode\",\"episode\":{\"season\":1,\"number\":8,\"ids\":{}},\"show\":{\"title\":\"The Flash\",\"year\":2014,\"ids\":{\"tmdb\":60735}}}",
            "{\"rank\":4,\"type\":\"person\",\"person\":{\"name\":\"x\"}}",
        };
        net.Routes["https://api.trakt.tv/users/justin/lists/dc/items/movie,show,season,episode"] = request =>
        {
            Assert.Equal("trakt-client", Assert.Single(request.Headers.GetValues("trakt-api-key")));
            Assert.Equal("2", Assert.Single(request.Headers.GetValues("trakt-api-version")));
            // Two rows per page; the fetcher's boundary check reads single rows (limit=1).
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            var page = int.Parse(query["page"]!, System.Globalization.CultureInfo.InvariantCulture);
            var size = query["limit"] == "1" ? 1 : 2;
            var response = Json("[" + string.Join(',', rows.Skip((page - 1) * size).Take(size)) + "]");
            response.Headers.Add("X-Pagination-Page-Count", "2");
            response.Headers.Add("X-Pagination-Item-Count", "4");
            return response;
        };
        var result = await net.Fetch("https://trakt.tv/users/justin/lists/dc");
        Assert.True(result.Ok);
        Assert.Equal(new[] { "movie|49521||", "tv|110492|1|", "tv|60735|1|8" }, result.Items.Select(i => i.Key));
        Assert.Equal("start here", result.Items[0].Note);
        Assert.Equal(391153, result.Items[1].TvdbId);

        net.Routes["https://api.trakt.tv/movies/popular"] = _ => Json("[{\"title\":\"Dune\",\"year\":2021,\"ids\":{\"tmdb\":438631}}]");
        var chart = await net.Fetch("https://trakt.tv/movies/popular");
        Assert.Equal("movie|438631||", Assert.Single(chart.Items).Key);
        net.Routes["https://api.trakt.tv/users/private/watchlist"] = _ => Json("{\"error\":\"forbidden\"}", 403);
        Assert.Equal("trakt_unauthorized", (await net.Fetch("https://trakt.tv/users/private/watchlist")).ErrorCode);
    }

    [Fact]
    public async Task AShortRetryAfterIsHonouredOnceAndALongOneIsReported()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.TraktClientId = "trakt-client";
        var calls = 0;
        net.Routes["https://api.trakt.tv/movies/trending"] = _ =>
        {
            calls++;
            if (calls == 1)
            {
                var limited = Json("{}", 429);
                limited.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(1));
                return limited;
            }

            return Json("[{\"watchers\":5,\"movie\":{\"title\":\"Dune\",\"ids\":{\"tmdb\":438631}}}]");
        };
        Assert.True((await net.Fetch("https://trakt.tv/movies/trending")).Ok);
        Assert.Equal(2, calls);

        net.Routes["https://api.trakt.tv/shows/trending"] = _ =>
        {
            var limited = Json("{}", 429);
            limited.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromMinutes(5));
            return limited;
        };
        var refused = await net.Fetch("https://trakt.tv/shows/trending");
        Assert.Equal(("rate_limited", 300), (refused.ErrorCode, refused.RetryAfterSeconds));
    }

    [Fact]
    public async Task ImdbIsOffByDefaultAndParsesTheGraphQlShapesWhenEnabled()
    {
        using var net = new Net();
        Assert.Equal("imdb_disabled", (await net.Fetch("https://www.imdb.com/chart/toptv/")).ErrorCode);
        Assert.Empty(net.Requests);

        net.Plugin.Plugin.Configuration.ListPlaceholdersImdbEnabled = true;
        net.Routes["https://api.graphql.imdb.com/"] = request =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.True(request.Headers.Contains("x-imdb-client-name"));
            var body = request.Content!.ReadAsStringAsync().Result;
            if (body.Contains("chartTitles", StringComparison.Ordinal))
            {
                Assert.Contains("TOP_RATED_TV_SHOWS", body, StringComparison.Ordinal);
                return Json("{\"data\":{\"chartTitles\":{\"total\":2,\"edges\":[{\"node\":{\"id\":\"tt0903747\",\"titleText\":{\"text\":\"Breaking Bad\"},\"titleType\":{\"id\":\"tvSeries\"},\"releaseYear\":{\"year\":2008}}},"
                    + "{\"node\":{\"id\":\"tt0959621\",\"titleText\":{\"text\":\"Pilot\"},\"titleType\":{\"id\":\"tvEpisode\"},\"series\":{\"series\":{\"id\":\"tt0903747\",\"titleText\":{\"text\":\"Breaking Bad\"}},\"displayableEpisodeNumber\":{\"displayableSeason\":{\"text\":\"1\"},\"episodeNumber\":{\"text\":\"1\"}}}}}],"
                    + "\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}},\"extensions\":{\"disclaimer\":\"...\"}}");
            }

            return Json("{\"errors\":[{\"message\":\"Permission denied\",\"extensions\":{\"code\":\"FORBIDDEN\"}}],\"data\":{\"list\":null}}");
        };
        var chart = await net.Fetch("https://www.imdb.com/chart/toptv/");
        Assert.True(chart.Ok);
        Assert.True(chart.Unofficial);
        Assert.Equal(new[] { "imdb|tt0903747||", "imdb|tt0903747|1|1" }, chart.Items.Select(i => i.Key));
        Assert.Equal(("tv", "Breaking Bad", "Pilot"), (chart.Items[1].MediaType, chart.Items[1].Title, chart.Items[1].Note));
        Assert.Equal("not_found", (await net.Fetch("https://www.imdb.com/list/ls000000001/")).ErrorCode);
    }

    [Fact]
    public async Task RedirectsAreNotFollowedAndResultsAreCachedBriefly()
    {
        using var net = new Net();
        net.Routes["https://mdblist.com/lists/me/moved/json"] = _ =>
        {
            var redirect = new HttpResponseMessage(HttpStatusCode.Found) { Content = new StringContent(string.Empty) };
            redirect.Headers.Location = new Uri("http://169.254.169.254/latest/meta-data");
            return redirect;
        };
        var moved = await net.Fetch("https://mdblist.com/lists/me/moved");
        Assert.False(moved.Ok);
        Assert.Equal("upstream_error", moved.ErrorCode);
        Assert.DoesNotContain(net.Requests, r => r.RequestUri!.Host == "169.254.169.254");

        net.Routes["https://mdblist.com/lists/me/ok/json"] = _ => Json("[{\"id\":1,\"mediatype\":\"movie\",\"title\":\"A\"}]");
        await net.Fetch("https://mdblist.com/lists/me/ok");
        await net.Fetch("https://mdblist.com/lists/me/ok");
        Assert.Single(net.Requests, r => r.RequestUri!.AbsolutePath == "/lists/me/ok/json");
        await net.Fetch("https://mdblist.com/lists/me/ok", new SourceFetchOptions { Fresh = true });
        Assert.Equal(2, net.Requests.Count(r => r.RequestUri!.AbsolutePath == "/lists/me/ok/json"));
    }

    // R4-7: offset pages of a Trakt list that change while they are read: the list is read again;
    // a list that keeps changing is reported Partial, so a sync never removes on it.
    [Theory]
    [InlineData(1, false)]
    [InlineData(99, true)]
    public async Task ATraktListEditedWhileItsPagesAreReadIsReadAgainOrReportedPartial(int edits, bool partial)
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.TraktClientId = "trakt-client";
        var rows = Enumerable.Range(1, 201).ToList();
        var next = 1000;
        var editsLeft = edits;
        net.Routes["https://api.trakt.tv/users/me/lists/drift/items/movie,show,season,episode"] = request =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            var page = int.Parse(query["page"]!, System.Globalization.CultureInfo.InvariantCulture);
            var limit = int.Parse(query["limit"]!, System.Globalization.CultureInfo.InvariantCulture);
            if (page == 2 && limit == 100 && editsLeft-- > 0)
            {
                // Between page 1 and page 2 the owner removes the first row (and adds a new one at the end): the count stays.
                rows.RemoveAt(0);
                rows.Add(next++);
                if (edits > 1)
                {
                    rows.RemoveAt(0);
                }
            }

            var slice = rows.Skip((page - 1) * limit).Take(limit);
            var response = Json("[" + string.Join(',', slice.Select(i => $"{{\"id\":{i},\"type\":\"movie\",\"movie\":{{\"title\":\"M{i}\",\"ids\":{{\"tmdb\":{i}}}}}}}")) + "]");
            response.Headers.Add("X-Pagination-Page-Count", ((rows.Count + limit - 1) / limit).ToString(System.Globalization.CultureInfo.InvariantCulture));
            response.Headers.Add("X-Pagination-Item-Count", rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return response;
        };

        var result = await net.Fetch("https://trakt.tv/users/me/lists/drift");
        Assert.True(result.Ok);
        Assert.Equal(partial, result.Partial);
        if (!partial)
        {
            Assert.Equal(Enumerable.Range(2, 200).Append(1000), result.Items.Select(i => i.TmdbId!.Value));
        }
    }

    // R4-7: the same for a TMDB list (a row removed before page 2 is read: item_count drops and a row is never seen).
    [Fact]
    public async Task ATmdbListEditedWhileItsPagesAreReadIsReadAgain()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        var rows = Enumerable.Range(1, 5).ToList();
        var edited = false;
        net.Routes["https://api.themoviedb.org/3/list/77"] = request =>
        {
            var page = int.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["page"]!, System.Globalization.CultureInfo.InvariantCulture);
            if (page == 2 && !edited)
            {
                edited = true;
                rows.RemoveAt(0);
            }

            var slice = rows.Skip((page - 1) * 2).Take(2);
            return Json($"{{\"name\":\"Drift\",\"item_count\":{rows.Count},\"total_pages\":{(rows.Count + 1) / 2},\"items\":[" + string.Join(',', slice.Select(i => $"{{\"id\":{i},\"media_type\":\"movie\",\"title\":\"M{i}\"}}")) + "]}");
        };

        var result = await net.Fetch("https://www.themoviedb.org/list/77");
        Assert.True(result.Ok);
        Assert.False(result.Partial);
        Assert.Equal(new[] { 2, 3, 4, 5 }, result.Items.Select(i => i.TmdbId!.Value));
    }

    [Fact]
    public async Task ListsAreCappedAtOneThousandEntriesAndMarkedTruncated()
    {
        using var net = new Net();
        var items = string.Join(',', Enumerable.Range(1, 1200).Select(i => $"{{\"id\":{i},\"mediatype\":\"movie\",\"title\":\"M{i}\"}}"));
        net.Routes["https://mdblist.com/lists/me/huge/json"] = _ => Json("[" + items + "]");
        var result = await net.Fetch("https://mdblist.com/lists/me/huge");
        Assert.True(result.Ok);
        Assert.Equal(ListSourceFetcher.MaxItems, result.Items.Count);
        Assert.True(result.Truncated);
        Assert.Equal(1200, result.Total);
    }

    [Fact]
    public void ProvidersReportCapabilitiesWithoutSecrets()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        var none = net.Fetcher.Providers();
        Assert.Equal((true, false, false, false, false), (none.Mdblist, none.TmdbLists, none.TmdbCharts, none.Trakt, none.Imdb));
        config.TMDB_API_KEY = "k";
        config.TraktClientId = "t";
        config.ListPlaceholdersImdbEnabled = true;
        config.ListPlaceholdersSyncEnabled = true;
        var all = net.Fetcher.Providers();
        Assert.Equal((true, true, true, true, true, 1000), (all.TmdbLists, all.TmdbCharts, all.Trakt, all.Imdb, all.SyncEnabled, all.MaxItems));
        var json = System.Text.Json.JsonSerializer.Serialize(all);
        Assert.DoesNotContain("\"k\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"t\"", json, StringComparison.Ordinal);
    }

    // ── Review round ────────────────────────────────────────────────────

    [Fact]
    public async Task MdblistApiPagesBeyondTheCapAreReportedAsTruncated()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.MdblistApiKey = "mdb-key";
        var page = string.Join(',', Enumerable.Range(1, 1000).Select(i => $"{{\"ids\":{{\"tmdb\":{i}}},\"title\":\"M{i}\",\"mediatype\":\"movie\"}}"));
        var options = new SourceFetchOptions { AllowMdblistApi = true, Fresh = true };

        // Exactly 1000 entries plus a continuation cursor in the body.
        net.Routes["https://api.mdblist.com/lists/me/big/items"] = _ => Json("{\"items\":[" + page + "],\"pagination\":{\"has_more\":true,\"next_cursor\":\"abc\"}}");
        var cursor = await net.Fetch("https://mdblist.com/lists/me/big", options);
        Assert.True(cursor.Ok);
        Assert.Equal((1000, true), (cursor.Items.Count, cursor.Truncated));

        // The X-Has-More header alone.
        net.Routes["https://api.mdblist.com/lists/me/big/items"] = _ =>
        {
            var response = Json("{\"items\":[{\"ids\":{\"tmdb\":1},\"mediatype\":\"movie\"}]}");
            response.Headers.Add("X-Has-More", "true");
            return response;
        };
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/big", options)).Truncated);

        // A full page without pagination facts is never taken as complete; a short last page is.
        net.Routes["https://api.mdblist.com/lists/me/big/items"] = _ => Json("{\"items\":[" + page + "]}");
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/big", options)).Truncated);
        net.Routes["https://api.mdblist.com/lists/me/big/items"] = _ => Json("{\"items\":[{\"ids\":{\"tmdb\":1},\"mediatype\":\"movie\"}],\"pagination\":{\"has_more\":false,\"next_cursor\":null}}");
        Assert.False((await net.Fetch("https://mdblist.com/lists/me/big", options)).Truncated);
    }

    [Fact]
    public async Task ALinkPinnedToThePublicMdblistJsonNeverFallsBackToTheApi()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.MdblistApiKey = "mdb-key";
        net.Routes["https://api.mdblist.com/lists/me/gone-private/items"] = _ => Json("{\"items\":[{\"ids\":{\"tmdb\":1},\"mediatype\":\"movie\"}]}");

        var pinned = await net.Fetch("https://mdblist.com/lists/me/gone-private", new SourceFetchOptions { AllowMdblistApi = true, Provider = "mdblist", Fresh = true });
        Assert.Equal("not_found", pinned.ErrorCode);
        Assert.Contains("publicly", pinned.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(net.Requests, r => r.RequestUri!.Host == "api.mdblist.com");

        // Unpinned (preview / link) and API-pinned fetches may use the API.
        Assert.Equal("mdblist-api", (await net.Fetch("https://mdblist.com/lists/me/gone-private", new SourceFetchOptions { AllowMdblistApi = true, Fresh = true })).Provider);
        Assert.Equal("mdblist-api", (await net.Fetch("https://mdblist.com/lists/me/gone-private", new SourceFetchOptions { AllowMdblistApi = true, Provider = "mdblist-api", Fresh = true })).Provider);
    }

    [Fact]
    public async Task ImdbErrorsNextToDataMakeThePartialFlag()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ListPlaceholdersImdbEnabled = true;
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json("{\"errors\":[{\"message\":\"resolver failed\",\"path\":[\"list\",\"items\",\"edges\",1,\"node\",\"item\"],\"extensions\":{\"code\":\"INTERNAL_SERVER_ERROR\"}}],"
            + "\"data\":{\"list\":{\"name\":{\"originalText\":\"Mine\"},\"items\":{\"total\":2,\"edges\":[{\"node\":{\"item\":{\"id\":\"tt0770828\",\"titleText\":{\"text\":\"Man of Steel\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":2013}}}},{\"node\":{\"item\":null}}],"
            + "\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null}}}}}");

        var result = await net.Fetch("https://www.imdb.com/list/ls000000002/");

        Assert.True(result.Ok);
        Assert.True(result.Partial);
        Assert.False(result.Truncated);
        Assert.Equal("imdb|tt0770828||", Assert.Single(result.Items).Key);
    }

    [Fact]
    public async Task ProviderSwitchesApplyBeforeTheCache()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        config.ListPlaceholdersImdbEnabled = true;
        config.TraktClientId = "trakt-client";
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json("{\"data\":{\"chartTitles\":{\"total\":1,\"edges\":[{\"node\":{\"id\":\"tt0903747\",\"titleText\":{\"text\":\"Breaking Bad\"},\"titleType\":{\"id\":\"tvSeries\"}}}],\"pageInfo\":{\"hasNextPage\":false}}}}");
        net.Routes["https://api.trakt.tv/movies/popular"] = _ => Json("[{\"title\":\"Dune\",\"year\":2021,\"ids\":{\"tmdb\":438631}}]");
        Assert.True((await net.Fetch("https://www.imdb.com/chart/toptv/")).Ok);
        Assert.True((await net.Fetch("https://trakt.tv/movies/popular")).Ok);

        config.ListPlaceholdersImdbEnabled = false;
        config.TraktClientId = string.Empty;
        Assert.Equal("imdb_disabled", (await net.Fetch("https://www.imdb.com/chart/toptv/")).ErrorCode);
        Assert.Equal("trakt_not_configured", (await net.Fetch("https://trakt.tv/movies/popular")).ErrorCode);
    }
}
