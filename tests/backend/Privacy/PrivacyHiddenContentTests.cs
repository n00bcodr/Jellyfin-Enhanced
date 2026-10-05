using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
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

}
