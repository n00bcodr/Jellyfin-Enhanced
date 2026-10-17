using System;
using System.Globalization;
using System.Linq;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>A durable batch, confirmation or hand-off operation.</summary>
    /// <param name="Id">Operation id (server-assigned).</param>
    /// <param name="UserId">The person whose operation it is.</param>
    /// <param name="Kind">What it is (request_batch, import_handoff, sync_handoff, list_apply).</param>
    /// <param name="ClientId">The caller's confirmation id (one per press/confirmation).</param>
    /// <param name="Fingerprint">Fingerprint of what was confirmed.</param>
    /// <param name="Subject">What it is about (a list id), server-checked.</param>
    /// <param name="Size">How many items it holds.</param>
    /// <param name="State">open, completed or abandoned.</param>
    /// <param name="Payload">Bounded server-built payload (a hand-off's items), or null.</param>
    /// <param name="CreatedAt">Created.</param>
    public sealed record RequestOperation(string Id, Guid UserId, string Kind, string ClientId, string Fingerprint, string? Subject, int Size, string State, string? Payload, DateTimeOffset CreatedAt);

    /// <summary>The answer to <see cref="RequestOperations.Begin"/>: the operation, or why there is none.</summary>
    /// <param name="Operation">The operation (new or replayed).</param>
    /// <param name="Replayed">The same confirmation again (a retry or restart): the same operation and child ids.</param>
    /// <param name="Refusal">invalid_input, batch_too_large, idempotency_conflict or database_unavailable.</param>
    public sealed record RequestOperationResult(RequestOperation? Operation, bool Replayed = false, string? Refusal = null);

    /// <summary>
    /// Durable batch/confirmation operations (acquire.db). A confirmation (Request all missing, a reviewed import's asks, a
    /// sync's additions) is recorded before anything is asked for; each title's request id is derived from the operation
    /// and the normalized person, title, scope, edition and target, so a retry or a restart of the same operation asks with
    /// the same ids (the ledger replays them) while every new confirmation gets new ids (and the ledger merges with what is
    /// already asked for). At most <see cref="MaxBatch"/> titles per request batch, enforced here. Automatic triggers have
    /// their own identity (<see cref="TriggerIdentity"/>), never an interactive one.
    /// </summary>
    public sealed class RequestOperations
    {
        /// <summary>Most titles in one request batch.</summary>
        public const int MaxBatch = 20;

        /// <summary>Most items in any other operation (hand-offs).</summary>
        public const int MaxItems = 2000;

        /// <summary>A request batch (Request all missing, reviewed import asks).</summary>
        public const string RequestBatch = "request_batch";

        private readonly AcquireDatabase _db;

        /// <summary>Creates the store (DI).</summary>
        public RequestOperations(AcquireDatabase db) { _db = db; }

        /// <summary>
        /// Records a confirmation, or replays it: the same person, kind and confirmation id with the same fingerprint is the
        /// same operation; with a different fingerprint it is refused (idempotency_conflict). A request batch holds at most
        /// <see cref="MaxBatch"/> titles.
        /// </summary>
        /// <param name="user">The person.</param>
        /// <param name="kind">Operation kind.</param>
        /// <param name="clientId">The caller's confirmation id.</param>
        /// <param name="fingerprint">Fingerprint of what was confirmed (the server's normalized items).</param>
        /// <param name="subject">What it is about (already checked by the caller), or null.</param>
        /// <param name="size">How many items.</param>
        /// <param name="now">Now.</param>
        /// <param name="payload">Bounded server-built payload, or null.</param>
        public RequestOperationResult Begin(Guid user, string kind, string clientId, string fingerprint, string? subject, int size, DateTimeOffset now, string? payload = null)
            => Begin(user, kind, clientId, fingerprint, subject, size, now, payload == null ? null : _ => payload);

        /// <summary>
        /// Records an operation whose payload names the operation itself (e.g. the request ids its items will ask with):
        /// <paramref name="payload"/> gets the new operation's id and runs in the same write, only when the operation is new.
        /// </summary>
        /// <param name="user">The person.</param>
        /// <param name="kind">Operation kind.</param>
        /// <param name="clientId">The caller's confirmation id.</param>
        /// <param name="fingerprint">Fingerprint of what was confirmed.</param>
        /// <param name="subject">What it is about, or null.</param>
        /// <param name="size">How many items.</param>
        /// <param name="now">Now.</param>
        /// <param name="payload">Builds the bounded payload from the new operation's id, or null.</param>
        public RequestOperationResult Begin(Guid user, string kind, string clientId, string fingerprint, string? subject, int size, DateTimeOffset now, Func<string, string?>? payload)
        {
            if (string.IsNullOrWhiteSpace(kind) || kind.Length > 40 || string.IsNullOrWhiteSpace(clientId) || clientId.Length > 128 || clientId.Any(char.IsControl) ||
                string.IsNullOrEmpty(fingerprint) || fingerprint.Length > 128 || size < 0 || subject?.Length > 200)
                return new(null, Refusal: "invalid_input");
            if (size > (kind == RequestBatch ? MaxBatch : MaxItems)) return new(null, Refusal: "batch_too_large");
            if (!_db.Available) return new(null, Refusal: "database_unavailable");
            return _db.Write((c, t) =>
            {
                var existing = Read(c, t, "user_id=$u AND kind=$k AND client_id=$c", ("$u", RequestLedger.Id(user)), ("$k", kind), ("$c", clientId));
                if (existing != null)
                    return existing.Fingerprint == fingerprint ? new RequestOperationResult(existing, Replayed: true) : new RequestOperationResult(null, Refusal: "idempotency_conflict");
                var id = RequestLedger.NewId();
                var body = payload?.Invoke(id);
                if (body?.Length > 1_000_000) return new RequestOperationResult(null, Refusal: "invalid_input");
                RequestLedger.Exec(c, t, "INSERT INTO request_operations(id,user_id,kind,client_id,fingerprint,subject,size,state,payload,created_at,updated_at) VALUES($id,$u,$k,$c,$f,$s,$n,'open',$p,$at,$at)",
                    ("$id", id), ("$u", RequestLedger.Id(user)), ("$k", kind), ("$c", clientId), ("$f", fingerprint), ("$s", subject), ("$n", size), ("$p", body), ("$at", RequestLedger.Ms(now)));
                return new RequestOperationResult(new RequestOperation(id, user, kind, clientId, fingerprint, subject, size, "open", body, now));
            });
        }

        /// <summary>A person's operation of a kind by their confirmation id, or null (read only).</summary>
        /// <param name="user">The person.</param>
        /// <param name="kind">Operation kind.</param>
        /// <param name="clientId">The caller's confirmation id.</param>
        public RequestOperation? Find(Guid user, string kind, string clientId)
            => !_db.Available ? null : _db.Read(c => Read(c, null, "user_id=$u AND kind=$k AND client_id=$c", ("$u", RequestLedger.Id(user)), ("$k", kind), ("$c", clientId)));

        /// <summary>One operation, or null.</summary>
        /// <param name="id">Operation id.</param>
        public RequestOperation? Find(string id) => !_db.Available ? null : _db.Read(c => Read(c, null, "id=$id", ("$id", id)));

        /// <summary>Marks an operation completed or abandoned (it stays readable for replays for 90 days).</summary>
        /// <param name="id">Operation id.</param>
        /// <param name="state">completed or abandoned.</param>
        /// <param name="now">Now.</param>
        public bool Finish(string id, string state, DateTimeOffset now)
            => state is "completed" or "abandoned" && _db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE request_operations SET state=$s,updated_at=$at WHERE id=$id AND state='open'", ("$s", state), ("$at", RequestLedger.Ms(now)), ("$id", id)) == 1);

        /// <summary>
        /// A title's request id inside an operation: derived from the operation and the normalized person, title, scope,
        /// edition and target, so the same operation always asks with the same id and another operation never does.
        /// Null when the input isn't valid.
        /// </summary>
        /// <param name="operationId">The operation.</param>
        /// <param name="user">The person asking.</param>
        /// <param name="input">The title and scope.</param>
        /// <param name="target">The backend target (see <see cref="RequestLedger.TargetKey(RequestPolicyFacts)"/>), or empty.</param>
        public static string? ChildRequestId(string operationId, Guid user, MutationInput input, string target)
            => input.Normalize() is { } normalized ? "op:" + MutationInput.Hash(operationId + "|" + RequestLedger.Id(user) + "|" + Scope(normalized) + "|" + target)[..40].ToLowerInvariant() : null;

        /// <summary>
        /// An automatic trigger's identity: recipe, triggering person, normalized title/scope/edition/target and what
        /// triggered it (a session and item, a source generation or delta, a release event). Used as the request id of the
        /// ask it makes and as its decision key, so the same trigger is one ask and one decision.
        /// </summary>
        /// <param name="recipe">Recipe id.</param>
        /// <param name="user">The triggering person.</param>
        /// <param name="input">The title and scope.</param>
        /// <param name="target">The backend target, or empty.</param>
        /// <param name="trigger">What triggered it.</param>
        public static string? TriggerIdentity(string recipe, Guid user, MutationInput input, string target, string trigger)
            => input.Normalize() is { } normalized ? "auto:" + recipe + ":" + MutationInput.Hash(RequestLedger.Id(user) + "|" + Scope(normalized) + "|" + target + "|" + trigger)[..40].ToLowerInvariant() : null;

        // The normalized identity of a scope (title, scope, edition, seasons, episodes), without routing choices.
        private static string Scope(MutationInput input)
            => input.Key + "|" + input.Scope + "|" + input.Variant + "|" + string.Join(",", input.Seasons.Select(s => s.ToString(CultureInfo.InvariantCulture))) + "|" +
               string.Join(",", input.Episodes.Select(e => e.Season.ToString(CultureInfo.InvariantCulture) + "x" + e.Episode.ToString(CultureInfo.InvariantCulture)));

        private static RequestOperation? Read(SqliteConnection c, SqliteTransaction? t, string where, params (string, object?)[] args)
        {
            using var cmd = RequestLedger.Cmd(c, t, "SELECT id,user_id,kind,client_id,fingerprint,subject,size,state,payload,created_at FROM request_operations WHERE " + where + " LIMIT 1", args);
            using var r = cmd.ExecuteReader();
            return r.Read() ? new RequestOperation(r.GetString(0), Guid.Parse(r.GetString(1)), r.GetString(2), r.GetString(3), r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5),
                r.GetInt32(6), r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(9))) : null;
        }
    }
}
