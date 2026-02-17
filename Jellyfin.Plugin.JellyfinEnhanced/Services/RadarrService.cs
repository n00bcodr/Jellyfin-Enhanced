using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
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
        /// Find Radarr movies whose tags start with the given prefix and return their TMDB IDs.
        /// Used for tag-based request matching: Seerr tags follow "{seerrUserId} - {username}" format,
        /// so matching by prefix (e.g. "8 - ") identifies items requested by a specific user.
        /// </summary>
        public async Task<List<int>> GetTmdbIdsMatchingTagPrefix(string radarrUrl, string apiKey, string tagPrefix)
        {
            var result = new List<int>();

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

                // Fetch all tags
                var tagsUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/tag";
                var tagsResponse = await httpClient.GetAsync(tagsUrl);

                if (!tagsResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Radarr tags for prefix matching. Status: {tagsResponse.StatusCode}");
                    return result;
                }

                var tagsContent = await tagsResponse.Content.ReadAsStringAsync();
                var tags = JsonSerializer.Deserialize<List<RadarrTag>>(tagsContent) ?? new List<RadarrTag>();

                // Find tag IDs whose label starts with the prefix
                var matchingTagIds = tags
                    .Where(t => t.Label.StartsWith(tagPrefix, StringComparison.OrdinalIgnoreCase))
                    .Select(t => t.Id)
                    .ToHashSet();

                if (matchingTagIds.Count == 0)
                {
                    return result;
                }

                // Fetch all movies and find those with matching tags
                var moviesUrl = $"{radarrUrl.TrimEnd('/')}/api/v3/movie";
                var moviesResponse = await httpClient.GetAsync(moviesUrl);

                if (!moviesResponse.IsSuccessStatusCode)
                {
                    _logger.Warning($"Failed to fetch Radarr movies for prefix matching. Status: {moviesResponse.StatusCode}");
                    return result;
                }

                var moviesContent = await moviesResponse.Content.ReadAsStringAsync();
                var movies = JsonSerializer.Deserialize<List<RadarrMovie>>(moviesContent) ?? new List<RadarrMovie>();

                result = movies
                    .Where(m => m.TmdbId > 0 && m.Tags.Any(t => matchingTagIds.Contains(t)))
                    .Select(m => m.TmdbId)
                    .ToList();

                _logger.Info($"Found {result.Count} Radarr movies matching tag-based request filter");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error fetching Radarr movies by tag prefix: {ex.Message}");
            }

            return result;
        }
    }
}
