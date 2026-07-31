/**
 * @file Remove from Continue Watching / Next Up: surface detection, the server
 * POST + optimistic hide, and the per-item action-sheet Remove button.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    /**
     * Shows notifications using Jellyfin's built-in notification system.
     * @param {string} message The message to display.
     * @param {string} [type='info'] The type of notification ('info', 'error', 'success').
     */
    const showNotification = (message, type = 'info') => {
        try {
            if (window.Dashboard?.alert) {
                window.Dashboard.alert(message);
            } else if (window.Emby?.Notifications) {
                window.Emby.Notifications.show({ title: message, type: type, timeout: 3000 });
            } else {
                console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
            }
        } catch (e) {
            console.error("🪼 Jellyfin Enhanced: Failed to show notification", e);
        }
    };

    // The two home-screen surfaces the Remove feature can act on. Each maps to a server
    // hide endpoint, the action-sheet label, and the HideScope persisted in hidden-content.json.
    const REMOVE_SURFACES = {
        continuewatching: { path: 'continue-watching', labelKey: 'remove_from_continue_watching', nameKey: 'remove_surface_continue_watching', successKey: 'remove_continue_watching_success' },
        nextup: { path: 'next-up', labelKey: 'remove_from_next_up', nameKey: 'remove_surface_next_up', successKey: 'remove_next_up_success' }
    };

    /**
     * Builds a menu item that matches the native action-sheet items in the given sheet. It
     * copies a sibling item's class list (so font size, borders and focus scaling match the
     * current sheet and device — Jellyfin adds `actionsheet-xlargeFont` on mobile, etc.) and
     * uses Jellyfin's own item structure: a class-based Material icon on an empty span plus
     * `listItemBody`/`actionSheetItemText`. It is parsed via innerHTML so the `is="emby-button"`
     * custom element upgrades (ripple) exactly like a native item.
     * @param {HTMLElement} scroller The `.actionSheetScroller` the item will live in.
     * @param {{dataId: string, icon: string, text: string}} opts
     * @returns {HTMLElement}
     */
    function buildNativeActionSheetItem(scroller, opts) {
        const ref = scroller.querySelector('.actionSheetMenuItem');
        // Mirror a real item's classes (minus any transient selection state) so sizing is identical.
        const itemClass = (ref ? ref.getAttribute('class') : 'listItem listItem-button actionSheetMenuItem')
            .replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
        const tmp = document.createElement('div');
        tmp.innerHTML =
            `<button is="emby-button" type="button" class="${itemClass}" data-id="${opts.dataId}">`
            + `<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${opts.icon}" aria-hidden="true"></span>`
            + `<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText"></div></div>`
            + `</button>`;
        const button = tmp.firstElementChild;
        // textContent (never innerHTML) for the label — matches native escapeHtml and is injection-safe.
        button.querySelector('.actionSheetItemText').textContent = opts.text;
        return button;
    }

    /** Swaps a native action-sheet item's Material icon (class-based, like Jellyfin's own items). */
    function setActionSheetItemIcon(button, iconName) {
        const span = button.querySelector('.actionsheetMenuItemIcon');
        if (span) {
            span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${iconName}`;
        }
    }

    /**
     * Keeps the Remove item one line and on-screen. Our "Remove from …" label is wider than the
     * sheet's native items, but Jellyfin sized + positioned the sheet (a `position:fixed` dialog
     * with an inline `left`) for its content BEFORE we added our item, so the now-wider sheet can
     * spill past the right edge. We re-run Jellyfin's own overflow correction: if the sheet still
     * fits the viewport, nudge it left so the whole one-line label shows; only if the label is
     * wider than the entire screen do we wrap it. Reads offsetWidth / inline left (both unaffected
     * by the open animation's transform). Call AFTER inserting the item.
     * @param {HTMLElement} button The already-inserted item.
     * @param {HTMLElement} scroller The action-sheet scroller.
     */
    function fitRemoveItemToMenu(button, scroller) {
        try {
            const dlg = scroller.closest('.dialog, .actionSheet');
            const viewportW = document.documentElement.clientWidth || window.innerWidth || 0;
            if (!dlg || !viewportW) return;

            const left = parseFloat(dlg.style.left);
            // Only positioned (corner-anchored) sheets have an inline left; centered / full-width
            // sheets need no help — a long label just wraps within their width.
            if (!Number.isFinite(left)) return;

            const width = dlg.offsetWidth;
            if (width <= viewportW - 20) {
                // Fits on screen at one line — shift it left if it currently spills past the edge.
                if (left + width > viewportW - 10) {
                    dlg.style.left = Math.max(10, viewportW - width - 10) + 'px';
                }
            } else {
                // Too wide for the screen even pinned to the edge → wrap the label to fit.
                dlg.style.left = '10px';
                button.style.maxWidth = (viewportW - 24) + 'px';
                const text = button.querySelector('.actionSheetItemText');
                if (text) text.style.whiteSpace = 'normal';
            }
        } catch (e) { /* leave native sizing */ }
    }

    // How long a captured menu context stays valid. The action-sheet observer fires within
    // ~150ms of a menu opening; this bounds how stale a context can be before we ignore it.
    const REMOVE_CONTEXT_TTL_MS = 5000;

    /**
     * Determines which home-screen surface a card belongs to, using locale-independent
     * signals so detection survives translated section titles and custom themes:
     *   • Next Up — the section title is a link to the Next Up list (`?type=nextup`).
     *   • Continue Watching — resume cards carry a `data-positionticks` playback position.
     * A localized section-title text check is kept as a last-resort fallback.
     * @param {Element} el A `.card` element, or any element inside/representing one.
     * @returns {'continuewatching'|'nextup'|null}
     */
    JE.detectCardSurface = function(el) {
        if (!el) return null;
        const card = (typeof el.closest === 'function' ? el.closest('.card') : null) || el;
        const section = typeof card.closest === 'function'
            ? card.closest('.section, .verticalSection, .homeSection')
            : null;

        // Next Up: the section title links to the Next Up list — present regardless of locale.
        if (section && section.querySelector('a[href*="type=nextup"]')) return 'nextup';

        // Continue Watching: only resume cards expose a playback position.
        const ticks = (card.getAttribute && card.getAttribute('data-positionticks'))
            || (el.getAttribute && el.getAttribute('data-positionticks'));
        if (ticks) return 'continuewatching';

        // Fallback for markup/themes without the link or ticks: localized section title text.
        if (section) {
            const title = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '')
                .toLowerCase().trim();
            if (title.includes('next up')) return 'nextup';
            if (title.includes('continue watching')) return 'continuewatching';
        }
        return null;
    };

    /**
     * Optimistically hides the just-removed card. Prefers hiding the exact card the user
     * acted on (so the same item shown in another row is never blanked); if that element is
     * gone, falls back to cards whose detected surface matches the one removed from.
     * @param {string} itemId Jellyfin item ID.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The specific card element the action was triggered from.
     */
    function optimisticHideRemovedCard(itemId, surface, card) {
        try {
            if (card && card.isConnected) {
                card.style.display = 'none';
                return;
            }
            // Fallback (card re-rendered/detached): hide matching cards on the same surface only.
            document.querySelectorAll(`.card[data-id="${CSS.escape(itemId)}"]`).forEach(c => {
                if (JE.detectCardSurface(c) === surface) {
                    c.style.display = 'none';
                }
            });
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: optimistic DOM-hide failed', e);
        }
    }

    /**
     * Non-destructive removal from a home surface (Continue Watching / Next Up):
     * server POST + scoped optimistic DOM hide. Playback position is always preserved.
     * @param {string} itemId Jellyfin item ID.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The specific card element the action was triggered from.
     * @returns {Promise<boolean>}
     */
    async function removeFromHomeSurface(itemId, surface, card) {
        const config = REMOVE_SURFACES[surface];
        const userId = ApiClient.getCurrentUserId();
        if (!userId || !itemId || !config) {
            showNotification(JE.t('remove_continue_watching_error'), "error");
            return false;
        }

        // Flush pending HC save BEFORE the POST so a later debounce can't clobber the just-written entry.
        // If the flush fails the debounce is rescheduled inside flushPendingSave; abort the write so we
        // don't proceed on top of stale server state.
        try {
            await JE.hiddenContent?.flushPendingSave?.();
        } catch (e) {
            showNotification(JE.t('remove_continue_watching_error_api', { error: e?.statusText || JE.t('unknown_error') }), "error");
            return false;
        }

        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/${config.path}/hide/${itemId}`),
                data: '{}',
                contentType: 'application/json',
                dataType: 'json',
                headers: { 'Content-Type': 'application/json' }
            });

            optimisticHideRemovedCard(itemId, surface, card);

            // Local-cache mirror only — server already wrote the canonical entry; a refetch would risk a clobber.
            try {
                JE.hiddenContent?.markScopedHidden?.(itemId, surface);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: markScopedHidden mirror failed', e);
            }
            return true;
        } catch (error) {
            const errorMessage = error.responseJSON?.message
                || error.responseJSON?.Message
                || error.statusText
                || JE.t('unknown_error');
            showNotification(JE.t('remove_continue_watching_error_api', { error: errorMessage }), "error");
            return false;
        }
    }

    // Closes any open action sheet via dialog.close() / Escape; never synthetic mouse events (they reopen the sheet).
    function closeOpenActionSheet() {
        try {
            const dialogs = document.querySelectorAll('dialog[open]');
            let dispatched = false;
            for (const dlg of dialogs) {
                if (typeof dlg.close === 'function') {
                    try { dlg.close(); dispatched = true; } catch (e) { /* not a real dialog */ }
                }
            }
            if (dispatched) return true;

            // Escape-keydown fallback targets the sheet directly — dispatching on `document` is
            // intercepted by JE's global shortcuts. Jellyfin leaves dismissed sheets in the DOM,
            // so target the VISIBLE one (newest), not the first (possibly stale/hidden) match.
            const sheets = [...document.querySelectorAll('.actionSheet, .actionsheet, .dialogContainer .dialog, .dialog.opened')];
            const sheet = sheets.reverse().find(s => s.offsetParent !== null) || sheets[0];
            if (sheet) {
                sheet.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                    bubbles: true, cancelable: true
                }));
            }
            return true;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: action sheet close failed', err);
            return false;
        }
    }

    /** Hides Continue Watching / Next Up rows whose visible-card count is zero so the title doesn't linger. */
    function hideEmptyHomeSections() {
        try {
            const sections = document.querySelectorAll('.verticalSection, .section, .homeSection');
            for (const section of sections) {
                const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
                const title = (titleEl?.textContent || '').toLowerCase().trim();
                const isCW = title.startsWith('continue watching');
                const isNextUp = title.startsWith('next up');
                if (!isCW && !isNextUp) continue;

                const cards = section.querySelectorAll('.card[data-positionticks], .card[data-id]');
                let visibleCount = 0;
                for (const card of cards) {
                    if (card.classList.contains('je-hidden')) continue;
                    if (card.style.display === 'none') continue;
                    visibleCount++;
                }
                if (visibleCount === 0) section.style.display = 'none';
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: hideEmptyHomeSections failed', err);
        }
    }
    JE.hideEmptyHomeSections = hideEmptyHomeSections;

    /**
     * Creates the surface-specific "Remove from …" button for the per-item action sheet,
     * rendered to match the sheet's native items. The bound item + surface are stamped onto
     * the element so a reused action sheet can tell whether an existing button still matches.
     * @param {HTMLElement} scroller The action-sheet scroller it will be inserted into.
     * @param {string} itemId The ID of the item.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The source card element, for a precise optimistic hide.
     * @returns {HTMLElement} The created button element.
     */
    function createRemoveButton(scroller, itemId, surface, card) {
        const config = REMOVE_SURFACES[surface] || REMOVE_SURFACES.continuewatching;
        const button = buildNativeActionSheetItem(scroller, {
            dataId: 'remove-continue-watching',
            icon: 'visibility_off',
            text: JE.t(config.labelKey)
        });
        button.dataset.jeItemId = itemId;
        button.dataset.jeSurface = surface;
        const textEl = button.querySelector('.actionSheetItemText');

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JE.t('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            const success = await removeFromHomeSurface(itemId, surface, card);

            // Restore visuals BEFORE close — a stuck sheet under odd themes is better than a stuck "Removing…" label.
            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');

            if (success) {
                const closed = closeOpenActionSheet();
                showNotification(JE.t(config.successKey), closed ? "success" : "info");
                hideEmptyHomeSections();
            }
        });

        return button;
    }

    /**
     * Returns the scroller of the action sheet that is actually on screen. Jellyfin leaves
     * dismissed action-sheet DOM behind, so the first `.actionSheetScroller` in the document
     * can be a stale/hidden one — pick the newest visible scroller instead.
     * @returns {HTMLElement|null}
     */
    function getActiveActionSheetScroller() {
        const scrollers = document.querySelectorAll('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            if (scrollers[i].offsetParent !== null) return scrollers[i];
        }
        return scrollers.length ? scrollers[scrollers.length - 1] : null;
    }

    /**
     * Adds the Remove button to the per-item action sheet for the item whose menu was just
     * opened. The action sheet content element is reused across opens, so a Remove button
     * from a previous item can linger; this reconciles the button against the freshly-captured
     * context (set on the menu mousedown / right-click) and removes any stale one.
     *
     * Two guards keep the button from leaking onto an unrelated sheet:
     *   • it only acts on a recent trigger (REMOVE_CONTEXT_TTL_MS), and
     *   • it only injects into a sheet that carries a media-item action (resume/play), so
     *     non-item sheets (sort menus, OSD audio/subtitle pickers, multi-select) are skipped.
     * The context is consumed once handled so a later sheet can't reuse it.
     */
    JE.addRemoveButton = () => {
        if (!JE.currentSettings.removeContinueWatchingEnabled) return;

        const scroller = getActiveActionSheetScroller();
        if (!scroller) return;

        const existing = scroller.querySelector('[data-id="remove-continue-watching"]');
        // Only a media-item action sheet exposes play/resume; anything else isn't an item menu.
        const insertionPoint = scroller.querySelector('[data-id="playallfromhere"]')
            || scroller.querySelector('[data-id="resume"]')
            || scroller.querySelector('[data-id="play"]');

        // Non-item sheet (sort/OSD/multi-select). It must never host the per-item Remove button,
        // so strip one that leaked in via a reused scroller — even with no fresh context — then bail.
        if (!insertionPoint) { if (existing) existing.remove(); return; }

        const ctx = JE.state.removeContext;
        // Media-item sheet but no recent trigger: leave any existing button untouched (don't strip
        // a still-valid button while its sheet is open; a fresh trigger reconciles it).
        if (!ctx || !ctx.itemId || (Date.now() - (ctx.ts || 0)) > REMOVE_CONTEXT_TTL_MS) return;

        const wantSurface = REMOVE_SURFACES[ctx.surface] ? ctx.surface : null;
        if (existing) {
            // Keep an already-correct button (avoids flicker on repeated observer fires).
            if (wantSurface && existing.dataset.jeItemId === ctx.itemId && existing.dataset.jeSurface === wantSurface) {
                JE.state.removeContext = null;
                return;
            }
            existing.remove();
        }
        if (!wantSurface) { JE.state.removeContext = null; return; }

        const removeButton = createRemoveButton(scroller, ctx.itemId, wantSurface, ctx.card);
        insertionPoint.after(removeButton);
        fitRemoveItemToMenu(removeButton, scroller);
        // Consume the context: one menu-open yields one button; later observer fires (or an
        // unrelated sheet opened within the TTL) must not re-inject from this same context.
        JE.state.removeContext = null;
    };

    // Shared with the multi-select Remove menu (features-remove-multiselect.js).
    internal.showNotification = showNotification;
    internal.REMOVE_SURFACES = REMOVE_SURFACES;
    internal.buildNativeActionSheetItem = buildNativeActionSheetItem;
    internal.setActionSheetItemIcon = setActionSheetItemIcon;
    internal.fitRemoveItemToMenu = fitRemoveItemToMenu;
    internal.removeFromHomeSurface = removeFromHomeSurface;
    internal.closeOpenActionSheet = closeOpenActionSheet;
    internal.hideEmptyHomeSections = hideEmptyHomeSections;
    internal.getActiveActionSheetScroller = getActiveActionSheetScroller;

})(window.JellyfinEnhanced);
