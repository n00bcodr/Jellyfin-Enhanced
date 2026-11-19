import type { LayoutSettings } from './layout-rules';
import type { CardController, LayoutHost } from './layout-runtime-types';
import type { LayoutFns, LayoutState } from './state';

/** Boxes are the same when no edge differs by more than this (CSS px): engines round a grid item and a positioned box a few hundredths apart. */
const ALIKE_PX = 0.1;
/** The idle pass runs at the latest this long after it was asked for (ms). */
const FLOW_IDLE_TIMEOUT_MS = 2000;
/**
 * The idle pass works through its cards in slices: each takes about this much script time (ms), then gives the
 * thread back, and the next runs in a later idle period. A page of cards decided and measured in one go was one long
 * task, and the frame that then laid all of them out again (in flow, on their pixels) another; a slice's frame costs
 * about twice the slice, so both stay well under a long task on any device.
 */
const IDLE_SLICE_MS = 12;
/** A slice takes this many cards at least, whatever is left of the idle period, and no more than the most. */
const IDLE_SLICE_MIN_CARDS = 2;
const IDLE_SLICE_MAX_CARDS = 48;
/**
 * What a card that is only measured again, or only marked, counts for beside one whose resting layout is decided: it
 * reads a few boxes of a layout that stands, where the other is asked about, marked, nudged and laid out again by the
 * frame that follows.
 */
const IDLE_LIGHT_CARD = 0.25;
/** A slice that is not the first runs at the latest this long after the one before it (ms). */
const IDLE_NEXT_TIMEOUT_MS = 500;

interface Probe { host: HTMLElement; slots: Array<[HTMLElement, string]>; ctrl: CardController | null; conf: LayoutSettings }

/**
 * The idle pass (upstream abcaa16d). Nothing is read from the page while cards are being drawn; here, once a whole
 * idle period has passed with no card queued, the queued cards' resting layout is decided (flushAlike) and their
 * group containers are moved onto whole pixels (snap.ts measureSnap, applySnap): one layout for both, and one paint.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createFlowIdle(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    void JE;
    let alikeScheduled = false;
    /** How many cards were ever queued for the idle pass, and how many had been when it was last scheduled. */
    let flowQueued = 0;
    let flowSeen = 0;
    /** What a card costs a slice on this device (ms), learnt from the slices that ran; the first assumes this. */
    let idleMsPerCard = 1.5;

    /** Have a card's resting layout decided in idle time (flushAlike): what decides it has to be read from the page, and a card that is being drawn reads nothing. */
    function queueFlow(ctrl: CardController): void {
        s.pendingAlike.add(ctrl);
        queueIdle();
    }

    /**
     * Have the idle pass run once the page has been idle a whole period with nothing queued since (the whole-pixel
     * pass asks the same way, snap.ts scheduleSnapPass): a page that is loading or scrolling new cards in is dealt
     * with once, when it has come to rest, not after every batch of cards.
     */
    function queueIdle(): void {
        flowQueued++;
        scheduleAlike();
    }

    /**
     * Run the idle pass when the browser is next idle.
     * @param next - For the slice after one that just ran: it need not wait as long.
     */
    function scheduleAlike(next = false): void {
        if (alikeScheduled) return;
        alikeScheduled = true;
        flowSeen = flowQueued;
        if (typeof requestIdleCallback === 'function') requestIdleCallback((deadline) => flushIdle(deadline), { timeout: next ? IDLE_NEXT_TIMEOUT_MS : FLOW_IDLE_TIMEOUT_MS });
        else setTimeout(() => flushIdle(), next ? 16 : 200);
    }

    /** How long the next slice of the idle pass may take (ms): a slice's time, and no more than the idle period has left. */
    function idleSliceRoom(deadline?: IdleDeadline): number {
        let room = IDLE_SLICE_MS;
        try {
            // Run because it had waited too long, not because the browser is idle: half a slice.
            if (deadline && deadline.didTimeout) room = IDLE_SLICE_MS / 2;
            else if (deadline && typeof deadline.timeRemaining === 'function') room = Math.min(IDLE_SLICE_MS, deadline.timeRemaining());
        } catch { /* a deadline that cannot be read: a whole slice */ }
        return room;
    }

    /** How many cards fit in a slice's time at what a card has cost so far: two at least, so the pass always ends. */
    function idleSliceCards(room: number): number {
        return Math.max(IDLE_SLICE_MIN_CARDS, Math.min(IDLE_SLICE_MAX_CARDS, Math.floor(room / Math.max(idleMsPerCard, 0.05))));
    }

    /**
     * The idle pass. It takes a slice of the cards at a time (idleSliceCards) and leaves the rest to the idle periods
     * that follow, so neither the pass nor the frame after it is a long task. A slice writes to its own cards only,
     * and each card is laid out by itself (Jellyfin's image box is contained), so no slice undoes a layout an earlier
     * one paid for.
     */
    function flushIdle(deadline?: IdleDeadline): void {
        alikeScheduled = false;
        if (flowQueued !== flowSeen) { scheduleAlike(); return; }
        const began = performance.now();
        const room = idleSliceRoom(deadline);
        // One slice of cards that had something done to them. Cards with nothing to do (hidden, under the pointer,
        // about to be fitted, gone) take no time and leave nothing for a frame to do: after a slice of those alone the
        // next follows at once, while the slice's time lasts.
        for (;;) {
            const started = performance.now();
            const worked = idleSlice(idleSliceCards(room - (started - began)));
            // What a card costs is learnt from cards that were worked on: counted, the others made a card look free,
            // and the slice after a run of them took every card it was allowed.
            if (worked > 0) idleMsPerCard = idleMsPerCard * 0.5 + ((performance.now() - started) / worked) * 0.5;
            const more = s.pendingAlike.size > 0 || s.pendingFreed.size > 0 || (s.pendingSnap.size > 0 && deps.snapReady());
            if (!more) return;
            if (worked > 0 || performance.now() - began >= room) break;
        }
        scheduleAlike(true);
    }

    /**
     * One slice of the idle pass (flushIdle).
     * @param count - How many cards it takes (one only measured again, or only marked, counts for a quarter).
     * @returns How many of them had something done (counted the same way): the rest cost nothing.
     */
    function idleSlice(count: number): number {
        const snapping = s.pendingSnap.size > 0 && deps.snapReady();
        // The cards waiting to be measured in the order they came (one queued again to be checked in flow comes after
        // every card that has not had its turn), then those waiting for their resting layout alone, then those an
        // answer has freed.
        const measuring: CardController[] = [];
        const deciding: CardController[] = [];
        const freed: CardController[] = [];
        let taken = 0;
        if (snapping) {
            for (const ctrl of s.pendingSnap) {
                if (taken >= count) break;
                measuring.push(ctrl);
                if (s.pendingAlike.has(ctrl)) { deciding.push(ctrl); taken += 1; } else taken += IDLE_LIGHT_CARD;
            }
        }
        for (const ctrl of s.pendingAlike) {
            if (taken >= count) break;
            if (snapping && s.pendingSnap.has(ctrl)) continue;
            deciding.push(ctrl);
            taken += 1;
        }
        for (const ctrl of s.pendingFreed) {
            if (taken >= count) break;
            freed.push(ctrl);
            taken += IDLE_LIGHT_CARD;
        }
        for (const ctrl of measuring) s.pendingSnap.delete(ctrl);
        for (const ctrl of deciding) { s.pendingAlike.delete(ctrl); s.pendingFreed.delete(ctrl); }
        for (const ctrl of freed) s.pendingFreed.delete(ctrl);
        // Measured first, while the layout the last frame made still stands, and written with the marks below, so the
        // browser lays the cards out once for both. A card whose layout the marks change lies where it lay to within
        // what the comparison allows, which is more than a layout unit: it is queued again (markFlow) and checked in a
        // later idle period, when the reading is free.
        const measuredBefore = s.snapCounters.cards;
        const plans = measuring.length ? deps.measureSnap(measuring) : null;
        const measured = s.snapCounters.cards - measuredBefore;
        const decided = flushAlike(deciding);
        // Cards an earlier slice's answers freed: nothing of theirs is read, their kinds are known.
        let marked = 0;
        for (const ctrl of freed) {
            if (!ctrl.host.isConnected || s.controllers.get(ctrl.host) !== ctrl || !ctrl.layout || ctrl.host.dataset.jeFlow === '1') continue;
            if (deps.decideFlow(ctrl, deps.resolveLayout(ctrl)) === true) { deps.markFlow(ctrl, true, true); marked++; }
        }
        if (plans) deps.applySnap(plans);
        return decided + IDLE_LIGHT_CARD * (Math.max(0, measured - decided) + marked);
    }

    /**
     * The boxes of some slots of a host, from the host's corner (reads only): each slot, what it holds, and the chips
     * of each group. Null for a slot whose quality or language group the page's CSS no longer clips (positioned state
     * only): flow would clip it again.
     * @param positioned - The host is laid out positioned now.
     */
    function boxesOf(host: HTMLElement, slots: Array<[HTMLElement, string]>, positioned: boolean): Array<number[] | null> {
        const origin = host.getBoundingClientRect();
        return slots.map(([slot]) => {
            const boxes: number[] = [];
            const add = (el: Element) => {
                const r = el.getBoundingClientRect();
                boxes.push(r.left - origin.left, r.top - origin.top, r.width, r.height);
            };
            add(slot);
            for (const node of slot.children) {
                if (positioned && (node.classList.contains(s.CONTAINER_CLASS.quality) || node.classList.contains(s.CONTAINER_CLASS.language))) {
                    let cs: CSSStyleDeclaration | null;
                    try { cs = getComputedStyle(node); } catch { cs = null; }
                    if (cs && ((cs.overflowX && cs.overflowX !== 'hidden') || (cs.overflowY && cs.overflowY !== 'hidden'))) return null;
                }
                // Its chips too: a genre icon is positioned in one layout and not in the other.
                add(node);
                for (const chip of node.children) add(chip);
            }
            return boxes;
        });
    }

    /**
     * Measure cards both ways and remember, for each kind of slot asked about, whether every box came out the same:
     * each card's boxes in the layout it has (reads), the mark flipped on all of them (writes), their boxes again (one
     * layout for all), and the mark put back. A card that also shows kinds of element not seen before has their styles
     * read while it is laid out in flow (layeredFlow). Nothing is painted in between.
     */
    function askBrowser(probes: Probe[]): void {
        if (!probes.length) return;
        const marked = probes.map((probe) => probe.host.dataset.jeFlow === '1');
        const flip = (host: HTMLElement, flow: boolean) => {
            if (flow) host.dataset.jeFlow = '1';
            else delete host.dataset.jeFlow;
        };
        const first = probes.map((probe, i) => boxesOf(probe.host, probe.slots, !marked[i]));
        probes.forEach((probe, i) => { if (marked[i] && probe.ctrl) deps.layeredFlow(probe.ctrl, probe.conf, true); });
        probes.forEach((probe, i) => flip(probe.host, !marked[i]));
        const second = probes.map((probe, i) => boxesOf(probe.host, probe.slots, !!marked[i]));
        probes.forEach((probe, i) => { if (!marked[i] && probe.ctrl) deps.layeredFlow(probe.ctrl, probe.conf, true); });
        probes.forEach((probe, i) => {
            probe.slots.forEach(([, key], k) => {
                const a = first[i]?.[k], b = second[i]?.[k];
                s.flowAlike.set(key, !!a && !!b && a.length === b.length && a.every((value, at) => Math.abs(value - (b[at] ?? NaN)) <= ALIKE_PX));
            });
            flip(probe.host, !!marked[i]);
            s.flowCounters.probes += probe.slots.length;
        });
    }

    /**
     * Decide the resting layout of the cards queued for it: the page's switch is read, one card of each kind of slot
     * not answered yet is measured both ways, the styles of kinds of element not seen yet are read, and every queued
     * card is marked for flow or left positioned.
     * @param cards - The cards of this slice, already taken off the queue (default: every queued card).
     * @returns How many of them were decided (the others had nothing done: gone, hidden, under the pointer).
     */
    function flushAlike(cards?: CardController[]): number {
        if (!cards) { cards = Array.from(s.pendingAlike); s.pendingAlike.clear(); }
        const list = cards.filter((c) => c.host.isConnected && s.controllers.get(c.host) === c && c.layout);
        const probes: Probe[] = [];
        const claimed = new Set<string>();
        const deciding: Array<[CardController, LayoutSettings]> = [];
        for (const ctrl of list) {
            const host = ctrl.host;
            // A live card is not at rest: decided when it is. A hidden one has no boxes to compare: when it gets a
            // size. Unless an earlier slice has answered for every kind it holds: then it is marked as the cards those
            // answers freed are, with nothing of its own read.
            const waits = !!host.dataset.jeLive || !(host.clientWidth > 0);
            if (waits) {
                if (deps.decideFlow(ctrl, deps.resolveLayout(ctrl)) === true) deps.markFlow(ctrl, true, true);
                else if (!host.dataset.jeLive) deps.awaitSize(ctrl);
                continue;
            }
            const conf = deps.resolveLayout(ctrl);
            deciding.push([ctrl, conf]);
            if (deps.flowFor(ctrl, conf, true) !== true) continue;
            const slots = deps.measurableKinds(ctrl, conf).filter(([, key]) => !s.flowAlike.has(key) && !claimed.has(key));
            for (const [, key] of slots) claimed.add(key);
            // Kinds of element no card has shown yet: their styles are read on this card.
            const fresh = new Set<string>();
            deps.layeredFlow(ctrl, conf, false, fresh);
            let inspect = false;
            for (const key of fresh) if (!claimed.has(key)) { claimed.add(key); inspect = true; }
            if (slots.length || inspect) probes.push({ host, slots, ctrl: inspect ? ctrl : null, conf });
        }
        askBrowser(probes);
        for (const [ctrl, conf] of deciding) {
            const flow = deps.decideFlow(ctrl, conf);
            // Still not known (an image of the card is loading): it stays as it is and is decided when that settles.
            if (flow !== null) deps.markFlow(ctrl, flow, true);
        }
        // The answers reach every card they free, not only the ones that asked: those take their turn in the slices
        // that follow (flushIdle), like any card.
        if (!probes.length) return deciding.length;
        for (const el of document.querySelectorAll<HTMLElement>('.je-tag-host:not([data-je-flow])')) {
            const ctrl = s.controllers.get(el);
            if (!ctrl || !ctrl.layout || s.pendingAlike.has(ctrl) || s.pendingFreed.has(ctrl)) continue;
            if (deps.decideFlow(ctrl, deps.resolveLayout(ctrl)) === true) s.pendingFreed.add(ctrl);
        }
        return deciding.length;
    }

    return {
        queueFlow, queueIdle, flushAlike,
        /** What the idle pass still has to do, and what a card costs a slice (performance checks). */
        idleStats: () => ({ waiting: s.pendingAlike.size + s.pendingFreed.size + s.pendingSnap.size, msPerCard: idleMsPerCard }),
    };
}
