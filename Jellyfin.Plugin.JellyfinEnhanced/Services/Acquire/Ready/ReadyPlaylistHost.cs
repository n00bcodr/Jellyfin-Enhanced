using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>
    /// Jellyfin's playlists as the Ready playlist uses them (tests fake it). Only ever called with the id of the one playlist
    /// a person's binding names (checked owner, privacy and marker first), never a playlist found by name, and never under
    /// a database transaction or 4c1's list Lifecycle lock.
    /// </summary>
    public interface IReadyPlaylistHost
    {
        /// <summary>The playlist, or null when Jellyfin has no playlist with this id.</summary>
        ReadyPlaylistInfo? Get(Guid playlistId);

        /// <summary>
        /// The owner's playlist whose folder carries <paramref name="marker"/> (the create's own marker, never a name), or null.
        /// </summary>
        ReadyPlaylistInfo? FindByMarker(Guid ownerId, string marker);

        /// <summary>
        /// The playlist's raw entries in order: each linked entry's item (by its id, or by its path for an entry Jellyfin
        /// keeps by path only, as 10.11 does after it reads the playlist file again), <see cref="Guid.Empty"/> for an entry
        /// that resolves to no item. Duplicates are kept.
        /// </summary>
        IReadOnlyList<Guid> Entries(Guid playlistId);

        /// <summary>Makes a private video playlist of the owner's, shared with nobody, named <paramref name="name"/>; returns its id.</summary>
        Task<Guid> CreateAsync(Guid ownerId, string name);

        /// <summary>Gives the playlist its display name (its folder, and so its marker, stays).</summary>
        Task RenameAsync(Guid playlistId, Guid ownerId, string name);

        /// <summary>
        /// Makes the playlist hold exactly these exact version items in this order, as the owner (Jellyfin's playlist update
        /// with item ids: it empties the list, then adds them; items Jellyfin won't hold are left out).
        /// </summary>
        Task SetAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, Guid ownerId);

        /// <summary>Deletes exactly this playlist (never the owner's other playlists).</summary>
        Task DeleteAsync(Guid playlistId);
    }

    /// <summary>The production <see cref="IReadyPlaylistHost"/> over Jellyfin's playlist and library managers.</summary>
    public sealed class JellyfinReadyPlaylistHost : IReadyPlaylistHost
    {
        private readonly ILibraryManager _library;
        private readonly IPlaylistManager _playlists;

        /// <summary>Creates the host (DI).</summary>
        public JellyfinReadyPlaylistHost(ILibraryManager library, IPlaylistManager playlists)
        {
            _library = library;
            _playlists = playlists;
        }

        /// <inheritdoc />
        public ReadyPlaylistInfo? Get(Guid playlistId) => Info(_library.GetItemById(playlistId) as Playlist);

        /// <inheritdoc />
        public ReadyPlaylistInfo? FindByMarker(Guid ownerId, string marker)
        {
            if (string.IsNullOrEmpty(marker)) return null;
            return _library.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.Playlist }, Recursive = true })
                .OfType<Playlist>()
                .Where(p => p.OwnerUserId == ownerId)
                .Select(Info)
                .FirstOrDefault(p => p != null && p.HasMarker(marker));
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid> Entries(Guid playlistId)
        {
            if (_library.GetItemById(playlistId) is not Playlist playlist) return Array.Empty<Guid>();
            // Same LinkedChild instances as LinkedChildren; an entry that resolves to no item is absent.
            return RawIds(playlist.LinkedChildren ?? Array.Empty<LinkedChild>(), playlist.GetLinkedChildrenInfos().Select(p => (p.Item1, p.Item2.Id)));
        }

        /// <summary>
        /// The raw entries of a playlist: each linked entry's resolved item, else its stored item id, else <see cref="Guid.Empty"/>.
        /// An entry kept by path only (no item id) counts by the item its path resolves to.
        /// </summary>
        internal static IReadOnlyList<Guid> RawIds(IReadOnlyList<LinkedChild> children, IEnumerable<(LinkedChild Child, Guid ItemId)> resolved)
        {
            var map = new Dictionary<LinkedChild, Guid>(ReferenceEqualityComparer.Instance);
            foreach (var (child, id) in resolved) map[child] = id;
            return children.Select(c => map.TryGetValue(c, out var id) ? id : c.ItemId ?? Guid.Empty).ToList();
        }

        /// <inheritdoc />
        public async Task<Guid> CreateAsync(Guid ownerId, string name)
        {
            var result = await _playlists.CreatePlaylist(new PlaylistCreationRequest
            {
                Name = name,
                UserId = ownerId,
                // An empty playlist can't infer its media type and would default to Audio.
                MediaType = MediaType.Video,
                Public = false,
                // No shares: Jellyfin hands a deleted owner's playlist to its first share.
                Users = Array.Empty<PlaylistUserPermissions>(),
            }).ConfigureAwait(false);
            return Guid.Parse(result.Id);
        }

        /// <inheritdoc />
        public Task RenameAsync(Guid playlistId, Guid ownerId, string name)
            => _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlistId, UserId = ownerId, Name = name });

        /// <inheritdoc />
        public Task SetAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, Guid ownerId)
            => _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlistId, UserId = ownerId, Ids = itemIds.ToArray() });

        /// <inheritdoc />
        public Task DeleteAsync(Guid playlistId)
        {
            if (_library.GetItemById(playlistId) is Playlist playlist)
                _library.DeleteItem(playlist, new DeleteOptions { DeleteFileLocation = true }, true);
            return Task.CompletedTask;
        }

        private static ReadyPlaylistInfo? Info(Playlist? p)
            => p == null ? null : new ReadyPlaylistInfo(p.Id, p.OwnerUserId, p.OpenAccess, p.Shares?.Count() ?? 0,
                string.IsNullOrEmpty(p.Path) ? string.Empty : Path.GetFileName(p.Path.TrimEnd('/', '\\')), p.Name ?? string.Empty);
    }
}
