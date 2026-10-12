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
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
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

        /// <summary>
        /// The prefix the sync writes and clears: the configured one, or the default when it is null
        /// or empty. Empty would match every tag (<c>StartsWith("")</c>), so it never reaches the
        /// sync. Whitespace is kept as typed, as the client's tag links read it.
        /// </summary>
        internal static string ResolveTagPrefix(Configuration.PluginConfiguration? config)
            => string.IsNullOrEmpty(config?.ArrTagsPrefix) ? Configuration.PluginConfiguration.DefaultArrTagsPrefix : config.ArrTagsPrefix;

        /// <summary>
        /// Tag labels per provider id, unioned over every instance of one kind, plus which ids any
        /// arr entry has at all (tagged or not): an item whose only ids are aliases (TMDB/IMDb for a
        /// series, IMDb for a movie) is known to be absent only when no entry has them.
        /// </summary>
        private sealed class TagIndex
        {
            public Dictionary<int, List<string>> ByTmdb { get; } = new();
            public Dictionary<int, List<string>> ByTvdb { get; } = new();
            public Dictionary<string, List<string>> ByImdb { get; } = new(StringComparer.OrdinalIgnoreCase);
            public HashSet<int> EntryTmdb { get; } = new();
            public HashSet<string> EntryImdb { get; } = new(StringComparer.OrdinalIgnoreCase);

            /// <summary>
            /// Radarr only: the TMDB ids (0 for none) of the movie entries that carry each IMDb id.
            /// An IMDb id more than one movie carries (a duplicate entry, a stale id) names none of them.
            /// </summary>
            public Dictionary<string, HashSet<int>> MovieImdbOwners { get; } = new(StringComparer.OrdinalIgnoreCase);

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
        /// TMDB and IMDb; series by TVDB, TMDB and IMDb (Jellyfin items often lack one of them).
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
                    var imdb = TitleAliases.FromIds(true, movie.TmdbId, null, movie.ImdbId).Select(TitleKey.Parse).FirstOrDefault(k => k?.Provider == "imdb")?.Id;
                    if (movie.TmdbId is > 0 and var movieTmdb) index.EntryTmdb.Add(movieTmdb);
                    if (imdb != null)
                    {
                        index.EntryImdb.Add(imdb);
                        if (!index.MovieImdbOwners.TryGetValue(imdb, out var owners)) index.MovieImdbOwners[imdb] = owners = new HashSet<int>();
                        owners.Add(movie.TmdbId is > 0 and var owner ? owner : 0);
                    }
                    var labels = library.Labels(movie.Tags);
                    if (labels.Count == 0) continue;
                    var any = false;
                    if (movie.TmdbId is > 0 and var tmdb) { TagIndex.Add(index.ByTmdb, tmdb, labels); any = true; }
                    if (imdb != null) { TagIndex.Add(index.ByImdb, imdb, labels); any = true; }
                    if (any) mapped++;
                }
                foreach (var series in library.Series)
                {
                    var imdb = TitleAliases.FromIds(false, series.TmdbId, series.TvdbId, series.ImdbId).Select(TitleKey.Parse).FirstOrDefault(k => k?.Provider == "imdb")?.Id;
                    if (series.TmdbId is > 0 and var seriesTmdb) index.EntryTmdb.Add(seriesTmdb);
                    if (imdb != null) index.EntryImdb.Add(imdb);
                    var labels = library.Labels(series.Tags);
                    if (labels.Count == 0) continue;
                    var any = false;
                    if (series.TvdbId is > 0 and var tvdb) { TagIndex.Add(index.ByTvdb, tvdb, labels); any = true; }
                    if (series.TmdbId is > 0 and var tmdb) { TagIndex.Add(index.ByTmdb, tmdb, labels); any = true; }
                    if (imdb != null) { TagIndex.Add(index.ByImdb, imdb, labels); any = true; }
                    if (any) mapped++;
                }
                _logger.Info($"Fetched {mapped} {(kind == ArrKind.Radarr ? "movie" : "series")} tag mappings from {instance.Name}");
            }
            return index;
        }

        /// <summary>
        /// The Radarr labels of a Jellyfin movie, and whether its place in Radarr is certain (so old
        /// prefixed tags may be cleared). A TMDB id some Radarr movie has decides alone. Otherwise the
        /// IMDb id decides when exactly one Radarr movie (one TMDB id, on any number of instances)
        /// carries it; carried by several, it names none: no labels, and the old tags are kept. With
        /// neither matching, a TMDB id proves the movie is not in Radarr. When some Radarr instance
        /// could not be read, the IMDb id decides nothing: the movie's own TMDB id may be on the
        /// unread instance, and one owner of the IMDb id among the instances read is no proof of one
        /// owner in all, so no labels are added from it.
        /// </summary>
        private static (List<string>? Tags, bool Proven) MatchMovie(TagIndex radarr, int? tmdb, string? imdb)
        {
            if (tmdb is int t && radarr.EntryTmdb.Contains(t)) return (radarr.ByTmdb.GetValueOrDefault(t), true);
            if (!radarr.Complete) return (null, false);
            if (imdb != null && radarr.MovieImdbOwners.TryGetValue(imdb, out var owners))
            {
                return owners.Count == 1 ? (radarr.ByImdb.GetValueOrDefault(imdb), true) : (null, false);
            }
            return (null, tmdb != null);
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

            string tagPrefix = ResolveTagPrefix(config);
            // Belt and braces: an empty prefix would match (and clear) every tag an item has.
            bool clearOldTags = config.ArrTagsClearOldTags && tagPrefix.Length > 0;

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
                // Whether the arrs' answer for this item can be trusted to be complete: it has the
                // kind's own id (TMDB for a movie, TVDB for a series: absent from every instance
                // means not there), or an alias id some arr entry has (tagged or not). An item with
                // no usable id, or only aliases no entry has, may well be in the arr under ids
                // Jellyfin doesn't know: its prefixed tags are kept.
                var proven = false;

                // Check if it's a movie: TMDB (Radarr's own id) when a Radarr movie has it; IMDb only
                // when none does, and only when one movie (one TMDB id) carries that IMDb id.
                if (item is Movie movie)
                {
                    kindComplete = radarrTags.Complete;
                    var keys = TitleAliases.FromProviderIds(true, movie.GetProviderId(MetadataProvider.Tmdb), null, movie.GetProviderId(MetadataProvider.Imdb));
                    (tagsToAdd, proven) = MatchMovie(radarrTags, keys.FirstOrDefault(k => k.Provider == "tmdb")?.NumericId, keys.FirstOrDefault(k => k.Provider == "imdb")?.Id);
                }
                // Check if it's a series: TVDB (Sonarr's own id), then TMDB and IMDb. The labels of
                // every id that matches are combined, so a series is found whichever ids it has.
                else if (item is Series series)
                {
                    kindComplete = sonarrTags.Complete;
                    var keys = TitleAliases.FromProviderIds(false, series.GetProviderId(MetadataProvider.Tmdb), series.GetProviderId(MetadataProvider.Tvdb), series.GetProviderId(MetadataProvider.Imdb));
                    var tvdb = keys.FirstOrDefault(k => k.Provider == "tvdb")?.NumericId;
                    var tmdb = keys.FirstOrDefault(k => k.Provider == "tmdb")?.NumericId;
                    var imdb = keys.FirstOrDefault(k => k.Provider == "imdb")?.Id;
                    var byTvdb = tvdb is int v ? sonarrTags.ByTvdb.GetValueOrDefault(v) : null;
                    var byTmdb = tmdb is int t ? sonarrTags.ByTmdb.GetValueOrDefault(t) : null;
                    var byImdb = imdb == null ? null : sonarrTags.ByImdb.GetValueOrDefault(imdb);
                    tagsToAdd = TagIndex.Union(byTvdb, byTmdb, byImdb);
                    proven = tvdb != null
                        || (tmdb is int et && sonarrTags.EntryTmdb.Contains(et))
                        || (imdb != null && sonarrTags.EntryImdb.Contains(imdb));
                }

                var existingTags = item.Tags?.ToList() ?? new List<string>();
                var modified = false;

                // Clear old tags with the prefix if enabled - but only when every instance of this
                // kind was read (a failed read must not strip the tags it would have confirmed) and
                // the item's absence from the arrs can be proven (see above).
                if (clearOldTags && kindComplete && !proven)
                {
                    _logger.Debug($"Arr Tags Sync: keeping the prefixed tags of {item.Name}: none of its ids proves it is (or isn't) in {(item is Movie ? "Radarr" : "Sonarr")}.");
                }
                if (clearOldTags && kindComplete && proven)
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
