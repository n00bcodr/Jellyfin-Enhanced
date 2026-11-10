using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Models
{
    /// <summary>The body of <see cref="PatchConfiguration"/>.</summary>
    public sealed class ConfigurationPatchRequest
    {
        /// <summary>Gets or sets the changed fields (PluginConfiguration property name → value).</summary>
        public Dictionary<string, JsonElement>? Changes { get; set; }

        /// <summary>Gets or sets, per changed field, the value read before it was edited.</summary>
        public Dictionary<string, JsonElement>? Expected { get; set; }
    }
}
