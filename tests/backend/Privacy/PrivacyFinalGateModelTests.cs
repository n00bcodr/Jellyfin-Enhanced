using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// The final presentation gate's model: which responses it guards comes from the matched endpoint's metadata, never
/// from path text, and it re-reads policy at delivery for every response type a guarded endpoint returns.
/// Model: route table x request casing x response type x a policy committed while the action runs.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyFinalGateModelTests
{
    // ---- Request casing: ASP.NET routing is case-insensitive, so every variant reaches the same action. ----
    public static readonly string[] Casings = ["declared", "lower", "upper", "mixed"];

    private static string Cased(string path, string casing) => casing switch
    {
        "lower" => path.ToLowerInvariant(),
        "upper" => path.ToUpperInvariant(),
        "mixed" => string.Concat(path.Select((c, i) => i % 2 == 0 ? char.ToUpperInvariant(c) : char.ToLowerInvariant(c))),
        _ => path
    };

    // ---- JE route table: every guarded route family with a payload the committed policy must change. ----
    private const string Feed = """{"results":[{"key":"movie:tmdb:42","title":"hidden"},{"key":"movie:tmdb:43","overview":"secret"}],"groups":[{"key":"movie:tmdb:42","basedOn":"hidden seed","results":[{"key":"movie:tmdb:43"}]}]}""";
    private const string Parts = """{"parts":[{"key":"movie:tmdb:42","title":"hidden"},{"key":"movie:tmdb:43","overview":"secret"}]}""";
    private const string Reviews = """{"reviews":[{"userId":"u","userName":"Viewer","content":"kept text","rating":9}],"averageRating":9,"totalReviews":1}""";
    private const string RatingMap = """{"ratings":{"tv:42":{"average":4,"count":1},"tv:42:s1:e2":{"average":4,"count":1}}}""";
    private const string Scores = """{"criticsScore":96}""";

    /// <summary>Route family, request path, raw action output, and which policy the in-flight commit installs.</summary>
    public static readonly (string Path, string Raw, string Policy)[] JeRoutes =
    [
        ("native-details/person/9/filmography", Feed, "feed"),
        ("native-details/discover/movie/genre/1", Feed, "feed"),
        ("native-details/title/movie/9/related/similar", Feed, "feed"),
        ("native-details/collection/9", Parts, "feed"),
        ("jellyseerr/discover/movies", Feed, "feed"),
        ("jellyseerr/search", Feed, "feed"),
        ("tmdb/discover/movie", Feed, "feed"),
        ("acquire/discover", Feed, "feed"),
        ("acquire/search", Feed, "feed"),
        ("acquire/hub", Feed, "feed"),
        ("acquire/requests/mine", Feed, "feed"),
        ("arr/requests", Feed, "feed"),
        ("arr/calendar", Feed, "feed"),
        ("native-details/title/tv/83867/ratings", Scores, "scores"),
        ("jellyseerr/tv/83867/ratings", Scores, "scores"),
        ("reviews/tv/42", Reviews, "reviews"),
        ("reviews/tv/42:s1", Reviews, "reviews"),
        ("reviews/tv/42:s1:e2", Reviews, "reviews"),
        ("reviews/ratings", RatingMap, "reviews"),
    ];
    public static readonly string[] JsonTypes = ["content", "file", "object"];

    public static IEnumerable<object[]> JeCells()
        => from route in JeRoutes from casing in Casings from type in JsonTypes select new object[] { route.Path, casing, type };

    private static IActionResult JsonResult(string raw, string type) => type switch
    {
        "content" => new ContentResult { Content = raw, ContentType = "application/json" },
        "file" => new FileContentResult(Encoding.UTF8.GetBytes(raw), "application/json; charset=utf-8"),
        _ => new ObjectResult(JsonNode.Parse(raw)) { StatusCode = 200 }
    };

    private static void Commit(ApiPluginFixture f, Guid user, string policy)
    {
        var config = f.Plugin.Configuration;
        config.HiddenContentEnabled = true; config.SpoilerBlurEnabled = true; config.SpoilerStripOverview = true;
        config.SpoilerStripRatings = true; config.SpoilerStripReviews = false; config.SpoilerReplaceTitle = true;
        var id = user.ToString("N");
        if (policy == "feed")
        {
            f.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent
            { Settings = new() { FilterSearch = true }, Items = new() { ["movie:tmdb:42"] = new() { Type = "Movie", TmdbId = "42" } } });
            f.Core.Manager.SaveUserConfiguration(id, "spoilerblur.json", new UserSpoilerBlur { PendingTmdb = new() { ["movie:43"] = new() } });
        }
        else f.Core.Manager.SaveUserConfiguration(id, "spoilerblur.json",
            new UserSpoilerBlur { ProviderTitles = new() { [policy == "scores" ? "tv:tmdb:83867" : "tv:tmdb:42"] = new() } });
    }

    private static void AssertPolicyApplied(string policy, string? body, string path)
    {
        var json = body == null ? null : JsonNode.Parse(body);
        switch (policy)
        {
            case "feed":
                Assert.DoesNotContain("hidden", body!); Assert.DoesNotContain("secret", body!); break;
            case "scores":
                Assert.True(json == null || json["criticsScore"] == null, body); break;
            case "reviews" when path.EndsWith("ratings", StringComparison.OrdinalIgnoreCase):
                Assert.Null(json!["ratings"]!["tv:42"]); Assert.Null(json["ratings"]!["tv:42:s1:e2"]); break;
            default:
                Assert.Null(json!["reviews"]![0]!["rating"]); Assert.Null(json["averageRating"]);
                Assert.Equal("kept text", json["reviews"]![0]!["content"]!.GetValue<string>()); break;
        }
    }

    [Theory]
    [MemberData(nameof(JeCells))]
    public void JeRouteCellAppliesThePolicyCommittedWhileTheActionRan(string path, string casing, string type)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var (_, raw, policy) = JeRoutes.Single(r => r.Path == path);
        var library = Mock.Of<ILibraryManager>();
        var spoilers = new SpoilerPresentation(f.Core.Manager, library, Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>());
        var action = EndpointRouting.Resolve(Cased("/JellyfinEnhanced/" + path, casing), user);
        Assert.IsType<ControllerActionDescriptor>(action.ActionDescriptor);
        // The action reads the (empty) policy into its request caches, then a commit lands before delivery.
        HiddenContentPolicy.Load(f.Core.Manager, user, action.HttpContext); spoilers.Load(user, action.HttpContext);
        var result = JsonResult(raw, type);
        Commit(f, user, policy);
        var context = new ResultExecutingContext(action, new List<IFilterMetadata>(), result, new object());
        new TitlePresentationResultFilter(f.Core.Manager, spoilers, library, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), null!).OnResultExecuting(context);
        AssertPolicyApplied(policy, Assert.IsType<ContentResult>(context.Result).Content, path);
    }

    // ---- Every JE endpoint: the guarded decision is a property of the endpoint, identical for every casing. ----
    private static string SamplePath(string template)
    {
        var path = Regex.Replace(template, @"\{(\*{0,2})([^}:=?]+)[^}]*\}", m =>
        {
            var name = m.Groups[2].Value;
            if (m.Groups[1].Value.Length > 0) return "tv/42/season/1";
            if (name.Contains("tmdb", StringComparison.OrdinalIgnoreCase)) return "42";
            if (name is "mediaType" or "type") return "tv";
            if (name is "relation") return "similar";
            if (name is "season" or "seasonNumber") return "1";
            if (name.EndsWith("Id", StringComparison.Ordinal) || name.EndsWith("id", StringComparison.Ordinal)) return "1";
            return "x1";
        });
        return "/" + path;
    }

    /// <summary>Observable on every build: the gate withholds If-None-Match from the action only on routes it guards.</summary>
    private static bool Guarded(string path, string method = "GET")
    {
        var action = EndpointRouting.Resolve(path, Guid.NewGuid(), method);
        action.HttpContext.Request.Headers.IfNoneMatch = "\"probe\"";
        var context = new ResourceExecutingContext(action, new List<IFilterMetadata>(), new List<IValueProviderFactory>());
        new TitlePresentationResultFilter(null!, null!, null!, null!, null!).OnResourceExecuting(context);
        return string.IsNullOrEmpty(action.HttpContext.Request.Headers.IfNoneMatch.ToString());
    }

    private static IEnumerable<(string Template, string Path)> ReadEndpoints()
        => EndpointRouting.Actions()
            .Where(a => a.EndpointMetadata.OfType<Microsoft.AspNetCore.Routing.HttpMethodMetadata>().Any(m => m.HttpMethods.Contains("GET")))
            .Select(a => (a.AttributeRouteInfo!.Template!, SamplePath(a.AttributeRouteInfo!.Template!)))
            .Distinct().OrderBy(e => e.Item1, StringComparer.Ordinal);

    /// <summary>The guarded route inventory. A new guarded endpoint must be added here deliberately.</summary>
    public static readonly string[] GuardedTemplates =
    [
        "JellyfinEnhanced/acquire/discover",
        "JellyfinEnhanced/acquire/hub",
        "JellyfinEnhanced/acquire/notify/inbox",
        "JellyfinEnhanced/acquire/requests",
        "JellyfinEnhanced/acquire/requests/approvals",
        "JellyfinEnhanced/acquire/requests/mine",
        "JellyfinEnhanced/acquire/requests/season/{itemId}",
        "JellyfinEnhanced/acquire/search",
        "JellyfinEnhanced/acquire/status",
        "JellyfinEnhanced/acquire/status/item/{itemId}",
        "JellyfinEnhanced/activity",
        "JellyfinEnhanced/arr/calendar",
        "JellyfinEnhanced/arr/requests",
        "JellyfinEnhanced/awards/{mediaType}/{tmdbId}",
        "JellyfinEnhanced/jellyseerr/collection/{collectionId}",
        "JellyfinEnhanced/jellyseerr/discover/genreslider/movie",
        "JellyfinEnhanced/jellyseerr/discover/genreslider/tv",
        "JellyfinEnhanced/jellyseerr/discover/movies",
        "JellyfinEnhanced/jellyseerr/discover/movies/genre/{genreId}",
        "JellyfinEnhanced/jellyseerr/discover/movies/keyword/{keywordId}",
        "JellyfinEnhanced/jellyseerr/discover/movies/studio/{studioId}",
        "JellyfinEnhanced/jellyseerr/discover/movies/upcoming",
        "JellyfinEnhanced/jellyseerr/discover/trending",
        "JellyfinEnhanced/jellyseerr/discover/tv",
        "JellyfinEnhanced/jellyseerr/discover/tv/genre/{genreId}",
        "JellyfinEnhanced/jellyseerr/discover/tv/keyword/{keywordId}",
        "JellyfinEnhanced/jellyseerr/discover/tv/network/{networkId}",
        "JellyfinEnhanced/jellyseerr/discover/tv/studio/{studioId}",
        "JellyfinEnhanced/jellyseerr/discover/tv/upcoming",
        "JellyfinEnhanced/jellyseerr/issue",
        "JellyfinEnhanced/jellyseerr/issue/{id}",
        "JellyfinEnhanced/jellyseerr/movie-collections",
        "JellyfinEnhanced/jellyseerr/movie/{tmdbId}",
        "JellyfinEnhanced/jellyseerr/movie/{tmdbId}/ratingscombined",
        "JellyfinEnhanced/jellyseerr/movie/{tmdbId}/recommendations",
        "JellyfinEnhanced/jellyseerr/movie/{tmdbId}/similar",
        "JellyfinEnhanced/jellyseerr/overrideRule",
        "JellyfinEnhanced/jellyseerr/permission-audit",
        "JellyfinEnhanced/jellyseerr/person/{personId}",
        "JellyfinEnhanced/jellyseerr/person/{personId}/combined_credits",
        "JellyfinEnhanced/jellyseerr/quota",
        "JellyfinEnhanced/jellyseerr/radarr",
        "JellyfinEnhanced/jellyseerr/request",
        "JellyfinEnhanced/jellyseerr/search",
        "JellyfinEnhanced/jellyseerr/settings/partial-requests",
        "JellyfinEnhanced/jellyseerr/settings/{type}",
        "JellyfinEnhanced/jellyseerr/sonarr",
        "JellyfinEnhanced/jellyseerr/sonarr/lookup/{tmdbId}",
        "JellyfinEnhanced/jellyseerr/status",
        "JellyfinEnhanced/jellyseerr/tv/{tmdbId}",
        "JellyfinEnhanced/jellyseerr/tv/{tmdbId}/ratings",
        "JellyfinEnhanced/jellyseerr/tv/{tmdbId}/recommendations",
        "JellyfinEnhanced/jellyseerr/tv/{tmdbId}/season/{seasonNumber}",
        "JellyfinEnhanced/jellyseerr/tv/{tmdbId}/similar",
        "JellyfinEnhanced/jellyseerr/{type}/{serverId}",
        "JellyfinEnhanced/jellyseerr/user",
        "JellyfinEnhanced/jellyseerr/user-status",
        "JellyfinEnhanced/jellyseerr/validate",
        "JellyfinEnhanced/jellyseerr/watchlist",
        "JellyfinEnhanced/mdblist-ratings/account-status",
        "JellyfinEnhanced/mdblist-ratings/{mediaType}/{tmdbId}",
        "JellyfinEnhanced/native-details/collection/{collectionId}",
        "JellyfinEnhanced/native-details/discover/{type}/{source}/{feedId}",
        "JellyfinEnhanced/native-details/person/{tmdbId}/filmography",
        "JellyfinEnhanced/native-details/title/tv/{tmdbId}/season/{season}",
        "JellyfinEnhanced/native-details/title/{type}/{tmdbId}",
        "JellyfinEnhanced/native-details/title/{type}/{tmdbId}/ratings",
        "JellyfinEnhanced/native-details/title/{type}/{tmdbId}/related/{relation}",
        "JellyfinEnhanced/reviews/admin/all",
        "JellyfinEnhanced/reviews/{mediaType}/{tmdbId}",
        "JellyfinEnhanced/reviews/ratings",
        "JellyfinEnhanced/tmdb/{**apiPath}",
        "JellyfinEnhanced/tmdb/search/keyword",
        "JellyfinEnhanced/tmdb/search/person",
        "JellyfinEnhanced/tmdb/validate",
    ];

    [Fact]
    public void EveryJeEndpointIsGuardedIdenticallyForEveryCasingAndTheGuardedSetIsPinned()
    {
        var guarded = new List<string>();
        var drift = new List<string>();
        foreach (var (template, path) in ReadEndpoints())
        {
            var declared = Guarded(path);
            if (declared) guarded.Add(template);
            foreach (var casing in Casings.Skip(1))
                if (Guarded(Cased(path, casing)) != declared) drift.Add($"{casing} {Cased(path, casing)} (declared {declared})");
        }
        Assert.True(drift.Count == 0, "classification depends on path text:\n" + string.Join("\n", drift));
        var actual = guarded.Order(StringComparer.Ordinal).ToArray();
        // The native details controller (and its resolve route) is compiled for Jellyfin 12 only.
        var expected = typeof(Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController).Assembly
            .GetType("Jellyfin.Plugin.JellyfinEnhanced.Controllers.NativeDetailsController") == null
            ? GuardedTemplates : GuardedTemplates.Append("JellyfinEnhanced/native-details/resolve");
        Assert.True(expected.Order(StringComparer.Ordinal).SequenceEqual(actual), "guarded templates:\n" + string.Join("\n", actual));
    }

    [Theory]
    [InlineData("/JellyfinEnhanced/AWARDS")]
    [InlineData("/JellyfinEnhanced/reviews")]
    [InlineData("/JellyfinEnhanced/Jellyseerr")]
    public void AParameterInTheRouteFamilyPositionIsNeverAGuardedRoute(string path)
        => Assert.False(Guarded(path));

    // ---- The three r13 scenarios. ----
    [Theory]
    [InlineData("/JellyfinEnhanced/Reviews/tv/42:s1:e2")]
    [InlineData("/jellyfinenhanced/REVIEWS/TV/42:s1:e2")]
    [InlineData("/JELLYFINENHANCED/Reviews/Tv/42")]
    public void MixedCaseReviewRoutesKeepRatingsSuppressed(string path)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = PrivacyOperationalProjectionTests.Guard(f, user, "tv:tmdb:42");
        f.Plugin.Configuration.SpoilerStripReviews = false;
        var context = new ResultExecutingContext(EndpointRouting.Resolve(path, user), new List<IFilterMetadata>(),
            new ContentResult { Content = Reviews, ContentType = "application/json" }, new object());
        new TitlePresentationResultFilter(f.Core.Manager, spoilers, Mock.Of<ILibraryManager>(), Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), null!).OnResultExecuting(context);
        var json = JsonNode.Parse(Assert.IsType<ContentResult>(context.Result).Content!)!;
        Assert.Null(json["reviews"]![0]!["rating"]); Assert.Null(json["averageRating"]);
    }

    // ---- Native guarded endpoints: host-verified return shapes (Jellyfin.Api 12.2 and 10.11.11 agree). ----
    /// <summary>Controller, action, verb, return shape, and whether Hidden Content and/or Spoiler Guard guard it.</summary>
    public static readonly (string Controller, string Action, string Method, string Shape, bool Hc, bool Sg)[] NativeEndpoints =
    [
        ("Items", "GetItems", "GET", "query", true, true),
        ("Items", "GetItemsByUserIdLegacy", "GET", "query", true, true),
        ("Items", "GetResumeItems", "GET", "query", true, true),
        ("Items", "GetResumeItemsLegacy", "GET", "query", true, true),
        ("UserLibrary", "GetItem", "GET", "item", false, true),
        ("UserLibrary", "GetItemLegacy", "GET", "item", false, true),
        ("UserLibrary", "GetLatestMedia", "GET", "list", true, true),
        ("UserLibrary", "GetLatestMediaLegacy", "GET", "list", true, true),
        ("UserLibrary", "GetIntros", "GET", "query", false, true),
        ("UserLibrary", "GetIntrosLegacy", "GET", "query", false, true),
        ("UserLibrary", "GetLocalTrailers", "GET", "list", false, true),
        ("UserLibrary", "GetLocalTrailersLegacy", "GET", "list", false, true),
        ("UserLibrary", "GetSpecialFeatures", "GET", "list", false, true),
        ("UserLibrary", "GetSpecialFeaturesLegacy", "GET", "list", false, true),
        ("TvShows", "GetEpisodes", "GET", "query", true, true),
        ("TvShows", "GetSeasons", "GET", "query", true, true),
        ("TvShows", "GetNextUp", "GET", "query", true, true),
        ("TvShows", "GetUpcomingEpisodes", "GET", "query", true, true),
        ("Suggestions", "GetSuggestions", "GET", "query", true, true),
        ("Suggestions", "GetSuggestionsLegacy", "GET", "query", true, true),
        ("Search", "GetSearchHints", "GET", "hints", true, true),
        ("Library", "GetSimilarItems", "GET", "query", true, true),
        ("Image", "GetItemImageInfos", "GET", "images", false, true),
        ("MediaInfo", "GetPlaybackInfo", "GET", "playback", false, true),
        ("MediaInfo", "GetPostedPlaybackInfo", "POST", "playback", false, true),
        ("Movies", "GetMovieRecommendations", "GET", "recommendations", false, true),
        ("Playlists", "GetPlaylistItems", "GET", "query", false, true),
        ("HomeScreen", "GetSectionContent", "GET", "query", true, false),
    ];

    public static IEnumerable<object[]> NativeCells()
        => from e in NativeEndpoints from policy in new[] { "hc", "sg" } where policy == "hc" ? e.Hc : e.Sg
           from casing in Casings select new object[] { e.Controller, e.Action, policy, casing };

    private sealed class NativeRig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public Guid User { get; } = Guid.NewGuid();
        public Guid Series { get; } = Guid.NewGuid();
        public Guid Episode { get; } = Guid.NewGuid();
        public Guid Kept { get; } = Guid.NewGuid();
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IUserDataManager> Data { get; } = new();
        public SpoilerFieldStripFilter Strip { get; }
        public SpoilerPresentation Spoilers { get; }
        private readonly SpoilerNextUnwatchedService _next;

        public NativeRig()
        {
            var config = F.Plugin.Configuration;
            config.HiddenContentEnabled = true; config.SpoilerBlurEnabled = true; config.SpoilerReplaceTitle = true; config.SpoilerStripOverview = true;
            var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Series, ProviderIds = new() { ["Tmdb"] = "42" } };
            var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Episode, SeriesId = Series };
            BaseItem? Find(Guid id) => id == Series ? series : id == Episode ? episode : null;
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
                .Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Select(Find).OfType<BaseItem>().ToList());
            Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Find(id)!);
            Users.Setup(u => u.GetUserById(User)).Returns(new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = User });
            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), Users.Object,
                new SpoilerIdentityService(Users.Object, F.Core.Logger), F.Core.Logger);
            var resolver = new SpoilerUserResolver(F.Core.Manager, Library.Object, F.Core.Logger, identities);
            _next = new SpoilerNextUnwatchedService(Library.Object, Users.Object, Data.Object, F.Core.Logger);
            Strip = new SpoilerFieldStripFilter(resolver, Library.Object, Users.Object, Data.Object, _next);
            Spoilers = new SpoilerPresentation(F.Core.Manager, Library.Object, Users.Object, Data.Object);
        }

        public BaseItemDto EpisodeDto() => new()
        {
            Id = Episode, SeriesId = Series, Type = BaseItemKind.Episode, Name = "Secret ending", Overview = "Secret plot",
            ParentIndexNumber = 2, IndexNumber = 3, UserData = new UserItemDataDto { Key = "e", Played = false }
        };

        /// <summary>The action's answer for a shape, holding the item the in-flight commit hides or guards.</summary>
        public object Value(string shape) => shape switch
        {
            "item" => EpisodeDto(),
            "query" => new QueryResult<BaseItemDto>(0, 2, new[] { EpisodeDto(), new BaseItemDto { Id = Kept, Type = BaseItemKind.Movie, Name = "Kept" } }),
            "list" => new[] { EpisodeDto(), new BaseItemDto { Id = Kept, Type = BaseItemKind.Movie, Name = "Kept" } }.Select(d => d),
            "hints" => new SearchHintResult(new[]
            {
                new SearchHint { Id = Episode, Type = BaseItemKind.Episode, Name = "Secret ending", ParentIndexNumber = 2, IndexNumber = 3, MatchedTerm = "Secret" },
                new SearchHint { Id = Kept, Type = BaseItemKind.Movie, Name = "Kept" }
            }, 2),
            "images" => new List<ImageInfo> { new() { ImageType = MediaBrowser.Model.Entities.ImageType.Primary, Path = "/media/Secret ending.jpg" } },
            "playback" => new PlaybackInfoResponse { MediaSources = new[] { new MediaSourceInfo { Path = "/media/Secret ending.mkv", Name = "Secret ending" } } },
            "recommendations" => new List<RecommendationDto> { new() { Items = new[] { EpisodeDto() } } },
            _ => throw new ArgumentOutOfRangeException(nameof(shape))
        };

        public void CommitHide()
        {
            F.Core.Manager.SaveUserConfiguration(User.ToString("N"), "hidden-content.json", new UserHiddenContent
            {
                Settings = new() { FilterSearch = true },
                Items = new() { ["entry"] = new HiddenContentItem { ItemId = Episode.ToString("D"), Type = "Episode" } }
            });
            HiddenContentResponseFilter.InvalidateUser(User.ToString("N"));
        }

        public void CommitGuard()
        {
            var state = new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } };
            state.Series[Series.ToString("N")] = new();
            F.Core.Manager.SaveUserConfiguration(User.ToString("N"), "spoilerblur.json", state);
            SpoilerUserResolver.InvalidateUser(User.ToString("N"));
        }

        public void Dispose() { _next.Dispose(); SpoilerUserResolver.InvalidateUser(User.ToString("N")); F.Dispose(); }
    }

    /// <summary>The host binds the controller/action of the matched endpoint; the request path's text plays no part.</summary>
    private static ActionContext NativeContext(NativeRig rig, string controller, string action, string method, string casing)
    {
        var http = new DefaultHttpContext { User = TestCallers.Principal(rig.User, false) };
        http.Request.Method = method;
        http.Request.Path = Cased($"/{controller}/{rig.Episode:N}/{action}", casing);
        var values = new RouteValueDictionary { ["controller"] = controller, ["action"] = action, ["itemId"] = rig.Episode.ToString("N") };
        http.Request.RouteValues = values;
        var descriptor = new ControllerActionDescriptor
        {
            ControllerName = controller, ActionName = action,
            RouteValues = new Dictionary<string, string?> { ["controller"] = controller, ["action"] = action }
        };
        return new ActionContext(http, new RouteData(values), descriptor, new ModelStateDictionary());
    }

    [Theory]
    [MemberData(nameof(NativeCells))]
    public async Task NativeCellDeliversThePolicyCommittedWhileTheActionRan(string controller, string action, string policy, string casing)
    {
        using var rig = new NativeRig();
        var endpoint = NativeEndpoints.Single(e => e.Controller == controller && e.Action == action);
        var context = NativeContext(rig, controller, action, endpoint.Method, casing);
        var result = new ObjectResult(rig.Value(endpoint.Shape));
        var filters = new List<IFilterMetadata>();
        // The action filters read the policy at the start of the action; the commit lands while the action runs.
        Task<ActionExecutedContext> Run()
        {
            if (policy == "hc") rig.CommitHide(); else rig.CommitGuard();
            return Task.FromResult(new ActionExecutedContext(context, filters, new object()) { Result = result });
        }
        var executing = new ActionExecutingContext(context, filters, new Dictionary<string, object?>(), new object());
        if (policy == "hc") await new HiddenContentResponseFilter(rig.F.Core.Manager, rig.F.Core.Logger).OnActionExecutionAsync(executing, Run);
        else await rig.Strip.OnActionExecutionAsync(executing, Run);
        var delivery = new ResultExecutingContext(context, filters, result, new object());
        new TitlePresentationResultFilter(rig.F.Core.Manager, rig.Spoilers, rig.Library.Object, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), rig.Strip)
            .OnResultExecuting(delivery);
        var delivered = Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value;
        var body = JsonSerializer.Serialize(delivered, delivered!.GetType());
        if (policy == "hc")
        {
            Assert.DoesNotContain(rig.Episode.ToString(), body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(rig.Episode.ToString("N"), body, StringComparison.OrdinalIgnoreCase);
            Assert.Contains(rig.Kept.ToString(), body, StringComparison.OrdinalIgnoreCase);
        }
        else Assert.DoesNotContain("Secret", body);
    }

    [Fact]
    public void TheNativeModelCoversEveryHostReturnShapeAndBothFilterTables()
    {
        Assert.Equal(new[] { "hints", "images", "item", "list", "playback", "query", "recommendations" },
            NativeEndpoints.Select(e => e.Shape).Distinct().Order(StringComparer.Ordinal));
        Assert.Equal(15, NativeEndpoints.Count(e => e.Hc));
        Assert.Equal(27, NativeEndpoints.Count(e => e.Sg));
    }
}
