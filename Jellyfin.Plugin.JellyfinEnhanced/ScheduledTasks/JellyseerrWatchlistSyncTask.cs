using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    // Scheduled task that syncs Jellyseerr watchlist items to Jellyfin watchlist.
    public class JellyseerrWatchlistSyncTask : IScheduledTask
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
            // Run daily at 3 AM by default
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfo.TriggerDaily,
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
                    _logger.Info($"[Jellyseerr Watchlist Sync] Processing user: {jellyfinUser.Username}");

                    // Get Jellyseerr user ID for this Jellyfin user
                    var jellyseerrUserId = await GetJellyseerrUserId(httpClient, jellyseerrUrl, jellyfinUser.Id.ToString());

                    if (string.IsNullOrEmpty(jellyseerrUserId))
                    {
                        _logger.Warning($"[Jellyseerr Watchlist Sync] No Jellyseerr account linked for user: {jellyfinUser.Username}");
                        processedUsers++;
                        continue;
                    }

                    // Get watchlist from Jellyseerr
                    var watchlistItems = await GetJellyseerrWatchlist(httpClient, jellyseerrUrl, jellyseerrUserId);

                    if (watchlistItems == null || watchlistItems.Count == 0)
                    {
                        _logger.Info($"[Jellyseerr Watchlist Sync] No watchlist items found for user: {jellyfinUser.Username}");
                        processedUsers++;
                        continue;
                    }

                    _logger.Info($"[Jellyseerr Watchlist Sync] Found {watchlistItems.Count} watchlist items for user: {jellyfinUser.Username}");

                    // Process each watchlist item
                    var itemsAdded = 0;
                    var itemsPending = 0;
                    foreach (var watchlistItem in watchlistItems)
                    {
                        cancellationToken.ThrowIfCancellationRequested();

                        var result = await ProcessWatchlistItem(jellyfinUser, watchlistItem);
                        if (result == WatchlistItemResult.Added)
                        {
                            itemsAdded++;
                            totalItemsAdded++;
                        }
                        else if (result == WatchlistItemResult.AddedToPending)
                        {
                            itemsPending++;
                        }
                    }

                    _logger.Info($"[Jellyseerr Watchlist Sync] User {jellyfinUser.Username}: Added {itemsAdded} items to watchlist, {itemsPending} items added to pending watchlist");
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Jellyseerr Watchlist Sync] Error processing user {jellyfinUser.Username}: {ex.Message}");
                }

                processedUsers++;
                var currentProgress = (int)((double)processedUsers / totalUsers * 100);
                progress?.Report(currentProgress);
            }

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
                                _logger.Info($"[Jellyseerr Watchlist Sync] Checking Jellyseerr user with jellyfinUserId: {jfUserIdStr}");

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

        private enum WatchlistItemResult
        {
            Added,
            AddedToPending,
            AlreadyInWatchlist,
            Skipped
        }

        private Task<WatchlistItemResult> ProcessWatchlistItem(Jellyfin.Data.Entities.User user, WatchlistItem watchlistItem)
        {
            try
            {
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
                    _logger.Debug($"[Jellyseerr Watchlist Sync] Item not found in library: {watchlistItem.Title} (TMDB: {watchlistItem.TmdbId}), adding to pending watchlist");

                    // Add to pending watchlist so it gets added when the item arrives
                    var pending = _userConfigurationManager.GetUserConfiguration<Configuration.PendingWatchlistItems>(user.Id.ToString(), "pending-watchlist.json");

                    // Check if already in pending list
                    var alreadyPending = pending.Items.Any(i => i.TmdbId == watchlistItem.TmdbId && i.MediaType == watchlistItem.MediaType);
                    if (!alreadyPending)
                    {
                        pending.Items.Add(new Configuration.PendingWatchlistItem
                        {
                            TmdbId = watchlistItem.TmdbId,
                            MediaType = watchlistItem.MediaType,
                            RequestedAt = DateTime.UtcNow
                        });
                        _userConfigurationManager.SaveUserConfiguration(user.Id.ToString(), "pending-watchlist.json", pending);
                        _logger.Info($"[Jellyseerr Watchlist Sync] ✓ Added to pending watchlist: {watchlistItem.Title} (TMDB: {watchlistItem.TmdbId}) for user {user.Username}");
                        return Task.FromResult(WatchlistItemResult.AddedToPending);
                    }

                    return Task.FromResult(WatchlistItemResult.Skipped);
                }

                // Get user data
                var userData = _userDataManager.GetUserData(user, item);

                // Check if already in watchlist
                if (userData.Likes == true)
                {
                    _logger.Debug($"[Jellyseerr Watchlist Sync] Item already in watchlist: {item.Name}");
                    return Task.FromResult(WatchlistItemResult.AlreadyInWatchlist);
                }

                // Add to watchlist
                userData.Likes = true;
                _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);

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
