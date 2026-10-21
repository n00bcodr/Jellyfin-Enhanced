using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

// A person's list swap-in consent (UserSettings.ListSwapIn) is theirs alone. The legacy settings save replaces the whole
// settings.json and is open to the owner or an administrator, and the administrators' "reset all users" writes defaults
// for everyone: none may change a consent. Only the person's explicit field-level operation does.
[Collection("Plugin singleton")]
public class ApiListConsentTests
{
    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller, bool admin)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User") }, "test"));
        return c;
    }

    private static JellyfinEnhancedUserSettings Stored(ApiPluginFixture f, Guid person) =>
        f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(person.ToString("N"), "settings.json");

    private static void Seed(ApiPluginFixture f, Guid person, bool? consent) =>
        f.Core.Manager.SaveUserConfiguration(person.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { ListSwapIn = consent, ShowFileSizes = false });

    // Browser 2 still carries the opposite consent when it saves a display choice.
    [Theory]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, null, true)]
    [InlineData(null, true, false)]
    public void OwnWholeDocumentSavePreservesEveryStoredConsent(bool? stored, bool? stale, bool admin)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, stored);
        var answer = Controller(f, person, admin).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"),
            new JellyfinEnhancedUserSettings { ListSwapIn = stale, ShowFileSizes = true });
        Assert.IsType<OkObjectResult>(answer);
        Assert.Equal(stored, Stored(f, person).ListSwapIn);
        Assert.True(Stored(f, person).ShowFileSizes);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(true, null)]
    [InlineData(null, true)]
    [InlineData(false, true)]
    public void AnAdministratorsSaveOfAnotherPersonsSettingsKeepsTheirSwapInConsent(bool? theirs, bool? sent)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, theirs);

        var answer = Controller(f, Guid.NewGuid(), admin: true).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { ListSwapIn = sent, ShowFileSizes = true });

        Assert.IsType<OkObjectResult>(answer);
        var stored = Stored(f, person);
        Assert.Equal(theirs, stored.ListSwapIn);
        Assert.True(stored.ShowFileSizes); // the rest of the save stands
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(true, false)]
    [InlineData(true, null)]
    public void APersonsExplicitOperationSetsTheirSwapInConsent(bool? theirs, bool? sent)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, theirs);

        Assert.IsType<OkObjectResult>(Controller(f, person, admin: false).SetUserSettingsConsent(person.ToString("N"), new() { Field = "ListSwapIn", Value = sent ?? false }));

        Assert.Equal(sent ?? false, Stored(f, person).ListSwapIn);
    }

    // An administrator saving their OWN settings is that person.
    [Fact]
    public void AnAdministratorsExplicitOwnOperationSetsTheirOwnSwapInConsent()
    {
        using var f = new ApiPluginFixture();
        var admin = Guid.NewGuid();
        Seed(f, admin, null);

        Assert.IsType<OkObjectResult>(Controller(f, admin, admin: true).SetUserSettingsConsent(admin.ToString("N"), new() { Field = "ListSwapIn", Value = true }));

        Assert.True(Stored(f, admin).ListSwapIn);
    }

    [Fact]
    public void ResettingEveryonesSettingsLeavesEachPersonsSwapInConsent()
    {
        using var f = new ApiPluginFixture();
        var agreed = Guid.NewGuid();
        var refused = Guid.NewGuid();
        var unset = Guid.NewGuid();
        Seed(f, agreed, true);
        Seed(f, refused, false);
        Seed(f, unset, null);

        Assert.IsType<OkObjectResult>(Controller(f, Guid.NewGuid(), admin: true).ResetAllUsersSettings());

        Assert.True(Stored(f, agreed).ListSwapIn);
        Assert.False(Stored(f, refused).ListSwapIn);
        Assert.Null(Stored(f, unset).ListSwapIn);
        // The reset itself happened (the seeded preference is back to the default).
        Assert.Equal(f.Plugin.Configuration.ShowFileSizes, Stored(f, agreed).ShowFileSizes);
    }

    // Review round 4 (4c1-r4-security-2 / behaviour-3): keeping the consent is atomic with the save. Each case runs another
    // writer's save while the first one is in the middle of writing the person's settings.json (it has read what it keeps):
    // the person's own save of their consent must wait for it and land after it, never be overwritten by it.
    public static IEnumerable<object[]> Writers() => new[] { new object[] { "admin-save" }, new object[] { "self-save" }, new object[] { "reset" }, new object[] { "first-read" } };

    [Theory]
    [MemberData(nameof(Writers))]
    public async Task APersonsConsentSavedWhileAnotherWriterSavesTheirSettingsIsNeverUndone(string writer)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var personN = person.ToString("N");
        if (writer != "first-read")
        {
            Seed(f, person, true);
        }

        var wanted = writer == "first-read" ? (bool?)true : false;
        Task<IActionResult>? theirs = null;
        var landedInside = false;
        var started = 0;
        f.Core.Manager.Saving = (user, file) =>
        {
            if (user == personN && file == "settings.json" && Interlocked.Exchange(ref started, 1) == 0)
            {
                // The other writer is saving the person's settings now: the person saves their own consent.
                theirs = Task.Run(() => Controller(f, person, admin: false).SetUserSettingsConsent(personN, new() { Field = "ListSwapIn", Value = wanted }));
                landedInside = theirs.Wait(TimeSpan.FromSeconds(1));
            }
        };

        var other = Controller(f, Guid.NewGuid(), admin: true);
        switch (writer)
        {
            case "self-save":
                Assert.IsType<OkObjectResult>(Controller(f, person, false).HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { ListSwapIn = true, ShowFileSizes = true }));
                break;
            case "admin-save":
                Assert.IsType<OkObjectResult>(other.HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { ListSwapIn = null, ShowFileSizes = true }));
                break;
            case "reset":
                Assert.IsType<OkObjectResult>(other.ResetAllUsersSettings());
                break;
            default:
                // The person's first read writes their defaults.
                Assert.IsType<OkObjectResult>(Controller(f, person, admin: false).GetUserSettingsSettings(personN));
                break;
        }

        Assert.NotNull(theirs);
        Assert.IsType<OkObjectResult>(await theirs!);
        Assert.False(landedInside, "the person's save ran while another writer held their settings");
        Assert.Equal(wanted, Stored(f, person).ListSwapIn);
    }

    [Theory]
    [InlineData("ListStatus", true)]
    [InlineData("listSwapIn", true)]
    [InlineData("Unknown", false)]
    [InlineData(null, true)]
    [InlineData("ListSwapIn", null)]
    public void ExplicitConsentRejectsUnknownFieldsOrMissingIntent(string? field, bool? value)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, false);
        Assert.IsType<BadRequestObjectResult>(Controller(f, person, false).SetUserSettingsConsent(person.ToString("N"), new() { Field = field, Value = value }));
        Assert.False(Stored(f, person).ListSwapIn);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EvenAnAdministratorCannotSetAnotherPersonsConsent(bool admin)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, false);
        Assert.IsType<ForbidResult>(Controller(f, Guid.NewGuid(), admin).SetUserSettingsConsent(person.ToString("N"), new() { Field = "ListSwapIn", Value = true }));
        Assert.False(Stored(f, person).ListSwapIn);
    }

    [Fact]
    public void StaleBrowserDisplaySaveCannotUndoExplicitRevocation()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, true);
        var browser2 = Stored(f, person);
        var read = Controller(f, person, false).HavingRead(f.Core.Manager, person.ToString("N")).HttpContext.Request.Headers.IfMatch.ToString();
        var self = Controller(f, person, false);
        Assert.IsType<OkObjectResult>(self.SetUserSettingsConsent(person.ToString("N"), new() { Field = "ListSwapIn", Value = false }));
        browser2.ShowFileSizes = true;
        // Stage 1 fix round 9: the stale document is refused whole (the revocation changed the stored revision).
        var stale = Controller(f, person, false);
        stale.HttpContext.Request.Headers.IfMatch = read;
        Assert.Equal(409, Assert.IsAssignableFrom<ObjectResult>(stale.SaveUserSettingsSettings(person.ToString("N"), browser2)).StatusCode);
        Assert.False(Stored(f, person).ListSwapIn);
        Assert.False(Stored(f, person).ShowFileSizes);
        // Read again, the same document is stored, and the revocation stays.
        Assert.IsType<OkObjectResult>(Controller(f, person, false).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), browser2));
        Assert.False(Stored(f, person).ListSwapIn);
        Assert.True(Stored(f, person).ShowFileSizes);
    }

    // Every writer of a person's settings.json takes the one lock (UserConfigurationManager.UserSettingsLock).
    [Theory]
    [MemberData(nameof(Writers))]
    public void EverySettingsWriterHoldsThePersonsSettingsLock(string writer)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var personN = person.ToString("N");
        if (writer != "first-read")
        {
            Seed(f, person, true);
        }

        var held = new List<bool>();
        f.Core.Manager.Saving = (user, file) =>
        {
            if (user == personN && file == "settings.json")
            {
                held.Add(Monitor.IsEntered(f.Core.Manager.UserSettingsLock(personN)));
            }
        };

        var admin = Controller(f, Guid.NewGuid(), admin: true);
        var self = Controller(f, person, admin: false);
        switch (writer)
        {
            case "self-save":
                self.HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { ShowFileSizes = true });
                self.SetUserSettingsConsent(personN, new() { Field = "ListSwapIn", Value = false });
                break;
            case "admin-save":
                admin.HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { ShowFileSizes = true });
                self.SetUserSettingsConsent(personN, new() { Field = "ListSwapIn", Value = false });
                break;
            case "reset":
                admin.ResetAllUsersSettings();
                break;
            default:
                self.GetUserSettingsSettings(personN);
                break;
        }

        Assert.NotEmpty(held);
        Assert.All(held, Assert.True);
    }
}
