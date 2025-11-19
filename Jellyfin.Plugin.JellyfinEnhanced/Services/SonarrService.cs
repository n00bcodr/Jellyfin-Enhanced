using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
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

        public async Task<Dictionary<string, List<string>>> GetSeriesTagsByTvdbId(string sonarrUrl, string apiKey)
        {
            var result = new Dictionary<string, List<string>>();

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Get all tags first
                _logger.Info($"Fetching Sonarr tags from {sonarrUrl}");
                var tagsUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/tag";
                var tagsResponse = await httpClient.GetAsync(tagsUrl);

                if (!tagsResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Sonarr tags. Status: {tagsResponse.StatusCode}");
                    return result;
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync();
                var tags = JsonSerializer.Deserialize<List<SonarrTag>>(tagsContent) ?? new List<SonarrTag>();
                var tagDictionary = tags.ToDictionary(t => t.Id, t => t.Label);

                _logger.Info($"Found {tags.Count} tags in Sonarr");

                // Get all series
                _logger.Info($"Fetching Sonarr series from {sonarrUrl}");
                var seriesUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/series";
                var seriesResponse = await httpClient.GetAsync(seriesUrl);

                if (!seriesResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Sonarr series. Status: {seriesResponse.StatusCode}");
                    return result;
                }

                var seriesContent = await seriesResponse.Content.ReadAsStringAsync();
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
            catch (Exception ex)
            {
                _logger.Error($"Error fetching Sonarr tags: {ex.Message}");
            }

            return result;
        }
    }
}
