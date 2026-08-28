using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Lightweight Matroska track-language reader.
    ///
    /// FFmpeg currently exposes Matroska LanguageBCP47/LanguageIETF values only
    /// as their base ISO-639 language (for example pt-BR -> por, en-US -> eng),
    /// which loses the region needed by Jellyfin Enhanced's flag resolver.
    ///
    /// This reader inspects only the Matroska header/Tracks structure and never
    /// reads media clusters. It has no dependency on mkvmerge or another external
    /// executable.
    /// </summary>
    internal static class MatroskaLanguageReader
    {
        private const ulong SegmentId = 0x18538067;
        private const ulong TracksId = 0x1654AE6B;
        private const ulong ClusterId = 0x1F43B675;
        private const ulong TrackEntryId = 0xAE;

        private const ulong TrackTypeId = 0x83;
        private const ulong LanguageId = 0x22B59C;
        private const ulong LanguageBcp47Id = 0x22B59D;

        private const ulong AudioTrackType = 2;

        // Language tags are tiny. Reject absurd element sizes rather than
        // allocating unbounded buffers if a malformed file is encountered.
        private const ulong MaxLanguageElementSize = 1024;

        /// <summary>
        /// Reads effective language values for audio TrackEntry elements, in
        /// Matroska audio-track order.
        ///
        /// Each list position corresponds to one audio track. A null entry is
        /// retained when that track has no usable language, so callers can safely
        /// align this list with Jellyfin's audio streams by ordinal without later
        /// tracks shifting position.
        ///
        /// LanguageBCP47/LanguageIETF takes precedence over legacy Language.
        /// </summary>
        /// <param name="path">Local Matroska/WebM file path.</param>
        /// <param name="languages">
        /// Audio languages in track order. Entries may be null.
        /// </param>
        /// <returns>
        /// True when the Matroska Tracks element was parsed successfully; false
        /// for unsupported paths, inaccessible/malformed files, or files whose
        /// Tracks element cannot be located safely.
        /// </returns>
        public static bool TryReadAudioLanguages(
            string? path,
            out IReadOnlyList<string?> languages)
        {
            languages = Array.Empty<string?>();

            if (!IsSupportedPath(path) || !File.Exists(path))
            {
                return false;
            }

            try
            {
                using var stream = new FileStream(
                    path!,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete,
                    bufferSize: 4096,
                    FileOptions.RandomAccess);

                if (!TryFindSegment(stream, out var segment))
                {
                    return false;
                }

                if (!TryFindTracks(stream, segment, out var tracks))
                {
                    return false;
                }

                var result = new List<string?>();
                if (!TryParseTracks(stream, tracks, result))
                {
                    return false;
                }

                languages = result;
                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (InvalidDataException)
            {
                return false;
            }
            catch (NotSupportedException)
            {
                return false;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        private static bool IsSupportedPath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            var extension = Path.GetExtension(path);
            return extension.Equals(".mkv", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".mka", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".mks", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".mk3d", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".webm", StringComparison.OrdinalIgnoreCase);
        }

        private static bool TryFindSegment(
            Stream stream,
            out ElementHeader segment)
        {
            segment = default;
            stream.Position = 0;

            while (stream.Position < stream.Length)
            {
                if (!TryReadElementHeader(stream, out var element))
                {
                    return false;
                }

                if (element.Id == SegmentId)
                {
                    segment = element;
                    return true;
                }

                if (!element.End.HasValue)
                {
                    return false;
                }

                stream.Position = element.End.Value;
            }

            return false;
        }

        private static bool TryFindTracks(
            Stream stream,
            ElementHeader segment,
            out ElementHeader tracks)
        {
            tracks = default;
            stream.Position = segment.DataStart;

            var segmentEnd = segment.End ?? stream.Length;

            while (stream.Position < segmentEnd && stream.Position < stream.Length)
            {
                if (!TryReadElementHeader(stream, out var element))
                {
                    return false;
                }

                if (element.Id == TracksId)
                {
                    if (!element.End.HasValue)
                    {
                        return false;
                    }

                    tracks = element;
                    return true;
                }

                // Tracks normally precedes the first media Cluster. Do not scan
                // through the media payload if a malformed/unusual file places
                // Tracks later; just fall back to Jellyfin's current language.
                if (element.Id == ClusterId)
                {
                    return false;
                }

                if (!element.End.HasValue)
                {
                    return false;
                }

                if (element.End.Value > segmentEnd
                    || element.End.Value > stream.Length)
                {
                    return false;
                }

                stream.Position = element.End.Value;
            }

            return false;
        }

        private static bool TryParseTracks(
            Stream stream,
            ElementHeader tracks,
            List<string?> audioLanguages)
        {
            if (!tracks.End.HasValue)
            {
                return false;
            }

            stream.Position = tracks.DataStart;

            while (stream.Position < tracks.End.Value)
            {
                if (!TryReadElementHeader(stream, out var element))
                {
                    return false;
                }

                if (!element.End.HasValue
                    || element.End.Value > tracks.End.Value)
                {
                    return false;
                }

                if (element.Id == TrackEntryId)
                {
                    if (!TryParseTrackEntry(
                            stream,
                            element,
                            out var trackType,
                            out var legacyLanguage,
                            out var bcp47Language))
                    {
                        return false;
                    }

                    if (trackType == AudioTrackType)
                    {
                        audioLanguages.Add(
                            NormalizeLanguage(bcp47Language)
                            ?? NormalizeLanguage(legacyLanguage));
                    }
                }

                stream.Position = element.End.Value;
            }

            return stream.Position == tracks.End.Value;
        }

        private static bool TryParseTrackEntry(
            Stream stream,
            ElementHeader trackEntry,
            out ulong? trackType,
            out string? legacyLanguage,
            out string? bcp47Language)
        {
            trackType = null;
            legacyLanguage = null;
            bcp47Language = null;

            if (!trackEntry.End.HasValue)
            {
                return false;
            }

            stream.Position = trackEntry.DataStart;

            while (stream.Position < trackEntry.End.Value)
            {
                if (!TryReadElementHeader(stream, out var element))
                {
                    return false;
                }

                if (!element.End.HasValue
                    || element.End.Value > trackEntry.End.Value)
                {
                    return false;
                }

                if (element.Id == TrackTypeId)
                {
                    if (!TryReadUnsignedInteger(stream, element, out var value))
                    {
                        return false;
                    }

                    trackType = value;
                }
                else if (element.Id == LanguageId)
                {
                    if (!TryReadUtf8String(stream, element, out legacyLanguage))
                    {
                        return false;
                    }
                }
                else if (element.Id == LanguageBcp47Id
                    && !TryReadUtf8String(stream, element, out bcp47Language))
                {
                    return false;
                }

                stream.Position = element.End.Value;
            }

            return stream.Position == trackEntry.End.Value;
        }

        private static bool TryReadUnsignedInteger(
            Stream stream,
            ElementHeader element,
            out ulong value)
        {
            value = 0;

            if (element.Size > 8)
            {
                return false;
            }

            for (ulong i = 0; i < element.Size; i++)
            {
                var next = stream.ReadByte();
                if (next < 0)
                {
                    return false;
                }

                value = (value << 8) | (byte)next;
            }

            return true;
        }

        private static bool TryReadUtf8String(
            Stream stream,
            ElementHeader element,
            out string? value)
        {
            value = null;

            if (element.Size > MaxLanguageElementSize
                || element.Size > int.MaxValue)
            {
                return false;
            }

            var length = (int)element.Size;
            var buffer = new byte[length];

            var read = 0;
            while (read < length)
            {
                var count = stream.Read(buffer, read, length - read);
                if (count <= 0)
                {
                    return false;
                }

                read += count;
            }

            value = Encoding.UTF8
                .GetString(buffer)
                .TrimEnd('\0');

            return true;
        }

        private static string? NormalizeLanguage(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            var normalized = value.Trim();

            if (normalized.Equals("und", StringComparison.OrdinalIgnoreCase)
                || normalized.Equals("root", StringComparison.OrdinalIgnoreCase)
                || normalized.Equals("zxx", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            return normalized;
        }

        private static bool TryReadElementHeader(
            Stream stream,
            out ElementHeader element)
        {
            element = default;

            if (!TryReadVint(
                    stream,
                    removeMarker: false,
                    out var id,
                    out _,
                    out _))
            {
                return false;
            }

            if (!TryReadVint(
                    stream,
                    removeMarker: true,
                    out var size,
                    out _,
                    out var unknownSize))
            {
                return false;
            }

            var dataStart = stream.Position;
            long? end = null;

            if (!unknownSize)
            {
                if (size > long.MaxValue)
                {
                    return false;
                }

                try
                {
                    end = checked(dataStart + (long)size);
                }
                catch (OverflowException)
                {
                    return false;
                }

                if (end.Value < dataStart)
                {
                    return false;
                }
            }

            element = new ElementHeader(
                id,
                size,
                dataStart,
                end);

            return true;
        }

        private static bool TryReadVint(
            Stream stream,
            bool removeMarker,
            out ulong value,
            out int length,
            out bool unknown)
        {
            value = 0;
            length = 0;
            unknown = false;

            var firstValue = stream.ReadByte();
            if (firstValue < 0)
            {
                return false;
            }

            var first = (byte)firstValue;
            byte marker = 0x80;
            length = 1;

            while (length <= 8 && (first & marker) == 0)
            {
                marker >>= 1;
                length++;
            }

            if (length > 8 || marker == 0)
            {
                return false;
            }

            value = removeMarker
                ? (ulong)(first & (marker - 1))
                : first;

            for (var i = 1; i < length; i++)
            {
                var next = stream.ReadByte();
                if (next < 0)
                {
                    return false;
                }

                value = (value << 8) | (byte)next;
            }

            if (removeMarker)
            {
                var valueBits = 7 * length;
                var unknownValue = (1UL << valueBits) - 1UL;

                unknown = value == unknownValue;
            }

            return true;
        }

        private readonly struct ElementHeader
        {
            public ElementHeader(
                ulong id,
                ulong size,
                long dataStart,
                long? end)
            {
                Id = id;
                Size = size;
                DataStart = dataStart;
                End = end;
            }

            public ulong Id { get; }

            public ulong Size { get; }

            public long DataStart { get; }

            public long? End { get; }
        }
    }
}
