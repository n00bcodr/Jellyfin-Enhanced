using System;
using System.Collections.Generic;
using System.Reflection;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Extensions
{
    /// <summary>
    /// Compatibility shim for the breaking IUserManager change between Jellyfin 10.11.8 and 10.11.9.
    ///
    /// Jellyfin 10.11.9 removed the <c>IUserManager.Users</c> property and replaced it with a
    /// <c>GetUsers()</c> method. Plugins compiled against 10.11.8 throw <see cref="MissingMethodException"/>
    /// at JIT time when running on 10.11.9 (and vice-versa). This shim detects which API is available
    /// at runtime via reflection so the plugin works on both versions.
    /// </summary>
    internal static class UserManagerExtensions
    {
        // Cached once per process: true = GetUsers() method exists (10.11.9+), false = use Users property (≤10.11.8)
        private static readonly Lazy<bool> _hasGetUsers = new Lazy<bool>(() =>
            typeof(IUserManager).GetMethod(
                "GetUsers",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                Type.EmptyTypes,
                null) != null);

        private static readonly Lazy<MethodInfo?> _getUsersMethod = new Lazy<MethodInfo?>(() =>
            typeof(IUserManager).GetMethod(
                "GetUsers",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                Type.EmptyTypes,
                null));

        private static readonly Lazy<PropertyInfo?> _usersProperty = new Lazy<PropertyInfo?>(() =>
            typeof(IUserManager).GetProperty(
                "Users",
                BindingFlags.Public | BindingFlags.Instance));

        /// <summary>
        /// Returns all users from the user manager, compatible with both Jellyfin ≤10.11.8
        /// (which exposes a <c>Users</c> property) and Jellyfin 10.11.9+ (which exposes a
        /// <c>GetUsers()</c> method).
        /// </summary>
        public static IEnumerable<Jellyfin.Database.Implementations.Entities.User> GetAllUsers(
            this IUserManager userManager)
        {
            if (_hasGetUsers.Value)
            {
                // Jellyfin 10.11.9+: IUserManager.GetUsers()
                var result = _getUsersMethod.Value!.Invoke(userManager, null);
                return (IEnumerable<Jellyfin.Database.Implementations.Entities.User>)result!;
            }
            else
            {
                // Jellyfin ≤10.11.8: IUserManager.Users property
                var result = _usersProperty.Value!.GetValue(userManager);
                return (IEnumerable<Jellyfin.Database.Implementations.Entities.User>)result!;
            }
        }
    }
}
