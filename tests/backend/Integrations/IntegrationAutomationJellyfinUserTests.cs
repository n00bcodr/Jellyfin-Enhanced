using Jellyfin.Data.Events.Users;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Api.Controllers;

namespace JE.Tests;

/// <summary>
/// 4a review round 8 (4a-security-r8-2): whether a person is a Jellyfin administrator is read from Jellyfin's database
/// (IUserManager.GetUserById has no in-memory cache on 12.2), so it is a gathered fact with a version. Round 9
/// (4a-security-r9-1): every Jellyfin action that can change or authenticate a user runs inside that version's bracket,
/// odd from before it runs until it returned: the person's when the action names them (or they are signed in), else
/// every person's. Jellyfin's user events move it too. The actions here are stand-ins with Jellyfin's names and
/// parameters; IntegrationJellyfinApiUserActionTests runs Jellyfin's own.
/// </summary>
[Collection("Jellyfin user versions")]
public class IntegrationAutomationJellyfinUserTests
{
    [Theory]
    [InlineData("UpdateUserPolicy")]
    [InlineData("DeleteUser")]
    [InlineData("AuthenticateUser")]
    [InlineData("UpdateUserPassword")]
    [InlineData("UpdateUserPasswordLegacy")]
    [InlineData("UpdateUserConfiguration")]
    public async Task JellyfinsUserActionRunsInsideThePersonsBracket(string action)
    {
        var person = Guid.NewGuid();
        var other = Guid.NewGuid();
        var context = JellyfinUserBracketHarness.Context<UserController>(action, new Dictionary<string, object?> { ["userId"] = person });
        var before = JellyfinUserVersions.Sample(person);
        var untouched = JellyfinUserVersions.Sample(other);
        Assert.Equal("user", await JellyfinUserBracketHarness.Observe(context, person, other));
        var after = JellyfinUserVersions.Sample(person);
        Assert.True(FactVersion.Settled(after));
        Assert.NotEqual(before, after);
        Assert.Equal(untouched, JellyfinUserVersions.Sample(other));
    }

    // A sign-in by name: the person isn't known before Jellyfin looks them up, so every person's version is bracketed
    // (round 8 looked the name up first, a database query on every sign-in). A failure (here: the action throws) still
    // ends the bracket.
    [Fact]
    public async Task ASignInByNameIsBracketedForEveryoneEvenWhenItThrows()
    {
        var person = Guid.NewGuid();
        var context = JellyfinUserBracketHarness.Context<UserController>("AuthenticateUserByName", new Dictionary<string, object?> { ["request"] = new { Username = "someone", Pw = "x" } });
        var before = JellyfinUserVersions.Sample(person);
        long during = 0;
        await Assert.ThrowsAsync<InvalidOperationException>(() => JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, () =>
        {
            during = JellyfinUserVersions.Sample(person);
            throw new InvalidOperationException("locked out");
        }));
        Assert.False(FactVersion.Settled(during));
        Assert.True(FactVersion.Settled(JellyfinUserVersions.Sample(person)));
        Assert.NotEqual(before, JellyfinUserVersions.Sample(person));
    }

    // Actions whose person isn't known before they run bracket everyone; an omitted userId is the signed-in person.
    [Theory]
    [InlineData("CreateUserByName", false, "global")]
    [InlineData("AuthenticateWithQuickConnect", false, "global")]
    [InlineData("UpdateUserPassword", true, "user")]
    [InlineData("UpdateUserPassword", false, "global")]
    public async Task APersonNotNamedIsTheSignedInOneElseEveryone(string action, bool signedIn, string expected)
    {
        var person = Guid.NewGuid();
        var context = JellyfinUserBracketHarness.Context<UserController>(action, new Dictionary<string, object?>(), signedIn ? person : null);
        Assert.Equal(expected, await JellyfinUserBracketHarness.Observe(context, person, Guid.NewGuid()));
    }

    [Fact]
    public async Task QuickConnectAndTheStartupWizardAreBracketed()
    {
        var person = Guid.NewGuid();
        Assert.Equal("user", await JellyfinUserBracketHarness.Observe(JellyfinUserBracketHarness.Context<QuickConnectController>("AuthorizeQuickConnect", new Dictionary<string, object?> { ["code"] = "123456", ["userId"] = person }), person, Guid.NewGuid()));
        Assert.Equal("global", await JellyfinUserBracketHarness.Observe(JellyfinUserBracketHarness.Context<StartupController>("UpdateStartupUser", new Dictionary<string, object?>()), person, Guid.NewGuid()));
    }

    // Anything else passes untouched: a GET of the user controller, and another controller's action whose code reaches
    // no user change (it has a userId, but that doesn't make it a user change).
    [Theory]
    [InlineData("user", "GetUsers")]
    [InlineData("quickconnect", "GetQuickConnectEnabled")]
    [InlineData("items", "UpdateItem")]
    public async Task OtherActionsAreNotBracketed(string controller, string action)
    {
        var person = Guid.NewGuid();
        var args = new Dictionary<string, object?> { ["userId"] = person };
        var context = controller switch
        {
            "user" => JellyfinUserBracketHarness.Context<UserController>(action, args),
            "quickconnect" => JellyfinUserBracketHarness.Context<QuickConnectController>(action, args),
            _ => JellyfinUserBracketHarness.Context<ItemsController>(action, args),
        };
        var before = JellyfinUserVersions.Sample(person);
        Assert.Equal("none", await JellyfinUserBracketHarness.Observe(context, person, Guid.NewGuid()));
        Assert.Equal(before, JellyfinUserVersions.Sample(person));
    }

    // No lock is held across the action: two of them for the same person run at once (each inside the bracket), and the
    // version is settled only once both returned.
    [Fact]
    public async Task TwoActionsForThePersonRunAtOnceWithoutALock()
    {
        var person = Guid.NewGuid();
        using var bothIn = new CountdownEvent(2);
        using var release = new ManualResetEventSlim();
        Task Run() => Task.Run(() =>
        {
            var context = JellyfinUserBracketHarness.Context<UserController>("UpdateUserPolicy", new Dictionary<string, object?> { ["userId"] = person });
            return JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, () =>
            {
                bothIn.Signal();
                release.Wait(TimeSpan.FromSeconds(20));
                return JellyfinUserBracketHarness.Done(context);
            });
        });
        var one = Run();
        var two = Run();
        Assert.True(bothIn.Wait(TimeSpan.FromSeconds(10)), "both actions run at once");
        Assert.False(FactVersion.Settled(JellyfinUserVersions.Sample(person)));
        release.Set();
        await Task.WhenAll(one, two);
        Assert.True(FactVersion.Settled(JellyfinUserVersions.Sample(person)));
    }

    // Jellyfin's user events (changes made outside those actions) move the version too.
    [Fact]
    public async Task JellyfinsUserEventsMoveThePersonsVersion()
    {
        var user = new User("someone", "default", "default") { Id = Guid.NewGuid() };
        var consumer = new JellyfinUserChangeVersion();
        var start = JellyfinUserVersions.Sample(user.Id);
        await consumer.OnEvent(new UserUpdatedEventArgs(user));
        var updated = JellyfinUserVersions.Sample(user.Id);
        await consumer.OnEvent(new UserLockedOutEventArgs(user));
        var locked = JellyfinUserVersions.Sample(user.Id);
        await consumer.OnEvent(new UserDeletedEventArgs(user));
        var deleted = JellyfinUserVersions.Sample(user.Id);
        Assert.True(start < updated && updated < locked && locked < deleted);
        Assert.True(FactVersion.Settled(deleted));
    }

    // The production policy's permission version is this one, every person's included.
    [Fact]
    public async Task TheRequestPolicysPermissionVersionIsThePersonsJellyfinVersion()
    {
        var person = Guid.NewGuid();
        var policy = (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.IRequestPolicy)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestPolicy));
        var start = policy.PermissionVersion(person);
        JellyfinUserVersions.Changed(person);
        Assert.Equal(JellyfinUserVersions.Sample(person), policy.PermissionVersion(person));
        Assert.NotEqual(start, policy.PermissionVersion(person));
        var mine = policy.PermissionVersion(person);
        await JellyfinUserVersions.MutateAll(() => Task.CompletedTask);
        Assert.NotEqual(mine, policy.PermissionVersion(person));
        Assert.True(FactVersion.Settled(policy.PermissionVersion(person)));
    }
}
