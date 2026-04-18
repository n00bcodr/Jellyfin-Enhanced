using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class SonarrSeries
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("tvdbId")]
        public int TvdbId { get; set; }

        [JsonPropertyName("imdbId")]
        public string? ImdbId { get; set; }

        [JsonPropertyName("tags")]
        public List<int> Tags { get; set; } = new List<int>();
    }

    public class SonarrTag
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("label")]
        public string Label { get; set; } = string.Empty;
    }

    public class SonarrService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        public SonarrService(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public async Task<Dictionary<string, List<string>>> GetSeriesTagsByTvdbId(string sonarrUrl, string apiKey, CancellationToken ct = default)
        {
            var result = new Dictionary<string, List<string>>();

            // SSRF guard: reject before any outbound request so scheduled-task callers
            // cannot be pointed at metadata/loopback targets via instance URL.
            if (!Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrUrlGuard.IsAllowedUrl(sonarrUrl))
            {
                _logger.Error($"Refusing to fetch Sonarr tags — URL rejected by SSRF guard: {sonarrUrl}");
                return result;
            }

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Get all tags first
                _logger.Info($"Fetching Sonarr tags from {sonarrUrl}");
                var tagsUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/tag";
                var tagsResponse = await httpClient.GetAsync(tagsUrl, ct);

                if (!tagsResponse.IsSuccessStatusCode)
                {
                    _logger.Error($"Failed to fetch Sonarr tags. Status: {tagsResponse.StatusCode}");
                    return result;
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync(ct);
                var tags = JsonSerializer.Deserialize<List<SonarrTag>>(tagsContent) ?? new List<SonarrTag>();
                var tagDictionary = tags.ToDictionary(t => t.Id, t => t.Label);

                _logger.Info($"Found {tags.Count} tags in Sonarr");

                // Get all series
                _logger.Info($"Fetching Sonarr series from {sonarrUrl}");
                var seriesUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/series";
                var seriesResponse = await httpClient.GetAsync(seriesUrl, ct);

                if (!seriesResponse.IsSuccessStatusCode)
                {
                    _logger.Error($"Failed to fetch Sonarr series. Status: {seriesResponse.StatusCode}");
                    return result;
                }

                var seriesContent = await seriesResponse.Content.ReadAsStringAsync(ct);
                var allSeries = JsonSerializer.Deserialize<List<SonarrSeries>>(seriesContent) ?? new List<SonarrSeries>();

                _logger.Info($"Found {allSeries.Count} series in Sonarr");

                // Map tags to series - use ImdbId as key since Jellyfin uses it
                foreach (var series in allSeries)
                {
                    if (!string.IsNullOrEmpty(series.ImdbId) && series.Tags.Count > 0)
                    {
                        var seriesTags = new List<string>();
                        foreach (var tagId in series.Tags)
                        {
                            if (tagDictionary.TryGetValue(tagId, out var tagLabel))
                            {
                                seriesTags.Add(tagLabel);
                            }
                        }

                        if (seriesTags.Count > 0)
                        {
                            result[series.ImdbId] = seriesTags;
                        }
                    }
                }

                _logger.Info($"Mapped tags for {result.Count} series");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;  // propagate cancel up to the scheduled task
            }
            catch (HttpRequestException ex)
            {
                _logger.Error($"Network error fetching Sonarr tags: {ex.Message}");
            }
            catch (TaskCanceledException ex)
            {
                _logger.Error($"Timeout fetching Sonarr tags: {ex.Message}");
            }
            catch (JsonException ex)
            {
                _logger.Error($"Invalid JSON from Sonarr tags endpoint: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.Error($"Unexpected error fetching Sonarr tags: {ex.Message}");
            }

            return result;
        }
    }
}
