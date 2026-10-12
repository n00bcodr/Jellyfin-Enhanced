using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json.Linq;
using StjSerializer = System.Text.Json.JsonSerializer;

namespace JE.Tests;

/// <summary>
/// The focus check's change markers (design item C5, section 6.3): GET user-settings/{userId}/revision
/// answers <c>{ "Settings": file revision, "Config": ConfigEpoch }</c>, the same values as Meta, without
/// seeding or resolving anything, under the same access rule as the other per-user routes.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsRevisionTests
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid UserB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    private sealed class Endpoints : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public string SettingsPath(Guid user) => Path.Combine(Plugin.Core.ConfigRoot, user.ToString("N"), "settings.json");

        public JellyfinEnhancedController Controller(Guid user, bool admin = false)
        {
            var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Plugin.Core.Manager, Mock.Of<IUserManager>(), maintenance);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public IActionResult Revision(Guid? caller = null, Guid? target = null, bool admin = false)
            => Controller(caller ?? UserA, admin).GetUserSettingsRevision((target ?? UserA).ToString());

        public JObject Meta(Guid? user = null)
            => (JObject)Body(Controller(user ?? UserA).GetUserSettingsSettings((user ?? UserA).ToString(), meta: true))["Meta"]!;

        public void Write(UserSettings settings, Guid? user = null) => Plugin.Core.Manager.SaveUserConfiguration((user ?? UserA).ToString("N"), "settings.json", settings);

        public void Dispose() => Plugin.Dispose();
    }

    private static JObject Body(IActionResult result) => JObject.Parse(StjSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(result).Value));

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult objectResult => objectResult.StatusCode ?? 200,
        StatusCodeResult code => code.StatusCode,
        ForbidResult => 403,
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    private static System.Text.Json.JsonElement Json(string json)
    {
        using var document = System.Text.Json.JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    [Fact]
    public void TheAnswerIsTheMetaRevisionAndConfigEpochInAboutAHundredBytes()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings { AutoPipEnabled = true });

        var result = endpoints.Revision();
        Assert.IsType<OkObjectResult>(result);
        var body = Body(result);
        Assert.Equal(new[] { "Settings", "Config" }, body.Properties().Select(p => p.Name).ToArray());
        var meta = endpoints.Meta();
        Assert.Equal(meta.Value<string>("Revision"), body.Value<string>("Settings"));
        Assert.Equal(meta.Value<string>("ConfigEpoch"), body.Value<string>("Config"));
        Assert.Equal(endpoints.Plugin.Plugin.ConfigEpoch, body.Value<string>("Config"));
        Assert.Matches("^[0-9a-f]{12}$", body.Value<string>("Settings")!);
        Assert.True(StjSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value).Length <= 100);
    }

    [Fact]
    public void SettingsChangesWithTheFileAndConfigWithEveryAdminSave()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        var first = Body(endpoints.Revision());

        // The user's own save (another device) changes the file revision only.
        var patch = Body(endpoints.Controller(UserA).PatchUserSettingsSettings(UserA.ToString(), Json("{\"Set\":{\"QualityTagsEnabled\":true}}")));
        var afterSave = Body(endpoints.Revision());
        Assert.NotEqual(first.Value<string>("Settings"), afterSave.Value<string>("Settings"));
        Assert.Equal(patch.Value<string>("Revision"), afterSave.Value<string>("Settings"));
        Assert.Equal(first.Value<string>("Config"), afterSave.Value<string>("Config"));

        // Any admin save, including one that only changes a master switch, changes Config only.
        var config = endpoints.Plugin.Plugin.Configuration;
        config.ShowReviews = !config.ShowReviews;
        endpoints.Plugin.Plugin.UpdateConfiguration(config);
        var afterAdmin = Body(endpoints.Revision());
        Assert.Equal(afterSave.Value<string>("Settings"), afterAdmin.Value<string>("Settings"));
        Assert.NotEqual(afterSave.Value<string>("Config"), afterAdmin.Value<string>("Config"));

        // Reading changes nothing.
        Assert.Equal(afterAdmin, Body(endpoints.Revision()));
    }

    [Fact]
    public void AUserWithoutASettingsFileGetsAnEmptyRevisionAndNothingIsSeeded()
    {
        using var endpoints = new Endpoints();
        var body = Body(endpoints.Revision());
        Assert.Equal(string.Empty, body.Value<string>("Settings"));
        Assert.Equal(endpoints.Plugin.Plugin.ConfigEpoch, body.Value<string>("Config"));
        Assert.False(File.Exists(endpoints.SettingsPath(UserA)));
    }

    [Fact]
    public void OnlyTheOwnerOrAnAdminCanReadTheRevision()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        Assert.Equal(403, Status(endpoints.Revision(caller: UserB)));
        Assert.Equal(200, Status(endpoints.Revision(caller: UserB, admin: true)));
        Assert.Equal(Body(endpoints.Revision()), Body(endpoints.Revision(caller: UserB, admin: true)));
    }

    [Fact]
    public void TheBootstrapAdvertisesTheRoute()
    {
        using var endpoints = new Endpoints();
        var bootstrap = JObject.Parse(StjSerializer.Serialize(Assert.IsType<JsonResult>(endpoints.Controller(UserA).GetBootstrap()).Value));
        Assert.Equal(new[] { "settingsPatch", "settingsRevision" }, bootstrap["Capabilities"]!.Values<string>().ToArray());
    }

    [Fact]
    public void AnAdminSaveDuringABootstrapNeverPairsTheOldConfigWithTheNewEpoch()
    {
        // The client records the bootstrap's Meta ConfigEpoch as the epoch of the PublicConfig it
        // applied; were they from different saves, the focus check would never refetch the new config.
        using var endpoints = new Endpoints();
        var plugin = endpoints.Plugin.Plugin;
        var before = plugin.CurrentConfiguration;
        var oldToast = before.Configuration.ToastDuration;
        var saved = false;
        // UserA has no settings.json: the bootstrap seeds it, and the admin saves right then.
        void SaveDuringTheRequest(string userId, string fileName)
        {
            if (saved || fileName != "settings.json") return;
            saved = true;
            var options = Jellyfin.Extensions.Json.JsonDefaults.Options;
            var next = StjSerializer.Deserialize<PluginConfiguration>(StjSerializer.Serialize(before.Configuration, options), options)!;
            next.ToastDuration = oldToast + 1000;
            plugin.UpdateConfiguration(next);
        }

        endpoints.Plugin.Core.Manager.UserConfigurationSaved += SaveDuringTheRequest;
        JObject bootstrap;
        try
        {
            bootstrap = JObject.Parse(StjSerializer.Serialize(Assert.IsType<JsonResult>(endpoints.Controller(UserA).GetBootstrap()).Value));
        }
        finally
        {
            endpoints.Plugin.Core.Manager.UserConfigurationSaved -= SaveDuringTheRequest;
        }

        Assert.True(saved);
        Assert.NotEqual(before.Epoch, plugin.ConfigEpoch);
        Assert.Equal(oldToast + 1000, plugin.Configuration.ToastDuration);
        // One snapshot: the old config with the old epoch, so the next focus check sees a new epoch.
        Assert.Equal(oldToast, bootstrap["PublicConfig"]!.Value<int>("ToastDuration"));
        Assert.Equal(before.Epoch, bootstrap["UserSettings"]!["SettingsMeta"]!.Value<string>("ConfigEpoch"));
        Assert.Equal(plugin.ConfigEpoch, Body(endpoints.Revision()).Value<string>("Config"));
    }
}
