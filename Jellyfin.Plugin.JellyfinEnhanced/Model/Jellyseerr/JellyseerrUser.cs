using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.Seerr {
    public class JellyseerrUser
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("jellyfinUserId")]
        public string? JellyfinUserId { get; set; }

        [JsonPropertyName("permissions")]
        public JellyseerrPermission Permissions { get; set; }
    }
}
