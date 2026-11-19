import { boxSizes, blurRgba } from './blur';
import { fitImage, parseColour, parseGradient, placeLayer, snap, splitLayers, startsPixelGrid } from './css-values';
import { createDraw } from './draw';
import { createRead } from './read';
import {
    AGAIN_EVENTS, BLUR_PX, HOLD_MAX_MS, HOLD_MS, HOST_MARKS, LIVE_REST_MS, MAX_SCALE, MEASURE_BUDGET_MS, MEASURE_CARDS, PROBE_RGB,
    RESIZE_SETTLE_MS, UNREADABLE_CAP, backdropLog, createBackdropState, tagClass, type BackdropFns, type BackdropHost, type Card,
} from './state';

// The blurred backdrop of status tags (upstream abcaa16d, tags/status-tag-backdrop.js; statustags.ts draws the tags).
// A status tag is a 72% dark pill over the card's artwork, and the artwork behind it is blurred.
// `backdrop-filter: blur(6px)` gave that look at the price of a compositor layer for every tag, plus one for whatever
// painted over it. This part paints the same picture once instead: it samples the artwork under a tag, blurs it the way
// the browser's backdrop filter does (blur.ts), and shows the result under the tag as a plain background image of the
// tag's slot. The tag, its colour, border and shadow are untouched and keep compositing over the picture, so Tag Styles
// and custom CSS behave as before, and the picture fades with its slot and the host. Nothing here adds an element, a
// layer or a paint property, and nothing runs while the page scrolls.
//
// The backdrop is cut to the tag's border box, from its pixel-snapped corner and with its width and height rounded to
// whole pixels, and repeated mirrored beyond its edges; where that box reaches a pixel past the slot's own, that row or
// column is left out; the tag's rounded corners are cut into the picture's alpha. Pixels are snapped the way the page
// snaps them: from the corner of the nearest ancestor that starts a pixel grid of its own, and a picture is placed
// inside its carrier's unsnapped box, where the browser draws it pixel for pixel. What is behind a tag is rebuilt from
// what the page shows (read.ts): the card image placed by its object-fit / background-size over the image box's own
// opaque colour, then the plain colours and linear gradients the host, the slot and the group paint.
//
// The picture is a stand-in for the filter, used only where it is the same: a card's host carries `data-je-blur`,
// which gives its status tags the live `backdrop-filter` (statustags.ts), from the moment its badge is drawn until every
// tag on it has its picture, and again whenever the picture would not be what the filter shows: while the pointer is on
// the card with its tags on show, or focus is in it; until no new card with a status tag has come for a few seconds
// (QUIET_MS); when it cannot be drawn faithfully (artwork still loading, hidden, filtered or faded by CSS, a chip of an
// earlier slot under the tag, a tag reaching outside the image or itself translucent, transparency with nothing known
// behind it, a background this part cannot draw, a canvas the browser will not let it read); and where this part does
// not run at all (no readable canvas, a content security policy without data: images, the file not loaded). A
// filtered tag is a layer of its own, so the layout controller keeps such a card positioned (layout/flow.ts flowFor)
// and is told when the mark changes. A picture never shows artwork sharper than the page does.
//
// Lifecycle: a card is tracked when its badge is drawn, and released once it is gone from the page. In between it is
// watched (its chips, its size, its artwork); a change queues one measuring pass after the next paint, reads first,
// then writes, a few cards a pass, and only a card whose geometry really changed is drawn again, in idle slices
// (draw.ts). Pictures are data URLs in the carrier's inline style, so they go with the card; decoded artwork is kept
// for a few cards only.
//
// This tree: the page-level listeners (pointer and focus, the content security policy, the window's size) are added
// while the painter is active and removed by setActive(false), where upstream adds them once for the page.

/**
 * The painter: JE.statusTagBackdrop, a component group of its own (tag-status-backdrop) that statustags.ts asks the
 * loader for when the first status tag is drawn. A page that shows none never downloads it.
 * @param JE - The tag runtime's surface (status-tag-backdrop-entry.ts).
 */
export function createStatusTagBackdrop(JE: BackdropHost) {
    const st = createBackdropState();
    const fns = {} as BackdropFns;
    const { read } = createRead(st, fns);
    const drawing = createDraw(st, fns);
    let measureScheduled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | 0 = 0;
    let sizes: ResizeObserver | null = null;

    /** A canvas whose pixels can be read back, as they were drawn, and exported. */
    function isSupported(): boolean {
        if (st.supported !== null) return st.supported;
        try {
            const probe = document.createElement('canvas');
            probe.width = probe.height = 2;
            const ctx = probe.getContext('2d', { willReadFrequently: true });
            st.supported = false;
            if (ctx && typeof ctx.getImageData === 'function' && typeof probe.toDataURL === 'function') {
                // A canvas that answers with other pixels than were drawn (a browser resisting fingerprinting does,
                // without throwing) would put noise behind every tag.
                ctx.fillStyle = `rgb(${PROBE_RGB.join(', ')})`;
                ctx.fillRect(0, 0, 2, 2);
                const got = ctx.getImageData(0, 0, 1, 1).data;
                st.supported = PROBE_RGB.every((value, i) => Math.abs((got[i] ?? -1) - value) <= 1) && got[3] === 255
                    && probe.toDataURL('image/png').startsWith('data:image/png');
            }
        } catch {
            st.supported = false;
        }
        return st.supported;
    }

    /** Device pixels a CSS pixel the pictures are drawn at. */
    const pixelScale = () => Math.min(MAX_SCALE, Math.max(1, window.devicePixelRatio || 1));

    // ── Watching a card ────────────────────────────────────────────

    /** Measure a card after the next paint. */
    function markDirty(card: Card): void {
        if (!st.active) return;
        st.dirty.add(card);
        if (measureScheduled) return;
        measureScheduled = true;
        if (typeof JE.core?.dom?.afterNextPaint === 'function') JE.core.dom.afterNextPaint(measureDirty);
        else requestAnimationFrame(() => setTimeout(measureDirty, 0));
    }

    /** Watch a card's artwork: its image container (a new background image or src, an <img> mounted or replaced) and an image still loading. */
    function watchArtwork(card: Card, container: Element | null, img: HTMLImageElement | null): void {
        if (card.container !== container) {
            card.art?.disconnect();
            card.container = container;
            if (container) {
                // A bare image or list row holds the host too: its chips and the pictures are not artwork.
                if (!card.art) card.art = new MutationObserver((records) => {
                    if (!records.some((record) => !(record.target instanceof Element && record.target.closest('.je-tag-host')))) return;
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
     * Whether a change to a card's artwork leaves its pictures as they are: Jellyfin's lazy loader takes the background
     * image of a card scrolled out of view (`background-image: none`, its address parked in `data-src`) and puts the
     * same one back when the card returns, for every card of a row as the row scrolls. The pictures drawn for that
     * artwork are the ones to show when the card is seen again, so they stay where they are and nothing is measured or
     * written while the page scrolls. Other artwork, or none, is a change (no layout read).
     */
    function artworkParked(card: Card): boolean {
        const kept = card.kept;
        const container = card.container instanceof HTMLElement ? card.container : null;
        if (!kept || card.moved || kept.job.img || card.sig !== kept.job.sig || !container) return false;
        const shown = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || '');
        return (shown ? shown[1] : container.getAttribute('data-src') || '') === kept.job.url;
    }

    /** An address's origin ('' when it cannot be told). */
    function originOf(url: string): string {
        try { return new URL(url, document.baseURI).origin; } catch { return ''; }
    }

    /** Remember artwork as unreadable, forgetting the oldest past the cap. */
    function markUnreadable(url: string): void {
        st.unreadable.add(url);
        if (st.unreadable.size > UNREADABLE_CAP) {
            const [oldest] = st.unreadable;
            if (oldest !== undefined) st.unreadable.delete(oldest);
        }
    }

    /**
     * Read a card again once a passing state is over: a hover or focus that scales the card, dims its artwork or fades
     * its tag ends without changing anything this part watches. The card's own transitions ending, the pointer leaving
     * it and focus leaving it are the ends looked for; a card still in the state then waits on.
     * @param scaled - The state is a transform's scale.
     */
    function measureAgainLater(card: Card, scaled = false): void {
        if (card.again) return;
        const target = card.host.closest('.card, .listItem') || card.host.parentElement;
        if (!target || typeof target.addEventListener !== 'function') return;
        let timer: ReturnType<typeof setTimeout> | 0 = 0;
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
        // A scale may be an ancestor's, whose end the card never hears: look again anyway, at a growing interval for
        // as long as it lasts (a theme may scale its cards for good).
        if (scaled) {
            card.holdMs = Math.min(HOLD_MAX_MS, card.holdMs ? card.holdMs * 2 : HOLD_MS);
            timer = setTimeout(again, card.holdMs);
        }
    }

    /** A watched card changed size. */
    function onResize(entries: ResizeObserverEntry[]): void {
        for (const entry of entries) {
            const card = entry.target instanceof HTMLElement ? st.cards.get(entry.target) : undefined;
            if (!card) continue;
            card.moved = true;
            markDirty(card);
        }
    }

    /** Queue a card (its .je-tag-host) for its tags' backdrops and watch it from now on; called whenever a status badge is drawn. */
    function track(host: HTMLElement | null | undefined): void {
        if (!host) return;
        // Where no picture will be painted the tag keeps the live filter.
        if (!st.active || st.supported === false || typeof MutationObserver !== 'function') { setBlur(host, true); return; }
        let card = st.cards.get(host);
        if (!card) {
            const created: Card = { host, chips: null, art: null, container: null, img: null, onLoad: () => markDirty(created), sig: '', carriers: new Set(), kept: null, moved: true, on: [], latest: null, fullSig: '', again: null, live: false, resting: 0, holdMs: 0 };
            card = created;
            st.cards.set(host, card);
            st.lastTracked = performance.now();
            // Chips arriving, leaving, moving or being fitted all change the host's subtree. Reading the layout here,
            // in the middle of whatever changed it (a hover reveal, a fitting pass), would force it early, so a tag
            // that moved keeps its old picture's place for the frame it moves in.
            created.chips = new MutationObserver((records) => {
                if (records.every((record) => record.type === 'attributes' && record.target === host && HOST_MARKS.has(record.attributeName || ''))) return;
                // Before the paint that shows the change: a tag drawn afresh must not be bare meanwhile.
                dropStale(created);
                created.moved = true;
                markDirty(created);
            });
            created.chips.observe(host, { attributes: true, childList: true, subtree: true });
            if (typeof ResizeObserver === 'function') {
                if (!sizes) sizes = new ResizeObserver(onResize);
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
     * Pictures on a slot that left the card, or that no longer holds a status tag (the card was presented again, its
     * badge redrawn or removed), are not under any tag now: they go at once and the live filter stands in, until the
     * measuring pass shows the pictures the card kept on its new slot. Cheap: a card has one or two carriers.
     */
    function dropStale(card: Card): void {
        if (!card.carriers.size) return;
        let stale = false;
        for (const carrier of card.carriers) {
            if (!carrier.isConnected || !card.host.contains(carrier) || !carrier.querySelector(`.${tagClass}`)) { stale = true; break; }
        }
        if (!stale) return;
        for (const carrier of card.carriers) drawing.clear(carrier);
        card.carriers.clear();
        card.on = [];
        setBlur(card.host, true);
    }

    /** Take up again a card that was released while it was off the page and is back with the same nodes (the layout controller says so). */
    function resume(host: HTMLElement): void {
        if (!host || !st.detached.has(host) || !host.isConnected) return;
        st.detached.delete(host);
        if (!host.querySelector(`.${tagClass}`)) { delete host.dataset.jeBlur; return; }
        track(host);
        try { JE.core?.tagLayout?.syncFlowOf?.(host); } catch { /* the controller decides it when the card is next placed */ }
    }

    /**
     * Give a card's status tags the live backdrop filter, or take it away once their pictures stand in for it
     * (statustags.ts styles `.je-tag-host:not([data-je-blur]) .status-tag`). A filtered tag is a layer of its own, which
     * a card resting in flow must not hold, so the layout controller is told to decide the card's layout again.
     */
    function setBlur(host: HTMLElement, on: boolean): void {
        if ((host.dataset.jeBlur === '1') === on) return;
        if (on) host.dataset.jeBlur = '1';
        else delete host.dataset.jeBlur;
        try { JE.core?.tagLayout?.syncFlowOf?.(host); } catch (err) { console.debug(`${backdropLog} could not re-decide a card's layout`, err); }
    }

    /** Stop watching a card and take its pictures away: its tags keep the live filter from then on. */
    function release(host: HTMLElement): void {
        const card = host ? st.cards.get(host) : undefined;
        if (!card) return;
        card.chips?.disconnect();
        card.art?.disconnect();
        card.img?.removeEventListener('load', card.onLoad);
        sizes?.unobserve(host);
        card.again?.();
        if (card.resting) clearTimeout(card.resting);
        card.resting = 0;
        card.live = false;
        st.lingering.delete(card);
        for (const carrier of card.carriers) drawing.clear(carrier);
        card.carriers.clear();
        // Off the page (its view was dropped, or its row is being moved): should the same nodes come back, the tag has
        // the live filter, and resume() takes the card up again.
        if (host.isConnected) setBlur(host, true);
        else { host.dataset.jeBlur = '1'; st.detached.add(host); }
        card.sig = '';
        card.on = [];
        card.latest = null;
        st.cards.delete(host);
        st.dirty.delete(card);
    }

    // ── Measuring (reads, then writes) ─────────────────────────────

    /**
     * A measuring pass: read every card, then write. A card whose geometry is unchanged is left alone; a changed one
     * loses its pictures (they no longer fit) and is queued for drawing.
     */
    function measure(list: Card[]): void {
        const started = performance.now();
        const scale = pixelScale();
        const pass = { origins: new Map<Element, { x: number; y: number }>(), probed: false };
        // A card in use keeps the live filter: it is read when it rests (rest).
        const plans = list.filter((card) => card.host.isConnected && st.cards.get(card.host) === card && !card.live).map((card) => read(card, scale, pass));
        for (const { card, sig, job, hold } of plans) {
            if (hold) {
                // A scaled card cannot be read: the filter scales with it, whatever its tags do meanwhile.
                for (const carrier of card.carriers) drawing.clear(carrier);
                card.carriers.clear();
                card.on = [];
                setBlur(card.host, true);
                card.chips?.takeRecords();
                continue;
            }
            // The same geometry on the same elements: nothing to do. The same geometry on new elements (a card
            // presented again in place draws its slots afresh) needs its pictures put on them.
            const on = job ? job.specs.flatMap((spec) => spec.pieces.map((p) => p.carrier)) : [];
            if (sig === card.sig && on.length === card.on.length && on.every((carrier, i) => carrier === card.on[i])) continue;
            card.sig = sig;
            card.on = on;
            card.latest = job;
            // The geometry its pictures were drawn for is back (artwork that went and returned, slots drawn afresh):
            // they are shown again, not redrawn.
            if (job && card.kept?.job.sig === sig) {
                st.counters.reused++;
                const drawn = card.kept.drawn;
                card.kept = { job, drawn };
                drawing.show(job, drawn);
                continue;
            }
            for (const carrier of card.carriers) drawing.clear(carrier);
            card.carriers.clear();
            // No picture until the new one is drawn (or at all): the live filter stands in.
            setBlur(card.host, true);
            // The pictures taken away are not a change to measure.
            card.chips?.takeRecords();
            if (job && isSupported()) {
                st.waiting.push(job);
                drawing.scheduleSlice();
            }
        }
        // A browser that cannot do the pixel work: nothing is watched or measured for it again.
        if (st.supported === false) setActive(false);
        const spent = performance.now() - started;
        st.counters.measures++;
        st.counters.cards += plans.length;
        st.counters.measureMs += spent;
        st.counters.maxMeasureMs = Math.max(st.counters.maxMeasureMs, spent);
    }

    /**
     * The pass after a paint: the cards queued by then, a few at a time while the pass has time; the rest are measured
     * after the next paint, so a page full of new cards never holds the main thread for long. Cards gone from the page
     * (a row Jellyfin dropped, a recycled list) are released first: a badge drawn anywhere runs this pass, so none is
     * kept long.
     */
    function measureDirty(): void {
        measureScheduled = false;
        for (const host of Array.from(st.cards.keys())) if (!host.isConnected) release(host);
        if (!st.active) { st.dirty.clear(); return; }
        const started = performance.now();
        while (st.dirty.size && performance.now() - started < MEASURE_BUDGET_MS) {
            const batch = Array.from(st.dirty).slice(0, MEASURE_CARDS);
            for (const card of batch) st.dirty.delete(card);
            measure(batch);
        }
        const [next] = st.dirty;
        if (next) markDirty(next);
        st.counters.passes++;
        st.counters.maxPassMs = Math.max(st.counters.maxPassMs, performance.now() - started);
    }

    // ── A card in use ──────────────────────────────────────────────
    // A picture is the artwork under a resting tag. With the pointer on a card (where it does not hide the tags) or
    // focus inside it, Jellyfin draws its overlay between the artwork and the tags, and the backdrop filter blurred that
    // too. A card in use therefore gives its pictures up for the live filter, and takes them back once it rests.

    /** Whether the pointer hides this card's tags instead of leaving them on show ("Hide tags on hover", except the layouts with a hover reveal of their own). */
    function hidesOnHover(host: HTMLElement): boolean {
        if (!document.body?.classList.contains('je-tags-hide-on-hover')) return false;
        const layout = host.dataset.jeLayout;
        return layout !== 'summary' && layout !== 'minimal';
    }

    /** Whether focus is in its card, or the pointer is on it with its tags on show. */
    function inUse(card: Card): boolean {
        try {
            const el = card.host.closest('.card, .listItem');
            return !!el && (el.matches(':focus-within') || (!hidesOnHover(card.host) && el.matches(':hover')));
        } catch {
            return false;
        }
    }

    /** The pointer or focus arrived: the live filter, and no picture under it. */
    function use(card: Card): void {
        if (card.resting) clearTimeout(card.resting);
        card.resting = 0;
        st.lingering.delete(card);
        if (card.live) return;
        card.live = true;
        setBlur(card.host, true);
        for (const carrier of card.carriers) drawing.clear(carrier);
        card.carriers.clear();
        // Put back by the measuring pass once the card rests (the same geometry: shown again, not redrawn).
        card.on = [];
        card.chips?.takeRecords();
    }

    /**
     * A card the pointer or focus left: its pictures come back shortly, unless it is in use again by then. A card still
     * in use when the time comes is looked at again when the pointer shows up elsewhere (a touch leaves its card
     * hovered and sends no pointerout later).
     */
    function rest(card: Card): void {
        if (!card.live || card.resting) return;
        card.resting = setTimeout(() => {
            card.resting = 0;
            if (!card.live || st.cards.get(card.host) !== card) return;
            if (inUse(card)) {
                // Focus says when it leaves; a hover left behind by a touch does not.
                let over = false;
                try { over = !!card.host.closest('.card, .listItem')?.matches(':hover'); } catch { over = false; }
                if (over) st.lingering.add(card);
                return;
            }
            card.live = false;
            card.moved = true;
            markDirty(card);
        }, LIVE_REST_MS);
    }

    /** A pointerover or focusin anywhere on the page. */
    function onUse(event: Event): void {
        const target = event.target instanceof Element ? event.target : null;
        const pointer = event.type === 'pointerover';
        const el = target ? target.closest('.card, .listItem') : null;
        if (pointer) for (const card of Array.from(st.lingering)) if (!el || !el.contains(card.host)) { st.lingering.delete(card); rest(card); }
        const host = el ? el.querySelector<HTMLElement>('.je-tag-host') : null;
        const card = host ? st.cards.get(host) : undefined;
        if (!card || !host || (pointer && hidesOnHover(host))) return;
        use(card);
    }

    /** A pointerout or focusout anywhere on the page. */
    function onLeave(event: Event): void {
        const target = event.target instanceof Element ? event.target : null;
        const el = target ? target.closest('.card, .listItem') : null;
        const related = (event as Event & { relatedTarget?: EventTarget | null }).relatedTarget;
        const to = related instanceof Node ? related : null;
        if (!el || (to && el.contains(to))) return;
        const host = el.querySelector<HTMLElement>('.je-tag-host');
        const card = host ? st.cards.get(host) : undefined;
        if (card) rest(card);
    }

    // ── Switches ───────────────────────────────────────────────────

    /** Measure every watched card again (the pixel density changed). */
    function refresh(): void {
        for (const card of st.cards.values()) {
            card.moved = true;
            markDirty(card);
        }
    }

    /**
     * A content security policy without `data:` among its image sources refuses every picture after the work of drawing
     * it: the first refusal turns the pictures off for the page. (A report-only policy refuses nothing.)
     */
    function onRefused(event: Event): void {
        const violation = event as Partial<SecurityPolicyViolationEvent>;
        if (!st.active || (violation.disposition && violation.disposition !== 'enforce') || violation.blockedURI !== 'data'
            || !/^img-src/.test(violation.effectiveDirective || violation.violatedDirective || '')) return;
        console.warn(`${backdropLog} the page's content security policy refuses data: images; status tags keep the live backdrop filter.`);
        setActive(false);
    }

    /** Browser zoom or a move to another screen changes the pixel grid the pictures are cut for. */
    function onWindowResize(): void {
        if (!st.cards.size) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(refresh, RESIZE_SETTLE_MS);
    }

    /** Hear the page while the pictures are on (setActive). */
    function listen(on: boolean): void {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        const pointerOver = ['pointerover', onUse] as const, focusIn = ['focusin', onUse] as const;
        const pointerOut = ['pointerout', onLeave] as const, focusOut = ['focusout', onLeave] as const;
        if (on) {
            document.addEventListener(pointerOver[0], pointerOver[1], { passive: true });
            document.addEventListener(focusIn[0], focusIn[1]);
            document.addEventListener(pointerOut[0], pointerOut[1], { passive: true });
            document.addEventListener(focusOut[0], focusOut[1]);
            document.addEventListener('securitypolicyviolation', onRefused);
            window.addEventListener('resize', onWindowResize, { passive: true });
        } else {
            document.removeEventListener('pointerover', onUse);
            document.removeEventListener('focusin', onUse);
            document.removeEventListener('pointerout', onLeave);
            document.removeEventListener('focusout', onLeave);
            document.removeEventListener('securitypolicyviolation', onRefused);
            window.removeEventListener('resize', onWindowResize);
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = 0;
        }
    }

    /** Turn the backdrops on or off (off: every picture goes at once and every card is released; on: every card on the page is tracked). */
    function setActive(value: boolean): void {
        const on = !!value;
        if (on === st.active) return;
        st.active = on;
        listen(on);
        if (on) {
            document.querySelectorAll<HTMLElement>('.je-tag-host').forEach((host) => track(host));
            return;
        }
        for (const host of Array.from(st.cards.keys())) release(host);
        sizes?.disconnect();
        sizes = null;
        st.dirty.clear();
        drawing.dropWork();
    }

    Object.assign(fns, {
        markDirty, watchArtwork, measureAgainLater, originOf, markUnreadable, setBlur, isSupported, setActive,
        clear: drawing.clear, write: drawing.write, show: drawing.show, scheduleSlice: drawing.scheduleSlice,
    });
    listen(true);

    // A user switch: decoded artwork of the outgoing user is dropped (the incoming user's cards are drawn, and
    // tracked, again), and their pictures go at once, not when their cards are next measured.
    JE.session?.onUserChange?.('status-tag-backdrop', () => {
        drawing.dropWork();
        st.unreadable.clear();
        st.tainting.clear();
        for (const card of st.cards.values()) {
            for (const carrier of card.carriers) drawing.clear(carrier);
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

    return {
        BLUR_PX,
        track,
        release,
        resume,
        refresh,
        setActive,
        isActive: () => st.active,
        /** The quiet period before pictures are painted (ms); a performance check or a test may shorten it. */
        get quietMs() { return st.quietMs; },
        set quietMs(ms: number) { st.quietMs = Math.max(0, Number(ms) || 0); },
        /** Timings and counts (performance checks). */
        stats: () => ({ ...st.counters, watching: st.cards.size, waiting: st.waiting.length, ready: st.ready.length, decoding: st.decoding.size, artwork: st.artwork.size, unreadable: st.unreadable.size }),
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
}
export type StatusTagBackdrop = ReturnType<typeof createStatusTagBackdrop>;
