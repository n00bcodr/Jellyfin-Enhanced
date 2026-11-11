using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Newtonsoft.Json;

namespace JE.Tests.Features.Admin;

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

    [Fact]
    public void StateFilesAreReplacedInsteadOfRewrittenInPlace()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.Dismiss();
        var snapshotPath = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var statePath = Path.Combine(f.Core.ConfigRoot, "whats-new.json");
        var baseline = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(snapshotPath))!;
        baseline.SettingIds.RemoveAt(0);
        baseline.PluginVersion = "1.0.0.0";
        File.WriteAllText(snapshotPath, JsonConvert.SerializeObject(baseline));
        File.WriteAllText(statePath, JsonConvert.SerializeObject(new WhatsNewState { PluginVersion = "1.0.0.0" }));
        // Each file as a reader opened it before the write. Rewriting a file in place truncates
        // these bytes first, which is what a crash or a full disk leaves behind; a replacement keeps them.
        static byte[] Rest(FileStream held) { using var seen = new MemoryStream(); held.CopyTo(seen); return seen.ToArray(); }
        var stateBefore = File.ReadAllBytes(statePath);
        using (var held = new FileStream(statePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            service.CheckForNewSettings();
            Assert.Equal(stateBefore, Rest(held));
        }
        Assert.Equal(f.Plugin.Version.ToString(), service.GetState()!.PluginVersion);
        var snapshotBefore = File.ReadAllBytes(snapshotPath);
        using (var held = new FileStream(snapshotPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            service.Dismiss();
            Assert.Equal(snapshotBefore, Rest(held));
        }
        Assert.Equal(f.Plugin.Version.ToString(), JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(snapshotPath))!.PluginVersion);
        Assert.Equal(["config-schema-snapshot.json"], Directory.GetFiles(f.Core.ConfigRoot, "*.json*").Select(Path.GetFileName));
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
