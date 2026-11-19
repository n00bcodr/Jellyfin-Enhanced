import { blurRgba } from './blur';
import { fitImage, type Gradient } from './css-values';
import {
    ARTWORK_CAP, ARTWORK_PIXELS, BLUR_PX, MAX_DECODES, SLICE_BUDGET_MS, STEP_MIN_MS, backdropLog,
    type Artwork, type BackdropFns, type BackdropState, type Base, type Job, type Layer, type Spec, type Under,
} from './state';

/** Free a decoded bitmap (an ImageBitmap; read through its own close, for engines that lack the global). */
const closeBitmap = (entry: Artwork) => (entry.drawable as { close?: () => void }).close?.();

/** A rounded rectangle path (each corner's radius limited to the box): top left, top right, bottom right, bottom left. */
function roundedPath(ctx: CanvasRenderingContext2D, width: number, height: number, radii: number[]): void {
    const [r0 = 0, r1 = 0, r2 = 0, r3 = 0] = radii;
    const limit = Math.min(1, width / Math.max(1e-6, r0 + r1), width / Math.max(1e-6, r3 + r2), height / Math.max(1e-6, r0 + r3), height / Math.max(1e-6, r1 + r2));
    const [tl, tr, br, bl] = [r0 * limit, r1 * limit, r2 * limit, r3 * limit];
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

/** Paint a gradient over a box at its offset (dx, dy) in the canvas. */
function fillGradient(ctx: CanvasRenderingContext2D, under: Under, gradient: Gradient, dx: number, dy: number): void {
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
 * Drawing the pictures (idle slices), and showing them.
 * @param st - The painter's shared state.
 * @param fns - The painter's other functions.
 */
export function createDraw(st: BackdropState, fns: BackdropFns) {
    let sliceScheduled = false;
    let quietTimer: ReturnType<typeof setTimeout> | 0 = 0;
    /** The picture being drawn, and the one its parts are cut into. */
    let canvas: HTMLCanvasElement | null = null;
    let cutter: HTMLCanvasElement | null = null;

    /** Show a carrier's pictures: background layers above its own (CSS pixels in the carrier's padding box). */
    function write(carrier: HTMLElement, layers: Layer[], base: Base | null): void {
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
        st.applied.set(carrier, layers.length);
    }

    /** Take a carrier's pictures away. */
    function clear(carrier: HTMLElement): void {
        if (!st.applied.has(carrier)) return;
        st.applied.delete(carrier);
        for (const property of ['background-image', 'background-position', 'background-size', 'background-repeat']) carrier.style.removeProperty(property);
    }

    /** Run a slice when the browser is idle (soon, at the latest). */
    function scheduleSlice(): void {
        if (sliceScheduled || !st.active) return;
        // Pictures are painted once the page has been quiet. While cards with status tags are still arriving (a page
        // loading, a row filling in) the live filter shows them, and the decoding and the pixel work would only
        // compete with what the page is busy with.
        const wait = st.lastTracked + st.quietMs - performance.now();
        if (wait > 0) {
            if (!quietTimer) {
                quietTimer = setTimeout(() => {
                    quietTimer = 0;
                    scheduleSlice();
                }, wait);
            }
            return;
        }
        sliceScheduled = true;
        if (typeof requestIdleCallback === 'function') requestIdleCallback(runSlice, { timeout: 500 });
        else setTimeout(() => runSlice(), 16);
    }

    /** Whether a card still wants the pictures this job draws. */
    const wanted = (job: Job) => st.cards.get(job.card.host) === job.card && job.card.sig === job.sig && job.card.latest === job && job.card.host.isConnected;

    /**
     * One idle slice: the pixel steps of cards whose artwork is decoded while the idle period lasts (at least one when
     * the slice ran late), then decode launches into free slots.
     */
    function runSlice(deadline?: IdleDeadline): void {
        sliceScheduled = false;
        if (!st.active) return;
        const started = performance.now();
        const left = typeof deadline?.timeRemaining === 'function'
            ? () => deadline.timeRemaining()
            : () => SLICE_BUDGET_MS - (performance.now() - started);
        const late = !deadline || !!deadline.didTimeout;
        let steps = 0;
        while (st.ready.length && (left() >= STEP_MIN_MS || (late && steps === 0))) {
            const job = st.ready.shift();
            if (!job || !wanted(job)) continue;
            steps++;
            draw(job);
        }
        let launched = 0;
        while (st.waiting.length && (left() >= STEP_MIN_MS || (late && !steps && !launched))) {
            const job = st.waiting[0];
            if (!job || !wanted(job)) { st.waiting.shift(); continue; }
            if (st.artwork.has(job.key)) { st.waiting.shift(); st.ready.push(job); continue; }
            const flight = st.decoding.get(job.key);
            if (flight) { st.waiting.shift(); flight.jobs.add(job); continue; }
            if (st.decoding.size >= MAX_DECODES) break;
            st.waiting.shift();
            launched++;
            decode(job);
        }
        const spent = performance.now() - started;
        st.counters.slices++;
        st.counters.sliceMs += spent;
        st.counters.maxSliceMs = Math.max(st.counters.maxSliceMs, spent);
        if (st.ready.length || (st.waiting.length && st.decoding.size < MAX_DECODES)) scheduleSlice();
    }

    /**
     * Decode a card's artwork off the main thread: the card's own <img> when it has one, else the same URL in an image
     * of this part's (the browser already holds it), then an ImageBitmap of it. Without createImageBitmap the decoded
     * image itself is drawn.
     */
    function decode(job: Job): void {
        const key = job.key;
        const gen = st.generation;
        const flight = { jobs: new Set([job]) };
        st.decoding.set(key, flight);
        st.counters.decodes++;
        const settle = (entry: Artwork | null) => {
            const stale = st.decoding.get(key) !== flight || gen !== st.generation;
            if (st.decoding.get(key) === flight) st.decoding.delete(key);
            if (stale) {
                if (entry?.bitmap) closeBitmap(entry);
                return;
            }
            if (entry) {
                remember(key, entry);
                for (const j of flight.jobs) st.ready.push(j);
            } else {
                fns.markUnreadable(key);
                st.counters.failed++;
            }
            scheduleSlice();
        };
        (async (): Promise<Artwork | null> => {
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
                    if (err instanceof Error && err.name === 'SecurityError') return null;
                }
            }
            if (source === job.img && typeof source.decode === 'function') await source.decode();
            return { drawable: source, bitmap: false, width, height };
        })().then(settle, (err: unknown) => {
            const name = err instanceof Error ? err.name : '';
            if (name !== 'SecurityError' && name !== 'InvalidStateError' && name !== 'EncodingError') console.debug(`${backdropLog} could not decode artwork`, err);
            settle(null);
        });
    }

    /** Keep decoded artwork (the oldest goes first past the caps). */
    function remember(key: string, entry: Artwork): void {
        forget(key);
        st.artwork.set(key, entry);
        const pixels = () => { let sum = 0; for (const e of st.artwork.values()) sum += e.width * e.height; return sum; };
        while (st.artwork.size > 1 && (st.artwork.size > ARTWORK_CAP || pixels() > ARTWORK_PIXELS)) {
            const [oldest] = st.artwork.keys();
            if (oldest === undefined) break;
            forget(oldest);
        }
    }

    /** Drop decoded artwork and free its bitmap. */
    function forget(key: string): void {
        const entry = st.artwork.get(key);
        if (!entry) return;
        st.artwork.delete(key);
        if (entry.bitmap) closeBitmap(entry);
    }

    /**
     * One tag's picture: what is behind the tag, blurred, with the tag's corners cut; then each of its parts as an image.
     * @param placed - The image in its box.
     * @returns A PNG data URL for each piece, or null when the tag keeps the live filter.
     */
    function picture(job: Job, spec: Spec, art: Artwork, placed: { x: number; y: number; width: number; height: number }): string[] | null {
        const { width, height } = spec;
        canvas = canvas || document.createElement('canvas');
        const sheet = canvas;
        sheet.width = width;
        sheet.height = height;
        const ctx = sheet.getContext('2d', { willReadFrequently: true });
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
        const background = (under: Under) => {
            const dx = under.x - spec.x, dy = under.y - spec.y;
            if (under.colour) {
                ctx.fillStyle = under.colour;
                ctx.fillRect(dx, dy, under.width, under.height);
            }
            // The last layer is painted first.
            for (let i = under.gradients.length - 1; i >= 0; i--) {
                const gradient = under.gradients[i];
                if (gradient) fillGradient(ctx, under, gradient, dx, dy);
            }
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
            if (p.sx === 0 && p.sy === 0 && p.width === width && p.height === height) return sheet.toDataURL('image/png');
            cutter = cutter || document.createElement('canvas');
            cutter.width = p.width;
            cutter.height = p.height;
            const cut = cutter.getContext('2d');
            if (!cut) return '';
            cut.clearRect(0, 0, p.width, p.height);
            cut.drawImage(sheet, p.sx, p.sy, p.width, p.height, 0, 0, p.width, p.height);
            return cutter.toDataURL('image/png');
        });
    }

    /** Show a card's pictures: each tag's parts as layers of their carriers (`drawn`: each tag's pictures, in the job's order). */
    function show(job: Job, drawn: Array<string[] | null>): void {
        const layers = new Map<HTMLElement, Layer[]>();
        job.specs.forEach((spec, at) => {
            const urls = drawn[at];
            if (!urls) return;
            spec.pieces.forEach((p, i) => {
                const url = urls[i];
                if (!url) return;
                const list = layers.get(p.carrier) ?? [];
                list.push({ url, x: p.left, y: p.top, width: p.cssWidth, height: p.cssHeight });
                layers.set(p.carrier, list);
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
        fns.setBlur(card.host, !complete);
    }

    /** A card's pixel step (timed): draw each tag's picture and show them. The pictures are kept with the geometry they were drawn for. */
    function draw(job: Job): void {
        const art = st.artwork.get(job.key);
        if (!art) { st.waiting.push(job); return; }
        // Used again: the most recent artwork is kept longest.
        st.artwork.delete(job.key);
        st.artwork.set(job.key, art);
        const started = performance.now();
        /** Each tag's pictures (null: it keeps the live filter). */
        let drawn: Array<string[] | null> = [];
        try {
            const placed = fitImage(art.width, art.height, job.boxWidth, job.boxHeight, job.fit, job.scale);
            drawn = job.specs.map((spec) => {
                const urls = placed ? picture(job, spec, art, placed) : null;
                if (urls) st.counters.drawn++;
                else st.counters.plain++;
                return urls;
            });
        } catch (err) {
            // A canvas the browser will not let us read: this artwork keeps the live filter.
            drawn = [];
            fns.markUnreadable(job.key);
            // Artwork from another origin without CORS: every image from there would be decoded, drawn and refused.
            const name = err instanceof Error ? err.name : '';
            if (name === 'SecurityError') st.tainting.add(fns.originOf(job.key));
            forget(job.key);
            st.counters.failed++;
            if (name !== 'SecurityError') console.debug(`${backdropLog} could not draw a backdrop`, err);
        }
        job.card.kept = { job, drawn };
        show(job, drawn);
        const spent = performance.now() - started;
        st.counters.pixelMs += spent;
        st.counters.maxPixelMs = Math.max(st.counters.maxPixelMs, spent);
    }

    /** Drop every drawing in flight and all decoded artwork. */
    function dropWork(): void {
        st.generation++;
        st.waiting.length = 0;
        st.ready.length = 0;
        st.decoding.clear();
        for (const key of Array.from(st.artwork.keys())) forget(key);
    }

    return { write, clear, scheduleSlice, show, dropWork };
}
