using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Parsing and shaping for the batched movie-collection lookup behind the
    /// Seerr search row's collection cards: which collection each movie of a
    /// rendered batch belongs to, in one request instead of a Seerr movie
    /// detail call (and, when Seerr names no collection, a TMDB detail call)
    /// per movie. Reads the same fields the client used to read from those
    /// two bodies and returns them in the client's shape.
    /// </summary>
    public static class MovieCollectionsBatch
    {
        /// <summary>Most distinct movies one request may ask for.</summary>
        public const int MaxIds = 100;

        // Longest accepted ids value (100 x "123456789," plus slack); anything
        // longer is refused before splitting.
        private const int MaxIdsLength = 1100;

        /// <summary>A movie's collection, as the search row renders it.</summary>
        /// <param name="Id">TMDB collection id (null when the body carries none).</param>
        /// <param name="Name">Collection name.</param>
        /// <param name="PosterPath">TMDB image path of the collection poster.</param>
        /// <param name="BackdropPath">TMDB image path of the collection backdrop.</param>
        public sealed record Collection(int? Id, string? Name, string? PosterPath, string? BackdropPath);

        /// <summary>
        /// Parses "603,604,..." into distinct positive TMDB ids (first-seen order).
        /// Malformed entries are skipped; the call fails when nothing valid remains
        /// or more than <see cref="MaxIds"/> distinct ids are requested.
        /// </summary>
        public static bool TryParseIds(string? ids, out List<int> parsed, out string error)
        {
            parsed = new List<int>();
            error = string.Empty;
            if (string.IsNullOrWhiteSpace(ids))
            {
                error = "No ids requested.";
                return false;
            }

            if (ids.Length > MaxIdsLength)
            {
                error = $"Too many ids (max {MaxIds}).";
                return false;
            }

            var seen = new HashSet<int>();
            foreach (var raw in ids.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                // Digits only (NumberStyles.None: no sign, spaces or separators), at
                // most 9 of them so the value always fits an int.
                if (raw.Length <= 9
                    && int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var id)
                    && id > 0
                    && seen.Add(id))
                {
                    parsed.Add(id);
                }
            }

            if (parsed.Count == 0)
            {
                error = "No valid ids requested.";
                return false;
            }

            if (parsed.Count > MaxIds)
            {
                error = $"Too many ids (max {MaxIds}).";
                return false;
            }

            return true;
        }

        /// <summary>
        /// Reads `collection` from a Seerr /api/v1/movie/{id} body. Returns false
        /// when the body is not a JSON object (the lookup is then unknown, as a
        /// failed call was for the client); otherwise true, with
        /// <paramref name="collection"/> null when Seerr names no collection.
        /// </summary>
        public static bool TryReadSeerrCollection(string json, out Collection? collection)
        {
            collection = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return false;
                }

                if (root.TryGetProperty("collection", out var c) && c.ValueKind == JsonValueKind.Object)
                {
                    collection = new Collection(ReadId(c, "id"), ReadString(c, "name"), ReadString(c, "posterPath"), ReadString(c, "backdropPath"));
                }

                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        /// <summary>
        /// Reads `belongs_to_collection` from a TMDB movie detail body; only an
        /// entry with a non-zero id counts. Returns false when the body is not a
        /// JSON object; otherwise true, with <paramref name="collection"/> null
        /// when the movie belongs to no collection.
        /// </summary>
        public static bool TryReadTmdbCollection(string json, out Collection? collection)
        {
            collection = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return false;
                }

                if ((root.TryGetProperty("belongs_to_collection", out var c) && c.ValueKind == JsonValueKind.Object)
                    || (root.TryGetProperty("belongsToCollection", out c) && c.ValueKind == JsonValueKind.Object))
                {
                    var id = ReadId(c, "id") is int idValue && idValue != 0 ? idValue : ReadId(c, "tmdbId");
                    if (id is int collectionId && collectionId != 0)
                    {
                        collection = new Collection(
                            collectionId,
                            ReadString(c, "name"),
                            ReadString(c, "poster_path") ?? ReadString(c, "posterPath"),
                            ReadString(c, "backdrop_path") ?? ReadString(c, "backdropPath"));
                    }
                }

                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        /// <summary>
        /// Serialises the batch response:
        /// { "results": { "603": { id, name, posterPath, backdropPath } | null } }.
        /// Keys follow <paramref name="ids"/> order; ids with no entry in
        /// <paramref name="results"/> (lookup failed or refused) are left out.
        /// </summary>
        public static string Serialize(IReadOnlyList<int> ids, IReadOnlyDictionary<int, Collection?> results)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteStartObject("results");
                foreach (var id in ids)
                {
                    if (!results.TryGetValue(id, out var collection))
                    {
                        continue;
                    }

                    var key = id.ToString(CultureInfo.InvariantCulture);
                    if (collection == null)
                    {
                        writer.WriteNull(key);
                        continue;
                    }

                    writer.WriteStartObject(key);
                    if (collection.Id is int collectionId)
                    {
                        writer.WriteNumber("id", collectionId);
                    }
                    else
                    {
                        writer.WriteNull("id");
                    }

                    WriteNullableString(writer, "name", collection.Name);
                    WriteNullableString(writer, "posterPath", collection.PosterPath);
                    WriteNullableString(writer, "backdropPath", collection.BackdropPath);
                    writer.WriteEndObject();
                }

                writer.WriteEndObject();
                writer.WriteEndObject();
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }

        private static int? ReadId(JsonElement obj, string name)
            => obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var value) ? value : null;

        private static string? ReadString(JsonElement obj, string name)
            => obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

        private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
        {
            if (value == null)
            {
                writer.WriteNull(name);
            }
            else
            {
                writer.WriteString(name, value);
            }
        }
    }
}
