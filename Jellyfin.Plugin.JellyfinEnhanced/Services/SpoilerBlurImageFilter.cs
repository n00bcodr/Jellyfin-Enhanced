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
        // Rate-limited warning helper now lives on SpoilerUserResolver.

        // Per-request user-state caching is now delegated to SpoilerUserResolver
        // (single shared HttpContext.Items key across both filters).

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly SpoilerUserResolver _resolver;
        private readonly ImageBlurService _blurService;
        private readonly Logger _logger;

        public SpoilerBlurImageFilter(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            SpoilerUserResolver resolver,
            ImageBlurService blurService,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _resolver = resolver;
            _blurService = blurService;
            _logger = logger;

            // R4-H7: when a user marks an episode (or season/series) played
            // or unplayed, evict the per-(user, season) "any episode
            // watched?" cache for that season so the next image fetch
            // reflects the new state immediately. Without this, the 30-second
            // TTL produces a stale-blur window in the wrong direction —
            // marking an episode UN-played returns the cached "any-watched=
            // true" entry and renders the season poster CLEAR for up to 30s,
            // a privacy regression.
            _userDataManager.UserDataSaved += OnUserDataSaved;
        }

        private void OnUserDataSaved(object? sender, MediaBrowser.Controller.Library.UserDataSaveEventArgs e)
        {
            try
            {
                if (e?.Item == null || e.UserId == Guid.Empty) return;

                Guid? seasonId = null;
                Guid? seriesId = null;
                switch (e.Item)
                {
                    case Episode ep:
                        seasonId = ep.SeasonId;
                        seriesId = ep.SeriesId;
                        break;
                    case Season s:
                        seasonId = s.Id;
                        seriesId = s.SeriesId;
                        break;
                    case Series ser:
                        seriesId = ser.Id;
                        break;
                }

                if (seasonId.HasValue && seasonId.Value != Guid.Empty)
                {
                    var key = e.UserId.ToString("N") + ":" + seasonId.Value.ToString("N");
                    _watchedCache.TryRemove(key, out _);
                }
                else if (seriesId.HasValue && seriesId.Value != Guid.Empty)
                {
                    // Series-level event — invalidate every cached season
                    // for this user under this series. Cache keys are
                    // "{userN}:{seasonN}" so we'd have to iterate. Cheap
                    // because the cache is small (≤512 entries) and this
                    // event is rare.
                    var prefix = e.UserId.ToString("N") + ":";
                    foreach (var k in _watchedCache.Keys)
                    {
                        if (k.StartsWith(prefix, StringComparison.Ordinal))
                            _watchedCache.TryRemove(k, out _);
                    }
                }
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "userdata-saved-handler:" + ex.GetType().FullName,
                    $"Spoiler blur: failed to invalidate season cache on UserDataSaved: {ex.Message}");
            }
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

            // User identification — handles ClaimsPrincipal first, then falls
            // back to session-by-IP for anonymous browser <img> requests and
            // native-client image fetches. Fail-closed on shared-IP ambiguity.
            // Lives in SpoilerUserResolver so the field-strip filter shares
            // exactly the same logic.
            var userId = _resolver.ResolveUserId(context.HttpContext);
            if (userId == null || userId == Guid.Empty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var userState = _resolver.LoadUserState(context.HttpContext, userId.Value);
            if (userState.Series.Count == 0)
            {
                // User hasn't enabled spoiler mode for any show — pass through.
                await next().ConfigureAwait(false);
                return;
            }

            // Read the item from Jellyfin's library. Cheap in-memory lookup.
            var item = _libraryManager.GetItemById(itemId);
            if (item == null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            // Resolve the parent series ID for both Episode and Season items.
            // Other item types pass through unchanged.
            Guid seriesId;
            switch (item)
            {
                case Episode ep:
                    seriesId = ep.SeriesId;
                    break;
                case Season seasonItem:
                    seriesId = seasonItem.SeriesId;
                    break;
                default:
                    await next().ConfigureAwait(false);
                    return;
            }

            if (seriesId == Guid.Empty
                || !userState.Series.ContainsKey(seriesId.ToString("N")))
            {
                // Item's series isn't on the user's spoiler-blur list.
                await next().ConfigureAwait(false);
                return;
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            // Episode path: blur if not played; pass-through with no-store if played.
            if (item is Episode episode)
            {
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
                // Else fall through to blur path below.
            }
            else
            {
                // Season path: blur if S2+ and the user has watched zero
                // episodes from this season; pass-through otherwise.
                var season = (Season)item;
                var seasonNum = season.IndexNumber.GetValueOrDefault(int.MaxValue);
                // Always show Season 1 (and Specials S0) so the user has some
                // entry point. Future seasons get blurred until at least one
                // episode is watched.
                if (seasonNum <= 1)
                {
                    await next().ConfigureAwait(false);
                    return;
                }
                if (HasWatchedAnyEpisodeInSeason(jUser, season))
                {
                    // User started this season — pass-through.
                    RegisterNoStoreOnStarting(context.HttpContext);
                    await next().ConfigureAwait(false);
                    return;
                }
                // Else fall through to blur path below.
            }

            // Stash the cache key so the post-action code doesn't recompute.
            var cacheKey = BuildItemCacheKey(item, imageType, context, pluginConfig.SpoilerBlurIntensity);

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
                    _resolver.WarnRateLimited(
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

        private static string BuildItemCacheKey(BaseItem item, string imageType, ActionExecutingContext context, int sigma)
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

            return $"{item.Id:N}|{imageType}|{index ?? "_"}|{tag ?? "_"}|{sigma}|{sizeKey}";
        }

        // Per-(user, season) "any episode watched?" cache. Home-page rows can
        // request the same season's Primary + Backdrop + Thumb in quick
        // succession; without caching we'd hit the library DB three times for
        // the same answer. The cache TTL is short because a user marking an
        // episode watched should flip the season's poster from blurred to
        // clear on next page load — too long a TTL means stale state. 30s is
        // long enough to cover a full home-page render but short enough that
        // mark-watched → next-navigation roundtrips see fresh data.
        private static readonly TimeSpan SeasonWatchedCacheTtl = TimeSpan.FromSeconds(30);

        private sealed class WatchedCacheEntry
        {
            public required bool AnyWatched { get; init; }
            public required DateTime ExpiresAt { get; init; }
        }

        private static readonly ConcurrentDictionary<string, WatchedCacheEntry> _watchedCache = new();

        private bool HasWatchedAnyEpisodeInSeason(JUser user, Season season)
        {
            var key = user.Id.ToString("N") + ":" + season.Id.ToString("N");
            var now = DateTime.UtcNow;
            if (_watchedCache.TryGetValue(key, out var hit) && hit.ExpiresAt > now)
            {
                return hit.AnyWatched;
            }

            bool anyWatched = false;
            // Diagnostic counters — kept (commented logger) for future
            // troubleshooting if the season-watched cache produces
            // unexpected blur/passthrough decisions. Uncomment the
            // _logger.Info line below to surface per-call results.
            int total = 0, withUd = 0;
            try
            {
                // Enumerate the season's episodes; bail as soon as we find a
                // played one. `shouldIncludeMissingEpisodes: false` skips
                // episodes Jellyfin has metadata for but no media file —
                // those obviously can't have been "played" so they'd just
                // waste iterations.
                foreach (var child in season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false))
                {
                    total++;
                    if (child is not Episode ep) continue;
                    var ud = _userDataManager.GetUserData(user, ep);
                    if (ud != null) withUd++;
                    if (ud?.Played == true)
                    {
                        anyWatched = true;
                        break;
                    }
                }
                // _logger.Info($"[seasondiag] season={season.Id} {season.Name} total={total} withUd={withUd} anyWatched={anyWatched}");
            }
            catch (Exception ex)
            {
                // On error, fail SAFE (assume watched → no blur). Spoiler-
                // mode is opt-in for entertainment, not security; a transient
                // DB glitch shouldn't surface a wrong-state blur. Pass-through
                // is the conservative default.
                _resolver.WarnRateLimited(
                    "season-watched:" + ex.GetType().FullName,
                    $"Spoiler blur: HasWatchedAnyEpisodeInSeason failed for season {season.Id} — passing through unblurred. {ex.Message}");
                anyWatched = true;
            }

            _watchedCache[key] = new WatchedCacheEntry
            {
                AnyWatched = anyWatched,
                ExpiresAt = now + SeasonWatchedCacheTtl,
            };

            // Periodic eviction so the dictionary doesn't grow unbounded
            // across long server uptimes. Cheap O(N) scan when the cache
            // grows beyond a small threshold.
            if (_watchedCache.Count > 512)
            {
                foreach (var kvp in _watchedCache)
                {
                    if (kvp.Value.ExpiresAt < now) _watchedCache.TryRemove(kvp.Key, out _);
                }
            }

            return anyWatched;
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
