using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Rig = JE.Tests.IntegrationRequestLedgerTests.Rig;

namespace JE.Tests;

/// <summary>
/// Withdrawing a request (cancel or decline) is one rule (phase 4b, review round 4: B10, B11, security-r4-1): who may,
/// seeing the request where it actually goes; what is cancelled and refunded (work proven unsent: queued, retrying,
/// held, failed); what stays (work that went out, and work that may have); and what becomes of the people following it.
/// Table: the request's parts × someone following it × cancel or decline × who withdraws it. Ledger and outbox over a
/// scripted backend, Seerr handling (where a keep-getting request follows new seasons).
/// </summary>
public class IntegrationRequestWithdrawalTableTests
{
    private const string Show = "tv:tvdb:81189";

    /// <summary>Where the request's parts are when it is withdrawn.</summary>
    public enum Part
    {
        /// <summary>Waiting for an OK; nothing to send yet.</summary>
        Held,
        /// <summary>Queued, not sent.</summary>
        Queued,
        /// <summary>Its send is retried later; nothing went out.</summary>
        Retry,
        /// <summary>Held at send (parked); nothing went out.</summary>
        Parked,
        /// <summary>The send was refused; nothing went out.</summary>
        Failed,
        /// <summary>Held after it was written (certainty unknown).</summary>
        Uncertain,
        /// <summary>It may have gone out; a read-back settles it.</summary>
        InFlight,
        /// <summary>It went out.</summary>
        Sent,
        /// <summary>Keep getting: season 2 went out, season 3's follow is queued.</summary>
        SentAndQueued,
        /// <summary>Season 2 went out, season 3 is retried later.</summary>
        SentAndRetry,
        /// <summary>Season 2 went out, season 3 is held at send.</summary>
        SentAndParked,
        /// <summary>Season 2 went out, season 3's send was refused (B10).</summary>
        SentAndFailed,
        /// <summary>Season 2 went out, season 3 was written but isn't confirmed.</summary>
        SentAndUncertain,
    }

    /// <summary>Who withdraws it.</summary>
    public enum Actor
    {
        /// <summary>The person who asked (a Member).</summary>
        Owner,
        /// <summary>Another Member.</summary>
        Stranger,
        /// <summary>A Manager (may approve and decline).</summary>
        Manager,
        /// <summary>An administrator.</summary>
        Admin,
    }

    public static TheoryData<Part, bool, bool, Actor> Every()
    {
        var rows = new TheoryData<Part, bool, bool, Actor>();
        foreach (var part in Enum.GetValues<Part>())
            foreach (var follower in new[] { false, true })
                foreach (var decline in new[] { false, true })
                    foreach (var actor in Enum.GetValues<Actor>()) rows.Add(part, follower, decline, actor);
        return rows;
    }

    /// <summary>A backend whose answer each test scripts (confirmed by default); never reached for a refusal at the guard.</summary>
    internal sealed class Scripted : IRequestBackend
    {
        public Func<RequestJob, RequestBackendResult>? Next { get; set; }
        public int Sends { get; private set; }
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
        {
            if (finalGuard() is { } refusal) return Task.FromResult(RequestBackendResult.Hold(refusal));
            Sends++;
            return Task.FromResult(Next?.Invoke(job) ?? new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true));
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => Task.FromResult(RequestBackendResult.Uncertain(job.WantId));
    }

    private static RequestBackendResult Result(Part part, RequestJob job) => part switch
    {
        Part.Retry or Part.SentAndRetry => BackendResults.Retry("service_down", "Seerr is down."),
        Part.Parked or Part.SentAndParked => BackendResults.Hold("seerr_options_changed", "Seerr's servers changed."),
        Part.Failed or Part.SentAndFailed => BackendResults.Failed("seerr_rejected", "Seerr refused it."),
        Part.Uncertain or Part.SentAndUncertain => BackendResults.HoldAfterWrite(job.WantId, "seerr_options_changed", "Seerr stored it elsewhere."),
        Part.InFlight => BackendResults.Maybe(job.WantId, "Not confirmed yet."),
        _ => new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true),
    };

    private static bool KeepGetting(Part part) => part is Part.SentAndQueued or Part.SentAndRetry or Part.SentAndParked or Part.SentAndFailed or Part.SentAndUncertain;

    internal sealed class Setup : IDisposable
    {
        public Rig Rig { get; } = new();
        public Scripted Backend { get; } = new();
        public Guid Owner { get; }
        public Guid Stranger { get; }
        public Guid Follower { get; }
        public string Id { get; private set; } = string.Empty;
        public string? FollowerId { get; private set; }
        public RequestOutbox Outbox { get; }

        public Setup()
        {
            Rig.Policy.Configuration.ArrRequestBackend = "seerr";
            Rig.Policy.Configuration.ArrRequestChargeFutureSeasons = true;
            Owner = Rig.Member;
            Stranger = Rig.Add("Member");
            Follower = Rig.Add("Member");
            foreach (var person in Rig.Policy.People.Keys.ToList()) Linked(person);
            Outbox = Rig.Runner(Backend);
        }

        /// <summary>A person with a Seerr account and readable Seerr quota (Seerr handling sends as them).</summary>
        public Guid Linked(Guid person)
        {
            Rig.Policy.People[person] = Rig.Policy.People[person] with { SeerrSource = "seerr-a", SeerrUser = Rig.Policy.People.Keys.ToList().IndexOf(person) + 1, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
            return person;
        }

        public Guid Who(Actor actor) => actor switch { Actor.Owner => Owner, Actor.Stranger => Stranger, Actor.Manager => Rig.Manager, _ => Rig.Admin };

        /// <summary>The owner's request with its parts where <paramref name="part"/> says, followed by someone when asked.</summary>
        public async Task Build(Part part, bool follower, Guid? owner = null, MutationInput? routing = null)
        {
            var by = owner ?? Owner;
            var input = (routing ?? new MutationInput()) with { Key = Show, Scope = KeepGetting(part) ? "future" : "seasons", Seasons = KeepGetting(part) ? new[] { 2 } : new[] { 1 } };
            var origin = part == Part.Held ? new RequestOrigin(RequestOrigin.InteractiveKind) { RequireApproval = true } : null;
            var outcome = await Rig.Service.CreateAsync(by, new(Guid.NewGuid().ToString("N"), input), default, origin);
            Assert.True(outcome.HttpStatus == 201, outcome.Reason + ": " + outcome.Message);
            Id = outcome.RequestId!;
            if (KeepGetting(part))
            {
                await Outbox.TickAsync(default);
                Assert.Equal("sent", Rig.Ledger.Find(Id)!.Status);
                Assert.True(Rig.Ledger.FollowFutureSeason(Id, 3, Rig.Policy, Rig.Now));
            }
            if (follower)
            {
                // Someone else asks for the part that isn't out yet (the same as the owner's when nothing is).
                var ask = await Rig.Service.CreateAsync(Follower, new(Guid.NewGuid().ToString("N"), new MutationInput { Key = Show, Scope = "seasons", Seasons = KeepGetting(part) ? new[] { 3 } : new[] { 1 } }), default);
                Assert.True(ask.HttpStatus == 201, ask.Reason + ": " + ask.Message);
                FollowerId = ask.RequestId!;
                Assert.True(Rig.Ledger.Find(FollowerId)!.Follower);
            }
            if (part is not (Part.Held or Part.Queued or Part.SentAndQueued))
            {
                Backend.Next = job => Result(part, job);
                await Outbox.TickAsync(default);
                Backend.Next = null;
            }
            var jobs = Rig.Ledger.ForWant(Id);
            var last = jobs.LastOrDefault(j => !KeepGetting(part) || j.Input.Seasons.SequenceEqual(new[] { 3 }));
            var expected = part switch
            {
                Part.Held => null,
                Part.Queued or Part.SentAndQueued => "queued",
                Part.Retry or Part.SentAndRetry => "retry",
                Part.Parked or Part.SentAndParked or Part.Uncertain or Part.SentAndUncertain => "parked",
                Part.Failed or Part.SentAndFailed => "failed",
                Part.InFlight => "maybe_sent",
                _ => "succeeded",
            };
            Assert.Equal(expected, last?.State);
        }

        // Reservation state per scope of a request ("initial", "s3", …).
        public Dictionary<string, string> Reservations(string want) => Rig.Db.Read(c =>
        {
            using var cmd = RequestLedger.Cmd(c, null, "SELECT scope,state FROM reservations WHERE want_id=$w", ("$w", want));
            using var r = cmd.ExecuteReader();
            var map = new Dictionary<string, string>();
            while (r.Read()) map[r.GetString(0).StartsWith("approval:", StringComparison.Ordinal) ? "approval" : r.GetString(0)] = r.GetString(1);
            return map;
        });

        public void Dispose() => Rig.Dispose();
    }

    private static bool Uncertain(Part part) => part is Part.Uncertain or Part.InFlight or Part.SentAndUncertain;

    private static bool PartSent(Part part) => part is Part.Sent or Part.SentAndQueued or Part.SentAndRetry or Part.SentAndParked or Part.SentAndFailed or Part.SentAndUncertain;

    // The request's status before it is withdrawn.
    private static string StatusOf(Part part) => part switch
    {
        Part.Held or Part.Parked or Part.Failed or Part.Uncertain or Part.SentAndParked or Part.SentAndFailed or Part.SentAndUncertain => "pending",
        Part.Sent or Part.SentAndQueued => "sent",
        _ => "queued",
    };

    [Theory]
    [MemberData(nameof(Every))]
    public async Task WithdrawingARequestIsOneRuleOverItsPartsItsFollowersTheActionAndWhoWithdrawsIt(Part part, bool follower, bool decline, Actor actor)
    {
        using var s = new Setup();
        await s.Build(part, follower);
        var before = s.Rig.Ledger.Find(s.Id)!;
        Assert.Equal(StatusOf(part), before.Status);
        var beforeJobs = s.Rig.Ledger.ForWant(s.Id).ToDictionary(j => j.Id, j => j.State);
        var beforeFollower = s.FollowerId == null ? null : s.Rig.Ledger.Find(s.FollowerId);
        var outcome = decline
            ? await s.Rig.Service.DeclineAsync(s.Id, s.Who(actor), "Not now.", default)
            : s.Rig.Service.Close(s.Id, s.Who(actor), null);

        // Who may: the owner or an administrator cancels; a Manager or an administrator declines.
        var allowed = decline ? actor is Actor.Manager or Actor.Admin : actor is Actor.Owner or Actor.Admin;
        // What may be withdrawn: anything active (declining: only what waits for an OK); never while a part may have gone
        // out; with a part that went out, only while it waits for an OK and what went out covers what it asked for.
        string? refusal = !allowed ? "requests_approve_required"
            : decline && StatusOf(part) != "pending" ? "request_changed"
            : Uncertain(part) ? "request_in_flight"
            : PartSent(part) && StatusOf(part) != "pending" ? "request_in_flight"
            : null;
        var after = s.Rig.Ledger.Find(s.Id)!;
        var jobs = s.Rig.Ledger.ForWant(s.Id);
        if (refusal != null)
        {
            Assert.Equal(refusal, outcome.Reason);
            Assert.True(outcome.HttpStatus >= 400);
            // Nothing changed.
            Assert.Equal((before.Status, before.Reason), (after.Status, after.Reason));
            Assert.Equal(beforeJobs, jobs.ToDictionary(j => j.Id, j => j.State));
            if (beforeFollower != null) Assert.Equal((beforeFollower.Status, beforeFollower.Follower), (s.Rig.Ledger.Find(s.FollowerId!)!.Status, s.Rig.Ledger.Find(s.FollowerId!)!.Follower));
            return;
        }
        Assert.True(outcome.HttpStatus == 200, outcome.Reason + ": " + outcome.Message);
        var reservations = s.Reservations(s.Id);
        if (PartSent(part))
        {
            // What went out stays, charged; every part proven unsent is cancelled and refunded (failed included: B10).
            Assert.Equal(("sent", "looking"), (after.Status, after.Reason));
            Assert.Equal("succeeded", Assert.Single(jobs, j => j.Input.Seasons.SequenceEqual(new[] { 2 })).State);
            Assert.Equal("cancelled", Assert.Single(jobs, j => j.Input.Seasons.SequenceEqual(new[] { 3 })).State);
            Assert.Equal("charged", reservations["initial"]);
            Assert.Equal("refunded", reservations["s3"]);
            Assert.Equal(1, after.Cost);
        }
        else
        {
            Assert.Equal(decline ? "declined" : "cancelled", after.Status);
            Assert.All(jobs, j => Assert.Equal("cancelled", j.State));
            Assert.All(reservations.Values, state => Assert.Equal("refunded", state));
        }
        if (s.FollowerId == null) return;
        // The person following it is never left waiting on nothing (B11): a cancel withdraws what they followed; a
        // decline makes them the owner of what nobody else is asking for, waiting for an OK.
        var followed = s.Rig.Ledger.Find(s.FollowerId)!;
        if (!decline)
        {
            Assert.Equal(("cancelled", "removed"), (followed.Status, followed.Reason));
            Assert.All(s.Reservations(s.FollowerId).Values, state => Assert.Equal("refunded", state));
        }
        else
        {
            Assert.Equal("pending", followed.Status);
            Assert.False(followed.Follower);
            Assert.Equal(KeepGetting(part) ? new[] { 3 } : new[] { 1 }, followed.OwnedInput!.Seasons);
            Assert.Equal(1, followed.Cost);
        }
        // Asking again is a request of its own now, never the old orphan "already recorded".
        var again = await s.Rig.Service.CreateAsync(s.Follower, new(Guid.NewGuid().ToString("N"), new MutationInput { Key = Show, Scope = "seasons", Seasons = KeepGetting(part) ? new[] { 3 } : new[] { 1 } }), default);
        if (decline)
        {
            // Their own request (now waiting for an OK) is the answer.
            Assert.Equal((s.FollowerId, 200), (again.RequestId, again.HttpStatus));
            return;
        }
        Assert.True(again.HttpStatus == 201, again.Reason + ": " + again.Message);
        Assert.NotEqual(s.FollowerId, again.RequestId);
    }

    /// <summary>
    /// A person deleted from Jellyfin withdraws by the same rule: what went out stays (anonymised), and every part proven
    /// unsent (held and refused parts included) is cancelled and refunded, so it holds no one's allowance or pool.
    /// </summary>
    [Theory]
    [InlineData(Part.SentAndQueued)]
    [InlineData(Part.SentAndRetry)]
    [InlineData(Part.SentAndParked)]
    [InlineData(Part.SentAndFailed)]
    public async Task ADeletedPersonsUnsentPartsAreWithdrawnByTheSameRule(Part part)
    {
        using var s = new Setup();
        await s.Build(part, follower: false);
        s.Rig.Ledger.PurgeUser(s.Owner);
        var jobs = s.Rig.Ledger.ForWant(s.Id);
        Assert.Equal("succeeded", Assert.Single(jobs, j => j.Input.Seasons.SequenceEqual(new[] { 2 })).State);
        Assert.Equal("cancelled", Assert.Single(jobs, j => j.Input.Seasons.SequenceEqual(new[] { 3 })).State);
        Assert.Equal(("charged", "refunded"), (s.Reservations(s.Id)["initial"], s.Reservations(s.Id)["s3"]));
    }

    // ------------------------------------------------------------------ seeing where it actually goes (security-r4-1)

    public static TheoryData<string, Part> Hidden()
    {
        var rows = new TheoryData<string, Part>();
        foreach (var part in new[] { Part.Held, Part.Parked, Part.Failed })
        {
            rows.Add("je", part);
            rows.Add("seerr", part);
        }
        rows.Add("seerr", Part.SentAndParked);
        rows.Add("seerr", Part.SentAndFailed);
        return rows;
    }

    /// <summary>
    /// An administrator's request going to a folder a Manager can't see (while the title's ordinary folder is one they
    /// can): the Manager can't decline it, whatever state it is in; another Manager and an administrator can. Whether
    /// it may be withdrawn never depends on its routing still fitting (that is often why it waits), but who sees it does.
    /// </summary>
    [Theory]
    [MemberData(nameof(Hidden))]
    public async Task OnlySomeoneWhoSeesWhereARequestGoesMayDeclineIt(string backend, Part part)
    {
        using var s = new Setup();
        s.Rig.Policy.Configuration.ArrRequestBackend = backend;
        var blind = s.Linked(s.Rig.Add("Manager"));
        // The stub's visibility: the blind Manager can't see the hidden folder (an arr folder, or a Seerr root folder).
        s.Rig.Policy.Adjust = (user, input, facts) => user == blind && (input.RootFolder == "/hidden" || input.SeerrRootFolder == "/hidden")
            ? facts with { Visible = false, Refusal = "not_visible_to_user" }
            // The request's routing no longer fits (its stamp is stale): that never stops a withdrawal.
            : input.SeerrOptions != null ? facts with { Refusal = "seerr_options_changed" } : facts;
        var routing = backend == "je" ? new MutationInput { RootFolder = "/hidden" } : new MutationInput { SeerrServerId = 0, SeerrProfileId = 4, SeerrRootFolder = "/hidden", SeerrOptions = "STAMP" };
        // Created while its options still fit.
        var adjust = s.Rig.Policy.Adjust;
        s.Rig.Policy.Adjust = (user, input, facts) => adjust(user, input, facts) is { Refusal: "seerr_options_changed" } stale ? stale with { Refusal = null } : adjust(user, input, facts);
        await s.Build(part, follower: false, owner: s.Rig.Admin, routing: routing);
        s.Rig.Policy.Adjust = adjust;
        Assert.Equal("pending", s.Rig.Ledger.Find(s.Id)!.Status);

        var refused = await s.Rig.Service.DeclineAsync(s.Id, blind, "Not now.", default);
        Assert.Equal(("not_visible_to_user", 403), (refused.Reason, refused.HttpStatus));
        Assert.Equal("pending", s.Rig.Ledger.Find(s.Id)!.Status);
        var declined = await s.Rig.Service.DeclineAsync(s.Id, s.Rig.Manager, "Not now.", default);
        Assert.True(declined.HttpStatus == 200, declined.Reason + ": " + declined.Message);
        Assert.Equal(PartSent(part) ? "sent" : "declined", s.Rig.Ledger.Find(s.Id)!.Status);
    }
}
