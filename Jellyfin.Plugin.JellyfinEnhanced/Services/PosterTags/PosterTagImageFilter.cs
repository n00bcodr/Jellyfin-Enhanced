using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    // Image-time half of native poster tags: an MVC action filter on Jellyfin's
    // item image actions that replaces a Primary image with the composite when
    // (and only when) its tag carries a valid "-jet" variant token.
    //
    // Registered BEFORE SpoilerBlurImageFilter, so it runs outside it: its
    // post-processing sees Spoiler Guard's result (blurred or substituted
    // bytes) and draws on top, using Spoiler Guard–stripped tag data.
    //
    // Request flow (anything unexpected => the original image):
    //   pre   Image action + Primary + master switch + tag has -jet; no
    //         Jellyfin indicator params (percentPlayed/unplayedCount); user from
    //         RequestIdentityService at Authenticated / Marker / SingleUserServer
    //         only (never IP or cookie); user's native tags on; token MAC valid
    //         for (user, item, CURRENT settings digest, pixel version); item
    //         visible to the user (GetItemById<BaseItem>(id, user)) and a card
    //         type. Strong = the token pins the CURRENT tag data hash; weak
    //         tokens get their conditional headers held back so Jellyfin can't
    //         answer 304 for a composite that may have changed.
    //   post  304 => keep (strong only reaches here). Base bytes from
    //         PhysicalFileResult (Jellyfin) or FileContentResult (Spoiler
    //         Guard). Compose via PosterTagComposer (cache + coalescing).
    //
    // Caching: strong => private, max-age=1y, immutable, ETag "{tag}";
    // weak => private, max-age=3600, ETag "jec-…" with MVC's own If-None-Match
    // handling; any failure on a -jet URL => original + no-store, with the
    // client's validators dropped so Jellyfin can't 304-confirm an old
    // composite the client still holds for that URL, so a transient fallback
    // is never pinned (or kept) under the personalised URL. Spoiler
    // Guard's no-store always wins: when it is involved this filter leaves
    // cache headers and validators alone (its OnStarting callback still runs
    // last). HEAD goes the same way; MVC's file executor writes no body.
    //
    // Spoiler-scoped posters are never client-cached: a URL whose token
    // carries the SpoilerScoped bit, and any owner under the viewer's Spoiler
    // Guard right now, is served no-store with the client's validators dropped
    // before the action runs (so Jellyfin can't 304-confirm it either). The
    // token pins the UNSTRIPPED data hash; the user's Spoiler Guard prefs, the
    // admin strip toggles and watched state all live outside the URL, so a
    // guarded poster rendered unstripped today could be re-minted under the
    // very same URL after they change. No client ever holds a cached copy
    // whose correctness depends on spoiler state outside the URL.
    public sealed class PosterTagImageFilter : IAsyncActionFilter
    {
        private const string ImageController = "Image";
        private const string NoStore = "private, no-store, max-age=0, must-revalidate";
        private const string StrongCacheControl = "private, max-age=31536000, immutable";
        private const string WeakCacheControl = "private, max-age=3600";

        private static readonly HashSet<string> ImageActions = new(StringComparer.OrdinalIgnoreCase)
        {
            "GetItemImage",
            "GetItemImageByIndex",
            "GetItemImage2",
        };

        private static readonly TimeSpan WarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> WarnedAt = new();

        private readonly RequestIdentityService _identity;
        private readonly PosterTagSettingsProvider _settings;
        private readonly PosterTagVariantToken _tokens;
        private readonly PosterTagDataProvider _data;
        private readonly PosterTagComposer _composer;
        private readonly SpoilerUserResolver _spoilerResolver;
        private readonly SpoilerTagDataStripper _stripper;
        private readonly ILibraryManager _libraryManager;
        private readonly PosterTagUserCache _users;
        private readonly Logger _logger;

        public PosterTagImageFilter(
            RequestIdentityService identity,
            PosterTagSettingsProvider settings,
            PosterTagVariantToken tokens,
            PosterTagDataProvider data,
            PosterTagComposer composer,
            SpoilerUserResolver spoilerResolver,
            SpoilerTagDataStripper stripper,
            ILibraryManager libraryManager,
            PosterTagUserCache users,
            Logger logger)
        {
            _identity = identity;
            _settings = settings;
            _tokens = tokens;
            _data = data;
            _composer = composer;
            _spoilerResolver = spoilerResolver;
            _stripper = stripper;
            _libraryManager = libraryManager;
            _users = users;
            _logger = logger;
        }

        // Strong: the token pins the tag data in Snapshot (which is then what gets
        // drawn). SpoilerScoped: the token was minted under Spoiler Guard, or the
        // owner is under the viewer's Spoiler Guard now; served no-store either
        // way (see the class comment).
        private sealed record Plan(BaseItem Item, JUser User, PosterTagSettings Settings, PosterTagVariant Variant, string Tag, PosterTagDataSnapshot? Snapshot, bool Strong, bool SpoilerScoped);

        // Synchronous fast path: registered globally, so every MVC action pays
        // only these checks unless the request is a Primary image whose tag
        // carries a "-jet" token (which only exists once the feature was on).
        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!IsImageAction(context)) return next();
            if (!context.ActionArguments.TryGetValue("imageType", out var imageType)
                || !string.Equals(imageType?.ToString(), "Primary", StringComparison.OrdinalIgnoreCase))
            {
                return next();
            }

            var tag = context.ActionArguments.TryGetValue("tag", out var rawTag) ? rawTag as string : null;
            var token = ImageTagDecoration.GetVariant(tag);
            if (token == null) return next();

            // Switched off since the URL was issued: serve the original, but
            // never let it be cached for a year under the personalised URL —
            // re-enabling would mint the very same URL again.
            if (JellyfinEnhanced.Instance?.Configuration?.NativePosterTagsEnabled != true) return OriginalNoStoreAsync(context.HttpContext, next);

            // Jellyfin draws its own indicators into the image for these; JE
            // corners would collide. Deterministic for the URL: serve as is.
            if (HasIndicatorParams(context)) return next();

            return RunAsync(context, next, tag!, token);
        }

        private async Task RunAsync(ActionExecutingContext context, ActionExecutionDelegate next, string tag, string token)
        {
            var http = context.HttpContext;
            Plan? plan = null;
            try
            {
                plan = CreatePlan(context, tag, token);
            }
            catch (Exception ex)
            {
                WarnRateLimited("plan:" + ex.GetType().FullName, $"Native poster tags: could not evaluate an image request ({ex.Message}); serving the original.");
            }

            if (plan == null)
            {
                await OriginalNoStoreAsync(http, next).ConfigureAwait(false);
                return;
            }

            // Weak: the URL does not pin the tag data, so Jellyfin's own 304s
            // (If-None-Match == tag on 12.x, If-Modified-Since on the source
            // file) could confirm a composite that has since changed. Hold the
            // validators back and answer them against our own ETag afterwards.
            // (If-Modified-Since is not restored: composites carry no Last-Modified.)
            // Spoiler-scoped: the response is no-store whatever else holds, so
            // nothing may be confirmed either; the validators are just dropped.
            StringValues heldIfNoneMatch = default;
            if (!plan.Strong || plan.SpoilerScoped)
            {
                if (!plan.SpoilerScoped) heldIfNoneMatch = http.Request.Headers[HeaderNames.IfNoneMatch];
                http.Request.Headers.Remove(HeaderNames.IfNoneMatch);
                http.Request.Headers.Remove(HeaderNames.IfModifiedSince);
            }

            var executed = await next().ConfigureAwait(false);
            if (executed.Exception != null || executed.Canceled) return;

            try
            {
                await PostProcessAsync(executed, plan, heldIfNoneMatch).ConfigureAwait(false);
            }
            catch (Exception ex) when (!http.RequestAborted.IsCancellationRequested)
            {
                WarnRateLimited("post:" + ex.GetType().FullName, $"Native poster tags: drawing failed for {plan.Item.Id} ({ex.Message}); serving the original uncached.");
                ApplyNoStore(http);
            }
            catch (Exception)
            {
                // Client went away; nothing to serve.
            }
        }

        // The original image, never cacheable under this URL. The client's
        // validators are dropped first: a client that holds an old composite
        // for this URL would otherwise get its copy confirmed by Jellyfin's own
        // 304 (If-None-Match == tag on 12.x, If-Modified-Since on the source
        // file) although the token was just rejected.
        private static async Task OriginalNoStoreAsync(HttpContext http, ActionExecutionDelegate next)
        {
            http.Request.Headers.Remove(HeaderNames.IfNoneMatch);
            http.Request.Headers.Remove(HeaderNames.IfModifiedSince);
            var executed = await next().ConfigureAwait(false);
            if (executed.Exception == null && !executed.Canceled) ApplyNoStore(http);
        }

        private Plan? CreatePlan(ActionExecutingContext context, string tag, string token)
        {
            if (!TryGetItemId(context, out var itemId)) return null;

            var identity = _identity.Resolve(context.HttpContext);
            if (identity.Candidates.Count != 1
                || identity.Confidence is not (IdentityConfidence.Authenticated or IdentityConfidence.Marker or IdentityConfidence.SingleUserServer))
            {
                return null;
            }

            var userId = identity.Candidates[0];
            var settings = _settings.Get(userId);
            if (!settings.NativeEnabled || !settings.AnyGroupEnabled) return null;

            if (!_tokens.Verify(token, userId, itemId, settings.Digest, PosterTagComposer.PixelVersion, out var variant)) return null;

            var user = _users.Get(userId);
            if (user == null) return null;

            // Library access + parental rating, exactly as Jellyfin's item
            // endpoints and JE's /tag-data check them.
            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item == null || !TagCacheService.TaggableTypes.Contains(item.GetBaseItemKind())) return null;

            // Taken once: the composite is drawn from this very snapshot, so a
            // tag-cache update between the check and the render can't put new
            // data under the old token's immutable response.
            var snapshot = _data.GetPinnedSnapshot(itemId, user);
            var strong = !variant.IsWeak
                && snapshot != null
                && string.Equals(variant.DataHash, snapshot.PinnedHash, StringComparison.Ordinal);
            var spoilerScoped = (variant.Flags & PosterTagVariantFlags.SpoilerScoped) != 0 || IsGuardedNow(context.HttpContext, item, userId);
            return new Plan(item, user, settings, variant, tag, snapshot, strong, spoilerScoped);
        }

        // Whether the owner is under the viewer's Spoiler Guard right now, with
        // the stamper's rule (SpoilerTagDataStripper.IsGuarded). Deliberately
        // independent of the strip toggles: an admin may switch one on later
        // without the URL changing.
        private bool IsGuardedNow(HttpContext http, BaseItem item, Guid userId)
        {
            if (JellyfinEnhanced.Instance?.Configuration?.SpoilerBlurEnabled != true) return false;
            var seriesId = item switch
            {
                Episode episode => episode.SeriesId,
                Season season => season.SeriesId,
                _ => Guid.Empty,
            };
            return _stripper.IsGuarded(
                _spoilerResolver.LoadUserState(http, userId),
                item.Id,
                item.GetBaseItemKind().ToString(),
                seriesId == Guid.Empty ? null : seriesId.ToString("N"));
        }

        private async Task PostProcessAsync(ActionExecutedContext executed, Plan plan, StringValues heldIfNoneMatch)
        {
            var http = executed.HttpContext;
            var response = http.Response;
            if (response.HasStarted) return;

            // Only a strong, non-scoped request can get here with a 304 (every
            // other plan had its validators removed before the action ran):
            // Jellyfin confirmed the client's copy of this exact URL, which
            // identifies exactly one composite.
            if (response.StatusCode == StatusCodes.Status304NotModified)
            {
                if (!NoStoreAlreadyRequired(http)) response.Headers[HeaderNames.CacheControl] = StrongCacheControl;
                return;
            }

            var image = await GetBaseImageAsync(executed.Result, http.RequestAborted).ConfigureAwait(false);
            if (image == null)
            {
                ApplyNoStore(http);
                return;
            }

            // Spoiler Guard involved, or the client sent Cache-Control: no-cache
            // (Jellyfin then answers no-store): never weaken that.
            var keepNoStore = NoStoreAlreadyRequired(http);
            var isHead = HttpMethods.IsHead(http.Request.Method);
            if (isHead && keepNoStore)
            {
                // e.g. Spoiler Guard skips HEAD (no body) and set no-store; don't
                // spend a render on headers nobody may cache.
                return;
            }

            var quality = image.Value.Transformed ? SpoilerOutputQuality : RequestedQuality(executed);
            var result = await _composer.ComposeAsync(
                http,
                plan.Item,
                plan.User,
                plan.Settings,
                (plan.Variant.Flags & PosterTagVariantFlags.TopRightOffset) != 0,
                image.Value.Base,
                quality,
                useCache: true,
                http.RequestAborted,
                plan.Snapshot).ConfigureAwait(false);

            if (result.Status == PosterTagComposeStatus.NoData)
            {
                ApplyNoStore(http);
                return;
            }

            // Spoiler-scoped: what is drawn depends on state the URL doesn't
            // carry (the user's Spoiler Guard prefs and watched state, the
            // admin's strip toggles), so a client must never keep it — even
            // when nothing was stripped this time.
            var noStore = keepNoStore || result.SpoilerStripped || plan.SpoilerScoped;
            // The tag part before -jet is client-supplied and not covered by the
            // MAC: only use it as a validator when it is a well-formed ETag.
            EntityTagHeaderValue? etag = null;
            if (!noStore
                && !EntityTagHeaderValue.TryParse(plan.Strong ? "\"" + plan.Tag + "\"" : "\"jec-" + result.Key.Substring(0, 32) + "\"", out etag))
            {
                etag = null;
            }

            if (result.Status == PosterTagComposeStatus.Rendered)
            {
                executed.Result = new FileContentResult(result.Bytes!, image.Value.Base.ContentType)
                {
                    EntityTag = etag,
                };
            }
            else if (executed.Result is FileResult original && !noStore)
            {
                // Passthrough: the original IS this URL's composite; give it the
                // same validator a drawn one would get.
                original.EntityTag = etag;
                original.LastModified = null;
            }

            var headers = response.Headers;
            headers.Remove(HeaderNames.Age);
            headers.Remove(HeaderNames.LastModified);
            headers.Remove(HeaderNames.ETag); // the result's EntityTag (if any) is written by MVC
            if (noStore)
            {
                if (!keepNoStore) headers[HeaderNames.CacheControl] = NoStore;
                // else: Spoiler Guard's (or Jellyfin's) no-store stays authoritative.
                return;
            }

            headers[HeaderNames.CacheControl] = plan.Strong ? StrongCacheControl : WeakCacheControl;
            headers.Remove(HeaderNames.Pragma);
            if (!plan.Strong && !StringValues.IsNullOrEmpty(heldIfNoneMatch))
            {
                // MVC's file executor evaluates If-None-Match against EntityTag.
                http.Request.Headers[HeaderNames.IfNoneMatch] = heldIfNoneMatch;
            }
        }

        /// <summary>JPEG quality used for Spoiler Guard output (its own encoder setting).</summary>
        private const int SpoilerOutputQuality = 85;

        // Jellyfin encodes at `quality ?? 100` (ImageController); match it.
        private static int RequestedQuality(ActionExecutedContext executed)
        {
            var raw = executed.HttpContext.Request.Query["quality"].ToString();
            return int.TryParse(raw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var q)
                ? Math.Clamp(q, 1, 100)
                : 100;
        }

        private readonly record struct BaseImageInfo(PosterTagBaseImage Base, bool Transformed);

        private static async Task<BaseImageInfo?> GetBaseImageAsync(IActionResult? result, CancellationToken cancellationToken)
        {
            switch (result)
            {
                case PhysicalFileResult physical when !string.IsNullOrEmpty(physical.FileName):
                {
                    var contentType = NormalizeContentType(physical.ContentType);
                    if (contentType == null || !File.Exists(physical.FileName)) return null;
                    // Jellyfin writes a resized image into its cache on the first
                    // request for that size, and concurrent first requests each
                    // re-encode it in place (SkiaEncoder: SKFileWStream truncates
                    // and rewrites the same path). A reader in that window can get
                    // a file of the right length, ending in a valid end marker,
                    // with a zero-filled hole in the middle. Key on the settled
                    // file and refuse a read that changed under us, so a composite
                    // is never drawn from (or cached for) a half-written file.
                    var file = await WaitForSettledFileAsync(physical.FileName, cancellationToken).ConfigureAwait(false);
                    var identity = "file:" + file.FullName + "|" + file.Length + "|" + file.LastWriteTimeUtc.Ticks;
                    return new BaseImageInfo(new PosterTagBaseImage(contentType, identity, () => ReadUnchangedAsync(file)), false);
                }

                case FileContentResult content when content.FileContents is { Length: > 0 } bytes:
                {
                    var contentType = NormalizeContentType(content.ContentType);
                    if (contentType == null) return null;
                    var identity = "bytes:" + Convert.ToHexString(SHA256.HashData(bytes));
                    return new BaseImageInfo(new PosterTagBaseImage(contentType, identity, () => Task.FromResult(bytes)), true);
                }

                default:
                    return null;
            }
        }

        private static readonly TimeSpan FileSettleTime = TimeSpan.FromMilliseconds(150);
        private static readonly TimeSpan FileSettleMaxWait = TimeSpan.FromSeconds(3);

        // Waits until the file has not been written for FileSettleTime (only
        // freshly encoded files ever wait), so racing first requests all key the
        // composite on the same final file identity. The total wait is measured
        // on a monotonic clock and capped at FileSettleMaxWait whatever the file
        // timestamps say: a future mtime (clock correction, a copy that kept
        // its timestamp) never ages, so such a file is accepted once its length
        // and mtime stayed the same over one settle interval instead.
        internal static async Task<FileInfo> WaitForSettledFileAsync(string path, CancellationToken cancellationToken)
        {
            var started = Stopwatch.GetTimestamp();
            var unchangedSince = started;
            (long Length, DateTime LastWrite)? seen = null;
            while (true)
            {
                var file = new FileInfo(path);
                if (!file.Exists) throw new IOException("The image file disappeared.");
                var now = Stopwatch.GetTimestamp();
                if (seen != (file.Length, file.LastWriteTimeUtc))
                {
                    seen = (file.Length, file.LastWriteTimeUtc);
                    unchangedSince = now;
                }

                var age = DateTime.UtcNow - file.LastWriteTimeUtc;
                if (age >= FileSettleTime) return file;
                if (age < TimeSpan.Zero && Stopwatch.GetElapsedTime(unchangedSince, now) >= FileSettleTime) return file;

                var remaining = FileSettleMaxWait - Stopwatch.GetElapsedTime(started, now);
                if (remaining <= TimeSpan.Zero) throw new IOException("The image file kept changing.");
                var delay = age < TimeSpan.Zero ? FileSettleTime - Stopwatch.GetElapsedTime(unchangedSince, now) : FileSettleTime - age;
                if (delay < TimeSpan.FromMilliseconds(20)) delay = TimeSpan.FromMilliseconds(20);
                if (delay > remaining) delay = remaining;
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }
        }

        // Reads the settled file into a buffer of exactly its keyed length and
        // fails if it changed since it was keyed. The size is checked BEFORE
        // anything is allocated or read: an empty or oversized file is a
        // passthrough (RenderAsync would decide the same from the bytes), and
        // that decision is deterministic for the file identity in the key.
        private static async Task<byte[]> ReadUnchangedAsync(FileInfo settled)
        {
            if (settled.Length <= 0 || settled.Length > PosterTagComposer.MaxSourceBytes) return CompositeImageCache.Passthrough;

            var length = (int)settled.Length;
            var bytes = new byte[length];
            var options = new FileStreamOptions
            {
                Mode = FileMode.Open,
                Access = FileAccess.Read,
                Share = FileShare.ReadWrite | FileShare.Delete,
                Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
                BufferSize = 1, // one exact-size read; no FileStream buffer
            };
            var stream = new FileStream(settled.FullName, options);
            await using (stream.ConfigureAwait(false))
            {
                var read = 0;
                while (read < length)
                {
                    var n = await stream.ReadAsync(bytes.AsMemory(read, length - read)).ConfigureAwait(false);
                    if (n == 0) throw new IOException("The image file changed while it was being read."); // shrank
                    read += n;
                }

                var probe = new byte[1];
                if (await stream.ReadAsync(probe).ConfigureAwait(false) != 0)
                {
                    throw new IOException("The image file changed while it was being read."); // grew
                }
            }

            var after = new FileInfo(settled.FullName);
            if (!after.Exists
                || after.Length != settled.Length
                || after.LastWriteTimeUtc != settled.LastWriteTimeUtc)
            {
                throw new IOException("The image file changed while it was being read.");
            }

            return bytes;
        }

        private static string? NormalizeContentType(string? contentType)
        {
            var media = contentType?.Split(';')[0].Trim().ToLowerInvariant();
            return media switch
            {
                "image/jpeg" or "image/jpg" => "image/jpeg",
                "image/png" => "image/png",
                "image/webp" => "image/webp",
                _ => null, // GIF, SVG, …: served as is
            };
        }

        private static bool NoStoreAlreadyRequired(HttpContext http)
            => http.Items.ContainsKey(SpoilerBlurImageFilter.NoStoreHttpContextItem)
                || http.Response.Headers.CacheControl.ToString().Contains("no-store", StringComparison.OrdinalIgnoreCase);

        private static void ApplyNoStore(HttpContext http)
        {
            if (http.Response.HasStarted) return;
            var headers = http.Response.Headers;
            headers[HeaderNames.CacheControl] = NoStore;
            headers.Remove(HeaderNames.ETag);
            headers.Remove(HeaderNames.LastModified);
            headers.Remove(HeaderNames.Age);
        }

        private static bool HasIndicatorParams(ActionExecutingContext context)
        {
            var args = context.ActionArguments;
            if (args.TryGetValue("percentPlayed", out var pp) && pp is double percent && percent > 0) return true;
            if (args.TryGetValue("unplayedCount", out var uc) && uc is int count && count > 0) return true;
            if (args.TryGetValue("addPlayedIndicator", out var api) && api is bool add && add) return true;
            return false;
        }

        private static bool IsImageAction(ActionExecutingContext context)
        {
            var rv = context.ActionDescriptor.RouteValues;
            if (rv == null) return false;
            if (!rv.TryGetValue("controller", out var controller) || controller == null) return false;
            if (!string.Equals(controller, ImageController, StringComparison.OrdinalIgnoreCase)) return false;
            return rv.TryGetValue("action", out var action) && action != null && ImageActions.Contains(action);
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

        private void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = WarnedAt.AddOrUpdate(key, now, (_, last) => (now - last) >= WarnInterval ? now : last);
            if (stored != now) return;
            _logger.Warning(message);
        }
    }
}
