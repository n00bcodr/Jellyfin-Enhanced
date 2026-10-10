using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>A playlist share.</summary>
    /// <param name="UserId">Shared-with user.</param>
    /// <param name="CanEdit">Whether the share may edit.</param>
    public readonly record struct ListShare(Guid UserId, bool CanEdit);

    /// <summary>The facts JE needs about a Jellyfin list.</summary>
    /// <param name="Id">List id.</param>
    /// <param name="Kind"><see cref="ListKinds.Playlist"/> or <see cref="ListKinds.Collection"/>.</param>
    /// <param name="Name">Display name.</param>
    /// <param name="OwnerId">Playlist owner (empty for collections).</param>
    /// <param name="OpenAccess">Playlist is public.</param>
    /// <param name="Shares">Playlist shares.</param>
    public sealed record ListInfo(Guid Id, string Kind, string Name, Guid OwnerId, bool OpenAccess, IReadOnlyList<ListShare> Shares);

    /// <summary>The facts JE needs about a library item.</summary>
    /// <param name="Id">Item id.</param>
    /// <param name="Kind">Jellyfin item kind.</param>
    public sealed record LibraryItemInfo(Guid Id, BaseItemKind Kind);

    /// <summary>A real (non-virtual) library episode and its coordinates.</summary>
    /// <param name="Id">Episode item id.</param>
    /// <param name="SeriesId">The series it belongs to.</param>
    /// <param name="Season">Season number (<c>ParentIndexNumber</c>).</param>
    /// <param name="Episode">First episode number (<c>IndexNumber</c>).</param>
    /// <param name="EpisodeEnd">Last episode number of a multi-episode file (<c>IndexNumberEnd</c>), else null.</param>
    public sealed record LibraryEpisode(Guid Id, Guid SeriesId, int Season, int Episode, int? EpisodeEnd);

    /// <summary>
    /// What swap-in needs to know about a library item that just changed: its kind, its own provider ids and, for
    /// episodes and seasons, the SERIES' provider ids and the coordinates (episode-level TMDB ids are never used).
    /// </summary>
    /// <param name="Id">Item id.</param>
    /// <param name="Kind">Jellyfin item kind.</param>
    /// <param name="ProviderIds">The item's own provider ids (Movie, Series).</param>
    /// <param name="SeriesId">Series of an episode/season, else null.</param>
    /// <param name="SeriesProviderIds">Provider ids of that series (episodes/seasons), else null.</param>
    /// <param name="Season">Season number (episode: <c>ParentIndexNumber</c>; season: <c>IndexNumber</c>).</param>
    /// <param name="Episode">Episode number (<c>IndexNumber</c>), episodes only.</param>
    /// <param name="EpisodeEnd">Last episode of a multi-episode file, episodes only.</param>
    /// <param name="IsVirtual">Jellyfin "missing" placeholder item (no file); never swapped in.</param>
    public sealed record LibraryItemFacts(
        Guid Id,
        BaseItemKind Kind,
        IReadOnlyDictionary<string, string> ProviderIds,
        Guid? SeriesId,
        IReadOnlyDictionary<string, string>? SeriesProviderIds,
        int? Season,
        int? Episode,
        int? EpisodeEnd,
        bool IsVirtual);

    /// <summary>
    /// Everything the placeholder service needs from Jellyfin, behind one seam so the list logic (coordinates, moves,
    /// inserts) can be tested against a faithful in-memory fake. The production implementation is
    /// <see cref="JellyfinListPlaceholderHost"/>, the only place with Jellyfin-version differences.
    /// </summary>
    public interface IListPlaceholderHost
    {
        /// <summary>True when playlist inserts take a position (Jellyfin 12); else append + move (10.11).</summary>
        bool SupportsPositionalInsert { get; }

        /// <summary>Resolves a list id to a playlist or collection.</summary>
        /// <param name="listId">Id.</param>
        /// <returns>The list, or null when the id is not a playlist/collection.</returns>
        ListInfo? GetList(Guid listId);

        /// <summary>The raw <c>LinkedChildren</c> slots of a list, freshly read, in order.</summary>
        /// <param name="listId">Id.</param>
        /// <returns>The slots.</returns>
        IReadOnlyList<RawEntry> GetRawEntries(Guid listId);

        /// <summary>Jellyfin's own visibility of the list entity for a user (runtime <c>IsVisible</c>, incl. 12.2 child checks).</summary>
        /// <param name="listId">Id.</param>
        /// <param name="user">User.</param>
        /// <returns>Whether the entity is visible.</returns>
        bool IsListVisible(Guid listId, User user);

        /// <summary>
        /// Row visibility as Jellyfin applies it to playlist rows and to <c>MoveItemAsync</c> (<c>BaseItem.IsVisible</c>).
        /// </summary>
        /// <param name="itemId">Item.</param>
        /// <param name="user">User.</param>
        /// <returns>Whether the row is visible.</returns>
        bool IsEntryVisible(Guid itemId, User user);

        /// <summary>Full access to an item (library access + parental, <c>GetItemById(id, user)</c>).</summary>
        /// <param name="itemId">Item.</param>
        /// <param name="user">User.</param>
        /// <returns>Whether the user can access the item.</returns>
        bool CanAccessItem(Guid itemId, User user);

        /// <summary>Basic facts of a library item.</summary>
        /// <param name="itemId">Item.</param>
        /// <returns>Facts, or null when it doesn't exist.</returns>
        LibraryItemInfo? GetItem(Guid itemId);

        /// <summary>A library movie with this TMDB id that every given user can access.</summary>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="users">Users that must all have access.</param>
        /// <returns>The item id or null.</returns>
        Guid? FindMovieByTmdb(int tmdbId, IReadOnlyList<User> users);

        /// <summary>Adds items to a playlist (jf12: at a raw position; jf10: appended, position ignored).</summary>
        /// <param name="playlistId">Playlist.</param>
        /// <param name="itemIds">Items in order.</param>
        /// <param name="rawPosition">Raw LinkedChildren position (null = append).</param>
        /// <param name="userId">User Jellyfin expands/filters with (the owner).</param>
        /// <returns>A task.</returns>
        Task AddToPlaylistAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, int? rawPosition, Guid userId);

        /// <summary>Moves the FIRST copy of an item to a visible-row index (Jellyfin <c>MoveItemAsync</c>).</summary>
        /// <param name="playlistId">Playlist.</param>
        /// <param name="itemId">Item.</param>
        /// <param name="newIndex">Index among rows visible to <paramref name="userId"/>.</param>
        /// <param name="userId">User the move runs as.</param>
        /// <returns>A task.</returns>
        Task MoveInPlaylistAsync(Guid playlistId, Guid itemId, int newIndex, Guid userId);

        /// <summary>Adds items to a collection (already de-duplicated by the caller).</summary>
        /// <param name="collectionId">Collection.</param>
        /// <param name="itemIds">Items.</param>
        /// <returns>A task.</returns>
        Task AddToCollectionAsync(Guid collectionId, IReadOnlyList<Guid> itemIds);

        /// <summary>Creates an empty video playlist.</summary>
        /// <param name="name">Name.</param>
        /// <param name="ownerId">Owner.</param>
        /// <param name="isPublic">Open access.</param>
        /// <returns>The new id.</returns>
        Task<Guid> CreatePlaylistAsync(string name, Guid ownerId, bool isPublic);

        /// <summary>Creates an empty collection.</summary>
        /// <param name="name">Name.</param>
        /// <returns>The new id.</returns>
        Task<Guid> CreateCollectionAsync(string name);

        /// <summary>Every playlist on the server (unfiltered; callers apply access rules).</summary>
        /// <returns>Playlists.</returns>
        IReadOnlyList<ListInfo> GetAllPlaylists();

        /// <summary>Collections the user can see.</summary>
        /// <param name="user">User.</param>
        /// <returns>Collections.</returns>
        IReadOnlyList<ListInfo> GetVisibleCollections(User user);

        /// <summary>Swap-in facts of a library item (null when it doesn't exist).</summary>
        /// <param name="itemId">Item.</param>
        /// <returns>The facts or null.</returns>
        LibraryItemFacts? GetItemFacts(Guid itemId);

        /// <summary>
        /// Library movies with this TMDB id or (else) IMDb id, in library order. Each id is its own single-key query
        /// (jf10 and jf12 combine mixed provider filters differently).
        /// </summary>
        /// <param name="tmdbId">TMDB id, or null.</param>
        /// <param name="imdbId">IMDb id, or null.</param>
        /// <param name="user">User the query is scoped to (library access + parental), or null for the whole library.</param>
        /// <returns>Movie item ids (distinct).</returns>
        IReadOnlyList<Guid> FindMovies(int? tmdbId, string? imdbId, User? user);

        /// <summary>Library series matching ANY of the ids (one single-key query per id).</summary>
        /// <param name="tmdbId">TMDB id, or null.</param>
        /// <param name="tvdbId">TVDB id, or null.</param>
        /// <param name="imdbId">IMDb id, or null.</param>
        /// <param name="user">User the query is scoped to, or null for the whole library.</param>
        /// <returns>Series item ids (distinct).</returns>
        IReadOnlyList<Guid> FindSeries(int? tmdbId, int? tvdbId, string? imdbId, User? user);

        /// <summary>The real (non-virtual) episodes of a series with known coordinates, optionally of one season.</summary>
        /// <param name="seriesId">Series.</param>
        /// <param name="seasonNumber">Season filter, or null for every season.</param>
        /// <param name="user">User the query is scoped to, or null for the whole library.</param>
        /// <returns>Episodes (any order).</returns>
        IReadOnlyList<LibraryEpisode> GetEpisodes(Guid seriesId, int? seasonNumber, User? user);

        /// <summary>The Season item of a series (a real season preferred over a virtual one).</summary>
        /// <param name="seriesId">Series.</param>
        /// <param name="seasonNumber">Season number.</param>
        /// <param name="user">User the query is scoped to, or null for the whole library.</param>
        /// <returns>The season id or null.</returns>
        Guid? FindSeason(Guid seriesId, int seasonNumber, User? user);
    }

    /// <summary>The production <see cref="IListPlaceholderHost"/> over Jellyfin's library, playlist and collection managers.</summary>
    public sealed class JellyfinListPlaceholderHost : IListPlaceholderHost
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IPlaylistManager _playlistManager;
        private readonly ICollectionManager _collectionManager;

        /// <summary>Creates the host.</summary>
        /// <param name="libraryManager">Library manager.</param>
        /// <param name="playlistManager">Playlist manager.</param>
        /// <param name="collectionManager">Collection manager.</param>
        public JellyfinListPlaceholderHost(ILibraryManager libraryManager, IPlaylistManager playlistManager, ICollectionManager collectionManager)
        {
            _libraryManager = libraryManager;
            _playlistManager = playlistManager;
            _collectionManager = collectionManager;
        }

        /// <inheritdoc />
#if JF12
        public bool SupportsPositionalInsert => true;
#else
        public bool SupportsPositionalInsert => false;
#endif

        /// <inheritdoc />
        public ListInfo? GetList(Guid listId) => ToInfo(_libraryManager.GetItemById(listId));

        /// <inheritdoc />
        public IReadOnlyList<RawEntry> GetRawEntries(Guid listId)
        {
            if (_libraryManager.GetItemById(listId) is not Folder folder || folder is not (Playlist or BoxSet))
            {
                return Array.Empty<RawEntry>();
            }

            var raw = folder.LinkedChildren ?? Array.Empty<LinkedChild>();
            // Same LinkedChild instances as LinkedChildren; unresolved (dangling) links are absent.
            var resolved = new Dictionary<LinkedChild, Guid>(ReferenceEqualityComparer.Instance);
            foreach (var pair in folder.GetLinkedChildrenInfos())
            {
                resolved[pair.Item1] = pair.Item2.Id;
            }

            var result = new List<RawEntry>(raw.Length);
            foreach (var child in raw)
            {
                result.Add(resolved.TryGetValue(child, out var id) ? new RawEntry(id, true) : new RawEntry(child.ItemId, false));
            }

            return result;
        }

        /// <inheritdoc />
        public bool IsListVisible(Guid listId, User user)
        {
            var item = _libraryManager.GetItemById(listId);
            return item switch
            {
                Playlist playlist => playlist.IsVisible(user),
                BoxSet => _libraryManager.GetItemById<BaseItem>(listId, user) != null,
                _ => false,
            };
        }

        /// <inheritdoc />
        public bool IsEntryVisible(Guid itemId, User user) => _libraryManager.GetItemById(itemId)?.IsVisible(user) == true;

        /// <inheritdoc />
        public bool CanAccessItem(Guid itemId, User user) => _libraryManager.GetItemById<BaseItem>(itemId, user) != null;

        /// <inheritdoc />
        public LibraryItemInfo? GetItem(Guid itemId)
        {
            var item = _libraryManager.GetItemById(itemId);
            return item == null ? null : new LibraryItemInfo(item.Id, item.GetBaseItemKind());
        }

        /// <inheritdoc />
        public Guid? FindMovieByTmdb(int tmdbId, IReadOnlyList<User> users)
        {
            if (users.Count == 0)
            {
                return null;
            }

            var query = new InternalItemsQuery(users[0])
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie },
                HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    { MetadataProvider.Tmdb.ToString(), tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture) },
                },
                // No Limit: copies the first user sees may not all be visible to the others (per-user libraries), so
                // every copy is checked until one passes for all of them. Copies of one TMDB id are few.
                Recursive = true,
            };
            foreach (var item in _libraryManager.GetItemList(query))
            {
                if (users.All(u => CanAccessItem(item.Id, u)))
                {
                    return item.Id;
                }
            }

            return null;
        }

        /// <inheritdoc />
        public Task AddToPlaylistAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, int? rawPosition, Guid userId)
        {
#if JF12
            return _playlistManager.AddItemToPlaylistAsync(playlistId, itemIds.ToArray(), rawPosition, userId);
#else
            return _playlistManager.AddItemToPlaylistAsync(playlistId, itemIds.ToArray(), userId);
#endif
        }

        /// <inheritdoc />
        public Task MoveInPlaylistAsync(Guid playlistId, Guid itemId, int newIndex, Guid userId) =>
            _playlistManager.MoveItemAsync(
                playlistId.ToString("N", System.Globalization.CultureInfo.InvariantCulture),
                itemId.ToString("N", System.Globalization.CultureInfo.InvariantCulture),
                newIndex,
                userId);

        /// <inheritdoc />
        public Task AddToCollectionAsync(Guid collectionId, IReadOnlyList<Guid> itemIds) =>
            _collectionManager.AddToCollectionAsync(collectionId, itemIds.Distinct().ToArray());

        /// <inheritdoc />
        public async Task<Guid> CreatePlaylistAsync(string name, Guid ownerId, bool isPublic)
        {
            var result = await _playlistManager.CreatePlaylist(new PlaylistCreationRequest
            {
                Name = name,
                UserId = ownerId,
                // An empty playlist can't infer its media type and would default to Audio.
                MediaType = MediaType.Video,
                Public = isPublic,
            }).ConfigureAwait(false);
            return Guid.Parse(result.Id);
        }

        /// <inheritdoc />
        public async Task<Guid> CreateCollectionAsync(string name)
        {
            var boxSet = await _collectionManager.CreateCollectionAsync(new CollectionCreationOptions
            {
                Name = name,
                IsLocked = false,
            }).ConfigureAwait(false);
            return boxSet.Id;
        }

        /// <inheritdoc />
        public IReadOnlyList<ListInfo> GetAllPlaylists() =>
            _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Playlist },
                Recursive = true,
            })
            .Select(ToInfo)
            .OfType<ListInfo>()
            .ToList();

        /// <inheritdoc />
        public IReadOnlyList<ListInfo> GetVisibleCollections(User user) =>
            _libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.BoxSet },
                Recursive = true,
            })
            .Where(i => _libraryManager.GetItemById<BaseItem>(i.Id, user) != null)
            .Select(ToInfo)
            .OfType<ListInfo>()
            .ToList();

        /// <inheritdoc />
        public LibraryItemFacts? GetItemFacts(Guid itemId)
        {
            var item = _libraryManager.GetItemById(itemId);
            if (item == null)
            {
                return null;
            }

            var ids = CopyIds(item);
            switch (item)
            {
                case Episode episode:
                {
                    var series = episode.SeriesId == Guid.Empty ? null : _libraryManager.GetItemById(episode.SeriesId);
                    return new LibraryItemFacts(item.Id, BaseItemKind.Episode, ids, series?.Id, series == null ? null : CopyIds(series), episode.ParentIndexNumber, episode.IndexNumber, episode.IndexNumberEnd, item.IsVirtualItem);
                }

                case Season season:
                {
                    var series = season.SeriesId == Guid.Empty ? null : _libraryManager.GetItemById(season.SeriesId);
                    return new LibraryItemFacts(item.Id, BaseItemKind.Season, ids, series?.Id, series == null ? null : CopyIds(series), season.IndexNumber, null, null, item.IsVirtualItem);
                }

                default:
                    return new LibraryItemFacts(item.Id, item.GetBaseItemKind(), ids, null, null, null, null, null, item.IsVirtualItem);
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid> FindMovies(int? tmdbId, string? imdbId, User? user)
        {
            var result = new List<Guid>();
            if (tmdbId is > 0)
            {
                AddMatches(result, BaseItemKind.Movie, MetadataProvider.Tmdb, tmdbId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), user);
            }

            if (!string.IsNullOrEmpty(imdbId))
            {
                AddMatches(result, BaseItemKind.Movie, MetadataProvider.Imdb, imdbId, user);
            }

            return result;
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid> FindSeries(int? tmdbId, int? tvdbId, string? imdbId, User? user)
        {
            var result = new List<Guid>();
            if (tmdbId is > 0)
            {
                AddMatches(result, BaseItemKind.Series, MetadataProvider.Tmdb, tmdbId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), user);
            }

            if (tvdbId is > 0)
            {
                AddMatches(result, BaseItemKind.Series, MetadataProvider.Tvdb, tvdbId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), user);
            }

            if (!string.IsNullOrEmpty(imdbId))
            {
                AddMatches(result, BaseItemKind.Series, MetadataProvider.Imdb, imdbId, user);
            }

            return result;
        }

        /// <inheritdoc />
        public IReadOnlyList<LibraryEpisode> GetEpisodes(Guid seriesId, int? seasonNumber, User? user)
        {
            var query = Query(user, BaseItemKind.Episode);
            query.AncestorIds = new[] { seriesId };
            query.IsVirtualItem = false;
            query.ParentIndexNumber = seasonNumber;
            return _libraryManager.GetItemList(query)
                .OfType<Episode>()
                .Where(e => e.ParentIndexNumber.HasValue && e.IndexNumber.HasValue && !e.IsVirtualItem)
                .Select(e => new LibraryEpisode(e.Id, seriesId, e.ParentIndexNumber!.Value, e.IndexNumber!.Value, e.IndexNumberEnd))
                .ToList();
        }

        /// <inheritdoc />
        public Guid? FindSeason(Guid seriesId, int seasonNumber, User? user)
        {
            var query = Query(user, BaseItemKind.Season);
            query.AncestorIds = new[] { seriesId };
            query.IndexNumber = seasonNumber;
            var seasons = _libraryManager.GetItemList(query).OfType<Season>().Where(s => s.IndexNumber == seasonNumber).ToList();
            return (seasons.FirstOrDefault(s => !s.IsVirtualItem) ?? seasons.FirstOrDefault())?.Id;
        }

        private static InternalItemsQuery Query(User? user, BaseItemKind kind)
        {
            var query = user == null ? new InternalItemsQuery() : new InternalItemsQuery(user);
            query.IncludeItemTypes = new[] { kind };
            query.Recursive = true;
            return query;
        }

        // One provider per query: jf10 ANDs and jf12 ORs mixed provider filters, single keys behave the same.
        private void AddMatches(List<Guid> result, BaseItemKind kind, MetadataProvider provider, string value, User? user)
        {
            var query = Query(user, kind);
            query.HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { provider.ToString(), value } };
            foreach (var item in _libraryManager.GetItemList(query))
            {
                if (!item.IsVirtualItem && !result.Contains(item.Id))
                {
                    result.Add(item.Id);
                }
            }
        }

        private static Dictionary<string, string> CopyIds(BaseItem item)
        {
            var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in item.ProviderIds ?? new Dictionary<string, string>())
            {
                if (!string.IsNullOrEmpty(pair.Key) && !string.IsNullOrEmpty(pair.Value))
                {
                    ids[pair.Key] = pair.Value;
                }
            }

            return ids;
        }

        private static ListInfo? ToInfo(BaseItem? item) => item switch
        {
            Playlist playlist => new ListInfo(
                playlist.Id,
                ListKinds.Playlist,
                playlist.Name ?? string.Empty,
                playlist.OwnerUserId,
                playlist.OpenAccess,
                (playlist.Shares ?? Array.Empty<PlaylistUserPermissions>()).Select(s => new ListShare(s.UserId, s.CanEdit)).ToList()),
            BoxSet boxSet => new ListInfo(boxSet.Id, ListKinds.Collection, boxSet.Name ?? string.Empty, Guid.Empty, false, Array.Empty<ListShare>()),
            _ => null,
        };
    }
}
