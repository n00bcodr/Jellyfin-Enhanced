using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Moq;
namespace JE.Tests;

public class PosterEpisodeSelectorTests
{
    private sealed class StreamEpisode : Episode
    {
        public List<MediaSourceInfo> Sources { get; init; }=[];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)=>Sources;
    }
    private static StreamEpisode Episode(int season,params MediaStreamType[] streams)=>new(){Id=Guid.NewGuid(),ParentIndexNumber=season,Sources=[new(){MediaStreams=streams.Select(t=>new MediaStream{Type=t}).ToList()}]};
    private static Mock<ILibraryManager> Library(IReadOnlyList<BaseItem> episodes,List<int> offsets)
    {
        var library=new Mock<ILibraryManager>();
        library.Setup(l=>l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q)=>{offsets.Add(q.StartIndex??0);Assert.Equal(50,q.Limit);Assert.False(q.IsVirtualItem);Assert.True(q.Recursive);Assert.Equal(new[]{BaseItemKind.Episode},q.IncludeItemTypes);return episodes.Skip(q.StartIndex??0).Take(q.Limit??50).ToArray();});
        return library;
    }
    [Theory]
    [InlineData(MediaStreamType.Audio,true)][InlineData(MediaStreamType.Video,true)][InlineData(MediaStreamType.Subtitle,false)][InlineData(MediaStreamType.EmbeddedImage,false)]
    public void Representative_requires_actual_audio_or_video_not_merely_media_source(MediaStreamType stream,bool expected)=>Assert.Equal(expected,TagEpisodeSelector.HasAudioOrVideoStreams(Episode(1,stream)));
    [Fact]
    public void Empty_sources_and_unprobed_files_do_not_supply_tags()
    {
        Assert.False(TagEpisodeSelector.HasAudioOrVideoStreams(new StreamEpisode()));Assert.False(TagEpisodeSelector.HasAudioOrVideoStreams(Episode(1)));
        Assert.False(TagEpisodeSelector.HasAudioOrVideoStreams(new StreamEpisode{Sources=[new(){MediaStreams=null!}]}));
    }
    [Fact]
    public void Selection_walks_past_two_pages_of_unprobed_episodes_and_specials()
    {
        var unusable=Enumerable.Range(0,55).Select(_=>(BaseItem)Episode(1)).ToList();var special=Episode(0,MediaStreamType.Audio);unusable.Add(special);
        unusable.AddRange(Enumerable.Range(0,51).Select(_=>(BaseItem)Episode(0,MediaStreamType.Video)));var regular=Episode(1,MediaStreamType.Video);unusable.Add(regular);
        var offsets=new List<int>();var library=Library(unusable,offsets);var container=new Series{Id=Guid.NewGuid()};var user=new User("test","default","default"){Id=Guid.NewGuid()};
        Assert.Same(regular,TagEpisodeSelector.GetFirstEpisode(library.Object,container,user));Assert.Equal(new[]{0,50,100},offsets);
        library.Verify(l=>l.GetItemList(It.Is<InternalItemsQuery>(q=>q.User==user&&q.ParentId==container.Id)),Times.Exactly(3));
    }
    [Theory]
    [InlineData(false)][InlineData(true)]
    public void Specials_fallback_and_special_season_select_first_usable_special(bool season)
    {
        var first=Episode(0,MediaStreamType.Audio);var second=Episode(0,MediaStreamType.Video);var offsets=new List<int>();var library=Library([Episode(0),first,second],offsets);
        BaseItem container=season?new Season():new Series();Assert.Same(first,TagEpisodeSelector.GetFirstEpisode(library.Object,container));
    }
    [Fact]
    public void Aggregation_visits_every_episode_after_representative_is_found()
    {
        var episodes=Enumerable.Range(0,101).Select(_=>(BaseItem)Episode(1,MediaStreamType.Audio)).ToArray();var offsets=new List<int>();var visited=new List<BaseItem>();var library=Library(episodes,offsets);
        var result=TagEpisodeSelector.ScanEpisodes(library.Object,new Series(),null,ep=>{visited.Add(ep);return TagEpisodeSelector.HasAudioOrVideoStreams(ep);},false);
        Assert.Same(episodes[0],result);Assert.Equal(episodes,visited);Assert.Equal(new[]{0,50,100},offsets);
    }
    [Fact]
    public void All_unusable_or_empty_library_returns_no_representative()
    {
        foreach(var episodes in new BaseItem[][]{[],[Episode(1),Episode(0,MediaStreamType.Subtitle)]}){var offsets=new List<int>();Assert.Null(TagEpisodeSelector.GetFirstEpisode(Library(episodes,offsets).Object,new Series()));}
    }
}
