using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The display languages JE stores and hands to clients (a person's <c>DisplayLanguage</c>, the administrator's default
    /// as each person's first setting). The client writes the same rule into Jellyfin's shared per-user language key
    /// (<c>JE.supportedLanguageCode</c> in js/enhanced/translations.js).
    /// </summary>
    public static class LanguageTags
    {
        private const string Prefix = "Jellyfin.Plugin.JellyfinEnhanced.js.locales.";
        private const string Suffix = ".json";

        private static readonly Regex Shape = new("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$", RegexOptions.CultureInvariant);

        private static readonly Lazy<IReadOnlyList<string>> BundledCodes = new(() => Assembly.GetExecutingAssembly()
            .GetManifestResourceNames()
            .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal) && n.EndsWith(Suffix, StringComparison.Ordinal))
            .Select(n => n.Substring(Prefix.Length, n.Length - Prefix.Length - Suffix.Length))
            .OrderBy(code => code, StringComparer.OrdinalIgnoreCase)
            .ToArray());

        /// <summary>The locale codes JE ships (its own locale files, <c>en</c> included).</summary>
        public static IReadOnlyList<string> Bundled => BundledCodes.Value;

        /// <summary>
        /// A display language JE may store: a language tag (normalized: <c>pt-br</c> → <c>pt-BR</c>) of a language JE ships
        /// (exactly, or its base language) or one the server knows as a culture; anything else (empty, a literal
        /// "undefined" or "null", a malformed or unsupported value) is <c>""</c>, Auto.
        /// </summary>
        /// <param name="raw">A stored, configured or submitted value.</param>
        /// <returns>The tag, or <c>""</c>.</returns>
        public static string Sanitize(string? raw)
        {
            var code = (raw ?? string.Empty).Trim();
            if (code.Length == 0 || !Shape.IsMatch(code)) return string.Empty;
            if (code.Equals("null", StringComparison.OrdinalIgnoreCase) || code.Equals("nan", StringComparison.OrdinalIgnoreCase)
                || code.Equals("true", StringComparison.OrdinalIgnoreCase) || code.Equals("false", StringComparison.OrdinalIgnoreCase))
            {
                return string.Empty;
            }

            var parts = code.Split('-');
            var normalized = parts.Length == 1 ? parts[0].ToLowerInvariant()
                : parts.Length == 2 ? parts[0].ToLowerInvariant() + "-" + parts[1].ToUpperInvariant() : code;
            return Supported(normalized) ? normalized : string.Empty;
        }

        private static bool Supported(string code)
        {
            var primary = code.Split('-')[0];
            if (Bundled.Any(b => b.Equals(code, StringComparison.OrdinalIgnoreCase) || b.Equals(primary, StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }

            try
            {
                // A culture the server has data for (a newer locale fetched by the client is a real language). Never the
                // invariant culture; a server without culture data accepts only the shipped languages.
                return !string.IsNullOrEmpty(CultureInfo.GetCultureInfo(code, predefinedOnly: true).Name);
            }
            catch (CultureNotFoundException)
            {
                return false;
            }
        }
    }
}
