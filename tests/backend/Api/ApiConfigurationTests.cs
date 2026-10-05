using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiConfigurationTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PublicConfigRedactsTopologyPreLoginAndNeverIncludesApiKeys(bool authenticated, bool admin)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.TMDB_API_KEY = "SECRET_TMDB_SENTINEL";
        config.MdblistApiKey = "SECRET_MDBLIST_SENTINEL";
        config.JellyseerrApiKey = "SECRET_SEERR_SENTINEL";
        config.SonarrApiKey = "SECRET_SONARR_SENTINEL";
        config.RadarrApiKey = "SECRET_RADARR_SENTINEL";
        config.JellyseerrUrls = "http://private-seerr.invalid:5055";
        config.JellyseerrUrlMappings = "private-mapping-sentinel";
        config.SonarrUrl = "http://private-sonarr.invalid:8989";
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(authenticated
            ? new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test")
            : new ClaimsIdentity());
        var result = Assert.IsType<JsonResult>(controller.GetPublicConfig());
        var json = JsonSerializer.Serialize(result.Value);
        Assert.DoesNotContain("SECRET_", json);
        Assert.DoesNotContain("private-sonarr", json);
        using var document = JsonDocument.Parse(json);
        Assert.True(document.RootElement.GetProperty("TmdbEnabled").GetBoolean());
        Assert.True(document.RootElement.GetProperty("MdblistEnabled").GetBoolean());
        Assert.Equal(authenticated, json.Contains("private-seerr", StringComparison.Ordinal));
        Assert.Equal(authenticated, json.Contains("private-mapping-sentinel", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PrivateConfigContainsTopologyOnlyForAdminAndNeverApiKeys(bool admin)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.SonarrUrl = "http://private-sonarr.invalid:8989";
        fixture.Plugin.Configuration.SonarrApiKey = "SECRET_SONARR_SENTINEL";
        fixture.Plugin.Configuration.RadarrApiKey = "SECRET_RADARR_SENTINEL";
        fixture.Plugin.Configuration.TMDB_API_KEY = "SECRET_TMDB_SENTINEL";
        var controller = ApiAssetTests.Controller(fixture.Core, Mock.Of<IUserManager>());
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        var json = JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPrivateConfig()).Value);
        Assert.DoesNotContain("SECRET_", json);
        if (admin) Assert.Contains("private-sonarr", json);
        else Assert.Equal("{}", json);
    }

    [Fact]
    public void DevelopmentModeDisablesCachingForIndividualScriptsAndBundle()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.DevMode = true;
        var controller = ApiAssetTests.Controller(fixture.Core);
        using var stream = Assert.IsType<FileStreamResult>(controller.GetMainScript()).FileStream;
        Assert.Equal("no-store", controller.Response.Headers.CacheControl);
        Assert.IsType<FileContentResult>(controller.GetScriptBundle());
        Assert.Equal("no-store", controller.Response.Headers.CacheControl);
        Assert.Contains("dev=\"true\"", fixture.Plugin.BuildScriptTag());
    }
    [Fact]
    public async Task RegisteredPagesAndViewsArePackagedAndViewsHaveHtmlMime()
    {
        using var fixture = new ApiPluginFixture();
        var controller = ApiAssetTests.Controller(fixture.Core);
        var pages = fixture.Plugin.GetPages().Concat(fixture.Plugin.GetViews()).ToArray();
        Assert.NotEmpty(pages);
        Assert.Equal(pages.Length, pages.Select(p => p.Name).Distinct().Count());
        foreach (var page in pages)
        {
            using var embedded = fixture.Plugin.GetType().Assembly.GetManifestResourceStream(page.EmbeddedResourcePath);
            Assert.NotNull(embedded);
            using var reader = new StreamReader(embedded!);
            Assert.NotEmpty(await reader.ReadToEndAsync());
        }
        foreach (var view in fixture.Plugin.GetViews())
        {
            var result = Assert.IsType<FileStreamResult>(controller.GetView(view.Name));
            using var stream = result.FileStream;
            Assert.Equal("text/html", result.ContentType);
            Assert.True(stream.Length > 0);
        }
        Assert.IsType<NotFoundObjectResult>(controller.GetView("unknown-view"));
    }

}
