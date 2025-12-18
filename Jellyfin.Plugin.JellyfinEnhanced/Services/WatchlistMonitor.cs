using System;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Monitors library additions to automatically add requested media to user watchlists.
    // When users request media through Jellyseerr, their TMDB IDs are stored in pending watchlist.
    // This service processes new library items and adds them to watchlists if they match pending requests.
    public class WatchlistMonitor : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;

        public WatchlistMonitor(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            UserConfigurationManager userConfigurationManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
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


        // Process an item from library events to check if it matches pending watchlist items.
        private Task ProcessItemForWatchlist(ItemChangeEventArgs e, string eventType)
        {
            try
            {
                // Only process movies and TV series - check this first to avoid spam
                var itemKind = e.Item?.GetBaseItemKind();
                if (itemKind != BaseItemKind.Movie && itemKind != BaseItemKind.Series)
                {
                    return Task.CompletedTask;
                }

                _logger.Info($"[Watchlist] {eventType} event triggered for: {e.Item?.Name ?? "Unknown"} (Type: {itemKind})");

                // Check if watchlist feature is enabled
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null)
                {
                    _logger.Warning("[Watchlist] Configuration is null");
                    return Task.CompletedTask;
                }

                if (!config.AddRequestedMediaToWatchlist)
                {
                    _logger.Debug("[Watchlist] AddRequestedMediaToWatchlist is disabled");
                    return Task.CompletedTask;
                }

                if (!config.JellyseerrEnabled)
                {
                    _logger.Debug("[Watchlist] JellyseerrEnabled is disabled");
                    return Task.CompletedTask;
                }

                // Check if item has TMDB ID
                if (e.Item?.ProviderIds == null)
                {
                    _logger.Debug($"[Watchlist] [{eventType}] Item has no ProviderIds yet: {e.Item?.Name}");
                    return Task.CompletedTask;
                }

                if (!e.Item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdString))
                {
                    _logger.Debug($"[Watchlist] [{eventType}] Item has no TMDB ID yet: {e.Item.Name}");
                    return Task.CompletedTask;
                }

                if (!int.TryParse(tmdbIdString, out var tmdbId))
                {
                    _logger.Warning($"[Watchlist] Invalid TMDB ID format: {tmdbIdString}");
                    return Task.CompletedTask;
                }

                var mediaType = itemKind == BaseItemKind.Movie ? "movie" : "tv";
                _logger.Info($"[Watchlist] New {mediaType} added to library: '{e.Item.Name}' (TMDB: {tmdbId})");

                // Check all users' pending watchlists
                var userIds = _userConfigurationManager.GetAllUserIds();
                var userIdsList = userIds.ToList();
                _logger.Info($"[Watchlist] Checking {userIdsList.Count} users for pending watchlist items");

                foreach (var userId in userIdsList)
                {
                    ProcessPendingWatchlistForUser(userId, tmdbId, mediaType, e.Item);
                }

                return Task.CompletedTask;
            }
            catch (Exception ex)
            {
                _logger.Error($"[Watchlist] Error in OnItemAdded: {ex.Message}\nStack trace: {ex.StackTrace}");
                return Task.CompletedTask;
            }
        }


        // Check if a user has this item in their pending watchlist and add it if found.
        private void ProcessPendingWatchlistForUser(string userId, int tmdbId, string mediaType, MediaBrowser.Controller.Entities.BaseItem item)
        {
            try
            {
                _logger.Debug($"[Watchlist] Checking pending watchlist for user {userId}, TMDB: {tmdbId}, Type: {mediaType}");

                var pending = _userConfigurationManager.GetUserConfiguration<PendingWatchlistItems>(userId, "pending-watchlist.json");
                _logger.Debug($"[Watchlist] User {userId} has {pending.Items.Count} pending watchlist items");

                var matchingItem = pending.Items.FirstOrDefault(i => i.TmdbId == tmdbId && i.MediaType == mediaType);

                if (matchingItem == null)
                {
                    _logger.Debug($"[Watchlist] No matching pending item found for user {userId}, TMDB: {tmdbId}, Type: {mediaType}");
                    return;
                }

                _logger.Info($"[Watchlist] Found matching pending watchlist item for user {userId}: TMDB {tmdbId} ({mediaType})");

                // Get the user object
                var user = _userManager.GetUserById(Guid.Parse(userId));
                if (user == null)
                {
                    _logger.Warning($"[Watchlist] Could not find user with ID {userId}");
                    return;
                }

                // Get or create user data for this item
                var userData = _userDataManager.GetUserData(user, item);

                // Check if already liked/in watchlist
                if (userData != null && userData.Likes == true)
                {
                    _logger.Debug($"[Watchlist] '{item.Name}' already in watchlist for user {userId}");
                }
                else if (userData != null)
                {
                    // Add to watchlist by setting Likes to true
                    userData.Likes = true;
                    _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);
                    _logger.Info($"[Watchlist] ✓ Added '{item.Name}' to watchlist for user {user.Username}");
                }
                else
                {
                    _logger.Warning($"[Watchlist] User data was null for '{item.Name}' and user {user.Username}; skipping.");
                }

                // Remove from pending list
                pending.Items.Remove(matchingItem);
                _userConfigurationManager.SaveUserConfiguration(userId, "pending-watchlist.json", pending);
                _logger.Info($"[Watchlist] Removed TMDB {tmdbId} from pending watchlist for user {userId}");
            }
            catch (Exception ex)
            {
                _logger.Error($"[Watchlist] Error processing pending watchlist for user {userId}: {ex.Message}\nStack trace: {ex.StackTrace}");
            }
        }


        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Watchlist] Unsubscribing from library events");
            _libraryManager.ItemAdded -= OnItemAdded;
            _libraryManager.ItemUpdated -= OnItemUpdated;
            GC.SuppressFinalize(this);
        }
    }
}
