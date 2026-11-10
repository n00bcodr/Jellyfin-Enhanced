import type { CardController, LayoutHost } from './layout-runtime-types';
import { childrenOf, type FitPlan, INDICATOR_BEFORE, type LayoutFns, type LayoutState, STACK_INSET, STACK_LIFT } from './state';

// ── Genre names ────────────────────────────────────────────────────
// A genre icon's name floats out beside it while the card is hovered,
// focused or revealed. Each name is bounded to the free room on its own
// line: from its icon (plus a gap) to the nearest other chip on that line
// or the card's inner edge, ellipsized past it, and hidden (the icon keeps
// its title) when that leaves less than GENRE_NAME_MIN. Icons side by side
// (a centre row, a band) would push their names into each other: there
// the names become one list, a line each, below a top row or above a
// bottom one, inside the card. The "+N" names tip then takes the first band
// across the card that no chip or shown name touches (from the top down),
// or is left out (it stays the card link's description). Measured for one
// card when it is revealed (pointer, focus, a preview's Hover view), never
// for every card at load.
const GENRE_NAME_GAP = 4;
const GENRE_NAME_MIN = 24;
const GENRE_NAME_SHARE = 0.6;
// ── Hidden chip names ──────────────────────────────────────────────
// A "+N" chip takes no pointer events and no focus (on the poster it
// would take clicks from the card and Jellyfin's buttons). The names it
// stands for are given to the card's own link instead: an accessible
// description, and a small tooltip while the card is hovered or focused.
const FOCUSABLE = 'a[href], button, [tabindex]:not([tabindex="-1"])';

/**
 * Applying a fit: chip rows, the revealed genre names and the hidden chips' names.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createFitApply(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    function applyFit(ctrl: CardController, plan: FitPlan) {
        for (const row of plan.rows) {
            if (row.width !== undefined)
                row.slot.style.setProperty('--je-anchor-width', `${row.width}px`);
            if (row.firstWidth !== undefined && row.chips[0]) {
                deps.prepareFitText(row.chips[0]);
                row.chips[0].setAttribute('data-je-fit-width', '');
                row.chips[0].style.setProperty('--je-chip-fit-width', `${row.firstWidth}px`);
            }
        }
        for (const { chip, width } of plan.stacks) {
            deps.prepareFitText(chip);
            chip.setAttribute('data-je-fit-width', '');
            chip.style.setProperty('--je-chip-fit-width', `${width}px`);
        }
        if (plan.lift?.lift)
            plan.lift.slot.style.setProperty(STACK_LIFT, `${Math.round(plan.lift.lift * 100) / 100}px`);
        if (plan.lift?.hidden.length) {
            for (const chip of plan.lift.hidden)
                chip.setAttribute('data-je-overflow', '');
            // A group left without chips takes no gap in the stack either.
            for (const group of childrenOf(plan.lift.slot)) {
                if (childrenOf(group).every((chip) => chip.hasAttribute('data-je-overflow')))
                    group.setAttribute('data-je-overflow', '');
            }
        }
        if (ctrl.layout === 'corners' && deps.resolveLayout(ctrl).edge === 'flush') {
            for (const row of plan.rows) {
                const slot = row.slot.dataset.jeSlot;
                if (!['tc', 'bc'].includes(slot || ''))
                    continue;
                const last = Math.max(0, ...row.chips.map((chip, i) => row.shown[i] ? row.fittedRows?.[i] || 0 : 0), row.shown.includes(false) && row.more ? row.fittedMoreRow || 0 : 0);
                row.chips.forEach((chip, i) => {
                    chip.toggleAttribute('data-je-flush-top', slot === 'tc' && !row.slot.hasAttribute('data-je-flush-detached') && row.shown[i] && row.fittedRows?.[i] === 1);
                    chip.toggleAttribute('data-je-flush-bottom', slot === 'bc' && row.shown[i] && row.fittedRows?.[i] === last);
                });
                const more = deps.moreChipOf(row.slot);
                const visible = row.more && row.shown.includes(false);
                more?.toggleAttribute('data-je-flush-top', visible && slot === 'tc' && !row.slot.hasAttribute('data-je-flush-detached') && row.fittedMoreRow === 1);
                more?.toggleAttribute('data-je-flush-bottom', visible && slot === 'bc' && row.fittedMoreRow === last);
            }
        }
        if (plan.pillFacts >= 0 && ctrl.pill) {
            Array.from(ctrl.pill.querySelectorAll<HTMLElement>('.je-tag-pill-fact')).slice(plan.pillFacts).forEach((fact) => {
                fact.setAttribute('data-je-overflow', '');
                fact.previousElementSibling?.setAttribute('data-je-overflow', '');
            });
        }
        const names = applyChipRows(plan.rows);
        describeHidden(ctrl, names);
        // A poster-stack group left with no chip takes no gap in the column either.
        for (const slot of deps.posterStack(ctrl)) {
            for (const group of childrenOf(slot)) {
                const chips = childrenOf(group);
                if ((group).dataset.jeGroup && chips.length && chips.every((chip) => chip.hasAttribute('data-je-overflow')))
                    group.setAttribute('data-je-overflow', '');
            }
        }
        for (const { el, before } of plan.indicator) {
            const value = before === null ? '' : `${Math.round(before * 100) / 100}px`;
            if (el.style.getPropertyValue(INDICATOR_BEFORE) === value)
                continue;
            if (value)
                el.style.setProperty(INDICATOR_BEFORE, value);
            else
                el.style.removeProperty(INDICATOR_BEFORE);
        }
    }

    function applyChipRows(rows: FitPlan['rows']) {
        const names: string[] = [];
        for (const { slot, chips, shown, more: room } of rows) {
            const more = deps.moreChipOf(slot);
            if (!more)
                continue;
            const hidden = chips.filter((chip, i) => !shown[i]);
            for (const chip of hidden)
                chip.setAttribute('data-je-overflow', '');
            names.push(...hidden.map(deps.chipLabel).filter(Boolean));
            // Not a single row fits: no empty scrim either.
            if (!room && !shown.some(Boolean))
                slot.setAttribute('data-je-overflow', '');
            if (hidden.length === 0 || !room) {
                more.setAttribute('data-je-overflow', '');
                more.removeAttribute('title');
                continue;
            }
            more.textContent = `+${hidden.length}`;
            more.title = hidden.map(deps.chipLabel).filter(Boolean).join(', ');
        }
        return names;
    }

    function isRevealed(host: HTMLElement) {
        const card = host.closest<HTMLElement>('.card, .je-mtp-card, .je-tie-card');
        if (!card)
            return false;
        try {
            return card.classList.contains('je-tag-reveal') || card.matches(':hover, :focus-within');
        }
        catch {
            return false;
        }
    }

    function fitReveal(host: HTMLElement | null | undefined) {
        if (!host)
            return;
        const ctrl = s.controllers.get(host);
        if (ctrl && s.fitScheduled && s.pendingFit.has(ctrl)) {
            s.genreAfterFit.add(host);
            return;
        }
        const names = (Array.from(host.querySelectorAll<HTMLElement>(':scope > .je-tag-slot:not([data-je-slot="hover"]) .genre-tag > .genre-text')));
        const tip = (host.querySelector<HTMLElement>(':scope > .je-tag-more-tip'));
        if (names.length === 0 && !tip)
            return;
        if (tip) {
            delete tip.dataset.jeTipFit;
            tip.style.removeProperty('top');
        }
        // Undo an earlier bound, so the names are read where the stylesheet puts them (one card, on demand).
        for (const name of names) {
            delete name.dataset.jeGenreFit;
            for (const prop of ['max-width', 'left', 'right', 'top', 'transform'])
                name.style.removeProperty(prop);
        }
        // Reads.
        const card = host.getBoundingClientRect();
        if (!(card.width > 0) || !(card.height > 0))
            return;
        const left = card.left + STACK_INSET;
        const right = card.right - STACK_INSET;
        const obstacles = (Array.from(host.querySelectorAll<HTMLElement>(':scope > .je-tag-slot:not([data-je-slot="hover"]) > [data-je-group] > *')))
            .map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0);
        const items = names.map((name) => {
            const tag = name.parentElement || name;
            const icon = tag.getBoundingClientRect();
            const box = name.getBoundingClientRect();
            // A name custom CSS shows inline (position: static) is not a floating name: left alone.
            const floating = getComputedStyle(name).position === 'absolute';
            return { tag, name, icon, floating, height: box.height, natural: box.width, floatsLeft: box.right <= icon.left + 0.5, borderLeft: tag.clientLeft, borderTop: tag.clientTop };
        }).filter((m) => m.icon.width > 0 && m.floating);
        // Icons side by side in one group: the names list under (or over) the row.
        const groups = new Map<HTMLElement | null, typeof items>();
        for (const item of items) {
            const group = item.tag.parentElement;
            if (!groups.has(group))
                groups.set(group, []);
            groups.get(group)?.push(item);
        }
        const writes: Array<{
            name: HTMLElement;
            mode: string;
            room: number;
            x?: number;
            y?: number;
        }> = [];
        for (const members of groups.values()) {
            const row = members.length > 1 && members.every((m) => Math.abs(m.icon.top - (members[0]?.icon.top || 0)) < 1);
            if (!row) {
                for (const m of members) {
                    // The name's line: centred on its icon.
                    const top = m.icon.top + (m.icon.height - m.height) / 2;
                    const bottom = top + m.height;
                    // The line must lie inside the card (a short image can push an icon past its edge).
                    let blocked = top < card.top - 0.5 || bottom > card.bottom + 0.5;
                    // The side the name floats to: from its icon (plus the gap) to the card's inner edge.
                    const near = m.floatsLeft ? m.icon.left - GENRE_NAME_GAP : m.icon.right + GENRE_NAME_GAP;
                    let limit = m.floatsLeft ? left : right;
                    for (const { el, r } of obstacles) {
                        if (el === m.tag || r.bottom <= top + 0.5 || r.top >= bottom - 0.5)
                            continue;
                        if (m.floatsLeft && r.left < m.icon.left - 0.5) {
                            // A chip on the name's line: the room ends a gap before it; one reaching the icon leaves none.
                            if (r.right <= near + 0.5)
                                limit = Math.max(limit, r.right + GENRE_NAME_GAP);
                            else
                                blocked = true;
                        }
                        if (!m.floatsLeft && r.right > m.icon.right + 0.5) {
                            if (r.left >= near - 0.5)
                                limit = Math.min(limit, r.left - GENRE_NAME_GAP);
                            else
                                blocked = true;
                        }
                    }
                    const room = blocked ? 0 : Math.floor(m.floatsLeft ? near - limit : limit - near);
                    const needed = Math.min(m.natural, Math.max(GENRE_NAME_MIN, GENRE_NAME_SHARE * m.natural));
                    writes.push({ name: m.name, mode: room < needed - 0.5 ? 'hidden' : 'side', room: Math.max(0, room) });
                }
                continue;
            }
            const rowLeft = Math.min(...members.map((m) => m.icon.left));
            const rowTop = Math.min(...members.map((m) => m.icon.top));
            const rowBottom = Math.max(...members.map((m) => m.icon.bottom));
            const below = (rowTop + rowBottom) / 2 < card.top + card.height / 2;
            const room = Math.floor(right - left);
            members.forEach((m, i) => {
                const width = Math.min(m.natural, room);
                const x = Math.min(Math.max(rowLeft, left), right - width);
                const line = m.height + 2;
                const y = below ? rowBottom + GENRE_NAME_GAP + i * line : rowTop - GENRE_NAME_GAP - (members.length - i) * line + 2;
                const inside = y >= card.top + STACK_INSET - 0.5 && y + m.height <= card.bottom - STACK_INSET + 0.5;
                // Offsets from the icon's padding box (the name's containing block).
                writes.push({ name: m.name, mode: inside ? 'list' : 'hidden', room, x: x - m.icon.left - m.borderLeft, y: y - m.icon.top - m.borderTop });
            });
        }
        // Writes.
        for (const w of writes) {
            w.name.dataset.jeGenreFit = w.mode;
            w.name.style.maxWidth = `${w.room}px`;
            if (w.mode !== 'list')
                continue;
            w.name.style.left = `${Math.round((w.x ?? 0) * 100) / 100}px`;
            w.name.style.right = 'auto';
            w.name.style.top = `${Math.round((w.y ?? 0) * 100) / 100}px`;
            w.name.style.transform = 'none';
        }
        if (tip)
            placeMoreTip(host, tip, card);
        host.dataset.jeGenreBound = '1';
    }

    function placeMoreTip(host: HTMLElement, tip: HTMLElement, card: DOMRect) {
        const box = tip.getBoundingClientRect();
        const busy = (Array.from(host.querySelectorAll<HTMLElement>(':scope > .je-tag-slot:not([data-je-slot="hover"]) > [data-je-group] > *, :scope > .je-tag-slot:not([data-je-slot="hover"]) .genre-tag > .genre-text')))
            .filter((el) => !el.matches('.genre-text') || (el.dataset.jeGenreFit !== 'hidden' && getComputedStyle(el).display !== 'none'))
            .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        const left = card.left + (card.width - box.width) / 2;
        const right = left + box.width;
        const free = (top: number) => busy.every((r) => r.right <= left - GENRE_NAME_GAP + 0.5 || r.left >= right + GENRE_NAME_GAP - 0.5
            || r.bottom <= top - GENRE_NAME_GAP + 0.5 || r.top >= top + box.height + GENRE_NAME_GAP - 0.5);
        // Candidate tops: the card's own inset, then a gap below every chip, nearest the top first.
        const tops = [card.top + STACK_INSET, ...busy.map((r) => r.bottom + GENRE_NAME_GAP)].sort((a, b) => a - b);
        const top = tops.find((y) => y >= card.top + STACK_INSET - 0.5 && y + box.height <= card.bottom - STACK_INSET + 0.5 && free(y));
        if (top === undefined) {
            tip.dataset.jeTipFit = 'hidden';
            return;
        }
        tip.dataset.jeTipFit = 'placed';
        tip.style.top = `${Math.round((top - card.top) * 100) / 100}px`;
    }

    function onReveal(event: Event) {
        const target = (event.target instanceof Element ? event.target : null);
        const card = target?.closest<HTMLElement>('.card');
        if (!card || card === s.revealedCard)
            return;
        s.revealedCard = card;
        fitReveal((card.querySelector<HTMLElement>('.je-tag-host')));
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('pointerover', onReveal, { passive: true });
        document.addEventListener('focusin', onReveal);
        document.addEventListener('pointerout', (event) => {
            if (s.revealedCard && !(event.relatedTarget instanceof Node && s.revealedCard.contains(event.relatedTarget)))
                s.revealedCard = null;
        }, { passive: true });
    }

    function cardLinkOf(host: HTMLElement) {
        const card = host.closest<HTMLElement>('.card, .listItem');
        const image = card?.querySelector<HTMLElement>(`.cardImageContainer:is(${FOCUSABLE})`);
        if (image)
            return (image);
        const around = host.parentElement?.closest<HTMLElement>(FOCUSABLE);
        if (around)
            return (around);
        return (card?.querySelector<HTMLElement>(FOCUSABLE) || null);
    }

    function toggleDescribedBy(el: HTMLElement, id: string, on: boolean) {
        const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter((t) => t && t !== id);
        if (on)
            ids.push(id);
        if (ids.length)
            el.setAttribute('aria-describedby', ids.join(' '));
        else
            el.removeAttribute('aria-describedby');
    }

    function describeHidden(ctrl: CardController, names: string[]) {
        const link = names.length ? cardLinkOf(ctrl.host) : null;
        if (ctrl.described && (ctrl.described !== link || !names.length) && ctrl.moreTip) {
            toggleDescribedBy(ctrl.described, ctrl.moreTip.id, false);
            ctrl.described = null;
        }
        if (!names.length) {
            ctrl.moreTip?.remove();
            ctrl.moreTip = null;
            return;
        }
        let tip = ctrl.moreTip;
        if (!tip || tip.parentElement !== ctrl.host) {
            tip?.remove();
            tip = document.createElement('span');
            tip.className = 'je-tag-more-tip';
            tip.id = `je-tag-more-${++s.moreTipSeq}`;
            tip.setAttribute('aria-hidden', 'true');
            ctrl.host.appendChild(tip);
            ctrl.moreTip = tip;
        }
        const list = names.join(', ');
        const label = typeof JE.t === 'function' ? JE.t('tag_layout_more_tags', { tags: list }) : '';
        const text = label && label !== 'tag_layout_more_tags' ? label : list;
        if (tip.textContent !== text)
            tip.textContent = text;
        if (link && link !== ctrl.described) {
            toggleDescribedBy(link, tip.id, true);
            ctrl.described = link;
        }
    }

    return { applyFit, applyChipRows, isRevealed, fitReveal, cardLinkOf, describeHidden };
}
