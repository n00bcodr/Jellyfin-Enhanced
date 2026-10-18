using System.Reflection;
using System.Reflection.Emit;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Users;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests
{
    /// <summary>
    /// 4a review round 9: how the bracket filter tells which actions can change or authenticate a user
    /// (<see cref="JellyfinUserActions"/>): from the code of the assembly that defines them, so an action Jellyfin (or a
    /// plugin) adds is bracketed without a change in JE.
    /// </summary>
    [Collection("Jellyfin user versions")]
    public class IntegrationJellyfinUserActionScanTests
    {
        // Bracketed for their controller alone: their code reaches no user change (a Quick Connect code, the wizard's
        // settings; 10.11's easy password only answers 403).
        private static readonly HashSet<string> ControllerOnly = new(StringComparer.Ordinal)
        {
            "QuickConnectController.InitiateQuickConnect", "StartupController.CompleteWizard", "StartupController.UpdateInitialConfiguration", "StartupController.SetRemoteAccess",
            "UserController.UpdateUserEasyPassword",
        };

        // The code alone finds every user-changing action of Jellyfin's own assembly: the controller rule is a second net.
        [Fact]
        public void JellyfinsUserChangesAreFoundInTheirCode()
        {
            using var api = JellyfinApiAssembly.Load();
            var scanned = JellyfinUserActions.Scan(api.Path);
            var bracketed = scanned.Where(a => a.Key != JellyfinUserKey.None).ToList();
            Assert.NotEmpty(bracketed);
            var problems = bracketed.Where(a => a.Reaches == null && !ControllerOnly.Contains(a.Controller + "." + a.Action)).Select(a => a.Controller + "." + a.Action + ": bracketed (" + a.Why + ") but its code reaches no user change").ToList();
            // The password change reaches the sign-in that can lock the account out, and the policy change its update.
            Assert.Contains(scanned, a => a is { Controller: "UserController", Action: "UpdateUserPassword", Reaches: "IUserManager.ResetPassword" or "IUserManager.AuthenticateUser" or "IUserManager.ChangePassword" });
            Assert.Contains(scanned, a => a is { Controller: "UserController", Action: "AuthenticateUserByName", Reaches: "ISessionManager.AuthenticateNewSession" });
            // GET actions don't change users, except the wizard's first-user read, which creates them.
            problems.AddRange(scanned.Where(a => a.Reaches != null && a.Verbs.All(v => v is "GET" or "HEAD") && a.Action != "GetFirstUser").Select(a => a.Controller + "." + a.Action + ": a GET that reaches " + a.Reaches));
            if (problems.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", problems));
        }

        // Reading the assembly is a one-time cost per process, done in the background before the first request.
        [Fact]
        public void ReadingJellyfinsAssemblyIsCheap()
        {
            using var api = JellyfinApiAssembly.Load();
            var timer = System.Diagnostics.Stopwatch.StartNew();
            Assert.True(JellyfinUserActions.Scan(api.Path).Count > 300);
            Assert.True(timer.Elapsed < TimeSpan.FromSeconds(5), "read in " + timer.Elapsed);
        }

        // Deny by default: a member of IUserManager this JE doesn't know (a Jellyfin update) counts as a change; only the
        // reviewed reads don't.
        [Theory]
        [InlineData("MediaBrowser.Controller.Library.IUserManager", "UpdatePolicyAsync", true)]
        [InlineData("MediaBrowser.Controller.Library.IUserManager", "LockOutAsync", true)]
        [InlineData("MediaBrowser.Controller.Library.IUserManager", "AuthenticateUser", true)]
        [InlineData("MediaBrowser.Controller.Library.IUserManager", "GetUserById", false)]
        [InlineData("MediaBrowser.Controller.Library.IUserManager", "get_Users", false)]
        [InlineData("MediaBrowser.Controller.Session.ISessionManager", "AuthenticateNewSession", true)]
        [InlineData("MediaBrowser.Controller.Session.ISessionManager", "ReportPlaybackProgress", false)]
        [InlineData("MediaBrowser.Controller.QuickConnect.IQuickConnect", "AuthorizeRequest", true)]
        [InlineData("MediaBrowser.Controller.QuickConnect.IQuickConnect", "TryConnect", false)]
        [InlineData("Jellyfin.Database.Implementations.Entities.User", "SetPermission", true)]
        [InlineData("Jellyfin.Database.Implementations.Entities.User", "set_MaxActiveSessions", true)]
        [InlineData("Jellyfin.Database.Implementations.Entities.User", "HasPermission", false)]
        [InlineData("MediaBrowser.Controller.Library.ILibraryManager", "DeleteItem", false)]
        public void WhatCountsAsAUserChange(string type, string member, bool changes) => Assert.Equal(changes, JellyfinUserActions.Mutates(type, member));

        // A plugin's controller: its action changes a user through a helper and a lambda, never named "User": its code
        // shows it, so it is bracketed (the person of its userId argument).
        [Fact]
        public async Task APluginControllerThatChangesAUserThroughAHelperIsBracketed()
        {
            var person = Guid.NewGuid();
            var args = new Dictionary<string, object?> { ["userId"] = person };
            Assert.Equal("user", await JellyfinUserBracketHarness.Observe(JellyfinUserBracketHarness.Context<StandIns.MembershipController>("Promote", args), person, Guid.NewGuid()));
            Assert.Equal("global", await JellyfinUserBracketHarness.Observe(JellyfinUserBracketHarness.Context<StandIns.MembershipController>("LogOn", new Dictionary<string, object?>()), person, Guid.NewGuid()));
            Assert.Equal("none", await JellyfinUserBracketHarness.Observe(JellyfinUserBracketHarness.Context<StandIns.MembershipController>("Ping", args), person, Guid.NewGuid()));
        }

        // JE's own actions (maintenance mode's, the bootstrap that can end an expired window) bracket their user changes
        // themselves, keyed by the user (the writer scan holds them to it), so the filter leaves them alone.
        [Theory]
        [InlineData("EnableMaintenanceMode", "POST")]
        [InlineData("GetBootstrap", "GET")]
        public void JesOwnActionsAreLeftToTheBracketsInsideThem(string action, string verb)
        {
            var controller = typeof(Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController);
            Assert.Contains(JellyfinUserActions.Scan(controller.Assembly.Location), a => a.Action == action && a.Reaches == "IUserManager.UpdatePolicyAsync");
            Assert.Equal(JellyfinUserKey.None, JellyfinUserActions.KeyOf(controller.GetMethod(action)!, controller.Name, verb));
        }

        // An assembly whose code can't be read (here: one made in memory): every request but a GET is bracketed, for everyone.
        [Theory]
        [InlineData("POST", JellyfinUserKey.Global)]
        [InlineData("DELETE", JellyfinUserKey.Global)]
        [InlineData("GET", JellyfinUserKey.None)]
        public void AnAssemblyThatCantBeReadBracketsEveryChange(string verb, JellyfinUserKey expected)
        {
            var assembly = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("Unreadable"), AssemblyBuilderAccess.Run);
            var type = assembly.DefineDynamicModule("Unreadable").DefineType("UnreadableController", TypeAttributes.Public, typeof(ControllerBase));
            type.DefineMethod("Act", MethodAttributes.Public, typeof(void), Type.EmptyTypes).GetILGenerator().Emit(OpCodes.Ret);
            var method = type.CreateType().GetMethod("Act")!;
            Assert.Equal(expected, JellyfinUserActions.KeyOf(method, "UnreadableController", verb));
        }

        [Fact]
        public void CombinedVersionsAreUnsettledWhileEitherIsAndMoveWithEither()
        {
            Assert.Equal(6, FactVersion.Combine(2, 4));
            Assert.Equal(-1, FactVersion.Combine(3, 4));
            Assert.Equal(-1, FactVersion.Combine(2, (1L << 40) + 2));
            Assert.False(FactVersion.Settled(FactVersion.Combine(2, 5)));
            Assert.NotEqual(FactVersion.Combine(2, 4), FactVersion.Combine(4, 4));
            Assert.NotEqual(FactVersion.Combine(2, 4), FactVersion.Combine(2, 6));
        }
    }
}

namespace JE.Tests.StandIns
{
    /// <summary>A plugin's controller (not Jellyfin's): only its code says it changes users.</summary>
    public sealed class MembershipController : ControllerBase
    {
        private readonly IUserManager _users = null!;

        [HttpPost("{userId}/Promote")]
        public async Task<ActionResult> Promote(Guid userId)
        {
            await Apply(userId, policy => policy.IsAdministrator = true);
            return NoContent();
        }

        [HttpPost("LogOn")]
        public async Task<ActionResult> LogOn(string name, string password)
            => await _users.AuthenticateUser(name, password, "127.0.0.1", true) == null ? Unauthorized() : NoContent();

        [HttpPost("{userId}/Ping")]
        public ActionResult Ping(Guid userId) => NoContent();

        private Task Apply(Guid userId, Action<UserPolicy> change)
        {
            var policy = new UserPolicy();
            change(policy);
            return Task.Run(() => _users.UpdatePolicyAsync(userId, policy));
        }
    }
}
