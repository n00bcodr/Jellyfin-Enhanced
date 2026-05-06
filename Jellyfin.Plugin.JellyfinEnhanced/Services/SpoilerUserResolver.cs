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
    // SpoilerBlurImageFilter and SpoilerFieldStripFilter. Extracted (R4-H3 +
    // R4-M7) so the IPv6/IPv4-mapped-IPv6/raw-IPv6-with-port handling and
    // the shared-IP ambiguity-window fail-closed logic stays in ONE place
    // — preventing future regressions like the field-strip filter inheriting
    // an old string-compare implementation.
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
        // Returns null when ambiguity is detected (multiple users active from
        // the same IP within the SharedIpAmbiguityWindow) — fail-closed so
        // we don't apply user A's spoiler list to user B's request.
        public Guid? ResolveUserId(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            // Primary: ClaimsPrincipal from the request's auth header.
            var primary = UserHelper.GetCurrentUserId(httpContext.User);
            if (primary != null && primary.Value != Guid.Empty) return primary;

            // Fallback: session-by-IP. Cheap; bails on null IP.
            return ResolveFromActiveSession(httpContext);
        }

        // Loads (and caches per-request) the user's UserSpoilerBlur state.
        // Single key shared by both filters; the second filter to look up
        // a given user gets the cached instance for free.
        public UserSpoilerBlur LoadUserState(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            if (httpContext.Items.TryGetValue(ContextKeyUserState, out var cached)
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
                // R6-M1: GetUserConfiguration is the LENIENT path — it
                // already swallows IOException + JsonException + parse
                // failures internally and returns `new T()` (it logs at
                // Error level via the config manager's own _logger, so the
                // corruption fact is observable, just not under our
                // namespace). The earlier R5-M2 split into IOException /
                // JsonException / catch-all was dead code; only this
                // outer catch-all fires, for exceptions that escape the
                // lenient path (e.g. ResolveUserFile throwing on a bad
                // userId). Rate-limited so a flood of bad requests
                // doesn't spam logs. Strict-read with corruption-503 is
                // available on the dedicated /spoiler-blur/series
                // endpoint and via LoadSpoilerStateForTagStrip.
                WarnRateLimited(
                    "userstate-load:" + ex.GetType().FullName,
                    $"Spoiler resolver: failed to read user state for {userId} — passing through unblurred. {ex.Message}");
                state = new UserSpoilerBlur();
            }
            httpContext.Items[ContextKeyUserState] = state;
            return state;
        }

        private Guid? ResolveFromActiveSession(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return null;
            var remoteIp = NormalizeIp(remoteIpRaw);

            // R5-M3: per-session try/catch instead of one outer try around
            // the whole iteration. Previously a single misbehaving SessionInfo
            // (e.g. a corrupt RemoteEndPoint string) aborted iteration of
            // ALL sessions; one bad row hid every healthy match. Now a
            // per-session failure logs a rate-limited warn and continues.
            SessionInfo? best = null;
            Guid? bestUser = null;
            var recentlyActiveUsers = new HashSet<Guid>();
            var now = DateTime.UtcNow;

            // R6-H3: snapshot the live IEnumerable INSIDE the outer try.
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
                    $"Spoiler resolver: ISessionManager.Sessions enumeration threw: {ex.Message}");
                return null;
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
                        $"Spoiler resolver: skipped a session row during IP match: {ex.Message}");
                    continue;
                }
            }

            if (recentlyActiveUsers.Count > 1)
            {
                WarnRateLimited(
                    "shared-ip:" + remoteIp.ToString(),
                    $"Spoiler resolver: ambiguous session-by-IP match for {remoteIp} — {recentlyActiveUsers.Count} distinct users active within {SharedIpAmbiguityWindow.TotalSeconds}s. Failing closed (pass-through unblurred). To resolve, configure Jellyfin's KnownProxies if behind a reverse proxy so the request IP reflects the actual client.");
                return null;
            }

            return best?.UserId;
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
                $"Spoiler resolver: unrecognized SessionInfo.RemoteEndPoint format '{safe}' — session-by-IP fallback offline. Likely a Jellyfin format change.");
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
    }
}
