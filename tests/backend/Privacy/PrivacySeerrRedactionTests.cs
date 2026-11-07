using System.Security.Claims;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacySeerrRedactionTests
{
    private const string MovieJson = """
        {"id":299534,"mediaType":"movie","title":"Endgame","overview":"Secret plot","tagline":"Secret tagline",
         "voteAverage":8.2,"voteCount":26000,"releaseDate":"2019-04-24","runtime":181,
         "posterPath":"/poster.jpg","backdropPath":"/backdrop.jpg",
         "genres":[{"id":12,"name":"Adventure"}],
         "keywords":[{"id":1,"name":"secret keyword"}],
         "credits":{"cast":[{"id":1,"name":"Actor","character":"Secret role"}],"crew":[{"job":"Director","name":"Director"}]},
         "relatedVideos":[{"site":"YouTube","key":"abc","type":"Trailer"}],
         "releases":{"results":[{"iso_3166_1":"US","release_dates":[{"certification":"PG-13","release_date":"2019-04-26T00:00:00.000Z","type":3}]}]},
         "collection":{"id":86311,"name":"Saga"},
         "externalIds":{"imdbId":"tt4154796"},
         "mediaInfo":{"tmdbId":299534,"status":5}}
        """;

    private const string TvJson = """
        {"id":1433,"mediaType":"tv","name":"Show","overview":"Secret plot","tagline":"Secret tagline",
         "voteAverage":7.5,"voteCount":900,"firstAirDate":"2005-02-06","lastAirDate":"2026-01-01",
         "posterPath":"/poster.jpg","backdropPath":"/backdrop.jpg",
         "lastEpisodeToAir":{"name":"Secret finale","overview":"Secret","airDate":"2026-01-01","stillPath":"/s.jpg"},
         "nextEpisodeToAir":{"name":"Secret next","airDate":"2026-02-01"},
         "keywords":[{"id":2,"name":"secret keyword"}],
         "credits":{"cast":[{"id":1,"name":"Actor","character":"Secret role"}],"crew":[]},
         "relatedVideos":[{"site":"YouTube","key":"abc","type":"Trailer"}],
         "externalIds":{"tvdbId":71663},
         "seasons":[
           {"seasonNumber":0,"name":"Specials","overview":"Specials plot","airDate":"2005-01-01","posterPath":"/s0.jpg","episodeCount":3},
           {"seasonNumber":1,"name":"Season 1","overview":"First plot","airDate":"2005-02-06","posterPath":"/s1.jpg","episodeCount":7},
           {"seasonNumber":2,"name":"The Secret Season","overview":"Secret season plot","airDate":"2006-02-06","posterPath":"/s2.jpg","episodeCount":16}],
         "mediaInfo":{"tmdbId":1433,"tvdbId":71663,"status":5}}
        """;

    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Guid UserId { get; } = Guid.NewGuid();
        public User User { get; } = new("test", "default", "default");
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IUserDataManager> Data { get; } = new();
        public UserSpoilerBlur State { get; set; } = new();
        public SpoilerSeerrRedactor Redactor { get; }
        public PluginConfiguration Config => Plugin.Plugin.Configuration;
        public Fixture()
        {
            Config.SpoilerBlurEnabled = true;
            User.Id = UserId;
            Users.Setup(u => u.GetUserById(UserId)).Returns(User);
            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), Users.Object,
                new SpoilerIdentityService(Users.Object, Plugin.Core.Logger), Plugin.Core.Logger);
            var resolver = new SpoilerUserResolver(Plugin.Core.Manager, Library.Object, Plugin.Core.Logger, identities);
            Redactor = new SpoilerSeerrRedactor(resolver, Library.Object, Users.Object, Data.Object);
            Save();
        }
        /// <summary>Saves through the production path, which drops the resolver's cached state.</summary>
        public void Save() => Plugin.Core.Manager.SaveUserConfiguration(UserId.ToString("N"), "spoilerblur.json", State);
        public Series GuardSeries(string? tmdb = "1433", string? tvdb = null)
        {
            var series = new Series { Id = Guid.NewGuid() };
            if (tmdb != null) series.ProviderIds["Tmdb"] = tmdb;
            if (tvdb != null) series.ProviderIds["Tvdb"] = tvdb;
            Library.Setup(l => l.GetItemById(series.Id)).Returns(series);
            State.Series[series.Id.ToString("N")] = new();
            Save();
            return series;
        }
        public Movie AddMovie(string tmdb = "299534", bool played = false)
        {
            var movie = new Movie { Id = Guid.NewGuid() };
            movie.ProviderIds["Tmdb"] = tmdb;
            Library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
            Data.Setup(d => d.GetUserData(User, movie)).Returns(new UserItemData { Key = "movie", Played = played });
            return movie;
        }
        public Movie GuardMovie(string tmdb = "299534", bool played = false)
        {
            var movie = AddMovie(tmdb, played);
            State.Movies[movie.Id.ToString("N")] = new();
            Save();
            return movie;
        }
        public string Seerr(string json, string path) => Redactor.RedactSeerr(json, path, UserId.ToString("N"), new DefaultHttpContext());
        public JsonObject SeerrObject(string json, string path) => Assert.IsType<JsonObject>(JsonNode.Parse(Seerr(json, path)));
        public JsonObject Tmdb(string json, string path)
        {
            Assert.True(Redactor.TryRedactTmdb(json, path, UserId.ToString("N"), new DefaultHttpContext(), out var body), path);
            return Assert.IsType<JsonObject>(JsonNode.Parse(body));
        }
        public void Dispose() { SpoilerUserResolver.InvalidateUser(UserId.ToString("N")); Plugin.Dispose(); }
    }

    private const string MoviePath = "/api/v1/movie/299534";
    private const string TvPath = "/api/v1/tv/1433";

    [Fact]
    public void ProtectedMovieDetailsFollowEveryDefaultToggle()
    {
        using var f = new Fixture(); f.GuardMovie();
        var body = f.SeerrObject(MovieJson, MoviePath);
        Assert.Equal("Spoiler Guard activated", (string?)body["overview"]);
        Assert.Equal("Endgame", (string?)body["title"]);
        Assert.False(body.ContainsKey("tagline"));
        Assert.False(body.ContainsKey("voteAverage")); Assert.False(body.ContainsKey("voteCount"));
        Assert.False(body.ContainsKey("relatedVideos"));
        Assert.False(body.ContainsKey("releaseDate"));
        Assert.Equal("2019", (string?)body["jeYear"]);
        Assert.Null(body["credits"]!["cast"]![0]!["character"]);
        Assert.Equal("Actor", (string?)body["credits"]!["cast"]![0]!["name"]);
        Assert.True((bool?)body["jeSpoilerGuard"]);
        // What requests, the age badge and collections read has to survive.
        Assert.Equal("Adventure", (string?)body["genres"]![0]!["name"]);
        Assert.Equal("PG-13", (string?)body["releases"]!["results"]![0]!["release_dates"]![0]!["certification"]);
        Assert.Null(body["releases"]!["results"]![0]!["release_dates"]![0]!["release_date"]);
        Assert.Equal(86311, (int?)body["collection"]!["id"]);
        Assert.Equal(5, (int?)body["mediaInfo"]!["status"]);
    }

    // Request override rules read keywords, and missing and empty mean different things to them.
    [Fact]
    public void KeywordsLeaveTheRenderedListButStayAvailableToRequestRules()
    {
        using var f = new Fixture(); f.GuardMovie();
        var body = f.SeerrObject(MovieJson, MoviePath);
        Assert.False(body.ContainsKey("keywords"));
        Assert.Equal("secret keyword", (string?)body["jeRuleKeywords"]![0]!["name"]);
    }

    [Theory]
    [InlineData("overview", "Overview")]
    [InlineData("tagline", "Taglines")]
    [InlineData("voteAverage", "Ratings")]
    [InlineData("keywords", "Tags")]
    [InlineData("releaseDate", "Dates")]
    public void EachToggleOnlyReleasesItsOwnField(string field, string toggle)
    {
        // Admin off, then the same field through the user's own opt-out.
        foreach (var admin in new[] { true, false })
        {
            using var f = new Fixture(); f.GuardMovie();
            var prefs = new SpoilerBlurUserPrefs();
            switch (toggle)
            {
                case "Overview": if (admin) f.Config.SpoilerStripOverview = false; else prefs.HideEpisodeDescriptions = false; break;
                case "Taglines": if (admin) f.Config.SpoilerStripTaglines = false; else prefs.HideTaglines = false; break;
                case "Ratings": if (admin) f.Config.SpoilerStripRatings = false; else prefs.HideRatings = false; break;
                case "Tags": if (admin) f.Config.SpoilerStripTags = false; else prefs.HideTags = false; break;
                case "Dates": if (admin) f.Config.SpoilerStripPremiereDate = false; else prefs.HideAirDate = false; break;
            }
            f.State.Prefs = prefs; f.Save();
            var body = f.SeerrObject(MovieJson, MoviePath);
            var original = Assert.IsType<JsonObject>(JsonNode.Parse(MovieJson));
            Assert.Equal(original[field]!.ToJsonString(), body[field]?.ToJsonString());
            // A sibling stays protected, or this would pass with everything released.
            var sibling = toggle == "Taglines" ? "voteAverage" : "tagline";
            Assert.False(body.ContainsKey(sibling), sibling);
        }
    }

    [Fact]
    public void TrailersAndRolesFollowTheTitleBearingCondition()
    {
        using var f = new Fixture(); f.GuardMovie();
        f.Config.SpoilerReplaceTitle = false; f.Config.SpoilerStripOverview = false;
        var released = f.SeerrObject(MovieJson, MoviePath);
        Assert.True(released.ContainsKey("relatedVideos"));
        Assert.Equal("Secret role", (string?)released["credits"]!["cast"]![0]!["character"]);
        f.Config.SpoilerReplaceTitle = true;
        var stripped = f.SeerrObject(MovieJson, MoviePath);
        Assert.False(stripped.ContainsKey("relatedVideos"));
        Assert.Null(stripped["credits"]!["cast"]![0]!["character"]);
    }

    [Fact]
    public void CastAllModeDropsTheWholeList()
    {
        using var f = new Fixture(); f.GuardMovie();
        Assert.Single(f.SeerrObject(MovieJson, MoviePath)["credits"]!["cast"]!.AsArray());
        f.Config.SpoilerStripCastMode = "All";
        var credits = f.SeerrObject(MovieJson, MoviePath)["credits"]!.AsObject();
        Assert.False(credits.ContainsKey("cast")); Assert.False(credits.ContainsKey("crew"));
    }

    [Fact]
    public void MovieArtFollowsTheImageSettings()
    {
        using var f = new Fixture(); f.GuardMovie();
        var defaults = f.SeerrObject(MovieJson, MoviePath);
        Assert.True(defaults.ContainsKey("posterPath"));
        f.Config.SpoilerKeepMoviePosters = false; f.Config.SpoilerBlurArtwork = true;
        var protectedArt = f.SeerrObject(MovieJson, MoviePath);
        Assert.False(protectedArt.ContainsKey("posterPath")); Assert.False(protectedArt.ContainsKey("backdropPath"));
    }

    [Fact]
    public void SeriesDetailsKeepTheFirstSeasonsAndStripLaterOnes()
    {
        using var f = new Fixture(); f.GuardSeries();
        f.Config.SpoilerKeepMoviePosters = false; f.Config.SpoilerBlurArtwork = true;
        var body = f.SeerrObject(TvJson, TvPath);
        Assert.Equal("Spoiler Guard activated", (string?)body["overview"]);
        Assert.Equal("Show", (string?)body["name"]);
        Assert.False(body.ContainsKey("lastEpisodeToAir")); Assert.False(body.ContainsKey("nextEpisodeToAir"));
        Assert.False(body.ContainsKey("firstAirDate")); Assert.False(body.ContainsKey("lastAirDate"));
        Assert.Equal("2005", (string?)body["jeYear"]);
        // Series art isn't touched by those two settings.
        Assert.True(body.ContainsKey("posterPath")); Assert.True(body.ContainsKey("backdropPath"));
        var seasons = body["seasons"]!.AsArray();
        Assert.Equal("Specials plot", (string?)seasons[0]!["overview"]);
        Assert.Equal("First plot", (string?)seasons[1]!["overview"]);
        Assert.Equal("/s1.jpg", (string?)seasons[1]!["posterPath"]);
        Assert.Equal("Season 2", (string?)seasons[2]!["name"]);
        Assert.Null(seasons[2]!["overview"]); Assert.Null(seasons[2]!["airDate"]); Assert.Null(seasons[2]!["posterPath"]);
        Assert.Equal(16, (int?)seasons[2]!["episodeCount"]);
    }

    [Fact]
    public void SeriesDescriptionsHaveTheirOwnPolicy()
    {
        using var f = new Fixture(); f.GuardSeries();
        f.Config.SpoilerStripSeriesOverview = false;
        var body = f.SeerrObject(TvJson, TvPath);
        Assert.Equal("Secret plot", (string?)body["overview"]);
        Assert.Null(body["seasons"]![2]!["overview"]);
    }

    [Fact]
    public void AMovieInAnOptedInCollectionIsProtected()
    {
        using var f = new Fixture();
        var movie = f.AddMovie();
        var boxSet = new BoxSet { Id = Guid.NewGuid(), LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        f.Library.Setup(l => l.GetItemById(boxSet.Id)).Returns(boxSet);
        // 10.11 resolves linked children one by one; 12 batches them through GetItemList.
        f.Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ItemIds.Contains(movie.Id)))).Returns(new BaseItem[] { movie });
        BaseItem.LibraryManager = f.Library.Object;
        f.State.Collections[boxSet.Id.ToString("N")] = new(); f.Save();
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(MovieJson, MoviePath)["overview"]);
    }

    [Fact]
    public void APlayedMovieHasNothingLeftToSpoil()
    {
        using var f = new Fixture(); f.GuardMovie(played: true);
        Assert.Same(MovieJson, f.Seerr(MovieJson, MoviePath));
    }

    [Fact]
    public void AnUnknownPlayStateKeepsTheProtection()
    {
        using var f = new Fixture(); var movie = f.GuardMovie();
        f.Data.Setup(d => d.GetUserData(f.User, movie)).Throws(new InvalidOperationException("offline"));
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(MovieJson, MoviePath)["overview"]);
    }

    [Theory]
    [InlineData("movie:299534", "movie")]
    [InlineData("tv:1433", "tv")]
    public void APendingTitleIsProtectedBeforeItArrives(string key, string kind)
    {
        using var f = new Fixture();
        f.State.PendingTmdb[key] = new(); f.Save();
        var (json, path) = kind == "tv" ? (TvJson, TvPath) : (MovieJson, MoviePath);
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(json, path)["overview"]);
    }

    [Fact]
    public void ASeriesWithoutATmdbIdIsMatchedByItsTvdbId()
    {
        using var f = new Fixture(); f.GuardSeries(tmdb: null, tvdb: "71663");
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(TvJson, TvPath)["overview"]);
    }

    [Fact]
    public void ATitleIsMatchedByTheJellyfinIdSeerrReports()
    {
        using var f = new Fixture();
        var series = f.GuardSeries(tmdb: null);
        var json = TvJson.Replace("\"status\":5", $"\"status\":5,\"jellyfinMediaId\":\"{series.Id}\"").Replace("\"tvdbId\":71663", "\"tvdbId\":1");
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(json, TvPath)["overview"]);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public void WithNothingToApplyTheBodyIsUntouched(bool enabled, bool guardOtherTitle)
    {
        using var f = new Fixture();
        f.Config.SpoilerBlurEnabled = enabled;
        if (guardOtherTitle) f.GuardMovie("1");
        Assert.Same(MovieJson, f.Seerr(MovieJson, MoviePath));
        Assert.Same(TvJson, f.Seerr(TvJson, TvPath));
    }

    [Fact]
    public void AnotherTitleOnTheListChangesNothingHere()
    {
        using var f = new Fixture(); f.GuardMovie("1");
        Assert.Same(MovieJson, f.Seerr(MovieJson, MoviePath));
    }

    [Fact]
    public void ASavedGuardAppliesToTheNextRequest()
    {
        using var f = new Fixture(); f.GuardMovie("1");
        Assert.Same(MovieJson, f.Seerr(MovieJson, MoviePath));
        f.GuardMovie();
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(MovieJson, MoviePath)["overview"]);
    }

    [Fact]
    public void AFailedLibraryLookupFailsClosed()
    {
        using var f = new Fixture();
        var id = Guid.NewGuid();
        f.Library.Setup(l => l.GetItemById(id)).Throws(new InvalidOperationException("offline"));
        f.State.Series[id.ToString("N")] = new(); f.Save();
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject(MovieJson, MoviePath)["overview"]);
    }

    [Fact]
    public void ABodyThatIsNotJsonPassesThrough()
    {
        using var f = new Fixture(); f.GuardMovie();
        Assert.Equal("<html>gateway</html>", f.Seerr("<html>gateway</html>", MoviePath));
    }

    [Theory]
    [InlineData("/api/v1/search?query=x", null)]
    [InlineData("/api/v1/discover/trending?page=1", null)]
    [InlineData("/api/v1/discover/movies?page=1", "movie")]
    [InlineData("/api/v1/movie/1/similar?page=1", "movie")]
    [InlineData("/api/v1/movie/1/recommendations?page=1", "movie")]
    public void ListsRedactOnlyTheProtectedResult(string path, string? listKind)
    {
        using var f = new Fixture(); f.GuardMovie();
        var type = listKind == null ? "\"mediaType\":\"movie\"," : string.Empty;
        var json = "{\"page\":2,\"totalPages\":9,\"results\":["
            + "{" + type + "\"id\":299534,\"title\":\"Endgame\",\"overview\":\"Secret plot\",\"voteAverage\":8.2,\"releaseDate\":\"2019-04-24\"},"
            + "{" + type + "\"id\":7,\"title\":\"Other\",\"overview\":\"Other plot\",\"voteAverage\":6.0}]}";
        var body = f.SeerrObject(json, path);
        var results = body["results"]!.AsArray();
        Assert.Equal("Spoiler Guard activated", (string?)results[0]!["overview"]);
        Assert.Null(results[0]!["voteAverage"]);
        Assert.Equal("Endgame", (string?)results[0]!["title"]);
        Assert.Equal("2019-04-24", (string?)results[0]!["releaseDate"]);
        Assert.Equal("Other plot", (string?)results[1]!["overview"]);
        Assert.Equal(6.0, (double?)results[1]!["voteAverage"]);
        Assert.Equal(2, (int?)body["page"]); Assert.Equal(9, (int?)body["totalPages"]);
    }

    [Fact]
    public void ListsMatchThroughMediaInfoAndKeepPeopleAndOtherKinds()
    {
        using var f = new Fixture(); var series = f.GuardSeries(tmdb: null);
        var json = "{\"results\":["
            + $"{{\"mediaType\":\"tv\",\"id\":1433,\"overview\":\"Secret plot\",\"mediaInfo\":{{\"jellyfinMediaId\":\"{series.Id:N}\"}}}},"
            + "{\"mediaType\":\"person\",\"id\":1433,\"name\":\"Person\"}]}";
        var results = f.SeerrObject(json, "/api/v1/search?query=x")["results"]!.AsArray();
        Assert.Equal("Spoiler Guard activated", (string?)results[0]!["overview"]);
        Assert.Equal("Person", (string?)results[1]!["name"]);
    }

    [Fact]
    public void CollectionPartsAndPersonCreditsAreCovered()
    {
        using var f = new Fixture(); f.GuardMovie();
        const string Entry = "{\"mediaType\":\"movie\",\"id\":299534,\"overview\":\"Secret plot\"}";
        Assert.Equal("Spoiler Guard activated", (string?)f.SeerrObject("{\"parts\":[" + Entry + "]}", "/api/v1/collection/86311")["parts"]![0]!["overview"]);
        var credits = f.SeerrObject("{\"cast\":[" + Entry + "],\"crew\":[" + Entry + "]}", "/api/v1/person/5/combined_credits");
        Assert.Equal("Spoiler Guard activated", (string?)credits["cast"]![0]!["overview"]);
        Assert.Equal("Spoiler Guard activated", (string?)credits["crew"]![0]!["overview"]);
    }

    [Theory]
    [InlineData("/api/v1/movie/299534/ratingscombined", true)]
    [InlineData("/api/v1/tv/1433/ratings", false)]
    public void RatingsEndpointsAnswerEmptyUntilTheUserOptsOut(string path, bool movie)
    {
        using var f = new Fixture();
        if (movie) f.GuardMovie(); else f.GuardSeries();
        const string Ratings = "{\"rt\":{\"criticsScore\":94},\"imdb\":{\"criticsScore\":8.4}}";
        Assert.Empty(f.SeerrObject(Ratings, path));
        f.State.Prefs = new SpoilerBlurUserPrefs { HideRatings = false }; f.Save();
        Assert.Same(Ratings, f.Seerr(Ratings, path));
    }

    [Fact]
    public void SeerrSeasonDetailsHideEveryEpisode()
    {
        using var f = new Fixture(); f.GuardSeries();
        const string Season = """
            {"seasonNumber":2,"name":"The Secret Season","overview":"Secret","airDate":"2006-02-06","posterPath":"/s2.jpg",
             "episodes":[{"episodeNumber":3,"name":"Secret title","overview":"Secret plot","airDate":"2006-02-20","stillPath":"/e.jpg","voteAverage":9.9}]}
            """;
        var body = f.SeerrObject(Season, "/api/v1/tv/1433/season/2");
        Assert.Equal("Season 2", (string?)body["name"]);
        Assert.Null(body["overview"]);
        var episode = body["episodes"]![0]!;
        Assert.Equal("Episode 3", (string?)episode["name"]);
        Assert.Null(episode["overview"]); Assert.Null(episode["airDate"]); Assert.Null(episode["stillPath"]); Assert.Null(episode["voteAverage"]);
    }

    [Fact]
    public void SonarrLookupCandidatesLoseTheirDescriptions()
    {
        using var f = new Fixture(); f.GuardSeries();
        const string Lookup = "[{\"tvdbId\":1,\"title\":\"Show\",\"overview\":\"Secret plot\"}]";
        var candidate = JsonNode.Parse(f.Seerr(Lookup, "/api/v1/service/sonarr/lookup/1433"))![0]!;
        Assert.Equal("Show", (string?)candidate["title"]); Assert.Null(candidate["overview"]);
    }

    [Fact]
    public void TmdbTvDetailsUseTheSameRulesInTmdbsShape()
    {
        using var f = new Fixture(); f.GuardSeries();
        const string Show = """
            {"id":1433,"name":"Show","overview":"Secret plot","tagline":"Secret tagline","vote_average":7.5,
             "first_air_date":"2005-02-06","last_air_date":"2026-01-01",
             "last_episode_to_air":{"name":"Secret","air_date":"2026-01-01"},"next_episode_to_air":{"air_date":"2026-02-01"},
             "seasons":[{"season_number":2,"name":"The Secret Season","overview":"Secret","air_date":"2006-02-06","poster_path":"/s2.jpg"}]}
            """;
        var body = f.Tmdb(Show, "tv/1433");
        Assert.Equal("Spoiler Guard activated", (string?)body["overview"]);
        Assert.False(body.ContainsKey("tagline")); Assert.False(body.ContainsKey("vote_average"));
        Assert.False(body.ContainsKey("first_air_date"));
        // The release-date chip reads these two.
        Assert.False(body.ContainsKey("last_episode_to_air")); Assert.False(body.ContainsKey("next_episode_to_air"));
        var season = body["seasons"]![0]!;
        Assert.Equal("Season 2", (string?)season["name"]);
        Assert.Null(season["overview"]); Assert.Null(season["air_date"]); Assert.Null(season["poster_path"]);
    }

    [Fact]
    public void TmdbSeasonAndEpisodeBodiesLoseTheirDates()
    {
        using var f = new Fixture(); f.GuardSeries();
        const string Season = "{\"season_number\":2,\"episodes\":[{\"episode_number\":1,\"name\":\"Secret\",\"air_date\":\"2006-02-06\",\"still_path\":\"/e.jpg\",\"guest_stars\":[{\"name\":\"Secret\"}]}]}";
        var episode = f.Tmdb(Season, "tv/1433/season/2")["episodes"]![0]!.AsObject();
        Assert.Equal("Episode 1", (string?)episode["name"]);
        Assert.False(episode.ContainsKey("air_date")); Assert.False(episode.ContainsKey("still_path")); Assert.False(episode.ContainsKey("guest_stars"));
        var single = f.Tmdb("{\"episode_number\":4,\"name\":\"Secret\",\"air_date\":\"2006-02-06\"}", "tv/1433/season/2/episode/4");
        Assert.Equal("Episode 4", (string?)single["name"]); Assert.False(single.ContainsKey("air_date"));
    }

    [Fact]
    public void TmdbReleaseDatesEmptyOnlyWhileDatesAreHidden()
    {
        using var f = new Fixture(); f.GuardMovie();
        const string Dates = "{\"id\":299534,\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"release_date\":\"2019-04-26\"}]}]}";
        Assert.Empty(f.Tmdb(Dates, "movie/299534/release_dates")["results"]!.AsArray());
        f.State.Prefs = new SpoilerBlurUserPrefs { HideAirDate = false }; f.Save();
        Assert.False(f.Redactor.TryRedactTmdb(Dates, "movie/299534/release_dates", f.UserId.ToString("N"), new DefaultHttpContext(), out var body));
        Assert.Same(Dates, body);
    }

    [Theory]
    [InlineData("movie/299534/watch/providers")]
    [InlineData("movie/299534/reviews")]
    [InlineData("tv/1433/watch/providers")]
    [InlineData("genre/movie/list")]
    public void OtherTmdbPathsAreLeftAlone(string path)
    {
        using var f = new Fixture(); f.GuardMovie(); f.GuardSeries();
        Assert.False(f.Redactor.TryRedactTmdb("{\"results\":[]}", path, f.UserId.ToString("N"), new DefaultHttpContext(), out _));
    }

    [Fact]
    public void HidesRatingsFollowsProtectionAndTheToggle()
    {
        using var f = new Fixture(); f.GuardMovie();
        var user = f.UserId.ToString("N");
        Assert.True(f.Redactor.HidesRatings("movie", "299534", user, new DefaultHttpContext()));
        Assert.False(f.Redactor.HidesRatings("movie", "1", user, new DefaultHttpContext()));
        Assert.False(f.Redactor.HidesRatings("tv", "299534", user, new DefaultHttpContext()));
        f.State.Prefs = new SpoilerBlurUserPrefs { HideRatings = false }; f.Save();
        Assert.False(f.Redactor.HidesRatings("movie", "299534", user, new DefaultHttpContext()));
    }

    [Fact]
    public void ACallerWithoutAGuidNeverReachesTheState()
    {
        using var f = new Fixture(); f.GuardMovie();
        Assert.Same(MovieJson, f.Redactor.RedactSeerr(MovieJson, MoviePath, null, new DefaultHttpContext()));
        Assert.Same(MovieJson, f.Redactor.RedactSeerr(MovieJson, MoviePath, "not-a-guid", new DefaultHttpContext()));
    }
}
