import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
export function installFrameSeek(context: PlayerContext) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // Frame Step (YouTube-style , / .). FPS cached per (itemId + media source) so series
    // auto-play swaps don't cross-pollute. Transient failures fall back to 24 without caching.
    const FRAME_STEP_FALLBACK_FPS = 24;
    const _fpsCache = new Map<string, number>();
    const _fpsInflight = new Map<string, Promise<number>>();
    let _frameOverlay: HTMLElement | null = null;
    let _frameOverlayHideTimer: number | null = null;
    let _frameOverlayFadeTimer: number | null = null;
    const _fallbackFpsWarned = new Set();



    function pickFps(stream: Stream | null | undefined) {
        if (!stream) return null;
        const candidates = [stream.ReferenceFrameRate, stream.RealFrameRate, stream.AverageFrameRate];
        for (const c of candidates) {
            const n = parseFloat(String(c));
            if (Number.isFinite(n) && n >= 1 && n < 1000) return n;
        }
        return null;
    }

    function getActiveMediaSourceId(video: HTMLVideoElement | null) {
        try {
            const src = video?.currentSrc || video?.src || '';
            const q = src.indexOf('?');
            if (q === -1) return null;
            return new URLSearchParams(src.substring(q + 1)).get('MediaSourceId') || null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step MediaSourceId parse failed', err);
            return null;
        }
    }

    async function fetchFpsForItem(itemId: string, activeMediaSourceId: string | null) {
        if (!itemId || !ApiClient) return null;
        try {
            const userId = ApiClient.getCurrentUserId();
            const item = decodeItem(await ApiClient.getItem(userId, itemId));
            const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
            const ordered = activeMediaSourceId
                ? [...sources.filter(s => s.Id === activeMediaSourceId), ...sources.filter(s => s.Id !== activeMediaSourceId)]
                : sources;
            for (const source of ordered) {
                const vs = source.MediaStreams?.find(s => s.Type === 'Video');
                const fps = pickFps(vs);
                if (fps) return fps;
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step fps lookup failed', err);
        }
        return null;
    }

    function getFpsCacheKey(itemId: string | null, video: HTMLVideoElement) {
        if (!itemId) return null;
        const msId = getActiveMediaSourceId(video);
        if (msId) return `${itemId}|ms:${msId}`;
        const src = (video?.currentSrc || video?.src || '').split('?')[0];
        return `${itemId}|src:${src}`;
    }

    async function resolveFps(video: HTMLVideoElement) {
        const lease = lifetime.lease(video);
        const itemId = getCurrentVideoItemId();
        const cacheKey = getFpsCacheKey(itemId, video);
        const cached = cacheKey ? _fpsCache.get(cacheKey) : undefined;
        if (cached !== undefined) return cached;
        // Inflight keyed by itemId so presses before/after currentSrc populates share one fetch.
        const inflight = itemId ? _fpsInflight.get(itemId) : undefined;
        if (inflight) return inflight;

        const activeMediaSourceId = getActiveMediaSourceId(video);
        const promise = (async () => {
            const fetched = itemId ? await fetchFpsForItem(itemId, activeMediaSourceId) : null;
            const isReal = fetched !== null && Number.isFinite(fetched) && fetched >= 1;
            const fps = isReal ? fetched : FRAME_STEP_FALLBACK_FPS;
            // Build write key from the source we fetched for, not getVideo() which may have swapped.
            const finalKey = itemId
                ? (activeMediaSourceId
                    ? `${itemId}|ms:${activeMediaSourceId}`
                    : `${itemId}|src:${(video?.currentSrc || video?.src || '').split('?')[0]}`)
                : null;
            if (lease.current() && finalKey && isReal) _fpsCache.set(finalKey, fps);
            if (lease.current() && !isReal && itemId && !_fallbackFpsWarned.has(itemId)) {
                try {
                    JE.toast(tWithFallback(
                        'toast_frame_step_fps_fallback',
                        'ℹ Frame step using fallback {fps} fps (actual rate unknown)',
                        { fps: FRAME_STEP_FALLBACK_FPS }
                    ));
                    _fallbackFpsWarned.add(itemId);
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: frame-step fallback toast failed', err);
                }
            }
            return fps;
        })();
        if (itemId) _fpsInflight.set(itemId, promise);
        try { return await promise; }
        finally { if (itemId && _fpsInflight.get(itemId) === promise) _fpsInflight.delete(itemId); }
    }

    // JE.t returns the raw key on miss; tWithFallback substitutes an inline English default
    // until upstream en.json catches up. Mirrors elsewhere/reviews.js.



    function showFrameOverlay(text: string) {
        if (!_frameOverlay) {
            _frameOverlay = document.createElement('div');
            _frameOverlay.setAttribute('data-je-frame-overlay', 'true');
            _frameOverlay.style.cssText = `
                position: fixed; bottom: 18%; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.78); color: #fff; padding: 6px 14px; border-radius: 6px;
                font-size: 0.95em; font-weight: 600; z-index: 999999;
                pointer-events: none; font-family: system-ui;
                opacity: 0; transition: opacity 0.15s ease-out; display: none;
                white-space: nowrap;
            `;
            document.body.appendChild(_frameOverlay);
        }
        _frameOverlay.textContent = text;
        _frameOverlay.style.display = 'block';
        requestAnimationFrame(() => {
            if (_frameOverlay) _frameOverlay.style.opacity = '1';
        });

        if (_frameOverlayHideTimer) { lifetime.cancel(_frameOverlayHideTimer); _frameOverlayHideTimer = null; }
        if (_frameOverlayFadeTimer) { lifetime.cancel(_frameOverlayFadeTimer); _frameOverlayFadeTimer = null; }
        _frameOverlayHideTimer = lifetime.timeout(() => {
            _frameOverlayHideTimer = null;
            if (!_frameOverlay) return;
            _frameOverlay.style.opacity = '0';
            _frameOverlayFadeTimer = lifetime.timeout(() => {
                _frameOverlayFadeTimer = null;
                if (_frameOverlay && _frameOverlay.style.opacity === '0') {
                    _frameOverlay.style.display = 'none';
                }
            }, 200);
        }, 900);
    }

    JE.frameStep = async (direction) => {
      const lease = lifetime.lease(getVideo());
      try {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        if (!video.paused) {
            try {
                const r: unknown = video.pause();
                // pause() returns a Promise on Chromecast/MSE/PiP; swallow rejection.
                if (r instanceof Promise) {
                    r.catch(err => console.warn('🪼 Jellyfin Enhanced: video.pause() rejected', err));
                }
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: video.pause() threw', err);
            }
        }

        const fps = await resolveFps(video);
        if (!lease.current() || video !== getVideo()) return;
        const frameDuration = 1 / fps;
        const delta = direction === 'forward' ? frameDuration : -frameDuration;
        const upper = Number.isFinite(video.duration) ? video.duration : Infinity;
        const newTime = Math.max(0, Math.min(upper, video.currentTime + delta));
        video.currentTime = newTime;

        const arrow = direction === 'forward' ? '▶' : '◀';
        const frameNum = Math.max(0, Math.round(newTime * fps));
        const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/\.?0+$/, '');
        const text = tWithFallback(
            'toast_frame_step',
            '{arrow} Frame {frame}  ·  {fps} fps',
            { arrow, frame: frameNum, fps: fpsLabel }
        );
        showFrameOverlay(text);
      } catch (err) {
        console.warn('🪼 Jellyfin Enhanced: frameStep failed', err);
      }
    };

    // --- Jump Back  ---
    // Track the last "stable" playback position via timeupdate (fires ~4x/sec
    // while playing). When a seek starts we snapshot that stable value — not
    // video.currentTime inside the seeking event
    // A guard flag prevents the jump-back action itself from overwriting the saved position.
    let _lastStablePosition: number | null = null;   // updated continuously during normal playback
    let _lastPositionBeforeSeek: number | null = null; // snapshotted at seek start
    let _jumpingBack = false;
    const seekTracked = new Map<HTMLVideoElement, () => void>();

    /**
     * Attaches timeupdate + seeking listeners to the given video element to track
     * the last known position before each seek. Safe to call multiple times — the
     * listeners are stored on the element and only attached once.
     * @param {HTMLVideoElement} video
     */
    JE.attachSeekTracker = (video) => {
        if (!video || seekTracked.has(video)) return;
        for (const release of seekTracked.values()) release();
        seekTracked.clear(); _lastStablePosition = _lastPositionBeforeSeek = null; _jumpingBack = false;

        // Keep a rolling record of where we actually are during normal playback
        const timeupdate = () => {
            if (_jumpingBack) return;
            if (!video.seeking && Number.isFinite(video.currentTime) && video.currentTime > 0) {
                _lastStablePosition = video.currentTime;
            }
        };

        const seeking = () => {
            if (_jumpingBack) return;
            if (_lastStablePosition !== null) {
                _lastPositionBeforeSeek = _lastStablePosition;
            }
        };
        video.addEventListener('timeupdate', timeupdate);
        video.addEventListener('seeking', seeking);
        seekTracked.set(video, () => { video.removeEventListener('timeupdate', timeupdate); video.removeEventListener('seeking', seeking); });
    };

    /**
     * Jumps back to the position captured just before the last seek.
     */
    JE.jumpToLastPosition = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        if (_lastPositionBeforeSeek === null) {
            JE.toast(tWithFallback('toast_no_last_position', '{{icon:rewind}} No previous position saved'));
            return;
        }
        const targetTime = _lastPositionBeforeSeek;
        _lastPositionBeforeSeek = null; // consume it so repeated presses don't loop
        _jumpingBack = true;
        _lastStablePosition = null;    // reset so it re-accumulates after the jump
        video.currentTime = targetTime;
        lifetime.timeout(() => { _jumpingBack = false; }, 500);

        const mins = Math.floor(targetTime / 60);
        const secs = Math.floor(targetTime % 60).toString().padStart(2, '0');
        JE.toast(tWithFallback('toast_jumped_back', '{{icon:rewind}} Jumped back to {time}', { time: `${mins}:${secs}` }));
    };


lifetime.onReset(() => {
 _frameOverlay?.remove(); _frameOverlay = null; _frameOverlayHideTimer = _frameOverlayFadeTimer = null;
 for (const release of seekTracked.values()) release(); seekTracked.clear();
 _lastStablePosition = _lastPositionBeforeSeek = null; _jumpingBack = false;
 _fpsCache.clear(); _fpsInflight.clear(); _fallbackFpsWarned.clear();
});
}
