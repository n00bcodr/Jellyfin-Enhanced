using System;
using System.Collections.Generic;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>One stored decision (unique per decision key; a repeat updates it and counts <c>Repeats</c>).</summary>
    public sealed record AutomationDecisionRow(string Key, string Recipe, string? UserId, string? TitleKey, string Mode, string Outcome, string Reason,
        string? Backend, string? Detail, int Repeats, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

    /// <summary>A recorded automation-eligibility grant (the legacy migration's, for Managers whose automatic requests went ahead).</summary>
    public sealed record AutomationGrant(string UserId, string Source, string? Detail, DateTimeOffset GrantedAt);

    /// <summary>A target's circuit breaker: consecutive failures and, when open, until when.</summary>
    public sealed record AutomationBreaker(string Target, int Failures, DateTimeOffset? OpenUntil, string? LastReason, DateTimeOffset UpdatedAt)
    {
        /// <summary>True while the breaker holds automatic sends to the target.</summary>
        /// <param name="now">Now.</param>
        public bool Open(DateTimeOffset now) => OpenUntil is { } until && until > now;
    }

    /// <summary>
    /// The automation engine's durable state in acquire.db: decisions (what each recipe decided, in every mode,
    /// Shadow's only effect), recorded eligibility grants, per-target circuit breakers, and small key/value state (the
    /// migration record and its one-time notice). No row here is a want, a job, a reservation or an upstream action.
    /// </summary>
    public sealed class AutomationStore
    {
        /// <summary>Consecutive automatic transport failures that open a target's breaker.</summary>
        public const int BreakerThreshold = 5;

        /// <summary>How long an open breaker holds automatic sends before one is tried again.</summary>
        public static readonly TimeSpan BreakerCooldown = TimeSpan.FromMinutes(15);

        private readonly AcquireDatabase _db;

        /// <summary>Creates the store (DI).</summary>
        public AutomationStore(AcquireDatabase db) { _db = db; }

        /// <summary>Tests: runs as a breaker read returns (with its target): a change made then is one the read missed.</summary>
        internal Action<string>? BreakerRead { get; set; }

        /// <summary>Tests: runs as a grant read returns (with its person).</summary>
        internal Action<Guid>? GrantRead { get; set; }

        /// <summary>The database.</summary>
        public AcquireDatabase Database => _db;

        /// <summary>
        /// Records a decision under its key: a new key adds a row; the same key again updates its outcome and counts a
        /// repeat (a progress event every few seconds is one decision, not hundreds). Never throws; false when not stored.
        /// </summary>
        /// <param name="decision">The decision.</param>
        /// <param name="now">When.</param>
        public bool Record(AutomationDecision decision, DateTimeOffset now)
        {
            try
            {
                if (!_db.Available) return false;
                _db.Write((c, t) => RequestLedger.Exec(c, t,
                    "INSERT INTO automation_decisions(decision_key,recipe,user_id,title_key,mode,outcome,reason,backend,detail,created_at,updated_at) VALUES($k,$r,$u,$key,$m,$o,$reason,$b,$d,$at,$at) " +
                    "ON CONFLICT(decision_key) DO UPDATE SET mode=$m,outcome=$o,reason=$reason,backend=$b,detail=$d,updated_at=$at,repeats=repeats+1",
                    ("$k", decision.Key), ("$r", decision.Recipe), ("$u", decision.User.HasValue ? RequestLedger.Id(decision.User.Value) : null), ("$key", decision.TitleKey),
                    ("$m", AutomationModes.Name(decision.Mode)), ("$o", decision.Outcome), ("$reason", decision.Reason), ("$b", decision.Backend),
                    ("$d", decision.Detail == null ? null : JsonSerializer.Serialize(decision.Detail)), ("$at", RequestLedger.Ms(now))));
                return true;
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                return false;
            }
        }

        /// <summary>The newest decisions, newest first (optionally since a time, optionally one recipe).</summary>
        /// <param name="max">At most this many (1..1000).</param>
        /// <param name="since">Only decisions updated after this.</param>
        /// <param name="recipe">Only this recipe.</param>
        public IReadOnlyList<AutomationDecisionRow> Decisions(int max = 100, DateTimeOffset? since = null, string? recipe = null)
        {
            if (!_db.Available) return Array.Empty<AutomationDecisionRow>();
            return _db.Read(c =>
            {
                using var cmd = RequestLedger.Cmd(c, null, "SELECT decision_key,recipe,user_id,title_key,mode,outcome,reason,backend,detail,repeats,created_at,updated_at FROM automation_decisions WHERE updated_at>$since AND ($r IS NULL OR recipe=$r) ORDER BY updated_at DESC,id DESC LIMIT $n",
                    ("$since", since.HasValue ? RequestLedger.Ms(since.Value) : 0L), ("$r", recipe), ("$n", Math.Clamp(max, 1, 1000)));
                using var r = cmd.ExecuteReader();
                var list = new List<AutomationDecisionRow>();
                while (r.Read())
                    list.Add(new(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), r.GetString(5), r.GetString(6),
                        r.IsDBNull(7) ? null : r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8), r.GetInt32(9), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(10)), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(11))));
                return (IReadOnlyList<AutomationDecisionRow>)list;
            });
        }

        /// <summary>True when the person holds a recorded automation-eligibility grant (false when it can't be read).</summary>
        /// <param name="user">The person.</param>
        public bool HasGrant(Guid user)
        {
            var granted = false;
            try
            {
                granted = _db.Available && _db.Read(c =>
                {
                    using var cmd = RequestLedger.Cmd(c, null, "SELECT 1 FROM automation_grants WHERE user_id=$u", ("$u", RequestLedger.Id(user)));
                    return cmd.ExecuteScalar() != null;
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // Not granted.
            }

            GrantRead?.Invoke(user);
            return granted;
        }

        /// <summary>Every recorded grant.</summary>
        public IReadOnlyList<AutomationGrant> Grants()
        {
            if (!_db.Available) return Array.Empty<AutomationGrant>();
            return _db.Read(c =>
            {
                using var cmd = RequestLedger.Cmd(c, null, "SELECT user_id,source,detail,granted_at FROM automation_grants ORDER BY granted_at,user_id");
                using var r = cmd.ExecuteReader();
                var list = new List<AutomationGrant>();
                while (r.Read()) list.Add(new(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(3))));
                return (IReadOnlyList<AutomationGrant>)list;
            });
        }

        /// <summary>Records grants and small state in one transaction (the migration's single commit).</summary>
        /// <param name="grants">Users to grant, with source and detail.</param>
        /// <param name="meta">Key/value state to set.</param>
        /// <param name="now">When.</param>
        internal void Commit(IEnumerable<(Guid User, string Source, string? Detail)> grants, IReadOnlyDictionary<string, string> meta, DateTimeOffset now)
        {
            _db.WriteAutomation((c, t) =>
            {
                foreach (var (user, source, detail) in grants)
                    RequestLedger.Exec(c, t, "INSERT OR IGNORE INTO automation_grants(user_id,source,detail,granted_at) VALUES($u,$s,$d,$at)", ("$u", RequestLedger.Id(user)), ("$s", source), ("$d", detail), ("$at", RequestLedger.Ms(now)));
                foreach (var (key, value) in meta)
                    RequestLedger.Exec(c, t, "INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=$v", ("$k", key), ("$v", value));
                return 0;
            });
        }

        /// <summary>A small state value, or null (also when unreadable).</summary>
        /// <param name="key">Key.</param>
        public string? Meta(string key)
        {
            try
            {
                return !_db.Available ? null : _db.Read(c =>
                {
                    using var cmd = RequestLedger.Cmd(c, null, "SELECT value FROM meta WHERE key=$k", ("$k", key));
                    return cmd.ExecuteScalar() as string;
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                return null;
            }
        }

        /// <summary>Sets a small state value.</summary>
        /// <param name="key">Key.</param>
        /// <param name="value">Value.</param>
        public void SetMeta(string key, string value) => _db.Write((c, t) => RequestLedger.Exec(c, t, "INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=$v", ("$k", key), ("$v", value)));

        /// <summary>A target's breaker (closed and empty when none is stored or it can't be read).</summary>
        /// <param name="target">Instance id or <c>seerr</c>.</param>
        public AutomationBreaker Breaker(string target)
        {
            AutomationBreaker? found = null;
            try
            {
                if (_db.Available)
                {
                    found = _db.Read(c =>
                    {
                        using var cmd = RequestLedger.Cmd(c, null, "SELECT failures,opened_until,last_reason,updated_at FROM automation_breakers WHERE target=$t", ("$t", target));
                        using var r = cmd.ExecuteReader();
                        return r.Read() ? new AutomationBreaker(target, r.GetInt32(0), r.IsDBNull(1) ? null : DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(1)), r.IsDBNull(2) ? null : r.GetString(2), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(3))) : null;
                    });
                }
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // Closed: the budgets fail closed on their own.
            }

            BreakerRead?.Invoke(target);
            return found ?? new AutomationBreaker(target, 0, null, null, DateTimeOffset.MinValue);
        }

        /// <summary>Every stored breaker.</summary>
        public IReadOnlyList<AutomationBreaker> Breakers()
        {
            if (!_db.Available) return Array.Empty<AutomationBreaker>();
            return _db.Read(c =>
            {
                using var cmd = RequestLedger.Cmd(c, null, "SELECT target,failures,opened_until,last_reason,updated_at FROM automation_breakers ORDER BY target");
                using var r = cmd.ExecuteReader();
                var list = new List<AutomationBreaker>();
                while (r.Read()) list.Add(new(r.GetString(0), r.GetInt32(1), r.IsDBNull(2) ? null : DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(2)), r.IsDBNull(3) ? null : r.GetString(3), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(4))));
                return (IReadOnlyList<AutomationBreaker>)list;
            });
        }

        /// <summary>
        /// Counts one failed automatic send to the target; the threshold-th in a row opens the breaker for the cooldown
        /// (a failure while half-open, after the cooldown, opens it again at once). Never throws.
        /// </summary>
        /// <param name="target">Instance id or <c>seerr</c>.</param>
        /// <param name="reason">Failure reason.</param>
        /// <param name="now">Now.</param>
        public void Failure(string target, string reason, DateTimeOffset now)
        {
            try
            {
                if (!_db.Available) return;
                _db.WriteAutomation((c, t) =>
                {
                    RequestLedger.Exec(c, t, "INSERT INTO automation_breakers(target,failures,last_reason,updated_at) VALUES($t,1,$r,$at) ON CONFLICT(target) DO UPDATE SET failures=failures+1,last_reason=$r,updated_at=$at",
                        ("$t", target), ("$r", reason), ("$at", RequestLedger.Ms(now)));
                    return RequestLedger.Exec(c, t, "UPDATE automation_breakers SET opened_until=$until WHERE target=$t AND failures>=$n",
                        ("$t", target), ("$n", BreakerThreshold), ("$until", RequestLedger.Ms(now + BreakerCooldown)));
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // Diagnostics only.
            }
        }

        /// <summary>A successful automatic send closes the target's breaker. Never throws.</summary>
        /// <param name="target">Instance id or <c>seerr</c>.</param>
        /// <param name="now">Now.</param>
        public void Success(string target, DateTimeOffset now)
        {
            try
            {
                if (!_db.Available) return;
                _db.WriteAutomation((c, t) => RequestLedger.Exec(c, t, "UPDATE automation_breakers SET failures=0,opened_until=NULL,updated_at=$at WHERE target=$t AND (failures>0 OR opened_until IS NOT NULL)",
                    ("$t", target), ("$at", RequestLedger.Ms(now))));
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // Diagnostics only.
            }
        }

        /// <summary>
        /// An administrator closes a target's breaker; the automatic requests it held are checked again at once (the
        /// same jobs, so nothing is sent twice). True when one was open or counting.
        /// </summary>
        /// <param name="target">Instance id or <c>seerr</c>.</param>
        /// <param name="now">Now.</param>
        public bool Reset(string target, DateTimeOffset now)
        {
            var reset = _db.WriteAutomation((c, t) =>
            {
                var reset = RequestLedger.Exec(c, t, "UPDATE automation_breakers SET failures=0,opened_until=NULL,last_reason='reset',updated_at=$at WHERE target=$t", ("$t", target), ("$at", RequestLedger.Ms(now)));
                RequestLedger.Exec(c, t, "UPDATE jobs SET next_attempt=$at WHERE state='retry' AND reason=$r AND next_attempt>$at AND " +
                    "(CASE WHEN $t='" + AutomationFlags.SeerrTarget + "' THEN json_extract(authorization_context,'$.Backend')='seerr' ELSE json_extract(authorization_context,'$.InstanceId')=$t END)",
                    ("$t", target), ("$r", AutomationHolds.BreakerOpen), ("$at", RequestLedger.Ms(now)));
                return reset;
            });
            return reset == 1;
        }
    }
}
