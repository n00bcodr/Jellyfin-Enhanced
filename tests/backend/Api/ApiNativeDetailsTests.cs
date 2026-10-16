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
        var ids = new[] { SyntheticId.Movie(693134), SyntheticId.Series(83867), SyntheticId.SeasonOf(83867, 2), SyntheticId.EpisodeOf(83867, 1, 12), SyntheticId.Person(1190668) };
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
     "keywords":[{"id":1,"name":"desert"}],"productionCountries":[{"iso_3166_1":"US","name":"United States of America"}],
     "posterPath":"/poster.jpg","backdropPath":"/back.jpg","imdbId":"tt15239678",
     "credits":{"cast":[{"id":1190668,"name":"Timothée Chalamet","character":"Paul","profilePath":"/p.jpg","order":0}],"crew":[{"id":137427,"name":"Denis Villeneuve","job":"Director","profilePath":null}]},
     "releases":{"results":[{"iso_3166_1":"US","release_dates":[{"type":3,"certification":"PG-13"}]}]},
     "relatedVideos":[{"site":"YouTube","type":"Trailer","key":"abc_DEF-123","name":"Trailer"},{"site":"YouTube","type":"Trailer","key":"bad key\"","name":"Bad"}],
     "mediaInfo":{"requests":[{"requestedBy":{"displayName":"someone else"}}]}}
    """;

    private const string SeriesJson = """
    {"id":83867,"name":"Andor","firstAirDate":"2022-09-21","lastAirDate":"2025-05-13","status":"Ended","episodeRunTime":[45],"voteAverage":8.3,
     "posterPath":"/sp.jpg","backdropPath":"/sb.jpg","externalIds":{"tvdbId":393189,"imdbId":"tt9253284"},
     "contentRatings":{"results":[{"iso_3166_1":"US","rating":"TV-14"}]},"genres":[{"id":1,"name":"Drama"}],
     "seasons":[{"seasonNumber":1,"name":"Season 1","episodeCount":3,"airDate":"2022-09-21","posterPath":"/s1.jpg"},{"seasonNumber":2,"name":"Season 2","episodeCount":12,"airDate":"2025-04-22","posterPath":"/s2.jpg"}],
     "credits":{"cast":[],"crew":[]},"createdBy":[{"id":5,"name":"Tony Gilroy","profilePath":"/tg.jpg"}]}
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
        public Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct) { Calls++; return Task.FromResult(Answer(tmdb == 83867, SeriesJson)); }
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct) { Calls++; return Task.FromResult(SeasonsDown ? SourceAnswer.Unavailable : Answer(tmdb == 83867 && KnownSeasons.Contains(season), SeasonJson.Replace("\"seasonNumber\":1", "\"seasonNumber\":" + season, StringComparison.Ordinal))); }
        public Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct) { Calls++; return Task.FromResult<JsonElement?>(J(Recs)); }
        public Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct) { Calls++; return Task.FromResult<string?>("/logo.png"); }
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
        public IntegrationTransport Images { get; }
        public IntegrationTransport Seerr { get; }
        public NativeDetailsArtwork Artwork { get; private set; } = null!;
        public NativeDetailsPolicy Policy { get; private set; } = null!;
        public NativeDetailsFacadeFilter Filter { get; private set; } = null!;
        public string Rating { get; set; } = "PG-13";
        private readonly string? _stateDir;
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter _parental;
        private readonly Mock<MediaBrowser.Controller.IServerApplicationHost> _host = new();
        private readonly Mock<MediaBrowser.Controller.Configuration.IServerConfigurationManager> _server = new();
        private readonly SpoilerNextUnwatchedService _next;
        private readonly SpoilerFieldStripFilter _strip;
        private readonly SpoilerUserResolver _spoilerUsers;
        /// <summary>Library revision handed to the physical-title reader (null: no cache).</summary>
        public Func<long>? LibraryRevision { get; set; }

        /// <summary>A rig; with <paramref name="stateDir"/> the grant key and session epochs are kept there (restart tests).</summary>
        public Rig(string? stateDir = null)
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
            Images = new IntegrationTransport((req, _) =>
            {
                lock (Hosts) Hosts.Add(req.RequestUri!.Host);
                var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[] { 0xff, 0xd8, 0xff, 1, 2, 3 }) };
                r.Content.Headers.ContentType = new("image/jpeg");
                return Task.FromResult(r);
            });
            Seerr = new IntegrationTransport((req, _) => Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new
            {
                releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = Rating } } } } },
                contentRatings = new { results = new[] { new { iso_3166_1 = "US", rating = Rating } } },
                keywords = Array.Empty<object>(), genres = Array.Empty<object>(),
            }))));
            var localization = new Mock<MediaBrowser.Model.Globalization.ILocalizationManager>();
            localization.Setup(l => l.GetRatingScore("PG-13", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(13, null));
            localization.Setup(l => l.GetRatingScore("TV-14", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(14, null));
            localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
            _server.SetupGet(s => s.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration { MetadataCountryCode = "US" });
            _parental = new Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter(Seerr, Callers.Users.Object, localization.Object, _server.Object, Plugin.Core.Logger);
            _host.SetupGet(h => h.SystemId).Returns(Server);
            // Spoiler Guard as registered (its own library lookups are for collections and watched state only).
            var loose = new Mock<MediaBrowser.Controller.Library.ILibraryManager>();
            _spoilerUsers = new SpoilerUserResolver(Plugin.Core.Manager, loose.Object, Plugin.Core.Logger, null!);
            _next = new SpoilerNextUnwatchedService(loose.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object, Plugin.Core.Logger);
            _strip = new SpoilerFieldStripFilter(_spoilerUsers, loose.Object, Callers.Users.Object, new Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object, _next);
            Restart();
        }

        /// <summary>A server restart: new artwork service, policy and facade (the same users, library and state folder).</summary>
        public void Restart()
        {
            Artwork = new NativeDetailsArtwork(Images, _stateDir);
            Policy = new NativeDetailsPolicy(_parental, Source, Libraries, null, _stateDir, new NativeDetailsLibrary(Library.Object, null, LibraryRevision));
            Filter = new NativeDetailsFacadeFilter(Callers.Users.Object, Library.Object, Dto.Object, _host.Object, _server.Object, Source, Policy, Artwork, _parental, Plugin.Core.Manager, _strip, _spoilerUsers);
        }

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

    /// <summary>Andor in the library: the series, seasons 1 and 2, S1E1 and S1E2. Items in <c>hidden</c> are ones Jellyfin hides from the viewer.</summary>
    private sealed record Shelf(Guid Series, Guid Season1, Guid Season2, Guid Episode1, Guid Episode2, HashSet<Guid> Hidden);

    private static Shelf Library(Rig rig, params User[] viewers)
    {
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), Name = "Andor" };
        var s1 = new MediaBrowser.Controller.Entities.TV.Season { Id = Guid.NewGuid(), IndexNumber = 1, SeriesId = series.Id };
        var s2 = new MediaBrowser.Controller.Entities.TV.Season { Id = Guid.NewGuid(), IndexNumber = 2, SeriesId = series.Id };
        var e1 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = 1, ParentIndexNumber = 1, SeriesId = series.Id };
        var e2 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = 2, ParentIndexNumber = 1, SeriesId = series.Id };
        var hidden = new HashSet<Guid>();
        // Unscoped queries (no user): what the library holds, whoever may see it.
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Series) && q.HasAnyProviderId.ContainsKey("Tmdb") && q.HasAnyProviderId["Tmdb"] == "83867")))
            .Returns(new List<MediaBrowser.Controller.Entities.BaseItem> { series });
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Season) && q.AncestorIds.Contains(series.Id))))
            .Returns(new List<MediaBrowser.Controller.Entities.BaseItem> { s1, s2 });
        rig.Library.Setup(l => l.GetItemList(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Episode) && q.AncestorIds.Contains(s1.Id))))
            .Returns(new List<MediaBrowser.Controller.Entities.BaseItem> { e1, e2 });
        foreach (var viewer in viewers)
        {
            foreach (var item in new MediaBrowser.Controller.Entities.BaseItem[] { series, s1, s2, e1, e2 })
            {
                // Jellyfin's own check for this viewer (rating, custom rating, tags, parents, library access).
                rig.Library.Setup(l => l.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(item.Id, viewer)).Returns(() => hidden.Contains(item.Id) ? null : item);
            }
        }

        return new Shelf(series.Id, s1.Id, s2.Id, e1.Id, e2.Id, hidden);
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
        var episodes = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) })).Result);
        Assert.Equal(new int?[] { 1, 3 }, episodes.Items.Select(i => i.IndexNumber));
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
            Assert.All(list.Items, e => Assert.StartsWith("Season 1, Episode ", e.Name, StringComparison.Ordinal));
            Assert.All(list.Items, e => Assert.False(e.ImageTags?.ContainsKey(ImageType.Primary) == true));
            // Seasons: the first keeps its poster (an entry point, as in the library); later ones don't.
            var seasons = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetSeasons", Me(viewer), new() { ["seriesId"] = series })).Result).Items;
            Assert.True(seasons.Single(x => x.IndexNumber == 1).ImageTags.ContainsKey(ImageType.Primary));
            Assert.False(seasons.Single(x => x.IndexNumber == 2).ImageTags?.ContainsKey(ImageType.Primary) == true);

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
}
#endif
