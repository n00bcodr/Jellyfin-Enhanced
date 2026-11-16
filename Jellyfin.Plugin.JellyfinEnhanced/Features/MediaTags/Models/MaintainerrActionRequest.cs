using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models
{
    /// <summary>Body of the Maintainerr actions: the item, for postpone the days (null resets the timer), for mark the version picked on the item page.</summary>
    public class MaintainerrActionRequest
    {
        /// <summary>Gets or sets the item to act on.</summary>
        [JsonPropertyName("itemId")]
        public Guid? ItemId { get; set; }

        /// <summary>Gets or sets the days to postpone by (1–3650), or null to reset the removal timer.</summary>
        [JsonPropertyName("days")]
        public int? Days { get; set; }

        /// <summary>Gets or sets the version (media source id) picked on the item page, for mark: it tells apart the 4K and 1080p copies of one movie.</summary>
        [JsonPropertyName("mediaSourceId")]
        public string? MediaSourceId { get; set; }
    }
}
