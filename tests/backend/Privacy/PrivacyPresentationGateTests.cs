using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Moq;
using System.Text.Json.Nodes;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyPresentationGateTests
{
    [Theory]
    [InlineData("acquire/discover")]
    [InlineData("acquire/search")]
    public void PartialEvidenceResponseKeepsItsStatusAndRetryHeadersThroughBothResultFilters(string path)
    {
        using var f = new ApiPluginFixture(); var user = Guid.NewGuid();
        f.Plugin.Configuration.HiddenContentEnabled = true; f.Plugin.Configuration.SpoilerBlurEnabled = true;
        f.Plugin.Configuration.SpoilerStripOverview = true;
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"), "hidden-content.json", new UserHiddenContent
        {
            Settings = new() { FilterSearch = true, FilterDiscovery = true },
            Items = new() { ["movie:tmdb:42"] = new() { Type = "Movie", TmdbId = "42" } },
        });
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"), "spoilerblur.json", new UserSpoilerBlur { PendingTmdb = new() { ["movie:43"] = new() } });
        var library = Mock.Of<ILibraryManager>();
        var spoilers = new SpoilerPresentation(f.Core.Manager, library, Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>());
        var http = new DefaultHttpContext(); http.Request.Method = "GET"; http.Request.Path = "/JellyfinEnhanced/" + path;
        http.User = JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        http.Request.Headers.IfNoneMatch = "*"; http.Response.Headers.ETag = "stale"; http.Response.Headers.RetryAfter = "5";
        var result = new ContentResult
        {
            StatusCode = 200, ContentType = "application/json; charset=utf-8",
            Content = """{"outcome":"partial","reason":"evidence_unavailable","answer":{"complete":false,"verification":"partial","retryAfterSeconds":5,"results":[{"key":"movie:tmdb:42","title":"hidden"},{"key":"movie:tmdb:43","overview":"secret"}]}}""",
        };
        http.Response.Headers.CacheControl = "private, no-store";
        var context = new ResultExecutingContext(EndpointRouting.Bind(http), new List<IFilterMetadata>(), result, new object());
        new Jellyfin.Plugin.JellyfinEnhanced.Helpers.RequestOutcomeFilterAttribute().OnResultExecuting(context);
        new TitlePresentationResultFilter(f.Core.Manager, spoilers, library, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), null!).OnResultExecuting(context);
        var partial = Assert.IsType<ContentResult>(context.Result);
        Assert.Equal(200, partial.StatusCode); Assert.Equal("private, no-store", http.Response.Headers.CacheControl);
        Assert.Equal("5", http.Response.Headers.RetryAfter); Assert.False(http.Response.Headers.ContainsKey("ETag"));
        Assert.DoesNotContain("hidden", partial.Content); Assert.DoesNotContain("secret", partial.Content);
        var answer = JsonNode.Parse(partial.Content!)!["answer"]!;
        Assert.NotNull(answer["complete"]);
        Assert.False(answer["complete"]!.GetValue<bool>()); Assert.Single(answer["results"]!.AsArray());
        Assert.Equal("partial", answer["verification"]!.GetValue<string>());
        Assert.Equal(5, answer["retryAfterSeconds"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("native-details/title/tv/83867/ratings", false)]
    [InlineData("native-details/title/tv/83867/ratings", true)]
    [InlineData("jellyseerr/tv/83867/ratings", false)]
    [InlineData("jellyseerr/tv/83867/ratings", true)]
    public void GuardedFlatTvRatingsHonorSuppressionAtFinalDelivery(string path, bool suppress)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = PrivacyOperationalProjectionTests.Guard(f, user, "tv:tmdb:83867", suppress);
        var final = PrivacyOperationalProjectionTests.Final(f, spoilers, user, path,
            new ContentResult { Content = "{\"criticsScore\":96}", ContentType = "application/json" });
        if (suppress) Assert.Null(final);
        else Assert.Equal(96, final["criticsScore"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("native-details/person/9/filmography")]
    [InlineData("native-details/discover/movie/genre/1")]
    [InlineData("native-details/title/movie/9/related/similar")]
    [InlineData("native-details/collection/9")]
    [InlineData("jellyseerr/discover/movies")]
    [InlineData("jellyseerr/search")]
    [InlineData("tmdb/discover/movie")]
    [InlineData("acquire/discover")]
    [InlineData("acquire/search")]
    [InlineData("acquire/hub")]
    [InlineData("acquire/requests/mine")]
    [InlineData("arr/requests")]
    [InlineData("arr/calendar")]
    public void FinalResultGateBypassesRequestMemoizationOnEveryFeedAndChangesValidators(string path)
    {
        using var f = new ApiPluginFixture(); var user=Guid.NewGuid();
        f.Plugin.Configuration.HiddenContentEnabled=true; f.Plugin.Configuration.SpoilerBlurEnabled=true; f.Plugin.Configuration.SpoilerStripOverview=true;
        var library=Mock.Of<ILibraryManager>();
        var service=new SpoilerPresentation(f.Core.Manager,library,Mock.Of<IUserManager>(),Mock.Of<IUserDataManager>());
        var http=new DefaultHttpContext(); http.Request.Path="/JellyfinEnhanced/"+path; http.Request.Method="GET";
        http.User=JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        HiddenContentPolicy.Load(f.Core.Manager,user,http); service.Load(user,http);
        var state=new UserHiddenContent { Settings=new() { FilterSearch=true }, Items=new() { ["movie:tmdb:42"]=new() { Type="Movie",TmdbId="42" } } };
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"hidden-content.json",state);
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"spoilerblur.json",new UserSpoilerBlur { PendingTmdb=new() { ["movie:43"]=new() } });
        var filter=new TitlePresentationResultFilter(f.Core.Manager,service,library,Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(),null!);
        var action=EndpointRouting.Bind(http);
        var raw="""{"results":[{"key":"movie:tmdb:42","title":"hidden"},{"key":"movie:tmdb:43","overview":"secret"}],"groups":[{"key":"movie:tmdb:42","basedOn":"hidden seed","results":[{"key":"movie:tmdb:43"}]}]}""";
        if(path=="native-details/collection/9") raw="""{"parts":[{"key":"movie:tmdb:42","title":"hidden"},{"key":"movie:tmdb:43","overview":"secret"}]}""";
        ResultExecutingContext Run() { var c=new ResultExecutingContext(action,new List<IFilterMetadata>(),new ContentResult { Content=raw,ContentType="application/json" },new object()); filter.OnResultExecuting(c); return c; }
        var result=Run(); var json=Assert.IsType<ContentResult>(result.Result).Content!;
        Assert.DoesNotContain("secret",json); Assert.DoesNotContain("hidden",json);
        var etag=http.Response.Headers.ETag.ToString(); Assert.NotEmpty(etag);
        http.Request.Headers.IfNoneMatch=etag; Assert.Equal(304, Assert.IsAssignableFrom<Microsoft.AspNetCore.Mvc.Infrastructure.IStatusCodeActionResult>(Run().Result).StatusCode);
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"spoilerblur.json",new UserSpoilerBlur());
        Assert.Contains("secret",Assert.IsType<ContentResult>(Run().Result).Content!); Assert.NotEqual(etag,http.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void FinalNativeGatePreservesWatchedLibraryEpisodePresentation()
    {
        using var f=new ApiPluginFixture();var user=Guid.NewGuid();var seriesId=Guid.NewGuid();var episodeId=Guid.NewGuid();
        f.Plugin.Configuration.SpoilerBlurEnabled=true;f.Plugin.Configuration.SpoilerStripOverview=true;
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"spoilerblur.json",new UserSpoilerBlur { Series=new() { [seriesId.ToString("N")]=new() } });
        var series=new MediaBrowser.Controller.Entities.TV.Series { Id=seriesId,ProviderIds=new() { ["Tmdb"]="42" } };
        var episode=new MediaBrowser.Controller.Entities.TV.Episode { Id=episodeId,SeriesId=seriesId };
        var library=new Mock<ILibraryManager>();library.Setup(l=>l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q)=>q.ItemIds.Select(id=>id==seriesId?(MediaBrowser.Controller.Entities.BaseItem)series:episode).ToList());
        var users=new Mock<IUserManager>();users.Setup(u=>u.GetUserById(user)).Returns(new Jellyfin.Database.Implementations.Entities.User("viewer","default","default") { Id=user });
        var userData=Mock.Of<IUserDataManager>();var resolver=new SpoilerUserResolver(f.Core.Manager,library.Object,f.Core.Logger,null!);
        var strip=new SpoilerFieldStripFilter(resolver,library.Object,users.Object,userData,new SpoilerNextUnwatchedService(library.Object,users.Object,userData,f.Core.Logger));
        var service=new SpoilerPresentation(f.Core.Manager,library.Object,users.Object,userData);
        var http=new DefaultHttpContext();http.Request.Method="GET";http.User=JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        var item=new MediaBrowser.Model.Dto.BaseItemDto { Id=episodeId,SeriesId=seriesId,Type=Jellyfin.Data.Enums.BaseItemKind.Episode,Overview="watched overview",UserData=new() { Key="episode",Played=true } };
        var action=new ActionContext(http,new RouteData(),new ActionDescriptor());var context=new ResultExecutingContext(action,new List<IFilterMetadata>(),new OkObjectResult(item),new object());
        new TitlePresentationResultFilter(f.Core.Manager,service,library.Object,Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(),strip).OnResultExecuting(context);
        Assert.Equal("watched overview",item.Overview);
    }

    [Fact]
    public void FinalNativeGatePreservesDiscoverySettingAndMetadataLookupBypass()
    {
        using var f=new ApiPluginFixture();var user=Guid.NewGuid();f.Plugin.Configuration.HiddenContentEnabled=true;
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"hidden-content.json",new UserHiddenContent { Settings=new() { FilterLibrary=true,FilterDiscovery=false }, Items=new() { ["movie:tmdb:42"]=new() { Type="Movie",TmdbId="42" } } });
        var library=Mock.Of<ILibraryManager>();var service=new SpoilerPresentation(f.Core.Manager,library,Mock.Of<IUserManager>(),Mock.Of<IUserDataManager>());
        var http=new DefaultHttpContext();http.Request.Method="GET";http.User=JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        var route=new RouteData();route.Values["controller"]="HomeScreen";route.Values["action"]="GetSectionContent";route.Values["sectionType"]="Discover";
        var action=new ActionContext(http,route,new ActionDescriptor());
        var filter=new TitlePresentationResultFilter(f.Core.Manager,service,library,Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(),null!);
        var item=new MediaBrowser.Model.Dto.BaseItemDto { Id=Guid.NewGuid(),Type=Jellyfin.Data.Enums.BaseItemKind.Movie,ProviderIds=new() { ["Tmdb"]="42" } };
        int Run() { var result=new OkObjectResult(new MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Dto.BaseItemDto>(0,1,new[] { item }));var context=new ResultExecutingContext(action,new List<IFilterMetadata>(),result,new object());filter.OnResultExecuting(context);return ((MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Dto.BaseItemDto>)result.Value!).Items.Count; }
        Assert.Equal(1,Run());
        route.Values["controller"]="Items";route.Values["action"]="GetItems";http.Request.QueryString=new QueryString("?Ids="+item.Id.ToString("N"));
        Assert.Equal(1,Run());
    }

    [Fact]
    public void FinalSeasonRowsUseOwningSeriesAndEpisodePolicy()
    {
        using var f=new ApiPluginFixture(); f.Plugin.Configuration.SpoilerBlurEnabled=true;f.Plugin.Configuration.SpoilerReplaceTitle=true;f.Plugin.Configuration.SpoilerStripOverview=true;
        var user=Guid.NewGuid(); f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"spoilerblur.json",new UserSpoilerBlur { PendingTmdb=new() { ["tv:42"]=new() } });
        var service=new SpoilerPresentation(f.Core.Manager,Mock.Of<ILibraryManager>(),Mock.Of<IUserManager>(),Mock.Of<IUserDataManager>());
        var json=TitlePresentationGate.Read(f.Core.Manager,service,user).Project("""{"rows":{"series":"tv:tmdb:42","episodes":[{"episode":1,"title":"secret","overview":"secret","still":"/secret.jpg"}]}}""","requests",null,"page");
        Assert.DoesNotContain("secret",json);
    }

    [Theory]
    [InlineData("reviews/tv/42", true)]
    [InlineData("reviews/tv/42:s1", true)]
    [InlineData("reviews/tv/42:s1:e2", true)]
    [InlineData("reviews/tv/042:s01:e02", true)]
    [InlineData("reviews/tv/43:s1", false)]
    [InlineData("reviews/tv/43:s1:e2", false)]
    public void ReviewRoutesResolveSeasonAndEpisodeKeysToTheGuardedSeries(string path, bool guarded)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = PrivacyOperationalProjectionTests.Guard(f, user, "tv:tmdb:42");
        f.Plugin.Configuration.SpoilerStripReviews = false;
        var final = PrivacyOperationalProjectionTests.Final(f, spoilers, user, path, new ContentResult
        {
            Content = """{"reviews":[{"userId":"u","userName":"Viewer","content":"kept text","rating":9}],"averageRating":9,"totalReviews":1}""",
            ContentType = "application/json"
        });
        var review = final["reviews"]![0]!;
        Assert.Equal("kept text", review["content"]!.GetValue<string>());
        Assert.Equal(guarded, review["rating"] == null);
        Assert.Equal(guarded, final["averageRating"] == null);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ReviewRatingMapResolvesExtendedKeysToTheOwningSeries(bool suppress)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = PrivacyOperationalProjectionTests.Guard(f, user, "tv:tmdb:42", suppress);
        var final = PrivacyOperationalProjectionTests.Final(f, spoilers, user, "reviews/ratings", new ContentResult
        {
            Content = """{"ratings":{"tv:42":{"average":4,"count":1},"tv:42:s1":{"average":4,"count":1},"tv:42:s1:e2":{"average":4,"count":1},"tv:43:s1:e2":{"average":3,"count":1}}}""",
            ContentType = "application/json"
        });
        var ratings = final["ratings"]!.AsObject();
        foreach (var key in new[] { "tv:42", "tv:42:s1", "tv:42:s1:e2" })
            Assert.Equal(suppress, ratings[key] == null);
        Assert.Equal(3, ratings["tv:43:s1:e2"]!["average"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("tv", "42", "tv:tmdb:42")]
    [InlineData("tv", "42:s1", "tv:tmdb:42")]
    [InlineData("series", "42:s1:e2", "tv:tmdb:42")]
    [InlineData("tv", "0042:s0:e0", "tv:tmdb:42")]
    [InlineData("movie", "603", "movie:tmdb:603")]
    [InlineData("movie", "603:s1", null)]
    [InlineData("tv", "42:e2", null)]
    [InlineData("tv", "42:s1:e2:x", null)]
    [InlineData("tv", "0", null)]
    [InlineData("tv", "4294967296", null)]
    [InlineData("tv", "-1", null)]
    [InlineData("tv", "４２", null)]
    [InlineData("person", "42", null)]
    [InlineData(null, "42", null)]
    public void OwningTitleIsTheSingleCanonicalRouteIdentityParser(string? type, string key, string? expected)
        => Assert.Equal(expected, HiddenContentPolicy.OwningTitle(type, key));

    [Theory]
    [InlineData("movie", "603:s1")]
    [InlineData("tv", "0:s1")]
    [InlineData("tv", "42:e2")]
    [InlineData("tv", "99999999999")]
    public void ReviewRoutesRejectKeysWithoutAnOwningTitle(string type, string key)
    {
        using var f = new ApiPluginFixture();
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = TestCallers.Principal(Guid.NewGuid(), false);
        Assert.IsType<BadRequestObjectResult>(c.GetItemReviews(type, key));
        Assert.IsType<BadRequestObjectResult>(c.UpsertReview(type, key, new() { Content = "text", Rating = 4 }));
        Assert.IsType<BadRequestObjectResult>(c.DeleteReview(type, key));
    }

    [Theory]
    [InlineData("42")]
    [InlineData("42:s1")]
    [InlineData("42:s1:e2")]
    public void SuppressedReviewsCoverTheGuardedSeriesSeasonsAndEpisodes(string key)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = PrivacyOperationalProjectionTests.Guard(f, user, "tv:tmdb:42");
        f.Plugin.Configuration.SpoilerStripReviews = true;
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager, spoilers);
        c.HttpContext.User = TestCallers.Principal(user, false);
        var body = System.Text.Json.JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(c.GetItemReviews("tv", key)).Value);
        Assert.Contains("\"totalReviews\":0", body);
    }
}
