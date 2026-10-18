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
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Playlists;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>
    /// The last check before one Jellyfin change of a Ready playlist: given the playlist as Jellyfin stored it now (null for a
    /// create, or when it is gone), null to go ahead or why not. The host calls it synchronously, with no await between it
    /// and the call into Jellyfin.
    /// </summary>
    /// <param name="stored">The playlist as stored now, or null.</param>
    /// <returns>Null to make the change, else the reason it isn't made.</returns>
    public delegate string? ReadyGate(ReadyPlaylistInfo? stored);

    /// <summary>
    /// Jellyfin's playlists as the Ready playlist uses them (tests fake it). Only ever called with the id of the one playlist
    /// a person's binding names, never a playlist found by name, and never under a database transaction or 4c1's list
    /// Lifecycle lock. Every change takes a <see cref="ReadyGate"/>, run right before Jellyfin is called.
    /// </summary>
    public interface IReadyPlaylistHost
    {
        /// <summary>The playlist as Jellyfin stored it (owner, privacy, shares, folder, name), or null when there is none.</summary>
        ReadyPlaylistInfo? Get(Guid playlistId);

        /// <summary>The id Jellyfin will give a playlist made now under <paramref name="name"/> (it derives it from the folder), or null.</summary>
        Guid? NewPlaylistId(string name);

        /// <summary>
        /// The playlist's raw entries in order: each linked entry's item (by its id, or by its path for an entry Jellyfin
        /// keeps by path only, as 10.11 does after it reads the playlist file again), <see cref="Guid.Empty"/> for an entry
        /// that resolves to no item. Duplicates are kept.
        /// </summary>
        IReadOnlyList<Guid> Entries(Guid playlistId);

        /// <summary>
        /// Makes a private video playlist of the owner's, shared with nobody, named <paramref name="name"/>, if
        /// <paramref name="gate"/> allows it; returns its id, or why it wasn't made.
        /// </summary>
        Task<(Guid? Id, string? Refused)> CreateAsync(Guid ownerId, string name, ReadyGate gate);

        /// <summary>Gives the playlist its display name (its folder, and so its marker, stays) if the gate allows it; null or why not.</summary>
        Task<string?> RenameAsync(Guid playlistId, Guid ownerId, string name, ReadyGate gate);

        /// <summary>
        /// Makes the playlist hold exactly these exact version items in this order, as the owner (Jellyfin's playlist update
        /// with item ids: it empties the list, then adds them; items Jellyfin won't hold are left out), if the gate allows it;
        /// null or why not.
        /// </summary>
        Task<string?> SetAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, Guid ownerId, ReadyGate gate);

        /// <summary>Deletes exactly this playlist (never the owner's other playlists) if the gate allows it; null or why not.</summary>
        Task<string?> DeleteAsync(Guid playlistId, ReadyGate gate);
    }

    /// <summary>
    /// The production <see cref="IReadyPlaylistHost"/> over Jellyfin's playlist and library managers. Reads go to what Jellyfin
    /// stored (its repository), not its cached instance: Jellyfin's own share, publish and rename materialize another
    /// instance and save it, leaving the cached one as it was. Its membership update saves the whole cached instance, so
    /// right before one the cached instance's metadata JE doesn't own (name, shares, privacy, owner and the rest the person
    /// may edit) is set from the stored one (heal-then-write, D49): a membership write never undoes the person's change.
    /// </summary>
    public sealed class JellyfinReadyPlaylistHost : IReadyPlaylistHost
    {
        private readonly ILibraryManager _library;
        private readonly IPlaylistManager _playlists;
        private readonly IFileSystem _fileSystem;

        /// <summary>Creates the host (DI).</summary>
        public JellyfinReadyPlaylistHost(ILibraryManager library, IPlaylistManager playlists, IFileSystem fileSystem)
        {
            _library = library;
            _playlists = playlists;
            _fileSystem = fileSystem;
        }

        /// <inheritdoc />
        public ReadyPlaylistInfo? Get(Guid playlistId) => Info(Stored(playlistId));

        /// <inheritdoc />
        public Guid? NewPlaylistId(string name)
        {
            // As Jellyfin's CreatePlaylist: the playlists folder, the name as a valid file name, "1" appended while it exists.
            var folder = _playlists.GetPlaylistsFolder()?.Path;
            if (string.IsNullOrEmpty(folder)) return null;
            var path = Path.Combine(folder, _fileSystem.GetValidFilename(name));
            while (Directory.Exists(path)) path += "1";
            return _library.GetNewItemId(path, typeof(Playlist));
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
        public async Task<(Guid? Id, string? Refused)> CreateAsync(Guid ownerId, string name, ReadyGate gate)
        {
            if (gate(null) is { } refused) return (null, refused);
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
            return (Guid.Parse(result.Id), null);
        }

        /// <inheritdoc />
        public async Task<string?> RenameAsync(Guid playlistId, Guid ownerId, string name, ReadyGate gate)
        {
            if (Checked(playlistId, gate) is { } refused) return refused;
            await _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlistId, UserId = ownerId, Name = name }).ConfigureAwait(false);
            return null;
        }

        /// <inheritdoc />
        public async Task<string?> SetAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, Guid ownerId, ReadyGate gate)
        {
            if (Checked(playlistId, gate) is { } refused) return refused;
            await _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlistId, UserId = ownerId, Ids = itemIds.ToArray() }).ConfigureAwait(false);
            return null;
        }

        /// <inheritdoc />
        public Task<string?> DeleteAsync(Guid playlistId, ReadyGate gate)
        {
            if (Checked(playlistId, gate) is { } refused) return Task.FromResult<string?>(refused);
            if (_library.GetItemById(playlistId) is Playlist playlist)
                _library.DeleteItem(playlist, new DeleteOptions { DeleteFileLocation = true }, true);
            return Task.FromResult<string?>(null);
        }

        // The stored playlist through the gate, then the cached instance healed from it; nothing awaited in between, and the
        // caller calls Jellyfin right after. Jellyfin has no conditional save: a native edit landing inside its own save is a
        // Jellyfin limitation (D49).
        private string? Checked(Guid playlistId, ReadyGate gate)
        {
            var stored = Stored(playlistId);
            if (gate(Info(stored)) is { } refused) return refused;
            if (_library.GetItemById(playlistId) is not Playlist cached || stored == null) return "missing";
            Heal(stored, cached);
            return null;
        }

        private Playlist? Stored(Guid playlistId) => playlistId == Guid.Empty ? null : _library.RetrieveItem(playlistId) as Playlist;

        // Jellyfin's item editor's fields and the playlist's own (owner, privacy, shares), as stored; membership, path and
        // identity stay with Jellyfin's manager.
        private static void Heal(Playlist stored, Playlist cached)
        {
            if (ReferenceEquals(stored, cached)) return;
            cached.Name = stored.Name;
            cached.ForcedSortName = stored.ForcedSortName;
            cached.OriginalTitle = stored.OriginalTitle;
#if JF12
            cached.OriginalLanguage = stored.OriginalLanguage;
#endif
            cached.Overview = stored.Overview;
            cached.Tagline = stored.Tagline;
            cached.CommunityRating = stored.CommunityRating;
            cached.CriticRating = stored.CriticRating;
            cached.OfficialRating = stored.OfficialRating;
            cached.CustomRating = stored.CustomRating;
            cached.PremiereDate = stored.PremiereDate;
            cached.EndDate = stored.EndDate;
            cached.ProductionYear = stored.ProductionYear;
            cached.DateCreated = stored.DateCreated;
            cached.PreferredMetadataLanguage = stored.PreferredMetadataLanguage;
            cached.PreferredMetadataCountryCode = stored.PreferredMetadataCountryCode;
            cached.IsLocked = stored.IsLocked;
            cached.LockedFields = (stored.LockedFields ?? Array.Empty<MetadataField>()).ToArray();
            cached.Genres = (stored.Genres ?? Array.Empty<string>()).ToArray();
            cached.Studios = (stored.Studios ?? Array.Empty<string>()).ToArray();
            cached.Tags = (stored.Tags ?? Array.Empty<string>()).ToArray();
            cached.ProductionLocations = (stored.ProductionLocations ?? Array.Empty<string>()).ToArray();
            cached.ProviderIds = new Dictionary<string, string>(stored.ProviderIds ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);
            cached.ImageInfos = (stored.ImageInfos ?? Array.Empty<ItemImageInfo>()).ToArray();
            cached.OwnerUserId = stored.OwnerUserId;
            cached.OpenAccess = stored.OpenAccess;
            cached.Shares = (stored.Shares ?? Array.Empty<PlaylistUserPermissions>()).ToArray();
        }

        private static ReadyPlaylistInfo? Info(Playlist? p)
            => p == null ? null : new ReadyPlaylistInfo(p.Id, p.OwnerUserId, p.OpenAccess, p.Shares?.Count() ?? 0,
                string.IsNullOrEmpty(p.Path) ? string.Empty : Path.GetFileName(p.Path.TrimEnd('/', '\\')), p.Name ?? string.Empty,
                new DateTimeOffset(DateTime.SpecifyKind(p.DateCreated, DateTimeKind.Utc)));
    }
}
