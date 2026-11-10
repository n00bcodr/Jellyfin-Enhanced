import { SHAPES, withShape } from './layout-rules';
import type { LayoutHost } from './layout-runtime-types';
import { type CardContext, childrenOf, contextElement, type LayoutFns, type LayoutState, type PreviewLook } from './state';

// A card waiting for its item data shows its tags after this long even
// when the data never comes (a failed fetch the pipeline didn't report).
const AWAIT_CONTEXT_MS = 8000;

/**
 * Card context: tag hosts, card shapes and facts, item looks and the wait for a card's item data.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createCardContext(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    function identityOf(el: HTMLElement) {
        const holder = el.closest<HTMLElement>('[data-id]') || el.closest<HTMLElement>('[data-itemid]');
        const raw = holder?.getAttribute('data-id') || holder?.getAttribute('data-itemid') || '';
        return raw.replace(/-/g, '').toLowerCase();
    }

    function shapeOfCard(el: Element | null) {
        if (!el || typeof el.closest !== 'function')
            return null;
        if (el.closest<HTMLElement>('.listItemImage-large'))
            return 'list';
        // The host's marker describes output; only an ancestor may declare
        // an input shape (the preview samples). Never classify from stale output.
        const origin = el.classList.contains('je-tag-host') ? el.parentElement : el;
        const explicit = origin?.closest<HTMLElement>('[data-je-shape]:not(.je-tag-host)')?.getAttribute('data-je-shape');
        if (explicit === 'portrait' || explicit === 'list' || explicit === 'landscape')
            return explicit;
        const card = el.closest<HTMLElement>('.card');
        if (!card)
            return null;
        for (const cls of card.classList) {
            if (s.PORTRAIT_CARD.test(cls))
                return 'portrait';
            if (s.LANDSCAPE_CARD.test(cls))
                return 'landscape';
        }
        return null;
    }

    function shapeOf(cardContext: CardContext): string {
        if (cardContext && 'host' in cardContext)
            return cardContext.shape || 'portrait';
        if (cardContext instanceof HTMLElement) {
            const ctrl = s.controllers.get(findHost(cardContext) || cardContext);
            return ctrl?.shape || shapeOfCard(cardContext) || 'portrait';
        }
        return cardContext?.shape === 'list' || cardContext?.shape === 'landscape' ? cardContext.shape : 'portrait';
    }

    function shapesInUse() {
        const base = deps.currentSettings();
        if (SHAPES.some((shape) => (shape === 'list' || shape === 'landscape' ? base.shapes[shape] : null)))
            return true;
        const looks = deps.currentLooks();
        return looks.rules.some((rule) => !!rule.shapes) || Array.from(looks.locks.values()).some((lock) => !!lock.shapes)
            || Array.from(looks.overrides.values()).some((look) => !!look.shapes);
    }

    function findHost(target: HTMLElement) {
        if (!target)
            return null;
        if (target.classList?.contains('je-tag-host'))
            return target;
        for (const child of childrenOf(target)) {
            if (child.classList.contains('je-tag-host'))
                return (child);
        }
        return null;
    }

    function ensureHost(target: HTMLElement) {
        const existing = findHost(target);
        if (existing || !target)
            return existing;
        const host = document.createElement('div');
        host.className = 'je-tag-host';
        const overlay = target.classList.contains('cardScalable')
            ? childrenOf(target).find((c) => c.classList.contains('cardOverlayContainer')) || null
            : null;
        target.insertBefore(host, overlay);
        return host;
    }

    function captionAnchor(host: HTMLElement) {
        const scalable = host.closest<HTMLElement>('.cardScalable');
        const box = scalable?.parentElement;
        if (!scalable || !box || !box.classList.contains('cardBox'))
            return null;
        for (let next = scalable.nextElementSibling; next; next = next.nextElementSibling) {
            if (next.classList.contains('je-tag-caption'))
                continue;
            if (next.classList.contains('cardText') || next.querySelector<HTMLElement>('.cardText')) {
                return { parent: box, before: (next) };
            }
        }
        return null;
    }

    function isIgnoredContext(host: HTMLElement) {
        const check = JE.core.tagRenderer?.isIgnoredContext;
        return typeof check === 'function' ? check(host) : false;
    }

    function controllerFor(target: HTMLElement, create: boolean) {
        const host = create ? ensureHost(target) : findHost(target);
        if (!host)
            return null;
        let ctrl = s.controllers.get(host) || null;
        const itemId = identityOf(host);
        if (ctrl && ctrl.itemId !== itemId) {
            deps.forget(ctrl);
            ctrl = null;
        }
        if (!ctrl && create) {
            deps.injectStyles();
            ctrl = { host, itemId, groups: new Map(), nodes: new Map(), outlet: null, pill: null, layout: null, seq: 0, moreTip: null, described: null, lookKey: '', shape: shapeOfCard(host) };
            s.controllers.set(host, ctrl);
        }
        return ctrl;
    }

    function cardFacts(cardContext: CardContext) {
        const look = deps.requireLook();
        const el = contextElement(cardContext);
        if (!el)
            return look.factsFrom(cardContext, { itemId: cardContext && 'itemId' in cardContext ? cardContext.itemId || '' : '', cardType: cardContext && 'cardType' in cardContext ? cardContext.cardType || null : null });
        const cardId = cardContext && 'host' in cardContext ? cardContext.itemId : identityOf(el);
        const data = contextOf(s.cardData, el);
        const usable = data && (!data.cardId || data.cardId === cardId);
        const cardType = el.closest<HTMLElement>('[data-type]')?.getAttribute('data-type') || null;
        return look.factsFrom(usable ? data.entry : null, { itemId: usable ? data.itemId : '', cardId, cardType });
    }

    function contextOf<T>(map: WeakMap<HTMLElement, T>, el: HTMLElement) {
        return map.get(el) || (el.parentElement ? map.get(el.parentElement) : undefined);
    }

    function needsCardData(cardType: string | null) {
        const looks = deps.currentLooks();
        const perItem = looks.locks.size + looks.overrides.size;
        if (!looks.rules.length && !perItem)
            return false;
        if (!cardType)
            return true;
        if (looks.rules.some((rule) => rule.enabled && rule.when.some((cond) => cond.field !== 'type')))
            return true;
        // A season or episode inherits its series' lock or item look: the series id comes with the data.
        return perItem > 0 && (cardType === 'Season' || cardType === 'Episode');
    }

    function isAwaiting(host: HTMLElement) {
        const rec = contextOf(s.awaitingData, host);
        return !!rec && rec.cardId === identityOf(host);
    }

    function resolveLayout(cardContext: CardContext) {
        const base = deps.currentSettings();
        const source = lookSource(cardContext);
        const shape = source.shape;
        if (source.lock)
            return deps.lookSettings(base, withShape(source.lock, (shape === 'list' || shape === 'landscape' ? source.lock.shapes?.[shape] : null)), source.source === 'lock' || ('locked' in source.lock && !!source.lock.locked));
        if (source.rule)
            return deps.lookSettings(base, withShape(source.rule, (shape === 'list' || shape === 'landscape' ? source.rule.shapes?.[shape] : null)), false);
        if (source.source === 'shape') {
            return deps.lookSettings(base, withShape({ layout: base.layout, density: base.density, slots: null, caps: null }, (shape === 'list' || shape === 'landscape' ? base.shapes[shape] : null)), false);
        }
        return base;
    }

    function lookSource(cardContext: CardContext) {
        const looks = deps.currentLooks();
        const shape = shapeOf(cardContext);
        const el = contextElement(cardContext);
        const preview = el ? contextOf(previewLooks, el) : undefined;
        if (preview)
            return { source: 'preview', lock: preview, rule: null, index: -1, shape };
        const shaped = (shape === 'list' || shape === 'landscape') && !!deps.currentSettings().shapes[shape];
        const none = { source: (shaped ? 'shape' : 'default'), lock: null, rule: null, index: -1, shape };
        if (!looks.rules.length && !looks.locks.size && !looks.overrides.size)
            return none;
        const facts = cardFacts(cardContext);
        const lock = deps.requireLook().findLock(looks.locks, facts);
        if (lock)
            return { source: 'lock', lock, rule: null, index: -1, shape };
        const override = deps.requireLook().findLock(looks.overrides, facts);
        if (override)
            return { source: 'override', lock: override, rule: null, index: -1, shape };
        const rule = deps.requireLook().firstMatch(looks.rules, facts);
        return rule ? { source: 'rule', lock: null, rule, index: looks.rules.indexOf(rule), shape } : none;
    }

    const previewLooks: WeakMap<HTMLElement, PreviewLook> = new WeakMap();

    function setPreviewLook(target: HTMLElement, look: PreviewLook | null) {
        if (!target)
            return;
        if (look)
            previewLooks.set(target, look);
        else
            previewLooks.delete(target);
        deps.refreshPresentation(target);
    }

    function cardIdentity(target: HTMLElement) {
        return target ? identityOf(findHost(target) || target) : '';
    }

    function setCardContext(target: HTMLElement, entry: unknown, itemId: string, cardId?: string) {
        if (!target || !entry)
            return false;
        const host = findHost(target) || target;
        const current = identityOf(host);
        if (cardId !== undefined && cardId !== null && cardId !== current)
            return false;
        s.cardData.set(host, { entry, itemId, cardId: current });
        const waited = endAwait(host);
        const ctrl = s.controllers.get(host);
        if (!ctrl || !ctrl.host.isConnected || !ctrl.groups.size)
            return true;
        const looks = deps.currentLooks();
        if (waited || ((looks.rules.length || looks.locks.size) && resolveLayout(ctrl).lookKey !== ctrl.lookKey))
            deps.presentAll(ctrl);
        return true;
    }

    function awaitCardContext(target: HTMLElement, cardId: string, cardType: string | null) {
        if (!target || !needsCardData(cardType))
            return false;
        const host = findHost(target) || target;
        endAwait(host);
        const token = { cardId, generation: ++s.waitGeneration };
        const timer = setTimeout(() => releaseCardContext(target, token), AWAIT_CONTEXT_MS);
        s.awaitingData.set(host, { cardId, timer, token });
        return token;
    }

    function endAwait(el: HTMLElement) {
        let waited = false;
        for (const key of [el, el.parentElement]) {
            const rec = key ? s.awaitingData.get(key) : undefined;
            if (!rec)
                continue;
            clearTimeout(rec.timer);
            if (key)
                s.awaitingData.delete(key);
            waited = true;
        }
        return waited;
    }

    function releaseCardContext(target: HTMLElement, token: {
        cardId: string;
        generation: number;
    }) {
        if (!target)
            return;
        const host = findHost(target) || target;
        const rec = contextOf(s.awaitingData, host);
        if (!rec || rec.token !== token || token.cardId !== identityOf(host))
            return;
        if (!endAwait(host))
            return;
        const ctrl = s.controllers.get(host);
        if (!ctrl || !ctrl.groups.size)
            return;
        if (ctrl.host.isConnected)
            deps.presentAll(ctrl);
        else
            ctrl.pendingPresentation = true;
    }

    function resumePresentation(target: HTMLElement) {
        const ctrl = target ? controllerFor(target, false) : null;
        if (ctrl?.pendingPresentation && ctrl.host.isConnected)
            deps.presentAll(ctrl);
    }

    return { shapeOfCard, shapeOf, shapesInUse, findHost, ensureHost, captionAnchor, isIgnoredContext, controllerFor, contextOf, isAwaiting, resolveLayout, lookSource, setPreviewLook, cardIdentity, setCardContext, awaitCardContext, endAwait, releaseCardContext, resumePresentation };
}
