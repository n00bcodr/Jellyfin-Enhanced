using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

/// <summary>
/// In-memory Jellyfin for the list services. Playlist add/move reproduce the decompiled 12.2 / 10.11
/// PlaylistManager algorithms (raw-position insert, 10.11 de-duplicating append, visible-row move that inserts by the
/// manageable-list index into the raw array), so coordinate bugs show up here exactly as on a server.
/// </summary>
internal sealed class FakeListHost : IListHost
{
    public sealed class FakeList
    {
        public required ListInfo Info { get; set; }
        public List<RawEntry> Raw { get; } = new();
        /// <summary>Where Jellyfin keeps the list (its item id is derived from it).</summary>
        public string Path { get; set; } = string.Empty;

        /// <summary>
        /// The name Jellyfin has saved (database and metadata), as opposed to its cached item's <see cref="Info"/> name;
        /// null for a list the test made directly.
        /// </summary>
        public string? SavedName { get; set; }
        public DateTime? StoredSaveStamp { get; set; } = DateTime.UtcNow;
        public ListInfo? SavedInfo { get; private set; }
        public IReadOnlyList<RawEntry> SavedRaw { get; private set; } = Array.Empty<RawEntry>();

        // Native managers save the entire item, including its cached name, on entry writes.
        public void Persist()
        {
            StoredSaveStamp = StoredSaveStamp?.AddTicks(1);
            SavedInfo = Info;
            SavedName = Info.Name;
            SavedRaw = Raw.ToArray();
        }
    }

    /// <summary>Jellyfin's managed collections folder (CollectionManager.GetCollectionsFolderPath).</summary>
    public const string CollectionsRoot = "/config/data/collections";

    /// <summary>Jellyfin's playlists folder.</summary>
    public const string PlaylistsRoot = "/config/data/playlists";

    public sealed record FakeSeries(Guid Id, int? Tmdb, int? Tvdb, string? Imdb);

    public sealed record FakeEpisode(Guid Id, Guid SeriesId, int Season, int Episode, int? EpisodeEnd, bool Virtual, int? OwnTmdb);

    public bool SupportsPositionalInsert { get; set; } = true;
    public DateTime? GetStoredSaveStamp(Guid listId) => Lists.TryGetValue(listId, out var list) ? list.StoredSaveStamp : null;

    public ListPlaylistSave? GetStoredPlaylistSave(Guid listId) => Lists.TryGetValue(listId, out var list) && list.StoredSaveStamp.HasValue
        ? new ListPlaylistSave(list.StoredSaveStamp.Value, ListOrder.BuildRealTokens(list.SavedRaw)) : null;

    public Task NativeMoveAsync(Guid listId, Guid itemId, int index, Guid userId) => MoveCore(listId, itemId, index, userId);
    /// <summary>Items that are 4K copies (<see cref="IsFourK"/>); everything else is a standard copy.</summary>
    public HashSet<Guid> FourK { get; } = new();
    public Dictionary<string, Guid> MoviesByImdb { get; } = new();
    public Dictionary<Guid, FakeSeries> Series { get; } = new();
    public List<FakeEpisode> Episodes { get; } = new();
    public HashSet<Guid> EpisodeCoordinatesMissing { get; } = new();
    /// <summary>Season items: (series, season) → (id, virtual).</summary>
    public Dictionary<(Guid Series, int Season), (Guid Id, bool Virtual)> Seasons { get; } = new();
    /// <summary>Throws from AddToPlaylistAsync / AddToCollectionAsync when set (after optionally mutating).</summary>
    public Exception? FailAdds { get; set; }
    /// <summary>With <see cref="FailAdds"/>: still mutate the list before throwing (crash after Jellyfin's write).</summary>
    public bool FailAfterMutating { get; set; }
    public Dictionary<Guid, FakeList> Lists { get; } = new();
    public Dictionary<Guid, BaseItemKind> Items { get; } = new();
    public Dictionary<int, Guid> MoviesByTmdb { get; } = new();
    /// <summary>Further copies of a movie by TMDB id (another library or edition), found after the <see cref="MoviesByTmdb"/> one.</summary>
    public Dictionary<int, List<Guid>> MoreMovieCopies { get; } = new();
    /// <summary>Items each user can't see (row visibility and access).</summary>
    public Dictionary<Guid, HashSet<Guid>> HiddenFrom { get; } = new();
    /// <summary>Lists each user can't see (entity visibility).</summary>
    public Dictionary<Guid, HashSet<Guid>> ListHiddenFrom { get; } = new();
    public List<string> Calls { get; } = new();
    // Items AddToCollectionAsync silently doesn't add (Jellyfin skips ids it can't resolve).
    public HashSet<Guid> CollectionDrops { get; } = new();
    public Func<Guid, IReadOnlyList<Guid>, int?, Task>? BeforeAdd { get; set; }
    // Runs right after a playlist add changed the entries (e.g. a native edit landing before JE re-reads them).
    public Action<Guid>? AfterAdd { get; set; }
    public Action<Guid>? AfterCreate { get; set; }
    // Runs right after a collection add changed the members (e.g. to capture the state a crash would leave).
    public Action<Guid>? AfterCollectionAdd { get; set; }
    /// <summary>Throws from the next N MoveInPlaylistAsync calls (before moving).</summary>
    public int FailMoves { get; set; }
    /// <summary>Throws from CreatePlaylistAsync / CreateCollectionAsync before anything is made (the attempt died first).</summary>
    public Exception? FailCreates { get; set; }
    /// <summary>
    /// Runs at the start of every Jellyfin write (op, list, the user it runs as, items) before it changes anything: the
    /// table tests check each write against the state at that moment.
    /// </summary>
    public Action<string, Guid, Guid, IReadOnlyList<Guid>>? OnWrite { get; set; }
    /// <summary>Runs inside every Jellyfin write, before ("op:before") and after ("op:after") it changes the list.</summary>
    public Action<string>? OnAwait { get; set; }

    public static User MakeUser(string name, bool admin = false, bool collections = false)
    {
        var user = new User(name, "default", "default") { Id = Guid.NewGuid() };
        user.SetPermission(PermissionKind.IsAdministrator, admin);
        user.SetPermission(PermissionKind.EnableCollectionManagement, collections);
        return user;
    }

    public Guid AddItem(BaseItemKind kind = BaseItemKind.Movie, int? tmdb = null)
    {
        var id = Guid.NewGuid();
        Items[id] = kind;
        if (tmdb.HasValue)
        {
            MoviesByTmdb[tmdb.Value] = id;
        }

        return id;
    }

    public FakeList AddPlaylist(User owner, bool openAccess = false, params ListShare[] shares)
    {
        var list = new FakeList { Info = new ListInfo(Guid.NewGuid(), ListKinds.Playlist, "Playlist", owner.Id, openAccess, shares), Path = PlaylistPath("Playlist") };
        Lists[list.Info.Id] = list;
        return list;
    }

    public FakeList AddCollection(string name = "Collection")
    {
        var list = new FakeList { Info = new ListInfo(Guid.NewGuid(), ListKinds.Collection, name, Guid.Empty, false, Array.Empty<ListShare>()), Path = CollectionsRoot + "/" + ValidFilename(name) + " [boxset]" };
        Lists[list.Info.Id] = list;
        return list;
    }

    public void Hide(Guid itemId, User from)
    {
        if (!HiddenFrom.TryGetValue(from.Id, out var set))
        {
            HiddenFrom[from.Id] = set = new HashSet<Guid>();
        }

        set.Add(itemId);
    }

    public Guid AddSeries(int? tmdb = null, int? tvdb = null, string? imdb = null)
    {
        var id = Guid.NewGuid();
        Items[id] = BaseItemKind.Series;
        Series[id] = new FakeSeries(id, tmdb, tvdb, imdb);
        return id;
    }

    public Guid AddEpisode(Guid seriesId, int season, int episode, int? episodeEnd = null, bool isVirtual = false, int? ownTmdb = null)
    {
        var id = Guid.NewGuid();
        Items[id] = BaseItemKind.Episode;
        Episodes.Add(new FakeEpisode(id, seriesId, season, episode, episodeEnd, isVirtual, ownTmdb));
        if (!Seasons.ContainsKey((seriesId, season)))
        {
            var seasonId = Guid.NewGuid();
            Items[seasonId] = BaseItemKind.Season;
            Seasons[(seriesId, season)] = (seasonId, isVirtual);
        }
        else if (!isVirtual && Seasons[(seriesId, season)].Virtual)
        {
            Seasons[(seriesId, season)] = (Seasons[(seriesId, season)].Id, false);
        }

        return id;
    }

    /// <summary>Adds a copy of a movie (the first copy of a TMDB id is its <see cref="MoviesByTmdb"/> entry).</summary>
    public Guid AddMovieCopy(int tmdb, bool fourK = false)
    {
        var id = Guid.NewGuid();
        Items[id] = BaseItemKind.Movie;
        if (!MoviesByTmdb.ContainsKey(tmdb))
        {
            MoviesByTmdb[tmdb] = id;
        }
        else
        {
            if (!MoreMovieCopies.TryGetValue(tmdb, out var copies))
            {
                MoreMovieCopies[tmdb] = copies = new List<Guid>();
            }

            copies.Add(id);
        }

        if (fourK)
        {
            FourK.Add(id);
        }

        return id;
    }

    public Guid AddMovie(int? tmdb = null, string? imdb = null)
    {
        var id = AddItem(BaseItemKind.Movie, tmdb);
        if (imdb != null)
        {
            MoviesByImdb[imdb] = id;
        }

        return id;
    }

    public IReadOnlyList<Guid> Resolved(Guid listId) =>
        Lists[listId].Raw.Where(r => r.Resolved).Select(r => r.ItemId!.Value).ToList();

    public ListInfo? GetList(Guid listId) => Lists.TryGetValue(listId, out var list) ? list.Info : null;

    public Action<Guid>? OnStoredNameRead { get; set; }

    public string? GetStoredName(Guid listId)
    {
        OnStoredNameRead?.Invoke(listId);
        return Lists.TryGetValue(listId, out var list) ? list.SavedName ?? list.Info.Name : null;
    }

    /// <summary>Runs at the start of every <see cref="GetRawEntries"/> call (to change a list between two reads).</summary>
    public Action<Guid>? OnRawRead { get; set; }

    public IReadOnlyList<RawEntry> GetRawEntries(Guid listId)
    {
        OnRawRead?.Invoke(listId);
        return Lists.TryGetValue(listId, out var list) ? list.Raw.ToList() : Array.Empty<RawEntry>();
    }

    public bool IsListVisible(Guid listId, User user) =>
        Lists.ContainsKey(listId) && !(ListHiddenFrom.TryGetValue(user.Id, out var set) && set.Contains(listId));

    public bool IsEntryVisible(Guid itemId, User user) => !(HiddenFrom.TryGetValue(user.Id, out var set) && set.Contains(itemId));

    public bool CanAccessItem(Guid itemId, User user) => Items.ContainsKey(itemId) && IsEntryVisible(itemId, user);

    public bool IsFourK(Guid itemId) => FourK.Contains(itemId);

    public Dictionary<Guid, IReadOnlyList<ListMediaSource>> MediaSources { get; } = new();

    public IReadOnlyList<ListMediaSource> GetMediaSources(Guid itemId) => MediaSources.TryGetValue(itemId, out var sources) ? sources : Items.ContainsKey(itemId)
        ? new[] { new ListMediaSource(itemId, itemId.ToString("N"), FourK.Contains(itemId) ? 3840 : 1920, FourK.Contains(itemId) ? 2160 : 1080, !Episodes.Any(e => e.Id == itemId && e.Virtual)) }
        : Array.Empty<ListMediaSource>();

    public LibraryItemInfo? GetItem(Guid itemId) => Items.TryGetValue(itemId, out var kind) ? new LibraryItemInfo(itemId, kind) : null;

    public Guid? FindMovieByTmdb(int tmdbId, IReadOnlyList<User> users) =>
        MoviesByTmdb.TryGetValue(tmdbId, out var id) && users.All(u => CanAccessItem(id, u)) ? id : null;

    private void HealName(Guid id)
    {
        if (Lists.TryGetValue(id, out var list)) list.Info = list.Info with { Name = GetStoredName(id)! };
    }

    public async Task AddToPlaylistAsync(ListWrite write, IReadOnlyList<Guid> itemIds, int? rawPosition)
    {
        write.Spend(write.ListId, ListWriteKind.Insert);
        HealName(write.ListId);
        var playlistId = write.ListId;
        var userId = write.ActAs;
        Calls.Add($"add:{string.Join(',', itemIds.Select(Short))}@{rawPosition?.ToString() ?? "end"}");
        OnWrite?.Invoke("add", playlistId, userId, itemIds);
        OnAwait?.Invoke("add:before");
        try
        {
            await AddCoreAsync(playlistId, itemIds, rawPosition, userId).ConfigureAwait(false);
        }
        finally
        {
            OnAwait?.Invoke("add:after");
        }
    }

    private async Task AddCoreAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, int? rawPosition, Guid userId)
    {
        if (BeforeAdd != null)
        {
            await BeforeAdd(playlistId, itemIds, rawPosition).ConfigureAwait(false);
        }

        if (FailAdds != null && !FailAfterMutating)
        {
            throw FailAdds;
        }

        var raw = Lists[playlistId].Raw;
        var add = itemIds.Where(id => IsEntryVisible(id, new User("x", "d", "d") { Id = userId })).ToList();
        if (!SupportsPositionalInsert)
        {
            // 10.11: drops items already in the playlist and repeats within the batch, then appends.
            var existing = raw.Where(r => r.ItemId.HasValue).Select(r => r.ItemId!.Value).ToHashSet();
            raw.AddRange(add.Where(id => !existing.Contains(id)).Distinct().Select(id => new RawEntry(id, true)));
            Lists[playlistId].Persist();
            AfterAdd?.Invoke(playlistId);
            return;
        }

        var entries = add.Select(id => new RawEntry(id, true)).ToList();
        if (rawPosition == null || rawPosition.Value >= raw.Count)
        {
            raw.AddRange(entries);
        }
        else
        {
            raw.InsertRange(Math.Max(rawPosition.Value, 0), entries);
        }

        Lists[playlistId].Persist();
        AfterAdd?.Invoke(playlistId);
        if (FailAdds != null)
        {
            throw FailAdds;
        }
    }

    public Task MoveInPlaylistAsync(ListWrite write, Guid itemId, int newIndex)
    {
        write.Spend(write.ListId, ListWriteKind.Move);
        HealName(write.ListId);
        var playlistId = write.ListId;
        var userId = write.ActAs;
        Calls.Add($"move:{Short(itemId)}->{newIndex}");
        OnWrite?.Invoke("move", playlistId, userId, new[] { itemId });
        OnAwait?.Invoke("move:before");
        try
        {
            return MoveCore(playlistId, itemId, newIndex, userId);
        }
        finally
        {
            OnAwait?.Invoke("move:after");
        }
    }

    private Task MoveCore(Guid playlistId, Guid itemId, int newIndex, Guid userId)
    {
        if (FailMoves > 0)
        {
            FailMoves--;
            throw new InvalidOperationException("move failed");
        }

        var raw = Lists[playlistId].Raw;
        var user = new User("x", "d", "d") { Id = userId };
        // PlaylistManager.MoveItemAsync (12.2 / 10.11.11), line for line.
        var manageable = raw.Where(r => r.Resolved).ToList();
        var visible = manageable.Where(r => IsEntryVisible(r.ItemId!.Value, user)).ToArray();
        if (Array.FindIndex(visible, r => r.ItemId == itemId) == newIndex)
        {
            return Task.CompletedTask;
        }

        var prior = visible[Math.Max(newIndex - 1, 0)].ItemId;
        var priorIndex = manageable.FindIndex(r => r.ItemId == prior);
        var index = newIndex == 0 ? (priorIndex <= 0 ? 0 : priorIndex - 1) : priorIndex + 1;
        var first = raw.FindIndex(r => r.ItemId == itemId);
        if (first < 0)
        {
            return Task.CompletedTask;
        }

        var moved = raw[first];
        raw.RemoveAt(first);
        if (newIndex >= raw.Count)
        {
            raw.Add(moved);
        }
        else
        {
            raw.Insert(index, moved);
        }

        Lists[playlistId].Persist();
        return Task.CompletedTask;
    }

    public Task AddToCollectionAsync(ListWrite write, IReadOnlyList<Guid> itemIds)
    {
        write.Spend(write.ListId, ListWriteKind.CollectionAdd);
        HealName(write.ListId);
        var collectionId = write.ListId;
        Calls.Add($"collection:{string.Join(',', itemIds.Select(Short))}");
        OnWrite?.Invoke("collection", collectionId, Guid.Empty, itemIds);
        OnAwait?.Invoke("collection:before");
        try
        {
            return CollectionCore(collectionId, itemIds);
        }
        finally
        {
            OnAwait?.Invoke("collection:after");
        }
    }

    private Task CollectionCore(Guid collectionId, IReadOnlyList<Guid> itemIds)
    {
        if (FailAdds != null && !FailAfterMutating)
        {
            throw FailAdds;
        }

        Lists[collectionId].Raw.AddRange(itemIds.Where(id => !CollectionDrops.Contains(id)).Select(id => new RawEntry(id, true)));
        Lists[collectionId].Persist();
        AfterCollectionAdd?.Invoke(collectionId);
        return FailAdds != null ? Task.FromException(FailAdds) : Task.CompletedTask;
    }

    public Task<Guid> CreatePlaylistAsync(ListWrite write, string name, bool isPublic)
    {
        write.Spend(Guid.Empty, ListWriteKind.Create);
        var ownerId = write.ActAs;
        Calls.Add($"create-playlist:{name}");
        OnWrite?.Invoke("create-playlist", Guid.Empty, ownerId, Array.Empty<Guid>());
        OnAwait?.Invoke("create:before");
        if (FailCreates != null)
        {
            throw FailCreates;
        }

        var id = MakePlaylist(name, ownerId, isPublic, Array.Empty<ListShare>());
        OnAwait?.Invoke("create:after");
        AfterCreate?.Invoke(id);
        return Task.FromResult(id);
    }

    public Task<Guid> CreateCollectionAsync(ListWrite write, string name, Guid marker)
    {
        write.Spend(Guid.Empty, ListWriteKind.Create);
        Calls.Add($"create-collection:{name}");
        OnWrite?.Invoke("create-collection", Guid.Empty, write.ActAs, Array.Empty<Guid>());
        OnAwait?.Invoke("create:before");
        if (FailCreates != null)
        {
            throw FailCreates;
        }

        var id = MakeCollection(name, new Dictionary<string, string> { [JellyfinListHost.CreateMarkerKey] = marker.ToString("N") });
        OnAwait?.Invoke("create:after");
        AfterCreate?.Invoke(id);
        return Task.FromResult(id);
    }

    /// <summary>Throws from the next N FinishCreateAsync calls (before renaming).</summary>
    public int FailFinishes { get; set; }

    /// <summary>
    /// Throws from the next N FinishCreateAsync calls AFTER the cached item got the new name but before it was saved, as
    /// Jellyfin's own rename does (it changes the cached item, then saves): the list shows the name, nothing kept it.
    /// </summary>
    public int FailFinishesAfterRename { get; set; }

    public Func<ListWrite, string, Task>? FinishCreateOverride { get; set; }

    public Task FinishCreateAsync(ListWrite write, string name)
    {
        if (FinishCreateOverride != null) return FinishCreateOverride(write, name);
        write.Spend(write.ListId, ListWriteKind.FinishCreate);
        Calls.Add($"finish:{name}");
        OnWrite?.Invoke("finish", write.ListId, write.ActAs, Array.Empty<Guid>());
        OnAwait?.Invoke("finish:before");
        if (FailFinishes > 0)
        {
            FailFinishes--;
            throw new IOException("Jellyfin could not save the list");
        }

        // The list keeps its folder (Jellyfin renames only the item).
        if (Lists.TryGetValue(write.ListId, out var list))
        {
            list.Info = list.Info with { Name = name };
            if (FailFinishesAfterRename > 0)
            {
                FailFinishesAfterRename--;
                throw new IOException("Jellyfin could not save the list");
            }

            list.SavedName = name;
        }

        OnAwait?.Invoke("finish:after");
        return Task.CompletedTask;
    }

    public ListInfo? FindCreated(string kind, Guid marker, Guid ownerId) => kind == ListKinds.Playlist
        ? Lists.Values.Where(l => l.Info.Kind == ListKinds.Playlist && (ownerId == Guid.Empty || l.Info.OwnerId == ownerId) && l.Path.Contains(marker.ToString("N"), StringComparison.OrdinalIgnoreCase)).Select(l => l.Info).FirstOrDefault()
        : Lists.Values.Where(l => l.Info.Kind == ListKinds.Collection && CollectionProviderIds.TryGetValue(l.Info.Id, out var ids)
            && ids.TryGetValue(JellyfinListHost.CreateMarkerKey, out var value) && value == marker.ToString("N")).Select(l => l.Info).FirstOrDefault();

    public Task<string?> CollectionDestinationAsync(string name)
    {
        OnAwait?.Invoke("destination");
        return Task.FromResult<string?>(CollectionsRoot + "/" + ValidFilename(name) + " [boxset]");
    }

    // JellyfinListHost.CollectionNameTaken: a collection in the collections folder kept at the destination or named so it
    // would be (compared without case); a [boxset] folder elsewhere doesn't count.
    public bool CollectionNameTaken(string destination)
    {
        var root = destination[..destination.LastIndexOf('/')];
        var folder = destination[(destination.LastIndexOf('/') + 1)..];
        return Lists.Values.Any(l => l.Info.Kind == ListKinds.Collection && l.Path.LastIndexOf('/') is var cut and > 0
            && string.Equals(l.Path[..cut], root, StringComparison.OrdinalIgnoreCase)
            && (string.Equals(l.Path[(cut + 1)..], folder, StringComparison.OrdinalIgnoreCase)
                || string.Equals(ValidFilename(GetStoredName(l.Info.Id)!) + " [boxset]", folder, StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>A playlist someone made in Jellyfin itself (no JE marker).</summary>
    public Task<Guid> CreateHandMadePlaylistAsync(string name, Guid ownerId) => Task.FromResult(MakePlaylist(name, ownerId, false, Array.Empty<ListShare>()));

    /// <summary>
    /// A collection someone made in Jellyfin itself (no JE marker), with Jellyfin's one-folder-per-name rule; or, with
    /// <paramref name="folder"/>, a <c>[boxset]</c> folder found in some library (not Jellyfin's collections folder).
    /// </summary>
    public Task<Guid> CreateHandMadeCollectionAsync(string name, string? folder = null) => Task.FromResult(MakeCollection(name, null, folder));

    /// <summary>
    /// Jellyfin deleting a user (PlaylistManager.RemovePlaylistsAsync, 10.11 and 12.2): each of their playlists goes to
    /// its first share (editors first), the rest stay shares; a private playlist without shares is deleted.
    /// </summary>
    public void RemoveUser(Guid userId)
    {
        foreach (var list in Lists.Values.Where(l => l.Info.Kind == ListKinds.Playlist && l.Info.OwnerId == userId).ToList())
        {
            var shares = list.Info.Shares.OrderByDescending(s => s.CanEdit).ToList();
            if (shares.Count > 0)
            {
                list.Info = list.Info with { OwnerId = shares[0].UserId, Shares = shares.Skip(1).ToList() };
            }
            else if (!list.Info.OpenAccess)
            {
                Lists.Remove(list.Info.Id);
            }
        }
    }

    /// <summary>Jellyfin's file-name rule (FileSystem.GetValidFilename) for the characters tests use.</summary>
    public static string ValidFilename(string name) => name.Replace('/', ' ').Replace(':', ' ');

    // PlaylistManager.CreatePlaylist: "<playlists>/<valid name>", with "1" appended while that folder exists.
    private string PlaylistPath(string name)
    {
        var path = PlaylistsRoot + "/" + ValidFilename(name);
        while (Lists.Values.Any(l => string.Equals(l.Path, path, StringComparison.Ordinal)))
        {
            path += "1";
        }

        return path;
    }

    /// <summary>The provider ids of each collection (Jellyfin keeps them with the item).</summary>
    public Dictionary<Guid, Dictionary<string, string>> CollectionProviderIds { get; } = new();

    private Guid MakePlaylist(string name, Guid ownerId, bool isPublic, IReadOnlyList<ListShare> shares)
    {
        var list = new FakeList { Info = new ListInfo(Guid.NewGuid(), ListKinds.Playlist, name, ownerId, isPublic, shares, CreatedAt: DateTime.UtcNow), Path = PlaylistPath(name), SavedName = name };
        Lists[list.Info.Id] = list;
        return list.Info.Id;
    }

    // Jellyfin 10.11/12 CollectionManager.CreateCollectionAsync: the folder is "<collections>/<valid name> [boxset]" and the
    // item id is derived from that path, so a second collection of a name replaces the first item (its members are gone).
    private Guid MakeCollection(string name, Dictionary<string, string>? providerIds, string? folder = null)
    {
        var path = (folder ?? CollectionsRoot) + "/" + ValidFilename(name) + " [boxset]";
        var existing = Lists.Values.FirstOrDefault(l => l.Info.Kind == ListKinds.Collection && string.Equals(l.Path, path, StringComparison.Ordinal));
        var id = existing?.Info.Id ?? Guid.NewGuid();
        var list = new FakeList { Info = new ListInfo(id, ListKinds.Collection, name, Guid.Empty, false, Array.Empty<ListShare>(), CreatedAt: DateTime.UtcNow), Path = path, SavedName = name };
        Lists[id] = list;
        CollectionProviderIds[id] = new Dictionary<string, string>(providerIds ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);
        return id;
    }

    public IReadOnlyList<ListInfo> GetAllPlaylists() => Lists.Values.Select(l => l.Info).Where(i => i.Kind == ListKinds.Playlist).ToList();

    public IReadOnlyList<ListInfo> GetAllCollections() => Lists.Values.Select(l => l.Info).Where(i => i.Kind == ListKinds.Collection).ToList();

    public IReadOnlyList<ListInfo> GetVisibleCollections(User user) =>
        Lists.Values.Select(l => l.Info).Where(i => i.Kind == ListKinds.Collection && IsListVisible(i.Id, user)).ToList();

    public LibraryItemFacts? GetItemFacts(Guid itemId)
    {
        if (Lists.TryGetValue(itemId, out var list))
        {
            return new LibraryItemFacts(itemId, list.Info.Kind == ListKinds.Playlist ? BaseItemKind.Playlist : BaseItemKind.BoxSet, Ids(), null, null, null, null, null, false);
        }

        if (!Items.TryGetValue(itemId, out var kind))
        {
            return null;
        }

        switch (kind)
        {
            case BaseItemKind.Movie:
                return new LibraryItemFacts(itemId, kind, Ids(
                    MoviesByTmdb.Where(p => p.Value == itemId).Select(p => (int?)p.Key)
                        .Concat(MoreMovieCopies.Where(p => p.Value.Contains(itemId)).Select(p => (int?)p.Key)).FirstOrDefault(),
                    null,
                    MoviesByImdb.Where(p => p.Value == itemId).Select(p => p.Key).FirstOrDefault()), null, null, null, null, null, false);
            case BaseItemKind.Series:
                var series = Series[itemId];
                return new LibraryItemFacts(itemId, kind, Ids(series.Tmdb, series.Tvdb, series.Imdb), null, null, null, null, null, false);
            case BaseItemKind.Episode:
                // Alternate items remain individually readable although Jellyfin's episode query lists only primaries.
                var episode = Episodes.FirstOrDefault(e => e.Id == itemId)
                    ?? Episodes.First(e => MediaSources.TryGetValue(e.Id, out var sources) && sources.Any(s => s.ItemId == itemId));
                var parent = Series[episode.SeriesId];
                return new LibraryItemFacts(itemId, kind, Ids(episode.OwnTmdb), parent.Id, Ids(parent.Tmdb, parent.Tvdb, parent.Imdb), EpisodeCoordinatesMissing.Contains(itemId) ? null : episode.Season, EpisodeCoordinatesMissing.Contains(itemId) ? null : episode.Episode, episode.EpisodeEnd, episode.Virtual);
            case BaseItemKind.Season:
                var season = Seasons.First(p => p.Value.Id == itemId);
                var owner = Series[season.Key.Series];
                return new LibraryItemFacts(itemId, kind, Ids(), owner.Id, Ids(owner.Tmdb, owner.Tvdb, owner.Imdb), season.Key.Season, null, null, season.Value.Virtual);
            default:
                return new LibraryItemFacts(itemId, kind, Ids(), null, null, null, null, null, false);
        }
    }

    public IReadOnlyList<Guid> FindMovies(int? tmdbId, string? imdbId, User? user)
    {
        var result = new List<Guid>();
        if (tmdbId.HasValue && MoviesByTmdb.TryGetValue(tmdbId.Value, out var byTmdb))
        {
            result.Add(byTmdb);
            result.AddRange(MoreMovieCopies.TryGetValue(tmdbId.Value, out var more) ? more : new List<Guid>());
        }

        if (imdbId != null && MoviesByImdb.TryGetValue(imdbId, out var byImdb) && !result.Contains(byImdb))
        {
            result.Add(byImdb);
        }

        return result.Where(id => user == null || CanAccessItem(id, user)).ToList();
    }

    /// <summary>Library queries made (series and episode lookups), to check that one operation memoises them.</summary>
    public int LibraryQueries { get; set; }

    public IReadOnlyList<Guid> FindSeries(int? tmdbId, int? tvdbId, string? imdbId, User? user)
    {
        LibraryQueries++;
        return Series.Values
            .Where(s => (tmdbId.HasValue && s.Tmdb == tmdbId) || (tvdbId.HasValue && s.Tvdb == tvdbId) || (imdbId != null && s.Imdb == imdbId))
            .Select(s => s.Id)
            .Where(id => user == null || CanAccessItem(id, user))
            .ToList();
    }

    public IReadOnlyList<LibraryEpisode> GetEpisodes(Guid seriesId, int? seasonNumber, User? user)
    {
        LibraryQueries++;
        return Episodes
            .Where(e => e.SeriesId == seriesId && !e.Virtual && !EpisodeCoordinatesMissing.Contains(e.Id) && (seasonNumber == null || e.Season == seasonNumber))
            .Where(e => user == null || CanAccessItem(e.Id, user))
            .Select(e => new LibraryEpisode(e.Id, seriesId, e.Season, e.Episode, e.EpisodeEnd))
            .ToList();
    }

    public Guid? FindSeason(Guid seriesId, int seasonNumber, User? user) =>
        Seasons.TryGetValue((seriesId, seasonNumber), out var season) && (user == null || CanAccessItem(season.Id, user)) ? season.Id : null;

    private static Dictionary<string, string> Ids(int? tmdb = null, int? tvdb = null, string? imdb = null)
    {
        var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (tmdb.HasValue)
        {
            ids["Tmdb"] = tmdb.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (tvdb.HasValue)
        {
            ids["Tvdb"] = tvdb.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (imdb != null)
        {
            ids["Imdb"] = imdb;
        }

        return ids;
    }

    public static string Short(Guid id) => id.ToString("N")[..6];
}
