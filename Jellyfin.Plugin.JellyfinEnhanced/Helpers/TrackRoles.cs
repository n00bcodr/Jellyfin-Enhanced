using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers;

/// <summary>
/// Which tracks count as a title's languages (js/tags/languagetags.js isSecondaryAudio mirrors it): a
/// commentary or audio-description track is not a dub, and a forced subtitle track (signs, foreign
/// dialogue) is not a subtitle option for the whole title.
/// </summary>
internal static class TrackRoles
{
    // Word stems, matched inside longer words too (German "Audiokommentar", "Kommentarspur"): English,
    // French, Italian and Dutch "comment…", German/Nordic "kommentar", Hungarian "kommentár",
    // Estonian "kommentaar", Spanish/Portuguese/Catalan "comentari/comentári", Polish/Czech
    // "komentar/komentář", Finnish "kommentti", Russian "комментар", Ukrainian "коментар", Greek
    // "σχόλια", Turkish "yorum", Arabic "تعليق", Hebrew "פרשנות", Japanese "解説/コメンタリー", Chinese
    // "解说/解說/评论/評論", Korean "코멘터리/해설"; audio description in those languages
    // ("audiodescription", "audiodescripción", "Audiodeskription", "Hörfilm", "syntolkning",
    // "synstolkning", "kuvailutulkkaus", "аудиоопис", "sesli betimleme", "音声ガイド", "口述影像", "音频描述").
    private static readonly Regex SecondaryAudioWords = new(
        @"comment|kommentar|kommentár|kommentaar|comentari|comentári|komentar|komentář|kommentti|комментар|коментар|σχόλι|yorum|تعليق|פרשנות|解説|解说|解說|评论|評論|コメンタリー|코멘터리|해설|audio[ -]?descri|audio[ -]?deskri|description[ -]audio|described[ -]video|descriptive[ -](?:audio|video|track)|visually[ -]impaired|hörfilm|syntolk|synstolk|kuvailutulk|аудиоопис|аудіоопис|sesli betimleme|音声ガイド|口述影像|音频描述|音訊描述",
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
