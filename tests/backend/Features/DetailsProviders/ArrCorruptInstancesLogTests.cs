using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Features.DetailsProviders;

/// <summary>
/// A damaged Sonarr or Radarr instance list is reported in the log by its length and where it stops
/// parsing, never by its text: the stored list carries each instance's URL and API key.
/// </summary>
[Collection("Plugin singleton")]
public class ArrCorruptInstancesLogTests
{
    [Fact]
    public async Task TheLogLineNamesTheDamageWithoutTheStoredText()
    {
        using var plugin = new ApiPluginFixture();
        var key = Guid.NewGuid().ToString("N");
        var host = "arr-" + Guid.NewGuid().ToString("N")[..8] + ".invalid";
        // A settings file cut off mid-way, as a restore of a truncated file leaves it.
        var sonarr = $"[{{\"Name\":\"Main\",\"Url\":\"http://sonarr-{host}:8989\",\"ApiKey\":\"{key}\",\"Enabled\":true}},{{\"Name\":\"4K\",\"Url\":\"http://so";
        var radarr = $"[{{\"Name\":\"Main\",\"Url\":\"http://radarr-{host}:7878\",\"ApiKey\":\"{key}\"";
        plugin.Plugin.Configuration.SonarrInstances = sonarr;
        plugin.Plugin.Configuration.RadarrInstances = radarr;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("[]")));
        var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), plugin.Core, transport);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, "Administrator")], "test"));

        Assert.IsAssignableFrom<IActionResult>(await controller.GetArrLinks("603", "81189"));

        var log = File.ReadAllText(plugin.Core.Logger.CurrentLogFilePath);
        Assert.Contains("SonarrInstances config is corrupt JSON", log);
        Assert.Contains("RadarrInstances config is corrupt JSON", log);
        Assert.DoesNotContain(key, log);
        Assert.DoesNotContain(host, log);
        Assert.DoesNotContain("\"Name\"", log);
        // What the administrator needs instead: how long the value is and where it breaks.
        Assert.Contains($"{sonarr.Length} characters", log);
        Assert.Contains($"{radarr.Length} characters", log);
    }
}
