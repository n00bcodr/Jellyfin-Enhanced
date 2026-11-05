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
            var audio = Regex.Match(label, @"^(.*) (\d+\.\d+(?:\.\d+)?)$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
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

        /// <summary>How many versions (media sources) an item has, from two up.</summary>
        public const string Versions = "versions";
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
        internal static readonly string[] ResolutionTokens = { "8k", "4320p", "4k", "2160p", "1440p", "1080p", "1080i", "720p", "576p", "576i", "480p", "480i", "360p", "404p", "384p", "520p" };

        private static readonly Regex ResolutionRegex = new(WordStart + "(" + string.Join("|", ResolutionTokens) + ")" + WordEnd, Options);
        private static readonly Regex ImaxRegex = new(WordStart + "imax(?:[ ._-]?enhanced)?" + WordEnd, Options);
        private static readonly Regex NonImaxRegex = new(WordStart + "non[ ._-]?imax" + WordEnd, Options);
        private static readonly Regex DtsRegex = new(WordStart + "dts" + WordEnd, Options);
        private static readonly Regex DolbyDigitalPlusRegex = new("dolby" + JsSpace + @"*digital\+", Options);
        private static readonly Regex Channels71Regex = new(WordStart + "7[. ]?1" + WordEnd, Options);
        private static readonly Regex Channels51Regex = new(WordStart + "5[. ]?1" + WordEnd, Options);
        private static readonly Regex Channels20Regex = new(WordStart + "stereo" + WordEnd + "|" + WordStart + "2[. ]?0" + WordEnd, Options);
        private static readonly Regex BareChannelRegex = new(@"^[0-9]+\.[0-9]+\z", Options);
        private static readonly Regex TrailingLayoutRegex = new(@"([0-9])\.([0-9])(?:\.([0-9]))?\z", Options);

        private static readonly string[] ResolutionOrder = { "8K", "4K", "1440p", "1080p", "1080i", "720p", "576p", "576i", "480p", "480i", "LOW-RES", "SD" };
        private static readonly string[] SourceOrder = { "REMUX", "BluRay", "WEB", "HD DVD", "DVD", "VHS", "HDTV", "SDTV", "Physical", "CAM", "TS", "TC", "SCR" };

        /// <summary>
        /// Which source is the better copy, best first: the one ranking for summaries (Best of a season) and for
        /// choosing among an item's versions, apart from <see cref="SourceOrder"/>'s presentation order. Broadcast
        /// captures beat tape; among pre-release copies a screener beats a telecine, a telecine a telesync, and a
        /// telesync a camera recording.
        /// </summary>
        internal static readonly string[] SourceQualityOrder = { "REMUX", "BluRay", "WEB", "HD DVD", "HDTV", "DVD", "SDTV", "VHS", "Physical", "SCR", "TC", "TS", "CAM" };
        private static readonly string[] DynamicRangeOrder = { "Dolby Vision", "HDR10+", "HDR10", "HLG", "HDR", "SDR" };
        private static readonly string[] SpecialFormatOrder = { "IMAX", "3D" };
        private static readonly string[] CodecOrder = { "VVC", "AV1", "HEVC", "H265", "VP9", "H264", "VP8", "XVID", "DIVX", "VC-1", "WMV", "MPEG2", "MPEG4", "MJPEG", "THEORA", "ProRes" };
        // TRaSH-Guides audio scores, highest first; from Dolby Digital+ on, lossy tracks rank by channels first (audioOrder in qualitytags.js).
        private static readonly string[] AudioOrder = { "TRUEHD ATMOS", "DTS-X", "ATMOS", "DD+ ATMOS", "TRUEHD", "DTS-HD MA", "PCM", "FLAC", "DTS-HD HRA", "DTS-HD", "Dolby Digital+", "DTS", "Dolby Digital", "7.1", "6.1", "5.1" };
        private static readonly int LossyAudioFrom = Array.IndexOf(AudioOrder, "Dolby Digital+");
        private static readonly string[] AudioBases = { "TRUEHD ATMOS", "DD+ ATMOS", "Dolby Digital+", "Dolby Digital", "ATMOS", "DTS-X", "TRUEHD", "DTS-HD MA", "DTS-HD HRA", "DTS-HD", "DTS", "PCM", "FLAC" };

        // Video codec detection order (first match wins), on the lowercased Codec then DisplayTitle.
        // The bare-WEB filename vocabulary (CodecTokens); detection uses CurrentCodecNeedles.
        private static readonly (string Needle, string Label)[] CodecNeedles =
        {
            ("hevc", "HEVC"), ("h265", "H265"), ("h264", "H264"), ("avc", "H264"), ("av1", "AV1"), ("vp9", "VP9"),
            ("vp8", "VP8"), ("xvid", "XVID"), ("divx", "DIVX"), ("wmv", "WMV"), ("vc1", "WMV"), ("mpeg2", "MPEG2"),
            ("mpeg4", "MPEG4"), ("mjpeg", "MJPEG"), ("theora", "THEORA"),
        };

        // Current vocabulary, same order as qualitytags.js detectVideoCodec.
        private static readonly (string Needle, string Label)[] CurrentCodecNeedles =
        {
            ("vvc", "VVC"), ("h266", "VVC"),
            ("hevc", "HEVC"), ("h265", "H265"), ("h264", "H264"), ("avc", "H264"), ("av1", "AV1"), ("vp9", "VP9"),
            ("vp8", "VP8"), ("xvid", "XVID"), ("divx", "DIVX"), ("wmv", "WMV"), ("vc1", "VC-1"), ("mpeg2", "MPEG2"),
            ("mpeg4", "MPEG4"), ("mjpeg", "MJPEG"), ("theora", "THEORA"), ("prores", "ProRes"),
        };

        /// <summary>Lowercase video codec needles, in detection order (also the bare-WEB filename vocabulary).</summary>
        internal static readonly string[] CodecTokens = Array.ConvertAll(CodecNeedles, n => n.Needle);

        /// <summary>One video stream's dynamic range, Dolby Vision base layer and known-SDR flag.</summary>
        internal readonly record struct RangeFacts(string? Range, string? Base, bool Sdr);

        // Jellyfin VideoRangeType names (both targets), lowercased; mirrors RANGE_TYPES in qualitytags.js.
        private static readonly Dictionary<string, RangeFacts> RangeTypes = new(StringComparer.Ordinal)
        {
            ["sdr"] = new(null, null, true),
            ["hdr10"] = new("HDR10", null, false),
            ["hdr10plus"] = new("HDR10+", null, false),
            ["hlg"] = new("HLG", null, false),
            ["dovi"] = new("Dolby Vision", null, false),
            ["doviwithhdr10"] = new("Dolby Vision", "HDR10", false),
            ["doviwithhdr10plus"] = new("Dolby Vision", "HDR10+", false),
            ["doviwithhlg"] = new("Dolby Vision", "HLG", false),
            ["doviwithsdr"] = new("Dolby Vision", "SDR", false),
            ["doviwithel"] = new("Dolby Vision", "HDR10", false),
            ["doviwithelhdr10plus"] = new("Dolby Vision", "HDR10+", false),
        };

        private const string WordBefore = "(?:^|[^a-z0-9_])";
        private const string WordAfter = "(?![a-z0-9_])";
        private static readonly Regex TitleDolbyVisionRegex = new(WordBefore + "(?:dolby" + JsSpace + "*vision|dovi|dv)" + WordAfter, Options);
        private static readonly Regex TitleHdr10PlusRegex = new(WordBefore + @"hdr10(?:\+|plus" + WordAfter + ")", Options);
        private static readonly Regex TitleHdr10Regex = new(WordBefore + "hdr10" + WordAfter, Options);
        private static readonly Regex TitleHlgRegex = new(WordBefore + "hlg" + WordAfter, Options);
        private static readonly Regex TitleHdrRegex = new(WordBefore + "hdr" + WordAfter, Options);
        private static readonly Regex TitleSdrRegex = new(WordBefore + "sdr" + WordAfter, Options);

        /// <summary>
        /// VideoRangeType first; only a missing or unknown type falls back to word-bounded
        /// hints in the display title and the type text, so "DVD" or "Advanced" never reads as Dolby Vision,
        /// then to Jellyfin's coarse VideoRange (HDR/SDR).
        /// </summary>
        internal static RangeFacts DetectRangeFacts(TagMediaStream video)
        {
            var type = (video.VideoRangeType ?? string.Empty).ToLowerInvariant();
            if (RangeTypes.TryGetValue(type, out var known)) return known;
            // An unrecognised type string still counts as a hint, after the title.
            var title = JsText.ToLower((video.DisplayTitle ?? string.Empty) + " " + type);
            // Jellyfin's DOVIInvalid says the Dolby Vision metadata is unusable: a DV word in the title cannot claim it.
            // A title naming a base layer too ("Dolby Vision HDR10") keeps it, as the structured DOVIWith… types do.
            if (type != "doviinvalid" && TitleDolbyVisionRegex.IsMatch(title))
                return new("Dolby Vision", TitleHdr10PlusRegex.IsMatch(title) ? "HDR10+" : TitleHdr10Regex.IsMatch(title) ? "HDR10" : TitleHlgRegex.IsMatch(title) ? "HLG" : TitleSdrRegex.IsMatch(title) ? "SDR" : null, false);
            if (TitleHdr10PlusRegex.IsMatch(title)) return new("HDR10+", null, false);
            if (TitleHdr10Regex.IsMatch(title)) return new("HDR10", null, false);
            if (TitleHlgRegex.IsMatch(title)) return new("HLG", null, false);
            if (TitleHdrRegex.IsMatch(title)) return new("HDR", null, false);
            // Jellyfin's coarse VideoRange still says HDR or SDR when the type is unknown.
            var coarse = (video.VideoRange ?? string.Empty).ToLowerInvariant();
            if (coarse == "hdr") return new("HDR", null, false);
            return new(null, null, TitleSdrRegex.IsMatch(title) || coarse == "sdr");
        }

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
            new(Versions, Array.Empty<string>(), 11),
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
            var all = (streams ?? Array.Empty<TagMediaStream>()).ToList();
            // Versions with an ordinary audio track list no commentary or audio-description facts.
            var ordinary = all.Where(s => s?.Type == "Audio" && !Helpers.TrackRoles.IsSecondaryAudio(s.Title, s.DisplayTitle)).Select(s => s.SourceId).ToHashSet();
            foreach (var stream in all)
            {
                if (stream == null) continue;
                if (stream.Type == "Audio" && ordinary.Contains(stream.SourceId) && Helpers.TrackRoles.IsSecondaryAudio(stream.Title, stream.DisplayTitle)) continue;
                if (stream.Type == "Video")
                {
                    var codec = DetectCodec(stream);
                    if (codec != null) values.Add(new(VideoCodec, codec, SourceId: stream.SourceId));
                    // Unknown stays unknown: only a known SDR stream is SDR; a Dolby Vision
                    // stream also lists the base layer other displays fall back to.
                    var range = DetectRangeFacts(stream);
                    if (range.Range != null) values.Add(new(DynamicRange, range.Range, SourceId: stream.SourceId));
                    if (range.Base != null) values.Add(new(DynamicRange, range.Base, SourceId: stream.SourceId));
                    else if (range.Range == null && range.Sdr) values.Add(new(DynamicRange, "SDR", SourceId: stream.SourceId));
                }
                else if (stream.Type == "Audio")
                {
                    var label = TrackAudioLabel(stream, legacyAudio);
                    if (label != null) values.Add(new(AudioInfo, label, stream.Language, stream.SourceId));
                }
            }
            return values.Distinct().ToList();
        }

        /// <summary>Use one merged version throughout detection and display modes. Native uses the first version.</summary>
        internal static TagStreamData? SelectSource(TagStreamData? data, string? sourceId = null)
        {
            if (data?.Streams == null) return data;
            // The requested version, else the first one Jellyfin lists that has stream facts (an unprobed
            // version describes nothing), else the first listed. Facts never mix versions.
            bool Probed(string? id) => id != null && data.Streams.Any(s => s?.SourceId == id && s.Type is "Video" or "Audio");
            var id = !string.IsNullOrEmpty(sourceId) && data.Streams.Any(s => s?.SourceId == sourceId)
                ? sourceId : data.Sources?.FirstOrDefault(s => Probed(s?.Id))?.Id ?? data.Sources?.FirstOrDefault(s => !string.IsNullOrEmpty(s?.Id))?.Id
                    ?? data.Streams.FirstOrDefault(s => !string.IsNullOrEmpty(s?.SourceId))?.SourceId;
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
                if (source.Is3D == true || (path.Contains("3d", StringComparison.Ordinal) && ContainsAny(path, "hsbs", "fsbs", "htab", "ftab", "mvc"))) break;
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
            var versions = VersionCount(data);
            data = SelectSource(data);
            var version = data?.Sources?.FirstOrDefault(s => !string.IsNullOrEmpty(s?.Id));
            if (version != null) { releaseSource = version.Source; edition = version.Edition; }
            var qualities = new List<string>(6);
            if (data?.Streams is null)
            {
                AddNamingTags(qualities, releaseSource, edition);
                if (versions > 1) Add(qualities, Versions + ":" + versions.ToString(System.Globalization.CultureInfo.InvariantCulture));
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
                // Every account gets the current video detection; version 0 keeps only its audio vocabulary.
                var resolution = DetectResolution(primaryVideo);
                if (resolution is not null) Add(qualities, resolution);

                var codec = DetectCodec(primaryVideo);
                if (codec is not null) Add(qualities, codec);

                var hdr = DetectRangeFacts(primaryVideo).Range;
                if (hdr is not null) Add(qualities, hdr);
            }

            if (includeAudio && !legacyAudio)
            {
                // One track supplies codec and channels together.
                var audio = BestAudioLabel(audioStreams, legacyAudio: false);
                if (audio is not null) Add(qualities, audio);
            }
            else if (includeAudio)
            {
                // The earlier vocabulary keeps its words, but its codec and channels must come from one real track.
                var (audio, channels) = TruthfulLegacyAudio(DetectAudioCodec(audioStreams, legacyAudio), DetectChannels(audioStreams), audioStreams);
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
                    // Jellyfin's own 3D format first, else 3D release words in the file name as whole words, outside a
                    // closing release group ("3Days.To.Kill.2014.1080p.H264-MVC" is no 3D).
                    var path = JsText.ToLower(MediaNamingTags.WithoutReleaseGroup(source.Path) ?? string.Empty);
                    if (source.Is3D == true || (ContainsWord(path, "3d") && new[] { "hsbs", "fsbs", "htab", "ftab", "mvc" }.Any(word => ContainsWord(path, word))))
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
            if (versions > 1) Add(qualities, Versions + ":" + versions.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return qualities;
        }

        /// <summary>
        /// How many versions an item has: its listed sources with an id, else the distinct source ids of
        /// its streams (versionCount in qualitytags.js). Series and seasons drop the fact: it would
        /// describe their representative episode.
        /// </summary>
        internal static int VersionCount(TagStreamData? data)
        {
            var listed = data?.Sources?.Where(s => !string.IsNullOrEmpty(s?.Id)).Select(s => s!.Id).Distinct(StringComparer.Ordinal).Count() ?? 0;
            return listed > 0 ? listed : data?.Streams?.Where(s => !string.IsNullOrEmpty(s?.SourceId)).Select(s => s!.SourceId).Distinct(StringComparer.Ordinal).Count() ?? 0;
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
            return BestAudioLabel(streams, legacyAudio);
        }

        /// <summary>One track's own sound label: its codec with its own channels, or a bare surround layout, bed only (version 0: 7.1/5.1 buckets).</summary>
        private static string? TrackAudioLabel(TagMediaStream stream, bool legacyAudio)
        {
            var track = new List<TagMediaStream>(1) { stream };
            var (codec, channels) = legacyAudio ? TruthfulLegacyAudio(DetectAudioCodec(track, true), DetectChannels(track), track) : (DetectAudioCodec(track), TrackChannels(stream));
            var bed = channels is { Length: > 3 } ? channels[..3] : channels;
            return codec == null ? (bed is "7.1" or "5.1" || (!legacyAudio && bed == "6.1") ? bed : null)
                : channels != null && !codec.Contains(channels, StringComparison.Ordinal) ? codec + " " + channels : codec;
        }

        // ffmpeg channel layout names; the "(side)"/"(back)"/"(wide)" variants share their layout.
        private static readonly Dictionary<string, string> NamedLayouts = new(StringComparer.Ordinal)
        {
            ["mono"] = "1.0", ["stereo"] = "2.0", ["quad"] = "4.0", ["hexagonal"] = "6.0", ["octagonal"] = "8.0",
        };

        // A bare count only says the usual layout for counts with one (Jellyfin's own convention).
        private static readonly Dictionary<int, string> CountLayouts = new() { [1] = "1.0", [2] = "2.0", [6] = "5.1", [7] = "6.1", [8] = "7.1" };

        private static readonly Regex NumericLayoutRegex = new(@"^([0-9])\.([0-9])(?:\.([0-9]))?\z", Options);
        private static readonly Regex TitleLayoutRegex = new(@"(?:^|[^a-z0-9_])([1-7])[. ]([01])(?:\.([246]))?(?![a-z0-9_])", Options);
        private static readonly Regex TitleStereoRegex = new(@"(?:^|[^a-z0-9_])stereo(?![a-z0-9_])", Options);
        private static readonly Regex TitleMonoRegex = new(@"(?:^|[^a-z0-9_])mono(?![a-z0-9_])", Options);

        /// <summary>
        /// One track's actual channel layout (trackChannels in qualitytags.js): its ChannelLayout, then a
        /// layout named in its title, then the usual layout for its count. Height channels stay ("5.1.2"). Unknown stays unknown.
        /// </summary>
        internal static string? TrackChannels(TagMediaStream stream)
        {
            var layout = JsText.ToLower(stream.ChannelLayout ?? string.Empty);
            var paren = layout.IndexOf('(', StringComparison.Ordinal);
            if (paren >= 0 && layout.EndsWith(')')) layout = layout[..paren];
            layout = JsText.Trim(layout);
            // Jellyfin's layout field, like a title, only counts when it agrees with the track's channel count.
            if (NamedLayouts.TryGetValue(layout, out var named) && AgreesWithCount(named, stream.Channels)) return named;
            var numeric = NumericLayoutRegex.Match(layout);
            if (numeric.Success && AgreesWithCount(Layout(numeric), stream.Channels)) return Layout(numeric);
            // A title layout only counts when the track's own channel count is unknown or agrees with it (its bed,
            // or bed plus heights), so a stereo encode titled "5.1" stays 2.0 (trackChannels in qualitytags.js).
            var title = JsText.ToLower(stream.DisplayTitle ?? string.Empty);
            var inTitle = TitleLayoutRegex.Match(title);
            var fromTitle = inTitle.Success ? Layout(inTitle) : TitleStereoRegex.IsMatch(title) ? "2.0" : TitleMonoRegex.IsMatch(title) ? "1.0" : null;
            if (fromTitle != null && AgreesWithCount(fromTitle, stream.Channels)) return fromTitle;
            return stream.Channels is { } count && CountLayouts.TryGetValue(count, out var usual) ? usual : null;
        }

        private static bool AgreesWithCount(string layout, int? channels)
        {
            if (channels is not > 0) return true;
            var parts = layout.Split('.');
            var bed = (parts[0][0] - '0') + (parts[1][0] - '0');
            var height = parts.Length > 2 ? parts[2][0] - '0' : 0;
            return bed == channels || bed + height == channels;
        }

        private static string Layout(Match match) => string.Join('.', match.Groups.Values.Skip(1).Where(g => g.Success).Select(g => g.Value));

        /// <summary>Rank every eligible track by codec tier then channels; the first track wins a tie (bestAudioLabel in qualitytags.js).</summary>
        private static string? BestAudioLabel(List<TagMediaStream> streams, bool legacyAudio)
        {
            string? best = null;
            foreach (var stream in streams)
            {
                var label = (legacyAudio ? LegacyAggregationAudio : AggregationAudio).GetValue(stream, item => new AudioLabel(TrackAudioLabel(item, legacyAudio))).Value;
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
                VideoCodec => CodecOrder, Source => SourceQualityOrder, _ => AudioOrder,
            };
            var index = Array.IndexOf(order, NormalizeLabel(label));
            // More channels win ties, heights too ("7.1.4" beats "7.1"; distinctRank in qualitytags.js).
            var layout = TrailingLayoutRegex.Match(label);
            var channels = layout.Success ? layout.Groups.Values.Skip(1).Where(g => g.Success).Sum(g => g.Value[0] - '0') : 0;
            if (category != AudioInfo) return (index < 0 ? 999 : index) * 100;
            // Lossy tracks rank by channels before codec; lossless and object tiers by codec first.
            if (index >= LossyAudioFrom) return LossyAudioFrom * 100 + (99 - Math.Min(channels, 99)) * 10 + (index - LossyAudioFrom);
            return (index < 0 ? 99900 : index * 100) + 99 - Math.Min(channels, 99);
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
            // Commentary and audio description never stand for the soundtrack while an ordinary track exists.
            if (audioStreams.Exists(s => !Helpers.TrackRoles.IsSecondaryAudio(s.Title, s.DisplayTitle)))
                audioStreams = audioStreams.FindAll(s => !Helpers.TrackRoles.IsSecondaryAudio(s.Title, s.DisplayTitle));
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
                    // A release group closing the file name ("…H264-IMAX") is a name, not an IMAX claim.
                    yield return MediaNamingTags.WithoutReleaseGroup(source?.Path);
                    yield return source?.Name;
                }
            }

            // Only video tracks speak for the picture: an audio track titled "Commentary about IMAX cameras" is not IMAX.
            foreach (var stream in streams)
            {
                if (stream?.Type == "Video") yield return stream?.DisplayTitle;
            }
        }

        /// <summary>The resolution bucket; a known interlaced 1080, 576 or 480 frame is 1080i, 576i or 480i, never claimed progressive.</summary>
        internal static string? DetectResolution(TagMediaStream video)
        {
            var bucket = DetectResolutionBucket(video);
            return bucket is "1080p" or "576p" or "480p" && video.IsInterlaced == true ? bucket[..^1] + "i" : bucket;
        }

        private static string? DetectResolutionBucket(TagMediaStream video)
        {
            var displayTitle = JsText.AsciiLower(video.DisplayTitle);
            var height = video.Height ?? 0;
            var width = video.Width ?? 0;
            var match = ResolutionRegex.Match(displayTitle);
            var found = match.Success ? match.Groups[1].Value : null;
            // Known dimensions decide; a title hint only names an unknown size.
            if (found is not null && height <= 0 && width <= 0)
            {
                return found switch
                {
                    "8k" or "4320p" => "8K",
                    "4k" or "2160p" => "4K",
                    "1440p" => "1440p",
                    "1080p" => "1080p",
                    "1080i" => "1080i",
                    "720p" => "720p",
                    "576p" => "576p",
                    "576i" => "576i",
                    "480p" => "480p",
                    "480i" => "480i",
                    _ => "LOW-RES", // 360p, 404p, 384p, 520p
                };
            }

            // A portrait frame (a phone video, 1080x1920) is measured by its short and long sides, so it is 1080p, not 4K.
            if (height > width && width > 0) (height, width) = (width, height);
            // Width covers cropped scope encodes (1920x800 is 1080p, a cropped DVD 720x304 is 480p).
            // 1440p needs a 1440-class height: a 2560-wide frame is usually ultrawide 1080p (2560x1080).
            // An 8K-class height needs a matching width: a 4:3 4096x3072 frame is 4K-class.
            if ((height >= 3000 && (width >= 5000 || width <= 0)) || width >= 7000) return "8K";
            // A 4K-class height needs a matching width: 2560x1600 (16:10) is a 1440p-class frame.
            if ((height >= 1550 && (width >= 2700 || width <= 0)) || width >= 3500) return "4K";
            if (height >= 1250) return "1440p";
            if (height >= 1000 || width >= 1800) return "1080p";
            if (height >= 700 || width >= 1200) return "720p";
            if (height >= 528) return "576p";
            if (height >= 400 || width >= 640) return "480p";
            return height > 0 ? "LOW-RES" : null;
        }

        /// <summary>The coarse VideoRange worth storing: HDR or SDR, only when the VideoRangeType is unknown, missing or invalid Dolby Vision.</summary>
        internal static string? CoarseRange(string? rangeType, string? range)
            => (string.IsNullOrEmpty(rangeType) || string.Equals(rangeType, "Unknown", StringComparison.OrdinalIgnoreCase) || string.Equals(rangeType, "DOVIInvalid", StringComparison.OrdinalIgnoreCase))
                && range is "HDR" or "SDR" ? range : null;

        private static readonly Regex DivxTagRegex = new("divx|dx50|div[3-6]", Options);

        private static bool ContainsWord(string text, string word)
        {
            for (var at = text.IndexOf(word, StringComparison.Ordinal); at >= 0; at = text.IndexOf(word, at + 1, StringComparison.Ordinal))
            {
                var end = at + word.Length;
                if ((at == 0 || !char.IsAsciiLetterOrDigit(text[at - 1])) && (end == text.Length || !char.IsAsciiLetterOrDigit(text[end]))) return true;
            }
            return false;
        }

        private static readonly Regex CodecSpellingRegex = new(@"(?<![a-z0-9])(h)[. ](26[456])(?![0-9])|(?<![a-z0-9])(vc|mpeg|vp)[-. ]([1-9])(?![a-z0-9])", Options);

        /// <summary>A lowercased title with "h.264"/"vc-1"/"mpeg-2" spellings joined (codecTitle in qualitytags.js).</summary>
        private static string CodecTitle(string? title) =>
            CodecSpellingRegex.Replace(JsText.ToLower(title ?? string.Empty), m => m.Groups[1].Success ? m.Groups[1].Value + m.Groups[2].Value : m.Groups[3].Value + m.Groups[4].Value);

        private static string? DetectCodec(TagMediaStream video)
        {
            var needles = CurrentCodecNeedles;
            var codec = JsText.ToLower(video.Codec ?? string.Empty);
            var codecTag = JsText.ToLower(video.CodecTag ?? string.Empty);
            foreach (var (needle, label) in needles)
            {
                if (codec.Contains(needle, StringComparison.Ordinal)) return label;
                // CodecTag is consulted for AVC, and for the MPEG-4 Part 2 encoders Jellyfin reports as
                // "mpeg4" (XviD; DivX as DIVX/DX50/DIV3-6), right after the codec's own check.
                if (needle == "avc" && codecTag.Contains("avc", StringComparison.Ordinal)) return label;
                if (needle == "xvid" && codecTag.Contains("xvid", StringComparison.Ordinal)) return label;
                if (needle == "divx" && DivxTagRegex.IsMatch(codecTag)) return label;
            }

            // A title only names a codec as a whole word ("NAV1GATOR" is no AV1), written with or without
            // its dot or hyphen ("H.264", "VC-1", "MPEG-2").
            var displayTitle = CodecTitle(video.DisplayTitle);
            foreach (var (needle, label) in needles)
            {
                if (ContainsWord(displayTitle, needle)) return label;
            }

            return null;
        }

        // Reference: Radarr/Sonarr audio custom formats, TRaSH-Guides Audio Formats:
        // https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/#audio-formats
        // Adapted to stream fields and existing chips: Atmos families (and E-AC-3 JOC) → ATMOS, DTS-ES → DTS;
        // a bare DTS-HD claims neither MA nor HRA; FLAC and (L)PCM have their own chips; AAC/Opus/MP3
        // keep channel-only fallback.
        // Same precedence as qualitytags.js.
        private static readonly (Regex Pattern, string Label)[] AudioAliases =
        {
            (new(@"(?:^|[^a-z0-9_])(?:atmos|ddpa|joc)(?![a-z_])", Options), "ATMOS"),
            (new(@"(?:^|[^a-z0-9_])true[ .-]?hd(?![a-z_])", Options), "TRUEHD"),
            (new(@"(?:^|[^a-z0-9_])dts[-_.: ]?x7?(?![a-z_])(?![-_. ]?26[456])", Options), "DTS-X"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:hra?|hi|high[ -]?resolution)(?![a-z_])", Options), "DTS-HD HRA"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:ma|xll|master[ -]?audio)(?![a-z_])", Options), "DTS-HD MA"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?hd(?![a-z_])", Options), "DTS-HD"),
            (new(@"(?:^|[^a-z0-9_])dts[-_. ]?es(?![a-z_])", Options), "DTS"),
            (new(@"(?:^|[^a-z0-9_])(?:dts|dca)(?![a-z_])", Options), "DTS"),
            (new(@"(?:^|[^a-z0-9_])(?:ddp(?:lus)?|dd\+|e[-_. ]?ac-?3|dolby" + JsSpace + @"*digital(?:" + JsSpace + @"*plus|" + JsSpace + @"*\+))(?![a-z_])", Options), "Dolby Digital+"),
            (new(@"(?:^|[^a-z0-9_])(?:dd(?!" + JsSpace + @"*\+)|dolby" + JsSpace + @"*digital(?!" + JsSpace + @"*(?:plus|\+)))(?![a-z_])|(?:^|[^a-z0-9_-])ac-?3(?![a-z_])", Options), "Dolby Digital"),
            (new(@"(?:^|[^a-z0-9_])flac(?![a-z_])", Options), "FLAC"),
            (new(@"(?:^|[^a-z0-9_])l?pcm(?![a-z])", Options), "PCM"),
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
                if (title == null) continue;
                // A DTS-HD profile the stream reports (MA or HRA) outranks a title's other DTS claim; DTS:X still refines it.
                var profile = AudioCodecFromText(stream.Codec + " " + stream.Profile);
                var refined = profile != null && Array.IndexOf(DtsProfiles, profile) >= 0 && Array.IndexOf(DtsTitles, title) >= 0
                    ? profile
                    : AudioCodecFromText(stream.DisplayTitle + " " + stream.Codec + " " + stream.Profile) ?? title;
                // The title refined by the same track's codec and profile, else the title alone, if the codec can carry it.
                foreach (var candidate in new[] { refined, title })
                {
                    var label = AtmosCarrier(candidate, stream);
                    if (CarrierAllows(label, stream.Codec)) return label;
                }
            }
            foreach (var stream in streams)
            {
                foreach (var candidate in new[] { AudioCodecFromText(stream.Codec + " " + stream.Profile), AudioCodecFromText(stream.Codec) })
                {
                    if (candidate == null) continue;
                    var label = AtmosCarrier(candidate, stream);
                    if (CarrierAllows(label, stream.Codec)) return label;
                }
            }
            return null;
        }

        private static readonly string[] DtsProfiles = { "DTS-HD MA", "DTS-HD HRA" };
        private static readonly string[] DtsTitles = { "DTS", "DTS-HD", "DTS-HD MA", "DTS-HD HRA" };

        // What each known stream codec can be (CARRIERS in qualitytags.js): a title may refine its carrier but never
        // contradict it. An unknown codec lets the title decide.
        private static readonly (Regex Codec, string[] Labels)[] Carriers =
        {
            (new("^(?:e-?ac-?3|ddp)", Options), new[] { "Dolby Digital+", "DD+ ATMOS" }),
            (new("^ac-?3$", Options), new[] { "Dolby Digital" }),
            (new("^(?:truehd|mlp)", Options), new[] { "TRUEHD", "TRUEHD ATMOS" }),
            (new("^(?:dts|dca)", Options), new[] { "DTS", "DTS-HD", "DTS-HD MA", "DTS-HD HRA", "DTS-X" }),
            (new("^flac", Options), new[] { "FLAC" }),
            (new("^pcm", Options), new[] { "PCM" }),
            (new("^(?:aac|opus|mp[23]|vorbis|alac|wmav)", Options), Array.Empty<string>()),
        };

        private static bool CarrierAllows(string label, string? codec)
        {
            var value = JsText.ToLower(codec ?? string.Empty);
            foreach (var (pattern, labels) in Carriers) if (pattern.IsMatch(value)) return Array.IndexOf(labels, label) >= 0;
            return true;
        }

        private static readonly Regex TrueHdCodecRegex = new("^(?:truehd|mlp)", Options);
        private static readonly Regex EAc3CodecRegex = new("^(?:e-?ac-?3|ddp)", Options);
        private static readonly Regex TrueHdCarrierRegex = new(@"(?:^|[^a-z0-9_])(?:true[ .-]?hd|mlp)(?![a-z_])", Options);
        private static readonly Regex DolbyDigitalPlusCarrierRegex = new(@"(?:^|[^a-z0-9_])(?:e[-_. ]?ac-?3|ddp(?:a|lus)?|dd\+|dolby" + JsSpace + @"*digital" + JsSpace + @"*(?:plus|\+))(?![a-z_])", Options);

        /// <summary>Atmos with the carrier that holds it (TRaSH's TrueHD Atmos and DD+ Atmos), else plain ATMOS (atmosCarrier in qualitytags.js).</summary>
        private static string AtmosCarrier(string label, TagMediaStream stream)
        {
            if (label != "ATMOS") return label;
            // The stream codec names the carrier first: a TrueHD title cannot hide an E-AC-3 JOC track's Atmos.
            var codec = JsText.ToLower(stream.Codec ?? string.Empty);
            if (TrueHdCodecRegex.IsMatch(codec)) return "TRUEHD ATMOS";
            if (EAc3CodecRegex.IsMatch(codec)) return "DD+ ATMOS";
            var text = JsText.ToLower(string.Join(' ', new[] { stream.Codec, stream.Profile, stream.DisplayTitle }.Where(s => !string.IsNullOrEmpty(s))));
            if (TrueHdCarrierRegex.IsMatch(text)) return "TRUEHD ATMOS";
            return DolbyDigitalPlusCarrierRegex.IsMatch(text) ? "DD+ ATMOS" : label;
        }

        private static readonly Regex LegacyDtsXRegex = new(@"(?:^|[^a-z0-9_])dts[-_.: ]?x(?![a-z0-9_])", Options);

        // Which current per-track labels each earlier-vocabulary codec may stand for (it may name less, never more).
        private static readonly Dictionary<string, string[]> LegacyStandsFor = new(StringComparer.Ordinal)
        {
            ["ATMOS"] = new[] { "TRUEHD ATMOS", "DD+ ATMOS", "ATMOS" },
            ["TRUEHD"] = new[] { "TRUEHD", "TRUEHD ATMOS" },
            ["DTS-X"] = new[] { "DTS-X" },
            ["DTS"] = new[] { "DTS", "DTS-HD", "DTS-HD MA", "DTS-HD HRA", "DTS-X" },
            ["Dolby Digital+"] = new[] { "Dolby Digital+", "DD+ ATMOS" },
        };

        // The earlier-vocabulary name of a current per-track codec; Dolby Digital, PCM and FLAC had none.
        private static readonly Dictionary<string, string> LegacyName = new(StringComparer.Ordinal)
        {
            ["TRUEHD ATMOS"] = "ATMOS", ["DD+ ATMOS"] = "ATMOS", ["ATMOS"] = "ATMOS", ["DTS-X"] = "DTS-X", ["TRUEHD"] = "TRUEHD",
            ["DTS-HD MA"] = "DTS", ["DTS-HD HRA"] = "DTS", ["DTS-HD"] = "DTS", ["DTS"] = "DTS", ["Dolby Digital+"] = "Dolby Digital+",
        };

        private static readonly string[] LegacyBuckets = { "2.0", "5.1", "7.1" };

        private static string? LegacyBucket(string? layout)
        {
            var total = (layout ?? string.Empty).Split('.').Sum(part => int.TryParse(part, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : 0);
            return total >= 8 ? "7.1" : total >= 6 ? "5.1" : total >= 2 ? "2.0" : null;
        }

        /// <summary>
        /// Version-0 sound (truthfulLegacyAudio in qualitytags.js): keep its codec and channel bucket when one eligible track holds
        /// both (the codec naming that track's carrier or less, the track having at least those channels); otherwise describe the
        /// best single track in the same vocabulary.
        /// </summary>
        private static (string? Codec, string? Channels) TruthfulLegacyAudio(string? codec, string? channels, List<TagMediaStream> streams)
        {
            var tracks = streams.Select(stream => (Label: DetectCurrentAudioCodec(new List<TagMediaStream>(1) { stream }), Bucket: LegacyBucket(TrackChannels(stream)), Stream: stream)).ToList();
            bool Holds((string? Label, string? Bucket, TagMediaStream Stream) track)
                => (codec == null || (LegacyStandsFor.TryGetValue(codec, out var labels) && track.Label != null && Array.IndexOf(labels, track.Label) >= 0))
                    && (channels == null || Array.IndexOf(LegacyBuckets, track.Bucket) >= Array.IndexOf(LegacyBuckets, channels));
            if (tracks.Any(Holds)) return (codec, channels);
            (string Text, (string? Label, string? Bucket, TagMediaStream Stream) Track)? best = null;
            foreach (var track in tracks)
            {
                var label = TrackAudioLabel(track.Stream, legacyAudio: false);
                if (label != null && (best == null || AggregationRank(label, AudioInfo) < AggregationRank(best.Value.Text, AudioInfo))) best = (label, track);
            }

            if (best == null) return (null, null);
            return (best.Value.Track.Label != null && LegacyName.TryGetValue(best.Value.Track.Label, out var name) ? name : null, best.Value.Track.Bucket);
        }

        private static string? DetectAudioCodec(List<TagMediaStream> audioStreams, bool legacyAudio = false)
        {
            if (!legacyAudio) return DetectCurrentAudioCodec(audioStreams);
            // Priority 1: the first stream whose display title names a codec its stream codec can carry (the earlier
            // vocabulary keeps its labels, never an impossible carrier).
            foreach (var stream in audioStreams)
            {
                var title = JsText.AsciiLower(stream.DisplayTitle);
                var titled = title.Contains("atmos", StringComparison.Ordinal) ? "ATMOS"
                    : title.Contains("truehd", StringComparison.Ordinal) ? "TRUEHD"
                    : title.Contains("dts-x", StringComparison.Ordinal) ? "DTS-X"
                    : DtsRegex.IsMatch(title) ? "DTS"
                    : DolbyDigitalPlusRegex.IsMatch(title) ? "Dolby Digital+" : null;
                if (titled != null && (CarrierAllows(titled == "ATMOS" ? "DD+ ATMOS" : titled, stream.Codec) || (titled == "ATMOS" && CarrierAllows("TRUEHD ATMOS", stream.Codec)))) return titled;
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
                    // DTS:X by name only: XLL (the DTS-HD MA lossless extension) is not object audio.
                    return LegacyDtsXRegex.IsMatch(codec + " " + profile) ? "DTS-X" : "DTS";
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
                // A layout the track's reported channel count cannot hold is ignored (getChannelTag in qualitytags.js).
                if (channels > 0 && channels < tagRank switch { 3 => 8, 2 => 6, 1 => 2, _ => 0 }) tagRank = 0;
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
