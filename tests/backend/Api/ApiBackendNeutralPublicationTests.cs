using System.Reflection;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiBackendNeutralPublicationTests
{
    public static IEnumerable<object[]> BootstrapCases()
    {
        foreach (var version in new[] { 0, 1 }) foreach (var admin in new[] { false, true })
            foreach (var state in new[] { "blank", "dormant", "enabled" }) yield return [version, admin, state];
    }
    private sealed class Trap : IHttpClientFactory
    {
        internal int Calls;
        public HttpClient CreateClient(string name) { Calls++; throw new InvalidOperationException("Unexpected Seerr HTTP"); }
    }
    private static async Task<IActionResult> Filter(ApiPluginFixture fixture, JellyfinEnhancedController controller, Func<Task<IActionResult>> action)
    {
        var descriptor = new ControllerActionDescriptor
        {
            ControllerTypeInfo = typeof(JellyfinEnhancedController).GetTypeInfo(),
            MethodInfo = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.GetBootstrap))!
        };
        var context = new ActionExecutingContext(new(controller.HttpContext, new RouteData(), descriptor), [], new Dictionary<string, object?>(), controller);
        ActionExecutedContext? executed = null;
        var filter = new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, fixture.Core.Logger);
        await filter.OnActionExecutionAsync(context, async () => executed = new(context, [], controller) { Result = await action() });
        return (executed?.Result ?? context.Result)!;
    }

    [Theory]
    [MemberData(nameof(BootstrapCases))]
    public async Task FreshNeutralBootstrapThroughTheGlobalFilterRemainsSuccessfulWithoutSeerrHttp(int version, bool admin, string state)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = version;
        config.JellyseerrEnabled = state == "enabled";
        config.JellyseerrUrls = state == "blank" ? "" : FakeSeerr.Url;
        config.JellyseerrApiKey = state == "blank" ? "" : FakeSeerr.Key;
        var users = Mock.Of<IUserManager>();
        var maintenance = new MaintenanceModeService(users, Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var trap = new Trap();
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance, fixture.Core.Manager, users, trap);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        var result = await Filter(fixture, controller, () => Task.FromResult<IActionResult>(controller.GetBootstrap()));
        Assert.Equal(200, Assert.IsType<JsonResult>(result).StatusCode ?? 200);
        Assert.Equal(0, trap.Calls);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public void RefusedOptionalPublicationDoesNotEnlistButCannotErasePriorActualDependencies(bool consumed)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration; config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "seerr";
        using var publication = SeerrFacts.BeginPublication();
        var epoch = EffectiveRequestsBackend.Shared.Current.Epoch;
        if (consumed) Assert.Equal("admitted", SeerrFacts.PublishSeerr(epoch, () => "admitted"));
        config.ArrRequestBackend = "je";
        Assert.False(SeerrFacts.TryPublishSeerr(epoch, () => throw new InvalidOperationException("must not run")));
        Assert.Throws<BackendDisabledException>(() => SeerrFacts.PublishSeerr(epoch, () => "refused"));
        if (consumed) Assert.Throws<BackendDisabledException>(() => publication.Publish(() => "neutral"));
        else Assert.Equal("neutral", publication.Publish(() => "neutral"));
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task GlobalFilterRetainsActualOldFactsWhenAnOptionalLaterReadIsRefused(bool actual)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration; config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "seerr";
        var controller = ApiAssetTests.Controller(fixture.Core);
        var epoch = EffectiveRequestsBackend.Shared.Current.Epoch;
        var result = await Filter(fixture, controller, async () =>
        {
            if (actual) SeerrFacts.PublishSeerr(epoch, () => "real-fact");
            await EffectiveRequestsBackend.Shared.TransitionAsync(() => config.ArrRequestBackend = "je", default);
            Assert.False(SeerrFacts.TryPublishSeerr(epoch, () => { }));
            return new JsonResult(new { local = true });
        });
        if (actual) Assert.Equal(409, Assert.IsType<ObjectResult>(result).StatusCode);
        else Assert.IsType<JsonResult>(result);
    }

    [Fact]
    public async Task InterruptedOptionalEffectReturnsFalseAndReleasesTheTransitionDrain()
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration; config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "seerr";
        var epoch = EffectiveRequestsBackend.Shared.Current.Epoch;
        Task transition = Task.CompletedTask;
        var error = Record.Exception(() => Assert.False(SeerrFacts.TryPublishSeerr(epoch, () =>
        {
            // A real transition interrupts the admitted callback; the nonthrowing optional API stays nonthrowing.
            transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => config.ArrRequestBackend = "je", default);
            throw new OperationCanceledException();
        })));
        await transition.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(error);
        Assert.Equal("je", config.ArrRequestBackend);
        config.ArrRequestBackend = "seerr";
        var fresh = EffectiveRequestsBackend.Shared.Current.Epoch;
        Assert.Throws<OperationCanceledException>(() => SeerrFacts.TryPublishSeerr(fresh, () => throw new OperationCanceledException()));
    }

    [Theory]
    [InlineData("unchanged")][InlineData("adopt")][InlineData("roundtrip")]
    public async Task JeMetadataPublicationUsesTheCapturedEffectiveEpochWithSubmissionsOff(string change)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration; config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "je";
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = false;
        using var outer = SeerrFacts.BeginPublication();
        SeerrFacts.Derived<string> cached;
        using (var read = SeerrFacts.BeginPublication())
        {
            read.EnlistEffective(EffectiveRequestsBackend.Shared.Current);
            cached = SeerrFacts.Remember("JE-only metadata");
        }
        if (change != "unchanged") await EffectiveRequestsBackend.Shared.TransitionAsync(() => config.ArrRequestBackend = "status_only", default);
        if (change == "roundtrip") await EffectiveRequestsBackend.Shared.TransitionAsync(() => config.ArrRequestBackend = "je", default);
        if (change == "unchanged")
        {
            Assert.Equal("JE-only metadata", cached.Publish());
            Assert.Equal("composed", outer.Publish(() => "composed"));
        }
        else
        {
            Assert.Throws<BackendDisabledException>(() => cached.Publish());
            Assert.Throws<BackendDisabledException>(() => outer.Publish(() => "withheld"));
        }
    }
}
