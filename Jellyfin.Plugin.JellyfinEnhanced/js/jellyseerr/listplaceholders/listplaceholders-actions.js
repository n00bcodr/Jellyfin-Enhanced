// /js/jellyseerr/listplaceholders/listplaceholders-actions.js
// The "…" menu of a placeholder row/card and the edits it offers: Remove, Move up/down
// (when the row can't be dragged, B4), Link a custom entry to a title, More info.
// Mutations publish the fresh view (listplaceholders-api.js); the page modules re-render from it.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    let openMenuState = null;

    /** Closes the open menu, if any. */
    function closeMenu() {
        if (!openMenuState) return;
        const { menu, cleanup, anchor } = openMenuState;
        openMenuState = null;
        cleanup();
        menu.remove();
        anchor?.setAttribute('aria-expanded', 'false');
    }

    /**
     * Opens a small menu next to a button.
     * @param {HTMLElement} anchor - The button that opened it.
     * @param {Array<{icon: string, label: string, onClick: Function, danger?: boolean}>} items
     * @returns {HTMLElement|null} The menu element.
     */
    function openMenu(anchor, items) {
        const wasOpenForAnchor = openMenuState?.anchor === anchor;
        closeMenu();
        if (wasOpenForAnchor || !items.length) return null;
        lp.ensureStyles?.();
        const menu = document.createElement('div');
        menu.className = 'je-lp-menu';
        menu.setAttribute('role', 'menu');
        for (const item of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'je-lp-menu-item' + (item.danger ? ' je-lp-danger' : '');
            button.setAttribute('role', 'menuitem');
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = item.icon;
            const label = document.createElement('span');
            label.textContent = item.label;
            button.append(icon, label);
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
                item.onClick();
            });
            menu.appendChild(button);
        }
        document.body.appendChild(menu);
        const rect = anchor.getBoundingClientRect();
        const width = menu.offsetWidth || 220;
        const height = menu.offsetHeight || items.length * 44;
        const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
        menu.style.top = `${Math.round(top)}px`;
        menu.style.left = `${Math.round(Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)))}px`;
        anchor.setAttribute('aria-expanded', 'true');

        /** Closes on a press outside the menu and its button. @param {PointerEvent} e */
        const onPointer = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
        /** Escape closes and returns focus to the button. @param {KeyboardEvent} e */
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus?.(); } };
        /** The menu is fixed-positioned: close it when the page scrolls or resizes. */
        const onScroll = () => closeMenu();
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        openMenuState = {
            menu,
            anchor,
            cleanup: () => {
                document.removeEventListener('pointerdown', onPointer, true);
                document.removeEventListener('keydown', onKey, true);
                window.removeEventListener('scroll', onScroll, true);
                window.removeEventListener('resize', onScroll);
            }
        };
        menu.querySelector('button')?.focus();
        return menu;
    }

    /**
     * Runs a mutation that needs the current rev; on a rev conflict it retries once with
     * the fresh view the 409 carried (if the placeholder still exists there).
     * @param {Object} ctrl - Page controller ({listId, view}).
     * @param {function(Object): Promise<any>} run - Called with the view to use.
     * @param {function(Object): boolean} [stillValid] - Whether the retry still makes sense on a fresh view.
     * @returns {Promise<any>}
     */
    async function withRev(ctrl, run, stillValid) {
        try {
            return await run(ctrl.view);
        } catch (error) {
            const fresh = error?.responseJSON?.view;
            if (error?.responseJSON?.code === 'rev_conflict' && fresh && (!stillValid || stillValid(fresh))) {
                return run(fresh);
            }
            throw error;
        }
    }

    /**
     * Removes a placeholder.
     * @param {Object} ctrl - Page controller.
     * @param {Object} ph - Placeholder.
     * @returns {Promise<void>}
     */
    async function remove(ctrl, ph) {
        ctrl.noteRemoved?.(ph.id);
        try {
            await withRev(ctrl, view => lp.api.removePlaceholder(ctrl.listId, ph.id, view.rev),
                view => view.placeholders.some(p => p.id === ph.id));
            JE.toast(JE.t('listPlaceholders_removed', { title: lp.render.esc(ph.title) }), 2500);
        } catch (error) {
            ctrl.noteRemoved?.(ph.id, false);
            // The list changed first and the placeholder is gone from it (swapped in meanwhile): its
            // disappearance was taken for this removal, so the library rows/cards reload here.
            const fresh = error?.responseJSON?.view;
            if (error?.responseJSON?.code === 'rev_conflict' && fresh && !(fresh.placeholders || []).some(p => p.id === ph.id)) {
                ctrl.afterRealItemsAdded?.();
            }
            lp.toastError(error);
        }
    }

    /**
     * New playlist order with a placeholder moved one visible slot up (-1) or down (+1).
     * @param {string[]} order - Current projected order.
     * @param {string} token - The placeholder's token.
     * @param {number} delta - -1 or +1.
     * @returns {string[]|null} null when it can't move that way.
     */
    function shiftedOrder(order, token, delta) {
        const from = order.indexOf(token);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= order.length) return null;
        const next = order.slice();
        next.splice(from, 1);
        next.splice(to, 0, token);
        return next;
    }

    /**
     * Moves a placeholder one slot (no Jellyfin call: real rows keep their order).
     * @param {Object} ctrl - Playlist controller.
     * @param {Object} ph
     * @param {number} delta
     * @returns {Promise<void>}
     */
    async function move(ctrl, ph, delta) {
        try {
            await withRev(ctrl, (view) => {
                const order = shiftedOrder(view.order || [], `p:${ph.id}`, delta);
                if (!order) return null;
                return lp.api.reorder(ctrl.listId, view.rev, order, null);
            }, view => (view.order || []).includes(`p:${ph.id}`));
        } catch (error) {
            lp.toastError(error);
        }
    }

    /**
     * Shows the "…" menu for a placeholder.
     * @param {Object} ctrl - Page controller ({listId, listKind, view, canEdit, canDragPlaceholders?}).
     * @param {Object} ph
     * @param {HTMLElement} anchor
     */
    function showPlaceholderMenu(ctrl, ph, anchor) {
        const items = [];
        const view = ctrl.view || {};
        if (ph.tmdbId && JE.jellyseerrMoreInfo?.open && JE.pluginConfig?.JellyseerrEnabled) {
            items.push({ icon: 'info', label: JE.t('listPlaceholders_more_info'), onClick: () => JE.jellyseerrMoreInfo.open(Number(ph.tmdbId), ph.mediaType) });
        }
        // Admin "Add to Radarr/Sonarr" (listplaceholders-arr.js; null for non-admins, custom entries or when off).
        const arrEntry = JE.listPlaceholders?.arr?.menuItemFor?.(ph);
        if (arrEntry) items.push({ icon: arrEntry.icon, label: arrEntry.label, onClick: () => arrEntry.onSelect() });
        if (view.canEdit) {
            if (ctrl.listKind === 'playlist' && !(ctrl.canDragPlaceholders && ctrl.canDragPlaceholders())) {
                const order = view.order || [];
                const index = order.indexOf(`p:${ph.id}`);
                if (index > 0) items.push({ icon: 'arrow_upward', label: JE.t('listPlaceholders_move_up'), onClick: () => move(ctrl, ph, -1) });
                if (index >= 0 && index < order.length - 1) items.push({ icon: 'arrow_downward', label: JE.t('listPlaceholders_move_down'), onClick: () => move(ctrl, ph, 1) });
            }
            if (ph.kind === 'custom' && JE.pluginConfig?.JellyseerrEnabled && lp.search?.open) {
                items.push({ icon: 'link', label: JE.t('listPlaceholders_link'), onClick: () => lp.search.open(ctrl, { mode: 'link', placeholder: ph }) });
            }
            items.push({ icon: 'delete', label: JE.t('listPlaceholders_remove'), danger: true, onClick: () => remove(ctrl, ph) });
        }
        openMenu(anchor, items);
    }

    lp.actions = { openMenu, closeMenu, remove, move, shiftedOrder, withRev, showPlaceholderMenu };

})(window.JellyfinEnhanced);
