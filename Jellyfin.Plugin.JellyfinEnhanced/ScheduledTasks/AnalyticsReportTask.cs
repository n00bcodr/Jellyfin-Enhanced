using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Sends the opt-in anonymous usage report on the admin-configured cadence
    /// (PluginConfiguration.AnalyticsReportIntervalDays, clamped 7-30 days).
    /// The actual due-check and no-op-when-disabled logic lives in
    /// AnalyticsReportingService.ReportIfDueAsync so it behaves identically
    /// whether triggered by this task's own default trigger or run manually
    /// from the Scheduled Tasks page.
    /// </summary>
    public class AnalyticsReportTask : IScheduledTask
    {
        private readonly AnalyticsReportingService _analyticsReportingService;

        public AnalyticsReportTask(AnalyticsReportingService analyticsReportingService)
        {
            _analyticsReportingService = analyticsReportingService;
        }

        public string Name => "Send Anonymous Usage Report";

        public string Key => "JellyfinEnhancedAnalyticsReport";

        public string Description =>
            "Sends the opt-in anonymous usage report configured in the Jellyfin Enhanced Usage Statistics section. " +
            "No-ops entirely unless enabled there, and skips silently until the configured reporting interval has elapsed.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // Runs once a day; ReportIfDueAsync is the actual cadence gate.
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.IntervalTrigger,
                    IntervalTicks = TimeSpan.FromHours(24).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            progress?.Report(0);
            await _analyticsReportingService.ReportIfDueAsync(cancellationToken).ConfigureAwait(false);
            progress?.Report(100);
        }
    }
}
