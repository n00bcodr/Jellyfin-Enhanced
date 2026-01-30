using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Monitors library additions to automatically add requested media to user watchlists.
    // Queries Jellyseerr API directly to check if added items were requested by users.
    public class WatchlistMonitor : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;

        public WatchlistMonitor(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            UserConfigurationManager userConfigurationManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _httpClientFactory = httpClientFactory;
            _userConfigurationManager = userConfigurationManager;
            _logger = logger;
        }

        // Initialize and start monitoring library events.
        public void Initialize()
        {
            // Only initialize if the watchlist feature is enabled in plugin configuration.
            var config = JellyfinEnhanced.Instance?.Configuration as Configuration.PluginConfiguration;
            if (config == null)
            {
                _logger.Warning("[Watchlist] Configuration is null - skipping watchlist monitoring initialization");
                return;
            }

            if (!config.AddRequestedMediaToWatchlist || !config.JellyseerrEnabled)
            {
                _logger.Info("[Watchlist] Watchlist monitoring is disabled in configuration - not subscribing to library events");
                return;
            }

            _logger.Info("[Watchlist] Initializing library event monitoring");
            _libraryManager.ItemAdded += OnItemAdded;
            _libraryManager.ItemUpdated += OnItemUpdated;
            _logger.Info("[Watchlist] Successfully subscribed to library ItemAdded and ItemUpdated events");
        }

        // Handle library item added events to check if they match pending watchlist items.
        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            _ = ProcessItemForWatchlist(e, "ItemAdded");
        }


        // Handle library item updated events (fires after metadata refresh) to check if they match pending watchlist items.
        private void OnItemUpdated(object? sender, ItemChangeEventArgs e)
        {
            _ = ProcessItemForWatchlist(e, "ItemUpdated");
        }


        // Process an item from library events to check if it matches any Jellyseerr requests.
        private async Task ProcessItemForWatchlist(ItemChangeEventArgs e, string eventType)
        {
            try
            {
                // Only process movies and TV series - check this first to avoid spam
                var itemKind = e.Item?.GetBaseItemKind();
                if (itemKind != BaseItemKind.Movie && itemKind != BaseItemKind.Series)
                {
                    return;
                }

                // _logger.Info($"[Watchlist] {eventType} event triggered for: {e.Item?.Name ?? "Unknown"} (Type: {itemKind})");

                // Check if watchlist feature is enabled
                var config = JellyfinEnhanced.Instance?.Configuration as PluginConfiguration;
                if (config == null)
                {
                    _logger.Warning("[Watchlist] Configuration is null");
                    return;
                }

                if (!config.AddRequestedMediaToWatchlist)
                {
                    _logger.Debug("[Watchlist] AddRequestedMediaToWatchlist is disabled");
                    return;
                }

                if (!config.JellyseerrEnabled)
                {
                    _logger.Debug("[Watchlist] JellyseerrEnabled is disabled");
                    return;
                }

                // Check if item has TMDB ID
                if (e.Item?.ProviderIds == null)
                {
                    _logger.Debug($"[Watchlist] [{eventType}] Item has no ProviderIds yet: {e.Item?.Name}");
                    return;
                }

                if (!e.Item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdString))
                {
                    _logger.Debug($"[Watchlist] [{eventType}] Item has no TMDB ID yet: {e.Item.Name}");
                    return;
                }

                if (!int.TryParse(tmdbIdString, out var tmdbId))
                {
                    _logger.Warning($"[Watchlist] Invalid TMDB ID format: {tmdbIdString}");
                    return;
                }

                var mediaType = itemKind == BaseItemKind.Movie ? "movie" : "tv";
                // _logger.Info($"[Watchlist] New {mediaType} added to library: '{e.Item.Name}' (TMDB: {tmdbId})");

                // Query Jellyseerr for ALL requests in a single API call
                var jellyseerrUrl = config.JellyseerrUrls?.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
                if (string.IsNullOrEmpty(jellyseerrUrl) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    _logger.Warning("[Watchlist] Jellyseerr URL or API key not configured");
                    return;
                }

                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

                // Fetch all requests at once (no X-Api-User header = all requests)
                var allRequests = await GetAllJellyseerrRequests(httpClient, jellyseerrUrl);
                if (allRequests == null || allRequests.Count == 0)
                {
                    return;
                }

                // Find requests matching this TMDB ID and media type
                var matchingRequests = allRequests.Where(r => r.TmdbId == tmdbId && r.MediaType == mediaType && !string.IsNullOrEmpty(r.RequestedByJellyfinUserId)).ToList();

                if (matchingRequests.Count == 0)
                {
                    return;
                }

                // Add to watchlist for each user who requested it (only log if actually added)
                var addedCount = 0;
                var addedUsers = new List<string>();

                foreach (var request in matchingRequests)
                {
                    var jellyfinUserId = request.RequestedByJellyfinUserId!.Replace("-", "");
                    var user = _userManager.Users.FirstOrDefault(u => u.Id.ToString().Replace("-", "").Equals(jellyfinUserId, StringComparison.OrdinalIgnoreCase));

                    if (user == null)
                    {
                        continue;
                    }

                    // Check if prevention is enabled and item was already processed
                    if (config.PreventWatchlistReAddition)
                    {
                        var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                        if (processedItems.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == mediaType))
                        {
                            continue; // Skip this user, item was already processed
                        }
                    }

                    var userData = _userDataManager.GetUserData(user, e.Item);
                    if (userData != null && userData.Likes != true)
                    {
                        userData.Likes = true;
                        _userDataManager.SaveUserData(user, e.Item, userData, UserDataSaveReason.UpdateUserRating, default);
                        addedCount++;
                        addedUsers.Add(user.Username);

                        // Mark as processed if prevention is enabled
                        if (config.PreventWatchlistReAddition)
                        {
                            var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                            processedItems.Items.Add(new ProcessedWatchlistItem
                            {
                                TmdbId = tmdbId,
                                MediaType = mediaType,
                                ProcessedAt = System.DateTime.UtcNow,
                                Source = "monitor"
                            });
                            _userConfigurationManager.SaveProcessedWatchlistItems(user.Id, processedItems);
                        }
                    }
                    else if (userData != null && userData.Likes == true && config.PreventWatchlistReAddition)
                    {
                        // Item is already in watchlist, mark as processed if not already marked
                        var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                        if (!processedItems.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == mediaType))
                        {
                            processedItems.Items.Add(new ProcessedWatchlistItem
                            {
                                TmdbId = tmdbId,
                                MediaType = mediaType,
                                ProcessedAt = System.DateTime.UtcNow,
                                Source = "existing"
                            });
                            _userConfigurationManager.SaveProcessedWatchlistItems(user.Id, processedItems);
                        }
                    }
                }

                // Only log if we actually added the item to at least one watchlist
                if (addedCount > 0)
                {
                    _logger.Info($"[Watchlist] ✓ Added '{e.Item.Name}' to watchlist for {string.Join(", ", addedUsers)}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Watchlist] Error in ProcessItemForWatchlist: {ex.Message}\nStack trace: {ex.StackTrace}");
            }
        }

        // Get ALL requests from Jellyseerr in a single API call
        private async Task<List<RequestItemWithUser>?> GetAllJellyseerrRequests(HttpClient httpClient, string jellyseerrUrl)
        {
            try
            {
                var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/request?take=1000&skip=0&sort=added&filter=all";

                var response = await httpClient.GetAsync(requestUri);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"[Watchlist] Failed to fetch requests from Jellyseerr: {response.StatusCode}");
                    return null;
                }

                var content = await response.Content.ReadAsStringAsync();
                var json = JsonSerializer.Deserialize<JsonElement>(content);

                if (!json.TryGetProperty("results", out var resultsArray))
                {
                    _logger.Warning("[Watchlist] Requests response missing results array");
                    return null;
                }

                var items = new List<RequestItemWithUser>();
                foreach (var item in resultsArray.EnumerateArray())
                {
                    var parsed = ParseRequestItemWithUser(item);
                    if (parsed != null)
                    {
                        items.Add(parsed);
                    }
                }

                return items;
            }
            catch (Exception ex)
            {
                _logger.Error($"[Watchlist] Error fetching all requests: {ex.Message}");
                return null;
            }
        }

        // Parse a request item including the requesting user's Jellyfin ID
        private RequestItemWithUser? ParseRequestItemWithUser(JsonElement item)
        {
            try
            {
                int? tmdbId = null;
                string? mediaType = null;
                string? requestedByJellyfinUserId = null;

                // Get media type from root
                if (item.TryGetProperty("type", out var typeElement))
                {
                    mediaType = typeElement.GetString() switch
                    {
                        "movie" => "movie",
                        "tv" => "tv",
                        _ => null
                    };
                }

                // Get TMDB ID from media.tmdbId
                if (item.TryGetProperty("media", out var mediaElement))
                {
                    if (mediaElement.TryGetProperty("tmdbId", out var tmdbElement) && tmdbElement.ValueKind == JsonValueKind.Number)
                    {
                        tmdbId = tmdbElement.GetInt32();
                    }
                }

                // Get requesting user's Jellyfin ID from requestedBy.jellyfinUserId
                if (item.TryGetProperty("requestedBy", out var requestedByElement))
                {
                    if (requestedByElement.TryGetProperty("jellyfinUserId", out var jellyfinUserIdElement))
                    {
                        requestedByJellyfinUserId = jellyfinUserIdElement.GetString();
                    }
                }

                if (tmdbId.HasValue && mediaType != null && !string.IsNullOrEmpty(requestedByJellyfinUserId))
                {
                    return new RequestItemWithUser
                    {
                        TmdbId = tmdbId.Value,
                        MediaType = mediaType,
                        RequestedByJellyfinUserId = requestedByJellyfinUserId
                    };
                }
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Watchlist] Error parsing request item: {ex.Message}");
            }

            return null;
        }


        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Watchlist] Unsubscribing from library events");
            _libraryManager.ItemAdded -= OnItemAdded;
            _libraryManager.ItemUpdated -= OnItemUpdated;
            GC.SuppressFinalize(this);
        }

        // Model for Jellyseerr request items
        private class RequestItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = string.Empty;
        }

        // Model for Jellyseerr request items with requesting user
        private class RequestItemWithUser
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = string.Empty;
            public string? RequestedByJellyfinUserId { get; set; }
        }
    }
}
