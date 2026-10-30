using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json;
using JsonElement = System.Text.Json.JsonElement;
using StjSerializer = System.Text.Json.JsonSerializer;

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

    /// <summary>The admin page's field patch: per-field writes on top of the live configuration.</summary>
    private static (JellyfinEnhancedController Controller, Action<bool> SignIn) PatchController(ApiPluginFixture f)
    {
        var controller = ApiAssetTests.Controller(f.Core);
        void SignIn(bool admin) => controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid(), admin) } };
        SignIn(true);
        return (controller, SignIn);
    }

    private static JellyfinEnhancedController.ConfigurationPatchRequest Patch(object changes, object? expected = null) => new()
    {
        Changes = StjSerializer.Deserialize<Dictionary<string, JsonElement>>(StjSerializer.Serialize(changes)),
        Expected = expected == null ? null : StjSerializer.Deserialize<Dictionary<string, JsonElement>>(StjSerializer.Serialize(expected)),
    };

    [Fact]
    public void TwoAdministratorsEditingDifferentFieldsBothPersist()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        f.Plugin.Configuration.DevMode = true;
        // Both pages read the configuration before either saved.
        var a = controller.PatchConfiguration(Patch(new { TagsHideOnHover = true }, new { TagsHideOnHover = false }));
        var b = controller.PatchConfiguration(Patch(new { DisableTagsOnSearchPage = true }, new { DisableTagsOnSearchPage = false }));
        Assert.IsType<OkObjectResult>(a);
        Assert.IsType<OkObjectResult>(b);
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage);
        Assert.True(f.Plugin.Configuration.DevMode, "fields nobody patched keep the server value");
    }

    [Fact]
    public void TwoAdministratorsEditingTheSameFieldGetAConflictAndNothingIsOverwritten()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        f.Plugin.Configuration.StatusTagsJustAddedDays = 7;
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 8 }, new { StatusTagsJustAddedDays = 7 })));
        // B read 7 too and saves 9 together with an unrelated field: refused as a whole.
        var refused = Assert.IsType<ConflictObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 9, TagsHideOnHover = true }, new { StatusTagsJustAddedDays = 7, TagsHideOnHover = false })));
        Assert.Equal("{\"conflicts\":{\"StatusTagsJustAddedDays\":8}}", StjSerializer.Serialize(refused.Value));
        Assert.Equal(8, f.Plugin.Configuration.StatusTagsJustAddedDays);
        Assert.False(f.Plugin.Configuration.TagsHideOnHover, "a refused patch writes nothing");
        // Keep mine: the same edit against the value now on the server.
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 9 }, new { StatusTagsJustAddedDays = 8 })));
        Assert.Equal(9, f.Plugin.Configuration.StatusTagsJustAddedDays);
        // Both choosing the same value is not a conflict.
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 9 }, new { StatusTagsJustAddedDays = 3 })));
    }

    [Fact]
    public void PatchKeepsObjectFieldsComparesThemByValueAndReturnsTheStoredValues()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        var order = new List<string> { "quality", "genre" };
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { TagGroupOrder = order }, new { TagGroupOrder = (object?)null })));
        Assert.Equal(order, f.Plugin.Configuration.TagGroupOrder);
        // An equal list read back from the API is not a conflict; the server clamps the day window.
        var ok = Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { TagGroupOrder = new[] { "genre" }, StatusTagsNewReleaseDays = 500 }, new { TagGroupOrder = new[] { "quality", "genre" } })));
        Assert.Equal("{\"values\":{\"TagGroupOrder\":[\"genre\"],\"StatusTagsNewReleaseDays\":365}}", StjSerializer.Serialize(ok.Value));
        Assert.Equal(365, f.Plugin.Configuration.StatusTagsNewReleaseDays);
    }

    [Fact]
    public void PatchIsAdminOnlyAndRefusesUnknownFieldsAndBadValues()
    {
        using var f = new ApiPluginFixture();
        var (controller, signIn) = PatchController(f);
        signIn(false);
        Assert.IsType<ForbidResult>(controller.PatchConfiguration(Patch(new { TagsHideOnHover = true })));
        Assert.False(f.Plugin.Configuration.TagsHideOnHover);
        signIn(true);
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(Patch(new { NoSuchField = 1 })));
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(Patch(new { TagsHideOnHover = "maybe" })));
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest()));
        Assert.False(f.Plugin.Configuration.TagsHideOnHover);
    }
}
