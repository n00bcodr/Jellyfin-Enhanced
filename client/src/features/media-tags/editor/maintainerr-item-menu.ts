import { apiClient, mediaTagsContext, type TagRuntimeBridge } from '../host';
import { isRecord, text } from '../pipeline/dto';
import CSS from './maintainerr-item-menu.css';

// Removal actions in Jellyfin's item menu (the ⋮ action sheet of the detail
// page and of cards), for whichever removal tool is on (Maintainerr or
// Reclaimerr, upstream da0ea773). Administrators get "Mark for removal" on an
// item the tool does not list, and "Keep" plus "Postpone removal" (Reclaimerr:
// "Change removal date") on one it does; movies, series and seasons (seasons:
// upstream 8f902bf7). With Reclaimerr and a service account, anyone signed in
// gets "Request removal" instead, filed as a Reclaimerr deletion request. The
// rows call the plugin's /JellyfinEnhanced/maintainerr or /reclaimerr routes,
// whichever tool is on; the tool's address and key never reach the browser,
// and the server refuses what a user may not do regardless of what this
// module shows (upstream 481a10ee, tags/maintainerr-item-menu.js).
//
// Mark and Keep apply at once and show a toast with Undo (which runs the
// opposite call; Reclaimerr's Keep has none); there is no confirm dialog.
// Postpone opens a small chooser (a few day counts, a custom count, or a
// timer reset; Reclaimerr also an exact day, and Mark opens the same chooser
// to schedule). Marking from the detail page's ⋮ also sends the version
// picked on that page (its .selectSource), so the server can tell a 4K
// copy's collection from a 1080p one's (upstream 06837783); a card's menu
// sends none. A done action tells the Leaving soon page to reload
// (je-leaving-soon-changed).
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
// Public surface: JE.removalMenu { inject, postpone, ROWS, act } (also
// JE.maintainerrMenu), used by the tests and the Leaving soon page.

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
    /** Reclaimerr's item route: whether this user may request a removal. */
    canRequest?: boolean;
    /** A removal request that was already waiting: whose it is. */
    AlreadyRequested?: 'mine' | 'other' | null;
}

/** An action's opposite, run by the toast's Undo. */
export interface UndoAction { path: string; body: Readonly<Record<string, unknown>>; doneKey: string }

export interface MaintainerrMenu {
    inject(): Promise<void>;
    /** The day chooser: postpone (or, for Reclaimerr, change the date), or with mode 'mark' schedule a removal. */
    postpone(itemId: string, state: MaintainerrItemState, opener: HTMLElement | null, mode?: 'postpone' | 'mark', mediaSourceId?: string): void;
    /** Run one action against the tool in use, then tell the user (with Undo when there is an opposite). */
    act(path: string, body: Readonly<Record<string, unknown>>, doneKey: string, undo: UndoAction | null): Promise<MaintainerrItemState | null>;
    ROWS: Readonly<{ mark: string; keep: string; postpone: string; request: string }>;
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
    const ROWS = Object.freeze({ mark: 'je-maintainerr-mark', keep: 'je-maintainerr-keep', postpone: 'je-maintainerr-postpone', request: 'je-maintainerr-request' });
    const ROW_SELECTOR = Object.values(ROWS).map((id) => `[data-id="${id}"]`).join(', ');
    const TYPES = new Set(['Movie', 'Series', 'Season']);
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

    /** The server offers the actions (the switch and a Maintainerr or Reclaimerr address) or removal requests. */
    function enabled(): boolean {
        return JE.pluginConfig?.MaintainerrActionsAvailable === true || JE.pluginConfig?.RemovalRequestsAvailable === true;
    }

    /** Reclaimerr is the removal tool: it schedules removals for an exact day, and has its own routes. */
    function exactDates(): boolean {
        return JE.pluginConfig?.LeavingSoonProvider === 'reclaimerr';
    }

    /** Noon (local) on a calendar day (yyyy-mm-dd), as ISO 8601: the instant sent for an exact removal day. */
    function dayToIso(day: string): string | null {
        const d = new Date(`${day}T12:00:00`);
        return Number.isFinite(d.getTime()) ? d.toISOString() : null;
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

    /** The version (media source id) picked on the detail page whose own ⋮ opened the menu; none from a card's ⋮. */
    function pickedVersion(opener: HTMLElement | null): Readonly<Record<string, string>> {
        const page = opener?.matches('.btnMoreCommands') ? opener.closest('#itemDetailPage') : null;
        const value = page?.querySelector<HTMLSelectElement>('select.selectSource')?.value;
        return value ? { mediaSourceId: value } : {};
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
                // Each tool has its own routes: JellyfinEnhanced/reclaimerr/... or JellyfinEnhanced/maintainerr/..., whichever is in use.
                url: client.getUrl(`JellyfinEnhanced/${exactDates() ? 'reclaimerr' : 'maintainerr'}/${path}`),
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
    async function act(path: string, body: Readonly<Record<string, unknown>>, doneKey: string, undo: UndoAction | null): Promise<MaintainerrItemState | null> {
        const lease = JE.session?.createLease?.();
        try {
            const state = stateOf(await request('POST', path, body));
            // Another user signed in meanwhile: their screen gets no toast about this one's action.
            if (lease && !lease.isCurrent()) return state;
            // A removal request that is already waiting: say whose it is, nothing was filed again.
            const waiting = state?.AlreadyRequested;
            if (waiting) { JE.toast?.(JE.escapeHtml(JE.t(waiting === 'mine' ? 'maintainerr_already_requested_mine' : 'maintainerr_already_requested'))); return state; }
            // Anything showing what is leaving (the Leaving soon page) reloads.
            try { window.dispatchEvent(new CustomEvent('je-leaving-soon-changed')); } catch { /* no event support */ }
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

    /** Dark text on a light accent (a pale theme colour made white text unreadable), white on a dark one. */
    function onAccent(accent: string): string | null {
        const probe = document.createElement('span');
        probe.style.color = accent;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.map(Number);
        probe.remove();
        if (!rgb || rgb.length < 3) return null;
        const [r = 0, g = 0, b = 0] = rgb;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? '#10151a' : '#fff';
    }

    /**
     * The day chooser: a few day counts, a custom count, or a timer reset; with Reclaimerr also an exact day, and with
     * mode 'mark' it schedules a removal (Reclaimerr: the same chooser, with a date and no reset). The tool's logo, the
     * day it leaves now, and a preview of the day a choice sets.
     */
    function postpone(itemId: string, state: MaintainerrItemState, opener: HTMLElement | null, mode: 'postpone' | 'mark' = 'postpone', mediaSourceId?: string): void {
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
        const exact = exactDates();
        // The logo of the tool this acts on (Reclaimerr or Maintainerr).
        const tool = exact ? 'reclaimerr' : 'maintainerr';
        dialog.innerHTML = '<div class="je-mt-head"><h2 id="je-mt-title" class="je-mt-title"><img class="je-mt-logo" alt="" width="34" height="34" /><span class="je-mt-titletext"></span></h2>'
            + '<button type="button" class="je-mt-x" aria-label="Close"><i class="material-icons" aria-hidden="true">close</i></button></div>'
            + '<div class="je-mt-current"><i class="material-icons" aria-hidden="true">event</i><div><p class="je-mt-hint"></p><div class="je-mt-when"></div></div></div>'
            + '<div class="je-mt-section"><div class="je-mt-quick"></div></div>'
            + `<div class="je-mt-section"><div class="je-mt-custom"><label><span class="je-mt-label"></span><input type="number" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" class="je-mt-input" /></label><button type="button" class="je-mt-button je-mt-primary je-mt-apply"></button></div></div>`
            + (exact ? '<div class="je-mt-section"><div class="je-mt-custom"><label><span class="je-mt-datelabel"></span><input type="date" class="je-mt-date" /></label><button type="button" class="je-mt-button je-mt-primary je-mt-applydate"></button></div></div>' : '')
            + '<div class="je-mt-preview" aria-live="polite"></div>'
            + '<div class="je-mt-footer"><button type="button" class="je-mt-button je-mt-reset"></button><button type="button" class="je-mt-button je-mt-ghost je-mt-cancel"></button></div>';
        const setText = (selector: string, value: string): void => { const el = dialog.querySelector(selector); if (el) el.textContent = value; };
        const logo = dialog.querySelector<HTMLImageElement>('.je-mt-logo');
        if (logo) {
            try { logo.src = JE.cdn.url('selfhst', `svg/${tool}.svg`); logo.title = exact ? 'Reclaimerr' : 'Maintainerr'; } catch { logo.remove(); }
        }
        // Reclaimerr takes any future day, earlier or later, so it is a date change; Maintainerr only moves a removal later.
        setText('.je-mt-titletext', JE.t(mode === 'mark' ? 'reclaimerr_schedule_title' : (exact ? 'reclaimerr_change_date' : 'maintainerr_postpone_title')));
        setText('.je-mt-datelabel', JE.t('reclaimerr_pick_date'));
        setText('.je-mt-applydate', JE.t('reclaimerr_apply_date'));
        if (days === null) dialog.querySelector('.je-mt-hint')?.remove();
        else setText('.je-mt-hint', JE.t('maintainerr_postpone_hint', { days }));
        setText('.je-mt-label', JE.t('maintainerr_postpone_days_label'));
        setText('.je-mt-apply', JE.t('maintainerr_postpone_apply'));
        try {
            const accent = JE.themer?.getThemeVariables?.()?.primaryAccent;
            if (accent) {
                dialog.style.setProperty('--je-mt-accent', accent);
                const text = onAccent(accent);
                if (text) dialog.style.setProperty('--je-mt-on-accent', text);
            }
        } catch { /* default accent */ }
        const resetEl = dialog.querySelector('.je-mt-reset');
        if (resetEl) {
            resetEl.innerHTML = '<i class="material-icons" aria-hidden="true">restart_alt</i><span></span>';
            const label = resetEl.querySelector('span');
            if (label) label.textContent = JE.t('maintainerr_reset_timer');
        }
        setText('.je-mt-cancel', JE.t('maintainerr_cancel'));
        const quick = dialog.querySelector<HTMLElement>('.je-mt-quick');
        const input = dialog.querySelector<HTMLInputElement>('.je-mt-input');
        const shortDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        // The day it leaves now, or today for a removal not yet scheduled: what a day count is added to.
        const known = typeof state.DeleteAt === 'number' && Number.isFinite(state.DeleteAt);
        const base = known ? state.DeleteAt as number : Date.now();
        const whenEl = dialog.querySelector('.je-mt-when');
        if (whenEl) { if (known) whenEl.textContent = shortDate(base); else whenEl.remove(); }
        let armed = false;
        const previewEl = dialog.querySelector<HTMLElement>('.je-mt-preview');
        /** Show the day an action would set, or nothing. */
        const preview = (ms: number | null): void => { if (previewEl) previewEl.textContent = ms === null ? '' : JE.t('reclaimerr_new_date', { date: shortDate(ms) }); };
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        const close = (): void => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey, true);
            try { opener?.focus?.(); } catch { /* gone */ }
        };
        const markUndo: UndoAction = { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' };
        const version = mediaSourceId ? { mediaSourceId } : {};
        const run = (count: number | null): void => {
            close();
            if (mode === 'mark') {
                const at = new Date(Date.now() + (count ?? 30) * DAY_MS).toISOString();
                void act('mark', exact ? { itemId, date: at, ...version } : { itemId, ...version }, 'maintainerr_marked', markUndo);
                return;
            }
            void act('postpone', count === null ? { itemId } : { itemId, days: count }, count === null ? 'maintainerr_reset' : 'maintainerr_postponed', null);
        };
        const runDate = (day: string): void => {
            const iso = dayToIso(day);
            if (!iso) return;
            close();
            if (mode === 'mark') void act('mark', { itemId, date: iso, ...version }, 'maintainerr_marked', markUndo);
            else void act('postpone', { itemId, date: iso }, 'maintainerr_postponed', null);
        };
        for (const count of QUICK_DAYS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'je-mt-button je-mt-day';
            b.textContent = JE.t('maintainerr_postpone_plus_days', { days: count });
            b.addEventListener('click', () => run(count));
            b.addEventListener('mouseenter', () => preview(base + count * DAY_MS));
            b.addEventListener('mouseleave', () => preview(null));
            // Keyboard focus previews too, but not the focus the dialog gives the first button when it opens.
            b.addEventListener('focus', () => { if (armed) preview(base + count * DAY_MS); });
            b.addEventListener('blur', () => preview(null));
            quick?.appendChild(b);
        }
        const apply = (): void => {
            if (!input) return;
            const n = Math.floor(Number(input.value));
            if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) { input.focus(); input.select?.(); return; }
            run(n);
        };
        dialog.querySelector('.je-mt-apply')?.addEventListener('click', apply);
        input?.addEventListener('input', () => { const n = Math.floor(Number(input.value)); preview(Number.isFinite(n) && n >= 1 && n <= MAX_DAYS ? base + n * DAY_MS : null); });
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        const dateInput = dialog.querySelector<HTMLInputElement>('.je-mt-date');
        if (dateInput) {
            const tomorrow = Date.now() + DAY_MS;
            // Reclaimerr moves a cleanup candidate only later than its deadline; a scheduled deletion (negative id) either way.
            const floor = (state.CollectionId ?? 0) > 0 && state.DeleteAt ? Math.max(Date.now(), state.DeleteAt) + DAY_MS : tomorrow;
            dateInput.min = new Date(floor).toISOString().slice(0, 10);
            dateInput.value = new Date(Date.now() + (mode === 'mark' || days === null ? 30 : Math.max(days, 1)) * DAY_MS).toISOString().slice(0, 10);
            dialog.querySelector('.je-mt-applydate')?.addEventListener('click', () => { if (dateInput.value) runDate(dateInput.value); else dateInput.focus(); });
            dateInput.addEventListener('input', () => { const iso = dayToIso(dateInput.value); preview(iso ? new Date(iso).getTime() : null); });
        }
        const resetButton = dialog.querySelector('.je-mt-reset');
        if (mode === 'mark') resetButton?.remove(); else resetButton?.addEventListener('click', () => run(null));
        dialog.querySelector('.je-mt-cancel')?.addEventListener('click', close);
        dialog.querySelector('.je-mt-x')?.addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onKey, true);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        const first = quick?.firstElementChild;
        if (first instanceof HTMLElement) first.focus();
        setTimeout(() => { armed = true; }, 0);
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
        const admin = await isAdmin();
        // Anyone signed in may ask for a removal (Reclaimerr with a service account); the rest is administrators only.
        if (!admin && JE.pluginConfig?.RemovalRequestsAvailable !== true) return;
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
        const exact = exactDates();
        if (!admin) {
            if (current.Marked || current.canRequest !== true) return;
            const ask = buildRow(scroller, ROWS.request, 'delete_sweep', JE.t('reclaimerr_request'));
            ask.addEventListener('click', () => { setTimeout(() => { void act('request', { itemId }, 'reclaimerr_requested', null); }, 0); });
            rows.push(ask);
        } else if (current.Marked) {
            const keep = buildRow(scroller, ROWS.keep, 'restore', JE.t('maintainerr_keep'));
            // Reclaimerr's Keep cannot be undone by marking again (a candidate stays protected, a schedule would restart at 30 days): no Undo.
            keep.addEventListener('click', () => { setTimeout(() => { void act('unmark', { itemId }, 'maintainerr_kept', exact ? null : { path: 'mark', body: { itemId, ...pickedVersion(opener) }, doneKey: 'maintainerr_marked' }); }, 0); });
            const later = buildRow(scroller, ROWS.postpone, exact ? 'event' : 'more_time', JE.t(exact ? 'reclaimerr_change_date' : 'maintainerr_postpone'));
            later.addEventListener('click', () => { setTimeout(() => postpone(itemId, current, opener), 0); });
            rows.push(keep, later);
        } else {
            const mark = buildRow(scroller, ROWS.mark, 'auto_delete', JE.t('maintainerr_mark'));
            mark.addEventListener('click', () => {
                setTimeout(() => {
                    const version = pickedVersion(opener);
                    // Reclaimerr schedules for an exact day: choose it (30 days is only the default).
                    if (exact) postpone(itemId, current, opener, 'mark', version.mediaSourceId);
                    else void act('mark', { itemId, ...version }, 'maintainerr_marked', { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' });
                }, 0);
            });
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

    // The removal actions are not specific to one tool: JE.removalMenu is the name to use, JE.maintainerrMenu the earlier one.
    const menu: MaintainerrMenu = { inject, postpone, act, ROWS };
    JE.removalMenu = menu;
    JE.maintainerrMenu = menu;
    return { menu, capture };
}
