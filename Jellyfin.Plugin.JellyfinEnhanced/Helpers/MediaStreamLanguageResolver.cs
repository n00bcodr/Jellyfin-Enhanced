using System;
using System.Collections.Generic;
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
    /// </summary>
    internal static class MediaStreamLanguageResolver
    {
        public static IReadOnlyList<ResolvedMediaStream> Resolve(
            MediaSourceInfo source,
            string? fallbackPath = null)
        {
            if (source.MediaStreams == null || source.MediaStreams.Count == 0)
            {
                return Array.Empty<ResolvedMediaStream>();
            }

            var sourcePath = !string.IsNullOrWhiteSpace(source.Path)
                ? source.Path
                : fallbackPath;

            var hasMatroskaLanguages =
                MatroskaLanguageReader.TryReadAudioLanguages(
                    sourcePath,
                    out var matroskaAudioLanguages);

            var internalAudioCount = 0;
            foreach (var stream in source.MediaStreams)
            {
                if (stream.Type == MediaStreamType.Audio && !stream.IsExternal)
                {
                    internalAudioCount++;
                }
            }

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
