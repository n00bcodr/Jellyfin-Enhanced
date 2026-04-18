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
    public class RadarrMovie
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("tmdbId")]
        public int TmdbId { get; set; }

        [JsonPropertyName("imdbId")]
        public string? ImdbId { get; set; }

        [JsonPropertyName("tags")]
        public List<int> Tags { get; set; } = new List<int>();
    }

    public class RadarrTag
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("label")]
        public string Label { get; set; } = string.Empty;
    }

    public class RadarrService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        public RadarrService(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public async Task<Dictionary<int, List<string>>> GetMovieTagsByTmdbId(string radarrUrl, string apiKey, CancellationToken ct = default)
        {
            var result = new Dictionary<int, List<string>>();

            // SSRF guard: reject before any outbound request so scheduled-task callers
            // cannot be pointed at metadata/loopback targets via instance URL.
            if (!Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrUrlGuard.IsAllowedUrl(radarrUrl))
            {
                _logger.Error($"Refusing to fetch Radarr tags — URL rejected by SSRF guard: {radarrUrl}");
                return result;
            }

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Get all tags first
                _logger.Info($"Fetching Radarr tags from {radarrUrl}");
                var tagsUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/tag";
                var tagsResponse = await httpClient.GetAsync(tagsUrl, ct);

                if (!tagsResponse.IsSuccessStatusCode)
                {
                    _logger.Error($"Failed to fetch Radarr tags. Status: {tagsResponse.StatusCode}");
                    return result;
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync(ct);
                var tags = JsonSerializer.Deserialize<List<RadarrTag>>(tagsContent) ?? new List<RadarrTag>();
                var tagDictionary = tags.ToDictionary(t => t.Id, t => t.Label);

                _logger.Info($"Found {tags.Count} tags in Radarr");

                // Get all movies
                _logger.Info($"Fetching Radarr movies from {radarrUrl}");
                var moviesUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/movie";
                var moviesResponse = await httpClient.GetAsync(moviesUrl, ct);

                if (!moviesResponse.IsSuccessStatusCode)
                {
                    _logger.Error($"Failed to fetch Radarr movies. Status: {moviesResponse.StatusCode}");
                    return result;
                }

                var moviesContent = await moviesResponse.Content.ReadAsStringAsync(ct);
                var movies = JsonSerializer.Deserialize<List<RadarrMovie>>(moviesContent) ?? new List<RadarrMovie>();

                _logger.Info($"Found {movies.Count} movies in Radarr");

                // Map tags to movies
                foreach (var movie in movies)
                {
                    if (movie.TmdbId > 0 && movie.Tags.Count > 0)
                    {
                        var movieTags = new List<string>();
                        foreach (var tagId in movie.Tags)
                        {
                            if (tagDictionary.TryGetValue(tagId, out var tagLabel))
                            {
                                movieTags.Add(tagLabel);
                            }
                        }

                        if (movieTags.Count > 0)
                        {
                            result[movie.TmdbId] = movieTags;
                        }
                    }
                }

                _logger.Info($"Mapped tags for {result.Count} movies");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // Let the scheduled task's cancellation path observe the cancel instead of
                // flattening it into an empty "success" result.
                throw;
            }
            catch (HttpRequestException ex)
            {
                _logger.Error($"Network error fetching Radarr tags: {ex.Message}");
            }
            catch (TaskCanceledException ex)
            {
                _logger.Error($"Timeout fetching Radarr tags: {ex.Message}");
            }
            catch (JsonException ex)
            {
                _logger.Error($"Invalid JSON from Radarr tags endpoint: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.Error($"Unexpected error fetching Radarr tags: {ex.Message}");
            }

            return result;
        }
    }
}
