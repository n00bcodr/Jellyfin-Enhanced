import type { LayoutHost } from './layout-runtime-types';
import { REST_AFTER_MS, type LayoutFns, type LayoutState } from './state';

/**
 * Live cards (upstream abcaa16d, core/tag-layout.js). A card the pointer is on (where it does not hide the tags) or
 * that holds focus is laid out positioned, as it always was: its genre names can float from their icons, and CSS
 * written for a hovered or focused card finds what it was written against. Flow is for cards at rest. The host
 * carries data-je-live meanwhile, and goes back to flow once the pointer and focus have left.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createLive(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    void JE;
    /** Cards whose focus leaving is heard (watchFocusOut). */
    const focusWatched = new WeakSet<Element>();

    /**
     * Whether the pointer hides this card's tags instead of revealing them: "Hide tags on hover" is on and the card's
     * layout has no hover reveal of its own (the stylesheet rules keyed off body.je-tags-hide-on-hover).
     */
    function hidesOnHover(host: HTMLElement | null): boolean {
        if (!host || !document.body?.classList.contains('je-tags-hide-on-hover')) return false;
        const layout = host.dataset.jeLayout;
        return layout !== 'summary' && layout !== 'minimal';
    }

    /** Whether a card is not at rest: it holds focus, or the pointer is on it and reveals rather than hides its tags. */
    function notAtRest(host: HTMLElement): boolean {
        try {
            const card = host.closest('.card, .listItem');
            const at = !!card && (card.matches(':focus-within') || (!hidesOnHover(host) && card.matches(':hover')));
            if (at && card) watchFocusOut(card);
            return at;
        } catch {
            return false;
        }
    }

    /**
     * Hear focus leaving a card that has gone live, on the card itself (focusout bubbles from what is inside it). A
     * live card goes back to flow when focus goes outside it (restLater).
     */
    function watchFocusOut(card: Element): void {
        if (focusWatched.has(card)) return;
        focusWatched.add(card);
        card.addEventListener('focusout', (event) => {
            const to = event instanceof FocusEvent && event.relatedTarget instanceof Node ? event.relatedTarget : null;
            if (!(to && card.contains(to))) restLater(card);
        });
    }

    /**
     * Lay a flow card out positioned while the pointer is on it or it holds focus (data-je-live; the stylesheet's flow
     * rules skip a live host). It starts as "in", which holds genre names at opacity 0 for one style pass: an element
     * that was not rendered has nothing to fade in from. showNames() then lets them fade.
     * @returns True when the host went live now.
     */
    function goLive(host: HTMLElement | null): boolean {
        if (!host || host.dataset.jeFlow !== '1') return false;
        const due = s.restTimers.get(host);
        if (due !== undefined) { clearTimeout(due); s.restTimers.delete(host); }
        if (host.dataset.jeLive) return false;
        host.dataset.jeLive = 'in';
        const card = host.closest('.card, .listItem');
        if (card) watchFocusOut(card);
        return true;
    }

    /** Let a host that just went live fade its genre names in (the styles are read once first, so the browser has their starting opacity). */
    function showNames(host: HTMLElement): void {
        if (host.dataset.jeLive !== 'in') return;
        const name = host.querySelector('.genre-tag > .genre-text');
        try { if (name) void getComputedStyle(name).opacity; } catch { /* no styles to read: nothing to fade from */ }
        host.dataset.jeLive = '1';
    }

    /** Put a live host back in flow once the pointer has left its card and the names have faded (unless the pointer came back meanwhile). */
    function restLater(card: Element): void {
        const host = card.querySelector<HTMLElement>('.je-tag-host[data-je-live]');
        if (!host || s.restTimers.has(host)) return;
        s.restTimers.set(host, setTimeout(() => {
            s.restTimers.delete(host);
            // Still focused: its focusout comes. Still hovered: a pointer that leaves says so, a touch does not (lingering).
            if (notAtRest(host)) {
                let over = false;
                try { over = card.matches(':hover'); } catch { over = false; }
                if (over) s.lingering = host;
                return;
            }
            delete host.dataset.jeLive;
            // What was placed while the card was live has not been asked about or inspected.
            const ctrl = s.controllers.get(host);
            if (ctrl && host.isConnected) deps.syncFlow(ctrl, deps.resolveLayout(ctrl));
        }, REST_AFTER_MS));
    }

    return { hidesOnHover, notAtRest, goLive, showNames, restLater };
}
