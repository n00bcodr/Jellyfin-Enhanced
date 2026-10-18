using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// What a recipe decided, in any mode. <c>Outcome</c>: would_request (would go out now), would_ask (would wait for an
    /// OK), would_follow (scope someone already asked for), already_recorded, blocked (refused: <c>Reason</c>), deferred
    /// (couldn't be worked out now), killed, and, outside Shadow, the actual result (recorded, asked). <c>Key</c> makes
    /// it unique: the same trigger again is the same decision.
    /// </summary>
    public sealed record AutomationDecision(string Key, string Recipe, Guid? User, string? TitleKey, AutomationMode Mode, string Outcome, string Reason, string? Backend, AutomationDecisionDetail? Detail = null);

    /// <summary>
    /// The predicted effects behind a decision: the request's would-be status, cost (the person's allowance) and size
    /// estimate, whether it would go out, the instance, and the budgets it would draw on. Nothing here was reserved.
    /// </summary>
    public sealed record AutomationDecisionDetail
    {
        /// <summary>Would-be request status (queued, pending, sent).</summary>
        [JsonPropertyName("status")] public string? Status { get; init; }

        /// <summary>Allowance it would cost the person.</summary>
        [JsonPropertyName("cost")] public int Cost { get; init; }

        /// <summary>Estimated GB.</summary>
        [JsonPropertyName("gb")] public double EstimatedGb { get; init; }

        /// <summary>It would send something (an add, a monitor change or a search; a POST to Seerr).</summary>
        [JsonPropertyName("wouldSend")] public bool WouldSend { get; init; }

        /// <summary>It would wait for an OK, and why (ask mode, not eligible, the household's rules).</summary>
        [JsonPropertyName("approval")] public string? Approval { get; init; }

        /// <summary>The instance it would go to (Sonarr/Radarr handling).</summary>
        [JsonPropertyName("instance")] public string? Instance { get; init; }

        /// <summary>The scope.</summary>
        [JsonPropertyName("scope")] public string? Scope { get; init; }

        /// <summary>The edition.</summary>
        [JsonPropertyName("variant")] public string? Variant { get; init; }

        /// <summary>The seasons.</summary>
        [JsonPropertyName("seasons")] public int[]? Seasons { get; init; }

        /// <summary>Recorded because the rollout Shadow override is on (whatever the recipe's own mode).</summary>
        [JsonPropertyName("override"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool ShadowOverride { get; init; }

        /// <summary>Budgets it would draw on, with what is left now (Shadow: what Auto would have used).</summary>
        [JsonPropertyName("budgets")] public IReadOnlyList<AutomationBudgetEffect>? Budgets { get; init; }
    }

    /// <summary>One budget a decision would draw on: its category, scope and the room left in its tightest window.</summary>
    public sealed record AutomationBudgetEffect(
        [property: JsonPropertyName("category")] string Category,
        [property: JsonPropertyName("scope")] string Scope,
        [property: JsonPropertyName("remaining")] int Remaining,
        [property: JsonPropertyName("nextSlotAt")] DateTimeOffset? NextSlotAt);

    /// <summary>The seam a household role policy (phase 4b, the Trusted role) plugs into; nobody is Trusted by default.</summary>
    public interface IAutomationTrust
    {
        /// <summary>True when the person's automatic requests may go ahead without an OK because they are Trusted.</summary>
        /// <param name="user">The person.</param>
        bool IsTrusted(Guid user);
    }

    /// <summary>The default: nobody is Trusted.</summary>
    public sealed class NoAutomationTrust : IAutomationTrust
    {
        /// <inheritdoc />
        public bool IsTrusted(Guid user) => false;
    }

    /// <summary>
    /// Who may have automatic requests go ahead without an OK while the engine is on: administrators by role, a Trusted
    /// person (the 4b seam), or a Manager with a recorded grant (Managers whose automatic requests went ahead before the
    /// migration). The grant stands for the Manager role it was recorded for: once its holder is a Member, it no longer
    /// counts (4a review round 10). Anyone else's automatic requests wait for an OK; Kids always do, Watchers never ask.
    /// </summary>
    public sealed class AutomationEligibility
    {
        private readonly AutomationStore _store;
        private readonly IAutomationTrust _trust;

        /// <summary>Creates the check (DI).</summary>
        public AutomationEligibility(AutomationStore store, IAutomationTrust trust) { _store = store; _trust = trust; }

        /// <summary>True when the person is eligible, and how: admin, trusted, grant; null when not.</summary>
        /// <param name="user">The person.</param>
        /// <param name="role">Their household role (Admin from Jellyfin).</param>
        public string? Why(Guid user, string role) => role == "Admin" ? "admin" : role is "Kid" or "Watcher" ? null : _trust.IsTrusted(user) ? "trusted" : role == "Manager" && _store.HasGrant(user) ? "grant" : null;

        /// <summary>The same rule on facts already read (the automatic-write check's decision).</summary>
        /// <param name="role">Their household role.</param>
        /// <param name="trusted">Whether they are Trusted (<see cref="Trusted"/>).</param>
        /// <param name="granted">Whether they hold a grant (<see cref="Granted"/>).</param>
        public static string? Why(string role, bool trusted, bool granted) => role == "Admin" ? "admin" : role is "Kid" or "Watcher" ? null : trusted ? "trusted" : granted && role == "Manager" ? "grant" : null;

        /// <summary>Whether the person is Trusted (the 4b seam; its implementations read memory only).</summary>
        /// <param name="user">The person.</param>
        public bool Trusted(Guid user) => _trust.IsTrusted(user);

        /// <summary>Whether the person holds a recorded grant (reads the database; false when it can't be read).</summary>
        /// <param name="user">The person.</param>
        public bool Granted(Guid user) => _store.HasGrant(user);

        /// <summary>True when the person's automatic requests may go ahead without an OK.</summary>
        /// <param name="user">The person.</param>
        /// <param name="role">Their household role.</param>
        public bool Eligible(Guid user, string role) => Why(user, role) != null;
    }

    /// <summary>
    /// The no-write decision seam: what an automatic (or list) ask would do now. It reads policy and the ledger (a
    /// rolled-back preview) and the budgets, and writes nothing: no want, approval, reservation, job, budget row or
    /// upstream call. Shadow mode records its answer as a decision; household rules and list previews read it too.
    /// </summary>
    public sealed class AutomationDecider
    {
        private readonly RequestService _requests;
        private readonly AutomationBudgets _budgets;
        private readonly AutomationEligibility _eligibility;

        /// <summary>Creates the seam (DI).</summary>
        public AutomationDecider(RequestService requests, AutomationBudgets budgets, AutomationEligibility eligibility)
        {
            _requests = requests;
            _budgets = budgets;
            _eligibility = eligibility;
        }

        /// <summary>The eligibility check.</summary>
        public AutomationEligibility Eligibility => _eligibility;

        /// <summary>
        /// Works out the origin an automatic ask is made with in <paramref name="mode"/> (Ask, or not eligible: it waits
        /// for an OK; free when the household made automatic requests free) without writing anything.
        /// </summary>
        /// <param name="origin">The base origin (recipe, list, sync).</param>
        /// <param name="mode">Effective mode.</param>
        /// <param name="user">The person it is for.</param>
        /// <param name="input">The scope.</param>
        public (RequestOrigin Origin, string? Approval) OriginFor(RequestOrigin origin, AutomationMode mode, Guid user, MutationInput input)
        {
            var role = _requests.Policy.Evaluate(user, input).Role;
            var approval = mode == AutomationMode.Ask ? "ask_mode" : _eligibility.Eligible(user, role) ? null : "not_eligible";
            return (origin with { RequireApproval = origin.RequireApproval || approval != null, Free = origin.Free || _requests.Policy.Configuration.ArrAutomationFree }, approval);
        }

        /// <summary>
        /// Previews an automatic ask and returns the decision (nothing written). <paramref name="mode"/> is the mode the
        /// recipe would act in (Shadow previews what Auto would do).
        /// </summary>
        /// <param name="key">The decision key (the trigger's identity).</param>
        /// <param name="recipe">The recipe.</param>
        /// <param name="user">The person it is for.</param>
        /// <param name="clientRequestId">The id the ask would use (its replay identity).</param>
        /// <param name="input">The scope.</param>
        /// <param name="origin">The base origin.</param>
        /// <param name="mode">The recipe's stored mode.</param>
        /// <param name="ct">Cancellation.</param>
        public async Task<AutomationDecision> DecideAsync(string key, string recipe, Guid user, string clientRequestId, MutationInput input, RequestOrigin origin, AutomationMode mode, CancellationToken ct)
        {
            var acting = mode == AutomationMode.Shadow ? AutomationMode.Auto : mode;
            var (withApproval, approval) = OriginFor(origin, acting, user, input);
            var preview = await _requests.PreviewAsync(user, new CreateRequest(clientRequestId, input), ct, withApproval).ConfigureAwait(false);
            var backend = _requests.Policy.Configuration.ArrRequestBackend;
            var o = preview.Outcome;
            var outcome = o.HttpStatus == 503 ? "deferred" : o.HttpStatus >= 400 ? "blocked" : !preview.New ? "already_recorded"
                : preview.Status == "pending" ? "would_ask" : preview.WouldSend ? "would_request" : "would_follow";
            var reason = outcome is "blocked" or "deferred" ? o.Reason : preview.Reason ?? o.Reason;
            var detail = new AutomationDecisionDetail
            {
                Status = preview.Status,
                Cost = preview.Cost,
                EstimatedGb = Math.Round(preview.EstimatedGb, 1),
                WouldSend = preview.WouldSend,
                Approval = preview.Status == "pending" ? approval ?? preview.Reason : null,
                Instance = string.IsNullOrEmpty(preview.InstanceId) ? null : preview.InstanceId,
                Scope = input.Scope,
                Variant = input.Variant,
                Seasons = input.Seasons.Length == 0 ? null : input.Seasons,
                Budgets = preview.WouldSend || outcome == "would_ask" ? Effects(backend, preview.InstanceId) : null,
            };
            return new AutomationDecision(key, recipe, user, input.Key, mode, outcome, reason, backend, detail);
        }

        /// <summary>The budgets a send would draw on now, with the room left in each (no write).</summary>
        /// <param name="backend">je or seerr.</param>
        /// <param name="instance">The Sonarr/Radarr instance (je).</param>
        public IReadOnlyList<AutomationBudgetEffect> Effects(string backend, string? instance)
        {
            var list = new List<AutomationBudgetEffect>();
            void Add(string category, string scope)
            {
                var usage = _budgets.Usage(category, scope);
                if (usage.Count == 0) return;
                var tightest = usage.OrderBy(u => u.Limit - u.Used).First();
                list.Add(new AutomationBudgetEffect(category, scope, Math.Max(0, tightest.Limit - tightest.Used), tightest.NextSlotAt));
            }

            if (backend == "seerr") Add(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget);
            else if (backend == "je")
            {
                Add(BudgetCategories.HouseholdAdd, BudgetCategories.Household);
                if (!string.IsNullOrEmpty(instance)) Add(BudgetCategories.Search, instance);
            }

            return list;
        }
    }
}
