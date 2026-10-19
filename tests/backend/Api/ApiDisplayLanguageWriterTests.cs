using System.Security.Claims;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

// Stage 1 fix round 3 (RBS1-R3-1): one gate for every writer. Whatever puts a person's settings.json in place (a save,
// the first-read seed, a reset: ApiDisplayLanguageTests; here: the consent operation, any other whole-file writer, a JE
// backup restore, the start-up folder migration) stores only a display language the shared policy accepts, and keeps
// every other field. What the server hands out (the settings answer, a save's answer, the public configuration) is what
// it stores, so the client mirrors only that; the administrator's default is gated when the configuration is saved or
// restored.
[Collection("Plugin singleton")]
public class ApiDisplayLanguageWriterTests
{
    private const string User = "0123456789abcdef0123456789abcdef";

    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, "User") }, "test"));
        return c;
    }

    private static string Path_(ApiPluginFixture f, string user) => Path.Combine(f.Core.ConfigRoot, user, "settings.json");

    // Read as stored: date-like strings stay strings, decimals keep their digits.
    private static JObject File_(string path)
    {
        using var reader = new Newtonsoft.Json.JsonTextReader(new StringReader(File.ReadAllText(path)))
        {
            DateParseHandling = Newtonsoft.Json.DateParseHandling.None,
            FloatParseHandling = Newtonsoft.Json.FloatParseHandling.Decimal,
        };
        return JObject.Load(reader);
    }

    private static string Folder(ApiPluginFixture f, Guid person) => Directory.CreateDirectory(Path.Combine(f.Core.ConfigRoot, person.ToString("N"))).FullName;

    // A stored document from an older version: its display language, a personal consent, settings JE knows and one it
    // doesn't (a newer version's), a date-like string and a decimal that a careless rewrite would reformat.
    private static string Older(string language) =>
        "{\"DisplayLanguage\":\"" + language + "\",\"ShowFileSizes\":true,\"AutoMovieRequests\":true,\"FutureField\":{\"a\":[1,2]},"
        + "\"Note\":\"2026-10-19T10:00:00Z\",\"Ratio\":1.10}";

    private static void AssertKept(JObject stored)
    {
        Assert.True((bool)stored["ShowFileSizes"]!);
        Assert.True((bool)stored["AutoMovieRequests"]!);
        Assert.True(JToken.DeepEquals(JToken.Parse("{\"a\":[1,2]}"), stored["FutureField"]));
        Assert.Equal(JTokenType.String, stored["Note"]!.Type);
        Assert.Equal("2026-10-19T10:00:00Z", (string)stored["Note"]!);
    }

    public static IEnumerable<object[]> Values() => new[]
    {
        new object[] { "en-US-US", "" }, new object[] { "haw-AU", "" }, new object[] { "kok-GB", "" }, new object[] { "ja", "" },
        new object[] { "pt-br", "pt-BR" }, new object[] { "en-AU", "en-AU" },
    };

    [Theory]
    [MemberData(nameof(Values))]
    public void APersonsConsentOperationStoresTheirDisplayLanguageThroughTheGate(string stored, string expected)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        File.WriteAllText(Path.Combine(Folder(f, person), "settings.json"), Older(stored));
        var answer = Controller(f, person).SetUserSettingsConsent(person.ToString("N"), new JellyfinEnhancedController.PersonalConsentChange { Field = "ListSwapIn", Value = true });
        Assert.IsType<OkObjectResult>(answer);
        var file = File_(Path_(f, person.ToString("N")));
        Assert.Equal(expected, (string)file["DisplayLanguage"]!);
        Assert.True((bool)file["ListSwapIn"]!);
        Assert.True((bool)file["AutoMovieRequests"]!);
    }

    [Theory]
    [MemberData(nameof(Values))]
    public void AnyWholeFileWriterOfSettingsJsonPassesTheGate(string sent, string expected)
    {
        using var f = new ApiPluginFixture();
        // A raw document (as the administrator's display change writes one), the property in either case.
        foreach (var name in new[] { "DisplayLanguage", "displayLanguage" })
        {
            var doc = JObject.Parse(Older("fr"));
            doc.Remove("DisplayLanguage");
            doc[name] = sent;
            f.Core.Manager.SaveUserConfiguration(User, "settings.json", doc);
            var file = File_(Path_(f, User));
            Assert.Equal(expected, (string)file[name]!);
            AssertKept(file);
        }

        // A read-modify-write of the file (no such caller today; every future one passes the same gate).
        File.WriteAllText(Path_(f, User), Older(sent));
        f.Core.Manager.RmwUserConfiguration<JObject>(User, "settings.json", doc => { doc["ShowFileSizes"] = false; return 1; });
        Assert.Equal(expected, (string)File_(Path_(f, User))["DisplayLanguage"]!);
    }

    [Fact]
    public void OtherFilesAreNeverChangedByTheGate()
    {
        using var f = new ApiPluginFixture();
        f.Core.Manager.SaveUserConfiguration(User, "elsewhere.json", JObject.Parse("{\"DisplayLanguage\":\"en-US-US\"}"));
        Assert.Equal("en-US-US", (string)File_(Path.Combine(f.Core.ConfigRoot, User, "elsewhere.json"))["DisplayLanguage"]!);
    }

    [Theory]
    [MemberData(nameof(Values))]
    public void TheStartUpFolderMigrationPutsSettingsInPlaceThroughTheGate(string stored, string expected)
    {
        // A folder under another spelling of the person's id: moved into place (no canonical folder yet), or merged into
        // an older canonical one.
        foreach (var merge in new[] { false, true })
        {
            using var f = new CoreFixture();
            if (merge) File.SetLastWriteTimeUtc(f.Write(User, Older("fr")), new DateTime(2020, 1, 1));
            var variant = f.Write(Guid.Parse(User).ToString("D").ToUpperInvariant(), Older(stored));
            File.SetLastWriteTimeUtc(variant, new DateTime(2021, 1, 1));
            _ = new UserConfigurationManager(f.Paths.Object, f.Logger);
            var file = File_(Path.Combine(f.ConfigRoot, User, "settings.json"));
            Assert.Equal(expected, (string)file["DisplayLanguage"]!);
            AssertKept(file);
        }
    }

    // A JE backup restore writes each person's settings.json as the backup holds it: the display language goes through the
    // gate, every other field is kept as it was, the file is put in place inside the settings version's bracket, and a
    // document the gate doesn't change is written byte for byte.
    [Theory]
    [MemberData(nameof(Values))]
    public void ABackupRestoreSanitizesTheRestoredSettingsDocumentAndKeepsTheRest(string inBackup, string expected)
    {
        using var f = new ApiPluginFixture();
        var configPath = Path.Combine(f.Core.Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced.xml");
        f.Plugin.Configuration.DefaultLanguage = "en-US-US";
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
        using (var s = File.Create(configPath)) new XmlSerializer(typeof(PluginConfiguration)).Serialize(s, f.Plugin.Configuration);
        var other = "fedcba9876543210fedcba9876543210";
        Directory.CreateDirectory(Path.Combine(f.Core.ConfigRoot, User));
        Directory.CreateDirectory(Path.Combine(f.Core.ConfigRoot, other));
        File.WriteAllText(Path_(f, User), Older(inBackup));
        File.WriteAllText(Path_(f, other), Older("fr"));
        var service = new JeBackupService(f.Core.ConfigRoot, configPath, () => f.Plugin.Secrets, f.Core.Logger);
        using var zip = new MemoryStream();
        service.Export(zip, JeBackupSecrets.Exclude, null);

        // Since the backup: the person chose French, the other person's file changed.
        File.WriteAllText(Path_(f, User), "{\"DisplayLanguage\":\"fr\"}");
        File.WriteAllText(Path_(f, other), "{}");
        var before = UserConfigurationManager.SettingsVersion(User);

        service.Restore(new MemoryStream(zip.ToArray()), null);

        var file = File_(Path_(f, User));
        Assert.Equal(expected, (string)file["DisplayLanguage"]!);
        AssertKept(file);
        Assert.Equal(1.10m, file["Ratio"]!.Value<decimal>());
        Assert.Equal(Older("fr"), File.ReadAllText(Path_(f, other)));
        if (expected == inBackup) Assert.Equal(Older(inBackup), File.ReadAllText(Path_(f, User)));
        var after = UserConfigurationManager.SettingsVersion(User);
        Assert.True(Jellyfin.Plugin.JellyfinEnhanced.Helpers.FactVersion.Settled(after));
        Assert.True(after > before);
        // The restored configuration's default language passes the same gate.
        Assert.Equal("", f.Plugin.Configuration.DefaultLanguage);
        // What the person's next read is handed is what is stored.
        Assert.Equal(expected, ReadAnswer(f, Guid.Parse(User)).GetProperty("DisplayLanguage").GetString());
    }

    private static JsonElement ReadAnswer(ApiPluginFixture f, Guid person)
        => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(Controller(f, person).GetUserSettingsSettings(person.ToString("N"))).Value);

    // A file written before the gate existed is handed out as the gate would store it, and not rewritten by a read.
    [Theory]
    [MemberData(nameof(Values))]
    public void TheSettingsAnswerIsWhatTheGateWouldStore(string stored, string expected)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var path = Path.Combine(Folder(f, person), "settings.json");
        File.WriteAllText(path, Older(stored));
        Assert.Equal(expected, ReadAnswer(f, person).GetProperty("DisplayLanguage").GetString());
        Assert.Equal(Older(stored), File.ReadAllText(path));
    }

    // A save answers what it stored, so the client mirrors that (RBS1-R3-2: haw-AU was stored as Auto while the client
    // kept and mirrored haw-AU until a reload).
    [Theory]
    [MemberData(nameof(Values))]
    public void ASaveAnswersTheDisplayLanguageItStored(string sent, string expected)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var answer = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(Controller(f, person)
            .SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { DisplayLanguage = sent })).Value);
        Assert.Equal(expected, answer.GetProperty("displayLanguage").GetString());
        Assert.Equal(expected, f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(person.ToString("N"), "settings.json").DisplayLanguage);
        // The consent operation answers it too.
        var consent = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(Controller(f, person)
            .SetUserSettingsConsent(person.ToString("N"), new JellyfinEnhancedController.PersonalConsentChange { Field = "ListSwapIn", Value = false })).Value);
        Assert.Equal(expected, consent.GetProperty("displayLanguage").GetString());
    }

    // The administrator's default: stored through the gate when the configuration is saved, and handed out gated.
    [Theory]
    [MemberData(nameof(Values))]
    public void TheAdministratorsDefaultLanguageIsGatedWhenSavedAndWhenHandedOut(string configured, string expected)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.DefaultLanguage = configured;
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        using (var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value)))
        {
            Assert.Equal(expected, document.RootElement.GetProperty("DefaultLanguage").GetString());
        }

        var saved = f.Plugin.Configuration;
        saved.DefaultLanguage = configured;
        f.Plugin.UpdateConfiguration(saved);
        Assert.Equal(expected, f.Plugin.Configuration.DefaultLanguage);
    }
}
