using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// Scheduled task that writes each movie's and series' audio languages as prefixed Jellyfin tags.
    public class AudioLanguageTagsSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ILocalizationManager _localization;
        private readonly TagCacheService _tagCacheService;
        private readonly Logger _logger;

        public AudioLanguageTagsSyncTask(
            ILibraryManager libraryManager,
            ILocalizationManager localization,
            TagCacheService tagCacheService,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _localization = localization;
            _tagCacheService = tagCacheService;
            _logger = logger;
        }

        public string Name => "Sync Audio Language Tags to Jellyfin";

        public string Key => "JellyfinEnhancedAudioLanguageTagsSync";

        public string Description => "Adds each movie's and series' audio languages to Jellyfin items as metadata tags.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // No default triggers - run on demand only
            return Array.Empty<TaskTriggerInfo>();
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.AudioLanguageTagSyncEnabled)
            {
                _logger.Info("Audio Language Tags Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            var tagPrefix = AudioLanguageTagHelper.GetPrefix(config);

            _logger.Info("Starting Audio Language Tags Sync task...");
            progress?.Report(0);

            var allItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                IsVirtualItem = false,
                Recursive = true
            }).ToList();

            _logger.Info($"Found {allItems.Count} items in Jellyfin library");

            var nameCache = new Dictionary<string, (string Base, string? Variant)>(StringComparer.OrdinalIgnoreCase);
            var updatedCount = 0;
            var processed = 0;
            var updatedItemNames = new List<string>();

            foreach (var item in allItems)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Cached entry when available, otherwise built directly. A null entry leaves the item's tags unchanged.
                var entry = _tagCacheService.TryGetEntry(item.Id, out var cached)
                    ? cached
                    : _tagCacheService.BuildEntryOnDemand(item);

                if (entry != null)
                {
                    var updatedTags = AudioLanguageTagHelper.BuildUpdatedTags(
                        item.Tags, entry.AudioLanguages, tagPrefix, _localization, nameCache);

                    if (updatedTags != null)
                    {
                        item.Tags = updatedTags;
                        await item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken);
                        updatedCount++;
                        updatedItemNames.Add(item.Name);

                        // Logged in batches of 50
                        if (updatedItemNames.Count >= 50)
                        {
                            _logger.Info($"Updated audio language tags for {updatedItemNames.Count} items ({processed + 1}/{allItems.Count} processed): {string.Join(", ", updatedItemNames.Take(10))}...");
                            updatedItemNames.Clear();
                        }
                    }
                }

                processed++;
                progress?.Report((double)processed / allItems.Count * 100);
            }

            if (updatedItemNames.Count > 0)
            {
                _logger.Info($"Updated audio language tags for {updatedItemNames.Count} items: {string.Join(", ", updatedItemNames.Take(10))}{(updatedItemNames.Count > 10 ? "..." : string.Empty)}");
            }

            _logger.Info($"Audio Language Tags Sync completed. Updated {updatedCount} items out of {allItems.Count}");
            progress?.Report(100);
        }
    }
}
