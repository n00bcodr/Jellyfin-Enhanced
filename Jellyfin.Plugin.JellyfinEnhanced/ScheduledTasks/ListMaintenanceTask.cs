using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Daily list maintenance (Requests &amp; downloads lists; nothing while lists are off): removes the data of deleted lists,
    /// old list operations and delivered swap-in events. With the maintenance switch it also refreshes the metadata of
    /// incomplete/undated entries (release dates, expected episodes, production state) and runs a full pass, which settles
    /// interrupted swaps and, on lists with swap-in consent, puts arrived titles in their place. It never asks for anything.
    /// </summary>
    public class ListMaintenanceTask : IScheduledTask
    {
        private readonly ListSwapService _swap;
        private readonly ListLifecycle _lifecycle;
        private readonly Logger _logger;
        private readonly ListOperations? _operations;
        private readonly ListEventStore? _events;
        private readonly ListLinks? _links;

        /// <summary>Creates the task.</summary>
        /// <param name="swap">Swap service.</param>
        /// <param name="lifecycle">List lifecycle (orphan sweep).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="operations">Durable list operations (old ones removed).</param>
        /// <param name="events">Swap-in events (delivered ones removed after 30 days).</param>
        /// <param name="links">Request links (links of removed entries dropped).</param>
        public ListMaintenanceTask(ListSwapService swap, ListLifecycle lifecycle, Logger logger, ListOperations? operations = null, ListEventStore? events = null, ListLinks? links = null)
        {
            _swap = swap;
            _lifecycle = lifecycle;
            _logger = logger;
            _operations = operations;
            _events = events;
            _links = links;
        }

        /// <inheritdoc />
        public string Name => "Requests & downloads: list maintenance";

        /// <inheritdoc />
        public string Key => "JellyfinEnhancedListMaintenance";

        /// <inheritdoc />
        public string Description => "Removes the list data of deleted playlists and collections; with list maintenance on, refreshes release dates and episode lists of titles not in the library yet and settles titles that arrived (on lists whose editor turned swap-in on).";

        /// <inheritdoc />
        public string Category => "Jellyfin Enhanced";

        /// <summary>Delay between the two existence checks of the orphan sweep (tests shorten it).</summary>
        internal TimeSpan OrphanConfirmDelay { get; set; } = ListLifecycle.ConfirmDelay;

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
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ListFlags.Lists(config))
            {
                _logger.Info("[Lists] Maintenance skipped: lists are off.");
                progress?.Report(100);
                return;
            }

            var removed = await _lifecycle.CollectOrphansAsync(OrphanConfirmDelay, cancellationToken).ConfigureAwait(false);
            try
            {
                _operations?.Purge(DateTimeOffset.UtcNow);
                _events?.Purge(DateTimeOffset.UtcNow);
                _links?.PruneOrphans();
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Lists] Maintenance: cleaning up list rows failed: {ex.Message}");
            }

            progress?.Report(5);
            if (!ListFlags.Maintenance(config))
            {
                _logger.Info($"[Lists] Maintenance: {removed} deleted list(s) cleaned up; metadata refresh and the full pass are off.");
                progress?.Report(100);
                return;
            }

            var inner = new Progress<double>(p => progress?.Report(5 + (p * 0.95)));
            var result = await _swap.RunAllAsync(MetadataMode.Maintenance, inner, cancellationToken).ConfigureAwait(false);
            _logger.Info($"[Lists] Maintenance done: {removed} deleted list(s) cleaned up, {result.Inserted} item(s) swapped in, {result.Retired} entr(y/ies) completed.");
            progress?.Report(100);
        }
    }
}
