using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using Moq;

namespace JE.Tests;

/// <summary>
/// The real view's physical folder read (<see cref="ArrJellyfinView.SeriesFolder"/>, edition round 13): two series folders of
/// one show in one library, which Jellyfin's automatic series grouping presents as one (a query by their presentation key
/// returns both folders' children). The read asks Jellyfin by the series item's own ancestry only and keeps exactly that
/// folder's seasons and episodes, missing ones included, never another item's version, and, for a viewer with parental limits,
/// the numbers Jellyfin hides from them there.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionFolderViewTests
{
    private sealed class EpisodeItem : Episode
    {
        protected override bool IsActiveRecording() => false;
    }

    private sealed class Lab : IDisposable
    {
        public Mock<ILibraryManager> Manager { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Dictionary<Guid, BaseItem> Items { get; } = new();
        public Dictionary<Guid, Guid[]> Ancestors { get; } = new();
        public HashSet<Guid> HiddenFromKid { get; } = new();
        public List<InternalItemsQuery> Queries { get; } = new();
        public Folder Root { get; } = new CollectionFolder { Id = Guid.NewGuid(), Name = "TV" };
        public Series Hd { get; }
        public Series Uhd { get; }
        public ArrJellyfinView View { get; }
        public User Kid { get; }
        public User Admin { get; }
        private readonly ILibraryManager _previous = BaseItem.LibraryManager;
        private readonly IServerConfigurationManager _previousConfiguration = BaseItem.ConfigurationManager;
        private readonly IFileSystem _previousFileSystem = BaseItem.FileSystem;

        public Lab()
        {
            Items[Root.Id] = Root;
            Hd = SeriesItem("/media/TV/Firefly");
            Uhd = SeriesItem("/media/TV/Firefly 4K");
            Kid = Person(admin: false);
            Admin = Person(admin: true);
            Manager.Setup(l => l.GetVirtualFolders()).Returns(() => new List<VirtualFolderInfo> { new() { ItemId = Root.Id.ToString("N"), Name = "TV", Locations = new[] { "/media/TV" }, LibraryOptions = new() } });
            Manager.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns(new List<Folder> { Root });
            Manager.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.GetValueOrDefault(id));
            Manager.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>()))
                .Returns((Guid id, User? user) => user?.Id == Kid.Id && HiddenFromKid.Contains(id) ? null : Items.GetValueOrDefault(id));
            Manager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            {
                Queries.Add(q);
                IEnumerable<BaseItem> rows = Items.Values.Where(i => i switch { Series => q.IncludeItemTypes.Contains(BaseItemKind.Series), Season => q.IncludeItemTypes.Contains(BaseItemKind.Season), Episode => q.IncludeItemTypes.Contains(BaseItemKind.Episode), _ => false });
                // Automatic series grouping: Jellyfin's grouped lists (by presentation key) hold both folders' children.
                if (!string.IsNullOrEmpty(q.SeriesPresentationUniqueKey)) rows = rows.Where(i => Ancestors.GetValueOrDefault(i.Id)?.Any(a => a == Hd.Id || a == Uhd.Id) == true);
                if (q.AncestorIds.Length > 0) rows = rows.Where(i => Ancestors.GetValueOrDefault(i.Id)?.Any(q.AncestorIds.Contains) == true);
                // Jellyfin's own parental filter on a query made for the user.
                if (q.User?.Id == Kid.Id) rows = rows.Where(i => !HiddenFromKid.Contains(i.Id));
                return rows.ToList();
            });
            Users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => id == Kid.Id ? Kid : id == Admin.Id ? Admin : null);
            View = new ArrJellyfinView(Manager.Object, Users.Object);
            BaseItem.LibraryManager = Manager.Object;
            var configuration = new Mock<IServerConfigurationManager>();
            configuration.SetupGet(c => c.Configuration).Returns(new ServerConfiguration());
            BaseItem.ConfigurationManager = configuration.Object;
            var fileSystem = new Mock<IFileSystem>();
            fileSystem.Setup(f => f.IsPathFile(It.IsAny<string>())).Returns(true);
            BaseItem.FileSystem = fileSystem.Object;
        }

        private static User Person(bool admin)
        {
            var user = new User(admin ? "admin" : "kid", "default", "default") { Id = Guid.NewGuid() };
            user.SetPermission(PermissionKind.EnableAllFolders, true);
            user.SetPermission(PermissionKind.IsAdministrator, admin);
            if (!admin) user.MaxParentalRatingScore = 10;
            return user;
        }

        private Series SeriesItem(string path)
        {
            var series = new Series { Id = Guid.NewGuid(), Name = "Firefly", Path = path, PresentationUniqueKey = "firefly" };
            series.SetProviderId(MetadataProvider.Tvdb, "78874");
            Items[series.Id] = series;
            Ancestors[series.Id] = new[] { Root.Id };
            return series;
        }

        public Season SeasonOf(Series series, int number)
        {
            var season = new Season { Id = Guid.NewGuid(), Name = "Season " + number, IndexNumber = number, SeriesId = series.Id, ParentId = series.Id, Path = series.Path + "/Season " + number };
            Items[season.Id] = season;
            Ancestors[season.Id] = new[] { series.Id, Root.Id };
            return season;
        }

        /// <summary>An episode of a season: a file, or a missing one (no path); <paramref name="versionOf"/> makes it another item's version.</summary>
        public Episode EpisodeOf(Series series, Season season, int number, bool file = true, Guid? versionOf = null)
        {
            var episode = new EpisodeItem
            {
                Id = Guid.NewGuid(), Name = "E" + number, IndexNumber = number, ParentIndexNumber = season.IndexNumber, SeriesId = series.Id, SeasonId = season.Id, ParentId = season.Id,
                Path = file ? $"{season.Path}/S{season.IndexNumber:00}E{number:00}.mkv" : null, IsVirtualItem = !file, OwnerId = versionOf ?? Guid.Empty,
            };
            Items[episode.Id] = episode;
            Ancestors[episode.Id] = new[] { season.Id, series.Id, Root.Id };
            return episode;
        }

        public StatusViewer Viewer(User user) => View.Viewer(user.Id)!;

        public void Dispose() { View.Dispose(); BaseItem.LibraryManager = _previous; BaseItem.ConfigurationManager = _previousConfiguration; BaseItem.FileSystem = _previousFileSystem; }
    }

    [Fact]
    public void TheFolderReadHoldsExactlyItsOwnSeriesItemsSeasonsAndEpisodes()
    {
        using var lab = new Lab();
        var hd1 = lab.SeasonOf(lab.Hd, 1);
        var hd2 = lab.SeasonOf(lab.Hd, 2);
        var hdE1 = lab.EpisodeOf(lab.Hd, hd1, 1);
        var hdE2 = lab.EpisodeOf(lab.Hd, hd1, 2);
        var hdE3 = lab.EpisodeOf(lab.Hd, hd1, 3, file: false);
        lab.EpisodeOf(lab.Hd, hd1, 2, versionOf: hdE2.Id);
        var hd2E1 = lab.EpisodeOf(lab.Hd, hd2, 1);
        var uhd1 = lab.SeasonOf(lab.Uhd, 1);
        lab.EpisodeOf(lab.Uhd, uhd1, 1);
        lab.EpisodeOf(lab.Uhd, uhd1, 4);
        // The kid's parental limit hides the standard folder's S1E1 and its whole season 2.
        lab.HiddenFromKid.UnionWith(new[] { hdE1.Id, hd2.Id, hd2E1.Id });

        var kid = lab.View.SeriesFolder(lab.Hd.Id, lab.Viewer(lab.Kid));
        var visible = kid.Episodes.Where(e => !e.Hidden).Select(e => (e.ItemId, e.Season, e.Episode, e.Virtual)).OrderBy(e => e.Episode).ToList();
        Assert.Equal(new[] { (hdE2.Id, 1, 2, false), (hdE3.Id, 1, 3, true) }, visible);
        Assert.Equal(new[] { (1, 1), (2, 1) }, kid.Episodes.Where(e => e.Hidden).Select(e => (e.Season, e.Episode)).OrderBy(e => e).ToArray());
        Assert.Equal(new[] { (hd1.Id, 1, false), (Guid.Empty, 2, true) }, kid.Seasons.Select(s => (s.ItemId, s.Season, s.Hidden)).OrderBy(s => s.Season).ToArray());
        Assert.Equal(new[] { (1, 2) }, kid.EpisodesOf(1, includeVirtual: false).Where(e => !e.Hidden).Select(e => (e.Season, e.Episode)).ToArray());

        var admin = lab.View.SeriesFolder(lab.Hd.Id, lab.Viewer(lab.Admin));
        Assert.Equal(new[] { (1, 1), (1, 2), (1, 3), (2, 1) }, admin.Episodes.Select(e => (e.Season, e.Episode)).OrderBy(e => e).ToArray());
        Assert.DoesNotContain(admin.Episodes, e => e.Hidden);

        // Every query asked by the series item's own ancestry, never by the presentation key grouping shares.
        Assert.NotEmpty(lab.Queries);
        Assert.All(lab.Queries.Where(q => q.IncludeItemTypes.Contains(BaseItemKind.Episode)), q =>
        {
            Assert.Equal(new[] { lab.Hd.Id }, q.AncestorIds);
            Assert.True(string.IsNullOrEmpty(q.SeriesPresentationUniqueKey));
        });
    }

    [Fact]
    public void AFolderTheViewerCantOpenReadsAsEmpty()
    {
        using var lab = new Lab();
        var hd1 = lab.SeasonOf(lab.Hd, 1);
        lab.EpisodeOf(lab.Hd, hd1, 1);
        lab.HiddenFromKid.Add(lab.Hd.Id);
        var kid = lab.View.SeriesFolder(lab.Hd.Id, lab.Viewer(lab.Kid));
        Assert.Empty(kid.Episodes);
        Assert.Empty(kid.Seasons);
    }
}
