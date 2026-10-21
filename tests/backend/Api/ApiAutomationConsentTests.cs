using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

// A person's automatic movie and season request consents are theirs alone. The legacy settings save replaces the whole
// settings.json and is open to the owner or an administrator, and the administrators' "reset all users" writes defaults
// for everyone: none of them sets or clears a consent. Only the person's own consent operation
// (PATCH user-settings/{id}/consent) does: one rule for every consent (Q-REBUILD1-1 (b), integration rebuild).
//
// Changed from 4a (each was "the person's own whole save sets their automation consent"; now that save keeps it and the
// consent operation sets it):
// - APersonsOwnSaveSetsTheirAutomationConsent became APersonsOwnWholeSaveKeepsTheirAutomationConsent (keeps) plus
//   APersonsConsentOperationSetsTheirAutomationConsent (the same choices through the operation, null included: it follows
//   the administrator's recipe setting).
// - The administrator's own-save case became AnAdministratorsOwnConsentOperationSetsTheirOwnAutomationConsent (an
//   administrator's own whole save keeps it, like everyone's).
// - The concurrency and lock tests: "the person saves their consent" is the consent operation now (it was their whole save).
[Collection("Plugin singleton")]
public class ApiAutomationConsentTests
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
        f.Core.Manager.SaveUserConfiguration(person.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { AutoMovieRequests = consent, AutoSeasonRequests = consent, ShowFileSizes = false });

    [Theory]
    [InlineData(true, false)]
    [InlineData(true, null)]
    [InlineData(null, true)]
    [InlineData(false, true)]
    public void AnAdministratorsSaveOfAnotherPersonsSettingsKeepsTheirAutomationConsent(bool? theirs, bool? sent)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, theirs);

        var answer = Controller(f, Guid.NewGuid(), admin: true).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { AutoMovieRequests = sent, AutoSeasonRequests = sent, ShowFileSizes = true });

        Assert.IsType<OkObjectResult>(answer);
        var stored = Stored(f, person);
        Assert.Equal(theirs, stored.AutoMovieRequests);
        Assert.Equal(theirs, stored.AutoSeasonRequests);
        Assert.True(stored.ShowFileSizes); // the rest of the save stands
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(true, false)]
    [InlineData(true, null)]
    public void APersonsOwnWholeSaveKeepsTheirAutomationConsent(bool? theirs, bool? sent)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, theirs);

        Assert.IsType<OkObjectResult>(Controller(f, person, admin: false).HavingRead(f.Core.Manager, person.ToString("N")).SaveUserSettingsSettings(person.ToString("N"), new JellyfinEnhancedUserSettings { AutoMovieRequests = sent, AutoSeasonRequests = sent, ShowFileSizes = true }));

        Assert.Equal(theirs, Stored(f, person).AutoMovieRequests);
        Assert.Equal(theirs, Stored(f, person).AutoSeasonRequests);
        Assert.True(Stored(f, person).ShowFileSizes); // the rest of the save stands
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(true, false)]
    [InlineData(true, null)]
    [InlineData(false, null)]
    public void APersonsConsentOperationSetsTheirAutomationConsent(bool? theirs, bool? sent)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, theirs);
        var self = Controller(f, person, admin: false);

        Assert.IsType<OkObjectResult>(self.SetUserSettingsConsent(person.ToString("N"), new() { Field = "AutoMovieRequests", Value = sent }));
        Assert.Equal(sent, Stored(f, person).AutoMovieRequests);
        Assert.Equal(theirs, Stored(f, person).AutoSeasonRequests); // one field at a time
        Assert.IsType<OkObjectResult>(self.SetUserSettingsConsent(person.ToString("N"), new() { Field = "AutoSeasonRequests", Value = sent }));
        Assert.Equal(sent, Stored(f, person).AutoSeasonRequests);
        Assert.False(Stored(f, person).ShowFileSizes); // nothing else taken from the caller
    }

    [Theory]
    [InlineData("AutoMovieRequests")]
    [InlineData("AutoSeasonRequests")]
    public void AnAutomationConsentOperationWithoutAValueOrForSomeoneElseChangesNothing(string field)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, true);

        Assert.IsType<BadRequestObjectResult>(Controller(f, person, admin: false).SetUserSettingsConsent(person.ToString("N"), new() { Field = field }));
        Assert.IsType<ForbidResult>(Controller(f, Guid.NewGuid(), admin: true).SetUserSettingsConsent(person.ToString("N"), new() { Field = field, Value = false }));
        Assert.IsType<BadRequestObjectResult>(Controller(f, person, admin: false).SetUserSettingsConsent(person.ToString("N"), new() { Field = field.ToLowerInvariant(), Value = false }));

        Assert.True(Stored(f, person).AutoMovieRequests);
        Assert.True(Stored(f, person).AutoSeasonRequests);
    }

    // An administrator acting on their OWN settings is that person: their consent operation sets it, their whole save keeps it.
    [Fact]
    public void AnAdministratorsOwnConsentOperationSetsTheirOwnAutomationConsent()
    {
        using var f = new ApiPluginFixture();
        var admin = Guid.NewGuid();
        Seed(f, admin, null);
        var self = Controller(f, admin, admin: true);

        Assert.IsType<OkObjectResult>(self.HavingRead(f.Core.Manager, admin.ToString("N")).SaveUserSettingsSettings(admin.ToString("N"), new JellyfinEnhancedUserSettings { AutoMovieRequests = true }));
        Assert.Null(Stored(f, admin).AutoMovieRequests);
        Assert.IsType<OkObjectResult>(self.SetUserSettingsConsent(admin.ToString("N"), new() { Field = "AutoMovieRequests", Value = true }));
        Assert.True(Stored(f, admin).AutoMovieRequests);
    }

    [Fact]
    public void ResettingEveryonesSettingsLeavesEachPersonsAutomationConsent()
    {
        using var f = new ApiPluginFixture();
        var agreed = Guid.NewGuid();
        var refused = Guid.NewGuid();
        var unset = Guid.NewGuid();
        Seed(f, agreed, true);
        Seed(f, refused, false);
        Seed(f, unset, null);

        Assert.IsType<OkObjectResult>(Controller(f, Guid.NewGuid(), admin: true).ResetAllUsersSettings());

        Assert.True(Stored(f, agreed).AutoMovieRequests);
        Assert.False(Stored(f, refused).AutoMovieRequests);
        Assert.Null(Stored(f, unset).AutoMovieRequests);
        Assert.True(Stored(f, agreed).AutoSeasonRequests);
        Assert.False(Stored(f, refused).AutoSeasonRequests);
        Assert.Null(Stored(f, unset).AutoSeasonRequests);
        // The reset itself happened (the seeded preference is back to the default).
        Assert.Equal(f.Plugin.Configuration.ShowFileSizes, Stored(f, agreed).ShowFileSizes);
    }

    // Keeping the consent is atomic with the save (as on 4c1, its review round 4: 4c1-r4-security-2 / behaviour-3). Each
    // case runs the person's own save of their consent while another writer is in the middle of writing their
    // settings.json (it has read what it keeps): the person's save must wait for it and land after it, never be
    // overwritten by it.
    public static IEnumerable<object[]> Writers() => new[] { new object[] { "admin-save" }, new object[] { "reset" }, new object[] { "first-read" } };

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
                // The other writer is saving the person's settings now: the person sets their own consents.
                theirs = Task.Run(() =>
                {
                    var self = Controller(f, person, admin: false);
                    Assert.IsType<OkObjectResult>(self.SetUserSettingsConsent(personN, new() { Field = "AutoMovieRequests", Value = wanted }));
                    return self.SetUserSettingsConsent(personN, new() { Field = "AutoSeasonRequests", Value = wanted });
                });
                landedInside = theirs.Wait(TimeSpan.FromSeconds(1));
            }
        };

        var other = Controller(f, Guid.NewGuid(), admin: true);
        switch (writer)
        {
            case "admin-save":
                Assert.IsType<OkObjectResult>(other.HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { AutoMovieRequests = null, ShowFileSizes = true }));
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
        Assert.Equal(wanted, Stored(f, person).AutoMovieRequests);
        Assert.Equal(wanted, Stored(f, person).AutoSeasonRequests);
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
            case "admin-save":
                admin.HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { ShowFileSizes = true });
                self.HavingRead(f.Core.Manager, personN).SaveUserSettingsSettings(personN, new JellyfinEnhancedUserSettings { ShowFileSizes = true });
                self.SetUserSettingsConsent(personN, new() { Field = "AutoMovieRequests", Value = false });
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
