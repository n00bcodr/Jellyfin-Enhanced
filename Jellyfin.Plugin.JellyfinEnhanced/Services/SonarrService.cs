using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
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

    public class SonarrEpisode
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("seasonNumber")]
        public int SeasonNumber { get; set; }

        [JsonPropertyName("episodeNumber")]
        public int EpisodeNumber { get; set; }

        [JsonPropertyName("seriesId")]
        public int SeriesId { get; set; }
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

        /// <summary>
        /// Triggers a search in Sonarr for a TV series based on TVDB ID.
        /// Supports searching for entire series, specific season, or specific episode.
        /// </summary>
        /// <param name="sonarrUrl">Sonarr base URL</param>
        /// <param name="apiKey">Sonarr API key</param>
        /// <param name="tvdbId">TVDB ID of the series</param>
        /// <param name="seasonNumber">Season number (0 = all seasons)</param>
        /// <param name="episodeNumber">Episode number (0 = all episodes in season)</param>
        /// <returns>True if search was triggered successfully</returns>
        public async Task<bool> TriggerSearchAsync(string sonarrUrl, string apiKey, int tvdbId, int seasonNumber = 0, int episodeNumber = 0)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(sonarrUrl) || string.IsNullOrWhiteSpace(apiKey))
                {
                    _logger.Warning("Sonarr URL or API key not configured");
                    return false;
                }

                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Find series by TVDB ID
                var seriesUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/series";
                var seriesResponse = await httpClient.GetAsync(seriesUrl);

                if (!seriesResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Sonarr series. Status: {seriesResponse.StatusCode}");
                    return false;
                }

                var seriesContent = await seriesResponse.Content.ReadAsStringAsync();
                var allSeries = JsonSerializer.Deserialize<List<SonarrSeries>>(seriesContent) ?? new List<SonarrSeries>();
                var series = allSeries.FirstOrDefault(s => s.TvdbId == tvdbId);

                if (series == null)
                {
                    _logger.Warning($"Series with TVDB ID {tvdbId} not found in Sonarr");
                    return false;
                }

                _logger.Info($"Found series '{series.Title}' (ID: {series.Id}) for TVDB ID {tvdbId}");

                object commandBody;
                string commandName;

                // Determine search type
                if (seasonNumber > 0 && episodeNumber > 0)
                {
                    // Episode search - need to find episode ID first
                    var episodesUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/episode?seriesId={series.Id}";
                    var episodesResponse = await httpClient.GetAsync(episodesUrl);

                    if (!episodesResponse.IsSuccessStatusCode)
                    {
                        _logger.Warning($"Failed to fetch episodes. Status: {episodesResponse.StatusCode}");
                        return false;
                    }

                    var episodesContent = await episodesResponse.Content.ReadAsStringAsync();
                    var episodes = JsonSerializer.Deserialize<List<SonarrEpisode>>(episodesContent) ?? new List<SonarrEpisode>();
                    var episode = episodes.FirstOrDefault(e => e.SeasonNumber == seasonNumber && e.EpisodeNumber == episodeNumber);

                    if (episode == null)
                    {
                        _logger.Warning($"Episode S{seasonNumber:D2}E{episodeNumber:D2} not found in Sonarr");
                        // Fall back to season search
                        commandName = "SeasonSearch";
                        commandBody = new { name = commandName, seriesId = series.Id, seasonNumber = seasonNumber };
                        _logger.Info($"Falling back to season search for S{seasonNumber:D2}");
                    }
                    else
                    {
                        commandName = "EpisodeSearch";
                        commandBody = new { name = commandName, episodeIds = new[] { episode.Id } };
                        _logger.Info($"Triggering episode search for S{seasonNumber:D2}E{episodeNumber:D2} (Episode ID: {episode.Id})");
                    }
                }
                else if (seasonNumber > 0)
                {
                    // Season search
                    commandName = "SeasonSearch";
                    commandBody = new { name = commandName, seriesId = series.Id, seasonNumber = seasonNumber };
                    _logger.Info($"Triggering season search for S{seasonNumber:D2}");
                }
                else
                {
                    // Series search
                    commandName = "SeriesSearch";
                    commandBody = new { name = commandName, seriesId = series.Id };
                    _logger.Info($"Triggering series search for '{series.Title}'");
                }

                // Execute the command
                var commandUrl = $"{sonarrUrl.TrimEnd('/')}/api/v3/command";
                var jsonContent = JsonSerializer.Serialize(commandBody);
                var content = new StringContent(jsonContent, Encoding.UTF8, "application/json");

                var commandResponse = await httpClient.PostAsync(commandUrl, content);

                if (commandResponse.IsSuccessStatusCode)
                {
                    _logger.Info($"Sonarr {commandName} triggered successfully for '{series.Title}'");

                    // For series-level issues (no specific season), also trigger missing episode search
                    // This helps find episodes that failed to download across all monitored seasons
                    if (seasonNumber == 0)
                    {
                        await TriggerMissingEpisodeSearchAsync(httpClient, commandUrl, series.Id, series.Title);
                    }

                    return true;
                }
                else
                {
                    var errorContent = await commandResponse.Content.ReadAsStringAsync();
                    _logger.Warning($"Sonarr command failed. Status: {commandResponse.StatusCode}, Response: {errorContent}");
                    return false;
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error triggering Sonarr search for TVDB ID {tvdbId}: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Triggers a search for missing episodes in a series.
        /// This finds episodes that are monitored but haven't been downloaded yet.
        /// </summary>
        private async Task TriggerMissingEpisodeSearchAsync(HttpClient httpClient, string commandUrl, int seriesId, string seriesTitle)
        {
            try
            {
                var missingSearchBody = new { name = "MissingEpisodeSearch", seriesId = seriesId };
                var jsonContent = JsonSerializer.Serialize(missingSearchBody);
                var content = new StringContent(jsonContent, Encoding.UTF8, "application/json");

                var response = await httpClient.PostAsync(commandUrl, content);

                if (response.IsSuccessStatusCode)
                {
                    _logger.Info($"Sonarr MissingEpisodeSearch triggered successfully for '{seriesTitle}'");
                }
                else
                {
                    var errorContent = await response.Content.ReadAsStringAsync();
                    _logger.Warning($"Sonarr MissingEpisodeSearch failed for '{seriesTitle}'. Status: {response.StatusCode}");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Error triggering MissingEpisodeSearch for '{seriesTitle}': {ex.Message}");
            }
        }
    }
}
