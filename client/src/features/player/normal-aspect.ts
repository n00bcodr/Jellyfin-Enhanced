import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
export function installAspect(context: PlayerContext) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // ── DOM-free aspect ratio cycling ────────────────────────────────────────
    //
    // Mirrors jellyfin-web's htmlVideoPlayer.setAspectRatio (identical in 10.11
    // and 12): the mode lives in the native appSettings localStorage key
    // `aspectRatio` (unprefixed — AppSettings.set only prefixes user-scoped
    // keys), and applying it is `object-fit` on the media element ('auto'
    // removes the property; the PGS graphical-subtitle canvas maps 'auto' to
    // 'contain'). Writing the same key keeps the native settings menu's check
    // marks — and the next native apply — consistent. No panel ever opens.

    /** The three native aspect modes, in native menu order. */
    const ASPECT_MODES = ['auto', 'cover', 'fill'];

    /**
     * Localized label for an aspect mode (used in the toast).
     * @param {string} mode
     * @returns {string}
     */
    function aspectModeLabel(mode: string) {
        if (mode === 'cover') return tWithFallback('aspect_ratio_cover', 'Cover');
        if (mode === 'fill') return tWithFallback('aspect_ratio_fill', 'Fill');
        return tWithFallback('aspect_ratio_auto', 'Auto');
    }

    /**
     * Cycles video aspect ratio (Auto → Cover → Fill) without opening the OSD
     * settings menu.
     */
    JE.cycleAspect = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        let stored = null;
        try {
            stored = window.localStorage.getItem('aspectRatio');
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: aspect ratio setting read failed', err);
        }
        const current = stored !== null && ASPECT_MODES.indexOf(stored) !== -1 ? stored : 'auto';
        const next = ASPECT_MODES[(ASPECT_MODES.indexOf(current) + 1) % ASPECT_MODES.length] ?? 'auto';
        try {
            window.localStorage.setItem('aspectRatio', next);
        } catch (err) {
            // Apply-only degradation: the mode still changes for this stream,
            // the native menu just won't reflect it.
            console.warn('🪼 Jellyfin Enhanced: aspect ratio setting write failed', err);
        }
        if (next === 'auto') {
            video.style.removeProperty('object-fit');
        } else {
            video.style.objectFit = next;
        }
        // libpgs renders graphical subtitles into a sibling canvas whose fit the
        // native player keeps in step with the video ('auto' → 'contain').
        const parent = video.parentElement;
        if (parent) {
            parent.querySelectorAll<HTMLElement>(':scope > canvas').forEach(canvas => {
                canvas.style.objectFit = next === 'auto' ? 'contain' : next;
            });
        }
        JE.toast(JE.t('toast_aspect_ratio', { ratio: aspectModeLabel(next) }));
    };



}
