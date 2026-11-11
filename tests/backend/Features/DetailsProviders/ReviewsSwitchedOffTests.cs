using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Activity;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.DetailsProviders;

/// <summary>
/// With user reviews switched off (ShowUserReviews, off by default) no user can post, read or remove
/// reviews through the review routes, and no stored review reaches the Activity feed. The administrator's
/// review list and delete keep working, so text posted earlier can still be removed.
/// </summary>
[Collection("Plugin singleton")]
public class ReviewsSwitchedOffTests
{
    private sealed class Lab : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public User Viewer { get; } = new("viewer", "default", "default") { Id = Guid.NewGuid() };
        private readonly object[] services;

        public Lab(bool reviewsOn)
        {
            var config = Plugin.Plugin.Configuration;
            config.ShowUserReviews = reviewsOn;
            config.ActivityFeedEnabled = true;
            config.ActivityFeedShowReviewed = true;
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(Viewer.Id)).Returns(Viewer);
            var itemId = Guid.NewGuid();
            var library = new Mock<ILibraryManager>();
            library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new List<Guid> { itemId });
            library.Setup(x => x.GetItemById(itemId)).Returns(new Movie { Id = itemId, Name = "Reviewed film" });
            var repository = new Mock<IItemRepository>();
            repository.Setup(x => x.GetItemIdsList(It.IsAny<InternalItemsQuery>())).Returns(new List<Guid> { itemId });
            services = [Plugin.Core.Manager, users.Object, library.Object, repository.Object];
        }

        public T Controller<T>(bool admin = false) where T : ControllerBase
        {
            var controller = (T)ApiAssetTests.Controller(typeof(T), Plugin.Core, services);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Viewer.Id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public string[] FeedTypes()
        {
            var feed = Assert.IsType<OkObjectResult>(Controller<JeActivityController>().GetActivityFeed());
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(feed.Value));
            return json.RootElement.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("ActivityType").GetString()!).ToArray();
        }

        public void Dispose() => Plugin.Dispose();
    }

    private static readonly JeDetailsProvidersController.ReviewPayload Text = new() { Content = "Posted while reviews are off", Rating = 4 };

    [Fact]
    public void NoUserCanPostReadOrRemoveReviewsWhileTheyAreSwitchedOff()
    {
        using var lab = new Lab(reviewsOn: false);
        var reviews = lab.Controller<JeDetailsProvidersController>();

        Assert.IsType<NotFoundResult>(reviews.UpsertReview("movie", "603", Text));
        Assert.Empty(lab.Plugin.Core.Manager.GetAllReviews().Reviews);

        // A review stored while the feature was on is neither shown nor counted, and stays for the admin.
        lab.Plugin.Core.Manager.UpsertReview(lab.Viewer.Id.ToString("N"), "movie", "603", "Posted earlier", 5, DateTime.UtcNow.ToString("o"));
        Assert.IsType<NotFoundResult>(reviews.GetItemReviews("movie", "603"));
        Assert.IsType<NotFoundResult>(reviews.GetReviewRatings("movie:603"));
        Assert.IsType<NotFoundResult>(reviews.DeleteReview("movie", "603"));
        Assert.Single(lab.Plugin.Core.Manager.GetAllReviews().Reviews);
        Assert.DoesNotContain("Reviewed", lab.FeedTypes());

        // The administrator can still find and remove it.
        var admin = lab.Controller<JeDetailsProvidersController>(admin: true);
        Assert.Contains("Posted earlier", JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(admin.AdminListReviews()).Value));
    }

    [Fact]
    public void WithReviewsOnTheRoutesAndTheFeedWorkAsBefore()
    {
        using var lab = new Lab(reviewsOn: true);
        var reviews = lab.Controller<JeDetailsProvidersController>();

        Assert.IsType<OkObjectResult>(reviews.UpsertReview("movie", "603", Text));
        Assert.Contains(Text.Content, JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(reviews.GetItemReviews("movie", "603")).Value));
        Assert.Contains("\"count\":1", JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(reviews.GetReviewRatings("movie:603")).Value));
        Assert.Contains("Reviewed", lab.FeedTypes());
        Assert.IsType<OkObjectResult>(reviews.DeleteReview("movie", "603"));
        Assert.Empty(lab.Plugin.Core.Manager.GetAllReviews().Reviews);
    }
}
