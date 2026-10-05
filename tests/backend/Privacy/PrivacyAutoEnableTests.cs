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

    [Fact]
    public async Task PendingPromoterRestoresFromDiskAndPromotesOnlyAccessibleUserOnLibraryEvent()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.SpoilerBlurEnabled = true;
        var alice = new User("alice", "default", "default") { Id = Guid.NewGuid() }; var bob = new User("bob", "default", "default") { Id = Guid.NewGuid() };
        var tmdb = Interlocked.Increment(ref _tmdbId).ToString(); var pendingKey = "tv:" + tmdb;
        var series = new Series { Id = Guid.NewGuid(), Name = "Acquired series", ProviderIds = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = tmdb } };
        foreach (var user in new[] { alice, bob }) {
            var state = new UserSpoilerBlur(); state.PendingTmdb[pendingKey] = new() { TmdbId = tmdb, MediaType = "tv" };
            f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        }
        var users = new Mock<IUserManager>(); users.Setup(x => x.GetUserById(alice.Id)).Returns(alice); users.Setup(x => x.GetUserById(bob.Id)).Returns(bob);
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemById<BaseItem>(series.Id, alice)).Returns(series); library.Setup(x => x.GetItemById<BaseItem>(series.Id, bob)).Returns((BaseItem?)null);
        var promoted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Core.Manager.UserConfigurationSaved += (id, file) => { if (id == alice.Id.ToString("N") && file == SpoilerBlurImageFilter.SpoilerBlurFileName) promoted.TrySetResult(); };
        var service = new SpoilerSeerrPendingPromoter(library.Object, users.Object, f.Core.Manager, f.Core.Paths.Object, f.Core.Logger);
        try {
            await service.StartAsync(CancellationToken.None);
            library.Raise(x => x.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = series });
            await promoted.Task.WaitAsync(TimeSpan.FromSeconds(15));
            var savedAlice = f.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName)!;
            var savedBob = f.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(bob.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName)!;
            Assert.Empty(savedAlice.PendingTmdb); Assert.Equal("Acquired series", savedAlice.Series[series.Id.ToString("N")].SeriesName);
            Assert.Contains(pendingKey, savedBob.PendingTmdb.Keys); Assert.Empty(savedBob.Series);
        } finally { await service.StopAsync(CancellationToken.None); SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, alice.Id); SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, bob.Id); }
    }
}
