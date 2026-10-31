// /js/tags/tag-direct-play.js
// Direct-play warnings for the Status group (tags/statustags.js draws the
// badge): whether this browser would play an item directly, asked of
// Jellyfin's own negotiation, POST /Items/{id}/PlaybackInfo with this
// browser's device profile. Nothing is played or transcoded; the answer's
// first media source says SupportsDirectPlay, and when not, its
// TranscodeReasons (the tooltip: codec, container, bitrate…) and whether a
// remux (direct stream) would do ("Won't direct play") or a transcode is
// needed ("Transcode").
//
// The device profile: jellyfin-web 12.1 keeps its own (browserDeviceProfile)
// inside its bundle with no public handle, and the capabilities it registers
// with the server (/Sessions) carry no DeviceProfile, so this module ports
// that builder: the same canPlayType probes, browser rules and the user's
// local playback settings, then the app host's width and codec settings. A
// native shell's (window.NativeShell.AppHost) own profile wins, built with
// the ported builder as jellyfin-web hands it its own. Requests ask with the
// user's saved video quality for this network (the measured or chosen
// bitrate), which is part of the cache key. JE.tagDirectPlay.setProfile()
// replaces the profile, for tests.
//
// Lookups are lazy and budgeted like the Poster sampler
// (tags/tag-poster-colours.js): only cards on screen (an
// IntersectionObserver) are queued, launches happen in idle slices
// (requestIdleCallback, at most SLICE_LAUNCHES per slice while idle time
// lasts) with at most MAX_IN_FLIGHT requests at once, and answers are
// applied in one pass per slice. Answers are kept per item and profile hash
// for a day, in memory and in the tag cache store (IndexedDB, per server and
// user, capped); a failed lookup is retried after RETRY_MS. A user switch
// drops everything in flight.
//
// Public surface: JE.tagDirectPlay { track, untrack, peek, describe,
// profile, profileHash, bitrate, webProfile, setProfile, reset, stats,
// classify }.
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Direct play:';
    /** How long an answer is trusted (ms). */
    const TTL_MS = 24 * 60 * 60 * 1000;
    /** How soon a failed lookup is asked again (ms). */
    const RETRY_MS = 10 * 60 * 1000;
    /** Requests started per idle slice, and in flight at once. */
    const SLICE_LAUNCHES = 4;
    const MAX_IN_FLIGHT = 2;
    /** A slice starts another request only with this much idle time left (ms). */
    const STEP_MIN_MS = 4;
    /** A slice's budget without an idle deadline (no requestIdleCallback), in ms. */
    const SLICE_BUDGET_MS = 8;
    const MEMORY_CAP = 3000;
    const STORE_CAP = 2000;
    const PERSIST_DELAY_MS = 2000;
    /** jellyfin-web's profile ceiling (getMaxBitrate). */
    const DEFAULT_BITRATE = 120000000;

    /** TranscodeReasons → tooltip phrase key (and the media fact it names). */
    const REASONS = {
        ContainerNotSupported: ['status_tag_dp_reason_container', 'container'],
        VideoCodecNotSupported: ['status_tag_dp_reason_video_codec', 'video'],
        VideoCodecTagNotSupported: ['status_tag_dp_reason_video_codec', 'video'],
        AudioCodecNotSupported: ['status_tag_dp_reason_audio_codec', 'audio'],
        ContainerBitrateExceedsLimit: ['status_tag_dp_reason_bitrate'],
        VideoBitrateNotSupported: ['status_tag_dp_reason_bitrate'],
        AudioBitrateNotSupported: ['status_tag_dp_reason_bitrate'],
        SubtitleCodecNotSupported: ['status_tag_dp_reason_subtitles'],
        VideoRangeTypeNotSupported: ['status_tag_dp_reason_range'],
        VideoProfileNotSupported: ['status_tag_dp_reason_video_format'],
        VideoLevelNotSupported: ['status_tag_dp_reason_video_format'],
        VideoResolutionNotSupported: ['status_tag_dp_reason_video_format'],
        VideoBitDepthNotSupported: ['status_tag_dp_reason_video_format'],
        VideoFramerateNotSupported: ['status_tag_dp_reason_video_format'],
        RefFramesNotSupported: ['status_tag_dp_reason_video_format'],
        AnamorphicVideoNotSupported: ['status_tag_dp_reason_video_format'],
        InterlacedVideoNotSupported: ['status_tag_dp_reason_video_format'],
        AudioChannelsNotSupported: ['status_tag_dp_reason_audio_format'],
        AudioProfileNotSupported: ['status_tag_dp_reason_audio_format'],
        AudioSampleRateNotSupported: ['status_tag_dp_reason_audio_format'],
        AudioBitDepthNotSupported: ['status_tag_dp_reason_audio_format'],
        SecondaryAudioNotSupported: ['status_tag_dp_reason_audio_format'],
    };

    /**
     * @typedef {Object} DirectPlayResult
     * @property {boolean} directPlay - The first media source plays as it is.
     * @property {boolean} remux - Not direct play, but only the container is the problem (direct stream).
     * @property {string[]} reasons - Jellyfin's TranscodeReasons.
     * @property {string|null} container
     * @property {string|null} video - Video codec.
     * @property {string|null} audio - Audio codec of the default track.
     */

    /** @type {Map<string, {r: DirectPlayResult|null, t: number}>} `${hash}|${id}` → answer (null: failed) */
    const memory = new Map();
    /** @type {Map<string, {cards: Set<HTMLElement>, id: string}>} queued lookups by memory key */
    const queue = new Map();
    /** @type {Set<string>} memory keys in flight */
    const inFlight = new Set();
    /** @type {WeakMap<HTMLElement, {id: string, onResult: Function}>} tracked cards */
    const tracked = new WeakMap();
    /** @type {Set<HTMLElement>} tracked cards currently on screen */
    const visible = new Set();
    /** @type {Map<string, number>} answers waiting to be persisted (memory key → saved time), by scope */
    const unsaved = new Map();
    /** @type {Set<Function>} live passes to run after a slice applied answers */
    const pendingNotify = new Set();
    let observer = null;
    let sliceScheduled = false;
    let generation = 0;
    let persistTimer = 0;
    let retryTimer = 0;
    /** @type {Object|null} */
    let override = null;
    /** @type {{profile: Object, hash: string}|null} */
    let built = null;
    /** @type {{base: Object, bitrate: number, value: {profile: Object, bitrate: number, hash: string}}|null} */
    let rated = null;
    /** @type {Promise<void>|null} A native shell's profile still on its way. */
    let nativePending = null;
    /** @type {Promise<void>|null} */
    let primed = null;
    let primedKey = '';
    let primedSettled = false;
    let sessionHooked = false;
    const counters = { slices: 0, launched: 0, answered: 0, failed: 0, fromMemory: 0, maxSliceMs: 0 };

    /** @returns {string} `${serverId}:${userId}`, the tag cache store's scope. */
    function scope() {
        const server = JE.session?.getServerId?.() || (typeof ApiClient !== 'undefined' && ApiClient.serverId?.()) || '';
        const user = JE.session?.getUserId?.() || (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || '';
        return server && user ? `${server}:${user}` : '';
    }

    /**
     * The browser flags jellyfin-web 12.1's device profile reads (a port of
     * the matching part of its scripts/browser.js detectBrowser). TV
     * platform versions (Tizen, webOS) are not read: those clients are app
     * shells whose own profile wins (see current()).
     * @param {string} [userAgent]
     * @returns {Object<string, *>}
     */
    function browserFlags(userAgent) {
        const nav = typeof navigator !== 'undefined' ? navigator : {};
        const raw = userAgent ?? nav.userAgent ?? '';
        const ua = raw.toLowerCase().replace(/(motorola edge)/, '').trim();
        const match = /(edg)[ /]([\w.]+)/.exec(ua) || /(edga)[ /]([\w.]+)/.exec(ua) || /(edgios)[ /]([\w.]+)/.exec(ua)
            || /(edge)[ /]([\w.]+)/.exec(ua) || /(titanos)[ /]([\w.]+)/.exec(ua) || /(opera)[ /]([\w.]+)/.exec(ua)
            || /(opr)[ /]([\w.]+)/.exec(ua) || /(chrome)[ /]([\w.]+)/.exec(ua) || /(safari)[ /]([\w.]+)/.exec(ua)
            || /(firefox)[ /]([\w.]+)/.exec(ua) || (!ua.includes('compatible') && /(mozilla)(?:.*? rv:([\w.]+)|)/.exec(ua)) || [];
        const versionMatch = /(version)[ /]([\w.]+)/.exec(ua);
        let platform = (/(ipad)/.exec(ua) || /(iphone)/.exec(ua) || /(windows)/.exec(ua) || /(android)/.exec(ua) || /(titanos)/.exec(ua) || [])[0] || '';
        let name = match[1] || '';
        if (name === 'edge') platform = '';
        if (name === 'opr') name = 'opera';
        const version = (versionMatch && versionMatch.length > 2 ? versionMatch[2] : null) || match[2] || '0';
        const b = {};
        if (name) { b[name] = true; b.versionMajor = parseInt(version.split('.')[0], 10) || 0; }
        if (platform) b[platform] = true;
        b.edgeChromium = !!(b.edg || b.edga || b.edgios);
        if (!b.chrome && !b.edgeChromium && !b.edge && !b.opera && ua.includes('webkit')) b.safari = true;
        b.osx = ua.includes('mac os x');
        if (b.osx && !b.iphone && !b.ipod && !b.ipad && (nav.maxTouchPoints || 0) > 1) b.ipad = true;
        b.mobile = ['mobi', 'ipad', 'iphone', 'ipod', 'silk', 'gt-p1000', 'nexus 7', 'kindle fire', 'opera mini'].some((t) => ua.includes(t));
        b.ps4 = ua.includes('playstation 4');
        b.xboxOne = ua.includes('xbox');
        b.tizen = ua.includes('tizen') || (typeof window !== 'undefined' && window.tizen != null);
        b.vidaa = ua.includes('vidaa');
        b.web0s = ua.includes('netcast') || ua.includes('web0s');
        b.tv = b.ps4 || ua.includes('kepler') || b.xboxOne || (!ua.includes('oculusbrowser') && (ua.includes('tv') || ua.includes('samsungbrowser') || ua.includes('viera') || ua.includes('titanos') || b.web0s));
        b.edgeUwp = (b.edge || b.edgeChromium) && (ua.includes('msapphost') || ua.includes('webview'));
        if (b.web0s || b.tizen) { delete b.chrome; delete b.safari; }
        b.iOS = !!(b.ipad || b.iphone || b.ipod);
        if (b.iOS) {
            const os = /OS (\d+)_(\d+)_?(\d+)?/.exec(nav.appVersion || raw) || /Version\/(\d+)/.exec(nav.appVersion || raw);
            if (os) b.iOSVersion = parseInt(os[1], 10) + (parseInt(os[2] || '0', 10) / 10);
        }
        return b;
    }

    /** @param {string} name @returns {string|null} A jellyfin-web app setting (localStorage, unprefixed). */
    function appSetting(name) {
        try { return localStorage.getItem(name); } catch { return null; }
    }

    /** @param {string} name @returns {string|null} A jellyfin-web per-user local setting (`${userId}-${name}`). */
    function userSetting(name) {
        const user = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || JE.session?.getUserId?.() || '';
        return user ? appSetting(`${user}-${name}`) : null;
    }

    /** jellyfin-web's toBoolean: only "true"/"false" count. */
    function flag(value, fallback) {
        return value === 'true' ? true : value === 'false' ? false : fallback;
    }

    /**
     * Whether the browser can play a MIME type: `canPlayType` only, as
     * jellyfin-web's profile checks it.
     * @param {HTMLMediaElement|null} el
     * @param {string} type
     * @returns {boolean}
     */
    function can(el, type) {
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
     * @param {Object} [options] - jellyfin-web's profile builder options.
     * @param {Object} [b] - browserFlags().
     * @returns {Object}
     */
    function webProfile(options = {}, b = browserFlags()) {
        const doc = typeof document !== 'undefined' ? document : null;
        const v = doc ? doc.createElement('video') : null;
        const audioEl = doc ? doc.createElement('audio') : null;
        const has = (type) => can(v, type);

        const canPlayHevc = () => {
            if (b.tizen || b.xboxOne || b.web0s || options.supportsHevc) return true;
            if (b.ps4) return false;
            return has('video/mp4; codecs="hvc1.1.L120"') || has('video/mp4; codecs="hev1.1.L120"') || has('video/mp4; codecs="hvc1.1.0.L120"') || has('video/mp4; codecs="hev1.1.0.L120"');
        };
        const canPlayAv1 = () => (b.xboxOne ? false : has('video/mp4; codecs="av01.0.15M.08"') && has('video/mp4; codecs="av01.0.15M.10"'));
        const canPlayNativeHls = () => b.tizen || has('application/x-mpegURL') || has('application/vnd.apple.mpegURL');
        const canPlayHls = canPlayNativeHls() || (typeof window !== 'undefined' && window.MediaSource != null);
        const canPlayNativeHlsInFmp4 = () => (b.iOS && b.iOSVersion >= 11) || b.osx;
        const supportsAc3 = () => (b.edgeUwp || b.tizen || b.web0s ? true : b.iOS && b.iOSVersion < 11 ? false : has('audio/mp4; codecs="ac-3"'));
        const supportsEac3 = () => (b.tizen || b.web0s ? true : b.iOS && b.iOSVersion < 11 ? false : has('audio/mp4; codecs="ec-3"'));
        const canPlayDts = () => (has('video/mp4; codecs="dts-"') || has('video/mp4; codecs="dts+"') ? true : null);
        const supportsAc3InHls = () => (b.tizen || b.web0s ? true : has('application/x-mpegurl; codecs="avc1.42E01E, ac-3"') || has('application/vnd.apple.mpegURL; codecs="avc1.42E01E, ac-3"'));
        const supportsMp3InHls = () => has('application/x-mpegurl; codecs="avc1.64001E, mp4a.40.34"') || has('application/vnd.apple.mpegURL; codecs="avc1.64001E, mp4a.40.34"');
        const canPlayAudioFormat = (format) => {
            let type;
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
            || (b.safari && ((b.iOS && b.iOSVersion >= 11) || b.osx))
            || (b.edgeChromium && b.versionMajor >= 121)
            || (b.chrome && !b.mobile)
            || (b.firefox && b.osx && !b.iphone && !b.ipod && !b.ipad && b.versionMajor >= 100));
        const supportsHlg = options.supportsHlg ?? supportsHdr10;
        const supportsDolbyVision = options.supportsDolbyVision ?? !!(b.safari && ((b.iOS && b.iOSVersion >= 13) || b.osx));
        const supportsAnamorphic = !!(b.chrome || b.firefox || b.safari || b.edgeChromium || b.edgeUwp || b.iOS || b.android);
        const supportsTextTracks = b.tizen || (v ? v.textTracks != null : false);
        // Probed only when PGS rendering is on (the order of jellyfin-web's checks does not matter to the result).
        const supportsCanvas2D = () => { try { return !!doc?.createElement('canvas').getContext('2d'); } catch { return false; } };
        const supportsSecondaryAudio = !!(v && v.audioTracks) && !b.firefox;

        const allowedChannels = parseInt(userSetting('allowedAudioChannels') || '-1', 10);
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
        const safariSupportsOpus = !!b.safari && b.versionMajor >= 17 && can(audioEl, 'audio/x-caf; codecs="opus"');
        const webmAudioCodecs = ['vorbis'];
        const profile = { MaxStreamingBitrate: bitrateSetting, MaxStaticBitrate: 100000000, MusicStreamingTranscodingBitrate: Math.min(bitrateSetting, 384000), DirectPlayProfiles: [] };

        let videoAudioCodecs = [];
        let hlsInTsVideoAudioCodecs = [];
        let hlsInFmp4VideoAudioCodecs = [];
        const supportsMp3VideoAudio = has('video/mp4; codecs="avc1.640029, mp4a.69"') || has('video/mp4; codecs="avc1.640029, mp4a.6B"') || has('video/mp4; codecs="avc1.640029, mp3"');
        let supportsMp2VideoAudio = options.supportsMp2VideoAudio;
        if (supportsMp2VideoAudio == null) {
            supportsMp2VideoAudio = b.edgeUwp || b.tizen || b.web0s;
            if (supportsMp3VideoAudio && (b.chrome || b.edgeChromium || (b.firefox && b.versionMajor >= 83))) supportsMp2VideoAudio = true;
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
        let supportsDts = flag(appSetting('enableDts'), false) || options.supportsDts;
        if (supportsDts == null) supportsDts = canPlayDts();
        if (supportsDts) videoAudioCodecs.push('dca', 'dts');
        if (b.tizen || b.web0s) videoAudioCodecs.push('pcm_s16le', 'pcm_s24le');
        if (flag(appSetting('enableTrueHd'), false) || options.supportsTrueHd) videoAudioCodecs.push('truehd');
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

        const mp4VideoCodecs = [];
        const webmVideoCodecs = [];
        const hlsInTsVideoCodecs = [];
        const hlsInFmp4VideoCodecs = [];
        if (canPlayAv1() && (b.safari || b.tizen || b.web0s || (!b.mobile && (b.edgeChromium || b.firefox || b.chrome || b.opera)))) hlsInFmp4VideoCodecs.push('av1');
        if (canPlayHevc() && (b.edgeChromium || b.safari || b.tizen || b.web0s || (b.chrome && (!b.android || b.versionMajor >= 105)) || (b.opera && !b.mobile) || (b.firefox && b.versionMajor >= 134))) hlsInFmp4VideoCodecs.push('hevc');
        if (has('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) { mp4VideoCodecs.push('h264'); hlsInTsVideoCodecs.push('h264'); hlsInFmp4VideoCodecs.push('h264'); }
        if (canPlayHevc()) { mp4VideoCodecs.push('hevc'); if (b.tizen || b.web0s || b.vidaa) hlsInTsVideoCodecs.push('hevc'); }
        if (supportsMpeg2Video()) mp4VideoCodecs.push('mpeg2video');
        if (supportsVc1()) mp4VideoCodecs.push('vc1');
        if (b.tizen) mp4VideoCodecs.push('msmpeg4v2');
        if (canPlayVp8) webmVideoCodecs.push('vp8');
        if (canPlayVp9) {
            if (!b.iOS && !(b.firefox && b.osx)) mp4VideoCodecs.push('vp9');
            if (b.safari || b.edgeChromium || b.chrome || b.firefox) hlsInFmp4VideoCodecs.push('vp9');
            if (!b.safari || (b.versionMajor >= 15 && b.versionMajor < 17)) webmVideoCodecs.push('vp9');
        }
        if (canPlayAv1()) {
            mp4VideoCodecs.push('av1');
            if (!b.safari || (b.versionMajor >= 15 && b.versionMajor < 17)) webmVideoCodecs.push('av1');
        }
        if ((!b.safari && canPlayVp8) || b.tizen) videoAudioCodecs.push('vorbis');
        if (webmVideoCodecs.length) profile.DirectPlayProfiles.push({ Container: 'webm', Type: 'Video', VideoCodec: webmVideoCodecs.join(','), AudioCodec: webmAudioCodecs.join(',') });
        if (mp4VideoCodecs.length) profile.DirectPlayProfiles.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: mp4VideoCodecs.join(','), AudioCodec: videoAudioCodecs.join(',') });
        if (canPlayMkv && mp4VideoCodecs.length) profile.DirectPlayProfiles.push({ Container: 'mkv', Type: 'Video', VideoCodec: mp4VideoCodecs.join(','), AudioCodec: videoAudioCodecs.join(',') });
        // Containers no browser check covers (jellyfin-web's getDirectPlayProfileForVideoContainer).
        for (const container of ['m2ts', 'wmv', 'ts', 'asf', 'avi', 'mpg', 'mpeg', 'flv', '3gp', 'mts', 'trp', 'vob', 'vro', 'mov']) {
            let supported = false;
            let name = container;
            let audio = videoAudioCodecs;
            const codecs = [];
            if (container === 'asf' || container === 'wmv') { supported = b.tizen || b.web0s || b.edgeUwp; audio = []; } else if (['avi', 'mpg', 'mpeg', 'm2ts'].includes(container)) supported = b.tizen || b.web0s || b.edgeUwp;
            else if (['flv', '3gp', 'mts', 'trp', 'vob', 'vro'].includes(container)) supported = b.tizen;
            else if (container === 'mov') { supported = b.safari || b.tizen || b.web0s || b.chrome || b.edgeChromium || b.edgeUwp; codecs.push('h264'); } else if (container === 'ts') { supported = b.tizen || b.web0s || b.edgeUwp; codecs.push('h264'); if ((b.tizen || b.web0s) && canPlayHevc()) codecs.push('hevc'); name = 'ts,mpegts'; }
            if (container === 'm2ts' || container === 'ts') { if (container === 'm2ts') codecs.push('h264'); if (supportsVc1()) codecs.push('vc1'); if (supportsMpeg2Video()) codecs.push('mpeg2video'); }
            if (supported) profile.DirectPlayProfiles.push({ Container: name, Type: 'Video', VideoCodec: codecs.join(','), AudioCodec: audio.join(',') });
        }
        const mp3InHls = supportsMp3InHls();
        for (const format of ['opus', 'mp3', 'mp2', 'aac', 'flac', 'alac', 'webma', 'wma', 'wav', 'ogg', 'oga'].filter(canPlayAudioFormat)) {
            if (format === 'mp3' && !mp3InHls) profile.DirectPlayProfiles.push({ Container: 'ts', AudioCodec: 'mp3', Type: 'Audio' });
            if (format === 'flac' && flag(appSetting('alwaysRemuxFlac'), false)) profile.DirectPlayProfiles.push({ Container: 'mp4', AudioCodec: 'flac', Type: 'Audio' });
            else if (format !== 'mp3' || !flag(appSetting('alwaysRemuxMp3'), false)) profile.DirectPlayProfiles.push({ Container: format, Type: 'Audio' });
            if (format === 'opus' || format === 'webma') profile.DirectPlayProfiles.push({ Container: 'webm', AudioCodec: format, Type: 'Audio' });
            if (format === 'aac' || format === 'alac') profile.DirectPlayProfiles.push({ Container: 'm4a', AudioCodec: format, Type: 'Audio' }, { Container: 'm4b', AudioCodec: format, Type: 'Audio' });
        }
        if (safariSupportsOpus) profile.DirectPlayProfiles.push({ Container: 'mp4', AudioCodec: 'opus', Type: 'Audio' });

        profile.TranscodingProfiles = [];
        const breakOnNonKeyFrames = !!(b.iOS || b.osx || b.edge || !canPlayNativeHls());
        let fmp4Hls = flag(userSetting('preferFmp4HlsContainer'), !!(b.safari || b.firefox || b.chrome || b.edgeChromium));
        if ((b.safari || b.tizen || b.web0s) && !canPlayNativeHlsInFmp4()) fmp4Hls = false;
        if (b.firefox && b.versionMajor === 149) fmp4Hls = false;
        const minSegments = b.iOS || b.osx ? '2' : '1';
        const channels = physicalAudioChannels.toString();
        if (canPlayHls) profile.TranscodingProfiles.push({ Container: fmp4Hls ? 'mp4' : 'ts', Type: 'Audio', AudioCodec: 'aac', Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, EnableAudioVbrEncoding: !flag(appSetting('disableVbrAudio'), false) });
        for (const format of ['aac', 'mp3', 'opus', 'wav'].filter(canPlayAudioFormat)) profile.TranscodingProfiles.push({ Container: format, Type: 'Audio', AudioCodec: format, Context: 'Streaming', Protocol: 'http', MaxAudioChannels: channels });
        for (const format of ['opus', 'mp3', 'aac', 'wav'].filter(canPlayAudioFormat)) profile.TranscodingProfiles.push({ Container: format, Type: 'Audio', AudioCodec: format, Context: 'Static', Protocol: 'http', MaxAudioChannels: channels });
        if (canPlayHls && options.enableHls !== false) {
            const segmentLength = flag(userSetting('limitSegmentLength'), false) ? 1 : undefined;
            if (hlsInFmp4VideoCodecs.length && hlsInFmp4VideoAudioCodecs.length && fmp4Hls) {
                profile.DirectPlayProfiles.push({ Container: 'hls', Type: 'Video', VideoCodec: hlsInFmp4VideoCodecs.join(','), AudioCodec: hlsInFmp4VideoAudioCodecs.join(',') });
                profile.TranscodingProfiles.push({ Container: 'mp4', Type: 'Video', AudioCodec: hlsInFmp4VideoAudioCodecs.join(','), VideoCodec: hlsInFmp4VideoCodecs.join(','), Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, SegmentLength: segmentLength });
            }
            if (hlsInTsVideoCodecs.length && hlsInTsVideoAudioCodecs.length) {
                profile.DirectPlayProfiles.push({ Container: 'hls', Type: 'Video', VideoCodec: hlsInTsVideoCodecs.join(','), AudioCodec: hlsInTsVideoAudioCodecs.join(',') });
                profile.TranscodingProfiles.push({ Container: 'ts', Type: 'Video', AudioCodec: hlsInTsVideoAudioCodecs.join(','), VideoCodec: hlsInTsVideoCodecs.join(','), Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, SegmentLength: segmentLength });
            }
        }

        profile.ContainerProfiles = [];
        profile.CodecProfiles = [];
        const cond = (Condition, Property, Value, IsRequired = false) => ({ Condition, Property, Value, IsRequired });
        const aacConditions = [];
        if (!has('video/mp4; codecs="avc1.640029, mp4a.40.5"')) aacConditions.push({ Condition: 'NotEquals', Property: 'AudioProfile', Value: 'HE-AAC' });
        if (!supportsSecondaryAudio) aacConditions.push(cond('Equals', 'IsSecondaryAudio', 'false'));
        if (aacConditions.length) profile.CodecProfiles.push({ Type: 'VideoAudio', Codec: 'aac', Conditions: aacConditions });
        const audioConditions = [];
        const videoAudioConditions = [];
        if (allowedChannels > 0) { audioConditions.push(cond('LessThanEqual', 'AudioChannels', channels)); videoAudioConditions.push(cond('LessThanEqual', 'AudioChannels', channels)); }
        if (!supportsSecondaryAudio) videoAudioConditions.push(cond('Equals', 'IsSecondaryAudio', 'false'));
        if (audioConditions.length) profile.CodecProfiles.push({ Type: 'Audio', Conditions: audioConditions });
        if (videoAudioConditions.length) profile.CodecProfiles.push({ Type: 'VideoAudio', Conditions: videoAudioConditions });
        if (safariSupportsOpus) {
            const opus = [cond('LessThanEqual', 'AudioChannels', '2')];
            profile.CodecProfiles.push({ Type: 'VideoAudio', Codec: 'opus', Conditions: opus });
            const split = [];
            for (const tp of profile.TranscodingProfiles) {
                if (tp.Type !== 'Video') continue;
                const codecs = tp.AudioCodec.split(',');
                if (!codecs.includes('opus')) continue;
                split.push({ ...tp, AudioCodec: 'opus', ApplyConditions: [...(tp.ApplyConditions || []), ...opus] });
                tp.AudioCodec = codecs.filter((c) => c !== 'opus').join(',');
            }
            profile.TranscodingProfiles.push(...split);
        }

        let maxH264Level = 42;
        let h264Profiles = 'high|main|baseline|constrained baseline';
        if (b.tizen || b.web0s || has('video/mp4; codecs="avc1.640833"')) maxH264Level = 51;
        if (has('video/mp4; codecs="avc1.640834"')) maxH264Level = 52;
        if (has('video/mp4; codecs="avc1.6e0033"') && !b.safari && !b.iOS && !b.web0s && !b.edge && !b.mobile && !b.tizen) h264Profiles += '|high 10';
        let maxHevcLevel = 120;
        let hevcProfiles = 'main';
        const hevc = (tag) => has(`video/mp4; codecs="hvc1.${tag}"`) || has(`video/mp4; codecs="hev1.${tag}"`);
        if (hevc('1.4.L123')) maxHevcLevel = 123;
        for (const [tag, level] of [['2.4.L123', 123], ['2.4.L153', 153], ['2.4.L183', 183], ['2.4.L186', 186]]) {
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
            const dv = [];
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
        if (b.iOS && b.iOSVersion < 13) {
            for (const container of ['ts', 'mp4']) profile.CodecProfiles.push({ Type: 'Video', Codec: 'h264', Container: container, Conditions: [...h264.filter((c) => c.Property !== 'VideoLevel'), cond('LessThanEqual', 'VideoLevel', '42')] });
        }
        if (b.safari && flag(appSetting('enableHi10p'), false)) profile.CodecProfiles.push({ Type: 'Video', Container: 'hls', SubContainer: 'mp4', Codec: 'h264', Conditions: [cond('EqualsAny', 'VideoProfile', h264Profiles + '|high 10')] });
        profile.CodecProfiles.push({ Type: 'Video', Codec: 'h264', Conditions: h264 });
        profile.CodecProfiles.push({ Type: 'Video', Codec: 'hevc', Conditions: hevcConds });
        profile.CodecProfiles.push({ Type: 'Video', Codec: 'vp9', Conditions: vp9 });
        profile.CodecProfiles.push({ Type: 'Video', Codec: 'av1', Conditions: av1 });
        const globalVideo = [];
        if (globalMaxVideoBitrate) globalVideo.push({ Condition: 'LessThanEqual', Property: 'VideoBitrate', Value: globalMaxVideoBitrate });
        if (maxVideoWidth) globalVideo.push(cond('LessThanEqual', 'Width', String(maxVideoWidth)));
        if (globalVideo.length) profile.CodecProfiles.push({ Type: 'Video', Conditions: globalVideo });

        // Subtitles: external VTT, ASS/SSA (the web player renders them), PGS only when the user turned its rendering on.
        profile.SubtitleProfiles = [];
        const burnIn = appSetting('subtitleburnin');
        const renderPgs = appSetting('subtitlerenderpgs') === 'true';
        if (burnIn !== 'all') {
            if (supportsTextTracks) profile.SubtitleProfiles.push({ Format: 'vtt', Method: 'External' });
            if (options.enableSsaRender !== false && !options.isRetry && burnIn !== 'allcomplexformats') profile.SubtitleProfiles.push({ Format: 'ass', Method: 'External' }, { Format: 'ssa', Method: 'External' });
            if (renderPgs && options.enablePgsRender !== false && !options.isRetry && burnIn !== 'allcomplexformats' && burnIn !== 'onlyimageformats' && supportsCanvas2D()) {
                profile.SubtitleProfiles.push({ Format: 'pgssub', Method: 'External' }, { Format: 'vobsub', Container: 'mks', Method: 'External' });
            }
        }
        profile.ResponseProfiles = [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }];
        return profile;
    }

    let speakers = null;
    /** @returns {number} The output's channel count (jellyfin-web's getSpeakerCount), -1 when unknown. */
    function speakerCount() {
        if (speakers !== null) return speakers;
        speakers = -1;
        try {
            const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
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
     * @param {Object} profile
     * @param {Object} b - browserFlags().
     * @returns {Object}
     */
    function withHostSettings(profile, b) {
        const maxVideoWidth = parseInt(appSetting('maxVideoWidth') || '0', 10) || 0;
        let width = maxVideoWidth;
        if (maxVideoWidth < 0) {
            const host = typeof window !== 'undefined' ? window.NativeShell?.AppHost : null;
            let s = null;
            try { s = typeof host?.screen === 'function' ? host.screen() : (typeof screen !== 'undefined' && !b.tv ? { width: Math.floor(screen.width * (window.devicePixelRatio || 1)), height: Math.floor(screen.height * (window.devicePixelRatio || 1)) } : null); } catch { s = null; }
            width = s ? Math.max(s.width, s.height) : 0;
        }
        if (width) {
            const condition = { Condition: 'LessThanEqual', Property: 'Width', Value: width.toString(), IsRequired: false };
            if (flag(appSetting('limitSupportedVideoResolution'), false)) profile.CodecProfiles.push({ Type: 'Video', Conditions: [condition] });
            for (const tp of profile.TranscodingProfiles || []) {
                if (tp.Type !== 'Video') continue;
                tp.Conditions = (tp.Conditions || []).filter((c) => c.Property !== 'Width');
                tp.Conditions.push(condition);
            }
        }
        for (const [setting, field] of [['preferredTranscodeVideoCodec', 'VideoCodec'], ['preferredTranscodeVideoAudioCodec', 'AudioCodec']]) {
            const preferred = appSetting(setting);
            if (!preferred) continue;
            for (const tp of profile.TranscodingProfiles || []) {
                if (tp.Type !== 'Video' || typeof tp[field] !== 'string') continue;
                const codecs = tp[field].split(',');
                const i = codecs.indexOf(preferred);
                if (i !== -1) { codecs.splice(i, 1); codecs.unshift(preferred); tp[field] = codecs.join(','); }
            }
        }
        return profile;
    }

    /**
     * jellyfin-web's builder options for a video (apphost getBaseProfileOptions
     * with hls.js in use, as for every video on desktop Chromium and Firefox).
     * @param {Object} b - browserFlags().
     * @returns {Object}
     */
    function baseOptions(b) {
        const nativeHls = b.tizen || (() => { try { const v = document.createElement('video'); return can(v, 'application/x-mpegURL') || can(v, 'application/vnd.apple.mpegURL'); } catch { return false; } })();
        const hlsJs = typeof window !== 'undefined' && window.MediaSource != null && !b.iOS && !b.tizen && !b.web0s
            && (!nativeHls || b.android || b.chrome || b.edgeChromium || b.opera);
        const disableHlsVideoAudioCodecs = [];
        if (hlsJs) {
            if (b.edge) disableHlsVideoAudioCodecs.push('mp3');
            if (!b.edgeChromium) disableHlsVideoAudioCodecs.push('ac3', 'eac3');
            if (!(b.chrome || b.edgeChromium || b.firefox)) disableHlsVideoAudioCodecs.push('opus');
        }
        return { enableMkvProgressive: false, disableHlsVideoAudioCodecs };
    }

    /**
     * The video bitrate jellyfin-web would ask with (playbackmanager's saved
     * max streaming bitrate for this network): the user's chosen quality, or
     * the last automatic measurement; with automatic detection on and nothing
     * measured yet, the profile's ceiling (no bandwidth test is run here).
     * @param {Object} profile
     * @returns {number}
     */
    function userBitrate(profile) {
        let inNetwork;
        try { inNetwork = (typeof ApiClient !== 'undefined' && ApiClient.getSavedEndpointInfo?.()) || {}; } catch { inNetwork = {}; }
        const net = inNetwork.IsInNetwork;
        const saved = parseInt(appSetting(`maxbitrate-Video-${net}`) || '0', 10) || 0;
        if (saved > 0) return saved;
        return flag(appSetting(`enableautobitratebitrate-Video-${net}`), true) ? (profile.MaxStreamingBitrate || DEFAULT_BITRATE) : 1500000;
    }

    /**
     * A short stable hash of a profile (FNV-1a over its JSON), for cache keys.
     * @param {Object} profile
     * @returns {string}
     */
    function hashOf(profile) {
        const text = JSON.stringify(profile);
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
    }

    /** @param {*} p @returns {boolean} Whether a shell's answer looks like a device profile. */
    function isProfile(p) {
        return !!p && typeof p === 'object' && Array.isArray(p.DirectPlayProfiles);
    }

    /**
     * Build the profile once, as jellyfin-web's app host does: a native
     * shell's own (window.NativeShell.AppHost.getDeviceProfile, handed the
     * ported builder; it may answer later, and lookups wait for it), else the
     * ported browser profile; then the host's width and codec settings.
     * @returns {{profile: Object, hash: string}}
     */
    function build() {
        const b = browserFlags();
        const builder = (options) => webProfile(options || {}, b);
        let profile = null;
        try {
            const shell = typeof window !== 'undefined' ? window.NativeShell?.AppHost : null;
            const version = (typeof ApiClient !== 'undefined' && ApiClient.appVersion?.()) || '';
            const native = typeof shell?.getDeviceProfile === 'function' ? shell.getDeviceProfile(builder, version) : null;
            if (native && typeof native.then === 'function') {
                const pending = Promise.resolve(native).then((answer) => {
                    if (!isProfile(answer)) return;
                    const own = withHostSettings(JSON.parse(JSON.stringify(answer)), b);
                    built = { profile: own, hash: hashOf(own) };
                    primed = null;
                }, () => { /* keep the browser profile */ }).finally(() => {
                    if (nativePending === pending) nativePending = null;
                    scheduleSlice();
                });
                nativePending = pending;
            } else if (isProfile(native)) profile = JSON.parse(JSON.stringify(native));
        } catch { /* fall back to the browser profile */ }
        profile = withHostSettings(profile || builder(baseOptions(b)), b);
        built = { profile, hash: hashOf(profile) };
        return built;
    }

    /**
     * The profile in use, the bitrate asked with (userBitrate) and the hash of
     * both (part of every cache key, so a quality change asks again).
     * @returns {{profile: Object, bitrate: number, hash: string}}
     */
    function current() {
        const base = override || built || build();
        const bitrate = userBitrate(base.profile);
        if (!rated || rated.base !== base || rated.bitrate !== bitrate) {
            rated = { base, bitrate, value: { profile: base.profile, bitrate, hash: hashOf({ profile: base.hash, bitrate }) } };
        }
        return rated.value;
    }

    /**
     * Read a PlaybackInfo answer: its first media source, as the player would.
     * @param {*} info - PlaybackInfoResponse.
     * @returns {DirectPlayResult|null} Null when the answer has no media source.
     */
    function classify(info) {
        const source = Array.isArray(info?.MediaSources) ? info.MediaSources[0] : null;
        if (!source || typeof source !== 'object') return null;
        let reasons = Array.isArray(source.TranscodeReasons) ? source.TranscodeReasons.filter((r) => typeof r === 'string')
            : typeof source.TranscodeReasons === 'string' ? source.TranscodeReasons.split(/[,\s]+/).filter(Boolean) : [];
        if (!reasons.length && typeof source.TranscodingUrl === 'string') {
            const match = /[?&]TranscodeReasons=([^&]+)/i.exec(source.TranscodingUrl);
            if (match) reasons = decodeURIComponent(match[1]).split(',').filter(Boolean);
        }
        const streams = Array.isArray(source.MediaStreams) ? source.MediaStreams : [];
        const video = streams.find((s) => s?.Type === 'Video');
        const audio = streams.find((s) => s?.Type === 'Audio' && s.Index === source.DefaultAudioStreamIndex) || streams.find((s) => s?.Type === 'Audio');
        const directPlay = source.SupportsDirectPlay === true;
        const containerOnly = reasons.length > 0 && reasons.every((r) => r === 'ContainerNotSupported');
        return {
            directPlay,
            remux: !directPlay && (containerOnly || (reasons.length === 0 && source.SupportsDirectStream === true)),
            reasons: [...new Set(reasons)].slice(0, 12),
            container: typeof source.Container === 'string' ? source.Container : null,
            video: typeof video?.Codec === 'string' ? video.Codec : null,
            audio: typeof audio?.Codec === 'string' ? audio.Codec : null,
        };
    }

    /**
     * The tooltip: the badge label and why ("video codec hevc, container mkv").
     * @param {DirectPlayResult} result
     * @param {string} label
     * @returns {string}
     */
    function describe(result, label) {
        const parts = [];
        for (const reason of result.reasons) {
            const [key, fact] = REASONS[reason] || ['status_tag_dp_reason_other'];
            const text = JE.t(key, { value: (fact && result[fact]) || '' }).trim();
            if (text && !parts.includes(text)) parts.push(text);
        }
        return parts.length ? `${label}: ${parts.join(', ')}` : label;
    }

    /**
     * Load this scope's stored answers for the current profile into memory
     * once. Never rejects.
     * @returns {Promise<void>}
     */
    function prime() {
        const s = scope();
        const { hash } = current();
        const key = `${s}|${hash}`;
        if (primed && primedKey === key) return primed;
        primedKey = key;
        primedSettled = false;
        const gen = generation;
        const store = JE.tagCacheStore;
        // Without a store there is nothing to wait for before the first request.
        primedSettled = !s || !store?.available?.() || typeof store.getDirectPlay !== 'function';
        primed = (async () => {
            if (primedSettled) return;
            try {
                const stored = await store.getDirectPlay(s, hash);
                if (gen !== generation || primedKey !== key) return;
                const now = Date.now();
                let loaded = 0;
                for (const [id, value] of stored) {
                    const memoryKey = `${hash}|${id}`;
                    if (!memory.has(memoryKey) && value && now - value.t < TTL_MS) { memory.set(memoryKey, value); loaded++; }
                }
                // Cards drawn before the stored answers arrived: one pass, and no request for those.
                if (!loaded) return;
                for (const card of visible) {
                    const entry = tracked.get(card);
                    if (!entry) continue;
                    const memoryKey = `${hash}|${entry.id}`;
                    if (memory.has(memoryKey) && !inFlight.has(memoryKey)) { queue.delete(memoryKey); pendingNotify.add(entry.onResult); }
                }
                scheduleSlice();
            } catch { /* the store marks itself unavailable */ }
        })();
        return primed;
    }

    /** Write the answers of the last few seconds (debounced) under the scope they were asked in. */
    function persistSoon() {
        if (persistTimer) return;
        const gen = generation;
        persistTimer = setTimeout(() => {
            persistTimer = 0;
            const batch = new Map(unsaved);
            unsaved.clear();
            const store = JE.tagCacheStore;
            const s = scope();
            if (gen !== generation || !s || !store?.available?.() || typeof store.putDirectPlay !== 'function') return;
            const byHash = new Map();
            for (const [memoryKey] of batch) {
                const value = memory.get(memoryKey);
                if (!value || value.r === null) continue;
                const [hash, id] = memoryKey.split('|');
                if (!byHash.has(hash)) byHash.set(hash, new Map());
                byHash.get(hash).set(id, value);
            }
            for (const [hash, values] of byHash) store.putDirectPlay(s, hash, values, STORE_CAP).catch(() => { /* marked unavailable */ });
        }, PERSIST_DELAY_MS);
    }

    /**
     * Remember an answer (oldest first out past the cap).
     * @param {string} key
     * @param {{r: DirectPlayResult|null, t: number}} value
     */
    function remember(key, value) {
        memory.delete(key);
        memory.set(key, value);
        if (memory.size > MEMORY_CAP) memory.delete(memory.keys().next().value);
    }

    /**
     * A fresh answer for an item under the current profile, or null.
     * @param {string} itemId
     * @returns {DirectPlayResult|null}
     */
    function peek(itemId) {
        const value = memory.get(`${current().hash}|${itemId}`);
        if (!value || value.r === null || Date.now() - value.t >= TTL_MS) return null;
        return value.r;
    }

    /** @param {string} key @returns {boolean} Whether a memory key needs asking (unknown, expired, or a failure due a retry). */
    function due(key) {
        const value = memory.get(key);
        if (!value) return true;
        return Date.now() - value.t >= (value.r === null ? RETRY_MS : TTL_MS);
    }

    /** @returns {IntersectionObserver|null} The shared on-screen watcher. */
    function watcher() {
        if (observer || typeof IntersectionObserver === 'undefined') return observer;
        const own = new IntersectionObserver((entries) => {
            if (observer !== own) return;
            for (const { target, isIntersecting } of entries) {
                const card = /** @type {HTMLElement} */ (target);
                if (!tracked.has(card) || !card.isConnected) { untrack(card); continue; }
                if (isIntersecting) { visible.add(card); enqueue(card); } else visible.delete(card);
            }
            scheduleSlice();
        }, { rootMargin: '200px 0px' });
        observer = own;
        return observer;
    }

    /**
     * Queue a visible card's item when its answer is due.
     * @param {HTMLElement} card
     */
    function enqueue(card) {
        const entry = tracked.get(card);
        if (!entry) return;
        const key = `${current().hash}|${entry.id}`;
        if (inFlight.has(key)) { queue.get(key)?.cards.add(card); return; }
        if (!due(key)) { counters.fromMemory++; return; }
        const job = queue.get(key) || { id: entry.id, cards: new Set() };
        job.cards.add(card);
        queue.set(key, job);
    }

    /**
     * Watch a card that may get a warning; its item is asked about once it is
     * on screen. `onResult` runs (batched per slice) when an answer lands.
     * @param {HTMLElement} card
     * @param {string} itemId
     * @param {Function} onResult
     */
    function track(card, itemId, onResult) {
        hookSession();
        const previous = tracked.get(card);
        tracked.set(card, { id: itemId, onResult });
        prime();
        // Drawn again (an expired answer, another profile): ask again if it is due.
        if (previous && previous.id === itemId) {
            if (visible.has(card)) { enqueue(card); scheduleSlice(); }
            return;
        }
        if (previous) visible.delete(card);
        const io = watcher();
        if (io) io.observe(card);
        else { visible.add(card); enqueue(card); scheduleSlice(); }
    }

    /** @param {HTMLElement} card Stop watching a card (recycled, removed, or showing another badge). */
    function untrack(card) {
        if (!tracked.has(card)) return;
        tracked.delete(card);
        visible.delete(card);
        observer?.unobserve(card);
        for (const [key, job] of queue) {
            job.cards.delete(card);
            if (!job.cards.size) queue.delete(key);
        }
    }

    /** Run a slice when the browser is idle (soon, at the latest). */
    function scheduleSlice() {
        if (sliceScheduled) return;
        sliceScheduled = true;
        if (typeof requestIdleCallback === 'function') requestIdleCallback(runSlice, { timeout: 1000 });
        else setTimeout(runSlice, 16);
    }

    /**
     * One idle slice: the live passes for answers that landed since the last
     * one (one per renderer), then launches for queued items still on screen
     * while idle time and request slots last (one at least when the slice
     * ran late).
     * @param {IdleDeadline} [deadline]
     */
    function runSlice(deadline) {
        sliceScheduled = false;
        const started = performance.now();
        const left = typeof deadline?.timeRemaining === 'function'
            ? () => deadline.timeRemaining()
            : () => SLICE_BUDGET_MS - (performance.now() - started);
        const late = !deadline || !!deadline.didTimeout;
        // The shell's own profile first (its settling schedules the next slice).
        if (nativePending) return;
        // Stored answers first: a request never goes out for an item the store already knows.
        prime();
        if (primed && !primedSettled) { primed.then(() => { primedSettled = true; scheduleSlice(); }); return; }
        // Queued under another profile or bitrate (it changed since): queue them under this one.
        const hash = current().hash;
        for (const [key, job] of [...queue]) {
            if (key.startsWith(`${hash}|`)) continue;
            queue.delete(key);
            for (const card of job.cards) enqueue(card);
        }
        const notify = [...pendingNotify];
        pendingNotify.clear();
        for (const fn of notify) {
            try { fn(); } catch (e) { console.warn(`${logPrefix} A badge pass failed.`, e); }
        }
        let launched = 0;
        for (const [key, job] of queue) {
            if (inFlight.size >= MAX_IN_FLIGHT || launched >= SLICE_LAUNCHES) break;
            if (!(left() >= STEP_MIN_MS || (late && launched === 0))) break;
            queue.delete(key);
            for (const card of [...job.cards]) if (!card.isConnected || !visible.has(card) || tracked.get(card)?.id !== job.id) job.cards.delete(card);
            if (!job.cards.size) continue;
            launched++;
            launch(key, job);
        }
        counters.slices++;
        counters.maxSliceMs = Math.max(counters.maxSliceMs, performance.now() - started);
        if (pendingNotify.size || (queue.size && inFlight.size < MAX_IN_FLIGHT)) scheduleSlice();
    }

    /**
     * Ask Jellyfin about one item (in a slice); the answer is applied by the
     * next slice. An answer for an earlier session is dropped.
     * @param {string} key
     * @param {{id: string, cards: Set<HTMLElement>}} job
     */
    async function launch(key, job) {
        if (typeof ApiClient === 'undefined') return;
        const gen = generation;
        const { profile, bitrate } = current();
        const userId = ApiClient.getCurrentUserId?.() || JE.session?.getUserId?.() || '';
        inFlight.add(key);
        counters.launched++;
        let value;
        try {
            const info = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`Items/${encodeURIComponent(job.id)}/PlaybackInfo`, { UserId: userId, StartTimeTicks: 0, IsPlayback: false, AutoOpenLiveStream: false, MaxStreamingBitrate: bitrate }),
                data: JSON.stringify({ UserId: userId, DeviceProfile: profile, MaxStreamingBitrate: bitrate, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true, AllowVideoStreamCopy: true, AllowAudioStreamCopy: true, IsPlayback: false, AutoOpenLiveStream: false }),
                contentType: 'application/json',
                dataType: 'json',
            });
            value = { r: classify(info), t: Date.now() };
            counters.answered++;
        } catch (e) {
            value = { r: null, t: Date.now() };
            counters.failed++;
        } finally {
            inFlight.delete(key);
        }
        if (gen !== generation) return;
        remember(key, value);
        if (value.r) { unsaved.set(key, value.t); persistSoon(); } else armRetry();
        for (const card of job.cards) {
            const entry = tracked.get(card);
            if (entry && entry.id === job.id) pendingNotify.add(entry.onResult);
        }
        scheduleSlice();
    }

    /** One timer re-queues visible cards whose lookup failed, once the retry delay has passed. */
    function armRetry() {
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = 0;
            for (const card of visible) enqueue(card);
            scheduleSlice();
        }, RETRY_MS);
    }

    /** Forget every card and in-flight answer (a user switch, a renderer teardown). Answers stay. */
    function reset() {
        generation++;
        for (const card of [...visible]) untrack(card);
        visible.clear();
        queue.clear();
        inFlight.clear();
        pendingNotify.clear();
        observer?.disconnect();
        observer = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = 0;
    }

    /** Register the session hook once: another user's answers are never shown or stored. */
    function hookSession() {
        if (sessionHooked) return;
        sessionHooked = true;
        JE.session?.onUserChange?.('direct-play', () => {
            reset();
            memory.clear();
            unsaved.clear();
            primed = null;
            primedKey = '';
        });
    }

    JE.tagDirectPlay = {
        track,
        untrack,
        peek,
        describe,
        classify,
        reset,
        /** @returns {Object} The device profile in use. */
        profile: () => current().profile,
        /** @returns {string} The hash of the profile and bitrate (part of every cache key). */
        profileHash: () => current().hash,
        /** @returns {number} The bitrate lookups ask with. */
        bitrate: () => current().bitrate,
        /**
         * The ported jellyfin-web builder for a user agent (tests compare it
         * with the real client's profile).
         * @param {Object} [options]
         * @param {string} [userAgent]
         * @returns {Object}
         */
        webProfile: (options, userAgent) => webProfile(options, browserFlags(userAgent)),
        /**
         * Use this profile instead of the browser's (null: back to it). Tests
         * and the lab probe force a restrictive one; answers are kept per hash.
         * @param {Object|null} profile
         */
        setProfile(profile) {
            override = profile ? { profile, hash: hashOf(profile) } : null;
            if (!profile) built = null;
            primed = null;
        },
        /** @returns {Object} Slice and request counters. */
        stats: () => ({ ...counters, queued: queue.size, inFlight: inFlight.size, memory: memory.size }),
    };
})(window.JellyfinEnhanced);
