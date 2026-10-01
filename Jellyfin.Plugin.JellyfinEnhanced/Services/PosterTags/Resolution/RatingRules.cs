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
        /// The critic and community chips (critic first). Empty when the entry carries neither
        /// rating; the web then creates no rating container of its own.
        /// </summary>
        public static List<PosterTag> ResolveScores(TagCacheEntry entry)
        {
            var tags = new List<PosterTag>(2);
            // normalizeCriticPercent: Number.isFinite fails for NaN and the infinities, no chip.
            if (entry.CriticRating is { } criticRaw && float.IsFinite(criticRaw))
            {
                var critic = Math.Max(0, Math.Min(100, JsText.MathRound(JsText.FloatAsJsNumber(criticRaw))));
                var percent = (int)critic;
                tags.Add(new RatingTag(PosterRatingSource.Critic, percent.ToString(CultureInfo.InvariantCulture) + "%", percent >= FreshThreshold));
            }

            if (entry.CommunityRating is { } communityRaw)
            {
                // parseFloat(v).toFixed(1); "0.0" (no data) shows a dash.
                var text = JsText.ToFixed(JsText.FloatAsJsNumber(communityRaw), 1);
                var display = double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) == 0 ? Dash : text;
                tags.Add(new RatingTag(PosterRatingSource.Community, display, false));
            }

            return tags;
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
