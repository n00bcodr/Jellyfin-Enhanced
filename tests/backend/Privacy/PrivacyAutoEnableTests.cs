using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace JellyfinEnhanced.Tests;

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
        Assert.Empty(SpoilerAutoEnableArmer.VisibleTo(user, [candidate]));
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        Assert.Same(candidate, Assert.Single(SpoilerAutoEnableArmer.VisibleTo(user, [candidate])));
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
