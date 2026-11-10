import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
type TrackPress = { item: Promise<string | null>; idless: boolean; video: HTMLVideoElement | null; src: string; current(): boolean };
export function installTrackControls(context: PlayerContext, cycleTrackMenu: (selector: string, empty: string, kind: TrackKind) => void) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // ── DOM-free track cycling (primary path) ────────────────────────────────
    //
    // Tracks are switched through the server's remote-control channel:
    // POST /Sessions/{id}/Command with SetAudioStreamIndex / SetSubtitleStreamIndex.
    // The web client routes both commands straight into its internal
    // playbackManager (serverNotifications.js in both jellyfin-web 10.11 and 12,
    // with Index -1 meaning "subtitles off"), so no action sheet ever opens.
    // The hardened OSD menu cycle above remains the fallback for an unmoved
    // surface when the session cannot be resolved or the command fails.
    //
    // Staleness model (each guard exists because a concrete interleaving breaks
    // without it — see the matching comments):
    //  * Presses are serialized per kind, so a rapid second press observes the
    //    first press's commanded index instead of re-computing the same "next"
    //    from a lagging PlayState.
    //  * A short-lived commanded-index memory (scoped to session+item+
    //    MediaSourceId) bridges the window where PlayState still reports the
    //    old track. It is retired the moment PlayState acknowledges the value,
    //    voided by a MediaSource switch (stream indices renumber), and cleared
    //    before EVERY menu fallback (the menu is authoritative and its
    //    selection is not observed here).
    //  * Item ownership is captured AT the keypress: parsed from the media
    //    source URL (or the video-page URL), or — for id-less hls.js blob
    //    sources — via a press-time session probe accepted only if the
    //    element/source surface is unchanged when it resolves. A press whose
    //    id-less surface later moves is swallowed outright: a lagging server
    //    can keep reporting the old item after an episode change, so no probe
    //    can PROVE the moved surface still plays the press item.
    //  * Before the POST the current surface is re-checked against the press
    //    item (a probe response itself can be stale), and a failed POST falls
    //    back to the menu only with positively proven, unmoved ownership.

    /** Milliseconds a commanded index may bridge PlayState lag. */
    const TRACK_COMMAND_MEMORY_MS = 10000;

    /**
     * Per-kind commanded-index memory. Audio and subtitle records are
     * independent so an intervening command of the other kind cannot evict one.
     * @type {{subtitle: ?{sessionId:string,itemId:string,mediaSourceId:?string,index:number,at:number}, audio: ?{...}}}
     */
    const lastCommanded: Record<TrackKind, { sessionId: string; itemId: string; mediaSourceId: string | null; index: number; at: number } | null> = { subtitle: null, audio: null };

    /** @param {'subtitle'|'audio'} kind */
    function forgetCommanded(kind: TrackKind) { lastCommanded[kind] = null; }

    /**
     * The remembered commanded index, when still authoritative.
     * @param {'subtitle'|'audio'} kind
     * @param {string} sessionId
     * @param {string} itemId
     * @param {?string} mediaSourceId
     * @param {number|null|undefined} reported - PlayState's current index.
     * @returns {?number}
     */
    function rememberedIndex(kind: TrackKind, sessionId: string, itemId: string, mediaSourceId: string | null, reported: number | undefined) {
        const rec = lastCommanded[kind];
        if (!rec || rec.sessionId !== sessionId || rec.itemId !== itemId) return null;
        // A media-source switch renumbers streams; the optimistic index is void.
        if (rec.mediaSourceId !== (mediaSourceId || null)) {
            forgetCommanded(kind);
            return null;
        }
        // PlayState acknowledged the command — it is authoritative again, and a
        // later EXTERNAL selection must win instead of being overridden.
        if (typeof reported === 'number' && reported === rec.index) {
            forgetCommanded(kind);
            return null;
        }
        if ((performance.now() - rec.at) > TRACK_COMMAND_MEMORY_MS) return null;
        return rec.index;
    }

    /**
     * Normalizes a Jellyfin item id for comparison (dashless, lowercase).
     * @param {string|null|undefined} value
     * @returns {?string}
     */


    /**
     * Parses the playing item id from a /Videos/{id}/... media source URL.
     * @param {string} src
     * @returns {?string}
     */


    /**
     * Item identity visible right now: source-URL parse with the video-page URL
     * as fallback. Null for id-less sources (hls.js blob) — an indeterminate
     * value never *asserts* staleness.
     * @returns {?string}
     */
    function currentItemHint() {
        const video = getVideo();
        const src = (video && (video.currentSrc || video.src)) || '';
        return normalizeItemId(parseItemIdFromVideosSrc(src) || getCurrentVideoItemId());
    }

    /**
     * Resolves the caller's OWN playing session — the remote-control target the
     * DOM-free paths command. Fail-open: an ambiguous DeviceId match (multiple
     * playing sessions) returns null rather than risking the wrong session.
     * @returns {Promise<?object>} The session DTO, or null.
     */
    async function probeOwnSession() {
        try {
            const ac = ApiClient;
            if (!ac) return null;
            const userId = ac.getCurrentUserId();
            const deviceId = typeof ac.deviceId === 'function' ? ac.deviceId() : '';
            if (!userId || !deviceId) return null;
            const sessions = await ac.ajax({
                type: 'GET',
                url: ac.getUrl(`/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`),
                dataType: 'json'
            });
            if (!Array.isArray(sessions)) return null;
            const matches = decodeSessions(sessions).filter(s => s && s.DeviceId === deviceId && s.NowPlayingItem && s.NowPlayingItem.Id);
            return matches.length === 1 ? matches[0] ?? null : null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: own-session probe failed', err);
            return null;
        }
    }

    /**
     * Per-kind press serialization: each press queues on a settled promise chain
     * so a rapid second press observes the first press's outcome. No timers.
     * @type {{subtitle: Promise, audio: Promise}}
     */
    const trackCycleChains = { subtitle: Promise.resolve(), audio: Promise.resolve() };

    /**
     * DOM-free cycle attempt. Returns true when the press was fully handled
     * (including toasts and deliberate swallows); false → the caller runs the
     * menu fallback.
     * @param {'subtitle'|'audio'} kind
     * @param {{item: Promise<?string>, idless: boolean, video: ?HTMLVideoElement, src: string}} press
     * @returns {Promise<boolean>}
     */
    async function cycleTrackViaApi(kind: TrackKind, press: TrackPress) {
        const ac = ApiClient;
        if (!ac) return false;
        const onVideoPage = () => press.current() && (typeof JE.isVideoPage !== 'function' || JE.isVideoPage());
        const surfaceUnchanged = () => {
            const v = getVideo();
            return v === press.video && ((v && (v.currentSrc || v.src)) || '') === press.src;
        };
        if (!onVideoPage()) return true;

        const [pressItemId, session] = await Promise.all([press.item, probeOwnSession()]);
        if (!onVideoPage()) return true; // navigated away — swallow
        // Unproven ownership never commands. The menu fallback is acceptable
        // only while the press surface has not moved; unproven + moved may
        // belong to the previous item — swallow.
        if (!pressItemId) {
            return press.idless && !surfaceUnchanged();
        }
        const sessionId = session && session.Id;
        const itemId = session && session.NowPlayingItem && session.NowPlayingItem.Id;
        if (!sessionId || !itemId) return false;
        // The press belongs to the item playing at the keypress; a disagreeing
        // session (next episode landed while queued/probing) swallows.
        const sessionItem = normalizeItemId(itemId);
        if (sessionItem && pressItemId !== sessionItem) return true;
        // Id-less press whose surface moved: no probe can prove it — swallow.
        if (press.idless && !surfaceUnchanged()) return true;

        const type = kind === 'subtitle' ? 'Subtitle' : 'Audio';
        const streams = ((session.NowPlayingItem && session.NowPlayingItem.MediaStreams) || [])
            .filter((s): s is Stream & { Index: number } => s.Type === type && typeof s.Index === 'number');
        if (streams.length === 0) {
            JE.toast(JE.t(kind === 'subtitle' ? 'toast_no_subtitles_found' : 'toast_no_audio_tracks_found'));
            return true;
        }
        // Subtitles cycle through Off (-1); audio has no Off state.
        const candidates = kind === 'subtitle'
            ? [-1].concat(streams.map(s => s.Index))
            : streams.map(s => s.Index);
        if (candidates.length < 2) {
            // A single audio track: nothing to switch. Named toast, no command.
            JE.toast(JE.t('toast_audio', { audio: JE.escapeHtml(trackDisplayName(streams[0])) }));
            return true;
        }

        const playState = session.PlayState || {};
        const reported = kind === 'subtitle' ? playState.SubtitleStreamIndex : playState.AudioStreamIndex;
        const mediaSourceId = playState.MediaSourceId || null;
        const current = rememberedIndex(kind, sessionId, itemId, mediaSourceId, reported);
        const effective = current !== null ? current : (typeof reported === 'number' ? reported : -1);
        const position = candidates.indexOf(effective);
        const next = candidates[(position + 1) % candidates.length];
        if (next === undefined) return false;
        const commandName = kind === 'subtitle' ? 'SetSubtitleStreamIndex' : 'SetAudioStreamIndex';

        // Pre-POST recheck: the probe response itself can be stale (produced for
        // the press item while the next episode landed in flight). A derivable
        // current item disagreeing with the press item swallows.
        const itemNow = currentItemHint();
        if (itemNow && itemNow !== pressItemId) return true;
        try {
            await ac.ajax({
                type: 'POST',
                url: ac.getUrl(`/Sessions/${encodeURIComponent(sessionId)}/Command`),
                contentType: 'application/json',
                data: JSON.stringify({ Name: commandName, Arguments: { Index: String(next) } })
            });
        } catch (err) {
            // The menu fallback after a FAILED command requires positively
            // proven, unmoved ownership — a rejected command cannot explain a
            // surface change, and a moved item must not get the menu.
            if (!onVideoPage()) return true;
            let proven = currentItemHint();
            if (!proven) {
                const fresh = await probeOwnSession();
                proven = normalizeItemId(fresh && fresh.NowPlayingItem && fresh.NowPlayingItem.Id);
            }
            if (proven !== pressItemId) return true;
            console.warn(`🪼 Jellyfin Enhanced: ${commandName} failed, falling back to the menu cycle`, err);
            return false;
        }
        // POST-side check deliberately ignores the surface: a successful switch
        // itself restarts the stream. The memory is session+item keyed, so a
        // write after a genuine item change self-invalidates on the next press.
        if (!onVideoPage()) return true;
        lastCommanded[kind] = { sessionId, itemId, mediaSourceId, index: next, at: performance.now() };
        const nextStream = next === -1 ? null : streams.find(s => s.Index === next);
        JE.toast(JE.t(kind === 'subtitle' ? 'toast_subtitle' : 'toast_audio',
            { [kind]: JE.escapeHtml(trackDisplayName(nextStream)) }));
        return true;
    }

    /**
     * Human-readable track name for toasts.
     * @param {?object} stream
     * @returns {string}
     */
    function trackDisplayName(stream: Stream | null | undefined) {
        if (!stream) return tWithFallback('track_off', 'Off');
        const name = (stream.DisplayTitle || stream.Title || stream.Language || stream.Codec || '').trim();
        return name || ('#' + stream.Index);
    }

    /**
     * Queues one track-cycle press: API first, hardened OSD menu as fallback.
     * @param {'subtitle'|'audio'} kind
     */
    function cycleTrack(kind: TrackKind) {
        if (!ApiClient) {
            // No API client — menu path directly; the memory never outlives a fallback.
            forgetCommanded(kind);
            runMenuFallback(kind);
            return;
        }
        // Press-time ownership, captured BEFORE queueing. Id-bearing sources
        // resolve synchronously; id-less sources fire a press-time probe that
        // only counts if the surface is still the keypress surface on resolve.
        const hint = currentItemHint();
        const pressVideo = hint ? null : getVideo();
        const lease = lifetime.lease();
        const press: TrackPress = {
            current: lease.current,
            idless: !hint,
            video: pressVideo,
            src: (pressVideo && (pressVideo.currentSrc || pressVideo.src)) || '',
            item: Promise.resolve(null)
        };
        press.item = hint
            ? Promise.resolve(hint)
            : probeOwnSession()
                .then(s => {
                    const id = normalizeItemId(s && s.NowPlayingItem && s.NowPlayingItem.Id);
                    const v = getVideo();
                    const same = v === press.video && ((v && (v.currentSrc || v.src)) || '') === press.src;
                    return same ? id : null;
                })
                .catch(() => null);
        trackCycleChains[kind] = trackCycleChains[kind].then(async () => {
            let handled = false;
            try {
                handled = await cycleTrackViaApi(kind, press);
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: API track cycle failed', err);
            }
            if (handled || !press.current()) return;
            if (typeof JE.isVideoPage === 'function' && !JE.isVideoPage()) return;
            // Every menu fallback invalidates the optimistic memory: the menu is
            // authoritative and its selection is not observed here.
            forgetCommanded(kind);
            runMenuFallback(kind);
        });
    }

    /** @param {'subtitle'|'audio'} kind */
    function runMenuFallback(kind: TrackKind) {
        if (kind === 'subtitle') {
            cycleTrackMenu('button.btnSubtitles', 'toast_no_subtitles_found', 'subtitle');
        } else {
            cycleTrackMenu('button.btnAudio', 'toast_no_audio_tracks_found', 'audio');
        }
    }

    /**
     * Cycles through available subtitle tracks (server command; OSD menu fallback).
     */
    JE.cycleSubtitleTrack = () => cycleTrack('subtitle');

    /**
     * Cycles through available audio tracks (server command; OSD menu fallback).
     */
    JE.cycleAudioTrack = () => cycleTrack('audio');

    let offsetPanel: Element | null = null;
    let offsetPanelTimer: number | null = null;
    const hideOffsetPanel = () => {
        lifetime.cancel(offsetPanelTimer);
        offsetPanel?.classList.add('hide');
        offsetPanel = offsetPanelTimer = null;
    };

    /**
     * Nudges the subtitle offset through jellyfin-web's own subtitle sync slider (its
     * updateOffset() applies the value) and shows that panel until two seconds pass
     * without another nudge, so the new value can be read.
     * @param deltaSeconds Seconds to add (negative = subtitles earlier).
     */
    JE.adjustSubtitleOffset = (deltaSeconds) => {
        const slider = document.querySelector<HTMLInputElement & { updateOffset?: unknown }>('.subtitleSyncSlider');
        const box = document.querySelector('.subtitleSyncContainer');
        if (!slider || !box || typeof slider.updateOffset !== 'function') {
            JE.toast(tWithFallback('toast_subtitle_offset_unavailable', 'Subtitle offset is not available'));
            return;
        }
        slider.updateOffset(Math.round(((parseFloat(slider.value) || 0) + deltaSeconds) * 10) / 10);
        hideOffsetPanel();
        box.classList.remove('hide');
        offsetPanel = box;
        offsetPanelTimer = lifetime.timeout(hideOffsetPanel, 2000);
    };

lifetime.onReset(() => {
 hideOffsetPanel();
 lastCommanded.subtitle = lastCommanded.audio = null;
 trackCycleChains.subtitle = Promise.resolve(); trackCycleChains.audio = Promise.resolve();
});
return { probeOwnSession, trackDisplayName };
}
