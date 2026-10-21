using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
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
    /// Delivery side of <see cref="LegacyCollageWithhold"/> on the host's image actions, both Jellyfin versions: a withheld
    /// image request is answered before the host's image action runs (so no size, validator, 304 or file is ever reached)
    /// with the host's own no-image answer. Image infos lose the withheld images (path included): they name their item
    /// only by the route. Each of these answers is judged again at its byte boundary (<see cref="LegacyCollageBody.Expect"/>),
    /// so an image that becomes withheld while the action runs isn't sent either. Every answer body, whatever its result
    /// type, goes through <see cref="LegacyCollageBody"/>.
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

        /// <summary>Registers the owner, the image filter, the answer body boundary, the WebSocket projection, and the record of
        /// what library tiles are composed from.</summary>
        /// <param name="services">The plugin's service collection (the host's own registrations are already in it).</param>
        public static void Register(IServiceCollection services)
        {
            services.AddSingleton<LegacyCollageWithhold>();
            services.AddSingleton<LegacyCollageWithholdFilter>();
            services.AddSingleton<LegacyCollageBody>();
            services.Configure<MvcOptions>(o =>
            {
                o.Filters.AddService<LegacyCollageWithholdFilter>(Order);
                o.Filters.AddService<LegacyCollageBody>(LegacyCollageBody.Order);
            });
            LegacyCollageSockets.Decorate(services);
            LegacyCollageCompositions.Decorate(services);
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var routeValues = context.ActionDescriptor.RouteValues;
            routeValues.TryGetValue("controller", out var controller);
            routeValues.TryGetValue("action", out var action);
            var preview = string.Equals(controller, "JellyfinEnhanced", StringComparison.Ordinal) && string.Equals(action, "PreviewNativePosterTags", StringComparison.Ordinal);
            var infosAction = string.Equals(controller, "Image", StringComparison.Ordinal) && string.Equals(action, "GetItemImageInfos", StringComparison.Ordinal);
            if (string.Equals(controller, "Image", StringComparison.Ordinal) && action != null && ImageActions.Contains(action))
            {
                if (ImageTarget(context) is not { } target)
                {
                    await next().ConfigureAwait(false);
                    return;
                }

                // Word for word the host's answer for an item without an image of that type.
                IActionResult? Withheld(LegacyCollageView view) => !view.Idle && target.Item() is { } item && view.Withholds(item, target.Type)
                    ? new NotFoundObjectResult(string.Format(NumberFormatInfo.InvariantInfo, "{0} does not have an image of type {1}", item.Name, target.Type))
                    : null;

                if (Withheld(_withhold.Begin()) is { } answer)
                {
                    context.Result = answer;
                    return;
                }

                // Not withheld now: judged again where its bytes (or its status, for a HEAD or a 304) are written.
                LegacyCollageBody.Expect(context.HttpContext, Withheld);
                await next().ConfigureAwait(false);
                return;
            }

            if (!preview && !infosAction)
            {
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
                if (preview)
                {
                    // JE's admin poster-tag preview draws on the item's Primary: a withheld one answers as the action does without one.
                    if (executed.Result is FileResult && RouteItem(context) is { } previewed)
                    {
                        var none = new NotFoundObjectResult(new { message = "Item has no Primary image." });
                        if (_withhold.Begin().Withholds(previewed, ImageType.Primary))
                        {
                            executed.Result = none;
                        }
                        else
                        {
                            LegacyCollageBody.Expect(context.HttpContext, view => view.Withholds(previewed, ImageType.Primary) ? none : null);
                        }
                    }

                    return;
                }

                if (executed.Result is ObjectResult { Value: IEnumerable<ImageInfo> infos } result && RouteItem(context) is { } item)
                {
                    var all = infos.ToList();
                    var view = _withhold.Begin();
                    var kept = all.Where(i => !view.Withholds(item, i.ImageType)).ToList();
                    result.Value = kept;
                    // Judged again where the answer is written: one withheld by then goes too.
                    LegacyCollageBody.Expect(context.HttpContext, now => kept.Any(i => now.Withholds(item, i.ImageType))
                        ? new ObjectResult(kept.Where(i => !now.Withholds(item, i.ImageType)).ToList()) { StatusCode = result.StatusCode, DeclaredType = result.DeclaredType }
                        : null);
                }
            }
            catch (Exception ex)
            {
                // Fail closed: an answer that couldn't be checked is not sent.
                _logger.Warning($"[Lists] Could not check an answer for legacy list collages ({ex.GetType().Name}: {ex.Message}); answered 500.");
                executed.Result = new StatusCodeResult(500);
            }
        }

        // The image type an image request is for (Primary and Thumb only: no collage is in any other) and its item, looked
        // up as the host does it (the requester's access applies: an item it can't find gets its normal 404), when asked.
        private (Func<BaseItem?> Item, ImageType Type)? ImageTarget(ActionExecutingContext context)
        {
            if (!context.RouteData.Values.TryGetValue("itemId", out var rawId) || !Guid.TryParse(Convert.ToString(rawId, CultureInfo.InvariantCulture), out var itemId)
                || !context.RouteData.Values.TryGetValue("imageType", out var rawType) || !Enum.TryParse<ImageType>(Convert.ToString(rawType, CultureInfo.InvariantCulture), true, out var type)
                || type is not (ImageType.Primary or ImageType.Thumb))
            {
                return null;
            }

            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User) ?? Guid.Empty;
            return (() => _libraryManager.GetItemById<BaseItem>(itemId, userId), type);
        }

        private BaseItem? RouteItem(FilterContext context)
            => context.RouteData.Values.TryGetValue("itemId", out var raw) && Guid.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out var id)
                ? _libraryManager.GetItemById(id)
                : null;
    }
}
