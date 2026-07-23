using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Scheduled task that reconciles the server-side tag cache against Jellyfin item saves.
    /// Runs daily at 3 AM. Can also be run manually from the admin dashboard.
    /// On startup, the cache is loaded from disk instead (TagCacheMonitor handles
    /// any items added/changed while the server was off via Jellyfin's library scan events).
    /// </summary>
    public class BuildTagCacheTask : IScheduledTask
    {
        private readonly TagCacheService _tagCacheService;
        private readonly TagCacheMonitor _tagCacheMonitor;
        private readonly Logger _logger;

        public BuildTagCacheTask(TagCacheService tagCacheService, TagCacheMonitor tagCacheMonitor, Logger logger)
        {
            _tagCacheService = tagCacheService;
            _tagCacheMonitor = tagCacheMonitor;
            _logger = logger;
        }

        public string Name => "Refresh Tag Cache";

        public string Key => "JellyfinEnhancedBuildTagCache";

        public string Description => "Builds the tag cache when needed, otherwise refreshes only entries for added, changed, and removed library items.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks
                }
            };
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            // Honor the "Server-Side Tag Cache" admin setting: when disabled, the
            // cache is fully out of service (released by the config transition
            // hook), so this task must not build or reconcile anything. Re-enable
            // catch-up is handled by that hook; this gate just keeps the daily
            // trigger and manual runs from doing work the admin opted out of.
            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true)
            {
                _logger.Info("[TagCache] Server-Side Tag Cache is disabled; skipping cache refresh (tags will use batch fallback).");
                progress.Report(100);
                return Task.CompletedTask;
            }

            // Subscribe BEFORE building, not after: on the first run after
            // re-enabling the setting, no monitor is attached yet, and a long
            // full build would miss every item changed while it runs. Subscribed
            // first, those changes queue as pending ids (the flush defers while
            // the rebuild lock is held) and apply to the new cache after the swap.
            _tagCacheMonitor.EnsureSubscribed();
            _tagCacheService.ReconcileCache(progress, cancellationToken);
            return Task.CompletedTask;
        }
    }
}
