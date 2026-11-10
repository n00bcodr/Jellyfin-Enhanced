using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    // Scheduled task that mirrors watchlist removals between Jellyfin and Seerr.
    // See WatchlistSyncPlanner for how a removal is told apart from a pending addition.
    public class WatchlistRemovalSyncTask : IScheduledTask, IConfigurableScheduledTask
    {
        private const string Tag = "[Watchlist Removal Sync]";

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;

        public WatchlistRemovalSyncTask(
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

        public string Name => "Sync Watchlist Removals between Jellyfin and Seerr";

        public string Key => "JellyfinEnhancedWatchlistRemovalSync";

        public string Description => "Mirrors watchlist removals between Jellyfin and Seerr, in the direction chosen in the plugin settings (Seerr > Watchlist > Removals).\n\nOnly items that were on both watchlists are ever removed. Run it after the two watchlist add syncs.";

        public string Category => "Jellyfin Enhanced";

        internal static bool IsFeatureEnabled([NotNullWhen(true)] PluginConfiguration? config) => WatchlistSyncPlanner.IsActive(config);

        public bool IsHidden => !IsFeatureEnabled(JellyfinEnhanced.Instance?.Configuration);

        public bool IsEnabled => true;

        public bool IsLogged => true;

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(4).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (!IsFeatureEnabled(config))
            {
                _logger.Info($"{Tag} Removal sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning($"{Tag} Seerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            var mode = WatchlistSyncPlanner.ParseMode(config.WatchlistRemovalSync);
            var seerrUrl = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim()).FirstOrDefault(u => u.Length > 0);
            if (seerrUrl == null)
            {
                _logger.Warning($"{Tag} No valid Seerr URL found.");
                progress?.Report(100);
                return;
            }

            _logger.Info($"{Tag} Starting (removals followed from: {mode})...");
            progress?.Report(0);

            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            var seerrUserMap = await GetSeerrUserMap(httpClient, seerrUrl, config.JellyseerrApiKey, cancellationToken);
            if (seerrUserMap == null || seerrUserMap.Count == 0)
            {
                _logger.Warning($"{Tag} Unable to load the Seerr user list; nothing removed.");
                progress?.Report(100);
                return;
            }

            var blockedIds = JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            var users = _userManager.GetAllUsers()
                .Where(u => !blockedIds.Contains(u.Id.ToString().Replace("-", ""), StringComparer.OrdinalIgnoreCase))
                .ToList();

            var libraryItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                HasTmdbId = true,
                Recursive = true
            });

            // A movie with several versions is several library items sharing one TMDB id, and a
            // like can sit on any of them, so every item per key is kept.
            var byKey = new Dictionary<string, List<BaseItem>>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in libraryItems)
            {
                if (item.ProviderIds == null || !item.ProviderIds.TryGetValue("Tmdb", out var tmdbStr)
                    || !int.TryParse(tmdbStr, out var tmdbId) || tmdbId <= 0) continue;
                var mediaType = item.GetBaseItemKind() == BaseItemKind.Movie ? "movie" : "tv";
                var key = WatchlistSyncPlanner.Key(mediaType, tmdbId);
                if (!byKey.TryGetValue(key, out var versions)) byKey[key] = versions = new List<BaseItem>();
                versions.Add(item);
            }
            var inLibrary = new HashSet<string>(byKey.Keys, StringComparer.OrdinalIgnoreCase);

            var processed = 0;
            var removedFromSeerr = 0;
            var removedFromJellyfin = 0;

            foreach (var user in users)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    if (!seerrUserMap.TryGetValue(user.Id.ToString().Replace("-", ""), out var seerrUserId))
                    {
                        continue;
                    }

                    var seerrList = await SeerrWatchlistReader.ReadKeysAsync(httpClient, seerrUrl, seerrUserId, config.JellyseerrApiKey, m => _logger.Warning($"{Tag} {m}"), cancellationToken);
                    if (seerrList == null)
                    {
                        // An unreadable list must never look like "everything was removed".
                        _logger.Warning($"{Tag} Could not read the Seerr watchlist for {user.Username}; skipping this user.");
                        continue;
                    }

                    var jellyfinList = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var (key, versions) in byKey)
                    {
                        if (versions.Any(v => _userDataManager.GetUserData(user, v)?.Likes == true)) jellyfinList.Add(key);
                    }

                    var state = _userConfigurationManager.GetWatchlistSyncState(user.Id);
                    var plan = WatchlistSyncPlanner.Compute(state.Synced, jellyfinList, seerrList, inLibrary, mode);
                    var next = new HashSet<string>(plan.NextSynced, StringComparer.OrdinalIgnoreCase);

                    foreach (var key in plan.RemoveFromSeerr)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var (mediaType, tmdbId) = SplitKey(key);
                        if (await RemoveFromSeerr(httpClient, seerrUrl, seerrUserId, config.JellyseerrApiKey, mediaType, tmdbId, user.Username, cancellationToken))
                        {
                            removedFromSeerr++;
                            _logger.Info($"{Tag} Removed from Seerr watchlist: {key} for {user.Username}");
                        }
                        else next.Add(key); // retry next run
                    }

                    foreach (var key in plan.RemoveFromJellyfin)
                    {
                        if (!byKey.TryGetValue(key, out var versions)) { next.Add(key); continue; }
                        foreach (var version in versions)
                        {
                            var data = _userDataManager.GetUserData(user, version);
                            if (data?.Likes != true) continue;
                            data.Likes = null;
                            _userDataManager.SaveUserData(user, version, data, UserDataSaveReason.UpdateUserRating, default);
                        }

                        removedFromJellyfin++;
                        _logger.Info($"{Tag} Removed from Jellyfin watchlist: {versions[0].Name} for {user.Username}");
                    }

                    _userConfigurationManager.SaveWatchlistSyncState(user.Id, new WatchlistSyncState
                    {
                        Synced = next.OrderBy(k => k, StringComparer.Ordinal).ToList(),
                        UpdatedAt = DateTime.UtcNow
                    });
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.Error($"{Tag} Error processing user {user.Username}: {ex.Message}");
                }

                processed++;
                progress?.Report((double)processed / Math.Max(users.Count, 1) * 100);
            }

            _logger.Info($"{Tag} Completed. Removed {removedFromSeerr} from Seerr and {removedFromJellyfin} from Jellyfin across {processed} users");
            progress?.Report(100);
        }

        private static (string MediaType, int TmdbId) SplitKey(string key)
        {
            var i = key.IndexOf(':');
            return (key[..i], int.Parse(key[(i + 1)..]));
        }

        private async Task<Dictionary<string, string>?> GetSeerrUserMap(HttpClient httpClient, string seerrUrl, string apiKey, CancellationToken cancellationToken)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            const int pageSize = 1000;
            var skip = 0;
            try
            {
                while (true)
                {
                    var uri = $"{seerrUrl.TrimEnd('/')}/api/v1/user?take={pageSize}&skip={skip}";
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, apiKey);
                    using var response = await httpClient.SendAsync(request, cancellationToken);
                    var (content, error) = await SeerrHttpHelper.ReadResponseAsync(response, uri, cancellationToken);
                    if (error != null)
                    {
                        _logger.Warning($"{Tag} Failed to get Seerr users: code={error.Code} status={error.HttpStatus}");
                        return null;
                    }

                    var json = JsonSerializer.Deserialize<JsonElement>(content!);
                    if (!json.TryGetProperty("results", out var results)) return null;

                    var count = 0;
                    foreach (var user in results.EnumerateArray())
                    {
                        count++;
                        if (!user.TryGetProperty("jellyfinUserId", out var jf) || !user.TryGetProperty("id", out var id)) continue;
                        var normalized = (jf.GetString() ?? string.Empty).Replace("-", string.Empty);
                        if (normalized.Length > 0) result[normalized] = id.GetInt32().ToString();
                    }

                    skip += count;
                    if (count < pageSize || skip >= 100000) break;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"{Tag} Error building Seerr user map: {ex.Message}");
                return null;
            }

            return result;
        }

        // A successful DELETE has an empty body, so the status code is checked directly.
        private async Task<bool> RemoveFromSeerr(HttpClient httpClient, string seerrUrl, string seerrUserId, string apiKey, string mediaType, int tmdbId, string username, CancellationToken cancellationToken)
        {
            try
            {
                // Seerr 3.x requires mediaType on this call and answers 400 without it.
                var uri = $"{seerrUrl.TrimEnd('/')}/api/v1/watchlist/{tmdbId}?mediaType={Uri.EscapeDataString(mediaType)}";
                using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Delete, uri, apiKey, seerrUserId);
                using var response = await httpClient.SendAsync(request, cancellationToken);
                if (response.IsSuccessStatusCode || (int)response.StatusCode == 404) return true;
                _logger.Warning($"{Tag} Failed to remove TMDB:{tmdbId} from Seerr for {username}: HTTP {(int)response.StatusCode}");
                return false;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"{Tag} Error removing TMDB:{tmdbId} from Seerr for {username}: {ex.Message}");
                return false;
            }
        }
    }
}
