using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Post-routing MVC filter that strips the user's hidden-content
    /// entries from Jellyfin's native resume endpoint
    /// (<c>ItemsController.GetResumeItems</c> and
    /// <c>GetResumeItemsLegacy</c>). Operates on the typed
    /// <see cref="QueryResult{T}"/> before serialization, so it works for
    /// every Jellyfin client without URL rewriting.
    /// </summary>
    public sealed class ContinueWatchingResumeFilter : IAsyncActionFilter
    {
        private const string ControllerName = "Items";
        private const string ResumeActionName = "GetResumeItems";
        private const string ResumeActionNameLegacy = "GetResumeItemsLegacy";
        private const string FileName = "hidden-content.json";

        /// <summary>HC scopes that include the Continue Watching surface.</summary>
        private static readonly HashSet<string> CwHideScopes =
            new(StringComparer.OrdinalIgnoreCase) { "global", "continuewatching", "homesections" };

        private readonly UserConfigurationManager _configManager;
        private readonly Logger _logger;

        public ContinueWatchingResumeFilter(UserConfigurationManager configManager, Logger logger)
        {
            _configManager = configManager;
            _logger = logger;
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!IsResumeAction(context))
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

            var executed = await next().ConfigureAwait(false);

            if (executed.Result is not ObjectResult or || or.Value is not QueryResult<BaseItemDto> qr)
            {
                return;
            }

            var items = qr.Items;
            if (items is null || items.Count == 0)
            {
                return;
            }

            UserHiddenContent? hidden;
            try
            {
                hidden = _configManager.GetUserConfiguration<UserHiddenContent>(userId.ToString("N"), FileName);
            }
            catch (Exception ex)
            {
                // A read failure must not 500 the resume endpoint — pass through unfiltered.
                _logger.Warning($"CW resume filter: failed to read hidden-content.json for user {userId}: {ex.Message}");
                return;
            }

            if (hidden?.Items is null || hidden.Items.Count == 0)
            {
                return;
            }

            var hideItemIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var hideSeriesIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in hidden.Items.Values)
            {
                if (entry == null) continue;
                var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope;
                if (!CwHideScopes.Contains(scope)) continue;
                if (string.IsNullOrEmpty(entry.ItemId)) continue;

                hideItemIds.Add(NormalizeId(entry.ItemId));

                // A "Series" entry cascades to every episode whose
                // SeriesId matches its ItemId.
                if (string.Equals(entry.Type, "Series", StringComparison.OrdinalIgnoreCase))
                {
                    hideSeriesIds.Add(NormalizeId(entry.ItemId));
                }
            }

            if (hideItemIds.Count == 0 && hideSeriesIds.Count == 0)
            {
                return;
            }

            var kept = new List<BaseItemDto>(items.Count);
            var dropped = 0;
            foreach (var item in items)
            {
                if (IsHidden(item, hideItemIds, hideSeriesIds))
                {
                    dropped++;
                    continue;
                }
                kept.Add(item);
            }

            if (dropped == 0)
            {
                return;
            }

            or.Value = new QueryResult<BaseItemDto>(
                qr.StartIndex,
                Math.Max(0, qr.TotalRecordCount - dropped),
                kept);
        }

        /// <summary>Matches RouteValues against the native resume actions.</summary>
        private static bool IsResumeAction(ActionExecutingContext context)
        {
            var rv = context.RouteData?.Values;
            if (rv is null) return false;

            if (!rv.TryGetValue("controller", out var rawController)
                || rawController is not string controller
                || !string.Equals(controller, ControllerName, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!rv.TryGetValue("action", out var rawAction)
                || rawAction is not string action)
            {
                return false;
            }

            return string.Equals(action, ResumeActionName, StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, ResumeActionNameLegacy, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Returns true if <paramref name="item"/> matches an item-scope or series-scope hide.</summary>
        private static bool IsHidden(BaseItemDto item, HashSet<string> hideItemIds, HashSet<string> hideSeriesIds)
        {
            if (hideItemIds.Contains(NormalizeId(item.Id.ToString()))) return true;
            if (item.SeriesId.HasValue
                && item.SeriesId.Value != Guid.Empty
                && hideSeriesIds.Contains(NormalizeId(item.SeriesId.Value.ToString())))
            {
                return true;
            }
            return false;
        }

        /// <summary>
        /// Normalizes a GUID-shaped id to lowercase hyphenated form so
        /// hyphenated and N-format keys match the same entry. Non-GUID
        /// ids (TMDB-only entries) are lowercased.
        /// </summary>
        private static string NormalizeId(string id)
        {
            if (string.IsNullOrEmpty(id)) return string.Empty;
            if (Guid.TryParse(id, out var g) || Guid.TryParseExact(id, "N", out g))
            {
                return g.ToString();
            }
            return id.ToLowerInvariant();
        }
    }
}
