using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// The phase-4 switch hierarchy, as every route and worker checks it (never only the page):
    /// <c>ArrPhase4Enabled</c> needs the integration and phase 1; the automation engine needs phase 4 and phase 3.
    /// The rollout Shadow override is a separate, durable deployment guard that no other switch turns off.
    /// </summary>
    public static class AutomationFlags
    {
        /// <summary>Kill-switch id that stands for Jellyfin Enhanced's own sends to Seerr.</summary>
        public const string SeerrTarget = "seerr";

        /// <summary>Phase 4 is in effect: the integration, phase 1 and phase 4 are on.</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool Phase4(PluginConfiguration? config) => config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase4Enabled: true };

        /// <summary>Phase 4 with phase 3 (lists, rules, recipes and the Ready playlist need both).</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool Phase4WithRequests(PluginConfiguration? config) => Phase4(config) && config!.ArrPhase3Enabled;

        /// <summary>The automation engine is in effect: phase 4, phase 3 and the engine switch are on.</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool Engine(PluginConfiguration? config) => Phase4WithRequests(config) && config!.ArrPhase4AutomationEnabled;

        /// <summary>The rollout Shadow override is on (whatever else is on or off).</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool ShadowOverride(PluginConfiguration? config) => config?.ArrAutomationShadowOverride == true;

        /// <summary>The global kill switch is on.</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool KilledAll(PluginConfiguration? config) => config?.ArrAutomationKillAll == true;

        /// <summary>
        /// True when the kill switch of the target (a Sonarr/Radarr instance id, or <see cref="SeerrTarget"/>) is on.
        /// </summary>
        /// <param name="config">Configuration (null: off).</param>
        /// <param name="target">Instance id or <c>seerr</c>.</param>
        public static bool KilledTarget(PluginConfiguration? config, string? target)
            => !string.IsNullOrEmpty(target) && (config?.ArrAutomationKilledInstances ?? string.Empty)
                .Split(new[] { ',', ';', '\n', '\r', ' ' }, StringSplitOptions.RemoveEmptyEntries)
                .Any(id => string.Equals(id.Trim(), target, StringComparison.OrdinalIgnoreCase));

        /// <summary>
        /// The recipe's mode as it applies now, and why when it doesn't act: the Shadow override makes everything Shadow;
        /// without the engine the answer is null (the existing features behave as before); an old recipe whose own switch
        /// is off is Off; a recipe the backend can't run is unavailable; status only refuses every request.
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <param name="recipe">Recipe id.</param>
        public static AutomationControl Control(PluginConfiguration? config, string recipe)
        {
            if (ShadowOverride(config)) return new(AutomationMode.Shadow, AutomationMode.Shadow, "shadow_override", Engine(config));
            if (!Engine(config)) return new(null, null, "engine_off", false);
            var stored = AutomationModes.Mode(config!, recipe);
            if (stored == AutomationMode.Off) return new(stored, AutomationMode.Off, "recipe_off", true);
            // An old recipe whose own switch (Auto Season / Auto Movie Request) is off does nothing, whatever its mode.
            if (!AutomationRecipes.SwitchedOn(config, recipe)) return new(stored, AutomationMode.Off, "recipe_off", true);
            if (config!.ArrRequestBackend is not ("je" or "seerr") && !AutomationRecipes.IsMembershipOnly(recipe)) return new(stored, AutomationMode.Off, "requests_off", true);
            if (config.ArrRequestBackend == "seerr" && AutomationRecipes.RequiresDirect(recipe)) return new(stored, AutomationMode.Off, "seerr_unsupported", true);
            if (stored == AutomationMode.Shadow) return new(stored, AutomationMode.Shadow, null, true);
            if (KilledAll(config) || AutomationModes.Killed(config, recipe)) return new(stored, AutomationMode.Off, "automation_killed", true);
            return new(stored, stored, null, true);
        }
    }

    /// <summary>
    /// A recipe's mode as it applies now. <c>Stored</c>: the mode on the configuration page (null without the engine);
    /// <c>Effective</c>: what it does (null: the engine is off and the existing behaviour applies); <c>Reason</c>: why it
    /// differs (shadow_override, engine_off, recipe_off, requests_off, seerr_unsupported, automation_killed);
    /// <c>Engine</c>: the engine is on.
    /// </summary>
    /// <param name="Stored">Stored mode.</param>
    /// <param name="Effective">Effective mode.</param>
    /// <param name="Reason">Why it doesn't act as stored.</param>
    /// <param name="Engine">The automation engine is in effect.</param>
    public sealed record AutomationControl(AutomationMode? Stored, AutomationMode? Effective, string? Reason, bool Engine)
    {
        /// <summary>The existing (pre-phase-4) behaviour applies: no engine, no override.</summary>
        public bool Legacy => Effective == null;
    }
}
