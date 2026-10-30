/**
 * @file Settings panel size: a resize grip in the bottom-right corner, grab
 * zone on the bottom edge, and Default / Large / Fill presets in
 * the header (with Reset size once a dragged size is in use).
 *
 * The chosen size is kept per user in localStorage (JE_panelSize_<userId>)
 * and clamped to the window on open and on every window resize; the stored
 * value is never shrunk by a smaller window, so a larger window gets it back.
 * Below 900px wide the panel keeps its built-in size (full screen on a phone)
 * and the controls are hidden. Only the panel's outer box changes: the header
 * and footer keep their height and the columns inside reflow.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const STORE_PREFIX = 'JE_panelSize_';
    const MIN_WIDTH = 720;
    const MIN_HEIGHT = 480;
    /** Space kept between the panel and every window edge, in px. */
    const GUTTER = 24;
    const DESKTOP_QUERY = '(min-width: 900px)';
    const KEY_STEP = 16;
    const KEY_STEP_LARGE = 64;
    const PRESETS = ['default', 'large', 'fill'];
    /** The built-in size (also the panel's inline style in ui-panel.js). */
    const DEFAULT_STYLE = { width: 'min(1040px, 94vw)', height: 'min(720px, 90vh)', maxWidth: '94vw', maxHeight: '90vh', boxSizing: '' };

    const escapeHtml = (value) => JE.escapeHtml(value);

    /**
     * @typedef {{preset: 'default'|'large'|'fill'}|{preset: 'custom', width: number, height: number}} PanelSize
     */

    /** @returns {string} The storage key for the signed-in user. */
    const storeKey = () => `${STORE_PREFIX}${(typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || ''}`;

    /**
     * Read the stored size. Anything unreadable or malformed counts as Default.
     * @param {string} key - Identity captured when this panel opened.
     * @returns {PanelSize}
     */
    function readSize(key) {
        let raw = null;
        try {
            raw = localStorage.getItem(key);
        } catch (err) {
            return { preset: 'default' };
        }
        if (!raw) return { preset: 'default' };
        try {
            const value = JSON.parse(raw);
            if (value && PRESETS.includes(value.preset)) return { preset: value.preset };
            if (value && value.preset === 'custom' && Number.isFinite(value.width) && Number.isFinite(value.height)
                && value.width > 0 && value.height > 0) {
                return { preset: 'custom', width: Math.round(value.width), height: Math.round(value.height) };
            }
        } catch (err) {
            // Not JSON: fall through to Default.
        }
        return { preset: 'default' };
    }

    /**
     * Store the size; Default removes the entry.
     * @param {PanelSize} size
     * @param {string} key - Identity captured when this panel opened.
     */
    function writeSize(size, key) {
        try {
            if (size.preset === 'default') localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify(size));
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not save the panel size', err);
        }
    }

    /**
     * The allowed size range for the current window: at least 720×480, at most
     * the window minus the gutter on each side (the maximum wins on a window
     * too small for the minimum).
     * @returns {{minWidth: number, minHeight: number, maxWidth: number, maxHeight: number}}
     */
    function sizeBounds() {
        const maxWidth = Math.max(0, window.innerWidth - GUTTER * 2);
        const maxHeight = Math.max(0, window.innerHeight - GUTTER * 2);
        return { minWidth: Math.min(MIN_WIDTH, maxWidth), minHeight: Math.min(MIN_HEIGHT, maxHeight), maxWidth, maxHeight };
    }

    /**
     * Clamp a width and height to the allowed range.
     * @param {number} width
     * @param {number} height
     * @returns {{width: number, height: number}}
     */
    function clampSize(width, height) {
        const b = sizeBounds();
        return {
            width: Math.round(Math.min(b.maxWidth, Math.max(b.minWidth, width))),
            height: Math.round(Math.min(b.maxHeight, Math.max(b.minHeight, height)))
        };
    }

    /**
     * The pixel size a stored choice stands for in the current window.
     * @param {PanelSize} size - Not Default (that one is left to the CSS).
     * @returns {{width: number, height: number}}
     */
    function resolveSize(size) {
        if (size.preset === 'large') return clampSize(window.innerWidth * 0.9, window.innerHeight * 0.9);
        if (size.preset === 'fill') return clampSize(Infinity, Infinity);
        return clampSize(size.width, size.height);
    }

    /**
     * The header controls (presets and Reset size). Hidden until wired, so
     * nothing shows where the wiring does not run.
     * @returns {string} HTML for the panel header.
     */
    internal.buildPanelSizeControlsHtml = function() {
        const names = { default: JE.t('panel_size_default'), large: JE.t('panel_size_large'), fill: JE.t('panel_size_fill') };
        const preset = (name) => `<button type="button" class="je-panel-size-btn" data-je-panel-size="${name}" aria-pressed="false">${escapeHtml(names[name])}</button>`;
        return `<div class="je-panel-size" role="group" aria-label="${escapeHtml(JE.t('panel_size_label'))}" hidden>`
            + PRESETS.map(preset).join('')
            + `<button type="button" class="je-panel-size-btn je-panel-size-reset" data-je-panel-size-reset hidden>${escapeHtml(JE.t('panel_size_reset'))}</button>`
            + '</div>';
    };

    /**
     * The grip and the bottom edge grab zone, placed last in the panel.
     * @returns {string} HTML appended after the panel footer.
     */
    internal.buildPanelResizeHandlesHtml = function() {
        return '<div class="je-panel-edge je-panel-edge--y" data-je-resize="y" aria-hidden="true" hidden></div>'
            + `<button type="button" class="je-panel-grip" data-je-resize="both" aria-label="${escapeHtml(JE.t('panel_size_grip'))}" title="${escapeHtml(JE.t('panel_size_grip_hint'))}" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" aria-describedby="jePanelSizeStatus" hidden>`
            + '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M15 5 5 15M15 9.5 9.5 15M15 13.5 13.5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>'
            + '</button><span id="jePanelSizeStatus" class="je-panel-size-status" role="status" aria-live="polite" aria-atomic="true"></span>';
    };

    /** The panel-scoped stylesheet for the controls and the grip. */
    const RESIZE_CSS = `
        #jellyfin-enhanced-panel .je-panel-size-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        #jellyfin-enhanced-panel .je-panel-size { display: inline-flex; align-self: center; margin: 0 40px 0 auto; padding: 2px; gap: 2px; border-radius: 8px; background: rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-panel-size[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-panel-size-btn { min-height: 26px; padding: 3px 10px; border: 0; border-radius: 6px; background: transparent; color: rgba(255,255,255,0.75); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-panel-size-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        #jellyfin-enhanced-panel .je-panel-size-btn[aria-pressed="true"] { background: rgba(255,255,255,0.2); color: #fff; }
        #jellyfin-enhanced-panel .je-panel-size-btn[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-panel-size-reset { margin-left: 4px; border: 1px dashed rgba(255,255,255,0.35); }
        #jellyfin-enhanced-panel .je-panel-size-btn:focus-visible, #jellyfin-enhanced-panel .je-panel-grip:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
        #jellyfin-enhanced-panel .je-panel-edge { position: absolute; z-index: 5; touch-action: none; }
        #jellyfin-enhanced-panel .je-panel-edge--y { left: 0; right: 24px; bottom: 0; height: 5px; cursor: ns-resize; }
        #jellyfin-enhanced-panel .je-panel-grip { position: absolute; z-index: 6; right: 4px; bottom: 4px; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: rgba(255,255,255,0.55); cursor: nwse-resize; touch-action: none; display: flex; }
        #jellyfin-enhanced-panel .je-panel-grip:hover, #jellyfin-enhanced-panel.je-panel-resizing .je-panel-grip { color: #fff; }
        #jellyfin-enhanced-panel :is(.je-panel-edge, .je-panel-grip)[hidden] { display: none; }
        #jellyfin-enhanced-panel.je-panel-resizing, #jellyfin-enhanced-panel.je-panel-resizing * { user-select: none; -webkit-user-select: none; }
        #jellyfin-enhanced-panel.je-panel-resizing[data-je-resize-axis="both"] * { cursor: nwse-resize !important; }
        #jellyfin-enhanced-panel.je-panel-resizing[data-je-resize-axis="y"] * { cursor: ns-resize !important; }
    `;

    /**
     * Wire the size controls of an open panel. Every listener outside the
     * panel element is dropped through ctx.onClose.
     * @param {{help: HTMLElement, resetAutoCloseTimer: Function, closePanel: Function, onClose: (fn: Function) => void}} ctx
     */
    internal.wirePanelResize = function(ctx) {
        const { help } = ctx;
        const controls = /** @type {HTMLElement|null} */ (help.querySelector('.je-panel-size'));
        const reset = /** @type {HTMLElement|null} */ (help.querySelector('[data-je-panel-size-reset]'));
        const presetButtons = /** @type {HTMLElement[]} */ (Array.from(help.querySelectorAll('[data-je-panel-size]')));
        const handles = /** @type {HTMLElement[]} */ (Array.from(help.querySelectorAll('[data-je-resize]')));
        if (!controls && !handles.length) return;
        JE.core.ui?.injectCss?.('je-panel-resize', RESIZE_CSS);

        const desktop = window.matchMedia(DESKTOP_QUERY);
        const key = storeKey();
        let closed = false;
        let size = readSize(key);
        /** Close the old user's panel through the shared teardown. */
        const identityChanged = () => { if (!closed) ctx.closePanel(); };
        /** Reject stale input even before the session event has been delivered. */
        const sameIdentity = () => {
            if (closed) return false;
            if (storeKey() === key) return true;
            identityChanged();
            return false;
        };
        document.addEventListener('je:user-changed', identityChanged);
        /** @type {{handle: HTMLElement, pointerId: number, axis: string, x: number, y: number, width: number, height: number, centred: boolean, left: number, moved: boolean}|null} */
        let drag = null;

        const status = help.querySelector('#jePanelSizeStatus');
        let announcementTimer = null;
        let pendingAnnouncement = '';
        /** Announce the latest size, coalescing pointer updates to one per 250ms. */
        const announce = (box, maximum = false, coalesce = false) => {
            pendingAnnouncement = JE.t('panel_size_status', { width: String(Math.round(box.width)), height: String(Math.round(box.height)) })
                + (maximum ? `. ${JE.t('panel_size_maximum')}` : '');
            const publish = () => {
                announcementTimer = null;
                if (status) status.textContent = pendingAnnouncement;
            };
            if (coalesce) {
                if (!announcementTimer) announcementTimer = setTimeout(publish, 250);
            } else {
                if (announcementTimer) clearTimeout(announcementTimer);
                publish();
            }
        };

        /** @returns {boolean} The panel was moved by its header (no longer centred). */
        const isMoved = () => help.style.transform === 'none';

        /**
         * Put a panel moved by its header back inside the window gutter.
         * @param {number} width
         * @param {number} height
         */
        const keepInView = (width, height) => {
            if (!isMoved()) return;
            const rect = help.getBoundingClientRect();
            const left = Math.max(GUTTER, Math.min(rect.left, window.innerWidth - GUTTER - width));
            const top = Math.max(GUTTER, Math.min(rect.top, window.innerHeight - GUTTER - height));
            help.style.left = `${Math.round(left)}px`;
            help.style.top = `${Math.round(top)}px`;
        };

        /**
         * Set the panel's box to a pixel size (already clamped).
         * @param {{width: number, height: number}} box
         */
        const setBox = (box) => {
            Object.assign(help.style, {
                // The measured box includes the border, so the set size must too,
                // or every stored or keyed size would drift by the border width.
                boxSizing: 'border-box',
                width: `${box.width}px`,
                height: `${box.height}px`,
                maxWidth: `calc(100vw - ${GUTTER * 2}px)`,
                maxHeight: `calc(100vh - ${GUTTER * 2}px)`
            });
            keepInView(box.width, box.height);
        };

        /** Show the current choice on the controls. */
        const syncControls = () => {
            presetButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.jePanelSize === size.preset)));
            if (reset) reset.hidden = size.preset !== 'custom';
        };

        /** Apply the stored choice to the current window (no write). */
        const apply = () => {
            const wide = desktop.matches;
            if (controls) controls.hidden = !wide;
            handles.forEach((handle) => { handle.hidden = !wide; });
            if (!wide || size.preset === 'default') {
                Object.assign(help.style, DEFAULT_STYLE);
                if (!wide) Object.assign(help.style, { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' });
                if (wide) {
                    const rect = help.getBoundingClientRect();
                    keepInView(rect.width, rect.height);
                }
            } else {
                setBox(resolveSize(size));
            }
            syncControls();
            announce(help.getBoundingClientRect());
        };

        /**
         * Choose and store a size.
         * @param {PanelSize} next
         */
        const choose = (next) => {
            if (!sameIdentity()) return;
            size = next;
            writeSize(size, key);
            apply();
            ctx.resetAutoCloseTimer();
        };

        presetButtons.forEach((button) => {
            button.addEventListener('click', () => {
                // A preset centres a panel moved by its header again.
                if (isMoved()) Object.assign(help.style, { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' });
                choose({ preset: /** @type {'default'|'large'|'fill'} */ (button.dataset.jePanelSize) });
            });
        });
        reset?.addEventListener('click', () => {
            choose({ preset: 'default' });
            // The button hides itself; keep keyboard focus in the group.
            presetButtons.find((b) => b.dataset.jePanelSize === 'default')?.focus();
        });

        /** End a drag; a drag that changed the size stores it. */
        const endDrag = (save = true) => {
            if (!drag) return;
            const { moved, handle, pointerId } = drag;
            drag = null;
            try { if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId); } catch (err) { /* already released */ }
            help.classList.remove('je-panel-resizing');
            help.removeAttribute('data-je-resize-axis');
            if (moved && save) {
                const rect = help.getBoundingClientRect();
                choose({ preset: 'custom', width: Math.round(rect.width), height: Math.round(rect.height) });
            }
        };

        handles.forEach((handle) => {
            handle.addEventListener('pointerdown', (e) => {
                if (!sameIdentity() || drag || e.button !== 0 || !desktop.matches) return;
                e.preventDefault();
                e.stopPropagation();
                const rect = help.getBoundingClientRect();
                drag = {
                    handle, pointerId: e.pointerId, axis: handle.dataset.jeResize || 'both',
                    x: e.clientX, y: e.clientY, width: rect.width, height: rect.height,
                    // A centred panel grows on both sides, so the edge follows the
                    // pointer at twice the pointer's distance.
                    centred: !isMoved(), left: rect.left, moved: false
                };
                try { handle.setPointerCapture?.(e.pointerId); } catch (err) { /* capture is a nicety */ }
                help.classList.add('je-panel-resizing');
                help.dataset.jeResizeAxis = drag.axis;
                ctx.resetAutoCloseTimer();
            });
            handle.addEventListener('pointermove', (e) => {
                if (!sameIdentity() || !desktop.matches || !drag || e.pointerId !== drag.pointerId) return;
                const factor = drag.centred ? 2 : 1;
                let width = drag.axis === 'y' ? drag.width : drag.width + (e.clientX - drag.x) * factor;
                const height = drag.axis === 'x' ? drag.height : drag.height + (e.clientY - drag.y) * factor;
                // A moved panel is anchored top-left: its right edge stops at the gutter.
                if (!drag.centred) width = Math.min(width, window.innerWidth - GUTTER - drag.left);
                drag.moved = true;
                const box = clampSize(width, height);
                setBox(box);
                announce(box, width > box.width || height > box.height, true);
            });
            /** Only the pointer that owns the drag may finish it. */
            const endOwnedDrag = (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(); };
            handle.addEventListener('pointerup', endOwnedDrag);
            handle.addEventListener('pointercancel', endOwnedDrag);
            handle.addEventListener('lostpointercapture', endOwnedDrag);
        });

        // Arrow keys on the grip: Left/Right change the width, Up/Down the
        // height (Shift for bigger steps). Other keys (Escape, Tab) pass.
        const grip = handles.find((handle) => handle.dataset.jeResize === 'both');
        grip?.addEventListener('keydown', (e) => {
            const steps = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
            if (!sameIdentity() || !steps || !desktop.matches || e.altKey || e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
            const rect = help.getBoundingClientRect();
            const box = clampSize(rect.width + steps[0] * step, rect.height + steps[1] * step);
            choose({ preset: 'custom', width: box.width, height: box.height });
            announce(box, (steps[0] > 0 && box.width <= rect.width) || (steps[1] > 0 && box.height <= rect.height));
        });

        // Selecting text while the pointer is captured would highlight the page.
        const blockSelection = (e) => { if (drag) e.preventDefault(); };
        document.addEventListener('selectstart', blockSelection);
        const handleWindowResize = () => { endDrag(false); apply(); };
        window.addEventListener('resize', handleWindowResize);
        desktop.addEventListener('change', handleWindowResize);
        ctx.onClose(() => {
            closed = true;
            if (announcementTimer) clearTimeout(announcementTimer);
            document.removeEventListener('je:user-changed', identityChanged);
            document.removeEventListener('selectstart', blockSelection);
            window.removeEventListener('resize', handleWindowResize);
            desktop.removeEventListener('change', handleWindowResize);
            endDrag(false);
        });

        apply();
    };
})(window.JellyfinEnhanced);
