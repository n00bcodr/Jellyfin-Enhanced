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

    /// <summary>Registered BCP 47 culture, at most 35 characters; invalid or unknown values use the display-language fallback.</summary>
    public static string? Locale(string? value)
    {
        // Check before trimming so an arbitrarily padded string also stays bounded.
        if (value == null || value.Length > 35) return null;
        value = value.Trim();
        return LocalePattern.IsMatch(value) && Cultures.TryGetValue(value, out var canonical) ? canonical : null;
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
