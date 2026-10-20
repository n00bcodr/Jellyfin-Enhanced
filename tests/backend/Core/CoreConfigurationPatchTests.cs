using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 7: a configuration page save is the administrator's changes (PATCH /JellyfinEnhanced/configuration),
/// applied by the server to the configuration it holds at that moment. Whatever another administrator, tab or server write
/// changed between the page's read and its save stays, unless the page changed that same field; arr instances change by id.
/// </summary>
[Collection("Plugin singleton")]
public class CoreConfigurationPatchTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // Stored instances have GUID ids (a save gives any other id a new one).
    private const string R1 = "11111111-1111-4111-8111-111111111111", R2 = "22222222-2222-4222-8222-222222222222";
    private const string S1 = "33333333-3333-4333-8333-333333333333", S2 = "44444444-4444-4444-8444-444444444444", S3 = "55555555-5555-4555-8555-555555555555";
    private const string Gone = "66666666-6666-4666-8666-666666666666";

    private static ConfigurationPatch Set(params (string Field, string Raw)[] fields)
        => new() { Set = fields.ToDictionary(f => f.Field, f => Json(f.Raw)) };

    private static string Instances(params object[] instances) => JsonSerializer.Serialize(instances);

    private static JsonArray Stored(string json) => (JsonArray)JsonNode.Parse(json)!;

    [Fact]
    public void AnotherWritersChangeOfAnotherFieldSurvivesAndOnlyThePatchedFieldsChange()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        plugin.Configuration.DefaultLanguage = "de";
        plugin.Configuration.MaintenanceScheduleEnabled = false;
        plugin.Configuration.ToastDuration = 1500;
        // The page read the configuration; then another writer changed two fields.
        plugin.Configuration.DefaultLanguage = "fr";
        plugin.Configuration.MaintenanceScheduleEnabled = true;
        var before = JsonSerializer.Serialize(plugin.Configuration);

        var result = plugin.PatchConfiguration(Set(("ToastDuration", "3000"), ("ShowFileSizes", "true")));

        Assert.Equal(new[] { "ToastDuration", "ShowFileSizes" }, result.Applied);
        var live = plugin.Configuration;
        Assert.Equal("fr", live.DefaultLanguage);                 // RBS1-R7-1
        Assert.True(live.MaintenanceScheduleEnabled);             // RBS1-R7-2
        Assert.Equal(3000, live.ToastDuration);
        Assert.True(live.ShowFileSizes);
        // Every other field byte for byte as it was.
        var after = JsonNode.Parse(JsonSerializer.Serialize(live))!.AsObject();
        var was = JsonNode.Parse(before)!.AsObject();
        foreach (var (name, value) in was)
        {
            if (name is "ToastDuration" or "ShowFileSizes") continue;
            Assert.True(JsonNode.DeepEquals(value, after[name]), name);
        }
    }

    [Fact]
    public void AnEmptyPatchChangesNothing()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.DefaultLanguage = "de";
        fixture.Plugin.Configuration.Shortcuts = new List<Shortcut> { new() { Name = "OpenSearch", Key = "/" } };
        var before = JsonSerializer.Serialize(fixture.Plugin.Configuration);
        var result = fixture.Plugin.PatchConfiguration(new ConfigurationPatch());
        Assert.Empty(result.Applied);
        Assert.Equal(before, JsonSerializer.Serialize(fixture.Plugin.Configuration));
    }

    [Fact]
    public void ListsAndNumbersAreReadAsJellyfinsRouteReadsThem()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.PatchConfiguration(Set(
            ("Shortcuts", """[{"Name":"OpenSearch","Key":"S","Label":"Open Search","Category":"Global"}]"""),
            ("ToastDuration", "\"2500\""),
            ("MaintenanceModeAffectedUsers", "\"[\\\"u1\\\"]\"")));
        var live = fixture.Plugin.Configuration;
        Assert.Equal("S", Assert.Single(live.Shortcuts).Key);
        Assert.Equal(2500, live.ToastDuration);
        Assert.Equal("[\"u1\"]", live.MaintenanceModeAffectedUsers);
    }

    [Fact]
    public void ServerMintedAndDerivedFieldsAndUnknownNamesAreIgnored()
    {
        using var fixture = new ApiPluginFixture();
        var live = fixture.Plugin.Configuration;
        live.AnalyticsInstallId = "install";
        live.RadarrInstances = Instances(new { Id = R1, Url = "http://r1", ApiKey = "", UrlMappings = "" });
        live.RadarrUrl = "http://r1";
        var result = fixture.Plugin.PatchConfiguration(Set(
            ("AnalyticsInstallId", "\"forged\""), ("RadarrInstances", "\"[]\""), ("RadarrUrl", "\"http://other\""), ("NoSuchSetting", "1"),
            ("ArrServerOwnedSeen", "\"{}\""), ("ShowFileSizes", "true")));
        Assert.Equal(new[] { "AnalyticsInstallId", "RadarrInstances", "RadarrUrl", "NoSuchSetting", "ArrServerOwnedSeen" }, result.Ignored);
        Assert.Equal("install", fixture.Plugin.Configuration.AnalyticsInstallId);
        Assert.Equal("http://r1", fixture.Plugin.Configuration.RadarrUrl);
        Assert.Single(Stored(fixture.Plugin.Configuration.RadarrInstances));
        Assert.True(fixture.Plugin.Configuration.ShowFileSizes);
    }

    [Fact]
    public void AValueOfTheWrongTypeSavesNothing()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.ShowFileSizes = false;
        var ex = Assert.Throws<ConfigurationPatchException>(() =>
            fixture.Plugin.PatchConfiguration(Set(("ShowFileSizes", "true"), ("ToastDuration", "\"soon\""))));
        Assert.Equal("ToastDuration", ex.Field);
        Assert.False(fixture.Plugin.Configuration.ShowFileSizes);
        Assert.Throws<ConfigurationPatchException>(() => fixture.Plugin.PatchConfiguration(Set(("ToastDuration", "null"))));
    }

    // RBS1-R7-3: an unchanged card is never sent; a changed one sends only its changed fields, by instance id.
    [Fact]
    public void InstanceChangesApplyByIdAndKeepWhatAnotherWriterChanged()
    {
        using var fixture = new ApiPluginFixture();
        var live = fixture.Plugin.Configuration;
        live.RadarrInstances = Instances(
            new { Id = R1, Name = "Radarr", Url = "http://r1", ApiKey = "", UrlMappings = "", LinkedLibraryIds = new[] { "a" }, Defaults = new { QualityProfileId = 4, RootFolderPath = "/m", Tags = new[] { 3 } }, SeerrServerId = 0 },
            new { Id = R2, Name = "Radarr 4K", Url = "http://r2", ApiKey = "", UrlMappings = "", LinkedLibraryIds = Array.Empty<string>(), SeerrServerId = 1 });
        // Another administrator, after this page's read: links r1 to another library, points it at another Seerr server
        // and changes its default profile.
        var other = Stored(live.RadarrInstances);
        other[0]!["LinkedLibraryIds"] = new JsonArray("a", "b");
        other[0]!["SeerrServerId"] = 7;
        other[0]!["Defaults"]!["QualityProfileId"] = 9;
        live.RadarrInstances = other.ToJsonString();

        // This page renamed r1, changed its default root folder and r2's links.
        var patch = new ConfigurationPatch
        {
            Instances = new()
            {
                ["RadarrInstances"] = new InstanceListPatch
                {
                    Change = new()
                    {
                        new() { Id = R1, Set = new() { ["Name"] = Json("\"Movies\""), ["Defaults.RootFolderPath"] = Json("\"/films\"") } },
                        new() { Id = R2.ToUpperInvariant(), Set = new() { ["LinkedLibraryIds"] = Json("[\"c\"]") } },
                    },
                },
            },
        };
        var result = fixture.Plugin.PatchConfiguration(patch);

        Assert.Empty(result.Skipped);
        var stored = Stored(fixture.Plugin.Configuration.RadarrInstances);
        Assert.Equal("Movies", (string?)stored[0]!["Name"]);
        Assert.Equal("[\"a\",\"b\"]", stored[0]!["LinkedLibraryIds"]!.ToJsonString());
        Assert.Equal(7, (int)stored[0]!["SeerrServerId"]!);
        Assert.Equal(9, (int)stored[0]!["Defaults"]!["QualityProfileId"]!);
        Assert.Equal("/films", (string?)stored[0]!["Defaults"]!["RootFolderPath"]);
        Assert.Equal("[3]", stored[0]!["Defaults"]!["Tags"]!.ToJsonString());
        Assert.Equal("[\"c\"]", stored[1]!["LinkedLibraryIds"]!.ToJsonString());
        Assert.Equal(1, (int)stored[1]!["SeerrServerId"]!);
    }

    [Fact]
    public void AddingAndRemovingInstancesKeepsOthersAndMirrorsTheFirst()
    {
        using var fixture = new ApiPluginFixture();
        var live = fixture.Plugin.Configuration;
        live.SonarrInstances = Instances(new { Id = S1, Url = "http://s1", ApiKey = "", UrlMappings = "m1" });
        // Another administrator added s2 meanwhile.
        live.SonarrInstances = Instances(new { Id = S1, Url = "http://s1", ApiKey = "", UrlMappings = "m1" }, new { Id = S2, Url = "http://s2", ApiKey = "", UrlMappings = "" });
        var patch = new ConfigurationPatch
        {
            Instances = new()
            {
                ["SonarrInstances"] = new InstanceListPatch
                {
                    Remove = new() { S1 },
                    Add = new() { Json("{\"Id\":\"" + S3 + "\",\"Url\":\"http://s3\",\"ApiKey\":\"\",\"UrlMappings\":\"m3\",\"Enabled\":true}") },
                },
            },
        };
        fixture.Plugin.PatchConfiguration(patch);
        var stored = Stored(fixture.Plugin.Configuration.SonarrInstances);
        Assert.Equal(new[] { S2, S3 }, stored.Select(i => (string?)i!["Id"]));
        Assert.Equal("http://s2", fixture.Plugin.Configuration.SonarrUrl);
        Assert.Equal(string.Empty, fixture.Plugin.Configuration.SonarrUrlMappings);
    }

    [Fact]
    public void OperationsOnAnInstanceAnotherWriterRemovedOrAddedAreSkippedAndReported()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.RadarrInstances = Instances(new { Id = R1, Url = "http://r1", ApiKey = "", UrlMappings = "" });
        fixture.Plugin.PatchConfiguration(new ConfigurationPatch()); // stored as a save stores it
        var before = fixture.Plugin.Configuration.RadarrInstances;
        var result = fixture.Plugin.PatchConfiguration(new ConfigurationPatch
        {
            Instances = new()
            {
                ["RadarrInstances"] = new InstanceListPatch
                {
                    Remove = new() { Gone },
                    Change = new() { new() { Id = Gone, Set = new() { ["Name"] = Json("\"x\"") } } },
                    Add = new() { Json("{\"Id\":\"" + R1 + "\",\"Url\":\"http://dup\"}") },
                },
            },
        });
        Assert.Equal(new[] { $"RadarrInstances[{Gone}] remove", $"RadarrInstances[{Gone}] change", $"RadarrInstances[{R1}] add" }, result.Skipped);
        Assert.Equal(before, fixture.Plugin.Configuration.RadarrInstances);
    }

    [Fact]
    public void AnInstanceListTheServerCantReadIsNotChanged()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.RadarrInstances = "[{broken";
        Assert.Throws<ConfigurationPatchException>(() => fixture.Plugin.PatchConfiguration(new ConfigurationPatch
        {
            Instances = new() { ["RadarrInstances"] = new InstanceListPatch { Remove = new() { R1 } } },
        }));
        Assert.Equal("[{broken", fixture.Plugin.Configuration.RadarrInstances);
    }

    // RBS1-R8-5: "Reset instances" on an unreadable stored list is an explicit operation, applied under the lock only while
    // the stored list is still unreadable; an unreadable list nobody reset keeps its bytes.
    [Fact]
    public void AConfirmedResetReplacesAnUnreadableListAndLeavesTheOtherUnreadableListAlone()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        plugin.Configuration.RadarrInstances = "[{broken";
        plugin.Configuration.RadarrUrl = "http://old.test";
        plugin.Configuration.SonarrInstances = "{also broken";
        var result = plugin.PatchConfiguration(new ConfigurationPatch
        {
            Instances = new()
            {
                ["RadarrInstances"] = new InstanceListPatch
                {
                    ResetUnreadable = true,
                    Add = new() { Json($$"""{"Id":"{{R1}}","Name":"New","Url":"http://new.test","ApiKey":"k"}""") },
                },
            },
        });
        Assert.Contains("RadarrInstances reset", result.Applied);
        var list = Stored(plugin.Configuration.RadarrInstances);
        Assert.Single(list);
        Assert.Equal("New", (string)list[0]!["Name"]!);
        Assert.Equal("http://new.test", plugin.Configuration.RadarrUrl);
        Assert.Equal("{also broken", plugin.Configuration.SonarrInstances);
    }

    [Fact]
    public void AResetAloneStoresAnEmptyListAndClearsTheMirroredFields()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        plugin.Configuration.RadarrInstances = "not json";
        plugin.Configuration.RadarrUrl = "http://old.test";
        plugin.PatchConfiguration(new ConfigurationPatch { Instances = new() { ["RadarrInstances"] = new InstanceListPatch { ResetUnreadable = true } } });
        Assert.Equal("[]", plugin.Configuration.RadarrInstances);
        Assert.Equal(string.Empty, plugin.Configuration.RadarrUrl);
    }

    [Fact]
    public void AResetOfAListAnotherWriterRepairedIsSkippedAndReportedAndTheirListStays()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        var repaired = Instances(new { Id = R2, Name = "Repaired", Url = "http://r.test", ApiKey = "k" });
        plugin.Configuration.RadarrInstances = repaired;
        var result = plugin.PatchConfiguration(new ConfigurationPatch
        {
            Set = new() { ["ToastDuration"] = Json("2500") },
            Instances = new() { ["RadarrInstances"] = new InstanceListPatch { ResetUnreadable = true, Add = new() { Json($$"""{"Id":"{{R1}}","Name":"New"}""") } } },
        });
        Assert.Contains(result.Skipped, s => s.StartsWith("RadarrInstances reset", StringComparison.Ordinal));
        var list = Stored(plugin.Configuration.RadarrInstances);
        Assert.Single(list);
        Assert.Equal("Repaired", (string)list[0]!["Name"]!);
        Assert.Equal(2500, plugin.Configuration.ToastDuration);
    }

    [Fact]
    public void ATypedCredentialIsStoredAsASecretAndUntouchedPlaceholdersStay()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        plugin.PatchConfiguration(Set(("JellyseerrApiKey", "\"SEERR-KEY-0000000000\"")));
        var seerrPlaceholder = plugin.Configuration.JellyseerrApiKey;
        Assert.True(SecretValue.IsPlaceholder(seerrPlaceholder));
        Assert.Equal("SEERR-KEY-0000000000", plugin.Secrets.Get(nameof(PluginConfiguration.JellyseerrApiKey)));

        plugin.PatchConfiguration(Set(("TMDB_API_KEY", "\"TMDB-KEY-00000000000\"")));
        Assert.Equal(seerrPlaceholder, plugin.Configuration.JellyseerrApiKey);
        Assert.Equal("SEERR-KEY-0000000000", plugin.Secrets.Get(nameof(PluginConfiguration.JellyseerrApiKey)));
        Assert.Equal("TMDB-KEY-00000000000", plugin.Secrets.Get(nameof(PluginConfiguration.TMDB_API_KEY)));
    }

    [Fact]
    public void ThePatchRunsTheUsualSaveRulesTheDisplayLanguageGateIncluded()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.PatchConfiguration(Set(("DefaultLanguage", "\"undefined\"")));
        Assert.Equal(string.Empty, fixture.Plugin.Configuration.DefaultLanguage);
    }

    private static ConfigurationPatchController Controller(ApiPluginFixture fixture, bool admin)
    {
        var callers = new TestCallers();
        var controller = new ConfigurationPatchController(callers.Users.Object, fixture.Core.Logger)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        controller.HttpContext.User = callers.Person(admin);
        return controller;
    }

    [Fact]
    public void OnlyAnAdministratorMayPatchAndTheAnswerIsTheStoredConfiguration()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.DefaultLanguage = "fr";
        Assert.IsType<ForbidResult>(Controller(fixture, admin: false).Patch(Set(("ShowFileSizes", "true"))));
        Assert.False(fixture.Plugin.Configuration.ShowFileSizes);

        var ok = Assert.IsType<OkObjectResult>(Controller(fixture, admin: true).Patch(Set(("ShowFileSizes", "true"))));
        var answer = JsonNode.Parse(JsonSerializer.Serialize(ok.Value))!;
        Assert.True((bool)answer["configuration"]!["ShowFileSizes"]!);
        Assert.Equal("fr", (string?)answer["configuration"]!["DefaultLanguage"]);

        var bad = Assert.IsType<BadRequestObjectResult>(Controller(fixture, admin: true).Patch(Set(("ToastDuration", "\"x\""))));
        Assert.Contains("ToastDuration", JsonSerializer.Serialize(bad.Value));
    }
}
