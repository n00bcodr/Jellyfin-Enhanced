using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services
{
    // Reads one user's Seerr watchlist. The endpoint takes only `page`: Seerr 3.x rejects
    // `take` (and any other unknown query parameter) with HTTP 400, and the page size is
    // fixed by Seerr. Pages are followed using the response's own `totalPages`.
    internal static class SeerrWatchlistReader
    {
        // Seerr's fixed watchlist page size, used only when a response has no totalPages.
        private const int FallbackPageSize = 20;
        private const int MaxPages = 1000;

        /// <summary>
        /// All items on the user's Seerr watchlist as "movie:603" style keys, or null when any
        /// page could not be read, so an unreadable list is never mistaken for an empty one.
        /// </summary>
        public static async Task<HashSet<string>?> ReadKeysAsync(
            HttpClient httpClient, string seerrUrl, string seerrUserId, string apiKey,
            Action<string>? log = null, CancellationToken cancellationToken = default)
        {
            var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                for (var page = 1; page <= MaxPages; page++)
                {
                    var uri = $"{seerrUrl.TrimEnd('/')}/api/v1/user/{seerrUserId}/watchlist?page={page}";
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, apiKey, seerrUserId);
                    using var response = await httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    var (content, error) = await SeerrHttpHelper.ReadResponseAsync(response, uri, cancellationToken).ConfigureAwait(false);
                    if (error != null)
                    {
                        log?.Invoke($"Seerr watchlist fetch failed: code={error.Code} status={error.HttpStatus}");
                        return null;
                    }

                    var json = JsonSerializer.Deserialize<JsonElement>(content!);
                    if (!json.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                    {
                        log?.Invoke("Seerr watchlist response has no results array");
                        return null;
                    }

                    var count = 0;
                    foreach (var item in results.EnumerateArray())
                    {
                        count++;
                        var tmdbId = item.TryGetProperty("tmdbId", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt32() : 0;
                        var mediaType = item.TryGetProperty("mediaType", out var m) ? m.GetString() ?? string.Empty : string.Empty;
                        if (tmdbId > 0 && mediaType.Length > 0) keys.Add($"{mediaType}:{tmdbId}");
                    }

                    if (json.TryGetProperty("totalPages", out var total) && total.ValueKind == JsonValueKind.Number)
                    {
                        if (page >= total.GetInt32()) return keys;
                    }
                    else if (count < FallbackPageSize)
                    {
                        return keys;
                    }
                }

                log?.Invoke("Seerr watchlist pagination safety cap hit");
                return null;
            }
            catch (Exception ex)
            {
                log?.Invoke($"Error fetching Seerr watchlist: {ex.Message}");
                return null;
            }
        }
    }
}
