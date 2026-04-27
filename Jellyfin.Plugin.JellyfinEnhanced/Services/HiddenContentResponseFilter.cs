using System;
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
    /// <summary>
    /// Post-routing filter that strips Hidden Content entries from every
    /// native Jellyfin endpoint that surfaces user-facing item lists,
    /// including <c>/UserItems/Resume</c>, <c>/Items</c>, <c>/Items/Latest</c>,
    /// <c>/Shows/NextUp</c>, <c>/Shows/Upcoming</c>, <c>/Items/Suggestions</c>,
    /// and <c>/Search/Hints</c>. Filtering is per-route via an internal table.
    /// </summary>
    public sealed class HiddenContentResponseFilter : IAsyncActionFilter
    {
        private const string FileName = "hidden-content.json";
        private const string CacheKey = "__JE_HC_FILTER_CACHE";

        // (controller, action) → (HC surface name, response-shape handler).
        // Surface name maps to the user's HiddenContentSettings.
        private static readonly Dictionary<(string, string), (string Surface, ResponseHandler Handler)> _routes
            = new(KeyComparer.Instance)
        {
            { ("Items", "GetResumeItems"),         ("continuewatching", FilterQueryResult) },
            { ("Items", "GetResumeItemsLegacy"),   ("continuewatching", FilterQueryResult) },
            { ("Items", "GetItems"),               ("library",          FilterQueryResult) },
            { ("Items", "GetItemsByUserIdLegacy"), ("library",          FilterQueryResult) },
            { ("UserLibrary", "GetLatestMedia"),       ("library", FilterEnumerable) },
            { ("UserLibrary", "GetLatestMediaLegacy"), ("library", FilterEnumerable) },
            { ("TvShows", "GetNextUp"),                ("nextup",          FilterQueryResult) },
            { ("TvShows", "GetUpcomingEpisodes"),      ("upcoming",        FilterQueryResult) },
            { ("Suggestions", "GetSuggestions"),       ("recommendations", FilterQueryResult) },
            { ("Suggestions", "GetSuggestionsLegacy"), ("recommendations", FilterQueryResult) },
            { ("Search", "GetSearchHints"),            ("search",          FilterSearchHints) },
        };

        private delegate void ResponseHandler(ActionExecutedContext executed, HideContext hide, string surface, Logger logger);

        /// <summary>Surfaces we've already warned about for shape mismatch — keeps log noise to one entry per surface per process lifetime.</summary>
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> _warnedShapeMismatch = new();

        private static void WarnShapeMismatchOnce(Logger logger, string surface, string handlerName, IActionResult? result)
        {
            if (!_warnedShapeMismatch.TryAdd(surface, 0)) return;
            var actualType = result?.GetType().FullName ?? "(null)";
            logger.Warning($"HC filter: {handlerName} for surface '{surface}' got an unexpected response shape ({actualType}); filter is no-op for this endpoint until plugin restart. Likely a Jellyfin upgrade changed the response type.");
        }

        private readonly UserConfigurationManager _configManager;
        private readonly Logger _logger;

        public HiddenContentResponseFilter(UserConfigurationManager configManager, Logger logger)
        {
            _configManager = configManager;
            _logger = logger;
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!TryGetRoute(context, out var route))
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

            var hide = LoadHideContext(context.HttpContext, userId);
            if (hide.IsEmpty)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            try
            {
                route.Handler(executed, hide, route.Surface, _logger);
            }
            catch (Exception ex)
            {
                // Filter must not 500 user-facing library/search/etc. Logged at Error
                // because a swallowed handler exception means hidden items leaked into
                // the response.
                _logger.Error($"HC response filter handler failed for surface '{route.Surface}' — entries will pass through unfiltered for this request: {ex.Message}");
            }
        }

        // ─── route gate ──────────────────────────────────────────────────────

        private static bool TryGetRoute(ActionExecutingContext context, out (string Surface, ResponseHandler Handler) route)
        {
            route = default;
            var rv = context.RouteData?.Values;
            if (rv is null) return false;
            if (!rv.TryGetValue("controller", out var rawC) || rawC is not string controller) return false;
            if (!rv.TryGetValue("action", out var rawA) || rawA is not string action) return false;
            return _routes.TryGetValue((controller, action), out route);
        }

        // ─── per-request hidden-content cache ────────────────────────────────

        /// <summary>Loads the user's hidden content + settings, caching the parsed result on <see cref="HttpContext.Items"/> so repeated filters in the same request don't re-read the file.</summary>
        private HideContext LoadHideContext(HttpContext httpContext, Guid userId)
        {
            if (httpContext.Items.TryGetValue(CacheKey, out var cached) && cached is HideContext hit)
            {
                return hit;
            }

            UserHiddenContent? data;
            try
            {
                data = _configManager.GetUserConfiguration<UserHiddenContent>(userId.ToString("N"), FileName);
            }
            catch (Exception ex)
            {
                // A failure here means hidden items will silently appear in the
                // user's library / search / etc. Log at Error so an admin
                // notices, even though we still fail open to keep the response
                // serving rather than 500ing the whole library.
                _logger.Error($"HC response filter: failed to read hidden-content.json for user {userId} — entries will pass through unfiltered: {ex.Message}");
                data = null;
            }

            var ctx = HideContext.Build(data);
            httpContext.Items[CacheKey] = ctx;
            return ctx;
        }

        // ─── response-shape handlers ─────────────────────────────────────────

        /// <summary>Filters an <see cref="ObjectResult"/> wrapping <see cref="QueryResult{BaseItemDto}"/>.</summary>
        private static void FilterQueryResult(ActionExecutedContext executed, HideContext hide, string surface, Logger logger)
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

        /// <summary>Filters an <see cref="ObjectResult"/> wrapping <see cref="IEnumerable{BaseItemDto}"/> (e.g. /Items/Latest).</summary>
        private static void FilterEnumerable(ActionExecutedContext executed, HideContext hide, string surface, Logger logger)
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

        /// <summary>Filters an <see cref="ObjectResult"/> wrapping <see cref="SearchHintResult"/>.</summary>
        private static void FilterSearchHints(ActionExecutedContext executed, HideContext hide, string surface, Logger logger)
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
            // SearchHintResult is constructor-only; build a new one.
            or.Value = new SearchHintResult(kept, Math.Max(0, sh.TotalRecordCount - dropped));
        }

        // ─── per-item hidden check ──────────────────────────────────────────

        private static bool IsHidden(BaseItemDto item, HideContext hide, string surface)
        {
            return IsHiddenById(item.Id.ToString(),
                                item.SeriesId.HasValue ? item.SeriesId.Value.ToString() : null,
                                hide, surface);
        }

        /// <summary>
        /// Determines whether an item should be hidden on a given surface.
        /// Per-surface scopes (continuewatching, nextup, homesections) are
        /// always honored; <c>global</c> scope is gated on the user's
        /// per-surface filter setting.
        /// </summary>
        private static bool IsHiddenById(string itemIdStr, string? seriesIdStr, HideContext hide, string surface)
        {
            var itemId = NormalizeId(itemIdStr);
            var seriesId = seriesIdStr is null ? null : NormalizeId(seriesIdStr);

            // 1) Item-scope hides — entry's ItemId matches this item.
            if (hide.ItemIdScopes.TryGetValue(itemId, out var scopes))
            {
                foreach (var s in scopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            // 2) Series-scope hides — entry has Type=Series and matches this item's parent.
            if (seriesId is not null && hide.SeriesIdScopes.TryGetValue(seriesId, out var sScopes))
            {
                foreach (var s in sScopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            // 3) The item itself happens to be a Series whose entry was
            //    keyed as series-scope — relevant when a Series row appears
            //    in resume / next-up etc.
            if (hide.SeriesIdScopes.TryGetValue(itemId, out var selfSeriesScopes))
            {
                foreach (var s in selfSeriesScopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            return false;
        }

        /// <summary>Whether a stored scope should hide the item on a given surface; gated through the per-surface setting to match hidden-content.js's <c>shouldFilterSurface</c> behavior.</summary>
        private static bool ScopeAppliesToSurface(string scope, string surface, HiddenContentSettings settings)
        {
            // Master gate. Mirrors hidden-content.js — even explicit-scope hides
            // are subject to the user's per-surface filter setting, so toggling
            // "Filter Continue Watching" off cleanly suppresses ALL CW filtering
            // (whether the entry is HideScope=continuewatching or HideScope=global).
            if (!ShouldFilterSurface(settings, surface)) return false;

            if (string.Equals(scope, surface, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase)
                && (string.Equals(surface, "nextup", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(surface, "continuewatching", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
            return string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Mirrors the per-surface gate in hidden-content.js's <c>shouldFilterSurface</c>.</summary>
        private static bool ShouldFilterSurface(HiddenContentSettings s, string surface)
        {
            if (s == null || !s.Enabled) return false;
            return surface switch
            {
                "library" or "details" => s.FilterLibrary,
                "discovery" => s.FilterDiscovery,
                "search" => s.FilterSearch,
                "upcoming" => s.FilterUpcoming,
                "calendar" => s.FilterCalendar,
                "recommendations" => s.FilterRecommendations,
                "requests" => s.FilterRequests,
                "nextup" => s.FilterNextUp,
                "continuewatching" => s.FilterContinueWatching,
                _ => true,
            };
        }

        /// <summary>Lowercase-hyphenated form so hyphenated and N-format GUIDs match; non-GUIDs are lowercased.</summary>
        private static string NormalizeId(string id)
        {
            if (string.IsNullOrEmpty(id)) return string.Empty;
            if (Guid.TryParse(id, out var g) || Guid.TryParseExact(id, "N", out g))
            {
                return g.ToString();
            }
            return id.ToLowerInvariant();
        }

        // ─── computed per-user state ─────────────────────────────────────────

        /// <summary>Pre-indexed snapshot of a user's hidden-content data — itemId/seriesId → set of scopes — built once per request.</summary>
        private sealed class HideContext
        {
            public static readonly HideContext Empty = new HideContext();

            public Dictionary<string, HashSet<string>> ItemIdScopes { get; } = new(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, HashSet<string>> SeriesIdScopes { get; } = new(StringComparer.OrdinalIgnoreCase);
            public HiddenContentSettings Settings { get; private set; } = new HiddenContentSettings();

            public bool IsEmpty => ItemIdScopes.Count == 0 && SeriesIdScopes.Count == 0;

            public static HideContext Build(UserHiddenContent? data)
            {
                if (data?.Items == null || data.Items.Count == 0)
                {
                    return new HideContext { Settings = data?.Settings ?? new HiddenContentSettings() };
                }

                var ctx = new HideContext { Settings = data.Settings ?? new HiddenContentSettings() };
                if (!ctx.Settings.Enabled) return ctx; // empty, will short-circuit

                foreach (var entry in data.Items.Values)
                {
                    if (entry == null || string.IsNullOrEmpty(entry.ItemId)) continue;
                    var id = NormalizeId(entry.ItemId);
                    var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope.ToLowerInvariant();

                    AddScope(ctx.ItemIdScopes, id, scope);
                    if (string.Equals(entry.Type, "Series", StringComparison.OrdinalIgnoreCase))
                    {
                        AddScope(ctx.SeriesIdScopes, id, scope);
                    }
                }
                return ctx;
            }

            private static void AddScope(Dictionary<string, HashSet<string>> dict, string key, string scope)
            {
                if (!dict.TryGetValue(key, out var set))
                {
                    set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    dict[key] = set;
                }
                set.Add(scope);
            }
        }

        /// <summary>Case-insensitive (controller, action) tuple comparer for the route table.</summary>
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
