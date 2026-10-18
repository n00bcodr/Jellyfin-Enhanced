using System.Reflection;
using Jellyfin.Data.Events.Users;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4a review round 8 (4a-security-r8-2): whether a person is a Jellyfin administrator is read from Jellyfin's database
/// (IUserManager.GetUserById has no in-memory cache on 12.2), so it is a gathered fact with a version. Jellyfin's own
/// actions that can take the permission away (Users/{id}/Policy, deleting a user, a sign-in that locks an account out) run
/// inside the person's version bracket, odd from before they run until they returned; Jellyfin's user events move it too.
/// </summary>
public class IntegrationAutomationJellyfinUserTests
{
    private static ActionExecutingContext Context(string controller, string action, Dictionary<string, object?> args)
    {
        var descriptor = new ControllerActionDescriptor
        {
            ActionName = action,
            ControllerName = "User",
            ControllerTypeInfo = (controller == "user" ? typeof(Jellyfin.Api.Controllers.UserController) : typeof(object)).GetTypeInfo(),
        };
        return new ActionExecutingContext(new ActionContext(new DefaultHttpContext(), new RouteData(), descriptor), new List<IFilterMetadata>(), args, new object());
    }

    private static Task<ActionExecutedContext> Done(ActionExecutingContext context)
        => Task.FromResult(new ActionExecutedContext(context, new List<IFilterMetadata>(), new object()) { Result = new NoContentResult() });

    [Theory]
    [InlineData("UpdateUserPolicy")]
    [InlineData("DeleteUser")]
    [InlineData("AuthenticateUser")]
    public async Task JellyfinsUserActionRunsInsideThePersonsBracket(string action)
    {
        var person = Guid.NewGuid();
        var other = Guid.NewGuid();
        var filter = new JellyfinUserChangeBracket(Mock.Of<IUserManager>());
        var context = Context("user", action, new Dictionary<string, object?> { ["userId"] = person });
        var before = JellyfinUserVersions.Sample(person);
        long during = 0;
        await filter.OnActionExecutionAsync(context, () => { during = JellyfinUserVersions.Sample(person); return Done(context); });
        Assert.False(FactVersion.Settled(during));
        var after = JellyfinUserVersions.Sample(person);
        Assert.True(FactVersion.Settled(after));
        Assert.NotEqual(before, after);
        Assert.Equal(0, JellyfinUserVersions.Sample(other));
    }

    // A sign-in by name: the person is looked up by the name given; a failure (here: the action throws) still ends the bracket.
    [Fact]
    public async Task ASignInByNameIsBracketedForThePersonItIsForEvenWhenItThrows()
    {
        var user = new User("someone", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserByName("someone")).Returns(user);
        var filter = new JellyfinUserChangeBracket(users.Object);
        var context = Context("user", "AuthenticateUserByName", new Dictionary<string, object?> { ["request"] = new { Username = "someone", Pw = "x" } });
        var before = JellyfinUserVersions.Sample(user.Id);
        long during = 0;
        await Assert.ThrowsAsync<InvalidOperationException>(() => filter.OnActionExecutionAsync(context, () =>
        {
            during = JellyfinUserVersions.Sample(user.Id);
            throw new InvalidOperationException("locked out");
        }));
        Assert.False(FactVersion.Settled(during));
        Assert.True(FactVersion.Settled(JellyfinUserVersions.Sample(user.Id)));
        Assert.NotEqual(before, JellyfinUserVersions.Sample(user.Id));
    }

    // Anything else passes untouched.
    [Theory]
    [InlineData("user", "UpdateUserConfiguration")]
    [InlineData("other", "UpdateUserPolicy")]
    public async Task OtherActionsAreNotBracketed(string controller, string action)
    {
        var person = Guid.NewGuid();
        var filter = new JellyfinUserChangeBracket(Mock.Of<IUserManager>());
        var context = Context(controller, action, new Dictionary<string, object?> { ["userId"] = person });
        var calls = 0;
        await filter.OnActionExecutionAsync(context, () => { calls++; Assert.True(FactVersion.Settled(JellyfinUserVersions.Sample(person))); return Done(context); });
        Assert.Equal(1, calls);
        Assert.Equal(0, JellyfinUserVersions.Sample(person));
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

    // The production policy's permission version is this one.
    [Fact]
    public void TheRequestPolicysPermissionVersionIsThePersonsJellyfinVersion()
    {
        var person = Guid.NewGuid();
        var policy = (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.IRequestPolicy)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestPolicy));
        Assert.Equal(0, policy.PermissionVersion(person));
        JellyfinUserVersions.Changed(person);
        Assert.Equal(JellyfinUserVersions.Sample(person), policy.PermissionVersion(person));
        Assert.NotEqual(0, policy.PermissionVersion(person));
    }
}
