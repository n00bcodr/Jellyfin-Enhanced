using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Seerr filter profiles (Helpers/DiscoveryFilterProfiles.cs and the user-settings endpoints): a user's own named
/// sets of the Filters menu's filters, in the address form, checked for shape, capped, replaced by name and deletable.
/// </summary>
[Collection("Plugin singleton")]
public class ApiDiscoveryFilterProfilesTests
{
    private static (JellyfinEnhancedController Controller, string User) Signed(ApiPluginFixture f)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager);
        var user = Guid.NewGuid();
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user, false) } };
        return (controller, user.ToString("N"));
    }

    private static JsonElement Json(object value) => JsonDocument.Parse(JsonSerializer.Serialize(value)).RootElement.Clone();

    private static JsonNode Body(IActionResult result) => JsonNode.Parse(JsonSerializer.Serialize(((ObjectResult)result).Value))!;

    private static IActionResult Save(JellyfinEnhancedController controller, string user, string name, string filters)
        => controller.SaveDiscoveryFilterProfile(user, Json(new { name, filters }));

    [Fact]
    public void UsersCannotReadSaveOrDeleteAnotherUsersProfiles()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = Signed(f);
        var other = Guid.NewGuid().ToString("N");
        Assert.IsType<ForbidResult>(controller.GetDiscoveryFilterProfiles(other));
        Assert.IsType<ForbidResult>(Save(controller, other, "Kids", "jeType=movies"));
        Assert.IsType<ForbidResult>(controller.DeleteDiscoveryFilterProfile(other, "abc"));
    }

    [Fact]
    public void ProfilesAreCheckedForShapeSavedByNameCappedAndDeletable()
    {
        using var f = new ApiPluginFixture();
        var (controller, user) = Signed(f);
        Assert.Empty(Body(controller.GetDiscoveryFilterProfiles(user))["profiles"]!.AsArray());

        // The address form the pages write, names and all.
        const string Kids = "jeType=series&jeGenres=16/16:Animation,10751/10751:Family,/10762:Kids&jeKeywords=10468:bear,12554:dragon&jeAny=genres,keywords&jeScore=7..";
        var saved = Body(Assert.IsType<OkObjectResult>(Save(controller, user, "  Kids ", Kids)));
        Assert.Equal("Kids", (string?)saved["profile"]!["name"]);
        Assert.Equal(Kids, (string?)saved["profile"]!["filters"]);
        var id = (string)saved["profile"]!["id"]!;

        // The same name (any case) takes the new filters, keeping its id and place.
        var again = Body(Assert.IsType<OkObjectResult>(Save(controller, user, "kids", "jeType=movies&jeServices=8:Netflix%20Kids")));
        Assert.Equal(id, (string?)again["profile"]!["id"]);
        Assert.Equal("kids", (string?)again["profile"]!["name"]);
        var list = Body(controller.GetDiscoveryFilterProfiles(user));
        Assert.Single(list["profiles"]!.AsArray());
        Assert.Equal("jeType=movies&jeServices=8:Netflix%20Kids", (string?)list["profiles"]![0]!["filters"]);
        Assert.Equal(DiscoveryFilterProfiles.MaxProfiles, (int)list["max"]!);

        foreach (var (name, filters, error) in new[]
        {
            ("", "jeType=movies", "name"),
            (new string('n', DiscoveryFilterProfiles.MaxName + 1), "jeType=movies", "name"),
            ("Tab\there", "jeType=movies", "name"),
            ("x", "", "empty"),
            ("x", "jeCategory=trending", "filters"),
            ("x", "tab=2&jeType=movies", "filters"),
            ("x", "jeType=movies&jeType=series", "filters"),
            ("x", "jeServices=8:<b>Netflix</b>", "filters"),
            ("x", "jeType=", "filters"),
            ("x", "jeType=movies&", "filters"),
            ("x", "jeKeywords=" + new string('1', DiscoveryFilterProfiles.MaxFilters), "filters"),
        })
        {
            Assert.Equal(error, (string?)Body(Assert.IsType<BadRequestObjectResult>(Save(controller, user, name, filters)))["error"]);
        }
        Assert.Equal("filters", (string?)Body(Assert.IsType<BadRequestObjectResult>(controller.SaveDiscoveryFilterProfile(user, Json(new[] { 1 }))))["error"]);

        for (var i = 2; i <= DiscoveryFilterProfiles.MaxProfiles; i++)
            Assert.IsType<OkObjectResult>(Save(controller, user, $"P{i}", "jeScore=7.."));
        var full = Body(Assert.IsType<BadRequestObjectResult>(Save(controller, user, "One more", "jeScore=8..")));
        Assert.Equal("full", (string?)full["error"]);
        // Full, a profile of a name already kept can still be saved over.
        Assert.IsType<OkObjectResult>(Save(controller, user, "P2", "jeScore=9.."));

        Assert.IsType<OkObjectResult>(controller.DeleteDiscoveryFilterProfile(user, id));
        Assert.IsType<NotFoundObjectResult>(controller.DeleteDiscoveryFilterProfile(user, id));
        Assert.Equal(DiscoveryFilterProfiles.MaxProfiles - 1, Body(controller.GetDiscoveryFilterProfiles(user))["profiles"]!.AsArray().Count);
    }
}
