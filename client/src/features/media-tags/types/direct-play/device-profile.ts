// jellyfin-web 12.1's browser device profile (scripts/browserDeviceProfile.js, apphost.js and browser.js), ported:
// the same canPlayType probes, platform rules and playback settings. Settings reads go through ProfileSettings so a
// build can record what it depended on; everything else is what the browser itself reports.
export type BrowserFlags = { [flag: string]: boolean | number | undefined; versionMajor?: number; iOSVersion?: number };
export interface ProfileSettings { app(name: string): string | null; user(name: string): string | null }
export interface ProfileCondition { Condition: string; Property: string; Value: string; IsRequired?: boolean }
export interface DirectPlayProfile { Container: string; Type: string; VideoCodec?: string; AudioCodec?: string }
export interface TranscodingProfile {
    Container: string; Type: string; AudioCodec: string; VideoCodec?: string; Context: string; Protocol: string; MaxAudioChannels: string;
    MinSegments?: string; BreakOnNonKeyFrames?: boolean; EnableAudioVbrEncoding?: boolean; SegmentLength?: number | undefined;
    ApplyConditions?: ProfileCondition[]; Conditions?: ProfileCondition[];
}
export interface CodecProfile { Type: string; Codec?: string; Container?: string; SubContainer?: string; Conditions: ProfileCondition[] }
export interface SubtitleProfile { Format: string; Method: string; Container?: string }
/** A native shell supplies its own, so everything but the direct-play list is optional. */
export interface DeviceProfile {
    MaxStreamingBitrate?: number;
    MaxStaticBitrate?: number;
    MusicStreamingTranscodingBitrate?: number;
    DirectPlayProfiles: DirectPlayProfile[];
    TranscodingProfiles?: TranscodingProfile[];
    ContainerProfiles?: unknown[];
    CodecProfiles?: CodecProfile[];
    SubtitleProfiles?: SubtitleProfile[];
    ResponseProfiles?: Array<{ Type: string; Container: string; MimeType: string }>;
}
export interface ProfileOptions {
    audioChannels?: number; disableHlsVideoAudioCodecs?: string[]; disableVideoAudioCodecs?: string[]; enableHls?: boolean; enableMkvProgressive?: boolean;
    enablePgsRender?: boolean; enableSsaRender?: boolean; globalMaxVideoBitrate?: number; isRetry?: boolean; maxVideoWidth?: number;
    supportsDolbyVision?: boolean; supportsDts?: boolean; supportsHdr10?: boolean; supportsHevc?: boolean; supportsHlg?: boolean;
    supportsMp2VideoAudio?: boolean; supportsTrueHd?: boolean;
}
export interface AppHostShell {
    screen?(): { width: number; height: number } | null;
    getDeviceProfile?(builder: (options?: ProfileOptions) => DeviceProfile, version: string): unknown;
}
interface ProfileWindow { tizen?: unknown; NativeShell?: { AppHost?: AppHostShell }; webkitAudioContext?: typeof AudioContext }
export function profileWindow(): Window & ProfileWindow { return window; }

/**
 * The browser flags jellyfin-web 12.1's device profile reads (a port of
 * the matching part of its scripts/browser.js detectBrowser). TV
 * platform versions (Tizen, webOS) are not read: those clients are app
 * shells whose own profile wins (see current()).
 * */
export function browserFlags(userAgent?: string): BrowserFlags {
    const nav: Partial<Pick<Navigator, 'userAgent' | 'maxTouchPoints' | 'appVersion'>> = typeof navigator !== 'undefined' ? navigator : {};
    const raw = userAgent ?? nav.userAgent ?? '';
    const ua = raw.toLowerCase().replace(/(motorola edge)/, '').trim();
    const match = /(edg)[ /]([\w.]+)/.exec(ua) || /(edga)[ /]([\w.]+)/.exec(ua) || /(edgios)[ /]([\w.]+)/.exec(ua)
        || /(edge)[ /]([\w.]+)/.exec(ua) || /(titanos)[ /]([\w.]+)/.exec(ua) || /(opera)[ /]([\w.]+)/.exec(ua)
        || /(opr)[ /]([\w.]+)/.exec(ua) || /(chrome)[ /]([\w.]+)/.exec(ua) || /(safari)[ /]([\w.]+)/.exec(ua)
        || /(firefox)[ /]([\w.]+)/.exec(ua) || (!ua.includes('compatible') && /(mozilla)(?:.*? rv:([\w.]+)|)/.exec(ua)) || [] as string[];
    const versionMatch = /(version)[ /]([\w.]+)/.exec(ua);
    let platform = (/(ipad)/.exec(ua) || /(iphone)/.exec(ua) || /(windows)/.exec(ua) || /(android)/.exec(ua) || /(titanos)/.exec(ua) || [])[0] || '';
    let name = match[1] || '';
    if (name === 'edge') platform = '';
    if (name === 'opr') name = 'opera';
    const version = (versionMatch && versionMatch.length > 2 ? versionMatch[2] : null) || match[2] || '0';
    const b: BrowserFlags = {};
    if (name) { b[name] = true; b.versionMajor = parseInt(version.split('.')[0] ?? '', 10) || 0; }
    if (platform) b[platform] = true;
    b.edgeChromium = !!(b.edg || b.edga || b.edgios);
    if (!b.chrome && !b.edgeChromium && !b.edge && !b.opera && ua.includes('webkit')) b.safari = true;
    b.osx = ua.includes('mac os x');
    if (b.osx && !b.iphone && !b.ipod && !b.ipad && (nav.maxTouchPoints || 0) > 1) b.ipad = true;
    b.mobile = ['mobi', 'ipad', 'iphone', 'ipod', 'silk', 'gt-p1000', 'nexus 7', 'kindle fire', 'opera mini'].some((t) => ua.includes(t));
    b.ps4 = ua.includes('playstation 4');
    b.xboxOne = ua.includes('xbox');
    b.tizen = ua.includes('tizen') || (typeof window !== 'undefined' && profileWindow().tizen != null);
    b.vidaa = ua.includes('vidaa');
    b.web0s = ua.includes('netcast') || ua.includes('web0s');
    b.tv = b.ps4 || ua.includes('kepler') || b.xboxOne || (!ua.includes('oculusbrowser') && (ua.includes('tv') || ua.includes('samsungbrowser') || ua.includes('viera') || ua.includes('titanos') || b.web0s));
    b.edgeUwp = (b.edge || b.edgeChromium) && (ua.includes('msapphost') || ua.includes('webview'));
    if (b.web0s || b.tizen) { delete b.chrome; delete b.safari; }
    b.iOS = !!(b.ipad || b.iphone || b.ipod);
    if (b.iOS) {
        const os = /OS (\d+)_(\d+)_?(\d+)?/.exec(nav.appVersion || raw) || /Version\/(\d+)/.exec(nav.appVersion || raw);
        if (os) b.iOSVersion = parseInt(os[1] ?? '', 10) + (parseInt(os[2] || '0', 10) / 10);
    }
    return b;
}

/** jellyfin-web's toBoolean: only "true"/"false" count. */
export function flag(value: string | null, fallback: boolean): boolean {
    return value === 'true' ? true : value === 'false' ? false : fallback;
}

/**
 * Whether the browser can play a MIME type: `canPlayType` only, as
 * jellyfin-web's profile checks it.
 * */
export function can(el: HTMLMediaElement|null, type: string): boolean {
    try {
        return !!(el && typeof el.canPlayType === 'function' && String(el.canPlayType(type)).replace(/no/, ''));
    } catch {
        return false;
    }
}

/**
 * jellyfin-web 12.1's browser device profile (scripts/browserDeviceProfile.js),
 * ported: the same canPlayType probes, platform rules and user playback
 * settings (DTS, TrueHD, Hi10p, subtitle burn-in and PGS rendering,
 * audio channels, fMP4-HLS, segment length) decide direct-play
 * containers and codecs, HLS targets, codec conditions (profiles,
 * levels, video range types, interlacing, anamorphic, bitrate and width
 * limits) and subtitle formats. It is also the builder handed to a native
 * shell's getDeviceProfile, as jellyfin-web does.
 * @param [options] - jellyfin-web's profile builder options.
 * @param [b] - browserFlags().
 * */
export function webProfile(settings: ProfileSettings, options: ProfileOptions = {}, b: BrowserFlags = browserFlags()): DeviceProfile {
    const versionMajor = b.versionMajor ?? Number.NaN;
    const iOSVersion = b.iOSVersion ?? Number.NaN;
    const doc = typeof document !== 'undefined' ? document : null;
    const v = doc ? doc.createElement('video') : null;
    const audioEl = doc ? doc.createElement('audio') : null;
    const has = (type: string) => can(v, type);

    const canPlayHevc = () => {
        if (b.tizen || b.xboxOne || b.web0s || options.supportsHevc) return true;
        if (b.ps4) return false;
        return has('video/mp4; codecs="hvc1.1.L120"') || has('video/mp4; codecs="hev1.1.L120"') || has('video/mp4; codecs="hvc1.1.0.L120"') || has('video/mp4; codecs="hev1.1.0.L120"');
    };
    const canPlayAv1 = () => (b.xboxOne ? false : has('video/mp4; codecs="av01.0.15M.08"') && has('video/mp4; codecs="av01.0.15M.10"'));
    const canPlayNativeHls = () => b.tizen || has('application/x-mpegURL') || has('application/vnd.apple.mpegURL');
    const canPlayHls = canPlayNativeHls() || (typeof window !== 'undefined' && window.MediaSource != null);
    const canPlayNativeHlsInFmp4 = () => (b.iOS && iOSVersion >= 11) || b.osx;
    const supportsAc3 = () => (b.edgeUwp || b.tizen || b.web0s ? true : b.iOS && iOSVersion < 11 ? false : has('audio/mp4; codecs="ac-3"'));
    const supportsEac3 = () => (b.tizen || b.web0s ? true : b.iOS && iOSVersion < 11 ? false : has('audio/mp4; codecs="ec-3"'));
    const canPlayDts = () => (has('video/mp4; codecs="dts-"') || has('video/mp4; codecs="dts+"') ? true : null);
    const supportsAc3InHls = () => (b.tizen || b.web0s ? true : has('application/x-mpegurl; codecs="avc1.42E01E, ac-3"') || has('application/vnd.apple.mpegURL; codecs="avc1.42E01E, ac-3"'));
    const supportsMp3InHls = () => has('application/x-mpegurl; codecs="avc1.64001E, mp4a.40.34"') || has('application/vnd.apple.mpegURL; codecs="avc1.64001E, mp4a.40.34"');
    const canPlayAudioFormat = (format: string) => {
        let type: string | undefined;
        if (format === 'flac' || format === 'asf') { if (b.tizen || b.web0s || b.edgeUwp) return true; } else if (format === 'wma') { if (b.tizen || b.edgeUwp) return true; } else if (format === 'opus') {
            if (b.web0s) return false;
            if (b.xboxOne) return false;
            type = 'audio/ogg; codecs="opus"';
        } else if (format === 'alac') { if (b.iOS || (b.osx && b.safari)) return true; } else if (format === 'mp2') return false;
        if (format === 'webma') type = 'audio/webm';
        else if (!type) type = 'audio/' + format;
        return can(audioEl, type);
    };
    const canPlayMkv = (() => {
        if (b.vidaa) return false;
        if (b.tizen || b.web0s) return true;
        // Firefox's mkv support forces preloading the whole file (jellyfin#15521).
        if (b.firefox) return false;
        if (has('video/x-matroska') || has('video/mkv')) return true;
        if (b.edgeChromium && b.windows) return true;
        return !!b.edgeUwp;
    })();
    const supportsMpeg2Video = () => b.tizen || b.web0s || b.edgeUwp;
    const supportsVc1 = () => b.tizen || b.web0s || b.edgeUwp || has('video/mp4; codecs="vc-1"');
    const supportsHdr10 = options.supportsHdr10 ?? !!(b.vidaa || b.tizen || b.web0s
        || (b.safari && ((b.iOS && iOSVersion >= 11) || b.osx))
        || (b.edgeChromium && versionMajor >= 121)
        || (b.chrome && !b.mobile)
        || (b.firefox && b.osx && !b.iphone && !b.ipod && !b.ipad && versionMajor >= 100));
    const supportsHlg = options.supportsHlg ?? supportsHdr10;
    const supportsDolbyVision = options.supportsDolbyVision ?? !!(b.safari && ((b.iOS && iOSVersion >= 13) || b.osx));
    const supportsAnamorphic = !!(b.chrome || b.firefox || b.safari || b.edgeChromium || b.edgeUwp || b.iOS || b.android);
    const supportsTextTracks = b.tizen || (v ? v.textTracks != null : false);
    // Probed only when PGS rendering is on (the order of jellyfin-web's checks does not matter to the result).
    const supportsCanvas2D = () => { try { return !!doc?.createElement('canvas').getContext('2d'); } catch { return false; } };
    const supportsSecondaryAudio = !!(v && 'audioTracks' in v && v.audioTracks) && !b.firefox;

    const allowedChannels = parseInt(settings.user('allowedAudioChannels') || '-1', 10);
    const physicalAudioChannels = (() => {
        if (allowedChannels > 0) return allowedChannels;
        if (options.audioChannels) return options.audioChannels;
        const surround = b.safari || b.chrome || b.edgeChromium || b.firefox || b.tv || b.ps4 || b.xboxOne;
        const speakers = speakerCount();
        if ((supportsAc3() || supportsEac3()) && surround) return speakers > 6 ? speakers : 6;
        if (speakers > 2) return surround ? speakers : 2;
        if (speakers > 0) return speakers;
        return surround ? 6 : 2;
    })();

    const bitrateSetting = 120000000;
    const canPlayVp8 = has('video/webm; codecs="vp8"');
    const canPlayVp9 = has('video/webm; codecs="vp9"');
    const safariSupportsOpus = !!b.safari && versionMajor >= 17 && can(audioEl, 'audio/x-caf; codecs="opus"');
    const webmAudioCodecs = ['vorbis'];
    const directPlay: DirectPlayProfile[] = [];
    const transcoding: TranscodingProfile[] = [];
    const codecProfiles: CodecProfile[] = [];
    const subtitleProfiles: SubtitleProfile[] = [];
    const profile: DeviceProfile = { MaxStreamingBitrate: bitrateSetting, MaxStaticBitrate: 100000000, MusicStreamingTranscodingBitrate: Math.min(bitrateSetting, 384000), DirectPlayProfiles: directPlay,
        TranscodingProfiles: transcoding, ContainerProfiles: [], CodecProfiles: codecProfiles, SubtitleProfiles: subtitleProfiles, ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }] };

    let videoAudioCodecs: string[] = [];
    let hlsInTsVideoAudioCodecs: string[] = [];
    let hlsInFmp4VideoAudioCodecs: string[] = [];
    const supportsMp3VideoAudio = has('video/mp4; codecs="avc1.640029, mp4a.69"') || has('video/mp4; codecs="avc1.640029, mp4a.6B"') || has('video/mp4; codecs="avc1.640029, mp3"');
    let supportsMp2VideoAudio = options.supportsMp2VideoAudio;
    if (supportsMp2VideoAudio == null) {
        supportsMp2VideoAudio = !!(b.edgeUwp || b.tizen || b.web0s);
        if (supportsMp3VideoAudio && (b.chrome || b.edgeChromium || (b.firefox && versionMajor >= 83))) supportsMp2VideoAudio = true;
        if (b.android) supportsMp2VideoAudio = false;
    }
    let maxVideoWidth = b.xboxOne ? (typeof screen !== 'undefined' ? screen.width : null) : null;
    if (options.maxVideoWidth) maxVideoWidth = options.maxVideoWidth;

    if (has('video/mp4; codecs="avc1.640029, mp4a.40.2"')) { videoAudioCodecs.push('aac'); hlsInTsVideoAudioCodecs.push('aac'); hlsInFmp4VideoAudioCodecs.push('aac'); }
    if (supportsMp3VideoAudio) videoAudioCodecs.push('mp3');
    if (b.safari || (supportsMp3VideoAudio && !b.ps4)) hlsInTsVideoAudioCodecs.push('mp3');
    if (supportsMp3InHls()) hlsInFmp4VideoAudioCodecs.push('mp3');
    if (supportsAc3()) {
        videoAudioCodecs.push('ac3');
        if (b.edgeChromium) hlsInFmp4VideoAudioCodecs.push('ac3');
        if (supportsEac3()) { videoAudioCodecs.push('eac3'); if (b.edgeChromium) hlsInFmp4VideoAudioCodecs.push('eac3'); }
        if (supportsAc3InHls()) {
            hlsInTsVideoAudioCodecs.push('ac3'); hlsInFmp4VideoAudioCodecs.push('ac3');
            if (supportsEac3()) { hlsInTsVideoAudioCodecs.push('eac3'); hlsInFmp4VideoAudioCodecs.push('eac3'); }
        }
    }
    if (supportsMp2VideoAudio) { videoAudioCodecs.push('mp2'); hlsInTsVideoAudioCodecs.push('mp2'); hlsInFmp4VideoAudioCodecs.push('mp2'); }
    let supportsDts: boolean | null | undefined = flag(settings.app('enableDts'), false) || options.supportsDts;
    if (supportsDts == null) supportsDts = canPlayDts();
    if (supportsDts) videoAudioCodecs.push('dca', 'dts');
    if (b.tizen || b.web0s) videoAudioCodecs.push('pcm_s16le', 'pcm_s24le');
    if (flag(settings.app('enableTrueHd'), false) || options.supportsTrueHd) videoAudioCodecs.push('truehd');
    if (b.tizen) videoAudioCodecs.push('aac_latm');
    if (canPlayAudioFormat('opus')) {
        videoAudioCodecs.push('opus'); webmAudioCodecs.push('opus');
        if (b.tizen) hlsInTsVideoAudioCodecs.push('opus');
        hlsInFmp4VideoAudioCodecs.push('opus');
    } else if (safariSupportsOpus) { videoAudioCodecs.push('opus'); webmAudioCodecs.push('opus'); hlsInFmp4VideoAudioCodecs.push('opus'); }
    if (canPlayAudioFormat('flac') && !b.tizen) { videoAudioCodecs.push('flac'); hlsInFmp4VideoAudioCodecs.push('flac'); }
    if (canPlayAudioFormat('alac')) { videoAudioCodecs.push('alac'); hlsInFmp4VideoAudioCodecs.push('alac'); }
    const disabled = options.disableVideoAudioCodecs || [];
    const disabledHls = options.disableHlsVideoAudioCodecs || [];
    videoAudioCodecs = videoAudioCodecs.filter((c) => !disabled.includes(c));
    hlsInTsVideoAudioCodecs = hlsInTsVideoAudioCodecs.filter((c) => !disabledHls.includes(c));
    hlsInFmp4VideoAudioCodecs = hlsInFmp4VideoAudioCodecs.filter((c) => !disabledHls.includes(c));

    const mp4VideoCodecs: string[] = [];
    const webmVideoCodecs: string[] = [];
    const hlsInTsVideoCodecs: string[] = [];
    const hlsInFmp4VideoCodecs: string[] = [];
    if (canPlayAv1() && (b.safari || b.tizen || b.web0s || (!b.mobile && (b.edgeChromium || b.firefox || b.chrome || b.opera)))) hlsInFmp4VideoCodecs.push('av1');
    if (canPlayHevc() && (b.edgeChromium || b.safari || b.tizen || b.web0s || (b.chrome && (!b.android || versionMajor >= 105)) || (b.opera && !b.mobile) || (b.firefox && versionMajor >= 134))) hlsInFmp4VideoCodecs.push('hevc');
    if (has('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) { mp4VideoCodecs.push('h264'); hlsInTsVideoCodecs.push('h264'); hlsInFmp4VideoCodecs.push('h264'); }
    if (canPlayHevc()) { mp4VideoCodecs.push('hevc'); if (b.tizen || b.web0s || b.vidaa) hlsInTsVideoCodecs.push('hevc'); }
    if (supportsMpeg2Video()) mp4VideoCodecs.push('mpeg2video');
    if (supportsVc1()) mp4VideoCodecs.push('vc1');
    if (b.tizen) mp4VideoCodecs.push('msmpeg4v2');
    if (canPlayVp8) webmVideoCodecs.push('vp8');
    if (canPlayVp9) {
        if (!b.iOS && !(b.firefox && b.osx)) mp4VideoCodecs.push('vp9');
        if (b.safari || b.edgeChromium || b.chrome || b.firefox) hlsInFmp4VideoCodecs.push('vp9');
        if (!b.safari || (versionMajor >= 15 && versionMajor < 17)) webmVideoCodecs.push('vp9');
    }
    if (canPlayAv1()) {
        mp4VideoCodecs.push('av1');
        if (!b.safari || (versionMajor >= 15 && versionMajor < 17)) webmVideoCodecs.push('av1');
    }
    if ((!b.safari && canPlayVp8) || b.tizen) videoAudioCodecs.push('vorbis');
    if (webmVideoCodecs.length) directPlay.push({ Container: 'webm', Type: 'Video', VideoCodec: webmVideoCodecs.join(','), AudioCodec: webmAudioCodecs.join(',') });
    if (mp4VideoCodecs.length) directPlay.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: mp4VideoCodecs.join(','), AudioCodec: videoAudioCodecs.join(',') });
    if (canPlayMkv && mp4VideoCodecs.length) directPlay.push({ Container: 'mkv', Type: 'Video', VideoCodec: mp4VideoCodecs.join(','), AudioCodec: videoAudioCodecs.join(',') });
    // Containers no browser check covers (jellyfin-web's getDirectPlayProfileForVideoContainer).
    for (const container of ['m2ts', 'wmv', 'ts', 'asf', 'avi', 'mpg', 'mpeg', 'flv', '3gp', 'mts', 'trp', 'vob', 'vro', 'mov']) {
        let supported: unknown = false;
        let name = container;
        let audio = videoAudioCodecs;
        const codecs: string[] = [];
        if (container === 'asf' || container === 'wmv') { supported = b.tizen || b.web0s || b.edgeUwp; audio = []; } else if (['avi', 'mpg', 'mpeg', 'm2ts'].includes(container)) supported = b.tizen || b.web0s || b.edgeUwp;
        else if (['flv', '3gp', 'mts', 'trp', 'vob', 'vro'].includes(container)) supported = b.tizen;
        else if (container === 'mov') { supported = b.safari || b.tizen || b.web0s || b.chrome || b.edgeChromium || b.edgeUwp; codecs.push('h264'); } else if (container === 'ts') { supported = b.tizen || b.web0s || b.edgeUwp; codecs.push('h264'); if ((b.tizen || b.web0s) && canPlayHevc()) codecs.push('hevc'); name = 'ts,mpegts'; }
        if (container === 'm2ts' || container === 'ts') { if (container === 'm2ts') codecs.push('h264'); if (supportsVc1()) codecs.push('vc1'); if (supportsMpeg2Video()) codecs.push('mpeg2video'); }
        if (supported) directPlay.push({ Container: name, Type: 'Video', VideoCodec: codecs.join(','), AudioCodec: audio.join(',') });
    }
    const mp3InHls = supportsMp3InHls();
    for (const format of ['opus', 'mp3', 'mp2', 'aac', 'flac', 'alac', 'webma', 'wma', 'wav', 'ogg', 'oga'].filter(canPlayAudioFormat)) {
        if (format === 'mp3' && !mp3InHls) directPlay.push({ Container: 'ts', AudioCodec: 'mp3', Type: 'Audio' });
        if (format === 'flac' && flag(settings.app('alwaysRemuxFlac'), false)) directPlay.push({ Container: 'mp4', AudioCodec: 'flac', Type: 'Audio' });
        else if (format !== 'mp3' || !flag(settings.app('alwaysRemuxMp3'), false)) directPlay.push({ Container: format, Type: 'Audio' });
        if (format === 'opus' || format === 'webma') directPlay.push({ Container: 'webm', AudioCodec: format, Type: 'Audio' });
        if (format === 'aac' || format === 'alac') directPlay.push({ Container: 'm4a', AudioCodec: format, Type: 'Audio' }, { Container: 'm4b', AudioCodec: format, Type: 'Audio' });
    }
    if (safariSupportsOpus) directPlay.push({ Container: 'mp4', AudioCodec: 'opus', Type: 'Audio' });

    const breakOnNonKeyFrames = !!(b.iOS || b.osx || b.edge || !canPlayNativeHls());
    let fmp4Hls = flag(settings.user('preferFmp4HlsContainer'), !!(b.safari || b.firefox || b.chrome || b.edgeChromium));
    if ((b.safari || b.tizen || b.web0s) && !canPlayNativeHlsInFmp4()) fmp4Hls = false;
    if (b.firefox && versionMajor === 149) fmp4Hls = false;
    const minSegments = b.iOS || b.osx ? '2' : '1';
    const channels = physicalAudioChannels.toString();
    if (canPlayHls) transcoding.push({ Container: fmp4Hls ? 'mp4' : 'ts', Type: 'Audio', AudioCodec: 'aac', Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, EnableAudioVbrEncoding: !flag(settings.app('disableVbrAudio'), false) });
    for (const format of ['aac', 'mp3', 'opus', 'wav'].filter(canPlayAudioFormat)) transcoding.push({ Container: format, Type: 'Audio', AudioCodec: format, Context: 'Streaming', Protocol: 'http', MaxAudioChannels: channels });
    for (const format of ['opus', 'mp3', 'aac', 'wav'].filter(canPlayAudioFormat)) transcoding.push({ Container: format, Type: 'Audio', AudioCodec: format, Context: 'Static', Protocol: 'http', MaxAudioChannels: channels });
    if (canPlayHls && options.enableHls !== false) {
        const segmentLength = flag(settings.user('limitSegmentLength'), false) ? 1 : undefined;
        if (hlsInFmp4VideoCodecs.length && hlsInFmp4VideoAudioCodecs.length && fmp4Hls) {
            directPlay.push({ Container: 'hls', Type: 'Video', VideoCodec: hlsInFmp4VideoCodecs.join(','), AudioCodec: hlsInFmp4VideoAudioCodecs.join(',') });
            transcoding.push({ Container: 'mp4', Type: 'Video', AudioCodec: hlsInFmp4VideoAudioCodecs.join(','), VideoCodec: hlsInFmp4VideoCodecs.join(','), Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, SegmentLength: segmentLength });
        }
        if (hlsInTsVideoCodecs.length && hlsInTsVideoAudioCodecs.length) {
            directPlay.push({ Container: 'hls', Type: 'Video', VideoCodec: hlsInTsVideoCodecs.join(','), AudioCodec: hlsInTsVideoAudioCodecs.join(',') });
            transcoding.push({ Container: 'ts', Type: 'Video', AudioCodec: hlsInTsVideoAudioCodecs.join(','), VideoCodec: hlsInTsVideoCodecs.join(','), Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, SegmentLength: segmentLength });
        }
    }

    const cond = (Condition: string, Property: string, Value: string, IsRequired = false): ProfileCondition => ({ Condition, Property, Value, IsRequired });
    const aacConditions: ProfileCondition[] = [];
    if (!has('video/mp4; codecs="avc1.640029, mp4a.40.5"')) aacConditions.push({ Condition: 'NotEquals', Property: 'AudioProfile', Value: 'HE-AAC' });
    if (!supportsSecondaryAudio) aacConditions.push(cond('Equals', 'IsSecondaryAudio', 'false'));
    if (aacConditions.length) codecProfiles.push({ Type: 'VideoAudio', Codec: 'aac', Conditions: aacConditions });
    const audioConditions: ProfileCondition[] = [];
    const videoAudioConditions: ProfileCondition[] = [];
    if (allowedChannels > 0) { audioConditions.push(cond('LessThanEqual', 'AudioChannels', channels)); videoAudioConditions.push(cond('LessThanEqual', 'AudioChannels', channels)); }
    if (!supportsSecondaryAudio) videoAudioConditions.push(cond('Equals', 'IsSecondaryAudio', 'false'));
    if (audioConditions.length) codecProfiles.push({ Type: 'Audio', Conditions: audioConditions });
    if (videoAudioConditions.length) codecProfiles.push({ Type: 'VideoAudio', Conditions: videoAudioConditions });
    if (safariSupportsOpus) {
        const opus = [cond('LessThanEqual', 'AudioChannels', '2')];
        codecProfiles.push({ Type: 'VideoAudio', Codec: 'opus', Conditions: opus });
        const split: TranscodingProfile[] = [];
        for (const tp of transcoding) {
            if (tp.Type !== 'Video') continue;
            const codecs = tp.AudioCodec.split(',');
            if (!codecs.includes('opus')) continue;
            split.push({ ...tp, AudioCodec: 'opus', ApplyConditions: [...(tp.ApplyConditions || []), ...opus] });
            tp.AudioCodec = codecs.filter((c) => c !== 'opus').join(',');
        }
        transcoding.push(...split);
    }

    let maxH264Level = 42;
    let h264Profiles = 'high|main|baseline|constrained baseline';
    if (b.tizen || b.web0s || has('video/mp4; codecs="avc1.640833"')) maxH264Level = 51;
    if (has('video/mp4; codecs="avc1.640834"')) maxH264Level = 52;
    if (has('video/mp4; codecs="avc1.6e0033"') && !b.safari && !b.iOS && !b.web0s && !b.edge && !b.mobile && !b.tizen) h264Profiles += '|high 10';
    let maxHevcLevel = 120;
    let hevcProfiles = 'main';
    const hevc = (tag: string) => has(`video/mp4; codecs="hvc1.${tag}"`) || has(`video/mp4; codecs="hev1.${tag}"`);
    if (hevc('1.4.L123')) maxHevcLevel = 123;
    for (const [tag, level] of [['2.4.L123', 123], ['2.4.L153', 153], ['2.4.L183', 183], ['2.4.L186', 186]] as const) {
        if (hevc(tag)) { maxHevcLevel = level; hevcProfiles = 'main|main 10'; }
    }
    let maxAv1Level = 15;
    for (const level of [16, 17, 18, 19]) {
        if (has(`video/mp4; codecs="av01.0.${level}M.08"`) && has(`video/mp4; codecs="av01.0.${level}M.10"`)) maxAv1Level = level;
    }
    let hevcRanges = 'SDR';
    let vp9Ranges = 'SDR';
    let av1Ranges = 'SDR';
    const webOsWithoutDv = b.web0s && !supportsDolbyVision;
    if (webOsWithoutDv) hevcRanges += '|DOVIWithSDR';
    if (supportsHdr10) {
        // HDR10+ plays on every HDR10 device, without its dynamic metadata.
        hevcRanges += '|HDR10|HDR10Plus'; vp9Ranges += '|HDR10|HDR10Plus'; av1Ranges += '|HDR10|HDR10Plus';
        if (b.vidaa || webOsWithoutDv) {
            hevcRanges += '|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';
            av1Ranges += '|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';
        }
    }
    if (supportsHlg) {
        hevcRanges += '|HLG'; vp9Ranges += '|HLG'; av1Ranges += '|HLG';
        if (webOsWithoutDv) hevcRanges += '|DOVIWithHLG';
    }
    if (supportsDolbyVision) {
        const dv: number[] = [];
        if (b.xboxOne) dv.push(5, 8);
        else {
            if (has('video/mp4; codecs="dvh1.05.06"')) dv.push(5);
            if (has('video/mp4; codecs="dvh1.08.06"')) dv.push(8);
        }
        if (dv.includes(5)) hevcRanges += '|DOVI';
        if (dv.includes(8)) hevcRanges += '|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus';
        if (b.web0s) hevcRanges += '|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';
        if (has('video/mp4; codecs="dav1.10.06"')) {
            av1Ranges += '|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus';
            if (b.web0s) av1Ranges += '|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';
        }
    }
    const h264 = [cond('EqualsAny', 'VideoProfile', h264Profiles), cond('EqualsAny', 'VideoRangeType', 'SDR'), cond('LessThanEqual', 'VideoLevel', String(maxH264Level))];
    const hevcConds = [cond('EqualsAny', 'VideoProfile', hevcProfiles), cond('EqualsAny', 'VideoRangeType', hevcRanges), cond('LessThanEqual', 'VideoLevel', String(maxHevcLevel))];
    const vp9 = [cond('EqualsAny', 'VideoRangeType', vp9Ranges)];
    const av1 = [cond('EqualsAny', 'VideoProfile', 'main'), cond('EqualsAny', 'VideoRangeType', av1Ranges), cond('LessThanEqual', 'VideoLevel', String(maxAv1Level))];
    if (!supportsAnamorphic) for (const list of [h264, hevcConds, av1]) list.push(cond('NotEquals', 'IsAnamorphic', 'true'));
    if (!b.edgeUwp && !b.tizen && !b.web0s) for (const list of [h264, hevcConds]) list.push(cond('NotEquals', 'IsInterlaced', 'true'));
    if (maxVideoWidth) for (const list of [h264, hevcConds, av1]) list.push(cond('LessThanEqual', 'Width', String(maxVideoWidth)));
    const globalMaxVideoBitrate = String(options.globalMaxVideoBitrate || (b.ps4 ? 8000000 : '') || '');
    if (globalMaxVideoBitrate) for (const list of [h264, hevcConds, av1]) list.push(cond('LessThanEqual', 'VideoBitrate', globalMaxVideoBitrate, true));
    if (b.safari) hevcConds.push(cond('EqualsAny', 'VideoCodecTag', 'hvc1|dvh1', true), cond('LessThanEqual', 'VideoFramerate', '60', true));
    if (b.iOS && iOSVersion < 13) {
        for (const container of ['ts', 'mp4']) codecProfiles.push({ Type: 'Video', Codec: 'h264', Container: container, Conditions: [...h264.filter((c) => c.Property !== 'VideoLevel'), cond('LessThanEqual', 'VideoLevel', '42')] });
    }
    if (b.safari && flag(settings.app('enableHi10p'), false)) codecProfiles.push({ Type: 'Video', Container: 'hls', SubContainer: 'mp4', Codec: 'h264', Conditions: [cond('EqualsAny', 'VideoProfile', h264Profiles + '|high 10')] });
    codecProfiles.push({ Type: 'Video', Codec: 'h264', Conditions: h264 });
    codecProfiles.push({ Type: 'Video', Codec: 'hevc', Conditions: hevcConds });
    codecProfiles.push({ Type: 'Video', Codec: 'vp9', Conditions: vp9 });
    codecProfiles.push({ Type: 'Video', Codec: 'av1', Conditions: av1 });
    const globalVideo: ProfileCondition[] = [];
    if (globalMaxVideoBitrate) globalVideo.push({ Condition: 'LessThanEqual', Property: 'VideoBitrate', Value: globalMaxVideoBitrate });
    if (maxVideoWidth) globalVideo.push(cond('LessThanEqual', 'Width', String(maxVideoWidth)));
    if (globalVideo.length) codecProfiles.push({ Type: 'Video', Conditions: globalVideo });

    // Subtitles: external VTT, ASS/SSA (the web player renders them), PGS only when the user turned its rendering on.
    const burnIn = settings.app('subtitleburnin');
    const renderPgs = settings.app('subtitlerenderpgs') === 'true';
    if (burnIn !== 'all') {
        if (supportsTextTracks) subtitleProfiles.push({ Format: 'vtt', Method: 'External' });
        if (options.enableSsaRender !== false && !options.isRetry && burnIn !== 'allcomplexformats') subtitleProfiles.push({ Format: 'ass', Method: 'External' }, { Format: 'ssa', Method: 'External' });
        if (renderPgs && options.enablePgsRender !== false && !options.isRetry && burnIn !== 'allcomplexformats' && burnIn !== 'onlyimageformats' && supportsCanvas2D()) {
            subtitleProfiles.push({ Format: 'pgssub', Method: 'External' }, { Format: 'vobsub', Container: 'mks', Method: 'External' });
        }
    }
    return profile;
}

let speakers: number | null = null;
/** @returns The output's channel count (jellyfin-web's getSpeakerCount), -1 when unknown. */
function speakerCount(): number {
    if (speakers !== null) return speakers;
    speakers = -1;
    try {
        const Ctx = typeof window !== 'undefined' ? (window.AudioContext || profileWindow().webkitAudioContext) : null;
        if (Ctx) {
            const ctx = new Ctx();
            speakers = ctx.destination.maxChannelCount;
            ctx.close?.().catch?.(() => {});
        }
    } catch { /* unknown */ }
    return speakers;
}

/**
 * jellyfin-web's app host additions to any profile (components/apphost.js
 * getDeviceProfile): the maximum video width setting and the preferred
 * transcoding codecs.
 * @param b - browserFlags().
 * */
export function withHostSettings(settings: ProfileSettings, profile: DeviceProfile, b: BrowserFlags): DeviceProfile {
    const maxVideoWidth = parseInt(settings.app('maxVideoWidth') || '0', 10) || 0;
    let width = maxVideoWidth;
    if (maxVideoWidth < 0) {
        const host = typeof window !== 'undefined' ? profileWindow().NativeShell?.AppHost : null;
        let s: { width: number; height: number } | null = null;
        try { s = typeof host?.screen === 'function' ? host.screen() : (typeof screen !== 'undefined' && !b.tv ? { width: Math.floor(screen.width * (window.devicePixelRatio || 1)), height: Math.floor(screen.height * (window.devicePixelRatio || 1)) } : null); } catch { s = null; }
        width = s ? Math.max(s.width, s.height) : 0;
    }
    if (width) {
        const condition: ProfileCondition = { Condition: 'LessThanEqual', Property: 'Width', Value: width.toString(), IsRequired: false };
        if (flag(settings.app('limitSupportedVideoResolution'), false)) (profile.CodecProfiles ??= []).push({ Type: 'Video', Conditions: [condition] });
        for (const tp of profile.TranscodingProfiles || []) {
            if (tp.Type !== 'Video') continue;
            tp.Conditions = (tp.Conditions || []).filter((c) => c.Property !== 'Width');
            tp.Conditions.push(condition);
        }
    }
    for (const [setting, field] of [['preferredTranscodeVideoCodec', 'VideoCodec'], ['preferredTranscodeVideoAudioCodec', 'AudioCodec']] as const) {
        const preferred = settings.app(setting);
        if (!preferred) continue;
        for (const tp of profile.TranscodingProfiles || []) {
            const list = tp[field];
            if (tp.Type !== 'Video' || typeof list !== 'string') continue;
            const codecs = list.split(',');
            const i = codecs.indexOf(preferred);
            if (i !== -1) { codecs.splice(i, 1); codecs.unshift(preferred); tp[field] = codecs.join(','); }
        }
    }
    return profile;
}

/**
 * jellyfin-web's builder options for a video (apphost getBaseProfileOptions
 * with hls.js in use, as for every video on desktop Chromium and Firefox).
 * @param b - browserFlags().
 * */
export function baseOptions(b: BrowserFlags): ProfileOptions {
    const nativeHls = b.tizen || (() => { try { const v = document.createElement('video'); return can(v, 'application/x-mpegURL') || can(v, 'application/vnd.apple.mpegURL'); } catch { return false; } })();
    const hlsJs = typeof window !== 'undefined' && window.MediaSource != null && !b.iOS && !b.tizen && !b.web0s
        && (!nativeHls || b.android || b.chrome || b.edgeChromium || b.opera);
    const disableHlsVideoAudioCodecs: string[] = [];
    if (hlsJs) {
        if (b.edge) disableHlsVideoAudioCodecs.push('mp3');
        if (!b.edgeChromium) disableHlsVideoAudioCodecs.push('ac3', 'eac3');
        if (!(b.chrome || b.edgeChromium || b.firefox)) disableHlsVideoAudioCodecs.push('opus');
    }
    return { enableMkvProgressive: false, disableHlsVideoAudioCodecs };
}

