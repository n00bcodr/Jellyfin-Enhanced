// @ts-check
// /js/tags/maintainerr-item-menu.js
//
// Maintainerr actions in Jellyfin's item menu (the ⋮ action sheet of the
// detail page and of cards), for administrators only: "Mark for removal" on
// an item Maintainerr does not list, and "Keep" plus "Postpone removal" on one
// it does. Movies and series. The rows call the plugin's admin-only
// /JellyfinEnhanced/maintainerr routes; the Maintainerr address and key never
// reach the browser, and the server refuses non-administrators regardless of
// what this module shows.
//
// Mark and Keep apply at once and show a toast with Undo (which runs the
// opposite call); there is no confirm dialog. Postpone opens a small chooser
// (a few day counts, a custom count, or a timer reset).
//
// The row is appended to the sheet the way tags/tag-item-menu.js appends
// "Media Tags" (jellyfin-web's itemContextMenu and actionsheet are not
// reachable from a plugin): the item is captured when its ⋮ button is pressed,
// the rows are added once the sheet is in the document, and a row id the menu
// does not know makes the sheet simply close while the row's own click handler
// runs. Re-check this with Jellyfin's private item-menu changes (IE-1).
//
// Public surface: JE.removalMenu { inject, postpone, ROWS, act } (also JE.maintainerrMenu) -- used by the tests and the Leaving soon page.
(function (JE) {
    'use strict';

    const ROWS = { mark: 'je-maintainerr-mark', keep: 'je-maintainerr-keep', postpone: 'je-maintainerr-postpone', request: 'je-maintainerr-request' };
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

    /**
     * @typedef {Object} MenuContext
     * @property {string} itemId
     * @property {string|null} type
     * @property {Promise<Object|null>|null} item
     * @property {string|null} name
     * @property {HTMLElement|null} opener
     * @property {number} ts
     */

    /**
     * @typedef {Object} ItemState
     * @property {string} ItemId
     * @property {boolean} Marked
     * @property {number|null} CollectionId
     * @property {string|null} CollectionName
     * @property {number|null} DeleteAt
     * @property {boolean} Supported
     */

    /** @type {MenuContext|null} */
    let context = null;
    /** @type {Promise<boolean>|null} */
    let adminCheck = null;

    /** @returns {boolean} The server offers the actions (the switch and a Maintainerr or Reclaimerr address) or removal requests. */
    function enabled() {
        return JE.pluginConfig?.MaintainerrActionsAvailable === true || JE.pluginConfig?.RemovalRequestsAvailable === true;
    }

    /** @returns {boolean} Reclaimerr is the removal tool: it schedules removals for an exact day. */
    function exactDates() {
        return JE.pluginConfig?.LeavingSoonProvider === 'reclaimerr';
    }

    /**
     * Noon (local) on a calendar day, as ISO 8601: the instant sent for an exact removal day.
     * @param {string} day yyyy-mm-dd
     * @returns {string|null}
     */
    function dayToIso(day) {
        const d = new Date(`${day}T12:00:00`);
        return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }

    /** @returns {Promise<boolean>} The signed-in user is an administrator (asked once per session). */
    function isAdmin() {
        adminCheck ??= Promise.resolve().then(() => ApiClient.getCurrentUser()).then((user) => user?.Policy?.IsAdministrator === true).catch(() => { adminCheck = null; return false; });
        return adminCheck;
    }

    /** @returns {string|null} The id of the item the visible detail page shows. */
    function detailItemId() {
        const query = (window.location.hash.split('?')[1] || window.location.search.slice(1) || '');
        const id = new URLSearchParams(query).get('id');
        return id ? normalizeId(id) : null;
    }

    /**
     * @param {string} id
     * @returns {string|null}
     */
    function normalizeId(id) {
        const clean = String(id || '').replace(/-/g, '').toLowerCase();
        return /^[0-9a-f]{32}$/.test(clean) ? clean : null;
    }

    /**
     * Remember the item whose menu is about to open.
     * @param {Event} e
     */
    function capture(e) {
        const el = /** @type {HTMLElement|null} */ (e.target instanceof Element ? e.target : null);
        if (!el || el.closest('.actionSheet, .dialogContainer, .je-mt-backdrop')) return;
        const more = /** @type {HTMLElement|null} */ (el.closest('.btnMoreCommands'));
        if (more && more.closest('#itemDetailPage')) {
            const itemId = detailItemId();
            if (!itemId) { context = null; return; }
            context = { itemId, type: null, item: ApiClient.getItem(ApiClient.getCurrentUserId(), itemId).catch(() => null), name: null, opener: more, ts: Date.now() };
            return;
        }
        const button = /** @type {HTMLElement|null} */ (e.type === 'contextmenu' ? el : el.closest('button[data-action="menu"]'));
        if (!button) return;
        const card = /** @type {HTMLElement|null} */ (button.closest('.card[data-id], .listItem[data-id], [data-id][data-type]'));
        const itemId = card ? normalizeId(card.dataset.id || '') : null;
        if (!itemId) { if (e.type !== 'contextmenu') context = null; return; }
        const name = card?.querySelector('.cardText-first, .cardText, .listItemBodyText')?.textContent?.trim() || null;
        context = { itemId, type: card?.dataset.type || null, item: null, name, opener: e.type === 'contextmenu' ? card : button, ts: Date.now() };
    }

    /** @returns {HTMLElement|null} The action sheet on screen (the newest visible one). */
    function activeScroller() {
        const scrollers = document.querySelectorAll('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            const el = /** @type {HTMLElement} */ (scrollers[i]);
            if (el.offsetParent !== null || el.getClientRects().length) return el;
        }
        return /** @type {HTMLElement|null} */ (scrollers[scrollers.length - 1] || null);
    }

    /**
     * A row with the native rows' markup.
     * @param {HTMLElement} scroller
     * @param {string} dataId
     * @param {string} icon
     * @param {string} text
     * @returns {HTMLButtonElement}
     */
    function buildRow(scroller, dataId, icon, text) {
        const shared = JE.internals?.features?.buildNativeActionSheetItem;
        if (typeof shared === 'function') return shared(scroller, { dataId, icon, text });
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
        const label = document.createElement('div');
        label.className = 'listItemBodyText actionSheetItemText';
        label.textContent = text;
        body.appendChild(label);
        button.append(iconEl, body);
        return /** @type {HTMLButtonElement} */ (button);
    }

    /**
     * Keep a sheet anchored on screen after rows made it taller.
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
     * One plugin request. Rejects with an Error whose message is the server's reason.
     * @param {'GET'|'POST'} method
     * @param {string} path
     * @param {Object} [body]
     * @returns {Promise<any>}
     */
    async function request(method, path, body) {
        try {
            return await ApiClient.ajax({
                type: method,
                // Each tool has its own routes: JellyfinEnhanced/reclaimerr/... or JellyfinEnhanced/maintainerr/..., whichever is in use.
                url: ApiClient.getUrl(`JellyfinEnhanced/${exactDates() ? 'reclaimerr' : 'maintainerr'}/${path}`),
                data: body ? JSON.stringify(body) : undefined,
                contentType: body ? 'application/json' : undefined,
                dataType: 'json',
            });
        } catch (err) {
            let reason = null;
            try { reason = typeof err?.json === 'function' ? (await err.json())?.error : null; } catch { /* no body */ }
            const status = err?.status;
            throw Object.assign(new Error(reason || (status ? `HTTP ${status}` : String(err?.message || err))), { status });
        }
    }

    /**
     * Local calendar days from now to a delete time (a DST day is not 24 hours).
     * @param {number|null|undefined} deleteAt
     * @returns {number|null}
     */
    function daysLeft(deleteAt) {
        if (!Number.isFinite(deleteAt)) return null;
        const day = (/** @type {number} */ ms) => { const d = new Date(ms); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS); };
        return day(/** @type {number} */ (deleteAt)) - day(Date.now());
    }

    /**
     * The sentence for a toast: the message, with the days left when the server knows them.
     * @param {string} key
     * @param {ItemState|null} state
     * @returns {string}
     */
    function withDays(key, state) {
        const days = daysLeft(state?.DeleteAt);
        return JE.escapeHtml(days === null ? JE.t(key) : JE.t(`${key}_days`, { days }));
    }

    /**
     * Run one action, then tell the user (with Undo when there is an opposite).
     * @param {string} path
     * @param {Object} body
     * @param {string} doneKey
     * @param {{path: string, body: Object, doneKey: string}|null} undo
     * @returns {Promise<ItemState|null>}
     */
    async function act(path, body, doneKey, undo) {
        try {
            const state = /** @type {ItemState} */ (await request('POST', path, body));
            // A removal request that is already waiting: say whose it is, nothing was filed again.
            const waiting = /** @type {any} */ (state)?.AlreadyRequested;
            if (waiting) { JE.toast?.(JE.escapeHtml(JE.t(waiting === 'mine' ? 'maintainerr_already_requested_mine' : 'maintainerr_already_requested'))); return state; }
            // Anything showing what is leaving (the Leaving soon page) reloads.
            try { window.dispatchEvent(new CustomEvent('je-leaving-soon-changed')); } catch { /* no event support */ }
            JE.toast?.(withDays(doneKey, state), undefined, undo ? {
                action: {
                    label: JE.t('maintainerr_undo'),
                    onClick: () => { act(undo.path, undo.body, undo.doneKey, null); },
                },
            } : undefined);
            return state;
        } catch (err) {
            console.warn(LOG, path, 'failed:', err);
            JE.toast?.(JE.escapeHtml(JE.t('maintainerr_failed', { error: err?.message || '' })), 6000);
            return null;
        }
    }

    /**
     * The postpone chooser: a few day counts, a custom count, or a timer reset.
     * @param {string} itemId
     * @param {ItemState} state
     * @param {HTMLElement|null} opener
     * @param {'postpone'|'mark'} [mode] 'mark' schedules a removal (Reclaimerr): the same chooser, with a date and no reset.
     * @param {string} [mediaSourceId] The version picked on the item page, sent with a mark.
     */
    function postpone(itemId, state, opener, mode = 'postpone', mediaSourceId = undefined) {
        document.getElementById('je-mt-dialog')?.remove();
        JE.core?.ui?.injectCss?.('je-maintainerr-menu', CSS);
        const backdrop = document.createElement('div');
        backdrop.className = 'je-mt-backdrop';
        backdrop.id = 'je-mt-dialog';
        const dialog = document.createElement('div');
        dialog.className = 'je-mt-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'je-mt-title');
        const days = daysLeft(state.DeleteAt);
        // The logo of the tool this acts on (Reclaimerr or Maintainerr).
        const tool = exactDates() ? 'reclaimerr' : 'maintainerr';
        dialog.innerHTML = `<div class="je-mt-head"><h2 id="je-mt-title" class="je-mt-title"><img class="je-mt-logo" alt="" width="34" height="34" /><span class="je-mt-titletext"></span></h2>`
            + `<button type="button" class="je-mt-x" aria-label="Close"><i class="material-icons" aria-hidden="true">close</i></button></div>`
            + `<div class="je-mt-current"><i class="material-icons" aria-hidden="true">event</i><div><p class="je-mt-hint"></p><div class="je-mt-when"></div></div></div>`
            + `<div class="je-mt-section"><div class="je-mt-quick"></div></div>`
            + `<div class="je-mt-section"><div class="je-mt-custom"><label><span class="je-mt-label"></span><input type="number" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" class="je-mt-input" /></label><button type="button" class="je-mt-button je-mt-primary je-mt-apply"></button></div></div>`
            + (exactDates() ? `<div class="je-mt-section"><div class="je-mt-custom"><label><span class="je-mt-datelabel"></span><input type="date" class="je-mt-date" /></label><button type="button" class="je-mt-button je-mt-primary je-mt-applydate"></button></div></div>` : '')
            + `<div class="je-mt-preview" aria-live="polite"></div>`
            + `<div class="je-mt-footer"><button type="button" class="je-mt-button je-mt-reset"></button><button type="button" class="je-mt-button je-mt-ghost je-mt-cancel"></button></div>`;
        const text = (/** @type {string} */ sel, /** @type {string} */ value) => { const el = dialog.querySelector(sel); if (el) el.textContent = value; };
        const logo = /** @type {HTMLImageElement|null} */ (dialog.querySelector('.je-mt-logo'));
        if (logo) { try { logo.src = JE.cdn.selfhst(`svg/${tool}.svg`); } catch { logo.remove(); } logo.title = tool === 'reclaimerr' ? 'Reclaimerr' : 'Maintainerr'; }
        // Reclaimerr takes any future day, earlier or later, so it is a date change; Maintainerr only moves a removal later.
        text('.je-mt-titletext', JE.t(mode === 'mark' ? 'reclaimerr_schedule_title' : (exactDates() ? 'reclaimerr_change_date' : 'maintainerr_postpone_title')));
        text('.je-mt-datelabel', JE.t('reclaimerr_pick_date'));
        text('.je-mt-applydate', JE.t('reclaimerr_apply_date'));
        text('.je-mt-hint', days === null ? '' : JE.t('maintainerr_postpone_hint', { days }));
        if (days === null) dialog.querySelector('.je-mt-hint')?.remove();
        text('.je-mt-label', JE.t('maintainerr_postpone_days_label'));
        text('.je-mt-apply', JE.t('maintainerr_postpone_apply'));
        try {
            const accent = JE?.themer?.getThemeVariables?.()?.primaryAccent;
            if (accent) {
                dialog.style.setProperty('--je-mt-accent', accent);
                // Text on the accent: dark on a light accent (a pale theme colour made white text unreadable), white on a dark one.
                const probe = document.createElement('span');
                probe.style.color = accent;
                document.body.appendChild(probe);
                const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
                probe.remove();
                if (rgb && rgb.length >= 3) {
                    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
                    dialog.style.setProperty('--je-mt-on-accent', lum > 0.55 ? '#10151a' : '#fff');
                }
            }
        } catch { /* default accent */ }
        const resetEl = dialog.querySelector('.je-mt-reset');
        if (resetEl) { resetEl.innerHTML = '<i class="material-icons" aria-hidden="true">restart_alt</i><span></span>'; const label = resetEl.querySelector('span'); if (label) label.textContent = JE.t('maintainerr_reset_timer'); }
        text('.je-mt-cancel', JE.t('maintainerr_cancel'));
        const quick = /** @type {HTMLElement} */ (dialog.querySelector('.je-mt-quick'));
        const shortDate = (/** @type {number} */ ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        // The day it leaves now, or today for a removal not yet scheduled: what a day count is added to.
        const known = Number.isFinite(state.DeleteAt);
        const base = known ? /** @type {number} */ (state.DeleteAt) : Date.now();
        const whenEl = dialog.querySelector('.je-mt-when');
        if (whenEl) { if (known) whenEl.textContent = shortDate(base); else whenEl.remove(); }
        let armed = false;
        const previewEl = /** @type {HTMLElement} */ (dialog.querySelector('.je-mt-preview'));
        /** Show the day an action would set, or nothing. @param {number|null} ms */
        const preview = (ms) => { previewEl.textContent = ms === null ? '' : JE.t('reclaimerr_new_date', { date: shortDate(ms) }); };
        const close = () => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey, true);
            try { opener?.focus?.(); } catch { /* gone */ }
        };
        const run = (/** @type {number|null} */ count) => {
            close();
            if (mode === 'mark') {
                const at = new Date(Date.now() + (count ?? 30) * DAY_MS).toISOString();
                act('mark', exactDates() ? { itemId, date: at, mediaSourceId } : { itemId, mediaSourceId }, 'maintainerr_marked', { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' });
                return;
            }
            act('postpone', count === null ? { itemId } : { itemId, days: count }, count === null ? 'maintainerr_reset' : 'maintainerr_postponed', null);
        };
        const runDate = (/** @type {string} */ day) => {
            const iso = dayToIso(day);
            if (!iso) return;
            close();
            if (mode === 'mark') act('mark', { itemId, date: iso, mediaSourceId }, 'maintainerr_marked', { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' });
            else act('postpone', { itemId, date: iso }, 'maintainerr_postponed', null);
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
            quick.appendChild(b);
        }
        const input = /** @type {HTMLInputElement} */ (dialog.querySelector('.je-mt-input'));
        const apply = () => {
            const n = Math.floor(Number(input.value));
            if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) { input.focus(); input.select?.(); return; }
            run(n);
        };
        dialog.querySelector('.je-mt-apply')?.addEventListener('click', apply);
        input.addEventListener('input', () => { const n = Math.floor(Number(input.value)); preview(Number.isFinite(n) && n >= 1 && n <= MAX_DAYS ? base + n * DAY_MS : null); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        const dateInput = /** @type {HTMLInputElement|null} */ (dialog.querySelector('.je-mt-date'));
        if (dateInput) {
            const tomorrow = new Date(Date.now() + DAY_MS);
            // Reclaimerr moves a cleanup candidate only later than its deadline; a scheduled deletion (negative id) either way.
            const floor = (state.CollectionId ?? 0) > 0 && state.DeleteAt ? Math.max(Date.now(), state.DeleteAt) + DAY_MS : tomorrow.getTime();
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
        const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        /** @type {HTMLElement|null} */ (quick.firstElementChild)?.focus();
        setTimeout(() => { armed = true; }, 0);
    }

    /**
     * Add the rows to the open item menu for the captured item (or drop stale
     * ones a reused sheet still holds).
     * @returns {Promise<void>}
     */
    async function inject() {
        const scroller = activeScroller();
        if (!scroller) return;
        const existing = Array.from(scroller.querySelectorAll(ROW_SELECTOR));
        const ctx = context;
        if (!scroller.querySelector(ITEM_ROW_SELECTOR) || !ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) {
            for (const row of existing) if (!ctx || /** @type {HTMLElement} */ (row).dataset.jeItemId !== ctx.itemId) row.remove();
            return;
        }
        if (existing.some((row) => /** @type {HTMLElement} */ (row).dataset.jeItemId === ctx.itemId)) return;
        for (const row of existing) row.remove();
        if (!enabled()) return;
        let type = ctx.type;
        let item = null;
        if (!type && ctx.item) {
            item = await ctx.item;
            type = item?.Type || null;
            if (context !== ctx || !scroller.isConnected) return;
        }
        if (!type || !TYPES.has(type)) return;
        // One ⋮ press, one item menu: a later sheet never gets rows for this item.
        context = null;
        const admin = await isAdmin();
        // Anyone signed in may ask for a removal (Reclaimerr, as their linked account); the rest is administrators only.
        if (!admin && JE.pluginConfig?.RemovalRequestsAvailable !== true) return;
        /** @type {ItemState|null} */
        let state = null;
        try { state = await request('GET', `item/${ctx.itemId}`); } catch (err) { if (err?.status !== 404) console.warn(LOG, 'could not read the item state:', err); return; }
        if (!state || !state.Supported || !scroller.isConnected || scroller.querySelector(ROW_SELECTOR)) return;
        const itemId = ctx.itemId;
        const opener = ctx.opener;
        const rows = [];
        if (!admin) {
            if (state.Marked || /** @type {any} */ (state).canRequest !== true) return;
            const ask = buildRow(scroller, ROWS.request, 'delete_sweep', JE.t('reclaimerr_request'));
            ask.addEventListener('click', () => { setTimeout(() => { act('request', { itemId }, 'reclaimerr_requested', null); }, 0); });
            rows.push(ask);
        } else if (state.Marked) {
            const keep = buildRow(scroller, ROWS.keep, 'restore', JE.t('maintainerr_keep'));
            keep.addEventListener('click', () => { setTimeout(() => { // Reclaimerr's Keep cannot be undone by marking again (a candidate stays protected, a schedule would restart at 30 days): no Undo.
                act('unmark', { itemId }, 'maintainerr_kept', exactDates() ? null : { path: 'mark', body: { itemId }, doneKey: 'maintainerr_marked' }); }, 0); });
            const later = buildRow(scroller, ROWS.postpone, exactDates() ? 'event' : 'more_time', JE.t(exactDates() ? 'reclaimerr_change_date' : 'maintainerr_postpone'));
            later.addEventListener('click', () => { setTimeout(() => postpone(itemId, /** @type {ItemState} */ (state), opener), 0); });
            rows.push(keep, later);
        } else {
            const mark = buildRow(scroller, ROWS.mark, 'auto_delete', JE.t('maintainerr_mark'));
            mark.addEventListener('click', () => {
                setTimeout(() => {
                    // The version picked on the item page (tells apart the 4K and 1080p copies of one movie).
                    const mediaSourceId = document.querySelector('#itemDetailPage:not(.hide) .selectSource')?.value || undefined;
                    // Reclaimerr schedules for an exact day: choose it (30 days is only the default).
                    if (exactDates()) postpone(itemId, /** @type {ItemState} */ (state), opener, 'mark', mediaSourceId);
                    else act('mark', { itemId, mediaSourceId }, 'maintainerr_marked', { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' });
                }, 0);
            });
            rows.push(mark);
        }
        const anchor = scroller.querySelector('[data-id="je-media-tags"], [data-id="share"]');
        for (const row of rows) {
            row.dataset.jeItemId = itemId;
            if (anchor) anchor.before(row); else scroller.appendChild(row);
        }
        fitSheet(scroller);
    }

    const CSS = `
.je-mt-backdrop{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px;animation:je-mt-fade .15s ease}
@keyframes je-mt-fade{from{opacity:0}to{opacity:1}}
.je-mt-dialog{--je-mt-accent:#00a4dc;background:linear-gradient(180deg,#252a2f,#1b1f23);color:#fff;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px 22px 18px;max-width:460px;width:100%;box-shadow:0 18px 60px rgba(0,0,0,.65);font-size:15px;animation:je-mt-pop .18s ease}
@keyframes je-mt-pop{from{transform:translateY(8px) scale(.98);opacity:0}to{transform:none;opacity:1}}
.je-mt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.je-mt-title{margin:0;font-size:1.3em;font-weight:600;display:flex;align-items:center;gap:12px}
.je-mt-logo{width:34px;height:34px;object-fit:contain;flex:none}
.je-mt-x{background:none;border:none;color:inherit;opacity:.65;cursor:pointer;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0}
.je-mt-x:hover,.je-mt-x:focus-visible{opacity:1;background:rgba(255,255,255,.1);outline:none}
.je-mt-current{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.06);margin-bottom:16px}
.je-mt-current .material-icons{color:var(--je-mt-accent);font-size:26px}
.je-mt-hint{margin:0;font-weight:600}
.je-mt-when{opacity:.7;font-size:.9em;margin-top:2px}
.je-mt-section{margin-bottom:16px}
.je-mt-quick{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.je-mt-button{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:inherit;border-radius:10px;padding:9px 12px;cursor:pointer;font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,border-color .15s,transform .1s}
.je-mt-button:hover,.je-mt-button:focus-visible{background:rgba(255,255,255,.16);outline:none}
.je-mt-button:active{transform:scale(.97)}
.je-mt-day{border-radius:999px;padding:9px 6px;font-weight:600;background:color-mix(in srgb,var(--je-mt-accent) 18%,transparent);border-color:color-mix(in srgb,var(--je-mt-accent) 45%,transparent)}
.je-mt-day:hover,.je-mt-day:focus-visible{background:color-mix(in srgb,var(--je-mt-accent) 38%,transparent)}
.je-mt-primary{background:var(--je-mt-accent);border-color:transparent;color:var(--je-mt-on-accent,#fff);font-weight:600;padding:9px 16px}
.je-mt-primary:hover,.je-mt-primary:focus-visible{filter:brightness(1.12);background:var(--je-mt-accent)}
.je-mt-ghost{background:none;border-color:transparent;opacity:.8}
.je-mt-custom{display:flex;align-items:flex-end;gap:10px}
.je-mt-custom label{display:flex;flex-direction:column;gap:5px;flex:1}
.je-mt-label,.je-mt-datelabel{font-size:.8em;opacity:.7;text-transform:uppercase;letter-spacing:.04em}
.je-mt-input,.je-mt-date{background:rgba(0,0,0,.28);color:inherit;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 11px;font:inherit;width:100%;box-sizing:border-box;color-scheme:dark}
.je-mt-input:focus,.je-mt-date:focus{border-color:var(--je-mt-accent);outline:none}
.je-mt-preview{min-height:1.4em;margin:-4px 0 12px;text-align:center;font-size:.9em;color:var(--je-mt-accent);font-weight:600}
.je-mt-footer{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px}
.je-mt-reset .material-icons{font-size:20px}
@media (max-width:420px){.je-mt-quick{grid-template-columns:repeat(2,1fr)}}
`;

    let scheduled = false;
    const SHEET_SELECTOR = '.actionSheet, .actionSheetScroller, .dialogContainer';
    /**
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
    JE.removalMenu = { inject, postpone, ROWS, act };
    JE.maintainerrMenu = JE.removalMenu;
})(window.JellyfinEnhanced);
