using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.SpoilerGuard.Model;

/// <summary>Policy-independent quality facts for a Series or Season. No episode paths or names.</summary>
public sealed class TagQualitySummary
{
    internal long? NextPremiere { get; init; }
    public int EpisodeCount { get; init; }
    public Dictionary<string, TagQualityCategory> Categories { get; init; } = new();
    /// <summary>Audio summaries for available language choices, including base-language fallbacks.</summary>
    public Dictionary<string, TagQualityCategory> AudioByLanguage { get; init; } = new();
    /// <summary>Audio for an unavailable region: generic tracks when present, otherwise all available tracks.</summary>
    public Dictionary<string, TagQualityCategory> AudioRegionFallback { get; init; } = new();
    /// <summary>Version-0 detector facts, independent of the current codec vocabulary.</summary>
    public TagQualityCategory LegacyAudio { get; init; } = new();
    /// <summary>Version-0 audio for the same language tiers as AudioByLanguage.</summary>
    public Dictionary<string, TagQualityCategory> LegacyAudioByLanguage { get; init; } = new();
    /// <summary>Version-0 audio for unavailable regions, retaining generic-track fallback.</summary>
    public Dictionary<string, TagQualityCategory> LegacyAudioRegionFallback { get; init; } = new();
    /// <summary>Source/format labels from the latest aired episode, used only by the latest policy.</summary>
    public string[] LatestExtras { get; init; } = System.Array.Empty<string>();

    /// <summary>Value equality for incremental no-op detection, including bounded value sets.</summary>
    public static bool ContentEquals(TagQualitySummary? a, TagQualitySummary? b) => ReferenceEquals(a, b)
        || (a != null && b != null && a.EpisodeCount == b.EpisodeCount
            && a.LatestExtras.SequenceEqual(b.LatestExtras)
            && TagQualityCategory.ContentEquals(a.LegacyAudio, b.LegacyAudio)
            && Equal(a.LegacyAudioByLanguage, b.LegacyAudioByLanguage) && Equal(a.LegacyAudioRegionFallback, b.LegacyAudioRegionFallback)
            && Equal(a.Categories, b.Categories) && Equal(a.AudioByLanguage, b.AudioByLanguage) && Equal(a.AudioRegionFallback, b.AudioRegionFallback));

    private static bool Equal(Dictionary<string, TagQualityCategory> a, Dictionary<string, TagQualityCategory> b) =>
        a.Count == b.Count && a.All(pair => b.TryGetValue(pair.Key, out var value) && TagQualityCategory.ContentEquals(pair.Value, value));
}

/// <summary>A category's independently ranked best, latest aired value and at most four distinct values, including unknown (null).</summary>
public sealed class TagQualityCategory
{
    public string? Best { get; init; }
    public string? Latest { get; init; }
    public string?[] Values { get; init; } = System.Array.Empty<string?>();
    /// <summary>Computed over every episode, independently of the bounded distinct set.</summary>
    public bool AllAgree { get; init; }
    /// <summary>Ranked union, intersection and latest-episode sets for All display mode.</summary>
    public string[] All { get; init; } = System.Array.Empty<string>();
    public string[] Shared { get; init; } = System.Array.Empty<string>();
    public string[] LatestAll { get; init; } = System.Array.Empty<string>();
    public bool AllSetsAgree { get; init; }

    internal static bool ContentEquals(TagQualityCategory a, TagQualityCategory b) =>
        a.Best == b.Best && a.Latest == b.Latest && a.AllAgree == b.AllAgree && a.Values.SequenceEqual(b.Values)
        && a.All.SequenceEqual(b.All) && a.Shared.SequenceEqual(b.Shared) && a.LatestAll.SequenceEqual(b.LatestAll) && a.AllSetsAgree == b.AllSetsAgree;
}
