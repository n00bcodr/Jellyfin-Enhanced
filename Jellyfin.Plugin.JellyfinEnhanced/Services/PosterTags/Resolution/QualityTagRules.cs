using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using System.Runtime.CompilerServices;
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
        /// <summary>Shared compact vocabulary, retaining the full label for colour identity.</summary>
        internal static string CompactLabel(string label)
        {
            var audio = Regex.Match(label, @"^(.*) (\d+\.\d+)$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
            var key = audio.Success ? audio.Groups[1].Value : label;
            return QualityCompactLabels.Labels.TryGetValue(key, out var value)
                ? value.Text + (audio.Success && value.KeepChannels ? " " + audio.Groups[2].Value : string.Empty)
                : label;
        }

        /// <summary>Model category keys, in default stack order.</summary>
        public const string Resolution = "resolution";

        /// <summary>Release source or physical media stub source (REMUX, BluRay, DVD...).</summary>
        public const string Source = "source";

        /// <summary>Release edition from server-side naming detection.</summary>
        public const string Edition = "edition";
        public const string Runtime = "runtime";
        public const string AspectRatio = "aspectRatio";
        public const string FrameRate = "frameRate";
        internal const string EditionPrefix = "edition:";

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

        /// <summary>Lowercase resolution tokens recognised in stream display titles (also the bare-WEB filename vocabulary).</summary>
        internal static readonly string[] ResolutionTokens = { "8k", "4320p", "4k", "2160p", "1440p", "1080p", "720p", "576p", "480p", "360p", "404p", "384p", "520p" };

        private static readonly Regex ResolutionRegex = new(WordStart + "(" + string.Join("|", ResolutionTokens) + ")" + WordEnd, Options);
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
        private static readonly string[] SourceOrder = { "REMUX", "BluRay", "WEB", "HD DVD", "DVD", "VHS", "HDTV", "Physical", "CAM", "TS", "TC", "SCR" };
        private static readonly string[] DynamicRangeOrder = { "Dolby Vision", "HDR10+", "HDR10", "HDR", "SDR" };
        private static readonly string[] SpecialFormatOrder = { "IMAX", "3D" };
        private static readonly string[] CodecOrder = { "AV1", "HEVC", "H265", "VP9", "H264", "VP8", "XVID", "DIVX", "WMV", "MPEG2", "MPEG4", "MJPEG", "THEORA" };
        private static readonly string[] AudioOrder = { "ATMOS", "DTS-X", "TRUEHD", "DTS-HD MA", "DTS-HD HRA", "DTS", "Dolby Digital+", "Dolby Digital", "7.1", "5.1" };
        private static readonly string[] AudioBases = { "Dolby Digital+", "Dolby Digital", "ATMOS", "DTS-X", "TRUEHD", "DTS-HD MA", "DTS-HD HRA", "DTS" };

        // Video codec detection order (first match wins), on the lowercased Codec then DisplayTitle.
        private static readonly (string Needle, string Label)[] CodecNeedles =
        {
            ("hevc", "HEVC"), ("h265", "H265"), ("h264", "H264"), ("avc", "H264"), ("av1", "AV1"), ("vp9", "VP9"),
            ("vp8", "VP8"), ("xvid", "XVID"), ("divx", "DIVX"), ("wmv", "WMV"), ("vc1", "WMV"), ("mpeg2", "MPEG2"),
            ("mpeg4", "MPEG4"), ("mjpeg", "MJPEG"), ("theora", "THEORA"),
        };

        /// <summary>Lowercase video codec needles, in detection order (also the bare-WEB filename vocabulary).</summary>
        internal static readonly string[] CodecTokens = Array.ConvertAll(CodecNeedles, n => n.Needle);

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
            new(Edition, Array.Empty<string>(), 7),
            new(Runtime, Array.Empty<string>(), 8),
            new(AspectRatio, Array.Empty<string>(), 9),
            new(FrameRate, Array.Empty<string>(), 10),
        };

        /// <summary>
        /// Detected quality labels for a tag-cache entry, in detection order, or an empty list (the
        /// web renders nothing when StreamData or StreamData.Streams is missing).
        /// </summary>
        /// <param name="data">Entry stream data (Series/Season: the representative episode).</param>
        /// <param name="preferredAudioLanguage">Effective preferred audio language, or null.</param>
        /// <param name="releaseSource">Canonical server-derived source, or null for legacy entries.</param>
        /// <param name="edition">Server-derived edition label, or null.</param>
        public static List<string> Detect(TagStreamData? data, string? preferredAudioLanguage, string? releaseSource = null, string? edition = null, bool legacyAudio = false)
            => Detect(data, preferredAudioLanguage, releaseSource, edition, includeAudio: true, legacyAudio: legacyAudio);

        /// <summary>Detect each track independently, deduplicating category/label/language triples.</summary>
        internal static List<TagStreamQuality> DetectDistinct(IEnumerable<TagMediaStream>? streams, bool legacyAudio = false)
        {
            var values = new List<TagStreamQuality>();
            foreach (var stream in streams ?? Array.Empty<TagMediaStream>())
            {
                if (stream == null) continue;
                if (stream.Type == "Video")
                {
                    var codec = DetectCodec(stream);
                    if (codec != null) values.Add(new(VideoCodec, codec, SourceId: stream.SourceId));
                    // An unprobed track is unknown, not evidence of SDR.
                    var range = DetectDynamicRange(stream);
                    if (range != null) values.Add(new(DynamicRange, range, SourceId: stream.SourceId));
                    else if (!string.IsNullOrEmpty(stream.VideoRangeType) || !string.IsNullOrEmpty(stream.Codec) || stream.Height > 0)
                        values.Add(new(DynamicRange, "SDR", SourceId: stream.SourceId));
                }
                else if (stream.Type == "Audio")
                {
                    var track = new List<TagMediaStream> { stream };
                    var codec = DetectAudioCodec(track, legacyAudio);
                    var channels = DetectChannels(track);
                    var label = codec == null ? (channels is "7.1" or "5.1" ? channels : null)
                        : channels != null && !codec.Contains(channels, StringComparison.Ordinal) ? codec + " " + channels : codec;
                    if (label != null) values.Add(new(AudioInfo, label, stream.Language, stream.SourceId));
                }
            }
            return values.Distinct().ToList();
        }

        /// <summary>Use one merged version throughout detection and display modes. Native uses the first version.</summary>
        internal static TagStreamData? SelectSource(TagStreamData? data, string? sourceId = null)
        {
            if (data?.Streams == null) return data;
            var id = !string.IsNullOrEmpty(sourceId) && data.Streams.Any(s => s?.SourceId == sourceId)
                ? sourceId : data.Streams.FirstOrDefault(s => !string.IsNullOrEmpty(s?.SourceId))?.SourceId;
            if (id == null) return data;
            var source = data.Sources?.FirstOrDefault(s => s?.Id == id);
            return new TagStreamData
            {
                Streams = data.Streams.Where(s => s?.SourceId == id).ToList(),
                DistinctQualities = data.DistinctQualities?.Where(q => q.SourceId == id).ToList(),
                Sources = source == null ? data.Sources : new List<TagMediaSource> { source },
                ItemName = data.ItemName,
                ItemPath = source == null ? data.ItemPath : source.Path,
                RunTimeTicks = source?.RunTimeTicks ?? data.RunTimeTicks,
            };
        }

        /// <summary>Read cached distinct facts (or derive fixture/fallback facts) with the existing audio-language tiers.</summary>
        internal static List<string> DistinctValues(TagStreamData? data, string category, string? preferred, bool allSources = false, bool legacyAudio = false)
        {
            if (!allSources) data = SelectSource(data);
            var values = legacyAudio && category == AudioInfo ? DetectDistinct(data?.Streams, legacyAudio: true) : data?.DistinctQualities ?? DetectDistinct(data?.Streams);
            var candidates = values.Where(value => value.Category == category).ToList();
            if (category == AudioInfo && !string.IsNullOrEmpty(preferred))
            {
                // Availability includes tracks with no displayable label. Once a tier is
                // selected, an empty label set must not fall back to another language.
                var tracks = data?.Streams?.FindAll(stream => stream?.Type == "Audio") ?? new List<TagMediaStream>();
                var languages = SelectAudioStreamsForLanguage(tracks, preferred).Select(stream => stream.Language).ToHashSet(StringComparer.Ordinal);
                candidates = candidates.FindAll(value => languages.Contains(value.Language));
            }
            return candidates.Select(value => value.Label).Distinct(StringComparer.Ordinal)
                .OrderBy(label => AggregationRank(label, category)).ThenBy(label => label, StringComparer.Ordinal).ToList();
        }

        /// <summary>Replace only All categories; Highest follows the legacy detector exactly.</summary>
        internal static List<string> ApplyDisplayModes(TagStreamData? data, List<string> labels, string? preferred, Func<string, bool>? all, bool legacyAudio = false)
        {
            data = SelectSource(data);
            if (all == null || data?.Streams == null || data.Streams.Any(stream => stream == null)) return labels;
            // Preserve the web detector's malformed-source failure boundary. The
            // 3D search stops after its first match, so a later null is not read.
            foreach (var source in data.Sources ?? new List<TagMediaSource>())
            {
                if (source == null) return labels;
                var path = JsText.ToLower(source.Path ?? string.Empty);
                if (path.Contains("3d", StringComparison.Ordinal) && ContainsAny(path, "hsbs", "fsbs", "htab", "ftab", "mvc")) break;
            }
            foreach (var category in new[] { AudioInfo, VideoCodec, DynamicRange })
            {
                if (!all(category)) continue;
                labels.RemoveAll(label => CategoryOf(label) == category);
                labels.AddRange(DistinctValues(data, category, preferred, legacyAudio: legacyAudio));
            }
            return labels;
        }

        /// <summary>Detect video and source labels without computing audio that aggregation ranks per track.</summary>
        internal static List<string> DetectNonAudio(TagStreamData? data)
            => Detect(data, null, null, null, includeAudio: false);

        private static List<string> Detect(TagStreamData? data, string? preferredAudioLanguage, string? releaseSource, string? edition, bool includeAudio, bool legacyAudio = false)
        {
            data = SelectSource(data);
            var version = data?.Sources?.FirstOrDefault(s => !string.IsNullOrEmpty(s?.Id));
            if (version != null) { releaseSource = version.Source; edition = version.Edition; }
            var qualities = new List<string>(6);
            if (data?.Streams is null)
            {
                AddNamingTags(qualities, releaseSource, edition);
                return qualities;
            }

            if (TechnicalQualityRules.Runtime(data.RunTimeTicks) is { } runtime) Add(qualities, Runtime + ":" + runtime);
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
                else if (includeAudio && stream.Type == "Audio") audioStreams.Add(stream);
            }

            if (includeAudio) audioStreams = SelectAudioStreamsForLanguage(audioStreams, preferredAudioLanguage);
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
                if (TechnicalQualityRules.Aspect(primaryVideo) is { } aspect) Add(qualities, AspectRatio + ":" + aspect);
                if (TechnicalQualityRules.FrameRate(primaryVideo) is { } rate) Add(qualities, FrameRate + ":" + rate);
                var resolution = DetectResolution(primaryVideo);
                if (resolution is not null) Add(qualities, resolution);

                var codec = DetectCodec(primaryVideo);
                if (codec is not null) Add(qualities, codec);

                var hdr = DetectDynamicRange(primaryVideo);
                if (hdr is not null) Add(qualities, hdr);
            }

            if (includeAudio)
            {
                var audio = DetectAudioCodec(audioStreams, legacyAudio);
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
            if (releaseSource is not null) Add(qualities, releaseSource);
            else if (stub is not null) Add(qualities, stub);
            if (edition is not null) Add(qualities, EditionPrefix + edition);
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
                if (label == "SDR" && settings.QualityHideSdr) continue;
                if (CategoryOf(label) == Resolution && !QualityDisplayRules.MeetsMinimum(label, settings.QualityMinimumResolution)) continue;
                if (!settings.ShowLowQualitySourceTag && label is "CAM" or "TS" or "TC" or "SCR") continue;
                if (label == EditionPrefix + "IMAX" && qualities.Contains("IMAX") && settings.ShowSpecialFormatTag) continue;
                var index = CategoryIndex(label);
                if (index < 0)
                {
                    (other ??= new List<string>()).Add(label);
                    continue;
                }

                if (!settings.IsQualityCategoryShown(Categories[index].Key)) continue;
                var target = buckets[index] ??= new List<string>();
                if (!target.Contains(label)) target.Add(label);
            }

            var order = new List<int>(Categories.Length);
            for (var i = 0; i < Categories.Length; i++)
            {
                var bucket = buckets[i];
                if (bucket is null) continue;
                var items = Categories[i].Items;
                StableSortBy(bucket, label =>
                {
                    if (settings.AllQualityValues(Categories[i].Key)) return AggregationRank(label, Categories[i].Key);
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
                foreach (var label in buckets[i]!) result.Add(new QualityTag(Categories[i].Items.Length == 0 ? label[(label.IndexOf(':') + 1)..] : label, Categories[i].Key));
            }

            if (other is not null)
            {
                foreach (var label in other) result.Add(new QualityTag(label, Other));
            }

            return result;
        }

        private sealed record AudioLabel(string? Value);
        private static readonly ConditionalWeakTable<TagMediaStream, AudioLabel> LegacyAggregationAudio = new();
        private static readonly ConditionalWeakTable<TagMediaStream, AudioLabel> AggregationAudio = new();

        /// <summary>Rank actual audio tracks for aggregation, retaining language fallback and each track's own channels.</summary>
        internal static string? DetectAggregationAudio(TagStreamData? data, string? preferred, bool legacyAudio = false)
        {
            var streams = SelectAudioStreamsForLanguage(data?.Streams?.FindAll(stream => stream?.Type == "Audio") ?? new List<TagMediaStream>(), preferred);
            string? best = null;
            foreach (var stream in streams)
            {
                var label = (legacyAudio ? LegacyAggregationAudio : AggregationAudio).GetValue(stream, item =>
                {
                    var track = new List<TagMediaStream>(1) { item };
                    var codec = DetectAudioCodec(track, legacyAudio);
                    var channels = DetectChannels(track);
                    return new AudioLabel(codec == null ? (channels is "7.1" or "5.1" ? channels : null)
                        : channels != null && !codec.Contains(channels, StringComparison.Ordinal) ? codec + " " + channels : codec);
                }).Value;
                if (label != null && (best == null || AggregationRank(label, AudioInfo) < AggregationRank(best, AudioInfo))) best = label;
            }
            return best;
        }

        /// <summary>Category priority shared by the container accumulator and native resolver; richer channels break audio ties.</summary>
        internal static int AggregationRank(string label, string category)
        {
            var order = category switch
            {
                Resolution => ResolutionOrder, DynamicRange => DynamicRangeOrder,
                VideoCodec => CodecOrder, _ => AudioOrder,
            };
            var index = Array.IndexOf(order, NormalizeLabel(label));
            var channels = label.Contains("7.1", StringComparison.Ordinal) ? 0 : label.Contains("5.1", StringComparison.Ordinal) ? 1 : 2;
            return (index < 0 ? 999 : index) * 10 + (category == AudioInfo ? channels : 0);
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

        /// <summary>The category key of a quality label (composite labels by their base), or <see cref="Other"/>.</summary>
        /// <param name="label">A quality label.</param>
        /// <returns>The category key.</returns>
        internal static string CategoryOf(string label)
        {
            var index = CategoryIndex(label);
            return index < 0 ? Other : Categories[index].Key;
        }

        /// <summary>Naming facts remain usable for unprobed media without stream data.</summary>
        private static void AddNamingTags(List<string> qualities, string? source, string? edition)
        {
            if (source is not null) Add(qualities, source);
            if (edition is not null) Add(qualities, EditionPrefix + edition);
        }

        private static int CategoryIndex(string label)
        {
            for (var i = 0; i < Categories.Length; i++)
                if (Categories[i].Items.Length == 0 && label.StartsWith(Categories[i].Key + ":", StringComparison.Ordinal)) return i;
            var normalized = NormalizeLabel(label);
            for (var i = 0; i < Categories.Length; i++)
            {
                if (Array.IndexOf(Categories[i].Items, normalized) >= 0) return i;
            }

            // Bare channel layouts ("2.0") fall into audio.
            return BareChannelRegex.IsMatch(label) ? Array.FindIndex(Categories, c => c.Key == AudioInfo) : -1;
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
                if (stream?.Type != "Subtitle") yield return stream?.DisplayTitle;
            }
        }

        internal static string? DetectResolution(TagMediaStream video)
        {
            var displayTitle = JsText.AsciiLower(video.DisplayTitle);
            var height = video.Height ?? 0;
            var width = video.Width ?? 0;
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

            // Width covers cropped scope encodes (1920x800 is 1080p).
            if (height >= 3000 || width >= 7000) return "8K";
            if (height >= 1550 || width >= 3500) return "4K";
            if (height >= 1250 || width >= 2400) return "1440p";
            if (height >= 1000 || width >= 1800) return "1080p";
            if (height >= 700 || width >= 1200) return "720p";
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

        // Reference: Radarr/Sonarr audio custom formats, TRaSH-Guides Audio Formats:
        // https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/#audio-formats
        // Adapted to stream fields and existing chips: Atmos families → ATMOS, DTS-ES → DTS;
        // FLAC/PCM/AAC/Opus/MP3 keep channel-only fallback. Same precedence as qualitytags.js.
        private static readonly (Regex Pattern, string Label)[] AudioAliases =
        {
            (new(@"(?:^|[^a-z0-9_])(?:atmos|ddpa)(?![a-z_])", Options), "ATMOS"),
            (new(@"(?:^|[^a-z0-9_])true[ .-]?hd(?![a-z_])", Options), "TRUEHD"),
            (new(@"(?:^|[^a-z0-9_])dts[-_.: ]?x7?(?![a-z_])(?![-_. ]?26[456])", Options), "DTS-X"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:hra?|hi|high[ -]?resolution)(?![a-z_])", Options), "DTS-HD HRA"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?(?:ma|hd(?:[-_. ]?ma)?|xll|master[ -]?audio)(?![a-z_])", Options), "DTS-HD MA"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?es(?![a-z_])", Options), "DTS"),
            (new(@"(?:^|[^a-z0-9_])dts(?![a-z_])", Options), "DTS"),
            (new(@"(?:^|[^a-z0-9_])(?:ddp(?:lus)?|dd\+|e[-_. ]?ac-?3|dolby" + JsSpace + @"*digital(?:" + JsSpace + @"*plus|" + JsSpace + @"*\+))(?![a-z_])", Options), "Dolby Digital+"),
            (new(@"(?:^|[^a-z0-9_])(?:dd(?!" + JsSpace + @"*\+)|dolby" + JsSpace + @"*digital(?!" + JsSpace + @"*(?:plus|\+)))(?![a-z_])|(?:^|[^a-z0-9_-])ac-?3(?![a-z_])", Options), "Dolby Digital"),
        };

        private static string? AudioCodecFromText(string? text)
        {
            var value = JsText.ToLower(text ?? string.Empty);
            foreach (var (pattern, label) in AudioAliases) if (pattern.IsMatch(value)) return label;
            return null;
        }

        private static string? DetectCurrentAudioCodec(List<TagMediaStream> streams)
        {
            foreach (var stream in streams)
            {
                var title = AudioCodecFromText(stream.DisplayTitle);
                if (title != null) return AudioCodecFromText(stream.DisplayTitle + " " + stream.Codec + " " + stream.Profile) ?? title;
            }
            foreach (var stream in streams)
            {
                var label = AudioCodecFromText(stream.Codec + " " + stream.Profile);
                if (label != null) return label;
            }
            return null;
        }

        private static string? DetectAudioCodec(List<TagMediaStream> audioStreams, bool legacyAudio = false)
        {
            if (!legacyAudio) return DetectCurrentAudioCodec(audioStreams);
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
                    if (codec.Contains('x', StringComparison.Ordinal) || profile.Contains('x', StringComparison.Ordinal)) return "DTS-X";
                    return "DTS";
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
            if (!Regex.IsMatch(context, @"\.disc(?:$|\s*\|)", Options)) return null;
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
