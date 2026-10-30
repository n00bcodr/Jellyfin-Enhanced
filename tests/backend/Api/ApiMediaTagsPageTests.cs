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

    /// <summary>A full save as the main configuration page posts it: the whole configuration it read, with its edits.</summary>
    private static Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration MainPageSave(ApiPluginFixture f, Action<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration> edit)
    {
        var read = StjSerializer.Deserialize<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration>(StjSerializer.Serialize(f.Plugin.Configuration))!;
        edit(read);
        return read;
    }

    /// <summary>Waits until <paramref name="thread"/> is blocked (on the configuration write lock).</summary>
    private static void WaitUntilBlocked(Thread thread)
        => Assert.True(SpinWait.SpinUntil(() => thread.ThreadState.HasFlag(ThreadState.WaitSleepJoin), 5000), "the patch is waiting for the lock");

    [Fact]
    public void AMainPageSaveCommittedWhileThePatchWaitsIsNotPutBackByThePatch()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        IActionResult? result = null;
        var patch = new Thread(() => result = controller.PatchConfiguration(Patch(new { TagsHideOnHover = true }, new { TagsHideOnHover = false })));
        // Another save holds the configuration write lock: the patch arrives and waits for it.
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock)
        {
            patch.Start();
            WaitUntilBlocked(patch);
            // The main configuration page's full save commits meanwhile (Monitor is reentrant on this thread).
            f.Plugin.UpdateConfiguration(MainPageSave(f, c => c.DisableTagsOnSearchPage = true));
            Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage);
        }

        Assert.True(patch.Join(5000));
        Assert.Equal("{\"values\":{\"TagsHideOnHover\":true}}", StjSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value));
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage, "the patch keeps the field the main page saved while it waited");
    }

    [Fact]
    public void APatchArrivingDuringAMainPageSaveWaitsAndBuildsOnIt()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        IActionResult? result = null;
        var patch = new Thread(() => result = controller.PatchConfiguration(Patch(new { TagsHideOnHover = true }, new { TagsHideOnHover = false })));
        // The reverse order: the main page's save is in its critical section first.
        f.Plugin.UpdateConfiguration(
            current =>
            {
                patch.Start();
                WaitUntilBlocked(patch);
                Assert.False(f.Plugin.Configuration.TagsHideOnHover, "the patch does not write inside another save");
                return MainPageSave(f, c => c.DisableTagsOnSearchPage = true);
            });
        Assert.True(patch.Join(5000));
        Assert.IsType<OkObjectResult>(result);
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage, "the patch is applied on top of the save that went first");
    }

    [Fact]
    public void SectionModulesNameTheTabAndGroupOfEachSetting()
    {
        // A synthetic module with a setting that is new in this build.
        const string module = """
            const SHARED_FIELDS = [
                { id: 'awardsTagsOscar', key: 'AwardsTagsOscar', type: 'switch', place: 'section', label: 'z' },
            ];
            A.registerSection({
                id: 'badges-awards',
                tab: 'badges',
                fields: SHARED_FIELDS,
            });
            A.registerSection({
                id: 'group-awards',
                tab: 'groups',
                order: 80,
                group: {
                    id: 'awards',
                    summary(ctx) { return ''; },
                },
                fields: [
                    { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'x' },
                ],
            });
            A.registerSection({
                id: 'layout-extra',
                tab: 'layout',
                fields: [
                    { id: 'tagScale', key: 'TagScale', type: 'select', label: 'y' },
                ],
            });
            """;
        var parsed = WhatsNewService.ParseSectionModule(module).ToList();
        Assert.Equal(new MediaTagsLocation("groups", "awards"), Assert.Single(parsed, p => p.Key == "awardsTagsEnabled").Value);
        Assert.Equal(new MediaTagsLocation("layout", null), Assert.Single(parsed, p => p.Key == "tagScale").Value);
        Assert.Equal(new MediaTagsLocation("badges", null), Assert.Single(parsed, p => p.Key == "awardsTagsOscar").Value);
        Assert.Equal(3, parsed.Count);
    }

    [Fact]
    public void WhatsNewRoutesNewMediaTagsSettingsToTheirTabWithoutReannouncingTheBaseline()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, service);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid(), true) } };
        // An acknowledged baseline announces nothing again.
        service.Dismiss();
        service.CheckForNewSettings();
        Assert.Null(service.GetState());
        // Three Media Tags settings new since that baseline, and one main-page setting.
        var path = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var baseline = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!;
        var fresh = new[] { "tagLayout", "statusTagsJustAddedDays", "ratingTagsOnNextUp", "devMode" };
        baseline.SettingIds.RemoveAll(fresh.Contains);
        File.WriteAllText(path, JsonConvert.SerializeObject(baseline));
        service.CheckForNewSettings();
        Assert.Equal(fresh.OrderBy(x => x), service.GetState()!.NewSettings.Keys.OrderBy(x => x));
        var body = System.Text.Json.JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(controller.GetWhatsNew()).Value);
        using var json = System.Text.Json.JsonDocument.Parse(body);
        var mediaTags = json.RootElement.GetProperty("mediaTags");
        Assert.Equal("{\"page\":\"JellyfinEnhancedMediaTags\",\"tab\":\"layout\",\"group\":null}", mediaTags.GetProperty("tagLayout").GetRawText());
        Assert.Equal("badges", mediaTags.GetProperty("statusTagsJustAddedDays").GetProperty("tab").GetString());
        Assert.Equal("rating", mediaTags.GetProperty("ratingTagsOnNextUp").GetProperty("group").GetString());
        Assert.False(mediaTags.TryGetProperty("devMode", out _), "main-page settings keep their badges there");
    }

    [Fact]
    public void UpgradingFromTheSeedBaselineLeavesNoPendingSettingWithoutAPlaceToShowIt()
    {
        using var f = new ApiPluginFixture();
        // An existing install (other plugin data on disk) with no snapshot yet falls back to the release seed.
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "reviews.json"), "{}");
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.CheckForNewSettings();
        var pending = service.GetState()!.NewSettings.Keys.ToList();
        var locations = service.GetMediaTagsLocations();
        Assert.Contains("tagLayout", pending);
        Assert.Equal(new MediaTagsLocation("badges", null), locations["statusTagsJustAdded"]);
        Assert.Equal(new MediaTagsLocation("groups", "quality"), locations["showResolutionTag"]);
        using var stream = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html")!;
        var html = new StreamReader(stream).ReadToEnd();
        foreach (var id in pending)
        {
            Assert.True(html.Contains($"id=\"{id}\"", StringComparison.Ordinal) || locations.ContainsKey(id), $"{id} has a control on the main page or a Media Tags location");
        }
    }
}
