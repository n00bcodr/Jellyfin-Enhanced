import type { LayoutHost } from './layout-runtime-types';
import type { SnapItem } from './snap';
import { SNAP_SAME_PX, type LayoutFns, type LayoutState } from './state';

/** A band that gains or loses a line within this long of its margins being written, holding what it held, did so because of them (ms). */
const BAND_OWN_MS = 1000;
/** A band this much taller or shorter than the pass measured it has a line more or less (CSS px; a line is a chip's height at least). */
const BAND_LINE_PX = 1;

/**
 * Bands' top band under the whole-pixel pass (upstream abcaa16d, core/tag-layout.js): its groups are spread with auto
 * margins, so a nudge has to keep every group on its line, and a band that changes lines all the same is held.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createSnapBands(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    void JE;
    /** The top bands of Bands cards (watchBand). */
    let bandObserver: ResizeObserver | null = null;
    /** Top band → the room inside its padding [width, height], as its observer last reported it. */
    const bandSizes = new WeakMap<Element, number[]>();
    /**
     * Top band → what the last pass found in it: the height inside its padding, and what it held (bandSignature). (A
     * measured box and an observer's report are not the same number to the last layout unit, so the height is only held
     * against a report for a whole line more or less: BAND_LINE_PX.)
     */
    const bandRooms = new WeakMap<Element, { height: number; held: string }>();
    /** Top band → when its groups' margins across were last written or taken off (performance.now). */
    const bandWrites = new WeakMap<Element, number>();
    /** Top bands whose margins changed their own lines: left as they are across until they change size for another reason. */
    const bandHeld = new WeakSet<Element>();
    /** Top bands being watched. */
    let bandsWatched = new WeakSet<Element>();
    const toUnits = (px: number) => Math.round(px * s.layoutScale * 64);
    const unitsToPx = (units: number) => units / 64 / s.layoutScale;

    /** Size observer of the top bands: the room inside a band's padding, which follows Jellyfin's indicators, is what its groups are spread over. */
    function onBandSizes(entries: ResizeObserverEntry[]): void {
        for (const entry of entries) {
            const slot = entry.target;
            if (!slot.isConnected) {
                bandObserver?.unobserve(slot);
                bandsWatched.delete(slot);
                bandSizes.delete(slot);
                continue;
            }
            const seen = bandSizes.get(slot);
            const { width, height } = entry.contentRect;
            bandSizes.set(slot, [width, height]);
            const host = slot.closest<HTMLElement>('.je-tag-host');
            const ctrl = host ? s.controllers.get(host) : null;
            if (!ctrl || !ctrl.layout || !(slot instanceof HTMLElement)) continue;
            // A band must never gain or lose a line because of its nudges (bandNudges keeps a group from changing
            // lines). Should one do so all the same, it is left as it is across from then on: measured again it would
            // get the same margins, change lines again, and so on without end. The margins are to blame only where
            // nothing else explains it: they were written a moment ago, and the band holds exactly what the pass
            // measured, in the room it measured. A tag drawn late or an image that arrived changes what it holds, and
            // is measured again like any other change.
            const wrote = bandWrites.get(slot);
            const recent = wrote !== undefined && performance.now() - wrote < BAND_OWN_MS;
            const room = bandRooms.get(slot);
            const own = recent && room !== undefined && bandSignature(slot) === room.held;
            const lines = own && room !== undefined && Math.abs(height - room.height) >= BAND_LINE_PX;
            // The first report is the size the last pass measured in, unless its margins have changed the lines since.
            const changed = seen ? Math.abs((seen[0] ?? 0) - width) >= SNAP_SAME_PX || Math.abs((seen[1] ?? 0) - height) >= SNAP_SAME_PX : lines;
            if (!changed) continue;
            if (bandHeld.has(slot)) {
                // Its size coming back as the margins come off is still its own doing; any other change frees it.
                if (own) continue;
                bandHeld.delete(slot);
            } else if (lines) {
                bandHeld.add(slot);
                s.snapCounters.held++;
            }
            deps.snapAgain(ctrl);
            // (snapAgain took the margins off: the size report that follows is this band's own too.)
            if (bandHeld.has(slot)) bandWrites.set(slot, performance.now());
        }
    }

    /**
     * What a top band holds, for telling a change of its lines that its margins made from any other (reads only;
     * where it is asked, the layout stands): the room across inside its padding, and the size of every item laid out
     * in it, in layout units, and its gap. Margins move items and change none of this.
     */
    function bandSignature(slot: HTMLElement): string {
        try {
            const style = getComputedStyle(slot);
            const box = slot.getBoundingClientRect();
            const pad = (side: string) => parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
            const rects: DOMRect[] = [];
            for (const child of slot.children) {
                const rect = child.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) rects.push(rect);
            }
            return bandHolds(box.width - pad('left') - pad('right'), style.columnGap, rects);
        } catch {
            return '';
        }
    }

    /**
     * @param room - The room across inside the band's padding, CSS px.
     * @param gap - The band's computed column gap.
     * @param rects - The boxes of the items laid out in it, in order.
     * @returns bandSignature's text for them.
     */
    function bandHolds(room: number, gap: string, rects: Array<{ width: number; height: number }>): string {
        return `${toUnits(room)}:${gap}:${rects.map((rect) => `${toUnits(rect.width)}x${toUnits(rect.height)}`).join(',')}`;
    }

    /** Watch a top band the pass measured (bandNudges notes the room it found in it). */
    function watchBand(slot: HTMLElement): void {
        if (bandsWatched.has(slot)) return;
        bandsWatched.add(slot);
        if (!bandObserver) bandObserver = new ResizeObserver(onBandSizes);
        bandObserver.observe(slot);
    }

    /** Stop watching every band (the cards were cleared: a band measured again is watched again). */
    function releaseBands(): void {
        bandObserver?.disconnect();
        bandObserver = null;
        bandsWatched = new WeakSet();
    }

    /**
     * Bands' top band spreads its groups with auto margins: the band's first group has one on its right, every other
     * group one on its left, and the browser shares a line's free space among them in whole layout units, one after
     * the other. A group moved through its other margin changes that sharing, and with it where the groups between
     * the ends of the line land. So the line's first and last group are moved through the margin they have (they are
     * held by the line's ends), and each group in between gets its auto margin as a length, what it measures now plus
     * the nudge (--je-band-left): it then sits a fixed distance from the group after it, and the line lies exactly as
     * it did, each group moved by its own fraction. Lengths do not follow a card that changes size, so the size
     * observer takes them off the moment one does (snapAgain).
     * @param origin - The corner of the slot's pixel grid.
     * @param items - Every item of the band that has a box, in order: its groups, and anything else laid out with them.
     * @returns For each item its --je-snap-x and --je-band-left (0: none), in CSS px; null for one that stays as it is.
     */
    function bandNudges(slot: HTMLElement, origin: { x: number; y: number }, items: SnapItem[]): Array<{ vx: number; left: number } | null> {
        const out: Array<{ vx: number; left: number } | null> = new Array<{ vx: number; left: number } | null>(items.length).fill(null);
        let gap = 0;
        let start = 0;
        let end = 0;
        try {
            const style = getComputedStyle(slot);
            const box = slot.getBoundingClientRect();
            const pad = (side: string) => parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
            // (A length becomes layout units by dropping what is left over.)
            gap = Math.floor((parseFloat(style.columnGap) || 0) * s.layoutScale * 64 + 1e-3);
            start = toUnits(box.left + pad('left') - origin.x);
            end = toUnits(box.right - pad('right') - origin.x);
            // What this pass found: a report of another number of lines, of a band that holds the same, is held against it.
            bandRooms.set(slot, { height: box.height - pad('top') - pad('bottom'), held: bandHolds(box.width - pad('left') - pad('right'), style.columnGap, items.map((item) => item.rect)) });
        } catch { return out; }
        const at = (i: number): SnapItem => items[i] as SnapItem;
        const lines: number[][] = [];
        items.forEach((item, i) => {
            const line = lines[lines.length - 1];
            if (line && Math.abs(at(line[0] ?? 0).uy - item.uy) < 1) line.push(i);
            else lines.push([i]);
        });
        /** A CSS pixel, in layout units: the least an auto margin must hold to give some up. */
        const pixel = 64 * s.layoutScale;
        // Each line: the margins it would get (null: it stays as it is), the free space its auto margins hold between
        // them, and how much of the line the margins would give back.
        const plans = lines.map((line) => {
            const n = line.length;
            const x = line.map((i) => toUnits(at(i).ux));
            const w = line.map((i) => toUnits(at(i).rect.width));
            const d = line.map((i) => toUnits(at(i).dx));
            const xs = (j: number) => x[j] ?? 0, ws = (j: number) => w[j] ?? 0, ds = (j: number) => d[j] ?? 0;
            const free = end - start - w.reduce((sum, width) => sum + width, 0) - gap * (n - 1);
            const plan: { values: Array<{ vx: number; left: number }> | null; free: number; gives: number; head: number; headNudge: number } = { values: null, free, gives: 0, head: ws(0), headNudge: ds(0) };
            // Something on the line that is not a group has no auto margin: the line stays as it is.
            if (line.some((i) => !at(i).group)) return plan;
            // The line starts with the band's first group: it is held by the line's start, and two auto margins lie between it and the next.
            const first = at(line[0] ?? 0).node === slot.firstElementChild;
            /** The auto margin (or two) between a group and the next. */
            const between = (j: number) => xs(j + 1) - (xs(j) + ws(j)) - gap;
            // Room: every auto margin holds a pixel at least, so none runs out and wraps a group.
            let roomy = first ? n === 1 || between(0) >= 2 * pixel : xs(0) - start >= pixel;
            for (let j = first ? 1 : 0; j < n - 1; j++) roomy = roomy && between(j) >= pixel;
            if (!roomy) return plan;
            const lengths = (j: number) => j >= (first ? 2 : 1);
            // (--je-snap-x is the left margin of the band's first group and minus the right margin of the others.)
            plan.values = line.map((_, j) => ({ vx: unitsToPx(ds(j)), left: lengths(j) ? unitsToPx(between(j - 1) + ds(j)) : 0 }));
            const taken = d.reduce((sum, nudge, j) => sum + (first && j === 0 ? nudge : -nudge) + (lengths(j) ? between(j - 1) + nudge : 0), 0);
            plan.gives = Math.max(0, -taken);
            return plan;
        });
        // No group may change lines. The first group of a line came down because it is wider than what was left of the
        // line above; pushed from its right it is as much narrower for the line breaking as it moves right, and the
        // margins of the line above can give room back. Where the two together come within an eighth of a pixel of
        // letting it up, both lines stay as they are: a group that came up would change the band's height, the nudges
        // would come off for that, and it would go down again. (The sums are exact in layout units; the slack is for a
        // margin that comes out a unit off what was written.)
        const slack = Math.max(4, Math.round(pixel / 8));
        for (let k = 0; k + 1 < plans.length; k++) {
            const above = plans[k];
            const below = plans[k + 1];
            if (!above || !below || (!above.values && !below.values)) continue;
            const room = above.free + (above.values ? above.gives : 0);
            const needs = below.head - (below.values ? Math.max(0, below.headNudge) : 0) + gap;
            if (room + slack >= needs) { above.values = null; below.values = null; }
        }
        plans.forEach((plan, k) => {
            const values = plan.values;
            if (values) (lines[k] ?? []).forEach((i, j) => { out[i] = values[j] ?? null; });
        });
        return out;
    }

    return {
        bandNudges, watchBand, releaseBands,
        /** A band's margins across were just written or taken off (onBandSizes blames a change of lines on them for a moment). */
        noteBandWrite: (slot: Element): void => { bandWrites.set(slot, performance.now()); },
        /** Whether a band is held: left as it is across until it changes size for another reason. */
        bandHeld: (slot: Element): boolean => bandHeld.has(slot),
    };
}
