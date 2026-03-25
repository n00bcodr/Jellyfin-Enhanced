using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
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
            var jellyseerrUrl = urls.FirstOrDefault()?.Trim();

            if (string.IsNullOrEmpty(jellyseerrUrl))
            {
                _logger.Warning("[Jellyseerr User Import] No valid Jellyseerr URL found.");
                progress?.Report(100);
                return;
            }

            var jellyfinUsers = _userManager.Users.ToList();
            var userIds = jellyfinUsers.Select(u => u.Id.ToString()).ToList();

            _logger.Info($"[Jellyseerr User Import] Found {userIds.Count} Jellyfin users to import.");
            progress?.Report(25);

            cancellationToken.ThrowIfCancellationRequested();

            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(30);
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = userIds });
            using var requestContent = new StringContent(requestBody, Encoding.UTF8, "application/json");

            try
            {
                var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/user/import-from-jellyfin";
                var response = await httpClient.PostAsync(requestUri, requestContent, cancellationToken);

                progress?.Report(75);

                if (response.IsSuccessStatusCode)
                {
                    var content = await response.Content.ReadAsStringAsync(cancellationToken);
                    var importedUsers = JsonSerializer.Deserialize<JsonElement>(content);
                    var importedCount = importedUsers.ValueKind == JsonValueKind.Array ? importedUsers.GetArrayLength() : 0;

                    _logger.Info($"[Jellyseerr User Import] Completed. {importedCount} new user(s) imported, {userIds.Count - importedCount} already existed.");
                }
                else
                {
                    var errorContent = await response.Content.ReadAsStringAsync(cancellationToken);
                    _logger.Warning($"[Jellyseerr User Import] Import failed. Status: {response.StatusCode}. Response: {errorContent}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyseerr User Import] Error during import: {ex.Message}");
            }

            progress?.Report(100);
        }
    }
}
