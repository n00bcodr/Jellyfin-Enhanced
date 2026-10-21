using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;

namespace JE.Tests;

/// <summary>
/// A whole-document write of a per-user document carries the revision its writer read (If-Match); without one it is
/// refused once a document is stored (stage 1 fix round 9). Tests of what such a write stores make the writer one that
/// has just read the document.
/// </summary>
internal static class DocumentRevisions
{
    /// <summary>The writer read <paramref name="fileName"/> of <paramref name="userId"/> just now: its next write sends that revision.</summary>
    public static JellyfinEnhancedController HavingRead<T>(this JellyfinEnhancedController controller, UserConfigurationManager manager, string userId, string fileName) where T : new()
    {
        controller.HttpContext.Request.Headers.IfMatch = "\"" + UserConfigurationManager.DocumentRevision(manager.GetUserConfiguration<T>(userId, fileName)) + "\"";
        return controller;
    }

    /// <summary>The writer read the person's settings.json just now.</summary>
    public static JellyfinEnhancedController HavingRead(this JellyfinEnhancedController controller, UserConfigurationManager manager, string userId)
        => controller.HavingRead<JellyfinEnhancedUserSettings>(manager, userId, UserConfigurationManager.SettingsFileName);
}
