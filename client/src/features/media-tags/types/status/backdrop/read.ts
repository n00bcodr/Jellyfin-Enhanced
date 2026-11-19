import { parseColour, parseGradient, placeLayer, snap, splitLayers, startsPixelGrid, units, type Gradient } from './css-values';
import { BENEATH_REACH, tagClass, type BackdropFns, type BackdropState, type Base, type Card, type Job, type Piece, type Spec, type Under } from './state';

/** This pass's paint origins, and whether it has read the layout yet. */
export interface ReadPass { origins: Map<Element, { x: number; y: number }>; probed: boolean }
/** What reading a card found: the geometry its pictures are for, the job that draws them, and `hold` for a scaled card. */
export interface ReadResult { card: Card; sig: string; job: Job | null; hold?: boolean }

/**
 * Where the browser's pixel grid starts for an element's box (reads only): the corner of the nearest ancestor that
 * starts its own (startsPixelGrid), else the page's. A plain translation in between moves the grid with it.
 * @param memo - One pass's answers.
 * @returns The origin in viewport CSS pixels.
 */
function paintOrigin(el: Element | null, memo: Map<Element, { x: number; y: number }>): { x: number; y: number } {
    if (!el || el === document.documentElement) return { x: 0, y: 0 };
    const known = memo.get(el);
    if (known) return known;
    const style = getComputedStyle(el);
    let origin: { x: number; y: number };
    const move = /^matrix\(1, 0, 0, 1, (-?[\d.e-]+), (-?[\d.e-]+)\)$/.exec(style.transform || '');
    if (startsPixelGrid(style, !!move)) {
        const rect = el.getBoundingClientRect();
        origin = { x: rect.left, y: rect.top };
    } else {
        const up = paintOrigin(el.parentElement, memo);
        origin = move ? { x: up.x + Number(move[1]), y: up.y + Number(move[2]) } : up;
    }
    memo.set(el, origin);
    return origin;
}

/**
 * An element's own background as this part can redraw it.
 * @param box - Its painted box [left, top, right, bottom], in pixels.
 * @param skip - Leading layers that are pictures.
 * @returns Null when it paints something else; `text` is '' when it paints nothing.
 */
function backgroundOf(style: CSSStyleDeclaration, box: number[], skip: number): { colour: string | null; gradients: Gradient[]; text: string } | null {
    const colour = parseColour(style.backgroundColor);
    if (!colour) return null;
    const images = splitLayers(style.backgroundImage).slice(skip);
    const gradients: Gradient[] = [];
    for (const image of images) {
        if (image === 'none') continue;
        const gradient = parseGradient(image);
        if (!gradient) return null;
        gradients.push(gradient);
    }
    if (gradients.length) {
        // Only gradients that fill their box as they are.
        const plain = (value: string, allowed: string[]) => splitLayers(value).slice(skip).slice(0, images.length).every((v) => allowed.includes(v));
        if (!plain(style.backgroundSize, ['auto', 'auto auto', '100% 100%']) || !plain(style.backgroundPosition, ['0% 0%', '0px 0px'])
            || !plain(style.backgroundOrigin, ['padding-box', 'border-box']) || !plain(style.backgroundClip, ['border-box', 'padding-box'])
            || parseFloat(style.borderTopWidth) || parseFloat(style.borderLeftWidth) || parseFloat(style.borderRightWidth) || parseFloat(style.borderBottomWidth)) return null;
    }
    const painted = (colour[3] ?? 0) > 0 || gradients.length > 0;
    return { colour: (colour[3] ?? 0) > 0 ? style.backgroundColor : null, gradients, text: painted ? `${style.backgroundColor};${images.join(',')}@${box.join(',')}` : '' };
}

/**
 * A carrier's own background layers (under the pictures).
 * @param skip - Leading layers that are pictures.
 * @returns Null when it has none.
 */
function baseOf(style: CSSStyleDeclaration, skip: number): Base | null {
    const image = splitLayers(style.backgroundImage).slice(skip);
    if (!image.length || image.every((v) => v === 'none')) return null;
    const list = (value: string, fallback: string) => {
        const own = splitLayers(value).slice(skip);
        return image.map((_, i) => own[i % Math.max(1, own.length)] || fallback);
    };
    return { image, position: list(style.backgroundPosition, '0% 0%'), size: list(style.backgroundSize, 'auto'), repeat: list(style.backgroundRepeat, 'repeat') };
}

/**
 * Whether a chip of an earlier slot paints under a tag's box (reads only): slots are painted in order, so a chip of a
 * slot before the tag's own lies under it where they overlap, and the filter blurred it with the artwork, shadow and
 * all. Such a tag keeps the live filter: a redrawn chip would only be near. A slot counts only while it shows as the
 * tag's own slot does (the same opacity): corner slots fade together when the pointer hides the tags, which changes
 * nothing, and a summary that gives way to the hover reveal is not under the chips revealed.
 * @param opacity - The tag's slot's computed opacity.
 * @param box - The tag's box [left, top, right, bottom] in the grid, in pixels.
 * @param X - Viewport CSS x → grid pixels.
 */
function chipBeneath(host: HTMLElement, slot: HTMLElement, opacity: number, box: number[], X: (v: number) => number, Y: (v: number) => number): boolean {
    const [left = 0, top = 0, right = 0, bottom = 0] = box;
    // (A chip's shadow, ring or outline reaches a little past its box.)
    const over = (r: DOMRect) => r.width > 0 && r.height > 0 && X(r.right) > left - BENEATH_REACH && X(r.left) < right + BENEATH_REACH
        && Y(r.bottom) > top - BENEATH_REACH && Y(r.top) < bottom + BENEATH_REACH;
    for (const other of Array.from(host.children)) {
        if (other === slot) break;
        if (!other.classList.contains('je-tag-slot') || !over(other.getBoundingClientRect())) continue;
        const shown = getComputedStyle(other);
        if (shown.visibility === 'hidden' || Math.abs(Number(shown.opacity) - opacity) > 0.05) continue;
        for (const el of Array.from(other.querySelectorAll('*'))) {
            if (!over(el.getBoundingClientRect())) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || !(Number(style.opacity) > 0)) continue;
            const colour = parseColour(style.backgroundColor);
            const edge = parseFloat(style.borderTopWidth) || 0;
            const edgeColour = parseColour(style.borderTopColor);
            if ((colour && (colour[3] ?? 0) > 0) || (edge > 0 && edgeColour && (edgeColour[3] ?? 0) > 0)) return true;
            if (el.tagName === 'IMG' || el.localName === 'svg' || style.backgroundImage !== 'none' || style.boxShadow !== 'none') return true;
            if (Array.from(el.childNodes).some((node) => node.nodeType === 3 && /\S/.test(node.nodeValue || ''))) return true;
        }
    }
    return false;
}

/**
 * The artwork a host sits on (reads only, no layout): the card image's <img> once it has loaded, or the image
 * container's background image once the lazy loader set it.
 */
export function artworkOf(host: HTMLElement): { box: HTMLElement; container: Element; url: string; img: HTMLImageElement | null } | { wait: Element; img: HTMLImageElement | null } | null {
    const parent = host.parentElement;
    if (!parent) return null;
    const container = parent.classList.contains('cardScalable') ? parent.querySelector('.cardImageContainer') : parent;
    if (!container) return null;
    const img = Array.from(container.querySelectorAll('img')).find((el) => !el.closest('.je-tag-host'));
    if (img) {
        const url = img.currentSrc || img.src;
        if (!url) return { wait: container, img: null };
        return img.complete && img.naturalWidth > 0 ? { box: img, container, url, img } : { wait: container, img };
    }
    const bg = /url\(["']?([^"')]+)["']?\)/.exec((container instanceof HTMLElement ? container.style?.backgroundImage : '') || '');
    return bg && bg[1] && container instanceof HTMLElement ? { box: container, container, url: bg[1], img: null } : { wait: container, img: null };
}

/**
 * Reading cards (the reads of a measuring pass).
 * @param st - The painter's shared state.
 * @param fns - The painter's other functions.
 */
export function createRead(st: BackdropState, fns: BackdropFns) {
    /** Read one card: where its tags, their carriers and its artwork are. */
    function read(card: Card, scale: number, pass: ReadPass): ReadResult {
        const none: ReadResult = { card, sig: '', job: null };
        const host = card.host;
        const tags = Array.from(host.querySelectorAll<HTMLElement>(`.${tagClass}`));
        if (!tags.length) return none;
        const art = artworkOf(host);
        fns.watchArtwork(card, art ? ('wait' in art ? art.wait : art.container) : null, art && 'wait' in art ? art.img : null);
        if (!art || 'wait' in art || st.unreadable.has(art.url) || (st.tainting.size && st.tainting.has(fns.originOf(art.url)))) return none;
        // Only the artwork went and came back (Jellyfin unloads the images of cards scrolled out of a row): nothing
        // moved, so the pictures drawn for it are shown again without reading the layout. They are the pictures of
        // the layout last read: a card read since they were drawn (its tag changed and the new picture is still to
        // draw, or there was nothing to draw) is read again.
        const kept = card.kept;
        if (!card.moved && kept && kept.job.sig === card.fullSig && kept.job.url === art.url && kept.job.scale === scale
            && kept.job.specs.every((spec) => spec.pieces.every((p) => p.carrier.isConnected))) {
            return { card, sig: kept.job.sig, job: kept.job };
        }
        const result = full(card, scale, pass, art, tags);
        if (!result.hold) card.fullSig = result.sig;
        return result;
    }

    /** The layout read. */
    function full(card: Card, scale: number, pass: ReadPass, art: { box: HTMLElement; container: Element; url: string; img: HTMLImageElement | null }, tags: HTMLElement[]): ReadResult {
        const none: ReadResult = { card, sig: '', job: null };
        const host = card.host;
        // The first geometry read of a pass pays for any layout the page still owes (other modules' writes since the
        // last frame); timed apart, so the counters tell it from this part's own reads.
        const probe = pass.probed ? 0 : performance.now();
        const boxRect = art.box.getBoundingClientRect();
        if (!pass.probed) {
            pass.probed = true;
            st.counters.layoutMs += performance.now() - probe;
        }
        if (!(boxRect.width > 0 && boxRect.height > 0)) { card.moved = false; return none; }
        // A card scaled by a transform (a focused card on a TV, a theme's hover) measures larger than it is laid out,
        // and its pictures are written in layout pixels: it keeps what it has and is read when the state is over.
        const laidOut = [art.box.offsetWidth, art.box.offsetHeight] as const;
        if (laidOut[0] > 0 && laidOut[1] > 0 && (Math.abs(boxRect.width - laidOut[0]) > Math.max(1, laidOut[0] * 0.01)
            || Math.abs(boxRect.height - laidOut[1]) > Math.max(1, laidOut[1] * 0.01))) {
            fns.measureAgainLater(card, true);
            return { card, sig: '', job: null, hold: true };
        }
        card.moved = false;
        card.holdMs = 0;
        const boxStyle = getComputedStyle(art.box);
        // Never sharper than the page shows it: artwork a style filters, hides or fades keeps the live filter (while a
        // hover dims it, say: the card is read again when that is over).
        const shown = (style: CSSStyleDeclaration, el: Element) => style.filter === 'none' && style.visibility !== 'hidden'
            && (Number(style.opacity) >= 1 || (typeof el.getAnimations === 'function' && el.getAnimations().length > 0));
        if (!shown(boxStyle, art.box)) { fns.measureAgainLater(card); return none; }
        const containerStyle = art.container === art.box ? boxStyle : getComputedStyle(art.container);
        if (art.container !== art.box && !shown(containerStyle, art.container)) { fns.measureAgainLater(card); return none; }
        let fit: { size: string; position: string };
        if (art.img) fit = { size: boxStyle.objectFit, position: boxStyle.objectPosition };
        else {
            if (splitLayers(boxStyle.backgroundImage).length !== 1 || boxStyle.backgroundAttachment !== 'scroll'
                || !['padding-box', 'border-box'].includes(boxStyle.backgroundOrigin)
                || (boxStyle.backgroundRepeat !== 'no-repeat' && boxStyle.backgroundSize !== 'cover')) return none;
            fit = { size: boxStyle.backgroundSize, position: boxStyle.backgroundPosition };
        }
        const baseColour = [boxStyle.backgroundColor, containerStyle.backgroundColor].find((c) => ((parseColour(c) || [0, 0, 0, 0])[3] ?? 0) >= 1) || null;
        // Pixels in the coordinates the card is painted (and snapped) in.
        const origin = paintOrigin(host, pass.origins);
        const X = (v: number) => (v - origin.x) * scale, Y = (v: number) => (v - origin.y) * scale;
        const boxLeft = snap(X(boxRect.left)), boxTop = snap(Y(boxRect.top));
        const boxWidth = snap(X(boxRect.right)) - boxLeft, boxHeight = snap(Y(boxRect.bottom)) - boxTop;
        if (!(boxWidth > 0 && boxHeight > 0)) return none;
        const frac = (v: number) => units(v - Math.floor(v));

        /** An element's facts, read once a pass: its box, its painted box, its unsnapped padding box and how many pictures it holds. */
        const seen = new Map<Element, { style: CSSStyleDeclaration; rect: DOMRect; painted: number[]; padding: number[]; own: number }>();
        const facts = (el: Element) => {
            let f = seen.get(el);
            if (!f) {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const border = (side: 'borderLeftWidth' | 'borderTopWidth' | 'borderRightWidth' | 'borderBottomWidth') => (parseFloat(style[side]) || 0) * scale;
                f = {
                    style,
                    rect,
                    painted: [snap(X(rect.left)), snap(Y(rect.top)), snap(X(rect.right)), snap(Y(rect.bottom))],
                    padding: [X(rect.left) + border('borderLeftWidth'), Y(rect.top) + border('borderTopWidth'), X(rect.right) - border('borderRightWidth'), Y(rect.bottom) - border('borderBottomWidth')],
                    own: el instanceof HTMLElement ? st.applied.get(el) || 0 : 0,
                };
                seen.set(el, f);
            }
            return f;
        };
        const at = (list: number[], i: number) => list[i] ?? 0;
        const specs: Spec[] = [];
        const bases = new Map<HTMLElement, Base>();
        const parts: string[] = [];
        // A tag that shows a backdrop and gets no picture here: the card then keeps the live filter for all of them.
        let partial = false;
        for (const tag of tags) {
            const rect = tag.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) continue;
            const style = getComputedStyle(tag);
            const colour = parseColour(style.backgroundColor);
            // An opaque tag hides its backdrop; a hidden one shows nothing.
            if (style.visibility === 'hidden' || (colour && (colour[3] ?? 0) >= 1 && style.backgroundImage === 'none')) continue;
            const group = tag.closest<HTMLElement>('[data-je-group]');
            const slot = tag.closest<HTMLElement>('.je-tag-slot');
            if (!group || !slot || !host.contains(slot)) { partial = true; continue; }
            // The picture is the slot's, so it would stay at full strength under a tag that is itself translucent or
            // fading (its own opacity, or its group's): the live filter then.
            if (Number(style.opacity) < 1 || (group !== tag && Number(facts(group).style.opacity) < 1)) { partial = true; fns.measureAgainLater(card); continue; }
            // The backdrop filter's own pixels: the tag's snapped corner, and its size rounded as a whole. A group or
            // slot that starts a pixel grid of its own snaps the tag from its own snapped corner.
            let gridX = origin.x, gridY = origin.y, left = 0, top = 0;
            for (const el of [slot, group]) {
                const f = facts(el);
                if (!startsPixelGrid(f.style, false)) continue;
                left += snap((f.rect.left - gridX) * scale);
                top += snap((f.rect.top - gridY) * scale);
                gridX = f.rect.left;
                gridY = f.rect.top;
            }
            left += snap((rect.left - gridX) * scale);
            top += snap((rect.top - gridY) * scale);
            const width = snap(units(rect.width * scale)), height = snap(units(rect.height * scale));
            if (!(width > 0 && height > 0)) continue;
            // A tag reaching outside the artwork's box has something else behind it.
            if (left < boxLeft || top < boxTop || left + width > boxLeft + boxWidth || top + height > boxTop + boxHeight) { partial = true; continue; }
            // What the host, the slot and the group (when it has a box) paint between the artwork and the tag.
            const unders: Under[] = [];
            let drawable = true;
            let underText = '';
            for (const el of [host, slot, group]) {
                const f = facts(el);
                if (!(at(f.painted, 2) > at(f.painted, 0) && at(f.painted, 3) > at(f.painted, 1))) continue;
                const bg = backgroundOf(f.style, f.painted.map((v, i) => v - (i % 2 ? boxTop : boxLeft)), f.own);
                if (!bg) { drawable = false; break; }
                if (!bg.text) continue;
                unders.push({ x: at(f.painted, 0) - boxLeft, y: at(f.painted, 1) - boxTop, width: at(f.painted, 2) - at(f.painted, 0), height: at(f.painted, 3) - at(f.painted, 1), colour: bg.colour, gradients: bg.gradients, host: el === host });
                underText += `${bg.text};`;
            }
            if (!drawable) { partial = true; continue; }
            // The slot shows the picture's pixels that lie inside its own box.
            const pieces: Piece[] = [];
            const piece = (carrier: HTMLElement, x0: number, y0: number, x1: number, y1: number) => {
                if (!(x1 > x0 && y1 > y0)) return;
                const f = facts(carrier);
                const h = placeLayer(x0, x1, at(f.padding, 0), at(f.padding, 2)), v = placeLayer(y0, y1, at(f.padding, 1), at(f.padding, 3));
                if (!h || !v || x0 < at(f.painted, 0) || y0 < at(f.painted, 1) || x1 > at(f.painted, 2) || y1 > at(f.painted, 3)) return;
                pieces.push({ carrier, sx: x0 - left, sy: y0 - top, width: x1 - x0, height: y1 - y0, left: units(h.offset / scale), top: units(v.offset / scale), cssWidth: units(h.size / scale), cssHeight: units(v.size / scale) });
                if (!bases.has(carrier)) {
                    const base = baseOf(f.style, f.own);
                    if (base) bases.set(carrier, base);
                }
            };
            const inSlot = facts(slot).painted;
            const cutRight = Math.max(left, Math.min(left + width, at(inSlot, 2))), cutBottom = Math.max(top, Math.min(top + height, at(inSlot, 3)));
            piece(slot, Math.max(left, at(inSlot, 0)), Math.max(top, at(inSlot, 1)), cutRight, cutBottom);
            if (!pieces.length) { partial = true; continue; }
            const corners = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
            // A corner given as a percentage or as an ellipse is not cut here: a square picture would show past the
            // pill's corners, so such a tag keeps the live filter.
            if (corners.some((r) => /%|\S\s+\S/.test(String(r || '')))) { partial = true; continue; }
            const radii = corners.map((r) => (parseFloat(r) || 0) * scale);
            // Another slot's chip under the tag is part of its backdrop: only the filter shows it as it is.
            if (chipBeneath(host, slot, Number(facts(slot).style.opacity), [left, top, left + width, top + height], X, Y)) { partial = true; continue; }
            specs.push({ x: left - boxLeft, y: top - boxTop, width, height, radii, unders, pieces });
            parts.push([left - boxLeft, top - boxTop, width, height, radii.map(units).join('/'), underText,
                pieces.map((p) => `${p.sx},${p.sy},${p.width},${p.height},${p.left},${p.top},${p.cssWidth},${p.cssHeight}`).join(';')].join(','));
        }
        if (!specs.length) return none;
        const sig = [scale, art.url, art.img ? 'img' : 'bg', fit.size, fit.position, baseColour || '', frac(X(boxRect.left)), frac(Y(boxRect.top)), boxWidth, boxHeight, ...parts].join('|');
        return { card, sig, job: { card, sig, key: art.url, url: art.url, img: art.img, scale, boxWidth, boxHeight, fit, base: baseColour, specs, bases, partial } };
    }

    return { read };
}
