using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Replaces image bytes with a downsample-then-upsample blurred version when:
    //   1. Admin has enabled spoiler blur server-wide.
    //   2. The image is for an episode of a series.
    //   3. The requesting user has opted-in to spoiler mode for that series.
    //   4. The user has NOT marked the episode as played.
    //
    // Runs as an MVC action filter scoped to Jellyfin's image controller actions
    // so EVERY client (web, TV, iOS, Android) receives blurred bytes from the
    // native image API. No client-side awareness or DOM manipulation needed.
    public sealed class SpoilerBlurImageFilter : IAsyncActionFilter
    {
        private const string ImageController = "Image";
        public const string SpoilerBlurFileName = "spoilerblur.json";

        // Image controller actions we care about. Jellyfin 10.11.x decorates
        // the same C# methods with both [HttpGet] and [HttpHead(Name="HeadItemImage")];
        // Name= only affects link generation, so RouteValues["action"] for a HEAD
        // request still resolves to the GET method name. We therefore only need
        // the GetItem* names. (L2)
        private static readonly HashSet<string> _imageActions = new(StringComparer.OrdinalIgnoreCase)
        {
            "GetItemImage",
            "GetItemImageByIndex",
            "GetItemImage2",
        };

        // Only blur image types that show episode content. Logos/banners are
        // series-level or content-free; blurring them would just confuse users
        // without protecting against spoilers.
        private static readonly HashSet<string> _blurrableImageTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "Primary",
            "Thumb",
            "Backdrop",
            "Art",
            "Screenshot",
        };

        // Re-warn at most once per hour per surface so a real Jellyfin upgrade
        // changing the response shape isn't permanently invisible.
        private static readonly TimeSpan ShapeWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _warnedShapeAt = new();

        // R2-M4 / R2-M5: per-key rate-limited warning state for
        // LoadUserState IO failures and session-manager exceptions. Without
        // this, an FS hiccup or transient session-manager error would log a
        // warning on every image request — a TV grid produces hundreds of
        // identical lines per second.
        private static readonly TimeSpan PerKeyWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _warnedAt = new();

        private void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = _warnedAt.AddOrUpdate(key, now,
                (_, last) => (now - last) >= PerKeyWarnInterval ? now : last);
            if (stored != now) return;
            _logger.Warning(message);
        }

        // Cache the loaded user spoiler-blur state per HTTP request so a single
        // image-grid request that resolves dozens of episode images doesn't
        // re-read the JSON file dozens of times.
        private const string ContextKeyUserState = "__JE_SpoilerBlur_UserState";

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ISessionManager _sessionManager;
        private readonly UserConfigurationManager _userConfigManager;
        private readonly ImageBlurService _blurService;
        private readonly Logger _logger;

        public SpoilerBlurImageFilter(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ISessionManager sessionManager,
            UserConfigurationManager userConfigManager,
            ImageBlurService blurService,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _sessionManager = sessionManager;
            _userConfigManager = userConfigManager;
            _blurService = blurService;
            _logger = logger;
        }

        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // L5: sync fast-path. The filter runs on every MVC action; for non-
            // image routes we want to add zero overhead by returning the
            // existing Task directly without entering an async state machine.
            if (!IsImageAction(context))
            {
                return next();
            }

            // Plugin-level master switch. Saves the per-user file read on every image.
            var pluginConfig = JellyfinEnhanced.Instance?.Configuration;
            if (pluginConfig?.SpoilerBlurEnabled != true)
            {
                return next();
            }
            return RunImageFilterAsync(context, next, pluginConfig);
        }

        private async Task RunImageFilterAsync(
            ActionExecutingContext context,
            ActionExecutionDelegate next,
            Configuration.PluginConfiguration pluginConfig)
        {

            if (!TryGetItemId(context, out var itemId)
                || !TryGetImageType(context, out var imageType)
                || !_blurrableImageTypes.Contains(imageType))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User);
            if (userId == null || userId == Guid.Empty)
            {
                // Anonymous image request — common from native clients and the
                // browser <img> loader because Jellyfin's image endpoint is
                // public-accessible by design. Fall back to identifying the
                // user via active sessions: native clients open a session at
                // login time which records (UserId, RemoteEndPoint), and
                // image fetches typically come from the same IP within
                // milliseconds. We pick the most recently-active session
                // matching the request IP.
                userId = ResolveUserFromActiveSession(context.HttpContext);
                if (userId == null || userId == Guid.Empty)
                {
                    await next().ConfigureAwait(false);
                    return;
                }
            }

            var userState = LoadUserState(context.HttpContext, userId.Value);
            if (userState.Series.Count == 0)
            {
                // User hasn't enabled spoiler mode for any show — pass through.
                await next().ConfigureAwait(false);
                return;
            }

            // Read the item from Jellyfin's library. Cheap in-memory lookup.
            var item = _libraryManager.GetItemById(itemId);
            if (item is not Episode episode)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var seriesId = episode.SeriesId;
            if (seriesId == Guid.Empty
                || !userState.Series.ContainsKey(seriesId.ToString("N")))
            {
                // Episode's series isn't on the user's spoiler-blur list.
                await next().ConfigureAwait(false);
                return;
            }

            // Already-watched episodes pass through. We use IUserDataManager
            // here rather than IsPlayed(user) directly — IsPlayed dispatches
            // on item type for series/season aggregation, but for a leaf
            // Episode it's equivalent to UserData.Played. Reading user data
            // straight is cheaper and skips Jellyfin's unrelated null guards.
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null)
            {
                await next().ConfigureAwait(false);
                return;
            }
            var userData = _userDataManager.GetUserData(jUser, episode);
            if (userData?.Played == true)
            {
                // M3: pass-through, but force `no-store` so a watched episode's
                // image isn't cached permanently in the user's browser. If the
                // user later marks the episode unwatched again, the next fetch
                // must re-evaluate through this filter.
                //
                // R2-H2: register on Response.OnStarting BEFORE awaiting
                // next(). For streaming FileStreamResult paths the response
                // headers can be flushed inside next()'s execution, so a
                // post-next() header write would be a no-op.
                RegisterNoStoreOnStarting(context.HttpContext);
                await next().ConfigureAwait(false);
                return;
            }

            // Stash the cache key so the post-action code doesn't recompute.
            var cacheKey = BuildCacheKey(episode, imageType, context, pluginConfig.SpoilerBlurIntensity);

            var executed = await next().ConfigureAwait(false);
            if (executed.Canceled || executed.Exception != null) return;

            try
            {
                await ReplaceWithBlurredAsync(executed, pluginConfig.SpoilerBlurIntensity, cacheKey).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // Never let blur failure break the response — pass through originals.
                _logger.Error($"Spoiler blur post-processing failed for episode {itemId} ({imageType}): {ex.Message}");
            }
        }

        // M3 / R2-H1: when an item that SHOULD be considered for blur (user
        // has the series enabled) takes a pass-through code path — watched,
        // blur failed, item not yet resolvable, etc. — strip 1-year public
        // caching. Uses the SAME header set as the blurred-response path
        // (`private, no-store, max-age=0, must-revalidate` + drop ETag /
        // Last-Modified) because `private, no-cache` still permits 304
        // revalidation and reuse of the cached unblurred bytes — defeating
        // the whole point of the pass-through scrub.
        //
        // For paths where the response has already begun streaming (the
        // watched-pass-through case after `next()`), we register on
        // `Response.OnStarting` so the override runs JUST BEFORE headers
        // flush. R2-H2.
        private void ApplyNoStoreToResponse(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            try
            {
                if (httpContext.Response.HasStarted)
                {
                    // Response already flushed — too late to mutate headers.
                    // R3-silent-failure-H1: surface so operators can diagnose
                    // when M3 cache-scrub silently fails for streaming results.
                    // Rate-limited so a misbehaving response shape doesn't
                    // spam logs on every image fetch.
                    WarnRateLimited(
                        "no-store-already-started",
                        "Spoiler blur: ApplyNoStoreToResponse called after Response.HasStarted=true; cache headers NOT applied. M3 cache-scrub may not have taken effect for this code path. (For watched-pass-through, use RegisterNoStoreOnStarting BEFORE awaiting next() instead.)");
                    return;
                }
                ApplyNoStoreHeadersDirect(httpContext);
            }
            catch (Exception ex)
            {
                // R2-H6: don't silently swallow; surface so operators can
                // diagnose when M3 isn't actually being applied.
                _logger.Warning($"ApplyNoStoreToResponse failed: {ex.Message}");
            }
        }

        // Registers an OnStarting callback that overrides the cache headers
        // immediately before MVC writes them. Use this for pass-through
        // paths that occur AFTER awaiting `next()` for streaming results
        // where the response may already be on its way out.
        private void RegisterNoStoreOnStarting(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            try
            {
                if (httpContext.Response.HasStarted)
                {
                    return;
                }
                httpContext.Response.OnStarting(() =>
                {
                    try { ApplyNoStoreHeadersDirect(httpContext); }
                    catch (Exception ex) { _logger.Warning($"OnStarting no-store override failed: {ex.Message}"); }
                    return Task.CompletedTask;
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"RegisterNoStoreOnStarting failed: {ex.Message}");
            }
        }

        private static void ApplyNoStoreHeadersDirect(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var headers = httpContext.Response.Headers;
            headers["Cache-Control"] = "private, no-store, max-age=0, must-revalidate";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
        }

        // Maps anonymous image requests back to a user by looking up the
        // most-recently-active Jellyfin session whose RemoteEndPoint IP
        // matches the request's RemoteIpAddress. Returns null when no
        // session matches OR when multiple distinct users were recently
        // active from the same IP (R2-H5: fail closed in shared-IP setups
        // rather than apply the wrong user's spoiler list).
        //
        // R2-H4: IP comparison via IPAddress.Equals after IPv4-mapped-IPv6
        // normalization, NOT string match — `[::1]:54321` vs `::1` and
        // `::ffff:192.0.2.1` vs `192.0.2.1` would otherwise miss.
        //
        // R3-H1 / R3-M1: ambiguity window reduced from 60s to 5s. The longer
        // window opened a denial-of-blur attack: any user with a valid
        // account whose client polls heartbeats (Swiftfin, etc.) on the
        // shared IP would perpetually trip ambiguity for everyone else,
        // forcing pass-through unblurred for the victim. 5s is wide enough
        // to catch the "two users login, image grid loads simultaneously"
        // race but narrow enough that a background heartbeat doesn't keep
        // it open.
        private static readonly TimeSpan SharedIpAmbiguityWindow = TimeSpan.FromSeconds(5);

        private Guid? ResolveUserFromActiveSession(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var remoteIpRaw = httpContext.Connection.RemoteIpAddress;
            if (remoteIpRaw == null) return null;
            var remoteIp = NormalizeIp(remoteIpRaw);

            try
            {
                // R3-M1 fix: collect ALL distinct UserIds with sessions whose
                // LastActivityDate is within the ambiguity window. Previous
                // pairwise comparison missed 3+ user scenarios and was
                // sensitive to enumeration order.
                SessionInfo? best = null;
                Guid? bestUser = null;
                var recentlyActiveUsers = new HashSet<Guid>();
                var now = DateTime.UtcNow;

                foreach (var s in _sessionManager.Sessions)
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

                if (recentlyActiveUsers.Count > 1)
                {
                    // Multiple users recently active from the same IP — pick
                    // none. Caller will pass through unblurred. Log via
                    // rate-limited Info so operators can diagnose
                    // "why isn't blur firing on our family TV setup".
                    WarnRateLimited(
                        "shared-ip:" + remoteIp.ToString(),
                        $"Spoiler blur: ambiguous session-by-IP match for {remoteIp} — {recentlyActiveUsers.Count} distinct users active within {SharedIpAmbiguityWindow.TotalSeconds}s. Failing closed (pass-through unblurred). To resolve, configure Jellyfin's KnownProxies if behind a reverse proxy so the request IP reflects the actual client.");
                    return null;
                }

                return best?.UserId;
            }
            catch (Exception ex)
            {
                // R2-M5: rate-limit by exception type — a malfunctioning
                // session manager could otherwise spam the log on every
                // anonymous image request.
                WarnRateLimited(
                    "session-lookup:" + ex.GetType().FullName,
                    $"Spoiler blur: session-by-IP lookup failed for {remoteIp}: {ex.Message}");
                return null;
            }
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
            // R3-M3: rate-limited surface so a future Jellyfin format change
            // is observable. Truncate the captured endpoint so a malicious
            // session-name injection can't blow up the log.
            var safe = endpoint.Length > 80 ? endpoint.Substring(0, 80) + "…" : endpoint;
            WarnRateLimited(
                "endpoint-parse",
                $"Spoiler blur: unrecognized SessionInfo.RemoteEndPoint format '{safe}' — session-by-IP fallback offline. Likely a Jellyfin format change.");
        }

        private bool RemoteEndpointIpEquals(string? endpoint, System.Net.IPAddress remoteIp)
        {
            if (string.IsNullOrEmpty(endpoint)) return false;

            // Try parsing as full IPEndPoint first (handles bracketed v6 +
            // ip:port). Fall back to raw IPAddress (no port).
            if (System.Net.IPEndPoint.TryParse(endpoint, out var parsed))
            {
                return NormalizeIp(parsed.Address).Equals(remoteIp);
            }
            if (System.Net.IPAddress.TryParse(endpoint, out var bare))
            {
                return NormalizeIp(bare).Equals(remoteIp);
            }

            // R3-codex-P1: `::1:1234` (raw IPv6 + port without brackets)
            // parses as a *full* IPv6 address (`::0.1.18.52`), NOT as an
            // endpoint. We have to detect this case and re-parse with the
            // last `:port` segment stripped. Same for things like
            // `::ffff:127.0.0.1:1234` which IPEndPoint.TryParse rejects
            // entirely without brackets.
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

            // Endpoint string is non-empty but didn't parse — log so a
            // future Jellyfin format change becomes visible.
            RemoteEndpointParseFailedWarn(endpoint);
            return false;
        }

        private static bool IsImageAction(ActionExecutingContext context)
        {
            var rv = context.ActionDescriptor.RouteValues;
            if (rv == null) return false;
            if (!rv.TryGetValue("controller", out var controller) || controller == null) return false;
            if (!string.Equals(controller, ImageController, StringComparison.OrdinalIgnoreCase)) return false;
            if (!rv.TryGetValue("action", out var action) || action == null) return false;
            return _imageActions.Contains(action);
        }

        private static bool TryGetItemId(ActionExecutingContext context, out Guid itemId)
        {
            itemId = Guid.Empty;
            if (!context.ActionArguments.TryGetValue("itemId", out var raw)) return false;
            switch (raw)
            {
                case Guid g when g != Guid.Empty:
                    itemId = g;
                    return true;
                case string s when Guid.TryParse(s, out var parsed) && parsed != Guid.Empty:
                    itemId = parsed;
                    return true;
                default:
                    return false;
            }
        }

        private static bool TryGetImageType(ActionExecutingContext context, out string imageType)
        {
            imageType = string.Empty;
            if (!context.ActionArguments.TryGetValue("imageType", out var raw) || raw == null) return false;
            // Jellyfin's ImageType is an enum; ToString() yields the member name (Primary, Thumb, etc.).
            imageType = raw.ToString() ?? string.Empty;
            return imageType.Length > 0;
        }

        private UserSpoilerBlur LoadUserState(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            if (httpContext.Items.TryGetValue(ContextKeyUserState, out var cached) && cached is UserSpoilerBlur hit)
                return hit;

            UserSpoilerBlur state;
            try
            {
                state = _userConfigManager.GetUserConfiguration<UserSpoilerBlur>(
                    userId.ToString("N"),
                    SpoilerBlurFileName);
            }
            catch (Exception ex)
            {
                // R2-M4: rate-limit per user — image-grid loads can produce
                // dozens of identical warnings if the file is genuinely
                // unreadable. Hourly resurfacing keeps the operator informed.
                WarnRateLimited(
                    "userstate-load:" + userId.ToString("N"),
                    $"Spoiler blur: failed to read user state for {userId} — passing through unblurred. {ex.Message}");
                state = new UserSpoilerBlur();
            }

            httpContext.Items[ContextKeyUserState] = state;
            return state;
        }

        // Query params Jellyfin's image controller uses to shape the output
        // (resize / re-encode). M1: two clients requesting the same episode
        // at different sizes must NOT share the same cached blurred bytes —
        // a TV asking for 720p must not receive a 300px-encoded thumb cached
        // for the web client.
        private static readonly string[] _sizeShapingParams =
        {
            "maxWidth", "maxHeight", "fillWidth", "fillHeight",
            "width", "height", "quality", "format",
        };

        private static string BuildCacheKey(Episode episode, string imageType, ActionExecutingContext context, int sigma)
        {
            string? tag = null;
            string? index = null;
            var query = context.HttpContext.Request.Query;
            if (query.TryGetValue("tag", out var t)) tag = t.ToString();
            if (context.ActionArguments.TryGetValue("imageIndex", out var idx) && idx != null)
                index = idx.ToString();

            // M1 / R2-H3: include the size-shaping query params so different
            // output sizes get distinct cache entries. Use the FULL param
            // name in the key — using just the first letter caused
            // maxWidth=300 and maxHeight=300 to collide on `m300;`.
            var sizeKey = new System.Text.StringBuilder();
            foreach (var p in _sizeShapingParams)
            {
                if (query.TryGetValue(p, out var v))
                {
                    sizeKey.Append(p).Append('=').Append(v.ToString()).Append(';');
                }
            }

            return $"{episode.Id:N}|{imageType}|{index ?? "_"}|{tag ?? "_"}|{sigma}|{sizeKey}";
        }

        private async Task ReplaceWithBlurredAsync(ActionExecutedContext executed, int sigma, string cacheKey)
        {
            if (executed.Result == null) return;

            // HEAD requests carry no body — pass through.
            if (string.Equals(executed.HttpContext.Request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            {
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            var (originalBytes, originalContentType) = await ExtractBytesAsync(executed.Result).ConfigureAwait(false);
            if (originalBytes == null || originalBytes.Length == 0)
            {
                MaybeWarnShapeMismatch(executed.Result);
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            var blurred = _blurService.Blur(originalBytes, sigma, cacheKey);
            if (blurred == null)
            {
                // H3: blur failed but we already consumed the original
                // FileStreamResult's stream during ExtractBytesAsync. Replace
                // the result with the original bytes we captured so MVC writes
                // a complete body, not an empty one. Force `no-store` so the
                // browser doesn't permanently cache this transient failure.
                executed.Result = new FileContentResult(originalBytes, originalContentType ?? "image/jpeg");
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            // We always re-encode as JPEG (the blur service does), so set the
            // content type explicitly. Cache-Control: private, no-store keeps
            // clients from holding the blurred copy after the user marks the
            // episode watched or disables spoiler mode for the series.
            executed.Result = new FileContentResult(blurred, "image/jpeg");

            if (executed.HttpContext.Response.HasStarted) return;
            var headers = executed.HttpContext.Response.Headers;
            headers["Cache-Control"] = "private, no-store, max-age=0, must-revalidate";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
        }

        private static async Task<(byte[]? Bytes, string? ContentType)> ExtractBytesAsync(IActionResult result)
        {
            switch (result)
            {
                case FileContentResult fcr:
                    return (fcr.FileContents, fcr.ContentType);

                case FileStreamResult fsr:
                    if (fsr.FileStream == null) return (null, fsr.ContentType);
                    using (var ms = new MemoryStream())
                    {
                        await fsr.FileStream.CopyToAsync(ms).ConfigureAwait(false);
                        return (ms.ToArray(), fsr.ContentType);
                    }

                case PhysicalFileResult pfr:
                    if (string.IsNullOrEmpty(pfr.FileName) || !File.Exists(pfr.FileName))
                        return (null, pfr.ContentType);
                    return (await File.ReadAllBytesAsync(pfr.FileName).ConfigureAwait(false), pfr.ContentType);

                case VirtualFileResult vfr:
                    if (string.IsNullOrEmpty(vfr.FileName)) return (null, vfr.ContentType);
                    var fp = vfr.FileName;
                    return File.Exists(fp)
                        ? (await File.ReadAllBytesAsync(fp).ConfigureAwait(false), vfr.ContentType)
                        : (null, vfr.ContentType);

                default:
                    return (null, null);
            }
        }

        private void MaybeWarnShapeMismatch(IActionResult result)
        {
            var key = result?.GetType().FullName ?? "(null)";
            var now = DateTime.UtcNow;
            var stored = _warnedShapeAt.AddOrUpdate(
                key,
                now,
                (_, last) => (now - last) >= ShapeWarnInterval ? now : last);
            if (stored != now) return;
            _logger.Warning($"Spoiler blur: image action produced an unrecognized result type ({key}); blur is no-op for this shape. Re-warns hourly. Likely a Jellyfin upgrade changed the image controller's return type.");
        }
    }
}
