namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>Provider ids as the arrs send them: 0 (or less) means "none", never a title.</summary>
    public static class ArrIds
    {
        /// <summary>The id, or null when it is missing, 0 or negative.</summary>
        public static int? Positive(int? id) => id is > 0 ? id : null;
    }
}
