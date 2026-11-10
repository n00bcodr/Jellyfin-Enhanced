/** The gesture classifier owns no listeners or browser-global state. */
export interface TapHost {
    contains(element: HTMLElement, target: EventTarget): boolean;
    scrolledRecentlyWithin(element: HTMLElement, quietWindow: number): boolean;
}
/**
 * Tracks one element's touches and decides on `touchend` whether they were
 * a tap. Shared by addTouchTapListener (listeners on the element) and
 * addDelegatedTouchTapListener (one set of listeners on a container, one
 * tracker per element), so both classify taps identically.
 *
 * @param element - Element the taps are detected on.
 * @param onTap - Called with the `touchend` event for genuine taps.
 */
export function createTapTracker(element: HTMLElement, onTap: (event: TouchEvent) => void, host: TapHost) {
    // Movement beyond this many pixels means the touch is a scroll/swipe, not a tap.
    const TAP_MOVE_THRESHOLD_PX = 10;
    // A touch starting within this window of a scroll event is stopping a
    // momentum fling, not tapping — momentum emits scroll events continuously.
    const SCROLL_QUIET_WINDOW_MS = 100;

    let trackedTouchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let stoppedFling = false;

    const exceedsThreshold = (touch: Touch) =>
        Math.abs(touch.clientX - startX) > TAP_MOVE_THRESHOLD_PX ||
        Math.abs(touch.clientY - startY) > TAP_MOVE_THRESHOLD_PX;

    return {
        start(e: TouchEvent) {
            // A second concurrent finger on the element is never a tap — cancel the
            // gesture and wait for a fresh single-finger touch. `targetTouches` is
            // scoped to this element on purpose: an unrelated resting contact
            // elsewhere on the screen (palm edge, holding thumb) must not make the
            // row unresponsive.
            if (trackedTouchId !== null || e.targetTouches.length > 1) {
                trackedTouchId = null;
                return;
            }
            // changedTouches can carry simultaneous contacts from other elements
            // in one hardware event — track the one that actually began here.
            const touch = Array.from(e.changedTouches).find(t => host.contains(element, t.target)) ||
                e.changedTouches[0];
            if (!touch) return;
            trackedTouchId = touch.identifier;
            moved = false;
            stoppedFling = host.scrolledRecentlyWithin(element, SCROLL_QUIET_WINDOW_MS);
            startX = touch.clientX;
            startY = touch.clientY;
        },
        move(e: TouchEvent) {
            if (moved || trackedTouchId === null) return;
            const touch = Array.from(e.touches).find(t => t.identifier === trackedTouchId);
            if (touch && exceedsThreshold(touch)) {
                moved = true;
            }
        },
        // System gestures (e.g. iOS edge swipes) cancel the touch without a touchend.
        cancel() {
            trackedTouchId = null;
        },
        end(e: TouchEvent) {
            const touch = Array.from(e.changedTouches).find(t => t.identifier === trackedTouchId);
            if (!touch) return;
            trackedTouchId = null;
            // Reject flick-stops, second-finger gestures on the element, and
            // touches that ended far from where they started (fast flicks can
            // outrun touchmove sampling without `moved` ever flipping).
            if (moved || stoppedFling || e.targetTouches.length > 0 || exceedsThreshold(touch)) {
                // The browser's own tap classifier is more tolerant than ours; if it
                // disagrees, its synthetic click would reach unguarded click
                // handlers (real request flow, instant modal). Suppress it.
                e.preventDefault();
                return;
            }
            onTap(e);
        }
    };
}

