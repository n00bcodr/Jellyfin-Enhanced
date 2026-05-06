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
                // R4-H4: more UserLibrary endpoints that emit episode DTOs.
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
                // R4-H4: "More Like This" rail emits BaseItemDto[] including
                // episode-shaped items — strip those too.
                { ("Library",     "GetSimilarItems"),        true },
                { ("Library",     "GetSimilarShows"),        true },
                { ("Library",     "GetSimilarMovies"),       true },
                { ("Library",     "GetSimilarTrailers"),     true },
                { ("Library",     "GetSimilarAlbums"),       true },
            };

        private readonly SpoilerUserResolver _resolver;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly Logger _logger;

        public SpoilerFieldStripFilter(
            SpoilerUserResolver resolver,
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            Logger logger)
        {
            _resolver = resolver;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _logger = logger;
        }

        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // Diagnostic: uncomment to log every controller/action this
            // filter sees on item-listing routes. Used to discover the
            // real route-value mappings (e.g. UserLibrary.GetItemLegacy
            // for /Users/{uid}/Items/{id}). Kept commented for future
            // route-discovery work — the route table above was built
            // from this output.
            //
            // var rv = context.ActionDescriptor.RouteValues;
            // string ctrl = "(none)", act = "(none)";
            // if (rv != null)
            // {
            //     if (rv.TryGetValue("controller", out var c) && c != null) ctrl = c;
            //     if (rv.TryGetValue("action", out var a) && a != null) act = a;
            // }
            // var path = context.HttpContext.Request.Path.Value ?? "";
            // if (!path.Contains("/Images/") &&
            //     (path.Contains("/Items") || path.Contains("/Shows")
            //      || path.Contains("/Suggestions") || path.Contains("/Search")))
            // {
            //     _logger.Info($"[fieldstrip-diag] path={path} controller={ctrl} action={act}");
            // }

            // Sync fast-path bail order — three short-circuit checks before
            // we touch anything expensive. Returns the original Task<>
            // unchanged so non-matching routes pay zero overhead.
            if (!IsTargetRoute(context)) return next();

            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerBlurEnabled != true) return next();
            if (!AnyStripToggleOn(cfg)) return next();

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

        private static bool AnyStripToggleOn(PluginConfiguration cfg)
        {
            return cfg.SpoilerStripOverview
                || cfg.SpoilerStripTags
                || cfg.SpoilerStripChapters
                || cfg.SpoilerStripTaglines
                || cfg.SpoilerStripCommunityRating
                || cfg.SpoilerStripCriticRating
                || cfg.SpoilerStripPremiereDate
                || cfg.SpoilerReplaceTitle
                || cfg.SpoilerStripCast;
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
            if (userState.Series.Count == 0)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            // R4-L5: surface (rate-limited) when the wrapped action threw —
            // strip silently skipped and operator can correlate "Overview
            // leaked but my toggle is on" reports with the underlying
            // controller exception.
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
                StripIfApplicable(executed.Result, userState, cfg, userId);
            }
            catch (Exception ex)
            {
                // R5-L1: rate-limit so a persistent strip bug on a 100-item
                // batch doesn't produce 100 log lines. Pattern matches the
                // rest of the filter (resolver.WarnRateLimited keyed by
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
            Guid userId)
        {
            // R4-M4 + R5-H2: ObjectResult covers most MVC return shapes,
            // but JsonResult / ContentResult / custom IActionResult are
            // siblings (not subclasses). Generalize: log any non-null,
            // non-ObjectResult shape with the type name as the rate-
            // limit key so a future Jellyfin upgrade is observable.
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
                    foreach (var item in seq) StripItem(item, userState, cfg, userId);
                    break;
                case SearchHintResult shr:
                    StripSearchHints(shr, userState, cfg, userId);
                    break;
            }
        }

        // Per-item strip. Only Episodes are eligible. Mutates `item` in
        // place when applicable; no-op otherwise.
        private void StripItem(BaseItemDto item, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId)
        {
            if (item == null) return;

            // R10-codex: trailer / intro / special-feature DTOs from
            // GetIntros / GetLocalTrailers / GetSpecialFeatures routes
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
                ApplyStripping(item, cfg);
                return;
            }

            var seriesId = item.SeriesId;
            if (seriesId == null || seriesId.Value == Guid.Empty)
            {
                // R5-M1: Episode DTOs SHOULD always carry SeriesId.
                // Silent return on null hides a Jellyfin DTO-shape regression.
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
                // R4-H5: Season DTOs leak Overview right next to a blurred
                // Season poster. Strip them too — but mirror the image
                // filter's "S1 always shows" + "any-played => pass-through"
                // logic so the user has an entry point.
                var sNum = item.IndexNumber.GetValueOrDefault(int.MaxValue);
                if (sNum <= 1) return; // Season 0 (Specials) and Season 1 always pass.

                // UserData.UnplayedItemCount is the simplest "any watched?"
                // signal for a Season DTO. > 0 AND total > unplayed = some
                // watched. R5-M6: TvShows.GetSeasons does NOT include
                // ItemCounts in its default fields, so UserData on a Season
                // DTO often lacks UnplayedItemCount/RecursiveItemCount —
                // fail-closed would over-strip every S2+. Fall back to the
                // server-side helper that mirrors the image filter's logic
                // (HasWatchedAnyEpisodeInSeason via library iteration).
                if (item.UserData != null
                    && item.UserData.UnplayedItemCount.HasValue
                    && item.RecursiveItemCount.HasValue)
                {
                    var unplayed = item.UserData.UnplayedItemCount.Value;
                    var totalIndicator = item.RecursiveItemCount.Value;
                    if (totalIndicator > 0 && unplayed < totalIndicator) return; // some watched
                }
                else if (HasWatchedAnyEpisodeInSeasonServerSide(userId, item.Id))
                {
                    return; // some watched — fall through to no-strip
                }
                ApplyStripping(item, cfg);
                return;
            }

            // Episode path.
            // R4-C1: prefer UserData.Played from the DTO; if absent (the
            // client passed enableUserData=false), fall back to
            // IUserDataManager server-side rather than fail-safe to
            // "treat as played, skip strip" — that bypass let lite
            // clients receive full episode metadata silently.
            bool played;
            if (item.UserData != null)
            {
                played = item.UserData.Played;
            }
            else
            {
                played = ResolvePlayedServerSide(userId, item.Id);
            }
            if (played) return;

            ApplyStripping(item, cfg);
        }

        // R4-C1: server-side fallback when the response shape omits UserData.
        // Checked exception types so a transient lookup failure doesn't kill
        // the whole strip.
        private bool ResolvePlayedServerSide(Guid userId, Guid itemId)
        {
            try
            {
                var jUser = _userManager.GetUserById(userId);
                // R5-H4: comment-vs-code mismatch fixed — both branches
                // return false, but for DIFFERENT reasons. When user/item
                // are gone, "treat as unwatched → strip applies" is the
                // safe default (we'd rather strip a non-existent ref than
                // leak metadata).
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
                // Better to show "Spoiler mode activated" on a watched
                // episode (UX glitch) than leak the synopsis (privacy).
                return false;
            }
        }

        // R5-M6: server-side "has the user watched ANY episode in this
        // season?" probe. Used as a fallback when the Season DTO carries
        // no ItemCounts (TvShows.GetSeasons strips them by default unless
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

        // R4-M1 + R5-L8: server-side sanitizer for the admin-supplied placeholder.
        // The configPage JS already strips tags + brackets on save, but
        // an admin who edited the XML config on disk would bypass that.
        // Cap length too — admin can't make a 1MB placeholder amplify
        // every response. Defense-in-depth: also strip HTML-entity
        // sequences (`&#60;` / `&lt;` etc.) so a future consumer that
        // switches to innerHTML doesn't materialize them as `<`.
        //
        // R6-L4 scope: this sanitization is HTML-context defense only.
        // It does NOT defend a JS-eval consumer (hex-escape sequences
        // survive intact and are harmless in HTML context but would
        // execute in a JS-eval context). No JE consumer evals Overview
        // today; if that ever changes, the sanitizer must be re-evaluated.
        private static string SanitizePlaceholder(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return "Spoiler mode activated";
            var trimmed = raw.Length > 200 ? raw.Substring(0, 200) : raw;
            var stripped = _htmlTagRe.Replace(trimmed, string.Empty)
                .Replace("<", string.Empty)
                .Replace(">", string.Empty)
                .Replace("\"", string.Empty)
                .Replace("'", string.Empty)
                .Replace("`", string.Empty)
                .Replace("&", string.Empty);
            return string.IsNullOrWhiteSpace(stripped) ? "Spoiler mode activated" : stripped;
        }

        // SearchHintResult shape is different from BaseItemDto: each
        // SearchHint carries Id, Name, IndexNumber, ParentIndexNumber,
        // Type (BaseItemKind enum), Series (series-name string), but
        // NOT SeriesId. To check spoiler-list membership we have to look
        // up the actual item.
        //
        // We strip episode hints whose series is in the user's spoiler
        // list and that the user hasn't watched. Server-side, so all
        // clients benefit. R4-H2.
        private void StripSearchHints(SearchHintResult result, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId)
        {
            if (result?.SearchHints == null) return;

            foreach (var hint in result.SearchHints)
            {
                if (hint == null) continue;
                if (hint.Type != Jellyfin.Data.Enums.BaseItemKind.Episode) continue;
                if (hint.Id == Guid.Empty) continue;

                // Look up the actual item to get SeriesId; cheap in-memory.
                // R5-H1: when the lookup throws (transient DB hiccup,
                // ObjectDisposedException during shutdown, etc.) the prior
                // `continue` left the hint UNSTRIPPED — fail-OPEN. Mirror
                // ResolvePlayedServerSide and fail-CLOSED: rate-limited
                // warn + sanitize the hint name before continuing so the
                // spoilery title doesn't leak through autocomplete.
                MediaBrowser.Controller.Entities.BaseItem? actualItem;
                try { actualItem = _libraryManager.GetItemById(hint.Id); }
                catch (Exception ex)
                {
                    _resolver.WarnRateLimited(
                        "searchhint-lookup:" + ex.GetType().FullName,
                        $"Spoiler field strip: SearchHint library lookup failed for {hint.Id}: {ex.Message}");
                    hint.Name = SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder);
                    continue;
                }
                if (actualItem is not MediaBrowser.Controller.Entities.TV.Episode ep) continue;
                if (ep.SeriesId == Guid.Empty) continue;
                if (!userState.Series.ContainsKey(ep.SeriesId.ToString("N"))) continue;

                if (ResolvePlayedServerSide(userId, hint.Id)) continue;

                // Replace the title — SearchHints don't expose Overview / Tags
                // so the title rewrite is the main spoiler vector here.
                if (cfg.SpoilerReplaceTitle && hint.IndexNumber.HasValue && hint.ParentIndexNumber.HasValue)
                {
                    hint.Name = $"Season {hint.ParentIndexNumber.Value}, Episode {hint.IndexNumber.Value}";
                }
                else if (cfg.SpoilerStripOverview)
                {
                    // Even when SpoilerReplaceTitle is off, the existing
                    // SpoilerStripOverview toggle implies "I want spoilers
                    // hidden" — replace the search-result name with the
                    // placeholder so spoilery titles like "The Death of X"
                    // don't appear in autocomplete.
                    hint.Name = SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder);
                }

                // R10-M3: MatchedTerm echoes the substring of the
                // ORIGINAL Name that the search query matched —
                // bypassing the Name rewrite. e.g. user searches
                // "Optimus" → MatchedTerm = "Optimus" from the raw
                // pre-strip title. Null it so autocomplete doesn't
                // surface the substring.
                hint.MatchedTerm = null;
            }
        }

        // Field-stripping body. Each block is gated on its own admin
        // toggle; toggles default ON for Overview / Tags / Chapters /
        // Taglines (the four highest-risk-leak-vs-lowest-UX-cost fields)
        // and OFF for everything else.
        private static void ApplyStripping(BaseItemDto item, PluginConfiguration cfg)
        {
            // Overview (episode synopsis) — single biggest spoiler vector.
            // Replace with the admin-configured placeholder so clients
            // don't render an empty "Description" header. We *replace*
            // rather than null because a literal null causes some clients
            // to fall back to the series description, which can also leak
            // ("the season everyone dies").
            //
            // R4-M1 defense-in-depth: sanitize the placeholder server-side
            // even though the configPage save handler also strips tags.
            // Defends against a config XML that was edited directly on disk
            // bypassing the JS save path.
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
            if (cfg.SpoilerStripChapters && item.Chapters != null)
            {
                foreach (var ch in item.Chapters)
                {
                    if (ch != null) ch.Name = null;
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
            //     paranoid spoiler-mode users; some shows leak via the
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
                    // GuestStars-only mode (default). R4-M5: pre-scan for
                    // any GuestStar entry before allocating — avoids list
                    // allocation on every cast-bearing item when no
                    // GuestStars are present (typical for cartoon series
                    // like Bluey).
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
            }

            // R9-H1 + R10-batch: when title replacement OR overview
            // strip is on, aggressively sanitize ALL title-bearing
            // fields. The R7→R10 review loop kept finding new leak
            // surfaces on the same DTO (MediaSources[].Path → tag-cache
            // StreamData → /Items endpoint MediaStreams → nested
            // MediaSources MediaStreams → MediaAttachments → RemoteTrailers
            // → People[].Role → ChapterInfo.ImagePath → EpisodeTitle / ...).
            // Per security review's paradigm-shift recommendation, treat
            // this as deny-by-default: aggressively null every field
            // that COULD carry the episode title. Future BaseItemDto
            // fields added by Jellyfin must be assumed-leaky until
            // proven otherwise. (R10-H1..H5 + R10-M1..M3)
            if (cfg.SpoilerReplaceTitle || cfg.SpoilerStripOverview)
            {
                // R10-M1/M2: top-level title-bearing string fields.
                if (!string.IsNullOrEmpty(item.Path)) item.Path = null;
                item.EpisodeTitle = null;
                item.ForcedSortName = null;
                item.CustomRating = null;

                // R10-H3: external link arrays whose Url slug or Name
                // commonly contains the episode title.
                item.RemoteTrailers = null;
                item.ExternalUrls = null;

                // R9-H1 + R10-H1 + R10-H2: top-level + nested
                // MediaStreams + MediaAttachments. ffprobe Title /
                // Comment / attachment FileName all routinely carry
                // the episode title on user-muxed mkvs.
                if (item.MediaStreams != null)
                {
                    foreach (var s in item.MediaStreams)
                    {
                        if (s == null) continue;
                        s.Title = null;
                        s.Comment = null;
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
                        // R10-H1: MediaSources nests its OWN MediaStreams
                        // array (separate from BaseItemDto.MediaStreams).
                        // Strip it too.
                        if (ms.MediaStreams != null)
                        {
                            foreach (var s in ms.MediaStreams)
                            {
                                if (s == null) continue;
                                s.Title = null;
                                s.Comment = null;
                            }
                        }
                        // R10-H2: mkv attachments (chapters_*.xml,
                        // subtitle_*.srt) frequently embed the episode
                        // title in FileName / Comment.
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

                // R10-H4: People[].Role (the character name) is an
                // episode-level spoiler regardless of cast strip mode.
                // R5 cast strip toggles drop the array entirely or filter
                // GuestStars; in BOTH cases this loop is a no-op (kept
                // people are removed elsewhere) or strips Role on the
                // remaining People to plug "recurring villain in role
                // 'Resurrected Optimus'" leaks.
                if (item.People != null)
                {
                    foreach (var p in item.People)
                    {
                        if (p == null) continue;
                        p.Role = null;
                    }
                }

                // R10-H5: ChapterInfo.ImagePath leaks server filesystem
                // path commonly containing the episode title. Separate
                // from the SpoilerStripChapters Name strip — applies
                // whenever title-strip is on, even if admin left
                // SpoilerStripChapters off.
                if (item.Chapters != null)
                {
                    foreach (var ch in item.Chapters)
                    {
                        if (ch == null) continue;
                        ch.ImagePath = null;
                    }
                }
            }
        }

    }
}
