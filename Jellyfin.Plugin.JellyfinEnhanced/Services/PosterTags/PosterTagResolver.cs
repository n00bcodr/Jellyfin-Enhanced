using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>
    /// Per-request facts about the poster's item and viewer that the tag-cache entry does not carry.
    /// </summary>
    /// <param name="ItemType">
    /// The card type the rating scope switches test (the web uses the card's <c>data-type</c>);
    /// normally the item's own <c>BaseItemKind</c> name. Empty falls back to the entry's type.
    /// </param>
    /// <param name="Played">The viewer's <c>UserData.Played</c> (or PlayedPercentage &gt;= 100).</param>
    /// <param name="UnplayedItemCount">The viewer's <c>UserData.UnplayedItemCount</c> for folders (Series, Season, BoxSet).</param>
    /// <param name="UserReviewAverage">
    /// The average (1-5) of the reviews on this server that this viewer may see, for the item's
    /// review key (<c>movie:{TmdbId}</c> or <c>tv:{TmdbId}</c>), as <c>GET reviews/ratings</c>
    /// returns it; null when there are none or the key is not a valid TMDB key.
    /// </param>
    /// <param name="UserReviewCount">
    /// Number of reviews behind <paramref name="UserReviewAverage"/>: 0 when the item was looked up
    /// and has none (or its key is invalid), which the web shows as a dash chip; null when review
    /// data is not available for this item, which draws no user-review chip.
    /// </param>
    public sealed record PosterTagItemContext(string ItemType, bool Played, int? UnplayedItemCount, double? UserReviewAverage, int? UserReviewCount);

    /// <summary>
    /// Decides which tags the web would draw on a card, from JE's tag-cache entry and the user's
    /// effective settings: a pure, allocation-light port of the five card tag groups
    /// (js/tags/qualitytags.js, genretags.js, ratingtags.js + userreviewtags.js, ageratingtags.js,
    /// languagetags.js + js/core/media-language.js) and of the pipeline's ordering and top-right
    /// indicator offset (js/tags/tag-pipeline.js, js/core/tag-renderer-base.js). Thread-safe, no I/O.
    /// </summary>
    /// <remarks>
    /// Not reproducible from an image request and therefore ignored: the Continue Watching / Next Up
    /// rating scopes and every other page or row context (details-page poster, search page, My Media,
    /// dialogs), hover-only details, and viewport-dependent sizing.
    /// <para>
    /// Positions are reduced to a <see cref="PosterTagCorner"/> plus one layout-wide top-right offset.
    /// The web stacks containers by their raw position string and offsets only the ones whose string
    /// is exactly "top-right"; for the four strings the settings UIs can produce ("top-left",
    /// "top-right", "bottom-left", "bottom-right") string, corner and offset eligibility coincide.
    /// Hand-edited strings such as "top" next to "top-right" share a corner here but stack and
    /// offset separately in the web; that difference is not modelled.
    /// </para>
    /// </remarks>
    public static class PosterTagResolver
    {
        /// <summary>
        /// The tags to draw, or null when nothing applies.
        /// </summary>
        /// <param name="entry">The JE tag-cache entry, already spoiler-stripped for this viewer.</param>
        /// <param name="settings">The viewer's effective settings.</param>
        /// <param name="context">Viewer and card facts.</param>
        /// <param name="landscape">Whether the image is landscape (aspect &gt; 1.2).</param>
        /// <returns>The layout, or null.</returns>
        public static PosterTagLayout? Resolve(TagCacheEntry entry, PosterTagSettings settings, PosterTagItemContext context, bool landscape)
        {
            ArgumentNullException.ThrowIfNull(entry);
            ArgumentNullException.ThrowIfNull(settings);
            ArgumentNullException.ThrowIfNull(context);
            if (!settings.AnyGroupEnabled) return null;

            // DOM order of the tag containers = paint and stack order. Renderers run in registration
            // order (quality, genre, rating, age rating, language), except that quality registers
            // late when it waits for the Jellyfin audio preference.
            var groups = new List<PosterTagGroupLayout>(5);
            PosterTagGroupLayout? reviewOnly = null;

            PosterTagGroupLayout? quality = settings.QualityTagsEnabled ? ResolveQuality(entry, settings) : null;
            if (quality is not null && !settings.UsesJellyfinAudioPreference) groups.Add(quality);

            if (settings.GenreTagsEnabled && GenreIcons.Resolve(entry.Genres) is { } genres)
            {
                groups.Add(Group(PosterTagGroup.Genre, settings, genres));
            }

            if (settings.RatingTagsEnabled)
            {
                var cardType = string.IsNullOrEmpty(context.ItemType) ? entry.Type : context.ItemType;
                if (!RatingRules.IsExcludedByScope(cardType, settings))
                {
                    var rating = RatingRules.ResolveScores(entry);
                    var review = context.UserReviewCount is null
                        ? null
                        : RatingRules.ResolveUserReview(entry, settings, context.UserReviewCount == 0 ? null : context.UserReviewAverage);
                    if (rating.Count > 0)
                    {
                        if (review is not null) rating.Add(review);
                        groups.Add(Group(PosterTagGroup.Rating, settings, rating));
                    }
                    else if (review is not null)
                    {
                        // The review lookup is async: with no score chips its container is created
                        // when the lookup settles, after every other container.
                        reviewOnly = Group(PosterTagGroup.Rating, settings, new List<PosterTag>(1) { review });
                    }
                }
            }

            if (settings.AgeRatingTagsEnabled && AgeRatingRules.Resolve(entry.OfficialRating) is { } age)
            {
                groups.Add(Group(PosterTagGroup.AgeRating, settings, new List<PosterTag>(1) { age }));
            }

            if (settings.LanguageTagsEnabled
                && LanguageFlagRules.Resolve(entry.AudioLanguages, entry.PartialAudioLanguages, settings.LanguagePriorityTerms, settings.LanguagePriorityStrict) is { } flags)
            {
                var tags = new List<PosterTag>(flags.Count);
                foreach (var flag in flags)
                {
                    tags.Add(new LanguageTag(LanguageFlagRules.ToFlagCode(flag.CountryCode), string.Join(", ", flag.AllLanguages), flag.Partial));
                }

                groups.Add(Group(PosterTagGroup.Language, settings, tags));
            }

            if (quality is not null && settings.UsesJellyfinAudioPreference) groups.Add(quality);
            if (reviewOnly is not null) groups.Add(reviewOnly);
            if (groups.Count == 0) return null;

            return new PosterTagLayout(groups, HasTopRightOffset(groups, settings, context), landscape);
        }

        /// <summary>
        /// Whether jellyfin-web would show a played check mark or an unplayed count on this card
        /// (indicators.getPlayedIndicatorHtml; every tagged item type can be marked played).
        /// </summary>
        /// <param name="context">Viewer and card facts.</param>
        /// <returns>True when an indicator is shown.</returns>
        public static bool ShowsPlayedIndicator(PosterTagItemContext context)
        {
            ArgumentNullException.ThrowIfNull(context);
            return context.UnplayedItemCount is > 0 || context.Played;
        }

        /// <summary>
        /// tag-pipeline.js buildIndicatorOffsetCSS: containers whose position is exactly "top-right"
        /// move down when the card shows a played or unplayed-count indicator.
        /// </summary>
        private static bool HasTopRightOffset(List<PosterTagGroupLayout> groups, PosterTagSettings settings, PosterTagItemContext context)
        {
            if (!ShowsPlayedIndicator(context)) return false;
            foreach (var group in groups)
            {
                if (string.Equals(settings.PositionOf(group.Group), "top-right", StringComparison.Ordinal)) return true;
            }

            return false;
        }

        private static PosterTagGroupLayout? ResolveQuality(TagCacheEntry entry, PosterTagSettings settings)
        {
            var labels = QualityTagRules.Detect(entry.StreamData, settings.PreferredAudioLanguage);
            if (labels.Count == 0) return null;
            var tags = QualityTagRules.Arrange(labels, settings);
            if (tags.Count == 0) return null;
            var list = new List<PosterTag>(tags.Count);
            list.AddRange(tags);
            return Group(PosterTagGroup.Quality, settings, list);
        }

        private static PosterTagGroupLayout Group<T>(PosterTagGroup group, PosterTagSettings settings, List<T> tags)
            where T : PosterTag
        {
            IReadOnlyList<PosterTag> list = tags is List<PosterTag> same ? same : tags.ConvertAll(t => (PosterTag)t);
            return new PosterTagGroupLayout(group, PosterTagSettings.CornerOf(settings.PositionOf(group)), list);
        }
    }
}
