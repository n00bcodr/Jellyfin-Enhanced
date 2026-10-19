using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

/// <summary>
/// The watchlist features read shared request facts with a completeness gate once phase 3 is on (C88):
/// the ledger in JE mode (no Seerr needed), Seerr's read model in Seerr mode; an incomplete read defers the
/// item (checked again later) instead of meaning "nobody asked"; add-only writes and the blocked-user filter stay.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationWatchlistFactsTests
{
    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public FakeSeerr Seerr { get; } = new();
        public DateTimeOffset Now { get; set; } = new(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        public SeerrRequestReadModel Model { get; }
        public SharedRequestFacts Facts { get; }
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IUserDataManager> Data { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public Dictionary<Guid, UserItemData> Saved { get; } = new();
        public WatchlistMonitor Monitor { get; }
        public PluginConfiguration Config => F.Plugin.Configuration;
        public Rig()
        {
            var c = Config;
            c.ArrIntegrationEnabled = true; c.ArrPhase1Enabled = true; c.ArrPhase3Enabled = true; c.ArrRequestBackend = "je";
            c.AddRequestedMediaToWatchlist = true; c.PreventWatchlistReAddition = false;
            Model = new SeerrRequestReadModel(Seerr.Transport, new ArrChangeFeed(() => Now), null, () => Config, () => Now);
            Facts = new SharedRequestFacts(R.Ledger, Model, null);
            Data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>())).Returns((User u, BaseItem _) => Saved.TryGetValue(u.Id, out var d) ? d : new UserItemData { Key = "k" });
            Data.Setup(d => d.SaveUserData(It.IsAny<User>(), It.IsAny<BaseItem>(), It.IsAny<UserItemData>(), It.IsAny<UserDataSaveReason>(), It.IsAny<CancellationToken>()))
                .Callback((User u, BaseItem _, UserItemData d, UserDataSaveReason _, CancellationToken _) => Saved[u.Id] = d);
            var userConfig = new UserConfigurationManager(F.Core.Paths.Object, F.Core.Logger);
            Monitor = new WatchlistMonitor(Library.Object, Users.Object, Data.Object, Seerr.Transport, userConfig, F.Core.Logger, Facts);
        }
        public Guid Person(string role)
        {
            var id = R.Add(role);
            var user = new User(role.ToLowerInvariant() + id.ToString("N")[..4], "default", "default") { Id = id };
            Users.Setup(u => u.GetUserById(id)).Returns(user);
            IEnumerable<User> All() => R.View.Users.Keys.Select(k => new User("u" + k.ToString("N")[..6], "default", "default") { Id = k }).ToList();
#if NET9_0
            Users.SetupGet(u => u.Users).Returns(All);
#else
            Users.Setup(u => u.GetUsers()).Returns(All);
#endif
            return id;
        }
        public bool Liked(Guid user) => Saved.TryGetValue(user, out var d) && d.Likes == true;
        public void Dispose() { Monitor.Dispose(); Model.Dispose(); Seerr.Dispose(); R.Dispose(); F.Dispose(); }
    }

    private static Movie Arrived(int tmdb = 603) => new() { Id = Guid.NewGuid(), Name = "Arrived", ProviderIds = new() { ["Tmdb"] = tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture) } };

    [Fact]
    public void TheWatchlistListensFromStartUpEvenWhileOffSoTurningItOnNeedsNoRestart()
    {
        using var rig = new Rig();
        rig.Config.AddRequestedMediaToWatchlist = false;
        rig.Monitor.Initialize();
        rig.Monitor.Initialize();
        rig.Library.VerifyAdd(l => l.ItemAdded += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once());
        rig.Library.VerifyAdd(l => l.ItemUpdated += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once());
    }

    [Fact]
    public async Task InJeModeTheLedgerSaysWhoAskedWithoutSeerr()
    {
        using var r = new Rig();
        var asker = r.Person("Member");
        var other = r.Person("Member");
        var cancelled = r.Person("Member");
        await r.R.Create(asker, IntegrationRequestLedgerTests.Movie(603));
        var gone = await r.R.Create(cancelled, IntegrationRequestLedgerTests.Movie(603));
        Assert.Equal(200, r.R.Service.Close(gone.RequestId!, cancelled, null).HttpStatus);
        Assert.True(await r.Monitor.ProcessFromSharedFactsAsync(Arrived(), 603, "movie", r.Config, 0));
        Assert.True(r.Liked(asker));
        Assert.False(r.Liked(other));
        Assert.False(r.Liked(cancelled));            // a cancelled ask isn't an ask
        Assert.Empty(r.Seerr.Calls);                 // no Seerr in JE mode

        // The blocked-user filter still applies.
        var blocked = r.Person("Member");
        await r.R.Create(blocked, IntegrationRequestLedgerTests.Movie(604));
        r.Config.JellyseerrImportBlockedUsers = blocked.ToString("N");
        await r.Monitor.ProcessFromSharedFactsAsync(Arrived(604), 604, "movie", r.Config, 0);
        Assert.False(r.Liked(blocked));

        var titles = r.Facts.ForUser(r.Config, asker);
        Assert.True(titles.Complete);
        Assert.Equal(new[] { (true, 603) }, titles.Titles);
    }

    [Fact]
    public async Task InSeerrModeAnIncompleteReadDefersTheItemInsteadOfMeaningNobodyAsked()
    {
        using var r = new Rig();
        r.Config.ArrRequestBackend = "seerr";
        r.Config.JellyseerrEnabled = true; r.Config.JellyseerrUrls = FakeSeerr.Url; r.Config.JellyseerrApiKey = FakeSeerr.Key;
        var asker = r.Person("Member");
        r.Seerr.Requests.Add(FakeSeerr.Request(11, "movie", 603, 2, asker, new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc)));
        var movie = Arrived();
        r.Library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);

        // Not read yet: deferred, nobody's watchlist touched.
        Assert.False(r.Facts.For(r.Config, TitleKey.Parse("movie:tmdb:603")!).Complete);
        Assert.False(await r.Monitor.ProcessFromSharedFactsAsync(movie, 603, "movie", r.Config, 0));
        Assert.Equal(1, r.Monitor.Deferred);
        Assert.False(r.Liked(asker));

        // Still failing: still deferred.
        r.Seerr.FailWith = 500;
        await r.Model.RefreshAsync(default);
        await r.Monitor.RecheckDeferredAsync();
        Assert.Equal(1, r.Monitor.Deferred);

        // A complete read arrives: the deferred item is added to the asker's watchlist.
        r.Seerr.FailWith = 0;
        Assert.True(await r.Model.RefreshAsync(default));
        await r.Monitor.RecheckDeferredAsync();
        Assert.Equal(0, r.Monitor.Deferred);
        Assert.True(r.Liked(asker));
        var titles = r.Facts.ForUser(r.Config, asker);
        Assert.True(titles.Complete);
        Assert.Equal(new[] { (true, 603) }, titles.Titles);
    }

    [Fact]
    public async Task BeyondTheReadWindowTheTitlesOwnRequestListFromSeerrNamesEveryoneWhoAsked()
    {
        using var r = new Rig();
        r.Config.ArrRequestBackend = "seerr";
        r.Config.JellyseerrEnabled = true; r.Config.JellyseerrUrls = FakeSeerr.Url; r.Config.JellyseerrApiKey = FakeSeerr.Key;
        var older = r.Person("Member");     // asked long ago: below the read window
        var newer = r.Person("Member");     // asked recently: in the window
        var declined = r.Person("Member");
        var at = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        const int count = SeerrRequestReadModel.MaxRequests + 5;
        lock (r.Seerr.Requests)
        {
            r.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 603, 2, older, at));
            for (var id = 2; id < count; id++) r.Seerr.Requests.Add(FakeSeerr.Request(id, "movie", 10_000 + id, 2, null, at.AddMinutes(id)));
            r.Seerr.Requests.Add(FakeSeerr.Request(count, "movie", 603, 2, newer, at.AddMinutes(count)));
        }
        Assert.True(await r.Model.RefreshAsync(default));
        Assert.NotNull(r.Model.Current.Floor);
        var facts = r.Facts.For(r.Config, TitleKey.Parse("movie:tmdb:603")!);
        Assert.Equal((false, true), (facts.Complete, facts.Truncated));      // never "complete" with only the newer asker
        Assert.Equal(new[] { newer }, facts.Users);

        System.Text.Json.Nodes.JsonObject Asked(Guid user, int status) => new() { ["status"] = status, ["requestedBy"] = new System.Text.Json.Nodes.JsonObject { ["jellyfinUserId"] = user.ToString("N") } };
        r.Seerr.Movies[603] = new System.Text.Json.Nodes.JsonObject
        {
            ["id"] = 603,
            ["mediaInfo"] = new System.Text.Json.Nodes.JsonObject { ["requests"] = new System.Text.Json.Nodes.JsonArray(Asked(older, 2), Asked(newer, 2), Asked(declined, 3)) },
        };
        var movie = Arrived();
        r.Library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        // The title's own list can't be read: deferred, nobody's watchlist touched.
        var lookups = r.Seerr.CallCount("/api/v1/movie/603");   // the read model's own title details included
        r.Seerr.FailWith = 503;
        Assert.False(await r.Monitor.ProcessFromSharedFactsAsync(movie, 603, "movie", r.Config, 0));
        Assert.Equal(1, r.Monitor.Deferred);
        Assert.False(r.Liked(newer));
        // Readable: everyone who asked gets it, the declined asker doesn't.
        r.Seerr.FailWith = 0;
        await r.Monitor.RecheckDeferredAsync();
        Assert.Equal(0, r.Monitor.Deferred);
        Assert.True(r.Liked(older));
        Assert.True(r.Liked(newer));
        Assert.False(r.Liked(declined));
        Assert.Equal(lookups + 2, r.Seerr.CallCount("/api/v1/movie/603"));
    }

    [Fact]
    public async Task DeferralIsBoundedAndGivesUp()
    {
        using var r = new Rig();
        r.Config.ArrRequestBackend = "seerr";
        r.Config.JellyseerrEnabled = true; r.Config.JellyseerrUrls = FakeSeerr.Url; r.Config.JellyseerrApiKey = FakeSeerr.Key;
        var movie = Arrived();
        r.Library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        await r.Monitor.ProcessFromSharedFactsAsync(movie, 603, "movie", r.Config, 0);
        for (var i = 0; i < 20; i++) await r.Monitor.RecheckDeferredAsync();
        Assert.Equal(0, r.Monitor.Deferred);       // gave up after ten tries
        for (var i = 0; i < 600; i++) await r.Monitor.ProcessFromSharedFactsAsync(Arrived(), 603, "movie", r.Config, 0);
        Assert.Equal(500, r.Monitor.Deferred);
        // Phase 3 off: the deferred items are dropped (the legacy path takes over).
        r.Config.ArrPhase3Enabled = false;
        await r.Monitor.RecheckDeferredAsync();
        Assert.Equal(0, r.Monitor.Deferred);
    }

    [Theory]
    [InlineData("je", true)]
    [InlineData("seerr", false)]
    public async Task TheSeerrWatchlistSyncReadsTheSharedFactsForItsRequestLegAndSkipsItWhileIncomplete(string backend, bool expectLiked)
    {
        using var r = new Rig();
        r.Config.ArrRequestBackend = backend;
        r.Config.JellyseerrEnabled = true; r.Config.JellyseerrUrls = FakeSeerr.Url; r.Config.JellyseerrApiKey = FakeSeerr.Key;
        r.Config.SyncJellyseerrWatchlist = true;
        var asker = r.Person("Member");
        await r.R.Create(asker, IntegrationRequestLedgerTests.Movie(603));
        r.Seerr.Users.Add(new System.Text.Json.Nodes.JsonObject { ["id"] = 27, ["jellyfinUserId"] = asker.ToString("N"), ["permissions"] = 32 });
        var movie = Arrived(603);
        r.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        var task = new Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks.JellyseerrWatchlistSyncTask(r.Library.Object, r.Users.Object, r.Data.Object, r.Seerr.Transport,
            new UserConfigurationManager(r.F.Core.Paths.Object, r.F.Core.Logger), r.F.Core.Logger, r.Facts);
        await task.RunAsync(null, CancellationToken.None);
        // JE mode: the ledger says the asker asked; Seerr mode: the read model hasn't read anything yet, so the request leg waits.
        Assert.Equal(expectLiked, r.Liked(asker));
        Assert.Equal(0, r.Seerr.CallCount("/api/v1/request"));      // never the old first-page read
    }
}
