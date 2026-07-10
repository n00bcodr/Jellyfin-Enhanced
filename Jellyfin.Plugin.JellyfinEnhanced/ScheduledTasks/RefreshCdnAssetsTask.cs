using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Warms and refreshes the local CDN cache. Downloads every "mutable" static asset
    /// (icons, fonts, theme colour sheets, logos, the fallback poster, …) into the
    /// plugin's on-disk cache so clients — which only ever hit the local
    /// <c>/JellyfinEnhanced/cdn/…</c> route — always get a fresh copy without touching
    /// any external CDN. Runs on startup and every 24 hours.
    /// </summary>
    public class RefreshCdnAssetsTask : IScheduledTask
    {
        private readonly Logger _logger;
        private readonly CdnAssetService _cdnAssetService;

        public RefreshCdnAssetsTask(Logger logger, CdnAssetService cdnAssetService)
        {
            _logger = logger;
            _cdnAssetService = cdnAssetService;
        }

        public string Name => "Refresh CDN Assets";

        public string Key => "JellyfinEnhancedRefreshCdnAssets";

        public string Description => "Downloads and refreshes the local copies of external CDN assets (icons, fonts, theme colours, logos) so clients are served them from the plugin instead of third-party CDNs. Runs on startup and every 24 hours.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // Warm the cache on startup, then keep it current on a 24h cadence.
            yield return new TaskTriggerInfo
            {
                Type = TaskTriggerInfoType.StartupTrigger
            };
            yield return new TaskTriggerInfo
            {
                Type = TaskTriggerInfoType.IntervalTrigger,
                IntervalTicks = TimeSpan.FromHours(24).Ticks
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            try
            {
                _logger.Info("[CDN] Refreshing local CDN asset cache…");
                await _cdnAssetService.RefreshKnownAsync(progress, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                _logger.Info("[CDN] CDN asset refresh cancelled.");
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"[CDN] CDN asset refresh failed: {ex}");
                throw;
            }
            finally
            {
                progress?.Report(100);
            }
        }
    }
}
