// /js/tags/tag-poster-colours.js
// The Poster Tag Styles preset on the web: every tag's default colours come
// from the artwork of the card it sits on. The colour is taken from the image
// the browser already shows (never a blurhash placeholder), downscaled to at
// most 32px, with the same algorithm the server uses for native posters
// (Services/PosterTags/PosterColour.cs; tests/poster/parity compares them):
//
//   1. skip translucent, near-black (letterbox) and near-white pixels;
//   2. a 512-bin histogram (3 bits per channel), each bin scored by its count
//      times 256 + 2 × its centre's chroma; the dominant colour is the rounded
//      mean of the winning bin (ties: the lower bin);
//   3. grey (chroma < 24) → a neutral dark badge; otherwise saturation clamped
//      to 0.45–0.85 and lightness to 0.20–0.42, white text when it reaches
//      4.5:1, else black, and a border 0.16 lighter / darker.
//
// The colours land as CSS custom properties (--je-tag-bg, --je-tag-border,
// --je-tag-fg) and a data-je-poster-colour marker on the card's .cardBox (so
// the caption strip below the image shares them); tags/tag-styles.js keys its
// static Poster rules off them, under any colour the administrator set. A card
// whose artwork cannot be read (a tainted canvas, a decode error) keeps the
// Default preset's colours. Nothing leaves the browser: the colours are kept
// in memory and in the tag cache store (IndexedDB, per server and user,
// capped), keyed by item, image type and image tag, so new artwork resamples.
// Each coloured or waiting card has an artwork watch (its image container
// and its item id): new artwork or a card recycled for another item
// resamples it; the watch goes with the card, released by the layout or, for
// a card that just left the page, by a sweep every few seconds (whether or
// not anything is being sampled), and held weakly meanwhile.
// Every sample and every store write belongs to the session generation it
// started in: after a user switch, a decode still in flight is dropped, never
// shown or stored as the incoming user's.
//
// The work runs in idle slices: the pixel work of artwork already decoded
// (draw, read back, histogram) while the idle period lasts, then reads (which
// image, is it loaded) for a batch of cards and the writes for cards whose
// colour is known. Images still to sample are decoded off the main thread
// (createImageBitmap, resized while decoding; without it, the image's own
// decode()), and their pixel work waits for a slice: a full-size image drawn
// small without createImageBitmap takes a slice of its own.
//
// Public surface: JE.tagPosterColours { ALGORITHM, dominant, normalise,
// coloursOf, keyOf, setActive, isActive, track, release, stats, clearMemory }.
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Poster colours:';
    /** Bumped with the server's PosterColour.AlgorithmVersion; part of every persisted key. */
    const ALGORITHM = 1;
    const SAMPLE_SIZE = 32;
    const MIN_ALPHA = 128;
    const NEAR_BLACK = 28;
    const NEAR_WHITE = 235;
    const GREY_CHROMA = 24;
    const MIN_SATURATION = 0.45;
    const MAX_SATURATION = 0.85;
    const MIN_LIGHTNESS = 0.20;
    const MAX_LIGHTNESS = 0.42;
    const BORDER_STEP = 0.16;
    /** The neutral dark badge of a grey or blank poster. */
    const NEUTRAL = Object.freeze({ background: [40, 40, 40], border: [88, 88, 88], text: [255, 255, 255] });

    /** Cards handled per idle slice, and decodes in flight at once. */
    const SLICE_CARDS = 40;
    const MAX_DECODES = 4;
    /** A slice starts another pixel step only with this much idle time left (ms). */
    const STEP_MIN_MS = 4;
    /** A slice's budget without an idle deadline (no requestIdleCallback), in ms. */
    const SLICE_BUDGET_MS = 8;
    /** Colours kept in memory and in the persisted store. */
    const MEMORY_CAP = 3000;
    const STORE_CAP = 2000;
    /** The persisted copy is written this long after the last new colour. */
    const PERSIST_DELAY_MS = 2000;
    /** While any card is watched, watches of cards gone from the page are released this often (ms). */
    const SWEEP_MS = 3000;
    /** A failed sample (tainted canvas, decode error): the card keeps the Default colours. */
    const FAILED = 'failed';
    /** A card's image changed before it was drawn: nothing is remembered, its cards are read again. */
    const STALE = 'stale';

    // ── The algorithm (pure, shared with PosterColour.cs) ─────────────────

    /**
     * The dominant colour of RGBA pixels (unpremultiplied, row by row).
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @returns {number[]|null} [r, g, b], or null when every pixel was skipped.
     */
    function dominant(data, width, height) {
        const count = new Int32Array(512);
        const sumR = new Float64Array(512), sumG = new Float64Array(512), sumB = new Float64Array(512);
        const pixels = Math.min(width * height, Math.floor(data.length / 4));
        for (let i = 0; i < pixels; i++) {
            const o = i * 4;
            const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
            if (a < MIN_ALPHA) continue;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max < NEAR_BLACK || min > NEAR_WHITE) continue;
            const bin = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
            count[bin]++;
            sumR[bin] += r; sumG[bin] += g; sumB[bin] += b;
        }
        let best = -1;
        let bestScore = 0;
        for (let bin = 0; bin < 512; bin++) {
            if (count[bin] === 0) continue;
            const cr = ((bin >> 6) << 5) + 16, cg = (((bin >> 3) & 7) << 5) + 16, cb = ((bin & 7) << 5) + 16;
            const chroma = Math.max(cr, cg, cb) - Math.min(cr, cg, cb);
            const score = count[bin] * (256 + 2 * chroma);
            if (score > bestScore) { bestScore = score; best = bin; }
        }
        if (best < 0) return null;
        const n = count[best];
        const mean = (sum) => Math.floor((2 * sum + n) / (2 * n));
        return [mean(sumR[best]), mean(sumG[best]), mean(sumB[best])];
    }

    /**
     * WCAG 2 contrast of white (or black) text over an opaque colour.
     * @param {number[]} rgb
     * @param {boolean} white
     * @returns {number}
     */
    function textContrast(rgb, white) {
        const channel = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        const l = 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
        return white ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
    }

    /**
     * HSL (hue in sextants, 0 to 6) to RGB, rounded half up per channel.
     * @param {number} hue
     * @param {number} saturation
     * @param {number} lightness
     * @returns {number[]}
     */
    function hsl(hue, saturation, lightness) {
        const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
        const x = c * (1 - Math.abs((hue % 2) - 1));
        const m = lightness - c / 2;
        const sextant = Math.trunc(hue);
        const [r, g, b] = sextant === 0 ? [c, x, 0] : sextant === 1 ? [x, c, 0] : sextant === 2 ? [0, c, x]
            : sextant === 3 ? [0, x, c] : sextant === 4 ? [x, 0, c] : [c, 0, x];
        const round = (v) => Math.min(255, Math.max(0, Math.floor(v * 255 + 0.5)));
        return [round(r + m), round(g + m), round(b + m)];
    }

    /**
     * The tag colours for a dominant colour.
     * @param {number[]|null} rgb
     * @returns {{background: number[], border: number[], text: number[]}}
     */
    function normalise(rgb) {
        if (!rgb) return NEUTRAL;
        const [r, g, b] = rgb;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const chroma = max - min;
        if (chroma < GREY_CHROMA) return NEUTRAL;
        let hue = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
        if (hue < 0) hue += 6;
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const saturation = clamp(chroma / (255 - Math.abs(max + min - 255)), MIN_SATURATION, MAX_SATURATION);
        const lightness = clamp((max + min) / 510, MIN_LIGHTNESS, MAX_LIGHTNESS);
        const background = hsl(hue, saturation, lightness);
        const white = textContrast(background, true) >= 4.5;
        const border = hsl(hue, saturation, clamp(lightness + (white ? BORDER_STEP : -BORDER_STEP), 0, 1));
        return { background, border, text: white ? [255, 255, 255] : [0, 0, 0] };
    }

    /**
     * The tag colours of RGBA pixels.
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @returns {{background: number[], border: number[], text: number[]}}
     */
    function coloursOf(data, width, height) {
        return normalise(dominant(data, width, height));
    }

    /** @param {number[]} rgb @returns {string} */
    const css = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

    /**
     * A stable key for a Jellyfin artwork URL: item, image type, index and
     * image tag (a new image has a new tag), whatever size was requested.
     * @param {string} url
     * @returns {string|null}
     */
    function keyOf(url) {
        if (!url || /^(?:data|blob):/i.test(url)) return null;
        const m = /\/Items\/([0-9a-f-]{32,36})\/Images\/([A-Za-z]+)(?:\/(\d+))?/i.exec(url);
        if (!m) return url.split('#')[0];
        const tag = /[?&]tag=([^&#]+)/i.exec(url);
        return `${m[1].replace(/-/g, '').toLowerCase()}:${m[2].toLowerCase()}:${m[3] || 0}:${tag ? decodeURIComponent(tag[1]) : ''}`;
    }

    // ── Runtime ────────────────────────────────────────────────────────

    let active = false;
    /** Moves on at every user switch; work started under an older one is dropped. */
    let generation = 0;
    /** @type {Map<string, {d: number[]|null}|string>} key → dominant colour, or FAILED */
    const memory = new Map();
    /** @type {Set<HTMLElement>} hosts waiting for a slice */
    const queue = new Set();
    let sliceScheduled = false;
    /**
     * A sample: its artwork, the cards showing it, and the generation and
     * store scope it was started for.
     * @typedef {{key: string, url: string, img: HTMLImageElement|null, hosts: Set<HTMLElement>, gen: number, scope: string}} Job
     */
    /**
     * Decoded artwork waiting for its pixel step: a small bitmap, or (no
     * createImageBitmap) the full-size image to draw small.
     * @typedef {{job: Job, drawable: ImageBitmap|HTMLImageElement, bitmap: boolean, w: number, h: number}} Decoded
     */
    /** @type {Map<string, Job>} samples waiting for a decode slot */
    const toSample = new Map();
    /** @type {Map<string, Job>} samples being decoded or waiting for their pixel step */
    const sampling = new Map();
    /** @type {Decoded[]} */
    const ready = [];
    /** @type {Map<string, Map<string, number[]|null>>} new colours not yet persisted, per store scope */
    const unsaved = new Map();
    let persistTimer = 0;
    let primed = null;
    let primedScope = '';
    /**
     * A card's artwork watch: one observer on its image container (a new
     * src, srcset or background image, an <img> mounted or replaced) and on
     * the card's item id (a virtual list recycling the card), and a load
     * listener on an image still loading. `key` is the artwork last seen
     * ready (null while waiting), `id` the item id last seen.
     * @typedef {{owner: Element, host: HTMLElement, container: Element|null, card: Element|null, id: string|null, key: string|null,
     *   img: HTMLImageElement|null, observer: MutationObserver|null, onLoad: () => void, ref: {deref: () => Watch|undefined}}} Watch
     */
    /** @type {WeakMap<Element, Watch>} a host's parent (the card's render target) → its watch */
    const watches = new WeakMap();
    /** @type {WeakMap<HTMLElement, Watch>} host → its watch */
    const watchOf = new WeakMap();
    /** @type {Set<{deref: () => Watch|undefined}>} every watch, held weakly: a card gone from the page stays collectable */
    const live = new Set();
    /** @param {Watch} w @returns {{deref: () => Watch|undefined}} */
    const weakRef = (w) => (typeof WeakRef === 'function' ? new WeakRef(w) : { deref: () => w });
    let sweepTimer = 0;
    let canvas = null;
    const counters = { slices: 0, totalMs: 0, maxMs: 0, cards: 0, sampled: 0, failed: 0, fromMemory: 0, sampleMs: 0, maxSampleMs: 0, steps: 0, fallback: 0 };

    /** @returns {string} `${serverId}:${userId}`, the tag cache store's scope. */
    function scope() {
        const server = JE.session?.getServerId?.() || (typeof ApiClient !== 'undefined' && ApiClient.serverId?.()) || '';
        const user = JE.session?.getUserId?.() || (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || '';
        return server && user ? `${server}:${user}` : '';
    }

    /**
     * Load the persisted colours of this server and user into memory once.
     * Never rejects: without the store, colours live in memory only.
     * @returns {Promise<void>}
     */
    function prime() {
        const s = scope();
        if (primed && primedScope === s) return primed;
        primedScope = s;
        const store = JE.tagCacheStore;
        const gen = generation;
        primed = (async () => {
            if (!s || !store?.available?.() || typeof store.getPosterColours !== 'function') return;
            try {
                const stored = await store.getPosterColours(s, ALGORITHM);
                if (gen !== generation || primedScope !== s) return;
                for (const [key, d] of stored) if (!memory.has(key)) memory.set(key, { d });
            } catch { /* the store marks itself unavailable */ }
        })();
        return primed;
    }

    /**
     * Write the colours sampled since the last write (debounced), each under
     * the scope its sample started in, and only while that is still the
     * current scope of the generation that sampled it.
     */
    function persistSoon() {
        if (persistTimer) return;
        const gen = generation;
        persistTimer = setTimeout(() => {
            persistTimer = 0;
            const batches = new Map(unsaved);
            unsaved.clear();
            const store = JE.tagCacheStore;
            if (gen !== generation || !store?.available?.() || typeof store.putPosterColours !== 'function') return;
            const now = scope();
            for (const [s, batch] of batches) {
                if (!s || s !== now || !batch.size) continue;
                store.putPosterColours(s, ALGORITHM, batch, STORE_CAP).catch(() => { /* the store marks itself unavailable */ });
            }
        }, PERSIST_DELAY_MS);
    }

    /**
     * Remember a colour (oldest entries go first past the cap).
     * @param {string} key
     * @param {{d: number[]|null}|string} value
     */
    function remember(key, value) {
        memory.delete(key);
        memory.set(key, value);
        if (memory.size > MEMORY_CAP) memory.delete(memory.keys().next().value);
    }

    /**
     * Where a card's colours go: its .cardBox (shared by the image and the
     * caption strip), else the element the host sits in (a list row image).
     * @param {HTMLElement} host
     * @returns {HTMLElement}
     */
    function targetOf(host) {
        return /** @type {HTMLElement} */ (host.closest('.cardBox') || host.parentElement || host);
    }

    /**
     * The artwork a host sits on (reads only, no layout): the card image's
     * <img> once it has loaded (Jellyfin 12), the image container's
     * background-image once the lazy loader set it (10.11, legacy cards), or
     * an element declaring its colour (data-je-poster-rgb, the settings
     * panel's sample cards).
     * @param {HTMLElement} host
     * @returns {{key: string, url: string, img: HTMLImageElement|null, container: Element, rgb?: number[]}|{wait: Element, img: HTMLImageElement|null}|null}
     */
    function artworkOf(host) {
        const parent = host.parentElement;
        if (!parent) return null;
        const container = parent.classList.contains('cardScalable')
            ? parent.querySelector('.cardImageContainer, [data-je-poster-rgb]')
            : parent;
        if (!container) return null;
        const declared = container.getAttribute('data-je-poster-rgb') || container.querySelector(':scope > [data-je-poster-rgb]')?.getAttribute('data-je-poster-rgb');
        if (declared) {
            const rgb = declared.split(',').map((v) => Number(v.trim()));
            return rgb.length === 3 && rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? { key: `declared:${rgb.join(',')}`, url: '', img: null, container, rgb } : null;
        }
        const img = /** @type {HTMLImageElement|null} */ (container.querySelector('img'));
        if (img) {
            const url = img.currentSrc || img.src;
            const key = keyOf(url);
            if (!key) return { wait: container, img: null };
            return img.complete && img.naturalWidth > 0 ? { key, url, img, container } : { wait: container, img };
        }
        const bg = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || '');
        const key = bg ? keyOf(bg[1]) : null;
        return key ? { key, url: bg[1], img: null, container } : { wait: container, img: null };
    }

    /** @param {Element|null} card @returns {string|null} */
    const idOf = (card) => card?.getAttribute('data-id') || card?.getAttribute('data-itemid') || null;

    /**
     * Track a card again whenever its artwork arrives or changes: an <img>
     * finishing, a new src or srcset, the lazy loader setting a background
     * image, Jellyfin 12 mounting (or replacing) the <img> inside the image
     * container, or the card being recycled for another item. Called on
     * every slice that reads the card, so a recycled card's new host takes
     * the watch over.
     * @param {HTMLElement} host
     * @param {Element} container - The image container.
     * @param {HTMLImageElement|null} img - An image still loading.
     * @param {string|null} key - The artwork shown, null while waiting.
     */
    function watch(host, container, img, key) {
        const owner = host.parentElement;
        if (!owner) return;
        let w = watches.get(owner);
        if (!w) {
            const created = /** @type {Watch} */ ({ owner, host, container: null, card: null, id: null, key: null, img: null, observer: null, onLoad: () => changed(created) });
            w = created;
            w.ref = weakRef(w);
            watches.set(owner, w);
            live.add(w.ref);
            sweepSoon();
        }
        if (w.host !== host) watchOf.delete(w.host);
        w.host = host;
        watchOf.set(host, w);
        w.key = key;
        if (w.container !== container) {
            w.observer?.disconnect();
            w.container = container;
            w.card = owner.closest('[data-id], [data-itemid]');
            if (!w.observer && typeof MutationObserver === 'function') w.observer = new MutationObserver(() => changed(w));
            w.observer?.observe(container, { attributes: true, attributeFilter: ['style', 'src', 'srcset'], childList: true, subtree: true });
            if (w.card) w.observer?.observe(w.card, { attributes: true, attributeFilter: ['data-id', 'data-itemid'] });
        }
        w.id = idOf(w.card);
        if (w.img !== img) {
            w.img?.removeEventListener('load', w.onLoad);
            w.img = img;
            img?.addEventListener('load', w.onLoad);
        }
    }

    /**
     * A watched card's container or item id changed: track it again if its
     * artwork, its item or its host did (the observer also sees the card's
     * own colour writes and chips, which change none of these).
     * @param {Watch} w
     */
    function changed(w) {
        if (watches.get(w.owner) !== w) return;
        const host = w.owner.isConnected
            ? (w.host.parentElement === w.owner ? w.host : /** @type {HTMLElement|undefined} */ (Array.from(w.owner.children).find((c) => c.classList.contains('je-tag-host'))))
            : null;
        if (!host) { drop(w); return; }
        const art = artworkOf(host);
        const key = art && 'key' in art ? art.key : null;
        if (host !== w.host || key !== w.key || idOf(w.card) !== w.id) track(host);
    }

    /** @param {Watch} w Disconnect a card's watch. */
    function drop(w) {
        w.observer?.disconnect();
        w.observer = null;
        w.img?.removeEventListener('load', w.onLoad);
        w.img = null;
        if (watches.get(w.owner) === w) watches.delete(w.owner);
        if (watchOf.get(w.host) === w) watchOf.delete(w.host);
        live.delete(w.ref);
    }

    /** Sweep the watches in a few seconds, while there are any. */
    function sweepSoon() {
        if (sweepTimer || !live.size) return;
        sweepTimer = setTimeout(sweep, SWEEP_MS);
    }

    /**
     * Release the watches of cards gone from the page (or whose host was
     * removed: a replacement host takes the watch over), on a timer of its
     * own: a page whose sampling has settled runs no slice, and Jellyfin
     * can drop a whole row without the layout seeing it.
     */
    function sweep() {
        sweepTimer = 0;
        for (const ref of Array.from(live)) {
            const w = ref.deref();
            if (!w) live.delete(ref);
            else if (!w.owner.isConnected || w.host.parentElement !== w.owner) changed(w);
        }
        sweepSoon();
    }

    /**
     * Stop watching a card's artwork; core/tag-layout.js calls this when it
     * drops the card's controller. Presenting the card again re-watches it.
     * @param {HTMLElement} host
     */
    function release(host) {
        const w = host ? watchOf.get(host) : null;
        if (w) drop(w);
    }

    /**
     * Write a card's colours (or clear them back to the Default preset's).
     * @param {HTMLElement} target
     * @param {string} key
     * @param {{d: number[]|null}|string|null} value
     */
    function apply(target, key, value) {
        if (!value || value === FAILED) {
            clear(target);
            return;
        }
        const c = normalise(/** @type {{d: number[]|null}} */ (value).d);
        target.style.setProperty('--je-tag-bg', css(c.background));
        target.style.setProperty('--je-tag-border', css(c.border));
        target.style.setProperty('--je-tag-fg', css(c.text));
        target.dataset.jePosterColour = '1';
        target.dataset.jePosterKey = key;
    }

    /** @param {HTMLElement} target Remove a card's colours. */
    function clear(target) {
        if (!target.dataset.jePosterColour && !target.dataset.jePosterKey) return;
        target.style.removeProperty('--je-tag-bg');
        target.style.removeProperty('--je-tag-border');
        target.style.removeProperty('--je-tag-fg');
        delete target.dataset.jePosterColour;
        delete target.dataset.jePosterKey;
    }

    /** Drop every sample in flight or waiting for its pixel step; their late results are ignored. */
    function dropSamples() {
        toSample.clear();
        sampling.clear();
        for (const step of ready.splice(0)) if (step.bitmap) /** @type {ImageBitmap} */ (step.drawable).close?.();
    }

    /** Run a slice when the browser is idle (soon, at the latest). */
    function scheduleSlice() {
        if (sliceScheduled || !active) return;
        sliceScheduled = true;
        if (typeof requestIdleCallback === 'function') requestIdleCallback(runSlice, { timeout: 500 });
        else setTimeout(runSlice, 16);
    }

    /**
     * One idle slice: pixel steps for decoded artwork while the idle period
     * lasts (at least one when the slice ran late, at most one full-size
     * drawing), then reads for a batch of queued cards and the writes for
     * those whose colour is known; the rest are queued for sampling, and
     * free decode slots are filled. Every part is timed in the slice
     * counters.
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
        let drawings = 0;
        while (ready.length && (left() >= STEP_MIN_MS || (late && steps === 0))) {
            if (!ready[0].bitmap && drawings) break;
            const step = /** @type {Decoded} */ (ready.shift());
            if (!step.bitmap) drawings++;
            steps++;
            finish(step.job, pixels(step));
        }
        const batch = [];
        for (const host of queue) {
            queue.delete(host);
            if (host.isConnected) batch.push(host);
            if (batch.length >= SLICE_CARDS) break;
        }
        // Reads.
        const reads = batch.map((host) => ({ host, target: targetOf(host), art: artworkOf(host) }));
        // Writes.
        for (const { host, target, art } of reads) {
            if (!art) { clear(target); continue; }
            if ('wait' in art) { clear(target); watch(host, art.wait, art.img, null); continue; }
            if (art.rgb) { apply(target, art.key, { d: art.rgb }); continue; }
            watch(host, art.container, null, art.key);
            const known = memory.get(art.key);
            if (known !== undefined) {
                counters.fromMemory++;
                if (target.dataset.jePosterKey !== art.key || !target.dataset.jePosterColour) apply(target, art.key, known);
                continue;
            }
            // New artwork: the previous item's colours never linger meanwhile.
            if (target.dataset.jePosterKey && target.dataset.jePosterKey !== art.key) clear(target);
            // Already being decoded (another card with the same artwork): wait for that result.
            const running = sampling.get(art.key);
            if (running) { running.hosts.add(host); continue; }
            const job = toSample.get(art.key) || { key: art.key, url: art.url, img: art.img, hosts: new Set(), gen: generation, scope: scope() };
            job.hosts.add(host);
            if (!job.img && art.img) job.img = art.img;
            toSample.set(art.key, job);
        }
        // Decodes start while idle time lasts too (at least one when the slice ran late).
        let launched = 0;
        pumpSamples(() => (left() >= STEP_MIN_MS || (late && !launched)) && ++launched > 0);
        const spent = performance.now() - started;
        counters.slices++;
        counters.cards += batch.length;
        counters.steps += steps;
        counters.totalMs += spent;
        counters.maxMs = Math.max(counters.maxMs, spent);
        if (queue.size || ready.length || (toSample.size && sampling.size < MAX_DECODES)) scheduleSlice();
    }

    /**
     * Start decodes while slots are free (a decoded artwork holds its slot
     * until its pixel step ran); cards showing an artwork already being
     * decoded join that decode, and its result goes to every one of them.
     * Nothing here runs pixel work: a decode, even one that settles at once,
     * only queues its step for a slice.
     * @param {() => boolean} more - Whether the slice has time for another decode to start.
     */
    function pumpSamples(more) {
        for (const [key, job] of toSample) {
            if (sampling.size >= MAX_DECODES) return;
            const running = sampling.get(key);
            if (running) {
                toSample.delete(key);
                job.hosts.forEach((host) => running.hosts.add(host));
                continue;
            }
            if (!more()) return;
            toSample.delete(key);
            sampling.set(key, job);
            decode(job).then((decoded) => {
                if (sampling.get(key) !== job || job.gen !== generation) {
                    if (decoded?.bitmap) /** @type {ImageBitmap} */ (decoded.drawable).close?.();
                    return;
                }
                if (!decoded) finish(job, FAILED);
                else ready.push(decoded);
                scheduleSlice();
            }, (err) => {
                finish(job, failure(job, err));
                scheduleSlice();
            });
        }
    }

    /**
     * A sample is done: remember its colour (or failure) and read its cards
     * again. A result arriving after a user switch (another generation) is
     * dropped: not remembered, not stored, and no card is touched.
     * @param {Job} job
     * @param {number[]|null|string} d - The dominant colour, FAILED or STALE.
     */
    function finish(job, d) {
        if (sampling.get(job.key) === job) sampling.delete(job.key);
        if (job.gen !== generation) return;
        if (d !== STALE) {
            remember(job.key, d === FAILED ? FAILED : { d: /** @type {number[]|null} */ (d) });
            if (d === FAILED) counters.failed++;
            else {
                counters.sampled++;
                if (!unsaved.has(job.scope)) unsaved.set(job.scope, new Map());
                /** @type {Map<string, number[]|null>} */ (unsaved.get(job.scope)).set(job.key, /** @type {number[]|null} */ (d));
                persistSoon();
            }
        }
        for (const host of job.hosts) track(host);
    }

    /** @param {Job} job @returns {boolean} The card's own image shows other artwork by now. */
    const moved = (job) => !!job.img && keyOf(job.img.currentSrc || job.img.src) !== job.key;

    /**
     * Why a sample failed: FAILED (the card keeps the Default colours; a
     * tainted canvas: SecurityError, a broken image: InvalidStateError or
     * EncodingError), or STALE when the card's image changed meanwhile.
     * @param {Job} job
     * @param {*} err
     * @returns {string}
     */
    function failure(job, err) {
        if (moved(job)) return STALE;
        if (err?.name !== 'SecurityError' && err?.name !== 'InvalidStateError' && err?.name !== 'EncodingError') {
            console.debug(`${logPrefix} could not sample artwork`, err);
        }
        return FAILED;
    }

    /**
     * Decode one artwork, off the main thread: small, with createImageBitmap
     * (resized while decoding); else (or when it rejects) the image itself,
     * decoded before a slice draws it. The image is same-origin, so the
     * canvas stays readable.
     * @param {Job} job
     * @returns {Promise<Decoded|null>} Null for an image without pixels.
     */
    async function decode(job) {
        let source = job.img && job.img.complete && job.img.naturalWidth > 0 ? job.img : null;
        if (!source) {
            const image = new Image();
            image.decoding = 'async';
            image.src = job.url;
            await image.decode();
            source = image;
        }
        const width = source.naturalWidth, height = source.naturalHeight;
        if (!(width > 0 && height > 0)) return null;
        const scale = Math.min(1, SAMPLE_SIZE / Math.max(width, height));
        const w = Math.max(1, Math.floor(width * scale + 0.5));
        const h = Math.max(1, Math.floor(height * scale + 0.5));
        if (typeof createImageBitmap === 'function') {
            try {
                return { job, drawable: await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }), bitmap: true, w, h };
            } catch (err) {
                if (err?.name === 'SecurityError') throw err;
                // Drawn from the image instead.
            }
        }
        if (typeof source.decode === 'function') await source.decode();
        return { job, drawable: source, bitmap: false, w, h };
    }

    /**
     * The pixel step of a decoded artwork, on the main thread (timed): draw
     * it small, read it back, take its dominant colour.
     * @param {Decoded} step
     * @returns {number[]|null|string} The dominant colour, FAILED or STALE.
     */
    function pixels(step) {
        const { job, drawable, bitmap, w, h } = step;
        if (!bitmap && drawable === job.img && (moved(job) || !job.img.complete)) return STALE;
        const started = performance.now();
        try {
            canvas = canvas || (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas'));
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return FAILED;
            ctx.clearRect(0, 0, w, h);
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawImage(drawable, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            return dominant(data, w, h);
        } catch (err) {
            return failure(job, err);
        } finally {
            if (bitmap) /** @type {ImageBitmap} */ (drawable).close?.();
            else counters.fallback++;
            const spent = performance.now() - started;
            counters.sampleMs += spent;
            counters.maxSampleMs = Math.max(counters.maxSampleMs, spent);
        }
    }

    /**
     * Queue a card (its .je-tag-host) for colouring; core/tag-layout.js
     * calls this whenever it presents a card. Nothing happens unless the
     * Poster preset is active.
     * @param {HTMLElement} host
     */
    function track(host) {
        if (!active || !host) return;
        queue.add(host);
        scheduleSlice();
    }

    /**
     * Turn the Poster colours on (every card on the page is queued) or off
     * (every card loses them at once). tags/tag-styles.js drives this from
     * the effective preset.
     * @param {boolean} on
     */
    function setActive(on) {
        on = !!on;
        if (on === active) return;
        active = on;
        if (on) {
            prime().then(() => {
                if (!active) return;
                document.querySelectorAll('.je-tag-host').forEach((host) => queue.add(/** @type {HTMLElement} */ (host)));
                scheduleSlice();
            });
            return;
        }
        queue.clear();
        dropSamples();
        for (const ref of Array.from(live)) {
            const w = ref.deref();
            if (w) drop(w);
        }
        live.clear();
        clearTimeout(sweepTimer);
        sweepTimer = 0;
        document.querySelectorAll('[data-je-poster-colour], [data-je-poster-key]').forEach((el) => clear(/** @type {HTMLElement} */ (el)));
    }

    /** Forget the colours in memory (a user switch: another user's store scope). */
    function clearMemory() {
        memory.clear();
        unsaved.clear();
        clearTimeout(persistTimer);
        persistTimer = 0;
        primed = null;
        primedScope = '';
    }

    // A user switch: a new generation, so samples and store writes still out
    // for the outgoing user are dropped when they finish.
    JE.session?.onUserChange?.('tag-poster-colours', () => {
        generation++;
        setActive(false);
        dropSamples();
        clearMemory();
    });

    JE.tagPosterColours = {
        ALGORITHM,
        NEUTRAL,
        dominant,
        normalise,
        coloursOf,
        keyOf,
        css,
        setActive,
        isActive: () => active,
        track,
        release,
        /** @returns {Object} Slice timings and counts (performance checks). */
        stats: () => ({ ...counters, queued: queue.size, waiting: toSample.size, decoding: sampling.size, remembered: memory.size, watching: live.size }),
        clearMemory,
    };
})(window.JellyfinEnhanced);
