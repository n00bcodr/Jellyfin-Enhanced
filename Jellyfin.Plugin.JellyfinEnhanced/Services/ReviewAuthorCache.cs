using System;
using System.Collections.Concurrent;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Review authors resolved recently, shared across requests. On Jellyfin
    /// 12 <c>IUserManager.GetUserById</c> reads the database (about 8 ms per
    /// author on the lab server), and the tag-cache delta resolves every author
    /// in the review store on every navigation.
    ///
    /// The cached user decides review visibility (hidden, disabled and deleted
    /// authors), so it must never outlive a change to that user: the user
    /// update and delete event consumers (<c>ReviewAuthorCacheInvalidator</c>)
    /// clear the whole cache, and a generation counter stops a lookup that
    /// raced an invalidation from storing the pre-change user. The TTL only
    /// bounds anything the events could miss.
    /// </summary>
    internal static class ReviewAuthorCache
    {
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(15);
        private static readonly ConcurrentDictionary<Guid, (JUser? User, DateTime CachedAt, long Generation)> _entries = new();
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
                && now - cached.CachedAt < Ttl)
            {
                return cached.User;
            }

            var user = lookup(userId);
            // Only store what was read under the current generation: if an
            // update/delete invalidated the cache while we were reading, the
            // user we hold may predate it.
            if (Interlocked.Read(ref _generation) == generation)
            {
                _entries[userId] = (user, now, generation);
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
