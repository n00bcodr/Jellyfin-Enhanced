using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    public sealed partial class SeerrFacts
    {
        public sealed class OwnedRequest
        {
            public int TmdbId { get; init; }
            public string MediaType { get; init; } = "movie";
        }
        public static Task<List<OwnedRequest>?> ReadOwnershipAsync(IHttpClientFactory http, Logger logger, string userId)
            => ReadSeerrAsync(SeerrUse.RequestRead, _ => new SeerrOwnershipReader(http, logger).ReadAsync(userId));

        private sealed class SeerrOwnershipReader(IHttpClientFactory _httpClientFactory, Logger _logger)
        {
        public async Task<List<OwnedRequest>?> ReadAsync(string userId)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
                {
                    return null;
                }

                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var httpClient = Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim();
                    try
                    {
                        var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/request?take=500&skip=0&sort=added";
                        using var request = Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUri, config.GetJellyseerrApiKey(), userId);
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                        if (error != null)
                        {
                            _logger.Warning($"Failed to get requests from {trimmedUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                            continue;
                        }

                        var json = JsonDocument.Parse(content!);

                        if (!json.RootElement.TryGetProperty("results", out var results))
                        {
                            continue;
                        }

                        var items = new List<OwnedRequest>();

                        foreach (var item in results.EnumerateArray())
                        {
                            if (!BelongsToUser(item, userId))
                            {
                                continue;
                            }

                            var parsed = ParseRequestItem(item);
                            if (parsed != null)
                            {
                                items.Add(parsed);
                            }
                        }

                        return items;
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Failed to get requests from {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error getting Seerr requests: {ex}");
            }

            return null;
        }

        private bool BelongsToUser(JsonElement requestElement, string jellyseerrUserId)
        {
            if (requestElement.TryGetProperty("requestedBy", out var requestedBy))
            {
                if (requestedBy.ValueKind == JsonValueKind.Number && requestedBy.TryGetInt32(out var idNumber))
                {
                    return string.Equals(idNumber.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase);
                }

                if (requestedBy.ValueKind == JsonValueKind.String)
                {
                    var idStr = requestedBy.GetString();
                    if (!string.IsNullOrEmpty(idStr) && string.Equals(idStr, jellyseerrUserId, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                if (requestedBy.ValueKind == JsonValueKind.Object && requestedBy.TryGetProperty("id", out var idProp))
                {
                    if ((idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt32(out var objId) && string.Equals(objId.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase)) ||
                        (idProp.ValueKind == JsonValueKind.String && string.Equals(idProp.GetString() ?? string.Empty, jellyseerrUserId, StringComparison.OrdinalIgnoreCase)))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private OwnedRequest? ParseRequestItem(JsonElement requestElement)
        {
            int tmdbId = 0;
            string mediaType = "";

            if (requestElement.TryGetProperty("media", out var media))
            {
                if (media.TryGetProperty("tmdbId", out var tmdbProp))
                {
                    tmdbId = tmdbProp.GetInt32();
                }
                if (media.TryGetProperty("mediaType", out var mtProp) && mtProp.ValueKind == JsonValueKind.String)
                {
                    mediaType = mtProp.GetString() ?? "";
                }
            }

            if (tmdbId == 0 && requestElement.TryGetProperty("tmdbId", out var topTmdb))
            {
                tmdbId = topTmdb.GetInt32();
            }

            if (string.IsNullOrWhiteSpace(mediaType) && requestElement.TryGetProperty("mediaType", out var topMediaType) && topMediaType.ValueKind == JsonValueKind.String)
            {
                mediaType = topMediaType.GetString() ?? "";
            }

            if (tmdbId == 0 || string.IsNullOrWhiteSpace(mediaType))
            {
                return null;
            }

            return new OwnedRequest
            {
                TmdbId = tmdbId,
                MediaType = mediaType
            };
        }

        }
    }
}
