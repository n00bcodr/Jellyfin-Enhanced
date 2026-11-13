using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models
{
    /// <summary>Body of the Maintainerr actions: the item, and for postpone the days (null resets the timer).</summary>
    public class MaintainerrActionRequest
    {
        /// <summary>Gets or sets the item to act on.</summary>
        [JsonPropertyName("itemId")]
        public Guid? ItemId { get; set; }

        /// <summary>Gets or sets the days to postpone by (1–3650), or null to reset the removal timer.</summary>
        [JsonPropertyName("days")]
        public int? Days { get; set; }
    }
}
