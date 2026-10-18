using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// 4a review round 8 (4a-security-r8-1/2/3): every fact the transport check gathers either is read in its final decision
/// from memory (the published disk snapshots), or is versioned, and every change to a versioned fact moves its version
/// BEFORE the change can be seen (odd while it is made, even after, also when it throws). Before round 8 a change could
/// be seen before its version moved (a breaker opened or an opt-out saved, the version moved only afterwards), a disk
/// snapshot published between the two disk reads or during a later read wasn't noticed, and a Jellyfin administrator
/// demoted while a later fact was read was still treated as one: each time the automatic write was sent. Each test
/// holds the check at the moment named, makes the change, and lets it decide: nothing may be sent.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationSeqlockTests
{
    // Holds the first call on the thread making it until released (or 20 s).
    private sealed class Barrier : IDisposable
    {
        private int _once;
        public ManualResetEventSlim Reached { get; } = new();
        public ManualResetEventSlim Release { get; } = new();

        public void Hold()
        {
            if (Interlocked.Exchange(ref _once, 1) != 0) return;
            Reached.Set();
            Release.Wait(TimeSpan.FromSeconds(20));
        }

        public void Dispose()
        {
            Release.Set();
            Reached.Dispose();
            Release.Dispose();
        }
    }

    // One automatic add (the next movie of a collection, for the administrator) queued and ready to send.
    private sealed class Send : IDisposable
    {
        public IntegrationAutomationTests.Engine E { get; } = new();
        public RequestWant Want { get; }
        public RequestJob Job { get; }
        public string Target { get; }
        public IntegrationTransport Transport { get; } = new((_, _) => Task.FromResult(IntegrationTransport.Response()));

        public Send(int lowDiskPercent = 0)
        {
            E.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
            E.C.ArrLowDiskPercent = lowDiskPercent;
            var asked = E.Auto(E.R.Admin, IntegrationRequestLedgerTests.Movie(962)).GetAwaiter().GetResult();
            Want = E.R.Ledger.Find(asked.WantId!)!;
            Job = E.R.Ledger.ForWant(Want.Id).Single();
            Target = AutomationSendGuard.Target(Job);
        }

        // The write through the transport, as the outbox's backend makes it (the check runs inside the transport).
        public Task<HttpStatusCode> Post(AutomationWriteGate gate, ISendAdmission? admission = null) => Task.Run(async () =>
        {
            using var client = Transport.CreateClient(ArrHttp.ClientName);
            using (AutomationTransportContext.Enter(gate, AutomationWrite.ForJob(Job, Want, true), admission))
            {
                using var response = await client.PostAsync("http://radarr.test/api/v3/movie", new StringContent("{}"));
                return response.StatusCode;
            }
        });

        public void Dispose()
        {
            Transport.Dispose();
            E.Dispose();
        }
    }

    // The breaker opens (its fifth failure in a row) while the check waits on its consent read; the commit is seen at
    // once, and the writer is held right after it (before it returns). The decision must not trust the closed breaker it
    // read before.
    [Fact]
    public async Task ABreakerOpenedWhileItsVersionIsStillMovingHoldsTheWrite()
    {
        using var s = new Send();
        for (var i = 1; i < AutomationStore.BreakerThreshold; i++) s.E.Store.Failure(s.Target, "backend_unavailable", s.E.R.Now);
        using var check = new Barrier();
        using var writer = new Barrier();
        s.E.Consent.Reading = check.Hold;
        var post = s.Post(s.E.Guard.Gate);
        Assert.True(check.Reached.Wait(TimeSpan.FromSeconds(10)), "the check read the consent");
        s.E.R.Db.Committed = writer.Hold;
        var opening = Task.Run(() => s.E.Store.Failure(s.Target, "backend_unavailable", s.E.R.Now));
        Assert.True(writer.Reached.Wait(TimeSpan.FromSeconds(10)), "the breaker opened (committed)");
        Assert.True(s.E.Store.Breaker(s.Target).Open(s.E.R.Now));
        check.Release.Set();
        await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => post);
        writer.Release.Set();
        await opening;
        Assert.Equal(0, s.Transport.Calls);
    }

    // The person's opt-out is saved while the check waits right after reading their consent (still on): the file is in
    // place, and the save is held right after it (before it returns). Their own settings file, the real reader.
    [Fact]
    public async Task AnOptOutSavedWhileItsVersionIsStillMovingHoldsTheWrite()
    {
        using var core = new CoreFixture();
        using var s = new Send();
        var consents = new HeldConsents(new UserSettingsConsents(core.Manager));
        var guard = new AutomationSendGuard(s.E.R.Policy, s.E.Budgets, s.E.Store, s.E.Eligibility, () => s.E.R.Now, consents);
        var person = s.E.R.Admin.ToString("N");
        core.Manager.SaveUserSettings(person, new UserSettings { AutoMovieRequests = true }, byThePerson: true);
        using var check = new Barrier();
        using var saver = new Barrier();
        consents.Reading = check.Hold;
        var post = s.Post(guard.Gate);
        Assert.True(check.Reached.Wait(TimeSpan.FromSeconds(10)), "the check read the consent");
        core.Manager.Moved = (_, file) => { if (file == UserConfigurationManager.SettingsFileName) saver.Hold(); };
        var saving = Task.Run(() => core.Manager.SaveUserSettings(person, new UserSettings { AutoMovieRequests = false }, byThePerson: true));
        Assert.True(saver.Reached.Wait(TimeSpan.FromSeconds(10)), "the opt-out is in place");
        Assert.False(new UserSettingsConsents(core.Manager).Preference(s.E.R.Admin, AutomationRecipes.AutoMovie));
        check.Release.Set();
        await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => post);
        saver.Release.Set();
        await saving;
        Assert.Equal(0, s.Transport.Calls);
    }

    // The breaker's opening write commits, then throws (here: as it returns); the version must still have moved, so the
    // check that read the closed breaker reads it again.
    [Fact]
    public async Task ABreakerWriteThatThrowsAfterItCommittedStillMovesTheVersion()
    {
        using var s = new Send();
        for (var i = 1; i < AutomationStore.BreakerThreshold; i++) s.E.Store.Failure(s.Target, "backend_unavailable", s.E.R.Now);
        using var check = new Barrier();
        s.E.Consent.Reading = check.Hold;
        var post = s.Post(s.E.Guard.Gate);
        Assert.True(check.Reached.Wait(TimeSpan.FromSeconds(10)), "the check read the consent");
        var thrown = 0;
        s.E.R.Db.Committed = () => { if (Interlocked.Exchange(ref thrown, 1) == 0) throw new SqliteException("thrown after the commit", 5); };
        s.E.Store.Failure(s.Target, "backend_unavailable", s.E.R.Now);
        s.E.R.Db.Committed = null;
        Assert.Equal(1, thrown);
        Assert.True(s.E.Store.Breaker(s.Target).Open(s.E.R.Now));
        check.Release.Set();
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => post);
        Assert.Equal(AutomationHolds.BreakerOpen, refused.Hold.Reason);
        Assert.Equal(0, s.Transport.Calls);
    }

    // A disk snapshot refresh publishes low space as the first disk fact is read: both disk answers must come from the
    // same snapshot, the one current at the decision.
    [Fact]
    public async Task LowDiskPublishedBetweenTheDiskReadsHoldsTheWrite()
    {
        using var s = new Send(lowDiskPercent: 5);
        var swapped = 0;
        s.E.R.Policy.Reading = what =>
        {
            if (what is "title_pause" or "disk_known" or "warm_disk" && Interlocked.Exchange(ref swapped, 1) == 0)
                s.E.R.Policy.Publish(new RequestDiskFacts(s.Target, "Radarr", "/movies", 1, 100, 5), known: true);
        };
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => s.Post(s.E.Guard.Gate));
        Assert.Equal(1, swapped);
        Assert.Equal(AutomationHolds.LowDisk, refused.Hold.Reason);
        Assert.Equal(0, s.Transport.Calls);
    }

    // Low space is published while the transport reads the job's budget reservations (after the disk facts were read
    // before round 8).
    [Fact]
    public async Task LowDiskPublishedDuringTheTransportsBudgetReadHoldsTheWrite()
    {
        using var s = new Send(lowDiskPercent: 5);
        var admission = s.E.Guard.Admission(s.Job, s.Want)!;
        Assert.Null(admission.Admit(SendWriteKind.Add, "add"));
        var swapped = 0;
        s.E.Budgets.RowsRead = category =>
        {
            if (category == BudgetCategories.HouseholdAdd && Interlocked.Exchange(ref swapped, 1) == 0)
                s.E.R.Policy.Publish(new RequestDiskFacts(s.Target, "Radarr", "/movies", 1, 100, 5), known: true);
        };
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => s.Post(s.E.Guard.Gate, admission));
        Assert.Equal(1, swapped);
        Assert.Equal(AutomationHolds.LowDisk, refused.Hold.Reason);
        Assert.Equal(0, s.Transport.Calls);
        // The attempt's reservation is released, nothing counted.
        Assert.Equal(0, s.E.Count("SELECT count(*) FROM automation_budget WHERE state<>'released'"));
    }

    // Another administrator removes this person's administrator permission while the check reads their consent (read
    // after their role): without the OK an administrator never needed, the request now needs one.
    [Fact]
    public async Task AnAdministratorDemotedWhileTheirConsentIsReadNeedsAnOk()
    {
        using var s = new Send();
        var demoted = 0;
        s.E.Consent.Reading = () => { if (Interlocked.Exchange(ref demoted, 1) == 0) s.E.R.Policy.Demote(s.E.R.Admin, "Member"); };
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => s.Post(s.E.Guard.Gate));
        Assert.Equal(1, demoted);
        Assert.Equal(AutomationHolds.ApprovalRequired, refused.Hold.Reason);
        Assert.True(refused.Hold.Park);
        Assert.Equal(0, s.Transport.Calls);
    }

    // 4a review round 9 (4a-security-r9-1): Jellyfin's own actions that can lock an administrator out or take their
    // permission away while the check reads their consent, as Jellyfin runs them (through the production bracket filter
    // and the production Jellyfin user version). Jellyfin 12.2's password change authenticates the current password
    // first; a wrong one counts a failed sign-in, and the last allowed one disables the account before the action
    // returns 403. The check read "administrator" before that and must not send without the OK now required.
    [Theory]
    [InlineData("UserController.UpdateUserPassword")]
    [InlineData("UserController.UpdateUserPasswordLegacy")]
    [InlineData("UserController.AuthenticateUserByName")]
    [InlineData("UserController.AuthenticateWithQuickConnect")]
    [InlineData("QuickConnectController.AuthorizeQuickConnect")]
    [InlineData("StartupController.UpdateStartupUser")]
    [InlineData("UserController.UpdateUserConfiguration")]
    public async Task AJellyfinActionThatLocksTheAdministratorOutDuringTheConsentReadNeedsAnOk(string name)
    {
        using var s = new Send();
        s.E.R.Policy.Permissions = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation.JellyfinUserVersions.Sample;
        var admin = s.E.R.Admin;
        var (controller, action) = (name.Split('.')[0], name.Split('.')[1]);
        // The arguments as Jellyfin binds them: the person's own id where the action takes one (none for a sign-in by
        // name, a Quick Connect sign-in or the start-up wizard: the person isn't known before it runs).
        var args = new Dictionary<string, object?>();
        if (action is "UpdateUserPassword" or "UpdateUserPasswordLegacy" or "AuthorizeQuickConnect" or "UpdateUserConfiguration") args["userId"] = admin;
        var context = controller switch
        {
            "UserController" => JellyfinUserBracketHarness.Context<Jellyfin.Api.Controllers.UserController>(action, args, signedIn: admin),
            "QuickConnectController" => JellyfinUserBracketHarness.Context<Jellyfin.Api.Controllers.QuickConnectController>(action, args, signedIn: admin),
            _ => JellyfinUserBracketHarness.Context<Jellyfin.Api.Controllers.StartupController>(action, args),
        };
        var locked = 0;
        s.E.Consent.Reading = () =>
        {
            if (Interlocked.Exchange(ref locked, 1) != 0) return;
            // Jellyfin's action: the failed authentication disables the account (no longer an administrator to JE),
            // then the action returns.
            JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, () =>
            {
                s.E.R.Policy.People[admin] = s.E.R.Policy.People[admin] with { Role = "Member", CanApprove = false, Can4k = false };
                return JellyfinUserBracketHarness.Done(context);
            }).GetAwaiter().GetResult();
        };
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => s.Post(s.E.Guard.Gate));
        Assert.Equal(1, locked);
        Assert.Equal(AutomationHolds.ApprovalRequired, refused.Hold.Reason);
        Assert.True(refused.Hold.Park);
        Assert.Equal(0, s.Transport.Calls);
    }

    // The same, with the password change still running as the check decides (it locked the account while the check
    // read the consent, and hasn't returned): its version is odd, so the check reads again and, while it stays odd,
    // holds. Nothing is sent.
    [Fact]
    public async Task APasswordChangeStillRunningAsTheCheckDecidesHoldsTheWrite()
    {
        using var s = new Send();
        s.E.R.Policy.Permissions = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation.JellyfinUserVersions.Sample;
        var admin = s.E.R.Admin;
        var context = JellyfinUserBracketHarness.Context<Jellyfin.Api.Controllers.UserController>("UpdateUserPassword", new Dictionary<string, object?> { ["userId"] = admin }, signedIn: admin);
        using var lockedOut = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        Task? running = null;
        s.E.Consent.Reading = () =>
        {
            if (running != null) return;
            running = Task.Run(() => JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, () =>
            {
                s.E.R.Policy.People[admin] = s.E.R.Policy.People[admin] with { Role = "Member", CanApprove = false, Can4k = false };
                lockedOut.Set();
                release.Wait(TimeSpan.FromSeconds(20));
                return JellyfinUserBracketHarness.Done(context);
            }));
            Assert.True(lockedOut.Wait(TimeSpan.FromSeconds(10)));
        };
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => s.Post(s.E.Guard.Gate));
        release.Set();
        await running!;
        Assert.Equal(AutomationHolds.EngineChanged, refused.Hold.Reason);
        Assert.Equal(0, s.Transport.Calls);
    }

    // Control: nothing changes while the consent is read; the person's automatic request goes (an administrator's,
    // eligible by role).
    [Fact]
    public async Task NothingChangedTheWriteGoes()
    {
        using var s = new Send(lowDiskPercent: 5);
        var reads = 0;
        s.E.Consent.Reading = () => Interlocked.Increment(ref reads);
        Assert.Equal(HttpStatusCode.OK, await s.Post(s.E.Guard.Gate));
        Assert.Equal(1, reads);
        Assert.Equal(1, s.Transport.Calls);
    }

    // The real settings reader with a hook as each preference read returns.
    private sealed class HeldConsents(IAutomationConsents inner) : IAutomationConsents
    {
        public Action? Reading { get; set; }

        public bool? Preference(Guid user, string recipe)
        {
            var preference = inner.Preference(user, recipe);
            Reading?.Invoke();
            return preference;
        }

        public long Version(Guid user) => inner.Version(user);
    }
}
