using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Delivery side of <see cref="LegacyCollageWithhold"/> on every MVC action, both Jellyfin versions: a withheld image
    /// request is answered before the host's image action runs (so no size, validator, 304 or file is ever reached) with
    /// the host's own no-image answer, and every answer goes through <see cref="LegacyCollageProjection"/>: the host's
    /// item-carrying shapes in place, any other answer (JE's own included) in its JSON form, replaced only when something
    /// in it was withheld. Image infos lose the withheld images (path included). Runs outside every other JE filter, so
    /// its rewrite is the last one applied. Does nothing while no collage marker or tile record exists.
    /// </summary>
    public sealed class LegacyCollageWithholdFilter : IAsyncActionFilter
    {
        /// <summary>Filter order: after the JF12 native-details facade (synthetic ids only), before every other filter.</summary>
        public const int Order = -900;

        // The host's image actions (a HEAD request routes to the same action).
        private static readonly HashSet<string> ImageActions = new(StringComparer.Ordinal) { "GetItemImage", "GetItemImageByIndex", "GetItemImage2" };

        private readonly LegacyCollageWithhold _withhold;
        private readonly ILibraryManager _libraryManager;
        private readonly Logger _logger;

        /// <summary>Creates the filter (DI).</summary>
        /// <param name="withhold">The owner of the legacy collage verdicts.</param>
        /// <param name="libraryManager">Library (item lookups, as the host's image action does them).</param>
        /// <param name="logger">JE logger.</param>
        public LegacyCollageWithholdFilter(LegacyCollageWithhold withhold, ILibraryManager libraryManager, Logger logger)
        {
            _withhold = withhold;
            _libraryManager = libraryManager;
            _logger = logger;
        }

        /// <summary>Registers the owner, the filter and its place in the MVC filter order, and the WebSocket projection.</summary>
        /// <param name="services">The plugin's service collection (the host's own registrations are already in it).</param>
        public static void Register(IServiceCollection services)
        {
            services.AddSingleton<LegacyCollageWithhold>();
            services.AddSingleton<LegacyCollageWithholdFilter>();
            services.Configure<MvcOptions>(o => o.Filters.AddService<LegacyCollageWithholdFilter>(Order));
            LegacyCollageSockets.Decorate(services);
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var view = _withhold.Begin();
            if (view.Idle)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var routeValues = context.ActionDescriptor.RouteValues;
            routeValues.TryGetValue("controller", out var controller);
            routeValues.TryGetValue("action", out var action);
            if (string.Equals(controller, "Image", StringComparison.Ordinal) && action != null && ImageActions.Contains(action))
            {
                if (WithheldImage(context, view) is { } answer)
                {
                    context.Result = answer;
                    return;
                }

                await next().ConfigureAwait(false);
                return;
            }

            var executed = await next().ConfigureAwait(false);
            if (executed.Exception != null && !executed.ExceptionHandled)
            {
                return;
            }

            try
            {
                if (string.Equals(controller, "JellyfinEnhanced", StringComparison.Ordinal) && string.Equals(action, "PreviewNativePosterTags", StringComparison.Ordinal))
                {
                    // JE's admin poster-tag preview draws on the item's Primary: a withheld one answers as the action does without one.
                    if (executed.Result is FileResult && RouteItem(context) is { } previewed && view.Withholds(previewed, ImageType.Primary))
                    {
                        executed.Result = new NotFoundObjectResult(new { message = "Item has no Primary image." });
                    }

                    return;
                }

                if (executed.Result is ObjectResult { Value: { } value } result)
                {
                    if (string.Equals(controller, "Image", StringComparison.Ordinal) && string.Equals(action, "GetItemImageInfos", StringComparison.Ordinal))
                    {
                        if (value is IEnumerable<ImageInfo> infos && RouteItem(context) is { } item)
                        {
                            result.Value = infos.Where(i => !view.Withholds(item, i.ImageType)).ToList();
                        }

                        return;
                    }

                    if (LegacyCollageProjection.Rewrite(value, view, out var replacement))
                    {
                        if (replacement != null)
                        {
                            result.Value = replacement;
                        }
                    }
                    else if (Projectable(value) && LegacyCollageProjection.ProjectAnswer(value, JsonOptions(context), view) is { } projected)
                    {
                        result.Value = projected;
                        result.DeclaredType = typeof(JsonNode);
                    }
                }
            }
            catch (Exception ex)
            {
                // Fail closed: an answer that couldn't be checked is not sent.
                _logger.Warning($"[Lists] Could not check an answer for legacy list collages ({ex.GetType().Name}: {ex.Message}); answered 500.");
                executed.Result = new StatusCodeResult(500);
            }
        }

        /// <summary>The rewrite of one answer value (tests: every host answer shape carrying item DTOs).</summary>
        /// <param name="value">The answer's value.</param>
        /// <returns>A replacement value when a lazy sequence had to be materialized, else null.</returns>
        internal object? RewriteValue(object value)
        {
            LegacyCollageProjection.Rewrite(value, _withhold.Begin(), out var replacement);
            return replacement;
        }

        // Answers with a JSON form that can name an item (not text, numbers or flags).
        private static bool Projectable(object value) => value is not (string or bool or Guid or DateTime) && !value.GetType().IsPrimitive && !value.GetType().IsEnum;

        // The host's JSON profiles: camelCase when the client asked for it, PascalCase otherwise (the host's default).
        private static JsonSerializerOptions JsonOptions(ActionContext context)
            => context.HttpContext.Request.Headers.Accept.Any(a => a != null && a.Contains("CamelCase", StringComparison.OrdinalIgnoreCase))
                ? JsonDefaults.CamelCaseOptions
                : JsonDefaults.PascalCaseOptions;

        private ActionResult? WithheldImage(ActionExecutingContext context, LegacyCollageView view)
        {
            if (!context.RouteData.Values.TryGetValue("itemId", out var rawId) || !Guid.TryParse(Convert.ToString(rawId, CultureInfo.InvariantCulture), out var itemId)
                || !context.RouteData.Values.TryGetValue("imageType", out var rawType) || !Enum.TryParse<ImageType>(Convert.ToString(rawType, CultureInfo.InvariantCulture), true, out var type)
                || type is not (ImageType.Primary or ImageType.Thumb))
            {
                return null;
            }

            // The host's own lookup (the requester's access applies): an item it can't find gets its normal 404.
            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User) ?? Guid.Empty;
            var item = _libraryManager.GetItemById<BaseItem>(itemId, userId);
            if (item == null || !view.Withholds(item, type))
            {
                return null;
            }

            // Word for word the host's answer for an item without an image of that type.
            return new NotFoundObjectResult(string.Format(NumberFormatInfo.InvariantInfo, "{0} does not have an image of type {1}", item.Name, type));
        }

        private BaseItem? RouteItem(FilterContext context)
            => context.RouteData.Values.TryGetValue("itemId", out var raw) && Guid.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out var id)
                ? _libraryManager.GetItemById(id)
                : null;
    }
}
