using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Daily list placeholder maintenance (no-op unless <c>ListPlaceholdersEnabled</c>): removes the documents of
    /// deleted lists (A8), refreshes Seerr metadata of incomplete/undated placeholders (release dates, expected
    /// episodes, production state; at most daily thanks to the metadata cache) and runs a full swap-in pass, which also
    /// retires season/series placeholders that became complete and completes interrupted swaps. Then re-checks the poster
    /// collages of placeholder-only lists (when that setting is on).
    /// </summary>
    public class ListPlaceholdersMaintenanceTask : IScheduledTask
    {
        private readonly ListPlaceholderSwapService _swap;
        private readonly ListPlaceholderLifecycle _lifecycle;
        private readonly Logger _logger;
        private readonly ListPlaceholderCollageService? _collage;

        /// <summary>Creates the task.</summary>
        /// <param name="swap">Swap service.</param>
        /// <param name="lifecycle">List lifecycle (orphan sweep).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="collage">Poster collage of placeholder-only lists (re-checked after the pass).</param>
        public ListPlaceholdersMaintenanceTask(ListPlaceholderSwapService swap, ListPlaceholderLifecycle lifecycle, Logger logger, ListPlaceholderCollageService? collage = null)
        {
            _swap = swap;
            _lifecycle = lifecycle;
            _logger = logger;
            _collage = collage;
        }

        /// <inheritdoc />
        public string Name => "List Placeholders Maintenance";

        /// <inheritdoc />
        public string Key => "JellyfinEnhancedListPlaceholdersMaintenance";

        /// <inheritdoc />
        public string Description => "Refreshes release dates and episode lists of \"Not in your library\" placeholders, adds titles that arrived in the library to their playlists and collections, removes placeholder data of deleted lists and updates the poster collages of lists that only have \"Not in your library\" titles.";

        /// <inheritdoc />
        public string Category => "Jellyfin Enhanced";

        /// <summary>Delay between the two existence checks of the orphan sweep (tests shorten it).</summary>
        internal TimeSpan OrphanConfirmDelay { get; set; } = ListPlaceholderLifecycle.ConfirmDelay;

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(4.5).Ticks,
                },
            };
        }

        /// <inheritdoc />
        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (JellyfinEnhanced.Instance?.Configuration?.ListPlaceholdersEnabled != true)
            {
                _logger.Info("[ListPlaceholders] Maintenance skipped: List Placeholders is disabled.");
                _collage?.QueueMarkers(); // takes back any poster collage left behind while off
                progress?.Report(100);
                return;
            }

            var removed = await _lifecycle.CollectOrphansAsync(OrphanConfirmDelay, cancellationToken).ConfigureAwait(false);
            progress?.Report(5);
            var inner = new Progress<double>(p => progress?.Report(5 + (p * 0.95)));
            var result = await _swap.RunAllAsync(MetadataMode.Maintenance, inner, cancellationToken).ConfigureAwait(false);
            _logger.Info($"[ListPlaceholders] Maintenance done: {removed} deleted list(s) cleaned up, {result.Inserted} item(s) swapped in, {result.Retired} placeholder(s) completed.");
            _collage?.QueueAll();
            progress?.Report(100);
        }
    }
}
