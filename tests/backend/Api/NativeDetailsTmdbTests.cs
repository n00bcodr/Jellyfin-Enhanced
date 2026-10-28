#if JF12
// Partial of ApiNativeDetailsTests, whose rig and the native-details pages it drives are Jellyfin 12 only (the plugin
// compiles them under JF12), like the rest of that class.
using System.Net;
using Jellyfin.Data;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Moq;

namespace JE.Tests;

/// <summary>
/// Requests &amp; downloads, A1 (SEERR-OFF-1): in Jellyfin Enhanced mode a title that isn't in the library has its native
/// pages from TMDB, gated on JE's own metadata (backend je + a TMDB key), never on Seerr, and no route behind them
/// contacts Seerr. Seerr mode keeps its source and gates.
/// </summary>
public partial class ApiNativeDetailsTests
{
    // TMDB's own answers (snake_case, appended sub-resources) for the titles the Seerr-shaped fixtures above describe.
    private const string TmdbMovie = """
    {"id":693134,"title":"Dune: Part Two","original_title":"Dune: Part Two","overview":"Paul unites with the Fremen.","tagline":"Long live the fighters.",
     "release_date":"2024-02-27","runtime":167,"vote_average":8.14,"vote_count":5000,"status":"Released","budget":190000000,"revenue":714000000,"original_language":"en",
     "genres":[{"id":878,"name":"Science Fiction"},{"id":12,"name":"Adventure"}],"production_companies":[{"id":923,"name":"Legendary Pictures","logo_path":"/l.png","origin_country":"US"}],
     "production_countries":[{"iso_3166_1":"US","name":"United States of America"}],"spoken_languages":[{"english_name":"English","iso_639_1":"en","name":"English"}],
     "poster_path":"/poster.jpg","backdrop_path":"/back.jpg","imdb_id":"tt15239678",
     "belongs_to_collection":{"id":726871,"name":"Dune Collection","poster_path":"/dc.jpg","backdrop_path":"/dcb.jpg"},
     "credits":{"cast":[{"id":1190668,"cast_id":3,"name":"Timothée Chalamet","character":"Paul","profile_path":"/p.jpg","order":0},{"id":3810,"name":"Javier Bardem","character":"Stilgar","profile_path":"/jb.jpg","order":1}],
                "crew":[{"id":137427,"name":"Denis Villeneuve","job":"Director","department":"Directing","profile_path":null}]},
     "release_dates":{"results":[{"iso_3166_1":"US","release_dates":[{"type":3,"certification":"PG-13"}]}]},
     "external_ids":{"imdb_id":"tt15239678","facebook_id":"DuneMovie"},
     "videos":{"results":[{"site":"YouTube","type":"Trailer","key":"abc_DEF-123","name":"Trailer"},{"site":"Vimeo","type":"Teaser","key":"999","name":"Teaser"}]},
     "keywords":{"keywords":[{"id":1,"name":"desert"},{"id":2,"name":"sandworm"}]},
     "watch/providers":{"results":{"US":{"link":"https://www.themoviedb.org/movie/693134/watch","flatrate":[{"provider_id":384,"provider_name":"Max","logo_path":"/max.jpg","display_priority":1}]}}}}
    """;

    private const string TmdbSeries = """
    {"id":83867,"name":"Andor","original_name":"Andor","first_air_date":"2022-09-21","last_air_date":"2025-05-13","status":"Ended","episode_run_time":[45],"vote_average":8.3,
     "poster_path":"/sp.jpg","backdrop_path":"/sb.jpg","genres":[{"id":18,"name":"Drama"}],"networks":[{"id":2739,"name":"Disney+"}],
     "created_by":[{"id":5,"name":"Tony Gilroy","profile_path":"/tg.jpg"}],
     "seasons":[{"season_number":1,"name":"Season 1","episode_count":3,"air_date":"2022-09-21","poster_path":"/s1.jpg"},{"season_number":2,"name":"Season 2","episode_count":12,"air_date":"2025-04-22","poster_path":"/s2.jpg"}],
     "last_episode_to_air":{"season_number":2,"episode_number":12,"air_date":"2025-05-13"},
     "credits":{"cast":[{"id":3810,"name":"Javier Bardem","character":"Guest","order":0}],"crew":[]},
     "content_ratings":{"results":[{"iso_3166_1":"US","rating":"TV-14"}]},"external_ids":{"tvdb_id":393189,"imdb_id":"tt9253284"},
     "videos":{"results":[]},"keywords":{"results":[{"id":3,"name":"rebellion"}]},"watch/providers":{"results":{}}}
    """;

    private const string TmdbSeason = """
    {"id":1,"season_number":1,"name":"Season 1","air_date":"2022-09-21","episodes":[
     {"episode_number":1,"season_number":1,"name":"Kassa","overview":"Cassian looks for his sister.","air_date":"2022-09-21","still_path":"/e1.jpg","vote_average":7.4,"runtime":40},
     {"episode_number":2,"season_number":1,"name":"That Would Be Me","air_date":"2022-09-21","still_path":"/e2.jpg"},
     {"episode_number":3,"season_number":1,"name":"Reckoning","air_date":"2022-09-21","still_path":null}]}
    """;

    private const string TmdbPerson = """
    {"id":3810,"name":"Javier Bardem","biography":"Spanish actor.","birthday":"1969-03-01","deathday":null,"place_of_birth":"Las Palmas, Spain",
     "known_for_department":"Acting","imdb_id":"nm0000849","profile_path":"/jb.jpg","adult":false,"popularity":12.5}
    """;

    private const string TmdbCredits = """
    {"id":3810,"cast":[{"id":693134,"media_type":"movie","title":"Dune: Part Two","character":"Stilgar","release_date":"2024-02-27","vote_count":5000,"poster_path":"/poster.jpg"},
                       {"id":83867,"media_type":"tv","name":"Andor","character":"Guest","first_air_date":"2022-09-21","vote_count":900}],
     "crew":[{"id":1,"media_type":"movie","title":"Produced","job":"Producer","department":"Production"}]}
    """;

    private const string TmdbRelated = """
    {"page":1,"total_pages":1,"total_results":2,"results":[{"id":438631,"title":"Dune","release_date":"2021-09-15","poster_path":"/d1.jpg","vote_average":7.8},
                                                           {"id":335984,"media_type":"movie","title":"Blade Runner 2049","poster_path":"/br.jpg"}]}
    """;

    private const string TmdbCollection = """
    {"id":726871,"name":"Dune Collection","overview":"The saga.","poster_path":"/dc.jpg","backdrop_path":"/dcb.jpg","parts":[
     {"id":438631,"media_type":"movie","title":"Dune","release_date":"2021-09-15","poster_path":"/d1.jpg"},{"id":693134,"title":"Dune: Part Two","release_date":"2024-02-27"}]}
    """;

    /// <summary>
    /// TMDB on the wire: the fixtures above by path (every other title is TMDB's 404), with every request recorded and any
    /// host other than TMDB's API recorded as foreign and failed.
    /// </summary>
    private sealed class TmdbNet : IDisposable
    {
        public List<string> Paths { get; } = new();
        public List<string> Foreign { get; } = new();
        public bool Down { get; set; }
        public IntegrationTransport Transport { get; }

        public TmdbNet()
        {
            Transport = new IntegrationTransport((req, _) =>
            {
                var uri = req.RequestUri!;
                if (uri.Host != "api.themoviedb.org")
                {
                    lock (Foreign) Foreign.Add(uri.Host + uri.AbsolutePath);
                    throw new HttpRequestException("only TMDB may be read here: " + uri.Host);
                }

                var path = uri.AbsolutePath.Replace("/3/", string.Empty, StringComparison.Ordinal);
                lock (Paths) Paths.Add(path + uri.Query.Replace(uri.Query.Contains("api_key", StringComparison.Ordinal) ? KeyPart(uri.Query) : string.Empty, string.Empty, StringComparison.Ordinal));
                if (Down) return Task.FromResult(IntegrationTransport.Response("""{"status_message":"down"}""", 503));
                var body = path switch
                {
                    "movie/693134" => TmdbMovie,
                    "tv/83867" => TmdbSeries,
                    "tv/83867/season/1" => TmdbSeason,
                    "tv/83867/season/2" => TmdbSeason.Replace("\"season_number\":1", "\"season_number\":2", StringComparison.Ordinal),
                    "person/3810" => TmdbPerson,
                    "person/3810/combined_credits" => TmdbCredits,
                    "movie/693134/recommendations" or "movie/693134/similar" or "tv/83867/recommendations" or "tv/83867/similar" => TmdbRelated,
                    "collection/726871" => TmdbCollection,
                    "movie/693134/images" or "tv/83867/images" => """{"logos":[{"file_path":"/logo.png","iso_639_1":"en"}]}""",
                    "genre/movie/list" => """{"genres":[{"id":878,"name":"Science Fiction"}]}""",
                    "genre/tv/list" => """{"genres":[{"id":18,"name":"Drama"}]}""",
                    "company/923" => """{"id":923,"name":"Legendary Pictures"}""",
                    "network/2739" => """{"id":2739,"name":"Disney+"}""",
                    _ => null,
                };
                return Task.FromResult(body == null
                    ? IntegrationTransport.Response("""{"success":false,"status_code":34}""", 404)
                    : IntegrationTransport.Response(body));
            });
        }

        private static string KeyPart(string query)
        {
            var start = query.IndexOf("api_key=", StringComparison.Ordinal);
            var end = query.IndexOf('&', start);
            return end < 0 ? query.Substring(start) : query.Substring(start, end - start + 1);
        }

        public void Dispose() => Transport.Dispose();
    }

    /// <summary>A rig over the production router (Seerr source on the rig's Seerr transport, TMDB source on <paramref name="net"/>).</summary>
    private static Rig ModeRig(TmdbNet net, List<IDisposable> owned)
        => new(source: r =>
        {
            var seerrCache = new TmdbResponseCache(r.Seerr, TimeProvider.System);
            var tmdbCache = new TmdbResponseCache(net.Transport, TimeProvider.System);
            owned.Add(seerrCache);
            owned.Add(tmdbCache);
            return new ModeNativeDetailsSource(new SeerrNativeDetailsSource(r.Seerr, seerrCache, r.Plugin.Core.Logger), new TmdbNativeDetailsSource(tmdbCache, null, r.Plugin.Core.Logger));
        });

    private static void JeModeWithTmdb(Rig rig, bool seerrConfigured)
    {
        JellyfinEnhancedMode(rig);
        var c = rig.Plugin.Plugin.Configuration;
        c.TMDB_API_KEY = "test-tmdb";
        if (!seerrConfigured)
        {
            // Seerr completely off: no switch, no address, no key.
            c.JellyseerrEnabled = false;
            c.JellyseerrUrls = string.Empty;
            c.JellyseerrApiKey = string.Empty;
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InJellyfinEnhancedModeEveryNativeRouteOfAnAbsentMovieAndSeriesReadsTmdbAndNeverSeerr(bool seerrStillConfigured)
    {
        using var net = new TmdbNet();
        var owned = new List<IDisposable>();
        using var rig = ModeRig(net, owned);
        try
        {
            JeModeWithTmdb(rig, seerrStillConfigured);
            var admin = rig.Person(admin: true, linked: false);
            var viewer = rig.Person(linked: false);
            viewer.DisplayMissingEpisodes = true;
            var pages = new NativeDetailsPages(rig.Callers.Users.Object, Host(), rig.Used, rig.Policy, () => new DateTime(2026, 10, 24, 0, 0, 0, DateTimeKind.Utc), rig.SpoilerUsers);
            foreach (var who in new[] { admin, viewer })
            {
                var me = Me(who);
                // Details: the movie, series, season and episode pages, and the person a credit leads to.
                var movie = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result);
                Assert.Equal("Dune: Part Two", movie.Name);
                Assert.Equal("PG-13", movie.OfficialRating);
                Assert.Equal("tt15239678", movie.ProviderIds["Imdb"]);
                Assert.Equal(new[] { "https://www.youtube.com/watch?v=abc_DEF-123" }, movie.RemoteTrailers.Select(t => t.Url));
                Assert.Contains(movie.People, p => p.Type == PersonKind.Director && p.Name == "Denis Villeneuve");
                var bardem = movie.People.Single(p => p.Name == "Javier Bardem");
                Assert.True(SyntheticId.TryParse(bardem.Id, Server, out var personPage) && personPage.Kind == SyntheticKind.Person);
                Assert.True(movie.ImageTags.ContainsKey(MediaBrowser.Model.Entities.ImageType.Logo));
                var series = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Series(83867)) })).Result);
                Assert.Equal("Andor", series.Name);
                Assert.Equal("393189", series.ProviderIds["Tvdb"]);
                Assert.Equal("TV-14", series.OfficialRating);
                Assert.Equal(2, series.ChildCount);
                Assert.Equal("Season 1", Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result).Name);
                Assert.Equal("Kassa", Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 1)) })).Result).Name);
                var person = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = bardem.Id })).Result);
                Assert.Equal("Spanish actor.", person.Overview);
                // Seasons and episodes lists.
                var seasons = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetSeasons", me, new() { ["seriesId"] = Id(SyntheticId.Series(83867)) })).Result);
                Assert.Equal(new int?[] { 1, 2 }, seasons.Items.Select(s => s.IndexNumber));
                if (who == viewer)
                {
                    var episodes = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = Id(SyntheticId.Series(83867)), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
                    Assert.Equal(new[] { "Kassa", "That Would Be Me", "Reckoning" }, episodes.Items.Select(e => e.Name));
                }

                // Related: the page's own "More like this" row and the related feeds.
                var similar = Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetSimilarItems", me, new() { ["itemId"] = Id(SyntheticId.Movie(693134)), ["limit"] = 12 })).Result);
                Assert.Equal(new[] { "Dune", "Blade Runner 2049" }, similar.Items.Select(i => i.Name));
                foreach (var relation in new[] { "similar", "recommendations" })
                {
                    Assert.Equal(new[] { "Dune", "Blade Runner 2049" }, Names(Body(await rig.Feeds.RelatedAsync(who, true, 693134, relation, 1, CancellationToken.None))));
                    // A series list: the row naming no type is the list's kind; the one TMDB marks a movie is left out.
                    Assert.Equal(new[] { "Dune" }, Names(Body(await rig.Feeds.RelatedAsync(who, false, 83867, relation, 1, CancellationToken.None))));
                }

                // Credits: the person's filmography.
                var films = Body(await rig.Feeds.FilmographyAsync(who, 3810, CancellationToken.None)).GetProperty("results").EnumerateArray().Select(r => r.TryGetProperty("title", out var t) ? t.GetString() : r.GetProperty("name").GetString()).ToList();
                Assert.Contains("Dune: Part Two", films);
                Assert.Contains("Andor", films);
                // Collection membership: the movie names its collection; the collection lists its movies.
                var details = Body(await rig.Feeds.TitleAsync(who, true, 693134, CancellationToken.None));
                Assert.Equal(726871, details.GetProperty("collection").GetProperty("id").GetInt32());
                Assert.Equal("Max", details.GetProperty("watchProviders")[0].GetProperty("flatrate")[0].GetProperty("name").GetString());
                var collection = Body(await rig.Feeds.CollectionAsync(who, 726871, CancellationToken.None));
                Assert.Equal("Dune Collection", collection.GetProperty("name").GetString());
                Assert.Equal(new[] { "Dune", "Dune: Part Two" }, collection.GetProperty("parts").EnumerateArray().Select(p => p.GetProperty("title").GetString()));
                // The series and season details the More Info window and the request sheet read.
                Assert.Equal(393189, Body(await rig.Feeds.TitleAsync(who, false, 83867, CancellationToken.None)).GetProperty("externalIds").GetProperty("tvdbId").GetInt32());
                Assert.Equal(3, Body(await rig.Feeds.SeasonAsync(who, 83867, 1, CancellationToken.None)).GetProperty("episodes").GetArrayLength());
                // Seerr's own ratings: none in JE mode, which is an answer (no error for the page to log).
                var ratings = await rig.Feeds.RatingsAsync(who, true, 693134, CancellationToken.None);
                Assert.Equal(FeedOutcome.Ok, ratings.Outcome);
                Assert.Equal("null", ratings.Json);
                // Request & status routes resolve the pages by key, from the same source.
                var movieKey = await pages.ResolveAsync(who.Id, Id(SyntheticId.Movie(693134)), CancellationToken.None);
                Assert.Equal(AbsentLookup.Found, movieKey.Outcome);
                Assert.Equal("movie:tmdb:693134", movieKey.Title!.Title.ToString());
                var episodeKey = await pages.ResolveAsync(who.Id, Id(SyntheticId.EpisodeOf(83867, 1, 2)), CancellationToken.None);
                Assert.Equal(AbsentLookup.Found, episodeKey.Outcome);
                Assert.Equal("tv:tvdb:393189", episodeKey.Title!.Title.ToString());
            }

            Assert.Empty(rig.SeerrReads);
            Assert.Empty(net.Foreign);
            Assert.Contains(net.Paths, p => p.StartsWith("movie/693134?append_to_response=", StringComparison.Ordinal));
        }
        finally
        {
            foreach (var o in owned) o.Dispose();
        }
    }

    [Fact]
    public async Task InJellyfinEnhancedModeATitleTmdbDoesntKnowIsAnHonestNotFoundAndAnOutageIsRetryableNeverSeerr()
    {
        using var net = new TmdbNet();
        var owned = new List<IDisposable>();
        using var rig = ModeRig(net, owned);
        try
        {
            JeModeWithTmdb(rig, seerrConfigured: true);
            var viewer = rig.Person(linked: false);
            var me = Me(viewer);
            // No TMDB match: answered like a missing item (the page shows its "not available" state), never a crash or Seerr.
            Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Movie(424242)) })).Result));
            Assert.Equal(FeedOutcome.NotFound, (await rig.Feeds.TitleAsync(viewer, false, 424242, CancellationToken.None)).Outcome);
            Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.SeasonOf(83867, 7)) })).Result));
            // TMDB down: retryable 503 (the page says it can't be loaded now), not "no such title".
            net.Down = true;
            Assert.Equal(503, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Series(1399)) })).Result));
            Assert.Equal(FeedOutcome.Unavailable, (await rig.Feeds.TitleAsync(viewer, true, 1399, CancellationToken.None)).Outcome);
            Assert.Empty(rig.SeerrReads);
            Assert.Empty(net.Foreign);
        }
        finally
        {
            foreach (var o in owned) o.Dispose();
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TheJeBackendWithSeerrSettingsKeptReadsTmdbAndNeverAsksSeerrForAnAccountOrATitle(bool rolloutOn)
    {
        // BEH-02: a strict-JE server keeps its Seerr settings (and answers every Seerr route with backend_disabled);
        // backend je alone selects TMDB, with or without the request rollout switches, and no Seerr account is asked for.
        using var net = new TmdbNet();
        var owned = new List<IDisposable>();
        using var rig = ModeRig(net, owned);
        try
        {
            var c = rig.Plugin.Plugin.Configuration;
            c.ArrRequestBackend = "je";
            c.ArrIntegrationEnabled = rolloutOn;
            c.ArrPhase1Enabled = rolloutOn;
            c.ArrPhase3Enabled = rolloutOn;
            c.TMDB_API_KEY = "test-tmdb";
            Assert.True(NativeDetailsPolicy.SeerrConfigured(c));
            var unlinked = rig.Person(linked: false);
            unlinked.DisplayMissingEpisodes = true;
            var me = Me(unlinked);
            Assert.Equal(NativeDetailsPolicy.Access.Allowed, await rig.Policy.ViewerAccessAsync(unlinked, CancellationToken.None));
            Assert.Equal("Dune: Part Two", Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result).Name);
            Assert.Equal("Kassa", Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 1)) })).Result).Name);
            Assert.Equal(3, Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = Id(SyntheticId.Series(83867)), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result).Items.Count);
            // The More Info window's public details answer for the JE backend (native pages on or off).
            c.NativeAbsentDetailsEnabled = false;
            Assert.True(NativeDetailsPolicy.PublicDetailsEnabled(c));
            Assert.Equal("Andor", Body(await rig.Feeds.TitleAsync(unlinked, false, 83867, CancellationToken.None)).GetProperty("name").GetString());
            Assert.Equal("Dune Collection", Body(await rig.Feeds.CollectionAsync(unlinked, 726871, CancellationToken.None)).GetProperty("name").GetString());
            Assert.Empty(rig.SeerrReads);
            Assert.Empty(net.Foreign);
        }
        finally
        {
            foreach (var o in owned) o.Dispose();
        }
    }

    [Fact]
    public async Task TheParentalTagRefusalWithoutSeerrStaysInJellyfinEnhancedMode()
    {
        // A2 join: missing verified tag evidence withholds the title as retryable unavailable; it is not a permanent policy refusal.
        using var net = new TmdbNet();
        var owned = new List<IDisposable>();
        using var rig = ModeRig(net, owned);
        try
        {
            JeModeWithTmdb(rig, seerrConfigured: false);
            var tagged = rig.Person(linked: false);
            tagged.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
            var withheld = await Call(rig, "UserLibrary", "GetItem", Me(tagged), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) });
            Assert.Equal(503, Assert.IsType<Microsoft.AspNetCore.Mvc.StatusCodeResult>(withheld.Result).StatusCode);
            Assert.Equal(FeedOutcome.Unavailable, (await rig.Feeds.TitleAsync(tagged, true, 693134, CancellationToken.None)).Outcome);
            var plain = rig.Person(linked: false);
            Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", Me(plain), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result));
            Assert.Empty(rig.SeerrReads);
        }
        finally
        {
            foreach (var o in owned) o.Dispose();
        }
    }

    [Fact]
    public async Task InSeerrModeThePagesStillReadSeerrAndNeedItConfigured()
    {
        using var net = new TmdbNet();
        var owned = new List<IDisposable>();
        using var rig = ModeRig(net, owned);
        try
        {
            var c = rig.Plugin.Plugin.Configuration;
            c.TMDB_API_KEY = "test-tmdb";
            var linked = rig.Person();
            // The router's Seerr source is asked (the rig's Seerr transport answers it), TMDB's source never.
            await rig.Used.MovieAsync(693134, CancellationToken.None);
            Assert.Contains(rig.SeerrReads, r => r.EndsWith("/api/v1/movie/693134", StringComparison.Ordinal));
            Assert.DoesNotContain(net.Paths, p => p.StartsWith("movie/693134?append_to_response", StringComparison.Ordinal));
            // A TMDB key alone doesn't make Seerr mode's pages ready: Seerr off refuses them, as before.
            c.JellyseerrEnabled = false;
            Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.ViewerAccessAsync(linked, CancellationToken.None));
        }
        finally
        {
            foreach (var o in owned) o.Dispose();
        }
    }

    [Theory]
    // backend, phases on, Seerr configured, TMDB key -> metadata ready, source
    [InlineData("je", true, false, true, true, "tmdb")]
    [InlineData("je", true, true, true, true, "tmdb")]
    [InlineData("je", true, true, false, false, "tmdb")]   // JE mode never falls back to Seerr
    [InlineData("je", true, false, false, false, "tmdb")]
    [InlineData("je", false, true, true, true, "tmdb")]    // backend je, rollout off: still TMDB, never Seerr (BEH-02)
    [InlineData("je", false, false, true, true, "tmdb")]
    [InlineData("je", false, true, false, false, "tmdb")]
    [InlineData("seerr", true, true, false, true, "seerr")]
    [InlineData("seerr", true, false, true, false, "seerr")]
    [InlineData("seerr", true, true, true, true, "seerr")]
    [InlineData("status_only", true, true, true, true, "seerr")]
    [InlineData("status_only", true, false, true, false, "seerr")]
    public void NativeDetailsAreReadyOnTheRequestModesOwnMetadataEverywhereTheyAreGated(string backend, bool phases, bool seerr, bool tmdb, bool ready, string source)
    {
        using var rig = new Rig();
        var c = rig.Plugin.Plugin.Configuration;
        c.ArrIntegrationEnabled = phases;
        c.ArrPhase1Enabled = phases;
        c.ArrPhase3Enabled = phases;
        c.ArrPhase4Enabled = true;
        c.ArrPhase4HomeRowsEnabled = true;
        c.ArrPhase4HssSectionsEnabled = true;
        c.ArrRequestBackend = backend;
        c.JellyseerrEnabled = seerr;
        if (!seerr)
        {
            c.JellyseerrUrls = string.Empty;
            c.JellyseerrApiKey = string.Empty;
        }

        c.TMDB_API_KEY = tmdb ? "test-tmdb" : string.Empty;
        Assert.Equal(ready, NativeDetailsPolicy.MetadataReady(c));
#if !NET9_0
        // The home sections' native pages, the client's capability and its source (a 10.11 build offers neither).
        Assert.Equal(ready, HomeFlags.NativePages(c));
        var cap = PublicNativeCapability(rig);
        Assert.Equal(ready, cap.GetProperty("Enabled").GetBoolean());
        Assert.Equal(source, cap.GetProperty("Source").GetString());
        // The switch still decides first.
        c.NativeAbsentDetailsEnabled = false;
        Assert.False(HomeFlags.NativePages(c));
        Assert.False(PublicNativeCapability(rig).GetProperty("Enabled").GetBoolean());
#endif
    }

    [Theory]
    [InlineData(true, true, NativeDetailsPolicy.Access.Allowed)]    // JE + TMDB, Seerr configured: no account needed
    [InlineData(false, true, NativeDetailsPolicy.Access.Allowed)]   // JE + TMDB, Seerr off
    [InlineData(true, false, NativeDetailsPolicy.Access.Refused)]   // JE without TMDB: no source (never Seerr's)
    [InlineData(false, false, NativeDetailsPolicy.Access.Refused)]
    public async Task AViewerWithoutASeerrAccountMayUseJellyfinEnhancedModesPagesExactlyWhenTmdbIsReady(bool seerr, bool tmdb, NativeDetailsPolicy.Access expected)
    {
        using var rig = new Rig();
        JellyfinEnhancedMode(rig);
        var c = rig.Plugin.Plugin.Configuration;
        c.JellyseerrEnabled = seerr;
        c.TMDB_API_KEY = tmdb ? "test-tmdb" : string.Empty;
        var unlinked = rig.Person(linked: false);
        Assert.Equal(expected, await rig.Policy.ViewerAccessAsync(unlinked, CancellationToken.None));
        Assert.Equal(expected, await rig.Policy.DetailsAccessAsync(unlinked, CancellationToken.None));
    }

    [Fact]
    public void ARevisionInSeerrModeIsWhatItWasBeforeAndChangesWhenJellyfinEnhancedModesMetadataDoes()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var c = rig.Plugin.Plugin.Configuration;
        var dir = Path.Combine(Path.GetTempPath(), "je-a1-revision-" + Guid.NewGuid().ToString("N"));
        try
        {
            // Policies over one state folder share the epochs' generation, so their revisions compare.
            string Revision() => new NativeDetailsPolicy(ParentalOf(rig), rig.Used, rig.Libraries, null, dir).Revision(viewer);
            var seerrMode = Revision();
            // A TMDB key is no part of Seerr mode's revision (open pages keep their artwork).
            c.TMDB_API_KEY = "test-tmdb";
            Assert.Equal(seerrMode, Revision());
            JellyfinEnhancedMode(rig);
            var ready = Revision();
            Assert.NotEqual(seerrMode, ready);
            // JE mode's metadata going away ends the grants minted while it was there.
            c.TMDB_API_KEY = string.Empty;
            Assert.NotEqual(ready, Revision());
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task TheModeRouterForwardsEveryMemberToTheSourceOfTheModeInEffect()
    {
        // Every member, the interface's defaults included: a default left on the router would answer "unavailable".
        var seerr = new Recording("seerr");
        var tmdb = new Recording("tmdb");
        var je = false;
        INativeDetailsSource router = new ModeNativeDetailsSource(seerr, tmdb, () => je);
        var members = typeof(INativeDetailsSource).GetMethods();
        foreach (var mode in new[] { false, true })
        {
            je = mode;
            foreach (var m in members)
            {
                var args = m.GetParameters().Select(p => p.ParameterType switch
                {
                    var t when t == typeof(int) => (object)1,
                    var t when t == typeof(bool) => true,
                    var t when t == typeof(string) => "genre",
                    var t when t == typeof(Guid) => Guid.NewGuid(),
                    var t when t == typeof(CancellationToken) => CancellationToken.None,
                    _ => null,
                }).ToArray();
                var task = (Task)m.Invoke(router, args)!;
                await task;
            }
        }

        Assert.Equal(members.Length, seerr.Calls.Count);
        Assert.Equal(members.Length, tmdb.Calls.Count);
        Assert.Equal(members.Select(m => m.Name).OrderBy(n => n), seerr.Calls.OrderBy(n => n));
    }

    [Fact]
    public async Task TheTmdbSourceMapsTmdbToSeerrsShapeAndKeepsAMissingFieldUnknown()
    {
        using var net = new TmdbNet();
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        var metadataViewer = Guid.NewGuid();
        using var cache = new TmdbResponseCache(net.Transport, TimeProvider.System);
        var source = new TmdbNativeDetailsSource(cache, null, plugin.Core.Logger);
        var movie = (await source.MovieAsync(693134, metadataViewer, CancellationToken.None)).Data!.Value;
        Assert.Equal("Dune: Part Two", movie.GetProperty("title").GetString());
        Assert.Equal("2024-02-27", movie.GetProperty("releaseDate").GetString());
        Assert.Equal("/poster.jpg", movie.GetProperty("posterPath").GetString());
        Assert.Equal("Stilgar", movie.GetProperty("credits").GetProperty("cast")[1].GetProperty("character").GetString());
        Assert.Equal("PG-13", movie.GetProperty("releases").GetProperty("results")[0].GetProperty("release_dates")[0].GetProperty("certification").GetString());
        Assert.Equal("Dune Collection", movie.GetProperty("collection").GetProperty("name").GetString());
        Assert.Equal(new[] { "desert", "sandworm" }, movie.GetProperty("keywords").EnumerateArray().Select(k => k.GetProperty("name").GetString()));
        Assert.Equal(2, movie.GetProperty("relatedVideos").GetArrayLength());
        Assert.False(movie.TryGetProperty("mediaInfo", out _));
        // Repeated reads are one upstream call (the source's own cache, then TMDB's shared one).
        var calls = net.Paths.Count;
        await source.MovieAsync(693134, metadataViewer, CancellationToken.None);
        await source.MovieAsync(693134, Guid.NewGuid(), CancellationToken.None);
        Assert.Equal(calls, net.Paths.Count);
        Assert.Equal(0, source.InFlightCount);

        // A title with almost nothing: every reader still gets a usable page (no poster, no date, no cast, no ids).
        var sparse = JsonDocument.Parse("""{"id":5,"title":null,"genres":null,"credits":{"cast":[{"id":0,"name":"No id"}]},"seasons":"x","external_ids":{}}""").RootElement;
        var m = JsonDocument.Parse(TmdbNativeShape.Movie(sparse).ToJsonString()).RootElement;
        Assert.False(m.TryGetProperty("title", out _));
        Assert.False(m.TryGetProperty("posterPath", out _));
        Assert.False(m.TryGetProperty("imdbId", out _));
        Assert.Equal(0, m.GetProperty("credits").GetProperty("cast").GetArrayLength());
        var s = JsonDocument.Parse(TmdbNativeShape.Series(sparse).ToJsonString()).RootElement;
        Assert.False(s.TryGetProperty("seasons", out _));
        Assert.False(s.GetProperty("externalIds").TryGetProperty("tvdbId", out _));
        var dtos = new NativeDetailsDtos(Server, Guid.NewGuid(), "rev", new NativeDetailsArtwork(net.Transport, null), "US", NoLinks.Instance);
        var dto = dtos.Movie(SyntheticId.Movie(5), m, null);
        Assert.Equal(string.Empty, dto.Name);
        Assert.Empty(dto.People);
        Assert.Empty(dto.ImageTags);
        Assert.Equal(0, dtos.Series(SyntheticId.Series(5), s, null).ChildCount);

        // TMDB's 404 is "no such title"; an outage or no key is "can't answer now" (never Seerr).
        Assert.True((await source.SeriesAsync(4040, metadataViewer, CancellationToken.None)).NotFound);
        net.Down = true;
        var down = await source.PersonAsync(4141, metadataViewer, CancellationToken.None);
        Assert.False(down.NotFound);
        Assert.Null(down.Data);
        plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        var keyless = new TmdbNativeDetailsSource(cache, null, plugin.Core.Logger);
        Assert.Null((await keyless.MovieAsync(1, CancellationToken.None)).Data);
        Assert.False(await keyless.IsSeerrLinkedAsync(Guid.NewGuid(), CancellationToken.None) ?? true);
        Assert.Empty(net.Foreign);
    }

    [Fact]
    public async Task ASeriesTmdbDoesntLinkToTvdbTakesTheIdTheArrLibrariesKnowItBy()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        using var net = new IntegrationTransport((req, _) => Task.FromResult(IntegrationTransport.Response(
            """{"id":777,"name":"Unlinked","seasons":[{"season_number":1,"episode_count":2}],"external_ids":{"tvdb_id":null,"imdb_id":null}}""")));
        var metadataViewer = Guid.NewGuid();
        using var cache = new TmdbResponseCache(net, TimeProvider.System);
        // What the arr libraries hold for the series (TitleAliases.Of in production: memory only).
        IReadOnlyList<TitleKey> Aliases(TitleKey key) => key.ToString() == "tv:tmdb:777"
            ? new[] { TitleKey.Parse("tv:tvdb:4242")!, TitleKey.Parse("tv:imdb:tt0000777")! }
            : Array.Empty<TitleKey>();
        var source = new TmdbNativeDetailsSource(cache, Aliases, plugin.Core.Logger, () => "test-tmdb", () => DateTime.UtcNow);
        var series = (await source.SeriesAsync(777, metadataViewer, CancellationToken.None)).Data!.Value;
        Assert.Equal(4242, series.GetProperty("externalIds").GetProperty("tvdbId").GetInt32());
        Assert.Equal("tt0000777", series.GetProperty("externalIds").GetProperty("imdbId").GetString());
        Assert.Equal("tv:tvdb:4242", NativeDetailsPages.SeriesKey(series, 777).ToString());
    }

    private static string?[] Names(JsonElement body)
        => body.GetProperty("results").EnumerateArray().Select(r => r.TryGetProperty("title", out var t) ? t.GetString() : r.GetProperty("name").GetString()).ToArray();

    private static MediaBrowser.Controller.IServerApplicationHost Host()
    {
        var host = new Mock<MediaBrowser.Controller.IServerApplicationHost>();
        host.SetupGet(h => h.SystemId).Returns(Server);
        return host.Object;
    }

    private static JsonElement PublicNativeCapability(Rig rig)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<MediaBrowser.Controller.Library.IUserManager>(), Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), rig.Plugin.Core.Paths.Object, rig.Plugin.Core.Logger);
        var controller = ApiAssetTests.Controller(rig.Plugin.Core, maintenance);
        controller.HttpContext.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.Role, "User")], "test"));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.GetPublicConfig()).Value));
        return document.RootElement.GetProperty("NativeAbsentDetails").Clone();
    }

    private static SeerrParentalFilter ParentalOf(Rig rig)
        => (SeerrParentalFilter)typeof(Rig).GetField("_parental", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(rig)!;

    /// <summary>A source that records which member was asked and answers nothing.</summary>
    private sealed class Recording(string name) : INativeDetailsSource
    {
        public string Name { get; } = name;
        public List<string> Calls { get; } = new();
        private Task<SourceAnswer> Note(string member) { lock (Calls) Calls.Add(member); return Task.FromResult(SourceAnswer.Unavailable); }
        public Task<SourceAnswer> MovieAsync(int tmdb, CancellationToken ct) => Note(nameof(MovieAsync));
        public Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct) => Note(nameof(SeriesAsync));
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct) => Note(nameof(SeasonAsync));
        public Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct) { lock (Calls) Calls.Add(nameof(RecommendationsAsync)); return Task.FromResult<JsonElement?>(null); }
        public Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct) { lock (Calls) Calls.Add(nameof(LogoPathAsync)); return Task.FromResult<string?>(null); }
        public Task<SourceAnswer> PersonAsync(int tmdb, CancellationToken ct) => Note(nameof(PersonAsync));
        public Task<SourceAnswer> GenresAsync(bool movie, CancellationToken ct) => Note(nameof(GenresAsync));
        public Task<SourceAnswer> StudioAsync(int tmdb, CancellationToken ct) => Note(nameof(StudioAsync));
        public Task<SourceAnswer> NetworkAsync(int tmdb, CancellationToken ct) => Note(nameof(NetworkAsync));
        public Task<SourceAnswer> PersonCreditsAsync(int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(PersonCreditsAsync));
        public Task<SourceAnswer> DiscoverAsync(bool movie, string filter, int id, int page, string? sortBy, Guid viewer, CancellationToken ct) => Note(nameof(DiscoverAsync));
        public Task<SourceAnswer> CompanySeriesAsync(int company, int page, string? sortBy, Guid viewer, CancellationToken ct) => Note(nameof(CompanySeriesAsync));
        public Task<SourceAnswer> MovieAsync(int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(MovieAsync));
        public Task<SourceAnswer> SeriesAsync(int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(SeriesAsync));
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, Guid viewer, CancellationToken ct) => Note(nameof(SeasonAsync));
        public Task<SourceAnswer> PersonAsync(int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(PersonAsync));
        public Task<SourceAnswer> StudioAsync(int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(StudioAsync));
        public Task<SourceAnswer> NetworkAsync(int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(NetworkAsync));
        public Task<SourceAnswer> GenresAsync(bool movie, Guid viewer, CancellationToken ct) => Note(nameof(GenresAsync));
        public Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct) { lock (Calls) Calls.Add(nameof(RecommendationsAsync)); return Task.FromResult<JsonElement?>(null); }
        public Task<string?> LogoPathAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct) { lock (Calls) Calls.Add(nameof(LogoPathAsync)); return Task.FromResult<string?>(null); }
        public Task<SourceAnswer> RatingsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct) => Note(nameof(RatingsAsync));
        public Task<SourceAnswer> RelatedAsync(bool movie, int tmdb, string relation, int page, Guid viewer, CancellationToken ct) => Note(nameof(RelatedAsync));
        public Task<SourceAnswer> CollectionAsync(int collection, Guid viewer, CancellationToken ct) => Note(nameof(CollectionAsync));
        public Task<SourceAnswer> KeywordsAsync(string query, Guid viewer, CancellationToken ct) => Note(nameof(KeywordsAsync));
        public Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct) { lock (Calls) Calls.Add(nameof(IsSeerrLinkedAsync)); return Task.FromResult<bool?>(null); }
    }

    /// <summary>Names lead nowhere (the DTO mapping alone).</summary>
    private sealed class NoLinks : ITitleLinks
    {
        public static readonly NoLinks Instance = new();
        public (Guid Id, string? ImageTag)? Person(string name, int tmdb) => null;
        public Guid? Genre(string name, int tmdb) => null;
        public Guid? Studio(string name, int tmdb, bool network) => null;
        public bool Tag(string name) => false;
    }
}
#endif
