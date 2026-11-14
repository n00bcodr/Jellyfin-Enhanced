using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Leaving soon facts from Maintainerr or the leaving collections. Runs hourly; a run
    /// before the configured refresh interval (or a failed request's retry delay) has passed
    /// does nothing, so the interval setting is the real cadence. It does nothing at all
    /// while no badge, home row or Maintainerr action uses the facts.
    /// </summary>
    public sealed class RefreshLeavingSoonTagsTask : IScheduledTask, IConfigurableScheduledTask
    {
        private readonly TagCacheService _cache;
        private readonly UserConfigurationManager _users;
        private readonly Logger _logger;

        public RefreshLeavingSoonTagsTask(TagCacheService cache, UserConfigurationManager users, Logger logger)
        {
            _cache = cache;
            _users = users;
            _logger = logger;
        }

        public string Name => "Refresh Leaving Soon Tags";
        public string Key => "JellyfinEnhancedRefreshLeavingSoonTags";
        public string Description => "Reads which items Maintainerr (or the configured leaving collections) will remove, for the Leaving soon status badge. Runs when the configured refresh interval has passed, and only while something uses the Leaving soon data.";
        public string Category => "Jellyfin Enhanced";
        public bool IsHidden => !LeavingSoonService.Configured(JellyfinEnhanced.Instance?.Configuration);
        public bool IsEnabled => true;
        public bool IsLogged => true;
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => new[] { new TaskTriggerInfo { Type = TaskTriggerInfoType.IntervalTrigger, IntervalTicks = TimeSpan.FromHours(1).Ticks } };

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!LeavingSoonService.Consumed(config, AnyUserShowsBadge))
            {
                _logger.Debug("[LeavingSoon] Scheduled refresh skipped: no source is set, or nothing uses the Leaving soon data.");
                progress.Report(100);
                return;
            }

            await _cache.RefreshLeavingAsync(force: false, cancellationToken).ConfigureAwait(false);
            _logger.Debug("[LeavingSoon] Scheduled refresh checked (it only contacts the source once the refresh interval has passed).");
            progress.Report(100);
        }

        private bool AnyUserShowsBadge()
            => _users.GetAllUserIds().Any(id => _users.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").StatusTagsLeaving);
    }
}
