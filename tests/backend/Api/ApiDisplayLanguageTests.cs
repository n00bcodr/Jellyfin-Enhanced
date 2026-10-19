using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

// Dashcrash §7 (integration rebuild): JE never stores an invalid display language. A person's DisplayLanguage, and the
// administrator's default as each person's first or reset setting, is a supported language tag (a language JE ships,
// exactly or by its base language, or a culture the server knows) or Auto (""): never a literal "undefined" or "null",
// a malformed or an unsupported value, which the client would otherwise mirror into Jellyfin's shared language key.
[Collection("Plugin singleton")]
public class ApiDisplayLanguageTests
{
    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, "User") }, "test"));
        return c;
    }

    private static JellyfinEnhancedUserSettings Stored(ApiPluginFixture f, Guid person) =>
        f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(person.ToString("N"), "settings.json");

    public static IEnumerable<object?[]> Languages() => new[]
    {
        new object?[] { null, "" }, new object?[] { "", "" }, new object?[] { "  ", "" },
        new object?[] { "en-AU", "en-AU" }, new object?[] { "en-au", "en-AU" }, new object?[] { "pt-br", "pt-BR" },
        new object?[] { "pr", "pr" }, new object?[] { "gsw", "gsw" }, new object?[] { "fr", "fr" },
        new object?[] { "undefined", "" }, new object?[] { "null", "" }, new object?[] { "NaN", "" },
        new object?[] { "en_US!", "" }, new object?[] { "english", "" }, new object?[] { "../en", "" }, new object?[] { "en-", "" },
        new object?[] { "zz-ZZ", "" }, new object?[] { "qaa", "" },
    };

    [Theory]
    [MemberData(nameof(Languages))]
    public void ASavedDisplayLanguageIsASupportedTagOrAuto(string? sent, string stored)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Assert.IsType<OkObjectResult>(Controller(f, person).SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { DisplayLanguage = sent!, ShowFileSizes = true }));
        Assert.Equal(stored, Stored(f, person).DisplayLanguage);
        Assert.True(Stored(f, person).ShowFileSizes);
    }

    [Theory]
    [MemberData(nameof(Languages))]
    public void TheAdministratorsDefaultLanguageSeedsAndResetsOnlyASupportedTag(string? configured, string stored)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.DefaultLanguage = configured!;
        var person = Guid.NewGuid();
        // The person's first read writes their defaults.
        Assert.IsType<OkObjectResult>(Controller(f, person).GetUserSettingsSettings(person.ToString("N")));
        Assert.Equal(stored, Stored(f, person).DisplayLanguage);
        Assert.Equal(stored, UserSettingsDefaults.Create(f.Plugin.Configuration).DisplayLanguage);
    }

    // Stage 1 fix round 2 (RBS1-BEH-R2-2): the complete tag's syntax is checked before any exact or base-language match,
    // so a malformed tag of a shipped language (en-12, en-US-US) is Auto, and a valid one (en-AU, pt-BR, zh-Hant) is kept,
    // on every server write: a save, the first-read seed and a reset. One table with the client
    // (tests/backend/Api/language-tags.json).
    private static JsonElement Table(string name)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "tests", "backend", "Api", "language-tags.json")));
        return document.RootElement.GetProperty(name).Clone();
    }

    public static IEnumerable<object?[]> Writes()
    {
        foreach (var row in Table("write").EnumerateArray())
            foreach (var path in new[] { "save", "seed", "reset" })
                yield return new object?[] { row[0].GetString(), row[1].GetString(), path };
    }

    [Theory]
    [MemberData(nameof(Writes))]
    public void EveryServerWriteChecksTheWholeTagBeforeMatchingAShippedLanguage(string raw, string expected, string path)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var admin = Controller(f, Guid.NewGuid());
        admin.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, "Administrator") }, "test"));
        switch (path)
        {
            case "save":
                Assert.IsType<OkObjectResult>(Controller(f, person).SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { DisplayLanguage = raw }));
                break;
            case "seed":
                f.Plugin.Configuration.DefaultLanguage = raw;
                Assert.IsType<OkObjectResult>(Controller(f, person).GetUserSettingsSettings(person.ToString("N")));
                break;
            default:
                Assert.IsType<OkObjectResult>(Controller(f, person).SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { DisplayLanguage = "fr" }));
                f.Plugin.Configuration.DefaultLanguage = raw;
                Assert.IsType<OkObjectResult>(admin.ResetAllUsersSettings());
                break;
        }

        Assert.Equal(expected, Stored(f, person).DisplayLanguage);
    }

    // The server's syntax rule is the client's (JE.languageCode): the same table, the same answers.
    [Fact]
    public void TheServersLanguageTagSyntaxIsTheClients()
    {
        var canonical = typeof(Jellyfin.Plugin.JellyfinEnhanced.Helpers.LanguageTags).GetMethod("Canonical", new[] { typeof(string) });
        Assert.NotNull(canonical);
        var wrong = Table("syntax").EnumerateArray()
            .Select(row => (Raw: row[0].GetString(), Expected: row[1].GetString(), Got: (string?)canonical!.Invoke(null, new object?[] { row[0].GetString() })))
            .Where(r => r.Expected != r.Got).Select(r => $"{r.Raw} → {r.Got} (expected {r.Expected})").ToList();
        Assert.Empty(wrong);
    }

    [Fact]
    public void ThePublicConfigurationListsTheLanguagesJeShips()
    {
        using var f = new ApiPluginFixture();
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        var languages = document.RootElement.GetProperty("SupportedLanguages").EnumerateArray().Select(e => e.GetString()).ToList();
        var shipped = Directory.GetFiles(Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "js", "locales"), "*.json")
            .Select(Path.GetFileNameWithoutExtension).OrderBy(c => c, StringComparer.OrdinalIgnoreCase).ToList();
        Assert.Equal(shipped, languages);
        Assert.Contains("en", languages);
        Assert.Contains("pr", languages);
        // The panel's list is the same, without the base English.
        Assert.Equal(shipped.Where(c => c != "en"), Assert.IsAssignableFrom<IEnumerable<string>>(Assert.IsType<OkObjectResult>(controller.GetAvailableLocales()).Value));
    }
}
