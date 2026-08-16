using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Business-logic layer for the Activity Feed's "recently watched" and
    /// "recently favorited" entries. The actual read/write/locking against
    /// the shared activity.json file lives in UserConfigurationManager,
    /// alongside the other shared plugin stores (reviews, etc.); this class
    /// just owns the activity-type constants and Guid<->string plumbing so
    /// callers (event consumers, the controller) don't duplicate either.
    /// </summary>
    public class ActivityService
    {
        internal const string ActivityTypeWatched = "Watched";
        internal const string ActivityTypeFavorited = "Favorited";

        private readonly UserConfigurationManager _userConfigurationManager;

        public ActivityService(UserConfigurationManager userConfigurationManager)
        {
            _userConfigurationManager = userConfigurationManager;
        }

        /// <param name="completed">
        /// Whether this session played the item to completion. Threshold-gating
        /// (only calling this once a meaningful fraction has been watched) is
        /// the caller's job -- see ActivityPlaybackConsumer.
        /// </param>
        /// <param name="progress">Fraction (0.0-1.0) of runtime played this session.</param>
        public void RecordWatched(Guid userId, Guid itemId, bool completed, double progress)
        {
            if (userId == Guid.Empty || itemId == Guid.Empty) return;
            _userConfigurationManager.RecordActivity(
                userId.ToString("N"), itemId.ToString("N"), ActivityTypeWatched, DateTime.UtcNow.ToString("o"), completed, progress);
        }

        public void RecordFavorited(Guid userId, Guid itemId)
        {
            if (userId == Guid.Empty || itemId == Guid.Empty) return;
            _userConfigurationManager.RecordActivity(
                userId.ToString("N"), itemId.ToString("N"), ActivityTypeFavorited, DateTime.UtcNow.ToString("o"));
        }

        /// <summary>Removes a favorited entry (called on unfavorite) so the feed stops showing it.</summary>
        public void RemoveFavorited(Guid userId, Guid itemId)
        {
            if (userId == Guid.Empty || itemId == Guid.Empty) return;
            _userConfigurationManager.RemoveActivity(
                userId.ToString("N"), itemId.ToString("N"), ActivityTypeFavorited);
        }
    }
}
