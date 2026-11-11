using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Platform;

/// <summary>
/// The splash screen's stored default image, /web/assets/img/banner-light.png, is where older web clients kept the
/// banner. Jellyfin 12's web client ships it only under a content-hashed name at its root, so the public settings
/// hand the splash the file the web client really has.
/// </summary>
[Collection("Plugin singleton")]
public class SplashImageTests
{
    private static string SplashUrl(ApiPluginFixture fixture)
    {
        var controller = ApiAssetTests.Controller(fixture.Core, fixture.Core.Manager,
            new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger));
        var body = JsonSerializer.SerializeToElement(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value);
        return body.GetProperty("SplashScreenImageUrl").GetString()!;
    }

    [Fact]
    public void TheStoredDefaultPointsAtTheBannerTheWebClientShips()
    {
        using var fixture = new ApiPluginFixture();
        var web = Path.Combine(fixture.Core.Root, "web");
        Directory.CreateDirectory(web);
        File.WriteAllBytes(Path.Combine(web, "banner-light.b113d4d1c6c07fcb73f0.png"), [1]);
        File.WriteAllBytes(Path.Combine(web, "banner-dark.31011bc0c5e6acb07879.png"), [1]);
        Assert.Equal("/web/assets/img/banner-light.png", fixture.Plugin.Configuration.SplashScreenImageUrl);
        Assert.Equal("/web/banner-light.b113d4d1c6c07fcb73f0.png", SplashUrl(fixture));

        // An administrator's own image is never replaced.
        fixture.Plugin.Configuration.SplashScreenImageUrl = "https://example.invalid/splash.png";
        Assert.Equal("https://example.invalid/splash.png", SplashUrl(fixture));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AWebClientWithTheOldPathOrWithoutABannerKeepsTheStoredDefault(bool oldPath)
    {
        using var fixture = new ApiPluginFixture();
        var web = Path.Combine(fixture.Core.Root, "web");
        Directory.CreateDirectory(Path.Combine(web, "assets", "img"));
        if (oldPath)
        {
            File.WriteAllBytes(Path.Combine(web, "assets", "img", "banner-light.png"), [1]);
            File.WriteAllBytes(Path.Combine(web, "banner-light.b113d4d1c6c07fcb73f0.png"), [1]);
        }

        Assert.Equal("/web/assets/img/banner-light.png", SplashUrl(fixture));
    }
}
