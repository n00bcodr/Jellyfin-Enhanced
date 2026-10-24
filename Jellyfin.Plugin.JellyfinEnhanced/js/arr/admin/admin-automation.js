/**
 * @file Requests & downloads, phase 4: the Automation card of the administrator's Overview tab. Reads
 * GET /JellyfinEnhanced/arr/admin/automation/status when the Overview tab is (re)loaded (admin-tabs.js
 * asks; no polling of its own) and shows, only when it applies: the rollout guard, the engine and its
 * kill switches, each recipe's effective mode, full budgets, open circuit breakers (with Try again
 * now: POST …/automation/breakers/reset), held automatic requests, the Seerr / status-only boundary,
 * unavailable accounting and the one-time migration notice (Got it: POST …/automation/notice/dismiss).
 * A failed read just hides the card. Pure DOM: every value goes in through textContent.
 */
(function (JE) {
    'use strict';

    const A = ((JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {}).admin = JE.internals.arrHub.admin || {};
    const logPrefix = '🪼 Jellyfin Enhanced: Requests (admin):';

    const RECIPE_KEYS = {
        auto_season: 'arr_auto_recipe_auto_season',
        auto_movie: 'arr_auto_recipe_auto_movie',
        keep_up: 'arr_auto_recipe_keep_up',
        list_acquire_ahead: 'arr_auto_recipe_list_acquire_ahead',
        release_day: 'arr_auto_recipe_release_day',
        list_sync: 'arr_auto_recipe_list_sync',
        list_sync_requests: 'arr_auto_recipe_list_sync_requests'
    };
    const MODE_KEYS = {
        off: 'arr_auto_mode_off',
        shadow: 'arr_auto_mode_shadow',
        ask: 'arr_auto_mode_ask',
        auto: 'arr_auto_mode_auto'
    };
    const REASON_KEYS = {
        shadow_override: 'arr_auto_reason_shadow_override',
        engine_off: 'arr_auto_reason_engine_off',
        recipe_off: 'arr_auto_reason_recipe_off',
        requests_off: 'arr_auto_reason_requests_off',
        seerr_unsupported: 'arr_auto_reason_seerr_unsupported',
        automation_killed: 'arr_auto_reason_automation_killed'
    };
    const CATEGORY_KEYS = {
        household_add: 'arr_auto_budget_household_add',
        instance_search: 'arr_auto_budget_instance_search',
        seerr_post: 'arr_auto_budget_seerr_post',
        source_fetch: 'arr_auto_budget_source_fetch',
        delta_work: 'arr_auto_budget_delta_work',
        backfill_search: 'arr_auto_budget_backfill_search'
    };
    const HELD_KEYS = {
        shadow_override: 'arr_auto_held_shadow_override',
        phase4_off: 'arr_auto_held_phase4_off',
        automation_killed: 'arr_auto_held_automation_killed',
        recipe_paused: 'arr_auto_held_recipe_paused',
        breaker_open: 'arr_auto_held_breaker_open',
        budget_exhausted: 'arr_auto_held_budget_exhausted',
        accounting_unavailable: 'arr_auto_held_accounting_unavailable',
        low_disk: 'arr_auto_held_low_disk',
        disk_unknown: 'arr_auto_held_disk_unknown',
        approval_required: 'arr_auto_held_approval_required',
        seerr_unsupported: 'arr_auto_held_seerr_unsupported',
        automation_changed: 'arr_auto_held_automation_changed',
        user_opted_out: 'arr_auto_held_user_opted_out'
    };

    const state = {
        // The last status body (null: none, or the last read failed).
        status: null,
        // What the card showed at the last notification ('' while hidden).
        shown: '',
        inFlight: null,
        again: false,
        onChange: null,
        generation: 0,
        // Buttons whose POST is under way, and the one whose last POST failed.
        busy: new Set(),
        failed: null
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
     * Translates a code through a key map, falling back to the code itself.
     * @param {Object<string, string>} keys Code → en.json key.
     * @param {string} code Code.
     * @returns {string} Text.
     */
    function label(keys, code) {
        return keys[code] ? tr(keys[code]) : String(code || '');
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
     * A time as the admin tabs show it ("Tue 14:05"), through admin-render.js when it is there.
     * @param {string|null} iso ISO date.
     * @returns {string} Text ('' when unknown).
     */
    function time(iso) {
        if (typeof A.when === 'function') return A.when(iso);
        if (!iso) return '';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }

    /**
     * True when the status has something the card shows.
     * @param {Object|null} status Status body.
     * @returns {boolean} Visible.
     */
    function visible(status) {
        return !!status && !!(status.shadowOverride || status.engine?.effective || notice(status));
    }

    /**
     * True when the one-time migration notice is due: it is pending and phase 4 is in effect (with phase 4 off nothing
     * the migration recorded acts, so administrators see nothing new).
     * @param {Object|null} status Status body.
     * @returns {boolean} Show the notice.
     */
    function notice(status) {
        return !!status?.phase4?.effective && status.migration?.notice === 'pending';
    }

    /**
     * What the card shows for a status, to tell whether a new read changed it.
     * @param {Object|null} status Status body.
     * @returns {string} Signature ('' when hidden).
     */
    function signature(status) {
        return visible(status) ? JSON.stringify(status) : '';
    }

    /**
     * Keeps a read's outcome and tells the tabs when what the card shows changed.
     * @param {Object|null} status New status (null: hide the card).
     * @returns {void}
     */
    function settle(status) {
        state.status = status;
        const now = signature(status);
        if (now === state.shown) return;
        state.shown = now;
        state.onChange?.();
    }

    /**
     * One read of the automation status: keeps the answer, or hides the card on any failure
     * (403 not an administrator, 404 an older server, anything else: a warning, never an error).
     * @param {number} generation The session generation the read started in.
     * @returns {Promise<void>}
     */
    async function fetchStatus(generation) {
        try {
            const body = await JE.core.api.plugin('/arr/admin/automation/status', { skipRetry: true });
            if (generation !== state.generation) return;
            settle(body && typeof body === 'object' ? body : null);
        } catch (err) {
            if (generation !== state.generation) return;
            if (err?.status !== 403 && err?.status !== 404) console.warn(`${logPrefix} could not read the automation status (${err?.status || err?.message || err})`);
            settle(null);
        }
    }

    /**
     * Reads the automation status (one read at a time; asked again while one runs, it reads once
     * more after it when the ask is fresh).
     * @param {boolean} [fresh] Something changed: the answer must come from a read that starts now.
     * @returns {Promise<void>}
     */
    function read(fresh) {
        if (state.inFlight) {
            if (fresh) state.again = true;
            return state.inFlight;
        }
        state.again = false;
        const generation = state.generation;
        const run = fetchStatus(generation).then(() => {
            if (state.inFlight === run) state.inFlight = null;
            return state.again && generation === state.generation ? read() : undefined;
        });
        state.inFlight = run;
        return run;
    }

    /**
     * Reads the automation status for the Overview tab and calls onChange when what the card shows
     * changed (appeared, changed or went away).
     * @param {Function} [onChange] Redraws the tab.
     * @returns {Promise<void>}
     */
    function refreshAutomation(onChange) {
        if (typeof onChange === 'function') state.onChange = onChange;
        return read();
    }

    /**
     * Runs one of the card's POST actions, then reads the status again.
     * @param {string} key Busy / focus key of the button.
     * @param {string} path Plugin route.
     * @param {Object} body Request body.
     * @param {any} [origin] The click's origin: the action is sent, and its answer shown, in that session only.
     * @returns {Promise<void>}
     */
    async function act(key, path, body, origin) {
        origin = JE.core.userWrite.originOf(origin);
        if (state.busy.has(key)) return;
        state.busy.add(key);
        state.failed = null;
        state.onChange?.();
        try {
            await JE.core.api.plugin(path, { method: 'POST', body, skipRetry: true, session: origin });
        } catch (err) {
            console.warn(`${logPrefix} automation action failed (${err?.status || err?.message || err})`);
            // A lost answer may have been done: "couldn't confirm" (the status read below says what holds), not failed.
            if (err?.sessionChanged || !JE.core.userWrite.isBound(origin)) return;
            if (JE.core.userWrite.outcome(err) === 'uncertain') JE.core.userWrite.reportUncertain(err);
            else state.failed = key;
        } finally {
            state.busy.delete(key);
        }
        if (!JE.core.userWrite.isBound(origin)) return;
        state.onChange?.();
        await read(true);
    }

    /**
     * A card button that keeps focus across redraws and shows its POST under way.
     * @param {string} text Label.
     * @param {string} key Busy / focus key.
     * @param {Function} onClick Action.
     * @returns {HTMLButtonElement} Button.
     */
    function actionButton(text, key, onClick) {
        const b = el('button', 'je-ops-btn');
        b.type = 'button';
        b.dataset.jeFocus = `automation:${key}`;
        b.textContent = state.busy.has(key) ? tr('arr_ops_working') : text;
        if (state.busy.has(key)) b.setAttribute('aria-disabled', 'true');
        b.addEventListener('click', () => {
            if (!state.busy.has(key)) onClick();
        });
        return b;
    }

    /**
     * A line of the card.
     * @param {HTMLElement} box Card.
     * @param {string} text Text.
     * @param {string} [cls] Extra classes.
     * @returns {HTMLElement} Line.
     */
    function line(box, text, cls) {
        const row = el('div', `je-ops-auto-line${cls ? ' ' + cls : ''}`, text);
        box.appendChild(row);
        return row;
    }

    /**
     * The failure note under a button whose last POST failed.
     * @param {HTMLElement} row Row of the button.
     * @param {string} key Busy / focus key.
     * @returns {void}
     */
    function failedNote(row, key) {
        if (state.failed !== key) return;
        const note = el('div', 'je-ops-item-sub je-ops-bad', tr('arr_auto_action_failed'));
        note.setAttribute('role', 'status');
        row.appendChild(note);
    }

    /**
     * The engine, kill switches and recipes.
     * @param {HTMLElement} box Card.
     * @param {Object} s Status.
     * @returns {void}
     */
    function engineLines(box, s) {
        const on = !!s.engine?.effective;
        line(box, tr(on ? 'arr_auto_engine_on' : 'arr_auto_engine_off'), on ? 'je-ops-ok' : 'je-ops-muted');
        if (s.killAll) line(box, tr('arr_auto_kill_all'), 'je-ops-bad');
        const killed = (s.targets || []).filter(t => t.killed).map(t => t.name || t.id);
        if (killed.length) line(box, tr('arr_auto_killed_targets', { names: killed.join(', ') }), 'je-ops-warn');
        const recipes = (s.recipes || []).filter(r => r.effective != null);
        if (!recipes.length) return;
        const list = el('ul', 'je-ops-auto-list');
        for (const r of recipes) {
            const params = { recipe: label(RECIPE_KEYS, r.id), mode: label(MODE_KEYS, r.effective) };
            const text = r.reason ? tr('arr_auto_recipe_line_reason', { ...params, reason: label(REASON_KEYS, r.reason) }) : tr('arr_auto_recipe_line', params);
            const item = el('li', '', text);
            item.dataset.recipe = r.id;
            list.appendChild(item);
        }
        box.appendChild(list);
    }

    /**
     * Full budgets and the sends still waiting for a read-back.
     * @param {HTMLElement} box Card.
     * @param {Object} s Status.
     * @returns {void}
     */
    function budgetLines(box, s) {
        const budgets = (s.budgets || []).filter(b => !b.reserved);
        for (const b of budgets) {
            if (!(b.used >= b.limit)) continue;
            const params = { category: label(CATEGORY_KEYS, b.category), scope: b.scopeName || b.scope || '', window: b.window || '', used: b.used, limit: b.limit };
            const at = time(b.nextSlotAt);
            line(box, at ? tr('arr_auto_budget_full', { ...params, time: at }) : tr('arr_auto_budget_full_no_time', params), 'je-ops-warn');
        }
        // One send counts in several budgets (each scope and window): the largest count, not the sum.
        const uncertain = Math.max(0, ...budgets.map(b => Number(b.uncertain) || 0));
        if (uncertain > 0) line(box, tr(uncertain === 1 ? 'arr_auto_uncertain_one' : 'arr_auto_uncertain', { n: uncertain }));
    }

    /**
     * Open circuit breakers, each with Try again now.
     * @param {HTMLElement} box Card.
     * @param {Object} s Status.
     * @returns {void}
     */
    function breakerLines(box, s) {
        for (const t of s.targets || []) {
            if (!t.breakerOpenUntil) continue;
            const key = `breaker:${t.id}`;
            const row = el('div', 'je-ops-auto-row');
            row.appendChild(el('div', 'je-ops-auto-line je-ops-warn', tr('arr_auto_breaker', { name: t.name || t.id, time: time(t.breakerOpenUntil) })));
            row.appendChild(actionButton(tr('arr_auto_breaker_reset'), key, () => act(key, '/arr/admin/automation/breakers/reset', { target: t.id })));
            failedNote(row, key);
            box.appendChild(row);
        }
    }

    /**
     * Held automatic requests by reason.
     * @param {HTMLElement} box Card.
     * @param {Object} s Status.
     * @returns {void}
     */
    function heldLines(box, s) {
        for (const [reason, count] of Object.entries(s.held || {})) {
            if (!(count > 0)) continue;
            line(box, tr('arr_auto_held', { count, reason: label(HELD_KEYS, reason) }));
        }
    }

    /**
     * The one-time migration notice, with Got it.
     * @param {HTMLElement} box Card.
     * @param {Object} m Migration.
     * @returns {void}
     */
    function migrationNotice(box, m) {
        const key = 'notice';
        const row = el('div', 'je-ops-auto-row je-ops-auto-notice');
        const mode = on => tr(on ? 'arr_auto_mode_auto' : 'arr_auto_mode_off');
        row.appendChild(el('div', 'je-ops-auto-line', tr('arr_auto_migration', { season: mode(m.autoSeason), movie: mode(m.autoMovie) })));
        const names = (m.grants || []).map(g => g.name || g.userId).filter(Boolean);
        if (names.length) row.appendChild(el('div', 'je-ops-auto-line', tr('arr_auto_migration_grants', { names: names.join(', ') })));
        row.appendChild(actionButton(tr('arr_auto_got_it'), key, () => act(key, '/arr/admin/automation/notice/dismiss', {})));
        failedNote(row, key);
        box.appendChild(row);
    }

    /**
     * The Automation card of the Overview tab, or null when there is nothing to show.
     * @returns {HTMLElement|null} Card.
     */
    function automationCard() {
        const s = state.status;
        if (!visible(s)) return null;
        const box = el('section', 'je-ops-box je-ops-automation');
        box.setAttribute('role', 'region');
        box.setAttribute('aria-label', tr('arr_auto_title'));
        box.appendChild(el('h2', 'je-ops-box-title', tr('arr_auto_title')));
        if (s.shadowOverride) line(box, tr('arr_auto_shadow_override'), 'je-ops-banner je-ops-banner-unknown');
        if (s.accountingUnavailable) line(box, tr('arr_auto_accounting_unavailable'), 'je-ops-banner je-ops-banner-unknown');
        engineLines(box, s);
        budgetLines(box, s);
        breakerLines(box, s);
        heldLines(box, s);
        if (s.backend === 'seerr') line(box, tr('arr_auto_seerr'), 'je-ops-item-sub');
        else if (s.backend === 'status_only') line(box, tr('arr_auto_status_only'), 'je-ops-item-sub');
        if (notice(s)) migrationNotice(box, s.migration);
        return box;
    }

    // Another person's hub never shows the last one's automation status.
    JE.session?.onUserChange?.('arr-hub-admin-automation', () => {
        state.generation++;
        state.status = null;
        state.shown = '';
        state.inFlight = null;
        state.again = false;
        state.onChange = null;
        state.busy.clear();
        state.failed = null;
    });

    A.refreshAutomation = refreshAutomation;
    A.automationCard = automationCard;
})(window.JellyfinEnhanced);
