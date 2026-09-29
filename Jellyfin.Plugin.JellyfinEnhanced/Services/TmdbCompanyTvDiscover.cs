using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Shapes a TMDB discover/tv page as a Seerr /discover/tv page for the
    /// "series by studio" feed. Seerr's own /discover/tv filters series by
    /// network only (there is no company filter, unlike /discover/movies), so
    /// the series a studio produced come straight from TMDB's with_companies
    /// filter; answering in Seerr's shape lets the discovery cards render them
    /// exactly like a network feed. TMDB knows nothing of Seerr's request
    /// state, so only the rows in the caller's library carry a mediaInfo
    /// (Seerr's own for that series when Seerr has one, so a partly available
    /// show keeps "Request missing"; otherwise a bare "available" entry),
    /// which keeps the in-library link and the exclude-library-items filter
    /// working.
    /// </summary>
    public static class TmdbCompanyTvDiscover
    {
        // Seerr's MediaStatus.AVAILABLE.
        private const int MediaStatusAvailable = 5;

        // The sort keys TMDB's discover/tv accepts.
        private static readonly HashSet<string> Sorts = new(StringComparer.Ordinal)
        {
            "popularity.asc", "popularity.desc",
            "first_air_date.asc", "first_air_date.desc",
            "vote_average.asc", "vote_average.desc",
            "vote_count.asc", "vote_count.desc",
            "name.asc", "name.desc",
            "original_name.asc", "original_name.desc",
        };

        /// <summary>Whether a client-supplied sortBy value is one of TMDB's discover/tv sort keys.</summary>
        public static bool IsValidSort(string? sortBy) => !string.IsNullOrEmpty(sortBy) && Sorts.Contains(sortBy);

        /// <summary>The TMDB series ids of a TMDB discover/tv body's rows, in order.</summary>
        /// <param name="tmdbJson">Upstream TMDB body.</param>
        /// <returns>The positive row ids.</returns>
        public static List<int> ReadRowIds(string tmdbJson)
        {
            var ids = new List<int>();
            using var doc = JsonDocument.Parse(tmdbJson);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("results", out var results)
                && results.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in results.EnumerateArray())
                {
                    if (row.ValueKind != JsonValueKind.Object) continue;
                    var id = ReadInt(row, "id", 0);
                    if (id > 0) ids.Add(id);
                }
            }
            return ids;
        }

        /// <summary>
        /// The mediaInfo object of a Seerr /api/v1/tv/{id} body as raw JSON, or
        /// null when the body has none (Seerr has never seen the series).
        /// </summary>
        /// <param name="seerrDetailJson">Seerr series detail body.</param>
        /// <returns>The raw mediaInfo JSON object, or null.</returns>
        public static string? ExtractMediaInfo(string seerrDetailJson)
        {
            try
            {
                using var doc = JsonDocument.Parse(seerrDetailJson);
                return doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("mediaInfo", out var info)
                    && info.ValueKind == JsonValueKind.Object
                    ? info.GetRawText()
                    : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>
        /// A minimal mediaInfo for a series in the caller's library that Seerr
        /// has no record of: available, linked to the Jellyfin item.
        /// </summary>
        /// <param name="jellyfinMediaId">The Jellyfin series id.</param>
        /// <returns>The raw mediaInfo JSON object.</returns>
        public static string LibraryMediaInfo(Guid jellyfinMediaId)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteNumber("status", MediaStatusAvailable);
                writer.WriteString("jellyfinMediaId", jellyfinMediaId.ToString("N", CultureInfo.InvariantCulture));
                writer.WriteEndObject();
            }
            return Encoding.UTF8.GetString(stream.ToArray());
        }

        /// <summary>
        /// Rewrites a TMDB discover/tv body ({ page, total_pages, total_results,
        /// results: [snake_case rows] }) into Seerr's discover shape ({ page,
        /// totalPages, totalResults, results: [camelCase rows with mediaType "tv"] }).
        /// </summary>
        /// <param name="tmdbJson">Upstream TMDB body.</param>
        /// <param name="mediaInfoById">Raw mediaInfo JSON objects by TMDB series id (the rows in the caller's library); other rows carry none.</param>
        /// <returns>The Seerr-shaped JSON body.</returns>
        public static string ToSeerrShape(string tmdbJson, IReadOnlyDictionary<int, string> mediaInfoById)
        {
            using var doc = JsonDocument.Parse(tmdbJson);
            var root = doc.RootElement;

            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteNumber("page", ReadInt(root, "page", 1));
                writer.WriteNumber("totalPages", ReadInt(root, "total_pages", 1));
                writer.WriteNumber("totalResults", ReadInt(root, "total_results", 0));
                writer.WriteStartArray("results");
                if (root.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
                {
                    foreach (var row in results.EnumerateArray())
                    {
                        if (row.ValueKind != JsonValueKind.Object) continue;
                        var id = ReadInt(row, "id", 0);
                        if (id <= 0) continue;
                        WriteRow(writer, row, id, mediaInfoById.TryGetValue(id, out var info) ? info : null);
                    }
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }

        private static void WriteRow(Utf8JsonWriter writer, JsonElement row, int id, string? mediaInfoJson)
        {
            writer.WriteStartObject();
            writer.WriteNumber("id", id);
            writer.WriteString("mediaType", "tv");
            CopyString(writer, row, "name", "name");
            CopyString(writer, row, "original_name", "originalName");
            CopyString(writer, row, "overview", "overview");
            CopyString(writer, row, "poster_path", "posterPath");
            CopyString(writer, row, "backdrop_path", "backdropPath");
            CopyString(writer, row, "first_air_date", "firstAirDate");
            CopyString(writer, row, "original_language", "originalLanguage");
            CopyNumber(writer, row, "vote_average", "voteAverage");
            CopyNumber(writer, row, "vote_count", "voteCount");
            CopyNumber(writer, row, "popularity", "popularity");
            CopyArray(writer, row, "genre_ids", "genreIds");
            CopyArray(writer, row, "origin_country", "originCountry");
            if (mediaInfoJson != null)
            {
                writer.WritePropertyName("mediaInfo");
                writer.WriteRawValue(mediaInfoJson);
            }
            writer.WriteEndObject();
        }

        private static int ReadInt(JsonElement obj, string name, int fallback)
        {
            return obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var value)
                ? value
                : fallback;
        }

        private static void CopyString(Utf8JsonWriter writer, JsonElement row, string from, string to)
        {
            if (row.TryGetProperty(from, out var el) && el.ValueKind == JsonValueKind.String)
            {
                writer.WriteString(to, el.GetString());
            }
        }

        private static void CopyNumber(Utf8JsonWriter writer, JsonElement row, string from, string to)
        {
            if (row.TryGetProperty(from, out var el) && el.ValueKind == JsonValueKind.Number)
            {
                writer.WritePropertyName(to);
                el.WriteTo(writer);
            }
        }

        private static void CopyArray(Utf8JsonWriter writer, JsonElement row, string from, string to)
        {
            if (row.TryGetProperty(from, out var el) && el.ValueKind == JsonValueKind.Array)
            {
                writer.WritePropertyName(to);
                el.WriteTo(writer);
            }
        }
    }
}
