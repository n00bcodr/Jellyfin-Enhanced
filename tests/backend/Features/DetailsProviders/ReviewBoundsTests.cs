using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace JE.Tests.Features.DetailsProviders;

// One account must not be able to grow the shared reviews store without limit: every user's
// details pages, rating chips and Activity read the whole store.
[Collection("Plugin singleton")]
public class ReviewBoundsTests
{
    private static JeDetailsProvidersController SignedIn(ApiPluginFixture f, Guid user)
    {
        // User reviews are switched on: while they are off the review routes answer 404.
        f.Plugin.Configuration.ShowUserReviews = true;
        var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), f.Core, f.Core.Manager, Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>());
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);
        return controller;
    }

    private static IActionResult Save(JeDetailsProvidersController controller, string key, string content, double? rating = null)
        => controller.UpsertReview("tv", key, new JeDetailsProvidersController.ReviewPayload { Content = content, Rating = rating });

    private static string Seed(ApiPluginFixture f, string userIdN, int count, string content)
    {
        var store = new AllReviewsStore();
        for (var i = 1; i <= count; i++)
            store.Reviews[$"{userIdN}:tv:1:s1:e{i}"] = new UserReview { UserId = userIdN, MediaType = "tv", TmdbId = $"1:s1:e{i}", Content = content, Rating = 3, CreatedAt = "2026", UpdatedAt = "2026" };
        var path = Path.Combine(f.Core.ConfigRoot, "reviews.json");
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(path, JsonConvert.SerializeObject(store, Formatting.Indented));
        return path;
    }

    [Theory]
    [InlineData("12345678901")]
    [InlineData("603\n")]
    [InlineData("603:s12345678901")]
    [InlineData("603:s1:e12345678901")]
    public void KeysNoTitleCanHaveAreRefused(string key)
    {
        using var f = new ApiPluginFixture();
        var controller = SignedIn(f, Guid.NewGuid());
        Assert.IsType<BadRequestObjectResult>(Save(controller, key, "x"));
        Assert.Empty(f.Core.Manager.GetAllReviews().Reviews);
        // The largest 32-bit ids and numbers still work.
        Assert.IsType<OkObjectResult>(Save(controller, "2147483647:s2023:e15000", "x"));
    }

    [Fact]
    public void AnAccountAtTenThousandReviewsCanEditAndDeleteButNotAdd()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var id = user.ToString("N");
        var path = Seed(f, id, 10_000, string.Empty);
        var bytes = File.ReadAllBytes(path);
        var controller = SignedIn(f, user);

        Assert.Contains("Delete", Assert.IsType<BadRequestObjectResult>(Save(controller, "2", "new", 4)).Value!.ToString());
        Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.IsType<OkObjectResult>(Save(controller, "1:s1:e7", "edited", 5));
        Assert.IsType<OkObjectResult>(controller.DeleteReview("tv", "1:s1:e8"));
        Assert.IsType<OkObjectResult>(Save(controller, "2", "new", 4));
        Assert.IsType<BadRequestObjectResult>(Save(controller, "3", "new", 4));
        // Another account is not affected.
        Assert.IsType<OkObjectResult>(Save(SignedIn(f, Guid.NewGuid()), "3", "new", 4));
        Assert.Equal(10_001, f.Core.Manager.GetAllReviews().Reviews.Count);
    }

    [Fact]
    public void AnAccountHoldsAtMostTwoMillionCharactersOfReviewText()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        Seed(f, user.ToString("N"), 1_000, new string('a', 2_000));
        var controller = SignedIn(f, user);

        Assert.IsType<BadRequestObjectResult>(Save(controller, "2", "more text"));
        // A rating without text, and edits that add no text, still save.
        Assert.IsType<OkObjectResult>(Save(controller, "2", string.Empty, 4));
        Assert.IsType<OkObjectResult>(Save(controller, "1:s1:e1", new string('b', 2_000)));
        Assert.IsType<OkObjectResult>(Save(controller, "1:s1:e1", "short"));
        Assert.IsType<OkObjectResult>(Save(controller, "3", new string('c', 1_995)));
        Assert.IsType<BadRequestObjectResult>(Save(controller, "4", "x"));
    }
}
