using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    // Scheduled task that syncs Jellyfin watchlist items to Jellyseerr watchlist.
    public class JellyfinToSeerrWatchlistSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Configuration.UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;

        public JellyfinToSeerrWatchlistSyncTask(
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

        public string Name => "Sync Watchlist from Jellyfin to Seerr";

        public string Key => "JellyfinEnhancedJellyfinToSeerrWatchlistSync";

        public string Description => "Syncs items from each user's Jellyfin watchlist to their Seerr watchlist.\n\nConfigure the task triggers to run this task periodically for automatic syncing.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks + TimeSpan.FromMinutes(30).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.SyncJellyfinWatchlistToSeerr || !config.JellyseerrEnabled)
            {
                _logger.Info("[Jellyfin→Seerr Watchlist Sync] Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("[Jellyfin→Seerr Watchlist Sync] Jellyseerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            _logger.Info("[Jellyfin→Seerr Watchlist Sync] Starting sync task...");
            progress?.Report(0);

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var jellyseerrUrl = urls.FirstOrDefault()?.Trim();

            if (string.IsNullOrEmpty(jellyseerrUrl))
            {
                _logger.Warning("[Jellyfin→Seerr Watchlist Sync] No valid Jellyseerr URL found.");
                progress?.Report(100);
                return;
            }

            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            var jellyseerrUserMap = await GetJellyseerrUserMap(httpClient, jellyseerrUrl, config.JellyseerrApiKey);
            if (jellyseerrUserMap.Count == 0)
            {
                _logger.Warning("[Jellyfin→Seerr Watchlist Sync] Unable to build Jellyseerr user map.");
            }

            var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper
                .GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            var allUsers = _userManager.GetAllUsers().ToList();
            var jellyfinUsers = allUsers
                .Where(u => !blockedIds.Contains(u.Id.ToString().Replace("-", ""), StringComparer.OrdinalIgnoreCase))
                .ToList();

            var skippedBlocked = allUsers.Count - jellyfinUsers.Count;
            if (skippedBlocked > 0)
                _logger.Info($"[Jellyfin→Seerr Watchlist Sync] Skipping {skippedBlocked} blocked user(s)");

            _logger.Info($"[Jellyfin→Seerr Watchlist Sync] Found {jellyfinUsers.Count} Jellyfin users");

            // Pre-fetch all movies and series with TMDB IDs once — shared across users
            var allMovies = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie },
                HasTmdbId = true,
                Recursive = true
            }).Select(i => (item: i, mediaType: "movie"));

            var allSeries = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Series },
                HasTmdbId = true,
                Recursive = true
            }).Select(i => (item: i, mediaType: "tv"));

            var allLibraryItems = allMovies.Concat(allSeries).ToList();

            var totalUsers = jellyfinUsers.Count;
            var processedUsers = 0;
            var totalItemsAdded = 0;

            foreach (var jellyfinUser in jellyfinUsers)
            {
                cancellationToken.ThrowIfCancellationRequested();

                try
                {
                    _logger.Info($"=================================================================================================================================");
                    _logger.Info($"[Jellyfin→Seerr Watchlist Sync] Processing user: {jellyfinUser.Username}");

                    var normalizedUserId = NormalizeUserId(jellyfinUser.Id.ToString());
                    jellyseerrUserMap.TryGetValue(normalizedUserId, out var jellyseerrUserId);

                    if (string.IsNullOrEmpty(jellyseerrUserId))
                    {
                        _logger.Warning($"[Jellyfin→Seerr Watchlist Sync] No Seerr account linked for user: {jellyfinUser.Username}");
                        processedUsers++;
                        continue;
                    }

                    // Get this user's Jellyfin watchlist items (Likes == true)
                    var jellyfinWatchlist = allLibraryItems
                        .Where(t => _userDataManager.GetUserData(jellyfinUser, t.item)?.Likes == true)
                        .ToList();

                    _logger.Info($"[Jellyfin→Seerr Watchlist Sync] User {jellyfinUser.Username}: {jellyfinWatchlist.Count} items in Jellyfin watchlist");

                    if (jellyfinWatchlist.Count == 0)
                    {
                        processedUsers++;
                        continue;
                    }

                    // Get this user's current Seerr watchlist to avoid duplicates
                    var seerrWatchlist = await GetSeerrWatchlist(httpClient, jellyseerrUrl, jellyseerrUserId, config.JellyseerrApiKey);
                    var seerrWatchlistKeys = new HashSet<string>(
                        seerrWatchlist.Select(i => $"{i.MediaType}:{i.TmdbId}"),
                        StringComparer.OrdinalIgnoreCase);

                    var itemsAdded = 0;
                    var itemsAlreadyPresent = 0;
                    var itemsSkipped = 0;

                    foreach (var (item, mediaType) in jellyfinWatchlist)
                    {
                        cancellationToken.ThrowIfCancellationRequested();

                        if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdStr) || string.IsNullOrEmpty(tmdbIdStr))
                        {
                            itemsSkipped++;
                            continue;
                        }

                        var key = $"{mediaType}:{tmdbIdStr}";

                        if (seerrWatchlistKeys.Contains(key))
                        {
                            itemsAlreadyPresent++;
                            continue;
                        }

                        var result = await AddToSeerrWatchlist(
                            httpClient, jellyseerrUrl, jellyseerrUserId, config.JellyseerrApiKey,
                            int.Parse(tmdbIdStr), mediaType, item.Name ?? "");

                        if (result == 1)
                        {
                            itemsAdded++;
                            totalItemsAdded++;
                            seerrWatchlistKeys.Add(key);
                            _logger.Info($"[Jellyfin→Seerr Watchlist Sync] ✓ Added to Seerr watchlist: {item.Name} for user {jellyfinUser.Username}");
                        }
                        else if (result == 0)
                        {
                            itemsAlreadyPresent++;
                            seerrWatchlistKeys.Add(key);
                        }
                        else
                        {
                            itemsSkipped++;
                        }
                    }

                    _logger.Info($"[Jellyfin→Seerr Watchlist Sync] User {jellyfinUser.Username}: Added {itemsAdded}, already present {itemsAlreadyPresent}, skipped {itemsSkipped}");
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Jellyfin→Seerr Watchlist Sync] Error processing user {jellyfinUser.Username}: {ex.Message}");
                }

                processedUsers++;
                progress?.Report((double)processedUsers / totalUsers * 100);
            }

            _logger.Info($"=================================================================================================================================");
            _logger.Info($"[Jellyfin→Seerr Watchlist Sync] Completed. Added {totalItemsAdded} total items across {processedUsers} users");
            progress?.Report(100);
        }

        private static string NormalizeUserId(string? userId)
            => string.IsNullOrEmpty(userId) ? string.Empty : userId.Replace("-", string.Empty);

        private async Task<Dictionary<string, string>> GetJellyseerrUserMap(HttpClient httpClient, string jellyseerrUrl, string apiKey)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            const int pageSize = 1000;
            int skip = 0;
            int reportedTotal = -1;

            try
            {
                while (true)
                {
                    var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/user?take={pageSize}&skip={skip}";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, apiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error != null)
                    {
                        _logger.Warning($"[Jellyfin→Seerr Watchlist Sync] Failed to get users: code={error.Code} status={error.HttpStatus}");
                        return result;
                    }

                    var usersResponse = JsonSerializer.Deserialize<JsonElement>(content!);
                    if (!usersResponse.TryGetProperty("results", out var usersArray)) return result;

                    int pageCount = 0;
                    foreach (var user in usersArray.EnumerateArray())
                    {
                        pageCount++;
                        if (!user.TryGetProperty("jellyfinUserId", out var jfUserId) || !user.TryGetProperty("id", out var id)) continue;
                        var normalizedId = NormalizeUserId(jfUserId.GetString());
                        if (!string.IsNullOrEmpty(normalizedId))
                            result[normalizedId] = id.GetInt32().ToString();
                    }

                    if (reportedTotal < 0 && usersResponse.TryGetProperty("pageInfo", out var pageInfo)
                        && pageInfo.TryGetProperty("results", out var totalEl) && totalEl.ValueKind == JsonValueKind.Number)
                        reportedTotal = totalEl.GetInt32();

                    skip += pageCount;
                    if (pageCount < pageSize) break;
                    if (reportedTotal >= 0 && skip >= reportedTotal) break;
                    if (skip >= 100000) { _logger.Warning("[Jellyfin→Seerr Watchlist Sync] Pagination safety cap hit"); break; }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyfin→Seerr Watchlist Sync] Error building user map: {ex.Message}");
            }

            return result;
        }

        private async Task<List<SeerrWatchlistItem>> GetSeerrWatchlist(HttpClient httpClient, string jellyseerrUrl, string jellyseerrUserId, string apiKey)
        {
            var items = new List<SeerrWatchlistItem>();
            const int pageSize = 100;
            int page = 1;

            try
            {
                while (true)
                {
                    var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/user/{jellyseerrUserId}/watchlist?take={pageSize}&page={page}";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, apiKey, jellyseerrUserId);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error != null)
                    {
                        _logger.Debug($"[Jellyfin→Seerr Watchlist Sync] Seerr watchlist fetch failed: {error.Code}");
                        break;
                    }

                    var watchlistResponse = JsonSerializer.Deserialize<JsonElement>(content!);
                    if (!watchlistResponse.TryGetProperty("results", out var resultsArray)) break;

                    int pageCount = 0;
                    foreach (var item in resultsArray.EnumerateArray())
                    {
                        pageCount++;
                        var tmdbId = item.TryGetProperty("tmdbId", out var t) ? t.GetInt32() : 0;
                        var mediaType = item.TryGetProperty("mediaType", out var m) ? m.GetString() ?? "" : "";
                        if (tmdbId > 0 && !string.IsNullOrEmpty(mediaType))
                            items.Add(new SeerrWatchlistItem { TmdbId = tmdbId, MediaType = mediaType });
                    }

                    if (pageCount < pageSize) break;
                    page++;
                    if (page > 1000) { _logger.Warning("[Jellyfin→Seerr Watchlist Sync] Watchlist pagination safety cap hit"); break; }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyfin→Seerr Watchlist Sync] Error fetching Seerr watchlist: {ex.Message}");
            }

            return items;
        }

        // Returns: 1 = added, 0 = already present, -1 = error
        private async Task<int> AddToSeerrWatchlist(HttpClient httpClient, string jellyseerrUrl, string jellyseerrUserId, string apiKey, int tmdbId, string mediaType, string title)
        {
            try
            {
                var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/watchlist";
                var body = JsonSerializer.Serialize(new { tmdbId, mediaType, title });
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Post, requestUri, apiKey, jellyseerrUserId, body);
                using var response = await httpClient.SendAsync(request);
                var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                if (error != null)
                {
                    if (error.HttpStatus == 409)
                        return 0; // already in watchlist
                    _logger.Warning($"[Jellyfin→Seerr Watchlist Sync] Failed to add {title} (TMDB:{tmdbId}): {error.Code} {error.HttpStatus}");
                    return -1;
                }

                return 1;
            }
            catch (Exception ex)
            {
                _logger.Error($"[Jellyfin→Seerr Watchlist Sync] Error adding {title} to Seerr watchlist: {ex.Message}");
                return -1;
            }
        }

        private class SeerrWatchlistItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = "";
        }
    }
}
