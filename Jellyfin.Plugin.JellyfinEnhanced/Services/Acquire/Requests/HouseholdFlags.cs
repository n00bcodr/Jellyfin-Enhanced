using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// The phase-4b switches as every route, policy check and worker reads them (never only the page). Household rules
    /// (the Trusted role and the fixed conditions) need phase 4 with phase 3; the conditions and group quotas apply only
    /// while Jellyfin Enhanced handles requests (Seerr's own rules apply in Seerr mode). Administrator Seerr request
    /// options need phase 4 with phase 3 and their own switch; the JE-only rule switches are not their parents.
    /// </summary>
    public static class HouseholdFlags
    {
        /// <summary>Household rules are on: the Trusted role can be given and counts (any request handling).</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool Rules(PluginConfiguration? config) => AutomationFlags.Phase4WithRequests(config) && config!.ArrPhase4HouseholdRulesEnabled;

        /// <summary>The fixed conditions decide requests: household rules on and Jellyfin Enhanced handling requests.</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool RulesApply(PluginConfiguration? config) => Rules(config) && config!.ArrRequestBackend == "je";

        /// <summary>Group quota pools count: the conditions apply and the group-quota switch is on.</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool Pools(PluginConfiguration? config) => RulesApply(config) && config!.ArrPhase4GroupQuotasEnabled;

        /// <summary>Administrators may pick Seerr's server, profile and root folder on a request (Seerr permission checked separately).</summary>
        /// <param name="config">Configuration (null: off).</param>
        public static bool SeerrOptions(PluginConfiguration? config) => AutomationFlags.Phase4WithRequests(config) && config!.ArrPhase4SeerrRequestOptionsEnabled;
    }
}
