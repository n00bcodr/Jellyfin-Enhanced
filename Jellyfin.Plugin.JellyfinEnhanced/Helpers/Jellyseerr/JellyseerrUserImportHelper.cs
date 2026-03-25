using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    public static class JellyseerrUserImportHelper
    {
        /// <summary>
        /// Parse the blocked user IDs config string into a normalized HashSet (dashless, case-insensitive).
        /// </summary>
        public static HashSet<string> GetBlockedUserIds(string? blockedUsersConfig)
        {
            if (string.IsNullOrEmpty(blockedUsersConfig))
            {
                return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            }

            return blockedUsersConfig
                .Split(new[] { ',', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(id => id.Trim().Replace("-", ""))
                .Where(id => !string.IsNullOrEmpty(id))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Bulk-import user IDs into Jellyseerr, trying each configured URL until one succeeds.
        /// Returns the count of newly imported users, or -1 if all URLs failed.
        /// </summary>
        public static async Task<int> BulkImportAsync(
            List<string> userIds,
            string[] urls,
            string apiKey,
            IHttpClientFactory httpClientFactory,
            Logger logger,
            CancellationToken cancellationToken = default)
        {
            var httpClient = httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(30);
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

            var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = userIds });

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
                        return importedCount;
                    }

                    var errorContent = await response.Content.ReadAsStringAsync(cancellationToken);
                    logger.Warning($"Bulk import failed at {url}. Status: {response.StatusCode}. Response: {errorContent}");
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (HttpRequestException ex)
                {
                    logger.Debug($"Connection error during bulk import at {url}: {ex.Message}");
                }
                catch (JsonException ex)
                {
                    logger.Warning($"Invalid response from Jellyseerr during bulk import at {url}: {ex.Message}");
                }
            }

            return -1;
        }
    }
}
