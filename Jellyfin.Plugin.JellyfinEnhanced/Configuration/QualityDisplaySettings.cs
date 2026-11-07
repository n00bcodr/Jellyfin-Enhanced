using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration;

/// <summary>Shared validation of per-category stream display modes and resolution filtering.</summary>
public static class QualityDisplayRules
{
    /// <summary>Canonical stream display mode; unknown values retain the legacy highest-only mode.</summary>
    public static string Mode(string? value) => value?.Trim().ToLowerInvariant() == "all" ? "all" : "highest";

    /// <summary>Canonical resolution threshold; unknown values disable filtering.</summary>
    public static string Minimum(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "720p" => "720p", "1080p" => "1080p", "4k" => "4k", _ => "off",
    };

    /// <summary>Whether a detected resolution meets the inclusive threshold.</summary>
    public static bool MeetsMinimum(string label, string? minimum) => Minimum(minimum) switch
    {
        "4k" => label is "8K" or "4K",
        "1080p" => label is "8K" or "4K" or "1440p" or "1080p" or "1080i",
        "720p" => label is "8K" or "4K" or "1440p" or "1080p" or "1080i" or "720p",
        _ => true,
    };
}
