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
// The device profile: jellyfin-web keeps its own (browserDeviceProfile)
// inside its bundle with no public handle, so this module builds the same
// kind of profile from the same browser checks (canPlayType /
// MediaSource.isTypeSupported for the containers and codecs, the screen's
// dynamic range for HDR). A native shell's (window.NativeShell) own profile
// wins when it has one. JE.tagDirectPlay.setProfile() replaces it, for tests.
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
// profile, profileHash, setProfile, reset, stats, classify }.
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
    /** The bitrate the profile allows (jellyfin-web's ceiling for an unmeasured connection). */
    const MAX_BITRATE = 120000000;

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
     * Whether the browser can play a MIME type with codecs.
     * @param {HTMLVideoElement|null} video
     * @param {string} type
     * @returns {boolean}
     */
    function can(video, type) {
        try {
            if (video && video.canPlayType(type).replace(/no/, '')) return true;
            return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(type);
        } catch {
            return false;
        }
    }

    /**
     * This browser's device profile, built from the checks jellyfin-web's
     * browserDeviceProfile makes: direct-play containers and codecs, an HLS
     * H.264/AAC transcoding target, text and PGS subtitles delivered
     * externally, and the video ranges the screen shows.
     * @returns {Object}
     */
    function browserProfile() {
        const video = typeof document !== 'undefined' ? document.createElement('video') : null;
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        const ua = nav?.userAgent || '';
        const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) || !!nav?.userAgentData?.brands?.some?.((b) => /Chromium/.test(b.brand));
        const hdr = (() => {
            try { return typeof matchMedia === 'function' && (matchMedia('(dynamic-range: high)').matches || matchMedia('(video-dynamic-range: high)').matches); } catch { return false; }
        })();
        const videoCodecs = [];
        if (can(video, 'video/mp4; codecs="avc1.42E01E"')) videoCodecs.push('h264');
        if (can(video, 'video/mp4; codecs="hvc1.1.L120.90"') || can(video, 'video/mp4; codecs="hev1.1.L120.90"') || can(video, 'video/mp4; codecs="hvc1.1.0.L120.90"')) videoCodecs.push('hevc');
        if (can(video, 'video/mp4; codecs="av01.0.15M.10"')) videoCodecs.push('av1');
        if (can(video, 'video/webm; codecs="vp9"') || can(video, 'video/mp4; codecs="vp09.00.10.08"')) videoCodecs.push('vp9');
        const webmVideo = ['vp8', 'vp9', 'av1'].filter((c) => (c === 'vp8' ? can(video, 'video/webm; codecs="vp8"') : videoCodecs.includes(c)));
        // Every browser that plays H.264 plays AAC.
        const audioCodecs = ['aac'];
        if (can(video, 'audio/mpeg')) audioCodecs.push('mp3');
        if (can(video, 'audio/ogg; codecs="opus"') || can(video, 'audio/webm; codecs="opus"')) audioCodecs.push('opus');
        if (can(video, 'audio/flac') || can(video, 'audio/mp4; codecs="flac"')) audioCodecs.push('flac');
        if (can(video, 'audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
        if (can(video, 'audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');
        if (can(video, 'audio/mp4; codecs="alac"')) audioCodecs.push('alac');
        const vorbis = can(video, 'audio/ogg; codecs="vorbis"') || can(video, 'audio/webm; codecs="vorbis"');
        const mkv = can(video, 'video/x-matroska') || can(video, 'video/mkv') || chromium;
        const direct = [{ Container: 'mp4,m4v', Type: 'Video', VideoCodec: videoCodecs.join(','), AudioCodec: audioCodecs.join(',') }];
        if (mkv) direct.push({ Container: 'mkv', Type: 'Video', VideoCodec: [...new Set([...videoCodecs, ...webmVideo])].join(','), AudioCodec: [...audioCodecs, ...(vorbis ? ['vorbis'] : [])].join(',') });
        if (webmVideo.length) direct.push({ Container: 'webm', Type: 'Video', VideoCodec: webmVideo.join(','), AudioCodec: [...(audioCodecs.includes('opus') ? ['opus'] : []), ...(vorbis ? ['vorbis'] : [])].join(',') });
        direct.push({ Container: 'mp3', Type: 'Audio' }, { Container: 'aac,m4a', Type: 'Audio', AudioCodec: 'aac' });
        const ranges = hdr ? 'SDR|HDR10|HLG' : 'SDR';
        const range = { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: ranges, IsRequired: false };
        return {
            Name: 'Jellyfin Enhanced web direct-play check',
            MaxStreamingBitrate: MAX_BITRATE,
            MaxStaticBitrate: MAX_BITRATE,
            MusicStreamingTranscodingBitrate: 384000,
            DirectPlayProfiles: direct,
            TranscodingProfiles: [
                { Container: 'ts', Type: 'Video', AudioCodec: 'aac', VideoCodec: 'h264', Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true },
                { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
            ],
            ContainerProfiles: [],
            CodecProfiles: [
                { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false }, { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }, range] },
                { Type: 'Video', Codec: 'hevc', Conditions: [{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false }, range] },
                { Type: 'Video', Codec: 'av1', Conditions: [range] },
                { Type: 'Video', Codec: 'vp9', Conditions: [range] },
            ],
            SubtitleProfiles: ['vtt', 'ass', 'ssa', 'pgssub', 'sup'].map((Format) => ({ Format, Method: 'External' })),
            ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
        };
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

    /** @returns {{profile: Object, hash: string}} The profile in use and its hash. */
    function current() {
        if (override) return override;
        if (!built) {
            let profile = null;
            try {
                // A native shell (a desktop or TV wrapper) knows its own player.
                const shell = typeof window !== 'undefined' ? window.NativeShell?.AppHost : null;
                const native = typeof shell?.getDeviceProfile === 'function' ? shell.getDeviceProfile(null) : null;
                if (native && typeof native === 'object' && Array.isArray(native.DirectPlayProfiles)) profile = native;
            } catch { /* fall back to the browser's own checks */ }
            profile = profile || browserProfile();
            built = { profile, hash: hashOf(profile) };
        }
        return built;
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
        // Stored answers first: a request never goes out for an item the store already knows.
        if (primed && !primedSettled) { primed.then(() => { primedSettled = true; scheduleSlice(); }); return; }
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
        const { profile } = current();
        const userId = ApiClient.getCurrentUserId?.() || JE.session?.getUserId?.() || '';
        inFlight.add(key);
        counters.launched++;
        let value;
        try {
            const info = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`Items/${encodeURIComponent(job.id)}/PlaybackInfo`, { UserId: userId, StartTimeTicks: 0, IsPlayback: false, AutoOpenLiveStream: false, MaxStreamingBitrate: profile.MaxStreamingBitrate || MAX_BITRATE }),
                data: JSON.stringify({ UserId: userId, DeviceProfile: profile, MaxStreamingBitrate: profile.MaxStreamingBitrate || MAX_BITRATE, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true, AllowVideoStreamCopy: true, AllowAudioStreamCopy: true, IsPlayback: false, AutoOpenLiveStream: false }),
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
        /** @returns {string} Its hash (part of every cache key). */
        profileHash: () => current().hash,
        /**
         * Use this profile instead of the browser's (null: back to it). Tests
         * and the lab probe force a restrictive one; answers are kept per hash.
         * @param {Object|null} profile
         */
        setProfile(profile) {
            override = profile ? { profile, hash: hashOf(profile) } : null;
            primed = null;
        },
        /** @returns {Object} Slice and request counters. */
        stats: () => ({ ...counters, queued: queue.size, inFlight: inFlight.size, memory: memory.size }),
    };
})(window.JellyfinEnhanced);
