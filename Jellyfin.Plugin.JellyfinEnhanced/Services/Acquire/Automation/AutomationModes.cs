using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>How a recipe acts: never, decide and record only, ask for an OK, or act.</summary>
    public enum AutomationMode
    {
        /// <summary>The recipe does nothing.</summary>
        Off,

        /// <summary>The recipe decides and records what it would have done: no want, approval, quota, arr call or list change.</summary>
        Shadow,

        /// <summary>Every request the recipe makes waits for an OK, whoever it is for.</summary>
        Ask,

        /// <summary>The recipe's requests go ahead under the usual rules (an ineligible person's still wait for an OK).</summary>
        Auto,
    }

    /// <summary>The recipes the automation engine knows, and what each needs from the request backend.</summary>
    public static class AutomationRecipes
    {
        /// <summary>Next-season keeper (the existing auto season request).</summary>
        public const string AutoSeason = "auto_season";

        /// <summary>Collection completer (the existing auto movie request).</summary>
        public const string AutoMovie = "auto_movie";

        /// <summary>Keep-up for airing shows (phase 4g).</summary>
        public const string KeepUp = "keep_up";

        /// <summary>List acquire-ahead while a list is played (phase 4g).</summary>
        public const string ListAcquireAhead = "list_acquire_ahead";

        /// <summary>Release-day arming: one extra search 6 hours after release (phase 4g).</summary>
        public const string ReleaseDay = "release_day";

        /// <summary>Scheduled linked-list sync (membership changes, phase 4c2).</summary>
        public const string ListSync = "list_sync";

        /// <summary>Asks for titles a linked list's sync added (phase 4g).</summary>
        public const string ListSyncRequests = "list_sync_requests";

        /// <summary>Every recipe, in the order the configuration page lists them.</summary>
        public static readonly IReadOnlyList<string> All = new[] { AutoSeason, AutoMovie, KeepUp, ListAcquireAhead, ReleaseDay, ListSync, ListSyncRequests };

        /// <summary>
        /// Recipes that need guarantees only Sonarr/Radarr handling gives (a targeted search, per-instance budgets, a
        /// known destination folder): unavailable while Seerr handles requests.
        /// </summary>
        private static readonly HashSet<string> DirectOnly = new(StringComparer.Ordinal) { ReleaseDay };

        /// <summary>Recipes that only change list membership (no request): their kill switch stops list effects only.</summary>
        private static readonly HashSet<string> MembershipOnly = new(StringComparer.Ordinal) { ListSync };

        /// <summary>True for a recipe id this version knows.</summary>
        /// <param name="recipe">Recipe id.</param>
        public static bool Known(string? recipe) => recipe != null && All.Contains(recipe, StringComparer.Ordinal);

        /// <summary>True for the recipes that existed before phase 4 (they keep working with phase 4 off).</summary>
        /// <param name="recipe">Recipe id.</param>
        public static bool IsLegacy(string? recipe) => recipe is AutoSeason or AutoMovie;

        /// <summary>
        /// False while an old recipe's own enable switch (Auto Season Request / Auto Movie Request) is off: it then records
        /// and sends nothing, whatever its mode. True for every other recipe.
        /// </summary>
        /// <param name="config">Configuration as it is now (null: off).</param>
        /// <param name="recipe">Recipe id.</param>
        public static bool SwitchedOn(PluginConfiguration? config, string? recipe) => recipe switch
        {
            AutoSeason => config?.AutoSeasonRequestEnabled == true,
            AutoMovie => config?.AutoMovieRequestEnabled == true,
            _ => true,
        };

        /// <summary>True when the recipe can't run while Seerr handles requests.</summary>
        /// <param name="recipe">Recipe id.</param>
        public static bool RequiresDirect(string? recipe) => recipe != null && DirectOnly.Contains(recipe);

        /// <summary>True when the recipe changes list membership only and never makes a request itself.</summary>
        /// <param name="recipe">Recipe id.</param>
        public static bool IsMembershipOnly(string? recipe) => recipe != null && MembershipOnly.Contains(recipe);
    }

    /// <summary>One recipe's stored settings (part of <see cref="PluginConfiguration.ArrAutomationRecipes"/>).</summary>
    public sealed record AutomationRecipeSettings
    {
        /// <summary>off, shadow, ask or auto. Missing or unreadable: shadow.</summary>
        [JsonPropertyName("mode")] public string Mode { get; init; } = "shadow";

        /// <summary>The recipe's kill switch (false: not killed).</summary>
        [JsonPropertyName("killed")] public bool Killed { get; init; }
    }

    /// <summary>Reads and writes the stored recipe modes and kill switches.</summary>
    public static class AutomationModes
    {
        private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

        /// <summary>Parses a stored mode; anything unknown is Shadow (never Auto by accident).</summary>
        /// <param name="value">Stored mode.</param>
        public static AutomationMode Parse(string? value) => value?.Trim().ToLowerInvariant() switch
        {
            "off" => AutomationMode.Off,
            "ask" => AutomationMode.Ask,
            "auto" => AutomationMode.Auto,
            _ => AutomationMode.Shadow,
        };

        /// <summary>The stored form of a mode.</summary>
        /// <param name="mode">Mode.</param>
        public static string Name(AutomationMode mode) => mode.ToString().ToLowerInvariant();

        /// <summary>Every known recipe's settings (a recipe not stored: Shadow, not killed).</summary>
        /// <param name="config">Configuration.</param>
        public static IReadOnlyDictionary<string, AutomationRecipeSettings> Read(PluginConfiguration config)
        {
            Dictionary<string, AutomationRecipeSettings>? stored = null;
            if (!string.IsNullOrWhiteSpace(config.ArrAutomationRecipes) && config.ArrAutomationRecipes.Length < 100_000)
            {
                try
                {
                    stored = JsonSerializer.Deserialize<Dictionary<string, AutomationRecipeSettings>>(config.ArrAutomationRecipes, Json);
                }
                catch (JsonException)
                {
                    stored = null;
                }
            }

            var map = new Dictionary<string, AutomationRecipeSettings>(StringComparer.Ordinal);
            foreach (var recipe in AutomationRecipes.All)
            {
                var found = stored?.FirstOrDefault(p => string.Equals(p.Key, recipe, StringComparison.OrdinalIgnoreCase)).Value;
                map[recipe] = found == null ? new AutomationRecipeSettings() : found with { Mode = Name(Parse(found.Mode)) };
            }

            return map;
        }

        /// <summary>One recipe's stored mode.</summary>
        /// <param name="config">Configuration.</param>
        /// <param name="recipe">Recipe id.</param>
        public static AutomationMode Mode(PluginConfiguration config, string recipe)
            => Read(config).TryGetValue(recipe, out var s) ? Parse(s.Mode) : AutomationMode.Shadow;

        /// <summary>True when the recipe's own kill switch is on.</summary>
        /// <param name="config">Configuration.</param>
        /// <param name="recipe">Recipe id.</param>
        public static bool Killed(PluginConfiguration config, string recipe)
            => Read(config).TryGetValue(recipe, out var s) && s.Killed;

        /// <summary>The stored JSON for these settings (every known recipe, in order).</summary>
        /// <param name="settings">Settings by recipe.</param>
        public static string Write(IReadOnlyDictionary<string, AutomationRecipeSettings> settings)
            => JsonSerializer.Serialize(AutomationRecipes.All.ToDictionary(r => r, r => settings.TryGetValue(r, out var s) ? s : new AutomationRecipeSettings()));
    }
}
