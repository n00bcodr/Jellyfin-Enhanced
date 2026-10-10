using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;

namespace JE.Tests;

/// <summary>
/// In-memory Jellyfin for the list placeholder service. Playlist add/move reproduce the decompiled 12.2 / 10.11
/// PlaylistManager algorithms (raw-position insert, 10.11 de-duplicating append, visible-row move that inserts by the
/// manageable-list index into the raw array), so coordinate bugs show up here exactly as on a server.
/// </summary>
internal sealed class FakeListHost : IListPlaceholderHost
{
    public sealed class FakeList
    {
        public required ListInfo Info { get; set; }
        public List<RawEntry> Raw { get; } = new();
    }

    public bool SupportsPositionalInsert { get; set; } = true;
    public Dictionary<Guid, FakeList> Lists { get; } = new();
    public Dictionary<Guid, BaseItemKind> Items { get; } = new();
    public Dictionary<int, Guid> MoviesByTmdb { get; } = new();
    /// <summary>Items each user can't see (row visibility and access).</summary>
    public Dictionary<Guid, HashSet<Guid>> HiddenFrom { get; } = new();
    /// <summary>Lists each user can't see (entity visibility).</summary>
    public Dictionary<Guid, HashSet<Guid>> ListHiddenFrom { get; } = new();
    public List<string> Calls { get; } = new();
    public Func<Guid, IReadOnlyList<Guid>, int?, Task>? BeforeAdd { get; set; }
    public Action<Guid>? AfterCreate { get; set; }

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
        var list = new FakeList { Info = new ListInfo(Guid.NewGuid(), ListKinds.Playlist, "Playlist", owner.Id, openAccess, shares) };
        Lists[list.Info.Id] = list;
        return list;
    }

    public FakeList AddCollection(string name = "Collection")
    {
        var list = new FakeList { Info = new ListInfo(Guid.NewGuid(), ListKinds.Collection, name, Guid.Empty, false, Array.Empty<ListShare>()) };
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

    public IReadOnlyList<Guid> Resolved(Guid listId) =>
        Lists[listId].Raw.Where(r => r.Resolved).Select(r => r.ItemId!.Value).ToList();

    public ListInfo? GetList(Guid listId) => Lists.TryGetValue(listId, out var list) ? list.Info : null;

    public IReadOnlyList<RawEntry> GetRawEntries(Guid listId) => Lists.TryGetValue(listId, out var list) ? list.Raw.ToList() : Array.Empty<RawEntry>();

    public bool IsListVisible(Guid listId, User user) =>
        Lists.ContainsKey(listId) && !(ListHiddenFrom.TryGetValue(user.Id, out var set) && set.Contains(listId));

    public bool IsEntryVisible(Guid itemId, User user) => !(HiddenFrom.TryGetValue(user.Id, out var set) && set.Contains(itemId));

    public bool CanAccessItem(Guid itemId, User user) => Items.ContainsKey(itemId) && IsEntryVisible(itemId, user);

    public LibraryItemInfo? GetItem(Guid itemId) => Items.TryGetValue(itemId, out var kind) ? new LibraryItemInfo(itemId, kind) : null;

    public Guid? FindMovieByTmdb(int tmdbId, IReadOnlyList<User> users) =>
        MoviesByTmdb.TryGetValue(tmdbId, out var id) && users.All(u => CanAccessItem(id, u)) ? id : null;

    public async Task AddToPlaylistAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, int? rawPosition, Guid userId)
    {
        Calls.Add($"add:{string.Join(',', itemIds.Select(Short))}@{rawPosition?.ToString() ?? "end"}");
        if (BeforeAdd != null)
        {
            await BeforeAdd(playlistId, itemIds, rawPosition).ConfigureAwait(false);
        }

        var raw = Lists[playlistId].Raw;
        var add = itemIds.Where(id => IsEntryVisible(id, new User("x", "d", "d") { Id = userId })).ToList();
        if (!SupportsPositionalInsert)
        {
            // 10.11: drops items already in the playlist and repeats within the batch, then appends.
            var existing = raw.Where(r => r.ItemId.HasValue).Select(r => r.ItemId!.Value).ToHashSet();
            raw.AddRange(add.Where(id => !existing.Contains(id)).Distinct().Select(id => new RawEntry(id, true)));
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
    }

    public Task MoveInPlaylistAsync(Guid playlistId, Guid itemId, int newIndex, Guid userId)
    {
        Calls.Add($"move:{Short(itemId)}->{newIndex}");
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

        return Task.CompletedTask;
    }

    public Task AddToCollectionAsync(Guid collectionId, IReadOnlyList<Guid> itemIds)
    {
        Calls.Add($"collection:{string.Join(',', itemIds.Select(Short))}");
        Lists[collectionId].Raw.AddRange(itemIds.Select(id => new RawEntry(id, true)));
        return Task.CompletedTask;
    }

    public Task<Guid> CreatePlaylistAsync(string name, Guid ownerId, bool isPublic)
    {
        var list = new FakeList { Info = new ListInfo(Guid.NewGuid(), ListKinds.Playlist, name, ownerId, isPublic, Array.Empty<ListShare>()) };
        Lists[list.Info.Id] = list;
        Calls.Add($"create-playlist:{name}");
        AfterCreate?.Invoke(list.Info.Id);
        return Task.FromResult(list.Info.Id);
    }

    public Task<Guid> CreateCollectionAsync(string name)
    {
        var list = AddCollection(name);
        Calls.Add($"create-collection:{name}");
        return Task.FromResult(list.Info.Id);
    }

    public IReadOnlyList<ListInfo> GetAllPlaylists() => Lists.Values.Select(l => l.Info).Where(i => i.Kind == ListKinds.Playlist).ToList();

    public IReadOnlyList<ListInfo> GetVisibleCollections(User user) =>
        Lists.Values.Select(l => l.Info).Where(i => i.Kind == ListKinds.Collection && IsListVisible(i.Id, user)).ToList();

    public static string Short(Guid id) => id.ToString("N")[..6];
}
