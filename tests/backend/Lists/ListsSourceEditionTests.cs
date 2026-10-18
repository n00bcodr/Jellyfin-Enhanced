using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Model Jellyfin's two different grouping mechanisms: alternate MediaSources on a movie/episode, and one presentation
// representative for several physical Series folders. Exercise the production host, not a parallel fake resolver.
[Collection("Plugin singleton")]
public class ListsSourceEditionTests
{
    private sealed class SourceMovie : Movie
    {
        public List<MediaSourceInfo> Sources { get; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private sealed class SourceEpisode : Episode
    {
        public List<MediaSourceInfo> Sources { get; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private sealed class Library : IDisposable
    {
        public CoreFixture Core { get; } = new();
        public List<BaseItem> Items { get; } = new();
        public HashSet<Guid> Hidden { get; } = new();
        public HashSet<Guid> Alternates { get; } = new();
        public bool ExpandGroupedEpisodes { get; set; }
        public Mock<ILibraryManager> Manager { get; } = new();
        public JellyfinListHost Host { get; }
        public ListResolver Resolver { get; }

        public Library()
        {
            Manager.Setup(m => m.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.FirstOrDefault(i => i.Id == id));
            Manager.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User>()))
                .Returns((Guid id, User _) => Hidden.Contains(id) ? null : Items.FirstOrDefault(i => i.Id == id));
            Manager.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery query) => Query(query).ToArray());
            Host = new JellyfinListHost(Manager.Object, Mock.Of<IPlaylistManager>(), Mock.Of<ICollectionManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
            Resolver = new ListResolver(Host, Core.Logger);
        }

        private IEnumerable<BaseItem> Query(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> result = Items.Where(i => !Alternates.Contains(i.Id) && !Hidden.Contains(i.Id));
            if (q.IncludeItemTypes?.Length > 0) result = result.Where(i => q.IncludeItemTypes.Contains(i switch
            {
                MediaBrowser.Controller.Entities.Movies.Movie => BaseItemKind.Movie,
                MediaBrowser.Controller.Entities.TV.Episode => BaseItemKind.Episode,
                MediaBrowser.Controller.Entities.TV.Series => BaseItemKind.Series,
                _ => i.GetBaseItemKind(),
            }));
            if (q.HasAnyProviderId?.Count > 0) result = result.Where(i => q.HasAnyProviderId.Any(p => i.ProviderIds.TryGetValue(p.Key, out var v) && v == p.Value));
            if (q.AncestorIds?.Length > 0)
            {
                var ancestors = q.AncestorIds.ToHashSet();
                if (ExpandGroupedEpisodes)
                {
                    var groups = Items.OfType<Series>().Where(s => ancestors.Contains(s.Id)).Select(s => s.PresentationUniqueKey).ToHashSet();
                    ancestors.UnionWith(Items.OfType<Series>().Where(s => groups.Contains(s.PresentationUniqueKey)).Select(s => s.Id));
                }

                result = result.Where(i => i is Episode e && ancestors.Contains(e.SeriesId));
            }
            if (q.ParentIndexNumber.HasValue) result = result.OfType<Episode>().Where(e => e.ParentIndexNumber == q.ParentIndexNumber);
            // Jellyfin groups series unless the caller explicitly asks for physical items.
            if (q.GroupByPresentationUniqueKey != false)
                result = result.GroupBy(i => i is Series s ? s.PresentationUniqueKey : i.Id.ToString()).Select(g => g.First());
            return result;
        }

        public Series Series(int tmdb, string group)
        {
            var series = new Series { Id = Guid.NewGuid(), PresentationUniqueKey = group, ProviderIds = new() { ["Tmdb"] = tmdb.ToString() } };
            Items.Add(series);
            return series;
        }

        public SourceEpisode Episode(Series series, int number, bool fourK = false)
        {
            var item = new SourceEpisode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = number, Width = fourK ? 3840 : 1920, Height = fourK ? 2160 : 1080, Path = "/media/" + Guid.NewGuid() + ".mkv" };
            item.Sources.Add(Source(item, fourK));
            Items.Add(item);
            return item;
        }

        public SourceMovie Movie(int tmdb, bool fourK = false)
        {
            var item = new SourceMovie { Id = Guid.NewGuid(), Width = fourK ? 3840 : 1920, Height = fourK ? 2160 : 1080, Path = "/media/" + Guid.NewGuid() + ".mkv", ProviderIds = new() { ["Tmdb"] = tmdb.ToString() } };
            item.Sources.Add(Source(item, fourK));
            Items.Add(item);
            return item;
        }

        public static MediaSourceInfo Source(BaseItem item, bool fourK) => new()
        {
            Id = item.Id.ToString("N"), Path = item.Path,
            MediaStreams = [new() { Type = MediaStreamType.Video, Width = fourK ? 3840 : 1920, Height = fourK ? 2160 : 1080 }],
            SupportsDirectPlay = true,
        };

        public void Dispose() => Core.Dispose();
    }

    private static Placeholder Tv(int tmdb, string kind = "series", bool fourK = true) =>
        Ph($"{{\"kind\":\"{kind}\",\"tmdbId\":{tmdb},\"title\":\"Show\",\"edition\":\"{(fourK ? "4k" : "standard")}\""
            + (kind == "series" ? "" : ",\"seasonNumber\":1")
            + (kind == "episodes" ? ",\"episodes\":[{\"s\":1,\"e\":2}]" : "") + "}");

    [Fact]
    public void AFourKWholeSeriesCollectionDoesNotTakeAnHdOnlyShow()
    {
        using var f = new Library();
        var hd = f.Series(100, "hd");
        f.Episode(hd, 1);
        Assert.False(f.Resolver.Resolve(Tv(100), ListKinds.Collection, Array.Empty<User>()).Found);
        var uhd = f.Series(100, "uhd");
        f.Episode(uhd, 1, fourK: true);
        Assert.Equal(uhd.Id, Assert.Single(f.Resolver.Resolve(Tv(100), ListKinds.Collection, Array.Empty<User>()).Items).ItemId);
    }

    [Fact]
    public void GroupedQueriesCreditAnEpisodesOwnPhysicalSeriesAndNeverAHiddenSibling()
    {
        using var f = new Library { ExpandGroupedEpisodes = true };
        var hd = f.Series(104, "group");
        var uhd = f.Series(104, "group");
        f.Episode(hd, 1);
        var fourK = f.Episode(uhd, 2, fourK: true);
        var viewer = FakeListHost.MakeUser("viewer");

        Assert.Equal(uhd.Id, Assert.Single(f.Resolver.Resolve(Tv(104), ListKinds.Collection, new[] { viewer }).Items).ItemId);
        Assert.Equal(uhd.Id, f.Host.GetEpisodes(hd.Id, null, viewer).Single(e => e.Id == fourK.Id).SeriesId);
        f.Hidden.Add(uhd.Id);
        Assert.False(f.Resolver.Resolve(Tv(104), ListKinds.Collection, new[] { viewer }).Found);
    }

    [Theory]
    [InlineData("movie", ListKinds.Playlist)]
    [InlineData("movie", ListKinds.Collection)]
    [InlineData("series", ListKinds.Playlist)]
    [InlineData("series", ListKinds.Collection)]
    [InlineData("season", ListKinds.Playlist)]
    [InlineData("season", ListKinds.Collection)]
    [InlineData("episodes", ListKinds.Playlist)]
    public void AFourKAlternateIsSelectedAsThePlayableItemAndNeverThroughAnInaccessibleSource(string kind, string listKind)
    {
        using var f = new Library();
        BaseItem primary;
        BaseItem alternate;
        List<MediaSourceInfo> sources;
        Placeholder scope;
        if (kind == "movie")
        {
            var movie = f.Movie(101);
            primary = movie;
            alternate = f.Movie(101, fourK: true);
            sources = movie.Sources;
            scope = Movie(101);
            scope.Edition = "4k";
        }
        else
        {
            var series = f.Series(101, "show");
            var episode = f.Episode(series, 2);
            primary = episode;
            alternate = f.Episode(series, 2, fourK: true);
            sources = episode.Sources;
            scope = Tv(101, kind);
        }
        f.Alternates.Add(alternate.Id);
        sources.Add(Library.Source(alternate, true));
        var viewer = FakeListHost.MakeUser("viewer");

        var selected = f.Resolver.Resolve(scope, listKind, new[] { viewer });
        Assert.Equal(alternate.Id, Assert.Single(selected.Items).ItemId);
        Assert.NotEqual(primary.Id, selected.Items[0].ItemId); // inserting the HD primary would still play HD
        f.Hidden.Add(alternate.Id);
        Assert.False(f.Resolver.Resolve(scope, listKind, new[] { viewer }).Found);
    }

    [Theory]
    [InlineData("series", false)]
    [InlineData("season", false)]
    [InlineData("episodes", false)]
    [InlineData("series", true)]
    [InlineData("season", true)]
    [InlineData("episodes", true)]
    public void EveryPhysicalFolderOfAPresentationGroupContributesItsQualifyingEpisodes(string kind, bool fourK)
    {
        using var f = new Library();
        var first = f.Series(102, "group");
        var second = f.Series(102, "group");
        var ep1 = f.Episode(first, 1, fourK);
        var ep2 = f.Episode(second, 2, fourK);
        // Grouping must not make the HD sibling's third episode count for a 4K scope.
        var ep3 = f.Episode(first, 3);

        var resolved = f.Resolver.Resolve(Tv(102, kind, fourK), ListKinds.Playlist, new[] { FakeListHost.MakeUser("viewer") });
        var expected = kind == "episodes" ? new[] { ep2.Id } : fourK ? new[] { ep1.Id, ep2.Id } : new[] { ep1.Id, ep2.Id, ep3.Id };
        Assert.Equal(expected, resolved.Items.Select(i => i.ItemId));
        f.Hidden.Add(second.Id);
        Assert.DoesNotContain(ep2.Id, f.Resolver.Resolve(Tv(102, kind, fourK), ListKinds.Playlist, new[] { FakeListHost.MakeUser("viewer") }).Items.Select(i => i.ItemId));
    }

    [Fact]
    public void VirtualAndUnplayableFourKSourcesNeverMakeAnEditionAvailable()
    {
        using var f = new Library();
        var movie = f.Movie(103, fourK: true);
        var scope = Movie(103);
        scope.Edition = "4k";
        movie.IsVirtualItem = true;
        Assert.False(f.Resolver.Resolve(scope, ListKinds.Playlist, Array.Empty<User>()).Found);
        movie.IsVirtualItem = false;
        movie.Sources.Clear();
        movie.Path = string.Empty;
        Assert.False(f.Resolver.Resolve(scope, ListKinds.Playlist, Array.Empty<User>()).Found);
    }
}
