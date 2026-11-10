namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.PublicApi
{
    /// <summary>
    /// The Seerr feature's surface for other features (artifacts/restructure-plan/backend.md §7.7). Another feature
    /// may reference this namespace and nothing else in Features.Seerr (FeatureBoundaryTests). Forwarding only: each
    /// member calls the existing implementation, with no logic of its own.
    /// </summary>
    public static class SeerrApi
    {
        /// <summary>Forwards to the static status helpers the Seerr routes use, for the Platform bootstrap.</summary>
        public static class Status
        {
            /// <summary><c>JeSeerrController.TryBuildSeerrUserStatusWithoutLookup(config, jellyfinUserId, isAdmin)</c>.</summary>
            public static object? TryBuildSeerrUserStatusWithoutLookup(Configuration.PluginConfiguration? config, string? jellyfinUserId, bool isAdmin)
                => JeSeerrController.TryBuildSeerrUserStatusWithoutLookup(config, jellyfinUserId, isAdmin);

            /// <summary><c>JeSeerrController.SeerrStatusResponse(active)</c>.</summary>
            public static object SeerrStatusResponse(bool active) => JeSeerrController.SeerrStatusResponse(active);
        }
    }
}
