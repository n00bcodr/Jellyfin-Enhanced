using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;
using Moq;
using Newtonsoft.Json;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreMaintenanceTests
{
    private sealed class Fixture : IDisposable
    {
        public CoreFixture Core { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<ISessionManager> Sessions { get; } = new();
        public User Admin { get; } = Make("admin");
        public User Alice { get; } = Make("alice");
        public User Restricted { get; } = Make("restricted");
        public Dictionary<Guid, UserPolicy> Policies { get; } = new();
        public MaintenanceModeService Service { get; }
        public Fixture()
        {
            Admin.SetPermission(PermissionKind.IsAdministrator, true);
            var all = new[] { Admin, Alice, Restricted };
#if NET9_0
            Users.SetupGet(x => x.Users).Returns(all);
#else
            Users.Setup(x => x.GetUsers()).Returns(all);
#endif
            foreach (var user in all)
            {
                Policies[user.Id] = new UserPolicy { IsDisabled = user == Restricted, EnableRemoteAccess = user != Restricted };
                Users.Setup(x => x.GetUserById(user.Id)).Returns(user);
                Users.Setup(x => x.GetUserDto(user, It.IsAny<string>())).Returns(() => new UserDto { Id = user.Id, Policy = Clone(Policies[user.Id]) });
            }
            Users.Setup(x => x.UpdatePolicyAsync(It.IsAny<Guid>(), It.IsAny<UserPolicy>()))
                .Callback<Guid, UserPolicy>((id, policy) => Policies[id] = Clone(policy)).Returns(Task.CompletedTask);
            Sessions.SetupGet(x => x.Sessions).Returns(Array.Empty<SessionInfo>());
            Service = Reopen();
        }
        private static User Make(string name) => new(name, "default", "default") { Id = Guid.NewGuid() };
        private static UserPolicy Clone(UserPolicy policy) => JsonConvert.DeserializeObject<UserPolicy>(JsonConvert.SerializeObject(policy))!;
        public MaintenanceModeService Reopen() => new(Users.Object, Sessions.Object, Core.Paths.Object, Core.Logger);
        public void Dispose() => Core.Dispose();
    }

    [Theory]
    [InlineData("none", false, true)][InlineData("disable_accounts", true, true)]
    [InlineData("disable_remote", false, false)][InlineData("both", true, false)]
    public async Task ActionsExcludeAdministratorsAndRestoreOnlyMaintenanceChanges(string action, bool disabled, bool remote)
    {
        using var f = new Fixture();
        await f.Service.EnableAsync("maintenance", 0, action, null);
        Assert.Equal(disabled, f.Policies[f.Alice.Id].IsDisabled);
        Assert.Equal(remote, f.Policies[f.Alice.Id].EnableRemoteAccess);
        Assert.False(f.Policies[f.Admin.Id].IsDisabled);
        Assert.True(f.Policies[f.Admin.Id].EnableRemoteAccess);
        await f.Reopen().DisableAsync();
        Assert.False(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Policies[f.Alice.Id].EnableRemoteAccess);
        Assert.True(f.Policies[f.Restricted.Id].IsDisabled);
        Assert.False(f.Policies[f.Restricted.Id].EnableRemoteAccess);
    }

    [Fact]
    public async Task SelectionReconciliationRestoresPreviousActionAndInvalidIdsDoNotTargetEveryone()
    {
        using var f = new Fixture();
        await f.Service.EnableAsync("", 0, "both", [f.Alice.Id.ToString()]);
        Assert.True(f.Policies[f.Alice.Id].IsDisabled);
        await f.Service.EnableAsync("", 0, "disable_remote", [f.Alice.Id.ToString()]);
        Assert.False(f.Policies[f.Alice.Id].IsDisabled);
        Assert.False(f.Policies[f.Alice.Id].EnableRemoteAccess);
        await f.Service.EnableAsync("", 0, "both", ["invalid", f.Admin.Id.ToString()]);
        Assert.False(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Policies[f.Alice.Id].EnableRemoteAccess);
        Assert.Empty(f.Service.GetStatus().AccountDisabledUserIds);
        Assert.Empty(f.Service.GetStatus().RemoteDisabledUserIds);
    }

    [Fact]
    public async Task RepeatManualSavePreservesClockAndManualWindowWinsOverSchedule()
    {
        using var f = new Fixture();
        await f.Service.EnableAsync("first", 60, "none", null);
        var started = f.Service.GetStatus().StartedAt;
        var end = f.Service.GetStatus().EndsAt;
        await f.Service.EnableAsync("updated", 60, "none", []);
        Assert.Equal(end, f.Service.GetStatus().EndsAt);
        Assert.Equal(started, f.Service.GetStatus().StartedAt);
        Assert.Equal("updated", f.Service.GetStatus().Message);
        Assert.False(await f.Service.EnableScheduledAsync("scheduled", "", "both", null, DateTime.UtcNow.AddHours(2)));
        await f.Service.DisableScheduledWindowAsync("schedule off");
        Assert.True(f.Service.GetStatus().IsActive);
        Assert.Equal("manual", f.Service.GetStatus().Source);
    }

    [Fact]
    public async Task ScheduledWindowEndedByAdminStaysSkippedAcrossRestartButNextOccurrenceOpens()
    {
        using var f = new Fixture();
        var end = DateTime.UtcNow.AddHours(1);
        Assert.True(await f.Service.EnableScheduledAsync("scheduled", "", "both", null, end));
        await f.Service.DisableAsync(includeScheduled: false);
        Assert.True(f.Service.GetStatus().IsActive);
        await f.Service.DisableAsync();
        var restarted = f.Reopen();
        Assert.False(await restarted.EnableScheduledAsync("scheduled", "", "both", null, end));
        Assert.True(await restarted.EnableScheduledAsync("scheduled", "", "both", null, end.AddDays(1)));
    }

    [Fact]
    public async Task ExpiredPersistedWindowRestoresPoliciesAndDisablesState()
    {
        using var f = new Fixture();
        await f.Service.EnableScheduledAsync("expired", "", "both", null, DateTime.UtcNow.AddHours(-1));
        var restarted = f.Reopen();
        var state = await restarted.ExpireIfDueAsync();
        Assert.False(state.IsActive);
        Assert.False(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Policies[f.Alice.Id].EnableRemoteAccess);
        Assert.False(f.Reopen().GetStatus().IsActive);
    }

    [Fact]
    public async Task FailedPolicyUpdatesAreNotRecordedAsChangesToRestore()
    {
        using var f = new Fixture();
        f.Users.Setup(x => x.UpdatePolicyAsync(f.Alice.Id, It.IsAny<UserPolicy>())).ThrowsAsync(new IOException("policy store unavailable"));
        await f.Service.EnableAsync("", 0, "both", [f.Alice.Id.ToString()]);
        Assert.Empty(f.Service.GetStatus().AccountDisabledUserIds);
        Assert.Empty(f.Service.GetStatus().RemoteDisabledUserIds);
        Assert.False(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Policies[f.Alice.Id].EnableRemoteAccess);
    }

    [Fact]
    public async Task FailedRestoreRemainsPendingAcrossRestartAndRetriesWithoutTouchingAlreadyRestoredUsers()
    {
        using var f = new Fixture();
        // Make both ordinary users eligible, so one restoration can succeed while the other fails.
        f.Policies[f.Restricted.Id] = new UserPolicy { IsDisabled = false, EnableRemoteAccess = true };
        await f.Service.EnableAsync("", 0, "both", null);
        var fail = true;
        f.Users.Setup(x => x.UpdatePolicyAsync(f.Alice.Id, It.IsAny<UserPolicy>()))
            .Returns<Guid, UserPolicy>((id, policy) =>
            {
                if (fail) throw new IOException("policy store unavailable");
                f.Policies[id] = policy;
                return Task.CompletedTask;
            });
        await f.Service.DisableAsync();
        Assert.False(f.Service.GetStatus().IsActive);
        Assert.Contains(f.Alice.Id.ToString(), f.Service.GetStatus().AccountDisabledUserIds);
        Assert.DoesNotContain(f.Restricted.Id.ToString(), f.Service.GetStatus().AccountDisabledUserIds);
        // An admin now changes the successfully restored user's policy. Retry must not undo it.
        f.Policies[f.Restricted.Id].IsDisabled = true;
        f.Policies[f.Restricted.Id].EnableRemoteAccess = false;
        fail = false;
        var restarted = f.Reopen();
        await restarted.ExpireIfDueAsync();
        Assert.False(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Policies[f.Alice.Id].EnableRemoteAccess);
        Assert.True(f.Policies[f.Restricted.Id].IsDisabled);
        Assert.False(f.Policies[f.Restricted.Id].EnableRemoteAccess);
        Assert.Empty(restarted.GetStatus().AccountDisabledUserIds);
        Assert.Empty(restarted.GetStatus().RemoteDisabledUserIds);
        Assert.Empty(f.Reopen().GetStatus().AccountDisabledUserIds);
    }

    [Fact]
    public async Task FailedReconcileCannotOverwritePreviousRestorationIntent()
    {
        using var f = new Fixture();
        await f.Service.EnableAsync("", 0, "both", [f.Alice.Id.ToString()]);
        f.Users.Setup(x => x.UpdatePolicyAsync(f.Alice.Id, It.IsAny<UserPolicy>())).ThrowsAsync(new IOException("policy store unavailable"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Service.EnableAsync("new", 0, "none", null));
        Assert.Contains(f.Alice.Id.ToString(), f.Service.GetStatus().AccountDisabledUserIds);
        Assert.Equal("both", f.Reopen().GetStatus().Action);
        await f.Service.DisableAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Service.EnableAsync("new", 0, "none", null));
        Assert.Contains(f.Alice.Id.ToString(), f.Reopen().GetStatus().AccountDisabledUserIds);
    }

    [Fact]
    public async Task NullPersistedRestoreListsDoNotBreakStartup()
    {
        using var f = new Fixture();
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "maintenance-state.json"), "{\"IsActive\":false,\"AccountDisabledUserIds\":null,\"RemoteDisabledUserIds\":null}");
        var reopened = f.Reopen();
        await reopened.ExpireIfDueAsync();
        await reopened.EnableAsync("", 0, "none", null);
        await reopened.DisableAsync();
        Assert.False(reopened.GetStatus().IsActive);
    }

    [Fact]
    public async Task PartialReconcileFailureThenOriginalSelectionReappliesEveryUser()
    {
        using var f = new Fixture();
        f.Policies[f.Restricted.Id] = new UserPolicy { IsDisabled = false, EnableRemoteAccess = true };
        await f.Service.EnableAsync("", 0, "both", null);
        var fail = true;
        f.Users.Setup(x => x.UpdatePolicyAsync(f.Alice.Id, It.IsAny<UserPolicy>())).Returns<Guid, UserPolicy>((id, policy) =>
        {
            if (fail) throw new IOException("unavailable");
            f.Policies[id] = policy;
            return Task.CompletedTask;
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Service.EnableAsync("", 0, "none", null));
        Assert.False(f.Policies[f.Restricted.Id].IsDisabled);
        fail = false;
        await f.Service.EnableAsync("", 0, "both", null);
        Assert.True(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Policies[f.Restricted.Id].IsDisabled);
        Assert.Equal(2, f.Service.GetStatus().AccountDisabledUserIds.Count);
    }

    [Fact]
    public async Task StateWriteFailureIsReportedBeforeRestoringPolicies()
    {
        using var f = new Fixture();
        await f.Service.EnableAsync("", 0, "both", null);
        var statePath = Path.Combine(f.Core.ConfigRoot, "maintenance-state.json");
        File.Delete(statePath);
        Directory.CreateDirectory(statePath);
        await Assert.ThrowsAnyAsync<IOException>(() => f.Service.DisableAsync());
        Assert.True(f.Policies[f.Alice.Id].IsDisabled);
        Assert.True(f.Service.GetStatus().IsActive);
        Assert.Empty(Directory.GetFiles(f.Core.ConfigRoot, "maintenance-state.json.tmp.*"));
    }

    [Fact]
    public async Task CheckpointFailureAfterPolicyRestoreAbortsReconciliation()
    {
        using var f = new Fixture();
        await f.Service.EnableAsync("", 0, "both", [f.Alice.Id.ToString()]);
        var statePath = Path.Combine(f.Core.ConfigRoot, "maintenance-state.json");
        f.Users.Setup(x => x.UpdatePolicyAsync(f.Alice.Id, It.IsAny<UserPolicy>())).Returns<Guid, UserPolicy>((id, policy) =>
        {
            f.Policies[id] = policy;
            File.Delete(statePath);
            Directory.CreateDirectory(statePath);
            return Task.CompletedTask;
        });
        await Assert.ThrowsAnyAsync<IOException>(() => f.Service.EnableAsync("new", 0, "none", null));
        Assert.Contains(f.Alice.Id.ToString(), f.Service.GetStatus().AccountDisabledUserIds);
        Assert.Equal("both", f.Service.GetStatus().Action);
        Assert.False(f.Service.GetStatus().IsActive);
    }

    [Theory]
    [InlineData("00:00", "08:00", true)][InlineData("22:00", "06:00", true)]
    [InlineData(" 9:00 ", "10:00", true)][InlineData("24:00", "06:00", false)]
    [InlineData("12:60", "06:00", false)][InlineData("06:00", "06:00", false)]
    [InlineData(null, "06:00", false)][InlineData("bogus", "06:00", false)]
    public void ScheduleParsingRejectsInvalidOrZeroLengthWindows(string? start, string? end, bool expected)
        => Assert.Equal(expected, MaintenanceScheduleService.TryParseWindow(start, end, out _, out _));

    [Theory]
    [InlineData(21, 59, false, 0)][InlineData(22, 0, true, 0)][InlineData(23, 59, true, 0)]
    [InlineData(0, 0, true, -1)][InlineData(5, 59, true, -1)][InlineData(6, 0, false, 0)]
    public void OvernightWindowIncludesStartAndExcludesEnd(int hour, int minute, bool active, int startDay)
    {
        var now = new DateTime(2026, 10, 5, hour, minute, 0);
        var result = MaintenanceScheduleService.CurrentWindow(TimeSpan.FromHours(22), TimeSpan.FromHours(6), now);
        Assert.Equal(active, result.HasValue);
        if (active)
        {
            Assert.Equal(now.Date.AddDays(startDay).AddHours(22), result!.Value.Start);
            Assert.Equal(TimeSpan.FromHours(8), result.Value.End - result.Value.Start);
        }
    }

    [Theory]
    [InlineData(-1, "0m")][InlineData(0, "0m")][InlineData(1, "1m")][InlineData(60, "1m")]
    [InlineData(61, "2m")][InlineData(3900, "1h 05m")]
    public void CountdownRoundsUpAndClampsExpiredWindows(int seconds, string expected)
        => Assert.Equal(expected, MaintenanceModeService.FormatCountdown(TimeSpan.FromSeconds(seconds)));
}
