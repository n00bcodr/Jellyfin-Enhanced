using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public sealed class HiddenContentResponseFilter : IAsyncActionFilter
    {
        private const string CacheKey = "__JE_HC_FILTER_CACHE";

        /// <summary>Compatibility invalidation seam. Policies now load strictly once per request.</summary>
        public static void InvalidateUser(string userId) { }

        // Shared immutable surface sets. Kept as statics so neither route matching nor per-request
        // surface resolution allocates.
        private static readonly string[] ContinueWatchingSurface = { "continuewatching" };
        private static readonly string[] LibrarySurface = { "library" };
        private static readonly string[] NextUpSurface = { "nextup" };
        private static readonly string[] UpcomingSurface = { "upcoming" };
        private static readonly string[] RecommendationsSurface = { "recommendations" };
        private static readonly string[] SearchSurface = { "search" };

        // A route whose Surfaces is null resolves its surface(s) per request - see ResolveSurfaces.
        private static readonly Dictionary<(string, string), (string[]? Surfaces, ResponseHandler Handler)> _routes
            = new(KeyComparer.Instance)
        {
            { ("Items", "GetResumeItems"),         (ContinueWatchingSurface, FilterQueryResult) },
            { ("Items", "GetResumeItemsLegacy"),   (ContinueWatchingSurface, FilterQueryResult) },
            { ("Items", "GetItems"),               (LibrarySurface,          FilterQueryResult) },
            { ("Items", "GetItemsByUserIdLegacy"), (LibrarySurface,          FilterQueryResult) },
            { ("UserLibrary", "GetLatestMedia"),       (LibrarySurface, FilterEnumerable) },
            { ("UserLibrary", "GetLatestMediaLegacy"), (LibrarySurface, FilterEnumerable) },
            { ("TvShows", "GetNextUp"),                (NextUpSurface,          FilterQueryResult) },
            { ("TvShows", "GetUpcomingEpisodes"),      (UpcomingSurface,        FilterQueryResult) },
            { ("Suggestions", "GetSuggestions"),       (RecommendationsSurface, FilterQueryResult) },
            { ("Suggestions", "GetSuggestionsLegacy"), (RecommendationsSurface, FilterQueryResult) },
            { ("Library", "GetSimilarItems"), (RecommendationsSurface, FilterQueryResult) },
            { ("TvShows", "GetSeasons"), (LibrarySurface, FilterQueryResult) },
            { ("TvShows", "GetEpisodes"), (LibrarySurface, FilterQueryResult) },
            { ("Search", "GetSearchHints"),            (SearchSurface,          FilterSearchHints) },

            // Home Screen Sections (IAmParadox27/jellyfin-plugin-home-sections) builds the home rows from
            // its OWN endpoint instead of Jellyfin's native ones, so on an HSS home screen a "Remove from
            // Continue Watching" hide that /UserItems/Resume honours came straight back on the next refresh.
            // Its response is a plain BaseItemDtoQueryResult, so the native handler fits as-is. The surface
            // is not fixed per route (it depends on which section was asked for), so it is left null here
            // and resolved from the {sectionType} route value per request. Matching on controller/action
            // name alone means no compile-time or runtime dependency on the plugin: with HSS absent the
            // route simply never matches and nothing here runs.
            { ("HomeScreen", "GetSectionContent"),     (null, FilterQueryResult) },
        };

        /// <summary>
        /// Maps a Home Screen Sections section id (its `{sectionType}` route value) to the hide surface(s)
        /// that row represents. Only the rows that mirror a scoped JE surface are listed; every other
        /// section falls back to "library" (see <see cref="ResolveSurfaces"/>).
        /// </summary>
        private static readonly Dictionary<string, string[]> _homeScreenSectionSurfaces
            = new(StringComparer.OrdinalIgnoreCase)
        {
            { "ContinueWatching", ContinueWatchingSurface },
            { "NextUp",           NextUpSurface },
            { "MyRequests", new[] { "requests" } },
            { "Discover", new[] { "discovery" } },
            { "Upcoming", UpcomingSurface },
            // One row rendering resume items and next-up items together. Both surfaces are in play, but they
            // are NOT applied to the whole list: each item is judged against the surface it is actually
            // appearing as (see FilterMixedHomeRow), so a Next-Up hide cannot suppress an episode that is
            // now in the row as a resume item, and vice versa.
            { "ContinueWatchingNextUp", new[] { "continuewatching", "nextup" } },
        };

        private delegate void ResponseHandler(ActionExecutedContext executed, HiddenContentPolicy hide, string surface, Logger logger);

        // Re-warn at most once per hour so a real Jellyfin upgrade isn't permanently invisible after the first warn.
        private static readonly TimeSpan ShapeMismatchReWarnInterval = TimeSpan.FromHours(1);
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTime> _warnedShapeMismatchAt = new();

        private static void WarnShapeMismatchOnce(Logger logger, string surface, string handlerName, IActionResult? result)
        {
            var now = DateTime.UtcNow;
            // AddOrUpdate returns the stored value. Equality with `now` means our new timestamp won the slot — log.
            var stored = _warnedShapeMismatchAt.AddOrUpdate(
                surface,
                now,
                (_, last) => (now - last) >= ShapeMismatchReWarnInterval ? now : last);
            if (stored != now) return;
            var actualType = result?.GetType().FullName ?? "(null)";
            logger.Warning($"HC filter: {handlerName} for surface '{surface}' got an unexpected response shape ({actualType}); filter is no-op for this endpoint. Likely a Jellyfin upgrade changed the response type. Re-warns hourly.");
        }

        private readonly UserConfigurationManager _configManager;
        private readonly Logger _logger;
        private readonly MediaBrowser.Controller.Library.ILibraryManager? _library;

        public HiddenContentResponseFilter(UserConfigurationManager configManager, Logger logger, MediaBrowser.Controller.Library.ILibraryManager? library = null)
        {
            _library = library;
            _configManager = configManager;
            _logger = logger;
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!TryGetRoute(context, out var route))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var hcEnabled = JellyfinEnhanced.Instance?.Configuration?.HiddenContentEnabled == true;
            var rcwEnabled = JellyfinEnhanced.Instance?.Configuration?.RemoveContinueWatchingEnabled == true;

            var surfaces = ResolveSurfaces(context, route.Surfaces);

            // RemoveContinueWatchingEnabled keeps the home-section Remove surfaces (Continue
            // Watching + Next Up) filtering on even when HC's master switch is off.
            var isRemoveSurface = false;
            foreach (var s in surfaces)
            {
                if (string.Equals(s, "continuewatching", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(s, "nextup", StringComparison.OrdinalIgnoreCase))
                {
                    isRemoveSurface = true;
                    break;
                }
            }
            if (!hcEnabled && !(rcwEnabled && isRemoveSurface))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User) ?? Guid.Empty;
            if (userId == Guid.Empty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            HiddenContentPolicy hide;
            try { hide = LoadHiddenContentPolicy(context.HttpContext, userId); }
            catch (Exception) { context.Result = new StatusCodeResult(503); return; }
            if (hide.IsEmpty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            // Pure metadata-resolver Ids calls bypass — JE's batchCheckParentSeries cascade caches missing IDs as deleted forever.
            if (surfaces.Length == 1 && surfaces[0] == "library" && IsMetadataResolverIdsCall(context))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);

            // The action threw, so there is no response to filter and no shape to diagnose. Without this
            // the handler would read a null Result and log a shape-mismatch warning blaming a Jellyfin
            // upgrade — wrong, and it would burn that surface's hourly warn slot ahead of a genuine one.
            // Reachable through any endpoint that can fault, including plugin sections doing network I/O.
            if (executed.Exception is not null && !executed.ExceptionHandled)
            {
                return;
            }

            try
            {
                if (executed.Result is ObjectResult materialized) NativeResponseValue.Materialize(materialized);
                if (_library != null && executed.Result is ObjectResult value)
                {
                    IEnumerable<Guid> ids = value.Value switch {
                        QueryResult<BaseItemDto> query => query.Items.SelectMany(i => new[] { i.Id, i.SeriesId ?? Guid.Empty }),
                        IEnumerable<BaseItemDto> items => items.SelectMany(i => new[] { i.Id, i.SeriesId ?? Guid.Empty }),
                        SearchHintResult hints => hints.SearchHints.Select(i => i.Id),
                        _ => Array.Empty<Guid>()
                    };
                    hide.BindLibraryIds(_library, ids);
                }
                if (surfaces.Length > 1)
                {
                    FilterMixedHomeRow(executed, hide, _logger);
                }
                else
                {
                    route.Handler(executed, hide, surfaces[0], _logger);
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"HC response filter could not project surface '{string.Join("+", surfaces)}': {ex.GetType().Name}");
                executed.Result = new StatusCodeResult(503);
            }
        }

        /// <summary>
        /// Filters a home row that renders resume items and next-up items in one list — Home Screen Sections'
        /// combined "Continue Watching / Next Up" section.
        /// </summary>
        /// <remarks>
        /// Each item is judged against the surface it is actually appearing as rather than against both
        /// scopes at once: only a resume item carries a playback position. Applying the union to the whole
        /// list would mean a Next-Up-scoped hide also suppressed that episode once the user had started
        /// watching it and it had become a Continue Watching entry — invisible on every other surface, since
        /// the native resume row and HSS's separate Continue Watching row would both still show it. This
        /// mirrors what the client-side row detector does per card, so the two halves agree.
        /// </remarks>
        private static void FilterMixedHomeRow(ActionExecutedContext executed, HiddenContentPolicy hide, Logger logger)
        {
            if (executed.Result is not ObjectResult or || or.Value is not QueryResult<BaseItemDto> qr)
            {
                WarnShapeMismatchOnce(logger, "continuewatching+nextup", nameof(FilterMixedHomeRow), executed.Result);
                return;
            }
            var items = qr.Items;
            if (items is null || items.Count == 0) return;

            var kept = new List<BaseItemDto>(items.Count);
            var dropped = 0;
            foreach (var item in items)
            {
                var surface = (item.UserData?.PlaybackPositionTicks ?? 0) > 0 ? "continuewatching" : "nextup";
                if (IsHidden(item, hide, surface)) { dropped++; continue; }
                kept.Add(item);
            }
            if (dropped == 0) return;

            or.Value = new QueryResult<BaseItemDto>(
                qr.StartIndex,
                Math.Max(0, qr.TotalRecordCount - dropped),
                kept);
        }

        /// <summary>
        /// Resolves the hide surface(s) a request should be filtered against.
        /// </summary>
        /// <param name="context">The executing action, for route values and query string.</param>
        /// <param name="routeSurfaces">The route's fixed surfaces, or null when they are request-dependent.</param>
        /// <returns>One or more surface names; never empty.</returns>
        private static string[] ResolveSurfaces(ActionContext context, string[]? routeSurfaces)
        {
            // Home Screen Sections: the row's surface is whichever section was requested.
            if (routeSurfaces is null)
            {
                var sectionType = context.RouteData?.Values is { } rv
                    && rv.TryGetValue("sectionType", out var rawSection)
                        ? rawSection as string
                        : null;

                // Unmapped, unknown and plugin-registered section types fall back to "library" — the same
                // treatment a native library list gets, so only a global hide reaches them (no scope is
                // ever stored as "library"). Conservative by design: a future HSS section keeps working
                // without a JE update, and a row-scoped hide can never over-hide somewhere it shouldn't.
                return !string.IsNullOrEmpty(sectionType)
                    && _homeScreenSectionSurfaces.TryGetValue(sectionType, out var sectionSurfaces)
                        ? sectionSurfaces
                        : LibrarySurface;
            }

            // /Items doubles as library list + search results — searchTerm wins, then fall back to library.
            if (routeSurfaces.Length == 1 && routeSurfaces[0] == "library" && HasSearchTerm(context))
            {
                return SearchSurface;
            }

            return routeSurfaces;
        }

        private static bool HasSearchTerm(ActionContext context)
        {
            var q = context.HttpContext?.Request?.Query;
            if (q == null) return false;
            return HasNonEmpty(q, "searchTerm") || HasNonEmpty(q, "SearchTerm");
        }

        private static bool HasNonEmpty(IQueryCollection q, string key)
            => q.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v.ToString());

        private static bool IsMetadataResolverIdsCall(ActionContext context)
        {
            var q = context.HttpContext?.Request?.Query;
            if (q == null) return false;
            if (!HasNonEmpty(q, "Ids") && !HasNonEmpty(q, "ids")) return false;
            if (IsRecursiveTrue(q, "Recursive") || IsRecursiveTrue(q, "recursive")) return false;
            if (HasNonEmpty(q, "ParentId") || HasNonEmpty(q, "parentId")) return false;
            return true;
        }

        private static bool IsRecursiveTrue(IQueryCollection q, string key)
            => q.TryGetValue(key, out var v) && string.Equals(v.ToString().Trim(), "true", StringComparison.OrdinalIgnoreCase);

        private static bool TryGetRoute(ActionContext context, out (string[]? Surfaces, ResponseHandler Handler) route)
        {
            route = default;
            var rv = context.RouteData?.Values;
            if (rv is null) return false;
            if (!rv.TryGetValue("controller", out var rawC) || rawC is not string controller) return false;
            if (!rv.TryGetValue("action", out var rawA) || rawA is not string action) return false;
            return _routes.TryGetValue((controller, action), out route);
        }

        /// <summary>Whether the matched endpoint (by controller/action metadata) is one this filter guards.</summary>
        internal static bool Guards(ActionContext context) => TryGetRoute(context, out _);

        /// <summary>The existing native route policy, reused by the final delivery gate including mixed home rows.</summary>
        internal static string PresentationSurface(ActionContext context, BaseItemDto? item)
        {
            if (!TryGetRoute(context, out var route)) return "none";
            var surfaces = ResolveSurfaces(context, route.Surfaces);
            if (surfaces.Length == 1 && surfaces[0] == "library" && IsMetadataResolverIdsCall(context)) return "none";
            return surfaces.Length > 1 ? (item?.UserData?.PlaybackPositionTicks ?? 0) > 0 ? "continuewatching" : "nextup" : surfaces[0];
        }

        private HiddenContentPolicy LoadHiddenContentPolicy(HttpContext httpContext, Guid userId)
        {
            if (httpContext.Items.TryGetValue(CacheKey, out var cached) && cached is HiddenContentPolicy hit) return hit;
            var policy = HiddenContentPolicy.Load(_configManager, userId, httpContext, _library);
            httpContext.Items[CacheKey] = policy;
            return policy;
        }

        private static void FilterQueryResult(ActionExecutedContext executed, HiddenContentPolicy hide, string surface, Logger logger)
        {
            if (executed.Result is not ObjectResult or || or.Value is not QueryResult<BaseItemDto> qr)
            {
                WarnShapeMismatchOnce(logger, surface, nameof(FilterQueryResult), executed.Result);
                return;
            }
            var items = qr.Items;
            if (items is null || items.Count == 0) return;

            var kept = new List<BaseItemDto>(items.Count);
            var dropped = 0;
            foreach (var item in items)
            {
                if (IsHidden(item, hide, surface)) { dropped++; continue; }
                kept.Add(item);
            }
            if (dropped == 0) return;

            or.Value = new QueryResult<BaseItemDto>(
                qr.StartIndex,
                Math.Max(0, qr.TotalRecordCount - dropped),
                kept);
        }

        private static void FilterEnumerable(ActionExecutedContext executed, HiddenContentPolicy hide, string surface, Logger logger)
        {
            if (executed.Result is not ObjectResult or || or.Value is not IEnumerable<BaseItemDto> raw)
            {
                WarnShapeMismatchOnce(logger, surface, nameof(FilterEnumerable), executed.Result);
                return;
            }

            var kept = new List<BaseItemDto>();
            var dropped = 0;
            foreach (var item in raw)
            {
                if (IsHidden(item, hide, surface)) { dropped++; continue; }
                kept.Add(item);
            }
            if (dropped == 0) return;
            or.Value = kept;
        }

        // SearchHint has no SeriesId, so series-scope cascade falls back to the /Items?searchTerm path.
        private static void FilterSearchHints(ActionExecutedContext executed, HiddenContentPolicy hide, string surface, Logger logger)
        {
            if (executed.Result is not ObjectResult or || or.Value is not SearchHintResult sh)
            {
                WarnShapeMismatchOnce(logger, surface, nameof(FilterSearchHints), executed.Result);
                return;
            }
            var hints = sh.SearchHints;
            if (hints is null || hints.Count == 0) return;

            var kept = new List<SearchHint>(hints.Count);
            var dropped = 0;
            foreach (var hint in hints)
            {
                if (IsHiddenById(hint.Id.ToString(), null, hide, surface)) { dropped++; continue; }
                kept.Add(hint);
            }
            if (dropped == 0) return;
            or.Value = new SearchHintResult(kept, Math.Max(0, sh.TotalRecordCount - dropped));
        }

        private static bool IsHidden(BaseItemDto item, HiddenContentPolicy hide, string surface) => hide.IsHidden(item, surface);

        private static bool IsHiddenById(string itemId, string? seriesId, HiddenContentPolicy hide, string surface)
            => hide.IsHidden(null, itemId, seriesId, surface);

        private sealed class KeyComparer : IEqualityComparer<(string, string)>
        {
            public static readonly KeyComparer Instance = new();
            public bool Equals((string, string) x, (string, string) y)
                => string.Equals(x.Item1, y.Item1, StringComparison.OrdinalIgnoreCase)
                && string.Equals(x.Item2, y.Item2, StringComparison.OrdinalIgnoreCase);
            public int GetHashCode((string, string) obj)
                => HashCode.Combine(
                    StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1 ?? string.Empty),
                    StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2 ?? string.Empty));
        }
    }
}
