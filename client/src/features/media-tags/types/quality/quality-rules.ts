// What an item's streams, versions and series facts say about its quality. No browser state: every setting and
// language rule arrives through QualityHost. Mirrors QualityTagRules on the server.
import { finite, isRecord, memberRecord, memberText, members, own, record, records, text, type JsonRecord } from '../../pipeline/dto';
import { AUDIO_BASES, CATEGORIES, CATEGORY_BY_KEY, EDITION_PREFIX, TAG_TO_CATEGORY, aspectRatios, audioOrder, resolutionOrder, sourceOrder } from './quality-data';
import type { MediaLanguage } from '../language/media-language';

export interface QualityHost {
    /** The personal value of a setting, else the administrator's PascalCase value. */
    setting(key: string): unknown;
    preferredAudioLanguage(): string | null;
    /** Whether audio keeps its version-0 presentation. */
    legacyAudio(): boolean;
    language(): Pick<MediaLanguage, 'isSecondaryAudio' | 'matchesLanguage'> | undefined;
}
interface VideoRangeFacts { range: string | null; base: string | null; sdr: boolean }
export type DistinctQuality = { Category: string; Label: string; Language?: unknown };

/** Raw streams or sources, null members in place; `memberRecord` is the detector's failure boundary on them. */
type Listed = readonly (JsonRecord | null)[];

function listed(value: unknown): Listed | null {
    return value ? members(value).map(member => (member === null || member === undefined ? null : record(member))) : null;
}

export function createQualityRules(host: QualityHost) {
    /**
     * Narrows the audio streams to the preferred language when one is set.
     * Tiers: streams matching language and region (when the preference has
     * one), then streams matching the language, then — when the title has
     * no audio in that language at all — every stream, exactly as before.
     * @param audioStreams - Audio streams in file order.
     * @param preferred - From host.preferredAudioLanguage().
     * */
    function selectAudioStreamsForLanguage(audioStreams: JsonRecord[], preferred: string | null): JsonRecord[] {
        // Commentary and audio description never stand for the soundtrack while an ordinary track exists.
        const secondary = host.language()?.isSecondaryAudio;
        if (typeof secondary === 'function' && audioStreams.some((s) => !secondary(s))) audioStreams = audioStreams.filter((s) => !secondary(s));
        const match = host.language()?.matchesLanguage;
        if (!preferred || !audioStreams.length || typeof match !== 'function') return audioStreams;
        const exact = audioStreams.filter((s) => match(s.Language, preferred, { requireRegion: true }));
        if (exact.length) return exact;
        const loose = audioStreams.filter((s) => match(s.Language, preferred));
        return loose.length ? loose : audioStreams;
    }

    /**
     * Normalizes dynamic quality labels to their base key for sorting and CSS color matching.
     * @param label - The quality label to normalize.
     * @returns The normalized base label.
     */
    function normalizeQualityLabel(label: string): string {
        if (!label) return label;

        for (const base of AUDIO_BASES) {
            if (label === base || label.startsWith(`${base} `)) {
                return base;
            }
        }

        return label;
    }

    // Which current per-track labels each earlier-vocabulary codec may stand for (it may name less, never more).
    const LEGACY_STANDS_FOR: Readonly<Record<string, readonly string[]>> = {
        'ATMOS': ['TRUEHD ATMOS', 'DD+ ATMOS', 'ATMOS'],
        'TRUEHD': ['TRUEHD', 'TRUEHD ATMOS'],
        'DTS-X': ['DTS-X'],
        'DTS': ['DTS', 'DTS-HD', 'DTS-HD MA', 'DTS-HD HRA', 'DTS-X'],
        'Dolby Digital+': ['Dolby Digital+', 'DD+ ATMOS'],
    };
    const LEGACY_BUCKETS = ['2.0', '5.1', '7.1'];
    // The earlier-vocabulary name of a current per-track codec; Dolby Digital, PCM and FLAC had none.
    const LEGACY_NAME: Readonly<Record<string, string>> = { 'TRUEHD ATMOS': 'ATMOS', 'DD+ ATMOS': 'ATMOS', 'ATMOS': 'ATMOS', 'DTS-X': 'DTS-X', 'TRUEHD': 'TRUEHD',
        'DTS-HD MA': 'DTS', 'DTS-HD HRA': 'DTS', 'DTS-HD': 'DTS', 'DTS': 'DTS', 'Dolby Digital+': 'Dolby Digital+' };

    /** @param layout A track layout such as "5.1.2". @returns Its earlier channel bucket. */
    function legacyBucket(layout: string | null | undefined): string | null {
        const total = String(layout || '').split('.').reduce((sum, part) => sum + (Number(part) || 0), 0);
        return total >= 8 ? '7.1' : total >= 6 ? '5.1' : total >= 2 ? '2.0' : null;
    }

    /**
     * Version-0 sound (QualityTagRules.TruthfulLegacyAudio): keep its codec and channel bucket when one eligible track
     * holds both (the codec naming that track's carrier or less, the track having at least those channels); otherwise
     * describe the best single track in the same vocabulary, so a TrueHD 2.0 track beside an AAC 7.1 never reads TRUEHD 7.1.
     * @param codec Earlier-vocabulary codec.
     * @param channels Earlier channel bucket.
     * @param streams Eligible audio tracks.
     * */
    function truthfulLegacyAudio(codec: string | null, channels: string | null, streams: JsonRecord[]): { codec: string | null; channels: string | null } {
        const tracks = streams.map(stream => ({ label: detectCurrentAudioCodec([stream]), bucket: legacyBucket(trackChannels(stream)), stream }));
        const holds = (track: typeof tracks[number]) => (codec === null || (track.label !== null && (own(LEGACY_STANDS_FOR, codec) || []).includes(track.label)))
            && (channels === null || LEGACY_BUCKETS.indexOf(track.bucket ?? '') >= LEGACY_BUCKETS.indexOf(channels));
        if (tracks.some(holds)) return { codec, channels };
        let best: { text: string; track: typeof tracks[number] } | null = null;
        for (const track of tracks) {
            const label = trackAudioLabel(track.stream);
            if (label && (best === null || distinctRank(label, 'audio') < distinctRank(best.text, 'audio'))) best = { text: label, track };
        }
        if (!best) return { codec: null, channels: null };
        return { codec: best.track.label === null ? null : own(LEGACY_NAME, best.track.label) ?? null, channels: best.track.bucket };
    }

    /**
     * Finds the richest channel layout available across audio streams.
     * @param audioStreams - Audio streams from item metadata.
     * @returns A channel tag such as "7.1", "5.1", or "2.0".
     */
    function getChannelTag(audioStreams: JsonRecord[]): string | null {
        if (audioStreams.length === 0) return null;

        const rank = (tag: string) => (tag === '7.1' ? 3 : tag === '5.1' ? 2 : 1);
        let maxChannels = 0;
        let detectedLayoutTag: string | null = null;

        for (const stream of audioStreams) {
            const channels = finite(stream.Channels) ?? 0;
            if (channels > maxChannels) {
                maxChannels = channels;
            }

            const layoutSignals = `${String(stream.ChannelLayout || '')} ${String(stream.DisplayTitle || '')}`.toLowerCase();
            let tag: string | null = null;
            if (/\b7[. ]?1\b/.test(layoutSignals)) {
                tag = '7.1';
            } else if (/\b5[. ]?1\b/.test(layoutSignals)) {
                tag = '5.1';
            } else if (/\bstereo\b|\b2[. ]?0\b/.test(layoutSignals)) {
                tag = '2.0';
            }

            // A layout the track's reported channel count cannot hold is ignored (a stereo track titled 7.1).
            const needs = tag === '7.1' ? 8 : tag === '5.1' ? 6 : 2;
            if (tag && channels > 0 && channels < needs) tag = null;

            if (tag && (!detectedLayoutTag || rank(tag) > rank(detectedLayoutTag))) {
                detectedLayoutTag = tag;
            }
        }

        if (detectedLayoutTag) {
            return detectedLayoutTag;
        }

        if (maxChannels >= 8) return '7.1';
        if (maxChannels >= 6) return '5.1';
        if (maxChannels >= 2) return '2.0';

        return null;
    }

    /**
     * How many versions an item has: its listed sources with an id, else the distinct source ids of
     * its streams (QualityTagRules.VersionCount).
     * */
    function versionCount(streams: Listed | null | undefined, sources: Listed | null | undefined): number {
        const listed = new Set((sources || []).map(s => s?.Id).filter(Boolean));
        return listed.size || new Set((streams || []).map(s => s?.SourceId).filter(Boolean)).size;
    }

    /** Technical labels from the representative item's runtime and first video stream. */
    function technicalLabels(ticks: unknown, video: JsonRecord | undefined): string[] {
        const labels: string[] = [];
        const minutes = Math.floor(Number(ticks) / 600000000);
        if (Number.isFinite(minutes) && minutes > 0) labels.push('runtime:' + (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`));
        if (!video) return labels;
        const parts = String(video.AspectRatio || '').trim().split(/[:/]/).map(Number);
        let ratio = parts.length === 1 ? parts[0] ?? 0 : parts.length === 2 ? (parts[0] ?? 0) / (parts[1] ?? 1) : 0;
        const width = finite(video.Width) ?? 0;
        const height = finite(video.Height) ?? 0;
        if (!Number.isFinite(ratio) || ratio <= 0) ratio = width > 0 && height > 0 ? width / height : 0;
        if (ratio >= .5 && ratio <= 4) {
            const snap = aspectRatios.filter(([value, tolerance]) => Math.abs(value - ratio) <= tolerance).sort((a, b) => Math.abs(a[0] - ratio) - Math.abs(b[0] - ratio))[0];
            labels.push('aspectRatio:' + (snap?.[2] || ratio.toFixed(2) + ':1'));
        }
        const real = Number(video.RealFrameRate);
        const rate = Number.isFinite(real) && real > 0 ? real : Number(video.AverageFrameRate);
        if (Number.isFinite(rate) && rate > 0 && rate <= 240) {
            const value = rate * (video.IsInterlaced === true ? 2 : 1);
            const snap = [24, 25, 30, 48, 50, 60, 100, 120, 144, 240].find(common => Math.abs(value - common) <= .15);
            labels.push('frameRate:' + (snap || Number(value.toFixed(2))) + (video.IsInterlaced === true ? 'i' : 'p'));
        }
        return labels;
    }

    // --- CORE LOGIC ---
    // Reference: Radarr/Sonarr audio custom formats, TRaSH-Guides Audio Formats:
    // https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/#audio-formats
    // Stream aliases use the established chip vocabulary: both Atmos families (and E-AC-3 JOC) →
    // ATMOS, DTS-ES → DTS; lossless FLAC and (L)PCM have their own chips; AAC/Opus/MP3 keep the
    // channel-only fallback. HRA and MA precede a bare DTS-HD, which claims neither (only an MA,
    // XLL or Master Audio word, in the title or the profile, says lossless); Plus/Atmos precede
    // plain DD. Boundaries reject suffixes.
    const AUDIO_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
        [/(?:^|[^a-z0-9_])(?:atmos|ddpa|joc)(?![a-z_])/, 'ATMOS'],
        [/(?:^|[^a-z0-9_])true[ .-]?hd(?![a-z_])/, 'TRUEHD'],
        [/(?:^|[^a-z0-9_])dts[-_.: ]?x7?(?![a-z_])(?![-_. ]?26[456])/, 'DTS-X'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:hra?|hi|high[ -]?resolution)(?![a-z_])/, 'DTS-HD HRA'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:ma|xll|master[ -]?audio)(?![a-z_])/, 'DTS-HD MA'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?hd(?![a-z_])/, 'DTS-HD'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?es(?![a-z_])/, 'DTS'],
        [/(?:^|[^a-z0-9_])(?:dts|dca)(?![a-z_])/, 'DTS'],
        [/(?:^|[^a-z0-9_])(?:ddp(?:lus)?|dd\+|e[-_. ]?ac-?3|dolby\s*digital(?:\s*plus|\s*\+))(?![a-z_])/, 'Dolby Digital+'],
        [/(?:^|[^a-z0-9_])(?:dd(?!\s*\+)|dolby\s*digital(?!\s*(?:plus|\+)))(?![a-z_])|(?:^|[^a-z0-9_-])ac-?3(?![a-z_])/, 'Dolby Digital'],
        [/(?:^|[^a-z0-9_])flac(?![a-z_])/, 'FLAC'],
        [/(?:^|[^a-z0-9_])l?pcm(?![a-z])/, 'PCM'],
    ];

    /**
     * Match the most specific stream alias before its carrier codec.
     * @param text Display title or technical metadata.
     * @returns Canonical sound chip identity, before channels.
     */
    function audioCodecFromText(source: unknown): string | null {
        const value = String(source || '').toLowerCase();
        return AUDIO_ALIASES.find(([pattern]) => pattern.test(value))?.[1] || null;
    }

    /**
     * Keep first-recognized-title priority, enriching its carrier from the same track's
     * profile; only use metadata-only tracks when no display title identifies a codec.
     * @param streams Eligible audio tracks.
     * @returns Current codec label; legacy detection remains independent.
     */
    function detectCurrentAudioCodec(streams: readonly JsonRecord[]): string | null {
        for (const stream of streams) {
            const title = audioCodecFromText(stream.DisplayTitle);
            if (!title) continue;
            // A DTS-HD profile the stream reports (MA or HRA) outranks a title's other DTS claim; DTS:X still refines it.
            const profile = audioCodecFromText([stream.Codec, stream.Profile].filter(Boolean).join(' '));
            const refined = profile !== null && DTS_PROFILES.includes(profile) && DTS_TITLES.includes(title)
                ? profile
                : audioCodecFromText([stream.DisplayTitle, stream.Codec, stream.Profile].filter(Boolean).join(' ')) || title;
            // The title refined by the same track's codec and profile, else the title alone, if the codec can carry it.
            const label = [refined, title]
                .map(candidate => atmosCarrier(candidate, stream)).find(candidate => carrierAllows(candidate, stream.Codec));
            if (label) return label;
        }
        for (const stream of streams) {
            const label = [audioCodecFromText([stream.Codec, stream.Profile].filter(Boolean).join(' ')), audioCodecFromText(stream.Codec)]
                .filter((candidate): candidate is string => !!candidate).map(candidate => atmosCarrier(candidate, stream)).find(candidate => carrierAllows(candidate, stream.Codec));
            if (label) return label;
        }
        return null;
    }

    const DTS_PROFILES = ['DTS-HD MA', 'DTS-HD HRA'];
    const DTS_TITLES = ['DTS', 'DTS-HD', 'DTS-HD MA', 'DTS-HD HRA'];

    // What each known stream codec can be (QualityTagRules.CarrierAllows): a title may refine its carrier
    // (DTS → DTS-HD MA, E-AC-3 → DD+ ATMOS) but never contradict it, so an AC-3 track titled "Atmos" stays
    // Dolby Digital and an AAC track titled "TrueHD" has no codec chip. An unknown codec lets the title decide.
    const CARRIERS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
        [/^(?:e-?ac-?3|ddp)/, ['Dolby Digital+', 'DD+ ATMOS']],
        [/^ac-?3$/, ['Dolby Digital']],
        [/^(?:truehd|mlp)/, ['TRUEHD', 'TRUEHD ATMOS']],
        [/^(?:dts|dca)/, ['DTS', 'DTS-HD', 'DTS-HD MA', 'DTS-HD HRA', 'DTS-X']],
        [/^flac/, ['FLAC']],
        [/^pcm/, ['PCM']],
        [/^(?:aac|opus|mp[23]|vorbis|alac|wmav)/, []],
    ];

    /**
     * @param label Detected sound label.
     * @param [codec] The track's stream codec.
     * @returns Whether the codec can carry that label.
     */
    function carrierAllows(label: string, codec: unknown): boolean {
        const known = CARRIERS.find(([pattern]) => pattern.test(String(codec || '').toLowerCase()));
        return !known || known[1].includes(label);
    }

    /**
     * Atmos with the carrier that holds it (TRaSH's TrueHD Atmos and DD+ Atmos): lossless TrueHD,
     * lossy E-AC-3, or plain ATMOS when the track does not say (QualityTagRules.AtmosCarrier).
     * @param label Detected codec label.
     * @param stream The same track.
     * @returns The label, with its carrier when it is ATMOS.
     */
    function atmosCarrier(label: string, stream: JsonRecord): string {
        if (label !== 'ATMOS') return label;
        // The stream codec names the carrier first: a TrueHD title cannot hide an E-AC-3 JOC track's Atmos.
        const codec = String(stream.Codec || '').toLowerCase();
        if (/^(?:truehd|mlp)/.test(codec)) return 'TRUEHD ATMOS';
        if (/^(?:e-?ac-?3|ddp)/.test(codec)) return 'DD+ ATMOS';
        const text = [stream.Codec, stream.Profile, stream.DisplayTitle].filter(Boolean).join(' ').toLowerCase();
        if (/(?:^|[^a-z0-9_])(?:true[ .-]?hd|mlp)(?![a-z_])/.test(text)) return 'TRUEHD ATMOS';
        if (/(?:^|[^a-z0-9_])(?:e[-_. ]?ac-?3|ddp(?:a|lus)?|dd\+|dolby\s*digital\s*(?:plus|\+))(?![a-z_])/.test(text)) return 'DD+ ATMOS';
        return label;
    }

    // ffmpeg channel layout names → the layout they are (the "(side)"/"(back)"/"(wide)" variants share it).
    const NAMED_LAYOUTS: Readonly<Record<string, string>> = { mono: '1.0', stereo: '2.0', quad: '4.0', hexagonal: '6.0', octagonal: '8.0' };
    // A bare count only says the usual layout for counts with one (Jellyfin's own convention).
    const COUNT_LAYOUTS: Readonly<Record<string, string>> = { 1: '1.0', 2: '2.0', 6: '5.1', 7: '6.1', 8: '7.1' };

    /**
     * One track's actual channel layout: its ChannelLayout, then a layout named in its title, then
     * the usual layout for its channel count. Height channels stay ("5.1.2", "7.1.4"). Unknown
     * stays unknown (QualityTagRules.TrackChannels).
     * @param stream Audio track.
     * @returns Layout such as "6.1", "4.0", "1.0" or "7.1.4".
     */
    function trackChannels(stream: JsonRecord): string|null {
        // A layout, from Jellyfin's layout field or the title, only counts when the track's own channel count is
        // unknown or agrees with it (its bed, or bed plus heights: TrueHD Atmos 7.1.4 over 8 channels), so a stereo
        // encode titled or labelled "5.1"/"7.1" stays 2.0.
        const count = Number(stream.Channels) > 0 ? Number(stream.Channels) : 0;
        const agrees = (found: string) => {
            const [bed = 0, lfe = 0, height = 0] = found.split('.').map(Number);
            return !count || bed + lfe === count || bed + lfe + height === count;
        };
        const layout = String(stream.ChannelLayout || '').toLowerCase().replace(/\(.*\)$/, '').trim();
        const namedLayout = own(NAMED_LAYOUTS, layout);
        if (namedLayout && agrees(namedLayout)) return namedLayout;
        const numeric = /^(\d)\.(\d)(?:\.(\d))?$/.exec(layout);
        if (numeric && agrees(numeric.slice(1).filter(Boolean).join('.'))) return numeric.slice(1).filter(Boolean).join('.');
        const title = String(stream.DisplayTitle || '').toLowerCase();
        const named = /(?:^|[^a-z0-9_])([1-7])[. ]([01])(?:\.([246]))?(?![a-z0-9_])/.exec(title);
        const fromTitle = named ? named.slice(1).filter(Boolean).join('.')
            : /(?:^|[^a-z0-9_])stereo(?![a-z0-9_])/.test(title) ? '2.0'
            : /(?:^|[^a-z0-9_])mono(?![a-z0-9_])/.test(title) ? '1.0' : null;
        if (fromTitle && agrees(fromTitle)) return fromTitle;
        return own(COUNT_LAYOUTS, String(stream.Channels)) || null;
    }

    /**
     * One track's own sound label: its codec with its own channels, or a bare surround layout
     * (its bed only: "5.1.2" without a codec is 5.1).
     * @param stream Audio track.
     * @returns Label such as "ATMOS 7.1", or null.
     */
    function trackAudioLabel(stream: JsonRecord): string|null {
        const codec = detectCurrentAudioCodec([stream]);
        const channels = trackChannels(stream);
        if (!codec) {
            const bed = channels?.slice(0, 3);
            return bed && ['7.1', '6.1', '5.1'].includes(bed) ? bed : null;
        }
        return channels && !codec.includes(channels) ? `${codec} ${channels}` : codec;
    }

    /**
     * Highest sound for current vocabularies: rank every eligible track by codec tier, then
     * channels, and keep the winning track's own label (first track wins a tie).
     * @param streams Audio tracks after the language tiers.
     * @returns The best single track's label.
     */
    function bestAudioLabel(streams: JsonRecord[]): string|null {
        let best: string | null = null;
        for (const stream of streams) {
            const label = trackAudioLabel(stream);
            if (label && (best === null || distinctRank(label, 'audio') < distinctRank(best, 'audio'))) best = label;
        }
        return best;
    }

    // Jellyfin's VideoRangeType values (both supported targets), lowercased. A Dolby Vision
    // stream keeps its base layer so All mode can show the fallback a non-DV display gets.
    const RANGE_TYPES: Readonly<Record<string, VideoRangeFacts>> = {
        sdr: { range: null, base: null, sdr: true },
        hdr10: { range: 'HDR10', base: null, sdr: false },
        hdr10plus: { range: 'HDR10+', base: null, sdr: false },
        hlg: { range: 'HLG', base: null, sdr: false },
        dovi: { range: 'Dolby Vision', base: null, sdr: false },
        doviwithhdr10: { range: 'Dolby Vision', base: 'HDR10', sdr: false },
        doviwithhdr10plus: { range: 'Dolby Vision', base: 'HDR10+', sdr: false },
        doviwithhlg: { range: 'Dolby Vision', base: 'HLG', sdr: false },
        doviwithsdr: { range: 'Dolby Vision', base: 'SDR', sdr: false },
        doviwithel: { range: 'Dolby Vision', base: 'HDR10', sdr: false },
        doviwithelhdr10plus: { range: 'Dolby Vision', base: 'HDR10+', sdr: false },
    };

    /**
     * Dynamic range of one video stream: Jellyfin's VideoRangeType first; only a missing or
     * unknown type falls back to word-bounded hints in the display title and the type text
     * ("DVD" is not Dolby Vision).
     * @param video Video stream.
     * @returns Range, DV base layer, known SDR.
     */
    function videoRangeFacts(video: JsonRecord): VideoRangeFacts {
        const type = String(video?.VideoRangeType || '').toLowerCase();
        const known = own(RANGE_TYPES, type);
        if (known) return known;
        // An unrecognised type string still counts as a hint, after the title.
        const title = `${String(video?.DisplayTitle || '')} ${type}`.toLowerCase();
        const word = (pattern: string) => new RegExp(`(?:^|[^a-z0-9_])(?:${pattern})(?![a-z0-9_])`).test(title);
        // Jellyfin's DOVIInvalid says the Dolby Vision metadata is unusable: a DV word in the title cannot claim it.
        const hdr10Plus = /(?:^|[^a-z0-9_])hdr10(?:\+|plus(?![a-z0-9_]))/.test(title);
        // A title naming a base layer too ("Dolby Vision HDR10") keeps it, as the structured DOVIWith… types do.
        if (type !== 'doviinvalid' && word('dolby\\s*vision|dovi|dv')) {
            return { range: 'Dolby Vision', base: hdr10Plus ? 'HDR10+' : word('hdr10') ? 'HDR10' : word('hlg') ? 'HLG' : word('sdr') ? 'SDR' : null, sdr: false };
        }
        if (hdr10Plus) return { range: 'HDR10+', base: null, sdr: false };
        if (word('hdr10')) return { range: 'HDR10', base: null, sdr: false };
        if (word('hlg')) return { range: 'HLG', base: null, sdr: false };
        if (word('hdr')) return { range: 'HDR', base: null, sdr: false };
        // Jellyfin's coarse VideoRange still says HDR or SDR when the type is unknown.
        const coarse = String(video?.VideoRange || '').toLowerCase();
        if (coarse === 'hdr') return { range: 'HDR', base: null, sdr: false };
        return { range: null, base: null, sdr: word('sdr') || coarse === 'sdr' };
    }

    /** @returns A lowercased title with "h.264"/"vc-1"/"mpeg-2" spellings joined (QualityTagRules.CodecTitle). */
    function codecTitle(title: unknown): string {
        return String(title || '').toLowerCase().replace(/(?<![a-z0-9])(h)[. ](26[456])(?![0-9])|(?<![a-z0-9])(vc|mpeg|vp)[-. ]([1-9])(?![a-z0-9])/g,
            (_, h: string | undefined, hn: string, w: string, wn: string) => h ? h + hn : w + wn);
    }

    /**
     * Video codec label (first match on the codec, then on the display title).
     * @param video Video stream.
     * @returns Codec label.
     */
    function detectVideoCodec(video: JsonRecord): string|null {
        const current: ReadonlyArray<readonly [string, string]> = [['vvc', 'VVC'], ['h266', 'VVC'], ['hevc', 'HEVC'], ['h265', 'H265'], ['h264', 'H264'], ['avc', 'H264'], ['av1', 'AV1'], ['vp9', 'VP9'],
            ['vp8', 'VP8'], ['xvid', 'XVID'], ['divx', 'DIVX'], ['wmv', 'WMV'], ['vc1', 'VC-1'], ['mpeg2', 'MPEG2'],
            ['mpeg4', 'MPEG4'], ['mjpeg', 'MJPEG'], ['theora', 'THEORA'], ['prores', 'ProRes']];
        const codec = String(video.Codec || '').toLowerCase();
        const codecTag = String(video.CodecTag || '').toLowerCase();
        for (const [needle, label] of current) {
            if (codec.includes(needle)) return label;
            // CodecTag is consulted for AVC, and for the MPEG-4 Part 2 encoders Jellyfin reports as
            // "mpeg4" (XviD; DivX as DIVX/DX50/DIV3-6), right after the codec's own check.
            if (needle === 'avc' && codecTag.includes('avc')) return label;
            if (needle === 'xvid' && codecTag.includes('xvid')) return label;
            if (needle === 'divx' && /divx|dx50|div[3-6]/.test(codecTag)) return label;
        }
        // A title only names a codec as a whole word ("NAV1GATOR" is no AV1), written with or without
        // its dot or hyphen ("H.264", "VC-1", "MPEG-2").
        const displayTitle = codecTitle(video.DisplayTitle);
        return current.find(([needle]) => new RegExp(`(?:^|[^a-z0-9])${needle}(?![a-z0-9])`).test(displayTitle))?.[1] || null;
    }

    // A scene release group closing a file name after its codec, audio, resolution or source token
    // (Shared/MediaTags/MediaNamingTags.cs TrailingGroup): its letters are a name, not a release word.
    const RELEASE_GROUP = /(?<=(?:^|[. _\-[\](){}])(?:[xh]\.?26[45]|hevc|avc|av1|vp9|xvid|divx|mpeg2|aac|ac3|e?ac3|dts|ma|ddp?|flac|opus|atmos|truehd|\d\.\d|\d{3,4}p|web|webrip|web[. _\-[\]()]*dl|bluray|remux|hdtv|dvdrip|10bit|hdr|hdr10|dv|sdr))-[A-Za-z0-9]{2,}$/i;

    /** @returns A path without the release group closing its file name (MediaNamingTags.WithoutReleaseGroup). */
    function withoutReleaseGroup(path: string): string {
        if (!path) return path;
        const bare = (path.includes('://') ? path.split(/[?#]/)[0] : path) ?? path;
        const slash = bare.replace(/\\/g, '/').lastIndexOf('/');
        const file = bare.slice(slash + 1);
        const dot = file.lastIndexOf('.');
        const extension = dot > 0 && file.length - dot >= 2 && file.length - dot <= 5 ? file.slice(dot) : '';
        const stem = extension ? file.slice(0, -extension.length) : file;
        return bare.slice(0, slash + 1) + stem.replace(RELEASE_GROUP, '') + extension;
    }

    /** A known interlaced 1080, 576 or 480 frame is 1080i, 576i or 480i, never claimed progressive (QualityTagRules.DetectResolution). */
    function interlacedLabel(tag: string, video: JsonRecord): string {
        return ['1080p', '576p', '480p'].includes(tag) && video?.IsInterlaced === true ? tag.slice(0, -1) + 'i' : tag;
    }

    /**
     * Analyzes media stream and source information to determine quality tags.
     * @param mediaStreams - The MediaStreams array from the Jellyfin item.
     * @param mediaSources - The MediaSources array from the Jellyfin item.
     * @param [itemData] - Optional item metadata for filename/title signals.
     * @param [singleTrack=false] Internal per-track detection without display-mode expansion.
     * @param [sourceId] Remembered merged version, or the first version.
     * @returns A list of detected quality tags.
     */
    function getEnhancedQuality(rawStreams: unknown, rawSources: unknown, input: JsonRecord | null = null, singleTrack: boolean = false, sourceId: string = ''): string[] {
        let itemData = input;
        if (!rawStreams && !rawSources && !itemData?.Source && !itemData?.Edition) return [];
        let mediaStreams = listed(rawStreams);
        let mediaSources = listed(rawSources);

        const versions = versionCount(mediaStreams, mediaSources);
        // Narrow raw streams, cached per-track sets and filename/technical facts together.
        // The browser's pick, else the first version Jellyfin lists that has stream facts (an unprobed
        // version describes nothing), else the first listed. Facts never mix versions.
        const probed = (id: unknown) => !!id && (mediaStreams?.some(s => s?.SourceId === id && (s.Type === 'Video' || s.Type === 'Audio'))
            || records(mediaSources?.find(s => s?.Id === id)?.MediaStreams).some(s => s.Type === 'Video' || s.Type === 'Audio'));
        const versionId = sourceId && (mediaStreams?.some(s => s?.SourceId === sourceId) || mediaSources?.some(s => s?.Id === sourceId))
            ? sourceId : mediaSources?.find(s => probed(s?.Id))?.Id || mediaSources?.find(s => s?.Id)?.Id || mediaStreams?.find(s => s?.SourceId)?.SourceId;
        if (versionId) {
            const version = mediaSources?.find(s => s?.Id === versionId);
            const tagged = mediaStreams?.some(s => s?.SourceId);
            if (tagged) mediaStreams = mediaStreams?.filter(s => s?.SourceId === versionId) ?? null;
            else if (version?.MediaStreams) mediaStreams = listed(version.MediaStreams);
            if (version) mediaSources = [version];
            itemData = { ...itemData,
                ...(version ? { Path: version.Path, RunTimeTicks: version.RunTimeTicks ?? itemData?.RunTimeTicks,
                    Source: version.Source, Edition: version.Edition } : {}),
                DistinctQualities: itemData?.DistinctQualities ? members(itemData.DistinctQualities).map(memberRecord).filter(q => q.SourceId === versionId) : undefined };
        }

        const qualities = new Set<string>();
        let videoStreams: JsonRecord[] = [];
        let audioStreams: JsonRecord[] = [];

        if (mediaStreams) {
            const streams = mediaStreams.map(memberRecord);
            videoStreams = streams.filter(s => s.Type === 'Video');
            audioStreams = streams.filter(s => s.Type === 'Audio');
        }

        // Also check within MediaSources, as this can sometimes contain more accurate stream info
        if (mediaSources?.[0]?.MediaStreams) {
            const sourceStreams = members(mediaSources[0].MediaStreams).map(memberRecord);
            videoStreams = videoStreams.concat(sourceStreams.filter(s => s.Type === 'Video'));
            audioStreams = audioStreams.concat(sourceStreams.filter(s => s.Type === 'Audio'));
        }

        // Sound tag: judge only the preferred language's tracks when the user
        // or admin set one (#433) — a film whose English track is Atmos but
        // whose German dub is plain AC3 reads AC3 for a German-preferring
        // user. Falls back to every track when the title has no audio in it.
        audioStreams = selectAudioStreamsForLanguage(audioStreams, host.preferredAudioLanguage());

        // Get primary video stream for analysis
        const primaryVideoStream = videoStreams[0];
        // Version-0 documents keep their audio vocabulary; every account gets the current video
        // detection (range type, codec, dimensions), as the server does.
        const legacyAudio = legacyFullAudio();
        for (const label of technicalLabels(itemData?.RunTimeTicks, primaryVideoStream)) qualities.add(label);

        // --- IMAX TAG LOGIC ---
        // Pattern sources:
        // - TRaSH Guides IMAX CF regex (NON-IMAX exclusion + IMAX token)
        // - Dictionarry-Hub IMAX / IMAX Enhanced patterns
        // We gather multiple title/name/path signals since IMAX often appears in file names.
        const imaxSignals: unknown[] = [];
        if (itemData) {
            imaxSignals.push(
                itemData.Name || '',
                itemData.OriginalTitle || '',
                itemData.SortName || '',
                itemData.EditionTitle || '',
                itemData.ForcedSortName || ''
            );
        }
        if (Array.isArray(mediaSources)) {
            mediaSources.forEach((source) => {
                // A release group closing the file name ("…H264-IMAX") is a name, not an IMAX claim.
                imaxSignals.push(withoutReleaseGroup(String(source?.Path || '')), source?.Name || '');
            });
        }
        // Only video tracks speak for the picture: an audio track titled "Commentary about IMAX cameras" is not IMAX.
        if (Array.isArray(mediaStreams)) {
            mediaStreams.filter(stream => stream?.Type === 'Video').forEach((stream) => {
                imaxSignals.push(stream?.DisplayTitle || '', stream?.Title || '');
            });
        }

        const imaxContext = imaxSignals.filter(Boolean).join(' | ');
        const nonImaxRegex = /\bNON[ ._-]?IMAX\b/i;
        const imaxRegex = /\bIMAX(?:[ ._-]?ENHANCED)?\b/i;
        if (imaxContext && imaxRegex.test(imaxContext) && !nonImaxRegex.test(imaxContext)) {
            qualities.add('IMAX');
        }

        // --- VIDEO RESOLUTION LOGIC ---
        let resolutionTag: string | null = null;

        if (primaryVideoStream) {
            // Priority 1: DisplayTitle Scan for resolution keywords
            const displayTitle = String(primaryVideoStream.DisplayTitle || '');
            const resolutionRegex = /\b(8k|4320p|4k|2160p|1440p|1080p|1080i|720p|576p|576i|480p|480i|360p|404p|384p|520p)\b/i;
            const resolutionMatch = displayTitle.match(resolutionRegex);

            const streamHeight = finite(primaryVideoStream.Height) ?? 0;
            const streamWidth = finite(primaryVideoStream.Width) ?? 0;
            // Known dimensions decide; a title hint only names an unknown size.
            const knownSize = streamHeight > 0 || streamWidth > 0;
            if (resolutionMatch && !knownSize) {
                const found = (resolutionMatch[1] ?? '').toLowerCase();
                if (found === '8k' || found === '4320p') {
                    resolutionTag = '8K';
                } else if (found === '4k' || found === '2160p') {
                    resolutionTag = '4K';
                } else if (found === '1440p') {
                    resolutionTag = '1440p';
                } else if (found === '1080p') {
                    resolutionTag = '1080p';
                } else if (found === '720p') {
                    resolutionTag = '720p';
                } else if (found === '576p') {
                    resolutionTag = '576p';
                } else if (found === '480p') {
                    resolutionTag = '480p';
                } else if (['1080i', '576i', '480i'].includes(found)) {
                    // A title naming interlaced scan keeps it.
                    resolutionTag = found;
                } else if (['360p', '404p', '384p', '520p'].includes(found)) {
                    // Generic low-res tag for anything below 480p
                    resolutionTag = 'LOW-RES';
                }
                if (resolutionTag) qualities.add(interlacedLabel(resolutionTag, primaryVideoStream));
            } else {
                // Priority 2: Dimension Fallback
                // A portrait frame (a phone video, 1080x1920) is measured by its short and long sides.
                const portrait = streamHeight > streamWidth && streamWidth > 0;
                const height = portrait ? streamWidth : streamHeight;
                const width = portrait ? streamHeight : streamWidth;
                if ((height >= 3000 && (width >= 5000 || width <= 0)) || width >= 7000) {
                    // An 8K-class height needs a matching width: a 4:3 4096x3072 frame is 4K-class.
                    resolutionTag = '8K';
                } else if ((height >= 1550 && (width >= 2700 || width <= 0)) || width >= 3500) {
                    // A 4K-class height needs a matching width: 2560x1600 (16:10) is a 1440p-class frame.
                    resolutionTag = '4K';
                } else if (height >= 1250) {
                    // Only a 1440-class height: a 2560-wide frame is usually ultrawide 1080p (2560x1080).
                    resolutionTag = '1440p';
                } else if (height >= 1000 || width >= 1800) {
                    resolutionTag = '1080p';
                } else if (height >= 700 || width >= 1200) {
                    resolutionTag = '720p';
                } else if (height >= 528) {
                    // PAL DVD is 720x576; NTSC DVD is 720x480. 528 splits the two evenly.
                    resolutionTag = '576p';
                } else if (height >= 400 || width >= 640) {
                    // A cropped DVD (720x304) or SD scope encode (854x356) is still SD by its width.
                    resolutionTag = '480p';
                } else if (height > 0) {
                    // Any smaller frame gets the generic low-res tag
                    resolutionTag = 'LOW-RES';
                }

                if (resolutionTag) {
                    qualities.add(interlacedLabel(resolutionTag, primaryVideoStream));
                }
            }
        }

        // --- VIDEO CODEC LOGIC ---
        if (primaryVideoStream) {
            const detectedCodec = detectVideoCodec(primaryVideoStream);
            if (detectedCodec) qualities.add(detectedCodec);
        }

        // --- VIDEO DYNAMIC RANGE LOGIC ---
        if (primaryVideoStream) {
            const range = videoRangeFacts(primaryVideoStream).range;
            if (range) qualities.add(range);
        }

        // --- AUDIO LOGIC ---
        let audioTag: string | null = null;
        if (!legacyAudio) {
            // One track supplies codec and channels together.
            audioTag = bestAudioLabel(audioStreams);
            if (audioTag) qualities.add(audioTag);
        } else {
            for (let i = 0; i < audioStreams.length; i++) {
                const stream = record(audioStreams[i]);

                // Priority 1: DisplayTitle Scan
                const displayTitle = String(stream.DisplayTitle || '');

                const atmosRegex = /atmos/i;
                const truehd = /truehd/i;
                const dtsxRegex = /dts-x/i;
                const dtsRegex = /\bdts\b/i;
                const ddpRegex = /dolby\s*digital\+/i;

                // The earlier vocabulary keeps its labels but never a carrier the stream codec cannot be.
                const legacyAllows = (tag: string) => carrierAllows(tag === 'ATMOS' ? 'DD+ ATMOS' : tag, stream.Codec) || (tag === 'ATMOS' && carrierAllows('TRUEHD ATMOS', stream.Codec));
                const atmosMatch = displayTitle.match(atmosRegex);
                const truehdMatch = displayTitle.match(truehd);
                const dtsxMatch = displayTitle.match(dtsxRegex);
                const dtsMatch = displayTitle.match(dtsRegex);
                const ddpMatch = displayTitle.match(ddpRegex);

                const titled = atmosMatch ? 'ATMOS' : truehdMatch ? 'TRUEHD' : dtsxMatch ? 'DTS-X' : dtsMatch ? 'DTS' : ddpMatch ? 'Dolby Digital+' : null;
                if (titled && legacyAllows(titled)) {
                    audioTag = titled;
                    break; // Stop all further audio checks
                }
            }

            if (!audioTag) {

                // Priority 2: Technical Metadata Fallback
                for (let i = 0; i < audioStreams.length; i++) {
                    const stream = record(audioStreams[i]);
                    const codec = String(stream.Codec || '').toLowerCase();
                    const profile = String(stream.Profile || '').toLowerCase();

                    if (codec.includes('truehd') || profile.includes('truehd')) {
                        if (codec.includes('atmos') || profile.includes('atmos')) {
                            audioTag = 'ATMOS';
                        } else {
                            audioTag = 'TRUEHD';
                        }
                        break;
                    } else if (codec.includes('dts')) {
                        // DTS:X by name only: XLL (the DTS-HD MA lossless extension) is not object audio.
                        if (/(?:^|[^a-z0-9_])dts[-_.: ]?x(?![a-z0-9_])/.test(`${codec} ${profile}`)) {
                            audioTag = 'DTS-X';
                        } else {
                            audioTag = 'DTS';
                        }
                        break;
                    } else if (codec.includes('eac3') || codec.includes('ddp')) {
                        audioTag = 'Dolby Digital+';
                        break;
                    }
                }
            }

            let channelTag = getChannelTag(audioStreams);
            // The earlier vocabulary keeps its words, but its codec and channels must come from one real track.
            ({ codec: audioTag, channels: channelTag } = truthfulLegacyAudio(audioTag, channelTag, audioStreams));

            // Append channel layout to codec tag instead of creating a separate channel tag.
            if (audioTag) {
                if (channelTag && !audioTag.includes(channelTag)) {
                    audioTag = `${audioTag} ${channelTag}`;
                }
                qualities.add(audioTag);
            } else if (channelTag === '7.1' || channelTag === '5.1') {
                // Preserve previous fallback behavior when no codec tag is detected.
                qualities.add(channelTag);
            }
        }

        // --- 3D VIDEO LOGIC ---
        if (mediaSources) {
            for (const member of mediaSources) {
                const source = memberRecord(member);
                // Jellyfin's own 3D format first (Is3D in cached facts, Video3DFormat on items), else 3D release
                // words as whole words, outside a closing release group ("3Days…H264-MVC" is no 3D).
                const path = withoutReleaseGroup(String(source.Path || '')).toLowerCase();
                const has3D = /(?:^|[^a-z0-9])3d(?![a-z0-9])/.test(path);
                const has3DFormat = /(?:^|[^a-z0-9])(?:hsbs|fsbs|htab|ftab|mvc)(?![a-z0-9])/.test(path);
                if (source.Is3D === true || source.Video3DFormat || (has3D && has3DFormat)) {
                    qualities.add('3D');
                    break; // Found 3D, no need to check other sources
                }
            }
        }

        // --- MEDIA STUB TAG LOGIC ---
        // Detect media stubs (.disc files) for BluRay, DVD, or generic Physical media
        const stubSignals: unknown[] = [];
        if (itemData) {
            stubSignals.push(
                itemData.Name || '',
                itemData.Path || ''
            );
        }
        if (Array.isArray(mediaSources)) {
            mediaSources.forEach((source) => {
                stubSignals.push(source?.Path || '', source?.Name || '');
            });
        }

        const stubContext = stubSignals.filter(Boolean).join(' | ').toLowerCase();

        // Check for .disc extension (media stub indicator)
        if (/\.disc(?:$|\s*\|)/.test(stubContext)) {
            // Parse filename/path for specific media type patterns
            const blurayRegex = /bluray|blu-ray|bdrip|bd-rip|bdremux/;
            const hddvdRegex = /hddvd|hd-dvd|hd dvd/;
            const dvdRegex = /dvd|dvdrip|dvd-rip|dvdremux/;
            const vhsRegex = /vhs/;
            const hdtvRegex = /hdtv/;

            if (blurayRegex.test(stubContext)) {
                qualities.add('BluRay');
            } else if (hddvdRegex.test(stubContext)) {
                qualities.add('HD DVD');
            } else if (dvdRegex.test(stubContext)) {
                qualities.add('DVD');
            } else if (vhsRegex.test(stubContext)) {
                qualities.add('VHS');
            } else if (hdtvRegex.test(stubContext)) {
                qualities.add('HDTV');
            } else {
                qualities.add('Physical');
            }
        }

        // Naming facts are computed before server paths are trimmed. Legacy stubs remain a fallback.
        const namedSource = text(itemData?.Source);
        if (namedSource && sourceOrder.includes(namedSource)) {
            for (const source of sourceOrder) qualities.delete(source);
            qualities.add(namedSource);
        }
        if (itemData?.Edition) qualities.add(EDITION_PREFIX + String(itemData.Edition));
        if (!singleTrack && versions > 1) qualities.add(`versions:${versions}`);
        if (!singleTrack && displayModeKey() !== '000') {
            const distinct: readonly unknown[] = itemData?.DistinctQualities ? members(itemData.DistinctQualities) : distinctQualities(videoStreams, audioStreams);
            for (const category of ['audio', 'videoCodec', 'dynamicRange']) {
                if (!allValues(category)) continue;
                for (const label of qualities) if (categorize(label) === category) qualities.delete(label);
                const facts: readonly unknown[] = category === 'audio' && legacyAudio ? distinctQualities([], audioStreams) : distinct;
                let values = facts.map(memberRecord).filter(value => value.Category === (category === 'audio' ? 'audioInfo' : category));
                if (category === 'audio' && host.preferredAudioLanguage()) {
                    // The raw tracks already chose the language tier above, including
                    // unlabelled tracks. No labels in that tier means no sound chip.
                    const languages = new Set<unknown>(audioStreams.map(stream => stream.Language || null));
                    values = values.filter(value => languages.has(value.Language || null));
                }
                for (const value of values) qualities.add(memberText(value.Label));
            }
        }
        return Array.from(qualities);
    }

    /** @param category Web category id. @returns Whether distinct sets are enabled. */
    function allValues(category: string): boolean {
        const key = category === 'audio' ? 'qualityAudioDisplayMode' : category === 'videoCodec' ? 'qualityVideoCodecDisplayMode' : category === 'dynamicRange' ? 'qualityHdrDisplayMode' : null;
        return !!key && host.setting(key) === 'all';
    }

    /** @returns Cache fingerprint for detection-affecting category modes. */
    function displayModeKey(): string {
        return ['audio', 'videoCodec', 'dynamicRange'].map(category => allValues(category) ? '1' : '0').join('');
    }

    /** Detect independently per track; cached and batch fallback paths use the same labels and language tiers.
     * @param videos Video streams. @param {Object[]} audio Audio streams. @returns Distinct facts.
     */
    function distinctQualities(videos: readonly JsonRecord[], audio: readonly JsonRecord[]): DistinctQuality[] {
        const values: DistinctQuality[] = [];
        for (const stream of [...videos, ...audio]) {
            const labels = getEnhancedQuality([stream], null, null, true);
            const categories = stream.Type === 'Video' ? ['videoCodec', 'dynamicRange'] : ['audio'];
            for (const label of labels) {
                const category = categorize(label);
                if (category && categories.includes(category)) values.push({ Category: category === 'audio' ? 'audioInfo' : category, Label: label, Language: stream.Language });
            }
            if (stream.Type === 'Video') {
                // Unknown stays unknown: only a known SDR stream is SDR; a Dolby Vision
                // stream also lists the base layer other displays fall back to.
                const facts = videoRangeFacts(stream);
                if (facts.base) values.push({ Category: 'dynamicRange', Label: facts.base });
                else if (!facts.range && facts.sdr) values.push({ Category: 'dynamicRange', Label: 'SDR' });
            }
        }
        return values;
    }

    /** @param label Quality label. @param {string} category Web category. @returns Rank; more channels win audio ties. */
    function distinctRank(label: string, category: string): number {
        const index = CATEGORY_BY_KEY.get(category)?.items.indexOf(normalizeQualityLabel(label)) ?? -1;
        // Every channel counts, heights too ("7.1.4" beats "7.1"; QualityTagRules.AggregationRank).
        const layout = /(\d)\.(\d)(?:\.(\d))?$/.exec(label);
        const channels = layout ? layout.slice(1).reduce((sum, part) => sum + Number(part || 0), 0) : 0;
        if (category !== 'audio') return (index < 0 ? 999 : index) * 100;
        // Lossy tracks (Dolby Digital+ onwards) rank by channels before codec, so an AAC 5.1 soundtrack
        // beats an AC-3 2.0 dub; lossless and object tiers always rank by codec first.
        const lossy = audioOrder.indexOf('Dolby Digital+');
        if (index >= lossy) return lossy * 100 + (99 - Math.min(channels, 99)) * 10 + (index - lossy);
        return (index < 0 ? 99900 : index * 100) + 99 - Math.min(channels, 99);
    }

    /** @param label Detected resolution. @returns Inclusive threshold, unknown settings mean Off. */
    function meetsMinimum(label: string): boolean {
        const threshold = host.setting('qualityMinimumResolution');
        // The last label each threshold accepts (1080i counts as 1080).
        const last = resolutionOrder.indexOf(threshold === '4k' ? '4K' : threshold === '1080p' ? '1080i' : threshold === '720p' ? '720p' : '');
        const index = resolutionOrder.indexOf(label);
        return last < 0 || (index >= 0 && index <= last);
    }

    /**
     * Effective series/season policy, independently of layout and label density.
     * @returns A known policy; legacy and invalid settings remain representative.
     */
    function aggregationPolicy(): string {
        const policy = host.setting('seriesQualityAggregation');
        return typeof policy === 'string' && ['latest', 'best', 'shared', 'mixed'].includes(policy) ? policy : 'representative';
    }

    /**
     * Resolve compact server facts without fetching episodes. Resolution, source, dynamic range,
     * codec and sound follow the policy across episodes; edition and special-format labels keep
     * their representative semantics, except latest uses its own labels.
     * @param entry - A server-cache entry, or batch item carrying QualitySummary.
     * @param representative - Legacy stream-derived labels.
     * @returns Labels before category toggles, ordering, density and caps.
     */
    function aggregateQualities(entry: JsonRecord, representative: string[]): string[] {
        const policy = aggregationPolicy();
        const summary = entry.QualitySummary;
        if (entry.Type !== 'Series' && entry.Type !== 'Season' || !isRecord(summary) || policy === 'representative') return representative;
        const categoryKeys: Readonly<Record<string, string>> = { resolution: 'resolution', source: 'source', dynamicRange: 'dynamicRange', videoCodec: 'videoCodec', audioInfo: 'audio' };
        // A version count describes one episode, never the series or season (QualitySummary.LatestExtras
        // stored before schema 31 may still carry one).
        const qualities = (policy === 'latest' ? members(summary.LatestExtras)
            : representative.filter(label => !Object.values(categoryKeys).includes(categorize(label) ?? '')))
            .map(memberText).filter(label => !label.startsWith('versions:'));
        const preferred = host.preferredAudioLanguage();
        const match = host.language()?.matchesLanguage;
        const audioVariants = Object.entries(record(legacyFullAudio() ? summary.LegacyAudioByLanguage : summary.AudioByLanguage));
        const regionalFallbacks = Object.entries(record(legacyFullAudio() ? summary.LegacyAudioRegionFallback : summary.AudioRegionFallback));
        const audio = preferred && typeof match === 'function'
            ? (audioVariants.find(([language]) => match(language, preferred, { requireRegion: true }))
                || regionalFallbacks.find(([language]) => match(language, preferred))
                || audioVariants.find(([language]) => !language.includes('-') && match(language, preferred)))?.[1] : null;
        let mixed = false;
        for (const [key, category] of Object.entries(record(summary.Categories))) {
            const facts = memberRecord(key === 'audioInfo' ? audio || (legacyFullAudio() ? summary.LegacyAudio : category) || {} : category);
            const categoryKey = own(categoryKeys, key) ?? '';
            const cat = CATEGORY_BY_KEY.get(categoryKey);
            if (allValues(categoryKey)) {
                qualities.push(...members(policy === 'latest' ? facts.LatestAll : policy === 'shared' ? facts.Shared : facts.All).map(memberText));
                mixed ||= !facts.AllSetsAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true);
                continue;
            }
            const value = policy === 'latest' ? facts.Latest : policy === 'shared' && !facts.AllAgree ? null : facts.Best;
            if (typeof value === 'string' && value) qualities.push(value);
            mixed ||= !facts.AllAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true);
        }
        if (policy === 'mixed' && Number(summary.EpisodeCount) > 1 && mixed) qualities.push('Mixed');
        return qualities;
    }

    /** @returns Whether audio must retain version-0 presentation. */
    function legacyFullAudio(): boolean {
        return host.legacyAudio();
    }

    /**
     * Fingerprint the effective category switches used to decide whether Mixed is present.
     * @returns Stable key for computed labels retained across reinitialization.
     */
    function aggregationCategoriesKey(): string {
        return CATEGORIES.map(cat => readBool(cat.settingKey, cat.fallback ?? true) ? '1' : '0').join('');
    }

    /**
     * Reads a boolean category toggle from per-user settings.
     * @param userKey - Key on JE.currentSettings
     * @param fallback - Returned when the user setting is not a boolean
     * @returns The resolved boolean
     */
    function readBool(userKey: string, fallback: boolean): boolean {
        const userVal = host.setting(userKey);
        if (typeof userVal === 'boolean') return userVal;
        return fallback;
    }

    /**
     * Reads a numeric category order from per-user settings.
     * @param userKey - Key on JE.currentSettings
     * @param fallback - Returned when the user setting is not a finite number
     * @returns The resolved number
     */
    function readInt(userKey: string, fallback: number): number {
        const userVal = finite(host.setting(userKey));
        if (userVal !== null) return userVal;
        return fallback;
    }

    /**
     * Determines which category a quality tag belongs to
     * @param tag - A quality tag, possibly composite (e.g. "ATMOS 7.1")
     * @returns The category key, or null if uncategorized
     */
    function categorize(tag: string): string|null {
        for (const cat of CATEGORIES) if (!cat.items.length && tag.startsWith(cat.key + ':')) return cat.key;
        const norm = normalizeQualityLabel(tag);
        const direct = TAG_TO_CATEGORY.get(norm);
        if (direct) return direct;
        // Bare channel layouts (e.g. "2.0") fall into audio.
        if (/^\d+\.\d+$/.test(tag)) return 'audio';
        return null;
    }


    return { aggregateQualities, aggregationCategoriesKey, aggregationPolicy, allValues, categorize, displayModeKey, distinctRank, getEnhancedQuality, legacyFullAudio, meetsMinimum, normalizeQualityLabel, readBool, readInt };
}
export type QualityRules = ReturnType<typeof createQualityRules>;
