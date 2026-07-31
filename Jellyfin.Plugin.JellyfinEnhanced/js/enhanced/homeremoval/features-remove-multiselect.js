/**
 * @file Remove option for Jellyfin's multi-select / long-press menu, including the
 * bulk-remove confirmation dialog.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    const { showNotification, REMOVE_SURFACES, buildNativeActionSheetItem, setActionSheetItemIcon,
            fitRemoveItemToMenu, removeFromHomeSurface, closeOpenActionSheet, hideEmptyHomeSections,
            getActiveActionSheetScroller } = internal;

    // ── Multi-select / long-press menu ───────────────────────────────────────────
    // Touch devices have no per-item "…" button; a long-press opens Jellyfin's multi-select
    // menu (Select All, Mark played, …) acting on the selected cards. We add a Remove option
    // there for any selected cards that live in Continue Watching / Next Up.

    /**
     * Collects the currently selected cards that sit in a removable home surface.
     * @returns {Array<{itemId: string, surface: string, card: Element, name: string}>}
     */
    function collectSelectedRemovableCards() {
        const out = [];
        const seen = new Set();
        document.querySelectorAll('.chkItemSelect').forEach(chk => {
            if (!chk.checked) return;
            const card = chk.closest('.card[data-id]') || chk.closest('[data-id]');
            const itemId = card && card.getAttribute('data-id');
            if (!itemId || seen.has(itemId)) return;
            const surface = JE.detectCardSurface(card);
            if (surface === 'continuewatching' || surface === 'nextup') {
                seen.add(itemId);
                const name = (card.querySelector('.cardText-first, .cardText')?.textContent || '').trim();
                out.push({ itemId, surface, card, name });
            }
        });
        return out;
    }

    /** Leaves Jellyfin's multi-select mode by clicking its close control (best-effort). */
    function exitSelectionMode() {
        try { document.querySelector('.btnCloseSelectionPanel')?.click(); }
        catch (e) { /* best-effort */ }
    }

    // Close handler of the currently-open bulk-remove confirm dialog (if any), so a second
    // open can resolve/clean up the first instead of orphaning its Promise + keydown listener.
    let activeConfirmClose = null;

    /**
     * Self-contained confirmation dialog for a bulk Remove. Lists each item and which home
     * surface it will be removed from. Inline-styled so it works even when the Hidden Content
     * module (and its dialog CSS) isn't active. Resolves true to proceed, false to cancel.
     * @param {Array<{name: string, surface: string}>} targets
     * @returns {Promise<boolean>}
     */
    function confirmMultiRemove(targets) {
        return new Promise((resolve) => {
            // Cleanly tear down any confirm still open (resolve its promise + drop its listener)
            // before opening a new one, so we never orphan a pending Promise / keydown handler.
            if (activeConfirmClose) activeConfirmClose(false);

            const overlay = document.createElement('div');
            overlay.className = 'je-remove-confirm-overlay';
            // Above Jellyfin's action sheet / dialog (z-index 999999) so it's never behind a closing menu.
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';

            const dialog = document.createElement('div');
            dialog.style.cssText = 'background:linear-gradient(135deg,rgba(30,30,35,0.98),rgba(20,20,25,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:24px;max-width:460px;width:100%;color:#fff;max-height:80vh;display:flex;flex-direction:column;';

            const title = document.createElement('h3');
            title.textContent = JE.t('remove_confirm_title');
            title.style.cssText = 'margin:0 0 16px 0;font-size:18px;font-weight:600;';
            dialog.appendChild(title);

            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:0 0 20px 0;overflow-y:auto;';
            targets.forEach(t => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px;padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:6px;';
                const name = document.createElement('span');
                name.textContent = t.name || '';
                name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                const from = document.createElement('span');
                from.textContent = JE.t(REMOVE_SURFACES[t.surface].nameKey);
                from.style.cssText = 'flex:0 0 auto;font-size:12px;color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.08);padding:3px 9px;border-radius:10px;white-space:nowrap;';
                row.appendChild(name);
                row.appendChild(from);
                list.appendChild(row);
            });
            dialog.appendChild(list);

            const buttons = document.createElement('div');
            buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
            const cancel = document.createElement('button');
            cancel.setAttribute('is', 'emby-button');
            cancel.type = 'button';
            cancel.textContent = JE.t('remove_confirm_cancel');
            cancel.style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;';
            const ok = document.createElement('button');
            ok.setAttribute('is', 'emby-button');
            ok.type = 'button';
            ok.textContent = JE.t('remove_button_text');
            ok.style.cssText = 'background:rgba(220,50,50,0.65);border:1px solid rgba(220,50,50,0.7);color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;';
            buttons.appendChild(cancel);
            buttons.appendChild(ok);
            dialog.appendChild(buttons);

            const close = (result) => {
                if (activeConfirmClose === close) activeConfirmClose = null;
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
                resolve(result);
            };
            activeConfirmClose = close;
            const escHandler = (e) => { if (e.key === 'Escape') close(false); };
            cancel.addEventListener('click', () => close(false));
            ok.addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
            document.addEventListener('keydown', escHandler);

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            ok.focus();
        });
    }

    /**
     * Removes every target from its surface, then tears down the multi-select menu/selection
     * and notifies — but only if at least one removal succeeded (so a total failure leaves the
     * selection intact for a retry).
     * @param {Array<{itemId: string, surface: string, card: Element}>} targets
     * @returns {Promise<number>} how many were removed.
     */
    async function performMultiRemove(targets) {
        let removed = 0;
        for (const t of targets) {
            // Sequential — selections are small and this keeps the HC store writes ordered.
            if (await removeFromHomeSurface(t.itemId, t.surface, t.card)) removed++;
        }
        if (removed > 0) {
            closeOpenActionSheet();
            exitSelectionMode();
            showNotification(JE.t('remove_items_success'), 'success');
            hideEmptyHomeSections();
        }
        return removed;
    }

    /**
     * Label for the multi-select Remove item: the specific "Remove from …" wording when every
     * selected removable card shares one surface, or the generic "Remove" when the selection
     * mixes Continue Watching and Next Up.
     * @param {Array<{surface: string}>} targets
     * @returns {string}
     */
    function multiSelectRemoveLabel(targets) {
        const surfaces = new Set(targets.map(t => t.surface));
        if (surfaces.size === 1 && REMOVE_SURFACES[targets[0].surface]) {
            return JE.t(REMOVE_SURFACES[targets[0].surface].labelKey);
        }
        return JE.t('remove_button_text');
    }

    /**
     * Builds the Remove menu item for the multi-select menu, matching the menu's native items.
     * Removes every selected Continue Watching / Next Up card from its own surface.
     * @param {HTMLElement} scroller The multi-select menu's scroller.
     * @param {Array<{itemId: string, surface: string, card: Element}>} targets
     * @returns {HTMLElement}
     */
    function createMultiSelectRemoveButton(scroller, targets) {
        const button = buildNativeActionSheetItem(scroller, {
            dataId: 'je-multiselect-remove',
            icon: 'visibility_off',
            text: multiSelectRemoveLabel(targets)
        });
        const textEl = button.querySelector('.actionSheetItemText');

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Recollect the selection at click time, not from the build-time closure: if the
            // sheet was reused after the selection changed, act on the CURRENT selection.
            const current = collectSelectedRemovableCards();
            if (!current.length) { closeOpenActionSheet(); exitSelectionMode(); return; }

            // Bulk removal (more than one item): close the menu and confirm first, listing each
            // item and the surface it'll be removed from, so the action is never a surprise.
            if (current.length > 1) {
                closeOpenActionSheet();
                const confirmed = await confirmMultiRemove(current);
                if (!confirmed) return; // selection kept so the user can adjust
                await performMultiRemove(current);
                return;
            }

            // Single item: remove directly with in-menu progress feedback.
            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JE.t('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            await performMultiRemove(current);

            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');
        });

        return button;
    }

    /**
     * Adds the Remove option to the multi-select / long-press menu when it is open and at
     * least one selected card is in Continue Watching or Next Up. Idempotent per menu.
     */
    JE.addMultiSelectRemoveButton = () => {
        if (!JE.currentSettings.removeContinueWatchingEnabled) return;

        const scroller = getActiveActionSheetScroller();
        if (!scroller) return;
        // "Select All" is unique to Jellyfin's multi-select menu — use it as the marker.
        if (!scroller.querySelector('[data-id="selectall"]')) return;
        if (scroller.querySelector('[data-id="je-multiselect-remove"]')) return;

        const targets = collectSelectedRemovableCards();
        if (!targets.length) return;

        const removeButton = createMultiSelectRemoveButton(scroller, targets);
        const anchor = scroller.querySelector('[data-id="refresh"]')
            || scroller.querySelector('[data-id="markunplayed"]')
            || scroller.querySelector('[data-id="markplayed"]');
        if (anchor) {
            anchor.after(removeButton);
        } else {
            scroller.appendChild(removeButton);
        }
        fitRemoveItemToMenu(removeButton, scroller);
    };
})(window.JellyfinEnhanced);
