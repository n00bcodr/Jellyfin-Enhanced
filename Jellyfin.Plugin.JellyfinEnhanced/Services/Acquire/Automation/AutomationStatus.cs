using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// What the request backend lets Jellyfin Enhanced guarantee about automatic work, as codes the hub, configuration
    /// page and docs word: Sonarr/Radarr handling (Direct) enforces household adds, per-instance searches, the disk guard
    /// at the folder the title actually lands in, breakers and every kill switch right before each write. Seerr handling
    /// counts only Jellyfin Enhanced's POSTs to Seerr and its kills and disk check hold only those sends; once Seerr
    /// accepts a request it is Seerr's (its later approval, folder and Sonarr/Radarr work included), so per-instance
    /// budgets, a guaranteed destination and stopping work after hand-off are not offered there.
    /// </summary>
    public sealed record AutomationContract(
        [property: JsonPropertyName("backend")] string Backend,
        [property: JsonPropertyName("guarantees")] IReadOnlyList<string> Guarantees,
        [property: JsonPropertyName("notGuaranteed")] IReadOnlyList<string> NotGuaranteed,
        [property: JsonPropertyName("unavailableRecipes")] IReadOnlyList<string> UnavailableRecipes)
    {
        /// <summary>The contract of a backend (je, seerr; anything else: no automatic requests at all).</summary>
        /// <param name="backend">Request backend.</param>
        public static AutomationContract For(string? backend) => backend switch
        {
            "je" => new("je",
                new[] { "household_adds", "instance_searches", "actual_root_disk_guard", "breakers", "kills_before_each_write", "read_back_after_kill" },
                Array.Empty<string>(), Array.Empty<string>()),
            "seerr" => new("seerr",
                new[] { "seerr_posts", "kills_before_handoff", "default_root_disk_hint", "breakers", "read_back_after_kill" },
                new[] { "per_instance_searches", "household_adds_downstream", "actual_destination", "kill_after_handoff", "downstream_approval" },
                AutomationRecipes.All.Where(AutomationRecipes.RequiresDirect).ToList()),
            _ => new(backend ?? "status_only", Array.Empty<string>(), new[] { "automatic_requests" }, AutomationRecipes.All.Where(r => !AutomationRecipes.IsMembershipOnly(r)).ToList()),
        };
    }

    /// <summary>Administrator status of the automation engine (configuration page and hub).</summary>
    public sealed record AutomationStatusBody
    {
        /// <summary>Phase 4 switch and whether it is in effect (its parents on).</summary>
        [JsonPropertyName("phase4")] public required AutomationSwitch Phase4 { get; init; }

        /// <summary>The automation engine switch and whether it is in effect.</summary>
        [JsonPropertyName("engine")] public required AutomationSwitch Engine { get; init; }

        /// <summary>The rollout Shadow override.</summary>
        [JsonPropertyName("shadowOverride")] public bool ShadowOverride { get; init; }

        /// <summary>The global kill switch.</summary>
        [JsonPropertyName("killAll")] public bool KillAll { get; init; }

        /// <summary>Request backend: je, seerr or status_only.</summary>
        [JsonPropertyName("backend")] public string Backend { get; init; } = "seerr";

        /// <summary>What this backend lets automation guarantee.</summary>
        [JsonPropertyName("contract")] public required AutomationContract Contract { get; init; }

        /// <summary>Every recipe with its stored and effective mode.</summary>
        [JsonPropertyName("recipes")] public required IReadOnlyList<AutomationRecipeStatus> Recipes { get; init; }

        /// <summary>Kill-switch targets (every Sonarr/Radarr instance, and Seerr).</summary>
        [JsonPropertyName("targets")] public required IReadOnlyList<AutomationTargetStatus> Targets { get; init; }

        /// <summary>Budget usage per window, with reset times (UTC).</summary>
        [JsonPropertyName("budgets")] public required IReadOnlyList<AutomationBudgetStatus> Budgets { get; init; }

        /// <summary>Automatic requests waiting at send, by reason.</summary>
        [JsonPropertyName("held")] public required IReadOnlyDictionary<string, int> Held { get; init; }

        /// <summary>The one-time migration and its notice.</summary>
        [JsonPropertyName("migration")] public AutomationMigrationStatus? Migration { get; init; }

        /// <summary>Accounting can't be used (database unavailable): nothing automatic is sent.</summary>
        [JsonPropertyName("accountingUnavailable")] public bool AccountingUnavailable { get; init; }
    }

    /// <summary>A switch and whether it is in effect.</summary>
    public sealed record AutomationSwitch([property: JsonPropertyName("enabled")] bool Enabled, [property: JsonPropertyName("effective")] bool Effective);

    /// <summary>A recipe's status.</summary>
    public sealed record AutomationRecipeStatus(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("mode")] string Mode,
        [property: JsonPropertyName("effective")] string? Effective,
        [property: JsonPropertyName("reason")] string? Reason,
        [property: JsonPropertyName("killed")] bool Killed,
        [property: JsonPropertyName("legacy")] bool Legacy,
        [property: JsonPropertyName("requiresDirect")] bool RequiresDirect);

    /// <summary>A kill-switch target with its breaker.</summary>
    public sealed record AutomationTargetStatus(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("kind")] string Kind,
        [property: JsonPropertyName("killed")] bool Killed,
        [property: JsonPropertyName("breakerFailures")] int BreakerFailures,
        [property: JsonPropertyName("breakerOpenUntil")] DateTimeOffset? BreakerOpenUntil);

    /// <summary>One budget window's usage.</summary>
    public sealed record AutomationBudgetStatus(
        [property: JsonPropertyName("category")] string Category,
        [property: JsonPropertyName("scope")] string Scope,
        [property: JsonPropertyName("scopeName")] string ScopeName,
        [property: JsonPropertyName("window")] string Window,
        [property: JsonPropertyName("used")] int Used,
        [property: JsonPropertyName("limit")] int Limit,
        [property: JsonPropertyName("uncertain")] int Uncertain,
        [property: JsonPropertyName("nextSlotAt")] DateTimeOffset? NextSlotAt,
        [property: JsonPropertyName("resetAt")] DateTimeOffset? ResetAt,
        [property: JsonPropertyName("reserved")] bool Reserved = false);

    /// <summary>The migration as administrators see it.</summary>
    public sealed record AutomationMigrationStatus(
        [property: JsonPropertyName("kind")] string Kind,
        [property: JsonPropertyName("at")] DateTimeOffset At,
        [property: JsonPropertyName("autoSeason")] bool AutoSeason,
        [property: JsonPropertyName("autoMovie")] bool AutoMovie,
        [property: JsonPropertyName("notice")] string Notice,
        [property: JsonPropertyName("grants")] IReadOnlyList<AutomationGrantStatus> Grants);

    /// <summary>A recorded grant with the person's name.</summary>
    public sealed record AutomationGrantStatus(
        [property: JsonPropertyName("userId")] string UserId,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("at")] DateTimeOffset At);

    /// <summary>Builds the administrator status (memory and acquire.db reads only; no upstream call).</summary>
    public sealed class AutomationStatusService
    {
        private readonly AutomationStore _store;
        private readonly AutomationBudgets _budgets;
        private readonly ArrStateStore _arr;
        private readonly IHouseholdDirectory _people;
        private readonly Func<PluginConfiguration> _config;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the status (DI).</summary>
        public AutomationStatusService(AutomationStore store, AutomationBudgets budgets, ArrStateStore arr, IHouseholdDirectory people)
            : this(store, budgets, arr, people, () => JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration(), () => DateTimeOffset.UtcNow)
        {
        }

        internal AutomationStatusService(AutomationStore store, AutomationBudgets budgets, ArrStateStore arr, IHouseholdDirectory people, Func<PluginConfiguration> config, Func<DateTimeOffset> now)
        {
            _store = store;
            _budgets = budgets;
            _arr = arr;
            _people = people;
            _config = config;
            _now = now;
        }

        /// <summary>The store (notice and breakers).</summary>
        public AutomationStore Store => _store;

        /// <summary>The configuration now.</summary>
        public PluginConfiguration Configuration => _config();

        /// <summary>The administrator status now.</summary>
        public AutomationStatusBody Build()
        {
            var config = _config();
            var now = _now();
            var instances = _arr.Registry.All();
            var targets = instances.Select(i => (i.Id, i.Name, Kind: i.Kind.ToString().ToLowerInvariant() + (i.Role == ArrInstanceRole.FourK ? "-4k" : string.Empty)))
                .Append((Id: AutomationFlags.SeerrTarget, Name: "Seerr", Kind: "seerr")).ToList();
            var names = targets.ToDictionary(t => t.Id, t => t.Name, StringComparer.OrdinalIgnoreCase);
            var budgets = new List<AutomationBudgetStatus>();
            void Add(string category, IEnumerable<string> scopes, bool reserved = false)
            {
                foreach (var scope in _budgets.Scopes(category, scopes))
                {
                    foreach (var u in _budgets.Usage(category, scope))
                        budgets.Add(new(category, scope, scope == BudgetCategories.Household ? "household" : names.TryGetValue(scope, out var n) ? n : scope,
                            AutomationBudgets.Label(u.Window), u.Used, u.Limit, u.Uncertain, u.Full ? u.NextSlotAt : null, u.ResetAt, reserved));
                }
            }

            Add(BudgetCategories.HouseholdAdd, new[] { BudgetCategories.Household });
            Add(BudgetCategories.Search, instances.Where(i => i.Usable).Select(i => i.Id));
            Add(BudgetCategories.SeerrPost, new[] { AutomationFlags.SeerrTarget });
            Add(BudgetCategories.SourceFetch, new[] { BudgetCategories.Household });
            Add(BudgetCategories.DeltaWork, new[] { BudgetCategories.Household });
            Add(BudgetCategories.Backfill, Array.Empty<string>(), reserved: true);

            var breakers = _store.Breakers().ToDictionary(b => b.Target, StringComparer.OrdinalIgnoreCase);
            var settings = AutomationModes.Read(config);
            var record = AutomationMigrationRecord.Read(config.ArrAutomationMigration);
            AutomationMigrationStatus? migration = null;
            if (record != null)
            {
                var people = _people.People().ToDictionary(p => p.Id);
                migration = new(record.Kind, record.At, record.AutoSeason, record.AutoMovie, Notice(_store.Meta(AutomationMigration.NoticeKey)),
                    _store.Grants().Select(g => new AutomationGrantStatus(g.UserId, Guid.TryParse(g.UserId, out var id) && people.TryGetValue(id, out var p) ? p.Name : string.Empty, g.Source, g.GrantedAt)).ToList());
            }

            return new AutomationStatusBody
            {
                Phase4 = new(config.ArrPhase4Enabled, AutomationFlags.Phase4(config)),
                Engine = new(config.ArrPhase4AutomationEnabled, AutomationFlags.Engine(config)),
                ShadowOverride = AutomationFlags.ShadowOverride(config),
                KillAll = AutomationFlags.KilledAll(config),
                Backend = config.ArrRequestBackend is "je" or "seerr" ? config.ArrRequestBackend : "status_only",
                Contract = AutomationContract.For(config.ArrRequestBackend),
                Recipes = AutomationRecipes.All.Select(r =>
                {
                    var control = AutomationFlags.Control(config, r);
                    return new AutomationRecipeStatus(r, settings[r].Mode, control.Effective is { } e ? AutomationModes.Name(e) : null, control.Reason, settings[r].Killed, AutomationRecipes.IsLegacy(r), AutomationRecipes.RequiresDirect(r));
                }).ToList(),
                Targets = targets.Select(t => new AutomationTargetStatus(t.Id, t.Name, t.Kind, AutomationFlags.KilledTarget(config, t.Id),
                    breakers.TryGetValue(t.Id, out var b) ? b.Failures : 0, breakers.TryGetValue(t.Id, out var o) && o.Open(now) ? o.OpenUntil : null)).ToList(),
                Budgets = budgets,
                Held = Held(),
                Migration = migration,
                AccountingUnavailable = !_store.Database.Available,
            };
        }

        private static string Notice(string? stored) => stored == null ? "none" : stored.StartsWith("seen", StringComparison.Ordinal) ? "seen" : stored;

        // Automatic requests waiting at send, by hold reason.
        private IReadOnlyDictionary<string, int> Held()
        {
            var map = new SortedDictionary<string, int>(StringComparer.Ordinal);
            try
            {
                if (!_store.Database.Available) return map;
                _store.Database.Read(c =>
                {
                    using var cmd = RequestLedger.Cmd(c, null, "SELECT j.reason,COUNT(*) FROM jobs j JOIN wants w ON w.id=j.want_id WHERE j.state IN ('retry','parked') AND w.origin_kind IN ('automation','sync','list','import') GROUP BY j.reason");
                    using var r = cmd.ExecuteReader();
                    while (r.Read()) map[r.GetString(0)] = r.GetInt32(1);
                    return 0;
                });
            }
            catch (Exception ex) when (ex is SqliteException or InvalidOperationException)
            {
                // Status only.
            }

            return map;
        }

        /// <summary>Marks the one-time migration notice as seen (true when it was pending).</summary>
        public bool DismissNotice()
        {
            if (_store.Meta(AutomationMigration.NoticeKey) != "pending") return false;
            _store.SetMeta(AutomationMigration.NoticeKey, "seen:" + _now().ToString("O", System.Globalization.CultureInfo.InvariantCulture));
            return true;
        }
    }
}
