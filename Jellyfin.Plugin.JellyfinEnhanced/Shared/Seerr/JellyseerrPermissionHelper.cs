
namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr
{
    public static class JellyseerrPermissionHelper
    {
        public static bool HasPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionToCheck)
        {
            if (permissionToCheck == JellyseerrPermission.NONE) return false;
            return (userPermissions & permissionToCheck) == permissionToCheck;
        }

        public static bool HasAnyPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionsToCheck)
        {
            if (permissionsToCheck == JellyseerrPermission.NONE) return false;
            return (userPermissions & permissionsToCheck) != 0;
        }
    }
}
