using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The display languages JE stores and hands to clients (a person's <c>DisplayLanguage</c>, the administrator's default
    /// as each person's first setting). The rule is data, js/language-policy.json (generated from js/locales by
    /// scripts/generate_language_policy.py), embedded here and carried by the client (<c>JE.languageCode</c> and
    /// <c>JE.supportedLanguageCode</c> in js/enhanced/translations.js), so both sides compute the same answer; neither asks
    /// which cultures the platform knows.
    /// </summary>
    public static class LanguageTags
    {
        private const string PolicyResource = "Jellyfin.Plugin.JellyfinEnhanced.js.language-policy.json";

        private sealed record Policy(char[] Space, IReadOnlyList<string> Reserved, Regex Tag, IReadOnlyList<string> Shipped);

        private static readonly Lazy<Policy> Loaded = new(() =>
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PolicyResource)
                ?? throw new InvalidOperationException("The embedded js/language-policy.json is missing.");
            using var document = JsonDocument.Parse(stream);
            var root = document.RootElement;
            static IReadOnlyList<string> Strings(JsonElement list) => list.EnumerateArray().Select(e => e.GetString()!).ToArray();
            return new Policy(
                root.GetProperty("space").GetString()!.ToCharArray(),
                Strings(root.GetProperty("reserved")),
                new Regex(root.GetProperty("tag").GetString()!, RegexOptions.CultureInvariant),
                Strings(root.GetProperty("shipped")));
        });

        /// <summary>The locale codes JE ships (its own locale files, <c>en</c> included), as the policy lists them.</summary>
        public static IReadOnlyList<string> Bundled => Loaded.Value.Shipped;

        /// <summary>
        /// A display language JE may store: a complete language tag (<see cref="Canonical"/>: <c>pt-br</c> → <c>pt-BR</c>) that
        /// resolves to a locale bundle JE ships, exactly or by its base language; anything else (empty, a literal "undefined"
        /// or "null", a malformed value, a language without a bundle such as <c>haw-AU</c>) is <c>""</c>, Auto.
        /// </summary>
        /// <param name="raw">A stored, configured or submitted value.</param>
        /// <returns>The tag, or <c>""</c>.</returns>
        public static string Sanitize(string? raw)
        {
            // The whole tag first: a shipped base language never makes a malformed tag (en-12, en-US-US) acceptable.
            var code = Canonical(raw);
            if (code.Length == 0) return string.Empty;
            var primary = code.Split('-')[0];
            return Bundled.Any(b => b.Equals(code, StringComparison.OrdinalIgnoreCase) || b.Equals(primary, StringComparison.OrdinalIgnoreCase))
                ? code
                : string.Empty;
        }

        /// <summary>
        /// A value as a complete language tag in canonical case (<c>zh-hant-tw</c> → <c>zh-Hant-TW</c>), or <c>""</c> when it
        /// is none (malformed, a literal "undefined" or "null", empty). Whether JE ships the language isn't checked.
        /// </summary>
        /// <param name="raw">A stored, configured or submitted value.</param>
        /// <returns>The tag, or <c>""</c>.</returns>
        public static string Canonical(string? raw)
        {
            var policy = Loaded.Value;
            var code = (raw ?? string.Empty).Trim(policy.Space);
            if (policy.Reserved.Contains(code, StringComparer.OrdinalIgnoreCase)) return string.Empty;
            var match = policy.Tag.Match(code);
            if (!match.Success || match.Length != code.Length) return string.Empty;
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
    }
}
