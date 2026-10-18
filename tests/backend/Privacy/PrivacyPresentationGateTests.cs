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
        var action=new ActionContext(http,new RouteData(),new ActionDescriptor());
        var raw="""{"results":[{"key":"movie:tmdb:42","title":"hidden"},{"key":"movie:tmdb:43","overview":"secret"}],"groups":[{"key":"movie:tmdb:42","basedOn":"hidden seed","results":[{"key":"movie:tmdb:43"}]}]}""";
        ResultExecutingContext Run() { var c=new ResultExecutingContext(action,new List<IFilterMetadata>(),new ContentResult { Content=raw,ContentType="application/json" },new object()); filter.OnResultExecuting(c); return c; }
        var result=Run(); var json=Assert.IsType<ContentResult>(result.Result).Content!;
        Assert.DoesNotContain("secret",json); Assert.DoesNotContain("hidden",json);
        var etag=http.Response.Headers.ETag.ToString(); Assert.NotEmpty(etag);
        http.Request.Headers.IfNoneMatch=etag; Assert.IsType<StatusCodeResult>(Run().Result);
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
        var json=TitlePresentationGate.Read(f.Core.Manager,service,user).Project("""{"rows":{"series":"tv:tmdb:42","episodes":[{"episode":1,"title":"secret","overview":"secret","still":"/secret.jpg"}]}}""","requests");
        Assert.DoesNotContain("secret",json);
    }
}
