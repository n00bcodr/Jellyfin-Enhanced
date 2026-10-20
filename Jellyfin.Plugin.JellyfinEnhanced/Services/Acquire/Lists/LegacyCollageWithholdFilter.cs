using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Delivery side of <see cref="LegacyCollageWithhold"/> on every MVC action, both Jellyfin versions: a withheld image
    /// request is answered before the host's image action runs (so no size, validator, 304 or file is ever reached) with
    /// the host's own no-image answer, and every answer carrying item DTOs, search hints or image infos loses the withheld
    /// images' tags, blur hashes, aspect ratio and info (path included). Runs outside every other JE filter, so its
    /// rewrite is the last one applied. Does nothing while no collage marker exists.
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

        /// <summary>Registers the owner, the filter and its place in the MVC filter order.</summary>
        /// <param name="services">The plugin's service collection.</param>
        public static void Register(IServiceCollection services)
        {
            services.AddSingleton<LegacyCollageWithhold>();
            services.AddSingleton<LegacyCollageWithholdFilter>();
            services.Configure<MvcOptions>(o => o.Filters.AddService<LegacyCollageWithholdFilter>(Order));
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (_withhold.NoMarkers())
            {
                await next().ConfigureAwait(false);
                return;
            }

            var routeValues = context.ActionDescriptor.RouteValues;
            routeValues.TryGetValue("controller", out var controller);
            routeValues.TryGetValue("action", out var action);
            if (string.Equals(controller, "Image", StringComparison.Ordinal) && action != null && ImageActions.Contains(action))
            {
                if (WithheldImage(context) is { } answer)
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
                    if (executed.Result is FileResult && RouteItem(context) is { } previewed && _withhold.Withholds(previewed, ImageType.Primary))
                    {
                        executed.Result = new NotFoundObjectResult(new { message = "Item has no Primary image." });
                    }

                    return;
                }

                if (executed.Result is ObjectResult { Value: { } value } result)
                {
                    var request = new RequestVerdicts(_withhold, _libraryManager);
                    if (string.Equals(controller, "Image", StringComparison.Ordinal) && string.Equals(action, "GetItemImageInfos", StringComparison.Ordinal))
                    {
                        if (value is IEnumerable<ImageInfo> infos && RouteItem(context) is { } item)
                        {
                            result.Value = infos.Where(i => !_withhold.Withholds(item, i.ImageType)).ToList();
                        }

                        return;
                    }

                    if (Rewrite(value, request) is { } replaced)
                    {
                        result.Value = replaced;
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

        private ActionResult? WithheldImage(ActionExecutingContext context)
        {
            if (!context.ActionDescriptor.RouteValues.ContainsKey("action")
                || !context.RouteData.Values.TryGetValue("itemId", out var rawId) || !Guid.TryParse(Convert.ToString(rawId, CultureInfo.InvariantCulture), out var itemId)
                || !context.RouteData.Values.TryGetValue("imageType", out var rawType) || !Enum.TryParse<ImageType>(Convert.ToString(rawType, CultureInfo.InvariantCulture), true, out var type)
                || type is not (ImageType.Primary or ImageType.Thumb))
            {
                return null;
            }

            // The host's own lookup (the requester's access applies): an item it can't find gets its normal 404.
            var userId = UserHelper.GetCurrentUserId(context.HttpContext.User) ?? Guid.Empty;
            var item = _libraryManager.GetItemById<BaseItem>(itemId, userId);
            if (item == null || !_withhold.Withholds(item, type))
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

        /// <summary>The rewrite of one answer value (tests: every host answer shape carrying item DTOs).</summary>
        /// <param name="value">The answer's value.</param>
        /// <returns>A replacement value when a lazy sequence had to be materialized, else null.</returns>
        internal object? RewriteValue(object value) => Rewrite(value, new RequestVerdicts(_withhold, _libraryManager));

        // Every host answer shape that carries item DTOs or search hints; returns a replacement value when a lazy
        // sequence had to be materialized for its edits to be the ones serialized.
        private static object? Rewrite(object value, RequestVerdicts verdicts)
        {
            switch (value)
            {
                case BaseItemDto dto:
                    Strip(dto, verdicts);
                    return null;
                case QueryResult<BaseItemDto> query:
                    foreach (var dto in query.Items ?? Array.Empty<BaseItemDto>())
                    {
                        Strip(dto, verdicts);
                    }

                    return null;
                case IEnumerable<BaseItemDto> sequence:
                    var list = sequence as IList<BaseItemDto> ?? sequence.ToList();
                    foreach (var dto in list)
                    {
                        Strip(dto, verdicts);
                    }

                    return ReferenceEquals(list, sequence) ? null : list;
                case SearchHintResult hints:
                    foreach (var hint in hints.SearchHints ?? Array.Empty<SearchHint>())
                    {
                        if (hint.Type is BaseItemKind.Playlist or BaseItemKind.BoxSet or BaseItemKind.CollectionFolder or BaseItemKind.UserView
                            && verdicts.Image(hint.Id, ImageType.Primary))
                        {
                            hint.PrimaryImageTag = null;
                            hint.PrimaryImageAspectRatio = null;
                        }

                        if (Guid.TryParse(hint.ThumbImageItemId, out var thumbItem) && verdicts.Image(thumbItem, ImageType.Thumb))
                        {
                            hint.ThumbImageTag = null;
                            hint.ThumbImageItemId = null;
                        }
                    }

                    return null;
                case IEnumerable<RecommendationDto> recommendations:
                    var materialized = recommendations as IList<RecommendationDto> ?? recommendations.ToList();
                    foreach (var dto in materialized.SelectMany(r => r.Items ?? Array.Empty<BaseItemDto>()))
                    {
                        Strip(dto, verdicts);
                    }

                    return ReferenceEquals(materialized, recommendations) ? null : materialized;
                case AllThemeMediaResult theme:
                    foreach (var dto in new[] { theme.ThemeVideosResult, theme.ThemeSongsResult, theme.SoundtrackSongsResult }.SelectMany(r => r?.Items ?? Array.Empty<BaseItemDto>()))
                    {
                        Strip(dto, verdicts);
                    }

                    return null;
                case SessionInfoDto session:
                    StripSession(session, verdicts);
                    return null;
                case IEnumerable<SessionInfoDto> sessions:
                    var sessionList = sessions as IList<SessionInfoDto> ?? sessions.ToList();
                    foreach (var session in sessionList)
                    {
                        StripSession(session, verdicts);
                    }

                    return ReferenceEquals(sessionList, sessions) ? null : sessionList;
                case AuthenticationResult authentication:
                    StripSession(authentication.SessionInfo, verdicts);
                    return null;
                case TimerInfoDto timer:
                    Strip(timer.ProgramInfo, verdicts);
                    return null;
                case QueryResult<TimerInfoDto> timers:
                    foreach (var timer in timers.Items ?? Array.Empty<TimerInfoDto>())
                    {
                        Strip(timer?.ProgramInfo, verdicts);
                    }

                    return null;
                default:
                    return null;
            }
        }

        private static void StripSession(SessionInfoDto? session, RequestVerdicts verdicts)
        {
            if (session != null)
            {
                Strip(session.NowPlayingItem, verdicts);
                Strip(session.NowViewingItem, verdicts);
#if !JF12
                // 10.11 also sends the whole play queue's items (Jellyfin 12 sends ids only).
                foreach (var queued in session.NowPlayingQueueFullItems ?? Array.Empty<BaseItemDto>())
                {
                    Strip(queued, verdicts);
                }
#endif
            }
        }

        private static void Strip(BaseItemDto? dto, RequestVerdicts verdicts, bool nested = false)
        {
            if (dto == null)
            {
                return;
            }

            if (!nested)
            {
                // A channel's current programme, one level down.
                Strip(dto.CurrentProgram, verdicts, nested: true);
            }

            if (dto.Type is BaseItemKind.Playlist or BaseItemKind.BoxSet && verdicts.List(dto.Id))
            {
                StripOwn(dto, ImageType.Primary);
            }
            else if (dto.Type is BaseItemKind.CollectionFolder or BaseItemKind.UserView
                && LegacyCollageWithhold.HolderKind(dto.CollectionType) is { } kind && verdicts.Kind(kind))
            {
                // A playlist or collection library tile: composed by the host from list images.
                StripOwn(dto, ImageType.Primary);
                StripOwn(dto, ImageType.Thumb);
                StripParent(dto, ImageType.Primary);
                StripParent(dto, ImageType.Thumb);
                return;
            }

            if (dto.ParentPrimaryImageItemId is { } parent && verdicts.List(parent))
            {
                StripParent(dto, ImageType.Primary);
            }
        }

        private static void StripOwn(BaseItemDto dto, ImageType type)
        {
            dto.ImageTags?.Remove(type);
            // The whole type: other JE filters may have re-keyed the hash under a stamped tag.
            dto.ImageBlurHashes?.Remove(type);
            if (type == ImageType.Primary)
            {
                dto.PrimaryImageAspectRatio = null;
            }
        }

        private static void StripParent(BaseItemDto dto, ImageType type)
        {
            string? tag;
            if (type == ImageType.Primary)
            {
                tag = dto.ParentPrimaryImageTag;
                dto.ParentPrimaryImageItemId = null;
                dto.ParentPrimaryImageTag = null;
            }
            else
            {
                tag = dto.ParentThumbImageTag;
                dto.ParentThumbItemId = null;
                dto.ParentThumbImageTag = null;
            }

            if (tag != null && dto.ImageBlurHashes != null && dto.ImageBlurHashes.TryGetValue(type, out var byTag))
            {
                byTag.Remove(tag);
                if (byTag.Count == 0)
                {
                    dto.ImageBlurHashes.Remove(type);
                }
            }
        }

        // One answer's verdicts, each list and kind looked up once.
        private sealed class RequestVerdicts
        {
            private readonly LegacyCollageWithhold _withhold;
            private readonly ILibraryManager _libraryManager;
            private readonly Dictionary<Guid, bool> _lists = new();
            private readonly Dictionary<BaseItemKind, bool> _kinds = new();
            private readonly Dictionary<(Guid, ImageType), bool> _images = new();

            public RequestVerdicts(LegacyCollageWithhold withhold, ILibraryManager libraryManager)
            {
                _withhold = withhold;
                _libraryManager = libraryManager;
            }

            public bool Image(Guid id, ImageType type)
            {
                if (!_images.TryGetValue((id, type), out var withheld))
                {
                    _images[(id, type)] = withheld = id != Guid.Empty && _libraryManager.GetItemById(id) is { } item && _withhold.Withholds(item, type);
                }

                return withheld;
            }

            public bool List(Guid id)
            {
                if (!_lists.TryGetValue(id, out var withheld))
                {
                    _lists[id] = withheld = _withhold.WithholdsList(id);
                }

                return withheld;
            }

            public bool Kind(BaseItemKind kind)
            {
                if (!_kinds.TryGetValue(kind, out var withheld))
                {
                    _kinds[kind] = withheld = _withhold.AnyWithheld(kind);
                }

                return withheld;
            }
        }
    }
}
