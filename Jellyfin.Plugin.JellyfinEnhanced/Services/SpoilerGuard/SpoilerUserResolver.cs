using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Shared user-resolution + spoiler-state-load helper used by both
    // SpoilerBlurImageFilter and SpoilerFieldStripFilter. Extracted so the
    // IPv6/IPv4-mapped-IPv6/raw-IPv6-with-port handling and the shared-IP
    // ambiguity-window fail-closed logic stays in ONE place — preventing
    // future regressions like the field-strip filter inheriting an old
    // string-compare implementation.
    //
    // Also shares a single HttpContext.Items cache key so a request that
    // triggers BOTH filters (e.g. an /Items batch that ALSO loads images)
    // performs ONE file-read for the per-user spoiler state, not two.
    public sealed class SpoilerUserResolver
    {
        public const string ContextKeyUserState = "__JE_SpoilerBlur_UserState_Shared";

        private static readonly TimeSpan SharedIpAmbiguityWindow = TimeSpan.FromSeconds(5);
        private static readonly TimeSpan PerKeyWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _warnedAt = new();

        // Per-browser identity cookie the web client sets on load (see
        // js/enhanced/spoiler-blur.js). Browsers attach it to every same-origin
        // request INCLUDING anonymous <img>/CSS-background image fetches, which
        // on Jellyfin 12 carry no other user identity (the image endpoint ignores
        // the api_key query param for identity, and <img> tags can't send an
        // Authorization header). We trust it ONLY to disambiguate among users
        // that actually have an active session from the request IP, so a forged
        // value can't impersonate a user who isn't even present.
        public const string SpoilerUidCookie = "je-spoiler-uid";

        // Short-TTL cache of the per-IP session scan. A single page load fires a
        // burst of image requests from one IP; without this each one would
        // re-enumerate ISessionManager.Sessions (O(sessions) + an allocation),
        // which is exactly the per-image latency that shows up as the BlurHash
        // placeholder lingering — and it gets worse the more sessions exist
        // (e.g. a Seerr instance polling the server). Cache the scan result for a
        // couple of seconds so the burst pays for one scan, not dozens.
        private static readonly TimeSpan IpScanCacheTtl = TimeSpan.FromSeconds(2);
        private static readonly ConcurrentDictionary<string, IpScanCacheEntry> _ipScanCache = new();

        private sealed class IpScanCacheEntry
        {
            public required DateTime CachedAt { get; init; }
            public required IReadOnlyList<Guid> Recent { get; init; }
            public required IReadOnlyCollection<Guid> IpUsers { get; init; }
            public required Guid? Best { get; init; }
        }

        private readonly UserConfigurationManager _userConfigManager;
        private readonly ISessionManager _sessionManager;
        private readonly Logger _logger;

        public SpoilerUserResolver(
            UserConfigurationManager userConfigManager,
            ISessionManager sessionManager,
            Logger logger)
        {
            _userConfigManager = userConfigManager;
            _sessionManager = sessionManager;
            _logger = logger;
        }

        // Resolves the requesting user's GUID, falling back to a session-by-IP
        // lookup when ClaimsPrincipal yields no user (anonymous browser image
        // requests, native clients that don't authenticate image fetches).
        // Returns null when session-by-IP is ambiguous (multiple users active
        // from the same IP within the SharedIpAmbiguityWindow) — callers that
        // need a single identity (the field-strip filter) then pass through.
        // The image filter instead uses ResolveCandidateUserIds so it can
        // disambiguate by spoiler scope and fail CLOSED (protect) rather than
        // leak the original bytes. See that method.
        public Guid? ResolveUserId(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var candidates = ResolveCandidateUserIds(httpContext);
            // Exactly one candidate = unambiguous (ClaimsPrincipal, or a single
            // session on the IP). Zero or many = no single safe identity.
            return candidates.Count == 1 ? candidates[0] : (Guid?)null;
        }

        // Resolves the FULL set of plausible requesting users:
        //   • ClaimsPrincipal present  → exactly that user (authoritative).
        //   • else session-by-IP       → every distinct user recently active
        //     from the request IP. One entry when unambiguous; several when a
        //     shared IP (reverse proxy without KnownProxies, NAT) can't pin
        //     the request to one session.
        // The image filter walks these and protects the item if ANY candidate
        // opted into it — fail-closed, so an anonymous image request on a
        // shared IP can no longer leak an opted-in user's unwatched artwork.
        public IReadOnlyList<Guid> ResolveCandidateUserIds(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var primary = UserHelper.GetCurrentUserId(httpContext.User);
            if (primary != null && primary.Value != Guid.Empty)
            {
                return new[] { primary.Value };
            }

            // Anonymous request (browser <img>/CSS-background, or a native
            // TV/mobile image fetch). Resolve by the users with a session from
            // the request IP (cached briefly — see below).
            var (recent, ipUsers, best) = ScanActiveSessionUsersCached(httpContext);

            // Per-browser cookie disambiguation. The je-spoiler-uid cookie pins
            // THIS request to its browser's user — trusted ONLY when that user
            // genuinely has a session from this IP (so a stale/forged value can't
            // impersonate an absent user). We validate against ALL IP sessions,
            // not just recently-active ones, because passively viewing images
            // doesn't refresh a session — a quietly-scrolling user would
            // otherwise age out of the active window and lose their own identity.
            if (httpContext.Request.Cookies.TryGetValue(SpoilerUidCookie, out var raw)
                && Guid.TryParse(raw, out var cookieUid)
                && cookieUid != Guid.Empty
                && ipUsers.Contains(cookieUid))
            {
                return new[] { cookieUid };
            }

            if (recent.Count > 1)
            {
                // Shared IP with no usable cookie (native client, or a
                // forged/stale value naming an absent user): return ALL active
                // users so the image filter fails CLOSED by scope (protect if
                // ANY opted in) rather than leaking the original bytes.
                WarnRateLimited(
                    "shared-ip-nocookie",
                    $"Spoiler Guard resolver: {recent.Count} users active from one IP with no matching {SpoilerUidCookie} cookie (native client, or cookie names an absent user). Disambiguating by spoiler scope. Configure Jellyfin KnownProxies so proxied requests carry the real client IP to restore per-user precision.");
                return recent;
            }

            if (recent.Count == 1) return recent;
            return best.HasValue ? new[] { best.Value } : Array.Empty<Guid>();
        }

        // Cached wrapper over the session scan. Keyed by normalized request IP;
        // entries live for IpScanCacheTtl so a page-load burst of image requests
        // scans ISessionManager.Sessions once instead of once per image.
        private (IReadOnlyList<Guid> Recent, IReadOnlyCollection<Guid> IpUsers, Guid? Best) ScanActiveSessionUsersCached(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return (Array.Empty<Guid>(), Array.Empty<Guid>(), null);
            var ipKey = NormalizeIp(remoteIpRaw).ToString();
            var now = DateTime.UtcNow;

            if (_ipScanCache.TryGetValue(ipKey, out var hit) && (now - hit.CachedAt) < IpScanCacheTtl)
            {
                return (hit.Recent, hit.IpUsers, hit.Best);
            }

            var scanned = ScanActiveSessionUsers(httpContext);
            _ipScanCache[ipKey] = new IpScanCacheEntry { CachedAt = now, Recent = scanned.Recent, IpUsers = scanned.IpUsers, Best = scanned.Best };

            // Opportunistic prune so the cache can't grow unbounded across many
            // distinct client IPs over a long uptime.
            if (_ipScanCache.Count > 512)
            {
                foreach (var kvp in _ipScanCache)
                {
                    if ((now - kvp.Value.CachedAt) >= IpScanCacheTtl) _ipScanCache.TryRemove(kvp.Key, out _);
                }
            }

            return (scanned.Recent, scanned.IpUsers, scanned.Best);
        }

        // Loads (and caches per-request, keyed by userId) the user's
        // UserSpoilerBlur state. Keying by userId lets the image filter probe
        // several shared-IP candidates in one request without the first one's
        // state masking the others; a request that triggers BOTH filters for
        // the SAME user still reads the file once (shared key).
        public UserSpoilerBlur LoadUserState(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            var cacheKey = ContextKeyUserState + ":" + userId.ToString("N");
            if (httpContext.Items.TryGetValue(cacheKey, out var cached)
                && cached is UserSpoilerBlur hit)
            {
                return hit;
            }

            UserSpoilerBlur state;
            try
            {
                state = _userConfigManager.GetUserConfiguration<UserSpoilerBlur>(
                    userId.ToString("N"),
                    SpoilerBlurImageFilter.SpoilerBlurFileName);
            }
            catch (Exception ex)
            {
                // GetUserConfiguration is the LENIENT path — it already
                // swallows IOException + JsonException + parse failures
                // internally and returns `new T()` (it logs at Error level
                // via the config manager's own _logger, so the corruption
                // fact is observable, just not under our namespace). This
                // outer catch-all only fires for exceptions that escape the
                // lenient path (e.g. ResolveUserFile throwing on a bad
                // userId). Rate-limited so a flood of bad requests doesn't
                // spam logs. Strict-read with corruption-503 is available
                // on the dedicated /spoiler-blur/series endpoint and via
                // LoadSpoilerStateForTagStrip.
                WarnRateLimited(
                    "userstate-load:" + ex.GetType().FullName,
                    $"Spoiler Guard resolver: failed to read user state for {userId} — passing through unblurred. {ex.Message}");
                state = new UserSpoilerBlur();
            }
            httpContext.Items[cacheKey] = state;
            return state;
        }

        // Session-by-IP scan. Returns the distinct users active from the
        // request IP:
        //   • empty      → no matching session (bail; nothing to protect).
        //   • one entry  → unambiguous best match.
        //   • many       → shared-IP ambiguity: every user active within the
        //     window. The caller (image filter) resolves this by spoiler
        //     scope; the single-identity caller (field-strip) treats it as
        //     "no single user" and passes through.
        private (IReadOnlyList<Guid> Recent, IReadOnlyCollection<Guid> IpUsers, Guid? Best) ScanActiveSessionUsers(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return (Array.Empty<Guid>(), Array.Empty<Guid>(), null);
            var remoteIp = NormalizeIp(remoteIpRaw);

            // Per-session try/catch instead of one outer try around the
            // whole iteration. Previously a single misbehaving SessionInfo
            // (e.g. a corrupt RemoteEndPoint string) aborted iteration of
            // ALL sessions; one bad row hid every healthy match. Now a
            // per-session failure logs a rate-limited warn and continues.
            SessionInfo? best = null;
            Guid? bestUser = null;
            var recentlyActiveUsers = new HashSet<Guid>();
            // Every distinct user with a session from this IP, regardless of how
            // recently active — the cookie-disambiguation set (a passively
            // image-viewing user stays here even after their session idles).
            var allIpUsers = new HashSet<Guid>();
            var now = DateTime.UtcNow;

            // Snapshot the live IEnumerable INSIDE the outer try.
            // ISessionManager.Sessions can return a live view; foreach's
            // MoveNext can throw InvalidOperationException ("Collection was
            // modified") that would escape both inner per-session catches
            // AND the outer property-access catch. ToArray() forces
            // materialization here so the enumerator hazard is contained.
            SessionInfo[] sessions;
            try
            {
                sessions = _sessionManager.Sessions.ToArray();
            }
            catch (Exception ex)
            {
                WarnRateLimited(
                    "session-list:" + ex.GetType().FullName,
                    $"Spoiler Guard resolver: ISessionManager.Sessions enumeration threw: {ex.Message}");
                return (Array.Empty<Guid>(), Array.Empty<Guid>(), null);
            }

            foreach (var s in sessions)
            {
                try
                {
                    if (s.UserId == Guid.Empty) continue;
                    if (!RemoteEndpointIpEquals(s.RemoteEndPoint, remoteIp)) continue;

                    allIpUsers.Add(s.UserId);
                    if ((now - s.LastActivityDate) < SharedIpAmbiguityWindow)
                    {
                        recentlyActiveUsers.Add(s.UserId);
                    }
                    if (best == null || s.LastActivityDate > best.LastActivityDate)
                    {
                        best = s;
                        bestUser = s.UserId;
                    }
                }
                catch (Exception ex)
                {
                    WarnRateLimited(
                        "session-iter:" + ex.GetType().FullName,
                        $"Spoiler Guard resolver: skipped a session row during IP match: {ex.Message}");
                    continue;
                }
            }

            // Return the recently-active set (for the no-cookie fail-closed
            // fallback), the full IP-user set (for cookie validation), and the
            // single best match. ResolveCandidateUserIds applies the cookie
            // first, then falls back to fail-closed-by-scope.
            return (recentlyActiveUsers.ToArray(), allIpUsers, bestUser);
        }

        // Returns the canonical IPAddress for comparison: IPv4-mapped-IPv6
        // unwrapped to IPv4, scope IDs cleared.
        private static System.Net.IPAddress NormalizeIp(System.Net.IPAddress addr)
        {
            if (addr.IsIPv4MappedToIPv6) return addr.MapToIPv4();
            if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 && addr.ScopeId != 0)
            {
                return new System.Net.IPAddress(addr.GetAddressBytes());
            }
            return addr;
        }

        private void RemoteEndpointParseFailedWarn(string endpoint)
        {
            var safe = endpoint.Length > 80 ? endpoint.Substring(0, 80) + "…" : endpoint;
            WarnRateLimited(
                "endpoint-parse",
                $"Spoiler Guard resolver: unrecognized SessionInfo.RemoteEndPoint format '{safe}' — session-by-IP fallback offline. Likely a Jellyfin format change.");
        }

        private bool RemoteEndpointIpEquals(string? endpoint, System.Net.IPAddress remoteIp)
        {
            if (string.IsNullOrEmpty(endpoint)) return false;

            if (System.Net.IPEndPoint.TryParse(endpoint, out var parsed))
            {
                return NormalizeIp(parsed.Address).Equals(remoteIp);
            }
            if (System.Net.IPAddress.TryParse(endpoint, out var bare))
            {
                return NormalizeIp(bare).Equals(remoteIp);
            }

            // Raw IPv6-with-port without brackets (e.g. "::1:1234") parses as
            // a single IPv6 address by both parsers — strip the trailing
            // ":port" and try again.
            var lastColon = endpoint.LastIndexOf(':');
            if (lastColon > 0 && lastColon < endpoint.Length - 1)
            {
                var portCandidate = endpoint.Substring(lastColon + 1);
                if (int.TryParse(portCandidate, out _))
                {
                    var addressOnly = endpoint.Substring(0, lastColon);
                    if (System.Net.IPAddress.TryParse(addressOnly, out var stripped))
                    {
                        return NormalizeIp(stripped).Equals(remoteIp);
                    }
                }
            }

            RemoteEndpointParseFailedWarn(endpoint);
            return false;
        }

        public void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = _warnedAt.AddOrUpdate(key, now,
                (_, last) => (now - last) >= PerKeyWarnInterval ? now : last);
            if (stored != now) return;
            _logger.Warning(message);
        }

        // Track per-user corruption events so the admin can surface a
        // banner in the JE management UI when any user's spoilerblur.json
        // was rolled into the .corrupt-backup file. The file-on-disk has
        // been rewritten with an empty state by UserConfigurationManager
        // (fail-open per SECURITY.md) so the user's image/strip pipeline
        // silently no-ops until they re-enable items. Surfacing this lets
        // the user know to retry.
        private static readonly ConcurrentDictionary<string, CorruptionEvent> _corruptionLog = new();

        public class CorruptionEvent
        {
            public string UserDisplay { get; set; } = string.Empty;
            public DateTime At { get; set; }
            public string Reason { get; set; } = string.Empty;
        }

        public static void RecordCorruption(string userKey, string userDisplay, string reason)
        {
            _corruptionLog[userKey] = new CorruptionEvent
            {
                UserDisplay = userDisplay,
                At = DateTime.UtcNow,
                Reason = reason,
            };
        }

        public static IReadOnlyDictionary<string, CorruptionEvent> GetCorruptionLog()
        {
            return _corruptionLog;
        }

        public static void ClearCorruption(string userKey)
        {
            _corruptionLog.TryRemove(userKey, out _);
        }
    }
}
