import { compactQualityLabel, revealSettings } from './layout-fitting';
import { DEFAULT_ORDER, ENABLED_SETTING, type Group, type LayoutSettings, normalizeGroup, SLOT_TO_POSITION } from './layout-rules';
import type { CardController, LayoutHost } from './layout-runtime-types';
import { childrenOf, cloneElement, type LayoutFns, type LayoutState } from './state';

const PILL_MAX_FACTS = 3;

/**
 * Presentation: chips, dots, pills and slots for each group, and tearing a card's presentation down.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createPresent(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    function applyDensityAndCap(group: Group, node: HTMLElement, conf: LayoutSettings) {
        if (conf.density === 'compact') {
            if (group === 'quality') {
                for (const chip of node.querySelectorAll<HTMLElement>('.quality-overlay-label')) {
                    const text = chip.textContent || '';
                    const short = chip.dataset.jeCompact || compactQualityLabel(text);
                    if (short !== text)
                        chip.textContent = short;
                }
            }
            else if (group === 'rating') {
                for (const chip of node.querySelectorAll<HTMLElement>('.rating-tag--source'))
                    chip.dataset.jeRatingCompact = '1';
                // Legacy Community/Critic chips retain their historical compact density.
                if (node.querySelector<HTMLElement>('.rating-tag-tmdb'))
                    node.querySelector<HTMLElement>('.rating-tag-critic')?.remove();
            }
            else if (group === 'status') {
                // Status badges carry their own short label ("Season Premiere" → "Premiere").
                for (const chip of node.querySelectorAll<HTMLElement>('[data-je-compact]')) {
                    chip.textContent = (chip).dataset.jeCompact || chip.textContent;
                }
            }
        }
        const cap = conf.caps[group];
        if (cap > 0) {
            while (node.children.length > cap)
                node.lastElementChild?.remove();
        }
    }

    function buildChips(group: Group, master: HTMLElement, conf: LayoutSettings, host?: HTMLElement) {
        const node = (cloneElement(master));
        node.dataset.jeGroup = group;
        // Event handler properties are not cloned: a flag whose country is
        // missing from the flag set still removes itself.
        for (const img of node.querySelectorAll<HTMLImageElement>('img'))
            img.onerror = () => img.remove();
        applyDensityAndCap(group, node, conf);
        if ((group === 'language' || group === 'awards') && host) {
            const link = deps.cardLinkOf(host);
            if (link?.matches('a[href]') && !link.contains(host)) {
                for (const chip of childrenOf(node)) {
                    const anchor = document.createElement('a');
                    anchor.className = group === 'language' ? 'language-link' : 'awards-link';
                    anchor.href = link.getAttribute('href') || '';
                    anchor.title = chip.getAttribute('title') || '';
                    // Mouse/touch only: keyboard focus stays on the poster's own link.
                    anchor.setAttribute('tabindex', '-1');
                    for (const attr of ['target', 'rel']) {
                        if (link.hasAttribute(attr))
                            anchor.setAttribute(attr, link.getAttribute(attr) || '');
                    }
                    chip.replaceWith(anchor);
                    anchor.appendChild(chip);
                }
            }
        }
        return node;
    }

    function buildDots(master: HTMLElement, conf: LayoutSettings) {
        const copy = buildChips('quality', master, { ...conf, density: 'full' });
        const labels = [];
        const dots = document.createElement('div');
        dots.className = 'je-tag-dots';
        dots.dataset.jeGroup = 'quality';
        for (const chip of childrenOf(copy)) {
            const label = chip.textContent || '';
            const kind = s.DOT_KIND.find(([cls]) => !!cls && chip.classList.contains(cls))?.[1] || 'codec';
            const dot = document.createElement('span');
            dot.className = 'je-tag-dot';
            dot.dataset.jeDot = kind;
            dot.title = label;
            dot.setAttribute('aria-hidden', 'true');
            dots.appendChild(dot);
            labels.push(label);
        }
        if (labels.length === 0)
            return null;
        dots.setAttribute('role', 'img');
        dots.setAttribute('aria-label', labels.join(', '));
        dots.title = labels.join(' · ');
        return dots;
    }

    function pillFact(group: Group, master: HTMLElement) {
        switch (group) {
            case 'quality': {
                const labels = Array.from(master.querySelectorAll<HTMLElement>('.quality-overlay-label'));
                const resolution = labels.find((l) => l.classList.contains('resolution'))?.textContent || '';
                const range = labels.map((l) => (l).dataset.quality || '').find((q) => s.DYNAMIC_RANGE.includes(q)) || '';
                const text = [resolution, range ? compactQualityLabel(range) : ''].filter(Boolean).join(' ')
                    || labels[0]?.textContent || '';
                return text ? { text } : null;
            }
            case 'rating': {
                const source = master.querySelector<HTMLElement>('.rating-tag--source');
                if (source)
                    return { text: source.getAttribute('aria-label') || source.textContent };
                const community = master.querySelector<HTMLElement>('.rating-tag-tmdb .rating-text')?.textContent;
                if (community)
                    return { text: community, glyph: '★' };
                const critic = master.querySelector<HTMLElement>('.rating-tag-critic .rating-text')?.textContent;
                if (critic)
                    return { text: critic };
                const review = master.querySelector<HTMLElement>('.je-userreview-tag .rating-text')?.textContent;
                return review ? { text: review, glyph: '♥' } : null;
            }
            case 'awards': {
                const chip = childrenOf(master)[0];
                return chip ? { text: chip.textContent, title: chip.title } : null;
            }
            case 'status':
            case 'ageRating': {
                const text = (master.firstElementChild?.textContent || '').trim();
                return text ? { text } : null;
            }
            case 'language': {
                const first = childrenOf(master)[0];
                if (first?.classList.contains('language-code') || first?.classList.contains('language-count-badge')) {
                    const copy = (cloneElement(first));
                    const marker = copy.querySelector<HTMLElement>('.language-cc');
                    const glyph = marker?.textContent || undefined;
                    marker?.remove();
                    return { text: (copy.textContent || '').trim(), glyph, title: first.getAttribute('title') || undefined };
                }
                const img = first instanceof HTMLImageElement ? first : first?.querySelector<HTMLImageElement>('img');
                if (!img)
                    return null;
                const flag = (cloneElement(img));
                flag.className = 'je-tag-pill-flag';
                (flag).onerror = () => flag.remove();
                return { text: img.getAttribute('alt') || '', title: first?.getAttribute('title') || undefined,
                    glyph: first?.querySelector<HTMLElement>('.language-cc')?.textContent || undefined, flag };
            }
            case 'genre': {
                const text = master.querySelector<HTMLElement>('.genre-tag')?.getAttribute('title') || '';
                return text ? { text } : null;
            }
            case 'logos': {
                const text = master.querySelector<HTMLElement>('.je-logo-chip')?.getAttribute('title') || '';
                return text ? { text } : null;
            }
            case 'custom': {
                // The label alone: the chip's icon is a ligature word, not text.
                const text = childrenOf(master)[0]?.dataset.jeCustom || '';
                return text ? { text } : null;
            }
            default:
                return null;
        }
    }

    function rankOf(ctrl: CardController, conf: LayoutSettings, group: Group) {
        if (conf.order)
            return conf.order.indexOf(group);
        return ctrl.groups.get(group)?.seq ?? Number.MAX_SAFE_INTEGER;
    }

    function slotElement(ctrl: CardController, slot: string) {
        if (slot === 'caption')
            return (ensureOutlet(ctrl));
        for (const child of childrenOf(ctrl.host)) {
            if (child.classList.contains('je-tag-slot') && (child).dataset.jeSlot === slot) {
                return (child);
            }
        }
        const el = document.createElement('div');
        el.className = 'je-tag-slot';
        el.dataset.jeSlot = slot;
        // Slots keep one order in the host (also the reading order), whichever group arrived first:
        // turning a group off and on again leaves the card exactly as it was.
        const rank = s.SLOT_ORDER.indexOf(slot);
        const children = childrenOf(ctrl.host);
        const isSlot = (child: Element) => child.classList.contains('je-tag-slot');
        let next = children.find((child) => isSlot(child) && s.SLOT_ORDER.indexOf((child).dataset.jeSlot || '') > rank);
        if (!next) {
            // After the last slot (any other child, such as the "+N" tooltip, stays after the slots).
            let last = -1;
            children.forEach((child, i) => { if (isSlot(child))
                last = i; });
            next = last >= 0 ? children[last + 1] : undefined;
        }
        if (next)
            ctrl.host.insertBefore(el, next);
        else
            ctrl.host.appendChild(el);
        return el;
    }

    function ensureOutlet(ctrl: CardController) {
        if (ctrl.outlet && ctrl.outlet.isConnected)
            return ctrl.outlet;
        const anchor = deps.captionAnchor(ctrl.host);
        if (!anchor)
            return null;
        // An outlet left by a previous host of the same card (Jellyfin rebuilt
        // the image block) is reused rather than stacked.
        let outlet = childrenOf(anchor.parent).find((c) => c.classList.contains('je-tag-caption')) || null;
        if (!outlet) {
            outlet = document.createElement('div');
            outlet.className = 'je-tag-slot je-tag-caption';
            outlet.dataset.jeSlot = 'caption';
            anchor.parent.insertBefore(outlet, anchor.before);
        }
        outlet.dataset.jeOwner = String(++s.outletSeq);
        outlet.replaceChildren();
        ctrl.outlet = (outlet);
        return ctrl.outlet;
    }

    function reservesCaption(conf: LayoutSettings, el: HTMLElement) {
        if (!conf.reserveCaption)
            return false;
        const scopes = JE.core.tagScopes;
        if (!scopes)
            return true;
        return DEFAULT_ORDER.some((g) => conf.slots[g] === 'caption' && !!JE.currentSettings?.[ENABLED_SETTING[g]] && !scopes.excludes(g, el));
    }

    function placeSorted(ctrl: CardController, conf: LayoutSettings, slotEl: HTMLElement | null, node: HTMLElement) {
        if (!slotEl)
            return;
        const rank = rankOf(ctrl, conf, normalizeGroup(node.dataset.jeGroup) || 'quality');
        let before = null;
        for (const sibling of childrenOf(slotEl)) {
            const group = normalizeGroup(sibling.dataset.jeGroup);
            if (group && rankOf(ctrl, conf, group) > rank) {
                before = sibling;
                break;
            }
        }
        // The "+N" overflow chip stays last.
        slotEl.insertBefore(node, before || deps.moreChipOf(slotEl));
    }

    function removeNodes(ctrl: CardController, group: Group) {
        const nodes = ctrl.nodes.get(group);
        if (!nodes)
            return;
        ctrl.nodes.delete(group);
        for (const node of nodes) {
            const slot = node.parentElement;
            node.remove();
            if (slot && slot !== ctrl.outlet && slot.classList.contains('je-tag-slot') && !deps.holdsGroups(slot))
                slot.remove();
        }
    }

    function effectiveSlot(ctrl: CardController, conf: LayoutSettings, group: Group) {
        const slot = conf.slots[group] || 'off';
        if (slot === 'caption' && !ensureOutlet(ctrl))
            return 'poster';
        return slot;
    }

    function refreshPill(ctrl: CardController, conf: LayoutSettings) {
        if (ctrl.pill) {
            const slot = ctrl.pill.parentElement;
            ctrl.pill.remove();
            if (slot && slot.children.length === 0)
                slot.remove();
            ctrl.pill = null;
        }
        if (conf.layout !== 'summary')
            return;
        const groups = Array.from(ctrl.groups.keys())
            .filter((g) => conf.slots[g] === 'pill')
            .sort((a, b) => rankOf(ctrl, conf, a) - rankOf(ctrl, conf, b));
        const facts = [];
        for (const group of groups) {
            // From the same capped, density-adjusted copy the chips show, so
            // the pill never names a chip the caps or density left out.
            const master = ctrl.groups.get(group)?.master;
            if (!master)
                continue;
            const shown = buildChips(group, master, conf);
            const fact = pillFact(group, shown);
            if (fact)
                facts.push({ group, ...fact });
            if (facts.length >= PILL_MAX_FACTS)
                break;
        }
        if (facts.length === 0)
            return;
        const link = facts.some(f => f.group === 'language' || f.group === 'awards') ? deps.cardLinkOf(ctrl.host) : null;
        const pill = document.createElement(link?.matches('a[href]') && !link.contains(ctrl.host) ? 'a' : 'div');
        if (pill.tagName === 'A' && link) {
            pill.setAttribute('href', link.getAttribute('href') || '');
            pill.setAttribute('tabindex', '-1');
            for (const attr of ['target', 'rel']) {
                if (link.hasAttribute(attr))
                    pill.setAttribute(attr, link.getAttribute(attr) || '');
            }
        }
        pill.className = 'je-tag-pill';
        const spoken: string[] = [];
        facts.forEach((fact, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'je-tag-pill-sep';
                sep.setAttribute('aria-hidden', 'true');
                sep.textContent = '·';
                pill.appendChild(sep);
            }
            const span = document.createElement('span');
            span.className = 'je-tag-pill-fact';
            span.dataset.jeGroup = fact.group;
            if (fact.title)
                span.title = fact.title;
            if (fact.glyph) {
                const glyph = document.createElement('span');
                glyph.className = fact.group === 'language' ? 'language-cc' : 'je-tag-pill-glyph';
                glyph.setAttribute('aria-hidden', 'true');
                glyph.textContent = fact.glyph;
                span.append(glyph, ' ');
            }
            if (fact.flag) {
                span.appendChild(fact.flag);
            }
            else {
                span.append(fact.text);
            }
            pill.appendChild(span);
            spoken.push(fact.title || fact.text);
        });
        pill.title = spoken.join(' · ');
        pill.setAttribute('aria-label', spoken.join(', '));
        slotElement(ctrl, 'pill')?.appendChild(pill);
        ctrl.pill = pill;
    }

    function presentGroup(ctrl: CardController, conf: LayoutSettings, group: Group) {
        removeNodes(ctrl, group);
        const rec = ctrl.groups.get(group);
        if (!rec)
            return;
        const slot = effectiveSlot(ctrl, conf, group);
        if (slot === 'off')
            return;
        const nodes: HTMLElement[] = [];
        if (slot === 'dots') {
            const dots = buildDots(rec.master, conf);
            if (dots) {
                placeSorted(ctrl, conf, slotElement(ctrl, 'dots'), dots);
                nodes.push(dots);
            }
        }
        else if (slot !== 'pill') {
            const chips = buildChips(group, rec.master, slot === 'hover' || (conf.layout === 'bands' && ctrl.narrow) ? revealSettings(conf) : conf, ctrl.host);
            if (conf.layout === 'corners')
                chips.dataset.jeCorner = SLOT_TO_POSITION[slot];
            // The original web rule for settings saved before layouts: only a
            // container set to exactly top-right clears the played indicator.
            if (conf.layout === 'corners' && conf.legacy && conf.indicatorGap.has(group))
                chips.dataset.jeIndicatorGap = '1';
            if (chips.children.length > 0) {
                placeSorted(ctrl, conf, slotElement(ctrl, slot), chips);
                nodes.push(chips);
            }
        }
        // Summaries (pill, dots, corner score) keep their full chips for the
        // hover/focus scrim of the summary and minimal layouts.
        if (s.SUMMARY_SLOTS.has(slot) && (conf.layout === 'summary' || conf.layout === 'minimal')) {
            const full = buildChips(group, rec.master, revealSettings(conf), ctrl.host);
            if (full.children.length > 0) {
                placeSorted(ctrl, conf, slotElement(ctrl, 'hover'), full);
                nodes.push(full);
            }
        }
        ctrl.nodes.set(group, nodes);
    }

    function syncIndicatorGap(ctrl: CardController, conf: LayoutSettings) {
        const on = conf.layout === 'corners' && !conf.legacy
            && Array.from(ctrl.groups.keys()).some((g) => conf.indicatorGap.has(g) && (ctrl.nodes.get(g)?.length || 0) > 0);
        if (on)
            ctrl.host.dataset.jeIndicatorGap = '1';
        else
            delete ctrl.host.dataset.jeIndicatorGap;
    }

    function teardown(ctrl: CardController) {
        for (const group of Array.from(ctrl.nodes.keys()))
            removeNodes(ctrl, group);
        ctrl.pill?.remove();
        ctrl.pill = null;
        for (const child of childrenOf(ctrl.host)) {
            if (child.classList.contains('je-tag-slot'))
                child.remove();
        }
        ctrl.outlet?.remove();
        ctrl.outlet = null;
        deps.describeHidden(ctrl, []);
        ctrl.layout = null;
        ctrl.lookKey = '';
        ctrl.host.style.removeProperty('--je-tag-scale');
        ctrl.host.style.removeProperty('--je-tag-gap');
        delete ctrl.host.dataset.jeLayout;
        delete ctrl.host.dataset.jeLegacy;
        delete ctrl.host.dataset.jeLocked;
        delete ctrl.host.dataset.jeIndicatorGap;
        delete ctrl.host.dataset.jeShape;
        delete ctrl.host.dataset.jeEdge;
        delete ctrl.host.dataset.jeGenreBound;
    }

    function presentAll(ctrl: CardController) {
        ctrl.pendingPresentation = false;
        const declaredShape = deps.shapeOfCard(ctrl.host);
        if (declaredShape)
            ctrl.shape = declaredShape;
        const conf = deps.resolveLayout(ctrl);
        const shaped = deps.shapesInUse();
        teardown(ctrl);
        ctrl.layout = conf.layout;
        ctrl.lookKey = conf.lookKey;
        ctrl.host.dataset.jeLayout = conf.layout;
        deps.applySize(ctrl.host, conf);
        if (shaped) {
            // A card its markup doesn't classify waits for the fitting pass
            // to measure its image, so its chips don't land in the portrait
            // look first and then move.
            if (ctrl.shape === null) {
                ctrl.lookKey = '';
                deps.scheduleFit(ctrl);
                return;
            }
            ctrl.host.dataset.jeShape = ctrl.shape;
        }
        // Settings saved before layouts keep the original web geometry
        // (tags/tag-layout-styles.js keys its legacy rules off this).
        if (conf.legacy)
            ctrl.host.dataset.jeLegacy = '1';
        if (reservesCaption(conf, ctrl.host) && !deps.isIgnoredContext(ctrl.host)) {
            const outlet = ensureOutlet(ctrl);
            if (outlet)
                deps.applySize(outlet, conf);
        }
        if (conf.locked)
            ctrl.host.dataset.jeLocked = '1';
        // Corners edge spacing (tags/tag-layout-styles.js); the default inset has no marker.
        if (conf.layout === 'corners' && conf.edge && conf.edge !== 'default')
            ctrl.host.dataset.jeEdge = conf.edge;
        // Waiting for item data: keep the groups, show none yet.
        if (deps.isAwaiting(ctrl.host))
            return;
        const groups = Array.from(ctrl.groups.keys()).sort((a, b) => rankOf(ctrl, conf, a) - rankOf(ctrl, conf, b));
        for (const group of groups)
            presentGroup(ctrl, conf, group);
        refreshPill(ctrl, conf);
        syncIndicatorGap(ctrl, conf);
        deps.scheduleFit(ctrl);
        // Poster preset: the card's colours follow its artwork (tags/tag-poster-colours.js).
        JE.tagPosterColours?.track(ctrl.host);
    }

    return { reservesCaption, removeNodes, refreshPill, presentGroup, syncIndicatorGap, teardown, presentAll };
}
