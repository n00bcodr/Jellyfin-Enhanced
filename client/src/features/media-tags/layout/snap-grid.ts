// The pixel grid boxes are snapped to (upstream abcaa16d, core/tag-layout.js): which element starts a grid of its own,
// and where the grid of an element's children starts. Reads styles and boxes only. (The same rule places the status
// tags' pictures: types/status/backdrop/.)

/** A plain move as a computed transform. */
const MOVE_ONLY = /^matrix\(1, 0, 0, 1, (-?[\d.e-]+), (-?[\d.e-]+)\)$/;
/** A plain move as a computed `translate`: one or two lengths in px or percentages of the element's own box (a third of 0px allowed). */
const TRANSLATE_PX = /^(-?[\d.e-]+)(px|%)(?: (-?[\d.e-]+)(px|%))?(?: 0px)?$/;
/** A computed `scale` or `rotate` that changes nothing: it starts no grid (measured on Chromium 145). */
const NO_SCALE = /^(?:none|1(?: 1){0,2})$/;
const NO_ROTATE = /^(?:none|(?:.* )?0deg)$/;

/** What an element's styles say of the pixel grid: whether it starts one, and the plain move it makes (CSS px). */
interface GridFact { epoch: number; starts: boolean; move: number[] | null }

/**
 * Whether an element starts a pixel grid of its own: the browser snaps the boxes inside it from its own (snapped)
 * corner, not from the page's. Measured on Chromium 145: paint containment, layout with style containment (Jellyfin's
 * `.cardScalable`), content-visibility, `will-change: transform` or `scale` (a home row's scroll slider), and here any
 * transform that is more than a move.
 * @param moves - Its transform is none or a plain move.
 */
export function startsPixelGrid(style: CSSStyleDeclaration, moves: boolean): boolean {
    const contain = style.contain || '';
    const paint = /\b(?:paint|content|strict)\b/.test(contain);
    const layout = /\b(?:layout|content|strict)\b/.test(contain);
    const styled = /\b(?:style|content|strict)\b/.test(contain) || (!!style.containerType && style.containerType !== 'normal');
    return paint || (layout && styled) || /\b(?:transform|scale|rotate)\b/.test(style.willChange || '')
        || (!!style.contentVisibility && style.contentVisibility !== 'visible') || !moves;
}

/**
 * The grid reader of one layout controller. What an element's styles say is kept until what is known of the page's
 * CSS is next forgotten (`epoch()` goes up); an element that makes a plain move is read on every pass (the move is its
 * own, and may differ the next time).
 * @param epoch - The layout's flowEpoch.
 */
export function createGridReader(epoch: () => number) {
    const gridFacts = new WeakMap<Element, GridFact>();

    function gridFact(el: Element): GridFact {
        let fact = gridFacts.get(el);
        if (fact && fact.epoch === epoch()) return fact;
        fact = { epoch: epoch(), starts: false, move: null };
        try {
            const style = getComputedStyle(el);
            const transform = style.transform || 'none';
            const matrix = transform === 'none' ? null : MOVE_ONLY.exec(transform);
            // The properties of their own (translate, scale, rotate) are not part of the computed transform. (A
            // translate the browser reports as a calc() does not say how far it moves: it is taken for a grid of its
            // own, which is an approximation. A percentage is of the element's own box.)
            const translate = style.translate && style.translate !== 'none' ? style.translate : '';
            const shift = translate ? TRANSLATE_PX.exec(translate) : null;
            const turned = !NO_SCALE.test(style.scale || 'none') || !NO_ROTATE.test(style.rotate || 'none');
            const moves = (transform === 'none' || !!matrix) && (!translate || !!shift) && !turned;
            fact.starts = startsPixelGrid(style, moves);
            if (!fact.starts && (matrix || shift)) {
                let dx = 0;
                let dy = 0;
                if (shift) {
                    const box = shift[2] === '%' || shift[4] === '%' ? el.getBoundingClientRect() : null;
                    dx = Number(shift[1]) * (shift[2] === '%' && box ? box.width / 100 : 1);
                    dy = Number(shift[3] || 0) * (shift[4] === '%' && box ? box.height / 100 : 1);
                }
                fact.move = [(matrix ? Number(matrix[1]) : 0) + dx, (matrix ? Number(matrix[2]) : 0) + dy];
            }
        } catch { /* no styles to read: it starts nothing */ }
        // How far an element is moved can change from one frame to the next (a row that slides, a transition): read each pass.
        if (!fact.move) gridFacts.set(el, fact);
        return fact;
    }

    /**
     * Where the pixel grid of an element's children starts (reads only): the corner of the nearest element that
     * starts one, itself included, else the page's. A plain move in between moves the grid with it.
     * @param memo - One pass's answers.
     * @returns In viewport CSS pixels.
     */
    function gridOrigin(el: Element | null, memo: Map<Element, { x: number; y: number }>): { x: number; y: number } {
        if (!el || el === document.documentElement) return { x: 0, y: 0 };
        const known = memo.get(el);
        if (known) return known;
        const fact = gridFact(el);
        let origin: { x: number; y: number };
        if (fact.starts) {
            const rect = el.getBoundingClientRect();
            origin = { x: rect.left, y: rect.top };
        } else {
            const up = gridOrigin(el.parentElement, memo);
            const move = fact.move;
            origin = move ? { x: up.x + (move[0] ?? 0), y: up.y + (move[1] ?? 0) } : up;
        }
        memo.set(el, origin);
        return origin;
    }

    return { gridOrigin };
}

/**
 * How far a coordinate is from the whole pixel a contained box there was painted from. Layout works in 64ths of a
 * pixel, and rounds a half up.
 * @param value - CSS px from the grid's corner.
 * @param scale - Layout pixels per CSS pixel.
 * @returns Layout units (64ths of a layout pixel) to move by.
 */
export function snapUnits(value: number, scale: number): number {
    const units = Math.round(value * scale * 64);
    return Math.floor(units / 64 + 0.5) * 64 - units;
}
