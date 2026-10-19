using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Moq;

namespace JE.Tests;

/// <summary>Native item lookup can still open database rows after a library's removal. Live roots own availability.</summary>
[Collection("Plugin singleton")]
public class IntegrationEditionOrphanTests
{
    private static readonly TitleKey Matrix = TitleKey.Parse("movie:tmdb:603")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    internal sealed class MovieFile : Movie
    {
        public List<MediaSourceInfo> Files { get; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Files;
    }

    internal sealed class EpisodeFile : Episode
    {
        protected override bool IsActiveRecording() => false;
        public List<MediaSourceInfo> Files { get; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Files;
    }

    internal sealed class Library : IDisposable
    {
        public Mock<ILibraryManager> Manager { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public List<VirtualFolderInfo> Live { get; } = new();
        public Dictionary<Guid, BaseItem> Items { get; } = new();
        public Dictionary<Guid, List<Folder>> Parents { get; } = new();
        public HashSet<Guid> Denied { get; } = new();
        public Dictionary<Guid, User> People { get; } = new();
        public Folder HdRoot { get; } = new CollectionFolder { Id = Guid.NewGuid(), Name = "Movies" };
        public Folder UhdRoot { get; } = new CollectionFolder { Id = Guid.NewGuid(), Name = "Movies 4K" };
        public MovieFile Hd { get; }
        public MovieFile Uhd { get; }
        public ArrJellyfinView View { get; }
        public bool IncludeHd { get; set; }
        private readonly ILibraryManager _previous = BaseItem.LibraryManager;
        private readonly IServerConfigurationManager _previousConfiguration = BaseItem.ConfigurationManager;
        private readonly IFileSystem _previousFileSystem = BaseItem.FileSystem;

        public Library()
        {
            AddRoot(HdRoot); AddRoot(UhdRoot);
            Hd = Movie(HdRoot, 1920); Uhd = Movie(UhdRoot, 3840);
            Manager.Setup(l => l.GetVirtualFolders()).Returns(() => Live.ToList());
            Manager.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns((BaseItem i) => Parents.GetValueOrDefault(i.Id) ?? new());
            Manager.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.GetValueOrDefault(id));
            // Deliberately accepts orphaned media, as the real host's standalone lookup does. Only the library
            // root's own lookup knows its access policy; ancestry/membership is a separate responsibility.
            Manager.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>()))
                .Returns((Guid id, User? _) => Denied.Contains(id) ? null : Items.GetValueOrDefault(id));
            Manager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                q.IncludeItemTypes.Contains(BaseItemKind.Movie) ? (IncludeHd ? new List<BaseItem> { Hd, Uhd } : new List<BaseItem> { Uhd })
                : Items.Values.Where(i => (q.IncludeItemTypes.Contains(BaseItemKind.Series) && i is Series) || (q.IncludeItemTypes.Contains(BaseItemKind.Season) && i is Season) || (q.IncludeItemTypes.Contains(BaseItemKind.Episode) && i is Episode)).ToList());
            Users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => People.GetValueOrDefault(id));
            View = new ArrJellyfinView(Manager.Object, Users.Object);
            BaseItem.LibraryManager = Manager.Object;
            var configuration = new Mock<IServerConfigurationManager>();
            configuration.SetupGet(c => c.Configuration).Returns(new ServerConfiguration());
            BaseItem.ConfigurationManager = configuration.Object;
            var fileSystem = new Mock<IFileSystem>();
            fileSystem.Setup(f => f.IsPathFile(It.IsAny<string>())).Returns(true);
            BaseItem.FileSystem = fileSystem.Object;
            Manager.Setup(m => m.Sort(It.IsAny<IEnumerable<BaseItem>>(), It.IsAny<User?>(), It.IsAny<IEnumerable<ItemSortBy>>(), It.IsAny<SortOrder>()))
                .Returns((IEnumerable<BaseItem> items, User? _, IEnumerable<ItemSortBy> _, SortOrder _) => items);
        }

        public void AddRoot(Folder folder)
        {
            Items[folder.Id] = folder;
            Live.Add(new VirtualFolderInfo { ItemId = folder.Id.ToString("N"), Name = folder.Name, Locations = new[] { "/media/" + folder.Name }, LibraryOptions = new() });
        }

        private MovieFile Movie(Folder root, int width)
        {
            var movie = new MovieFile { Id = Guid.NewGuid(), Name = "The Matrix", Path = $"/media/{root.Name}/The Matrix.mkv", DateCreated = DateTime.UtcNow.AddDays(-1) };
            movie.SetProviderId(MetadataProvider.Tmdb, "603");
            movie.Files.Add(File(movie, width)); Items[movie.Id] = movie; Parents[movie.Id] = new() { root };
            return movie;
        }

        public StatusViewer Person(StatusViewer person)
        {
            People[person.UserId] = (User)person.Handle!;
            return View.Viewer(person.UserId)!;
        }

        public void Change(string state)
        {
            switch (state)
            {
                case "path": Live.Single(f => f.ItemId == UhdRoot.Id.ToString("N")).Locations = new[] { "/media/still-live" }; break;
                case "missing": Parents[Uhd.Id].Clear(); break;
                case "removed": Live.RemoveAll(f => f.ItemId == UhdRoot.Id.ToString("N")); break;
                case "denied": Denied.Add(UhdRoot.Id); break;
                case "disabled": Live.Single(f => f.ItemId == UhdRoot.Id.ToString("N")).LibraryOptions.Enabled = false; break;
            }
        }

        public void Dispose() { View.Dispose(); BaseItem.LibraryManager = _previous; BaseItem.ConfigurationManager = _previousConfiguration; BaseItem.FileSystem = _previousFileSystem; }
    }

    internal static MediaSourceInfo File(Video item, int width) => new()
    {
        Id = item.Id.ToString("N"), Path = item.Path, Protocol = MediaProtocol.File, Type = MediaSourceType.Default,
        MediaStreams = new List<MediaStream> { new() { Type = MediaStreamType.Video, Width = width, Height = width == 3840 ? 2160 : 1080 } },
    };

    [Theory]
    [InlineData("path", false)]
    [InlineData("path", true)]
    [InlineData("missing", false)]
    [InlineData("removed", false)]
    [InlineData("denied", false)]
    [InlineData("disabled", false)]
    [InlineData("missing", true)]
    [InlineData("removed", true)]
    [InlineData("disabled", true)]
    public void OnlyLiveAccessibleRootsCanSupplyCopiesOrSources(string state, bool libraryContext)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(fake.Member);
        l.Change(state);
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
        Assert.DoesNotContain(l.View.Copies(Matrix, viewer).Seen, c => c.Visible);
        Assert.Empty(l.View.Sources(l.Uhd.Id, viewer));
        Assert.Empty(editions.Scope(viewer, Matrix, Edition.Standard));
        Assert.Empty(editions.Scope(viewer, Matrix, Edition.FourK));
        Assert.Empty(editions.ScopeForAll(libraryContext ? Array.Empty<StatusViewer>() : new[] { viewer }, Matrix, Edition.FourK));
    }

    [Theory]
    [InlineData("path")]
    [InlineData("missing")]
    [InlineData("removed")]
    [InlineData("denied")]
    public async Task AnOrphanNeverMakesARequestReadyOrFulfilled(string state)
    {
        using var l = new Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        l.Change(state);
        lab.Policy.Adjust = (_, _, p) => p with { Can4k = true };
        await lab.Warm();
        foreach (var variant in new[] { "standard", "4k" })
        {
            var id = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix.ToString(), Variant = variant });
            await lab.Outbox.TickAsync(default);
            await lab.Fulfilment.CheckAsync(new[] { Matrix.ToString() }, default);
            Assert.NotEqual("fulfilled", lab.Ledger.Find(id)!.Status);
            Assert.NotEqual("ready", (await lab.Page(viewer))[Matrix.ToString()].GetProperty("group").GetString());
        }
    }

    [Theory]
    [InlineData("path")]
    [InlineData("missing")]
    [InlineData("removed")]
    [InlineData("denied")]
    public async Task AnOrphanedLinkedVersionNeverHidesGet4kOrCountsOnThePageOrCard(string state)
    {
        using var l = new Library { IncludeHd = true };
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin);
        l.Hd.Files.Add(File(l.Uhd, 3840));
#if JF12
        l.Manager.Setup(m => m.GetLocalAlternateVersionIds(l.Hd)).Returns(new[] { l.Uhd.Id });
#else
        l.Hd.LocalAlternateVersions = new[] { l.Uhd.Path };
#endif
        l.Change(state);
        await lab.Warm();
        foreach (var (body, details) in new[] { (await lab.Status.ForItemAsync(viewer, l.Hd.Id, default), true), (await lab.Status.ForBatchAsync(viewer, new[] { l.Hd.Id }, Array.Empty<TitleKey>(), default), false) })
        {
            using var doc = JsonDocument.Parse(body!.Json);
            var status = doc.RootElement.GetProperty("items")[0];
            Assert.False(status.TryGetProperty("fourK", out var fourK) && fourK.GetBoolean());
            if (details) Assert.Equal(1, status.GetProperty("versions").GetInt32());
        }
        Assert.DoesNotContain(l.View.Sources(l.Hd.Id, viewer), s => s.Width == 3840);
    }

    [Theory]
    [InlineData("path")]
    [InlineData("missing")]
    [InlineData("removed")]
    [InlineData("denied")]
    public async Task AnOrphanIsNotAnOpenableItemPageOrBadgeCard(string state)
    {
        using var l = new Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin);
        l.Change(state);
        Assert.Null(l.View.Resolve(l.Uhd.Id, viewer));
        foreach (var body in new[] { await lab.Status.ForItemAsync(viewer, l.Uhd.Id, default), await lab.Status.ForBatchAsync(viewer, new[] { l.Uhd.Id }, Array.Empty<TitleKey>(), default) })
        {
            using var doc = JsonDocument.Parse(body.Json);
            Assert.Empty(doc.RootElement.GetProperty("items").EnumerateArray());
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PreviouslyGatheredCopiesCannotLendOrphanedSourcesAndLiveCopiesRemainUnchanged(bool libraryContext)
    {
        using var l = new Library { IncludeHd = true };
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(fake.Member);
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
        var gathered = l.View.Copies(Matrix, viewer).Seen;
        Assert.Equal(2, gathered.Count(c => c.Visible));
        Assert.Single(editions.Movie(viewer, gathered, Edition.FourK));
        Assert.Equal(2, editions.Movie(viewer, gathered, Edition.Standard).Count);
        l.Change("removed");
        Assert.Empty(editions.Movie(viewer, gathered, Edition.FourK));
        Assert.Equal(l.Hd.Id, Assert.Single(editions.Movie(viewer, gathered, Edition.Standard, readDimensions: false)).PlayableItemId);
        l.Hd.Files.Add(File(l.Uhd, 3840));
        l.Manager.Invocations.Clear();
        Assert.Single(l.View.Sources(l.Hd.Id, viewer));
        l.Manager.Verify(m => m.GetVirtualFolders(), Times.Once);
        if (!libraryContext) l.Manager.Verify(m => m.GetItemById<BaseItem>(l.HdRoot.Id, It.IsAny<User?>()), Times.Once);
    }

    [Theory]
    [InlineData("path")]
    [InlineData("removed")]
    public async Task LibraryRemovalInvalidatesCachedEditionStatusWithoutAnItemEvent(string state)
    {
        using var l = new Library { IncludeHd = true };
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin);
        await lab.Warm();
        using var before = JsonDocument.Parse((await lab.Status.ForItemAsync(viewer, l.Hd.Id, default)).Json);
        Assert.True(before.RootElement.GetProperty("items")[0].GetProperty("fourK").GetBoolean());
        // A cancelled cleanup need never send ItemRemoved for the still-present database row.
        l.Change(state);
        using var after = JsonDocument.Parse((await lab.Status.ForItemAsync(viewer, l.Hd.Id, default)).Json);
        Assert.False(after.RootElement.GetProperty("items")[0].TryGetProperty("fourK", out var fourK) && fourK.GetBoolean());
    }

    [Fact]
    public void ReaddingTheSamePathUsesTheCurrentRootAndRefreshesAccessOncePerPass()
    {
        using var l = new Library { IncludeHd = true };
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = l.Person(fake.Member);
        var old = l.UhdRoot; l.Change("removed");
        Assert.DoesNotContain(l.View.Copies(Matrix, viewer).Seen, c => c.Visible && c.ItemId == l.Uhd.Id);
        var readded = new CollectionFolder { Id = Guid.NewGuid(), Name = "Renamed 4K" }; l.AddRoot(readded);
        l.Live.Single(f => f.ItemId == readded.Id.ToString("N")).Locations = new[] { "/media/Movies 4K" };
        // A stale collection row may be listed before the current one. The physical media need not get a new id.
        l.Parents[l.Uhd.Id] = new() { old, readded };
        l.Manager.Invocations.Clear();
        var copy = Assert.Single(l.View.Copies(Matrix, viewer).Seen, c => c.ItemId == l.Uhd.Id);
        Assert.True(copy.Visible); Assert.Equal(readded.Id.ToString("N"), copy.LibraryId);
        l.Manager.Verify(m => m.GetVirtualFolders(), Times.Once);
        l.Manager.Verify(m => m.GetItemById<BaseItem>(readded.Id, It.IsAny<User?>()), Times.Once);
        Assert.Equal(readded.Id.ToString("N"), l.View.Resolve(l.Uhd.Id, viewer)!.LibraryId);
        l.Denied.Add(readded.Id);
        Assert.DoesNotContain(l.View.Copies(Matrix, viewer).Seen, c => c.ItemId == l.Uhd.Id && c.Visible);
        Assert.Contains(l.View.Copies(Matrix, StatusViewer.Library).Seen, c => c.ItemId == l.Uhd.Id && c.Visible);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AGroupedSeriesCannotLendEpisodesFromARemovedLibrary(bool libraryContext)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(fake.Member);
        var series = new Series { Id = Guid.NewGuid(), Path = "/media/Movies 4K/Firefly", PresentationUniqueKey = "firefly" };
        series.SetProviderId(MetadataProvider.Tvdb, "78874");
        var episode = new EpisodeFile { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1, Path = series.Path + "/S01E01.mkv" };
        episode.Files.Add(File(episode, 3840));
        l.Items[series.Id] = series; l.Items[episode.Id] = episode;
        l.Parents[series.Id] = new() { l.UhdRoot }; l.Parents[episode.Id] = new() { l.UhdRoot };
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
        Assert.True(editions.Available(viewer, Firefly.WithEpisode(1, 1), Edition.FourK));
        l.Change("removed");
        Assert.Empty(editions.Scope(viewer, Firefly.WithEpisode(1, 1), Edition.FourK));
        Assert.Empty(l.View.EpisodeSources(series.Id, 1, viewer));
        Assert.False(editions.AvailableRange(viewer, Firefly, 1, 1, 1, Edition.Standard));
    }
    private static (Series Live, Series Orphan, Season Season, EpisodeFile Episode) GroupedRows(Library l)
    {
        var live = new Series { Id = Guid.NewGuid(), Path = "/media/Movies/Firefly", PresentationUniqueKey = "firefly" };
        var orphan = new Series { Id = Guid.NewGuid(), Path = "/media/Movies 4K/Firefly", PresentationUniqueKey = "firefly" };
        live.SetProviderId(MetadataProvider.Tvdb, "78874"); orphan.SetProviderId(MetadataProvider.Tvdb, "78874");
        var season = new Season { Id = Guid.NewGuid(), SeriesId = live.Id, ParentId = orphan.Id, IndexNumber = 2, Path = orphan.Path + "/Season 02", SeriesPresentationUniqueKey = "firefly" };
        var episode = new EpisodeFile { Id = Guid.NewGuid(), SeriesId = live.Id, ParentId = season.Id, ParentIndexNumber = 2, IndexNumber = 1, Path = season.Path + "/S02E01.mkv", SeriesPresentationUniqueKey = "firefly" };
        episode.Files.Add(File(episode, 3840));
        foreach (var i in new BaseItem[] { live, orphan, season, episode })
        {
            l.Items[i.Id] = i; l.Parents[i.Id] = new() { i == live ? l.HdRoot : l.UhdRoot };
        }
        return (live, orphan, season, episode);
    }

    [Theory]
    [InlineData("Copies")]
    [InlineData("Resolve")]
    [InlineData("Sources")]
    [InlineData("Sources-fast")]
    [InlineData("Linked-sources")]
    [InlineData("Linked-path")]
    [InlineData("Episodes")]
    [InlineData("Episodes-season")]
    [InlineData("Seasons")]
    [InlineData("SeriesParts-season")]
    [InlineData("SeriesParts-episode")]
    [InlineData("VersionHolder")]
    [InlineData("EpisodeSources")]
    [InlineData("EpisodeSources-fast")]
    [InlineData("GroupedSeries")]
    [InlineData("ScopeForAll")]
    [InlineData("AvailableRange")]
    public void EveryNativeQueryRejectsARowOutsideCurrentLocations(string entry)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = l.Person(fake.Member);
        var rows = GroupedRows(l);
        l.Hd.Files.Add(File(l.Uhd, 3840));
        l.Manager.Setup(m => m.FindByPath(l.Uhd.Path, false)).Returns(l.Uhd);
        l.Change("path"); // Same live collection id, stale native collection mapping.
        l.Manager.Invocations.Clear();
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
        switch (entry)
        {
            case "Copies": Assert.True(l.View.Copies(Matrix, viewer).IsProvenAbsent); break;
            case "Resolve": Assert.Null(l.View.Resolve(l.Uhd.Id, viewer)); break;
            case "Sources": Assert.Empty(l.View.Sources(l.Uhd.Id, viewer)); break;
            case "Sources-fast": Assert.Empty(l.View.Sources(l.Uhd.Id, viewer, false)); break;
            case "Linked-sources": Assert.DoesNotContain(l.View.Sources(l.Hd.Id, viewer), x => x.Width == 3840); break;
            case "Linked-path":
                l.Hd.Files[1].Id = "path-only";
                Assert.DoesNotContain(l.View.Sources(l.Hd.Id, viewer), x => x.Width == 3840); break;
            case "Episodes": Assert.Empty(l.View.Episodes(rows.Live.Id, null, viewer, true)); break;
            case "Episodes-season": Assert.Empty(l.View.Episodes(rows.Live.Id, 2, viewer, true)); break;
            case "Seasons": Assert.Empty(l.View.Seasons(rows.Live.Id, viewer)); break;
            case "SeriesParts-season": Assert.Empty(l.View.SeriesParts(rows.Live.Id, 2, null, viewer)); break;
            case "SeriesParts-episode": Assert.Empty(l.View.SeriesParts(rows.Live.Id, 2, 1, viewer)); break;
            case "VersionHolder":
                l.Uhd.LinkedAlternateVersions = new[] { new LinkedChild { ItemId = l.Hd.Id } };
                Assert.Null(l.View.VersionHolder(l.Hd.Id, new[] { l.Uhd.Id }, viewer)); break;
            case "EpisodeSources": Assert.Empty(l.View.EpisodeSources(rows.Live.Id, null, viewer)); break;
            case "EpisodeSources-fast": Assert.Empty(l.View.EpisodeSources(rows.Live.Id, null, viewer, false)); break;
            case "GroupedSeries": Assert.Empty(l.View.GroupedSeries(rows.Live.Id, viewer)); break;
            case "ScopeForAll": Assert.Empty(editions.ScopeForAll(Array.Empty<StatusViewer>(), Matrix, Edition.FourK)); break;
            case "AvailableRange": Assert.False(editions.AvailableRange(viewer, Firefly, 2, 1, 1, Edition.FourK)); break;
        }
        // Each public lookup takes one topology/access snapshot even for grouped/linked children.
        l.Manager.Verify(m => m.GetVirtualFolders(), Times.Exactly(entry == "AvailableRange" ? 2 : 1));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GroupedOrphansNeverBecomeReadyEpisodesOrHiddenPolicyMarkers(bool parental)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var person = (User)fake.Member.Handle!;
        if (parental) person.MaxParentalRatingScore = 100;
        var viewer = l.Person(fake.Member);
        var rows = GroupedRows(l);
        l.Change("path");
        var episodes = l.View.Episodes(rows.Live.Id, null, viewer, true);
        var seasons = l.View.Seasons(rows.Live.Id, viewer);
        Assert.Empty(episodes); Assert.Empty(seasons);
        var c = new ComposeContext(viewer, DateTime.UtcNow, 24);
        var copy = new ArrCopyFacts(new Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrConnection { Kind = Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrKind.Sonarr });
        Assert.Empty(StatusComposer.EpisodeStates(copy, 2, episodes, c));
        var status = StatusComposer.Series(new TitleFacts(Firefly), l.View.Resolve(rows.Live.Id, viewer)!, episodes, seasons, c, true);
        Assert.NotEqual(StatusStage.Ready, status.Stage);
    }

    [Theory]
    [InlineData("/media/Movies 4K-other/file.mkv")]
    [InlineData("/media/Movies 4K/../removed/file.mkv")]
    public void PhysicalAncestryRequiresACompleteNormalizedDirectoryBoundary(string path)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        l.Uhd.Path = path;
        Assert.True(l.View.Copies(Matrix, l.Person(fake.Member)).IsProvenAbsent);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void VirtualRowsUseTheirOwnPhysicalParentAncestry(bool removed)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = l.Person(fake.Member);
        var rows = GroupedRows(l);
        rows.Season.Path = null; rows.Season.IsVirtualItem = true;
        rows.Episode.Path = null; rows.Episode.IsVirtualItem = true;
        if (removed) l.Change("path");
        if (removed)
        {
            Assert.Null(l.View.Resolve(rows.Season.Id, viewer));
            Assert.Null(l.View.Resolve(rows.Episode.Id, viewer));
            Assert.Empty(l.View.Episodes(rows.Live.Id, null, viewer, true));
            Assert.Empty(l.View.Seasons(rows.Live.Id, viewer));
        }
        else
        {
            Assert.NotNull(l.View.Resolve(rows.Season.Id, viewer));
            Assert.NotNull(l.View.Resolve(rows.Episode.Id, viewer));
            Assert.Single(l.View.Episodes(rows.Live.Id, null, viewer, true));
            Assert.Single(l.View.Seasons(rows.Live.Id, viewer));
        }
        // Native LocationType.Virtual also follows from an absent path, independently of the stored flag.
        rows.Season.IsVirtualItem = false; rows.Episode.IsVirtualItem = false;
        Assert.Equal(!removed, l.View.Resolve(rows.Season.Id, viewer) != null);
        Assert.Equal(!removed, l.View.Resolve(rows.Episode.Id, viewer) != null);
    }

    [Fact]
    public void ASourcesPrimaryIdCannotLendAPathOutsideCurrentLocations()
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var source = File(l.Uhd, 3840); source.Id = l.Hd.Id.ToString("N");
        l.Hd.Files.Add(source);
        l.Manager.Setup(m => m.FindByPath(l.Uhd.Path, false)).Returns(l.Uhd);
        var viewer = l.Person(fake.Member);
        Assert.Equal(2, l.View.Sources(l.Hd.Id, viewer).Count);
        l.Change("path");
        Assert.Single(l.View.Sources(l.Hd.Id, l.Person(fake.Member)));
    }

    /// <summary>A native page really limits BEFORE LibraryOf, including duplicates and retained orphan rows.</summary>
    internal static List<BaseItem> PagedRows(Library l, int orphans, bool series, bool live = true)
    {
        var rows = new List<BaseItem>();
        for (var n = 0; n < orphans; n++)
        {
            BaseItem row = series
                ? new Series { Id = Guid.NewGuid(), Name = $"A orphan {n:D4}", Path = $"/removed/{n}/series" }
                : new MovieFile { Id = Guid.NewGuid(), Name = $"A orphan {n:D4}", Path = $"/removed/{n}/movie.mkv" };
            l.Items[row.Id] = row; l.Parents[row.Id] = new() { l.UhdRoot }; rows.Add(row);
        }
        if (live)
        {
            if (series)
            {
                var row = new Series { Id = Guid.NewGuid(), Name = "Z live", Path = "/media/Movies/Firefly" };
                row.SetProviderId(MetadataProvider.Tvdb, "78874");
                l.Items[row.Id] = row; l.Parents[row.Id] = new() { l.HdRoot }; rows.Add(row);
                var episode = new EpisodeFile { Id = Guid.NewGuid(), SeriesId = row.Id, ParentIndexNumber = 1, IndexNumber = 1, Path = row.Path + "/S01E01.mkv" };
                episode.Files.Add(File(episode, 3840)); l.Items[episode.Id] = episode; l.Parents[episode.Id] = new() { l.HdRoot };
            }
            else rows.Add(l.Uhd);
        }
        l.Manager.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IncludeItemTypes.Contains(BaseItemKind.Episode)
                ? l.Items.Values.OfType<Episode>().Cast<BaseItem>().ToList()
                : rows.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToList());
        return rows;
    }

    [Theory]
    [InlineData("movie", false)]
    [InlineData("movie", true)]
    [InlineData("series", false)]
    [InlineData("series", true)]
    [InlineData("4k", false)]
    [InlineData("4k", true)]
    [InlineData("alias", false)]
    [InlineData("alias", true)]
    public void NativeLimitsCannotHideALiveCopyBehindTwentyOrphans(string entry, bool libraryContext)
    {
        using var l = new Library();
        using var rig = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(rig.Member);
        var rows = PagedRows(l, 20, entry == "series");
        var key = entry == "series" ? Firefly : Matrix;
        IReadOnlyCollection<TitleKey>? aliases = null;
        if (entry == "alias")
        {
            aliases = new[] { TitleKey.Parse("movie:tmdb:604")! };
            l.Manager.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                q.HasAnyProviderId?.GetValueOrDefault("Tmdb") == "604"
                    ? rows.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToList() : new());
        }
        var copies = l.View.Copies(key, viewer, aliases).Seen;
        Assert.Equal(rows.Last().Id, Assert.Single(copies).ItemId);
        if (entry != "alias")
        {
            var editions = new EditionAvailability(l.View, () => rig.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
            Assert.True(editions.Available(viewer, key, entry == "4k" ? Edition.FourK : Edition.Standard));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TwentyFiveOrphansOnlyProveAbsenceAfterExhaustion(bool libraryContext)
    {
        using var l = new Library();
        using var rig = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        PagedRows(l, 25, false, live: false);
        Assert.True(l.View.Copies(Matrix, libraryContext ? StatusViewer.Library : l.Person(rig.Member)).IsProvenAbsent);
        // Check exhaustion, not merely an empty projection from a full native page.
        var queries = l.Manager.Invocations.Where(i => i.Method.Name == "GetItemList").Select(i => (InternalItemsQuery)i.Arguments[0]).ToList();
        Assert.True(queries.Sum(q => q.Limit ?? 0) > 25);
    }

    [Fact]
    public void PagingCountsDistinctEligibleCopiesAcrossAliasesAndATwentyFirstMakesItIncomplete()
    {
        // 21 distinct copies (each listed twice): the budget lists twenty, and the 21st, read but not listed, proves the
        // lookup did not see every copy. It used to read as Found, so a copy the viewer can open past the twenty was
        // taken as absent by every reader that concludes absence (edition round 8).
        using var l = new Library();
        var rows = PagedRows(l, 210, false, live: false);
        for (var n = 0; n < 21; n++)
        {
            var row = new MovieFile { Id = Guid.NewGuid(), Path = $"/media/Movies/{n}.mkv" };
            l.Items[row.Id] = row; l.Parents[row.Id] = new() { l.HdRoot };
            rows.Add(row); rows.Add(row);
        }
        var lookup = l.View.Copies(Matrix, StatusViewer.Library, Enumerable.Range(604, 5).Select(n => TitleKey.Parse("movie:tmdb:" + n)!).ToArray());
        Assert.Equal(CopyLookupOutcome.Incomplete, lookup.Outcome);
        Assert.Empty(lookup.Display);
        var copies = lookup.Seen;
        Assert.Equal(20, copies.Count); Assert.Equal(20, copies.Select(c => c.ItemId).Distinct().Count());
        l.Manager.Verify(m => m.GetItemList(It.IsAny<InternalItemsQuery>()), Times.AtMost(10));
    }

    [Theory]
    [InlineData(100)]
    [InlineData(120)]
    public void AFullFilteredNativePageRequiresAnotherPage(int orphans)
    {
        using var l = new Library();
        var rows = PagedRows(l, orphans, false);
        Assert.Equal(rows.Last().Id, Assert.Single(l.View.Copies(Matrix, StatusViewer.Library).Seen).ItemId);
        var queries = l.Manager.Invocations.Where(i => i.Method.Name == "GetItemList").Select(i => (InternalItemsQuery)i.Arguments[0]).ToList();
        Assert.Equal(new[] { 0, 100 }, queries.Select(q => q.StartIndex ?? 0));
        Assert.All(queries, q => Assert.Equal(new[] { (ItemSortBy.SortName, SortOrder.Ascending), (ItemSortBy.DateCreated, SortOrder.Ascending) }, q.OrderBy));
    }

    [Fact]
    public void AnExactlyFullOrphanPageRequiresAnEmptyPageBeforeAbsence()
    {
        using var l = new Library();
        PagedRows(l, 100, false, live: false);
        Assert.True(l.View.Copies(Matrix, StatusViewer.Library).IsProvenAbsent);
        l.Manager.Verify(m => m.GetItemList(It.IsAny<InternalItemsQuery>()), Times.Exactly(2));
    }

    [Fact]
    public void EveryProviderAliasIsSearchedBeforeAbsence()
    {
        using var l = new Library();
        l.Manager.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.HasAnyProviderId?.GetValueOrDefault("Tmdb") == "608" ? new List<BaseItem> { l.Uhd } : new());
        // Six TMDB ids: six queries (one value of a provider per query), every one searched within the page ceiling.
        var aliases = Enumerable.Range(604, 5).Select(n => TitleKey.Parse("movie:tmdb:" + n)!).ToArray();
        Assert.Equal(l.Uhd.Id, Assert.Single(l.View.Copies(Matrix, StatusViewer.Library, aliases).Seen).ItemId);
        l.Manager.Verify(m => m.GetItemList(It.IsAny<InternalItemsQuery>()), Times.Exactly(6));
    }

}
