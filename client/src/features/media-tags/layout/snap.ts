import type { CardController, LayoutHost } from './layout-runtime-types';
import { createGridReader, snapUnits } from './snap-grid';
import type { LayoutFns, LayoutState } from './state';

// ── Whole pixels (upstream abcaa16d) ───────────────────────────────────
// Chromium paints a box that has layout and style containment from a whole pixel: the box's corner is rounded to one,
// and everything inside is placed from there. Seven group containers had that containment, at the price of a paint
// property node for each on every card. Without it a container whose corner falls between two pixels paints its chips
// a fraction of a pixel off, which shows in their edges and in the anti-aliasing of their text. So each of those
// containers is moved by that fraction instead (--je-snap-x and --je-snap-y, a pair of margins that cancel:
// tag-layout-styles.ts): its corner then lies on the pixel the contained box was painted from, and the card paints
// the same pixels with no containment, layer or stacking context added.
//
// A card is measured once its tags have been drawn and the page has come to rest, in the idle pass that settles
// resting layouts (flow-idle.ts): one pass for every card queued (reads, then writes). It is measured again only when
// its size changes (the size observer that refits cards), an image in its tags loads or a font arrives: no layout is
// read while a page loads, scrolls or the pointer moves. A card the fitting pass is about to measure is un-nudged
// first, so that pass reads the layout as it is without the nudge.
//
// Firefox and WebKit paint a contained box where they paint a plain one (measured: nothing differs between them), so
// nothing is nudged there.

/** The groups whose containers had layout and style containment. */
const SNAPPED_GROUPS = new Set(['genre', 'quality', 'language', 'rating', 'ageRating', 'status', 'logos']);
/** A card whose size is changing is measured once it has kept a size for this long (ms). */
const SNAP_SETTLE_MS = 120;
/** What ends a state a card cannot be measured in (snapLater). */
const SNAP_AGAIN_EVENTS = ['pointerleave', 'focusout', 'transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
/** The written values and the custom properties that carry them. */
const SNAP_PROPERTIES: Array<['vx' | 'vy' | 'left', string]> = [['vx', '--je-snap-x'], ['vy', '--je-snap-y'], ['left', '--je-band-left']];
/**
 * A box this far (CSS px) from the size the observer reported for it is scaled. A report and a measured box differ by
 * a layout unit at most (a 64th of a pixel), and by two for a card hundreds of thousands of pixels down the page, where
 * a measured box is that coarse.
 */
const SCALED_PX = 0.05;

/** A container's nudge as worked out by measureSnap, in CSS px; `band`: the top band it stands in. */
export interface SnapPlan { node: HTMLElement; x: number; y: number; vx: number; left: number; band: Element | null }
/** An item of a slot as measureSnap read it: where it would be without its nudge, and the nudge it needs. */
export interface SnapItem { node: HTMLElement; rect: DOMRect; ux: number; uy: number; dx: number; dy: number; group: boolean }
interface Nudge { x: number; y: number; vx: string; vy: string; left: string }

/**
 * The whole-pixel pass.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createSnap(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    void JE;
    /** Container → how far it is moved (CSS px) and the values written. */
    const nudges = new WeakMap<HTMLElement, Nudge>();
    let snapSettle: ReturnType<typeof setTimeout> | 0 = 0;
    let snapSupport: boolean | null = null;
    let scaleObserver: ResizeObserver | null = null;
    /** Hosts waiting for a state they cannot be measured in to end. */
    const snapWaiting = new WeakSet<HTMLElement>();
    const grid = createGridReader(() => s.flowEpoch);
    const unitsToPx = (units: number) => units / 64 / s.layoutScale;

    /**
     * Whether containers are nudged here: an engine that paints a contained box from a whole pixel (Chromium's
     * family) and can say which grid it snaps to (`devicePixelContentBoxSize`, Chromium 84).
     */
    function snapSupported(): boolean {
        if (snapSupport === null) {
            snapSupport = false;
            try {
                snapSupport = navigator.vendor === 'Google Inc.' && typeof ResizeObserver === 'function'
                    && typeof ResizeObserverEntry === 'function' && 'devicePixelContentBoxSize' in ResizeObserverEntry.prototype;
            } catch { snapSupport = false; }
            // Registered so that they are not inherited: writing one on a container restyles the container, not every
            // chip inside it. As any value ('*'), not as a length: a registered length is kept to six decimals, which
            // is coarser than a layout unit on a dense screen. (The loader registers them as the page starts, when
            // that restyles nothing: registering one restyles every element of the page. This is for a page that came
            // by another loader.)
            if (snapSupport) {
                for (const [, name] of SNAP_PROPERTIES) {
                    try { CSS.registerProperty({ name, syntax: '*', inherits: false }); } catch { /* registered already, or not registrable: it is inherited then, which draws the same */ }
                }
            }
        }
        return snapSupport && deps.api.wholePixels;
    }

    /**
     * Learn the grid the browser snaps boxes to, and hear when it changes (browser zoom, a window moved to another
     * screen). It is the device pixel ratio, except under an emulated one (the developer tools' device mode): boxes
     * still snap in CSS pixels there, which the root's size in device pixels shows.
     */
    function watchScale(): void {
        if (scaleObserver || typeof ResizeObserver !== 'function') return;
        try {
            scaleObserver = new ResizeObserver((entries) => {
                const entry = entries[entries.length - 1];
                const css = entry?.contentBoxSize?.[0]?.inlineSize ?? 0;
                const device = entry?.devicePixelContentBoxSize?.[0]?.inlineSize ?? 0;
                if (!(css > 0 && device > 0)) return;
                const ratio = window.devicePixelRatio || 1;
                // The same within a pixel over the root's width: the ratio is real.
                const scale = Math.abs(device - css * ratio) <= 1 ? ratio : Math.round(device / css * 100) / 100;
                if (scale === s.layoutScale) return;
                const first = !s.layoutScale;
                s.layoutScale = scale;
                // Another grid: every card's containers land elsewhere on it.
                if (!first) for (const el of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
                    const ctrl = s.controllers.get(el);
                    if (ctrl && ctrl.layout) s.pendingSnap.add(ctrl);
                }
                if (s.pendingSnap.size) deps.queueIdle();
            });
            scaleObserver.observe(document.documentElement, { box: 'device-pixel-content-box' });
            deps.watchFonts();
        } catch {
            scaleObserver = null;
            snapSupport = false;
        }
    }

    /**
     * Whether cards can be measured now: whole pixels are done here, and the browser has said which grid it snaps to.
     * (Where they are not done nothing waits; while the grid is not known the cards wait, and the pass runs when the
     * browser has said.)
     */
    function snapReady(): boolean {
        if (!snapSupported()) { s.pendingSnap.clear(); return false; }
        if (!s.layoutScale) { watchScale(); return false; }
        return true;
    }

    /**
     * Queue a card for the next whole-pixel pass, which runs with the idle pass (flow-idle.ts): when the browser is
     * idle and no card has been drawn for a whole idle period.
     * @param settle - Its size is changing: wait until it has kept one (a window being resized reports every card on every frame).
     */
    function scheduleSnap(ctrl: CardController, settle = false): void {
        if (!snapSupported()) return;
        watchScale();
        s.pendingSnap.add(ctrl);
        if (!settle) { deps.queueIdle(); return; }
        if (snapSettle) clearTimeout(snapSettle);
        snapSettle = setTimeout(() => {
            snapSettle = 0;
            deps.queueIdle();
        }, SNAP_SETTLE_MS);
    }

    /** Take a card's nudges off (writes only): the fitting pass is about to measure it, and reads the layout as it is without them. */
    function unsnap(ctrl: CardController): void {
        for (const slot of ctrl.host.children) {
            for (const node of slot.children) {
                if (!(node instanceof HTMLElement) || !nudges.has(node)) continue;
                nudges.delete(node);
                for (const [, name] of SNAP_PROPERTIES) node.style.removeProperty(name);
            }
        }
    }

    /**
     * A card the whole-pixel pass measured has another size now (the size observer): its containers lie elsewhere.
     * Bands' margins given as lengths (bandNudges) do not follow a size that changes, so they come off at once, before
     * the frame is painted.
     */
    function snapAgain(ctrl: CardController): void {
        if (ctrl.layout === 'bands') unsnap(ctrl);
        scheduleSnap(ctrl, true);
    }

    /**
     * Have the size observer watch a card the pass measured, and note the size it measured at: another size queues
     * the card again (fit-measure.ts refitOnSizeChange).
     * @param width - 0 for a card that was not laid out: any size it gets is another.
     */
    function noteSnapSize(host: HTMLElement, width: number, height: number): void {
        deps.watchSize(host);
        const sizes = s.fittedWidths.get(host);
        if (!sizes) return;
        // In the observer's own units where it has reported (they differ from the box by any padding of the page's).
        const known = width > 0 && sizes.observed >= 0;
        sizes.snapWidth = known ? sizes.observed : width;
        sizes.snapHeight = known ? sizes.observedHeight : height;
    }

    /**
     * Whether a card's box is not the size it is laid out at: it is scaled (hovered or focused under a theme,
     * animating), and distances read then are scaled too. The size observer reports the box as it is laid out, to the
     * layout unit: against that, a card a fraction of a pixel off its size shows (the last frames of a zoom on its way
     * back, when it would be measured and nudged for a size it is about to leave). The report is used where it agrees
     * with the layout's size in whole pixels, which is always known; without one, that rounding is all there is, and a
     * scale that hides inside it is taken for none.
     */
    function scaled(host: HTMLElement, rect: DOMRect): boolean {
        const sizes = s.fittedWidths.get(host);
        const width = host.offsetWidth;
        const height = host.offsetHeight;
        if (sizes && sizes.boxWidth !== undefined && sizes.boxHeight !== undefined) {
            // (The report is inline size first: in a vertical writing mode that is the height. Either way round.)
            let agrees = false;
            for (const [across, down] of [[sizes.boxWidth, sizes.boxHeight], [sizes.boxHeight, sizes.boxWidth]] as const) {
                if (Math.abs(across - width) > 0.5 || Math.abs(down - height) > 0.5) continue;
                agrees = true;
                if (Math.abs(rect.width - across) <= SCALED_PX && Math.abs(rect.height - down) <= SCALED_PX) return false;
            }
            if (agrees) return true;
        }
        return Math.abs(rect.width - width) > 0.51 || Math.abs(rect.height - height) > 0.51;
    }

    /** Measure a card again when the state it could not be measured in ends (the pointer leaves, focus leaves, an animation finishes). */
    function snapLater(ctrl: CardController): void {
        const host = ctrl.host;
        const card = host.closest('.card, .listItem') || host.parentElement;
        if (!card || snapWaiting.has(host)) return;
        snapWaiting.add(host);
        s.snapCounters.deferred++;
        const inState = (state: string) => { try { return card.matches(state); } catch { return false; } };
        /** Whether a transition of a transform is still running in the card: it is on its way back to its own size. */
        const settling = () => {
            try {
                return card.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'
                    && /^(?:transform|scale|translate|rotate|zoom)$/.test((animation as Animation & { transitionProperty?: string }).transitionProperty || ''));
            } catch {
                return false;
            }
        };
        const again = (event: Event) => {
            // The listeners hear the card's descendants too (neither pointerleave nor the end of a transition is the
            // card's own alone). Only what ends the state counts: the pointer leaving the card itself, focus going
            // outside it, or a transition or animation finishing once neither is on it any more. A pointer moving
            // between the card's buttons, or the transition that brought the card to its hover size, must not have it
            // measured. Nor is it measured on its way back: the pointer has left, the card is still a hair larger than
            // its own size, and that reads as not scaled (scaled). The end of that transition is what is waited for then.
            if (event.type === 'pointerleave') {
                if (event.target !== card || settling()) return;
            } else if (event.type === 'focusout') {
                const to = event instanceof FocusEvent ? event.relatedTarget : null;
                if ((to instanceof Node && card.contains(to)) || settling()) return;
            } else if (inState(':hover') || inState(':focus-within')) {
                return;
            }
            for (const type of SNAP_AGAIN_EVENTS) card.removeEventListener(type, again, true);
            snapWaiting.delete(host);
            if (!(host.isConnected && s.controllers.get(host) === ctrl && ctrl.layout)) return;
            // (A font arrived meanwhile: its fit waited too.)
            if (ctrl.refit) { ctrl.refit = false; deps.scheduleFit(ctrl); }
            scheduleSnap(ctrl, true);
        };
        for (const type of SNAP_AGAIN_EVENTS) card.addEventListener(type, again, true);
    }

    /**
     * The whole-pixel pass, reads: for every queued card, how far each of its containers is from the pixel it was
     * painted from when it was contained.
     * @param cards - The cards of this slice, already taken off the queue (default: every queued card).
     * @returns The nudges to write (applySnap); null when nothing could be measured yet.
     */
    function measureSnap(cards?: CardController[]): SnapPlan[] | null {
        if (!snapReady()) return null;
        if (!cards) { cards = Array.from(s.pendingSnap); s.pendingSnap.clear(); }
        const started = performance.now();
        const list = cards.filter((c) => c.host.isConnected && s.controllers.get(c.host) === c && c.layout);
        const plans: SnapPlan[] = [];
        const memo = new Map<Element, { x: number; y: number }>();
        for (const ctrl of list) {
            // About to be fitted: measured after that pass (flushFit queues it again).
            if (s.pendingFit.has(ctrl)) continue;
            const host = ctrl.host;
            const hostRect = host.getBoundingClientRect();
            // Not laid out (a hidden page): its size observer queues it when it is.
            if (!(hostRect.width > 0 && hostRect.height > 0)) { noteSnapSize(host, 0, 0); continue; }
            if (scaled(host, hostRect)) { snapLater(ctrl); continue; }
            s.snapCounters.cards++;
            let any = false;
            let loading = false;
            for (const slot of host.children) {
                if (!slot.classList.contains('je-tag-slot') || !(slot instanceof HTMLElement)) continue;
                const band = ctrl.layout === 'bands' && slot.dataset.jeSlot === 'top';
                const items: SnapItem[] = [];
                let origin: { x: number; y: number } | null = null;
                for (const node of slot.children) {
                    if (!(node instanceof HTMLElement)) continue;
                    const group = node.dataset.jeGroup;
                    const snapped = !!group && SNAPPED_GROUPS.has(group);
                    // In the band every item takes part: one that is not nudged still has to stay where it is.
                    if (!snapped && !band) continue;
                    const was = nudges.get(node);
                    const rect = node.getBoundingClientRect();
                    // No box (its chips are the slot's own items, it is hidden, its image has not loaded): nothing is
                    // painted from its corner.
                    if (!(rect.width > 0 && rect.height > 0)) {
                        if (was) plans.push({ node, x: 0, y: 0, vx: 0, left: 0, band: null });
                        continue;
                    }
                    origin ??= grid.gridOrigin(slot, memo);
                    // Where it would be without the nudge it has.
                    const ux = rect.left - origin.x - (was ? was.x : 0);
                    const uy = rect.top - origin.y - (was ? was.y : 0);
                    items.push({ node, rect, ux, uy, dx: snapped ? unitsToPx(snapUnits(ux, s.layoutScale)) : 0, dy: snapped ? unitsToPx(snapUnits(uy, s.layoutScale)) : 0, group: !!group });
                }
                // An image still loading gives its container another size when it arrives: measured again then.
                if (!loading && deps.imagesLoading(slot)) loading = true;
                if (!items.length) continue;
                any = true;
                if (band) deps.watchBand(slot);
                // (A held band takes no margins across: see snap-bands.ts onBandSizes.)
                const values = !band || !origin ? null : deps.bandHeld(slot) ? items.map(() => null) : deps.bandNudges(slot, origin, items);
                items.forEach((item, i) => {
                    if (!item.group) return;
                    if (!values) { plans.push({ node: item.node, x: item.dx, y: item.dy, vx: item.dx, left: 0, band: null }); return; }
                    // A band line that could not take its nudges keeps its groups where they are across; up and down nothing is shared.
                    const value = values[i];
                    plans.push({ node: item.node, x: value ? item.dx : 0, y: item.dy, vx: value ? value.vx : 0, left: value ? value.left : 0, band: slot });
                });
            }
            if (any) noteSnapSize(host, hostRect.width, hostRect.height);
            if (loading) deps.awaitImages(ctrl);
        }
        s.snapCounters.passes++;
        s.snapCounters.passMs += performance.now() - started;
        return plans;
    }

    /** The whole-pixel pass, writes: the nudges that changed. */
    function applySnap(plans: SnapPlan[]): void {
        for (const plan of plans) {
            const { node } = plan;
            const was = nudges.get(node);
            // The shortest text that reads back as the same number: the margin then comes out on the layout unit meant.
            const next: Nudge = { x: plan.x, y: plan.y, vx: plan.vx ? `${plan.vx}px` : '', vy: plan.y ? `${plan.y}px` : '', left: plan.left ? `${plan.left}px` : '' };
            for (const [key, name] of SNAP_PROPERTIES) {
                if ((was ? was[key] : '') === next[key]) continue;
                if (next[key]) node.style.setProperty(name, next[key]);
                else node.style.removeProperty(name);
                s.snapCounters.moved++;
                // A band's margins across are what could change its size (onBandSizes).
                if (plan.band && key !== 'vy') deps.noteBandWrite(plan.band);
            }
            if (next.vx || next.vy || next.left) nudges.set(node, next);
            else nudges.delete(node);
        }
    }

    /** Stop hearing of the pixel grid (the cards were cleared: the next card measured starts it again). */
    function releaseScale(): void {
        scaleObserver?.disconnect();
        scaleObserver = null;
    }

    /** The whole-pixel pass in one go: reads, then writes. */
    function flushSnap(): void {
        const plans = measureSnap();
        if (plans) applySnap(plans);
    }

    return {
        snapSupported, snapReady, scheduleSnap, unsnap, snapAgain, snapLater, measureSnap, applySnap, flushSnap, releaseScale,
        /** Counts of the whole-pixel pass and the time its reads took (performance checks). */
        snapStats: () => ({ ...s.snapCounters, scale: s.layoutScale, waiting: s.pendingSnap.size }),
    };
}
