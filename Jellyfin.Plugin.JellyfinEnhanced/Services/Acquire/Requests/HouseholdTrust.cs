using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// The Trusted role behind the automation engine's trust seam: a person whose server-owned household role is Trusted,
    /// while household rules are on, may have automatic requests go ahead without an OK. Trusted grants no approval,
    /// household names, Manage or administrator operations; nobody is made Trusted by any migration.
    /// </summary>
    public sealed class HouseholdTrust : IAutomationTrust
    {
        private readonly Func<PluginConfiguration?> _config;

        /// <summary>Creates the seam over the plugin's live configuration (DI).</summary>
        public HouseholdTrust()
            : this(() => JellyfinEnhanced.Instance?.Configuration)
        {
        }

        /// <summary>Creates the seam over an explicit configuration (tests).</summary>
        /// <param name="config">Configuration source.</param>
        internal HouseholdTrust(Func<PluginConfiguration?> config) { _config = config; }

        /// <inheritdoc />
        public bool IsTrusted(Guid user)
        {
            var config = _config();
            return HouseholdFlags.Rules(config) && user != Guid.Empty
                && RequestPolicy.NormalizeRole(RequestPolicy.Settings(config!, user).Role ?? config!.ArrRequestDefaultRole, true) == "Trusted";
        }
    }
}
