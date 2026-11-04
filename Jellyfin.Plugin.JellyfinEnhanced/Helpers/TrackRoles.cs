using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers;

/// <summary>
/// Which tracks count as a title's languages (js/tags/languagetags.js isSecondaryAudio mirrors it): a
/// commentary or audio-description track is not a dub, and a forced subtitle track (signs, foreign
/// dialogue) is not a subtitle option for the whole title.
/// </summary>
internal static class TrackRoles
{
    private static readonly Regex SecondaryAudioWords = new(
        @"(?<![a-z0-9])(?:commentar(?:y|ies)|audio[ -]?descri(?:ption|bed)|described[ -]video|descriptive[ -](?:audio|video|track)|visually[ -]impaired)(?![a-z0-9])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    // "AD" only as an upper-case word, so "Ad" or "ad-free" never match.
    private static readonly Regex AudioDescriptionAbbreviation = new(@"(?<![A-Za-z0-9])AD(?![A-Za-z0-9])", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>True for a commentary or audio-description audio track, from its title.</summary>
    internal static bool IsSecondaryAudio(string? title, string? displayTitle)
    {
        var text = (title ?? string.Empty) + " | " + (displayTitle ?? string.Empty);
        return SecondaryAudioWords.IsMatch(text) || AudioDescriptionAbbreviation.IsMatch(text);
    }
}
