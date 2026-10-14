using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace JellyfinEnhanced.Tests;

[Collection("Plugin singleton")]
public class PrivacyHiddenContentTests
{
    private static async Task<object?> Run(JE.Tests.ApiPluginFixture f, Guid user, string controller, string action, object body, string query = "", string? section = null)
    {
        var http = new DefaultHttpContext { User = PrivacyPolicyTests.Principal(user) };
        http.Request.QueryString = new QueryString(query);
        var route = new RouteData(); route.Values["controller"] = controller; route.Values["action"] = action; if (section != null) route.Values["sectionType"] = section;
        var context = new ActionContext(http, route, new ActionDescriptor());
        var filters = new List<IFilterMetadata>();
        var executed = new ActionExecutedContext(context, filters, new object()) { Result = new ObjectResult(body) };
        var calls = 0;
        await new HiddenContentResponseFilter(f.Core.Manager, f.Core.Logger).OnActionExecutionAsync(
            new ActionExecutingContext(context, filters, new Dictionary<string, object?>(), new object()),
            () => { calls++; return Task.FromResult(executed); });
        Assert.Equal(1, calls);
        return Assert.IsType<ObjectResult>(executed.Result).Value;
    }
    private static UserHiddenContent Hide(Guid item, string scope = "global", string type = "Movie") => new()
    { Items = new() { ["entry"] = new HiddenContentItem { ItemId = item.ToString("D").ToUpperInvariant(), Type = type, HideScope = scope } } };
    private static void Save(JE.Tests.ApiPluginFixture f, Guid user, UserHiddenContent data)
    { f.Core.Manager.SaveUserConfiguration(user.ToString("N"), "hidden-content.json", data); HiddenContentResponseFilter.InvalidateUser(user.ToString("N")); }
    private static QueryResult<BaseItemDto> Rows(params BaseItemDto[] items) => new(5, 20, items);

    [Theory]
    [InlineData("Items", "GetItems")]
    [InlineData("Items", "GetItemsByUserIdLegacy")]
    [InlineData("Items", "GetResumeItems")]
    [InlineData("Items", "GetResumeItemsLegacy")]
    [InlineData("TvShows", "GetNextUp")]
    [InlineData("TvShows", "GetUpcomingEpisodes")]
    [InlineData("Suggestions", "GetSuggestions")]
    [InlineData("Suggestions", "GetSuggestionsLegacy")]
    public async Task GlobalHideRemovesItemsAndAdjustsPaginationAcrossRoutes(string controller, string action)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var hidden = Guid.NewGuid(); var kept = Guid.NewGuid(); Save(f, user, Hide(hidden));
        var source = Rows(new BaseItemDto { Id = hidden }, new() { Id = kept });
        var result = Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, controller, action, source));
        Assert.Equal(kept, Assert.Single(result.Items).Id); Assert.Equal(19, result.TotalRecordCount); Assert.Equal(5, result.StartIndex);
        Assert.Equal(2, source.Items.Count); // filtering must not alter the shared source collection
        var other = Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, Guid.NewGuid(), controller, action, source));
        Assert.Equal(2, other.Items.Count);
    }

    [Fact]
    public async Task SeriesHideCascadesToEpisodesAndInvalidationRestoresImmediately()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var series = Guid.NewGuid(); Save(f, user, Hide(series, type: "Series"));
        var source = Rows(new BaseItemDto { Id = series }, new() { Id = Guid.NewGuid(), SeriesId = series }, new() { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid() });
        Assert.Single(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetItems", source)).Items);
        Save(f, user, new UserHiddenContent());
        Assert.Equal(3, Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetItems", source)).Items.Count);
    }

    [Theory]
    [InlineData("continuewatching", "GetResumeItems", true)]
    [InlineData("continuewatching", "GetItems", false)]
    [InlineData("homesections", "GetResumeItems", true)]
    [InlineData("homesections", "GetItems", false)]
    [InlineData("nextup", "GetResumeItems", false)]
    public async Task SurfaceScopesDoNotOverHideLibrary(string scope, string action, bool filtered)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var hidden = Guid.NewGuid(); Save(f, user, Hide(hidden, scope));
        var result = Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", action, Rows(new BaseItemDto { Id = hidden })));
        Assert.Equal(filtered ? 0 : 1, result.Items.Count);
    }

    [Theory]
    [InlineData("?Ids=abc", false)]
    [InlineData("?Ids=abc&Recursive=true", true)]
    [InlineData("?Ids=abc&ParentId=parent", true)]
    [InlineData("?SearchTerm=title", false)]
    public async Task MetadataResolverBypassAndSearchPreferenceAreHonored(string query, bool filtered)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var hidden = Guid.NewGuid(); Save(f, user, Hide(hidden));
        var result = Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetItems", Rows(new BaseItemDto { Id = hidden }), query));
        Assert.Equal(filtered ? 0 : 1, result.Items.Count);
    }

    [Fact]
    public async Task SearchHintsAndLazyLatestEnumerableUseTypedHandlers()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var hidden = Guid.NewGuid(); var kept = Guid.NewGuid(); var settings = Hide(hidden); settings.Settings.FilterSearch = true; Save(f, user, settings);
        var hints = new SearchHintResult(new[] { new SearchHint { Id = hidden }, new SearchHint { Id = kept } }, 2);
        var search = Assert.IsType<SearchHintResult>(await Run(f, user, "Search", "GetSearchHints", hints));
        Assert.Equal(kept, Assert.Single(search.SearchHints).Id); Assert.Equal(1, search.TotalRecordCount);
        var latest = (IEnumerable<BaseItemDto>)(await Run(f, user, "UserLibrary", "GetLatestMedia", new[] { hidden, kept }.Select(id => new BaseItemDto { Id = id })))!;
        Assert.Equal(kept, Assert.Single(latest).Id);
    }

    [Fact]
    public async Task RemoveContinueWatchingWorksWithMasterOffButRespectsUserSurfaceSwitch()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = false; f.Plugin.Configuration.RemoveContinueWatchingEnabled = true;
        var user = Guid.NewGuid(); var hidden = Guid.NewGuid(); var settings = Hide(hidden, "continuewatching"); Save(f, user, settings);
        Assert.Empty(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetResumeItems", Rows(new BaseItemDto { Id = hidden }))).Items);
        settings.Settings.FilterContinueWatching = false; Save(f, user, settings);
        Assert.Single(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetResumeItems", Rows(new BaseItemDto { Id = hidden }))).Items);
        // The Continue Watching switch alone never reaches library listings, even for a global hide.
        Save(f, user, Hide(hidden));
        Assert.Single(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetItems", Rows(new BaseItemDto { Id = hidden }))).Items);
    }
    [Theory]
    [InlineData("nextup", 0, true)]
    [InlineData("nextup", 100, false)]
    [InlineData("continuewatching", 0, false)]
    [InlineData("continuewatching", 100, true)]
    public async Task MixedHomeSectionUsesEachItemsPlaybackState(string scope, long position, bool filtered)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var hidden = Guid.NewGuid(); Save(f, user, Hide(hidden, scope));
        var source = Rows(new BaseItemDto { Id = hidden, UserData = new UserItemDataDto { Key = "fixture", PlaybackPositionTicks = position } });
        var result = Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "HomeScreen", "GetSectionContent", source, section: "ContinueWatchingNextUp"));
        Assert.Equal(filtered ? 0 : 1, result.Items.Count);
    }

    [Theory]
    [InlineData("continuewatching", null)]
    [InlineData("homesections", "nextup")]
    public async Task ResumingAHiddenItemShowsItInContinueWatchingOnTheNextRequest(string scope, string? remainingScope)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = Guid.NewGuid(); var movie = new Movie { Id = Guid.NewGuid() }; Save(f, user, Hide(movie.Id, scope));
        // The first request caches the user's hidden content (30-second TTL) with the entry present.
        Assert.Empty(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetResumeItems", Rows(new BaseItemDto { Id = movie.Id }))).Items);
        using var usage = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        await new ContinueWatchingPlaybackConsumer(f.Core.Manager, usage, f.Core.Logger).OnEvent(new PlaybackStartEventArgs
        { Item = movie, Session = new SessionInfo(Mock.Of<ISessionManager>(), NullLogger.Instance) { UserId = user } });
        // A Continue Watching hide is dropped and a home-sections hide demoted to Next Up...
        var saved = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(user.ToString("N"), "hidden-content.json");
        Assert.Equal(remainingScope, saved.Items.Values.SingleOrDefault()?.HideScope);
        // ...and the very next request sees it, without waiting for the cache to expire.
        Assert.Single(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user, "Items", "GetResumeItems", Rows(new BaseItemDto { Id = movie.Id }))).Items);
    }

    /// <summary>
    /// Design item A5: the Continue Watching orphan prune (an item removed from the library) drops the
    /// response filter's cached hidden content, so an item re-added with the same id inside the 30 s
    /// cache window is not still hidden by the pruned entry.
    /// </summary>
    [Fact]
    public async Task OrphanPruneInvalidatesTheHiddenContentCache()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.HiddenContentEnabled = true;
        var user = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var movie = new Movie { Id = Guid.NewGuid() }; var other = Guid.NewGuid();
        var hidden = Hide(movie.Id); hidden.Items["other"] = new HiddenContentItem { ItemId = other.ToString(), Type = "Movie", HideScope = "global" };
        Save(f, user.Id, hidden);
        var users = new Mock<IUserManager>();
#if NET9_0
        users.SetupGet(x => x.Users).Returns(new[] { user });
#else
        users.Setup(x => x.GetUsers()).Returns(new[] { user });
#endif
        var library = new Mock<ILibraryManager>();
        var hook = new ContinueWatchingLibraryHook(library.Object, f.Core.Manager, users.Object, f.Core.Logger);
        await hook.StartAsync(CancellationToken.None);
        // The first request caches the user's hidden content with both entries present.
        Assert.Empty(Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user.Id, "Items", "GetItems", Rows(new BaseItemDto { Id = movie.Id }, new BaseItemDto { Id = other }))).Items);
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(user.Id.ToString("N")));

        library.Raise(l => l.ItemRemoved += null, library.Object, new ItemChangeEventArgs { Item = movie });

        // The prune runs off-thread; wait for it to land, well inside the 30 s cache TTL.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (HiddenContentResponseFilter.IsCachedForTest(user.Id.ToString("N")) && DateTime.UtcNow < deadline) await Task.Delay(20);
        Assert.False(HiddenContentResponseFilter.IsCachedForTest(user.Id.ToString("N")));
        Assert.Equal("other", Assert.Single(f.Core.Manager.GetUserConfiguration<UserHiddenContent>(user.Id.ToString("N"), "hidden-content.json").Items).Key);
        // The same id comes back (re-added) and is shown; the other hide still applies.
        var result = Assert.IsType<QueryResult<BaseItemDto>>(await Run(f, user.Id, "Items", "GetItems", Rows(new BaseItemDto { Id = movie.Id }, new BaseItemDto { Id = other })));
        Assert.Equal(movie.Id, Assert.Single(result.Items).Id);
        await hook.StopAsync(CancellationToken.None);
    }
}
