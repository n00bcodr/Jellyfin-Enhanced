using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

public class IntegrationRequestLedgerTests
{
    internal sealed class Policy : IRequestPolicy
    {
        public PluginConfiguration Configuration { get; } = new() { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrRequestBackend = "je", ArrRequestDefaultRole = "Member" };
        public Dictionary<Guid, RequestPolicyFacts> People { get; } = new();
        public Func<Guid, MutationInput, Task>? Before { get; set; }
        public Func<Guid, MutationInput, RequestPolicyFacts, RequestPolicyFacts>? Adjust { get; set; }
        public Task PrepareIdentityAsync(Guid userId, bool movie, CancellationToken ct) => Task.CompletedTask;
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Before?.Invoke(user, input) ?? Task.CompletedTask;
        public bool IsAdmin(Guid user) => People.GetValueOrDefault(user)?.Role == "Admin";
        public string AuthorizationStamp(Guid user, MutationInput input) => JsonSerializer.Serialize(People.GetValueOrDefault(user)) + JsonSerializer.Serialize(Configuration);
        public RequestPolicyFacts Evaluate(Guid user, MutationInput input)
        {
            var person = People.TryGetValue(user, out var known) ? known : new(user, "Watcher", false, false, false, false, "missing", "je", "r1", "g1", 7, 7, 0, "null", "user_required");
            person = person with { Backend = Configuration.ArrRequestBackend };
            if (!(Configuration.ArrIntegrationEnabled && Configuration.ArrPhase1Enabled && Configuration.ArrPhase3Enabled)) person = person with { Refusal = "feature_disabled" };
            return Adjust?.Invoke(user, input, person) ?? person;
        }
    }
    internal sealed class Backend : IRequestBackend
    {
        public int Sends { get; private set; }
        public int Reads { get; private set; }
        public Func<Task>? Gate { get; set; }
        public bool Unknown { get; set; }
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public async Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
        {
            if (Gate != null) await Gate();
            if (finalGuard() is { } refusal) return RequestBackendResult.Hold(refusal);
            Sends++;
            return Unknown ? RequestBackendResult.Uncertain(job.WantId) : new(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true);
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
        {
            Reads++;
            return Task.FromResult(Unknown ? RequestBackendResult.Uncertain(job.WantId) : new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true));
        }
    }
    internal sealed class Rig : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "je-requests-" + Guid.NewGuid().ToString("N"));
        public DateTimeOffset Now { get; set; } = new(2026, 10, 13, 12, 0, 0, TimeSpan.Zero);
        public AcquireDatabase Db { get; private set; }
        public RequestLedger Ledger { get; private set; }
        public Policy Policy { get; } = new();
        public Backend Backend { get; } = new();
        public FakeJellyfinView View { get; } = new();
        public ArrChangeFeed Feed { get; } = new();
        public ArrAuditLog Audit { get; }
        public RequestService Service { get; private set; }
        public Guid Member { get; }
        public Guid Kid { get; }
        public Guid Manager { get; }
        public Guid Admin { get; }
        public Rig()
        {
            Directory.CreateDirectory(Root);
            Db = new(Path.Combine(Root, "acquire.db")); Ledger = new(Db);
            Audit = new(Path.Combine(Root, "audit.jsonl"), 100000, 1);
            Member = Add("Member"); Kid = Add("Kid"); Manager = Add("Manager"); Admin = Add("Admin");
            Service = new(Ledger, Policy, View, Feed, () => Now);
        }
        public Guid Add(string role)
        {
            var viewer = View.AddUser(role == "Admin");
            Policy.People[viewer.UserId] = new(viewer.UserId, role, role != "Watcher", role is "Manager" or "Admin", role == "Admin", true, "p1", "je", "r1", "g1", 7, 7, 0, "{\"score\":5}");
            return viewer.UserId;
        }
        public void Reopen()
        {
            Db.Dispose(); Db = new(Path.Combine(Root, "acquire.db")); Ledger = new(Db);
            Service = new(Ledger, Policy, View, Feed, () => Now);
        }
        public RequestOutbox Runner(IRequestBackend? backend = null) => new(Ledger, Policy, backend ?? Backend, new RequestTitleLocks(), Feed, Audit, () => Now);
        public AcquireRequestsController Controller(Guid? user = null, ClaimsPrincipal? principal = null)
        {
            var controller = new AcquireRequestsController(Service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = principal ?? TestCallers.Principal(user ?? Member, user == Admin);
            return controller;
        }
        public Task<RequestOutcome> Create(Guid? user = null, MutationInput? input = null, string? client = null)
            => Service.CreateAsync(user ?? Member, new(client ?? Guid.NewGuid().ToString("N"), input ?? Movie()), CancellationToken.None);
        public void Dispose() { Db.Dispose(); Directory.Delete(Root, true); }
    }
    internal static MutationInput Movie(int id = 603, string variant = "standard") => new() { Key = "movie:tmdb:" + id, Variant = variant };
    internal static MutationInput Seasons(params int[] seasons) => new() { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = seasons };
    private static RequestOutcome Outcome(IActionResult result) => Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(result).Value);

    [Theory]
    [InlineData("Admin")]
    [InlineData("Manager")]
    public async Task ApproversMatchingAskApprovesSharedPendingScopeAndFollowsForFree(string role)
    {
        using var r = new Rig();
        var first = await r.Create(r.Kid);
        var other = r.Add("Kid"); var second = await r.Create(other);
        var actor = role == "Admin" ? r.Admin : r.Manager;
        var ask = await r.Create(actor);
        Assert.Equal(201, ask.HttpStatus); Assert.Equal("queued_outage", ask.Reason);
        Assert.Empty(r.Ledger.List(actor, true));
        Assert.All(r.Ledger.ForTitle(Movie().Key), w => Assert.Equal("queued", w.Status));
        Assert.Single(r.Ledger.Due(r.Now));
        var job = r.Ledger.Due(r.Now).Single();
        Assert.Equal(r.Kid, job.Authorization.Requester); Assert.Equal(actor, job.Authorization.Approver);
        Assert.Equal(1, r.Service.Quota(r.Kid).Used);
        Assert.Equal(0, r.Service.Quota(other).Used); Assert.Equal(0, r.Service.Quota(actor).Used);
        Assert.Equal(first.RequestId, job.WantId);
        Assert.True(r.Ledger.Find(second.RequestId!)!.Follower);
        await r.Runner().TickAsync(default);
        Assert.Equal(1, r.Backend.Sends);
        Assert.All(r.Ledger.ForTitle(Movie().Key), w => Assert.Equal("sent", w.Status));
    }

    [Fact]
    public async Task MemberWithinQuotaAsksAutomaticallyEvenWhenAKidAlreadyHasPendingIntent()
    {
        using var r = new Rig(); var pending = await r.Create(r.Kid);
        var ask = await r.Create(r.Member);
        Assert.Equal("queued_outage", ask.Reason);
        Assert.Equal("queued", r.Ledger.Find(pending.RequestId!)!.Status);
        Assert.True(r.Ledger.Find(pending.RequestId!)!.Follower);
        Assert.Equal(r.Member, r.Ledger.Due(r.Now).Single().Authorization.Requester);
        Assert.Null(r.Ledger.Due(r.Now).Single().Authorization.Approver);
        Assert.Equal(1, r.Service.Quota(r.Member).Used); Assert.Equal(0, r.Service.Quota(r.Kid).Used);
    }

    [Fact]
    public async Task AutomaticNarrowAskDoesNotApproveUnaskedScopeOrWaitForIt()
    {
        using var r = new Rig(); var broad = await r.Create(r.Kid, Seasons(1, 2));
        var narrow = await r.Create(r.Admin, Seasons(1));
        Assert.Equal("queued_outage", narrow.Reason);
        Assert.Equal("pending", r.Ledger.Find(broad.RequestId!)!.Status);
        Assert.Equal(new[] { 1 }, r.Ledger.Due(r.Now).Single().Input.Seasons);
        var other = await r.Create(r.Manager, Seasons(1));
        Assert.Equal("queued_outage", other.Reason); Assert.Equal(0, r.Service.Quota(r.Manager).Used);
        await r.Service.ApproveAsync(broad.RequestId!, r.Admin, null, default);
        Assert.Equal(new[] { 2 }, r.Ledger.ForWant(broad.RequestId!).Single().Input.Seasons);
        Assert.Equal(1, r.Service.Quota(r.Kid).Used);
    }

    [Fact]
    public async Task ApprovalCoversOtherPendingWantsButLeavesExtraScopeAwaitingApproval()
    {
        using var r = new Rig();
        var one = await r.Create(r.Kid, Seasons(1));
        var other = r.Add("Kid"); var broad = await r.Create(other, Seasons(1, 2));
        var third = r.Add("Kid"); var excess = await r.Create(third, Seasons(1, 2, 3));
        Assert.Equal(200, (await r.Service.ApproveAsync(broad.RequestId!, r.Admin, null, default)).HttpStatus);
        Assert.Equal("queued", r.Ledger.Find(one.RequestId!)!.Status);
        Assert.Equal("pending", r.Ledger.Find(excess.RequestId!)!.Status);
        Assert.Equal(0, r.Service.Quota(r.Kid).Used); Assert.Equal(2, r.Service.Quota(other).Used);
        await r.Service.ApproveAsync(excess.RequestId!, r.Admin, null, default);
        Assert.Equal(new[] { 3 }, r.Ledger.ForWant(excess.RequestId!).Single().Input.Seasons);
        Assert.Equal(1, r.Service.Quota(third).Used);
    }

    [Fact]
    public async Task DecliningOnePendingWantPreservesOtherUsersIntentsWithoutChargingThem()
    {
        using var r = new Rig(); var first = await r.Create(r.Kid);
        var other = r.Add("Kid"); var second = await r.Create(other);
        var third = r.Add("Kid"); var last = await r.Create(third);
        Assert.Equal(200, r.Service.Close(first.RequestId!, r.Admin, "Not for kids").HttpStatus);
        Assert.Equal("declined", r.Ledger.Find(first.RequestId!)!.Status);
        Assert.Equal("pending", r.Ledger.Find(second.RequestId!)!.Status);
        Assert.Equal("pending", r.Ledger.Find(last.RequestId!)!.Status);
        Assert.Equal(0, r.Service.Quota(other).Used); Assert.Empty(r.Ledger.Due(r.Now));
        await r.Service.ApproveAsync(last.RequestId!, r.Admin, null, default);
        Assert.Single(r.Ledger.Due(r.Now)); Assert.Equal(1, r.Service.Quota(third).Used);
        Assert.Equal(0, r.Service.Quota(other).Used);
    }

    [Fact]
    public async Task AutomaticAskRechecksOriginalRequesterAndDoesNotApproveForbiddenWant()
    {
        using var r = new Rig(); var first = await r.Create(r.Kid);
        r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { Refusal = "parental_blocked" };
        var ask = await r.Create(r.Admin);
        Assert.Equal("queued_outage", ask.Reason);
        Assert.Equal("pending", r.Ledger.Find(first.RequestId!)!.Status);
        Assert.Equal(r.Admin, r.Ledger.Due(r.Now).Single().Authorization.Requester);
        Assert.Equal(0, r.Service.Quota(r.Kid).Used);
    }

    [Fact]
    public async Task MatchingAskAndExplicitApprovalRaceStillProducesOneJobAndOneCharge()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid);
        var actions = Enumerable.Range(0, 12).Select(i => Task.Run(() => i % 2 == 0
            ? r.Create(r.Admin)
            : r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default)));
        var results = await Task.WhenAll(actions);
        Assert.All(results, result => Assert.Contains(result.HttpStatus, new[] { 200, 201, 409 }));
        Assert.Single(r.Ledger.Due(r.Now)); Assert.Equal(1, r.Service.Quota(r.Kid).Used);
        Assert.Equal(0, r.Service.Quota(r.Admin).Used); Assert.Empty(r.Ledger.List(r.Manager, true));
    }

    [Fact]
    public async Task RefusedMatchingCreateRollsBackItsImplicitApprovals()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid);
        var original = r.Policy.People[r.Manager];
        r.Policy.People[r.Manager] = original with { Role = "Kid", CanApprove = false };
        await r.Create(r.Manager, Movie(604));
        r.Policy.People[r.Manager] = original;
        r.Policy.Configuration.ArrRequestPendingLimit = 1;
        Assert.Equal(429, (await r.Create(r.Manager)).HttpStatus);
        Assert.Equal("pending", r.Ledger.Find(want.RequestId!)!.Status);
        Assert.Empty(r.Ledger.Due(r.Now)); Assert.Equal(0, r.Service.Quota(r.Kid).Used);
    }

    [Theory]
    [InlineData("Admin")]
    [InlineData("Member")]
    public async Task MatchingAskCannotStartAnotherJobWhileSharedSendIsUncertain(string role)
    {
        using var r = new Rig(); var want = await r.Create();
        r.Backend.Unknown = true; await r.Runner().TickAsync(default);
        r.Db.Write((c, t) =>
        {
            RequestLedger.Exec(c, t, "UPDATE wants SET status='pending' WHERE id=$id", ("$id", want.RequestId));
            RequestLedger.Exec(c, t, "UPDATE jobs SET state='parked' WHERE want_id=$id", ("$id", want.RequestId));
            return true;
        });
        var actor = role == "Admin" ? r.Admin : r.Add("Member");
        Assert.Equal(409, (await r.Create(actor)).HttpStatus);
        Assert.Single(r.Ledger.ForWant(want.RequestId!)); Assert.Empty(r.Ledger.List(actor, false));
    }

    [Fact]
    public async Task QuotaHttpBodyUsesCamelCaseEvenWithoutHostNamingPolicy()
    {
        using var r = new Rig(); await r.Create();
        var response = Assert.IsType<OkObjectResult>(await r.Controller().Quota());
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(response.Value));
        var quota = json.RootElement.GetProperty("quota");
        Assert.Equal(new[] { "available", "limit", "nextSlotAt", "remaining", "used", "usedGb" }, quota.EnumerateObject().Select(p => p.Name).OrderBy(n => n).ToArray());
        Assert.Equal(1, quota.GetProperty("used").GetInt32());
    }

    [Fact]
    public async Task LabDeleteRemovesAuditByJobLinkAndPreservesCoincidentalAuditIds()
    {
        using var r = new Rig(); var want = await r.Create(client: "je-3a-cli-audit");
        var job = r.Ledger.ForWant(want.RequestId!).Single();
        r.Db.Write((c, t) =>
        {
            RequestLedger.Exec(c, t, "INSERT INTO request_audit VALUES('linked',NULL,$job,NULL,'test','accepted','test',0)", ("$job", job.Id));
            RequestLedger.Exec(c, t, "INSERT INTO request_audit VALUES($id,NULL,NULL,NULL,'test','accepted','test',0)", ("$id", job.Id));
            return true;
        });
        Assert.True(r.Ledger.LabDelete(want.RequestId!));
        r.Db.Read(c =>
        {
            using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT id FROM request_audit";
            using var reader = cmd.ExecuteReader(); Assert.True(reader.Read()); Assert.Equal(job.Id, reader.GetString(0)); Assert.False(reader.Read());
            return true;
        });
    }

    private static (string Id, string? Want, string? Job, string? Actor, string Action)[] AuditRows(Rig r)
        => r.Db.Read(c =>
        {
            using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT id,want_id,job_id,actor_id,action FROM request_audit ORDER BY id";
            using var reader = cmd.ExecuteReader();
            var rows = new List<(string, string?, string?, string?, string)>();
            while (reader.Read()) rows.Add((reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2), reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetString(4)));
            return rows.ToArray();
        });

    [Fact]
    public async Task RestartImportKeepsOneLinkedDispatchAndSharedDispatchAndCleanupCannotReimportThem()
    {
        using var r = new Rig(); var owner = await r.Create(client: "je-3a-cli-dispatch");
        var follower = r.Add("Member"); var shared = await r.Create(follower, client: "je-3a-cli-shared");
        var job = r.Ledger.ForWant(owner.RequestId!).Single();
        await r.Runner().TickAsync(default);
        var mirrored = Assert.Single(r.Audit.ReadRecent(int.MaxValue));
        Assert.Equal("request.dispatch", mirrored.Action); Assert.Equal(job.Id, mirrored.Id);
        r.Reopen();
        for (var restart = 0; restart < 2; restart++)
        {
            r.Ledger.ImportAudit(r.Audit.ReadRecent(int.MaxValue)); r.Ledger.Recover(r.Now);
            var dispatch = Assert.Single(AuditRows(r), a => a.Action == "dispatch");
            Assert.Equal(owner.RequestId, dispatch.Want); Assert.Equal(job.Id, dispatch.Job);
            var sharedDispatch = Assert.Single(AuditRows(r), a => a.Action == "shared_dispatch");
            Assert.Equal(shared.RequestId, sharedDispatch.Want); Assert.Equal(job.Id, sharedDispatch.Job);
            Assert.DoesNotContain(AuditRows(r), a => a.Action.StartsWith("request.", StringComparison.Ordinal));
        }
        Assert.True(r.Ledger.LabDelete(owner.RequestId!)); Assert.True(r.Ledger.LabDelete(shared.RequestId!));
        Assert.Empty(AuditRows(r));
        r.Reopen(); r.Ledger.ImportAudit(r.Audit.ReadRecent(int.MaxValue)); r.Ledger.Recover(r.Now);
        Assert.Empty(AuditRows(r));
    }

    [Theory]
    [InlineData("request.dispatch")]
    [InlineData("request.shared_dispatch")]
    [InlineData("request.future_action")]
    public async Task ImportRepairsOrphanedOutboxMirrorsButPreservesLinkedAndLegacyAudit(string action)
    {
        using var r = new Rig(); var owner = await r.Create(client: "je-3a-cli-import");
        var job = r.Ledger.ForWant(owner.RequestId!).Single();
        await r.Runner().TickAsync(default);
        r.Db.Write((c, t) =>
        {
            RequestLedger.Exec(c, t, "INSERT INTO request_audit VALUES($id,NULL,NULL,$actor,$action,'succeeded','looking',$at)",
                ("$id", job.Id), ("$actor", RequestLedger.Id(r.Member)), ("$action", action), ("$at", RequestLedger.Ms(r.Now)));
            RequestLedger.Exec(c, t, "INSERT INTO request_audit VALUES('already-orphaned',NULL,NULL,NULL,$action,'succeeded','looking',$at)",
                ("$action", action), ("$at", RequestLedger.Ms(r.Now)));
            return true;
        });
        var entries = new[]
        {
            new ArrAuditEntry { Id = job.Id, Time = r.Now, UserId = RequestLedger.Id(r.Member), Action = action },
            new ArrAuditEntry { Id = "legacy-search", Time = r.Now, UserId = RequestLedger.Id(r.Member), Action = "movie.search", Outcome = "succeeded" },
            new ArrAuditEntry { Id = "legacy-remove", Time = r.Now, UserId = RequestLedger.Id(r.Admin), Action = "queue.remove", Outcome = "succeeded" },
        };
        r.Reopen(); r.Ledger.ImportAudit(entries); r.Ledger.ImportAudit(entries);
        var dispatch = Assert.Single(AuditRows(r), a => a.Action == "dispatch");
        Assert.Equal(job.Id, dispatch.Job); Assert.Equal(owner.RequestId, dispatch.Want);
        Assert.DoesNotContain(AuditRows(r), a => a.Action.StartsWith("request.", StringComparison.Ordinal));
        Assert.Single(AuditRows(r), a => a.Id == "legacy-search");
        Assert.Single(AuditRows(r), a => a.Id == "legacy-remove");
    }

    [Theory]
    [InlineData("request.dispatch")]
    [InlineData("request.shared_dispatch")]
    public async Task LabDeleteAlsoRemovesOldJobIdMatchedOutboxImports(string action)
    {
        using var r = new Rig(); var owner = await r.Create(client: "je-3a-cli-old-import");
        var job = r.Ledger.ForWant(owner.RequestId!).Single();
        await r.Runner().TickAsync(default);
        r.Db.Write((c, t) => RequestLedger.Exec(c, t,
            "INSERT INTO request_audit VALUES($id,NULL,NULL,NULL,$action,'succeeded','looking',$at)",
            ("$id", job.Id), ("$action", action), ("$at", RequestLedger.Ms(r.Now))));
        Assert.True(r.Ledger.LabDelete(owner.RequestId!)); Assert.Empty(AuditRows(r));
        r.Ledger.ImportAudit(r.Audit.ReadRecent(int.MaxValue)); Assert.Empty(AuditRows(r));
    }

    [Fact]
    public async Task ImportDoesNotResurrectRetainedDispatchesOrDeletedUsersAuditIdentity()
    {
        using var r = new Rig(); await r.Create(); await r.Runner().TickAsync(default);
        r.Ledger.Retain(r.Now.AddDays(181), 30);
        Assert.Empty(AuditRows(r));
        r.Ledger.ImportAudit(r.Audit.ReadRecent(int.MaxValue)); Assert.Empty(AuditRows(r));
        var fresh = await r.Create(input: Movie(604)); await r.Runner().TickAsync(default);
        r.Ledger.PurgeUser(r.Member);
        r.Reopen(); r.Ledger.ImportAudit(r.Audit.ReadRecent(int.MaxValue));
        var dispatch = Assert.Single(AuditRows(r), a => a.Action == "dispatch");
        Assert.Null(dispatch.Actor); Assert.Equal(fresh.RequestId, dispatch.Want);
        var retained = Assert.Single(r.Ledger.ForWant(fresh.RequestId!));
        Assert.Equal(retained.Id, dispatch.Job); Assert.Equal("succeeded", retained.State);
        Assert.NotEqual(r.Member, retained.Authorization.Requester);
        r.Ledger.ImportAudit(new[] { new ArrAuditEntry { Id = "deleted-user-legacy", Time = r.Now,
            UserId = RequestLedger.Id(r.Member), Action = "movie.search", Outcome = "succeeded" } });
        Assert.DoesNotContain(AuditRows(r), a => a.Id == "deleted-user-legacy");
        Assert.Empty(r.Ledger.List(r.Member, false));
    }

    [Fact]
    public async Task ConcurrentDoubleTapAndTwoUsersShareAnAcquisitionAndChargeOnlyOnce()
    {
        using var r = new Rig();
        var results = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => Task.Run(() => r.Create(client: "tap"))));
        Assert.Single(results.Select(x => x.RequestId).Distinct());
        Assert.Equal(1, r.Service.Quota(r.Member).Used);
        var other = r.Add("Member");
        Assert.Equal("accepted", (await r.Create(other)).Outcome);
        Assert.Equal(0, r.Service.Quota(other).Used);
        var a = r.Ledger.List(r.Member, false).Single(); var b = r.Ledger.List(other, false).Single();
        Assert.Equal(a.AcquisitionId, b.AcquisitionId);
        Assert.Single(r.Ledger.Due(r.Now));
        await r.Runner().TickAsync(default);
        Assert.Equal("sent", r.Ledger.List(other, false).Single().Status);
        var third = r.Add("Member");
        Assert.Equal("merged", (await r.Create(third)).Outcome); // A confirmed backend result, not merely queued intent.
    }
    [Fact]
    public async Task WithdrawingAnUnsentOwnerNeverSilentlyTransfersTheirChargeToFollowers()
    {
        using var r = new Rig(); var owner = await r.Create(); var follower = r.Add("Member"); var joined = await r.Create(follower);
        Assert.Equal(200, r.Service.Close(owner.RequestId!, r.Member, null).HttpStatus);
        Assert.Equal("removed", r.Ledger.Find(joined.RequestId!)!.Reason);
        Assert.Equal(0, r.Service.Quota(follower).Used); Assert.Empty(r.Ledger.Due(r.Now));
        var ask = await r.Create(follower); Assert.Equal(201, ask.HttpStatus); Assert.Equal(1, r.Service.Quota(follower).Used);
    }

    [Fact]
    public async Task DifferentClientIdsForTheSameUsersScopeStillReuseOneActiveWant()
    {
        using var r = new Rig();
        var first = await r.Create(client: "first"); var second = await r.Create(client: "second");
        Assert.Equal(first.RequestId, second.RequestId); Assert.Single(r.Ledger.List(r.Member, false));
        Assert.Equal(second.RequestId, (await r.Create(client: "second")).RequestId);
        Assert.Equal("idempotency_conflict", (await r.Create(input: Movie(604), client: "second")).Reason);
        Assert.Single(r.Ledger.Due(r.Now)); Assert.Equal(1, r.Service.Quota(r.Member).Used);
        using var canonical = JsonDocument.Parse(r.Ledger.Due(r.Now).Single().Input.Canonical);
        Assert.False(canonical.RootElement.TryGetProperty("Canonical", out _));
        Assert.False(canonical.RootElement.TryGetProperty("Fingerprint", out _));
    }
    [Fact]
    public void UpgradeFromSchemaOneBacksUpAndIsIdempotentOnReopen()
    {
        using var r = new Rig();
        var path = Path.Combine(r.Root, "old.db");
        using (var c = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + path))
        {
            c.Open(); using var command = c.CreateCommand(); command.CommandText = AcquireDatabase.Migrations[0] + " PRAGMA user_version=1;"; command.ExecuteNonQuery();
        }
        using (var old = new AcquireDatabase(path)) { Assert.True(old.Available); Assert.Equal(2, old.Version); }
        Assert.Single(Directory.GetFiles(r.Root, "old.db.pre-v1.*"));
        using var reopened = new AcquireDatabase(path); Assert.Equal(2, reopened.Version);
        Assert.Single(Directory.GetFiles(r.Root, "old.db.pre-v1.*"));
    }

    [Fact]
    public async Task CanonicalIdempotencyIgnoresSeasonOrderButRefusesChangedScope()
    {
        using var r = new Rig();
        var first = await r.Create(input: Seasons(2, 1, 1), client: "scope");
        Assert.Equal(first.RequestId, (await r.Create(input: Seasons(1, 2), client: "scope")).RequestId);
        var conflict = await r.Create(input: Seasons(1, 3), client: "scope");
        Assert.Equal(409, conflict.HttpStatus); Assert.Equal("idempotency_conflict", conflict.Reason);
        Assert.Single(r.Ledger.List(r.Member, false));
        Assert.Equal(2, r.Service.Quota(r.Member).Used);
    }
    [Theory]
    [InlineData("want")]
    [InlineData("reservation")]
    [InlineData("job")]
    [InlineData("notice")]
    public async Task FaultBetweenWritesRollsBackAndReopenedDatabaseHasNoPartialIntent(string point)
    {
        using var r = new Rig();
        r.Ledger.Fault = stage => { if (stage == point) throw new IOException("injected"); };
        await Assert.ThrowsAsync<IOException>(() => r.Create(client: "fault"));
        r.Reopen();
        Assert.Empty(r.Ledger.List(r.Member, false)); Assert.Empty(r.Ledger.Due(r.Now)); Assert.Equal(0, r.Service.Quota(r.Member).Used);
        Assert.Equal(201, (await r.Create(client: "fault")).HttpStatus);
        Assert.Equal(AcquireDatabase.Migrations.Count, r.Db.Version);
    }
    [Fact]
    public async Task ConcurrentApprovalCreatesOneJobAndOneCharge()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid);
        var outcomes = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default))));
        Assert.Single(outcomes, o => o.HttpStatus == 200);
        Assert.All(outcomes.Where(o => o.HttpStatus != 200), o => Assert.Equal(409, o.HttpStatus));
        Assert.Single(r.Ledger.ForWant(want.RequestId!)); Assert.Equal(1, r.Service.Quota(r.Kid).Used);
    }
    [Fact]
    public async Task AskingSeasonsSeparatelyStillHitsCumulativeSeriesThreshold()
    {
        using var r = new Rig();
        for (var season = 1; season <= 4; season++) Assert.Equal("queued_outage", (await r.Create(input: Seasons(season))).Reason);
        var excess = await r.Create(input: Seasons(5));
        Assert.Equal("awaiting_approval", excess.Reason);
        Assert.Equal(4, r.Service.Quota(r.Member).Used); Assert.Equal("pending", r.Ledger.Find(excess.RequestId!)!.Status);
    }
    [Fact]
    public async Task MergeChargesOnlyUncoveredSeasonsAndFutureChargesAreIdempotent()
    {
        using var r = new Rig(); await r.Create(input: Seasons(1));
        var other = r.Add("Member"); await r.Create(other, Seasons(1, 2, 3)); Assert.Equal(2, r.Service.Quota(other).Used);
        Assert.Equal(new[] { 1, 2, 3 }, r.Ledger.List(other, false).Single().Input.Seasons);
        Assert.Equal(new[] { 2, 3 }, r.Ledger.List(other, false).Single().OwnedInput!.Seasons);
        var future = await r.Create(input: Seasons(4) with { Scope = "future" });
        Assert.False(r.Ledger.ChargeFutureSeason(future.RequestId!, 5, r.Policy, r.Now)); // No future charge before the monitoring write is confirmed.
        await r.Runner().TickAsync(default);
        Assert.True(r.Ledger.ChargeFutureSeason(future.RequestId!, 5, r.Policy, r.Now));
        Assert.False(r.Ledger.ChargeFutureSeason(future.RequestId!, 5, r.Policy, r.Now));
        Assert.Equal(3, r.Service.Quota(r.Member).Used);
    }
    [Fact]
    public async Task EpisodeCostHasFiveFreeThenChargesInGroupsOfFive()
    {
        using var r = new Rig();
        for (var episode = 1; episode <= 11; episode++) await r.Create(input: Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, episode) } });
        Assert.Equal(2, r.Service.Quota(r.Member).Used);
    }
    [Fact]
    public async Task ApprovalOrderCannotMakeEpisodeChargesDisappearAndFollowersKeepTheirFreeAllowance()
    {
        using var r = new Rig(); var ids = new List<string>();
        for (var ep = 1; ep <= 10; ep++) ids.Add((await r.Create(r.Kid, Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, ep) } })).RequestId!);
        foreach (var id in ids.AsEnumerable().Reverse()) Assert.Equal(200, (await r.Service.ApproveAsync(id, r.Manager, null, default)).HttpStatus);
        Assert.Equal(1, r.Service.Quota(r.Kid).Used);
        var follower = r.Add("Member");
        await r.Create(follower, Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        for (var ep = 11; ep <= 15; ep++) await r.Create(follower, Seasons() with { Scope = "episodes", Episodes = new[] { new RequestEpisode(1, ep) } });
        Assert.Equal(0, r.Service.Quota(follower).Used);
    }

    [Fact]
    public async Task DeclineRefundsAndCooldownRefusesTheSameScope()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid);
        Assert.Equal(200, r.Service.Close(want.RequestId!, r.Manager, "Let's watch it together").HttpStatus);
        Assert.Equal(0, r.Service.Quota(r.Kid).Used);
        Assert.Equal("decline_cooldown", (await r.Create(r.Kid)).Reason);
        r.Now = r.Now.AddDays(7); Assert.Equal(201, (await r.Create(r.Kid)).HttpStatus);
        var pending = r.Ledger.List(r.Kid, false).Single(w => w.Status == "pending");
        Assert.Equal(200, r.Service.Close(pending.Id, r.Kid, null).HttpStatus);
    }
    [Fact]
    public async Task ManagerWithout4kCannotApproveAs4kThroughRawApi()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid);
        var outcome = Outcome(await r.Controller(r.Manager).Approve(want.RequestId!, new(Movie(variant: "4k")), default));
        Assert.Equal(403, outcome.HttpStatus); Assert.Equal("requests_4k_required", outcome.Reason);
        Assert.Empty(r.Ledger.ForWant(want.RequestId!)); Assert.Equal("pending", r.Ledger.Find(want.RequestId!)!.Status);
    }
    [Fact]
    public async Task RawApiRefusesKidRatingAndManagerCannotOverrideRequesterVisibility()
    {
        using var r = new Rig();
        r.Policy.Adjust = (user, _, facts) => user == r.Kid ? facts with { Visible = false, Refusal = "not_visible_to_user" } : facts;
        Assert.Equal(403, Outcome(await r.Controller(r.Kid).Create(new("kid", Movie()), default)).HttpStatus);
        Assert.Empty(r.Ledger.List(r.Kid, false));
        r.Policy.Adjust = null; var want = await r.Create(r.Kid);
        r.Policy.Adjust = (user, _, facts) => user == r.Kid ? facts with { Visible = false, Refusal = "not_visible_to_user" } : facts;
        Assert.Equal(403, Outcome(await r.Controller(r.Manager).Approve(want.RequestId!, null, default)).HttpStatus);
        Assert.Empty(r.Ledger.ForWant(want.RequestId!));
        var list = r.Service.List(r.Kid, false); Assert.Empty(JsonDocument.Parse(list.Json).RootElement.GetProperty("items").EnumerateArray());
    }
    [Fact]
    public async Task PrivateBodiesAndEtagsAreIsolatedByUserRoleAndPolicyRevision()
    {
        using var r = new Rig(); await r.Create(r.Kid);
        var member = r.Service.List(r.Member, false); var manager = r.Service.List(r.Manager, true);
        Assert.NotEqual(member.ETag, manager.ETag); Assert.NotEqual(member.Json, manager.Json);
        Assert.Contains("requesterId", Encoding.UTF8.GetString(manager.Json));
        var sameUserMember = r.Service.List(r.Member, false);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Role = "Manager", CanApprove = true };
        Assert.NotEqual(sameUserMember.ETag, r.Service.List(r.Member, false).ETag);
        var before = r.Service.List(r.Member, false);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Revision = "p2" };
        Assert.NotEqual(before.ETag, r.Service.List(r.Member, false).ETag);
    }
    [Theory]
    [InlineData("user")]
    [InlineData("role")]
    [InlineData("parental")]
    [InlineData("library")]
    [InlineData("capability")]
    [InlineData("flag")]
    [InlineData("backend")]
    [InlineData("generation")]
    [InlineData("identity")]
    [InlineData("approver")]
    [InlineData("kid_role")]
    [InlineData("preset")]
    [InlineData("quota")]
    [InlineData("series_threshold")]
    [InlineData("gb")]
    public async Task ReauthorizationAfterBlockedPrerequisitePreventsEveryRevokedSend(string change)
    {
        using var r = new Rig();
        var variant = change == "capability" ? "4k" : "standard";
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Can4k = true };
        var input = change is "quota" or "series_threshold" ? Seasons(1, 2) : Movie(variant: variant);
        var want = await r.Create(change == "approver" ? r.Kid : r.Member, input);
        if (change == "approver") await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        r.Policy.Before = (_, _) => { entered.TrySetResult(); return resume.Task; };
        var tick = r.Runner().TickAsync(default); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var f = r.Policy.People[r.Member];
        switch (change)
        {
            case "user": r.Policy.People.Remove(r.Member); break;
            case "role": r.Policy.People[r.Member] = f with { Role = "Watcher", CanCreate = false }; break;
            case "parental": case "library": r.Policy.People[r.Member] = f with { Visible = false, Refusal = "not_visible_to_user", Revision = "p2" }; break;
            case "capability": r.Policy.People[r.Member] = f with { Can4k = false }; break;
            case "flag": r.Policy.Configuration.ArrPhase3Enabled = false; break;
            case "backend": r.Policy.Configuration.ArrRequestBackend = "seerr"; break;
            case "generation": r.Policy.People[r.Member] = f with { ConnectionGeneration = "g2" }; break;
            case "identity": r.Policy.People[r.Member] = f with { SeerrSource = "s2", SeerrUser = 9 }; break;
            case "approver": r.Policy.People[r.Manager] = r.Policy.People[r.Manager] with { Role = "Member", CanApprove = false }; break;
            case "kid_role": r.Policy.People[r.Member] = f with { Role = "Kid" }; break;
            case "preset": r.Policy.Configuration.ArrRequestPreset = "approve_everything"; break;
            case "quota": r.Policy.People[r.Member] = f with { Limit = 1 }; break;
            case "series_threshold": r.Policy.Configuration.ArrRequestSeriesThreshold = 1; break;
            case "gb": r.Policy.People[r.Member] = f with { GbLimit = 1 }; break;
        }
        resume.SetResult(); await tick;
        Assert.Equal(0, r.Backend.Sends); Assert.Equal("parked", r.Ledger.ForWant(want.RequestId!).Single().State);
    }
    [Fact]
    public async Task BackendGateRunsFinalGuardAndBenignRevisionChangeReevaluatesSuccessfully()
    {
        using var r = new Rig(); var want = await r.Create();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        r.Backend.Gate = () => { entered.SetResult(); return resume.Task; };
        var tick = r.Runner().TickAsync(default); await entered.Task;
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { CanCreate = false };
        resume.SetResult(); await tick; Assert.Equal(0, r.Backend.Sends);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { CanCreate = true, Revision = "new-stamp" };
        r.Backend.Gate = null;
        await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default);
        await r.Runner().TickAsync(default); Assert.Equal(1, r.Backend.Sends);
    }
    [Fact]
    public async Task RestartMidSendReadbacksInsteadOfPostingAgainAndKeepsReservation()
    {
        using var r = new Rig(); var want = await r.Create(); var job = r.Ledger.Due(r.Now).Single();
        Assert.True(r.Ledger.Claim(job, r.Db.Generation, r.Now));
        r.Reopen(); r.Ledger.Recover(r.Now); r.Backend.Unknown = true;
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Backend.Sends); Assert.Equal(1, r.Backend.Reads); Assert.Equal(1, r.Service.Quota(r.Member).Used);
        Assert.Equal("maybe_sent", r.Ledger.ForWant(want.RequestId!).Single().State);
        Assert.Equal(409, r.Service.Close(want.RequestId!, r.Member, null).HttpStatus);
    }
    [Fact]
    public async Task UnavailableReadbackCannotTurnUncertainSendIntoABlindRetry()
    {
        using var r = new Rig(); var want = await r.Create(); var job = r.Ledger.Due(r.Now).Single();
        r.Ledger.Claim(job, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now);
        var backend = new FailedReadback(); await r.Runner(backend).TickAsync(default);
        Assert.Equal("maybe_sent", r.Ledger.ForWant(want.RequestId!).Single().State);
        Assert.Equal(1, r.Service.Quota(r.Member).Used); Assert.Equal(0, backend.Sends);
    }
    private sealed class FailedReadback : IRequestBackend
    {
        public int Sends { get; private set; }
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> guard, CancellationToken ct)
        { Sends++; return Task.FromResult(new RequestBackendResult(RequestOutcome.Refused("backend_unavailable", 503, "unavailable"), Retryable: true)); }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
            => Task.FromResult(new RequestBackendResult(RequestOutcome.Refused("backend_unavailable", 503, "unavailable"), Retryable: true));
    }

    [Fact]
    public async Task RevokingAuthorizationForAnUncertainJobNeverAllowsRefundOrBlindReapproval()
    {
        using var r = new Rig(); var want = await r.Create(); var job = r.Ledger.Due(r.Now).Single();
        r.Ledger.Claim(job, r.Db.Generation, r.Now); r.Ledger.Recover(r.Now);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { CanCreate = false };
        r.Backend.Unknown = true;
        await r.Runner().TickAsync(default);
        Assert.Equal("maybe_sent", r.Ledger.ForWant(want.RequestId!).Single().State); Assert.Equal(0, r.Backend.Sends);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { CanCreate = true };
        Assert.Equal(409, (await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default)).HttpStatus);
        Assert.Equal(409, r.Service.Close(want.RequestId!, r.Member, null).HttpStatus);
        Assert.Equal(1, r.Service.Quota(r.Member).Used);
    }

    [Fact]
    public async Task PlaceholderRetriesDurablyAndUnsentCancellationRefunds()
    {
        using var r = new Rig(); var want = await r.Create();
        await r.Runner(new UnavailableRequestBackend()).TickAsync(default);
        Assert.Equal("retry", r.Ledger.ForWant(want.RequestId!).Single().State);
        Assert.Equal("backend_unavailable", r.Ledger.ForWant(want.RequestId!).Single().Reason);
        r.Reopen(); Assert.Single(r.Ledger.ForWant(want.RequestId!));
        Assert.Equal(200, r.Service.Close(want.RequestId!, r.Member, null).HttpStatus); Assert.Equal(0, r.Service.Quota(r.Member).Used);
    }
    [Fact]
    public async Task BackupRestoreIncludesLedgerAndRejectsOldGenerationCompletion()
    {
        using var r = new Rig(); var want = await r.Create(); var bytes = r.Db.Snapshot()!; var job = r.Ledger.Due(r.Now).Single(); var oldGeneration = r.Db.Generation;
        Assert.True(r.Ledger.Claim(job, oldGeneration, r.Now)); r.Db.ReplaceWith(bytes);
        r.Ledger.Complete(job, oldGeneration, new(RequestOutcome.Accepted(want.RequestId!, "looking"), Confirmed: true), r.Now);
        Assert.Equal("queued", r.Ledger.ForWant(want.RequestId!).Single().State); Assert.Equal(1, r.Service.Quota(r.Member).Used);
    }
    [Fact]
    public async Task PurgeDeletedUserRemovesIntentAndPersonalJobContextAndPreventsLateWrites()
    {
        using var r = new Rig(); var want = await r.Create(r.Kid); await r.Service.ApproveAsync(want.RequestId!, r.Manager, null, default);
        r.Ledger.PurgeUser(r.Manager); Assert.Equal("parked", Assert.Single(r.Ledger.ForWant(want.RequestId!)).State); Assert.Equal("identity_changed", r.Ledger.Find(want.RequestId!)!.Reason);
        r.Ledger.PurgeUser(r.Kid); Assert.Empty(r.Ledger.List(r.Kid, false)); Assert.Equal(0, r.Service.Quota(r.Kid).Used);
        Assert.Equal(403, (await r.Create(r.Kid)).HttpStatus);
    }
    [Fact]
    public async Task BulkApprovalRechecksEachItemAndReturnsPerItemFailures()
    {
        using var r = new Rig(); var first = await r.Create(r.Kid); var second = await r.Create(r.Kid, Movie(604));
        r.Policy.Adjust = (user, input, facts) => user == r.Manager && input.Key == "movie:tmdb:604" ? facts with { Visible = false, Refusal = "not_visible_to_user" } : facts;
        var response = Assert.IsType<ObjectResult>(await r.Controller(r.Manager).BulkApprove(new(new[] { first.RequestId!, second.RequestId! }), default));
        Assert.Equal(207, response.StatusCode); Assert.Single(r.Ledger.ForWant(first.RequestId!)); Assert.Empty(r.Ledger.ForWant(second.RequestId!));
    }
    [Fact]
    public async Task EveryRequestRouteRefusesApiKeysAndUnknownUsersAndViewerCannotApprove()
    {
        using var r = new Rig();
        foreach (var principal in new[] { TestCallers.ApiKey(), TestCallers.Unknown() })
        {
            var c = r.Controller(principal: principal);
            Assert.Equal(403, Outcome(await c.Create(null, default)).HttpStatus);
            Assert.Equal(403, Outcome(await c.List()).HttpStatus); Assert.Equal(403, Outcome(await c.Quota()).HttpStatus);
            Assert.Equal(403, Outcome(await c.Approve("id", null, default)).HttpStatus);
            Assert.Equal(403, Outcome(c.Cancel("id")).HttpStatus); Assert.Equal(403, Outcome(await c.Decline("id", null)).HttpStatus);
            Assert.Equal(403, Outcome(await c.BulkApprove(null, default)).HttpStatus); Assert.Equal(403, Outcome(c.LabDelete("id")).HttpStatus); Assert.Equal(403, Outcome(c.LabHold("id")).HttpStatus);
        }
        Assert.Equal(403, Outcome(await r.Controller().Approve("id", null, default)).HttpStatus);
        Assert.Equal(403, Outcome(await r.Controller().List("pending")).HttpStatus); Assert.Empty(r.Ledger.Due(r.Now));
    }
    [Fact]
    public async Task SeerrManagerCanReadPendingButApprovalRefreshesManagementPermissionAndUnknownQuotaIsUnavailable()
    {
        using var r = new Rig(); r.Policy.Configuration.ArrRequestBackend = "seerr";
        r.Policy.People[r.Manager] = r.Policy.People[r.Manager] with { CanApprove = false };
        var want = await r.Create(r.Kid);
        var list = Assert.IsType<FileContentResult>(await r.Controller(r.Manager).List("pending"));
        var row = JsonDocument.Parse(list.FileContents).RootElement.GetProperty("items").EnumerateArray().Single();
        Assert.False(row.GetProperty("canApprove").GetBoolean()); Assert.Equal(r.Kid, row.GetProperty("requesterId").GetGuid());
        Assert.False(r.Service.Quota(r.Manager).Available);
        r.Policy.Before = (user, _) =>
        {
            if (user == r.Manager) r.Policy.People[user] = r.Policy.People[user] with { CanApprove = true };
            return Task.CompletedTask;
        };
        Assert.Equal(200, Outcome(await r.Controller(r.Manager).Approve(want.RequestId!, null, default)).HttpStatus);
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Backend.Sends); Assert.Equal("retry", r.Ledger.ForWant(want.RequestId!).Single().State);
    }

    [Fact]
    public void RequestFailuresUseSafeA2BodiesInsteadOfExceptionPaths()
    {
        var http = new DefaultHttpContext();
        var context = new Microsoft.AspNetCore.Mvc.Filters.ExceptionContext(
            new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), new Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor()),
            new List<Microsoft.AspNetCore.Mvc.Filters.IFilterMetadata>()) { Exception = new IOException("private backend /private/path") };
        new Jellyfin.Plugin.JellyfinEnhanced.Helpers.RequestOutcomeFilterAttribute().OnException(context);
        Assert.True(context.ExceptionHandled);
        var result = Assert.IsType<ObjectResult>(context.Result); Assert.Equal(503, result.StatusCode);
        var outcome = Assert.IsType<RequestOutcome>(result.Value); Assert.Equal("unavailable", outcome.Outcome);
        Assert.DoesNotContain("private", outcome.Message); Assert.Equal("private, no-store", http.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public void NoProductionCSharpDeclaresAsyncVoid()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        // External output folders do not have the repository as an ancestor.
        root ??= new DirectoryInfo(Directory.GetCurrentDirectory());
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        Assert.NotNull(root);
        var files = Directory.EnumerateFiles(Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced"), "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains("/obj/") && !f.Contains("/bin/"));
        Assert.DoesNotContain(files, f => Regex.IsMatch(File.ReadAllText(f), @"\basync\s+void\b"));
    }
}
