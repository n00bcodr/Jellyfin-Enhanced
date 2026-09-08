using System;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Records Activity Feed "Favorited" entries by watching
    /// IUserDataManager.UserDataSaved -- Jellyfin has no dedicated
    /// favorite-toggled event; a favorite/unfavorite still lands here as a
    /// user-data save with UpdateUserRating (also used for likes). Imports
    /// and general user-data updates can change favorites as well.
    /// A Singleton subscribed for the plugin's lifetime, same pattern as
    /// SpoilerNextUnwatchedService.
    /// </summary>
    public sealed class ActivityFavoriteMonitor : IDisposable
    {
        private readonly IUserDataManager _userDataManager;
        private readonly ActivityService _activityService;
        private readonly Logger _logger;
        private bool _disposed;

        public ActivityFavoriteMonitor(IUserDataManager userDataManager, ActivityService activityService, Logger logger)
        {
            _userDataManager = userDataManager;
            _activityService = activityService;
            _logger = logger;
            _userDataManager.UserDataSaved += OnUserDataSaved;
        }

        private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
        {
            try
            {
                // Playback events are frequent and never toggle favorites.
                // Filter before touching the shared JSON file, including for
                // items that have never been favorited. These reasons exist
                // on both Jellyfin 10.11 and 12.
                if (e.SaveReason != UserDataSaveReason.UpdateUserRating
                    && e.SaveReason != UserDataSaveReason.UpdateUserData
                    && e.SaveReason != UserDataSaveReason.Import) return;

                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.ActivityFeedEnabled != true || cfg.ActivityFeedShowFavorited != true) return;

                var item = e.Item;
                if (item == null || e.UserId == Guid.Empty || e.UserData == null) return;

                if (e.UserData?.IsFavorite == true)
                {
                    _activityService.RecordFavorited(e.UserId, item.Id);
                }
                else
                {
                    // Un-favorited (or never favorited, in which case this is a
                    // no-op remove) -- drop it from the feed if present.
                    _activityService.RemoveFavorited(e.UserId, item.Id);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ActivityFeed] Failed to record favorited activity: {ex.Message}");
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                _userDataManager.UserDataSaved -= OnUserDataSaved;
            }
            catch (Exception ex)
            {
                _logger.Warning($"ActivityFavoriteMonitor: unsubscribe on Dispose threw: {ex.Message}");
            }
        }
    }
}
