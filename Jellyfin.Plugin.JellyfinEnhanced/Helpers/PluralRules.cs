using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers;

/// <summary>
/// The CLDR plural category ("zero", "one", "two", "few", "many", "other") of a whole number in a language,
/// as the browser's Intl.PluralRules gives it to JE.t (js/plugin.js): native poster text picks the same
/// `key_one` / `key_few` … forms. tests/fixtures/plural-categories.json, generated from Intl.PluralRules,
/// holds every shipped locale to it. A language Intl does not know takes English rules, as JE.t asks Intl
/// with English as the fallback.
/// </summary>
internal static class PluralRules
{
    private static readonly HashSet<string> OneIfOne = new(StringComparer.OrdinalIgnoreCase)
    {
        "en", "de", "gsw", "nl", "sv", "da", "nb", "nn", "no", "it", "es", "el", "hu", "tr", "fi", "et", "ca", "bg", "pt-PT", "af", "eu", "gl", "sq", "ur", "az", "ka", "kk", "ky", "mn", "uz", "ta", "te", "ml", "mr", "ne",
    };

    private static readonly HashSet<string> NoForms = new(StringComparer.OrdinalIgnoreCase)
    {
        "ja", "zh", "ko", "th", "vi", "id", "ms", "lo", "my", "km", "yue",
    };

    // Languages whose "many" covers exact millions (CLDR: e = 0 and i != 0 and i % 1000000 = 0 and v = 0).
    private static readonly HashSet<string> MillionsAreMany = new(StringComparer.OrdinalIgnoreCase) { "es", "it", "ca", "fr", "pt", "pt-PT" };

    /// <summary>The category of <paramref name="n"/> (a count, never negative in practice) in <paramref name="cultureName"/>.</summary>
    internal static string Category(string? cultureName, long n)
    {
        n = Math.Abs(n);
        var name = string.IsNullOrEmpty(cultureName) ? "en" : cultureName;
        var lang = string.Equals(name, "pt-PT", StringComparison.OrdinalIgnoreCase) ? "pt-PT" : name.Split('-', '_')[0].ToLowerInvariant();
        long r10 = n % 10, r100 = n % 100;
        if (MillionsAreMany.Contains(lang) && n != 0 && n % 1_000_000 == 0) return "many";
        if (OneIfOne.Contains(lang)) return n == 1 ? "one" : "other";
        if (NoForms.Contains(lang)) return "other";
        switch (lang)
        {
            case "fr":
            case "pt":
            case "hi":
            case "fa":
            case "bn":
            case "gu":
            case "kn":
            case "am":
            case "zu":
                return n <= 1 ? "one" : "other";
            case "is":
            case "mk":
                return r10 == 1 && r100 != 11 ? "one" : "other";
            case "ru":
            case "uk":
            case "be":
                return r10 == 1 && r100 != 11 ? "one" : r10 is >= 2 and <= 4 && r100 is < 12 or > 14 ? "few" : "many";
            case "hr":
            case "sr":
            case "bs":
                return r10 == 1 && r100 != 11 ? "one" : r10 is >= 2 and <= 4 && r100 is < 12 or > 14 ? "few" : "other";
            case "pl":
                return n == 1 ? "one" : r10 is >= 2 and <= 4 && r100 is < 12 or > 14 ? "few" : "many";
            case "cs":
            case "sk":
                return n == 1 ? "one" : n is >= 2 and <= 4 ? "few" : "other";
            case "lt":
                return r100 is >= 11 and <= 19 ? "other" : r10 == 1 ? "one" : r10 >= 2 ? "few" : "other";
            case "lv":
                return r10 == 0 || r100 is >= 11 and <= 19 ? "zero" : r10 == 1 ? "one" : "other";
            case "ro":
                return n == 1 ? "one" : n == 0 || r100 is >= 1 and <= 19 ? "few" : "other";
            case "he":
                return n == 1 ? "one" : n == 2 ? "two" : "other";
            case "sl":
                return r100 == 1 ? "one" : r100 == 2 ? "two" : r100 is 3 or 4 ? "few" : "other";
            case "ar":
                return n == 0 ? "zero" : n == 1 ? "one" : n == 2 ? "two" : r100 is >= 3 and <= 10 ? "few" : r100 >= 11 ? "many" : "other";
            case "cy":
                return n switch { 0 => "zero", 1 => "one", 2 => "two", 3 => "few", 6 => "many", _ => "other" };
            case "ga":
                return n switch { 1 => "one", 2 => "two", >= 3 and <= 6 => "few", >= 7 and <= 10 => "many", _ => "other" };
            default:
                return n == 1 ? "one" : "other";
        }
    }
}
