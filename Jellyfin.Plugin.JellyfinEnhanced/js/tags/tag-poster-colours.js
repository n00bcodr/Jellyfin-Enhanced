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
// Every sample and every store write belongs to the session generation it
// started in: after a user switch, a decode still in flight is dropped, never
// shown or stored as the incoming user's.
//
// The work runs in idle slices: reads (which image, is it loaded) for a batch
// of cards, then the writes for cards whose colour is known; images still to
// sample are decoded off the main thread (createImageBitmap, resized while
// decoding) and their cards are queued for the next slice.
//
// Public surface: JE.tagPosterColours { ALGORITHM, dominant, normalise,
// coloursOf, keyOf, setActive, isActive, track, stats, clearMemory }.
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
    /** Colours kept in memory and in the persisted store. */
    const MEMORY_CAP = 3000;
    const STORE_CAP = 2000;
    /** The persisted copy is written this long after the last new colour. */
    const PERSIST_DELAY_MS = 2000;
    /** A failed sample (tainted canvas, decode error): the card keeps the Default colours. */
    const FAILED = 'failed';

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
     * @typedef {{url: string, img: HTMLImageElement|null, hosts: Set<HTMLElement>, gen: number, scope: string}} Job
     */
    /** @type {Map<string, Job>} samples waiting for a decode slot */
    const toSample = new Map();
    /** @type {Map<string, Job>} samples being decoded */
    const sampling = new Map();
    /** @type {Map<string, Map<string, number[]|null>>} new colours not yet persisted, per store scope */
    const unsaved = new Map();
    let persistTimer = 0;
    let primed = null;
    let primedScope = '';
    /** @type {WeakSet<Element>} artwork elements a listener or the observer already watches */
    const watched = new WeakSet();
    /** @type {WeakMap<Element, HTMLElement>} watched artwork → its host */
    const hostOfArt = new WeakMap();
    let observer = null;
    let canvas = null;
    const counters = { slices: 0, totalMs: 0, maxMs: 0, cards: 0, sampled: 0, failed: 0, fromMemory: 0, sampleMs: 0, maxSampleMs: 0 };

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
     * @returns {{key: string, url: string, img: HTMLImageElement|null, rgb?: number[]}|{wait: Element, img: HTMLImageElement|null}|null}
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
            return rgb.length === 3 && rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? { key: `declared:${rgb.join(',')}`, url: '', img: null, rgb } : null;
        }
        const img = /** @type {HTMLImageElement|null} */ (container.querySelector('img'));
        if (img) {
            const url = img.currentSrc || img.src;
            const key = keyOf(url);
            if (!key) return { wait: container, img: null };
            return img.complete && img.naturalWidth > 0 ? { key, url, img } : { wait: container, img };
        }
        const bg = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || '');
        const key = bg ? keyOf(bg[1]) : null;
        return key ? { key, url: bg[1], img: null } : { wait: container, img: null };
    }

    /**
     * Track a card again once its artwork arrives or changes: an <img>
     * finishing, a new src, the lazy loader setting a background image, or
     * Jellyfin 12 mounting (or replacing) the <img> inside the image
     * container after the tags arrived. The container's subtree is watched.
     * @param {Element} container - The image container.
     * @param {HTMLElement} host
     * @param {HTMLImageElement|null} img - An image still loading.
     */
    function waitFor(container, host, img) {
        hostOfArt.set(container, host);
        if (img && !watched.has(img)) {
            watched.add(img);
            img.addEventListener('load', () => {
                const owner = img.closest('.cardImageContainer') || img.parentElement;
                const h = owner ? hostOfArt.get(owner) : null;
                if (h) track(h);
            });
        }
        if (watched.has(container)) return;
        watched.add(container);
        if (!observer && typeof MutationObserver === 'function') {
            observer = new MutationObserver((records) => {
                const hosts = new Set();
                for (const record of records) {
                    // The watched container, or one whose subtree changed.
                    let el = /** @type {Element|null} */ (record.target);
                    while (el && !hostOfArt.has(el)) el = el.parentElement;
                    const h = el ? hostOfArt.get(el) : null;
                    if (h) hosts.add(h);
                }
                hosts.forEach(track);
            });
        }
        observer?.observe(container, { attributes: true, attributeFilter: ['style', 'src'], childList: true, subtree: true });
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

    /** Run a slice when the browser is idle (soon, at the latest). */
    function scheduleSlice() {
        if (sliceScheduled || !active) return;
        sliceScheduled = true;
        if (typeof requestIdleCallback === 'function') requestIdleCallback(runSlice, { timeout: 500 });
        else setTimeout(runSlice, 16);
    }

    /**
     * One idle slice: reads for a batch of queued cards, then the writes for
     * those whose colour is known; the rest are queued for sampling.
     */
    function runSlice() {
        sliceScheduled = false;
        if (!active) return;
        const started = performance.now();
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
            if ('wait' in art) { clear(target); waitFor(art.wait, host, art.img); continue; }
            if (art.rgb) { apply(target, art.key, { d: art.rgb }); continue; }
            const known = memory.get(art.key);
            if (known !== undefined) {
                counters.fromMemory++;
                if (target.dataset.jePosterKey !== art.key || !target.dataset.jePosterColour) apply(target, art.key, known);
                continue;
            }
            // New artwork: the previous item's colours never linger meanwhile.
            if (target.dataset.jePosterKey && target.dataset.jePosterKey !== art.key) clear(target);
            const job = toSample.get(art.key) || { url: art.url, img: art.img, hosts: new Set(), gen: generation, scope: scope() };
            job.hosts.add(host);
            if (!job.img && art.img) job.img = art.img;
            toSample.set(art.key, job);
        }
        const spent = performance.now() - started;
        counters.slices++;
        counters.cards += batch.length;
        counters.totalMs += spent;
        counters.maxMs = Math.max(counters.maxMs, spent);
        pumpSamples();
        if (queue.size) scheduleSlice();
    }

    /**
     * Start decodes while slots are free. A result arriving after a user
     * switch (another generation) is dropped: not remembered, not stored,
     * and no card is touched.
     */
    function pumpSamples() {
        for (const [key, job] of toSample) {
            if (sampling.size >= MAX_DECODES) return;
            toSample.delete(key);
            if (sampling.has(key)) continue;
            sampling.set(key, job);
            sample(job).then((d) => {
                if (job.gen !== generation) return;
                remember(key, d === FAILED ? FAILED : { d });
                if (d === FAILED) counters.failed++;
                else {
                    counters.sampled++;
                    if (!unsaved.has(job.scope)) unsaved.set(job.scope, new Map());
                    unsaved.get(job.scope).set(key, d);
                    persistSoon();
                }
            }).finally(() => {
                if (sampling.get(key) === job) sampling.delete(key);
                if (job.gen !== generation) return;
                for (const host of job.hosts) track(host);
                pumpSamples();
            });
        }
    }

    /**
     * Decode one artwork small and take its dominant colour. The image is
     * same-origin, so the canvas stays readable; anything that still fails
     * (a tainted canvas: SecurityError, a broken image: InvalidStateError)
     * gives FAILED and the card keeps the Default colours.
     * @param {{url: string, img: HTMLImageElement|null}} job
     * @returns {Promise<number[]|null|string>}
     */
    async function sample(job) {
        try {
            let source = job.img && job.img.complete && job.img.naturalWidth > 0 ? job.img : null;
            if (!source) {
                const image = new Image();
                image.decoding = 'async';
                image.src = job.url;
                await image.decode();
                source = image;
            }
            const width = source.naturalWidth, height = source.naturalHeight;
            if (!(width > 0 && height > 0)) return FAILED;
            const scale = Math.min(1, SAMPLE_SIZE / Math.max(width, height));
            const w = Math.max(1, Math.floor(width * scale + 0.5));
            const h = Math.max(1, Math.floor(height * scale + 0.5));
            let drawable = source;
            let bitmap = null;
            if (typeof createImageBitmap === 'function') {
                bitmap = await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
                drawable = bitmap;
            }
            // The synchronous part (draw, read back, histogram) runs on the main thread: timed.
            const started = performance.now();
            canvas = canvas || (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas'));
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return FAILED;
            ctx.clearRect(0, 0, w, h);
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawImage(drawable, 0, 0, w, h);
            bitmap?.close?.();
            const data = ctx.getImageData(0, 0, w, h).data;
            const result = dominant(data, w, h);
            const spent = performance.now() - started;
            counters.sampleMs += spent;
            counters.maxSampleMs = Math.max(counters.maxSampleMs, spent);
            return result;
        } catch (err) {
            if (err?.name !== 'SecurityError' && err?.name !== 'InvalidStateError' && err?.name !== 'EncodingError') {
                console.debug(`${logPrefix} could not sample artwork`, err);
            }
            return FAILED;
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
        toSample.clear();
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
        sampling.clear();
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
        /** @returns {Object} Slice timings and counts (performance checks). */
        stats: () => ({ ...counters, queued: queue.size, waiting: toSample.size, decoding: sampling.size, remembered: memory.size }),
        clearMemory,
    };
})(window.JellyfinEnhanced);
