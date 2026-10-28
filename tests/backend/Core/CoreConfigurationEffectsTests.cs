using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.Users;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json;
using EnhancedPlugin = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 12: the configuration's runtime effects follow the configuration the server holds now, reconciled by
/// one server owner (RBS1-R12-4). Administrator A stored Enable and its answer waited; B stored Disable and maintenance was
/// turned off; A's late answer then turned it back on from the snapshot it carried (the configuration lock ordered the
/// configuration, not the later effects of an old page). Now every configuration change asks the one owner
/// (ConfigurationEffects) to reconcile from the current generation; it runs one reconcile at a time and checks the
/// generation again before each user is changed, so an older Enable can never land after a newer Disable completed. The
/// Custom Tabs entries Jellyfin Enhanced manages are synced by the same owner from the current intent and ownership.
/// </summary>
[Collection("Plugin singleton")]
public class CoreConfigurationEffectsTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Api { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<ISessionManager> Sessions { get; } = new();
        public User Admin { get; } = Make("admin");
        public User Alice { get; } = Make("alice");
        public User Bob { get; } = Make("bob");
        public Dictionary<Guid, UserPolicy> Policies { get; } = new();
        /// <summary>Every policy write, in order (who, disabled, remote access).</summary>
        public List<(Guid User, bool Disabled, bool Remote)> PolicyWrites { get; } = new();
        public MaintenanceModeService Maintenance { get; }
        public Mock<IPluginManager> PluginManager { get; } = new();
        public List<SessionInfo> SessionList { get; } = new();
        public int Broadcasts;
        public ConfigurationEffects Effects { get; }

        public Fixture()
        {
            Admin.SetPermission(PermissionKind.IsAdministrator, true);
            var all = new[] { Admin, Alice, Bob };
#if NET9_0
            Users.SetupGet(x => x.Users).Returns(all);
#else
            Users.Setup(x => x.GetUsers()).Returns(all);
#endif
            foreach (var user in all)
            {
                Policies[user.Id] = new UserPolicy { IsDisabled = false, EnableRemoteAccess = true };
                Users.Setup(x => x.GetUserById(user.Id)).Returns(user);
                Users.Setup(x => x.GetUserDto(user, It.IsAny<string>())).Returns(() => new UserDto { Id = user.Id, Policy = Clone(Policies[user.Id]) });
            }
            Users.Setup(x => x.UpdatePolicyAsync(It.IsAny<Guid>(), It.IsAny<UserPolicy>()))
                .Callback<Guid, UserPolicy>((id, policy) => { Policies[id] = Clone(policy); lock (PolicyWrites) PolicyWrites.Add((id, policy.IsDisabled, policy.EnableRemoteAccess)); }).Returns(Task.CompletedTask);
            Sessions.SetupGet(x => x.Sessions).Returns(() => SessionList.ToArray());
            Sessions.Setup(x => x.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
                .Returns(() => { Interlocked.Increment(ref Broadcasts); return Task.CompletedTask; });
            PluginManager.SetupGet(x => x.Plugins).Returns(Array.Empty<LocalPlugin>());
            Maintenance = new MaintenanceModeService(Users.Object, Sessions.Object, Api.Core.Paths.Object, Api.Core.Logger);
            Effects = new ConfigurationEffects(Maintenance, PluginManager.Object, Api.Core.Logger);
            Effects.StartAsync(CancellationToken.None).GetAwaiter().GetResult();
        }

        private static User Make(string name) => new(name, "default", "default") { Id = Guid.NewGuid() };
        public static UserPolicy Clone(UserPolicy policy) => JsonConvert.DeserializeObject<UserPolicy>(JsonConvert.SerializeObject(policy))!;
        public EnhancedPlugin Plugin => Api.Plugin;
        public long Generation => Plugin.Configuration.ConfigurationGeneration;

        public void Patch(string field, string raw) => Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { [field] = Json(raw) } });

        /// <summary>Waits for every reconcile asked for so far.</summary>
        public Task<ConfigurationEffectsOutcome> Settled() => Effects.ReconcileAsync(Generation, TimeSpan.FromSeconds(10));

        public void Dispose()
        {
            Effects.StopAsync(CancellationToken.None).GetAwaiter().GetResult();
            Api.Dispose();
        }
    }

    [Fact]
    public async Task AnOlderEnableCannotLandAfterANewerDisableCompleted()
    {
        using var f = new Fixture();
        await f.Settled();
        // A's Enable is being applied: its first user's policy write is held.
        var held = new TaskCompletionSource();
        var reached = new TaskCompletionSource();
        f.Users.Setup(x => x.UpdatePolicyAsync(f.Alice.Id, It.IsAny<UserPolicy>())).Returns<Guid, UserPolicy>(async (id, policy) =>
        {
            reached.TrySetResult();
            await held.Task;
            f.Policies[id] = Fixture.Clone(policy);
        });
        f.Patch("MaintenanceModeAction", "\"disable_accounts\"");
        f.Patch("MaintenanceModeEnabled", "true");
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // B stores Disable while A's effect is still out.
        f.Patch("MaintenanceModeEnabled", "false");
        held.SetResult();
        var outcome = await f.Settled();
        Assert.Equal("applied", outcome.Maintenance);
        Assert.False(f.Plugin.Configuration.MaintenanceModeEnabled);
        Assert.False(f.Maintenance.GetStatus().IsActive, "maintenance stays off: the newer configuration's");
        Assert.False(f.Policies[f.Alice.Id].IsDisabled, "the user A's pass changed is restored");
        Assert.False(f.Policies[f.Bob.Id].IsDisabled, "a user after the stopped pass is never changed");
        Assert.DoesNotContain(f.PolicyWrites, w => w.User == f.Bob.Id && w.Disabled);
        Assert.Equal(0, f.Broadcasts);
    }

    [Fact]
    public async Task AConfigurationReplacedAfterTheLastAccountChangeIsTheOneThatOpensAndAnnouncesTheWindow()
    {
        using var f = new Fixture();
        f.SessionList.Add(new SessionInfo(f.Sessions.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance) { Id = "s1", DeviceId = "d1", UserId = f.Alice.Id, UserName = "alice" });
        await f.Settled();
        // A's Enable is applied up to its last user (Bob), whose policy write is held; B stores a newer Enable (another
        // message) meanwhile. A's pass must end without opening the window: B's own pass opens it, and announces it once.
        var bobHeld = new TaskCompletionSource();
        var bobReached = new TaskCompletionSource();
        var bobCalls = 0;
        f.Users.Setup(x => x.UpdatePolicyAsync(It.IsAny<Guid>(), It.IsAny<UserPolicy>())).Returns<Guid, UserPolicy>(async (id, policy) =>
        {
            if (id == f.Bob.Id && Interlocked.Increment(ref bobCalls) == 1) { bobReached.TrySetResult(); await bobHeld.Task; }
            f.Policies[id] = Fixture.Clone(policy);
        });
        f.Patch("MaintenanceModeAction", "\"disable_accounts\"");
        f.Patch("MaintenanceModeMessage", "\"A's window\"");
        f.Patch("MaintenanceModeEnabled", "true");
        await bobReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Patch("MaintenanceModeMessage", "\"B's window\"");
        bobHeld.SetResult();
        await f.Settled();
        var status = f.Maintenance.GetStatus();
        Assert.True(status.IsActive);
        Assert.Equal("B's window", status.Message);
        Assert.Equal(1, f.Broadcasts);
    }

    [Fact]
    public async Task AWindowOpenedByAConfigurationIsAnnouncedOnceAndFollowsItsSettings()
    {
        using var f = new Fixture();
        var session = new SessionInfo(f.Sessions.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance) { Id = "s1", DeviceId = "d1", UserId = f.Alice.Id, UserName = "alice" };
        f.SessionList.Add(session);
        f.Patch("MaintenanceModeAction", "\"disable_remote\"");
        f.Patch("MaintenanceModeDurationMinutes", "30");
        f.Patch("MaintenanceModeEnabled", "true");
        await f.Settled();
        var state = f.Maintenance.GetStatus();
        Assert.True(state.IsActive);
        Assert.Equal("disable_remote", state.Action);
        Assert.False(f.Policies[f.Alice.Id].EnableRemoteAccess);
        Assert.Equal(1, f.Broadcasts);
        var endsAt = state.EndsAt;
        Assert.NotNull(endsAt);
        // An unrelated save: the same window, its clock kept, nobody told again.
        f.Patch("ToastDuration", "2222");
        await f.Settled();
        Assert.Equal(endsAt, f.Maintenance.GetStatus().EndsAt);
        Assert.Equal(1, f.Broadcasts);
        // Off again: the users are restored.
        f.Patch("MaintenanceModeEnabled", "false");
        await f.Settled();
        Assert.False(f.Maintenance.GetStatus().IsActive);
        Assert.True(f.Policies[f.Alice.Id].EnableRemoteAccess);
    }

    [Fact]
    public async Task ManualOffLeavesAScheduledWindowRunningWhileTheScheduleIsOn()
    {
        using var f = new Fixture();
        await f.Maintenance.EnableScheduledAsync("nightly", null, "none", null, DateTime.UtcNow.AddHours(1));
        f.Patch("MaintenanceScheduleEnabled", "true");
        await f.Settled();
        Assert.True(f.Maintenance.GetStatus().IsActive, "the schedule's window keeps running");
        f.Patch("MaintenanceScheduleEnabled", "false");
        await f.Settled();
        Assert.False(f.Maintenance.GetStatus().IsActive, "with the schedule off, nothing stays active");
    }

    [Fact]
    public async Task AFieldWriterAsksForAReconcileOnlyWhenItChangesWhatTheEffectsFollow()
    {
        using var f = new Fixture();
        await f.Settled();
        var requested = typeof(ConfigurationEffects).GetField("_requested", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var before = (long)requested.GetValue(f.Effects)!;
        f.Plugin.MutateConfiguration(cfg => { cfg.ClearTranslationCacheTimestamp = 42; return true; });
        Assert.Equal(before, (long)requested.GetValue(f.Effects)!);
        f.Plugin.MutateConfiguration(cfg => { cfg.MaintenanceModeEnabled = true; return true; });
        Assert.Equal(before + 1, (long)requested.GetValue(f.Effects)!);
        await f.Settled();
        Assert.True(f.Maintenance.GetStatus().IsActive);
    }

    [Fact]
    public async Task ARestoredConfigurationTakesEffectFromTheServer()
    {
        using var f = new Fixture();
        await f.Settled();
        var restored = ConfigurationPatcher.Clone(f.Plugin.Configuration);
        restored.MaintenanceModeEnabled = true;
        restored.MaintenanceModeAction = "none";
        var apply = typeof(EnhancedPlugin).GetMethod("ApplyConfiguration", BindingFlags.Instance | BindingFlags.NonPublic)!;
        apply.Invoke(f.Plugin, new object[] { (Func<PluginConfiguration?, MediaBrowser.Model.Plugins.BasePluginConfiguration>)(_ => restored), false, false });
        // Nobody asks: the restore itself starts the reconcile (waited for passively, bounded).
        for (var i = 0; i < 100 && !f.Maintenance.GetStatus().IsActive; i++) await Task.Delay(50);
        Assert.True(f.Maintenance.GetStatus().IsActive);
    }

    [Fact]
    public async Task ThePagesConfirmationIsRefusedForAnOlderGenerationAndWaitsForTheCurrentOne()
    {
        using var f = new Fixture();
        f.Patch("MaintenanceModeAction", "\"none\"");
        f.Patch("MaintenanceModeEnabled", "true");
        var enabledAt = f.Generation;
        f.Patch("MaintenanceModeEnabled", "false");
        var controller = (JellyfinEnhancedController)RuntimeHelpers.GetUninitializedObject(typeof(JellyfinEnhancedController));
        var confirm = typeof(JellyfinEnhancedController).GetMethod("ConfirmConfigurationEffects", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var stale = await (Task<IActionResult>)confirm.Invoke(controller, new object?[] { enabledAt, true })!;
        Assert.Equal(409, Assert.IsType<ObjectResult>(stale).StatusCode);
        var wrongVerb = await (Task<IActionResult>)confirm.Invoke(controller, new object?[] { f.Generation, true })!;
        Assert.Equal(409, Assert.IsType<ObjectResult>(wrongVerb).StatusCode);
        var current = await (Task<IActionResult>)confirm.Invoke(controller, new object?[] { f.Generation, false })!;
        Assert.IsType<OkObjectResult>(current);
        Assert.False(f.Maintenance.GetStatus().IsActive);
    }

    private static JellyfinEnhancedController ControllerFor(Fixture f, bool apiKey)
    {
        var controller = (JellyfinEnhancedController)RuntimeHelpers.GetUninitializedObject(typeof(JellyfinEnhancedController));
        void Set(string field, object value) => typeof(JellyfinEnhancedController).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(controller, value);
        Set("_sessionManager", f.Sessions.Object);
        Set("_logger", f.Api.Core.Logger);
        Set("_maintenanceModeService", f.Maintenance);
        var identity = new System.Security.Claims.ClaimsIdentity(new[]
        {
            new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.Role, "Administrator"),
            new System.Security.Claims.Claim("Jellyfin-DeviceId", "device-a"),
            new System.Security.Claims.Claim("Jellyfin-IsApiKey", apiKey ? "true" : "false"),
        }, "test");
        controller.ControllerContext = new ControllerContext { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext { User = new System.Security.Claims.ClaimsPrincipal(identity) } };
        return controller;
    }

    [Fact]
    public async Task ASignedInPagesCommandWithoutAGenerationIsRefusedAndNothingIsReplayed()
    {
        // Only a configuration page of an earlier build sends Enable without the generation it confirms: it would replay its
        // copy over newer saves, so it is refused (and told to reload). An API key (a script) keeps the direct command.
        using var f = new Fixture();
        await f.Settled();
        var refused = await ControllerFor(f, apiKey: false).EnableMaintenanceMode(new MaintenanceModeRequest { Message = "old page", Action = "none" });
        var answer = Assert.IsType<ObjectResult>(refused);
        Assert.Equal(409, answer.StatusCode);
        Assert.Contains("reload_required", JsonConvert.SerializeObject(answer.Value));
        Assert.False(f.Maintenance.GetStatus().IsActive, "nothing replayed");
        var direct = await ControllerFor(f, apiKey: true).EnableMaintenanceMode(new MaintenanceModeRequest { Message = "script", Action = "none" });
        Assert.IsType<OkObjectResult>(direct);
        Assert.True(f.Maintenance.GetStatus().IsActive);
        var off = await ControllerFor(f, apiKey: false).DisableMaintenanceMode();
        Assert.Equal(409, Assert.IsType<ObjectResult>(off).StatusCode);
        Assert.True(f.Maintenance.GetStatus().IsActive, "a session's Disable without a generation changes nothing either");
    }

    // ------------------------------------------------------------------ Custom Tabs

    public sealed class TabsConfiguration : BasePluginConfiguration
    {
        public List<Tab> Tabs { get; set; } = new();
        public string Other { get; set; } = "kept";
    }

    public sealed class Tab
    {
        public string Title { get; set; } = string.Empty;
        public string ContentHtml { get; set; } = string.Empty;
        public int Order { get; set; }
    }

    private const string HiddenHtml = "<div class=\"jellyfinenhanced hidden-content\"></div>";

    private static (Mock<IHasPluginConfiguration> Host, Func<TabsConfiguration> Current) InstallTabs(Fixture f, TabsConfiguration initial, Action? onUpdate = null)
    {
        var current = initial;
        var plugin = new Mock<IPlugin>();
        var host = plugin.As<IHasPluginConfiguration>();
        host.SetupGet(x => x.Configuration).Returns(() => current);
        host.SetupGet(x => x.ConfigurationType).Returns(typeof(TabsConfiguration));
        host.Setup(x => x.UpdateConfiguration(It.IsAny<BasePluginConfiguration>())).Callback<BasePluginConfiguration>(next =>
        {
            onUpdate?.Invoke();
            current = (TabsConfiguration)next;
        });
        var local = new LocalPlugin(Path.Combine(f.Api.Core.Root, "tabs"), true, new PluginManifest { Id = ConfigurationEffects.CustomTabsPluginId, Name = "Custom Tabs", Version = "1.0.0.0" })
        {
            Instance = plugin.Object
        };
        f.PluginManager.SetupGet(x => x.Plugins).Returns(new[] { local });
        return (host, () => current);
    }

    private static void AskForHiddenTab(Fixture f, bool on)
    {
        f.Plugin.MutateConfiguration(cfg =>
        {
            cfg.HiddenContentEnabled = on;
            cfg.HiddenContentUseCustomTabs = on;
            cfg.HiddenContentAutoCreateCustomTab = on;
            return true;
        });
    }

    [Fact]
    public async Task TheServerAddsAndRemovesTheEntryItOwnsAndKeepsEveryOtherTab()
    {
        using var f = new Fixture();
        var (_, current) = InstallTabs(f, new TabsConfiguration { Tabs = { new Tab { Title = "Mine", ContentHtml = "<div>mine</div>", Order = 3 } } });
        AskForHiddenTab(f, true);
        // The change's own reconcile (or the one waited for, if that one had not run yet) adds it: either way it ends clean.
        var added = await f.Settled();
        Assert.True(added.CustomTabs!.Ok);
        Assert.Contains(added.CustomTabs.Status, new[] { "ok", "noop" });
        Assert.Contains(current().Tabs, t => t.ContentHtml == HiddenHtml && t.Title == "Hidden Content");
        Assert.True(f.Plugin.Configuration.HiddenContentCustomTabJeOwned, "recorded as Jellyfin Enhanced's");
        Assert.Equal("kept", current().Other);
        Assert.Contains(current().Tabs, t => t.ContentHtml == "<div>mine</div>" && t.Order == 3);
        AskForHiddenTab(f, false);
        var removed = await f.Settled();
        Assert.True(removed.CustomTabs!.Ok);
        Assert.Contains(removed.CustomTabs.Status, new[] { "ok", "noop" });
        Assert.DoesNotContain(current().Tabs, t => t.ContentHtml == HiddenHtml);
        Assert.False(f.Plugin.Configuration.HiddenContentCustomTabJeOwned);
        Assert.Contains(current().Tabs, t => t.ContentHtml == "<div>mine</div>");
    }

    [Fact]
    public async Task AnEntryAnAdministratorMadeByHandIsNeverRemoved()
    {
        using var f = new Fixture();
        var (_, current) = InstallTabs(f, new TabsConfiguration { Tabs = { new Tab { Title = "Hidden (mine)", ContentHtml = HiddenHtml } } });
        AskForHiddenTab(f, true);
        await f.Settled();
        Assert.False(f.Plugin.Configuration.HiddenContentCustomTabJeOwned, "an existing entry is never claimed");
        AskForHiddenTab(f, false);
        await f.Settled();
        Assert.Contains(current().Tabs, t => t.ContentHtml == HiddenHtml);
    }

    [Fact]
    public async Task WithoutCustomTabsOrWithAnUnknownShapeNothingIsWrittenAndTheReasonIsTold()
    {
        using var f = new Fixture();
        AskForHiddenTab(f, true);
        var absent = await f.Settled();
        Assert.Equal("skipped", absent.CustomTabs!.Status);
        Assert.True(absent.CustomTabs.Ok);
        var plugin = new Mock<IPlugin>();
        var host = plugin.As<IHasPluginConfiguration>();
        host.SetupGet(x => x.Configuration).Returns(new BasePluginConfiguration());
        host.SetupGet(x => x.ConfigurationType).Returns(typeof(BasePluginConfiguration));
        var local = new LocalPlugin(Path.Combine(f.Api.Core.Root, "tabs"), true, new PluginManifest { Id = ConfigurationEffects.CustomTabsPluginId, Name = "Custom Tabs", Version = "1.0.0.0" }) { Instance = plugin.Object };
        f.PluginManager.SetupGet(x => x.Plugins).Returns(new[] { local });
        f.Patch("ToastDuration", "1234");
        var unknown = await f.Settled();
        Assert.False(unknown.CustomTabs!.Ok);
        Assert.Equal("failed", unknown.CustomTabs.Status);
        host.Verify(x => x.UpdateConfiguration(It.IsAny<BasePluginConfiguration>()), Times.Never);
    }

    [Fact]
    public async Task AFailedCustomTabsWriteRecordsNoOwnershipAndSaysSo()
    {
        using var f = new Fixture();
        InstallTabs(f, new TabsConfiguration(), () => throw new IOException("custom tabs refused"));
        AskForHiddenTab(f, true);
        var outcome = await f.Settled();
        Assert.False(outcome.CustomTabs!.Ok);
        Assert.Equal("failed", outcome.CustomTabs.Status);
        Assert.False(f.Plugin.Configuration.HiddenContentCustomTabJeOwned);
    }

    [Fact]
    public async Task ASyncPlannedFromAnOlderGenerationWritesNothing()
    {
        using var f = new Fixture();
        await f.Settled();
        var (host, current) = InstallTabs(f, new TabsConfiguration());
        // The intent is on; between the sync's read and its write another save lands (its own reconcile syncs it).
        f.Plugin.Configuration.HiddenContentEnabled = f.Plugin.Configuration.HiddenContentUseCustomTabs = f.Plugin.Configuration.HiddenContentAutoCreateCustomTab = true;
        var plugins = f.PluginManager.Object.Plugins.ToArray();
        f.PluginManager.SetupGet(x => x.Plugins).Returns(() =>
        {
            f.Plugin.Configuration.ConfigurationGeneration++;
            return plugins;
        });
        var outcome = f.Effects.SyncCustomTabs();
        Assert.Equal("superseded", outcome!.Status);
        Assert.Empty(current().Tabs);
        host.Verify(x => x.UpdateConfiguration(It.IsAny<BasePluginConfiguration>()), Times.Never);
    }
}
