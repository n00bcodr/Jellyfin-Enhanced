using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Port of <c>js/tags/qualitytags.js</c>: <c>getEnhancedQuality</c> (stream analysis on the
    /// server tag-cache <see cref="TagStreamData"/>) and <c>insertOverlay</c> (category buckets,
    /// per-category toggles and stack order). Case-insensitive JS regexes are matched on an
    /// ASCII-lowercased copy, which is exactly what a non-unicode <c>/i</c> JS regex does (it never
    /// folds a non-ASCII character onto an ASCII one); text the web lowercases with
    /// <c>toLowerCase()</c> first goes through <see cref="JsText.ToLower"/>. JS <c>\b</c> (ASCII word
    /// characters only) and <c>\s</c> are spelled out: .NET's ECMAScript mode also counts U+0130
    /// and U+212A as word characters.
    /// </summary>
    internal static class QualityTagRules
    {
        /// <summary>Model category keys, in default stack order.</summary>
        public const string Resolution = "resolution";

        /// <summary>Physical media stub source (BluRay, DVD...).</summary>
        public const string Source = "source";

        /// <summary>Dolby Vision / HDR.</summary>
        public const string DynamicRange = "dynamicRange";

        /// <summary>IMAX / 3D.</summary>
        public const string SpecialFormat = "specialFormat";

        /// <summary>Video codec.</summary>
        public const string VideoCodec = "videoCodec";

        /// <summary>Audio codec and channels.</summary>
        public const string AudioInfo = "audioInfo";

        /// <summary>Labels outside every category (kept last, as the web does).</summary>
        public const string Other = "other";

        private const string JsSpace = @"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";

        // JS \b around a pattern that starts and ends with word characters.
        private const string WordStart = "(?<![A-Za-z0-9_])";
        private const string WordEnd = "(?![A-Za-z0-9_])";
        private const RegexOptions Options = RegexOptions.CultureInvariant | RegexOptions.Compiled;

        private static readonly Regex ResolutionRegex = new(WordStart + "(8k|4320p|4k|2160p|1440p|1080p|720p|576p|480p|360p|404p|384p|520p)" + WordEnd, Options);
        private static readonly Regex ImaxRegex = new(WordStart + "imax(?:[ ._-]?enhanced)?" + WordEnd, Options);
        private static readonly Regex NonImaxRegex = new(WordStart + "non[ ._-]?imax" + WordEnd, Options);
        private static readonly Regex DolbyVisionRegex = new("dolby" + JsSpace + "*vision|dv", Options);
        private static readonly Regex HdrRegex = new(WordStart + "hdr" + WordEnd, Options);
        private static readonly Regex DtsRegex = new(WordStart + "dts" + WordEnd, Options);
        private static readonly Regex DolbyDigitalPlusRegex = new("dolby" + JsSpace + @"*digital\+", Options);
        private static readonly Regex Channels71Regex = new(WordStart + "7[. ]?1" + WordEnd, Options);
        private static readonly Regex Channels51Regex = new(WordStart + "5[. ]?1" + WordEnd, Options);
        private static readonly Regex Channels20Regex = new(WordStart + "stereo" + WordEnd + "|" + WordStart + "2[. ]?0" + WordEnd, Options);
        private static readonly Regex BareChannelRegex = new(@"^[0-9]+\.[0-9]+\z", Options);

        private static readonly string[] ResolutionOrder = { "8K", "4K", "1440p", "1080p", "720p", "576p", "480p", "LOW-RES", "SD" };
        private static readonly string[] SourceOrder = { "BluRay", "HD DVD", "DVD", "VHS", "HDTV", "Physical" };
        private static readonly string[] DynamicRangeOrder = { "Dolby Vision", "HDR10+", "HDR10", "HDR" };
        private static readonly string[] SpecialFormatOrder = { "IMAX", "3D" };
        private static readonly string[] CodecOrder = { "AV1", "HEVC", "H265", "VP9", "H264", "VP8", "XVID", "DIVX", "WMV", "MPEG2", "MPEG4", "MJPEG", "THEORA" };
        private static readonly string[] AudioOrder = { "ATMOS", "DTS-X", "TRUEHD", "DTS", "Dolby Digital+", "7.1", "5.1" };
        private static readonly string[] AudioBases = { "Dolby Digital+", "ATMOS", "DTS-X", "TRUEHD", "DTS" };

        // Video codec detection order (first match wins), on the lowercased Codec then DisplayTitle.
        private static readonly (string Needle, string Label)[] CodecNeedles =
        {
            ("hevc", "HEVC"), ("h265", "H265"), ("h264", "H264"), ("avc", "H264"), ("av1", "AV1"), ("vp9", "VP9"),
            ("vp8", "VP8"), ("xvid", "XVID"), ("divx", "DIVX"), ("wmv", "WMV"), ("vc1", "WMV"), ("mpeg2", "MPEG2"),
            ("mpeg4", "MPEG4"), ("mjpeg", "MJPEG"), ("theora", "THEORA"),
        };

        /// <summary>A quality category, as the web's CATEGORIES table.</summary>
        private sealed record Category(string Key, string[] Items, int DefaultOrder);

        private static readonly Category[] Categories =
        {
            new(Resolution, ResolutionOrder, 1),
            new(Source, SourceOrder, 2),
            new(DynamicRange, DynamicRangeOrder, 3),
            new(SpecialFormat, SpecialFormatOrder, 4),
            new(VideoCodec, CodecOrder, 5),
            new(AudioInfo, AudioOrder, 6),
        };

        /// <summary>
        /// Detected quality labels for a tag-cache entry, in detection order, or an empty list (the
        /// web renders nothing when StreamData or StreamData.Streams is missing).
        /// </summary>
        /// <param name="data">Entry stream data (Series/Season: the representative episode).</param>
        /// <param name="preferredAudioLanguage">Effective preferred audio language, or null.</param>
        public static List<string> Detect(TagStreamData? data, string? preferredAudioLanguage)
        {
            var qualities = new List<string>(6);
            if (data?.Streams is null) return qualities;

            var streams = data.Streams;
            var sources = data.Sources;

            // A null stream throws in the web's Type filter: the card gets no quality tags. (A null
            // source only throws if the 3D scan below reaches it; every other source read is
            // null-safe.)
            if (streams.Contains(null!)) return qualities;

            var videoStreams = new List<TagMediaStream>(1);
            var audioStreams = new List<TagMediaStream>(4);
            foreach (var stream in streams)
            {
                if (stream.Type == "Video") videoStreams.Add(stream);
                else if (stream.Type == "Audio") audioStreams.Add(stream);
            }

            audioStreams = SelectAudioStreamsForLanguage(audioStreams, preferredAudioLanguage);
            var primaryVideo = videoStreams.Count > 0 ? videoStreams[0] : null;

            // IMAX: item name (+ the item fields the server path does not carry), every source
            // path/name and every stream display title, joined with " | ".
            var imaxContext = JoinNonEmpty(EnumerateImaxSignals(data, sources, streams));
            if (imaxContext.Length > 0)
            {
                var lowered = JsText.AsciiLower(imaxContext);
                if (ImaxRegex.IsMatch(lowered) && !NonImaxRegex.IsMatch(lowered)) Add(qualities, "IMAX");
            }

            if (primaryVideo is not null)
            {
                var resolution = DetectResolution(primaryVideo);
                if (resolution is not null) Add(qualities, resolution);

                var codec = DetectCodec(primaryVideo);
                if (codec is not null) Add(qualities, codec);

                var hdr = DetectDynamicRange(primaryVideo);
                if (hdr is not null) Add(qualities, hdr);
            }

            var audio = DetectAudioCodec(audioStreams);
            var channels = DetectChannels(audioStreams);
            if (audio is not null)
            {
                if (channels is not null && !audio.Contains(channels, StringComparison.Ordinal)) audio = audio + " " + channels;
                Add(qualities, audio);
            }
            else if (channels is "7.1" or "5.1")
            {
                Add(qualities, channels);
            }

            if (sources is not null)
            {
                foreach (var source in sources)
                {
                    // source.Path on null throws, which drops every quality tag of the card.
                    if (source is null) return new List<string>(0);
                    if (string.IsNullOrEmpty(source.Path)) continue;
                    var path = JsText.ToLower(source.Path);
                    if (path.Contains("3d", StringComparison.Ordinal) && ContainsAny(path, "hsbs", "fsbs", "htab", "ftab", "mvc"))
                    {
                        Add(qualities, "3D");
                        break;
                    }
                }
            }

            var stub = DetectStub(data, sources);
            if (stub is not null) Add(qualities, stub);
            return qualities;
        }

        /// <summary>
        /// insertOverlay: drop disabled categories, sort within categories, keep one resolution,
        /// order categories by the user's stack order (ties by default order), uncategorized last.
        /// </summary>
        public static List<QualityTag> Arrange(List<string> qualities, PosterTagSettings settings)
        {
            var result = new List<QualityTag>(qualities.Count);
            if (qualities.Count == 0) return result;

            List<string>?[] buckets = new List<string>?[Categories.Length];
            List<string>? other = null;
            foreach (var label in qualities)
            {
                var index = CategoryIndex(label);
                if (index < 0)
                {
                    (other ??= new List<string>()).Add(label);
                    continue;
                }

                if (!settings.IsQualityCategoryShown(Categories[index].Key)) continue;
                (buckets[index] ??= new List<string>()).Add(label);
            }

            var order = new List<int>(Categories.Length);
            for (var i = 0; i < Categories.Length; i++)
            {
                var bucket = buckets[i];
                if (bucket is null) continue;
                var items = Categories[i].Items;
                StableSortBy(bucket, label =>
                {
                    var idx = Array.IndexOf(items, NormalizeLabel(label));
                    return idx == -1 ? 999 : idx;
                });
                if (i == 0 && bucket.Count > 1) bucket.RemoveRange(1, bucket.Count - 1);
                order.Add(i);
            }

            order.Sort((a, b) =>
            {
                var oa = settings.QualityCategoryOrder(Categories[a].Key);
                var ob = settings.QualityCategoryOrder(Categories[b].Key);
                return oa != ob ? oa.CompareTo(ob) : Categories[a].DefaultOrder.CompareTo(Categories[b].DefaultOrder);
            });

            foreach (var i in order)
            {
                foreach (var label in buckets[i]!) result.Add(new QualityTag(label, Categories[i].Key));
            }

            if (other is not null)
            {
                foreach (var label in other) result.Add(new QualityTag(label, Other));
            }

            return result;
        }

        /// <summary>Composite audio labels ("ATMOS 7.1") normalize to their base ("ATMOS").</summary>
        internal static string NormalizeLabel(string label)
        {
            foreach (var audioBase in AudioBases)
            {
                if (label == audioBase || label.StartsWith(audioBase + " ", StringComparison.Ordinal)) return audioBase;
            }

            return label;
        }

        private static int CategoryIndex(string label)
        {
            var normalized = NormalizeLabel(label);
            for (var i = 0; i < Categories.Length; i++)
            {
                if (Array.IndexOf(Categories[i].Items, normalized) >= 0) return i;
            }

            // Bare channel layouts ("2.0") fall into audio.
            return BareChannelRegex.IsMatch(label) ? Categories.Length - 1 : -1;
        }

        private static List<TagMediaStream> SelectAudioStreamsForLanguage(List<TagMediaStream> audioStreams, string? preferred)
        {
            if (string.IsNullOrEmpty(preferred) || audioStreams.Count == 0) return audioStreams;
            var exact = audioStreams.FindAll(s => LanguageFlagRules.MatchesLanguage(s.Language, preferred, requireRegion: true));
            if (exact.Count > 0) return exact;
            var loose = audioStreams.FindAll(s => LanguageFlagRules.MatchesLanguage(s.Language, preferred, requireRegion: false));
            return loose.Count > 0 ? loose : audioStreams;
        }

        private static IEnumerable<string?> EnumerateImaxSignals(TagStreamData data, List<TagMediaSource>? sources, List<TagMediaStream> streams)
        {
            // itemData = { Name, Path }: OriginalTitle/SortName/EditionTitle/ForcedSortName are absent.
            yield return data.ItemName;
            if (sources is not null)
            {
                foreach (var source in sources)
                {
                    yield return source?.Path;
                    yield return source?.Name;
                }
            }

            foreach (var stream in streams)
            {
                yield return stream?.DisplayTitle;
            }
        }

        private static string? DetectResolution(TagMediaStream video)
        {
            var displayTitle = JsText.AsciiLower(video.DisplayTitle);
            var height = video.Height ?? 0;
            var match = ResolutionRegex.Match(displayTitle);
            var found = match.Success ? match.Groups[1].Value : null;
            var falsely4K = found is "4k" or "2160p" && height > 0 && height < 1250;
            if (found is not null && !falsely4K)
            {
                return found switch
                {
                    "8k" or "4320p" => "8K",
                    "4k" or "2160p" => "4K",
                    "1440p" => "1440p",
                    "1080p" => "1080p",
                    "720p" => "720p",
                    "576p" => "576p",
                    "480p" => "480p",
                    _ => "LOW-RES", // 360p, 404p, 384p, 520p
                };
            }

            // Dimension fallback; the tag cache carries no Width (always 0 in the server path).
            if (height >= 3000) return "8K";
            if (height >= 1550) return "4K";
            if (height >= 1250) return "1440p";
            if (height >= 1000) return "1080p";
            if (height >= 700) return "720p";
            if (height >= 528) return "576p";
            if (height >= 400) return "480p";
            return height > 0 ? "LOW-RES" : null;
        }

        private static string? DetectCodec(TagMediaStream video)
        {
            var codec = JsText.ToLower(video.Codec ?? string.Empty);
            var codecTag = JsText.ToLower(video.CodecTag ?? string.Empty);
            foreach (var (needle, label) in CodecNeedles)
            {
                if (codec.Contains(needle, StringComparison.Ordinal)) return label;
                // CodecTag is only consulted for AVC, right after the codec's own h264/avc checks.
                if (needle == "avc" && codecTag.Contains("avc", StringComparison.Ordinal)) return label;
            }

            var displayTitle = JsText.ToLower(video.DisplayTitle ?? string.Empty);
            foreach (var (needle, label) in CodecNeedles)
            {
                if (displayTitle.Contains(needle, StringComparison.Ordinal)) return label;
            }

            return null;
        }

        private static string? DetectDynamicRange(TagMediaStream video)
        {
            var displayTitle = JsText.AsciiLower(video.DisplayTitle);
            var rangeType = JsText.AsciiLower(video.VideoRangeType);
            if (DolbyVisionRegex.IsMatch(displayTitle) || DolbyVisionRegex.IsMatch(rangeType)) return "Dolby Vision";
            if (displayTitle.Contains("hdr10plus", StringComparison.Ordinal) || rangeType.Contains("hdr10plus", StringComparison.Ordinal)) return "HDR10+";
            if (displayTitle.Contains("hdr10", StringComparison.Ordinal) || rangeType.Contains("hdr10", StringComparison.Ordinal)) return "HDR10";
            if (HdrRegex.IsMatch(displayTitle) || HdrRegex.IsMatch(rangeType)) return "HDR";
            return null;
        }

        private static string? DetectAudioCodec(List<TagMediaStream> audioStreams)
        {
            // Priority 1: the first stream whose display title names a codec.
            foreach (var stream in audioStreams)
            {
                var title = JsText.AsciiLower(stream.DisplayTitle);
                if (title.Contains("atmos", StringComparison.Ordinal)) return "ATMOS";
                if (title.Contains("truehd", StringComparison.Ordinal)) return "TRUEHD";
                if (title.Contains("dts-x", StringComparison.Ordinal)) return "DTS-X";
                if (DtsRegex.IsMatch(title)) return "DTS";
                if (DolbyDigitalPlusRegex.IsMatch(title)) return "Dolby Digital+";
            }

            // Priority 2: codec / profile metadata.
            foreach (var stream in audioStreams)
            {
                var codec = JsText.ToLower(stream.Codec ?? string.Empty);
                var profile = JsText.ToLower(stream.Profile ?? string.Empty);
                if (codec.Contains("truehd", StringComparison.Ordinal) || profile.Contains("truehd", StringComparison.Ordinal))
                {
                    return codec.Contains("atmos", StringComparison.Ordinal) || profile.Contains("atmos", StringComparison.Ordinal) ? "ATMOS" : "TRUEHD";
                }

                if (codec.Contains("dts", StringComparison.Ordinal))
                {
                    return codec.Contains('x', StringComparison.Ordinal) || profile.Contains('x', StringComparison.Ordinal) ? "DTS-X" : "DTS";
                }

                if (codec.Contains("eac3", StringComparison.Ordinal) || codec.Contains("ddp", StringComparison.Ordinal)) return "Dolby Digital+";
            }

            return null;
        }

        /// <summary>getChannelTag: richest layout named (7.1 &gt; 5.1 &gt; 2.0), else by max channel count.</summary>
        private static string? DetectChannels(List<TagMediaStream> audioStreams)
        {
            if (audioStreams.Count == 0) return null;
            var maxChannels = 0;
            var rank = 0;
            foreach (var stream in audioStreams)
            {
                var channels = stream.Channels ?? 0;
                if (channels > maxChannels) maxChannels = channels;

                // Lowercased with toLowerCase() before an ASCII-boundary match: K (Kelvin) becomes
                // a word character, İ becomes "i" + U+0307.
                var signals = JsText.ToLower((stream.ChannelLayout ?? string.Empty) + " " + (stream.DisplayTitle ?? string.Empty));
                var tagRank = Channels71Regex.IsMatch(signals) ? 3 : Channels51Regex.IsMatch(signals) ? 2 : Channels20Regex.IsMatch(signals) ? 1 : 0;
                if (tagRank > rank) rank = tagRank;
            }

            switch (rank)
            {
                case 3: return "7.1";
                case 2: return "5.1";
                case 1: return "2.0";
            }

            if (maxChannels >= 8) return "7.1";
            if (maxChannels >= 6) return "5.1";
            if (maxChannels >= 2) return "2.0";
            return null;
        }

        private static string? DetectStub(TagStreamData data, List<TagMediaSource>? sources)
        {
            var signals = new List<string?>(2 + ((sources?.Count ?? 0) * 2)) { data.ItemName, data.ItemPath };
            if (sources is not null)
            {
                foreach (var source in sources)
                {
                    signals.Add(source?.Path);
                    signals.Add(source?.Name);
                }
            }

            var context = JsText.ToLower(JoinNonEmpty(signals));
            if (!context.Contains(".disc", StringComparison.Ordinal)) return null;
            if (ContainsAny(context, "bluray", "blu-ray", "bdrip", "bd-rip", "bdremux")) return "BluRay";
            if (ContainsAny(context, "hddvd", "hd-dvd", "hd dvd")) return "HD DVD";
            if (context.Contains("dvd", StringComparison.Ordinal)) return "DVD";
            if (context.Contains("vhs", StringComparison.Ordinal)) return "VHS";
            if (context.Contains("hdtv", StringComparison.Ordinal)) return "HDTV";
            return "Physical";
        }

        private static string JoinNonEmpty(IEnumerable<string?> parts)
        {
            StringBuilder? sb = null;
            string? single = null;
            foreach (var part in parts)
            {
                if (string.IsNullOrEmpty(part)) continue;
                if (single is null && sb is null)
                {
                    single = part;
                    continue;
                }

                sb ??= new StringBuilder(single);
                sb.Append(" | ").Append(part);
            }

            return sb?.ToString() ?? single ?? string.Empty;
        }

        private static bool ContainsAny(string haystack, params string[] needles)
        {
            foreach (var needle in needles)
            {
                if (haystack.Contains(needle, StringComparison.Ordinal)) return true;
            }

            return false;
        }

        /// <summary>A Set: the web adds each label once, keeping first-insertion order.</summary>
        private static void Add(List<string> qualities, string label)
        {
            if (!qualities.Contains(label)) qualities.Add(label);
        }

        private static void StableSortBy(List<string> list, Func<string, int> key)
        {
            if (list.Count < 2) return;
            var keyed = new List<(int Key, int Index, string Value)>(list.Count);
            for (var i = 0; i < list.Count; i++) keyed.Add((key(list[i]), i, list[i]));
            keyed.Sort((a, b) => a.Key != b.Key ? a.Key.CompareTo(b.Key) : a.Index.CompareTo(b.Index));
            for (var i = 0; i < keyed.Count; i++) list[i] = keyed[i].Value;
        }
    }
}
