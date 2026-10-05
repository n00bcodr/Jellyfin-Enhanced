using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Newtonsoft.Json;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreWhatsNewTests
{
    [Fact]
    public void FreshInstallAcknowledgesCurrentSchemaWithoutNewBanner()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.CheckForNewSettings();
        Assert.Null(service.GetState());
        var path = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var baseline = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!;
        Assert.NotEmpty(baseline.SettingIds);
        Assert.Equal(f.Plugin.Version.ToString(), baseline.PluginVersion);
        Assert.Equal(baseline.SettingIds.Count, baseline.SettingIds.Distinct().Count());
    }

    [Fact]
    public void StartupPreservesAcknowledgedBaselineAndFirstSeenVersionUntilDismissal()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.Dismiss();
        var path = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var baseline = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!;
        var missing = baseline.SettingIds[0];
        baseline.SettingIds.RemoveAt(0);
        baseline.PluginVersion = "1.0.0.0";
        File.WriteAllText(path, JsonConvert.SerializeObject(baseline));
        service.CheckForNewSettings();
        Assert.Contains(missing, service.GetState()!.NewSettings.Keys);
        var state = service.GetState()!;
        state.NewSettings[missing] = "2.0.0.0";
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "whats-new.json"), JsonConvert.SerializeObject(state));
        service.CheckForNewSettings();
        Assert.Equal("2.0.0.0", service.GetState()!.NewSettings[missing]);
        Assert.DoesNotContain(missing, JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!.SettingIds);
        service.Dismiss();
        Assert.Null(service.GetState());
        service.CheckForNewSettings();
        Assert.Null(service.GetState());
        Assert.Contains(missing, JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!.SettingIds);
    }

    [Theory]
    [InlineData("")][InlineData("null")][InlineData("not json")]
    public void CorruptNotificationStateDoesNotPreventStartup(string content)
    {
        using var f = new ApiPluginFixture();
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "whats-new.json"), content);
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        Assert.Null(service.GetState());
        service.CheckForNewSettings();
        Assert.True(File.Exists(Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json")));
    }
}
