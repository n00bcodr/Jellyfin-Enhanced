using System;
using System.Collections.Frozen;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// <c>new Intl.DisplayNames(['en'], { type: 'language' }).of(code)</c> without ICU, from the data
    /// captured in <see cref="ResolutionData"/>. Covers bare ISO 639 codes, language aliases, region,
    /// script and variant subtags and CLDR dialect names ("American English").
    /// </summary>
    internal static class LanguageNames
    {
        private static readonly FrozenDictionary<string, string> Languages = Load(ResolutionData.LanguageNames);
        private static readonly FrozenDictionary<string, string> LanguageAliases = Load(ResolutionData.LanguageAliases);
        private static readonly FrozenDictionary<string, string> Regions = Load(ResolutionData.RegionNames);
        private static readonly FrozenDictionary<string, string> RegionAliases = Load(ResolutionData.RegionAliases);
        private static readonly FrozenDictionary<string, string> Scripts = Load(ResolutionData.ScriptNames);
        private static readonly FrozenDictionary<string, string> Dialects = Load(ResolutionData.DialectNames);
        private static readonly FrozenDictionary<string, string> LanguageRegionAliases = Load(ResolutionData.LanguageRegionAliases);
        private static readonly FrozenDictionary<string, string> CompositeLanguageAliases = Load(ResolutionData.CompositeLanguageAliases);
        private static readonly FrozenDictionary<string, string> Variants = Load(ResolutionData.VariantNames);
        private static readonly FrozenDictionary<string, string> GenericVariantAliases = Load(ResolutionData.GenericVariantAliases);
        private static readonly FrozenDictionary<string, string> VariantAliases = Load(ResolutionData.VariantAliases);

        /// <summary>
        /// The English display name, or null where Intl.DisplayNames throws a RangeError (the tag is
        /// not a structurally valid Unicode language identifier, e.g. "pt_BR" or "root").
        /// </summary>
        public static string? Of(string code)
        {
            if (EndsWithAsciiIgnoreCase(code, PosixExtension))
            {
                // ICU parses a trailing -u-va-posix into the POSIX variant when the tag has no other
                // variant (the grandfathered zh-hakka-style tags lose theirs first); V8 then accepts
                // it as a plain language id and names it like "...-posix". Any other extension, or
                // -u-va-posix next to a variant, stays an ICU keyword and V8 throws.
                var prefix = code.Substring(0, code.Length - PosixExtension.Length);
                if (!IsGrandfatheredWithVariant(prefix)
                    && (!TryParse(prefix, out _, out _, out _, out var prefixVariants) || prefixVariants is not null))
                {
                    return null;
                }

                return Of(prefix + "-posix");
            }

            if (!TryParse(code, out var language, out var script, out var region, out var variants))
            {
                return null;
            }

            if (script is null && region is null && variants is null)
            {
                return Languages.TryGetValue(language, out var bare) ? bare : language;
            }

            if (region is not null && RegionAliases.TryGetValue(region, out var canonicalRegion))
            {
                region = canonicalRegion;
            }

            var originalLanguage = language;
            if (region is not null && LanguageRegionAliases.TryGetValue(language + "-" + region, out var regionAlias))
            {
                // A language+region pair with its own language (sgn-US -> ase); the region is consumed.
                TryParse(regionAlias, out language, out var aliasScript, out region, out _);
                script ??= aliasScript;
            }
            else if (CompositeLanguageAliases.TryGetValue(language, out var alias) || LanguageAliases.TryGetValue(language, out alias))
            {
                // Replace the language; subtags the alias brings (sh -> sr-Latn) only fill gaps.
                var parts = alias.Split('-');
                language = parts[0];
                for (var i = 1; i < parts.Length; i++)
                {
                    if (parts[i].Length == 4) script ??= parts[i];
                    else region ??= parts[i];
                }
            }

            if (variants is not null)
            {
                variants = ApplyVariantAliases(originalLanguage, variants, ref language, ref script, ref region);
            }

            var head = Languages.TryGetValue(language, out var languageName) ? languageName : language;
            var details = new List<string>(3);
            if (script is not null && region is null)
            {
                if (Dialects.TryGetValue(language + "-" + script, out var dialect)) head = dialect;
                else details.Add(ScriptName(script));
            }
            else if (script is null && region is not null)
            {
                if (Dialects.TryGetValue(language + "-" + region, out var dialect)) head = dialect;
                else details.Add(RegionName(region));
            }
            else if (script is not null && region is not null)
            {
                details.Add(ScriptName(script));
                details.Add(RegionName(region));
            }

            if (variants is { Count: 1 })
            {
                details.Add(Variants.TryGetValue(variants[0], out var variantName) ? variantName : variants[0].ToUpperInvariant());
            }
            else if (variants is { Count: > 1 })
            {
                // Several variants are shown as one raw, sorted, upper-case token ("ABCDE_FGHIJ").
                variants.Sort(StringComparer.Ordinal);
                details.Add(string.Join('_', variants).ToUpperInvariant());
            }

            return details.Count == 0 ? head : head + " (" + string.Join(", ", details) + ")";
        }

        /// <summary>
        /// Variant canonicalization: language+variant aliases (zh-hakka -> hak, art-lojban -> jbo),
        /// then the language-independent ones (heploc -> alalc97, lojban dropped; baku1926 becomes the
        /// Baku script only when it is the tag's sole subtag).
        /// </summary>
        private static List<string>? ApplyVariantAliases(string originalLanguage, List<string> variants, ref string language, ref string? script, ref string? region)
        {
            var soleSubtag = variants.Count == 1 && script is null && region is null;
            var result = new List<string>(variants.Count);
            foreach (var variant in variants)
            {
                if (VariantAliases.TryGetValue(originalLanguage + "-" + variant, out var pairAlias))
                {
                    // Intl writes a kept posix variant as the -u-va-posix extension (prs-posix -> fa-AF-u-va-posix).
                    if (EndsWithAsciiIgnoreCase(pairAlias, PosixExtension))
                    {
                        pairAlias = pairAlias.Substring(0, pairAlias.Length - PosixExtension.Length) + "-posix";
                    }

                    TryParse(pairAlias, out language, out var aliasScript, out var aliasRegion, out var aliasVariants);
                    script ??= aliasScript;
                    region ??= aliasRegion;
                    if (aliasVariants is not null) result.AddRange(aliasVariants);
                }
                else if (!GenericVariantAliases.TryGetValue(variant, out var replacement)
                    || replacement.StartsWith("u-va-", StringComparison.Ordinal))
                {
                    result.Add(variant); // posix stays a variant, named "Computer"
                }
                else if (replacement.Length == 4 && char.IsAsciiLetterUpper(replacement[0]))
                {
                    if (soleSubtag) script = replacement;
                    else result.Add(variant);
                }
                else if (replacement.Length > 0)
                {
                    result.Add(replacement);
                }
            }

            return result.Count == 0 ? null : result;
        }

        /// <summary>
        /// The canonical base language Intl.getCanonicalLocales gives a 2-3 letter code
        /// (iw -> he, cmn -> zh, sh -> sr), or the code itself.
        /// </summary>
        public static string CanonicalLanguage(string base2or3)
        {
            if (LanguageAliases.TryGetValue(base2or3, out var alias))
            {
                var dash = alias.IndexOf('-');
                return dash < 0 ? alias : alias.Substring(0, dash);
            }

            return base2or3;
        }

        private static string ScriptName(string script) => Scripts.TryGetValue(script, out var name) ? name : script;

        private static string RegionName(string region) => Regions.TryGetValue(region, out var name) ? name : region;

        /// <summary>
        /// UTS #35 unicode_language_id, as ECMA-402 requires for DisplayNames type "language":
        /// language (2-3 or 5-8 letters), optional script, optional region, distinct variants; no
        /// extensions, no extlang, '-' separators only.
        /// </summary>
        private static bool TryParse(string code, out string language, out string? script, out string? region, out List<string>? variants)
        {
            language = string.Empty;
            script = null;
            region = null;
            variants = null;
            if (string.IsNullOrEmpty(code)) return false;

            var subtags = code.Split('-');
            var first = subtags[0];
            if (!(first.Length is >= 2 and <= 3 or >= 5 and <= 8) || !IsAlpha(first)) return false;
            language = AsciiLower(first);

            var index = 1;
            if (index < subtags.Length && subtags[index].Length == 4 && IsAlpha(subtags[index]))
            {
                var s = subtags[index];
                script = char.ToUpperInvariant(s[0]) + AsciiLower(s.Substring(1));
                index++;
            }

            if (index < subtags.Length
                && ((subtags[index].Length == 2 && IsAlpha(subtags[index])) || (subtags[index].Length == 3 && IsDigits(subtags[index]))))
            {
                region = subtags[index].ToUpperInvariant();
                index++;
            }

            for (; index < subtags.Length; index++)
            {
                var v = subtags[index];
                var isVariant = IsAlphanumeric(v)
                    && (v.Length is >= 5 and <= 8 || (v.Length == 4 && v[0] >= '0' && v[0] <= '9'));
                if (!isVariant) return false;
                var lowered = AsciiLower(v);
                variants ??= new List<string>();
                if (variants.Contains(lowered)) return false;
                variants.Add(lowered);
            }

            return true;
        }

        private static string AsciiLower(string value) => JsText.AsciiLower(value);

        private const string PosixExtension = "-u-va-posix";

        /// <summary>BCP 47 grandfathered tags ICU replaces before reading extensions, whose variant then disappears.</summary>
        private static bool IsGrandfatheredWithVariant(string tag) => AsciiLower(tag) is "art-lojban" or "zh-guoyu" or "zh-hakka" or "zh-xiang";

        private static bool EndsWithAsciiIgnoreCase(string value, string lowerSuffix)
        {
            if (value.Length < lowerSuffix.Length) return false;
            var offset = value.Length - lowerSuffix.Length;
            for (var i = 0; i < lowerSuffix.Length; i++)
            {
                var c = value[offset + i];
                if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
                if (c != lowerSuffix[i]) return false;
            }

            return true;
        }

        private static bool IsAlpha(string value)
        {
            foreach (var c in value)
            {
                if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
            }

            return value.Length > 0;
        }

        private static bool IsDigits(string value)
        {
            foreach (var c in value)
            {
                if (c < '0' || c > '9') return false;
            }

            return value.Length > 0;
        }

        private static bool IsAlphanumeric(string value)
        {
            foreach (var c in value)
            {
                if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
            }

            return value.Length > 0;
        }

        private static FrozenDictionary<string, string> Load(string data)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (key, value) in JsText.ParseTable(data))
            {
                map[key] = value;
            }

            return map.ToFrozenDictionary(StringComparer.Ordinal);
        }
    }
}
