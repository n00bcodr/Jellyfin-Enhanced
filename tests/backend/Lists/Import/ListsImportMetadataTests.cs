using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace JE.Tests;

// The JE-only metadata adapter (track 4c2a): title lookups and list metadata from TMDB with Jellyfin Enhanced's own key,
// so a household without Seerr can import and keep entries current. Same query language and result states as the Seerr
// lookup, the same PlaceholderMetadata semantics as the Seerr reader (Seerr stays first when it is set up), and the
// production viewer policy over the real per-person files.
[Collection("Plugin singleton")]
public class ListsImportMetadataTests
{
    private sealed class Net : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<string> Calls { get; } = new();
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public TmdbImportLookup Lookup { get; }
        public ImportCallContext Context { get; } = new("test", false);

        public Net()
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Calls)
                {
                    Calls.Add(request.RequestUri!.Host + request.RequestUri.PathAndQuery);
                }

                var key = request.RequestUri!.GetLeftPart(UriPartial.Path);
                return Task.FromResult(Routes.TryGetValue(key, out var route) ? route(request) : IntegrationTransport.Response("{\"status_code\":34}", 404));
            });
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            Lookup = new TmdbImportLookup(Tmdb, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger);
            Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        }

        public void Dispose()
        {
            Tmdb.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static HttpResponseMessage Json(string body, int status = 200) => IntegrationTransport.Response(body, status);

    private const string Multi = "{\"page\":1,\"results\":[{\"id\":49521,\"media_type\":\"movie\",\"title\":\"Man of Steel\",\"original_title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"poster_path\":\"/pgqgaUx1cJb5oYQQ5v0tNARCeBp.jpg\",\"overview\":\"A child is sent to Earth.\",\"popularity\":36.3,\"vote_count\":16680},"
        + "{\"id\":73968,\"media_type\":\"person\",\"name\":\"Henry Cavill\"},"
        + "{\"id\":1,\"media_type\":\"movie\",\"title\":\"Adult\",\"adult\":true},"
        + "{\"id\":2,\"media_type\":\"tv\",\"name\":\"Bad poster\",\"first_air_date\":\"\",\"poster_path\":\"https://evil.test/x.jpg\"}]}";

    private const string Peacemaker = "{\"id\":110492,\"name\":\"Peacemaker\",\"first_air_date\":\"2022-01-13\",\"in_production\":true,\"status\":\"Returning Series\",\"external_ids\":{\"imdb_id\":\"tt13146488\",\"tvdb_id\":391153},"
        + "\"last_episode_to_air\":{\"season_number\":2,\"episode_number\":8,\"air_date\":\"2025-10-09\"},\"next_episode_to_air\":null,\"poster_path\":\"/hE3LRZAY84fG19a18pzpkZERjTE.jpg\",\"overview\":\"The continuing story.\","
        + "\"seasons\":[{\"season_number\":0,\"episode_count\":3,\"air_date\":\"2022-11-21\",\"name\":\"Specials\"},{\"season_number\":1,\"episode_count\":8,\"air_date\":\"2022-01-13\",\"name\":\"Season 1\"},{\"season_number\":2,\"episode_count\":8,\"air_date\":\"2025-08-21\",\"name\":\"Season 2\"}]}";

    private const string PeacemakerS2 = "{\"air_date\":\"2025-08-21\",\"poster_path\":\"/s2.jpg\",\"episodes\":[" + "{\"episode_number\":1,\"season_number\":2,\"name\":\"The Ties That Grind\",\"air_date\":\"2025-08-21\"},{\"episode_number\":2,\"season_number\":2,\"name\":\"A Man Is Only as Good as His Bird\",\"air_date\":\"2025-08-28\"}]}";

    [Fact]
    public async Task SearchesAreTmdbsMultiSearchWithAdultTitlesAndPeopleDropped()
    {
        using var net = new Net();
        net.Routes["https://api.themoviedb.org/3/search/multi"] = request =>
        {
            Assert.Contains("query=Man%20of%20Steel", request.RequestUri!.Query, StringComparison.Ordinal);
            Assert.Contains("include_adult=false", request.RequestUri.Query, StringComparison.Ordinal);
            return Json(Multi);
        };

        var hits = await net.Lookup.SearchAsync("Man  of Steel", net.Context, CancellationToken.None);

        Assert.Equal(LookupStatus.Ok, hits.Status);
        Assert.Equal(2, hits.Value!.Count);
        var movie = hits.Value[0];
        Assert.Equal(("movie", 49521, "Man of Steel", 2013, "/pgqgaUx1cJb5oYQQ5v0tNARCeBp.jpg", 16680), (movie.MediaType, movie.TmdbId, movie.Title, movie.Year, movie.PosterPath, movie.VoteCount));
        Assert.Null(hits.Value[1].PosterPath); // not a TMDB path
        Assert.Null(hits.Value[1].ReleaseDate);
        Assert.Equal("tmdb", net.Lookup.Provider);

        await net.Lookup.SearchAsync("man of steel", net.Context, CancellationToken.None); // cached (normalized)
        Assert.Single(net.Calls);
        Assert.Equal(1, net.Context.Calls);
        Assert.DoesNotContain(net.Calls, c => c.Contains("tmdb-key", StringComparison.Ordinal) && !c.Contains("api_key=tmdb-key", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheYearAndIdFormsUseTheMatchingTmdbEndpoints()
    {
        using var net = new Net();
        net.Routes["https://api.themoviedb.org/3/search/movie"] = request =>
        {
            Assert.Contains("year=2026", request.RequestUri!.Query, StringComparison.Ordinal);
            return Json("{\"results\":[{\"id\":1400940,\"title\":\"Clayface\",\"release_date\":\"2026-10-21\"}]}");
        };
        net.Routes["https://api.themoviedb.org/3/search/tv"] = request =>
        {
            Assert.Contains("first_air_date_year=2026", request.RequestUri!.Query, StringComparison.Ordinal);
            return Json("{\"results\":[]}");
        };
        net.Routes["https://api.themoviedb.org/3/movie/1924"] = _ => Json("{\"id\":1924,\"title\":\"Superman\",\"release_date\":\"1978-12-14\"}");
        net.Routes["https://api.themoviedb.org/3/tv/1924"] = _ => Json("{\"id\":1924,\"name\":\"Survival of the Richest\",\"first_air_date\":\"2010-01-01\"}");
        net.Routes["https://api.themoviedb.org/3/find/tt0770828"] = request =>
        {
            Assert.Contains("external_source=imdb_id", request.RequestUri!.Query, StringComparison.Ordinal);
            return Json("{\"movie_results\":[{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\"}],\"tv_results\":[]}");
        };
        net.Routes["https://api.themoviedb.org/3/find/391153"] = request =>
        {
            Assert.Contains("external_source=tvdb_id", request.RequestUri!.Query, StringComparison.Ordinal);
            return Json("{\"movie_results\":[],\"tv_results\":[{\"id\":110492,\"name\":\"Peacemaker\",\"first_air_date\":\"2022-01-13\"}]}");
        };

        Assert.Equal(1400940, Assert.Single((await net.Lookup.SearchAsync("Clayface year:2026", net.Context, CancellationToken.None)).Value!).TmdbId);
        Assert.Equal(new[] { ("movie", 1924), ("tv", 1924) }, (await net.Lookup.SearchAsync("tmdb:1924", net.Context, CancellationToken.None)).Value!.Select(h => (h.MediaType, h.TmdbId)));
        Assert.Equal(49521, Assert.Single((await net.Lookup.SearchAsync("imdb:tt0770828", net.Context, CancellationToken.None)).Value!).TmdbId);
        Assert.Equal(110492, Assert.Single((await net.Lookup.SearchAsync("tvdb:391153", net.Context, CancellationToken.None)).Value!).TmdbId);
        Assert.Empty((await net.Lookup.SearchAsync("imdb:tt0000001", net.Context, CancellationToken.None)).Value!); // unknown id: no titles
    }

    [Fact]
    public async Task DetailsSeasonsAndEpisodeIdsMapToTheLookupShapes()
    {
        using var net = new Net();
        var fail = true;
        net.Routes["https://api.themoviedb.org/3/tv/110492"] = request =>
        {
            Assert.Contains("append_to_response=external_ids", request.RequestUri!.Query, StringComparison.Ordinal);
            return fail ? Json("{\"status_code\":25}", 429) : Json(Peacemaker);
        };
        net.Routes["https://api.themoviedb.org/3/tv/110492/season/2"] = _ => Json(PeacemakerS2);
        net.Routes["https://api.themoviedb.org/3/find/tt0959621"] = _ => Json("{\"tv_episode_results\":[{\"show_id\":1396,\"season_number\":1,\"episode_number\":1,\"name\":\"Pilot\",\"air_date\":\"2008-01-20\"}]}");

        Assert.Equal(LookupStatus.Transient, (await net.Lookup.GetDetailsAsync("tv", 110492, net.Context, CancellationToken.None)).Status); // a TMDB error is never cached
        fail = false;
        var details = await net.Lookup.GetDetailsAsync("tv", 110492, net.Context, CancellationToken.None);
        Assert.Equal(LookupStatus.Ok, details.Status);
        Assert.Equal(("tt13146488", 391153, true), (details.Value!.ImdbId, details.Value.TvdbId, details.Value.InProduction));
        Assert.Equal(new[] { 0, 1, 2 }, details.Value.Seasons.Select(s => s.SeasonNumber));
        Assert.Equal(8, details.Value.Seasons[2].EpisodeCount);

        var season = await net.Lookup.GetSeasonAsync(110492, 2, net.Context, CancellationToken.None);
        Assert.Equal(("The Ties That Grind", "2025-08-21"), (season.Value![0].Title, season.Value[0].AirDate));
        Assert.Equal(LookupStatus.NotFound, (await net.Lookup.GetSeasonAsync(110492, 9, net.Context, CancellationToken.None)).Status); // TMDB's 404 is a real miss
        Assert.Equal(LookupStatus.NotFound, (await net.Lookup.GetDetailsAsync("person", 5, net.Context, CancellationToken.None)).Status);

        var found = await net.Lookup.FindImdbEpisodeAsync("tt0959621", CancellationToken.None);
        Assert.Equal((1396, 1, 1, "Pilot"), (found.Value!.ShowTmdbId, found.Value.Season, found.Value.Episode, found.Value.Title));
        Assert.True(net.Lookup.CanFindImdbEpisodes);
    }

    [Fact]
    public async Task WithoutAKeyNothingIsAskedAndAnotherKeyNeverReusesAnswers()
    {
        using var net = new Net();
        net.Routes["https://api.themoviedb.org/3/search/multi"] = request => Json("{\"results\":[{\"id\":" + (request.RequestUri!.Query.Contains("api_key=aaaa", StringComparison.Ordinal) ? "1" : "2") + ",\"media_type\":\"movie\",\"title\":\"X\"}]}");
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        Assert.False(net.Lookup.IsConfigured);
        Assert.Equal(LookupStatus.Transient, (await net.Lookup.SearchAsync("X", net.Context, CancellationToken.None)).Status);
        Assert.Empty(net.Calls);

        net.Plugin.Plugin.Configuration.TMDB_API_KEY = "aaaa";
        var a = await net.Lookup.SearchAsync("X", net.Context, CancellationToken.None);
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = "bbbb"; // same length
        var b = await net.Lookup.SearchAsync("X", net.Context, CancellationToken.None);
        Assert.Equal((1, 2), (a.Value![0].TmdbId, b.Value![0].TmdbId));
    }

    [Fact]
    public async Task TheChooserPrefersTheTmdbKeyAndLabelsSeerrAsTheFallback()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        var seerr = new SeerrImportLookup(net.Transport, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), net.Plugin.Core.Logger);
        var chooser = new MetadataImportLookup(net.Lookup, seerr);
        net.Routes["https://api.themoviedb.org/3/search/multi"] = _ => Json(Multi);
        net.Routes["http://seerr.test/api/v1/search"] = _ => Json("{\"results\":[{\"id\":49521,\"mediaType\":\"movie\",\"title\":\"Man of Steel\",\"releaseDate\":\"2013-06-12\"}]}");

        Assert.Equal(("tmdb", true), (chooser.Provider, chooser.IsConfigured));
        await chooser.SearchAsync("Man of Steel", net.Context, CancellationToken.None);
        Assert.All(net.Calls, c => Assert.StartsWith("api.themoviedb.org", c, StringComparison.Ordinal));

        config.TMDB_API_KEY = string.Empty;
        Assert.Equal(("", false), (chooser.Provider, chooser.IsConfigured));
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";
        Assert.Equal(("seerr", true), (chooser.Provider, chooser.IsConfigured));
        Assert.Equal(49521, (await chooser.SearchAsync("Man of Steel", net.Context, CancellationToken.None)).Value![0].TmdbId);
        Assert.Contains(net.Calls, c => c.StartsWith("seerr.test", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnImportResolvesWithoutSeerr()
    {
        using var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/search/multi"] = Multi;
        var tmdb = new TmdbImportLookup(new TmdbResponseCache(h.Lists.Transport, TimeProvider.System), h.Limiter, h.Plugin.Core.Logger);
        var resolver = new ListImportResolver(new MetadataImportLookup(tmdb, new SeerrImportLookup(h.Lists.Transport, h.Limiter, h.Plugin.Core.Logger)), h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger);
        var user = h.NewUser("member");
        Assert.False(h.Plugin.Plugin.Configuration.JellyseerrEnabled);

        var outcome = await resolver.ResolveAsync(new[] { new ImportEntryDto { Title = "Man of Steel", Year = 2013, TypeHint = "movie" } }, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = new[] { user },
            Context = new ImportCallContext("member", false),
        }, CancellationToken.None);

        var result = Assert.Single(outcome.Response.Results);
        Assert.Equal(("high", 49521, "tmdb"), (result.Confidence, result.Match!.TmdbId, outcome.Response.MetadataProvider));
        Assert.DoesNotContain(h.SeerrCalls, c => c.StartsWith("/api/v1", StringComparison.Ordinal));
    }

    // ── List metadata ───────────────────────────────────────────────────

    private static Placeholder Season(int tmdb, int season) => new() { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Season, MediaType = "tv", TmdbId = tmdb, Title = "Peacemaker", SeasonNumber = season };

    [Fact]
    public async Task ListMetadataWithoutSeerrComesFromTmdbBehindItsSwitch()
    {
        using var net = new Net();
        ImportTestFlags.AllOn(net.Plugin.Plugin.Configuration);
        net.Routes["https://api.themoviedb.org/3/tv/110492"] = _ => Json(Peacemaker);
        net.Routes["https://api.themoviedb.org/3/tv/110492/season/2"] = _ => Json(PeacemakerS2);
        net.Routes["https://api.themoviedb.org/3/movie/49521"] = _ => Json("{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"poster_path\":\"/p.jpg\",\"overview\":\"Krypton.\",\"imdb_id\":\"tt0770828\"}");
        var source = new TmdbListMetadataSource(net.Tmdb, net.Plugin.Core.Logger);
        var today = new DateTime(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);

        // Switch off: nothing is read (lists keep working as before).
        Assert.False(TmdbListMetadataSource.IsAvailable);
        Assert.Null(await source.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), today, CancellationToken.None));
        Assert.Empty(net.Calls);

        net.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
        var season = await source.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), today, CancellationToken.None);
        Assert.NotNull(season);
        Assert.Equal(("2025-08-21", "/s2.jpg", 391153, "tt13146488", true, false), (season!.ReleaseDate, season.PosterPath, season.TvdbId, season.ImdbId, season.InProduction, season.Partial));
        Assert.Equal(new[] { 1, 2 }, season.Expected!.Select(e => e.E));

        var movie = await source.FetchAsync(new Placeholder { Id = "m", Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = 49521, Title = "Man of Steel" }, TimeSpan.FromHours(12), today, CancellationToken.None);
        Assert.Equal(("2013-06-12", "/p.jpg", "tt0770828", "Krypton."), (movie!.ReleaseDate, movie.PosterPath, movie.ImdbId, movie.Overview));

        // The list core's own merge applies it as it applies Seerr's answer.
        var entry = Season(110492, 2);
        Assert.True(ListMetadataService.Apply(entry, season));
        Assert.Equal(("2025-08-21", 2), (entry.ReleaseDate, entry.Expected.Count));

        // No key: unavailable, nothing invented.
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        Assert.Null(await source.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), today, CancellationToken.None));
    }

    [Fact]
    public async Task AFailedSeasonReadIsPartialNeverAShrunkenSeason()
    {
        using var net = new Net();
        ImportTestFlags.AllOn(net.Plugin.Plugin.Configuration);
        net.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
        net.Routes["https://api.themoviedb.org/3/tv/110492"] = _ => Json(Peacemaker);
        net.Routes["https://api.themoviedb.org/3/tv/110492/season/2"] = _ => Json("{\"status_code\":11}", 500);
        var source = new TmdbListMetadataSource(net.Tmdb, net.Plugin.Core.Logger);

        var season = await source.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), DateTime.UtcNow, CancellationToken.None);

        Assert.True(season!.Partial);
        Assert.True(season.SeasonReadFailed);
        Assert.Null(season.Expected);
    }

    [Fact]
    public async Task SeerrStaysFirstAndTmdbOnlyStandsInWithoutIt()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        ImportTestFlags.AllOn(config);
        config.ArrPhase4ListJeMetadataEnabled = true;
        net.Routes["https://api.themoviedb.org/3/tv/110492"] = _ => Json(Peacemaker);
        net.Routes["https://api.themoviedb.org/3/tv/110492/season/2"] = _ => Json(PeacemakerS2);
        net.Routes["http://seerr.test/api/v1/tv/110492"] = _ => Json(JsonSerializer.Serialize(TmdbListMetadataSource.Camelize(JsonDocument.Parse(Peacemaker).RootElement)));
        net.Routes["http://seerr.test/api/v1/tv/110492/season/2"] = _ => Json(JsonSerializer.Serialize(TmdbListMetadataSource.Camelize(JsonDocument.Parse(PeacemakerS2).RootElement)));
        var seerrReader = new ListMetadataService(net.Transport, net.Plugin.Core.Logger);
        var sources = new ListMetadataSources(seerrReader, new TmdbListMetadataSource(net.Tmdb, net.Plugin.Core.Logger));
        var today = new DateTime(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);

        var fromTmdb = await sources.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), today, CancellationToken.None);
        Assert.True(sources.Available);
        Assert.All(net.Calls, c => Assert.StartsWith("api.themoviedb.org", c, StringComparison.Ordinal));

        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";
        net.Calls.Clear();
        var fromSeerr = await sources.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), today, CancellationToken.None);
        Assert.All(net.Calls, c => Assert.StartsWith("seerr.test", c, StringComparison.Ordinal));

        // Same answer either way: the adapter only changes where the public data comes from.
        Assert.Equal(Strip(fromSeerr!), Strip(fromTmdb!));

        config.JellyseerrEnabled = false;
        config.ArrPhase4ListJeMetadataEnabled = false;
        Assert.False(sources.Available);
        Assert.Null(await sources.FetchAsync(Season(110492, 2), TimeSpan.FromHours(12), today, CancellationToken.None));
    }

    private static string Strip(PlaceholderMetadata metadata)
    {
        var node = JsonSerializer.SerializeToNode(metadata)!.AsObject();
        node.Remove(nameof(PlaceholderMetadata.FetchedAtUtc));
        return node.ToJsonString();
    }

    [Fact]
    public void CamelizeRenamesEverySnakeCaseKeyAndKeepsValues()
    {
        var camel = TmdbListMetadataSource.Camelize(JsonDocument.Parse("{\"release_date\":\"2013-06-12\",\"external_ids\":{\"tvdb_id\":5,\"imdb_id\":\"tt1\"},\"seasons\":[{\"season_number\":1,\"air_date\":null}],\"id\":3,\"_x\":1}").RootElement);
        Assert.Equal("{\"releaseDate\":\"2013-06-12\",\"externalIds\":{\"tvdbId\":5,\"imdbId\":\"tt1\"},\"seasons\":[{\"seasonNumber\":1,\"airDate\":null}],\"id\":3,\"x\":1}", camel.GetRawText());
    }

    // ── The production viewer policy ────────────────────────────────────

    [Fact]
    public void TheViewerPolicyReadsHiddenContentAndSpoilerGuardFromEachPersonsFiles()
    {
        using var lists = new ListsHarness();
        var manager = lists.Plugin.Core.Manager;
        var viewer = lists.NewUser("viewer");
        var other = lists.NewUser("other");
        var series = lists.Host.AddSeries(tmdb: 1399);
        lists.Host.Hide(series, other);
        manager.SaveUserConfiguration(viewer.Id.ToString("N"), "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["a"] = new() { ItemId = Guid.NewGuid().ToString("N"), Type = "Movie", TmdbId = "49521" },
                ["b"] = new() { Type = "Series", TmdbId = "1399", HideScope = "nextup" }, // not a global hide
            },
        });
        var state = new UserSpoilerBlur();
        state.Series[series.ToString("N")] = new SpoilerBlurSeriesEntry { SeriesId = series.ToString("N") };
        state.PendingTmdb["movie:603"] = new SpoilerBlurPendingEntry { MediaType = "movie", TmdbId = "603" };
        manager.SaveUserConfiguration(viewer.Id.ToString("N"), "spoilerblur.json", state);
        manager.SaveUserConfiguration(other.Id.ToString("N"), "spoilerblur.json", state);
        SpoilerUserResolver.InvalidateUser(viewer.Id.ToString("N"));
        SpoilerUserResolver.InvalidateUser(other.Id.ToString("N"));
        var spoilers = new SpoilerUserResolver(manager, new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>().Object, lists.Plugin.Core.Logger, null!);
        var policy = new UserImportViewerPolicy(manager, lists.Host, lists.Plugin.Core.Logger, spoilers);

        // Spoiler Guard off on the server: no spoiler rules (hidden titles still marked).
        var off = policy.For(viewer);
        Assert.Contains("movie:tmdb:49521", off.HiddenKeys);
        Assert.DoesNotContain("tv:tmdb:1399", off.HiddenKeys);
        Assert.False(off.SpoilerGuarded("tv", 1399));

        lists.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        var on = policy.For(viewer);
        Assert.True(on.SpoilerGuarded("tv", 1399)); // guards a library copy they can open
        Assert.True(on.SpoilerGuarded("movie", 603)); // turned on before it arrived
        Assert.False(on.SpoilerGuarded("tv", 1400));
        // The same file, but the other person can't open that library copy: only the pending entry counts for them.
        var forOther = policy.For(other);
        Assert.False(forOther.SpoilerGuarded("tv", 1399));
        Assert.True(forOther.SpoilerGuarded("movie", 603));
        Assert.Empty(forOther.HiddenKeys);
        _ = CultureInfo.InvariantCulture;
    }
}
