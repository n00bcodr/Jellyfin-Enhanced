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

        /// <summary>Queues Jellyfin's own scan of one library (as its "Scan library" button does). False when the library is unknown.</summary>
        bool QueueLibraryScan(string libraryId);

        /// <summary>Queues a full metadata refresh of one item and its children (a new series). False when it isn't a folder.</summary>
        bool QueueItemRefresh(Guid itemId);

        /// <summary>
        /// Tells Jellyfin's library monitor a path changed (its own debounced refresh, as real-time
        /// monitoring does). Jellyfin acts on it whatever the library's monitoring setting, by
        /// validating the nearest item it has recursively: only for libraries with real-time monitoring on.
        /// </summary>
        void ReportChanged(string path);

        /// <summary>
        /// Removes the missing (virtual) episodes Jellyfin still lists for the slot an episode file now fills
        /// (same series, season and episode number), as Jellyfin's own series refresh does; no file is
        /// touched. Returns how many it removed: 0 when the path isn't an episode with a file, -1 while
        /// Jellyfin hasn't numbered that episode yet (its metadata does, a moment after it is added).
        /// </summary>
        int RemoveMissingTwins(string filePath);
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
                Kind = item switch
                {
                    Movie => "movie",
                    Episode => "episode",
                    Series => "series",
                    Season => "season",
                    Folder => "folder",
                    _ => "other",
                },
            };
        }

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
        public bool QueueLibraryScan(string libraryId)
        {
            if (!Guid.TryParse(libraryId, out var id) || _libraryManager.GetItemById(id) is not Folder) return false;
            _providerManager.QueueRefresh(
                id,
                new MetadataRefreshOptions(new DirectoryService(_fileSystem))
                {
                    MetadataRefreshMode = MetadataRefreshMode.Default,
                    ImageRefreshMode = MetadataRefreshMode.Default,
                },
                RefreshPriority.High);
            return true;
        }

        /// <inheritdoc />
        public bool QueueItemRefresh(Guid itemId)
        {
            if (_libraryManager.GetItemById(itemId) is not Folder) return false;
            _providerManager.QueueRefresh(
                itemId,
                new MetadataRefreshOptions(new DirectoryService(_fileSystem))
                {
                    MetadataRefreshMode = MetadataRefreshMode.FullRefresh,
                    ImageRefreshMode = MetadataRefreshMode.Default,
                },
                RefreshPriority.High);
            return true;
        }

        /// <inheritdoc />
        public void ReportChanged(string path) => _libraryMonitor.ReportFileSystemChanged(Native(path));

        /// <inheritdoc />
        public int RemoveMissingTwins(string filePath)
        {
            if (_libraryManager.FindByPath(Native(filePath), false) is not Episode { IsMissingEpisode: false } episode || episode.Series is not { } series) return 0;
            if (episode.ParentIndexNumber is not int season || episode.IndexNumber is not int number) return -1;
            var twins = series.GetRecursiveChildren(i => i is Episode e && e.IsMissingEpisode && e.ParentIndexNumber == season && e.IndexNumber == number).ToList();
            foreach (var twin in twins) _libraryManager.DeleteItem(twin, new DeleteOptions { DeleteFileLocation = false }, false);
            return twins.Count;
        }
    }
}
