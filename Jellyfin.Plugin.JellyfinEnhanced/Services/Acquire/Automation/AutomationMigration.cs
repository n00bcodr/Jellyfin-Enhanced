using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// The record of the one-time automation migration: kind (fresh install or upgrade), when, the existing recipes'
    /// on/off state it found, the recipe settings it wrote and how many eligibility grants it recorded.
    /// </summary>
    public sealed record AutomationMigrationRecord
    {
        /// <summary>Migration version.</summary>
        [JsonPropertyName("version")] public int Version { get; init; } = AutomationMigration.Version;

        /// <summary>fresh or upgrade.</summary>
        [JsonPropertyName("kind")] public string Kind { get; init; } = "fresh";

        /// <summary>When it ran (UTC).</summary>
        [JsonPropertyName("at")] public DateTimeOffset At { get; init; }

        /// <summary>The next-season keeper was on.</summary>
        [JsonPropertyName("autoSeason")] public bool AutoSeason { get; init; }

        /// <summary>The collection completer was on.</summary>
        [JsonPropertyName("autoMovie")] public bool AutoMovie { get; init; }

        /// <summary>The recipe settings it wrote (JSON of <see cref="PluginConfiguration.ArrAutomationRecipes"/>).</summary>
        [JsonPropertyName("recipes")] public string Recipes { get; init; } = string.Empty;

        /// <summary>Eligibility grants recorded (Managers whose automatic requests went ahead before).</summary>
        [JsonPropertyName("grants")] public int Grants { get; init; }

        /// <summary>Reads a stored record; null when absent or unreadable.</summary>
        /// <param name="json">Stored JSON.</param>
        public static AutomationMigrationRecord? Read(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            try { return JsonSerializer.Deserialize<AutomationMigrationRecord>(json); }
            catch (JsonException) { return null; }
        }
    }

    /// <summary>
    /// The one-time, durable automation migration. A fresh install stores every recipe in Shadow. An upgrade maps the
    /// existing recipes by their switch: on → Auto, off → Off (new recipes: Shadow). When either was on, every Manager
    /// (by household role, not a Jellyfin administrator) gets a recorded eligibility grant, so their automatic requests
    /// keep going ahead once the engine is on, with a one-time notice for administrators; administrators are eligible
    /// by role and Members keep needing an OK. It runs at most once: the record is kept in both the configuration and
    /// acquire.db, and it only runs when neither has it (a later switch, or restoring one of the two, never reruns it).
    /// Per-person recipe preferences are left unset (null = follow the administrator). The rollout Shadow override is
    /// never touched.
    /// </summary>
    public static class AutomationMigration
    {
        /// <summary>The migration's version.</summary>
        public const int Version = 1;

        /// <summary>acquire.db meta key of the record.</summary>
        public const string MetaKey = "automation_migration";

        /// <summary>acquire.db meta key of the one-time notice: pending, none, or seen:{time}.</summary>
        public const string NoticeKey = "automation_migration_notice";

        /// <summary>The grant source of the legacy migration.</summary>
        public const string LegacySource = "legacy_migration";

        /// <summary>What the migration would write, worked out without writing.</summary>
        /// <param name="config">Configuration as found.</param>
        /// <param name="fresh">A fresh install (no configuration existed before this start).</param>
        /// <param name="managers">Users whose household role is Manager (not Jellyfin administrators).</param>
        /// <param name="now">Now.</param>
        public static (AutomationMigrationRecord Record, IReadOnlyList<Guid> Grants) Plan(PluginConfiguration config, bool fresh, IEnumerable<Guid> managers, DateTimeOffset now)
        {
            var current = AutomationModes.Read(config).ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
            var season = !fresh && config.AutoSeasonRequestEnabled;
            var movie = !fresh && config.AutoMovieRequestEnabled;
            if (!fresh)
            {
                current[AutomationRecipes.AutoSeason] = current[AutomationRecipes.AutoSeason] with { Mode = AutomationModes.Name(season ? AutomationMode.Auto : AutomationMode.Off) };
                current[AutomationRecipes.AutoMovie] = current[AutomationRecipes.AutoMovie] with { Mode = AutomationModes.Name(movie ? AutomationMode.Auto : AutomationMode.Off) };
            }

            var grants = season || movie ? managers.Distinct().ToList() : new List<Guid>();
            var record = new AutomationMigrationRecord { Kind = fresh ? "fresh" : "upgrade", At = now, AutoSeason = season, AutoMovie = movie, Recipes = AutomationModes.Write(current), Grants = grants.Count };
            return (record, grants);
        }

        /// <summary>
        /// Runs the migration once. Returns the record written, or null when it ran before (each side missing the record
        /// gets it back from the other) or can't run yet (grants are due and acquire.db is unavailable: tried at the next start;
        /// until then every recipe reads as Shadow).
        /// </summary>
        /// <param name="config">The live configuration (changed in place; <paramref name="save"/> persists it).</param>
        /// <param name="store">The automation store.</param>
        /// <param name="fresh">A fresh install.</param>
        /// <param name="managers">Users whose household role is Manager.</param>
        /// <param name="now">Now.</param>
        /// <param name="save">Saves the configuration.</param>
        public static AutomationMigrationRecord? Run(PluginConfiguration config, AutomationStore store, bool fresh, Func<IEnumerable<Guid>> managers, DateTimeOffset now, Action save)
        {
            var inConfig = AutomationMigrationRecord.Read(config.ArrAutomationMigration);
            var available = store.Database.Available;
            var inDb = available ? AutomationMigrationRecord.Read(store.Meta(MetaKey)) : null;
            if (inConfig != null || inDb != null)
            {
                if (inConfig == null && inDb != null)
                {
                    config.ArrAutomationMigration = JsonSerializer.Serialize(inDb);
                    if (string.IsNullOrWhiteSpace(config.ArrAutomationRecipes)) config.ArrAutomationRecipes = inDb.Recipes;
                    save();
                }
                else if (inDb == null && available)
                {
                    store.SetMeta(MetaKey, JsonSerializer.Serialize(inConfig));
                }

                return null;
            }

            var (record, grants) = Plan(config, fresh, managers(), now);
            if (!available && grants.Count > 0) return null;
            var json = JsonSerializer.Serialize(record);
            if (available)
            {
                store.Commit(grants.Select(g => (g, LegacySource, (string?)JsonSerializer.Serialize(new { autoSeason = record.AutoSeason, autoMovie = record.AutoMovie }))),
                    new Dictionary<string, string> { [MetaKey] = json, [NoticeKey] = grants.Count > 0 ? "pending" : "none" }, now);
            }

            config.ArrAutomationRecipes = record.Recipes;
            config.ArrAutomationMigration = json;
            save();
            return record;
        }

        /// <summary>The users whose household role is Manager, for the grants (Jellyfin administrators are eligible by role).</summary>
        /// <param name="config">Configuration (roles).</param>
        /// <param name="users">Every user: id and whether a Jellyfin administrator.</param>
        public static IEnumerable<Guid> Managers(PluginConfiguration config, IEnumerable<(Guid Id, bool Admin)> users)
            => users.Where(u => !u.Admin && RequestPolicy.NormalizeRole(RequestPolicy.Settings(config, u.Id).Role ?? config.ArrRequestDefaultRole) == "Manager").Select(u => u.Id);
    }

    /// <summary>Runs the one-time automation migration at start-up (it changes nothing that acts while the engine is off).</summary>
    public sealed class AutomationStartup : IHostedService
    {
        private readonly AutomationStore _store;
        private readonly IUserManager _users;
        private readonly Logger _logger;

        /// <summary>Creates the start-up step (DI).</summary>
        public AutomationStartup(AutomationStore store, IUserManager users, Logger logger)
        {
            _store = store;
            _users = users;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            try
            {
                var plugin = JellyfinEnhanced.Instance;
                if (plugin?.Configuration is not { } config) return Task.CompletedTask;
                var record = AutomationMigration.Run(config, _store, !plugin.ConfigurationExistedAtStart,
                    () => AutomationMigration.Managers(config, _users.GetAllUsers().Select(u => (u.Id, u.HasPermission(PermissionKind.IsAdministrator)))),
                    DateTimeOffset.UtcNow, plugin.SaveConfiguration);
                if (record != null)
                    _logger.Info($"Requests & downloads: automation migration ({record.Kind}) recorded: next season {(record.AutoSeason ? "Auto" : record.Kind == "fresh" ? "Shadow" : "Off")}, next movie {(record.AutoMovie ? "Auto" : record.Kind == "fresh" ? "Shadow" : "Off")}, {record.Grants} eligibility grant(s).");
            }
            catch (Exception ex)
            {
                // Not migrated: every recipe reads as Shadow until it runs (the next start).
                _logger.Warning("Requests & downloads: automation migration didn't run: " + ex.Message);
            }

            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
