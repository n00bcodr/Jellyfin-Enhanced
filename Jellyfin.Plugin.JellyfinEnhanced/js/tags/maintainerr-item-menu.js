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
// Public surface: JE.maintainerrMenu { inject, postpone, ROWS } (tests).
(function (JE) {
    'use strict';

    const ROWS = { mark: 'je-maintainerr-mark', keep: 'je-maintainerr-keep', postpone: 'je-maintainerr-postpone' };
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

    /** @returns {boolean} The server offers the actions (the switch and a Maintainerr URL). */
    function enabled() {
        return JE.pluginConfig?.MaintainerrActionsAvailable === true;
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
                url: ApiClient.getUrl(`JellyfinEnhanced/maintainerr/${path}`),
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
     */
    function postpone(itemId, state, opener) {
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
        dialog.innerHTML = `<h2 id="je-mt-title" class="je-mt-title"></h2><p class="je-mt-hint"></p>`
            + `<div class="je-mt-quick"></div>`
            + `<div class="je-mt-custom"><label><span class="je-mt-label"></span><input type="number" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" class="je-mt-input" /></label><button type="button" class="je-mt-button je-mt-apply"></button></div>`
            + `<div class="je-mt-footer"><button type="button" class="je-mt-button je-mt-reset"></button><button type="button" class="je-mt-button je-mt-cancel"></button></div>`;
        const text = (/** @type {string} */ sel, /** @type {string} */ value) => { const el = dialog.querySelector(sel); if (el) el.textContent = value; };
        text('.je-mt-title', JE.t('maintainerr_postpone_title'));
        text('.je-mt-hint', days === null ? '' : JE.t('maintainerr_postpone_hint', { days }));
        if (days === null) dialog.querySelector('.je-mt-hint')?.remove();
        text('.je-mt-label', JE.t('maintainerr_postpone_days_label'));
        text('.je-mt-apply', JE.t('maintainerr_postpone_apply'));
        text('.je-mt-reset', JE.t('maintainerr_reset_timer'));
        text('.je-mt-cancel', JE.t('maintainerr_cancel'));
        const quick = /** @type {HTMLElement} */ (dialog.querySelector('.je-mt-quick'));
        const close = () => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey, true);
            try { opener?.focus?.(); } catch { /* gone */ }
        };
        const run = (/** @type {number|null} */ count) => {
            close();
            act('postpone', count === null ? { itemId } : { itemId, days: count }, count === null ? 'maintainerr_reset' : 'maintainerr_postponed', null);
        };
        for (const count of QUICK_DAYS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'je-mt-button je-mt-day';
            b.textContent = JE.t('maintainerr_postpone_plus_days', { days: count });
            b.addEventListener('click', () => run(count));
            quick.appendChild(b);
        }
        const input = /** @type {HTMLInputElement} */ (dialog.querySelector('.je-mt-input'));
        const apply = () => {
            const n = Math.floor(Number(input.value));
            if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) { input.focus(); input.select?.(); return; }
            run(n);
        };
        dialog.querySelector('.je-mt-apply')?.addEventListener('click', apply);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        dialog.querySelector('.je-mt-reset')?.addEventListener('click', () => run(null));
        dialog.querySelector('.je-mt-cancel')?.addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        /** @type {HTMLElement|null} */ (quick.firstElementChild)?.focus();
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
        if (!await isAdmin()) return;
        /** @type {ItemState|null} */
        let state = null;
        try { state = await request('GET', `item/${ctx.itemId}`); } catch (err) { if (err?.status !== 404) console.warn(LOG, 'could not read the item state:', err); return; }
        if (!state || !state.Supported || !scroller.isConnected || scroller.querySelector(ROW_SELECTOR)) return;
        const itemId = ctx.itemId;
        const opener = ctx.opener;
        const rows = [];
        if (state.Marked) {
            const keep = buildRow(scroller, ROWS.keep, 'restore', JE.t('maintainerr_keep'));
            keep.addEventListener('click', () => { setTimeout(() => { act('unmark', { itemId }, 'maintainerr_kept', { path: 'mark', body: { itemId }, doneKey: 'maintainerr_marked' }); }, 0); });
            const later = buildRow(scroller, ROWS.postpone, 'more_time', JE.t('maintainerr_postpone'));
            later.addEventListener('click', () => { setTimeout(() => postpone(itemId, /** @type {ItemState} */ (state), opener), 0); });
            rows.push(keep, later);
        } else {
            const mark = buildRow(scroller, ROWS.mark, 'auto_delete', JE.t('maintainerr_mark'));
            mark.addEventListener('click', () => { setTimeout(() => { act('mark', { itemId }, 'maintainerr_marked', { path: 'unmark', body: { itemId }, doneKey: 'maintainerr_kept' }); }, 0); });
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
.je-mt-backdrop{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
.je-mt-dialog{background:#1f1f1f;color:#fff;border-radius:8px;padding:20px 22px;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.6);font-size:15px}
.je-mt-title{margin:0 0 6px;font-size:1.25em}
.je-mt-hint{margin:0 0 14px;opacity:.8}
.je-mt-quick{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.je-mt-button{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:inherit;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}
.je-mt-button:hover,.je-mt-button:focus-visible{background:rgba(255,255,255,.18);outline:none}
.je-mt-custom{display:flex;align-items:flex-end;gap:8px;margin-bottom:16px}
.je-mt-custom label{display:flex;flex-direction:column;gap:4px;flex:1}
.je-mt-label{font-size:.85em;opacity:.8}
.je-mt-input{background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:8px;font:inherit;width:100%;box-sizing:border-box}
.je-mt-footer{display:flex;justify-content:space-between;gap:8px}
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

    JE.maintainerrMenu = { inject, postpone, ROWS };
})(window.JellyfinEnhanced);
