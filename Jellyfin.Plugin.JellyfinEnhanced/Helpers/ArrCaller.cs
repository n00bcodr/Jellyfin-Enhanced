using System;
using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Who is calling a "Requests &amp; downloads" route (arr, acquire, notify and JE backup routes):
    /// one answer for every controller. A <em>person</em> is a Jellyfin user the server knows,
    /// signed in with their own token. These are never a person:
    /// <list type="bullet">
    /// <item><description>an API key (Jellyfin marks it with <c>Jellyfin-IsApiKey</c>; its user id is the
    /// empty GUID and it carries the administrator role claim, so a role check alone would let it in);</description></item>
    /// <item><description>a principal whose user id is missing or the empty GUID;</description></item>
    /// <item><description>a user id Jellyfin doesn't know (deleted since the token was issued).</description></item>
    /// </list>
    /// Per-user routes refuse such callers (403 <c>user_required</c>, nothing stored) and administrator
    /// routes refuse them too: an administrator is a person whose Jellyfin account has the
    /// administrator permission, never just a role claim.
    /// </summary>
    public static class ArrCaller
    {
        /// <summary>The claim Jellyfin's authentication handler sets to "True" for API-key callers.</summary>
        public const string ApiKeyClaim = "Jellyfin-IsApiKey";

        /// <summary>True when the caller authenticated with an API key (not a user's token).</summary>
        public static bool IsApiKey(ClaimsPrincipal principal)
            => bool.TryParse(UserHelper.GetClaimValue(principal, ApiKeyClaim), out var apiKey) && apiKey;

        /// <summary>
        /// The caller's own Jellyfin user id, or null for an API key, a missing user id or the empty
        /// GUID. Doesn't check that Jellyfin knows the user (see <see cref="Human(ClaimsPrincipal, IArrJellyfinView)"/>).
        /// </summary>
        public static Guid? PersonId(ClaimsPrincipal principal)
        {
            if (IsApiKey(principal)) return null;
            return UserHelper.GetCurrentUserId(principal) is Guid id && id != Guid.Empty ? id : null;
        }

        /// <summary>The calling person as a status viewer, or null (API key, empty GUID, unknown user).</summary>
        public static StatusViewer? Human(ClaimsPrincipal principal, IArrJellyfinView view)
        {
            if (PersonId(principal) is not Guid id) return null;
            try
            {
                return view.Viewer(id);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>The calling person when they are a Jellyfin administrator, else null.</summary>
        public static StatusViewer? Admin(ClaimsPrincipal principal, IArrJellyfinView view)
            => Human(principal, view) is { IsAdmin: true } viewer ? viewer : null;

        /// <summary>The calling person's Jellyfin account, or null (API key, empty GUID, unknown user).</summary>
        public static User? Human(ClaimsPrincipal principal, IUserManager users)
        {
            if (PersonId(principal) is not Guid id) return null;
            try
            {
                return Find(id, users) is { } user && !user.HasPermission(PermissionKind.IsDisabled) ? user : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// A known user by id, including a disabled account for housekeeping. Empty ids return
        /// null. Lookup failures propagate, so housekeeping never takes an unreadable user for a
        /// deleted one; caller checks catch them at the route boundary.
        /// </summary>
        public static User? Find(Guid id, IUserManager users)
            => id == Guid.Empty ? null : users.GetUserById(id);

        /// <summary>True when the caller is a person whose Jellyfin account has the administrator permission.</summary>
        public static bool IsAdmin(ClaimsPrincipal principal, IUserManager users)
            => Human(principal, users) is { } user && user.HasPermission(PermissionKind.IsAdministrator);
    }
}
