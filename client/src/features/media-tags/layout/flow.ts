import type { LayoutSettings } from './layout-rules';
import type { CardController, LayoutHost } from './layout-runtime-types';
import { REST_AFTER_MS, type LayoutFns, type LayoutState } from './state';

/**
 * Layouts whose resting slots can be laid out in flow (tag-layout-styles.ts buildFlowStyles). Summary and Minimal
 * fade single slots on hover, which needs each slot to be a layer of its own.
 */
const FLOW_LAYOUTS = new Set(['corners', 'bands', 'caption']);

/** An element's class attribute (an SVG element's `className` is not a string). */
const classOf = (el: Element): string => el.getAttribute('class') || '';

/**
 * Resting flow (upstream abcaa16d): which cards may lay their resting tags out in flow, with nothing positioned
 * inside the host, and what of the page's CSS decides it. A card is marked data-je-flow while it may; everything else
 * keeps the positioned layout, unchanged. Nothing here reads the page while a card is being drawn: what has to be
 * read is read in idle time (flow-idle.ts flushAlike).
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createFlow(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    /** Whether this browser has what the flow rules are written with (asked once). */
    let flowSupport: boolean | null = null;
    /** Whether the page's CSS leaves resting flow on (flowAllowedByPage). */
    let flowAllowed: boolean | null = null;
    /** Whether genre names float beside their icons, as the stylesheet has them (genreNamesFloat). */
    let namesFloat: boolean | null = null;

    /**
     * Whether the browser supports everything the resting flow rules use: a size container and its cqh unit, and
     * `overflow: clip`. Without any of them cards keep the positioned layout.
     */
    function flowSupported(): boolean {
        if (flowSupport === null) {
            const css = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' ? CSS : null;
            flowSupport = !!css && css.supports('container-type', 'size') && css.supports('max-height', '1cqh') && css.supports('overflow', 'clip');
        }
        return flowSupport;
    }

    /**
     * Whether the page's own CSS leaves resting flow on: `:root { --je-tag-flow: off; }` keeps every card positioned.
     * Read from the root once and kept until what is known of the page's CSS is next forgotten (forgetPageCss).
     */
    function flowAllowedByPage(): boolean {
        if (flowAllowed === null) {
            let value = '';
            try { value = getComputedStyle(document.documentElement).getPropertyValue('--je-tag-flow'); } catch { value = ''; }
            flowAllowed = String(value || '').trim().toLowerCase() !== 'off';
        }
        return flowAllowed;
    }

    /**
     * Whether genre names float out of their icons (the stylesheet's absolute position), read from the first name a
     * card shows and kept until what is known of the page's CSS is next forgotten. Custom CSS can show them inline
     * instead (`position: static`, the documented recipe): they are then part of the resting card and cannot be left
     * out of it.
     * @param host - A host holding at least one genre name.
     */
    function genreNamesFloat(host: HTMLElement): boolean {
        if (namesFloat === null) {
            const name = host.querySelector('.genre-tag > .genre-text');
            if (!name) return true;
            let position = '';
            try { position = getComputedStyle(name).position; } catch { position = ''; }
            namesFloat = position !== 'static' && position !== 'relative';
        }
        return namesFloat;
    }

    /**
     * Whether a card's resting tags may be laid out in flow, with nothing positioned inside the host, or stay
     * positioned as they always were. Flow paints the same pixels only while nothing inside the host is a layer in
     * its own right, so a card keeps the positioned layout when it has
     *   - a layout or anchor that positions or fades slots one by one (Summary, Minimal, the five centre anchors,
     *     Flush's clipped host);
     *   - a dimmed "partial" language flag (its opacity makes it a layer, and the chips after it must then be
     *     layers to paint over it);
     *   - a status tag with the live backdrop filter (`data-je-blur` on the host, the status-tag painter): a
     *     filtered tag is a layer too;
     *   - genre names custom CSS shows inline (genreNamesFloat);
     *   - a context that is not a library card or list row (the previews style their sample hosts themselves);
     *   - a page whose CSS turns flow off (flowAllowedByPage).
     * Floating genre names hang off a positioned icon: a flow card leaves them out while it rests. Any flow card is
     * laid out positioned for as long as the pointer is on it with its tags on show, or focus is in it (live.ts goLive).
     * @param read - False while a card is being drawn: nothing is read from styles then, and an answer that needs a
     *   read is null (flushAlike reads it in idle time).
     */
    function flowFor(ctrl: CardController, conf: LayoutSettings, read = true): boolean | null {
        if (!deps.api.restingFlow || !FLOW_LAYOUTS.has(conf.layout) || !flowSupported()) return false;
        // The page's switch is a style read: for a card that is being drawn it waits for the idle pass.
        if (flowAllowed === null && !read) return null;
        if (!flowAllowedByPage()) return false;
        if (conf.layout === 'corners' && conf.edge === 'flush') return false;
        const host = ctrl.host;
        if (!host.closest('.card, .listItem')) return false;
        const blur = host.dataset.jeBlur === '1';
        let names = false;
        for (const child of host.children) {
            if (!child.classList.contains('je-tag-slot') || !(child instanceof HTMLElement)) continue;
            if (s.CENTRE_SLOTS.has(child.dataset.jeSlot || '')) return false;
            if (child.querySelector('.language-flag-partial')) return false;
            if (blur && child.querySelector('.status-tag')) return false;
            if (!names && child.querySelector('.genre-tag')) names = true;
        }
        if (!names) return true;
        if (namesFloat === null && !read) return null;
        return genreNamesFloat(host);
    }

    // ── The page's own CSS on a flow card ──────────────────────────────
    // Custom CSS written against the positioned layout must keep working with nothing added to it. Two questions
    // decide whether a card may rest in flow, each asked once per kind and remembered:
    //   - does the browser lay its slots out in flow exactly as positioned? Asked of the browser itself: a card of
    //     the kind is measured both ways in idle time (flushAlike). A nudged group, a slot with another inset or
    //     margin, a re-ordered or re-aligned stack, padding on the host: whatever moves a box by any property
    //     answers no.
    //   - is anything on it a layer of its own (translucent, transformed, filtered, given a stacking order)? Read
    //     from its computed styles (layeredFlow): flow paints in another order around such a box.
    // A card that fails either keeps the positioned layout, where its CSS works as it always did.

    /** Style sheets the page had when the answers were reached: another count means other rules. */
    let flowSheets = -1;
    let reprobeQueued = false;

    /** Run after the next paint (the shared pass where the DOM module is loaded, so the layout read there is the one the paint just made). */
    function afterPaint(fn: () => void): void {
        if (typeof JE.core.dom?.afterNextPaint === 'function') JE.core.dom.afterNextPaint(fn);
        else requestAnimationFrame(fn);
    }

    /**
     * Forget what was learnt of the page's CSS: the switch, how genre names are shown, and every answer about a kind
     * of slot or element. Elements inspected before are inspected again (flowEpoch).
     */
    function forgetPageCss(): void {
        flowAllowed = null;
        namesFloat = null;
        s.flowVerdicts.clear();
        s.flowAlike.clear();
        s.flowEpoch++;
    }

    /**
     * Notice style sheets arriving or leaving after cards were drawn (custom CSS saved in the dashboard, a theme, a
     * sheet JE injects late), at the next card placed: every kind on the page is asked about again after the next
     * paint (reprobe). Text written into an existing sheet and a sheet pulled in by `@import` do not change the
     * count: those apply from the next JE.reinitializeTagLayout().
     */
    function noteSheets(): void {
        const sheets = document.styleSheets ? document.styleSheets.length : 0;
        if (sheets === flowSheets) return;
        const first = flowSheets < 0;
        flowSheets = sheets;
        if (!first) queueReprobe();
    }

    /** A card with no size (its page is hidden) has no boxes to compare: its resting layout is decided when the size observer first reports one. */
    function awaitSize(ctrl: CardController): void {
        s.unmeasured.add(ctrl);
        deps.watchSize(ctrl.host);
    }

    /** Ask about every kind on the page again after the next paint (other style sheets, or a window size that may cross a media query). */
    function queueReprobe(): void {
        if (reprobeQueued) return;
        reprobeQueued = true;
        afterPaint(() => {
            reprobeQueued = false;
            reprobe();
        });
    }

    /**
     * The page's CSS may have changed under cards already drawn. What was learnt is forgotten and every card is
     * decided again in the idle pass (flushAlike): one card of each kind is measured where it stands, and only cards
     * whose answers changed are touched. A card resting in flow keeps its layout meanwhile.
     */
    function reprobe(): void {
        forgetPageCss();
        for (const el of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
            const ctrl = s.controllers.get(el);
            if (!ctrl || !ctrl.layout) continue;
            ctrl.layered.clear();
            deps.queueFlow(ctrl);
        }
    }

    /**
     * The z-index each group container's own stylesheet gives it. A group is a flex or grid item in either layout,
     * so it stacks by that number the same way in both; inside a tag host the pipeline's base rules reset all but
     * the custom group's to auto. Any other value is the page's (the awards container sets none).
     */
    const OWN_Z_INDEX: Record<string, string> = {
        [s.CONTAINER_CLASS.quality]: '100', [s.CONTAINER_CLASS.genre]: '101', [s.CONTAINER_CLASS.language]: '101', [s.CONTAINER_CLASS.rating]: '10',
        [s.CONTAINER_CLASS.ageRating]: '10', [s.CONTAINER_CLASS.status]: '10', [s.CONTAINER_CLASS.logos]: '10', [s.CONTAINER_CLASS.custom]: '10',
    };

    /**
     * What tells one kind of card from another for the page's CSS: the page it is on, the card's classes, item type
     * and indicators, and the look its tags are drawn in.
     */
    function flowContext(ctrl: CardController, conf: LayoutSettings): string {
        const card = ctrl.host.closest('.card, .listItem');
        const page = ctrl.host.closest('.page, .mainAnimatedPage');
        const indicators = card ? card.querySelector('.cardIndicators') : null;
        return `${page ? page.id || classOf(page) : ''}|${card ? classOf(card) : ''}|${card ? card.getAttribute('data-type') || '' : ''}`
            + `|${indicators ? Array.from(indicators.children, classOf).join(',') : ''}`
            + `|${conf.layout}|${conf.legacy ? 1 : 0}|${deps.edgeOf(ctrl)}|${conf.tagScale}|${conf.tagGap}`;
    }

    // ── Laid out alike ─────────────────────────────────────────────────

    /** A card's slots with the key of their kind: the card's context, the slot, and the classes of what it holds, in order. */
    function slotKinds(ctrl: CardController, conf: LayoutSettings): Array<[HTMLElement, string]> {
        const context = flowContext(ctrl, conf);
        const kinds: Array<[HTMLElement, string]> = [];
        for (const child of ctrl.host.children) {
            if (!child.classList.contains('je-tag-slot') || !(child instanceof HTMLElement)) continue;
            kinds.push([child, `${context}|${child.dataset.jeSlot || ''}|${Array.from(child.children, classOf).join(',')}`]);
        }
        return kinds;
    }

    /** Hosts waiting for an image of theirs to load before they are asked about (awaitImages). */
    const awaitingImages = new WeakSet<HTMLElement>();

    /**
     * Whether a slot holds an image that has not finished loading (a flag, a logo): its chips do not have the boxes
     * they will have, and two layouts of empty boxes prove nothing.
     */
    function imagesLoading(slot: Element): boolean {
        for (const img of slot.querySelectorAll('img')) if (!img.complete) return true;
        return false;
    }

    /** Decide a card's layout again when one of its images has loaded or failed (neither event bubbles: heard on the way down to it). */
    function awaitImages(ctrl: CardController): void {
        const host = ctrl.host;
        if (awaitingImages.has(host)) return;
        awaitingImages.add(host);
        const settled = () => {
            host.removeEventListener('load', settled, true);
            host.removeEventListener('error', settled, true);
            awaitingImages.delete(host);
            if (!host.isConnected || s.controllers.get(host) !== ctrl || !ctrl.layout) return;
            syncFlow(ctrl, deps.resolveLayout(ctrl));
            // Its container has another size: where the whole-pixel pass put it no longer holds.
            deps.snapAgain(ctrl);
        };
        host.addEventListener('load', settled, true);
        host.addEventListener('error', settled, true);
    }

    /** The kinds of slot of a card that can be asked about now; a card with a slot whose images are still loading is asked about that slot later. */
    function measurableKinds(ctrl: CardController, conf: LayoutSettings): Array<[HTMLElement, string]> {
        const kinds = slotKinds(ctrl, conf);
        const ready = kinds.filter(([slot]) => !imagesLoading(slot));
        if (ready.length < kinds.length) awaitImages(ctrl);
        return ready;
    }

    /** Whether the browser lays every slot of a card out in flow exactly as positioned, from what is remembered; null for a kind not asked about yet (flushAlike asks). */
    function laidOutAlike(ctrl: CardController, conf: LayoutSettings): boolean | null {
        let known = true;
        let differs = false;
        let kinds = '';
        for (const [, key] of slotKinds(ctrl, conf)) {
            kinds += `${key}\n`;
            const alike = s.flowAlike.get(key);
            if (alike === false) differs = true;
            if (alike === undefined) known = false;
        }
        ctrl.kinds = kinds;
        if (differs) return false;
        return known ? true : null;
    }

    // ── Layers of the page's making ────────────────────────────────────

    /**
     * A reader of an element's computed values that forces no layout: the typed style map where the browser has one
     * (`getComputedStyle` lays the page out to answer for a transform or an offset, whatever its value).
     */
    function styleReader(el: Element): ((property: string) => string) | null {
        try {
            if (typeof el.computedStyleMap === 'function') {
                const map = el.computedStyleMap();
                return (property) => {
                    // The map throws for a property the browser does not know (an older one without unprefixed
                    // mask-image or backdrop-filter): unknown is unset.
                    try {
                        const value = map.get(property);
                        return value === null || value === undefined ? '' : String(value);
                    } catch {
                        return '';
                    }
                };
            }
            const cs = getComputedStyle(el);
            return (property) => cs.getPropertyValue(property);
        } catch {
            return null;
        }
    }

    /**
     * Whether the page's CSS, read from a flow card's element, makes that element a layer of its own: positioned,
     * transformed, translucent, filtered, masked, isolated or given a stacking order other than its group's own. A
     * flow card paints such a box in another order than the positioned layout does. Reads styles only.
     */
    function layeredByPage(el: Element): boolean {
        const read = styleReader(el);
        if (!read) return false;
        const off = (property: string, none: string) => {
            const value = read(property);
            return !!value && value !== none;
        };
        if (off('position', 'static') || off('transform', 'none') || off('translate', 'none') || off('rotate', 'none') || off('scale', 'none')
            || off('opacity', '1') || off('filter', 'none') || off('backdrop-filter', 'none') || off('mix-blend-mode', 'normal')
            || off('clip-path', 'none') || off('mask-image', 'none') || off('perspective', 'none') || off('will-change', 'auto')
            || off('isolation', 'auto') || /paint|layout|strict|content/.test(read('contain') || '')) return true;
        const z = read('z-index');
        return !!z && z !== 'auto' && z !== OWN_Z_INDEX[el.classList[0] ?? ''];
    }

    /** Slots and what they hold, with the stamp they were inspected under (layeredFlow). */
    const inspected = new WeakMap<Element, string>();
    /** Hosts due another look once their slots have faded back. */
    const inspectTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

    /**
     * Whether anything on a flow card is a layer of the page's making (layeredByPage). Looks only at the slots and
     * group nodes it has not seen as they are (a node is seen again when it gains or loses elements, as the fitting
     * pass's "+N" does), and asks the styles once per kind of element: the card's context, the slot, the group, the
     * chip it is part of, its tag and classes. On a settled page that is a map lookup per new element.
     * @param read - Read the styles of kinds not seen yet. The host must then be marked for flow and not live, so the
     *   styles read are a flow card's. False (a card being drawn, or one being decided from what is remembered):
     *   nothing is read, and a kind not seen yet makes the answer null.
     * @param fresh - Receives the keys of the kinds not seen yet.
     */
    function layeredFlow(ctrl: CardController, conf: LayoutSettings, read: boolean, fresh?: Set<string>): boolean | null {
        const host = ctrl.host;
        let context = '';
        let unknown = false;
        /**
         * @param where - Slot, group and enclosing chip.
         * @param passing - The element is in a passing state of JE's own (a fading slot): never read, and not offered
         *   to the idle pass as the one to read its kind from.
         * @returns False when its kind has not been seen and is not read now.
         */
        const look = (el: Element, where: string, passing = false): boolean => {
            if (!context) context = flowContext(ctrl, conf);
            const key = `${context}|${where}|${el.tagName}|${classOf(el)}`;
            let layered = s.flowVerdicts.get(key);
            if (layered === undefined) {
                if (!read || passing) {
                    unknown = true;
                    if (fresh && !passing) fresh.add(key);
                    return false;
                }
                layered = layeredByPage(el);
                s.flowVerdicts.set(key, layered);
                s.flowCounters.inspections++;
            }
            if (layered && el instanceof HTMLElement) ctrl.layered.add(el);
            return true;
        };
        // Hide Tags on Hover fades the slots of the card under the pointer: an opacity read then is JE's own and
        // passing, and would be remembered against every card of the kind. (Told from where the pointer is and was:
        // asking a slot for its animations lays the page out.)
        const hides = deps.hidesOnHover(host);
        let hovered = false;
        if (hides) { try { hovered = !!host.closest('.card, .listItem')?.matches(':hover'); } catch { hovered = false; } }
        const easingBack = hides && !hovered && s.lastLeft.host === host && performance.now() - s.lastLeft.at < REST_AFTER_MS;
        let fading = false;
        for (const child of host.children) {
            if (!child.classList.contains('je-tag-slot') || !(child instanceof HTMLElement)) continue;
            const slot = child.dataset.jeSlot || '';
            if (inspected.get(child) !== `${s.flowEpoch}`) {
                // Another card of the kind answers for a fading slot; with none, it is read once the pointer has gone.
                if (look(child, `${slot}|slot`, hovered || easingBack)) inspected.set(child, `${s.flowEpoch}`);
                else if (hovered || easingBack) fading = true;
            }
            for (const node of child.children) {
                const parts = node.getElementsByTagName('*');
                const stamp = `${s.flowEpoch}:${parts.length}`;
                if (inspected.get(node) === stamp) continue;
                const group = (node instanceof HTMLElement ? node.dataset.jeGroup : '') || classOf(node);
                let seen = look(node, `${slot}|${group}`);
                for (const part of Array.from(parts)) {
                    // A genre's floating name is JE's own (left out of a resting card); the inside of an inline SVG paints with it.
                    if (part.namespaceURI !== 'http://www.w3.org/1999/xhtml' && part.localName !== 'svg') continue;
                    if (part.classList.contains('genre-text')) continue;
                    // The chip it belongs to: a rule can tell `.rating-tag-critic .rating-text` from another chip's.
                    let chip: Element = part;
                    while (chip.parentElement && chip.parentElement !== node) chip = chip.parentElement;
                    if (!look(part, `${slot}|${group}|${chip === part ? '' : classOf(chip)}`)) seen = false;
                }
                if (seen) inspected.set(node, stamp);
            }
        }
        if (fading) inspectLater(ctrl, hovered);
        if (ctrl.layered.size > 0) return true;
        return unknown ? null : false;
    }

    /**
     * Inspect a card's slots once they are no longer fading: after the pointer has left the card (the pointerout
     * handler), or shortly, when it already has and the slots are easing back.
     */
    function inspectLater(ctrl: CardController, hovered: boolean): void {
        const host = ctrl.host;
        if (hovered) { s.uninspected.add(host); return; }
        if (inspectTimers.has(host)) return;
        inspectTimers.set(host, setTimeout(() => {
            inspectTimers.delete(host);
            if (host.isConnected && s.controllers.get(host) === ctrl && ctrl.layout) syncFlow(ctrl, deps.resolveLayout(ctrl));
        }, REST_AFTER_MS));
    }

    /**
     * Whether a card may rest in flow, from what is remembered: nothing is read from the page. Null when the page has
     * to be asked first (its switch, how it shows genre names, a kind of slot or of element not seen yet); flushAlike
     * asks in idle time. A card that is hovered or focused when its tags arrive is live at once (and is inspected
     * once it rests).
     */
    function decideFlow(ctrl: CardController, conf: LayoutSettings): boolean | null {
        const host = ctrl.host;
        const alike = laidOutAlike(ctrl, conf);
        const eligible = flowFor(ctrl, conf, false);
        if (eligible !== true) return eligible;
        // What the page layered last time and is still on the card keeps it positioned, with nothing to re-read.
        for (const el of ctrl.layered) if (!host.contains(el)) ctrl.layered.delete(el);
        if (ctrl.layered.size > 0) return false;
        if (alike !== true) return alike;
        if (!host.dataset.jeLive && deps.notAtRest(host)) host.dataset.jeLive = '1';
        // A live mark nothing will take off: the card was removed while focused and put back.
        else if (host.dataset.jeLive && !s.restTimers.has(host) && s.lingering !== host && !deps.notAtRest(host)) delete host.dataset.jeLive;
        if (host.dataset.jeLive) return true;
        const layered = layeredFlow(ctrl, conf, false);
        return layered === null ? null : !layered;
    }

    /**
     * Put the resting flow mark on a card's host or take it off.
     * @param measure - The idle pass is settling the card's resting layout: its whole-pixel nudges are measured again
     *   as it then lies (the two layouts agree to within what the comparison allows, which is more than a layout
     *   unit). Not for a card that changes layout for a moment under the pointer or focus: that would read its layout
     *   on every hover.
     */
    function markFlow(ctrl: CardController, flow: boolean, measure = false): void {
        const host = ctrl.host;
        if (flow !== (host.dataset.jeFlow === '1')) {
            if (flow) host.dataset.jeFlow = '1';
            else delete host.dataset.jeFlow;
            if (measure && deps.snapSupported()) s.pendingSnap.add(ctrl);
        }
        if (flow) ctrl.flowKinds = ctrl.kinds;
    }

    /**
     * Mark (or unmark) a card's host for the resting flow rules, after its groups were placed or removed. This runs
     * while the card is being drawn, so it reads nothing from the page: a card of kinds already answered is marked or
     * left positioned at once, and any other stays positioned, as every card always was, until the idle pass has
     * asked the page (flushAlike). A card resting in flow that holds what it held when it was let in keeps its layout
     * while it is asked about again (only the answers were forgotten: a style sheet came, the width changed), instead
     * of being laid out twice to get back there.
     */
    function syncFlow(ctrl: CardController, conf: LayoutSettings): void {
        const host = ctrl.host;
        noteSheets();
        const flow = decideFlow(ctrl, conf);
        if (flow !== null) {
            markFlow(ctrl, flow);
            return;
        }
        deps.queueFlow(ctrl);
        if (host.dataset.jeFlow === '1' && ctrl.flowKinds === ctrl.kinds) return;
        markFlow(ctrl, false);
    }

    return {
        forgetPageCss, flowFor, syncFlow, decideFlow, markFlow, layeredFlow, measurableKinds, awaitSize, awaitImages,
        imagesLoading, queueReprobe, inspectLater,
    };
}
