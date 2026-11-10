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
        if (!JE.currentSettings.longPress2xEnabled || (e.button !== undefined && e.button !== 0) || pressTimer) {
            return;
        }
        videoElement = getVideo();
        if (!videoElement) return;

        // Store initial press position
        pressStartX = e.clientX ?? e.touches?.[0]?.clientX ?? null;
        pressStartY = e.clientY ?? e.touches?.[0]?.clientY ?? null;

        originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
        isLongPress = false;

        const lease = lifetime.lease(videoElement);
        pressTimer = lifetime.timeout(() => {
            if (!lease.current() || videoElement !== getVideo()) { JE.handleLongPressCancel(); return; }
            if (JE.state.pauseScreenClickTimer) {
                lifetime.cancel(JE.state.pauseScreenClickTimer);
                JE.state.pauseScreenClickTimer = null;
            }
            isLongPress = true;
            // Make sure video is playing when we activate speed boost
            if (!videoElement) return;
            if (videoElement.paused) {
                videoElement.play().catch(err => console.warn("🪼 Play blocked:", err));
            }
            videoElement.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
            showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
            if (navigator.vibrate) navigator.vibrate(50);
        }, LONG_PRESS_CONFIG.DURATION);
    };

    JE.handleLongPressUp = (e) => {
        if (!pressTimer) return;
        lifetime.cancel(pressTimer);
        pressTimer = null;

        if (isLongPress) {
            const video = videoElement;
            if (video) {
                video.playbackRate = originalSpeed;
            }
            hideOverlay();
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
        isLongPress = false;
        pressStartX = null;
        pressStartY = null;
    };

    JE.handleLongPressCancel = () => {
        if (pressTimer) {
            lifetime.cancel(pressTimer);
            pressTimer = null;
            if (isLongPress) {
                const video = videoElement;
                if (video) {
                    video.playbackRate = originalSpeed;
                }
                hideOverlay();
            }
            isLongPress = false;
        }
        pressStartX = null;
        pressStartY = null;
    };

    // Handle mouse movement during press to detect drag/scrub
    JE.handleLongPressMove = (e) => {
        if (!pressTimer || isLongPress || pressStartX === null || pressStartY === null) return;

        const currentX = e.clientX ?? e.touches?.[0]?.clientX ?? null;
        const currentY = e.clientY ?? e.touches?.[0]?.clientY ?? null;

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
        if (isLongPress || pressTimer) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
    };


lifetime.onReset(() => { JE.handleLongPressCancel(); videoElement = null; speedOverlay?.remove(); speedOverlay = null; });
}
