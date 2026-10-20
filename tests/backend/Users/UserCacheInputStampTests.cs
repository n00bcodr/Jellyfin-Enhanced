using System.Reflection;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 3 (COREUC-R3-2): a value carries the stamp of the inputs it was computed from. A request reads the
/// viewer, the Dashboard saves their policy, and only then does the request compute an answer from its own (earlier)
/// read: that answer may serve the rest of that request, never the next one. Each cache that keeps something decided
/// by a user is driven through its production path.
/// </summary>
[Collection("Jellyfin user versions")]
public class UserCacheInputStampTests
{
    private static User Read(Guid id, bool allFolders) => UserChange.Read(id, policy: u => u.SetPermission(PermissionKind.EnableAllFolders, allFolders));

    [Fact]
    public async Task APolicySaveBetweenTheRequestsFirstReadAndItsFourKCheckEndsTheBadgeOnTheNextRequest()
    {
        var (viewer, copy) = (Guid.NewGuid(), Guid.NewGuid());
        var current = Read(viewer, allFolders: true);
        var reads = 0;
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(() => { reads++; return current; });
        var posterUsers = new PosterTagUserCache(users.Object);
        var library = new Mock<ILibraryManager>();
        // The 4K copy lives in a library only "all folders" opens.
        library.Setup(l => l.GetItemById<BaseItem>(copy, It.IsAny<User>()))
            .Returns((Guid _, User u) => u.HasPermission(PermissionKind.EnableAllFolders) ? new Movie { Id = copy } : null);
        using var stamps = new JellyfinStampLibrary(library.Object, Mock.Of<IUserDataManager>(), posterUsers);
        using var resolver = new AcquisitionStampResolver(stamps, null!, () => null, () => DateTimeOffset.UtcNow);
        var check = typeof(AcquisitionStampResolver).GetMethod("CanOpen", BindingFlags.Instance | BindingFlags.NonPublic, [typeof(Guid), typeof(Guid)]);
        Assert.NotNull(check);
        bool CanOpen() => (bool)check.Invoke(resolver, [viewer, copy])!;
        try
        {
            UserChange.Request(new DefaultHttpContext());
            // The request reads the viewer first (a poster's tag data) ...
            Assert.NotNull(posterUsers.Get(viewer));
            // ... the Dashboard takes the 4K library away (10.11: no event) ...
            await UserChange.PolicyPost(viewer, () => current = Read(viewer, allFolders: false));
            // ... and the request's first 4K check answers from its own read.
            Assert.True(CanOpen());
            Assert.Equal(1, reads);

            // The next request: no badge (before: the request's answer, kept under the version after the save, for 30 s).
            UserChange.Request(new DefaultHttpContext());
            Assert.False(CanOpen());
            Assert.False(CanOpen());
            Assert.Equal(2, reads);
        }
        finally
        {
            UserChange.Request(null);
        }
    }

    [Fact]
    public async Task APolicySaveBetweenTheRequestsFirstReadAndItsFirstUseOfEachHeldUserIsGoneOnTheNextRequest()
    {
        var id = Guid.NewGuid();
        var current = Read(id, allFolders: true);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(() => current);
        var posterUsers = new PosterTagUserCache(users.Object);
        try
        {
            UserChange.Request(new DefaultHttpContext());
            Assert.True(UserAuthority.ReadOncePerRequest(id, users.Object.GetUserById).User!.HasPermission(PermissionKind.EnableAllFolders));
            await UserChange.PolicyPost(id, () => current = Read(id, allFolders: false));
            // This request's first use of each held-user cache: its own read.
            Assert.True(posterUsers.Get(id)!.HasPermission(PermissionKind.EnableAllFolders));
            Assert.True(ReviewAuthorCache.Resolve(id, users.Object.GetUserById)!.HasPermission(PermissionKind.EnableAllFolders));

            UserChange.Request(new DefaultHttpContext());
            Assert.False(posterUsers.Get(id)!.HasPermission(PermissionKind.EnableAllFolders));
            Assert.False(ReviewAuthorCache.Resolve(id, users.Object.GetUserById)!.HasPermission(PermissionKind.EnableAllFolders));
        }
        finally
        {
            UserChange.Request(null);
        }
    }

    [Fact]
    public async Task APolicySaveBetweenTheRequestsFirstReadAndItsBoundaryIsGoneOnTheNextRequest()
    {
        using var core = new CoreFixture();
        var (id, series) = (Guid.NewGuid(), Guid.NewGuid());
        var current = Read(id, allFolders: true);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(() => current);
        using var next = new SpoilerNextUnwatchedService(Mock.Of<ILibraryManager>(), users.Object, Mock.Of<IUserDataManager>(), core.Logger);
        var computedFor = new List<bool>();
        next.BoundaryComputerForTest = (_, _) => { computedFor.Add(current.HasPermission(PermissionKind.EnableAllFolders)); return null; };
        try
        {
            UserChange.Request(new DefaultHttpContext());
            var viewer = UserAuthority.ReadOncePerRequest(id, users.Object.GetUserById).User!;
            await UserChange.PolicyPost(id, () => current = Read(id, allFolders: false));
            // The blur filter hands the boundary the viewer it read before the save.
            next.GetBoundary(id, series, viewer);
            UserChange.Request(new DefaultHttpContext());
            next.GetBoundary(id, series);
            next.GetBoundary(id, series);
            Assert.Equal(2, computedFor.Count);
        }
        finally
        {
            UserChange.Request(null);
        }
    }

    [Fact]
    public void AnEntrysLifetimeRunsFromWhenItsInputsWereRead()
    {
        var now = 0L;
        var cache = new UserAccessCache<Guid, int>(TimeSpan.FromSeconds(30), 16, ticks: () => now);
        var user = UserChange.Read(Guid.NewGuid());
        var ticket = cache.Begin(user);
        // A slow computation (a cold access query) ...
        now += TimeSpan.FromSeconds(25).Ticks;
        cache.Set(user.Id, ticket, 1);
        Assert.True(cache.TryGet(user.Id, ticket.Authority, out _));
        // ... ends 30 s after its inputs were read, not 30 s after it was stored.
        now += TimeSpan.FromSeconds(5).Ticks;
        Assert.False(cache.TryGet(user.Id, ticket.Authority, out _));

        // The same for a held read.
        var held = new UserAccessCache<Guid, int>(TimeSpan.FromSeconds(30), 16, ticks: () => now);
        var reads = 0;
        held.GetHeld(user.Id, user.Id, () =>
        {
            reads++;
            var read = UserAuthority.ReadOncePerRequest(user.Id, _ => user);
            now += TimeSpan.FromSeconds(25).Ticks;
            return (1, read.Stamp);
        });
        now += TimeSpan.FromSeconds(5).Ticks;
        held.GetHeld(user.Id, user.Id, () => { reads++; return (2, UserAuthority.ReadOncePerRequest(user.Id, _ => user).Stamp); });
        Assert.Equal(2, reads);
    }
}
