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

        // In-memory cache of recently requested seasons to avoid duplicates (keyed by tmdbId_seasonNumber, global across all users)
        private readonly Dictionary<string, DateTime> _requestedSeasons = new();
        private readonly object _requestCacheLock = new();

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

            var series = episode.Series;
            var seasonNumber = episode.ParentIndexNumber.Value;
            var episodeNumber = episode.IndexNumber.Value;

            _logger.Info($"[Auto-Season-Request] Checking '{series.Name}' S{seasonNumber}E{episodeNumber}");

            // Check this specific season for auto-season-request, passing the current episode number
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
                _logger.Warning($"[Auto-Season-Request] Could not find TMDB ID for series '{series.Name}'");
                return;
            }

            // Get the total episode count for this season from TMDB/Jellyseerr
            var totalEpisodesInSeason = await GetTotalEpisodesInSeasonFromTmdb(tmdbId, currentSeasonNumber);
            if (totalEpisodesInSeason == null || totalEpisodesInSeason <= 0)
            {
                _logger.Warning($"[Auto-Season-Request] Could not determine total episodes for '{series.Name}' S{currentSeasonNumber} from TMDB");
                return;
            }

            // Calculate remaining episodes based on current episode position and TMDB total
            // If watching E8 out of 15 total episodes, remaining = 15 - 8 = 7 episodes left
            var remainingAfterCurrent = totalEpisodesInSeason.Value - currentEpisodeNumber;
            if (remainingAfterCurrent < 0) remainingAfterCurrent = 0;

            // Query episodes in Jellyfin for "require all watched" check if needed
            var availableEpisodesInJellyfin = 0;
            List<Episode> allEpisodes = new List<Episode>();

            if (config.AutoSeasonRequestRequireAllWatched)
            {
                var episodesQuery = new InternalItemsQuery(user)
                {
                    AncestorIds = new[] { series.Id },
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    OrderBy = new[] { (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending), (ItemSortBy.IndexNumber, JSortOrder.Ascending) }
                };

                allEpisodes = _libraryManager.GetItemsResult(episodesQuery).Items
                    .OfType<Episode>()
                    .Where(e => e.ParentIndexNumber == currentSeasonNumber)
                    .OrderBy(e => e.IndexNumber)
                    .ToList();

                availableEpisodesInJellyfin = allEpisodes.Count;
            }

            _logger.Info($"[Auto-Season-Request] Season {currentSeasonNumber}: E{currentEpisodeNumber}/{totalEpisodesInSeason} (TMDB total), {availableEpisodesInJellyfin} available in Jellyfin, {remainingAfterCurrent} episodes remaining after current (threshold: {config.AutoSeasonRequestThresholdValue})");

            // Check if threshold is met
            bool thresholdMet = remainingAfterCurrent <= config.AutoSeasonRequestThresholdValue;

            if (!thresholdMet)
            {
                _logger.Debug($"[Auto-Season-Request] Threshold not met for '{series.Name}' S{currentSeasonNumber}");
                return;
            }

            // If "Require All Episodes Watched" is enabled, verify all episodes before the threshold are watched
            bool shouldRequest = true;
            if (config.AutoSeasonRequestRequireAllWatched)
            {
                // Check that all episodes before the current one are marked as watched
                var episodesBeforeCurrent = allEpisodes.Where(e => e.IndexNumber.HasValue && e.IndexNumber.Value < currentEpisodeNumber).ToList();
                var unwatchedBeforeCurrent = episodesBeforeCurrent.Where(e =>
                {
                    var userData = _userDataManager.GetUserData(user, e);
                    return userData == null || !userData.Played;
                }).ToList();

                if (unwatchedBeforeCurrent.Any())
                {
                    shouldRequest = false;
                    var unwatchedEpisodeNumbers = string.Join(", ", unwatchedBeforeCurrent.Select(e => $"E{e.IndexNumber}"));
                    _logger.Debug($"[Auto-Season-Request] Threshold met but not all prior episodes watched for '{series.Name}' S{currentSeasonNumber}. Unwatched: {unwatchedEpisodeNumbers}");
                }
                else
                {
                    _logger.Info($"[Auto-Season-Request] Threshold met and all prior episodes watched for '{series.Name}' S{currentSeasonNumber} - requesting next season");
                }
            }

            if (!shouldRequest)
            {
                return;
            }

            // Threshold met - prepare to request next season
            var nextSeasonNumber = currentSeasonNumber + 1;

            // Check in-memory cache first (fast path to avoid redundant API calls)
            var cacheKey = $"{tmdbId}_S{nextSeasonNumber}";
            lock (_requestCacheLock)
            {
                // Clean up expired entries
                var expiredKeys = _requestedSeasons.Where(kvp => (DateTime.Now - kvp.Value).TotalHours > 1)
                    .Select(kvp => kvp.Key).ToList();
                foreach (var key in expiredKeys) _requestedSeasons.Remove(key);

                if (_requestedSeasons.TryGetValue(cacheKey, out var cachedTime) &&
                    (DateTime.Now - cachedTime).TotalHours < 1)
                {
                    _logger.Debug($"[Auto-Season-Request] Already requested S{nextSeasonNumber} for TMDB {tmdbId} (cached)");
                    return;
                }
            }

            // Get episode count for next season to verify it has started
            var nextSeasonEpisodeCount = await GetTotalEpisodesInSeasonFromTmdb(tmdbId, nextSeasonNumber);

            if (nextSeasonEpisodeCount == null || nextSeasonEpisodeCount <= 0)
            {
                _logger.Info($"[Auto-Season-Request] Season {nextSeasonNumber} has not started yet (0 episodes) - not requesting");
                return;
            }

            // Check Jellyseerr for season availability/status - always query to get latest status
            var jellyseerrStatus = await GetSeasonStatusFromJellyseerr(tmdbId, nextSeasonNumber);

            if (jellyseerrStatus == null)
            {
                _logger.Debug($"[Auto-Season-Request] Season {nextSeasonNumber} does not exist for '{series.Name}' (not available on TMDB)");
                return;
            }

            if (jellyseerrStatus.IsAvailable)
            {
                _logger.Debug($"[Auto-Season-Request] Season {nextSeasonNumber} already available on Jellyfin for '{series.Name}'");
                return;
            }

            if (jellyseerrStatus.IsRequested)
            {
                _logger.Debug($"[Auto-Season-Request] Season {nextSeasonNumber} already requested in Jellyseerr for '{series.Name}'");
                return;
            }

            // Season exists, not available, not requested - proceed with request
            var success = await RequestNextSeason(tmdbId, nextSeasonNumber, user.Id.ToString());

            if (success)
            {
                // Update cache so subsequent events for any user won't re-request
                lock (_requestCacheLock)
                {
                    _requestedSeasons[cacheKey] = DateTime.Now;
                }
                _logger.Info($"[Auto-Season-Request] ✓ Requested '{series.Name}' S{nextSeasonNumber} (TMDB: {tmdbId}) for {user.Username}");
            }
            else
            {
                _logger.Warning($"[Auto-Season-Request] ✗ Failed to request '{series.Name}' S{nextSeasonNumber} for {user.Username}");
            }
        }

        // Gets the total number of episodes in a season from TMDB
        private async Task<int?> GetTotalEpisodesInSeasonFromTmdb(string tmdbId, int seasonNumber)
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
                            _logger.Debug($"[Auto-Season-Request] Jellyseerr returned {response.StatusCode} for TMDB {tmdbId}");
                            continue;
                        }

                        var content = await response.Content.ReadAsStringAsync();
                        using (JsonDocument doc = JsonDocument.Parse(content))
                        {
                            var root = doc.RootElement;

                            // Log TMDB's reported number of seasons
                            if (root.TryGetProperty("numberOfSeasons", out var totalSeasonsProp))
                            {
                                var totalSeasons = totalSeasonsProp.GetInt32();
                                _logger.Info($"[Auto-Season-Request] TMDB reports {totalSeasons} total seasons for TMDB ID {tmdbId}");
                            }

                            // Look for the season in the response
                            if (root.TryGetProperty("seasons", out var seasonsArray))
                            {
                                foreach (var season in seasonsArray.EnumerateArray())
                                {
                                    if (season.TryGetProperty("seasonNumber", out var seasonNumProp) &&
                                        seasonNumProp.GetInt32() == seasonNumber)
                                    {
                                        // Get episode count for this season
                                        if (season.TryGetProperty("episodeCount", out var episodeCountProp))
                                        {
                                            var episodeCount = episodeCountProp.GetInt32();
                                            _logger.Info($"[Auto-Season-Request] TMDB reports {episodeCount} episodes in season {seasonNumber}");
                                            return episodeCount;
                                        }
                                    }
                                }
                            }
                        }

                        // Season not found in response
                        _logger.Info($"[Auto-Season-Request] Season {seasonNumber} not found in TMDB data (season does not exist on TMDB)");
                        return null;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Season-Request] Error checking TMDB data at {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Season-Request] Error querying TMDB episode count: {ex.Message}");
            }

            return null;
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
                            _logger.Debug($"[Auto-Season-Request] Jellyseerr returned {response.StatusCode} for TMDB {tmdbId}");
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
                                _logger.Info($"[Auto-Season-Request] Jellyseerr reports {totalSeasons} total seasons for TMDB ID {tmdbId}");
                                if (seasonNumber > totalSeasons)
                                {
                                    _logger.Info($"[Auto-Season-Request] Season {seasonNumber} does not exist on TMDB - show only has {totalSeasons} season(s)");
                                    return null; // Season doesn't exist
                                }
                            }

                            // First, check if there are any requests for this season
                            // Jellyseerr API nests requests under mediaInfo, not at root level
                            bool hasRequest = false;
                            if (root.TryGetProperty("mediaInfo", out var mediaInfoElement) &&
                                mediaInfoElement.TryGetProperty("requests", out var requestsArray))
                            {
                                _logger.Info($"[Auto-Season-Request] Jellyseerr reports {requestsArray.GetArrayLength()} request(s) for TMDB ID {tmdbId}");
                                foreach (var request in requestsArray.EnumerateArray())
                                {
                                    // Check if this request contains the season we're looking for
                                    if (request.TryGetProperty("seasons", out var requestSeasons))
                                    {
                                        foreach (var requestSeason in requestSeasons.EnumerateArray())
                                        {
                                            if (requestSeason.TryGetProperty("seasonNumber", out var requestSeasonNum) &&
                                                requestSeasonNum.GetInt32() == seasonNumber)
                                            {
                                                hasRequest = true;
                                                _logger.Info($"[Auto-Season-Request] Found existing request for season {seasonNumber}");
                                                break;
                                            }
                                        }
                                        if (hasRequest) break;
                                    }
                                }
                            }
                            else
                            {
                                _logger.Info($"[Auto-Season-Request] No mediaInfo or no requests found for TMDB ID {tmdbId}");
                            }

                            // Look for the season in the response to check availability
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
                                            _logger.Info($"[Auto-Season-Request] Jellyseerr Season {seasonNumber} raw status code: {statusValue} (5 = available)");
                                        }

                                        // Set IsRequested based on whether we found a request for this season
                                        status.IsRequested = hasRequest;

                                        _logger.Info($"[Auto-Season-Request] Season {seasonNumber} final status from Jellyseerr: Available={status.IsAvailable}, Requested={status.IsRequested}");
                                        return status;
                                    }
                                }
                            }
                        }

                        // Season not found in Jellyseerr response - it doesn't exist
                        _logger.Info($"[Auto-Season-Request] Season {seasonNumber} not found in Jellyseerr response");
                        return null;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Season-Request] Error checking Jellyseerr at {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Season-Request] Error querying Jellyseerr: {ex.Message}");
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
                _logger.Warning("[Auto-Season-Request] Jellyseerr configuration is missing");
                return false;
            }

            // Get Jellyseerr user ID
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"[Auto-Season-Request] Could not find Jellyseerr user for Jellyfin user {jellyfinUserId}");
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
                        _logger.Warning($"[Auto-Season-Request] Jellyseerr returned {response.StatusCode}: {responseContent}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Season-Request] Exception requesting season from Jellyseerr at {url}: {ex.Message}");
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
                            _logger.Warning($"[Auto-Season-Request] No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                        }
                    }
                    else
                    {
                        _logger.Warning($"[Auto-Season-Request] Failed to fetch users from Jellyseerr: {response.StatusCode}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Season-Request] Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            return null;
        }
    }
}
