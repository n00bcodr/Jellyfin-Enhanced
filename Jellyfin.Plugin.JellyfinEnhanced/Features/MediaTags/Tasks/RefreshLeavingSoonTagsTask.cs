using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Leaving soon facts from Maintainerr or the leaving collections. Runs hourly; a run
    /// before the configured refresh interval (or a failed request's retry delay) has passed
    /// does nothing, so the interval setting is the real cadence.
    /// </summary>
    public sealed class RefreshLeavingSoonTagsTask : IScheduledTask, IConfigurableScheduledTask
    {
        private readonly TagCacheService _cache;
        public RefreshLeavingSoonTagsTask(TagCacheService cache) => _cache = cache;
        public string Name => "Refresh Leaving Soon Tags";
        public string Key => "JellyfinEnhancedRefreshLeavingSoonTags";
        public string Description => "Reads which items Maintainerr (or the configured leaving collections) will remove, for the Leaving soon status badge. Runs when the configured refresh interval has passed.";
        public string Category => "Jellyfin Enhanced";
        public bool IsHidden => !LeavingSoonSources.Configured(JellyfinEnhanced.Instance?.Configuration);
        public bool IsEnabled => true;
        public bool IsLogged => true;
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => new[] { new TaskTriggerInfo { Type = TaskTriggerInfoType.IntervalTrigger, IntervalTicks = TimeSpan.FromHours(1).Ticks } };

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            await _cache.RefreshLeavingAsync(force: false, cancellationToken).ConfigureAwait(false);
            progress.Report(100);
        }
    }
}
