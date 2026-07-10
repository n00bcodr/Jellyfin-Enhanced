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
            _tagCacheService.ReconcileCache(progress, cancellationToken);
            // Ensure the monitor is subscribed to events after the first build
            _tagCacheMonitor.EnsureSubscribed();
            return Task.CompletedTask;
        }
    }
}
