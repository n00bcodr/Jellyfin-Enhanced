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
            if (executed.Canceled || executed.Exception != null) return;

            try
            {
                StripIfApplicable(executed.Result, userState, cfg, userId);
            }
            catch (Exception ex)
            {
                _logger.Error($"Spoiler field strip failed: {ex.Message}");
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
            if (result is not ObjectResult or || or.Value == null) return;

            switch (or.Value)
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
            // Direct enum compare — faster than ToString("Episode") and
            // future-proof if Jellyfin renames any enum string forms.
            if (item.Type != Jellyfin.Data.Enums.BaseItemKind.Episode
                && item.Type != Jellyfin.Data.Enums.BaseItemKind.Season)
            {
                return;
            }

            var seriesId = item.SeriesId;
            if (seriesId == null || seriesId.Value == Guid.Empty) return;
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
                // watched. When UserData is missing (enableUserData=false),
                // fall back to the server-side helper used by the image
                // filter via _libraryManager.GetItemById + iterate, but
                // here we cheat: ResolvePlayedServerSide on the season itself
                // returns the aggregated Played flag which Jellyfin sets to
                // true when ALL episodes are played — different semantics.
                // For seasons we want "any played?" so default-strip when
                // we cannot determine (fail-closed, like episodes).
                if (item.UserData != null)
                {
                    var unplayed = item.UserData.UnplayedItemCount.GetValueOrDefault(int.MaxValue);
                    var totalIndicator = item.RecursiveItemCount.GetValueOrDefault(unplayed);
                    if (totalIndicator > 0 && unplayed < totalIndicator) return; // some watched
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

        private static readonly System.Text.RegularExpressions.Regex _htmlTagRe
            = new System.Text.RegularExpressions.Regex("<[^>]+>", System.Text.RegularExpressions.RegexOptions.Compiled);

        // R4-M1: server-side sanitizer for the admin-supplied placeholder.
        // The configPage JS already strips tags + brackets on save, but
        // an admin who edited the XML config on disk would bypass that.
        // Cap length too — admin can't make a 1MB placeholder amplify
        // every response.
        private static string SanitizePlaceholder(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return "Spoiler mode activated";
            var trimmed = raw.Length > 200 ? raw.Substring(0, 200) : raw;
            var stripped = _htmlTagRe.Replace(trimmed, string.Empty)
                .Replace("<", string.Empty)
                .Replace(">", string.Empty)
                .Replace("\"", string.Empty)
                .Replace("'", string.Empty)
                .Replace("`", string.Empty);
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
                MediaBrowser.Controller.Entities.BaseItem? actualItem;
                try { actualItem = _libraryManager.GetItemById(hint.Id); }
                catch { continue; }
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
                    // GuestStars-only mode (default).
                    var kept = new List<BaseItemPerson>(item.People.Length);
                    foreach (var p in item.People)
                    {
                        if (p == null) continue;
                        // PersonKind.GuestStar serializes as "GuestStar" in BaseItemDto.
                        if (string.Equals(p.Type.ToString(), "GuestStar", StringComparison.Ordinal))
                            continue;
                        kept.Add(p);
                    }
                    item.People = kept.ToArray();
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
        }

    }
}
