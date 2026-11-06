using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration;

/// <summary>Bound and canonicalize saved browser date context on assignment, including deserialization.</summary>
public static class NativePosterDateContext
{
    private static readonly Regex LocalePattern = new(
        @"\A(?:[a-z]{2,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly IReadOnlyDictionary<string, string> Cultures = CultureInfo.GetCultures(CultureTypes.AllCultures)
        // ICU resolves these registered Chinese aliases but omits them from GetCultures.
        .Concat(new[] { "zh-CN", "zh-HK", "zh-MO", "zh-SG", "zh-TW" }.Select(CultureInfo.GetCultureInfo))
        .DistinctBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
        .Where(c => c.Name.Length > 0).ToDictionary(c => c.Name, c => c.Name, StringComparer.OrdinalIgnoreCase);
    private static readonly Regex ZonePattern = new(@"\A[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*\z", RegexOptions.CultureInvariant);

    /// <summary>Registered BCP 47 base plus an optional Unicode extension, bounded to 35 characters.</summary>
    public static string? Locale(string? value)
    {
        // Check before trimming so an arbitrarily padded string also stays bounded.
        if (value == null || value.Length > 35) return null;
        value = value.Trim();
        var extension = value.IndexOf("-u-", StringComparison.OrdinalIgnoreCase);
        var name = extension < 0 ? value : value[..extension];
        if (!LocalePattern.IsMatch(name) || !Cultures.TryGetValue(name, out var canonical)) return null;
        if (extension < 0) return canonical;

        // Unicode attributes precede keyword/type pairs. Reject empty/oversize
        // subtags, duplicate attributes/keys and other extension singletons.
        var subtags = value[(extension + 3)..].Split('-');
        var attributes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hasKey = false;
        foreach (var subtag in subtags)
        {
            if (subtag.Length is < 2 or > 8 || !subtag.All(c => char.IsAsciiLetterOrDigit(c))) return null;
            if (subtag.Length == 2)
            {
                // Unicode locale keys are alphanumeric followed by a letter.
                if (!char.IsAsciiLetter(subtag[1]) || !keys.Add(subtag)) return null;
                hasKey = true;
            }
            else if (!hasKey && !attributes.Add(subtag)) return null;
        }
        // Keep the browser's bounded value verbatim for save/load. Formatting
        // uses its registered base; extensions cannot discard language/region.
        return value;
    }

    /// <summary>Canonical language/script/region for formatting; Unicode preferences remain stored on the user.</summary>
    public static string? FormattingLocale(string? value)
    {
        var locale = Locale(value);
        if (locale == null) return null;
        var extension = locale.IndexOf("-u-", StringComparison.OrdinalIgnoreCase);
        return Cultures[extension < 0 ? locale : locale[..extension]];
    }

    /// <summary>Resolvable IANA zone, at most 64 characters. Recognized Windows IDs are converted to IANA before storage.</summary>
    public static string? TimeZone(string? value)
    {
        if (value == null || value.Length > 64) return null;
        value = value.Trim();
        if (!string.Equals(value, "UTC", StringComparison.OrdinalIgnoreCase) && TimeZoneInfo.TryConvertWindowsIdToIanaId(value, out var iana)) value = iana;
        if (!ZonePattern.IsMatch(value)) return null;
        try { return TimeZoneInfo.FindSystemTimeZoneById(value).Id; }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { return null; }
    }
}
