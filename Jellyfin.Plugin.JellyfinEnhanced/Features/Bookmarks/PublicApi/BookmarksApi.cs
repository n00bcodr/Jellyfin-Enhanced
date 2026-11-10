using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks.PublicApi
{
    /// <summary>
    /// The Bookmarks feature's surface for other features (artifacts/restructure-plan/backend.md §7.7). Another feature
    /// may reference this namespace and nothing else in Features.Bookmarks (FeatureBoundaryTests). Forwarding only: each
    /// member calls the existing implementation, with no logic of its own.
    /// </summary>
    public static class BookmarksApi
    {
        /// <summary>Forwards to <see cref="BookmarkDocumentService"/> for the members other features call.</summary>
        public static class Documents
        {
            /// <summary><c>new BookmarkDocumentService(userConfigurationManager).Read(userId)</c>.</summary>
            public static BookmarkDocumentResponse Read(UserConfigurationManager userConfigurationManager, string userId)
                => new BookmarkDocumentService(userConfigurationManager).Read(userId);
        }
    }
}
