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

    public sealed record FakeSeries(Guid Id, int? Tmdb, int? Tvdb, string? Imdb);

    public sealed record FakeEpisode(Guid Id, Guid SeriesId, int Season, int Episode, int? EpisodeEnd, bool Virtual, int? OwnTmdb);

    public bool SupportsPositionalInsert { get; set; } = true;
    public Dictionary<string, Guid> MoviesByImdb { get; } = new();
    public Dictionary<Guid, FakeSeries> Series { get; } = new();
    public List<FakeEpisode> Episodes { get; } = new();
    /// <summary>Season items: (series, season) → (id, virtual).</summary>
    public Dictionary<(Guid Series, int Season), (Guid Id, bool Virtual)> Seasons { get; } = new();
    /// <summary>Throws from AddToPlaylistAsync / AddToCollectionAsync when set (after optionally mutating).</summary>
    public Exception? FailAdds { get; set; }
    /// <summary>With <see cref="FailAdds"/>: still mutate the list before throwing (crash after Jellyfin's write).</summary>
    public bool FailAfterMutating { get; set; }
    public Dictionary<Guid, FakeList> Lists { get; } = new();
    public Dictionary<Guid, BaseItemKind> Items { get; } = new();
    public Dictionary<int, Guid> MoviesByTmdb { get; } = new();
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

        AfterAdd?.Invoke(playlistId);
        if (FailAdds != null)
        {
            throw FailAdds;
        }
    }

    public Task MoveInPlaylistAsync(Guid playlistId, Guid itemId, int newIndex, Guid userId)
    {
        Calls.Add($"move:{Short(itemId)}->{newIndex}");
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

        return Task.CompletedTask;
    }

    public Task AddToCollectionAsync(Guid collectionId, IReadOnlyList<Guid> itemIds)
    {
        Calls.Add($"collection:{string.Join(',', itemIds.Select(Short))}");
        if (FailAdds != null && !FailAfterMutating)
        {
            throw FailAdds;
        }

        Lists[collectionId].Raw.AddRange(itemIds.Where(id => !CollectionDrops.Contains(id)).Select(id => new RawEntry(id, true)));
        AfterCollectionAdd?.Invoke(collectionId);
        return FailAdds != null ? Task.FromException(FailAdds) : Task.CompletedTask;
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
                    MoviesByTmdb.Where(p => p.Value == itemId).Select(p => (int?)p.Key).FirstOrDefault(),
                    null,
                    MoviesByImdb.Where(p => p.Value == itemId).Select(p => p.Key).FirstOrDefault()), null, null, null, null, null, false);
            case BaseItemKind.Series:
                var series = Series[itemId];
                return new LibraryItemFacts(itemId, kind, Ids(series.Tmdb, series.Tvdb, series.Imdb), null, null, null, null, null, false);
            case BaseItemKind.Episode:
                var episode = Episodes.First(e => e.Id == itemId);
                var parent = Series[episode.SeriesId];
                return new LibraryItemFacts(itemId, kind, Ids(episode.OwnTmdb), parent.Id, Ids(parent.Tmdb, parent.Tvdb, parent.Imdb), episode.Season, episode.Episode, episode.EpisodeEnd, episode.Virtual);
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
            .Where(e => e.SeriesId == seriesId && !e.Virtual && (seasonNumber == null || e.Season == seasonNumber))
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
