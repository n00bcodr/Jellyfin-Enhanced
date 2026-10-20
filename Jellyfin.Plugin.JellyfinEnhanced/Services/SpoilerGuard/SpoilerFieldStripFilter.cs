using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Strips spoiler-y metadata fields (Overview, Tags, Chapter names,
    // Taglines, ratings, premiere date, episode title, cast) from
    // BaseItemDto responses for UNWATCHED episodes whose parent series
    // is in the requesting user's Spoiler Guard list. Series-level DTOs
    // use a separate overview policy so admins and users can keep the
    // show's general description without exposing episode plots.
    //
    // Runs as an MVC action filter scoped to the standard item-listing
    // endpoints (Items, NextUp, Episodes, Suggestions, etc.) so every
    // client benefits — not just web. Companion to SpoilerBlurImageFilter
    // which handles the image bytes; this filter handles the metadata.
    //
    // Performance: three string compares + one dict lookup before any
    // expensive work. Per-item strip is O(1) (a handful of property
    // assignments). NO database queries — relies on the UserData.Played
    // flag Jellyfin already includes in the DTO. If UserData is omitted
    // from a particular endpoint's response shape, we skip stripping for
    // that item (fail-safe, matches the action-filter rule pattern in
    // HiddenContentResponseFilter).
    public sealed class SpoilerFieldStripFilter : IAsyncActionFilter
    {
        // Which endpoints this filter strips comes from the one surface registry (PrivacySurfaceRegistry): every host
        // endpoint whose answer can carry a title, extracted from Jellyfin 12.2 and 10.11.11, classified once for both
        // Hidden Content and Spoiler Guard.

        // Per-category reveal mask for the advanced Spoiler Guard mode. Each
        // flag EXEMPTS one field from a strip the base toggles would apply;
        // default (all false) is the uniform full strip. A reveal can only
        // relax an active strip — it never strips anything itself.
        internal readonly record struct CategoryReveal(bool Title, bool Overview, bool Ratings)
        {
            internal static readonly CategoryReveal None = default;
        }

        private readonly SpoilerUserResolver _resolver;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly SpoilerNextUnwatchedService _nextUnwatched;
        private readonly MediaBrowser.Model.Globalization.ILocalizationManager? _localization;

        public SpoilerFieldStripFilter(
            SpoilerUserResolver resolver,
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            SpoilerNextUnwatchedService nextUnwatched,
            MediaBrowser.Model.Globalization.ILocalizationManager? localization = null)
        {
            // The watched-state and ownership changes the delivery gate compares (verdict inputs with revisions).
            PrivacyInputs.Observe(libraryManager, userDataManager);
            _resolver = resolver;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _nextUnwatched = nextUnwatched;
            // The host's closed lists (languages, ratings, labels) a protected item's values are checked against.
            _localization = localization;
        }

        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // Sync fast-path bail order — three short-circuit checks before
            // we touch anything expensive. Returns the original Task<>
            // unchanged so non-matching routes pay zero overhead.
            if (!IsTargetRoute(context)) return next();

            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerBlurEnabled != true) return next();
            // Do NOT short-circuit on AnyStripToggleOn. The pipeline's
            // cache-bust pass (MutateImageTagsForCacheBust) must run on
            // EVERY DTO whenever Spoiler Guard is enabled, so native-client
            // image caches re-fetch when the user flips watched-state or
            // toggles Spoiler Guard itself. ApplyStripping is internally
            // per-toggle gated, so when no strip toggle is on it's a no-op
            // past the cache-bust mutation.

            return RunFieldStripAsync(context, next, cfg);
        }

        /// <summary>
        /// Spoiler Guard's own strip over library items answered by another filter that short-circuits the
        /// action (the native details facade lists a season or episode the viewer can open in the library
        /// as itself): the same pipeline as a native answer, by the caller's watched state.
        /// </summary>
        /// <param name="result">The answer.</param>
        /// <param name="context">The action's context (the route).</param>
        /// <param name="userId">The effective viewer the answer is for.</param>
        internal void StripLibraryItems(IActionResult? result, ActionExecutingContext context, Guid userId)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (result == null || cfg?.SpoilerBlurEnabled != true || userId == Guid.Empty) return;
            var userState = _resolver.LoadUserState(context.HttpContext, userId);
            if (!HasEntries(userState)) return;
            try
            {
                StripIfApplicable(result, userState, cfg, userId, context);
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited("fieldstrip-apply:" + ex.GetType().FullName, $"Spoiler Guard field strip failed: {ex.Message}");
            }
        }

        /// <summary>Whether the matched endpoint (by its descriptor's controller/action) is one this filter strips.</summary>
        internal static bool Guards(ActionContext context) => IsTargetRoute(context);

        /// <summary>Whether a viewer's state names anything Spoiler Guard could apply to.</summary>
        internal static bool HasEntries(UserSpoilerBlur state)
            => state.Series.Count + state.Movies.Count + state.Collections.Count + state.ProviderTitles.Count + state.PendingTmdb.Count > 0;

        /// <summary>
        /// The final delivery gate's re-strip with the state it read at delivery, for every guarded response shape. The
        /// strip is idempotent, so an answer the action-time pass already stripped is unchanged.
        /// </summary>
        internal void StripDelivered(ObjectResult result, UserSpoilerBlur state, Guid userId, ActionContext context)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerBlurEnabled != true || userId == Guid.Empty || !HasEntries(state)) return;
            StripIfApplicable(result, state, cfg, userId, context);
        }

        private static bool IsTargetRoute(ActionContext context) => PrivacySurfaceRegistry.Find(context) is { Sg: true };

        private async Task RunFieldStripAsync(
            ActionExecutingContext context,
            ActionExecutionDelegate next,
            PluginConfiguration cfg)
        {
            var userId = _resolver.ResolveUserId(context.HttpContext) ?? Guid.Empty;
            if (userId == Guid.Empty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var userState = _resolver.LoadUserState(context.HttpContext, userId);
            // A movies-only spoiler user (no series in their list) would
            // short-circuit the entire field-strip pipeline here if we
            // only checked Series, leaving movie /Items,
            // /Items/{id}/PlaybackInfo, and /Items/{id}/Images unstripped
            // despite the Movie branches in StripItem +
            // RouteParentIsSpoilerEpisode. Mirror the GetTagCache /
            // GetTagData / image-filter checks.
            if (!HasEntries(userState))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            // Surface (rate-limited) when the wrapped action threw — strip
            // silently skipped and operator can correlate "Overview leaked
            // but my toggle is on" reports with the underlying controller
            // exception.
            if (executed.Exception != null)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-action-exception:" + executed.Exception.GetType().FullName,
                    $"Spoiler Guard field strip: wrapped action threw — strip not applied. {executed.Exception.GetType().Name}: {executed.Exception.Message}");
                return;
            }
            if (executed.Canceled) return;

            try
            {
                StripIfApplicable(executed.Result, userState, cfg, userId, context);
            }
            catch (Exception ex)
            {
                // Rate-limit so a persistent strip bug on a 100-item batch
                // doesn't produce 100 log lines. Pattern matches the rest
                // of the filter (resolver.WarnRateLimited keyed by
                // exception type).
                _resolver.WarnRateLimited(
                    "fieldstrip-apply:" + ex.GetType().FullName,
                    $"Spoiler Guard field strip failed: {ex.Message}");
            }
        }

        // Walks the action result and applies StripItem to every item in Spoiler Guard's scope. A protected item is
        // delivered as the value walk rebuilt it (PrivacyValues), so every answer shape writes the rebuilt items back.
        private void StripIfApplicable(
            IActionResult? result,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            ActionContext context)
        {
            // ObjectResult covers most MVC return shapes, but JsonResult /
            // ContentResult / custom IActionResult are siblings (not
            // subclasses). Generalize: log any non-null, non-ObjectResult
            // shape with the type name as the rate-limit key so a future
            // Jellyfin upgrade is observable.
            if (result == null) return;
            if (result is not ObjectResult objectResult)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-shape:" + result.GetType().FullName,
                    $"Spoiler Guard field strip: action returned {result.GetType().Name}; strip is no-op for that shape. Likely a Jellyfin upgrade — switch to {result.GetType().Name}-aware extraction.");
                return;
            }
            if (objectResult.Value == null) return;

            // A lazy answer (12.2 builds recommendation DTOs per enumeration) is enumerated once and its instances stripped.
            var value = NativeResponseValue.Materialize(objectResult);
            // Every decision below takes its ownership from the one identity resolver (the item's owner, a theme
            // answer's OwnerId, the route's opened item), never from a DTO's SeriesId.
            var identities = NativePrivacyProjection.Identities(_libraryManager, value, context);
            BaseItemDto Strip(BaseItemDto item) => StripItem(item, userState, cfg, userId, item == null ? null : identities.GetValueOrDefault(item.Id));
            switch (value)
            {
                case BaseItemDto or QueryResult<BaseItemDto> or IEnumerable<BaseItemDto> or IReadOnlyList<MediaBrowser.Model.Dto.RecommendationDto> or AllThemeMediaResult:
                    // Many controllers return a lazy LINQ Select that builds a NEW BaseItemDto per enumeration: the
                    // answer was materialized above, and every listed item is replaced by what the strip delivers.
                    NativeResponseValue.Replace(objectResult, Strip);
                    break;
                case SearchHintResult shr:
                    objectResult.Value = StripSearchHints(shr, userState, cfg, userId, identities);
                    break;
                // ImageInfo[] from /Items/{id}/Images. Path is raw
                // filesystem. Look up the parent itemId from the route to
                // determine if its series is in the spoiler list.
                case IEnumerable<MediaBrowser.Model.Dto.ImageInfo> imgs:
                    objectResult.Value = StripImageInfos(imgs, userState, cfg, userId, context);
                    break;
                // PlaybackInfoResponse contains MediaSources[] with the
                // same title-bearing fields as BaseItemDto's MediaSources.
                case MediaBrowser.Model.MediaInfo.PlaybackInfoResponse pbi:
                    StripPlaybackInfo(pbi, userState, cfg, userId, context);
                    break;
                default:
                    // Route was in the allowlist (so we *believed* it
                    // returned a spoilable DTO shape) but the runtime
                    // shape didn't match any case arm. Two common causes:
                    // (a) Jellyfin upgrade introduced a new wrapper shape,
                    // (b) controller's return changed signature
                    // (e.g. ActionResult<X> → Foo). Rate-limited so a hot
                    // route with the new shape doesn't spam logs — one
                    // warn per (Controller, Action, ValueType) per process
                    // lifetime via the resolver's rate-limit map.
                    var rv = context.ActionDescriptor.RouteValues;
                    var ctrl = rv != null && rv.TryGetValue("controller", out var c) ? c : "?";
                    var act = rv != null && rv.TryGetValue("action", out var a) ? a : "?";
                    _resolver.WarnRateLimited(
                        $"fieldstrip-unknown-shape:{ctrl}.{act}:{objectResult.Value.GetType().FullName}",
                        $"Spoiler Guard field strip: route {ctrl}.{act} returned shape {objectResult.Value.GetType().FullName} — no case arm matched, strip silently skipped. Likely a Jellyfin upgrade. Add a case arm in StripIfApplicable to cover this shape.");
                    break;
            }
        }

        /// <summary>What the host vouches for in this projection (its closed lists, the library's entities).</summary>
        internal PrivacyValueHost Host(Microsoft.AspNetCore.Http.HttpContext? http = null) => new(_libraryManager, _localization, http?.User);

        /// <summary>
        /// What Spoiler Guard reveals of a guarded item for this viewer: the parts whose strip the administrator or the
        /// viewer turned off (and, for an episode, its advanced-mode category).
        /// </summary>
        internal static PrivacyReveal Reveal(UserSpoilerBlur userState, PluginConfiguration cfg, BaseItemDto? item = null, CategoryReveal category = default, long? watchedThrough = null)
        {
            var replaceTitle = ShouldStrip(cfg.SpoilerReplaceTitle, userState.Prefs?.ReplaceEpisodeTitles) && !category.Title;
            var stripOverview = (item == null ? ShouldStrip(cfg.SpoilerStripOverview, userState.Prefs?.HideEpisodeDescriptions) : ShouldStripOverview(item, userState, cfg)) && !category.Overview;
            return new PrivacyReveal
            {
                Title = !replaceTitle,
                TitleFamily = !(replaceTitle || stripOverview),
                Overview = !stripOverview,
                Tags = !ShouldStrip(cfg.SpoilerStripTags, userState.Prefs?.HideTags),
                Taglines = !ShouldStrip(cfg.SpoilerStripTaglines, userState.Prefs?.HideTaglines),
                ChapterNames = !ShouldStrip(cfg.SpoilerStripChapters, userState.Prefs?.HideChapterNames),
                WatchedThrough = watchedThrough,
                Placeholder = SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder),
            };
        }

        // Extractor for /Items/{id}/Images: ImageInfo doesn't carry the item; the route's opened item is judged, and each
        // entry is rebuilt from validated values (no file path unless Spoiler Guard reveals its title family).
        private IEnumerable<MediaBrowser.Model.Dto.ImageInfo> StripImageInfos(
            IEnumerable<MediaBrowser.Model.Dto.ImageInfo> imgs,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            ActionContext context)
        {
            if (RouteVerdict(context, userState, userId) == null) return imgs;
            var reveal = Reveal(userState, cfg);
            var host = Host(context.HttpContext);
            return imgs.Select(info => info == null ? null! : PrivacyValues.Image(info, reveal, host)).ToList();
        }

        // Extractor for /Items/{id}/PlaybackInfo: the opened item's media sources rebuilt by the same rules as a guarded
        // item's own MediaSources (no path, a movie version's constructed label, validated stream values, no transport
        // headers).
        private void StripPlaybackInfo(
            MediaBrowser.Model.MediaInfo.PlaybackInfoResponse pbi,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            ActionContext context)
        {
            if (pbi.MediaSources == null) return;
            if (RouteVerdict(context, userState, userId) is not { } kind) return;
            var reveal = Reveal(userState, cfg);
            var host = Host(context.HttpContext);
            pbi.MediaSources = pbi.MediaSources.Select((ms, i) => ms == null ? null! : PrivacyValues.Source(ms, kind, reveal, host, i)).ToArray();
        }

        // The route's opened item (images, playback info): its kind when Spoiler Guard protects it for this viewer (the
        // one verdict, from the resolver's identity of that item), else null.
        private Jellyfin.Data.Enums.BaseItemKind? RouteVerdict(
            ActionContext context,
            UserSpoilerBlur userState,
            Guid userId)
        {
            try
            {
                var routeValues = context.HttpContext.Request.RouteValues;
                if (!routeValues.TryGetValue("itemId", out var idObj) || idObj == null)
                {
                    return null;
                }
                if (!Guid.TryParse(idObj.ToString(), out var itemId) || itemId == Guid.Empty)
                {
                    return null;
                }
                if (PrivacyIdentities.Resolve(_libraryManager, new[] { itemId }, context.HttpContext).GetValueOrDefault(itemId) is not { } identity) return null;
                return Protects(identity, userState, userId) ? identity.Kind : null;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-route-parent:" + ex.GetType().FullName,
                    $"Spoiler Guard field strip: parent-route lookup failed: {ex.Message}");
                // Fail CLOSED: better to over-strip than leak.
                return Jellyfin.Data.Enums.BaseItemKind.Episode;
            }
        }

        /// <summary>
        /// The one Spoiler Guard verdict for a resolved library item of ANY kind, asked by every site (DTOs, sessions,
        /// search hints, the opened item's images and playback info, activity rows): a series in scope; a movie or episode
        /// the viewer has not watched; a season after the first with no watched episode; an extra of a guarded title (a
        /// movie's follows the movie's watched state); nothing else (a collection, playlist, folder, person or programme is
        /// not a title Spoiler Guard guards). A site may pass what its own answer already says (the viewer's watched state,
        /// a season's number and counts).
        /// </summary>
        internal bool Protects(PrivacyIdentity identity, UserSpoilerBlur state, Guid userId, bool? played = null, int? seasonIndex = null, bool? seasonWatched = null)
        {
            if (!_resolver.InSpoilerScope(state, identity)) return false;
            switch (identity.Kind)
            {
                case Jellyfin.Data.Enums.BaseItemKind.Series:
                    return true;
                case Jellyfin.Data.Enums.BaseItemKind.Movie:
                case Jellyfin.Data.Enums.BaseItemKind.Episode:
                    return !(identity.Played ?? played ?? ResolvePlayedServerSide(userId, identity.ItemId));
                case Jellyfin.Data.Enums.BaseItemKind.Season:
                    var index = seasonIndex ?? (_libraryManager.GetItemById(identity.ItemId) as MediaBrowser.Controller.Entities.TV.Season)?.IndexNumber;
                    // Seasons 0 and 1 are the viewer's entry point.
                    if (index.GetValueOrDefault(int.MaxValue) <= 1) return false;
                    return !(seasonWatched ?? HasWatchedAnyEpisodeInSeasonServerSide(userId, identity.ItemId));
                default:
                    if (!identity.IsExtra) return false;
                    return !(identity.OwnerKind == Jellyfin.Data.Enums.BaseItemKind.Movie && (identity.Played ?? ResolvePlayedServerSide(userId, identity.OwnerId)));
            }
        }

        /// <summary>
        /// Replaces the watched state an answer's items carry (the host's, from when it built the answer) with the viewer's
        /// current one, for a projection the delivery gate asks for again; a folder's counts are dropped, so its verdict is
        /// read from the server.
        /// </summary>
        internal void RefreshUserData(Microsoft.AspNetCore.Mvc.ObjectResult result, Guid viewer)
        {
            var user = _userManager.GetUserById(viewer);
            if (user == null) return;
            NativeResponseValue.Replace(result, dto =>
            {
                if (dto.UserData == null || dto.Id == Guid.Empty || _libraryManager.GetItemById(dto.Id) is not { } item) return dto;
                var now = _userDataManager.GetUserData(user, item);
                dto.UserData.Played = now?.Played == true;
                dto.UserData.PlaybackPositionTicks = now?.PlaybackPositionTicks ?? 0;
                dto.UserData.PlayCount = now?.PlayCount ?? 0;
                dto.UserData.UnplayedItemCount = null;
                return dto;
            });
        }

        /// <summary>
        /// Applies the native watched/season/category rules with a freshly loaded presentation state, the item's ownership
        /// taken from its resolved identity. Returns what is delivered in the item's place (the rebuilt item when protected).
        /// </summary>
        internal BaseItemDto StripLibraryItem(BaseItemDto item, PrivacyIdentity? identity, UserSpoilerBlur state, PluginConfiguration config, Guid viewer)
            => StripItem(item, state, config, viewer, identity);

        // Per-item strip: returns what is delivered in the item's place (the item itself when Spoiler Guard does not
        // protect it, else the value walk's rebuilt item). With a resolved identity every decision (kind, owning title,
        // scope) comes from it; only an id the library cannot resolve falls back to the DTO.
        private BaseItemDto StripItem(BaseItemDto item, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId, PrivacyIdentity? identity = null)
        {
            if (item == null) return item!;
            if (identity != null)
            {
                return StripOwned(item, identity, userState, cfg, userId);
            }

            // Series path: when the item is the Series itself (Series detail
            // page = /Items/{seriesId}), strip cast / overview / tags / etc.
            // for the series-level DTO when the user has Spoiler Guard on
            // for it. Crucial for the Cast & Crew rail on series detail
            // pages —
            // an unexpected guest star or recurring villain on the series-
            // level cast is a major spoiler. No watched-state check (a
            // series doesn't have one), no Name rewrite (series titles are
            // OK to surface — it's the per-item plot detail that spoils).
            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Series)
            {
                if (item.Id == Guid.Empty) return item;
                if (!_resolver.IsSeriesInSpoilerScope(userState, item.Id, item.ProviderIds)) return item;
                // Mutate ImageTags so native client image caches refetch
                // on state change. Series has no per-watched semantics so
                // just hash the in-list state.
                MutateImageTagsForCacheBust(item, cfg, watched: false, playbackPositionTicks: 0);
                return ApplyStripping(item, userState, cfg, userId);
            }

            // BoxSet (Collection) DTOs pass through unstripped. The
            // collection itself is the entry point the user just clicked
            // (like Series); blurring its art/Overview would spoil the
            // user's own navigation. The collection toggle's effect is on
            // the MOVIES inside (handled in the Movie arm via
            // SpoilerUserResolver.IsMovieInSpoilerScope).

            // Movie path: a movie is in spoiler scope when either it's
            // directly opted in (Movies dict) OR it's a child of a
            // collection (BoxSet) the user has opted in (Collections dict).
            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Movie)
            {
                if (item.Id == Guid.Empty) return item;
                if (!_resolver.IsMovieInSpoilerScope(userState, item.Id, item.ProviderIds)) return item;
                bool moviePlayed;
                long moviePlayPos = 0;
                if (item.UserData != null)
                {
                    moviePlayed = item.UserData.Played;
                    moviePlayPos = item.UserData.PlaybackPositionTicks;
                }
                else
                {
                    moviePlayed = ResolvePlayedServerSide(userId, item.Id);
                }
                // Mutate ImageTags BEFORE the watched-skip. We want the
                // URL to flip on watched-state change so an already-cached
                // blurred image gets re-fetched once the user marks the
                // movie played.
                MutateImageTagsForCacheBust(item, cfg, moviePlayed, moviePlayPos);
                if (moviePlayed) return item;
                return ApplyStripping(item, userState, cfg, userId);
            }

            // Trailer / intro / special-feature DTOs from GetIntros /
            // GetLocalTrailers / GetSpecialFeatures routes
            // arrive with Type=Trailer/Video and would prior have early-
            // returned. If their SeriesId is in the user's spoiler list,
            // their Name/Overview/Path/MediaStreams can leak the parent
            // episode's title. Apply aggressive strip to be safe — these
            // DTOs are extras of an unwatched-spoiler episode.
            // Direct enum compare — faster than ToString("Episode") and
            // future-proof if Jellyfin renames any enum string forms.
            var isEpisodeOrSeason = item.Type == Jellyfin.Data.Enums.BaseItemKind.Episode
                || item.Type == Jellyfin.Data.Enums.BaseItemKind.Season;
            var isExtra = !isEpisodeOrSeason
                && item.SeriesId.HasValue
                && item.SeriesId.Value != Guid.Empty
                && _resolver.IsSeriesInSpoilerScope(userState, item.SeriesId.Value);
            if (!isEpisodeOrSeason && !isExtra) return item;

            if (isExtra)
            {
                // Extras (trailers / intros / specials) — we don't have a
                // per-extra watched flag; apply strip unconditionally
                // since the extra exists as part of an episode whose
                // very metadata the user has opted into hiding.
                MutateImageTagsForCacheBust(item, cfg, watched: false, playbackPositionTicks: 0);
                return ApplyStripping(item, userState, cfg, userId);
            }

            var seriesId = item.SeriesId;
            if (seriesId == null || seriesId.Value == Guid.Empty)
            {
                // Episode DTOs SHOULD always carry SeriesId. Silent return
                // on null hides a Jellyfin DTO-shape regression.
                if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Episode)
                {
                    _resolver.WarnRateLimited(
                        "fieldstrip-episode-no-seriesid",
                        $"Spoiler Guard field strip: Episode DTO {item.Id} has no SeriesId — strip cannot determine series membership. Possible Jellyfin DTO-shape change.");
                }
                return item;
            }
            if (!_resolver.IsSeriesInSpoilerScope(userState, seriesId.Value)) return item;

            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Season)
            {
                // Season DTOs leak Overview right next to a blurred Season
                // poster. Strip them too — but mirror the image filter's
                // "S1 always shows" + "any-played => pass-through" logic
                // so the user has an entry point.
                var sNum = item.IndexNumber.GetValueOrDefault(int.MaxValue);
                if (sNum <= 1) return item; // Season 0 (Specials) and Season 1 always pass.
                var seasonAnyWatched = SeasonWatched(item) ?? HasWatchedAnyEpisodeInSeasonServerSide(userId, item.Id);
                // Mutate ImageTags BEFORE the watched-skip so the URL
                // flips when the user starts the season.
                MutateImageTagsForCacheBust(item, cfg, seasonAnyWatched, playbackPositionTicks: 0);
                if (seasonAnyWatched) return item;
                return ApplyStripping(item, userState, cfg, userId);
            }

            // Episode path.
            // Prefer UserData.Played from the DTO; if absent (the client
            // passed enableUserData=false), fall back to IUserDataManager
            // server-side rather than fail-safe to "treat as played, skip
            // strip" — that bypass let lite clients receive full episode
            // metadata silently.
            var played = item.UserData?.Played ?? ResolvePlayedServerSide(userId, item.Id);
            // Same logic — mutate before watched-skip so the URL flips on
            // watched-state change. Episode has no
            // playback-position-affects-image (chapter rail belongs to the
            // movie path), so pass 0.
            MutateImageTagsForCacheBust(item, cfg, played, playbackPositionTicks: 0);
            if (played) return item;

            return ApplyStripping(item, userState, cfg, userId, ResolveCategoryReveal(item, userState, cfg, userId, seriesId.Value));
        }

        /// <summary>
        /// Whether a season DTO's own counts say the viewer has watched any of it (UserData.UnplayedItemCount below its
        /// RecursiveItemCount); null when the answer carries no counts (TvShows.GetSeasons omits them by default).
        /// </summary>
        private static bool? SeasonWatched(BaseItemDto item)
            => item.UserData is { UnplayedItemCount: { } unplayed } && item.RecursiveItemCount is { } total ? total > 0 && unplayed < total : null;

        /// <summary>
        /// The per-item rules for a library item whose ownership the identity resolver gave, by the one verdict
        /// (<see cref="Protects"/>) with what the item's own answer says (the viewer's watched state, a season's number and
        /// counts). Collections, folders and names pass through.
        /// </summary>
        private BaseItemDto StripOwned(BaseItemDto item, PrivacyIdentity identity, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId)
        {
            if (!_resolver.InSpoilerScope(userState, identity)) return item;
            var kind = identity.Kind;
            var season = kind == Jellyfin.Data.Enums.BaseItemKind.Season;
            if (!(kind is Jellyfin.Data.Enums.BaseItemKind.Series or Jellyfin.Data.Enums.BaseItemKind.Movie or Jellyfin.Data.Enums.BaseItemKind.Episode || season || identity.IsExtra)) return item;
            if (season && item.IndexNumber.GetValueOrDefault(int.MaxValue) <= 1) return item;
            var protects = Protects(identity, userState, userId, played: item.UserData?.Played, seasonIndex: season ? item.IndexNumber : null, seasonWatched: season ? SeasonWatched(item) : null);
            // Mutate the image tags BEFORE the watched-skip so a client's image cache refetches when the state flips.
            MutateImageTagsForCacheBust(item, cfg, !protects, kind == Jellyfin.Data.Enums.BaseItemKind.Movie ? item.UserData?.PlaybackPositionTicks ?? 0 : 0);
            if (!protects) return item;
            return ApplyStripping(item, userState, cfg, userId,
                kind == Jellyfin.Data.Enums.BaseItemKind.Episode ? ResolveCategoryReveal(item, userState, cfg, userId, identity.SeriesId) : default);
        }

        /// <summary>
        /// The strip for a title that isn't in the library (the native details facade answers it before
        /// this filter runs, so it calls this itself): what <see cref="StripItem"/> applies to the same
        /// kind for a viewer who guards the title and has watched none of it, with no reveal. Seasons 0
        /// and 1 pass, as in the library. Returns what is delivered in the item's place.
        /// </summary>
        /// <param name="item">The facade's DTO.</param>
        /// <param name="userState">The viewer's Spoiler Guard state.</param>
        /// <param name="cfg">Plugin configuration.</param>
        /// <param name="userId">The viewer.</param>
        internal BaseItemDto StripAbsent(BaseItemDto item, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId)
        {
            if (item == null) return item!;
            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Season && item.IndexNumber.GetValueOrDefault(int.MaxValue) <= 1) return item;
            return ApplyStripping(item, userState, cfg, userId);
        }

        /// <summary>
        /// What the strip leaves out of a not-in-library episode row (a native details season page's
        /// rows) for a viewer who guards the title: its title, overview and air date, by the same admin
        /// and per-user switches as <see cref="StripAbsent"/>.
        /// </summary>
        /// <param name="userState">The viewer's Spoiler Guard state.</param>
        /// <param name="cfg">Plugin configuration.</param>
        /// <returns>Title, overview and air date: true where the strip removes them.</returns>
        internal static (bool Title, bool Overview, bool AirDate) AbsentRowStrip(UserSpoilerBlur userState, PluginConfiguration cfg)
            => (ShouldStrip(cfg.SpoilerReplaceTitle, userState.Prefs?.ReplaceEpisodeTitles),
                ShouldStrip(cfg.SpoilerStripOverview, userState.Prefs?.HideEpisodeDescriptions),
                ShouldStrip(cfg.SpoilerStripPremiereDate, userState.Prefs?.HideAirDate));

        // Advanced-mode category reveal for an unwatched episode of a guarded
        // series. Gate order: admin master (SpoilerAdvancedMode), then the
        // user's per-user opt-out (UseAdvancedCategories == false restores the
        // uniform full strip), then boundary categorization. Every failure
        // path — no boundary, missing index numbers, specials — yields
        // CategoryReveal.None, i.e. the full strip.
        private CategoryReveal ResolveCategoryReveal(
            BaseItemDto item,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            Guid seriesId)
        {
            if (!cfg.SpoilerAdvancedMode) return CategoryReveal.None;
            if (userState.Prefs?.UseAdvancedCategories == false) return CategoryReveal.None;
            if (item.Type != Jellyfin.Data.Enums.BaseItemKind.Episode) return CategoryReveal.None;

            var boundary = _nextUnwatched.GetBoundary(userId, seriesId);
            var category = SpoilerNextUnwatchedService.Categorize(
                boundary, item.Id, item.ParentIndexNumber, item.IndexNumber);
            return category switch
            {
                SpoilerEpisodeCategory.NextEpisode => new CategoryReveal(
                    Title: !cfg.SpoilerNextEpisodeStripTitle,
                    Overview: !cfg.SpoilerNextEpisodeStripOverview,
                    Ratings: !cfg.SpoilerNextEpisodeStripRatings),
                SpoilerEpisodeCategory.CurrentSeason => new CategoryReveal(
                    Title: !cfg.SpoilerCurrentSeasonStripTitle,
                    Overview: !cfg.SpoilerCurrentSeasonStripOverview,
                    Ratings: !cfg.SpoilerCurrentSeasonStripRatings),
                _ => CategoryReveal.None,
            };
        }

        // A movie ID is "in spoiler scope" when either (a) it's directly
        // in the user's Movies dict, OR (b) it's a member of a BoxSet
        // (collection) the user has opted in. BoxSets are NOT direct
        // parents in Jellyfin's data model — they reference movies via
        // LinkedChildren.
        private bool ResolvePlayedServerSide(Guid userId, Guid itemId)
        {
            try
            {
                var jUser = _userManager.GetUserById(userId);
                // Both branches return false, but for DIFFERENT reasons.
                // When user/item are gone, "treat as unwatched → strip
                // applies" is the safe default (we'd rather strip a
                // non-existent ref than leak metadata).
                if (jUser == null) return false;
                var item = _libraryManager.GetItemById(itemId);
                if (item == null) return false;
                var ud = _userDataManager.GetUserData(jUser, item);
                return ud?.Played == true;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-resolveplayed:" + ex.GetType().FullName,
                    $"Spoiler Guard field strip: ResolvePlayedServerSide failed for item {itemId}: {ex.Message}");
                // Fail CLOSED: when we can't determine played-state and the
                // response would otherwise leak metadata, prefer the strip.
                // Better to show "Spoiler Guard activated" on a watched
                // episode (UX glitch) than leak the synopsis (privacy).
                return false;
            }
        }

        // Server-side fallback for the watched-through tick used by
        // progressive movie chapter strip. Returns long.MaxValue when the
        // movie is fully Played (so all chapters show); the raw
        // PlaybackPositionTicks otherwise; or null if neither could be
        // resolved (caller treats null as fail-CLOSED → strip all). Used
        // when the DTO's UserData is missing (enableUserData=false on
        // lite clients).
        private long? ResolveWatchedThroughTicksServerSide(Guid userId, Guid itemId)
        {
            try
            {
                var jUser = _userManager.GetUserById(userId);
                if (jUser == null) return null;
                var item = _libraryManager.GetItemById(itemId);
                if (item == null) return null;
                var ud = _userDataManager.GetUserData(jUser, item);
                if (ud == null) return null;
                if (ud.Played) return long.MaxValue;
                if (ud.PlaybackPositionTicks > 0) return ud.PlaybackPositionTicks;
                return null;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-resolvethroughticks:" + ex.GetType().FullName,
                    $"Spoiler Guard field strip: ResolveWatchedThroughTicksServerSide failed for item {itemId}: {ex.Message}");
                return null;
            }
        }

        // Server-side "has the user watched ANY episode in this season?"
        // probe. Used as a fallback when the Season DTO carries no
        // ItemCounts (TvShows.GetSeasons strips them by default unless
        // ?fields=ItemCounts is requested). Fail-closed on throw → return
        // false so strip applies (privacy > UX glitch).
        private bool HasWatchedAnyEpisodeInSeasonServerSide(Guid userId, Guid seasonId)
        {
            try
            {
                var jUser = _userManager.GetUserById(userId);
                if (jUser == null) return false;
                var seasonItem = _libraryManager.GetItemById(seasonId)
                    as MediaBrowser.Controller.Entities.TV.Season;
                if (seasonItem == null) return false;
                foreach (var ep in seasonItem.GetEpisodes(jUser, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false))
                {
                    if (ep == null) continue;
                    var ud = _userDataManager.GetUserData(jUser, ep);
                    if (ud?.Played == true) return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-seasonprobe:" + ex.GetType().FullName,
                    $"Spoiler Guard field strip: season any-watched probe failed for season {seasonId}: {ex.Message}");
                return false;
            }
        }

        private static readonly System.Text.RegularExpressions.Regex _htmlTagRe
            = new System.Text.RegularExpressions.Regex("<[^>]+>", System.Text.RegularExpressions.RegexOptions.Compiled);

        // Server-side sanitizer for the admin-supplied placeholder. The
        // configPage JS already strips tags + brackets on save, but an
        // admin who edited the XML config on disk would bypass that. Cap
        // length too — admin can't make a 1MB placeholder amplify every
        // response. Defense-in-depth: also strip HTML-entity sequences
        // (`&#60;` / `&lt;` etc.) so a future consumer that switches to
        // innerHTML doesn't materialize them as `<`.
        //
        // Scope: this sanitization is HTML-context defense only. It does
        // NOT defend a JS-eval consumer (hex-escape sequences survive
        // intact and are harmless in HTML context but would execute in a
        // JS-eval context). No JE consumer evals Overview today; if that
        // ever changes, the sanitizer must be re-evaluated.
        // Merge admin strip policy with optional per-user override. The admin
        // policy is the cap: a strip the admin has disabled is never re-enabled
        // by a user override (no client-side knob can broaden server-side
        // protection). When the admin has the strip enabled, the user can
        // opt OUT by setting their override to false.
        //   adminOn=false → never strip (admin gates the feature)
        //   adminOn=true, override=null → strip (default: follow admin)
        //   adminOn=true, override=false → don't strip (user opt-out)
        //   adminOn=true, override=true → strip (explicit user re-affirm)
        private static bool ShouldStrip(bool adminOn, bool? userOverride)
            => adminOn && (userOverride ?? true);

        // Series descriptions are independently configurable from episode,
        // season, movie, and extra descriptions. The generic ApplyStripping
        // path handles every guarded item kind, so choose the correct policy
        // before touching Overview instead of coupling Series back to the
        // legacy episode-description switch.
        private static bool ShouldStripOverview(
            BaseItemDto item,
            UserSpoilerBlur userState,
            PluginConfiguration cfg)
            => item.Type == Jellyfin.Data.Enums.BaseItemKind.Series
                ? ShouldStrip(
                    cfg.SpoilerStripSeriesOverview ?? cfg.SpoilerStripOverview,
                    userState.Prefs?.HideSeriesDescriptions)
                : ShouldStrip(cfg.SpoilerStripOverview, userState.Prefs?.HideEpisodeDescriptions);

        private static string SanitizePlaceholder(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return "Spoiler Guard activated";
            var trimmed = raw.Length > 200 ? raw.Substring(0, 200) : raw;
            var stripped = _htmlTagRe.Replace(trimmed, string.Empty)
                .Replace("<", string.Empty)
                .Replace(">", string.Empty)
                .Replace("\"", string.Empty)
                .Replace("'", string.Empty)
                .Replace("`", string.Empty)
                .Replace("&", string.Empty);
            return string.IsNullOrWhiteSpace(stripped) ? "Spoiler Guard activated" : stripped;
        }

        // Search hints ask the same verdict as every other site, for EVERY kind (an episode, a season, a movie, a series,
        // an extra): a hint whose item Spoiler Guard protects is rebuilt with a constructed name (an episode's or season's
        // neutral name; the library's own title for a kind whose title Spoiler Guard shows), the series' own name, no
        // matched term and only validated values. An id the library cannot resolve keeps its hint (Hidden Content and the
        // final gate judge those).
        private SearchHintResult StripSearchHints(SearchHintResult result, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId,
            IReadOnlyDictionary<Guid, PrivacyIdentity> identities)
        {
            if (result?.SearchHints == null) return result!;
            var reveal = Reveal(userState, cfg);
            var host = Host();
            var hints = new List<SearchHint>(result.SearchHints.Count);
            foreach (var hint in result.SearchHints)
            {
                if (hint == null || hint.Id == Guid.Empty || identities.GetValueOrDefault(hint.Id) is not { } identity
                    || !Protects(identity, userState, userId, seasonIndex: identity.Kind == Jellyfin.Data.Enums.BaseItemKind.Season ? hint.IndexNumber : null))
                {
                    hints.Add(hint!);
                    continue;
                }
                // Its name and series are the construction table's (an episode's or season's neutral name, an extra's kind).
                hints.Add(PrivacyValues.Hint(hint, identity, reveal, host));
            }
            return new SearchHintResult(hints.ToArray(), result.TotalRecordCount);
        }

        // Mutate the DTO's `ImageTags` so the URL the client constructs
        // differs whenever the user's spoiler-state for this item changes.
        // Native image caches (Glide, Coil, SDWebImage) cache strictly by
        // URL and routinely ignore Cache-Control: no-store. By tying the
        // tag to a state-hash, a watched-state flip immediately
        // invalidates the cached blurred image without the user having to
        // clear app cache.
        //
        // Called from EVERY StripItem branch (not just ApplyStripping)
        // because we want the cache-bust even when no field-strip toggles
        // are on — the user opted into Spoiler Guard, the image bytes
        // depend on watched-state, the URL must reflect that.

        public static void MutateImageTagsForCacheBust(
            BaseItemDto item,
            PluginConfiguration cfg,
            bool watched,
            long playbackPositionTicks)
        {
            if (item == null) return;
            var hasPrimaryTags = item.ImageTags != null && item.ImageTags.Count > 0;
            // Backdrops live in a SEPARATE BaseItemDto.BackdropImageTags string[]
            // (never in ImageTags), and are only re-served blurred when the admin
            // enabled SpoilerBlurArtwork — so only they need busting, and only then.
            var hasBackdropTags = cfg?.SpoilerBlurArtwork == true
                && item.BackdropImageTags != null && item.BackdropImageTags.Length > 0;
            if (!hasPrimaryTags && !hasBackdropTags) return;

            // Hash the inputs that affect blur OUTPUT bytes. Same shape
            // as the API's imageCacheToken so a client integrating with
            // the API ends up with the SAME URL as one that doesn't.
            var inputs = $"{item.Id:N}|{cfg?.SpoilerBlurEnabled == true}|{watched}|{cfg?.SpoilerBlurMode ?? "blur"}|{cfg?.SpoilerBlurIntensity ?? 40}|{cfg?.SpoilerBlurArtwork == true}|{cfg?.SpoilerKeepMoviePosters == true}|{playbackPositionTicks}";
            var token = ShortHash(inputs);

            // Prefix the existing tag rather than replace it — preserves
            // Jellyfin's own image-version semantics (tag changes when
            // image bytes change). Final URL: ?tag={our-token}-{jellyfin-tag}
            if (hasPrimaryTags)
            {
                var keys = item.ImageTags!.Keys.ToArray();
                foreach (var k in keys)
                {
                    var orig = item.ImageTags[k] ?? string.Empty;
                    if (!orig.StartsWith("sb-", StringComparison.Ordinal))
                    {
                        item.ImageTags[k] = "sb-" + token + "-" + orig;
                    }
                }
            }

            // Bust the backdrop tags too, or a native client keeps requesting
            // the pre-toggle backdrop URL (cached strictly by tag) and never
            // refetches the now-blurred bytes.
            if (hasBackdropTags)
            {
                for (var i = 0; i < item.BackdropImageTags!.Length; i++)
                {
                    var orig = item.BackdropImageTags[i] ?? string.Empty;
                    if (!orig.StartsWith("sb-", StringComparison.Ordinal))
                    {
                        item.BackdropImageTags[i] = "sb-" + token + "-" + orig;
                    }
                }
            }
        }

        // 8-hex-char SHA1 prefix. Sub-microsecond per call; fine for
        // 200-item batches.
        private static string ShortHash(string s)
        {
            using var sha = System.Security.Cryptography.SHA1.Create();
            var bytes = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(s));
            return Convert.ToHexString(bytes).Substring(0, 8).ToLowerInvariant();
        }

        // Field-stripping body: Spoiler Guard's per-switch strips of the item's non-text values (ratings, air date, the
        // cast it leaves out), then the value walk (PrivacyValues.Guarded) builds what is delivered: every retained string
        // constructed (the neutral name, the placeholder overview, "Chapter N", the library's own titles) or validated, the
        // parts a switch reveals kept (PrivacyReveal). All strip toggles default ON (strict-by-default posture, matching
        // PluginConfiguration.cs / configPage.html / the docs); an admin relaxes individual categories rather than opting
        // into them. Instance (was static) so it can call the server-side fallbacks when item.UserData is null
        // (enableUserData=false response shape).
        private BaseItemDto ApplyStripping(BaseItemDto item, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId, CategoryReveal reveal = default)
        {
            // Effective per-item toggles: the base admin+user decision, minus
            // any advanced-mode category reveal for this specific episode.
            // reveal is default(None) on every non-episode path and whenever
            // advanced mode is off, so these reduce to the base toggles.
            var stripRatings = ShouldStrip(cfg.SpoilerStripRatings, userState.Prefs?.HideRatings) && !reveal.Ratings;

            // Ratings — a 9.8/10 community rating or a critic rating on a
            // specific episode implies a major event. Both are covered by the
            // single SpoilerStripRatings toggle. On by default (admins can
            // relax it). Setting to null is the right call — empty/zero would
            // render as "0/10" in some clients.
            if (stripRatings)
            {
                item.CommunityRating = null;
                item.CriticRating = null;
            }

            // PremiereDate (air date) — a multi-month gap before an episode
            // can imply "season finale" / "long-anticipated reveal". On by
            // default (admins can relax it).
            if (ShouldStrip(cfg.SpoilerStripPremiereDate, userState.Prefs?.HideAirDate))
            {
                item.PremiereDate = null;
            }

            // Cast stripping. Two modes:
            //   - "GuestStars" (default when SpoilerStripCast on): drop only
            //     People whose Type matches the GuestStar enum value.
            //     Leaves the regular cast in place — they appear in every
            //     episode anyway, so they don't reveal anything new about
            //     this one.
            //   - "All": drop the entire People array. Strict mode for
            //     paranoid Spoiler Guard users; some shows leak via the
            //     regular cast appearing or not appearing in a given
            //     episode (e.g. a recurring villain return).
            // The kept people's roles (character names) go with the title strip, in the value walk.
            if (ShouldStrip(cfg.SpoilerStripCast, userState.Prefs?.HideCast) && item.People != null && item.People.Length > 0)
            {
                item.People = string.Equals(cfg.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase)
                    ? Array.Empty<BaseItemPerson>()
                    : item.People.Where(p => p != null && p.Type != Jellyfin.Data.Enums.PersonKind.GuestStar).ToArray();
            }

            // Chapters (names and thumbnails) — progressive for movies: chapters starting before the viewer's resume
            // point keep their names and images (the viewer has seen those scenes); a fully played movie shows them all.
            // Episodes are binary (watched or not), so every chapter is protected. Strict-less-than at the boundary: the
            // chapter that STARTS at the resume tick has not been watched yet.
            long? watchedThrough = null;
            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Movie && item.Chapters != null)
            {
                watchedThrough = item.UserData switch
                {
                    { Played: true } => long.MaxValue,
                    { PlaybackPositionTicks: > 0 } data => data.PlaybackPositionTicks,
                    null => ResolveWatchedThroughTicksServerSide(userId, item.Id),
                    _ => null,
                };
            }

            // Title replacement — "The Death of X" → "Season 2, Episode 6" for Episodes, "Season N" for Seasons, whatever
            // numbering the library has (NeutralNames); every name field of the protected item goes with it. Movie and
            // series titles are not Spoiler Guard's to hide: they come from the library's own item. When the title or the
            // overview strip is on, every other title-bearing value goes too (paths, stream/source/attachment titles,
            // roles, links): deny by default, a future field is assumed leaky until classified.
            return PrivacyValues.Guarded(item, Reveal(userState, cfg, item, reveal, watchedThrough), Host());
        }
    }
}
