using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Re-fetches every playlist/collection linked to an external list (MDBList, TMDB, Trakt, IMDb) and applies the
    /// changes (design §8, F1–F3): new entries are added at the end, entries the sync added are removed when they leave
    /// the list (if the link asks for it). Default: every 12 hours. Does nothing unless list placeholders and
    /// <c>ListPlaceholdersSyncEnabled</c> are on; linked lists can always be synced by hand ("Sync now").
    /// </summary>
    public class ListPlaceholdersSyncTask : IScheduledTask
    {
        private readonly ListSourceService _sources;
        private readonly Logger _logger;

        /// <summary>Creates the task.</summary>
        /// <param name="sources">Linked-source service.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholdersSyncTask(ListSourceService sources, Logger logger)
        {
            _sources = sources;
            _logger = logger;
        }

        /// <inheritdoc />
        public string Name => "Sync linked lists (list placeholders)";

        /// <inheritdoc />
        public string Key => "JellyfinEnhancedListPlaceholdersSync";

        /// <inheritdoc />
        public string Description => "Re-fetches playlists and collections that are linked to an MDBList, TMDB, Trakt or IMDb list and adds new entries (or removes dropped ones, if the link asks for it). Requires \"Keep linked lists in sync\" in the List Placeholders settings.";

        /// <inheritdoc />
        public string Category => "Jellyfin Enhanced";

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.IntervalTrigger,
                    IntervalTicks = TimeSpan.FromHours(12).Ticks,
                },
            };
        }

        /// <inheritdoc />
        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.ListPlaceholdersEnabled != true || !config.ListPlaceholdersSyncEnabled)
            {
                progress.Report(100);
                return;
            }

            _logger.Info("[ListPlaceholders] Syncing linked lists.");
            await _sources.SyncAllAsync(progress, cancellationToken).ConfigureAwait(false);
            progress.Report(100);
        }
    }
}
