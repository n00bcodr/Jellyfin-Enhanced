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

        /// <summary>The recipe is now Off or Shadow.</summary>
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
        };

        /// <summary>True for a hold that waits and is checked again by itself (not parked for a person).</summary>
        /// <param name="reason">Reason code.</param>
        public static bool IsWait(string? reason) => reason != null && Waits.ContainsKey(reason);

        /// <summary>The wait of a hold reason (five minutes for one not listed).</summary>
        /// <param name="reason">Reason code.</param>
        public static TimeSpan WaitFor(string reason) => Waits.TryGetValue(reason, out var wait) ? wait : TimeSpan.FromMinutes(5);
    }

    /// <summary>
    /// The send-time guard for automatic work (recipes, list sync) and for work only phase 4 creates. Interactive asks
    /// are never touched. Asked by the outbox before any transport and again at every write (kills between writes),
    /// and it builds the per-write budget admission. With the engine off, the existing recipes' queued work goes out
    /// as before; only the rollout Shadow override and phase-4-only origins hold then.
    /// </summary>
    public sealed class AutomationSendGuard
    {
        private readonly IRequestPolicy _policy;
        private readonly AutomationBudgets _budgets;
        private readonly AutomationStore _store;
        private readonly AutomationEligibility _eligibility;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the guard (DI).</summary>
        public AutomationSendGuard(IRequestPolicy policy, AutomationBudgets budgets, AutomationStore store, AutomationEligibility eligibility)
            : this(policy, budgets, store, eligibility, () => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>Creates the guard with an explicit clock (tests).</summary>
        internal AutomationSendGuard(IRequestPolicy policy, AutomationBudgets budgets, AutomationStore store, AutomationEligibility eligibility, Func<DateTimeOffset> now)
        {
            _policy = policy;
            _budgets = budgets;
            _store = store;
            _eligibility = eligibility;
            _now = now;
        }

        /// <summary>The budgets.</summary>
        public AutomationBudgets Budgets => _budgets;

        /// <summary>The automation store (breakers).</summary>
        public AutomationStore Store => _store;

        /// <summary>The target a job's sends go to, for kills and breakers: its instance (Sonarr/Radarr) or <c>seerr</c>.</summary>
        /// <param name="job">The job.</param>
        public static string Target(RequestJob job) => job.Authorization.Backend == "seerr" ? AutomationFlags.SeerrTarget : job.Authorization.InstanceId;

        /// <summary>True when the guard applies to the want at all (an automatic or phase-4-only origin).</summary>
        /// <param name="want">The want.</param>
        public static bool Applies(RequestWant? want) => want != null && (RequestOrigin.IsAutomatic(want.OriginKind) || RequestOrigin.IsPhase4Only(want.OriginKind, want.OriginSource));

        /// <summary>
        /// Why the job may not be sent now (null: it may). Checked before any transport, and again before every write.
        /// Never asked for a read-back.
        /// </summary>
        /// <param name="job">The job.</param>
        /// <param name="want">Its want (null: not this guard's).</param>
        /// <param name="preTransport">The check before any transport (budgets and disk are checked there only).</param>
        public AutomationHold? Hold(RequestJob job, RequestWant? want, bool preTransport = true)
        {
            if (!Applies(want)) return null;
            var config = _policy.Configuration;
            var automatic = RequestOrigin.IsAutomatic(want!.OriginKind);
            if (automatic && AutomationFlags.ShadowOverride(config))
                return new(AutomationHolds.ShadowOverride, "The rollout Shadow override is on: automatic requests are recorded, never sent.", AutomationHolds.WaitFor(AutomationHolds.ShadowOverride));
            var phase4Only = RequestOrigin.IsPhase4Only(want.OriginKind, want.OriginSource);
            if (phase4Only && !(automatic ? AutomationFlags.Engine(config) : AutomationFlags.Phase4WithRequests(config)))
                return new(AutomationHolds.Phase4Off, "Phase 4 (or its automation engine) is off: work it created waits.", AutomationHolds.WaitFor(AutomationHolds.Phase4Off));
            if (!automatic || !AutomationFlags.Engine(config)) return null;

            var recipe = RecipeOf(want);
            var target = Target(job);
            if (AutomationFlags.KilledAll(config) || (recipe != null && AutomationModes.Killed(config, recipe)) || AutomationFlags.KilledTarget(config, target))
                return new(AutomationHolds.Killed, "A kill switch is on: automatic requests wait until it is off.", AutomationHolds.WaitFor(AutomationHolds.Killed));
            var mode = recipe == null ? AutomationMode.Shadow : AutomationModes.Mode(config, recipe);
            if (mode is AutomationMode.Off or AutomationMode.Shadow)
                return new(AutomationHolds.RecipePaused, "The recipe is now " + AutomationModes.Name(mode) + ": its queued request waits.", AutomationHolds.WaitFor(AutomationHolds.RecipePaused));
            if (job.Authorization.Backend == "seerr" && AutomationRecipes.RequiresDirect(recipe))
                return new(AutomationHolds.SeerrUnsupported, "This recipe needs Sonarr/Radarr handling; Seerr handles requests now.", TimeSpan.Zero, Park: true);
            if (job.Authorization.Approver == null)
            {
                var role = _policy.Evaluate(job.Authorization.Requester, job.Input).Role;
                if (mode == AutomationMode.Ask || !_eligibility.Eligible(job.Authorization.Requester, role))
                    return new(AutomationHolds.ApprovalRequired, "An OK is required now (Ask mode, or the person isn't eligible for automatic requests).", TimeSpan.Zero, Park: true);
            }

            var now = _now();
            var breaker = _store.Breaker(target);
            if (breaker.Open(now))
                return new(AutomationHolds.BreakerOpen, "Automatic sends to this target failed " + breaker.Failures.ToString(CultureInfo.InvariantCulture) + " times in a row; paused until " + breaker.OpenUntil!.Value.ToString("u", CultureInfo.InvariantCulture) + ".", Until(breaker.OpenUntil!.Value, now));
            if (!preTransport) return null;

            if (_policy.TitlePause(job.Input) != null)
                return new(AutomationHolds.LowDisk, "The drive it would land on is below the low-disk threshold.", AutomationHolds.WaitFor(AutomationHolds.LowDisk));
            if (job.Authorization.Backend == "je" && config.ArrLowDiskPercent > 0 && !_policy.DiskKnown(job.Input))
                return new(AutomationHolds.DiskUnknown, "The destination's free space isn't known yet; automatic sends wait for it.", AutomationHolds.WaitFor(AutomationHolds.DiskUnknown));

            var exhausted = job.Authorization.Backend == "seerr"
                ? _budgets.Exhausted(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget)
                : _budgets.Exhausted(BudgetCategories.Search, target);
            if (exhausted != null)
                return new(AutomationHolds.BudgetExhausted, "The " + exhausted.Category + " budget (" + AutomationBudgets.Label(exhausted.Window) + ") is used up.", Until(exhausted.NextSlotAt ?? now + exhausted.Window, now));
            return null;
        }

        /// <summary>The per-write admission for an automatic job under the engine; null for anything else.</summary>
        /// <param name="job">The job (its attempt count makes a resend's search a new search).</param>
        /// <param name="want">Its want.</param>
        public ISendAdmission? Admission(RequestJob job, RequestWant? want)
        {
            if (want == null || !RequestOrigin.IsAutomatic(want.OriginKind) || !AutomationFlags.Engine(_policy.Configuration)) return null;
            return new JobAdmission(_budgets, job, RecipeOf(want), _now);
        }

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

        private static TimeSpan Until(DateTimeOffset at, DateTimeOffset now) => at > now ? at - now + TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(30);

        private static string? RecipeOf(RequestWant want) => want.OriginKind == RequestOrigin.AutomationKind ? want.OriginSource
            : want.OriginKind == RequestOrigin.SyncKind ? RequestOriginDetail.Read(want.OriginDetail)?.Provenance?.Recipe ?? AutomationRecipes.ListSyncRequests : null;

        /// <summary>One job's admission: adds count once per job, each search and POST once per attempt.</summary>
        private sealed class JobAdmission : ISendAdmission
        {
            private readonly AutomationBudgets _budgets;
            private readonly RequestJob _job;
            private readonly string? _recipe;
            private readonly Func<DateTimeOffset> _now;
            private readonly Dictionary<string, string> _reserved = new(StringComparer.Ordinal);

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
                    if (!admission.Replayed && admission.Id != null) _reserved[kind + "|" + detail] = admission.Id;
                    return null;
                }

                var wait = admission.RetryAt is { } at ? at - _now() : AutomationHolds.WaitFor(admission.Reason ?? AutomationHolds.AccountingUnavailable);
                if (wait < TimeSpan.FromSeconds(30)) wait = TimeSpan.FromSeconds(30);
                return admission.Reason == "budget_exhausted"
                    ? new SendRefusal(AutomationHolds.BudgetExhausted, "The " + category + " budget is used up; the request waits for room.", wait)
                    : new SendRefusal(AutomationHolds.AccountingUnavailable, "Automatic sends can't be counted right now (" + admission.Reason + "); nothing was sent.", wait);
            }

            public void Settled(SendWriteKind kind, string detail, SendWriteResult result)
            {
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
