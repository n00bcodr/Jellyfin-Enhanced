using System.Globalization;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

/// <summary>Technical labels shared by cache aggregation, batch and native posters; the web aspect table is generated from this table.</summary>
internal static class TechnicalQualityRules
{
    // Absolute display-aspect tolerances; nearest candidate wins; anamorphic scope shares one label.
    private static readonly (double Ratio, double Tolerance, string Label)[] Ratios =
    {
        (4d / 3, .025, "4:3"), (1.43, .015, "IMAX 1.43"), (1.66, .02, "1.66:1"),
        (16d / 9, .025, "16:9"), (1.85, .025, "1.85:1"), (1.90, .02, "IMAX 1.90"),
        (2, .025, "2:1"), (2.20, .025, "2.20:1"), (2.35, .019, "2.39:1"),
        (2.39, .025, "2.39:1"), (2.76, .025, "2.76:1"),
    };

    /// <summary>Whole-minute duration, truncated rather than rounded across hour boundaries.</summary>
    internal static string? Runtime(long? ticks)
    {
        if (ticks is not > 0) return null;
        var minutes = ticks.Value / TimeSpan.TicksPerMinute;
        if (minutes < 1) return null;
        return minutes >= 60 ? $"{minutes / 60}h {minutes % 60:00}m" : $"{minutes}m";
    }

    /// <summary>Prefer declared display aspect, then dimensions; malformed/nonfinite values are ignored.</summary>
    internal static string? Aspect(TagMediaStream? stream)
    {
        if (stream == null) return null;
        var parts = stream.AspectRatio?.Split(':', '/');
        double ratio = 0;
        if (parts is { Length: 1 or 2 } && double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var numerator)
            && (parts.Length == 1 || double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out _)))
            ratio = parts.Length == 1 ? numerator : numerator / double.Parse(parts[1], CultureInfo.InvariantCulture);
        if (!double.IsFinite(ratio) || ratio <= 0) ratio = stream.Width is > 0 && stream.Height is > 0 ? (double)stream.Width.Value / stream.Height.Value : 0;
        if (ratio < .5 || ratio > 4) return null;
        string? label = null;
        var nearest = double.MaxValue;
        foreach (var candidate in Ratios)
        {
            var delta = Math.Abs(candidate.Ratio - ratio);
            if (delta <= candidate.Tolerance && delta < nearest) { label = candidate.Label; nearest = delta; }
        }
        return label ?? ratio.ToString("0.00", CultureInfo.InvariantCulture) + ":1";
    }

    /// <summary>Snap fractional cinema/broadcast rates; interlaced values display fields per second.</summary>
    internal static string? FrameRate(TagMediaStream? stream)
    {
        if (stream == null) return null;
        var rate = stream.RealFrameRate is > 0 && float.IsFinite(stream.RealFrameRate.Value) ? stream.RealFrameRate : stream.AverageFrameRate;
        if (rate is not > 0 || !float.IsFinite(rate.Value) || rate > 240) return null;
        var value = (double)rate.Value * (stream.IsInterlaced == true ? 2 : 1);
        foreach (var common in new[] { 24, 25, 30, 48, 50, 60, 100, 120, 144, 240 })
            if (Math.Abs(value - common) <= .15) return common.ToString(CultureInfo.InvariantCulture) + (stream.IsInterlaced == true ? "i" : "p");
        return value.ToString("0.##", CultureInfo.InvariantCulture) + (stream.IsInterlaced == true ? "i" : "p");
    }

    /// <summary>Compact labels keep the same technical value.</summary>
    internal static string Compact(string label, string category) => category switch
    {
        QualityTagRules.Runtime => Regex.Replace(label, @"(\d+)h (\d+)m", "$1h$2", RegexOptions.CultureInvariant),
        QualityTagRules.AspectRatio => label.StartsWith("IMAX ", StringComparison.Ordinal) ? label[5..] : label switch { "16:9" => "16:9", "4:3" => "4:3", _ => label.Replace(":1", "", StringComparison.Ordinal) },
        _ => label,
    };
}
