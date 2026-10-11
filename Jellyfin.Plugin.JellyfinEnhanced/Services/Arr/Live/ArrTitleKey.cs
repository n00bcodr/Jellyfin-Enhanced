using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>
    /// Title keys: the one way the status UI, the change feed and the status routes name a title,
    /// independent of which arr instance (or Jellyfin item) holds it.
    /// <list type="bullet">
    /// <item><description><c>movie:tmdb:&lt;id&gt;</c></description></item>
    /// <item><description><c>tv:tvdb:&lt;id&gt;</c>, <c>tv:tvdb:&lt;id&gt;:s&lt;n&gt;</c>, <c>tv:tvdb:&lt;id&gt;:s&lt;n&gt;:e&lt;n&gt;</c></description></item>
    /// </list>
    /// A change to an episode also changes its season and series (see <see cref="WithParents"/>), so a
    /// page that shows only the series hears about an episode download.
    /// </summary>
    public static class ArrTitleKey
    {
        /// <summary>Longest key accepted from a client.</summary>
        public const int MaxLength = 48;

        private static readonly Regex Shape = new(
            @"^(movie:tmdb:[1-9][0-9]{0,8}|tv:tvdb:[1-9][0-9]{0,8}(:s(0|[1-9][0-9]{0,3})(:e(0|[1-9][0-9]{0,4}))?)?)$",
            RegexOptions.CultureInvariant | RegexOptions.Compiled,
            TimeSpan.FromMilliseconds(50));

        /// <summary>A movie by its TMDB id.</summary>
        public static string Movie(int tmdbId) => "movie:tmdb:" + tmdbId.ToString(CultureInfo.InvariantCulture);

        /// <summary>A series by its TVDB id.</summary>
        public static string Series(int tvdbId) => "tv:tvdb:" + tvdbId.ToString(CultureInfo.InvariantCulture);

        /// <summary>A season of a series.</summary>
        public static string Season(int tvdbId, int season) => Series(tvdbId) + ":s" + season.ToString(CultureInfo.InvariantCulture);

        /// <summary>An episode of a series.</summary>
        public static string Episode(int tvdbId, int season, int episode) => Season(tvdbId, season) + ":e" + episode.ToString(CultureInfo.InvariantCulture);

        /// <summary>True for a well-formed key.</summary>
        public static bool IsValid(string? key)
            => !string.IsNullOrEmpty(key) && key.Length <= MaxLength && Shape.IsMatch(key);

        /// <summary>
        /// The keys a change to a series, season or episode touches: the title itself, plus its season
        /// and series. A movie touches only itself.
        /// </summary>
        public static IEnumerable<string> WithParents(int tvdbId, int? season, int? episode)
        {
            if (season is int s && s >= 0)
            {
                if (episode is int e && e >= 0) yield return Episode(tvdbId, s, e);
                yield return Season(tvdbId, s);
            }
            yield return Series(tvdbId);
        }

        /// <summary>
        /// Splits a key into its media type ("movie" or "tv") and provider id. False for a malformed key.
        /// </summary>
        public static bool TryParse(string? key, out string mediaType, out int providerId, out int? season, out int? episode)
        {
            mediaType = string.Empty;
            providerId = 0;
            season = null;
            episode = null;
            if (!IsValid(key)) return false;
            var parts = key!.Split(':');
            mediaType = parts[0];
            providerId = int.Parse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture);
            if (parts.Length > 3) season = int.Parse(parts[3].AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture);
            if (parts.Length > 4) episode = int.Parse(parts[4].AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture);
            return true;
        }

        /// <summary>The title-level key (movie or series) a key belongs to.</summary>
        public static string? TitleOf(string? key)
        {
            if (!TryParse(key, out var type, out var id, out _, out _)) return null;
            return type == "movie" ? Movie(id) : Series(id);
        }
    }
}
