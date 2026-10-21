using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

// One rule for every consent (Q-REBUILD1-1 (b), integration rebuild): only the person's own consent operation
// (PATCH user-settings/{id}/consent) sets or clears a consent in their settings.json. A whole-document save (the person's
// own, an administrator's own, an administrator's of someone else) and the reset of everyone's keep every consent as
// stored, whatever the document carries. Before the rule, the person's own whole save still set the automatic-request
// consents (4a) while list swap-in already needed the operation (4e).
[Collection("Plugin singleton")]
public class ApiPersonalConsentRuleTests
{
    // Every personal consent in settings.json. A new consent joins this list, UserConfigurationManager.PersonalConsents
    // and the consent operation's whitelist together.
    private static readonly string[] Consents = { "AutoSeasonRequests", "AutoMovieRequests", "ListSwapIn" };

    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller, bool admin)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User") }, "test"));
        return c;
    }

    private static bool? Get(JellyfinEnhancedUserSettings s, string field) => (bool?)typeof(JellyfinEnhancedUserSettings).GetProperty(field)!.GetValue(s);

    private static void Set(JellyfinEnhancedUserSettings s, string field, bool? value) => typeof(JellyfinEnhancedUserSettings).GetProperty(field)!.SetValue(s, value);

    private static JellyfinEnhancedUserSettings Stored(ApiPluginFixture f, Guid person) =>
        f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(person.ToString("N"), "settings.json");

    public static IEnumerable<object?[]> Cases()
    {
        foreach (var field in Consents)
            foreach (var writer in new[] { "self-save", "admin-own-save", "admin-save", "reset" })
                foreach (var stored in new bool?[] { true, false, null })
                    yield return new object?[] { field, writer, stored };
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void NoWholeSettingsSaveOrResetChangesAnyConsent(string field, string writer, bool? stored)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var seeded = new JellyfinEnhancedUserSettings { ShowFileSizes = false };
        // Every consent stored, the one under test with the case's value and the others with a different one.
        foreach (var other in Consents) Set(seeded, other, other == field ? stored : stored != true);
        f.Core.Manager.SaveUserConfiguration(person.ToString("N"), "settings.json", seeded);
        var before = Consents.ToDictionary(c => c, c => Get(seeded, c));

        // The document carries a different value for every consent (null where the stored one is set, else true).
        var sent = new JellyfinEnhancedUserSettings { ShowFileSizes = true };
        foreach (var c in Consents) Set(sent, c, before[c] == null ? true : before[c] == true ? false : null);
        var answer = writer switch
        {
            "self-save" => Controller(f, person, admin: false).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), sent),
            "admin-own-save" => Controller(f, person, admin: true).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), sent),
            "admin-save" => Controller(f, Guid.NewGuid(), admin: true).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), sent),
            _ => Controller(f, Guid.NewGuid(), admin: true).ResetAllUsersSettings(),
        };

        Assert.IsType<OkObjectResult>(answer);
        var after = Stored(f, person);
        foreach (var c in Consents) Assert.True(before[c] == Get(after, c), $"{writer} changed {c}: {before[c]} → {Get(after, c)}");
        // The save or reset itself happened.
        Assert.Equal(writer == "reset" ? f.Plugin.Configuration.ShowFileSizes : true, after.ShowFileSizes);
    }

    [Fact]
    public void TheConsentInventoryIsTheConsentOperationsWhitelist()
    {
        Assert.Equal(Consents, UserConfigurationManager.PersonalConsents.Select(c => c.Field));
        foreach (var c in Consents) Assert.Equal(typeof(bool?), typeof(JellyfinEnhancedUserSettings).GetProperty(c)!.PropertyType);
    }

    public static IEnumerable<object?[]> Choices()
    {
        foreach (var field in Consents)
            foreach (var value in new bool?[] { true, false, null })
                yield return new object?[] { field, value };
    }

    // The operation sets exactly its own field; null is a choice only where it means "follow the administrator".
    [Theory]
    [MemberData(nameof(Choices))]
    public void TheConsentOperationSetsExactlyItsField(string field, bool? value)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var seeded = new JellyfinEnhancedUserSettings { ShowFileSizes = false };
        foreach (var c in Consents) Set(seeded, c, value != true);
        f.Core.Manager.SaveUserConfiguration(person.ToString("N"), "settings.json", seeded);

        var answer = Controller(f, person, admin: false).SetUserSettingsConsent(person.ToString("N"), new() { Field = field, Value = value });

        var after = Stored(f, person);
        var followsAdministrator = field != "ListSwapIn";
        if (value == null && !followsAdministrator)
        {
            Assert.IsType<BadRequestObjectResult>(answer);
            Assert.True(Get(after, field));
        }
        else
        {
            var ok = Assert.IsType<OkObjectResult>(answer);
            Assert.Equal(value, Get(after, field));
            // The answer carries every consent as stored.
            var consents = Assert.IsAssignableFrom<IReadOnlyDictionary<string, bool?>>(ok.Value!.GetType().GetProperty("consents")!.GetValue(ok.Value));
            foreach (var c in Consents) Assert.Equal(Get(after, c), consents[c]);
        }

        foreach (var c in Consents.Where(c => c != field)) Assert.Equal(value != true, Get(after, c));
        Assert.False(after.ShowFileSizes);
    }
}
