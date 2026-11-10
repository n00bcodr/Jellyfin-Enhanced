using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution
{
    /// <summary>
    /// Score numbers in the user's locale (decimal separator and digits), as the web writes them with
    /// <c>Intl.NumberFormat</c> (JE.core.mediaLanguage.formatNumberText). The table
    /// (<c>js/tags/score-numbers.json</c>) is generated from the same ICU data by
    /// <c>scripts/generate_score_numbers.mjs</c>; an unlisted culture uses its closest listed ancestor.
    /// </summary>
    internal static class ScoreNumbers
    {
        private sealed record NumberFormat(string Decimal, string Digits);

        private sealed record Table(Dictionary<string, NumberFormat> Formats, Dictionary<string, string> Locales);

        private static readonly Table Data = Read();

        private static readonly NumberFormat Default = new(".", "0123456789");

        /// <summary>The format key for a culture ("default" for ASCII digits and a full stop), used in poster digests.</summary>
        /// <param name="culture">The user's formatting culture.</param>
        /// <returns>The key.</returns>
        internal static string FormatKey(CultureInfo culture)
        {
            var format = Find(culture);
            return format == Default ? "default" : format.Decimal + format.Digits;
        }

        /// <summary>A score text ("8.1", "81%") with the culture's decimal separator and digits.</summary>
        /// <param name="text">Text with ASCII digits and an optional full stop.</param>
        /// <param name="culture">The user's formatting culture.</param>
        /// <returns>The localized text.</returns>
        internal static string Localize(string text, CultureInfo culture)
        {
            var format = Find(culture);
            if (format == Default) return text;
            var result = new StringBuilder(text.Length);
            foreach (var c in text)
            {
                if (c == '.') result.Append(format.Decimal);
                else if (c is >= '0' and <= '9') result.Append(format.Digits, c - '0', 1);
                else result.Append(c);
            }

            return result.ToString();
        }

        private static NumberFormat Find(CultureInfo culture)
        {
            for (var ancestor = culture; !string.IsNullOrEmpty(ancestor.Name); ancestor = ancestor.Parent)
            {
                if (Data.Locales.TryGetValue(ancestor.Name, out var key) && Data.Formats.TryGetValue(key, out var format))
                {
                    return format.Decimal == "." && format.Digits == Default.Digits ? Default : format;
                }
            }

            return Default;
        }

        private static Table Read()
        {
            using var stream = typeof(ScoreNumbers).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js.tags.score-numbers.json");
            return stream == null
                ? new Table(new Dictionary<string, NumberFormat>(), new Dictionary<string, string>())
                : JsonSerializer.Deserialize<Table>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        }
    }
}
