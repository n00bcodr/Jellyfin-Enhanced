using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Reviews
{
    /// <summary>
    /// Per-request state for deciding which reviews a viewer may see.
    /// Shared by <see cref="GetItemReviews"/> and <see cref="GetReviewRatings"/>
    /// so the list and the poster rating chips can never disagree. Authors
    /// are resolved at most once per request.
    /// </summary>
    public sealed class ReviewVisibilityContext
    {
        public bool ViewerIsAdmin { get; init; }
        public string? ViewerUserIdN { get; init; }
        public bool HideHiddenAuthors { get; init; }
        public bool HideDisabledAuthors { get; init; }
        public Dictionary<Guid, Jellyfin.Database.Implementations.Entities.User?> Authors { get; } = new();
    }
}
