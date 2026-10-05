using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;
using SkiaSharp;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PosterBlurFilterTests
{
    private sealed class ResponseFeature : HttpResponseFeature
    {
        private readonly List<(Func<object,Task> Callback,object State)> callbacks=[];
        public override void OnStarting(Func<object,Task> callback,object state)=>callbacks.Add((callback,state));
        public async Task Start() { foreach(var (callback,state) in callbacks.AsEnumerable().Reverse()) await callback(state); }
    }
    private sealed class Fixture : IDisposable
    {
        public readonly ApiPluginFixture Plugin=new();
        public readonly Guid UserId=Guid.NewGuid();
        public readonly Movie Movie=new(){Id=Guid.NewGuid()};
        public readonly Mock<ILibraryManager> Library=new();
        public readonly Mock<IUserManager> Users=new();
        public readonly Mock<IUserDataManager> UserData=new();
        public readonly Mock<IChapterManager> Chapters=new();
        public readonly User User=new("test","default","default");
        public readonly SpoilerBlurImageFilter Filter;
        private readonly SpoilerNextUnwatchedService next;
        public Fixture(bool guarded=true)
        {
            Plugin.Plugin.Configuration.SpoilerBlurEnabled=true; Plugin.Plugin.Configuration.SpoilerKeepMoviePosters=false;
            Plugin.Plugin.Configuration.SpoilerBlurMode="blur";
            User.Id=UserId; Users.Setup(u=>u.GetUserById(UserId)).Returns(User);
            Library.Setup(l=>l.GetItemById(Movie.Id)).Returns(Movie);
            UserData.Setup(u=>u.GetUserData(User,Movie)).Returns(new UserItemData{Key="movie",Played=false});
            var state=new UserSpoilerBlur(); if(guarded) state.Movies[Movie.Id.ToString("N")]=new();
            Plugin.Core.Manager.SaveUserConfiguration(UserId.ToString("N"),"spoilerblur.json",state);
            var markers=new SpoilerIdentityService(Users.Object,Plugin.Core.Logger);
            var identity=new RequestIdentityService(Mock.Of<ISessionManager>(),Users.Object,markers,Plugin.Core.Logger);
            var resolver=new SpoilerUserResolver(Plugin.Core.Manager,Library.Object,Plugin.Core.Logger,identity);
            next=new SpoilerNextUnwatchedService(Library.Object,Users.Object,UserData.Object,Plugin.Core.Logger);
            Filter=new SpoilerBlurImageFilter(Library.Object,Users.Object,UserData.Object,Chapters.Object,resolver,new ImageBlurService(Plugin.Core.Logger),next,Plugin.Core.Logger);
        }
        public async Task<(ActionExecutedContext Executed,DefaultHttpContext Http)> Run(IActionResult original,string type="Primary",string method="GET",string controller="Image",string action="GetItemImage",Guid? viewer=null,string query="")
        {
            var http=new DefaultHttpContext(); var response=new ResponseFeature(); http.Features.Set<IHttpResponseFeature>(response);
            http.Request.Method=method; http.Request.QueryString=new QueryString(query);
            http.User=new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId",(viewer??UserId).ToString())],"Test"));
            var descriptor=new ActionDescriptor{RouteValues=new Dictionary<string,string?>{{"controller",controller},{"action",action}}};
            var ac=new ActionContext(http,new RouteData(),descriptor,new ModelStateDictionary());
            var executing=new ActionExecutingContext(ac,[],new Dictionary<string,object?>{{"itemId",Movie.Id},{"imageType",type},{"imageIndex",0}},new object());
            var executed=new ActionExecutedContext(ac,[],new object()){Result=original};
            await Filter.OnActionExecutionAsync(executing,()=>{http.Response.Headers.CacheControl="public, max-age=31536000";http.Response.Headers.ETag="original";http.Response.Headers.LastModified="yesterday";return Task.FromResult(executed);});
            await response.Start(); return(executed,http);
        }
        public void Dispose(){Filter.Dispose();next.Dispose();SpoilerUserResolver.InvalidateUser(UserId.ToString("N"));Plugin.Dispose();}
    }
    private static void Private(HttpContext http,bool chapter=false)
    {
        Assert.Equal(chapter?"private, max-age=30, must-revalidate":"private, no-store, max-age=0, must-revalidate",http.Response.Headers.CacheControl.ToString());
        Assert.False(http.Response.Headers.ContainsKey("ETag")); Assert.False(http.Response.Headers.ContainsKey("Last-Modified"));
        Assert.Equal(true,http.Items[SpoilerBlurImageFilter.NoStoreHttpContextItem]);
    }
    [Theory]
    [InlineData("Primary")][InlineData("Thumb")][InlineData("Screenshot")][InlineData("Chapter")]
    public async Task Protected_movie_surfaces_replace_pixels_and_scrub_shared_cache_headers(string type)
    {
        using var f=new Fixture(); var bytes=PosterBlurTests.Source();
        var (executed,http)=await f.Run(new FileContentResult(bytes,"image/png"),type);
        var result=Assert.IsType<FileContentResult>(executed.Result);Assert.Equal("image/jpeg",result.ContentType);Assert.NotEqual(bytes,result.FileContents);
        using var image=SKBitmap.Decode(result.FileContents);Assert.Equal(96,image.Width);Private(http,type=="Chapter");
    }
    [Theory]
    [InlineData("blur")][InlineData("hide")]
    public async Task Corrupt_protected_images_fail_closed_in_both_modes(string mode)
    {
        using var f=new Fixture(); f.Plugin.Plugin.Configuration.SpoilerBlurMode=mode;
        var (executed,http)=await f.Run(new FileContentResult([1,2,3],"image/png"));
        var result=Assert.IsType<FileContentResult>(executed.Result); using var image=SKBitmap.Decode(result.FileContents);Assert.NotNull(image);Private(http);
    }
    [Fact]
    public async Task Stream_read_failure_returns_structural_fallback()
    {
        using var f=new Fixture();using var stream=new MemoryStream(PosterBlurTests.Source());stream.Dispose();
        var(executed,http)=await f.Run(new FileStreamResult(stream,"image/png"));
        var result=Assert.IsType<FileContentResult>(executed.Result);using var image=SKBitmap.Decode(result.FileContents);Assert.Equal(16,image.Width);Private(http);
    }
    [Theory]
    [InlineData(true,false,"Primary")][InlineData(false,true,"Primary")][InlineData(false,false,"Backdrop")]
    public async Task Watched_exempt_posters_and_disabled_artwork_keep_bytes_but_disallow_public_cache(bool watched,bool keep,string type)
    {
        using var f=new Fixture(); f.Plugin.Plugin.Configuration.SpoilerKeepMoviePosters=keep;f.Plugin.Plugin.Configuration.SpoilerBlurArtwork=false;
        f.UserData.Setup(u=>u.GetUserData(f.User,f.Movie)).Returns(new UserItemData{Key="movie",Played=watched});
        var original=new FileContentResult(PosterBlurTests.Source(),"image/png");var(executed,http)=await f.Run(original,type);Assert.Same(original,executed.Result);Private(http);
    }
    [Fact]
    public async Task Head_preserves_body_result_but_scrubs_cache()
    {
        using var f=new Fixture();var original=new FileContentResult(PosterBlurTests.Source(),"image/png");var(executed,http)=await f.Run(original,method:"HEAD");Assert.Same(original,executed.Result);Private(http);
    }
    [Theory]
    [InlineData("Logo","Image","GetItemImage")][InlineData("Primary","Items","GetItems")][InlineData("Primary","Image","OtherAction")]
    public async Task Unrelated_routes_or_image_types_are_untouched(string type,string controller,string action)
    {
        using var f=new Fixture();var original=new FileContentResult(PosterBlurTests.Source(),"image/png");var(executed,http)=await f.Run(original,type,controller:controller,action:action);
        Assert.Same(original,executed.Result);Assert.Equal("original",http.Response.Headers.ETag.ToString());Assert.False(http.Items.ContainsKey(SpoilerBlurImageFilter.NoStoreHttpContextItem));
    }
    [Fact]
    public async Task Guarded_users_cached_blur_does_not_leak_into_other_users_response()
    {
        using var f=new Fixture();var original=new FileContentResult(PosterBlurTests.Source(),"image/png");var(first,_)=await f.Run(original);Assert.NotSame(original,first.Result);
        var(second,http)=await f.Run(original,viewer:Guid.NewGuid());Assert.Same(original,second.Result);Assert.Equal("original",http.Response.Headers.ETag.ToString());
    }
    [Fact]
    public async Task Different_size_query_parameters_cannot_reuse_wrong_image_dimensions()
    {
        using var f=new Fixture();var(first,_)=await f.Run(new FileContentResult(PosterBlurTests.Source(64,32),"image/png"),query:"?maxWidth=64");
        var(second,_)=await f.Run(new FileContentResult(PosterBlurTests.Source(32,64),"image/png"),query:"?maxHeight=64");
        using var a=SKBitmap.Decode(Assert.IsType<FileContentResult>(first.Result).FileContents);using var b=SKBitmap.Decode(Assert.IsType<FileContentResult>(second.Result).FileContents);
        Assert.Equal(64,a.Width);Assert.Equal(32,b.Width);Assert.Equal(64,b.Height);
    }
    [Theory]
    [InlineData(99L,true)][InlineData(100L,false)][InlineData(101L,false)]
    public async Task Chapters_reveal_only_strictly_before_resume_position(long chapterStart,bool reveal)
    {
        using var f=new Fixture();
        f.UserData.Setup(u=>u.GetUserData(f.User,f.Movie)).Returns(new UserItemData{Key="movie",PlaybackPositionTicks=100});
        f.Chapters.Setup(c=>c.GetChapter(f.Movie.Id,0)).Returns(new MediaBrowser.Model.Entities.ChapterInfo{StartPositionTicks=chapterStart});
        var original=new FileContentResult(PosterBlurTests.Source(),"image/png");var(executed,http)=await f.Run(original,"Chapter");
        Assert.Equal(reveal,ReferenceEquals(original,executed.Result));Private(http,true);
    }
    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task Disabled_master_or_user_without_scope_preserves_original(bool disableMaster)
    {
        using var f=new Fixture(guarded:disableMaster);f.Plugin.Plugin.Configuration.SpoilerBlurEnabled=!disableMaster;
        var original=new FileContentResult(PosterBlurTests.Source(),"image/png");var(executed,http)=await f.Run(original);
        Assert.Same(original,executed.Result);Assert.Equal("original",http.Response.Headers.ETag.ToString());
    }
    [Theory]
    [InlineData("stream")][InlineData("physical")][InlineData("virtual")]
    public async Task All_supported_file_result_shapes_are_protected(string shape)
    {
        using var f=new Fixture();var bytes=PosterBlurTests.Source();var path=Path.Combine(f.Plugin.Core.Root,"spoiler.png");await File.WriteAllBytesAsync(path,bytes);
        using var stream=new MemoryStream(bytes);
        IActionResult original=shape switch {"stream"=>new FileStreamResult(stream,"image/png"),"physical"=>new PhysicalFileResult(path,"image/png"),_=>new VirtualFileResult(path,"image/png")};
        var(executed,http)=await f.Run(original);var result=Assert.IsType<FileContentResult>(executed.Result);Assert.NotEqual(bytes,result.FileContents);Private(http);
    }

    [Fact]
    public async Task Replaced_stream_result_disposes_original_stream()
    {
        using var f=new Fixture();using var stream=new MemoryStream(PosterBlurTests.Source());
        var(executed,_)=await f.Run(new FileStreamResult(stream,"image/png"));
        Assert.IsType<FileContentResult>(executed.Result);
        Assert.False(stream.CanRead);
    }

    [Theory]
    [InlineData("HEAD",false)][InlineData("GET",true)]
    public async Task Unreplaced_stream_result_retains_mvc_ownership(string method,bool empty)
    {
        using var f=new Fixture();using var stream=new MemoryStream(empty?[]:PosterBlurTests.Source());var original=new FileStreamResult(stream,"image/png");
        var(executed,_)=await f.Run(original,method:method);Assert.Same(original,executed.Result);Assert.True(stream.CanRead);
    }

}
