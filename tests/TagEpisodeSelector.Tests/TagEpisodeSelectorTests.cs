global using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;
using System.Reflection;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Xunit;

public class TagEpisodeSelectorTests
{
    private readonly ILibraryManager _library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    private readonly BaseItem _container = new Series { Id = Guid.NewGuid() };
    private LibraryProxy Library => (LibraryProxy)(object)_library;

    // Only the query used by the selector is supported; unexpected library calls fail.
    public class LibraryProxy : DispatchProxy
    {
        public Func<InternalItemsQuery, IReadOnlyList<BaseItem>> Query { get; set; } =
            _ => throw new InvalidOperationException("No library response configured");
        public int QueryCount { get; private set; }

        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            Assert.Equal(nameof(ILibraryManager.GetItemList), method?.Name);
            var query = Assert.IsType<InternalItemsQuery>(Assert.Single(args!));
            QueryCount++;
            return Query(query);
        }
    }

    private sealed class TestEpisode : Episode
    {
        public List<MediaSourceInfo> Sources { get; set; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private static TestEpisode CreateEpisode(int season, params MediaStreamType[] streams)
    {
        return new TestEpisode
        {
            Id = Guid.NewGuid(),
            ParentIndexNumber = season,
            Sources = new List<MediaSourceInfo>
            {
                new() { MediaStreams = streams.Select(type => new MediaStream { Type = type }).ToList() }
            }
        };
    }

    private void LibraryReturns(params BaseItem[] episodes)
    {
        Library.Query = query => episodes
            .Skip(query.StartIndex ?? 0).Take(query.Limit ?? episodes.Length).ToArray();
    }

    [Fact]
    public void SkipsSourcesWithoutAudioOrVideoStreams()
    {
        var real = CreateEpisode(1, MediaStreamType.Video, MediaStreamType.Audio);
        LibraryReturns(CreateEpisode(1), CreateEpisode(1, MediaStreamType.Subtitle), real);
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library, _container));
    }

    [Fact]
    public void SearchesPastFiftyStreamlessEpisodes()
    {
        var real = CreateEpisode(1, MediaStreamType.Video);
        LibraryReturns(Enumerable.Range(0, 55).Select(_ => CreateEpisode(1)).Append(real).ToArray());
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library, _container));
        Assert.Equal(2, Library.QueryCount);
    }

    [Fact]
    public void PrefersRegularEpisodeEvenWhenSpecialsFillFirstPage()
    {
        var real = CreateEpisode(1, MediaStreamType.Video);
        LibraryReturns(Enumerable.Range(0, 55).Select(_ => CreateEpisode(0, MediaStreamType.Video)).Append(real).ToArray());
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library, _container));
    }

    [Fact]
    public void UsesFirstUsableSpecialWhenNoRegularEpisodeHasStreams()
    {
        var special = CreateEpisode(0, MediaStreamType.Audio);
        LibraryReturns(CreateEpisode(0), special, CreateEpisode(0, MediaStreamType.Video), CreateEpisode(1));
        Assert.Same(special, TagEpisodeSelector.GetFirstEpisode(_library, _container));
    }

    [Fact]
    public void SpecialSeasonStopsAfterItsFirstUsableEpisode()
    {
        var special = CreateEpisode(0, MediaStreamType.Video);
        LibraryReturns(new[] { special }.Concat(
            Enumerable.Range(0, 55).Select(_ => CreateEpisode(0, MediaStreamType.Video))).ToArray());
        var season = new Season { Id = Guid.NewGuid(), IndexNumber = 0 };
        Assert.Same(special, TagEpisodeSelector.GetFirstEpisode(_library, season));
        Assert.Equal(1, Library.QueryCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(50)]
    [InlineData(55)]
    public void ReturnsNullWhenNoUsableEpisodeExists(int count)
    {
        LibraryReturns(Enumerable.Range(0, count).Select(_ => CreateEpisode(1)).ToArray());
        Assert.Null(TagEpisodeSelector.GetFirstEpisode(_library, _container));
    }

    [Fact]
    public void AcceptsStreamsFromAlternateSource()
    {
        var real = CreateEpisode(1);
        real.Sources = new List<MediaSourceInfo>
        {
            new() { MediaStreams = null! },
            new() { MediaStreams = new List<MediaStream> { new() { Type = MediaStreamType.Video } } }
        };
        LibraryReturns(real);
        Assert.Same(real, TagEpisodeSelector.GetFirstEpisode(_library, _container));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FiltersVirtualEpisodesAndPreservesContainerAndUserScope(bool season)
    {
        BaseItem container = season ? new Season { Id = Guid.NewGuid() } : _container;
        var user = new User("test", "provider", "password-reset-provider");
        Library.Query = query =>
        {
            Assert.Same(user, query.User);
            Assert.Equal(container.Id, query.ParentId);
            Assert.False(query.IsVirtualItem);
            Assert.True(query.Recursive);
            Assert.Equal(new[] { BaseItemKind.Episode }, query.IncludeItemTypes);
            return Array.Empty<BaseItem>();
        };
        Assert.Null(TagEpisodeSelector.GetFirstEpisode(_library, container, user));
    }
}
