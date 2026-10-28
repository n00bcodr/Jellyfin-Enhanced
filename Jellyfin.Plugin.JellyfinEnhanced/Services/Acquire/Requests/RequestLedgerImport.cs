using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One Seerr request ready to become a JE want during the authority transfer.</summary>
    /// <param name="UserId">The Jellyfin requester (from Seerr's user mapping).</param>
    /// <param name="RequestId">Seerr's request id, unique together with the source id.</param>
    /// <param name="Input">The canonical scope and edition Seerr holds.</param>
    /// <param name="Pending">True for a request still awaiting an OK; false for one already processing.</param>
    /// <param name="CreatedAt">When the person asked in Seerr.</param>
    public sealed record ImportCandidate(Guid UserId, int RequestId, MutationInput Input, bool Pending, DateTimeOffset CreatedAt);

    /// <summary>The result of one import transaction.</summary>
    /// <param name="BatchId">The batch id, or null when nothing new was imported.</param>
    /// <param name="Imported">Wants created.</param>
    /// <param name="Skipped">Rows left out, by reason.</param>
    public sealed record ImportResult(string? BatchId, int Imported, IReadOnlyDictionary<string, int> Skipped);

    /// <summary>One import batch, for the status route and rollback.</summary>
    public sealed record ImportBatch(string Id, string SourceId, string Digest, string PreviousBackend, int Imported, string State,
        DateTimeOffset CreatedAt, DateTimeOffset RollbackUntil, DateTimeOffset? RolledBackAt, int Removed, int Kept);

    /// <summary>The result of rolling back one batch.</summary>
    /// <param name="Reason">null on success, else not_found, already_rolled_back, rollback_expired or newer_batch (a later batch is still committed).</param>
    /// <param name="Removed">Imported wants removed.</param>
    /// <param name="Kept">Imported wants kept because they were touched after the import.</param>
    /// <param name="PreviousBackend">The request handling in use before the import.</param>
    public sealed record ImportRollback(string? Reason, int Removed, int Kept, string PreviousBackend);

    /// <summary>One automation outcome row (diagnostics and tests).</summary>
    public sealed record AutomationLogEntry(string Recipe, string? UserId, string? TitleKey, string Outcome, string Reason, string? WantId, DateTimeOffset At);

    public sealed partial class RequestLedger
    {
        /// <summary>Client request id prefix of imported wants: <c>seerr:{source}:{request}</c>.</summary>
        public const string ImportClientPrefix = "seerr:";

        /// <summary>
        /// The JE-assigned id of a Seerr source, keyed by its normalised address set only, so a key rotation
        /// keeps it and another address gets another one. Read only; null when none was assigned yet.
        /// </summary>
        /// <param name="addressFingerprint">Hash of the normalised, sorted Seerr addresses (never the key).</param>
        public string? FindOriginSource(string addressFingerprint)
            => !_db.Available ? null : _db.Read(c => Scalar(c, null, "SELECT value FROM meta WHERE key=$k", ("$k", "seerr_origin:" + addressFingerprint)));

        /// <summary>The JE-assigned id of a Seerr source, assigning one on first use.</summary>
        /// <param name="addressFingerprint">Hash of the normalised, sorted Seerr addresses (never the key).</param>
        public string OriginSource(string addressFingerprint) => _db.Write((c, t) =>
        {
            var key = "seerr_origin:" + addressFingerprint;
            var existing = Scalar(c, t, "SELECT value FROM meta WHERE key=$k", ("$k", key));
            if (existing != null) return existing;
            var id = NewId();
            Exec(c, t, "INSERT INTO meta(key,value) VALUES($k,$v)", ("$k", key), ("$v", id));
            return id;
        });

        /// <summary>Seerr request ids already imported from one source.</summary>
        public IReadOnlySet<int> ImportedRequestIds(string? sourceId)
        {
            if (sourceId == null || !_db.Available) return new HashSet<int>();
            return _db.Read(c =>
            {
                using var cmd = Cmd(c, null, "SELECT origin_request_id FROM wants WHERE origin_source_id=$s AND origin_kind=$k", ("$s", sourceId), ("$k", RequestOrigin.SeerrImportKind));
                using var r = cmd.ExecuteReader();
                var ids = new HashSet<int>();
                while (r.Read())
                {
                    if (!r.IsDBNull(0) && int.TryParse(r.GetString(0), NumberStyles.None, CultureInfo.InvariantCulture, out var id)) ids.Add(id);
                }
                return ids;
            });
        }

        /// <summary>
        /// Imports Seerr requests as wants in one transaction: pending requests wait for a JE OK, processing ones
        /// only link to the title (no outgoing job). Nothing is charged and no "new request" notice is written.
        /// Rows already imported from the same source, requests of deleted users and asks a person already has in
        /// JE are skipped. Any failure rolls the whole import back.
        /// </summary>
        /// <param name="sourceId">JE-assigned Seerr source id.</param>
        /// <param name="digest">Digest of the complete Seerr read the plan came from.</param>
        /// <param name="items">Importable rows.</param>
        /// <param name="planSkipped">Rows the plan already left out, by reason (recorded with the batch).</param>
        /// <param name="actor">The administrator moving the requests.</param>
        /// <param name="previousBackend">Request handling before the transfer (restored by rollback).</param>
        /// <param name="targetKey">The JE-mode backend target of a scope (its instance and connection).</param>
        /// <param name="now">Commit time.</param>
        /// <param name="rollbackWindow">How long the batch can be rolled back.</param>
        /// <param name="staged">
        /// A move's import before its handover: the batch is <c>staged</c>, so its wants are invisible and inert
        /// (<see cref="NotStaged"/>) until <see cref="CommitStagedImport"/>, or removed whole by <see cref="DiscardStagedImport"/>.
        /// </param>
        public ImportResult ImportSeerr(string sourceId, string digest, IReadOnlyList<ImportCandidate> items, IReadOnlyDictionary<string, int> planSkipped,
            Guid actor, string previousBackend, Func<MutationInput, string> targetKey, DateTimeOffset now, TimeSpan rollbackWindow, bool staged = false)
            => _db.Write((c, t) =>
            {
                var skipped = new Dictionary<string, int>(planSkipped, StringComparer.Ordinal);
                void Skip(string reason) => skipped[reason] = skipped.GetValueOrDefault(reason) + 1;
                var batch = NewId();
                var imported = 0;
                foreach (var item in items)
                {
                    // The title as the ledger holds it (any of its ids resolved).
                    var input = item.Input.Normalize() is { } normalized ? Canonical(c, t, normalized) : null;
                    var requestId = item.RequestId.ToString(CultureInfo.InvariantCulture);
                    if (input == null) { Skip("unreadable"); continue; }
                    if (Scalar(c, t, "SELECT id FROM wants WHERE origin_source_id=$s AND origin_request_id=$r", ("$s", sourceId), ("$r", requestId)) != null) { Skip("already_imported"); continue; }
                    if (Deleted(c, t, item.UserId)) { Skip("unmapped_user"); continue; }
                    // Already in JE: a processing request only when the person's ask on the JE target was already
                    // sent (Seerr sent this one; an ask still waiting, or one aimed at Seerr, would send it again);
                    // a waiting request when the person has an ask JE acts on (on the JE target, or waiting or
                    // queued anywhere: approval moves it onto the JE target).
                    var target = targetKey(input);
                    var own = Wants(c, t, "user_id=$u AND " + TitleIs + " AND variant=$v", ("$u", Id(item.UserId)), ("$key", input.Key), ("$v", input.Variant)).Where(Active)
                        .Where(w => item.Pending ? RequestDestination.SameTarget(w.TargetKey, target) || w.Status is "pending" or "queued" : RequestDestination.SameTarget(w.TargetKey, target) && w.Status is "sent" or "stale")
                        .Select(w => w.Input).ToArray();
                    if (own.Length > 0 && input.Extra(own) == null) { Skip("already_in_je"); continue; }
                    var acquisition = Scalar(c, t, "SELECT id FROM acquisitions WHERE " + TitleIs + " AND variant=$v AND state='active'", ("$key", input.Key), ("$v", input.Variant));
                    if (acquisition == null)
                    {
                        acquisition = NewId();
                        Exec(c, t, "INSERT INTO acquisitions VALUES($id,$key,$v,'active',$at)", ("$id", acquisition), ("$key", input.Key), ("$v", input.Variant), ("$at", Ms(now)));
                    }
                    var id = NewId();
                    var client = ImportClientPrefix + sourceId + ":" + requestId;
                    var asked = item.CreatedAt > now || item.CreatedAt.Year < 2000 ? now : item.CreatedAt;
                    Exec(c, t, "INSERT INTO wants(id,acquisition_id,user_id,client_request_id,fingerprint,title_key,variant,mutation_input,owned_input,status,reason,cost,target_key,parental_signature,is_follower,origin_kind,origin_source_id,origin_request_id,import_batch_id,created_at,updated_at) VALUES($id,$a,$u,$client,$f,$key,$v,$input,$owned,$status,$r,0,$target,'null',0,$kind,$source,$request,$batch,$created,$at)",
                        ("$id", id), ("$a", acquisition), ("$u", Id(item.UserId)), ("$client", client), ("$f", input.Fingerprint), ("$key", input.Key), ("$v", input.Variant),
                        ("$input", input.Canonical), ("$owned", input.Canonical), ("$status", item.Pending ? "pending" : "sent"), ("$r", item.Pending ? "awaiting_approval" : "looking"),
                        ("$target", targetKey(input)), ("$kind", RequestOrigin.SeerrImportKind), ("$source", sourceId), ("$request", requestId), ("$batch", batch), ("$created", Ms(asked)), ("$at", Ms(now)));
                    AcceptActiveAliases(c, t, input.Key);
                    RememberInput(c, t, item.UserId, client, input.Fingerprint, id);
                    // A pending import holds a free reservation, so a later JE approval charges like any approval.
                    if (item.Pending) Reserve(c, t, id, item.UserId, 0, 0, "held", now, "initial");
                    // Audit and the change feed, but no request notice: importing is not a new ask.
                    Exec(c, t, "INSERT INTO request_audit VALUES($id,$w,NULL,$actor,'import','accepted','seerr_import',$at)", ("$id", NewId()), ("$w", id), ("$actor", Id(actor)), ("$at", Ms(now)));
                    Exec(c, t, "INSERT INTO request_events(title_key,created_at) VALUES($key,$at)", ("$key", input.Key), ("$at", Ms(now)));
                    imported++;
                    Fault?.Invoke("import");
                }
                if (imported == 0) return new ImportResult(null, 0, skipped);
                Changed(c, t);
                Exec(c, t, "INSERT INTO import_batches(id,origin_kind,origin_source_id,digest,actor_id,previous_backend,imported,skipped,state,created_at,rollback_until) VALUES($id,$kind,$source,$digest,$actor,$previous,$n,$skipped,$state,$at,$until)",
                    ("$state", staged ? "staged" : "committed"), ("$id", batch), ("$kind", RequestOrigin.SeerrImportKind), ("$source", sourceId), ("$digest", digest), ("$actor", Id(actor)), ("$previous", previousBackend),
                    ("$n", imported), ("$skipped", JsonSerializer.Serialize(skipped)), ("$at", Ms(now)), ("$until", Ms(now + rollbackWindow)));
                Fault?.Invoke("batch");
                return new ImportResult(batch, imported, skipped);
            });

        /// <summary>
        /// The handover of a move happened: its staged batch becomes an ordinary committed batch, and its wants appear as
        /// if imported now. While staged they were absent to every reader, alias reconciliation included, so a title whose
        /// other id was learned meanwhile has moved on: each want is brought to its title's current key, and (with
        /// <paramref name="policy"/>) a request that now covers it leads, as a merge would have arranged. True when the
        /// batch was staged (false when it was already committed or discarded).
        /// </summary>
        /// <param name="batchId">The staged batch.</param>
        /// <param name="now">When the handover committed.</param>
        /// <param name="policy">Request policy for the merge's follow step (null: identity only).</param>
        public bool CommitStagedImport(string batchId, DateTimeOffset now, IRequestPolicy? policy = null) => _db.Write((c, t) =>
        {
            if (Exec(c, t, "UPDATE import_batches SET state='committed' WHERE id=$id AND state='staged'", ("$id", batchId)) == 0) return false;
            var moved = new HashSet<string>(StringComparer.Ordinal);
            foreach (var want in Wants(c, t, "import_batch_id=$b", ("$b", batchId)))
            {
                var canonical = Canonical(c, t, want.Input.Key);
                if (canonical == want.Input.Key) continue;
                var input = want.Input with { Key = canonical };
                var owned = want.OwnedInput == null ? null : want.OwnedInput with { Key = canonical };
                Exec(c, t, "UPDATE wants SET title_key=$key,mutation_input=$input,owned_input=$owned,fingerprint=CASE WHEN fingerprint=$old THEN $f ELSE fingerprint END WHERE id=$id",
                    ("$key", canonical), ("$input", input.Canonical), ("$owned", owned?.Canonical), ("$old", want.Input.Fingerprint), ("$f", input.Fingerprint), ("$id", want.Id));
                moved.Add(want.AcquisitionId);
            }
            if (policy != null) foreach (var acquisition in moved) FollowWithin(c, t, acquisition, policy, now);
            // The titles changed now (they were invisible until the handover): pages following them read again.
            foreach (var key in StagedKeys(c, t, batchId)) Exec(c, t, "INSERT INTO request_events(title_key,created_at) VALUES($key,$at)", ("$key", key), ("$at", Ms(now)));
            Changed(c, t);
            return true;
        });

        /// <summary>
        /// The handover of a move was refused (or never happened): every want of its staged batch is removed (nothing
        /// could touch them: no reader, action or dispatch saw them), and the batch is recorded as rolled back.
        /// True when the batch was staged.
        /// </summary>
        /// <param name="batchId">The staged batch.</param>
        /// <param name="now">When it was discarded.</param>
        public bool DiscardStagedImport(string batchId, DateTimeOffset now) => _db.Write((c, t) =>
        {
            if (Scalar(c, t, "SELECT id FROM import_batches WHERE id=$id AND state='staged'", ("$id", batchId)) == null) return false;
            Exec(c, t, "DELETE FROM request_audit WHERE action='import' AND want_id IN (SELECT id FROM wants WHERE import_batch_id=$b)", ("$b", batchId));
            var removed = Exec(c, t, "DELETE FROM wants WHERE import_batch_id=$b", ("$b", batchId));
            Exec(c, t, "DELETE FROM acquisitions WHERE id NOT IN (SELECT acquisition_id FROM wants)");
            Exec(c, t, "UPDATE import_batches SET state='rolled_back',rolled_back_at=$at,removed=$removed,kept=0 WHERE id=$id", ("$at", Ms(now)), ("$removed", removed), ("$id", batchId));
            Changed(c, t);
            return true;
        });

        /// <summary>
        /// Rolls back every staged batch: a move that didn't finish its handover in this process (it crashed, or the
        /// database was restored from a copy taken mid-move) counts as refused; the administrator runs it again. Its
        /// wants were never seen or acted on. Returns how many batches were rolled back.
        /// </summary>
        /// <param name="now">Now.</param>
        public int DiscardStagedImports(DateTimeOffset now)
        {
            if (!_db.Available) return 0;
            var rolledBack = 0;
            foreach (var batch in _db.Read(c => Batches(c, null, "state='staged'")))
                if (DiscardStagedImport(batch.Id, now)) rolledBack++;
            return rolledBack;
        }

        private static List<string> StagedKeys(SqliteConnection c, SqliteTransaction t, string batchId)
        {
            using var cmd = Cmd(c, t, "SELECT DISTINCT title_key FROM wants WHERE import_batch_id=$b", ("$b", batchId));
            using var r = cmd.ExecuteReader();
            var keys = new List<string>();
            while (r.Read()) keys.Add(r.GetString(0));
            return keys;
        }

        // Why a batch can't be rolled back now (null when it can). Batches roll back newest first, so the
        // request handling each one restores is the one in use just before it.
        private static string? RollbackRefusal(SqliteConnection c, SqliteTransaction? t, ImportBatch? batch, DateTimeOffset now)
        {
            if (batch == null) return "not_found";
            if (batch.State != "committed") return "already_rolled_back";
            if (now > batch.RollbackUntil) return "rollback_expired";
            return Scalar(c, t, "SELECT id FROM import_batches WHERE state='committed' AND id<>$id AND (created_at>$at OR (created_at=$at AND rowid>(SELECT rowid FROM import_batches WHERE id=$id))) LIMIT 1",
                ("$id", batch.Id), ("$at", Ms(batch.CreatedAt))) != null ? "newer_batch" : null;
        }

        /// <summary>Whether a batch can be rolled back now (Reason null) and the request handling it restores. Read only.</summary>
        /// <param name="batchId">The batch.</param>
        /// <param name="now">Rollback time.</param>
        public ImportRollback CheckRollback(string batchId, DateTimeOffset now) => _db.Read(c =>
        {
            var batch = Batches(c, null, "id=$id", ("$id", batchId)).SingleOrDefault();
            return new ImportRollback(RollbackRefusal(c, null, batch, now), 0, 0, batch?.PreviousBackend ?? string.Empty);
        });

        /// <summary>
        /// Rolls one import batch back: removes its wants nobody touched since the import and keeps the rest
        /// (an approval, a cancel, a job, any later change), so nothing a person did in JE is lost. Batches
        /// roll back newest first.
        /// </summary>
        /// <param name="batchId">The batch.</param>
        /// <param name="now">Rollback time; refused after the batch's window.</param>
        public ImportRollback RollbackImport(string batchId, DateTimeOffset now) => _db.Write((c, t) =>
        {
            var batch = Batches(c, t, "id=$id", ("$id", batchId)).SingleOrDefault();
            if (RollbackRefusal(c, t, batch, now) is { } refusal) return new ImportRollback(refusal, 0, 0, batch?.PreviousBackend ?? string.Empty);
            var committed = batch!;
            var removed = 0;
            var kept = 0;
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var want in Wants(c, t, "import_batch_id=$b", ("$b", batchId)))
            {
                var untouched = want.UpdatedAt <= committed.CreatedAt &&
                    ((want.Status == "pending" && want.Reason == "awaiting_approval") || (want.Status == "sent" && want.Reason == "looking") || (want.Status == "stale" && want.Reason == "stale")) &&
                    Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w LIMIT 1", ("$w", want.Id)) == null &&
                    Scalar(c, t, "SELECT id FROM approvals WHERE want_id=$w LIMIT 1", ("$w", want.Id)) == null &&
                    Scalar(c, t, "SELECT client_request_id FROM request_inputs WHERE want_id=$w AND client_request_id<>$client LIMIT 1", ("$w", want.Id), ("$client", want.ClientRequestId)) == null &&
                    Scalar(c, t, "SELECT id FROM reservations WHERE want_id=$w AND state='charged' LIMIT 1", ("$w", want.Id)) == null;
                if (!untouched) { kept++; continue; }
                Exec(c, t, "DELETE FROM request_audit WHERE want_id=$w AND action='import'", ("$w", want.Id));
                removed += Exec(c, t, "DELETE FROM wants WHERE id=$w", ("$w", want.Id));
                keys.Add(want.Input.Key);
            }
            foreach (var key in keys) Exec(c, t, "INSERT INTO request_events(title_key,created_at) VALUES($key,$at)", ("$key", key), ("$at", Ms(now)));
            Exec(c, t, "DELETE FROM acquisitions WHERE id NOT IN (SELECT acquisition_id FROM wants)");
            Fault?.Invoke("rollback");
            Exec(c, t, "UPDATE import_batches SET state='rolled_back',rolled_back_at=$at,removed=$removed,kept=$kept WHERE id=$id", ("$at", Ms(now)), ("$removed", removed), ("$kept", kept), ("$id", batchId));
            Changed(c, t);
            return new ImportRollback(null, removed, kept, committed.PreviousBackend);
        });

        /// <summary>The newest import batches, newest first.</summary>
        /// <param name="max">At most this many.</param>
        public IReadOnlyList<ImportBatch> ImportBatches(int max = 10)
            => !_db.Available ? Array.Empty<ImportBatch>() : _db.Read(c => Batches(c, null, "state<>'staged' ORDER BY created_at DESC,rowid DESC LIMIT " + Math.Clamp(max, 1, 100).ToString(CultureInfo.InvariantCulture)));

        /// <summary>The users whose wants a batch holds (for the change feed).</summary>
        public IReadOnlyList<Guid> ImportUsers(string batchId) => _db.Read(c =>
        {
            using var cmd = Cmd(c, null, "SELECT DISTINCT user_id FROM wants WHERE import_batch_id=$b", ("$b", batchId));
            using var r = cmd.ExecuteReader();
            var users = new List<Guid>();
            while (r.Read()) if (Guid.TryParse(r.GetString(0), out var user)) users.Add(user);
            return users;
        });

        private static List<ImportBatch> Batches(SqliteConnection c, SqliteTransaction? t, string where, params (string, object?)[] args)
        {
            using var cmd = Cmd(c, t, "SELECT id,origin_source_id,digest,previous_backend,imported,state,created_at,rollback_until,rolled_back_at,removed,kept FROM import_batches WHERE " + where, args);
            using var r = cmd.ExecuteReader();
            var list = new List<ImportBatch>();
            while (r.Read())
                list.Add(new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetString(5),
                    DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(6)), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(7)),
                    r.IsDBNull(8) ? null : DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(8)), r.GetInt32(9), r.GetInt32(10)));
            return list;
        }

        /// <summary>Records one automation outcome (kept 90 days; purged with the user).</summary>
        /// <param name="recipe">auto_movie or auto_season.</param>
        /// <param name="user">The person the recipe acted for.</param>
        /// <param name="titleKey">The title asked for, when known.</param>
        /// <param name="outcome">want_recorded, definitive_noop, preparation_failed or cancelled.</param>
        /// <param name="reason">Stable reason code.</param>
        /// <param name="wantId">The want recorded, if any.</param>
        /// <param name="now">When.</param>
        public void LogAutomation(string recipe, Guid? user, string? titleKey, string outcome, string reason, string? wantId, DateTimeOffset now)
        {
            if (!_db.Available) return;
            _db.Write((c, t) => Exec(c, t, "INSERT INTO automation_log(recipe,user_id,title_key,outcome,reason,want_id,created_at) VALUES($recipe,$u,$key,$outcome,$reason,$want,$at)",
                ("$recipe", recipe), ("$u", user.HasValue ? Id(user.Value) : null), ("$key", titleKey), ("$outcome", outcome), ("$reason", reason), ("$want", wantId), ("$at", Ms(now))));
        }

        /// <summary>The newest automation outcomes, newest first.</summary>
        /// <param name="max">At most this many.</param>
        public IReadOnlyList<AutomationLogEntry> AutomationLog(int max = 50) => !_db.Available ? Array.Empty<AutomationLogEntry>() : _db.Read(c =>
        {
            using var cmd = Cmd(c, null, "SELECT recipe,user_id,title_key,outcome,reason,want_id,created_at FROM automation_log ORDER BY id DESC LIMIT $n", ("$n", Math.Clamp(max, 1, 1000)));
            using var r = cmd.ExecuteReader();
            var list = new List<AutomationLogEntry>();
            while (r.Read())
                list.Add(new(r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetString(4),
                    r.IsDBNull(5) ? null : r.GetString(5), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(6))));
            return list;
        });
    }
}
