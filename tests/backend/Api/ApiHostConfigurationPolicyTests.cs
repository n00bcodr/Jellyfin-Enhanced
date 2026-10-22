using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 12 control: Jellyfin's whole-configuration route keeps the accepted policy (Q-REBUILD1FIX10-1): a
/// signed-in page is refused (it migrates to the PATCH), an API key (a script) still replaces the configuration.
/// </summary>
[Collection("Plugin singleton")]
public class ApiHostConfigurationPolicyTests
{
    private static ClaimsPrincipal Person(Guid id, string device, bool apiKey = false) => new(new ClaimsIdentity(new[] {
        new Claim("Jellyfin-UserId", id.ToString()), new Claim("Jellyfin-DeviceId", device),
        new Claim("Jellyfin-IsApiKey", apiKey ? "true" : "false")
    }, "test"));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentWholeConfigurationUsesTheAcceptedSessionAndApiKeyPolicy(bool apiKey)
    {
        using var fixture = new ApiPluginFixture();
        var incoming = ConfigurationPatcher.Clone(fixture.Plugin.Configuration);
        incoming.ToastDuration = 2345;
        var http = new DefaultHttpContext();
        http.Request.Method = "POST";
        http.User = Person(Guid.NewGuid(), "maintenance-script-" + Guid.NewGuid(), apiKey);
        var descriptor = new ControllerActionDescriptor { ControllerName = "Plugins", ActionName = "UpdatePluginConfiguration" };
        var action = new ActionContext(http, new RouteData(), descriptor);
        var filters = new List<IFilterMetadata>();
        var executing = new ActionExecutingContext(action, filters, new Dictionary<string, object?> {
            ["pluginId"] = Guid.Parse("f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b"), ["configuration"] = incoming
        }, new object());
        var reached = false;
        await new HostConfigurationRouteFilter(null).OnActionExecutionAsync(executing, () => {
            reached = true;
            fixture.Plugin.UpdateConfiguration(incoming);
            return Task.FromResult(new ActionExecutedContext(action, filters, new object()) { Result = new NoContentResult() });
        });
        Assert.Equal(apiKey, reached);
        if (apiKey) Assert.Equal(2345, fixture.Plugin.Configuration.ToastDuration);
        else Assert.Equal(409, Assert.IsType<ObjectResult>(executing.Result).StatusCode);
    }
}
