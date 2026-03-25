using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    public class JellyseerrUserImportTask : IScheduledTask
    {
        private readonly IUserManager _userManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        public JellyseerrUserImportTask(
            IUserManager userManager,
            IHttpClientFactory httpClientFactory,
            Logger logger)
        {
            _userManager = userManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public string Name => "Import Jellyfin Users to Seerr";

        public string Key => "JellyfinEnhancedJellyseerrUserImport";

        public string Description => "Imports all Jellyfin users into Seerr so they can use Seerr Search without needing to visit the Seerr UI.\n\nAlready imported users are automatically skipped. Configure the task triggers to run this task periodically.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.IntervalTrigger,
                    IntervalTicks = TimeSpan.FromHours(6).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.JellyseerrAutoImportUsers || !config.JellyseerrEnabled)
            {
                _logger.Info("[Jellyseerr User Import] Auto-import is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("[Jellyseerr User Import] Jellyseerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            _logger.Info("[Jellyseerr User Import] Starting Jellyseerr user import task...");
            progress?.Report(0);

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var jellyfinUsers = _userManager.Users.ToList();
            var blockedIds = JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            var userIds = jellyfinUsers
                .Select(u => u.Id.ToString().Replace("-", ""))
                .Where(id => !blockedIds.Contains(id))
                .ToList();

            _logger.Info($"[Jellyseerr User Import] Found {jellyfinUsers.Count} Jellyfin users ({userIds.Count} after excluding {blockedIds.Count} blocked).");
            progress?.Report(25);

            var importedCount = await JellyseerrUserImportHelper.BulkImportAsync(
                userIds, urls, config.JellyseerrApiKey, _httpClientFactory, _logger, cancellationToken);

            if (importedCount >= 0)
            {
                JellyfinEnhancedController.ClearUserCaches();
                _logger.Info($"[Jellyseerr User Import] Completed. {importedCount} new user(s) imported out of {userIds.Count} sent.");
            }
            else
            {
                _logger.Warning("[Jellyseerr User Import] Import failed on all configured Jellyseerr URLs.");
            }

            progress?.Report(100);
        }
    }
}
