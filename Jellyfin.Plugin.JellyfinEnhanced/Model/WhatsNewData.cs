using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>
    /// Every setting control id as of the last acknowledged state (dismiss,
    /// or first run), plus the plugin version at that point. Diffed against
    /// the current set on every startup to auto-detect newly added settings.
    /// Persisted to config-schema-snapshot.json (see WhatsNewService).
    /// </summary>
    public class ConfigSchemaSnapshot
    {
        public string PluginVersion { get; set; } = string.Empty;
        public List<string> SettingIds { get; set; } = new();
    }

    /// <summary>
    /// The settings currently pending, each tagged with the version it was
    /// first detected in. PluginVersion is the most recently observed
    /// running version, used for the release-notes link. Persisted to
    /// whats-new.json (see WhatsNewService); deleted once nothing is pending.
    /// </summary>
    public class WhatsNewState
    {
        public string PluginVersion { get; set; } = string.Empty;
        /// <summary>Setting id -> the plugin version it was first detected in.</summary>
        public Dictionary<string, string> NewSettings { get; set; } = new();
    }
}
