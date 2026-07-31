// @ts-check
// /js/core/ui-kit.js
//
// Small shared UI primitives: THE escapeHtml (previously defined 3+ times),
// the toast notification (moved from enhanced/ui.js), dedupe-by-id CSS
// injection (previously helpers.addCSS), and scroll-friendly tap detection
// (shared by the Seerr results row, cards and request buttons).
//
// Public surface: JE.core.ui { escapeHtml, toast, injectCss, removeCss,
// addTouchTapListener }.
// Aliases kept: JE.escapeHtml, JE.toast, JE.helpers.addCSS/removeCSS/escHtml.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    /**
     * Escapes HTML special characters to prevent XSS when interpolating into
     * HTML strings (innerHTML sinks, template literals, JE.toast, ...).
     * Non-string values are stringified first (null/undefined become '').
     * @param {*} str - The value to escape.
     * @returns {string} The escaped string safe for HTML interpolation.
     */
    function escapeHtml(str) {
        const s = typeof str === 'string' ? str : String(str ?? '');
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Add custom CSS to the page, deduped by id. Injecting the same id again
     * replaces the previous style element.
     * @param {string} id - Unique ID for the style element
     * @param {string} css - The CSS content
     */
    function injectCss(id, css) {
        // Remove existing style with same ID
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
        }

        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        document.head.appendChild(style);

        console.log(`🪼 Jellyfin Enhanced: Added CSS: ${id}`);
    }

    /**
     * Remove injected CSS by ID.
     * @param {string} id - The style element ID
     * @returns {boolean} True if removed
     */
    function removeCss(id) {
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
            console.log(`🪼 Jellyfin Enhanced: Removed CSS: ${id}`);
            return true;
        }
        return false;
    }

    /**
     * Displays a short-lived toast notification (moved from enhanced/ui.js).
     * NOTE: renders via innerHTML — escape user-controlled content with
     * JE.core.ui.escapeHtml before passing it in.
     * @param {string} html The (already localized/escaped) content to display.
     * @param {number} [duration] How long to show the toast, in ms.
     */
    function toast(html, duration) {
        const ms = duration ?? ((JE.CONFIG && JE.CONFIG.TOAST_DURATION) || 1500);

        // Use the theme system to get appropriate colors
        const themeVars = JE.themer?.getThemeVariables() || {};
        const toastBg = themeVars.secondaryBg || 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
        const toastBorder = `1px solid ${themeVars.primaryAccent || 'rgba(255,255,255,0.1)'}`;
        const blurValue = themeVars.blur || '30px';

        const t = document.createElement('div');
        t.className = 'jellyfin-enhanced-toast';
        Object.assign(t.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            transform: 'translateX(100%)',
            background: toastBg,
            color: '#fff',
            padding: '10px 14px',
            borderRadius: '8px',
            zIndex: 99999,
            fontSize: 'clamp(13px, 2vw, 16px)',
            textShadow: '-1px -1px 10px black',
            fontWeight: '500',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            backdropFilter: `blur(${blurValue})`,
            border: toastBorder,
            transition: 'transform 0.3s ease-out',
            maxWidth: 'clamp(280px, 80vw, 350px)'
        });
        t.innerHTML = html; // Note: the calling function should pass the localized string
        document.body.appendChild(t);
        setTimeout(() => t.style.transform = 'translateX(0)', 10);
        setTimeout(() => {
            t.style.transform = 'translateX(100%)';
            setTimeout(() => t.remove(), 300);
        }, ms);
    }

    // Most recent scroll seen anywhere in the document (capture phase sees the
    // results row's own scroll events too). Lets tap detection tell a
    // tap-that-stops-a-momentum-fling — for which browsers suppress the synthetic
    // click, so native cards do nothing — apart from a deliberate tap. The target
    // is kept so only scrolls of a container that actually holds the tapped
    // element count; a sibling row still coasting must not reject taps here.
    let lastScrollTs = 0;
    let lastScrollTarget = null;
    document.addEventListener('scroll', (e) => {
        lastScrollTs = Date.now();
        lastScrollTarget = e.target;
    }, { capture: true, passive: true });

    /**
     * Registers a scroll-friendly touch "tap" handler on an element.
     *
     * A non-passive `touchstart` handler that calls `preventDefault()` cancels the
     * native scroll gesture, so any swipe starting on the element goes dead — on
     * phones this froze the horizontal Seerr results row, whose surface is almost
     * entirely posters/buttons. Instead, listen passively and only treat the touch
     * as a tap on `touchend` when the finger has not moved beyond a small
     * threshold; swipes fall through to the browser's native scrolling.
     *
     * @param {HTMLElement} element - Element to attach the tap handler to.
     * @param {Function} onTap - Called with the `touchend` event for genuine taps.
     *                           May call `event.preventDefault()` to suppress the
     *                           synthetic click that follows a tap.
     */
    function addTouchTapListener(element, onTap) {
        // Movement beyond this many pixels means the touch is a scroll/swipe, not a tap.
        const TAP_MOVE_THRESHOLD_PX = 10;
        // A touch starting within this window of a scroll event is stopping a
        // momentum fling, not tapping — momentum emits scroll events continuously.
        const SCROLL_QUIET_WINDOW_MS = 100;
        let trackedTouchId = null;
        let startX = 0;
        let startY = 0;
        let moved = false;
        let stoppedFling = false;

        const exceedsThreshold = (touch) =>
            Math.abs(touch.clientX - startX) > TAP_MOVE_THRESHOLD_PX ||
            Math.abs(touch.clientY - startY) > TAP_MOVE_THRESHOLD_PX;

        element.addEventListener('touchstart', (e) => {
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
            const touch = Array.from(e.changedTouches).find(t => element.contains(t.target)) ||
                e.changedTouches[0];
            trackedTouchId = touch.identifier;
            moved = false;
            stoppedFling = (Date.now() - lastScrollTs < SCROLL_QUIET_WINDOW_MS) &&
                !!(lastScrollTarget && lastScrollTarget.contains && lastScrollTarget.contains(element));
            startX = touch.clientX;
            startY = touch.clientY;
        }, { passive: true });

        element.addEventListener('touchmove', (e) => {
            if (moved || trackedTouchId === null) return;
            const touch = Array.from(e.touches).find(t => t.identifier === trackedTouchId);
            if (touch && exceedsThreshold(touch)) {
                moved = true;
            }
        }, { passive: true });

        // System gestures (e.g. iOS edge swipes) cancel the touch without a touchend.
        element.addEventListener('touchcancel', () => {
            trackedTouchId = null;
        }, { passive: true });

        // Non-passive so the synthetic click can be suppressed via preventDefault();
        // preventDefault on touchend cannot block scrolling.
        element.addEventListener('touchend', (e) => {
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
        }, { passive: false });
    }

    JE.core.ui = {
        escapeHtml,
        toast,
        injectCss,
        removeCss,
        addTouchTapListener
    };

    // Frozen-contract aliases: these are the canonical implementations now.
    JE.escapeHtml = escapeHtml;
    JE.toast = toast;

    console.log('🪼 Jellyfin Enhanced: UI kit core initialized');

})(window.JellyfinEnhanced);
