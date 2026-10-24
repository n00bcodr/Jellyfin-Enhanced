using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The durable owner of a person's retry key. The database reservation precedes preparation and claims;
    /// process waiters only join that reservation. A reservation without its live worker is unresolved.
    /// </summary>
    internal sealed class RetryOwners
    {
        internal sealed record Lease(string Path, Guid User, string Key, string Revision, long Generation, string Kind, string Identity);
        private sealed record Flight(string Revision, Task<object?> Result);
        private static readonly object Gate = new();
        private static readonly Dictionary<(string, Guid, string), Flight> Flights = new();
        private static readonly AsyncLocal<Lease?> Context = new();
        private static readonly JsonSerializerOptions Json = new() { IncludeFields = true, Converters = { new OutcomeConverter() } };
        private readonly AcquireDatabase _db;
        internal RetryOwners(AcquireDatabase db) { _db = db; }
        internal Lease? Current => Context.Value is { } lease && lease.Path == _db.FilePath ? lease : null;

        internal static string? Key(string? key)
            => string.IsNullOrWhiteSpace(key) || key.Length > 128 || key.Any(char.IsControl) ? null : key.Trim();

        /// <summary>Reserve synchronously, then run exactly one worker; identical callers own no separate effects.</summary>
        internal async Task<T> ExecuteAsync<T>(Guid user, string key, string kind, string identity,
            Func<CancellationToken, Task<T>> worker, Func<T> conflict, Func<T> unresolved,
            CancellationToken ct, DateTimeOffset now, TimeSpan? retention = null, Func<T, bool>? releaseUnsent = null, string? legacyIdentity = null)
        {
            ct.ThrowIfCancellationRequested();
            if (Key(key) is not { } canonical) return conflict();
            if (Current is { } parent && parent.User == user && parent.Key == canonical && parent.Kind == kind && parent.Identity == identity)
                return await worker(ct).ConfigureAwait(false);
            var slot = (_db.FilePath, user, canonical);
            TaskCompletionSource<object?>? mine = null;
            Task<object?>? joined = null;
            Lease? lease = null;
            T? answer = default;
            var disposition = "unknown";
            lock (Gate)
            {
                var generation = _db.Generation;
                var reserved = _db.WriteIf(generation, (c, t) =>
                {
                    RequestLedger.Exec(c, t, "DELETE FROM retry_owners WHERE user_id=$u AND retry_key=$k AND state='completed' AND deadline IS NOT NULL AND deadline<=$at",
                        ("$u", user.ToString("N")), ("$k", canonical), ("$at", now.ToUnixTimeMilliseconds()));
                    using (var read = RequestLedger.Cmd(c, t, "SELECT revision,kind,identity,state,result,result_type,action_receipt FROM retry_owners WHERE user_id=$u AND retry_key=$k", ("$u", user.ToString("N")), ("$k", canonical)))
                    using (var r = read.ExecuteReader())
                    {
                        if (r.Read())
                        {
                            if (r.GetString(2) != identity && !(r.GetString(1) == "legacy_request" && r.GetString(2) == legacyIdentity)) return "conflict";
                            if (r.GetString(1) == "legacy_request" && kind is "ask" or "add")
                            {
                                if (InternalInput(c, t, user, canonical)) return "conflict";
                                lease = new Lease(_db.FilePath, user, canonical, r.GetString(0), generation, kind, identity);
                                r.Close();
                                RequestLedger.Exec(c, t, "UPDATE retry_owners SET kind=$kind,identity=$identity,state='reserved' WHERE revision=$r", ("$kind", kind), ("$identity", identity), ("$r", lease.Revision));
                                RequestLedger.Exec(c, t, "UPDATE request_inputs SET fingerprint=$identity WHERE user_id=$u AND trim(client_request_id)=$k", ("$identity", identity), ("$u", user.ToString("N")), ("$k", canonical));
                                return "owner";
                            }
                            if (r.GetString(1) != kind) return "conflict";
                            if (!r.IsDBNull(4) && r.GetString(5) == typeof(T).ToString())
                            { answer = JsonSerializer.Deserialize<T>(r.GetString(4), Json); return "receipt"; }
                            if (!r.IsDBNull(6))
                            { answer = Project(JsonSerializer.Deserialize<ArrActionOutcome>(r.GetString(6), Json), unresolved); return "receipt"; }
                            if (Flights.TryGetValue(slot, out var active) && active.Revision == r.GetString(0))
                            { joined = active.Result; return "join"; }
                            return "unknown";
                        }
                    }
                    if (InternalInput(c, t, user, canonical)) return "conflict";
                    lease = new Lease(_db.FilePath, user, canonical, Guid.NewGuid().ToString("N"), generation, kind, identity);
                    RequestLedger.Exec(c, t, "INSERT INTO retry_owners(user_id,retry_key,revision,kind,identity,state,created_at) VALUES($u,$k,$r,$kind,$i,'reserved',$at)",
                        ("$u", user.ToString("N")), ("$k", canonical), ("$r", lease.Revision), ("$kind", kind), ("$i", identity), ("$at", now.ToUnixTimeMilliseconds()));
                    return "owner";
                }, "unknown");
                disposition = reserved.Result;
                if (disposition == "owner")
                {
                    mine = new(TaskCreationOptions.RunContinuationsAsynchronously);
                    Flights[slot] = new Flight(lease!.Revision, mine.Task);
                }
            }
            if (disposition == "conflict") return conflict();
            if (disposition == "receipt") return Replayed(answer!);
            if (joined != null)
            {
                try { return Project(await joined.WaitAsync(ct).ConfigureAwait(false), unresolved); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                { return await ExecuteAsync(user, key, kind, identity, worker, conflict, unresolved, ct, now, retention, releaseUnsent, legacyIdentity).ConfigureAwait(false); }
            }
            if (mine == null || lease == null) return unresolved();
            var previous = Context.Value;
            Context.Value = lease;
            try
            {
                var result = await worker(ct).ConfigureAwait(false);
                try
                {
                    var done = _db.WriteIf(lease.Generation, (c, t) =>
                {
                    // A refused, proven-unsent operation can be freshly authorised under this same identity.
                    if (releaseUnsent?.Invoke(result) == true &&
                        RequestLedger.Exec(c, t, "DELETE FROM retry_owners WHERE revision=$r AND state='reserved'", ("$r", lease.Revision)) == 1) return true;
                    return Complete(c, t, lease, result, now, retention);
                }, false);
                if (!done.Done || !done.Result) result = unresolved();
                }
                catch (Exception ex) when (ex is SqliteException or InvalidOperationException or System.IO.IOException)
                { result = unresolved(); }
                mine.TrySetResult(result);
                return result;
            }
            catch (OperationCanceledException)
            {
                // Only this revision's proven-unsent work may be released; a cancelled waiter never enters here.
                var released = Release(lease);
                if (released) mine.TrySetCanceled(ct);
                else mine.TrySetResult(unresolved());
                throw;
            }
            catch
            {
                // Persistence or transport failures retain the durable reservation. Never turn ambiguity into a new send.
                mine.TrySetResult(unresolved());
                throw;
            }
            finally
            {
                Context.Value = previous;
                lock (Gate)
                    if (Flights.TryGetValue(slot, out var active) && active.Revision == lease.Revision) Flights.Remove(slot);
            }
        }

        // Ledger child ids are aliases of an existing public owner's split, never independently executable inputs.
        // This also covers an older child whose text collided with a direct action key that has since expired.
        private static bool InternalInput(SqliteConnection c, SqliteTransaction t, Guid user, string key)
        {
            using var read = RequestLedger.Cmd(c, t, @"SELECT 1 FROM request_inputs child
JOIN wants w ON w.id=child.want_id JOIN request_inputs parent ON parent.user_id=child.user_id
JOIN wants go ON go.id=parent.want_id AND go.client_request_id=parent.client_request_id||'|go'
JOIN wants held ON held.user_id=parent.user_id AND held.client_request_id=parent.client_request_id||'|ok'
WHERE child.user_id=$u AND trim(child.client_request_id)=$k AND child.client_request_id=w.client_request_id AND w.id IN (go.id,held.id) LIMIT 1",
                ("$u", user.ToString("N")), ("$k", key));
            return read.ExecuteScalar() != null;
        }

        private static T Project<T>(object? value, Func<T> unresolved)
        {
            if (value is T same) return Replayed(same);
            var action = value as ArrActionOutcome ?? (value as ManageSearchResult)?.Outcome;
            if (action == null) return unresolved();
            if (typeof(T) == typeof(ArrActionOutcome)) return (T)(object)Replayed(action);
            if (typeof(T) == typeof(ManageSearchResult)) return (T)(object)new ManageSearchResult { Outcome = Replayed(action) };
            if (typeof(T) == typeof(ValueTuple<RequestOutcome, bool?>))
            {
                var outcome = action.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown
                    ? new RequestOutcome { Reason = "searched", HttpStatus = 200, Certainty = action.Status, Message = action.Message }
                    : RequestOutcome.Refused(action.Conflict ? PressChecks.Conflict : "search_failed", action.Conflict ? 409 : 502);
                return (T)(object)(outcome, (bool?)null);
            }
            return unresolved();
        }

        private static T Replayed<T>(T value) => value switch
        {
            RequestOutcome request when request.HttpStatus < 400 => (T)(object)(request with { HttpStatus = 200 }),
            ArrActionOutcome action => (T)(object)new ArrActionOutcome { Status = action.Status, Message = action.Message, Error = action.Error, ReadBack = action.ReadBack, AuditId = action.AuditId, Audited = action.Audited, Replayed = true, Conflict = action.Conflict },
            ManageSearchResult search => (T)(object)new ManageSearchResult { Outcome = Replayed(search.Outcome), Found = search.Found, Refusal = search.Refusal },
            _ => value,
        };

        internal bool ReleaseUnsent() => Current is { } lease && Release(lease);

        private bool Release(Lease lease) => _db.WriteIf(lease.Generation, (c, t) =>
            RequestLedger.Exec(c, t, "DELETE FROM retry_owners WHERE revision=$r AND state='reserved'", ("$r", lease.Revision)) == 1, false).Result;

        internal static bool Complete<T>(SqliteConnection c, SqliteTransaction t, Lease lease, T result, DateTimeOffset now, TimeSpan? retention)
        {
            if (result is RequestOutcome request && request.HttpStatus < 400)
                foreach (var id in new[] { request.RequestId, request.HeldRequestId }.OfType<string>())
                    RequestLedger.Exec(c, t, "INSERT OR IGNORE INTO retry_wants VALUES($r,$w)", ("$r", lease.Revision), ("$w", id));
            return RequestLedger.Exec(c, t, "UPDATE retry_owners SET result=$result,result_type=$type,state=CASE WHEN state IN ('sending','unknown') THEN state ELSE 'completed' END,deadline=CASE WHEN state='unknown' THEN NULL WHEN action_receipt IS NOT NULL THEN deadline ELSE $deadline END WHERE revision=$r",
                ("$result", JsonSerializer.Serialize(result, Json)), ("$type", typeof(T).ToString()), ("$deadline", retention.HasValue ? now.Add(retention.Value).ToUnixTimeMilliseconds() : null), ("$r", lease.Revision)) == 1;
        }

        /// <summary>Persist the immutable command and original opaque binding before transport is entered.</summary>
        internal bool Sending(ArrActionRequest request, DateTimeOffset now, TimeSpan retention)
        {
            if (Current is not { } lease) return false;
            return _db.WriteIf(lease.Generation, (c, t) => RequestLedger.Exec(c, t,
                "UPDATE retry_owners SET state='sending',command=$command,binding=$binding,deadline=$deadline WHERE revision=$r AND state='reserved'",
                ("$command", JsonSerializer.Serialize(new { request.Action, request.InstanceId, request.Target, request.Details })), ("$binding", request.Binding), ("$deadline", now.Add(retention).ToUnixTimeMilliseconds()), ("$r", lease.Revision)) == 1, false).Result;
        }

        internal bool ActionFinished(ArrActionOutcome outcome, DateTimeOffset now, TimeSpan retention)
        {
            if (Current is not { } lease) return false;
            return _db.WriteIf(lease.Generation, (c, t) => RequestLedger.Exec(c, t,
                "UPDATE retry_owners SET action_receipt=$receipt,state=$state,deadline=CASE WHEN $state='unknown' THEN NULL ELSE COALESCE(deadline,$deadline) END WHERE revision=$r",
                ("$receipt", JsonSerializer.Serialize(outcome, Json)), ("$state", outcome.Status == ArrActionStatus.Unknown ? "unknown" : outcome.Status == ArrActionStatus.Rejected ? "reserved" : "completed"),
                ("$deadline", outcome.Status == ArrActionStatus.Unknown ? null : now.Add(retention).ToUnixTimeMilliseconds()), ("$r", lease.Revision)) == 1, false).Result;
        }

        internal ArrActionOutcome? ReplayAction(Guid user, string key, string identity, DateTimeOffset now)
            => _db.Read(c =>
            {
                using var read = RequestLedger.Cmd(c, null, "SELECT kind,identity,state,action_receipt,deadline,revision FROM retry_owners WHERE user_id=$u AND retry_key=$k", ("$u", user.ToString("N")), ("$k", Key(key)));
                using var r = read.ExecuteReader();
                if (!r.Read() || (r.GetString(2) == "completed" && !r.IsDBNull(4) && r.GetInt64(4) <= now.ToUnixTimeMilliseconds())) return null;
                if (r.GetString(0) != "action" || r.GetString(1) != identity) return new ArrActionOutcome { Status = ArrActionStatus.Rejected, Conflict = true, Message = PressChecks.Message(PressChecks.Conflict) };
                if (!r.IsDBNull(3)) return JsonSerializer.Deserialize<ArrActionOutcome>(r.GetString(3), Json);
                return Current?.Revision == r.GetString(5) ? null : UnresolvedAction();
            });

        internal bool SearchClaimed(string slot, DateTimeOffset now, int hours) => _db.Read(c =>
        {
            using var read = RequestLedger.Cmd(c, null, "SELECT 1 FROM request_search_slots s LEFT JOIN retry_owners o ON o.revision=s.owner_revision WHERE s.slot=$s AND (s.claimed_at>$cutoff OR o.state IN ('reserved','sending','unknown'))",
                ("$s", slot), ("$cutoff", now.AddHours(-hours).ToUnixTimeMilliseconds()));
            return read.ExecuteScalar() != null;
        });

        internal bool ClaimSearch(string slot, DateTimeOffset now, int hours)
        {
            if (Current is not { } lease) return false;
            return _db.WriteIf(lease.Generation, (c,t) => RequestLedger.Exec(c, t,
                "INSERT INTO request_search_slots VALUES($s,$r,$at) ON CONFLICT(slot) DO UPDATE SET owner_revision=excluded.owner_revision,claimed_at=excluded.claimed_at WHERE request_search_slots.claimed_at<=$cutoff AND NOT EXISTS(SELECT 1 FROM retry_owners o WHERE o.revision=request_search_slots.owner_revision AND o.state IN ('reserved','sending','unknown'))",
                ("$s", slot), ("$r", lease.Revision), ("$at", now.ToUnixTimeMilliseconds()), ("$cutoff", now.AddHours(-hours).ToUnixTimeMilliseconds())) == 1, false).Result;
        }

        internal void ReleaseSearch(IEnumerable<string> slots)
        {
            if (Current is not { } lease) return;
            _db.WriteIf(lease.Generation, (c,t) =>
            {
                foreach (var slot in slots) RequestLedger.Exec(c,t, "DELETE FROM request_search_slots WHERE slot=$s AND owner_revision=$r", ("$s", slot), ("$r", lease.Revision));
                return true;
            }, false);
        }

        internal bool Holds(Guid user, string key, DateTimeOffset now) => _db.Read(c =>
        {
            using var read = RequestLedger.Cmd(c, null, "SELECT 1 FROM retry_owners WHERE user_id=$u AND retry_key=$k AND (state<>'completed' OR deadline IS NULL OR deadline>$at)",
                ("$u", user.ToString("N")), ("$k", Key(key)), ("$at", now.ToUnixTimeMilliseconds()));
            return read.ExecuteScalar() != null;
        });

        internal static ArrActionOutcome UnresolvedAction() => new() { Status = ArrActionStatus.Unknown, Replayed = true, Message = "The earlier action is unresolved. Check its original server before trying again." };
        internal static RequestOutcome UnresolvedRequest() => RequestOutcome.Refused("request_in_flight", 409, "conflict") with { Certainty = ArrActionStatus.Unknown, Message = "The earlier request is unresolved. Check it before trying again." };

        // HttpStatus is hidden from API JSON but is part of the durable internal receipt.
        private sealed class OutcomeConverter : JsonConverter<RequestOutcome>
        {
            public override RequestOutcome? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
            {
                using var doc = JsonDocument.ParseValue(ref reader);
                return JsonSerializer.Deserialize<RequestOutcome>(doc.RootElement.GetProperty("body"))! with { HttpStatus = doc.RootElement.GetProperty("http").GetInt32() };
            }
            public override void Write(Utf8JsonWriter writer, RequestOutcome value, JsonSerializerOptions options)
            {
                writer.WriteStartObject(); writer.WriteNumber("http", value.HttpStatus); writer.WritePropertyName("body");
                JsonSerializer.Serialize(writer, value); writer.WriteEndObject();
            }
        }
    }
}
