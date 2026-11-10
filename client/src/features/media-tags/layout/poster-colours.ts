/// <reference lib="es2021.weakref" />
import { logPrefix, ALGORITHM, SAMPLE_SIZE, MIN_ALPHA, NEAR_BLACK, NEAR_WHITE, GREY_CHROMA, MIN_SATURATION, MAX_SATURATION, MIN_LIGHTNESS, MAX_LIGHTNESS, BORDER_STEP, NEUTRAL, SLICE_CARDS, MAX_DECODES, STEP_MIN_MS, SLICE_BUDGET_MS, MEMORY_CAP, STORE_CAP, PERSIST_DELAY_MS, SWEEP_MS, FAILED, STALE, dominant, textContrast, hsl, normalise, coloursOf, css, keyOf } from './poster-colour-rules';
import type { RGB } from './poster-colour-rules';
interface Job {
    key: string;
    url: string;
    img: HTMLImageElement | null;
    hosts: Set<HTMLElement>;
    gen: number;
    scope: string;
}
interface Decoded {
    job: Job;
    drawable: ImageBitmap | HTMLImageElement;
    bitmap: boolean;
    w: number;
    h: number;
}
interface Launch {
    job: Job;
    source: HTMLImageElement;
    fallback: boolean;
}
type WatchRef = {
    deref(): Watch | undefined;
};
interface Watch {
    owner: Element;
    host: HTMLElement;
    container: Element | null;
    card: Element | null;
    id: string | null;
    key: string | null;
    img: HTMLImageElement | null;
    observer: MutationObserver | null;
    onLoad(): void;
    ref: WatchRef;
}
type ColourValue = {
    d: RGB | null;
} | typeof FAILED;
export interface PosterColourStore {
    available?(): boolean;
    getPosterColours?(scope: string, algorithm: number): Promise<Iterable<readonly [
        string,
        RGB | null
    ]>>;
    putPosterColours?(scope: string, algorithm: number, batch: Map<string, RGB | null>, cap: number): Promise<unknown>;
}
export interface PosterColourHost {
    scope(): string;
    store(): PosterColourStore | undefined;
    onUserChange(reset: () => void): void;
}
function errorName(error: unknown): unknown { return error && typeof error === 'object' && 'name' in error ? error.name : undefined; }
export function createPosterColours(host: PosterColourHost) {
    // ── Runtime ────────────────────────────────────────────────────────
    let active = false;
    let generation = 0;
    const memory: Map<string, ColourValue> = new Map();
    const queue: Set<HTMLElement> = new Set();
    let sliceScheduled = false;
    const toSample: Map<string, Job> = new Map();
    const sampling: Map<string, Job> = new Map();
    const ready: Decoded[] = [];
    const launches: Launch[] = [];
    const unsaved: Map<string, Map<string, RGB | null>> = new Map();
    let persistTimer = 0;
    let primed: Promise<void> | null = null;
    let primedScope = '';
    const watches: WeakMap<Element, Watch> = new WeakMap();
    const watchOf: WeakMap<HTMLElement, Watch> = new WeakMap();
    const live: Set<WatchRef> = new Set();
    const weakRef = (w: Watch) => (typeof WeakRef === 'function' ? new WeakRef(w) : { deref: () => w });
    let sweepTimer = 0;
    let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
    const counters = { slices: 0, totalMs: 0, maxMs: 0, cards: 0, sampled: 0, failed: 0, fromMemory: 0, sampleMs: 0, maxSampleMs: 0, steps: 0, fallback: 0, rechecks: 0 };
    const scope = host.scope;
    function prime() {
        const s = scope();
        if (primed && primedScope === s)
            return primed;
        primedScope = s;
        const store = host.store();
        const gen = generation;
        primed = (async () => {
            if (!s || !store?.available?.() || typeof store.getPosterColours !== 'function')
                return;
            try {
                const stored = await store.getPosterColours(s, ALGORITHM);
                if (gen !== generation || primedScope !== s)
                    return;
                for (const [key, d] of stored)
                    if (!memory.has(key))
                        memory.set(key, { d });
            }
            catch { /* the store marks itself unavailable */ }
        })();
        return primed;
    }
    function persistSoon() {
        if (persistTimer)
            return;
        const gen = generation;
        persistTimer = setTimeout(() => {
            persistTimer = 0;
            const batches = new Map(unsaved);
            unsaved.clear();
            const store = host.store();
            if (gen !== generation || !store?.available?.() || typeof store.putPosterColours !== 'function')
                return;
            const now = scope();
            for (const [s, batch] of batches) {
                if (!s || s !== now || !batch.size)
                    continue;
                store.putPosterColours(s, ALGORITHM, batch, STORE_CAP).catch(() => { });
            }
        }, PERSIST_DELAY_MS);
    }
    function remember(key: string, value: ColourValue) {
        memory.delete(key);
        memory.set(key, value);
        if (memory.size > MEMORY_CAP)
            memory.delete(memory.keys().next().value || '');
    }
    function targetOf(host: HTMLElement) {
        return (host.closest<HTMLElement>('.cardBox') || host.parentElement || host);
    }
    function artworkOf(host: HTMLElement) {
        const parent = host.parentElement;
        if (!parent)
            return null;
        const container = parent.classList.contains('cardScalable')
            ? parent.querySelector<HTMLElement>('.cardImageContainer, [data-je-poster-rgb]')
            : parent;
        if (!container)
            return null;
        const declared = container.getAttribute('data-je-poster-rgb') || container.querySelector(':scope > [data-je-poster-rgb]')?.getAttribute('data-je-poster-rgb');
        if (declared) {
            const rgb = declared.split(',').map((v) => Number(v.trim()));
            return rgb.length === 3 && rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? { key: `declared:${rgb.join(',')}`, url: '', img: null, container, rgb: [rgb[0] || 0, rgb[1] || 0, rgb[2] || 0] as RGB } : null;
        }
        const img = (container.querySelector('img'));
        if (img) {
            const url = img.currentSrc || img.src;
            const key = keyOf(url);
            if (!key)
                return { wait: container, img: null };
            return img.complete && img.naturalWidth > 0 ? { key, url, img, container } : { wait: container, img };
        }
        const bg = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || '');
        const url = bg?.[1] || '';
        const key = keyOf(url);
        return key ? { key, url, img: null, container } : { wait: container, img: null };
    }
    const idOf = (card: Element | null) => card?.getAttribute('data-id') || card?.getAttribute('data-itemid') || null;
    function watch(host: HTMLElement, container: Element, img: HTMLImageElement | null, key: string | null) {
        const owner = host.parentElement;
        if (!owner)
            return;
        let w = watches.get(owner);
        if (!w) {
            const created: Watch = ({ owner, host, container: null, card: null, id: null, key: null, img: null, observer: null, ref: { deref: () => undefined }, onLoad: () => changed(created) });
            w = created;
            w.ref = weakRef(w);
            watches.set(owner, w);
            live.add(w.ref);
            sweepSoon();
        }
        if (w.host !== host)
            watchOf.delete(w.host);
        w.host = host;
        watchOf.set(host, w);
        w.key = key;
        if (w.container !== container) {
            w.observer?.disconnect();
            w.container = container;
            w.card = owner.closest('[data-id], [data-itemid]');
            if (!w.observer && typeof MutationObserver === 'function')
                w.observer = new MutationObserver((records) => { if (records.some(artworkRecord) && w)
                    changed(w); });
            w.observer?.observe(container, { attributes: true, attributeFilter: ['style', 'src', 'srcset'], attributeOldValue: true, childList: true, subtree: true });
            if (w.card)
                w.observer?.observe(w.card, { attributes: true, attributeFilter: ['data-id', 'data-itemid'] });
        }
        w.id = idOf(w.card);
        if (w.img !== img) {
            w.img?.removeEventListener('load', w.onLoad);
            w.img = img;
            img?.addEventListener('load', w.onLoad);
        }
    }
    const backgroundOf = (style: string | null) => /url\(["']?([^"')]+)["']?\)/.exec(style || '')?.[1] || '';
    function artworkRecord(record: MutationRecord) {
        const target = record.target;
        if (!(target instanceof Element))
            return false;
        if (target.closest?.('.je-tag-host'))
            return false;
        if (record.type === 'childList') {
            const nodes = [...record.addedNodes, ...record.removedNodes];
            return nodes.some((n) => n instanceof Element && !n.classList.contains('je-tag-host'));
        }
        if (record.attributeName === 'style')
            return backgroundOf(record.oldValue) !== backgroundOf(target.getAttribute('style'));
        return true;
    }
    function changed(w: Watch) {
        if (watches.get(w.owner) !== w)
            return;
        counters.rechecks++;
        const host = w.owner.isConnected
            ? (w.host.parentElement === w.owner ? w.host : (Array.from(w.owner.children).find((c) => c.classList.contains('je-tag-host'))))
            : null;
        if (!(host instanceof HTMLElement)) {
            drop(w);
            return;
        }
        const art = artworkOf(host);
        const key = art && 'key' in art ? art.key : null;
        if (host !== w.host || key !== w.key || idOf(w.card) !== w.id)
            track(host);
    }
    function drop(w: Watch) {
        w.observer?.disconnect();
        w.observer = null;
        w.img?.removeEventListener('load', w.onLoad);
        w.img = null;
        if (watches.get(w.owner) === w)
            watches.delete(w.owner);
        if (watchOf.get(w.host) === w)
            watchOf.delete(w.host);
        live.delete(w.ref);
    }
    function sweepSoon() {
        if (sweepTimer || !live.size)
            return;
        sweepTimer = setTimeout(sweep, SWEEP_MS);
    }
    function sweep() {
        sweepTimer = 0;
        for (const ref of Array.from(live)) {
            const w = ref.deref();
            if (!w)
                live.delete(ref);
            else if (!w.owner.isConnected || w.host.parentElement !== w.owner)
                changed(w);
        }
        sweepSoon();
    }
    function release(host: HTMLElement) {
        const w = host ? watchOf.get(host) : null;
        if (w)
            drop(w);
    }
    function apply(target: HTMLElement, key: string, value: ColourValue | null) {
        if (!value || value === FAILED) {
            clear(target);
            return;
        }
        const c = normalise((value).d);
        target.style.setProperty('--je-tag-bg', css(c.background));
        target.style.setProperty('--je-tag-border', css(c.border));
        target.style.setProperty('--je-tag-fg', css(c.text));
        target.dataset.jePosterColour = '1';
        target.dataset.jePosterKey = key;
    }
    function clear(target: HTMLElement) {
        if (!target.dataset.jePosterColour && !target.dataset.jePosterKey)
            return;
        target.style.removeProperty('--je-tag-bg');
        target.style.removeProperty('--je-tag-border');
        target.style.removeProperty('--je-tag-fg');
        delete target.dataset.jePosterColour;
        delete target.dataset.jePosterKey;
    }
    function dropSamples() {
        toSample.clear();
        sampling.clear();
        launches.length = 0;
        for (const step of ready.splice(0))
            if (step.bitmap)
                ('close' in step.drawable ? step.drawable.close() : undefined);
    }
    function scheduleSlice() {
        if (sliceScheduled || !active)
            return;
        sliceScheduled = true;
        if (typeof requestIdleCallback === 'function')
            requestIdleCallback(runSlice, { timeout: 500 });
        else
            setTimeout(runSlice, 16);
    }
    function runSlice(deadline?: IdleDeadline) {
        sliceScheduled = false;
        if (!active)
            return;
        const started = performance.now();
        const left = typeof deadline?.timeRemaining === 'function'
            ? () => deadline.timeRemaining()
            : () => SLICE_BUDGET_MS - (performance.now() - started);
        const late = !deadline || !!deadline.didTimeout;
        let steps = 0;
        let drawings = 0;
        while (ready.length && (left() >= STEP_MIN_MS || (late && steps === 0))) {
            if (!ready[0]?.bitmap && drawings)
                break;
            const step = ready.shift();
            if (!step)
                break;
            if (!step.bitmap)
                drawings++;
            steps++;
            finish(step.job, pixels(step));
        }
        const batch = [];
        for (const host of queue) {
            queue.delete(host);
            if (host.isConnected)
                batch.push(host);
            if (batch.length >= SLICE_CARDS)
                break;
        }
        // Reads.
        const reads = batch.map((host) => ({ host, target: targetOf(host), art: artworkOf(host) }));
        // Writes.
        for (const { host, target, art } of reads) {
            if (!art) {
                clear(target);
                continue;
            }
            if ('wait' in art) {
                clear(target);
                watch(host, art.wait, art.img, null);
                continue;
            }
            if (art.rgb) {
                apply(target, art.key, { d: art.rgb });
                continue;
            }
            watch(host, art.container, null, art.key);
            const known = memory.get(art.key);
            if (known !== undefined) {
                counters.fromMemory++;
                if (target.dataset.jePosterKey !== art.key || !target.dataset.jePosterColour)
                    apply(target, art.key, known);
                continue;
            }
            // New artwork: the previous item's colours never linger meanwhile.
            if (target.dataset.jePosterKey && target.dataset.jePosterKey !== art.key)
                clear(target);
            // Already being decoded (another card with the same artwork): wait for that result.
            const running = sampling.get(art.key);
            if (running) {
                running.hosts.add(host);
                continue;
            }
            const job = toSample.get(art.key) || { key: art.key, url: art.url, img: art.img, hosts: new Set(), gen: generation, scope: scope() };
            job.hosts.add(host);
            if (!job.img && art.img)
                job.img = art.img;
            toSample.set(art.key, job);
        }
        // Decode launches while idle time lasts too (at least one when the slice ran late).
        let launched = 0;
        pumpSamples(() => (left() >= STEP_MIN_MS || (late && !launched)) && ++launched > 0);
        const spent = performance.now() - started;
        counters.slices++;
        counters.cards += batch.length;
        counters.steps += steps;
        counters.totalMs += spent;
        counters.maxMs = Math.max(counters.maxMs, spent);
        if (queue.size || ready.length || launches.length || (toSample.size && sampling.size < MAX_DECODES))
            scheduleSlice();
    }
    function pumpSamples(more: () => boolean) {
        while (launches.length) {
            if (!more())
                return;
            const next = launches.shift();
            if (!next)
                break;
            const { job, source, fallback } = next;
            launch(job, source, fallback);
        }
        for (const [key, job] of toSample) {
            if (sampling.size >= MAX_DECODES)
                return;
            const running = sampling.get(key);
            if (running) {
                toSample.delete(key);
                job.hosts.forEach((host) => running.hosts.add(host));
                continue;
            }
            if (!more())
                return;
            toSample.delete(key);
            // The card's image shows other artwork by now (recycled while the
            // job waited for a slot): never decode it under this key. The job
            // is dropped and its cards are read again.
            if (moved(job)) {
                job.hosts.forEach((host) => track(host));
                continue;
            }
            sampling.set(key, job);
            start(job);
        }
    }
    function start(job: Job) {
        if (job.img && job.img.complete && job.img.naturalWidth > 0) {
            launch(job, job.img, false);
            return;
        }
        const image = new Image();
        image.decoding = 'async';
        image.src = job.url;
        settle(job, attempt(() => image.decode()), () => launches.push({ job, source: image, fallback: false }));
    }
    function launch(job: Job, source: HTMLImageElement, fallback: boolean) {
        const width = source.naturalWidth, height = source.naturalHeight;
        if (!(width > 0 && height > 0)) {
            finish(job, FAILED);
            return;
        }
        const scale = Math.min(1, SAMPLE_SIZE / Math.max(width, height));
        const w = Math.max(1, Math.floor(width * scale + 0.5));
        const h = Math.max(1, Math.floor(height * scale + 0.5));
        if (!fallback && typeof createImageBitmap === 'function') {
            settle(job, attempt(() => createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })), (bitmap) => ready.push({ job, drawable: bitmap, bitmap: true, w, h }), (err) => {
                if (errorName(err) === 'SecurityError')
                    return false;
                // Drawn from the image instead.
                launches.push({ job, source, fallback: true });
                return true;
            });
            return;
        }
        // An image of the sampler's own was decoded by start().
        if (source !== job.img || typeof source.decode !== 'function') {
            ready.push({ job, drawable: source, bitmap: false, w, h });
            scheduleSlice();
            return;
        }
        settle(job, attempt(() => source.decode()), () => ready.push({ job, drawable: source, bitmap: false, w, h }));
    }
    function attempt<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return Promise.resolve(fn());
        }
        catch (err) {
            return Promise.reject(err);
        }
    }
    function settle<T extends void | ImageBitmap>(job: Job, promise: Promise<T>, done: (value: T) => void, retry?: (err: unknown) => boolean) {
        promise.then((value) => {
            if (!owns(job)) {
                value?.close?.();
                return;
            }
            done(value);
            scheduleSlice();
        }, (err) => {
            if (!owns(job))
                return;
            if (!retry?.(err))
                finish(job, failure(job, err));
            scheduleSlice();
        });
    }
    const owns = (job: Job) => sampling.get(job.key) === job && job.gen === generation;
    function finish(job: Job, d: RGB | null | typeof FAILED | typeof STALE) {
        if (!owns(job))
            return;
        sampling.delete(job.key);
        if (d !== STALE) {
            remember(job.key, d === FAILED ? FAILED : { d: (d) });
            if (d === FAILED)
                counters.failed++;
            else {
                counters.sampled++;
                if (!unsaved.has(job.scope))
                    unsaved.set(job.scope, new Map());
                unsaved.get(job.scope)?.set(job.key, (d));
                persistSoon();
            }
        }
        for (const host of job.hosts)
            track(host);
    }
    const moved = (job: Job) => !!job.img && keyOf(job.img.currentSrc || job.img.src) !== job.key;
    function failure(job: Job, err: unknown) {
        if (moved(job))
            return STALE;
        if (errorName(err) !== 'SecurityError' && errorName(err) !== 'InvalidStateError' && errorName(err) !== 'EncodingError') {
            console.debug(`${logPrefix} could not sample artwork`, err);
        }
        return FAILED;
    }
    function pixels(step: Decoded) {
        const { job, drawable, bitmap, w, h } = step;
        if (!bitmap && drawable === job.img && (moved(job) || !job.img.complete))
            return STALE;
        const started = performance.now();
        try {
            canvas = canvas || (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas'));
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx || !('clearRect' in ctx))
                return FAILED;
            ctx.clearRect(0, 0, w, h);
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawImage(drawable, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            return dominant(data, w, h);
        }
        catch (err) {
            return failure(job, err);
        }
        finally {
            if (bitmap)
                ('close' in drawable ? drawable.close() : undefined);
            else
                counters.fallback++;
            const spent = performance.now() - started;
            counters.sampleMs += spent;
            counters.maxSampleMs = Math.max(counters.maxSampleMs, spent);
        }
    }
    function track(host: HTMLElement) {
        if (!active || !host)
            return;
        queue.add(host);
        scheduleSlice();
    }
    function setActive(on: boolean) {
        on = !!on;
        if (on === active)
            return;
        active = on;
        if (on) {
            prime().then(() => {
                if (!active)
                    return;
                document.querySelectorAll<HTMLElement>('.je-tag-host').forEach((host) => queue.add((host)));
                scheduleSlice();
            });
            return;
        }
        queue.clear();
        dropSamples();
        for (const ref of Array.from(live)) {
            const w = ref.deref();
            if (w)
                drop(w);
        }
        live.clear();
        clearTimeout(sweepTimer);
        sweepTimer = 0;
        document.querySelectorAll<HTMLElement>('[data-je-poster-colour], [data-je-poster-key]').forEach((el) => clear((el)));
    }
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
    host.onUserChange(() => {
        generation++;
        setActive(false);
        dropSamples();
        clearMemory();
    });
    return {
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
        stats: () => ({ ...counters, queued: queue.size, waiting: toSample.size, decoding: sampling.size, remembered: memory.size, watching: live.size }),
        clearMemory,
    };
}
export type PosterColours = ReturnType<typeof createPosterColours>;
