using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

/// <summary>
/// An in-memory Jellyfin library for the Jellyfin bridge: libraries with their folders, items by
/// path (folders and files), files Jellyfin's process can see, provider ids, and a record of every
/// refresh, library scan and monitor report. A refresh can "find" files (adds their items).
/// </summary>
internal sealed class FakeLibraryAccess : IJellyfinLibraryAccess
{
    public List<JfLibraryRoot> Libs { get; } = new();
    public Dictionary<string, JfPathItem> Items { get; } = new(StringComparer.Ordinal);
    public HashSet<string> Files { get; } = new(StringComparer.Ordinal);
    public HashSet<string> Folders { get; } = new(StringComparer.Ordinal);
    public HashSet<string> MovieIds { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> SeriesIds { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> PathsByProvider { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<(Guid Folder, List<string> Paths)> Refreshes { get; } = new();
    public List<string> Scans { get; } = new();
    public List<string> Reported { get; } = new();
    public bool ScanRunning { get; set; }
    /// <summary>When true, a refresh adds an item for every refreshed path that is a known file.</summary>
    public bool RefreshFinds { get; set; } = true;
    public Func<Guid, Task>? DuringRefresh { get; set; }

    public JfLibraryRoot AddLibrary(string name, string type, params string[] locations)
    {
        var lib = new JfLibraryRoot { Id = Guid.NewGuid().ToString("N"), Name = name, CollectionType = type, Locations = locations };
        Libs.Add(lib);
        foreach (var l in locations)
        {
            Items[l] = new JfPathItem { Id = Guid.NewGuid(), Kind = "folder", IsFolder = true };
            Folders.Add(l);
        }
        return lib;
    }

    public JfPathItem AddFolder(string path, string kind)
    {
        var item = new JfPathItem { Id = Guid.NewGuid(), Kind = kind, IsFolder = true };
        Items[path] = item;
        Folders.Add(path);
        return item;
    }

    public void AddFile(string path, bool indexed, string kind = "episode")
    {
        Files.Add(path);
        if (indexed) Items[path] = new JfPathItem { Id = Guid.NewGuid(), Kind = kind };
    }

    public IReadOnlyList<JfLibraryRoot> Libraries() => Libs;

    public JfPathItem? FindByPath(string path)
    {
        lock (Items) return Items.TryGetValue(path, out var i) ? i : null;
    }

    public bool FileExists(string path) => Files.Contains(path);

    public bool DirectoryExists(string path) => Folders.Contains(path) || Files.Any(f => f.StartsWith(path.TrimEnd('/') + "/", StringComparison.Ordinal));

    public IReadOnlyList<string> Entries(string folder)
        => Files.Concat(Folders).Where(p => BridgePaths.Parent(p) == BridgePaths.Norm(folder)).Distinct().ToList();

    public string? ItemPathByProvider(bool movie, string provider, string id)
        => PathsByProvider.TryGetValue((movie ? "movie:" : "tv:") + provider + ":" + id, out var p) ? p : null;

    public (IReadOnlySet<string> Movies, IReadOnlySet<string> Series) ProviderIndex() => (MovieIds, SeriesIds);

    public bool LibraryScanRunning => ScanRunning;

    /// <summary>
    /// Like Jellyfin's non-recursive <c>ValidateChildren</c>: only the refreshed folder's direct
    /// children among the refresh paths get items; a new folder is added without looking inside it
    /// (a new season folder stays empty until it is refreshed itself). In a movie library's own
    /// folder a new movie folder becomes the movie (its video file's item), as Jellyfin resolves it.
    /// </summary>
    public async Task RefreshFolderAsync(Guid folderId, IReadOnlyList<string> refreshPaths, CancellationToken cancellationToken)
    {
        lock (Refreshes) Refreshes.Add((folderId, refreshPaths.ToList()));
        if (DuringRefresh != null) await DuringRefresh(folderId);
        if (!RefreshFinds) return;
        lock (Items)
        {
            var folder = Items.FirstOrDefault(kv => kv.Value.Id == folderId).Key;
            if (folder == null) return;
            var movieRoot = Libs.Any(l => l.CollectionType == "movies" && l.Locations.Contains(folder));
            foreach (var p in refreshPaths)
            {
                if (BridgePaths.Parent(p) != folder) continue;
                if (Files.Contains(p)) Items[p] = new JfPathItem { Id = Guid.NewGuid(), Kind = movieRoot ? "movie" : "episode" };
                else if (movieRoot)
                {
                    foreach (var video in Files.Where(f => BridgePaths.Parent(f) == p)) Items.TryAdd(video, new JfPathItem { Id = Guid.NewGuid(), Kind = "movie" });
                }
                else Items.TryAdd(p, new JfPathItem { Id = Guid.NewGuid(), Kind = Items[folder].Kind == "series" ? "season" : "folder", IsFolder = true });
            }
        }
    }

    /// <summary>Turns a library's real-time monitoring on or off.</summary>
    public void SetRealtime(string name, bool on)
    {
        var i = Libs.FindIndex(l => l.Name == name);
        var l = Libs[i];
        Libs[i] = new JfLibraryRoot { Id = l.Id, Name = l.Name, CollectionType = l.CollectionType, Locations = l.Locations, RealtimeMonitor = on };
    }

    public bool QueueLibraryScan(string libraryId)
    {
        Scans.Add(libraryId);
        return Libs.Any(l => l.Id == libraryId);
    }

    public List<Guid> ItemRefreshes { get; } = new();

    public bool QueueItemRefresh(Guid itemId)
    {
        lock (ItemRefreshes) ItemRefreshes.Add(itemId);
        return true;
    }

    public void ReportChanged(string path)
    {
        lock (Reported) Reported.Add(path);
    }
}
