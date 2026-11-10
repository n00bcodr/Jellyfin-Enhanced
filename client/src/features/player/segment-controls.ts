import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
export function installSegmentControls(context: PlayerContext) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // ── Segment-data skip (primary), skip-button click (fallback) ───────────
    //
    // The server's native Media Segments API (GET /MediaSegments/{itemId},
    // available on both 10.11 and 12) gives the exact intro/outro boundaries,
    // so the shortcut can seek straight past the segment the position is inside
    // — no button, no DOM. The visible skip-button click remains the fallback
    // for items without segment data and for third-party skip-button plugins.

    /** Ticks per second in Jellyfin's timeline (1 tick = 100 ns). */
    const TICKS_PER_SECOND = 10000000;

    /** Per-item media segment cache: itemId → {segments:[], at:number}. */
    const segmentCache = new Map<string, { segments: MediaSegment[]; at: number }>();
    const SEGMENT_CACHE_MS = 10 * 60 * 1000;

    /**
     * Derives the transcode clock offset (ticks) from the media source URL —
     * non-HLS progressive transcodes without CopyTimestamps restart the element
     * clock at the transcode's StartTimeTicks, so raw currentTime would desync
     * every boundary comparison. HLS (.m3u8 / blob:) and Static/CopyTimestamps
     * sources keep an absolute clock (offset 0).
     * @param {string} src
     * @returns {number}
     */
    function transcodeOffsetTicks(src: string) {
        try {
            const q = (src || '').indexOf('?');
            if (q === -1) return 0;
            if (src.substring(0, q).toLowerCase().endsWith('.m3u8')) return 0;
            let startTimeTicks = 0;
            for (const [name, value] of new URLSearchParams(src.substring(q + 1))) {
                const lower = name.toLowerCase();
                if ((lower === 'static' || lower === 'copytimestamps') && String(value).toLowerCase() === 'true') {
                    return 0; // absolute element clock
                }
                if (lower === 'starttimeticks') {
                    const n = parseInt(value, 10);
                    if (Number.isFinite(n) && n > 0) startTimeTicks = n;
                }
            }
            return startTimeTicks;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: transcode offset parse failed', err);
            return 0;
        }
    }

    /**
     * Fetches (and caches) the item's media segments.
     * @param {string} itemId
     * @returns {Promise<Array<object>>}
     */
    async function fetchMediaSegments(itemId: string) {
        const lease = lifetime.lease();
        const cached = segmentCache.get(itemId);
        if (cached && (performance.now() - cached.at) < SEGMENT_CACHE_MS) return cached.segments;
        try {
            const ac = ApiClient;
            if (!ac) return [];
            const res = await ac.ajax({
                type: 'GET',
                url: ac.getUrl(`/MediaSegments/${encodeURIComponent(itemId)}`),
                dataType: 'json'
            });
            const segments = decodeSegments(res);
            // Bound the cache: one entry per item would otherwise accumulate
            // across a long session (TTL is only checked on read).
            if (segmentCache.size > 50) segmentCache.clear();
            if (lease.current()) segmentCache.set(itemId, { segments, at: performance.now() });
            return segments;
        } catch (err) {
            // Transient failure: no caching, the next press retries.
            console.warn('🪼 Jellyfin Enhanced: media segments fetch failed', err);
            return [];
        }
    }

    /**
     * Clicks the visible native/third-party skip button, if any.
     * @returns {boolean} True when a button was clicked.
     */
    function clickSkipButton() {
        const skipButton = document.querySelector<HTMLElement>('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
        if (!skipButton) return false;
        const buttonText = skipButton.textContent || '';
        skipButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        skipButton.click();
        if (buttonText.includes('Skip Intro')) {
            JE.toast(JE.t('toast_skipped_intro'));
        } else if (buttonText.includes('Skip Outro')) {
            JE.toast(JE.t('toast_skipped_outro'));
        } else {
            JE.toast(`${JE.icons.wrapEmoji('⏭️')} Skipped`);
        }
        return true;
    }

    /**
     * Skips the current intro/outro. Primary path is data-driven: when the
     * position is inside a known media segment, seek past its exact end — no
     * button, no DOM. Falls back to the visible skip button otherwise.
     */
    JE.skipIntroOutro = () => {
        const lease = lifetime.lease(getVideo());
        const video = getVideo();
        const itemId = getCurrentVideoItemId()
            || parseItemIdFromVideosSrc((video && (video.currentSrc || video.src)) || '');
        if (!video || !itemId) {
            if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
            return;
        }
        const pressVideo = video;
        const pressSrc = video.currentSrc || video.src || '';
        fetchMediaSegments(itemId).then(segments => {
            if (!lease.current()) return;
            // The fetch is async: bail to the button if the surface moved.
            const v = getVideo();
            if (v !== pressVideo || ((v && (v.currentSrc || v.src)) || '') !== pressSrc) {
                if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
                return;
            }
            const offset = transcodeOffsetTicks(pressSrc);
            const nowTicks = pressVideo.currentTime * TICKS_PER_SECOND + offset;
            const seg = segments.find(s => s
                && typeof s.StartTicks === 'number' && typeof s.EndTicks === 'number'
                && s.StartTicks <= nowTicks && s.EndTicks > nowTicks);
            if (seg && seg.EndTicks !== undefined) {
                const endSeconds = (seg.EndTicks - offset) / TICKS_PER_SECOND;
                const duration = Number.isFinite(pressVideo.duration) && pressVideo.duration > 0
                    ? pressVideo.duration : Infinity;
                const target = Math.min(endSeconds, duration);
                if (target > pressVideo.currentTime) {
                    pressVideo.currentTime = target;
                    if (seg.Type === 'Intro') {
                        JE.toast(JE.t('toast_skipped_intro'));
                    } else if (seg.Type === 'Outro') {
                        JE.toast(JE.t('toast_skipped_outro'));
                    } else {
                        JE.toast(`${JE.icons.wrapEmoji('⏭️')} Skipped`);
                    }
                    return;
                }
            }
            if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
        }).catch(err => {
            if (!lease.current()) return;
            console.warn('🪼 Jellyfin Enhanced: segment skip failed', err);
            if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
        });
    };


lifetime.onReset(() => segmentCache.clear());
}
