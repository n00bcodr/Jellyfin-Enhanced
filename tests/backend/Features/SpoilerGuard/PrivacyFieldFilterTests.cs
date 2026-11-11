using System.Security.Claims;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Identity;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;

namespace JE.Tests.Features.SpoilerGuard;

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
                new SpoilerIdentityService(Users.Object, Plugin.Core.Logger, Plugin.Core.Paths.Object), Plugin.Core.Logger);
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
        public async Task<object?> Invoke(object value, string controller = "Items", string action = "GetItems", Guid? user = null, Guid? routeItem = null)
        {
            var http = new DefaultHttpContext();
            http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", (user ?? User).ToString())], "Test"));
            if (routeItem != null) http.Request.RouteValues["itemId"] = routeItem.Value.ToString("N");
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
        Assert.All(result, item => { Assert.Equal("Season 2, Episode 3", item.Name); Assert.NotEqual("Secret plot", item.Overview); Assert.Equal("/S02E03", item.Path); });
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
    public async Task AnUnreadableStateFileKeepsTheLastStateReadAndIsLeftAsItIs()
    {
        using var f = new Fixture();
        var first = f.Episode();
        await f.Invoke(first);
        Assert.Equal("Season 2, Episode 3", first.Name);

        // The file then cannot be read (a write cut short, a share that dropped) once the cached copy has gone.
        var path = Path.Combine(f.Plugin.Core.ConfigRoot, f.User.ToString("N"), "spoilerblur.json");
        File.WriteAllText(path, "{\"Series\":{");
        SpoilerUserResolver.InvalidateUser(f.User.ToString("N"));
        var later = f.Episode();
        await f.Invoke(later);
        Assert.Equal("Season 2, Episode 3", later.Name);
        Assert.NotEqual("Secret plot", later.Overview);
        // Reading it never moves or rewrites it.
        Assert.Equal("{\"Series\":{", File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.corrupt-*"));
    }

    // GET /Sessions: a session's NowPlayingItem and NowViewingItem are built without a user (no UserData) and are
    // the session's own DTOs, which every other reader of the session gets too.
    [Fact]
    public async Task SessionListStripsAGuardedEpisodeBeingPlayedAsACopyOfTheSharedSessionItem()
    {
        using var f = new Fixture();
        var playing = f.Episode(); playing.UserData = null;
        playing.MediaStreams = [new MediaStream { Type = MediaStreamType.Audio, Title = "Secret ending commentary" }];
        var outside = f.Episode(); outside.SeriesId = Guid.NewGuid(); outside.UserData = null;
        var sessions = new List<SessionInfoDto> { new() { Id = "tv", NowPlayingItem = playing, NowViewingItem = outside } };
        var session = Assert.Single(Assert.IsAssignableFrom<IEnumerable<SessionInfoDto>>(await f.Invoke(sessions, "Session", "GetSessions")));
        Assert.Equal("Season 2, Episode 3", session.NowPlayingItem!.Name); Assert.NotEqual("Secret plot", session.NowPlayingItem.Overview);
        Assert.Null(Assert.Single(session.NowPlayingItem.MediaStreams!).Title);
        Assert.Equal("Secret ending", playing.Name); Assert.Equal("Secret plot", playing.Overview); Assert.Equal("/Secret.mkv", playing.Path);
        Assert.Equal("Secret ending commentary", Assert.Single(playing.MediaStreams).Title);
        Assert.Same(outside, session.NowViewingItem);
        // Someone who guards nothing gets the session's own item, unchanged.
        var others = new List<SessionInfoDto> { new() { Id = "tv", NowPlayingItem = playing } };
        var unguarded = Assert.Single(Assert.IsAssignableFrom<IEnumerable<SessionInfoDto>>(await f.Invoke(others, "Session", "GetSessions", Guid.NewGuid())));
        Assert.Same(playing, unguarded.NowPlayingItem);
    }

    // GET /Videos/{id}/AdditionalParts: the other files of a multi-part episode are plain videos with no series id,
    // named after their files.
    [Fact]
    public async Task AdditionalPartsOfAGuardedUnwatchedEpisodeLoseTheTitleTheirFileNamesCarry()
    {
        using var f = new Fixture();
        BaseItemDto Part() => new() { Id = Guid.NewGuid(), Type = BaseItemKind.Video, Name = "Show - S02E03 - Secret ending - pt2", Path = "/media/Show/Show - S02E03 - Secret ending - pt2.mkv", Container = "mkv" };
        var guarded = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = f.Series };
        var outside = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid() };
        foreach (var episode in new[] { guarded, outside }) f.Library.Setup(x => x.GetItemById(episode.Id)).Returns(episode);
        var part = Part();
        await f.Invoke(new QueryResult<BaseItemDto> { Items = [part] }, "Videos", "GetAdditionalPart", routeItem: guarded.Id);
        Assert.Equal("Part 2", part.Name); Assert.DoesNotContain("Secret", part.Path);
        var kept = Part();
        await f.Invoke(new QueryResult<BaseItemDto> { Items = [kept] }, "Videos", "GetAdditionalPart", routeItem: outside.Id);
        Assert.Equal("Show - S02E03 - Secret ending - pt2", kept.Name); Assert.Equal("/media/Show/Show - S02E03 - Secret ending - pt2.mkv", kept.Path);
    }

    [Fact]
    public async Task AStateFileUnreadableBeforeAnyReadGuardsEverySeriesUntilItReads()
    {
        using var f = new Fixture();
        // Nothing has read the user's file since the server started, and it cannot be read now.
        var path = Path.Combine(f.Plugin.Core.ConfigRoot, f.User.ToString("N"), "spoilerblur.json");
        File.WriteAllText(path, "{\"Series\":{");
        f.Library.Setup(l => l.GetItemIds(It.Is<MediaBrowser.Controller.Entities.InternalItemsQuery>(q => q.IncludeItemTypes.Contains(BaseItemKind.Series)))).Returns([f.Series]);
        var episode = f.Episode();
        await f.Invoke(episode);
        Assert.Equal("Season 2, Episode 3", episode.Name);
        Assert.NotEqual("Secret plot", episode.Overview);
        Assert.Equal("{\"Series\":{", File.ReadAllText(path));

        // Once it reads, its own answer applies: here the user guards nothing.
        f.Save(new UserSpoilerBlur());
        SpoilerUserResolver.InvalidateUser(f.User.ToString("N"));
        var later = f.Episode();
        await f.Invoke(later);
        Assert.Equal("Secret ending", later.Name);
    }

    // Upstream d3bd07d3: Home Screen Sections serves the web home rows from its own endpoint.
    [Fact]
    public async Task HomeScreenSectionsRowsStripGuardedUnwatchedEpisodes()
    {
        using var f = new Fixture();
        var hidden = f.Episode(); var watched = f.Episode(true);
        var query = new QueryResult<BaseItemDto> { Items = [hidden, watched], TotalRecordCount = 2 };
        Assert.Same(query, await f.Invoke(query, "HomeScreen", "GetSectionContent"));
        Assert.Equal("Season 2, Episode 3", hidden.Name); Assert.NotEqual("Secret plot", hidden.Overview); Assert.Equal("/S02E03", hidden.Path);
        Assert.Equal("Secret ending", watched.Name); Assert.Equal("Secret plot", watched.Overview);
    }

    [Fact]
    public void GuardedEpisodeKeepsANeutralPathSoWebDownloadDoesNotThrow()
    {
        var dto = new BaseItemDto { SeriesName = "Show/Name", ParentIndexNumber = 1, IndexNumber = 2, Container = "mkv", Path = "/media/Show/The Secret Ending.mkv" };
        var path = SpoilerFieldStripFilter.NeutralPath(dto);
        Assert.Equal("/Show Name S01E02.mkv", path);
        Assert.DoesNotContain("Secret", path);
        Assert.Equal("/Item", SpoilerFieldStripFilter.NeutralPath(new BaseItemDto()));
    }

    // What web does with it: Download on the item's page (the single-item route) and "Download all" (the
    // episode list) both build the file name with item.Path.replace(/^.*[\\/]/, '').
    [Theory]
    [InlineData("UserLibrary", "GetItem", "mkv", "/media/Show/Show - S02E03 - Secret ending.mkv", "Show S02E03.mkv")]
    [InlineData("TvShows", "GetEpisodes", "mkv", "/media/Show/Show - S02E03 - Secret ending.mkv", "Show S02E03.mkv")]
    // Container is ffprobe's whole format list for some files: the name is the one the file itself uses.
    [InlineData("UserLibrary", "GetItem", "mov,mp4,m4a,3gp,3g2,mj2", "/media/Show/Show - S02E03 - Secret ending.mp4", "Show S02E03.mp4")]
    [InlineData("TvShows", "GetEpisodes", "mkv,webm", "/media/Show/Show - S02E03 - Secret ending.WEBM", "Show S02E03.webm")]
    // Never the path's own text: an "extension" the container list does not name is not taken.
    [InlineData("UserLibrary", "GetItem", "mov,mp4,m4a,3gp,3g2,mj2", "/media/Show/Show.S02E03.Secret.Ending", "Show S02E03.mov")]
    [InlineData("UserLibrary", "GetItem", null, "/media/Show/Show.S02E03.Secret.Ending", "Show S02E03")]
    public async Task AGuardedEpisodeLeavesTheFilterWithAFileNameWebCanDownloadUnder(string controller, string action, string? container, string path, string fileName)
    {
        using var f = new Fixture();
        var dto = f.Episode();
        dto.SeriesName = "Show"; dto.Container = container; dto.Path = path;
        object value = action == "GetEpisodes" ? new QueryResult<BaseItemDto> { Items = [dto], TotalRecordCount = 1 } : dto;
        await f.Invoke(value, controller, action);
        Assert.NotNull(dto.Path);
        Assert.Equal(fileName, System.Text.RegularExpressions.Regex.Replace(dto.Path, @"^.*[\\/]", string.Empty));
        Assert.DoesNotContain("Secret", dto.Path, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Ending", dto.Path, StringComparison.OrdinalIgnoreCase);
        // A second pass over the same DTO (nested results are filtered again) changes nothing.
        var once = dto.Path;
        await f.Invoke(value, controller, action);
        Assert.Equal(once, dto.Path);
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

    // Fields a DTO carries before the auxiliary title-bearing block runs. Links and trailers
    // are separate so a test can show one surviving while the other is scrubbed.
    private static ExternalUrl[] Links() => [new ExternalUrl { Name = "TheMovieDb", Url = "https://www.themoviedb.org/tv/1399" }, new ExternalUrl { Name = "IMDb", Url = "https://www.imdb.com/title/tt0944947" }];

    private static BaseItemDto WithAuxiliaryFields(BaseItemDto dto)
    {
        dto.Path = "/Secret";
        dto.ExternalUrls = Links();
        dto.RemoteTrailers = [new MediaUrl { Name = "Secret trailer", Url = "https://example.test/secret" }];
        dto.People = [new BaseItemPerson { Name = "Actor", Role = "Secret role", Type = PersonKind.Actor }];
        return dto;
    }

    // Web renders .itemExternalLinks from ExternalUrls, and Arr, Seerr, Letterboxd and Elsewhere
    // anchor on that row or read the TMDB link from it (#1017). Series and movie titles are never
    // replaced, so only their links are kept: everything else in the block stays scrubbed.
    [Theory]
    [InlineData("Series", true, "UserLibrary", "GetItemLegacy", true, true)]
    [InlineData("Series", true, "UserLibrary", "GetItem", true, false)]
    [InlineData("Series", true, "Items", "GetItems", false, true)]
    [InlineData("Movie", false, "UserLibrary", "GetItemLegacy", true, true)]
    [InlineData("Movie", false, "UserLibrary", "GetItem", true, false)]
    [InlineData("Movie", false, "Items", "GetItems", false, true)]
    public async Task GuardedSeriesAndMovieKeepExternalLinksButNotTheOtherAuxiliaryFields(string kind, bool isSeries, string controller, string action, bool replaceTitle, bool stripOverview)
    {
        using var f = new Fixture();
        f.Plugin.Plugin.Configuration.SpoilerReplaceTitle = replaceTitle;
        f.Plugin.Plugin.Configuration.SpoilerStripSeriesOverview = stripOverview;
        f.Plugin.Plugin.Configuration.SpoilerStripOverview = stripOverview;
        var id = isSeries ? f.Series : Guid.NewGuid();
        if (!isSeries) { var state = new UserSpoilerBlur(); state.Movies[id.ToString("N")] = new(); f.Save(state); }
        var dto = WithAuxiliaryFields(new BaseItemDto { Id = id, Type = Enum.Parse<BaseItemKind>(kind), Name = "Title", Overview = "Plot", UserData = new UserItemDataDto { Key = "test" } });
        await f.Invoke(dto, controller, action);
        Assert.Equal(Links().Select(l => l.Url), dto.ExternalUrls.Select(l => l.Url));
        Assert.Null(dto.RemoteTrailers); Assert.NotNull(dto.Path); Assert.DoesNotContain("Secret", dto.Path);
        Assert.Null(Assert.Single(dto.People).Role);
        Assert.Equal("Title", dto.Name);
    }

    // The reproduction's denied side: a replaced title must not come back through a link.
    [Theory]
    [InlineData("Episode", false)]
    [InlineData("Season", false)]
    [InlineData("Trailer", true)]
    [InlineData("Video", true)]
    public async Task EpisodeSeasonAndExtraExternalLinksStayStripped(string kind, bool isExtra)
    {
        using var f = new Fixture();
        var dto = WithAuxiliaryFields(f.Episode());
        dto.Type = Enum.Parse<BaseItemKind>(kind);
        if (dto.Type == BaseItemKind.Season)
        {
            // S1 always passes, so use a later season with nothing watched.
            dto.IndexNumber = 2; dto.RecursiveItemCount = 8;
            dto.UserData!.UnplayedItemCount = 8;
        }
        await f.Invoke(dto, "UserLibrary", isExtra ? "GetLocalTrailers" : "GetItem");
        Assert.Null(dto.ExternalUrls); Assert.Null(dto.RemoteTrailers); Assert.NotNull(dto.Path); Assert.DoesNotContain("Secret", dto.Path);
        Assert.Null(Assert.Single(dto.People).Role);
    }

    // Preservation: no strip applies, so nothing here may depend on the new kind check.
    [Fact]
    public async Task UnguardedAndWatchedItemsKeepTheirExternalLinks()
    {
        using var f = new Fixture();
        var unguarded = WithAuxiliaryFields(new BaseItemDto { Id = Guid.NewGuid(), Type = BaseItemKind.Series, Name = "Title", Overview = "Plot" });
        var watched = WithAuxiliaryFields(f.Episode(played: true));
        await f.Invoke(new QueryResult<BaseItemDto> { Items = [unguarded, watched] });
        Assert.NotNull(unguarded.ExternalUrls); Assert.NotNull(unguarded.RemoteTrailers);
        Assert.NotNull(watched.ExternalUrls); Assert.NotNull(watched.RemoteTrailers);
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
