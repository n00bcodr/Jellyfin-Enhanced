using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.Arr
{
    /// <summary>
    /// Represents a single Sonarr or Radarr instance configuration (one row of the
    /// <c>SonarrInstances</c> / <c>RadarrInstances</c> JSON). Which list a row sits in decides its kind.
    /// Fields after <see cref="Enabled"/> are the instance registry (v2) additions; older rows simply
    /// lack them and get the defaults below. Every field must survive a config-page round trip.
    /// </summary>
    public class ArrInstance
    {
        /// <summary>
        /// Stable identifier (lowercase GUID). Assigned once, by the config page or the server's
        /// migration, and never reused; the API key is stored under it in the secrets store.
        /// </summary>
        public string Id { get; set; } = string.Empty;

        /// <summary>
        /// User-assigned display name (e.g., "TV Shows", "Anime", "4K Movies").
        /// </summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// Base URL of the instance (e.g., "http://192.168.1.100:8989").
        /// </summary>
        public string Url { get; set; } = string.Empty;

        /// <summary>
        /// API key for authenticating with the instance. In the stored configuration this is a
        /// <see cref="Services.Secrets.SecretValue"/> placeholder; the getters on
        /// <see cref="Configuration.PluginConfiguration"/> resolve the real key from the secrets store.
        /// </summary>
        public string ApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Optional per-instance URL mappings for reverse-proxy remapping.
        /// Format: newline-separated "jellyfin_url|arr_url" pairs.
        /// </summary>
        public string UrlMappings { get; set; } = string.Empty;

        /// <summary>
        /// When false the instance is skipped by every fan-out path (arr links, calendar,
        /// queue, tag sync) without being removed from config. Lets admins temporarily
        /// disable an instance (maintenance, replacement, etc.) without losing URL/API key.
        /// Defaults to true so existing configs migrate cleanly — old JSON has no Enabled
        /// field and <see cref="System.Text.Json"/> leaves the default value in place.
        /// </summary>
        public bool Enabled { get; set; } = true;

        /// <summary>
        /// What this instance is for: <see cref="ArrInstanceRole.Standard"/>, <see cref="ArrInstanceRole.FourK"/>,
        /// <see cref="ArrInstanceRole.Anime"/> or <see cref="ArrInstanceRole.Custom"/>.
        /// </summary>
        public string Role { get; set; } = ArrInstanceRole.Standard;

        /// <summary>The default instance for its kind and role (at most one per kind and role).</summary>
        public bool IsDefault { get; set; }

        /// <summary>Kept for history but no longer used for anything new (ids are never reused).</summary>
        public bool Retired { get; set; }

        /// <summary>Jellyfin library (collection folder) ids whose content this instance manages.</summary>
        public List<string> LinkedLibraryIds { get; set; } = new();

        /// <summary>How this instance's paths map to the paths Jellyfin sees.</summary>
        public List<ArrPathMapping> PathMappings { get; set; } = new();

        /// <summary>Defaults used when JE adds something to this instance (unset means "ask" / arr default).</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public ArrInstanceDefaults? Defaults { get; set; }

        /// <summary>The matching Seerr server id when this instance was imported from Seerr.</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? SeerrServerId { get; set; }

        /// <summary>Live updates from the arr: "auto" (connect when the feature needs it) or "off".</summary>
        public string LiveUpdates { get; set; } = "auto";

        /// <summary>Webhook state: "off" or "provisioned".</summary>
        public string Webhook { get; set; } = "off";
    }

    /// <summary>Instance roles used for routing (standard, 4K, anime).</summary>
    public static class ArrInstanceRole
    {
        /// <summary>The everyday instance.</summary>
        public const string Standard = "standard";

        /// <summary>A 4K (UHD) instance.</summary>
        public const string FourK = "4k";

        /// <summary>An anime instance.</summary>
        public const string Anime = "anime";

        /// <summary>Any other purpose; never chosen automatically.</summary>
        public const string Custom = "custom";

        /// <summary>The known roles.</summary>
        public static readonly IReadOnlyList<string> All = new[] { Standard, FourK, Anime, Custom };

        /// <summary>Normalises an incoming role ("4K", "Standard", unknown) to a known value.</summary>
        public static string Normalize(string? role)
        {
            var r = (role ?? string.Empty).Trim().ToLowerInvariant();
            foreach (var known in All)
            {
                if (r == known) return known;
            }
            return Standard;
        }
    }

    /// <summary>One arr-path to Jellyfin-path prefix mapping.</summary>
    public class ArrPathMapping
    {
        /// <summary>Path prefix as the arr sees it (e.g. "/movies").</summary>
        public string ArrPath { get; set; } = string.Empty;

        /// <summary>The same folder as Jellyfin sees it (e.g. "/media/movies").</summary>
        public string JellyfinPath { get; set; } = string.Empty;
    }

    /// <summary>Per-instance defaults for adding titles.</summary>
    public class ArrInstanceDefaults
    {
        /// <summary>Quality profile id.</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? QualityProfileId { get; set; }

        /// <summary>Root folder path.</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? RootFolderPath { get; set; }

        /// <summary>Tag ids to apply.</summary>
        public List<int> Tags { get; set; } = new();

        /// <summary>Radarr minimum availability (announced, inCinemas, released).</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? MinimumAvailability { get; set; }

        /// <summary>Sonarr series type (standard, daily, anime).</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? SeriesType { get; set; }
    }
}
