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
        private static List<RequestWant> Wants(SqliteConnection c, SqliteTransaction? t, string where = "1=1", params (string, object?)[] args)
        {
            using var cmd = Cmd(c, t, "SELECT id,acquisition_id,user_id,client_request_id,fingerprint,mutation_input,status,reason,cost,parental_signature,created_at,updated_at,is_follower,owned_input,target_key,origin_kind FROM wants WHERE " + where + " ORDER BY created_at,id", args);
            using var r = cmd.ExecuteReader();
            var list = new List<RequestWant>();
            while (r.Read()) list.Add(new(r.GetString(0), r.GetString(1), Guid.Parse(r.GetString(2)), r.GetString(3), r.GetString(4),
                JsonSerializer.Deserialize<MutationInput>(r.GetString(5))!, r.GetString(6), r.GetString(7), r.GetInt32(8), r.GetString(9),
                DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(10)), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(11)), r.GetBoolean(12), r.IsDBNull(13) ? null : JsonSerializer.Deserialize<MutationInput>(r.GetString(13)), r.GetString(14), r.GetString(15)));
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
                    var targetsForWant = candidates.Where(j => j.Input.Variant == want.Input.Variant && (want.Input.InstanceId == null || j.Authorization.InstanceId == want.Input.InstanceId))
                        .Select(j => TargetKey(j.Authorization)).Distinct(StringComparer.Ordinal).ToArray();
                    if (targetsForWant.Length == 1)
                    {
                        Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", targetsForWant[0]), ("$id", want.Id));
                        var coveredScope = Jobs(c, t, "want_id IN (SELECT id FROM wants WHERE acquisition_id=$a AND status IN ('pending','queued','sent','stale')) AND " + LiveJobs, ("$a", want.AcquisitionId))
                            .Where(j => TargetKey(j.Authorization) == targetsForWant[0] && (want.Status is not ("sent" or "stale") || j.State == "succeeded")).Select(j => j.Input);
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
        public IReadOnlyList<RequestWant> List(Guid user, bool pending) => _db.Read(c => Wants(c, null,
            pending ? "status='pending'" : "user_id=$u", ("$u", Id(user))));
        /// <summary>Title intent for read models, with canonical provider identity.</summary>
        public IReadOnlyList<RequestWant> ForTitle(string key) => _db.Read(c => Wants(c, null, "title_key=$key", ("$key", key)));
        /// <summary>
        /// True when requests already sent to the caller's request target cover all of <paramref name="input"/>
        /// (succeeded jobs, or a request that was already processing in Seerr when it moved): nothing is left to
        /// ask for, so Search may run the arr's search for it again without a new request.
        /// </summary>
        public bool SentCovers(MutationInput input, RequestPolicyFacts facts) => _db.Available && _db.Read(c =>
        {
            var covered = Wants(c, null, "title_key=$key AND variant=$v", ("$key", input.Key), ("$v", input.Variant)).Where(Active).ToArray();
            // Any connection of the same instance (or Seerr) counts: a Search runs only for parts the instance already
            // monitors, so an address or key change since the send doesn't make them "never asked for".
            var destination = Destination(TargetKey(facts));
            return covered.Length > 0 && input.Extra(Confirmed(c, null, covered, target => Destination(target) == destination)) == null;
        });
        // A target key without its connection generation: the backend, the instance and the Seerr source.
        private static string Destination(string target)
        {
            try
            {
                var parts = JsonSerializer.Deserialize<string?[]>(target);
                if (parts is { Length: 4 }) return JsonSerializer.Serialize(new[] { parts[0], parts[1], parts[3] });
            }
            catch (JsonException)
            {
                // Not a target key: compared as it is.
            }
            return target;
        }
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
            using (var cmd = Cmd(c, null, "SELECT j.mutation_input,j.authorization_context,j.updated_at FROM jobs j JOIN wants w ON w.id=j.want_id WHERE w.title_key=$key AND j.state='succeeded'", ("$key", titleKey)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read())
                    list.Add(new(TargetKey(JsonSerializer.Deserialize<RequestAuthorization>(r.GetString(1))!), JsonSerializer.Deserialize<MutationInput>(r.GetString(0))!, DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(2))));
            }
            foreach (var want in Wants(c, null, "title_key=$key AND origin_kind=$kind", ("$key", titleKey), ("$kind", RequestOrigin.SeerrImportKind)))
            {
                if (LinkedScope(c, null, want) is { } linked) list.Add(new(want.TargetKey, linked, want.CreatedAt));
            }
            return (IReadOnlyList<RequestDispatch>)list;
        });
        /// <summary>Persistent policy/cache invalidation stamp, fenced by restore generation.</summary>
        public long Revision => !_db.Available ? 0 : _db.Read(c => long.Parse(Scalar(c, null, "SELECT COALESCE((SELECT value FROM meta WHERE key='request_revision'),'0')")!, CultureInfo.InvariantCulture)) + _db.Generation * 1000000000;
        private static void Changed(SqliteConnection c, SqliteTransaction t) => Exec(c, t, "INSERT INTO meta VALUES('request_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");
        internal static bool HasRouting(MutationInput input) => input.InstanceId != null || input.ProfileId != null || input.RootFolder != null;
        internal static bool RoutingChanged(MutationInput input, MutationInput original)
            => input.InstanceId != original.InstanceId || input.ProfileId != original.ProfileId || input.RootFolder != original.RootFolder;
        internal static string TargetKey(RequestAuthorization auth)
            => JsonSerializer.Serialize(new[] { auth.Backend, auth.InstanceId, auth.ConnectionGeneration, auth.SeerrSource });
        /// <summary>
        /// The target a Seerr-mode ask goes to while Jellyfin Enhanced points at the Seerr <paramref name="source"/>
        /// (<see cref="SeerrRequestReadModel.SourceOf"/>): Seerr picks its own server, so no instance or connection.
        /// </summary>
        internal static string SeerrTargetKey(string? source)
            => TargetKey(new RequestAuthorization(Guid.Empty, null, string.Empty, string.Empty, string.Empty, "seerr", string.Empty, string.Empty, string.Empty, source));
        /// <summary>The backend target an ask with these facts goes to (its backend, instance, connection and Seerr source).</summary>
        internal static string TargetKey(RequestPolicyFacts facts) => TargetKey(Authorize(facts, null, new MutationInput(), false));
        private static bool Active(RequestWant w) => w.Status is "pending" or "queued" or "sent" or "stale";
        private static bool Deleted(SqliteConnection c, SqliteTransaction t, Guid user)
            => Scalar(c, t, "SELECT user_hash FROM request_deleted_users WHERE user_hash=$u", ("$u", MutationInput.Hash("deleted:" + Id(user)))) != null;
        private const string LiveJobs = "(state IN ('queued','retry','sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown')";
        private const string KnownUnsent = "COALESCE(json_extract(outcome,'$.certainty'),'Rejected') NOT IN ('Unknown','Succeeded')";
        private static bool Anonymous(SqliteConnection c, SqliteTransaction t, Guid user)
            => Scalar(c, t, "SELECT user_hash FROM request_deleted_users WHERE lower(substr(user_hash,1,32))=$u", ("$u", Id(user))) != null;
        private static void Supersede(SqliteConnection c, SqliteTransaction t, string job, string reason)
        {
            // A followed new season's charge (scope "s<n>") is charged once and stays, as in Jellyfin Enhanced mode.
            if (Exec(c, t, "UPDATE jobs SET state='cancelled',reason=$r WHERE id=$j AND state IN ('queued','retry','parked') AND " + KnownUnsent, ("$j", job), ("$r", reason)) == 1)
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id=$j AND scope NOT LIKE 's%'", ("$j", job));
        }
        private static List<QuotaCharge> Charges(SqliteConnection c, SqliteTransaction? t, Guid user, bool unsentOnly = false)
        {
            using var cmd = Cmd(c, t, "SELECT cost,charged_at,estimated_gb,want_id FROM reservations WHERE user_id=$u AND state='charged'" + (unsentOnly ? " AND want_id IN (SELECT id FROM wants WHERE status IN ('queued','pending')) AND (job_id IS NULL OR job_id NOT IN (SELECT id FROM jobs WHERE state='succeeded'))" : ""), ("$u", Id(user)));
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
            => facts.Role == "Member" && !TitleKey.Parse(input.Key)!.IsMovie && own.Where(w => w.Input.Key == input.Key && w.Status is not ("declined" or "cancelled"))
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
        // An estimate, never a claim about actual disk usage; backend enrichment can replace it in 3b.
        private static double EstimateGb(MutationInput input) => input.Variant == "4k" ? input.Scope == "movie" ? 40 : input.Scope == "episodes" ? input.Episodes.Length * 4 : input.Seasons.Length * 40
            : input.Scope == "movie" ? 8 : input.Scope == "episodes" ? input.Episodes.Length : input.Seasons.Length * 10;
        /// <summary>Re-evaluates approval requirements for an automatic job under the current household rules.</summary>
        public bool NeedsApprovalAtSend(RequestJob job, RequestPolicyFacts requester, IRequestPolicy policy, DateTimeOffset now)
        {
            if (job.Authorization.Approver.HasValue) return false;
            if (requester.Role == "Kid") return true;
            if (requester.Role != "Member" || requester.Backend != "je") return false;
            if (policy.Configuration.ArrRequestPreset == "approve_everything") return true;
            return _db.Read(c =>
            {
                var want = Wants(c, null, "id=$id", ("$id", job.WantId)).SingleOrDefault();
                if (want == null) return true;
                var own = Wants(c, null, "user_id=$u", ("$u", Id(requester.UserId))).Where(w => w.Id != want.Id && w.CreatedAt <= want.CreatedAt && w.Status != "pending").ToArray();
                return OverQuota(requester, Charges(c, null, requester.UserId), 0, 0, now) ||
                    OverSeries(requester, want.Input, own, policy.Configuration.ArrRequestSeriesThreshold);
            });
        }

        /// <summary>Creates intent, quota reservation and (when approved) a job in one commit.</summary>
        /// <param name="user">The requester.</param>
        /// <param name="request">Client id and confirmed input.</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Commit time.</param>
        /// <param name="origin">Where the intent came from; automation never self-approves a Member in JE mode.</param>
        public RequestOutcome Create(Guid user, CreateRequest request, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin = null)
        {
            var normalized = request.Input?.Normalize();
            if (normalized == null || string.IsNullOrWhiteSpace(request.ClientRequestId) || request.ClientRequestId.Length > 128 || request.ClientRequestId.Any(char.IsControl)) return RequestOutcome.Refused("invalid_input", 400);
            return _db.Write((c, t) =>
            {
                // Matching asks may approve existing wants; a later refusal must undo those approvals too.
                Exec(c, t, "SAVEPOINT request_create");
                var outcome = CreateCore(c, t, user, request, normalized, policy, now, origin);
                if (outcome.HttpStatus >= 400) Exec(c, t, "ROLLBACK TO request_create");
                Exec(c, t, "RELEASE request_create");
                return outcome;
            });
        }
        private RequestOutcome CreateCore(SqliteConnection c, SqliteTransaction t, Guid user, CreateRequest request, MutationInput normalized, IRequestPolicy policy, DateTimeOffset now, RequestOrigin? origin)
        {
            var automation = origin?.Kind == RequestOrigin.AutomationKind;
            if (Deleted(c, t, user)) return RequestOutcome.Refused("user_required");
            var priorHash = Scalar(c, t, "SELECT fingerprint FROM request_inputs WHERE user_id=$u AND client_request_id=$k", ("$u", Id(user)), ("$k", request.ClientRequestId));
            if (priorHash != null && priorHash != normalized.Fingerprint) return RequestOutcome.Refused("idempotency_conflict", 409);
            if (priorHash != null)
            {
                var existingId = Scalar(c, t, "SELECT want_id FROM request_inputs WHERE user_id=$u AND client_request_id=$k", ("$u", Id(user)), ("$k", request.ClientRequestId))!;
                var existing = Wants(c, t, "id=$id", ("$id", existingId)).Single();
                // A retry of an ask that was split answers as the split did.
                if (Wants(c, t, "user_id=$u AND client_request_id=$k", ("$u", Id(user)), ("$k", request.ClientRequestId + SplitHeldSuffix)).SingleOrDefault() is { } heldPart)
                    return Split(RequestOutcome.Accepted(existing.Id, existing.Reason, 200), heldPart.Id, heldPart.Input.SeasonNumbers.OrderBy(n => n).ToArray());
                return RequestOutcome.Accepted(existing.Id, existing.Reason, 200);
            }
            if (!policy.IsAdmin(user) && HasRouting(normalized)) return RequestOutcome.Refused("admin_required");
            var facts = policy.Evaluate(user, normalized);
            if (RequestPolicy.Check(facts, null, normalized, false) is { } refusal) return RequestOutcome.Refused(refusal, RequestPolicy.RefusalStatus(refusal), outcome: refusal is "not_visible_to_user" or "low_disk" ? "blocked" : "denied");
            if (SeerrEpisodes(facts, normalized) is { } seerrOnly) return seerrOnly;
            if (facts.Role != "Admin" && (normalized.InstanceId != null || normalized.ProfileId != null || normalized.RootFolder != null)) return RequestOutcome.Refused("admin_required");
            // An approver's matching ask authorises the shared pending scope, without moving its charge.
            // Automation never approves someone else's pending ask on a person's behalf.
            if (!automation && facts.CanApprove && facts.Role is "Manager" or "Admin")
            {
                foreach (var pending in Wants(c, t, "title_key=$key AND variant=$v AND status='pending'", ("$key", normalized.Key), ("$v", normalized.Variant))
                    .Where(w => !w.Follower && w.TargetKey == TargetKey(facts) && w.Input.Extra(new[] { normalized }) == null))
                {
                    var approved = ApproveCore(c, t, pending.Id, user, null, policy, now);
                    if (approved.HttpStatus != 200) continue;
                }
            }
            var own = Wants(c, t, "user_id=$u", ("$u", Id(user)));
            var ownSame = own.Where(w => Active(w) && w.TargetKey == TargetKey(facts) && w.Input.Key == normalized.Key && w.Input.Variant == normalized.Variant).ToArray();
            // One of the person's own asks covers it, or several together do (an ask split at the series threshold).
            var sameOwn = ownSame.FirstOrDefault(w => normalized.Extra(new[] { w.Input }) == null)
                ?? (ownSame.Length > 1 && normalized.Extra(ownSame.Select(w => w.Input)) == null ? ownSame.First(w => w.Input.Overlaps(normalized)) : null);
            if (sameOwn != null)
            {
                RememberInput(c, t, user, request.ClientRequestId, normalized.Fingerprint, sameOwn.Id);
                return RequestOutcome.Accepted(sameOwn.Id, sameOwn.Reason, 200) with { Message = "Your request is already recorded." };
            }
            if (own.Count(w => w.Status == "pending") >= Math.Clamp(policy.Configuration.ArrRequestPendingLimit, 1, 100)) return RequestOutcome.Refused("pending_limit", 429, "quota_exceeded");
            if (own.Any(w => w.Status == "declined" && w.Input.Key == normalized.Key && w.Input.Variant == normalized.Variant &&
                normalized.Extra(new[] { w.Input }) == null && w.UpdatedAt > now.AddDays(-Math.Clamp(policy.Configuration.ArrRequestDeclineCooldownDays, 0, 365)))) return RequestOutcome.Refused("decline_cooldown", outcome: "blocked");
            var covered = Wants(c, t, "title_key=$key AND variant=$v", ("$key", normalized.Key), ("$v", normalized.Variant)).Where(Active).ToArray();
            var authorizedExtra = normalized.Extra(Coverage(c, t, covered, TargetKey(facts)));
            var auto = facts.Role is "Manager" or "Admin" || (facts.Role == "Member" && facts.Backend == "je" && !automation &&
                policy.Configuration.ArrRequestPreset != "approve_everything" &&
                !OverQuota(facts, Charges(c, t, user), authorizedExtra == null ? 0 : Cost(c, t, authorizedExtra, user, now, facts.WindowDays), authorizedExtra == null ? 0 : EstimateGb(authorizedExtra), now) &&
                !OverSeries(facts, normalized, own, policy.Configuration.ArrRequestSeriesThreshold));
            if (!auto && !automation && SplitAtThreshold(c, t, user, request, normalized, facts, own, policy, now, origin) is { } split) return split;
            var extra = normalized.Extra(Coverage(c, t, covered, TargetKey(facts), !auto));
            if (auto && (extra != null || covered.Any(w => w.Status == "pending")) && Scalar(c, t,
                "SELECT j.id FROM jobs j JOIN wants w ON w.id=j.want_id WHERE w.title_key=$key AND w.variant=$v AND json_extract(j.authorization_context,'$.Backend')=$backend AND json_extract(j.authorization_context,'$.InstanceId')=$instance AND json_extract(j.authorization_context,'$.ConnectionGeneration')=$generation AND json_extract(j.authorization_context,'$.SeerrSource') IS $source AND (j.state IN ('sending','maybe_sent') OR json_extract(j.outcome,'$.certainty')='Unknown') LIMIT 1",
                ("$key", normalized.Key), ("$v", normalized.Variant), ("$backend", facts.Backend), ("$instance", facts.InstanceId), ("$generation", facts.ConnectionGeneration), ("$source", facts.SeerrSource)) != null) return RequestOutcome.Refused("request_in_flight", 409);
            var cost = extra == null ? 0 : Cost(c, t, extra, user, now, facts.WindowDays);
            var gb = extra == null ? 0 : EstimateGb(extra);
            if (OverGbCap(facts, Charges(c, t, user), gb, now)) return RequestOutcome.Refused("quota_exceeded", 429, "quota_exceeded");
            var over = OverQuota(facts, Charges(c, t, user, facts.Backend == "seerr"), cost, gb, now);
            var needsApproval = extra != null && (facts.Role == "Kid" || (facts.Backend == "je" && facts.Role == "Member" && (automation || policy.Configuration.ArrRequestPreset == "approve_everything" || over || OverSeries(facts, normalized, own, policy.Configuration.ArrRequestSeriesThreshold))));
            if (over && facts.Backend == "seerr") return RequestOutcome.Refused("over_quota", 429, "quota_exceeded");
            var confirmedScope = extra == null && ConfirmedScope(c, t, normalized, covered, facts);
            var waitingScope = extra == null && normalized.Extra(Coverage(c, t, covered, TargetKey(facts))) != null;
            var status = confirmedScope ? "sent" : needsApproval || waitingScope ? "pending" : "queued";
            var reason = confirmedScope ? "looking" : status == "pending" ? over ? "over_quota" : "awaiting_approval" : "queued_outage";
            var acquisition = Scalar(c, t, "SELECT id FROM acquisitions WHERE title_key=$key AND variant=$v AND state='active'", ("$key", normalized.Key), ("$v", normalized.Variant));
            if (acquisition == null)
            {
                acquisition = NewId();
                Exec(c, t, "INSERT INTO acquisitions VALUES($id,$key,$v,'active',$at)", ("$id", acquisition), ("$key", normalized.Key), ("$v", normalized.Variant), ("$at", Ms(now)));
            }
            var id = NewId();
            var stored = normalized;
            Exec(c, t, "INSERT INTO wants(id,acquisition_id,user_id,client_request_id,fingerprint,title_key,variant,mutation_input,owned_input,status,reason,cost,parental_signature,is_follower,created_at,updated_at) VALUES($id,$a,$u,$client,$f,$key,$v,$input,$owned,$status,$r,$cost,$p,$follower,$at,$at)",
                ("$id", id), ("$a", acquisition), ("$u", Id(user)), ("$client", request.ClientRequestId), ("$f", normalized.Fingerprint), ("$key", stored.Key), ("$v", stored.Variant), ("$input", stored.Canonical), ("$owned", extra?.Canonical), ("$status", status), ("$r", reason), ("$cost", cost), ("$p", facts.ParentalSignature), ("$follower", extra == null), ("$at", Ms(now)));
            Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", TargetKey(facts)), ("$id", id));
            if (origin != null)
                Exec(c, t, "UPDATE wants SET origin_kind=$kind,origin_source_id=$source WHERE id=$id", ("$kind", origin.Kind), ("$source", origin.Source), ("$id", id));
            RememberInput(c, t, user, request.ClientRequestId, normalized.Fingerprint, id);
            Fault?.Invoke("want");
            Reserve(c, t, id, user, cost, gb, status == "pending" ? "held" : "charged", now, "initial");
            Fault?.Invoke("reservation");
            if (extra != null && status == "queued") AddJob(c, t, id, extra!, Authorize(facts, null, extra!, false), now);
            Fault?.Invoke("job");
            if (status == "queued" && extra != null && auto) ReleasePendingFollowers(c, t, acquisition, user, policy, now, false);
            Record(c, t, id, null, user, "create", "accepted", reason, stored.Key, now);
            Fault?.Invoke("notice");
            if (confirmedScope)
                return RequestOutcome.Accepted(id, reason, 200) with { Outcome = "merged", Message = "Someone in your household already asked, we'll tell you both." };
            return RequestOutcome.Accepted(id, reason);
        }
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
            if (facts.Role != "Member" || facts.Backend != "je" || policy.Configuration.ArrRequestPreset == "approve_everything" ||
                normalized.Scope is not ("seasons" or "episodes") || !OverSeries(facts, normalized, own, threshold)) return null;
            var asked = own.Where(w => w.Input.Key == normalized.Key && w.Status is not ("declined" or "cancelled")).SelectMany(w => w.Input.SeasonNumbers).ToHashSet();
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
            RememberInput(c, t, user, request.ClientRequestId, normalized.Fingerprint, queued.RequestId!);
            return Split(queued, waiting.RequestId!, held);
        }
        /// <summary>The client id suffix of the part of a split ask that waits for an OK.</summary>
        private const string SplitHeldSuffix = "|ok";
        private static RequestOutcome Split(RequestOutcome queued, string heldId, int[] heldSeasons)
            => queued with { Outcome = "split", HeldRequestId = heldId, HeldSeasons = heldSeasons, Message = "Asked! The rest waits for an OK." };
        private static IEnumerable<MutationInput> Coverage(SqliteConnection c, SqliteTransaction t, IEnumerable<RequestWant> wants, string target, bool includePending = false)
        {
            foreach (var want in wants.Where(w => Active(w) && w.TargetKey == target))
            {
                var jobs = Jobs(c, t, "want_id=$id AND (state IN ('queued','retry','sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown')", ("$id", want.Id));
                foreach (var job in jobs.Where(j => TargetKey(j.Authorization) == target)) yield return job.Input;
                if (includePending && want.Status == "pending" && jobs.Count == 0 && want.OwnedInput != null) yield return want.OwnedInput;
                if (LinkedScope(c, t, want) is { } linked) yield return linked;
            }
        }
        // Scope already sent to the target: succeeded jobs, and requests that were already processing in Seerr
        // when they moved (Seerr sent them; JE never sends them again).
        private static IEnumerable<MutationInput> Confirmed(SqliteConnection c, SqliteTransaction? t, IEnumerable<RequestWant> wants, string target)
            => Confirmed(c, t, wants, key => key == target);
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
        private static void Reserve(SqliteConnection c, SqliteTransaction t, string id, Guid user, int cost, double gb, string state, DateTimeOffset now, string scope)
            => Exec(c, t, "INSERT INTO reservations(id,want_id,user_id,cost,estimated_gb,state,charged_at,scope,episode_count) VALUES($id,$w,$u,$cost,$gb,$state,$at,$scope,COALESCE((SELECT CASE WHEN json_extract(owned_input,'$.Scope')='episodes' THEN json_array_length(owned_input,'$.Episodes') ELSE 0 END FROM wants WHERE id=$w AND $scope='initial'),0))", ("$id", NewId()), ("$w", id), ("$u", Id(user)), ("$cost", cost), ("$gb", gb), ("$state", state), ("$at", Ms(now)), ("$scope", scope));
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
        // linkReservation: the job carries the want's latest unlinked ask or approval charge (a followed new season's
        // charge, scope "s<n>", goes with that season's own job instead: see FollowJob).
        private static string AddJob(SqliteConnection c, SqliteTransaction t, string wantId, MutationInput input, RequestAuthorization auth, DateTimeOffset now, bool linkReservation = true)
        {
            var id = NewId();
            Exec(c, t, "INSERT INTO jobs(id,want_id,action,instance_id,connection_generation,mutation_input,idempotency_key,fingerprint,authorization_context,state,next_attempt,reason,created_at,updated_at) VALUES($id,$w,'request',$instance,$generation,$input,$key,$f,$auth,'queued',$at,'queued_outage',$at,$at)",
                ("$id", id), ("$w", wantId), ("$instance", auth.InstanceId), ("$generation", auth.ConnectionGeneration), ("$input", input.Canonical), ("$key", "request:" + id), ("$f", input.Fingerprint), ("$auth", JsonSerializer.Serialize(auth)), ("$at", Ms(now)));
            if (linkReservation)
                Exec(c, t, "UPDATE reservations SET job_id=$job WHERE id=(SELECT id FROM reservations WHERE want_id=$w AND state='charged' AND job_id IS NULL AND (scope='initial' OR scope LIKE 'approval:%') ORDER BY rowid DESC LIMIT 1)", ("$job", id), ("$w", wantId));
            return id;
        }
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
        private RequestOutcome ApproveCore(SqliteConnection c, SqliteTransaction t, string id, Guid actor, MutationInput? edits, IRequestPolicy policy, DateTimeOffset now, bool resumeHeld = false)
        {
            var want = Wants(c, t, "id=$id", ("$id", id)).SingleOrDefault();
            if (want == null) return RequestOutcome.Refused("not_found", 404);
            if (Deleted(c, t, actor) || Deleted(c, t, want.UserId)) return RequestOutcome.Refused("user_required");
            var input = edits?.Normalize() ?? want.Input;
            if (edits != null && (edits.Normalize() == null || input.Key != want.Input.Key)) return RequestOutcome.Refused("invalid_input", 400);
            if (!policy.IsAdmin(actor) && RoutingChanged(input, want.Input)) return RequestOutcome.Refused("admin_required");
            var requester = policy.Evaluate(want.UserId, input);
            var approver = policy.Evaluate(actor, input);
            if (RequestPolicy.Check(requester, approver, input, true) is { } refusal) return RequestOutcome.Refused(refusal, RequestPolicy.RefusalStatus(refusal), outcome: "blocked");
            if (SeerrEpisodes(requester, input) is { } seerrOnly) return seerrOnly;
            if (approver.Role != "Admin" && (input.InstanceId != want.Input.InstanceId || input.ProfileId != want.Input.ProfileId || input.RootFolder != want.Input.RootFolder)) return RequestOutcome.Refused("admin_required");
            if (want.Status != "pending") return RequestOutcome.Refused("request_changed", 409);
            // A job held after part of it was written (parked, certainty unknown) isn't in flight: approving resumes it.
            if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$id AND (state IN ('sending','maybe_sent') OR (state<>'parked' AND json_extract(outcome,'$.certainty')='Unknown')) LIMIT 1", ("$id", id)) != null) return RequestOutcome.Refused("request_in_flight", 409);
            var held = Jobs(c, t, "want_id=$id AND state='parked' AND json_extract(outcome,'$.certainty')='Unknown'", ("$id", id));
            var targetChanged = TargetKey(requester) != want.TargetKey;
            // The written part stays where it went: such a request resumes as it was, never edited or moved elsewhere.
            if (held.Count > 0 && (!resumeHeld || targetChanged || held.Any(j => TargetKey(j.Authorization) != TargetKey(requester)) || (edits != null && input.Fingerprint != want.Input.Fingerprint)))
                return RequestOutcome.Refused("request_in_flight", 409);
            if (targetChanged)
                foreach (var old in Jobs(c, t, "want_id=$id AND state IN ('queued','retry') AND " + KnownUnsent, ("$id", id)).Where(j => TargetKey(j.Authorization) != TargetKey(requester)))
                    Supersede(c, t, old.Id, "instance_changed");
            if (edits != null && input.Fingerprint != want.Input.Fingerprint)
            {
                var succeeded = Jobs(c, t, "want_id=$id AND state='succeeded'", ("$id", id));
                if (succeeded.Any(j => TargetKey(j.Authorization) != TargetKey(requester) || RoutingChanged(input, want.Input) || j.Input.Extra(new[] { input }) != null))
                    return RequestOutcome.Refused("request_changed", 409);
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id IN (SELECT id FROM jobs WHERE want_id=$id AND state IN ('queued','retry'))", ("$id", id));
                Exec(c, t, "UPDATE jobs SET state='cancelled',reason='request_changed' WHERE want_id=$id AND state IN ('queued','retry')", ("$id", id));
            }
            // A "keep getting new episodes" request held while a new season it follows was being sent (over Seerr's quota,
            // say): approving sends that season again, with this approval's authority (its charge stays as it was).
            var followed = edits == null && !targetChanged
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
                Exec(c, t, "UPDATE jobs SET state='maybe_sent',reason='maybe_sent',next_attempt=$at,authorization_context=$auth,updated_at=$at WHERE id=$j",
                    ("$auth", JsonSerializer.Serialize(Authorize(requester, approver, resume.Input, edits != null) with { SeerrUser = resume.Authorization.SeerrUser ?? requester.SeerrUser, SeerrSeasons = resume.Authorization.SeerrSeasons })), ("$at", Ms(now)), ("$j", resume.Id));
            var own = Wants(c, t, "user_id=$u AND id<>$id", ("$u", Id(want.UserId)), ("$id", id));
            var covered = Wants(c, t, "title_key=$key AND variant=$v AND id<>$id", ("$key", input.Key), ("$v", input.Variant), ("$id", id)).Where(w => Active(w) && w.Status != "pending").ToArray();
            // (maybe_sent here: only the held jobs resumed above.)
            var existingJobs = Jobs(c, t, "want_id=$id AND state IN ('queued','retry','succeeded','maybe_sent')", ("$id", id));
            var extra = input.Extra(Coverage(c, t, covered, TargetKey(requester)).Concat(existingJobs.Where(j => TargetKey(j.Authorization) == TargetKey(requester)).Select(j => j.Input)));
            var cost = extra == null ? 0 : Cost(c, t, extra, want.UserId, now, requester.WindowDays, existingJobs.Count == 0 ? id : null);
            var gb = extra == null ? 0 : EstimateGb(extra);
            if (OverGbCap(requester, Charges(c, t, want.UserId).Where(charge => existingJobs.Count > 0 || charge.WantId != id).ToArray(), gb, now)) return RequestOutcome.Refused("quota_exceeded", 429, "quota_exceeded");
            // Explicit approval grants soft quota/series excess, while hard limits and visibility remain enforced.
            if (requester.Backend == "seerr" && OverQuota(requester, Charges(c, t, want.UserId, requester.Backend == "seerr"), cost, gb, now)) return RequestOutcome.Refused("over_quota", 429, "quota_exceeded");
            var confirmedScope = extra == null && followed.Length == 0 && ConfirmedScope(c, t, input, covered.Append(want).ToArray(), requester);
            var stored = input;
            var priorCost = existingJobs.Count == 0 ? 0 : int.Parse(Scalar(c, t, "SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id=$id AND state='charged'", ("$id", id))!, CultureInfo.InvariantCulture);
            var acquisition = want.AcquisitionId;
            if (input.Variant != want.Input.Variant)
            {
                acquisition = Scalar(c, t, "SELECT id FROM acquisitions WHERE title_key=$key AND variant=$v AND state='active'", ("$key", input.Key), ("$v", input.Variant)) ?? NewId();
                Exec(c, t, "INSERT OR IGNORE INTO acquisitions VALUES($id,$key,$v,'active',$at)", ("$id", acquisition), ("$key", input.Key), ("$v", input.Variant), ("$at", Ms(now)));
            }
            Exec(c, t, "UPDATE wants SET acquisition_id=$a,mutation_input=$input,owned_input=$owned,variant=$v,status=$state,reason=$reason,cost=$cost,is_follower=$follower,parental_signature=$p,updated_at=$at WHERE id=$id",
                ("$a", acquisition), ("$input", stored.Canonical), ("$owned", extra?.Canonical), ("$v", stored.Variant), ("$state", confirmedScope ? "sent" : "queued"), ("$reason", confirmedScope ? "looking" : "queued_outage"), ("$cost", priorCost + cost), ("$p", requester.ParentalSignature), ("$follower", extra == null && existingJobs.Count == 0), ("$at", Ms(now)), ("$id", id));
            Exec(c, t, "UPDATE wants SET target_key=$target WHERE id=$id", ("$target", TargetKey(requester)), ("$id", id));
            if (existingJobs.Count == 0)
                Exec(c, t, "UPDATE reservations SET job_id=NULL,state='charged',cost=$cost,estimated_gb=$gb,charged_at=$at,episode_count=COALESCE((SELECT CASE WHEN json_extract(owned_input,'$.Scope')='episodes' THEN json_array_length(owned_input,'$.Episodes') ELSE 0 END FROM wants WHERE id=$id),0) WHERE want_id=$id AND scope='initial'", ("$cost", cost), ("$gb", gb), ("$at", Ms(now)), ("$id", id));
            else if (extra != null)
                Exec(c, t, "INSERT INTO reservations(id,want_id,user_id,cost,estimated_gb,state,charged_at,scope,episode_count) VALUES($rid,$id,$u,$cost,$gb,'charged',$at,$scope,$episodes)",
                    ("$rid", NewId()), ("$id", id), ("$u", Id(want.UserId)), ("$cost", cost), ("$gb", gb), ("$at", Ms(now)), ("$scope", "approval:" + NewId()), ("$episodes", extra.Scope == "episodes" ? extra.Episodes.Length : 0));
            Fault?.Invoke("reservation");
            var auth = Authorize(requester, approver, extra ?? stored, edits != null);
            if (extra != null) AddJob(c, t, id, extra, auth, now);
            foreach (var season in followed) FollowJob(c, t, id, season, Authorize(requester, approver, season, false), now);
            Approval(c, t, want, actor, "approve", null, edits, auth, now);
            Record(c, t, id, null, actor, "approve", "accepted", "queued_outage", stored.Key, now);
            if (edits != null && input.Fingerprint != want.Input.Fingerprint)
            {
                WithdrawFollowers(c, t, want.AcquisitionId, now);
                if (acquisition != want.AcquisitionId) WithdrawFollowers(c, t, acquisition, now);
            }
            if (targetChanged) RehomeFollowers(c, t, want.AcquisitionId, acquisition, want.TargetKey, TargetKey(requester), actor, policy, now);
            ReleasePendingFollowers(c, t, acquisition, actor, policy, now);
            return RequestOutcome.Accepted(id, confirmedScope ? "looking" : "queued_outage", 200);
        }
        private static void RehomeFollowers(SqliteConnection c, SqliteTransaction t, string oldAcquisition, string acquisition, string oldTarget, string target, Guid actor, IRequestPolicy policy, DateTimeOffset now)
        {
            var oldWants = Wants(c, t, "acquisition_id=$a", ("$a", oldAcquisition));
            var oldCoverage = Coverage(c, t, oldWants, oldTarget).ToArray();
            var newCoverage = Coverage(c, t, Wants(c, t, "acquisition_id=$a", ("$a", acquisition)), target).ToArray();
            foreach (var follower in oldWants.Where(w => w.Follower && w.TargetKey == oldTarget && w.Status is "queued" or "pending" && w.Input.Extra(oldCoverage) != null))
            {
                if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w LIMIT 1", ("$w", follower.Id)) != null) continue;
                var facts = policy.Evaluate(follower.UserId, follower.Input);
                var migrate = TargetKey(facts) == target && RequestPolicy.Check(facts, policy.Evaluate(actor, follower.Input), follower.Input, true) == null;
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
            foreach (var want in wants.Where(w => w.TargetKey == target && w.Status == "queued" && w.Input.Extra(Coverage(c, t, wants, w.TargetKey)) != null))
            {
                Exec(c, t, "UPDATE wants SET status='pending',reason=$r,updated_at=$at WHERE id=$w", ("$r", reason), ("$at", Ms(now)), ("$w", want.Id));
                Record(c, t, want.Id, null, null, "scope_held", "accepted", reason, want.Input.Key, now);
            }
        }
        private static void ReleasePendingFollowers(SqliteConnection c, SqliteTransaction t, string acquisition, Guid actor, IRequestPolicy policy, DateTimeOffset now, bool approving = true)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
            foreach (var follower in wants.Where(w => w.Status == "pending"))
            {
                if (follower.Input.Extra(Coverage(c, t, wants, follower.TargetKey)) != null) continue;
                if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$id LIMIT 1", ("$id", follower.Id)) != null) continue;
                if (RequestPolicy.Check(policy.Evaluate(follower.UserId, follower.Input), approving ? policy.Evaluate(actor, follower.Input) : null, follower.Input, approving) != null) continue;
                // Scope that is already sent has no job left to complete, so the follower is sent now too.
                var sent = follower.Input.Extra(Confirmed(c, t, wants, follower.TargetKey)) == null;
                Exec(c, t, "UPDATE wants SET status=$s,reason=$r,owned_input=NULL,is_follower=1,cost=0,updated_at=$at WHERE id=$id",
                    ("$s", sent ? "sent" : "queued"), ("$r", sent ? "looking" : "queued_outage"), ("$at", Ms(now)), ("$id", follower.Id));
                Exec(c, t, "UPDATE reservations SET state='charged',cost=0,estimated_gb=0,episode_count=0,charged_at=$at WHERE want_id=$id AND scope='initial' AND state='held'", ("$at", Ms(now)), ("$id", follower.Id));
                Record(c, t, follower.Id, null, actor, "merged", "accepted", sent ? "looking" : "queued_outage", follower.Input.Key, now);
            }
        }
        /// <summary>Cancel or decline; uncertain/in-flight writes cannot be refunded or deleted.</summary>
        public RequestOutcome Close(string id, Guid actor, string? declineReason, IRequestPolicy policy, DateTimeOffset now)
            => _db.Write((c, t) =>
            {
                var want = Wants(c, t, "id=$id", ("$id", id)).SingleOrDefault();
                if (want == null) return RequestOutcome.Refused("not_found", 404);
                var facts = policy.Evaluate(actor, want.Input);
                if (facts.Refusal != null) return RequestOutcome.Refused(facts.Refusal);
                if (declineReason == null ? actor != want.UserId && facts.Role != "Admin" : !facts.CanApprove) return RequestOutcome.Refused("requests_approve_required");
                if (declineReason != null && (string.IsNullOrWhiteSpace(declineReason) || declineReason.Length > 500 || declineReason.Any(ch => char.IsControl(ch) && ch != '\n'))) return RequestOutcome.Refused("invalid_reason", 400);
                if (!Active(want) || (declineReason != null && want.Status != "pending")) return RequestOutcome.Refused("request_changed", 409);
                if (Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$id AND (state IN ('sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown') LIMIT 1", ("$id", id)) != null ||
                    LinkedScope(c, t, want) != null) return RequestOutcome.Refused("request_in_flight", 409);
                var state = declineReason == null ? "cancelled" : "declined";
                Exec(c, t, "UPDATE wants SET status=$s,reason=$s,updated_at=$at WHERE id=$id", ("$s", state), ("$at", Ms(now)), ("$id", id));
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE want_id=$id", ("$id", id));
                Exec(c, t, "UPDATE jobs SET state='cancelled',reason=$s WHERE want_id=$id", ("$s", state), ("$id", id));
                if (declineReason == null) WithdrawFollowers(c, t, want.AcquisitionId, now);
                else RestorePendingOwners(c, t, want.AcquisitionId, policy, now);
                Approval(c, t, want, actor, state, declineReason, null, Authorize(facts, facts, want.Input, false), now);
                Record(c, t, id, null, actor, state, "accepted", state, want.Input.Key, now);
                return RequestOutcome.Accepted(id, state, 200);
            });
        private static void RestorePendingOwners(SqliteConnection c, SqliteTransaction t, string acquisition, IRequestPolicy policy, DateTimeOffset now)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
            var coverage = wants.Where(w => Active(w) && w.OwnedInput != null).ToList();
            foreach (var follower in wants.Where(w => w.Follower && w.Status == "pending"))
            {
                var extra = follower.Input.Extra(coverage.Where(w => w.TargetKey == follower.TargetKey).Select(w => w.OwnedInput!));
                if (extra == null) continue;
                var facts = policy.Evaluate(follower.UserId, extra);
                var cost = Cost(c, t, extra, follower.UserId, now, facts.WindowDays);
                Exec(c, t, "UPDATE wants SET owned_input=$input,is_follower=0,cost=$cost,updated_at=$at WHERE id=$id", ("$input", extra.Canonical), ("$cost", cost), ("$at", Ms(now)), ("$id", follower.Id));
                Exec(c, t, "UPDATE reservations SET cost=$cost,estimated_gb=$gb WHERE want_id=$id AND scope='initial'", ("$cost", cost), ("$gb", EstimateGb(extra)), ("$id", follower.Id));
                Record(c, t, follower.Id, null, null, "scope_restored", "accepted", follower.Reason, follower.Input.Key, now);
                coverage.Add(follower with { OwnedInput = extra });
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
                Reserve(c, t, wantId, want.UserId, 1, EstimateGb(want.Input) / Math.Max(1, want.Input.Seasons.Length), "charged", now, scope);
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
        /// sent keep-getting request on the Seerr the requester's asks go to now, or the season is the one asked for.
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
                var input = new MutationInput { Key = want.Input.Key, Scope = "seasons", Variant = want.Input.Variant, Seasons = new[] { season } }.Normalize();
                if (input == null) return false;
                var requester = policy.Evaluate(want.UserId, input);
                if (requester.Backend != "seerr" || TargetKey(requester) != want.TargetKey) return false;
                var jobs = Jobs(c, t, "want_id=$id", ("$id", wantId));
                if (jobs.Any(j => j.Input.Scope == "seasons" && j.Input.Seasons.Contains(season))) return false;
                // The approval the request went out with covers what it follows (a Kid's OK'd keep-getting needs no new OK).
                var approver = jobs.Where(j => j.State == "succeeded").Select(j => j.Authorization.Approver).LastOrDefault(a => a != null);
                var scope = "s" + season.ToString(CultureInfo.InvariantCulture);
                if (want.Cost > 0 && policy.Configuration.ArrRequestChargeFutureSeasons && Scalar(c, t, "SELECT id FROM reservations WHERE want_id=$id AND scope=$s", ("$id", wantId), ("$s", scope)) == null)
                    Reserve(c, t, wantId, want.UserId, 1, EstimateGb(want.Input) / Math.Max(1, want.Input.Seasons.Length), "charged", now, scope);
                FollowJob(c, t, wantId, input, Authorize(requester, approver is Guid a ? policy.Evaluate(a, input) : null, input, false), now);
                Record(c, t, wantId, null, want.UserId, "future_season", "accepted", "queued_outage", want.Input.Key, now);
                return true;
            });
        }
        private static List<RequestJob> Jobs(SqliteConnection c, SqliteTransaction? t, string where, params (string, object?)[] args)
        {
            using var cmd = Cmd(c, t, "SELECT id,want_id,mutation_input,authorization_context,state,attempts,next_attempt,reason,idempotency_key,fingerprint,COALESCE(json_extract(outcome,'$.certainty')='Unknown',0) FROM jobs WHERE " + where + " ORDER BY next_attempt,id LIMIT 100", args);
            using var r = cmd.ExecuteReader();
            var list = new List<RequestJob>();
            while (r.Read()) list.Add(new(r.GetString(0), r.GetString(1), JsonSerializer.Deserialize<MutationInput>(r.GetString(2))!, JsonSerializer.Deserialize<RequestAuthorization>(r.GetString(3))!,
                r.GetString(4), r.GetInt32(5), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(6)), r.GetString(7), r.GetString(8), r.GetString(9), r.GetInt64(10) == 1));
            return list;
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
        public void Recover(DateTimeOffset now) => _db.Write((c, t) => Exec(c, t, "UPDATE jobs SET state='maybe_sent',reason='maybe_sent',next_attempt=$at WHERE state='sending' OR (state='parked' AND json_extract(outcome,'$.certainty')='Unknown')", ("$at", Ms(now))));
        /// <summary>Claims a due row under a database generation fence.</summary>
        public bool Claim(RequestJob job, long generation, DateTimeOffset now) => _db.WriteIf(generation, (c, t) =>
            Exec(c, t, "UPDATE jobs SET state='sending',attempts=attempts+1,updated_at=$at WHERE id=$id AND state=$state AND next_attempt<=$at", ("$at", Ms(now)), ("$id", job.Id), ("$state", job.State)) == 1, false).Result;
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
                    shared = shared.Where(w => w.TargetKey == TargetKey(job.Authorization)).ToList();
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
        public void PurgeUser(Guid user) => _db.Write((c, t) => PurgeUser(c, t, user));
        internal static int PurgeUser(SqliteConnection c, SqliteTransaction t, Guid user)
        {
            var id = Id(user);
            Changed(c, t);
            Exec(c, t, "INSERT OR IGNORE INTO request_deleted_users VALUES($u)", ("$u", MutationInput.Hash("deleted:" + id)));
            Exec(c, t, "UPDATE approvals SET actor_id=NULL WHERE actor_id=$u", ("$u", id));
            Exec(c, t, "UPDATE request_audit SET actor_id=NULL WHERE actor_id=$u", ("$u", id));
            Exec(c, t, "UPDATE import_batches SET actor_id=NULL WHERE actor_id=$u", ("$u", id));
            Exec(c, t, "DELETE FROM automation_log WHERE user_id=$u", ("$u", id));
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
                Wants(c, t, "acquisition_id=$a AND id<>$w", ("$a", w.AcquisitionId), ("$w", w.Id)).Any(f => Active(f) && f.TargetKey == w.TargetKey && f.Input.Extra(new[] { w.Input })?.Fingerprint != f.Input.Fingerprint)).ToArray();
            foreach (var want in retained)
            {
                var linked = LinkedScope(c, t, want) != null;
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE job_id IN (SELECT id FROM jobs WHERE want_id=$w AND state IN ('queued','retry') AND COALESCE(json_extract(outcome,'$.certainty'),'Rejected')<>'Unknown')", ("$w", want.Id));
                Exec(c, t, "UPDATE jobs SET state='cancelled',reason='identity_changed' WHERE want_id=$w AND state IN ('queued','retry') AND COALESCE(json_extract(outcome,'$.certainty'),'Rejected')<>'Unknown'", ("$w", want.Id));
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
        public void Retain(DateTimeOffset now, int staleDays) => _db.Write((c, t) =>
        {
            Exec(c, t, "DELETE FROM request_events WHERE created_at<$at", ("$at", Ms(now.AddHours(-48))));
            Exec(c, t, "DELETE FROM request_notices WHERE created_at<$at", ("$at", Ms(now.AddDays(-90))));
            Exec(c, t, "DELETE FROM request_audit WHERE created_at<$at", ("$at", Ms(now.AddDays(-180))));
            Exec(c, t, "DELETE FROM automation_log WHERE created_at<$at", ("$at", Ms(now.AddDays(-90))));
            Exec(c, t, "DELETE FROM wants WHERE status IN ('fulfilled','cancelled','declined') AND updated_at<$at", ("$at", Ms(now.AddYears(-1))));
            return Exec(c, t, "UPDATE wants SET status='stale',reason='stale' WHERE status='sent' AND created_at<$at", ("$at", Ms(now.AddDays(-Math.Clamp(staleDays, 1, 365)))));
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
            Exec(c, t, "DELETE FROM request_events WHERE title_key=$key AND NOT EXISTS(SELECT 1 FROM wants WHERE title_key=$key)", ("$key", key));
            Exec(c, t, "DELETE FROM acquisitions WHERE id NOT IN (SELECT acquisition_id FROM wants)");
            return removed == 1;
        });
    }
}
