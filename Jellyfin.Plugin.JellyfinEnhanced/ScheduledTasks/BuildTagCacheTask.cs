using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Scheduled task that builds the server-side tag cache for all library items.
    /// Runs on startup and daily at 3 AM.
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

        public string Name => "Build Tag Cache";

        public string Key => "JellyfinEnhancedBuildTagCache";

        public string Description => "Pre-computes tag data (genres, ratings, languages, quality stream info) for all library items. Clients load this cache in a single request instead of making per-page API calls.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.StartupTrigger
                },
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks
                }
            };
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            _tagCacheService.BuildFullCache(progress, cancellationToken);
            // Ensure the monitor is subscribed to events after the first build
            _tagCacheMonitor.EnsureSubscribed();
            return Task.CompletedTask;
        }
    }
}
