using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json;

namespace JE.Tests;

/// <summary>
/// The Media Tags admin page: its registration and files, the cache summary
/// it reads, and What's New still tracking the settings it took over from
/// the main configuration page.
/// </summary>
[Collection("Plugin singleton")]
public class ApiMediaTagsPageTests
{
    [Fact]
    public async Task PageIsRegisteredOutsideTheMenuAndServesItsModules()
    {
        using var f = new ApiPluginFixture();
        var page = Assert.Single(f.Plugin.GetPages(), p => p.Name == "JellyfinEnhancedMediaTags");
        Assert.False(page.EnableInMainMenu);
        using (var stream = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly.GetManifestResourceStream(page.EmbeddedResourcePath))
        {
            Assert.NotNull(stream);
            var html = await new StreamReader(stream!).ReadToEndAsync();
            Assert.Contains("id=\"JellyfinEnhancedMediaTagsPage\"", html);
            Assert.Contains("/JellyfinEnhanced/js/enhanced/admintags/admin-tags.js", html);
        }

        var controller = ApiAssetTests.Controller(f.Core);
        foreach (var (path, type) in new[] { ("enhanced/admintags/admin-tags.js", "application/javascript"), ("enhanced/admintags/admin-tags.css", "text/css"), ("enhanced/admintags/sections/layout.js", "application/javascript") })
        {
            var result = Assert.IsType<FileStreamResult>(controller.GetScript(path));
            Assert.Equal(type, result.ContentType);
        }
    }

    [Fact]
    public void CacheSummaryIsAdminOnlyAndReportsTheCache()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        var controller = ApiAssetTests.Controller(f.Core, cache);
        void SignIn(bool admin) => controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid(), admin) } };

        SignIn(admin: false);
        Assert.IsType<ForbidResult>(controller.GetTagCacheSummary());

        SignIn(admin: true);
        var body = JsonConvert.SerializeObject(Assert.IsType<OkObjectResult>(controller.GetTagCacheSummary()).Value);
        Assert.Equal("{\"enabled\":true,\"entries\":0,\"lastModified\":0,\"rebuilding\":false}", body);

        f.Plugin.Configuration.TagCacheServerMode = false;
        body = JsonConvert.SerializeObject(Assert.IsType<OkObjectResult>(controller.GetTagCacheSummary()).Value);
        Assert.Equal("{\"enabled\":false,\"entries\":0,\"lastModified\":0,\"rebuilding\":false}", body);
    }

    [Fact]
    public void WhatsNewTracksTheSettingsOnTheMediaTagsPage()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.CheckForNewSettings();
        var path = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var ids = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!.SettingIds;
        // Moved off configPage.html, declared by the page's section modules under their old ids.
        foreach (var id in new[] { "qualityTagsEnabled", "showResolutionTag", "tagLayout", "statusTagsJustAddedDays", "tagStylesEnabled", "tagCacheServerMode", "nativePosterTagsWebClientNames", "tagLookRulesJson" })
        {
            Assert.Contains(id, ids);
        }

        // Still on the main page.
        Assert.Contains("devMode", ids);
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }
}
