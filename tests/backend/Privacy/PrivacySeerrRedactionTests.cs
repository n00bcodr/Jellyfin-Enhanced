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
using Series = MediaBrowser.Controller.Entities.TV.Series;

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
        /// <summary>Marks episodes played, as the library answers the redactor's query.</summary>
        public void SetPlayed(Series series, params (int Season, int Episode)[] played)
        {
            var items = played.Select(p => (BaseItem)new Episode { Id = Guid.NewGuid(), ParentIndexNumber = p.Season, IndexNumber = p.Episode }).ToArray();
            Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.IsPlayed == true && q.ParentId == series.Id))).Returns(items);
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
    public void ASeasonTheUserHasStartedStaysVisible()
    {
        using var f = new Fixture(); var series = f.GuardSeries();
        f.SetPlayed(series, (2, 1));
        var season = f.SeerrObject(TvJson, TvPath)["seasons"]![2]!;
        Assert.Equal("The Secret Season", (string?)season["name"]);
        Assert.Equal("Secret season plot", (string?)season["overview"]);
        Assert.Equal("/s2.jpg", (string?)season["posterPath"]);
    }

    [Fact]
    public void AFailedProgressLookupLeavesLaterSeasonsStripped()
    {
        using var f = new Fixture(); var series = f.GuardSeries();
        f.Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ParentId == series.Id))).Throws(new InvalidOperationException("offline"));
        Assert.Null(f.SeerrObject(TvJson, TvPath)["seasons"]![2]!["overview"]);
    }

    [Fact]
    public void PlayedEpisodesKeepTheirTextInASeasonResponse()
    {
        using var f = new Fixture(); var series = f.GuardSeries();
        f.SetPlayed(series, (2, 1));
        const string Season = "{\"seasonNumber\":2,\"episodes\":[{\"episodeNumber\":1,\"name\":\"Seen title\",\"overview\":\"Seen plot\"},{\"episodeNumber\":2,\"name\":\"Secret title\",\"overview\":\"Secret plot\"}]}";
        var episodes = f.SeerrObject(Season, "/api/v1/tv/1433/season/2")["episodes"]!.AsArray();
        Assert.Equal("Seen title", (string?)episodes[0]!["name"]); Assert.Equal("Seen plot", (string?)episodes[0]!["overview"]);
        Assert.Equal("Episode 2", (string?)episodes[1]!["name"]); Assert.Null(episodes[1]!["overview"]);
        // The single-episode TMDB route, which the episode page's date chip uses.
        Assert.False(f.Redactor.TryRedactTmdb("{\"name\":\"Seen title\"}", "tv/1433/season/2/episode/1", f.UserId.ToString("N"), new DefaultHttpContext(), out _));
    }

    // The date chip reads these objects, so a date opt-out has to keep them.
    [Fact]
    public void ADateOptOutKeepsAirDatesAndStillHidesTheEpisodeText()
    {
        using var f = new Fixture(); f.GuardSeries();
        f.State.Prefs = new SpoilerBlurUserPrefs { HideAirDate = false }; f.Save();
        var seerr = f.SeerrObject(TvJson, TvPath)["lastEpisodeToAir"]!;
        Assert.Equal("2026-01-01", (string?)seerr["airDate"]);
        Assert.Null(seerr["overview"]); Assert.Null(seerr["stillPath"]);
        Assert.NotEqual("Secret finale", (string?)seerr["name"]);
        const string Tmdb = "{\"id\":1433,\"last_episode_to_air\":{\"episode_number\":9,\"name\":\"Secret\",\"overview\":\"Secret\",\"air_date\":\"2026-01-01\"}}";
        var tmdb = f.Tmdb(Tmdb, "tv/1433")["last_episode_to_air"]!;
        Assert.Equal("2026-01-01", (string?)tmdb["air_date"]);
        Assert.Equal("Episode 9", (string?)tmdb["name"]); Assert.Null(tmdb["overview"]);
    }

    [Fact]
    public void WithDatesAndTextBothAllowedTheEpisodeObjectsAreLeftAlone()
    {
        using var f = new Fixture(); f.GuardSeries();
        f.Config.SpoilerReplaceTitle = false; f.Config.SpoilerStripOverview = false; f.Config.SpoilerStripSeriesOverview = false;
        f.State.Prefs = new SpoilerBlurUserPrefs { HideAirDate = false }; f.Save();
        Assert.Equal("Secret finale", (string?)f.SeerrObject(TvJson, TvPath)["lastEpisodeToAir"]!["name"]);
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
    public void AMovieGuardedOnlyThroughACollectionSaysSo()
    {
        using var f = new Fixture();
        var movie = f.AddMovie();
        var boxSet = new BoxSet { Id = Guid.NewGuid(), LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        f.Library.Setup(l => l.GetItemById(boxSet.Id)).Returns(boxSet);
        f.Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ItemIds.Contains(movie.Id)))).Returns(new BaseItem[] { movie });
        BaseItem.LibraryManager = f.Library.Object;
        f.State.Collections[boxSet.Id.ToString("N")] = new(); f.Save();
        Assert.True((bool?)f.SeerrObject(MovieJson, MoviePath)["jeSpoilerGuardInherited"]);
        // On the list as well, so it can be switched off from the title.
        f.State.Movies[movie.Id.ToString("N")] = new(); f.Save();
        Assert.False(f.SeerrObject(MovieJson, MoviePath).ContainsKey("jeSpoilerGuardInherited"));
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

    // Ratings and season requests only carry the TMDB id, so the match made on the
    // details response has to hold for them too.
    [Theory]
    [InlineData("/api/v1/tv/90001/ratings", "{\"criticsScore\":94}")]
    [InlineData("/api/v1/tv/90001/season/2", "{\"seasonNumber\":2,\"overview\":\"Secret\",\"episodes\":[]}")]
    public void FollowUpRequestsKeepAMatchMadeOnAnotherId(string path, string body)
    {
        using var f = new Fixture(); f.GuardSeries(tmdb: null, tvdb: "90001");
        var details = "{\"id\":90001,\"name\":\"Show\",\"overview\":\"Secret plot\",\"externalIds\":{\"tvdbId\":90001}}";
        Assert.True((bool?)f.SeerrObject(details, "/api/v1/tv/90001")["jeSpoilerGuard"]);
        Assert.NotEqual(body, f.Seerr(body, path));
    }

    [Fact]
    public void TmdbFollowUpsKeepAMatchMadeOnAnotherId()
    {
        using var f = new Fixture(); f.GuardSeries(tmdb: null, tvdb: "90002");
        f.Seerr("{\"id\":90002,\"overview\":\"Secret plot\",\"externalIds\":{\"tvdbId\":90002}}", "/api/v1/tv/90002");
        Assert.Equal("Spoiler Guard activated", (string?)f.Tmdb("{\"overview\":\"Secret plot\"}", "tv/90002")["overview"]);
    }

    [Fact]
    public void ABareTmdbIdIsKeptProtectedUntilItsOtherIdsAreKnown()
    {
        using var f = new Fixture(); f.GuardSeries(tmdb: null, tvdb: "90003");
        const string Ratings = "{\"criticsScore\":94}";
        // Could be the guarded series: nothing says otherwise yet.
        Assert.NotEqual(Ratings, f.Seerr(Ratings, "/api/v1/tv/90004/ratings"));
        // The details settle it, including for a title outside the library, which has no other ids.
        f.Seerr("{\"id\":90004,\"overview\":\"Plot\",\"externalIds\":{}}", "/api/v1/tv/90004");
        Assert.Same(Ratings, f.Seerr(Ratings, "/api/v1/tv/90004/ratings"));
    }

    [Fact]
    public void ALibraryItemWithThatTmdbIdSettlesItToo()
    {
        using var f = new Fixture(); f.GuardSeries(tmdb: null, tvdb: "90005");
        f.Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.HasAnyProviderId != null && q.HasAnyProviderId["Tmdb"] == "90006")))
            .Returns(new BaseItem[] { new Series { Id = Guid.NewGuid() } });
        const string Ratings = "{\"criticsScore\":94}";
        Assert.Same(Ratings, f.Seerr(Ratings, "/api/v1/tv/90006/ratings"));
    }

    [Fact]
    public void WithEveryGuardKnownByTmdbIdNoExtraLookupRuns()
    {
        using var f = new Fixture(); f.GuardSeries();
        const string Ratings = "{\"criticsScore\":94}";
        Assert.Same(Ratings, f.Seerr(Ratings, "/api/v1/tv/90007/ratings"));
        f.Library.Verify(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.HasAnyProviderId != null)), Times.Never);
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
    public void RowsReportWhatToHideForATitle()
    {
        using var f = new Fixture(); f.GuardMovie(); f.Config.SpoilerKeepMoviePosters = false;
        var rows = f.Redactor.LoadRows(f.UserId.ToString("N"), new DefaultHttpContext())!;
        var policy = rows.ForTitle(false, "299534", null, null)!;
        Assert.True(policy.HideDates); Assert.True(policy.HidePoster); Assert.True(policy.HideOverview);
        Assert.Null(rows.ForTitle(false, "1", null, null));
    }

    [Fact]
    public void RowsHideAnEpisodeTitleUntilItIsPlayed()
    {
        using var f = new Fixture(); var series = f.GuardSeries(tvdb: "71663");
        series.ProviderIds["Shoko Series"] = "55"; f.State = new UserSpoilerBlur(); f.State.Series[series.Id.ToString("N")] = new(); f.Save();
        f.SetPlayed(series, (2, 1));
        var rows = f.Redactor.LoadRows(f.UserId.ToString("N"), new DefaultHttpContext())!;
        Assert.True(rows.HidesEpisodeTitle(null, "71663", null, 2, 2));
        Assert.False(rows.HidesEpisodeTitle(null, "71663", null, 2, 1));
        Assert.True(rows.HidesEpisodeTitle("1433", null, null, 3, 1));
        Assert.False(rows.HidesEpisodeTitle("7", "7", null, 2, 2));
        // Shoko numbers an episode without a season, and matches on its own series id.
        Assert.True(rows.HidesEpisodeTitle(null, null, "55", null, 2));
        Assert.False(rows.HidesEpisodeTitle(null, null, "55", null, 1));
        Assert.True(rows.HidesEpisodeOverview(null, "71663", null, 2, 2));
    }

    [Fact]
    public void RowsFollowTheTitleOptOut()
    {
        using var f = new Fixture(); f.GuardSeries(tvdb: "71663");
        f.State.Prefs = new SpoilerBlurUserPrefs { ReplaceEpisodeTitles = false }; f.Save();
        var rows = f.Redactor.LoadRows(f.UserId.ToString("N"), new DefaultHttpContext())!;
        Assert.False(rows.HidesEpisodeTitle(null, "71663", null, 2, 2));
        Assert.True(rows.HidesEpisodeOverview(null, "71663", null, 2, 2));
    }

    [Fact]
    public void NoRowsAreLoadedWithNothingToApply()
    {
        using var f = new Fixture();
        Assert.Null(f.Redactor.LoadRows(f.UserId.ToString("N"), new DefaultHttpContext()));
    }

    [Fact]
    public void AFailedCollectionLookupIsNotAnAnswer()
    {
        using var f = new Fixture();
        var id = Guid.NewGuid();
        f.Library.Setup(l => l.GetItemById(id)).Throws(new InvalidOperationException("offline"));
        f.State.Collections[id.ToString("N")] = new(); f.Save();
        var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), f.Users.Object,
            new SpoilerIdentityService(f.Users.Object, f.Plugin.Core.Logger), f.Plugin.Core.Logger);
        var resolver = new SpoilerUserResolver(f.Plugin.Core.Manager, f.Library.Object, f.Plugin.Core.Logger, identities);
        Assert.False(resolver.TryGetMovieScope(f.State, Guid.NewGuid(), out _));
    }

    [Fact]
    public void ACallerWithoutAGuidNeverReachesTheState()
    {
        using var f = new Fixture(); f.GuardMovie();
        Assert.Same(MovieJson, f.Redactor.RedactSeerr(MovieJson, MoviePath, null, new DefaultHttpContext()));
        Assert.Same(MovieJson, f.Redactor.RedactSeerr(MovieJson, MoviePath, "not-a-guid", new DefaultHttpContext()));
    }
}
