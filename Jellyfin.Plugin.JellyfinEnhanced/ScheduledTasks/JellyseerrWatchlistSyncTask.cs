using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    // Scheduled task that syncs Jellyseerr watchlist items to Jellyfin watchlist.
    public partial class JellyseerrWatchlistSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Configuration.UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;

        public JellyseerrWatchlistSyncTask(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            Configuration.UserConfigurationManager userConfigurationManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _httpClientFactory = httpClientFactory;
            _userConfigurationManager = userConfigurationManager;
            _logger = logger;
        }

        public string Name => "Sync Jellyseerr Watchlist to Jellyfin";

        public string Key => "JellyfinEnhancedJellyseerrWatchlistSync";

        public string Description => "Syncs items from each user's Jellyseerr watchlist to their Jellyfin watchlist.\n\nConfigure the task triggers to run this task periodically for automatic syncing.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.SyncJellyseerrWatchlist || !config.JellyseerrEnabled)
            {
                _logger.Info("[Jellyseerr Watchlist Sync] Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("[Jellyseerr Watchlist Sync] Jellyseerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            _logger.Info("[Jellyseerr Watchlist Sync] Starting Jellyseerr watchlist sync task...");
            progress?.Report(0);

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var jellyseerrUrl = urls.FirstOrDefault()?.Trim();

            if (string.IsNullOrEmpty(jellyseerrUrl))
            {
                _logger.Warning("[Jellyseerr Watchlist Sync] No valid Jellyseerr URL found.");
                progress?.Report(100);
                return;
            }

            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            // Get all Jellyfin users
            var jellyfinUsers = _userManager.Users.ToList();
            _logger.Info($"[Jellyseerr Watchlist Sync] Found {jellyfinUsers.Count} Jellyfin users");

            var totalUsers = jellyfinUsers.Count;
            var processedUsers = 0;
            var totalItemsAdded = 0;

            foreach (var jellyfinUser in jellyfinUsers)
            {
                cancellationToken.ThrowIfCancellationRequested();

                try
                {
                    _logger.Info($"=================================================================================================================================");
                    _logger.Info($"=================================================================================================================================");

                    _logger.Info($"[Jellyseerr Watchlist Sync] Processing user: {jellyfinUser.Username}");

                    // Clean up old processed items if prevention is enabled
                    if (config.PreventWatchlistReAddition)
                    {
                        _userConfigurationManager.CleanupOldProcessedWatchlistItems(jellyfinUser.Id, config.WatchlistMemoryRetentionDays);
                    }

                    // Get Jellyseerr user ID for this Jellyfin user
                    var jellyseerrUserId = await GetJellyseerrUserId(httpClient, jellyseerrUrl, jellyfinUser.Id.ToString());

                    if (string.IsNullOrEmpty(jellyseerrUserId))
                    {
                        _logger.Warning($"[Jellyseerr Watchlist Sync] No Jellyseerr account linked for user: {jellyfinUser.Username}");
                        processedUsers++;
                        continue;
                    }

                    // Get watchlist from Jellyseerr
                    var watchlistItems = await GetJellyseerrWatchlist(httpClient, jellyseerrUrl, jellyseerrUserId) ?? new List<WatchlistItem>();

                    var requestItems = new List<WatchlistItem>();
                    if (config.AddRequestedMediaToWatchlist)
                    {
                        requestItems = await GetJellyseerrRequests(httpClient, jellyseerrUrl, jellyseerrUserId) ?? new List<WatchlistItem>();
                    }

                    // Log consolidated summary
                    var totalItems = watchlistItems.Count + requestItems.Count;
                    if (totalItems > 0)
                    {
                        var parts = new List<string>();
                        if (watchlistItems.Count > 0) parts.Add($"{watchlistItems.Count} watchlist items");
                        if (requestItems.Count > 0) parts.Add($"{requestItems.Count} requests");
                        _logger.Info($"[Jellyseerr Watchlist Sync] Found {string.Join(", ", parts)} for user: {jellyfinUser.Username}");
                    }
                    else
                    {
                        _logger.Info($"[Jellyseerr Watchlist Sync] No items found for user: {jellyfinUser.Username}");
                    }

                    var combinedItems = watchlistItems.Concat(requestItems).ToList();

                    // Process each item
                    var itemsAdded = 0;
                    var itemsPending = 0;
                    var alreadyProcessedItems = new List<string>();
                    var alreadyInWatchlistItems = new List<string>();
                    var notInLibraryItems = new List<string>();
                    var processedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var item in combinedItems)
                    {
                        cancellationToken.ThrowIfCancellationRequested();

                        var key = $"{item.MediaType}:{item.TmdbId}";
                        if (!processedKeys.Add(key))
                        {
                            continue;
                        }

                        var result = await ProcessWatchlistItem(jellyfinUser, item);
                        var itemInfo = $"TMDB: {item.TmdbId}";

                        switch (result)
                        {
                            case WatchlistItemResult.Added:
                                itemsAdded++;
                                totalItemsAdded++;
                                break;
                            case WatchlistItemResult.AddedToPending:
                                itemsPending++;
                                break;
                            case WatchlistItemResult.AlreadyProcessed:
                                alreadyProcessedItems.Add(itemInfo);
                                break;
                            case WatchlistItemResult.AlreadyInWatchlist:
                                alreadyInWatchlistItems.Add(itemInfo);
                                break;
                            case WatchlistItemResult.NotInLibrary:
                                notInLibraryItems.Add(itemInfo);
                                break;
                        }
                    }

                    // Log consolidated results
                    if (alreadyProcessedItems.Count > 0)
                    {
                        _logger.Debug($"[Jellyseerr Watchlist Sync] Items already processed for user {jellyfinUser.Username}: {string.Join(", ", alreadyProcessedItems)}");
                    }
                    if (alreadyInWatchlistItems.Count > 0)
                    {
                        _logger.Debug($"[Jellyseerr Watchlist Sync] Items already in watchlist for user {jellyfinUser.Username}: {string.Join(", ", alreadyInWatchlistItems)}");
                    }
                    if (notInLibraryItems.Count > 0)
                    {
                        _logger.Debug($"[Jellyseerr Watchlist Sync] Items not in library for user {jellyfinUser.Username} (will be auto-added by WatchlistMonitor): {string.Join(", ", notInLibraryItems)}");
                    }

                    _logger.Info($"[Jellyseerr Watchlist Sync] User {jellyfinUser.Username}: Added {itemsAdded} items to watchlist, {itemsPending} items added to pending watchlist, {alreadyProcessedItems.Count} already processed, {alreadyInWatchlistItems.Count} already in watchlist, {notInLibraryItems.Count} not in library");
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Jellyseerr Watchlist Sync] Error processing user {jellyfinUser.Username}: {ex.Message}");
                }

                processedUsers++;
                var currentProgress = (int)((double)processedUsers / totalUsers * 100);
                progress?.Report(currentProgress);
            }

            _logger.Info($"=================================================================================================================================");
            _logger.Info($"=================================================================================================================================");
            _logger.Info($"[Jellyseerr Watchlist Sync] Completed. Added {totalItemsAdded} total items across {processedUsers} users");
            progress?.Report(100);
        }

        private async Task<string?> GetJellyseerrUserId(HttpClient httpClient, string jellyseerrUrl, string jellyfinUserId)
        {
            try
            {
                var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/user?take=1000";
                var response = await httpClient.GetAsync(requestUri);

                if (response.IsSuccessStatusCode)
                {
                    var content = await response.Content.ReadAsStringAsync();
                    var usersResponse = JsonSerializer.Deserialize<JsonElement>(content);

                    if (usersResponse.TryGetProperty("results", out var usersArray))
                    {
                        var userCount = usersArray.GetArrayLength();
                        // _logger.Info($"[Jellyseerr Watchlist Sync] Found {userCount} Jellyseerr users");

                        // Normalize Jellyfin user ID by removing hyphens for comparison
                        var normalizedJellyfinUserId = jellyfinUserId.Replace("-", "");

                        foreach (var user in usersArray.EnumerateArray())
                        {
                            if (user.TryGetProperty("jellyfinUserId", out var jfUserId))
                            {
                                var jfUserIdStr = jfUserId.GetString();
                                // _logger.Info($"[Jellyseerr Watchlist Sync] Checking Jellyseerr user with jellyfinUserId: {jfUserIdStr}");

                                // Normalize both IDs by removing hyphens before comparison
                                var normalizedJellyseerrUserId = jfUserIdStr?.Replace("-", "") ?? "";

                                if (string.Equals(normalizedJellyseerrUserId, normalizedJellyfinUserId, StringComparison.OrdinalIgnoreCase))
                                {
                                    if (user.TryGetProperty("id", out var id))
                                    {
                                        var jellyseerrUserId = id.GetInt32().ToString();
                                        _logger.Info($"[Jellyseerr Watchlist Sync] Found matching Jellyseerr user ID: {jellyseerrUserId}");
                                        return jellyseerrUserId;
                                    }
                                }
                            }
                        }

                        _logger.Warning($"[Jellyseerr Watchlist Sync] No Jellyseerr user found with jellyfinUserId matching: {jellyfinUserId}");
                    }
                }
                else
                {
                    _logger.Warning($"[Jellyseerr Watchlist Sync] Failed to get users from Jellyseerr. Status: {response.StatusCode}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyseerr Watchlist Sync] Error getting Jellyseerr user ID: {ex.Message}");
            }

            return null;
        }

        private async Task<List<WatchlistItem>?> GetJellyseerrWatchlist(HttpClient httpClient, string jellyseerrUrl, string jellyseerrUserId)
        {
            try
            {
                var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/user/{jellyseerrUserId}/watchlist";
                httpClient.DefaultRequestHeaders.Remove("X-Api-User");
                httpClient.DefaultRequestHeaders.Add("X-Api-User", jellyseerrUserId);

                var response = await httpClient.GetAsync(requestUri);

                if (response.IsSuccessStatusCode)
                {
                    var content = await response.Content.ReadAsStringAsync();
                    var watchlistResponse = JsonSerializer.Deserialize<JsonElement>(content);

                    var items = new List<WatchlistItem>();

                    if (watchlistResponse.TryGetProperty("results", out var resultsArray))
                    {
                        foreach (var item in resultsArray.EnumerateArray())
                        {
                            var watchlistItem = new WatchlistItem();

                            if (item.TryGetProperty("tmdbId", out var tmdbId))
                            {
                                watchlistItem.TmdbId = tmdbId.GetInt32();
                            }

                            if (item.TryGetProperty("mediaType", out var mediaType))
                            {
                                watchlistItem.MediaType = mediaType.GetString() ?? "";
                            }

                            if (item.TryGetProperty("title", out var title))
                            {
                                watchlistItem.Title = title.GetString() ?? "";
                            }

                            items.Add(watchlistItem);
                        }
                    }

                    return items;
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyseerr Watchlist Sync] Error getting Jellyseerr watchlist: {ex.Message}");
            }

            return null;
        }

        private async Task<List<WatchlistItem>?> GetJellyseerrRequests(HttpClient httpClient, string jellyseerrUrl, string jellyseerrUserId)
        {
            try
            {
                var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/request?take=500&skip=0&sort=added&filter=all";
                httpClient.DefaultRequestHeaders.Remove("X-Api-User");
                httpClient.DefaultRequestHeaders.Add("X-Api-User", jellyseerrUserId);

                var response = await httpClient.GetAsync(requestUri);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Debug($"[Jellyseerr Watchlist Sync] Requests fetch failed with {response.StatusCode}");
                    return null;
                }

                var content = await response.Content.ReadAsStringAsync();
                var json = JsonSerializer.Deserialize<JsonElement>(content);

                if (!json.TryGetProperty("results", out var resultsArray))
                {
                    _logger.Debug("[Jellyseerr Watchlist Sync] Requests response missing results array");
                    return null;
                }

                var items = new List<WatchlistItem>();
                foreach (var item in resultsArray.EnumerateArray())
                {
                    // Filter to the requesting user
                    if (!BelongsToUser(item, jellyseerrUserId))
                    {
                        continue;
                    }

                    var parsed = ParseRequestItem(item);
                    if (parsed != null)
                    {
                        items.Add(parsed);
                    }
                }

                return items;
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyseerr Watchlist Sync] Error getting Jellyseerr requests: {ex.Message}");
            }

            return null;
        }

        private bool BelongsToUser(JsonElement requestElement, string jellyseerrUserId)
        {
            // Check common shapes: requestedBy is object with id, or scalar id, or userId
            if (requestElement.TryGetProperty("requestedBy", out var requestedBy))
            {
                if (requestedBy.ValueKind == JsonValueKind.Number && requestedBy.TryGetInt32(out var idNumber))
                {
                    return string.Equals(idNumber.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase);
                }

                if (requestedBy.ValueKind == JsonValueKind.String)
                {
                    var idStr = requestedBy.GetString();
                    if (!string.IsNullOrEmpty(idStr) && string.Equals(idStr, jellyseerrUserId, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                if (requestedBy.ValueKind == JsonValueKind.Object && requestedBy.TryGetProperty("id", out var idProp))
                {
                    if ((idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt32(out var objId) && string.Equals(objId.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase)) ||
                        (idProp.ValueKind == JsonValueKind.String && string.Equals(idProp.GetString() ?? string.Empty, jellyseerrUserId, StringComparison.OrdinalIgnoreCase)))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private WatchlistItem? ParseRequestItem(JsonElement requestElement)
        {
            // Prefer media.tmdbId / media.mediaType, fallback to top-level tmdbId/mediaType
            int tmdbId = 0;
            string mediaType = "";
            string title = "";

            if (requestElement.TryGetProperty("media", out var media))
            {
                if (media.TryGetProperty("tmdbId", out var tmdbProp))
                {
                    tmdbId = tmdbProp.GetInt32();
                }
                if (media.TryGetProperty("mediaType", out var mtProp) && mtProp.ValueKind == JsonValueKind.String)
                {
                    mediaType = mtProp.GetString() ?? "";
                }
                if (media.TryGetProperty("title", out var titleProp) && titleProp.ValueKind == JsonValueKind.String)
                {
                    title = titleProp.GetString() ?? "";
                }
            }

            if (tmdbId == 0 && requestElement.TryGetProperty("tmdbId", out var topTmdb))
            {
                tmdbId = topTmdb.GetInt32();
            }

            if (tmdbId == 0 && requestElement.TryGetProperty("mediaId", out var mediaIdProp))
            {
                if (mediaIdProp.ValueKind == JsonValueKind.Number && mediaIdProp.TryGetInt32(out var mediaIdInt))
                {
                    tmdbId = mediaIdInt;
                }
            }

            if (string.IsNullOrWhiteSpace(mediaType) && requestElement.TryGetProperty("mediaType", out var topMediaType) && topMediaType.ValueKind == JsonValueKind.String)
            {
                mediaType = topMediaType.GetString() ?? "";
            }

            if (string.IsNullOrWhiteSpace(mediaType) && requestElement.TryGetProperty("type", out var typeProp) && typeProp.ValueKind == JsonValueKind.String)
            {
                mediaType = typeProp.GetString() ?? "";
            }

            if (string.IsNullOrWhiteSpace(title) && requestElement.TryGetProperty("title", out var topTitle) && topTitle.ValueKind == JsonValueKind.String)
            {
                title = topTitle.GetString() ?? "";
            }

            if (tmdbId == 0 || string.IsNullOrWhiteSpace(mediaType))
            {
                return null;
            }

            return new WatchlistItem
            {
                TmdbId = tmdbId,
                MediaType = mediaType,
                Title = title
            };
        }

        private enum WatchlistItemResult
        {
            Added,
            AddedToPending,
            AlreadyInWatchlist,
            AlreadyProcessed,
            NotInLibrary,
            Skipped
        }

        private Task<WatchlistItemResult> ProcessWatchlistItem(JUser user, WatchlistItem watchlistItem)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config?.PreventWatchlistReAddition == true)
                {
                    // Check if this item was already processed for this user
                    var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                    var itemKey = $"{watchlistItem.MediaType}:{watchlistItem.TmdbId}";

                    if (processedItems.Items.Any(p => p.TmdbId == watchlistItem.TmdbId && p.MediaType == watchlistItem.MediaType))
                    {
                        return Task.FromResult(WatchlistItemResult.AlreadyProcessed);
                    }
                }

                // Determine Jellyfin item type based on Jellyseerr media type
                var itemType = watchlistItem.MediaType == "movie" ? BaseItemKind.Movie : BaseItemKind.Series;

                // Find the item in Jellyfin library by TMDB ID
                var items = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { itemType },
                    HasTmdbId = true,
                    Recursive = true
                });

                var item = items.FirstOrDefault(i =>
                {
                    if (i.ProviderIds != null && i.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
                    {
                        return tmdbId == watchlistItem.TmdbId.ToString();
                    }
                    return false;
                });

                if (item == null)
                {
                    // Item not in library yet - WatchlistMonitor will automatically add it when it arrives
                    return Task.FromResult(WatchlistItemResult.NotInLibrary);
                }

                // Get user data
                var userData = _userDataManager.GetUserData(user, item);
                if (userData == null)
                {
                    _logger.Warning($"[Jellyseerr Watchlist Sync] User data is null for item {item.Name}; skipping.");
                    return Task.FromResult(WatchlistItemResult.Skipped);
                }

                // Check if already in watchlist
                if (userData.Likes == true)
                {
                    // Mark as processed if prevention is enabled and not already marked
                    if (config?.PreventWatchlistReAddition == true)
                    {
                        var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                        if (!processedItems.Items.Any(p => p.TmdbId == watchlistItem.TmdbId && p.MediaType == watchlistItem.MediaType))
                        {
                            processedItems.Items.Add(new ProcessedWatchlistItem
                            {
                                TmdbId = watchlistItem.TmdbId,
                                MediaType = watchlistItem.MediaType,
                                ProcessedAt = System.DateTime.UtcNow,
                                Source = "existing"
                            });
                            _userConfigurationManager.SaveProcessedWatchlistItems(user.Id, processedItems);
                        }
                    }

                    return Task.FromResult(WatchlistItemResult.AlreadyInWatchlist);
                }

                // Add to watchlist
                userData.Likes = true;
                _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);

                // Mark as processed if prevention is enabled
                if (config?.PreventWatchlistReAddition == true)
                {
                    var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                    processedItems.Items.Add(new ProcessedWatchlistItem
                    {
                        TmdbId = watchlistItem.TmdbId,
                        MediaType = watchlistItem.MediaType,
                        ProcessedAt = System.DateTime.UtcNow,
                        Source = "sync"
                    });
                    _userConfigurationManager.SaveProcessedWatchlistItems(user.Id, processedItems);
                }

                _logger.Info($"[Jellyseerr Watchlist Sync] ✓ Added to watchlist: {item.Name} for user {user.Username}");
                return Task.FromResult(WatchlistItemResult.Added);
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyseerr Watchlist Sync] Error processing watchlist item: {ex.Message}");
                return Task.FromResult(WatchlistItemResult.Skipped);
            }
        }

        private class WatchlistItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = "";
            public string Title { get; set; } = "";
        }
    }
}
