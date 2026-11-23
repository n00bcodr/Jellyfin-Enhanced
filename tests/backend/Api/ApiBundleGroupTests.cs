using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

// The component bundle route and the bootstrap's group list, through the controller.
[Collection("Plugin singleton")]
public class ApiBundleGroupTests
{
    [Fact]
    public void BundleRouteServesGroupsAndRejectsUnknownOnes()
    {
        using var fixture = new ApiPluginFixture();
        var controller = ApiAssetTests.Controller(fixture.Core);
        var script = Assert.IsType<FileContentResult>(controller.GetScriptBundle("core"));
        Assert.Equal("application/javascript", script.ContentType);
        Assert.Contains("window.__JE_BUNDLES", Encoding.UTF8.GetString(script.FileContents));
        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl);
        Assert.Equal("application/json", Assert.IsType<FileContentResult>(controller.GetScriptBundleMap("core")).ContentType);
        Assert.IsType<NotFoundResult>(controller.GetScriptBundle("not-a-group"));
        Assert.IsType<NotFoundResult>(controller.GetScriptBundle("core,core"));
        Assert.IsType<NotFoundResult>(controller.GetScriptBundleMap(""));
        // Without the parameter the route still serves the whole manifest in the single-array format.
        Assert.Contains("window.__JE_BUNDLE_MODULES", Encoding.UTF8.GetString(Assert.IsType<FileContentResult>(controller.GetScriptBundle()).FileContents));
    }

    [Fact]
    public void BootstrapCarriesTheGroupsFileAsWritten()
    {
        using var fixture = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance, fixture.Core.Manager, Mock.Of<ILibraryManager>());
        controller.ControllerContext.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        var body = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetBootstrap()).Value)).RootElement;
        var listed = body.GetProperty("ComponentGroups").EnumerateArray().ToArray();
        var resolved = ClientScriptBundle.GetComponentGroups();
        // "core" is implicit: the payload lists every other group, in order, with its own modules.
        Assert.Equal(resolved.Skip(1).Select(g => g.Id), listed.Select(g => g.GetProperty("id").GetString()));
        for (var i = 0; i < listed.Length; i++)
        {
            Assert.Equal(resolved[i + 1].Scripts.OrderBy(p => p, StringComparer.Ordinal),
                listed[i].GetProperty("modules").EnumerateArray().Select(m => m.GetString()!).OrderBy(p => p, StringComparer.Ordinal));
        }
        Assert.Equal(ClientScriptBundle.GetComponentScripts(), body.GetProperty("ComponentScripts").EnumerateArray().Select(s => s.GetString()!));
    }
}
