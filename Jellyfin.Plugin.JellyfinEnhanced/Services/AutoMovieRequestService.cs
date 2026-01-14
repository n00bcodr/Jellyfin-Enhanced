using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class AutoMovieRequestService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        // Track which movies have already been requested to avoid duplicates (with timestamps for expiry)
        private readonly Dictionary<string, Dictionary<string, DateTime>> _requestedMovies = new();

        public AutoMovieRequestService(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _libraryManager = libraryManager;
        }

        // Checks a movie to determine if the next movie in collection should be requested.
        // Event-driven entry point called when a user starts watching a movie.
        public async Task CheckMovieForCollectionRequestAsync(BaseItem movieItem, Guid userId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AutoMovieRequestEnabled || !config.JellyseerrEnabled)
            {
                return;
            }

            if (string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                _logger.Warning("[Auto-Movie-Request] TMDB API key is not configured. Auto movie requests require TMDB API access.");
                return;
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return;
            }

            // Ensure this is a movie
            var movie = movieItem as Movie;
            if (movie == null)
            {
                return;
            }

            // Get TMDB ID
            var tmdbId = GetTmdbId(movie);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.Debug($"[Auto-Movie-Request] '{movie.Name}' has no TMDB ID");
                return;
            }

            // Get collection info from TMDB
            var collectionInfo = await GetTmdbCollectionIdAsync(tmdbId);
            if (collectionInfo == null)
            {
                // _logger.Debug($"[Auto-Movie-Request] '{movie.Name}' is not part of a TMDB collection");
                return;
            }

            _logger.Info($"[Auto-Movie-Request] '{movie.Name}' is part of {collectionInfo.Name} (TMDB collection {collectionInfo.Id})");

            // Get collection details from Jellyseerr
            var nextMovieInfo = await GetNextMovieInCollectionAsync(collectionInfo.Id, tmdbId);
            if (nextMovieInfo == null)
            {
                _logger.Debug($"[Auto-Movie-Request] No next movie found or next movie is already available/requested");
                return;
            }

            // Check if we've already requested this movie (in-memory cache with 1-hour expiry)
            var requestKey = $"{user.Id}_{nextMovieInfo.TmdbId}";
            if (!_requestedMovies.ContainsKey(user.Id.ToString()))
            {
                _requestedMovies[user.Id.ToString()] = new Dictionary<string, DateTime>();
            }

            // Check if cached and not expired (1 hour)
            if (_requestedMovies[user.Id.ToString()].TryGetValue(requestKey, out var cachedTime))
            {
                if ((DateTime.Now - cachedTime).TotalHours < 1)
                {
                    _logger.Debug($"[Auto-Movie-Request] Already requested '{nextMovieInfo.Title}' (cached)");
                    return;
                }
                else
                {
                    // Expired, remove from cache
                    _requestedMovies[user.Id.ToString()].Remove(requestKey);
                }
            }

            // Request the movie
            var success = await RequestMovie(nextMovieInfo.TmdbId.ToString(), user.Id.ToString());

            if (success)
            {
                _requestedMovies[user.Id.ToString()][requestKey] = DateTime.Now;
                _logger.Info($"[Auto-Movie-Request] ✓ Requested '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
            }
            else
            {
                _logger.Warning($"[Auto-Movie-Request] ✗ Failed to request '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
            }
        }

        // Jellyseerr movie status
        private class MovieStatus
        {
            public bool IsAvailable { get; set; }
            public bool IsRequested { get; set; }
        }

        // Collection info from TMDB
        private class CollectionInfo
        {
            public int Id { get; set; }
            public string Name { get; set; } = string.Empty;
        }

        // Movie info with title
        private class MovieInfo
        {
            public int TmdbId { get; set; }
            public string Title { get; set; } = string.Empty;
        }

        // Gets TMDB collection ID and name for a movie
        private async Task<CollectionInfo?> GetTmdbCollectionIdAsync(string tmdbId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return null;
            }

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                var requestUrl = $"https://api.themoviedb.org/3/movie/{tmdbId}?api_key={config.TMDB_API_KEY}";

                var response = await httpClient.GetAsync(requestUrl);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Debug($"[Auto-Movie-Request] TMDB returned {response.StatusCode} for movie {tmdbId}");
                    return null;
                }

                var content = await response.Content.ReadAsStringAsync();
                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;
                    if (root.TryGetProperty("belongs_to_collection", out var collectionProp))
                    {
                        if (collectionProp.ValueKind != JsonValueKind.Null &&
                            collectionProp.TryGetProperty("id", out var idProp) &&
                            collectionProp.TryGetProperty("name", out var nameProp))
                        {
                            return new CollectionInfo
                            {
                                Id = idProp.GetInt32(),
                                Name = nameProp.GetString() ?? "Unknown Collection"
                            };
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Movie-Request] Error querying TMDB: {ex.Message}");
            }

            return null;
        }

        // Gets next movie in collection from Jellyseerr collection endpoint
        private async Task<MovieInfo?> GetNextMovieInCollectionAsync(int collectionId, string currentTmdbId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            try
            {
                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Clear();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim().TrimEnd('/');
                    var requestUrl = $"{trimmedUrl}/api/v1/collection/{collectionId}";

                    try
                    {
                        var response = await httpClient.GetAsync(requestUrl);
                        if (!response.IsSuccessStatusCode)
                        {
                            _logger.Debug($"[Auto-Movie-Request] Jellyseerr returned {response.StatusCode} for collection {collectionId}");
                            continue;
                        }

                        var content = await response.Content.ReadAsStringAsync();
                        using (JsonDocument doc = JsonDocument.Parse(content))
                        {
                            var root = doc.RootElement;

                            if (root.TryGetProperty("parts", out var partsArray))
                            {
                                int? currentIndex = null;
                                int? nextIndex = null;

                                // Find current movie and next movie
                                var parts = partsArray.EnumerateArray().ToList();
                                for (int i = 0; i < parts.Count; i++)
                                {
                                    var part = parts[i];
                                    if (part.TryGetProperty("id", out var idProp) && idProp.GetInt32().ToString() == currentTmdbId)
                                    {
                                        currentIndex = i;
                                        break;
                                    }
                                }

                                if (currentIndex.HasValue && currentIndex.Value < parts.Count - 1)
                                {
                                    nextIndex = currentIndex.Value + 1;
                                    var nextPart = parts[nextIndex.Value];

                                    // Check if next movie is available or already requested
                                    if (nextPart.TryGetProperty("mediaInfo", out var mediaInfo))
                                    {
                                        if (mediaInfo.TryGetProperty("status", out var statusProp))
                                        {
                                            var statusValue = statusProp.GetInt32();
                                            // 5 = available, 2 = pending, 3 = processing
                                            if (statusValue == 5 || statusValue == 2 || statusValue == 3)
                                            {
                                                _logger.Debug($"[Auto-Movie-Request] Next movie already available or requested (status: {statusValue})");
                                                return null;
                                            }
                                        }
                                    }

                                    // Check release date if configured
                                    if (config.AutoMovieRequestCheckReleaseDate && nextPart.TryGetProperty("releaseDate", out var releaseDateProp))
                                    {
                                        var releaseDateStr = releaseDateProp.GetString();
                                        if (!string.IsNullOrEmpty(releaseDateStr) && DateTime.TryParse(releaseDateStr, out var releaseDate))
                                        {
                                            if (releaseDate > DateTime.Now)
                                            {
                                                _logger.Debug($"[Auto-Movie-Request] Next movie is not yet released (release date: {releaseDate:yyyy-MM-dd}), skipping");
                                                return null;
                                            }
                                        }
                                    }

                                    // Return next movie's TMDB ID and title
                                    if (nextPart.TryGetProperty("id", out var nextIdProp) &&
                                        nextPart.TryGetProperty("title", out var titleProp))
                                    {
                                        return new MovieInfo
                                        {
                                            TmdbId = nextIdProp.GetInt32(),
                                            Title = titleProp.GetString() ?? "Unknown Title"
                                        };
                                    }
                                }
                                else
                                {
                                    // _logger.Debug($"[Auto-Movie-Request] Current movie is the last in collection or not found");
                                    return null;
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Movie-Request] Error checking Jellyseerr at {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Movie-Request] Error querying Jellyseerr collection: {ex.Message}");
            }

            return null;
        }

        // Gets TMDB ID from movie metadata
        private string? GetTmdbId(Movie movie)
        {
            if (movie.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
            {
                return tmdbId;
            }
            return null;
        }

        // Requests a movie from Jellyseerr
        private async Task<bool> RequestMovie(string tmdbId, string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("[Auto-Movie-Request] Jellyseerr configuration is missing");
                return false;
            }

            // Get Jellyseerr user ID
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"[Auto-Movie-Request] Could not find Jellyseerr user for Jellyfin user {jellyfinUserId}");
                return false;
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);
            httpClient.DefaultRequestHeaders.Add("X-Api-User", jellyseerrUserId);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/request";

                    var requestBody = new
                    {
                        mediaType = "movie",
                        mediaId = int.Parse(tmdbId)
                    };

                    var jsonContent = JsonSerializer.Serialize(requestBody);
                    var content = new StringContent(jsonContent, Encoding.UTF8, "application/json");

                    var response = await httpClient.PostAsync(requestUri, content);
                    var responseContent = await response.Content.ReadAsStringAsync();

                    if (response.IsSuccessStatusCode)
                    {
                        return true;
                    }
                    else
                    {
                        _logger.Warning($"[Auto-Movie-Request] Jellyseerr returned {response.StatusCode}: {responseContent}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Movie-Request] Exception requesting movie from Jellyseerr at {url}: {ex.Message}");
                }
            }

            return false;
        }

        // Gets the Jellyseerr user ID for a Jellyfin user
        private async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            // Normalize the Jellyfin user ID (remove dashes for comparison)
            var normalizedJellyfinUserId = jellyfinUserId.Replace("-", "").ToLowerInvariant();

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000";
                    var response = await httpClient.GetAsync(requestUri);

                    if (response.IsSuccessStatusCode)
                    {
                        var content = await response.Content.ReadAsStringAsync();
                        var usersResponse = JsonSerializer.Deserialize<JsonElement>(content);

                        if (usersResponse.TryGetProperty("results", out var usersArray))
                        {
                            foreach (var userElement in usersArray.EnumerateArray())
                            {
                                if (userElement.TryGetProperty("jellyfinUserId", out var jfUserId) &&
                                    userElement.TryGetProperty("id", out var id))
                                {
                                    var jellyseerrJfUserId = jfUserId.GetString();
                                    if (!string.IsNullOrEmpty(jellyseerrJfUserId))
                                    {
                                        // Normalize both IDs for comparison (remove dashes)
                                        var normalizedJellyseerrId = jellyseerrJfUserId.Replace("-", "").ToLowerInvariant();

                                        if (normalizedJellyseerrId == normalizedJellyfinUserId)
                                        {
                                            return id.GetInt32().ToString();
                                        }
                                    }
                                }
                            }
                            _logger.Warning($"[Auto-Movie-Request] No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                        }
                    }
                    else
                    {
                        _logger.Warning($"[Auto-Movie-Request] Failed to fetch users from Jellyseerr: {response.StatusCode}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Movie-Request] Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            return null;
        }

        // Clears the request cache (useful for testing or resetting)
        public void ClearRequestCache()
        {
            _requestedMovies.Clear();
            _logger.Info("[Auto-Movie-Request] Cleared auto movie request cache");
        }
    }
}
