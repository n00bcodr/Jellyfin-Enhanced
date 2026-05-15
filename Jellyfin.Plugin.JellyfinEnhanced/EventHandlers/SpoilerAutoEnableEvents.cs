using System;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    // On PlaybackStart of an Episode that is S1E1 of a series the user has
    // never played before, automatically add the series to the user's
    // UserSpoilerBlur.Series. Gated by the admin toggle
    // SpoilerAutoEnableOnFirstPlay AND the master SpoilerBlurEnabled kill
    // switch. The first-play check uses the *series* UserData PlayCount /
    // LastPlayedDate — covers users who watched some other episode (e.g.
    // S2E1) before circling back to S1E1, so they don't get the auto-
    // enable on what is effectively a rewatch.
    public sealed class SpoilerAutoEnableOnFirstPlayConsumer : IEventConsumer<PlaybackStartEventArgs>
    {
        private readonly UserConfigurationManager _configManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly Logger _logger;

        public SpoilerAutoEnableOnFirstPlayConsumer(
            UserConfigurationManager configManager,
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            Logger logger)
        {
            _configManager = configManager;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _logger = logger;
        }

        public Task OnEvent(PlaybackStartEventArgs eventArgs)
        {
            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.SpoilerBlurEnabled != true) return Task.CompletedTask;
                if (cfg?.SpoilerAutoEnableOnFirstPlay != true) return Task.CompletedTask;

                var item = eventArgs?.Item;
                var session = eventArgs?.Session;
                if (item == null || session == null) return Task.CompletedTask;

                if (item is not Episode episode) return Task.CompletedTask;
                // S1E1 only — the "starting a show from the beginning" signal.
                // Picking up at S3E5 doesn't imply spoiler protection is wanted
                // (user likely already knows the plot or is sampling).
                if (episode.IndexNumber != 1 || episode.ParentIndexNumber != 1) return Task.CompletedTask;

                var userId = session.UserId;
                if (userId == Guid.Empty) return Task.CompletedTask;

                var seriesId = episode.SeriesId;
                if (seriesId == Guid.Empty) return Task.CompletedTask;

                var series = _libraryManager.GetItemById(seriesId);
                if (series == null) return Task.CompletedTask;

                var user = _userManager.GetUserById(userId);
                if (user == null) return Task.CompletedTask;

                // Series-level UserData aggregates child episode play state.
                // Either signal (PlayCount > 0 or LastPlayedDate set) means
                // the user has played at least one episode of this series
                // before — treat as a rewatch / re-entry, skip auto-enable.
                var seriesUserData = _userDataManager.GetUserData(user, series);
                if (seriesUserData != null
                    && (seriesUserData.PlayCount > 0 || seriesUserData.LastPlayedDate.HasValue))
                {
                    return Task.CompletedTask;
                }

                var seriesIdN = seriesId.ToString("N");
                var seriesName = series.Name ?? string.Empty;

                int changed;
                try
                {
                    changed = _configManager.RmwUserConfiguration<UserSpoilerBlur>(
                        userId.ToString("N"),
                        SpoilerBlurImageFilter.SpoilerBlurFileName,
                        state =>
                        {
                            if (state == null) return 0;
                            if (state.Series.ContainsKey(seriesIdN)) return 0;
                            state.Series[seriesIdN] = new SpoilerBlurSeriesEntry
                            {
                                SeriesId = seriesIdN,
                                SeriesName = seriesName,
                                EnabledAt = DateTime.UtcNow.ToString("o"),
                            };
                            return 1;
                        });
                }
                catch (InvalidDataException ex)
                {
                    _logger.Warning($"SpoilerAutoEnable: skipping {userId}/{seriesIdN} due to corrupt spoilerblur.json: {ex.Message}");
                    return Task.CompletedTask;
                }

                if (changed > 0)
                {
                    _logger.Info($"SpoilerAutoEnable: enabled spoiler mode for series '{seriesName}' ({seriesIdN}) on first-play of S1E1 by user {userId}");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerAutoEnable: consumer failed: {ex.Message}");
            }

            return Task.CompletedTask;
        }
    }
}
