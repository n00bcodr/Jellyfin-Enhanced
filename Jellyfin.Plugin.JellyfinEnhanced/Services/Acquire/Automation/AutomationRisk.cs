using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>How much an automatic action can undo or destroy.</summary>
    public enum AutomationRisk
    {
        /// <summary>Refresh or rescan: automatic, rate-limited.</summary>
        R0Refresh,

        /// <summary>Additive (add, monitor, item search): automatic under policy and budgets.</summary>
        R1Additive,

        /// <summary>Corrective (mark failed and search again, remove from the queue and blocklist, grab a held release): never scheduled automatically here.</summary>
        R2Corrective,

        /// <summary>Reductive (unmonitor): only with an explicit policy that enables it.</summary>
        R3Reductive,

        /// <summary>Destructive (delete files or titles, remove with the client's data, manual import): never automatic.</summary>
        R4Destructive,
    }

    /// <summary>
    /// Which risk classes automatic work may schedule: R0 and R1 (under their rate limits and budgets); R2 never (no new
    /// automatic corrective remediation in this phase); R3 only with an explicit policy; R4 never. An action this
    /// version doesn't know is R4 (fail closed).
    /// </summary>
    public static class AutomationRiskPolicy
    {
        /// <summary>True when automatic work may schedule an action of this class.</summary>
        /// <param name="risk">Risk class.</param>
        /// <param name="explicitReductivePolicy">An administrator explicitly enabled reductive automation.</param>
        public static bool MaySchedule(AutomationRisk risk, bool explicitReductivePolicy = false) => risk switch
        {
            AutomationRisk.R0Refresh => true,
            AutomationRisk.R1Additive => true,
            AutomationRisk.R3Reductive => explicitReductivePolicy,
            _ => false,
        };

        /// <summary>The risk class of an action name (unknown: R4).</summary>
        /// <param name="action">Action name.</param>
        public static AutomationRisk Of(string? action) => action?.Trim().ToLowerInvariant() switch
        {
            "refresh" or "rescan" or "scan" or "refresh_series" or "refresh_movie" => AutomationRisk.R0Refresh,
            "add" or "monitor" or "search" or "request" => AutomationRisk.R1Additive,
            "mark_failed" or "blocklist" or "queue_remove" or "grab" => AutomationRisk.R2Corrective,
            "unmonitor" => AutomationRisk.R3Reductive,
            _ => AutomationRisk.R4Destructive,
        };

        /// <summary>True when automatic work may schedule the named action.</summary>
        /// <param name="action">Action name.</param>
        /// <param name="explicitReductivePolicy">An administrator explicitly enabled reductive automation.</param>
        public static bool MaySchedule(string? action, bool explicitReductivePolicy = false) => MaySchedule(Of(action), explicitReductivePolicy);
    }
}
