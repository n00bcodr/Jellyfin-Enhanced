using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

/// <summary>Hearing-impaired subtitle detection, independent of language spelling and rendering style.</summary>
internal static class SubtitleAccessibility
{
    private static readonly Regex Marker = new(@"\b(?:SDH|CC)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    internal static bool IsSdh(bool? hearingImpaired, string? title, string? displayTitle) =>
        hearingImpaired == true || Marker.IsMatch((title ?? string.Empty) + " " + displayTitle);

    internal static string[] Languages(IEnumerable<TagMediaStream>? streams) => (streams ?? Array.Empty<TagMediaStream>())
        .Where(s => s?.Type == "Subtitle" && IsSdh(s.IsHearingImpaired, s.Title, s.DisplayTitle))
        .Select(s => Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.TagCacheService.NormalizeStreamLanguage(s.Language)).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
}
