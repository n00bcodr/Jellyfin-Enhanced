using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

/// <summary>
/// The one import readiness gate (<see cref="BridgeImportReadiness"/>, Requests &amp; downloads, bridge): a just-imported
/// copy Jellyfin already lists is "Almost ready" everywhere (status, request fulfilment, notifications, the Ready
/// playlist's edition scope, list swap-in) until the bridge publishes it after reading its metadata back, and every one
/// of them wakes once when it is published. Through the real Jellyfin view, the real list host and the real bridge.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationBridgeReadinessTests
{
    private const string Matrix = "movie:tmdb:603";
    private const string MatrixFile = "/media/movies/The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv";

    private static async Task Until(Func<bool> check, int ms = 10000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (!check() && DateTime.UtcNow < end) await Task.Delay(10);
    }

    // ------------------------------------------------------------------ the gate itself

    [Fact]
    public void TheGateHoldsAnImportByPathThenByItemAndPublishesOnlyTheCurrentImportOnce()
    {
        var now = DateTimeOffset.UtcNow;
        var feed = new ArrChangeFeed();
        var gate = new BridgeImportReadiness(feed, () => now);
        var released = new List<ImportReadyRelease>();
        gate.Released += _ => throw new InvalidOperationException("a broken listener");
        gate.Released += r => released.Add(r);
        var item = Guid.NewGuid();
        Assert.False(gate.Pending(item, MatrixFile));

        gate.Begin(MatrixFile, "radarr:1", Matrix);
        var revision = gate.Revision;
        // Before Jellyfin's item is known: by path only (the view and list host ask with the item's path).
        Assert.True(gate.Pending(item, MatrixFile));
        Assert.False(gate.Pending(item, null));
        gate.Attach(MatrixFile, "radarr:1", item);
        Assert.True(gate.Pending(item, null));
        Assert.True(gate.Revision > revision);

        // A newer import of the same path takes over: the older one can no longer publish it.
        gate.Begin(MatrixFile, "radarr:2", Matrix);
        Assert.False(gate.Release(MatrixFile, "radarr:1", null));
        Assert.True(gate.Pending(Guid.Empty, MatrixFile));
        Assert.False(gate.Pending(item, null));
        gate.Attach(MatrixFile, "radarr:2", item);
        var cursor = feed.Cursor;
        Assert.True(gate.Release(MatrixFile, "radarr:2", null));
        Assert.False(gate.Release(MatrixFile, "radarr:2", null));
        Assert.False(gate.Pending(item, MatrixFile));
        // Once, with its key and item, the broken listener notwithstanding; the change feed is bumped for the title.
        var release = Assert.Single(released);
        Assert.Equal((Matrix, true, item), (release.Key, release.Verified, Assert.Single(release.ItemIds)));
        Assert.Contains(feed.Read(feed.Epoch, cursor).Changes, c => c.Key == Matrix);
        Assert.Equal(ImportReadinessState.Ready, Assert.Single(gate.Entries()).State);

        // Never forever: an import whose follow-up never ended stops holding after MaxHold.
        gate.Begin("/media/movies/Other/Other.mkv", "radarr:3", null);
        Assert.True(gate.Pending(Guid.Empty, "/media/movies/Other/Other.mkv"));
        now += gate.MaxHold;
        Assert.False(gate.Pending(Guid.Empty, "/media/movies/Other/Other.mkv"));
        // A dropped import (it never reached Jellyfin) is not published.
        gate.Begin("/media/movies/Gone/Gone.mkv", "radarr:4", null);
        gate.Drop("/media/movies/Gone/Gone.mkv", "radarr:4");
        Assert.False(gate.Pending(Guid.Empty, "/media/movies/Gone/Gone.mkv"));
        Assert.Single(released);
    }

    // ------------------------------------------------------------------ the real Jellyfin view: status, fulfilment, editions

    /// <summary>A movie whose media sources (one per version) are what Jellyfin's GetMediaSources lists.</summary>
    private sealed class VersionedMovie : Movie
    {
        public List<MediaSourceInfo> Versions { get; } = new();

        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Versions;
    }

    /// <summary>The real Jellyfin view over one just-imported movie (The Matrix) the viewer may open, with the readiness gate.</summary>
    private sealed class Library : IDisposable
    {
        public VersionedMovie Movie { get; }
        public Mock<ILibraryManager> Manager { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Dictionary<Guid, User> People { get; } = new();
        public BridgeImportReadiness Readiness { get; } = new(null, null);
        public ArrJellyfinView View { get; }
        private readonly ILibraryManager _previous = BaseItem.LibraryManager;

        public Library()
        {
            Movie = new VersionedMovie { Id = Guid.NewGuid(), Name = "The Matrix (1999) {tmdb-603}", Path = MatrixFile, DateCreated = DateTime.UtcNow };
            Movie.SetProviderId(MetadataProvider.Tmdb, "603");
            Movie.Versions.Add(new MediaSourceInfo { Id = Movie.Id.ToString("N"), Path = MatrixFile, Protocol = MediaProtocol.File, Type = MediaSourceType.Default, MediaStreams = new List<MediaStream> { new() { Type = MediaStreamType.Video, Width = 1920, Height = 1080 } } });
            var root = new CollectionFolder { Id = Guid.NewGuid(), Name = "Movies" };
            BaseItem? ById(Guid id) => id == Movie.Id ? Movie : id == root.Id ? root : null;
            Manager.Setup(l => l.GetVirtualFolders()).Returns(new List<VirtualFolderInfo> { new() { ItemId = root.Id.ToString("N"), Locations = new[] { "/media/movies" } } });
            Manager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie) ? new List<BaseItem> { Movie } : new List<BaseItem>());
            Manager.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns(new List<Folder> { root });
            Manager.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => ById(id));
            Manager.Setup(l => l.FindByPath(It.IsAny<string>(), It.IsAny<bool?>())).Returns((string path, bool? _) => path == MatrixFile ? Movie : null);
            Manager.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>())).Returns((Guid id, User? user) => user != null && People.ContainsKey(user.Id) ? ById(id) : null);
            Users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => People.GetValueOrDefault(id));
            View = new ArrJellyfinView(Manager.Object, Users.Object, null, Readiness);
            BaseItem.LibraryManager = Manager.Object;
        }

        public StatusViewer Person(StatusViewer fake)
        {
            var user = (User)fake.Handle!;
            user.SetPermission(PermissionKind.IsAdministrator, false);
            People[user.Id] = user;
            return View.Viewer(user.Id)!;
        }

        public void Dispose()
        {
            View.Dispose();
            BaseItem.LibraryManager = _previous;
        }
    }

    [Fact]
    public async Task AJustImportedMovieTheViewListsIsAlmostReadyAndUnfulfilledUntilTheGatePublishesIt()
    {
        using var library = new Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(jellyfin: library.View);
        // Radarr imported the file (no download left); Jellyfin lists the movie with its folder's name, metadata not read yet.
        lab.Radarr.Queue.Clear();
        lab.Radarr.Movies[0]!["hasFile"] = true;
        var emma = library.Person(lab.Emma);
        library.Readiness.Begin(MatrixFile, "radarr:9", Matrix);
        library.Readiness.Attach(MatrixFile, "radarr:9", library.Movie.Id);
        await lab.Warm();
        var key = TitleKey.Parse(Matrix)!;
        var scope = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = new(Array.Empty<int>(), false, null) };

        // The view says so as a separate fact; Jellyfin's own Playable is unchanged.
        var item = library.View.Resolve(library.Movie.Id, emma)!;
        Assert.True(item.AwaitingMetadata);
        Assert.True(item.Playable);
        Assert.False(EditionAvailability.Plays(item));
        Assert.True(Assert.Single(library.View.Sources(library.Movie.Id, emma)).AwaitingMetadata);
        // Nothing qualifies yet: the Ready playlist's selection reads this same edition scope.
        Assert.Empty(lab.Status.Editions.Scope(emma, key, Edition.Standard));
        Assert.Equal(StatusStage.AlmostReady, Assert.Single(await lab.Status.ComposeForAsync(emma, new[] { key }, scope, default)).Status.Stage);
        var request = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.NotEqual("fulfilled", lab.Ledger.Find(request)!.Status);

        // Published: the view's revision moves (cached compositions are read again), and it is Ready and fulfilled.
        var revision = library.View.Revision;
        Assert.True(library.Readiness.Release(MatrixFile, "radarr:9", null));
        Assert.True(library.View.Revision > revision);
        Assert.False(library.View.Resolve(library.Movie.Id, emma)!.AwaitingMetadata);
        Assert.Single(lab.Status.Editions.Scope(emma, key, Edition.Standard));
        Assert.Equal(StatusStage.Ready, Assert.Single(await lab.Status.ComposeForAsync(emma, new[] { key }, scope, default)).Status.Stage);
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(request)!.Status);
    }

    // ------------------------------------------------------------------ notifications, through the real bridge

    [Fact]
    public async Task AReadyNotificationWaitsForTheHydrationAndIsSentOnceAfterIt()
    {
        const string Dune = "movie:tmdb:693134";
        const string File = "/data/movies/Dune Part Two (2024) {tmdb-693134}/Dune.Part.Two.mkv";
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        rig.View.Readiness = rig.Bridge.Readiness;
        rig.Bridge.HydrationAttemptTimeout = TimeSpan.FromMinutes(5);
        rig.Bridge.MetadataWaitOverride = TimeSpan.FromMinutes(5);
        rig.Service.SubscribeBridge();
        rig.Bridge.Subscribe();
        var radarr = rig.Arr.Instance("RadarrZ");
        await rig.Store.GetHistoryAsync(radarr, default);
        await rig.Step(Dune);
        rig.Library.AddLibrary("Movies", "movies", "/data/movies");
        rig.Library.AddFile(File, indexed: false, kind: "movie");
        // Jellyfin's first read leaves the folder's name and no artwork; its hydrations don't land yet (a slow provider).
        rig.Library.NewItemMeta = FakeLibraryAccess.Skeleton;
        rig.Library.HydrationWorks = false;
        var copy = Guid.NewGuid();
        rig.Library.DuringRefresh = _ =>
        {
            rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = copy, Path = File, LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
            rig.View.Rev++;
            return Task.CompletedTask;
        };
        var import = FakeArr.HistoryRow(50, "downloadFolderImported", rig.Arr.Now.UtcDateTime, "dl50", 693134, "Dune Part Two");
        import["movieId"] = 2;
        import["data"] = new JsonObject { ["importedPath"] = File };
        rig.Radarr.History.Insert(0, import);
        await rig.Store.RefreshForEventAsync(radarr.Id, ArrSnapshotKind.History, force: true);
        await Until(() => rig.Library.Hydrations.Count > 0);

        // Indexed (the bridge told the notifications) but not hydrated: no Ready, however many rounds run.
        async Task Rounds(int n)
        {
            for (var round = 0; round < n; round++)
            {
                await rig.Service.TickAsync(default, force: true);
                rig.Service.FlushBatches(rig.Arr.Now);
                await rig.Dispatcher.RunOnceAsync(default);
                await Task.Delay(30);
            }
        }
        await Rounds(10);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.True(rig.Bridge.Readiness.Pending(copy, File));

        // Jellyfin finishes reading it: the bridge publishes it, its wake-up makes the title due, and Ready goes out once.
        var item = rig.Library.Items[File];
        var meta = rig.Library.Metas[item.Id];
        meta.Name = "Dune: Part Two";
        meta.Overview = meta.Primary = meta.Backdrop = true;
        await Until(() => !rig.Bridge.Readiness.Pending(copy, File));
        for (var round = 0; round < 50 && rig.Inbox(rig.Emma).Count == 0; round++) await Rounds(1);
        var ready = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("ready", copy.ToString("N")), (ready.Kind, ready.ItemId));
        await Rounds(5);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Single(rig.Pushes);
    }

    // ------------------------------------------------------------------ list swap-in and the real list host

    [Fact]
    public async Task AJustImportedCopyIsSwappedIntoAListOnlyOnceItIsPublishedReady()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(49521);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, CancellationToken.None));
        await h.Consent(access);

        // Jellyfin lists the arrival, but its import is still held: nothing is swapped in, the placeholder stays.
        var arrived = h.Host.AddItem(tmdb: 49521);
        h.Host.Awaiting.Add(arrived);
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(CancellationToken.None);
        Assert.Equal(new[] { a }, h.Host.Resolved(playlist.Info.Id));
        Assert.Contains(h.Store.Load(access.ListIdN)!.Items, p => p.Id == movie.Id);

        // Published Ready: the monitor's wake-up matches it at once (Jellyfin's last update of it may have come before).
        h.Host.Awaiting.Remove(arrived);
        var gate = new BridgeImportReadiness(null, null);
        var monitor = new ListSwapMonitor(Mock.Of<ILibraryManager>(), h.Swap, h.Plugin.Core.Logger, gate);
        await monitor.StartAsync(CancellationToken.None);
        try
        {
            gate.Begin("/media/movies/Arrived/Arrived.mkv", "radarr:1", "movie:tmdb:49521");
            gate.Attach("/media/movies/Arrived/Arrived.mkv", "radarr:1", arrived);
            gate.Release("/media/movies/Arrived/Arrived.mkv", "radarr:1", null);
            await h.Swap.DrainAsync(CancellationToken.None);
            Assert.Equal(new[] { a, arrived }, h.Host.Resolved(playlist.Info.Id));
            Assert.DoesNotContain(h.Store.Load(access.ListIdN)!.Items, p => p.Id == movie.Id);
        }
        finally
        {
            await monitor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void TheRealListHostAsksTheGateWithTheItemsPath()
    {
        var item = new Movie { Id = Guid.NewGuid(), Path = MatrixFile };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(item.Id)).Returns(item);
        var gate = new BridgeImportReadiness(null, null);
        var host = new JellyfinListHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<ICollectionManager>(), Mock.Of<IFileSystem>(), null, gate);
        Assert.False(host.AwaitingMetadata(item.Id));
        // Held by path before the bridge knows the item's id.
        gate.Begin(MatrixFile, "radarr:1", Matrix);
        Assert.True(host.AwaitingMetadata(item.Id));
        gate.Release(MatrixFile, "radarr:1", "backdrop");
        Assert.False(host.AwaitingMetadata(item.Id));
        // Without the gate (an older registration) nothing is held.
        Assert.False(new JellyfinListHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<ICollectionManager>(), Mock.Of<IFileSystem>()).AwaitingMetadata(item.Id));
    }

    [Fact]
    public void TheListEditionAdapterNeverMatchesAHeldCopy()
    {
        var viewer = FakeListHost.MakeUser("viewer");
        var movie = Guid.NewGuid();
        var host = new Mock<IListHost>();
        host.Setup(h => h.FindMovies(49521, null, viewer)).Returns(new[] { movie });
        host.Setup(h => h.CanAccessItem(It.IsAny<Guid>(), viewer)).Returns(true);
        host.Setup(h => h.GetMediaSources(movie)).Returns(new[] { new ListMediaSource(movie, movie.ToString("N"), 1920, 1080, true) });
        var held = true;
        host.Setup(h => h.AwaitingMetadata(movie)).Returns(() => held);
        var editions = new ListEditionAvailability(host.Object);
        var scope = Movie(49521);
        Assert.Empty(editions.Resolve(scope, new[] { viewer }).Sources);
        held = false;
        Assert.Equal(movie, Assert.Single(editions.Resolve(scope, new[] { viewer }).Sources).ItemId);
    }
}
