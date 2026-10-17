using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

// A person's list swap-in consent (UserSettings.ListSwapIn) is theirs alone. The legacy settings save replaces the whole
// settings.json and is open to the owner or an administrator, and the administrators' "reset all users" writes defaults
// for everyone: neither may set or clear another person's consent. The person's own save does.
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

    private static UserSettings Stored(ApiPluginFixture f, Guid person) =>
        f.Core.Manager.GetUserConfiguration<UserSettings>(person.ToString("N"), "settings.json");

    private static void Seed(ApiPluginFixture f, Guid person, bool? consent) =>
        f.Core.Manager.SaveUserConfiguration(person.ToString("N"), "settings.json", new UserSettings { ListSwapIn = consent, ShowFileSizes = false });

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

        var answer = Controller(f, Guid.NewGuid(), admin: true).SaveUserSettingsSettings(person.ToString("N"), new UserSettings { ListSwapIn = sent, ShowFileSizes = true });

        Assert.IsType<OkObjectResult>(answer);
        var stored = Stored(f, person);
        Assert.Equal(theirs, stored.ListSwapIn);
        Assert.True(stored.ShowFileSizes); // the rest of the save stands
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(true, false)]
    [InlineData(true, null)]
    public void APersonsOwnSaveSetsTheirSwapInConsent(bool? theirs, bool? sent)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        Seed(f, person, theirs);

        Assert.IsType<OkObjectResult>(Controller(f, person, admin: false).SaveUserSettingsSettings(person.ToString("N"), new UserSettings { ListSwapIn = sent }));

        Assert.Equal(sent, Stored(f, person).ListSwapIn);
    }

    // An administrator saving their OWN settings is that person.
    [Fact]
    public void AnAdministratorsOwnSaveSetsTheirOwnSwapInConsent()
    {
        using var f = new ApiPluginFixture();
        var admin = Guid.NewGuid();
        Seed(f, admin, null);

        Assert.IsType<OkObjectResult>(Controller(f, admin, admin: true).SaveUserSettingsSettings(admin.ToString("N"), new UserSettings { ListSwapIn = true }));

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
}
