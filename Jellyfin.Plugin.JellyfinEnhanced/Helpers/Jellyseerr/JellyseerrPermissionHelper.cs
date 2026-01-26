using Jellyfin.Plugin.JellyfinEnhanced.Model.Seerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Seerr
{
    public static class JellyseerrPermissionHelper
    {
        public static bool HasPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionToCheck)
        {
            return (userPermissions & permissionToCheck) == permissionToCheck;
        }

        public static bool HasAnyPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionsToCheck)
        {
            return (userPermissions & permissionsToCheck) != 0;
        }
    }
}
