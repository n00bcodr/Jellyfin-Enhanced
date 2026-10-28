using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Removes server-side cache entries past the age limit and, over the size cap, the least recently
    /// used ones. Runs at startup and daily; nothing happens while the cache folder doesn't exist.
    /// </summary>
    public class ServerCacheMaintenanceTask : IScheduledTask
    {
        private readonly ServerBlobCache _cache;
        private readonly Logger _logger;

        /// <summary>Creates the task.</summary>
        public ServerCacheMaintenanceTask(ServerBlobCache cache, Logger logger)
        {
            _cache = cache;
            _logger = logger;
        }

        /// <inheritdoc />
        public string Name => "Tidy the server-side cache";

        /// <inheritdoc />
        public string Key => "JellyfinEnhancedServerCacheMaintenance";

        /// <inheritdoc />
        public string Description => "Removes entries of Jellyfin Enhanced's server-side cache (TMDB artwork of titles that aren't in the library) that are older than the age limit, and the least recently used ones when it is over its size limit.";

        /// <inheritdoc />
        public string Category => "Jellyfin Enhanced";

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger },
                new TaskTriggerInfo { Type = TaskTriggerInfoType.DailyTrigger, TimeOfDayTicks = TimeSpan.FromHours(4).Ticks },
            };
        }

        /// <inheritdoc />
        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var removed = await _cache.SweepAsync(full: true, cancellationToken).ConfigureAwait(false);
            if (removed > 0) _logger.Info($"[Server cache] Tidied: {removed} entries removed.");
            progress?.Report(100);
        }
    }
}
