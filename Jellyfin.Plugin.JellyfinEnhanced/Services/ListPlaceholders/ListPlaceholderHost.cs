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
