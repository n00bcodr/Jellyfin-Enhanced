/**
 * @file Requests & downloads, phase 2: the administrator's tabs of the Requests page (#/requests?tab=
 * overview|activity|system|audit). Loads each tab from its admin route (GET /JellyfinEnhanced/arr/
 * admin/hub/overview|activity|system, /arr/admin/audit), re-reads the open tab when the change feed
 * announces the administrators' key (admin:ops: an arr was read again or an action was audited),
 * with a slow fallback poll (every 10 seconds when there is no change feed), and runs the fixes: Open in Sonarr/Radarr (links), Search again / Retry import
 * / Remove (keep the data, optionally blocklist and search again) through POST /arr/admin/queue/
 * action, remove *with* the download's data only after a typed confirmation and a server-issued
 * token (POST /arr/admin/queue/confirm), and Scan now (POST /arr/admin/bridge/scan). Every action is
 * audited on the server. The server refuses all of it to non-administrators; the tabs only exist
 * when the hub answer carries the admin block with phase 2 on.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const A = H.admin = H.admin || {};
    const TABS = ['overview', 'activity', 'system', 'audit'];
    const ROUTES = {
        overview: '/arr/admin/hub/overview',
        activity: '/arr/admin/hub/activity',
        system: '/arr/admin/hub/system',
        audit: '/arr/admin/audit?take=200'
    };
    const POLL_MS = 10000;
    const FEED_POLL_MS = 60000;
    const FEED_KEY = 'admin:ops';
    const RELOAD_DELAY_MS = 300;
    const logPrefix = '🪼 Jellyfin Enhanced: Requests (admin):';

    const state = {
        tab: null,
        panel: null,
        data: {},
        loadedAt: {},
        okAt: {},
        failed: {},
        retry: { timer: null, delay: 0, tab: null },
        loading: {},
        again: {},
        timer: null,
        unsubscribe: null,
        reloadTimer: null,
        generation: 0,
        busy: new Set(),
        results: {},
        banner: null,
        dialog: null
    };

    /**
     * Translates through the shared status helper.
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * The admin tabs the hub answer allows (none unless it carries the admin block with phase 2 on).
     * @param {Object|null} hubData The hub response.
     * @returns {string[]} Tab ids.
     */
    function tabs(hubData) {
        return hubData?.admin?.hub === true ? [...TABS] : [];
    }

    /**
     * A fresh idempotency key (one per click).
     * @returns {string} Key.
     */
    function newKey() {
        return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    /**
     * Shows an admin tab in the hub's panel (called on every hub render). Draws what is known at
     * once, loads the tab when it has nothing or is older than the poll interval, and keeps one
     * poll running while the tab is shown.
     * @param {HTMLElement} panel The hub's tab panel.
     * @param {string} tab Tab id.
     * @returns {void}
     */
    function render(panel, tab) {
        A.injectStyles?.();
        if (state.tab !== tab) {
            // A dialog the tabs opened belongs to the tab it was opened on (the Manage drawer's stays).
            if (state.tab) closeDialog('tabs');
            state.tab = tab;
            state.banner = null;
        }
        state.panel = panel;
        draw();
        if (!state.data[tab] || Date.now() - (state.loadedAt[tab] || 0) >= POLL_MS) load(tab);
        follow();
        if (!state.timer) schedule();
    }

    /**
     * True when the change feed is there to follow (otherwise the tabs poll every 10 seconds).
     * @returns {boolean} Feed available.
     */
    function hasFeed() {
        return typeof JE.arr?.onStatusChange === 'function' && typeof JE.arrStatus?.subscribe === 'function';
    }

    /**
     * Follows the administrators' feed key while an admin tab is shown: a change re-reads the shown
     * tab shortly (a burst makes one read).
     * @returns {void}
     */
    function follow() {
        if (state.unsubscribe || !hasFeed()) return;
        state.unsubscribe = JE.arrStatus.subscribe([FEED_KEY], () => {
            if (state.reloadTimer || !state.tab) return;
            state.reloadTimer = setTimeout(() => {
                state.reloadTimer = null;
                if (state.tab && state.panel?.isConnected && !document.hidden) load(state.tab, true);
            }, RELOAD_DELAY_MS);
        });
    }

    /**
     * Stops polling and forgets the panel (the hub left the admin tab or the page).
     * @returns {void}
     */
    function leave() {
        state.tab = null;
        state.panel = null;
        state.generation++;
        stopRetry();
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        if (state.reloadTimer) clearTimeout(state.reloadTimer);
        state.reloadTimer = null;
        if (state.unsubscribe) state.unsubscribe();
        state.unsubscribe = null;
        // Only the tabs' own dialog: the Manage drawer's Remove dialog belongs to the drawer (which
        // can be open over any hub tab, whose re-renders call this).
        closeDialog('tabs');
    }

    /**
     * The next fallback poll of the shown tab (skipped while the page is hidden): every minute
     * while the change feed is followed, every 10 seconds without it.
     * @returns {void}
     */
    function schedule() {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(async () => {
            state.timer = null;
            if (!state.tab || !state.panel?.isConnected) return;
            if (!document.hidden) await load(state.tab);
            if (state.tab) schedule();
        }, state.unsubscribe ? FEED_POLL_MS : POLL_MS);
    }

    /**
     * Reads one tab (one read at a time per tab; an answer for a tab no longer shown is kept for later).
     * @param {string} tab Tab id.
     * @param {boolean} [fresh] The answer must come from a read that starts now (something changed:
     *   a feed change, an action's outcome): asked while a read is under way, the tab is read once
     *   more after it, since that read may have looked before the change.
     * @returns {Promise<void>}
     */
    async function load(tab, fresh) {
        if (!ROUTES[tab]) return undefined;
        if (state.loading[tab]) {
            if (fresh) state.again[tab] = true;
            return state.loading[tab];
        }
        delete state.again[tab];
        const generation = state.generation;
        const run = (async () => {
            try {
                const data = await JE.core.api.plugin(ROUTES[tab], { skipRetry: true });
                if (generation !== state.generation) return;
                if (!data || typeof data !== 'object') throw new Error('empty answer');
                const attention = (state.data.overview?.needsAttention || []).length;
                state.data[tab] = data;
                state.failed[tab] = false;
                state.loadedAt[tab] = Date.now();
                state.okAt[tab] = state.loadedAt[tab];
                if (state.retry.tab === tab) stopRetry();
                // The hub's Overview tab shows how many rows need attention: redraw its tab strip.
                if (tab === 'overview' && (state.data.overview?.needsAttention || []).length !== attention) H.renderTabs?.();
            } catch (err) {
                if (generation !== state.generation) return;
                // What the tab shows stays (with a note saying the re-read failed), and it is tried
                // again on its own, sooner than the fallback poll.
                state.failed[tab] = true;
                if (state.data[tab] && state.tab === tab) scheduleRetry(tab, generation);
                console.warn(`${logPrefix} could not load the ${tab} tab (${err?.status || err?.message || err})`);
            } finally {
                delete state.loading[tab];
            }
            if (state.tab === tab) draw();
            if (state.again[tab]) {
                delete state.again[tab];
                if (generation === state.generation && state.tab === tab) await load(tab);
            }
        })();
        state.loading[tab] = run;
        return run;
    }

    /**
     * Tries a failed re-read of the shown tab again: after 5 s, then twice as long each time, at
     * most a minute apart; stops when the tab or the page is left.
     * @param {string} tab Tab id.
     * @param {number} generation The visit the failure belongs to.
     * @returns {void}
     */
    function scheduleRetry(tab, generation) {
        if (state.retry.timer && state.retry.tab === tab) return;
        stopRetry(true);
        state.retry.tab = tab;
        state.retry.delay = JE.arrStatus.retryDelay(state.retry.delay);
        state.retry.timer = setTimeout(() => {
            state.retry.timer = null;
            if (generation === state.generation && state.tab === tab && state.panel?.isConnected) load(tab, true);
        }, state.retry.delay);
    }

    /**
     * Stops trying again (a read worked, or the tab was left).
     * @param {boolean} [keepDelay] Keep the backoff (switching the retried tab).
     * @returns {void}
     */
    function stopRetry(keepDelay) {
        if (state.retry.timer) clearTimeout(state.retry.timer);
        state.retry.timer = null;
        if (!keepDelay) {
            state.retry.delay = 0;
            state.retry.tab = null;
        }
    }

    /**
     * The control that has focus inside the panel (its data-je-focus id), if any.
     * @returns {string|null} Focus id.
     */
    function focused() {
        const active = document.activeElement;
        if (!state.panel || !active || !state.panel.contains(active)) return null;
        return active.closest('[data-je-focus]')?.dataset.jeFocus || '';
    }

    /**
     * Draws the shown tab from what is known, keeping keyboard / D-pad focus on the same control.
     * @returns {void}
     */
    function draw() {
        const panel = state.panel;
        if (!panel || !state.tab) return;
        const focus = focused();
        panel.textContent = '';
        if (state.banner) {
            const banner = el('div', `je-ops-banner${state.banner.failed ? ' je-ops-banner-error' : state.banner.unknown ? ' je-ops-banner-unknown' : ''}`, state.banner.message);
            banner.setAttribute('role', 'status');
            panel.appendChild(banner);
        }
        const data = state.data[state.tab];
        if (!data) {
            const box = el('div', 'je-hub-empty', tr(state.failed[state.tab] ? 'arr_ops_error' : 'arr_hub_loading'));
            panel.appendChild(box);
            return;
        }
        if (state.failed[state.tab]) {
            const tab = state.tab;
            panel.appendChild(JE.arrStatus.staleNote(state.okAt[tab] || state.loadedAt[tab] || 0, () => { stopRetry(); load(tab, true); }, 'je-ops-banner je-ops-banner-unknown'));
        }
        const ctx = context();
        try {
            if (state.tab === 'overview') A.renderOverview(panel, data, ctx);
            else if (state.tab === 'activity') A.renderActivity(panel, data, ctx);
            else if (state.tab === 'system') A.renderSystem(panel, data, ctx);
            else A.renderAudit(panel, data, ctx);
        } catch (err) {
            console.warn(`${logPrefix} could not draw the ${state.tab} tab`, err);
        }
        if (focus !== null && !panel.contains(document.activeElement)) {
            const target = [...panel.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === focus);
            target?.focus({ preventScroll: true });
        }
    }

    /**
     * The callbacks and helpers the renderers use.
     * @returns {Object} Context.
     */
    function context() {
        return {
            busy: state.busy,
            results: state.results,
            arrUrl,
            seerrUrl,
            act,
            queue: queueAction,
            scan: scanNow
        };
    }

    /**
     * The instances known from any tab's answer, by id.
     * @param {string} id Instance id.
     * @returns {Object|null} Instance card.
     */
    function instance(id) {
        for (const data of [state.data.overview, state.data.activity]) {
            const card = (data?.instances || []).find(i => i.id === id);
            if (card) return card;
        }
        return (state.data.system?.instances || []).map(i => i.card).find(c => c?.id === id) || null;
    }

    /**
     * A page of an instance's own UI as this browser should open it (URL mappings applied).
     * @param {string} instanceId Instance id.
     * @param {string} [path] Page ("/activity/queue").
     * @returns {string|null} URL.
     */
    function arrUrl(instanceId, path) {
        const card = instance(instanceId);
        const base = card ? JE.internals?.arrManage?.mappedUrl?.(card.url, card.urlMappings) : null;
        if (!base) return null;
        return path && /^\/[A-Za-z0-9/_-]*$/.test(path) ? base + path : base;
    }

    /**
     * Seerr's Sonarr/Radarr settings page, when Seerr's browser address is known.
     * @returns {string|null} URL.
     */
    function seerrUrl() {
        const base = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl?.();
        return base && /^https?:\/\//i.test(base) ? `${base.replace(/\/+$/, '')}/settings/services` : null;
    }

    /**
     * Runs a Needs attention fix.
     * @param {string} fix Fix id.
     * @param {Object} item Row.
     * @param {HTMLElement} [opener] The control clicked (focus returns to it).
     * @returns {void}
     */
    function act(fix, item, opener) {
        if (state.busy.has(item.id) && fix !== 'open_system') return;
        switch (fix) {
            case 'open_system':
                H.selectTab?.('system');
                return;
            case 'scan_now':
                scanNow({ id: item.id, instanceId: item.instanceId, arrPath: item.arrPath }, opener);
                return;
            case 'search_now':
                if (item.downloadId) runQueue({ instanceId: item.instanceId, downloadId: item.downloadId, action: 'search' }, item.id, opener);
                else post('/arr/admin/hub/search', { instanceId: item.instanceId, key: item.key }, item.id, opener);
                return;
            case 'retry_import':
                runQueue({ instanceId: item.instanceId, downloadId: item.downloadId, action: 'retry_import' }, item.id, opener);
                return;
            case 'remove_search': {
                // The row says how many episodes the download covers (the Activity answer too, when read).
                const group = (state.data.activity?.queue || []).find(g => g.instanceId === item.instanceId && g.downloadId === item.downloadId);
                removeDialog({ instanceId: item.instanceId, downloadId: item.downloadId, title: [item.title, item.scope].filter(Boolean).join(' '), scope: item.scope, episodes: item.episodes || group?.episodes || 0, instance: item.instance }, item.id, opener, true);
                return;
            }
            case 'remove_with_data':
                confirmDataDialog({ instanceId: item.instanceId, downloadId: item.downloadId }, item.id, opener);
                return;
        }
    }

    /**
     * Runs a queue action from the Activity tab.
     * @param {string} action remove, remove_with_data, search or retry_import.
     * @param {Object} g Download.
     * @param {HTMLElement} [opener] The control clicked.
     * @returns {void}
     */
    function queueAction(action, g, opener) {
        const busyId = A.downloadKey(g);
        if (state.busy.has(busyId)) return;
        const target = { instanceId: g.instanceId, downloadId: g.downloadId, title: [g.title, g.scope].filter(Boolean).join(' '), scope: g.scope, episodes: g.episodes, instance: g.instance };
        if (action === 'remove') removeDialog(target, busyId, opener, false);
        else if (action === 'remove_with_data') confirmDataDialog(target, busyId, opener);
        else runQueue({ instanceId: g.instanceId, downloadId: g.downloadId, action }, busyId, opener);
    }

    /**
     * Posts a queue action.
     * @param {Object} body Action body (without the idempotency key).
     * @param {string} busyId The row it belongs to.
     * @param {HTMLElement} [opener] The control clicked.
     * @returns {Promise<Object|null>} Outcome.
     */
    function runQueue(body, busyId, opener) {
        return post('/arr/admin/queue/action', body, busyId, opener);
    }

    /**
     * Posts an admin action (with a fresh idempotency key), shows its outcome and reads the tab again.
     * @param {string} path Route.
     * @param {Object} body Body (without the idempotency key).
     * @param {string} busyId The row it belongs to.
     * @param {HTMLElement} [opener] The control clicked.
     * @returns {Promise<Object|null>} Outcome.
     */
    async function post(path, body, busyId, opener) {
        state.busy.add(busyId);
        state.banner = null;
        draw();
        let outcome = null;
        try {
            outcome = await JE.core.api.plugin(path, { method: 'POST', body: { ...body, idempotencyKey: newKey() }, skipRetry: true });
        } catch (err) {
            outcome = { status: 'Failed', message: err?.message || String(err) };
        }
        state.busy.delete(busyId);
        report(busyId, outcome);
        opener?.focus?.({ preventScroll: true });
        return outcome;
    }

    /**
     * Scan now for an imported path.
     * @param {{id: string, instanceId: string, arrPath: string}} target What to scan.
     * @param {HTMLElement} [opener] The control clicked.
     * @returns {Promise<void>}
     */
    async function scanNow(target, opener) {
        if (state.busy.has(target.id)) return;
        state.busy.add(target.id);
        state.banner = null;
        draw();
        let outcome;
        try {
            outcome = await JE.core.api.plugin('/arr/admin/bridge/scan', { method: 'POST', body: { instanceId: target.instanceId, path: target.arrPath, idempotencyKey: newKey() }, skipRetry: true });
        } catch (err) {
            outcome = { status: 'Failed', message: err?.message || String(err) };
        }
        state.busy.delete(target.id);
        report(target.id, outcome);
        opener?.focus?.({ preventScroll: true });
    }

    /**
     * Shows an action's outcome on its row and as the tab banner, then reads the tab again.
     * @param {string} rowId Row id.
     * @param {Object|null} outcome Server answer.
     * @returns {void}
     */
    function report(rowId, outcome) {
        const status = outcome?.status;
        const failed = status === 'Failed' || status === 'Rejected';
        const message = [outcome?.message, outcome?.readBack].filter(Boolean).join(' ');
        state.results[rowId] = { message: failed ? tr('arr_ops_action_failed', { message: outcome?.message || '' }) : message, failed };
        state.banner = { message: state.results[rowId].message, failed, unknown: status === 'Unknown' };
        draw();
        if (state.tab) {
            state.loadedAt[state.tab] = 0;
            load(state.tab, true);
        }
    }

    // ------------------------------------------------------------------ dialogs

    /**
     * Closes the open dialog (focus returns to its opener).
     * @param {string} [owner] Only a dialog this owner opened ('tabs': the admin tabs, 'drawer':
     *   the Manage drawer); any dialog when left out.
     * @returns {void}
     */
    function closeDialog(owner) {
        const d = state.dialog;
        if (!d || (owner && d.owner !== owner)) return;
        state.dialog = null;
        document.removeEventListener('keydown', d.onKey, true);
        document.removeEventListener('focusin', d.onFocus, true);
        d.overlay.remove();
        openerNow(d)?.focus?.({ preventScroll: true });
    }

    /**
     * The control a dialog returns focus to: its opener, or (when a redraw replaced it while the
     * dialog was open) the control with the same focus id now, else the selected hub tab.
     * @param {{opener: HTMLElement|null, focusId: string|null}} d Dialog.
     * @returns {HTMLElement|null} Control.
     */
    function openerNow(d) {
        if (d.opener?.isConnected) return d.opener;
        if (d.focusId) {
            for (const root of [state.panel, document.querySelector('.je-manage')]) {
                const again = root ? [...root.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === d.focusId) : null;
                if (again) return again;
            }
        }
        return document.querySelector('.je-hub-tab[aria-selected="true"]') || document.querySelector('.je-manage');
    }

    /**
     * Opens a dialog (focus trapped inside, Esc closes).
     * @param {string} title Heading.
     * @param {HTMLElement} opener The control that opened it.
     * @param {string} [owner] Who opened it ('tabs' by default, 'drawer' for the Manage drawer):
     *   leaving the admin tabs closes only theirs, closing the drawer only its own.
     * @returns {{box: HTMLElement, buttons: HTMLElement}} Parts to fill.
     */
    function openDialog(title, opener, owner) {
        closeDialog();
        A.injectStyles?.();
        const overlay = el('div', 'je-ops-dialog-overlay');
        // focuscontainer: jellyfin-web's D-pad navigation (TV) stays inside the dialog.
        const box = el('div', 'je-ops-dialog focuscontainer');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        const heading = el('h2', '', title);
        heading.id = `je-ops-dialog-title-${Date.now()}`;
        box.setAttribute('aria-labelledby', heading.id);
        box.appendChild(heading);
        const buttons = el('div', 'je-ops-dialog-buttons');
        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
        const onKey = (e) => {
            if (!state.dialog) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeDialog();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = [...box.querySelectorAll('button, input, a[href]')].filter(n => !n.disabled);
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) {
                e.preventDefault();
                first.focus();
            }
        };
        // Focus that leaves the dialog (D-pad, a click behind it) comes back to its first control.
        const onFocus = (e) => {
            if (!state.dialog || box.contains(e.target)) return;
            const first = [...box.querySelectorAll('button, input, a[href]')].find(n => !n.disabled);
            (first || box).focus({ preventScroll: true });
        };
        box.tabIndex = -1;
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocus, true);
        document.body.appendChild(overlay);
        const focusId = opener?.closest?.('[data-je-focus]')?.dataset.jeFocus || null;
        state.dialog = { overlay, opener, onKey, onFocus, focusId, owner: owner || 'tabs' };
        return { box, buttons };
    }

    /**
     * A dialog button.
     * @param {string} label Text.
     * @param {string} [cls] Extra classes.
     * @returns {HTMLButtonElement} Button.
     */
    function dialogButton(label, cls) {
        const b = el('button', `je-ops-btn${cls ? ' ' + cls : ''}`, label);
        b.type = 'button';
        return b;
    }

    /**
     * Tier 2: remove a download from the queue keeping its data, with blocklist / search again
     * choices and the blast radius of a season pack. "Delete the download's data too" leads to the
     * Tier 3 dialog.
     * @param {Object} target Download (instanceId, downloadId, title, scope, episodes).
     * @param {string} busyId Row id.
     * @param {HTMLElement} opener The control clicked.
     * @param {boolean} searchByDefault Pre-tick "search again" (the Remove & search again fix).
     * @param {(body: Object) => void} [run] Runs the removal instead of the tab (the Manage drawer;
     *   it offers only the non-destructive removal, so there is no "delete the data too").
     * @returns {void}
     */
    function removeDialog(target, busyId, opener, searchByDefault, run) {
        const { box, buttons } = openDialog(tr('arr_ops_remove_title'), opener, run ? 'drawer' : 'tabs');
        box.appendChild(el('p', '', tr('arr_ops_remove_body', { title: target.title || '', instance: target.instance || instance(target.instanceId)?.name || '' })));
        if (target.episodes > 1) box.appendChild(el('p', 'je-ops-warn', tr('arr_ops_remove_pack', { scope: target.scope || '', n: target.episodes })));
        const blockLabel = el('label');
        const block = document.createElement('input');
        block.type = 'checkbox';
        block.checked = true;
        blockLabel.appendChild(block);
        blockLabel.appendChild(document.createTextNode(tr('arr_ops_remove_blocklist')));
        box.appendChild(blockLabel);
        const searchLabel = el('label');
        const search = document.createElement('input');
        search.type = 'checkbox';
        search.checked = searchByDefault !== false;
        searchLabel.appendChild(search);
        searchLabel.appendChild(document.createTextNode(tr('arr_ops_remove_search')));
        box.appendChild(searchLabel);
        const ok = dialogButton(tr('arr_ops_action_remove'), 'je-ops-btn-primary');
        const data = dialogButton(tr('arr_ops_remove_with_data_link'), 'je-ops-btn-danger');
        const cancel = dialogButton(tr('arr_ops_cancel'));
        ok.addEventListener('click', () => {
            const body = { instanceId: target.instanceId, downloadId: target.downloadId, action: 'remove', blocklist: block.checked, searchAgain: search.checked };
            closeDialog();
            if (run) run(body);
            else runQueue(body, busyId, opener);
        });
        data.addEventListener('click', () => confirmDataDialog(target, busyId, opener, { blocklist: block.checked, searchAgain: search.checked }));
        cancel.addEventListener('click', () => closeDialog());
        buttons.appendChild(cancel);
        if (!run) buttons.appendChild(data);
        buttons.appendChild(ok);
        box.appendChild(buttons);
        ok.focus();
    }

    /**
     * Tier 3: remove a download *and* delete its data. Asks the server what the download covers and
     * for a one-time token, then needs the confirmation word typed before the button works.
     * @param {Object} target Download (instanceId, downloadId).
     * @param {string} busyId Row id.
     * @param {HTMLElement} opener The control clicked.
     * @param {{blocklist?: boolean, searchAgain?: boolean}} [choices] Choices from the Tier 2 dialog.
     * @returns {Promise<void>}
     */
    async function confirmDataDialog(target, busyId, opener, choices) {
        // The answer may come after the admin left the tab or someone else signed in: then nothing
        // opens. The row is busy meanwhile.
        const generation = state.generation;
        const tab = state.tab;
        closeDialog();
        state.busy.add(busyId);
        draw();
        let confirmation;
        try {
            confirmation = await JE.core.api.plugin('/arr/admin/queue/confirm', { method: 'POST', body: { instanceId: target.instanceId, downloadId: target.downloadId }, skipRetry: true });
        } catch (err) {
            state.busy.delete(busyId);
            if (generation !== state.generation || !tab || state.tab !== tab) return;
            report(busyId, { status: 'Failed', message: err?.status === 404 ? tr('arr_ops_not_in_queue') : (err?.message || String(err)) });
            return;
        }
        state.busy.delete(busyId);
        if (generation !== state.generation || !tab || state.tab !== tab) return;
        draw();
        const dl = confirmation?.download || {};
        const word = tr('arr_ops_confirm_word');
        const { box, buttons } = openDialog(tr('arr_ops_delete_title'), opener);
        const warn = el('div', 'je-ops-warnbox');
        warn.appendChild(el('p', '', tr('arr_ops_delete_body', { title: [dl.title, dl.scope].filter(Boolean).join(' '), instance: dl.instance || '' })));
        if (dl.episodes > 1) warn.appendChild(el('p', '', tr('arr_ops_remove_pack', { scope: dl.scope || '', n: dl.episodes })));
        warn.appendChild(el('p', '', [dl.release, dl.client, dl.size ? A.size(dl.size) : ''].filter(Boolean).join(' · ')));
        box.appendChild(warn);
        box.appendChild(el('p', '', tr('arr_ops_delete_type', { word })));
        const input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', tr('arr_ops_delete_type', { word }));
        box.appendChild(input);
        const ok = dialogButton(tr('arr_ops_action_remove_with_data'), 'je-ops-btn-danger');
        ok.disabled = true;
        input.addEventListener('input', () => { ok.disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); });
        const cancel = dialogButton(tr('arr_ops_cancel'));
        ok.addEventListener('click', () => {
            if (ok.disabled) return;
            const body = {
                instanceId: target.instanceId,
                downloadId: target.downloadId,
                action: 'remove_with_data',
                blocklist: choices?.blocklist === true,
                searchAgain: choices?.searchAgain === true,
                confirmationToken: confirmation?.token
            };
            closeDialog();
            runQueue(body, busyId, opener);
        });
        cancel.addEventListener('click', () => closeDialog());
        buttons.appendChild(cancel);
        buttons.appendChild(ok);
        box.appendChild(buttons);
        input.focus();
    }

    JE.session?.onUserChange?.('arr-hub-admin', () => {
        state.data = {};
        state.loadedAt = {};
        state.results = {};
        state.banner = null;
        state.busy.clear();
        leave();
        closeDialog();
    });

    A.tabs = tabs;
    A.render = render;
    A.removeDialog = removeDialog;
    A.closeDialog = closeDialog;
    A.leave = leave;
    A.refresh = () => (state.tab ? load(state.tab, true) : Promise.resolve());
    A.state = state;
    A.TABS = TABS;
})(window.JellyfinEnhanced);
