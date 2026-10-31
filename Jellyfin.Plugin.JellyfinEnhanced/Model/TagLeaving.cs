using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>
    /// Leaving soon facts (Status group, schema v19): the item is in a Maintainerr
    /// collection or one of the administrator's leaving collections. Immutable and
    /// value-compared, so entries can share one instance.
    /// </summary>
    public sealed record TagLeaving
    {
        /// <summary>When Maintainerr deletes it (addDate + deleteAfterDays), Unix ms UTC; null when no date is known.</summary>
        public long? DeleteAt { get; init; }

        /// <summary>
        /// Where an undated fact came from when only the administrator's leaving collections
        /// produced it: those collections' ids (N format, sorted, comma-separated). Null when
        /// Maintainerr supplied it, which every viewer of the item may see. Kept on the server:
        /// per-user projections drop it and serve the fact only to a user who can access one
        /// of these collections (see <c>LeavingSoonService.Visible</c>).
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Collections { get; init; }
    }
}
