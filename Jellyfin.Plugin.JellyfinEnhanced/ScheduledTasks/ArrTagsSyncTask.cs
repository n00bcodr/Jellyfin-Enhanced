using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// Scheduled task that syncs tags from Radarr and Sonarr to Jellyfin items.
    public class ArrTagsSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        public ArrTagsSyncTask(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public string Name => "Sync Tags from *arr to Jellyfin";

        public string Key => "JellyfinEnhancedArrTagsSync";

        public string Description => "Fetches tags from Radarr and Sonarr and adds them to Jellyfin items as metadata tags. \n\n Configure the task triggers to run this task periodically for new items to be synced automatically.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // No default triggers - run on demand only
            return Array.Empty<TaskTriggerInfo>();
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.ArrTagsSyncEnabled)
            {
                _logger.Info("Arr Tags Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            _logger.Info("Starting Arr Tags Sync task...");
            progress?.Report(0);

            var radarrService = new RadarrService(_httpClientFactory, _logger);
            var sonarrService = new SonarrService(_httpClientFactory, _logger);

            Dictionary<int, List<string>> radarrTags = new Dictionary<int, List<string>>();
            Dictionary<string, List<string>> sonarrTags = new Dictionary<string, List<string>>();

            // Fetch Radarr tags if configured
            if (!string.IsNullOrWhiteSpace(config.RadarrUrl) && !string.IsNullOrWhiteSpace(config.RadarrApiKey))
            {
                _logger.Info("Fetching tags from Radarr...");
                radarrTags = await radarrService.GetMovieTagsByTmdbId(config.RadarrUrl, config.RadarrApiKey);
                _logger.Info($"Fetched {radarrTags.Count} movie tag mappings from Radarr");
            }
            else
            {
                _logger.Info("Radarr URL or API key not configured, skipping Radarr sync");
            }

            progress?.Report(25);
            cancellationToken.ThrowIfCancellationRequested();

            // Fetch Sonarr tags if configured
            if (!string.IsNullOrWhiteSpace(config.SonarrUrl) && !string.IsNullOrWhiteSpace(config.SonarrApiKey))
            {
                _logger.Info("Fetching tags from Sonarr...");
                sonarrTags = await sonarrService.GetSeriesTagsByTvdbId(config.SonarrUrl, config.SonarrApiKey);
                _logger.Info($"Fetched {sonarrTags.Count} series tag mappings from Sonarr");
            }
            else
            {
                _logger.Info("Sonarr URL or API key not configured, skipping Sonarr sync");
            }

            progress?.Report(50);
            cancellationToken.ThrowIfCancellationRequested();

            // Get all movies and series from Jellyfin
            var allItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                IsVirtualItem = false,
                Recursive = true
            }).ToList();

            _logger.Info($"Found {allItems.Count} items in Jellyfin library");

            var updatedCount = 0;
            var totalItems = allItems.Count;
            var processedItems = 0;
            var updatedItemNames = new List<string>(); // Track updated items for batch logging

            string tagPrefix = config.ArrTagsPrefix ?? "Requested by: ";
            bool clearOldTags = config.ArrTagsClearOldTags;

            foreach (var item in allItems)
            {
                cancellationToken.ThrowIfCancellationRequested();

                List<string>? tagsToAdd = null;

                // Check if it's a movie
                if (item is Movie movie)
                {
                    var tmdbId = movie.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb);
                    if (!string.IsNullOrWhiteSpace(tmdbId) && int.TryParse(tmdbId, out var tmdbIdInt))
                    {
                        if (radarrTags.TryGetValue(tmdbIdInt, out var tags))
                        {
                            tagsToAdd = tags;
                        }
                    }
                }
                // Check if it's a series
                else if (item is Series series)
                {
                    var imdbId = series.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Imdb);
                    if (!string.IsNullOrWhiteSpace(imdbId))
                    {
                        if (sonarrTags.TryGetValue(imdbId, out var tags))
                        {
                            tagsToAdd = tags;
                        }
                    }
                }

                var existingTags = item.Tags?.ToList() ?? new List<string>();
                var modified = false;

                // Clear old tags with the prefix if enabled
                if (clearOldTags)
                {
                    var tagsToRemove = existingTags
                        .Where(t => t.StartsWith(tagPrefix, StringComparison.OrdinalIgnoreCase))
                        .ToList();

                    if (tagsToRemove.Count > 0)
                    {
                        foreach (var tag in tagsToRemove)
                        {
                            existingTags.Remove(tag);
                        }
                        modified = true;
                    }
                }

                // Add new tags if found
                if (tagsToAdd != null && tagsToAdd.Count > 0)
                {
                    foreach (var tag in tagsToAdd)
                    {
                        var formattedTag = $"{tagPrefix}{tag}";

                        // Only add if not already present
                        if (!existingTags.Contains(formattedTag, StringComparer.OrdinalIgnoreCase))
                        {
                            existingTags.Add(formattedTag);
                            modified = true;
                        }
                    }
                }

                // Update item if modified
                if (modified)
                {
                    item.Tags = existingTags.ToArray();
                    await item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken);
                    updatedCount++;
                    updatedItemNames.Add(item.Name);
                    
                    // Log in batches of 50 items to reduce log spam
                    if (updatedItemNames.Count >= 50)
                    {
                        _logger.Info($"Updated tags for {updatedItemNames.Count} items: {string.Join(", ", updatedItemNames.Take(10))}...");
                        updatedItemNames.Clear();
                    }
                }

                processedItems++;
                var currentProgress = 50 + (int)((double)processedItems / totalItems * 50);
                progress?.Report(currentProgress);
            }

            // Log any remaining updated items
            if (updatedItemNames.Count > 0)
            {
                if (updatedItemNames.Count <= 10)
                {
                    _logger.Info($"Updated tags for: {string.Join(", ", updatedItemNames)}");
                }
                else
                {
                    _logger.Info($"Updated tags for {updatedItemNames.Count} items: {string.Join(", ", updatedItemNames.Take(10))}...");
                }
            }

            _logger.Info($"Arr Tags Sync completed. Updated {updatedCount} items out of {totalItems}");
            progress?.Report(100);
        }
    }
}
