using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>Which way an automatic write leaves.</summary>
    public enum AutomationWritePath
    {
        /// <summary>A queued job of the request ledger, sent by the outbox (Sonarr/Radarr or Seerr).</summary>
        Queued,

        /// <summary>The old recipes' own POST to Seerr while phase 3 is off (no ledger).</summary>
        LegacySeerr,
    }

    /// <summary>
    /// One automatic outbound write about to leave: whose it is and where it goes. Built by the write site from what it
    /// already holds; every setting the gate decides on is read live by the gate itself, never carried here.
    /// </summary>
    public sealed record AutomationWrite
    {
        /// <summary>Which way it leaves.</summary>
        public AutomationWritePath Path { get; init; }

        /// <summary>The want's origin kind (automation, sync, list, import).</summary>
        public string OriginKind { get; init; } = RequestOrigin.AutomationKind;

        /// <summary>The recipe (null: none, e.g. a deliberate list ask).</summary>
        public string? Recipe { get; init; }

        /// <summary>An automatic origin (recipes, list sync).</summary>
        public bool Automatic { get; init; }

        /// <summary>Work only phase 4 creates.</summary>
        public bool Phase4Only { get; init; }

        /// <summary>The person it is for.</summary>
        public Guid Requester { get; init; }

        /// <summary>Who approved it (null: nobody).</summary>
        public Guid? Approver { get; init; }

        /// <summary>je or seerr (queued work); seerr for the old recipes' own POST.</summary>
        public string Backend { get; init; } = "seerr";

        /// <summary>The kill-switch and breaker target: the Sonarr/Radarr instance, or <c>seerr</c>.</summary>
        public string? Target { get; init; }

        /// <summary>The scope (the disk guard measures its destination).</summary>
        public MutationInput? Input { get; init; }

        /// <summary>
        /// Whether the attempt chose a budget admission (the engine was in effect for it) when it started; null before
        /// that choice (the check before any transport).
        /// </summary>
        public bool? BudgetedAtStart { get; init; }

        /// <summary>The check before any transport: the preliminary budget check runs here only (each write is admitted).</summary>
        public bool PreTransport { get; init; }

        /// <summary>The old recipe's path can start again through the ledger (a recorder is available).</summary>
        public bool LedgerAvailable { get; init; }

        /// <summary>
        /// A queued job's write; null when the gate doesn't apply to it (a person's own ask, or a want not found).
        /// </summary>
        /// <param name="job">The job.</param>
        /// <param name="want">Its want.</param>
        /// <param name="budgetedAtStart">Whether this attempt chose a budget admission (null: before any transport).</param>
        public static AutomationWrite? ForJob(RequestJob job, RequestWant? want, bool? budgetedAtStart)
        {
            if (!AutomationSendGuard.Applies(want)) return null;
            return new AutomationWrite
            {
                Path = AutomationWritePath.Queued,
                OriginKind = want!.OriginKind,
                Recipe = AutomationSendGuard.RecipeOf(want),
                Automatic = RequestOrigin.IsAutomatic(want.OriginKind),
                Phase4Only = RequestOrigin.IsPhase4Only(want.OriginKind, want.OriginSource),
                Requester = job.Authorization.Requester,
                Approver = job.Authorization.Approver,
                Backend = job.Authorization.Backend,
                Target = AutomationSendGuard.Target(job),
                Input = job.Input,
                BudgetedAtStart = budgetedAtStart,
                PreTransport = budgetedAtStart == null,
            };
        }

        /// <summary>An old recipe's own POST to Seerr (phase 3 off), at any of Seerr's addresses.</summary>
        /// <param name="recipe">auto_movie or auto_season.</param>
        /// <param name="ledgerAvailable">The recipe can start again through the ledger once phase 3 is on.</param>
        public static AutomationWrite LegacySeerr(string recipe, bool ledgerAvailable) => new()
        {
            Path = AutomationWritePath.LegacySeerr,
            OriginKind = RequestOrigin.AutomationKind,
            Recipe = recipe,
            Automatic = true,
            Backend = "seerr",
            Target = AutomationFlags.SeerrTarget,
            LedgerAvailable = ledgerAvailable,
        };
    }

    /// <summary>
    /// The one gate every automatic outbound write passes immediately before it leaves: each Sonarr/Radarr add, monitor
    /// change, search, tag and refresh of the Direct backend (after the wait for a connection slot), the Seerr backend's
    /// POST, and the old recipes' own POST to Seerr at each address. It re-reads every gate from the live configuration
    /// and state on every call, in <see cref="Gates"/> order, and returns the first hold (null: the write may go). Nothing
    /// a write site decided before an await is trusted here. The last call is made inside the HTTP transport
    /// (<see cref="AutomationTransportHandler"/>, D41): every write made in an automation context is checked there as it
    /// is handed on, after its budgets are checked again with the limits as they are then. That is the guarantee; the
    /// write sites' own calls (budgets admitted per write right after them, <see cref="ISendAdmission"/>) stay as defence
    /// in depth. The preliminary budget check runs before any transport only. A read-back is never gated.
    /// </summary>
    public sealed class AutomationWriteGate
    {
        /// <summary>Hold reason on the old recipes' direct Seerr path: the recipe or Seerr is switched off; nothing is sent.</summary>
        public const string Disabled = "disabled";

        /// <summary>Hold reason for queued work: the integration, phase 1 or 3, the request backend or Seerr changed.</summary>
        public const string ConfigurationChanged = "configuration_changed";

        private readonly Func<PluginConfiguration?> _config;
        private readonly IRequestPolicy? _policy;
        private readonly AutomationBudgets? _budgets;
        private readonly AutomationStore? _store;
        private readonly AutomationEligibility? _eligibility;
        private readonly IAutomationConsents? _consents;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>
        /// Creates the gate over the live configuration. Without the policy, store, eligibility or budgets (the old
        /// recipes' own path, where the engine can't be in effect), a gate that needs one holds the write.
        /// </summary>
        /// <param name="config">The live configuration (an administrator's save replaces it).</param>
        /// <param name="policy">Request policy (roles, disk).</param>
        /// <param name="budgets">Budgets.</param>
        /// <param name="store">Automation store (breakers).</param>
        /// <param name="eligibility">Eligibility (administrators, Trusted, grants).</param>
        /// <param name="consents">Per-person consents.</param>
        /// <param name="now">Clock.</param>
        public AutomationWriteGate(Func<PluginConfiguration?> config, IRequestPolicy? policy = null, AutomationBudgets? budgets = null, AutomationStore? store = null,
            AutomationEligibility? eligibility = null, IAutomationConsents? consents = null, Func<DateTimeOffset>? now = null)
        {
            _config = config;
            _policy = policy;
            _budgets = budgets;
            _store = store;
            _eligibility = eligibility;
            _consents = consents;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        private delegate AutomationHold? GateCheck(AutomationWriteGate gate, AutomationWrite write, PluginConfiguration config);

        private sealed record Gate(string Id, GateCheck Run, bool EngineOnly = false);

        // The gates in the order they are asked. The engine-only ones act only on automatic work while the engine is in
        // effect (with it off, the old recipes' queued work goes out as before).
        private static readonly Gate[] Ordered =
        {
            new("legacy_switch", (_, w, c) => w.OriginKind == RequestOrigin.AutomationKind && !AutomationRecipes.SwitchedOn(c, w.Recipe)
                ? Hold(w.Path == AutomationWritePath.LegacySeerr ? Disabled : AutomationHolds.RecipePaused, "The recipe is switched off: its request waits until it is on again.") : null),
            new("shadow_override", (_, w, c) => w.Automatic && AutomationFlags.ShadowOverride(c)
                ? Hold(AutomationHolds.ShadowOverride, "The rollout Shadow override is on: automatic requests are recorded, never sent.") : null),
            new("requests", (_, w, c) => Requests(w, c)),
            new("phase4", (_, w, c) => w.Phase4Only && !(w.Automatic ? AutomationFlags.Engine(c) : AutomationFlags.Phase4WithRequests(c))
                ? Hold(AutomationHolds.Phase4Off, "Phase 4 (or its automation engine) is off: work it created waits.") : null),
            new("engine_changed", (_, w, c) => w.BudgetedAtStart is bool started && w.Automatic && started != AutomationFlags.Engine(c)
                ? Hold(AutomationHolds.EngineChanged, "The automation engine was turned on or off during the send: it starts again under the current rules.") : null),
            new("kill_all", (_, _, c) => AutomationFlags.KilledAll(c) ? Killed() : null, EngineOnly: true),
            new("kill_recipe", (_, w, c) => w.Recipe != null && AutomationModes.Killed(c, w.Recipe) ? Killed() : null, EngineOnly: true),
            new("kill_target", (_, w, c) => AutomationFlags.KilledTarget(c, w.Target) ? Killed() : null, EngineOnly: true),
            new("recipe_mode", (_, w, c) => (w.Recipe == null ? AutomationMode.Shadow : AutomationModes.Mode(c, w.Recipe)) is var mode && mode is AutomationMode.Off or AutomationMode.Shadow
                ? Hold(AutomationHolds.RecipePaused, "The recipe is now " + AutomationModes.Name(mode) + ": its queued request waits.") : null, EngineOnly: true),
            // A recipe's ask: the person's consent as it is now. List sync asks run on the list link's own consent.
            new("consent", (g, w, _) => w.OriginKind == RequestOrigin.AutomationKind && w.Recipe != null && !AutomationConsent.Allows(g._consents, w.Requester, w.Recipe)
                ? Hold(AutomationHolds.UserOptedOut, "The person turned this automatic request off for themselves: it waits until they turn it back on.") : null, EngineOnly: true),
            new("seerr_unsupported", (_, w, _) => w.Backend == "seerr" && AutomationRecipes.RequiresDirect(w.Recipe)
                ? Park(AutomationHolds.SeerrUnsupported, "This recipe needs Sonarr/Radarr handling; Seerr handles requests now.") : null, EngineOnly: true),
            new("approval", (g, w, c) => g.Approval(w, c), EngineOnly: true),
            new("breaker", (g, w, _) => g.Breaker(w), EngineOnly: true),
            // Seerr handling included: the policy measures the drive Seerr's default server would fill (as before).
            new("low_disk", (g, w, _) => w.Input == null ? null : g._policy == null ? Unchecked() : g._policy.TitlePause(w.Input) != null
                ? Hold(AutomationHolds.LowDisk, "The drive it would land on is below the low-disk threshold.") : null, EngineOnly: true),
            new("disk_unknown", (g, w, c) => w.Backend != "je" || w.Input == null || c.ArrLowDiskPercent <= 0 ? null : g._policy == null ? Unchecked() : !g._policy.DiskKnown(w.Input)
                ? Hold(AutomationHolds.DiskUnknown, "The destination's free space isn't known yet; automatic sends wait for it.") : null, EngineOnly: true),
            new("budget", (g, w, _) => g.Budget(w), EngineOnly: true),
        };

        /// <summary>The gates, in the order they are asked.</summary>
        public static IReadOnlyList<string> Gates { get; } = Ordered.Select(g => g.Id).ToArray();

        /// <summary>
        /// Why <paramref name="write"/> may not go now (null: it may). Re-reads every gate live; call it immediately before
        /// the write leaves, after the last await.
        /// </summary>
        /// <param name="write">The write (null: the gate doesn't apply, e.g. a person's own ask).</param>
        public AutomationHold? Check(AutomationWrite? write)
        {
            if (write == null) return null;
            var config = _config();
            if (config == null)
                return write.Path == AutomationWritePath.LegacySeerr ? Hold(Disabled, "The plugin configuration isn't loaded.") : Park(ConfigurationChanged, "The plugin configuration isn't loaded.");
            var engine = write.Automatic && AutomationFlags.Engine(config);
            foreach (var gate in Ordered)
            {
                if (gate.EngineOnly && !engine) continue;
                if (gate.Run(this, write, config) is { } hold) return hold;
            }
            return null;
        }

        /// <summary>The result of one named gate alone for <paramref name="write"/> (tests and diagnostics).</summary>
        /// <param name="id">The gate's id (<see cref="Gates"/>).</param>
        /// <param name="write">The write.</param>
        internal AutomationHold? CheckOne(string id, AutomationWrite write)
        {
            var config = _config();
            return config == null ? null : Ordered.Single(g => g.Id == id).Run(this, write, config);
        }

        // The integration and the request path the write was chosen under still apply. The old recipes' direct path stops
        // once phase 3 is on (the check starts again through the ledger) or Seerr is off; queued work waits for a person
        // when the integration, phase 1 or 3, the request backend, or Seerr (Seerr handling) changed.
        private static AutomationHold? Requests(AutomationWrite w, PluginConfiguration c)
        {
            if (!w.Automatic) return null;
            if (w.Path == AutomationWritePath.LegacySeerr)
            {
                if (w.LedgerAvailable && c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true })
                    return Hold(AutomationHolds.EngineChanged, "Phase 3 was turned on: the recipe checks again through the request ledger.");
                return c.JellyseerrEnabled ? null : Hold(Disabled, "Seerr is switched off.");
            }
            var on = c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true } && c.ArrRequestBackend is "je" or "seerr";
            if (!on || c.ArrRequestBackend != w.Backend || (w.Backend == "seerr" && !SeerrRequestReadModel.IsActive(c)))
                return Park(ConfigurationChanged, "Request handling changed after this automatic request was queued.");
            return null;
        }

        // Ask mode, or a person who isn't eligible (any more): an OK is required now.
        private AutomationHold? Approval(AutomationWrite w, PluginConfiguration c)
        {
            if (w.Approver != null) return null;
            if (_policy == null || _eligibility == null || w.Input == null) return Unchecked();
            var mode = w.Recipe == null ? AutomationMode.Shadow : AutomationModes.Mode(c, w.Recipe);
            var role = _policy.Evaluate(w.Requester, w.Input).Role;
            return mode == AutomationMode.Ask || !_eligibility.Eligible(w.Requester, role)
                ? Park(AutomationHolds.ApprovalRequired, "An OK is required now (Ask mode, or the person isn't eligible for automatic requests).") : null;
        }

        private AutomationHold? Breaker(AutomationWrite w)
        {
            if (string.IsNullOrEmpty(w.Target)) return null;
            if (_store == null) return Unchecked();
            var now = _now();
            var breaker = _store.Breaker(w.Target);
            return breaker.Open(now)
                ? new(AutomationHolds.BreakerOpen, "Automatic sends to this target failed " + breaker.Failures.ToString(CultureInfo.InvariantCulture) + " times in a row; paused until " + breaker.OpenUntil!.Value.ToString("u", CultureInfo.InvariantCulture) + ".", Until(breaker.OpenUntil!.Value, now))
                : null;
        }

        // The preliminary budget check before any transport; each write is then admitted on its own.
        private AutomationHold? Budget(AutomationWrite w)
        {
            if (!w.PreTransport) return null;
            if (_budgets == null) return Unchecked();
            var exhausted = w.Backend == "seerr"
                ? _budgets.Exhausted(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget)
                : _budgets.Exhausted(BudgetCategories.Search, w.Target ?? string.Empty);
            if (exhausted == null) return null;
            var now = _now();
            return new(AutomationHolds.BudgetExhausted, "The " + exhausted.Category + " budget (" + AutomationBudgets.Label(exhausted.Window) + ") is used up.", Until(exhausted.NextSlotAt ?? now + exhausted.Window, now));
        }

        private static AutomationHold Hold(string reason, string message) => new(reason, message, AutomationHolds.WaitFor(reason));

        private static AutomationHold Park(string reason, string message) => new(reason, message, TimeSpan.Zero, Park: true);

        private static AutomationHold Killed() => Hold(AutomationHolds.Killed, "A kill switch is on: automatic requests wait until it is off.");

        // A gate this instance can't evaluate (a service it wasn't given): the write waits rather than going unchecked.
        private static AutomationHold Unchecked() => Hold(AutomationHolds.AccountingUnavailable, "The automation checks can't be made right now; nothing was sent.");

        private static TimeSpan Until(DateTimeOffset at, DateTimeOffset now) => at > now ? at - now + TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(30);
    }
}
