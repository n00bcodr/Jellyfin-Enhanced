using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace JE.Tests;

/// <summary>
/// 4a review round 10 (4a-security-r10-1): a recorded approver never stands in for current authority. An administrator
/// approves a Member's Ask-mode automatic request; after the outbox's last policy check, just before the transport check,
/// the administrator is demoted. Round 9's transport check returned "may go" because an approver was recorded at all: it
/// gathered nothing about them, and sampled only the requester's version. The POST went out and the job succeeded.
/// <para>
/// Now the transport check gathers both people's current policy facts (the same <see cref="IRequestPolicy.Evaluate"/>
/// the outbox's checks use), each versioned by that person's Jellyfin user version, and decides on them: the approver
/// must still be able to approve (a Jellyfin administrator, or a Manager), enabled, not deleted, not locked out, and see
/// the title; an edited request needs an administrator; the requester must still be there, able to ask and see the title.
/// A lost approval parks the job as approval_required (the want waits for a new OK; the old approval is void).
/// </para>
/// Each change is made at the reviewer's moment (as the write reaches the transport check, after every earlier check
/// answered) and, separately, while the transport check's own read is held. Everything runs through the real outbox,
/// the Direct backend and the production transport handler.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationApproverTests
{
    private sealed class Race : IDisposable
    {
        private int _once;
        private int _armed;

        public IntegrationRequestBackendsTests.Lab Lab { get; } = new();
        public IntegrationAutomationTests.Engine E { get; }
        public string WantId { get; set; } = string.Empty;

        public Race(bool engine = true)
        {
            E = new IntegrationAutomationTests.Engine(engine);
            // Admission records these defaults before dispatch; both fixtures share the configured destination.
            E.C.RadarrInstances = Lab.Config.RadarrInstances;
            E.C.SonarrInstances = Lab.Config.SonarrInstances;
            var instance = Lab.Instance("Radarr").Id;
            var generation = Lab.Arr.Factory.ConnectionGeneration(instance)!;
            E.R.Policy.Adjust = (_, _, facts) => facts with { InstanceId = instance, ConnectionGeneration = generation };
            Lab.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(961));
        }

        public static MutationInput Input => IntegrationRequestLedgerTests.Movie(961);

        /// <summary>The requester's automatic request (Ask: it waits), approved by the approver (with edits, when given).</summary>
        public async Task AskAndApprove(Guid requester, Guid approver, MutationInput? edits = null)
        {
            E.Mode(AutomationRecipes.AutoMovie, AutomationMode.Ask);
            await Ask(requester, "pending");
            var approved = await E.R.Service.ApproveAsync(WantId, approver, edits == null ? null : new ApproveRequest(edits), default);
            Assert.True(approved.HttpStatus < 300, "approved: " + approved.Reason);
            Assert.Equal("queued", E.R.Ledger.Find(WantId)!.Status);
        }

        /// <summary>The requester's automatic request, expected to be recorded as <paramref name="status"/> (queued or pending).</summary>
        public async Task Ask(Guid requester, string status)
        {
            var asked = await E.Auto(requester, Input, AutomationRecipes.AutoMovie);
            WantId = asked.WantId ?? throw new Xunit.Sdk.XunitException("no request recorded: " + asked.Reason);
            Assert.Equal(status, Want.Status);
        }

        /// <summary>The change, made as the first write reaches the transport check (every earlier check has answered).</summary>
        public void AtTheTransport(Action change)
            => Lab.Arr.Transport.BeforeGate = request => { if (request.Method != HttpMethod.Get && Interlocked.Exchange(ref _once, 1) == 0) change(); };

        /// <summary>The change, made while the transport check's own read (the requester's consent) is held.</summary>
        public void DuringTheTransportsRead(Action change)
            => Lab.Arr.Transport.BeforeGate = request =>
            {
                if (request.Method == HttpMethod.Get || Interlocked.Exchange(ref _armed, 1) != 0) return;
                E.Consent.Reading = () => { if (Interlocked.Exchange(ref _once, 1) == 0) change(); };
            };

        public Task Tick() => E.Outbox(Lab.Direct).TickAsync(default);

        /// <summary>Whether the movie was added (the arr received the POST).</summary>
        public bool Sent => Lab.Radarr.Writes.Any(w => w.Method == "POST" && w.Path == "/api/v3/movie");

        public RequestJob Job => E.R.Ledger.ForWant(WantId).OrderBy(j => j.Attempts).Last();

        public RequestWant Want => E.R.Ledger.Find(WantId)!;

        public bool Changed => _once == 1;

        public void Dispose()
        {
            E.Dispose();
            Lab.Dispose();
        }
    }

    public static IEnumerable<object[]> ApproverChanges()
        => from change in new[] { "demoted", "disabled", "deleted", "locked_out", "loses_the_approving_role" }
           from moment in new[] { "at_the_transport", "during_the_transports_read" }
           select new object[] { change, moment };

    // The approver's authority is gone: nothing is sent, the job parks as approval_required, and the want waits for a new
    // OK (the old approval is void).
    [Theory]
    [MemberData(nameof(ApproverChanges))]
    public async Task AnApproverWhoLostTheirAuthorityBeforeTheSendVoidsTheApproval(string change, string moment)
    {
        using var r = new Race();
        var approver = change == "loses_the_approving_role" ? r.E.R.Manager : r.E.R.Admin;
        // Jellyfin's own lockout moves the production version (JellyfinUserVersions), as it does on a server.
        if (change == "locked_out") r.E.R.Policy.Permissions = JellyfinUserVersions.Sample;
        await r.AskAndApprove(r.E.R.Member, approver);
        Action act = change switch
        {
            "demoted" => () => r.E.R.Policy.Demote(approver, "Member"),
            "disabled" => () => r.E.R.Policy.Disable(approver),
            "deleted" => () => r.E.R.Policy.Delete(approver),
            "locked_out" => () => LockOut(r, approver),
            "loses_the_approving_role" => () => r.E.R.Policy.Demote(approver, "Member"),
            _ => throw new ArgumentOutOfRangeException(nameof(change), change, null),
        };
        if (moment == "at_the_transport") r.AtTheTransport(act);
        else r.DuringTheTransportsRead(act);
        await r.Tick();
        Assert.True(r.Changed, "the change was made");
        Assert.False(r.Sent, "the movie was added after the approver lost their authority");
        Assert.Equal(("parked", AutomationHolds.ApprovalRequired), (r.Job.State, r.Job.Reason));
        Assert.Equal(("pending", AutomationHolds.ApprovalRequired), (r.Want.Status, r.Want.Reason));
    }

    // Jellyfin itself locks the approver out (a wrong current password through the password change, the last allowed
    // failed attempt disables the account) through the production bracket filter and version.
    private static void LockOut(Race r, Guid approver)
    {
        var context = JellyfinUserBracketHarness.Context<Jellyfin.Api.Controllers.UserController>("UpdateUserPassword", new Dictionary<string, object?> { ["userId"] = approver }, signedIn: approver);
        JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, () =>
        {
            r.E.R.Policy.People[approver] = IntegrationRequestLedgerTests.Policy.Disabled(r.E.R.Policy.People[approver]);
            return JellyfinUserBracketHarness.Done(context);
        }).GetAwaiter().GetResult();
    }

    // Control: nothing changes about the approver; the approved request goes.
    [Theory]
    [InlineData("at_the_transport")]
    [InlineData("during_the_transports_read")]
    public async Task AnApproverWhoKeepsTheirAuthorityIsSent(string moment)
    {
        using var r = new Race();
        await r.AskAndApprove(r.E.R.Member, r.E.R.Admin);
        if (moment == "at_the_transport") r.AtTheTransport(() => { });
        else r.DuringTheTransportsRead(() => { });
        await r.Tick();
        Assert.True(r.Changed);
        Assert.True(r.Sent);
        Assert.Equal("succeeded", r.Job.State);
    }

    // An edited request (an administrator chose its quality profile) needs an administrator's OK: one demoted to Manager
    // can still approve, but not this.
    [Fact]
    public async Task AnEditedApprovalNeedsAnAdministratorStill()
    {
        using var r = new Race();
        await r.AskAndApprove(r.E.R.Member, r.E.R.Admin, Race.Input with { ProfileId = 5 });
        Assert.True(r.Job.Authorization.Edited);
        r.AtTheTransport(() => r.E.R.Policy.Demote(r.E.R.Admin, "Manager"));
        await r.Tick();
        Assert.False(r.Sent);
        Assert.Equal(("parked", AutomationHolds.ApprovalRequired), (r.Job.State, r.Job.Reason));
    }

    // With the engine off (the old recipe's queued work goes out as before): a Member's automatic request still waits for
    // an OK in JE mode, and the approver's authority is checked at the transport just the same.
    [Fact]
    public async Task WithTheEngineOffTheApproverIsCheckedAtTheTransportToo()
    {
        using var r = new Race(engine: false);
        await r.Ask(r.E.R.Member, "pending");
        Assert.True((await r.E.R.Service.ApproveAsync(r.WantId, r.E.R.Admin, null, default)).HttpStatus < 300);
        r.AtTheTransport(() => r.E.R.Policy.Demote(r.E.R.Admin, "Member"));
        await r.Tick();
        Assert.False(r.Sent);
        Assert.Equal(("parked", AutomationHolds.ApprovalRequired), (r.Job.State, r.Job.Reason));
    }

    // The requester's own authority, with an approval recorded: round 9 checked nothing about them once an approver was.
    [Theory]
    [InlineData("disabled", "identity_changed")]
    [InlineData("deleted", "identity_changed")]
    [InlineData("watcher", "authorization_changed")]
    public async Task ARequesterWhoLostTheirAuthorityIsNotSentEvenWithAnApproval(string change, string reason)
    {
        using var r = new Race();
        await r.AskAndApprove(r.E.R.Member, r.E.R.Admin);
        r.AtTheTransport(() =>
        {
            if (change == "disabled") r.E.R.Policy.Disable(r.E.R.Member);
            else if (change == "deleted") r.E.R.Policy.Delete(r.E.R.Member);
            else r.E.R.Policy.Demote(r.E.R.Member, "Watcher");
        });
        await r.Tick();
        Assert.False(r.Sent);
        Assert.Equal(("parked", reason), (r.Job.State, r.Job.Reason));
    }

    // A recorded eligibility grant stands for the household Manager role it was given for (the legacy migration grants it
    // to Managers whose automatic requests went ahead). Demoted to Member, the person's automatic requests need an OK, at
    // the transport and when the next one is recorded.
    [Fact]
    public async Task AMigratedManagersGrantStopsCountingOnceTheyAreAMember()
    {
        using var r = new Race();
        r.E.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        r.E.Grant(r.E.R.Manager);
        await r.Ask(r.E.R.Manager, "queued");
        r.AtTheTransport(() => r.E.R.Policy.Demote(r.E.R.Manager, "Member"));
        await r.Tick();
        Assert.False(r.Sent);
        Assert.Equal(("parked", AutomationHolds.ApprovalRequired), (r.Job.State, r.Job.Reason));

        // Their next automatic request is recorded as waiting for an OK; as a Manager it went ahead.
        using var next = new Race();
        next.E.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        next.E.Grant(next.E.R.Manager);
        next.E.R.Policy.Demote(next.E.R.Manager, "Member");
        await next.Ask(next.E.R.Manager, "pending");
        Assert.Empty(next.E.R.Ledger.ForWant(next.WantId));
    }

    // A list's sync asks on its owner's behalf (an automatic, phase-4-only origin). The owner here is a Trusted Manager,
    // eligible without an OK; disabled before the send, nothing goes (round 9 read only whether they were an
    // administrator, and Trusted kept them eligible).
    [Fact]
    public async Task AListSyncsOwnerDisabledBeforeTheSendIsNotSent()
    {
        using var r = new Race();
        r.E.Mode(AutomationRecipes.ListSyncRequests, AutomationMode.Auto);
        r.E.Trusted.Trusted.Add(r.E.R.Manager);
        var origin = RequestOrigin.Sync("list-1", new RequestProvenance(EntryId: "e1", SourceGeneration: "g1"));
        var created = r.E.R.Ledger.Create(r.E.R.Manager, new CreateRequest("sync-1", Race.Input), r.E.R.Policy, r.E.R.Now, origin);
        Assert.True(created.HttpStatus < 300, created.Reason);
        r.WantId = created.RequestId!;
        Assert.Equal("queued", r.Want.Status);
        r.AtTheTransport(() => r.E.R.Policy.Disable(r.E.R.Manager));
        await r.Tick();
        Assert.True(r.Changed);
        Assert.False(r.Sent);
        Assert.Equal(("parked", "identity_changed"), (r.Job.State, r.Job.Reason));
    }
}
