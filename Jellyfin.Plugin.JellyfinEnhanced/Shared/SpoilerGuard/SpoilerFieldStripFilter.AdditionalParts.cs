using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard
{
    public sealed partial class SpoilerFieldStripFilter
    {
        // Videos.GetAdditionalPart: each part of a stacked episode is a plain
        // Video with no series id, named after its file, so StripItem cannot
        // place it. It is judged by the route's item, as the image-info arm
        // does: the parts of an unwatched guarded episode are stripped like
        // it and, when titles are replaced, named by their place in the stack.
        private void StripAdditionalParts(IReadOnlyList<BaseItemDto> parts, UserSpoilerBlur userState, PluginConfiguration cfg, Guid userId, ActionExecutingContext context)
        {
            var rv = context.ActionDescriptor.RouteValues;
            if (parts.Count == 0 || rv == null || !rv.TryGetValue("action", out var action) || action != "GetAdditionalPart") return;
            if (!RouteParentIsSpoilerEpisode(context, userState, userId, out var isMovie) || isMovie) return;
            var replaceTitle = ShouldStrip(cfg.SpoilerReplaceTitle, userState.Prefs?.ReplaceEpisodeTitles);
            for (var i = 0; i < parts.Count; i++)
            {
                var part = parts[i];
                if (part == null) continue;
                ApplyStripping(part, userState, cfg, userId);
                if (replaceTitle)
                {
                    part.Name = $"Part {i + 2}";
                    part.SortName = null;
                    part.OriginalTitle = null;
                }
            }
        }
    }
}
