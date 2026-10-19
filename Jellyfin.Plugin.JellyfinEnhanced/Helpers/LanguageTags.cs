using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The display languages JE stores and hands to clients (a person's <c>DisplayLanguage</c>, the administrator's default
    /// as each person's first setting). The rule is data: js/language-policy.json (the tag syntax), and the locale bundles
    /// this build ships, read at run time from its embedded js/locales resources (a locale file added to js/locales is a
    /// language JE ships, with no other step). The client gets the same data inside the translations script the server
    /// serves (<see cref="TranslationsScript"/>; <c>JE.languageCode</c> and <c>JE.supportedLanguageCode</c>), so both sides
    /// compute the same answer; neither asks which cultures the platform knows.
    /// </summary>
    public static class LanguageTags
    {
        private const string ResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.";
        private const string PolicyResource = ResourcePrefix + "language-policy.json";
        private const string LocalePrefix = ResourcePrefix + "locales.";
        private const string TranslationsResource = ResourcePrefix + "enhanced.translations.js";

        /// <summary>The line of js/enhanced/translations.js the server replaces with the policy when it serves the file.</summary>
        private const string PolicyPlaceholder = "const LANGUAGE_POLICY = null; // je:language-policy";

        private sealed record Policy(string SpaceText, char[] Space, IReadOnlyList<string> Reserved, string TagPattern, Regex Tag);

        private static readonly Lazy<Policy> Loaded = new(() =>
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PolicyResource)
                ?? throw new InvalidOperationException("The embedded js/language-policy.json is missing.");
            using var document = JsonDocument.Parse(stream);
            var root = document.RootElement;
            var space = root.GetProperty("space").GetString()!;
            var tag = root.GetProperty("tag").GetString()!;
            return new Policy(
                space,
                space.ToCharArray(),
                root.GetProperty("reserved").EnumerateArray().Select(e => e.GetString()!).ToArray(),
                tag,
                new Regex(tag, RegexOptions.CultureInvariant));
        });

        // The locale bundles the build embeds (js/locales/<code>.json): each file name that is a language tag.
        private static readonly Lazy<IReadOnlyList<string>> Shipped = new(() => Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Where(name => name.StartsWith(LocalePrefix, StringComparison.Ordinal) && name.EndsWith(".json", StringComparison.Ordinal))
            .Select(name => name[LocalePrefix.Length..^".json".Length])
            .Where(code => Canonical(code).Length > 0)
            .OrderBy(code => code, StringComparer.OrdinalIgnoreCase)
            .ToArray());

        private static readonly Lazy<string> Served = new(() =>
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(TranslationsResource)
                ?? throw new InvalidOperationException("The embedded js/enhanced/translations.js is missing.");
            using var reader = new System.IO.StreamReader(stream, Encoding.UTF8);
            var policy = Loaded.Value;
            var json = JsonSerializer.Serialize(
                new { space = policy.SpaceText, reserved = policy.Reserved, tag = policy.TagPattern, shipped = Bundled },
                new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            return reader.ReadToEnd().Replace(PolicyPlaceholder, "const LANGUAGE_POLICY = " + json + ";", StringComparison.Ordinal);
        });

        /// <summary>The locale codes JE ships: its embedded locale files (<c>en</c> included), ordered case-insensitively.</summary>
        public static IReadOnlyList<string> Bundled => Shipped.Value;

        /// <summary>
        /// js/enhanced/translations.js as the server serves it: the policy line carries the rule (js/language-policy.json) and
        /// the locale bundles this build ships (<see cref="Bundled"/>). Without it the client accepts no language at all.
        /// </summary>
        /// <returns>The script.</returns>
        public static string TranslationsScript() => Served.Value;

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
