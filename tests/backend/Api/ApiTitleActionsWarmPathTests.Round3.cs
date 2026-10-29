// Review round 3 (WPR2-1 and the passing round-2 guards): reviewer probes ported.
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Model.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Moq;

namespace JE.Tests;

public partial class ApiTitleActionsWarmPathTests
{
    [Fact]
    public void ListedRepeatsItsCopyReadAfterReplacingAStalePerson()
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.IsAdministrator, true);
        var next = Rig.Person(rig.Viewer.Id);
        next.SetPermission(PermissionKind.IsAdministrator, true);
        next.DisplayMissingEpisodes = !rig.Viewer.DisplayMissingEpisodes;
        var live = rig.Viewer;
        rig.Lookup = id => id == live.Id ? live : null;
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Copy", Path = "/movies/copy.mkv" };
        var arrived = false;
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(() => arrived ? new List<BaseItem> { movie } : new List<BaseItem>());
        library.Setup(l => l.GetItemById<BaseItem>(movie.Id, It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns(movie);
        var view = new Mock<IArrJellyfinView>();
        view.SetupGet(v => v.Revision).Returns(1);
        view.Setup(v => v.Viewer(It.IsAny<Guid>())).Returns(() => ArrJellyfinView.ViewerOf(live));
        view.Setup(v => v.ViewerAsRead(It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns((Jellyfin.Database.Implementations.Entities.User u) => ArrJellyfinView.ViewerOf(u));
        view.Setup(v => v.Copies(It.IsAny<TitleKey>(), It.IsAny<StatusViewer>(), It.IsAny<IReadOnlyCollection<TitleKey>>())).Returns(() => {
            live = next;
            arrived = true;
            return CopyLookup.Complete(new[] { new JfCopy { ItemId = movie.Id, Visible = true } });
        });
        var roots = new FakeLibraryAccess();
        var requests = new RequestPolicy(view.Object, rig.Store, new ArrInstanceLibraries(rig.Store, roots), new TitleAliases(rig.Store, null), rig.Gate, rig.Arr.Factory, new UnavailableRequestBackend());
        var policy = new NativeDetailsPolicy(rig.Gate, Mock.Of<INativeDetailsSource>(), roots, requests, physical: new NativeDetailsLibrary(library.Object));
        Assert.Equal(NativeDetailsPolicy.ListedTitle.Copy(movie.Id), policy.Listed(rig.Viewer, true, TmdbId));
    }

    [Theory]
    [InlineData("see")]
    [InlineData("list")]
    [InlineData("listed")]
    public async Task ADeletionDuringEvaluationRefusesTheWholeHeldDecision(string entry)
    {
        using var rig = new Rig();
        await rig.Settle();
        var once = 0;
        rig.OnScan = () => { if (Interlocked.Exchange(ref once, 1) == 0) rig.Lookup = _ => null; };
        if (entry == "see") Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.SeeDetailsAsync(rig.Viewer, Title, CancellationToken.None));
        else if (entry == "list") Assert.False(rig.Policy.MayListAbsent(rig.Viewer, Title));
        else Assert.Equal(NativeDetailsPolicy.ListedTitle.Left, rig.Policy.Listed(rig.Viewer, true, TmdbId));
        Assert.Equal(1, once);
        Assert.Null(rig.View.Viewer(rig.Viewer.Id));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AFolderChangeDuringTheFinalStampRejectsPreviouslyVisibleCopies(bool held)
    {
        using var rig = new Rig();
        await rig.Settle();
        var movie = rig.AddCopy();
        var input = new MutationInput { Key = "movie:tmdb:" + TmdbId, Scope = "movie" };
        var accessor = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        try
        {
            Assert.True(rig.Requests.Evaluate(rig.Viewer.Id, input).Visible);
            var before = rig.Requests.AuthorizationStamp(rig.Viewer.Id, input);
            var reads = 0;
            rig.Lookup = id => {
                // Held evaluation's first database read is its final stamp; id evaluation has an initial read too.
                if (++reads == (held ? 1 : 2))
                {
                    rig.Closed.Add(movie.Id);
                    rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new MediaBrowser.Controller.Library.ItemChangeEventArgs { Item = new Folder { Id = Guid.NewGuid(), Path = "/movies/parent" } });
                }
                return id == rig.Viewer.Id ? rig.Viewer : null;
            };
            var current = false;
            var facts = held ? rig.Requests.Evaluate(rig.Viewer, input, out current) : rig.Requests.Evaluate(rig.Viewer.Id, input);
            Assert.False(facts.Visible);
            Assert.False(current);
            Assert.NotEqual(before, rig.Requests.AuthorizationStamp(rig.Viewer.Id, input));
        }
        finally { accessor.HttpContext = null; }
    }

    [Fact]
    public async Task APlaylistDoesNotMoveTheStampButDropsSharedCopyFacts()
    {
        using var rig = new Rig();
        await rig.Settle();
        var input = new MutationInput { Key = "movie:tmdb:" + TmdbId, Scope = "movie" };
        var key = TitleKey.Parse(input.Key)!;
        var accessor = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        try
        {
            var viewer = rig.View.Viewer(rig.Viewer.Id)!;
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            var stamp = rig.Requests.AuthorizationStamp(rig.Viewer.Id, input);
            var revision = rig.View.Revision;
            var scans = rig.Scans;
            rig.Changed(new MediaBrowser.Controller.Playlists.Playlist { Id = Guid.NewGuid() });
            Assert.Equal(revision, rig.View.Revision);
            Assert.Equal(stamp, rig.Requests.AuthorizationStamp(rig.Viewer.Id, input));
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            Assert.Equal(scans + 1, rig.Scans);
        }
        finally { accessor.HttpContext = null; }
    }

    [Fact]
    public async Task ANonFolderChangeDuringAScanPreventsSharingWithoutMovingTheStamp()
    {
        using var rig = new Rig();
        await rig.Settle();
        var input = new MutationInput { Key = "movie:tmdb:" + TmdbId, Scope = "movie" };
        var key = TitleKey.Parse(input.Key)!;
        var accessor = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        try
        {
            var viewer = rig.View.Viewer(rig.Viewer.Id)!;
            var stamp = rig.Requests.AuthorizationStamp(rig.Viewer.Id, input);
            var once = 0;
            rig.OnScan = () => { if (Interlocked.Exchange(ref once, 1) == 0) rig.Changed(new Genre { Id = Guid.NewGuid() }); };
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            Assert.Equal(2, rig.Scans);
            Assert.Equal(stamp, rig.Requests.AuthorizationStamp(rig.Viewer.Id, input));
        }
        finally { accessor.HttpContext = null; }
    }
    [Fact]
    public async Task ASecondReplacementDuringTheFreshPhysicalRetryIsRefused()
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.IsAdministrator, true);
        var next = Rig.Person(rig.Viewer.Id);
        next.SetPermission(PermissionKind.IsAdministrator, true);
        next.MaxParentalRatingScore = 10;
        var middle = Rig.Person(rig.Viewer.Id);
        middle.SetPermission(PermissionKind.IsAdministrator, true);
        middle.DisplayMissingEpisodes = !rig.Viewer.DisplayMissingEpisodes;
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), Name = "Show", Path = "/movies/show" };
        series.SetProviderId(MetadataProvider.Tmdb, TmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var season = new MediaBrowser.Controller.Entities.TV.Season { Id = Guid.NewGuid(), IndexNumber = 1, SeriesId = series.Id, Path = "/movies/show/s1" };
        var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), IndexNumber = 1, ParentIndexNumber = 1, SeriesId = series.Id, SeasonId = season.Id, Path = "/movies/show/s1/e1.mkv" };
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => {
            if (q.IncludeItemTypes.Contains(BaseItemKind.Series)) return new List<BaseItem> { series };
            if (q.IncludeItemTypes.Contains(BaseItemKind.Season)) return new List<BaseItem> { season };
            if (q.IncludeItemTypes.Contains(BaseItemKind.Episode)) return new List<BaseItem> { episode };
            return new List<BaseItem>();
        });
        rig.Library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User>())).Returns((Guid id, User u) =>
            id == series.Id ? series : id == season.Id ? season : id == episode.Id && !u.MaxParentalRatingScore.HasValue ? episode : null!);
        User live = rig.Viewer;
        rig.Lookup = id => id == live.Id ? live : null;
        var scans = 0;
        var view = new Mock<IArrJellyfinView>();
        view.SetupGet(v => v.Revision).Returns(1);
        view.Setup(v => v.Viewer(It.IsAny<Guid>())).Returns(() => ArrJellyfinView.ViewerOf(live));
        view.Setup(v => v.ViewerAsRead(It.IsAny<User>())).Returns((User u) => ArrJellyfinView.ViewerOf(u));
        view.Setup(v => v.Copies(It.IsAny<TitleKey>(), It.IsAny<StatusViewer>(), It.IsAny<IReadOnlyCollection<TitleKey>>()))
            .Returns(() => { scans++; if (scans == 1) live = middle; if (scans == 3) live = next; return CopyLookup.Complete(new[] { new JfCopy { ItemId = series.Id, Visible = true } }); });
        view.Setup(v => v.Seasons(It.IsAny<Guid>(), It.IsAny<StatusViewer>())).Returns(Array.Empty<JfSeason>());
        view.Setup(v => v.Episodes(It.IsAny<Guid>(), It.IsAny<int?>(), It.IsAny<StatusViewer>(), It.IsAny<bool>())).Returns(Array.Empty<JfEpisode>());
        var roots = new FakeLibraryAccess();
        var requests = new RequestPolicy(view.Object, rig.Store, new ArrInstanceLibraries(rig.Store, roots), new TitleAliases(rig.Store, null), rig.Gate, rig.Arr.Factory, new UnavailableRequestBackend());
        var policy = new NativeDetailsPolicy(rig.Gate, Mock.Of<INativeDetailsSource>(), roots, requests,
            physical: new NativeDetailsLibrary(rig.Library.Object));
        var title = SyntheticId.EpisodeOf(TmdbId, 1, 1);
        Assert.True(policy.Physical(next, title).Hides(title));
        Assert.False(policy.Physical(rig.Viewer, title).Hides(title));
        var withHeldRead = await policy.SeeDetailsAsync(rig.Viewer, title, CancellationToken.None);
        var withFreshRead = await policy.SeeDetailsAsync(next, title, CancellationToken.None);
        Assert.Equal(NativeDetailsPolicy.Access.Refused, withFreshRead);
        Assert.Equal(withFreshRead, withHeldRead);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APersonWhoKeepsChangingIsRefusedAfterThreeConfirmedReads(bool churn)
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.IsAdministrator, true);
        User live = rig.Viewer;
        rig.Lookup = id => id == live.Id ? live : null;
        var view = new Mock<IArrJellyfinView>();
        view.SetupGet(v => v.Revision).Returns(1);
        view.Setup(v => v.Viewer(It.IsAny<Guid>())).Returns(() => ArrJellyfinView.ViewerOf(live));
        view.Setup(v => v.ViewerAsRead(It.IsAny<User>())).Returns((User u) => ArrJellyfinView.ViewerOf(u));
        // Every evaluation's copy scan lands a new read of the person whose policy revision never repeats (another blocked
        // folder that holds nothing here), so no stamp ever confirms an earlier read.
        view.Setup(v => v.Copies(It.IsAny<TitleKey>(), It.IsAny<StatusViewer>(), It.IsAny<IReadOnlyCollection<TitleKey>>())).Returns(() =>
        {
            if (churn)
            {
                var next = Rig.Person(rig.Viewer.Id);
                next.SetPermission(PermissionKind.IsAdministrator, true);
                next.SetPreference(PreferenceKind.BlockedMediaFolders, new[] { Guid.NewGuid() });
                live = next;
            }

            return CopyLookup.Absent;
        });
        var roots = new FakeLibraryAccess();
        var requests = new RequestPolicy(view.Object, rig.Store, new ArrInstanceLibraries(rig.Store, roots), new TitleAliases(rig.Store, null), rig.Gate, rig.Arr.Factory, new UnavailableRequestBackend());
        var policy = new NativeDetailsPolicy(rig.Gate, Mock.Of<INativeDetailsSource>(), roots, requests);
        // Never answered from an unconfirmed read: a page gets a temporary answer (Unknown, a retryable 503), never allowed.
        var expected = churn ? NativeDetailsPolicy.Access.Unknown : NativeDetailsPolicy.Access.Allowed;
        Assert.Equal(expected, await policy.SeeDetailsAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.Equal(!churn, policy.MayListAbsent(rig.Viewer, Title));
        Assert.Equal(churn ? NativeDetailsPolicy.ListedTitle.Left : NativeDetailsPolicy.ListedTitle.Absent, policy.Listed(rig.Viewer, true, TmdbId));
    }
}
