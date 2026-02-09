using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// Scheduled task that signals all clients to clear cached translations on next page load.
    public partial class ClearTranslationCacheTask : IScheduledTask
    {
        private readonly Logger _logger;

        public ClearTranslationCacheTask(Logger logger)
        {
            _logger = logger;
        }

        public string Name => "Refresh Translation Cache";

        public string Key => "JellyfinEnhancedClearTranslationCache";

        public string Description => "Signals all clients to refresh cached translations on next page load. Runs on startup to ensure fresh translations after plugin updates.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.StartupTrigger
                }
            };
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                _logger.Warning("[Clear Translation Cache] Plugin configuration is not available.");
                progress?.Report(100);
                return Task.CompletedTask;
            }

            config.ClearTranslationCacheTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            JellyfinEnhanced.Instance!.SaveConfiguration();

            _logger.Info($"[Clear Translation Cache] Translation cache clear signal set at {new DateTimeOffset(DateTimeOffset.FromUnixTimeMilliseconds(config.ClearTranslationCacheTimestamp).DateTime, TimeSpan.Zero):O}. All clients will clear their translation cache on next page load.");

            progress?.Report(100);
            return Task.CompletedTask;
        }
    }
}
