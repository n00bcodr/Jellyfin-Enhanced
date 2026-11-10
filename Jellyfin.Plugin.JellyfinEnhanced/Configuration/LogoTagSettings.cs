using System;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// The administrator's Logos tag group choices: what a movie or series
    /// card's logo shows, the watch-provider region and how many logos an
    /// item may carry. Unknown values normalise to the defaults, so a stale or
    /// hand-edited configuration never breaks the cache build.
    /// </summary>
    public static class LogoTagRules
    {
        public const string Provider = "provider";
        public const string Network = "network";
        public const string Studio = "studio";
        public const string Off = "off";

        /// <summary>Most logos one item may carry.</summary>
        public const int MaxLogos = 2;

        /// <summary>Movies: provider (default), studio or off.</summary>
        public static string MovieMode(string? value)
        {
            var mode = (value ?? string.Empty).Trim().ToLowerInvariant();
            return mode is Studio or Off ? mode : Provider;
        }

        /// <summary>Series (and their seasons and episodes): network (default), provider or off.</summary>
        public static string SeriesMode(string? value)
        {
            var mode = (value ?? string.Empty).Trim().ToLowerInvariant();
            return mode is Provider or Off ? mode : Network;
        }

        /// <summary>1 or 2.</summary>
        public static int Max(int value) => Math.Clamp(value, 1, MaxLogos);

        /// <summary>
        /// The watch-provider region: the Logos setting when it is a two-letter
        /// code, else the Seerr default region, else "US".
        /// </summary>
        public static string Region(PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(config);
            var own = config.LogoTagsRegion?.Trim().ToUpperInvariant();
            return WatchProvidersBatch.IsValidRegion(own) ? own! : WatchProvidersBatch.DefaultRegion(config.DEFAULT_REGION);
        }

        /// <summary>Normalise the stored choices in place (config saves can come from anywhere).</summary>
        public static void Normalize(PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(config);
            config.LogoTagsMovieMode = MovieMode(config.LogoTagsMovieMode);
            config.LogoTagsSeriesMode = SeriesMode(config.LogoTagsSeriesMode);
            config.LogoTagsMaxLogos = Max(config.LogoTagsMaxLogos);
            var region = config.LogoTagsRegion?.Trim().ToUpperInvariant() ?? string.Empty;
            config.LogoTagsRegion = WatchProvidersBatch.IsValidRegion(region) ? region : string.Empty;
        }

        /// <summary>A fingerprint of everything that changes which logos an item gets.</summary>
        public static string Fingerprint(PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(config);
            return string.Join("|", MovieMode(config.LogoTagsMovieMode), SeriesMode(config.LogoTagsSeriesMode), Max(config.LogoTagsMaxLogos), Region(config));
        }
    }
}
