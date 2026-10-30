using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
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
    public sealed record PosterTagItemContext(string ItemType, bool Played, int? UnplayedItemCount, double? UserReviewAverage, int? UserReviewCount, PosterStatusContext? Status = null);

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

            PosterTagGroupLayout? quality = settings.Shows(PosterTagGroup.Quality) ? ResolveQuality(entry, settings) : null;
            if (quality is not null && !settings.UsesJellyfinAudioPreference) groups.Add(quality);

            if (settings.Shows(PosterTagGroup.Genre) && GenreIcons.Resolve(entry.Genres, settings.GenreCap) is { } genres)
            {
                groups.Add(Group(PosterTagGroup.Genre, settings, genres));
            }

            if (settings.Shows(PosterTagGroup.Rating))
            {
                var cardType = string.IsNullOrEmpty(context.ItemType) ? entry.Type : context.ItemType;
                if (!RatingRules.IsExcludedByScope(cardType, settings))
                {
                    var rating = RatingRules.ResolveScores(entry, settings);
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

            if (settings.Shows(PosterTagGroup.AgeRating) && AgeRatingRules.Resolve(entry.OfficialRating) is { } age)
            {
                groups.Add(Group(PosterTagGroup.AgeRating, settings, new List<PosterTag>(1) { age }));
            }

            if (settings.Shows(PosterTagGroup.Status) && StatusRules.Resolve(entry, settings, context.Status ?? new PosterStatusContext(DateTimeOffset.UtcNow)) is { } status)
                groups.Add(Group(PosterTagGroup.Status, settings, new List<PosterTag>(1) { status }));

            if (settings.Shows(PosterTagGroup.Language) && LanguageFlagRules.ResolveGroup(entry, settings) is { } languages)
            {
                groups.Add(Group(PosterTagGroup.Language, settings, languages));
            }

            if (quality is not null && settings.UsesJellyfinAudioPreference) groups.Add(quality);
            if (reviewOnly is not null) groups.Add(reviewOnly);
            if (settings.Shows(PosterTagGroup.Awards) && entry.Awards is { } awards)
            {
                var tags = new List<PosterTag>();
                if (settings.AwardsImdb && awards.ImdbRank is > 0 and <= 250) tags.Add(new AwardTag("imdbTop250", "Top 250"));
                if (settings.AwardsCertifiedFresh && awards.CertifiedFresh) tags.Add(new AwardTag("certifiedFresh", "Certified Fresh"));
                if (settings.AwardsOscar && awards.OscarWinner) tags.Add(new AwardTag("oscar", "Oscar winner"));
                if (settings.AwardsEmmy && awards.EmmyWinner) tags.Add(new AwardTag("emmy", "Emmy winner"));
                if (settings.AwardsLetterboxd && awards.LetterboxdRank is > 0 and <= 250) tags.Add(new AwardTag("letterboxdTop250", "Top 250"));
                if (tags.Count > 0) groups.Add(Group(PosterTagGroup.Awards, settings, tags));
            }
            if (groups.Count == 0) return null;

            // An explicit priority order replaces arrival order: groups sharing a corner stack in it
            // (core/tag-layout.js rankOf). List.Sort is unstable, but every group appears once.
            if (settings.GroupOrder is { } order)
            {
                groups.Sort((a, b) => IndexOf(order, a.Group).CompareTo(IndexOf(order, b.Group)));
            }

            return new PosterTagLayout(groups, HasTopRightOffset(groups, settings, context), landscape, settings.Styles, settings.Bands) { TagScale = settings.TagScale, TagGap = settings.TagGap };
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
            if (settings.Bands) return true;
            foreach (var group in groups)
            {
                if (string.Equals(settings.PositionOf(group.Group), "top-right", StringComparison.Ordinal)) return true;
            }

            return false;
        }

        private static PosterTagGroupLayout? ResolveQuality(TagCacheEntry entry, PosterTagSettings settings)
        {
            var labels = SeriesQualityAggregation.Resolve(entry, settings.SeriesQualityAggregation, settings.PreferredAudioLanguage, settings.IsQualityCategoryShown);
            if (labels.Count == 0) return null;
            var tags = QualityTagRules.Arrange(labels, settings);
            if (tags.Count == 0) return null;
            var list = new List<PosterTag>(tags.Count);
            list.AddRange(tags);
            return Group(PosterTagGroup.Quality, settings, list);
        }

        /// <summary>
        /// The group with the user's cap applied to its final chips (core/tag-layout.js
        /// applyDensityAndCap: the first N chips stay, 0 keeps all). Genre and language apply
        /// their caps while resolving, where the cap also decides which chips are checked.
        /// </summary>
        private static PosterTagGroupLayout Group<T>(PosterTagGroup group, PosterTagSettings settings, List<T> tags)
            where T : PosterTag
        {
            List<PosterTag> list = tags is List<PosterTag> same ? same : tags.ConvertAll(t => (PosterTag)t);
            if (settings.CompactBands)
            {
                if (group == PosterTagGroup.Quality) list = list.Select(t => t is QualityTag q ? q with { DisplayText = CompactQuality(q.Label) } : t).ToList();
                if (group == PosterTagGroup.Rating && list.OfType<RatingTag>().Any(t => t.Source == PosterRatingSource.Community))
                    list.RemoveAll(t => t is RatingTag { Source: PosterRatingSource.Critic });
            }
            var cap = settings.CapOf(group);
            if (cap > 0 && list.Count > cap) list.RemoveRange(cap, list.Count - cap);
            return new PosterTagGroupLayout(group, PosterTagSettings.CornerOf(settings.PositionOf(group)), list);
        }

        /// <summary>The web's compact quality labels, retaining the full label for colour identity.</summary>
        private static string CompactQuality(string label)
        {
            var exact = label switch { "Dolby Vision" => "DV", "HDR10+" => "HDR+", "Dolby Digital+" => "DD+", "BluRay" => "BD",
                "Director's Cut" => "DC", "Extended" => "Ext", "Unrated" => "Unr", "Remastered" => "Rem", "Criterion" => "CC", "Special Edition" => "Special", "Mixed" => "±", _ => null };
            if (exact != null) return exact;
            var audio = Regex.Match(label, @"^(ATMOS|DTS-X|TRUEHD|DTS|Dolby Digital\+) (\d+\.\d+)$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
            return audio.Success ? audio.Groups[audio.Groups[1].Value == "Dolby Digital+" ? 2 : 1].Value : label;
        }

        private static int IndexOf(IReadOnlyList<PosterTagGroup> order, PosterTagGroup group)
        {
            for (var i = 0; i < order.Count; i++)
            {
                if (order[i] == group) return i;
            }

            return order.Count;
        }
    }
}
