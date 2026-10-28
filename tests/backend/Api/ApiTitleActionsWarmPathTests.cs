using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Xunit;

namespace JE.Tests;

/// <summary>
/// The action menu's warm path in Jellyfin Enhanced mode with request visibility on, over the production arr view: the
/// person is read once per authorization phase (the reads already made are reused, every fresh final stamp and post-await
/// re-read stays), and a request shares a finished copy scan only while nothing could have changed what it found.
/// </summary>
[Collection("Plugin singleton")]
public class ApiTitleActionsWarmPathTests
{
    private const int TmdbId = 693134;

    private sealed class Rig : IDisposable
    {
        private int _reads;
        private int _scans;

        public FakeArr Arr { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public Folder Movies { get; } = new() { Id = Guid.NewGuid(), Path = "/movies" };
        public List<BaseItem> Copies { get; } = new();
        public HashSet<Guid> Closed { get; } = new();
        public User Viewer { get; }
        public Func<Guid, User?>? Lookup { get; set; }
        public Action? OnPageRead { get; set; }
        public Action? OnScan { get; set; }
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public SeerrParentalFilter Gate { get; }
        public ArrJellyfinView View { get; }
        public ArrStateStore Store { get; }
        public RequestPolicy Requests { get; }
        public NativeDetailsPolicy Policy { get; }
        public NativeDetailsFeeds Feeds { get; }
        public ArrStatusService Status { get; }

        /// <summary>Times the person was read from Jellyfin (its database, on both hosts).</summary>
        public int Reads => Volatile.Read(ref _reads);

        /// <summary>Copy scans: native provider queries for movies.</summary>
        public int Scans => Volatile.Read(ref _scans);

        public Rig()
        {
            Arr.Add("movies.invalid", "Radarr");
            Arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
            var config = Arr.Plugin.Plugin.Configuration;
            config.NativeAbsentDetailsEnabled = true;
            config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = true;
            config.ArrRequestBackend = "je";
            config.TMDB_API_KEY = "test-tmdb";
            config.JellyseerrEnabled = false;
            config.JellyseerrUrls = string.Empty;
            Viewer = Person();
            Users.Setup(m => m.GetUserById(It.IsAny<Guid>())).Returns((Guid id) =>
            {
                Interlocked.Increment(ref _reads);
                if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty", nameof(id));
                return Lookup != null ? Lookup(id) : id == Viewer.Id ? Viewer : null;
            });
            Library.Setup(l => l.GetVirtualFolders()).Returns(() => new List<VirtualFolderInfo> { new() { ItemId = Movies.Id.ToString("N"), Name = "Movies", Locations = new[] { "/movies" } } });
            Library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User>())).Returns((Guid id, User user) =>
                id == Movies.Id ? (user.HasPermission(PermissionKind.EnableAllFolders) ? Movies : null!)
                : Copies.FirstOrDefault(c => c.Id == id && !Closed.Contains(id))!);
            Library.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns(new List<Folder> { Movies });
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            {
                if (q.HasAnyProviderId is not { Count: > 0 } ids || !(q.IncludeItemTypes ?? Array.Empty<BaseItemKind>()).Contains(BaseItemKind.Movie)) return new List<BaseItem>();
                Interlocked.Increment(ref _scans);
                OnScan?.Invoke();
                IEnumerable<BaseItem> found = Copies.Where(c => ids.Any(w => c.ProviderIds.TryGetValue(w.Key, out var v) && v == w.Value)).ToList().Skip(q.StartIndex ?? 0);
                if (q.Limit is int limit) found = found.Take(limit);
                return found.ToList();
            });
            // Parental evidence is unavailable (TMDB answers 503): a restricted person is never allowed by it.
            Transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 503)));
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            var server = new Mock<IServerConfigurationManager>();
            server.SetupGet(m => m.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
            Gate = new SeerrParentalFilter(Transport, Users.Object, Mock.Of<ILocalizationManager>(), server.Object, Arr.Plugin.Core.Logger,
                new TitleParentalEvidenceProvider(Transport, Tmdb, Library.Object));
            View = new ArrJellyfinView(Library.Object, Users.Object);
            Store = Arr.Store();
            var access = new FakeLibraryAccess();
            access.Libs.Add(new JfLibraryRoot { Id = Movies.Id.ToString(), Name = "Movies", CollectionType = "movies", Locations = new[] { "/movies" } });
            var libraries = new ArrInstanceLibraries(Store, access) { Parental = Gate };
            Requests = new RequestPolicy(View, Store, libraries, new TitleAliases(Store, null), Gate, Arr.Factory, new UnavailableRequestBackend());
            var source = new Mock<INativeDetailsSource>();
            source.Setup(s => s.MovieAsync(It.IsAny<int>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
                .Returns(async (int id, Guid _, CancellationToken _) =>
                {
                    await Task.Yield();
                    OnPageRead?.Invoke();
                    return SourceAnswer.Of(JsonDocument.Parse("{\"id\":" + id + ",\"title\":\"Movie\"}").RootElement.Clone());
                });
            Policy = new NativeDetailsPolicy(Gate, source.Object, access, Requests);
            Feeds = new NativeDetailsFeeds(source.Object, Policy, Gate, Library.Object);
            Status = new ArrStatusService(Store, View, new NoRequestFacts(), () => Arr.Plugin.Plugin.Configuration, null);
        }

        public static User Person(Guid? id = null)
        {
            var user = new User("viewer", "default", "default") { Id = id ?? Guid.NewGuid() };
            user.SetPermission(PermissionKind.EnableAllFolders, true);
            return user;
        }

        /// <summary>A copy of the title under the movies library (the viewer can open it unless <paramref name="closed"/>).</summary>
        public Movie AddCopy(bool closed = false)
        {
            var movie = new Movie { Id = Guid.NewGuid(), Name = "Copy", Path = "/movies/copy-" + Guid.NewGuid().ToString("N") + ".mkv" };
            movie.SetProviderId(MetadataProvider.Tmdb, TmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Copies.Add(movie);
            if (closed) Closed.Add(movie.Id);
            return movie;
        }

        /// <summary>Waits (bounded) until request visibility's authorization stamp holds still: no arr read is landing.</summary>
        public async Task Settle()
        {
            var input = new MutationInput { Key = "movie:tmdb:" + TmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture), Scope = "movie" };
            var deadline = DateTime.UtcNow.AddSeconds(10);
            var last = Requests.AuthorizationStamp(Viewer.Id, input);
            while (DateTime.UtcNow < deadline)
            {
                await Task.Delay(50);
                var now = Requests.AuthorizationStamp(Viewer.Id, input);
                if (now == last) return;
                last = now;
            }
        }

        /// <summary>Jellyfin announcing an item change (its library manager's event).</summary>
        public void Changed(BaseItem item) => Library.Raise(l => l.ItemAdded += null, Library.Object, new ItemChangeEventArgs { Item = item });

        /// <summary>
        /// The menu read as the viewer, in a request (the ambient HTTP context Jellyfin's hosting provides, which request-scoped
        /// reads use) unless <paramref name="ambient"/> is false.
        /// </summary>
        public async Task<(int Status, string Body)> Read(bool ambient = true)
        {
            var http = new DefaultHttpContext { User = TestCallers.Principal(Viewer.Id, false) };
            var accessor = new HttpContextAccessor();
            if (ambient) accessor.HttpContext = http;
            try
            {
                var route = new TitleActionsController(Feeds, Policy, Users.Object, Status) { ControllerContext = new ControllerContext { HttpContext = http } };
                var result = await route.Read("movie", TmdbId);
                return result switch
                {
                    ObjectResult o => (o.StatusCode ?? 200, JsonSerializer.Serialize(o.Value)),
                    StatusCodeResult s => (s.StatusCode, string.Empty),
                    _ => (200, string.Empty),
                };
            }
            finally
            {
                accessor.HttpContext = null;
            }
        }

        public void Dispose()
        {
            View.Dispose();
            Store.Dispose();
            Tmdb.Dispose();
            Transport.Dispose();
            Arr.Dispose();
        }
    }

    private static readonly SyntheticId Title = SyntheticId.Movie(TmdbId);

    [Fact]
    public async Task AWarmMenuReadReadsThePersonOncePerPhaseWithTheSameAnswer()
    {
        using var rig = new Rig();
        // Warm: a first read, then the arr side settled (no snapshot landing mid-read, which retries any evaluation).
        Assert.Equal(200, (await rig.Read()).Status);
        await rig.Settle();
        var before = rig.Reads;
        var (status, body) = await rig.Read();
        Assert.Equal(200, status);
        Assert.Equal("{\"allowed\":true,\"itemId\":null}", body);
        // Before: 19 reads of the person (the controller's three, a status viewer per real-copy check, and in each of the
        // three admissions two parental reads plus a request-visibility evaluation reading them three times). Now: the
        // controller's own three (its first read, the live read after the metadata await and the final one), and each
        // admission's fresh final authorization stamp; the parental policy and real-copy checks use the read in hand.
        Assert.Equal(6, rig.Reads - before);
    }

    [Theory]
    [InlineData("restricted", 404)]
    [InlineData("folders", 404)]
    [InlineData("disabled", 403)]
    [InlineData("deleted", 403)]
    public async Task APersonReplacedDuringTheSourceAwaitIsDecidedFromTheNewRead(string replacement, int expected)
    {
        using var rig = new Rig();
        var readsBeforeAwait = -1;
        rig.OnPageRead = () =>
        {
            readsBeforeAwait = rig.Reads;
            // A new User object (Jellyfin 12 reads a fresh one per lookup), never the one read before the await.
            var next = Rig.Person(rig.Viewer.Id);
            if (replacement == "restricted") next.MaxParentalRatingScore = 10;
            if (replacement == "folders") next.SetPermission(PermissionKind.EnableAllFolders, false);
            if (replacement == "disabled") next.SetPermission(PermissionKind.IsDisabled, true);
            rig.Lookup = id => replacement == "deleted" || id != next.Id ? null : next;
        };
        var (status, _) = await rig.Read();
        Assert.Equal(expected, status);
        // The person was read again after the await: the live read (and, admitted, the final one).
        Assert.True(readsBeforeAwait >= 0 && rig.Reads > readsBeforeAwait, $"reads before the await {readsBeforeAwait}, after {rig.Reads}");
    }

    [Theory]
    [InlineData("restricted")]
    [InlineData("tags")]
    [InlineData("folders")]
    [InlineData("disabled")]
    [InlineData("deleted")]
    public async Task AReadInHandThatIsNoLongerThePersonIsDecidedAgainFromFreshReads(string replacement)
    {
        using var rig = new Rig();
        var held = rig.Viewer;
        // From the evaluation's own (fresh) final stamp on, Jellyfin answers with the replaced person.
        var next = Rig.Person(held.Id);
        if (replacement == "restricted") next.MaxParentalRatingScore = 10;
        if (replacement == "tags") next.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
        if (replacement == "folders") next.SetPermission(PermissionKind.EnableAllFolders, false);
        if (replacement == "disabled") next.SetPermission(PermissionKind.IsDisabled, true);
        rig.Lookup = id => replacement == "deleted" || id != next.Id ? null : next;
        // Refused, as a fresh read decides: restricted or tag-ruled with unverified evidence (request visibility fails
        // closed), no folder access, disabled or deleted. Never allowed by the unrestricted read in hand.
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.SeeDetailsAsync(held, Title, CancellationToken.None));
        Assert.False(rig.Policy.MayListAbsent(held, Title));
        Assert.Equal(NativeDetailsPolicy.ListedTitle.Left, rig.Policy.Listed(held, true, TmdbId));
    }

    [Fact]
    public async Task APolicySavedSilentlyOnTheSameUserDuringEvaluationIsNotAllowedByTheOldRead()
    {
        using var rig = new Rig();
        // Jellyfin 10.11 saves a policy on the user object with no event: here, while the copy scan runs.
        var once = 0;
        rig.OnScan = () => { if (Interlocked.Exchange(ref once, 1) == 0) rig.Viewer.MaxParentalRatingScore = 10; };
        Assert.NotEqual(NativeDetailsPolicy.Access.Allowed, await rig.Policy.SeeDetailsAsync(rig.Viewer, Title, CancellationToken.None));
    }

    [Fact]
    public async Task UnknownEvidenceForARestrictedReadInHandFailsClosed()
    {
        using var rig = new Rig();
        rig.Viewer.MaxParentalRatingScore = 10;
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.SeeDetailsAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.False(rig.Policy.MayListAbsent(rig.Viewer, Title));
        Assert.False(await rig.Policy.MayListAbsentAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.Equal(404, (await rig.Read()).Status);
        // Unrestricted again: allowed.
        rig.Viewer.MaxParentalRatingScore = null;
        Assert.Equal(NativeDetailsPolicy.Access.Allowed, await rig.Policy.SeeDetailsAsync(rig.Viewer, Title, CancellationToken.None));
    }

    [Fact]
    public async Task AMenuReadScansTheLibraryOnceWithinItsRequest()
    {
        using var rig = new Rig();
        Assert.Equal(200, (await rig.Read()).Status);
        // Before: five scans (both real-copy checks, and request visibility in each of the three admissions).
        Assert.Equal(1, rig.Scans);
        // Outside a request nothing is shared.
        var before = rig.Scans;
        Assert.Equal(200, (await rig.Read(ambient: false)).Status);
        Assert.Equal(5, rig.Scans - before);
        // Nor between requests.
        before = rig.Scans;
        Assert.Equal(200, (await rig.Read()).Status);
        Assert.Equal(1, rig.Scans - before);
    }

    [Fact]
    public async Task ACopyArrivingDuringTheSourceAwaitIsTheCopyReturned()
    {
        using var rig = new Rig();
        Movie? arrived = null;
        rig.OnPageRead = () =>
        {
            arrived = rig.AddCopy();
            rig.Changed(arrived);
        };
        var (status, body) = await rig.Read();
        Assert.Equal(200, status);
        Assert.Contains(arrived!.Id.ToString("N"), body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnInaccessibleCopyArrivingDuringTheSourceAwaitHidesTheTitle()
    {
        using var rig = new Rig();
        rig.OnPageRead = () => rig.Changed(rig.AddCopy(closed: true));
        // A copy the viewer can't open never lets the title show as absent instead.
        Assert.Equal(404, (await rig.Read()).Status);
    }

    [Fact]
    public async Task OnlyAFinishedScanIsSharedAndOnlyForTheSameInputs()
    {
        using var rig = new Rig();
        var key = TitleKey.Parse("movie:tmdb:" + TmdbId)!;
        var accessor = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        try
        {
            var viewer = rig.View.Viewer(rig.Viewer.Id)!;
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            Assert.True(rig.View.Copies(key, viewer).IsProvenAbsent);
            Assert.Equal(1, rig.Scans);
            // Another person, other ids, another library topology: scanned again.
            var other = Rig.Person();
            rig.Users.Setup(m => m.GetUserById(other.Id)).Returns(other);
            rig.View.Copies(key, rig.View.Viewer(other.Id)!);
            Assert.Equal(2, rig.Scans);
            rig.View.Copies(key, viewer, new[] { TitleKey.Parse("movie:imdb:tt0000001")! });
            Assert.Equal(3, rig.Scans);
            rig.Library.Setup(l => l.GetVirtualFolders()).Returns(() => new List<VirtualFolderInfo> { new() { ItemId = rig.Movies.Id.ToString("N"), Name = "Movies", Locations = new[] { "/movies", "/more" } } });
            rig.View.Copies(key, viewer);
            Assert.Equal(4, rig.Scans);
            // The same person with other authority (folder access as read now): scanned again.
            rig.Viewer.SetPermission(PermissionKind.EnableAllFolders, false);
            rig.Viewer.SetPreference(PreferenceKind.EnabledFolders, new[] { rig.Movies.Id });
            rig.View.Copies(key, rig.View.Viewer(rig.Viewer.Id)!);
            Assert.Equal(5, rig.Scans);
            viewer = rig.View.Viewer(rig.Viewer.Id)!;
            rig.View.Copies(key, viewer);
            Assert.Equal(5, rig.Scans);
            // Any movie or series change since the scan began: scanned again, also when it lands during the scan.
            rig.Changed(new Movie { Id = Guid.NewGuid() });
            rig.View.Copies(key, viewer);
            Assert.Equal(6, rig.Scans);
            var once = 0;
            rig.OnScan = () => { if (Interlocked.Exchange(ref once, 1) == 0) rig.Changed(new Movie { Id = Guid.NewGuid() }); };
            rig.Changed(new Movie { Id = Guid.NewGuid() });
            rig.View.Copies(key, viewer);
            rig.View.Copies(key, viewer);
            Assert.Equal(8, rig.Scans);
            // An incomplete scan (a copy past the eligible budget) proves nothing and is never shared.
            for (var i = 0; i <= ArrJellyfinView.CopyBudget; i++) rig.AddCopy();
            rig.Changed(rig.Copies[0]);
            var incomplete = rig.View.Copies(key, viewer);
            Assert.False(incomplete.IsComplete);
            var scans = rig.Scans;
            Assert.False(rig.View.Copies(key, viewer).IsComplete);
            Assert.True(rig.Scans > scans);
        }
        finally
        {
            accessor.HttpContext = null;
        }
    }
}
