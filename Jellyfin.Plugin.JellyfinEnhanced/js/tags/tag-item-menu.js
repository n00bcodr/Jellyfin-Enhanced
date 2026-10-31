// @ts-check
// /js/tags/tag-item-menu.js
//
// "Media Tags" in Jellyfin's item menu (the ⋮ action sheet of the detail
// page and of cards), which opens the per-item editor (tags/tag-item-editor.js).
//
// jellyfin-web 12.1 builds that sheet in itemContextMenu.show(): getCommands()
// lists the rows, actionsheet.show() draws them as
// button.actionSheetMenuItem[data-id] in .actionSheetScroller and resolves
// with the clicked row's data-id after closing the sheet. Neither module is
// reachable from a plugin (no global, no hook), so the row is appended to the
// sheet once it is in the document, with the native rows' markup and classes
// (features-remove-home.js does the same for Remove from Continue Watching).
// A row id the menu does not know makes itemContextMenu reject, and both
// callers (the detail page's ⋮ and cards' ⋮) catch that, so the sheet simply
// closes; the row's own click handler opens the editor. This depends on
// those callers retaining their rejection handlers; re-check them when
// updating Jellyfin's private item-menu integration (IE-1).
//
// The item is captured when its ⋮ button is pressed (or a card is
// right-clicked), as that is the only moment the menu's item is known. A row
// is added only for a fresh capture, an item type that has poster tags, a
// sheet with the item menu's own rows, and while a poster tag type is on.
//
// Public surface: JE.tagItemMenu { inject } (tests).
(function (JE) {
    'use strict';

    const DATA_ID = 'je-media-tags';
    const CONTEXT_TTL_MS = 5000;
    /** Rows only the item menu (itemContextMenu.getCommands) has: a sheet without one is another menu. */
    const ITEM_ROWS = ['addtocollection', 'addtoplaylist', 'share', 'edit', 'editimages', 'editsubtitles', 'identify', 'moremediainfo', 'refresh', 'delete', 'download', 'copy-stream', 'playallfromhere', 'queueallfromhere', 'resume', 'play', 'queue', 'shuffle', 'instantmix', 'multiSelect', 'removefromcollection'];
    const ITEM_ROW_SELECTOR = ITEM_ROWS.map((id) => `[data-id="${id}"]`).join(', ');

    /**
     * @typedef {Object} MenuContext
     * @property {string} itemId - Normalised id.
     * @property {string|null} type - The card's data-type, or the fetched item's.
     * @property {Promise<Object|null>|null} item - The detail page's item, being read.
     * @property {HTMLElement|null} opener - The ⋮ button (focus returns there).
     * @property {number} ts
     */

    /** @type {MenuContext|null} */
    let context = null;

    /**
     * The id of the item the visible detail page shows (its route's id=).
     * @returns {string|null}
     */
    function detailItemId() {
        const query = (window.location.hash.split('?')[1] || window.location.search.slice(1) || '');
        const id = new URLSearchParams(query).get('id');
        return id ? JE.core.tagLook?.normalizeId(id) || null : null;
    }

    /**
     * Remember the item whose menu is about to open.
     * @param {Event} e
     */
    function capture(e) {
        const el = /** @type {HTMLElement|null} */ (e.target instanceof Element ? e.target : null);
        if (!el || el.closest('.actionSheet, .dialogContainer, .je-tie-backdrop')) return;
        const more = /** @type {HTMLElement|null} */ (el.closest('.btnMoreCommands'));
        if (more && more.closest('#itemDetailPage')) {
            const itemId = detailItemId();
            if (!itemId) { context = null; return; }
            const userId = ApiClient.getCurrentUserId();
            context = { itemId, type: null, item: ApiClient.getItem(userId, itemId).catch(() => null), opener: more, ts: Date.now() };
            return;
        }
        const button = /** @type {HTMLElement|null} */ (e.type === 'contextmenu' ? el : el.closest('button[data-action="menu"]'));
        if (!button) return;
        const card = /** @type {HTMLElement|null} */ (button.closest('.card[data-id], .listItem[data-id], [data-id][data-type]'));
        const itemId = card ? JE.core.tagLook?.normalizeId(card.dataset.id || '') : null;
        if (!itemId) { if (e.type !== 'contextmenu') context = null; return; }
        context = { itemId, type: card?.dataset.type || null, item: null, opener: e.type === 'contextmenu' ? card : button, ts: Date.now() };
    }

    /**
     * The action sheet on screen: Jellyfin leaves closed sheets in the
     * document for their exit animation, so the newest visible one.
     * @returns {HTMLElement|null}
     */
    function activeScroller() {
        const scrollers = document.querySelectorAll('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            const el = /** @type {HTMLElement} */ (scrollers[i]);
            if (el.offsetParent !== null || el.getClientRects().length) return el;
        }
        // Nothing reports a box (a sheet still being laid out): the newest one.
        return /** @type {HTMLElement|null} */ (scrollers[scrollers.length - 1] || null);
    }

    /**
     * A row with the native rows' markup: a sibling's classes (font size,
     * focus scaling per device), a class-based Material icon and the text in
     * .actionSheetItemText (as textContent).
     * @param {HTMLElement} scroller
     * @returns {HTMLButtonElement}
     */
    function buildRow(scroller) {
        const shared = JE.internals?.features?.buildNativeActionSheetItem;
        if (typeof shared === 'function') return shared(scroller, { dataId: DATA_ID, icon: 'local_offer', text: JE.t('tag_item_editor_menu') });
        const ref = scroller.querySelector('.actionSheetMenuItem');
        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.type = 'button';
        button.className = (ref?.getAttribute('class') || 'listItem listItem-button actionSheetMenuItem').replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
        button.dataset.id = DATA_ID;
        const icon = document.createElement('span');
        icon.className = 'actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons local_offer';
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('div');
        body.className = 'listItemBody actionsheetListItemBody';
        const text = document.createElement('div');
        text.className = 'listItemBodyText actionSheetItemText';
        text.textContent = JE.t('tag_item_editor_menu');
        body.appendChild(text);
        button.append(icon, body);
        return /** @type {HTMLButtonElement} */ (button);
    }

    /**
     * Keep a sheet anchored to its button on screen after the row made it
     * taller (Jellyfin placed it for its own rows): move it up as far as needed.
     * @param {HTMLElement} scroller
     */
    function fitSheet(scroller) {
        const sheet = /** @type {HTMLElement|null} */ (scroller.closest('.actionSheet, .dialog'));
        if (!sheet) return;
        const top = parseFloat(sheet.style.top);
        if (!Number.isFinite(top)) return;
        const viewport = document.documentElement.clientHeight || window.innerHeight || 0;
        const overflow = top + sheet.offsetHeight - (viewport - 10);
        if (overflow > 0) sheet.style.top = `${Math.max(10, top - overflow)}px`;
    }

    /**
     * Add the row to the open item menu for the captured item (or drop a
     * stale one a reused sheet still holds).
     * @returns {Promise<void>}
     */
    async function inject() {
        const scroller = activeScroller();
        if (!scroller) return;
        const existing = /** @type {HTMLElement|null} */ (scroller.querySelector(`[data-id="${DATA_ID}"]`));
        const ctx = context;
        if (!scroller.querySelector(ITEM_ROW_SELECTOR) || !ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) {
            if (existing && (!ctx || existing.dataset.jeItemId !== ctx.itemId)) existing.remove();
            return;
        }
        if (existing?.dataset.jeItemId === ctx.itemId) return;
        existing?.remove();
        let type = ctx.type;
        let item = null;
        if (!type && ctx.item) {
            item = await ctx.item;
            type = item?.Type || null;
            if (context !== ctx || !scroller.isConnected) return;
        }
        // One ⋮ press, one item menu: a later sheet (multi-select's, another
        // feature's) never gets a row for this item.
        context = null;
        if (!JE.tagItemEditor?.anyTagsOn?.() || !type || !JE.tagItemEditor.TYPES.has(type)) return;
        if (scroller.querySelector(`[data-id="${DATA_ID}"]`)) return;
        const row = buildRow(scroller);
        row.dataset.jeItemId = ctx.itemId;
        const opener = ctx.opener;
        const itemId = ctx.itemId;
        // The sheet closes itself (it resolves with this row's id) and hands
        // focus back to its button; the editor opens right after.
        row.addEventListener('click', () => {
            setTimeout(() => { JE.tagItemEditor.open(itemId, { opener, item: item || undefined }); }, 0);
        });
        const share = scroller.querySelector('[data-id="share"]');
        if (share) share.before(row);
        else scroller.appendChild(row);
        fitSheet(scroller);
    }

    let scheduled = false;
    const SHEET_SELECTOR = '.actionSheet, .actionSheetScroller, .dialogContainer';
    /**
     * Whether a mutation batch opened or changed an action sheet.
     * @param {MutationRecord[]} mutations
     * @returns {boolean}
     */
    function touchesSheet(mutations) {
        for (const m of mutations) {
            if (/** @type {Element} */ (m.target).closest?.(SHEET_SELECTOR)) return true;
            for (const node of m.addedNodes) {
                if (node.nodeType === 1 && (/** @type {Element} */ (node).matches(SHEET_SELECTOR) || /** @type {Element} */ (node).querySelector(SHEET_SELECTOR))) return true;
            }
        }
        return false;
    }

    document.addEventListener('click', capture, true);
    document.addEventListener('contextmenu', capture, true);
    // Synchronous priority: the row is in place before the sheet's first frame.
    JE.core.dom?.onBodyMutation?.('tag-item-menu', (mutations) => {
        if (scheduled || !context || !touchesSheet(mutations)) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            inject().catch((err) => console.warn('🪼 Jellyfin Enhanced [TagLook]: could not add Media Tags to the item menu:', err));
        });
    }, { priority: 1 });
    JE.session?.onUserChange?.('tag-item-menu', () => { context = null; });

    JE.tagItemMenu = { inject, DATA_ID };
})(window.JellyfinEnhanced);
