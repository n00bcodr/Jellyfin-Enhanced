// /js/tags/status-tag-backdrop.js
// The blurred backdrop of status tags (tags/statustags.js draws the tags).
// A status tag is a 72% dark pill over the card's artwork, and the
// artwork behind it is blurred. `backdrop-filter: blur(6px)` gave that
// look at the price of a compositor layer for every tag, plus one for
// whatever painted over it. This part paints the same picture once
// instead: it samples the artwork under a tag, blurs it the way the
// browser's backdrop filter does, and shows the result under the tag as
// a plain background image of the tag's slot. The tag, its colour,
// border and shadow are untouched and keep
// compositing over the picture, so Tag Styles and custom CSS behave as
// before, and the picture fades with its slot and the host. Nothing here
// adds an element, a layer or a paint property, and nothing runs while
// the page scrolls.
//
// The blur is Chromium's, measured on synthetic pages (Chromium 145):
//   - the backdrop is cut to the tag's border box, from its pixel-snapped
//     corner and with its width and height rounded to whole pixels (the
//     filter made the tag a pixel grid of its own, so that box can end a
//     pixel before or after the box the pill is painted in), and repeated
//     mirrored beyond its edges: no colour from outside bleeds in. Where
//     that box reaches a pixel past the slot's own (a tag against the
//     slot's edge), that row or column is left out: a background stops at
//     its element's box, and painting it on the host would leave it
//     behind when a slot fades alone;
//   - the kernel is Skia's Gaussian approximation: three box blurs of
//     floor(sigma × 3 × sqrt(2π) / 4 + 0.5) pixels (two of that width and
//     one a pixel wider when it is even), rows first, rounded to whole
//     channel values after each direction; sigma is 6 CSS pixels;
//   - the tag's rounded corners are cut into the picture's alpha.
// Pixels are snapped the way the page snaps them: from the corner of the
// nearest ancestor that starts a pixel grid of its own (startsPixelGrid),
// and a picture is placed inside its carrier's unsnapped box, where the
// browser draws it pixel for pixel.
//
// What is behind a tag is rebuilt from what the page shows: the card
// image (an <img>, or the image container's background image) placed by
// its object-fit / background-size over the image box's own opaque
// colour, then the plain colours and linear gradients the host, the slot
// and the group paint (a Bands layout's band).
//
// The picture is a stand-in for the filter, used only where it is the
// same: a card's host carries `data-je-blur`, which gives its status tags
// the live `backdrop-filter` (tags/statustags.js), from the moment its
// badge is drawn until every tag on it has its picture, and again whenever
// the picture would not be what the filter shows:
//   - while the pointer is on the card with its tags on show, or focus is
//     in it: Jellyfin's overlay lies between the artwork and the tags then;
//   - when it cannot be drawn faithfully: artwork still loading, hidden,
//     filtered or faded by CSS, a chip of an earlier slot under the tag (a
//     crowded card), a tag reaching outside the image or itself
//     translucent, transparency with nothing known behind it, a background
//     this part cannot draw, a canvas the browser will not let it read;
//   - where this part does not run at all (no readable canvas, a content
//     security policy without data: images, the file not loaded).
// So the look never waits for this part and never depends on it; it only
// stops costing a compositor layer where a picture can stand in. A
// filtered tag is a layer of its own, so the layout controller keeps such
// a card positioned (core/tag-layout.js flowFor) and is told when the mark
// changes. A picture never shows artwork sharper than the page does: it
// comes from the image the card shows (artwork Spoiler Guard serves
// blurred is blurred again).
//
// Lifecycle: a card is tracked when its badge is drawn, and released once
// it is gone from the page. In between it is watched (its chips, its
// size, its artwork); a change queues one
// measuring pass after the next paint, reads first, then writes, a few
// cards a pass, and only a card whose geometry really changed is drawn
// again, in idle slices (it loses its old pictures in that pass; a card
// whose artwork Jellyfin unloaded and loads again, as it does for cards
// scrolled out of a row, shows the pictures it already has). Pictures are data URLs in the
// carrier's inline style, so they go with the card; decoded artwork is
// kept for a few cards only.
//
// Surface (JE.statusTagBackdrop): BLUR_PX, track, release, resume, refresh,
// setActive, isActive, stats, and the pure parts boxSizes, blurRgba,
// fitImage, parseGradient, parseColour, splitLayers, snap,
// startsPixelGrid, placeLayer.
//
// This file is a component group of its own, fetched when the first status
// tag is drawn (tags/statustags.js trackBackdrop): a page that shows none
// never downloads it. A tag does not wait for it; when this file arrives it
// takes up every status tag already on the page.
(function (JE) {
    'use strict';

    /** The class of a status tag (tags/statustags.js). */
    const tagClass = 'status-tag';

    const backdrop = (() => {
        const backdropLog = '🪼 Jellyfin Enhanced: Status tag backdrop:';
        /** The Gaussian sigma of the look, in CSS pixels (the old `backdrop-filter: blur(6px)`). */
        const BLUR_PX = 6;
        /** Pictures are drawn at the device's pixel density, up to this many pixels per CSS pixel. */
        const MAX_SCALE = 3;
        /** Decoded artwork kept for cards drawn again (their chips moved, the window resized): images, and their pixels in all. */
        const ARTWORK_CAP = 12;
        const ARTWORK_PIXELS = 4e6;
        /** Decodes in flight at once. */
        const MAX_DECODES = 4;
        /** A slice starts another step only with this much idle time left (ms). */
        const STEP_MIN_MS = 3;
        /** A slice's budget without an idle deadline (no requestIdleCallback), in ms. */
        const SLICE_BUDGET_MS = 6;
        /** A measuring pass reads this many cards at a time and starts no further batch after this long (ms): the rest wait for the next paint. */
        const MEASURE_CARDS = 6;
        const MEASURE_BUDGET_MS = 3;
        /** A window resize is measured this long after the last one (ms); a card that changed size is measured at once. */
        const RESIZE_SETTLE_MS = 200;
        /** Layout units in a pixel: geometry is compared and written in these. */
        const UNITS = 64;
        /** How far past its box a chip's shadow, ring or outline may paint (pixels of the grid). */
        const BENEATH_REACH = 6;
        /** Artwork addresses remembered as unreadable. */
        const UNREADABLE_CAP = 500;
        /**
         * How long after the pointer or focus has left a card its pictures come back (ms): once Jellyfin's
         * overlay has faded from the artwork, and before the layout controller rests the card (its 200 ms).
         */
        const LIVE_REST_MS = 180;
        /** A scaled card is looked at again after this long, doubling up to the cap while it stays scaled (ms). */
        const HOLD_MS = 1000;
        const HOLD_MAX_MS = 30000;
        /** What ends a passing state of a card (measureAgainLater). */
        const AGAIN_EVENTS = ['transitionend', 'transitioncancel', 'animationend', 'pointerleave', 'focusout'];
        /** The colour the canvas probe draws and must read back (isSupported). */
        const PROBE_RGB = [18, 52, 86];

        // ── The blur (pure) ────────────────────────────────────────────

        /**
         * The three box widths Skia blurs with for a Gaussian of this sigma.
         * @param {number} sigma - In pixels.
         * @returns {number[]} Empty when the blur is too small to change anything.
         */
        function boxSizes(sigma) {
            const width = Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);
            if (!(width > 1)) return [];
            return width % 2 ? [width, width, width] : [width, width, width + 1];
        }

        /**
         * Blur the lines of one direction in place: every line is extended by
         * mirroring, summed three times and rounded.
         * @param {Uint8ClampedArray} data - RGBA.
         * @param {number} lines - Lines to blur.
         * @param {number} length - Pixels a line.
         * @param {number} lineStep - Array distance between lines.
         * @param {number} pixelStep - Array distance between a line's pixels.
         * @param {number[]} sizes - Box widths.
         * @param {Float64Array} a - Scratch, at least length + sum(sizes) long.
         * @param {Float64Array} b - Scratch of the same size.
         */
        function blurLines(data, lines, length, lineStep, pixelStep, sizes, a, b) {
            const pad = (sizes[0] + sizes[1] + sizes[2] - 3) / 2;
            const period = 2 * length;
            const padded = length + 2 * pad;
            const norm = 1 / (sizes[0] * sizes[1] * sizes[2]);
            for (let line = 0; line < lines; line++) {
                for (let channel = 0; channel < 3; channel++) {
                    const base = line * lineStep + channel;
                    for (let k = 0; k < padded; k++) {
                        let j = (k - pad) % period;
                        if (j < 0) j += period;
                        if (j >= length) j = period - 1 - j;
                        a[k] = data[base + j * pixelStep];
                    }
                    let from = a, to = b, count = padded;
                    for (let pass = 0; pass < 3; pass++) {
                        const size = sizes[pass];
                        const out = count - size + 1;
                        let sum = 0;
                        for (let k = 0; k < size; k++) sum += from[k];
                        to[0] = sum;
                        for (let k = 1; k < out; k++) {
                            sum += from[k + size - 1] - from[k - 1];
                            to[k] = sum;
                        }
                        count = out;
                        const swap = from; from = to; to = swap;
                    }
                    for (let j = 0; j < length; j++) data[base + j * pixelStep] = Math.floor(from[j] * norm + 0.5);
                }
            }
        }

        /**
         * Blur opaque RGBA pixels in place the way Chromium's backdrop filter
         * does: mirrored edges, three box blurs, rows then columns. Alpha is
         * left as it is.
         * @param {Uint8ClampedArray} data
         * @param {number} width
         * @param {number} height
         * @param {number} sigma - In pixels.
         * @returns {Uint8ClampedArray} The same array.
         */
        function blurRgba(data, width, height, sigma) {
            const sizes = boxSizes(sigma);
            if (!sizes.length || !(width > 0 && height > 0)) return data;
            const scratch = Math.max(width, height) + sizes[0] + sizes[1] + sizes[2];
            const a = new Float64Array(scratch), b = new Float64Array(scratch);
            blurLines(data, height, width, width * 4, 4, sizes, a, b);
            blurLines(data, width, height, 4, width * 4, sizes, a, b);
            return data;
        }

        // ── Geometry and CSS values (pure) ─────────────────────────────

        /** @param {number} value @returns {number} A layout coordinate snapped to the pixel grid the way the browser paints boxes. */
        const snap = (value) => Math.floor(value + 0.5);
        /** @param {number} value @returns {number} The value in whole layout units. */
        const units = (value) => Math.round(value * UNITS) / UNITS;

        /**
         * Split a CSS list at its top-level commas (`a, f(b, c)` → two layers).
         * @param {string} value
         * @returns {string[]}
         */
        function splitLayers(value) {
            const out = [];
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
         * @param {string} value - `rgb(…)`, `rgba(…)` or `transparent`.
         * @returns {number[]|null} Null for anything else.
         */
        function parseColour(value) {
            const text = String(value || '').trim();
            if (text === 'transparent') return [0, 0, 0, 0];
            const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
            if (!m) return null;
            let alpha = 1;
            if (m[4] !== undefined) alpha = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
            return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
        }

        /**
         * A computed `linear-gradient()` this part can draw: a side or an
         * angle, and rgb colour stops placed by percentages (or not at all).
         * @param {string} value
         * @returns {{angle: number, stops: {at: number, colour: string}[]}|null} The angle in degrees (0: to top, 90: to right).
         */
        function parseGradient(value) {
            const m = /^linear-gradient\((.*)\)$/s.exec(String(value || '').trim());
            if (!m) return null;
            const parts = splitLayers(m[1]);
            let angle = 180;
            const first = parts[0] || '';
            const sides = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
            if (Object.hasOwn(sides, first)) {
                angle = sides[first];
                parts.shift();
            } else if (/^-?[\d.]+deg$/.test(first)) {
                angle = parseFloat(first);
                parts.shift();
            } else if (/^to /.test(first) || /^-?[\d.]+(?:rad|grad|turn)$/.test(first)) {
                return null;
            }
            if (parts.length < 2) return null;
            /** @type {{at: number|null, colour: string}[]} */
            const stops = [];
            for (const part of parts) {
                const s = /^(rgba?\([^)]*\))(?:\s+(-?[\d.]+)%)?$/.exec(part);
                if (!s || !parseColour(s[1])) return null;
                stops.push({ colour: s[1], at: s[2] === undefined ? null : parseFloat(s[2]) / 100 });
            }
            // Unplaced stops: the ends at 0 and 1, the rest spread evenly; none before the one it follows.
            if (stops[0].at === null) stops[0].at = 0;
            if (stops[stops.length - 1].at === null) stops[stops.length - 1].at = 1;
            for (let i = 1; i < stops.length; i++) {
                if (stops[i].at !== null) {
                    stops[i].at = Math.max(/** @type {number} */ (stops[i].at), /** @type {number} */ (stops[i - 1].at));
                    continue;
                }
                let next = i;
                while (stops[next].at === null) next++;
                const from = /** @type {number} */ (stops[i - 1].at);
                const to = Math.max(from, /** @type {number} */ (stops[next].at));
                for (let k = i; k < next; k++) stops[k].at = from + (to - from) * (k - i + 1) / (next - i + 1);
            }
            if (stops.some((stop) => /** @type {number} */ (stop.at) < 0 || /** @type {number} */ (stop.at) > 1)) return null;
            return { angle, stops: /** @type {{at: number, colour: string}[]} */ (stops) };
        }

        /**
         * One coordinate of a computed position or size: a percentage or pixels.
         * @param {string} value
         * @returns {{pct: number}|{px: number}|null}
         */
        function parseLength(value) {
            const m = /^(-?[\d.]+)(%|px)$/.exec(String(value || '').trim());
            if (!m) return null;
            return m[2] === '%' ? { pct: parseFloat(m[1]) / 100 } : { px: parseFloat(m[1]) };
        }

        /**
         * Where an image lands in its box, in the box's pixels.
         * @param {number} naturalWidth
         * @param {number} naturalHeight
         * @param {number} boxWidth
         * @param {number} boxHeight
         * @param {{size: string, position: string}} fit - object-fit / background-size, and the computed position.
         * @param {number} scale - Pixels a CSS pixel.
         * @returns {{x: number, y: number, width: number, height: number}|null} Null for values this part does not place.
         */
        function fitImage(naturalWidth, naturalHeight, boxWidth, boxHeight, fit, scale) {
            if (!(naturalWidth > 0 && naturalHeight > 0 && boxWidth > 0 && boxHeight > 0)) return null;
            const size = String(fit.size || '').trim();
            const cover = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
            const contain = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
            let width, height;
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
                const px = (v, box) => ('pct' in v ? v.pct * box : v.px * scale);
                width = w ? px(w, boxWidth) : null;
                height = h ? px(h, boxHeight) : null;
                if (width === null && height === null) return null;
                if (width === null) width = /** @type {number} */ (height) * naturalWidth / naturalHeight;
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
         * Whether an element starts a pixel grid of its own: Chromium snaps
         * the boxes inside it to whole pixels from its own (snapped) corner,
         * not from the page's. Measured on Chromium 145: paint containment,
         * layout with style containment (Jellyfin's `.cardScalable`),
         * content-visibility, `will-change: transform` or `scale` (a home
         * row's scroll slider), and here any transform that is more than a move.
         * @param {CSSStyleDeclaration} style
         * @param {boolean} moves - Its transform is a plain translation.
         * @returns {boolean}
         */
        function startsPixelGrid(style, moves) {
            const contain = style.contain || '';
            const paint = /\b(?:paint|content|strict)\b/.test(contain);
            const layout = /\b(?:layout|content|strict)\b/.test(contain);
            const styled = /\b(?:style|content|strict)\b/.test(contain) || (!!style.containerType && style.containerType !== 'normal');
            return paint || (layout && styled) || /\b(?:transform|scale|rotate)\b/.test(style.willChange || '')
                || (!!style.contentVisibility && style.contentVisibility !== 'visible') || (!!style.transform && style.transform !== 'none' && !moves);
        }

        /**
         * One axis of a background layer that shows whole picture pixels on
         * whole screen pixels. The browser cuts a layer to its element's
         * unsnapped box and then stretches what is left over the snapped
         * pixels, so the layer is given the part of the wanted pixels that
         * lies inside that box: it snaps back to the wanted pixels, and the
         * picture is drawn pixel for pixel.
         * @param {number} from - First wanted pixel (a whole number, in the grid).
         * @param {number} to - One past the last.
         * @param {number} near - The carrier's padding edge, unsnapped.
         * @param {number} far - Its far padding edge.
         * @returns {{offset: number, size: number}|null} In pixels from the near edge; null when the carrier's box cannot show those pixels.
         */
        function placeLayer(from, to, near, far) {
            const lo = Math.max(from, near), hi = Math.min(to, far);
            if (!(hi > lo) || snap(lo) !== from || snap(hi) !== to) return null;
            return { offset: lo - near, size: hi - lo };
        }

        // ── State ──────────────────────────────────────────────────────

        /**
         * A watched card. `sig` is the geometry its pictures were last asked
         * for ('' when it shows none), `carriers` the elements that hold
         * them, `kept` the last pictures drawn and what they were drawn for,
         * `moved` whether its chips or its size changed since it was last read,
         * `on` the elements its last measured pictures belong on, `latest`
         * the job that measurement made (an older one in flight is dropped),
         * `fullSig` what the last read of its layout found ('' for nothing to
         * draw), `again` the way to stop waiting for a passing state to end
         * (measureAgainLater), `live` whether the pointer or focus is on the
         * card (its tags then keep the live filter, see use) and `resting` the
         * timer that ends that.
         * @typedef {{host: HTMLElement, chips: MutationObserver|null, art: MutationObserver|null, container: Element|null, img: HTMLImageElement|null,
         *   onLoad: () => void, sig: string, carriers: Set<HTMLElement>, kept: {job: Job, drawn: (string[]|null)[]}|null, moved: boolean,
         *   on: HTMLElement[], latest: Job|null, fullSig: string, again: (() => void)|null, live: boolean,
         *   resting: ReturnType<typeof setTimeout>|0, holdMs: number}} Card
         */
        /** A background painted between the artwork and a tag (pixels in the image box; `host`: the host's own, under every chip). @typedef {{x: number, y: number, width: number, height: number, colour: string|null, gradients: Object[], host: boolean}} Under */
        /**
         * A part of a tag's picture as one background layer: `sx`…`height` are its pixels within the picture, the rest its CSS box in the carrier.
         * @typedef {{carrier: HTMLElement, sx: number, sy: number, width: number, height: number, left: number, top: number, cssWidth: number, cssHeight: number}} Piece
         */
        /** One tag's picture to draw (pixels, relative to the image box). @typedef {{x: number, y: number, width: number, height: number, radii: number[], unders: Under[], pieces: Piece[]}} Spec */
        /** A carrier's own background layers, kept under the pictures. @typedef {{image: string[], position: string[], size: string[], repeat: string[]}} Base */
        /**
         * A card's pictures being drawn.
         * @typedef {{card: Card, sig: string, key: string, url: string, img: HTMLImageElement|null, scale: number, boxWidth: number, boxHeight: number,
         *   fit: {size: string, position: string}, base: string|null, specs: Spec[], bases: Map<HTMLElement, Base>, partial: boolean}} Job
         */
        /** A picture layer as written. @typedef {{url: string, x: number, y: number, width: number, height: number}} Layer */

        /** @type {Map<HTMLElement, Card>} host → its card */
        const cards = new Map();
        /** @type {Set<Card>} cards to measure after the next paint */
        const dirty = new Set();
        /** @type {WeakMap<HTMLElement, number>} carrier → how many of its background layers are pictures */
        const applied = new WeakMap();
        /** @type {Job[]} cards waiting for a decode slot */
        const waiting = [];
        /** @type {Job[]} cards whose artwork is decoded, waiting for their pixel step */
        const ready = [];
        /** @type {Map<string, {jobs: Set<Job>}>} artwork URL → its decode in flight */
        const decoding = new Map();
        /** @type {Map<string, {drawable: CanvasImageSource, bitmap: boolean, width: number, height: number}>} decoded artwork, most recent last */
        const artwork = new Map();
        /** @type {Set<string>} artwork that cannot be read (a tainted canvas, a broken image); the oldest are forgotten past UNREADABLE_CAP */
        const unreadable = new Set();
        /** @type {Set<string>} origins whose artwork taints the canvas: nothing from them is decoded again */
        const tainting = new Set();
        /** @type {Set<Card>} cards found still in use when their pictures were due back (see rest) */
        const lingering = new Set();
        /** @type {WeakSet<HTMLElement>} hosts released while they were off the page (see resume) */
        const detached = new WeakSet();
        const counters = { passes: 0, maxPassMs: 0, measures: 0, measureMs: 0, maxMeasureMs: 0, layoutMs: 0, cards: 0, reused: 0, slices: 0, sliceMs: 0, maxSliceMs: 0, decodes: 0, drawn: 0, plain: 0, pixelMs: 0, maxPixelMs: 0, failed: 0 };
        let active = true;
        let measureScheduled = false;
        let sliceScheduled = false;
        let resizeTimer = 0;
        let generation = 0;
        /** @type {ResizeObserver|null} */
        let sizes = null;
        /** @type {HTMLCanvasElement|null} the picture being drawn, and the one its parts are cut into */
        let canvas = null;
        /** @type {HTMLCanvasElement|null} */
        let cutter = null;
        /** @type {boolean|null} whether this browser can do the pixel work (decided when the first picture is due) */
        let supported = null;

        /** @returns {boolean} A canvas whose pixels can be read back, as they were drawn, and exported. */
        function isSupported() {
            if (supported !== null) return supported;
            try {
                const probe = document.createElement('canvas');
                probe.width = probe.height = 2;
                const ctx = probe.getContext('2d', { willReadFrequently: true });
                supported = false;
                if (ctx && typeof ctx.getImageData === 'function' && typeof probe.toDataURL === 'function') {
                    // A canvas that answers with other pixels than were drawn (a browser resisting
                    // fingerprinting does, without throwing) would put noise behind every tag.
                    ctx.fillStyle = `rgb(${PROBE_RGB.join(', ')})`;
                    ctx.fillRect(0, 0, 2, 2);
                    const read = ctx.getImageData(0, 0, 1, 1).data;
                    supported = PROBE_RGB.every((value, i) => Math.abs(read[i] - value) <= 1) && read[3] === 255
                        && probe.toDataURL('image/png').startsWith('data:image/png');
                }
            } catch {
                supported = false;
            }
            return supported;
        }

        /** @returns {number} Device pixels a CSS pixel the pictures are drawn at. */
        const pixelScale = () => Math.min(MAX_SCALE, Math.max(1, window.devicePixelRatio || 1));

        // ── Watching a card ────────────────────────────────────────────

        /**
         * The artwork a host sits on (reads only, no layout): the card
         * image's <img> once it has loaded, or the image container's
         * background image once the lazy loader set it.
         * @param {HTMLElement} host
         * @returns {{box: HTMLElement, container: Element, url: string, img: HTMLImageElement|null}|{wait: Element, img: HTMLImageElement|null}|null}
         */
        function artworkOf(host) {
            const parent = host.parentElement;
            if (!parent) return null;
            const container = parent.classList.contains('cardScalable') ? parent.querySelector('.cardImageContainer') : parent;
            if (!container) return null;
            const img = /** @type {HTMLImageElement|undefined} */ (Array.from(container.querySelectorAll('img')).find((el) => !el.closest('.je-tag-host')));
            if (img) {
                const url = img.currentSrc || img.src;
                if (!url) return { wait: container, img: null };
                return img.complete && img.naturalWidth > 0 ? { box: img, container, url, img } : { wait: container, img };
            }
            const bg = /url\(["']?([^"')]+)["']?\)/.exec(/** @type {HTMLElement} */ (container).style?.backgroundImage || '');
            return bg ? { box: /** @type {HTMLElement} */ (container), container, url: bg[1], img: null } : { wait: container, img: null };
        }

        /** @param {Card} card Measure a card after the next paint. */
        function markDirty(card) {
            if (!active) return;
            dirty.add(card);
            if (measureScheduled) return;
            measureScheduled = true;
            if (typeof JE.core?.dom?.afterNextPaint === 'function') JE.core.dom.afterNextPaint(measureDirty);
            else requestAnimationFrame(() => setTimeout(measureDirty, 0));
        }

        /**
         * Watch a card's artwork: its image container (a new background image
         * or src, an <img> mounted or replaced) and an image still loading.
         * @param {Card} card
         * @param {Element|null} container
         * @param {HTMLImageElement|null} img - An image still loading.
         */
        function watchArtwork(card, container, img) {
            if (card.container !== container) {
                card.art?.disconnect();
                card.container = container;
                if (container) {
                    // A bare image or list row holds the host too: its chips and the pictures are not artwork.
                    card.art = card.art || new MutationObserver((records) => {
                        if (!records.some((record) => !/** @type {Element} */ (record.target).closest?.('.je-tag-host'))) return;
                        if (!artworkParked(card)) markDirty(card);
                    });
                    card.art.observe(container, { attributes: true, attributeFilter: ['style', 'src', 'srcset'], childList: true, subtree: true });
                }
            }
            if (card.img !== img) {
                card.img?.removeEventListener('load', card.onLoad);
                card.img = img;
                img?.addEventListener('load', card.onLoad);
            }
        }

        /**
         * Whether a change to a card's artwork leaves its pictures as they
         * are: Jellyfin's lazy loader takes the background image of a card
         * scrolled out of view (`background-image: none`, its address parked
         * in `data-src`) and puts the same one back when the card returns,
         * for every card of a row as the row scrolls. The pictures drawn for
         * that artwork are the ones to show when the card is seen again, so
         * they stay where they are and nothing is measured or written while
         * the page scrolls. Other artwork, or none, is a change (no layout read).
         * @param {Card} card
         * @returns {boolean}
         */
        function artworkParked(card) {
            const kept = card.kept;
            const container = /** @type {HTMLElement|null} */ (card.container);
            if (!kept || card.moved || kept.job.img || card.sig !== kept.job.sig || !container) return false;
            const shown = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || '');
            return (shown ? shown[1] : container.getAttribute('data-src') || '') === kept.job.url;
        }

        /** The layout controller's own marks on a host (core/tag-layout.js): how the card is laid out and fades, never where a tag is. */
        const HOST_MARKS = new Set(['data-je-flow', 'data-je-live', 'data-je-blur']);

        /** @param {ResizeObserverEntry[]} entries A watched card changed size. */
        /** @param {string} url @returns {string} Its origin ('' when it cannot be told). */
        function originOf(url) {
            try { return new URL(url, document.baseURI).origin; } catch { return ''; }
        }

        /** @param {string} url Remember artwork as unreadable, forgetting the oldest past the cap. */
        function markUnreadable(url) {
            unreadable.add(url);
            if (unreadable.size > UNREADABLE_CAP) unreadable.delete(unreadable.values().next().value);
        }

        /**
         * Read a card again once a passing state is over: a hover or focus
         * that scales the card, dims its artwork or fades its tag ends
         * without changing anything this part watches. The card's own
         * transitions ending, the pointer leaving it and focus leaving it
         * are the ends looked for; a card still in the state then waits on.
         * @param {Card} card
         * @param {boolean} [scaled] - The state is a transform's scale.
         */
        function measureAgainLater(card, scaled = false) {
            if (card.again) return;
            const target = card.host.closest('.card, .listItem') || card.host.parentElement;
            if (!target || typeof target.addEventListener !== 'function') return;
            let timer = 0;
            const stop = () => {
                if (card.again !== stop) return;
                card.again = null;
                if (timer) clearTimeout(timer);
                for (const type of AGAIN_EVENTS) target.removeEventListener(type, again);
            };
            const again = () => {
                if (card.again !== stop) return;
                stop();
                card.moved = true;
                markDirty(card);
            };
            card.again = stop;
            for (const type of AGAIN_EVENTS) target.addEventListener(type, again, { passive: true });
            // A scale may be an ancestor's, whose end the card never hears: look again anyway, at a
            // growing interval for as long as it lasts (a theme may scale its cards for good).
            if (scaled) {
                card.holdMs = Math.min(HOLD_MAX_MS, card.holdMs ? card.holdMs * 2 : HOLD_MS);
                timer = setTimeout(again, card.holdMs);
            }
        }

        function onResize(entries) {
            for (const entry of entries) {
                const card = cards.get(/** @type {HTMLElement} */ (entry.target));
                if (!card) continue;
                card.moved = true;
                markDirty(card);
            }
        }

        /**
         * Queue a card (its .je-tag-host) for its tags' backdrops and watch
         * it from now on; called whenever a status badge is drawn.
         * @param {HTMLElement|null|undefined} host
         */
        function track(host) {
            if (!host) return;
            // Where no picture will be painted the tag keeps the live filter.
            if (!active || supported === false || typeof MutationObserver !== 'function') { setBlur(host, true); return; }
            let card = cards.get(host);
            if (!card) {
                const created = /** @type {Card} */ ({ host, chips: null, art: null, container: null, img: null, onLoad: () => markDirty(created), sig: '', carriers: new Set(), kept: null, moved: true, on: [], latest: null, fullSig: '', again: null, live: false, resting: 0, holdMs: 0 });
                card = created;
                cards.set(host, card);
                // Chips arriving, leaving, moving or being fitted all change the host's subtree. Reading the
                // layout here, in the middle of whatever changed it (a hover reveal, a fitting pass), would
                // force it early, so a tag that moved keeps its old picture's place for the frame it moves in.
                card.chips = new MutationObserver((records) => {
                    if (records.every((record) => record.type === 'attributes' && record.target === host && HOST_MARKS.has(record.attributeName || ''))) return;
                    // Before the paint that shows the change: a tag drawn afresh must not be bare meanwhile.
                    dropStale(created);
                    created.moved = true;
                    markDirty(created);
                });
                card.chips.observe(host, { attributes: true, childList: true, subtree: true });
                if (typeof ResizeObserver === 'function') {
                    sizes = sizes || new ResizeObserver(onResize);
                    sizes.observe(host);
                }
            }
            // Until its pictures stand in for it, the tag has the live filter: the look never waits for this part.
            dropStale(card);
            if (!card.carriers.size) setBlur(host, true);
            card.moved = true;
            markDirty(card);
        }

        /**
         * Pictures on a slot that left the card, or that no longer holds a
         * status tag (the card was presented again, its badge redrawn or
         * removed), are not under any tag now: they go at once and the live
         * filter stands in, until the measuring pass shows the pictures the
         * card kept on its new slot. Cheap: a card has one or two carriers.
         * @param {Card} card
         */
        function dropStale(card) {
            if (!card.carriers.size) return;
            let stale = false;
            for (const carrier of card.carriers) {
                if (!carrier.isConnected || !card.host.contains(carrier) || !carrier.querySelector(`.${tagClass}`)) { stale = true; break; }
            }
            if (!stale) return;
            for (const carrier of card.carriers) clear(carrier);
            card.carriers.clear();
            card.on = [];
            setBlur(card.host, true);
        }

        /**
         * Take up again a card that was released while it was off the page
         * and is back with the same nodes (the layout controller says so).
         * @param {HTMLElement} host
         */
        function resume(host) {
            if (!host || !detached.has(host) || !host.isConnected) return;
            detached.delete(host);
            if (!host.querySelector(`.${tagClass}`)) { delete host.dataset.jeBlur; return; }
            track(host);
            try { JE.core?.tagLayout?.syncFlowOf?.(host); } catch { /* the controller decides it when the card is next placed */ }
        }

        /**
         * Give a card's status tags the live backdrop filter, or take it
         * away once their pictures stand in for it (tags/statustags.js styles
         * `.je-tag-host[data-je-blur] .status-tag`). A filtered tag is a layer
         * of its own, which a card resting in flow must not hold, so the
         * layout controller is told to decide the card's layout again.
         * @param {HTMLElement} host
         * @param {boolean} on
         */
        function setBlur(host, on) {
            if ((host.dataset.jeBlur === '1') === on) return;
            if (on) host.dataset.jeBlur = '1';
            else delete host.dataset.jeBlur;
            try { JE.core?.tagLayout?.syncFlowOf?.(host); } catch (err) { console.debug(`${backdropLog} could not re-decide a card's layout`, err); }
        }

        /**
         * Stop watching a card and take its pictures away: its tags keep
         * the live filter from then on.
         * @param {HTMLElement} host
         */
        function release(host) {
            const card = host ? cards.get(host) : null;
            if (!card) return;
            card.chips?.disconnect();
            card.art?.disconnect();
            card.img?.removeEventListener('load', card.onLoad);
            sizes?.unobserve(host);
            card.again?.();
            if (card.resting) clearTimeout(card.resting);
            card.resting = 0;
            card.live = false;
            lingering.delete(card);
            for (const carrier of card.carriers) clear(carrier);
            card.carriers.clear();
            // Off the page (its view was dropped, or its row is being moved): should the same nodes come
            // back, the tag has the live filter, and resume() takes the card up again.
            if (host.isConnected) setBlur(host, true);
            else { host.dataset.jeBlur = '1'; detached.add(host); }
            card.sig = '';
            card.on = [];
            card.latest = null;
            cards.delete(host);
            dirty.delete(card);
        }

        // ── Measuring (reads, then writes) ─────────────────────────────

        /**
         * Where the browser's pixel grid starts for an element's box (reads
         * only): the corner of the nearest ancestor that starts its own
         * (startsPixelGrid), else the page's. A plain translation in between
         * moves the grid with it.
         * @param {Element|null} el
         * @param {Map<Element, {x: number, y: number}>} memo - One pass's answers.
         * @returns {{x: number, y: number}} The origin in viewport CSS pixels.
         */
        function paintOrigin(el, memo) {
            if (!el || el === document.documentElement) return { x: 0, y: 0 };
            const known = memo.get(el);
            if (known) return known;
            const style = getComputedStyle(el);
            let origin;
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
         * @param {CSSStyleDeclaration} style
         * @param {number[]} box - Its painted box [left, top, right, bottom], in pixels.
         * @param {number} skip - Leading layers that are pictures.
         * @returns {{colour: string|null, gradients: Object[], text: string}|null} Null when it paints something else; `text` is '' when it paints nothing.
         */
        function backgroundOf(style, box, skip) {
            const colour = parseColour(style.backgroundColor);
            if (!colour) return null;
            const images = splitLayers(style.backgroundImage).slice(skip);
            const gradients = [];
            for (const image of images) {
                if (image === 'none') continue;
                const gradient = parseGradient(image);
                if (!gradient) return null;
                gradients.push(gradient);
            }
            if (gradients.length) {
                // Only gradients that fill their box as they are.
                const plain = (value, allowed) => splitLayers(value).slice(skip).slice(0, images.length).every((v) => allowed.includes(v));
                if (!plain(style.backgroundSize, ['auto', 'auto auto', '100% 100%']) || !plain(style.backgroundPosition, ['0% 0%', '0px 0px'])
                    || !plain(style.backgroundOrigin, ['padding-box', 'border-box']) || !plain(style.backgroundClip, ['border-box', 'padding-box'])
                    || parseFloat(style.borderTopWidth) || parseFloat(style.borderLeftWidth) || parseFloat(style.borderRightWidth) || parseFloat(style.borderBottomWidth)) return null;
            }
            const painted = colour[3] > 0 || gradients.length > 0;
            return { colour: colour[3] > 0 ? style.backgroundColor : null, gradients, text: painted ? `${style.backgroundColor};${images.join(',')}@${box.join(',')}` : '' };
        }

        /**
         * A carrier's own background layers (under the pictures).
         * @param {CSSStyleDeclaration} style
         * @param {number} skip - Leading layers that are pictures.
         * @returns {Base|null} Null when it has none.
         */
        function baseOf(style, skip) {
            const image = splitLayers(style.backgroundImage).slice(skip);
            if (!image.length || image.every((v) => v === 'none')) return null;
            const list = (value, fallback) => {
                const own = splitLayers(value).slice(skip);
                return image.map((_, i) => own[i % Math.max(1, own.length)] || fallback);
            };
            return { image, position: list(style.backgroundPosition, '0% 0%'), size: list(style.backgroundSize, 'auto'), repeat: list(style.backgroundRepeat, 'repeat') };
        }

        /**
         * Whether a chip of an earlier slot paints under a tag's box (reads
         * only): slots are painted in order, so a chip of a slot before the
         * tag's own lies under it where they overlap, and the filter blurred
         * it with the artwork, shadow and all. Such a tag keeps the live
         * filter: a redrawn chip would only be near. A slot counts only
         * while it shows as the tag's own slot does (the same opacity):
         * corner slots fade together when the pointer hides the tags, which
         * changes nothing, and a summary that gives way to the hover reveal
         * is not under the chips revealed.
         * @param {HTMLElement} host
         * @param {HTMLElement} slot - The tag's slot.
         * @param {number} opacity - The slot's computed opacity.
         * @param {number[]} box - The tag's box [left, top, right, bottom] in the grid, in pixels.
         * @param {(v: number) => number} X - Viewport CSS x → grid pixels.
         * @param {(v: number) => number} Y
         * @returns {boolean}
         */
        function chipBeneath(host, slot, opacity, box, X, Y) {
            // (A chip's shadow, ring or outline reaches a little past its box.)
            const over = (r) => r.width > 0 && r.height > 0 && X(r.right) > box[0] - BENEATH_REACH && X(r.left) < box[2] + BENEATH_REACH
                && Y(r.bottom) > box[1] - BENEATH_REACH && Y(r.top) < box[3] + BENEATH_REACH;
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
                    if ((colour && colour[3] > 0) || (edge > 0 && edgeColour && edgeColour[3] > 0)) return true;
                    if (el.tagName === 'IMG' || el.localName === 'svg' || style.backgroundImage !== 'none' || style.boxShadow !== 'none') return true;
                    if (Array.from(el.childNodes).some((node) => node.nodeType === 3 && /\S/.test(node.nodeValue || ''))) return true;
                }
            }
            return false;
        }

        /**
         * Read one card: where its tags, their carriers and its artwork are.
         * @param {Card} card
         * @param {number} scale
         * @param {{origins: Map<Element, {x: number, y: number}>, probed: boolean}} pass - This pass's paint origins, and whether it has read the layout yet.
         * @returns {{card: Card, sig: string, job: Job|null}}
         */
        function read(card, scale, pass) {
            const none = { card, sig: '', job: null };
            const host = card.host;
            const tags = Array.from(host.querySelectorAll(`.${tagClass}`));
            if (!tags.length) return none;
            const art = artworkOf(host);
            watchArtwork(card, art ? ('wait' in art ? art.wait : art.container) : null, art && 'wait' in art ? art.img : null);
            if (!art || 'wait' in art || unreadable.has(art.url) || (tainting.size && tainting.has(originOf(art.url)))) return none;
            // Only the artwork went and came back (Jellyfin unloads the images of cards scrolled out of a
            // row): nothing moved, so the pictures drawn for it are shown again without reading the layout.
            // They are the pictures of the layout last read: a card read since they were drawn (its tag
            // changed and the new picture is still to draw, or there was nothing to draw) is read again.
            const kept = card.kept;
            if (!card.moved && kept && kept.job.sig === card.fullSig && kept.job.url === art.url && kept.job.scale === scale
                && kept.job.specs.every((spec) => spec.pieces.every((p) => p.carrier.isConnected))) {
                return { card, sig: kept.job.sig, job: kept.job };
            }
            /** The layout read. @returns {{card: Card, sig: string, job: Job|null, hold?: boolean}} */
            const full = () => {
                // The first geometry read of a pass pays for any layout the page still owes (other modules'
                // writes since the last frame); timed apart, so the counters tell it from this part's own reads.
                const probe = pass.probed ? 0 : performance.now();
                const boxRect = art.box.getBoundingClientRect();
                if (!pass.probed) {
                    pass.probed = true;
                    counters.layoutMs += performance.now() - probe;
                }
                if (!(boxRect.width > 0 && boxRect.height > 0)) { card.moved = false; return none; }
                // A card scaled by a transform (a focused card on a TV, a theme's hover) measures larger
                // than it is laid out, and its pictures are written in layout pixels: it keeps what it
                // has and is read when the state is over.
                const laidOut = [art.box.offsetWidth, art.box.offsetHeight];
                if (laidOut[0] > 0 && laidOut[1] > 0 && (Math.abs(boxRect.width - laidOut[0]) > Math.max(1, laidOut[0] * 0.01)
                    || Math.abs(boxRect.height - laidOut[1]) > Math.max(1, laidOut[1] * 0.01))) {
                    measureAgainLater(card, true);
                    return { card, sig: '', job: null, hold: true };
                }
                card.moved = false;
                card.holdMs = 0;
                const boxStyle = getComputedStyle(art.box);
                // Never sharper than the page shows it: artwork a style filters, hides or fades keeps the live filter
                // (while a hover dims it, say: the card is read again when that is over).
                const shown = (style, el) => style.filter === 'none' && style.visibility !== 'hidden'
                    && (Number(style.opacity) >= 1 || (typeof el.getAnimations === 'function' && el.getAnimations().length > 0));
                if (!shown(boxStyle, art.box)) { measureAgainLater(card); return none; }
                const containerStyle = art.container === art.box ? boxStyle : getComputedStyle(art.container);
                if (art.container !== art.box && !shown(containerStyle, art.container)) { measureAgainLater(card); return none; }
                /** @type {{size: string, position: string}} */
                let fit;
                if (art.img) fit = { size: boxStyle.objectFit, position: boxStyle.objectPosition };
                else {
                    if (splitLayers(boxStyle.backgroundImage).length !== 1 || boxStyle.backgroundAttachment !== 'scroll'
                        || !['padding-box', 'border-box'].includes(boxStyle.backgroundOrigin)
                        || (boxStyle.backgroundRepeat !== 'no-repeat' && boxStyle.backgroundSize !== 'cover')) return none;
                    fit = { size: boxStyle.backgroundSize, position: boxStyle.backgroundPosition };
                }
                const baseColour = [boxStyle.backgroundColor, containerStyle.backgroundColor].find((c) => (parseColour(c) || [0, 0, 0, 0])[3] >= 1) || null;
                // Pixels in the coordinates the card is painted (and snapped) in.
                const origin = paintOrigin(host, pass.origins);
                const X = (v) => (v - origin.x) * scale, Y = (v) => (v - origin.y) * scale;
                const boxLeft = snap(X(boxRect.left)), boxTop = snap(Y(boxRect.top));
                const boxWidth = snap(X(boxRect.right)) - boxLeft, boxHeight = snap(Y(boxRect.bottom)) - boxTop;
                if (!(boxWidth > 0 && boxHeight > 0)) return none;
                const frac = (v) => units(v - Math.floor(v));

                /**
                 * An element's facts, read once a pass: its box, its painted box, its unsnapped padding box and how many pictures it holds.
                 * @type {Map<Element, {style: CSSStyleDeclaration, rect: DOMRect, painted: number[], padding: number[], own: number}>}
                 */
                const seen = new Map();
                const facts = (el) => {
                    let f = seen.get(el);
                    if (!f) {
                        const rect = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        const border = (side) => (parseFloat(style[side]) || 0) * scale;
                        f = {
                            style,
                            rect,
                            painted: [snap(X(rect.left)), snap(Y(rect.top)), snap(X(rect.right)), snap(Y(rect.bottom))],
                            padding: [X(rect.left) + border('borderLeftWidth'), Y(rect.top) + border('borderTopWidth'), X(rect.right) - border('borderRightWidth'), Y(rect.bottom) - border('borderBottomWidth')],
                            own: applied.get(/** @type {HTMLElement} */ (el)) || 0,
                        };
                        seen.set(el, f);
                    }
                    return f;
                };
                /** @type {Spec[]} */
                const specs = [];
                /** @type {Map<HTMLElement, Base>} */
                const bases = new Map();
                const parts = [];
                // A tag that shows a backdrop and gets no picture here: the card then keeps the live filter for all of them.
                let partial = false;
                for (const tag of tags) {
                    const rect = tag.getBoundingClientRect();
                    if (!(rect.width > 0 && rect.height > 0)) continue;
                    const style = getComputedStyle(tag);
                    const colour = parseColour(style.backgroundColor);
                    // An opaque tag hides its backdrop; a hidden one shows nothing.
                    if (style.visibility === 'hidden' || (colour && colour[3] >= 1 && style.backgroundImage === 'none')) continue;
                    const group = /** @type {HTMLElement|null} */ (tag.closest('[data-je-group]'));
                    const slot = /** @type {HTMLElement|null} */ (tag.closest('.je-tag-slot'));
                    if (!group || !slot || !host.contains(slot)) { partial = true; continue; }
                    // The picture is the slot's, so it would stay at full strength under a tag that is
                    // itself translucent or fading (its own opacity, or its group's): the live filter then.
                    if (Number(style.opacity) < 1 || (group !== tag && Number(facts(group).style.opacity) < 1)) { partial = true; measureAgainLater(card); continue; }
                    // The backdrop filter's own pixels: the tag's snapped corner, and its size rounded as a whole.
                    // A group or slot that starts a pixel grid of its own snaps the tag from its own snapped corner.
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
                    const unders = [];
                    let drawable = true;
                    let underText = '';
                    for (const el of [host, slot, group]) {
                        const f = facts(el);
                        if (!(f.painted[2] > f.painted[0] && f.painted[3] > f.painted[1])) continue;
                        const bg = backgroundOf(f.style, f.painted.map((v, i) => v - (i % 2 ? boxTop : boxLeft)), f.own);
                        if (!bg) { drawable = false; break; }
                        if (!bg.text) continue;
                        unders.push({ x: f.painted[0] - boxLeft, y: f.painted[1] - boxTop, width: f.painted[2] - f.painted[0], height: f.painted[3] - f.painted[1], colour: bg.colour, gradients: bg.gradients, host: el === host });
                        underText += `${bg.text};`;
                    }
                    if (!drawable) { partial = true; continue; }
                    // The slot shows the picture's pixels that lie inside its own box.
                    /** @type {Piece[]} */
                    const pieces = [];
                    const piece = (carrier, x0, y0, x1, y1) => {
                        if (!(x1 > x0 && y1 > y0)) return;
                        const f = facts(carrier);
                        const h = placeLayer(x0, x1, f.padding[0], f.padding[2]), v = placeLayer(y0, y1, f.padding[1], f.padding[3]);
                        if (!h || !v || x0 < f.painted[0] || y0 < f.painted[1] || x1 > f.painted[2] || y1 > f.painted[3]) return;
                        pieces.push({ carrier, sx: x0 - left, sy: y0 - top, width: x1 - x0, height: y1 - y0, left: units(h.offset / scale), top: units(v.offset / scale), cssWidth: units(h.size / scale), cssHeight: units(v.size / scale) });
                        if (!bases.has(carrier)) {
                            const base = baseOf(f.style, f.own);
                            if (base) bases.set(carrier, base);
                        }
                    };
                    const inSlot = facts(slot).painted;
                    const cutRight = Math.max(left, Math.min(left + width, inSlot[2])), cutBottom = Math.max(top, Math.min(top + height, inSlot[3]));
                    piece(slot, Math.max(left, inSlot[0]), Math.max(top, inSlot[1]), cutRight, cutBottom);
                    if (!pieces.length) { partial = true; continue; }
                    const corners = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
                    // A corner given as a percentage or as an ellipse is not cut here: a square picture
                    // would show past the pill's corners, so such a tag keeps the live filter.
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
            };
            const result = full();
            if (!result.hold) card.fullSig = result.sig;
            return result;
        }

        /**
         * A measuring pass: read every card, then write. A card whose
         * geometry is unchanged is left alone; a changed one loses its
         * pictures (they no longer fit) and is queued for drawing.
         * @param {Card[]} list
         */
        function measure(list) {
            const started = performance.now();
            const scale = pixelScale();
            const pass = { origins: new Map(), probed: false };
            // A card in use keeps the live filter: it is read when it rests (rest).
            const plans = list.filter((card) => card.host.isConnected && cards.get(card.host) === card && !card.live).map((card) => read(card, scale, pass));
            for (const { card, sig, job, hold } of plans) {
                if (hold) {
                    // A scaled card cannot be read: the filter scales with it, whatever its tags do meanwhile.
                    for (const carrier of card.carriers) clear(carrier);
                    card.carriers.clear();
                    card.on = [];
                    setBlur(card.host, true);
                    card.chips?.takeRecords();
                    continue;
                }
                // The same geometry on the same elements: nothing to do. The same geometry on new elements
                // (a card presented again in place draws its slots afresh) needs its pictures put on them.
                const on = job ? job.specs.flatMap((spec) => spec.pieces.map((p) => p.carrier)) : [];
                if (sig === card.sig && on.length === card.on.length && on.every((carrier, i) => carrier === card.on[i])) continue;
                card.sig = sig;
                card.on = on;
                card.latest = job;
                // The geometry its pictures were drawn for is back (artwork that went and returned, slots
                // drawn afresh): they are shown again, not redrawn.
                if (job && card.kept?.job.sig === sig) {
                    counters.reused++;
                    const drawn = card.kept.drawn;
                    card.kept = { job, drawn };
                    show(job, drawn);
                    continue;
                }
                for (const carrier of card.carriers) clear(carrier);
                card.carriers.clear();
                // No picture until the new one is drawn (or at all): the live filter stands in.
                setBlur(card.host, true);
                // The pictures taken away are not a change to measure.
                card.chips?.takeRecords();
                if (job && isSupported()) {
                    waiting.push(job);
                    scheduleSlice();
                }
            }
            // A browser that cannot do the pixel work: nothing is watched or measured for it again.
            if (supported === false) setActive(false);
            const spent = performance.now() - started;
            counters.measures++;
            counters.cards += plans.length;
            counters.measureMs += spent;
            counters.maxMeasureMs = Math.max(counters.maxMeasureMs, spent);
        }

        /**
         * The pass after a paint: the cards queued by then, a few at a time
         * while the pass has time; the rest are measured after the next
         * paint, so a page full of new cards never holds the main thread for
         * long. Cards gone from the page (a row Jellyfin dropped, a recycled
         * list) are released first: a badge drawn anywhere runs this pass,
         * so none is kept long.
         */
        function measureDirty() {
            measureScheduled = false;
            for (const host of Array.from(cards.keys())) if (!host.isConnected) release(host);
            if (!active) { dirty.clear(); return; }
            const started = performance.now();
            while (dirty.size && performance.now() - started < MEASURE_BUDGET_MS) {
                const batch = Array.from(dirty).slice(0, MEASURE_CARDS);
                for (const card of batch) dirty.delete(card);
                measure(batch);
            }
            if (dirty.size) markDirty(/** @type {Card} */ (dirty.values().next().value));
            counters.passes++;
            counters.maxPassMs = Math.max(counters.maxPassMs, performance.now() - started);
        }

        // ── Writing a carrier's pictures ───────────────────────────────

        /**
         * Show a carrier's pictures: background layers above its own.
         * @param {HTMLElement} carrier
         * @param {Layer[]} layers - CSS pixels in the carrier's padding box.
         * @param {Base|null} base
         */
        function write(carrier, layers, base) {
            const image = layers.map((l) => `url("${l.url}")`);
            const position = layers.map((l) => `${l.x}px ${l.y}px`);
            const size = layers.map((l) => `${l.width}px ${l.height}px`);
            const repeat = layers.map(() => 'no-repeat');
            if (base) {
                image.push(...base.image);
                position.push(...base.position);
                size.push(...base.size);
                repeat.push(...base.repeat);
            }
            carrier.style.setProperty('background-image', image.join(', '));
            carrier.style.setProperty('background-position', position.join(', '));
            carrier.style.setProperty('background-size', size.join(', '));
            carrier.style.setProperty('background-repeat', repeat.join(', '));
            applied.set(carrier, layers.length);
        }

        /** @param {HTMLElement} carrier Take a carrier's pictures away. */
        function clear(carrier) {
            if (!applied.has(carrier)) return;
            applied.delete(carrier);
            for (const property of ['background-image', 'background-position', 'background-size', 'background-repeat']) carrier.style.removeProperty(property);
        }

        // ── Drawing (idle slices) ──────────────────────────────────────

        /** Run a slice when the browser is idle (soon, at the latest). */
        function scheduleSlice() {
            if (sliceScheduled || !active) return;
            sliceScheduled = true;
            if (typeof requestIdleCallback === 'function') requestIdleCallback(runSlice, { timeout: 500 });
            else setTimeout(runSlice, 16);
        }

        /** @param {Job} job @returns {boolean} Whether a card still wants the pictures this job draws. */
        const wanted = (job) => cards.get(job.card.host) === job.card && job.card.sig === job.sig && job.card.latest === job && job.card.host.isConnected;

        /**
         * One idle slice: the pixel steps of cards whose artwork is decoded
         * while the idle period lasts (at least one when the slice ran late),
         * then decode launches into free slots.
         * @param {IdleDeadline} [deadline]
         */
        function runSlice(deadline) {
            sliceScheduled = false;
            if (!active) return;
            const started = performance.now();
            const left = typeof deadline?.timeRemaining === 'function'
                ? () => deadline.timeRemaining()
                : () => SLICE_BUDGET_MS - (performance.now() - started);
            const late = !deadline || !!deadline.didTimeout;
            let steps = 0;
            while (ready.length && (left() >= STEP_MIN_MS || (late && steps === 0))) {
                const job = /** @type {Job} */ (ready.shift());
                if (!wanted(job)) continue;
                steps++;
                draw(job);
            }
            let launched = 0;
            while (waiting.length && (left() >= STEP_MIN_MS || (late && !steps && !launched))) {
                const job = waiting[0];
                if (!wanted(job)) { waiting.shift(); continue; }
                if (artwork.has(job.key)) { waiting.shift(); ready.push(job); continue; }
                const flight = decoding.get(job.key);
                if (flight) { waiting.shift(); flight.jobs.add(job); continue; }
                if (decoding.size >= MAX_DECODES) break;
                waiting.shift();
                launched++;
                decode(job);
            }
            const spent = performance.now() - started;
            counters.slices++;
            counters.sliceMs += spent;
            counters.maxSliceMs = Math.max(counters.maxSliceMs, spent);
            if (ready.length || (waiting.length && decoding.size < MAX_DECODES)) scheduleSlice();
        }

        /**
         * Decode a card's artwork off the main thread: the card's own <img>
         * when it has one, else the same URL in an image of this part's (the
         * browser already holds it), then an ImageBitmap of it. Without
         * createImageBitmap the decoded image itself is drawn.
         * @param {Job} job
         */
        function decode(job) {
            const key = job.key;
            const gen = generation;
            const flight = { jobs: new Set([job]) };
            decoding.set(key, flight);
            counters.decodes++;
            const settle = (entry) => {
                const stale = decoding.get(key) !== flight || gen !== generation;
                if (decoding.get(key) === flight) decoding.delete(key);
                if (stale) {
                    if (entry?.bitmap) /** @type {ImageBitmap} */ (entry.drawable).close?.();
                    return;
                }
                if (entry) {
                    remember(key, entry);
                    for (const j of flight.jobs) ready.push(j);
                } else {
                    markUnreadable(key);
                    counters.failed++;
                }
                scheduleSlice();
            };
            (async () => {
                let source = job.img && job.img.complete && job.img.naturalWidth > 0 ? job.img : null;
                if (!source) {
                    source = new Image();
                    source.decoding = 'async';
                    source.src = job.url;
                    await source.decode();
                }
                const width = source.naturalWidth, height = source.naturalHeight;
                if (!(width > 0 && height > 0)) return null;
                if (typeof createImageBitmap === 'function') {
                    try {
                        return { drawable: await createImageBitmap(source), bitmap: true, width, height };
                    } catch (err) {
                        if (err?.name === 'SecurityError') return null;
                    }
                }
                if (source === job.img && typeof source.decode === 'function') await source.decode();
                return { drawable: source, bitmap: false, width, height };
            })().then(settle, (err) => {
                if (err?.name !== 'SecurityError' && err?.name !== 'InvalidStateError' && err?.name !== 'EncodingError') console.debug(`${backdropLog} could not decode artwork`, err);
                settle(null);
            });
        }

        /**
         * Keep decoded artwork (the oldest goes first past the caps).
         * @param {string} key
         * @param {{drawable: CanvasImageSource, bitmap: boolean, width: number, height: number}} entry
         */
        function remember(key, entry) {
            forget(key);
            artwork.set(key, entry);
            const pixels = () => { let sum = 0; for (const e of artwork.values()) sum += e.width * e.height; return sum; };
            while (artwork.size > 1 && (artwork.size > ARTWORK_CAP || pixels() > ARTWORK_PIXELS)) forget(artwork.keys().next().value);
        }

        /** @param {string} key Drop decoded artwork and free its bitmap. */
        function forget(key) {
            const entry = artwork.get(key);
            if (!entry) return;
            artwork.delete(key);
            if (entry.bitmap) /** @type {ImageBitmap} */ (entry.drawable).close?.();
        }

        /**
         * A rounded rectangle path (each corner's radius limited to the box).
         * @param {CanvasRenderingContext2D} ctx
         * @param {number} width
         * @param {number} height
         * @param {number[]} radii - Top left, top right, bottom right, bottom left.
         */
        function roundedPath(ctx, width, height, radii) {
            const limit = Math.min(1, ...[
                width / Math.max(1e-6, radii[0] + radii[1]), width / Math.max(1e-6, radii[3] + radii[2]),
                height / Math.max(1e-6, radii[0] + radii[3]), height / Math.max(1e-6, radii[1] + radii[2]),
            ]);
            const [tl, tr, br, bl] = radii.map((r) => r * limit);
            ctx.beginPath();
            ctx.moveTo(tl, 0);
            ctx.lineTo(width - tr, 0);
            ctx.arcTo(width, 0, width, tr, tr);
            ctx.lineTo(width, height - br);
            ctx.arcTo(width, height, width - br, height, br);
            ctx.lineTo(bl, height);
            ctx.arcTo(0, height, 0, height - bl, bl);
            ctx.lineTo(0, tl);
            ctx.arcTo(0, 0, tl, 0, tl);
            ctx.closePath();
        }

        /**
         * Paint a gradient over a box.
         * @param {CanvasRenderingContext2D} ctx
         * @param {Under} under
         * @param {{angle: number, stops: {at: number, colour: string}[]}} gradient
         * @param {number} dx - The box's offset in the canvas.
         * @param {number} dy
         */
        function fillGradient(ctx, under, gradient, dx, dy) {
            const rad = gradient.angle * Math.PI / 180;
            const sin = Math.sin(rad), cos = Math.cos(rad);
            const half = (Math.abs(under.width * sin) + Math.abs(under.height * cos)) / 2;
            const cx = dx + under.width / 2, cy = dy + under.height / 2;
            const fill = ctx.createLinearGradient(cx - sin * half, cy + cos * half, cx + sin * half, cy - cos * half);
            for (const stop of gradient.stops) fill.addColorStop(stop.at, stop.colour);
            ctx.fillStyle = fill;
            ctx.fillRect(dx, dy, under.width, under.height);
        }

        /**
         * One tag's picture: what is behind the tag, blurred, with the tag's
         * corners cut; then each of its parts as an image.
         * @param {Job} job
         * @param {Spec} spec
         * @param {{drawable: CanvasImageSource, width: number, height: number}} art
         * @param {{x: number, y: number, width: number, height: number}} placed - The image in its box.
         * @returns {string[]|null} A PNG data URL for each piece, or null when the tag keeps the live filter.
         */
        function picture(job, spec, art, placed) {
            const { width, height } = spec;
            canvas = canvas || document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, width, height);
            if (job.base) {
                ctx.fillStyle = job.base;
                ctx.fillRect(0, 0, width, height);
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawImage(art.drawable, placed.x - spec.x, placed.y - spec.y, placed.width, placed.height);
            const background = (under) => {
                const dx = under.x - spec.x, dy = under.y - spec.y;
                if (under.colour) {
                    ctx.fillStyle = under.colour;
                    ctx.fillRect(dx, dy, under.width, under.height);
                }
                // The last layer is painted first.
                for (let i = under.gradients.length - 1; i >= 0; i--) fillGradient(ctx, under, under.gradients[i], dx, dy);
            };
            // In paint order: the host's own background, the chips of earlier slots, then the tag's slot and group.
            spec.unders.filter((under) => under.host).forEach(background);
            spec.unders.filter((under) => !under.host).forEach(background);
            const pixels = ctx.getImageData(0, 0, width, height);
            const data = pixels.data;
            // Something unknown shows through: no picture.
            for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return null;
            blurRgba(data, width, height, BLUR_PX * job.scale);
            ctx.putImageData(pixels, 0, 0);
            if (spec.radii.some((r) => r > 0)) {
                ctx.globalCompositeOperation = 'destination-in';
                ctx.fillStyle = '#000';
                roundedPath(ctx, width, height, spec.radii);
                ctx.fill();
                ctx.globalCompositeOperation = 'source-over';
            }
            return spec.pieces.map((p) => {
                if (p.sx === 0 && p.sy === 0 && p.width === width && p.height === height) return /** @type {HTMLCanvasElement} */ (canvas).toDataURL('image/png');
                cutter = cutter || document.createElement('canvas');
                cutter.width = p.width;
                cutter.height = p.height;
                const cut = cutter.getContext('2d');
                if (!cut) return '';
                cut.clearRect(0, 0, p.width, p.height);
                cut.drawImage(/** @type {HTMLCanvasElement} */ (canvas), p.sx, p.sy, p.width, p.height, 0, 0, p.width, p.height);
                return cutter.toDataURL('image/png');
            });
        }

        /**
         * Show a card's pictures: each tag's parts as layers of their carriers.
         * @param {Job} job
         * @param {(string[]|null)[]} drawn - Each tag's pictures, in the job's order.
         */
        function show(job, drawn) {
            /** @type {Map<HTMLElement, Layer[]>} */
            const layers = new Map();
            job.specs.forEach((spec, at) => {
                const urls = drawn[at];
                if (!urls) return;
                spec.pieces.forEach((p, i) => {
                    if (!urls[i]) return;
                    if (!layers.has(p.carrier)) layers.set(p.carrier, []);
                    /** @type {Layer[]} */ (layers.get(p.carrier)).push({ url: urls[i], x: p.left, y: p.top, width: p.cssWidth, height: p.cssHeight });
                });
            });
            const card = job.card;
            // In use: the live filter shows what is behind the tag now (rest() shows these pictures later).
            if (card.live) return;
            // Pictures stand in for the filter only when every tag that shows a backdrop has all of its own.
            const complete = !job.partial && job.specs.length > 0 && job.specs.every((spec, at) => {
                const urls = drawn[at];
                return !!urls && spec.pieces.every((p, i) => !!urls[i] && p.carrier.isConnected);
            });
            if (!complete) layers.clear();
            for (const carrier of Array.from(card.carriers)) {
                if (layers.has(carrier)) continue;
                clear(carrier);
                card.carriers.delete(carrier);
            }
            for (const [carrier, list] of layers) {
                write(carrier, list, job.bases.get(carrier) || null);
                card.carriers.add(carrier);
            }
            // These writes are not a change to measure.
            card.chips?.takeRecords();
            setBlur(card.host, !complete);
        }

        // ── A card in use ──────────────────────────────────────────────
        // A picture is the artwork under a resting tag. With the pointer on a
        // card (where it does not hide the tags) or focus inside it, Jellyfin
        // draws its overlay between the artwork and the tags, and the backdrop
        // filter blurred that too. A card in use therefore gives its pictures
        // up for the live filter, and takes them back once it rests.

        /**
         * Whether the pointer hides this card's tags instead of leaving them
         * on show (the layout controller's rule: "Hide tags on hover", except
         * for the layouts with a hover reveal of their own).
         * @param {HTMLElement} host
         * @returns {boolean}
         */
        function hidesOnHover(host) {
            if (!document.body?.classList.contains('je-tags-hide-on-hover')) return false;
            const layout = host.dataset.jeLayout;
            return layout !== 'summary' && layout !== 'minimal';
        }

        /** @param {Card} card @returns {boolean} Whether focus is in its card, or the pointer is on it with its tags on show. */
        function inUse(card) {
            try {
                const el = card.host.closest('.card, .listItem');
                return !!el && (el.matches(':focus-within') || (!hidesOnHover(card.host) && el.matches(':hover')));
            } catch {
                return false;
            }
        }

        /** @param {Card} card The pointer or focus arrived: the live filter, and no picture under it. */
        function use(card) {
            if (card.resting) clearTimeout(card.resting);
            card.resting = 0;
            lingering.delete(card);
            if (card.live) return;
            card.live = true;
            setBlur(card.host, true);
            for (const carrier of card.carriers) clear(carrier);
            card.carriers.clear();
            // Put back by the measuring pass once the card rests (the same geometry: shown again, not redrawn).
            card.on = [];
            card.chips?.takeRecords();
        }

        /**
         * A card the pointer or focus left: its pictures come back shortly,
         * unless it is in use again by then. A card still in use when the
         * time comes is looked at again when the pointer shows up elsewhere
         * (a touch leaves its card hovered and sends no pointerout later).
         * @param {Card} card
         */
        function rest(card) {
            if (!card.live || card.resting) return;
            card.resting = setTimeout(() => {
                card.resting = 0;
                if (!card.live || cards.get(card.host) !== card) return;
                if (inUse(card)) {
                    // Focus says when it leaves; a hover left behind by a touch does not.
                    let over = false;
                    try { over = !!card.host.closest('.card, .listItem')?.matches(':hover'); } catch { over = false; }
                    if (over) lingering.add(card);
                    return;
                }
                card.live = false;
                card.moved = true;
                markDirty(card);
            }, LIVE_REST_MS);
        }

        /** @param {Event} event A pointerover or focusin anywhere on the page. */
        function onUse(event) {
            const target = event.target instanceof Element ? event.target : null;
            const pointer = event.type === 'pointerover';
            const el = target ? target.closest('.card, .listItem') : null;
            if (pointer) for (const card of Array.from(lingering)) if (!el || !el.contains(card.host)) { lingering.delete(card); rest(card); }
            const host = el ? /** @type {HTMLElement|null} */ (el.querySelector('.je-tag-host')) : null;
            const card = host ? cards.get(host) : undefined;
            if (!card || !host || (pointer && hidesOnHover(host))) return;
            use(card);
        }

        /** @param {Event} event A pointerout or focusout anywhere on the page. */
        function onLeave(event) {
            const target = event.target instanceof Element ? event.target : null;
            const el = target ? target.closest('.card, .listItem') : null;
            const to = /** @type {any} */ (event).relatedTarget instanceof Node ? /** @type {any} */ (event).relatedTarget : null;
            if (!el || (to && el.contains(to))) return;
            const host = /** @type {HTMLElement|null} */ (el.querySelector('.je-tag-host'));
            const card = host ? cards.get(host) : undefined;
            if (card) rest(card);
        }

        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('pointerover', onUse, { passive: true });
            document.addEventListener('focusin', onUse);
            document.addEventListener('pointerout', onLeave, { passive: true });
            document.addEventListener('focusout', onLeave);
        }

        /**
         * A card's pixel step (timed): draw each tag's picture and show them.
         * The pictures are kept with the geometry they were drawn for.
         * @param {Job} job
         */
        function draw(job) {
            const art = artwork.get(job.key);
            if (!art) { waiting.push(job); return; }
            // Used again: the most recent artwork is kept longest.
            artwork.delete(job.key);
            artwork.set(job.key, art);
            const started = performance.now();
            /** @type {(string[]|null)[]} each tag's pictures (null: it keeps the live filter) */
            let drawn = [];
            try {
                const placed = fitImage(art.width, art.height, job.boxWidth, job.boxHeight, job.fit, job.scale);
                drawn = job.specs.map((spec) => {
                    const urls = placed ? picture(job, spec, art, placed) : null;
                    if (urls) counters.drawn++;
                    else counters.plain++;
                    return urls;
                });
            } catch (err) {
                // A canvas the browser will not let us read: this artwork keeps the live filter.
                drawn = [];
                markUnreadable(job.key);
                // Artwork from another origin without CORS: every image from there would be decoded, drawn and refused.
                if (err?.name === 'SecurityError') tainting.add(originOf(job.key));
                forget(job.key);
                counters.failed++;
                if (err?.name !== 'SecurityError') console.debug(`${backdropLog} could not draw a backdrop`, err);
            }
            job.card.kept = { job, drawn };
            show(job, drawn);
            const spent = performance.now() - started;
            counters.pixelMs += spent;
            counters.maxPixelMs = Math.max(counters.maxPixelMs, spent);
        }

        // ── Switches ───────────────────────────────────────────────────

        /** Measure every watched card again (the pixel density changed). */
        function refresh() {
            for (const card of cards.values()) {
                card.moved = true;
                markDirty(card);
            }
        }

        /** Drop every drawing in flight and all decoded artwork. */
        function dropWork() {
            generation++;
            waiting.length = 0;
            ready.length = 0;
            decoding.clear();
            for (const key of Array.from(artwork.keys())) forget(key);
        }

        /**
         * Turn the backdrops on or off (off: every picture goes at once and
         * every card is released; on: every card on the page is tracked).
         * @param {boolean} on
         */
        function setActive(on) {
            on = !!on;
            if (on === active) return;
            active = on;
            if (on) {
                document.querySelectorAll('.je-tag-host').forEach((host) => track(/** @type {HTMLElement} */ (host)));
                return;
            }
            for (const host of Array.from(cards.keys())) release(host);
            dirty.clear();
            dropWork();
        }

        // A user switch: decoded artwork of the outgoing user is dropped
        // (the incoming user's cards are drawn, and tracked, again).
        JE.session?.onUserChange?.('status-tag-backdrop', () => {
            dropWork();
            unreadable.clear();
            tainting.clear();
            // The outgoing user's pictures go at once, not when their cards are next measured.
            for (const card of cards.values()) {
                for (const carrier of card.carriers) clear(carrier);
                card.carriers.clear();
                setBlur(card.host, true);
                card.sig = '';
                card.fullSig = '';
                card.kept = null;
                card.on = [];
                card.latest = null;
            }
            refresh();
        });

        // A content security policy without `data:` among its image sources refuses every picture
        // after the work of drawing it: the first refusal turns the pictures off for the page.
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('securitypolicyviolation', (event) => {
                // (A report-only policy refuses nothing.)
                if (!active || (event.disposition && event.disposition !== 'enforce') || event.blockedURI !== 'data'
                    || !/^img-src/.test(event.effectiveDirective || event.violatedDirective || '')) return;
                console.warn(`${backdropLog} the page's content security policy refuses data: images; status tags keep the live backdrop filter.`);
                setActive(false);
            });
        }

        // Browser zoom or a move to another screen changes the pixel grid the pictures are cut for.
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('resize', () => {
                if (!cards.size) return;
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(refresh, RESIZE_SETTLE_MS);
            }, { passive: true });
        }

        return {
            BLUR_PX,
            track,
            release,
            resume,
            refresh,
            setActive,
            isActive: () => active,
            /** @returns {Object} Timings and counts (performance checks). */
            stats: () => ({ ...counters, watching: cards.size, waiting: waiting.length, ready: ready.length, decoding: decoding.size, artwork: artwork.size, unreadable: unreadable.size }),
            boxSizes,
            blurRgba,
            fitImage,
            parseGradient,
            parseColour,
            splitLayers,
            snap,
            startsPixelGrid,
            placeLayer,
        };
    })();

    JE.statusTagBackdrop = backdrop;

    // The tags drawn while this file was on its way.
    if (typeof document !== 'undefined') {
        const waiting = new Set();
        document.querySelectorAll(`.je-tag-host .${tagClass}`).forEach((tag) => waiting.add(tag.closest('.je-tag-host')));
        waiting.forEach((host) => backdrop.track(/** @type {HTMLElement} */ (host)));
    }
})(window.JellyfinEnhanced);
