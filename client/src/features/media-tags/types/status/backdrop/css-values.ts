// Geometry and CSS values of the status tags' painted backdrop (upstream abcaa16d, tags/status-tag-backdrop.js). Pure.

/** Layout units in a pixel: geometry is compared and written in these. */
export const UNITS = 64;

/** A layout coordinate snapped to the pixel grid the way the browser paints boxes. */
export const snap = (value: number): number => Math.floor(value + 0.5);
/** The value in whole layout units. */
export const units = (value: number): number => Math.round(value * UNITS) / UNITS;

/** A linear gradient this part can draw: the angle in degrees (0: to top, 90: to right) and colour stops placed 0 to 1. */
export interface Gradient { angle: number; stops: Array<{ at: number; colour: string }> }

/** Split a CSS list at its top-level commas (`a, f(b, c)` → two layers). */
export function splitLayers(value: string | null | undefined): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            out.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = text.slice(start).trim();
    if (last) out.push(last);
    return out;
}

/**
 * A computed colour as [r, g, b, a] (a from 0 to 1).
 * @param value - `rgb(…)`, `rgba(…)` or `transparent`.
 * @returns Null for anything else.
 */
export function parseColour(value: string | null | undefined): number[] | null {
    const text = String(value || '').trim();
    if (text === 'transparent') return [0, 0, 0, 0];
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
    if (!m) return null;
    let alpha = 1;
    if (m[4] !== undefined) alpha = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

/** A computed `linear-gradient()` this part can draw: a side or an angle, and rgb colour stops placed by percentages (or not at all). */
export function parseGradient(value: string | null | undefined): Gradient | null {
    const m = /^linear-gradient\((.*)\)$/s.exec(String(value || '').trim());
    if (!m) return null;
    const parts = splitLayers(m[1]);
    let angle = 180;
    const first = parts[0] || '';
    const sides: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
    if (Object.prototype.hasOwnProperty.call(sides, first)) {
        angle = sides[first] ?? 180;
        parts.shift();
    } else if (/^-?[\d.]+deg$/.test(first)) {
        angle = parseFloat(first);
        parts.shift();
    } else if (/^to /.test(first) || /^-?[\d.]+(?:rad|grad|turn)$/.test(first)) {
        return null;
    }
    if (parts.length < 2) return null;
    const stops: Array<{ at: number | null; colour: string }> = [];
    for (const part of parts) {
        const s = /^(rgba?\([^)]*\))(?:\s+(-?[\d.]+)%)?$/.exec(part);
        if (!s || !s[1] || !parseColour(s[1])) return null;
        stops.push({ colour: s[1], at: s[2] === undefined ? null : parseFloat(s[2]) / 100 });
    }
    const at = (i: number) => stops[i]?.at ?? null;
    const set = (i: number, value: number) => { const stop = stops[i]; if (stop) stop.at = value; };
    // Unplaced stops: the ends at 0 and 1, the rest spread evenly; none before the one it follows.
    if (at(0) === null) set(0, 0);
    if (at(stops.length - 1) === null) set(stops.length - 1, 1);
    for (let i = 1; i < stops.length; i++) {
        const own = at(i);
        if (own !== null) {
            set(i, Math.max(own, at(i - 1) ?? 0));
            continue;
        }
        let next = i;
        while (at(next) === null) next++;
        const from = at(i - 1) ?? 0;
        const to = Math.max(from, at(next) ?? 0);
        for (let k = i; k < next; k++) set(k, from + (to - from) * (k - i + 1) / (next - i + 1));
    }
    if (stops.some((stop) => (stop.at ?? 0) < 0 || (stop.at ?? 0) > 1)) return null;
    return { angle, stops: stops.map((stop) => ({ at: stop.at ?? 0, colour: stop.colour })) };
}

/** One coordinate of a computed position or size: a percentage or pixels. */
function parseLength(value: string | null | undefined): { pct: number } | { px: number } | null {
    const m = /^(-?[\d.]+)(%|px)$/.exec(String(value || '').trim());
    if (!m || !m[1]) return null;
    return m[2] === '%' ? { pct: parseFloat(m[1]) / 100 } : { px: parseFloat(m[1]) };
}

/**
 * Where an image lands in its box, in the box's pixels.
 * @param fit - object-fit / background-size, and the computed position.
 * @param scale - Pixels a CSS pixel.
 * @returns Null for values this part does not place.
 */
export function fitImage(naturalWidth: number, naturalHeight: number, boxWidth: number, boxHeight: number, fit: { size: string; position: string }, scale: number): { x: number; y: number; width: number; height: number } | null {
    if (!(naturalWidth > 0 && naturalHeight > 0 && boxWidth > 0 && boxHeight > 0)) return null;
    const size = String(fit.size || '').trim();
    const cover = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
    const contain = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    let width: number | null, height: number | null;
    if (size === 'cover') { width = naturalWidth * cover; height = naturalHeight * cover; }
    else if (size === 'contain') { width = naturalWidth * contain; height = naturalHeight * contain; }
    else if (size === 'fill') { width = boxWidth; height = boxHeight; }
    else if (size === 'none' || size === 'auto' || size === 'auto auto') { width = naturalWidth * scale; height = naturalHeight * scale; }
    else if (size === 'scale-down') {
        const s = Math.min(scale, contain);
        width = naturalWidth * s; height = naturalHeight * s;
    } else {
        const parts = size.split(/\s+/);
        if (parts.length > 2) return null;
        const w = parts[0] === 'auto' ? null : parseLength(parts[0]);
        const h = parts.length < 2 || parts[1] === 'auto' ? null : parseLength(parts[1]);
        if ((parts[0] !== 'auto' && !w) || (parts.length === 2 && parts[1] !== 'auto' && !h)) return null;
        const px = (v: { pct: number } | { px: number }, box: number) => ('pct' in v ? v.pct * box : v.px * scale);
        width = w ? px(w, boxWidth) : null;
        height = h ? px(h, boxHeight) : null;
        if (width === null && height === null) return null;
        if (width === null) width = (height ?? 0) * naturalWidth / naturalHeight;
        if (height === null) height = width * naturalHeight / naturalWidth;
    }
    if (!(width > 0 && height > 0)) return null;
    const position = String(fit.position || '50% 50%').trim().split(/\s+/);
    if (position.length !== 2) return null;
    const px = parseLength(position[0]), py = parseLength(position[1]);
    if (!px || !py) return null;
    const x = 'pct' in px ? (boxWidth - width) * px.pct : px.px * scale;
    const y = 'pct' in py ? (boxHeight - height) * py.pct : py.px * scale;
    return { x, y, width, height };
}

/**
 * Whether an element starts a pixel grid of its own: Chromium snaps the boxes inside it to whole pixels from its own
 * (snapped) corner, not from the page's. Measured on Chromium 145: paint containment, layout with style containment
 * (Jellyfin's `.cardScalable`), content-visibility, `will-change: transform` or `scale` (a home row's scroll slider),
 * and here any transform that is more than a move. (The layout controller's whole-pixel pass reads the same rule,
 * with the transform properties of their own as well: layout/snap-grid.ts.)
 * @param moves - Its transform is a plain translation.
 */
export function startsPixelGrid(style: CSSStyleDeclaration, moves: boolean): boolean {
    const contain = style.contain || '';
    const paint = /\b(?:paint|content|strict)\b/.test(contain);
    const layout = /\b(?:layout|content|strict)\b/.test(contain);
    const styled = /\b(?:style|content|strict)\b/.test(contain) || (!!style.containerType && style.containerType !== 'normal');
    return paint || (layout && styled) || /\b(?:transform|scale|rotate)\b/.test(style.willChange || '')
        || (!!style.contentVisibility && style.contentVisibility !== 'visible') || (!!style.transform && style.transform !== 'none' && !moves);
}

/**
 * One axis of a background layer that shows whole picture pixels on whole screen pixels. The browser cuts a layer to
 * its element's unsnapped box and then stretches what is left over the snapped pixels, so the layer is given the part
 * of the wanted pixels that lies inside that box: it snaps back to the wanted pixels, and the picture is drawn pixel
 * for pixel.
 * @param from - First wanted pixel (a whole number, in the grid).
 * @param to - One past the last.
 * @param near - The carrier's padding edge, unsnapped.
 * @param far - Its far padding edge.
 * @returns In pixels from the near edge; null when the carrier's box cannot show those pixels.
 */
export function placeLayer(from: number, to: number, near: number, far: number): { offset: number; size: number } | null {
    const lo = Math.max(from, near), hi = Math.min(to, far);
    if (!(hi > lo) || snap(lo) !== from || snap(hi) !== to) return null;
    return { offset: lo - near, size: hi - lo };
}
