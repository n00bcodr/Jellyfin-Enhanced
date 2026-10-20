using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
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
    /// aspect ratio, image info and path), and neither do the playlist/collection library tiles the host composes from
    /// list images. Nothing is ever deleted, rewritten or adopted: the files stay as they are, and the host answers as
    /// it does for a list without an image.
    /// <list type="bullet">
    /// <item>Proof is content: the current file's SHA-256 against the hashes a marker for that list id recorded (the
    /// saved and the pending one). A marker or image JE can't read or understand counts as the collage (fail closed).</item>
    /// <item>A different image (one the owner set later) and every list without a marker are untouched.</item>
    /// <item>Verdicts are cached per list against the marker and image files' size and modification time, so a
    /// replaced image or marker is classified again on the next request.</item>
    /// </list>
    /// </summary>
    public sealed class LegacyCollageWithhold
    {
        /// <summary>Largest marker read; a bigger one is not #936's and counts as unreadable.</summary>
        public const long MaxMarkerBytes = 64 * 1024;

        private const int MaxCachedVerdicts = 4096;

        private static readonly Regex HashPattern = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);

        private readonly string[] _markerDirectories;
        private readonly ILibraryManager _libraryManager;
        private readonly ConcurrentDictionary<Guid, (string Key, LegacyCollageVerdict Verdict)> _verdicts = new();
        private readonly object _listingLock = new();
        private string? _listingKey;
        private HashSet<Guid>? _listing;

        /// <summary>Creates the owner (DI): markers in Jellyfin Enhanced's configuration folder.</summary>
        /// <param name="appPaths">Jellyfin application paths.</param>
        /// <param name="libraryManager">Library (list lookups).</param>
        public LegacyCollageWithhold(IApplicationPaths appPaths, ILibraryManager libraryManager)
            : this(MarkerDirectories(Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced")), libraryManager)
        {
        }

        /// <summary>Creates the owner over explicit marker folders (tests).</summary>
        /// <param name="markerDirectories">Folders holding <c>&lt;listIdN&gt;.json</c> markers.</param>
        /// <param name="libraryManager">Library (list lookups).</param>
        internal LegacyCollageWithhold(IReadOnlyList<string> markerDirectories, ILibraryManager libraryManager)
        {
            _markerDirectories = markerDirectories.ToArray();
            _libraryManager = libraryManager;
        }

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

        /// <summary>True when no marker exists at all (every request can skip this owner).</summary>
        /// <returns>Whether there is nothing to withhold.</returns>
        public bool NoMarkers()
        {
            var listing = Listing();
            return listing != null && listing.Count == 0;
        }

        /// <summary>True when a marker exists for the list id (or the marker folders can't be listed).</summary>
        /// <param name="listId">List id.</param>
        /// <returns>Whether the id may have a JE collage.</returns>
        public bool MayHaveMarker(Guid listId)
        {
            var listing = Listing();
            return listing == null || listing.Contains(listId);
        }

        /// <summary>Classifies the list's current Primary image (any other item: <see cref="LegacyCollageVerdict.NoEvidence"/>).</summary>
        /// <param name="item">The item.</param>
        /// <returns>The verdict.</returns>
        public LegacyCollageVerdict Classify(BaseItem item)
        {
            if (item is not (Playlist or BoxSet))
            {
                return LegacyCollageVerdict.NoEvidence;
            }

            var listing = Listing();
            if (listing != null && !listing.Contains(item.Id))
            {
                return LegacyCollageVerdict.NoEvidence;
            }

            var listIdN = item.Id.ToString("N");
            var markers = _markerDirectories.Select(d => Path.Combine(d, listIdN + ".json")).ToArray();
            var images = (item.ImageInfos ?? Array.Empty<ItemImageInfo>()).Where(i => i.Type == ImageType.Primary).ToArray();
            if (listing == null)
            {
                // A marker folder exists but can't be read: no list image can be shown not to be a collage.
                return images.Length == 0 ? LegacyCollageVerdict.NoImage : LegacyCollageVerdict.Unreadable;
            }

            string key;
            try
            {
                key = Stamp(markers, images, out var anyMarker);
                if (!anyMarker)
                {
                    return LegacyCollageVerdict.NoEvidence;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return images.Length == 0 ? LegacyCollageVerdict.NoImage : LegacyCollageVerdict.Unreadable;
            }

            if (images.Length == 0)
            {
                return LegacyCollageVerdict.NoImage;
            }

            if (_verdicts.TryGetValue(item.Id, out var cached) && string.Equals(cached.Key, key, StringComparison.Ordinal))
            {
                return cached.Verdict;
            }

            var verdict = Evaluate(listIdN, markers, images);
            if (_verdicts.Count >= MaxCachedVerdicts)
            {
                _verdicts.Clear();
            }

            _verdicts[item.Id] = (key, verdict);
            return verdict;
        }

        /// <summary>
        /// True when the item's image of that type must be withheld: a list's Primary holding (or possibly holding) the
        /// collage, or the Primary/Thumb of a playlist or collection library tile while any list of that kind is withheld
        /// (the host composes those tiles from list images).
        /// </summary>
        /// <param name="item">The item.</param>
        /// <param name="type">Image type.</param>
        /// <returns>Whether to withhold it.</returns>
        public bool Withholds(BaseItem item, ImageType type)
        {
            if (type == ImageType.Primary && IsWithheld(Classify(item)))
            {
                return true;
            }

            return type is ImageType.Primary or ImageType.Thumb && HolderKind(item) is { } kind && AnyWithheld(kind);
        }

        /// <summary>True when the list with this id currently withholds its Primary image.</summary>
        /// <param name="listId">List id.</param>
        /// <returns>Whether it does.</returns>
        public bool WithholdsList(Guid listId)
        {
            if (listId == Guid.Empty || !MayHaveMarker(listId))
            {
                return false;
            }

            return _libraryManager.GetItemById(listId) is { } item && IsWithheld(Classify(item));
        }

        /// <summary>True when a list of that kind (Playlist or BoxSet) withholds its image, or the markers can't be listed.</summary>
        /// <param name="kind">List kind.</param>
        /// <returns>Whether library tiles of that kind are withheld.</returns>
        public bool AnyWithheld(BaseItemKind kind)
        {
            var listing = Listing();
            if (listing == null)
            {
                return true;
            }

            foreach (var id in listing)
            {
                if (_libraryManager.GetItemById(id) is { } item && item.GetBaseItemKind() == kind && IsWithheld(Classify(item)))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>The list kind a library tile is composed from: Playlist for playlist libraries/views, BoxSet for collections.</summary>
        /// <param name="collectionType">The folder's or view's collection type.</param>
        /// <returns>The kind, or null for any other folder.</returns>
        public static BaseItemKind? HolderKind(CollectionType? collectionType) => collectionType switch
        {
            CollectionType.playlists => BaseItemKind.Playlist,
            CollectionType.boxsets => BaseItemKind.BoxSet,
            _ => null,
        };

        private static BaseItemKind? HolderKind(BaseItem item)
            => item is IHasCollectionType holder and not (Playlist or BoxSet) ? HolderKind(holder.CollectionType) : null;

        private static bool IsWithheld(LegacyCollageVerdict verdict) => verdict is LegacyCollageVerdict.Collage or LegacyCollageVerdict.Unreadable;

        // Ids with a marker in any folder; null when a folder exists but can't be listed (then every id may have one).
        private HashSet<Guid>? Listing()
        {
            string key;
            try
            {
                key = string.Join("|", _markerDirectories.Select(d => Directory.Exists(d) ? d + ":" + Directory.GetLastWriteTimeUtc(d).Ticks : d + ":-"));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return null;
            }

            lock (_listingLock)
            {
                if (_listing != null && string.Equals(_listingKey, key, StringComparison.Ordinal))
                {
                    return _listing;
                }
            }

            var ids = new HashSet<Guid>();
            try
            {
                foreach (var dir in _markerDirectories.Where(Directory.Exists))
                {
                    foreach (var name in Directory.EnumerateFiles(dir, "*.json", SearchOption.TopDirectoryOnly).Select(Path.GetFileNameWithoutExtension))
                    {
                        if (ListStore.IsValidListId(name))
                        {
                            ids.Add(Guid.ParseExact(name!, "N"));
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return null;
            }

            lock (_listingLock)
            {
                _listingKey = key;
                _listing = ids;
            }

            return ids;
        }

        // Size and modification time of every marker and image file: the cache key of a verdict.
        private static string Stamp(string[] markers, ItemImageInfo[] images, out bool anyMarker)
        {
            anyMarker = false;
            var parts = new List<string>(markers.Length + images.Length);
            foreach (var marker in markers)
            {
                var info = new FileInfo(marker);
                anyMarker |= info.Exists;
                parts.Add(info.Exists ? info.Length + ":" + info.LastWriteTimeUtc.Ticks : "-");
            }

            foreach (var image in images)
            {
                if (!image.IsLocalFile || string.IsNullOrEmpty(image.Path))
                {
                    parts.Add("remote:" + image.Path);
                    continue;
                }

                var info = new FileInfo(image.Path);
                parts.Add(image.Path + ":" + (info.Exists ? info.Length + ":" + info.LastWriteTimeUtc.Ticks : "-"));
            }

            return string.Join("|", parts);
        }

        private static LegacyCollageVerdict Evaluate(string listIdN, string[] markers, ItemImageInfo[] images)
        {
            var hashes = new HashSet<string>(StringComparer.Ordinal);
            foreach (var marker in markers)
            {
                byte[] bytes;
                try
                {
                    if (!File.Exists(marker))
                    {
                        continue;
                    }

                    using var stream = new FileStream(marker, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    if (stream.Length > MaxMarkerBytes)
                    {
                        return LegacyCollageVerdict.Unreadable;
                    }

                    bytes = new byte[stream.Length];
                    stream.ReadExactly(bytes);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    return LegacyCollageVerdict.Unreadable;
                }

                if (ReadHashes(bytes, listIdN) is not { } recorded)
                {
                    return LegacyCollageVerdict.Unreadable;
                }

                hashes.UnionWith(recorded);
            }

            if (hashes.Count == 0)
            {
                // Every marker vanished between the stamp and the read.
                return LegacyCollageVerdict.NoEvidence;
            }

            foreach (var image in images)
            {
                if (!image.IsLocalFile || string.IsNullOrEmpty(image.Path))
                {
                    return LegacyCollageVerdict.Unreadable;
                }

                string sha;
                try
                {
                    using var stream = new FileStream(image.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    sha = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
                {
                    return LegacyCollageVerdict.Unreadable;
                }

                if (hashes.Contains(sha))
                {
                    return LegacyCollageVerdict.Collage;
                }
            }

            return LegacyCollageVerdict.Superseded;
        }

        /// <summary>
        /// The hashes a #936 marker recorded (<c>sha256</c> of the saved collage, <c>pendingSha256</c> of a write that may
        /// have landed), or null when it isn't one for this list: not one JSON object, a duplicate or mistyped field, another
        /// list's id, a malformed hash, or no hash at all.
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

                            if (!HashPattern.IsMatch(hash))
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
}
