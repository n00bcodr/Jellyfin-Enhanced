using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
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

        public class BulkImportResult
        {
            public int Imported { get; set; }
            public bool Reached { get; set; }
            public List<string> Errors { get; set; } = new();
        }

        public static Task<BulkImportResult> BulkImportAsync(
            List<string> userIds,
            string[] urls,
            string apiKey,
            IHttpClientFactory httpClientFactory,
            Logger logger,
            CancellationToken cancellationToken = default,
            Func<List<string>, List<string>?>? recheck = null)
            => EffectiveRequestsBackend.Shared.CheckSeerr(SeerrUse.UserImport).Allowed
                ? Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.UserImport, cancellationToken,
                    ct => BulkImportCoreAsync(userIds, urls, apiKey, httpClientFactory, logger, ct, recheck))
                : BulkImportCoreAsync(userIds, urls, apiKey, httpClientFactory, logger, cancellationToken, recheck);

        private static async Task<BulkImportResult> BulkImportCoreAsync(
            List<string> userIds,
            string[] urls,
            string apiKey,
            IHttpClientFactory httpClientFactory,
            Logger logger,
            CancellationToken cancellationToken,
            Func<List<string>, List<string>?>? recheck)
        {
            var result = new BulkImportResult();
            if (!EffectiveRequestsBackend.Shared.CheckSeerr(SeerrUse.UserImport).Allowed)
            {
                logger.Info("[RequestsBackend] Seerr import denied: backend_disabled");
                result.Errors.Add("backend_disabled");
                return result;
            }
            var httpClient = SeerrHttpHelper.CreateClient(httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(30);

            foreach (var url in urls)
            {
                cancellationToken.ThrowIfCancellationRequested();
                // An automatic run asks again before every address (the next one after a failure included): the ids
                // still allowed now, or null to stop.
                if (recheck != null && (userIds = recheck(userIds) ?? new List<string>()).Count == 0)
                {
                    logger.Info("[Jellyseerr User Import] Auto-import was turned off (or everyone left is blocked) during the run; stopping");
                    result.Errors.Add("Stopped: auto-import was turned off or everyone left is blocked.");
                    break;
                }
                var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = userIds });
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
                catch (BackendDisabledException ex)
                {
                    result.Errors.Add(ex.Reason);
                    break;
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
