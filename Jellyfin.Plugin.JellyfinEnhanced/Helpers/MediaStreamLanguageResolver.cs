using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Resolves the effective language for media streams.
    ///
    /// Jellyfin/FFmpeg currently reduces Matroska LanguageBCP47 values such as
    /// pt-BR or en-US to their base ISO-639 language. For local Matroska sources,
    /// prefer the authoritative BCP-47 value read directly from TrackEntry while
    /// preserving Jellyfin's existing language as a fallback.
    ///
    /// The file is only consulted when the source has embedded audio streams for
    /// its languages to align with, and, given a <see cref="MatroskaLanguageCache"/>,
    /// only opened when it changed since it was last read. A Jellyfin language
    /// of "por" or "eng" is not a reason to skip the read: that is exactly the
    /// reduced value the file's BCP-47 tag corrects.
    /// </summary>
    internal static class MediaStreamLanguageResolver
    {
        public static IReadOnlyList<ResolvedMediaStream> Resolve(
            MediaSourceInfo source,
            string? fallbackPath = null,
            MatroskaLanguageCache? cache = null)
        {
            if (source.MediaStreams == null || source.MediaStreams.Count == 0)
            {
                return Array.Empty<ResolvedMediaStream>();
            }

            var sourcePath = !string.IsNullOrWhiteSpace(source.Path)
                ? source.Path
                : fallbackPath;

            var internalAudioCount = source.MediaStreams.Count(
                stream => stream.Type == MediaStreamType.Audio
                    && !stream.IsExternal);

            // The file's languages can only be aligned onto embedded audio
            // streams, so without any there is nothing to read (or stat) for.
            IReadOnlyList<string?> matroskaAudioLanguages = Array.Empty<string?>();
            var hasMatroskaLanguages =
                internalAudioCount > 0
                && (cache != null
                    ? cache.TryGetAudioLanguages(sourcePath, out matroskaAudioLanguages)
                    : MatroskaLanguageReader.TryReadAudioLanguages(sourcePath, out matroskaAudioLanguages));

            // Only align by ordinal when both views contain exactly the same
            // number of embedded audio tracks. This prevents a missing stream
            // or an external audio file from shifting BCP-47 languages onto
            // the wrong Jellyfin stream.
            var canAlignMatroskaLanguages =
                hasMatroskaLanguages
                && matroskaAudioLanguages.Count == internalAudioCount;

            var result = new List<ResolvedMediaStream>(
                source.MediaStreams.Count);

            var audioOrdinal = 0;

            foreach (var stream in source.MediaStreams)
            {
                var effectiveLanguage = stream.Language;

                if (stream.Type == MediaStreamType.Audio && !stream.IsExternal)
                {
                    if (canAlignMatroskaLanguages
                        && audioOrdinal < matroskaAudioLanguages.Count
                        && !string.IsNullOrWhiteSpace(
                            matroskaAudioLanguages[audioOrdinal]))
                    {
                        effectiveLanguage =
                            matroskaAudioLanguages[audioOrdinal];
                    }

                    audioOrdinal++;
                }

                result.Add(
                    new ResolvedMediaStream(
                        stream,
                        effectiveLanguage));
            }

            return result;
        }
    }

    internal readonly struct ResolvedMediaStream
    {
        public ResolvedMediaStream(
            MediaStream stream,
            string? language)
        {
            Stream = stream;
            Language = language;
        }

        public MediaStream Stream { get; }

        public string? Language { get; }
    }
}
