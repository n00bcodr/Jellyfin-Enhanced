using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Transactional request, reservation, approval and outbox storage in acquire.db.</summary>
    public sealed partial class RequestLedger
    {
        private readonly AcquireDatabase _db;
        internal Action<string>? Fault { get; set; }
        /// <summary>Creates the ledger over the shared database.</summary>
        public RequestLedger(AcquireDatabase database) { _db = database; }
        /// <summary>The database, including its restore generation.</summary>
        public AcquireDatabase Database => _db;
        /// <summary>The durable owner of title-wide add settings.</summary>
        public TitleChoiceRegistry Choices => new(_db);
        internal static long Ms(DateTimeOffset at) => at.ToUnixTimeMilliseconds();
        internal static string Id(Guid user) => user.ToString("N", CultureInfo.InvariantCulture);
        internal static string NewId() => Guid.NewGuid().ToString("N");
        internal static SqliteCommand Cmd(SqliteConnection c, SqliteTransaction? t, string sql, params (string, object?)[] args) => NotifyStore.Command(c, t, sql, args);
        internal static int Exec(SqliteConnection c, SqliteTransaction t, string sql, params (string, object?)[] args) => NotifyStore.Exec(c, t, sql, args);
        private static string? Scalar(SqliteConnection c, SqliteTransaction? t, string sql, params (string, object?)[] args)
        {
            using var cmd = Cmd(c, t, sql, args);
            return cmd.ExecuteScalar()?.ToString();
        }
        /// <summary>
        /// Wants a move from Seerr imported but hasn't handed over yet (their batch is <c>staged</c>): no reader, list,
        /// action or dispatch sees them until the handover commits the batch; a refused handover discards it whole.
        /// </summary>
        internal const string NotStaged = "(import_batch_id IS NULL OR import_batch_id NOT IN (SELECT id FROM import_batches WHERE state='staged'))";

        private static List<RequestWant> Wants(SqliteConnection c, SqliteTransaction? t, string where = "1=1", params (string, object?)[] args)
        {
            using var cmd = Cmd(c, t, "SELECT id,acquisition_id,user_id,client_request_id,fingerprint,mutation_input,status,reason,cost,parental_signature,created_at,updated_at,is_follower,owned_input,target_key,origin_kind,origin_source_id,origin_detail,operation_id,rule_detail FROM wants WHERE (" + where + ") AND " + NotStaged + " ORDER BY created_at,id", args);
            using var r = cmd.ExecuteReader();
            var list = new List<RequestWant>();
            while (r.Read()) list.Add(new(r.GetString(0), r.GetString(1), Guid.Parse(r.GetString(2)), r.GetString(3), r.GetString(4),
                JsonSerializer.Deserialize<MutationInput>(r.GetString(5))!, r.GetString(6), r.GetString(7), r.GetInt32(8), r.GetString(9),
                DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(10)), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(11)), r.GetBoolean(12), r.IsDBNull(13) ? null : JsonSerializer.Deserialize<MutationInput>(r.GetString(13)), r.GetString(14), r.GetString(15),
                r.IsDBNull(16) ? null : r.GetString(16), r.IsDBNull(17) ? null : r.GetString(17), r.IsDBNull(18) ? null : r.GetString(18), r.IsDBNull(19) ? null : r.GetString(19)));
            return list;
        }
        internal static void ExtendSchemaTwo(SqliteConnection c, SqliteTransaction t, bool targets, bool reservations, bool onlyEmptyTargets = false)
        {
            if (targets)
            {
                var wants = Wants(c, t, onlyEmptyTargets ? "target_key='' AND status IN ('pending','queued','sent','stale')" : "1=1");
                foreach (var want in wants)
                {
                    var own = Jobs(c, t, "want_id=$id", ("$id", want.Id));
                    var candidates = Jobs(c, t, "want_id=$id AND " + LiveJobs, ("$id", want.Id));
                    if (candidates.Count == 0 && own.Count > 0)
                        candidates = Jobs(c, t, "id=(SELECT id FROM jobs WHERE want_id=$id ORDER BY created_at DESC,rowid DESC LIMIT 1)", ("$id", want.Id));
                    else if (own.Count == 0)
                        candidates = Jobs(c, t, "want_id IN (SELECT id FROM wants WHERE acquisition_id=$a) AND " + LiveJobs, ("$a", want.AcquisitionId));
                    var targetsForWant = candidates.Where(j => RequestDestination.SameEdition(j.Input, want.Input) && (want.Input.InstanceId == null || j.Authorization.InstanceId == want.Input.InstanceId))
                        .Select(j => TargetKey(j.Authorization)).Distinct(StringComparer.Ordinal).ToArray();
                    if (targetsForWant.Length == 1)
                    {
                        Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", targetsForWant[0]), ("$id", want.Id));
                        var coveredScope = Jobs(c, t, "want_id IN (SELECT id FROM wants WHERE acquisition_id=$a AND status IN ('pending','queued','sent','stale')) AND " + LiveJobs, ("$a", want.AcquisitionId))
                            .Where(j => RequestDestination.SameTarget(TargetKey(j.Authorization), targetsForWant[0]) && (want.Status is not ("sent" or "stale") || j.State == "succeeded")).Select(j => j.Input);
                        if (want.Status is "queued" or "sent" or "stale" && want.Input.Extra(coveredScope) != null)
                            Exec(c, t, "UPDATE wants SET status='pending',reason='instance_changed' WHERE id=$id", ("$id", want.Id));
                    }
                    else
                    {
                        // An explicit unresolved identity cannot cover any resolved backend target.
                        Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", "unresolved:" + want.Id), ("$id", want.Id));
                        if (Active(want))
                        {
                            Exec(c, t, "UPDATE wants SET status='pending',reason='instance_changed' WHERE id=$id", ("$id", want.Id));
                            Exec(c, t, "UPDATE jobs SET state='parked',reason='instance_changed' WHERE want_id=$id AND state IN ('queued','retry') AND " + KnownUnsent, ("$id", want.Id));
                        }
                    }
                }
            }
            if (reservations)
            {
                var rows = new List<(string Id, string Want, long At, double Gb, int Episodes)>();
                using (var cmd = Cmd(c, t, "SELECT id,want_id,charged_at,estimated_gb,episode_count FROM reservations WHERE scope='initial' OR scope LIKE 'approval:%' ORDER BY rowid"))
                using (var reader = cmd.ExecuteReader())
                    while (reader.Read()) rows.Add((reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.GetDouble(3), reader.GetInt32(4)));
                var used = new HashSet<string>(StringComparer.Ordinal);
                foreach (var row in rows)
                {
                    // Preserve a charge if historical data is ambiguous; never refund unrelated sent scope.
                    var candidates = new List<(string Id, MutationInput Input)>();
                    using (var cmd = Cmd(c, t, "SELECT id,mutation_input FROM jobs WHERE want_id=$w AND created_at=$at ORDER BY CASE WHEN state IN ('queued','retry','sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown' THEN 0 ELSE 1 END,rowid", ("$w", row.Want), ("$at", row.At)))
                    using (var reader = cmd.ExecuteReader())
                        while (reader.Read()) candidates.Add((reader.GetString(0), JsonSerializer.Deserialize<MutationInput>(reader.GetString(1))!));
                    var match = candidates.FirstOrDefault(j => !used.Contains(j.Id) && EstimateGb(j.Input) == row.Gb && (j.Input.Scope == "episodes" ? j.Input.Episodes.Length : 0) == row.Episodes);
                    if (match.Id == null) continue;
                    used.Add(match.Id);
                    Exec(c, t, "UPDATE reservations SET job_id=$job WHERE id=$id", ("$job", match.Id), ("$id", row.Id));
                }
            }
        }
        /// <summary>One want by opaque id.</summary>
        public RequestWant? Find(string id) => _db.Read(c => Wants(c, null, "id=$id", ("$id", id)).SingleOrDefault());
        /// <summary>Private listing source; policy filtering happens before projection.</summary>
        /// <remarks>
        /// The waiting list also holds requests that went out for a 4K copy nothing can take any more
        /// (<c>no_4k_instance</c>): an administrator has to look at them.
        /// </remarks>
        public IReadOnlyList<RequestWant> List(Guid user, bool pending) => _db.Read(c => Wants(c, null,
            pending ? "status='pending' OR (status IN ('sent','stale') AND reason='" + No4k + "')" : "user_id=$u", ("$u", Id(user))));
        /// <summary>The reason of an open 4K request nothing can take now (no usable 4K instance, or no 4K server in Seerr).</summary>
        internal const string No4k = "no_4k_instance";
        /// <summary>
        /// Holds every open 4K request whose kind nothing can take now (<paramref name="fourKTarget"/> answers false: no
        /// usable 4K Radarr/Sonarr in Jellyfin Enhanced mode, no 4K server in Seerr mode) with the reason
        /// <c>no_4k_instance</c> instead of leaving it to look like it is still coming (and turn stale): one waiting for an
        /// OK or not sent yet waits for an administrator; one that already went out keeps its state, says why and is
        /// listed for administrators. When a 4K target is back (true), each is released as it was: queued again (its job
        /// still due), sent, or waiting for an OK. Unknown (null) changes nothing. Returns the requests changed.
        /// </summary>
        /// <param name="fourKTarget">Whether a 4K copy of a movie (true) or series (false) can be taken now.</param>
        /// <param name="now">Now.</param>
        public IReadOnlyList<RequestWant> HoldWithout4k(Func<bool, bool?> fourKTarget, DateTimeOffset now)
        {
            if (!_db.Available) return Array.Empty<RequestWant>();
            var known = new Dictionary<bool, bool?>();
            bool? Target(RequestWant w) => TitleKey.Parse(w.Input.Key) is { } key ? known.TryGetValue(key.IsMovie, out var k) ? k : known[key.IsMovie] = fourKTarget(key.IsMovie) : null;
            bool Changes(RequestWant w) => Target(w) is bool has && (has ? w.Reason == No4k : w.Reason != No4k);
            if (!_db.Read(c => Wants(c, null, "variant='4k' AND status IN ('pending','queued','sent','stale')")).Any(Changes)) return Array.Empty<RequestWant>();
            return _db.Write((c, t) =>
            {
                var changed = new List<RequestWant>();
                foreach (var want in Wants(c, t, "variant='4k' AND status IN ('pending','queued','sent','stale')").Where(Changes))
                {
                    string status, reason;
                    if (Target(want) == false)
                    {
                        // Not sent yet: waits for an administrator (its job, when due, is held at send with the same reason).
                        (status, reason) = (want.Status is "pending" or "queued" ? "pending" : want.Status, No4k);
                    }
                    else if (want.Status != "pending")
                    {
                        (status, reason) = (want.Status, want.Status == "stale" ? "stale" : "looking");
                    }
                    else
                    {
                        // Its own job still due goes on; scope already sent (by it or anyone) is sent; scope another request is
                        // sending follows it; else it waits for an OK (a job held at send resumes with the OK).
                        var shared = Wants(c, t, "acquisition_id=$a", ("$a", want.AcquisitionId));
                        (status, reason) = Jobs(c, t, "want_id=$id AND state IN ('queued','retry','sending','maybe_sent')", ("$id", want.Id)).Count > 0 ? ("queued", "queued_outage")
                            : want.Input.Extra(Confirmed(c, t, shared, want.TargetKey)) == null ? ("sent", "looking")
                            : want.Input.Extra(Coverage(c, t, shared, want.TargetKey)) == null ? ("queued", "queued_outage")
                            : ("pending", "awaiting_approval");
                    }
                    Exec(c, t, "UPDATE wants SET status=$s,reason=$r,updated_at=$at WHERE id=$id", ("$s", status), ("$r", reason), ("$at", Ms(now)), ("$id", want.Id));
                    Record(c, t, want.Id, null, null, reason == No4k ? "scope_held" : "scope_restored", "accepted", reason, want.Input.Key, now);
                    changed.Add(want with { Status = status, Reason = reason });
                }
                return (IReadOnlyList<RequestWant>)changed;
            });
        }
        /// <summary>Title intent for read models, with canonical provider identity.</summary>
        /// <remarks>Any of the title's ids finds it (the ledger's aliases).</remarks>
        public IReadOnlyList<RequestWant> ForTitle(string key) => _db.Read(c => Wants(c, null, TitleIs, ("$key", key)));
        /// <summary>
        /// True when requests already sent to the caller's request target cover all of <paramref name="input"/>
        /// (succeeded jobs, or a request that was already processing in Seerr when it moved): nothing is left to
        /// ask for, so Search may run the arr's search for it again without a new request.
        /// </summary>
        public bool SentCovers(MutationInput input, RequestPolicyFacts facts) => _db.Available && _db.Read(c =>
        {
            input = Canonical(c, null, input);
            var covered = Wants(c, null, TitleIs + " AND variant=$v", ("$key", input.Key), ("$v", input.Variant)).Where(Active).ToArray();
            // Any connection of the same instance (or Seerr) counts: a Search runs only for parts the instance already
            // monitors, so an address or key change since the send doesn't make them "never asked for".
            var here = TargetKey(facts);
            return covered.Length > 0 && input.Extra(Confirmed(c, null, covered, target => RequestDestination.SamePlace(target, here))) == null;
        });
        /// <summary>
        /// What actually went out for a title, per target: each succeeded job's scope at the time its send was
        /// confirmed, and each request that was already processing in Seerr when it moved (a job-less link) at the
        /// time it was asked for there. A want's own last change (a join, an approval of scope already sent, a
        /// target move) is not a send, so the "still looking" clock counts from these only.
        /// </summary>
        /// <param name="titleKey">Canonical title key.</param>
        public IReadOnlyList<RequestDispatch> Dispatches(string titleKey) => !_db.Available ? Array.Empty<RequestDispatch>() : _db.Read(c =>
        {
            var list = new List<RequestDispatch>();
            using (var cmd = Cmd(c, null, "SELECT j.mutation_input,j.authorization_context,j.updated_at FROM jobs j JOIN wants w ON w.id=j.want_id WHERE w." + TitleIs + " AND j.state='succeeded'", ("$key", titleKey)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read())
                    list.Add(new(TargetKey(JsonSerializer.Deserialize<RequestAuthorization>(r.GetString(1))!), JsonSerializer.Deserialize<MutationInput>(r.GetString(0))!, DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(2))));
            }
            foreach (var want in Wants(c, null, TitleIs + " AND origin_kind=$kind", ("$key", titleKey), ("$kind", RequestOrigin.SeerrImportKind)))
            {
                if (LinkedScope(c, null, want) is { } linked) list.Add(new(want.TargetKey, linked, want.CreatedAt));
            }
            return (IReadOnlyList<RequestDispatch>)list;
        });
        /// <summary>Persistent policy/cache invalidation stamp, fenced by restore generation.</summary>
        public long Revision => !_db.Available ? 0 : _db.Read(c => long.Parse(Scalar(c, null, "SELECT COALESCE((SELECT value FROM meta WHERE key='request_revision'),'0')")!, CultureInfo.InvariantCulture)) + _db.Generation * 1000000000;
        private static void Changed(SqliteConnection c, SqliteTransaction t) => Exec(c, t, "INSERT INTO meta VALUES('request_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");
        /// <summary>
        /// The input chooses where the request goes: an arr instance, profile or root folder (Jellyfin Enhanced mode), or a
        /// Seerr server, profile, root folder and options stamp (Seerr mode). Administrators only.
        /// </summary>
        internal static bool HasRouting(MutationInput input) => input.HasArrRouting || input.HasSeerrOptions;
        /// <summary>The input names Seerr options (server, profile, root folder, stamp).</summary>
        internal static bool HasSeerrOptions(MutationInput input) => input.HasSeerrOptions;
        /// <summary>Any routing choice differs between the two inputs (arr or Seerr).</summary>
        internal static bool RoutingChanged(MutationInput input, MutationInput original) => RequestDestination.RoutingChanged(input, original);
        internal static string TargetKey(RequestAuthorization auth)
            => JsonSerializer.Serialize(new[] { auth.Backend, auth.InstanceId, auth.ConnectionGeneration, auth.SeerrSource });
        /// <summary>
        /// The target a Seerr-mode ask goes to while Jellyfin Enhanced points at the Seerr <paramref name="source"/>
        /// (<see cref="SeerrFacts.SourceOf"/>): Seerr picks its own server, so no instance or connection.
        /// </summary>
        internal static string SeerrTargetKey(string? source)
            => TargetKey(new RequestAuthorization(Guid.Empty, null, string.Empty, string.Empty, string.Empty, "seerr", string.Empty, string.Empty, string.Empty, source));
        /// <summary>The backend target an ask with these facts goes to (its backend, instance, connection and Seerr source).</summary>
        internal static string TargetKey(RequestPolicyFacts facts) => TargetKey(Authorize(facts, null, new MutationInput(), false));
        private static bool Active(RequestWant w) => w.Status is "pending" or "queued" or "sent" or "stale";
        private static bool Deleted(SqliteConnection c, SqliteTransaction? t, Guid user)
            => Scalar(c, t, "SELECT user_hash FROM request_deleted_users WHERE user_hash=$u", ("$u", MutationInput.Hash("deleted:" + Id(user)))) != null;
        private const string LiveJobs = "(state IN ('queued','retry','sending','maybe_sent','succeeded') OR (state!='cancelled' AND json_extract(outcome,'$.certainty')='Unknown'))";
        private const string KnownUnsent = "COALESCE(json_extract(outcome,'$.certainty'),'Rejected') NOT IN ('Unknown','Succeeded')";
        private static bool Anonymous(SqliteConnection c, SqliteTransaction t, Guid user)
            => Scalar(c, t, "SELECT user_hash FROM request_deleted_users WHERE lower(substr(user_hash,1,32))=$u", ("$u", Id(user))) != null;
        private static void Supersede(SqliteConnection c, SqliteTransaction t, string job, string reason)
        {
            // A followed new season's charge (scope "s<n>") is charged once and stays, as in Jellyfin Enhanced mode.
            if (Exec(c, t, "UPDATE jobs SET state='cancelled',reason=$r WHERE id=$j AND state IN ('queued','retry','parked') AND " + KnownUnsent, ("$j", job), ("$r", reason)) == 1)
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id=$j AND scope NOT LIKE 's%'", ("$j", job));
        }
        // upTo: only charges made up to that one, in charge order (see ChargedUpTo).
        private static List<QuotaCharge> Charges(SqliteConnection c, SqliteTransaction? t, Guid user, bool unsentOnly = false, ChargeOrder? upTo = null)
        {
            using var cmd = Cmd(c, t, "SELECT cost,charged_at,estimated_gb,want_id FROM reservations WHERE user_id=$u AND state='charged'" + (unsentOnly ? " AND want_id IN (SELECT id FROM wants WHERE status IN ('queued','pending')) AND (job_id IS NULL OR job_id NOT IN (SELECT id FROM jobs WHERE state='succeeded'))" : "") +
                (upTo == null ? "" : " AND " + ChargedBy), ("$u", Id(user)), ("$upto", upTo?.At), ("$seq", upTo?.Seq));
            using var r = cmd.ExecuteReader();
            var list = new List<QuotaCharge>();
            while (r.Read()) list.Add(new(r.GetInt32(0), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(1)), r.GetDouble(2), r.GetString(3)));
            return list;
        }
        internal string AuditActor(Guid user) => _db.Read(c => Scalar(c, null, "SELECT user_hash FROM request_deleted_users WHERE user_hash=$hash OR lower(substr(user_hash,1,32))=$u", ("$hash", MutationInput.Hash("deleted:" + Id(user))), ("$u", Id(user))) == null ? Id(user) : string.Empty);
        /// <summary>Rolling quota projection from committed charges.</summary>
        public QuotaProjection Quota(RequestPolicyFacts facts, DateTimeOffset now) => facts.Backend == "seerr"
            ? facts.BackendQuota ?? new QuotaProjection(0, null, null, null, 0, false)
            : _db.Read(c => QuotaProjector.Project(Charges(c, null, facts.UserId), facts.Limit, TimeSpan.FromDays(facts.WindowDays), now));
        private static int Cost(SqliteConnection c, SqliteTransaction t, MutationInput input, Guid user, DateTimeOffset now, int days, string? excludeWant = null)
        {
            if (input.Scope == "movie") return 1;
            if (input.Scope != "episodes") return input.Seasons.Length;
            var episodes = EpisodesCharged(c, t, user, now, days, excludeWant);
            static int EpisodeCost(int count) => Math.Max(0, (count - 5 + 4) / 5);
            return EpisodeCost(episodes + input.Episodes.Length) - EpisodeCost(episodes);
        }
        private static int EpisodesCharged(SqliteConnection c, SqliteTransaction? t, Guid user, DateTimeOffset now, int days, string? excludeWant = null)
            => int.Parse(Scalar(c, t, "SELECT COALESCE(SUM(episode_count),0) FROM reservations WHERE user_id=$u AND state='charged' AND charged_at>$since AND charged_at<=$at AND ($exclude IS NULL OR want_id<>$exclude)",
                ("$u", Id(user)), ("$since", Ms(now.AddDays(-days))), ("$at", Ms(now)), ("$exclude", excludeWant))!, CultureInfo.InvariantCulture);
        /// <summary>
        /// Single episodes charged to the user in the rolling window: an episode ask costs what it adds to
        /// them (the first five of a window are free), so request previews need the count.
        /// </summary>
        public int EpisodesCharged(Guid user, int days, DateTimeOffset now) => _db.Read(c => EpisodesCharged(c, null, user, now, days));
        private static bool OverSeries(RequestPolicyFacts facts, MutationInput input, IEnumerable<RequestWant> own, int threshold)
            => facts.Role == "Member" && !TitleKey.Parse(input.Key)!.IsMovie && own.Where(w => RequestDestination.SameTitle(w.Input, input) && w.Status is not ("declined" or "cancelled"))
                .SelectMany(w => w.Input.SeasonNumbers).Concat(input.SeasonNumbers).Distinct().Count() > Math.Clamp(threshold, 1, 200);
        private static bool OverQuota(RequestPolicyFacts facts, IReadOnlyList<QuotaCharge> charges, int cost, double gb, DateTimeOffset now)
        {
            var projection = QuotaProjector.Project(charges, facts.Limit, TimeSpan.FromDays(facts.WindowDays), now);
            if (facts.Backend == "seerr")
                return facts.BackendQuota is { Available: true, Limit: not null } native && native.Used + projection.Used + cost > native.Limit;
            return facts.Limit.HasValue && projection.Used + cost > facts.Limit;
        }
        private static bool OverGbCap(RequestPolicyFacts facts, IReadOnlyList<QuotaCharge> charges, double gb, DateTimeOffset now)
            => facts.GbLimit > 0 && QuotaProjector.Project(charges, null, TimeSpan.FromDays(facts.WindowDays), now).UsedGb + gb > facts.GbLimit;
        /// <summary>Re-checks the hard estimated GB cap, including already approved reservations.</summary>
        public bool ExceedsGbCapAtSend(RequestPolicyFacts requester, DateTimeOffset now)
            => _db.Read(c => OverGbCap(requester, Charges(c, null, requester.UserId), 0, now));
        // The fixed estimate reservations were written with before sizes came from the instance (matching old rows only).
        private static double EstimateGb(MutationInput input) => input.Variant == "4k" ? input.Scope == "movie" ? 40 : input.Scope == "episodes" ? input.Episodes.Length * 4 : input.Seasons.Length * 40
            : input.Scope == "movie" ? 8 : input.Scope == "episodes" ? input.Episodes.Length : input.Seasons.Length * 10;
        // An estimate, never a claim about actual disk usage: from the target instance's typical sizes when known.
        private static double EstimateGb(MutationInput input, RequestPolicyFacts facts) => RequestSizeHint.Estimate(input, facts.Size);
        /// <summary>Re-evaluates approval requirements for an automatic job under the current household rules.</summary>
        public bool NeedsApprovalAtSend(RequestJob job, RequestPolicyFacts requester, IRequestPolicy policy, DateTimeOffset now)
            => ApprovalNeededAtSend(job, requester, policy, now) != null;
        /// <summary>
        /// Why a job nobody approved needs an OK now (null: it doesn't), re-evaluated at send under the current household
        /// settings: a Kid (<c>authorization_changed</c>); the household's rules now refusing it (<c>household_rule</c>) or
        /// wanting a look (<c>rule_review</c>); the group pool its charge is bound to now over its limit
        /// (<c>group_quota</c>); a Member's preset, quota or series threshold (<c>authorization_changed</c>).
        /// </summary>
        /// <param name="job">The job.</param>
        /// <param name="requester">The requester's current facts.</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Now.</param>
        public string? ApprovalNeededAtSend(RequestJob job, RequestPolicyFacts requester, IRequestPolicy policy, DateTimeOffset now)
        {
            if (job.Authorization.Approver.HasValue) return null;
            if (requester.Role == "Kid") return "authorization_changed";
            if (requester.Backend == "je")
            {
                if (requester.Rules?.Verdict == HouseholdRules.Deny) return HouseholdRule;
                if (requester.Rules?.Verdict == HouseholdRules.Review) return RuleReview;
                if (HouseholdFlags.Pools(policy.Configuration) && _db.Read(c =>
                {
                    var bound = Scalar(c, null, "SELECT COALESCE((SELECT pool_id FROM reservations WHERE job_id=$j LIMIT 1),(SELECT pool_id FROM reservations WHERE want_id=$w AND scope='initial' LIMIT 1))", ("$j", job.Id), ("$w", job.WantId));
                    var pool = GroupQuotaPolicy.ById(GroupQuotaPolicy.Parse(policy.Configuration.ArrGroupQuotaPools), bound, policy.Configuration.ArrRequestQuotaWindowDays);
                    // Like the personal allowance below: only pool charges made up to this job's own, so a later excess an
                    // approver let into the pool never holds a request that was within it (the current limit and window apply).
                    return pool != null && PoolUsed(c, null, pool.Id, pool.WindowDays, now, ChargedUpTo(c, job, job.WantId)) > pool.Limit;
                })) return GroupQuota;
            }
            if (requester.Role != "Member" || requester.Backend != "je") return null;
            if (policy.Configuration.ArrRequestPreset == "approve_everything" && requester.Rules?.Verdict != HouseholdRules.Approve) return "authorization_changed";
            return _db.Read(c =>
            {
                var want = Wants(c, null, "id=$id", ("$id", job.WantId)).SingleOrDefault();
                if (want == null) return true;
                var own = Wants(c, null, "user_id=$u", ("$u", Id(requester.UserId))).Where(w => w.Id != want.Id && w.CreatedAt <= want.CreatedAt && w.Status != "pending").ToArray();
                // Only charges made up to this job's own: a later ask an approver let past the limit (soft excess) never
                // holds a request that was within the allowance when it was made.
                return OverQuota(requester, Charges(c, null, requester.UserId, upTo: ChargedUpTo(c, job, want.Id)), 0, 0, now) ||
                    OverSeries(requester, want.Input, own, policy.Configuration.ArrRequestSeriesThreshold);
            }) ? "authorization_changed" : null;
        }

        /// <summary>
        /// Records the household-rule verdict a waiting request was held with at send (phase 4b) as its rationale, so it
        /// says why it waits (a rating that changed, or that isn't known now), after a restart too.
        /// </summary>
        /// <param name="wantId">The request.</param>
        /// <param name="verdict">The verdict it was held with.</param>
        public void HeldByRules(string wantId, HouseholdRuleVerdict verdict)
            => _db.Write((c, t) => Exec(c, t, "UPDATE wants SET rule_detail=$rules WHERE id=$id AND status='pending'", ("$rules", verdict.Json), ("$id", wantId)));

        /// <summary>
        /// A charge's place in the order charges were made (review round 4, 4b-B12): when it was charged, then the sequence
        /// it was given when it became charged (two charges in the same millisecond keep the order they were made in).
        /// </summary>
        /// <param name="At">When it was charged (Unix milliseconds).</param>
        /// <param name="Seq">Its charge sequence.</param>
        internal readonly record struct ChargeOrder(long At, long Seq);
        // The next charge sequence, for a reservation becoming charged (one writer at a time).
        private const string NextCharge = "(SELECT COALESCE(MAX(charge_seq),0)+1 FROM reservations)";
        // A charge made up to the one at ($upto, $seq) in charge order.
        private const string ChargedBy = "(charged_at<$upto OR (charged_at=$upto AND COALESCE(charge_seq,0)<=$seq))";
        // The job's own charge (the latest of it and its request's initial one; null when it has none, so every charge up to
        // now counts): the send-time allowance and pool checks count only charges made up to it, in charge order.
        private static ChargeOrder? ChargedUpTo(SqliteConnection c, RequestJob job, string wantId)
        {
            using var cmd = Cmd(c, null, "SELECT charged_at,COALESCE(charge_seq,0) FROM reservations WHERE (job_id=$j OR (want_id=$w AND scope='initial')) AND state='charged' ORDER BY charged_at DESC,COALESCE(charge_seq,0) DESC LIMIT 1", ("$j", job.Id), ("$w", wantId));
            using var r = cmd.ExecuteReader();
            return r.Read() ? new ChargeOrder(r.GetInt64(0), r.GetInt64(1)) : null;
        }

        /// <summary>Creates intent, quota reservation and (when approved) a job in one commit.</summary>
        /// <param name="user">The requester.</param>
        /// <param name="request">Client id and confirmed input.</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Commit time.</param>
        /// <param name="origin">Where the intent came from; automation never self-approves a Member in JE mode.</param>
        /// <param name="target">
        /// A season page's ask (D53, edition round 21: the check's command is what is recorded): the instance the check proved it
        /// lands on; the ask is refused (<see cref="PressChecks.Changed"/>) unless the policy sends it there now. Null: no press.
        /// </param>
        public RequestOutcome Create(Guid user, CreateRequest request, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin = null, string? target = null)
        {
            var normalized = request.Input?.Normalize();
            if (normalized == null || string.IsNullOrWhiteSpace(request.ClientRequestId) || request.ClientRequestId.Length > 128 || request.ClientRequestId.Any(char.IsControl)) return RequestOutcome.Refused("invalid_input", 400);
            return _db.Write((c, t) =>
            {
                // Matching asks may approve existing wants; a later refusal must undo those approvals too.
                Exec(c, t, "SAVEPOINT request_create");
                var outcome = CreateCore(c, t, user, request, normalized, policy, now, origin, target);
                if (outcome.HttpStatus >= 400) Exec(c, t, "ROLLBACK TO request_create");
                Exec(c, t, "RELEASE request_create");
                return outcome;
            });
        }
        /// <summary>
        /// The no-write preview of <see cref="Create"/>: the same checks, merges and charges worked out inside a
        /// transaction that is always rolled back, so it answers exactly what an ask would do now (its outcome, the
        /// request's status, cost and estimate, whether it would go out) and leaves no want, approval, reservation, job,
        /// audit row, event or notice behind. Shadow decisions, household-rule and list previews use it.
        /// </summary>
        /// <param name="user">The requester.</param>
        /// <param name="request">Client id and confirmed input.</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Now.</param>
        /// <param name="origin">Where the ask would come from.</param>
        public RequestPreview Preview(Guid user, CreateRequest request, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin = null)
        {
            var normalized = request.Input?.Normalize();
            if (normalized == null || string.IsNullOrWhiteSpace(request.ClientRequestId) || request.ClientRequestId.Length > 128 || request.ClientRequestId.Any(char.IsControl))
                return new RequestPreview(RequestOutcome.Refused("invalid_input", 400));
            if (!_db.Available) return new RequestPreview(RequestOutcome.Refused("database_unavailable", 503, "unavailable"));
            return _db.Write((c, t) =>
            {
                Exec(c, t, "SAVEPOINT request_preview");
                try
                {
                    var before = Scalar(c, t, "SELECT COUNT(*) FROM wants");
                    var outcome = CreateCore(c, t, user, request, normalized, policy, now, origin);
                    var created = Scalar(c, t, "SELECT COUNT(*) FROM wants") != before;
                    var want = outcome.RequestId == null ? null : Wants(c, t, "id=$id", ("$id", outcome.RequestId)).SingleOrDefault();
                    if (want == null) return new RequestPreview(outcome, New: created);
                    var jobs = Jobs(c, t, "want_id=$id", ("$id", want.Id));
                    var gb = double.Parse(Scalar(c, t, "SELECT COALESCE(SUM(estimated_gb),0) FROM reservations WHERE want_id=$id", ("$id", want.Id)) ?? "0", CultureInfo.InvariantCulture);
                    return new RequestPreview(outcome, want.Status, want.Reason, want.Cost, gb, want.Follower, jobs.Count > 0, created, want.OwnedInput, jobs.Select(j => j.Authorization.InstanceId).FirstOrDefault());
                }
                finally
                {
                    Exec(c, t, "ROLLBACK TO request_preview");
                    Exec(c, t, "RELEASE request_preview");
                }
            });
        }
        /// <summary>Most asks one batch preview (and one "request all missing" batch) holds.</summary>
        public const int MaxBatch = 20;
        /// <summary>
        /// The no-write preview of a batch of asks made one after another (phase 4b, "request all missing"): each is
        /// worked out after the ones before it, inside one transaction that is always rolled back, so charges, the
        /// person's allowance and group pools add up across the batch exactly as the real asks would. Null entries are
        /// invalid asks. At most <see cref="MaxBatch"/>.
        /// </summary>
        /// <param name="user">The requester.</param>
        /// <param name="requests">The asks, in order (normalized inputs).</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Now.</param>
        /// <param name="origin">Where the asks would come from.</param>
        public IReadOnlyList<RequestPreview> PreviewBatch(Guid user, IReadOnlyList<CreateRequest?> requests, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin = null)
        {
            if (requests.Count > MaxBatch) throw new ArgumentOutOfRangeException(nameof(requests));
            if (!_db.Available) return requests.Select(_ => new RequestPreview(RequestOutcome.Refused("database_unavailable", 503, "unavailable"))).ToArray();
            return _db.Write((c, t) =>
            {
                Exec(c, t, "SAVEPOINT request_preview_batch");
                try
                {
                    var list = new List<RequestPreview>();
                    foreach (var request in requests)
                    {
                        var normalized = request?.Input?.Normalize();
                        if (request == null || normalized == null || string.IsNullOrWhiteSpace(request.ClientRequestId) || request.ClientRequestId.Length > 128 || request.ClientRequestId.Any(char.IsControl))
                        {
                            list.Add(new RequestPreview(RequestOutcome.Refused("invalid_input", 400)));
                            continue;
                        }
                        // Each ask on its own savepoint, like Create: a refusal leaves nothing of it for the next one.
                        Exec(c, t, "SAVEPOINT request_preview_item");
                        var before = Scalar(c, t, "SELECT COUNT(*) FROM wants");
                        var outcome = CreateCore(c, t, user, request, normalized, policy, now, origin);
                        if (outcome.HttpStatus >= 400) Exec(c, t, "ROLLBACK TO request_preview_item");
                        Exec(c, t, "RELEASE request_preview_item");
                        var created = Scalar(c, t, "SELECT COUNT(*) FROM wants") != before;
                        var want = outcome.RequestId == null ? null : Wants(c, t, "id=$id", ("$id", outcome.RequestId)).SingleOrDefault();
                        if (want == null)
                        {
                            list.Add(new RequestPreview(outcome, New: created));
                            continue;
                        }
                        var jobs = Jobs(c, t, "want_id=$id", ("$id", want.Id));
                        var gb = double.Parse(Scalar(c, t, "SELECT COALESCE(SUM(estimated_gb),0) FROM reservations WHERE want_id=$id", ("$id", want.Id)) ?? "0", CultureInfo.InvariantCulture);
                        list.Add(new RequestPreview(outcome, want.Status, want.Reason, want.Cost, gb, want.Follower, jobs.Count > 0, created, want.OwnedInput, jobs.Select(j => j.Authorization.InstanceId).FirstOrDefault()));
                    }
                    return (IReadOnlyList<RequestPreview>)list;
                }
                finally
                {
                    Exec(c, t, "ROLLBACK TO request_preview_batch");
                    Exec(c, t, "RELEASE request_preview_batch");
                }
            });
        }

        /// <summary>
        /// A retry of an ask this person already made (the same client request id): the outcome recorded for it when the input
        /// is the same (a split ask answers as the split did), a conflict when the id was used for another input; null when the
        /// id is new.
        /// </summary>
        private RequestOutcome? Recorded(SqliteConnection c, SqliteTransaction? t, Guid user, string clientRequestId, MutationInput normalized, PressIntent? expect)
        {
            var priorHash = Scalar(c, t, "SELECT fingerprint FROM request_inputs WHERE user_id=$u AND client_request_id=$k", ("$u", Id(user)), ("$k", clientRequestId));
            if (priorHash == null) return null;
            // A retry of the same ask names the title by any of its ids.
            if (priorHash != Idempotency(expect, normalized) && (expect != null || !Fingerprints(c, t, normalized).Contains(priorHash))) return RequestOutcome.Refused(PressChecks.Conflict, 409);
            var existingId = Scalar(c, t, "SELECT want_id FROM request_inputs WHERE user_id=$u AND client_request_id=$k", ("$u", Id(user)), ("$k", clientRequestId))!;
            var existing = Wants(c, t, "id=$id", ("$id", existingId)).Single();
            // A retry of an ask that was split answers as the split did.
            if (Wants(c, t, "user_id=$u AND client_request_id=$k", ("$u", Id(user)), ("$k", clientRequestId + SplitHeldSuffix)).SingleOrDefault() is { } heldPart)
                return Split(RequestOutcome.Accepted(existing.Id, existing.Reason, 200), heldPart.Id, heldPart.Input.SeasonNumbers.OrderBy(n => n).ToArray());
            return RequestOutcome.Accepted(existing.Id, existing.Reason, 200);
        }

        /// <summary>
        /// The recorded outcome of a retry of an ask this person already made with the same client request id and input (its
        /// first answer was lost), read before anything about the ask is worked out again (D53, edition round 20: replay
        /// before revalidation: a retry of an accepted press gets its receipt even after the episode arrived). Null when there
        /// is none to replay (a new id, another input under the id: <see cref="Create"/> decides, or a person who is gone).
        /// </summary>
        /// <param name="user">The requester.</param>
        /// <param name="request">Client id and input (as the request service normalized it).</param>
        /// <returns>The recorded outcome, or null.</returns>
        public RequestOutcome? Replay(Guid user, CreateRequest request)
        {
            var normalized = request.Input?.Normalize();
            if (normalized == null || string.IsNullOrWhiteSpace(request.ClientRequestId) || request.ClientRequestId.Length > 128 || request.ClientRequestId.Any(char.IsControl)) return null;
            return _db.Read(c => Deleted(c, null, user) ? null : Recorded(c, null, user, request.ClientRequestId, normalized, request.Expect) is { } recorded && (recorded.HttpStatus < 400 || recorded.Reason == PressChecks.Conflict) ? recorded : null);
        }

        /// <summary>
        /// What a client request id is remembered by (D53, edition round 21: a key replays only the identical press): an ask's
        /// input, and for a season page's press the whole press too (its page, copy, edition and destination as well as its
        /// scope), so the same id with another press is a conflict, never the first ask's receipt.
        /// </summary>
        private static string Idempotency(PressIntent? expect, MutationInput normalized)
            => expect == null ? normalized.Fingerprint : MutationInput.Hash("press|" + (PressChecks.RequestFingerprint(expect, PressChecks.Ask, null, normalized) ?? normalized.Fingerprint));

        private RequestOutcome CreateCore(SqliteConnection c, SqliteTransaction t, Guid user, CreateRequest request, MutationInput normalized, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin, string? target = null)
        {
            // Automatic origins (recipes, list sync) never self-approve a Member and never approve someone else's ask.
            var automation = origin?.Automatic == true;
            // Ask mode, or automation the person isn't eligible for: the want waits for an OK whoever they are.
            var mustAsk = origin?.RequireApproval == true;
            if (Deleted(c, t, user)) return RequestOutcome.Refused("user_required");
            if (Recorded(c, t, user, request.ClientRequestId, normalized, request.Expect) is { } recorded) return recorded;
            if (!policy.IsAdmin(user) && HasRouting(normalized)) return RequestOutcome.Refused("admin_required");
            // The title as the ledger holds it (any of its ids resolved).
            normalized = Canonical(c, t, normalized);
            var facts = policy.Evaluate(user, normalized);
            // A press records only where its check proved it lands (the request target now, in the same transaction).
            bool landsOnTarget = RequestDestination.SameInstance(facts.InstanceId, target);
            if (target != null && facts.Backend == "je" && !landsOnTarget)
                return RequestOutcome.Refused(PressChecks.Changed, 409, "conflict") with { Message = PressChecks.Message(PressChecks.Changed) };
            if (RequestPolicy.Check(facts, null, normalized, false) is { } refusal) return RequestOutcome.Refused(refusal, RequestPolicy.RefusalStatus(refusal), outcome: refusal is "not_visible_to_user" or "low_disk" ? "blocked" : refusal == "backend_unavailable" ? "unavailable" : "denied");
            if (SeerrEpisodes(facts, normalized) is { } seerrOnly) return seerrOnly;
            if (SingleSeason(policy.Configuration, facts, normalized) is { } oneSeason) return oneSeason;
            if (facts.Role != "Admin" && HasRouting(normalized)) return RequestOutcome.Refused("admin_required");
            if (CheckTitleChoice(c, t, user, normalized, facts, request.OverrideChoiceVersion, allowChanges: !automation && !normalized.HasSeerrOptions && facts.CanApprove && facts.Role == "Admin") is { } choiceConflict) return choiceConflict;
            normalized = Canonical(c, t, normalized);
            var admittedInput = facts.Backend == "je" && TitleChoiceRegistry.Current(c, t, normalized, Authorize(facts, null, normalized, false)) is { } admittedChoice
                ? normalized with { ProfileId = normalized.ProfileId ?? admittedChoice.ProfileId, RootFolder = normalized.RootFolder ?? admittedChoice.RootFolder }
                : normalized;
            // An approver's matching ask authorises the shared pending scope, without moving its charge.
            // Automation never approves someone else's pending ask on a person's behalf.
            // An ask that chooses a Seerr destination doesn't approve someone else's pending ask without it (that would
            // send the shared scope to Seerr's defaults and leave the chosen destination unused).
            if (!automation && !normalized.HasSeerrOptions && facts.CanApprove && facts.Role is "Manager" or "Admin")
            {
                foreach (var pending in Wants(c, t, TitleIs + " AND variant=$v", ("$key", normalized.Key), ("$v", normalized.Variant))
                    .Where(w => !w.Follower && Active(w) && RequestDestination.SameTarget(w.TargetKey, TargetKey(facts)) &&
                        (w.Status == "pending" ? w.Input.Extra(new[] { normalized }) == null : normalized.HasArrRouting && facts.Backend == "je")))
                {
                    // Manage Add may authorize a viewer's pending ask instead of creating its own job. Its
                    // explicit profile/root must therefore become that approval's input, while the viewer
                    // keeps their own scope and charge. ApproveCore persists the edits in the want and job.
                    var edits = normalized.HasArrRouting ? pending.Input.WithArrChoices(admittedInput) : null;
                    // Coverage ignores add settings. Reconcile them with the actual owner before acknowledging
                    // a follower/duplicate. ApproveCore alone owns authorization, replacement and persistence.
                    if (pending.Status != "pending" && RequestDestination.SameInput(edits, pending.Input) &&
                        Jobs(c, t, "want_id=$w AND state IN ('queued','retry')", ("$w", pending.Id)).All(j => TitleChoiceRegistry.Check(c, t, j) == null)) continue;
                    var approved = ApproveCore(c, t, pending.Id, user, edits, policy, now, reconcileArrChoices: pending.Status != "pending");
                    if (approved.HttpStatus >= 400 && edits != null)
                        return approved with { Message = approved.Reason is "request_in_flight" or "request_changed"
                            ? "These add choices could not be applied: the shared request is already sending or sent. Check the title in Manage before changing its profile or folder."
                            : approved.Message };
                    if (approved.HttpStatus != 200) continue;
                }
            }
            var own = Wants(c, t, "user_id=$u", ("$u", Id(user)));
            // The person's own asks that may stand for it: at its target, and (an ask choosing a Seerr destination) going there.
            var ownSame = own.Where(w => Active(w) && RequestDestination.Serves(normalized, TargetKey(facts), w.Input, w.TargetKey)).ToArray();
            // One of them covers it, or several together do (an ask split at the series threshold); the answer is one of those,
            // never an ask elsewhere. Else it is a request of its own, whose destination is checked when it is sent. The same
            // holds for someone else's scope below.
            var sameOwn = ownSame.FirstOrDefault(w => normalized.Extra(new[] { w.Input }) == null)
                ?? (ownSame.Length > 1 && normalized.Extra(ownSame.Select(w => w.Input)) == null ? ownSame.First(w => w.Input.Overlaps(normalized)) : null);
            if (sameOwn != null)
            {
                RememberInput(c, t, user, request.ClientRequestId, Idempotency(request.Expect, normalized), sameOwn.Id);
                return RequestOutcome.Accepted(sameOwn.Id, sameOwn.Reason, 200) with { Message = "Your request is already recorded." };
            }
            // An explicit household-rule deny (phase 4b) refuses every new request of the person for it, following someone
            // else's included: the rules say this person doesn't get it. (A replay of their own earlier ask answers above.)
            if (facts.Rules is { Verdict: HouseholdRules.Deny } denied)
                return RequestOutcome.Refused(HouseholdRule, 403, "denied") with { Message = "The household's rules don't allow this request (" + denied.Text() + ").", Rules = denied };
            if (own.Count(w => w.Status == "pending") >= Math.Clamp(policy.Configuration.ArrRequestPendingLimit, 1, 100)) return RequestOutcome.Refused("pending_limit", 429, "quota_exceeded");
            if (own.Any(w => w.Status == "declined" && RequestDestination.SameEdition(w.Input, normalized) &&
                normalized.Extra(new[] { w.Input }) == null && w.UpdatedAt > now.AddDays(-Math.Clamp(policy.Configuration.ArrRequestDeclineCooldownDays, 0, 365)))) return RequestOutcome.Refused("decline_cooldown", outcome: "blocked");
            var covered = Wants(c, t, TitleIs + " AND variant=$v", ("$key", normalized.Key), ("$v", normalized.Variant)).Where(Active).ToArray();
            var authorizedExtra = normalized.Extra(Coverage(c, t, covered, TargetKey(facts)));
            // Household rules (phase 4b, null while they don't apply): a review waits for an OK whoever asks; an approve
            // lifts only a Member's blanket-approval preset (never quota, the series threshold or a group pool).
            var rules = facts.Rules;
            var ruleReview = rules?.Verdict == HouseholdRules.Review;
            var blanket = policy.Configuration.ArrRequestPreset == "approve_everything" && rules?.Verdict != HouseholdRules.Approve;
            var authorizedCost = authorizedExtra == null ? 0 : Cost(c, t, authorizedExtra, user, now, facts.WindowDays);
            // A group pool this ask would take over its limit (phase 4b; soft: an approval may grant it).
            var poolHeld = PoolOver(c, t, facts.Pool, origin?.Free == true ? 0 : authorizedCost, now);
            var auto = !mustAsk && !ruleReview && !poolHeld && (facts.Role is "Manager" or "Admin" or "Trusted") || (!mustAsk && !ruleReview && !poolHeld && facts.Role == "Member" && facts.Backend == "je" && !automation &&
                !blanket &&
                !OverQuota(facts, Charges(c, t, user), authorizedCost, authorizedExtra == null ? 0 : EstimateGb(authorizedExtra, facts), now) &&
                !OverSeries(facts, normalized, own, policy.Configuration.ArrRequestSeriesThreshold));
            if (!auto && !automation && SplitAtThreshold(c, t, user, request, normalized, facts, own, policy, now, origin) is { } split) return split;
            var extra = normalized.Extra(Coverage(c, t, covered, TargetKey(facts), !auto));
            if (auto && (extra != null || covered.Any(w => w.Status == "pending")) && Scalar(c, t,
                "SELECT j.id FROM jobs j JOIN wants w ON w.id=j.want_id WHERE w." + TitleIs + " AND w.variant=$v AND json_extract(j.authorization_context,'$.Backend')=$backend AND json_extract(j.authorization_context,'$.InstanceId')=$instance AND json_extract(j.authorization_context,'$.ConnectionGeneration')=$generation AND json_extract(j.authorization_context,'$.SeerrSource') IS $source AND (j.state IN ('sending','maybe_sent') OR json_extract(j.outcome,'$.certainty')='Unknown') LIMIT 1",
                ("$key", normalized.Key), ("$v", normalized.Variant), ("$backend", facts.Backend), ("$instance", facts.InstanceId), ("$generation", facts.ConnectionGeneration), ("$source", facts.SeerrSource)) != null) return RequestOutcome.Refused("request_in_flight", 409);
            // Free automation costs nobody's allowance; the estimated GB still counts against a hard GB cap.
            var cost = extra == null || origin?.Free == true ? 0 : Cost(c, t, extra, user, now, facts.WindowDays);
            var gb = extra == null ? 0 : EstimateGb(extra, facts);
            if (OverGbCap(facts, Charges(c, t, user), gb, now)) return RequestOutcome.Refused("quota_exceeded", 429, "quota_exceeded");
            var over = OverQuota(facts, Charges(c, t, user, facts.Backend == "seerr"), cost, gb, now);
            var poolOver = PoolOver(c, t, facts.Pool, cost, now);
            var needsApproval = extra != null && (mustAsk || ruleReview || poolOver || facts.Role == "Kid" || (facts.Backend == "je" && facts.Role == "Member" && (automation || blanket || over || OverSeries(facts, normalized, own, policy.Configuration.ArrRequestSeriesThreshold))));
            if (over && facts.Backend == "seerr") return RequestOutcome.Refused("over_quota", 429, "quota_exceeded");
            var confirmedScope = extra == null && ConfirmedScope(c, t, normalized, covered, facts);
            var waitingScope = extra == null && normalized.Extra(Coverage(c, t, covered, TargetKey(facts))) != null;
            var status = confirmedScope ? "sent" : needsApproval || waitingScope ? "pending" : "queued";
            var reason = confirmedScope ? "looking" : status == "pending" ? ruleReview && extra != null ? RuleReview : over ? "over_quota" : poolOver ? GroupQuota : "awaiting_approval" : "queued_outage";
            var acquisition = Scalar(c, t, "SELECT id FROM acquisitions WHERE " + TitleIs + " AND variant=$v AND state='active'", ("$key", normalized.Key), ("$v", normalized.Variant));
            if (acquisition == null)
            {
                acquisition = NewId();
                Exec(c, t, "INSERT INTO acquisitions VALUES($id,$key,$v,'active',$at)", ("$id", acquisition), ("$key", normalized.Key), ("$v", normalized.Variant), ("$at", Ms(now)));
            }
            var id = NewId();
            var stored = normalized;
            Exec(c, t, "INSERT INTO wants(id,acquisition_id,user_id,client_request_id,fingerprint,title_key,variant,mutation_input,owned_input,status,reason,cost,parental_signature,is_follower,created_at,updated_at) VALUES($id,$a,$u,$client,$f,$key,$v,$input,$owned,$status,$r,$cost,$p,$follower,$at,$at)",
                ("$id", id), ("$a", acquisition), ("$u", Id(user)), ("$client", request.ClientRequestId), ("$f", normalized.Fingerprint), ("$key", stored.Key), ("$v", stored.Variant), ("$input", stored.Canonical), ("$owned", extra?.Canonical), ("$status", status), ("$r", reason), ("$cost", cost), ("$p", facts.ParentalSignature), ("$follower", extra == null), ("$at", Ms(now)));
            AcceptActiveAliases(c, t, stored.Key);
            Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", TargetKey(facts)), ("$id", id));
            if (origin != null)
                Exec(c, t, "UPDATE wants SET origin_kind=$kind,origin_source_id=$source,origin_detail=$detail,operation_id=$operation WHERE id=$id",
                    ("$kind", origin.Kind), ("$source", origin.Source), ("$detail", origin.Detail), ("$operation", origin.Provenance?.OperationId), ("$id", id));
            // The verdict it was created with, as its rationale (phase 4b).
            if (rules is { Verdict: not HouseholdRules.None } && extra != null)
                Exec(c, t, "UPDATE wants SET rule_detail=$rules WHERE id=$id", ("$rules", rules.Json), ("$id", id));
            RememberInput(c, t, user, request.ClientRequestId, Idempotency(request.Expect, normalized), id);
            Fault?.Invoke("want");
            Reserve(c, t, id, user, cost, gb, status == "pending" ? "held" : "charged", now, "initial", facts.Pool?.Id);
            Fault?.Invoke("reservation");
            if (extra != null && status == "queued") AddJob(c, t, id, extra!, Authorize(facts, null, extra!, false), now, defaults: ChoiceDefaults(policy, facts.InstanceId));
            Fault?.Invoke("job");
            if (status == "queued" && extra != null && auto) ReleasePendingFollowers(c, t, acquisition, user, policy, now, false);
            Record(c, t, id, null, user, "create", "accepted", reason, stored.Key, now);
            Fault?.Invoke("notice");
            if (confirmedScope)
                return RequestOutcome.Accepted(id, reason, 200) with { Outcome = "merged", Message = "Someone in your household already asked, we'll tell you both." };
            return RequestOutcome.Accepted(id, reason) with { Rules = rules is { Verdict: not HouseholdRules.None } && extra != null ? rules : null };
        }
        /// <summary>The reason of a request waiting for an OK because the household's rules want a look (phase 4b).</summary>
        internal const string RuleReview = "rule_review";
        /// <summary>The reason of a request waiting for an OK because its group pool is used up (phase 4b).</summary>
        internal const string GroupQuota = "group_quota";
        /// <summary>The reason of a request the household's rules refuse (phase 4b).</summary>
        internal const string HouseholdRule = "household_rule";
        /// <summary>
        /// Seerr takes whole seasons only: single episodes are refused in Seerr mode before anything is recorded (the
        /// request controls ask for the episode's season instead, said before the person confirms), so a job that could
        /// only ever be held at send is never created. Null when the ask isn't single episodes in Seerr mode.
        /// </summary>
        private static RequestOutcome? SeerrEpisodes(RequestPolicyFacts facts, MutationInput input)
            => facts.Backend == "seerr" && input.Scope == "episodes"
                ? RequestOutcome.Refused("seerr_whole_season_only", 409, "blocked") with { Message = "Seerr takes whole seasons only; ask for the season." }
                : null;
        /// <summary>
        /// "Only allow requesting one season at a time": an ask for more than one season (or for episodes of more than one
        /// season) is refused before anything is recorded; the request controls offer one season at a time. Approving a
        /// request recorded before the option was turned on is left to the approver. Null when the ask is fine.
        /// </summary>
        private static RequestOutcome? SingleSeason(Configuration.PluginConfiguration config, RequestPolicyFacts facts, MutationInput input)
            => input.Scope is "seasons" or "episodes" && input.SeasonNumbers.Distinct().Count() > 1 && RequestPolicy.SingleSeasonOnly(config, facts)
                ? RequestOutcome.Refused("single_season_only", 409, "blocked") with { Message = "Only one season can be asked for at a time." }
                : null;
        /// <summary>
        /// A Member's ask (JE mode, no blanket approval preset) that crosses the household's series threshold: the seasons
        /// that still fit under it go ahead as one request and only the excess waits for an OK as a second one (S1–S3
        /// asked before, an S4–S6 ask at threshold 4: S4 is queued, S5–S6 wait). Seasons the person already asked for stay
        /// free and go with the first part. Each part is an ordinary request with its own reservation and approval; the
        /// client's id answers with the first. Null (nothing written) when there is nothing to split, or when the first
        /// part would not go ahead on its own either (over quota, or something else holds it): the whole ask is then held
        /// as before.
        /// </summary>
        private RequestOutcome? SplitAtThreshold(SqliteConnection c, SqliteTransaction t, Guid user, CreateRequest request, MutationInput normalized,
            RequestPolicyFacts facts, IReadOnlyList<RequestWant> own, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin)
        {
            var threshold = policy.Configuration.ArrRequestSeriesThreshold;
            if (facts.Role != "Member" || facts.Backend != "je" || (policy.Configuration.ArrRequestPreset == "approve_everything" && facts.Rules?.Verdict != HouseholdRules.Approve) ||
                normalized.Scope is not ("seasons" or "episodes") || !OverSeries(facts, normalized, own, threshold)) return null;
            var asked = own.Where(w => RequestDestination.SameTitle(w.Input, normalized) && w.Status is not ("declined" or "cancelled")).SelectMany(w => w.Input.SeasonNumbers).ToHashSet();
            var fresh = normalized.SeasonNumbers.Where(s => !asked.Contains(s)).Distinct().OrderBy(s => s).ToArray();
            var room = Math.Clamp(threshold, 1, 200) - asked.Count;
            if (room <= 0 || room >= fresh.Length) return null;
            var first = normalized.SeasonNumbers.Where(s => asked.Contains(s)).Concat(fresh.Take(room)).ToHashSet();
            var held = fresh.Skip(room).ToArray();
            MutationInput Part(Func<int, bool> keep) => normalized.Scope == "episodes"
                ? normalized with { Episodes = normalized.Episodes.Where(e => keep(e.Season)).ToArray() }
                : normalized with { Seasons = normalized.Seasons.Where(keep).ToArray() };
            Exec(c, t, "SAVEPOINT request_split");
            var queued = CreateCore(c, t, user, request with { ClientRequestId = request.ClientRequestId + "|go" }, Part(first.Contains), policy, now, origin);
            // The excess is the later part of the ask: it is ordered after the first, so the first's send-time series
            // check never counts the excess (approved or not) against it.
            string? Status(RequestOutcome o) => o.HttpStatus >= 400 || o.RequestId == null ? null : Wants(c, t, "id=$id", ("$id", o.RequestId)).SingleOrDefault()?.Status;
            var waiting = Status(queued) is "queued" or "sent"
                ? CreateCore(c, t, user, request with { ClientRequestId = request.ClientRequestId + SplitHeldSuffix }, Part(held.Contains), policy, now.AddMilliseconds(1), origin)
                : null;
            if (waiting == null || Status(waiting) != "pending")
            {
                Exec(c, t, "ROLLBACK TO request_split");
                Exec(c, t, "RELEASE request_split");
                return null;
            }
            Exec(c, t, "RELEASE request_split");
            RememberInput(c, t, user, request.ClientRequestId, Idempotency(request.Expect, normalized), queued.RequestId!);
            return Split(queued, waiting.RequestId!, held);
        }
        /// <summary>The client id suffix of the part of a split ask that waits for an OK.</summary>
        private const string SplitHeldSuffix = "|ok";
        private static RequestOutcome Split(RequestOutcome queued, string heldId, int[] heldSeasons)
            => queued with { Outcome = "split", HeldRequestId = heldId, HeldSeasons = heldSeasons, Message = "Asked! The rest waits for an OK." };
        private static IEnumerable<MutationInput> Coverage(SqliteConnection c, SqliteTransaction t, IEnumerable<RequestWant> wants, string target, bool includePending = false)
        {
            foreach (var want in wants.Where(w => Active(w) && RequestDestination.SameTarget(w.TargetKey, target)))
            {
                var jobs = Jobs(c, t, "want_id=$id AND (state IN ('queued','retry','sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown')", ("$id", want.Id));
                foreach (var job in jobs.Where(j => RequestDestination.SameTarget(TargetKey(j.Authorization), target))) yield return job.Input;
                if (includePending && want.Status == "pending" && jobs.Count == 0 && want.OwnedInput != null) yield return want.OwnedInput;
                if (LinkedScope(c, t, want) is { } linked) yield return linked;
            }
        }
        // Scope already sent to the target: succeeded jobs, and requests that were already processing in Seerr
        // when they moved (Seerr sent them; JE never sends them again).
        private static IEnumerable<MutationInput> Confirmed(SqliteConnection c, SqliteTransaction? t, IEnumerable<RequestWant> wants, string target)
            => Confirmed(c, t, wants, key => RequestDestination.SameTarget(key, target));
        private static IEnumerable<MutationInput> Confirmed(SqliteConnection c, SqliteTransaction? t, IEnumerable<RequestWant> wants, Func<string, bool> target)
        {
            foreach (var want in wants)
            {
                foreach (var job in Jobs(c, t, "want_id=$id AND state='succeeded'", ("$id", want.Id)).Where(j => target(TargetKey(j.Authorization)))) yield return job.Input;
                if (target(want.TargetKey) && LinkedScope(c, t, want) is { } linked) yield return linked;
            }
        }
        private static bool ConfirmedScope(SqliteConnection c, SqliteTransaction t, MutationInput input, RequestWant[] covered, RequestPolicyFacts facts)
            => input.Extra(Confirmed(c, t, covered, TargetKey(facts))) == null;
        /// <summary>
        /// The scope of a request that was already processing in Seerr when it moved to JE: linked to its title
        /// as sent (cost 0, no job) so later asks merge with it instead of sending a second add. Null for any
        /// other want, and for a moved request that has since been approved into a job of its own.
        /// </summary>
        private static MutationInput? LinkedScope(SqliteConnection c, SqliteTransaction? t, RequestWant want)
            => want.OriginKind == RequestOrigin.SeerrImportKind && want.Status is "sent" or "stale" && want.OwnedInput != null &&
                Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w LIMIT 1", ("$w", want.Id)) == null ? want.OwnedInput : null;
        private static void RememberInput(SqliteConnection c, SqliteTransaction t, Guid user, string client, string fingerprint, string wantId)
            => Exec(c, t, "INSERT INTO request_inputs VALUES($u,$client,$f,$w)", ("$u", Id(user)), ("$client", client), ("$f", fingerprint), ("$w", wantId));
        // pool: the group pool the initial reservation is bound to (phase 4b); every later charge of the want (an
        // approval's extra scope, a future season) is bound to the same pool, so spend never moves between pools.
        private static void Reserve(SqliteConnection c, SqliteTransaction t, string id, Guid user, int cost, double gb, string state, DateTimeOffset now, string scope, string? pool = null)
            => Exec(c, t, "INSERT INTO reservations(id,want_id,user_id,cost,estimated_gb,state,charged_at,scope,episode_count,pool_id,charge_seq) VALUES($id,$w,$u,$cost,$gb,$state,$at,$scope,COALESCE((SELECT CASE WHEN json_extract(owned_input,'$.Scope')='episodes' THEN json_array_length(owned_input,'$.Episodes') ELSE 0 END FROM wants WHERE id=$w AND $scope='initial'),0)," + PoolOf + ",CASE WHEN $state='charged' THEN " + NextCharge + " END)", ("$id", NewId()), ("$w", id), ("$u", Id(user)), ("$cost", cost), ("$gb", gb), ("$state", state), ("$at", Ms(now)), ("$scope", scope), ("$pool", pool));
        // The pool a new reservation of want $w is bound to: the one named ($pool, the initial reservation), else the
        // pool of the want's initial reservation.
        private const string PoolOf = "COALESCE($pool,(SELECT pool_id FROM reservations WHERE want_id=$w AND scope='initial' LIMIT 1))";
        /// <summary>Requests charged to a group pool in its rolling window (charged reservations bound to it), up to <paramref name="upTo"/> in charge order when given.</summary>
        private static int PoolUsed(SqliteConnection c, SqliteTransaction? t, string pool, int days, DateTimeOffset now, ChargeOrder? upTo = null)
            => int.Parse(Scalar(c, t, "SELECT COALESCE(SUM(cost),0) FROM reservations WHERE pool_id=$p AND state='charged' AND charged_at>$since AND charged_at<=$at" + (upTo == null ? "" : " AND " + ChargedBy),
                ("$p", pool), ("$since", Ms(now.AddDays(-days))), ("$at", Ms(now)), ("$upto", upTo?.At), ("$seq", upTo?.Seq))!, CultureInfo.InvariantCulture);
        /// <summary>True when <paramref name="cost"/> more would take the pool over its limit.</summary>
        private static bool PoolOver(SqliteConnection c, SqliteTransaction? t, GroupPoolBinding? pool, int cost, DateTimeOffset now)
            => pool != null && cost > 0 && PoolUsed(c, t, pool.Id, pool.WindowDays, now) + cost > pool.Limit;
        /// <summary>
        /// A group pool's use now (phase 4b): requests charged in its window, its limit and when the next one frees up.
        /// An aggregate: whose requests they were is never part of it.
        /// </summary>
        /// <param name="pool">The pool.</param>
        /// <param name="now">Now.</param>
        public QuotaProjection PoolQuota(GroupPoolBinding pool, DateTimeOffset now) => _db.Read(c =>
        {
            var charges = new List<QuotaCharge>();
            using (var cmd = Cmd(c, null, "SELECT cost,charged_at FROM reservations WHERE pool_id=$p AND state='charged' AND cost>0", ("$p", pool.Id)))
            using (var r = cmd.ExecuteReader())
                while (r.Read()) charges.Add(new QuotaCharge(r.GetInt32(0), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(1))));
            return QuotaProjector.Project(charges, pool.Limit, TimeSpan.FromDays(pool.WindowDays), now);
        });
        // The request for a new season a keep-getting request follows; its charge (if any) goes with the latest one, so it
        // counts as unsent until that one is sent (Seerr's quota), and stays charged when it is replaced (see Supersede).
        private static void FollowJob(SqliteConnection c, SqliteTransaction t, string wantId, MutationInput season, RequestAuthorization auth, DateTimeOffset now)
        {
            var job = AddJob(c, t, wantId, season, auth, now, linkReservation: false);
            Exec(c, t, "UPDATE reservations SET job_id=$job WHERE want_id=$w AND scope=$s", ("$job", job), ("$w", wantId), ("$s", "s" + season.Seasons.Single().ToString(CultureInfo.InvariantCulture)));
        }
        // The requests for new seasons a keep-getting request followed (Seerr mode) that Seerr refused (known unsent), for
        // seasons no later request of it is sending or sent.
        private static IReadOnlyList<RequestJob> HeldFollows(SqliteConnection c, SqliteTransaction t, RequestWant want)
        {
            if (want.Input.Scope != "future") return Array.Empty<RequestJob>();
            var follows = Jobs(c, t, "want_id=$id", ("$id", want.Id)).Where(j => j.Input.Scope == "seasons" && !j.Input.Seasons.Intersect(want.Input.Seasons).Any()).ToList();
            var going = follows.Where(j => j.State is not ("parked" or "failed" or "cancelled")).SelectMany(j => j.Input.Seasons).ToHashSet();
            return follows.Where(j => j.State is "parked" or "failed" && !j.Uncertain && !j.Input.Seasons.Any(going.Contains)).ToList();
        }
        private static RequestAuthorization Authorize(RequestPolicyFacts facts, RequestPolicyFacts? approver, MutationInput input, bool edited)
            => new(facts.UserId, approver?.UserId, "request", input.Scope, input.Variant, facts.Backend, facts.InstanceId, facts.ConnectionGeneration,
                facts.Revision, facts.SeerrSource, facts.SeerrUser, facts.SeerrPermissions, edited);
        // Jobs supply the immutability fence, including disjoint and uncertain work. Ownership
        // comes only from the registry; the outbox's bounded due list is not this inventory.
        private static List<RequestJob> TitleChoiceJobs(SqliteConnection c, SqliteTransaction t, MutationInput input, string target, bool history = false)
            => ReadJobs(c, t, "want_id IN (SELECT id FROM wants WHERE " + TitleIs + " AND variant=$v)" + (history ? "" : " AND state<>'cancelled'"), false,
                ("$key", input.Key), ("$v", input.Variant))
                .Where(j => j.Authorization.Backend == "je" && RequestDestination.SameTarget(TargetKey(j.Authorization), target)).ToList();
        private static bool HasChoice(MutationInput input) => input.ProfileId != null || input.RootFolder != null;
        private static bool ChoiceDiffers(MutationInput current, MutationInput proposed)
            => RequestDestination.ArrChoicesDiffer(current.ProfileId, current.RootFolder, proposed);
        private static RequestOutcome? CheckTitleChoice(SqliteConnection c, SqliteTransaction t, Guid actor, MutationInput input, RequestPolicyFacts facts, long? overrideVersion, string? correctionWant = null, bool allowChanges = true, Model.Arr.ArrInstanceDefaults? defaults = null)
        {
            if (facts.Backend != "je") return null;
            var auth = Authorize(facts, null, input, false);
            var jobs = TitleChoiceJobs(c, t, input, TargetKey(facts));
            var current = TitleChoiceRegistry.Current(c, t, input, auth);
            foreach (var job in jobs.Where(j => ChoiceDiffers(j.Input, input)))
                if (job.Uncertain || job.State is "sending" or "maybe_sent" or "succeeded")
                    return RequestOutcome.Refused(job.State == "succeeded" ? "request_changed" : "request_in_flight", 409, "conflict") with
                    { Message = "These add choices could not be applied: the title is already sending or sent. Check the title in Manage before changing its profile or folder." };
            if (current == null)
            {
                if (!TitleChoiceRegistry.IsIdentityFenced(c, t, input.Key)) return null; // Only executable work claims a new title.
                if (allowChanges && overrideVersion != null && TitleChoiceRegistry.Override(c, t, input, auth, overrideVersion.Value, actor).Accepted) return null;
                return RequestOutcome.Refused("choice_conflict", 409, "conflict") with
                {
                    Choice = allowChanges || facts.Role == "Admin" ? TitleChoiceRegistry.SplitConflict(c, t, input.Key) : null,
                    Message = "This title's learned identity changed. Cancel or settle ambiguous work, then explicitly confirm the corrected identity and add choices.",
                };
            }
            if (!HasChoice(input) && !current.Conflicted && overrideVersion == null) return null;
            var conflict = TitleChoiceRegistry.Conflicts(current, input);
            if (!allowChanges && HasChoice(input) && TitleChoiceRegistry.Differs(current, input)) conflict = true;
            if (allowChanges && overrideVersion != null)
            {
                if (TitleChoiceRegistry.Override(c, t, input, auth, overrideVersion.Value, actor).Accepted) return null;
            }
            else if (!conflict)
            {
                // Explicit partial/default adoption is a checked Claim. Read-only approval must not
                // fill, adopt or bump an existing record, even through this common admission helper.
                if (!allowChanges || TitleChoiceRegistry.Claim(c, t, input, auth, actor, defaults, current.Revision).Accepted) return null;
            }
            return RequestOutcome.Refused("choice_conflict", 409, "conflict") with
            {
                Choice = allowChanges || facts.Role == "Admin" ? current.Wire : null,
                Message = TitleChoiceRegistry.IsIdentityFenced(c, t, input.Key)
                    ? "This title's learned ids disagree. Cancel or settle ambiguous requests and correct conflicting source ids, then explicitly confirm the current revision to accept the corrected mapping and these add choices. Detached titles remain held."
                    : "This title already has an administrator's profile and root folder choice. Series settings apply to the whole title; seasons remain separate. Use the current choices, or explicitly confirm replacing this version before it sends.",
            };
        }
        // linkReservation: the job carries the want's latest unlinked ask or approval charge (a followed new season's
        // charge, scope "s<n>", goes with that season's own job instead: see FollowJob).
        private static Model.Arr.ArrInstanceDefaults? ChoiceDefaults(IRequestPolicy policy, string instance)
            => TitleChoiceRegistry.Settings(policy.Configuration, instance);
        private static string AddJob(SqliteConnection c, SqliteTransaction t, string wantId, MutationInput input, RequestAuthorization auth, DateTimeOffset now, bool linkReservation = true, Model.Arr.ArrInstanceDefaults? defaults = null)
        {
            var binding = TitleChoiceRegistry.Bind(c, t, input, auth, defaults);
            (input, auth) = (binding.Input, binding.Authorization);
            var id = NewId();
            Exec(c, t, "INSERT INTO jobs(id,want_id,action,instance_id,connection_generation,mutation_input,idempotency_key,fingerprint,authorization_context,state,next_attempt,reason,created_at,updated_at) VALUES($id,$w,'request',$instance,$generation,$input,$key,$f,$auth,'queued',$at,'queued_outage',$at,$at)",
                ("$id", id), ("$w", wantId), ("$instance", auth.InstanceId), ("$generation", auth.ConnectionGeneration), ("$input", input.Canonical), ("$key", "request:" + id), ("$f", input.Fingerprint), ("$auth", JsonSerializer.Serialize(auth)), ("$at", Ms(now)));
            TitleChoiceRegistry.Link(c, t, id, binding.Id, binding.Revision);
            if (linkReservation)
                Exec(c, t, "UPDATE reservations SET job_id=$job WHERE id=(SELECT id FROM reservations WHERE want_id=$w AND state='charged' AND job_id IS NULL AND (scope='initial' OR scope LIKE 'approval:%') ORDER BY rowid DESC LIMIT 1)", ("$job", id), ("$w", wantId));
            return id;
        }
        // Authorization refresh preserves the send binding and leaves the independent registry reference
        // untouched. New identities go through AddJob/TitleChoiceRegistry.Bind.
        private static void ReauthorizeJob(SqliteConnection c, SqliteTransaction t, RequestJob job, RequestAuthorization refreshed, DateTimeOffset now)
            => Exec(c, t, "UPDATE jobs SET state='maybe_sent',reason='maybe_sent',next_attempt=$at,authorization_context=$auth,updated_at=$at WHERE id=$j",
                ("$auth", JsonSerializer.Serialize(job.Authorization.CarryForward(refreshed))), ("$at", Ms(now)), ("$j", job.Id));
        /// <summary>Approves one pending row with fresh requester and approver checks in the transaction.</summary>
        public RequestOutcome Approve(string id, Guid actor, MutationInput? edits, IRequestPolicy policy, DateTimeOffset now)
            => _db.Write((c, t) =>
            {
                Exec(c, t, "SAVEPOINT request_approve");
                var outcome = ApproveCore(c, t, id, actor, edits, policy, now, resumeHeld: true);
                if (outcome.HttpStatus >= 400) Exec(c, t, "ROLLBACK TO request_approve");
                Exec(c, t, "RELEASE request_approve");
                return outcome;
            });
        // resumeHeld: an explicit approval may resume work held after part of it was written; an approver's matching ask
        // (an implicit approval) leaves such work alone.
        private RequestOutcome ApproveCore(SqliteConnection c, SqliteTransaction t, string id, Guid actor, MutationInput? edits, IRequestPolicy policy, DateTimeOffset now, bool resumeHeld = false, bool reconcileArrChoices = false)
        {
            var want = Wants(c, t, "id=$id", ("$id", id)).SingleOrDefault();
            if (want == null) return RequestOutcome.Refused("not_found", 404);
            if (Deleted(c, t, actor) || Deleted(c, t, want.UserId)) return RequestOutcome.Refused("user_required");
            // An edit names the request's own title, by any of its ids.
            var input = edits?.Normalize() is { } edited ? Canonical(c, t, edited) : want.Input;
            if (edits != null && (edits.Normalize() == null || !RequestDestination.SameTitle(input, want.Input))) return RequestOutcome.Refused("invalid_input", 400);
            if (!policy.IsAdmin(actor) && RoutingChanged(input, want.Input)) return RequestOutcome.Refused("admin_required");
            if (!policy.Evaluate(actor, want.Input, want.TargetKey).Visible) return RequestOutcome.Refused("not_visible_to_user");
            var requester = policy.Evaluate(want.UserId, input);
            var approver = policy.Evaluate(actor, input);
            if (RequestPolicy.Check(requester, approver, input, true) is { } refusal) return RequestOutcome.Refused(refusal, RequestPolicy.RefusalStatus(refusal), outcome: refusal == "backend_unavailable" ? "unavailable" : "blocked");
            if (SeerrEpisodes(requester, input) is { } seerrOnly) return seerrOnly;
            if (approver.Role != "Admin" && RoutingChanged(input, want.Input)) return RequestOutcome.Refused("admin_required");
            if (CheckTitleChoice(c, t, actor, input, requester, null, reconcileArrChoices ? null : id, allowChanges: false) is { } choiceConflict)
                return approver.Role == "Admin" ? choiceConflict : choiceConflict with { Choice = null, Message = "This title's add settings changed. Ask an administrator to review it in Manage." };
            // Manage Add can reauthorize the known-unsent owner without moving its scope or charge.
            // It cannot reopen sent work; normal approval retains its pending-only contract.
            if (want.Status != "pending" && !(reconcileArrChoices && want.Status == "queued" && edits != null && requester.Backend == "je")) return RequestOutcome.Refused("request_changed", 409);
            // A job held after part of it was written (parked, certainty unknown) isn't in flight: approving resumes it.
            if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$id AND (state IN ('sending','maybe_sent') OR (state<>'parked' AND json_extract(outcome,'$.certainty')='Unknown')) LIMIT 1", ("$id", id)) != null) return RequestOutcome.Refused("request_in_flight", 409);
            var jobs = Jobs(c, t, "want_id=$id", ("$id", id));
            var held = jobs.Where(j => j.State == "parked" && j.Uncertain).ToList();
            var targetChanged = !RequestDestination.SameTarget(TargetKey(requester), want.TargetKey);
            // The one re-confirmation rule: only a fresh stamp for the same destination on the request's own Seerr
            // re-confirms it (a written part keeps its uncertainty and is read back first); a written part resumes only
            // where it was; and what went out never moves, whatever the approval is.
            var verdict = RequestDestination.Approval(want.Input, want.TargetKey, input, TargetKey(requester), edits != null, jobs, resumeHeld);
            if (verdict.Refusal != null) return RequestOutcome.Refused(verdict.Refusal, 409);
            if (reconcileArrChoices)
            {
                // Replace identities rather than editing a row an outbox worker may already have read.
                // The claim and this transaction serialize: either the old claim wins (refused above),
                // or that stale snapshot can no longer claim the cancelled job. Move only the reservation
                // link; its owner, cost, charge time/order and scope remain exactly as charged.
                var unsent = Jobs(c, t, "want_id=$id AND state IN ('queued','retry') AND " + KnownUnsent, ("$id", id));
                if (unsent.Count == 0) return RequestOutcome.Refused("request_changed", 409);
                foreach (var job in unsent)
                {
                    var replacement = job.Input.WithArrChoices(input);
                    var next = AddJob(c, t, id, replacement, Authorize(requester, approver, replacement, true), now, linkReservation: false, defaults: ChoiceDefaults(policy, requester.InstanceId));
                    if (ChoiceDiffers(job.Input, replacement) || job.TitleChoiceRevision != TitleChoiceRegistry.Current(c, t, replacement, job.Authorization)?.Revision)
                        Record(c, t, id, next, actor, "choice_override", "accepted", "request_changed", input.Key, now);
                    Exec(c, t, "UPDATE jobs SET state='cancelled',reason='request_changed',updated_at=$at WHERE id=$j", ("$at", Ms(now)), ("$j", job.Id));
                    Exec(c, t, "UPDATE reservations SET job_id=$next WHERE job_id=$old", ("$next", next), ("$old", job.Id));
                }
                Exec(c, t, "UPDATE wants SET mutation_input=$input,owned_input=$owned,reason='queued_outage',updated_at=$at WHERE id=$id",
                    ("$input", input.Canonical), ("$owned", want.OwnedInput?.WithArrChoices(input).Canonical), ("$at", Ms(now)), ("$id", id));
                var authorization = Authorize(requester, approver, input, true);
                Approval(c, t, want, actor, "approve", null, edits, authorization, now);
                Record(c, t, id, null, actor, "approve", "accepted", "queued_outage", input.Key, now);
                return RequestOutcome.Accepted(id, "queued_outage", 200);
            }
            var restamp = verdict.Reconfirms;
            if (targetChanged)
                foreach (var old in Jobs(c, t, "want_id=$id AND state IN ('queued','retry') AND " + KnownUnsent, ("$id", id)).Where(j => !RequestDestination.SameTarget(TargetKey(j.Authorization), TargetKey(requester))))
                    Supersede(c, t, old.Id, "instance_changed");
            if (restamp)
            {
                // Its jobs at that destination carry the new stamp (Seerr is only ever sent the server, profile and root
                // folder): what went out stays covered, and held new seasons and queued work go out with the new stamp.
                foreach (var job in jobs.Where(j => RequestDestination.SameOptions(j.Input, want.Input)))
                {
                    var moved = job.Input with { SeerrOptions = input.SeerrOptions };
                    Exec(c, t, "UPDATE jobs SET mutation_input=$input,fingerprint=$f WHERE id=$j", ("$input", moved.Canonical), ("$f", moved.Fingerprint), ("$j", job.Id));
                }
            }
            else if (edits != null && !RequestDestination.SameInput(input, want.Input))
            {
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id IN (SELECT id FROM jobs WHERE want_id=$id AND state IN ('queued','retry'))", ("$id", id));
                Exec(c, t, "UPDATE jobs SET state='cancelled',reason='request_changed' WHERE want_id=$id AND state IN ('queued','retry')", ("$id", id));
            }
            // A "keep getting new episodes" request held while a new season it follows was being sent (over Seerr's quota,
            // say): approving sends that season again, with this approval's authority (its charge stays as it was).
            var followed = (edits == null || restamp) && !targetChanged
                ? HeldFollows(c, t, want).Select(j => j.Input).DistinctBy(i => i.Fingerprint).ToArray()
                : Array.Empty<MutationInput>();
            foreach (var parked in Jobs(c, t, "want_id=$id AND state='parked' AND " + KnownUnsent, ("$id", id)))
                Supersede(c, t, parked.Id, "request_changed");
            // The same job goes on with the approval's authority: same scope and reservation, certainty still unknown (no
            // cancel or refund meanwhile). As after a restart, a fresh read of what is there comes first; then a guarded
            // send writes only what is missing.
            // A job waiting for something only a person can fix (a Seerr account) is checked again at once.
            Exec(c, t, "UPDATE jobs SET next_attempt=$at WHERE want_id=$id AND state='retry' AND next_attempt>$at", ("$at", Ms(now)), ("$id", id));
            foreach (var resume in held)
                ReauthorizeJob(c, t, resume, Authorize(requester, approver, resume.Input, edits != null), now);
            var own = Wants(c, t, "user_id=$u AND id<>$id", ("$u", Id(want.UserId)), ("$id", id));
            var covered = Wants(c, t, TitleIs + " AND variant=$v AND id<>$id", ("$key", input.Key), ("$v", input.Variant), ("$id", id)).Where(w => Active(w) && w.Status != "pending").ToArray();
            // (maybe_sent here: only the held jobs resumed above.)
            var existingJobs = Jobs(c, t, "want_id=$id AND state IN ('queued','retry','succeeded','maybe_sent')", ("$id", id));
            var extra = input.Extra(Coverage(c, t, covered, TargetKey(requester)).Concat(existingJobs.Where(j => RequestDestination.SameTarget(TargetKey(j.Authorization), TargetKey(requester))).Select(j => j.Input)));
            var cost = extra == null || Free(want) ? 0 : Cost(c, t, extra, want.UserId, now, requester.WindowDays, existingJobs.Count == 0 ? id : null);
            var gb = extra == null ? 0 : EstimateGb(extra, requester);
            if (OverGbCap(requester, Charges(c, t, want.UserId).Where(charge => existingJobs.Count > 0 || charge.WantId != id).ToArray(), gb, now)) return RequestOutcome.Refused("quota_exceeded", 429, "quota_exceeded");
            // Explicit approval grants soft quota/series excess, while hard limits and visibility remain enforced.
            if (requester.Backend == "seerr" && OverQuota(requester, Charges(c, t, want.UserId, requester.Backend == "seerr"), cost, gb, now)) return RequestOutcome.Refused("over_quota", 429, "quota_exceeded");
            var confirmedScope = extra == null && followed.Length == 0 && ConfirmedScope(c, t, input, covered.Append(want).ToArray(), requester);
            var stored = input;
            var priorCost = existingJobs.Count == 0 ? 0 : int.Parse(Scalar(c, t, "SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=$id AND state='charged'", ("$id", id))!, CultureInfo.InvariantCulture);
            var acquisition = want.AcquisitionId;
            if (!RequestDestination.SameEdition(input, want.Input))
            {
                acquisition = Scalar(c, t, "SELECT id FROM acquisitions WHERE " + TitleIs + " AND variant=$v AND state='active'", ("$key", input.Key), ("$v", input.Variant)) ?? NewId();
                Exec(c, t, "INSERT OR IGNORE INTO acquisitions VALUES($id,$key,$v,'active',$at)", ("$id", acquisition), ("$key", input.Key), ("$v", input.Variant), ("$at", Ms(now)));
            }
            Exec(c, t, "UPDATE wants SET acquisition_id=$a,mutation_input=$input,owned_input=$owned,variant=$v,status=$state,reason=$reason,cost=$cost,is_follower=$follower,parental_signature=$p,updated_at=$at WHERE id=$id",
                ("$a", acquisition), ("$input", stored.Canonical), ("$owned", extra?.Canonical), ("$v", stored.Variant), ("$state", confirmedScope ? "sent" : "queued"), ("$reason", confirmedScope ? "looking" : "queued_outage"), ("$cost", priorCost + cost), ("$p", requester.ParentalSignature), ("$follower", extra == null && existingJobs.Count == 0), ("$at", Ms(now)), ("$id", id));
            AcceptActiveAliases(c, t, stored.Key);
            Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", TargetKey(requester)), ("$id", id));
            if (existingJobs.Count == 0)
                Exec(c, t, "UPDATE reservations SET job_id=NULL,state='charged',charge_seq=" + NextCharge + ",cost=$cost,estimated_gb=$gb,charged_at=$at,episode_count=COALESCE((SELECT CASE WHEN json_extract(owned_input,'$.Scope')='episodes' THEN json_array_length(owned_input,'$.Episodes') ELSE 0 END FROM wants WHERE id=$id),0) WHERE want_id=$id AND scope='initial'", ("$cost", cost), ("$gb", gb), ("$at", Ms(now)), ("$id", id));
            else if (extra != null)
                Exec(c, t, "INSERT INTO reservations(id,want_id,user_id,cost,estimated_gb,state,charged_at,scope,episode_count,pool_id,charge_seq) VALUES($rid,$id,$u,$cost,$gb,'charged',$at,$scope,$episodes,(SELECT pool_id FROM reservations WHERE want_id=$id AND scope='initial' LIMIT 1)," + NextCharge + ")",
                    ("$rid", NewId()), ("$id", id), ("$u", Id(want.UserId)), ("$cost", cost), ("$gb", gb), ("$at", Ms(now)), ("$scope", "approval:" + NewId()), ("$episodes", extra.Scope == "episodes" ? extra.Episodes.Length : 0));
            Fault?.Invoke("reservation");
            var auth = Authorize(requester, approver, extra ?? stored, edits != null);
            if (extra != null) AddJob(c, t, id, extra, auth, now, defaults: ChoiceDefaults(policy, requester.InstanceId));
            foreach (var season in followed) FollowJob(c, t, id, season, Authorize(requester, approver, season, false), now);
            Approval(c, t, want, actor, "approve", null, edits, auth, now);
            Record(c, t, id, null, actor, "approve", "accepted", "queued_outage", stored.Key, now);
            if (edits != null && !RequestDestination.SameInput(input, want.Input))
            {
                WithdrawFollowers(c, t, want.AcquisitionId, now);
                if (acquisition != want.AcquisitionId) WithdrawFollowers(c, t, acquisition, now);
            }
            if (targetChanged) RehomeFollowers(c, t, want.AcquisitionId, acquisition, want.TargetKey, TargetKey(requester), actor, policy, now);
            ReleasePendingFollowers(c, t, acquisition, actor, policy, now);
            return RequestOutcome.Accepted(id, confirmedScope ? "looking" : "queued_outage", 200);
        }
        // Free automation (persisted with the want) costs nobody's allowance whenever its cost is worked out again; its
        // estimated GB still counts against a hard GB cap.
        private static bool Free(RequestWant want) => RequestOriginDetail.Read(want.OriginDetail)?.Free == true;
        private static void RehomeFollowers(SqliteConnection c, SqliteTransaction t, string oldAcquisition, string acquisition, string oldTarget, string target, Guid actor, IRequestPolicy policy, DateTimeOffset now)
        {
            var oldWants = Wants(c, t, "acquisition_id=$a", ("$a", oldAcquisition));
            var oldCoverage = Coverage(c, t, oldWants, oldTarget).ToArray();
            var newCoverage = Coverage(c, t, Wants(c, t, "acquisition_id=$a", ("$a", acquisition)), target).ToArray();
            foreach (var follower in oldWants.Where(w => w.Follower && RequestDestination.SameTarget(w.TargetKey, oldTarget) && w.Status is "queued" or "pending" && w.Input.Extra(oldCoverage) != null))
            {
                if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w LIMIT 1", ("$w", follower.Id)) != null) continue;
                var facts = policy.Evaluate(follower.UserId, follower.Input);
                var migrate = RequestDestination.SameTarget(TargetKey(facts), target) && RequestPolicy.Check(facts, policy.Evaluate(actor, follower.Input), follower.Input, true) == null;
                var queued = migrate && follower.Input.Extra(newCoverage) == null;
                var confirmed = queued && ConfirmedScope(c, t, follower.Input, Wants(c, t, "acquisition_id=$a", ("$a", acquisition)).ToArray(), facts);
                var reason = confirmed ? "looking" : queued ? "queued_outage" : "instance_changed";
                Exec(c, t, "UPDATE wants SET acquisition_id=$a,target_key=$t,status=$s,reason=$r,updated_at=$at WHERE id=$w",
                    ("$a", migrate ? acquisition : oldAcquisition), ("$t", migrate ? target : oldTarget), ("$s", confirmed ? "sent" : queued ? "queued" : "pending"), ("$r", reason), ("$at", Ms(now)), ("$w", follower.Id));
                Record(c, t, follower.Id, null, actor, "target_changed", "accepted", reason, follower.Input.Key, now);
            }
        }
        private static void DemoteUncoveredFollowers(SqliteConnection c, SqliteTransaction t, string acquisition, string target, string reason, DateTimeOffset now)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
            foreach (var want in wants.Where(w => RequestDestination.SameTarget(w.TargetKey, target) && w.Status == "queued" && w.Input.Extra(Coverage(c, t, wants, w.TargetKey)) != null))
            {
                Exec(c, t, "UPDATE wants SET status='pending',reason=$r,updated_at=$at WHERE id=$w", ("$r", reason), ("$at", Ms(now)), ("$w", want.Id));
                Record(c, t, want.Id, null, null, "scope_held", "accepted", reason, want.Input.Key, now);
            }
        }
        // actor: who released them (an approver, or the asker whose ask covers them); null for the ledger itself (a merge).
        private static void ReleasePendingFollowers(SqliteConnection c, SqliteTransaction t, string acquisition, Guid? actor, IRequestPolicy policy, DateTimeOffset now, bool approving = true)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
            foreach (var follower in wants.Where(w => w.Status == "pending"))
            {
                if (follower.Input.Extra(Coverage(c, t, wants, follower.TargetKey)) != null) continue;
                if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$id LIMIT 1", ("$id", follower.Id)) != null) continue;
                if (RequestPolicy.Check(policy.Evaluate(follower.UserId, follower.Input), approving && actor is Guid approver ? policy.Evaluate(approver, follower.Input) : null, follower.Input, approving) != null) continue;
                // Scope that is already sent has no job left to complete, so the follower is sent now too.
                var sent = follower.Input.Extra(Confirmed(c, t, wants, follower.TargetKey)) == null;
                Exec(c, t, "UPDATE wants SET status=$s,reason=$r,owned_input=NULL,is_follower=1,cost=0,updated_at=$at WHERE id=$id",
                    ("$s", sent ? "sent" : "queued"), ("$r", sent ? "looking" : "queued_outage"), ("$at", Ms(now)), ("$id", follower.Id));
                Exec(c, t, "UPDATE reservations SET state='charged',charge_seq=" + NextCharge + ",cost=0,estimated_gb=0,episode_count=0,charged_at=$at WHERE want_id=$id AND scope='initial' AND state='held'", ("$at", Ms(now)), ("$id", follower.Id));
                Record(c, t, follower.Id, null, actor, "merged", "accepted", sent ? "looking" : "queued_outage", follower.Input.Key, now);
            }
        }
        /// <summary>Cancel (<paramref name="declineReason"/> null) or decline: the one withdrawal rule (see <see cref="Withdraw"/>).</summary>
        public RequestOutcome Close(string id, Guid actor, string? declineReason, IRequestPolicy policy, DateTimeOffset now)
            => _db.Write((c, t) => Withdraw(c, t, id, actor, declineReason, policy, now));
        // Work proven unsent: queued, retried later, held at send (parked) or refused (failed), and never left uncertain.
        private const string Unsent = "state IN ('queued','retry','parked','failed') AND " + KnownUnsent;
        // What a policy refusal says only about a request's routing no longer fitting, or not being checkable now (its arr
        // instance or folder changed, its Seerr choice is stale, Seerr can't be asked, the drive is low): never a reason to
        // keep it. Anything else (no such person, the feature off, authority changing, not seeing it) refuses a withdrawal.
        private static readonly IReadOnlySet<string> RoutingRefusals = new HashSet<string>(StringComparer.Ordinal)
        {
            "invalid_instance", "instance_changed", "invalid_defaults", "invalid_choice", "seerr_options_invalid", "seerr_options_changed", "seerr_options_disabled",
            "seerr_advanced_required", "backend_unavailable", "low_disk",
        };
        /// <summary>
        /// The one withdrawal rule (phase 4b, review round 4), for a cancel (<paramref name="declineReason"/> null) or a decline:
        /// <list type="number">
        /// <item>Who may: the person who asked or an administrator cancels; someone who may approve declines. Each is judged
        /// as they see the request where it actually goes (its arr instance and folder, or its Seerr choice), never by whether
        /// its routing still fits: a stale Seerr choice or a changed arr is often why it waits.</item>
        /// <item>What may be withdrawn: an active request (a decline: one waiting for an OK), never while a part of it may have
        /// gone out (being sent, unconfirmed, or a request Seerr was already processing when it moved). A request with a part
        /// that went out only while it waits for an OK and what went out covers what it asked for.</item>
        /// <item>What is cancelled and refunded: every part proven unsent (queued, retried later, held, refused). What stays:
        /// what went out, charged; such a request is sent again. Else the request is cancelled or declined as a whole.</item>
        /// <item>The people following it: a cancel withdraws what they followed that nothing covers any more; a decline makes
        /// each of them the owner of what nobody else is still asking for, waiting for an OK.</item>
        /// </list>
        /// </summary>
        private static RequestOutcome Withdraw(SqliteConnection c, SqliteTransaction t, string id, Guid actor, string? declineReason, IRequestPolicy policy, DateTimeOffset now)
        {
            var want = Wants(c, t, "id=$id", ("$id", id)).SingleOrDefault();
            if (want == null) return RequestOutcome.Refused("not_found", 404);
            var decline = declineReason != null;
            // 1. Who may, seeing it where it goes.
            var facts = policy.Evaluate(actor, want.Input, want.TargetKey);
            if (!facts.Visible || (facts.Refusal != null && !RoutingRefusals.Contains(facts.Refusal))) return RequestOutcome.Refused(facts.Refusal ?? "not_visible_to_user");
            if (decline ? !facts.CanApprove : actor != want.UserId && facts.Role != "Admin") return RequestOutcome.Refused("requests_approve_required");
            if (decline && (string.IsNullOrWhiteSpace(declineReason) || declineReason!.Length > 500 || declineReason.Any(ch => char.IsControl(ch) && ch != '\n'))) return RequestOutcome.Refused("invalid_reason", 400);
            // 2. What may be withdrawn.
            if (!Active(want) || (decline && want.Status != "pending")) return RequestOutcome.Refused("request_changed", 409);
            var jobs = Jobs(c, t, "want_id=$id", ("$id", id));
            if (jobs.Any(j => j.State is "sending" or "maybe_sent" || j.Uncertain) || LinkedScope(c, t, want) != null) return RequestOutcome.Refused("request_in_flight", 409);
            var sent = jobs.Where(j => j.State == "succeeded").Select(j => j.Input).ToList();
            if (sent.Count > 0 && (want.Status != "pending" || want.Input.Extra(sent) != null)) return RequestOutcome.Refused("request_in_flight", 409);
            // 3. Every part proven unsent is cancelled and refunded; what went out stays.
            var state = decline ? "declined" : "cancelled";
            Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id IN (SELECT id FROM jobs WHERE want_id=$id AND " + Unsent + ")", ("$id", id));
            Exec(c, t, "UPDATE jobs SET state='cancelled',reason=$s WHERE want_id=$id AND " + Unsent, ("$s", state), ("$id", id));
            if (sent.Count > 0)
            {
                Exec(c, t, "UPDATE wants SET status='sent',reason='looking',cost=(SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=wants.id AND state='charged'),updated_at=$at WHERE id=$id", ("$at", Ms(now)), ("$id", id));
            }
            else
            {
                Exec(c, t, "UPDATE wants SET status=$s,reason=$s,updated_at=$at WHERE id=$id", ("$s", state), ("$at", Ms(now)), ("$id", id));
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE want_id=$id", ("$id", id));
            }
            // 4. The people following it.
            if (decline) RestorePendingOwners(c, t, want.AcquisitionId, policy, now);
            else WithdrawFollowers(c, t, want.AcquisitionId, now);
            var reason = sent.Count > 0 ? "looking" : state;
            Approval(c, t, want, actor, state, declineReason, null, Authorize(facts, facts, want.Input, false), now);
            Record(c, t, id, null, actor, state, "accepted", reason, want.Input.Key, now);
            return RequestOutcome.Accepted(id, reason, 200);
        }
        // A decline: each person following a request that nothing covers any more (pending or queued) owns what nobody else
        // at their target is still asking for (the remaining coverage), waiting for an OK.
        private static void RestorePendingOwners(SqliteConnection c, SqliteTransaction t, string acquisition, IRequestPolicy policy, DateTimeOffset now)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
            for (var i = 0; i < wants.Count; i++)
            {
                var follower = wants[i];
                if (!follower.Follower || follower.Status is not ("pending" or "queued")) continue;
                var extra = follower.Input.Extra(Coverage(c, t, wants, follower.TargetKey, true));
                if (extra == null) continue;
                var facts = policy.Evaluate(follower.UserId, extra);
                var cost = Free(follower) ? 0 : Cost(c, t, extra, follower.UserId, now, facts.WindowDays);
                var reason = follower.Status == "pending" ? follower.Reason : "awaiting_approval";
                Exec(c, t, "UPDATE wants SET status='pending',reason=$r,owned_input=$input,is_follower=0,cost=$cost,updated_at=$at WHERE id=$id", ("$r", reason), ("$input", extra.Canonical), ("$cost", cost), ("$at", Ms(now)), ("$id", follower.Id));
                Exec(c, t, "UPDATE reservations SET state='held',cost=$cost,estimated_gb=$gb WHERE want_id=$id AND scope='initial'", ("$cost", cost), ("$gb", EstimateGb(extra, facts)), ("$id", follower.Id));
                Record(c, t, follower.Id, null, null, "scope_restored", "accepted", reason, follower.Input.Key, now);
                // It covers the people after it who follow the same scope.
                wants[i] = follower with { Status = "pending", Reason = reason, Follower = false, OwnedInput = extra, Cost = cost };
            }
        }
        private static void WithdrawFollowers(SqliteConnection c, SqliteTransaction t, string acquisition, DateTimeOffset now)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));

            foreach (var mixed in wants.Where(w => !w.Follower && Active(w) && w.Input.Extra(Coverage(c, t, wants, w.TargetKey, true)) != null))
            {
                Exec(c, t, "UPDATE wants SET status='pending',reason='removed',updated_at=$at WHERE id=$id", ("$at", Ms(now)), ("$id", mixed.Id));
                Record(c, t, mixed.Id, null, null, "scope_withdrawn", "accepted", "removed", mixed.Input.Key, now);
            }
            foreach (var follower in wants.Where(w => w.Follower && w.Status is "queued" or "pending" && w.Input.Extra(Coverage(c, t, wants, w.TargetKey, true)) != null))
            {
                Exec(c, t, "UPDATE wants SET status='cancelled',reason='removed',updated_at=$at WHERE id=$id", ("$at", Ms(now)), ("$id", follower.Id));
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE want_id=$id", ("$id", follower.Id));
                Record(c, t, follower.Id, null, null, "withdrawn", "accepted", "removed", follower.Input.Key, now);
            }
        }
        private static void Approval(SqliteConnection c, SqliteTransaction t, RequestWant want, Guid actor, string action, string? reason, MutationInput? edits, RequestAuthorization auth, DateTimeOffset now)
            => Exec(c, t, "INSERT INTO approvals VALUES($id,$w,$actor,$action,$r,$edits,$instance,$generation,$at)", ("$id", NewId()), ("$w", want.Id), ("$actor", Id(actor)), ("$action", action), ("$r", reason), ("$edits", edits?.Canonical), ("$instance", auth.InstanceId), ("$generation", auth.ConnectionGeneration), ("$at", Ms(now)));
        private static void Record(SqliteConnection c, SqliteTransaction t, string wantId, string? jobId, Guid? actor, string action, string outcome, string reason, string key, DateTimeOffset now)
        {
            Changed(c, t);
            if (actor.HasValue && Deleted(c, t, actor.Value)) actor = null;
            Exec(c, t, "INSERT INTO request_audit VALUES($id,$w,$j,$actor,$action,$outcome,$reason,$at)", ("$id", NewId()), ("$w", wantId), ("$j", jobId), ("$actor", actor.HasValue ? Id(actor.Value) : null), ("$action", action), ("$outcome", outcome), ("$reason", reason), ("$at", Ms(now)));
            Exec(c, t, "INSERT INTO request_events(title_key,created_at) VALUES($key,$at)", ("$key", key), ("$at", Ms(now)));
            var owner = Scalar(c, t, "SELECT user_id FROM wants WHERE id=$id", ("$id", wantId));
            if (owner != null && Scalar(c, t, "SELECT user_hash FROM request_deleted_users WHERE lower(substr(user_hash,1,32))=$u", ("$u", owner)) == null) Exec(c, t, "INSERT INTO request_notices VALUES($id,$w,$u,$kind,$at)", ("$id", NewId()), ("$w", wantId), ("$u", owner), ("$kind", action), ("$at", Ms(now)));
        }
        /// <summary>Owned "keep getting new episodes" requests that went out to <paramref name="targetKey"/> (sent or stale, not followers).</summary>
        /// <param name="targetKey">The backend target (see <see cref="TargetKey(RequestAuthorization)"/>).</param>
        public IReadOnlyList<RequestWant> FutureWants(string targetKey) => !_db.Available ? Array.Empty<RequestWant>() : _db.Read(c =>
            (IReadOnlyList<RequestWant>)Wants(c, null, "target_key=$t AND status IN ('sent','stale') AND cost>0 AND json_extract(mutation_input,'$.Scope')='future'", ("$t", targetKey)));
        /// <summary>Charges a newly observed future season exactly once; overdrafts remain visible.</summary>
        public bool ChargeFutureSeason(string wantId, int season, IRequestPolicy policy, DateTimeOffset now)
        {
            if (season < 0 || season > 10000) return false;
            return _db.Write((c, t) =>
            {
                var want = Wants(c, t, "id=$id", ("$id", wantId)).SingleOrDefault();
                if (want == null || want.Input.Scope != "future" || want.Cost == 0 || want.Status is not ("sent" or "stale") || want.Input.Seasons.Contains(season) || !policy.Configuration.ArrRequestChargeFutureSeasons) return false;
                var scope = "s" + season.ToString(CultureInfo.InvariantCulture);
                if (Scalar(c, t, "SELECT id FROM reservations WHERE want_id=$id AND scope=$s", ("$id", wantId), ("$s", scope)) != null) return false;
                var newSeason = want.Input.NewSeason(season);
                Reserve(c, t, wantId, want.UserId, 1, EstimateGb(newSeason, policy.Evaluate(want.UserId, newSeason)), "charged", now, scope);
                Record(c, t, wantId, null, want.UserId, "future_season", "accepted", "looking", want.Input.Key, now);
                return true;
            });
        }
        /// <summary>
        /// Seerr mode (Seerr doesn't follow new seasons itself): queues one request to Seerr for a new season of a sent
        /// "keep getting new episodes" request, as its owner with the approval it was sent with, and charges the owner
        /// for it once (D16; an overdraft is allowed, as Sonarr would fetch it in Jellyfin Enhanced mode) unless charging
        /// future seasons is off or the season was charged already. Once per season and request, whatever became of the
        /// first (a held one is sent again when the request is approved): false when one exists, the request isn't a
        /// sent keep-getting request on the Seerr the requester's asks go to now, or the season is the one asked for. The
        /// new season's request is the approved request's input for that season, with its Seerr options and stamp.
        /// </summary>
        /// <param name="wantId">The keep-getting request.</param>
        /// <param name="season">The new season.</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Now.</param>
        public bool FollowFutureSeason(string wantId, int season, IRequestPolicy policy, DateTimeOffset now)
        {
            if (season < 1 || season > 10000) return false;
            return _db.Write((c, t) =>
            {
                var want = Wants(c, t, "id=$id", ("$id", wantId)).SingleOrDefault();
                if (want == null || want.Input.Scope != "future" || want.Status is not ("sent" or "stale") || want.Input.Seasons.Contains(season)) return false;
                // From the request as approved: the new season goes where it went (an administrator's Seerr server, profile,
                // root folder and options stamp included), checked again at send like any request with them.
                var input = want.Input.NewSeason(season).Normalize();
                if (input == null) return false;
                var requester = policy.Evaluate(want.UserId, input);
                if (requester.Backend != "seerr" || !RequestDestination.SameTarget(TargetKey(requester), want.TargetKey)) return false;
                var jobs = Jobs(c, t, "want_id=$id", ("$id", wantId));
                if (jobs.Any(j => j.Input.Scope == "seasons" && j.Input.Seasons.Contains(season))) return false;
                // The approval the request went out with covers what it follows (a Kid's OK'd keep-getting needs no new OK).
                var approver = jobs.Where(j => j.State == "succeeded").Select(j => j.Authorization.Approver).LastOrDefault(a => a != null);
                var scope = "s" + season.ToString(CultureInfo.InvariantCulture);
                if (want.Cost > 0 && policy.Configuration.ArrRequestChargeFutureSeasons && Scalar(c, t, "SELECT id FROM reservations WHERE want_id=$id AND scope=$s", ("$id", wantId), ("$s", scope)) == null)
                    Reserve(c, t, wantId, want.UserId, 1, EstimateGb(input, requester), "charged", now, scope);
                FollowJob(c, t, wantId, input, Authorize(requester, approver is Guid a ? policy.Evaluate(a, input) : null, input, false), now);
                Record(c, t, wantId, null, want.UserId, "future_season", "accepted", "queued_outage", want.Input.Key, now);
                return true;
            });
        }
        private static List<RequestJob> Jobs(SqliteConnection c, SqliteTransaction? t, string where, params (string, object?)[] args)
        {
            return ReadJobs(c, t, where, true, args);
        }
        private static List<RequestJob> ReadJobs(SqliteConnection c, SqliteTransaction? t, string where, bool bounded, params (string, object?)[] args)
        {
            using var cmd = Cmd(c, t, "SELECT id,want_id,mutation_input,authorization_context,state,attempts,next_attempt,reason,idempotency_key,fingerprint,COALESCE(json_extract(outcome,'$.certainty')='Unknown',0) FROM jobs WHERE " + where + " ORDER BY next_attempt,id" + (bounded ? " LIMIT 100" : ""), args);
            using var r = cmd.ExecuteReader();
            var list = new List<RequestJob>();
            while (r.Read()) list.Add(new(r.GetString(0), r.GetString(1), JsonSerializer.Deserialize<MutationInput>(r.GetString(2))!, JsonSerializer.Deserialize<RequestAuthorization>(r.GetString(3))!,
                r.GetString(4), r.GetInt32(5), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(6)), r.GetString(7), r.GetString(8), r.GetString(9), r.GetInt64(10) == 1));
            r.Close();
            return list.Select(j => TitleChoiceRegistry.Display(c, t, j)).ToList();
        }
        /// <summary>One job by id, or null.</summary>
        public RequestJob? Job(string id) => _db.Read(c => Jobs(c, null, "id=$id", ("$id", id)).SingleOrDefault());
        /// <summary>
        /// Binds a job that is being sent to Seerr to the account it goes out as and the exact seasons it carries, before
        /// the request leaves: a read-back (also after a restart) then looks for exactly that. False: not bound (the job
        /// is no longer being sent), so nothing may be sent.
        /// </summary>
        public bool BindSeerrSend(string jobId, int seerrUser, int[] seasons) => _db.Write((c, t) =>
            Exec(c, t, "UPDATE jobs SET authorization_context=json_set(authorization_context,'$.SeerrUser',$u,'$.SeerrSeasons',json($s)) WHERE id=$id AND state='sending'",
                ("$u", seerrUser), ("$s", JsonSerializer.Serialize(seasons)), ("$id", jobId)) == 1);
        /// <summary>Due jobs. A previous sending row becomes maybe_sent during recovery.</summary>
        public IReadOnlyList<RequestJob> Due(DateTimeOffset now) => _db.Read(c => Jobs(c, null, "state IN ('queued','retry','maybe_sent') AND next_attempt<=$at", ("$at", Ms(now))));
        /// <summary>Jobs of a want, for administrative diagnostics and tests.</summary>
        public IReadOnlyList<RequestJob> ForWant(string id) => _db.Read(c => Jobs(c, null, "want_id=$id", ("$id", id)));
        /// <summary>Recovers uncertain writes after a process restart, never blindly re-sending them.</summary>
        public void Recover(DateTimeOffset now)
        {
            _db.Write((c, t) => Exec(c, t, "UPDATE jobs SET state='maybe_sent',reason='maybe_sent',next_attempt=$at WHERE state='sending' OR (state='parked' AND json_extract(outcome,'$.certainty')='Unknown')", ("$at", Ms(now))));
            // A move's staged batch left by the process that ran it (or by a restored copy) never completes: rolled back.
            DiscardStagedImports(now);
        }
        /// <summary>Claims a due row under a database generation fence (after the send-time redundancy check: see <see cref="ClaimForDispatch"/>).</summary>
        public bool Claim(RequestJob job, long generation, DateTimeOffset now) => ClaimForDispatch(job, generation, now) == DispatchClaim.Claimed;
        /// <summary>What claiming a due job for its send did.</summary>
        public enum DispatchClaim
        {
            /// <summary>Claimed: it is being sent now.</summary>
            Claimed,
            /// <summary>Not claimed: it changed meanwhile (or the database was restored).</summary>
            Lost,
            /// <summary>Not sent: what it would send already went out for the title, so it was cancelled and its charge given back.</summary>
            Served,
            /// <summary>Not sent yet: what it would send is being sent (or is unconfirmed) for the title; it waits for that to settle.</summary>
            Waits,
        }
        /// <summary>How long a job waits when work in flight for its title would cover it (see <see cref="DispatchClaim.Waits"/>).</summary>
        internal static readonly TimeSpan InFlightWait = TimeSpan.FromSeconds(30);
        /// <summary>
        /// Claims a due job for its send under a database generation fence, after the one send-time redundancy check (review
        /// round 5, 4b-B13): a job whose scope another job or request of the title already sent there (the same destination,
        /// <see cref="RequestDestination.Serves(MutationInput, string, MutationInput, string)"/>) is never POSTed: it is
        /// cancelled and its charge given back once, and a request left with nothing of its own follows what went out (free).
        /// One whose scope is covered only together with work in flight there (being sent, or unconfirmed) waits for that work
        /// to settle. A read-back (<c>maybe_sent</c>) is always claimed: it only reads.
        /// </summary>
        /// <param name="job">The due job.</param>
        /// <param name="generation">The database generation it was read in.</param>
        /// <param name="now">Now.</param>
        public DispatchClaim ClaimForDispatch(RequestJob job, long generation, DateTimeOffset now) => _db.WriteIf(generation, (c, t) =>
        {
            if (job.State != "maybe_sent" && Redundancy(c, t, job, now) is { } settled) return settled;
            return Exec(c, t, "UPDATE jobs SET state='sending',attempts=attempts+1,updated_at=$at WHERE id=$id AND state=$state AND next_attempt<=$at", ("$at", Ms(now)), ("$id", job.Id), ("$state", job.State)) == 1
                ? DispatchClaim.Claimed : DispatchClaim.Lost;
        }, DispatchClaim.Lost).Result;
        // The send-time redundancy check (see ClaimForDispatch): null when the job goes out.
        private static DispatchClaim? Redundancy(SqliteConnection c, SqliteTransaction t, RequestJob job, DateTimeOffset now)
        {
            var want = Wants(c, t, "id=$id", ("$id", job.WantId)).SingleOrDefault();
            if (want == null || !Active(want)) return null;
            var target = TargetKey(job.Authorization);
            var title = Wants(c, t, "acquisition_id=$a", ("$a", want.AcquisitionId)).Where(Active).ToList();
            var sent = new List<MutationInput>();
            var going = new List<MutationInput>();
            foreach (var other in title)
            {
                foreach (var work in Jobs(c, t, "want_id=$w AND id<>$j", ("$w", other.Id), ("$j", job.Id)).Where(j => RequestDestination.Serves(job.Input, target, j.Input, TargetKey(j.Authorization))))
                {
                    if (work.State == "succeeded") sent.Add(work.Input);
                    else if (work.State is "sending" or "maybe_sent" || work.Uncertain && work.State != "cancelled") going.Add(work.Input);
                }
                if (LinkedScope(c, t, other) is { } linked && RequestDestination.Serves(job.Input, target, linked, other.TargetKey)) sent.Add(linked);
            }
            if (job.Input.Extra(sent) != null)
            {
                if (job.Input.Extra(sent.Concat(going)) != null) return null;
                if (job.State == "retry" && job.Uncertain && LeadsRetryCycle(c, t, job, title)) return null;
                // Covered only with work in flight: it waits for that to settle (a merge noted it, and SettleMerges finishes it).
                return Exec(c, t, "UPDATE jobs SET next_attempt=$next WHERE id=$j AND state=$s", ("$next", Ms(now + InFlightWait)), ("$j", job.Id), ("$s", job.State)) == 1 ? DispatchClaim.Waits : DispatchClaim.Lost;
            }
            // What it would send went out already: cancelled, and its own charge given back (once: only a charged one is).
            if (Exec(c, t, "UPDATE jobs SET state='cancelled',reason='merged',updated_at=$at WHERE id=$j AND state=$s", ("$at", Ms(now)), ("$j", job.Id), ("$s", job.State)) != 1) return DispatchClaim.Lost;
            Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id=$j AND state='charged'", ("$j", job.Id));
            var own = Jobs(c, t, "want_id=$w AND " + LiveJobs, ("$w", want.Id));
            var confirmed = Confirmed(c, t, title, want.TargetKey).ToList();
            if (own.Count == 0 && want.Input.Extra(confirmed) == null)
            {
                // Nothing of its own is left: it follows what went out, free (every charge of it given back).
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE want_id=$w AND state IN ('charged','held')", ("$w", want.Id));
                Exec(c, t, "UPDATE wants SET status='sent',reason='looking',is_follower=1,owned_input=NULL,cost=0,updated_at=$at WHERE id=$w", ("$at", Ms(now)), ("$w", want.Id));
            }
            else
            {
                var whole = want.Input.Extra(confirmed) == null;
                Exec(c, t, "UPDATE wants SET status=CASE WHEN $sent THEN 'sent' ELSE status END,reason=CASE WHEN $sent THEN 'looking' ELSE reason END,cost=(SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=wants.id AND state='charged'),updated_at=$at WHERE id=$w",
                    ("$sent", whole), ("$at", Ms(now)), ("$w", want.Id));
            }
            Record(c, t, want.Id, job.Id, null, "merged", "accepted", "looking", want.Input.Key, now);
            return DispatchClaim.Served;
        }
        // Only resumable uncertain retries can break a wait-for cycle. Ordinary unsent jobs, active sends and
        // read-backs cannot lead one: unsent duplicates still wait, sends finish, and read-backs are always claimed.
        private static bool LeadsRetryCycle(SqliteConnection c, SqliteTransaction t, RequestJob job, IReadOnlyList<RequestWant> title)
        {
            var work = title.SelectMany(w => Jobs(c, t, "want_id=$w", ("$w", w.Id))).ToList();
            var edges = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var candidate in work.Where(j => j.State == "retry" && j.Uncertain))
            {
                var target = TargetKey(candidate.Authorization);
                var others = work.Where(j => j.Id != candidate.Id && RequestDestination.Serves(candidate.Input, target, j.Input, TargetKey(j.Authorization))).ToList();
                var sent = others.Where(j => j.State == "succeeded").Select(j => j.Input).ToList();
                sent.AddRange(title.Select(w => (Want: w, Input: LinkedScope(c, t, w)))
                    .Where(x => x.Input != null && RequestDestination.Serves(candidate.Input, target, x.Input, x.Want.TargetKey)).Select(x => x.Input!));
                var going = others.Where(j => j.State is "sending" or "maybe_sent" || j.Uncertain && j.State != "cancelled").ToList();
                if (candidate.Input.Extra(sent) != null && candidate.Input.Extra(sent.Concat(going.Select(j => j.Input))) == null)
                    edges[candidate.Id] = going.Select(j => j.Id).ToList();
            }
            HashSet<string> Reach(string start, bool backwards)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal) { start };
                var pending = new Stack<string>();
                pending.Push(start);
                while (pending.Count > 0)
                {
                    var at = pending.Pop();
                    var next = backwards ? edges.Where(e => e.Value.Contains(at)).Select(e => e.Key)
                        : edges.TryGetValue(at, out var following) ? following : Enumerable.Empty<string>();
                    foreach (var id in next) if (seen.Add(id)) pending.Push(id);
                }
                return seen;
            }
            // Intersection of forward and reverse reachability is this job's strongly connected component.
            var cycle = Reach(job.Id, false);
            cycle.IntersectWith(Reach(job.Id, true));
            if (cycle.Count < 2) return false;
            // Persistent charge order survives equal timestamps and recovery; the job id resolves a remaining tie.
            long Charge(RequestJob j)
            {
                var value = Scalar(c, t, "SELECT MIN(charge_seq) FROM reservations WHERE want_id=$w AND (job_id=$j OR scope='initial') AND charge_seq>0", ("$w", j.WantId), ("$j", j.Id));
                return long.TryParse(value, out var sequence) ? sequence : long.MaxValue;
            }
            return work.Where(j => cycle.Contains(j.Id)).OrderBy(Charge).ThenBy(j => j.Id, StringComparer.Ordinal).First().Id == job.Id;
        }

        /// <summary>Commits a job outcome, its intent state, audit, event and notification together.</summary>
        public bool Complete(RequestJob job, long generation, RequestBackendResult result, DateTimeOffset now)
        {
            return _db.WriteIf(generation, (c, t) =>
            {
                var storedWant = Wants(c, t, "id=$id", ("$id", job.WantId)).SingleOrDefault();
                if (storedWant == null) return false;
                var deletedNotSent = Anonymous(c, t, storedWant.UserId) && result.VerifiedNotSent && !result.Confirmed && result.Outcome.Certainty is not (ArrActionStatus.Unknown or ArrActionStatus.Succeeded);
                // An uncertain result the backend can resume (part of the change is upstream) is retried through a fresh
                // send that reads before it writes; its Unknown certainty keeps it from being cancelled or refunded meanwhile.
                var state = result.Confirmed ? "succeeded" : result.Parked ? "parked" : result.Outcome.Certainty == ArrActionStatus.Unknown ? result.Retryable ? "retry" : "maybe_sent" : result.Retryable ? "retry" : "failed";
                if (deletedNotSent) state = "cancelled";
                var next = result.Retryable && result.RetryAfter is { } wait && wait > TimeSpan.Zero ? now + wait : now.AddSeconds(Math.Min(300, 5 * Math.Pow(2, Math.Min(job.Attempts, 6))));
                if (Exec(c, t, "UPDATE jobs SET state=$state,reason=$reason,outcome=$outcome,next_attempt=$next,updated_at=$at WHERE id=$id AND state='sending'", ("$state", state), ("$reason", result.Outcome.Reason), ("$outcome", JsonSerializer.Serialize(result.Outcome)), ("$next", Ms(next)), ("$at", Ms(now)), ("$id", job.Id)) == 0) return false;
                // The same wait again changes nothing anyone sees: no new audit row, notice or event.
                if (!deletedNotSent && RepeatsWait(job, result)) return true;
                // A wait only a person can end (no Seerr account linked yet) shows as held for them, while its job is still
                // checked again now and then and goes out by itself once it can.
                var held = state is "parked" or "failed" || (state == "retry" && HeldWaits.Contains(result.Outcome.Reason));
                Exec(c, t, "UPDATE wants SET status=$state,reason=$r,updated_at=$at WHERE id=$id AND target_key=$target", ("$state", result.Confirmed ? "sent" : held ? "pending" : "queued"), ("$r", result.Outcome.Reason), ("$at", Ms(now)), ("$id", job.WantId), ("$target", TargetKey(job.Authorization)));
                if (state is "parked" or "failed")
                    DemoteUncoveredFollowers(c, t, Wants(c, t, "id=$id", ("$id", job.WantId)).Single().AcquisitionId, TargetKey(job.Authorization), result.Outcome.Reason, now);
                if (result.Confirmed)
                {
                    var acquisition = Scalar(c, t, "SELECT acquisition_id FROM wants WHERE id=$id", ("$id", job.WantId));
                    var shared = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
                    // Succeeded jobs and scope Seerr was already processing when it moved (linked imports).
                    var confirmed = Confirmed(c, t, shared, TargetKey(job.Authorization)).ToArray();
                    // A mixed intent is sent only after every part, including shared scope, is confirmed.
                    var activeCoverage = Coverage(c, t, shared, TargetKey(job.Authorization)).ToArray();
                    shared = shared.Where(w => RequestDestination.SameTarget(w.TargetKey, TargetKey(job.Authorization))).ToList();
                    foreach (var incomplete in shared.Where(w => Active(w) && (w.Id == job.WantId || w.Status == "queued" || w.Reason == "removed") && w.Input.Extra(confirmed) != null))
                        Exec(c, t, "UPDATE wants SET status=$s,reason=$r WHERE id=$id", ("$s", incomplete.Input.Extra(activeCoverage) == null ? "queued" : "pending"),
                            ("$r", incomplete.Input.Extra(activeCoverage) == null ? "queued_outage" : "removed"), ("$id", incomplete.Id));
                    foreach (var follower in shared.Where(w => Active(w) && (w.Id == job.WantId || w.Status is "queued" or "pending") && w.Input.Extra(confirmed) == null))
                    {
                        Exec(c, t, "UPDATE wants SET status='sent',reason=$r,updated_at=$at WHERE id=$id", ("$r", result.Outcome.Reason), ("$at", Ms(now)), ("$id", follower.Id));
                        if (follower.Id != job.WantId)
                            Record(c, t, follower.Id, job.Id, job.Authorization.Approver ?? job.Authorization.Requester, "shared_dispatch", result.Outcome.Outcome, result.Outcome.Reason, job.Input.Key, now);
                    }
                }
                // A keep-getting request with a followed new season Seerr refused waits for an OK (which sends that season
                // again), whatever else of it went out meanwhile.
                if (result.Confirmed && HeldFollows(c, t, storedWant).FirstOrDefault() is { } heldFollow)
                    Exec(c, t, "UPDATE wants SET status='pending',reason=$r WHERE id=$id AND status='sent'", ("$r", heldFollow.Reason), ("$id", job.WantId));
                if (deletedNotSent)
                {
                    Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id=$j", ("$j", job.Id));
                    var remains = Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w AND (state IN ('sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty') IN ('Unknown','Succeeded')) LIMIT 1", ("$w", job.WantId)) != null;
                    Exec(c, t, "UPDATE wants SET status=$s,reason='removed',cost=(SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=wants.id AND state='charged') WHERE id=$w",
                        ("$s", remains ? "pending" : "cancelled"), ("$w", job.WantId));
                    WithdrawFollowers(c, t, storedWant.AcquisitionId, now);
                }
                Record(c, t, job.WantId, job.Id, job.Authorization.Approver ?? job.Authorization.Requester, "dispatch", result.Outcome.Outcome, result.Outcome.Reason, job.Input.Key, now);
                return true;
            }, false).Result;
        }
        /// <summary>
        /// Waits a person has to end (the asker has no Seerr account linked): the want shows as held (pending, with the
        /// reason) while its job is retried at the wait's own long interval, not parked.
        /// </summary>
        internal static readonly IReadOnlySet<string> HeldWaits = new HashSet<string>(StringComparer.Ordinal) { "seerr_user_unlinked" };
        /// <summary>
        /// True when <paramref name="result"/> is the same wait the job's last attempt ended in (a retry with its own wait
        /// and the same reason): the job's next check is moved on, and nothing else is recorded.
        /// </summary>
        internal static bool RepeatsWait(RequestJob job, RequestBackendResult result)
            => !result.Confirmed && result.Retryable && result.RetryAfter != null && result.Outcome.Reason == job.Reason;
        /// <summary>
        /// Seerr now links an account to <paramref name="user"/>: their requests waiting for one
        /// (<c>seerr_user_unlinked</c>) are checked at once instead of at their next long interval. The same jobs, so
        /// nothing is sent twice. Returns how many were woken.
        /// </summary>
        public int WakeUnlinked(Guid user, DateTimeOffset now) => !_db.Available ? 0 : _db.Write((c, t) =>
            Exec(c, t, "UPDATE jobs SET next_attempt=$at WHERE state='retry' AND reason='seerr_user_unlinked' AND next_attempt>$at AND json_extract(authorization_context,'$.Requester')=$guid",
                ("$at", Ms(now)), ("$guid", user.ToString())));
        /// <summary>Purges a deleted person's intent and all personal outbox contexts in one transaction.</summary>
        public void PurgeUser(Guid user)
        {
            // Their eligibility grant goes with them: inside the automation version's bracket.
            _db.WriteAutomation((c, t) => PurgeUser(c, t, user));
        }
        internal static int PurgeUser(SqliteConnection c, SqliteTransaction t, Guid user)
        {
            var id = Id(user);
            Changed(c, t);
            Exec(c, t, "INSERT OR IGNORE INTO request_deleted_users VALUES($u)", ("$u", MutationInput.Hash("deleted:" + id)));
            Exec(c, t, "UPDATE approvals SET actor_id=NULL WHERE actor_id=$u", ("$u", id));
            Exec(c, t, "UPDATE request_audit SET actor_id=NULL WHERE actor_id=$u", ("$u", id));
            Exec(c, t, "UPDATE import_batches SET actor_id=NULL WHERE actor_id=$u", ("$u", id));
            Exec(c, t, "DELETE FROM automation_log WHERE user_id=$u", ("$u", id));
            Exec(c, t, "DELETE FROM automation_decisions WHERE user_id=$u; DELETE FROM automation_grants WHERE user_id=$u; DELETE FROM request_operations WHERE user_id=$u", ("$u", id));
            // Revoke only known-unsent approvals. Preserve send certainty and anonymise every retained context.
            const string unsent = "json_extract(authorization_context,'$.Approver')=$guid AND state IN ('queued','retry') AND COALESCE(json_extract(outcome,'$.certainty'),'Rejected')<>'Unknown'";
            Exec(c, t, "UPDATE wants SET status='pending',reason='identity_changed' WHERE id IN (SELECT want_id FROM jobs WHERE " + unsent + ")", ("$guid", user.ToString()));
            Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id IN (SELECT id FROM jobs WHERE " + unsent + ")", ("$guid", user.ToString()));
            Exec(c, t, "UPDATE wants SET cost=(SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=wants.id AND state='charged') WHERE id IN (SELECT want_id FROM jobs WHERE " + unsent + ")", ("$guid", user.ToString()));
            Exec(c, t, "UPDATE jobs SET state='parked',reason='identity_changed' WHERE " + unsent, ("$guid", user.ToString()));
            Exec(c, t, "UPDATE jobs SET authorization_context=json_set(authorization_context,'$.Approver',NULL) WHERE json_extract(authorization_context,'$.Approver')=$guid", ("$guid", user.ToString()));
            var affected = Wants(c, t, "user_id=$u", ("$u", id)).Select(w => w.AcquisitionId).Distinct().ToArray();
            var anonymous = MutationInput.Hash("deleted:" + id)[..32].ToLowerInvariant();
            var retained = Wants(c, t, "user_id=$u", ("$u", id)).Where(w =>
                Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w AND (state IN ('sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown') LIMIT 1", ("$w", w.Id)) != null ||
                LinkedScope(c, t, w) != null ||
                Wants(c, t, "acquisition_id=$a AND id<>$w", ("$a", w.AcquisitionId), ("$w", w.Id)).Any(f => Active(f) && RequestDestination.SameTarget(f.TargetKey, w.TargetKey) && f.Input.Extra(new[] { w.Input })?.Fingerprint != f.Input.Fingerprint)).ToArray();
            foreach (var want in retained)
            {
                var linked = LinkedScope(c, t, want) != null;
                // As a withdrawal: every part proven unsent (held and refused parts included) is cancelled and refunded.
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id IN (SELECT id FROM jobs WHERE want_id=$w AND " + Unsent + ")", ("$w", want.Id));
                Exec(c, t, "UPDATE jobs SET state='cancelled',reason='identity_changed' WHERE want_id=$w AND " + Unsent, ("$w", want.Id));
                if (!linked && Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w AND (state IN ('sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown') LIMIT 1", ("$w", want.Id)) == null)
                    Exec(c, t, "UPDATE wants SET status='cancelled',reason='identity_changed' WHERE id=$w", ("$w", want.Id));
                Exec(c, t, "UPDATE wants SET user_id=$anon,client_request_id=id,fingerprint='',parental_signature='null',cost=(SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=wants.id AND state='charged') WHERE id=$w", ("$anon", anonymous), ("$w", want.Id));
                Exec(c, t, "UPDATE jobs SET authorization_context=json_set(authorization_context,'$.Requester',$anon,'$.SeerrPermissions',0) WHERE want_id=$w", ("$anon", Guid.Parse(anonymous).ToString()), ("$w", want.Id));
                Exec(c, t, "UPDATE reservations SET user_id=$anon WHERE want_id=$w", ("$anon", anonymous), ("$w", want.Id));
                Exec(c, t, "DELETE FROM request_inputs WHERE want_id=$w; DELETE FROM request_notices WHERE want_id=$w", ("$w", want.Id));
            }
            var count = Exec(c, t, "DELETE FROM wants WHERE user_id=$u", ("$u", id));
            foreach (var acquisition in affected) WithdrawFollowers(c, t, acquisition, DateTimeOffset.UtcNow);
            Exec(c, t, "DELETE FROM acquisitions WHERE id NOT IN (SELECT acquisition_id FROM wants)");
            return count;
        }
        /// <summary>Retention and stale marking; old completed intent is removed after a year.</summary>
        public void Retain(DateTimeOffset now, int staleDays) => _db.WriteAutomation((c, t) =>
        {
            Exec(c, t, "DELETE FROM request_events WHERE created_at<$at", ("$at", Ms(now.AddHours(-48))));
            Exec(c, t, "DELETE FROM request_notices WHERE created_at<$at", ("$at", Ms(now.AddDays(-90))));
            Exec(c, t, "DELETE FROM request_audit WHERE created_at<$at", ("$at", Ms(now.AddDays(-180))));
            Exec(c, t, "DELETE FROM automation_log WHERE created_at<$at", ("$at", Ms(now.AddDays(-90))));
            Exec(c, t, "DELETE FROM automation_decisions WHERE updated_at<$at", ("$at", Ms(now.AddDays(-90))));
            Exec(c, t, "DELETE FROM request_operations WHERE updated_at<$at", ("$at", Ms(now.AddDays(-90))));
            // Budget rows only count inside their 24-hour window; two days keeps the reset times readable.
            Exec(c, t, "DELETE FROM automation_budget WHERE reserved_at<$at", ("$at", Ms(now.AddDays(-2))));
            Exec(c, t, "DELETE FROM wants WHERE status IN ('fulfilled','cancelled','declined') AND updated_at<$at", ("$at", Ms(now.AddYears(-1))));
            // A 4K request nothing can take (no_4k_instance) says so; it never turns stale meanwhile.
            return Exec(c, t, "UPDATE wants SET status='stale',reason='stale' WHERE status='sent' AND reason<>'" + No4k + "' AND created_at<$at", ("$at", Ms(now.AddDays(-Math.Clamp(staleDays, 1, 365)))));
        });
        /// <summary>Lab-only durable send claim, with no transport. Restart recovery must read it back.</summary>
        public bool LabHold(string wantId, DateTimeOffset now) => _db.Write((c, t) =>
            Exec(c, t, "UPDATE jobs SET state='sending',reason='lab_hold',attempts=attempts+1,updated_at=$at WHERE want_id IN (SELECT id FROM wants WHERE id=$id AND client_request_id LIKE 'je-3a-cli-%') AND state IN ('queued','retry')", ("$id", wantId), ("$at", Ms(now))) == 1);

        /// <summary>Imports legacy action audit idempotently; request outcomes already belong to ledger transactions.</summary>
        public void ImportAudit(IEnumerable<ArrAuditEntry> entries) => _db.Write((c, t) =>
        {
            // Repair earlier JSONL imports, including orphan copies left after their jobs were deleted.
            var count = Exec(c, t, "DELETE FROM request_audit WHERE action LIKE 'request.%' AND want_id IS NULL AND job_id IS NULL");
            foreach (var entry in entries)
            {
                // Outbox mirrors are operational history; Complete already committed their linked ledger audit.
                if (entry.Action.StartsWith("request.", StringComparison.Ordinal)) continue;
                if (Guid.TryParse(entry.UserId, out var actor) && Deleted(c, t, actor)) continue;
                count += Exec(c, t, "INSERT OR IGNORE INTO request_audit VALUES($id,NULL,NULL,$actor,$action,$outcome,$r,$at)", ("$id", entry.Id), ("$actor", entry.UserId), ("$action", entry.Action), ("$outcome", entry.Outcome), ("$r", entry.Error ?? ""), ("$at", Ms(entry.Time)));
            }
            return count;
        });

        /// <summary>Lab-only removal by ids; refuses any row not created with the lab client prefix.</summary>
        public bool LabDelete(string id) => _db.Write((c, t) =>
        {
            var key = Scalar(c, t, "SELECT title_key FROM wants WHERE id=$id AND client_request_id LIKE 'je-3a-cli-%'", ("$id", id));
            if (key == null) return false;
            Changed(c, t);
            Exec(c, t, "DELETE FROM request_audit WHERE want_id=$id OR job_id IN (SELECT id FROM jobs WHERE want_id=$id) OR (want_id IS NULL AND job_id IS NULL AND action LIKE 'request.%' AND id IN (SELECT id FROM jobs WHERE want_id=$id))", ("$id", id));
            var removed = Exec(c, t, "DELETE FROM wants WHERE id=$id", ("$id", id));
            Exec(c, t, "DELETE FROM request_events WHERE " + TitleIs + " AND NOT EXISTS(SELECT 1 FROM wants WHERE " + TitleIs + ")", ("$key", key));
            Exec(c, t, "DELETE FROM acquisitions WHERE id NOT IN (SELECT acquisition_id FROM wants)");
            return removed == 1;
        });
    }
}
