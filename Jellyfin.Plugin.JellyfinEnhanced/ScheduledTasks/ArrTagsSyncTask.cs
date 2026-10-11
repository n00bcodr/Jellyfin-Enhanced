using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// Scheduled task that syncs tags from Radarr and Sonarr to Jellyfin items.
    public class ArrTagsSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ArrStateStore _arrState;
        private readonly Logger _logger;

        public ArrTagsSyncTask(
            ILibraryManager libraryManager,
            ArrStateStore arrState,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _arrState = arrState;
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

        /// <summary>Tag labels per provider id, unioned over every instance of one kind.</summary>
        private sealed class TagIndex
        {
            public Dictionary<int, List<string>> ByTmdb { get; } = new();
            public Dictionary<int, List<string>> ByTvdb { get; } = new();
            public Dictionary<string, List<string>> ByImdb { get; } = new(StringComparer.OrdinalIgnoreCase);

            /// <summary>
            /// False when some instance of this kind could not be read (or its list is corrupt): the
            /// labels are incomplete, so existing prefixed tags must not be cleared this run.
            /// </summary>
            public bool Complete { get; set; } = true;

            public static void Add<TKey>(Dictionary<TKey, List<string>> map, TKey key, List<string> labels)
                where TKey : notnull
            {
                if (labels.Count == 0) return;
                if (!map.TryGetValue(key, out var existing))
                {
                    map[key] = new List<string>(labels);
                    return;
                }
                foreach (var tag in labels)
                {
                    if (!existing.Contains(tag, StringComparer.OrdinalIgnoreCase))
                        existing.Add(tag);
                }
            }

            public static List<string>? Union(params List<string>?[] lists)
            {
                List<string>? result = null;
                foreach (var list in lists)
                {
                    if (list == null) continue;
                    result ??= new List<string>();
                    foreach (var tag in list)
                    {
                        if (!result.Contains(tag, StringComparer.OrdinalIgnoreCase)) result.Add(tag);
                    }
                }
                return result;
            }
        }

        /// <summary>
        /// Reads the library index of every enabled instance of a kind (a fresh read, through the
        /// shared arr state store) and indexes the tag labels by provider id. Movies are matched by
        /// TMDB; series by TVDB, TMDB and IMDb (Jellyfin series often lack one of them).
        /// </summary>
        private async Task<TagIndex> CollectAsync(ArrKind kind, bool corrupt, CancellationToken cancellationToken)
        {
            var index = new TagIndex();
            var label = kind.ToString();
            if (corrupt)
            {
                index.Complete = false;
                _logger.Error($"{label}Instances config is corrupt JSON — no {label} tags will sync this run and existing tags are kept. "
                    + "Admin must open the Arr Links config page and reset the corrupt value.");
            }

            var instances = _arrState.Instances(kind);
            // An enabled instance whose saved key can't be read (secrets.json unreadable or missing the
            // key) was not fetched: its titles' tags must not be cleared as if it had none.
            var unreadable = _arrState.Registry.Usable(kind)
                .Where(c => !string.IsNullOrEmpty(c.StoredKey) && !instances.Any(i => string.Equals(i.Id, c.Id, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (unreadable.Count > 0)
            {
                index.Complete = false;
                _logger.Error($"The saved API key of {label} instance(s) {string.Join(", ", unreadable.Select(c => c.Name))} can't be read (see the Secrets messages in the log); they are skipped and existing {label} tags are kept this run.");
            }
            if (instances.Count == 0)
            {
                if (unreadable.Count > 0) return index;
                var configured = _arrState.Registry.All().Count(c => c.Kind == kind);
                var enabled = _arrState.Registry.Usable(kind).Count;
                _logger.Info(configured == 0 ? $"No {label} instances configured, skipping {label} sync"
                    : enabled == 0 ? $"All {configured} {label} instances are disabled — skipping {label} sync"
                    : $"No enabled {label} instance has an API key, skipping {label} sync");
                return index;
            }

            foreach (var instance in instances)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _logger.Info($"Fetching tags from {label} instance: {instance.Name}");
                var result = await _arrState.RefreshLibraryNowAsync(instance, cancellationToken).ConfigureAwait(false);
                if (!result.Ok)
                {
                    index.Complete = false;
                    _logger.Error($"Failed to sync tags from {label} instance {instance.Name} ({result.Error!.Kind}: {result.Error.Message.TrimEnd('.')}). Existing {label} tags are kept this run.");
                    continue;
                }

                var library = result.Value!;
                var mapped = 0;
                foreach (var movie in library.Movies)
                {
                    var labels = library.Labels(movie.Tags);
                    if (labels.Count == 0) continue;
                    if (movie.TmdbId is > 0 and var tmdb) { TagIndex.Add(index.ByTmdb, tmdb, labels); mapped++; }
                }
                foreach (var series in library.Series)
                {
                    var labels = library.Labels(series.Tags);
                    if (labels.Count == 0) continue;
                    var any = false;
                    if (series.TvdbId is > 0 and var tvdb) { TagIndex.Add(index.ByTvdb, tvdb, labels); any = true; }
                    if (series.TmdbId is > 0 and var tmdb) { TagIndex.Add(index.ByTmdb, tmdb, labels); any = true; }
                    if (!string.IsNullOrWhiteSpace(series.ImdbId)) { TagIndex.Add(index.ByImdb, series.ImdbId.Trim(), labels); any = true; }
                    if (any) mapped++;
                }
                _logger.Info($"Fetched {mapped} {(kind == ArrKind.Radarr ? "movie" : "series")} tag mappings from {instance.Name}");
            }
            return index;
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

            var radarrTags = await CollectAsync(ArrKind.Radarr, config.IsRadarrInstancesCorrupt(), cancellationToken).ConfigureAwait(false);
            progress?.Report(25);
            cancellationToken.ThrowIfCancellationRequested();

            var sonarrTags = await CollectAsync(ArrKind.Sonarr, config.IsSonarrInstancesCorrupt(), cancellationToken).ConfigureAwait(false);
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

            // Parse sync filter - if empty, sync all tags
            var syncFilterTags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(config.ArrTagsSyncFilter))
            {
                var filterParts = config.ArrTagsSyncFilter.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (var part in filterParts)
                {
                    syncFilterTags.Add(part.Trim());
                }
                _logger.Info($"Filtering tags to sync: {string.Join(", ", syncFilterTags)}");
            }

            foreach (var item in allItems)
            {
                cancellationToken.ThrowIfCancellationRequested();

                List<string>? tagsToAdd = null;
                var kindComplete = true;

                // Check if it's a movie
                if (item is Movie movie)
                {
                    kindComplete = radarrTags.Complete;
                    if (int.TryParse(movie.GetProviderId(MetadataProvider.Tmdb), out var tmdbIdInt))
                    {
                        tagsToAdd = radarrTags.ByTmdb.GetValueOrDefault(tmdbIdInt);
                    }
                }
                // Check if it's a series: TVDB (Sonarr's own id), then TMDB and IMDb. The labels of
                // every id that matches are combined, so a series is found whichever ids it has.
                else if (item is Series series)
                {
                    kindComplete = sonarrTags.Complete;
                    var byTvdb = int.TryParse(series.GetProviderId(MetadataProvider.Tvdb), out var tvdb) ? sonarrTags.ByTvdb.GetValueOrDefault(tvdb) : null;
                    var byTmdb = int.TryParse(series.GetProviderId(MetadataProvider.Tmdb), out var tmdb) ? sonarrTags.ByTmdb.GetValueOrDefault(tmdb) : null;
                    var imdbId = series.GetProviderId(MetadataProvider.Imdb);
                    var byImdb = string.IsNullOrWhiteSpace(imdbId) ? null : sonarrTags.ByImdb.GetValueOrDefault(imdbId.Trim());
                    tagsToAdd = TagIndex.Union(byTvdb, byTmdb, byImdb);
                }

                var existingTags = item.Tags?.ToList() ?? new List<string>();
                var modified = false;

                // Clear old tags with the prefix if enabled - but only when every instance of this
                // kind was read: a failed read must not strip the tags it would have confirmed.
                if (clearOldTags && kindComplete)
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
                        // Apply sync filter - skip tags not in filter (if filter is set)
                        if (syncFilterTags.Count > 0 && !syncFilterTags.Contains(tag))
                        {
                            continue;
                        }

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
                if (modified && !(item.Tags ?? Array.Empty<string>()).SequenceEqual(existingTags, StringComparer.Ordinal))
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
