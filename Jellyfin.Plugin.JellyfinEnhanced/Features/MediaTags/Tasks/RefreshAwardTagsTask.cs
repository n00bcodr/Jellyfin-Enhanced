using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>Shared Awards enrichment, daily by default and runnable on demand from the dashboard.</summary>
    public sealed class RefreshAwardTagsTask : IScheduledTask, IConfigurableScheduledTask
    {
        private readonly TagCacheService _cache;
        public RefreshAwardTagsTask(TagCacheService cache) => _cache = cache;
        public string Name => "Refresh Awards Tags";
        public string Key => "JellyfinEnhancedRefreshAwardTags";
        public string Description => "Refreshes IMDb/Letterboxd chart membership, Certified Fresh and Oscar/Emmy wins. Cached results respect the configured refresh interval and provider retry limits.";
        public string Category => "Jellyfin Enhanced";
        public bool IsHidden => JellyfinEnhanced.Instance?.Configuration.AwardsTagsEnabled != true;
        public bool IsEnabled => true;
        public bool IsLogged => true;
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => new[] { new TaskTriggerInfo { Type = TaskTriggerInfoType.DailyTrigger, TimeOfDayTicks = TimeSpan.FromHours(4).Ticks } };
        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken) => _cache.RefreshAwardsAsync(progress, cancellationToken);
    }
}
