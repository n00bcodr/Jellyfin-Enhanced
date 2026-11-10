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
