using System.Collections;
using System.Text.Json;
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
/// The final gate's delivery model: every response value is materialized once, projected, and the projected value is
/// what leaves; library items get the full native rule set whether or not they carry TMDB metadata.
/// Model: item kind x TMDB identity x rule (Jellyfin ID, collection, provider, Hidden Content ID/series) x watched state
/// x response shape x value form (materialized, re-enumerating) x a rule committed while the action runs.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyDeliveryModelTests
{
    /// <summary>A value that builds fresh instances on every enumeration, as 12.2's movie recommendations do.</summary>
    private sealed class Regenerating<T>(Func<T[]> build) : IReadOnlyList<T>
    {
        public int Count => build().Length;
        public T this[int index] => build()[index];
        public IEnumerator<T> GetEnumerator() => ((IEnumerable<T>)build()).GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>Lazy LINQ over a factory: each enumeration runs the factory again.</summary>
    private static IEnumerable<T> Lazy<T>(Func<T[]> build) => new[] { 0 }.SelectMany(_ => build());

    /// <summary>Shape, the native endpoint answering it, and the kinds it can carry.</summary>
    public static readonly (string Shape, string Controller, string Action, string[] Kinds, bool Hc)[] Shapes =
    [
        ("item", "UserLibrary", "GetItem", ["movie", "series", "episode"], false),
        ("query", "Items", "GetItems", ["movie", "series", "episode"], true),
        ("list", "UserLibrary", "GetLatestMedia", ["movie", "series", "episode"], true),
        ("hints", "Search", "GetSearchHints", ["movie", "episode"], true),
        ("recommendations", "Movies", "GetMovieRecommendations", ["movie"], false),
        ("recommendations-items", "Movies", "GetMovieRecommendations", ["movie"], false),
        ("images", "Image", "GetItemImageInfos", ["movie", "episode"], false),
        ("playback", "MediaInfo", "GetPlaybackInfo", ["movie", "episode"], false),
    ];

    public static readonly string[] Rules = ["sg-id", "sg-collection", "sg-provider", "hc-id", "hc-series"];

    public static IEnumerable<object[]> Cells()
    {
        foreach (var (shape, _, _, kinds, hc) in Shapes)
        foreach (var kind in kinds)
        foreach (var tmdb in new[] { true, false })
        foreach (var rule in Rules)
        foreach (var watched in new[] { false, true })
        foreach (var form in shape == "item" ? new[] { "materialized" } : new[] { "materialized", "lazy" })
        {
            if (rule == "sg-collection" && kind != "movie") continue;
            if (rule == "sg-provider" && !tmdb) continue;
            if (rule.StartsWith("hc-", StringComparison.Ordinal) && (!hc || watched)) continue;
            if (rule == "hc-series" && kind != "episode") continue;
            if (watched && (rule != "sg-id" || kind == "series")) continue;
            yield return new object[] { shape, kind, tmdb, rule, watched, form };
        }
    }

    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public Guid User { get; } = Guid.NewGuid();
        public Guid Movie { get; } = Guid.NewGuid();
        public Guid Series { get; } = Guid.NewGuid();
        public Guid Episode { get; } = Guid.NewGuid();
        public Guid Collection { get; } = Guid.NewGuid();
        public Guid Kept { get; } = Guid.NewGuid();
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IUserDataManager> Data { get; } = new();
        public SpoilerFieldStripFilter Strip { get; }
        public SpoilerPresentation Spoilers { get; }
        private readonly SpoilerNextUnwatchedService _next;
        private readonly ILibraryManager? _previous = BaseItem.LibraryManager;
        private readonly bool _tmdb;
        private readonly bool _watched;

        public Rig(bool tmdb, bool watched)
        {
            _tmdb = tmdb; _watched = watched;
            var config = F.Plugin.Configuration;
            config.HiddenContentEnabled = true; config.SpoilerBlurEnabled = true; config.SpoilerReplaceTitle = true;
            config.SpoilerStripOverview = true; config.SpoilerStripSeriesOverview = true;
            Dictionary<string, string> Ids(string id) => tmdb ? new() { ["Tmdb"] = id } : new();
            var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Movie, ProviderIds = Ids("603") };
            var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Series, ProviderIds = Ids("42") };
            var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Episode, SeriesId = Series };
            var collection = new MediaBrowser.Controller.Entities.Movies.BoxSet { Id = Collection, LinkedChildren = [new LinkedChild { ItemId = Movie }] };
            BaseItem? Find(Guid id) => id == Movie ? movie : id == Series ? series : id == Episode ? episode : id == Collection ? collection : null;
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
                .Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Select(Find).OfType<BaseItem>().ToList());
            Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Find(id)!);
            BaseItem.LibraryManager = Library.Object;
            Users.Setup(u => u.GetUserById(User)).Returns(new User("viewer", "default", "default") { Id = User });
            Data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>())).Returns(new UserItemData { Key = "k", Played = watched });
            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), Users.Object,
                new SpoilerIdentityService(Users.Object, F.Core.Logger), F.Core.Logger);
            var resolver = new SpoilerUserResolver(F.Core.Manager, Library.Object, F.Core.Logger, identities);
            _next = new SpoilerNextUnwatchedService(Library.Object, Users.Object, Data.Object, F.Core.Logger);
            Strip = new SpoilerFieldStripFilter(resolver, Library.Object, Users.Object, Data.Object, _next);
            Spoilers = new SpoilerPresentation(F.Core.Manager, Library.Object, Users.Object, Data.Object);
        }

        public Guid Target(string kind) => kind == "movie" ? Movie : kind == "series" ? Series : Episode;

        public BaseItemDto Dto(string kind)
        {
            var ids = _tmdb ? new Dictionary<string, string?> { ["Tmdb"] = kind == "movie" ? "603" : "42" } : new Dictionary<string, string?>();
            var dto = new BaseItemDto { Id = Target(kind), Overview = "Secret plot", UserData = new UserItemDataDto { Key = "k", Played = _watched } };
            switch (kind)
            {
                case "movie": dto.Type = BaseItemKind.Movie; dto.Name = "Movie"; dto.ProviderIds = ids; break;
                case "series": dto.Type = BaseItemKind.Series; dto.Name = "Show"; dto.ProviderIds = ids; break;
                default:
                    dto.Type = BaseItemKind.Episode; dto.Name = "Secret ending"; dto.SeriesId = Series;
                    dto.ParentIndexNumber = 2; dto.IndexNumber = 3; dto.ProviderIds = new Dictionary<string, string?>();
                    break;
            }
            return dto;
        }

        private BaseItemDto KeptDto() => new() { Id = Kept, Type = BaseItemKind.Movie, Name = "Kept" };

        /// <summary>The action's answer; a re-enumerating form builds fresh instances every time it is enumerated.</summary>
        public object Value(string shape, string kind, bool lazy)
        {
            BaseItemDto[] Items() => [Dto(kind), KeptDto()];
            SearchHint[] Hints() =>
            [
                new SearchHint { Id = Target(kind), Type = kind == "movie" ? BaseItemKind.Movie : BaseItemKind.Episode,
                    Name = kind == "movie" ? "Movie" : "Secret ending", ParentIndexNumber = 2, IndexNumber = 3, MatchedTerm = "Secret" },
                new SearchHint { Id = Kept, Type = BaseItemKind.Movie, Name = "Kept" }
            ];
            ImageInfo[] Images() => [new() { ImageType = MediaBrowser.Model.Entities.ImageType.Primary, Path = "/media/Secret plot.jpg" }];
            MediaSourceInfo[] Sources() => [new MediaSourceInfo { Path = "/media/Secret plot.mkv", Name = "Version" }];
            return shape switch
            {
                "item" => Dto(kind),
                "query" => new QueryResult<BaseItemDto>(0, 2, lazy ? new Regenerating<BaseItemDto>(Items) : Items()),
                "list" => lazy ? Lazy(Items) : Items(),
                "hints" => new SearchHintResult(lazy ? new Regenerating<SearchHint>(Hints) : Hints(), 2),
                // 12.2: Select over the recommendation categories, building the wrapper and its DTOs on each enumeration.
                "recommendations" => lazy ? new[] { 0 }.Select(_ => new RecommendationDto { Items = Items() })
                    : new List<RecommendationDto> { new() { Items = Items() } },
                "recommendations-items" => new List<RecommendationDto> { new() { Items = lazy ? new Regenerating<BaseItemDto>(Items) : Items() } },
                "images" => lazy ? Lazy(Images) : Images().ToList(),
                "playback" => new PlaybackInfoResponse { MediaSources = lazy ? new Regenerating<MediaSourceInfo>(Sources) : Sources() },
                _ => throw new ArgumentOutOfRangeException(nameof(shape))
            };
        }

        /// <summary>The rule saved while the action runs.</summary>
        public void Commit(string rule, string kind)
        {
            var id = User.ToString("N");
            if (rule.StartsWith("hc-", StringComparison.Ordinal))
            {
                var target = rule == "hc-series" ? Series : Target(kind);
                F.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent
                {
                    Settings = new() { FilterSearch = true },
                    Items = new() { ["entry"] = new HiddenContentItem { ItemId = target.ToString("D"), Type = rule == "hc-series" ? "Series" : kind switch { "movie" => "Movie", "series" => "Series", _ => "Episode" } } }
                });
                return;
            }
            var state = new UserSpoilerBlur();
            if (rule == "sg-id")
            {
                if (kind == "movie") state.Movies[Movie.ToString("N")] = new();
                else state.Series[Series.ToString("N")] = new();
            }
            else if (rule == "sg-collection") state.Collections[Collection.ToString("N")] = new();
            else state.ProviderTitles[kind == "movie" ? "movie:tmdb:603" : "tv:tmdb:42"] = new();
            F.Core.Manager.SaveUserConfiguration(id, "spoilerblur.json", state);
            SpoilerUserResolver.InvalidateUser(id);
        }

        public void Dispose()
        {
            _next.Dispose();
            SpoilerUserResolver.InvalidateUser(User.ToString("N"));
            BaseItem.LibraryManager = _previous!;
            F.Dispose();
        }
    }

    private static ActionContext Context(Rig rig, string controller, string action, Guid itemId)
    {
        var http = new DefaultHttpContext { User = TestCallers.Principal(rig.User, false) };
        http.Request.Method = "GET";
        http.Request.Path = $"/{controller}/{itemId:N}/{action}";
        var values = new RouteValueDictionary { ["controller"] = controller, ["action"] = action, ["itemId"] = itemId.ToString("N") };
        http.Request.RouteValues = values;
        var descriptor = new ControllerActionDescriptor
        {
            ControllerName = controller, ActionName = action,
            RouteValues = new Dictionary<string, string?> { ["controller"] = controller, ["action"] = action }
        };
        return new ActionContext(http, new RouteData(values), descriptor, new ModelStateDictionary());
    }

    /// <summary>Runs the guarding action filter with the commit inside the action, then the final gate; returns what MVC would serialize.</summary>
    private static async Task<string> Deliver(Rig rig, string shape, string kind, string rule, bool lazy)
    {
        var (_, controller, action, _, _) = Shapes.Single(s => s.Shape == shape);
        var context = Context(rig, controller, action, rig.Target(kind));
        var result = new ObjectResult(rig.Value(shape, kind, lazy));
        var filters = new List<IFilterMetadata>();
        Task<ActionExecutedContext> Run()
        {
            rig.Commit(rule, kind);
            return Task.FromResult(new ActionExecutedContext(context, filters, new object()) { Result = result });
        }
        var executing = new ActionExecutingContext(context, filters, new Dictionary<string, object?>(), new object());
        if (rule.StartsWith("hc-", StringComparison.Ordinal))
            await new HiddenContentResponseFilter(rig.F.Core.Manager, rig.F.Core.Logger, rig.Library.Object).OnActionExecutionAsync(executing, Run);
        else await rig.Strip.OnActionExecutionAsync(executing, Run);
        var delivery = new ResultExecutingContext(context, filters, result, new object());
        new TitlePresentationResultFilter(rig.F.Core.Manager, rig.Spoilers, rig.Library.Object, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), rig.Strip)
            .OnResultExecuting(delivery);
        var delivered = Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value!;
        // Serialization enumerates the delivered value, as MVC's formatter does.
        return JsonSerializer.Serialize(delivered, delivered.GetType());
    }

    [Theory]
    [MemberData(nameof(Cells))]
    public async Task DeliveryAppliesTheFullNativeRuleSetToTheMaterializedValue(string shape, string kind, bool tmdb, string rule, bool watched, string form)
    {
        using var rig = new Rig(tmdb, watched);
        var body = await Deliver(rig, shape, kind, rule, form == "lazy");
        if (rule.StartsWith("hc-", StringComparison.Ordinal))
        {
            Assert.DoesNotContain(rig.Target(kind).ToString(), body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(rig.Target(kind).ToString("N"), body, StringComparison.OrdinalIgnoreCase);
            Assert.Contains(rig.Kept.ToString(), body, StringComparison.OrdinalIgnoreCase);
        }
        else if (watched) Assert.Contains("Secret", body);
        else Assert.DoesNotContain("Secret", body);
    }

    [Fact]
    public void TheModelCoversEveryLazyShapeAndEveryNonTmdbKind()
    {
        var cells = Cells().Select(c => (Shape: (string)c[0], Kind: (string)c[1], Tmdb: (bool)c[2], Rule: (string)c[3], Watched: (bool)c[4], Form: (string)c[5])).ToArray();
        foreach (var shape in Shapes.Where(s => s.Shape != "item"))
            Assert.Contains(cells, c => c.Shape == shape.Shape && c.Form == "lazy" && c.Rule.StartsWith("sg-", StringComparison.Ordinal));
        foreach (var kind in new[] { "movie", "series", "episode" })
            Assert.Contains(cells, c => c.Kind == kind && !c.Tmdb && c.Rule == "sg-id" && !c.Watched);
        Assert.Contains(cells, c => c.Rule == "sg-collection" && !c.Tmdb);
        Assert.Equal(cells.Length, cells.Distinct().Count());
    }
}
