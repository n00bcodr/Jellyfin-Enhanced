using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Trickplay;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Replaces spoiler-bearing image bytes (parent-art substitution in
    // "hide" mode, or a Gaussian blur in "blur" mode) when Spoiler Guard is
    // enabled server-wide AND the requesting user has opted in for the item,
    // for these protected surfaces:
    //   • Episodes of an opted-in series the user has NOT played
    //   • Season posters for S2+ of an opted-in series with no episode watched
    //   • Movies opted in directly OR via an opted-in collection (until played;
    //     SpoilerKeepMoviePosters can exempt the Primary/Thumb poster)
    //   • Trickplay tile-sheets (unless the admin turned SpoilerBlurTrickplay
    //     off or the user opted out via Prefs.HideTrickplay=false) and (when
    //     SpoilerBlurArtwork is on) backdrops
    // A collection's (BoxSet's) OWN art always passes through — it's a shortcut
    // that protects the movies inside, not itself. Per-user state lives in
    // spoilerblur.json (Series / Movies / Collections / PendingTmdb / Prefs).
    //
    // Runs as an MVC action filter scoped to Jellyfin's image + trickplay
    // controller actions so EVERY client (web, TV, iOS, Android) receives the
    // protected bytes from the native image API. No client-side awareness or
    // DOM manipulation needed.
    public sealed class SpoilerBlurImageFilter : IAsyncActionFilter, IDisposable
    {
        private const string ImageController = "Image";
        // Trickplay tile-sheet endpoint (Videos/{id}/Trickplay/{w}/{i}.jpg).
        // Each tile is a sprite-sheet JPEG containing many small thumbnails for
        // timeline scrubbing previews. For Spoiler Guard unwatched items, these
        // thumbnails reveal scenes the user explicitly opted to hide.
        private const string TrickplayController = "Trickplay";
        public const string SpoilerBlurFileName = "spoilerblur.json";

        // Set in HttpContext.Items whenever this filter takes over the response's
        // caching (no-store pass-through registered via OnStarting, or a replaced
        // image). Outer image filters (native poster tags) read it so they never
        // weaken caching, even before the OnStarting callback has run.
        public const string NoStoreHttpContextItem = "JE.Img.SpoilerNoStore";

        // Image controller actions we care about. Jellyfin 10.11.x decorates
        // the same C# methods with both [HttpGet] and [HttpHead(Name="HeadItemImage")];
        // Name= only affects link generation, so RouteValues["action"] for a HEAD
        // request still resolves to the GET method name. We therefore only need
        // the GetItem* names.
        private static readonly HashSet<string> _imageActions = new(StringComparer.OrdinalIgnoreCase)
        {
            "GetItemImage",
            "GetItemImageByIndex",
            "GetItemImage2",
        };

        // Image-type allowlist split into two tiers.
        //
        // Always blur (poster surface — where most spoiler risk lives,
        // typically curated marketing art that conveys plot):
        //   Primary, Thumb, Screenshot
        //
        // Optional blur — admin-toggled via SpoilerBlurArtwork
        // (default false). Backdrops/Art are wider aesthetic images
        // shown on detail pages and collections; many users find blurring
        // those over-aggressive, so they pass through by default.
        private static readonly HashSet<string> _alwaysBlurImageTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "Primary",
            "Thumb",
            "Screenshot",
            // Chapter thumbnails — the Scenes rail in jellyfin-web's
            // movie/episode detail pages. For movies these are
            // progressive-revealed below in the Movie path (chapters past
            // PlaybackPositionTicks blur, before pass through). For
            // episodes the entire chapter set blurs alongside the rest
            // of the unwatched-episode metadata.
            "Chapter",
        };
        // Logos are artwork too: the same tier provider answers protect (SpoilerPresentationContext.ProtectArtwork).
        private static readonly HashSet<string> _artworkImageTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "Backdrop",
            "Art",
            "Logo",
        };

        // Re-warn at most once per hour per surface so a real Jellyfin upgrade
        // changing the response shape isn't permanently invisible.
        private static readonly TimeSpan ShapeWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _warnedShapeAt = new();

        // Rate-limited warning helper + per-request user-state caching now
        // live on SpoilerUserResolver (single shared HttpContext.Items key
        // across both filters).

        private readonly ILibraryManager _libraryManager;
        private readonly IChapterManager _chapterManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly SpoilerUserResolver _resolver;
        private readonly ImageBlurService _blurService;
        private readonly SpoilerNextUnwatchedService _nextUnwatched;
        private readonly Logger _logger;

        public SpoilerBlurImageFilter(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IChapterManager chapterManager,
            SpoilerUserResolver resolver,
            ImageBlurService blurService,
            SpoilerNextUnwatchedService nextUnwatched,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _chapterManager = chapterManager;
            _resolver = resolver;
            _blurService = blurService;
            _nextUnwatched = nextUnwatched;
            _logger = logger;

            // When a user marks an episode (or season/series) played or
            // unplayed, evict the per-(user, season) "any episode watched?"
            // cache for that season so the next image fetch reflects the
            // new state immediately. Without this, the 30-second TTL
            // produces a stale-blur window in the wrong direction —
            // marking an episode UN-played returns the cached "any-watched=
            // true" entry and renders the season poster CLEAR for up to
            // 30s, a privacy regression.
            _userDataManager.UserDataSaved += OnUserDataSaved;
        }

        private void OnUserDataSaved(object? sender, MediaBrowser.Controller.Library.UserDataSaveEventArgs e)
        {
            // Dispatch off the IUserDataManager publish thread. Other
            // UserDataSaved consumers (resume tracking, scheduled tasks,
            // integrations) share that thread; a malicious user
            // burst-toggling Played would otherwise pile up synchronous
            // O(K) cache scans on the publish path. Task.Run drops the
            // work onto the threadpool — fire-and-forget is safe because
            // a missed eviction just leaves stale cache for ≤30s (TTL).
            if (e?.Item == null || e.UserId == Guid.Empty) return;

            // Snapshot the values we need so the lambda captures don't
            // race against post-event mutation.
            var userId = e.UserId;
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
                // Explicit Movie no-op. The Movie image path doesn't use
                // _watchedCache (it reads UserData.Played directly per
                // request), so there's nothing to invalidate here. Listed
                // for future-proofing — if a movie-level server cache is
                // added later, this is the hook.
                case MediaBrowser.Controller.Entities.Movies.Movie:
                    return;
            }

            if (!seasonId.HasValue && !seriesId.HasValue) return;

            // Per-(user, scope) coalesce. A "Mark season watched" sweep on
            // a 24-episode season fires 24 events → 24 queued threadpool
            // tasks all racing the same _watchedCache; coalescing per-user
            // only would collapse cross-season events (seasons A and B for
            // the same user collide and drop B's eviction). Keyed by
            // (userId, scopeId) where scopeId is seasonId for
            // episode/season events and seriesId for series events.
            // Same-season repeats coalesce; cross-season events each get
            // their own dispatch.
            var scopeId = seasonId.HasValue && seasonId.Value != Guid.Empty
                ? seasonId.Value
                : seriesId!.Value;
            var dedupKey = (userId, scopeId);
            if (!_pendingInvalidations.TryAdd(dedupKey, 0))
            {
                return;
            }

            // Protect the dispatcher itself. If Task.Run throws
            // synchronously (OOM, threadpool denial-of-service), the
            // lambda's `finally` never runs — the dedup key would stay
            // in the dictionary forever and that scope's events would
            // be silently dropped until process restart. Catch + remove.
            try
            {
                Task.Run(() =>
                {
                    try
                    {
                        // Instance-field _disposed read at execution time
                        // so post-Dispose lambdas no-op fast.
                        if (_disposed) return;
                        if (seasonId.HasValue && seasonId.Value != Guid.Empty)
                        {
                            // Keys carry the host's specials setting after the season id: both forms go.
                            var key = userId.ToString("N") + ":" + seasonId.Value.ToString("N");
                            _watchedCache.TryRemove(key + ":0", out _);
                            // Surface eviction-key-mismatch as a debug
                            // breadcrumb. If a future refactor desyncs the
                            // build-key from the read-key, evictions
                            // silently become no-ops; counting the
                            // no-removal cases makes that observable.
                            if (!_watchedCache.TryRemove(key + ":1", out _))
                            {
                                // Hit may not exist (cold cache); not an error.
                                // _logger.Info($"[SpoilerBlur] UserDataSaved: no cache entry for season key {key} (cold cache or already evicted).");
                            }
                        }
                        else if (seriesId.HasValue && seriesId.Value != Guid.Empty)
                        {
                            // Series-level event — invalidate every cached season
                            // for this user (keys are "{userN}:{seasonN}", so we
                            // iterate). Cheap: cache is small (≤512) and this is
                            // rare. ToArray so the snapshot survives a concurrent
                            // insert and future framework changes to Keys.
                            var prefix = userId.ToString("N") + ":";
                            foreach (var k in _watchedCache.Keys.ToArray())
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
                            $"Spoiler Guard: failed to invalidate season cache on UserDataSaved: {ex.Message}");
                    }
                    finally
                    {
                        _pendingInvalidations.TryRemove(dedupKey, out _);
                    }
                });
            }
            catch (Exception ex)
            {
                // Synchronous Task.Run failure (rare). Release the dedup
                // slot so subsequent events for this scope can dispatch
                // again, and surface the failure with rate-limited warn.
                _pendingInvalidations.TryRemove(dedupKey, out _);
                _resolver.WarnRateLimited(
                    "userdata-saved-dispatch:" + ex.GetType().FullName,
                    $"Spoiler Guard: Task.Run dispatch threw synchronously: {ex.Message}");
            }
        }

        // Per-(user, scope) dedup gate for the OnUserDataSaved Task.Run
        // dispatch. Scope is seasonId for episode/season events, seriesId
        // for series events. Static so a hot-reload preserves the dedup
        // state across plugin instances (matches _watchedCache,
        // _warnedShapeAt pattern in this file).
        private static readonly ConcurrentDictionary<(Guid, Guid), byte> _pendingInvalidations = new();

        // This filter is a Singleton subscribed to
        // IUserDataManager.UserDataSaved. Without an unsubscribe path,
        // hot-reload / plugin disable+re-enable leaks the event handler
        // delegate (memory leak + double-fire on next event). DI containers
        // dispose Singletons at host shutdown; the plugin's OnUninstalling
        // also calls Dispose via the service provider.
        private bool _disposed;
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                _userDataManager.UserDataSaved -= OnUserDataSaved;
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerBlurImageFilter: unsubscribe on Dispose threw: {ex.Message}");
            }
        }

        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // Sync fast-path. The filter runs on every MVC action; for
            // non-image routes we want to add zero overhead by returning
            // the existing Task directly without entering an async state
            // machine.
            if (!IsImageAction(context))
            {
                return next();
            }

            return RunImageFilterAsync(context, next);
        }

        private async Task RunImageFilterAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // The action runs once; every decision below works on its answer.
            ActionExecutedContext? executed = null;
            IActionResult? loaded = null;
            async Task<ActionExecutedContext> Once()
            {
                if (executed != null) return executed;
                executed = await next().ConfigureAwait(false);
                loaded = executed.Result;
                return executed;
            }

            // The one delivery gate, on every branch (the master switch on or off when loading starts): each attempt decides
            // under its own read-set (the admin's settings, every candidate viewer's Spoiler Guard state, the item's library
            // facts and watched state), and the image leaves only when the gate, after the decision's last await (the action
            // that loaded the image), finds that set unchanged. A changed input decides again on the loaded image; one whose
            // loaded image a protected form already consumed, or whose inputs keep changing, gets the fallback image. The
            // delivered set guards the bytes as they are written, and a 304 (no bytes) only while it holds.
            var http = context.HttpContext;
            // The candidate viewers are resolved only once Spoiler Guard is on (an image with the master switch off costs
            // the settings check alone).
            List<Guid>? candidates = null;
            string? why = null;
            for (var attempt = 0; attempt < PrivacyDelivery.Attempts; attempt++)
            {
                if (attempt > 0) foreach (var candidate in candidates ?? []) PrivacyDelivery.Discard(http, candidate);
                using var scope = PrivacyReadSet.Begin();
                var pluginConfig = JellyfinEnhanced.Instance?.Configuration;
                bool replaced;
                if (pluginConfig?.SpoilerBlurEnabled != true)
                {
                    // Spoiler Guard is off as this attempt reads the settings: the image passes through (the settings are
                    // in the read-set, so turning it on while the image loads decides again).
                    await Once().ConfigureAwait(false);
                    replaced = false;
                }
                else
                {
                    candidates ??= _resolver.ResolveCandidateUserIds(http).Where(c => c != Guid.Empty).Distinct().ToList();
                    foreach (var candidate in candidates) _resolver.LoadUserStateFresh(http, candidate);
                    replaced = await DecideAsync(context, Once, pluginConfig).ConfigureAwait(false);
                }
                if (executed == null || executed.Canceled || executed.Exception != null) return;
                if (scope.Reads.Valid())
                {
                    // A 304 confirms the client's copy: only while the decision's inputs hold.
                    if (executed.Result is StatusCodeResult { StatusCode: 304 } notModified)
                        executed.Result = PrivacyResponseGuard.Confirm(http, notModified);
                    PrivacyResponseGuard.Install(http, scope.Reads);
                    return;
                }
                why = PrivacyReadSet.Withheld(scope.Reads);
                // The loaded image became its protected form under inputs that changed: decided again on the loaded image
                // (its bytes, kept when the protected form read them); without them, the fallback image.
                if (replaced)
                {
                    var original = loaded is FileContentResult ? loaded : http.Items[LoadedImageKey] as IActionResult;
                    if (original == null) break;
                    executed.Result = original;
                }
            }

            _logger.Warning($"Spoiler Guard: an image's verdict inputs kept changing ({why}); the fallback image was sent.");
            WithholdImage(executed);
        }

        /// <summary>An image whose verdict inputs changed under its protected form or kept changing: the fallback image, never cached.</summary>
        private void WithholdImage(ActionExecutedContext? executed)
        {
            if (executed is not { } answered || answered.HttpContext.Response.HasStarted) return;
            answered.Result = new FileContentResult(_blurService.HardcodedFallbackJpeg, "image/jpeg");
            ApplyNoStoreToResponse(answered.HttpContext);
        }

        /// <summary>
        /// One decision on an image answer: passes it through (false) or replaces it with its protected form (true; also
        /// true when nothing was answered). <paramref name="next"/> runs the action once; a later decision reuses its result.
        /// </summary>
        private async Task<bool> DecideAsync(
            ActionExecutingContext context,
            Func<Task<ActionExecutedContext>> next,
            Configuration.PluginConfiguration pluginConfig)
        {
            if (!TryGetItemId(context, out var itemId))
            {
                await next().ConfigureAwait(false);
                return false;
            }
            // Trickplay routes don't carry an `imageType` argument —
            // they're sprite-sheet tiles for a video's scrubbing previews.
            // Treat them as always-blur (the entire sheet contains scene
            // previews that the user opted to hide).
            bool isTrickplay = IsTrickplayRoute(context);
            string imageType;
            bool inArtwork;
            if (isTrickplay)
            {
                imageType = "Trickplay";
                inArtwork = false;
            }
            else
            {
                if (!TryGetImageType(context, out imageType))
                {
                    await next().ConfigureAwait(false);
                    return false;
                }
                // Always-blur tier (poster surface) vs artwork tier (Backdrop/
                // Art) gated behind SpoilerBlurArtwork. Anything else (logos,
                // banners, etc.) passes through unchanged.
                var inAlways = _alwaysBlurImageTypes.Contains(imageType);
                inArtwork = !inAlways && _artworkImageTypes.Contains(imageType);
                if (!inAlways && !inArtwork)
                {
                    await next().ConfigureAwait(false);
                    return false;
                }
            }
            // Do NOT short-circuit Backdrop/Art on SpoilerBlurArtwork=false
            // here — we still need the eligibility check below so
            // spoiler-list artwork can be served with `no-store`. Otherwise
            // Jellyfin's default long-lived public cache headers would let
            // a browser/proxy hold the unblurred bytes; if the admin later
            // toggles SpoilerBlurArtwork on, the client never re-fetches
            // and never sees the blurred response.
            //
            // Decision is deferred to the post-eligibility branch:
            //   inAlways                          → blur (existing path)
            //   inArtwork && SpoilerBlurArtwork   → blur
            //   inArtwork && !SpoilerBlurArtwork  → pass-through w/ no-store

            // Read the item up front: every candidate viewer's decision is about this item.
            var item = PrivacyReads.Item(_libraryManager, itemId);
            if (item == null)
            {
                await next().ConfigureAwait(false);
                return false;
            }

            // User identification — handles ClaimsPrincipal first, then falls back to session-by-IP for anonymous browser
            // <img> requests and native-client image fetches. On a shared IP the fallback can yield several candidates: the
            // image is protected when ANY plausible viewer's decision protects it (one who guards it and has not watched it),
            // never decided by whichever candidate comes first. For the common authenticated request there is exactly one.
            var verdict = ImageVerdict.Pass;
            UserSpoilerBlur? userState = null;
            foreach (var candidate in _resolver.ResolveCandidateUserIds(context.HttpContext))
            {
                if (candidate == Guid.Empty) continue;
                var candidateState = _resolver.LoadUserState(context.HttpContext, candidate);
                if (!SpoilerFieldStripFilter.HasEntries(candidateState)) continue; // this candidate protects nothing
                if (_userManager.GetUserById(candidate) is not { } candidateUser) continue;
                var decided = await DecideForAsync(context, item, imageType, isTrickplay, inArtwork, candidateState, candidateUser, pluginConfig).ConfigureAwait(false);
                if (decided > verdict) verdict = decided;
                if (decided == ImageVerdict.Protect)
                {
                    userState = candidateState;
                    break;
                }
            }
            if (verdict != ImageVerdict.Protect)
            {
                if (verdict == ImageVerdict.PassUncached) RegisterNoStoreOnStarting(context.HttpContext, imageType);
                await next().ConfigureAwait(false);
                return false;
            }

            // Cache key incorporates the blur mode so toggling between "blur"
            // and "hide" doesn't serve stale entries from the wrong mode.
            var spoilerMode = string.Equals(pluginConfig.SpoilerBlurMode, "hide", StringComparison.OrdinalIgnoreCase)
                ? "hide" : "blur";
            var cacheKey = BuildItemCacheKey(item, imageType, context, pluginConfig.SpoilerBlurIntensity)
                + ":" + spoilerMode;

            // The protected form is made from the image's bytes: the client's copy (an earlier, unprotected answer) is
            // never revalidated, so the host answers with the bytes rather than a 304.
            context.HttpContext.Request.Headers.Remove("If-None-Match");
            context.HttpContext.Request.Headers.Remove("If-Modified-Since");
            var executed = await next().ConfigureAwait(false);
            if (executed.Canceled || executed.Exception != null) return true;

            var originalResult = executed.Result;
            try
            {
                if (spoilerMode == "hide")
                {
                    await ReplaceWithStockCardAsync(executed, pluginConfig.SpoilerBlurIntensity, cacheKey, imageType, item, userState!).ConfigureAwait(false);
                }
                else
                {
                    await ReplaceWithBlurredAsync(executed, pluginConfig.SpoilerBlurIntensity, cacheKey, imageType).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Spoiler Guard post-processing failed for episode {itemId} ({imageType}, {spoilerMode}): {ex.Message}");

                // Fail CLOSED in BOTH modes. An exception thrown before
                // ReplaceWith*Async assigned executed.Result (e.g. ExtractBytesAsync
                // stream-copy IOException, OOM on a 4K backdrop decode, or an
                // ObjectDisposedException on a cancelled request) would otherwise
                // let MVC write the original FileStreamResult body — leaking the
                // spoiler image. Force the hardcoded fallback so the fail-closed
                // invariant holds structurally regardless of mode or where in the
                // pipeline the failure occurred (blur mode is NOT exempt: a
                // best-effort blur must still never serve the original bytes).
                if (!executed.HttpContext.Response.HasStarted)
                {
                    try
                    {
                        executed.Result = new FileContentResult(_blurService.HardcodedFallbackJpeg, "image/jpeg");
                        ApplyNoStoreToResponse(executed.HttpContext);
                    }
                    catch (Exception fallbackEx)
                    {
                        _logger.Error($"Spoiler Guard: fail-closed fallback assignment failed for {itemId}: {fallbackEx.Message}");
                    }
                }
            }
            finally
            {
                // MVC normally disposes FileStreamResult streams while executing the
                // result. Replacing that result transfers ownership to this filter;
                // otherwise every protected stream response leaks its file handle.
                if (!ReferenceEquals(originalResult, executed.Result) && originalResult is FileStreamResult streamResult)
                {
                    try { await streamResult.FileStream.DisposeAsync().ConfigureAwait(false); }
                    catch (Exception ex) { _logger.Warning($"Spoiler Guard source stream cleanup failed: {ex.Message}"); }
                }
            }

            return true;
        }

        /// <summary>What one viewer's decision makes of an image: pass it, pass it uncached (its item is guarded), or protect it.</summary>
        private enum ImageVerdict
        {
            Pass = 0,
            PassUncached = 1,
            Protect = 2,
        }

        /// <summary>
        /// One viewer's decision on one image of <paramref name="item"/>, from the item's one privacy decision: its ownership
        /// (an extra by its owner, 10.11's listed owner included), its scope, its watched state and season exemptions (the
        /// same verdict as its item answers), the advanced next-episode image reveal, and the image kind's own rules (artwork
        /// by the artwork setting, movie posters by the keep-posters setting, chapters and trickplay sheets by how far the
        /// viewer watched). The playback position, the chapter timeline and the trickplay timing are read (and recorded) only
        /// in the branches that use them.
        /// </summary>
        private async Task<ImageVerdict> DecideForAsync(ActionExecutingContext context, BaseItem item, string imageType, bool isTrickplay, bool inArtwork,
            UserSpoilerBlur state, JUser user, Configuration.PluginConfiguration config)
        {
            // Collections are a SHORTCUT for "protect the movies in this collection": the collection's own art passes.
            if (item is MediaBrowser.Controller.Entities.Movies.BoxSet) return ImageVerdict.Pass;
            var identity = PrivacyIdentities.Of(_libraryManager, item, user, _userDataManager);
            if (!_resolver.InSpoilerScope(state, identity)) return ImageVerdict.Pass;
            // Trickplay opt-out (admin SpoilerBlurTrickplay=false, or this viewer set Prefs.HideTrickplay=false): the original
            // sheet with no-store, so turning protection back on takes effect on the next fetch. On a shared-IP request the sheet
            // stays protected while any in-scope candidate still inherits the protection (the verdict is the strictest one).
            if (isTrickplay && (!config.SpoilerBlurTrickplay || state.Prefs?.HideTrickplay == false)) return ImageVerdict.PassUncached;
            var poster = !isTrickplay && (string.Equals(imageType, "Primary", StringComparison.OrdinalIgnoreCase) || string.Equals(imageType, "Thumb", StringComparison.OrdinalIgnoreCase));
            var chapterImage = string.Equals(imageType, "Chapter", StringComparison.OrdinalIgnoreCase);
            switch (identity.Kind)
            {
                case Jellyfin.Data.Enums.BaseItemKind.Movie:
                    if (identity.Played == true) return ImageVerdict.PassUncached;
                    // Admin opt-out for movie posters (Primary and Thumb); chapters, screenshots and artwork still follow.
                    if (config.SpoilerKeepMoviePosters && poster) return ImageVerdict.PassUncached;
                    if ((chapterImage || isTrickplay) && await WatchedPastAsync(context, item, user, chapterImage).ConfigureAwait(false)) return ImageVerdict.PassUncached;
                    break;
                case Jellyfin.Data.Enums.BaseItemKind.Episode:
                    if (identity.Played == true) return ImageVerdict.PassUncached;
                    if (poster && config.SpoilerAdvancedMode && !config.SpoilerNextEpisodeStripImage && state.Prefs?.UseAdvancedCategories != false
                        && SpoilerNextUnwatchedService.Categorize(_nextUnwatched.GetBoundary(user.Id, identity.SeriesId), item.Id, item.ParentIndexNumber, item.IndexNumber)
                            == SpoilerEpisodeCategory.NextEpisode)
                        return ImageVerdict.PassUncached;
                    if (isTrickplay && await WatchedPastAsync(context, item, user, chapter: false).ConfigureAwait(false)) return ImageVerdict.PassUncached;
                    break;
                case Jellyfin.Data.Enums.BaseItemKind.Season:
                    // Season 1 (and Specials S0) always show, so the viewer has an entry point; a later season shows once
                    // any of its episodes is watched.
                    if (item is not Season season || season.IndexNumber.GetValueOrDefault(int.MaxValue) <= 1) return ImageVerdict.Pass;
                    if (HasWatchedAnyEpisodeInSeason(user, season)) return ImageVerdict.PassUncached;
                    break;
                case Jellyfin.Data.Enums.BaseItemKind.Series:
                    // A series' own poster is its entry point; its artwork follows the artwork setting.
                    if (!inArtwork) return ImageVerdict.Pass;
                    break;
                default:
                    // An extra (featurette, trailer, theme video) follows its owner: a movie's until the movie is watched.
                    if (!identity.IsExtra) return ImageVerdict.Pass;
                    if (identity.OwnerKind == Jellyfin.Data.Enums.BaseItemKind.Movie && identity.Played == true) return ImageVerdict.PassUncached;
                    break;
            }
            // Artwork tier with the toggle OFF: the original bytes, uncached so a later toggle-on is never served from a cache.
            if (inArtwork && config.SpoilerBlurArtwork != true) return ImageVerdict.PassUncached;
            return ImageVerdict.Protect;
        }

        /// <summary>
        /// Whether <paramref name="user"/> has watched past what the requested chapter image (or trickplay sheet) shows:
        /// a chapter that starts before the resume point, a sheet whose whole range ends at or before it. Reads (and records)
        /// the playback position and the chapter or trickplay timing. Fail-closed on any lookup failure.
        /// </summary>
        private async Task<bool> WatchedPastAsync(ActionExecutingContext context, BaseItem item, JUser user, bool chapter)
        {
            var data = PrivacyReads.UserData(_userDataManager, user, item, progress: true);
            if (data == null || data.Played || data.PlaybackPositionTicks <= 0) return data?.Played == true && chapter;
            var position = data.PlaybackPositionTicks;
            if (chapter)
            {
                if (!TryGetImageIndex(context, out var index)) return false;
                try
                {
                    return PrivacyReads.Chapter(_chapterManager, item.Id, index) is { } start && start.StartPositionTicks < position;
                }
                catch (Exception ex)
                {
                    _resolver.WarnRateLimited("image-chapter-lookup:" + ex.GetType().FullName, $"Spoiler Guard: chapter lookup failed for {item.Id} idx {index}: {ex.Message}");
                    return false;
                }
            }
            return await TrickplayTileFullyWatchedAsync(context, item.Id, position).ConfigureAwait(false);
        }

        // When an item that SHOULD be considered for blur (user has the
        // series enabled) takes a pass-through code path — watched, blur
        // failed, item not yet resolvable, etc. — strip 1-year public
        // caching. Uses the SAME header set as the blurred-response path
        // (`private, no-store, max-age=0, must-revalidate` + drop ETag /
        // Last-Modified) because `private, no-cache` still permits 304
        // revalidation and reuse of the cached unblurred bytes — defeating
        // the whole point of the pass-through scrub.
        //
        // For paths where the response has already begun streaming (the
        // watched-pass-through case after `next()`), we register on
        // `Response.OnStarting` so the override runs JUST BEFORE headers
        // flush.
        private void ApplyNoStoreToResponse(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            try
            {
                if (httpContext.Response.HasStarted)
                {
                    // Response already flushed — too late to mutate
                    // headers. Surface so operators can diagnose when the
                    // cache-scrub silently fails for streaming results.
                    // Rate-limited so a misbehaving response shape doesn't
                    // spam logs on every image fetch.
                    _resolver.WarnRateLimited(
                        "no-store-already-started",
                        "Spoiler Guard: ApplyNoStoreToResponse called after Response.HasStarted=true; cache headers NOT applied. Cache-scrub may not have taken effect for this code path. (For watched-pass-through, use RegisterNoStoreOnStarting BEFORE awaiting next() instead.)");
                    return;
                }
                ApplyNoStoreHeadersDirect(httpContext);
            }
            catch (Exception ex)
            {
                // Don't silently swallow; surface so operators can
                // diagnose when the cache headers aren't actually
                // being applied.
                _logger.Warning($"ApplyNoStoreToResponse failed: {ex.Message}");
            }
        }

        // Registers an OnStarting callback that overrides the cache headers
        // immediately before MVC writes them. Use this for pass-through
        // paths that occur AFTER awaiting `next()` for streaming results
        // where the response may already be on its way out.
        private void RegisterNoStoreOnStarting(Microsoft.AspNetCore.Http.HttpContext httpContext, string imageType = "")
        {
            try
            {
                httpContext.Items[NoStoreHttpContextItem] = true;
                if (httpContext.Response.HasStarted)
                {
                    return;
                }
                httpContext.Response.OnStarting(() =>
                {
                    try { ApplyNoStoreHeadersDirect(httpContext, imageType); }
                    catch (Exception ex) { _logger.Warning($"OnStarting no-store override failed: {ex.Message}"); }
                    return Task.CompletedTask;
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"RegisterNoStoreOnStarting failed: {ex.Message}");
            }
        }

        private static void ApplyNoStoreHeadersDirect(Microsoft.AspNetCore.Http.HttpContext httpContext, string imageType = "")
        {
            httpContext.Items[NoStoreHttpContextItem] = true;
            var headers = httpContext.Response.Headers;
            // Chapter / scene preview images render in a hover-tooltip on
            // the player timeline. Strict no-store made every hover round-
            // trip and produced a visible "gray box → image swap" jank as
            // the browser had no cached copy. Allow a short private cache
            // (30s) for chapter images so subsequent hovers within the
            // same session are instant. Trade-off: a watched-state change
            // (e.g. user advances past a chapter) re-renders within 30s
            // instead of immediately — acceptable for Spoiler Guard UX.
            // Other image types keep strict no-store: posters / thumbs
            // change blur status on a per-watch event, where caching past
            // a state change would defeat the feature.
            var isChapter = string.Equals(imageType, "Chapter", StringComparison.OrdinalIgnoreCase);
            headers["Cache-Control"] = isChapter
                ? "private, max-age=30, must-revalidate"
                : "private, no-store, max-age=0, must-revalidate";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
        }

        // User resolution (ClaimsPrincipal, then session-by-IP with shared-IP
        // disambiguation) lives in SpoilerUserResolver — see
        // ResolveCandidateUserIds / ScanActiveSessionUsers.
        private static bool IsImageAction(ActionExecutingContext context)
        {
            var rv = context.ActionDescriptor.RouteValues;
            if (rv == null) return false;
            if (!rv.TryGetValue("controller", out var controller) || controller == null) return false;
            if (!rv.TryGetValue("action", out var action) || action == null) return false;
            if (string.Equals(controller, ImageController, StringComparison.OrdinalIgnoreCase))
            {
                return _imageActions.Contains(action);
            }
            // Trickplay tiles. Same image-mutation pipeline; the tile is
            // just a JPEG of stitched-together thumbnails.
            if (string.Equals(controller, TrickplayController, StringComparison.OrdinalIgnoreCase))
            {
                return string.Equals(action, "GetTrickplayTileImage", StringComparison.OrdinalIgnoreCase);
            }
            return false;
        }

        private static bool IsTrickplayRoute(ActionExecutingContext context)
        {
            var rv = context.ActionDescriptor.RouteValues;
            if (rv == null) return false;
            if (!rv.TryGetValue("controller", out var c) || c == null) return false;
            return string.Equals(c, TrickplayController, StringComparison.OrdinalIgnoreCase);
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

        // Reads the imageIndex action arg for chapter image requests
        // (`/Items/{id}/Images/Chapter/{index}`).
        private static bool TryGetImageIndex(ActionExecutingContext context, out int imageIndex)
        {
            imageIndex = 0;
            if (!context.ActionArguments.TryGetValue("imageIndex", out var raw) || raw == null) return false;
            if (raw is int i) { imageIndex = i; return true; }
            return int.TryParse(raw.ToString(), out imageIndex);
        }

        // Exclusive END time (in ticks) of the trickplay tile SHEET being
        // requested (route GetTrickplayTileImage(itemId, width, index)), or null
        // if it can't be determined. A `width` sheet packs TileWidth*TileHeight
        // thumbnails, each `Interval` ms apart, so tile N covers the timeline
        // range [N*perSheet*Interval, (N+1)*perSheet*Interval) ms. Resolves
        // ITrickplayManager from the request scope (this filter is a singleton;
        // the manager is request-scoped) rather than via constructor injection.
        private static async Task<long?> TryGetTrickplayTileEndTicksAsync(ActionExecutingContext context, Guid itemId)
        {
            if (!context.ActionArguments.TryGetValue("width", out var wRaw) || wRaw == null) return null;
            if (!context.ActionArguments.TryGetValue("index", out var iRaw) || iRaw == null) return null;
            if (!int.TryParse(wRaw.ToString(), out var width)) return null;
            if (!int.TryParse(iRaw.ToString(), out var tileIndex) || tileIndex < 0) return null;

            if (context.HttpContext.RequestServices?.GetService(typeof(ITrickplayManager)) is not ITrickplayManager mgr)
                return null;

            // The sheet's timing is a verdict input: read through the accessor, which records how to read it again.
            if (await PrivacyReads.Trickplay(mgr, itemId, width).ConfigureAwait(false) is not { } timing) return null;
            var (perSheet, interval) = timing;
            if (perSheet <= 0 || interval <= 0) return null;
            long endMs = (tileIndex + 1L) * perSheet * interval;
            return endMs * TimeSpan.TicksPerMillisecond;
        }

        // True when the requested trickplay tile sheet's timeline range lies
        // ENTIRELY at or before the user's resume point — i.e. every thumbnail
        // in it is a scene already watched, so it's safe to pass through
        // unblurred. Fail-CLOSED (returns false → blur) on any lookup failure
        // or a tile that straddles / is ahead of the resume point.
        private async Task<bool> TrickplayTileFullyWatchedAsync(ActionExecutingContext context, Guid itemId, long watchedThroughTicks)
        {
            try
            {
                var tileEnd = await TryGetTrickplayTileEndTicksAsync(context, itemId).ConfigureAwait(false);
                return tileEnd.HasValue && tileEnd.Value <= watchedThroughTicks;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "image-trickplay-lookup:" + ex.GetType().FullName,
                    $"Spoiler Guard: trickplay lookup failed for {itemId}: {ex.Message}");
                return false;
            }
        }

        // Query params Jellyfin's image controller uses to shape the
        // output (resize / re-encode). Two clients requesting the same
        // episode at different sizes must NOT share the same cached
        // blurred bytes — a TV asking for 720p must not receive a
        // 300px-encoded thumb cached for the web client.
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

            // Trickplay tiles bind their size + tile position as ROUTE
            // arguments (GetTrickplayTileImage(itemId, width, index)), not
            // query params, so _sizeShapingParams (which scans the query
            // string) and `imageIndex` both miss them. Without folding these
            // in, every tile-sheet width and every tile of an item would
            // collapse onto one cache entry and serve the wrong blurred tile.
            var routeKey = new System.Text.StringBuilder();
            if (context.ActionArguments.TryGetValue("width", out var w) && w != null)
                routeKey.Append("w=").Append(w).Append(';');
            if (context.ActionArguments.TryGetValue("index", out var i) && i != null)
                routeKey.Append("i=").Append(i).Append(';');

            // Include the size-shaping query params so different output
            // sizes get distinct cache entries. Use the FULL param name in
            // the key — using just the first letter caused maxWidth=300
            // and maxHeight=300 to collide on `m300;`.
            var sizeKey = new System.Text.StringBuilder();
            foreach (var p in _sizeShapingParams)
            {
                if (query.TryGetValue(p, out var v))
                {
                    sizeKey.Append(p).Append('=').Append(v.ToString()).Append(';');
                }
            }

            return $"{item.Id:N}|{imageType}|{index ?? "_"}|{tag ?? "_"}|{sigma}|{routeKey}{sizeKey}";
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
            /// <summary>The input tick the episodes' watched state was read at.</summary>
            public long ReadAt { get; init; }
        }

        private static readonly ConcurrentDictionary<string, WatchedCacheEntry> _watchedCache = new();

        // Does this candidate's spoiler state cover the item at all? Used to
        // pick the effective user when a shared-IP request yields several
        // candidates: the first candidate that protects the item wins, so an
        // anonymous request never leaks an opted-in user's artwork. Mirrors
        // the per-branch scope checks in the main filter body:
        //   Episode / Season → parent series on the user's Series list
        //   Movie            → IsMovieInSpoilerScope (direct or via collection)
        //   BoxSet / other   → not protected here (its own art passes through)
        private bool ItemInSpoilerScope(UserSpoilerBlur userState, BaseItem item)
        {
            switch (item)
            {
                case Episode ep:
                    return ep.SeriesId != Guid.Empty
                        && _resolver.IsSeriesInSpoilerScope(userState, ep.SeriesId);
                case Season season:
                    return season.SeriesId != Guid.Empty
                        && _resolver.IsSeriesInSpoilerScope(userState, season.SeriesId);
                case MediaBrowser.Controller.Entities.Movies.Movie movie:
                    return _resolver.IsMovieInSpoilerScope(userState, movie.Id, movie.ProviderIds);
                default:
                    return false;
            }
        }

        // A movie is "in spoiler scope" when either (a) the user has it
        // directly opted in via the per-movie toggle, OR (b) the movie is
        // a member of a collection (BoxSet) the user has opted in.
        // BoxSets are NOT direct parents of their member movies in
        // Jellyfin's data model — they reference movies via
        // LinkedChildren. So we iterate opted-in collections, check
        // whether each contains the movie ID.
        private bool HasWatchedAnyEpisodeInSeason(JUser user, Season season)
        {
            // Which episodes the season holds depends on the host's specials setting: part of the memo's key.
            var key = user.Id.ToString("N") + ":" + season.Id.ToString("N") + ":" + PrivacyReads.HostSpecials();
            var now = DateTime.UtcNow;
            // The user's watched state over the season's episodes, recorded as of when it was read.
            PrivacyReads.WatchedIn(user.Id, season.Id);
            if (_watchedCache.TryGetValue(key, out var hit) && hit.ExpiresAt > now && !PrivacyInputs.ScopeChangedSince(hit.ReadAt, user.Id, season.Id))
            {
                PrivacyReadSet.Current?.Watched(user.Id, season.Id, hit.ReadAt);
                PrivacyReadSet.Current?.ChildrenOf(season.Id, hit.ReadAt);
                return hit.AnyWatched;
            }
            var readAt = PrivacyInputs.Now;

            bool anyWatched = false;
            bool determinationFailed = false;
            // Diagnostic counters kept for the commented _logger.Info below —
            // uncomment to troubleshoot unexpected blur/passthrough decisions.
            int total = 0, withUd = 0;
            try
            {
                // `shouldIncludeMissingEpisodes: false` skips episodes Jellyfin
                // has metadata for but no media file — they can't have been
                // "played", so iterating them just wastes work.
                foreach (var child in PrivacyReads.SeasonEpisodes(season, user))
                {
                    total++;
                    if (child is not Episode ep) continue;
                    var ud = PrivacyReads.UserData(_userDataManager, user, ep);
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
                // Fail CLOSED (assume not watched → BLUR). The user opted
                // into spoiler protection for this series; defaulting to
                // pass-through on a transient DB-contention exception
                // can produce a real bug pattern: 24 simultaneous
                // season-image requests overwhelm GetEpisodes for the
                // late seasons in the burst, exceptions cache as
                // "watched" for 30s, and the user sees later seasons
                // unblurred until the cache TTL expires. If the user
                // enabled Spoiler Guard, they want blur on uncertainty,
                // not exposure.
                _resolver.WarnRateLimited(
                    "season-watched:" + ex.GetType().FullName,
                    $"Spoiler Guard: HasWatchedAnyEpisodeInSeason failed for season {season.Id} — failing CLOSED (blur). {ex.Message}");
                anyWatched = false;
                determinationFailed = true;
            }

            // Don't cache exception results. Caching a fail-open
            // `anyWatched=true` for 30s would make one transient DB
            // hiccup persist across the full TTL even after the
            // contention subsided. Only cache successful determinations;
            // let the next call retry, which under typical conditions
            // succeeds.
            if (!determinationFailed)
            {
                _watchedCache[key] = new WatchedCacheEntry
                {
                    AnyWatched = anyWatched,
                    ExpiresAt = now + SeasonWatchedCacheTtl,
                    ReadAt = readAt,
                };
            }

            // Periodic eviction so the dictionary doesn't grow unbounded
            // across long server uptimes. Snapshot via ToArray so a
            // concurrent insert during the scan can't trip
            // InvalidOperationException — `ConcurrentDictionary` enumerator
            // only guarantees stable iteration when snapshotted.
            if (_watchedCache.Count > 512)
            {
                foreach (var kvp in _watchedCache.ToArray())
                {
                    if (kvp.Value.ExpiresAt < now) _watchedCache.TryRemove(kvp.Key, out _);
                }
            }

            return anyWatched;
        }

        // Stock-card replacement path. Used when SpoilerBlurMode == "hide".
        // Instead of returning a flat dark-grey rectangle, try a "safe
        // parent" art image first so the user gets a visually-consistent
        // grid of "this show / this franchise" art rather than a sea of
        // blank dark cards. The parent image type is picked by source
        // aspect to avoid distortion:
        //   Episode (16:9 thumb)        → Series Backdrop (16:9)
        //   Season (2:3 poster)         → Series Primary (2:3)
        //   Movie via Collection (2:3)  → Collection Primary (2:3)
        // When no safe parent art exists (movie directly opted in, series
        // without a Backdrop, etc.) the fallback chain is: blur the original →
        // a flat dark stock card → the pre-encoded #101010 fallback JPEG (only
        // if Skia itself fails). Mirrors ReplaceWithBlurredAsync's no-store policy.
        private async Task ReplaceWithStockCardAsync(
            ActionExecutedContext executed,
            int sigma,
            string cacheKey,
            string imageType,
            MediaBrowser.Controller.Entities.BaseItem item,
            UserSpoilerBlur userState)
        {
            if (executed.Result == null) return;
            if (string.Equals(executed.HttpContext.Request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            {
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            var (originalBytes, originalType) = await ExtractBytesAsync(executed.Result).ConfigureAwait(false);
            if (originalBytes is { Length: > 0 }) KeepLoaded(executed, originalBytes, originalType);
            if (originalBytes == null || originalBytes.Length == 0)
            {
                // A protected answer without bytes to transform never confirms the client's copy (a 304 would keep its
                // earlier, unprotected pixels): it is replaced.
                if (NotModified(executed.Result))
                {
                    executed.Result = new FileContentResult(_blurService.HardcodedFallbackJpeg, "image/jpeg");
                    ApplyNoStoreToResponse(executed.HttpContext);
                    return;
                }
                MaybeWarnShapeMismatch(executed.Result);
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            var parentBytes = TryGetParentArtBytes(item, userState, originalBytes, cacheKey + ":pp");
            if (parentBytes != null && parentBytes.Length > 0)
            {
                executed.Result = new FileContentResult(parentBytes, "image/jpeg");
                if (executed.HttpContext.Response.HasStarted) return;
                ApplyNoStoreHeadersDirect(executed.HttpContext, imageType);
                return;
            }

            // No safe parent art available (e.g. movie directly opted in,
            // series without a Backdrop, season without a Series Primary).
            // Fall back to a blur of the original bytes so the card still
            // has content rather than rendering as a flat dark "broken"
            // tile. Visually consistent with what the user would see in
            // blur-mode for the same item.
            var blurred = _blurService.Blur(originalBytes, sigma, cacheKey);
            if (blurred != null)
            {
                executed.Result = new FileContentResult(blurred, "image/jpeg");
                if (executed.HttpContext.Response.HasStarted) return;
                ApplyNoStoreHeadersDirect(executed.HttpContext, imageType);
                return;
            }

            var stock = _blurService.StockCard(originalBytes, cacheKey);
            if (stock == null)
            {
                // Skia render failed on a flat-fill — practically unreachable
                // (Jellyfin's whole image pipeline shares the same Skia copy)
                // but the hide-mode spoiler contract is "never serve original
                // bytes through this path". Fall back to the pre-encoded
                // 16x16 #101010 JPEG so the invariant is structural, not
                // dependent on Skia liveness.
                executed.Result = new FileContentResult(_blurService.HardcodedFallbackJpeg, "image/jpeg");
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            executed.Result = new FileContentResult(stock, "image/jpeg");
            if (executed.HttpContext.Response.HasStarted) return;
            ApplyNoStoreHeadersDirect(executed.HttpContext, imageType);
        }

        // Returns the bytes of a "safe parent" art image scaled to roughly
        // match the original-image dimensions. Picks the parent image type
        // by the source's aspect so ResizeToMatch's non-uniform scale stays
        // proportional:
        //
        //   Episode (16:9 thumb)        → Series Backdrop
        //   Season (2:3 poster)         → Series Primary
        //   Movie via Collection (2:3)  → Collection Primary
        //
        // Returns null when no safe parent exists (movie directly opted in,
        // or the picked image type is missing on the parent) — caller then
        // falls back to blurring the original (then a flat dark stock card,
        // then the hardcoded fallback JPEG). JPEG-encoded, suitable for
        // FileContentResult.
        private byte[]? TryGetParentArtBytes(
            MediaBrowser.Controller.Entities.BaseItem item,
            UserSpoilerBlur userState,
            byte[] originalBytes,
            string cacheKey)
        {
            try
            {
                Guid parentId = Guid.Empty;
                var parentImageType = MediaBrowser.Model.Entities.ImageType.Primary;

                if (item is Episode ep)
                {
                    // Episode Primary is the episode thumbnail (16:9). Series
                    // Backdrop is also 16:9, so ResizeToMatch's non-uniform
                    // scale stays proportional.
                    parentId = ep.SeriesId;
                    parentImageType = MediaBrowser.Model.Entities.ImageType.Backdrop;
                }
                else if (item is Season s)
                {
                    // Season Primary is the season poster (2:3). Keep Primary
                    // here so we feed a 2:3 source into a 2:3 target slot — a
                    // Series Backdrop would squash 16:9 → 2:3, which is what
                    // we just fixed in the inverse direction for episodes.
                    parentId = s.SeriesId;
                    parentImageType = MediaBrowser.Model.Entities.ImageType.Primary;
                }
                else if (item is MediaBrowser.Controller.Entities.Movies.Movie movie)
                {
                    // Movie directly opted-in has no safe parent (its own
                    // Primary IS the spoiler). For collection-opted movies,
                    // fall back to the collection's Primary art (2:3, same
                    // aspect as the movie's own poster).
                    if (!userState.Movies.ContainsKey(movie.Id.ToString("N")))
                    {
                        parentId = _resolver.FindOptedInCollectionForMovie(userState, movie.Id) ?? Guid.Empty;
                    }
                }

                if (parentId == Guid.Empty) return null;
                var parent = PrivacyReads.Item(_libraryManager, parentId);
                if (parent == null) return null;

                var imgInfo = parent.GetImageInfo(parentImageType, 0);
                if (imgInfo == null || string.IsNullOrEmpty(imgInfo.Path)) return null;
                if (!System.IO.File.Exists(imgInfo.Path)) return null;

                // Cache via the same LRU as StockCard — same cacheKey
                // shape so successive identical requests are free.
                var fileBytes = System.IO.File.ReadAllBytes(imgInfo.Path);
                if (fileBytes == null || fileBytes.Length == 0) return null;

                // Resize to roughly match the original dimensions so the
                // card layout doesn't shift. Use the original's probe
                // dimensions; cap at MaxDecodeEdgePx via ImageBlurService.
                //
                // The resize cache key MUST include the chosen parent id +
                // image type: for a collection-opted movie the parent is
                // picked from the requesting user's Collections, so the same
                // movie/size/mode key can resolve to DIFFERENT collection art
                // for two users. Without this, user B (movie in Collection B)
                // could be served user A's Collection A art from the cache.
                var parentArtKey = cacheKey + ":" + parentId.ToString("N") + ":" + parentImageType;
                return _blurService.ResizeToMatch(fileBytes, originalBytes, parentArtKey);
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "parent-art:" + ex.GetType().FullName,
                    $"Spoiler Guard: parent-art fallback failed for item {item?.Id}: {ex.Message}");
                return null;
            }
        }

        private async Task ReplaceWithBlurredAsync(ActionExecutedContext executed, int sigma, string cacheKey, string imageType = "")
        {
            if (executed.Result == null) return;

            // HEAD requests carry no body — pass through.
            if (string.Equals(executed.HttpContext.Request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            {
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            var (originalBytes, originalType) = await ExtractBytesAsync(executed.Result).ConfigureAwait(false);
            if (originalBytes is { Length: > 0 }) KeepLoaded(executed, originalBytes, originalType);
            if (originalBytes == null || originalBytes.Length == 0)
            {
                // A protected answer without bytes to transform never confirms the client's copy (a 304 would keep its
                // earlier, unprotected pixels): it is replaced.
                if (NotModified(executed.Result))
                {
                    executed.Result = new FileContentResult(_blurService.HardcodedFallbackJpeg, "image/jpeg");
                    ApplyNoStoreToResponse(executed.HttpContext);
                    return;
                }
                MaybeWarnShapeMismatch(executed.Result);
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            var blurred = _blurService.Blur(originalBytes, sigma, cacheKey);
            if (blurred == null)
            {
                // Blur failed, and we already consumed the source stream during
                // ExtractBytesAsync, so we MUST write a complete body — but it
                // must NEVER be the original spoiler bytes (fail CLOSED, same as
                // hide mode). Fall back to a stock card sized to the original
                // (keeps the grid from shifting), then the hardcoded JPEG if even
                // that fails. Not cached (null key) since this is a transient
                // error path. Force `no-store`.
                var fallback = _blurService.StockCard(originalBytes, null) ?? _blurService.HardcodedFallbackJpeg;
                executed.Result = new FileContentResult(fallback, "image/jpeg");
                ApplyNoStoreToResponse(executed.HttpContext);
                return;
            }

            // We always re-encode as JPEG (the blur service does), so set the
            // content type explicitly. Cache-Control: private, no-store keeps
            // clients from holding the blurred copy after the user marks the
            // episode watched or disables Spoiler Guard for the series.
            // Chapter images get a short browser-cache window via
            // ApplyNoStoreHeadersDirect so timeline-hover preview thumbs
            // don't round-trip on every cursor move.
            executed.Result = new FileContentResult(blurred, "image/jpeg");

            if (executed.HttpContext.Response.HasStarted) return;
            ApplyNoStoreHeadersDirect(executed.HttpContext, imageType);
        }

        /// <summary>The loaded image's bytes, kept by a protected form that read a stream (a later decision starts from them).</summary>
        private const string LoadedImageKey = "__JE_SPOILER_LOADED_IMAGE";

        /// <summary>Keeps the loaded image's bytes for a decision made again (the stream they came from is consumed).</summary>
        private static void KeepLoaded(ActionExecutedContext executed, byte[] bytes, string? contentType)
        {
            if (executed.Result is FileContentResult) return;
            var kept = new FileContentResult(bytes, contentType ?? "image/jpeg");
            if (executed.Result is FileResult file) { kept.LastModified = file.LastModified; kept.EntityTag = file.EntityTag; }
            executed.HttpContext.Items[LoadedImageKey] = kept;
        }

        /// <summary>Whether an answer confirms the client's copy instead of carrying the image (a 304).</summary>
        private static bool NotModified(IActionResult? result) => result is StatusCodeResult { StatusCode: 304 } or ObjectResult { StatusCode: 304 };

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
            _logger.Warning($"Spoiler Guard: image action produced an unrecognized result type ({key}); blur is no-op for this shape. Re-warns hourly. Likely a Jellyfin upgrade changed the image controller's return type.");
        }
    }
}
