import { normalizeGroup } from './layout-rules';
import type { CardController, LayoutHost } from './layout-runtime-types';
import type { LayoutFns, LayoutState } from './state';

/**
 * Group lifecycle: commit, remove, refresh and clear a card's groups, and reinitialize.
 * @param s - The layout's shared mutable state (state.ts).
 * @param JE - The layout host (tag-layout-entry.ts).
 * @param deps - The other layout modules' functions, filled in by createTagLayout.
 */
export function createGroups(s: LayoutState, JE: LayoutHost, deps: LayoutFns) {
    // ── Public operations ──────────────────────────────────────────────
    function commitGroup(target: HTMLElement, groupId: string, overlay: HTMLElement) {
        const group = normalizeGroup(groupId);
        if (!group || !target)
            return false;
        if (!overlay || overlay.children.length === 0) {
            removeGroup(target, group);
            return false;
        }
        const ctrl = deps.controllerFor(target, true);
        if (!ctrl)
            return false;
        const conf = deps.resolveLayout(ctrl);
        const previous = ctrl.groups.get(group);
        // A group keeps the place it first arrived at on this card, even after being removed and
        // drawn again (legacy documents order a slot by arrival).
        if (!ctrl.arrived)
            ctrl.arrived = new Map();
        if (!ctrl.arrived.has(group))
            ctrl.arrived.set(group, previous ? previous.seq : ++ctrl.seq);
        ctrl.groups.set(group, { master: overlay, seq: ctrl.arrived.get(group) ?? ctrl.seq });
        if (ctrl.layout !== conf.layout || ctrl.lookKey !== conf.lookKey) {
            deps.presentAll(ctrl);
        }
        else if (!deps.isAwaiting(ctrl.host)) {
            deps.presentGroup(ctrl, conf, group);
            if (conf.layout === 'summary')
                deps.refreshPill(ctrl, conf);
            deps.syncIndicatorGap(ctrl, conf);
            deps.scheduleFit(ctrl);
        }
        return true;
    }

    function removeGroup(target: HTMLElement, groupId: string) {
        const group = normalizeGroup(groupId);
        const ctrl = target ? deps.controllerFor(target, false) : null;
        if (!group || !ctrl || !ctrl.groups.has(group))
            return;
        ctrl.groups.delete(group);
        deps.removeNodes(ctrl, group);
        if (deps.isAwaiting(ctrl.host))
            return;
        const conf = deps.resolveLayout(ctrl);
        if (conf.layout === 'summary')
            deps.refreshPill(ctrl, conf);
        deps.syncIndicatorGap(ctrl, conf);
        deps.scheduleFit(ctrl);
    }

    function hasGroup(target: HTMLElement, groupId: string) {
        const group = normalizeGroup(groupId);
        const ctrl = target ? deps.controllerFor(target, false) : null;
        return !!(group && ctrl && ctrl.groups.has(group));
    }

    function getGroup(target: HTMLElement, groupId: string) {
        const group = normalizeGroup(groupId);
        const ctrl = target ? deps.controllerFor(target, false) : null;
        return (group && ctrl?.groups.get(group)?.master) || null;
    }

    function refreshPresentation(targets?: HTMLElement | HTMLElement[]) {
        const list = targets === undefined
            ? Array.from(document.querySelectorAll<HTMLElement>('.je-tag-host'))
            : (Array.isArray(targets) ? targets : [targets]);
        for (const target of list) {
            const ctrl = deps.controllerFor((target), false);
            if (ctrl && ctrl.host.isConnected)
                deps.presentAll(ctrl);
        }
    }

    function describe(target: HTMLElement) {
        const ctrl = target ? deps.controllerFor(target, false) : null;
        if (!ctrl)
            return [];
        const conf = deps.resolveLayout(ctrl);
        return Array.from(ctrl.groups.entries())
            .sort((a, b) => a[1].seq - b[1].seq)
            .map(([group, rec]) => ({
            group,
            slot: conf.slots[group] === 'caption' && !ctrl.outlet ? 'poster' : (conf.slots[group] || 'off'),
            seq: rec.seq,
            element: ctrl.nodes.get(group)?.[0] || null,
        }));
    }

    function clearCard(target: HTMLElement) {
        // The user review key lives on the render target (the host, or the
        // image of a card without one): a lookup still out for the old item
        // checks it before adding its chip.
        if (target?.dataset)
            delete target.dataset.jeReviewKey;
        if (target)
            s.cardData.delete(target);
        const host = deps.findHost(target);
        if (!host)
            return;
        s.cardData.delete(host);
        if (host.parentElement)
            s.cardData.delete(host.parentElement);
        delete host.dataset.jeReviewKey;
        deps.endAwait(host);
        const ctrl = host ? s.controllers.get(host) : null;
        if (!ctrl)
            return;
        forget(ctrl);
    }

    function forget(ctrl: CardController) {
        // A reused host may already be waiting for the replacement item.
        // Retiring its old controller must cancel only the old item's hold.
        if (deps.contextOf(s.awaitingData, ctrl.host)?.cardId === ctrl.itemId)
            deps.endAwait(ctrl.host);
        deps.teardown(ctrl);
        s.controllers.delete(ctrl.host);
        deps.unwatchSize(ctrl.host);
        // Its artwork watch (tags/tag-poster-colours.js) goes with it.
        JE.tagPosterColours?.release(ctrl.host);
    }

    function removeGroupEverywhere(groupId: string) {
        for (const host of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
            const reserve = deps.reservesCaption(deps.resolveLayout(s.controllers.get(host) || host), host);
            removeGroup((host), groupId);
            // The group was the last one switched on that could fill the
            // caption strip: give the reserved space back.
            const ctrl = reserve ? null : s.controllers.get((host));
            if (ctrl?.outlet && !deps.holdsGroups(ctrl.outlet)) {
                ctrl.outlet.remove();
                ctrl.outlet = null;
            }
        }
    }

    function clearAll() {
        for (const host of document.querySelectorAll<HTMLElement>('.je-tag-host'))
            clearCard((host));
        document.querySelectorAll<HTMLElement>('.je-tag-caption').forEach((el) => el.remove());
        document.querySelectorAll<HTMLElement>('[data-je-review-key]').forEach((el) => { delete (el).dataset.jeReviewKey; });
    }

    function prepareCard(target: HTMLElement) {
        if (!target || !deps.reservesCaption(deps.resolveLayout(deps.findHost(target) || target), target))
            return;
        const host = deps.ensureHost(target);
        if (!host || deps.isIgnoredContext(host))
            return;
        const ctrl = deps.controllerFor(host, true);
        // A card presented while nothing could fill the strip has no outlet yet.
        if (ctrl && (ctrl.layout !== 'caption' || (!ctrl.outlet?.isConnected && deps.captionAnchor(ctrl.host))))
            deps.presentAll(ctrl);
    }

    function syncBodyClasses() {
        if (!document.body)
            return;
        document.body.classList.toggle('je-tags-hide-on-hover', !!JE.currentSettings?.tagsHideOnHover);
    }

    function reinitialize() {
        deps.invalidateSettings();
        syncBodyClasses();
        if (s.reinitPending)
            return s.reinitPending;
        s.reinitPending = Promise.resolve().then(() => {
            s.reinitPending = null;
            deps.invalidateSettings();
            const owned = new Set();
            for (const host of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
                const el = (host);
                const reserve = deps.reservesCaption(deps.resolveLayout(s.controllers.get(el) || el), el);
                const ctrl = deps.controllerFor(el, reserve && !deps.isIgnoredContext(el));
                if (!ctrl)
                    continue;
                deps.presentAll(ctrl);
                if (ctrl.outlet)
                    owned.add(ctrl.outlet);
            }
            document.querySelectorAll<HTMLElement>('.je-tag-caption').forEach((el) => { if (!owned.has(el))
                el.remove(); });
            document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
        });
        return s.reinitPending;
    }

    return { commitGroup, removeGroup, hasGroup, getGroup, refreshPresentation, describe, clearCard, forget, removeGroupEverywhere, clearAll, prepareCard, reinitialize };
}
