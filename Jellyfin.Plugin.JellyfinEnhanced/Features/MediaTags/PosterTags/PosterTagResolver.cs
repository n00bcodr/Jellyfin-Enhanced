using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Resolution;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags
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
    /// effective settings: a pure, allocation-light port of the card tag groups
    /// (js/tags/qualitytags.js, genretags.js, ratingtags.js + userreviewtags.js, ageratingtags.js,
    /// languagetags.js + js/core/media-language.js, logotags.js, customtags.js) and of the pipeline's ordering and top-right
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
            // order (quality, genre, rating, age rating, language, logos, custom), except that quality registers
            // late when it waits for the Jellyfin audio preference.
            var groups = new List<PosterTagGroupLayout>(9);
            PosterTagGroupLayout? reviewOnly = null;
            // A group shows when it is switched on and its "Where to show" includes this item type.
            bool On(PosterTagGroup group) => settings.Shows(group) && settings.ScopeAllows(group, context.ItemType);

            PosterTagGroupLayout? quality = On(PosterTagGroup.Quality) ? ResolveQuality(entry, settings) : null;
            if (quality is not null && !settings.UsesJellyfinAudioPreference) groups.Add(quality);

            if (On(PosterTagGroup.Genre) && GenreIcons.Resolve(entry.Genres, settings.GenreCap) is { } genres)
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

            if (On(PosterTagGroup.AgeRating) && AgeRatingRules.Resolve(entry.OfficialRating) is { } age)
            {
                groups.Add(Group(PosterTagGroup.AgeRating, settings, new List<PosterTag>(1) { age }));
            }

            if (On(PosterTagGroup.Status) && StatusRules.Resolve(entry, settings, context.Status ?? new PosterStatusContext(DateTimeOffset.UtcNow)) is { } status)
                groups.Add(Group(PosterTagGroup.Status, settings, new List<PosterTag>(1) { status }));
            if (On(PosterTagGroup.Custom) && ResolveCustom(entry, settings) is { } custom)
            {
                groups.Add(Group(PosterTagGroup.Custom, settings, custom));
            }

            if (On(PosterTagGroup.Language) && LanguageFlagRules.ResolveGroup(entry, settings) is { } languages)
            {
                groups.Add(Group(PosterTagGroup.Language, settings, languages));
            }

            if (On(PosterTagGroup.Logos) && LogoRules.Resolve(entry.Logos) is { } logos)
            {
                groups.Add(Group(PosterTagGroup.Logos, settings, logos));
            }

            if (quality is not null && settings.UsesJellyfinAudioPreference) groups.Add(quality);
            if (reviewOnly is not null) groups.Add(reviewOnly);
            if (On(PosterTagGroup.Awards) && entry.Awards is { } awards)
            {
                var tags = new List<PosterTag>();
                // Captions come from the vocabulary the web translates (awardstags.js CAPTION_KEYS).
                string Caption(string key) => StatusRules.Text(key, settings.StatusCulture);
                if (settings.AwardsImdb && awards.ImdbRank is > 0 and <= 250) tags.Add(new AwardTag("imdbTop250", Caption("awards_tags_label_imdbTop250")));
                if (settings.AwardsCertifiedFresh && awards.CertifiedFresh) tags.Add(new AwardTag("certifiedFresh", Caption("awards_tags_label_certifiedFresh")));
                if (settings.AwardsOscar && awards.OscarWinner) tags.Add(new AwardTag("oscar", Caption("awards_tags_oscar")));
                if (settings.AwardsEmmy && awards.EmmyWinner) tags.Add(new AwardTag("emmy", Caption("awards_tags_emmy")));
                if (settings.AwardsLetterboxd && awards.LetterboxdRank is > 0 and <= 250) tags.Add(new AwardTag("letterboxdTop250", Caption("awards_tags_label_imdbTop250")));
                if (tags.Count > 0) groups.Add(Group(PosterTagGroup.Awards, settings, tags));
            }
            if (groups.Count == 0) return null;

            // An explicit priority order replaces arrival order: groups sharing a corner stack in it
            // (core/tag-layout.js rankOf). List.Sort is unstable, but every group appears once.
            if (settings.GroupOrder is { } order)
            {
                groups.Sort((a, b) => IndexOf(order, a.Group).CompareTo(IndexOf(order, b.Group)));
            }

            return new PosterTagLayout(groups, HasTopRightOffset(groups, settings, context), landscape, settings.Styles, settings.Bands) { TagScale = settings.TagScale, TagGap = settings.TagGap, KindLooks = settings.KindLooks, EdgeInset = settings.Bands ? 6f : settings.EdgeInset };
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
            // Flush is an exact zero policy value, not a near-zero distance.
            if (settings.Bands || (settings.EdgeInset.Equals(0f) && groups.Any(g => g.Corner == PosterTagCorner.TopCenter))) return true;
            foreach (var group in groups)
            {
                if (string.Equals(settings.PositionOf(group.Group), "top-right", StringComparison.Ordinal)) return true;
            }

            return false;
        }

        private static PosterTagGroupLayout? ResolveQuality(TagCacheEntry entry, PosterTagSettings settings)
        {
            var labels = SeriesQualityAggregation.Resolve(entry, settings.SeriesQualityAggregation, settings.PreferredAudioLanguage, settings.IsQualityCategoryShown, settings.AllQualityValues, settings.LegacyAudioFacts);
            if (labels.Count == 0) return null;
            var tags = QualityTagRules.Arrange(labels, settings);
            if (tags.Count == 0) return null;
            var list = new List<PosterTag>(tags.Count);
            list.AddRange(tags);
            return Group(PosterTagGroup.Quality, settings, list);
        }

        /// <summary>
        /// customtags.js rulesFor: the rules the entry matched, in the current rule table order
        /// (the cached ids are a set: a reorder needs no re-match), skipping ids no rule has any
        /// more; null when none is left.
        /// </summary>
        private static List<PosterTag>? ResolveCustom(TagCacheEntry entry, PosterTagSettings settings)
        {
            if (entry.CustomTags is not { Length: > 0 } ids) return null;
            var matcher = settings.CustomTagRules;
            List<PosterTag>? tags = null;
            for (var i = 0; i < matcher.Rules.Count; i++)
            {
                var id = matcher.Ids[i];
                if (Array.IndexOf(ids, id) < 0) continue;
                tags ??= new List<PosterTag>(ids.Length);
                tags.Add(new CustomTag(matcher.Rules[i].Label, matcher.Rules[i].Icon, id));
            }

            return tags;
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
            if (group == PosterTagGroup.Quality)
            {
                // "2 versions" in the user's language; Compact "×2" (qualitytags.js versionsText).
                list = list.Select(t => t is QualityTag { Category: QualityTagRules.Versions } q
                    ? q with { DisplayText = settings.CompactLabels ? "×" + q.Label : (long.TryParse(q.Label, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var versions) ? StatusRules.Text("quality_versions_count", settings.StatusCulture, versions) : StatusRules.Text("quality_versions_count", settings.StatusCulture)).Replace("{count}", q.Label, StringComparison.Ordinal) }
                    : t).ToList();
            }

            // A runtime in the user's own hour and minute abbreviations (the label stays the chip's identity).
            if (!settings.CompactLabels && group == PosterTagGroup.Quality)
            {
                list = list.Select(t => t is QualityTag { Category: QualityTagRules.Runtime, DisplayText: null } q
                    && TechnicalQualityRules.RuntimeText(q.Label, false, settings.StatusCulture) is var text && text != q.Label ? q with { DisplayText = text } : t).ToList();
            }

            if (!settings.CompactLabels && group == PosterTagGroup.Quality && settings.StatusCulture.Name is { Length: > 0 } culture && !culture.StartsWith("en", StringComparison.Ordinal))
            {
                list = list.Select(t => t is QualityTag q && q.DisplayText is null && FullQuality(q.Label, settings) is { } text ? q with { DisplayText = text } : t).ToList();
            }

            if (settings.CompactLabels)
            {
                if (group == PosterTagGroup.Quality) list = list.Select(t => t is QualityTag q && q.Category != QualityTagRules.Versions ? q with { DisplayText = q.Category == QualityTagRules.Runtime ? TechnicalQualityRules.RuntimeText(q.Label, true, settings.StatusCulture) : q.Category is QualityTagRules.AspectRatio or QualityTagRules.FrameRate ? TechnicalQualityRules.Compact(q.Label, q.Category) : CompactQuality(q.Label, settings) } : t).ToList();
                if (group == PosterTagGroup.Rating && list.OfType<RatingTag>().Any(t => t.Source == PosterRatingSource.Community))
                    list.RemoveAll(t => t is RatingTag { Source: PosterRatingSource.Critic });
            }
            var cap = settings.CapOf(group);
            if (cap > 0 && list.Count > cap) list.RemoveRange(cap, list.Count - cap);
            return new PosterTagGroupLayout(group, PosterTagSettings.CornerOf(settings.PositionOf(group)), list);
        }

        /// <summary>The web's compact quality labels, retaining the full label for colour identity.</summary>
        private static string CompactQuality(string label, PosterTagSettings settings)
        {
            var exact = label switch {
                "Director's Cut" => "DC", "Extended" => "Ext", "Unrated" => "Unr", "Remastered" => "Rem", "Criterion" => "CC",
                "Ultimate" => "Ult", "Collector's Edition" => "CE", "Anniversary" => "Anniv", "Uncensored" => "Unc", "Open Matte" => "OM",
                "Rogue Cut" => "Rogue", "Black and Chrome" => "B&C", "Masters of Cinema" => "MoC", "Producer's Cut" => "PC", "Alternate Cut" => "Alt",
                "Assembly Cut" => "Asm", "International Cut" => "Intl", "Restored" => "Rest", "Hybrid" => "Hyb",
                "Roadshow" => "Road", "Despecialized" => "Despec", "Fan Edit" => "Fan",
                "Special Edition" => StatusRules.Text("quality_edition_special_compact", settings.StatusCulture), "Mixed" => "±", _ => null };
            return exact ?? QualityTagRules.CompactLabel(label);
        }

        // Full words the web translates (qualitytags.js EDITIONS and the Mixed marker); codecs and proper nouns stay literal.
        private static readonly Dictionary<string, string> TranslatedQualityLabels = new(StringComparer.Ordinal)
        {
            ["Director's Cut"] = "quality_edition_directors_cut", ["Extended"] = "quality_edition_extended", ["Unrated"] = "quality_edition_unrated",
            ["Theatrical"] = "quality_edition_theatrical", ["Remastered"] = "quality_edition_remastered", ["Uncut"] = "quality_edition_uncut",
            ["Final Cut"] = "quality_edition_final_cut", ["Special Edition"] = "quality_edition_special", ["Ultimate"] = "quality_edition_ultimate",
            ["Collector's Edition"] = "quality_edition_collectors", ["Anniversary"] = "quality_edition_anniversary", ["Uncensored"] = "quality_edition_uncensored",
            ["Producer's Cut"] = "quality_edition_producers_cut", ["Alternate Cut"] = "quality_edition_alternate_cut", ["Assembly Cut"] = "quality_edition_assembly_cut",
            ["International Cut"] = "quality_edition_international_cut", ["Restored"] = "quality_edition_restored", ["Hybrid"] = "quality_edition_hybrid",
            ["Roadshow"] = "quality_edition_roadshow", ["Fan Edit"] = "quality_edition_fan_edit",
            ["Mixed"] = "series_quality_mixed",
        };

        /// <summary>A Full-density quality label in the user's language where the web translates it, else null (the label itself).</summary>
        private static string? FullQuality(string label, PosterTagSettings settings)
        {
            if (!TranslatedQualityLabels.TryGetValue(label, out var key)) return null;
            var text = StatusRules.Text(key, settings.StatusCulture);
            return text == label ? null : text;
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
