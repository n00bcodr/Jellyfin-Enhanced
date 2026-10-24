using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Dto;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46ProjectionReferenceTests
{
    [Fact]
    public void StaleDtoSeriesCannotAuthorizeAnotherTitlesText()
    {
        using var rig=new PrivacyHostShapeModelTests.Rig();
        var episode=rig.Items.Values.OfType<Episode>().First();
        var owner=rig.Items[episode.SeriesId];
        var wrong=new Series {Id=Guid.NewGuid(),Name="other series private title"};
        rig.Items[wrong.Id]=wrong;
        var dto=new BaseItemDto {Id=episode.Id,Type=BaseItemKind.Episode,SeriesId=wrong.Id,SeriesName=wrong.Name,Name="private episode"};
        using var scope=PrivacyReadSet.Begin();
        var projected=PrivacyValues.Guarded(dto,PrivacyReveal.None,new PrivacyValueHost(rig.Library.Object,rig.Localization));
        Assert.True(scope.Reads.Valid(),scope.Reads.Failure);
        Assert.Equal(owner.Name,projected.SeriesName);
        Assert.Equal(wrong.Id,dto.SeriesId); // ingestion owns a snapshot; the caller's DTO stays intact
    }

    [Fact]
    public void NeutralEpisodeNameUsesCanonicalNumberingRatherThanTheCarriedDto()
    {
        using var rig=new PrivacyHostShapeModelTests.Rig();
        var episode=rig.Items.Values.OfType<Episode>().First();
        episode.ParentIndexNumber=2;episode.IndexNumber=4;
        var host=new PrivacyValueHost(rig.Library.Object,rig.Localization);
        var dto=new BaseItemDto {Id=episode.Id,Type=BaseItemKind.Episode,SeriesId=episode.SeriesId,ParentIndexNumber=99,IndexNumber=88,Name="private episode"};
        using var scope=PrivacyReadSet.Begin();
        var stale=PrivacyValues.Guarded(dto,PrivacyReveal.None,host);
        dto.ParentIndexNumber=2;dto.IndexNumber=4;
        var current=PrivacyValues.Guarded(dto,PrivacyReveal.None,host);
        Assert.Equal(current.Name,stale.Name);
        Assert.True(scope.Reads.Valid(),scope.Reads.Failure);
    }

    [Theory]
    [InlineData("Name")]
    [InlineData("SortName")]
    [InlineData("OriginalTitle")]
    public void EntityTextUsedByProjectionIsComparedAtCommit(string field)
    {
        using var rig=new PrivacyHostShapeModelTests.Rig();
        var movie=rig.Items.Values.OfType<MediaBrowser.Controller.Entities.Movies.Movie>().First();
        movie.Name="first name";movie.SortName="first sort";movie.OriginalTitle="first original";
        var dto=new BaseItemDto {Id=movie.Id,Type=BaseItemKind.Movie,Name=movie.Name,SortName=movie.SortName,OriginalTitle=movie.OriginalTitle};
        using var scope=PrivacyReadSet.Begin();
        var projected=PrivacyValues.Guarded(dto,PrivacyReveal.None,new PrivacyValueHost(rig.Library.Object,rig.Localization));
        Assert.True(scope.Reads.Valid(),scope.Reads.Failure);
        if(field=="Name")movie.Name="changed";
        else if(field=="SortName")movie.SortName="changed";
        else movie.OriginalTitle="changed";
        Assert.False(scope.Reads.Valid(),"The construction consumed entity text that changed before commit: "+field);
    }
    [Fact]
    public async Task CarriedChapterTimelineCannotKeepAnOldRevealAtCommit()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items.Values.OfType<MediaBrowser.Controller.Entities.Movies.Movie>().First();
        var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
        state.Movies[movie.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", state);
        var chapters = new Moq.Mock<MediaBrowser.Controller.Chapters.IChapterManager>();
        var timeline = new List<MediaBrowser.Model.Entities.ChapterInfo> {new() {StartPositionTicks = 10}};
        chapters.Setup(c => c.GetChapters(movie.Id)).Returns(() => timeline);
        var identities = new Jellyfin.Plugin.JellyfinEnhanced.Services.RequestIdentityService(
            Moq.Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), rig.Users.Object,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerIdentityService(rig.Users.Object, rig.F.Core.Logger), rig.F.Core.Logger);
        var resolver = new Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerUserResolver(rig.F.Core.Manager, rig.Library.Object, rig.F.Core.Logger, identities);
        using var next = new Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerNextUnwatchedService(rig.Library.Object, rig.Users.Object, rig.UserData.Object, rig.F.Core.Logger);
        var filter = PrivacyTestHost.Create<SpoilerFieldStripFilter>(resolver, rig.Library.Object, rig.Users.Object, rig.UserData.Object, next, rig.Localization, chapters.Object);
        var http = new Microsoft.AspNetCore.Http.DefaultHttpContext {User = TestCallers.Principal(rig.Admin, true)};
        var action = new Microsoft.AspNetCore.Mvc.ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(),
            new Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor {RouteValues = new Dictionary<string,string?> { ["controller"]="Items",["action"]="GetItems" }});
        var dto = new BaseItemDto {Id=movie.Id,Type=BaseItemKind.Movie,UserData=new UserItemDataDto {Key="k",PlaybackPositionTicks=100},
            Chapters=[new() {Name="past chapter",StartPositionTicks=10}]};
        rig.UserData.Setup(d => d.GetUserData(Moq.It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), movie))
            .Returns(new MediaBrowser.Controller.Entities.UserItemData {Key="k",PlaybackPositionTicks=100});
        using var scope = PrivacyReadSet.Begin();
        var result = new Microsoft.AspNetCore.Mvc.ObjectResult(dto);
        await filter.OnActionExecutionAsync(new Microsoft.AspNetCore.Mvc.Filters.ActionExecutingContext(action, [], new Dictionary<string,object?>(), this),
            () => Task.FromResult(new Microsoft.AspNetCore.Mvc.Filters.ActionExecutedContext(action, [], this) {Result=result}));
        Assert.Equal("past chapter", ((BaseItemDto)result.Value!).Chapters![0].Name);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        timeline[0].StartPositionTicks = 20; // same consumed reveal partition
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        timeline[0].StartPositionTicks = 200;
        Assert.False(scope.Reads.Valid());
    }

    [Theory]
    [InlineData(1, 99, true)]
    [InlineData(2, 1, false)]
    public void AdvancedCategoryUsesTheCanonicalSeasonInsteadOfTheCarriedDto(int canonical, int carried, bool revealed)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var boundary = rig.Items.Values.OfType<Episode>().First();
        boundary.ParentIndexNumber=1; boundary.IndexNumber=1;
        var item = new Episode {Id=Guid.NewGuid(),SeriesId=boundary.SeriesId,SeasonId=boundary.SeasonId,ParentIndexNumber=canonical,IndexNumber=2,Name="advanced private title"};
        rig.Items[item.Id]=item;
        rig.Library.Setup(l => l.GetItemList(Moq.It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>()))
            .Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) => q.ItemIds is {Length: > 0}
                ? q.ItemIds.Select(id => rig.Items.GetValueOrDefault(id)).OfType<MediaBrowser.Controller.Entities.BaseItem>().ToList()
                : [boundary]);
        var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
        state.Series[boundary.SeriesId.ToString("N")]=new();
        var cfg=rig.F.Plugin.Configuration;
        cfg.SpoilerAdvancedMode=true; cfg.SpoilerCurrentSeasonStripTitle=false;
        var dto=new BaseItemDto {Id=item.Id,Type=BaseItemKind.Episode,SeriesId=item.SeriesId,SeasonId=item.SeasonId,
            ParentIndexNumber=carried,IndexNumber=2,Name=item.Name,UserData=new() {Key="k",Played=false}};
        using var scope=PrivacyReadSet.Begin();
        var result=rig.Strip.StripLibraryItem(dto,PrivacyIdentities.Of(rig.Library.Object,item),state,cfg,rig.Admin);
        Assert.Equal(revealed,result.Name=="advanced private title");
        Assert.True(scope.Reads.Valid(),scope.Reads.Failure);
    }

    [Fact]
    public async Task ASearchHintsOldEntrySeasonNumberCannotRevealTheCurrentLaterSeason()
    {
        using var rig=new PrivacyHostShapeModelTests.Rig();
        var shot=PrivacyHostShapeModelTests.Data.Shots.Single(s=>s.File=="Search.GetSearchHints.json");
        var user=shot.Viewer=="viewer"?rig.Viewer:rig.Admin;
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r=>r.Id=="sg-series"),user);
        var season=rig.Items.Values.OfType<Season>().First(); season.IndexNumber=2;
        var hint=new MediaBrowser.Model.Search.SearchHint {Id=season.Id,Type=BaseItemKind.Season,IndexNumber=1,Name="private later season"};
        var (_,body)=await PrivacyHostShapeModelTests.Deliver(rig,shot,
            answer:new MediaBrowser.Model.Search.SearchHintResult([hint],1));
        Assert.DoesNotContain("private later season",body);
    }

}
