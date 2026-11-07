using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Port of <c>js/tags/logotags.js</c> readLogos and shortName: the valid logos of a cache entry
    /// (a known kind and a name, at most two, a logo path only when the proxy can serve it) and the
    /// text a name chip shows.
    /// </summary>
    internal static class LogoRules
    {
        /// <summary>Names longer than this show as an initialism (<c>TEXT_MAX_LENGTH</c>).</summary>
        internal const int TextMaxLength = TagCacheService.LogoTextMaxLength;

        private const int MaxLogos = 2;

        /// <summary>logotags.js word separators: <c>/[\s\-–—/&amp;+]+/</c>.</summary>
        private static readonly Regex WordSeparators = new(@"[\s\-–—/&+]+", RegexOptions.CultureInvariant);

        /// <summary>The entry's logos as the web reads them; null when none is valid.</summary>
        /// <param name="logos">The entry's <c>Logos</c>.</param>
        /// <returns>The tags, or null.</returns>
        public static List<PosterTag>? Resolve(TagLogo[]? logos)
        {
            if (logos is null || logos.Length == 0) return null;
            var tags = new List<PosterTag>(Math.Min(logos.Length, MaxLogos));
            foreach (var logo in logos)
            {
                if (logo is null || logo.Kind is not ("provider" or "network" or "studio")) continue;
                var name = JsText.Trim(logo.Name ?? string.Empty);
                if (name.Length == 0) continue;
                tags.Add(new LogoTag(logo.Kind, name, TagLogoService.IsLogoPath(logo.Logo) ? logo.Logo : null));
                if (tags.Count == MaxLogos) break;
            }

            return tags.Count > 0 ? tags : null;
        }

        /// <summary>
        /// The name itself up to <see cref="TextMaxLength"/> UTF-16 units, else the initials of its
        /// first four words when it has two or more, else the name cut to fit with an ellipsis.
        /// </summary>
        /// <param name="name">A logo name.</param>
        /// <returns>The chip text.</returns>
        public static string ShortName(string name)
        {
            var text = JsText.Trim(name ?? string.Empty);
            if (text.Length <= TextMaxLength) return text;
            var words = new List<string>();
            foreach (var word in WordSeparators.Split(text))
            {
                if (FirstLetterOrDigit(word) is not null) words.Add(word);
            }

            if (words.Count >= 2)
            {
                var initials = new StringBuilder(4);
                for (var i = 0; i < words.Count && i < 4; i++) initials.Append(FirstLetterOrDigit(words[i]));
                return JsText.ToUpper(initials.ToString());
            }

            return text[..(TextMaxLength - 1)] + "…";
        }

        /// <summary>The first letter or number (a whole code point, like <c>/[\p{L}\p{N}]/u</c>), or null.</summary>
        private static string? FirstLetterOrDigit(string word)
        {
            for (var i = 0; i < word.Length; i += char.IsSurrogatePair(word, i) ? 2 : 1)
            {
                var category = CharUnicodeInfo.GetUnicodeCategory(word, i);
                if (category is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
                    or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter or UnicodeCategory.DecimalDigitNumber
                    or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber)
                {
                    return word.Substring(i, char.IsSurrogatePair(word, i) ? 2 : 1);
                }
            }

            return null;
        }
    }
}
