using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>The kind of upstream write a send admits right before it leaves.</summary>
    public enum SendWriteKind
    {
        /// <summary>Adding a title to Sonarr/Radarr, or switching on monitoring of more of it.</summary>
        Add,

        /// <summary>A Sonarr/Radarr search command.</summary>
        Search,

        /// <summary>Jellyfin Enhanced's POST of a request to Seerr.</summary>
        Post,
    }

    /// <summary>How an admitted write ended.</summary>
    public enum SendWriteResult
    {
        /// <summary>It went out.</summary>
        Sent,

        /// <summary>It definitely didn't go out.</summary>
        NotSent,

        /// <summary>Its answer was lost: it may have gone out.</summary>
        MaybeSent,

        /// <summary>The upstream already had it (an add of a title already there).</summary>
        AlreadyThere,
    }

    /// <summary>A write refused at admission: why, the administrator's wording, and when to try again.</summary>
    /// <param name="Reason">Reason code (budget_exhausted, accounting_unavailable).</param>
    /// <param name="Message">Administrator wording.</param>
    /// <param name="Wait">Wait before the next attempt.</param>
    public sealed record SendRefusal(string Reason, string Message, TimeSpan Wait);

    /// <summary>
    /// Per-write admission for one automatic job, asked by the backend right before each write leaves (after the final
    /// guard) and told how it ended. Interactive work has none.
    /// </summary>
    public interface ISendAdmission
    {
        /// <summary>Admits one write; null when it may go, else why not.</summary>
        /// <param name="kind">The write.</param>
        /// <param name="detail">What makes it unique inside the job (the command and its ids).</param>
        SendRefusal? Admit(SendWriteKind kind, string detail);

        /// <summary>
        /// Asked inside the transport (<see cref="AutomationTransportHandler"/>): the writes admitted and not settled yet,
        /// checked again against each budget's limits as they are now, each counting its own row once (null: they still fit).
        /// </summary>
        SendRefusal? Recheck();

        /// <summary>
        /// The transport refused the write: what this attempt reserved and hasn't settled is released (not sent). Rows
        /// counted earlier (a write sent, or replayed from an earlier one) stay counted.
        /// </summary>
        void Release();

        /// <summary>How the write admitted last for <paramref name="kind"/> and <paramref name="detail"/> ended.</summary>
        /// <param name="kind">The write.</param>
        /// <param name="detail">Its detail as admitted.</param>
        /// <param name="result">How it ended.</param>
        void Settled(SendWriteKind kind, string detail, SendWriteResult result);
    }

    /// <summary>Why an automatic job is held at send, and for how long (or parked for a person).</summary>
    /// <param name="Reason">Reason code.</param>
    /// <param name="Message">Administrator wording.</param>
    /// <param name="Wait">Wait before the next check (ignored when parked).</param>
    /// <param name="Park">A person has to look at it (an OK is now required; the recipe can't run here).</param>
    public sealed record AutomationHold(string Reason, string Message, TimeSpan Wait, bool Park = false);

    /// <summary>The automatic-send hold reasons and their waits.</summary>
    public static class AutomationHolds
    {
        /// <summary>The rollout Shadow override is on.</summary>
        public const string ShadowOverride = "shadow_override";

        /// <summary>Work only phase 4 creates while phase 4 (or its engine) is off.</summary>
        public const string Phase4Off = "phase4_off";

        /// <summary>A kill switch is on (global, the recipe's or the target's).</summary>
        public const string Killed = "automation_killed";

        /// <summary>The recipe is now Off or Shadow, or an old recipe's own switch is off.</summary>
        public const string RecipePaused = "recipe_paused";

        /// <summary>The target's circuit breaker is open.</summary>
        public const string BreakerOpen = "breaker_open";

        /// <summary>A budget window is full.</summary>
        public const string BudgetExhausted = "budget_exhausted";

        /// <summary>The budgets can't be counted (database unavailable): nothing automatic goes out.</summary>
        public const string AccountingUnavailable = "accounting_unavailable";

        /// <summary>The drive the download would land on is below the low-disk threshold.</summary>
        public const string LowDisk = "low_disk";

        /// <summary>The destination's free space isn't known yet.</summary>
        public const string DiskUnknown = "disk_unknown";

        /// <summary>An OK is required now (Ask mode, or the person isn't eligible).</summary>
        public const string ApprovalRequired = "approval_required";

        /// <summary>The recipe needs Sonarr/Radarr handling and Seerr handles requests.</summary>
        public const string SeerrUnsupported = "seerr_unsupported";

        /// <summary>
        /// The automation engine was turned on or off after the send started: the attempt starts again under the current
        /// rules (its budgets and checks) instead of sending with the ones it started with.
        /// </summary>
        public const string EngineChanged = "automation_changed";

        /// <summary>The person opted out of the recipe after its request was queued: it waits (a read-back still runs).</summary>
        public const string UserOptedOut = "user_opted_out";

        private static readonly Dictionary<string, TimeSpan> Waits = new(StringComparer.Ordinal)
        {
            [ShadowOverride] = TimeSpan.FromMinutes(15),
            [Phase4Off] = TimeSpan.FromMinutes(15),
            [Killed] = TimeSpan.FromMinutes(5),
            [RecipePaused] = TimeSpan.FromMinutes(15),
            [BreakerOpen] = TimeSpan.FromMinutes(5),
            [BudgetExhausted] = TimeSpan.FromMinutes(15),
            [AccountingUnavailable] = TimeSpan.FromMinutes(5),
            [LowDisk] = TimeSpan.FromMinutes(30),
            [DiskUnknown] = TimeSpan.FromMinutes(2),
            [EngineChanged] = TimeSpan.FromSeconds(30),
            [UserOptedOut] = TimeSpan.FromMinutes(15),
        };

        /// <summary>True for a hold that waits and is checked again by itself (not parked for a person).</summary>
        /// <param name="reason">Reason code.</param>
        public static bool IsWait(string? reason) => reason != null && Waits.ContainsKey(reason);

        /// <summary>The wait of a hold reason (five minutes for one not listed).</summary>
        /// <param name="reason">Reason code.</param>
        public static TimeSpan WaitFor(string reason) => Waits.TryGetValue(reason, out var wait) ? wait : TimeSpan.FromMinutes(5);
    }

    /// <summary>
    /// The send-time side of automation for queued work (recipes, list sync, work only phase 4 creates). People's own
    /// asks are never touched. Its <see cref="Gate"/> is the one <see cref="AutomationWriteGate"/> the outbox asks before
    /// any transport and the backends ask again immediately before every write; it also builds the per-write budget
    /// admission, and counts breakers and settles budgets after an attempt. With the engine off, the existing recipes'
    /// queued work goes out as before; only the rollout Shadow override, an old recipe's own switch turned off, the request
    /// path changing and phase-4-only origins hold then.
    /// </summary>
    public sealed class AutomationSendGuard
    {
        private readonly IRequestPolicy _policy;
        private readonly AutomationBudgets _budgets;
        private readonly AutomationStore _store;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the guard (DI).</summary>
        public AutomationSendGuard(IRequestPolicy policy, AutomationBudgets budgets, AutomationStore store, AutomationEligibility eligibility, IAutomationConsents consents)
            : this(policy, budgets, store, eligibility, () => DateTimeOffset.UtcNow, consents)
        {
        }

        /// <summary>Creates the guard with an explicit clock (tests).</summary>
        internal AutomationSendGuard(IRequestPolicy policy, AutomationBudgets budgets, AutomationStore store, AutomationEligibility eligibility, Func<DateTimeOffset> now, IAutomationConsents? consents = null)
        {
            _policy = policy;
            _budgets = budgets;
            _store = store;
            _now = now;
            Gate = new AutomationWriteGate(() => policy.Configuration, policy, budgets, store, eligibility, consents, now);
        }

        /// <summary>The budgets.</summary>
        public AutomationBudgets Budgets => _budgets;

        /// <summary>The automation store (breakers).</summary>
        public AutomationStore Store => _store;

        /// <summary>The write gate every automatic write of a queued job passes, before any transport and before each write.</summary>
        public AutomationWriteGate Gate { get; }

        /// <summary>The target a job's sends go to, for kills and breakers: its instance (Sonarr/Radarr) or <c>seerr</c>.</summary>
        /// <param name="job">The job.</param>
        public static string Target(RequestJob job) => job.Authorization.Backend == "seerr" ? AutomationFlags.SeerrTarget : job.Authorization.InstanceId;

        /// <summary>
        /// True when a kill switch stops automatic work of <paramref name="recipe"/> to <paramref name="target"/>: the global
        /// one, the recipe's, or the target's. Kills act only with the engine on (callers check it).
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <param name="recipe">Recipe id (null: none).</param>
        /// <param name="target">Instance id or <c>seerr</c>.</param>
        public static bool Killed(PluginConfiguration config, string? recipe, string? target)
            => AutomationFlags.KilledAll(config) || (recipe != null && AutomationModes.Killed(config, recipe)) || AutomationFlags.KilledTarget(config, target);

        /// <summary>The kill-switch target a request with these facts would go to: its instance, or <c>seerr</c>.</summary>
        /// <param name="facts">The requester's current facts.</param>
        public static string Target(RequestPolicyFacts facts) => facts.Backend == "seerr" ? AutomationFlags.SeerrTarget : facts.InstanceId;

        /// <summary>True when the guard applies to the want at all (an automatic or phase-4-only origin).</summary>
        /// <param name="want">The want.</param>
        public static bool Applies(RequestWant? want) => want != null && (RequestOrigin.IsAutomatic(want.OriginKind) || RequestOrigin.IsPhase4Only(want.OriginKind, want.OriginSource));

        /// <summary>
        /// Why the job may not be sent now (null: it may): the write gate for this job. <paramref name="budgetedAtStart"/>
        /// null is the check before any transport; otherwise whether the attempt chose a budget admission, asked
        /// immediately before each write. Never asked for a read-back.
        /// </summary>
        /// <param name="job">The job.</param>
        /// <param name="want">Its want (null: not this guard's).</param>
        /// <param name="budgetedAtStart">Null before any transport; else whether this attempt was admitted against budgets.</param>
        public AutomationHold? Hold(RequestJob job, RequestWant? want, bool? budgetedAtStart = null)
            => Gate.Check(AutomationWrite.ForJob(job, want, budgetedAtStart));

        /// <summary>The per-write admission for an automatic job under the engine; null for anything else.</summary>
        /// <param name="job">The job (its attempt count makes a resend's search a new search).</param>
        /// <param name="want">Its want.</param>
        public ISendAdmission? Admission(RequestJob job, RequestWant? want)
            => Budgeted(want) ? new JobAdmission(_budgets, job, RecipeOf(want!), _now) : null;

        /// <summary>
        /// True when the want's writes are admitted against the budgets now: an automatic origin with the engine on. An
        /// attempt that started the other way stops at its next write (see <see cref="AutomationHolds.EngineChanged"/>).
        /// </summary>
        /// <param name="want">The want.</param>
        public bool Budgeted(RequestWant? want) => want != null && RequestOrigin.IsAutomatic(want.OriginKind) && AutomationFlags.Engine(_policy.Configuration);

        /// <summary>
        /// After a job's attempt: counts a transport failure toward the target's breaker or closes it on success, and
        /// settles the job's uncertain budget rows when a read-back decided them.
        /// </summary>
        /// <param name="job">The job.</param>
        /// <param name="want">Its want.</param>
        /// <param name="result">The attempt's result.</param>
        /// <param name="transportStarted">Something was sent (or tried).</param>
        /// <param name="settledByRead">A fresh read decided the result.</param>
        public void Observe(RequestJob job, RequestWant? want, RequestBackendResult result, bool transportStarted, bool settledByRead)
        {
            if (want == null || !RequestOrigin.IsAutomatic(want.OriginKind)) return;
            var now = _now();
            if (result.Confirmed || (settledByRead && result.VerifiedNotSent))
                _budgets.SettleJob(job.Id, result.Confirmed, !result.Confirmed && result.VerifiedNotSent);
            if (!transportStarted) return;
            var target = Target(job);
            if (string.IsNullOrEmpty(target)) return;
            if (result.Confirmed) _store.Success(target, now);
            else if (result.Outcome.Reason is "backend_unavailable" or "service_down" or "maybe_sent" && !AutomationHolds.IsWait(result.Outcome.Reason))
                _store.Failure(target, result.Outcome.Reason, now);
        }

        /// <summary>The recipe a want's automatic work belongs to (list sync: its provenance's), or null.</summary>
        /// <param name="want">The want.</param>
        internal static string? RecipeOf(RequestWant want) => want.OriginKind == RequestOrigin.AutomationKind ? want.OriginSource
            : want.OriginKind == RequestOrigin.SyncKind ? RequestOriginDetail.Read(want.OriginDetail)?.Provenance?.Recipe ?? AutomationRecipes.ListSyncRequests : null;

        /// <summary>One job's admission: adds count once per job, each search and POST once per attempt.</summary>
        private sealed class JobAdmission : ISendAdmission
        {
            private readonly AutomationBudgets _budgets;
            private readonly RequestJob _job;
            private readonly string? _recipe;
            private readonly Func<DateTimeOffset> _now;
            // What this attempt reserved and hasn't settled (it settles them), and every admitted write not settled yet,
            // replays included (the transport checks those again).
            private readonly Dictionary<string, string> _reserved = new(StringComparer.Ordinal);
            private readonly Dictionary<string, (string Category, string Scope, string Id)> _active = new(StringComparer.Ordinal);

            public JobAdmission(AutomationBudgets budgets, RequestJob job, string? recipe, Func<DateTimeOffset> now) { _budgets = budgets; _job = job; _recipe = recipe; _now = now; }

            private (string Category, string Scope, string Key) Slot(SendWriteKind kind, string detail) => kind switch
            {
                SendWriteKind.Add => (BudgetCategories.HouseholdAdd, BudgetCategories.Household, "job:" + _job.Id),
                SendWriteKind.Search => (BudgetCategories.Search, _job.Authorization.InstanceId, "job:" + _job.Id + ":a" + (_job.Attempts + 1).ToString(CultureInfo.InvariantCulture) + ":" + detail),
                _ => (BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget, "job:" + _job.Id + ":a" + (_job.Attempts + 1).ToString(CultureInfo.InvariantCulture)),
            };

            public SendRefusal? Admit(SendWriteKind kind, string detail)
            {
                var (category, scope, key) = Slot(kind, detail);
                var admission = _budgets.Admit(category, scope, key, _job.Id, _recipe);
                if (admission.Admitted)
                {
                    // Only a write that reserved here settles the row: a replayed add (an earlier write of this job) stays as it was.
                    if (admission.Id != null)
                    {
                        _active[kind + "|" + detail] = (category, scope, admission.Id);
                        if (!admission.Replayed) _reserved[kind + "|" + detail] = admission.Id;
                    }
                    return null;
                }

                return Refusal(category, admission);
            }

            public SendRefusal? Recheck()
            {
                foreach (var slot in _active.Values)
                {
                    var now = _budgets.Recheck(slot.Category, slot.Scope, slot.Id);
                    if (!now.Admitted) return Refusal(slot.Category, now);
                }
                return null;
            }

            private SendRefusal Refusal(string category, BudgetAdmission admission)
            {
                var wait = admission.RetryAt is { } at ? at - _now() : AutomationHolds.WaitFor(admission.Reason ?? AutomationHolds.AccountingUnavailable);
                if (wait < TimeSpan.FromSeconds(30)) wait = TimeSpan.FromSeconds(30);
                return admission.Reason == "budget_exhausted"
                    ? new SendRefusal(AutomationHolds.BudgetExhausted, "The " + category + " budget is used up; the request waits for room.", wait)
                    : new SendRefusal(AutomationHolds.AccountingUnavailable, "Automatic sends can't be counted right now (" + admission.Reason + "); nothing was sent.", wait);
            }

            public void Release()
            {
                foreach (var id in _reserved.Values) _budgets.Settle(id, BudgetOutcome.NotSent);
                _reserved.Clear();
                _active.Clear();
            }

            public void Settled(SendWriteKind kind, string detail, SendWriteResult result)
            {
                _active.Remove(kind + "|" + detail);
                if (!_reserved.Remove(kind + "|" + detail, out var id)) return;
                _budgets.Settle(id, result switch
                {
                    SendWriteResult.Sent => BudgetOutcome.Sent,
                    SendWriteResult.MaybeSent => BudgetOutcome.MaybeSent,
                    SendWriteResult.AlreadyThere => BudgetOutcome.AlreadyThere,
                    _ => BudgetOutcome.NotSent,
                });
            }
        }
    }
}
