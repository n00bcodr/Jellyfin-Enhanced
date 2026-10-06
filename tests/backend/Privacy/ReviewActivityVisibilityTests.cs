using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Moq;

namespace JE.Tests;

public class ReviewActivityVisibilityTests
{
    private static User User(Guid? id = null) => new("author", "default", "default") { Id = id ?? Guid.NewGuid() };

    [Fact]
    public void AllModerationCombinationsPreserveAdministratorSelfAndOrphanRules()
    {
        foreach (var exists in new[] {false,true})
        foreach (var hidden in new[] {false,true})
        foreach (var disabled in new[] {false,true})
        foreach (var hideHidden in new[] {false,true})
        foreach (var hideDisabled in new[] {false,true})
        foreach (var admin in new[] {false,true})
        foreach (var self in new[] {false,true})
        {
            var author = User(); author.SetPermission(PermissionKind.IsHidden, hidden); author.SetPermission(PermissionKind.IsDisabled, disabled);
            var review = new UserReview { UserId = author.Id.ToString("N") };
            var expected = admin || (exists && self) || (exists ? !(hidden && hideHidden || disabled && hideDisabled) : !(hideHidden || hideDisabled));
            var actual = ReviewVisibility.IsVisible(review, admin, self ? review.UserId.ToUpperInvariant() : Guid.NewGuid().ToString("N"), hideHidden, hideDisabled,
                _ => exists ? author : null, out var resolved, out var orphan);
            Assert.Equal(expected, actual); Assert.Equal(exists ? author : null, resolved);
            Assert.Equal(!exists && !admin && (hideHidden || hideDisabled), orphan);
        }
    }

    [Fact]
    public void MalformedAuthorNeverTriggersLookupAndCannotClaimSelfVisibility()
    {
        var review = new UserReview { UserId = "malformed" };
        Assert.False(ReviewVisibility.IsVisible(review, false, "malformed", true, true, _ => throw new Exception("unexpected lookup"), out var author, out var orphan));
        Assert.Null(author); Assert.True(orphan);
    }

    [Fact]
    public void AuthorCacheSeparatesUsersCachesDeletionAndRejectsLookupRacingInvalidation()
    {
        var first = User(); var second = User(); var calls = 0;
        User? Lookup(Guid id) { calls++; return id == first.Id ? first : null; }
        Assert.Same(first, ReviewAuthorCache.Resolve(first.Id, Lookup));
        Assert.Same(first, ReviewAuthorCache.Resolve(first.Id, Lookup));
        Assert.Null(ReviewAuthorCache.Resolve(second.Id, Lookup)); Assert.Null(ReviewAuthorCache.Resolve(second.Id, Lookup));
        Assert.Equal(2,calls);
        var race = Guid.NewGuid();
        Assert.Same(first, ReviewAuthorCache.Resolve(race, _ => { ReviewAuthorCache.Invalidate(); return first; }));
        Assert.Same(second, ReviewAuthorCache.Resolve(race, _ => second));
        Assert.Same(second, ReviewAuthorCache.Resolve(race, _ => throw new Exception("expected fresh cache")));
    }

    [Fact]
    public void FeedFiltersBeforeLimitAndDoesNotReusePermissionsOrAuthorsAcrossRequests()
    {
        using var env = new CoreFixture();
        var viewer = User(); var author = User(); var blocked = Guid.NewGuid(); var allowed = Guid.NewGuid();
        var library = new Mock<ILibraryManager>(); var users = new Mock<IUserManager>(); var repository = new Mock<IItemRepository>();
        var allowedIds = new[] { allowed };
        // Library items are only visible to a query scoped to a user: on Jellyfin 12 by
        // ConfigureUserAccess(query, user), on 10.11 by the user-bound recursive query.
        var scopedTo = new Dictionary<InternalItemsQuery, User>(ReferenceEqualityComparer.Instance);
#if NET9_0
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns<InternalItemsQuery>(query => query.User == null ? [] : allowedIds);
#else
        library.Setup(x => x.ConfigureUserAccess(It.IsAny<InternalItemsQuery>(), It.IsAny<User>())).Callback<InternalItemsQuery, User>((query, user) => scopedTo[query] = user);
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns<InternalItemsQuery>(query => scopedTo.ContainsKey(query) ? allowedIds : []);
#endif
        library.Setup(x => x.GetItemById(allowed)).Returns(new Movie { Id = allowed, Name = "Visible movie" });
        users.Setup(x => x.GetUserById(author.Id)).Returns(author);
        var builder = new ActivityFeedBuilder(library.Object,users.Object,repository.Object,env.Logger);
        var config = new PluginConfiguration { ActivityFeedShowWatched = true, HideReviewsFromHiddenUsers = true };
        var entries = new[] {new ActivityEntry { UserId = author.Id.ToString("N"), ItemId = blocked.ToString("N"), ActivityType = "Watched", OccurredAt = "2025-01-02T00:00:00Z" },
            new ActivityEntry { UserId = author.Id.ToString("N"), ItemId = allowed.ToString("N"), ActivityType = "Watched", OccurredAt = "2025-01-01T00:00:00Z", Completed = true, Progress = 1 }};
        var row = Assert.Single(builder.Build(entries, [], viewer, false, config, 1));
        Assert.Equal("author",row.UserName); Assert.True(row.Completed); Assert.Equal(1,row.Progress);
        library.Verify(x => x.GetItemById(blocked), Times.Never);
#if !NET9_0
        Assert.Contains(viewer, scopedTo.Values);
#endif
        allowedIds = [];
        Assert.Empty(builder.Build(entries, [], User(), false, config, 1));
        // A later request sees the author's new state from a fresh lookup (a new User object),
        // not an author resolved for an earlier request.
        allowedIds = [allowed];
        var hiddenAuthor = User(author.Id); hiddenAuthor.SetPermission(PermissionKind.IsHidden,true);
        users.Setup(x => x.GetUserById(author.Id)).Returns(hiddenAuthor);
        Assert.Empty(builder.Build(entries, [], viewer, false, config, 1));
        Assert.Single(builder.Build(entries, [], hiddenAuthor, false, config, 1));
        Assert.Single(builder.Build(entries, [], viewer, true, config, 1));
    }

    [Fact]
    public void DisabledFeedCategoriesAndCancellationNeverQueryLibrary()
    {
        using var env = new CoreFixture();
        var library = new Mock<ILibraryManager>(MockBehavior.Strict);
        var builder = new ActivityFeedBuilder(library.Object,Mock.Of<IUserManager>(),Mock.Of<IItemRepository>(),env.Logger);
        var entry = new ActivityEntry { UserId = Guid.NewGuid().ToString("N"), ItemId = Guid.NewGuid().ToString("N"), ActivityType = "Watched", OccurredAt = "2025-01-01T00:00:00Z" };
        Assert.Empty(builder.Build([entry], [], User(), false, new PluginConfiguration { ActivityFeedShowWatched = false }, 1));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => builder.Build([entry], [], User(), false, new PluginConfiguration(), 1, cancelled.Token));
    }
}
