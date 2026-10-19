using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Instance registry v2 normalisation for the <c>SonarrInstances</c> / <c>RadarrInstances</c>
    /// JSON rows: stable ids (kept, inherited by URL, or newly minted), known roles, one default per
    /// role, clean library and path lists. Pure: no I/O and no credentials (the key placeholders are
    /// handled by <see cref="Secrets.SecretsMigration"/>, which calls this).
    /// </summary>
    public static class ArrRegistryMigration
    {
        /// <summary>Serializer settings for the stored instance JSON (compact, PascalCase, default escaping).</summary>
        internal static readonly JsonSerializerOptions StoredJson = new();

        /// <summary>
        /// Parses stored instance JSON. Returns null when it is not a JSON array of rows (corrupt);
        /// an empty or blank value is an empty list. Null rows are dropped.
        /// </summary>
        public static List<ArrInstance>? Parse(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new List<ArrInstance>();
            try
            {
                var rows = JsonSerializer.Deserialize<List<ArrInstance?>>(json, StoredJson);
                return rows?.Where(r => r != null).Select(r => r!).ToList() ?? new List<ArrInstance>();
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>Serializes rows for storage.</summary>
        public static string Serialize(IEnumerable<ArrInstance> rows) => JsonSerializer.Serialize(rows.ToList(), StoredJson);

        /// <summary>
        /// Normalises <paramref name="rows"/> in place. Ids: a valid id is kept unless an earlier row
        /// already uses it; a row without one inherits the id of the matching <paramref name="previous"/>
        /// row (same URL, not yet claimed) so a client that does not know about ids cannot re-key an
        /// instance; anything else gets a new id. Rows without a URL are dropped (they can't be used).
        /// </summary>
        /// <param name="rows">Rows to normalise (one kind).</param>
        /// <param name="previous">The currently stored rows of the same kind, if any.</param>
        /// <param name="defaultName">Name for rows without one ("Sonarr" / "Radarr").</param>
        /// <param name="usedIds">Ids already taken by rows normalised before these (the other kind's
        /// list): instance keys are stored per id for both kinds, so an id must be unique across
        /// both lists. Updated with the ids assigned here.</param>
        /// <returns>The normalised rows.</returns>
        public static List<ArrInstance> Normalize(List<ArrInstance> rows, IReadOnlyList<ArrInstance>? previous, string defaultName, ISet<string>? usedIds = null)
        {
            var result = new List<ArrInstance>(rows.Count);
            var used = usedIds ?? new HashSet<string>(StringComparer.Ordinal);
            var previousById = (previous ?? Array.Empty<ArrInstance>())
                .Where(p => IsValidId(p.Id))
                .GroupBy(p => NormalizeId(p.Id))
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

            foreach (var row in rows)
            {
                row.Url = (row.Url ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(row.Url)) continue;

                var id = IsValidId(row.Id) ? NormalizeId(row.Id) : null;
                if (id == null || used.Contains(id))
                {
                    var inherited = previousById.Values.FirstOrDefault(p =>
                        !used.Contains(NormalizeId(p.Id)) && SameUrl(p.Url, row.Url));
                    id = inherited != null ? NormalizeId(inherited.Id) : NewId();
                }
                used.Add(id);
                row.Id = id;

                row.Name = string.IsNullOrWhiteSpace(row.Name) ? defaultName : row.Name.Trim();
                row.UrlMappings ??= string.Empty;
                row.ApiKey ??= string.Empty;
                row.Role = ArrInstanceRole.Normalize(row.Role);
                row.LinkedLibraryIds = (row.LinkedLibraryIds ?? new List<string>())
                    .Where(l => !string.IsNullOrWhiteSpace(l))
                    .Select(l => l.Trim().ToLowerInvariant())
                    .Distinct(StringComparer.Ordinal)
                    .ToList();
                row.PathMappings = (row.PathMappings ?? new List<ArrPathMapping>())
                    .Where(m => m != null && !string.IsNullOrWhiteSpace(m.ArrPath) && !string.IsNullOrWhiteSpace(m.JellyfinPath))
                    .Select(m => new ArrPathMapping { ArrPath = m.ArrPath.Trim(), JellyfinPath = m.JellyfinPath.Trim() })
                    .ToList();
                row.LiveUpdates = row.LiveUpdates == "off" ? "off" : "auto";
                row.Webhook = row.Webhook == "provisioned" ? "provisioned" : "off";
                if (row.Defaults != null) row.Defaults.Tags ??= new List<int>();
                if (row.Retired) row.IsDefault = false;
                result.Add(row);
            }

            // At most one default per role: the first flagged row wins.
            foreach (var group in result.Where(r => r.IsDefault).GroupBy(r => r.Role))
            {
                foreach (var extra in group.Skip(1)) extra.IsDefault = false;
            }

            return result;
        }

        /// <summary>A fresh instance id.</summary>
        public static string NewId() => Guid.NewGuid().ToString("D");

        /// <summary>True for a GUID-shaped id.</summary>
        public static bool IsValidId(string? id) => !string.IsNullOrWhiteSpace(id) && Guid.TryParse(id, out _);

        private static string NormalizeId(string id) => Guid.Parse(id).ToString("D");

        /// <summary>URL equality ignoring case, surrounding space and a trailing slash.</summary>
        public static bool SameUrl(string? a, string? b)
            => string.Equals((a ?? string.Empty).Trim().TrimEnd('/'), (b ?? string.Empty).Trim().TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
    }
}
