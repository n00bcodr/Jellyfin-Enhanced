using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr
{
    /// <summary>
    /// Process-wide Seerr caches (restructure S2.0b, moved verbatim from JellyfinEnhancedController, backend.md §6 R3).
    /// The *arr queue/history caches live here too because <see cref="ClearAllSeerrCachesOnConfigChange"/> clears them.
    /// </summary>
    internal static class SeerrCaches
    {
        // Server-side cache for proxied avatar images to avoid re-fetching from
        // upstream Seerr on every request. Entries expire after 1 hour.
        internal static readonly ConcurrentDictionary<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> _avatarCache = new();
        internal static readonly TimeSpan _avatarCacheDuration = TimeSpan.FromHours(1);

        // Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId)
        internal static readonly Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> _userIdCache = new();
        internal static readonly object _userIdCacheLock = new();

        // Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache)
        internal static readonly Dictionary<string, (JellyseerrUser? User, DateTime CachedAt)> _userCache = new();
        internal static readonly object _userCacheLock = new();

        // Cache for Seerr proxy responses (discovery/search endpoints)
        internal static readonly Dictionary<string, (string Content, DateTime CachedAt)> _responseCache = new();
        internal static readonly object _responseCacheLock = new();

        // Throttle for manual user import
        internal static DateTime _lastManualImport = DateTime.MinValue;
        internal static readonly object _importThrottleLock = new();

        // cache the result of /api/v1/status probes so a Seerr outage
        // doesn't cause every failed proxy call to issue a fresh status check.
        // Negative-cached for 30s; positive results expire on the same TTL.
        internal static (bool Active, DateTime CachedAt)? _seerrStatusCache;
        internal static readonly object _seerrStatusCacheLock = new();
        internal static readonly TimeSpan _seerrStatusCacheTtl = TimeSpan.FromSeconds(30);

        /// <summary>
        /// The answer <see cref="IsSeerrReachableCached"/> would give right now if it
        /// can be given from the probe cache alone; null when a probe would be needed.
        /// </summary>
        internal static bool? TryGetCachedSeerrReachability()
        {
            lock (_seerrStatusCacheLock)
            {
                if (_seerrStatusCache.HasValue
                    && DateTime.UtcNow - _seerrStatusCache.Value.CachedAt < _seerrStatusCacheTtl)
                {
                    return _seerrStatusCache.Value.Active;
                }
            }

            return null;
        }

        // Cache for request-page TMDB enrichments (movie/tv detail lookups via Jellyseerr)
        internal static readonly Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt)> _tmdbEnrichmentCache = new();
        internal static readonly object _tmdbEnrichmentCacheLock = new();
        internal static readonly ConcurrentDictionary<string, Task<TmdbEnrichmentResult>> _tmdbEnrichmentInFlight = new();

        internal static TimeSpan GetResponseCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        internal static TimeSpan GetUserIdCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        internal static TimeSpan GetTmdbEnrichmentCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        internal sealed class TmdbEnrichmentResult
        {
            public string? Title { get; init; }
            public int? Year { get; init; }
            public string? PosterUrl { get; init; }
            public string? DigitalReleaseDate { get; init; }
            public string? TheatricalReleaseDate { get; init; }
            public string? InitialAirDate { get; init; }
            public string? NextAirDate { get; init; }
        }

        internal static void ClearUserCaches()
        {
            lock (_userCacheLock)
            {
                _userCache.Clear();
            }

            lock (_userIdCacheLock)
            {
                _userIdCache.Clear();
            }
        }

        public static void ClearAllSeerrCachesOnConfigChange()
        {
            ClearUserCaches();
            lock (_responseCacheLock)
            {
                _responseCache.Clear();
            }
            lock (_tmdbEnrichmentCacheLock)
            {
                _tmdbEnrichmentCache.Clear();
            }
            // Avatar cache may reference the OLD Seerr URL — clear it too.
            _avatarCache.Clear();
            // also flush the cached status probe so admins see fresh
            // reachability immediately after fixing config.
            lock (_seerrStatusCacheLock) { _seerrStatusCache = null; }
            // Arr instance URLs/keys may have just changed too — drop the merged
            // queue/history caches rather than waiting out their TTL.
            lock (_arrQueueCacheLock) { _arrQueueCache = null; }
            lock (_arrHistoryCacheLock) { _arrHistoryCache = null; }
        }

        // *arr download caches (Downloads), cleared by ClearAllSeerrCachesOnConfigChange.
        // Merged, unfiltered (all-instances) results are cached process-wide for a short TTL
        // tied to the admin's own poll interval — per-user visibility (DownloadsFilterByUserRequests /
        // DownloadsHistoryAdminOnly) is always applied fresh, AFTER the cache read, so nothing
        // user-specific is ever stored in these caches.
        internal static (List<object> Items, List<object> Errors, DateTime CachedAt)? _arrQueueCache;
        internal static readonly object _arrQueueCacheLock = new();
        internal static (List<dynamic> Items, DateTime CachedAt)? _arrHistoryCache;
        internal static readonly object _arrHistoryCacheLock = new();
    }
}
