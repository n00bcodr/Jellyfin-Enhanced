using System;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    /// <summary>
    /// Records an Activity Feed "Watched" entry on playback stop, threshold-
    /// gated by how much of the item was actually played -- a session
    /// stopped seconds in shouldn't count as "watched". A session that
    /// crosses the threshold records the watched fraction; one that finishes
    /// (Jellyfin's own PlayedToCompletion) upgrades that same entry to
    /// completed. Both the completed flag and the highest-ever progress are
    /// merge-only in ActivityService/UserConfigurationManager -- neither
    /// downgrades on a later, shallower re-watch. Feeds ActivityService,
    /// which owns the persisted activity.json store; this consumer only
    /// decides WHEN an event counts.
    /// </summary>
    public sealed class ActivityPlaybackConsumer : IEventConsumer<PlaybackStopEventArgs>
    {
        // Minimum fraction of an item's runtime that must have played before
        // it's worth recording at all. Low enough to mean "they actually
        // started this", not just an accidental click-and-stop.
        private const double WatchedThresholdFraction = 0.05;

        private readonly ActivityService _activityService;
        private readonly Logger _logger;

        public ActivityPlaybackConsumer(ActivityService activityService, Logger logger)
        {
            _activityService = activityService;
            _logger = logger;
        }

        public Task OnEvent(PlaybackStopEventArgs eventArgs)
        {
            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.ActivityFeedEnabled != true || cfg.ActivityFeedShowWatched != true)
                {
                    return Task.CompletedTask;
                }

                var item = eventArgs.Item;
                if (item == null) return Task.CompletedTask;

                var completed = eventArgs.PlayedToCompletion;

                // Items with no known runtime (live TV, some music) can't be
                // fractioned -- fraction stays 0 and the item is skipped
                // unless Jellyfin already flagged it complete.
                var fraction = 0.0;
                var runtimeTicks = item.RunTimeTicks;
                var positionTicks = eventArgs.PlaybackPositionTicks;
                if (runtimeTicks.HasValue && runtimeTicks.Value > 0 && positionTicks.HasValue)
                {
                    fraction = Math.Clamp((double)positionTicks.Value / runtimeTicks.Value, 0, 1);
                }

                if (completed)
                {
                    // Jellyfin's completion detection accounts for credits/
                    // end-of-content skip, so the raw tick fraction can land
                    // a bit under 1.0 even on a finished watch -- the display
                    // should still read as fully watched.
                    fraction = Math.Max(fraction, 1.0);
                }
                else if (fraction < WatchedThresholdFraction)
                {
                    return Task.CompletedTask;
                }

                foreach (var user in eventArgs.Users)
                {
                    if (user == null || user.Id == Guid.Empty) continue;
                    _activityService.RecordWatched(user.Id, item.Id, completed, fraction);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ActivityFeed] Failed to record watched activity: {ex.Message}");
            }

            return Task.CompletedTask;
        }
    }
}
