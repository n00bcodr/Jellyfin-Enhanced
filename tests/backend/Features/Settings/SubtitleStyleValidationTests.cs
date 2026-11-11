using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Features.Settings;

/// <summary>
/// The custom subtitle colours go into CSS text in the browser. Both user settings saves keep a colour the browser
/// would use and save a malformed one as the default the browser shows for it instead; a document stored before
/// this check still loads as it is, and the next save goes through.
/// </summary>
[Collection("Plugin singleton")]
public class SubtitleStyleValidationTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";

    private static JeSettingsController Controller(ApiPluginFixture f)
    {
        var maintenance = new MaintenanceModeService(Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>(), Moq.Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = (JeSettingsController)ApiAssetTests.Controller(typeof(JeSettingsController), f.Core, maintenance, f.Core.Manager);
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(Guid.ParseExact(User, "N"), false);
        return controller;
    }

    private static (string? Text, string? Background) Stored(ApiPluginFixture f)
    {
        using var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(f.Core.ConfigRoot, User, "settings.json")));
        return (saved.RootElement.GetProperty("CustomSubtitleTextColor").GetString(), saved.RootElement.GetProperty("CustomSubtitleBgColor").GetString());
    }

    [Theory]
    // What the settings panel saves (its presets and colour pickers) and other colours the browser accepts.
    [InlineData("#FFFF00FF", "transparent", "#FFFF00FF", "transparent")]
    [InlineData("#fff", "#000000B2", "#fff", "#000000B2")]
    [InlineData("rgba(255, 255, 0, 0.5)", "hsl(0 0% 0% / 50%)", "rgba(255, 255, 0, 0.5)", "hsl(0 0% 0% / 50%)")]
    // Anything that could end the declaration or the rule, load a URL or is no colour at all: the browser's defaults.
    [InlineData("#fff;}body{display:none}", "red;background:url(//example.invalid/x.png)", "#FFFFFFFF", "#00000000")]
    [InlineData("expression(alert(1))", "\"><script>", "#FFFFFFFF", "#00000000")]
    [InlineData("#12345", "", "#FFFFFFFF", "#00000000")]
    [InlineData(null, "#000\n;}", "#FFFFFFFF", "#00000000")]
    public void TheSettingsSaveKeepsColoursTheBrowserUsesAndStoresItsDefaultsForMalformedOnes(string? text, string? background, string storedText, string storedBackground)
    {
        using var f = new ApiPluginFixture();
        var controller = Controller(f);
        var document = new JellyfinEnhancedUserSettings { CustomSubtitleTextColor = text!, CustomSubtitleBgColor = background!, UsingCustomColors = true };
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(User, document));
        Assert.Equal((storedText, storedBackground), Stored(f));
    }

    [Fact]
    public void AMalformedColourStoredBeforeTheCheckStillLoadsAndTheNextSaveGoesThrough()
    {
        using var f = new ApiPluginFixture();
        f.Core.Write(User, """{"CustomSubtitleTextColor":"#fff;}body{display:none}","CustomSubtitleBgColor":"#00000080","UsingCustomColors":true,"AutoPauseEnabled":false}""");
        var controller = Controller(f);
        var loaded = Assert.IsType<RevisionedSettingsResponse>(Assert.IsType<JsonResult>(controller.GetRevisionedSettings(User)).Value);
        Assert.Equal("#fff;}body{display:none}", loaded.Settings.CustomSubtitleTextColor);
        loaded.Settings.AutoPauseEnabled = true;
        Assert.IsType<JsonResult>(controller.SaveRevisionedSettings(User, new RevisionedSettingsRequest { Revision = loaded.Revision, Settings = loaded.Settings }));
        Assert.Equal(("#FFFFFFFF", "#00000080"), Stored(f));
        using var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(f.Core.ConfigRoot, User, "settings.json")));
        Assert.True(saved.RootElement.GetProperty("AutoPauseEnabled").GetBoolean());
        Assert.True(saved.RootElement.GetProperty("UsingCustomColors").GetBoolean());
    }
}
