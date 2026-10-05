using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace JE.Tests;

public class CoreServerConfigurationTests
{
    private static PluginConfiguration Legacy(string json) => new()
    {
        SonarrInstances = json, RadarrInstances = json,
        SonarrUrl = "http://sonarr.local", SonarrApiKey = "sonarr-key", SonarrUrlMappings = "source|dest",
        RadarrUrl = "http://radarr.local", RadarrApiKey = "radarr-key", RadarrUrlMappings = "source|dest"
    };

    [Theory]
    [InlineData("")][InlineData(" ")][InlineData("[]")][InlineData("null")][InlineData("[null]")][InlineData("[{}]")]
    public void EmptyOrIncompleteInstancesMigrateLegacyCredentials(string json)
    {
        var config = Legacy(json);
        var sonarr = Assert.Single(config.GetSonarrInstances());
        var radarr = Assert.Single(config.GetRadarrInstances());
        Assert.Equal("http://sonarr.local", sonarr.Url);
        Assert.Equal("sonarr-key", sonarr.ApiKey);
        Assert.Equal("source|dest", sonarr.UrlMappings);
        Assert.Equal("http://radarr.local", radarr.Url);
        Assert.Equal("radarr-key", radarr.ApiKey);
        Assert.False(config.IsSonarrInstancesCorrupt());
        Assert.False(config.IsRadarrInstancesCorrupt());
    }

    [Theory]
    [InlineData("broken")][InlineData("{}")][InlineData("[]junk")][InlineData("[]\n{}")][InlineData("[42]")]
    public void CorruptInstanceListsNeverReactivateLegacyCredentials(string json)
    {
        var config = Legacy(json);
        Assert.Empty(config.GetSonarrInstances());
        Assert.Empty(config.GetRadarrInstances());
        Assert.True(config.IsSonarrInstancesCorrupt());
        Assert.True(config.IsRadarrInstancesCorrupt());
        Assert.Equal(json, config.SonarrInstances);
    }

    [Fact]
    public void ExplicitInstancesOverrideLegacyAndDisabledInstancesAreRetainedButNotUsed()
    {
        var config = Legacy("[{\"Name\":\"on\",\"Url\":\"http://on.local\",\"ApiKey\":\"key\",\"Enabled\":true},{\"Name\":\"off\",\"Url\":\"http://off.local\",\"ApiKey\":\"key\",\"Enabled\":false},null,{}]");
        Assert.Equal(2, config.GetSonarrInstances().Count);
        Assert.Equal(2, config.GetRadarrInstances().Count);
        Assert.Equal("on", Assert.Single(config.GetEnabledSonarrInstances()).Name);
        Assert.Equal("on", Assert.Single(config.GetEnabledRadarrInstances()).Name);
        Assert.DoesNotContain(config.GetSonarrInstances(), i => i.Url == config.SonarrUrl);
    }

    [Theory]
    [InlineData(null, "all")][InlineData("", "all")][InlineData("all", "all")]
    [InlineData("[\"private-user-guid\"]", "selected")][InlineData("unexpected", "selected")]
    public void PublicMaintenanceShapeNeverLeaksUserIdentity(string? raw, string expected)
        => Assert.Equal(expected, PluginConfiguration.DeriveAffectedUsersShape(raw));

    [Theory]
    [InlineData("", "key", false)][InlineData("url", " ", false)][InlineData("url", "key", true)]
    public void ShokoRequiresBothUrlAndKey(string url, string key, bool expected)
        => Assert.Equal(expected, new PluginConfiguration { ShokoUrl = url, ShokoApiKey = key }.IsShokoConfigured());
}
