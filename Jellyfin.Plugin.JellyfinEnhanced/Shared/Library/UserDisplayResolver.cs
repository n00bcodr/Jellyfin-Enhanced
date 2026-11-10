using System;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Library
{
    /// <summary>"Name (id)" for log lines, shared by every feature (restructure S2.0b, moved verbatim from JellyfinEnhancedController).</summary>
    public sealed class UserDisplayResolver
    {
        private readonly IUserManager _userManager;

        public UserDisplayResolver(IUserManager userManager)
        {
            _userManager = userManager;
        }

        public string ResolveUserDisplay(string userId)
        {
            try
            {
                // Accept both dashed and dashless GUIDs
                if (Guid.TryParse(userId, out var guid) ||
                    Guid.TryParseExact(userId, "N", out guid))
                {
                    var user = _userManager.GetUserById(guid);
                    if (user != null)
                        return $"{user.Username} ({userId})";
                }
            }
            catch { /* non-fatal */ }
            return userId;
        }
    }
}
