using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Port of the server-cache path of <c>js/tags/ratingtags.js</c> (critic tomato and community
    /// star chips, item-type scope switches) and of <c>js/tags/userreviewtags.js</c> (the
    /// person_heart chip with the average of this server's user reviews).
    /// </summary>
    internal static class RatingRules
    {
        /// <summary>Critic scores below this are "rotten".</summary>
        public const int FreshThreshold = 60;

        /// <summary>Shown instead of a zero community rating, and for a missing user-review average.</summary>
        public const string Dash = "\u2014";

        /// <summary>
        /// The configured source chips, filtered by minimum score. Legacy documents retain
        /// the critic/community include switches and their original ordering. Empty when none is left;
        /// the web then creates no rating container of its own.
        /// </summary>
        public static List<PosterTag> ResolveScores(TagCacheEntry entry, PosterTagSettings settings)
        {
            var tags = new List<PosterTag>();
            var sources = settings.RatingTagsSources ?? new[] { "critic", "community" };
            foreach (var id in sources)
            {
                if (settings.RatingTagsSources == null && ((id == "community" && !settings.RatingTagsShowCommunity) || (id == "critic" && !settings.RatingTagsShowCritic))) continue;
                double? raw = id == "community" ? entry.CommunityRating : id == "critic" ? entry.CriticRating : entry.Ratings?.Get(id);
                if (raw is not { } value || !double.IsFinite(value)) continue;
                // Legacy DTOs are floats; JS receives their shortest decimal JSON, then formats
                // community to one decimal / critic to a percent before the shared source helper.
                if (id == "community" && entry.CommunityRating is { } community)
                    value = double.Parse(JsText.ToFixed(JsText.FloatAsJsNumber(community), 1), CultureInfo.InvariantCulture);
                if (id == "critic" && entry.CriticRating is { } critic)
                    value = JsText.MathRound(JsText.FloatAsJsNumber(critic));
                var maximum = id is "community" or "imdb" ? 10 : id == "letterboxd" ? 5 : 100;
                value = Math.Clamp(value, 0, maximum);
                var score = value * 10 / maximum;
                if (score < settings.RatingTagsMinScore) continue;
                var text = id == "community" && value == 0 ? Dash : maximum <= 10
                    ? JsText.ToFixed(value, 1)
                    : JsText.MathRound(value).ToString(CultureInfo.InvariantCulture) + (id == "metacritic" ? "" : "%");
                if (!Enum.TryParse<PosterRatingSource>(id, true, out var source)) continue;
                tags.Add(new RatingTag(source, text, value >= FreshThreshold,
                    settings.RatingTagsColorByScore ? ScoreColor(score) : null, settings.RatingTagsCompact && source is not (PosterRatingSource.Community or PosterRatingSource.Critic)));
            }

            return tags;
        }

        /// <summary>Same red/amber/green interpolation as the web source renderer.</summary>
        public static string ScoreColor(double score)
        {
            if (score < 5) return "#ef5350";
            if (score >= 7.5) return "#66bb6a";
            var t = (score - 5) / 2.5;
            return $"#{(int)Math.Floor(255 - 153 * t + .5):x2}{(int)Math.Floor(179 + 8 * t + .5):x2}{(int)Math.Floor(106 * t + .5):x2}";
        }

        /// <summary>
        /// Whether rating tags are switched off for this card type (Movie, Series, Season and Episode
        /// have switches; every other type is never excluded). The home-row switches (Continue
        /// Watching, Next Up) need the row the card sits in and cannot be applied to an image.
        /// </summary>
        public static bool IsExcludedByScope(string? itemType, PosterTagSettings settings) => itemType switch
        {
            "Movie" => !settings.RatingTagsOnMovies,
            "Series" => !settings.RatingTagsOnSeries,
            "Season" => !settings.RatingTagsOnSeasons,
            "Episode" => !settings.RatingTagsOnEpisodes,
            _ => false,
        };

        /// <summary>
        /// The user-review chip, or null when the web shows none. In the server-cache path the web
        /// resolves the review key only for Movie and Series (Season/Episode need a parent series
        /// the cache path never supplies), and only when the entry has a TMDB id.
        /// </summary>
        /// <param name="entry">The tag-cache entry.</param>
        /// <param name="settings">Effective settings.</param>
        /// <param name="average">Viewer-visible average review rating (1-5), or null when none.</param>
        public static RatingTag? ResolveUserReview(TagCacheEntry entry, PosterTagSettings settings, double? average)
        {
            if (!settings.UserReviewChipEnabled) return null;
            if (entry.Type is not ("Movie" or "Series") || string.IsNullOrEmpty(entry.TmdbId)) return null;
            if (average is null || double.IsNaN(average.Value) || double.IsInfinity(average.Value))
            {
                return settings.ShowUserRatingDash ? new RatingTag(PosterRatingSource.UserReview, Dash, false) : null;
            }

            // The 1-5 average shown out of ten: "8" for whole numbers, else one decimal.
            var raw = average.Value * 2;
            var text = Math.Floor(raw) == raw && Math.Abs(raw) < 1e21
                ? ((decimal)raw).ToString(CultureInfo.InvariantCulture)
                : JsText.ToFixed(raw, 1);
            return new RatingTag(PosterRatingSource.UserReview, text, false);
        }
    }
}
