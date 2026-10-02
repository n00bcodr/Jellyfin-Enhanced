using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Stamps the requesting user's identity marker (see
    // SpoilerIdentityService) onto every image-tag field of item DTOs in
    // AUTHENTICATED API responses. Clients build their image URLs from these
    // values and echo them back as `?tag=` on the (anonymous) image request,
    // which is the only user-correlated signal native clients put on the
    // wire — SpoilerUserResolver extracts it there, replacing session-by-IP
    // matching for any client that received stamped DTOs. This is what keeps
    // Spoiler Guard per-user precise behind reverse proxies that hide the
    // real client IP.
    //
    // Unlike SpoilerFieldStripFilter this filter has NO route allowlist and
    // stamps ALL items for ALL users (not just spoiler-scoped items): an
    // image request can only be attributed to a user if EVERY tag that user
    // ever received carries their marker — including items they never
    // guarded (that's precisely how a non-guarding user proves they're not
    // the guarding one and gets clean bytes on a shared IP). Unknown response
    // shapes are simply left unstamped; the resolver then falls back to the
    // existing single-user / cookie / shared-IP identity ladder for those
    // images (fail-safe, strictly additive).
    //
    // PERF(R-series server analogue): gates are two cheap checks before
    // any work (master switch, authenticated user), and the stamp
    // itself is a handful of string appends + dictionary re-keys per item —
    // no I/O, no DB, no allocation beyond the new tag strings.
    //
    // Native poster tags (NativePosterTagsEnabled) reuse this filter as their
    // metadata-time hook: for native clients of users with the feature on,
    // NativePosterTagStamper inserts a "-jet" variant token (plus this user's
    // "-jeu" marker) into the Primary image tags a poster can be drawn from,
    // BEFORE the Spoiler Guard stamping below, giving
    // "sb-{8hex}-{tag}-jet{token}-jeu{12hex}" (ImageTagDecoration). With Spoiler
    // Guard on, every other field is stamped exactly as before; with it off,
    // only those eligible fields change, so no other image URL churns.
    public sealed class SpoilerIdentityTagFilter : IAsyncActionFilter
    {
        private readonly SpoilerIdentityService _identity;
        private readonly SpoilerUserResolver _resolver;
        private readonly NativePosterTagStamper _posterTags;

        public SpoilerIdentityTagFilter(
            SpoilerIdentityService identity,
            SpoilerUserResolver resolver,
            NativePosterTagStamper posterTags)
        {
            _identity = identity;
            _resolver = resolver;
            _posterTags = posterTags;
        }

        // Non-async on purpose: this filter is registered globally (no route
        // allowlist), so the disabled/anonymous fast paths run on EVERY MVC
        // response the server serves — `return next()` synchronously there so
        // no async state machine is allocated when we will do no work
        // (mirrors SpoilerFieldStripFilter's fast-path pattern).
        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            var spoilerGuard = cfg?.SpoilerBlurEnabled == true;
            if (!spoilerGuard && cfg?.NativePosterTagsEnabled != true)
            {
                return next();
            }

            // Only authenticated user responses get stamped — the DTO is the
            // per-user channel. API-key requests (no user) and anonymous
            // requests pass through untouched.
            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User);
            if (userId == null || userId.Value == Guid.Empty)
            {
                return next();
            }

            // Native poster tags alone: web clients (and everyone while the
            // master switch is off) keep the synchronous fast path.
            var posterTags = _posterTags.IsCandidate(context.HttpContext);
            if (!spoilerGuard && !posterTags)
            {
                return next();
            }

            return StampAfterActionAsync(context, next, userId.Value, spoilerGuard, posterTags);
        }

        private async Task StampAfterActionAsync(ActionExecutingContext context, ActionExecutionDelegate next, Guid userId, bool spoilerGuard, bool posterTags)
        {
            var executed = await next().ConfigureAwait(false);
            if (executed.Exception != null || executed.Canceled) return;
            if (executed.Result is not ObjectResult { Value: not null }) return;

            NativePosterTagStampSession? session = null;
            if (posterTags)
            {
                try
                {
                    session = _posterTags.Begin(context.HttpContext, userId);
                }
                catch (Exception ex)
                {
                    _resolver.WarnRateLimited(
                        "postertags-session:" + ex.GetType().FullName,
                        $"Native poster tags: could not prepare tag stamping — posters for this response stay original. {ex.Message}");
                }
            }

            if (!spoilerGuard && session == null) return;

            try
            {
                StampIfApplicable(executed.Result, spoilerGuard ? _identity.MintMarker(userId) : null, session);
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "identitytag-apply:" + ex.GetType().FullName,
                    $"Spoiler Guard identity tags: stamping failed — response served unstamped (image identity falls back to single-user/cookie/IP resolution). {ex.Message}");
            }
        }

        // marker: stamp every field with Spoiler Guard's identity (null when
        // Spoiler Guard is off). session: native poster tags for this response
        // (null when not applicable). Native stamping runs first per item so
        // its "-jet" lands in front of the trailing "-jeu".
        private void StampIfApplicable(IActionResult? result, string? marker, NativePosterTagStampSession? session)
        {
            // Opportunistic: only ObjectResult shapes we recognize are
            // stamped. Anything else (file results, unknown wrappers) is
            // left alone — those images resolve via the IP ladder as before.
            if (result is not ObjectResult objectResult || objectResult.Value == null) return;

            switch (objectResult.Value)
            {
                case BaseItemDto single:
                    Stamp(single, marker, session);
                    break;
                case QueryResult<BaseItemDto> qr:
                    if (qr.Items != null)
                    {
                        foreach (var item in qr.Items) Stamp(item, marker, session);
                    }
                    break;
                case IEnumerable<BaseItemDto> seq:
                    // Same lazy-iterator hazard as SpoilerFieldStripFilter:
                    // LINQ projections re-materialize fresh DTOs on every
                    // enumeration, so mutate a materialized list and write it
                    // back — otherwise MVC serializes unstamped copies.
                    var list = seq is List<BaseItemDto> alreadyList ? alreadyList : seq.ToList();
                    foreach (var item in list) Stamp(item, marker, session);
                    if (!ReferenceEquals(list, seq))
                    {
                        objectResult.Value = list;
                    }
                    break;
                case SearchHintResult shr:
                    if (shr.SearchHints != null)
                    {
                        foreach (var hint in shr.SearchHints)
                        {
                            if (hint == null) continue;
                            if (session != null) StampNative(() => _posterTags.StampSearchHint(hint, session));
                            if (marker == null) continue;
                            if (!string.IsNullOrEmpty(hint.PrimaryImageTag))
                                hint.PrimaryImageTag = SpoilerIdentityService.AppendMarker(hint.PrimaryImageTag, marker);
                            if (!string.IsNullOrEmpty(hint.ThumbImageTag))
                                hint.ThumbImageTag = SpoilerIdentityService.AppendMarker(hint.ThumbImageTag, marker);
                            if (!string.IsNullOrEmpty(hint.BackdropImageTag))
                                hint.BackdropImageTag = SpoilerIdentityService.AppendMarker(hint.BackdropImageTag, marker);
                        }
                    }
                    break;
                case IEnumerable<RecommendationDto> recs:
                    foreach (var rec in recs)
                    {
                        if (rec?.Items == null) continue;
                        foreach (var item in rec.Items) Stamp(item, marker, session);
                    }
                    break;
            }
        }

        private void Stamp(BaseItemDto item, string? marker, NativePosterTagStampSession? session)
        {
            if (item == null) return;
            if (session != null) StampNative(() => _posterTags.StampItem(item, session));
            if (marker != null) StampItem(item, marker);
        }

        // A native stamping failure skips that one item's posters (they stay
        // original) and never blocks Spoiler Guard's identity stamping.
        private void StampNative(Action stamp)
        {
            try
            {
                stamp();
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "postertags-stamp:" + ex.GetType().FullName,
                    $"Native poster tags: stamping an item failed — its posters stay original. {ex.Message}");
            }
        }

        // Every image-tag-bearing BaseItemDto field (clients build image URLs
        // from ALL of these — series/parent art on episode rows, album art,
        // channel art, chapter thumbs), plus ImageBlurHashes re-keyed in
        // lockstep because clients look blurhashes up BY the tag string.
        // Internal so focused tests can cover tag stamping directly if this
        // repo grows a test project.
        internal static void StampItem(BaseItemDto item, string marker)
        {
            if (item == null) return;

            if (item.ImageTags != null && item.ImageTags.Count > 0)
            {
                var keys = item.ImageTags.Keys.ToArray();
                foreach (var k in keys)
                {
                    var orig = item.ImageTags[k];
                    var stamped = SpoilerIdentityService.AppendMarker(orig, marker);
                    if (!ReferenceEquals(stamped, orig))
                    {
                        ReKeyBlurhash(item, k, orig, stamped);
                        item.ImageTags[k] = stamped;
                    }
                }
            }

            StampTagArray(item, item.BackdropImageTags, ImageType.Backdrop, marker);
            StampTagArray(item, item.ScreenshotImageTags, ImageType.Screenshot, marker);
            StampTagArray(item, item.ParentBackdropImageTags, ImageType.Backdrop, marker);

            item.AlbumPrimaryImageTag = StampScalar(item, item.AlbumPrimaryImageTag, ImageType.Primary, marker);
            item.SeriesPrimaryImageTag = StampScalar(item, item.SeriesPrimaryImageTag, ImageType.Primary, marker);
            item.ParentPrimaryImageTag = StampScalar(item, item.ParentPrimaryImageTag, ImageType.Primary, marker);
            item.ChannelPrimaryImageTag = StampScalar(item, item.ChannelPrimaryImageTag, ImageType.Primary, marker);
            item.ParentLogoImageTag = StampScalar(item, item.ParentLogoImageTag, ImageType.Logo, marker);
            item.ParentArtImageTag = StampScalar(item, item.ParentArtImageTag, ImageType.Art, marker);
            item.SeriesThumbImageTag = StampScalar(item, item.SeriesThumbImageTag, ImageType.Thumb, marker);
            item.ParentThumbImageTag = StampScalar(item, item.ParentThumbImageTag, ImageType.Thumb, marker);

            // Chapter thumbnails (the Scenes rail) — clients echo
            // ChapterInfo.ImageTag on /Items/{id}/Images/Chapter/{n} requests.
            if (item.Chapters != null)
            {
                foreach (var ch in item.Chapters)
                {
                    if (ch != null && !string.IsNullOrEmpty(ch.ImageTag))
                    {
                        ch.ImageTag = SpoilerIdentityService.AppendMarker(ch.ImageTag, marker);
                    }
                }
            }
        }

        private static void StampTagArray(BaseItemDto item, string[]? tags, ImageType blurhashType, string marker)
        {
            if (tags == null) return;
            for (var i = 0; i < tags.Length; i++)
            {
                var orig = tags[i];
                if (string.IsNullOrEmpty(orig)) continue;
                var stamped = SpoilerIdentityService.AppendMarker(orig, marker);
                if (!ReferenceEquals(stamped, orig))
                {
                    ReKeyBlurhash(item, blurhashType, orig, stamped);
                    tags[i] = stamped;
                }
            }
        }

        private static string? StampScalar(BaseItemDto item, string? orig, ImageType blurhashType, string marker)
        {
            if (string.IsNullOrEmpty(orig)) return orig;
            var stamped = SpoilerIdentityService.AppendMarker(orig, marker);
            if (!ReferenceEquals(stamped, orig))
            {
                ReKeyBlurhash(item, blurhashType, orig, stamped);
            }
            return stamped;
        }

        // ImageBlurHashes is Dictionary<ImageType, Dictionary<tag, hash>> —
        // keyed by the TAG STRING the client holds. Re-key alongside every
        // tag rewrite or blurhash placeholder lookups silently break. The
        // current tag may already carry the strip filter's "sb-{8hex}-"
        // cache-bust prefix while the blurhash dict still holds the ORIGINAL
        // Jellyfin tag (that filter never re-keyed) — fall back to the
        // prefix-stripped base tag so those entries re-key correctly too.
        private static void ReKeyBlurhash(BaseItemDto item, ImageType type, string oldTag, string newTag)
        {
            if (item.ImageBlurHashes == null) return;
            if (!item.ImageBlurHashes.TryGetValue(type, out var byTag) || byTag == null) return;

            if (byTag.Remove(oldTag, out var hash))
            {
                byTag[newTag] = hash;
                return;
            }

            var baseTag = TryStripCacheBustPrefix(oldTag);
            if (baseTag != null && byTag.Remove(baseTag, out hash))
            {
                byTag[newTag] = hash;
            }
        }

        // "sb-{8hex}-{origTag}" → "{origTag}", or null when the shape doesn't
        // match (see SpoilerFieldStripFilter.MutateImageTagsForCacheBust).
        private static string? TryStripCacheBustPrefix(string tag)
        {
            const int prefixLen = 12; // "sb-" + 8 hex + "-"
            if (tag.Length <= prefixLen) return null;
            if (!tag.StartsWith("sb-", StringComparison.Ordinal)) return null;
            if (tag[prefixLen - 1] != '-') return null;
            return tag.Substring(prefixLen);
        }
    }
}
