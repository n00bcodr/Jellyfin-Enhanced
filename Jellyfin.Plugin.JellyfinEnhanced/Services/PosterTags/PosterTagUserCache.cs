using System;
using System.Collections.Concurrent;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    // A short-lived cache in front of IUserManager.GetUserById for the native
    // poster tag hot paths. On Jellyfin 12 every GetUserById opens a DB
    // context and runs a serializable SQLite transaction (6-12 ms measured):
    // an image request paid it once for the viewer and once PER REVIEW AUTHOR
    // (twice, for the pinned hash and the render data), so a warm
    // composite-cache hit on an item with half a dozen reviews cost 40-90 ms,
    // and metadata stamping paid it per DTO, making a 100-item /Items response
    // ~400 ms slower.
    //
    // Safe because the users are only read: library access and parental
    // rating (GetItemById<BaseItem>(id, user)), the admin flag, and the
    // hidden/disabled flags that decide review visibility. A policy change
    // takes effect within the TTL. Jellyfin's image endpoints are anonymous
    // anyway; this only decides whose tag data is drawn. Null results are
    // cached too, so a deleted review author is not looked up again on every
    // poster.
    public sealed class PosterTagUserCache
    {
        private const int MaxEntries = 4096;
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

        private readonly IUserManager _userManager;
        private readonly ConcurrentDictionary<Guid, (JUser? User, DateTime At)> _cache = new();

        public PosterTagUserCache(IUserManager userManager)
        {
            _userManager = userManager;
        }

        /// <summary>The user, or null when there is none (either answer is cached for the TTL).</summary>
        public JUser? Get(Guid userId)
        {
            if (userId == Guid.Empty) return null;
            var now = DateTime.UtcNow;
            if (_cache.TryGetValue(userId, out var hit) && now - hit.At < Ttl) return hit.User;

            var user = _userManager.GetUserById(userId);
            if (_cache.Count >= MaxEntries) _cache.Clear();
            _cache[userId] = (user, now);
            return user;
        }
    }
}
