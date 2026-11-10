using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Reviews;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Activity.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;

namespace JE.Tests.Features.DetailsProviders;

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
}
