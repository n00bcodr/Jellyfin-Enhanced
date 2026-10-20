using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>What JE knows about a list's current Primary image and the collage closed PR #936 drew into it.</summary>
    public enum LegacyCollageVerdict
    {
        /// <summary>No collage marker for the list: the image is the host's business.</summary>
        NoEvidence = 0,

        /// <summary>The list has a marker but no Primary image.</summary>
        NoImage = 1,

        /// <summary>The image's content is none the marker recorded: an image set after the collage. Served as usual.</summary>
        Superseded = 2,

        /// <summary>The image's content is the collage the marker recorded. Withheld.</summary>
        Collage = 3,

        /// <summary>The marker or the image couldn't be read or understood. Treated as the collage: withheld.</summary>
        Unreadable = 4,
    }

    /// <summary>
    /// Closed PR #936 drew a collage of member posters into a list's native Primary image and recorded it in a marker
    /// (<c>list-placeholders/collages/&lt;listIdN&gt;.json</c>, copied by <see cref="ExperimentalListImporter"/> to
    /// <c>lists/legacy-collages/</c>). Those posters were chosen once, for nobody in particular, so they can be ones a
    /// viewer has hidden since or that Spoiler Guard covers. Until per-viewer collages exist, a list whose current
    /// Primary is that collage gets none of it anywhere (the image, its sizes and validators, DTO tags, blur hashes,
    /// aspect ratio, image info and path), and neither do the playlist/collection library tiles the host composed from
    /// list images while one was a collage. No image or marker is ever deleted, rewritten or adopted: the host answers
    /// as it does for an item without that image.
    /// <list type="bullet">
    /// <item>Proof is content, judged afresh on every answer: the current file's SHA-256 against the hashes a marker for
    /// that list id recorded (the saved and the pending one, each exactly 64 lowercase hex characters). Nothing judged is
    /// kept beyond the answer, so a file that changes (even back to the same size and time) is judged again.</item>
    /// <item>Absence is a listing: a marker folder's markers come from a listing taken now; a folder that can't be opened
    /// counts as absent only when its parent lists without it. Anything JE can't list, read or understand counts as the
    /// collage (fail closed).</item>
    /// <item>A library tile built while a list of its kind was a collage stays withheld until the host regenerates it
    /// (<see cref="LegacyCollageTiles"/>, kept across restarts).</item>
    /// </list>
    /// Each answer, WebSocket message or image request gets its own <see cref="LegacyCollageView"/>.
    /// </summary>
    public sealed class LegacyCollageWithhold
    {
        /// <summary>Largest marker read; a bigger one is not #936's and counts as unreadable.</summary>
        public const long MaxMarkerBytes = 64 * 1024;

        /// <summary>JE's record of the library tiles it has seen built from a collage (in the importer's <c>lists</c> folder).</summary>
        public const string TileStateFileName = "legacy-collage-tiles.json";

        private const string MarkerExtension = ".json";

        private static readonly EnumerationOptions ListingOptions = new()
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = false,
            AttributesToSkip = 0,
            ReturnSpecialDirectories = false,
            MatchType = MatchType.Simple,
        };

        /// <summary>How long a folder's listing is reused while its modification time is unchanged.</summary>
        internal static readonly TimeSpan ListingReuse = TimeSpan.FromSeconds(2);

        private readonly string[] _markerDirectories;
        private readonly Dictionary<string, (DateTime Written, long Taken, string[] Names)> _listings = new(StringComparer.Ordinal);

        /// <summary>Creates the owner (DI): markers in Jellyfin Enhanced's configuration folder.</summary>
        /// <param name="appPaths">Jellyfin application paths.</param>
        /// <param name="libraryManager">Library (list lookups).</param>
        /// <param name="logger">JE logger.</param>
        public LegacyCollageWithhold(IApplicationPaths appPaths, ILibraryManager libraryManager, Logger logger)
            : this(MarkerDirectories(Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced")), libraryManager, () => DateTime.UtcNow, logger.Warning)
        {
        }

        /// <summary>Creates the owner over explicit marker folders (tests).</summary>
        /// <param name="markerDirectories">Folders holding <c>&lt;listIdN&gt;.json</c> markers; the first one's parent holds the tile record.</param>
        /// <param name="libraryManager">Library (list lookups).</param>
        internal LegacyCollageWithhold(IReadOnlyList<string> markerDirectories, ILibraryManager libraryManager)
            : this(markerDirectories, libraryManager, () => DateTime.UtcNow, null)
        {
        }

        /// <summary>Creates the owner over explicit marker folders and clock (tests).</summary>
        /// <param name="markerDirectories">Folders holding <c>&lt;listIdN&gt;.json</c> markers; the first one's parent holds the tile record.</param>
        /// <param name="libraryManager">Library (list lookups).</param>
        /// <param name="utcNow">Clock.</param>
        /// <param name="warn">Warning sink.</param>
        internal LegacyCollageWithhold(IReadOnlyList<string> markerDirectories, ILibraryManager libraryManager, Func<DateTime> utcNow, Action<string>? warn)
        {
            _markerDirectories = markerDirectories.ToArray();
            Library = libraryManager;
            Tiles = new LegacyCollageTiles(Path.Combine(Path.GetDirectoryName(_markerDirectories[0])!, TileStateFileName), utcNow, warn);
        }

        internal ILibraryManager Library { get; }

        internal LegacyCollageTiles Tiles { get; }

        /// <summary>
        /// The marker folders under Jellyfin Enhanced's configuration folder: the importer's copies, and #936's originals
        /// (still there when the import wasn't run, or a copy failed).
        /// </summary>
        /// <param name="pluginConfigDirectory">Jellyfin Enhanced's configuration folder.</param>
        /// <returns>The folders.</returns>
        public static IReadOnlyList<string> MarkerDirectories(string pluginConfigDirectory) => new[]
        {
            Path.Combine(pluginConfigDirectory, ListStore.DirectoryName, ListStore.LegacyCollagesFolder),
            Path.Combine(pluginConfigDirectory, ExperimentalListImporter.SourceFolderName, "collages"),
        };

        /// <summary>A view for one answer, message or request: the marker folders as listed now, every judgement made once.</summary>
        /// <returns>The view.</returns>
        public LegacyCollageView Begin() => new(this, Listing());

        /// <summary>True when the marker folders were listed now and hold no marker (tile records aside).</summary>
        /// <returns>Whether no marker exists.</returns>
        public bool NoMarkers() => Listing() is { Count: 0 };

        /// <summary>Classifies the list's current Primary image (any other item: <see cref="LegacyCollageVerdict.NoEvidence"/>).</summary>
        /// <param name="item">The item.</param>
        /// <returns>The verdict.</returns>
        public LegacyCollageVerdict Classify(BaseItem item) => Begin().Classify(item);

        /// <summary>True when the item's image of that type must be withheld (see <see cref="LegacyCollageView.Withholds"/>).</summary>
        /// <param name="item">The item.</param>
        /// <param name="type">Image type.</param>
        /// <returns>Whether to withhold it.</returns>
        public bool Withholds(BaseItem item, ImageType type) => Begin().Withholds(item, type);

        /// <summary>True when the list with this id currently withholds its Primary image.</summary>
        /// <param name="listId">List id.</param>
        /// <returns>Whether it does.</returns>
        public bool WithholdsList(Guid listId) => Begin().List(listId);

        /// <summary>True when a list of that kind (Playlist or BoxSet) withholds its image, or the markers can't be listed.</summary>
        /// <param name="kind">List kind.</param>
        /// <returns>Whether every library tile of that kind is withheld.</returns>
        public bool AnyWithheld(BaseItemKind kind) => Begin().AnyWithheld(kind);

        /// <summary>The list kind a library tile is composed from: Playlist for playlist libraries/views, BoxSet for collections.</summary>
        /// <param name="collectionType">The folder's or view's collection type.</param>
        /// <returns>The kind, or null for any other folder.</returns>
        public static BaseItemKind? HolderKind(CollectionType? collectionType) => collectionType switch
        {
            CollectionType.playlists => BaseItemKind.Playlist,
            CollectionType.boxsets => BaseItemKind.BoxSet,
            _ => null,
        };

        /// <summary>The list kind an item's own tile is composed from (a library folder or view, never a list itself).</summary>
        /// <param name="item">The item.</param>
        /// <returns>The kind, or null.</returns>
        internal static BaseItemKind? HolderKindOf(BaseItem item)
            => item is IHasCollectionType holder and not (Playlist or BoxSet) ? HolderKind(holder.CollectionType) : null;

        internal static bool IsWithheld(LegacyCollageVerdict verdict) => verdict is LegacyCollageVerdict.Collage or LegacyCollageVerdict.Unreadable;

        /// <summary>True for exactly 64 lowercase hexadecimal characters (a SHA-256 as #936 wrote it), nothing before or after.</summary>
        /// <param name="value">Candidate.</param>
        /// <returns>Whether it is one.</returns>
        internal static bool IsHash(string? value)
        {
            if (value is not { Length: 64 })
            {
                return false;
            }

            foreach (var c in value)
            {
                if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>The list a marker file is for: exactly 32 lowercase hex characters then ".json"; any other name is no marker.</summary>
        /// <param name="fileName">The entry's name.</param>
        /// <returns>The list id, or null.</returns>
        internal static Guid? MarkerId(string fileName)
        {
            if (fileName.Length != 32 + MarkerExtension.Length || !fileName.EndsWith(MarkerExtension, StringComparison.Ordinal))
            {
                return null;
            }

            var id = fileName[..32];
            foreach (var c in id)
            {
                if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
                {
                    return null;
                }
            }

            return Guid.ParseExact(id, "N");
        }

        /// <summary>The SHA-256 of a file (lowercase hex).</summary>
        /// <param name="path">The file.</param>
        /// <returns>The hash.</returns>
        internal static string HashFile(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }

        internal static bool IsFileError(Exception ex)
            => ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or System.Security.SecurityException;

        /// <summary>
        /// True only when a listing proves the path absent: its parent was listed and names no entry of that name (a
        /// parent that isn't there either must be shown absent the same way, up to an ancestor that lists). A folder that
        /// can't be entered, read or listed proves nothing.
        /// </summary>
        /// <param name="path">The file or folder.</param>
        /// <param name="names">Lists a folder: its entry names, or null when it can't be listed.</param>
        /// <returns>Whether it is shown absent.</returns>
        internal static bool ShownAbsent(string path, Func<string, string[]?> names)
        {
            var current = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
            for (var depth = 0; depth < 64; depth++)
            {
                var parent = Path.GetDirectoryName(current);
                var name = Path.GetFileName(current);
                if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(name))
                {
                    return false;
                }

                if (names(parent) is { } entries)
                {
                    // Named there (in the platform's case rules), yet it couldn't be opened: not absent.
                    return !entries.Contains(name, OperatingSystem.IsLinux() ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase);
                }

                try
                {
                    // Directory.Exists only picks the way: a parent that is there but can't be listed proves nothing; one
                    // that isn't there (or can't be looked at) must be shown absent by its own parent's listing.
                    if (Directory.Exists(parent))
                    {
                        return false;
                    }
                }
                catch (Exception ex) when (IsFileError(ex))
                {
                    return false;
                }

                current = parent;
            }

            return false;
        }

        /// <summary>The entry names of a folder, from a listing taken now; null when it isn't a folder that can be listed.</summary>
        /// <param name="dir">The folder.</param>
        /// <returns>The names, or null.</returns>
        internal static string[]? ListNow(string dir)
        {
            try
            {
                return Directory.Exists(dir) ? Directory.EnumerateFileSystemEntries(dir, "*", ListingOptions).Select(e => Path.GetFileName(e)).ToArray() : null;
            }
            catch (Exception ex) when (IsFileError(ex))
            {
                return null;
            }
        }

        // A folder's names, from a listing reused for at most ListingReuse while the folder's modification time is the one
        // it had then, and only if that time was more than a second old when it was listed (a change landing in the same
        // clock tick as the listing could keep the time; such a listing is never reused).
        private string[]? Names(string dir)
        {
            DateTime written;
            try
            {
                if (!Directory.Exists(dir))
                {
                    return null;
                }

                written = Directory.GetLastWriteTimeUtc(dir);
            }
            catch (Exception ex) when (IsFileError(ex))
            {
                return null;
            }

            var now = Environment.TickCount64;
            lock (_listings)
            {
                if (_listings.TryGetValue(dir, out var cached) && cached.Written == written && now - cached.Taken < (long)ListingReuse.TotalMilliseconds)
                {
                    return cached.Names;
                }
            }

            var wall = DateTime.UtcNow;
            if (ListNow(dir) is not { } names)
            {
                return null;
            }

            lock (_listings)
            {
                if (wall - written > TimeSpan.FromSeconds(1))
                {
                    _listings[dir] = (written, now, names);
                }
                else
                {
                    _listings.Remove(dir);
                }
            }

            return names;
        }

        /// <summary>The marker folders' paths (the view reads markers from those that list a list's id).</summary>
        internal IReadOnlyList<string> Directories => _markerDirectories;

        // Each list id with a marker entry (any kind of entry) and a bit per folder listing it, from listings (see Names);
        // null when a folder can't be listed and can't be shown absent either (then any list may have a marker).
        private Dictionary<Guid, int>? Listing()
        {
            var ids = new Dictionary<Guid, int>();
            for (var i = 0; i < _markerDirectories.Length; i++)
            {
                if (Names(_markerDirectories[i]) is { } names)
                {
                    foreach (var name in names)
                    {
                        if (MarkerId(name) is { } id)
                        {
                            ids[id] = ids.GetValueOrDefault(id) | (1 << i);
                        }
                    }
                }
                else if (!ShownAbsent(_markerDirectories[i], Names))
                {
                    return null;
                }
            }

            return ids;
        }

        /// <summary>
        /// The hashes a #936 marker recorded (<c>sha256</c> of the saved collage, <c>pendingSha256</c> of a write that may
        /// have landed), or null when it isn't one for this list: not one JSON object, a duplicate or mistyped field, another
        /// list's id, a hash that isn't exactly 64 lowercase hex characters, or no hash at all.
        /// </summary>
        /// <param name="json">The marker's bytes.</param>
        /// <param name="listIdN">The list it was stored for ("N").</param>
        /// <returns>The hashes, or null.</returns>
        internal static IReadOnlyCollection<string>? ReadHashes(byte[] json, string listIdN)
        {
            try
            {
                using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 4 });
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }

                var seen = new HashSet<string>(StringComparer.Ordinal);
                string? listId = null;
                var hashes = new List<string>(2);
                foreach (var property in doc.RootElement.EnumerateObject())
                {
                    if (!seen.Add(property.Name))
                    {
                        return null;
                    }

                    switch (property.Name)
                    {
                        case "listId":
                            if (property.Value.ValueKind != JsonValueKind.String)
                            {
                                return null;
                            }

                            listId = property.Value.GetString();
                            break;
                        case "sha256":
                        case "pendingSha256":
                            if (property.Value.ValueKind == JsonValueKind.Null)
                            {
                                break;
                            }

                            if (property.Value.ValueKind != JsonValueKind.String)
                            {
                                return null;
                            }

                            var hash = property.Value.GetString()!;
                            if (hash.Length == 0)
                            {
                                break;
                            }

                            if (!IsHash(hash))
                            {
                                return null;
                            }

                            hashes.Add(hash);
                            break;
                    }
                }

                return string.Equals(listId, listIdN, StringComparison.Ordinal) && hashes.Count > 0 ? hashes : null;
            }
            catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException)
            {
                return null;
            }
        }
    }

    /// <summary>
    /// One answer's (or message's, or request's) view of the legacy collages: the marker folders as listed when it began,
    /// each list judged at most once (from its files' content, never from an earlier answer), each library tile kind
    /// observed once.
    /// </summary>
    public sealed class LegacyCollageView
    {
        private readonly LegacyCollageWithhold _owner;
        private readonly Dictionary<Guid, int>? _listing;
        private readonly Dictionary<Guid, Judgement> _judgements = new();
        private readonly Dictionary<BaseItemKind, KindState> _kinds = new();
        private readonly Dictionary<(Guid, ImageType), bool> _images = new();

        internal LegacyCollageView(LegacyCollageWithhold owner, Dictionary<Guid, int>? listing)
        {
            _owner = owner;
            _listing = listing;
            Idle = listing is { Count: 0 } && !owner.Tiles.HasHistory;
        }

        /// <summary>True when there is nothing to withhold: no marker listed and no library tile ever seen built from a collage.</summary>
        public bool Idle { get; }

        /// <summary>Classifies the list's current Primary image (any other item: <see cref="LegacyCollageVerdict.NoEvidence"/>).</summary>
        /// <param name="item">The item.</param>
        /// <returns>The verdict.</returns>
        public LegacyCollageVerdict Classify(BaseItem item) => Judge(item).Verdict;

        /// <summary>
        /// True when the item's image of that type must be withheld: a list's Primary holding (or possibly holding) the
        /// collage, or the Primary/Thumb of a playlist or collection library tile that may hold a collage's pixels.
        /// </summary>
        /// <param name="item">The item.</param>
        /// <param name="type">Image type.</param>
        /// <returns>Whether to withhold it.</returns>
        public bool Withholds(BaseItem item, ImageType type)
        {
            if (Idle || type is not (ImageType.Primary or ImageType.Thumb))
            {
                return false;
            }

            if (item is Playlist or BoxSet)
            {
                return type == ImageType.Primary && LegacyCollageWithhold.IsWithheld(Classify(item));
            }

            return LegacyCollageWithhold.HolderKindOf(item) is { } kind && Tile(item, type, kind);
        }

        /// <summary>True when the item with this id withholds its image of that type (DTO references to an item's image).</summary>
        /// <param name="id">Item id.</param>
        /// <param name="type">Image type.</param>
        /// <returns>Whether it does.</returns>
        public bool Image(Guid id, ImageType type)
        {
            if (Idle || id == Guid.Empty || type is not (ImageType.Primary or ImageType.Thumb))
            {
                return false;
            }

            if (!_images.TryGetValue((id, type), out var withheld))
            {
                _images[(id, type)] = withheld = _owner.Library.GetItemById(id) is { } item && Withholds(item, type);
            }

            return withheld;
        }

        /// <summary>True when the list with this id withholds its Primary image.</summary>
        /// <param name="listId">List id.</param>
        /// <returns>Whether it does.</returns>
        public bool List(Guid listId)
        {
            if (Idle || listId == Guid.Empty || (_listing != null && !_listing.ContainsKey(listId)))
            {
                return false;
            }

            return Image(listId, ImageType.Primary);
        }

        /// <summary>True when a list of that kind withholds its Primary now, or the markers can't be listed.</summary>
        /// <param name="kind">List kind.</param>
        /// <returns>Whether it does.</returns>
        public bool AnyWithheld(BaseItemKind kind) => !Idle && Kind(kind).WithheldNow;

        private Judgement Judge(BaseItem item)
        {
            if (item is not (Playlist or BoxSet) || (_listing != null && !_listing.ContainsKey(item.Id)))
            {
                return Judgement.None;
            }

            if (!_judgements.TryGetValue(item.Id, out var judgement))
            {
                _judgements[item.Id] = judgement = Evaluate(item);
            }

            return judgement;
        }

        private Judgement Evaluate(BaseItem item)
        {
            var images = (item.ImageInfos ?? Array.Empty<ItemImageInfo>()).Where(i => i.Type == ImageType.Primary).ToArray();
            if (images.Length == 0)
            {
                return new Judgement(LegacyCollageVerdict.NoImage, "none");
            }

            if (_listing == null)
            {
                // A marker folder can't be listed: no list image can be shown not to be a collage.
                return new Judgement(LegacyCollageVerdict.Unreadable, "unlisted");
            }

            var listIdN = item.Id.ToString("N");
            var hashes = new HashSet<string>(StringComparer.Ordinal);
            var mask = _listing[item.Id];
            for (var i = 0; i < _owner.Directories.Count; i++)
            {
                if ((mask & (1 << i)) == 0)
                {
                    continue;
                }

                byte[] bytes;
                try
                {
                    // The listing named it: one that can't be opened now (gone, a folder, no permission) is unreadable.
                    using var stream = new FileStream(Path.Combine(_owner.Directories[i], listIdN + ".json"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    if (stream.Length > LegacyCollageWithhold.MaxMarkerBytes)
                    {
                        return new Judgement(LegacyCollageVerdict.Unreadable, "marker");
                    }

                    bytes = new byte[stream.Length];
                    stream.ReadExactly(bytes);
                }
                catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex) || ex is EndOfStreamException)
                {
                    return new Judgement(LegacyCollageVerdict.Unreadable, "marker");
                }

                if (LegacyCollageWithhold.ReadHashes(bytes, listIdN) is not { } recorded)
                {
                    return new Judgement(LegacyCollageVerdict.Unreadable, "marker");
                }

                hashes.UnionWith(recorded);
            }

            var identity = new List<string>(images.Length);
            var collage = false;
            foreach (var image in images)
            {
                if (!image.IsLocalFile || string.IsNullOrEmpty(image.Path))
                {
                    return new Judgement(LegacyCollageVerdict.Unreadable, "remote");
                }

                try
                {
                    var sha = LegacyCollageWithhold.HashFile(image.Path);
                    var info = new FileInfo(image.Path);
                    identity.Add(sha + ":" + info.Length + ":" + info.LastWriteTimeUtc.Ticks);
                    collage |= hashes.Contains(sha);
                }
                catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
                {
                    return new Judgement(LegacyCollageVerdict.Unreadable, "image");
                }
            }

            return new Judgement(collage ? LegacyCollageVerdict.Collage : LegacyCollageVerdict.Superseded, string.Join("|", identity));
        }

        // What the lists of that kind look like now, and the moment from which a tile of that kind can be clean.
        private KindState Kind(BaseItemKind kind)
        {
            if (_kinds.TryGetValue(kind, out var state))
            {
                return state;
            }

            if (_listing == null)
            {
                return _kinds[kind] = new KindState(true, null);
            }

            var lists = new Dictionary<string, string>(StringComparer.Ordinal);
            var withheld = false;
            foreach (var id in _listing.Keys)
            {
                var item = _owner.Library.GetItemById(id);
                if (item == null)
                {
                    // A list that is gone may have fed a tile of either kind before it went.
                    lists[id.ToString("N")] = "missing";
                }
                else if (item is Playlist or BoxSet && item.GetBaseItemKind() == kind)
                {
                    var judgement = Judge(item);
                    lists[id.ToString("N")] = judgement.Verdict + ":" + judgement.Identity;
                    withheld |= LegacyCollageWithhold.IsWithheld(judgement.Verdict);
                }
            }

            return _kinds[kind] = new KindState(withheld, _owner.Tiles.Observe(kind, withheld, lists));
        }

        private bool Tile(BaseItem holder, ImageType type, BaseItemKind kind)
        {
            var state = Kind(kind);
            var images = (holder.ImageInfos ?? Array.Empty<ItemImageInfo>()).Where(i => i.Type == type).ToArray();
            if (state.WithheldNow)
            {
                // Whatever this tile holds now may hold a collage's pixels: remembered, so a copy of it later is known.
                foreach (var image in images)
                {
                    Remember(image);
                }

                return true;
            }

            if (state.CleanFrom is not { } cleanFrom || images.Length == 0)
            {
                return false;
            }

            foreach (var image in images)
            {
                if (!image.IsLocalFile || string.IsNullOrEmpty(image.Path))
                {
                    return true;
                }

                try
                {
                    var info = new FileInfo(image.Path);
                    if (!info.Exists)
                    {
                        return true;
                    }

                    var written = info.LastWriteTimeUtc;
                    var sha = LegacyCollageWithhold.HashFile(image.Path);
                    if (written <= cleanFrom + LegacyCollageTiles.RegenerationMargin)
                    {
                        // Not regenerated since the last list of its kind stopped being (or could have been) a collage.
                        _owner.Tiles.Record(sha);
                        return true;
                    }

                    if (_owner.Tiles.Contaminated(sha))
                    {
                        return true;
                    }
                }
                catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
                {
                    return true;
                }
            }

            return false;
        }

        private void Remember(ItemImageInfo image)
        {
            if (!image.IsLocalFile || string.IsNullOrEmpty(image.Path))
            {
                return;
            }

            try
            {
                _owner.Tiles.Record(LegacyCollageWithhold.HashFile(image.Path));
            }
            catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
            {
                // Nothing to remember; the tile is withheld all the same.
            }
        }

        private sealed record Judgement(LegacyCollageVerdict Verdict, string Identity)
        {
            public static readonly Judgement None = new(LegacyCollageVerdict.NoEvidence, string.Empty);
        }

        private sealed record KindState(bool WithheldNow, DateTime? CleanFrom);
    }
}
