using System;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Monitors playback events to automatically request next seasons when threshold is reached.
    public class AutoSeasonRequestMonitor : IDisposable
    {
        private readonly ISessionManager _sessionManager;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly AutoSeasonRequestService _autoSeasonRequestService;
        private readonly Logger _logger;

        // Track which user+item combinations have already been checked to avoid duplicate checks
        private readonly Dictionary<string, DateTime> _checkedSessions = new();
        private readonly object _sessionLock = new();

        public AutoSeasonRequestMonitor(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoSeasonRequestService autoSeasonRequestService,
            Logger logger)
        {
            _sessionManager = sessionManager;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _autoSeasonRequestService = autoSeasonRequestService;
            _logger = logger;
        }

        // Initialize and start monitoring playback events.
        public void Initialize()
        {
            // Only initialize if the auto-season-request feature is enabled in plugin configuration.
            var config = JellyfinEnhanced.Instance?.Configuration as Configuration.PluginConfiguration;
            if (config == null)
            {
                _logger.Warning("[Auto-Season-Request] Configuration is null - skipping auto-season-request monitoring initialization");
                return;
            }

            if (!config.AutoSeasonRequestEnabled || !config.JellyseerrEnabled)
            {
                _logger.Info("[Auto-Season-Request] Auto-request monitoring is disabled in configuration - not subscribing to playback events");
                return;
            }

            // _logger.Info("[Auto-Season-Request] Initializing playback event monitoring");

            // Subscribe to playback events
            _sessionManager.PlaybackStopped += OnPlaybackStopped;
            _sessionManager.PlaybackProgress += OnPlaybackProgress;

            _logger.Info("[Auto-Season-Request] Successfully subscribed to playback events");
        }

        // Handle playback stopped events to check if we should request next season.
        private async void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
        {
            try
            {
                // Check if auto-season-request is enabled
                var config = JellyfinEnhanced.Instance?.Configuration as PluginConfiguration;
                if (config == null)
                {
                    return;
                }

                if (!config.AutoSeasonRequestEnabled)
                {
                    return;
                }

                if (!config.JellyseerrEnabled)
                {
                    return;
                }

                // Only process TV episodes
                if (e.Item?.GetBaseItemKind() != BaseItemKind.Episode)
                {
                    return;
                }

                _logger.Debug($"[Auto-Season-Request] PlaybackStopped event fired for episode: {e.Item?.Name}");

                // Check if the episode was watched (at least 90% completion)
                var playedToCompletion = e.PlayedToCompletion;
                var completionPercentage = 0.0;
                if (e.Item != null && e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks.HasValue && e.Item.RunTimeTicks.Value > 0)
                {
                    completionPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
                }
                //This probably can be removed but leaving it for now as a debug log

                _logger.Info($"[Auto-Season-Request] Episode '{e.Item?.Name ?? "Unknown"}' - PlayedToCompletion: {playedToCompletion}, Completion: {completionPercentage:P1}");

                if (playedToCompletion || completionPercentage >= 0.9)
                {
                    _logger.Info($"[Auto-Season-Request] Episode '{e.Item?.Name ?? "Unknown"}' completed by {e.Session?.UserName ?? "Unknown"}, checking threshold");

                    // Process this episode completion
                    if (e.Item != null && e.Session?.UserId != null)
                    {
                        await _autoSeasonRequestService.CheckEpisodeCompletionAsync(e.Item, e.Session.UserId);
                    }
                    else
                    {
                        _logger.Warning("[Auto-Season-Request] Item or Session/UserId is null, cannot process");
                    }
                }
                //This probably can be removed but leaving it for now as a debug log
                else
                {
                    _logger.Debug($"[Auto-Season-Request] Episode not completed enough ({completionPercentage:P1}), skipping");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Auto-Season-Request] Error in OnPlaybackStopped: {ex.Message}");
            }
        }

        // Handle playback progress events to detect when user starts watching a new episode.
        private async void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                // Check if auto-season-request is enabled
                var config = JellyfinEnhanced.Instance?.Configuration as PluginConfiguration;
                if (config == null || !config.AutoSeasonRequestEnabled || !config.JellyseerrEnabled)
                {
                    return;
                }

                // Only process TV episodes
                if (e.Item?.GetBaseItemKind() != BaseItemKind.Episode)
                {
                    return;
                }

                // Only check when episode just started (within first 2 minutes)
                if (e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks.HasValue && e.Item.RunTimeTicks.Value > 0)
                {
                    var progressPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
                    var progressMinutes = TimeSpan.FromTicks(e.PlaybackPositionTicks.Value).TotalMinutes;

                    // Only trigger on episode start (less than 2 minutes in)
                    if (progressMinutes <= 2 && progressPercentage < 0.05)
                    {
                        // Create a unique key using userId and item ID
                        if (e.Session?.UserId == null || e.Item?.Id == null)
                        {
                            return;
                        }

                        var sessionItemKey = $"{e.Session.UserId}_{e.Item.Id}";

                        // Thread-safe dictionary access
                        lock (_sessionLock)
                        {
                            // Clean up expired cache entries (older than 1 hour)
                            var expiredKeys = _checkedSessions.Where(kvp => (DateTime.Now - kvp.Value).TotalHours > 1)
                                .Select(kvp => kvp.Key)
                                .ToList();
                            foreach (var key in expiredKeys)
                            {
                                _checkedSessions.Remove(key);
                            }

                            // Skip if we've checked this user+item combination in the last hour
                            if (_checkedSessions.ContainsKey(sessionItemKey))
                            {
                                return;
                            }

                            // Mark as checked with current timestamp
                            _checkedSessions[sessionItemKey] = DateTime.Now;
                        }

                        _logger.Info($"[Auto-Season-Request] Episode '{e.Item?.Name ?? "Unknown"}' started by {e.Session?.UserName ?? "Unknown"}, checking threshold");

                        if (e.Item != null && e.Session?.UserId != null)
                        {
                            await _autoSeasonRequestService.CheckEpisodeCompletionAsync(e.Item, e.Session.UserId);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Auto-Season-Request] Error in OnPlaybackProgress: {ex.Message}");
            }
        }

        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Auto-Season-Request] Unsubscribing from playback events");

            _sessionManager.PlaybackStopped -= OnPlaybackStopped;
            _sessionManager.PlaybackProgress -= OnPlaybackProgress;

            GC.SuppressFinalize(this);
        }
    }
}
