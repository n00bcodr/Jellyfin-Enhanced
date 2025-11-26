using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class AutoSeasonRequestService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;

        // Track which seasons have already been requested to avoid duplicates
        private readonly Dictionary<string, HashSet<string>> _requestedSeasons = new();

        public AutoSeasonRequestService(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
        }

        // Checks a completed episode to determine if next season should be requested.
        // Event-driven entry point called when a user finishes watching an episode.
        public async Task CheckEpisodeCompletionAsync(BaseItem episodeItem, Guid userId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AutoSeasonRequestEnabled || !config.JellyseerrEnabled)
            {
                return;
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return;
            }

            // Get the series this episode belongs to
            var episode = episodeItem as Episode;
            if (episode == null || episode.Series == null || !episode.ParentIndexNumber.HasValue)
            {
                return;
            }

            var series = episode.Series;
            _logger.Info($"[Auto-Request] Checking '{series.Name}' S{episode.ParentIndexNumber}E{episode.IndexNumber}");

            // Check this specific season for auto-request
            await CheckSeasonForAutoRequest(series, episode.ParentIndexNumber.Value, user);
        }

        // Checks if a specific season needs its next season requested
        private async Task CheckSeasonForAutoRequest(Series series, int currentSeasonNumber, JUser user)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return;
            }

            // Get all seasons for this series that have at least one episode
            var seasonsQuery = new InternalItemsQuery(user)
            {
                Parent = series,
                IncludeItemTypes = new[] { BaseItemKind.Season },
                Recursive = false
            };

            var seasons = _libraryManager.GetItemsResult(seasonsQuery).Items
                .OfType<Season>()
                .Where(s => s.IndexNumber.HasValue && s.IndexNumber.Value > 0) // Exclude specials (Season 0)
                .OrderBy(s => s.IndexNumber)
                .ToList();

            // Filter to only seasons that have at least one episode
            seasons = seasons.Where(season =>
            {
                var episodeCheck = new InternalItemsQuery(user)
                {
                    Parent = season,
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Limit = 1
                };
                return _libraryManager.GetItemsResult(episodeCheck).Items.Count > 0;
            }).ToList();

            if (seasons.Count == 0)
            {
                return;
            }

            // Find the current season being watched
            var currentSeason = seasons.FirstOrDefault(s => s.IndexNumber == currentSeasonNumber);
            if (currentSeason == null)
            {
                _logger.Debug($"[Auto-Request] Season {currentSeasonNumber} not found for '{series.Name}'");
                return;
            }

            // Check if the next season already exists locally
            var nextSeasonNumber = currentSeasonNumber + 1;
            var nextSeasonExists = seasons.Any(s => s.IndexNumber == nextSeasonNumber);

            if (nextSeasonExists)
            {
                _logger.Debug($"[Auto-Request] Season {nextSeasonNumber} already exists locally for '{series.Name}', no request needed");
                return;
            }

            _logger.Debug($"[Auto-Request] Checking season {currentSeasonNumber} of '{series.Name}' (next season {nextSeasonNumber} not available locally)");

            // Get all episodes in the current season
            var episodesQuery = new InternalItemsQuery(user)
            {
                Parent = currentSeason,
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                Recursive = false,
                OrderBy = new[] { (ItemSortBy.IndexNumber, JSortOrder.Ascending) }
            };

            var episodes = _libraryManager.GetItemsResult(episodesQuery).Items.ToList();

            if (episodes.Count == 0)
            {
                return;
            }

            // Calculate remaining unwatched episodes
            var remainingEpisodes = CalculateRemainingEpisodes(episodes, user);
            var watchedEpisodes = episodes.Count - remainingEpisodes;

            _logger.Info($"[Auto-Request] Season {currentSeasonNumber}: {watchedEpisodes}/{episodes.Count} watched, {remainingEpisodes} remaining (threshold: {config.AutoSeasonRequestThresholdValue})");

            bool shouldRequest = remainingEpisodes <= config.AutoSeasonRequestThresholdValue;

            if (shouldRequest)
            {
                // Check if we've already requested this season
                var requestKey = $"{user.Id}_{series.Id}_{currentSeasonNumber}";
                if (!_requestedSeasons.ContainsKey(user.Id.ToString()))
                {
                    _requestedSeasons[user.Id.ToString()] = new HashSet<string>();
                }

                if (_requestedSeasons[user.Id.ToString()].Contains(requestKey))
                {
                    _logger.Debug($"[Auto-Request] Already requested next season for '{series.Name}' S{nextSeasonNumber} (cached)");
                    return;
                }

                // Get TMDB ID to request the next season
                var tmdbId = GetTmdbId(series);
                if (string.IsNullOrEmpty(tmdbId))
                {
                    _logger.Warning($"[Auto-Request] Could not find TMDB ID for series '{series.Name}' - cannot make request");
                    return;
                }
                var success = await RequestNextSeason(tmdbId, nextSeasonNumber, user.Id.ToString());

                if (success)
                {
                    _requestedSeasons[user.Id.ToString()].Add(requestKey);
                    _logger.Info($"[Auto-Request] ✓ Requested '{series.Name}' S{nextSeasonNumber} (TMDB: {tmdbId}) for {user.Username}");
                }
                else
                {
                    _logger.Warning($"[Auto-Request] ✗ Failed to request '{series.Name}' S{nextSeasonNumber} for {user.Username}");
                }
            }
            else
            {
                _logger.Debug($"[Auto-Request] Threshold not met for '{series.Name}' S{currentSeasonNumber}");
            }
        }

        // Calculates remaining unwatched episodes
        private int CalculateRemainingEpisodes(
            List<BaseItem> episodes,
            JUser user)
        {
            int remainingEpisodes = 0;

            foreach (var episode in episodes)
            {
                var userData = _userDataManager.GetUserData(user, episode);

                // If episode hasn't been watched (completed)
                if (userData == null || !userData.Played)
                {
                    remainingEpisodes++;
                }
            }

            return remainingEpisodes;
        }

        // Gets TMDB ID from series metadata
        private string? GetTmdbId(Series series)
        {
            if (series.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
            {
                return tmdbId;
            }
            return null;
        }

        // Requests the next season from Jellyseerr
        private async Task<bool> RequestNextSeason(string tmdbId, int seasonNumber, string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("[Auto-Request] Jellyseerr configuration is missing");
                return false;
            }

            // Get Jellyseerr user ID
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"[Auto-Request] Could not find Jellyseerr user for Jellyfin user {jellyfinUserId}");
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
                        mediaType = "tv",
                        mediaId = int.Parse(tmdbId),
                        seasons = new[] { seasonNumber }
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
                        _logger.Warning($"[Auto-Request] Jellyseerr returned {response.StatusCode}: {responseContent}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Request] Exception requesting season from Jellyseerr at {url}: {ex.Message}");
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
                            _logger.Warning($"[Auto-Request] No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                        }
                    }
                    else
                    {
                        _logger.Warning($"[Auto-Request] Failed to fetch users from Jellyseerr: {response.StatusCode}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Request] Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            return null;
        }

        // Clears the request cache (useful for testing or resetting)
        public void ClearRequestCache()
        {
            _requestedSeasons.Clear();
            _logger.Info("[Auto-Request] Cleared auto season request cache");
        }
    }
}
