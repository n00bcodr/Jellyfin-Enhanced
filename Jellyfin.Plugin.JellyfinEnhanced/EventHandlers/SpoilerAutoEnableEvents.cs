using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    // On PlaybackStart of an Episode that is S1E1 of a series the user has
    // never played any episode of before, automatically add the series to
    // the user's UserSpoilerBlur.Series. Gated by the admin toggle
    // SpoilerAutoEnableOnFirstPlay AND the master SpoilerBlurEnabled kill
    // switch. The "played before" check queries the user's played episodes
    // of the series (IsPlayed=true) rather than a series-level UserData row —
    // Jellyfin never aggregates play state onto the Series row, so that field
    // is always empty and would make the guard a no-op (auto-enabling shows
    // the user already knows, and re-enabling after a manual opt-out on every
    // S1E1 replay). Covers both a rewatch of S1E1 and a user who watched
    // other episodes (e.g. S2E1) before circling back to S1E1.
    public sealed class SpoilerAutoEnableOnFirstPlayConsumer : IEventConsumer<PlaybackStartEventArgs>
    {
        private readonly UserConfigurationManager _configManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        public SpoilerAutoEnableOnFirstPlayConsumer(
            UserConfigurationManager configManager,
            ILibraryManager libraryManager,
            IUserManager userManager,
            Logger logger)
        {
            _configManager = configManager;
            _libraryManager = libraryManager;
            _userManager = userManager;
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

                // Has the user played ANY episode of this series before? Ask
                // the library for one played episode under the series for this
                // user. IsPlayed reflects per-episode UserData, which Jellyfin
                // does maintain (unlike the Series row). A hit means either a
                // rewatch of S1E1 or a user who watched later episodes first —
                // both are "already knows the show", so skip auto-enable.
                // PlaybackStart fires before this S1E1 is marked played, so a
                // genuine first play correctly returns zero here.
                var playedProbe = new InternalItemsQuery(user)
                {
                    AncestorIds = new[] { seriesId },
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    IsPlayed = true,
                    Recursive = true,
                    Limit = 1,
                };
                if (_libraryManager.GetItemList(playedProbe).Any())
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
                    _logger.Info($"SpoilerAutoEnable: enabled Spoiler Guard for series '{seriesName}' ({seriesIdN}) on first-play of S1E1 by user {userId}");
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
