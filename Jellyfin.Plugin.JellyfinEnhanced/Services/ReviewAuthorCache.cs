using System;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Review authors resolved recently, shared across requests. On both
    /// Jellyfin 10.11 and 12 <c>IUserManager.GetUserById</c> reads the database
    /// (about 8 ms per author on the lab server), and the tag-cache delta
    /// resolves every author in the review store on every navigation.
    ///
    /// The cached user decides review visibility (hidden, disabled and deleted
    /// authors), so it must never outlive a change to that user. Each entry
    /// keeps the author's Jellyfin user version as stamped before the lookup
    /// (<see cref="UserAuthority.ReadOncePerRequest"/>) and is served only while
    /// <see cref="UserAuthority.Unchanged"/>: the author's own version moves on
    /// the Jellyfin user actions JE brackets for them (the Dashboard's policy
    /// save, which 10.11 makes without an event), on JE's own changes to them
    /// (maintenance mode) and on Jellyfin's events about them; a change whose
    /// person isn't known before it runs (sign-in by name) counts, once it has
    /// run, only for the person it turned out to be about
    /// (<see cref="UserChangeAttribution"/>), so someone signing in doesn't make
    /// every author read again. A miss reads the author once per request
    /// (<see cref="UserAuthority.ReadOncePerRequest"/>). The event consumers
    /// (<c>ReviewAuthorCacheInvalidator</c>) and maintenance mode also clear the
    /// whole cache, and a lookup that raced an invalidation never leaves an
    /// entry that is served (<see cref="UserAccessCache{TKey, TValue}"/>). The TTL only bounds a
    /// change made by other code with no event (another plugin's direct save).
    /// </summary>
    internal static class ReviewAuthorCache
    {
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(15);

        // Jellyfin never reuses a user id, so "no such user" stays true (served for the TTL without the version check).
        private static readonly UserAccessCache<Guid, JUser?> _entries = new(Ttl, 8192, final: user => user == null);

        /// <summary>
        /// The Jellyfin user behind <paramref name="userId"/> (null when the
        /// user no longer exists), from the cache while fresh and still valid.
        /// </summary>
        /// <param name="userId">The review author's user id.</param>
        /// <param name="lookup">Resolves the user when the cache has no valid entry.</param>
        public static JUser? Resolve(Guid userId, Func<Guid, JUser?> lookup)
            // The stamp is taken before the read: a change that lands during it
            // moves the version past the stamp (or leaves it unsettled), so the
            // entry is never served for a later request; an invalidation during
            // it ends the entry too. Read once per request.
            => _entries.GetHeld(userId, userId, () => UserAuthority.ReadOncePerRequest(userId, lookup));

        /// <summary>Drops every cached author (any user's policy, name or existence changed).</summary>
        public static void Invalidate() => _entries.InvalidateAll();
    }
}
