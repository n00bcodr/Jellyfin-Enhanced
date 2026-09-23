global using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Moq;
using Xunit;

public class TagEpisodeSelectorTests
{
    private readonly Mock<ILibraryManager> _library = new(MockBehavior.Strict);
    private readonly BaseItem _container = new Series { Id = Guid.NewGuid() };

    private static BaseItem Episode(int season, params MediaStreamType[] streams)
    {
        var episode = new Mock<Episode>();
        episode.Object.Id = Guid.NewGuid();
        episode.Object.ParentIndexNumber = season;
        episode.Setup(e => e.GetMediaSources(false)).Returns(new List<MediaSourceInfo>
        {
            new() { MediaStreams = streams.Select(type => new MediaStream { Type = type }).ToList() }
        });
        return episode.Object;
    }

    private void LibraryReturns(params BaseItem[] episodes)
    {
        _library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery query) => episodes
                .Skip(query.StartIndex ?? 0).Take(query.Limit ?? episodes.Length).ToArray());
    }

    [Fact]
    public void SkipsSourcesWithoutAudioOrVideoStreams()
    {
        var real = Episode(1, MediaStreamType.Video, MediaStreamType.Audio);
        LibraryReturns(Episode(1), Episode(1, MediaStreamType.Subtitle), real);
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library.Object, _container));
    }

    [Fact]
    public void SearchesPastFiftyStreamlessEpisodes()
    {
        var real = Episode(1, MediaStreamType.Video);
        LibraryReturns(Enumerable.Range(0, 55).Select(_ => Episode(1)).Append(real).ToArray());
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library.Object, _container));
        _library.Verify(l => l.GetItemList(It.IsAny<InternalItemsQuery>()), Times.Exactly(2));
    }

    [Fact]
    public void PrefersRegularEpisodeEvenWhenSpecialsFillFirstPage()
    {
        var real = Episode(1, MediaStreamType.Video);
        LibraryReturns(Enumerable.Range(0, 55).Select(_ => Episode(0, MediaStreamType.Video)).Append(real).ToArray());
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library.Object, _container));
    }

    [Fact]
    public void UsesFirstUsableSpecialWhenNoRegularEpisodeHasStreams()
    {
        var special = Episode(0, MediaStreamType.Audio);
        LibraryReturns(Episode(0), special, Episode(0, MediaStreamType.Video), Episode(1));
        Assert.Same(special, TagEpisodeSelector.GetFirstEpisode(_library.Object, _container));
    }

    [Fact]
    public void SpecialSeasonStopsAfterItsFirstUsableEpisode()
    {
        var special = Episode(0, MediaStreamType.Video);
        LibraryReturns(new[] { special }.Concat(
            Enumerable.Range(0, 55).Select(_ => Episode(0, MediaStreamType.Video))).ToArray());
        var season = new Season { Id = Guid.NewGuid(), IndexNumber = 0 };
        Assert.Same(special, TagEpisodeSelector.GetFirstEpisode(_library.Object, season));
        _library.Verify(l => l.GetItemList(It.IsAny<InternalItemsQuery>()), Times.Once);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(50)]
    [InlineData(55)]
    public void ReturnsNullWhenNoUsableEpisodeExists(int count)
    {
        LibraryReturns(Enumerable.Range(0, count).Select(_ => Episode(1)).ToArray());
        Assert.Null(TagEpisodeSelector.GetFirstEpisode(_library.Object, _container));
    }

    [Fact]
    public void AcceptsStreamsFromAlternateSource()
    {
        var real = Episode(1);
        Mock.Get(real as Episode ?? throw new InvalidOperationException())
            .Setup(e => e.GetMediaSources(false)).Returns(new List<MediaSourceInfo>
            {
                new() { MediaStreams = null! },
                new() { MediaStreams = new List<MediaStream> { new() { Type = MediaStreamType.Video } } }
            });
        LibraryReturns(real);
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library.Object, _container));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FiltersVirtualEpisodesAndPreservesContainerAndUserScope(bool season)
    {
        BaseItem container = season ? new Season { Id = Guid.NewGuid() } : _container;
        var user = new User("test", "provider", "password-reset-provider");
        _library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery query) =>
            {
                Assert.Same(user, query.User);
                Assert.Equal(container.Id, query.ParentId);
                Assert.False(query.IsVirtualItem);
                Assert.True(query.Recursive);
                Assert.Equal(new[] { BaseItemKind.Episode }, query.IncludeItemTypes);
                return Array.Empty<BaseItem>();
            });
        Assert.Null(TagEpisodeSelector.GetFirstEpisode(_library.Object, container, user));
    }
}
