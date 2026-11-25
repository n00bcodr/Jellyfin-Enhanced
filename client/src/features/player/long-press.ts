import type { PressEvent } from './host';
import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
export function installLongPress(context: PlayerContext) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // --- Long Press Speed Control ---
    const LONG_PRESS_CONFIG = {
        DURATION: 500,
        SPEED_NORMAL: 1.0,
        SPEED_FAST: 2.0,
        MOVEMENT_THRESHOLD: 10, // pixels - ignore small movements
    };

    let pressTimer: number | null = null;
    let isLongPress = false;
    let videoElement: HTMLVideoElement | null = null;
    let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
    let speedOverlay: HTMLElement | null = null;
    let pressStartX: number | null = null;
    let pressStartY: number | null = null;
    let touchTarget: Element | null = null;
    let touchPointerDown: PressEvent | null = null;
    let suppressClickUntil = 0;

    /** Only claim the playing video surface, never controls, dialogs or paused playback. */
    function canStartLongPress(e: PressEvent) {
        const video = getVideo();
        const target = e.target instanceof Element ? e.target : null;
        return !!(JE.currentSettings.longPress2xEnabled && video && !video.paused
            && target?.closest('video, .videoPlayerContainer, #videoOsdPage')
            && !target.closest('button, a, input, select, textarea, [role="button"], .osdControls, .headerTop, .upNextContainer, .dialogContainer, .pause-screen-active, .jellyfin-enhanced-panel'));
    }

    /** Jellyfin toggles the OSD on pointerdown; defer a touch tap until its release. */
    function handleLongPressPointerDown(e: PressEvent) {
        suppressClickUntil = 0;
        if (e.pointerType !== 'touch' || !canStartLongPress(e)) return;
        touchPointerDown = e;
        e.stopImmediatePropagation();
    }

    // The rest of the gesture's input, beside the listeners chrome's events.ts forwards (navigation already
    // cancels through the lifetime). Physical input only, as there; held with the lifetime's signal and
    // added again after each reset.
    const physical = (handler: (e: PressEvent) => void, videoPage = true) => (e: Event) => {
        if (e.isTrusted !== false && (!videoPage || JE.isVideoPage())) handler(e as unknown as PressEvent);
    };
    function listen() {
        const { signal } = lifetime.lease();
        document.addEventListener('pointerdown', physical(handleLongPressPointerDown), { capture: true, signal });
        document.addEventListener('pointermove', physical(e => JE.handleLongPressMove(e)), { capture: true, signal });
        document.addEventListener('pointercancel', physical(() => JE.handleLongPressCancel(), false), { capture: true, signal });
        window.addEventListener('blur', () => JE.handleLongPressCancel(), { signal });
        document.addEventListener('visibilitychange', () => { if (document.hidden) JE.handleLongPressCancel(); }, { signal });
    }

    function createSpeedOverlay() {
        if (speedOverlay) return;
        speedOverlay = document.createElement('div');
        speedOverlay.setAttribute('data-speed-overlay', 'true');
        speedOverlay.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.9); color: white; padding: 8px 16px; border-radius: 6px;
            font-size: 1.2em; font-weight: bold; z-index: 999999;
            pointer-events: none; font-family: system-ui;
            opacity: 0; transition: opacity 0.2s ease-out; display: none;
        `;
        document.body.appendChild(speedOverlay);
    }

    function showOverlay(speed: number) {
        createSpeedOverlay();
        if (!speedOverlay) return;
        speedOverlay.innerHTML = `${speed}x${speed > 1 ? ' ' + JE.icon(JE.IconName.FAST_FORWARD) : ' ' + JE.icon(JE.IconName.PLAY)}`;
        speedOverlay.style.display = 'block';
        lifetime.timeout(() => { if (speedOverlay) speedOverlay.style.opacity = '1'; }, 10);
    }

    function hideOverlay() {
        if (speedOverlay) {
            speedOverlay.style.opacity = '0';
            lifetime.timeout(() => { if (speedOverlay) speedOverlay.style.display = 'none'; }, 200);
        }
    }

    JE.handleLongPressDown = (e) => {
        suppressClickUntil = 0;
        if (e.touches && e.touches.length > 1) {
            JE.handleLongPressCancel();
            return;
        }
        if (!canStartLongPress(e) || (e.button !== undefined && e.button !== 0) || pressTimer) return;
        videoElement = getVideo();
        if (!videoElement) return;

        if (e.touches) {
            // Cancel native scrolling and compatibility mouse/click events from this touch.
            // A short tap is forwarded to Jellyfin on release; a hold owns the whole gesture.
            touchTarget = e.target instanceof Element ? e.target : null;
            e.preventDefault();
            e.stopImmediatePropagation();
        }

        // Store initial press position
        pressStartX = e.touches?.[0]?.clientX ?? e.clientX ?? null;
        pressStartY = e.touches?.[0]?.clientY ?? e.clientY ?? null;

        originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
        isLongPress = false;

        const lease = lifetime.lease(videoElement);
        pressTimer = lifetime.timeout(() => {
            if (!lease.current() || !videoElement || videoElement !== getVideo() || videoElement.paused || !JE.currentSettings.longPress2xEnabled) {
                JE.handleLongPressCancel();
                return;
            }
            if (JE.state.pauseScreenClickTimer) {
                lifetime.cancel(JE.state.pauseScreenClickTimer);
                JE.state.pauseScreenClickTimer = null;
            }
            isLongPress = true;
            videoElement.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
            showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
            if (navigator.vibrate) navigator.vibrate(50);
        }, LONG_PRESS_CONFIG.DURATION);
    };

    JE.handleLongPressUp = (e) => {
        const target = touchTarget;
        const pointer = touchPointerDown;
        const tap = target && pressTimer && !isLongPress && videoElement === getVideo();
        if (target || isLongPress) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
        JE.handleLongPressCancel();
        if (tap && target.isConnected) {
            // Reuse Jellyfin's own OSD handler, including its double-tap timing guard.
            if (!pointer) { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
            const init = { bubbles: true, pointerType: 'touch', pointerId: pointer.pointerId ?? 0, clientX: pointer.clientX ?? 0, clientY: pointer.clientY ?? 0, button: 0 };
            target.dispatchEvent(new PointerEvent('pointerdown', init));
            // Jellyfin tracks pointer state on window to decide when the OSD may hide.
            target.dispatchEvent(new PointerEvent('pointerup', init));
        }
    };

    JE.handleLongPressCancel = () => {
        lifetime.cancel(pressTimer);
        pressTimer = null;
        if (isLongPress) {
            // Restore the original element, even if navigation replaced the current video.
            if (videoElement) videoElement.playbackRate = originalSpeed;
            hideOverlay();
            suppressClickUntil = Date.now() + 400;
        }
        isLongPress = false;
        videoElement = null;
        pressStartX = null;
        pressStartY = null;
        touchTarget = null;
        touchPointerDown = null;
    };

    // Handle mouse movement during press to detect drag/scrub
    JE.handleLongPressMove = (e) => {
        if (touchTarget || isLongPress) {
            if (e.cancelable) e.preventDefault();
            e.stopImmediatePropagation();
        }
        if (!pressTimer || isLongPress || pressStartX === null || pressStartY === null) return;

        const currentX = e.touches?.[0]?.clientX ?? e.clientX ?? null;
        const currentY = e.touches?.[0]?.clientY ?? e.clientY ?? null;

        if (currentX === null || currentY === null) return;

        const distanceMoved = Math.sqrt(
            Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
        );

        // If user moves more than threshold, cancel the long press (likely a drag attempt)
        if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
            lifetime.cancel(pressTimer);
            pressTimer = null;
            pressStartX = null;
            pressStartY = null;
        }
    };

    // Block click events that would pause/play when doing a long press
    JE.handleLongPressClick = (e) => {
        // If long press is just completed OR user is still holding (timer active),
        // prevent the click from pausing the video
        if (isLongPress || pressTimer || Date.now() < suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
    };


lifetime.onReset(() => { JE.handleLongPressCancel(); videoElement = null; speedOverlay?.remove(); speedOverlay = null; listen(); });
listen();
}
