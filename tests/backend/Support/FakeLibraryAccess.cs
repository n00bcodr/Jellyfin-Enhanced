using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

/// <summary>
/// An in-memory Jellyfin library for the Jellyfin bridge: libraries with their folders, items by
/// path (folders and files), files Jellyfin's process can see (with their size and last write), provider
/// ids, each item's metadata (title, overview, artwork, media info, numbers, refresh stamp), and a record
/// of every refresh, hydration, created folder and monitor report. Discovery and metadata are separate,
/// as in Jellyfin: a refresh "finds" files (adds their items) and gives each new item the metadata
/// <see cref="NewItemMeta"/> says (complete by default; a skeleton to model a first read that found
/// nothing); a hydration then fills it (<see cref="HydrationWorks"/>), as Jellyfin's full refresh does.
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
    public List<string> Reported { get; } = new();
    public bool ScanRunning { get; set; }
    /// <summary>When true, a refresh adds an item for every refreshed path that is a known file.</summary>
    public bool RefreshFinds { get; set; } = true;
    public Func<Guid, Task>? DuringRefresh { get; set; }

    /// <summary>Each item's metadata, by item id.</summary>
    public Dictionary<Guid, Meta> Metas { get; } = new();

    /// <summary>
    /// The metadata a new item gets when a refresh (or a series' hydration) adds it: complete by default. Set it to
    /// <see cref="Skeleton"/> to model a first read that found nothing (the raw folder name, no overview, no art).
    /// </summary>
    public Func<string, string, Meta> NewItemMeta { get; set; } = Complete;

    /// <summary>A hydration fills the item's metadata (and stamps it) when true; when false it ends with a failure (no stamp, nothing filled).</summary>
    public bool HydrationWorks { get; set; } = true;

    /// <summary>What a working hydration leaves out (a provider without a backdrop or an episode still).</summary>
    public HashSet<string> ProviderLacks { get; } = new(StringComparer.Ordinal);

    /// <summary>Every hydration asked for, in order.</summary>
    public List<(Guid Item, HydrationScope Scope)> Hydrations { get; } = new();

    /// <summary>Every folder created on its own (parent folder item, folder path).</summary>
    public List<(Guid Parent, string Path)> Created { get; } = new();

    /// <summary>A file's size and last write per path, when set; a known file is (1, a fixed time) otherwise.</summary>
    public Dictionary<string, Queue<(long, DateTime)>> StampSequence { get; } = new(StringComparer.Ordinal);

    /// <summary>How often each file's stamp was read.</summary>
    public Dictionary<string, int> StampReads { get; } = new(StringComparer.Ordinal);

    /// <summary>Runs as a folder is about to be created (tests: Jellyfin's monitor adding it first).</summary>
    public Action<string>? BeforeCreate { get; set; }

    /// <summary>Runs right before a hydration takes effect (tests interleave there).</summary>
    public Action<Guid, HydrationScope>? DuringHydration { get; set; }

    /// <summary>One item's metadata as Jellyfin keeps it.</summary>
    public sealed class Meta
    {
        public string? Name { get; set; }
        public bool Overview { get; set; }
        public bool Primary { get; set; }
        public bool Backdrop { get; set; }
        public bool Probed { get; set; }
        public bool ProviderIds { get; set; }
        public int? Season { get; set; }
        public int? Episode { get; set; }
        public Guid SeriesId { get; set; }
        public Guid SeasonId { get; set; }
        public DateTime? LastRefreshed { get; set; }
        public bool Locked { get; set; }
    }

    private static string Base(string path)
    {
        var p = BridgePaths.Norm(path);
        return p[(p.LastIndexOf('/') + 1)..];
    }

    private static string Stem(string path) => Path.GetFileNameWithoutExtension(Base(path));

    /// <summary>Metadata a refresh read in full: the providers' title, overview, artwork, media info, a stamp.</summary>
    public static Meta Complete(string path, string kind) => new()
    {
        Name = "Canonical " + Stem(path), Overview = true, Primary = true, Backdrop = true, Probed = kind is "movie" or "episode", ProviderIds = true,
        LastRefreshed = DateTime.UtcNow,
    };

    /// <summary>
    /// A first read that found nothing (Jellyfin 12.2 MovieResolver: the folder's name as it is; the provider id parsed from
    /// it), with the media probe done and a refresh stamp (a no-match still stamps).
    /// </summary>
    public static Meta Skeleton(string path, string kind) => new()
    {
        Name = kind == "movie" ? Base(BridgePaths.Parent(path) ?? path) : kind == "episode" ? Stem(path) : Base(path),
        Probed = kind is "movie" or "episode", ProviderIds = kind is "movie" or "series", LastRefreshed = DateTime.UtcNow,
    };

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
        Metas[item.Id] = Complete(path, kind);
        return item;
    }

    public void AddFile(string path, bool indexed, string kind = "episode")
    {
        Files.Add(path);
        if (indexed) Index(path, kind, Complete(path, kind));
    }

    /// <summary>Adds the item of a file with the given metadata (an episode is bound to its season and series folders).</summary>
    public JfPathItem Index(string path, string kind, Meta meta)
    {
        var item = new JfPathItem { Id = Guid.NewGuid(), Kind = kind };
        lock (Items)
        {
            Items[path] = item;
            if (kind == "episode") Bind(path, meta);
            Metas[item.Id] = meta;
        }
        return item;
    }

    // An episode's numbers and its season and series items, from its folders (under the lock).
    private void Bind(string path, Meta meta)
    {
        var season = BridgePaths.Parent(path);
        var series = season == null ? null : BridgePaths.Parent(season);
        if (season != null && Items.TryGetValue(season, out var s) && s.Kind == "season") meta.SeasonId = s.Id;
        if (series != null && Items.TryGetValue(series, out var t) && t.Kind == "series") meta.SeriesId = t.Id;
        var name = Stem(path);
        var e = name.LastIndexOf('E');
        meta.Season ??= 1;
        meta.Episode ??= e >= 0 && int.TryParse(new string(name[(e + 1)..].TakeWhile(char.IsDigit).ToArray()), out var n) ? n : 1;
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
    /// New items get <see cref="NewItemMeta"/>.
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
                if (Files.Contains(p)) Index(p, movieRoot ? "movie" : "episode", NewItemMeta(p, movieRoot ? "movie" : "episode"));
                else if (movieRoot)
                {
                    foreach (var video in Files.Where(f => BridgePaths.Parent(f) == p && !Items.ContainsKey(f)).ToList()) Index(video, "movie", NewItemMeta(video, "movie"));
                }
                else if (!Items.ContainsKey(p))
                {
                    var kind = Items[folder].Kind == "series" ? "season" : "folder";
                    var item = new JfPathItem { Id = Guid.NewGuid(), Kind = kind, IsFolder = true };
                    Items[p] = item;
                    Metas[item.Id] = Complete(p, kind);
                }
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

    /// <summary>Movie or episode items the bridge asked Jellyfin to read again (their file changed in place), in order.</summary>
    public List<Guid> FileRefreshes { get; } = new();

    public bool QueueFileRefresh(Guid itemId)
    {
        lock (FileRefreshes) FileRefreshes.Add(itemId);
        return true;
    }

    public void ReportChanged(string path)
    {
        lock (Reported) Reported.Add(path);
    }

    /// <summary>Files whose missing (virtual) twins the bridge asked to remove, in order.</summary>
    public List<string> TwinRemovals { get; } = new();

    /// <summary>How many missing twins each file has (a removal takes them away).</summary>
    public Dictionary<string, int> MissingTwins { get; } = new(StringComparer.Ordinal);

    /// <summary>Files whose episode Jellyfin hasn't numbered yet: the next removal answers -1 (and numbers it).</summary>
    public HashSet<string> NumberedLater { get; } = new(StringComparer.Ordinal);

    public int RemoveMissingTwins(string filePath)
    {
        lock (TwinRemovals)
        {
            TwinRemovals.Add(filePath);
            if (NumberedLater.Remove(filePath)) return -1;
            return MissingTwins.Remove(filePath, out var n) ? n : 0;
        }
    }

    public (long Size, DateTime ModifiedUtc)? FileStamp(string path)
    {
        lock (StampReads)
        {
            StampReads[path] = StampReads.GetValueOrDefault(path) + 1;
            if (StampSequence.TryGetValue(path, out var seq) && seq.Count > 0) return seq.Count > 1 ? seq.Dequeue() : seq.Peek();
        }
        return Files.Contains(path) ? (1, new DateTime(2026, 10, 24, 0, 0, 0, DateTimeKind.Utc)) : null;
    }

    public JfItemFacts? ReadFacts(Guid itemId)
    {
        lock (Items)
        {
            var path = Items.FirstOrDefault(kv => kv.Value.Id == itemId).Key;
            if (path == null || !Metas.TryGetValue(itemId, out var meta)) return null;
            var kind = Items[path].Kind;
            return Facts(itemId, kind, path, meta, kind == "episode" && Metas.TryGetValue(meta.SeriesId, out var s) ? Facts(meta.SeriesId, "series", Items.First(kv => kv.Value.Id == meta.SeriesId).Key, s, null) : null);
        }
    }

    private static JfItemFacts Facts(Guid id, string kind, string path, Meta m, JfItemFacts? series) => new()
    {
        Id = id, Kind = kind, Path = path, Name = m.Name, HasOverview = m.Overview, HasPrimary = m.Primary, HasBackdrop = m.Backdrop,
        HasProviderIds = m.ProviderIds, Probed = m.Probed, Season = m.Season, Episode = m.Episode, SeriesId = m.SeriesId, SeasonId = m.SeasonId,
        LastRefreshed = m.LastRefreshed, NameLocked = m.Locked, Series = series,
    };

    /// <summary>
    /// Like Jellyfin's full refresh of the item (FullRefresh metadata and images, title replaced): fills its metadata
    /// (what <see cref="ProviderLacks"/> names stays empty) and stamps it; a series tree also finds and hydrates everything
    /// inside the series folder (its season folders and episode files), never anything outside it.
    /// </summary>
    public bool QueueHydration(Guid itemId, HydrationScope scope)
    {
        string? path;
        string kind;
        lock (Items)
        {
            path = Items.FirstOrDefault(kv => kv.Value.Id == itemId).Key;
            if (path == null) return false;
            kind = Items[path].Kind;
            if (Libs.Any(l => l.Locations.Contains(path))) return false;
            var allowed = scope switch
            {
                HydrationScope.Item => kind is "movie" or "episode",
                HydrationScope.SeriesTree => kind == "series",
                _ => kind is "series" or "season",
            };
            if (!allowed) return false;
        }
        lock (Hydrations) Hydrations.Add((itemId, scope));
        DuringHydration?.Invoke(itemId, scope);
        if (!HydrationWorks) return true;
        if (HydrationDelay > TimeSpan.Zero)
        {
            // Like Jellyfin's refresh queue: accepted now, done a moment later.
            _ = Task.Run(async () =>
            {
                await Task.Delay(HydrationDelay);
                Apply(itemId, path, kind, scope);
            });
            return true;
        }
        Apply(itemId, path, kind, scope);
        return true;
    }

    /// <summary>How long a hydration takes after it was accepted (zero: at once, inside the call).</summary>
    public TimeSpan HydrationDelay { get; set; }

    private void Apply(Guid itemId, string path, string kind, HydrationScope scope)
    {
        lock (Items)
        {
            Fill(itemId, path, kind);
            if (scope == HydrationScope.SeriesTree)
            {
                var files = Files.Where(f => f.StartsWith(path + "/", StringComparison.Ordinal)).ToList();
                foreach (var season in Folders.Where(f => BridgePaths.Parent(f) == path).Concat(files.Select(f => BridgePaths.Parent(f)!).Where(f => f != path)).Distinct().ToList())
                {
                    if (!Items.ContainsKey(season))
                    {
                        var s = new JfPathItem { Id = Guid.NewGuid(), Kind = "season", IsFolder = true };
                        Items[season] = s;
                        Metas[s.Id] = new Meta();
                    }
                    Fill(Items[season].Id, season, "season");
                }
                foreach (var file in files)
                {
                    if (!Items.ContainsKey(file)) Index(file, "episode", new Meta());
                    Fill(Items[file].Id, file, "episode");
                }
            }
        }
    }

    // Under the lock.
    private void Fill(Guid id, string path, string kind)
    {
        if (!Metas.TryGetValue(id, out var m)) Metas[id] = m = new Meta();
        if (!m.Locked) m.Name = "Canonical " + Stem(path);
        m.Overview = !ProviderLacks.Contains("overview");
        m.Primary = !ProviderLacks.Contains(kind == "episode" ? "episode image" : "poster");
        m.Backdrop = !ProviderLacks.Contains("backdrop");
        m.Probed = kind is "movie" or "episode";
        m.ProviderIds = true;
        if (kind == "episode") Bind(path, m);
        m.LastRefreshed = DateTime.UtcNow;
    }

    /// <summary>Creates the item of one new folder directly inside a library's folder (a series in a TV library), like Jellyfin's resolver for that one folder.</summary>
    public JfCreatedItem? CreateChildFolder(Guid parentFolderId, string folderPath)
    {
        BeforeCreate?.Invoke(folderPath);
        lock (Items)
        {
            var parent = Items.FirstOrDefault(kv => kv.Value.Id == parentFolderId).Key;
            if (parent == null || BridgePaths.Parent(folderPath) != parent) return null;
            lock (Created) Created.Add((parentFolderId, folderPath));
            if (Items.TryGetValue(folderPath, out var existing)) return new JfCreatedItem(existing.Id, existing.Kind, false);
            if (!DirectoryExists(folderPath)) return null;
            var type = Libs.FirstOrDefault(l => l.Locations.Contains(parent))?.CollectionType;
            var kind = type == "tvshows" ? "series" : type == "movies" ? "movie" : "folder";
            var item = new JfPathItem { Id = Guid.NewGuid(), Kind = kind, IsFolder = true };
            Items[folderPath] = item;
            Folders.Add(folderPath);
            // As Jellyfin's resolver leaves a new series: its folder's name, no metadata, never refreshed.
            Metas[item.Id] = kind == "series" ? new Meta { Name = Base(folderPath), ProviderIds = true } : Complete(folderPath, kind);
            return new JfCreatedItem(item.Id, kind, true);
        }
    }
}
