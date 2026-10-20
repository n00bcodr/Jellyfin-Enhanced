using System;
using System.Collections.Concurrent;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
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
    // The users are only read: library access and parental rating
    // (GetItemById<BaseItem>(id, user)), the admin flag, and the
    // hidden/disabled flags that decide review visibility. Each entry keeps
    // the user's Jellyfin user version as stamped before the lookup
    // (UserAuthority.Take) and is served only while UserAuthority.Unchanged,
    // so a policy change applies to the next request: the version moves on the
    // Jellyfin user actions JE brackets for the person (the Dashboard's policy
    // save, which 10.11 makes without an event), on JE's own changes to them
    // (maintenance mode) and on Jellyfin's events about them. A change whose
    // person isn't known before it runs (sign-in by name) counts, once it has
    // run, only for the person it turned out to be about
    // (UserChangeAttribution). A miss reads the user once per request
    // (UserAuthority.ReadOncePerRequest), never sharing a read with another
    // request. The TTL only bounds a change made by other code with no event
    // (another plugin's direct save). Jellyfin's image endpoints are anonymous
    // anyway; this only decides whose tag data is drawn. Null results are
    // cached too (Jellyfin never reuses a user id), so a deleted review author
    // is not looked up again on every poster.
    public sealed class PosterTagUserCache
    {
        private const int MaxEntries = 4096;
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

        private readonly IUserManager _userManager;
        private readonly ConcurrentDictionary<Guid, (JUser? User, DateTime At, UserAuthority.Stamp Stamp)> _cache = new();

        public PosterTagUserCache(IUserManager userManager)
        {
            _userManager = userManager;
        }

        /// <summary>The user, or null when there is none (either answer is cached for the TTL while the user is unchanged).</summary>
        public JUser? Get(Guid userId)
        {
            if (userId == Guid.Empty) return null;
            var now = DateTime.UtcNow;
            if (_cache.TryGetValue(userId, out var hit) && now - hit.At < Ttl
                && (hit.User == null || UserAuthority.Unchanged(userId, hit.Stamp)))
            {
                return hit.User;
            }

            // Stamped before the read, so a change landing during it is never served later.
            var (user, stamp) = UserAuthority.ReadOncePerRequest(userId, _userManager.GetUserById);
            if (_cache.Count >= MaxEntries) _cache.Clear();
            _cache[userId] = (user, now, stamp);
            return user;
        }
    }
}
