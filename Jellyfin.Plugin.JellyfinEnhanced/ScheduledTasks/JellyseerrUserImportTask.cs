using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
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

        public string Name => "Import Jellyfin Users to Jellyseerr";

        public string Key => "JellyfinEnhancedJellyseerrUserImport";

        public string Description => "Imports all Jellyfin users into Jellyseerr so they can use Seerr Search without needing to visit the Jellyseerr UI.\n\nAlready-imported users are automatically skipped. Configure the task triggers to run this task periodically.";

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
            var blockedIds = (config.JellyseerrImportBlockedUsers ?? string.Empty)
                .Split(new[] { ',', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(id => id.Trim().Replace("-", ""))
                .Where(id => !string.IsNullOrEmpty(id))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var userIds = jellyfinUsers
                .Select(u => u.Id.ToString().Replace("-", ""))
                .Where(id => !blockedIds.Contains(id))
                .ToList();

            _logger.Info($"[Jellyseerr User Import] Found {jellyfinUsers.Count} Jellyfin users ({userIds.Count} after excluding {blockedIds.Count} blocked).");
            progress?.Report(25);

            cancellationToken.ThrowIfCancellationRequested();

            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(30);
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = userIds });
            var imported = false;

            foreach (var url in urls)
            {
                cancellationToken.ThrowIfCancellationRequested();

                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/user/import-from-jellyfin";
                    using var requestContent = new StringContent(requestBody, Encoding.UTF8, "application/json");
                    var response = await httpClient.PostAsync(requestUri, requestContent, cancellationToken);

                    if (response.IsSuccessStatusCode)
                    {
                        var content = await response.Content.ReadAsStringAsync(cancellationToken);
                        var importedUsers = JsonSerializer.Deserialize<JsonElement>(content);
                        var importedCount = importedUsers.ValueKind == JsonValueKind.Array ? importedUsers.GetArrayLength() : 0;

                        _logger.Info($"[Jellyseerr User Import] Completed. {importedCount} new user(s) imported out of {userIds.Count} sent.");

                        // Clear user lookup caches so JIT lookups pick up newly imported users
                        JellyfinEnhancedController.ClearUserCaches();

                        imported = true;
                        break;
                    }

                    var errorContent = await response.Content.ReadAsStringAsync(cancellationToken);
                    _logger.Warning($"[Jellyseerr User Import] Import failed at {url}. Status: {response.StatusCode}. Response: {errorContent}");
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Jellyseerr User Import] Error during import at {url}: {ex}");
                }
            }

            if (!imported)
            {
                _logger.Warning("[Jellyseerr User Import] Import failed on all configured Jellyseerr URLs.");
            }

            progress?.Report(100);
        }
    }
}
