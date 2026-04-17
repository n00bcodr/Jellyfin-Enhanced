namespace Jellyfin.Plugin.JellyfinEnhanced.Model.Arr
{
    /// <summary>
    /// Represents a single Sonarr or Radarr instance configuration.
    /// </summary>
    public class ArrInstance
    {
        /// <summary>
        /// User-assigned display name (e.g., "TV Shows", "Anime", "4K Movies").
        /// </summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// Base URL of the instance (e.g., "http://192.168.1.100:8989").
        /// </summary>
        public string Url { get; set; } = string.Empty;

        /// <summary>
        /// API key for authenticating with the instance.
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
    }
}
