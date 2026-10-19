using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using User = Jellyfin.Database.Implementations.Entities.User;
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
/// Review round 15's scenarios at the final delivery gate: an unclassified endpoint's titles, movie recommendations and
/// their seeds, activity rows of a series guarded by Jellyfin ID, and a guarded collection's member on provider JSON.
/// Uses only the gate's public surface, so the same file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound15Tests
{
    // ---- The rig shared by the gate scenarios. ----

    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public Guid User { get; } = Guid.NewGuid();
        public Dictionary<Guid, BaseItem> Items { get; } = new();
        public HashSet<Guid> Played { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public SpoilerFieldStripFilter Strip { get; }
        public SpoilerPresentation Spoilers { get; }
        private readonly SpoilerNextUnwatchedService _next;
        private readonly ILibraryManager? _previous = BaseItem.LibraryManager;

        public Rig()
        {
            var config = F.Plugin.Configuration;
            config.HiddenContentEnabled = true; config.SpoilerBlurEnabled = true; config.SpoilerReplaceTitle = true; config.SpoilerStripOverview = true;
            config.SpoilerStripSeriesOverview = true; config.SpoilerStripRatings = true; config.SpoilerStripReviews = true; config.SpoilerKeepMoviePosters = false;
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
                .Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Select(id => Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList());
            Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.GetValueOrDefault(id)!);
            BaseItem.LibraryManager = Library.Object;
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(User)).Returns(new User("viewer", "default", "default") { Id = User });
            var data = new Mock<IUserDataManager>();
            data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>()))
                .Returns((User _, BaseItem item) => new UserItemData { Key = "k", Played = Played.Contains(item.Id) });
            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), users.Object, new SpoilerIdentityService(users.Object, F.Core.Logger), F.Core.Logger);
            var resolver = new SpoilerUserResolver(F.Core.Manager, Library.Object, F.Core.Logger, identities);
            _next = new SpoilerNextUnwatchedService(Library.Object, users.Object, data.Object, F.Core.Logger);
            Strip = new SpoilerFieldStripFilter(resolver, Library.Object, users.Object, data.Object, _next);
            Spoilers = new SpoilerPresentation(F.Core.Manager, Library.Object, users.Object, data.Object);
        }

        public T Add<T>(T item) where T : BaseItem { if (item.Id == Guid.Empty) item.Id = Guid.NewGuid(); Items[item.Id] = item; return item; }

        public void Hide(params Guid[] ids) => F.Core.Manager.SaveUserConfiguration(User.ToString("N"), "hidden-content.json", new UserHiddenContent
        { Items = ids.ToDictionary(id => id.ToString("N"), id => new HiddenContentItem { ItemId = id.ToString("D"), Type = Items[id] is MediaBrowser.Controller.Entities.TV.Series ? "Series" : "Movie" }) });

        public void Guard(UserSpoilerBlur state)
        {
            F.Core.Manager.SaveUserConfiguration(User.ToString("N"), "spoilerblur.json", state);
            SpoilerUserResolver.InvalidateUser(User.ToString("N"));
        }

        public TitlePresentationResultFilter Gate(MediaBrowser.Controller.IServerApplicationHost? host = null)
            => new(F.Core.Manager, Spoilers, Library.Object, host ?? Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), Strip);

        public ActionContext Native(string controller, string action, string method = "GET", System.Reflection.TypeInfo? type = null)
        {
            var http = new DefaultHttpContext { User = TestCallers.Principal(User, false) };
            http.Request.Method = method;
            var values = new RouteValueDictionary { ["controller"] = controller, ["action"] = action };
            http.Request.RouteValues = values;
            var descriptor = new ControllerActionDescriptor
            {
                ControllerName = controller, ActionName = action, DisplayName = controller + "." + action,
                ControllerTypeInfo = type ?? typeof(Microsoft.AspNetCore.Mvc.ControllerBase).GetTypeInfo(),
                RouteValues = new Dictionary<string, string?> { ["controller"] = controller, ["action"] = action }
            };
            return new ActionContext(http, new RouteData(values), descriptor, new ModelStateDictionary());
        }

        public IActionResult Deliver(ActionContext context, IActionResult result)
        {
            var delivery = new ResultExecutingContext(context, new List<IFilterMetadata>(), result, new object());
            Gate().OnResultExecuting(delivery);
            return delivery.Result;
        }

        public void Dispose()
        {
            _next.Dispose();
            SpoilerUserResolver.InvalidateUser(User.ToString("N"));
            BaseItem.LibraryManager = _previous!;
            F.Dispose();
        }
    }

    private static BaseItemDto Dto(BaseItem item) => new()
    {
        Id = item.Id, Name = item.Name, Overview = "Secret plot " + item.Name,
        Type = item is MediaBrowser.Controller.Entities.TV.Episode ? BaseItemKind.Episode : BaseItemKind.Movie,
        UserData = new UserItemDataDto { Key = "k", Played = false }
    };

    // ---- An endpoint the registry doesn't classify. ----

    [Fact]
    public void AnUnclassifiedTitleAnswerIsWithheldWhileAnyPolicyAppliesAndDeliveredOtherwise()
    {
        using var rig = new Rig();
        var movie = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Movie" });
        var other = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Other" });
        QueryResult<BaseItemDto> Answer() => new(0, 1, [Dto(movie)]);
        Assert.IsType<ObjectResult>(rig.Deliver(rig.Native("Future", "GetThings"), new ObjectResult(Answer())));
        rig.Hide(other.Id);
        Assert.Equal(503, Assert.IsType<StatusCodeResult>(rig.Deliver(rig.Native("Future", "GetThings"), new ObjectResult(Answer()))).StatusCode);
        // An answer without titles is never withheld.
        Assert.IsType<ObjectResult>(rig.Deliver(rig.Native("Future", "GetThings"), new ObjectResult(new UserItemDataDto { Key = "k" })));
        // Spoiler Guard alone also withholds.
        rig.Hide();
        rig.Guard(new UserSpoilerBlur { Movies = { [other.Id.ToString("N")] = new() } });
        Assert.Equal(503, Assert.IsType<StatusCodeResult>(rig.Deliver(rig.Native("Plugin", "GetRows", "POST"), new ObjectResult(Answer()))).StatusCode);
        // A registered endpoint with the same answer is projected, not withheld.
        Assert.IsType<ObjectResult>(rig.Deliver(rig.Native("Items", "GetItems"), new ObjectResult(Answer())));
    }

    // ---- D46-SEC-R15-2: movie recommendations. ----

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MovieRecommendationsHideHiddenTitlesAndDropCategoriesSeededByHiddenOrGuardedTitles(bool lazy)
    {
        using var rig = new Rig();
        var hidden = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Hidden" });
        var shown = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Shown" });
        var guardedSeed = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Guarded seed" });
        var watchedSeed = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Watched seed" });
        rig.Played.Add(watchedSeed.Id);
        rig.Hide(hidden.Id);
        rig.Guard(new UserSpoilerBlur { Movies = { [guardedSeed.Id.ToString("N")] = new(), [watchedSeed.Id.ToString("N")] = new() } });
        RecommendationDto Category(RecommendationType type, string name, Guid seed) => new()
        { RecommendationType = type, BaselineItemName = name, CategoryId = seed, Items = [Dto(hidden), Dto(shown)] };
        RecommendationDto[] Build() =>
        [
            Category(RecommendationType.SimilarToLikedItem, "Hidden", hidden.Id),
            Category(RecommendationType.SimilarToLikedItem, "Guarded seed", guardedSeed.Id),
            Category(RecommendationType.SimilarToRecentlyPlayed, "Watched seed", watchedSeed.Id),
            Category(RecommendationType.HasActorFromRecentlyPlayed, "An actor", Guid.NewGuid()),
        ];
        object value = lazy ? new[] { 0 }.SelectMany(_ => Build()) : Build().ToList();
        var delivered = Assert.IsAssignableFrom<IEnumerable<RecommendationDto>>(
            Assert.IsType<ObjectResult>(rig.Deliver(rig.Native("Movies", "GetMovieRecommendations"), new ObjectResult(value))).Value).ToArray();
        Assert.Equal(new[] { "Watched seed", "An actor" }, delivered.Select(c => c.BaselineItemName));
        foreach (var category in delivered) Assert.Equal(new[] { shown.Id }, category.Items.Select(i => i.Id));
    }

    // ---- D46-SEC-R15-3: activity rows by Jellyfin ID. ----

    [Fact]
    public void ActivityRowsOfAJellyfinIdGuardedSeriesWithoutTmdbStripAnUnwatchedEpisodeOnly()
    {
        using var rig = new Rig();
        var series = rig.Add(new MediaBrowser.Controller.Entities.TV.Series { Name = "Show" });
        var unwatched = rig.Add(new MediaBrowser.Controller.Entities.TV.Episode { Name = "Secret ending", SeriesId = series.Id, IndexNumber = 3, ParentIndexNumber = 2 });
        var watched = rig.Add(new MediaBrowser.Controller.Entities.TV.Episode { Name = "Seen pilot", SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1 });
        rig.Played.Add(watched.Id);
        rig.Guard(new UserSpoilerBlur { Series = { [series.Id.ToString("N")] = new() } });
        string Row(Guid id, string name) => $$$"""{"activityType":"Reviewed","userId":"u","userName":"Viewer","timestamp":1,"content":"review of {{{name}}}","rating":9,"item":{"id":"{{{id:N}}}","name":"{{{name}}}","type":"Episode","hasPrimaryImage":true,"hasThumbImage":true}}""";
        var raw = "{\"items\":[" + Row(unwatched.Id, "Secret ending") + "," + Row(watched.Id, "Seen pilot") + "]}";
        var context = EndpointRouting.Resolve("/JellyfinEnhanced/activity", rig.User);
        var body = Assert.IsType<ContentResult>(rig.Deliver(context, new ObjectResult(JsonNode.Parse(raw)) { StatusCode = 200 })).Content!;
        var rows = JsonNode.Parse(body)!["items"]!.AsArray();
        var guarded = rows.Single(r => r!["item"]!["id"]!.GetValue<string>() == unwatched.Id.ToString("N"))!;
        Assert.Null(guarded["item"]!["name"]); Assert.Null(guarded["content"]); Assert.Null(guarded["rating"]);
        Assert.False(guarded["item"]!["hasPrimaryImage"]!.GetValue<bool>()); Assert.False(guarded["item"]!["hasThumbImage"]!.GetValue<bool>());
        var seen = rows.Single(r => r!["item"]!["id"]!.GetValue<string>() == watched.Id.ToString("N"))!;
        Assert.Equal("Seen pilot", seen["item"]!["name"]!.GetValue<string>()); Assert.Equal("review of Seen pilot", seen["content"]!.GetValue<string>());
        Assert.True(seen["item"]!["hasPrimaryImage"]!.GetValue<bool>());
    }

    // ---- D46-SEC-R15-4: a guarded collection's member on provider JSON. ----

    [Fact]
    public void ProviderJsonOfAMemberOfAGuardedCollectionIsGuardedByLinkedChildren()
    {
        using var rig = new Rig();
        var member = rig.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "Part two", ProviderIds = new() { ["Tmdb"] = "604" } });
        var set = rig.Add(new MediaBrowser.Controller.Entities.Movies.BoxSet { Name = "Saga", LinkedChildren = [new LinkedChild { ItemId = member.Id }] });
        rig.Guard(new UserSpoilerBlur { Collections = { [set.Id.ToString("N")] = new() } });
        var context = EndpointRouting.Resolve("/JellyfinEnhanced/tmdb/movie/604", rig.User);
        var raw = """{"id":604,"title":"Part two","overview":"Secret plot","vote_average":8.1,"vote_count":12}""";
        var body = JsonNode.Parse(Assert.IsType<ContentResult>(rig.Deliver(context, new ContentResult { Content = raw, ContentType = "application/json" })).Content!)!;
        Assert.Null(body["overview"]); Assert.Null(body["vote_average"]); Assert.Null(body["vote_count"]);
        Assert.True(body["jeSpoiler"]!["guarded"]!.GetValue<bool>());
        // Watching it releases the guard (the viewer's watched state is part of the identity).
        rig.Played.Add(member.Id);
        var again = JsonNode.Parse(Assert.IsType<ContentResult>(rig.Deliver(EndpointRouting.Resolve("/JellyfinEnhanced/tmdb/movie/604", rig.User),
            new ContentResult { Content = raw, ContentType = "application/json" })).Content!)!;
        Assert.Equal("Secret plot", again["overview"]!.GetValue<string>());
    }
}
