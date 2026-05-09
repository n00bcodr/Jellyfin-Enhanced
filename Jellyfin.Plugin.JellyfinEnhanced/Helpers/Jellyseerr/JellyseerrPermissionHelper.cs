using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    public static class JellyseerrPermissionHelper
    {
        /// <summary>
        /// Returns true iff <paramref name="userPermissions"/> contains EVERY bit
        /// in <paramref name="permissionToCheck"/>. Audit C01-MED-44: when
        /// <paramref name="permissionToCheck"/> is <see cref="JellyseerrPermission.NONE"/>
        /// (0), the bitwise comparison is trivially true for any input which
        /// can mislead callers expecting a "user has zero permissions" check.
        /// We explicitly return <c>false</c> for NONE so the helper never
        /// returns a misleading positive.
        /// </summary>
        public static bool HasPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionToCheck)
        {
            if (permissionToCheck == JellyseerrPermission.NONE) return false;
            return (userPermissions & permissionToCheck) == permissionToCheck;
        }

        /// <summary>
        /// Returns true iff <paramref name="userPermissions"/> contains AT LEAST
        /// ONE bit in <paramref name="permissionsToCheck"/>. Same NONE caveat
        /// as <see cref="HasPermission"/>: passing 0 always returns false.
        /// </summary>
        public static bool HasAnyPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionsToCheck)
        {
            if (permissionsToCheck == JellyseerrPermission.NONE) return false;
            return (userPermissions & permissionsToCheck) != 0;
        }
    }
}
