using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Records the poster collage JE set as a list's primary image, so JE only ever replaces or removes its own image:
    /// the image counts as JE's only while the list's primary image is still this path with this content hash.
    /// </summary>
    public sealed class ListCollageMarker
    {
        /// <summary>The list id ("N").</summary>
        [JsonPropertyName("listId")]
        public string ListId { get; set; } = string.Empty;

        /// <summary>Path of the image JE saved.</summary>
        [JsonPropertyName("imagePath")]
        public string ImagePath { get; set; } = string.Empty;

        /// <summary>SHA-256 (lowercase hex) of the saved image.</summary>
        [JsonPropertyName("sha256")]
        public string Sha256 { get; set; } = string.Empty;

        /// <summary>TMDB poster paths the collage was built from, in order.</summary>
        [JsonPropertyName("posterKeys")]
        public List<string> PosterKeys { get; set; } = new();

        /// <summary>Poster paths TMDB answered with a client error (not retried while this collage stands).</summary>
        [JsonPropertyName("failedKeys")]
        public List<string> FailedKeys { get; set; } = new();

        /// <summary>When the collage was set (UTC ISO-8601).</summary>
        [JsonPropertyName("setAt")]
        public string SetAt { get; set; } = string.Empty;
    }

    /// <summary>
    /// One small JSON file per list under <c>list-placeholders/collages/</c>, kept apart from the list document on
    /// purpose: writing it doesn't bump the document's revision, so an image change never makes an open list page's
    /// next edit fail with a revision conflict, and saving it doesn't re-trigger the collage itself.
    /// Callers serialise access per list.
    /// </summary>
    public sealed class ListCollageMarkerStore
    {
        private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };

        private readonly string _dir;
        private readonly Logger _logger;

        /// <summary>Creates the store; the directory is created on first write.</summary>
        /// <param name="placeholderStore">The placeholder store (its directory is the parent).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="folder">Sub-folder of the placeholder store's directory (relative, e.g. "collages").</param>
        public ListCollageMarkerStore(ListPlaceholderStore placeholderStore, Logger logger, string folder = "collages")
        {
            _dir = Path.Combine(placeholderStore.DirectoryPath, folder);
            _logger = logger;
        }

        /// <summary>The marker of a list, or null (none, or unreadable: JE then treats the image as not its own).</summary>
        /// <param name="listIdN">List id.</param>
        /// <returns>The marker or null.</returns>
        public ListCollageMarker? Load(string listIdN)
        {
            var path = PathFor(listIdN);
            if (!File.Exists(path))
            {
                return null;
            }

            try
            {
                var marker = JsonSerializer.Deserialize<ListCollageMarker>(File.ReadAllText(path), JsonOptions);
                if (marker == null || !string.Equals(marker.ListId, listIdN, StringComparison.Ordinal) || string.IsNullOrEmpty(marker.ImagePath))
                {
                    return null;
                }

                marker.PosterKeys ??= new List<string>();
                marker.FailedKeys ??= new List<string>();
                return marker;
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                _logger.Debug($"[ListPlaceholders] Collage marker of {listIdN} is unreadable ({ex.Message}); ignoring it.");
                return null;
            }
        }

        /// <summary>True when a marker file exists for the list.</summary>
        /// <param name="listIdN">List id.</param>
        /// <returns>Whether it exists.</returns>
        public bool Exists(string listIdN) => ListPlaceholderStore.IsValidListId(listIdN) && File.Exists(PathFor(listIdN));

        /// <summary>Writes a marker atomically (temp file + move).</summary>
        /// <param name="marker">The marker.</param>
        public void Save(ListCollageMarker marker)
        {
            ArgumentNullException.ThrowIfNull(marker);
            Directory.CreateDirectory(_dir);
            var path = PathFor(marker.ListId);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, JsonSerializer.Serialize(marker, JsonOptions), new UTF8Encoding(false));
                File.Move(temporary, path, overwrite: true);
            }
            finally
            {
                try { File.Delete(temporary); }
                catch (IOException) { /* moved already, or a harmless leftover */ }
            }
        }

        /// <summary>Removes a list's marker.</summary>
        /// <param name="listIdN">List id.</param>
        /// <returns>True when one existed.</returns>
        public bool Delete(string listIdN)
        {
            var path = PathFor(listIdN);
            if (!File.Exists(path))
            {
                return false;
            }

            File.Delete(path);
            return true;
        }

        /// <summary>Ids of every list with a marker.</summary>
        /// <returns>List ids ("N").</returns>
        public IReadOnlyList<string> EnumerateListIds()
        {
            if (!Directory.Exists(_dir))
            {
                return Array.Empty<string>();
            }

            return Directory.EnumerateFiles(_dir, "*.json")
                .Select(Path.GetFileNameWithoutExtension)
                .Where(ListPlaceholderStore.IsValidListId)
                .Select(id => id!)
                .ToList();
        }

        private string PathFor(string listIdN)
        {
            if (!ListPlaceholderStore.IsValidListId(listIdN))
            {
                throw new ArgumentException("List id must be 32 lowercase hex characters.", nameof(listIdN));
            }

            return Path.Combine(_dir, listIdN + ".json");
        }
    }
}
