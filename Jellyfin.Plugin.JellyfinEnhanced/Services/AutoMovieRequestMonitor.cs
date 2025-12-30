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
    // Monitors playback events to automatically request next movies in collections.
    public class AutoMovieRequestMonitor : IDisposable
    {
        private readonly ISessionManager _sessionManager;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly AutoMovieRequestService _autoMovieRequestService;
        private readonly Logger _logger;

        // Track which user+item combinations have already been checked to avoid duplicate checks
        private readonly Dictionary<string, DateTime> _checkedSessions = new();
        private readonly object _sessionLock = new();

        public AutoMovieRequestMonitor(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoMovieRequestService autoMovieRequestService,
            Logger logger)
        {
            _sessionManager = sessionManager;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _autoMovieRequestService = autoMovieRequestService;
            _logger = logger;
        }

        // Initialize and start monitoring playback events.
        public void Initialize()
        {
            // Check if auto-movie-request is enabled
            var config = JellyfinEnhanced.Instance?.Configuration as Configuration.PluginConfiguration;
            if (config == null)
            {
                _logger.Warning("[Auto-Movie-Request] Configuration is null - skipping auto-movie-request monitoring initialization");
                return;
            }

            if (!config.AutoMovieRequestEnabled || !config.JellyseerrEnabled)
            {
                _logger.Info("[Auto-Movie-Request] Auto-Movie-Request monitoring is disabled in configuration - not subscribing to playback events");
                return;
            }

            _logger.Info("[Auto-Movie-Request] Initializing playback event monitoring");

            // Subscribe to playback progress events (to detect when user starts watching)
            _sessionManager.PlaybackProgress += OnPlaybackProgress;

            _logger.Info("[Auto-Movie-Request] Successfully subscribed to playback events");
        }

        // Handle playback progress events to detect when user starts watching a movie.
        private async void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                // Check if auto-movie-request is enabled
                var config = JellyfinEnhanced.Instance?.Configuration as PluginConfiguration;
                if (config == null || !config.AutoMovieRequestEnabled || !config.JellyseerrEnabled)
                {
                    return;
                }

                // Only process movies
                if (e.Item?.GetBaseItemKind() != BaseItemKind.Movie)
                {
                    return;
                }

                // Check if conditions for triggering are met based on configuration
                if (e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks.HasValue && e.Item.RunTimeTicks.Value > 0)
                {
                    var progressPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
                    var progressMinutes = TimeSpan.FromTicks(e.PlaybackPositionTicks.Value).TotalMinutes;

                    var triggerType = config.AutoMovieRequestTriggerType ?? "Both";
                    var minutesWatched = config.AutoMovieRequestMinutesWatched;

                    bool shouldTrigger = false;

                    if (triggerType == "OnStart")
                    {
                        // Trigger only on movie start (less than 5 minutes in and less than 5% progress)
                        shouldTrigger = (progressMinutes <= 5 && progressPercentage < 0.05);
                    }
                    else if (triggerType == "OnMinutesWatched")
                    {
                        // Trigger only when user has watched for configured minutes
                        shouldTrigger = (progressMinutes >= minutesWatched);
                    }
                    else if (triggerType == "Both")
                    {
                        // Trigger on either condition
                        shouldTrigger = (progressMinutes <= 5 && progressPercentage < 0.05) || (progressMinutes >= minutesWatched);
                    }

                    if (shouldTrigger)
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

                        _logger.Info($"[Auto-Movie-Request] Movie '{e.Item?.Name ?? "Unknown"}' started by {e.Session?.UserName ?? "Unknown"}, checking for collection");

                        if (e.Item != null && e.Session?.UserId != null)
                        {
                            await _autoMovieRequestService.CheckMovieForCollectionRequestAsync(e.Item, e.Session.UserId);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Auto-Movie-Request] Error in OnPlaybackProgress: {ex.Message}");
            }
        }

        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Auto-Movie-Request] Unsubscribing from playback events");

            _sessionManager.PlaybackProgress -= OnPlaybackProgress;

            GC.SuppressFinalize(this);
        }
    }
}
