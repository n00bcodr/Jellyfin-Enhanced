using System;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>Validation shared by stored preferences, public defaults and native posters.</summary>
    public static class RatingSourceSettings
    {
        public static readonly string[] SourceIds = { "community", "critic", "imdb", "tmdb", "rtCritic", "rtAudience", "metacritic", "letterboxd", "trakt", "myAnimeList", "aniList", "metacriticUser", "rogerEbert", "mdblist" };

        /// <summary>Keep known, distinct source ids in the requested order. Null retains legacy includes.</summary>
        public static string[]? NormalizeSources(string[]? sources) => sources?.Where(SourceIds.Contains).Distinct(StringComparer.Ordinal).ToArray();

        /// <summary>Admin defaults in requested order; old include switches survive an upgrade.</summary>
        public static string[] Defaults(PluginConfiguration config) => NormalizeSources(config.RatingTagsSources)
            ?? new[] { "community", "critic" }.Where(id => id == "community" ? config.RatingTagsShowCommunity : config.RatingTagsShowCritic).ToArray();

        /// <summary>Clamp a finite minimum to the common zero-to-ten scale.</summary>
        public static double NormalizeMinimum(double value) => double.IsFinite(value) ? Math.Clamp(value, 0, 10) : 0;

        /// <summary>Normalize a user document before saving it.</summary>
        public static void Normalize(JellyfinEnhancedUserSettings settings)
        {
            settings.RatingTagsSources = NormalizeSources(settings.RatingTagsSources);
            settings.RatingTagsMinScore = NormalizeMinimum(settings.RatingTagsMinScore);
        }
    }
}
