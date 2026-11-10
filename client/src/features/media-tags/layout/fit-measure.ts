import * as rules from './layout-rules';
import { centreRowLimit, chipsThatFit, FIT_MAX_ROWS, rowBudget, rowsHeight, shapeOfSize } from './layout-fitting';
import { EDGE_SPACINGS, TAG_GAPS, TAG_SCALES } from './layout-rules';
import type { CardController, LayoutHost } from './layout-runtime-types';
import { childrenOf, type FitPlan, type FitRow, INDICATOR_BEFORE, type LayoutFns, type LayoutState, STACK_INSET, STACK_LIFT } from './state';

const NARROW_CARD_PX = 160;
const SAME_WIDTH_PX = 0.01;

/**
 * Fit scheduling and measurement: rows, anchors, stacks, corner lift and indicator gaps, read in one pass.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createFitMeasure(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    // ── Fitting ────────────────────────────────────────────────────────
    // What fits on a card depends on its rendered size, which only the
    // browser knows. After cards are presented, one pass after the next
    // paint measures every card queued by then — reads and writes batched
    // across the page to avoid a layout per card — and hides what does not
    // fit, never half a chip or fact:
    //   - the summary pill's lowest-priority facts;
    //   - in the caption strip, the bottom band and the hover reveal, chips
    //     past their two rows (fewer when the reveal's share of the card
    //     height has room for less), lowest priority first, behind a "+N"
    //     chip whose title names them;
    //   - centre anchors' whole chips, in at most two rows or one side column,
    //     within budgets measured between occupied corners and Jellyfin
    //     overlays, with omitted chips counted in "+N".
    // It also switches bands on cards narrower than NARROW_CARD_PX to compact
    // labels. The four original corner stacks keep their geometry, except a
    // card saved before layouts with an exact top-right container below
    // another container: the indicator offset depends on the measured height
    // of the containers above it (indicatorGapsToMeasure).
    function holdsGroups(slotEl: Element) {
        return childrenOf(slotEl).some((c) => !!((c).dataset.jeGroup));
    }

    function moreChipOf(slotEl: HTMLElement) {
        const last = slotEl.lastElementChild;
        return last instanceof HTMLElement && last.classList.contains('je-tag-more') ? (last) : null;
    }

    function rowSlots(ctrl: CardController) {
        const slots = [];
        if (ctrl.outlet && ctrl.outlet.isConnected)
            slots.push(ctrl.outlet);
        const wrapping = ctrl.layout === 'bands' ? 'bottom' : 'hover';
        for (const child of childrenOf(ctrl.host)) {
            if (child.classList.contains('je-tag-slot') && ((child).dataset.jeSlot === wrapping
                || (ctrl.layout === 'corners' && s.CENTRE_SLOTS.has((child).dataset.jeSlot || '')))) {
                slots.push((child));
            }
        }
        return slots;
    }

    function posterStack(ctrl: CardController) {
        const slot = ctrl.layout === 'caption' ? ctrl.host.querySelector<HTMLElement>(':scope > .je-tag-slot[data-je-slot="poster"]') : null;
        return slot ? [(slot)] : [];
    }

    function slotChips(slotEl: HTMLElement) {
        const chips = [];
        for (const child of childrenOf(slotEl)) {
            if ((child).dataset.jeGroup)
                chips.push(...(childrenOf(child)));
        }
        return chips;
    }

    function chipLabel(chip: HTMLElement) {
        return chip.getAttribute('title') || chip.getAttribute('alt')
            || chip.querySelector<HTMLElement>('.rating-text')?.textContent?.trim()
            || (chip.textContent || '').trim();
    }

    function rowWidth(slotEl: HTMLElement, style: CSSStyleDeclaration) {
        const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const width = parseFloat(style.width);
        if (!Number.isFinite(width))
            return slotEl.clientWidth - pad;
        return style.boxSizing === 'border-box'
            ? width - pad - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0)
            : width;
    }

    function indicatorGapsToMeasure(ctrl: CardController) {
        if (ctrl.layout !== 'corners' || ctrl.host.dataset.jeLegacy !== '1')
            return null;
        for (const child of childrenOf(ctrl.host)) {
            const slot = (child);
            if (!slot.classList.contains('je-tag-slot') || slot.dataset.jeSlot !== 'tr')
                continue;
            const items = (childrenOf(slot));
            const needs = items.some((el, i) => !!el.dataset.jeIndicatorGap
                && ((i > 0 && !items[i - 1]?.dataset.jeIndicatorGap) || !!el.style.getPropertyValue(INDICATOR_BEFORE)));
            return needs ? slot : null;
        }
        return null;
    }

    function needsShape(ctrl: CardController) {
        return deps.shapeOfCard(ctrl.host) === null && deps.shapesInUse();
    }

    function scheduleFit(ctrl: CardController) {
        if (s.fitting || !(s.FIT_LAYOUTS.has(ctrl.layout || '') || centreSlots(ctrl).length || cornerLanguageGroups(ctrl).length || indicatorGapsToMeasure(ctrl) || needsShape(ctrl) || needsRadius(ctrl)))
            return;
        s.pendingFit.add(ctrl);
        watchSize(ctrl.host);
        if (s.fitScheduled)
            return;
        s.fitScheduled = true;
        if (typeof JE.core.dom?.afterNextPaint === 'function')
            JE.core.dom.afterNextPaint(flushFit);
        else
            requestAnimationFrame(flushFit);
    }

    const fittedWidths: WeakMap<HTMLElement, {
        observed: number;
        observedHeight: number;
        fitted: number;
        fittedHeight: number;
        measured: {
            width: number;
            height: number;
        } | null;
    }> = new WeakMap();

    function watchSize(host: HTMLElement) {
        if (typeof ResizeObserver !== 'function' || fittedWidths.has(host))
            return;
        s.sizeObserver ??= new ResizeObserver(refitOnSizeChange);
        fittedWidths.set(host, { observed: -1, observedHeight: -1, fitted: -1, fittedHeight: -1, measured: null });
        s.sizeObserver.observe(host);
    }

    function unwatchSize(host: HTMLElement) {
        if (!fittedWidths.has(host))
            return;
        fittedWidths.delete(host);
        s.sizeObserver?.unobserve(host);
    }

    function refitOnSizeChange(entries: ResizeObserverEntry[]) {
        for (const entry of entries) {
            const host = entry.target;
            if (!(host instanceof HTMLElement))
                continue;
            const ctrl = s.controllers.get(host);
            const sizes = fittedWidths.get(host);
            if (!ctrl || !sizes || !host.isConnected) {
                unwatchSize(host);
                continue;
            }
            const width = entry.contentRect.width;
            const height = entry.contentRect.height;
            if (width <= 0)
                continue;
            sizes.observed = width;
            sizes.observedHeight = height;
            // The first observation reports the size the queued fit is about to use.
            if (sizes.fitted < 0) {
                sizes.fitted = width;
                sizes.fittedHeight = height;
                continue;
            }
            // The change the last pass already measured and fitted (in whole pixels).
            const measured = sizes.measured;
            sizes.measured = null;
            if (measured && Math.abs(width - measured.width) < 1 && Math.abs(height - measured.height) < 1) {
                sizes.fitted = width;
                sizes.fittedHeight = height;
                continue;
            }
            if (Math.abs(width - sizes.fitted) < SAME_WIDTH_PX && Math.abs(height - sizes.fittedHeight) < SAME_WIDTH_PX)
                continue;
            scheduleFit(ctrl);
        }
    }

    function edgeOf(ctrl: CardController) {
        const edge = ctrl.layout === 'corners' ? ctrl.host.dataset.jeEdge : undefined;
        return (edge && rules.hasOwn(EDGE_SPACINGS, edge) ? EDGE_SPACINGS[edge] : EDGE_SPACINGS.default) ?? 6;
    }

    function needsRadius(ctrl: CardController) {
        return ctrl.host.dataset.jeEdge === 'flush' && !ctrl.host.style.getPropertyValue('--je-card-radius');
    }

    function cardRadiusOf(ctrl: CardController) {
        const parent = ctrl.host.parentElement;
        const art = (parent?.classList.contains('cardScalable') && parent.querySelector<HTMLElement>('.cardImageContainer')) || parent;
        if (!art)
            return '0px';
        const style = getComputedStyle(art);
        return style.borderTopLeftRadius || style.borderRadius.split(' ')[0] || '0px';
    }

    function flushFit() {
        s.fitScheduled = false;
        const list = Array.from(s.pendingFit).filter((c) => c.host.isConnected && s.controllers.get(c.host) === c);
        s.pendingFit.clear();
        if (list.length === 0)
            return;
        s.fitting = true;
        try {
            // Reads: cards not laid out (hidden, detached tab) are left as they
            // are. The image's height shapes only cards whose shape is measured.
            const widths = list.map((ctrl) => ctrl.host.clientWidth);
            const hostHeights = list.map((ctrl, i) => ((widths[i] ?? 0) > 0 ? ctrl.host.clientHeight : 0));
            // The size this pass fits at, in the observer's units: its latest observation
            // (delivered before this pass's paint), or 0 for a card left unfitted.
            list.forEach((ctrl, i) => {
                const sizes = fittedWidths.get(ctrl.host);
                if (!sizes)
                    return;
                sizes.fitted = (widths[i] ?? 0) > 0 ? sizes.observed : 0;
                sizes.fittedHeight = (widths[i] ?? 0) > 0 ? sizes.observedHeight : 0;
                // Changed after the frame observed it: the next observation is this pass's size.
                const moved = (widths[i] ?? 0) > 0 && sizes.observed >= 0
                    && (Math.abs((widths[i] ?? 0) - sizes.observed) >= 1 || Math.abs((hostHeights[i] ?? 0) - sizes.observedHeight) >= 1);
                sizes.measured = moved ? { width: (widths[i] ?? 0), height: (hostHeights[i] ?? 0) } : null;
            });
            const heights = list.map((ctrl, i) => (needsShape(ctrl) ? (hostHeights[i] ?? 0) : 0));
            const radii = list.map((ctrl, i) => ((widths[i] ?? 0) > 0 && needsRadius(ctrl) ? cardRadiusOf(ctrl) : null));
            const shown = list.filter((ctrl, i) => (widths[i] ?? 0) > 0);
            // Writes: a card whose shape was measured is presented in its
            // shape's look (one not laid out as a portrait, measured again
            // next time); bands that crossed the narrow-card width re-present
            // with the other labels; then show what an earlier pass hid, and
            // give every wrapping slot its "+N" chip, so both are measured afresh.
            const presented = new Set();
            const narrowed = new Set<CardController>();
            list.forEach((ctrl, i) => {
                const narrow = (widths[i] ?? 0) > 0 && (widths[i] ?? 0) < NARROW_CARD_PX;
                if ((widths[i] ?? 0) === 0 || narrow === !!ctrl.narrow)
                    return;
                ctrl.narrow = narrow;
                narrowed.add(ctrl);
            });
            list.forEach((ctrl, i) => {
                if (!needsShape(ctrl))
                    return;
                const shape = (widths[i] ?? 0) > 0 ? shapeOfSize((widths[i] ?? 0), (heights[i] ?? 0)) : 'portrait';
                const changed = shape !== ctrl.shape;
                ctrl.shape = shape;
                if (changed) {
                    deps.presentAll(ctrl);
                    presented.add(ctrl);
                }
            });
            for (const ctrl of narrowed) {
                if (ctrl.layout === 'bands' && !presented.has(ctrl))
                    deps.presentAll(ctrl);
            }
            list.forEach((ctrl, i) => { if (typeof radii[i] === 'string')
                ctrl.host.style.setProperty('--je-card-radius', radii[i]); });
            for (const ctrl of shown)
                prepareFit(ctrl);
            // Language columns yield whole chips before centre budgets are read,
            // keeping a full rating value or a readable overflow chip beside them.
            const languages = shown.map(measureCornerLanguages);
            languages.forEach(deps.applyChipRows);
            // Read every occupied corner before writing centre-anchor budgets.
            const anchors = shown.map(measureAnchors);
            shown.forEach((ctrl, i) => applyAnchors(anchors[i] || []));
            // Reads, then writes.
            const plans = shown.map((ctrl, i) => {
                const plan = measureFit(ctrl);
                plan.rows.unshift(...(languages[i] || []));
                return plan;
            });
            shown.forEach((ctrl, i) => plans[i] && deps.applyFit(ctrl, plans[i]));
        }
        finally {
            s.fitting = false;
        }
        // Genre names asked for while this pass was pending, and those of revealed
        // cards it changed, are bounded against the fitted chips.
        const bound = new Set(s.genreAfterFit);
        s.genreAfterFit.clear();
        for (const ctrl of list)
            if (ctrl.host.dataset.jeGenreBound && deps.isRevealed(ctrl.host))
                bound.add(ctrl.host);
        for (const host of bound)
            if (host.isConnected)
                deps.fitReveal(host);
    }

    function centreSlots(ctrl: CardController) {
        return ctrl.layout === 'corners' ? childrenOf(ctrl.host).filter((el) => s.CENTRE_SLOTS.has((el).dataset.jeSlot || '')) : [];
    }

    function measureAnchors(ctrl: CardController) {
        const centres = centreSlots(ctrl);
        if (!centres.length)
            return [];
        const conf = deps.resolveLayout(ctrl);
        const gap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
        const edge = edgeOf(ctrl);
        const host = ctrl.host.getBoundingClientRect();
        const boxes: Record<string, DOMRect[]> = {};
        for (const el of childrenOf(ctrl.host)) {
            const slot = (el).dataset.jeSlot;
            if (!['tl', 'tr', 'bl', 'br'].includes(slot || ''))
                continue;
            boxes[slot || ''] = childrenOf(el).filter((g) => (g).dataset.jeGroup).map((g) => g.getBoundingClientRect());
        }
        const width = (slots: string[]) => Math.max(edge, ...slots.flatMap((s) => (boxes[s] || []).map((b) => s.endsWith('l') ? b.right - host.left + gap : host.right - b.left + gap)));
        const height = (slots: string[]) => Math.max(edge, ...slots.flatMap((s) => (boxes[s] || []).map((b) => s.startsWith('t') ? b.bottom - host.top + gap : host.bottom - b.top + gap)));
        const scalable = ctrl.host.parentElement;
        const progress = scalable?.querySelector<HTMLElement>('.itemProgressBar, .cardProgressBar, .cardProgress');
        const flush = conf.edge === 'flush';
        const bottom = progress ? Math.max(edge, host.bottom - progress.getBoundingClientRect().top + (flush ? 0 : gap)) : edge;
        let top = edge;
        const cornerReserve = width(['tl', 'tr']);
        let topReserve = cornerReserve;
        let overlayBottom = 0;
        for (const overlay of scalable?.querySelectorAll<HTMLElement>('.cardIndicators > *, .countIndicator, .playedIndicator') || []) {
            // Jellyfin sometimes wraps a tiny indicator in a full-width box.
            // Its leaf supplies the actual obstruction, rather than that box.
            if (flush && overlay.querySelector<HTMLElement>('.countIndicator, .playedIndicator'))
                continue;
            const b = overlay.getBoundingClientRect();
            if (flush && (!b.width || !b.height))
                continue;
            if (b.bottom <= host.top || b.top >= host.top + host.height / 3)
                continue;
            overlayBottom = Math.max(overlayBottom, b.bottom - host.top + gap);
            const middle = host.left + host.width / 2;
            if (b.left < middle && b.right > middle)
                top = Math.max(top, b.bottom - host.top + gap);
            else
                topReserve = Math.max(topReserve, b.right <= middle ? b.right - host.left + gap : host.right - b.left + gap);
        }
        if (flush) {
            const row = centres.find(el => el.dataset.jeSlot === 'tc');
            const first = row && slotChips(row)[0];
            const firstWidth = first?.getBoundingClientRect().width || 0;
            // Prefer the gap between corner indicators. Only a first chip that
            // cannot fit there moves below the obstructions and gets full width.
            if (top > 0 || firstWidth > host.width - 2 * topReserve + 0.01) {
                // Below them only while the row stays in the image's top half
                // (a short image has no room there): else it keeps its place.
                const below = Math.max(overlayBottom, height(['tl', 'tr']));
                if (below + (first?.getBoundingClientRect().height || 0) <= host.height / 2 + 0.01) {
                    top = below;
                    topReserve = 0;
                }
            }
            else
                top = 0;
        }
        // On a short image a tall column of the other edge (languages
        // bottom-left, a status column top-right) reaches into a centre row's
        // band: the row keeps clear of it too.
        const crossing = (slots: string[], from: number, to: number) => Math.max(0, ...slots.flatMap((s) => (boxes[s] || [])
            .filter((b) => b.bottom - host.top > from && b.top - host.top < to)
            .map((b) => s.endsWith('l') ? b.right - host.left + gap : host.right - b.left + gap)));
        const topRow = top + centreRowLimit(host.height, top);
        const bottomRow = host.height - bottom - centreRowLimit(host.height, bottom);
        topReserve = Math.max(topReserve, crossing(['bl', 'br'], top, topRow));
        const bottomReserve = Math.max(width(['bl', 'br']), crossing(['tl', 'tr'], bottomRow, host.height - bottom));
        return centres.map((el) => {
            const slot = el.dataset.jeSlot;
            return { el, top, bottom, reserve: slot === 'tc' ? topReserve : slot === 'bc' ? bottomReserve : slot === 'ml' ? height(['tl', 'bl']) : slot === 'mr' ? height(['tr', 'br']) : edge };
        });
    }

    function applyAnchors(anchors: ReturnType<typeof measureAnchors>) {
        for (const { el, reserve, top, bottom } of anchors) {
            el.style.setProperty('--je-anchor-reserve', `${reserve}px`);
            el.style.setProperty('--je-anchor-top', `${top}px`);
            el.style.setProperty('--je-anchor-bottom', `${bottom}px`);
            el.toggleAttribute('data-je-flush-detached', el.dataset.jeSlot === 'tc' && top > 0);
        }
    }

    function cornerLanguageGroups(ctrl: CardController) {
        return ctrl.layout === 'corners' ? Array.from(ctrl.host.querySelectorAll<HTMLElement>(':scope > .je-tag-slot:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"]) > [data-je-group="language"]'))
            .filter(group => group.querySelector<HTMLElement>('.language-chip') && childrenOf(ctrl.host)
            .some(slot => slot.dataset.jeSlot === ((group.parentElement?.dataset.jeSlot || '').startsWith('t') ? 'tc' : 'bc') && slot.querySelector<HTMLElement>('.rating-tag'))) : [];
    }

    function measureCornerLanguages(ctrl: CardController) {
        const rows: FitRow[] = [];
        const conf = deps.resolveLayout(ctrl);
        const gap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
        const inner = Math.max(0, ctrl.host.clientWidth - 2 * edgeOf(ctrl));
        for (const group of cornerLanguageGroups(ctrl)) {
            const slot = group.parentElement?.dataset.jeSlot || '';
            const centre = childrenOf(ctrl.host).find(el => el.dataset.jeSlot === (slot.startsWith('t') ? 'tc' : 'bc'));
            const rating = centre?.querySelector<HTMLElement>('.rating-tag');
            const centreMore = centre && moreChipOf(centre);
            const more = moreChipOf(group);
            if (!rating || !centreMore || !more)
                continue;
            const chips = childrenOf(group).filter(chip => chip !== more);
            if (!chips.length)
                continue;
            const rects = chips.map(chip => chip.getBoundingClientRect());
            const ratingWidth = rating.getBoundingClientRect().width;
            const moreRect = more.getBoundingClientRect();
            const languageMinimum = Math.max((rects[0]?.width || 0), chips.length > 1 ? moreRect.width : 0);
            const fullRoom = (inner - ratingWidth) / 2 - gap;
            const minimum = languageMinimum <= fullRoom ? Math.max(ratingWidth, centreMore.getBoundingClientRect().width) : centreMore.getBoundingClientRect().width;
            const available = Math.max((rects[0]?.width || 0), (inner - minimum) / 2 - gap);
            const height = ctrl.host.clientHeight * 0.9;
            const rowGap = parseFloat(getComputedStyle(group).rowGap) || 0;
            const shown = chipsThatFit(rects.map((rect, i) => i === 0 || rect.width <= available + 0.01 ? rect.height : Infinity), height, rowGap, 1, moreRect.height);
            shown[0] = true;
            rows.push({ slot: group, chips, shown, more: moreRect.width <= available + 0.01 && (rects[0]?.height || 0) + rowGap + moreRect.height <= height });
        }
        return rows;
    }

    function prepareFit(ctrl: CardController) {
        ctrl.host.querySelector<HTMLElement>(':scope > .je-tag-slot[data-je-slot="corner"]')?.style.removeProperty(STACK_LIFT);
        for (const root of [ctrl.host, ctrl.outlet]) {
            root?.querySelectorAll<HTMLElement>('[data-je-overflow]').forEach((el) => el.removeAttribute('data-je-overflow'));
            // Restore the intrinsic markup before any measurements.
            root?.querySelectorAll<HTMLElement>('.je-tag-fit-text').forEach((text) => text.replaceWith(...text.childNodes));
            root?.querySelectorAll<HTMLElement>('[data-je-fit-width]').forEach((el) => {
                el.removeAttribute('data-je-fit-width');
                el.style.removeProperty('--je-chip-fit-width');
            });
        }
        const languages = cornerLanguageGroups(ctrl);
        for (const slotEl of [...rowSlots(ctrl), ...languages, ...posterStack(ctrl)]) {
            const count = languages.includes(slotEl) ? childrenOf(slotEl).filter(el => !el.classList.contains('je-tag-more')).length : slotChips(slotEl).length;
            let more = moreChipOf(slotEl) || slotEl.querySelector<HTMLElement>(':scope > .je-tag-more');
            if (count === 0) {
                more?.remove();
                continue;
            }
            if (!more) {
                more = document.createElement('span');
                more.className = 'je-tag-more';
            }
            if (more !== slotEl.lastElementChild)
                slotEl.appendChild(more);
            const text = `+${count}`;
            if (more.textContent !== text)
                more.textContent = text;
        }
    }

    function rowRoom(ctrl: CardController, style: CSSStyleDeclaration, slotEl: HTMLElement) {
        const raw = style.maxHeight;
        if (slotEl === ctrl.outlet) {
            const height = parseFloat(style.height);
            return height > 0 ? { inside: height, oneRow: height, gap: parseFloat(style.rowGap) || 0 } : null;
        }
        if (!raw || raw === 'none')
            return ctrl.layout === 'bands' && slotEl.dataset.jeSlot === 'bottom' ? bandRoom(ctrl, style) : null;
        let limit = parseFloat(raw);
        if (raw.endsWith('%')) {
            // The slot is positioned in the host, which covers the image.
            const height = ctrl.host.clientHeight;
            if (!(height > 0))
                return null;
            limit = (limit / 100) * height;
        }
        if (!Number.isFinite(limit))
            return null;
        const padTop = parseFloat(style.paddingTop) || 0;
        const padBottom = parseFloat(style.paddingBottom) || 0;
        return { inside: limit - padTop - padBottom, oneRow: limit - padBottom, gap: parseFloat(style.rowGap) || 0 };
    }

    function bandRoom(ctrl: CardController, style: CSSStyleDeclaration) {
        const height = ctrl.host.clientHeight;
        const top = ctrl.host.querySelector<HTMLElement>(':scope > .je-tag-slot[data-je-slot="top"]');
        const bottoms = Array.from(top?.querySelectorAll<HTMLElement>(':scope > [data-je-group] > *') || [])
            .map((chip) => chip.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.bottom);
        if (!(height > 0) || !bottoms.length)
            return null;
        const below = Math.max(...bottoms) - ctrl.host.getBoundingClientRect().top;
        const gap = parseFloat(style.rowGap) || 0;
        const inside = height - (parseFloat(style.paddingBottom) || 0) - below - gap;
        return { inside, oneRow: inside, gap };
    }

    function measureFit(ctrl: CardController) {
        const plan: FitPlan = { pillFacts: ctrl.pill ? pillFactsThatFit(ctrl.pill) : -1, rows: measurePosterStack(ctrl), indicator: measureIndicatorGaps(ctrl), stacks: measureStacks(ctrl), lift: measureCornerLift(ctrl) };
        const slots = rowSlots(ctrl);
        const sides = new Map(slots.filter(el => ['ml', 'mr'].includes(el.dataset.jeSlot || ''))
            .map(el => [el.dataset.jeSlot, slotChips(el).map(chip => chip.getBoundingClientRect())]));
        const conf = deps.resolveLayout(ctrl);
        // Only rows sharing the corner-language reservation path require whole
        // ratings. Cards without boxed language columns keep first-chip fitting.
        const mixedRatingSlots = new Set<string>(cornerLanguageGroups(ctrl).map(group => (group.parentElement?.dataset.jeSlot || '').startsWith('t') ? 'tc' : 'bc'));
        const innerWidth = sides.size ? Math.max(0, ctrl.host.clientWidth - 2 * edgeOf(ctrl)) : 0;
        const sideGap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
        const half = Math.max(0, (innerWidth - sideGap) / 2);
        for (const slotEl of slots) {
            const chips = slotChips(slotEl);
            const more = moreChipOf(slotEl);
            if (chips.length === 0 || !more)
                continue;
            const style = getComputedStyle(slotEl);
            const vertical = ctrl.layout === 'corners' && ['ml', 'mr'].includes(slotEl.dataset.jeSlot || '');
            const opposite = sides.get(slotEl.dataset.jeSlot === 'ml' ? 'mr' : 'ml') || [];
            const oppositeWidth = Math.min(half, Math.max(0, ...opposite.map(rect => rect.width)));
            // Side budgets come from the host, never the column's content width:
            // a previous +N chip must not shrink the next measurement's budget.
            const available = vertical ? Math.max(0, Math.min(opposite.length ? half : innerWidth, innerWidth - oppositeWidth - sideGap))
                : rowWidth(slotEl, style);
            const gap = parseFloat(style.columnGap) || 0;
            // Centre chips are unconstrained by CSS, so these batched reads
            // measure their intrinsic widths, including padding and borders.
            const rects = chips.map((chip) => chip.getBoundingClientRect());
            const widths = rects.map((r) => r.width);
            const moreRect = more.getBoundingClientRect();
            if (!(available > 0) && ctrl.layout !== 'corners') {
                plan.rows.push({ slot: slotEl, chips, shown: chips.map(() => true), more: true });
                continue;
            }
            if (ctrl.layout === 'corners') {
                const measured = parseFloat(slotEl.style.getPropertyValue('--je-anchor-reserve'));
                const reserve = Number.isFinite(measured) ? measured : edgeOf(ctrl);
                const offset = parseFloat(slotEl.style.getPropertyValue(slotEl.dataset.jeSlot === 'tc' ? '--je-anchor-top' : '--je-anchor-bottom'));
                const limit = Math.max(0, vertical ? ctrl.host.clientHeight - 2 * reserve
                    : ['tc', 'bc'].includes(slotEl.dataset.jeSlot || '') ? centreRowLimit(ctrl.host.clientHeight, Number.isFinite(offset) ? offset : reserve)
                        : ctrl.host.clientHeight / 3);
                if (!vertical && ctrl.host.clientHeight > 0 && available < moreRect.width - 0.01) {
                    // No room between the corner stacks even for "+N" (a short
                    // image crowded with tags): the row is left out, its facts
                    // stay in the card's description.
                    plan.rows.push({ slot: slotEl, chips, shown: chips.map(() => false), more: false });
                    continue;
                }
                const heights = rects.map((r) => r.height);
                const rowGap = parseFloat(style.rowGap) || 0;
                let shown = null;
                let fittedRows: number[] = [];
                let fittedMoreRow = 0;
                const ratingFirst = mixedRatingSlots.has(slotEl.dataset.jeSlot || '') && !!chips[0]?.matches('.rating-tag');
                const fitWidths = widths.map((width, i) => i === 0 && !ratingFirst ? Math.min(width, Math.max(0, available)) : width);
                if (vertical) {
                    // Keep the first label (ellipsized if necessary); later chips
                    // still need both height and width to be shown whole.
                    shown = chipsThatFit(heights.map((height, i) => (fitWidths[i] ?? 0) <= available + 0.01 ? height : Infinity), limit, rowGap, 1, moreRect.height);
                }
                else {
                    // The rows the height has room for, then chips in priority order until one no longer fits.
                    const rows: number[] = [], moreRow = { row: 0 };
                    const budget = rowBudget(heights, moreRect.height, limit, rowGap);
                    if (budget > 0) {
                        shown = chipsThatFit(fitWidths, available, gap, budget, moreRect.width, rows, moreRow);
                        fittedRows = rows;
                        fittedMoreRow = moreRow.row;
                    }
                }
                if (!shown?.[0] && !ratingFirst) {
                    // An anchor always tells the user at least its first fact.
                    // +N counts only later chips, and is omitted without room.
                    shown = chips.map((_, i) => i === 0);
                    fittedRows = chips.map((_, i) => i === 0 ? 1 : 0);
                    fittedMoreRow = 2;
                }
                if (!shown)
                    shown = chips.map(() => false);
                const moreFits = vertical ? (shown.some(Boolean) ? (heights[0] ?? 0) + rowGap : 0) + moreRect.height <= limit
                    : rowsHeight(shown, fittedRows, heights, moreRect.height, rowGap, fittedMoreRow) <= limit;
                plan.rows.push({ slot: slotEl, chips, shown, fittedRows, fittedMoreRow,
                    width: vertical ? available : undefined, firstWidth: !ratingFirst && (widths[0] ?? 0) > available ? Math.max(0, available) : undefined,
                    more: moreFits && limit >= moreRect.height && available >= moreRect.width });
                continue;
            }
            const room = rowRoom(ctrl, style, slotEl);
            if (!room) {
                plan.rows.push({ slot: slotEl, chips, shown: chipsThatFit(widths, available, gap, FIT_MAX_ROWS, moreRect.width), more: true });
                continue;
            }
            // As many whole rows as the height has room for, "+N" included, then chips in
            // priority order until one no longer fits. A slot with room for only one row in
            // its padding (a short hover reveal) uses that row.
            const heights = rects.map((r) => r.height);
            let budget = rowBudget(heights, moreRect.height, room.inside, room.gap);
            if (budget === 0 && Math.max(moreRect.height, ...heights) <= room.oneRow + 0.01)
                budget = 1;
            const shown = chipsThatFit(widths, available, gap, budget, moreRect.width);
            plan.rows.push(budget > 0
                ? { slot: slotEl, chips, shown, more: true }
                : { slot: slotEl, chips, shown: chips.map(() => false), more: false });
        }
        return plan;
    }

    function measurePosterStack(ctrl: CardController): FitRow[] {
        const slot = posterStack(ctrl)[0];
        const more = slot && moreChipOf(slot);
        if (!more)
            return [];
        const height = ctrl.host.clientHeight;
        const chips = slotChips(slot);
        const top = ctrl.host.getBoundingClientRect().top;
        const bottoms = chips.map((chip) => chip.getBoundingClientRect().bottom - top);
        const limit = height - STACK_INSET;
        if (!(height > 0) || bottoms.every((bottom) => bottom <= limit + 0.01))
            return [{ slot, chips, shown: chips.map(() => true), more: true }];
        const room = limit - more.getBoundingClientRect().height - (parseFloat(getComputedStyle(slot).rowGap) || 0);
        let fits = true;
        return [{ slot, chips, shown: bottoms.map((bottom) => (fits = fits && bottom <= room + 0.01)), more: true }];
    }

    function measureStacks(ctrl: CardController) {
        const slots = s.STACK_SLOTS[ctrl.layout || ''];
        if (!slots)
            return [];
        const width = Math.max(0, ctrl.host.clientWidth - 2 * STACK_INSET);
        const out = [];
        for (const slot of childrenOf(ctrl.host)) {
            if (!slots.includes((slot).dataset.jeSlot || ''))
                continue;
            for (const group of childrenOf(slot)) {
                if (!((group).dataset.jeGroup))
                    continue;
                for (const chip of (childrenOf(group))) {
                    if (chip.getBoundingClientRect().width > width + 0.01)
                        out.push({ chip, width });
                }
            }
        }
        return out;
    }

    function measureCornerLift(ctrl: CardController) {
        if (ctrl.layout !== 'minimal')
            return null;
        const slots = (childrenOf(ctrl.host));
        const corner = slots.find((el) => el.dataset.jeSlot === 'corner');
        if (!corner)
            return null;
        const dots = slots.find((el) => el.dataset.jeSlot === 'dots')?.getBoundingClientRect();
        const chipRects = (slot: HTMLElement | undefined) => Array.from(slot?.querySelectorAll<HTMLElement>(':scope > [data-je-group] > *') || [])
            .map((chip) => ({ chip: (chip), r: chip.getBoundingClientRect() })).filter(({ r }) => r.width > 0);
        const chips = chipRects(corner);
        const conf = deps.resolveLayout(ctrl);
        const gap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
        const meets = !!dots?.width && chips.some(({ r }) => r.left < dots.right + gap && r.top < dots.bottom && r.bottom > dots.top);
        const lift = meets ? Math.max(0, corner.getBoundingClientRect().bottom - dots.top + gap) : 0;
        const host = ctrl.host.getBoundingClientRect();
        if (!(ctrl.host.clientHeight > 0))
            return { slot: corner, lift, hidden: [] };
        const ceiling = host.top + STACK_INSET;
        const above = chipRects(slots.find((el) => el.dataset.jeSlot === 'top')).map(({ r }) => r);
        const hidden = [];
        for (const { chip, r } of chips.sort((a, b) => b.r.bottom - a.r.bottom)) {
            const top = r.top - lift;
            if (hidden.length || top < ceiling - 0.01
                || above.some((t) => r.left < t.right && r.right > t.left && top < t.bottom + gap - 0.01))
                hidden.push(chip);
        }
        return { slot: corner, lift, hidden };
    }

    function measureIndicatorGaps(ctrl: CardController) {
        const slot = indicatorGapsToMeasure(ctrl);
        if (!slot)
            return [];
        const items = (childrenOf(slot));
        const top = slot.getBoundingClientRect().top;
        const gap = parseFloat(getComputedStyle(slot).rowGap) || 0;
        const out: FitPlan['indicator'] = [];
        items.forEach((el, i) => {
            if (!el.dataset.jeIndicatorGap)
                return;
            const prev = items[i - 1];
            out.push({ el, before: !prev || prev.dataset.jeIndicatorGap ? null : Math.max(0, prev.getBoundingClientRect().bottom + gap - top) });
        });
        return out;
    }

    function pillFactsThatFit(pill: HTMLElement) {
        const facts = Array.from(pill.querySelectorAll<HTMLElement>('.je-tag-pill-fact'));
        const excess = pill.scrollWidth - pill.clientWidth;
        let keep = facts.length;
        let freed = 0;
        while (keep > 1 && freed < excess - 0.5) {
            const fact = facts[keep - 1];
            if (!fact)
                break;
            const sep = fact.previousElementSibling;
            freed += fact.getBoundingClientRect().width + (sep ? sep.getBoundingClientRect().width : 0);
            keep--;
        }
        return keep;
    }

    function prepareFitText(first: HTMLElement) {
        const chip = first.matches('.awards-link, .language-link') ? first.firstElementChild : first;
        if (!chip)
            return;
        if (chip.matches('.status-tag, .quality-overlay-label, .age-rating-tag, .je-logo-text')) {
            const text = document.createElement('span');
            text.className = 'je-tag-fit-text';
            text.append(...chip.childNodes);
            chip.append(text);
        }
        else if (chip.matches('.language-chip')) {
            for (const node of Array.from(chip.childNodes)) {
                if (node.nodeType !== 3)
                    continue;
                const text = document.createElement('span');
                text.className = 'je-tag-fit-text';
                node.replaceWith(text);
                text.append(node);
            }
        }
    }

    return { holdsGroups, moreChipOf, posterStack, chipLabel, scheduleFit, unwatchSize, flushFit, prepareFitText };
}
