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

        // Track which seasons have already been requested to avoid duplicates (with timestamps for expiry)
        private readonly Dictionary<string, Dictionary<string, DateTime>> _requestedSeasons = new();

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
        // Event-driven entry point called when a user finishes or starts watching an episode.
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
            if (episode == null || episode.Series == null || !episode.ParentIndexNumber.HasValue || !episode.IndexNumber.HasValue)
            {
                return;
            }

            // Skip if this episode is already marked played to avoid replays triggering new requests
            var episodeUserData = _userDataManager.GetUserData(user, episode);
            if (episodeUserData?.Played == true)
            {
                _logger.Debug($"[Auto-Request] Episode '{episode.Name}' is already played for {user.Username}, skipping auto-request check");
                return;
            }

            var series = episode.Series;
            var seasonNumber = episode.ParentIndexNumber.Value;
            var episodeNumber = episode.IndexNumber.Value;

            _logger.Info($"[Auto-Request] Checking '{series.Name}' S{seasonNumber}E{episodeNumber}");

            // Check this specific season for auto-request, passing the current episode number
            await CheckSeasonForAutoRequest(series, seasonNumber, episodeNumber, user);
        }

        // Checks if a specific season needs its next season requested
        private async Task CheckSeasonForAutoRequest(Series series, int currentSeasonNumber, int currentEpisodeNumber, JUser user)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return;
            }

            // Get TMDB ID first - we'll need it for Jellyseerr checks
            var tmdbId = GetTmdbId(series);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.Warning($"[Auto-Request] Could not find TMDB ID for series '{series.Name}'");
                return;
            }

            // Query all episodes in the current season using the series as parent
            var episodesQuery = new InternalItemsQuery(user)
            {
                AncestorIds = new[] { series.Id },
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                Recursive = true,
                OrderBy = new[] { (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending), (ItemSortBy.IndexNumber, JSortOrder.Ascending) }
            };

            var allEpisodes = _libraryManager.GetItemsResult(episodesQuery).Items
                .OfType<Episode>()
                .Where(e => e.ParentIndexNumber == currentSeasonNumber)
                .OrderBy(e => e.IndexNumber)
                .ToList();

            if (allEpisodes.Count == 0)
            {
                _logger.Debug($"[Auto-Request] No episodes found in season {currentSeasonNumber} of '{series.Name}'");
                return;
            }

            var totalEpisodes = allEpisodes.Count;

            // Calculate remaining episodes based on current episode position
            // If watching E8 out of 10 episodes, remaining = 10 - 8 = 2 episodes left
            var remainingAfterCurrent = totalEpisodes - currentEpisodeNumber;
            if (remainingAfterCurrent < 0) remainingAfterCurrent = 0;

            _logger.Info($"[Auto-Request] Season {currentSeasonNumber}: E{currentEpisodeNumber}/{totalEpisodes}, {remainingAfterCurrent} episodes remaining after current (threshold: {config.AutoSeasonRequestThresholdValue})");

            // Check if threshold is met
            bool thresholdMet = remainingAfterCurrent <= config.AutoSeasonRequestThresholdValue;

            if (!thresholdMet)
            {
                _logger.Debug($"[Auto-Request] Threshold not met for '{series.Name}' S{currentSeasonNumber}");
                return;
            }

            // If "Require All Episodes Watched" is enabled, verify all episodes before the threshold are watched
            bool shouldRequest = true;
            AutoSeasonRequestThresholdValue
            {
                // Check that all episodes up to the current one are marked as watched
                var episodesBeforeCurrent = allEpisodes.Where(e => e.IndexNumber.HasValue && e.IndexNumber.Value <= currentEpisodeNumber).ToList();
                var unwatchedBeforeCurrent = episodesBeforeCurrent.Where(e =>
                {
                    var userData = _userDataManager.GetUserData(user, e);
                    return userData == null || !userData.Played;
                }).ToList();

                if (unwatchedBeforeCurrent.Any())
                {
                    shouldRequest = false;
                    var unwatchedEpisodeNumbers = string.Join(", ", unwatchedBeforeCurrent.Select(e => $"E{e.IndexNumber}"));
                    _logger.Debug($"[Auto-Request] Threshold met but not all prior episodes watched for '{series.Name}' S{currentSeasonNumber}. Unwatched: {unwatchedEpisodeNumbers}");
                }
                else
                {
                    _logger.Info($"[Auto-Request] Threshold met and all prior episodes watched for '{series.Name}' S{currentSeasonNumber} - requesting next season");
                }
            }

            if (!shouldRequest)
            {
                return;
            }

            // Threshold met - prepare to request next season
            var nextSeasonNumber = currentSeasonNumber + 1;

            // Check if we've already requested this season (in-memory cache with 1-hour expiry)
            var requestKey = $"{user.Id}_{series.Id}_{nextSeasonNumber}";
            if (!_requestedSeasons.ContainsKey(user.Id.ToString()))
            {
                _requestedSeasons[user.Id.ToString()] = new Dictionary<string, DateTime>();
            }

            // Check if cached and not expired (1 hour)
            if (_requestedSeasons[user.Id.ToString()].TryGetValue(requestKey, out var cachedTime))
            {
                if ((DateTime.Now - cachedTime).TotalHours < 1)
                {
                    _logger.Debug($"[Auto-Request] Already requested '{series.Name}' S{nextSeasonNumber} (cached)");
                    return;
                }
                else
                {
                    // Expired, remove from cache
                    _requestedSeasons[user.Id.ToString()].Remove(requestKey);
                }
            }

            // Check Jellyseerr for season availability/status
            var jellyseerrStatus = await GetSeasonStatusFromJellyseerr(tmdbId, nextSeasonNumber);

            if (jellyseerrStatus == null)
            {
                _logger.Debug($"[Auto-Request] Season {nextSeasonNumber} does not exist for '{series.Name}' (not available on TMDB)");
                _requestedSeasons[user.Id.ToString()][requestKey] = DateTime.Now; // Mark as checked to avoid repeated attempts
                return;
            }

            if (jellyseerrStatus.IsAvailable)
            {
                _logger.Debug($"[Auto-Request] Season {nextSeasonNumber} already available on Jellyfin for '{series.Name}'");
                _requestedSeasons[user.Id.ToString()][requestKey] = DateTime.Now;
                return;
            }

            if (jellyseerrStatus.IsRequested)
            {
                _logger.Debug($"[Auto-Request] Season {nextSeasonNumber} already requested in Jellyseerr for '{series.Name}'");
                _requestedSeasons[user.Id.ToString()][requestKey] = DateTime.Now;
                return;
            }

            // Season exists, not available, not requested - proceed with request
            var success = await RequestNextSeason(tmdbId, nextSeasonNumber, user.Id.ToString());

            if (success)
            {
                _requestedSeasons[user.Id.ToString()][requestKey] = DateTime.Now;
                _logger.Info($"[Auto-Request] ✓ Requested '{series.Name}' S{nextSeasonNumber} (TMDB: {tmdbId}) for {user.Username}");
            }
            else
            {
                _logger.Warning($"[Auto-Request] ✗ Failed to request '{series.Name}' S{nextSeasonNumber} for {user.Username}");
            }
        }

        // Jellyseerr season status
        private class SeasonStatus
        {
            public bool IsAvailable { get; set; }
            public bool IsRequested { get; set; }
        }

        // Gets season status from Jellyseerr
        private async Task<SeasonStatus?> GetSeasonStatusFromJellyseerr(string tmdbId, int seasonNumber)
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
                    var requestUrl = $"{trimmedUrl}/api/v1/tv/{tmdbId}";

                    try
                    {
                        var response = await httpClient.GetAsync(requestUrl);
                        if (!response.IsSuccessStatusCode)
                        {
                            _logger.Debug($"[Auto-Request] Jellyseerr returned {response.StatusCode} for TMDB {tmdbId}");
                            continue;
                        }

                        var content = await response.Content.ReadAsStringAsync();
                        using (JsonDocument doc = JsonDocument.Parse(content))
                        {
                            var root = doc.RootElement;

                            // Check if the show has this many seasons in TMDB
                            // numberOfSeasons tells us how many seasons exist/have aired
                            if (root.TryGetProperty("numberOfSeasons", out var totalSeasonsProp))
                            {
                                var totalSeasons = totalSeasonsProp.GetInt32();
                                if (seasonNumber > totalSeasons)
                                {
                                    _logger.Debug($"[Auto-Request] Season {seasonNumber} does not exist - show only has {totalSeasons} season(s)");
                                    return null; // Season doesn't exist
                                }
                            }

                            // Look for the season in the response
                            if (root.TryGetProperty("seasons", out var seasonsArray))
                            {
                                foreach (var season in seasonsArray.EnumerateArray())
                                {
                                    if (season.TryGetProperty("seasonNumber", out var seasonNumProp) &&
                                        seasonNumProp.GetInt32() == seasonNumber)
                                    {
                                        var status = new SeasonStatus();

                                        // Check if season is available (status 5 = available)
                                        if (season.TryGetProperty("status", out var statusProp))
                                        {
                                            var statusValue = statusProp.GetInt32();
                                            status.IsAvailable = statusValue == 5;
                                            status.IsRequested = statusValue == 2 || statusValue == 3; // 2=pending, 3=processing
                                        }

                                        _logger.Debug($"[Auto-Request] Season {seasonNumber} status from Jellyseerr: Available={status.IsAvailable}, Requested={status.IsRequested}");
                                        return status;
                                    }
                                }
                            }
                        }

                        // Season not found in Jellyseerr response - it doesn't exist
                        return null;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Request] Error checking Jellyseerr at {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Request] Error querying Jellyseerr: {ex.Message}");
            }

            return null;
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
