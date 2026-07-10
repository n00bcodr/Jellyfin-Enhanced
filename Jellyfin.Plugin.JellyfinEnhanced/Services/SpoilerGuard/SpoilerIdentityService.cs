using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Per-user identity markers embedded in image tags ("tagged image URLs").
    //
    // Native clients (Android TV, Swiftfin, Roku, …) fetch item images with a
    // fully anonymous GET — no Authorization header, no token, no cookie
    // (verified in every client's source; the Kotlin/Swift SDK image-URL
    // builders have no credential support at all). The ONLY user-correlated
    // value on the wire is the `?tag=` query param, which every client echoes
    // verbatim from the authenticated, per-user item DTO it received. So:
    // SpoilerIdentityTagFilter appends "-jeu{12hex}" (this user's marker) to
    // every image-tag field it serves, and SpoilerUserResolver extracts the
    // marker from `?tag=` on the image request to attribute it to that user —
    // no IP involvement, which is what makes Spoiler Guard precise behind
    // reverse proxies that hide the real client IP.
    //
    // The marker is an UNKEYED short hash of the userId — deliberately not an
    // HMAC. Spoiler Guard protects a user from their OWN spoilers: a forged
    // marker only lets a client deliberately request another user's blur
    // policy, i.e. self-spoil — and anonymous requests from IPs with no
    // sessions already receive clean bytes today, so forgery gains nothing.
    // What actually matters is (a) collision resistance between real users
    // (12 hex = 48 bits; pairwise collision odds are negligible and detected
    // at map build), and (b) staleness: a marker naming a deleted/unknown
    // user simply fails to resolve and the resolver falls back to the
    // existing IP ladder. Strictly additive, fail-safe.
    public sealed class SpoilerIdentityService
    {
        // Tag suffix sentinel. Composes with the existing "sb-{8hex}-{tag}"
        // cache-bust PREFIX (final tag: "sb-{8hex}-{origTag}-jeu{12hex}").
        // "jeu" (JE user) cannot appear inside Jellyfin's hex image tags, and
        // the fixed "-jeu" + 12-hex shape keeps extraction unambiguous.
        public const string MarkerSentinel = "-jeu";
        public const int MarkerHexLength = 12;

        // Rebuild the marker→user map at most this often on a miss, so a
        // stream of requests carrying stale/unknown markers can't force a
        // per-request user-enumeration storm (mirrors the resolver's F8
        // negative-cache posture).
        private static readonly TimeSpan MapRebuildMinInterval = TimeSpan.FromSeconds(5);
        private static readonly TimeSpan MapTtl = TimeSpan.FromSeconds(60);

        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        private readonly ConcurrentDictionary<Guid, string> _mintCache = new();
        private readonly object _mapLock = new();
        private Dictionary<string, Guid>? _markerMap;
        private DateTime _mapBuiltAt = DateTime.MinValue;

        public SpoilerIdentityService(IUserManager userManager, Logger logger)
        {
            _userManager = userManager;
            _logger = logger;
        }

        /// <summary>
        /// The stable 12-hex marker for a user: prefix of SHA-256 over the
        /// N-format userId. Deterministic across restarts (no persisted
        /// secret needed) so native-client image caches stay valid.
        /// </summary>
        public string MintMarker(Guid userId)
        {
            return _mintCache.GetOrAdd(userId, static id =>
            {
                var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(id.ToString("N")));
                return Convert.ToHexString(bytes).Substring(0, MarkerHexLength).ToLowerInvariant();
            });
        }

        /// <summary>
        /// Appends the marker suffix to a tag value. Idempotent: a tag that
        /// already carries a marker suffix is returned unchanged (guards
        /// against a filter re-entry double-stamping).
        /// </summary>
        public static string AppendMarker(string tag, string marker)
        {
            if (string.IsNullOrEmpty(tag)) return tag;
            if (TryParseMarker(tag, out _, out _)) return tag;
            return tag + MarkerSentinel + marker;
        }

        /// <summary>
        /// Extracts a trailing "-jeu{12hex}" marker from a tag value.
        /// Returns the base tag (marker stripped) and the marker hex.
        /// </summary>
        public static bool TryParseMarker(string? tag, out string baseTag, out string marker)
        {
            baseTag = tag ?? string.Empty;
            marker = string.Empty;
            if (string.IsNullOrEmpty(tag)) return false;

            var suffixLen = MarkerSentinel.Length + MarkerHexLength;
            if (tag.Length <= suffixLen) return false;
            var sentinelStart = tag.Length - suffixLen;
            if (string.CompareOrdinal(tag, sentinelStart, MarkerSentinel, 0, MarkerSentinel.Length) != 0) return false;

            for (var i = tag.Length - MarkerHexLength; i < tag.Length; i++)
            {
                var c = tag[i];
                var isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                if (!isHex) return false;
            }

            baseTag = tag.Substring(0, sentinelStart);
            marker = tag.Substring(sentinelStart + MarkerSentinel.Length);
            return true;
        }

        /// <summary>
        /// Forces the next resolution to rebuild the marker→user map. Called
        /// by the user-created/deleted event consumers so a just-created
        /// user's freshly stamped marker resolves immediately instead of
        /// waiting out the rebuild throttle (which exists to stop unknown-
        /// marker spray from forcing a user enumeration per request).
        /// </summary>
        public void InvalidateMap()
        {
            lock (_mapLock)
            {
                _mapBuiltAt = DateTime.MinValue;
            }
        }

        /// <summary>
        /// Resolves a marker back to a CURRENT user id. Unknown markers
        /// (stale tag from a deleted user, forged value, hash of nobody)
        /// return false and the caller falls back to the IP ladder.
        /// </summary>
        public bool TryResolveMarker(string marker, out Guid userId)
        {
            userId = Guid.Empty;
            if (string.IsNullOrEmpty(marker)) return false;

            var map = GetOrBuildMap(allowRebuildOnMiss: false);
            if (map != null && map.TryGetValue(marker, out userId)) return true;

            // Miss — the map may predate a just-created user. Rebuild at most
            // once per MapRebuildMinInterval, then try once more.
            map = GetOrBuildMap(allowRebuildOnMiss: true);
            return map != null && map.TryGetValue(marker, out userId);
        }

        private Dictionary<string, Guid>? GetOrBuildMap(bool allowRebuildOnMiss)
        {
            var now = DateTime.UtcNow;
            var current = _markerMap;
            var age = now - _mapBuiltAt;
            var fresh = current != null && age < MapTtl;
            if (fresh && !allowRebuildOnMiss) return current;
            if (current != null && allowRebuildOnMiss && age < MapRebuildMinInterval) return current;

            lock (_mapLock)
            {
                // Re-check under the lock — another request may have rebuilt.
                var recheckAge = DateTime.UtcNow - _mapBuiltAt;
                if (_markerMap != null
                    && (allowRebuildOnMiss ? recheckAge < MapRebuildMinInterval : recheckAge < MapTtl))
                {
                    return _markerMap;
                }

                try
                {
                    var map = new Dictionary<string, Guid>(StringComparer.Ordinal);
                    var collided = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var user in _userManager.GetAllUsers())
                    {
                        var m = MintMarker(user.Id);
                        if (!map.TryAdd(m, user.Id))
                        {
                            // Astronomically unlikely (48-bit pairwise), but a
                            // collision must never MIS-attribute: drop both
                            // users from marker resolution — they fall back to
                            // the IP ladder, which is correct, just coarser.
                            collided.Add(m);
                        }
                    }

                    foreach (var m in collided)
                    {
                        map.Remove(m);
                        _logger.Warning($"Spoiler Guard identity: two users share marker {m}; both excluded from tag-based identity (falling back to IP matching for them).");
                    }

                    _markerMap = map;
                    _mapBuiltAt = DateTime.UtcNow;
                    return map;
                }
                catch (Exception ex)
                {
                    // Keep serving the previous map (possibly stale) rather
                    // than failing resolution outright.
                    _logger.Warning($"Spoiler Guard identity: user enumeration failed while building the marker map: {ex.Message}");
                    _mapBuiltAt = DateTime.UtcNow; // throttle retry storms
                    return _markerMap;
                }
            }
        }
    }
}
