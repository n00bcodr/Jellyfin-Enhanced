using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
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
        /// Makes a private video playlist of the owner's, shared with nobody, named <paramref name="name"/>, carrying JE's
        /// <paramref name="nonce"/> from its creation on, if <paramref name="gate"/> allows it. Returns what the create itself
        /// made (its id and creation second, observed inside the create call before Jellyfin's refresh), or why nothing is
        /// JE's: <c>provenance</c> when the create's own playlist couldn't be observed (nothing of it is JE's).
        /// </summary>
        Task<(ReadyCreated? Made, string? Refused)> CreateAsync(Guid ownerId, string name, string nonce, ReadyGate gate);

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
    /// What JE's own create made, as the create call itself showed it (never a later lookup by id): the id Jellyfin gave the
    /// playlist and its creation time to the whole second, taken from the very playlist object the create allocated, before
    /// Jellyfin's refresh saves it again.
    /// </summary>
    /// <param name="Id">The playlist's id (Jellyfin's create result, checked against the object it allocated).</param>
    /// <param name="CreatedSecond">Its creation time as the create set it (its folder's creation time), UTC Unix seconds.</param>
    public sealed record ReadyCreated(Guid Id, long CreatedSecond);

    /// <summary>
    /// The production <see cref="IReadyPlaylistHost"/> over Jellyfin's playlist and library managers. Reads go to what Jellyfin
    /// stored (its repository), not its cached instance: Jellyfin's own share, publish and rename materialize another
    /// instance and save it, leaving the cached one as it was. Its membership update saves the whole cached instance, so
    /// right before one the cached instance's metadata JE doesn't own (name, shares, privacy, owner and the rest the person
    /// may edit) is set from the stored one (heal-then-write, D49): a membership write never undoes the person's change.
    /// After the heal the latest stored playlist goes through the whole gate again: when it is no longer the one the gate passed
    /// (another nonce, creation time or owner: deleted and made again with the same id in between), or its privacy, shares or
    /// name changed in between, nothing is written.
    /// </summary>
    /// <remarks>
    /// Provenance at the create (4f round 6): Jellyfin's create returns only an id, and a playlist made again under the same
    /// folder gets the same id, so a later read can't tell JE's playlist from one put in its place. But Jellyfin raises
    /// <see cref="ILibraryManager.ItemAdded"/> synchronously inside <see cref="IPlaylistManager.CreatePlaylist"/>, with the very
    /// playlist object the create allocated, before the create's own metadata refresh saves it again (12.2 and 10.11.11: no
    /// await before <c>Folder.AddChild</c>; probed live). While JE's create call runs, and only on its own call path, the host
    /// takes that object's id and creation second and writes JE's nonce into it, so Jellyfin's own save of the created
    /// playlist stores the nonce with it: a playlist anyone makes in its place, in any second, carries no nonce. No such
    /// event, a second one, or one for another id: nothing of it is JE's.
    /// </remarks>
    public sealed class JellyfinReadyPlaylistHost : IReadyPlaylistHost, IDisposable
    {
        /// <summary>
        /// What JE's per-binding nonce is stored under: the playlist item's <c>ExternalId</c> (a plain column of Jellyfin's
        /// item table, used by Jellyfin only for channel items), as this prefix and the nonce. No Jellyfin route, item
        /// editor or DTO reads or sets it, so a person can neither see nor forge it, and Jellyfin's own playlist saves keep
        /// it: they save an instance read with a partial field set (12.2 and 10.11 re-read the playlist with
        /// <c>DtoOptions(allFields: false)</c> in UpdatePlaylist), which always maps the item's columns but leaves out its
        /// provider ids, and the save then deletes the provider ids it didn't load (seen live on 12.2).
        /// </summary>
        public const string NoncePrefix = "jellyfin-enhanced-ready:";

        // The create JE's own call path is inside (a value flows only along that call path: another request's create never sees it).
        private static readonly AsyncLocal<CreateScope?> Creating = new();

        private readonly ILibraryManager _library;
        private readonly IPlaylistManager _playlists;
        private readonly IFileSystem _fileSystem;

        /// <summary>Creates the host (DI).</summary>
        public JellyfinReadyPlaylistHost(ILibraryManager library, IPlaylistManager playlists, IFileSystem fileSystem)
        {
            _library = library;
            _playlists = playlists;
            _fileSystem = fileSystem;
            _library.ItemAdded += OnItemAdded;
        }

        /// <inheritdoc />
        public void Dispose() => _library.ItemAdded -= OnItemAdded;

        /// <summary>One create of JE's while its call into Jellyfin runs: what it expects and what it saw.</summary>
        internal sealed class CreateScope
        {
            internal CreateScope(Guid owner, string name, string nonce)
            {
                Owner = owner;
                Name = name;
                Nonce = nonce;
            }

            internal Guid Owner { get; }

            internal string Name { get; }

            internal string Nonce { get; }

            /// <summary>False once JE's call into Jellyfin returned its task: later events are never this create's.</summary>
            internal bool Open { get; set; } = true;

            /// <summary>How many playlists matching this create were added on its call path (exactly one, or nothing is JE's).</summary>
            internal int Matches { get; set; }

            internal Guid Id { get; set; }

            internal long CreatedSecond { get; set; }
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e) => Observe(Creating.Value, e.Item);

        /// <summary>
        /// The create's own playlist as Jellyfin added it, on JE's call path, synchronously and before the create's refresh: its
        /// id and creation second are taken, and JE's nonce is written into that object (the refresh then saves it with it).
        /// Anything else (no create of JE's running here, another item, owner or name) is left alone.
        /// </summary>
        internal static void Observe(CreateScope? scope, BaseItem? item)
        {
            if (scope is not { Open: true } || item is not Playlist playlist || playlist.OwnerUserId != scope.Owner
                || !string.Equals(playlist.Name, scope.Name, StringComparison.Ordinal)) return;
            if (++scope.Matches > 1) return;
            scope.Id = playlist.Id;
            scope.CreatedSecond = new DateTimeOffset(DateTime.SpecifyKind(playlist.DateCreated, DateTimeKind.Utc)).ToUnixTimeSeconds();
            playlist.ExternalId = NoncePrefix + scope.Nonce;
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
        public async Task<(ReadyCreated? Made, string? Refused)> CreateAsync(Guid ownerId, string name, string nonce, ReadyGate gate)
        {
            if (gate(null) is { } refused) return (null, refused);
            var scope = new CreateScope(ownerId, name, nonce);
            Task<PlaylistCreationResult> creating;
            var outer = Creating.Value;
            Creating.Value = scope;
            try
            {
                // Jellyfin adds the playlist (and raises ItemAdded) synchronously in this call, before its first await.
                creating = _playlists.CreatePlaylist(new PlaylistCreationRequest
                {
                    Name = name,
                    UserId = ownerId,
                    // An empty playlist can't infer its media type and would default to Audio.
                    MediaType = MediaType.Video,
                    Public = false,
                    // No shares: Jellyfin hands a deleted owner's playlist to its first share.
                    Users = Array.Empty<PlaylistUserPermissions>(),
                });
            }
            finally
            {
                scope.Open = false;
                Creating.Value = outer;
            }

            var result = await creating.ConfigureAwait(false);
            var id = Guid.Parse(result.Id);
            return scope.Matches == 1 && scope.Id == id ? (new ReadyCreated(id, scope.CreatedSecond), null) : (null, "provenance");
        }

        /// <inheritdoc />
        public async Task<string?> RenameAsync(Guid playlistId, Guid ownerId, string name, ReadyGate gate)
        {
            if (Checked(playlistId, gate, out _) is { } refused) return refused;
            await _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlistId, UserId = ownerId, Name = name }).ConfigureAwait(false);
            return null;
        }

        /// <inheritdoc />
        public async Task<string?> SetAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, Guid ownerId, ReadyGate gate)
        {
            if (Checked(playlistId, gate, out _) is { } refused) return refused;
            await _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlistId, UserId = ownerId, Ids = itemIds.ToArray() }).ConfigureAwait(false);
            return null;
        }

        /// <inheritdoc />
        public Task<string?> DeleteAsync(Guid playlistId, ReadyGate gate)
        {
            var refused = Checked(playlistId, gate, out var cached);
            if (refused != null || cached == null) return Task.FromResult<string?>(refused ?? "missing");
            _library.DeleteItem(cached, new DeleteOptions { DeleteFileLocation = true }, true);
            return Task.FromResult<string?>(null);
        }

        // The stored playlist through the gate, then the cached instance healed from it, then the latest stored playlist through
        // the WHOLE gate again (owner, privacy, shares, JE's nonce, creation second and the caller's own conditions): it and the
        // healed instance Jellyfin is about to save must still be the playlist the gate passed, with the owner, privacy, shares
        // and name the heal gave the instance (a change in between would be undone by the save: nothing is written, the next
        // look sees it). Nothing awaited in between, and the caller calls Jellyfin right after. Jellyfin has no conditional
        // save: a native edit landing inside its own save is a Jellyfin limitation (D49).
        private string? Checked(Guid playlistId, ReadyGate gate, out Playlist? cached)
        {
            cached = null;
            var stored = Stored(playlistId);
            var passed = Info(stored);
            if (gate(passed) is { } refused) return refused;
            if (_library.GetItemById(playlistId) is not Playlist live || stored == null || passed == null) return "missing";
            Heal(stored, live);
            var again = Info(Stored(playlistId));
            if (gate(again) is { } late) return late;
            if (again == null) return "missing";
            if (!SameItem(passed, again) || !SameItem(passed, Info(live)!)) return "identity";
            if (!SameState(passed, again)) return "changed";
            cached = live;
            return null;
        }

        private static bool SameItem(ReadyPlaylistInfo a, ReadyPlaylistInfo b)
            => a.Id == b.Id && a.OwnerId == b.OwnerId && string.Equals(a.Nonce, b.Nonce, StringComparison.Ordinal) && a.CreatedSecond == b.CreatedSecond
               && string.Equals(a.FolderName, b.FolderName, StringComparison.OrdinalIgnoreCase);

        // What the heal copied that the person can change: an instance healed from an older read would undo it on save.
        private static bool SameState(ReadyPlaylistInfo a, ReadyPlaylistInfo b)
            => a.OpenAccess == b.OpenAccess && a.ShareCount == b.ShareCount && string.Equals(a.Name, b.Name, StringComparison.Ordinal);

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
            cached.ExternalId = stored.ExternalId;
            cached.OwnerUserId = stored.OwnerUserId;
            cached.OpenAccess = stored.OpenAccess;
            cached.Shares = (stored.Shares ?? Array.Empty<PlaylistUserPermissions>()).ToArray();
        }

        private static ReadyPlaylistInfo? Info(Playlist? p)
            => p == null ? null : new ReadyPlaylistInfo(p.Id, p.OwnerUserId, p.OpenAccess, p.Shares?.Count() ?? 0,
                string.IsNullOrEmpty(p.Path) ? string.Empty : Path.GetFileName(p.Path.TrimEnd('/', '\\')), p.Name ?? string.Empty,
                new DateTimeOffset(DateTime.SpecifyKind(p.DateCreated, DateTimeKind.Utc)),
                p.ExternalId is { } external && external.StartsWith(NoncePrefix, StringComparison.Ordinal) && external.Length > NoncePrefix.Length ? external[NoncePrefix.Length..] : null);
    }
}
