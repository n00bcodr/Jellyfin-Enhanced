import type { LayoutHost } from './layout-runtime-types';
import type { LayoutFns, LayoutState } from './state';

/** Faces come in bursts (a family's weights, a script's subsets): the cards are gone through once, this long after the first (ms). */
const FONTS_SETTLE_MS = 150;

/** @returns A font face's unicode-range ("U+0000-00FF, U+0131, U+4??") as [from, to] code points. */
export function unicodeRanges(text: string): number[][] {
    const ranges: number[][] = [];
    for (const part of String(text || 'U+0-10FFFF').split(',')) {
        const found = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part);
        if (!found || !found[1]) continue;
        const from = parseInt(found[1].replace(/\?/g, '0'), 16);
        const to = found[2] ? parseInt(found[2], 16) : parseInt(found[1].replace(/\?/g, 'F'), 16);
        if (from <= to) ranges.push([from, to]);
    }
    return ranges;
}

/**
 * Fonts that arrive after tags were drawn (upstream abcaa16d, core/tag-layout.js). They give chips other widths: an
 * icon is a word until its font has come, several times as wide. A card fitted before that hid chips there is room
 * for (a "+1" where the chip fits), and nothing else would fit it again; and every right-aligned container has another
 * corner. So when fonts have arrived, the cards they concern are fitted again where they are fitted, and measured
 * again for their whole pixels otherwise.
 *
 * A page loads fonts all the time that no tag is drawn in: Jellyfin's text font comes in a hundred subsets, one for
 * each script a title needs, as titles scroll into view. A card is concerned only if a face that arrived can draw a
 * character of its tags' text, and a load that brought no face (it failed) concerns none.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createFontsRefit(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    void JE;
    /** Whether fonts arriving are heard (watchFonts). */
    let fontsWatched = false;
    let fontsDue: ReturnType<typeof setTimeout> | 0 = 0;
    /** The characters the faces that arrived since the cards were last gone through can draw ([from, to]); null: not known, so any. */
    let fontRanges: number[][] | null = [];

    function watchFonts(): void {
        if (fontsWatched) return;
        fontsWatched = true;
        try {
            document.fonts?.addEventListener?.('loadingdone', (event) => {
                const faces = (event as FontFaceSetLoadEvent | undefined)?.fontfaces;
                if (faces && !faces.length) return;
                if (!faces) fontRanges = null;
                else if (fontRanges) {
                    try { for (const face of faces) fontRanges.push(...unicodeRanges(face.unicodeRange)); } catch { fontRanges = null; }
                }
                if (!fontsDue) fontsDue = setTimeout(refitForFonts, FONTS_SETTLE_MS);
            });
        } catch { /* no font loading to hear of */ }
    }

    /** Go through the cards the fonts that arrived concern (watchFonts). */
    function refitForFonts(): void {
        fontsDue = 0;
        const ranges = fontRanges;
        fontRanges = [];
        /** Whether a character can be drawn by a face that arrived. */
        const drawn = new Map<number, boolean>();
        const concerns = (host: HTMLElement) => {
            if (!ranges) return true;
            const text = host.textContent || '';
            for (let i = 0; i < text.length; i++) {
                const code = text.codePointAt(i) ?? 0;
                if (code > 0xffff) i++;
                if (code <= 0x20) continue;
                let can = drawn.get(code);
                if (can === undefined) { can = ranges.some(([from = 0, to = 0]) => code >= from && code <= to); drawn.set(code, can); }
                if (can) return true;
            }
            return false;
        };
        for (const host of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
            const ctrl = s.controllers.get(host);
            if (!ctrl || !ctrl.layout || !concerns(host)) continue;
            // Under the pointer or holding focus a theme may have the card zoomed, and widths read then are scaled
            // against room that is not: it is fitted when that is over (snapLater).
            const card = host.closest('.card, .listItem') || host.parentElement;
            let busy = false;
            try { busy = !!card && card.matches(':hover, :focus-within'); } catch { busy = false; }
            if (busy) { ctrl.refit = true; deps.snapLater(ctrl); continue; }
            // (A card that is fitted is measured after its fit; scheduleFit takes its nudges off for it.)
            deps.scheduleFit(ctrl);
            if (!s.pendingFit.has(ctrl) && deps.snapSupported()) deps.snapAgain(ctrl);
        }
    }

    return { watchFonts };
}
