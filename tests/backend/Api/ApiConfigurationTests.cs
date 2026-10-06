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
    /// <summary>
    /// Fills every secret-like string setting (*ApiKey, *API_KEY, *Secret, *Token, *Password) and each
    /// Sonarr/Radarr instance key with a "SECRET_" sentinel. Neither config payload may contain any of
    /// them: the private (admin) payload is documented as topology only, with no API keys.
    /// </summary>
    private static IReadOnlyList<string> SeedSecrets(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration config)
    {
        var seeded = new List<string>();
        foreach (var property in config.GetType().GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            if (property.PropertyType != typeof(string) || !property.CanWrite
                || !System.Text.RegularExpressions.Regex.IsMatch(property.Name, "(ApiKey|API_KEY|Secret|Token|Password)$")) continue;
            property.SetValue(config, "SECRET_" + property.Name + "_SENTINEL");
            seeded.Add(property.Name);
        }
        config.SonarrInstances = "[{\"Name\":\"Main\",\"Url\":\"http://private-sonarr-instance.invalid\",\"ApiKey\":\"SECRET_SONARR_INSTANCE_SENTINEL\",\"Enabled\":true}]";
        config.RadarrInstances = "[{\"Name\":\"Main\",\"Url\":\"http://private-radarr-instance.invalid\",\"ApiKey\":\"SECRET_RADARR_INSTANCE_SENTINEL\",\"Enabled\":true}]";
        // The known keys must be among them, or the name filter has silently stopped matching.
        Assert.Superset(new HashSet<string> { "TMDB_API_KEY", "MdblistApiKey", "JellyseerrApiKey", "ShokoApiKey", "SonarrApiKey", "RadarrApiKey", "AnalyticsInstallSecret" }, seeded.ToHashSet());
        return seeded;
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PublicConfigRedactsTopologyPreLoginAndNeverIncludesApiKeys(bool authenticated, bool admin)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        SeedSecrets(config);
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
        SeedSecrets(fixture.Plugin.Configuration);
        var controller = ApiAssetTests.Controller(fixture.Core, Mock.Of<IUserManager>());
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        var json = JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPrivateConfig()).Value);
        Assert.DoesNotContain("SECRET_", json);
        if (admin)
        {
            Assert.Contains("private-sonarr", json);
            Assert.Contains("private-sonarr-instance", json);
            Assert.Contains("private-radarr-instance", json);
        }
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
