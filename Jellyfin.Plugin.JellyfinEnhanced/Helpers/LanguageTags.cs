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

        // A complete language tag: a 2-3 letter language, then an optional 4-letter script, an optional region (2 letters
        // or 3 digits) and variants (5-8 letters or digits, or a digit and 3 more), each variant once. Extensions and
        // private use aren't display languages. The client's JE.languageCode (js/enhanced/translations.js, and its copy in
        // js/plugin.js) uses the same expression; tests/backend/Api/language-tags.json holds the shared table.
        private static readonly Regex Tag = new(
            "^(?<language>[A-Za-z]{2,3})(?:-(?<script>[A-Za-z]{4}))?(?:-(?<region>[A-Za-z]{2}|[0-9]{3}))?(?<variants>(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*)$",
            RegexOptions.CultureInvariant);

        private static readonly Lazy<IReadOnlyList<string>> BundledCodes = new(() => Assembly.GetExecutingAssembly()
            .GetManifestResourceNames()
            .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal) && n.EndsWith(Suffix, StringComparison.Ordinal))
            .Select(n => n.Substring(Prefix.Length, n.Length - Prefix.Length - Suffix.Length))
            .OrderBy(code => code, StringComparer.OrdinalIgnoreCase)
            .ToArray());

        /// <summary>The locale codes JE ships (its own locale files, <c>en</c> included).</summary>
        public static IReadOnlyList<string> Bundled => BundledCodes.Value;

        /// <summary>
        /// A display language JE may store: a complete language tag (<see cref="Canonical"/>: <c>pt-br</c> → <c>pt-BR</c>) of a
        /// language JE ships (exactly, or its base language) or one the server knows as a culture; anything else (empty, a
        /// literal "undefined" or "null", a malformed or unsupported value) is <c>""</c>, Auto.
        /// </summary>
        /// <param name="raw">A stored, configured or submitted value.</param>
        /// <returns>The tag, or <c>""</c>.</returns>
        public static string Sanitize(string? raw)
        {
            // The whole tag first: a shipped base language never makes a malformed tag (en-12, en-US-US) acceptable.
            var code = Canonical(raw);
            return code.Length > 0 && Supported(code) ? code : string.Empty;
        }

        /// <summary>
        /// A value as a complete language tag in canonical case (<c>zh-hant-tw</c> → <c>zh-Hant-TW</c>), or <c>""</c> when it
        /// is none (malformed, a literal "undefined" or "null", empty). Whether the language is supported isn't checked.
        /// </summary>
        /// <param name="raw">A stored, configured or submitted value.</param>
        /// <returns>The tag, or <c>""</c>.</returns>
        public static string Canonical(string? raw)
        {
            var code = (raw ?? string.Empty).Trim();
            if (code.Equals("null", StringComparison.OrdinalIgnoreCase) || code.Equals("nan", StringComparison.OrdinalIgnoreCase)
                || code.Equals("true", StringComparison.OrdinalIgnoreCase) || code.Equals("false", StringComparison.OrdinalIgnoreCase))
            {
                return string.Empty;
            }

            var match = Tag.Match(code);
            if (!match.Success) return string.Empty;
            var variants = match.Groups["variants"].Value.Split('-', StringSplitOptions.RemoveEmptyEntries).Select(v => v.ToLowerInvariant()).ToList();
            if (variants.Distinct(StringComparer.Ordinal).Count() != variants.Count) return string.Empty;
            var tag = match.Groups["language"].Value.ToLowerInvariant();
            if (match.Groups["script"].Success)
            {
                var script = match.Groups["script"].Value;
                tag += "-" + char.ToUpperInvariant(script[0]) + script[1..].ToLowerInvariant();
            }

            if (match.Groups["region"].Success) tag += "-" + match.Groups["region"].Value.ToUpperInvariant();
            foreach (var variant in variants) tag += "-" + variant;
            return tag;
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
