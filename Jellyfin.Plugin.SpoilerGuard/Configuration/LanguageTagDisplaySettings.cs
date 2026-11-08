using System;

namespace Jellyfin.Plugin.SpoilerGuard.Configuration
{
    /// <summary>
    /// What the Language Tags group shows: audio and/or subtitle languages,
    /// flags or text codes, and the Dual/Multi audio count badge. Per-user
    /// settings with the administrator's starting defaults, like the rating
    /// group's include switches. Unknown style or badge values normalize to
    /// today's look (flags, no badge), so a stale or hand-edited document
    /// never hides the group.
    /// </summary>
    public static class LanguageTagDisplay
    {
        /// <summary>Flag images (the original look).</summary>
        public const string StyleFlags = "flags";

        /// <summary>Uppercase ISO 639-1 (else 639-2) codes in a small chip.</summary>
        public const string StyleCodes = "codes";

        /// <summary>No count badge.</summary>
        public const string BadgeOff = "off";

        /// <summary>The Dual/Multi badge replaces the audio chips.</summary>
        public const string BadgeOnly = "only";

        /// <summary>The Dual/Multi badge comes before the audio chips.</summary>
        public const string BadgeWithChips = "both";

        /// <summary>A known style, lower-cased; anything else is <see cref="StyleFlags"/>.</summary>
        /// <param name="value">Stored or posted value.</param>
        /// <returns>The normalized style.</returns>
        public static string NormalizeStyle(string? value) =>
            string.Equals(value?.Trim(), StyleCodes, StringComparison.OrdinalIgnoreCase) ? StyleCodes : StyleFlags;

        /// <summary>A known count badge mode, lower-cased; anything else is <see cref="BadgeOff"/>.</summary>
        /// <param name="value">Stored or posted value.</param>
        /// <returns>The normalized mode.</returns>
        public static string NormalizeCountBadge(string? value)
        {
            var v = value?.Trim();
            if (string.Equals(v, BadgeOnly, StringComparison.OrdinalIgnoreCase)) return BadgeOnly;
            if (string.Equals(v, BadgeWithChips, StringComparison.OrdinalIgnoreCase)) return BadgeWithChips;
            return BadgeOff;
        }

        /// <summary>Normalize the language display settings of a user document in place (on save).</summary>
        /// <param name="settings">The posted document.</param>
        public static void Normalize(SpoilerGuardUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            settings.LanguageTagsStyle = NormalizeStyle(settings.LanguageTagsStyle);
            settings.LanguageTagsCountBadge = NormalizeCountBadge(settings.LanguageTagsCountBadge);
        }

        /// <summary>
        /// Copy the administrator's language display defaults onto a user
        /// document: new users and "apply defaults to all users" start from them.
        /// </summary>
        /// <param name="settings">The user document being seeded.</param>
        /// <param name="config">The plugin configuration.</param>
        public static void ApplyDefaults(SpoilerGuardUserSettings settings, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(settings);
            ArgumentNullException.ThrowIfNull(config);
            settings.LanguageTagsShowAudio = config.LanguageTagsShowAudio;
            settings.LanguageTagsShowSubtitles = config.LanguageTagsShowSubtitles;
            settings.LanguageTagsStyle = NormalizeStyle(config.LanguageTagsStyle);
            settings.LanguageTagsCountBadge = NormalizeCountBadge(config.LanguageTagsCountBadge);
            // Priority policy stays live: new/reset users follow future admin changes.
            settings.LanguageTagsPriority = null;
            settings.LanguageTagsPriorityStrict = null;
        }
    }
}
