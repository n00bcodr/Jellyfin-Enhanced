using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace JE.Tests.Features.Settings;

[Collection("Plugin singleton")]
public class RevisionedSettingsTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";

    [Theory]
    [InlineData("1e400")]
    [InlineData("1e-400")]
    [InlineData("0.123456789012345678901234567890123456789")]
    public void SaveRetainsUnknownNumericLiterals(string literal)
    {
        using var f = new CoreFixture();
        f.Write(User, "{\"FutureNumber\":" + literal + "}");
        var service = new SettingsDocumentService(f.Manager);
        var loaded = service.Read(User, () => new(), false);
        loaded.Settings.AutoPauseEnabled = false;
        Assert.True(service.TrySave(User, new RevisionedSettingsRequest { Revision = loaded.Revision, Settings = loaded.Settings }, false, out _));
        using var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(f.ConfigRoot, User, "settings.json")));
        Assert.Equal(literal, json.RootElement.GetProperty("FutureNumber").GetRawText());
    }

    [Fact]
    public void AtomicSeedAndSavePreserveUnknownFieldsNullInheritanceAndCallerAdmin()
    {
        using var f = new CoreFixture();
        f.Write(User, "{\"future\":{\"nested\":[1,null,true]},\"UseNativePosterTags\":null,\"IsAdmin\":true}");
        var service = new SettingsDocumentService(f.Manager);
        var first = service.Read(User, () => throw new Exception("must not seed existing"), false);
        Assert.False(first.Settings.IsAdmin);
        Assert.Null(first.Settings.UseNativePosterTags);
        first.Settings.AutoPauseEnabled = false;
        Assert.True(service.TrySave(User, new RevisionedSettingsRequest { Revision = first.Revision, Settings = first.Settings }, false, out var saved));
        Assert.NotEqual(first.Revision, saved!.Revision);
        var raw = (JObject)f.Manager.ReadUserConfigurationDocument(User, "settings.json").Document!;
        Assert.Equal("{\"nested\":[1,null,true]}", raw["future"]!.ToString(Newtonsoft.Json.Formatting.None));
        Assert.Null(raw["IsAdmin"]);
        Assert.Equal(JTokenType.Null, raw["UseNativePosterTags"]!.Type);
        Assert.False(service.TrySave(User, new RevisionedSettingsRequest { Revision = first.Revision, Settings = first.Settings }, false, out _));
    }

    [Fact]
    public void OrdinaryWritesInvalidateLoadedRevisionAndCorruptDocumentsArePreserved()
    {
        using var f = new CoreFixture();
        var service = new SettingsDocumentService(f.Manager);
        var first = service.Read(User, () => new JellyfinEnhancedUserSettings(), false);
        f.Manager.SaveUserConfiguration(User, "settings.json", new JellyfinEnhancedUserSettings { AutoPauseEnabled = false });
        Assert.False(service.TrySave(User, new RevisionedSettingsRequest { Revision = first.Revision, Settings = first.Settings }, false, out _));
        f.Write(User, "[]");
        Assert.Throws<InvalidDataException>(() => service.Read(User, () => new(), false));
        Assert.Equal("[]", File.ReadAllText(Path.Combine(f.ConfigRoot, User, "settings.json")));
    }
    // The bytes JE 11.9.0.0 wrote after an upgrade from 11.8: its web client posted null for the six new quality
    // switches and their orders, and UserConfigurationManager.SaveUserConfiguration serialised the bound UserSettings
    // with Newtonsoft (indented, no BOM, no final newline). 11.10 made the switches bool.
    private const string SettingsWrittenBy119 = """
{
  "AutoPauseEnabled": false,
  "AutoResumeEnabled": true,
  "AutoPipEnabled": false,
  "LongPress2xEnabled": true,
  "PauseScreenEnabled": true,
  "PauseScreenDelaySeconds": 12,
  "AutoSkipIntro": true,
  "AutoSkipOutro": false,
  "DisableCustomSubtitleStyles": false,
  "SelectedStylePresetIndex": 4,
  "SelectedFontSizePresetIndex": 3,
  "SelectedFontFamilyPresetIndex": 1,
  "CustomSubtitleTextColor": "#FFFF00FF",
  "CustomSubtitleBgColor": "#00000000",
  "UsingCustomColors": true,
  "SubtitleVerticalPosition": 70,
  "SubtitleHorizontalPosition": 50,
  "RandomButtonEnabled": true,
  "RandomUnwatchedOnly": true,
  "RandomIncludeMovies": true,
  "RandomIncludeShows": false,
  "ShowWatchProgress": true,
  "WatchProgressMode": "time",
  "WatchProgressTimeFormat": "hours",
  "ShowFileSizes": false,
  "ShowAudioLanguages": true,
  "QualityTagsEnabled": true,
  "ShowResolutionTag": null,
  "ShowSourceTag": null,
  "ShowDynamicRangeTag": null,
  "ShowSpecialFormatTag": null,
  "ShowVideoCodecTag": null,
  "ShowAudioInfoTag": null,
  "ResolutionTagOrder": null,
  "SourceTagOrder": null,
  "DynamicRangeTagOrder": null,
  "SpecialFormatTagOrder": null,
  "VideoCodecTagOrder": null,
  "AudioInfoTagOrder": null,
  "GenreTagsEnabled": true,
  "LanguageTagsEnabled": false,
  "RatingTagsEnabled": true,
  "PeopleTagsEnabled": false,
  "TagsHideOnHover": false,
  "QualityTagsPosition": "top-right",
  "GenreTagsPosition": "top-right",
  "LanguageTagsPosition": "bottom-left",
  "RatingTagsPosition": "bottom-right",
  "ShowRatingInPlayer": false,
  "RemoveContinueWatchingEnabled": false,
  "LastOpenedTab": "settings",
  "ReviewsExpandedByDefault": true,
  "DisplayLanguage": "de",
  "CalendarDisplayMode": "list",
  "CalendarDefaultViewMode": "agenda"
}
""";

    [Fact]
    public void SettingsWrittenBy119WithNullQualitySwitchesLoadWithTheUsersValuesAndSave()
    {
        using var fixture = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var id = user.ToString("N");
        var path = fixture.Core.Write(id, SettingsWrittenBy119);
        var maintenance = new MaintenanceModeService(Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>(), Moq.Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = (JeSettingsController)ApiAssetTests.Controller(typeof(JeSettingsController), fixture.Core, maintenance, fixture.Core.Manager);
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);

        var read = controller.GetRevisionedSettings(id);
        Assert.Equal(SettingsWrittenBy119, File.ReadAllText(path));
        var loaded = Assert.IsType<RevisionedSettingsResponse>(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(read).Value);
        var s = loaded.Settings;
        Assert.Equal((4, 3, 1, 12, 70), (s.SelectedStylePresetIndex, s.SelectedFontSizePresetIndex, s.SelectedFontFamilyPresetIndex, s.PauseScreenDelaySeconds, s.SubtitleVerticalPosition));
        Assert.Equal(("#FFFF00FF", "time", "top-right", "settings", "de"), (s.CustomSubtitleTextColor, s.WatchProgressMode, s.QualityTagsPosition, s.LastOpenedTab, s.DisplayLanguage));
        Assert.True(s.AutoResumeEnabled && s.AutoSkipIntro && s.UsingCustomColors && s.LongPress2xEnabled && s.QualityTagsEnabled && s.GenreTagsEnabled && s.ReviewsExpandedByDefault);
        Assert.False(s.AutoPauseEnabled || s.ShowRatingInPlayer || s.RandomIncludeShows);
        // A stored null reads as the switch's default since 11.10 (shown), and a null order stays unset.
        Assert.True(s.ShowResolutionTag && s.ShowSourceTag && s.ShowDynamicRangeTag && s.ShowSpecialFormatTag && s.ShowVideoCodecTag && s.ShowAudioInfoTag);
        Assert.Null(s.ResolutionTagOrder);

        s.AutoSkipOutro = true;
        var saved = controller.SaveRevisionedSettings(id, new RevisionedSettingsRequest { Revision = loaded.Revision, Settings = s });
        var receipt = Assert.IsType<SettingsSaveReceipt>(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(saved).Value);
        var again = Assert.IsType<RevisionedSettingsResponse>(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.GetRevisionedSettings(id)).Value);
        Assert.Equal(receipt.Revision, again.Revision);
        Assert.True(again.Settings.AutoSkipOutro && again.Settings.AutoSkipIntro);
        Assert.Equal((4, 12, "de"), (again.Settings.SelectedStylePresetIndex, again.Settings.PauseScreenDelaySeconds, again.Settings.DisplayLanguage));
    }

    [Fact]
    public async Task GuardedRoutesEnforceUserScopeAndReturnConflictWithoutChangingBytes()
    {
        using var fixture = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var maintenance = new MaintenanceModeService(Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>(), Moq.Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = (JeSettingsController)ApiAssetTests.Controller(typeof(JeSettingsController), fixture.Core, maintenance, fixture.Core.Manager);
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);
        Assert.IsType<Microsoft.AspNetCore.Mvc.ForbidResult>(controller.GetRevisionedSettings(Guid.NewGuid().ToString("N")));
        var loaded = Assert.IsType<RevisionedSettingsResponse>(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.GetRevisionedSettings(user.ToString("N"))).Value);
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "client/entries/contracts.json"))) root = root.Parent;
        Assert.NotNull(root);
        var start = new System.Diagnostics.ProcessStartInfo("node") { WorkingDirectory = root.FullName, RedirectStandardInput = true, RedirectStandardError = true, UseShellExecute = false };
        start.ArgumentList.Add("tests/frontend/contracts/check-wire.mjs");
        start.ArgumentList.Add("settings");
        start.ArgumentList.Add("false");
        using var process = System.Diagnostics.Process.Start(start)!;
        var error = process.StandardError.ReadToEndAsync();
        var httpResult = Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.GetRevisionedSettings(user.ToString("N")));
        var serializer = Assert.IsType<System.Text.Json.JsonSerializerOptions>(httpResult.SerializerSettings);
        await process.StandardInput.WriteAsync(System.Text.Json.JsonSerializer.Serialize(loaded, serializer));
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await process.WaitForExitAsync(timeout.Token);
        Assert.True(process.ExitCode == 0, await error);
        var request = new RevisionedSettingsRequest { Revision = loaded.Revision, Settings = loaded.Settings };
        loaded.Settings.AutoPauseEnabled = !loaded.Settings.AutoPauseEnabled;
        var receipt = Assert.IsType<SettingsSaveReceipt>(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.SaveRevisionedSettings(user.ToString("N"), request)).Value);
        Assert.NotEqual(loaded.Revision, receipt.Revision);
        Assert.IsType<Microsoft.AspNetCore.Mvc.ConflictObjectResult>(controller.SaveRevisionedSettings(user.ToString("N"), request));
        Assert.Equal(receipt.Revision, fixture.Core.Manager.ReadUserConfigurationDocument(user.ToString("N"), "settings.json").Revision);
    }

}
