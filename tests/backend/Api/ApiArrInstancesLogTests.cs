using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// A damaged Sonarr or Radarr instance list is reported in the plugin log by its length and where it
/// stops parsing, never by its text: the stored list carries each instance's URL and API key, and
/// administrators paste that log into support threads.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrInstancesLogTests
{
    [Fact]
    public void ACorruptInstanceListIsLoggedWithoutItsUrlOrApiKey()
    {
        using var f = new ApiPluginFixture();
        var key = Guid.NewGuid().ToString("N");
        var host = "arr-" + Guid.NewGuid().ToString("N")[..8] + ".invalid";
        // Settings files cut off part way, as a restore of a truncated file leaves them.
        var sonarr = $"[{{\"Name\":\"Main\",\"Url\":\"http://sonarr-{host}:8989\",\"ApiKey\":\"{key}\",\"Enabled\":true}},{{\"Name\":\"4K\",\"Url\":\"http://so";
        var radarr = $"[{{\"Name\":\"Main\",\"Url\":\"http://radarr-{host}:7878\",\"ApiKey\":\"{key}\"";
        f.Plugin.Configuration.SonarrInstances = sonarr;
        f.Plugin.Configuration.RadarrInstances = radarr;
        var controller = ApiAssetTests.Controller(f.Core);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "Administrator")], "test"));

        // The admin settings payload checks the lists and logs damage once per stored value.
        Assert.IsType<JsonResult>(controller.GetPrivateConfig());
        Assert.IsType<JsonResult>(controller.GetPrivateConfig());

        var log = File.ReadAllText(f.Core.Logger.CurrentLogFilePath);
        Assert.Single(log.Split('\n'), line => line.Contains("SonarrInstances config is corrupt JSON"));
        Assert.Single(log.Split('\n'), line => line.Contains("RadarrInstances config is corrupt JSON"));
        Assert.DoesNotContain(key, log);
        Assert.DoesNotContain(host, log);
        Assert.DoesNotContain("\"ApiKey\"", log);
        // What the administrator needs instead: how long the value is and where it breaks.
        Assert.Contains($"Stored value: {sonarr.Length} characters", log);
        Assert.Contains($"Stored value: {radarr.Length} characters", log);
    }
}
