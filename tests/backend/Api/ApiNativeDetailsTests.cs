using System.Net;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Moq;
using Xunit;

namespace JE.Tests;

/// <summary>The synthetic id codec is shared by both builds and by the web client.</summary>
public class NativeDetailsIdTests
{
    private const string Server = "0202511b0eac4284ab045b3ba556d72e";

    [Fact]
    public void IdsRoundTripPerKindAndBindToTheServer()
    {
        var ids = new[] { SyntheticId.Movie(693134), SyntheticId.Series(83867), SyntheticId.SeasonOf(83867, 2), SyntheticId.EpisodeOf(83867, 1, 12), SyntheticId.Person(1190668), SyntheticId.Genre(878), SyntheticId.Studio(923), SyntheticId.Network(2739) };
        foreach (var id in ids)
        {
            var guid = id.ToGuid(Server);
            Assert.True(SyntheticId.HasNamespace(guid));
            Assert.True(SyntheticId.TryParse(guid, Server, out var back));
            Assert.Equal(id, back);
            Assert.True(SyntheticId.TryParse(guid.ToString("D").ToUpperInvariant(), Server, out _));
            // Another server never accepts it (the check binds the id to its server).
            Assert.False(SyntheticId.TryParse(guid, "1111111b0eac4284ab045b3ba556d72e", out _));
        }

        // The vector the live lab served and the web client's test computes too.
        Assert.Equal("4a45ad11000a938e00000000f9c67720", SyntheticId.Movie(693134).Format(Server));
        Assert.Equal("4a45ad1500000ee200000000f845f0a8", SyntheticId.Person(3810).Format(Server));
        Assert.Equal("4a45ad1600002a0d0000000061de6198", SyntheticId.Genre(10765).Format(Server));
        // Only titles are titles; the pages they link to aren't.
        Assert.All(ids, id => Assert.Equal(id.Kind is SyntheticKind.Movie or SyntheticKind.Series or SyntheticKind.Season or SyntheticKind.Episode, id.IsTitle));
        Assert.Equal(SyntheticId.Movie(693134).Format(Server), SyntheticId.Movie(693134).Format("0202511B-0EAC-4284-AB04-5B3BA556D72E"));
    }

    [Fact]
    public void TamperedMalformedAndOrdinaryIdsAreNotSynthetic()
    {
        var good = SyntheticId.Movie(693134).Format(Server);
        Assert.False(SyntheticId.TryParse(good[..8] + "2" + good[9..], Server, out _)); // tmdb digit changed, check no longer matches
        Assert.False(SyntheticId.TryParse("4a45ad1100000000000000000000000", Server, out _));
        Assert.False(SyntheticId.TryParse("not-a-guid", Server, out _));
        // Kind and coordinates must agree: a movie with a season is rejected even with a valid check.
        Assert.False(new SyntheticId(SyntheticKind.Movie, 1, 2, 0).IsWellFormed());
        Assert.False(new SyntheticId((SyntheticKind)9, 1, 0, 0).IsWellFormed());
        Assert.False(new SyntheticId(SyntheticKind.Genre, 1, 1, 0).IsWellFormed());
        Assert.False(new SyntheticId(SyntheticKind.Network, 1, 0, 2).IsWellFormed());
        var rnd = new Random(7);
        for (var i = 0; i < 2000; i++)
        {
            var bytes = new byte[16];
            rnd.NextBytes(bytes);
            Assert.False(SyntheticId.TryParse(new Guid(bytes), Server, out _));
        }
    }
}

#if !NET9_0
[Collection("Plugin singleton")]
public class ApiNativeDetailsTests
{
    private const string Server = "0202511b0eac4284ab045b3ba556d72e";
    private static readonly Guid MoviesLib = Guid.NewGuid();
    private static readonly Guid ShowsLib = Guid.NewGuid();

    private const string MovieJson = """
    {"id":693134,"title":"Dune: Part Two","originalTitle":"Dune: Part Two","overview":"Paul unites with the Fremen.","tagline":"Long live the fighters.",
     "releaseDate":"2024-02-27","runtime":167,"voteAverage":8.14,"genres":[{"id":878,"name":"Science Fiction"},{"id":12,"name":"Adventure"}],
     "keywords":[{"id":1,"name":"desert"},{"id":2,"name":"sandworm"}],"productionCountries":[{"iso_3166_1":"US","name":"United States of America"}],
     "productionCompanies":[{"id":923,"name":"Legendary Pictures"},{"id":99,"name":"Tiny Co"}],
     "posterPath":"/poster.jpg","backdropPath":"/back.jpg","imdbId":"tt15239678",
     "credits":{"cast":[{"id":1190668,"name":"Timothée Chalamet","character":"Paul","profilePath":"/p.jpg","order":0},{"id":3810,"name":"Javier Bardem","character":"Stilgar","profilePath":"/jb.jpg","order":1}],"crew":[{"id":137427,"name":"Denis Villeneuve","job":"Director","profilePath":null}]},
     "releases":{"results":[{"iso_3166_1":"US","release_dates":[{"type":3,"certification":"PG-13"}]}]},
     "relatedVideos":[{"site":"YouTube","type":"Trailer","key":"abc_DEF-123","name":"Trailer"},{"site":"YouTube","type":"Trailer","key":"bad key\"","name":"Bad"}],
     "mediaInfo":{"requests":[{"requestedBy":{"displayName":"someone else"}}]}}
    """;

    private const string SeriesJson = """
    {"id":83867,"name":"Andor","firstAirDate":"2022-09-21","lastAirDate":"2025-05-13","status":"Ended","episodeRunTime":[45],"voteAverage":8.3,
     "posterPath":"/sp.jpg","backdropPath":"/sb.jpg","externalIds":{"tvdbId":393189,"imdbId":"tt9253284"},
     "contentRatings":{"results":[{"iso_3166_1":"US","rating":"TV-14"}]},"genres":[{"id":1,"name":"Drama"}],
     "seasons":[{"seasonNumber":1,"name":"Season 1","episodeCount":3,"airDate":"2022-09-21","posterPath":"/s1.jpg"},{"seasonNumber":2,"name":"Season 2","episodeCount":12,"airDate":"2025-04-22","posterPath":"/s2.jpg"}],
     "credits":{"cast":[],"crew":[]},"createdBy":[{"id":5,"name":"Tony Gilroy","profilePath":"/tg.jpg"}],"networks":[{"id":2739,"name":"Disney+"}]}
    """;

    private const string SeasonJson = """
    {"seasonNumber":1,"name":"Season 1","episodes":[
     {"episodeNumber":1,"seasonNumber":1,"name":"Kassa","overview":"Cassian looks for his sister.","airDate":"2022-09-21","stillPath":"/e1.jpg","voteAverage":7.4,"runtime":40},
     {"episodeNumber":2,"seasonNumber":1,"name":"That Would Be Me","airDate":"2022-09-21","stillPath":"https://image.tmdb.org/t/p/original//e2.jpg"},
     {"episodeNumber":3,"seasonNumber":1,"name":"Reckoning","airDate":"2022-09-21","stillPath":null}]}
    """;

    private const string RecsJson = """
    {"results":[{"id":438631,"mediaType":"movie","title":"Dune","releaseDate":"2021-09-15","posterPath":"/d1.jpg","voteAverage":7.8},
                {"id":1,"mediaType":"person","name":"Not a title"},{"id":335984,"mediaType":"movie","title":"Blade Runner 2049","posterPath":"/br.jpg"}]}
    """;

    private const string PersonJson = """
    {"id":3810,"name":"Javier Bardem","biography":"Spanish actor.","birthday":"1969-03-01","deathday":null,"placeOfBirth":"Las Palmas, Spain",
     "knownForDepartment":"Acting","imdbId":"nm0000849","profilePath":"/jb.jpg","adult":false,"popularity":12.5}
    """;

    /// <summary>Known titles answer; unknown ones are "no such title" (Seerr 404); <see cref="Down"/> is an outage.</summary>
    private sealed class FakeSource : INativeDetailsSource
    {
        public int Calls;
        public HashSet<Guid> Linked { get; } = new();
        public bool Down { get; set; }
        public bool SeasonsDown { get; set; }
        /// <summary>Seasons of Andor the source knows (season 2 is the season-1 data renumbered).</summary>
        public HashSet<int> KnownSeasons { get; } = new() { 1 };
        public string Recs { get; set; } = RecsJson;
        private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();
        private SourceAnswer Answer(bool known, string json) => Down ? SourceAnswer.Unavailable : known ? SourceAnswer.Of(J(json)) : SourceAnswer.Missing;
        public Task<SourceAnswer> MovieAsync(int tmdb, CancellationToken ct) { Calls++; return Task.FromResult(Answer(tmdb == 693134, MovieJson)); }
        /// <summary>The series details answered for Andor (null: <see cref="SeriesJson"/>).</summary>
        public string? Series { get; set; }
        public Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct) { Calls++; return Task.FromResult(Answer(tmdb == 83867, Series ?? SeriesJson)); }
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct) { Calls++; return Task.FromResult(SeasonsDown ? SourceAnswer.Unavailable : Answer(tmdb == 83867 && KnownSeasons.Contains(season), SeasonJson.Replace("\"seasonNumber\":1", "\"seasonNumber\":" + season, StringComparison.Ordinal))); }
        public Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct) { Calls++; return Task.FromResult<JsonElement?>(J(Recs)); }
        public Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct) { Calls++; return Task.FromResult<string?>("/logo.png"); }
        /// <summary>People the source knows (Bardem by default); <see cref="AdultPerson"/> marks one an adult performer.</summary>
        public int? AdultPerson { get; set; }
        public Task<SourceAnswer> PersonAsync(int tmdb, CancellationToken ct)
        {
            Calls++;
            if (tmdb == AdultPerson) return Task.FromResult(Answer(true, PersonJson.Replace("\"adult\":false", "\"adult\":true", StringComparison.Ordinal).Replace("3810", tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)));
            return Task.FromResult(Answer(tmdb == 3810, PersonJson));
        }

        public bool GenresDown { get; set; }
        public Task<SourceAnswer> GenresAsync(bool movie, CancellationToken ct)
        {
            Calls++;
            if (GenresDown && !movie) return Task.FromResult(SourceAnswer.Unavailable);
            return Task.FromResult(Answer(true, movie ? """[{"id":878,"name":"Science Fiction"},{"id":12,"name":"Adventure"}]""" : """[{"id":10765,"name":"Sci-Fi & Fantasy"},{"id":18,"name":"Drama"}]"""));
        }

        public Task<SourceAnswer> StudioAsync(int tmdb, CancellationToken ct) { Calls++; return Task.FromResult(Answer(tmdb == 99, """{"id":99,"name":"Tiny Co"}""")); }
        public Task<SourceAnswer> NetworkAsync(int tmdb, CancellationToken ct) { Calls++; return Task.FromResult(Answer(tmdb == 2739, """{"id":2739,"name":" Disney+ "}""")); }
        /// <summary>The combined credits of Bardem (and of <see cref="AdultPerson"/>).</summary>
        public string Credits { get; set; } = """{"cast":[],"crew":[]}""";
        /// <summary>Feed reads aren't started (the viewer's read budget or the server's queue is used up).</summary>
        public bool Busy { get; set; }
        public Task<SourceAnswer> PersonCreditsAsync(int tmdb, Guid viewer, CancellationToken ct) { Calls++; return Task.FromResult(Busy ? SourceAnswer.Throttled : Answer(tmdb == 3810 || tmdb == AdultPerson, Credits)); }
        /// <summary>Discovery pages by "movie|tv:filter:id:page" (company series: "tv:company:id:page"); others are unknown.</summary>
        public Dictionary<string, string> Feeds { get; } = new();
        public List<string> FeedCalls { get; } = new();
        public Task<SourceAnswer> DiscoverAsync(bool movie, string filter, int id, int page, string? sortBy, Guid viewer, CancellationToken ct)
        {
            Calls++;
            var key = $"{(movie ? "movie" : "tv")}:{filter}:{id}:{page}";
            FeedCalls.Add(key + (sortBy == null ? string.Empty : "?" + sortBy));
            if (Busy) return Task.FromResult(SourceAnswer.Throttled);
            return Task.FromResult(Answer(Feeds.ContainsKey(key), Feeds.GetValueOrDefault(key) ?? "{}"));
        }

        public Task<SourceAnswer> CompanySeriesAsync(int company, int page, string? sortBy, Guid viewer, CancellationToken ct)
        {
            Calls++;
            var key = $"tv:company:{company}:{page}";
            FeedCalls.Add(key + (sortBy == null ? string.Empty : "?" + sortBy));
            if (Busy) return Task.FromResult(SourceAnswer.Throttled);
            return Task.FromResult(Answer(Feeds.ContainsKey(key), Feeds.GetValueOrDefault(key) ?? "{}"));
        }

        /// <summary>A page's own metadata reads aren't started (the viewer's feed budget is used up).</summary>
        public bool PagesBusy { get; set; }
        public Task<SourceAnswer> MovieAsync(int tmdb, Guid viewer, CancellationToken ct) => PagesBusy ? Task.FromResult(SourceAnswer.Throttled) : MovieAsync(tmdb, ct);
        public Task<SourceAnswer> SeriesAsync(int tmdb, Guid viewer, CancellationToken ct) => PagesBusy ? Task.FromResult(SourceAnswer.Throttled) : SeriesAsync(tmdb, ct);
        public List<string> RatingCalls { get; } = new();
        /// <summary>The source knows no ratings for any title (Seerr's 404 for a series Rotten Tomatoes doesn't know).</summary>
        public bool NoRatings { get; set; }
        public Task<SourceAnswer> RatingsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct)
        {
            Calls++;
            RatingCalls.Add((movie ? "movie:" : "tv:") + tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (Busy) return Task.FromResult(SourceAnswer.Throttled);
            if (NoRatings) return Task.FromResult(Answer(false, "{}"));
            return Task.FromResult(Answer(movie ? tmdb == 693134 : tmdb == 83867, movie ? """{"rt":{"criticsScore":92},"imdb":{"criticsScore":8.5}}""" : """{"criticsScore":96}"""));
        }

        public Task<SourceAnswer> KeywordsAsync(string query, Guid viewer, CancellationToken ct)
        {
            Calls++;
            if (Busy) return Task.FromResult(SourceAnswer.Throttled);
            return Task.FromResult(Answer(true, """{"page":1,"results":[{"id":161919,"name":"adult animation","extra":"x"},{"id":0,"name":"bad"},{"id":5,"name":null}]}"""));
        }

        /// <summary>Similar/recommended pages by "movie|tv:id:relation:page" (others are unknown).</summary>
        public Dictionary<string, string> Related { get; } = new();
        public Task<SourceAnswer> RelatedAsync(bool movie, int tmdb, string relation, int page, Guid viewer, CancellationToken ct)
        {
            Calls++;
            var key = $"{(movie ? "movie" : "tv")}:{tmdb}:{relation}:{page}";
            if (Busy) return Task.FromResult(SourceAnswer.Throttled);
            return Task.FromResult(Answer(Related.ContainsKey(key), Related.GetValueOrDefault(key) ?? "{}"));
        }

        /// <summary>Movie collections the source knows, by TMDB collection id (others are unknown).</summary>
        public Dictionary<int, string> Collections { get; } = new();
        public Task<SourceAnswer> CollectionAsync(int collection, Guid viewer, CancellationToken ct)
        {
            Calls++;
            if (Busy) return Task.FromResult(SourceAnswer.Throttled);
            return Task.FromResult(Answer(Collections.ContainsKey(collection), Collections.GetValueOrDefault(collection) ?? "{}"));
        }

        /// <summary>Seerr can't tell who is linked (unreachable, no earlier answer).</summary>
        public bool LinkUnknown { get; set; }
        public Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct) => Task.FromResult<bool?>(LinkUnknown ? null : Linked.Contains(userId));
    }

    /// <summary>Everything one facade needs, with a strict library manager (any write throws).</summary>
    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public TestCallers Callers { get; } = new();
        public FakeSource Source { get; } = new();
        public SpoilerUserResolver SpoilerUsers => _spoilerUsers;
        public FakeLibraryAccess Libraries { get; } = new();
        public Mock<MediaBrowser.Controller.Library.ILibraryManager> Library { get; } = new(MockBehavior.Strict);
        public Mock<MediaBrowser.Controller.Dto.IDtoService> Dto { get; } = new(MockBehavior.Strict);
        public List<string> Hosts { get; } = new();
        public TaskCompletionSource? ImageGate { get; set; }
        public TaskCompletionSource? ImageStarted { get; set; }
        public IntegrationTransport Images { get; }
        public IntegrationTransport Seerr { get; }
        public NativeDetailsArtwork Artwork { get; private set; } = null!;
        public NativeDetailsPolicy Policy { get; private set; } = null!;
        public NativeDetailsFacadeFilter Filter { get; private set; } = null!;
        public NativeDetailsFeeds Feeds { get; private set; } = null!;
        public Mock<MediaBrowser.Controller.Drawing.IImageProcessor> ImageTags { get; } = new();
        public string Rating { get; set; } = "PG-13";
        private readonly string? _stateDir;
        private Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter _parental;
        private readonly Func<Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter> _newParental;
        private readonly Mock<MediaBrowser.Controller.IServerApplicationHost> _host = new();
        private readonly Mock<MediaBrowser.Controller.Configuration.IServerConfigurationManager> _server = new();
        private readonly SpoilerNextUnwatchedService _next;
        private readonly SpoilerFieldStripFilter _strip;
        private readonly SpoilerUserResolver _spoilerUsers;
        /// <summary>Library revision handed to the physical-title reader (null: no cache).</summary>
        public Func<long>? LibraryRevision { get; set; }

        /// <summary>While set, the parental filter's rating lookups wait for it.</summary>
        public TaskCompletionSource? RatingGate { get; set; }

        /// <summary>
        /// A rig; with <paramref name="stateDir"/> the grant key and session epochs are kept there (restart
        /// tests); <paramref name="parentalBudget"/> is how long a list waits for its rating lookups.
        /// </summary>
        public Rig(string? stateDir = null, TimeSpan? parentalBudget = null)
        {
            _stateDir = stateDir;
            var c = Plugin.Plugin.Configuration;
            c.NativeAbsentDetailsEnabled = true;
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = "http://seerr.invalid";
            c.JellyseerrApiKey = "test-seerr";
            Libraries.Libs.Add(new() { Id = MoviesLib.ToString(), Name = "Movies", CollectionType = "movies" });
            Libraries.Libs.Add(new() { Id = ShowsLib.ToString(), Name = "Shows", CollectionType = "tvshows" });
            Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((MediaBrowser.Controller.Entities.BaseItem?)null);
            Library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns(new List<MediaBrowser.Controller.Entities.BaseItem>());
            // People, genres and studios by name (read only: never created); none unless a test adds them.
            Library.Setup(l => l.GetPerson(It.IsAny<string>())).Returns((MediaBrowser.Controller.Entities.Person?)null);
            Library.Setup(l => l.GetGenreId(It.IsAny<string>())).Returns((string n) => NameId("genre", n));
            Library.Setup(l => l.GetStudioId(It.IsAny<string>())).Returns((string n) => NameId("studio", n));
            ImageTags.Setup(i => i.GetImageCacheTag(It.IsAny<MediaBrowser.Controller.Entities.BaseItem>(), It.IsAny<MediaBrowser.Controller.Entities.ItemImageInfo>()))
                .Returns((MediaBrowser.Controller.Entities.BaseItem item, MediaBrowser.Controller.Entities.ItemImageInfo _) => "lib-tag-" + item.Id.ToString("N"));
            Images = new IntegrationTransport(async (req, _) =>
            {
                lock (Hosts) Hosts.Add(req.RequestUri!.Host);
                ImageStarted?.TrySetResult();
                if (ImageGate != null) await ImageGate.Task;
                var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[] { 0xff, 0xd8, 0xff, 1, 2, 3 }) };
                r.Content.Headers.ContentType = new("image/jpeg");
                return r;
            });
            Seerr = new IntegrationTransport(async (req, _) =>
            {
                if (RatingGate is { } gate) await gate.Task;
                return IntegrationTransport.Response(JsonSerializer.Serialize(new
                {
                    releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = Rating } } } } },
                    contentRatings = new { results = new[] { new { iso_3166_1 = "US", rating = Rating } } },
                    keywords = Array.Empty<object>(), genres = Array.Empty<object>(),
                }));
            });
            var localization = new Mock<MediaBrowser.Model.Globalization.ILocalizationManager>();
            localization.Setup(l => l.GetRatingScore("PG-13", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(13, null));
            localization.Setup(l => l.GetRatingScore("TV-14", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(14, null));
            localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
            _server.SetupGet(s => s.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration { MetadataCountryCode = "US" });
            _newParental = () => parentalBudget is { } budget
                ? new Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter(Seerr, Callers.Users.Object, localization.Object, _server.Object, Plugin.Core.Logger, budget)
                : new Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter(Seerr, Callers.Users.Object, localization.Object, _server.Object, Plugin.Core.Logger);
            _parental = _newParental();
            _host.SetupGet(h => h.SystemId).Returns(Server);
            // Spoiler Guard as registered (its own library lookups are for collections and watched state only).
            var loose = new Mock<MediaBrowser.Controller.Library.ILibraryManager>();
            _spoilerUsers = new SpoilerUserResolver(Plugin.Core.Manager, loose.Object, Plugin.Core.Logger, null!);
            _next = new SpoilerNextUnwatchedService(loose.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object, Plugin.Core.Logger);
            _strip = new SpoilerFieldStripFilter(_spoilerUsers, loose.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object, _next);
            Restart();
        }

        /// <summary>
        /// A server restart: new artwork service, policy and facade (the same users, library and state folder);
        /// with <paramref name="forgetRatings"/> the parental filter's rating cache is lost too, as in a real restart.
        /// </summary>
        public void Restart(bool forgetRatings = false)
        {
            if (forgetRatings) _parental = _newParental();
            Artwork = new NativeDetailsArtwork(Images, _stateDir);
            Policy = new NativeDetailsPolicy(_parental, Source, Libraries, null, _stateDir, new NativeDetailsLibrary(Library.Object, null, LibraryRevision));
            Filter = new NativeDetailsFacadeFilter(Callers.Users.Object, Library.Object, Dto.Object, _host.Object, _server.Object, Source, Policy, Artwork, _parental, Plugin.Core.Manager, _strip, _spoilerUsers,
                new NativeDetailsLinks(Library.Object, ImageTags.Object, LibraryRevision), new SpoilerPresentation(Plugin.Core.Manager, Library.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object), new ImageBlurService(Plugin.Core.Logger));
            Feeds = new NativeDetailsFeeds(Source, Policy, _parental, Library.Object, Plugin.Core.Manager, new SpoilerPresentation(Plugin.Core.Manager, Library.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object));
        }

        /// <summary>The feeds over another source (the policy still admits titles from <see cref="Source"/>).</summary>
        public NativeDetailsFeeds FeedsOver(INativeDetailsSource source) => new(source, Policy, _parental, Library.Object, Plugin.Core.Manager, new SpoilerPresentation(Plugin.Core.Manager, Library.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object));

        /// <summary>The id Jellyfin derives for a genre or studio name (a stand-in: stable per kind and name).</summary>
        public static Guid NameId(string kind, string name)
            => new(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(kind + "|" + name.ToLowerInvariant())).AsSpan(0, 16));

        public User Person(bool admin = false, bool linked = true)
        {
            var user = Callers.Register(Guid.NewGuid(), admin);
            user.SetPermission(PermissionKind.EnableAllFolders, true);
            if (linked) Source.Linked.Add(user.Id);
            return user;
        }

        public void Dispose()
        {
            _next.Dispose();
            Images.Dispose();
            Seerr.Dispose();
            Plugin.Dispose();
        }
    }

    private sealed record Run(IActionResult? Result, int NextCalls, IDictionary<string, object?> Arguments, HttpContext Http);

    private static async Task<Run> Call(Rig rig, string controller, string action, System.Security.Claims.ClaimsPrincipal? user, Dictionary<string, object?> args, string method = "GET")
    {
        var http = new DefaultHttpContext();
        if (user != null) http.User = user;
        http.Request.Method = method;
        var descriptor = new ControllerActionDescriptor { ControllerName = controller, ActionName = action };
        var context = new ActionContext(http, new RouteData(), descriptor);
        var filters = new List<IFilterMetadata>();
        var executing = new ActionExecutingContext(context, filters, args, new object());
        var calls = 0;
        await rig.Filter.OnActionExecutionAsync(executing, () =>
        {
            calls++;
            return Task.FromResult(new ActionExecutedContext(context, filters, new object()) { Result = new OkResult() });
        });
        return new Run(executing.Result, calls, args, http);
    }

    private static Guid Id(SyntheticId id) => id.ToGuid(Server);

    private static System.Security.Claims.ClaimsPrincipal Me(User user) => TestCallers.Principal(user.Id, user.HasPermission(PermissionKind.IsAdministrator));

    private static int Status(IActionResult? result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        ContentResult c => c.StatusCode ?? 200,
        FileContentResult => 200,
        null => -1,
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    private static T Value<T>(IActionResult? result) => Assert.IsType<T>(Assert.IsType<OkObjectResult>(result).Value);

    [Fact]
    public void AllowlistIsFrozen()
    {
        var expected = new[]
        {
            "UserLibrary.GetItem=Item", "UserLibrary.GetItemLegacy=Item", "UserLibrary.GetIntros=EmptyQuery", "UserLibrary.GetIntrosLegacy=EmptyQuery",
            "UserLibrary.GetLocalTrailers=EmptyArray", "UserLibrary.GetLocalTrailersLegacy=EmptyArray", "UserLibrary.GetSpecialFeatures=EmptyArray",
            "UserLibrary.GetSpecialFeaturesLegacy=EmptyArray", "Library.GetThemeMedia=ThemeMedia", "Library.GetThemeSongs=ThemeResult",
            "Library.GetThemeVideos=ThemeResult", "Library.GetItemCollections=EmptyQuery", "Library.GetSimilarItems=Similar", "Library.GetAncestors=Ancestors",
            "Videos.GetAdditionalPart=EmptyQuery", "TvShows.GetSeasons=Seasons", "TvShows.GetEpisodes=Episodes", "TvShows.GetNextUp=EmptyQuery",
            "LiveTv.GetLiveTvPrograms=EmptyQuery", "Image.GetItemImage=Image", "Image.GetItemImageByIndex=Image", "Image.GetItemImage2=Image",
            "Items.GetItems=Batch", "Items.GetItemsByUserIdLegacy=Batch",
            "ArrStatus.GetItemStatus=PassThrough", "AcquireRequests.Season=PassThrough", "NativeDetails.Resolve=PassThrough",
        };
        Assert.Equal(expected, NativeDetailsAllowlist.Routes.Select(r => $"{r.Controller}.{r.Action}={r.Answer}"));
        // Read-only: GET everywhere, HEAD only for artwork.
        Assert.All(NativeDetailsAllowlist.Routes, r => Assert.Equal(r.Answer == FacadeAnswer.Image ? new[] { "GET", "HEAD" } : new[] { "GET" }, r.Methods));
        Assert.Equal(NativeDetailsFacadeFilter.Order, -1000);
        // People, genres, studios and networks open their own page (the item) and nothing a title has;
        // a person page also reads its (empty) ancestors and collections.
        SyntheticKind[] KindsOf(string action) => NativeDetailsAllowlist.Routes.Single(r => r.Controller + "." + r.Action == action).Kinds;
        var linked = new[] { SyntheticKind.Person, SyntheticKind.Genre, SyntheticKind.Studio, SyntheticKind.Network };
        Assert.Equal(Enum.GetValues<SyntheticKind>(), KindsOf("UserLibrary.GetItem").OrderBy(k => k));
        Assert.Contains(SyntheticKind.Person, KindsOf("Library.GetAncestors"));
        Assert.Contains(SyntheticKind.Person, KindsOf("Library.GetItemCollections"));
        foreach (var route in NativeDetailsAllowlist.Routes.Where(r => r.Answer is not (FacadeAnswer.Item or FacadeAnswer.Image or FacadeAnswer.Batch)))
        {
            var allowed = route.Action is "GetAncestors" or "GetItemCollections" ? new[] { SyntheticKind.Person } : Array.Empty<SyntheticKind>();
            Assert.Empty(route.Kinds.Intersect(linked).Except(allowed));
        }
    }

    public sealed class QueueBody
    {
        public IReadOnlyList<Guid> PlayingQueue { get; set; } = Array.Empty<Guid>();
    }

    public static TheoryData<string, string, string, string, string, int> Refusals()
    {
        var movie = SyntheticId.Movie(693134).Format(Server);
        return new()
        {
            { "UserLibrary", "MarkFavoriteItem", "POST", "itemId", "guid", 403 },
            { "UserLibrary", "UnmarkFavoriteItemLegacy", "DELETE", "itemId", "guid", 403 },
            { "Playstate", "MarkPlayedItem", "POST", "itemId", "guid", 403 },
            { "Playstate", "OnPlaybackStart", "POST", "itemId", "guid", 403 },
            { "MediaInfo", "GetPostedPlaybackInfo", "POST", "itemId", "guid", 403 },
            { "Library", "DeleteItem", "DELETE", "itemId", "guid", 403 },
            { "ItemRefresh", "RefreshItem", "POST", "itemId", "guid", 403 },
            { "ItemUpdate", "UpdateItem", "POST", "itemId", "guid", 403 },
            { "Playlists", "AddItemToPlaylist", "POST", "ids", "array", 403 },
            { "Collection", "AddToCollection", "POST", "ids", "array", 403 },
            { "Sessions", "DisplayContent", "POST", "itemId", "string", 403 },
            { "Sessions", "Play", "POST", "itemIds", "array", 403 },
            { "Sessions", "SendFullGeneralCommand", "POST", "command", "command", 403 },
            { "SyncPlay", "SyncPlaySetNewQueue", "POST", "requestData", "queue", 403 },
            { "Library", "GetDownload", "GET", "itemId", "guid", 404 },
            { "UserLibrary", "GetLatestMedia", "GET", "parentId", "guid", 404 },
            { "Persons", "GetPerson", "GET", "name", "string", 404 },
            { "JellyfinEnhanced", "GetItemStats", "GET", "itemId", "string", 404 },
            { "JellyfinEnhanced", "GetPeopleInfo", "GET", "ids", "csv", 404 },
            // Allowlisted action, but a synthetic id in an argument it doesn't take ids in.
            { "UserLibrary", "GetItem", "GET", "userId", "guid", 404 },
            // Allowlisted action, wrong method.
            { "UserLibrary", "GetItem", "POST", "itemId", "guid", 403 },
        };
    }

    [Theory]
    [MemberData(nameof(Refusals))]
    public async Task EverythingOutsideTheAllowlistNamingASyntheticIdIsRefusedBeforeTheNativeAction(string controller, string action, string method, string arg, string shape, int status)
    {
        using var rig = new Rig();
        var admin = rig.Person(admin: true);
        var id = Id(SyntheticId.Movie(693134));
        object value = shape switch
        {
            "guid" => id,
            "string" => id.ToString("N"),
            "array" => new[] { Guid.NewGuid(), id },
            "csv" => Guid.NewGuid().ToString("N") + "," + id.ToString("N"),
            "command" => new MediaBrowser.Model.Session.GeneralCommand(new Dictionary<string, string> { ["ItemId"] = id.ToString("N") }),
            "queue" => new QueueBody { PlayingQueue = new[] { id } },
            _ => throw new ArgumentException(shape),
        };
        var run = await Call(rig, controller, action, Me(admin), new() { [arg] = value }, method);
        Assert.Equal(0, run.NextCalls);
        Assert.Equal(status, Status(run.Result));
        Assert.Equal(0, rig.Source.Calls);
    }

    [Fact]
    public async Task OrdinaryRequestsPassThroughUntouched()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var real = Guid.NewGuid();
        var run = await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = real, ["userId"] = viewer.Id });
        Assert.Equal(1, run.NextCalls);
        Assert.Null(run.Result);
        // A GUID with the namespace but a wrong check (a real item could have that prefix) is not intercepted.
        var lookalike = Guid.ParseExact("4a45ad11000a938e0000000000000000", "N");
        Assert.Equal(1, (await Call(rig, "UserLibrary", "MarkFavoriteItem", Me(viewer), new() { ["itemId"] = lookalike }, "POST")).NextCalls);
        Assert.Equal(0, rig.Source.Calls);
    }

    public static TheoryData<string> Callers() => new() { "self", "apikey", "unknown", "disabled", "other-user", "admin-for-viewer", "admin-for-unknown", "anonymous" };

    [Theory]
    [MemberData(nameof(Callers))]
    public async Task EffectiveViewerMatchesNative(string who)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var other = rig.Person();
        var admin = rig.Person(admin: true);
        var disabled = rig.Person();
        disabled.SetPermission(PermissionKind.IsDisabled, true);
        var (principal, asked, status, expectedViewer) = who switch
        {
            "self" => (Me(viewer), viewer.Id, 200, viewer.Id),
            "apikey" => (TestCallers.ApiKey(), viewer.Id, 403, Guid.Empty),
            "unknown" => (TestCallers.Unknown(), viewer.Id, 403, Guid.Empty),
            "disabled" => (Me(disabled), disabled.Id, 403, Guid.Empty),
            "other-user" => (Me(viewer), other.Id, 403, Guid.Empty),
            "admin-for-viewer" => (Me(admin), viewer.Id, 200, viewer.Id),
            "admin-for-unknown" => (Me(admin), Guid.NewGuid(), 404, Guid.Empty),
            "anonymous" => (new System.Security.Claims.ClaimsPrincipal(), viewer.Id, 403, Guid.Empty),
            _ => throw new ArgumentException(who),
        };
        var run = await Call(rig, "UserLibrary", "GetItemLegacy", principal, new() { ["itemId"] = Id(SyntheticId.Movie(693134)), ["userId"] = asked });
        Assert.Equal(0, run.NextCalls);
        Assert.Equal(status, Status(run.Result));
        if (status == 200)
        {
            var dto = Value<BaseItemDto>(run.Result);
            // Policy and artwork follow the effective (target) viewer.
            Assert.True(rig.Artwork.TryRead(dto.ImageTags[ImageType.Primary], out var grant));
            Assert.Equal(expectedViewer, grant!.Viewer);
        }
    }

    [Theory]
    [InlineData("off")]
    [InlineData("no-seerr")]
    [InlineData("unlinked")]
    [InlineData("import-blocked")]
    [InlineData("no-library")]
    [InlineData("over-limit")]
    [InlineData("under-limit")]
    [InlineData("unrated-restricted")]
    public async Task EligibilityRefusesLikeAHiddenItem(string scenario)
    {
        using var rig = new Rig();
        var viewer = rig.Person(linked: scenario != "unlinked");
        var config = rig.Plugin.Plugin.Configuration;
        switch (scenario)
        {
            case "off": config.NativeAbsentDetailsEnabled = false; break;
            case "no-seerr": config.JellyseerrEnabled = false; break;
            case "import-blocked": config.JellyseerrImportBlockedUsers = viewer.Id.ToString("D"); break;
            case "no-library":
                viewer.SetPermission(PermissionKind.EnableAllFolders, false);
                viewer.SetPreference(PreferenceKind.EnabledFolders, new[] { Guid.NewGuid().ToString() });
                break;
            case "over-limit": viewer.MaxParentalRatingScore = 10; break; // PG-13 = 13
            case "under-limit": viewer.MaxParentalRatingScore = 16; break;
            case "unrated-restricted": viewer.MaxParentalRatingScore = 16; rig.Rating = ""; break;
        }

        var run = await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) });
        Assert.Equal(0, run.NextCalls);
        Assert.Equal(scenario == "under-limit" ? 200 : 404, Status(run.Result));
        // The same rule guards the children, and the series rule its seasons and episodes.
        var seasons = await Call(rig, "TvShows", "GetSeasons", Me(viewer), new() { ["seriesId"] = Id(SyntheticId.Series(83867)) });
        Assert.Equal(scenario is "under-limit" ? 200 : 404, Status(seasons.Result));
    }

    [Theory]
    [InlineData(SyntheticKind.Movie)]
    [InlineData(SyntheticKind.Series)]
    [InlineData(SyntheticKind.Season)]
    [InlineData(SyntheticKind.Episode)]
    public async Task DtoInvariantsPerType(SyntheticKind kind)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var id = kind switch
        {
            SyntheticKind.Movie => SyntheticId.Movie(693134),
            SyntheticKind.Series => SyntheticId.Series(83867),
            SyntheticKind.Season => SyntheticId.SeasonOf(83867, 1),
            _ => SyntheticId.EpisodeOf(83867, 1, 2),
        };
        var dto = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(id) })).Result);
        Assert.Equal(Id(id), dto.Id);
        Assert.Equal(Server, dto.ServerId);
        Assert.Equal(kind switch { SyntheticKind.Movie => BaseItemKind.Movie, SyntheticKind.Series => BaseItemKind.Series, SyntheticKind.Season => BaseItemKind.Season, _ => BaseItemKind.Episode }, dto.Type);
        var folder = kind is SyntheticKind.Series or SyntheticKind.Season;
        Assert.Equal(folder, dto.IsFolder);
        Assert.Equal(folder ? MediaType.Unknown : MediaType.Video, dto.MediaType);
        Assert.Equal(LocationType.Virtual, dto.LocationType);
        Assert.False(dto.UserData.IsFavorite);
        Assert.False(dto.UserData.Played);
        Assert.Equal(0, dto.UserData.PlayCount);
        Assert.Equal(0, dto.UserData.PlaybackPositionTicks);
        Assert.Equal(0, dto.SpecialFeatureCount);
        Assert.Equal(0, dto.LocalTrailerCount);
        Assert.Equal(0, dto.PartCount);
        Assert.Equal(0, dto.MediaSourceCount);
        Assert.Empty(dto.MediaSources);
        Assert.False(dto.CanDelete);
        Assert.False(dto.CanDownload);
        // Every artwork tag is a grant for this viewer whose owner is the item id the client will put in the URL.
        void Owned(string? tag, Guid owner, ImageType type)
        {
            Assert.True(rig.Artwork.TryRead(tag, out var g), $"{type} grant");
            Assert.Equal(owner, g!.Owner);
            Assert.Equal(type, g.Type);
            Assert.Equal(viewer.Id, g.Viewer);
        }

        foreach (var (type, tag) in dto.ImageTags) Owned(tag, dto.Id, type);
        var series = Id(SyntheticId.Series(83867));
        switch (kind)
        {
            case SyntheticKind.Movie:
                Assert.Equal("693134", dto.ProviderIds["Tmdb"]);
                Assert.Equal("PG-13", dto.OfficialRating);
                Assert.Equal(new[] { "https://www.youtube.com/watch?v=abc_DEF-123" }, dto.RemoteTrailers.Select(t => t.Url));
                Assert.Contains(dto.People, p => p.Type == PersonKind.Actor && p.Role == "Paul" && SyntheticId.TryParse(p.Id, Server, out var person) && person.Kind == SyntheticKind.Person);
                Assert.DoesNotContain("someone else", JsonSerializer.Serialize(dto)); // Seerr's per-account parts never reach the page
                Owned(dto.BackdropImageTags.Single(), dto.Id, ImageType.Backdrop);
                break;
            case SyntheticKind.Series:
                Assert.Equal("393189", dto.ProviderIds["Tvdb"]);
                Assert.Equal("Ended", dto.Status);
                Assert.Equal(2, dto.ChildCount);
                break;
            case SyntheticKind.Season:
                Assert.Equal(series, dto.SeriesId);
                Assert.Equal(series, dto.ParentId);
                Assert.Equal(1, dto.IndexNumber);
                Assert.Equal(3, dto.ChildCount);
                Assert.Equal(series, dto.ParentBackdropItemId);
                Owned(dto.ParentBackdropImageTags.Single(), series, ImageType.Backdrop);
                Owned(dto.ParentLogoImageTag, series, ImageType.Logo);
                Owned(dto.SeriesPrimaryImageTag, series, ImageType.Primary);
                break;
            case SyntheticKind.Episode:
                Assert.Equal(series, dto.SeriesId);
                Assert.Equal(Id(SyntheticId.SeasonOf(83867, 1)), dto.SeasonId);
                Assert.Equal(dto.SeasonId, dto.ParentId);
                Assert.Equal(1, dto.ParentIndexNumber);
                Assert.Equal(2, dto.IndexNumber);
                Assert.Equal("Andor", dto.SeriesName);
                break;
        }
    }

    [Fact]
    public async Task ChildrenAndSupplementaryAnswersStayInsideTheTitle()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var me = Me(viewer);
        var series = Id(SyntheticId.Series(83867));
        var seasons = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetSeasons", me, new() { ["seriesId"] = series })).Result);
        Assert.Equal(new int?[] { 1, 2 }, seasons.Items.Select(s => s.IndexNumber));
        Assert.All(seasons.Items, s => Assert.Equal(series, s.ParentId));

        var season1 = Id(SyntheticId.SeasonOf(83867, 1));
        // "Display missing episodes" off: no rows (the season can still be browsed and requested).
        var none = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = season1 })).Result);
        Assert.Empty(none.Items);
        viewer.DisplayMissingEpisodes = true;
        var rows = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = season1 })).Result);
        Assert.Equal(new[] { "Kassa", "That Would Be Me", "Reckoning" }, rows.Items.Select(e => e.Name));
        Assert.All(rows.Items, e => Assert.Equal(season1, e.ParentId));
        // Seerr gives episode stills as full TMDB URLs: the grant keeps only the file path.
        Assert.True(rig.Artwork.TryRead(rows.Items[1].ImageTags[ImageType.Primary], out var still));
        Assert.Equal("/e2.jpg", still!.Path);
        Assert.False(rows.Items[2].ImageTags.ContainsKey(ImageType.Primary));
        // Playback queues get nothing; a season of another series is a mismatched scope.
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = season1, ["isMissing"] = false })).Result).Items);
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(1399, 1)) })).Result));
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = Id(SyntheticId.Movie(693134)) })).Result));

        // Empty answers that keep native sections quiet.
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetNextUp", me, new() { ["seriesId"] = series })).Result).Items);
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "LiveTv", "GetLiveTvPrograms", me, new() { ["librarySeriesId"] = series })).Result).Items);
        Assert.Empty(Value<BaseItemDto[]>((await Call(rig, "UserLibrary", "GetSpecialFeatures", me, new() { ["itemId"] = series })).Result));
        var theme = Value<AllThemeMediaResult>((await Call(rig, "Library", "GetThemeMedia", me, new() { ["itemId"] = series })).Result);
        Assert.Equal(series, theme.ThemeSongsResult.OwnerId);
        Assert.Empty(theme.ThemeVideosResult.Items);

        var ancestors = Value<List<BaseItemDto>>((await Call(rig, "Library", "GetAncestors", me, new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 1)) })).Result);
        Assert.Equal(new[] { BaseItemKind.Season, BaseItemKind.Series }, ancestors.Select(a => a.Type));

        var similar = Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetSimilarItems", me, new() { ["itemId"] = Id(SyntheticId.Movie(693134)), ["limit"] = 12 })).Result);
        Assert.Equal(new[] { "Dune", "Blade Runner 2049" }, similar.Items.Select(i => i.Name));
        Assert.All(similar.Items, i => Assert.True(SyntheticId.TryParse(i.Id, Server, out var s) && s.Kind == SyntheticKind.Movie));
        Assert.Equal(2, similar.TotalRecordCount);
    }

    [Fact]
    public async Task BatchesLeaveSyntheticIdsOut()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var syn = Id(SyntheticId.Movie(693134));
        var real = Guid.NewGuid();
        var only = await Call(rig, "Items", "GetItems", Me(viewer), new() { ["ids"] = new[] { syn } });
        Assert.Equal(0, only.NextCalls);
        Assert.Empty(Value<QueryResult<BaseItemDto>>(only.Result).Items);
        var mixed = await Call(rig, "Items", "GetItems", Me(viewer), new() { ["ids"] = new[] { real, syn }, ["excludeItemIds"] = new[] { syn } });
        Assert.Equal(1, mixed.NextCalls);
        Assert.Equal(new[] { real }, (Guid[])mixed.Arguments["ids"]!);
        Assert.Empty((Guid[])mixed.Arguments["excludeItemIds"]!);
        var parent = await Call(rig, "Items", "GetItemsByUserIdLegacy", Me(viewer), new() { ["parentId"] = syn });
        Assert.Equal(0, parent.NextCalls);
        Assert.Empty(Value<QueryResult<BaseItemDto>>(parent.Result).Items);
    }

    [Fact]
    public async Task GuardEnabledDuringColdArtworkFetchNeverReturnsOriginalBytes()
    {
        using var rig = new Rig(); var viewer=rig.Person(); var movie=Id(SyntheticId.Movie(693134));
        var config=rig.Plugin.Plugin.Configuration; config.SpoilerBlurEnabled=true; config.SpoilerKeepMoviePosters=false;
        var dto=Value<BaseItemDto>((await Call(rig,"UserLibrary","GetItem",Me(viewer),new() { ["itemId"]=movie })).Result);
        rig.ImageStarted=new(TaskCreationOptions.RunContinuationsAsynchronously); rig.ImageGate=new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending=Call(rig,"Image","GetItemImage",null,new() { ["itemId"]=movie,["imageType"]=ImageType.Primary,["tag"]=dto.ImageTags[ImageType.Primary],["maxWidth"]=300 });
        await rig.ImageStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"),"spoilerblur.json",new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur { PendingTmdb=new() { ["movie:693134"]=new() } });
        rig.ImageGate.SetResult(); var result=await pending;
        if(result.Result is FileContentResult file) Assert.NotEqual(new byte[] { 0xff,0xd8,0xff,1,2,3 },file.FileContents);
        else Assert.Equal(404,Status(result.Result));
    }

    [Fact]
    public async Task ArtworkNeedsAValidCurrentGrantAndIsNeverCacheable()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        var dto = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result);
        var tag = dto.ImageTags[ImageType.Primary];
        Dictionary<string, object?> Args(Guid owner, ImageType type, string? t, int? index = null) => new() { ["itemId"] = owner, ["imageType"] = type, ["tag"] = t, ["imageIndex"] = index, ["maxWidth"] = 300 };

        // Anonymous, like a plain <img>: the grant is the authority.
        var ok = await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Primary, tag));
        var file = Assert.IsType<FileContentResult>(ok.Result);
        Assert.Equal("image/jpeg", file.ContentType);
        Assert.Equal("private, no-store", ok.Http.Response.Headers.CacheControl.ToString());
        Assert.Equal(new[] { "image.tmdb.org" }, rig.Hosts.Distinct());
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Primary, tag), "HEAD")).Result));

        var tampered = tag[..^1] + (tag[^1] == '0' ? '1' : '0');
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Primary, tampered))).Result));
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(Id(SyntheticId.Movie(438631)), ImageType.Primary, tag))).Result));
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Backdrop, tag))).Result));
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImageByIndex", null, Args(movie, ImageType.Primary, tag, 1))).Result));
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Primary, "plain-tag"))).Result));
        // A policy change (a new parental limit) ends the grants minted before it.
        viewer.MaxParentalRatingScore = 16;
        await Task.Delay(5100); // the revision is reused for 5 s
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Primary, tag))).Result));
        // So does disabling the feature.
        viewer.MaxParentalRatingScore = null;
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(movie, ImageType.Primary, tag))).Result));
    }

    [Fact]
    public async Task NoLibraryRowsNoUserDataNoEvents()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        viewer.DisplayMissingEpisodes = true;
        var me = Me(viewer);
        foreach (var (controller, action, args) in new (string, string, Dictionary<string, object?>)[]
        {
            ("UserLibrary", "GetItem", new() { ["itemId"] = Id(SyntheticId.Movie(693134)) }),
            ("UserLibrary", "GetItem", new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 1)) }),
            ("TvShows", "GetSeasons", new() { ["seriesId"] = Id(SyntheticId.Series(83867)) }),
            ("TvShows", "GetEpisodes", new() { ["seriesId"] = Id(SyntheticId.Series(83867)), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) }),
            ("Library", "GetSimilarItems", new() { ["itemId"] = Id(SyntheticId.Series(83867)) }),
            ("UserLibrary", "MarkFavoriteItem", new() { ["itemId"] = Id(SyntheticId.Movie(693134)) }),
        })
        {
            await Call(rig, controller, action, me, args, action.StartsWith("Mark", StringComparison.Ordinal) ? "POST" : "GET");
        }

        // The strict library mock throws on anything but these two reads (no create, update, delete,
        // refresh or people writes), and the facade has no user-data, session, provider or event service at all.
        rig.Library.Verify(l => l.GetItemById(It.IsAny<Guid>()), Times.AtLeastOnce());
        var forbidden = new[] { typeof(MediaBrowser.Controller.Library.IUserDataManager), typeof(MediaBrowser.Controller.Session.ISessionManager), typeof(MediaBrowser.Controller.Providers.IProviderManager), typeof(MediaBrowser.Controller.Persistence.IItemRepository) };
        foreach (var type in new[] { typeof(NativeDetailsFacadeFilter), typeof(NativeDetailsPolicy), typeof(NativeDetailsArtwork), typeof(SeerrNativeDetailsSource) })
        {
            var parameters = type.GetConstructors().SelectMany(c => c.GetParameters()).Select(p => p.ParameterType);
            Assert.DoesNotContain(parameters, forbidden.Contains);
        }
    }

    [Fact]
    public async Task SourceOutageAnswersRetryableNotEmpty()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        viewer.DisplayMissingEpisodes = true;
        var me = Me(viewer);
        var series = Id(SyntheticId.Series(83867));
        rig.Source.Down = true;
        Assert.Equal(503, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result));
        Assert.Equal(503, Status((await Call(rig, "TvShows", "GetSeasons", me, new() { ["seriesId"] = series })).Result));
        // A title the source doesn't know (a stale or hand-made id) is a plain 404, not an outage.
        rig.Source.Down = false;
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Movie(1)) })).Result));
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Series(2)) })).Result));
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetSeasons", me, new() { ["seriesId"] = Id(SyntheticId.Series(2)) })).Result));
        // Episode lists: a season the series doesn't have is 404; a season whose episodes can't be had
        // (unknown to the source or an outage) is an empty list, since jellyfin-web's list has no error handler.
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["season"] = 9 })).Result));
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 2)) })).Result).Items);
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result));
        rig.Source.SeasonsDown = true;
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result).Items);
        Assert.Equal(503, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 1)) })).Result));
        // A season page whose own episode data can't be had fails up front (retryable: the modal once),
        // never a season shown with no episodes.
        Assert.Equal(503, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result));
        rig.Source.SeasonsDown = false;
        // An unknown season of a known series is a plain 404.
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.SeasonOf(83867, 9)) })).Result));
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Person(5)) })).Result));
    }

    [Fact]
    public async Task SimilarShowsALibraryCopyOnlyWhenNativeWouldWithTheRequestedFields()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var inside = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Kids copy" };
        var outside = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Adults copy" };
        rig.Source.Recs = $$$"""
        {"results":[{"id":11,"mediaType":"movie","title":"Kids copy","mediaInfo":{"jellyfinMediaId":"{{{inside.Id:N}}}"}},
                    {"id":12,"mediaType":"movie","title":"Adults copy","mediaInfo":{"jellyfinMediaId":"{{{outside.Id:N}}}"}},
                    {"id":438631,"mediaType":"movie","title":"Dune","posterPath":"/d1.jpg"}]}
        """;
        // Both copies exist; native's user-scoped lookup (parental rules, parent chain, library access)
        // finds only the one in a library this viewer can open.
        rig.Library.Setup(l => l.GetItemById(inside.Id)).Returns(inside);
        rig.Library.Setup(l => l.GetItemById(outside.Id)).Returns(outside);
        rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(inside.Id, viewer)).Returns(inside);
        rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(outside.Id, viewer)).Returns((MediaBrowser.Controller.Entities.BaseItem?)null);
        var options = new List<MediaBrowser.Controller.Dto.DtoOptions>();
        rig.Dto.Setup(d => d.GetBaseItemDto(It.IsAny<MediaBrowser.Controller.Entities.BaseItem>(), It.IsAny<MediaBrowser.Controller.Dto.DtoOptions>(), viewer, null))
            .Returns((MediaBrowser.Controller.Entities.BaseItem item, MediaBrowser.Controller.Dto.DtoOptions o, User? _, MediaBrowser.Controller.Entities.BaseItem? _) =>
            {
                options.Add(o);
                return new BaseItemDto { Id = item.Id, Name = item.Name };
            });
        var fields = new[] { ItemFields.PrimaryImageAspectRatio, ItemFields.CanDelete };
        var similar = Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetSimilarItems", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)), ["limit"] = 12, ["fields"] = fields })).Result);
        Assert.Equal(new[] { "Kids copy", "Dune" }, similar.Items.Select(i => i.Name));
        Assert.Equal(inside.Id, similar.Items[0].Id);
        Assert.DoesNotContain(similar.Items, i => i.Id == outside.Id);
        // Only the requested fields (never Path, MediaSources, People ... unless asked for).
        Assert.Equal(fields, Assert.Single(options).Fields);
    }

    [Fact]
    public async Task SimilarListsOnlyAbsentTitlesWhosePageWouldOpen()
    {
        using var rig = new Rig();
        // This viewer can open the Shows library only: absent movies would be refused on their own page.
        var viewer = rig.Person();
        viewer.SetPermission(PermissionKind.EnableAllFolders, false);
        viewer.SetPreference(PreferenceKind.EnabledFolders, [ShowsLib.ToString("N")]);
        var me = Me(viewer);
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Movie(438631)) })).Result));
        rig.Source.Recs = """
        {"results":[{"id":438631,"mediaType":"movie","title":"Dune","posterPath":"/d1.jpg"},{"id":1399,"mediaType":"tv","name":"Game of Thrones","posterPath":"/g.jpg"}]}
        """;
        var similar = Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetSimilarItems", me, new() { ["itemId"] = Id(SyntheticId.Series(83867)) })).Result);
        Assert.Equal(new[] { "Game of Thrones" }, similar.Items.Select(i => i.Name));
        Assert.Equal(1, similar.TotalRecordCount);
    }

    [Fact]
    public async Task SimilarLeavesOutWhatTheViewerHidWithHiddenContent()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.HiddenContentEnabled = true;
        var viewer = rig.Person();
        var other = rig.Person();
        var copy = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Hidden copy" };
        rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(copy.Id, It.IsAny<User>())).Returns(copy);
        rig.Dto.Setup(d => d.GetBaseItemDto(It.IsAny<MediaBrowser.Controller.Entities.BaseItem>(), It.IsAny<MediaBrowser.Controller.Dto.DtoOptions>(), It.IsAny<User>(), null))
            .Returns((MediaBrowser.Controller.Entities.BaseItem item, MediaBrowser.Controller.Dto.DtoOptions _, User? _, MediaBrowser.Controller.Entities.BaseItem? _) => new BaseItemDto { Id = item.Id, Name = item.Name });
        rig.Source.Recs = $$$"""
        {"results":[{"id":438631,"mediaType":"movie","title":"Dune","posterPath":"/d1.jpg"},
                    {"id":1399,"mediaType":"tv","name":"Game of Thrones","posterPath":"/g.jpg"},
                    {"id":603,"mediaType":"movie","title":"The Matrix","posterPath":"/m.jpg"},
                    {"id":12,"mediaType":"movie","title":"Hidden copy","mediaInfo":{"jellyfinMediaId":"{{{copy.Id:N}}}"}},
                    {"id":1400,"mediaType":"tv","name":"Seinfeld","posterPath":"/s.jpg"}]}
        """;
        // Hidden by provider key (a title that isn't in the library), by Jellyfin id (a library copy), a
        // movie hide that must not hide the series with the same TMDB number, and a scoped hide that
        // applies to Next Up only.
        var hide = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent();
        hide.Items["tmdb-438631"] = new() { ItemId = string.Empty, TmdbId = "438631", Type = "Movie", Name = "Dune" };
        hide.Items[copy.Id.ToString("N")] = new() { ItemId = copy.Id.ToString("N"), Type = "Movie", Name = "Hidden copy" };
        hide.Items["tmdb-1399"] = new() { ItemId = string.Empty, TmdbId = "1399", Type = "Movie", Name = "Same number, a movie" };
        hide.Items["tmdb-1400"] = new() { ItemId = string.Empty, TmdbId = "1400", Type = "Series", Name = "Seinfeld", HideScope = "nextup" };
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "hidden-content.json", hide);
        async Task<QueryResult<BaseItemDto>> Similar(User who, int limit = 12)
            => Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetSimilarItems", Me(who), new() { ["itemId"] = Id(SyntheticId.Movie(693134)), ["limit"] = limit })).Result);

        var mine = await Similar(viewer);
        Assert.Equal(new[] { "Game of Thrones", "The Matrix", "Seinfeld" }, mine.Items.Select(i => i.Name));
        Assert.Equal(3, mine.TotalRecordCount);
        // Before the limit: two shown means the first two that aren't hidden.
        Assert.Equal(new[] { "Game of Thrones", "The Matrix" }, (await Similar(viewer, 2)).Items.Select(i => i.Name));
        // Someone else's hides are theirs.
        Assert.Equal(5, (await Similar(other)).TotalRecordCount);
        // The viewer's recommendations switch off, or Hidden Content off: nothing is left out.
        hide.Settings.FilterRecommendations = false;
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "hidden-content.json", hide);
        Assert.Equal(5, (await Similar(viewer)).TotalRecordCount);
        hide.Settings.FilterRecommendations = true;
        hide.Settings.Enabled = false;
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "hidden-content.json", hide);
        Assert.Equal(5, (await Similar(viewer)).TotalRecordCount);
    }

    [Fact]
    public async Task ArtworkGrantsEndWhenTheViewerMayNoLongerUseNativeDetails()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
        var args = new Dictionary<string, object?> { ["itemId"] = movie, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
        // Import-blocked by the admin: old image URLs stop at once (no restart, no revision wait).
        rig.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = viewer.Id.ToString("N");
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
        rig.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = string.Empty;
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
        // Unlinked in Seerr: the same.
        rig.Source.Linked.Remove(viewer.Id);
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
    }

    [Fact]
    public async Task JellyfinEnhancedsOwnPageReadsRunForSyntheticIdsOfTheirKinds()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        var season = Id(SyntheticId.SeasonOf(83867, 1));
        // The route runs (it applies the page's viewer rules itself, by key).
        Assert.Equal(1, (await Call(rig, "ArrStatus", "GetItemStatus", Me(viewer), new() { ["itemId"] = movie.ToString("N") })).NextCalls);
        Assert.Equal(1, (await Call(rig, "AcquireRequests", "Season", Me(viewer), new() { ["itemId"] = season.ToString("N") })).NextCalls);
        Assert.Equal(1, (await Call(rig, "NativeDetails", "Resolve", Me(viewer), new() { ["id"] = movie.ToString("N") })).NextCalls);
        // Anything else of theirs naming a synthetic id is refused like any other action.
        var seasonRowsForMovie = await Call(rig, "AcquireRequests", "Season", Me(viewer), new() { ["itemId"] = movie.ToString("N") });
        Assert.Equal((404, 0), (Status(seasonRowsForMovie.Result), seasonRowsForMovie.NextCalls));
        var person = await Call(rig, "ArrStatus", "GetItemStatus", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Person(1190668)).ToString("N") });
        Assert.Equal((404, 0), (Status(person.Result), person.NextCalls));
        var write = await Call(rig, "ArrStatus", "GetItemStatus", Me(viewer), new() { ["itemId"] = movie.ToString("N") }, "POST");
        Assert.Equal((403, 0), (Status(write.Result), write.NextCalls));
        // Switched off: refused before the route.
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        var off = await Call(rig, "ArrStatus", "GetItemStatus", Me(viewer), new() { ["itemId"] = movie.ToString("N") });
        Assert.Equal((404, 0), (Status(off.Result), off.NextCalls));
    }

    private static NativeDetailsPages Pages(Rig rig, DateTime? now = null)
    {
        var host = new Mock<MediaBrowser.Controller.IServerApplicationHost>();
        host.SetupGet(h => h.SystemId).Returns(Server);
        return new NativeDetailsPages(rig.Callers.Users.Object, host.Object, rig.Source, rig.Policy, () => now ?? new DateTime(2026, 10, 15, 0, 0, 0, DateTimeKind.Utc), rig.SpoilerUsers);
    }

    [Fact]
    public async Task PageIdsResolveToTheTitlesKeyAndPublicSeasonFactsUnderThePagesRules()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var pages = Pages(rig);
        // Ordinary ids are not pages; persons never are.
        Assert.Equal(AbsentLookup.NotAbsent, (await pages.ResolveAsync(viewer.Id, Guid.NewGuid(), CancellationToken.None)).Outcome);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.Person(1)), CancellationToken.None)).Outcome);
        var movie = (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.Movie(693134)), CancellationToken.None)).Title!;
        Assert.Equal(("movie", "movie:tmdb:693134"), (movie.Kind, movie.Title.ToString()));
        // A series is keyed by TVDB when Seerr names it; seasons count their aired episodes.
        var series = (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.Series(83867)), CancellationToken.None)).Title!;
        Assert.Equal("tv:tvdb:393189", series.Title.ToString());
        Assert.Equal(new[] { (1, 3, 3), (2, 12, 12) }, series.Seasons.Select(x => (x.Season, x.Episodes, x.Aired)));
        Assert.Equal(Id(SyntheticId.SeasonOf(83867, 2)), series.Seasons[1].PageId);
        var before = (await Pages(rig, new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc)).ResolveAsync(viewer.Id, Id(SyntheticId.Series(83867)), CancellationToken.None)).Title!;
        Assert.Equal(0, before.Seasons[1].Aired);
        // A season page: its episodes with page ids; rows exactly when the viewer shows missing episodes.
        var season = (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!;
        Assert.Equal(("season", 1, "tv:tvdb:393189:s1"), (season.Kind, season.Season!.Value, season.ScopeKey.ToString()));
        Assert.Equal(new[] { 1, 2, 3 }, season.Episodes.Select(e => e.Episode));
        Assert.Equal(Id(SyntheticId.EpisodeOf(83867, 1, 2)), season.Episodes[1].PageId);
        Assert.Equal(Id(SyntheticId.Series(83867)), season.SeriesPageId);
        Assert.False(season.Rows);
        viewer.DisplayMissingEpisodes = true;
        Assert.True((await pages.ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!.Rows);
        var episode = (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.EpisodeOf(83867, 1, 3)), CancellationToken.None)).Title!;
        Assert.Equal("tv:tvdb:393189:s1:e3", episode.ScopeKey.ToString());
        // Unknown seasons/episodes/titles and viewers the page refuses: refused; an outage: unavailable.
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 7)), CancellationToken.None)).Outcome);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.EpisodeOf(83867, 1, 9)), CancellationToken.None)).Outcome);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.Movie(5)), CancellationToken.None)).Outcome);
        var unlinked = rig.Person(linked: false);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(unlinked.Id, Id(SyntheticId.Movie(693134)), CancellationToken.None)).Outcome);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(Guid.NewGuid(), Id(SyntheticId.Movie(693134)), CancellationToken.None)).Outcome);
        rig.Source.Down = true;
        Assert.Equal(AbsentLookup.Unavailable, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.Movie(693134)), CancellationToken.None)).Outcome);
    }

    [Fact]
    public async Task AnUnknownSeerrLinkFailsOverInsteadOfRefusing()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        rig.Source.LinkUnknown = true;
        // Retryable (the page falls back to the modal once), not the refusal a hidden title gets.
        Assert.Equal(503, Status((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result));
        Assert.Equal(AbsentLookup.Unavailable, (await Pages(rig).ResolveAsync(viewer.Id, movie, CancellationToken.None)).Outcome);
        Assert.False(await rig.Policy.ViewerMayUseAsync(viewer, CancellationToken.None));
        rig.Source.LinkUnknown = false;
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result));
    }

    [Fact]
    public async Task ASignOutEndsTheViewersArtworkGrants()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var other = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        async Task<Dictionary<string, object?>> ArgsFor(User who)
        {
            var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(who), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
            return new Dictionary<string, object?> { ["itemId"] = movie, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
        }

        var mine = await ArgsFor(viewer);
        var theirs = await ArgsFor(other);
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(mine))).Result));
        rig.Policy.Revoke(viewer.Id);
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(mine))).Result));
        // Only that viewer's grants; a new page view mints working ones.
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(theirs))).Result));
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(await ArgsFor(viewer)))).Result));
    }

    [Fact]
    public async Task ASignOutStillEndsTheGrantsAfterARestart()
    {
        var dir = Path.Combine(Path.GetTempPath(), "je-3e-epochs-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var rig = new Rig(dir);
            var viewer = rig.Person();
            var other = rig.Person();
            var movie = Id(SyntheticId.Movie(693134));
            async Task<Dictionary<string, object?>> ArgsFor(User who)
            {
                var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(who), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
                return new Dictionary<string, object?> { ["itemId"] = movie, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
            }

            var mine = await ArgsFor(viewer);
            var theirs = await ArgsFor(other);
            rig.Policy.Revoke(viewer.Id);
            Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(mine))).Result));
            // The key outlives the restart, and so does the sign-out: the old URL stays dead.
            rig.Restart();
            Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(mine))).Result));
            // Open pages of everyone else keep working across the restart; a new page view mints working grants.
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(theirs))).Result));
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(await ArgsFor(viewer)))).Result));
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(dir, NativeDetailsPolicy.EpochFile)));
            }

            // An unreadable file doesn't fail the service (it fails closed: see RevocationStateThatCantBeTrustedEndsEveryEarlierGrant).
            File.WriteAllText(Path.Combine(dir, NativeDetailsPolicy.EpochFile), "{not json");
            rig.Restart();
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(await ArgsFor(other)))).Result));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    /// <summary>
    /// Andor in the library: the series, seasons 1 and 2, S1E1 and S1E2 (with <paramref name="combined"/>, one file
    /// S1E1-E2 instead). Items in <c>hidden</c> are ones Jellyfin hides from the viewer.
    /// </summary>
    private sealed record Shelf(Guid Series, Guid Season1, Guid Season2, Guid Episode1, Guid Episode2, HashSet<Guid> Hidden);

    private static Shelf Library(Rig rig, params User[] viewers) => Library(rig, false, viewers);

    private static Shelf Library(Rig rig, bool combined, params User[] viewers)
    {
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), Name = "Andor" };
        var s1 = new MediaBrowser.Controller.Entities.TV.Season { Id = Guid.NewGuid(), IndexNumber = 1, SeriesId = series.Id };
        var s2 = new MediaBrowser.Controller.Entities.TV.Season { Id = Guid.NewGuid(), IndexNumber = 2, SeriesId = series.Id };
        var e1 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = 1, IndexNumberEnd = combined ? 2 : null, ParentIndexNumber = 1, SeriesId = series.Id };
        var e2 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = 2, ParentIndexNumber = 1, SeriesId = series.Id };
        var hidden = new HashSet<Guid>();
        // Unscoped queries (no user): what the library holds, whoever may see it.
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Series) && q.HasAnyProviderId != null && q.HasAnyProviderId.ContainsKey("Tmdb") && q.HasAnyProviderId["Tmdb"] == "83867")))
            .Returns(new List<MediaBrowser.Controller.Entities.BaseItem> { series });
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Season) && q.AncestorIds.Contains(series.Id))))
            .Returns(new List<MediaBrowser.Controller.Entities.BaseItem> { s1, s2 });
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Episode) && q.AncestorIds.Contains(s1.Id))))
            .Returns(combined ? new List<MediaBrowser.Controller.Entities.BaseItem> { e1 } : new List<MediaBrowser.Controller.Entities.BaseItem> { e1, e2 });
        foreach (var viewer in viewers)
        {
            foreach (var item in new MediaBrowser.Controller.Entities.BaseItem[] { series, s1, s2, e1, e2 })
            {
                // Jellyfin's own check for this viewer (rating, custom rating, tags, parents, library access).
                rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(item.Id, viewer)).Returns(() => hidden.Contains(item.Id) ? null : item);
            }
        }

        // A part the viewer can open is listed as itself: native's own DTO (a stand-in with its id and number).
        rig.Dto.Setup(d => d.GetBaseItemDto(It.Is<MediaBrowser.Controller.Entities.BaseItem>(i => i.Id == series.Id || i.Id == s1.Id || i.Id == s2.Id || i.Id == e1.Id || i.Id == e2.Id), It.IsAny<MediaBrowser.Controller.Dto.DtoOptions>(), It.IsAny<User>(), null))
            .Returns((MediaBrowser.Controller.Entities.BaseItem i, MediaBrowser.Controller.Dto.DtoOptions _, User _, MediaBrowser.Controller.Entities.BaseItem? _) => new BaseItemDto { Id = i.Id, IndexNumber = i.IndexNumber, Name = "library " + i.Id.ToString("N") });
        return new Shelf(series.Id, s1.Id, s2.Id, e1.Id, e2.Id, hidden);
    }

    [Fact]
    public async Task AFileHoldingSeveralEpisodesIsListedOnceAndNoneOfItsEpisodesAsMissing()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        viewer.MaxParentalRatingScore = 18;
        viewer.DisplayMissingEpisodes = true;
        var me = Me(viewer);
        // The library has S1E1-E2 as one file; public data lists E1, E2 and E3.
        var shelf = Library(rig, true, viewer);
        var episodes = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = Id(SyntheticId.Series(83867)), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
        // The file once (as itself), then the episode it doesn't hold: no stand-in "missing" E2 next to the file.
        Assert.Equal(new[] { shelf.Episode1, Id(SyntheticId.EpisodeOf(83867, 1, 3)) }, episodes.Items.Select(i => i.Id));
        Assert.Equal(2, episodes.TotalRecordCount);
    }

    [Fact]
    public async Task WhatTheLibraryHidesFromTheViewerIsNeverRemadeFromPublicData()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        // A parental limit the title passes (TMDB rating): Jellyfin may still hide parts of the library copy.
        viewer.MaxParentalRatingScore = 18;
        viewer.DisplayMissingEpisodes = true;
        rig.Source.KnownSeasons.Add(2);
        var me = Me(viewer);
        var series = Id(SyntheticId.Series(83867));
        var shelf = Library(rig, viewer);
        async Task<int> Item(SyntheticId id) => Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(id) })).Result);
        async Task<Dictionary<string, object?>> ImageOf(SyntheticId id)
        {
            var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(id) })).Result).ImageTags[ImageType.Primary];
            return new Dictionary<string, object?> { ["itemId"] = Id(id), ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
        }

        // Nothing hidden yet: every part of the title answers.
        Assert.Equal(200, await Item(SyntheticId.SeasonOf(83867, 2)));
        Assert.Equal(200, await Item(SyntheticId.EpisodeOf(83867, 1, 2)));
        var stillOfE2 = await ImageOf(SyntheticId.EpisodeOf(83867, 1, 2));
        var seasonPoster = await ImageOf(SyntheticId.SeasonOf(83867, 2));
        var seriesPoster = await ImageOf(SyntheticId.Series(83867));

        // Jellyfin now hides season 2 and S1E2 from this viewer (a custom rating, a blocked tag).
        shelf.Hidden.Add(shelf.Season2);
        shelf.Hidden.Add(shelf.Episode2);
        Assert.Equal(404, await Item(SyntheticId.SeasonOf(83867, 2)));
        Assert.Equal(404, await Item(SyntheticId.EpisodeOf(83867, 2, 1)));
        Assert.Equal(404, await Item(SyntheticId.EpisodeOf(83867, 1, 2)));
        Assert.Equal(200, await Item(SyntheticId.EpisodeOf(83867, 1, 1)));
        Assert.Equal(200, await Item(SyntheticId.SeasonOf(83867, 1)));
        var seasons = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetSeasons", me, new() { ["seriesId"] = series })).Result);
        Assert.Equal(new int?[] { 1 }, seasons.Items.Select(i => i.IndexNumber));
        // What the viewer can open in the library is listed as itself, never as a stand-in from public data.
        Assert.Equal(shelf.Season1, seasons.Items.Single().Id);
        var episodes = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
        Assert.Equal(new int?[] { 1, 3 }, episodes.Items.Select(i => i.IndexNumber));
        Assert.Equal(new[] { shelf.Episode1, Id(SyntheticId.EpisodeOf(83867, 1, 3)) }, episodes.Items.Select(i => i.Id));
        // A season page of the series: it belongs to the library's series (its links go there).
        var seasonOne = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
        Assert.Equal((shelf.Series, shelf.Series), (seasonOne.SeriesId, seasonOne.ParentId));
        // jellyfin-web then lists the season's episodes by the library's series and the page's season.
        var bySeries = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = shelf.Series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
        Assert.Equal(new int?[] { 1, 3 }, bySeries.Items.Select(i => i.IndexNumber));
        // A series id that isn't a copy of this title (or one the viewer can't open) is a mismatched scope.
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = Guid.NewGuid(), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result));
        var episodeThree = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 3)) })).Result);
        Assert.Equal((shelf.Series, shelf.Season1, shelf.Season1), (episodeThree.SeriesId, episodeThree.SeasonId, episodeThree.ParentId));
        // And an episode page's parents: the library's season and series.
        var parents = Value<List<BaseItemDto>>((await Call(rig, "Library", "GetAncestors", me, new() { ["itemId"] = Id(SyntheticId.EpisodeOf(83867, 1, 3)) })).Result);
        Assert.Equal(new[] { shelf.Season1, shelf.Series }, parents.Select(p => p.Id));
        Assert.Equal(2, episodes.TotalRecordCount);
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 2)) })).Result));
        Assert.Equal(404, Status((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["season"] = 2 })).Result));
        // Artwork of the hidden parts, minted before: no longer served; the title's own still is.
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(stillOfE2))).Result));
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(seasonPoster))).Result));
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(seriesPoster))).Result));
        // The status pages: no season entry, episode or row for the hidden parts.
        var pages = Pages(rig);
        var seriesPage = (await pages.ResolveAsync(viewer.Id, series, CancellationToken.None)).Title!;
        Assert.Equal(new[] { 1 }, seriesPage.Seasons.Select(x => x.Season));
        // The series page names what is hidden (numbers only), so its status leaves Sonarr's states of them out too.
        Assert.Equal(new[] { 2 }, seriesPage.HiddenSeasons);
        Assert.Equal(new[] { (1, 2) }, seriesPage.HiddenSeriesEpisodes);
        var seasonPage = (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!;
        Assert.Equal(new[] { 1, 3 }, seasonPage.Episodes.Select(e => e.Episode));
        Assert.Equal(new[] { 2 }, seasonPage.HiddenEpisodes);
        Assert.Equal(new[] { 2 }, seasonPage.HiddenSeasons);
        Assert.Empty(seasonPage.HiddenSeriesEpisodes);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 2)), CancellationToken.None)).Outcome);
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, Id(SyntheticId.EpisodeOf(83867, 1, 2)), CancellationToken.None)).Outcome);
        // The whole series hidden (another library, a blocked tag): its page isn't re-made either.
        shelf.Hidden.Add(shelf.Series);
        Assert.Equal(404, await Item(SyntheticId.Series(83867)));
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(seriesPoster))).Result));
        Assert.Equal(AbsentLookup.Refused, (await pages.ResolveAsync(viewer.Id, series, CancellationToken.None)).Outcome);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GuardedTvRatingsHonorSuppressionThroughProducerAndFinalGate(bool suppress)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var spoilers = PrivacyOperationalProjectionTests.Guard(rig.Plugin, viewer.Id, "tv:tmdb:83867", suppress);
        var answer = await rig.Feeds.RatingsAsync(viewer, false, 83867, default);
        Assert.Equal(FeedOutcome.Ok, answer.Outcome);
        var final = PrivacyOperationalProjectionTests.Final(rig.Plugin, spoilers, viewer.Id,
            "native-details/title/tv/83867/ratings", new ContentResult { Content = answer.Json, ContentType = "application/json" });
        if (suppress)
        {
            Assert.Equal("null", answer.Json);
            Assert.Null(final);
        }
        else
        {
            Assert.Equal(96, Body(answer).GetProperty("criticsScore").GetInt32());
            Assert.Equal(96, final["criticsScore"]!.GetValue<int>());
        }
    }

    [Theory]
    [InlineData("title")]
    [InlineData("season")]
    [InlineData("ratings")]
    public async Task GuardedNativeJsonProducersKeepTheirDeclaredOperationalShape(string resource)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        PrivacyOperationalProjectionTests.Guard(rig.Plugin, viewer.Id, resource == "title" ? "movie:tmdb:693134" : "tv:tmdb:83867");
        rig.Source.KnownSeasons.Add(2);
        var answer = resource switch
        {
            "title" => await rig.Feeds.TitleAsync(viewer, true, 693134, default),
            "season" => await rig.Feeds.SeasonAsync(viewer, 83867, 2, default),
            _ => await rig.Feeds.RatingsAsync(viewer, false, 83867, default)
        };
        Assert.Equal(FeedOutcome.Ok, answer.Outcome);
        if (resource == "ratings") { Assert.Equal("null", answer.Json); return; }
        var row = Body(answer);
        Assert.True(row.GetProperty("jeSpoiler").GetProperty("guarded").GetBoolean());
        if (resource == "title")
        {
            Assert.Equal(693134, row.GetProperty("id").GetInt32());
            Assert.Equal(167, row.GetProperty("runtime").GetInt32());
            Assert.Equal("Dune: Part Two", row.GetProperty("title").GetString());
            Assert.False(row.TryGetProperty("overview", out _));
            Assert.False(row.TryGetProperty("posterPath", out _));
        }
        else
        {
            Assert.Equal(2, row.GetProperty("seasonNumber").GetInt32());
            Assert.Equal(3, row.GetProperty("episodes").GetArrayLength());
            var episode = row.GetProperty("episodes")[0];
            Assert.Equal(2, episode.GetProperty("seasonNumber").GetInt32());
            Assert.Equal(1, episode.GetProperty("episodeNumber").GetInt32());
            Assert.Equal(40, episode.GetProperty("runtime").GetInt32());
            Assert.Equal("", episode.GetProperty("name").GetString());
            Assert.False(episode.TryGetProperty("overview", out _));
            Assert.False(episode.TryGetProperty("stillPath", out _));
        }
    }

    [Fact]
    public async Task PendingGuardProjectsRawPublicDetailsAndEachRelatedTitleIndependently()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        rig.Source.Related["movie:693134:recommendations:1"] = RecsJson;
        var viewer = rig.Person(); var other = rig.Person();
        var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
        state.PendingTmdb["movie:693134"] = new();
        state.PendingTmdb["movie:438631"] = new();
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "spoilerblur.json", state);
        SpoilerUserResolver.InvalidateUser(viewer.Id.ToString("N"));
        var raw = Body(await rig.Feeds.TitleAsync(viewer, true, 693134, CancellationToken.None));
        Assert.False(raw.TryGetProperty("overview", out var overview) && !string.IsNullOrEmpty(overview.GetString()));
        Assert.False(raw.TryGetProperty("voteAverage", out var rating) && rating.ValueKind == JsonValueKind.Number);
        Assert.True(raw.GetProperty("jeSpoiler").GetProperty("guarded").GetBoolean());
        Assert.False(string.IsNullOrEmpty(Body(await rig.Feeds.TitleAsync(other, true, 693134, CancellationToken.None)).GetProperty("overview").GetString()));
        var cards = Body(await rig.Feeds.RelatedAsync(viewer, true, 693134, "recommendations", 1, CancellationToken.None)).GetProperty("results");
        Assert.False(cards[0].TryGetProperty("voteAverage", out var score) && score.ValueKind == JsonValueKind.Number);
        Assert.True(cards[0].GetProperty("jeSpoiler").GetProperty("guarded").GetBoolean());
        Assert.False(cards[1].GetProperty("jeSpoiler").GetProperty("guarded").GetBoolean());
        // A shared raw source remains unchanged when another viewer reads it afterwards.
        Assert.Equal(7.8, Body(await rig.Feeds.RelatedAsync(other, true, 693134, "recommendations", 1, CancellationToken.None)).GetProperty("results")[0].GetProperty("voteAverage").GetDouble());
    }

    [Fact]
    public async Task OldLogoGrantIsProtectedAfterGuardActivation()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        rig.Plugin.Plugin.Configuration.SpoilerBlurArtwork = true;
        var viewer = rig.Person();
        var before = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result);
        var art = new Dictionary<string, object?> { ["itemId"] = before.Id, ["imageType"] = ImageType.Logo, ["tag"] = before.ImageTags[ImageType.Logo] };
        var original = Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, new(art))).Result).FileContents;
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "spoilerblur.json",
            new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur { PendingTmdb = new() { ["movie:693134"] = new() } });
        var protectedArt = Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, new(art))).Result);
        Assert.NotEqual(original, protectedArt.FileContents);
    }

    [Fact]
    public async Task ProviderGuardProtectsMissingRowsUnderAnExistingLibrarySeasonAndOldMovieArtUrls()
    {
        using var rig = new Rig();
        using var requests = new IntegrationRequestLedgerTests.Rig();
        rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        rig.Plugin.Plugin.Configuration.SpoilerKeepMoviePosters = false;
        var viewer = rig.Person();
        var before = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result);
        var art = new Dictionary<string, object?> { ["itemId"] = before.Id, ["imageType"] = ImageType.Primary, ["tag"] = before.ImageTags[ImageType.Primary] };
        var original = Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, art)).Result).FileContents;
        var seasonId = Guid.NewGuid(); var seriesId = Guid.NewGuid();
        var title = TitleKey.Parse("tv:tmdb:83867")!;
        requests.View.AddItem(new JfItemRef { ItemId = seasonId, Kind = "season", Key = title.WithSeason(2), SeriesId = seriesId, Season = 2, TmdbId = 83867 });
        var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
        state.ProviderTitles["tv:tmdb:83867"] = new(); state.PendingTmdb["movie:693134"] = new();
        rig.Plugin.Core.Manager.SaveUserConfiguration(requests.Member.ToString("N"), "spoilerblur.json", state);
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "spoilerblur.json", state);
        var presentation = new SpoilerPresentation(rig.Plugin.Core.Manager, rig.Library.Object, rig.Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object);
        var rows = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.SeasonRowsService(requests.View, requests.Ledger, requests.Policy, null,
            (_, _, _, _) => Task.FromResult<string?>("""{"episodes":[{"episode_number":1,"name":"Secret title","overview":"Secret plot","air_date":"2030-01-02","still_path":"/secret.jpg"}]}"""), () => requests.Now, presentation);
        var answer = await rows.ForSeasonAsync(requests.View.Users[requests.Member], seasonId, null, CancellationToken.None);
        var episode = Assert.Single(answer!.Episodes);
        Assert.Null(episode.Title); Assert.Null(episode.Overview); Assert.Null(episode.AirDate); Assert.Null(episode.Still);
        var protectedArt = Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, new(art))).Result);
        Assert.NotEqual(original, protectedArt.FileContents);
        var after = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = before.Id })).Result);
        Assert.NotEqual(before.ImageTags[ImageType.Primary], after.ImageTags[ImageType.Primary]);
    }

    [Fact]
    public async Task SpoilerGuardOnATitleTheViewerGuardsAppliesToItsNativePage()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        var viewer = rig.Person();
        var fan = rig.Person();
        var other = rig.Person();
        rig.Source.KnownSeasons.Add(2);
        var series = Id(SyntheticId.Series(83867));
        var episode = Id(SyntheticId.EpisodeOf(83867, 1, 1));
        var shelf = Library(rig, viewer, fan, other);
        // A third season the library doesn't have.
        rig.Source.Series = SeriesJson.Replace("{\"seasonNumber\":2,", "{\"seasonNumber\":3,\"name\":\"Season 3\",\"episodeCount\":8,\"airDate\":\"2027-04-22\",\"posterPath\":\"/s3.jpg\"},{\"seasonNumber\":2,", StringComparison.Ordinal);
        rig.Source.KnownSeasons.Add(3);
        async Task<BaseItemDto> Item(User who, Guid id) => Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(who), new() { ["itemId"] = id })).Result);
        Dictionary<string, object?> Still(BaseItemDto dto) => new() { ["itemId"] = dto.Id, ["imageType"] = ImageType.Primary, ["tag"] = dto.ImageTags[ImageType.Primary], ["maxWidth"] = 300 };
        void Guard(User who, Action<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur> on)
        {
            var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
            on(state);
            rig.Plugin.Core.Manager.SaveUserConfiguration(who.Id.ToString("N"), "spoilerblur.json", state);
            SpoilerUserResolver.InvalidateUser(who.Id.ToString("N"));
        }

        try
        {
            // A still drawn before the viewer guarded the title.
            var before = await Item(viewer, episode);
            Assert.Equal(("Kassa", "Cassian looks for his sister."), (before.Name, before.Overview));
            var still = Still(before);
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(still))).Result));
            var seriesPoster = new Dictionary<string, object?> { ["itemId"] = series, ["imageType"] = ImageType.Primary, ["tag"] = (await Item(viewer, series)).ImageTags[ImageType.Primary], ["maxWidth"] = 300 };

            // The viewer turns Spoiler Guard on for Andor from Seerr, before it is in the library (a pending entry).
            Guard(viewer, s => s.PendingTmdb["tv:83867"] = new());
            var guarded = await Item(viewer, episode);
            Assert.Equal("Season 1, Episode 1", guarded.Name);
            Assert.Equal("Spoiler Guard activated", guarded.Overview);
            Assert.Null(guarded.CommunityRating);
            Assert.False(guarded.ImageTags?.ContainsKey(ImageType.Primary) == true);
            Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(still))).Result));
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(seriesPoster))).Result));
            viewer.DisplayMissingEpisodes = true;
            var list = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", Me(viewer), new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
            // Episodes the viewer can open in the library are listed as themselves (Spoiler Guard's library
            // rules apply to them, by watched state); the absent ones are stripped here.
            var absent = list.Items.Where(e => SyntheticId.HasNamespace(e.Id)).ToList();
            Assert.Equal(new[] { shelf.Episode1, shelf.Episode2 }, list.Items.Where(e => !SyntheticId.HasNamespace(e.Id)).Select(e => e.Id));
            Assert.NotEmpty(absent);
            Assert.All(absent, e => Assert.StartsWith("Season 1, Episode ", e.Name, StringComparison.Ordinal));
            Assert.All(absent, e => Assert.False(e.ImageTags?.ContainsKey(ImageType.Primary) == true));
            // Seasons: the library's own are themselves; a later absent one has no poster.
            var seasons = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetSeasons", Me(viewer), new() { ["seriesId"] = series })).Result).Items;
            Assert.Equal(new[] { shelf.Season1, shelf.Season2 }, seasons.Where(x => x.IndexNumber is 1 or 2).Select(x => x.Id));
            Assert.False(seasons.Single(x => x.IndexNumber == 3).ImageTags?.ContainsKey(ImageType.Primary) == true);

            // The season's rows (the status page) carry no plot either, by the same switches.
            var rows = (await Pages(rig).ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!;
            Assert.Equal(new AbsentRowSpoilers(true, true, true), rows.Spoilers);
            Guard(viewer, s => { s.PendingTmdb["tv:83867"] = new(); s.Prefs = new() { HideAirDate = false }; });
            Assert.Equal(new AbsentRowSpoilers(true, true, false), (await Pages(rig).ResolveAsync(viewer.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!.Spoilers);
            Assert.Null((await Pages(rig).ResolveAsync(other.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!.Spoilers);

            // Another viewer who guards the library copy of the series gets the same.
            Guard(fan, s => s.Series[shelf.Series.ToString("N")] = new());
            Assert.Equal("Season 1, Episode 1", (await Item(fan, episode)).Name);
            Assert.NotNull((await Pages(rig).ResolveAsync(fan.Id, Id(SyntheticId.SeasonOf(83867, 1)), CancellationToken.None)).Title!.Spoilers);
            // Nobody else is touched.
            var plain = await Item(other, episode);
            Assert.Equal("Kassa", plain.Name);
            Assert.True(plain.ImageTags.ContainsKey(ImageType.Primary));
            // Spoiler Guard off: the page is as public data has it.
            rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = false;
            Assert.Equal("Kassa", (await Item(viewer, episode)).Name);
        }
        finally
        {
            foreach (var who in new[] { viewer, fan }) SpoilerUserResolver.InvalidateUser(who.Id.ToString("N"));
        }
    }

    [Fact]
    public async Task RevocationStateThatCantBeTrustedEndsEveryEarlierGrant()
    {
        var dir = Path.Combine(Path.GetTempPath(), "je-3e-epochs-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(dir, NativeDetailsPolicy.EpochFile);
        try
        {
            using var rig = new Rig(dir);
            var viewer = rig.Person();
            var other = rig.Person();
            var movie = Id(SyntheticId.Movie(693134));
            async Task<Dictionary<string, object?>> ArgsFor(User who)
            {
                var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(who), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
                return new Dictionary<string, object?> { ["itemId"] = movie, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
            }

            async Task<int> Image(Dictionary<string, object?> args) => Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result);

            // A healthy restart keeps open pages working.
            var theirs = await ArgsFor(other);
            rig.Restart();
            Assert.Equal(200, await Image(theirs));

            // A corrupt or truncated epochs file: nothing about earlier sign-outs is known, so no earlier grant verifies.
            File.WriteAllText(file, "{not json");
            rig.Restart();
            Assert.Equal(404, await Image(theirs));
            theirs = await ArgsFor(other);
            Assert.Equal(200, await Image(theirs));

            // A sign-out that couldn't be written (full disk): the file is dropped, and the next start ends
            // every earlier grant, even once the disk is fine again.
            Directory.CreateDirectory(file + ".tmp");
            rig.Policy.Revoke(viewer.Id);
            Assert.False(File.Exists(file));
            Directory.Delete(file + ".tmp");
            rig.Restart();
            Assert.Equal(404, await Image(theirs));
            theirs = await ArgsFor(other);

            // A folder that can't be written at start (read-only): the state on disk may be missing a
            // sign-out made since, so it isn't trusted either.
            if (!OperatingSystem.IsWindows() && Environment.UserName != "root")
            {
                rig.Policy.Revoke(viewer.Id);
                var mine = await ArgsFor(viewer);
                File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute);
                rig.Policy.Revoke(viewer.Id);
                rig.Restart();
                Assert.Equal(404, await Image(mine));
                Assert.Equal(404, await Image(theirs));
                File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                Directory.Delete(dir, true);
            }
        }
    }

    [Fact]
    public void OneViewerCantMakeTheServerFetchWithoutBound()
    {
        var now = new DateTime(2026, 10, 15, 0, 0, 0, DateTimeKind.Utc);
        using var images = new IntegrationTransport((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)));
        var artwork = new NativeDetailsArtwork(images, null, () => now);
        var viewer = Guid.NewGuid();
        Assert.Equal(NativeDetailsArtwork.UpstreamBurst, Enumerable.Range(0, NativeDetailsArtwork.UpstreamBurst + 50).Count(_ => artwork.TakeUpstream(viewer)));
        Assert.True(artwork.TakeUpstream(Guid.NewGuid())); // another viewer has their own budget
        now = now.AddSeconds(10);
        Assert.Equal((int)(10 * NativeDetailsArtwork.UpstreamPerSecond), Enumerable.Range(0, 100).Count(_ => artwork.TakeUpstream(viewer)));
    }

    [Fact]
    public void TheGrantKeyOutlivesARestartAndStaysPrivate()
    {
        var dir = Path.Combine(Path.GetTempPath(), "je-3e-key-" + Guid.NewGuid().ToString("N"));
        try
        {
            var first = NativeDetailsArtwork.LoadKey(dir);
            Assert.Equal(first, NativeDetailsArtwork.LoadKey(dir));
            Assert.Equal(32, first.Length);
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(dir, "native-details-artwork.key")));
            }

            // Without a folder: a fresh key in memory each time.
            Assert.NotEqual(NativeDetailsArtwork.LoadKey(null), NativeDetailsArtwork.LoadKey(null));
            using var images = new IntegrationTransport((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)));
            var tag = new NativeDetailsArtwork(images, dir).Mint(Guid.NewGuid(), ImageType.Primary, 0, "/a.jpg", Guid.NewGuid(), "r1");
            Assert.True(new NativeDetailsArtwork(images, dir).TryRead(tag, out _));
            Assert.False(new NativeDetailsArtwork(images).TryRead(tag, out _));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task HiddenContentSavesNamingASyntheticIdAreRefused()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var body = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent();
        body.Items[Guid.NewGuid().ToString("N")] = new();
        var ok = await Call(rig, "JellyfinEnhanced", "SaveUserHiddenContent", Me(viewer), new() { ["userId"] = viewer.Id.ToString("N"), ["userConfiguration"] = body }, "POST");
        Assert.Equal(1, ok.NextCalls);
        body.Items[SyntheticId.Movie(693134).Format(Server)] = new();
        var refused = await Call(rig, "JellyfinEnhanced", "SaveUserHiddenContent", Me(viewer), new() { ["userId"] = viewer.Id.ToString("N"), ["userConfiguration"] = body }, "POST");
        Assert.Equal(0, refused.NextCalls);
        Assert.Equal(403, Status(refused.Result));
    }

    // ---- Phase 3e2: where the names on a synthetic page lead -------------------------------------------

    /// <summary>A library person (with a primary image) under a TMDB id, opened for the given viewers unless hidden.</summary>
    private static MediaBrowser.Controller.Entities.Person LibraryPerson(Rig rig, string name, string? tmdb, HashSet<Guid> hidden, params User[] viewers)
    {
        var person = new MediaBrowser.Controller.Entities.Person { Id = Guid.NewGuid(), Name = name };
        if (tmdb != null) person.SetProviderId(MetadataProvider.Tmdb, tmdb);
        person.ImageInfos = new[] { new MediaBrowser.Controller.Entities.ItemImageInfo { Type = ImageType.Primary, Path = "/people/" + name + ".jpg" } };
        rig.Library.Setup(l => l.GetPerson(name)).Returns(person);
        foreach (var viewer in viewers)
        {
            rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(person.Id, viewer)).Returns(() => hidden.Contains(person.Id) ? null : person);
        }

        return person;
    }

    /// <summary>A library genre/studio/tag the viewer finds titles behind (or not), by name.</summary>
    private static void LibraryName(Rig rig, User viewer, string kind, string name, bool exists, Func<bool> finds)
    {
        var id = Rig.NameId(kind, name);
        if (exists)
        {
            MediaBrowser.Controller.Entities.BaseItem item = kind == "genre"
                ? new MediaBrowser.Controller.Entities.Genre { Id = id, Name = name }
                : new MediaBrowser.Controller.Entities.Studio { Id = id, Name = name };
            rig.Library.Setup(l => l.GetItemById(id)).Returns(item);
        }

        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Some title" };
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == viewer
                && (kind == "genre" ? q.GenreIds.Contains(id) : kind == "studio" ? q.StudioIds.Contains(id) : q.Tags.Contains(name)))))
            .Returns(() => finds() ? new List<MediaBrowser.Controller.Entities.BaseItem> { movie } : new List<MediaBrowser.Controller.Entities.BaseItem>());
    }

    [Fact]
    public async Task CastAndCrewLeadToTheLibrarysPersonPageOrTheirOwn()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var other = rig.Person();
        var hidden = new HashSet<Guid>();
        var chalamet = LibraryPerson(rig, "Timothée Chalamet", "1190668", hidden, viewer, other);
        // A namesake: Jellyfin has someone of that name, but not this TMDB person.
        LibraryPerson(rig, "Javier Bardem", "999", hidden, viewer);
        var movie = Id(SyntheticId.Movie(693134));
        async Task<BaseItemDto> Page(User who) => Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(who), new() { ["itemId"] = movie })).Result);

        var dto = await Page(viewer);
        var paul = dto.People.Single(p => p.Name == "Timothée Chalamet");
        // The library's own person page (native), with the library's own photo.
        Assert.Equal(chalamet.Id, paul.Id);
        Assert.Equal("lib-tag-" + chalamet.Id.ToString("N"), paul.PrimaryImageTag);
        Assert.Equal(PersonKind.Actor, paul.Type);
        Assert.Equal("Paul", paul.Role);
        // Someone the library doesn't have (or only a namesake of): their own page, their photo by grant.
        foreach (var name in new[] { "Javier Bardem", "Denis Villeneuve" })
        {
            var entry = dto.People.First(p => p.Name == name);
            Assert.True(SyntheticId.TryParse(entry.Id, Server, out var person));
            Assert.Equal(SyntheticKind.Person, person.Kind);
            if (entry.PrimaryImageTag != null)
            {
                Assert.True(rig.Artwork.TryRead(entry.PrimaryImageTag, out var grant));
                Assert.Equal(entry.Id, grant!.Owner);
                Assert.Equal(viewer.Id, grant.Viewer);
            }
        }

        Assert.Equal(PersonKind.Director, dto.People.Single(p => p.Name == "Denis Villeneuve").Type);
        // A library person Jellyfin doesn't let this viewer open: their own page instead, never the library's.
        hidden.Add(chalamet.Id);
        var paulHidden = (await Page(viewer)).People.Single(p => p.Name == "Timothée Chalamet");
        Assert.True(SyntheticId.TryParse(paulHidden.Id, Server, out var own) && own == SyntheticId.Person(1190668));
        Assert.NotEqual("lib-tag-" + chalamet.Id.ToString("N"), paulHidden.PrimaryImageTag);
        // The library lookup fails: their own page (no error).
        rig.Library.Setup(l => l.GetPerson("Timothée Chalamet")).Throws(new InvalidOperationException("db"));
        hidden.Clear();
        Assert.True(SyntheticId.TryParse((await Page(other)).People.Single(p => p.Name == "Timothée Chalamet").Id, Server, out _));
    }

    [Fact]
    public async Task WhereNamesLeadIsReadAgainWhenTheLibraryOrTheViewersPolicyChanges()
    {
        using var rig = new Rig();
        long revision = 1;
        rig.LibraryRevision = () => revision;
        rig.Restart();
        var viewer = rig.Person();
        var hidden = new HashSet<Guid>();
        var chalamet = LibraryPerson(rig, "Timothée Chalamet", "1190668", hidden, viewer);
        var sciFiShown = true;
        LibraryName(rig, viewer, "genre", "Science Fiction", true, () => sciFiShown);
        rig.Plugin.Plugin.Configuration.JellyseerrShowGenreDiscovery = false;
        async Task<BaseItemDto> Page() => Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result);
        Assert.Equal(chalamet.Id, (await Page()).People.Single(p => p.Name == "Timothée Chalamet").Id);
        Assert.Equal(new[] { "Science Fiction" }, (await Page()).GenreItems.Select(g => g.Name));
        // Within one library revision the answers are reused (an absent page reads up to ~50 names).
        hidden.Add(chalamet.Id);
        sciFiShown = false;
        rig.Library.Invocations.Clear();
        var cached = await Page();
        Assert.Equal(chalamet.Id, cached.People.Single(p => p.Name == "Timothée Chalamet").Id);
        Assert.DoesNotContain(rig.Library.Invocations, i => i.Method.Name is "GetPerson" or "GetGenreId");
        // The library changed (any add, update or remove): read again.
        revision++;
        var fresh = await Page();
        Assert.True(SyntheticId.TryParse(fresh.People.Single(p => p.Name == "Timothée Chalamet").Id, Server, out _));
        Assert.Empty(fresh.GenreItems);
        // The viewer's policy revision is part of the key too (here moved by a sign-out).
        hidden.Clear();
        sciFiShown = true;
        revision++;
        Assert.Equal(chalamet.Id, (await Page()).People.Single(p => p.Name == "Timothée Chalamet").Id);
        hidden.Add(chalamet.Id);
        Assert.Equal(chalamet.Id, (await Page()).People.Single(p => p.Name == "Timothée Chalamet").Id);
        rig.Policy.Revoke(viewer.Id);
        Assert.True(SyntheticId.TryParse((await Page()).People.Single(p => p.Name == "Timothée Chalamet").Id, Server, out _));
    }

    [Fact]
    public async Task APersonsOwnPageHoldsTheirPublicDetailsUnderTheViewerRule()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var me = Me(viewer);
        var bardem = Id(SyntheticId.Person(3810));
        var run = await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = bardem });
        Assert.Equal(0, run.NextCalls);
        var dto = Value<BaseItemDto>(run.Result);
        Assert.Equal(bardem, dto.Id);
        Assert.Equal(BaseItemKind.Person, dto.Type);
        Assert.Equal("Javier Bardem", dto.Name);
        Assert.Equal("Spanish actor.", dto.Overview);
        Assert.Equal(new DateTime(1969, 3, 1, 0, 0, 0, DateTimeKind.Utc), dto.PremiereDate);
        Assert.Null(dto.EndDate);
        Assert.Equal(new[] { "Las Palmas, Spain" }, dto.ProductionLocations);
        Assert.Equal(new[] { "Acting" }, dto.Taglines);
        Assert.Equal("3810", dto.ProviderIds["Tmdb"]);
        Assert.Equal("nm0000849", dto.ProviderIds["Imdb"]);
        Assert.Equal(new[] { "https://www.imdb.com/name/nm0000849", "https://www.themoviedb.org/person/3810" }, dto.ExternalUrls.Select(u => u.Url));
        Assert.Equal(MediaType.Unknown, dto.MediaType);
        Assert.Equal(LocationType.Virtual, dto.LocationType);
        Assert.Empty(dto.MediaSources);
        Assert.False(dto.UserData.IsFavorite);
        Assert.True(rig.Artwork.TryRead(dto.ImageTags[ImageType.Primary], out var photo));
        Assert.Equal((bardem, viewer.Id), (photo!.Owner, photo.Viewer));
        // The photo is served by its grant.
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new() { ["itemId"] = bardem, ["imageType"] = ImageType.Primary, ["tag"] = dto.ImageTags[ImageType.Primary], ["maxWidth"] = 300 })).Result));
        // The page's other native reads: no ancestors, no collections, and no library filmography (the
        // titles come from JE's person discovery row, filtered for the viewer).
        Assert.Empty(Value<BaseItemDto[]>((await Call(rig, "Library", "GetAncestors", me, new() { ["itemId"] = bardem })).Result));
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetItemCollections", me, new() { ["itemId"] = bardem })).Result).Items);
        var films = await Call(rig, "Items", "GetItemsByUserIdLegacy", me, new() { ["personIds"] = new[] { bardem }, ["includeItemTypes"] = new[] { BaseItemKind.Movie } });
        Assert.Equal(0, films.NextCalls);
        Assert.Empty(Value<QueryResult<BaseItemDto>>(films.Result).Items);
        // Still nothing a title has: no similar rail, seasons, playback or user data for a person id.
        Assert.Equal(404, Status((await Call(rig, "Library", "GetSimilarItems", me, new() { ["itemId"] = bardem })).Result));
        Assert.Equal(403, Status((await Call(rig, "UserLibrary", "MarkFavoriteItem", me, new() { ["itemId"] = bardem }, "POST")).Result));
        Assert.Equal(404, Status((await Call(rig, "ArrStatus", "GetItemStatus", me, new() { ["itemId"] = bardem.ToString("N") })).Result));
        // Unknown to TMDB: 404; Seerr down: retryable.
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(SyntheticId.Person(77)) })).Result));
        rig.Source.Down = true;
        Assert.Equal(503, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = bardem })).Result));
        rig.Source.Down = false;
        // The viewer rule: unlinked (Seerr mode) or the feature off is a refusal like a hidden item.
        var unlinked = rig.Person(linked: false);
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", Me(unlinked), new() { ["itemId"] = bardem })).Result));
        // An adult performer: refused to a viewer with any parental limit, shown to one without.
        rig.Source.AdultPerson = 4242;
        var adult = Id(SyntheticId.Person(4242));
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = adult })).Result));
        var kid = rig.Person();
        kid.MaxParentalRatingScore = 10;
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", Me(kid), new() { ["itemId"] = adult })).Result));
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", Me(kid), new() { ["itemId"] = bardem })).Result));
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        var off = await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = bardem });
        Assert.Equal((404, 0), (Status(off.Result), off.NextCalls));
    }

    [Fact]
    public async Task GenresStudiosAndTagsLeadToTheLibraryOrADiscoveryPageNeverToNothing()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var me = Me(viewer);
        var config = rig.Plugin.Plugin.Configuration;
        var sciFiShown = true;
        // "Science Fiction" and "Legendary Pictures" are in the library with titles this viewer finds;
        // "Adventure" is in the library but nothing behind it is the viewer's; "Tiny Co" and "Disney+" aren't there.
        LibraryName(rig, viewer, "genre", "Science Fiction", true, () => sciFiShown);
        LibraryName(rig, viewer, "genre", "Adventure", true, () => false);
        LibraryName(rig, viewer, "studio", "Legendary Pictures", true, () => true);
        LibraryName(rig, viewer, "tag", "desert", false, () => true);
        LibraryName(rig, viewer, "tag", "sandworm", false, () => false);
        async Task<BaseItemDto> Page(SyntheticId id) => Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(id) })).Result);
        string Where(Guid id) => SyntheticId.TryParse(id, Server, out var s) ? s.Kind + ":" + s.TmdbId : id == Rig.NameId("genre", "Science Fiction") || id == Rig.NameId("studio", "Legendary Pictures") ? "library" : "?";

        // Every discovery row on (the defaults) and the viewer linked to Seerr.
        var movie = await Page(SyntheticId.Movie(693134));
        Assert.Equal(new[] { "Science Fiction", "Adventure" }, movie.Genres);
        Assert.Equal(new[] { "Science Fiction=library", "Adventure=Genre:12" }, movie.GenreItems.Select(g => g.Name + "=" + Where(g.Id)));
        Assert.Equal(new[] { "Legendary Pictures=library", "Tiny Co=Studio:99" }, movie.Studios.Select(g => g.Name + "=" + Where(g.Id)));
        Assert.Equal(new[] { "desert", "sandworm" }, movie.Tags);
        var series = await Page(SyntheticId.Series(83867));
        Assert.Equal(new[] { "Disney+=Network:2739" }, series.Studios.Select(g => g.Name + "=" + Where(g.Id)));
        Assert.Equal(new[] { "Drama=Genre:1" }, series.GenreItems.Select(g => g.Name + "=" + Where(g.Id)));

        // The rows switched off: a name leads to the library only when the viewer finds titles there.
        config.JellyseerrShowGenreDiscovery = false;
        config.JellyseerrShowNetworkDiscovery = false;
        config.JellyseerrShowTagDiscovery = false;
        movie = await Page(SyntheticId.Movie(693134));
        Assert.Equal(new[] { "Science Fiction" }, movie.GenreItems.Select(g => g.Name));
        Assert.Equal(new[] { "Science Fiction", "Adventure" }, movie.Genres);
        Assert.Equal(new[] { "Legendary Pictures" }, movie.Studios.Select(g => g.Name));
        Assert.Equal(new[] { "desert" }, movie.Tags);
        Assert.Empty((await Page(SyntheticId.Series(83867))).Studios);
        // What the viewer finds is read again (cached per library revision only when there is one).
        sciFiShown = false;
        Assert.Empty((await Page(SyntheticId.Movie(693134))).GenreItems);

        // Jellyfin Enhanced mode: the page needs no Seerr account, and neither do the genre, studio and
        // network discovery pages (their feeds are read with JE's own key, filtered for the viewer: see
        // NativeDetailsFeeds); a tag's row on the library's tag page reads Seerr as the viewer, so only
        // a linked viewer gets tags that lead to that row alone.
        config.JellyseerrShowGenreDiscovery = true;
        config.JellyseerrShowNetworkDiscovery = true;
        config.JellyseerrShowTagDiscovery = true;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je";
        var unlinked = rig.Person(linked: false);
        LibraryName(rig, unlinked, "genre", "Science Fiction", true, () => true);
        var forUnlinked = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(unlinked), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result);
        Assert.Equal(new[] { "Science Fiction=library", "Adventure=Genre:12" }, forUnlinked.GenreItems.Select(g => g.Name + "=" + Where(g.Id)));
        Assert.Equal(new[] { "Legendary Pictures=Studio:923", "Tiny Co=Studio:99" }, forUnlinked.Studios.Select(g => g.Name + "=" + Where(g.Id)));
        // Tags lead to the tag page, whose row reads the native keyword feeds without an account.
        Assert.Equal(new[] { "desert", "sandworm" }, forUnlinked.Tags);
        // The linked viewer in the same mode gets the discovery pages (Science Fiction shows them nothing in the library now).
        Assert.Equal(new[] { "Science Fiction=Genre:878", "Adventure=Genre:12" }, (await Page(SyntheticId.Movie(693134))).GenreItems.Select(g => g.Name + "=" + Where(g.Id)));
    }

    [Fact]
    public async Task GenreStudioAndNetworkDiscoveryPagesAnswerTheirName()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var me = Me(viewer);
        async Task<IActionResult?> Item(SyntheticId id) => (await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = Id(id) })).Result;
        var sciFi = Value<BaseItemDto>(await Item(SyntheticId.Genre(878)));
        Assert.Equal((BaseItemKind.Genre, "Science Fiction", Id(SyntheticId.Genre(878))), (sciFi.Type, sciFi.Name, sciFi.Id));
        Assert.Equal("Sci-Fi & Fantasy", Value<BaseItemDto>(await Item(SyntheticId.Genre(10765))).Name);
        var studio = Value<BaseItemDto>(await Item(SyntheticId.Studio(99)));
        Assert.Equal((BaseItemKind.Studio, "Tiny Co"), (studio.Type, studio.Name));
        var network = Value<BaseItemDto>(await Item(SyntheticId.Network(2739)));
        Assert.Equal((BaseItemKind.Studio, "Disney+"), (network.Type, network.Name));
        Assert.Empty(network.ImageTags);
        Assert.Equal(LocationType.Virtual, network.LocationType);
        // Unknown ids: 404; a genre list that can't be read: retryable.
        Assert.Equal(404, Status(await Item(SyntheticId.Genre(4))));
        Assert.Equal(404, Status(await Item(SyntheticId.Studio(5))));
        Assert.Equal(404, Status(await Item(SyntheticId.Network(6))));
        rig.Source.GenresDown = true;
        Assert.Equal(503, Status(await Item(SyntheticId.Genre(10765))));
        Assert.Equal(200, Status(await Item(SyntheticId.Genre(878))));
        // The list page's own query names the synthetic genre/studio: it matches nothing (never the whole library).
        var list = await Call(rig, "Items", "GetItems", me, new() { ["genreIds"] = new[] { Id(SyntheticId.Genre(878)) }, ["recursive"] = true });
        Assert.Equal(0, list.NextCalls);
        Assert.Empty(Value<QueryResult<BaseItemDto>>(list.Result).Items);
        var byStudio = await Call(rig, "Items", "GetItems", me, new() { ["studioIds"] = new[] { Id(SyntheticId.Studio(99)) } });
        Assert.Equal(0, byStudio.NextCalls);
        // Their pages have nothing else: no ancestors, similar items or artwork routes beyond the item.
        Assert.Equal(404, Status((await Call(rig, "Library", "GetAncestors", me, new() { ["itemId"] = Id(SyntheticId.Genre(878)) })).Result));
        Assert.Equal(404, Status((await Call(rig, "Library", "GetSimilarItems", me, new() { ["itemId"] = Id(SyntheticId.Studio(99)) })).Result));
        // Not linked to Seerr: refused like any page.
        Assert.Equal(404, Status((await Call(rig, "UserLibrary", "GetItem", Me(rig.Person(linked: false)), new() { ["itemId"] = Id(SyntheticId.Genre(878)) })).Result));
    }

    // ---- Review follow-ups: the lists on those pages are filtered for the viewer on the server --------

    /// <summary>
    /// A library copy of a title, found by its TMDB id with no user on the query (what the library holds),
    /// and opened by Jellyfin's own check for each viewer in <paramref name="openFor"/> only.
    /// </summary>
    private static MediaBrowser.Controller.Entities.BaseItem Copy(Rig rig, bool movie, int tmdb, string name, User[] openFor, params User[] closedFor)
    {
        MediaBrowser.Controller.Entities.BaseItem item = movie
            ? new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = name }
            : new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), Name = name };
        var kind = movie ? BaseItemKind.Movie : BaseItemKind.Series;
        var key = tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture);
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(kind) && q.HasAnyProviderId != null && q.HasAnyProviderId.ContainsKey("Tmdb") && q.HasAnyProviderId["Tmdb"] == key)))
            .Returns(new List<MediaBrowser.Controller.Entities.BaseItem> { item });
        rig.Library.Setup(l => l.GetItemById(item.Id)).Returns(item);
        foreach (var viewer in openFor) rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(item.Id, viewer)).Returns(item);
        foreach (var viewer in closedFor) rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(item.Id, viewer)).Returns((MediaBrowser.Controller.Entities.BaseItem?)null);
        return item;
    }

    private static JsonElement Body(FeedAnswer answer)
    {
        Assert.Equal(FeedOutcome.Ok, answer.Outcome);
        return JsonDocument.Parse(answer.Json!).RootElement.Clone();
    }

    private static string[] Titles(JsonElement body)
        => body.GetProperty("results").EnumerateArray().Select(r => r.GetProperty("id").GetInt32() + (r.TryGetProperty("mediaInfo", out var m) && m.TryGetProperty("jellyfinMediaId", out var jf) ? "=" + jf.GetString() : string.Empty)).ToArray();

    /// <summary>A viewer who can open the Movies library only (not Shows).</summary>
    private static User MoviesOnly(Rig rig, bool linked = true)
    {
        var viewer = rig.Person(linked: linked);
        viewer.SetPermission(PermissionKind.EnableAllFolders, false);
        viewer.SetPreference(PreferenceKind.EnabledFolders, [MoviesLib.ToString("N")]);
        return viewer;
    }

    [Fact]
    public async Task AFilmographyHoldsOnlyWhatTheViewerMayOpenBeforeItLeavesTheServer()
    {
        using var rig = new Rig();
        var viewer = MoviesOnly(rig);
        var admin = rig.Person(admin: true);
        // Seerr names a copy of 11 the viewer can open and one of 12 they can't; 13 is a copy only the
        // library knows (no Seerr id); 1400 is a series in the Shows library the viewer can't open;
        // 1399 and 438631 aren't in the library at all; 14 is an appearance (a talk show).
        var inside = Copy(rig, true, 11, "Kids copy", new[] { viewer, admin });
        var outside = Copy(rig, true, 12, "Adults copy", new[] { admin }, viewer);
        var found = Copy(rig, true, 13, "Found by TMDB", new[] { viewer, admin });
        var locked = Copy(rig, false, 1400, "Locked Show", new[] { admin }, viewer);
        // 15: a movie copy only the library knows, which Jellyfin hides from the viewer (a rating, a tag).
        var rated = Copy(rig, true, 15, "Hidden by rating", new[] { admin }, viewer);
        rig.Source.Credits = $$$"""
        {"cast":[
          {"id":11,"mediaType":"movie","title":"Kids copy","character":"Lead","voteCount":50,"posterPath":"/k.jpg","genreIds":[18],
           "mediaInfo":{"status":5,"jellyfinMediaId":"{{{inside.Id:N}}}","requests":[{"requestedBy":{"displayName":"someone else"}}],"downloadStatus":[{"title":"dl"}]}},
          {"id":12,"mediaType":"movie","title":"Adults copy","voteCount":900,"mediaInfo":{"status":5,"jellyfinMediaId":"{{{outside.Id:N}}}"}},
          {"id":1399,"mediaType":"tv","name":"Game of Thrones","voteCount":5000},
          {"id":1400,"mediaType":"tv","name":"Locked Show","voteCount":4000},
          {"id":438631,"mediaType":"movie","title":"Dune","voteCount":3000,"posterPath":"javascript:alert(1)","character":"Stilgar","mediaInfo":{"status":2}},
          {"id":13,"mediaType":"movie","title":"Found by TMDB","voteCount":10},
          {"id":15,"mediaType":"movie","title":"Hidden by rating","voteCount":20},
          {"id":5,"mediaType":"person","name":"Not a title"},
          {"id":438631,"mediaType":"movie","title":"Dune","character":"again"}],
         "crew":[{"id":14,"mediaType":"movie","title":"Talk","genreIds":[10767],"voteCount":99999,"job":"Producer"}]}
        """;

        var answer = await rig.Feeds.FilmographyAsync(viewer, 3810, CancellationToken.None);
        var body = Body(answer);
        // Best known first, the appearance last; library cards carry the copy this viewer can open.
        Assert.Equal(new[] { "438631", $"11={inside.Id:N}", $"13={found.Id:N}", "14" }, Titles(body));
        // What the viewer may not open is not in the answer at all (not just hidden by the browser):
        // no hidden copy, no series of a library they can't open, no title of a library they can't reach.
        foreach (var leak in new[] { "Adults copy", outside.Id.ToString("N"), outside.Id.ToString("D"), "Game of Thrones", "Locked Show", locked.Id.ToString("N"), "Hidden by rating", rated.Id.ToString("N"), "someone else", "requests", "downloadStatus", "javascript" })
        {
            Assert.DoesNotContain(leak, answer.Json!, StringComparison.OrdinalIgnoreCase);
        }

        var dune = body.GetProperty("results")[0];
        Assert.Equal(("Dune", "Stilgar", 2), (dune.GetProperty("title").GetString(), dune.GetProperty("character").GetString(), dune.GetProperty("mediaInfo").GetProperty("status").GetInt32()));
        Assert.False(dune.TryGetProperty("posterPath", out _));
        Assert.Equal(5, body.GetProperty("results")[1].GetProperty("mediaInfo").GetProperty("status").GetInt32());

        // The administrator, who can open every library and copy, gets them all.
        var all = Body(await rig.Feeds.FilmographyAsync(admin, 3810, CancellationToken.None));
        Assert.Equal(new[] { "1399", $"1400={locked.Id:N}", "438631", $"12={outside.Id:N}", $"11={inside.Id:N}", $"15={rated.Id:N}", $"13={found.Id:N}", "14" }, Titles(all));

        // The person page's own rule: unknown 404, outage retryable, an adult performer refused to a
        // viewer with a parental limit, unlinked (Seerr mode) refused.
        Assert.Equal(FeedOutcome.NotFound, (await rig.Feeds.FilmographyAsync(viewer, 77, CancellationToken.None)).Outcome);
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.FilmographyAsync(MoviesOnly(rig, linked: false), 3810, CancellationToken.None)).Outcome);
        rig.Source.AdultPerson = 4242;
        var kid = rig.Person();
        kid.MaxParentalRatingScore = 10;
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.FilmographyAsync(kid, 4242, CancellationToken.None)).Outcome);
        Assert.Equal(FeedOutcome.Ok, (await rig.Feeds.FilmographyAsync(viewer, 4242, CancellationToken.None)).Outcome);
        rig.Source.Down = true;
        Assert.Equal(FeedOutcome.Unavailable, (await rig.Feeds.FilmographyAsync(viewer, 3810, CancellationToken.None)).Outcome);
    }

    [Fact]
    public async Task AFilmographyAppliesTheViewersParentalLimitBeforeTheLibraryCheck()
    {
        using var rig = new Rig();
        rig.Source.Credits = """{"cast":[{"id":438631,"mediaType":"movie","title":"Dune","voteCount":3000},{"id":1399,"mediaType":"tv","name":"Game of Thrones","voteCount":5000}],"crew":[]}""";
        // Every title here is rated PG-13 by the rig's rating source.
        var kid = rig.Person();
        kid.MaxParentalRatingScore = 10;
        Assert.Empty(Titles(Body(await rig.Feeds.FilmographyAsync(kid, 3810, CancellationToken.None))));
        var teen = rig.Person();
        teen.MaxParentalRatingScore = 13;
        Assert.Equal(new[] { "1399", "438631" }, Titles(Body(await rig.Feeds.FilmographyAsync(teen, 3810, CancellationToken.None))));
    }

    [Fact]
    public async Task InJellyfinEnhancedModeAFilmographyNeedsNoSeerrAccount()
    {
        using var rig = new Rig();
        rig.Source.Credits = """{"cast":[{"id":438631,"mediaType":"movie","title":"Dune","voteCount":3000}],"crew":[]}""";
        var unlinked = rig.Person(linked: false);
        // Seerr mode: the person page (and its list) needs the viewer's Seerr account.
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.FilmographyAsync(unlinked, 3810, CancellationToken.None)).Outcome);
        var config = rig.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je";
        // Jellyfin Enhanced mode: the page opens without one, and so does its filmography.
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", Me(unlinked), new() { ["itemId"] = Id(SyntheticId.Person(3810)) })).Result));
        Assert.Equal(new[] { "438631" }, Titles(Body(await rig.Feeds.FilmographyAsync(unlinked, 3810, CancellationToken.None))));
        // And the genre, studio and network discovery pages' feeds.
        rig.Source.Feeds["movie:genre:878:1"] = """{"page":1,"totalPages":1,"results":[{"id":438631,"mediaType":"movie","title":"Dune"}]}""";
        Assert.Equal(new[] { "438631" }, Titles(Body(await rig.Feeds.DiscoverAsync(unlinked, true, "genre", 878, 1, null, CancellationToken.None))));
    }

    [Fact]
    public async Task TheFeedRoutesAnswerTheCallerOnlyAndNeverToAnApiKey()
    {
        using var rig = new Rig();
        rig.Source.Credits = """{"cast":[{"id":438631,"mediaType":"movie","title":"Dune","voteCount":3000}],"crew":[]}""";
        var viewer = rig.Person();
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController For(System.Security.Claims.ClaimsPrincipal user) => new(rig.Feeds, rig.Callers.Users.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = user } },
        };

        var controller = For(Me(viewer));
        var ok = Assert.IsType<ContentResult>(await controller.Filmography(3810, CancellationToken.None));
        Assert.Equal("application/json", ok.ContentType);
        Assert.Contains("\"id\":438631", ok.Content, StringComparison.Ordinal);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl.ToString());
        Assert.Equal(404, Status(await For(Me(viewer)).Filmography(77, CancellationToken.None)));
        Assert.Equal(400, Status(await For(Me(viewer)).Discover("person", "genre", 878)));
        Assert.Equal(400, Status(await For(Me(viewer)).Discover("movie", "person", 878)));
        // An API key (no user) or the feature off: refused before anything is read.
        var calls = rig.Source.Calls;
        Assert.Equal(403, Status(await For(new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity("Custom"))).Filmography(3810, CancellationToken.None)));
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        Assert.Equal(403, Status(await For(Me(viewer)).Filmography(3810, CancellationToken.None)));
        Assert.Equal(403, Status(await For(Me(viewer)).Discover("movie", "genre", 878)));
        Assert.Equal(calls, rig.Source.Calls);
    }

    [Fact]
    public async Task GenreStudioAndNetworkFeedsAreFilteredForTheViewerBeforeTheyLeaveTheServer()
    {
        using var rig = new Rig();
        var viewer = MoviesOnly(rig);
        var admin = rig.Person(admin: true);
        var both = rig.Person();
        var inside = Copy(rig, true, 11, "Kids copy", new[] { viewer, admin });
        var outside = Copy(rig, true, 12, "Adults copy", new[] { admin }, viewer);
        var locked = Copy(rig, false, 1400, "Locked Show", new[] { admin }, viewer, both);
        var rated = Copy(rig, true, 15, "Hidden by rating", new[] { admin }, viewer);
        rig.Source.Feeds["tv:network:49:1"] = """{"page":1,"totalPages":3,"results":[{"id":1400,"mediaType":"tv","name":"Locked Show"}]}""";
        rig.Source.Feeds["movie:studio:99:1"] = $$$"""
        {"page":1,"totalPages":7,"totalResults":140,"results":[
          {"id":12,"mediaType":"movie","title":"Adults copy","mediaInfo":{"status":5,"jellyfinMediaId":"{{{outside.Id:N}}}"}},
          {"id":11,"mediaType":"movie","title":"Kids copy","mediaInfo":{"status":5,"jellyfinMediaId":"{{{inside.Id:N}}}"}},
          {"id":438631,"mediaType":"movie","title":"Dune"},{"id":15,"mediaType":"movie","title":"Hidden by rating"},{"id":1399,"mediaType":"tv","name":"Wrong kind"}]}
        """;
        rig.Source.Feeds["tv:network:2739:1"] = """{"page":1,"totalPages":3,"results":[{"id":1399,"mediaType":"tv","name":"Game of Thrones"},{"id":1400,"mediaType":"tv","name":"Locked Show"}]}""";
        rig.Source.Feeds["tv:company:99:2"] = """{"page":2,"totalPages":2,"results":[{"id":1399,"mediaType":"tv","name":"Game of Thrones"}]}""";

        var studio = await rig.Feeds.DiscoverAsync(viewer, true, "studio", 99, 1, "popularity.desc", CancellationToken.None);
        Assert.Equal(new[] { $"11={inside.Id:N}", "438631" }, Titles(Body(studio)));
        Assert.Equal(7, Body(studio).GetProperty("totalPages").GetInt32());
        Assert.False(Body(studio).TryGetProperty("totalResults", out _), "no upstream count of what was left out");
        Assert.DoesNotContain("Adults copy", studio.Json!, StringComparison.Ordinal);
        Assert.DoesNotContain("Hidden by rating", studio.Json!, StringComparison.Ordinal);
        Assert.DoesNotContain(outside.Id.ToString("N"), studio.Json!, StringComparison.Ordinal);
        Assert.Contains("movie:studio:99:1?popularity.desc", rig.Source.FeedCalls);
        // A page whose every title is left out is an empty page, not the end of the feed (more pages may hold titles).
        var hiddenPage = Body(await rig.Feeds.DiscoverAsync(both, false, "network", 49, 1, null, CancellationToken.None));
        Assert.Empty(Titles(hiddenPage));
        Assert.Equal(3, hiddenPage.GetProperty("totalPages").GetInt32());
        // No series library for this viewer at all: nothing of a series feed could be theirs, so it ends at
        // once (never paged through empty) and the source isn't asked.
        var asked = rig.Source.FeedCalls.Count;
        var network = Body(await rig.Feeds.DiscoverAsync(viewer, false, "network", 2739, 1, null, CancellationToken.None));
        Assert.Empty(Titles(network));
        Assert.Equal(1, network.GetProperty("totalPages").GetInt32());
        Assert.Empty(Titles(Body(await rig.Feeds.DiscoverAsync(viewer, false, "company", 99, 2, null, CancellationToken.None))));
        Assert.Equal(asked, rig.Source.FeedCalls.Count);
        // The administrator gets them.
        Assert.Equal(new[] { "1399", $"1400={locked.Id:N}" }, Titles(Body(await rig.Feeds.DiscoverAsync(admin, false, "network", 2739, 1, null, CancellationToken.None))));
        Assert.Equal(new[] { $"12={outside.Id:N}", $"11={inside.Id:N}", "438631", $"15={rated.Id:N}" }, Titles(Body(await rig.Feeds.DiscoverAsync(admin, true, "studio", 99, 1, null, CancellationToken.None))));
        Assert.Equal(new[] { "1399" }, Titles(Body(await rig.Feeds.DiscoverAsync(admin, false, "company", 99, 2, null, CancellationToken.None))));

        // Only the feeds these pages have, with a sane page and sort.
        foreach (var (movie, source, id, page, sort) in new (bool, string, int, int, string?)[]
        {
            (true, "network", 2739, 1, null), (false, "studio", 99, 1, null), (true, "company", 1, 1, null), (true, "genre", 0, 1, null),
            (true, "genre", 878, 0, null), (true, "genre", 878, 501, null), (true, "genre", 878, 1, "popularity.desc&x=1"),
        })
        {
            Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.DiscoverAsync(viewer, movie, source, id, page, sort, CancellationToken.None)).Outcome);
        }

        Assert.Equal(FeedOutcome.NotFound, (await rig.Feeds.DiscoverAsync(viewer, true, "genre", 878, 1, null, CancellationToken.None)).Outcome);
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.DiscoverAsync(MoviesOnly(rig, linked: false), true, "studio", 99, 1, null, CancellationToken.None)).Outcome);
        rig.Source.Down = true;
        Assert.Equal(FeedOutcome.Unavailable, (await rig.Feeds.DiscoverAsync(viewer, true, "studio", 99, 1, null, CancellationToken.None)).Outcome);
    }

    [Fact]
    public async Task AListedTitleShowsAnyCopyTheViewerCanOpenBeforeItIsLeftOut()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        // 21: Seerr names a standard copy the viewer can't open and a 4K copy they can (the library's
        // own lookup finds only the standard one). 22: Seerr names a standard copy they can't open; the
        // library also has another copy, unnamed, that they can. 23: the only copy is hidden from them.
        var fourK = Copy(rig, true, 21, "4K copy", new[] { viewer });
        var standard = Copy(rig, true, 21, "Standard copy", Array.Empty<User>(), viewer);
        var named = Copy(rig, true, 22, "Named copy", Array.Empty<User>(), viewer);
        var alternate = Copy(rig, true, 22, "Alternate copy", new[] { viewer });
        var only = Copy(rig, true, 23, "Only copy", Array.Empty<User>(), viewer);
        var rows = $$$"""
          {"id":21,"mediaType":"movie","title":"Twenty-one","voteCount":30,"mediaInfo":{"status":5,"jellyfinMediaId":"{{{standard.Id:N}}}","jellyfinMediaId4k":"{{{fourK.Id:N}}}"}},
          {"id":22,"mediaType":"movie","title":"Twenty-two","voteCount":20,"mediaInfo":{"status":5,"jellyfinMediaId":"{{{named.Id:N}}}"}},
          {"id":23,"mediaType":"movie","title":"Twenty-three","voteCount":10,"mediaInfo":{"status":5,"jellyfinMediaId":"{{{only.Id:N}}}"}}
        """;
        rig.Source.Credits = "{\"cast\":[" + rows + "],\"crew\":[]}";
        rig.Source.Feeds["movie:studio:99:1"] = "{\"page\":1,\"totalPages\":1,\"results\":[" + rows + "]}";
        var expected = new[] { $"21={fourK.Id:N}", $"22={alternate.Id:N}" };
        foreach (var answer in new[]
        {
            await rig.Feeds.FilmographyAsync(viewer, 3810, CancellationToken.None),
            await rig.Feeds.DiscoverAsync(viewer, true, "studio", 99, 1, null, CancellationToken.None),
        })
        {
            Assert.Equal(expected, Titles(Body(answer)));
            foreach (var hidden in new[] { standard.Id, named.Id, only.Id })
            {
                Assert.DoesNotContain(hidden.ToString("N"), answer.Json!, StringComparison.OrdinalIgnoreCase);
            }
        }
    }

    [Fact]
    public async Task FeedReadsTheServerWontStartNowAnswer429AndRetryAfter()
    {
        using var rig = new Rig();
        rig.Source.Credits = """{"cast":[{"id":438631,"mediaType":"movie","title":"Dune","voteCount":3000}],"crew":[]}""";
        rig.Source.Feeds["movie:genre:878:1"] = """{"page":1,"totalPages":1,"results":[{"id":438631,"mediaType":"movie","title":"Dune"}]}""";
        var viewer = rig.Person();
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController For() => new(rig.Feeds, rig.Callers.Users.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(viewer) } },
        };

        rig.Source.Busy = true;
        var calls = rig.Source.Calls;
        Assert.Equal(FeedOutcome.Busy, (await rig.Feeds.FilmographyAsync(viewer, 3810, CancellationToken.None)).Outcome);
        // Only the admitted read was asked for: no person read goes upstream behind a refused one.
        Assert.Equal(calls + 1, rig.Source.Calls);
        foreach (var call in new Func<Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController, Task<IActionResult>>[]
        {
            c => c.Filmography(3810, CancellationToken.None),
            c => c.Discover("movie", "genre", 878),
            c => c.Discover("tv", "company", 99),
        })
        {
            var controller = For();
            var result = Assert.IsType<ObjectResult>(await call(controller));
            Assert.Equal(429, result.StatusCode);
            Assert.Contains("busy", JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
            Assert.Equal("2", controller.Response.Headers.RetryAfter.ToString());
            Assert.Equal("private, no-store", controller.Response.Headers.CacheControl.ToString());
        }

        rig.Source.Busy = false;
        Assert.Equal(new[] { "438631" }, Titles(Body(await rig.Feeds.FilmographyAsync(viewer, 3810, CancellationToken.None))));
        Assert.Equal(new[] { "438631" }, Titles(Body(await rig.Feeds.DiscoverAsync(viewer, true, "genre", 878, 1, null, CancellationToken.None))));
    }

    [Fact]
    public async Task AListWhoseParentalChecksAreStillRunningAnswers504UntilTheyLand()
    {
        using var rig = new Rig(parentalBudget: TimeSpan.FromMilliseconds(150));
        rig.Source.Credits = """{"cast":[{"id":438631,"mediaType":"movie","title":"Dune","voteCount":3000}],"crew":[]}""";
        rig.Source.Feeds["movie:genre:878:1"] = """{"page":1,"totalPages":3,"results":[{"id":603,"mediaType":"movie","title":"The Matrix"}]}""";
        var teen = rig.Person();
        teen.MaxParentalRatingScore = 13;
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController For() => new(rig.Feeds, rig.Callers.Users.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(teen) } },
        };

        rig.RatingGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        foreach (var call in new Func<Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController, Task<IActionResult>>[]
        {
            c => c.Filmography(3810, CancellationToken.None),
            c => c.Discover("movie", "genre", 878),
        })
        {
            // Unverified titles are not missing titles: not an empty list, a "come back shortly".
            var controller = For();
            var result = Assert.IsType<ObjectResult>(await call(controller));
            Assert.Equal(504, result.StatusCode);
            Assert.Contains("parental_pending", JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
            Assert.Equal("2", controller.Response.Headers.RetryAfter.ToString());
        }

        // The lookups kept running; once they land the same requests answer the list.
        rig.RatingGate.SetResult();
        FeedAnswer film = default, genre = default;
        for (var i = 0; i < 100; i++)
        {
            film = await rig.Feeds.FilmographyAsync(teen, 3810, CancellationToken.None);
            genre = await rig.Feeds.DiscoverAsync(teen, true, "genre", 878, 1, null, CancellationToken.None);
            if (film.Outcome == FeedOutcome.Ok && genre.Outcome == FeedOutcome.Ok) break;
            await Task.Delay(20);
        }

        Assert.Equal(new[] { "438631" }, Titles(Body(film)));
        Assert.Equal(new[] { "603" }, Titles(Body(genre)));
    }
    [Fact]
    public async Task AnAbsentTitlesExtrasAndRatingsComeFromTheServerForEveryViewerItsPageOpensFor()
    {
        using var rig = new Rig();
        var unlinked = rig.Person(linked: false);
        // Seerr mode: the page (and so its extras) needs the viewer's Seerr account.
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.TitleAsync(unlinked, true, 693134, CancellationToken.None)).Outcome);
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.RatingsAsync(unlinked, true, 693134, CancellationToken.None)).Outcome);
        Assert.Empty(rig.Source.RatingCalls);
        var config = rig.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je";
        // Jellyfin Enhanced mode: the page opens without an account, and so do its extras, read with JE's key.
        var movie = Body(await rig.Feeds.TitleAsync(unlinked, true, 693134, CancellationToken.None));
        Assert.Equal("Dune: Part Two", movie.GetProperty("title").GetString());
        Assert.True(movie.TryGetProperty("relatedVideos", out _));
        Assert.False(movie.TryGetProperty("mediaInfo", out _));                   // Seerr's per-account part stays behind
        Assert.DoesNotContain("someone else", movie.GetRawText(), StringComparison.Ordinal);
        Assert.Equal("Andor", Body(await rig.Feeds.TitleAsync(unlinked, false, 83867, CancellationToken.None)).GetProperty("name").GetString());
        Assert.Equal(92, Body(await rig.Feeds.RatingsAsync(unlinked, true, 693134, CancellationToken.None)).GetProperty("rt").GetProperty("criticsScore").GetInt32());
        Assert.Equal(96, Body(await rig.Feeds.RatingsAsync(unlinked, false, 83867, CancellationToken.None)).GetProperty("criticsScore").GetInt32());
        // Unknown, invalid, busy and down answer like the other feeds.
        Assert.Equal(FeedOutcome.NotFound, (await rig.Feeds.TitleAsync(unlinked, true, 77, CancellationToken.None)).Outcome);
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.TitleAsync(unlinked, true, 0, CancellationToken.None)).Outcome);
        // A known title without ratings is an empty answer (no 404 for the page to log), not "no such title".
        rig.Source.NoRatings = true;
        var none = await rig.Feeds.RatingsAsync(unlinked, false, 83867, CancellationToken.None);
        Assert.Equal(FeedOutcome.Ok, none.Outcome);
        Assert.Equal("null", none.Json);
        // Only Seerr's own answer means that: the feed's own refusals keep their error.
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.RatingsAsync(unlinked, false, 0, CancellationToken.None)).Outcome);
        rig.Source.NoRatings = false;
        rig.Source.Busy = true;
        Assert.Equal(FeedOutcome.Busy, (await rig.Feeds.RatingsAsync(unlinked, true, 693134, CancellationToken.None)).Outcome);
        rig.Source.Busy = false;
        rig.Source.Down = true;
        Assert.Equal(FeedOutcome.Unavailable, (await rig.Feeds.TitleAsync(unlinked, true, 693134, CancellationToken.None)).Outcome);
        rig.Source.Down = false;

        // Routes: the caller only, JSON, never kept; a bad type is 400.
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController For(System.Security.Claims.ClaimsPrincipal user) => new(rig.Feeds, rig.Callers.Users.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = user } },
        };
        var controller = For(Me(unlinked));
        var ok = Assert.IsType<ContentResult>(await controller.Title("movie", 693134, CancellationToken.None));
        Assert.DoesNotContain("mediaInfo", ok.Content, StringComparison.Ordinal);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl.ToString());
        Assert.Equal(200, Status(await For(Me(unlinked)).Ratings("tv", 83867, CancellationToken.None)));
        Assert.Equal(400, Status(await For(Me(unlinked)).Title("person", 693134, CancellationToken.None)));
        Assert.Equal(404, Status(await For(Me(unlinked)).Title("movie", 77, CancellationToken.None)));
        Assert.Equal(403, Status(await For(new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity("Custom"))).Title("movie", 693134, CancellationToken.None)));
    }

    /// <summary>Turns the request feature on in Jellyfin Enhanced mode (no Seerr account needed).</summary>
    private static void JellyfinEnhancedMode(Rig rig)
    {
        var config = rig.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je";
    }

    private static Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController FeedsFor(Rig rig, System.Security.Claims.ClaimsPrincipal user) => new(rig.Feeds, rig.Callers.Users.Object)
    {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = user } },
    };

    private const string CollectionJson = """
    {"id":726871,"name":"Dune Collection","overview":"The saga.","posterPath":"/dc.jpg","backdropPath":"javascript:x","parts":[
     {"id":438631,"mediaType":"movie","title":"Dune","releaseDate":"2021-09-15","posterPath":"/d1.jpg","mediaInfo":{"status":2,"requests":[{"requestedBy":{"displayName":"someone else"}}],"externalServiceId":77}},
     {"id":693134,"title":"Dune: Part Two","releaseDate":"2024-02-27","posterPath":"/d2.jpg"},
     {"id":1170608,"mediaType":"movie","title":"Dune: Part Three","releaseDate":"2026-12-16"},
     {"id":12,"mediaType":"movie","title":"Adults copy","releaseDate":"2020-01-01"},
     {"id":5,"mediaType":"person","name":"Not a movie"}]}
    """;

    [Fact]
    public async Task WithNativePagesOffATitlesPublicDetailsStillAnswerInJellyfinEnhancedModeForTheMoreInfoWindow()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        rig.Source.Collections[726871] = CollectionJson;
        var unlinked = rig.Person(linked: false);
        var linked = rig.Person();
        var ct = CancellationToken.None;

        // Seerr mode with native pages off: nothing here answers (the window reads Seerr with the viewer's own account).
        var calls = rig.Source.Calls;
        Assert.Equal(403, Status(await FeedsFor(rig, Me(linked)).Title("movie", 693134, ct)));
        Assert.Equal(403, Status(await FeedsFor(rig, Me(unlinked)).Ratings("movie", 693134, ct)));
        Assert.Equal(403, Status(await FeedsFor(rig, Me(unlinked)).Collection(726871, ct)));
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.TitleAsync(linked, true, 693134, ct)).Outcome);
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.CollectionAsync(linked, 726871, ct)).Outcome);
        Assert.Equal(calls, rig.Source.Calls);

        // Jellyfin Enhanced mode: a viewer without a Seerr account gets the title's public details, ratings and
        // collection, read with Jellyfin Enhanced's key; Seerr's per-account part stays behind.
        JellyfinEnhancedMode(rig);
        var title = Assert.IsType<ContentResult>(await FeedsFor(rig, Me(unlinked)).Title("movie", 693134, ct));
        Assert.Contains("Dune: Part Two", title.Content, StringComparison.Ordinal);
        Assert.DoesNotContain("mediaInfo", title.Content, StringComparison.Ordinal);
        Assert.DoesNotContain("someone else", title.Content, StringComparison.Ordinal);
        Assert.Equal("Andor", Body(await rig.Feeds.TitleAsync(unlinked, false, 83867, ct)).GetProperty("name").GetString());
        Assert.Equal(200, Status(await FeedsFor(rig, Me(unlinked)).Ratings("tv", 83867, ct)));
        Assert.Equal(200, Status(await FeedsFor(rig, Me(unlinked)).Collection(726871, ct)));
        Assert.Equal(200, Status(await FeedsFor(rig, Me(linked)).Title("tv", 83867, ct)));

        // Only a title's public details: native pages' own lists and the facade stay off.
        calls = rig.Source.Calls;
        Assert.Equal(403, Status(await FeedsFor(rig, Me(unlinked)).Filmography(3810, ct)));
        Assert.Equal(403, Status(await FeedsFor(rig, Me(unlinked)).Discover("movie", "genre", 878)));
        Assert.Equal(403, Status(await FeedsFor(rig, Me(unlinked)).Keywords("desert", ct)));
        Assert.Equal(403, Status(await FeedsFor(rig, Me(unlinked)).Genres("movie", ct)));
        Assert.Equal(calls, rig.Source.Calls);
        Assert.NotEqual(200, Status((await Call(rig, "UserLibrary", "GetItem", Me(unlinked), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result));

        // The title page's own rule still applies: a parental limit, a library the viewer can't open, a disabled
        // account, an API key.
        var kid = rig.Person(linked: false);
        kid.MaxParentalRatingScore = 10;
        Assert.Equal(404, Status(await FeedsFor(rig, Me(kid)).Title("movie", 693134, ct)));
        Assert.Equal(404, Status(await FeedsFor(rig, Me(kid)).Ratings("movie", 693134, ct)));
        Assert.Equal(404, Status(await FeedsFor(rig, Me(MoviesOnly(rig, linked: false))).Title("tv", 83867, ct)));
        var disabled = rig.Person(linked: false);
        disabled.SetPermission(PermissionKind.IsDisabled, true);
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.TitleAsync(disabled, true, 693134, ct)).Outcome);
        Assert.Equal(403, Status(await FeedsFor(rig, new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity("Custom"))).Collection(726871, ct)));

        // Seerr not set up: nothing to read.
        rig.Plugin.Plugin.Configuration.JellyseerrUrls = string.Empty;
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.TitleAsync(unlinked, true, 693134, ct)).Outcome);
    }

    [Fact]
    public async Task APublicTitleCarriesTheViewersOwnLibraryCopyAndSeerrsPublicStateNeverItsRequests()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        JellyfinEnhancedMode(rig);
        var viewer = rig.Person(linked: false);
        var ct = CancellationToken.None;
        // Absent, and Seerr says it's being processed: that public state, without Seerr's requests or arr ids.
        rig.Source.Series = SeriesJson.Replace("\"networks\"", "\"mediaInfo\":{\"status\":3,\"requests\":[{\"requestedBy\":{\"displayName\":\"someone else\"}}],\"externalServiceId\":9,\"downloadStatus\":[{\"title\":\"dl\"}]},\"networks\"", StringComparison.Ordinal);
        var pending = await rig.Feeds.TitleAsync(viewer, false, 83867, ct);
        Assert.Equal("{\"status\":3}", Body(pending).GetProperty("mediaInfo").GetRawText());
        foreach (var leak in new[] { "someone else", "externalServiceId", "downloadStatus" }) Assert.DoesNotContain(leak, pending.Json!, StringComparison.Ordinal);

        // A library copy the viewer can open: available, and it opens that copy (the window's Play and season links).
        var copy = Copy(rig, false, 83867, "Andor", new[] { viewer });
        var have = Body(await rig.Feeds.TitleAsync(viewer, false, 83867, ct)).GetProperty("mediaInfo");
        Assert.Equal((5, copy.Id.ToString("N")), (have.GetProperty("status").GetInt32(), have.GetProperty("jellyfinMediaId").GetString()));
    }

    [Fact]
    public async Task ATitlesSimilarAndRecommendedRowsAreJudgedForAViewerWithoutASeerrAccount()
    {
        using var rig = new Rig();
        rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        JellyfinEnhancedMode(rig);
        var viewer = rig.Person(linked: false);
        var admin = rig.Person(admin: true);
        var ct = CancellationToken.None;
        var mine = Copy(rig, true, 11, "Kids copy", new[] { viewer, admin });
        var theirs = Copy(rig, true, 12, "Adults copy", new[] { admin }, viewer);
        rig.Source.Related["movie:693134:similar:1"] = """
        {"page":1,"totalPages":3,"results":[
          {"id":438631,"mediaType":"movie","title":"Dune","posterPath":"/d1.jpg","mediaInfo":{"status":3,"requests":[{"requestedBy":{"displayName":"someone else"}}]}},
          {"id":11,"mediaType":"movie","title":"Kids copy"},
          {"id":12,"mediaType":"movie","title":"Adults copy"},
          {"id":1399,"mediaType":"tv","name":"Not a movie"},
          {"id":438631,"mediaType":"movie","title":"Dune again"}]}
        """;
        rig.Source.Related["movie:693134:recommendations:2"] = """{"page":2,"totalPages":2,"results":[{"id":335984,"title":"Blade Runner 2049"}]}""";

        var answer = await rig.Feeds.RelatedAsync(viewer, true, 693134, "similar", 1, ct);
        var body = Body(answer);
        // The list's own kind, once each; the viewer's copy as that copy, the copy hidden from them left out.
        Assert.Equal(new[] { "438631", $"11={mine.Id:N}" }, Titles(body));
        Assert.Equal((1, 3), (body.GetProperty("page").GetInt32(), body.GetProperty("totalPages").GetInt32()));
        Assert.Equal(3, body.GetProperty("results")[0].GetProperty("mediaInfo").GetProperty("status").GetInt32());
        foreach (var leak in new[] { "Adults copy", theirs.Id.ToString("N"), "someone else", "requests", "Not a movie" }) Assert.DoesNotContain(leak, answer.Json!, StringComparison.Ordinal);
        Assert.Equal(new[] { "335984" }, Titles(Body(await rig.Feeds.RelatedAsync(viewer, true, 693134, "recommendations", 2, ct))));
        Assert.Equal(3, Titles(Body(await rig.Feeds.RelatedAsync(admin, true, 693134, "similar", 1, ct))).Length);

        // Bad relation or page: invalid before anything is read; an unknown title's rows: not found.
        var calls = rig.Source.Calls;
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.RelatedAsync(viewer, true, 693134, "keywords", 1, ct)).Outcome);
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.RelatedAsync(viewer, true, 693134, "similar", 0, ct)).Outcome);
        Assert.Equal(calls, rig.Source.Calls);
        Assert.Equal(404, Status(await FeedsFor(rig, Me(viewer)).Related("movie", 77, "similar", 1, ct)));
        Assert.Equal(400, Status(await FeedsFor(rig, Me(viewer)).Related("person", 693134, "similar", 1, ct)));
        Assert.Equal(200, Status(await FeedsFor(rig, Me(viewer)).Related("movie", 693134, "similar", 1, ct)));

        // The title's own rule: a parental limit refuses the rows of a title the viewer may not see.
        var kid = rig.Person(linked: false);
        kid.MaxParentalRatingScore = 10;
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.RelatedAsync(kid, true, 693134, "similar", 1, ct)).Outcome);
        // Seerr mode: the viewer's own account reads them (the proxy), so none here.
        rig.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        Assert.Equal(403, Status(await FeedsFor(rig, Me(viewer)).Related("movie", 693134, "similar", 1, ct)));
    }

    [Fact]
    public async Task ACollectionsMoviesAreJudgedForTheViewerBeforeTheyLeaveTheServer()
    {
        using var rig = new Rig();
        JellyfinEnhancedMode(rig);
        rig.Source.Collections[726871] = CollectionJson;
        var viewer = rig.Person(linked: false);
        var admin = rig.Person(admin: true);
        var ct = CancellationToken.None;
        // Part Two: a copy the viewer can open; "Adults copy": one only the administrator can.
        var mine = Copy(rig, true, 693134, "Dune: Part Two", new[] { viewer, admin });
        var theirs = Copy(rig, true, 12, "Adults copy", new[] { admin }, viewer);

        var answer = await rig.Feeds.CollectionAsync(viewer, 726871, ct);
        var body = Body(answer);
        Assert.Equal(("Dune Collection", "The saga.", "/dc.jpg"), (body.GetProperty("name").GetString(), body.GetProperty("overview").GetString(), body.GetProperty("posterPath").GetString()));
        Assert.False(body.TryGetProperty("backdropPath", out _));
        var parts = body.GetProperty("parts");
        // Movies only, each judged like a filmography's: the viewer's copy as that copy (available), absent ones
        // with their public state, the copy hidden from them left out.
        Assert.Equal(new[] { "438631", "693134", "1170608" }, parts.EnumerateArray().Select(p => p.GetProperty("id").GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray());
        Assert.Equal(2, parts[0].GetProperty("mediaInfo").GetProperty("status").GetInt32());
        Assert.Equal(("2021-09-15", "/d1.jpg"), (parts[0].GetProperty("releaseDate").GetString(), parts[0].GetProperty("posterPath").GetString()));
        Assert.Equal(5, parts[1].GetProperty("mediaInfo").GetProperty("status").GetInt32());
        Assert.Equal(mine.Id.ToString("N"), parts[1].GetProperty("mediaInfo").GetProperty("jellyfinMediaId").GetString());
        Assert.False(parts[2].TryGetProperty("mediaInfo", out _));
        foreach (var leak in new[] { "Adults copy", theirs.Id.ToString("N"), "someone else", "requests", "externalServiceId", "Not a movie", "javascript" })
        {
            Assert.DoesNotContain(leak, answer.Json!, StringComparison.OrdinalIgnoreCase);
        }

        // The administrator gets every movie; a viewer with a parental limit below the movies' rating gets none.
        Assert.Equal(4, Body(await rig.Feeds.CollectionAsync(admin, 726871, ct)).GetProperty("parts").GetArrayLength());
        var kid = rig.Person(linked: false);
        kid.MaxParentalRatingScore = 10;
        Assert.Equal(0, Body(await rig.Feeds.CollectionAsync(kid, 726871, ct)).GetProperty("parts").GetArrayLength());

        // Unknown, invalid, busy and down answer like the other feeds; Seerr mode needs the viewer's own account.
        Assert.Equal(FeedOutcome.NotFound, (await rig.Feeds.CollectionAsync(viewer, 1, ct)).Outcome);
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.CollectionAsync(viewer, 0, ct)).Outcome);
        Assert.Equal(404, Status(await FeedsFor(rig, Me(viewer)).Collection(1, ct)));
        rig.Source.Busy = true;
        Assert.Equal(429, Status(await FeedsFor(rig, Me(viewer)).Collection(726871, ct)));
        rig.Source.Busy = false;
        rig.Source.Down = true;
        Assert.Equal(503, Status(await FeedsFor(rig, Me(viewer)).Collection(726871, ct)));
        rig.Source.Down = false;
        rig.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.CollectionAsync(viewer, 726871, ct)).Outcome);
        Assert.Equal(FeedOutcome.Ok, (await rig.Feeds.CollectionAsync(rig.Person(), 726871, ct)).Outcome);
    }

    [Fact]
    public async Task AnHtmlNotFoundFromAProxyInFrontOfSeerrIsAFailureNotNoRatings()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var config = rig.Plugin.Plugin.Configuration;
        // What the transport answers: a reverse proxy's own 404 page (HTML), or Seerr's 404 for a series Rotten
        // Tomatoes doesn't know (JSON). With two Seerr URLs only the first one answers that way.
        var proxy = true;
        using var seerr = new IntegrationTransport((req, _) =>
        {
            if (req.RequestUri!.Host == "seerr2.invalid") return Task.FromResult(IntegrationTransport.Response("""{"criticsScore":96}"""));
            return Task.FromResult(proxy
                ? IntegrationTransport.Response("<html><body><h1>404 Not Found</h1></body></html>", 404, "text/html")
                : IntegrationTransport.Response("""{"message":"Rotten Tomatoes ratings not found."}""", 404));
        });
        using var tmdb = new TmdbResponseCache(seerr, TimeProvider.System);
        // A new source each time: failures are cached for a moment.
        NativeDetailsFeeds Feeds() => rig.FeedsOver(new SeerrNativeDetailsSource(seerr, tmdb, rig.Plugin.Core.Logger));

        var proxied = await Feeds().RatingsAsync(viewer, false, 83867, CancellationToken.None);
        Assert.Equal(FeedOutcome.Unavailable, proxied.Outcome);
        Assert.Null(proxied.Json);
        // The other source callers: the proxy's page is an outage there too, not "no such title".
        Assert.Equal(FeedOutcome.Unavailable, (await Feeds().TitleAsync(viewer, true, 693134, CancellationToken.None)).Outcome);
        var source = new SeerrNativeDetailsSource(seerr, tmdb, rig.Plugin.Core.Logger);
        Assert.False((await source.MovieAsync(693134, viewer.Id, CancellationToken.None)).NotFound);
        Assert.False((await source.SeriesAsync(83867, viewer.Id, CancellationToken.None)).NotFound);
        Assert.False((await source.SeasonAsync(83867, 1, viewer.Id, CancellationToken.None)).NotFound);
        Assert.False((await source.PersonCreditsAsync(3810, viewer.Id, CancellationToken.None)).NotFound);
        Assert.False((await source.DiscoverAsync(true, "genre", 878, 1, null, viewer.Id, CancellationToken.None)).NotFound);

        // The next Seerr URL is still asked after a proxy's page.
        config.JellyseerrUrls = "http://seerr.invalid\nhttp://seerr2.invalid";
        var next = await Feeds().RatingsAsync(viewer, false, 83867, CancellationToken.None);
        Assert.Equal(FeedOutcome.Ok, next.Outcome);
        Assert.Equal("""{"criticsScore":96}""", next.Json);
        config.JellyseerrUrls = "http://seerr.invalid";

        // Seerr's own 404 still means the series has no ratings, and a title Seerr doesn't know stays "no such title".
        proxy = false;
        var none = await Feeds().RatingsAsync(viewer, false, 83867, CancellationToken.None);
        Assert.Equal(FeedOutcome.Ok, none.Outcome);
        Assert.Equal("null", none.Json);
        Assert.Equal(FeedOutcome.NotFound, (await Feeds().TitleAsync(viewer, true, 693134, CancellationToken.None)).Outcome);

        // The route: the proxy's page is a 503, Seerr's own 404 a 200 null.
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsFeedsController Route() => new(Feeds(), rig.Callers.Users.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(viewer) } },
        };
        Assert.Equal("null", Assert.IsType<ContentResult>(await Route().Ratings("tv", 83867, CancellationToken.None)).Content);
        proxy = true;
        Assert.Equal(503, Status(await Route().Ratings("tv", 83867, CancellationToken.None)));
    }

    [Fact]
    public async Task ATagsKeywordAndALibraryGenresTmdbGenreAreFoundWithoutASeerrAccount()
    {
        using var rig = new Rig();
        var unlinked = rig.Person(linked: false);
        Assert.Equal(FeedOutcome.Refused, (await rig.Feeds.KeywordsAsync(unlinked, "adult animation", CancellationToken.None)).Outcome);
        var config = rig.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je";
        // Only id and name of real keywords leave the server.
        Assert.Equal("""{"results":[{"id":161919,"name":"adult animation"}]}""", (await rig.Feeds.KeywordsAsync(unlinked, "adult animation", CancellationToken.None)).Json);
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.KeywordsAsync(unlinked, " ", CancellationToken.None)).Outcome);
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.KeywordsAsync(unlinked, new string('a', 101), CancellationToken.None)).Outcome);
        var genres = JsonDocument.Parse((await rig.Feeds.GenresAsync(unlinked, false, CancellationToken.None)).Json!).RootElement;
        Assert.Equal(new[] { "10765=Sci-Fi & Fantasy", "18=Drama" }, genres.EnumerateArray().Select(g => g.GetProperty("id").GetInt32() + "=" + g.GetProperty("name").GetString()));
        // The keyword's feeds, filtered like the other discovery feeds.
        rig.Source.Feeds["movie:keywords:161919:1"] = """{"page":1,"totalPages":3,"results":[{"id":438631,"mediaType":"movie","title":"Dune"}]}""";
        Assert.Equal(new[] { "438631" }, Titles(Body(await rig.Feeds.DiscoverAsync(unlinked, true, "keyword", 161919, 1, null, CancellationToken.None))));
        Assert.Contains("movie:keywords:161919:1", rig.Source.FeedCalls);
        Assert.Equal(FeedOutcome.Invalid, (await rig.Feeds.DiscoverAsync(unlinked, true, "keywords", 161919, 1, null, CancellationToken.None)).Outcome);
    }

    [Fact]
    public async Task SeasonAndEpisodePagesNameTheSeriesGenresAndRegularCastButTheirCardsDont()
    {
        using var rig = new Rig();
        rig.Source.Series = SeriesJson.Replace("\"credits\":{\"cast\":[],\"crew\":[]}",
            "\"credits\":{\"cast\":[{\"id\":11,\"name\":\"Diego Luna\",\"character\":\"Cassian\",\"order\":0}],\"crew\":[]}", StringComparison.Ordinal);
        var viewer = rig.Person();
        foreach (var id in new[] { SyntheticId.SeasonOf(83867, 1), SyntheticId.EpisodeOf(83867, 1, 2) })
        {
            var dto = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(id) })).Result);
            Assert.Equal(new[] { "Drama" }, dto.Genres);
            var person = Assert.Single(dto.People);
            Assert.Equal(("Diego Luna", "Cassian"), (person.Name, person.Role));
            Assert.DoesNotContain(dto.People, p => p.Name == "Tony Gilroy");   // the series' creators stay on the series page
        }
    }

    [Fact]
    public void AGrantLastsADayFromTheHourItWasMintedInAndNeverFromTheFuture()
    {
        var now = new DateTime(2026, 10, 17, 10, 30, 0, DateTimeKind.Utc);
        using var images = new IntegrationTransport((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)));
        var artwork = new NativeDetailsArtwork(images, null, () => now);
        var owner = Guid.NewGuid();
        var viewer = Guid.NewGuid();
        var tag = artwork.Mint(owner, ImageType.Primary, 0, "/a.jpg", viewer, "r1");
        // The same image in the same hour keeps its tag (a page drawn twice reuses its URLs).
        now = now.AddMinutes(20);
        Assert.Equal(tag, artwork.Mint(owner, ImageType.Primary, 0, "/a.jpg", viewer, "r1"));
        Assert.True(artwork.TryRead(tag, out var grant));
        Assert.Equal(owner, grant!.Context);                     // a title's own artwork: its own page
        now = new DateTime(2026, 10, 18, 9, 59, 0, DateTimeKind.Utc);
        Assert.True(artwork.TryRead(tag, out _));
        now = new DateTime(2026, 10, 18, 10, 0, 0, DateTimeKind.Utc);
        Assert.False(artwork.TryRead(tag, out _));               // 24 hours after its hour began
        // A clock that went back two hours doesn't make a grant from "later" acceptable.
        var later = artwork.Mint(owner, ImageType.Primary, 0, "/a.jpg", viewer, "r1");
        now = now.AddHours(-2);
        Assert.False(artwork.TryRead(later, out _));
        now = now.AddHours(1);
        Assert.True(artwork.TryRead(later, out _));
    }

    [Fact]
    public async Task ACastPhotoIsServedWhileThePageItWasShownOnIsStillTheViewers()
    {
        using var rig = new Rig();
        long revision = 1;
        rig.LibraryRevision = () => revision;
        rig.Restart();
        var viewer = rig.Person();
        var movie = SyntheticId.Movie(693134);
        var dto = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(movie) })).Result);
        var bardem = dto.People.Single(p => p.Name == "Javier Bardem");
        Assert.True(rig.Artwork.TryRead(bardem.PrimaryImageTag, out var castGrant));
        Assert.Equal((bardem.Id, Id(movie)), (castGrant!.Owner, castGrant.Context));
        var ownPage = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = bardem.Id })).Result);
        Assert.True(rig.Artwork.TryRead(ownPage.ImageTags[ImageType.Primary], out var pageGrant));
        Assert.Equal(bardem.Id, pageGrant!.Context);
        Dictionary<string, object?> Args(string tag) => new() { ["itemId"] = bardem.Id, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, Args(bardem.PrimaryImageTag!))).Result));
        // The library gets a copy of the title that is hidden from the viewer: the title's page is no
        // longer theirs, and neither are the photos it showed; the person's own page still is.
        Copy(rig, true, 693134, "Dune: Part Two", Array.Empty<User>(), viewer);
        revision++;
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(bardem.PrimaryImageTag!))).Result));
        Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, Args(ownPage.ImageTags[ImageType.Primary]))).Result));
        // The person page's rule is read again when its photo is served: an unknown person (the source says
        // there is no such person now) loses it.
        rig.Source.Down = true;
        Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, Args(ownPage.ImageTags[ImageType.Primary]))).Result));
    }

    [Fact]
    public async Task ARestrictedViewersArtworkStillLoadsAfterARestartForgotTheTitlesRating()
    {
        var dir = Path.Combine(Path.GetTempPath(), "je-3h1-grants-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var rig = new Rig(dir);
            var viewer = rig.Person();
            viewer.MaxParentalRatingScore = 14;
            var movie = Id(SyntheticId.Movie(693134));
            var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
            var args = new Dictionary<string, object?> { ["itemId"] = movie, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
            // A restart: the key and the policy revision are the same, the rating cache is empty. The rating is read again.
            rig.Restart(forgetRatings: true);
            Assert.Equal(200, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
            // A rating that can't be placed under the limit any more (re-rated while the server was down) is
            // refused once read: fail closed.
            rig.Restart(forgetRatings: true);
            rig.Rating = "R";
            Assert.Equal(404, Status((await Call(rig, "Image", "GetItemImage", null, new(args))).Result));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }


    [Fact]
    public async Task ASimilarTitleTheLibraryHasButSeerrDoesntNameIsShownAsTheViewersCopyOrLeftOut()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var blocked = rig.Person();
        // Dune (2021) is recommended without a library link from Seerr, but the library has it.
        var copy = Copy(rig, true, 438631, "Dune", new[] { viewer }, blocked);
        rig.Dto.Setup(d => d.GetBaseItemDto(copy, It.IsAny<MediaBrowser.Controller.Dto.DtoOptions>(), viewer, null)).Returns(new BaseItemDto { Id = copy.Id, Name = "Dune" });
        async Task<BaseItemDto[]> Similar(User who) => Value<QueryResult<BaseItemDto>>((await Call(rig, "Library", "GetSimilarItems", Me(who), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result).Items.ToArray();
        var mine = await Similar(viewer);
        Assert.Equal(copy.Id, mine.Single(i => i.Name == "Dune").Id);       // the library's own, not a stand-in
        var theirs = await Similar(blocked);
        Assert.DoesNotContain(theirs, i => i.Name == "Dune" || i.Id == copy.Id);   // hidden from them: not remade from public data
        Assert.Contains(theirs, i => i.Name == "Blade Runner 2049");
    }


    [Fact]
    public async Task APageReadTheViewersBudgetCantStartIs429WithRetryAfterNotAnOutage()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        rig.Source.PagesBusy = true;
        var run = await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) });
        Assert.Equal(429, Status(run.Result));
        Assert.Equal("2", run.Http.Response.Headers["Retry-After"].ToString());
        var seasons = await Call(rig, "TvShows", "GetSeasons", Me(viewer), new() { ["seriesId"] = Id(SyntheticId.Series(83867)) });
        Assert.Equal(429, Status(seasons.Result));
        rig.Source.PagesBusy = false;
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(SyntheticId.Movie(693134)) })).Result));
    }

}

/// <summary>The real Seerr-backed source: shared fetches, 404 vs outage, and a bounded linked-account check.</summary>
[Collection("Plugin singleton")]
public class NativeDetailsSourceTests
{
    private static (ApiPluginFixture Plugin, SeerrNativeDetailsSource Source, TmdbResponseCache Tmdb) Make(IntegrationTransport seerr)
    {
        var plugin = new ApiPluginFixture();
        var c = plugin.Plugin.Configuration;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = "http://seerr.invalid";
        c.JellyseerrApiKey = "test-seerr";
        var tmdb = new TmdbResponseCache(seerr, TimeProvider.System);
        return (plugin, new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger), tmdb);
    }

    [Fact]
    public async Task FetchesAreSharedAndTellMissingFromUnavailable()
    {
        var gate = new TaskCompletionSource();
        using var seerr = new IntegrationTransport(async (req, _) =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (req.RequestUri.Host == "api.themoviedb.org")
            {
                // TMDB: title 4 doesn't exist; title 3 does (Seerr is just failing).
                return path.EndsWith("/movie/4", StringComparison.Ordinal)
                    ? IntegrationTransport.Response("""{"success":false,"status_code":34}""", 404)
                    : IntegrationTransport.Response("""{"id":3}""");
            }

            if (path.EndsWith("/movie/1", StringComparison.Ordinal)) { await gate.Task; return IntegrationTransport.Response("""{"id":1,"title":"One"}"""); }
            if (path.EndsWith("/movie/2", StringComparison.Ordinal)) return IntegrationTransport.Response("""{"message":"Not found"}""", 404);
            return IntegrationTransport.Response("""{"message":"Unable to retrieve movie."}""", 500);
        });
        var (plugin, source, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var a = source.MovieAsync(1, CancellationToken.None);
        var b = source.MovieAsync(1, CancellationToken.None);
        gate.SetResult();
        Assert.Equal("One", (await a).Data!.Value.GetProperty("title").GetString());
        Assert.Equal("One", (await b).Data!.Value.GetProperty("title").GetString());
        Assert.Equal(1, seerr.Calls);
        var missing = await source.MovieAsync(2, CancellationToken.None);
        Assert.True(missing.NotFound);
        Assert.Null(missing.Data);
        // Seerr answers 500 for a title TMDB doesn't have; without a TMDB key that stays "unavailable".
        Assert.False((await source.MovieAsync(4, CancellationToken.None)).NotFound);
        // With JE's TMDB key, TMDB's own 404 makes it "no such title"; a title TMDB has stays an outage.
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        var keyed = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger);
        Assert.True((await keyed.MovieAsync(4, CancellationToken.None)).NotFound);
        var down = await keyed.MovieAsync(3, CancellationToken.None);
        Assert.False(down.NotFound);
        Assert.Null(down.Data);
        // Negative answers are cached briefly too (no request storm against a failing Seerr).
        var calls = seerr.Calls;
        await keyed.MovieAsync(3, CancellationToken.None);
        await keyed.MovieAsync(4, CancellationToken.None);
        Assert.Equal(calls, seerr.Calls);
        Assert.Equal(0, source.InFlightCount);
        Assert.Equal(0, keyed.InFlightCount);
    }

    [Fact]
    public async Task AWaiterThatGivesUpLeavesNoInFlightEntryBehind()
    {
        var gate = new TaskCompletionSource();
        using var seerr = new IntegrationTransport(async (req, _) =>
        {
            await gate.Task;
            var r = IntegrationTransport.Response("""{"id":1,"title":"One"}""");
            return r;
        });
        var (plugin, source, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        using (var cts = new CancellationTokenSource())
        {
            var waiting = source.MovieAsync(1, cts.Token);
            cts.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        }

        Assert.Equal(1, source.InFlightCount);
        gate.SetResult();
        for (var i = 0; i < 100 && source.InFlightCount > 0; i++) await Task.Delay(20);
        Assert.Equal(0, source.InFlightCount);
        // The fetch still completed for later callers.
        Assert.Equal("One", (await source.MovieAsync(1, CancellationToken.None)).Data!.Value.GetProperty("title").GetString());
        Assert.Equal(1, seerr.Calls);

        // Artwork: the same rule.
        var imageGate = new TaskCompletionSource();
        using var images = new IntegrationTransport(async (req, _) =>
        {
            await imageGate.Task;
            var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[] { 0xff, 0xd8, 0xff }) };
            r.Content.Headers.ContentType = new("image/jpeg");
            return r;
        });
        var artwork = new NativeDetailsArtwork(images);
        using (var cts = new CancellationTokenSource())
        {
            var waiting = artwork.FetchAsync("/poster.jpg", "w300", cts.Token);
            cts.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        }

        Assert.Equal(1, artwork.InFlightCount);
        imageGate.SetResult();
        for (var i = 0; i < 100 && artwork.InFlightCount > 0; i++) await Task.Delay(20);
        Assert.Equal(0, artwork.InFlightCount);
    }

    [Fact]
    public async Task ALinkedAccountListAnswersOnlyWhileRecentAndForTheSeerrConfiguredNow()
    {
        var user = Guid.NewGuid();
        var down = false;
        var listed = new HashSet<string> { user.ToString("N") };
        using var seerr = new IntegrationTransport((req, _) => Task.FromResult(down
            ? IntegrationTransport.Response("{}", 500)
            : IntegrationTransport.Response(JsonSerializer.Serialize(new { results = listed.Select(id => new { jellyfinUserId = id }) }))));
        var (plugin, _, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var now = new DateTime(2026, 10, 15, 12, 0, 0, DateTimeKind.Utc);
        var source = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger, () => now);
        Assert.True(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        // Seerr goes away: the last list still answers for a while ...
        down = true;
        now = now.AddMinutes(2);
        Assert.True(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        // ... but not for ever: once it is old, "can't tell" (the page falls back), never "linked".
        now = now.AddMinutes(4);
        Assert.Null(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        now = now.AddMinutes(1);
        Assert.Null(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        // Back: read again; the admin had unlinked the viewer meanwhile.
        down = false;
        listed.Clear();
        now = now.AddMinutes(1);
        Assert.False(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        // Another Seerr (URL or key changed): the list read from the old one is no answer for it.
        listed.Add(user.ToString("N"));
        now = now.AddMinutes(1);
        Assert.True(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        listed.Clear();
        plugin.Plugin.Configuration.JellyseerrApiKey = "another-key";
        Assert.False(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        down = true;
        plugin.Plugin.Configuration.JellyseerrUrls = "http://other-seerr.invalid";
        Assert.Null(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
    }

    [Fact]
    public async Task AHangingSeerrCannotConvoyTheLinkedAccountCheck()
    {
        using var seerr = new IntegrationTransport(async (req, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return IntegrationTransport.Response();
        });
        var (plugin, source, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var user = Guid.NewGuid();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        // A page fires several facade requests at once: one bounded refresh, the rest don't queue behind it for long.
        var checks = Enumerable.Range(0, 8).Select(_ => source.IsSeerrLinkedAsync(user, CancellationToken.None)).ToArray();
        // Nothing known yet: "can't tell" (the page fails over to the modal), never "linked".
        Assert.All(await Task.WhenAll(checks), linked => Assert.Null(linked));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(9), clock.Elapsed.ToString());
        Assert.Equal(1, seerr.Calls);
        // Right after a failed refresh: answered at once, no new attempt.
        clock.Restart();
        Assert.Null(await source.IsSeerrLinkedAsync(user, CancellationToken.None));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(1), clock.Elapsed.ToString());
        Assert.Equal(1, seerr.Calls);
    }

    [Fact]
    public async Task EveryPageOfSeerrsAccountsIsReadBeforeSomeoneIsCalledUnlinked()
    {
        // 2,500 Seerr accounts: the one asked about is on the third page.
        var ids = Enumerable.Range(0, 2500).Select(_ => Guid.NewGuid().ToString("N")).ToList();
        var failPage = -1;
        using var seerr = new IntegrationTransport((req, _) =>
        {
            var q = System.Web.HttpUtility.ParseQueryString(req.RequestUri!.Query);
            var skip = int.Parse(q["skip"] ?? "0", System.Globalization.CultureInfo.InvariantCulture);
            var take = int.Parse(q["take"] ?? "0", System.Globalization.CultureInfo.InvariantCulture);
            if (skip / take == failPage) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadGateway));
            var page = ids.Skip(skip).Take(take).Select(id => new { jellyfinUserId = id });
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { pageInfo = new { results = ids.Count }, results = page })));
        });
        var (plugin, _, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var now = new DateTime(2026, 10, 16, 12, 0, 0, DateTimeKind.Utc);
        var source = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger, () => now);
        Assert.True(await source.IsSeerrLinkedAsync(Guid.Parse(ids[2400]), CancellationToken.None));
        Assert.Equal(3, seerr.Calls);
        Assert.False(await source.IsSeerrLinkedAsync(Guid.NewGuid(), CancellationToken.None));
        // A page that can't be read: can't tell (never "unlinked" for the people on it).
        var fresh = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger, () => now);
        failPage = 2;
        Assert.Null(await fresh.IsSeerrLinkedAsync(Guid.Parse(ids[2400]), CancellationToken.None));
    }

    [Fact]
    public async Task APagesOwnMetadataReadsComeOutOfTheSameBudgetAfterAShortWait()
    {
        using var seerr = new IntegrationTransport((req, _) => Task.FromResult(IntegrationTransport.Response("""{"id":1,"title":"A title","name":"A name"}""")));
        var (plugin, _, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var now = new DateTime(2026, 10, 16, 12, 0, 0, DateTimeKind.Utc);
        var source = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger, () => now) { PageReadWait = TimeSpan.FromMilliseconds(400) };
        INativeDetailsSource pages = source;
        var viewer = Guid.NewGuid();
        var none = CancellationToken.None;
        // Movie, series, season, person, studio and network pages, each a new title: a token each.
        for (var id = 1; id <= SeerrNativeDetailsSource.FeedBurst; id++)
        {
            var answer = (id % 6) switch
            {
                0 => await pages.MovieAsync(id, viewer, none),
                1 => await pages.SeriesAsync(id, viewer, none),
                2 => await pages.SeasonAsync(id, 1, viewer, none),
                3 => await pages.PersonAsync(id, viewer, none),
                4 => await pages.StudioAsync(id, viewer, none),
                _ => await pages.NetworkAsync(id, viewer, none),
            };
            Assert.NotNull(answer.Data);
        }

        Assert.Equal(SeerrNativeDetailsSource.FeedBurst, seerr.Calls);
        // Past the budget a new page waits for a token, then answers busy (nothing fetched).
        var watch = System.Diagnostics.Stopwatch.StartNew();
        Assert.True((await pages.MovieAsync(9999, viewer, none)).Busy);
        Assert.True(watch.ElapsedMilliseconds >= 350, watch.ElapsedMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal(SeerrNativeDetailsSource.FeedBurst, seerr.Calls);
        // A page already read is free; another viewer has their own budget; the old unbudgeted read
        // (the server's own checks) never asks the viewer's budget.
        Assert.NotNull((await pages.MovieAsync(6, viewer, none)).Data);
        Assert.NotNull((await pages.MovieAsync(9999, Guid.NewGuid(), none)).Data);
        Assert.NotNull((await pages.MovieAsync(9999, viewer, none)).Data);
        Assert.NotNull((await source.MovieAsync(8888, none)).Data);
        // A token refilled while waiting lets the read start.
        var waiting = pages.SeriesAsync(7777, viewer, none);
        await Task.Delay(100);
        now = now.AddSeconds(1);
        Assert.NotNull((await waiting).Data);
    }

    [Fact]
    public async Task FeedReadsComeOutOfTheViewersBudgetWhenTheyGoUpstream()
    {
        using var seerr = new IntegrationTransport((req, _) => Task.FromResult(req.RequestUri!.Host == "api.themoviedb.org"
            ? IntegrationTransport.Response("""{"page":1,"total_pages":1,"results":[{"id":1399,"name":"Game of Thrones"}]}""")
            : IntegrationTransport.Response("""{"page":1,"totalPages":500,"results":[{"id":603,"mediaType":"movie","title":"The Matrix"}],"cast":[],"crew":[]}""")));
        var (plugin, _, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var now = new DateTime(2026, 10, 16, 12, 0, 0, DateTimeKind.Utc);
        var source = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger, () => now);
        var viewer = Guid.NewGuid();
        var none = CancellationToken.None;
        Task<SourceAnswer> Page(int page, Guid who) => source.DiscoverAsync(true, "genre", 878, page, null, who, none);

        // Normal browsing (a person page: one read; a discovery page's first screens and their
        // prefetch: about fifteen pages over two feeds) stays well inside the burst.
        for (var page = 1; page <= SeerrNativeDetailsSource.FeedBurst; page++) Assert.NotNull((await Page(page, viewer)).Data);
        Assert.Equal(SeerrNativeDetailsSource.FeedBurst, seerr.Calls);
        // One more page, sort, person or company series that isn't cached: not started.
        Assert.True((await Page(SeerrNativeDetailsSource.FeedBurst + 1, viewer)).Busy);
        Assert.True((await source.DiscoverAsync(true, "genre", 878, 1, "vote_average.desc", viewer, none)).Busy);
        Assert.True((await source.PersonCreditsAsync(3810, viewer, none)).Busy);
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        Assert.True((await source.CompanySeriesAsync(99, 1, null, viewer, none)).Busy);
        Assert.Equal(SeerrNativeDetailsSource.FeedBurst, seerr.Calls);
        // What is cached costs nothing.
        Assert.NotNull((await Page(1, viewer)).Data);
        Assert.NotNull((await Page(SeerrNativeDetailsSource.FeedBurst, viewer)).Data);
        // Another viewer has their own budget; what they fetched is then cached for everyone.
        var other = Guid.NewGuid();
        Assert.NotNull((await source.CompanySeriesAsync(99, 1, null, other, none)).Data);
        Assert.NotNull((await source.PersonCreditsAsync(3810, other, none)).Data);
        Assert.NotNull((await source.CompanySeriesAsync(99, 1, null, viewer, none)).Data);
        Assert.NotNull((await source.PersonCreditsAsync(3810, viewer, none)).Data);
        // The budget comes back at FeedPerSecond.
        now = now.AddSeconds(5);
        var refilled = (int)(5 * SeerrNativeDetailsSource.FeedPerSecond);
        var started = 0;
        for (var page = 100; page < 100 + refilled + 5; page++) started += (await Page(page, viewer)).Data != null ? 1 : 0;
        Assert.Equal(refilled, started);
        // A refused read was never fetched or cached: it is started once the budget allows.
        now = now.AddSeconds(1);
        Assert.NotNull((await Page(SeerrNativeDetailsSource.FeedBurst + 1, viewer)).Data);
        Assert.Equal(0, source.FeedReadsPending);
        Assert.Equal(0, source.InFlightCount);
    }

    [Fact]
    public async Task FeedReadsRunAFewAtATimeBehindABoundedQueue()
    {
        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var running = 0;
        var most = 0;
        var gate = new object();
        using var seerr = new IntegrationTransport(async (req, _) =>
        {
            var now = Interlocked.Increment(ref running);
            lock (gate) most = Math.Max(most, now);
            await hold.Task;
            Interlocked.Decrement(ref running);
            return IntegrationTransport.Response("""{"page":1,"totalPages":500,"results":[]}""");
        });
        var (plugin, source, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        var none = CancellationToken.None;
        var queued = SeerrNativeDetailsSource.FeedConcurrency + SeerrNativeDetailsSource.FeedQueue;
        // Every wait is bounded: a read wrongly queued behind the held ones fails the test instead of hanging it.
        var limit = TimeSpan.FromSeconds(10);
        try
        {
            // Several viewers, each well inside their own budget, fill the server's queue; the last of
            // them gives up at once, which doesn't free the place its read still holds.
            var reads = Enumerable.Range(1, queued - 1).Select(page => source.DiscoverAsync(false, "network", 49, page, null, Guid.NewGuid(), none)).ToList();
            using (var cts = new CancellationTokenSource())
            {
                var gaveUp = source.DiscoverAsync(false, "network", 49, queued, null, Guid.NewGuid(), cts.Token);
                cts.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => gaveUp);
            }

            for (var i = 0; i < 200 && Volatile.Read(ref running) < SeerrNativeDetailsSource.FeedConcurrency; i++) await Task.Delay(10);
            await Task.Delay(50);
            Assert.Equal(SeerrNativeDetailsSource.FeedConcurrency, Volatile.Read(ref running));
            Assert.Equal(queued, source.FeedReadsPending);
            // A fresh viewer's new read isn't started (nor queued) while the queue is full ...
            Assert.True((await source.DiscoverAsync(false, "network", 49, 400, null, Guid.NewGuid(), none).WaitAsync(limit)).Busy);
            // ... but joining a read already running costs nothing.
            var join = source.DiscoverAsync(false, "network", 49, 1, null, Guid.NewGuid(), none);
            hold.SetResult();
            Assert.All(await Task.WhenAll(reads).WaitAsync(limit), r => Assert.NotNull(r.Data));
            Assert.NotNull((await join.WaitAsync(limit)).Data);
            Assert.Equal(queued, seerr.Calls);
            Assert.Equal(SeerrNativeDetailsSource.FeedConcurrency, most);
            Assert.Equal(0, source.FeedReadsPending);
            Assert.Equal(0, source.InFlightCount);
        }
        finally
        {
            hold.TrySetResult();
        }

        // Room again: new reads start.
        Assert.NotNull((await source.DiscoverAsync(false, "network", 49, 400, null, Guid.NewGuid(), none)).Data);
    }

    [Fact]
    public async Task OneViewerCantFillTheFeedQueueAndWaitingViewersTakeTurns()
    {
        // A slow upstream: every read waits until the test lets it (or everything) answer.
        var holds = new System.Collections.Concurrent.ConcurrentDictionary<string, TaskCompletionSource>();
        var all = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var started = new System.Collections.Concurrent.ConcurrentQueue<string>();
        TaskCompletionSource Hold(string key) => holds.GetOrAdd(key, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        using var seerr = new IntegrationTransport(async (req, _) =>
        {
            var key = req.RequestUri!.PathAndQuery;
            started.Enqueue(key);
            await Task.WhenAny(Hold(key).Task, all.Task);
            return IntegrationTransport.Response("""{"page":1,"totalPages":500,"results":[]}""");
        });
        var (plugin, _, tmdb) = Make(seerr);
        using var _p = plugin;
        using var _t = tmdb;
        // The clock stands still: no budget comes back, and none is needed (every viewer stays far inside it).
        var now = new DateTime(2026, 10, 16, 12, 0, 0, DateTimeKind.Utc);
        var source = new SeerrNativeDetailsSource(seerr, tmdb, plugin.Core.Logger, () => now);
        var none = CancellationToken.None;
        var share = SeerrNativeDetailsSource.FeedPerViewer;
        var slots = SeerrNativeDetailsSource.FeedConcurrency;
        // The scenario: one viewer's share fills every upstream slot, and is a small part of the server's room.
        Assert.Equal(slots, share);
        Assert.True(3 * share <= slots + SeerrNativeDetailsSource.FeedQueue);
        static string Key(int network, int page) => $"/api/v1/discover/tv?page={page}&network={network}";
        Task<SourceAnswer> Page(int network, int page, Guid who) => source.DiscoverAsync(false, "network", network, page, null, who, none);
        // Every wait is bounded: a read wrongly held back fails the test instead of hanging it.
        var limit = TimeSpan.FromSeconds(10);
        async Task StartedAsync(int count)
        {
            for (var i = 0; i < 500 && started.Count < count; i++) await Task.Delay(10);
            await Task.Delay(30);
            Assert.Equal(count, started.Count);
        }

        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var third = Guid.NewGuid();
        var joiner = Guid.NewGuid();
        try
        {
            // The first viewer keeps distinct uncached pages coming: its share runs, every upstream slot busy.
            var firstReads = Enumerable.Range(1, share).Select(page => Page(49, page, first)).ToList();
            await StartedAsync(slots);
            // It can't go past its share, though its budget has tokens left and the server has room.
            for (var page = share + 1; page <= slots + SeerrNativeDetailsSource.FeedQueue; page++)
            {
                Assert.True((await Page(49, page, first).WaitAsync(limit)).Busy, $"page {page}");
            }

            Assert.Equal(share, source.FeedReadsOf(first));
            Assert.Equal(share, source.FeedReadsPending);
            // Other viewers' uncached reads are still taken: the second fills its own share (queued), the third queues one after it.
            var secondReads = Enumerable.Range(1, share).Select(page => Page(50, page, second)).ToList();
            var thirdRead = Page(51, 1, third);
            await StartedAsync(slots);
            Assert.All(secondReads.Append(thirdRead), r => Assert.False(r.IsCompleted));
            Assert.Equal(share, source.FeedReadsOf(second));
            Assert.Equal(1, source.FeedReadsOf(third));
            Assert.True((await Page(50, share + 1, second).WaitAsync(limit)).Busy);
            // Joining a read already running is free, and lets nobody past a share: a viewer with
            // nothing outstanding and one at its share both join the first viewer's page 3.
            var joined = Page(49, 3, joiner);
            var joinedAtShare = Page(49, 3, second);
            Assert.Equal(0, source.FeedReadsOf(joiner));
            Assert.Equal(share, source.FeedReadsOf(second));
            Assert.Equal(share, source.FeedReadsOf(first));
            Assert.Equal(2 * share + 1, source.FeedReadsPending);
            Assert.Equal(slots, started.Count);

            // Slots go to the waiting viewers in turn: the first freed one to the second viewer, the
            // next to the third, not to the second viewer's next read.
            Hold(Key(49, 1)).SetResult();
            Assert.NotNull((await firstReads[0].WaitAsync(limit)).Data);
            await StartedAsync(slots + 1);
            Assert.Equal(Key(50, 1), started.Last());
            Hold(Key(49, 2)).SetResult();
            Assert.NotNull((await firstReads[1].WaitAsync(limit)).Data);
            await StartedAsync(slots + 2);
            Assert.Equal(Key(51, 1), started.Last());
            // A read that ended gave its place back: the first viewer may start (queue) new ones again, up to its share.
            Assert.Equal(share - 2, source.FeedReadsOf(first));
            var again = new[] { Page(49, 100, first), Page(49, 101, first) };
            Assert.All(again, r => Assert.False(r.IsCompleted));
            Assert.True((await Page(49, 102, first).WaitAsync(limit)).Busy);
            Assert.Equal(share, source.FeedReadsOf(first));

            all.SetResult();
            var answers = await Task.WhenAll(firstReads.Concat(secondReads).Concat(again).Append(thirdRead).Append(joined).Append(joinedAtShare)).WaitAsync(limit);
            Assert.All(answers, r => Assert.NotNull(r.Data));
            Assert.Equal(2 * share + 3, seerr.Calls);
            // Nothing is left counted or tracked once the reads end.
            Assert.Equal(0, source.FeedReadsPending);
            Assert.Equal(0, source.FeedViewersTracked);
            Assert.Equal(0, source.InFlightCount);
        }
        finally
        {
            all.TrySetResult();
        }

        // The joiner was never charged: its whole budget is still there.
        for (var page = 1; page <= SeerrNativeDetailsSource.FeedBurst; page++) Assert.NotNull((await Page(52, page, joiner).WaitAsync(limit)).Data);
    }


}
#endif
