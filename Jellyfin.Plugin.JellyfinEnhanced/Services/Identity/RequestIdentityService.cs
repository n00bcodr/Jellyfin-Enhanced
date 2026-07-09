using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// How the requesting user was identified — ordered strongest to weakest.
    /// Consumers pick their posture from this: a feature that needs ONE
    /// certain user (field stripping) treats <see cref="SharedIpCandidates"/>
    /// with more than one candidate as "no identity"; a feature that can fail
    /// closed (image blur) protects if ANY candidate matches.
    /// </summary>
    public enum IdentityConfidence
    {
        /// <summary>Authenticated token on the request (ClaimsPrincipal). Authoritative.</summary>
        Authenticated,

        /// <summary>Per-user image-tag marker echoed in ?tag= (see SpoilerIdentityService). Strong; proxy-proof; works for native clients.</summary>
        Marker,

        /// <summary>Per-browser je-spoiler-uid cookie, validated against a session on the request IP. Strong for web.</summary>
        Cookie,

        /// <summary>The server has exactly one user account — every request that reaches user-scoped behavior can only be that user.</summary>
        SingleUserServer,

        /// <summary>Session-by-IP match only. One candidate when the IP is unshared; several behind a shared IP (reverse proxy/NAT) — ambiguous.</summary>
        SharedIpCandidates,

        /// <summary>No signal at all (no token, no marker, no cookie, no session on the IP).</summary>
        None,
    }

    /// <summary>The resolved identity: every plausible requesting user, plus how they were identified.</summary>
    public sealed record RequestIdentity(IReadOnlyList<Guid> Candidates, IdentityConfidence Confidence)
    {
        public static readonly RequestIdentity None = new(Array.Empty<Guid>(), IdentityConfidence.None);
    }

    // The plugin-wide "who is making this request?" ladder. Extracted from
    // SpoilerUserResolver so EVERY feature — current or future — resolves
    // request identity through one documented choke point
    // instead of reinventing per-feature identity. Order of tiers:
    //
    //   1. ClaimsPrincipal        — authenticated requests. Authoritative.
    //   2. ?tag= identity marker  — the per-user "-jeu{12hex}" suffix stamped
    //      into image tags by SpoilerIdentityTagFilter and echoed verbatim by
    //      every client (web AND native TV/mobile). No IP involvement, which
    //      is what keeps per-user behavior precise behind reverse proxies
    //      that hide the real client IP.
    //   2.5 Single-user server   — with exactly one account, ambiguity is
    //      structurally impossible; skip all IP work.
    //   3. je-spoiler-uid cookie  — web browsers attach it to anonymous
    //      same-origin image fetches; trusted only to disambiguate among
    //      users that actually have a session on the request IP.
    //   4. Session-by-IP          — every user with a session from the
    //      request IP; ambiguous (multiple candidates) behind shared IPs.
    //   5. None.
    //
    // Trust model (documented in research/spoiler-guard-identity-attempts.md):
    // markers and cookies are DISAMBIGUATION signals, not authentication —
    // consumers must never grant access based on them, only choose which
    // user's own preferences (e.g. spoiler policy) to apply. A forged value
    // can only opt the sender into another user's stricter/looser view of
    // content the sender could already reach anonymously.
    public sealed class RequestIdentityService
    {
        // Per-browser identity cookie the web client sets on load (see
        // js/enhanced/spoiler-blur.js). Browsers attach it to every
        // same-origin request INCLUDING anonymous <img>/CSS-background image
        // fetches, which carry no other user identity on Jellyfin 12 (the
        // image endpoint ignores legacy token params, and <img> tags can't
        // send an Authorization header). Trusted ONLY to disambiguate among
        // users that actually have an active session from the request IP, so
        // a forged value can't select a user who isn't even present.
        public const string SpoilerUidCookie = "je-spoiler-uid";

        private static readonly TimeSpan PerKeyWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _warnedAt = new();

        // Short-TTL cache of the per-IP session scan. A single page load fires
        // a burst of image requests from one IP; without this each one would
        // re-enumerate ISessionManager.Sessions (O(sessions) + an allocation),
        // which is exactly the per-image latency that shows up as the BlurHash
        // placeholder lingering — and it gets worse the more sessions exist
        // (e.g. a Seerr instance polling the server). Cache the scan result
        // for a couple of seconds so a burst pays for one scan, not dozens.
        private static readonly TimeSpan IpScanCacheTtl = TimeSpan.FromSeconds(2);
        private static readonly ConcurrentDictionary<string, IpScanCacheEntry> _ipScanCache = new();

        private sealed class IpScanCacheEntry
        {
            public required DateTime CachedAt { get; init; }
            public required IReadOnlyCollection<Guid> IpUsers { get; init; }
        }

        // F8: negative-cache for a je-spoiler-uid cookie that names a user
        // with NO session on the request IP. Without it, a stale/forged
        // cookie forces an uncached full session rescan on EVERY request (a
        // scan storm). Keyed by "{ipKey}|{cookieUidN}". TTL matches the
        // IP-scan cache TTL so a just-logged-in user whose cookie missed a
        // moment earlier is never suppressed for longer than the ordinary
        // scan staleness they'd face anyway.
        private static readonly TimeSpan CookieMissNegativeCacheTtl = TimeSpan.FromSeconds(2);
        private static readonly ConcurrentDictionary<string, DateTime> _cookieMissCache = new(StringComparer.Ordinal);

        // TTL-cached user count for the single-user shortcut so we don't
        // enumerate users per request (user enumeration is a DB query in JF12).
        // 60s staleness only matters around user creation/deletion, and the
        // UserTopologyEvents consumers invalidate on exactly those events —
        // the TTL is belt-and-braces. Published as ONE immutable snapshot
        // behind a volatile reference: Nullable<Guid> is a multi-word struct
        // whose lock-free reads could tear during a value transition (a
        // torn HasValue=true garbage id would flow into LoadUserState as a
        // nonexistent user with empty spoiler state → clean bytes), and a
        // volatile reference swap is atomic with correct ordering on weak
        // memory models (ARM) too.
        private static readonly TimeSpan UserCountCacheTtl = TimeSpan.FromSeconds(60);

        private sealed class SingleUserSnapshot
        {
            public required Guid? Value { get; init; }
            public required DateTime CheckedAt { get; init; }
        }

        private volatile SingleUserSnapshot? _singleUser;
        private readonly object _singleUserLock = new();

        private readonly ISessionManager _sessionManager;
        private readonly MediaBrowser.Controller.Library.IUserManager _userManager;
        private readonly SpoilerIdentityService _markers;
        private readonly Logger _logger;

        public RequestIdentityService(
            ISessionManager sessionManager,
            MediaBrowser.Controller.Library.IUserManager userManager,
            SpoilerIdentityService markers,
            Logger logger)
        {
            _sessionManager = sessionManager;
            _userManager = userManager;
            _markers = markers;
            _logger = logger;
        }

        /// <summary>
        /// Drops the cached single-user answer so the next request re-checks
        /// the user set. Called by the user-created/deleted event consumers
        /// (EventHandlers/UserTopologyEvents) — a stale "there is only user A"
        /// after user B was created would attribute B's anonymous requests to
        /// A, which is exactly the accidental misattribution the design
        /// forbids. The TTL remains as belt-and-braces only.
        /// </summary>
        public void InvalidateUserTopology()
        {
            _singleUser = null; // atomic volatile reference write
        }

        // The lone user's id when the server has exactly one account, else
        // null. Cached for UserCountCacheTtl.
        private Guid? TryGetSingleUserId()
        {
            var snapshot = _singleUser; // one volatile read; immutable after publish
            if (snapshot != null && (DateTime.UtcNow - snapshot.CheckedAt) < UserCountCacheTtl)
            {
                return snapshot.Value;
            }

            lock (_singleUserLock)
            {
                snapshot = _singleUser;
                if (snapshot != null && (DateTime.UtcNow - snapshot.CheckedAt) < UserCountCacheTtl)
                {
                    return snapshot.Value;
                }

                Guid? result;
                try
                {
                    Guid? only = null;
                    var count = 0;
                    foreach (var u in _userManager.GetAllUsers())
                    {
                        if (++count > 1) { only = null; break; }
                        only = u.Id;
                    }
                    result = count == 1 ? only : null;
                }
                catch (Exception ex)
                {
                    WarnRateLimited(
                        "single-user-count:" + ex.GetType().FullName,
                        $"JE request identity: user enumeration for the single-user shortcut threw: {ex.Message}");
                    result = null;
                }
                _singleUser = new SingleUserSnapshot { Value = result, CheckedAt = DateTime.UtcNow };
                return result;
            }
        }

        /// <summary>
        /// Resolves the FULL set of plausible requesting users plus the
        /// confidence tier that produced them. Never throws; the weakest
        /// outcome is <see cref="RequestIdentity.None"/>.
        /// </summary>
        public RequestIdentity Resolve(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            // Tier 1: authenticated request — authoritative.
            var primary = Helpers.UserHelper.GetCurrentUserId(httpContext.User);
            if (primary != null && primary.Value != Guid.Empty)
            {
                return new RequestIdentity(new[] { primary.Value }, IdentityConfidence.Authenticated);
            }

            // Tier 2: per-user identity marker embedded in the `?tag=` value
            // (see SpoilerIdentityService / SpoilerIdentityTagFilter). Present
            // whenever the client built this URL from an item DTO we stamped —
            // which every client does, native TV/mobile included, because
            // clients never invent image URLs; they echo the DTO's tag. No IP
            // involvement, so this stays per-user precise behind reverse
            // proxies that hide the real client IP. A marker naming no current
            // user (stale device cache after a user was deleted, forged value)
            // falls through to the ladder below. No session check on purpose:
            // the tag only reaches a client inside that user's authenticated
            // DTO response, and a forged marker merely lets a client
            // deliberately opt into another user's blur policy — Spoiler Guard
            // protects users from their OWN spoilers, so that "attack" only
            // self-spoils (anonymous IPs with no sessions get clean bytes
            // today anyway).
            var taggedValue = ExtractTagCandidate(httpContext);
            if (taggedValue != null
                && SpoilerIdentityService.TryParseMarker(taggedValue, out _, out var markerHex)
                && _markers.TryResolveMarker(markerHex, out var markerUid)
                && markerUid != Guid.Empty)
            {
                return new RequestIdentity(new[] { markerUid }, IdentityConfidence.Marker);
            }

            // Tier 2.5: single-user server shortcut. With exactly one user
            // account, ambiguity is structurally impossible — any request
            // that reaches user-scoped behavior can only be that user. This
            // also covers the case the IP ladder misses entirely: an
            // anonymous fetch from an IP with no recorded session (e.g. a TV
            // whose session row rotated) would otherwise get NO protection.
            // Skips the session scan altogether on single-user servers.
            var singleUser = TryGetSingleUserId();
            if (singleUser != null)
            {
                return new RequestIdentity(new[] { singleUser.Value }, IdentityConfidence.SingleUserServer);
            }

            // Anonymous request (browser <img>/CSS-background, or a native
            // TV/mobile image fetch) — resolve by session-on-IP (cached briefly).
            var ipUsers = ScanActiveSessionUsersCached(httpContext);

            // Tier 3: per-browser cookie disambiguation. The je-spoiler-uid
            // cookie pins THIS request to its browser's user — trusted ONLY
            // when that user genuinely has a session from this IP, so a
            // stale/forged value can't select a user who isn't present.
            if (httpContext.Request.Cookies.TryGetValue(SpoilerUidCookie, out var raw)
                && Guid.TryParse(raw, out var cookieUid)
                && cookieUid != Guid.Empty)
            {
                // A cookie naming a user absent from the (up-to-TTL-stale)
                // cached set may be a JUST-logged-in user the cache hasn't
                // seen yet — re-scan uncached once before rejecting, else a
                // fresh login leaks its own guarded images for up to the
                // cache TTL.
                //
                // F8: but a STALE/forged cookie naming an absent user would
                // trigger that uncached full session rescan on EVERY request
                // (a scan storm). Negative-cache the (ip, cookieUid) miss for
                // a short window so repeated requests with the same stale
                // cookie reuse the last scan instead of re-scanning.
                if (!ipUsers.Contains(cookieUid))
                {
                    var ipKey = TryGetNormalizedIpKey(httpContext);
                    var missKey = ipKey != null ? ipKey + "|" + cookieUid.ToString("N") : null;
                    var now = DateTime.UtcNow;
                    var recentMiss = missKey != null
                        && _cookieMissCache.TryGetValue(missKey, out var missAt)
                        && (now - missAt) < CookieMissNegativeCacheTtl;
                    if (!recentMiss)
                    {
                        ipUsers = ScanActiveSessionUsersFresh(httpContext);
                        if (missKey != null && !ipUsers.Contains(cookieUid))
                        {
                            _cookieMissCache[missKey] = now;
                            if (_cookieMissCache.Count > 512)
                            {
                                foreach (var kvp in _cookieMissCache)
                                {
                                    if ((now - kvp.Value) >= CookieMissNegativeCacheTtl)
                                        _cookieMissCache.TryRemove(kvp.Key, out _);
                                }
                            }
                        }
                    }
                }
                if (ipUsers.Contains(cookieUid))
                {
                    return new RequestIdentity(new[] { cookieUid }, IdentityConfidence.Cookie);
                }
            }

            // Tier 4: no usable marker/cookie (native TV/mobile client, or a
            // forged/stale value naming an absent user). Return every user
            // with a session on this IP so fail-closed consumers can protect
            // the item if ANY of them matches. (Using the full IP-session set
            // — not a recent-activity window — is deliberate; passive image
            // viewing doesn't refresh a session, so an opted-in user must not
            // age out of protection.)
            if (ipUsers.Count > 1)
            {
                WarnRateLimited(
                    "shared-ip-nocookie",
                    $"JE request identity: {ipUsers.Count} users have a session on one IP with no marker and no matching {SpoilerUidCookie} cookie (native client with a pre-update cached URL, or cookie names an absent user). Consumers disambiguate by their own scope. Configure Jellyfin KnownProxies so proxied requests carry the real client IP, or wait for clients to refresh their cached image URLs (identity markers).");
                return new RequestIdentity(ipUsers.ToArray(), IdentityConfidence.SharedIpCandidates);
            }
            return ipUsers.Count == 1
                ? new RequestIdentity(ipUsers.ToArray(), IdentityConfidence.SharedIpCandidates)
                : RequestIdentity.None;
        }

        // The stamped tag can reach the server on THREE carriers; check all:
        //   • ?tag= query param — the standard form every client uses.
        //   • the {tag} PATH segment of Jellyfin's alternate image route
        //     (Items/{id}/Images/{type}/{index}/{tag}/{format}/…).
        //   • If-None-Match — the image endpoint echoes the supplied tag as
        //     the ETag verbatim, so a caching client's revalidation carries
        //     the SAME marker back in the conditional header even if the
        //     query string was dropped along the way. Same token, identical
        //     trust — zero added misattribution surface.
        private static string? ExtractTagCandidate(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            if (httpContext.Request.Query.TryGetValue("tag", out var tagValues))
            {
                var q = tagValues.ToString();
                if (!string.IsNullOrEmpty(q)) return q;
            }

            if (httpContext.Request.RouteValues.TryGetValue("tag", out var routeTag)
                && routeTag is string routeStr
                && !string.IsNullOrEmpty(routeStr))
            {
                return routeStr;
            }

            var inm = httpContext.Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(inm))
            {
                // Shape: optional W/ prefix, quoted value, possibly a list —
                // take the first entry and strip weak prefix + quotes.
                var first = inm.Split(',')[0].Trim();
                if (first.StartsWith("W/", StringComparison.Ordinal)) first = first.Substring(2);
                first = first.Trim('"');
                if (!string.IsNullOrEmpty(first)) return first;
            }

            return null;
        }

        // Cached wrapper over the session scan. Keyed by normalized request
        // IP; entries live for IpScanCacheTtl so a page-load burst of image
        // requests scans ISessionManager.Sessions once instead of per image.
        private IReadOnlyCollection<Guid> ScanActiveSessionUsersCached(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            var ipKey = NormalizeIp(remoteIpRaw).ToString();

            if (_ipScanCache.TryGetValue(ipKey, out var hit) && (DateTime.UtcNow - hit.CachedAt) < IpScanCacheTtl)
            {
                return hit.IpUsers;
            }
            return ScanAndCache(ipKey, httpContext);
        }

        // Forces a fresh (uncached) scan and refreshes the cache. Used when a
        // je-spoiler-uid cookie names a user absent from the cached set: the
        // cache can be up to IpScanCacheTtl stale, so a just-logged-in user's
        // brand-new session may not be in it yet. Re-scanning before rejecting
        // the cookie closes the window where a fresh login would otherwise
        // leak its guarded images for up to the TTL.
        private IReadOnlyCollection<Guid> ScanActiveSessionUsersFresh(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            return ScanAndCache(NormalizeIp(remoteIpRaw).ToString(), httpContext);
        }

        private IReadOnlyCollection<Guid> ScanAndCache(string ipKey, Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var now = DateTime.UtcNow;
            var ipUsers = ScanActiveSessionUsers(httpContext);
            _ipScanCache[ipKey] = new IpScanCacheEntry { CachedAt = now, IpUsers = ipUsers };

            // Opportunistic prune so the cache can't grow unbounded across
            // many distinct client IPs over a long uptime.
            if (_ipScanCache.Count > 512)
            {
                foreach (var kvp in _ipScanCache)
                {
                    if ((now - kvp.Value.CachedAt) >= IpScanCacheTtl) _ipScanCache.TryRemove(kvp.Key, out _);
                }
            }
            return ipUsers;
        }

        // Session-by-IP scan. Returns the set of DISTINCT users that have a
        // session from the request IP, regardless of how recently active. We
        // deliberately do NOT filter by a recent-activity window: passively
        // viewing images (lazy-loaded <img>/CSS-background posters) does not
        // refresh a session's LastActivityDate, so a quietly-scrolling
        // opted-in user would age out of any activity window while still
        // firing anonymous image requests — and drop out of fail-closed
        // protection, leaking their own guarded artwork. Empty ⇒ no matching
        // session (nothing to protect).
        private IReadOnlyCollection<Guid> ScanActiveSessionUsers(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return Array.Empty<Guid>();
            var remoteIp = NormalizeIp(remoteIpRaw);

            var ipUsers = new HashSet<Guid>();

            // Snapshot the live IEnumerable. ISessionManager.Sessions can
            // return a live view; foreach's MoveNext can throw
            // InvalidOperationException ("Collection was modified"). ToArray()
            // forces materialization here so the enumerator hazard is contained.
            SessionInfo[] sessions;
            try
            {
                sessions = _sessionManager.Sessions.ToArray();
            }
            catch (Exception ex)
            {
                WarnRateLimited(
                    "session-list:" + ex.GetType().FullName,
                    $"JE request identity: ISessionManager.Sessions enumeration threw: {ex.Message}");
                return Array.Empty<Guid>();
            }

            // Per-session try/catch (not one outer try) so a single
            // misbehaving SessionInfo (e.g. a corrupt RemoteEndPoint) can't
            // abort iteration of ALL sessions — one bad row must not hide
            // every healthy match.
            foreach (var s in sessions)
            {
                try
                {
                    if (s.UserId == Guid.Empty) continue;
                    if (!RemoteEndpointIpEquals(s.RemoteEndPoint, remoteIp)) continue;
                    ipUsers.Add(s.UserId);
                }
                catch (Exception ex)
                {
                    WarnRateLimited(
                        "session-iter:" + ex.GetType().FullName,
                        $"JE request identity: skipped a session row during IP match: {ex.Message}");
                    continue;
                }
            }

            return ipUsers;
        }

        // Normalized request-IP key (or null when the remote IP is
        // unavailable), used for the F8 cookie-miss negative cache. Same
        // normalization the per-IP session-scan cache uses so keys line up.
        private static string? TryGetNormalizedIpKey(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var raw = httpContext.Connection.RemoteIpAddress;
            return raw == null ? null : NormalizeIp(raw).ToString();
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
                $"JE request identity: unrecognized SessionInfo.RemoteEndPoint format '{safe}' — session-by-IP fallback offline. Likely a Jellyfin format change.");
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

        private void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = _warnedAt.AddOrUpdate(key, now,
                (_, last) => (now - last) >= PerKeyWarnInterval ? now : last);
            if (stored != now) return;
            _logger.Warning(message);
        }
    }
}
