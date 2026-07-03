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
            return ScanActiveSessionUsers(httpContext);
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
        private IReadOnlyList<Guid> ScanActiveSessionUsers(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            var remoteIp = NormalizeIp(remoteIpRaw);

            // Per-session try/catch instead of one outer try around the
            // whole iteration. Previously a single misbehaving SessionInfo
            // (e.g. a corrupt RemoteEndPoint string) aborted iteration of
            // ALL sessions; one bad row hid every healthy match. Now a
            // per-session failure logs a rate-limited warn and continues.
            SessionInfo? best = null;
            Guid? bestUser = null;
            var recentlyActiveUsers = new HashSet<Guid>();
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
                return Array.Empty<Guid>();
            }

            foreach (var s in sessions)
            {
                try
                {
                    if (s.UserId == Guid.Empty) continue;
                    if (!RemoteEndpointIpEquals(s.RemoteEndPoint, remoteIp)) continue;

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

            if (recentlyActiveUsers.Count > 1)
            {
                // Shared-IP ambiguity: return ALL recently-active users so the
                // image filter can protect the item if any of them opted in
                // (fail-closed by scope), instead of leaking the original.
                WarnRateLimited(
                    "shared-ip:" + remoteIp.ToString(),
                    $"Spoiler Guard resolver: ambiguous session-by-IP match for {remoteIp} — {recentlyActiveUsers.Count} distinct users active within {SharedIpAmbiguityWindow.TotalSeconds}s. Disambiguating by spoiler scope (protect if any candidate opted in). To pin requests to one user, configure Jellyfin's KnownProxies if behind a reverse proxy so the request IP reflects the actual client.");
                return recentlyActiveUsers.ToArray();
            }

            return bestUser.HasValue ? new[] { bestUser.Value } : Array.Empty<Guid>();
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
