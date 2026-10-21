using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 10: Jellyfin's own plugin-configuration route (POST /Plugins/{id}/Configuration, which hands the
/// whole configuration a client posted to the plugin's UpdateConfiguration) is fenced like every other configuration
/// writer. The configuration carries its generation; every write moves it on (a configuration page save, a server write,
/// a restore), and a whole configuration built on an earlier one is refused, so it can't put back what another
/// administrator, the server or a restore changed since (RBS1-R10-2: the stale document replayed ToastDuration and
/// DefaultLanguage; round 9 had listed the route as an exclusion).
/// </summary>
[Collection("Plugin singleton")]
public class CoreHostConfigurationFenceTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static void Set(ApiPluginFixture f, string field, string json)
        => f.Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { [field] = Json(json) } });

    [Fact]
    public void AnEarlierWholeConfigurationIsRefusedAndPutsNothingBack()
    {
        using var f = new ApiPluginFixture();
        var older = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        var delay = f.Plugin.Configuration.HelpPanelAutocloseDelay;
        Set(f, "ToastDuration", "1600");
        older.HelpPanelAutocloseDelay = delay + 5000;
        Assert.NotNull(Record.Exception(() => f.Plugin.UpdateConfiguration(older)));
        Assert.Equal(1600, f.Plugin.Configuration.ToastDuration);
        Assert.Equal(delay, f.Plugin.Configuration.HelpPanelAutocloseDelay);
    }

    [Fact]
    public void AnEarlierWholeConfigurationKeepsAnotherAdministratorsLanguage()
    {
        using var f = new ApiPluginFixture();
        Set(f, "DefaultLanguage", "\"de\"");
        var older = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        Set(f, "DefaultLanguage", "\"fr\"");
        older.ToastDuration = 3000;
        Assert.NotNull(Record.Exception(() => f.Plugin.UpdateConfiguration(older)));
        Assert.Equal("fr", f.Plugin.Configuration.DefaultLanguage);
        Assert.Equal(1500, f.Plugin.Configuration.ToastDuration);
    }

    // The server's own writes (here the plain save every server writer makes) move the generation on too.
    [Fact]
    public void AServerWriteMakesAnEarlierCopyStale()
    {
        using var f = new ApiPluginFixture();
        var older = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        f.Plugin.Configuration.ToastDuration = 1700;
        f.Plugin.SaveConfiguration();
        older.HelpPanelAutocloseDelay = 21000;
        Assert.NotNull(Record.Exception(() => f.Plugin.UpdateConfiguration(older)));
        Assert.Equal(1700, f.Plugin.Configuration.ToastDuration);
        Assert.NotEqual(21000, f.Plugin.Configuration.HelpPanelAutocloseDelay);
    }

    // A restored configuration (a JE backup) is a write like any other: a copy from before it is refused.
    [Fact]
    public void ARestoredConfigurationMakesAnEarlierCopyStale()
    {
        using var f = new ApiPluginFixture();
        var older = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        var restored = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        restored.ToastDuration = 1800;
        f.Plugin.RestoreConfiguration(restored, Array.Empty<string>());
        older.ToastDuration = 2500;
        Assert.NotNull(Record.Exception(() => f.Plugin.UpdateConfiguration(older)));
        Assert.Equal(1800, f.Plugin.Configuration.ToastDuration);
    }

    // Control: a whole configuration built on the one held now is applied.
    [Fact]
    public void ACurrentWholeConfigurationIsApplied()
    {
        using var f = new ApiPluginFixture();
        Set(f, "ToastDuration", "1600");
        var current = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        current.HelpPanelAutocloseDelay = 22000;
        f.Plugin.UpdateConfiguration(current);
        Assert.Equal(22000, f.Plugin.Configuration.HelpPanelAutocloseDelay);
        Assert.Equal(1600, f.Plugin.Configuration.ToastDuration);
    }
}
