using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using static JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

public class IntegrationRequestReviewRound2Tests
{
    private static void Confirm(Rig r, RequestJob job)
    {
        Assert.True(r.Ledger.Claim(job, r.Db.Generation, r.Now));
        Assert.True(r.Ledger.Complete(job, r.Db.Generation, new(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true), r.Now));
    }

    [Theory]
    [InlineData("generation")]
    [InlineData("backend")]
    [InlineData("source")]
    public async Task S1ChangedTargetAfterSuccessCreatesCompletableOwnedJob(string change)
    {
        using var r = new Rig(); var first = await r.Create();
        Confirm(r, Assert.Single(r.Ledger.ForWant(first.RequestId!)));
        var secondUser = r.Add("Member");
        if (change == "generation") r.Policy.People[secondUser] = r.Policy.People[secondUser] with { ConnectionGeneration = "g2" };
        if (change == "backend") r.Policy.Configuration.ArrRequestBackend = "seerr";
        if (change == "source") r.Policy.People[secondUser] = r.Policy.People[secondUser] with { SeerrSource = "other-source" };
        var second = await r.Create(secondUser);
        var job = Assert.Single(r.Ledger.ForWant(second.RequestId!));
        Assert.False(r.Ledger.Find(second.RequestId!)!.Follower);
        Confirm(r, job); Assert.Equal("sent", r.Ledger.Find(second.RequestId!)!.Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task S1AlternateInstanceDoesNotFollowOrCompleteFromOriginalJob(bool uncertain)
    {
        using var r = new Rig(); var first = await r.Create(); var old = Assert.Single(r.Ledger.ForWant(first.RequestId!));
        if (uncertain) { r.Ledger.Claim(old, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now); }
        r.Policy.Adjust = (_, input, facts) => facts with { InstanceId = input.InstanceId ?? "r1" };
        var second = await r.Create(r.Admin, Movie() with { InstanceId = "r2" });
        Assert.Equal(201, second.HttpStatus);
        var alternate = Assert.Single(r.Ledger.ForWant(second.RequestId!)); Assert.Equal("r2", alternate.Authorization.InstanceId);
        if (uncertain)
        {
            var backend = new ReadbackBackend(); await r.Runner(backend).TickAsync(default);
            Assert.Equal("r1", Assert.Single(backend.Reads).Authorization.InstanceId);
            Assert.Equal("g1", backend.Reads[0].Authorization.ConnectionGeneration);
        }
        else Confirm(r, old);
        Assert.Equal("queued", r.Ledger.Find(second.RequestId!)!.Status);
        if (uncertain) { r.Now = r.Now.AddMinutes(10); alternate = Assert.Single(r.Ledger.ForWant(second.RequestId!)); }
        Confirm(r, alternate); Assert.Equal("sent", r.Ledger.Find(second.RequestId!)!.Status);
    }

    private static async Task<(string Id, Guid User)> Orphan(Rig r, MutationInput? firstInput = null, MutationInput? mixedInput = null)
    {
        r.Policy.People[r.Manager] = r.Policy.People[r.Manager] with { Can4k = true };
        var first = await r.Create(input: firstInput ?? Seasons(1)); var user = r.Add("Member");
        var mixed = await r.Create(user, mixedInput ?? Seasons(1, 2));
        Assert.Equal(200, r.Service.Close(first.RequestId!, r.Member, null).HttpStatus);
        Assert.Equal("pending", r.Ledger.Find(mixed.RequestId!)!.Status);
        return (mixed.RequestId!, user);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task S2EditedOrphanReplacesUnsentScopeAndCharges(bool fourK)
    {
        using var r = new Rig(); var (id, user) = await Orphan(r);
        var obsolete = Assert.Single(r.Ledger.ForWant(id));
        var edited = fourK ? Seasons(1, 2) with { Variant = "4k" } : Seasons(1);
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, new(edited), default)).HttpStatus);
        var live = Assert.Single(r.Ledger.ForWant(id), j => j.State == "queued");
        Assert.Equal("cancelled", r.Ledger.ForWant(id).Single(j => j.Id == obsolete.Id).State);
        Assert.Equal(edited.Normalize()!.Canonical, r.Ledger.Find(id)!.Input.Canonical);
        Assert.Equal(edited.Normalize()!.Canonical, live.Input.Canonical);
        Assert.Equal(fourK ? 2 : 1, r.Service.Quota(user).Used); Assert.Equal(fourK ? 80 : 10, r.Service.Quota(user).UsedGb);
        Assert.Equal(r.Service.Quota(user).Used, r.Ledger.Find(id)!.Cost);
        await r.Runner().TickAsync(default); Assert.Equal(1, r.Backend.Sends); Assert.Equal("sent", r.Ledger.Find(id)!.Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task S2EditedMultiJobOrphanReplacesEveryUnsentJob(bool fourK)
    {
        using var r = new Rig(); r.Policy.People[r.Manager] = r.Policy.People[r.Manager] with { Can4k = true };
        var first = await r.Create(input: Seasons(1)); var thirdUser = r.Add("Member");
        var third = await r.Create(thirdUser, Seasons(3)); var user = r.Add("Member");
        var mixed = await r.Create(user, Seasons(1, 2, 3)); var id = mixed.RequestId!;
        r.Service.Close(first.RequestId!, r.Member, null);
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, null, default)).HttpStatus);
        Assert.Equal(2, r.Ledger.ForWant(id).Count(j => j.State == "queued"));
        r.Service.Close(third.RequestId!, thirdUser, null);
        Assert.Equal("pending", r.Ledger.Find(id)!.Status);
        var input = fourK ? Seasons(1, 2) with { Variant = "4k" } : Seasons(1);
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, new(input), default)).HttpStatus);
        Assert.Equal(2, r.Ledger.ForWant(id).Count(j => j.State == "cancelled"));
        Assert.Equal(input.Normalize()!.Canonical, Assert.Single(r.Ledger.Due(r.Now)).Input.Canonical);
        Assert.Equal(fourK ? 80 : 10, r.Service.Quota(user).UsedGb);
        Assert.Equal(fourK ? 2 : 1, r.Service.Quota(user).Used);
        Assert.Equal(fourK ? 2 : 1, r.Ledger.Find(id)!.Cost);
        await r.Runner().TickAsync(default); Assert.Equal(1, r.Backend.Sends); Assert.Equal("sent", r.Ledger.Find(id)!.Status);
    }

    [Fact]
    public async Task S2ConflictingEditsRefuseWithExistingConflictShapeAndNoWrites()
    {
        foreach (var state in new[] { "succeeded", "sending", "maybe_sent", "parked_unknown" })
        {
            using var r = new Rig(); var (id, _) = await Orphan(r); var job = Assert.Single(r.Ledger.ForWant(id));
            r.Ledger.Claim(job, r.Db.Generation, r.Now);
            if (state == "succeeded") r.Ledger.Complete(job, r.Db.Generation, new(RequestOutcome.Accepted(id, "looking"), Confirmed: true), r.Now);
            if (state == "maybe_sent") r.Ledger.Recover(r.Now);
            if (state == "parked_unknown") r.Ledger.Complete(job, r.Db.Generation, RequestBackendResult.Uncertain(id) with { Parked = true }, r.Now);
            var revision = r.Ledger.Revision; var before = r.Ledger.Find(id)!;
            var response = Assert.IsType<ObjectResult>(await r.Controller(r.Manager).Approve(id, new(Seasons(1) with { Variant = "4k" }), default));
            Assert.Equal(409, response.StatusCode); var outcome = Assert.IsType<RequestOutcome>(response.Value);
            Assert.Equal("denied", outcome.Outcome); Assert.Equal(ArrActionStatus.Rejected, outcome.Certainty);
            Assert.Equal(state == "succeeded" ? "request_changed" : "request_in_flight", outcome.Reason);
            Assert.Equal(revision, r.Ledger.Revision); Assert.Equal(JsonSerializer.Serialize(before), JsonSerializer.Serialize(r.Ledger.Find(id)));
        }
    }

    [Fact]
    public async Task S2FailedEditedApprovalRollsBackJobAndReservationReconciliation()
    {
        using var r = new Rig(); var (id, user) = await Orphan(r);
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = 20 };
        var before = r.Ledger.Revision;
        var result = await r.Service.ApproveAsync(id, r.Manager, new(Seasons(1, 2) with { Variant = "4k" }), default);
        Assert.Equal(429, result.HttpStatus); Assert.Equal(before, r.Ledger.Revision);
        Assert.Equal("queued", Assert.Single(r.Ledger.ForWant(id)).State); Assert.Equal(10, r.Service.Quota(user).UsedGb);
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = 100 };
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, new(Seasons(1, 2) with { Variant = "4k" }), default)).HttpStatus);
        Assert.Equal("cancelled", r.Ledger.ForWant(id).Single(j => j.Input.Variant == "standard").State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task S3S6DeletedApproverKeepsSurvivingScopeChargedExactlyOnce(bool episodes)
    {
        using var r = new Rig();
        var one = Seasons(1); var two = Seasons(1, 2);
        if (episodes)
        {
            one = new() { Key = one.Key, Scope = "episodes", Episodes = Enumerable.Range(1, 5).Select(e => new RequestEpisode(1, e)).ToArray() };
            two = one with { Episodes = Enumerable.Range(1, 10).Select(e => new RequestEpisode(1, e)).ToArray() };
        }
        var (id, user) = await Orphan(r, one, two);
        r.Policy.People[user] = r.Policy.People[user] with { GbLimit = episodes ? 10 : 20 };
        Confirm(r, Assert.Single(r.Ledger.ForWant(id)));
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, null, default)).HttpStatus);
        Assert.Equal(episodes ? 1 : 2, r.Service.Quota(user).Used);
        r.Ledger.PurgeUser(r.Manager);
        Assert.Equal(episodes ? 0 : 1, r.Service.Quota(user).Used); Assert.Equal(episodes ? 5 : 10, r.Service.Quota(user).UsedGb);
        Assert.Equal(episodes ? 5 : 0, EpisodeCharges(r, user));
        Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Admin, null, default)).HttpStatus);
        Assert.Equal(episodes ? 1 : 2, r.Service.Quota(user).Used); Assert.Equal(episodes ? 10 : 20, r.Service.Quota(user).UsedGb);
        Assert.Equal(episodes ? 10 : 0, EpisodeCharges(r, user));
        Assert.Equal(episodes ? 1 : 2, r.Ledger.Find(id)!.Cost);
        Assert.Equal(429, (await r.Create(user, Movie(700))).HttpStatus);
        await r.Runner().TickAsync(default); Assert.Equal("sent", r.Ledger.Find(id)!.Status);
        r.Reopen(); Assert.Equal(episodes ? 10 : 20, r.Service.Quota(user).UsedGb);
    }
    private static int EpisodeCharges(Rig r, Guid user) => r.Db.Read(c =>
    {
        using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COALESCE(SUM(episode_count),0) FROM reservations WHERE state='charged' AND user_id=$u";
        cmd.Parameters.AddWithValue("$u", user.ToString("N")); return Convert.ToInt32(cmd.ExecuteScalar());
    });

    [Theory]
    [InlineData("sending")]
    [InlineData("maybe_sent")]
    [InlineData("succeeded")]
    [InlineData("parked_unknown")]
    public async Task S4DeletedRequesterKeepsCertaintyAndFollowersWithoutPersonalContext(string state)
    {
        using var r = new Rig(); r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { SeerrUser = 27 };
        var owner = await r.Create(r.Kid);
        await r.Service.ApproveAsync(owner.RequestId!, r.Manager, null, default);
        var follower = await r.Create(r.Add("Member")); var job = Assert.Single(r.Ledger.ForWant(owner.RequestId!));
        r.Ledger.Claim(job, r.Db.Generation, r.Now);
        if (state == "maybe_sent") r.Ledger.Recover(r.Now);
        if (state == "succeeded") r.Ledger.Complete(job, r.Db.Generation, new(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true), r.Now);
        if (state == "parked_unknown") r.Ledger.Complete(job, r.Db.Generation, RequestBackendResult.Uncertain(job.WantId) with { Parked = true }, r.Now);
        r.Ledger.PurgeUser(r.Kid);
        Assert.Empty(r.Ledger.List(r.Kid, false)); var retained = Assert.Single(r.Ledger.ForWant(owner.RequestId!));
        Assert.Equal(state == "parked_unknown" ? "parked" : state, retained.State);
        Assert.NotEqual(r.Kid, retained.Authorization.Requester); Assert.Equal(27, retained.Authorization.SeerrUser);
        Assert.NotEqual("cancelled", r.Ledger.Find(follower.RequestId!)!.Status);
        var want = r.Ledger.Find(owner.RequestId!)!; Assert.Equal("null", want.ParentalSignature); Assert.Empty(want.Fingerprint);
        Assert.DoesNotContain(r.Kid.ToString("N"), r.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT group_concat(user_id) FROM reservations"; return cmd.ExecuteScalar()?.ToString() ?? ""; }));
        if (state == "sending") Assert.True(r.Ledger.Complete(job, r.Db.Generation, new(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true), r.Now));
        else if (state != "succeeded") { r.Ledger.Recover(r.Now); await r.Runner().TickAsync(default); }
        Assert.Equal("sent", r.Ledger.Find(follower.RequestId!)!.Status);
        r.Reopen(); Assert.Equal(job.Id, Assert.Single(r.Ledger.ForWant(owner.RequestId!)).Id);
    }

    [Fact]
    public async Task S4SharedUnsentIntentIsAnonymizedAndPurelyUnsentIntentIsDeleted()
    {
        using var r = new Rig(); var owner = await r.Create(); var follower = await r.Create(r.Add("Member"));
        r.Ledger.PurgeUser(r.Member);
        Assert.NotNull(r.Ledger.Find(owner.RequestId!)); Assert.NotEqual(r.Member, r.Ledger.Find(owner.RequestId!)!.UserId);
        Assert.Equal("cancelled", Assert.Single(r.Ledger.ForWant(owner.RequestId!)).State);
        Assert.Equal("cancelled", r.Ledger.Find(follower.RequestId!)!.Status);
        var unsent = await r.Create(r.Kid, Movie(700)); r.Ledger.PurgeUser(r.Kid);
        Assert.Null(r.Ledger.Find(unsent.RequestId!)); Assert.Empty(r.Ledger.ForWant(unsent.RequestId!));
    }

    [Fact]
    public async Task S4DeletionDuringTransportStillCompletesAndAuditsWithoutReidentifyingRequester()
    {
        using var r = new Rig(); var want = await r.Create();
        var backend = new VanishingBackend(() => r.Ledger.PurgeUser(r.Member));
        await r.Runner(backend).TickAsync(default);
        Assert.Equal("succeeded", Assert.Single(r.Ledger.ForWant(want.RequestId!)).State);
        var audit = Assert.Single(r.Audit.ReadRecent(10)); Assert.Equal("succeeded", audit.Outcome); Assert.Empty(audit.UserId);
        Assert.Equal(1, r.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM request_audit WHERE action='dispatch'"; return Convert.ToInt32(cmd.ExecuteScalar()); }));
    }

    [Fact]
    public async Task S4MissingRowAfterTransportStillAppendsJsonlAudit()
    {
        using var r = new Rig(); var want = await r.Create(client: "je-3a-cli-vanish");
        var backend = new VanishingBackend(() => Assert.True(r.Ledger.LabDelete(want.RequestId!)));
        await r.Runner(backend).TickAsync(default);
        Assert.Null(r.Ledger.Find(want.RequestId!));
        var audit = Assert.Single(r.Audit.ReadRecent(10)); Assert.Equal("succeeded", audit.Outcome); Assert.Equal("request.dispatch", audit.Action);
    }
    private sealed class VanishingBackend(Action disappear) : IRequestBackend
    {
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> guard, CancellationToken ct)
        {
            Assert.Null(guard()); disappear();
            return Task.FromResult(new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true));
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => Task.FromResult(RequestBackendResult.Uncertain(job.WantId));
    }
    private sealed class ReadbackBackend : IRequestBackend
    {
        public List<RequestJob> Reads { get; } = new();
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> guard, CancellationToken ct) => Task.FromResult(new RequestBackendResult(RequestOutcome.Refused("backend_unavailable", 503), Retryable: true, VerifiedNotSent: true));
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) { Reads.Add(job); return Task.FromResult(new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking"), Confirmed: true)); }
    }

    [Fact]
    public async Task S1S3S6SchemaTwoDoesNotBindAlternateFollowerToWrongTarget()
    {
        using var r = new Rig(); await r.Create();
        r.Policy.Adjust = (_, input, facts) => facts with { InstanceId = input.InstanceId ?? "r1" };
        var follower = await r.Create(r.Admin, Movie() with { InstanceId = "r2" });
        // Reproduce the pre-extension erroneous follower: its input selected r2 but it had no job.
        r.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand(); cmd.Transaction = t;
            cmd.CommandText = "DELETE FROM jobs WHERE want_id=$w; UPDATE wants SET is_follower=1,owned_input=NULL,cost=0 WHERE id=$w; UPDATE reservations SET cost=0,estimated_gb=0,job_id=NULL WHERE want_id=$w;";
            cmd.Parameters.AddWithValue("$w", follower.RequestId!); return cmd.ExecuteNonQuery();
        });
        var path = Path.Combine(r.Root, "follower-schema2.db"); File.WriteAllBytes(path, r.Db.Snapshot()!);
        AcquireSchemaFixtures.ToSchemaTwo(path);
        using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
        {
            c.Open(); using var cmd = c.CreateCommand(); cmd.CommandText = "ALTER TABLE wants DROP COLUMN target_key; ALTER TABLE reservations DROP COLUMN job_id;"; cmd.ExecuteNonQuery();
        }
        using var db = new AcquireDatabase(path); Assert.True(db.Available); var ledger = new RequestLedger(db);
        Assert.Equal("pending", ledger.Find(follower.RequestId!)!.Status); Assert.Equal("instance_changed", ledger.Find(follower.RequestId!)!.Reason);
        Assert.Equal(200, ledger.Approve(follower.RequestId!, r.Admin, null, r.Policy, r.Now).HttpStatus);
        Assert.Equal("r2", Assert.Single(ledger.ForWant(follower.RequestId!)).Authorization.InstanceId);
    }

    [Fact]
    public async Task S1S3S6SchemaTwoReusedInitialReservationBackfillsToLiveJob()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid);
        await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default);
        r.Ledger.PurgeUser(r.Manager);
        await r.Service.ApproveAsync(want.RequestId!, r.Admin, null, default);
        var live = Assert.Single(r.Ledger.ForWant(want.RequestId!), j => j.State == "queued");
        var path = Path.Combine(r.Root, "reused-schema2.db"); File.WriteAllBytes(path, r.Db.Snapshot()!);
        AcquireSchemaFixtures.ToSchemaTwo(path);
        using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
        {
            c.Open(); using var cmd = c.CreateCommand(); cmd.CommandText = "ALTER TABLE wants DROP COLUMN target_key; ALTER TABLE reservations DROP COLUMN job_id;"; cmd.ExecuteNonQuery();
        }
        using var db = new AcquireDatabase(path); Assert.True(db.Available); Assert.Equal(AcquireDatabase.Migrations.Count, db.Version);
        Assert.Equal(live.Id, db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT job_id FROM reservations WHERE want_id=$w AND scope='initial'"; cmd.Parameters.AddWithValue("$w", want.RequestId!); return cmd.ExecuteScalar()?.ToString(); }));
        var ledger = new RequestLedger(db); ledger.PurgeUser(r.Admin);
        Assert.Equal(0, ledger.Quota(r.Policy.Evaluate(r.Kid, Movie()), r.Now).UsedGb);
        Assert.Equal(0, ledger.Find(want.RequestId!)!.Cost);
    }

    [Fact]
    public async Task S1S3S6ExistingSchemaTwoExtendsAndBackfillsTargetsAndJobLinksOnce()
    {
        using var r = new Rig(); var (id, user) = await Orphan(r); Confirm(r, Assert.Single(r.Ledger.ForWant(id)));
        r.Now = r.Now.AddMinutes(1); await r.Service.ApproveAsync(id, r.Manager, null, default);
        var path = Path.Combine(r.Root, "old-schema2.db"); File.WriteAllBytes(path, r.Db.Snapshot()!);
        AcquireSchemaFixtures.ToSchemaTwo(path);
        using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
        {
            c.Open(); using var cmd = c.CreateCommand(); cmd.CommandText = "ALTER TABLE wants DROP COLUMN target_key; ALTER TABLE reservations DROP COLUMN job_id;"; cmd.ExecuteNonQuery();
        }
        for (var pass = 0; pass < 2; pass++)
        {
            using var db = new AcquireDatabase(path); Assert.True(db.Available); Assert.Equal(AcquireDatabase.Migrations.Count, db.Version);
            var ledger = new RequestLedger(db); Assert.NotEmpty(ledger.Find(id)!.TargetKey);
            Assert.Equal(2 + pass, db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM reservations WHERE want_id=$w AND job_id IS NOT NULL"; cmd.Parameters.AddWithValue("$w", id); return Convert.ToInt32(cmd.ExecuteScalar()); }));
            if (pass == 0)
            {
                ledger.PurgeUser(r.Manager); Assert.Equal(1, ledger.Quota(r.Policy.Evaluate(user, Seasons(1, 2)), r.Now).Used);
                Assert.Equal(200, ledger.Approve(id, r.Admin, null, r.Policy, r.Now).HttpStatus);
            }
            Assert.Equal(20, ledger.Quota(r.Policy.Evaluate(user, Seasons(1, 2)), r.Now).UsedGb);
        }
        Assert.Single(Directory.GetFiles(r.Root, "old-schema2.db.pre-v" + AcquireDatabase.Migrations.Count + ".*"));
    }
}
