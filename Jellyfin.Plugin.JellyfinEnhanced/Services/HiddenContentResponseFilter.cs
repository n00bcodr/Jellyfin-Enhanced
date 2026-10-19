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

        // Which endpoints this filter guards, and on which surface, comes from the one surface registry
        // (PrivacySurfaceRegistry): every host endpoint whose answer can carry a title, plus Home Screen Sections'
        // row endpoint (its {sectionType} selects the surface; with the plugin absent the route never matches).

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
            if (!Guards(context))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var hcEnabled = JellyfinEnhanced.Instance?.Configuration?.HiddenContentEnabled == true;
            var rcwEnabled = JellyfinEnhanced.Instance?.Configuration?.RemoveContinueWatchingEnabled == true;

            var surfaces = PrivacySurfaceRegistry.Surfaces(context);

            // RemoveContinueWatchingEnabled keeps the home-section Remove surfaces (Continue
            // Watching + Next Up) filtering on even when HC's master switch is off.
            var isRemoveSurface = surfaces.Any(s => s is "continuewatching" or "nextup");
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
            // Pure metadata-resolver Ids calls bypass — JE's batchCheckParentSeries cascade caches missing IDs as deleted forever.
            if (hide.IsEmpty || surfaces is ["none"])
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
                if (executed.Result is not ObjectResult { Value: not null } value
                    || NativeResponseValue.Materialize(value) is not (QueryResult<BaseItemDto> or IEnumerable<BaseItemDto> or SearchHintResult or IReadOnlyList<RecommendationDto>))
                {
                    WarnShapeMismatchOnce(_logger, string.Join("+", surfaces), nameof(OnActionExecutionAsync), executed.Result);
                    return;
                }
                // The one identity resolver and the one projection the final delivery gate also uses.
                var identities = _library != null
                    ? PrivacyIdentities.Resolve(_library, NativePrivacyProjection.Ids(value.Value), context.HttpContext)
                    : new Dictionary<Guid, PrivacyIdentity>();
                foreach (var identity in identities.Values) hide.Bind(identity);
                NativePrivacyProjection.Hide(value, hide, item => PrivacySurfaceRegistry.Surface(context, item), identities, single: false);
            }
            catch (Exception ex)
            {
                _logger.Error($"HC response filter could not project surface '{string.Join("+", surfaces)}': {ex.GetType().Name}");
                executed.Result = new StatusCodeResult(503);
            }
        }

        /// <summary>Whether the matched endpoint (by controller/action metadata) is one this filter guards.</summary>
        internal static bool Guards(ActionContext context) => PrivacySurfaceRegistry.Find(context) is { Hc: not null };

        /// <summary>The registry's surface for an item of this request ("none" when Hidden Content does not apply).</summary>
        internal static string PresentationSurface(ActionContext context, BaseItemDto? item) => PrivacySurfaceRegistry.Surface(context, item);

        private HiddenContentPolicy LoadHiddenContentPolicy(HttpContext httpContext, Guid userId)
        {
            if (httpContext.Items.TryGetValue(CacheKey, out var cached) && cached is HiddenContentPolicy hit) return hit;
            var policy = HiddenContentPolicy.Load(_configManager, userId, httpContext, _library);
            httpContext.Items[CacheKey] = policy;
            return policy;
        }
    }
}
