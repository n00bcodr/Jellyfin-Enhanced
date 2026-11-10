using System.Collections.Generic;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions
{
    /// <summary>User enumeration through the supported Jellyfin 12 API.</summary>
    internal static class UserManagerExtensions
    {
        /// <summary>Returns all users from the server's user manager.</summary>
        public static IEnumerable<Jellyfin.Database.Implementations.Entities.User> GetAllUsers(
            this IUserManager userManager) => userManager.GetUsers();
    }
}
