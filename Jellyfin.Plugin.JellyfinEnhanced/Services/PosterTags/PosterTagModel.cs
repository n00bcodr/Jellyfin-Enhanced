using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>Card corner a tag group is anchored to.</summary>
    public enum PosterTagCorner
    {
        TopLeft,
        TopRight,
        BottomLeft,
        BottomRight,
    }

    /// <summary>
    /// Tag groups in the web's paint and stacking order: groups sharing a corner stack in this order,
    /// pushed away from the corner.
    /// </summary>
    public enum PosterTagGroup
    {
        Quality,
        Genre,
        Rating,
        AgeRating,
        Language,
    }

    /// <summary>Rating chip source.</summary>
    public enum PosterRatingSource
    {
        /// <summary>Critic rating (Rotten Tomatoes style), value is a percentage.</summary>
        Critic,

        /// <summary>Community rating (TMDB/IMDb style star), value is out of 10.</summary>
        Community,

        /// <summary>Average of this server's user reviews (person_heart chip).</summary>
        UserReview,
    }

    /// <summary>One resolved tag. Carries meaning, not visuals; the renderer owns colours, icons and sizes.</summary>
    public abstract record PosterTag;

    /// <summary>
    /// A quality chip such as "4K", "HDR10", "Dolby Vision", "HEVC", "Atmos 7.1".
    /// <paramref name="Label"/> is the exact text the web shows; <paramref name="Category"/> is the web's
    /// quality category key (resolution, source, dynamicRange, specialFormat, videoCodec, audioInfo).
    /// </summary>
    public sealed record QualityTag(string Label, string Category) : PosterTag;

    /// <summary>A genre chip. <paramref name="Icon"/> is the Material Symbols glyph name the web uses.</summary>
    public sealed record GenreTag(string Genre, string Icon) : PosterTag;

    /// <summary>
    /// A language flag. <paramref name="FlagCode"/> is the flag-icons code (e.g. "gb", "es-ct") or
    /// "no-dialogue"; <paramref name="Partial"/> marks a language present on only some episodes.
    /// </summary>
    public sealed record LanguageTag(string FlagCode, string Language, bool Partial) : PosterTag;

    /// <summary>
    /// A rating chip. <paramref name="Text"/> is the formatted value exactly as the web shows it
    /// ("83%", "7.5", "—"). <paramref name="Fresh"/> selects the fresh/rotten icon for critic ratings.
    /// </summary>
    public sealed record RatingTag(PosterRatingSource Source, string Text, bool Fresh) : PosterTag;

    /// <summary>An age rating badge. <paramref name="ColorKey"/> is the normalised key used by the web's rating colours.</summary>
    public sealed record AgeRatingTag(string Text, string ColorKey) : PosterTag;

    /// <summary>The tags of one group and where they go.</summary>
    public sealed record PosterTagGroupLayout(PosterTagGroup Group, PosterTagCorner Corner, IReadOnlyList<PosterTag> Tags);

    /// <summary>
    /// Everything the renderer needs to draw one poster's tags.
    /// <paramref name="TopRightOffset"/> mirrors the web rule that pushes top-right tags down when the card shows a
    /// played or unplayed-count indicator. <paramref name="Landscape"/> selects the landscape logical card width.
    /// </summary>
    public sealed record PosterTagLayout(IReadOnlyList<PosterTagGroupLayout> Groups, bool TopRightOffset, bool Landscape)
    {
        /// <summary>True when nothing would be drawn.</summary>
        public bool IsEmpty
        {
            get
            {
                foreach (var group in Groups)
                {
                    if (group.Tags.Count > 0) return false;
                }

                return true;
            }
        }
    }
}
