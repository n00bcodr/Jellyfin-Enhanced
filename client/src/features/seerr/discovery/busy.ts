// A section's list while it is being replaced (a new order, a filter): it keeps its height and stays on
// screen, dimmed, until the new cards are in, and a change that takes long shows Jellyfin's own loading
// circle over it. Published as JE.discoveryBusy { circle, hold, release, mark, heldAt, HOLD_LIST_MS }.
import busyCss from './discovery-busy.css';
import { injectStyleOnce } from './discovery-styles';
import type { DiscoveryBusyFacade } from './types';

/** How long a list being rebuilt keeps its height at most (ms). */
export const HOLD_LIST_MS = 8000;

/**
 * Jellyfin's loading circle, in the markup its own loading module draws, so its stylesheet and the
 * active theme draw it. Shown (by the section's stylesheet, after a moment) while a section's list
 * is being replaced: over the list, and in the foot of the Filters menu where that covers the list.
 */
export function circle(className: string): HTMLElement {
    const row = document.createElement('div');
    row.className = className;
    row.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('div');
    spinner.className = 'mdl-spinner mdlSpinnerActive';
    for (const layer of [1, 2, 3, 4]) {
        const one = document.createElement('div');
        one.className = `mdl-spinner__layer mdl-spinner__layer-${layer}`;
        for (const [side, part] of [['left', 'Left'], ['right', 'Right']] as const) {
            const clip = document.createElement('div');
            clip.className = `mdl-spinner__circle-clipper mdl-spinner__${side}`;
            const arc = document.createElement('div');
            arc.className = `mdl-spinner__circle mdl-spinner__circle${part}`;
            clip.appendChild(arc);
            one.appendChild(clip);
        }
        spinner.appendChild(one);
    }
    row.appendChild(spinner);
    return row;
}

/** Where the page stands when a section's header is held at the top of the screen, just so. */
export function heldAt(section: HTMLElement, header: HTMLElement): number {
    const bar = parseFloat(section.style.getPropertyValue('--jellyseerr-sticky-top')) || 0;
    const tuck = parseFloat(header.style.getPropertyValue('--jellyseerr-header-tuck')) || 0;
    return section.getBoundingClientRect().top + window.scrollY - bar + tuck + 2;
}

export function createDiscoveryBusy(): DiscoveryBusyFacade {
    /**
     * Each held list's give-up timer. A newer change replaces it, and the release ends it, so an earlier
     * change's timer never lets go of a later change's hold.
     */
    const holdTimers = new WeakMap<HTMLElement, number>();

    /** For a change that takes long: Jellyfin's own loading circle over the section's list (the stylesheet shows it, after a moment). */
    function mark(section: Element | null | undefined): void {
        const list = section?.querySelector('.itemsContainer');
        if (section && list && !section.querySelector('.jellyseerr-busy')) list.before(circle('jellyseerr-busy'));
    }

    /**
     * A list about to be rebuilt (a new order, a filter) keeps its height until the new cards are
     * in: emptied, it would let the page fall away under the viewer and move the control just used.
     * Outside a discovery section (the Recommendations page's controls) it does nothing.
     */
    function hold(control: Element | null | undefined): void {
        const section = control?.closest?.('.jellyseerr-discovery-section');
        const list = section?.querySelector<HTMLElement>('.itemsContainer');
        if (!section || !list) return;
        list.style.minHeight = `${list.offsetHeight}px`;
        list.dataset.held = section.querySelector('.jellyseerr-discovery-header')?.hasAttribute('data-stuck') ? 'stuck' : 'join';
        mark(section);
        // (Should the new cards never come, the height is not kept for ever.)
        window.clearTimeout(holdTimers.get(list));
        holdTimers.set(list, window.setTimeout(() => release(list), HOLD_LIST_MS));
    }

    /** The rebuilt list takes its own height; read under a held header, it starts again right under it. */
    function release(list: HTMLElement | null | undefined): void {
        if (!list) return;
        window.clearTimeout(holdTimers.get(list));
        holdTimers.delete(list);
        const held = list.dataset.held;
        if (!held) return;
        delete list.dataset.held;
        const section = list.closest<HTMLElement>('.jellyseerr-discovery-section');
        const header = section?.querySelector<HTMLElement>('.jellyseerr-discovery-header');
        if (held === 'stuck' && section && header) window.scrollTo({ top: heldAt(section, header) });
        list.style.minHeight = '';
    }

    injectStyleOnce('jellyseerr-discovery-busy-styles', busyCss);
    return { circle, hold, release, mark, heldAt, HOLD_LIST_MS };
}
