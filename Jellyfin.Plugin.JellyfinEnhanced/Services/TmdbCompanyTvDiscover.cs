using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Shapes a TMDB discover/tv page as a Seerr /discover/tv page for the
    /// "series by studio" feed. Seerr's own /discover/tv filters series by
    /// network only (there is no company filter, unlike /discover/movies), so
    /// the series a studio produced come straight from TMDB's with_companies
    /// filter; answering in Seerr's shape lets the discovery cards render them
    /// exactly like a network feed. TMDB knows nothing of Seerr's request
    /// state, so the only mediaInfo a row carries is "in this user's library"
    /// (resolved against the Jellyfin library by the caller), which keeps the
    /// in-library link and the exclude-library-items filter working.
    /// </summary>
    public static class TmdbCompanyTvDiscover
    {
        // Seerr's MediaStatus.AVAILABLE.
        private const int MediaStatusAvailable = 5;

        // TMDB sort keys: "popularity.desc", "first_air_date.asc", ...
        private static readonly Regex SortPattern = new(@"^[a-z_]{1,32}\.(asc|desc)$", RegexOptions.CultureInvariant);

        /// <summary>Whether a client-supplied sortBy value is a plain TMDB sort key.</summary>
        public static bool IsValidSort(string? sortBy) => !string.IsNullOrEmpty(sortBy) && SortPattern.IsMatch(sortBy);

        /// <summary>
        /// Rewrites a TMDB discover/tv body ({ page, total_pages, total_results,
        /// results: [snake_case rows] }) into Seerr's discover shape ({ page,
        /// totalPages, totalResults, results: [camelCase rows with mediaType "tv"] }).
        /// </summary>
        /// <param name="tmdbJson">Upstream TMDB body.</param>
        /// <param name="libraryLookup">Maps a TMDB series id to the Jellyfin item id when the series is in the caller's library, else null.</param>
        /// <returns>The Seerr-shaped JSON body.</returns>
        public static string ToSeerrShape(string tmdbJson, Func<int, Guid?> libraryLookup)
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
                        WriteRow(writer, row, id, libraryLookup(id));
                    }
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }

        private static void WriteRow(Utf8JsonWriter writer, JsonElement row, int id, Guid? jellyfinMediaId)
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
            if (jellyfinMediaId.HasValue)
            {
                writer.WriteStartObject("mediaInfo");
                writer.WriteNumber("status", MediaStatusAvailable);
                writer.WriteString("jellyfinMediaId", jellyfinMediaId.Value.ToString("N", CultureInfo.InvariantCulture));
                writer.WriteEndObject();
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
