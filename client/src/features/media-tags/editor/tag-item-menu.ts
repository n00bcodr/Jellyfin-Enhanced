import { apiClient, mediaTagsContext, type TagRuntimeBridge } from '../host';
import { isRecord, text, type JsonRecord } from '../pipeline/dto';

/** The item whose menu is about to open, captured from the press that opens it. */
interface MenuContext {
    /** Normalised id. */
    itemId: string;
    /** The card's data-type, or the fetched item's. */
    type: string | null;
    /** The detail page's item, being read. */
    item: Promise<unknown> | null;
    /** The ⋮ button (focus returns there). */
    opener: HTMLElement | null;
    ts: number;
}
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
export function createItemMenu(JE: TagRuntimeBridge, alsoCapture?: (e: Event) => void) {

    const DATA_ID = 'je-media-tags';
    const CONTEXT_TTL_MS = 5000;
    /** Rows only the item menu (itemContextMenu.getCommands) has: a sheet without one is another menu. */
    const ITEM_ROWS = ['addtocollection', 'addtoplaylist', 'share', 'edit', 'editimages', 'editsubtitles', 'identify', 'moremediainfo', 'refresh', 'delete', 'download', 'copy-stream', 'playallfromhere', 'queueallfromhere', 'resume', 'play', 'queue', 'shuffle', 'instantmix', 'multiSelect', 'removefromcollection'];
    const ITEM_ROW_SELECTOR = ITEM_ROWS.map((id) => `[data-id="${id}"]`).join(', ');
    /**
     * One context for this bridge (review D3). Building it reads nothing and it keeps no per-open state: `peer()`
     * reads `JE.homeRemoval` on each call, so a row built later still sees a facade published after this ran.
     */
    const featureCtx = mediaTagsContext(JE);

    let context: MenuContext|null = null;

    /**
     * The id of the item the visible detail page shows (its route's id=).
     * */
    function detailItemId(): string|null {
        const query = (window.location.hash.split('?')[1] || window.location.search.slice(1) || '');
        const id = new URLSearchParams(query).get('id');
        return id ? JE.core.tagLook?.normalizeId(id) || null : null;
    }

    /**
     * Remember the item whose menu is about to open.
     */
    function capture(e: Event) {
        // The Maintainerr rows (same bundle) learn the menu's item from the same press.
        alsoCapture?.(e);
        const el = e.target instanceof HTMLElement ? e.target : null;
        if (!el || el.closest('.actionSheet, .dialogContainer, .je-tie-backdrop')) return;
        const more = el.closest<HTMLElement>('.btnMoreCommands');
        if (more && more.closest('#itemDetailPage')) {
            const itemId = detailItemId();
            if (!itemId) { context = null; return; }
            const userId = apiClient().getCurrentUserId();
            context = { itemId, type: null, item: apiClient().getItem(userId, itemId).catch(() => null), opener: more, ts: Date.now() };
            return;
        }
        const button = e.type === 'contextmenu' ? el : el.closest<HTMLElement>('button[data-action="menu"]');
        if (!button) return;
        const card = button.closest<HTMLElement>('.card[data-id], .listItem[data-id], [data-id][data-type]');
        const itemId = card ? JE.core.tagLook?.normalizeId(card.dataset.id || '') : null;
        if (!itemId) { if (e.type !== 'contextmenu') context = null; return; }
        context = { itemId, type: card?.dataset.type || null, item: null, opener: e.type === 'contextmenu' ? card : button, ts: Date.now() };
    }

    /**
     * The action sheet on screen: Jellyfin leaves closed sheets in the
     * document for their exit animation, so the newest visible one.
     * */
    function activeScroller(): HTMLElement|null {
        const scrollers = document.querySelectorAll<HTMLElement>('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            const el = scrollers[i];
            if (el && (el.offsetParent !== null || el.getClientRects().length)) return el;
        }
        // Nothing reports a box (a sheet still being laid out): the newest one.
        return (scrollers[scrollers.length - 1] || null);
    }

    /**
     * A row with the native rows' markup: a sibling's classes (font size,
     * focus scaling per device), a class-based Material icon and the text in
     * .actionSheetItemText (as textContent).
     * */
    function buildRow(scroller: HTMLElement): HTMLButtonElement {
        const shared = featureCtx.peer('homeRemoval')?.buildNativeActionSheetItem;
        if (typeof shared === 'function') return shared(scroller, { dataId: DATA_ID, icon: 'local_offer', text: JE.t('common_media_tags') });
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
        text.textContent = JE.t('common_media_tags');
        body.appendChild(text);
        button.append(icon, body);
        return button;
    }

    /**
     * Keep a sheet anchored to its button on screen after the row made it
     * taller (Jellyfin placed it for its own rows): move it up as far as needed.
     */
    function fitSheet(scroller: HTMLElement) {
        const sheet = scroller.closest<HTMLElement>('.actionSheet, .dialog');
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
     * */
    async function inject(): Promise<void> {
        const scroller = activeScroller();
        if (!scroller) return;
        const existing = scroller.querySelector<HTMLElement>(`[data-id="${DATA_ID}"]`);
        const ctx = context;
        if (!scroller.querySelector(ITEM_ROW_SELECTOR) || !ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) {
            if (existing && (!ctx || existing.dataset.jeItemId !== ctx.itemId)) existing.remove();
            return;
        }
        if (existing?.dataset.jeItemId === ctx.itemId) return;
        existing?.remove();
        let type = ctx.type;
        let item: JsonRecord | null = null;
        if (!type && ctx.item) {
            const read = await ctx.item;
            item = isRecord(read) ? read : null;
            type = text(item?.Type);
            if (context !== ctx || !scroller.isConnected) return;
        }
        // One ⋮ press, one item menu: a later sheet (multi-select's, another
        // feature's) never gets a row for this item.
        context = null;
        const editor = JE.tagItemEditor;
        if (!editor?.anyTagsOn?.() || !type || !editor.TYPES.has(type)) return;
        if (scroller.querySelector(`[data-id="${DATA_ID}"]`)) return;
        const row = buildRow(scroller);
        row.dataset.jeItemId = ctx.itemId;
        const opener = ctx.opener;
        const itemId = ctx.itemId;
        // The sheet closes itself (it resolves with this row's id) and hands
        // focus back to its button; the editor opens right after.
        row.addEventListener('click', () => {
            setTimeout(() => { void editor.open(itemId, { opener, ...(item ? { item } : {}) }); }, 0);
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
     * */
    function touchesSheet(mutations: MutationRecord[]): boolean {
        for (const m of mutations) {
            if (m.target instanceof Element && m.target.closest(SHEET_SELECTOR)) return true;
            for (const node of m.addedNodes) {
                if (node instanceof Element && (node.matches(SHEET_SELECTOR) || node.querySelector(SHEET_SELECTOR))) return true;
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
}
