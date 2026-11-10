using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.PublicApi
{
    /// <summary>
    /// The Spoiler Guard feature's surface for other features (artifacts/restructure-plan/backend.md §7.7). Another
    /// feature may reference this namespace and nothing else in Features.SpoilerGuard (FeatureBoundaryTests). Forwarding
    /// only: each member calls the existing implementation, with no logic of its own.
    /// </summary>
    public static class SpoilerGuardApi
    {
        /// <summary>Forwards to <see cref="SpoilerAutoEnableFilter"/> for the members other features call.</summary>
        public static class AutoEnableFilter
        {
            /// <summary><c>SpoilerAutoEnableFilter.AllowsType(cfg, isSeries)</c>.</summary>
            public static bool AllowsType(PluginConfiguration? cfg, bool isSeries) => SpoilerAutoEnableFilter.AllowsType(cfg, isSeries);
        }
    }
}
