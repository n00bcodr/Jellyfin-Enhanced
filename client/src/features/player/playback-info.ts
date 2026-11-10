import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
export function installPlaybackInfo(context: PlayerContext, probeOwnSession: () => Promise<PlayingSession | null>, trackDisplayName: (stream: Stream | null | undefined) => string) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // ── Playback info overlay (DOM-free ShowPlaybackInfo) ────────────────────
    //
    // A plugin-rendered stats overlay toggled by the ShowPlaybackInfo shortcut,
    // replacing the settings-menu → stats panel click chain. Data comes from the
    // media element itself plus the own-session probe (PlayState /
    // TranscodingInfo / MediaStreams). Every value lands via textContent — no
    // HTML sink. One 1s refresh timer exists only while the overlay is open,
    // and it self-destructs when the player goes away.

    const PLAYBACK_INFO_REFRESH_MS = 1000;
    let playbackInfoOverlay: HTMLElement | null = null;
    let playbackInfoTimer: number | null = null;

    /** Tears the overlay and its refresh timer down. */
    function destroyPlaybackInfo() {
        if (playbackInfoTimer) { lifetime.cancel(playbackInfoTimer); playbackInfoTimer = null; }
        if (playbackInfoOverlay) { playbackInfoOverlay.remove(); playbackInfoOverlay = null; }
    }

    /**
     * Builds the label/value rows for the overlay.
     * @param {HTMLVideoElement} video
     * @param {?object} session
     * @returns {Array<[string,string]>}
     */
    function playbackInfoRows(video: HTMLVideoElement, session: PlayingSession | null) {
        const rows: [string, string][] = [];
        if (video.videoWidth && video.videoHeight) {
            rows.push([tWithFallback('pi_resolution', 'Resolution'), `${video.videoWidth}×${video.videoHeight}`]);
        }
        if (Math.abs(video.playbackRate - 1) > 0.001) {
            rows.push([tWithFallback('pi_speed', 'Speed'), `${video.playbackRate}x`]);
        }
        if (typeof video.getVideoPlaybackQuality === 'function') {
            const q = video.getVideoPlaybackQuality();
            rows.push([tWithFallback('pi_dropped_frames', 'Dropped frames'), `${q.droppedVideoFrames} / ${q.totalVideoFrames}`]);
        }
        try {
            const buffered = video.buffered;
            if (buffered && buffered.length > 0) {
                const ahead = buffered.end(buffered.length - 1) - video.currentTime;
                if (Number.isFinite(ahead)) rows.push([tWithFallback('pi_buffer', 'Buffered'), `${Math.max(0, ahead).toFixed(1)} s`]);
            }
        } catch (err) { /* buffered ranges can throw during teardown */ }
        if (session) {
            const playState = session.PlayState || {};
            const transcoding = session.TranscodingInfo || null;
            if (playState.PlayMethod) {
                let method = playState.PlayMethod;
                if (transcoding && typeof transcoding.CompletionPercentage === 'number') {
                    method += ` (${transcoding.CompletionPercentage.toFixed(0)}%)`;
                }
                rows.push([tWithFallback('pi_play_method', 'Play method'), method]);
            }
            if (transcoding) {
                const codecs = [transcoding.Container, transcoding.VideoCodec, transcoding.AudioCodec]
                    .filter(Boolean).join(' · ');
                if (codecs) rows.push([tWithFallback('pi_transcoding', 'Transcoding'), codecs]);
                if (typeof transcoding.Bitrate === 'number' && transcoding.Bitrate > 0) {
                    rows.push([tWithFallback('pi_bitrate', 'Bitrate'), `${(transcoding.Bitrate / 1000000).toFixed(1)} Mbps`]);
                }
                const reasons = Array.isArray(transcoding.TranscodeReasons)
                    ? transcoding.TranscodeReasons.join(', ') : (transcoding.TranscodeReasons || '');
                if (reasons) rows.push([tWithFallback('pi_transcode_reason', 'Reason'), reasons]);
            } else if (session.NowPlayingItem && session.NowPlayingItem.Container) {
                rows.push([tWithFallback('pi_container', 'Container'), session.NowPlayingItem.Container]);
            }
            const streams = (session.NowPlayingItem && session.NowPlayingItem.MediaStreams) || [];
            if (typeof playState.AudioStreamIndex === 'number') {
                const audio = streams.find(s => s && s.Type === 'Audio' && s.Index === playState.AudioStreamIndex);
                if (audio) rows.push([tWithFallback('pi_audio', 'Audio'), trackDisplayName(audio)]);
            }
            if (typeof playState.SubtitleStreamIndex === 'number' && playState.SubtitleStreamIndex >= 0) {
                const sub = streams.find(s => s && s.Type === 'Subtitle' && s.Index === playState.SubtitleStreamIndex);
                if (sub) rows.push([tWithFallback('pi_subtitle', 'Subtitles'), trackDisplayName(sub)]);
            }
        }
        return rows;
    }

    /**
     * Renders the overlay off-DOM and swaps content in one replaceChildren —
     * no incremental mutation of the live overlay, all values via textContent.
     * @param {HTMLVideoElement} video
     * @param {?object} session
     */
    function renderPlaybackInfo(video: HTMLVideoElement, session: PlayingSession | null) {
        if (!playbackInfoOverlay) return;
        const fragment = document.createDocumentFragment();
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;margin-bottom:6px;';
        title.textContent = tWithFallback('playback_info_title', 'Playback Info');
        fragment.appendChild(title);
        for (const [label, value] of playbackInfoRows(video, session)) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;';
            const labelEl = document.createElement('span');
            labelEl.style.opacity = '0.75';
            labelEl.textContent = label;
            const valueEl = document.createElement('span');
            valueEl.textContent = value;
            row.append(labelEl, valueEl);
            fragment.appendChild(row);
        }
        playbackInfoOverlay.replaceChildren(fragment);
    }

    /**
     * One refresh tick: sample the video + session coherently, render, reschedule.
     * `overlay` identity-guards the loop so a toggle-off/on while a probe is in
     * flight cannot fork a second timer chain.
     * @param {HTMLElement} overlay
     */
    async function refreshPlaybackInfo(overlay: HTMLElement) {
        const lease = lifetime.lease();
        if (playbackInfoOverlay !== overlay) return;
        try {
        if (typeof JE.isVideoPage === 'function' && !JE.isVideoPage()) { destroyPlaybackInfo(); return; }
        const video = getVideo();
        if (!video) { destroyPlaybackInfo(); return; }
        const sampledSrc = video.currentSrc || video.src || '';
        const sampledPageItem = getCurrentVideoItemId();
        const session = await probeOwnSession();
        if (playbackInfoOverlay !== overlay) return;
        if (!lease.current()) return;
        const current = getVideo();
        if (!current) { destroyPlaybackInfo(); return; }
        // The session sample and the video must describe the same playback: a
        // next-episode swap (new element/source, a changed route id behind a
        // stable blob source, or a derivable item disagreeing with the probed
        // session) discards this mixed sample; the next tick renders fresh.
        const currentSrc = current.currentSrc || current.src || '';
        const derivable = normalizeItemId(parseItemIdFromVideosSrc(currentSrc) || getCurrentVideoItemId());
        const sessionItem = normalizeItemId(session && session.NowPlayingItem && session.NowPlayingItem.Id);
        const coherent = current === video
            && currentSrc === sampledSrc
            && getCurrentVideoItemId() === sampledPageItem
            && !(derivable && sessionItem && derivable !== sessionItem);
        if (coherent) renderPlaybackInfo(current, session);
        } catch (err) {
            // A failing tick must not kill the refresh chain — the overlay
            // would freeze with stale data until manually toggled.
            console.warn('🪼 Jellyfin Enhanced: playback info refresh failed', err);
        }
        if (playbackInfoOverlay === overlay) {
            playbackInfoTimer = lifetime.timeout(() => {
                playbackInfoTimer = null;
                refreshPlaybackInfo(overlay);
            }, PLAYBACK_INFO_REFRESH_MS);
        }
    }

    /**
     * Toggles the playback-info overlay (no native menus involved).
     */
    JE.togglePlaybackInfo = () => {
        if (playbackInfoOverlay) { destroyPlaybackInfo(); return; }
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        const overlay = document.createElement('div');
        overlay.setAttribute('data-je-playback-info', 'true');
        overlay.style.cssText = `
            position: fixed; top: 12px; left: 12px; z-index: 999999;
            background: rgba(0,0,0,0.72); color: #fff; padding: 10px 14px;
            border-radius: 8px; font-size: 0.85em; font-family: system-ui;
            pointer-events: none; min-width: 240px; max-width: 42vw;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        `;
        playbackInfoOverlay = overlay;
        renderPlaybackInfo(video, null); // immediate local stats; session data lands on the first refresh
        document.body.appendChild(overlay);
        refreshPlaybackInfo(overlay);
    };

    // Auto-skip lives in player/auto-skip.js — it is data-driven off the native
    // Media Segments API rather than the localized skip button, and consumes the
    // two element/item helpers exported below.


lifetime.onReset(destroyPlaybackInfo);
}
