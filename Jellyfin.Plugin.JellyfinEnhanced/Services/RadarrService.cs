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

        public async Task<Dictionary<int, List<string>>> GetMovieTagsByTmdbId(string radarrUrl, string apiKey)
        {
            var result = new Dictionary<int, List<string>>();

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Get all tags first
                _logger.Info($"Fetching Radarr tags from {radarrUrl}");
                var tagsUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/tag";
                var tagsResponse = await httpClient.GetAsync(tagsUrl);

                if (!tagsResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Radarr tags. Status: {tagsResponse.StatusCode}");
                    return result;
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync();
                var tags = JsonSerializer.Deserialize<List<RadarrTag>>(tagsContent) ?? new List<RadarrTag>();
                var tagDictionary = tags.ToDictionary(t => t.Id, t => t.Label);

                _logger.Info($"Found {tags.Count} tags in Radarr");

                // Get all movies
                _logger.Info($"Fetching Radarr movies from {radarrUrl}");
                var moviesUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/movie";
                var moviesResponse = await httpClient.GetAsync(moviesUrl);

                if (!moviesResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Radarr movies. Status: {moviesResponse.StatusCode}");
                    return result;
                }

                var moviesContent = await moviesResponse.Content.ReadAsStringAsync();
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
            catch (Exception ex)
            {
                _logger.Error($"Error fetching Radarr tags: {ex.Message}");
            }

            return result;
        }

        /// <summary>
        /// Triggers a search in Radarr for a movie based on TMDB ID.
        /// </summary>
        /// <param name="radarrUrl">Radarr base URL</param>
        /// <param name="apiKey">Radarr API key</param>
        /// <param name="tmdbId">TMDB ID of the movie</param>
        /// <returns>True if search was triggered successfully</returns>
        public async Task<bool> TriggerSearchAsync(string radarrUrl, string apiKey, int tmdbId)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(radarrUrl) || string.IsNullOrWhiteSpace(apiKey))
                {
                    _logger.Warning("Radarr URL or API key not configured");
                    return false;
                }

                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Find movie by TMDB ID
                var moviesUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/movie";
                var moviesResponse = await httpClient.GetAsync(moviesUrl);

                if (!moviesResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Radarr movies. Status: {moviesResponse.StatusCode}");
                    return false;
                }

                var moviesContent = await moviesResponse.Content.ReadAsStringAsync();
                var allMovies = JsonSerializer.Deserialize<List<RadarrMovie>>(moviesContent) ?? new List<RadarrMovie>();
                var movie = allMovies.FirstOrDefault(m => m.TmdbId == tmdbId);

                if (movie == null)
                {
                    _logger.Warning($"Movie with TMDB ID {tmdbId} not found in Radarr");
                    return false;
                }

                _logger.Info($"Found movie '{movie.Title}' (ID: {movie.Id}) for TMDB ID {tmdbId}");

                // Trigger movie search
                var commandUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/command";
                var commandBody = new { name = "MoviesSearch", movieIds = new[] { movie.Id } };
                var jsonContent = JsonSerializer.Serialize(commandBody);
                var content = new StringContent(jsonContent, Encoding.UTF8, "application/json");

                var commandResponse = await httpClient.PostAsync(commandUrl, content);

                if (commandResponse.IsSuccessStatusCode)
                {
                    _logger.Info($"Radarr MoviesSearch triggered successfully for '{movie.Title}'");
                    return true;
                }
                else
                {
                    var errorContent = await commandResponse.Content.ReadAsStringAsync();
                    _logger.Warning($"Radarr command failed. Status: {commandResponse.StatusCode}, Response: {errorContent}");
                    return false;
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error triggering Radarr search for TMDB ID {tmdbId}: {ex.Message}");
                return false;
            }
        }
    }
}
