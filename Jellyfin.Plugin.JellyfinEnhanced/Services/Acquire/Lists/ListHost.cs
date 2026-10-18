using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
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
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Playlists;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
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
    /// <param name="SortName">Jellyfin's sort name (forced sort name, or the name without leading articles); null when unknown.</param>
    /// <param name="CreatedAt">When Jellyfin created the list (UTC); null when unknown.</param>
    public sealed record ListInfo(Guid Id, string Kind, string Name, Guid OwnerId, bool OpenAccess, IReadOnlyList<ListShare> Shares, string? SortName = null, DateTime? CreatedAt = null);

    /// <summary>The facts JE needs about a library item.</summary>
    /// <param name="Id">Item id.</param>
    /// <param name="Kind">Jellyfin item kind.</param>
    public sealed record LibraryItemInfo(Guid Id, BaseItemKind Kind);

    /// <summary>A physical video source and the library item that plays that exact file (never its HD representative).</summary>
    /// <param name="ItemId">Backing playable item id.</param>
    /// <param name="SourceId">Jellyfin media-source id.</param>
    /// <param name="Width">Source video width.</param>
    /// <param name="Height">Source video height.</param>
    /// <param name="Playable">A real source with video and a playable backing item.</param>
    public sealed record ListMediaSource(Guid ItemId, string SourceId, int? Width, int? Height, bool Playable);

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
    /// <see cref="JellyfinListHost"/>, the only place with Jellyfin-version differences.
    /// </summary>
    public interface IListHost
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

        /// <summary>
        /// Whether a library item has a playable 4K source (at least 3200 pixels wide or 2000 high), including alternates.
        /// Availability for a viewer and a scope goes through <see cref="ListEditionAvailability"/> instead.
        /// </summary>
        /// <param name="itemId">Item.</param>
        /// <returns>Whether it is a 4K copy.</returns>
        bool IsFourK(Guid itemId);

        /// <summary>Physical video sources, including alternate versions, with their exact playable backing item ids.</summary>
        /// <param name="itemId">Movie or episode (may be a presentation representative).</param>
        /// <returns>Sources; no source is inferred from a folder, arr ownership or a virtual item.</returns>
        IReadOnlyList<ListMediaSource> GetMediaSources(Guid itemId);

        /// <summary>Basic facts of a library item.</summary>
        /// <param name="itemId">Item.</param>
        /// <returns>Facts, or null when it doesn't exist.</returns>
        LibraryItemInfo? GetItem(Guid itemId);

        /// <summary>A library movie with this TMDB id that every given user can access.</summary>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="users">Users that must all have access.</param>
        /// <returns>The item id or null.</returns>
        Guid? FindMovieByTmdb(int tmdbId, IReadOnlyList<User> users);

        /// <summary>Adds items to a playlist (jf12: at a raw position; jf10: appended, position ignored), as the grant's user (the owner).</summary>
        /// <param name="write">The gate's grant for this insert (<see cref="ListWriteKind.Insert"/>).</param>
        /// <param name="itemIds">Items in order.</param>
        /// <param name="rawPosition">Raw LinkedChildren position (null = append).</param>
        /// <returns>A task.</returns>
        Task AddToPlaylistAsync(ListWrite write, IReadOnlyList<Guid> itemIds, int? rawPosition);

        /// <summary>Moves the FIRST copy of an item to a visible-row index (Jellyfin <c>MoveItemAsync</c>), as the grant's user.</summary>
        /// <param name="write">The gate's grant for this move (<see cref="ListWriteKind.Move"/> or <see cref="ListWriteKind.Place"/>).</param>
        /// <param name="itemId">Item.</param>
        /// <param name="newIndex">Index among rows visible to the grant's user.</param>
        /// <returns>A task.</returns>
        Task MoveInPlaylistAsync(ListWrite write, Guid itemId, int newIndex);

        /// <summary>Adds items to a collection (already de-duplicated by the caller).</summary>
        /// <param name="write">The gate's grant for this add (<see cref="ListWriteKind.CollectionAdd"/>).</param>
        /// <param name="itemIds">Items.</param>
        /// <returns>A task.</returns>
        Task AddToCollectionAsync(ListWrite write, IReadOnlyList<Guid> itemIds);

        /// <summary>
        /// Creates an empty video playlist owned by the grant's user, with no shares. Jellyfin keeps it in a folder named
        /// after <paramref name="name"/> (made unique), so a create under a name carrying its operation's marker
        /// (<see cref="ListService.CreateName"/>) is found again by <see cref="FindCreated"/>.
        /// </summary>
        /// <param name="write">The gate's grant for this create.</param>
        /// <param name="name">Name (the one carrying the marker).</param>
        /// <param name="isPublic">Open access.</param>
        /// <returns>The new id.</returns>
        Task<Guid> CreatePlaylistAsync(ListWrite write, string name, bool isPublic);

        /// <summary>
        /// Creates an empty collection carrying <paramref name="marker"/> in the same write (a provider id). Jellyfin puts it
        /// at "<c>collections folder/name [boxset]</c>" and replaces whatever collection is there: create it under a name
        /// no other collection has (<see cref="ListService.CreateName"/>, which carries the marker).
        /// </summary>
        /// <param name="write">The gate's grant for this create.</param>
        /// <param name="name">Name (the one carrying the marker).</param>
        /// <param name="marker">The create operation's marker.</param>
        /// <returns>The new id.</returns>
        Task<Guid> CreateCollectionAsync(ListWrite write, string name, Guid marker);

        /// <summary>
        /// Gives a list JE created its chosen name (it was created under the one carrying its marker); the list keeps its
        /// folder. As the grant's user (a playlist's owner). Saves every time it is called, whatever the cached item shows;
        /// when the save fails the cached item gets its old name back only while it still has JE's chosen name.
        /// </summary>
        /// <param name="write">The gate's grant (<see cref="ListWriteKind.FinishCreate"/>).</param>
        /// <param name="name">The chosen name.</param>
        /// <returns>A task.</returns>
        Task FinishCreateAsync(ListWrite write, string name);

        /// <summary>
        /// The list a create with this marker made: the owner's playlist whose folder carries the marker, or the collection
        /// with the marker's provider id; null when there is none.
        /// </summary>
        /// <param name="kind">List kind.</param>
        /// <param name="marker">The create operation's marker.</param>
        /// <param name="ownerId">The person who created it (playlists must be theirs).</param>
        /// <returns>The list, or null.</returns>
        ListInfo? FindCreated(string kind, Guid marker, Guid ownerId);

        /// <summary>
        /// Where Jellyfin's create of a collection of this name would put it: the full, normalised path of
        /// "<c>name [boxset]</c>" in Jellyfin's own collections folder (made when there is none yet, as the create would).
        /// Null when that folder can't be had.
        /// </summary>
        /// <param name="name">Name.</param>
        /// <returns>The destination, or null.</returns>
        Task<string?> CollectionDestinationAsync(string name);

        /// <summary>
        /// Whether a collection already has this destination (<see cref="CollectionDestinationAsync"/>): its folder exists, or a
        /// collection in Jellyfin's collections folder is kept there or is named so it would be. Compared without case.
        /// A <c>[boxset]</c> folder anywhere else (some library's own) never takes a name.
        /// </summary>
        /// <param name="destination">The destination.</param>
        /// <returns>Whether the name is taken.</returns>
        bool CollectionNameTaken(string destination);

        /// <summary>Every playlist on the server (unfiltered; callers apply access rules).</summary>
        /// <returns>Playlists.</returns>
        IReadOnlyList<ListInfo> GetAllPlaylists();

        /// <summary>Collections the user can see.</summary>
        /// <param name="user">User.</param>
        /// <returns>Collections.</returns>
        IReadOnlyList<ListInfo> GetVisibleCollections(User user);

        /// <summary>Every collection on the server (unfiltered; callers apply access rules).</summary>
        /// <returns>Collections.</returns>
        IReadOnlyList<ListInfo> GetAllCollections();

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

    /// <summary>The production <see cref="IListHost"/> over Jellyfin's library, playlist and collection managers.</summary>
    public sealed class JellyfinListHost : IListHost
    {
        /// <summary>The provider id key a collection JE creates carries its create operation's marker under.</summary>
        public const string CreateMarkerKey = "JellyfinEnhancedCreate";

        private readonly ILibraryManager _libraryManager;
        private readonly IPlaylistManager _playlistManager;
        private readonly ICollectionManager _collectionManager;
        private readonly IFileSystem _fileSystem;

        /// <summary>Creates the host.</summary>
        /// <param name="libraryManager">Library manager.</param>
        /// <param name="playlistManager">Playlist manager.</param>
        /// <param name="collectionManager">Collection manager.</param>
        /// <param name="fileSystem">File system (Jellyfin's file-name rules for collection folders).</param>
        public JellyfinListHost(ILibraryManager libraryManager, IPlaylistManager playlistManager, ICollectionManager collectionManager, IFileSystem fileSystem)
        {
            _libraryManager = libraryManager;
            _playlistManager = playlistManager;
            _collectionManager = collectionManager;
            _fileSystem = fileSystem;
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
        public bool IsFourK(Guid itemId) => GetMediaSources(itemId).Any(s => s.Playable && (s.Width >= 3200 || s.Height >= 2000));

        /// <inheritdoc />
        public IReadOnlyList<ListMediaSource> GetMediaSources(Guid itemId)
        {
            if (_libraryManager.GetItemById(itemId) is not Video video || video.IsVirtualItem)
            {
                return Array.Empty<ListMediaSource>();
            }

            var result = new List<ListMediaSource>();
            foreach (var source in video.GetMediaSources(false))
            {
                var backing = Guid.TryParse(source.Id, out var id) ? _libraryManager.GetItemById(id) : null;
                if (backing == null && !string.IsNullOrEmpty(source.Path))
                {
                    backing = string.Equals(source.Path, video.Path, StringComparison.Ordinal)
                        ? video
                        : _libraryManager.FindByPath(source.Path, null);
                }

                // A source's dimensions may never be attributed to a different file. Without its backing item lists
                // cannot select this edition for playback, so it is unavailable until Jellyfin can resolve it.
                if (backing is not Video actual || actual.IsVirtualItem || string.IsNullOrEmpty(source.Path)
                    || !string.Equals(actual.Path, source.Path, StringComparison.Ordinal)) continue;
                var stream = source.MediaStreams?.FirstOrDefault(s => s.Type == MediaStreamType.Video);
                result.Add(new ListMediaSource(actual.Id, source.Id, stream?.Width, stream?.Height,
                    stream != null && (source.SupportsDirectPlay || source.SupportsDirectStream || source.SupportsTranscoding)));
            }

            return result;
        }

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
        public Task AddToPlaylistAsync(ListWrite write, IReadOnlyList<Guid> itemIds, int? rawPosition)
        {
            write.Spend(write.ListId, ListWriteKind.Insert);
#if JF12
            return _playlistManager.AddItemToPlaylistAsync(write.ListId, itemIds.ToArray(), rawPosition, write.ActAs);
#else
            return _playlistManager.AddItemToPlaylistAsync(write.ListId, itemIds.ToArray(), write.ActAs);
#endif
        }

        /// <inheritdoc />
        public Task MoveInPlaylistAsync(ListWrite write, Guid itemId, int newIndex)
        {
            write.Spend(write.ListId, ListWriteKind.Move);
            return _playlistManager.MoveItemAsync(
                write.ListId.ToString("N", System.Globalization.CultureInfo.InvariantCulture),
                itemId.ToString("N", System.Globalization.CultureInfo.InvariantCulture),
                newIndex,
                write.ActAs);
        }

        /// <inheritdoc />
        public Task AddToCollectionAsync(ListWrite write, IReadOnlyList<Guid> itemIds)
        {
            write.Spend(write.ListId, ListWriteKind.CollectionAdd);
            return _collectionManager.AddToCollectionAsync(write.ListId, itemIds.Distinct().ToArray());
        }

        /// <inheritdoc />
        public async Task<Guid> CreatePlaylistAsync(ListWrite write, string name, bool isPublic)
        {
            write.Spend(Guid.Empty, ListWriteKind.Create);
            var result = await ListContinuation.Await(() => _playlistManager.CreatePlaylist(new PlaylistCreationRequest
            {
                Name = name,
                UserId = write.ActAs,
                // An empty playlist can't infer its media type and would default to Audio.
                MediaType = MediaType.Video,
                Public = isPublic,
                // No shares: Jellyfin hands a deleted owner's playlist to its first share, so none may stand for nobody.
                Users = Array.Empty<PlaylistUserPermissions>(),
            })).ConfigureAwait(false);
            return Guid.Parse(result.Id);
        }

        /// <inheritdoc />
        public async Task<Guid> CreateCollectionAsync(ListWrite write, string name, Guid marker)
        {
            write.Spend(Guid.Empty, ListWriteKind.Create);
            var options = new CollectionCreationOptions
            {
                Name = name,
                IsLocked = false,
            };
            // Saved with the collection itself (one write).
            options.ProviderIds[CreateMarkerKey] = marker.ToString("N", System.Globalization.CultureInfo.InvariantCulture);
            var boxSet = await ListContinuation.Await(() => _collectionManager.CreateCollectionAsync(options)).ConfigureAwait(false);
            return boxSet.Id;
        }

        /// <inheritdoc />
        public async Task FinishCreateAsync(ListWrite write, string name)
        {
            write.Spend(write.ListId, ListWriteKind.FinishCreate);
            // Always saved, also when the cached item already shows the name: Jellyfin changes the cached item before it
            // saves it, so an earlier failed save can leave the name showing with nothing kept. When the save fails, the
            // cached item gets its old name back.
            switch (_libraryManager.GetItemById(write.ListId))
            {
                case Playlist playlist:
                    var playlistName = playlist.Name;
                    try
                    {
                        await ListContinuation.Await(() => _playlistManager.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlist.Id, UserId = write.ActAs, Name = name })).ConfigureAwait(false);
                    }
                    catch
                    {
                        if (string.Equals(playlist.Name, name, StringComparison.Ordinal)) playlist.Name = playlistName;
                        throw;
                    }

                    break;
                case BoxSet boxSet:
                    // BaseItem.UpdateToRepositoryAsync, with the parent read through the library manager: saved with its
                    // metadata (collection.xml), so the name stays through scans and refreshes.
                    var boxSetName = boxSet.Name;
                    boxSet.Name = name;
                    try
                    {
                        var parent = boxSet.ParentId.Equals(Guid.Empty) ? null : _libraryManager.GetItemById(boxSet.ParentId);
                        await ListContinuation.Await(() => _libraryManager.UpdateItemAsync(boxSet, parent!, ItemUpdateType.MetadataEdit, CancellationToken.None)).ConfigureAwait(false);
                    }
                    catch
                    {
                        if (string.Equals(boxSet.Name, name, StringComparison.Ordinal)) boxSet.Name = boxSetName;
                        throw;
                    }

                    break;
            }
        }

        /// <summary>
        /// The create marker a list item carries (a collection's provider id, a playlist's folder name from
        /// <see cref="ListService.CreateName"/>), read from the item itself: also from a removed one, which no lookup finds.
        /// </summary>
        /// <param name="item">The playlist or collection.</param>
        /// <returns>The marker, or null.</returns>
        internal static Guid? CreateMarkerOf(BaseItem item)
        {
            if (item.ProviderIds != null && item.ProviderIds.TryGetValue(CreateMarkerKey, out var value) && Guid.TryParseExact(value, "N", out var marker))
            {
                return marker;
            }

            var folder = Path.GetFileName(Trimmed(item.Path ?? string.Empty));
            var matches = System.Text.RegularExpressions.Regex.Matches(folder, @"\(([0-9a-fA-F]{32})\)");
            return matches.Count > 0 && Guid.TryParseExact(matches[^1].Groups[1].Value, "N", out marker) ? marker : null;
        }

        /// <inheritdoc />
        public ListInfo? FindCreated(string kind, Guid marker, Guid ownerId)
        {
            var value = marker.ToString("N", System.Globalization.CultureInfo.InvariantCulture);
            if (kind == ListKinds.Playlist)
            {
                // The folder Jellyfin made from the name the create used (ListService.CreateName), never renamed.
                return _libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.Playlist }, Recursive = true })
                    .OfType<Playlist>()
                    .Where(p => (ownerId == Guid.Empty || p.OwnerUserId == ownerId) && !string.IsNullOrEmpty(p.Path) && Path.GetFileName(Trimmed(p.Path)).Contains(value, StringComparison.OrdinalIgnoreCase))
                    .Select(ToInfo)
                    .OfType<ListInfo>()
                    .FirstOrDefault();
            }

            return _libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.BoxSet }, Recursive = true })
                .Where(i => i.ProviderIds != null && i.ProviderIds.TryGetValue(CreateMarkerKey, out var id) && string.Equals(id, value, StringComparison.OrdinalIgnoreCase))
                .Select(ToInfo)
                .OfType<ListInfo>()
                .FirstOrDefault();
        }

        /// <inheritdoc />
        public async Task<string?> CollectionDestinationAsync(string name)
        {
            // CollectionManager.CreateCollectionAsync: "<collections folder>/<valid file name> [boxset]".
            var folder = await ListContinuation.Await(() => _collectionManager.GetCollectionsFolder(true)).ConfigureAwait(false);
            return string.IsNullOrEmpty(folder?.Path) ? null : Normalised(Path.Combine(folder.Path, _fileSystem.GetValidFilename(name) + " [boxset]"));
        }

        /// <inheritdoc />
        public bool CollectionNameTaken(string destination)
        {
            // Compared without case, so a name that differs only in case is refused too (some file systems fold case).
            var root = Path.GetDirectoryName(destination);
            var folder = Path.GetFileName(destination);
            if (_fileSystem.DirectoryExists(destination))
            {
                return true; // a collection being made (Jellyfin makes the folder first) or left behind
            }

            return _libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.BoxSet }, Recursive = true })
                .Any(i => !string.IsNullOrEmpty(i.Path)
                    && string.Equals(Path.GetDirectoryName(Normalised(i.Path)), root, StringComparison.OrdinalIgnoreCase)
                    && (string.Equals(Path.GetFileName(Normalised(i.Path)), folder, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(_fileSystem.GetValidFilename(i.Name ?? string.Empty) + " [boxset]", folder, StringComparison.OrdinalIgnoreCase)));
        }

        private static string Trimmed(string path) => path.TrimEnd('/', '\\');

        private static string Normalised(string path) => Trimmed(Path.GetFullPath(path));

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
        public IReadOnlyList<ListInfo> GetAllCollections() =>
            _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.BoxSet },
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
                .Where(e => e.ParentIndexNumber.HasValue && e.IndexNumber.HasValue && !e.IsVirtualItem && e.SeriesId != Guid.Empty)
                .Select(e => new LibraryEpisode(e.Id, e.SeriesId, e.ParentIndexNumber!.Value, e.IndexNumber!.Value, e.IndexNumberEnd))
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
            // A presentation representative is not the whole physical show. All sibling folders and their own
            // episodes must remain candidates; the edition helper deduplicates only after checking every source.
            query.GroupByPresentationUniqueKey = false;
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

        private static DateTime? Utc(DateTime created) => created == default ? null : DateTime.SpecifyKind(created, DateTimeKind.Utc);

        private static ListInfo? ToInfo(BaseItem? item) => item switch
        {
            Playlist playlist => new ListInfo(
                playlist.Id,
                ListKinds.Playlist,
                playlist.Name ?? string.Empty,
                playlist.OwnerUserId,
                playlist.OpenAccess,
                (playlist.Shares ?? Array.Empty<PlaylistUserPermissions>()).Select(s => new ListShare(s.UserId, s.CanEdit)).ToList(),
                playlist.SortName,
                Utc(playlist.DateCreated)),
            BoxSet boxSet => new ListInfo(boxSet.Id, ListKinds.Collection, boxSet.Name ?? string.Empty, Guid.Empty, false, Array.Empty<ListShare>(), boxSet.SortName, Utc(boxSet.DateCreated)),
            _ => null,
        };
    }
}
