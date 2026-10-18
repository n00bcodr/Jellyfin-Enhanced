using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>The budget categories automatic work is admitted against.</summary>
    public static class BudgetCategories
    {
        /// <summary>Sonarr/Radarr handling: titles added or newly monitored, household-wide, per rolling 24 hours.</summary>
        public const string HouseholdAdd = "household_add";

        /// <summary>Sonarr/Radarr handling: searches per instance, per rolling hour and per rolling 24 hours.</summary>
        public const string Search = "instance_search";

        /// <summary>Seerr handling: Jellyfin Enhanced's own POSTs to Seerr per rolling 24 hours (not what Seerr does next).</summary>
        public const string SeerrPost = "seerr_post";

        /// <summary>Reserved for backfill (a later phase): never admitted by this version.</summary>
        public const string Backfill = "backfill_search";

        /// <summary>Linked lists: source reads per rolling hour.</summary>
        public const string SourceFetch = "source_fetch";

        /// <summary>Linked lists: list changes applied per rolling hour.</summary>
        public const string DeltaWork = "delta_work";

        /// <summary>The household-wide scope.</summary>
        public const string Household = "household";

        /// <summary>Every category, for status.</summary>
        public static readonly IReadOnlyList<string> All = new[] { HouseholdAdd, Search, SeerrPost, Backfill, SourceFetch, DeltaWork };
    }

    /// <summary>One rolling window of a budget.</summary>
    /// <param name="Length">Window length.</param>
    /// <param name="Limit">Admissions allowed inside it.</param>
    public sealed record BudgetWindow(TimeSpan Length, int Limit);

    /// <summary>
    /// A budget's state in one window: <c>Used</c> counts reserved, sent and uncertain admissions (an uncertain one
    /// counts until a read-back settles it); <c>NextSlotAt</c> is when the next admission frees up while it is full
    /// (null: room now); <c>ResetAt</c> when the oldest counted admission leaves the window.
    /// </summary>
    public sealed record BudgetUsage(string Category, string Scope, TimeSpan Window, int Used, int Limit, int Uncertain, DateTimeOffset? NextSlotAt, DateTimeOffset? ResetAt)
    {
        /// <summary>No room left in this window.</summary>
        public bool Full => Used >= Limit;
    }

    /// <summary>The answer to one admission.</summary>
    /// <param name="Admitted">The action may go now.</param>
    /// <param name="Id">The reservation (null when refused).</param>
    /// <param name="Reason">Refusal code: budget_exhausted, accounting_unavailable or not_implemented.</param>
    /// <param name="RetryAt">When it may be tried again (budget_exhausted).</param>
    /// <param name="Replayed">The same unique action was admitted before: nothing new was counted.</param>
    /// <param name="Window">The full window that waits longest (budget_exhausted).</param>
    public sealed record BudgetAdmission(bool Admitted, string? Id, string? Reason, DateTimeOffset? RetryAt, bool Replayed = false, TimeSpan? Window = null);

    /// <summary>How an admitted action ended.</summary>
    public enum BudgetOutcome
    {
        /// <summary>It went out (a new add, a search): counted.</summary>
        Sent,

        /// <summary>It definitely didn't go out: released.</summary>
        NotSent,

        /// <summary>Whether it went out is unknown: counted until a read-back settles it.</summary>
        MaybeSent,

        /// <summary>The upstream already had it (an add of a title already there): released, not a new add.</summary>
        AlreadyThere,
    }

    /// <summary>
    /// Durable, atomic budget admission in acquire.db. An admission is one row, written in the same short
    /// <c>BEGIN IMMEDIATE</c> transaction that counted the window, so two workers can never both take the last slot.
    /// Unique actions only: a unique key admitted before is a replay and counts nothing new. Windows are rolling UTC
    /// (1 h, 24 h); a row stamped in the future (a clock that moved back) still counts. When the database can't be
    /// used, nothing is admitted (fail closed). Read-back of an earlier send is never admitted here: it is not an action.
    /// </summary>
    public sealed class AutomationBudgets
    {
        private readonly AcquireDatabase _db;
        private readonly Func<PluginConfiguration> _config;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Tests: runs as an admission starts, before it waits for the database writer.</summary>
        internal Action? BeforeAdmission { get; set; }

        /// <summary>Creates the budgets (DI).</summary>
        public AutomationBudgets(AcquireDatabase db)
            : this(db, () => JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration(), () => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>Creates the budgets over an explicit configuration and clock (tests).</summary>
        internal AutomationBudgets(AcquireDatabase db, Func<PluginConfiguration> config, Func<DateTimeOffset> now)
        {
            _db = db;
            _config = config;
            _now = now;
        }

        /// <summary>The windows of a category as configured now (limits clamped to 0..100000; 0 admits nothing).</summary>
        /// <param name="category">Budget category.</param>
        public IReadOnlyList<BudgetWindow> Windows(string category)
        {
            var c = _config();
            static int Clamp(int v) => Math.Clamp(v, 0, 100_000);
            return category switch
            {
                BudgetCategories.HouseholdAdd => new[] { new BudgetWindow(TimeSpan.FromDays(1), Clamp(c.ArrAutomationHouseholdAddsPerDay)) },
                BudgetCategories.Search => new[] { new BudgetWindow(TimeSpan.FromHours(1), Clamp(c.ArrAutomationSearchesPerHour)), new BudgetWindow(TimeSpan.FromDays(1), Clamp(c.ArrAutomationSearchesPerDay)) },
                BudgetCategories.SeerrPost => new[] { new BudgetWindow(TimeSpan.FromDays(1), Clamp(c.ArrAutomationSeerrPostsPerDay)) },
                BudgetCategories.Backfill => new[] { new BudgetWindow(TimeSpan.FromHours(1), Clamp(c.ArrAutomationBackfillPerHour)) },
                BudgetCategories.SourceFetch => new[] { new BudgetWindow(TimeSpan.FromHours(1), Clamp(c.ArrAutomationSourceFetchesPerHour)) },
                BudgetCategories.DeltaWork => new[] { new BudgetWindow(TimeSpan.FromHours(1), Clamp(c.ArrAutomationDeltaWorkPerHour)) },
                _ => Array.Empty<BudgetWindow>(),
            };
        }

        /// <summary>
        /// Admits one unique action against every window of the category, or refuses it. A unique key admitted before
        /// (and not released) is a replay: admitted, nothing new counted. The reserved category for backfill refuses with
        /// <c>not_implemented</c>.
        /// </summary>
        /// <param name="category">Budget category.</param>
        /// <param name="scope">Household, an instance id, or the Seerr source.</param>
        /// <param name="uniqueKey">What makes the action unique (a job and its step).</param>
        /// <param name="jobId">The outbox job, when there is one.</param>
        /// <param name="recipe">The recipe, for reports.</param>
        public BudgetAdmission Admit(string category, string scope, string uniqueKey, string? jobId = null, string? recipe = null)
        {
            BeforeAdmission?.Invoke();
            if (category == BudgetCategories.Backfill) return new(false, null, "not_implemented", null);
            if (string.IsNullOrEmpty(scope) || string.IsNullOrEmpty(uniqueKey) || uniqueKey.Length > 512) return new(false, null, "invalid_budget", null);
            try
            {
                if (!_db.Available) return new(false, null, "accounting_unavailable", null);
                return _db.Write((c, t) =>
                {
                    // The limits and the clock are read once the writer is taken: a limit saved while the admission waited
                    // for it applies (4a-security-r6-1).
                    var now = _now();
                    var windows = Windows(category);
                    if (windows.Count == 0) return new BudgetAdmission(false, null, "invalid_budget", null);
                    string? existing = null, state = null;
                    using (var cmd = RequestLedger.Cmd(c, t, "SELECT id,state FROM automation_budget WHERE category=$c AND scope=$s AND unique_key=$k", ("$c", category), ("$s", scope), ("$k", uniqueKey)))
                    using (var r = cmd.ExecuteReader())
                    {
                        if (r.Read()) { existing = r.GetString(0); state = r.GetString(1); }
                    }

                    if (existing != null && state != "released") return new BudgetAdmission(true, existing, null, null, Replayed: true);
                    if (Full(windows.Select(w => Count(c, t, category, scope, w, now)), now) is { } full) return full;

                    var id = existing ?? RequestLedger.NewId();
                    if (existing == null)
                        RequestLedger.Exec(c, t, "INSERT INTO automation_budget(id,category,scope,unique_key,job_id,recipe,state,reserved_at) VALUES($id,$c,$s,$k,$j,$r,'reserved',$at)",
                            ("$id", id), ("$c", category), ("$s", scope), ("$k", uniqueKey), ("$j", jobId), ("$r", recipe), ("$at", RequestLedger.Ms(now)));
                    else
                        RequestLedger.Exec(c, t, "UPDATE automation_budget SET state='reserved',outcome=NULL,settled_at=NULL,reserved_at=$at,job_id=$j WHERE id=$id", ("$id", id), ("$j", jobId), ("$at", RequestLedger.Ms(now)));
                    return new BudgetAdmission(true, id, null, null);
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                return new(false, null, "accounting_unavailable", null);
            }
        }

        /// <summary>
        /// Checks an admitted action again inside the transport, against the limits and the time as they are now: it still fits
        /// when every window has room for one more besides everything else counted there (its own row counted once, not as
        /// a second action). Changes nothing: a refusal is released by the admission's owner, which releases only what this
        /// attempt reserved (a row counted earlier, sent or replayed, stays counted).
        /// </summary>
        /// <param name="category">The category.</param>
        /// <param name="scope">The scope.</param>
        /// <param name="id">The current reservation (or an earlier admission replayed by this job).</param>
        public BudgetAdmission Recheck(string category, string scope, string id)
        {
            try
            {
                if (!_db.Available) return new(false, null, "accounting_unavailable", null);
                return _db.Read(c =>
                {
                    var now = _now();
                    var windows = Windows(category);
                    using var own = RequestLedger.Cmd(c, null, "SELECT state FROM automation_budget WHERE id=$id AND category=$c AND scope=$s", ("$id", id), ("$c", category), ("$s", scope));
                    if (own.ExecuteScalar() is not string state || state == "released" || windows.Count == 0)
                        return new BudgetAdmission(false, null, "accounting_unavailable", null);
                    // Everything else in each window, then room for this one.
                    return Full(windows.Select(w => Count(c, null, category, scope, w, now, id)), now) ?? new BudgetAdmission(true, id, null, null, Replayed: true);
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                return new(false, null, "accounting_unavailable", null);
            }
        }

        /// <summary>
        /// Records how an admitted action ended. Only a reservation still in flight (or uncertain) changes: an action
        /// counted as sent stays counted.
        /// </summary>
        /// <param name="id">The reservation.</param>
        /// <param name="outcome">How it ended.</param>
        public void Settle(string id, BudgetOutcome outcome)
        {
            var (state, label) = outcome switch
            {
                BudgetOutcome.Sent => ("consumed", "sent"),
                BudgetOutcome.MaybeSent => ("ambiguous", "maybe_sent"),
                BudgetOutcome.AlreadyThere => ("released", "confirmed_existing"),
                _ => ("released", "not_sent"),
            };
            try
            {
                if (!_db.Available) return;
                _db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE automation_budget SET state=$s,outcome=$o,settled_at=$at WHERE id=$id AND state IN ('reserved','ambiguous')",
                    ("$s", state), ("$o", label), ("$at", RequestLedger.Ms(_now())), ("$id", id)));
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // The row stays reserved and keeps counting: conservative.
            }
        }

        /// <summary>
        /// A job's uncertain actions after its read-back: confirmed (counted as sent) or proven not there (released).
        /// Anything else leaves them uncertain and counted. Returns the rows changed.
        /// </summary>
        /// <param name="jobId">The job.</param>
        /// <param name="confirmed">The read-back confirmed the job.</param>
        /// <param name="notThere">The read-back proved nothing of it is upstream.</param>
        public int SettleJob(string jobId, bool confirmed, bool notThere)
        {
            if (!confirmed && !notThere) return 0;
            try
            {
                if (!_db.Available) return 0;
                return _db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE automation_budget SET state=$s,outcome=$o,settled_at=$at WHERE job_id=$j AND state IN ('ambiguous','reserved')",
                    ("$s", confirmed ? "consumed" : "released"), ("$o", confirmed ? "confirmed" : "not_there"), ("$at", RequestLedger.Ms(_now())), ("$j", jobId)));
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                return 0;
            }
        }

        /// <summary>A budget's usage per window (no write). Unavailable accounting reads as full.</summary>
        /// <param name="category">Budget category.</param>
        /// <param name="scope">Scope.</param>
        public IReadOnlyList<BudgetUsage> Usage(string category, string scope)
        {
            var now = _now();
            var windows = Windows(category);
            try
            {
                if (!_db.Available) return windows.Select(w => new BudgetUsage(category, scope, w.Length, w.Limit, w.Limit, 0, null, null)).ToList();
                return _db.Read(c => windows.Select(w => Count(c, null, category, scope, w, now)).ToList());
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                return windows.Select(w => new BudgetUsage(category, scope, w.Length, w.Limit, w.Limit, 0, null, null)).ToList();
            }
        }

        /// <summary>Every scope a category has been used in within the last 24 hours (for status), plus the ones named.</summary>
        /// <param name="category">Budget category.</param>
        /// <param name="named">Scopes always listed.</param>
        public IReadOnlyList<string> Scopes(string category, IEnumerable<string> named)
        {
            var scopes = new SortedSet<string>(named, StringComparer.Ordinal);
            try
            {
                if (!_db.Available) return scopes.ToList();
                _db.Read(c =>
                {
                    using var cmd = RequestLedger.Cmd(c, null, "SELECT DISTINCT scope FROM automation_budget WHERE category=$c AND reserved_at>$since", ("$c", category), ("$since", RequestLedger.Ms(_now().AddDays(-1))));
                    using var r = cmd.ExecuteReader();
                    while (r.Read()) scopes.Add(r.GetString(0));
                    return 0;
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // Status only.
            }

            return scopes.ToList();
        }

        /// <summary>
        /// The full window that waits longest for its next free slot, or null when every window has room (no write). The
        /// same answer an admission's refusal gives.
        /// </summary>
        /// <param name="category">Budget category.</param>
        /// <param name="scope">Scope.</param>
        public BudgetUsage? Exhausted(string category, string scope) => Blocking(Usage(category, scope), _now());

        // Every window is counted: the refusal waits for the latest next slot among the full ones (the hourly window can
        // free up long before the daily one does; 4a-behaviour-r7-1).
        private static BudgetAdmission? Full(IEnumerable<BudgetUsage> usages, DateTimeOffset now)
            => Blocking(usages, now) is { } blocking ? new BudgetAdmission(false, null, "budget_exhausted", NextSlot(blocking, now), Window: blocking.Window) : null;

        private static BudgetUsage? Blocking(IEnumerable<BudgetUsage> usages, DateTimeOffset now)
            => usages.Where(u => u.Full).OrderByDescending(u => NextSlot(u, now)).FirstOrDefault();

        // A window with a limit of 0 never frees a slot: it is checked again after its length.
        private static DateTimeOffset NextSlot(BudgetUsage usage, DateTimeOffset now) => usage.NextSlotAt ?? now + usage.Window;

        private static BudgetUsage Count(SqliteConnection c, SqliteTransaction? t, string category, string scope, BudgetWindow window, DateTimeOffset now, string? ownId = null)
        {
            var since = RequestLedger.Ms(now - window.Length);
            var stamps = new List<(long At, bool Uncertain)>();
            using (var cmd = RequestLedger.Cmd(c, t, "SELECT reserved_at,state FROM automation_budget WHERE category=$c AND scope=$s AND state IN ('reserved','consumed','ambiguous') AND reserved_at>$since AND ($own IS NULL OR id<>$own) ORDER BY reserved_at",
                ("$c", category), ("$s", scope), ("$since", since), ("$own", ownId)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read()) stamps.Add((r.GetInt64(0), r.GetString(1) == "ambiguous"));
            }

            DateTimeOffset At(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms) + window.Length;
            DateTimeOffset? next = null;
            if (stamps.Count >= window.Limit)
            {
                // To admit one more, (used - limit + 1) of the oldest must leave the window.
                var index = stamps.Count - window.Limit;
                next = index < stamps.Count ? At(stamps[index].At) : now;
                if (window.Limit == 0) next = null;
            }

            return new BudgetUsage(category, scope, window.Length, stamps.Count, window.Limit, stamps.Count(s => s.Uncertain), next, stamps.Count == 0 ? null : At(stamps[0].At));
        }

        /// <summary>Formats a window length for status (1h, 24h).</summary>
        /// <param name="window">Window.</param>
        public static string Label(TimeSpan window) => ((int)window.TotalHours).ToString(CultureInfo.InvariantCulture) + "h";
    }
}
