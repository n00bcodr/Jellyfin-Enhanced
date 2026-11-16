namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Hidden tags (#1043): per tag group, the Tag Styles labels (the tiles of the Colours tag list) whose chips
    /// never draw. A label hides exactly the chips it colours: a genre label every spelling of that genre (Other:
    /// every genre without an icon of its own), an age rating board every rating on it, a logo style every logo of
    /// that kind, a language code every chip of that language. Set by the administrator for everyone; null hides
    /// nothing. The rules that read it are TagHiddenRules and TagHiddenSet (Shared/MediaTags/PosterTags).
    /// </summary>
    public class TagHiddenValues
    {
        public string[]? Quality { get; set; }
        public string[]? AgeRating { get; set; }
        public string[]? Rating { get; set; }
        public string[]? Genre { get; set; }
        public string[]? Status { get; set; }
        public string[]? Language { get; set; }
        public string[]? Awards { get; set; }
        public string[]? Logos { get; set; }
        public string[]? Custom { get; set; }
    }
}
