using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Port of <c>js/tags/ageratingtags.js</c> normalizeRating with the shared Colored Ratings
    /// normalizer (<c>js/extras/colored-ratings.js</c>): collapse whitespace, map the common
    /// "not rated" and German FSK spellings, else keep the trimmed original. The normalized string
    /// is the case-sensitive colour key; the badge shows it upper-cased (CSS text-transform).
    /// </summary>
    internal static class AgeRatingRules
    {
        private static readonly FrozenDictionary<string, string> Mappings = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["NOT RATED"] = "NR",
            ["NOT-RATED"] = "NR",
            ["UNRATED"] = "NR",
            ["NO RATING"] = "NR",
            ["DE-0"] = "FSK-0",
            ["DE-6"] = "FSK-6",
            ["DE-12"] = "FSK-12",
            ["DE-16"] = "FSK-16",
            ["DE-18"] = "FSK-18",
            ["FSK0"] = "FSK-0",
            ["FSK6"] = "FSK-6",
            ["FSK12"] = "FSK-12",
            ["FSK16"] = "FSK-16",
            ["FSK18"] = "FSK-18",
            ["FSK 0"] = "FSK-0",
            ["FSK 6"] = "FSK-6",
            ["FSK 12"] = "FSK-12",
            ["FSK 16"] = "FSK-16",
            ["FSK 18"] = "FSK-18",
            ["APPROVED"] = "APPROVED",
            ["PASSED"] = "PASSED",
        }.ToFrozenDictionary(StringComparer.Ordinal);

        /// <summary>The badge for an OfficialRating, or null when there is none.</summary>
        public static AgeRatingTag? Resolve(string? officialRating)
        {
            var key = Normalize(officialRating);
            return key is null ? null : new AgeRatingTag(JsText.ToUpper(key), key);
        }

        /// <summary>The normalized rating (colour key), or null when empty.</summary>
        public static string? Normalize(string? raw)
        {
            if (raw is null) return null;

            // String(raw).replace(/\s+/g, ' ').trim()
            var text = JsText.Trim(CollapseWhitespace(raw));
            if (text.Length == 0) return null;

            // colored-ratings normalizeRating(text): mapping by the upper-cased text, else the
            // (already trimmed) text itself.
            var upper = JsText.ToUpper(text);
            var normalized = Mappings.TryGetValue(upper, out var mapped) ? mapped : text;
            return normalized.Length == 0 ? null : normalized;
        }

        private static string CollapseWhitespace(string value)
        {
            StringBuilder? sb = null;
            var inRun = false;
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                if (JsText.IsJsWhiteSpace(c))
                {
                    if (!inRun)
                    {
                        if (sb is null && c != ' ') sb = new StringBuilder(value.Length).Append(value, 0, i);
                        sb?.Append(' ');
                    }
                    else
                    {
                        sb ??= new StringBuilder(value.Length).Append(value, 0, i);
                    }

                    inRun = true;
                    continue;
                }

                inRun = false;
                sb?.Append(c);
            }

            return sb?.ToString() ?? value;
        }
    }
}
