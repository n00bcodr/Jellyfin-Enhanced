import { apiClient, hasApiClient, type TagRuntimeBridge } from '../../host';
import { isRecord, own, record, records, stringList, type JsonRecord } from '../../pipeline/dto';
import type { DirectPlayResult } from '../../pipeline/contract';
import { createCardWatch } from './card-watch';
import { askPlaybackInfo, REASONS } from './playback-request';
import { baseOptions, browserFlags, flag, profileWindow, webProfile, withHostSettings, type DeviceProfile, type ProfileOptions } from './device-profile';

/** One remembered answer: result (null when the lookup failed), its time, and the media it was asked about. */
interface Answer { r: DirectPlayResult | null; t: number; m?: string }
interface LookupKey { id: string; source?: string }
interface LookupJob extends LookupKey { cards: Set<HTMLElement>; media: string; source: string; prior?: Answer | undefined }
interface TrackedCard extends LookupKey { onResult: (itemIds: Set<string>) => void; media: string; source: string }
interface BuiltProfile { profile: DeviceProfile; hash: string; reads: string[]; settings: string }
interface BaseProfile { profile: DeviceProfile; hash: string }
interface RatedProfile { profile: DeviceProfile; bitrate: number; hash: string }
type TimedError = Error & { timedOut: true };
function isTimedOut(error: unknown): error is TimedError { return isRecord(error) && error.timedOut === true; }
/** A stored answer in the shape the lookups read, whatever older versions wrote. */
function storedResult(value: JsonRecord): DirectPlayResult {
    return {
        directPlay: value.directPlay === true,
        remux: value.remux === true,
        reasons: stringList(value.reasons),
        container: typeof value.container === 'string' ? value.container : null,
        video: typeof value.video === 'string' ? value.video : null,
        audio: typeof value.audio === 'string' ? value.audio : null,
    };
}
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
// bitrate), which is part of the cache key. The profile is rebuilt when the
// user or any setting it read changes (checked at most once per task), so a
// user switch or a playback setting changed in this page asks with the new
// one; answers stay keyed by profile hash. JE.tagDirectPlay.setProfile()
// replaces the profile, for tests.
//
// Lookups are lazy and budgeted like the Poster sampler
// (tags/tag-poster-colours.js): only cards on screen (an
// IntersectionObserver) are queued, launches happen in idle slices
// (requestIdleCallback, at most SLICE_LAUNCHES per slice while idle time
// lasts) with at most MAX_IN_FLIGHT requests at once, and answers are
// applied in one pass per slice. Answers are kept per item and profile hash
// for a day, in memory and in the tag cache store (IndexedDB, per server and
// user, capped); a failed lookup is retried after RETRY_MS. Each request
// has a deadline (DEADLINE_MS, the answer's body included): past it the
// request is aborted, its slot frees once the abort settles it, and the item
// counts as failed. A user switch (or any reset) drops every answer in
// flight; their requests keep their slots until they settle or are aborted,
// so a reset never raises the two-request cap.
//
// Public surface: JE.tagDirectPlay { track, untrack, peek, describe,
// profile, profileHash, bitrate, webProfile, setProfile, reset, stats,
// classify }.
export function createDirectPlay(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced: Direct play:';
    /** How long an answer is trusted (ms). */
    const TTL_MS = 24 * 60 * 60 * 1000;
    /** How soon a failed lookup is asked again (ms). */
    const RETRY_MS = 10 * 60 * 1000;
    /** How long a PlaybackInfo request may take, answer read included, before it is aborted (ms). */
    const DEADLINE_MS = 15 * 1000;
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


    // `${hash}|${id}` → answer (null: failed).
    const memory = new Map<string, Answer>();
    // Queued lookups by memory key.
    const queue = new Map<string, LookupJob>();
    // This session's lookups in flight, by memory key (their jobs).
    const inFlight = new Map<string, LookupJob>();
    /**
     * Every request still on the network, this session's or an earlier one's:
     * a reset forgets lookups but leaves their requests running, so their
     * slots stay taken until they settle or their deadline aborts them
     * (MAX_IN_FLIGHT counts these).
     * 
     */
    const network = new Set<object>();
    /**
     * tracked cards.
     * Replaced wholesale by reset(): a card off screen at that moment is not in
     * `visible`, so only a fresh map guarantees its next track() registers it
     * with the new observer instead of taking the same-item shortcut.
     */
    let tracked = new WeakMap<HTMLElement, TrackedCard>();
    /** tracked cards currently on screen */
    const visible: Set<HTMLElement> = new Set();
    /** answers waiting to be persisted (memory key → saved time), by scope */
    const unsaved: Map<string, number> = new Map();
    /** live passes to run after a slice applied answers, each with the items answered */
    const pendingNotify = new Map<(itemIds: Set<string>) => void, Set<string>>();
    /** Which tracked cards are under the observer, and the released ones (card-watch.ts). */
    const cards = createCardWatch<TrackedCard>({
        entry: card => tracked.get(card), visible, watcher: () => watcher(), observer: () => observer,
        answeredAt: entry => settledAnswer(entry)?.t ?? null, ttlMs: TTL_MS, untrack: card => untrack(card),
    });
    /** The hash current() last answered with: a change lapses every released card's answer. */
    let ratedHash = '';
    /** Whether memory may hold a failed lookup (none since the last user: nothing to retry, see nextRetryAt). */
    let failedSeen = false;
    let observer: IntersectionObserver | null = null;
    let sliceScheduled = false;
    let generation = 0;
    let persistTimer: ReturnType<typeof setTimeout> | 0 = 0;
    let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;
    /** When the retry timer fires (ms since the epoch), or 0. */
    let retryAt = 0;
    let override: BaseProfile | null = null;
    /**
     * The built profile, the settings its build read and the values it read
     * them with, with the user's id (a change rebuilds it).
     * 
     */
    let built: BuiltProfile | null = null;
    /**
     * The profile generation: each build starts one, and a user change or a
     * changed setting ends it at once (rebuild). A native shell's late answer
     * applies only to the generation it was asked in.
     */
    let builds = 0;
    /** Setting names and values read while a build runs. */
    let reading: Map<string, string|null>|null = null;
    /** The settings were compared in this task already (see settingsChanged). */
    let settingsChecked = false;
    let rated: { base: BaseProfile; bitrate: number; value: RatedProfile } | null = null;
    /** A native shell's profile still on its way. */
    let nativePending: Promise<void>|null = null;
    let primed: Promise<void>|null = null;
    let primedKey = '';
    let primedSettled = false;
    let sessionHooked = false;
    const counters = { slices: 0, launched: 0, answered: 0, failed: 0, timedOut: 0, fromMemory: 0, maxSliceMs: 0 };

    /**
     * Every fact a direct-play answer depends on, version by version: a version's own facts, then each of its
     * streams'. The server's MediaSourceInfo.Revision hashes exactly these (TagCacheService.DirectPlaySourceFields
     * and DirectPlayStreamFields, kept equal by tests/fixtures/direct-play-inputs.json); a card without that
     * revision (an item read through /tag-data) fingerprints the same list from the facts it holds.
     */
    const INPUTS = Object.freeze({
        source: Object.freeze(['Id', 'Path', 'Container', 'Size', 'Bitrate', 'RunTimeTicks', 'Video3DFormat', 'Protocol', 'Timestamp', 'DefaultAudioStreamIndex']),
        stream: Object.freeze(['Index', 'Type', 'Codec', 'CodecTag', 'Profile', 'Level', 'BitDepth', 'BitRate', 'Width', 'Height', 'IsInterlaced',
            'RealFrameRate', 'AverageFrameRate', 'Channels', 'ChannelLayout', 'SampleRate', 'VideoRangeType', 'ColorTransfer', 'PixelFormat',
            'Language', 'IsDefault', 'IsForced', 'IsExternal', 'IsAnamorphic', 'RefFrames', 'PacketLength', 'IsAVC', 'Rotation', 'NalLengthSize',
            'DvProfile', 'DvLevel', 'DvBlSignalCompatibilityId', 'BlPresentFlag', 'ElPresentFlag', 'RpuPresentFlag', 'Hdr10PlusPresentFlag',
            'ColorPrimaries', 'ColorSpace', 'ColorRange', 'IsHearingImpaired', 'Path']),
    });

    /**
     * An item's key in memory and the store: its id, plus the version asked about when the user picked one
     * (an answer for one version is no answer for another).
     * */
    function itemKey(entry: LookupKey): string {
        return entry.source ? `${entry.id}@${entry.source}` : entry.id;
    }

    /** @returns `${serverId}:${userId}`, the tag cache store's scope. */
    function scope(): string {
        const server = JE.session?.getServerId?.() || (hasApiClient() && apiClient().serverId?.()) || '';
        const user = JE.session?.getUserId?.() || (hasApiClient() && apiClient().getCurrentUserId?.()) || '';
        return server && user ? `${server}:${user}` : '';
    }

    /** @param name @returns A local setting's value now (not recorded). */
    function storedSetting(name: string): string|null {
        try { return localStorage.getItem(name); } catch { return null; }
    }

    /** @param name @returns A jellyfin-web app setting (localStorage, unprefixed). */
    function appSetting(name: string): string|null {
        const value = storedSetting(name);
        if (reading && !reading.has(name)) reading.set(name, value);
        return value;
    }

    /** @returns The signed-in user's id, as jellyfin-web prefixes its per-user settings. */
    function currentUser(): string {
        return (hasApiClient() && apiClient().getCurrentUserId?.()) || JE.session?.getUserId?.() || '';
    }

    const profileSettings = { app: appSetting, user: userSetting };

    /** @param name @returns A jellyfin-web per-user local setting (`${userId}-${name}`). */
    function userSetting(name: string): string|null {
        const user = currentUser();
        return user ? appSetting(`${user}-${name}`) : null;
    }

    /**
     * A user and setting values as one string (a build's inputs).
     * */
    function inputsOf(user: string, values: Map<string, string|null>): string {
        let text = user;
        for (const [name, value] of values) text += `\n${name}=${value}`;
        return text;
    }

    /**
     * The same for the signed-in user and these settings' values now.
     * */
    function settingsOf(names: Iterable<string>): string {
        const values = new Map();
        for (const name of names) values.set(name, storedSetting(name));
        return inputsOf(currentUser(), values);
    }

    /**
     * The video bitrate jellyfin-web would ask with (playbackmanager's saved
     * max streaming bitrate for this network): the user's chosen quality, or
     * the last automatic measurement; with automatic detection on and nothing
     * measured yet, the profile's ceiling (no bandwidth test is run here).
     * */
    function userBitrate(profile: DeviceProfile): number {
        let inNetwork: unknown = {};
        try { inNetwork = (hasApiClient() && apiClient().getSavedEndpointInfo?.()) || {}; } catch { inNetwork = {}; }
        const net = String(record(inNetwork).IsInNetwork);
        const saved = parseInt(appSetting(`maxbitrate-Video-${net}`) || '0', 10) || 0;
        if (saved > 0) return saved;
        return flag(appSetting(`enableautobitratebitrate-Video-${net}`), true) ? (profile.MaxStreamingBitrate || DEFAULT_BITRATE) : 1500000;
    }

    /**
     * A short stable hash of a profile (FNV-1a over its JSON), for cache keys.
     * */
    function hashOf(profile: unknown): string {
        const text = JSON.stringify(profile);
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
    }

    /** @param p @returns Whether a shell's answer looks like a device profile. */
    /** A profile owned here: a shell may keep and change its own object. */
    function clone(profile: DeviceProfile): DeviceProfile {
        const copy: unknown = JSON.parse(JSON.stringify(profile));
        return isProfile(copy) ? copy : profile;
    }

    function isProfile(p: unknown): p is DeviceProfile {
        return isRecord(p) && Array.isArray(p.DirectPlayProfiles);
    }

    /**
     * Build the profile once, as jellyfin-web's app host does: a native
     * shell's own (window.NativeShell.AppHost.getDeviceProfile, handed the
     * ported builder; it may answer later, and lookups wait for it), else the
     * ported browser profile; then the host's width and codec settings. The
     * user and the settings read on the way are recorded with the values read
     * (inputsOf). A late answer applies only while its generation is current
     * and those inputs still hold; otherwise the profile is built again.
     * */
    function build(): BuiltProfile {
        const b = browserFlags();
        const own = ++builds;
        const user = currentUser();
        const reads = new Map<string, string | null>();
        const recording = <T>(fn: () => T): T => {
            const outer = reading;
            reading = reads;
            try { return fn(); } finally { reading = outer; }
        };
        const builder = (options?: ProfileOptions) => recording(() => webProfile(profileSettings, options || {}, b));
        const finish = (profile: DeviceProfile): BuiltProfile => ({ profile, hash: hashOf(profile), reads: [...reads.keys()], settings: inputsOf(user, reads) });
        let profile: DeviceProfile | null = null;
        try {
            const shell = typeof window !== 'undefined' ? profileWindow().NativeShell?.AppHost : null;
            const version = (hasApiClient() && apiClient().appVersion?.()) || '';
            const native = typeof shell?.getDeviceProfile === 'function' ? shell.getDeviceProfile(builder, version) : null;
            if (isRecord(native) && typeof native.then === 'function') {
                const pending = Promise.resolve(native).then((answer: unknown) => {
                    // The user or a setting changed since: that ended this generation (rebuild).
                    if (!isProfile(answer) || own !== builds) return;
                    const profile = recording(() => withHostSettings(profileSettings, clone(answer), b));
                    // A change no lookup has noticed yet: the answer was built from old inputs.
                    if (settingsOf(reads.keys()) !== inputsOf(user, reads)) { rebuild(); return; }
                    built = finish(profile);
                    primed = null;
                }, () => { /* keep the browser profile */ }).finally(() => {
                    if (nativePending === pending) nativePending = null;
                    scheduleSlice();
                });
                nativePending = pending;
            } else if (isProfile(native)) profile = clone(native);
        } catch { /* fall back to the browser profile */ }
        const final = finish(recording(() => withHostSettings(profileSettings, profile || webProfile(profileSettings, baseOptions(b), b), b)));
        built = final;
        return final;
    }

    /**
     * Whether the user or a setting the built profile read has changed since
     * it was built (compared once per task: cards ask for the profile often).
     * */
    function settingsChanged(): boolean {
        if (!built || settingsChecked) return false;
        settingsChecked = true;
        queueMicrotask(() => { settingsChecked = false; });
        return settingsOf(built.reads) !== built.settings;
    }

    /**
     * End the profile generation and drop the built profile so the next
     * lookup builds it again (a native answer still on its way is ignored and
     * no longer holds lookups back), with the answers in memory under the hash
     * in use (persisted answers stay keyed by their hash and are simply not
     * read under the new one).
     */
    function rebuild() {
        builds++;
        nativePending = null;
        const hash = rated?.value.hash;
        if (hash) for (const key of [...memory.keys()]) if (key.startsWith(`${hash}|`)) memory.delete(key);
        built = null;
        rated = null;
        primed = null;
        primedKey = '';
        // Their answers went with the hash (and stay gone should the next build hash the same).
        cards.rewatchSettled();
    }

    /**
     * The profile in use, the bitrate asked with (userBitrate) and the hash of
     * both (part of every cache key, so a quality change asks again).
     * */
    function current(): RatedProfile {
        if (!override && settingsChanged()) rebuild();
        const base: BaseProfile = override || built || build();
        const bitrate = userBitrate(base.profile);
        if (rated?.base === base && rated.bitrate === bitrate) return rated.value;
        const value = { profile: base.profile, bitrate, hash: hashOf({ profile: base.hash, bitrate }) };
        rated = { base, bitrate, value };
        // Another profile or bitrate: the released cards have no answer under it.
        const changed = ratedHash !== '' && ratedHash !== value.hash;
        ratedHash = value.hash;
        if (changed) cards.rewatchSettled();
        return value;
    }

    /**
     * Read a PlaybackInfo answer: the version asked about, else its first media source, as the player would.
     * @param info - PlaybackInfoResponse.
     * @param [sourceId] - The MediaSourceId the request named.
     * @returns Null when the answer has no media source.
     */
    function classify(info: unknown, sourceId: string = ''): DirectPlayResult|null {
        const answers = record(info).MediaSources;
        const sources = Array.isArray(answers) ? answers : [];
        // The version asked about (MediaSourceId), else the first: the one Jellyfin would play.
        const source: unknown = (sourceId && records(sources).find((s) => s.Id === sourceId)) || sources[0] || null;
        if (!isRecord(source)) return null;
        let reasons = Array.isArray(source.TranscodeReasons) ? stringList(source.TranscodeReasons)
            : typeof source.TranscodeReasons === 'string' ? source.TranscodeReasons.split(/[,\s]+/).filter(Boolean) : [];
        if (!reasons.length && typeof source.TranscodingUrl === 'string') {
            const match = /[?&]TranscodeReasons=([^&]+)/i.exec(source.TranscodingUrl);
            if (match?.[1]) reasons = decodeURIComponent(match[1]).split(',').filter(Boolean);
        }
        const streams = records(source.MediaStreams);
        const video = streams.find((s) => s.Type === 'Video');
        const audio = streams.find((s) => s.Type === 'Audio' && s.Index === source.DefaultAudioStreamIndex) || streams.find((s) => s.Type === 'Audio');
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
     * */
    function describe(result: DirectPlayResult, label: string): string {
        const parts: string[] = [];
        for (const reason of result.reasons) {
            const [key, fact] = own(REASONS, reason) || ['status_tag_dp_reason_other'];
            const text = JE.t(key, { value: (fact && result[fact]) || '' }).trim();
            if (text && !parts.includes(text)) parts.push(text);
        }
        return parts.length ? `${label}: ${parts.join(', ')}` : label;
    }

    /**
     * Load this scope's stored answers for the current profile into memory
     * once. Never rejects.
     * */
    function prime(): Promise<void> {
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
        const loading = (async () => {
            if (primedSettled || !store) return;
            try {
                const stored = await store.getDirectPlay(s, hash);
                if (gen !== generation || primedKey !== key) return;
                const now = Date.now();
                /** The items the store answered (a version's key is `${id}@${source}`). */
                const loaded: string[] = [];
                for (const [id, value] of stored) {
                    const memoryKey = `${hash}|${id}`;
                    if (!memory.has(memoryKey) && value && now - value.t < TTL_MS) {
                        const answer: Answer = { r: storedResult(value.r), t: value.t, ...(typeof value.m === 'string' ? { m: value.m } : {}) };
                        memory.set(memoryKey, answer);
                        if (answer.r === null) failedSeen = true;
                        loaded.push(String(id).split('@')[0] ?? '');
                    }
                }
                // Cards drawn before the stored answers arrived (watched, and on screen: without WeakRef none is watched).
                if (!loaded.length) return;
                for (const card of new Set([...cards.watchedCards(), ...visible])) {
                    const entry = tracked.get(card);
                    if (!entry) continue;
                    const memoryKey = `${hash}|${itemKey(entry)}`;
                    const known = memory.get(memoryKey);
                    if (!known || inFlight.has(memoryKey) || !sameMedia(known, entry.media)) continue;
                    // The pass covers every restored item: cards off screen are drawn from memory too.
                    if (visible.has(card)) { queue.delete(memoryKey); notifySoon(entry, loaded); }
                    // Answered, on screen or not: nothing left to watch it for.
                    cards.settle(card);
                }
                scheduleSlice();
            } catch { /* the store marks itself unavailable */ }
        })();
        primed = loading;
        return loading;
    }

    /** Have the next slice tell a card's renderer its item (and `more`) was answered: one call per slice, every item since the last. */
    function notifySoon(entry: TrackedCard, more?: readonly string[]): void {
        let ids = pendingNotify.get(entry.onResult);
        if (!ids) pendingNotify.set(entry.onResult, ids = new Set());
        ids.add(entry.id);
        if (more) for (const id of more) ids.add(id);
    }

    /** Write the answers of the last few seconds (debounced) under the scope they were asked in. */
    function persistSoon() {
        if (persistTimer) return;
        const gen = generation;
        persistTimer = setTimeout(() => {
            persistTimer = 0;
            // Armed before a reset: this session's answers wait for their own timer instead of being dropped.
            if (gen !== generation) {
                if (unsaved.size) persistSoon();
                return;
            }
            const batch = new Map(unsaved);
            unsaved.clear();
            const store = JE.tagCacheStore;
            const s = scope();
            if (!s || !store?.available?.() || typeof store.putDirectPlay !== 'function') return;
            const byHash = new Map<string, Map<string, Answer>>();
            for (const [memoryKey] of batch) {
                const value = memory.get(memoryKey);
                if (!value || value.r === null) continue;
                const [hash = '', id = ''] = memoryKey.split('|');
                const answers = byHash.get(hash) ?? new Map<string, Answer>();
                answers.set(id, value);
                byHash.set(hash, answers);
            }
            for (const [hash, values] of byHash) store.putDirectPlay(s, hash, values, STORE_CAP).catch(() => { /* marked unavailable */ });
        }, PERSIST_DELAY_MS);
    }

    /**
     * Remember an answer (oldest first out past the cap).
     */
    function remember(key: string, value: Answer): void {
        memory.delete(key);
        memory.set(key, value);
        if (value.r === null) failedSeen = true;
        if (memory.size > MEMORY_CAP) {
            const [oldest] = memory.keys();
            if (oldest !== undefined) memory.delete(oldest);
            // It may have been a released card's answer.
            if (cards.anySettled()) cards.armSettled(Date.now());
        }
    }

    /**
     * A fresh answer for an item under the current profile and its current media, or null.
     * @param [media] - The item's media fingerprint (an answer for other media is no answer); omitted, any.
     * @param [source] - The version asked about ('' for the default one).
     * */
    function peek(itemId: string, media?: string, source: string = ''): DirectPlayResult|null {
        const value = memory.get(`${current().hash}|${itemKey({ id: itemId, source })}`);
        if (!value || value.r === null || !sameMedia(value, media) || Date.now() - value.t >= TTL_MS) return null;
        return value.r;
    }

    /**
     * Whether an answer was given for these media. A caller that names no media accepts any; an answer
     * stored before fingerprints existed is asked again for known media.
     * */
    function sameMedia(value: {m?: string}, media: string|undefined): boolean {
        return media === undefined || value.m === media;
    }

    /**
     * @returns Whether a memory key needs asking (unknown, other media, expired, or a failure due a retry).
     */
    function due(key: string, media?: string): boolean {
        const value = memory.get(key);
        if (!value || !sameMedia(value, media)) return true;
        return Date.now() - value.t >= (value.r === null ? RETRY_MS : TTL_MS);
    }

    /** A card's fresh answer under the profile in use, none on the network: nothing to ask while it lasts (a failure is retried). */
    function settledAnswer(entry: TrackedCard): Answer | null {
        const key = `${current().hash}|${itemKey(entry)}`;
        if (inFlight.has(key)) return null;
        const value = memory.get(key);
        return value && value.r !== null && sameMedia(value, entry.media || '') && Date.now() - value.t < TTL_MS ? value : null;
    }

    /** @returns The shared on-screen watcher. */
    function watcher(): IntersectionObserver|null {
        if (observer || typeof IntersectionObserver === 'undefined') return observer;
        const own = new IntersectionObserver((entries) => {
            if (observer !== own) return;
            for (const { target, isIntersecting } of entries) {
                if (!(target instanceof HTMLElement)) continue;
                const card = target;
                if (!tracked.has(card) || !card.isConnected) { untrack(card); continue; }
                // A report queued before the card was released.
                if (cards.isSettled(card)) continue;
                const whereOnly = cards.takeRewatched(card);
                if (isIntersecting) { visible.add(card); if (!whereOnly) enqueue(card); }
                else { visible.delete(card); cards.settle(card); }
            }
            // A slice only when there is something to ask or tell (most reports are of cards already waiting).
            if (queue.size || pendingNotify.size) scheduleSlice();
            // A failed lookup scrolled back before it is due waits for the timer.
            armRetry();
        }, { rootMargin: '200px 0px' });
        observer = own;
        return observer;
    }

    /**
     * Queue a visible card's item when its answer is due.
     */
    function enqueue(card: HTMLElement) {
        const entry = tracked.get(card);
        if (!entry) return;
        const key = `${current().hash}|${itemKey(entry)}`;
        const media = entry.media || '';
        // A request for these media already on the network answers this card too.
        const running = inFlight.get(key);
        if (running && running.media === media) { running.cards.add(card); return; }
        if (!inFlight.has(key) && !due(key, media)) { counters.fromMemory++; cards.settle(card); return; }
        const job: LookupJob = queue.get(key) || { id: entry.id, source: entry.source || '', cards: new Set(), media };
        job.media = media;
        job.cards.add(card);
        queue.set(key, job);
    }

    /**
     * Watch a card that may get a warning; its item is asked about once it is
     * on screen. `onResult` runs (batched per slice) when an answer lands, with the ids of the
     * items answered (as given here), so its pass can leave every other card alone.
     * @param [media] - The item's media fingerprint: an answer for other media is asked again.
     * @param [source] - The version the card stands for (the user's pick, see qualitytags.js); '' for
     *   the default one Jellyfin plays.
     */
    function track(card: HTMLElement, itemId: string, onResult: (itemIds: Set<string>) => void, media: string = '', source: string = ''): void {
        hookSession();
        const previous = tracked.get(card);
        const entry: TrackedCard = { id: itemId, onResult, media, source };
        tracked.set(card, entry);
        listen(true);
        prime();
        // A released card drawn again: watched once more unless what it shows now is answered too.
        if (cards.isSettled(card)) {
            if (!settledAnswer(entry)) cards.rewatch(card, false);
            return;
        }
        // Drawn again (an expired answer, another profile, changed media): ask again if it is due.
        if (previous && previous.id === itemId && (previous.source || '') === source) {
            // Watched again a moment ago and not reported yet: that report asks, as this draw would have.
            if (cards.takeRewatched(card)) return;
            if (visible.has(card)) { enqueue(card); scheduleSlice(); }
            return;
        }
        if (previous) visible.delete(card);
        if (!watcher()) { visible.add(card); enqueue(card); scheduleSlice(); return; }
        // Already answered (a page drawn again within the day): never watched at all.
        if (!cards.settle(card)) cards.watch(card);
    }

    /** @param card Stop watching a card (recycled, removed, or showing another badge). */
    function untrack(card: HTMLElement) {
        if (!tracked.has(card)) return;
        tracked.delete(card);
        visible.delete(card);
        cards.forget(card);
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
        else setTimeout(() => runSlice(), 16);
    }

    /**
     * One idle slice: the live passes for answers that landed since the last
     * one (one per renderer), then launches for queued items still on screen
     * while idle time and request slots last (one at least when the slice
     * ran late).
     */
    function runSlice(deadline?: IdleDeadline): void {
        sliceScheduled = false;
        const started = performance.now();
        const left = typeof deadline?.timeRemaining === 'function'
            ? () => deadline.timeRemaining()
            : () => SLICE_BUDGET_MS - (performance.now() - started);
        const late = !deadline || !!deadline.didTimeout;
        // The shell's own profile first (its settling schedules the next slice),
        // built again now if the user or a setting changed.
        current();
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
        for (const [fn, ids] of notify) {
            try { fn(ids); } catch (e) { console.warn(`${logPrefix} A badge pass failed.`, e); }
        }
        let launched = 0;
        for (const [key, job] of queue) {
            if (network.size >= MAX_IN_FLIGHT || launched >= SLICE_LAUNCHES) break;
            if (!(left() >= STEP_MIN_MS || (late && launched === 0))) break;
            queue.delete(key);
            for (const card of [...job.cards]) {
                const entry = tracked.get(card);
                if (!card.isConnected || !visible.has(card) || !entry || itemKey(entry) !== itemKey(job)) job.cards.delete(card);
            }
            if (!job.cards.size) continue;
            launched++;
            launch(key, job);
        }
        counters.slices++;
        counters.maxSliceMs = Math.max(counters.maxSliceMs, performance.now() - started);
        if (pendingNotify.size || (queue.size && network.size < MAX_IN_FLIGHT)) scheduleSlice();
    }

    /**
     * Ask Jellyfin about one item (in a slice); the answer is applied by the
     * next slice. An answer for an earlier session is dropped, but its
     * request holds a slot until it settles (or its deadline aborts it), and
     * its end never touches a later session's lookup of the same item.
     */
    async function launch(key: string, job: LookupJob): Promise<void> {
        if (!hasApiClient()) return;
        const gen = generation;
        const { profile, bitrate } = current();
        const userId = apiClient().getCurrentUserId?.() || JE.session?.getUserId?.() || '';
        const request = {};
        // The answer known when this request left: one stored meanwhile for other media is newer.
        job.prior = memory.get(key);
        inFlight.set(key, job);
        network.add(request);
        counters.launched++;
        let value: Answer;
        try {
            const info = await askPlaybackInfo(DEADLINE_MS,
                apiClient().getUrl(`Items/${encodeURIComponent(job.id)}/PlaybackInfo`, { UserId: userId, StartTimeTicks: 0, IsPlayback: false, AutoOpenLiveStream: false, MaxStreamingBitrate: bitrate, ...(job.source ? { MediaSourceId: job.source } : {}) }),
                JSON.stringify({ UserId: userId, DeviceProfile: profile, MaxStreamingBitrate: bitrate, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true, AllowVideoStreamCopy: true, AllowAudioStreamCopy: true, IsPlayback: false, AutoOpenLiveStream: false, ...(job.source ? { MediaSourceId: job.source } : {}) }),
            );
            value = { r: classify(info, job.source), t: Date.now(), m: job.media || '' };
            counters.answered++;
        } catch (e) {
            // A failure, a stalled request included, is asked again after RETRY_MS.
            value = { r: null, t: Date.now(), m: job.media || '' };
            counters.failed++;
            if (isTimedOut(e)) counters.timedOut++;
        } finally {
            network.delete(request);
            if (gen === generation && inFlight.get(key) === job) inFlight.delete(key);
        }
        // A freed slot: queued lookups (of this session) may go now.
        if (gen !== generation) { if (queue.size) scheduleSlice(); return; }
        // An answer for media since replaced never overwrites the answer for the new media.
        const newer = memory.get(key);
        const running = inFlight.get(key);
        const superseded = (running !== undefined && (running.media || '') !== (job.media || ''))
            || (newer !== undefined && newer !== job.prior && (newer.m || '') !== (job.media || ''));
        if (superseded) { scheduleSlice(); return; }
        remember(key, value);
        if (value.r) { unsaved.set(key, value.t); persistSoon(); }
        armRetry();
        for (const card of job.cards) {
            const entry = tracked.get(card);
            if (entry && itemKey(entry) === itemKey(job)) { notifySoon(entry); cards.settle(card); }
        }
        scheduleSlice();
    }

    /**
     * When the earliest failed lookup of a visible card is due again (ms
     * since the epoch), or 0 when none is waiting. Lookups already queued or
     * on the network are left out; successful answers never count.
     * */
    function nextRetryAt(): number {
        if (!failedSeen) return 0;
        const { hash } = current();
        let earliest = 0;
        for (const card of visible) {
            const entry = tracked.get(card);
            if (!entry) continue;
            const key = `${hash}|${itemKey(entry)}`;
            const value = memory.get(key);
            if (!value || value.r !== null || inFlight.has(key) || queue.has(key)) continue;
            const at = value.t + RETRY_MS;
            if (!earliest || at < earliest) earliest = at;
        }
        return earliest;
    }

    /**
     * One timer re-queues visible cards whose lookup failed, at the time the
     * earliest of them is due again; each pass and each answer arms it again
     * for the failures not due yet.
     */
    function armRetry() {
        const at = nextRetryAt();
        if (retryTimer && at === retryAt) return;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = 0;
        retryAt = at;
        if (!at) return;
        retryTimer = setTimeout(() => {
            retryTimer = 0;
            retryAt = 0;
            for (const card of visible) enqueue(card);
            scheduleSlice();
            armRetry();
        }, Math.max(0, at - Date.now()));
    }

    /**
     * Forget every card and in-flight answer (a user switch, a renderer
     * teardown). Answers stay; requests still on the network keep their slots
     * until they settle or their deadline aborts them.
     */
    function reset() {
        generation++;
        for (const card of [...visible]) untrack(card);
        visible.clear();
        cards.reset();
        listen(false);
        tracked = new WeakMap();
        queue.clear();
        inFlight.clear();
        pendingNotify.clear();
        observer?.disconnect();
        observer = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = 0;
        retryAt = 0;
    }

    /** Register the session hook once: another user's answers are never shown or stored. */
    function hookSession() {
        if (sessionHooked) return;
        sessionHooked = true;
        JE.session?.onUserChange?.('direct-play', () => {
            reset();
            memory.clear();
            failedSeen = false;
            unsaved.clear();
            // The next user's profile: built again once their id is in place
            // (the hook may run before it is; the build records the user).
            rebuild();
        });
        JE.core?.navigation?.onNavigate?.(lookAgain);
    }
    // Released cards have no observer: look at the profile and bitrate again when the page changes, the tab comes
    // back or the network does, while cards are tracked (current() rewatches them when the hash changed).
    const lookAgain = () => { if (cards.busy() || visible.size) current(); };
    const onVisible = () => { if (document.visibilityState === 'visible') lookAgain(); };
    let listening = false;
    function listen(on: boolean): void {
        if (listening === on) return; listening = on;
        if (on) { document.addEventListener('visibilitychange', onVisible); window.addEventListener('online', lookAgain); }
        else { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', lookAgain); }
    }

    const api = {
        INPUTS,
        track,
        untrack,
        peek,
        describe,
        classify,
        reset,
        /** @returns The device profile in use. */
        profile: (): DeviceProfile => current().profile,
        /** @returns The hash of the profile and bitrate (part of every cache key). */
        profileHash: (): string => current().hash,
        /** @returns The bitrate lookups ask with. */
        bitrate: (): number => current().bitrate,
        /**
         * The ported jellyfin-web builder for a user agent (tests compare it
         * with the real client's profile).
         * */
        webProfile: (options?: ProfileOptions, userAgent?: string) => webProfile(profileSettings, options, browserFlags(userAgent)),
        /**
         * Use this profile instead of the browser's (null: back to it). Tests
         * and the lab probe force a restrictive one; answers are kept per hash.
         */
        setProfile(profile: DeviceProfile | null) {
            override = profile ? { profile, hash: hashOf(profile) } : null;
            if (!profile) built = null;
            primed = null;
        },
        /** @returns Slice and request counters, and how many cards are watched and released. */
        stats: (): JsonRecord => ({ ...counters, queued: queue.size, inFlight: network.size, memory: memory.size, ...cards.counts() }),
    };
    JE.tagDirectPlay = api;
    return api;
}
export type DirectPlay = ReturnType<typeof createDirectPlay>;
