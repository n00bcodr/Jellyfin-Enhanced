using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using static JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

public class IntegrationRequestReviewRound1Tests
{
    [Theory]
    [InlineData("sending")]
    [InlineData("maybe_sent")]
    [InlineData("succeeded")]
    [InlineData("parked")]
    public async Task R1DeletedApproverPreservesSendCertaintyAndFences(string state)
    {
        using var r = new Rig();
        var want = await r.Create(r.Kid);
        await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default);
        var job = Assert.Single(r.Ledger.Due(r.Now));
        Assert.True(r.Ledger.Claim(job, r.Db.Generation, r.Now));
        if (state == "maybe_sent") r.Ledger.Recover(r.Now);
        if (state == "succeeded") r.Ledger.Complete(job, r.Db.Generation, new(RequestOutcome.Accepted(want.RequestId!, "looking"), Confirmed: true), r.Now);
        if (state == "parked") r.Ledger.Complete(job, r.Db.Generation, RequestBackendResult.Uncertain(want.RequestId!) with { Parked = true }, r.Now);
        var previous = r.Ledger.Find(want.RequestId!)!;
        r.Ledger.PurgeUser(r.Manager);
        var retained = Assert.Single(r.Ledger.ForWant(want.RequestId!));
        Assert.Equal(job.Id, retained.Id); Assert.Equal(state, retained.State); Assert.Null(retained.Authorization.Approver);
        Assert.Equal(previous.Status, r.Ledger.Find(want.RequestId!)!.Status);
        Assert.Equal(409, r.Service.Close(want.RequestId!, r.Kid, null).HttpStatus);
        // Work held after part of it was written resumes on an explicit approval: the same job and charge, still uncertain.
        Assert.Equal(state == "parked" ? 200 : 409, (await r.Service.ApproveAsync(want.RequestId!, r.Admin, null, default)).HttpStatus);
        Assert.Equal(1, r.Service.Quota(r.Kid).Used);
        if (state == "parked")
        {
            var resumed = Assert.Single(r.Ledger.ForWant(want.RequestId!));
            Assert.Equal((job.Id, "maybe_sent", true, (Guid?)r.Admin), (resumed.Id, resumed.State, resumed.Uncertain, resumed.Authorization.Approver));
            Assert.Equal(409, r.Service.Close(want.RequestId!, r.Kid, null).HttpStatus);
        }
        if (state == "sending")
        {
            Assert.True(r.Ledger.Complete(job, r.Db.Generation, new(RequestOutcome.Accepted(want.RequestId!, "looking"), Confirmed: true), r.Now));
            Assert.Equal("sent", r.Ledger.Find(want.RequestId!)!.Status);
            Assert.Equal(0, r.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM request_audit WHERE actor_id='" + r.Manager.ToString("N") + "'"; return Convert.ToInt32(cmd.ExecuteScalar()); }));
        }
        r.Reopen(); Assert.Equal(job.Id, Assert.Single(r.Ledger.ForWant(want.RequestId!)).Id);
    }

    [Theory]
    [InlineData("role")]
    [InlineData("generation")]
    [InlineData("flags")]
    [InlineData("preparation")]
    public async Task R3UncertainReadbackUsesOriginalGenerationAcrossRevocationAndRestore(string change)
    {
        using var r = new Rig(); var want = await r.Create(); var job = Assert.Single(r.Ledger.Due(r.Now));
        r.Ledger.Claim(job, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now);
        var original = r.Policy.People[r.Member];
        if (change == "role") r.Policy.People[r.Member] = original with { CanCreate = false };
        if (change == "generation") r.Policy.People[r.Member] = original with { ConnectionGeneration = "rotated" };
        if (change == "flags") r.Policy.Configuration.ArrPhase3Enabled = false;
        if (change == "preparation") r.Policy.Before = (_, _) => throw new InvalidOperationException();
        var backend = new ReadbackBackend();
        await r.Runner(backend).TickAsync(default);
        Assert.Equal(1, backend.Reads); Assert.Equal("maybe_sent", Assert.Single(r.Ledger.ForWant(want.RequestId!)).State);
        Assert.Equal("g1", backend.LastRead!.Authorization.ConnectionGeneration); Assert.Equal("r1", backend.LastRead.Authorization.InstanceId);
        r.Policy.People[r.Member] = original; r.Policy.Configuration.ArrPhase3Enabled = true; r.Policy.Before = null;
        backend.Confirm = true; r.Now = r.Now.AddMinutes(10);
        await r.Runner(backend).TickAsync(default);
        Assert.Equal(2, backend.Reads); Assert.Equal(0, backend.Sends); Assert.Equal("sent", r.Ledger.Find(want.RequestId!)!.Status);
    }

    [Fact]
    public async Task R3VerifiedNotSentStillReauthorizesBeforeRetry()
    {
        using var r = new Rig(); var want = await r.Create(); var job = Assert.Single(r.Ledger.Due(r.Now));
        r.Ledger.Claim(job, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { CanCreate = false };
        var backend = new ReadbackBackend { NotSent = true };
        await r.Runner(backend).TickAsync(default);
        Assert.Equal(1, backend.Reads); Assert.Equal("retry", Assert.Single(r.Ledger.ForWant(want.RequestId!)).State);
        r.Now = r.Now.AddMinutes(10); await r.Runner(backend).TickAsync(default);
        Assert.Equal(0, backend.Sends); Assert.Equal("authorization_changed", Assert.Single(r.Ledger.ForWant(want.RequestId!)).Reason);
    }

    [Fact]
    public async Task R3RecoveryMakesPreviouslyParkedUnknownJobsReadableAgain()
    {
        using var r = new Rig(); var want = await r.Create(); var job = Assert.Single(r.Ledger.Due(r.Now));
        r.Ledger.Claim(job, r.Db.Generation, r.Now);
        r.Ledger.Complete(job, r.Db.Generation, RequestBackendResult.Uncertain(job.WantId) with { Parked = true }, r.Now);
        r.Reopen(); r.Ledger.Recover(r.Now);
        await r.Runner().TickAsync(default);
        Assert.Equal(1, r.Backend.Reads); Assert.Equal(0, r.Backend.Sends); Assert.Equal("sent", r.Ledger.Find(want.RequestId!)!.Status);
    }

    private sealed class ReadbackBackend : IRequestBackend
    {
        public bool Confirm, NotSent;
        public int Reads, Sends;
        public RequestJob? LastRead;
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> guard, CancellationToken ct)
        { Sends++; return Task.FromResult(RequestBackendResult.Hold(guard() ?? "unexpected_send")); }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
        {
            Reads++; LastRead = job;
            return Task.FromResult(Confirm ? new(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true) :
                NotSent ? new(RequestOutcome.Refused("not_sent"), VerifiedNotSent: true) : RequestBackendResult.Uncertain(job.WantId));
        }
    }

    [Fact]
    public async Task R4MixedWantLosingSharedSeasonNeverConfirmsOrCoversIt()
    {
        using var r = new Rig(); var first = await r.Create(input: Seasons(1)); var secondUser = r.Add("Member");
        var mixed = await r.Create(secondUser, Seasons(1, 2));
        Assert.Equal(new[] { 2 }, Assert.Single(r.Ledger.ForWant(mixed.RequestId!)).Input.Seasons);
        Assert.Equal(200, r.Service.Close(first.RequestId!, r.Member, null).HttpStatus);
        Assert.Equal("pending", r.Ledger.Find(mixed.RequestId!)!.Status); Assert.Equal("removed", r.Ledger.Find(mixed.RequestId!)!.Reason);
        await r.Runner().TickAsync(default);
        Assert.Equal("succeeded", Assert.Single(r.Ledger.ForWant(mixed.RequestId!)).State);
        Assert.Equal("pending", r.Ledger.Find(mixed.RequestId!)!.Status);
        var thirdUser = r.Add("Member"); var third = await r.Create(thirdUser, Seasons(1));
        Assert.Equal(201, third.HttpStatus); Assert.Equal("accepted", third.Outcome);
        Assert.Equal(new[] { 1 }, Assert.Single(r.Ledger.ForWant(third.RequestId!)).Input.Seasons);
        Assert.Equal(1, r.Service.Quota(secondUser).Used); Assert.Equal(1, r.Service.Quota(thirdUser).Used);
    }

    [Fact]
    public async Task R4ReapprovingOrphanedMixedScopeOnlyAddsMissingSeasonAndRetainsCharge()
    {
        using var r = new Rig(); var first = await r.Create(input: Seasons(1)); var secondUser = r.Add("Member");
        var mixed = await r.Create(secondUser, Seasons(1, 2));
        r.Service.Close(first.RequestId!, r.Member, null); await r.Runner().TickAsync(default);
        r.Now = r.Now.AddDays(1);
        Assert.Equal(200, (await r.Service.ApproveAsync(mixed.RequestId!, r.Manager, null, default)).HttpStatus);
        Assert.Equal(new[] { 1 }, Assert.Single(r.Ledger.Due(r.Now)).Input.Seasons);
        Assert.Equal(2, r.Service.Quota(secondUser).Used); Assert.Equal(20, r.Service.Quota(secondUser).UsedGb);
        await r.Runner().TickAsync(default); Assert.Equal("sent", r.Ledger.Find(mixed.RequestId!)!.Status);
        r.Now = r.Now.AddDays(6); Assert.Equal(1, r.Service.Quota(secondUser).Used);
    }

    [Fact]
    public async Task R4MixedWantWaitsForAllJobsToConfirm()
    {
        using var r = new Rig(); var first = await r.Create(input: Seasons(1)); var mixed = await r.Create(r.Add("Member"), Seasons(1, 2));
        var partial = Assert.Single(r.Ledger.ForWant(mixed.RequestId!));
        r.Ledger.Claim(partial, r.Db.Generation, r.Now);
        r.Ledger.Complete(partial, r.Db.Generation, new(RequestOutcome.Accepted(partial.WantId, "looking"), Confirmed: true), r.Now);
        Assert.Equal("queued", r.Ledger.Find(mixed.RequestId!)!.Status);
        await r.Runner().TickAsync(default);
        Assert.Equal("sent", r.Ledger.Find(first.RequestId!)!.Status); Assert.Equal("sent", r.Ledger.Find(mixed.RequestId!)!.Status);
    }

    [Theory]
    [InlineData("Member")]
    [InlineData("Kid")]
    [InlineData("Manager")]
    [InlineData("Admin")]
    public async Task R5HardGbCapRefusesCreateForEveryRole(string role)
    {
        using var r = new Rig(); var user = r.Add(role); r.Policy.People[user] = r.Policy.People[user] with { GbLimit = 1 };
        var outcome = await r.Create(user);
        Assert.Equal(429, outcome.HttpStatus); Assert.Equal("quota_exceeded", outcome.Outcome); Assert.Equal("quota_exceeded", outcome.Reason);
        Assert.Empty(r.Ledger.List(user, false)); Assert.Empty(r.Ledger.Due(r.Now)); Assert.Equal(0, r.Service.Quota(user).UsedGb);
    }

    [Fact]
    public async Task R11ApproveCannotOverrideGbCapAndWritesNothing()
    {
        using var r = new Rig(); var pending = await r.Create(r.Kid);
        r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { GbLimit = 1 };
        var before = r.Ledger.Revision;
        var outcome = await r.Service.ApproveAsync(pending.RequestId!, r.Manager, null, default);
        Assert.Equal(429, outcome.HttpStatus); Assert.Equal("quota_exceeded", outcome.Outcome); Assert.Equal("quota_exceeded", outcome.Reason);
        Assert.Equal(before, r.Ledger.Revision); Assert.Empty(r.Ledger.ForWant(pending.RequestId!));
        Assert.Equal("pending", r.Ledger.Find(pending.RequestId!)!.Status); Assert.Equal(0, r.Service.Quota(r.Kid).UsedGb);
    }

    [Fact]
    public async Task R11ApprovedJobRechecksLoweredGbCap()
    {
        using var r = new Rig(); var pending = await r.Create(r.Kid);
        await r.Service.ApproveAsync(pending.RequestId!, r.Manager, null, default);
        r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { GbLimit = 1 };
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Backend.Sends); Assert.Equal("quota_exceeded", Assert.Single(r.Ledger.ForWant(pending.RequestId!)).Reason);
        Assert.Equal(8, r.Service.Quota(r.Kid).UsedGb);
        Assert.Equal("quota_exceeded", r.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT json_extract(outcome,'$.outcome') FROM jobs WHERE want_id=$id"; cmd.Parameters.AddWithValue("$id", pending.RequestId!); return (string)cmd.ExecuteScalar()!; }));
    }

    [Fact]
    public async Task R7DelayedApprovalsConsumeEpisodeAllowanceInChargeWindow()
    {
        using var r = new Rig(); var ids = new List<string>();
        for (var ep = 1; ep <= 10; ep++) ids.Add((await r.Create(r.Kid, Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, ep) } })).RequestId!);
        r.Now = r.Now.AddDays(8);
        foreach (var id in ids) Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, null, default)).HttpStatus);
        Assert.Equal(1, r.Service.Quota(r.Kid).Used);
        r.Reopen();
        Assert.Equal(1, r.Service.Quota(r.Kid).Used);
        r.Now = r.Now.AddDays(7);
        Assert.Equal(0, r.Service.Quota(r.Kid).Used);
        var next = await r.Create(r.Kid, Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 11) } });
        await r.Service.ApproveAsync(next.RequestId!, r.Manager, null, default);
        Assert.Equal(0, r.Service.Quota(r.Kid).Used);
    }

    [Fact]
    public void R7ExistingSchemaTwoGetsEpisodeCountOnceAndBackfillsOwnedScope()
    {
        using var r = new Rig(); var path = Path.Combine(r.Root, "old-schema2.db"); var user = Guid.NewGuid().ToString("N");
        var input = Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 2) } };
        using (var c = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + path))
        {
            c.Open(); using var cmd = c.CreateCommand();
            cmd.CommandText = AcquireDatabase.Migrations[0] + AcquireDatabase.Migrations[1].Replace("    episode_count INTEGER NOT NULL DEFAULT 0,\n", "", StringComparison.Ordinal) + " PRAGMA user_version=2;";
            cmd.ExecuteNonQuery();
            cmd.CommandText = "INSERT INTO acquisitions VALUES('a',$key,'standard','active',1); INSERT INTO wants(id,acquisition_id,user_id,client_request_id,fingerprint,title_key,variant,mutation_input,owned_input,status,reason,cost,parental_signature,created_at,updated_at) VALUES('w','a',$u,'k','f',$key,'standard',$input,$input,'queued','queued_outage',0,'null',1,1); INSERT INTO reservations(id,want_id,user_id,cost,estimated_gb,state,charged_at,scope) VALUES('r','w',$u,0,2,'charged',1,'initial');";
            cmd.Parameters.AddWithValue("$key", input.Key); cmd.Parameters.AddWithValue("$u", user); cmd.Parameters.AddWithValue("$input", input.Canonical); cmd.ExecuteNonQuery();
        }
        for (var pass = 0; pass < 2; pass++)
        {
            using var db = new AcquireDatabase(path); Assert.True(db.Available); Assert.Equal(AcquireDatabase.Migrations.Count, db.Version);
            Assert.Equal(2, db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT episode_count FROM reservations WHERE id='r'"; return Convert.ToInt32(cmd.ExecuteScalar()); }));
        }
        Assert.Single(Directory.GetFiles(r.Root, "old-schema2.db.pre-v2.*"));
    }

    [Fact]
    public async Task R8ReplayingCancelledApproverKeyCannotApproveSomeoneElsesWant()
    {
        using var r = new Rig(); var original = await r.Create(r.Admin, client: "replay");
        Assert.Equal(200, r.Service.Close(original.RequestId!, r.Admin, null).HttpStatus);
        var pending = await r.Create(r.Kid); var revision = r.Ledger.Revision;
        var replay = await r.Create(r.Admin, client: "replay");
        Assert.Equal(200, replay.HttpStatus); Assert.Equal(original.RequestId, replay.RequestId); Assert.Equal("cancelled", replay.Reason);
        Assert.Equal(revision, r.Ledger.Revision); Assert.Equal("pending", r.Ledger.Find(pending.RequestId!)!.Status);
        Assert.Empty(r.Ledger.ForWant(pending.RequestId!)); Assert.Equal(0, r.Service.Quota(r.Kid).Used);
    }

    [Fact]
    public async Task R9RequesterChangeDuringApproverReadStopsSend()
    {
        using var r = new Rig(); var pending = await r.Create(r.Kid);
        await r.Service.ApproveAsync(pending.RequestId!, r.Manager, null, default);
        var timeout = TimeSpan.FromMinutes(2);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim(); var approverReads = 0;
        r.Policy.Adjust = (user, _, facts) =>
        {
            if (user == r.Manager && Interlocked.Increment(ref approverReads) == 2)
            {
                entered.SetResult();
                Assert.True(release.Wait(timeout), "The test did not release the held approver read.");
            }
            return facts;
        };
        // Evaluate is synchronous. Give its held read a dedicated thread so it cannot starve
        // the continuation that changes the requester and releases it on a busy test host.
        var tick = Task.Factory.StartNew(() => r.Runner().TickAsync(default),
            CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
        try
        {
            await Task.WhenAny(entered.Task, tick).WaitAsync(timeout);
            Assert.True(entered.Task.IsCompletedSuccessfully, "The outbox finished before the approver read was held.");
            Assert.False(tick.IsCompleted);
            Assert.True(r.Policy.People[r.Kid].CanCreate);
            r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { CanCreate = false, Revision = "revoked" };
        }
        finally
        {
            release.Set();
            await tick.WaitAsync(timeout);
        }
        Assert.Equal(0, r.Backend.Sends); Assert.Equal("authorization_changed", Assert.Single(r.Ledger.ForWant(pending.RequestId!)).Reason);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task R12NonAdminRoutingIsRejectedBeforePreparationOrEvaluation(bool approval)
    {
        using var r = new Rig(); var pending = await r.Create(r.Kid); var reads = 0;
        r.Policy.Before = (_, _) => { reads++; throw new InvalidOperationException("Routing must not be read"); };
        r.Policy.Adjust = (_, input, facts) => { reads++; return facts with { Refusal = input.RootFolder == "/valid" ? "low_disk" : "invalid_defaults" }; };
        foreach (var input in new[] { Movie() with { RootFolder = "/valid", ProfileId = 1 }, Movie() with { RootFolder = "/invalid", ProfileId = 999 }, Movie() with { InstanceId = "guessed" } })
        {
            var result = approval ? await r.Service.ApproveAsync(pending.RequestId!, r.Manager, new(input), default) : await r.Create(input: input);
            Assert.Equal(403, result.HttpStatus); Assert.Equal("admin_required", result.Reason);
            var direct = approval ? r.Ledger.Approve(pending.RequestId!, r.Manager, input, r.Policy, r.Now) : r.Ledger.Create(r.Member, new(Guid.NewGuid().ToString("N"), input), r.Policy, r.Now);
            Assert.Equal(403, direct.HttpStatus); Assert.Equal("admin_required", direct.Reason);
        }
        Assert.Equal(0, reads); Assert.Empty(r.Ledger.Due(r.Now));
    }

    private static Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest.PlaybackTrigger R6Trigger(string key)
        => new(key, Guid.NewGuid(), "user", new MediaBrowser.Controller.Entities.Movies.Movie());

    [Fact]
    public async Task R6PlaybackHandoffKeepsCompletionBehindMoreThan128Events()
    {
        var logs = new List<string>();
        var executed = 0; var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var queue = new Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest.PlaybackTriggerChannel(1024, async (t, _) =>
        {
            if (t.Key == "first") { entered.SetResult(); await release.Task; }
            else if (t.Key == "stopped") completed.SetResult();
            else Interlocked.Increment(ref executed);
        }, logs.Add);
        Assert.True(queue.TryWrite(R6Trigger("first")));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (var i = 0; i < 256; i++) Assert.True(queue.TryWrite(R6Trigger("progress-" + i)));
        // Thousands of repeats of waiting progress triggers coalesce instead of filling the queue.
        for (var i = 0; i < 5000; i++) Assert.True(queue.TryWrite(R6Trigger("progress-" + (i % 256))));
        Assert.True(queue.TryWrite(R6Trigger("stopped")));
        release.SetResult(); await completed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(256, executed); Assert.Empty(logs);
        Assert.Equal(5000, queue.Coalesced); Assert.Equal(0, queue.Dropped);
    }

    [Fact]
    public async Task R6PlaybackLogsClosedAdmissionAndWorkFailures()
    {
        var logs = new List<string>();
        var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var queue = new Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest.PlaybackTriggerChannel(16, (t, _) =>
        {
            if (t.Key == "boom") throw new InvalidOperationException();
            complete.SetResult(); return Task.CompletedTask;
        }, logs.Add);
        queue.TryWrite(R6Trigger("boom"));
        queue.TryWrite(R6Trigger("ok"));
        await complete.Task.WaitAsync(TimeSpan.FromSeconds(5));
        queue.Dispose(); Assert.Single(logs); Assert.Contains("work failed", logs[0], StringComparison.Ordinal);
        Assert.False(queue.TryWrite(R6Trigger("late"))); Assert.Equal(2, logs.Count); Assert.Contains("admission failed", logs[1], StringComparison.Ordinal);
    }
}

[Collection("Plugin singleton")]
public class IntegrationRequestReviewRound1ProductionTests
{
    [Fact]
    public async Task R9ProductionPolicyRechecksRequesterAfterBlockedApproverCopyRead()
    {
        using var arr = new FakeArr(); arr.Add("movies.invalid", "Radarr"); arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je";
        var jf = new FakeJellyfinView(); var kid = jf.AddUser(false); var manager = jf.AddUser(false);
        config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [kid.UserId.ToString("N")] = new { Role = "Kid" }, [manager.UserId.ToString("N")] = new { Role = "Manager" } });
        var users = new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>();
        users.Setup(u => u.GetUserById(kid.UserId)).Returns((Jellyfin.Database.Implementations.Entities.User)kid.Handle!);
        users.Setup(u => u.GetUserById(manager.UserId)).Returns((Jellyfin.Database.Implementations.Entities.User)manager.Handle!);
        var parental = new SeerrParentalFilter(arr.Transport, users.Object, Moq.Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), Moq.Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(), arr.Plugin.Core.Logger);
        using var store = arr.Store(); var libraries = new ArrInstanceLibraries(store, new FakeLibraryAccess()); var aliases = new TitleAliases(store, null);
        var backend = new Backend(); var policy = new RequestPolicy(jf, store, libraries, aliases, parental, arr.Factory, backend);
        using var db = new AcquireDatabase(Path.Combine(arr.Plugin.Core.Root, "review-race.db")); var ledger = new RequestLedger(db);
        var service = new RequestService(ledger, policy, jf, new Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrChangeFeed(), aliases);
        var pending = await service.CreateAsync(kid.UserId, new("race", Movie()), default);
        Assert.Equal(201, pending.HttpStatus); Assert.Equal(200, (await service.ApproveAsync(pending.RequestId!, manager.UserId, null, default)).HttpStatus);
        Guid current = Guid.Empty; var blocked = 0;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); using var release = new ManualResetEventSlim();
        jf.OnViewer = user => current = user;
        jf.OnCopies = () => { if (current == manager.UserId && Interlocked.Increment(ref blocked) == 2) { entered.SetResult(); Assert.True(release.Wait(TimeSpan.FromSeconds(10))); } };
        var runner = new RequestOutbox(ledger, policy, backend, new RequestTitleLocks(), new Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrChangeFeed(), new ArrAuditLog(Path.Combine(arr.Plugin.Core.Root, "review-audit.jsonl"), 100000, 1));
        var tick = Task.Run(() => runner.TickAsync(default));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            jf.Users.Remove(kid.UserId);
        }
        finally { release.Set(); }
        await tick;
        Assert.Equal(0, backend.Sends); Assert.Equal("identity_changed", Assert.Single(ledger.ForWant(pending.RequestId!)).Reason);
    }
}
