using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>Card anchor for a tag group (four corners and five centre positions).</summary>
    public enum PosterTagCorner
    {
        TopLeft,
        TopRight,
        BottomLeft,
        BottomRight,
        TopCenter,
        BottomCenter,
        CenterLeft,
        CenterRight,
        Center,
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
        Status,
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
        Imdb, Tmdb, RtCritic, RtAudience, Metacritic, Letterboxd, Trakt,
    }

    /// <summary>One resolved tag. Carries meaning, not visuals; the renderer owns colours, icons and sizes.</summary>
    public abstract record PosterTag;

    /// <summary>
    /// A quality chip such as "4K", "HDR10", "Dolby Vision", "HEVC", "Atmos 7.1".
    /// <paramref name="Label"/> is the exact text the web shows; <paramref name="Category"/> is the web's
    /// quality category key (resolution, source, dynamicRange, specialFormat, videoCodec, audioInfo).
    /// </summary>
    public sealed record QualityTag(string Label, string Category, string? DisplayText = null) : PosterTag;

    /// <summary>A genre chip. <paramref name="Icon"/> is the Material Symbols glyph name the web uses.</summary>
    public sealed record GenreTag(string Genre, string Icon) : PosterTag;

    /// <summary>
    /// A language flag. <paramref name="FlagCode"/> is the flag-icons code (e.g. "gb", "es-ct") or
    /// "no-dialogue"; <paramref name="Partial"/> marks a language present on only some episodes.
    /// </summary>
    public sealed record LanguageTag(string FlagCode, string Language, bool Partial) : PosterTag
    {
        /// <summary>A subtitle chip, with a CC prefix.</summary>
        public bool Subtitle { get; init; }
        /// <summary>Uppercase ISO code for Codes style; null for a flag.</summary>
        public string? Code { get; init; }
        /// <summary>Dual/Multi audio count label, or null for a language chip.</summary>
        public string? CountBadge { get; init; }
    }

    /// <summary>
    /// A rating chip. <paramref name="Text"/> is the formatted value exactly as the web shows it
    /// ("83%", "7.5", "—"). <paramref name="Fresh"/> selects the fresh/rotten icon for critic ratings.
    /// </summary>
    public sealed record RatingTag(PosterRatingSource Source, string Text, bool Fresh, string? ScoreColor = null, bool Compact = false) : PosterTag
    {
        /// <summary>Stable source id, shared with web selectors and Tag Styles labels.</summary>
        public string SourceId => Source switch
        {
            PosterRatingSource.UserReview => "userReview", PosterRatingSource.RtCritic => "rtCritic",
            PosterRatingSource.RtAudience => "rtAudience", _ => Source.ToString().ToLowerInvariant()
        };
        public bool IsSource => Source is not (PosterRatingSource.Community or PosterRatingSource.Critic or PosterRatingSource.UserReview);
    }

    /// <summary>An age rating badge. <paramref name="ColorKey"/> is the normalised key used by the web's rating colours.</summary>
    public sealed record AgeRatingTag(string Text, string ColorKey) : PosterTag;

    /// <summary>One localized status chip, styled with the web vocabulary's stable label key.</summary>
    public sealed record StatusTag(string Key, string Text, string StyleKey) : PosterTag;

    /// <summary>Renderer-generated omission count; uses the dedicated .je-tag-more style.</summary>
    internal sealed record OverflowTag(int Count) : PosterTag;

    /// <summary>The tags of one group and where they go.</summary>
    public sealed record PosterTagGroupLayout(PosterTagGroup Group, PosterTagCorner Corner, IReadOnlyList<PosterTag> Tags);

    /// <summary>
    /// Everything the renderer needs to draw one poster's tags.
    /// <paramref name="TopRightOffset"/> mirrors the web rule that pushes top-right tags down when the card shows a
    /// played or unplayed-count indicator. <paramref name="Landscape"/> selects the landscape logical card width.
    /// </summary>
    public sealed record PosterTagLayout(IReadOnlyList<PosterTagGroupLayout> Groups, bool TopRightOffset, bool Landscape, TagStyleSet? Styles = null, bool Bands = false)
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
