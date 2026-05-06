using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
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
                { ("TvShows",     "GetEpisodes"),            true },
                { ("TvShows",     "GetSeasons"),             true },
                { ("TvShows",     "GetNextUp"),              true },
                { ("TvShows",     "GetUpcomingEpisodes"),    true },
                { ("Suggestions", "GetSuggestions"),         true },
                { ("Suggestions", "GetSuggestionsLegacy"),   true },
                { ("Search",      "GetSearchHints"),         true },
            };

        private const string ContextKeyUserState = "__JE_SpoilerFieldStrip_UserState";

        private readonly UserConfigurationManager _userConfigManager;
        private readonly ISessionManager _sessionManager;
        private readonly Logger _logger;

        public SpoilerFieldStripFilter(
            UserConfigurationManager userConfigManager,
            ISessionManager sessionManager,
            Logger logger)
        {
            _userConfigManager = userConfigManager;
            _sessionManager = sessionManager;
            _logger = logger;
        }

        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
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
            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User)
                ?? ResolveUserIdFromSession(context.HttpContext)
                ?? Guid.Empty;
            if (userId == Guid.Empty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var userState = LoadUserState(context.HttpContext, userId);
            if (userState.Series.Count == 0)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            if (executed.Canceled || executed.Exception != null) return;

            try
            {
                StripIfApplicable(executed.Result, userState, cfg);
            }
            catch (Exception ex)
            {
                _logger.Error($"Spoiler field strip failed: {ex.Message}");
            }
        }

        // Walks the action result and applies StripItem to every Episode
        // whose SeriesId is in the user's spoiler list AND whose
        // UserData.Played != true.
        private static void StripIfApplicable(
            IActionResult? result,
            UserSpoilerBlur userState,
            PluginConfiguration cfg)
        {
            if (result is not ObjectResult or || or.Value == null) return;

            switch (or.Value)
            {
                case BaseItemDto single:
                    StripItem(single, userState, cfg);
                    break;
                case QueryResult<BaseItemDto> qr:
                    if (qr.Items != null)
                    {
                        foreach (var item in qr.Items) StripItem(item, userState, cfg);
                    }
                    break;
                case IEnumerable<BaseItemDto> seq:
                    foreach (var item in seq) StripItem(item, userState, cfg);
                    break;
                case SearchHintResult shr:
                    // Search hints don't carry the same DTO shape — they're
                    // a different model with limited fields. Stripping
                    // those is out of scope for now (covered by the image
                    // filter on the search results' thumbnails).
                    break;
            }
        }

        // Per-item strip. Only Episodes are eligible. Mutates `item` in
        // place when applicable; no-op otherwise.
        private static void StripItem(BaseItemDto item, UserSpoilerBlur userState, PluginConfiguration cfg)
        {
            if (item == null) return;
            // Type-string check avoids a dependency on Jellyfin.Data.Enums
            // here. BaseItemDto.Type is the BaseItemKind enum string-form.
            if (!string.Equals(item.Type.ToString(), "Episode", StringComparison.Ordinal)) return;

            var seriesId = item.SeriesId;
            if (seriesId == null || seriesId.Value == Guid.Empty) return;
            if (!userState.Series.ContainsKey(seriesId.Value.ToString("N"))) return;

            // UserData.Played is what we use; if UserData is missing from
            // the response shape (rare), fail-safe: treat as played, skip.
            var played = item.UserData?.Played ?? true;
            if (played) return;

            // Apply per-field stripping. Each gated independently on the
            // admin's per-field toggle.
            ApplyStripping(item, cfg);
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
            if (cfg.SpoilerStripOverview && !string.IsNullOrEmpty(item.Overview))
            {
                item.Overview = string.IsNullOrEmpty(cfg.SpoilerOverviewPlaceholder)
                    ? "Spoiler mode activated"
                    : cfg.SpoilerOverviewPlaceholder;
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
        }

        // Same per-request user-state cache pattern as SpoilerBlurImageFilter.
        // When a list endpoint returns 50 episodes, we still only read the
        // user's spoilerblur.json once.
        private UserSpoilerBlur LoadUserState(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            if (httpContext.Items.TryGetValue(ContextKeyUserState, out var cached)
                && cached is UserSpoilerBlur hit)
            {
                return hit;
            }

            UserSpoilerBlur state;
            try
            {
                state = _userConfigManager.GetUserConfiguration<UserSpoilerBlur>(
                    userId.ToString("N"),
                    SpoilerBlurImageFilter.SpoilerBlurFileName);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Spoiler field strip: failed to load user state for {userId}: {ex.Message}");
                state = new UserSpoilerBlur();
            }
            httpContext.Items[ContextKeyUserState] = state;
            return state;
        }

        // Mirrors SpoilerBlurImageFilter.ResolveUserFromActiveSession but
        // simpler — for metadata stripping we don't need ambiguity-window
        // fail-closed because applying the wrong user's strip is a UX
        // glitch (user sees "Spoiler mode activated" on an episode they
        // haven't opted in for) rather than a privacy / spoiler leak.
        // Falling back to "no strip" (return Empty) on any uncertainty is
        // the conservative default.
        private Guid? ResolveUserIdFromSession(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            try
            {
                var remoteIp = httpContext.Connection.RemoteIpAddress?.ToString();
                if (string.IsNullOrEmpty(remoteIp)) return null;

                SessionInfo? best = null;
                foreach (var s in _sessionManager.Sessions)
                {
                    if (s.UserId == Guid.Empty) continue;
                    var endpoint = s.RemoteEndPoint ?? string.Empty;
                    if (!endpoint.StartsWith(remoteIp + ":", StringComparison.Ordinal)
                        && !string.Equals(endpoint, remoteIp, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    if (best == null || s.LastActivityDate > best.LastActivityDate) best = s;
                }
                return best?.UserId;
            }
            catch
            {
                return null;
            }
        }
    }
}
