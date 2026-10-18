using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Entities;
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

    private sealed class MovieFile : Movie
    {
        public List<MediaSourceInfo> Files { get; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Files;
    }

    private sealed class EpisodeFile : Episode
    {
        public List<MediaSourceInfo> Files { get; } = new();
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Files;
    }

    private sealed class Library : IDisposable
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
                : Items.Values.Where(i => q.IncludeItemTypes.Contains(BaseItemKind.Series) ? i is Series : i is Episode).ToList());
            Users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => People.GetValueOrDefault(id));
            View = new ArrJellyfinView(Manager.Object, Users.Object);
            BaseItem.LibraryManager = Manager.Object;
        }

        public void AddRoot(Folder folder)
        {
            Items[folder.Id] = folder;
            Live.Add(new VirtualFolderInfo { ItemId = folder.Id.ToString("N"), Name = folder.Name, LibraryOptions = new() });
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
                case "missing": Parents[Uhd.Id].Clear(); break;
                case "removed": Live.RemoveAll(f => f.ItemId == UhdRoot.Id.ToString("N")); break;
                case "denied": Denied.Add(UhdRoot.Id); break;
                case "disabled": Live.Single(f => f.ItemId == UhdRoot.Id.ToString("N")).LibraryOptions.Enabled = false; break;
            }
        }

        public void Dispose() { View.Dispose(); BaseItem.LibraryManager = _previous; }
    }

    private static MediaSourceInfo File(Video item, int width) => new()
    {
        Id = item.Id.ToString("N"), Path = item.Path, Protocol = MediaProtocol.File, Type = MediaSourceType.Default,
        MediaStreams = new List<MediaStream> { new() { Type = MediaStreamType.Video, Width = width, Height = width == 3840 ? 2160 : 1080 } },
    };

    [Theory]
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
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v));
        Assert.DoesNotContain(l.View.Copies(Matrix, viewer), c => c.Visible);
        Assert.Empty(l.View.Sources(l.Uhd.Id, viewer));
        Assert.Empty(editions.Scope(viewer, Matrix, Edition.Standard));
        Assert.Empty(editions.Scope(viewer, Matrix, Edition.FourK));
        Assert.Empty(editions.ScopeForAll(libraryContext ? Array.Empty<StatusViewer>() : new[] { viewer }, Matrix, Edition.FourK));
    }

    [Theory]
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
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v));
        var gathered = l.View.Copies(Matrix, viewer);
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

    [Fact]
    public async Task LibraryRemovalInvalidatesCachedEditionStatusWithoutAnItemEvent()
    {
        using var l = new Library { IncludeHd = true };
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin);
        await lab.Warm();
        using var before = JsonDocument.Parse((await lab.Status.ForItemAsync(viewer, l.Hd.Id, default)).Json);
        Assert.True(before.RootElement.GetProperty("items")[0].GetProperty("fourK").GetBoolean());
        // A cancelled cleanup need never send ItemRemoved for the still-present database row.
        l.Change("removed");
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
        Assert.DoesNotContain(l.View.Copies(Matrix, viewer), c => c.Visible && c.ItemId == l.Uhd.Id);
        var readded = new CollectionFolder { Id = Guid.NewGuid(), Name = "Renamed 4K" }; l.AddRoot(readded);
        // A stale collection row may be listed before the current one. The physical media need not get a new id.
        l.Parents[l.Uhd.Id] = new() { old, readded };
        l.Manager.Invocations.Clear();
        var copy = Assert.Single(l.View.Copies(Matrix, viewer), c => c.ItemId == l.Uhd.Id);
        Assert.True(copy.Visible); Assert.Equal(readded.Id.ToString("N"), copy.LibraryId);
        l.Manager.Verify(m => m.GetVirtualFolders(), Times.Once);
        l.Manager.Verify(m => m.GetItemById<BaseItem>(readded.Id, It.IsAny<User?>()), Times.Once);
        Assert.Equal(readded.Id.ToString("N"), l.View.Resolve(l.Uhd.Id, viewer)!.LibraryId);
        l.Denied.Add(readded.Id);
        Assert.DoesNotContain(l.View.Copies(Matrix, viewer), c => c.ItemId == l.Uhd.Id && c.Visible);
        Assert.Contains(l.View.Copies(Matrix, StatusViewer.Library), c => c.ItemId == l.Uhd.Id && c.Visible);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AGroupedSeriesCannotLendEpisodesFromARemovedLibrary(bool libraryContext)
    {
        using var l = new Library();
        using var fake = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(fake.Member);
        var series = new Series { Id = Guid.NewGuid(), Path = "/media/tv4k/Firefly", PresentationUniqueKey = "firefly" };
        series.SetProviderId(MetadataProvider.Tvdb, "78874");
        var episode = new EpisodeFile { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1, Path = series.Path + "/S01E01.mkv" };
        episode.Files.Add(File(episode, 3840));
        l.Items[series.Id] = series; l.Items[episode.Id] = episode;
        l.Parents[series.Id] = new() { l.UhdRoot }; l.Parents[episode.Id] = new() { l.UhdRoot };
        var editions = new EditionAvailability(l.View, () => fake.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v));
        Assert.True(editions.Available(viewer, Firefly.WithEpisode(1, 1), Edition.FourK));
        l.Change("removed");
        Assert.Empty(editions.Scope(viewer, Firefly.WithEpisode(1, 1), Edition.FourK));
        Assert.Empty(l.View.EpisodeSources(series.Id, 1, viewer));
        Assert.False(editions.AvailableRange(viewer, Firefly, 1, 1, 1, Edition.Standard));
    }
}
