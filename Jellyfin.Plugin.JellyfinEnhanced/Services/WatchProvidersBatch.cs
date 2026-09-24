using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Parsing and shaping for the batched watch-providers endpoint used by Seerr
    /// cards. A TMDB watch/providers body lists every region (~5-20 KB); a card
    /// only needs one region's flat-rate (subscription) providers, so the batch
    /// returns just that slice for up to <see cref="MaxItems"/> titles at once.
    /// </summary>
    public static class WatchProvidersBatch
    {
        /// <summary>Most distinct titles one request may ask for.</summary>
        public const int MaxItems = 100;

        // Longest accepted items value (100 x "movie:123456789," plus slack); anything
        // longer is refused before splitting.
        private const int MaxItemsLength = 2048;
        private const int MaxProviderNameLength = 200;

        private static readonly Regex ItemPattern = new(@"^(movie|tv):([0-9]{1,9})$", RegexOptions.CultureInvariant);
        private static readonly Regex RegionPattern = new(@"^[A-Z]{2}$", RegexOptions.CultureInvariant);
        // Same shape the client accepts for TMDB image paths (e.g. "/abc.jpg").
        private static readonly Regex LogoPathPattern = new(@"^/[A-Za-z0-9_\-.]+\.(jpg|jpeg|png|webp|avif)$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

        /// <summary>One requested title.</summary>
        /// <param name="MediaType">"movie" or "tv".</param>
        /// <param name="TmdbId">Positive TMDB id.</param>
        public readonly record struct Item(string MediaType, int TmdbId)
        {
            /// <summary>Key used in the response ("movie:603").</summary>
            public string Key => MediaType + ":" + TmdbId.ToString(CultureInfo.InvariantCulture);

            /// <summary>TMDB API path of this title's watch providers.</summary>
            public string ApiPath => MediaType + "/" + TmdbId.ToString(CultureInfo.InvariantCulture) + "/watch/providers";
        }

        /// <summary>One flat-rate provider as returned to the client.</summary>
        public sealed record Provider(int ProviderId, string ProviderName, string LogoPath);

        /// <summary>
        /// Parses "movie:603,tv:1399,..." into distinct items (first-seen order).
        /// Malformed entries are skipped; the call fails when nothing valid remains
        /// or more than <see cref="MaxItems"/> distinct titles are requested.
        /// </summary>
        public static bool TryParseItems(string? items, out List<Item> parsed, out string error)
        {
            parsed = new List<Item>();
            error = string.Empty;
            if (string.IsNullOrWhiteSpace(items))
            {
                error = "No items requested.";
                return false;
            }

            if (items.Length > MaxItemsLength)
            {
                error = $"Too many items (max {MaxItems}).";
                return false;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var raw in items.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var match = ItemPattern.Match(raw);
                if (!match.Success
                    || !int.TryParse(match.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var id)
                    || id <= 0)
                {
                    continue;
                }

                var item = new Item(match.Groups[1].Value, id);
                if (seen.Add(item.Key))
                {
                    parsed.Add(item);
                }
            }

            if (parsed.Count == 0)
            {
                error = "No valid items requested.";
                return false;
            }

            if (parsed.Count > MaxItems)
            {
                error = $"Too many items (max {MaxItems}).";
                return false;
            }

            return true;
        }

        /// <summary>True for a two-letter upper-case region code ("US").</summary>
        public static bool IsValidRegion(string? region) => region != null && RegionPattern.IsMatch(region);

        /// <summary>
        /// The region to use when the caller sends none: the admin's DEFAULT_REGION
        /// when it is a valid code (case-insensitively), otherwise "US".
        /// </summary>
        public static string DefaultRegion(string? configured)
        {
            var candidate = configured?.Trim().ToUpperInvariant();
            return IsValidRegion(candidate) ? candidate! : "US";
        }

        /// <summary>
        /// Extracts results[region].flatrate from a TMDB watch/providers body, in
        /// TMDB order, keeping only entries with a string name and a well-formed
        /// logo path. Returns an empty list when the region or its flat-rate list
        /// is absent, and null when the body is not the expected JSON.
        /// </summary>
        public static List<Provider>? ExtractFlatrate(string json, string region)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }

                var providers = new List<Provider>();
                if (!root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Object
                    || !results.TryGetProperty(region, out var regional) || regional.ValueKind != JsonValueKind.Object
                    || !regional.TryGetProperty("flatrate", out var flatrate) || flatrate.ValueKind != JsonValueKind.Array)
                {
                    return providers;
                }

                foreach (var entry in flatrate.EnumerateArray())
                {
                    if (entry.ValueKind != JsonValueKind.Object
                        || !entry.TryGetProperty("provider_name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String
                        || !entry.TryGetProperty("logo_path", out var logoEl) || logoEl.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    var name = nameEl.GetString() ?? string.Empty;
                    var logo = logoEl.GetString() ?? string.Empty;
                    if (name.Length == 0 || name.Length > MaxProviderNameLength || !LogoPathPattern.IsMatch(logo))
                    {
                        continue;
                    }

                    var id = entry.TryGetProperty("provider_id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
                        && idEl.TryGetInt32(out var parsedId) ? parsedId : 0;
                    providers.Add(new Provider(id, name, logo));
                }

                return providers;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>
        /// Serialises the batch response:
        /// { "region": "US", "results": { "movie:603": [ { provider_id, provider_name, logo_path } ] | null } }.
        /// Keys follow <paramref name="items"/> order; a missing entry is written as null.
        /// </summary>
        public static string Serialize(string region, IReadOnlyList<Item> items, IReadOnlyDictionary<string, List<Provider>?> results)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("region", region);
                writer.WriteStartObject("results");
                foreach (var item in items)
                {
                    if (!results.TryGetValue(item.Key, out var providers) || providers == null)
                    {
                        writer.WriteNull(item.Key);
                        continue;
                    }

                    writer.WriteStartArray(item.Key);
                    foreach (var p in providers)
                    {
                        writer.WriteStartObject();
                        writer.WriteNumber("provider_id", p.ProviderId);
                        writer.WriteString("provider_name", p.ProviderName);
                        writer.WriteString("logo_path", p.LogoPath);
                        writer.WriteEndObject();
                    }
                    writer.WriteEndArray();
                }
                writer.WriteEndObject();
                writer.WriteEndObject();
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }
    }
}
