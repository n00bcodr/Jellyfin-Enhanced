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
        /// Result of a bulk import attempt. <see cref="Imported"/> is the count
        /// of users that Seerr created; <see cref="Errors"/> is per-URL error
        /// messages (or single "all unreachable" entry on full network failure).
        /// <see cref="Reached"/> is true if at least one URL responded with
        /// HTTP — the throttle/cache should NOT fire on a full network outage.
        /// </summary>
        public class BulkImportResult
        {
            public int Imported { get; set; }
            public bool Reached { get; set; }
            public List<string> Errors { get; set; } = new();
        }

        /// <summary>
        /// Bulk-import user IDs into Jellyseerr, trying each configured URL.
        /// Audit CRIT-4: previously returned just an int that conflated
        /// "0 imported because all collided" with "0 imported because nothing
        /// to do" with "all URLs failed." Now reports each cause distinctly
        /// so the controller can decide whether to flush caches and consume
        /// the throttle slot.
        /// </summary>
        public static async Task<BulkImportResult> BulkImportAsync(
            List<string> userIds,
            string[] urls,
            string apiKey,
            IHttpClientFactory httpClientFactory,
            Logger logger,
            CancellationToken cancellationToken = default)
        {
            var result = new BulkImportResult();
            var httpClient = httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(30);

            var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = userIds });

            foreach (var url in urls)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var trimmedUrl = url.Trim();
                var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/user/import-from-jellyfin";

                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(
                        HttpMethod.Post, requestUri, apiKey, bodyJson: requestBody);
                    using var response = await httpClient.SendAsync(request, cancellationToken);
                    result.Reached = true;

                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri, cancellationToken);
                    if (error != null)
                    {
                        var msg = $"Import failed at {trimmedUrl}: {error.Code} {error.HttpStatus} — {error.Message}";
                        logger.Warning(msg);
                        result.Errors.Add(msg);
                        continue;
                    }

                    var importedUsers = JsonSerializer.Deserialize<JsonElement>(json!);
                    var importedCount = importedUsers.ValueKind == JsonValueKind.Array ? importedUsers.GetArrayLength() : 0;
                    result.Imported = importedCount;
                    return result;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (HttpRequestException ex)
                {
                    logger.Debug($"Connection error during bulk import at {trimmedUrl}: {ex.Message}");
                    result.Errors.Add($"Connection error at {trimmedUrl}: {ex.Message}");
                }
                catch (JsonException ex)
                {
                    logger.Warning($"Invalid response from Jellyseerr during bulk import at {trimmedUrl}: {ex.Message}");
                    result.Errors.Add($"Invalid response at {trimmedUrl}: {ex.Message}");
                    result.Reached = true;
                }
            }

            if (!result.Reached && result.Errors.Count == 0)
            {
                result.Errors.Add("Could not reach any configured Jellyseerr URL.");
            }
            return result;
        }
    }
}
