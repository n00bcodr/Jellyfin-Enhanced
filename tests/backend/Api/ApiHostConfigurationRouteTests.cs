using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 10: the configuration's generation (carried in the document Jellyfin's plugin-configuration route
/// hands out and takes back) moves on with every configuration writer; the route's answer for a refused save is a visible
/// 409, and a save from a page of an earlier JE (a signed-in session: the current configuration page never uses that
/// route) is refused with a reload notice for that session. Per-user document revisions start a new incarnation when the
/// server starts again, so a revision handed out before is spent.
/// </summary>
[Collection("Plugin singleton")]
public class ApiHostConfigurationRouteTests
{
    private static readonly Guid PluginId = Guid.Parse("f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b");

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public void EveryConfigurationWriterMovesTheGenerationOn()
    {
        using var f = new ApiPluginFixture();
        var seen = new List<long> { f.Plugin.Configuration.ConfigurationGeneration };
        void Moved()
        {
            var now = f.Plugin.Configuration.ConfigurationGeneration;
            Assert.True(now > seen[^1], $"generation {now} after {seen[^1]}");
            seen.Add(now);
        }

        f.Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { ["ToastDuration"] = Json("1600") } });
        Moved();
        f.Plugin.SaveConfiguration();
        Moved();
        var current = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        current.ToastDuration = 1700;
        f.Plugin.UpdateConfiguration(current);
        Moved();
        var restored = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        restored.ConfigurationGeneration = 0;
        f.Plugin.RestoreConfiguration(restored, Array.Empty<string>());
        Moved();
        var stale = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        stale.ConfigurationGeneration = seen[1];
        var refused = Assert.Throws<ConfigurationConflictException>(() => f.Plugin.UpdateConfiguration(stale));
        Assert.Equal(seen[^1], refused.Current);
        Assert.Equal(seen[^1], f.Plugin.Configuration.ConfigurationGeneration);
    }

    [Fact]
    public void ThePatchRouteNeverSetsTheGeneration()
    {
        using var f = new ApiPluginFixture();
        var before = f.Plugin.Configuration.ConfigurationGeneration;
        var result = f.Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { ["ConfigurationGeneration"] = Json("999") } });
        Assert.Contains("ConfigurationGeneration", result.Ignored);
        Assert.NotEqual(999, f.Plugin.Configuration.ConfigurationGeneration);
        Assert.True(f.Plugin.Configuration.ConfigurationGeneration >= before);
    }

    private sealed class Route
    {
        public readonly Mock<ISessionManager> Sessions = new();
        public readonly List<(string Session, MessageCommand Command)> Sent = new();
        public readonly string Device = "device-" + Guid.NewGuid().ToString("N");
        public readonly Guid User = Guid.NewGuid();
        public bool Reached;

        public Route()
        {
            var session = new SessionInfo(Sessions.Object, NullLogger.Instance) { Id = "session-" + Device, DeviceId = Device, UserId = User, Client = "Jellyfin Web" };
            Sessions.SetupGet(s => s.Sessions).Returns(new[] { session });
            Sessions.Setup(s => s.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
                .Callback<string, string, MessageCommand, CancellationToken>((_, target, command, _) => Sent.Add((target, command)))
                .Returns(Task.CompletedTask);
        }
    }

    private static int Status(IActionResult? result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        _ => 0,
    };

    // A signed-in page posting JE's whole configuration to Jellyfin's route is an earlier JE configuration page: refused
    // before anything is applied, with a reload notice for its session.
    [Fact]
    public async Task AnEarlierConfigurationPagesSaveIsRefusedWithAReloadNotice()
    {
        using var f = new ApiPluginFixture();
        var route = new Route();
        var applied = false;
        var result = await RunOnRoute(route, PluginId, () => applied = true, apiKey: false);
        Assert.False(route.Reached);
        Assert.False(applied);
        Assert.Equal(409, Status(result));
        Assert.Contains("reload_required", JsonSerializer.Serialize(((ObjectResult)result!).Value), StringComparison.Ordinal);
        var notice = Assert.Single(route.Sent);
        Assert.Equal("session-" + route.Device, notice.Session);
        Assert.Contains("reload", notice.Command.Text, StringComparison.OrdinalIgnoreCase);
    }

    // An API key's whole configuration goes to the plugin, which refuses an earlier generation: a visible 409 (no
    // session, so no notice); a current one is applied. Other plugins' saves pass through untouched.
    [Fact]
    public async Task AnApiKeysStaleSaveIsAVisibleConflictAndACurrentOneIsApplied()
    {
        using var f = new ApiPluginFixture();
        var route = new Route();
        var stale = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        f.Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { ["ToastDuration"] = Json("1600") } });
        stale.ToastDuration = 2000;
        var refused = await RunOnRoute(route, PluginId, () => f.Plugin.UpdateConfiguration(stale));
        Assert.Equal(409, Status(refused));
        Assert.Contains("configuration_conflict", JsonSerializer.Serialize(((ObjectResult)refused!).Value), StringComparison.Ordinal);
        Assert.Equal(1600, f.Plugin.Configuration.ToastDuration);
        Assert.Empty(route.Sent);

        var current = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        current.ToastDuration = 2100;
        Assert.Equal(204, Status(await RunOnRoute(route, PluginId, () => f.Plugin.UpdateConfiguration(current))));
        Assert.Equal(2100, f.Plugin.Configuration.ToastDuration);

        var other = new Route();
        Assert.Equal(204, Status(await RunOnRoute(other, Guid.NewGuid(), () => { }, apiKey: false)));
        Assert.True(other.Reached);
        Assert.Empty(other.Sent);
    }

    // Jellyfin's PluginsController.UpdatePluginConfiguration for a plugin, called by an API key or a signed-in session, through
    // the filter; the action itself runs `action` (the plugin's UpdateConfiguration).
    private static async Task<IActionResult?> RunOnRoute(Route route, Guid plugin, Action action, bool apiKey = true)
    {
        var http = new DefaultHttpContext();
        http.Request.Method = "POST";
        http.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("Jellyfin-UserId", route.User.ToString()), new Claim("Jellyfin-DeviceId", route.Device),
            new Claim("Jellyfin-IsApiKey", apiKey ? "true" : "false"),
        }, "test"));
        var descriptor = new ControllerActionDescriptor { ControllerName = "Plugins", ActionName = "UpdatePluginConfiguration" };
        var context = new ActionContext(http, new RouteData(), descriptor);
        var filters = new List<IFilterMetadata>();
        var executing = new ActionExecutingContext(context, filters, new Dictionary<string, object?> { ["pluginId"] = plugin }, new object());
        ActionExecutedContext? executed = null;
        await new HostConfigurationRouteFilter(route.Sessions.Object).OnActionExecutionAsync(executing, () =>
        {
            route.Reached = true;
            executed = new ActionExecutedContext(context, filters, new object());
            try { action(); executed.Result = new NoContentResult(); }
            catch (Exception ex) { executed.Exception = ex; }
            return Task.FromResult(executed);
        });
        if (executed?.Exception != null && !executed.ExceptionHandled) throw executed.Exception;
        return executing.Result ?? executed?.Result;
    }

    // A restart begins a new incarnation: a revision handed out before it is spent, even for a document nobody changed.
    [Fact]
    public void ARevisionHandedOutBeforeARestartIsSpent()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent { Items = { ["a"] = new HiddenContentItem { ItemId = "a" } } });
        var reader = ApiUserDocumentRevisionTests.Controller(f, person);
        var tag = ApiUserDocumentRevisionTests.ETag(reader, reader.GetUserHiddenContent(id));
        UserConfigurationManager.NewIncarnation();
        var doc = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json");
        doc.Items["b"] = new HiddenContentItem { ItemId = "b" };
        var result = ApiUserDocumentRevisionTests.Controller(f, person, tag).SaveUserHiddenContent(id, doc);
        Assert.Equal(409, ((ObjectResult)result).StatusCode);
        var again = ApiUserDocumentRevisionTests.Controller(f, person);
        Assert.NotEqual(tag, ApiUserDocumentRevisionTests.ETag(again, again.GetUserHiddenContent(id)));
    }
    // A page whose session isn't connected when its write is refused (10.11's web client reconnects only when the tab is
    // shown again after a restart) is told once its session starts again; a session of another device is not.
    [Fact]
    public async Task ARefusedPageWithoutASessionIsToldWhenItsSessionStarts()
    {
        var route = new Route();
        var connected = new List<SessionInfo>();
        route.Sessions.SetupGet(s => s.Sessions).Returns(() => connected.ToArray());
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            using var f = new ApiPluginFixture();
            Assert.Equal(409, Status(await RunOnRoute(route, PluginId, () => { }, apiKey: false)));
            Assert.Empty(route.Sent);
            var other = new SessionInfo(route.Sessions.Object, NullLogger.Instance) { Id = "other", DeviceId = "device-other", UserId = route.User };
            route.Sessions.Raise(s => s.SessionStarted += null, new SessionEventArgs { SessionInfo = other });
            var back = new SessionInfo(route.Sessions.Object, NullLogger.Instance) { Id = "back", DeviceId = route.Device, UserId = route.User };
            connected.Add(back);
            route.Sessions.Raise(s => s.SessionStarted += null, new SessionEventArgs { SessionInfo = back });
            for (var i = 0; i < 100 && route.Sent.Count == 0; i++) await Task.Delay(20);
            var notice = Assert.Single(route.Sent);
            Assert.Equal("back", notice.Session);
            Assert.Contains("reload", notice.Command.Text, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            ClientReloadNotice.DeliveryDelay = previous;
        }
    }
}
