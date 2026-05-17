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
    // is in the requesting user's spoiler-blur list.
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
        // Action-name table built from live observation on Jellyfin 10.11.x:
        // - /Items                        → Items.GetItems
        // - /Items?<filter>               → Items.GetItems (same)
        // - /Items/Resume                 → Items.GetResumeItems / GetResumeItemsLegacy
        // - /Items/{id}                   → UserLibrary.GetItem
        // - /Users/{uid}/Items/{id}       → UserLibrary.GetItemLegacy
        // - /Items/Latest                 → UserLibrary.GetLatestMedia / Legacy
        // - /Shows/{seriesId}/Episodes    → TvShows.GetEpisodes
        // - /Shows/{seriesId}/Seasons     → TvShows.GetSeasons
        // - /Shows/NextUp                 → TvShows.GetNextUp
        // - /Shows/Upcoming               → TvShows.GetUpcomingEpisodes
        // - /Shows/{seriesId}/Similar     → LibraryStructure / etc — covered by GetSimilar* if present
        // - /Items?<search>               → Items.GetItems with searchTerm
        // - /Search/Hints                 → Search.GetSearchHints
        // - /Users/{uid}/Suggestions      → Suggestions.GetSuggestions / Legacy
        private static readonly Dictionary<(string, string), bool> _routes
            = new()
            {
                { ("Items",       "GetItems"),               true },
                { ("Items",       "GetItemsByUserIdLegacy"), true },
                { ("Items",       "GetResumeItems"),         true },
                { ("Items",       "GetResumeItemsLegacy"),   true },
                { ("UserLibrary", "GetItem"),                true },
                { ("UserLibrary", "GetItemLegacy"),          true },
                { ("UserLibrary", "GetLatestMedia"),         true },
                { ("UserLibrary", "GetLatestMediaLegacy"),   true },
                // More UserLibrary endpoints that emit episode DTOs.
                { ("UserLibrary", "GetIntros"),              true },
                { ("UserLibrary", "GetIntrosLegacy"),        true },
                { ("UserLibrary", "GetLocalTrailers"),       true },
                { ("UserLibrary", "GetLocalTrailersLegacy"), true },
                { ("UserLibrary", "GetSpecialFeatures"),     true },
                { ("UserLibrary", "GetSpecialFeaturesLegacy"),true },
                { ("TvShows",     "GetEpisodes"),            true },
                { ("TvShows",     "GetSeasons"),             true },
                { ("TvShows",     "GetNextUp"),              true },
                { ("TvShows",     "GetUpcomingEpisodes"),    true },
                { ("Suggestions", "GetSuggestions"),         true },
                { ("Suggestions", "GetSuggestionsLegacy"),   true },
                { ("Search",      "GetSearchHints"),         true },
                // "More Like This" rail emits BaseItemDto[] including
                // episode-shaped items — strip those too.
                { ("Library",     "GetSimilarItems"),        true },
                { ("Library",     "GetSimilarShows"),        true },
                { ("Library",     "GetSimilarMovies"),       true },
                { ("Library",     "GetSimilarTrailers"),     true },
                { ("Library",     "GetSimilarAlbums"),       true },
                // /Items/{id}/Images returns IEnumerable<ImageInfo> whose
                // Path is the raw server filesystem path (commonly
                // contains the episode title in user-organized libraries).
                { ("Image",       "GetItemImageInfos"),      true },
                // /Items/{id}/PlaybackInfo returns
                // PlaybackInfoResponse{MediaSources: MediaSourceInfo[]}.
                // MediaSourceInfo carries the same title-bearing fields as
                // BaseItemDto.MediaSources (Path, Name, MediaStreams,
                // MediaAttachments) — emitted as a peer DTO not covered
                // by the BaseItemDto-shape strip. Both GET and POST
                // variants register here.
                { ("MediaInfo",   "GetPlaybackInfo"),        true },
                { ("MediaInfo",   "GetPostedPlaybackInfo"),  true },
                // Surfaces commonly hit by native clients (Streamyfin /
                // Findroid / Swiftfin / Jellyfin Android TV) that
                // previously bypassed the strip.
                //
                // Movies.GetMovieRecommendations powers the "Recommended for
                // You" rail on home screens — wraps BaseItemDto[] inside
                // a RecommendationDto, requires a custom switch arm.
                { ("Movies",      "GetMovieRecommendations"), true },
                // Playlists.GetPlaylistItems returns QueryResult<BaseItemDto>
                // — user-created playlists can include spoiler-list
                // episodes/movies (e.g. "Watch later"), so the items need
                // the same strip as a regular library list.
                { ("Playlists",   "GetPlaylistItems"),       true },
            };

        private readonly SpoilerUserResolver _resolver;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;

        public SpoilerFieldStripFilter(
            SpoilerUserResolver resolver,
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager)
        {
            _resolver = resolver;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
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
            // EVERY DTO whenever spoiler blur is enabled, so native-client
            // image caches re-fetch when the user flips watched-state or
            // toggles Spoiler Guard itself. ApplyStripping is internally
            // per-toggle gated, so when no strip toggle is on it's a no-op
            // past the cache-bust mutation.

            return RunFieldStripAsync(context, next, cfg);
        }

        private static bool IsTargetRoute(ActionExecutingContext context)
        {
            var rv = context.ActionDescriptor.RouteValues;
            if (rv == null) return false;
            if (!rv.TryGetValue("controller", out var controller) || controller == null) return false;
            if (!rv.TryGetValue("action", out var action) || action == null) return false;
            return _routes.ContainsKey((controller, action));
        }

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
            if (userState.Series.Count == 0 && userState.Movies.Count == 0 && userState.Collections.Count == 0)
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
                    $"Spoiler field strip: wrapped action threw — strip not applied. {executed.Exception.GetType().Name}: {executed.Exception.Message}");
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
                    $"Spoiler field strip failed: {ex.Message}");
            }
        }

        // Walks the action result and applies StripItem to every Episode
        // whose SeriesId is in the user's spoiler list AND whose
        // UserData.Played != true.
        private void StripIfApplicable(
            IActionResult? result,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            ActionExecutingContext context)
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
                    $"Spoiler field strip: action returned {result.GetType().Name}; strip is no-op for that shape. Likely a Jellyfin upgrade — switch to {result.GetType().Name}-aware extraction.");
                return;
            }
            if (objectResult.Value == null) return;

            switch (objectResult.Value)
            {
                case BaseItemDto single:
                    StripItem(single, userState, cfg, userId);
                    break;
                case QueryResult<BaseItemDto> qr:
                    if (qr.Items != null)
                    {
                        foreach (var item in qr.Items) StripItem(item, userState, cfg, userId);
                    }
                    break;
                case IEnumerable<BaseItemDto> seq:
                    // Many controllers (e.g. UserLibrary.GetLatestMedia,
                    // Items.GetItems via .Select projections) return a
                    // lazy LINQ Select iterator that materializes a NEW
                    // BaseItemDto on every enumeration. If we just
                    // iterate-and-mutate, MVC re-iterates at serialization
                    // time and gets a fresh unstripped DTO — our mutations
                    // are lost. Materialize and write back so MVC
                    // serializes our stripped copies.
                    var list = seq is List<BaseItemDto> alreadyList
                        ? alreadyList
                        : seq.ToList();
                    foreach (var item in list) StripItem(item, userState, cfg, userId);
                    if (!ReferenceEquals(list, seq))
                    {
                        objectResult.Value = list;
                    }
                    break;
                case SearchHintResult shr:
                    StripSearchHints(shr, userState, cfg, userId);
                    break;
                // ImageInfo[] from /Items/{id}/Images. Path is raw
                // filesystem. Look up the parent itemId from the route to
                // determine if its series is in the spoiler list.
                case IEnumerable<MediaBrowser.Model.Dto.ImageInfo> imgs:
                    StripImageInfos(imgs, userState, cfg, userId, context);
                    break;
                // Movies.GetMovieRecommendations returns a list of
                // RecommendationDto wrappers, each holding a
                // BaseItemDto[]. Walk both layers.
                case IEnumerable<MediaBrowser.Model.Dto.RecommendationDto> recs:
                    foreach (var rec in recs)
                    {
                        if (rec?.Items == null) continue;
                        foreach (var item in rec.Items) StripItem(item, userState, cfg, userId);
                    }
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
                        $"Spoiler field strip: route {ctrl}.{act} returned shape {objectResult.Value.GetType().FullName} — no case arm matched, strip silently skipped. Likely a Jellyfin upgrade. Add a case arm in StripIfApplicable to cover this shape.");
                    break;
            }
        }

        // Extractor for /Items/{id}/Images. ImageInfo doesn't carry
        // SeriesId, so we look up the parent item via the route's `itemId`
        // and check its series-list membership.
        private void StripImageInfos(
            IEnumerable<MediaBrowser.Model.Dto.ImageInfo> imgs,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            ActionExecutingContext context)
        {
            if (!RouteParentIsSpoilerEpisode(context, userState, userId)) return;
            if (!cfg.SpoilerReplaceTitle && !cfg.SpoilerStripOverview) return;

            foreach (var info in imgs)
            {
                if (info == null) continue;
                info.Path = null;
            }
        }

        // Extractor for /Items/{id}/PlaybackInfo. Walks
        // PlaybackInfoResponse.MediaSources and applies the same
        // MediaSourceInfo-level strip as ApplyStripping does for
        // BaseItemDto.MediaSources.
        private void StripPlaybackInfo(
            MediaBrowser.Model.MediaInfo.PlaybackInfoResponse pbi,
            UserSpoilerBlur userState,
            PluginConfiguration cfg,
            Guid userId,
            ActionExecutingContext context)
        {
            if (pbi.MediaSources == null) return;
            if (!RouteParentIsSpoilerEpisode(context, userState, userId)) return;
            if (!cfg.SpoilerReplaceTitle && !cfg.SpoilerStripOverview) return;

            foreach (var ms in pbi.MediaSources)
            {
                if (ms == null) continue;
                ms.Path = null;
                ms.Name = null;
                if (ms.MediaStreams != null)
                {
                    foreach (var s in ms.MediaStreams)
                    {
                        if (s == null) continue;
                        s.Title = null;
                        s.Comment = null;
                        s.Path = null;
                        s.DeliveryUrl = null;
                    }
                }
                if (ms.MediaAttachments != null)
                {
                    foreach (var att in ms.MediaAttachments)
                    {
                        if (att == null) continue;
                        att.FileName = null;
                        att.Comment = null;
                    }
                }
            }
        }

        // Look up the parent item from the route's itemId value and
        // confirm it's an Episode (or Season) of a spoiler-list series
        // the user hasn't watched.
        private bool RouteParentIsSpoilerEpisode(
            ActionExecutingContext context,
            UserSpoilerBlur userState,
            Guid userId)
        {
            try
            {
                var routeValues = context.HttpContext.Request.RouteValues;
                if (!routeValues.TryGetValue("itemId", out var idObj) || idObj == null)
                {
                    return false;
                }
                if (!Guid.TryParse(idObj.ToString(), out var itemId) || itemId == Guid.Empty)
                {
                    return false;
                }
                var parent = _libraryManager.GetItemById(itemId);
                if (parent == null) return false;

                Guid? seriesId = null;
                bool watchedCheck = true;
                // Movies path. Movie's spoiler-list membership is keyed
                // by movie ID (not by SeriesId), and watched-state is the
                // movie's own UserData.Played. Mirrors StripItem.
                if (parent is MediaBrowser.Controller.Entities.Movies.Movie movieParent)
                {
                    if (!IsMovieIdInSpoilerScope(userState, movieParent.Id)) return false;
                    if (ResolvePlayedServerSide(userId, itemId)) return false;
                    return true;
                }
                if (parent is MediaBrowser.Controller.Entities.TV.Episode ep)
                {
                    seriesId = ep.SeriesId;
                }
                else if (parent is MediaBrowser.Controller.Entities.TV.Season s)
                {
                    seriesId = s.SeriesId;
                    watchedCheck = false; // Season any-watched check is too costly here; over-strip.
                }
                else
                {
                    // Extras (Trailer / Video / Intro / etc.) attached to
                    // a spoiler-list series. Mirrors the isExtra path in
                    // StripItem. Use the BaseItem's SeriesId
                    // (`SeriesPresentationUniqueKey`-related — fall back
                    // to ParentId lookup if absent).
                    Guid extraSeriesId = Guid.Empty;
                    var hasSeriesProp = parent.GetType().GetProperty("SeriesId");
                    if (hasSeriesProp != null
                        && hasSeriesProp.GetValue(parent) is Guid sid
                        && sid != Guid.Empty)
                    {
                        extraSeriesId = sid;
                    }
                    else if (parent.ParentId != Guid.Empty)
                    {
                        // Walk up the parent chain until we find a Series.
                        var ancestor = _libraryManager.GetItemById(parent.ParentId);
                        var hops = 0;
                        while (ancestor != null && hops < 4)
                        {
                            if (ancestor is MediaBrowser.Controller.Entities.TV.Series ser)
                            {
                                extraSeriesId = ser.Id;
                                break;
                            }
                            if (ancestor.ParentId == Guid.Empty) break;
                            ancestor = _libraryManager.GetItemById(ancestor.ParentId);
                            hops++;
                        }
                    }
                    if (extraSeriesId == Guid.Empty) return false;
                    seriesId = extraSeriesId;
                    watchedCheck = false; // Extras have no per-extra watched flag — over-strip.
                }

                if (!seriesId.HasValue || seriesId.Value == Guid.Empty) return false;
                if (!userState.Series.ContainsKey(seriesId.Value.ToString("N"))) return false;

                if (watchedCheck && ResolvePlayedServerSide(userId, itemId)) return false;
                return true;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-route-parent:" + ex.GetType().FullName,
                    $"Spoiler field strip: parent-route lookup failed: {ex.Message}");
                // Fail CLOSED: better to over-strip than leak.
                return true;
            }
        }

        // Per-item strip. Only Episodes are eligible. Mutates `item` in
        // place when applicable; no-op otherwise.
        private void StripItem(BaseItemDto item, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId)
        {
            if (item == null) return;

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
                if (item.Id == Guid.Empty) return;
                if (!userState.Series.ContainsKey(item.Id.ToString("N"))) return;
                // Mutate ImageTags so native client image caches refetch
                // on state change. Series has no per-watched semantics so
                // just hash the in-list state.
                MutateImageTagsForCacheBust(item, cfg, watched: false, playbackPositionTicks: 0);
                ApplyStripping(item, cfg, userId);
                return;
            }

            // BoxSet (Collection) DTOs pass through unstripped. The
            // collection itself is the entry point the user just clicked
            // (like Series); blurring its art/Overview would spoil the
            // user's own navigation. The collection toggle's effect is on
            // the MOVIES inside (handled in the Movie arm via
            // IsMovieInSpoilerScope / IsMovieIdInSpoilerScope).

            // Movie path: a movie is in spoiler scope when either it's
            // directly opted in (Movies dict) OR it's a child of a
            // collection (BoxSet) the user has opted in (Collections dict).
            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Movie)
            {
                if (item.Id == Guid.Empty) return;
                if (!IsMovieIdInSpoilerScope(userState, item.Id)) return;
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
                if (moviePlayed) return;
                ApplyStripping(item, cfg, userId);
                return;
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
                && userState.Series.ContainsKey(item.SeriesId.Value.ToString("N"));
            if (!isEpisodeOrSeason && !isExtra) return;

            if (isExtra)
            {
                // Extras (trailers / intros / specials) — we don't have a
                // per-extra watched flag; apply strip unconditionally
                // since the extra exists as part of an episode whose
                // very metadata the user has opted into hiding.
                MutateImageTagsForCacheBust(item, cfg, watched: false, playbackPositionTicks: 0);
                ApplyStripping(item, cfg, userId);
                return;
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
                        $"Spoiler field strip: Episode DTO {item.Id} has no SeriesId — strip cannot determine series membership. Possible Jellyfin DTO-shape change.");
                }
                return;
            }
            if (!userState.Series.ContainsKey(seriesId.Value.ToString("N"))) return;

            if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Season)
            {
                // Season DTOs leak Overview right next to a blurred Season
                // poster. Strip them too — but mirror the image filter's
                // "S1 always shows" + "any-played => pass-through" logic
                // so the user has an entry point.
                var sNum = item.IndexNumber.GetValueOrDefault(int.MaxValue);
                if (sNum <= 1) return; // Season 0 (Specials) and Season 1 always pass.

                // UserData.UnplayedItemCount is the simplest "any watched?"
                // signal for a Season DTO. > 0 AND total > unplayed = some
                // watched. TvShows.GetSeasons does NOT include ItemCounts
                // in its default fields, so UserData on a Season DTO often
                // lacks UnplayedItemCount/RecursiveItemCount — fail-closed
                // would over-strip every S2+. Fall back to the server-side
                // helper that mirrors the image filter's logic
                // (HasWatchedAnyEpisodeInSeason via library iteration).
                bool seasonAnyWatched = false;
                if (item.UserData != null
                    && item.UserData.UnplayedItemCount.HasValue
                    && item.RecursiveItemCount.HasValue)
                {
                    var unplayed = item.UserData.UnplayedItemCount.Value;
                    var totalIndicator = item.RecursiveItemCount.Value;
                    if (totalIndicator > 0 && unplayed < totalIndicator) seasonAnyWatched = true;
                }
                else if (HasWatchedAnyEpisodeInSeasonServerSide(userId, item.Id))
                {
                    seasonAnyWatched = true;
                }
                // Mutate ImageTags BEFORE the watched-skip so the URL
                // flips when the user starts the season.
                MutateImageTagsForCacheBust(item, cfg, seasonAnyWatched, playbackPositionTicks: 0);
                if (seasonAnyWatched) return;
                ApplyStripping(item, cfg, userId);
                return;
            }

            // Episode path.
            // Prefer UserData.Played from the DTO; if absent (the client
            // passed enableUserData=false), fall back to IUserDataManager
            // server-side rather than fail-safe to "treat as played, skip
            // strip" — that bypass let lite clients receive full episode
            // metadata silently.
            bool played;
            if (item.UserData != null)
            {
                played = item.UserData.Played;
            }
            else
            {
                played = ResolvePlayedServerSide(userId, item.Id);
            }
            // Same logic — mutate before watched-skip so the URL flips on
            // watched-state change. Episode has no
            // playback-position-affects-image (chapter rail belongs to the
            // movie path), so pass 0.
            MutateImageTagsForCacheBust(item, cfg, played, playbackPositionTicks: 0);
            if (played) return;

            ApplyStripping(item, cfg, userId);
        }

        // A movie ID is "in spoiler scope" when either (a) it's directly
        // in the user's Movies dict, OR (b) it's a member of a BoxSet
        // (collection) the user has opted in. BoxSets are NOT direct
        // parents in Jellyfin's data model — they reference movies via
        // LinkedChildren.
        private bool IsMovieIdInSpoilerScope(UserSpoilerBlur userState, Guid movieId)
        {
            if (movieId == Guid.Empty) return false;
            if (userState.Movies.ContainsKey(movieId.ToString("N"))) return true;
            if (userState.Collections.Count == 0) return false;
            try
            {
                foreach (var collKeyN in userState.Collections.Keys)
                {
                    if (!Guid.TryParse(collKeyN, out var collGuid)) continue;
                    var bs = _libraryManager.GetItemById(collGuid)
                        as MediaBrowser.Controller.Entities.Movies.BoxSet;
                    if (bs == null) continue;
                    foreach (var child in bs.GetLinkedChildren())
                    {
                        if (child != null && child.Id == movieId) return true;
                    }
                }
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "fieldstrip-movie-collection:" + ex.GetType().FullName,
                    $"Spoiler field strip: IsMovieIdInSpoilerScope linked-children walk failed for {movieId}: {ex.Message}");
            }
            return false;
        }

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
                    $"Spoiler field strip: ResolvePlayedServerSide failed for item {itemId}: {ex.Message}");
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
                    $"Spoiler field strip: ResolveWatchedThroughTicksServerSide failed for item {itemId}: {ex.Message}");
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
                    $"Spoiler field strip: season any-watched probe failed for season {seasonId}: {ex.Message}");
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

        // SearchHintResult shape is different from BaseItemDto: each
        // SearchHint carries Id, Name, IndexNumber, ParentIndexNumber,
        // Type (BaseItemKind enum), Series (series-name string), but
        // NOT SeriesId. To check spoiler-list membership we have to look
        // up the actual item.
        //
        // We strip episode hints whose series is in the user's spoiler
        // list and that the user hasn't watched. Server-side, so all
        // clients benefit.
        private void StripSearchHints(SearchHintResult result, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId)
        {
            if (result?.SearchHints == null) return;

            foreach (var hint in result.SearchHints)
            {
                if (hint == null) continue;
                var isEpisodeHint = hint.Type == Jellyfin.Data.Enums.BaseItemKind.Episode;
                var isMovieHint = hint.Type == Jellyfin.Data.Enums.BaseItemKind.Movie;
                if (!isEpisodeHint && !isMovieHint) continue;
                if (hint.Id == Guid.Empty) continue;

                // Look up the actual item. For Episodes we need SeriesId
                // for spoiler-list membership; for Movies the hint.Id is
                // the movie ID directly. Lookup-throw fails-CLOSED.
                MediaBrowser.Controller.Entities.BaseItem? actualItem;
                try { actualItem = _libraryManager.GetItemById(hint.Id); }
                catch (Exception ex)
                {
                    _resolver.WarnRateLimited(
                        "searchhint-lookup:" + ex.GetType().FullName,
                        $"Spoiler field strip: SearchHint library lookup failed for {hint.Id}: {ex.Message}");
                    hint.Name = SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder);
                    hint.MatchedTerm = null;
                    continue;
                }

                if (isEpisodeHint)
                {
                    if (actualItem is not MediaBrowser.Controller.Entities.TV.Episode ep) continue;
                    if (ep.SeriesId == Guid.Empty) continue;
                    if (!userState.Series.ContainsKey(ep.SeriesId.ToString("N"))) continue;
                    if (ResolvePlayedServerSide(userId, hint.Id)) continue;

                    if (cfg.SpoilerReplaceTitle && hint.IndexNumber.HasValue && hint.ParentIndexNumber.HasValue)
                    {
                        hint.Name = $"Season {hint.ParentIndexNumber.Value}, Episode {hint.IndexNumber.Value}";
                    }
                    else if (cfg.SpoilerStripOverview)
                    {
                        hint.Name = SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder);
                    }
                }
                else
                {
                    // Movie hint path. Spoiler-list keyed by movie ID
                    // directly; watched check via the same server-side
                    // helper. Movie hint Name is NOT rewritten (MatchedTerm
                    // is still nulled below to suppress autocomplete
                    // substring leak of any non-title-bearing match).
                    if (actualItem is not MediaBrowser.Controller.Entities.Movies.Movie) continue;
                    if (!IsMovieIdInSpoilerScope(userState, hint.Id)) continue;
                    if (ResolvePlayedServerSide(userId, hint.Id)) continue;
                }

                // MatchedTerm echoes the substring of the ORIGINAL Name
                // that the search query matched — bypassing the Name
                // rewrite. e.g. user searches "Optimus" → MatchedTerm =
                // "Optimus" from the raw pre-strip title. Null it so
                // autocomplete doesn't surface the substring. Applies to
                // both Episode and Movie hints.
                hint.MatchedTerm = null;
            }
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
        // are on — the user opted into spoiler-blur, the image bytes
        // depend on watched-state, the URL must reflect that.
        public static void MutateImageTagsForCacheBust(
            BaseItemDto item,
            PluginConfiguration cfg,
            bool watched,
            long playbackPositionTicks)
        {
            if (item?.ImageTags == null || item.ImageTags.Count == 0) return;

            // Hash the inputs that affect blur OUTPUT bytes. Same shape
            // as the API's imageCacheToken so a client integrating with
            // the API ends up with the SAME URL as one that doesn't.
            var inputs = $"{item.Id:N}|{cfg?.SpoilerBlurEnabled == true}|{watched}|{cfg?.SpoilerBlurMode ?? "blur"}|{cfg?.SpoilerBlurIntensity ?? 40}|{cfg?.SpoilerBlurArtwork == true}|{playbackPositionTicks}";
            var token = ShortHash(inputs);

            // Prefix the existing tag rather than replace it — preserves
            // Jellyfin's own image-version semantics (tag changes when
            // image bytes change). Final URL: ?tag={our-token}-{jellyfin-tag}
            var keys = item.ImageTags.Keys.ToArray();
            foreach (var k in keys)
            {
                var orig = item.ImageTags[k] ?? string.Empty;
                if (!orig.StartsWith("sb-", StringComparison.Ordinal))
                {
                    item.ImageTags[k] = "sb-" + token + "-" + orig;
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

        // Field-stripping body. Each block is gated on its own admin
        // toggle; toggles default ON for Overview / Tags / Chapters /
        // Taglines (the four highest-risk-leak-vs-lowest-UX-cost fields)
        // and OFF for everything else.
        // Instance (was static) so it can call the server-side fallback
        // for PlaybackPositionTicks when item.UserData is null
        // (enableUserData=false response shape). The userId arg is used
        // only by that fallback path.
        private void ApplyStripping(BaseItemDto item, PluginConfiguration cfg, Guid userId)
        {
            // Overview (episode synopsis) — single biggest spoiler vector.
            // Replace with the admin-configured placeholder so clients
            // don't render an empty "Description" header. We *replace*
            // rather than null because a literal null causes some clients
            // to fall back to the series description, which can also leak
            // ("the season everyone dies").
            //
            // Defense-in-depth: sanitize the placeholder server-side
            // even though the configPage save handler also strips tags.
            // Defends against a config XML that was edited directly on
            // disk bypassing the JS save path.
            if (cfg.SpoilerStripOverview && !string.IsNullOrEmpty(item.Overview))
            {
                item.Overview = SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder);
            }

            // Tags — TMDB tags often contain spoiler phrases like
            // "Death of a main character" or "Wedding". Empty array
            // (not null) matches what Jellyfin returns for an item
            // legitimately without tags.
            if (cfg.SpoilerStripTags && item.Tags != null && item.Tags.Length > 0)
            {
                item.Tags = Array.Empty<string>();
            }

            // Chapter NAMES — a chapter named "X reveals Y" is a major
            // spoiler. Strip the name but KEEP the timestamp (StartPositionTicks)
            // so the player's seek bar still shows the chapter divider; the
            // user can navigate via timestamp without the spoiler text.
            //
            // Progressive-strip for Movies: only strip chapters whose
            // StartPositionTicks is AFTER the user's current playback
            // position. Already-watched chapters retain their names so a
            // half-finished movie shows scene names + thumbnails up to the
            // user's resume point, then hides everything after. For
            // Episodes (binary watched/unwatched semantics) the full strip
            // still applies — no "half-watched" episode mode.
            if (cfg.SpoilerStripChapters && item.Chapters != null)
            {
                long? watchedThroughTicks = null;
                if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Movie)
                {
                    if (item.UserData != null)
                    {
                        // PlaybackPositionTicks reflects the resume point.
                        // When the movie is fully Played, treat as watched
                        // through End so all chapter names show.
                        if (item.UserData.Played)
                        {
                            watchedThroughTicks = long.MaxValue;
                        }
                        else if (item.UserData.PlaybackPositionTicks > 0)
                        {
                            watchedThroughTicks = item.UserData.PlaybackPositionTicks;
                        }
                    }
                    else
                    {
                        // UserData omitted (lite client with
                        // enableUserData=false). Server-side fallback so a
                        // half-watched movie still shows pre-resume-point
                        // chapter names instead of stripping all of them.
                        watchedThroughTicks = ResolveWatchedThroughTicksServerSide(userId, item.Id);
                    }
                }

                int chapterNumber = 0;
                foreach (var ch in item.Chapters)
                {
                    if (ch == null) continue;
                    chapterNumber++;
                    // Strict-less-than. At the exact resume boundary, the
                    // chapter that STARTS at that tick has not been
                    // watched yet — its name is still a future spoiler.
                    // Use `<` so the current chapter is hidden until
                    // playback advances past its start.
                    if (watchedThroughTicks.HasValue
                        && ch.StartPositionTicks < watchedThroughTicks.Value)
                    {
                        // Pre-resume-point chapter — keep its name and
                        // ImagePath visible.
                        continue;
                    }
                    // Replace with a generic number rather than null.
                    // Some Jellyfin clients render `null` Name as the
                    // literal string "undefined" (web client's chapter
                    // rail observed). "Chapter N" gives the user a stable
                    // label without leaking the original spoilery name.
                    ch.Name = $"Chapter {chapterNumber}";
                }
            }

            // Taglines — TMDB taglines like "Everything changes tonight"
            // are pure spoiler bait. Empty array, same reasoning as Tags.
            if (cfg.SpoilerStripTaglines && item.Taglines != null)
            {
                item.Taglines = Array.Empty<string>();
            }

            // CommunityRating — a 9.8/10 rating on a specific episode
            // implies a major event. Off by default; opt-in for users who
            // find ratings spoiler-y. Setting to null is the right call —
            // empty/zero would render as "0/10" in some clients.
            if (cfg.SpoilerStripCommunityRating)
            {
                item.CommunityRating = null;
            }

            // CriticRating — same rationale.
            if (cfg.SpoilerStripCriticRating)
            {
                item.CriticRating = null;
            }

            // PremiereDate (air date) — a multi-month gap before an episode
            // can imply "season finale" / "long-anticipated reveal". Strict
            // mode users opt in. Clearing this also helps with calendar
            // surfaces that show "airs on YYYY-MM-DD" — though those
            // surfaces are mostly unaired (i.e. the user has no chance to
            // watch yet) and would not be in the spoiler list anyway.
            if (cfg.SpoilerStripPremiereDate)
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
            // Always uses BaseItemPerson.Type string comparison so we don't
            // pull in a hard reference to PersonKind enum from elsewhere.
            if (cfg.SpoilerStripCast && item.People != null && item.People.Length > 0)
            {
                if (string.Equals(cfg.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase))
                {
                    item.People = Array.Empty<BaseItemPerson>();
                }
                else
                {
                    // GuestStars-only mode (default). Pre-scan for any
                    // GuestStar entry before allocating — avoids list
                    // allocation on every cast-bearing item when no
                    // GuestStars are present (typical for cartoon series).
                    bool hasGuest = false;
                    foreach (var p in item.People)
                    {
                        if (p != null && p.Type == Jellyfin.Data.Enums.PersonKind.GuestStar)
                        {
                            hasGuest = true;
                            break;
                        }
                    }
                    if (hasGuest)
                    {
                        var kept = new List<BaseItemPerson>(item.People.Length);
                        foreach (var p in item.People)
                        {
                            if (p == null) continue;
                            if (p.Type == Jellyfin.Data.Enums.PersonKind.GuestStar) continue;
                            kept.Add(p);
                        }
                        item.People = kept.ToArray();
                    }
                }
            }

            // Title replacement — "The Death of X" → "Season 2, Episode 6"
            // for Episodes; for Seasons, replace with "Season N" only when
            // IndexNumber is set. Off by default because some clients use
            // Name in navigation tooltips, breadcrumbs, and "now playing"
            // overlays where the synthesized title can look jarring.
            if (cfg.SpoilerReplaceTitle)
            {
                if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Episode
                    && item.IndexNumber.HasValue
                    && item.ParentIndexNumber.HasValue)
                {
                    item.Name = $"Season {item.ParentIndexNumber.Value}, Episode {item.IndexNumber.Value}";
                    item.SortName = null;
                    item.OriginalTitle = null;
                }
                else if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Season
                    && item.IndexNumber.HasValue)
                {
                    item.Name = $"Season {item.IndexNumber.Value}";
                    item.SortName = null;
                    item.OriginalTitle = null;
                }
                // Movie titles intentionally NOT rewritten — the movie
                // title is OK to surface (it's already in URLs / library
                // nav anyway), only the synopsis / chapter / cast /
                // artwork content needs spoiler treatment for movies.
            }

            // When title replacement OR overview strip is on, aggressively
            // sanitize ALL title-bearing fields. The BaseItemDto has many
            // nested surfaces that can leak the episode title in practice
            // (MediaSources[].Path → tag-cache StreamData → /Items
            // endpoint MediaStreams → nested MediaSources MediaStreams →
            // MediaAttachments → RemoteTrailers → People[].Role →
            // ChapterInfo.ImagePath → EpisodeTitle / ...). Treat this as
            // deny-by-default: aggressively null every field that COULD
            // carry the episode title. Future BaseItemDto fields added by
            // Jellyfin must be assumed-leaky until proven otherwise.
            if (cfg.SpoilerReplaceTitle || cfg.SpoilerStripOverview)
            {
                // Top-level title-bearing string fields.
                if (!string.IsNullOrEmpty(item.Path)) item.Path = null;
                item.EpisodeTitle = null;
                item.ForcedSortName = null;
                item.CustomRating = null;

                // External link arrays whose Url slug or Name commonly
                // contains the episode title.
                item.RemoteTrailers = null;
                item.ExternalUrls = null;

                // Top-level + nested MediaStreams + MediaAttachments.
                // ffprobe Title / Comment / attachment FileName all
                // routinely carry the episode title on user-muxed mkvs.
                if (item.MediaStreams != null)
                {
                    foreach (var s in item.MediaStreams)
                    {
                        if (s == null) continue;
                        s.Title = null;
                        s.Comment = null;
                        // External subtitle / audio stream filenames
                        // mirror the episode title ("S05E14 - The Death
                        // of X.en.srt"). Path is the raw filesystem path;
                        // DeliveryUrl is the public download URL — both
                        // leak.
                        s.Path = null;
                        s.DeliveryUrl = null;
                        // DisplayTitle is a read-only getter on the
                        // MediaStream entity that derives from Title;
                        // nulling Title sanitizes it transitively.
                    }
                }
                if (item.MediaSources != null)
                {
                    foreach (var ms in item.MediaSources)
                    {
                        if (ms == null) continue;
                        ms.Path = null;
                        ms.Name = null;
                        // MediaSources nests its OWN MediaStreams array
                        // (separate from BaseItemDto.MediaStreams). Strip
                        // it too.
                        if (ms.MediaStreams != null)
                        {
                            foreach (var s in ms.MediaStreams)
                            {
                                if (s == null) continue;
                                s.Title = null;
                                s.Comment = null;
                                // External file paths / delivery URLs
                                // leak just like the top-level streams.
                                s.Path = null;
                                s.DeliveryUrl = null;
                            }
                        }
                        // mkv attachments (chapters_*.xml, subtitle_*.srt)
                        // frequently embed the episode title in FileName /
                        // Comment.
                        if (ms.MediaAttachments != null)
                        {
                            foreach (var att in ms.MediaAttachments)
                            {
                                if (att == null) continue;
                                att.FileName = null;
                                att.Comment = null;
                            }
                        }
                    }
                }

                // People[].Role (the character name) is an episode-level
                // spoiler regardless of cast strip mode. The cast strip
                // toggles drop the array entirely or filter GuestStars; in
                // BOTH cases this loop is a no-op (kept people are
                // removed elsewhere) or strips Role on the remaining
                // People to plug "recurring villain in role 'Resurrected
                // Optimus'" leaks.
                if (item.People != null)
                {
                    foreach (var p in item.People)
                    {
                        if (p == null) continue;
                        p.Role = null;
                    }
                }

                // ChapterInfo.ImagePath leaks server filesystem path.
                // Strip whenever title-strip is on, BUT respect the same
                // progressive-strip carve-out for movies — already-watched
                // chapter thumbnails stay visible (the user already saw
                // those scenes).
                if (item.Chapters != null)
                {
                    long? watchedThroughTicksForImg = null;
                    if (item.Type == Jellyfin.Data.Enums.BaseItemKind.Movie)
                    {
                        if (item.UserData != null)
                        {
                            if (item.UserData.Played) watchedThroughTicksForImg = long.MaxValue;
                            else if (item.UserData.PlaybackPositionTicks > 0)
                                watchedThroughTicksForImg = item.UserData.PlaybackPositionTicks;
                        }
                        else
                        {
                            // Server-side fallback.
                            watchedThroughTicksForImg = ResolveWatchedThroughTicksServerSide(userId, item.Id);
                        }
                    }
                    foreach (var ch in item.Chapters)
                    {
                        if (ch == null) continue;
                        // Strict-less-than (boundary).
                        if (watchedThroughTicksForImg.HasValue
                            && ch.StartPositionTicks < watchedThroughTicksForImg.Value)
                        {
                            continue;
                        }
                        ch.ImagePath = null;
                    }
                }
            }
        }

    }
}
