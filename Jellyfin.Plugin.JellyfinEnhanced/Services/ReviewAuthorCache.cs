using System;
using System.Collections.Concurrent;
using System.Threading;
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
    /// keeps the author's Jellyfin user version as sampled before the lookup
    /// (<see cref="UserAuthority.Version"/>) and is served only while that is
    /// unchanged: it moves on the Jellyfin user actions JE brackets (the
    /// Dashboard's policy save, which 10.11 makes without an event), on JE's own
    /// user changes (maintenance mode) and on Jellyfin's user events. The event
    /// consumers (<c>ReviewAuthorCacheInvalidator</c>) and maintenance mode also
    /// clear the whole cache, and a generation counter stops a lookup that raced
    /// an invalidation from storing the pre-change user. The TTL only bounds a
    /// change made by other code with no event (another plugin's direct save).
    /// </summary>
    internal static class ReviewAuthorCache
    {
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(15);
        private static readonly ConcurrentDictionary<Guid, (JUser? User, DateTime CachedAt, long Generation, long Stamp)> _entries = new();
        private static long _generation;

        /// <summary>
        /// The Jellyfin user behind <paramref name="userId"/> (null when the
        /// user no longer exists), from the cache while fresh and still valid.
        /// </summary>
        /// <param name="userId">The review author's user id.</param>
        /// <param name="lookup">Resolves the user when the cache has no valid entry.</param>
        public static JUser? Resolve(Guid userId, Func<Guid, JUser?> lookup)
        {
            var generation = Interlocked.Read(ref _generation);
            var now = DateTime.UtcNow;
            if (_entries.TryGetValue(userId, out var cached)
                && cached.Generation == generation
                && now - cached.CachedAt < Ttl
                // Jellyfin never reuses a user id, so "no such user" stays true.
                && (cached.User == null || UserAuthority.Unchanged(userId, cached.Stamp)))
            {
                return cached.User;
            }

            // Sampled before the read: a change that lands during it moves the
            // version past the stamp (or leaves it unsettled), so the entry is
            // never served for a later request.
            var stamp = UserAuthority.Version(userId);
            var user = lookup(userId);
            // Only store what was read under the current generation: if an
            // update/delete invalidated the cache while we were reading, the
            // user we hold may predate it.
            if (Interlocked.Read(ref _generation) == generation)
            {
                _entries[userId] = (user, now, generation, stamp);
            }

            return user;
        }

        /// <summary>Drops every cached author (any user's policy, name or existence changed).</summary>
        public static void Invalidate()
        {
            Interlocked.Increment(ref _generation);
            _entries.Clear();
        }
    }
}
