using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Identity;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Events;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Features.SpoilerGuard;

[Collection("Plugin singleton")]
public class PrivacyAutoEnableTests
{
    private static int _tmdbId = 1900000;
    [Fact]
    public void BulkArmingCountsSkipsPreservesExistingAndDryRunDoesNotPersist()
    {
        using var f = new JE.Tests.CoreFixture(); var user = Guid.NewGuid().ToString("N");
        var candidates = Enumerable.Range(0, 5).Select(i => new SpoilerAutoEnableArmer.Candidate { Id = Guid.NewGuid(), IdN = Guid.NewGuid().ToString("N"), IsSeries = i % 2 == 0, Name = "Title " + i }).ToArray();
        var state = new UserSpoilerBlur(); state.Series[candidates[0].IdN] = new() { EnabledAt = "original", SeriesName = "original name" };
        f.Manager.SaveUserConfiguration(user, SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        SpoilerAutoEnableArmer.SkipReason Skip(SpoilerAutoEnableArmer.Candidate c) => c == candidates[3] ? SpoilerAutoEnableArmer.SkipReason.Watched : c == candidates[4] ? SpoilerAutoEnableArmer.SkipReason.Started : SpoilerAutoEnableArmer.SkipReason.None;
        var preview = SpoilerAutoEnableArmer.ArmForUser(f.Manager, user, candidates, Skip, true, "new");
        Assert.Equal(2, preview.Armed); Assert.Equal(1, preview.AlreadyArmed); Assert.Equal(1, preview.SkippedWatched); Assert.Equal(1, preview.SkippedStarted);
        Assert.Single(f.Manager.GetUserConfiguration<UserSpoilerBlur>(user, SpoilerBlurImageFilter.SpoilerBlurFileName)!.Series);
        var applied = SpoilerAutoEnableArmer.ArmForUser(f.Manager, user, candidates, Skip, false, "new"); Assert.Equal(preview, applied);
        var saved = f.Manager.GetUserConfiguration<UserSpoilerBlur>(user, SpoilerBlurImageFilter.SpoilerBlurFileName)!;
        Assert.Equal("original", saved.Series[candidates[0].IdN].EnabledAt); Assert.Equal("original name", saved.Series[candidates[0].IdN].SeriesName);
        Assert.Equal(2, saved.Series.Count); Assert.Single(saved.Movies);
        Assert.Equal(0, SpoilerAutoEnableArmer.ArmForUser(f.Manager, user, candidates, Skip, false, "later").Armed);
    }

    [Fact]
    public void BulkCandidatesHonorTypeAndLibraryScopeAndRestrictedUsers()
    {
        var cfg = new PluginConfiguration { SpoilerAutoEnableSeries = false, SpoilerAutoEnableMovies = true };
        var library = new Mock<ILibraryManager>(); var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie" }; var folder = Guid.NewGuid();
        library.Setup(x => x.GetCollectionFolders(movie)).Returns(new List<Folder> { new CollectionFolder { Id = folder } });
        Assert.Null(SpoilerAutoEnableArmer.TryBuildCandidate(library.Object, new Series(), cfg, null, false));
        Assert.Null(SpoilerAutoEnableArmer.TryBuildCandidate(library.Object, new Episode(), cfg, null, false));
        Assert.Null(SpoilerAutoEnableArmer.TryBuildCandidate(library.Object, movie, cfg, [Guid.NewGuid()], true));
        var candidate = SpoilerAutoEnableArmer.TryBuildCandidate(library.Object, movie, cfg, [folder], true)!;
        Assert.Equal(movie.Id, candidate.Id); Assert.Contains(folder, candidate.LibraryIds);
        var user = new User("test", "default", "default"); user.SetPermission(PermissionKind.EnableAllFolders, false);
        Assert.Empty(SpoilerAutoEnableArmer.VisibleTo(library.Object, user, [candidate]));
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        Assert.Same(candidate, Assert.Single(SpoilerAutoEnableArmer.VisibleTo(library.Object, user, [candidate])));
    }

    [Theory]
    [InlineData(1, 1, false, true, true)]
    [InlineData(1, 1, true, true, false)]
    [InlineData(1, 2, false, true, false)]
    [InlineData(2, 1, false, true, false)]
    [InlineData(1, 1, false, false, false)]
    public async Task FirstPlayConsumerOnlyArmsUnseenS1E1(int season, int episodeNumber, bool previouslyWatched, bool enabled, bool expected)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.SpoilerBlurEnabled = true; f.Plugin.Configuration.SpoilerAutoEnableOnFirstPlay = enabled;
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() }; var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = season, IndexNumber = episodeNumber };
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemById(series.Id)).Returns(series);
        library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery query) => {
            Assert.True(query.IsPlayed); Assert.Equal(new[] { series.Id }, query.AncestorIds); Assert.Equal(1, query.Limit);
            return previouslyWatched ? new BaseItem[] { episode } : Array.Empty<BaseItem>(); });
        var users = new Mock<IUserManager>(); users.Setup(x => x.GetUserById(user.Id)).Returns(user);
        var consumer = new SpoilerAutoEnableOnFirstPlayConsumer(f.Core.Manager, library.Object, users.Object, f.Core.Logger);
        var args = new PlaybackStartEventArgs { Item = episode, Session = new SessionInfo(Mock.Of<ISessionManager>(), NullLogger.Instance) { UserId = user.Id } };
        await consumer.OnEvent(args); await consumer.OnEvent(args);
        var saved = f.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName);
        Assert.Equal(expected ? 1 : 0, saved?.Series.Count ?? 0);
        if (expected) Assert.Equal("Series", saved!.Series[series.Id.ToString("N")].SeriesName);
    }

    // Jellyfin's id query is the judge of what a user may see; here it hides the rated film from the limited child,
    // as a maximum parental rating does on a real server.
    private sealed record ParentalSetup(Mock<ILibraryManager> Library, Mock<IUserManager> Users, User Admin, User Child, Movie Family, Movie Rated)
    {
        public static ParentalSetup Create()
        {
            var family = new Movie { Id = Guid.NewGuid(), Name = "Family film" }; var rated = new Movie { Id = Guid.NewGuid(), Name = "Rated film" };
            var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() }; var child = new User("child", "default", "default") { Id = Guid.NewGuid(), MaxParentalRatingScore = 10 };
            foreach (var user in new[] { admin, child }) user.SetPermission(PermissionKind.EnableAllFolders, true);
            var library = new Mock<ILibraryManager>();
            library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == null ? new BaseItem[] { family, rated } : Array.Empty<BaseItem>());
            library.Setup(x => x.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => (BaseItem?)(id == family.Id ? family : id == rated.Id ? rated : null));
            library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                q.IsPlayed != null || q.IsResumable != null ? Array.Empty<Guid>() : q.MaxParentalRating != null ? new[] { family.Id } : new[] { family.Id, rated.Id });
            var users = new Mock<IUserManager>(); users.Setup(x => x.GetUsers()).Returns(new[] { admin, child });
            users.Setup(x => x.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => id == admin.Id ? admin : id == child.Id ? child : null);
            return new ParentalSetup(library, users, admin, child, family, rated);
        }

        public string[] Keys(params Movie[] movies) => movies.Select(m => m.Id.ToString("N")).OrderBy(k => k).ToArray();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BulkAutoEnableNeverArmsATitleTheUsersParentalRatingHides(bool libraryAdd)
    {
        using var f = new JE.Tests.ApiPluginFixture(); var s = ParentalSetup.Create();
        f.Plugin.Configuration.SpoilerBlurEnabled = true; f.Plugin.Configuration.SpoilerAutoEnableOnLibraryAdd = true;
        if (libraryAdd)
        {
            var enabler = new SpoilerLibraryAddAutoEnabler(s.Library.Object, s.Users.Object, f.Core.Manager, f.Core.Logger);
            await enabler.StartAsync(CancellationToken.None);
            foreach (var movie in new[] { s.Family, s.Rated }) s.Library.Raise(x => x.ItemAdded += null, s.Library.Object, new ItemChangeEventArgs { Item = movie });
            await enabler.StopAsync(CancellationToken.None); enabler.Dispose();
        }
        else new SpoilerExistingTitlesApplier(s.Library.Object, s.Users.Object, f.Core.Manager, f.Core.Logger).Run(new SpoilerExistingTitlesApplier.Options(), null, CancellationToken.None);
        UserSpoilerBlur Saved(User user) => f.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName)!;
        Assert.Equal(s.Keys(s.Family, s.Rated), Saved(s.Admin).Movies.Keys.OrderBy(k => k).ToArray());
        Assert.Equal(s.Keys(s.Family), Saved(s.Child).Movies.Keys.OrderBy(k => k).ToArray());
    }

    [Fact]
    public void AnEntryForATitleTheUserMayNotSeeIsNeverSentToThem()
    {
        using var f = new JE.Tests.ApiPluginFixture(); var s = ParentalSetup.Create(); f.Plugin.Configuration.SpoilerBlurEnabled = true;
        var childKey = s.Child.Id.ToString("N");
        var state = new UserSpoilerBlur();
        foreach (var movie in new[] { s.Family, s.Rated }) state.Movies[movie.Id.ToString("N")] = new() { MovieId = movie.Id.ToString("N"), MovieName = movie.Name };
        foreach (var user in new[] { s.Child, s.Admin }) f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        JeSpoilerGuardController Guard(User caller)
        {
            var guard = (JeSpoilerGuardController)JE.Tests.ApiAssetTests.Controller(typeof(JeSpoilerGuardController), f.Core, s.Library.Object, s.Users.Object, f.Core.Manager);
            guard.HttpContext.User = PrivacyPolicyTests.Principal(caller.Id, caller == s.Admin); return guard;
        }
        string[] Sent(IActionResult result) => Assert.IsType<UserSpoilerBlur>(Assert.IsType<OkObjectResult>(result).Value).Movies.Keys.OrderBy(k => k).ToArray();
        Assert.Equal(s.Keys(s.Family), Sent(Guard(s.Child).GetSpoilerBlurSeries()));
        Assert.Equal(s.Keys(s.Family), Sent(Guard(s.Child).GetUserSpoilerBlur(childKey)));
        var maintenance = new Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance.MaintenanceModeService(s.Users.Object, Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var platform = JE.Tests.ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager, s.Library.Object, s.Users.Object);
        platform.HttpContext.User = PrivacyPolicyTests.Principal(s.Child.Id);
        var bootstrap = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Transport.BootstrapResponse>(Assert.IsType<JsonResult>(platform.GetBootstrap()).Value);
        Assert.Equal(s.Keys(s.Family), bootstrap.Prefetched.SpoilerBlurSeries!.Movies.Keys.OrderBy(k => k).ToArray());
        // A user who may see every title still gets their whole list; and the stored file is unchanged.
        Assert.Equal(s.Keys(s.Family, s.Rated), Sent(Guard(s.Admin).GetSpoilerBlurSeries()));
        Assert.Equal(s.Keys(s.Family, s.Rated), f.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(childKey, SpoilerBlurImageFilter.SpoilerBlurFileName)!.Movies.Keys.OrderBy(k => k).ToArray());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AListWithNoSeriesOrFilmAsksNoUserLookup(bool documentSaved)
    {
        // Every page load sends the caller's list in the bootstrap; with no series or film in it there is nothing
        // to hide, so Jellyfin's user database is not asked (an admin's bootstrap reads no user otherwise).
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.SpoilerBlurEnabled = true;
        var caller = Guid.NewGuid();
        var state = new UserSpoilerBlur { Collections = new() { [new string('c', 32)] = new() { CollectionName = "Collection" } } };
        if (documentSaved) f.Core.Manager.SaveUserConfiguration(caller.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        // A returning user: Hidden Content's first-visit seeding (which logs the user's name) is done.
        f.Core.Manager.SaveUserConfiguration(caller.ToString("N"), "hidden-content.json", new UserHiddenContent());
        var users = new Mock<IUserManager>();
        var guard = (JeSpoilerGuardController)JE.Tests.ApiAssetTests.Controller(typeof(JeSpoilerGuardController), f.Core, Mock.Of<ILibraryManager>(), users.Object, f.Core.Manager);
        guard.HttpContext.User = PrivacyPolicyTests.Principal(caller, admin: true);
        Assert.Equal(documentSaved ? 1 : 0, Assert.IsType<UserSpoilerBlur>(Assert.IsType<OkObjectResult>(guard.GetSpoilerBlurSeries()).Value).Collections.Count);
        Assert.Equal(documentSaved ? 1 : 0, Assert.IsType<UserSpoilerBlur>(Assert.IsType<OkObjectResult>(guard.GetUserSpoilerBlur(caller.ToString("N"))).Value).Collections.Count);
        var maintenance = new Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance.MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var platform = JE.Tests.ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager, Mock.Of<ILibraryManager>(), users.Object);
        platform.HttpContext.User = PrivacyPolicyTests.Principal(caller, admin: true);
        var bootstrap = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Transport.BootstrapResponse>(Assert.IsType<JsonResult>(platform.GetBootstrap()).Value);
        Assert.Equal(documentSaved ? 1 : 0, bootstrap.Prefetched.SpoilerBlurSeries!.Collections.Count);
        users.Verify(x => x.GetUserById(It.IsAny<Guid>()), Times.Never());
    }

    private sealed record PendingSetup(JE.Tests.ApiPluginFixture Fixture, User Alice, User Bob, Series Series, string PendingKey, Mock<ILibraryManager> Library, SpoilerSeerrPendingPromoter Service) : IAsyncDisposable
    {
        public UserSpoilerBlur Saved(User user) => Fixture.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName)!;
        public async ValueTask DisposeAsync()
        {
            // Bounded so a stuck sweep cannot hang the run. StopAsync swallows the host giving up,
            // so a sweep still running after it is caught by the zero-wait check instead.
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try
            {
                await Service.StopAsync(timeout.Token);
                await Service.WaitForSweepsAsync().WaitAsync(TimeSpan.Zero);
            }
            finally
            {
                SpoilerSeerrPendingPromoter.UnregisterPending(PendingKey, Alice.Id); SpoilerSeerrPendingPromoter.UnregisterPending(PendingKey, Bob.Id);
                Fixture.Dispose();
            }
        }
    }

    // Alice and Bob both have the series pending on disk; only Alice can see it.
    private static PendingSetup SetUpPending()
    {
        var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.SpoilerBlurEnabled = true;
        var alice = new User("alice", "default", "default") { Id = Guid.NewGuid() }; var bob = new User("bob", "default", "default") { Id = Guid.NewGuid() };
        var tmdb = Interlocked.Increment(ref _tmdbId).ToString(); var pendingKey = "tv:" + tmdb;
        var series = new Series { Id = Guid.NewGuid(), Name = "Acquired series", ProviderIds = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = tmdb } };
        foreach (var user in new[] { alice, bob }) {
            var state = new UserSpoilerBlur(); state.PendingTmdb[pendingKey] = new() { TmdbId = tmdb, MediaType = "tv" };
            f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        }
        var users = new Mock<IUserManager>(); users.Setup(x => x.GetUserById(alice.Id)).Returns(alice); users.Setup(x => x.GetUserById(bob.Id)).Returns(bob);
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemById<BaseItem>(series.Id, alice)).Returns(series); library.Setup(x => x.GetItemById<BaseItem>(series.Id, bob)).Returns((BaseItem?)null);
        var service = new SpoilerSeerrPendingPromoter(library.Object, users.Object, f.Core.Manager, f.Core.Paths.Object, f.Core.Logger) { SweepSettleDelay = TimeSpan.Zero };
        return new PendingSetup(f, alice, bob, series, pendingKey, library, service);
    }

    [Fact]
    public async Task PendingPromoterRestoresFromDiskAndPromotesOnlyAccessibleUserOnLibraryEvent()
    {
        await using var p = SetUpPending();
        await p.Service.StartAsync(CancellationToken.None);
        p.Library.Raise(x => x.ItemUpdated += null, p.Library.Object, new ItemChangeEventArgs { Item = p.Series });
        // Every user of the sweep has been handled once it has finished.
        await p.Service.WaitForSweepsAsync().WaitAsync(TimeSpan.FromSeconds(15));
        var savedAlice = p.Saved(p.Alice); var savedBob = p.Saved(p.Bob);
        Assert.Empty(savedAlice.PendingTmdb); Assert.Equal("Acquired series", savedAlice.Series[p.Series.Id.ToString("N")].SeriesName);
        Assert.Contains(p.PendingKey, savedBob.PendingTmdb.Keys); Assert.Empty(savedBob.Series);
    }

    [Fact]
    public async Task PendingPromoterStopWaitsForARunningSweepAndCancelsSettlingOnes()
    {
        await using var p = SetUpPending();
        using var entered = new SemaphoreSlim(0); using var release = new SemaphoreSlim(0);
        p.Library.Setup(x => x.GetItemById<BaseItem>(p.Series.Id, p.Alice)).Returns(() => { entered.Release(); release.Wait(); return p.Series; });
        await p.Service.StartAsync(CancellationToken.None);
        p.Library.Raise(x => x.ItemUpdated += null, p.Library.Object, new ItemChangeEventArgs { Item = p.Series });
        Assert.True(await entered.WaitAsync(TimeSpan.FromSeconds(15)));
        var stop = p.Service.StopAsync(CancellationToken.None);
        try
        {
            await Task.Delay(100);
            Assert.False(stop.IsCompleted);
        }
        finally
        {
            // Always unblock the sweep, even when the assertion fails.
            release.Release();
        }
        await stop.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Empty(p.Saved(p.Alice).PendingTmdb);

        // A sweep still in its settle delay is dropped by StopAsync rather than run later.
        await using var q = SetUpPending();
        q.Service.SweepSettleDelay = TimeSpan.FromMinutes(5);
        await q.Service.StartAsync(CancellationToken.None);
        q.Library.Raise(x => x.ItemUpdated += null, q.Library.Object, new ItemChangeEventArgs { Item = q.Series });
        await q.Service.StopAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(15));
        await q.Service.WaitForSweepsAsync().WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Contains(q.PendingKey, q.Saved(q.Alice).PendingTmdb.Keys);
    }
}
