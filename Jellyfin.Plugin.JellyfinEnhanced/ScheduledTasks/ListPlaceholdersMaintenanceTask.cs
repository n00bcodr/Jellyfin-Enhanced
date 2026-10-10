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
    /// retires season/series placeholders that became complete and completes interrupted swaps.
    /// </summary>
    public class ListPlaceholdersMaintenanceTask : IScheduledTask
    {
        private readonly ListPlaceholderSwapService _swap;
        private readonly ListPlaceholderLifecycle _lifecycle;
        private readonly Logger _logger;

        /// <summary>Creates the task.</summary>
        /// <param name="swap">Swap service.</param>
        /// <param name="lifecycle">List lifecycle (orphan sweep).</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholdersMaintenanceTask(ListPlaceholderSwapService swap, ListPlaceholderLifecycle lifecycle, Logger logger)
        {
            _swap = swap;
            _lifecycle = lifecycle;
            _logger = logger;
        }

        /// <inheritdoc />
        public string Name => "List Placeholders Maintenance";

        /// <inheritdoc />
        public string Key => "JellyfinEnhancedListPlaceholdersMaintenance";

        /// <inheritdoc />
        public string Description => "Refreshes release dates and episode lists of \"Not in your library\" placeholders, adds titles that arrived in the library to their playlists and collections, and removes placeholder data of deleted lists.";

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
                progress?.Report(100);
                return;
            }

            var removed = await _lifecycle.CollectOrphansAsync(OrphanConfirmDelay, cancellationToken).ConfigureAwait(false);
            progress?.Report(5);
            var inner = new Progress<double>(p => progress?.Report(5 + (p * 0.95)));
            var result = await _swap.RunAllAsync(MetadataMode.Maintenance, inner, cancellationToken).ConfigureAwait(false);
            _logger.Info($"[ListPlaceholders] Maintenance done: {removed} deleted list(s) cleaned up, {result.Inserted} item(s) swapped in, {result.Retired} placeholder(s) completed.");
            progress?.Report(100);
        }
    }
}
