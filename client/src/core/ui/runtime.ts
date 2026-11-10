import type { UiHost } from '../../host/ui-host';
import { createTapTracker } from './tap-tracker';

/** Browser primitives are injected; scroll and gesture ownership stays in this instance. */
export function createUi(host: UiHost) {
    const document = host.document;
    /**
     * Escapes HTML special characters to prevent XSS when interpolating into
     * HTML strings (innerHTML sinks, template literals, JE.toast, ...).
     * Non-string values are stringified first (null/undefined become '').
     * @param str - The value to escape.
     * @returns The escaped string safe for HTML interpolation.
     */
    function escapeHtml(str: unknown) {
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
     * @param id - Unique ID for the style element
     * @param css - The CSS content
     */
    function injectCss(id: string, css: string) {
        // Remove existing style with same ID
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
        }

        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        document.head.appendChild(style);

    }

    /**
     * Remove injected CSS by ID.
     * @param id - The style element ID
     * @returns True if removed
     */
    function removeCss(id: string) {
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
            host.log(`Removed CSS: ${id}`);
            return true;
        }
        return false;
    }

    /**
     * Displays a short-lived toast notification (moved from enhanced/ui.js).
     * NOTE: renders via innerHTML — escape user-controlled content with
     * JE.core.ui.escapeHtml before passing it in.
     * @param html The (already localized/escaped) content to display.
     * @param [duration] How long to show the toast, in ms.
     */
    function toast(html: string, duration?: number) {
        const ms = duration ?? (host.toastDuration() || 1500);

        // Use the theme system to get appropriate colors
        const themeVars = host.themeVariables();
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
        host.setTimeout(() => t.style.transform = 'translateX(0)', 10);
        host.setTimeout(() => {
            t.style.transform = 'translateX(100%)';
            host.setTimeout(() => t.remove(), 300);
        }, ms);
    }

    // One capture listener per installed UI runtime; siblings do not cancel taps.
    let lastScrollTs = 0;
    let lastScrollTarget: EventTarget | null = null;
    document.addEventListener('scroll', event => {
        lastScrollTs = host.now();
        lastScrollTarget = event.target;
    }, { capture: true, passive: true });
    const tapHost = {
        contains: host.contains,
        scrolledRecentlyWithin: (element: HTMLElement, quietWindow: number) =>
            host.now() - lastScrollTs < quietWindow && host.contains(lastScrollTarget, element)
    };

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
     * @param element - Element to attach the tap handler to.
     * @param onTap - Called with the `touchend` event for genuine taps.
     *                           May call `event.preventDefault()` to suppress the
     *                           synthetic click that follows a tap.
     */
    function addTouchTapListener(element: HTMLElement, onTap: (event: TouchEvent) => void) {
        const tracker = createTapTracker(element, onTap, tapHost);
        element.addEventListener('touchstart', tracker.start, { passive: true });
        element.addEventListener('touchmove', tracker.move, { passive: true });
        element.addEventListener('touchcancel', tracker.cancel, { passive: true });
        // Non-passive so the synthetic click can be suppressed via preventDefault();
        // preventDefault on touchend cannot block scrolling.
        element.addEventListener('touchend', tracker.end, { passive: false });
    }

    /**
     * Delegated form of addTouchTapListener: one set of touch listeners on
     * `root` serves every element `resolveElement` maps a touch target to
     * (e.g. the poster of each card in a row), instead of four listeners per
     * element. Each element keeps its own tracker (in a WeakMap), so taps are
     * classified exactly as addTouchTapListener does on that element.
     *
     * @param root - Container whose descendants receive the taps.
     * @param resolveElement - Maps a touch
     *   target to the element it is a tap on, or null when it is not one of them.
     * @param onTap - Called with the
     *   `touchend` event and the element for genuine taps. May call
     *   `event.preventDefault()` to suppress the synthetic click.
     */
    function addDelegatedTouchTapListener(root: HTMLElement, resolveElement: (target: Element) => HTMLElement | null, onTap: (event: TouchEvent, element: HTMLElement) => void) {

        const trackers = new WeakMap<HTMLElement, ReturnType<typeof createTapTracker>>();
        /**
         * @param e
         * @param create - Start tracking an element not seen before.
         */
        const trackerFor = (e: Event, create: boolean) => {
            const target = e.target;
            const element = host.isElement(target) ? resolveElement(target) : null;
            if (!element) return null;
            let tracker = trackers.get(element);
            if (!tracker && create) {
                tracker = createTapTracker(element, (event) => onTap(event, element), tapHost);
                trackers.set(element, tracker);
            }
            return tracker || null;
        };
        root.addEventListener('touchstart', (e) => { trackerFor(e, true)?.start(e); }, { passive: true });
        root.addEventListener('touchmove', (e) => { trackerFor(e, false)?.move(e); }, { passive: true });
        root.addEventListener('touchcancel', (e) => { trackerFor(e, false)?.cancel(); }, { passive: true });
        // Non-passive so the synthetic click can be suppressed (see addTouchTapListener).
        root.addEventListener('touchend', (e) => { trackerFor(e, false)?.end(e); }, { passive: false });
    }

    /**
     * Whether Jellyfin's TV layout (remote-driven) is active.
     */
    function isTvLayout() {
        return document.documentElement.classList.contains('layout-tv');
    }

    function ensureSkeletonCss() {
        if (document.getElementById('je-skeleton-css')) return;
        injectCss('je-skeleton-css', `
            .je-skeleton-row { overflow: hidden; }
            .je-skeleton-bar { width: 12em; height: 1.4em; border-radius: 6px; margin-bottom: 0.5em; }
            .je-skeleton-cards { display: flex; padding-top: 0.95em; }
            .je-skeleton-cards > .card { flex: 0 0 auto; }
            .je-skeleton-card { border-radius: 8px; }
            .je-skeleton-text { height: 1.2em; width: 70%; margin: 0.4em auto 0; border-radius: 4px; }
            .je-skeleton-grid { display: grid; gap: 1em; grid-template-columns: repeat(auto-fill, minmax(var(--je-skeleton-min, 340px), 1fr)); }
            .je-skeleton-block { height: var(--je-skeleton-height, 7em); border-radius: 6px; }
            .je-skeleton-bar, .je-skeleton-card, .je-skeleton-text, .je-skeleton-block {
                background: linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.06) 75%);
                background-size: 200% 100%;
                animation: je-skeleton-shimmer 1.4s ease-in-out infinite;
            }
            @keyframes je-skeleton-shimmer {
                from { background-position: 200% 0; }
                to { background-position: -200% 0; }
            }
            @media (prefers-reduced-motion: reduce) {
                .je-skeleton-bar, .je-skeleton-card, .je-skeleton-text, .je-skeleton-block { animation: none; }
            }
        `);
    }

    /**
     * Shimmering placeholder rows of portrait cards, for content that loads
     * as titled card rows. Titles are known up front, so they show as real
     * headings; a null title shows a placeholder bar.
     * @param titles - One entry per row
     * @param [cards=10] - Placeholder cards per row
     * @returns A status element to append, then remove once loaded
     */
    function createSkeletonRows(titles: Array<string | null>, cards = 10) {
        ensureSkeletonCss();
        const el = document.createElement('div');
        el.setAttribute('role', 'status');
        // Jellyfin's own card classes, so width, margins and the 2:3 poster
        // follow the same breakpoints as the real cards.
        const card = '<div class="card overflowPortraitCard"><div class="cardBox cardBox-bottompadded">' +
            '<div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait je-skeleton-card"></div></div>' +
            '<div class="je-skeleton-text"></div><div class="je-skeleton-text" style="width:45%"></div></div></div>';
        el.innerHTML = titles.map(title =>
            '<div class="verticalSection je-skeleton-row">' +
            (title ? `<h2 class="sectionTitle sectionTitle-cards">${escapeHtml(title)}</h2>` : '<div class="je-skeleton-bar"></div>') +
            '<div class="je-skeleton-cards">' + card.repeat(cards) + '</div></div>'
        ).join('');
        return el;
    }

    /**
     * Shimmering placeholder blocks in a responsive grid, as an HTML string
     * for renderers that build markup. A full-width minWidth gives a list.
     * @param count - Number of blocks
     * @param [opts]
     * @returns Markup for a status element
     */
    function skeletonGridHtml(count: number, opts: { minWidth?: string; height?: string; label?: string } = {}) {
        ensureSkeletonCss();
        const { minWidth = '340px', height = '7em', label = '' } = opts;
        return `<div class="je-skeleton-grid" role="status" aria-label="${escapeHtml(label)}" style="--je-skeleton-min:${minWidth};--je-skeleton-height:${height}">` +
            '<div class="je-skeleton-block"></div>'.repeat(count) + '</div>';
    }

    return { escapeHtml, toast, injectCss, removeCss, createSkeletonRows, skeletonGridHtml,
        addTouchTapListener, addDelegatedTouchTapListener, isTvLayout };
}
export type Ui = ReturnType<typeof createUi>;
