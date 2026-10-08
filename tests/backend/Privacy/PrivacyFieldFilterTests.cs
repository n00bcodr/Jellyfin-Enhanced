using System.Security.Claims;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyFieldFilterTests
{
    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Guid User { get; } = Guid.NewGuid();
        public Guid Series { get; } = Guid.NewGuid();
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IUserDataManager> Data { get; } = new();
        private readonly SpoilerNextUnwatchedService next;
        private readonly SpoilerFieldStripFilter filter;
        public Fixture()
        {
            Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), Users.Object,
                new SpoilerIdentityService(Users.Object, Plugin.Core.Logger), Plugin.Core.Logger);
            var resolver = new SpoilerUserResolver(Plugin.Core.Manager, Library.Object, Plugin.Core.Logger, identities);
            next = new SpoilerNextUnwatchedService(Library.Object, Users.Object, Data.Object, Plugin.Core.Logger);
            filter = new SpoilerFieldStripFilter(resolver, Library.Object, Users.Object, Data.Object, next);
            var state = new UserSpoilerBlur();
            state.Series[Series.ToString("N")] = new();
            Save(state);
        }
        // The production save path drops the resolver's cached state itself (see the test below).
        public void Save(UserSpoilerBlur state) => Plugin.Core.Manager.SaveUserConfiguration(User.ToString("N"), "spoilerblur.json", state);
        public BaseItemDto Episode(bool played = false) => new()
        {
            Id = Guid.NewGuid(), SeriesId = Series, Type = BaseItemKind.Episode,
            Name = "Secret ending", Overview = "Secret plot", OriginalTitle = "Secret original", Path = "/Secret.mkv",
            ParentIndexNumber = 2, IndexNumber = 3, UserData = new UserItemDataDto { Key = "test", Played = played },
            Tags = ["Secret tag"], CommunityRating = 9, CriticRating = 80, SortName = "Secret sort",
        };
        public async Task<object?> Invoke(object value, string controller = "Items", string action = "GetItems", Guid? user = null)
        {
            var http = new DefaultHttpContext();
            http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", (user ?? User).ToString())], "Test"));
            var descriptor = new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = controller, ["action"] = action } };
            var context = new ActionContext(http, new RouteData(), descriptor, new ModelStateDictionary());
            var result = new ObjectResult(value);
            var calls = 0;
            await filter.OnActionExecutionAsync(new ActionExecutingContext(context, [], new Dictionary<string, object?>(), this), () =>
            {
                calls++;
                return Task.FromResult(new ActionExecutedContext(context, [], this) { Result = result });
            });
            Assert.Equal(1, calls);
            return result.Value;
        }
        public void Dispose() { next.Dispose(); SpoilerUserResolver.InvalidateUser(User.ToString("N")); Plugin.Dispose(); }
    }

    [Fact]
    public async Task LazyLatestMediaIsMaterializedSoSerializationCannotRecreateUnstrippedItems()
    {
        using var f = new Fixture();
        var enumerations = 0;
        var lazy = Enumerable.Range(0, 2).Select(_ => { enumerations++; return f.Episode(); });
        var result = Assert.IsAssignableFrom<IEnumerable<BaseItemDto>>(await f.Invoke(lazy, "UserLibrary", "GetLatestMedia"));
        Assert.All(result, item => { Assert.Equal("Season 2, Episode 3", item.Name); Assert.NotEqual("Secret plot", item.Overview); Assert.Null(item.Path); });
        Assert.All(result, item => Assert.Empty(item.Tags));
        Assert.Equal(2, enumerations);
    }

    [Fact]
    public async Task MixedQueryStripsOnlyGuardedUnwatchedItemsAndPreservesPagination()
    {
        using var f = new Fixture();
        var hidden = f.Episode(); var watched = f.Episode(true); var outside = f.Episode(); outside.SeriesId = Guid.NewGuid();
        var query = new QueryResult<BaseItemDto> { Items = [hidden, watched, outside], TotalRecordCount = 25, StartIndex = 4 };
        Assert.Same(query, await f.Invoke(query));
        Assert.Equal("Season 2, Episode 3", hidden.Name);
        Assert.Null(hidden.OriginalTitle); Assert.Null(hidden.SortName);
        Assert.Null(hidden.CommunityRating); Assert.Null(hidden.CriticRating);
        Assert.Equal("Secret ending", watched.Name); Assert.Equal("Secret plot", watched.Overview);
        Assert.Equal("Secret original", watched.OriginalTitle); Assert.Equal("Secret sort", watched.SortName);
        Assert.Equal(9, watched.CommunityRating); Assert.Equal(80, watched.CriticRating);
        Assert.Equal("Secret ending", outside.Name); Assert.Equal("Secret plot", outside.Overview);
        Assert.Equal(25, query.TotalRecordCount); Assert.Equal(4, query.StartIndex);
        var other = f.Episode(); await f.Invoke(other, user: Guid.NewGuid());
        Assert.Equal("Secret plot", other.Overview);
    }

    [Fact]
    public async Task SubtitleDeliveryRemainsUsableWhileTitleBearingPathsAreScrubbed()
    {
        using var f = new Fixture();
        var dto = f.Episode();
        static MediaStream[] Streams() => [new MediaStream { IsExternal = true, Path = "/Secret.srt", Title = "Secret", DeliveryUrl = "/Videos/1/Subtitles/0/Stream.srt" },
            new MediaStream { IsExternal = true, IsExternalUrl = true, Path = "https://provider/Secret.srt", DeliveryUrl = "https://provider/Secret.srt" },
            new MediaStream { Title = "Secret" }];
        dto.MediaStreams = Streams();
        // Each media source nests its own copy of the streams, scrubbed by the same rules.
        dto.MediaSources = [new MediaSourceInfo { Name = "Secret", Path = "/Secret.mkv", MediaStreams = Streams() }];
        await f.Invoke(dto, "UserLibrary", "GetItem");
        foreach (var streams in new[] { dto.MediaStreams, dto.MediaSources[0].MediaStreams })
        {
            Assert.Null(streams[0].Path); Assert.Null(streams[0].Title);
            Assert.Equal("/Videos/1/Subtitles/0/Stream.srt", streams[0].DeliveryUrl);
            Assert.Null(streams[1].Path); Assert.Null(streams[1].DeliveryUrl);
            Assert.Null(streams[2].Title);
        }
        Assert.Null(dto.MediaSources[0].Path); Assert.Null(dto.MediaSources[0].Name);
    }

    [Fact]
    public async Task SavingSpoilerStateReplacesTheCachedStateForTheNextRequest()
    {
        using var f = new Fixture();
        var id = Guid.NewGuid();
        BaseItemDto Movie() => new() { Id = id, Type = BaseItemKind.Movie, Name = "Movie name", Overview = "Secret plot", UserData = new UserItemDataDto { Key = "test" } };
        // This request caches the user's state, in which the movie is not protected.
        var before = Movie(); await f.Invoke(before);
        Assert.Equal("Secret plot", before.Overview);
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(f.User.ToString("N")));
        var state = new UserSpoilerBlur(); state.Series[f.Series.ToString("N")] = new(); state.Movies[id.ToString("N")] = new();
        f.Save(state);
        var after = Movie(); await f.Invoke(after);
        Assert.NotEqual("Secret plot", after.Overview);
    }

    [Fact]
    public async Task MovieChapterBoundaryPreservesPastChaptersAndVersionName()
    {
        using var f = new Fixture();
        var id = Guid.NewGuid(); var state = new UserSpoilerBlur(); state.Movies[id.ToString("N")] = new(); f.Save(state);
        var movie = new BaseItemDto { Id = id, Type = BaseItemKind.Movie, Name = "Movie name", Overview = "Secret plot",
            UserData = new UserItemDataDto { Key = "test", PlaybackPositionTicks = 100 },
            Chapters = [new ChapterInfo { Name = "Past", StartPositionTicks = 99, ImagePath = "/past.jpg" }, new ChapterInfo { Name = "Boundary secret", StartPositionTicks = 100, ImagePath = "/secret.jpg" }],
            MediaSources = [new MediaSourceInfo { Name = "Director's Cut", Path = "/Secret.mkv" }] };
        await f.Invoke(movie);
        Assert.Equal("Movie name", movie.Name); Assert.Equal("Director's Cut", movie.MediaSources[0].Name);
        Assert.Equal("Past", movie.Chapters[0].Name); Assert.Equal("/past.jpg", movie.Chapters[0].ImagePath);
        Assert.Equal("Chapter 2", movie.Chapters[1].Name); Assert.Null(movie.Chapters[1].ImagePath);
    }

    [Theory]
    [InlineData(false, "Items", "GetItems")]
    [InlineData(true, "Other", "GetItems")]
    public async Task DisabledAndUnrelatedRoutesPassThrough(bool enabled, string controller, string action)
    {
        using var f = new Fixture(); f.Plugin.Plugin.Configuration.SpoilerBlurEnabled = enabled;
        var dto = f.Episode(); await f.Invoke(dto, controller, action);
        Assert.Equal("Secret ending", dto.Name); Assert.Equal("Secret plot", dto.Overview);
    }
}
