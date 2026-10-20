using System;
using System.Globalization;
using System.Linq;
using System.Text;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// What a cache keyed by a Jellyfin user's authority checks before it answers, so a change to the user applies to
    /// the next request however it was made. Neither Jellyfin version tells plugins about every change: 10.11 saves a
    /// policy without an event, and both save <c>UpdateUserAsync</c> without one. So:
    /// <list type="bullet">
    /// <item><description><see cref="Fingerprint"/>, the user's authority read from a user object: for a cache whose
    /// caller has just read the user (a request's own lookup), which therefore sees any change, however it was
    /// made.</description></item>
    /// <item><description><see cref="Version"/>, the person's Jellyfin user version: for a cache that holds the user
    /// itself (review authors, poster tags), where reading the user again is the cost the cache saves (a database query
    /// on both 10.11 and 12.2). It moves on every Jellyfin user action JE brackets (the policy and user API on both
    /// versions), on JE's own user changes (maintenance mode) and on Jellyfin's user events; a change made by other code
    /// without an event (another plugin) waits for the cache's TTL.</description></item>
    /// </list>
    /// </summary>
    internal static class UserAuthority
    {
        /// <summary>
        /// Appends what Jellyfin decides a user may see by: role, library access (all, enabled and blocked folders),
        /// parental rating, blocked and allowed tags, blocked unrated items, and "show missing episodes". The status
        /// viewer's policy revision hashes exactly this.
        /// </summary>
        /// <param name="fingerprint">Where to append.</param>
        /// <param name="user">The user.</param>
        public static void AppendPolicy(StringBuilder fingerprint, JUser user)
        {
            var isAdmin = user.HasPermission(PermissionKind.IsAdministrator);
            var allFolders = user.HasPermission(PermissionKind.EnableAllFolders);
            var folders = allFolders ? Array.Empty<Guid>() : user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders);
            var blockedTags = user.GetPreference(PreferenceKind.BlockedTags) ?? Array.Empty<string>();
            var allowedTags = user.GetPreference(PreferenceKind.AllowedTags) ?? Array.Empty<string>();
            var blockedUnrated = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
            // Folders blocked through the user policy API: library access in another form (like EnabledFolders).
            var blockedFolders = user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders);

            fingerprint.Append(isAdmin ? 'A' : 'U').Append('|').Append(allFolders ? '*' : '-').Append('|');
            foreach (var f in folders.OrderBy(f => f)) fingerprint.Append(f.ToString("N", CultureInfo.InvariantCulture)).Append(',');
            fingerprint.Append('|').Append(user.MaxParentalRatingScore?.ToString(CultureInfo.InvariantCulture) ?? "-")
                .Append('.').Append(user.MaxParentalRatingSubScore?.ToString(CultureInfo.InvariantCulture) ?? "-").Append('|');
            foreach (var t in blockedTags.OrderBy(t => t, StringComparer.Ordinal)) fingerprint.Append(t).Append(',');
            fingerprint.Append('|');
            foreach (var t in allowedTags.OrderBy(t => t, StringComparer.Ordinal)) fingerprint.Append(t).Append(',');
            fingerprint.Append('|');
            foreach (var u in blockedUnrated.OrderBy(u => u)) fingerprint.Append((int)u).Append(',');
            fingerprint.Append('|');
            foreach (var f in blockedFolders.OrderBy(f => f)) fingerprint.Append(f.ToString("N", CultureInfo.InvariantCulture)).Append(',');
            fingerprint.Append('|').Append(user.DisplayMissingEpisodes ? 'M' : '-');
        }

        /// <summary>
        /// The user's authority as one string: <see cref="AppendPolicy"/> plus the disabled and hidden flags (whether
        /// they may sign in, and whether their reviews are shown). Equal strings mean the same authority.
        /// </summary>
        /// <param name="user">The user, as just read.</param>
        /// <returns>The fingerprint.</returns>
        public static string Fingerprint(JUser user)
        {
            var fingerprint = new StringBuilder(128);
            AppendPolicy(fingerprint, user);
            fingerprint.Append('|').Append(user.HasPermission(PermissionKind.IsDisabled) ? 'D' : '-')
                .Append(user.HasPermission(PermissionKind.IsHidden) ? 'H' : '-');
            return fingerprint.ToString();
        }

        /// <summary>
        /// The person's Jellyfin user version now (<see cref="JellyfinUserVersions.Sample"/>): a value cached with an
        /// earlier sample is current only while this is <see cref="FactVersion.Settled"/> and equal to it.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <returns>The sample.</returns>
        public static long Version(Guid userId) => JellyfinUserVersions.Sample(userId);

        /// <summary>True when a value read under <paramref name="stamp"/> may still be served (no change since).</summary>
        /// <param name="userId">The user.</param>
        /// <param name="stamp">The <see cref="Version"/> sampled before the value was read.</param>
        /// <returns>True when unchanged.</returns>
        public static bool Unchanged(Guid userId, long stamp) => FactVersion.Settled(stamp) && Version(userId) == stamp;
    }
}
