using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>A Jellyfin library: name, type and folders (Jellyfin's view of the disk).</summary>
    public sealed class JfLibraryRoot
    {
        /// <summary>The library's (collection folder's) item id.</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary>Display name.</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>movies, tvshows, mixed, … (null when not set).</summary>
        public string? CollectionType { get; init; }

        /// <summary>Its folders.</summary>
        public IReadOnlyList<string> Locations { get; init; } = Array.Empty<string>();

        /// <summary>The library has real-time monitoring on (Jellyfin then reacts to changed paths itself).</summary>
        public bool RealtimeMonitor { get; init; }
    }

    /// <summary>The Jellyfin item at a path.</summary>
    public sealed class JfPathItem
    {
        /// <summary>Item id.</summary>
        public Guid Id { get; init; }

        /// <summary>movie, episode, series, season, folder or other.</summary>
        public string Kind { get; init; } = "other";

        /// <summary>A folder (can be refreshed).</summary>
        public bool IsFolder { get; init; }
    }

    /// <summary>How far one hydration of a just-imported item reaches (<see cref="IJellyfinLibraryAccess.QueueHydration"/>).</summary>
    public enum HydrationScope
    {
        /// <summary>One movie or episode: queued, never anything around it.</summary>
        Item,

        /// <summary>A series JE just created and everything in it (its seasons and episodes are all new): queued; only inside that series.</summary>
        SeriesTree,

        /// <summary>A series' or season's own metadata only, without its children (an existing series whose own title is still raw).</summary>
        ItemOnly,
    }

    /// <summary>
    /// What the bridge reads back from one Jellyfin item to tell whether its metadata is usable: the title as Jellyfin shows
    /// it, whether it has an overview, artwork and provider ids, the media info of a video, an episode's numbers and binding.
    /// </summary>
    public sealed class JfItemFacts
    {
        /// <summary>Item id.</summary>
        public Guid Id { get; init; }

        /// <summary>movie, episode, series, season, folder or other.</summary>
        public string Kind { get; init; } = "other";

        /// <summary>The item's file or folder (bridge form, '/').</summary>
        public string? Path { get; init; }

        /// <summary>The title Jellyfin shows.</summary>
        public string? Name { get; init; }

        /// <summary>It has an overview.</summary>
        public bool HasOverview { get; init; }

        /// <summary>It has a primary image (a poster, an episode still).</summary>
        public bool HasPrimary { get; init; }

        /// <summary>It has a backdrop.</summary>
        public bool HasBackdrop { get; init; }

        /// <summary>It has a TMDB, TVDB or IMDb id.</summary>
        public bool HasProviderIds { get; init; }

        /// <summary>A movie or episode whose file Jellyfin has read (runtime or video dimensions known).</summary>
        public bool Probed { get; init; }

        /// <summary>Season number (episodes).</summary>
        public int? Season { get; init; }

        /// <summary>Episode number (episodes).</summary>
        public int? Episode { get; init; }

        /// <summary>The series item (episodes, seasons).</summary>
        public Guid SeriesId { get; init; }

        /// <summary>The season item (episodes).</summary>
        public Guid SeasonId { get; init; }

        /// <summary>When Jellyfin last finished refreshing it without a failure (UTC), or null when it never has.</summary>
        public DateTime? LastRefreshed { get; init; }

        /// <summary>An administrator locked its metadata or its title: JE never asks for it to be replaced.</summary>
        public bool NameLocked { get; init; }

        /// <summary>An episode's series, as the same facts (null otherwise).</summary>
        public JfItemFacts? Series { get; init; }
    }

    /// <summary>The item for a new folder (<see cref="IJellyfinLibraryAccess.CreateChildFolder"/>).</summary>
    /// <param name="Id">Item id.</param>
    /// <param name="Kind">series, movie, season, folder or other.</param>
    /// <param name="Created">True when JE created it; false when Jellyfin already had it (its own monitor came first).</param>
    public sealed record JfCreatedItem(Guid Id, string Kind, bool Created);

    /// <summary>
    /// What the Jellyfin bridge needs from Jellyfin's library: the libraries and their folders, the
    /// item at a path, which titles exist by provider id, and the targeted refresh itself. One seam
    /// so the path rules can be tested without a Jellyfin server.
    /// </summary>
    public interface IJellyfinLibraryAccess
    {
        /// <summary>Every library with its folders.</summary>
        IReadOnlyList<JfLibraryRoot> Libraries();

        /// <summary>The item Jellyfin has at exactly this path, or null.</summary>
        JfPathItem? FindByPath(string path);

        /// <summary>True when Jellyfin's process can see a file at this path.</summary>
        bool FileExists(string path);

        /// <summary>True when Jellyfin's process can see a folder at this path.</summary>
        bool DirectoryExists(string path);

        /// <summary>The files and folders directly inside a folder, as Jellyfin's process sees them (empty when unreadable).</summary>
        IReadOnlyList<string> Entries(string folder);

        /// <summary>The path of a movie (<paramref name="movie"/>) or series Jellyfin has with this provider id (tmdb, imdb, tvdb), or null.</summary>
        string? ItemPathByProvider(bool movie, string provider, string id);

        /// <summary>Every movie and series provider id Jellyfin has, as "tmdb:603" / "imdb:tt0133093" / "tvdb:78874".</summary>
        (IReadOnlySet<string> Movies, IReadOnlySet<string> Series) ProviderIndex();

        /// <summary>True while Jellyfin's "Scan media library" task runs.</summary>
        bool LibraryScanRunning { get; }

        /// <summary>Validates one folder's children, non-recursively, looking only at <paramref name="refreshPaths"/>.</summary>
        Task RefreshFolderAsync(Guid folderId, IReadOnlyList<string> refreshPaths, CancellationToken cancellationToken);

        /// <summary>
        /// Queues a refresh of one movie or episode whose file changed in place (an upgrade imported at the same
        /// path): Jellyfin reads the file and its versions again (media info, dimensions). False when the item isn't a video.
        /// </summary>
        bool QueueFileRefresh(Guid itemId);

        /// <summary>
        /// Tells Jellyfin's library monitor a path changed (its own debounced refresh, as real-time
        /// monitoring does). Jellyfin acts on it whatever the library's monitoring setting, by
        /// validating the nearest item it has recursively: only for a library with real-time monitoring on
        /// whose own folder Jellyfin has no item for (never a new series: that is added on its own).
        /// </summary>
        void ReportChanged(string path);

        /// <summary>
        /// Removes the missing (virtual) episodes Jellyfin still lists for the slot an episode file now fills
        /// (same series, season and episode number), as Jellyfin's own series refresh does; no file is
        /// touched. Returns how many it removed: 0 when the path isn't an episode with a file, -1 while
        /// Jellyfin hasn't numbered that episode yet (its metadata does, a moment after it is added).
        /// </summary>
        int RemoveMissingTwins(string filePath);

        /// <summary>A file's size and last write (UTC) as Jellyfin's process sees them, or null when it can't see a file there.</summary>
        (long Size, DateTime ModifiedUtc)? FileStamp(string path);

        /// <summary>The facts the bridge judges an item's metadata by (<see cref="JfItemFacts"/>), or null when there is no such item.</summary>
        JfItemFacts? ReadFacts(Guid itemId);

        /// <summary>
        /// Has one just-imported item's metadata read in full and repaired: remote metadata AND remote images refreshed in
        /// full (a first read that found nothing, or a refresh stamp, never keeps them from running), the title and overview
        /// replaced by what the providers have (locked fields kept; existing artwork kept, missing artwork filled), at high
        /// priority. <paramref name="scope"/> decides how far it reaches; never a library or a library folder. False when the
        /// item isn't one the scope allows.
        /// </summary>
        bool QueueHydration(Guid itemId, HydrationScope scope);

        /// <summary>
        /// Adds the item for ONE new folder directly inside <paramref name="parentFolderId"/> (a new series folder in a TV
        /// library's own folder) the way Jellyfin's scan would: its resolver reads only that folder, under that parent, and
        /// the item is created there. Nothing else in the parent is looked at (no validation of the library folder). When
        /// Jellyfin already has an item there (its monitor came first) that one is returned. Null when nothing resolves.
        /// </summary>
        JfCreatedItem? CreateChildFolder(Guid parentFolderId, string folderPath);
    }

    /// <summary><see cref="IJellyfinLibraryAccess"/> over the real library, provider and task managers.</summary>
    public sealed class JellyfinLibraryAccess : IJellyfinLibraryAccess
    {
        private const string LibraryScanTaskKey = "RefreshLibrary";
        private readonly ILibraryManager _libraryManager;
        private readonly IProviderManager _providerManager;
        private readonly IFileSystem _fileSystem;
        private readonly ITaskManager _taskManager;
        private readonly ILibraryMonitor _libraryMonitor;
        private readonly char _separator;

        /// <summary>Creates the access (DI).</summary>
        public JellyfinLibraryAccess(ILibraryManager libraryManager, IProviderManager providerManager, IFileSystem fileSystem, ITaskManager taskManager, ILibraryMonitor libraryMonitor)
            : this(libraryManager, providerManager, fileSystem, taskManager, libraryMonitor, Path.DirectorySeparatorChar)
        {
        }

        /// <summary>Creates the access for a server whose paths use <paramref name="separator"/> (tests: a Windows server).</summary>
        internal JellyfinLibraryAccess(ILibraryManager libraryManager, IProviderManager providerManager, IFileSystem fileSystem, ITaskManager taskManager, ILibraryMonitor libraryMonitor, char separator)
        {
            _libraryManager = libraryManager;
            _providerManager = providerManager;
            _fileSystem = fileSystem;
            _taskManager = taskManager;
            _libraryMonitor = libraryMonitor;
            _separator = separator;
        }

        /// <summary>
        /// A bridge path (always '/', see <see cref="BridgePaths.Norm"/>) in the server's own form.
        /// Jellyfin stores item paths with the OS separator and matches them exactly (FindByPath,
        /// RefreshPaths), so on Windows "D:/TV/Show" must become "D:\TV\Show" again.
        /// </summary>
        internal static string ToNative(string path, char separator)
            => separator == '/' ? path : path.Replace('/', separator);

        private string Native(string path) => ToNative(path, _separator);

        /// <inheritdoc />
        public IReadOnlyList<JfLibraryRoot> Libraries()
            => ReadLibraries(_libraryManager);

        /// <summary>The library locations used by path and access decisions.</summary>
        internal static IReadOnlyList<JfLibraryRoot> ReadLibraries(ILibraryManager libraryManager)
            => libraryManager.GetVirtualFolders()
                .Select(v => new JfLibraryRoot
                {
                    Id = v.ItemId ?? string.Empty,
                    Name = v.Name ?? string.Empty,
                    CollectionType = v.CollectionType?.ToString().ToLowerInvariant(),
                    Locations = v.Locations ?? Array.Empty<string>(),
                    RealtimeMonitor = v.LibraryOptions?.EnableRealtimeMonitor == true,
                })
                .ToList();

        /// <inheritdoc />
        public JfPathItem? FindByPath(string path)
        {
            var item = _libraryManager.FindByPath(Native(path), null);
            if (item == null) return null;
            return new JfPathItem
            {
                Id = item.Id,
                IsFolder = item.IsFolder,
                Kind = KindOf(item),
            };
        }

        private static string KindOf(BaseItem item) => item switch
        {
            Movie => "movie",
            Episode => "episode",
            Series => "series",
            Season => "season",
            Folder => "folder",
            _ => "other",
        };

        /// <inheritdoc />
        public bool FileExists(string path)
        {
            try
            {
                return File.Exists(Native(path));
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <inheritdoc />
        public bool DirectoryExists(string path)
        {
            try
            {
                return Directory.Exists(Native(path));
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<string> Entries(string folder)
        {
            try
            {
                return Directory.EnumerateFileSystemEntries(Native(folder)).Take(2000).Select(p => p.Replace('\\', '/')).ToList();
            }
            catch (Exception)
            {
                return Array.Empty<string>();
            }
        }

        /// <inheritdoc />
        public string? ItemPathByProvider(bool movie, string provider, string id)
        {
            var name = provider switch { "tmdb" => "Tmdb", "tvdb" => "Tvdb", _ => "Imdb" };
            return _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { movie ? BaseItemKind.Movie : BaseItemKind.Series },
                HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { name, id } },
                Recursive = true,
                Limit = 1,
                DtoOptions = new DtoOptions(false),
            }).FirstOrDefault()?.Path;
        }

        /// <inheritdoc />
        public (IReadOnlySet<string> Movies, IReadOnlySet<string> Series) ProviderIndex()
        {
            var movies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var series = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                Recursive = true,
                IsVirtualItem = false,
                // Provider ids are only read from the database when asked for.
                DtoOptions = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } },
            });
            foreach (var item in items)
            {
                var target = item is Movie ? movies : series;
                foreach (var (provider, key) in new[] { (MetadataProvider.Tmdb, "tmdb"), (MetadataProvider.Imdb, "imdb"), (MetadataProvider.Tvdb, "tvdb") })
                {
                    var value = item.GetProviderId(provider);
                    if (!string.IsNullOrWhiteSpace(value)) target.Add(key + ":" + value.Trim());
                }
            }
            return (movies, series);
        }

        /// <inheritdoc />
        public bool LibraryScanRunning
            => _taskManager.ScheduledTasks.Any(t => string.Equals(t.ScheduledTask.Key, LibraryScanTaskKey, StringComparison.Ordinal) && t.State == TaskState.Running);

        /// <inheritdoc />
        public async Task RefreshFolderAsync(Guid folderId, IReadOnlyList<string> refreshPaths, CancellationToken cancellationToken)
        {
            if (_libraryManager.GetItemById(folderId) is not Folder folder) return;
            var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem))
            {
                // Without RefreshPaths a non-recursive validate still re-checks every child (spike S2).
                RefreshPaths = refreshPaths.Select(Native).ToArray(),
            };
            await folder.ValidateChildren(new Progress<double>(), options, recursive: false, allowRemoveRoot: false, cancellationToken).ConfigureAwait(false);
        }

        /// <inheritdoc />
        public bool QueueFileRefresh(Guid itemId)
        {
            if (_libraryManager.GetItemById(itemId) is not Video) return false;
            // The default mode re-runs the providers whose file changed (the media probe), and the item's versions with it.
            _providerManager.QueueRefresh(
                itemId,
                new MetadataRefreshOptions(new DirectoryService(_fileSystem))
                {
                    MetadataRefreshMode = MetadataRefreshMode.Default,
                    ImageRefreshMode = MetadataRefreshMode.Default,
                },
                RefreshPriority.High);
            return true;
        }

        /// <inheritdoc />
        public void ReportChanged(string path) => _libraryMonitor.ReportFileSystemChanged(Native(path));

        /// <inheritdoc />
        public (long Size, DateTime ModifiedUtc)? FileStamp(string path)
        {
            try
            {
                var info = new FileInfo(Native(path));
                // A fresh look every time (no cached file system entry): an arr still copying keeps changing both.
                info.Refresh();
                return info.Exists ? (info.Length, info.LastWriteTimeUtc) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <inheritdoc />
        public JfItemFacts? ReadFacts(Guid itemId)
        {
            var item = _libraryManager.GetItemById(itemId);
            return item == null ? null : FactsOf(item, item is Episode e ? e.Series : null);
        }

        /// <summary>The facts of one item (and of an episode's series).</summary>
        internal static JfItemFacts FactsOf(BaseItem item, Series? series)
        {
            var video = item as Video;
            var episode = item as Episode;
            return new JfItemFacts
            {
                Id = item.Id,
                Kind = KindOf(item),
                Path = string.IsNullOrEmpty(item.Path) ? null : item.Path.Replace('\\', '/'),
                Name = item.Name,
                HasOverview = !string.IsNullOrWhiteSpace(item.Overview),
                HasPrimary = item.HasImage(ImageType.Primary, 0),
                HasBackdrop = item.HasImage(ImageType.Backdrop, 0),
                HasProviderIds = new[] { MetadataProvider.Tmdb, MetadataProvider.Tvdb, MetadataProvider.Imdb }.Any(p => !string.IsNullOrWhiteSpace(item.GetProviderId(p))),
                Probed = video != null && ((item.RunTimeTicks ?? 0) > 0 || item.Width > 0 || item.Height > 0),
                Season = episode?.ParentIndexNumber ?? (item as Season)?.IndexNumber,
                Episode = episode?.IndexNumber,
                SeriesId = episode?.SeriesId ?? (item as Season)?.SeriesId ?? Guid.Empty,
                SeasonId = episode?.SeasonId ?? Guid.Empty,
                LastRefreshed = item.DateLastRefreshed.Year < 1900 ? null : item.DateLastRefreshed,
                NameLocked = item.IsLocked || (item.LockedFields ?? Array.Empty<MetadataField>()).Contains(MetadataField.Name),
                Series = series == null ? null : FactsOf(series, null),
            };
        }

        /// <inheritdoc />
        public bool QueueHydration(Guid itemId, HydrationScope scope)
        {
            var item = _libraryManager.GetItemById(itemId);
            if (item == null || !Hydratable(item, scope, _libraryManager)) return false;
            var options = HydrationOptions(new DirectoryService(_fileSystem));
            if (scope == HydrationScope.ItemOnly)
            {
                // The folder's own metadata only: a queued refresh of a folder would also validate everything in it with
                // these options, so its own refresh runs directly (in the background; the bridge reads the result back).
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await _providerManager.RefreshSingleItem(item, options, CancellationToken.None).ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        // The bridge reads the item back and retries or publishes it with what is missing.
                    }
                });
                return true;
            }
            _providerManager.QueueRefresh(itemId, options, RefreshPriority.High);
            return true;
        }

        /// <summary>
        /// The refresh options of a hydration: remote metadata and remote images refreshed in full (FullRefresh skips the
        /// "changed providers only" and "already refreshed" filters a default refresh applies once an item has a refresh
        /// stamp), the providers' title and overview replacing the raw folder name (FullRefresh alone keeps a non-empty
        /// name), locked fields kept by Jellyfin's own merge, existing artwork kept (only missing artwork is fetched), and
        /// nothing removed. A fresh directory service, so the file is looked at as it is now.
        /// </summary>
        internal static MetadataRefreshOptions HydrationOptions(IDirectoryService directoryService)
            => new(directoryService)
            {
                MetadataRefreshMode = MetadataRefreshMode.FullRefresh,
                ImageRefreshMode = MetadataRefreshMode.FullRefresh,
                ReplaceAllMetadata = true,
                ReplaceAllImages = false,
                RemoveOldMetadata = false,
            };

        /// <summary>
        /// The items a hydration may reach: a movie or episode (<see cref="HydrationScope.Item"/>), a series
        /// (<see cref="HydrationScope.SeriesTree"/>), a series or season (<see cref="HydrationScope.ItemOnly"/>); never a
        /// library, a library's own folder or any other folder.
        /// </summary>
        internal static bool Hydratable(BaseItem item, HydrationScope scope, ILibraryManager libraryManager)
        {
            if (item is ICollectionFolder or AggregateFolder or UserRootFolder || item.IsTopParent) return false;
            if (!string.IsNullOrEmpty(item.Path) && libraryManager.GetVirtualFolders().Any(v => (v.Locations ?? Array.Empty<string>()).Any(l => BridgePaths.SamePath(l, item.Path)))) return false;
            return scope switch
            {
                HydrationScope.Item => item is Movie or Episode,
                HydrationScope.SeriesTree => item is Series,
                _ => item is Series or Season,
            };
        }

        /// <inheritdoc />
        public JfCreatedItem? CreateChildFolder(Guid parentFolderId, string folderPath)
        {
            if (_libraryManager.GetItemById(parentFolderId) is not Folder parent || parent is ICollectionFolder or AggregateFolder or UserRootFolder) return null;
            var native = Native(folderPath);
            // Only a folder directly inside the parent, never the parent itself or anything deeper.
            if (string.IsNullOrEmpty(parent.Path) || !BridgePaths.SamePath(BridgePaths.Parent(BridgePaths.Norm(folderPath)) ?? string.Empty, parent.Path)) return null;
            if (_libraryManager.FindByPath(native, true) is { } existing) return new JfCreatedItem(existing.Id, KindOf(existing), false);
            if (!Directory.Exists(native)) return null;
            var directoryService = new DirectoryService(_fileSystem);
            var info = _fileSystem.GetDirectoryInfo(native);
            // Jellyfin's own resolution of that one folder, as its scan of the parent would do it for this entry (ignore
            // rules, the library's content type and options, the parent as context).
            var resolved = _libraryManager.ResolvePaths(new[] { info }, directoryService, parent, _libraryManager.GetLibraryOptions(parent), _libraryManager.GetContentType(parent))
                .FirstOrDefault(i => !string.IsNullOrEmpty(i.Path) && BridgePaths.SamePath(i.Path, native));
            if (resolved == null) return null;
            // Its id is Jellyfin's own for that path and type: a monitor or scan that added it meanwhile added the same item.
            if (_libraryManager.GetItemById(resolved.Id) is { } raced) return new JfCreatedItem(raced.Id, KindOf(raced), false);
            parent.AddChild(resolved);
            return new JfCreatedItem(resolved.Id, KindOf(resolved), true);
        }

        /// <inheritdoc />
        public int RemoveMissingTwins(string filePath)
        {
            if (_libraryManager.FindByPath(Native(filePath), false) is not Episode { IsMissingEpisode: false } episode || episode.Series is not { } series) return 0;
            if (episode.ParentIndexNumber is null || episode.IndexNumber is null) return -1;
            var twins = series.GetRecursiveChildren(i => IsMissingTwin(episode, series.Id, i)).ToList();
            foreach (var twin in twins) _libraryManager.DeleteItem(twin, new DeleteOptions { DeleteFileLocation = false }, false);
            return twins.Count;
        }

        /// <summary>
        /// Jellyfin's own rule for a missing episode a file now fills (its series refresh,
        /// <c>SeriesMetadataService.RemoveObsoleteEpisodes</c>): a virtual or missing episode of the same season whose
        /// number the file's episode contains (<see cref="Episode.ContainsEpisodeNumber"/>, so an S01E04-E05 file fills
        /// E04 and E05). Narrower than Jellyfin's on purpose: the same series item, numbered, and never an item with a
        /// path (an episode with a file is never removed). <paramref name="seriesId"/> is the file's series item (its
        /// own folder's: with automatic series grouping another folder of the series is another series item, whose
        /// missing episodes stay).
        /// </summary>
        internal static bool IsMissingTwin(Episode file, Guid seriesId, BaseItem candidate)
            => candidate is Episode e
                && e.Id != file.Id
                && string.IsNullOrEmpty(e.Path)
                && (e.IsVirtualItem || e.IsMissingEpisode)
                && !string.IsNullOrEmpty(file.Path)
                && !seriesId.Equals(Guid.Empty)
                && (file.SeriesId.Equals(Guid.Empty) || file.SeriesId.Equals(seriesId))
                && e.SeriesId.Equals(seriesId)
                && e.ParentIndexNumber is int season && season == file.ParentIndexNumber
                && e.IndexNumber is int number && file.ContainsEpisodeNumber(number);
    }
}
