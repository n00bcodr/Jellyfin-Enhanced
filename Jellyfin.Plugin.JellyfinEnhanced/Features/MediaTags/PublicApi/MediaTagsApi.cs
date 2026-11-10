using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PublicApi
{
    /// <summary>
    /// The Media Tags feature's surface for other features (artifacts/restructure-plan/backend.md §7.7). Another
    /// feature may reference this namespace and nothing else in Features.MediaTags (FeatureBoundaryTests). Forwarding
    /// only: each member calls the existing implementation, with no logic of its own.
    /// </summary>
    public static class MediaTagsApi
    {
        /// <summary>Forwards to <see cref="TagCacheService.Instance"/> for the members other features call.</summary>
        public static class TagCache
        {
            /// <summary><c>TagCacheService.Instance?.OnLogoSettingsChanged()</c>.</summary>
            public static void OnLogoSettingsChanged() => TagCacheService.Instance?.OnLogoSettingsChanged();

            /// <summary><c>TagCacheService.Instance?.OnRatingSourceSettingsChanged()</c>.</summary>
            public static void OnRatingSourceSettingsChanged() => TagCacheService.Instance?.OnRatingSourceSettingsChanged();

            /// <summary><c>TagCacheService.Instance?.RefreshRatingSourceAvailability()</c>.</summary>
            public static void RefreshRatingSourceAvailability() => TagCacheService.Instance?.RefreshRatingSourceAvailability();
        }

        /// <summary>Forwards to the static <see cref="PosterTags.NativeClientPolicy"/> members other features read.</summary>
        public static class NativeClients
        {
            /// <summary><c>NativeClientPolicy.BuiltInWebClients</c> (the same list instance).</summary>
            public static System.Collections.Generic.IReadOnlyList<string> BuiltInWebClients => PosterTags.NativeClientPolicy.BuiltInWebClients;
        }
    }
}
