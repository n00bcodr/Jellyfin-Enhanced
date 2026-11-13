import { apiClient, mediaTagsContext, type TagRuntimeBridge } from '../host';
import { isRecord, text } from '../pipeline/dto';
import CSS from './maintainerr-item-menu.css';

// Maintainerr actions in Jellyfin's item menu (the ⋮ action sheet of the
// detail page and of cards), for administrators only: "Mark for removal" on
// an item Maintainerr does not list, and "Keep" plus "Postpone removal" on one
// it does. Movies and series. The rows call the plugin's admin-only
// /JellyfinEnhanced/maintainerr routes; the Maintainerr address and key never
// reach the browser, and the server refuses non-administrators regardless of
// what this module shows (upstream 481a10ee, tags/maintainerr-item-menu.js).
//
// Mark and Keep apply at once and show a toast with Undo (which runs the
// opposite call); there is no confirm dialog. Postpone opens a small chooser
// (a few day counts, a custom count, or a timer reset).
//
// The rows are appended to the sheet the way tag-item-menu.ts appends "Media
// Tags" (jellyfin-web's itemContextMenu and actionsheet are not reachable
// from a plugin): the item is captured when its ⋮ button is pressed (through
// the Media Tags row's own capture listener, which hands every press to
// `capture` here, so the page holds one pair of listeners for both), the rows
// are added once the sheet is in the document, and a row id the menu does
// not know makes the sheet simply close while the row's own click handler
// runs. Re-check this with Jellyfin's private item-menu changes (IE-1).
//
// The output js/tags/tag-item-menu.js carries this module after the Media
// Tags row (the bundle's load order is pinned, so it has no script of its own).
//
// Public surface: JE.maintainerrMenu { inject, postpone, ROWS } (tests).

/** The item whose menu is about to open, captured from the press that opens it. */
interface MenuContext {
    /** Normalised id. */
    itemId: string;
    /** The card's data-type, or the fetched item's. */
    type: string | null;
    /** The detail page's item, being read. */
    item: Promise<unknown> | null;
    /** The ⋮ button or card (focus returns there). */
    opener: HTMLElement | null;
    ts: number;
}

/** GET maintainerr/item/{id} and every action's answer (MaintainerrItemState). */
export interface MaintainerrItemState {
    ItemId?: string;
    Marked?: boolean;
    CollectionId?: number | null;
    CollectionName?: string | null;
    DeleteAt?: number | null;
    Supported?: boolean;
}

export interface MaintainerrMenu {
    inject(): Promise<void>;
    postpone(itemId: string, state: MaintainerrItemState, opener: HTMLElement | null): void;
    ROWS: Readonly<{ mark: string; keep: string; postpone: string }>;
}

/** A refused request: the server's reason (its {error}) as the message, and the HTTP status. */
class RequestError extends Error {
    constructor(message: string, readonly status: number | undefined) {
        super(message);
    }
}

/** The menu, and the capture the item menu's click and contextmenu listener hands every press to. */
export interface MaintainerrMenuParts { menu: MaintainerrMenu; capture(e: Event): void }

export function createMaintainerrMenu(JE: TagRuntimeBridge): MaintainerrMenuParts {
    const ROWS = Object.freeze({ mark: 'je-maintainerr-mark', keep: 'je-maintainerr-keep', postpone: 'je-maintainerr-postpone' });
    const ROW_SELECTOR = Object.values(ROWS).map((id) => `[data-id="${id}"]`).join(', ');
    const TYPES = new Set(['Movie', 'Series']);
    const CONTEXT_TTL_MS = 5000;
    const DAY_MS = 86400000;
    const QUICK_DAYS = [7, 14, 30, 90];
    const MAX_DAYS = 3650;
    /** Rows only the item menu (itemContextMenu.getCommands) has: a sheet without one is another menu. */
    const ITEM_ROWS = ['addtocollection', 'addtoplaylist', 'share', 'edit', 'editimages', 'editsubtitles', 'identify', 'moremediainfo', 'refresh', 'delete', 'download', 'copy-stream', 'playallfromhere', 'queueallfromhere', 'resume', 'play', 'queue', 'shuffle', 'instantmix', 'multiSelect', 'removefromcollection'];
    const ITEM_ROW_SELECTOR = ITEM_ROWS.map((id) => `[data-id="${id}"]`).join(', ');
    const LOG = '🪼 Jellyfin Enhanced [Maintainerr]:';
    const featureCtx = mediaTagsContext(JE);

    let context: MenuContext | null = null;
    let adminCheck: Promise<boolean> | null = null;

    /** The server offers the actions (the switch and a Maintainerr URL). */
    function enabled(): boolean {
        return JE.pluginConfig?.MaintainerrActionsAvailable === true;
    }

    /** The signed-in user is an administrator (asked once per signed-in user). */
    function isAdmin(): Promise<boolean> {
        adminCheck ??= Promise.resolve()
            .then(() => apiClient().getCurrentUser())
            .then((user) => isRecord(user) && isRecord(user.Policy) && user.Policy.IsAdministrator === true)
            .catch(() => { adminCheck = null; return false; });
        return adminCheck;
    }

    function normalizeId(id: string): string | null {
        const clean = String(id || '').replace(/-/g, '').toLowerCase();
        return /^[0-9a-f]{32}$/.test(clean) ? clean : null;
    }

    /** The id of the item the visible detail page shows (its route's id=). */
    function detailItemId(): string | null {
        const query = (window.location.hash.split('?')[1] || window.location.search.slice(1) || '');
        const id = new URLSearchParams(query).get('id');
        return id ? normalizeId(id) : null;
    }

    /** Remember the item whose menu is about to open. */
    function capture(e: Event): void {
        const el = e.target instanceof Element ? e.target : null;
        if (!el || el.closest('.actionSheet, .dialogContainer, .je-mt-backdrop')) return;
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
        const itemId = card ? normalizeId(card.dataset.id || '') : null;
        if (!itemId) { if (e.type !== 'contextmenu') context = null; return; }
        const opener = e.type === 'contextmenu' ? card : button instanceof HTMLElement ? button : null;
        context = { itemId, type: card?.dataset.type || null, item: null, opener, ts: Date.now() };
    }

    /** The action sheet on screen (the newest visible one). */
    function activeScroller(): HTMLElement | null {
        const scrollers = document.querySelectorAll<HTMLElement>('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            const el = scrollers[i];
            if (el && (el.offsetParent !== null || el.getClientRects().length)) return el;
        }
        return scrollers[scrollers.length - 1] || null;
    }

    /** A row with the native rows' markup. */
    function buildRow(scroller: HTMLElement, dataId: string, icon: string, label: string): HTMLButtonElement {
        const shared = featureCtx.peer('homeRemoval')?.buildNativeActionSheetItem;
        if (typeof shared === 'function') return shared(scroller, { dataId, icon, text: label });
        const ref = scroller.querySelector('.actionSheetMenuItem');
        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.type = 'button';
        button.className = (ref?.getAttribute('class') || 'listItem listItem-button actionSheetMenuItem').replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
        button.dataset.id = dataId;
        const iconEl = document.createElement('span');
        iconEl.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${icon}`;
        iconEl.setAttribute('aria-hidden', 'true');
        const body = document.createElement('div');
        body.className = 'listItemBody actionsheetListItemBody';
        const textEl = document.createElement('div');
        textEl.className = 'listItemBodyText actionSheetItemText';
        textEl.textContent = label;
        body.appendChild(textEl);
        button.append(iconEl, body);
        return button;
    }

    /** Keep a sheet anchored on screen after rows made it taller. */
    function fitSheet(scroller: HTMLElement): void {
        const sheet = scroller.closest<HTMLElement>('.actionSheet, .dialog');
        if (!sheet) return;
        const top = parseFloat(sheet.style.top);
        if (!Number.isFinite(top)) return;
        const viewport = document.documentElement.clientHeight || window.innerHeight || 0;
        const overflow = top + sheet.offsetHeight - (viewport - 10);
        if (overflow > 0) sheet.style.top = `${Math.max(10, top - overflow)}px`;
    }

    /** One plugin request. Rejects with a RequestError whose message is the server's reason. */
    async function request(method: 'GET' | 'POST', path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
        const client = apiClient();
        try {
            return await client.ajax({
                type: method,
                url: client.getUrl(`JellyfinEnhanced/maintainerr/${path}`),
                dataType: 'json',
                ...(body ? { data: JSON.stringify(body), contentType: 'application/json' } : {}),
            });
        } catch (err: unknown) {
            const failure = isRecord(err) ? err : {};
            let reason: string | null = null;
            try {
                const answer: unknown = typeof failure.json === 'function' ? await (failure.json as () => Promise<unknown>)() : null;
                reason = isRecord(answer) ? text(answer.error) : null;
            } catch { /* no body */ }
            const status = typeof failure.status === 'number' ? failure.status : undefined;
            const message = reason || (status ? `HTTP ${status}` : String(text(failure.message) ?? err));
            throw new RequestError(message, status);
        }
    }

    function stateOf(value: unknown): MaintainerrItemState | null {
        return isRecord(value) ? value : null;
    }

    /** Local calendar days from now to a delete time (a DST day is not 24 hours). */
    function daysLeft(deleteAt: number | null | undefined): number | null {
        if (typeof deleteAt !== 'number' || !Number.isFinite(deleteAt)) return null;
        const day = (ms: number): number => { const d = new Date(ms); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS); };
        return day(deleteAt) - day(Date.now());
    }

    /** The sentence for a toast: the message, with the days left when the server knows them. */
    function withDays(key: string, state: MaintainerrItemState | null): string {
        const days = daysLeft(state?.DeleteAt);
        return JE.escapeHtml(days === null ? JE.t(key) : JE.t(`${key}_days`, { days }));
    }

    /** Run one action, then tell the user (with Undo when there is an opposite). */
    async function act(path: string, body: Readonly<Record<string, unknown>>, doneKey: string, undo: { path: string; body: Readonly<Record<string, unknown>>; doneKey: string } | null): Promise<MaintainerrItemState | null> {
        const lease = JE.session?.createLease?.();
        try {
            const state = stateOf(await request('POST', path, body));
            // Another user signed in meanwhile: their screen gets no toast about this one's action.
            if (lease && !lease.isCurrent()) return state;
            JE.toast?.(withDays(doneKey, state), undefined, undo ? {
                action: {
                    label: JE.t('maintainerr_undo'),
                    onClick: () => { void act(undo.path, undo.body, undo.doneKey, null); },
                },
            } : undefined);
            return state;
        } catch (err: unknown) {
            console.warn(LOG, path, 'failed:', err);
            if (lease && !lease.isCurrent()) return null;
            JE.toast?.(JE.escapeHtml(JE.t('maintainerr_failed', { error: err instanceof Error ? err.message : '' })), 6000);
            return null;
        }
    }

    /** The postpone chooser: a few day counts, a custom count, or a timer reset. */
    function postpone(itemId: string, state: MaintainerrItemState, opener: HTMLElement | null): void {
        document.getElementById('je-mt-dialog')?.remove();
        JE.core.ui?.injectCss?.('je-maintainerr-menu', CSS);
        const backdrop = document.createElement('div');
        backdrop.className = 'je-mt-backdrop';
        backdrop.id = 'je-mt-dialog';
        const dialog = document.createElement('div');
        dialog.className = 'je-mt-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'je-mt-title');
        const days = daysLeft(state.DeleteAt);
        dialog.innerHTML = '<h2 id="je-mt-title" class="je-mt-title"></h2><p class="je-mt-hint"></p>'
            + '<div class="je-mt-quick"></div>'
            + `<div class="je-mt-custom"><label><span class="je-mt-label"></span><input type="number" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" class="je-mt-input" /></label><button type="button" class="je-mt-button je-mt-apply"></button></div>`
            + '<div class="je-mt-footer"><button type="button" class="je-mt-button je-mt-reset"></button><button type="button" class="je-mt-button je-mt-cancel"></button></div>';
        const setText = (selector: string, value: string): void => { const el = dialog.querySelector(selector); if (el) el.textContent = value; };
        setText('.je-mt-title', JE.t('maintainerr_postpone_title'));
        if (days === null) dialog.querySelector('.je-mt-hint')?.remove();
        else setText('.je-mt-hint', JE.t('maintainerr_postpone_hint', { days }));
        setText('.je-mt-label', JE.t('maintainerr_postpone_days_label'));
        setText('.je-mt-apply', JE.t('maintainerr_postpone_apply'));
        setText('.je-mt-reset', JE.t('maintainerr_reset_timer'));
        setText('.je-mt-cancel', JE.t('maintainerr_cancel'));
        const quick = dialog.querySelector<HTMLElement>('.je-mt-quick');
        const input = dialog.querySelector<HTMLInputElement>('.je-mt-input');
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        const close = (): void => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey, true);
            try { opener?.focus?.(); } catch { /* gone */ }
        };
        const run = (count: number | null): void => {
            close();
            void act('postpone', count === null ? { itemId } : { itemId, days: count }, count === null ? 'maintainerr_reset' : 'maintainerr_postponed', null);
        };
        for (const count of QUICK_DAYS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'je-mt-button je-mt-day';
            b.textContent = JE.t('maintainerr_postpone_plus_days', { days: count });
            b.addEventListener('click', () => run(count));
            quick?.appendChild(b);
        }
        const apply = (): void => {
            if (!input) return;
            const n = Math.floor(Number(input.value));
            if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) { input.focus(); input.select?.(); return; }
            run(n);
        };
        dialog.querySelector('.je-mt-apply')?.addEventListener('click', apply);
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        dialog.querySelector('.je-mt-reset')?.addEventListener('click', () => run(null));
        dialog.querySelector('.je-mt-cancel')?.addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onKey, true);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        const first = quick?.firstElementChild;
        if (first instanceof HTMLElement) first.focus();
    }

    /** Add the rows to the open item menu for the captured item (or drop stale ones a reused sheet still holds). */
    async function inject(): Promise<void> {
        const scroller = activeScroller();
        if (!scroller) return;
        const existing = Array.from(scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR));
        const ctx = context;
        if (!scroller.querySelector(ITEM_ROW_SELECTOR) || !ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) {
            for (const row of existing) if (!ctx || row.dataset.jeItemId !== ctx.itemId) row.remove();
            return;
        }
        if (existing.some((row) => row.dataset.jeItemId === ctx.itemId)) return;
        for (const row of existing) row.remove();
        if (!enabled()) return;
        let type = ctx.type;
        if (!type && ctx.item) {
            const read = await ctx.item;
            type = isRecord(read) ? text(read.Type) : null;
            if (context !== ctx || !scroller.isConnected) return;
        }
        if (!type || !TYPES.has(type)) return;
        // One ⋮ press, one item menu: a later sheet never gets rows for this item.
        context = null;
        const lease = JE.session?.createLease?.();
        if (!await isAdmin()) return;
        let state: MaintainerrItemState | null = null;
        try {
            state = stateOf(await request('GET', `item/${ctx.itemId}`));
        } catch (err: unknown) {
            // 404: the actions are off on the server (or it does not know the item); no rows.
            if (!(err instanceof RequestError && err.status === 404)) console.warn(LOG, 'could not read the item state:', err);
            return;
        }
        if (lease && !lease.isCurrent()) return;
        if (!state || !state.Supported || !scroller.isConnected || scroller.querySelector(ROW_SELECTOR)) return;
        const itemId = ctx.itemId;
        const opener = ctx.opener;
        const current = state;
        const rows: HTMLButtonElement[] = [];
        if (current.Marked) {
            const keep = buildRow(scroller, ROWS.keep, 'restore', JE.t('maintainerr_keep'));
            keep.addEventListener('click', () => { setTimeout(() => { void act('unmark', { itemId }, 'maintainerr_kept', { path: 'mark', body: { itemId }, doneKey: 'maintainerr_marked' }); }, 0); });
            const later = buildRow(scroller, ROWS.postpone, 'more_time', JE.t('maintainerr_postpone'));
            later.addEventListener('click', () => { setTimeout(() => postpone(itemId, current, opener), 0); });
            rows.push(keep, later);
        } else {
            const mark = buildRow(scroller, ROWS.mark, 'auto_delete', JE.t('maintainerr_mark'));
            mark.addEventListener('click', () => { setTimeout(() => { void act('mark', { itemId }, 'maintainerr_marked', { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' }); }, 0); });
            rows.push(mark);
        }
        const anchor = scroller.querySelector('[data-id="je-media-tags"], [data-id="share"]');
        for (const row of rows) {
            row.dataset.jeItemId = itemId;
            if (anchor) anchor.before(row);
            else scroller.appendChild(row);
        }
        fitSheet(scroller);
    }

    let scheduled = false;
    const SHEET_SELECTOR = '.actionSheet, .actionSheetScroller, .dialogContainer';
    /** Whether a mutation batch opened or changed an action sheet. */
    function touchesSheet(mutations: MutationRecord[]): boolean {
        for (const m of mutations) {
            if (m.target instanceof Element && m.target.closest(SHEET_SELECTOR)) return true;
            for (const node of m.addedNodes) {
                if (node instanceof Element && (node.matches(SHEET_SELECTOR) || node.querySelector(SHEET_SELECTOR))) return true;
            }
        }
        return false;
    }

    JE.core.dom?.onBodyMutation?.('maintainerr-item-menu', (mutations) => {
        if (scheduled || !context || !touchesSheet(mutations)) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            inject().catch((err) => console.warn(LOG, 'could not add the Maintainerr rows to the item menu:', err));
        });
    }, { priority: 1 });
    JE.session?.onUserChange?.('maintainerr-item-menu', () => { context = null; adminCheck = null; });

    const menu: MaintainerrMenu = { inject, postpone, ROWS };
    JE.maintainerrMenu = menu;
    return { menu, capture };
}
