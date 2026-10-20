using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// What a cache keyed by a Jellyfin user's authority checks before it answers, so a change to the user applies to
    /// the next request however it was made. Neither Jellyfin version tells plugins about every change: 10.11 saves a
    /// policy without an event, and both save <c>UpdateUserAsync</c> without one. So:
    /// <list type="bullet">
    /// <item><description><see cref="Fingerprint"/>, every access-deciding fact of a user object, DERIVED from the
    /// classification of the host's user types (<see cref="UserAuthorityFields"/>): for a cache whose caller has just
    /// read the user (a request's own lookup), which therefore sees any change, however it was made.</description></item>
    /// <item><description><see cref="Take"/>, the person's version (<see cref="Stamp"/>): their own Jellyfin user version,
    /// which moves on every Jellyfin user action JE brackets for that person (the policy and user API on both versions),
    /// on JE's own changes to them (maintenance mode) and on Jellyfin's events about them; and the changes whose person
    /// wasn't known before they ran (sign-in by name, user creation), counted once they have run against the person they
    /// turned out to be about (<see cref="UserChangeAttribution"/>), or against everyone when that can't be told. Keyed
    /// by access, a cache checks the fingerprint AND the person's part; a cache that holds the user itself (review
    /// authors, poster tags), where reading the user again is the cost it saves, checks both parts.</description></item>
    /// </list>
    /// "Unsettled" isn't "changed": someone else's change, or one whose person isn't known yet, leaves other people's
    /// entries alone (a request running alongside it may see the state before it, as it would had it come a moment
    /// sooner). A change of the person themselves in flight is a change.
    /// </summary>
    internal static class UserAuthority
    {
        private static readonly object RequestReadsKey = new();

        // Changes whose person wasn't known before they ran, once they have: per person they turned out to be about, and
        // the ones whose person couldn't be told (every person's).
        private static readonly ConcurrentDictionary<Guid, long> Attributed = new();
        private static long _unknown;

        /// <summary>
        /// Appends what the arr status viewer's policy revision hashes (<c>ArrJellyfinView.Viewer</c>): role, library
        /// access (all, enabled and blocked folders), parental rating, blocked and allowed tags, blocked unrated items,
        /// and "show missing episodes". That revision is stored with each request's authorization, so its input stays
        /// fixed (a tag holding a separator is escaped, so no two policies share it; every other revision is unchanged);
        /// the caches keyed by access use <see cref="Fingerprint"/>, which covers every access-deciding fact.
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
            foreach (var t in blockedTags.OrderBy(t => t, StringComparer.Ordinal)) Escaped(fingerprint, t).Append(',');
            fingerprint.Append('|');
            foreach (var t in allowedTags.OrderBy(t => t, StringComparer.Ordinal)) Escaped(fingerprint, t).Append(',');
            fingerprint.Append('|');
            foreach (var u in blockedUnrated.OrderBy(u => u)) fingerprint.Append((int)u).Append(',');
            fingerprint.Append('|');
            foreach (var f in blockedFolders.OrderBy(f => f)) fingerprint.Append(f.ToString("N", CultureInfo.InvariantCulture)).Append(',');
            fingerprint.Append('|').Append(user.DisplayMissingEpisodes ? 'M' : '-');
        }

        // A tag as part of the revision: '\', ',' and '|' (its separators) escaped, so a tag holding them can't pass for
        // the structure (two different policies never share a revision). A tag without them is written as it is, so the
        // revisions stored with existing requests stay what they were.
        private static StringBuilder Escaped(StringBuilder text, string tag)
        {
            if (tag.IndexOfAny(['\\', ',', '|']) < 0) return text.Append(tag);
            foreach (var c in tag)
            {
                if (c is '\\' or ',' or '|') text.Append('\\');
                text.Append(c);
            }

            return text;
        }

        /// <summary>
        /// The user's authority as one string: every property of the user, its permissions and its preferences except
        /// those classified as not deciding access (<see cref="UserAuthorityFields"/>), so channels, Live TV, schedules,
        /// devices and any property a newer Jellyfin adds are in it. Equal strings mean the same authority.
        /// </summary>
        /// <param name="user">The user, as just read.</param>
        /// <returns>The fingerprint.</returns>
        public static string Fingerprint(JUser user) => UserAuthorityFields.Fingerprint(user);

        /// <summary>A person's version: their own Jellyfin user version, and the changes of unknown person that have run.</summary>
        /// <param name="Own">The person's own Jellyfin user version (<see cref="JellyfinUserVersions.SampleOwn"/>).</param>
        /// <param name="Attributed">How many changes of unknown person turned out to be about them.</param>
        /// <param name="Unknown">How many changes of unknown person couldn't be told (every person's).</param>
        public readonly record struct Stamp(long Own, long Attributed, long Unknown);

        /// <summary>The person's version now: take it BEFORE reading what is cached under it.</summary>
        /// <param name="userId">The user.</param>
        /// <returns>The stamp.</returns>
        public static Stamp Take(Guid userId)
            => new(JellyfinUserVersions.SampleOwn(userId), Attributed.GetValueOrDefault(userId), Interlocked.Read(ref _unknown));

        /// <summary>
        /// True when nothing changed the person since <paramref name="stamp"/>: their own version is settled and equal (a
        /// change of theirs in flight counts), no change of unknown person turned out to be about them, and none ended that
        /// couldn't be told. Someone else's sign-in, in flight or done, doesn't count.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="stamp">The stamp taken before the value was read.</param>
        /// <returns>True when the value may still be served.</returns>
        public static bool Unchanged(Guid userId, Stamp stamp) => OwnUnchanged(userId, stamp) && Interlocked.Read(ref _unknown) == stamp.Unknown;

        /// <summary>
        /// The person's own part only: for a cache that also checks the user as just read (<see cref="Fingerprint"/>),
        /// which a change whose person couldn't be told shows if it was about them.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="stamp">The stamp taken before the value was computed.</param>
        /// <returns>True when the person's own version hasn't moved, nothing of theirs is in flight and no change of unknown
        /// person turned out to be about them.</returns>
        public static bool OwnUnchanged(Guid userId, Stamp stamp)
            => FactVersion.Settled(stamp.Own) && JellyfinUserVersions.SampleOwn(userId) == stamp.Own
                && Attributed.GetValueOrDefault(userId) == stamp.Attributed;

        /// <summary>
        /// A change whose person wasn't known before it ran has run (<see cref="UserChangeAttribution"/>): it was about
        /// <paramref name="person"/>; <see cref="Guid.Empty"/> when it touched nobody; null when that can't be told (every
        /// person's entries are read again).
        /// </summary>
        /// <param name="person">Whom it was about.</param>
        internal static void Finished(Guid? person)
        {
            if (person == null) Interlocked.Increment(ref _unknown);
            else if (person.Value != Guid.Empty) Attributed.AddOrUpdate(person.Value, 1, (_, n) => n + 1);
        }

        /// <summary>
        /// The user read once per request: the first call in a request reads (<paramref name="lookup"/>, with the stamp
        /// taken before), later calls in the same request get that read. A read is never handed to another request, in
        /// flight or done; outside a request every call reads.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="lookup">The read (Jellyfin's <c>GetUserById</c>: a database query on both versions).</param>
        /// <returns>The user (null when there is none) and the stamp taken before it was read.</returns>
        public static (JUser? User, Stamp Stamp) ReadOncePerRequest(Guid userId, Func<Guid, JUser?> lookup)
        {
            var http = new HttpContextAccessor().HttpContext;
            if (http == null) return Read(userId, lookup);
            ConcurrentDictionary<Guid, Lazy<(JUser?, Stamp)>> reads;
            lock (http.Items)
            {
                if (http.Items.TryGetValue(RequestReadsKey, out var held) && held is ConcurrentDictionary<Guid, Lazy<(JUser?, Stamp)>> existing)
                {
                    reads = existing;
                }
                else
                {
                    http.Items[RequestReadsKey] = reads = new ConcurrentDictionary<Guid, Lazy<(JUser?, Stamp)>>();
                }
            }

            return reads.GetOrAdd(userId, id => new Lazy<(JUser?, Stamp)>(() => Read(id, lookup))).Value;
        }

        private static (JUser? User, Stamp Stamp) Read(Guid userId, Func<Guid, JUser?> lookup)
        {
            // Taken before the read: a change landing during it moves the version past the stamp.
            var stamp = Take(userId);
            return (lookup(userId), stamp);
        }
    }
}
