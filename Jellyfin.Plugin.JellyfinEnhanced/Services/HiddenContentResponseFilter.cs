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
    public sealed class HiddenContentResponseFilter : IAsyncActionFilter
    {
        private const string FileName = "hidden-content.json";
        private const string CacheKey = "__JE_HC_FILTER_CACHE";

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

        // Re-warn at most once per hour so a real Jellyfin upgrade isn't permanently invisible after the first warn.
        private static readonly TimeSpan ShapeMismatchReWarnInterval = TimeSpan.FromHours(1);
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTime> _warnedShapeMismatchAt = new();
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, byte> _warnedReadFailure = new();

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

        public HiddenContentResponseFilter(UserConfigurationManager configManager, Logger logger)
        {
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

            // /Items doubles as library list + search results — searchTerm wins, then fall back to library.
            var surface = (route.Surface == "library" && HasSearchTerm(context))
                ? "search"
                : route.Surface;

            // RemoveContinueWatchingEnabled keeps CW filtering on even when HC's master switch is off.
            if (!hcEnabled && !(rcwEnabled && string.Equals(surface, "continuewatching", StringComparison.OrdinalIgnoreCase)))
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

            // Pure metadata-resolver Ids calls bypass — JE's batchCheckParentSeries cascade caches missing IDs as deleted forever.
            if (surface == "library" && IsMetadataResolverIdsCall(context))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            try
            {
                route.Handler(executed, hide, surface, _logger);
            }
            catch (Exception ex)
            {
                _logger.Error($"HC response filter handler failed for surface '{route.Surface}' — entries will pass through unfiltered for this request: {ex.Message}");
            }
        }

        private static bool HasSearchTerm(ActionExecutingContext context)
        {
            var q = context.HttpContext?.Request?.Query;
            if (q == null) return false;
            return HasNonEmpty(q, "searchTerm") || HasNonEmpty(q, "SearchTerm");
        }

        private static bool HasNonEmpty(IQueryCollection q, string key)
            => q.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v.ToString());

        private static bool IsMetadataResolverIdsCall(ActionExecutingContext context)
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

        private static bool TryGetRoute(ActionExecutingContext context, out (string Surface, ResponseHandler Handler) route)
        {
            route = default;
            var rv = context.RouteData?.Values;
            if (rv is null) return false;
            if (!rv.TryGetValue("controller", out var rawC) || rawC is not string controller) return false;
            if (!rv.TryGetValue("action", out var rawA) || rawA is not string action) return false;
            return _routes.TryGetValue((controller, action), out route);
        }

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
                // Dedup once per user per process so a corrupt file doesn't spam Error on every matched request.
                if (_warnedReadFailure.TryAdd(userId, 0))
                {
                    _logger.Error($"HC response filter: failed to read hidden-content.json for user {userId} — entries will pass through unfiltered until the file is repaired: {ex.Message}");
                }
                data = null;
            }

            if (data != null) _warnedReadFailure.TryRemove(userId, out _);

            var ctx = HideContext.Build(data);
            httpContext.Items[CacheKey] = ctx;
            return ctx;
        }

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

        // SearchHint has no SeriesId, so series-scope cascade falls back to the /Items?searchTerm path.
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
            or.Value = new SearchHintResult(kept, Math.Max(0, sh.TotalRecordCount - dropped));
        }

        private static bool IsHidden(BaseItemDto item, HideContext hide, string surface)
        {
            return IsHiddenById(item.Id.ToString(),
                                item.SeriesId.HasValue ? item.SeriesId.Value.ToString() : null,
                                hide, surface);
        }

        private static bool IsHiddenById(string itemIdStr, string? seriesIdStr, HideContext hide, string surface)
        {
            var itemId = NormalizeId(itemIdStr);
            var seriesId = seriesIdStr is null ? null : NormalizeId(seriesIdStr);

            if (hide.ItemIdScopes.TryGetValue(itemId, out var scopes))
            {
                foreach (var s in scopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            if (seriesId is not null && hide.SeriesIdScopes.TryGetValue(seriesId, out var sScopes))
            {
                foreach (var s in sScopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            // Item is itself a Series row whose entry was keyed series-scope.
            if (hide.SeriesIdScopes.TryGetValue(itemId, out var selfSeriesScopes))
            {
                foreach (var s in selfSeriesScopes)
                {
                    if (ScopeAppliesToSurface(s, surface, hide.Settings)) return true;
                }
            }

            return false;
        }

        private static bool ScopeAppliesToSurface(string scope, string surface, HiddenContentSettings settings)
        {
            // Per-surface gate — toggling "Filter Continue Watching" off suppresses ALL CW filtering, including explicit-scope hides.
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

        private static string NormalizeId(string id)
        {
            if (string.IsNullOrEmpty(id)) return string.Empty;
            if (Guid.TryParse(id, out var g) || Guid.TryParseExact(id, "N", out g))
            {
                return g.ToString();
            }
            return id.ToLowerInvariant();
        }

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
                if (!ctx.Settings.Enabled) return ctx;

                foreach (var entry in data.Items.Values)
                {
                    if (entry == null || string.IsNullOrWhiteSpace(entry.ItemId)) continue;
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
