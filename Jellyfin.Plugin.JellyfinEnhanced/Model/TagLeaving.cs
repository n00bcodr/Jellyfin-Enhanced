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
    }
}
