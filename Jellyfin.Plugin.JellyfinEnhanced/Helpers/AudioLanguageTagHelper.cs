using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using MediaBrowser.Model.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Maps stream language codes to audio-language tag names and computes tag changes.
    /// Used by <c>AudioLanguageTagsSyncTask</c>, <c>TagCacheService</c> and the <c>audio-language-tags</c> endpoint.
    /// </summary>
    internal static class AudioLanguageTagHelper
    {
        /// <summary>
        /// Tag names without the prefix: <c>Base</c> ("English") and, when the code has a
        /// region or script, <c>Variant</c> ("English (United States)").
        /// </summary>
        public static (string Base, string? Variant) GetTagNames(string code, ILocalizationManager localization)
        {
            var parts = code.Trim().ToLowerInvariant().Replace('_', '-').Split('-', StringSplitOptions.RemoveEmptyEntries);
            var baseCode = parts.Length > 0 ? parts[0] : code;

            string? baseName = null;
            try
            {
                baseName = localization.FindLanguageInfo(baseCode)?.DisplayName;
            }
            catch
            {
                // Unknown code: fall back to the code itself.
            }

            baseName = string.IsNullOrWhiteSpace(baseName) ? baseCode.ToUpperInvariant() : baseName.Trim();

            string? script = null;
            string? region = null;
            for (var i = 1; i < parts.Length; i++)
            {
                var part = parts[i];
                // Single-letter subtag: extension or private-use section
                if (part.Length == 1) break;
                if (region == null && part.Length == 2 && IsLetters(part))
                {
                    region = part == "uk" ? "gb" : part;
                }
                else if (region == null && part.Length == 3 && IsDigits(part))
                {
                    region = part;
                }
                else if (script == null && part.Length == 4 && IsLetters(part))
                {
                    script = part;
                }
            }

            var qualifiers = new List<string>();
            if (script != null)
            {
                qualifiers.Add(script switch
                {
                    "hans" => "Simplified",
                    "hant" => "Traditional",
                    _ => char.ToUpperInvariant(script[0]) + script[1..]
                });
            }

            if (region != null)
            {
                qualifiers.Add(GetRegionName(region));
            }

            return qualifiers.Count == 0
                ? (baseName, null)
                : (baseName, $"{baseName} ({string.Join(", ", qualifiers)})");
        }

        /// <summary>The configured tag prefix, falling back to the default when blank.</summary>
        public static string GetPrefix(Configuration.PluginConfiguration config) =>
            string.IsNullOrWhiteSpace(config.AudioLanguageTagPrefix) ? "JE Language: " : config.AudioLanguageTagPrefix;

        /// <summary>
        /// The tag list after adding missing audio-language tags and removing prefixed tags
        /// for languages the item no longer has. Null when nothing changes.
        /// </summary>
        public static string[]? BuildUpdatedTags(
            IEnumerable<string>? currentTags,
            IEnumerable<string>? languageCodes,
            string prefix,
            ILocalizationManager localization,
            Dictionary<string, (string Base, string? Variant)>? nameCache = null)
        {
            var desired = new List<string>();
            foreach (var code in languageCodes ?? Array.Empty<string>())
            {
                (string Base, string? Variant) names;
                if (nameCache == null || !nameCache.TryGetValue(code, out names))
                {
                    names = GetTagNames(code, localization);
                    if (nameCache != null) nameCache[code] = names;
                }

                foreach (var name in new[] { names.Base, names.Variant })
                {
                    if (name == null) continue;
                    var tag = prefix + name;
                    if (!desired.Contains(tag, StringComparer.OrdinalIgnoreCase))
                    {
                        desired.Add(tag);
                    }
                }
            }

            var existing = new List<string>(currentTags ?? Array.Empty<string>());
            var stale = existing
                .Where(t => t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                    && !desired.Contains(t, StringComparer.OrdinalIgnoreCase))
                .ToList();
            var missing = desired
                .Where(t => !existing.Contains(t, StringComparer.OrdinalIgnoreCase))
                .ToList();

            if (stale.Count == 0 && missing.Count == 0) return null;

            existing.RemoveAll(t => stale.Contains(t));
            existing.AddRange(missing);
            return existing.ToArray();
        }

        private static string GetRegionName(string region)
        {
            if (region == "419") return "Latin America";
            if (IsDigits(region)) return region;
            try
            {
                return new RegionInfo(region.ToUpperInvariant()).EnglishName;
            }
            catch (ArgumentException)
            {
                return region.ToUpperInvariant();
            }
        }

        private static bool IsLetters(string s)
        {
            foreach (var c in s) if (c < 'a' || c > 'z') return false;
            return true;
        }

        private static bool IsDigits(string s)
        {
            foreach (var c in s) if (c < '0' || c > '9') return false;
            return true;
        }
    }
}
