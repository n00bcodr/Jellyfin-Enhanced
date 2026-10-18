using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
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
    /// POST, and the old recipes' own POST to Seerr at each address. Nothing a write site decided before an await is
    /// trusted here: every call reads it all again, in two steps. First the facts the gates read from storage are
    /// gathered (breaker, budgets, the eligibility grant, whether the person is a Jellyfin administrator, their consent,
    /// whether Seerr's key is stored); those reads may wait. Then the live configuration is read and every gate is judged
    /// on it and those facts, in <see cref="Gates"/> order, with nothing that waits (no I/O, lock, wait or await) before
    /// the answer: the first hold, or null when the write may go. What can be read from memory is read in that decision
    /// (the published disk snapshots, the household role, Trusted). Every fact is registered in
    /// <see cref="AutomationFacts"/>, either read in the decision or versioned: each change to a versioned fact moves its
    /// version odd before the change can be seen and even after (<see cref="FactVersion"/>). The versions are sampled
    /// before the gather and at the decision; the decision is only made when every sample is settled and none moved,
    /// otherwise the facts are gathered again, a few times at most.
    /// The last call is made inside the HTTP transport (<see cref="AutomationTransportHandler"/>, D41), with the job's
    /// budget reservations among the facts and judged in the same decision: that is the guarantee. The write sites' own
    /// calls (budgets admitted per write right after them, <see cref="ISendAdmission"/>) stay as defence in depth. The
    /// preliminary budget check runs before any transport only. A read-back is never gated.
    /// </summary>
    public sealed class AutomationWriteGate
    {
        /// <summary>Hold reason on the old recipes' direct Seerr path: the recipe or Seerr is switched off; nothing is sent.</summary>
        public const string Disabled = "disabled";

        /// <summary>Hold reason for queued work: the integration, phase 1 or 3, the request backend or Seerr changed.</summary>
        public const string ConfigurationChanged = "configuration_changed";

        /// <summary>How many times the facts are gathered when what they depend on keeps changing (then the write waits).</summary>
        internal const int GatherRounds = 3;

        private readonly Func<PluginConfiguration?> _config;
        private readonly IRequestPolicy? _policy;
        private readonly AutomationBudgets? _budgets;
        private readonly AutomationStore? _store;
        private readonly AutomationEligibility? _eligibility;
        private readonly IAutomationConsents? _consents;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<long> _secrets;

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
        /// <param name="secrets">The secrets store's version (default: the plugin's store).</param>
        public AutomationWriteGate(Func<PluginConfiguration?> config, IRequestPolicy? policy = null, AutomationBudgets? budgets = null, AutomationStore? store = null,
            AutomationEligibility? eligibility = null, IAutomationConsents? consents = null, Func<DateTimeOffset>? now = null, Func<long>? secrets = null)
        {
            _config = config;
            _policy = policy;
            _budgets = budgets;
            _store = store;
            _eligibility = eligibility;
            _consents = consents;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _secrets = secrets ?? (() => JellyfinEnhanced.Instance?.Secrets.Version.Sample() ?? 0);
        }

        /// <summary>
        /// The versioned facts (<see cref="AutomationFacts"/>), gathered before the decision. Null: not gathered (not needed
        /// for this write, or the service it is read from isn't there: the gate then holds the write as unchecked).
        /// </summary>
        internal sealed record Facts
        {
            /// <summary>The engine-only gates' facts were gathered (the engine was in effect for the write, or every gate was asked).</summary>
            public bool EngineFacts { get; init; }

            /// <summary>A Seerr API key is stored (queued automatic work under Seerr handling).</summary>
            public bool? SeerrKey { get; init; }

            /// <summary>The person consents to the recipe asking for them.</summary>
            public bool? Consented { get; init; }

            /// <summary>The person is a Jellyfin administrator (enabled, with the administrator permission).</summary>
            public bool? Admin { get; init; }

            /// <summary>The person holds a recorded eligibility grant.</summary>
            public bool? Granted { get; init; }

            /// <summary>The target's breaker.</summary>
            public AutomationBreaker? Breaker { get; init; }

            /// <summary>What the preliminary budget check counts.</summary>
            public BudgetRows? Budget { get; init; }

            /// <summary>What the job's admitted writes count (at the transport).</summary>
            public IReadOnlyList<BudgetRows>? Admission { get; init; }
        }

        // The version sources of the gathered facts (AutomationFacts.Versions), sampled without waiting: the configuration
        // (the object, and what it holds, as a save may change it in place), the database's generation (a restore) and its
        // automation version (budgets, breakers, grants), the person's settings version (their consents), their Jellyfin
        // permission version, and the secrets store's version (Seerr's key).
        private readonly record struct Stamp(PluginConfiguration Config, string Settings, long Generation, long Automation, long Person, long Jellyfin, long Secrets)
        {
            // No change was in flight as it was sampled.
            public bool Settled => FactVersion.Settled(Automation) && FactVersion.Settled(Person) && FactVersion.Settled(Jellyfin) && FactVersion.Settled(Secrets);

            public bool Same(Stamp other) => ReferenceEquals(Config, other.Config) && Settings == other.Settings && Generation == other.Generation
                && Automation == other.Automation && Person == other.Person && Jellyfin == other.Jellyfin && Secrets == other.Secrets;
        }

        private sealed record Gate(string Id, bool EngineOnly = false);

        // The gates in the order they are asked. The engine-only ones act only on automatic work while the engine is in
        // effect (with it off, the old recipes' queued work goes out as before).
        private static readonly Gate[] Ordered =
        {
            new("legacy_switch"),
            new("shadow_override"),
            new("requests"),
            new("phase4"),
            new("engine_changed"),
            new("kill_all", EngineOnly: true),
            new("kill_recipe", EngineOnly: true),
            new("kill_target", EngineOnly: true),
            new("recipe_mode", EngineOnly: true),
            new("consent", EngineOnly: true),
            new("seerr_unsupported", EngineOnly: true),
            new("approval", EngineOnly: true),
            new("breaker", EngineOnly: true),
            new("low_disk", EngineOnly: true),
            new("disk_unknown", EngineOnly: true),
            new("budget", EngineOnly: true),
        };

        /// <summary>The gates, in the order they are asked.</summary>
        public static IReadOnlyList<string> Gates { get; } = Ordered.Select(g => g.Id).ToArray();

        /// <summary>
        /// Why <paramref name="write"/> may not go now (null: it may). Gathers the facts, then decides on the live
        /// configuration; call it immediately before the write leaves, after the last await.
        /// </summary>
        /// <param name="write">The write (null: the gate doesn't apply, e.g. a person's own ask).</param>
        public AutomationHold? Check(AutomationWrite? write) => Check(write, null);

        /// <summary>
        /// The transport's check (<see cref="AutomationTransportHandler"/>): <see cref="Check(AutomationWrite?)"/> with the
        /// budget reservations <paramref name="admission"/> admitted and hasn't settled among the facts, judged against the
        /// live limits in the same decision (each counting its own row once).
        /// </summary>
        /// <param name="write">The write (null: the gate doesn't apply).</param>
        /// <param name="admission">The job's admission (null: not budgeted).</param>
        internal AutomationHold? Check(AutomationWrite? write, ISendAdmission? admission)
        {
            if (write == null) return null;
            for (var round = 1; ; round++)
            {
                var config = _config();
                if (config == null) return Unloaded(write);
                var before = StampOf(write, config);
                // Facts first: each of these reads may wait (the database, during a restore too; a settings file; Jellyfin's
                // users; the secrets store).
                var facts = Gather(write, config, every: false, admission);
                if (Final(write, before, facts, admission, round, out var hold)) return hold;
            }
        }

        // The decision. Nothing here waits: the live configuration, the stamps, every gate and the budget judgement read
        // memory only, and the transport hands the request on as soon as this answers. False: a fact may be stale (a change
        // to what it depends on was in flight, or landed, while the facts were gathered), so they are gathered again.
        private bool Final(AutomationWrite write, Stamp before, Facts facts, ISendAdmission? admission, int round, out AutomationHold? hold)
        {
            var live = _config();
            if (live == null)
            {
                hold = Unloaded(write);
                return true;
            }
            var after = StampOf(write, live);
            if (after.Generation != before.Generation)
            {
                // A restore replaced the database: what was read (and the job's reservations) belong to the old one.
                hold = Changed("The request database was restored while this automatic request was checked; it is checked again under the restored state.");
                return true;
            }
            if (!before.Settled || !after.Settled || !after.Same(before) || (Engine(write, live) && !facts.EngineFacts))
            {
                hold = round >= GatherRounds ? Changed("The automation settings or state kept changing while this automatic request was checked; it is checked again shortly.") : null;
                return round >= GatherRounds;
            }
            hold = Decide(write, live, facts, admission);
            return true;
        }

        // Every gate in order on the live configuration and the gathered facts, then the admitted writes' budgets.
        private AutomationHold? Decide(AutomationWrite write, PluginConfiguration config, Facts facts, ISendAdmission? admission)
        {
            var engine = Engine(write, config);
            var disk = engine ? Disk(write, config) : null;
            foreach (var gate in Ordered)
            {
                if (gate.EngineOnly && !engine) continue;
                if (Run(gate.Id, write, config, facts, disk) is { } hold) return hold;
            }
            return facts.Admission is { } rows && admission?.Recheck(rows, config) is { } limited ? new AutomationHold(limited.Reason, limited.Message, limited.Wait) : null;
        }

        // Both disk verdicts, from one read of each published snapshot (memory only); null: no policy or no scope.
        private (RequestDiskFacts? Pause, bool Known)? Disk(AutomationWrite write, PluginConfiguration config)
            => write.Input != null && _policy != null ? _policy.Disk(write.Input, config) : null;

        /// <summary>The result of one named gate alone for <paramref name="write"/> (tests and diagnostics): its facts gathered, then judged.</summary>
        /// <param name="id">The gate's id (<see cref="Gates"/>).</param>
        /// <param name="write">The write.</param>
        internal AutomationHold? CheckOne(string id, AutomationWrite write)
        {
            var config = _config();
            if (config == null) return null;
            var gate = Ordered.Single(g => g.Id == id).Id;
            return Run(gate, write, config, Gather(write, config, every: true, null), Disk(write, config));
        }

        private static bool Engine(AutomationWrite write, PluginConfiguration config) => write.Automatic && AutomationFlags.Engine(config);

        // The version of every source a gathered fact depends on (AutomationFacts.Versions): memory only.
        private Stamp StampOf(AutomationWrite write, PluginConfiguration config)
        {
            var db = _store?.Database ?? _budgets?.Database;
            return new(config, JsonSerializer.Serialize(config), db?.Generation ?? 0, db?.Automation.Sample() ?? 0, _consents?.Version(write.Requester) ?? 0,
                _policy?.PermissionVersion(write.Requester) ?? 0, _secrets());
        }

        // The versioned facts (AutomationFacts), each only where a gate needs it. The engine-only gates' facts are read
        // while the engine is in effect (or for every gate, when one is asked alone).
        private Facts Gather(AutomationWrite w, PluginConfiguration config, bool every, ISendAdmission? admission)
        {
            var facts = new Facts
            {
                SeerrKey = w.Path == AutomationWritePath.Queued && w.Automatic && w.Backend == "seerr" ? !string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()) : null,
                // At the transport: what the job's admitted writes count.
                Admission = admission?.Rows(),
            };
            if (!every && !Engine(w, config)) return facts;
            facts = facts with { EngineFacts = true };
            if (w.PreTransport && _budgets != null)
                facts = facts with { Budget = w.Backend == "seerr" ? _budgets.Rows(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget) : _budgets.Rows(BudgetCategories.Search, w.Target ?? string.Empty) };
            if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breaker(w.Target) };
            if (w.Approver == null && _policy != null && _eligibility != null && w.Input != null)
                facts = facts with { Admin = _policy.IsAdmin(w.Requester), Granted = _eligibility.Granted(w.Requester) };
            if (w.OriginKind == RequestOrigin.AutomationKind && w.Recipe != null) facts = facts with { Consented = AutomationConsent.Allows(_consents, w.Requester, w.Recipe) };
            // The disk facts are read in the decision, from memory; start the reads of any that aren't there yet.
            if (w.Input != null && _policy != null) _policy.WarmDisk(w.Input);
            return facts;
        }

        // One gate, on the configuration, the gathered facts and the disk verdicts given: memory only.
        private AutomationHold? Run(string id, AutomationWrite w, PluginConfiguration c, Facts f, (RequestDiskFacts? Pause, bool Known)? disk) => id switch
        {
            "legacy_switch" => w.OriginKind == RequestOrigin.AutomationKind && !AutomationRecipes.SwitchedOn(c, w.Recipe)
                ? Hold(w.Path == AutomationWritePath.LegacySeerr ? Disabled : AutomationHolds.RecipePaused, "The recipe is switched off: its request waits until it is on again.") : null,
            "shadow_override" => w.Automatic && AutomationFlags.ShadowOverride(c)
                ? Hold(AutomationHolds.ShadowOverride, "The rollout Shadow override is on: automatic requests are recorded, never sent.") : null,
            "requests" => Requests(w, c, f),
            "phase4" => w.Phase4Only && !(w.Automatic ? AutomationFlags.Engine(c) : AutomationFlags.Phase4WithRequests(c))
                ? Hold(AutomationHolds.Phase4Off, "Phase 4 (or its automation engine) is off: work it created waits.") : null,
            "engine_changed" => w.BudgetedAtStart is bool started && w.Automatic && started != AutomationFlags.Engine(c)
                ? Hold(AutomationHolds.EngineChanged, "The automation engine was turned on or off during the send: it starts again under the current rules.") : null,
            "kill_all" => AutomationFlags.KilledAll(c) ? Killed() : null,
            "kill_recipe" => w.Recipe != null && AutomationModes.Killed(c, w.Recipe) ? Killed() : null,
            "kill_target" => AutomationFlags.KilledTarget(c, w.Target) ? Killed() : null,
            "recipe_mode" => (w.Recipe == null ? AutomationMode.Shadow : AutomationModes.Mode(c, w.Recipe)) is var mode && mode is AutomationMode.Off or AutomationMode.Shadow
                ? Hold(AutomationHolds.RecipePaused, "The recipe is now " + AutomationModes.Name(mode) + ": its queued request waits.") : null,
            // A recipe's ask: the person's consent as it was read. List sync asks run on the list link's own consent.
            "consent" => w.OriginKind == RequestOrigin.AutomationKind && w.Recipe != null && f.Consented != true
                ? Hold(AutomationHolds.UserOptedOut, "The person turned this automatic request off for themselves: it waits until they turn it back on.") : null,
            "seerr_unsupported" => w.Backend == "seerr" && AutomationRecipes.RequiresDirect(w.Recipe)
                ? Park(AutomationHolds.SeerrUnsupported, "This recipe needs Sonarr/Radarr handling; Seerr handles requests now.") : null,
            "approval" => Approval(w, c, f),
            "breaker" => Breaker(w, f),
            // Seerr handling included: the policy measures the drive Seerr's default server would fill (as before).
            "low_disk" => w.Input == null ? null : disk is not { } low ? Unchecked() : low.Pause != null
                ? Hold(AutomationHolds.LowDisk, "The drive it would land on is below the low-disk threshold.") : null,
            "disk_unknown" => w.Backend != "je" || w.Input == null || c.ArrLowDiskPercent <= 0 ? null : disk is not { } known ? Unchecked() : !known.Known
                ? Hold(AutomationHolds.DiskUnknown, "The destination's free space isn't known yet; automatic sends wait for it.") : null,
            "budget" => Budget(w, c, f),
            _ => throw new ArgumentOutOfRangeException(nameof(id), id, null),
        };

        // The integration and the request path the write was chosen under still apply. The old recipes' direct path stops
        // once phase 3 is on (the check starts again through the ledger) or Seerr is off; queued work waits for a person
        // when the integration, phase 1 or 3, the request backend, or Seerr (Seerr handling) changed.
        private static AutomationHold? Requests(AutomationWrite w, PluginConfiguration c, Facts f)
        {
            if (!w.Automatic) return null;
            if (w.Path == AutomationWritePath.LegacySeerr)
            {
                if (w.LedgerAvailable && c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true })
                    return Hold(AutomationHolds.EngineChanged, "Phase 3 was turned on: the recipe checks again through the request ledger.");
                return c.JellyseerrEnabled ? null : Hold(Disabled, "Seerr is switched off.");
            }
            var on = c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true } && c.ArrRequestBackend is "je" or "seerr";
            if (!on || c.ArrRequestBackend != w.Backend || (w.Backend == "seerr" && !SeerrRequestReadModel.IsActive(c, f.SeerrKey == true)))
                return Park(ConfigurationChanged, "Request handling changed after this automatic request was queued.");
            return null;
        }

        // Ask mode, or a person who isn't eligible (any more): an OK is required now. Their role and Trusted are read here
        // from memory, on the live configuration; whether they are a Jellyfin administrator and hold a grant were gathered.
        private AutomationHold? Approval(AutomationWrite w, PluginConfiguration c, Facts f)
        {
            if (w.Approver != null) return null;
            if (_policy == null || _eligibility == null || w.Input == null || f.Admin is not { } admin || f.Granted is not { } granted) return Unchecked();
            var mode = w.Recipe == null ? AutomationMode.Shadow : AutomationModes.Mode(c, w.Recipe);
            var eligible = AutomationEligibility.Why(_policy.RoleOf(w.Requester, admin, c), _eligibility.Trusted(w.Requester), granted) != null;
            return mode == AutomationMode.Ask || !eligible
                ? Park(AutomationHolds.ApprovalRequired, "An OK is required now (Ask mode, or the person isn't eligible for automatic requests).") : null;
        }

        private AutomationHold? Breaker(AutomationWrite w, Facts f)
        {
            if (string.IsNullOrEmpty(w.Target)) return null;
            if (_store == null || f.Breaker is not { } breaker) return Unchecked();
            var now = _now();
            return breaker.Open(now)
                ? new(AutomationHolds.BreakerOpen, "Automatic sends to this target failed " + breaker.Failures.ToString(CultureInfo.InvariantCulture) + " times in a row; paused until " + breaker.OpenUntil!.Value.ToString("u", CultureInfo.InvariantCulture) + ".", Until(breaker.OpenUntil!.Value, now))
                : null;
        }

        // The preliminary budget check before any transport; each write is then admitted on its own. A full budget waits
        // for the latest next free slot among its full windows.
        private AutomationHold? Budget(AutomationWrite w, PluginConfiguration c, Facts f)
        {
            if (!w.PreTransport) return null;
            if (_budgets == null || f.Budget is not { } rows) return Unchecked();
            var now = _now();
            var judged = AutomationBudgets.Judge(rows, c, now);
            if (judged.Admitted) return null;
            if (judged.Reason != "budget_exhausted" || judged.Window is not { } window) return Unchecked();
            return new(AutomationHolds.BudgetExhausted, "The " + rows.Category + " budget (" + AutomationBudgets.Label(window) + ") is used up.", Until(judged.RetryAt ?? now + window, now));
        }

        private static AutomationHold Unloaded(AutomationWrite write)
            => write.Path == AutomationWritePath.LegacySeerr ? Hold(Disabled, "The plugin configuration isn't loaded.") : Park(ConfigurationChanged, "The plugin configuration isn't loaded.");

        // What the facts were read under moved (a restore, or changes landing faster than they can be read): nothing is
        // sent now, and the request is checked again shortly under the current rules.
        private static AutomationHold Changed(string message) => Hold(AutomationHolds.EngineChanged, message);

        private static AutomationHold Hold(string reason, string message) => new(reason, message, AutomationHolds.WaitFor(reason));

        private static AutomationHold Park(string reason, string message) => new(reason, message, TimeSpan.Zero, Park: true);

        private static AutomationHold Killed() => Hold(AutomationHolds.Killed, "A kill switch is on: automatic requests wait until it is off.");

        // A gate this instance can't evaluate (a service it wasn't given): the write waits rather than going unchecked.
        private static AutomationHold Unchecked() => Hold(AutomationHolds.AccountingUnavailable, "The automation checks can't be made right now; nothing was sent.");

        private static TimeSpan Until(DateTimeOffset at, DateTimeOffset now) => at > now ? at - now + TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(30);
    }
}
