using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.Data.Sqlite;
using static JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

public class IntegrationRequestReviewRound3Tests
{
    private static void Finish(Rig r, RequestJob job, RequestBackendResult result)
    {
        Assert.True(r.Ledger.Claim(job, r.Db.Generation, r.Now));
        Assert.True(r.Ledger.Complete(job, r.Db.Generation, result, r.Now));
    }
    private static void Confirm(Rig r, RequestJob job) => Finish(r, job, new(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true));
    private static void Sql(Rig r, string sql, params (string, object?)[] args)
        => r.Db.Write((c, t) => { using var cmd = RequestLedger.Cmd(c, t, sql, args); return cmd.ExecuteNonQuery(); });
    private static void Rotate(Rig r)
    {
        foreach (var user in r.Policy.People.Keys.ToArray())
            r.Policy.People[user] = r.Policy.People[user] with { ConnectionGeneration = "g2" };
    }
    private static int Charged(Rig r, string job) => r.Db.Read(c =>
    {
        using var cmd = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM reservations WHERE job_id=$j AND state='charged'", ("$j", job));
        return Convert.ToInt32(cmd.ExecuteScalar());
    });
    private static async Task<(string Id, Guid User)> Mixed(Rig r)
    {
        var first = await r.Create(input: Seasons(1)); var user = r.Add("Member");
        var mixed = await r.Create(user, Seasons(1, 2));
        r.Service.Close(first.RequestId!, r.Member, null);
        return (mixed.RequestId!, user);
    }

    [Theory]
    [InlineData("instance_changed")]
    [InlineData("authorization_changed")]
    public async Task V1HeldOwnerDemotesThenReleasesFollowersOnUneditedReapproval(string reason)
    {
        using var r = new Rig(); var owner = await r.Create(); var user = r.Add("Member");
        var follower = await r.Create(user); var old = Assert.Single(r.Ledger.ForWant(owner.RequestId!));
        if (reason == "instance_changed") Rotate(r);
        else r.Policy.Configuration.ArrRequestPreset = "approve_everything";
        await r.Runner().TickAsync(default);
        Assert.Equal("parked", Assert.Single(r.Ledger.ForWant(owner.RequestId!)).State);
        Assert.Equal("pending", r.Ledger.Find(follower.RequestId!)!.Status);
        Assert.Equal(reason, r.Ledger.Find(follower.RequestId!)!.Reason);
        Assert.Equal(200, (await r.Service.ApproveAsync(owner.RequestId!, r.Manager, null, default)).HttpStatus);
        var current = Assert.Single(r.Ledger.ForWant(owner.RequestId!), j => j.State == "queued");
        Assert.Equal(r.Ledger.Find(owner.RequestId!)!.TargetKey, r.Ledger.Find(follower.RequestId!)!.TargetKey);
        Assert.Equal("queued", r.Ledger.Find(follower.RequestId!)!.Status);
        Confirm(r, current);
        Assert.Equal("sent", r.Ledger.Find(follower.RequestId!)!.Status);
        Assert.Empty(r.Ledger.ForWant(follower.RequestId!)); Assert.Equal(0, r.Service.Quota(user).Used);
        Assert.NotEqual(old.Id, current.Id);
    }

    [Fact]
    public async Task V1UneditedTargetChangeReplacesRetryScopeBeforeGbCapAndRehomesFollowers()
    {
        using var r = new Rig(); var first = await r.Create(input: Seasons(1)); var user = r.Add("Member");
        var mixed = await r.Create(user, Seasons(1, 2)); var old = Assert.Single(r.Ledger.ForWant(mixed.RequestId!));
        Finish(r, old, new(RequestOutcome.Refused("backend_unavailable", 503), Retryable: true, VerifiedNotSent: true));
        var thirdUser = r.Add("Member"); var follower = await r.Create(thirdUser, Seasons(2));
        r.Service.Close(first.RequestId!, r.Member, null); Rotate(r);
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = 20 };
        Assert.Equal(200, (await r.Service.ApproveAsync(mixed.RequestId!, r.Manager, null, default)).HttpStatus);
        Assert.Equal("cancelled", r.Ledger.ForWant(mixed.RequestId!).Single(j => j.Id == old.Id).State);
        Assert.Equal(0, Charged(r, old.Id));
        var current = Assert.Single(r.Ledger.ForWant(mixed.RequestId!), j => j.State == "queued");
        Assert.Equal(new[] { 1, 2 }, current.Input.Seasons); Assert.Equal("g2", current.Authorization.ConnectionGeneration);
        Assert.Equal(2, r.Service.Quota(user).Used); Assert.Equal(20, r.Service.Quota(user).UsedGb);
        Assert.Equal(2, r.Ledger.Find(mixed.RequestId!)!.Cost);
        Assert.Equal(r.Ledger.Find(mixed.RequestId!)!.TargetKey, r.Ledger.Find(follower.RequestId!)!.TargetKey);
        Confirm(r, current); Assert.Equal("sent", r.Ledger.Find(follower.RequestId!)!.Status);
        r.Now = r.Now.AddMinutes(10); await r.Runner().TickAsync(default);
        Assert.Equal("sent", r.Ledger.Find(mixed.RequestId!)!.Status);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task V1OldTargetCompletionCannotOverwriteRetargetedWant(bool confirmed, bool queued)
    {
        using var r = new Rig(); var want = await r.Create(); var old = Assert.Single(r.Ledger.ForWant(want.RequestId!));
        // Seed a late old-target job as left by an earlier implementation. Its immutable context remains g1.
        Assert.True(r.Ledger.Claim(old, r.Db.Generation, r.Now));
        var target = RequestLedger.TargetKey(old.Authorization with { ConnectionGeneration = "g2" });
        Sql(r, "UPDATE wants SET target_key=$t,status=$s,reason=$r WHERE id=$w", ("$t", target),
            ("$s", confirmed || queued ? "queued" : "sent"), ("$r", confirmed || queued ? "queued_outage" : "looking"), ("$w", want.RequestId!));
        var before = JsonSerializer.Serialize(r.Ledger.Find(want.RequestId!));
        var result = confirmed ? new RequestBackendResult(RequestOutcome.Accepted(old.WantId, "looking"), Confirmed: true) : RequestBackendResult.Hold("instance_changed");
        Assert.True(r.Ledger.Complete(old, r.Db.Generation, result, r.Now));
        Assert.Equal(before, JsonSerializer.Serialize(r.Ledger.Find(want.RequestId!)));
        Assert.Equal(1, Charged(r, old.Id));
    }

    [Fact]
    public async Task V1AlreadyConfirmedReplacementTargetCompletesOwnerAndRehomedFollowers()
    {
        using var r = new Rig(); var owner = await r.Create(r.Kid); var user = r.Add("Kid");
        var follower = await r.Create(user); Rotate(r);
        var replacement = await r.Create(r.Admin); Confirm(r, Assert.Single(r.Ledger.ForWant(replacement.RequestId!)));
        Assert.Equal(200, (await r.Service.ApproveAsync(owner.RequestId!, r.Manager, null, default)).HttpStatus);
        Assert.Equal("sent", r.Ledger.Find(owner.RequestId!)!.Status); Assert.Equal("sent", r.Ledger.Find(follower.RequestId!)!.Status);
        Assert.Equal(r.Ledger.Find(owner.RequestId!)!.TargetKey, r.Ledger.Find(follower.RequestId!)!.TargetKey);
        Assert.Empty(r.Ledger.ForWant(owner.RequestId!)); Assert.Empty(r.Ledger.ForWant(follower.RequestId!));
        Assert.Equal(0, r.Service.Quota(r.Kid).Used); Assert.Equal(0, r.Service.Quota(user).Used);
    }

    [Theory]
    [InlineData("missing_columns")]
    [InlineData("existing_columns")]
    [InlineData("ambiguous_live")]
    public async Task V2SchemaTwoPrefersLiveTargetAndRepairsExistingEmptyKeysOnce(string fixture)
    {
        using var r = new Rig(); var want = await r.Create(); var old = Assert.Single(r.Ledger.ForWant(want.RequestId!));
        Finish(r, old, RequestBackendResult.Hold("instance_changed")); Rotate(r); r.Now = r.Now.AddMinutes(1);
        Assert.Equal(200, (await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default)).HttpStatus);
        var current = Assert.Single(r.Ledger.ForWant(want.RequestId!), j => j.State == "queued");
        Sql(r, "UPDATE jobs SET state=$s WHERE id=$j; UPDATE wants SET target_key='' WHERE id=$w; DELETE FROM meta WHERE key='request_target_repair_v3';",
            ("$s", fixture == "ambiguous_live" ? "queued" : "parked"), ("$j", old.Id), ("$w", want.RequestId!));
        var path = Path.Combine(r.Root, "v2.db"); File.WriteAllBytes(path, r.Db.Snapshot()!);
        if (fixture == "missing_columns")
        {
            using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"); c.Open(); using var cmd = c.CreateCommand();
            cmd.CommandText = "ALTER TABLE wants DROP COLUMN target_key; ALTER TABLE reservations DROP COLUMN job_id;"; cmd.ExecuteNonQuery();
        }
        for (var pass = 0; pass < 2; pass++)
        {
            using var db = new AcquireDatabase(path); Assert.True(db.Available); Assert.Equal(2, db.Version);
            var ledger = new RequestLedger(db); var stored = ledger.Find(want.RequestId!)!;
            Assert.NotEmpty(stored.TargetKey);
            if (fixture == "ambiguous_live")
            {
                Assert.Equal("pending", stored.Status); Assert.Equal("instance_changed", stored.Reason);
                Assert.All(ledger.ForWant(stored.Id), j => Assert.Equal("parked", j.State));
                Assert.Empty(ledger.Due(r.Now));
            }
            else
            {
                Assert.Equal(RequestLedger.TargetKey(current.Authorization), stored.TargetKey);
                var user = r.Add("Member"); r.Policy.People[user] = r.Policy.People[user] with { ConnectionGeneration = "g2" };
                var follower = ledger.Create(user, new("v2-follower-" + pass, Movie()), r.Policy, r.Now);
                Assert.Equal(201, follower.HttpStatus); Assert.True(ledger.Find(follower.RequestId!)!.Follower);
                Assert.Empty(ledger.ForWant(follower.RequestId!));
            }
        }
        Assert.Single(Directory.GetFiles(r.Root, "v2.db.pre-v2.*"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task V2RepairOfPreviouslySentEmptyTargetRechecksTheWholeCurrentScope(bool otherQueued)
    {
        using var r = new Rig(); var first = await r.Create(input: Seasons(1)); var user = r.Add("Member");
        var want = await r.Create(user, Seasons(1, 2)); Confirm(r, Assert.Single(r.Ledger.ForWant(first.RequestId!)));
        Finish(r, Assert.Single(r.Ledger.ForWant(want.RequestId!)), RequestBackendResult.Hold("instance_changed"));
        Rotate(r); await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default);
        var current = Assert.Single(r.Ledger.ForWant(want.RequestId!), j => j.State == "queued"); var partial = Seasons(2).Normalize()!;
        // Round-1 coverage could borrow S1 from g1, send only S2 to g2, and round 2's empty key skipped the full-scope check.
        Sql(r, "UPDATE jobs SET mutation_input=$i,fingerprint=$f,state='succeeded' WHERE id=$j; UPDATE wants SET owned_input=$i,status='sent',cost=1,target_key='' WHERE id=$w; UPDATE reservations SET cost=1,estimated_gb=10 WHERE job_id=$j; DELETE FROM meta WHERE key='request_target_repair_v3';",
            ("$i", partial.Canonical), ("$f", partial.Fingerprint), ("$j", current.Id), ("$w", want.RequestId!));
        if (otherQueued)
        {
            var other = r.Add("Member"); r.Policy.People[other] = r.Policy.People[other] with { ConnectionGeneration = "g2" };
            Assert.Equal(201, (await r.Create(other, Seasons(1))).HttpStatus);
        }
        var path = Path.Combine(r.Root, "partial-v2.db"); File.WriteAllBytes(path, r.Db.Snapshot()!);
        using var db = new AcquireDatabase(path); Assert.True(db.Available); var ledger = new RequestLedger(db);
        Assert.Equal("pending", ledger.Find(want.RequestId!)!.Status); Assert.Equal("instance_changed", ledger.Find(want.RequestId!)!.Reason);
        Assert.Equal(RequestLedger.TargetKey(current.Authorization), ledger.Find(want.RequestId!)!.TargetKey);
        Assert.Equal("succeeded", ledger.ForWant(want.RequestId!).Single(j => j.Id == current.Id).State);
        Assert.Equal(1, ledger.Quota(r.Policy.Evaluate(user, Seasons(1, 2)), r.Now).Used);
        Assert.Equal(200, ledger.Approve(want.RequestId!, r.Admin, null, r.Policy, r.Now).HttpStatus);
        Assert.Equal(new[] { 1 }, Assert.Single(ledger.Due(r.Now)).Input.Seasons);
        Assert.Equal(otherQueued ? 10 : 20, ledger.Quota(r.Policy.Evaluate(user, Seasons(1, 2)), r.Now).UsedGb);
    }

    [Fact]
    public async Task V2AmbiguousUnknownTargetKeepsReadbackAndFencesAnotherAsk()
    {
        using var r = new Rig(); var owner = await r.Create(); var old = Assert.Single(r.Ledger.ForWant(owner.RequestId!));
        Finish(r, old, RequestBackendResult.Hold("instance_changed")); Rotate(r); r.Now = r.Now.AddMinutes(1);
        await r.Service.ApproveAsync(owner.RequestId!, r.Manager, null, default);
        Sql(r, "UPDATE jobs SET state='parked',outcome=$o WHERE id=$j; UPDATE wants SET target_key='' WHERE id=$w; DELETE FROM meta WHERE key='request_target_repair_v3';",
            ("$o", JsonSerializer.Serialize(RequestBackendResult.Uncertain(owner.RequestId!).Outcome)), ("$j", old.Id), ("$w", owner.RequestId!));
        var path = Path.Combine(r.Root, "unknown-v2.db"); File.WriteAllBytes(path, r.Db.Snapshot()!);
        using var db = new AcquireDatabase(path); Assert.True(db.Available); var ledger = new RequestLedger(db);
        Assert.NotEmpty(ledger.Find(owner.RequestId!)!.TargetKey); Assert.Equal("pending", ledger.Find(owner.RequestId!)!.Status);
        Assert.Equal("parked", ledger.ForWant(owner.RequestId!).Single(j => j.Id == old.Id).State);
        var user = r.Add("Member"); var revision = ledger.Revision;
        Assert.Equal(409, ledger.Create(user, new("unknown-follow", Movie()), r.Policy, r.Now).HttpStatus);
        Assert.Equal(revision, ledger.Revision); Assert.Empty(ledger.List(user, false));
        ledger.Recover(r.Now); var due = Assert.Single(ledger.Due(r.Now)); Assert.Equal(old.Id, due.Id);
        Assert.Equal("g1", due.Authorization.ConnectionGeneration);
        Assert.Equal(1, ledger.Quota(r.Policy.Evaluate(r.Member, Movie()), r.Now).Used);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task V3ParkedSupplementalApprovalIsRefundedBeforeEditedOrUneditedReplacement(bool edited)
    {
        using var r = new Rig(); var (id, user) = await Mixed(r); var succeeded = Assert.Single(r.Ledger.ForWant(id));
        Confirm(r, succeeded); await r.Service.ApproveAsync(id, r.Manager, null, default);
        var old = Assert.Single(r.Ledger.ForWant(id), j => j.State == "queued");
        r.Policy.People[r.Manager] = r.Policy.People[r.Manager] with { Role = "Member", CanApprove = false };
        await r.Runner().TickAsync(default);
        Assert.Equal("parked", r.Ledger.ForWant(id).Single(j => j.Id == old.Id).State); Assert.Equal(1, Charged(r, old.Id));
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = edited ? 30 : 20 };
        var input = edited ? new ApproveRequest(Seasons(1, 2, 3)) : null;
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Admin, input, default)).HttpStatus);
        Assert.Equal("cancelled", r.Ledger.ForWant(id).Single(j => j.Id == old.Id).State); Assert.Equal(0, Charged(r, old.Id));
        Assert.Equal(1, Charged(r, succeeded.Id));
        Assert.Equal(edited ? 3 : 2, r.Service.Quota(user).Used); Assert.Equal(edited ? 30 : 20, r.Service.Quota(user).UsedGb);
        Assert.Equal(edited ? 3 : 2, r.Ledger.Find(id)!.Cost);
        // The same reconciliation must never replace parked Unknown work or its charge.
        var uncertain = await r.Create(r.Kid, Movie(900)); await r.Service.ApproveAsync(uncertain.RequestId!, r.Admin, null, default);
        Finish(r, Assert.Single(r.Ledger.ForWant(uncertain.RequestId!)), RequestBackendResult.Uncertain(uncertain.RequestId!) with { Parked = true });
        Assert.Equal(409, (await r.Service.ApproveAsync(uncertain.RequestId!, r.Admin, null, default)).HttpStatus);
        Assert.Equal(1, r.Service.Quota(r.Kid).Used); Assert.Equal("parked", Assert.Single(r.Ledger.ForWant(uncertain.RequestId!)).State);
    }

    [Fact]
    public async Task V3RefusedReplacementRollsBackRefundAndCanBeRetriedAtCorrectCap()
    {
        using var r = new Rig(); var (id, user) = await Mixed(r); Confirm(r, Assert.Single(r.Ledger.ForWant(id)));
        await r.Service.ApproveAsync(id, r.Manager, null, default);
        var old = Assert.Single(r.Ledger.ForWant(id), j => j.State == "queued");
        Finish(r, old, RequestBackendResult.Hold("authorization_changed"));
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = 15 };
        var revision = r.Ledger.Revision;
        Assert.Equal(429, (await r.Service.ApproveAsync(id, r.Admin, null, default)).HttpStatus);
        Assert.Equal(revision, r.Ledger.Revision); Assert.Equal(1, Charged(r, old.Id));
        Assert.Equal("parked", r.Ledger.ForWant(id).Single(j => j.Id == old.Id).State);
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = 20 };
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Admin, null, default)).HttpStatus);
        Assert.Equal(20, r.Service.Quota(user).UsedGb); Assert.Equal(0, Charged(r, old.Id));
    }

    [Theory]
    [InlineData("readback")]
    [InlineData("before_guard")]
    public async Task V4DeletedRequesterNotSentCancelsOnlyUnsentIntentAndUnstrandsFollower(string path)
    {
        using var r = new Rig(); var owner = await r.Create(r.Kid); await r.Service.ApproveAsync(owner.RequestId!, r.Manager, null, default);
        var user = r.Add("Member"); var follower = await r.Create(user); var job = Assert.Single(r.Ledger.ForWant(owner.RequestId!));
        void Delete() { r.Ledger.PurgeUser(r.Kid); r.Policy.People.Remove(r.Kid); }
        var backend = new NotSentBackend(job.Id);
        if (path == "readback") { r.Ledger.Claim(job, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now); Delete(); }
        else r.Policy.Before = (who, _) => { if (who == r.Kid) Delete(); return Task.CompletedTask; };
        await r.Runner(backend).TickAsync(default);
        var retained = Assert.Single(r.Ledger.ForWant(owner.RequestId!));
        Assert.Equal("cancelled", retained.State); Assert.Equal(0, Charged(r, job.Id));
        Assert.Equal("cancelled", r.Ledger.Find(owner.RequestId!)!.Status); Assert.Equal(0, r.Ledger.Find(owner.RequestId!)!.Cost);
        Assert.Equal("cancelled", r.Ledger.Find(follower.RequestId!)!.Status); Assert.Equal("removed", r.Ledger.Find(follower.RequestId!)!.Reason);
        Assert.Equal(0, backend.Sends); Assert.Equal(path == "readback" ? 1 : 0, backend.Reads);
        Assert.Equal(1, r.Db.Read(c => { using var cmd = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM request_audit WHERE job_id=$j AND action='dispatch'", ("$j", job.Id)); return Convert.ToInt32(cmd.ExecuteScalar()); }));
        var again = await r.Create(user); Assert.Equal(201, again.HttpStatus); Assert.NotEqual(follower.RequestId, again.RequestId);
        Assert.Single(r.Ledger.ForWant(again.RequestId!)); Assert.Equal(1, r.Service.Quota(user).Used);
        r.Now = r.Now.AddMinutes(10); await r.Runner(backend).TickAsync(default);
        Assert.Equal(1, backend.Sends); // Only the new, live requester's job is eligible to send.
    }

    [Theory]
    [InlineData("succeeded")]
    [InlineData("unknown")]
    public async Task V4NotSentDeletedJobPreservesOtherSendCertaintyAndItsFollowers(string certainty)
    {
        using var r = new Rig(); var (id, user) = await Mixed(r); var owned = Assert.Single(r.Ledger.ForWant(id));
        r.Policy.People[user] = r.Policy.People[user] with { SeerrUser = 47 };
        await r.Service.ApproveAsync(id, r.Manager, null, default);
        var missing = Assert.Single(r.Ledger.ForWant(id), j => j.Id != owned.Id);
        var broad = await r.Create(r.Add("Member"), Seasons(1, 2)); var narrow = await r.Create(r.Add("Member"), Seasons(2));
        Finish(r, owned, certainty == "succeeded" ? new(RequestOutcome.Accepted(id, "looking"), Confirmed: true) : RequestBackendResult.Uncertain(id));
        r.Ledger.Claim(missing, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now); r.Ledger.PurgeUser(user); r.Policy.People.Remove(user);
        var backend = new NotSentBackend(missing.Id); await r.Runner(backend).TickAsync(default);
        Assert.Equal("cancelled", r.Ledger.ForWant(id).Single(j => j.Id == missing.Id).State); Assert.Equal(0, Charged(r, missing.Id));
        Assert.Equal(certainty == "succeeded" ? "succeeded" : "maybe_sent", r.Ledger.ForWant(id).Single(j => j.Id == owned.Id).State);
        Assert.Equal(1, Charged(r, owned.Id)); Assert.Equal(1, r.Ledger.Find(id)!.Cost);
        Assert.Equal("cancelled", r.Ledger.Find(broad.RequestId!)!.Status);
        Assert.Equal(certainty == "succeeded" ? "sent" : "queued", r.Ledger.Find(narrow.RequestId!)!.Status);
        Assert.Equal(47, backend.LastRead!.Authorization.SeerrUser); Assert.NotEqual(user, backend.LastRead.Authorization.Requester);
        Assert.Equal(0, backend.Sends);
    }

    private sealed class NotSentBackend(string absent) : IRequestBackend
    {
        public int Reads, Sends;
        public RequestJob? LastRead;
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> guard, CancellationToken ct)
        {
            if (guard() is { } refusal) return Task.FromResult(RequestBackendResult.Hold(refusal));
            Sends++; return Task.FromResult(new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true));
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
        {
            Reads++; LastRead = job;
            return Task.FromResult(job.Id == absent ? new RequestBackendResult(RequestOutcome.Refused("not_sent"), VerifiedNotSent: true) : RequestBackendResult.Uncertain(job.WantId));
        }
    }
}
