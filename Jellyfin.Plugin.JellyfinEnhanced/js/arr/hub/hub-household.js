/**
 * @file Requests & downloads, phase 3: the Household tab of the Requests page (#/requests?tab=
 * household), for Managers and Admins, from GET /JellyfinEnhanced/acquire/household. One card per
 * person (Managers see the people who share a library with them): name, role, request use and
 * their open requests on titles the viewer can see. Administrators also pick each person's role and
 * request limit, see 4K holders and a parental-limit hint, and set the house rules (preset, default
 * role, household and per-role limits); Save asks for a confirmation, then POSTs only what changed
 * to /JellyfinEnhanced/acquire/household and says how it went. Cards, no wide tables; every
 * control is a real, focusable button or select (TV and 420 px friendly).
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext;
    const TAB = 'household';
    const ROUTE = '/acquire/household';
    const ROLES = ['watcher', 'kid', 'member', 'manager'];
    const PRESETS = ['ask_first', 'open_house', 'approve_everything'];
    const LIMITS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50];
    const logPrefix = '🪼 Jellyfin Enhanced: Household:';

    const tokens = X.intent(TAB);
    const state = {
        data: null,
        error: false,
        epoch: null,
        panel: null,
        shown: false,
        loading: null,
        unfollow: null,
        edits: { users: new Map(), roles: new Map(), preset: null, defaultRole: null, quotaLimit: null },
        confirming: false,
        saving: false,
        result: null,
        stale: false
    };

    /**
     * Forgets everything read or edited for another user.
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === X.epoch()) return;
        state.epoch = X.epoch();
        state.data = null;
        state.error = false;
        state.result = null;
        state.stale = false;
        discard();
        tokens.drop();
    }

    /**
     * Drops unsaved edits.
     * @returns {void}
     */
    function discard() {
        state.edits = { users: new Map(), roles: new Map(), preset: null, defaultRole: null, quotaLimit: null };
        state.confirming = false;
    }

    /**
     * True when there are unsaved edits.
     * @returns {boolean} Dirty.
     */
    function dirty() {
        const e = state.edits;
        return e.users.size > 0 || e.roles.size > 0 || e.preset !== null || e.defaultRole !== null || e.quotaLimit !== null;
    }

    /**
     * Reads the household under a fresh intent token (only the current token's answer is shown).
     * @returns {Promise<void>}
     */
    async function load() {
        resetForUser();
        const token = tokens.next();
        const run = (async () => {
            const answer = await X.call(ROUTE);
            if (!tokens.isCurrent(token)) return;
            if (answer.status === 200 && Array.isArray(answer.body?.people)) {
                state.data = answer.body;
                state.error = false;
                state.stale = false;
            } else {
                state.error = true;
                console.warn(`${logPrefix} could not load (${answer.status || 'no answer'})`);
            }
            if (state.loading === run) state.loading = null;
            draw();
        })();
        state.loading = run;
        return run;
    }

    /**
     * Shows the tab in the page's panel (called on every page render).
     * @param {HTMLElement} panel Panel.
     * @returns {void}
     */
    function render(panel) {
        resetForUser();
        H.injectExtraStyles?.();
        const first = !state.shown;
        state.panel = panel;
        state.shown = true;
        if (!state.unfollow) {
            state.unfollow = X.follow(['req:state'], () => {
                if (!state.shown) return;
                // Never throw away an administrator's unsaved edits: say the household changed instead.
                if (dirty() || state.saving) {
                    state.stale = true;
                    draw();
                } else load();
            });
        }
        draw();
        const inFlight = state.loading && tokens.isCurrent(tokens.current());
        if ((first || !state.data) && !inFlight) load();
    }

    /**
     * The tab is no longer shown: stop following and forget the panel (edits stay until a user switch).
     * @returns {void}
     */
    function leave() {
        if (!state.shown) return;
        state.shown = false;
        state.panel = null;
        tokens.drop();
        state.loading = null;
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
    }

    /**
     * A role's words.
     * @param {string} role watcher, kid, member, manager or admin.
     * @returns {string} Text.
     */
    function roleText(role) {
        return X.tr(`arr_approvals_role_${ROLES.includes(role) || role === 'admin' ? role : 'watcher'}`);
    }

    /**
     * "3 of 7 used" / "2 used · no limit" ('' when unknown).
     * @param {Object} quota Quota.
     * @returns {string} Text.
     */
    function quotaText(quota) {
        if (!quota || quota.available === false || typeof quota.used !== 'number') return '';
        return typeof quota.limit === 'number' ? X.tr('arr_approvals_quota', { used: quota.used, limit: quota.limit }) : X.tr('arr_approvals_quota_unlimited', { used: quota.used });
    }

    /**
     * A select of request limits: the inherited value, no limit, then fixed numbers (and the current
     * value when it isn't one of them).
     * @param {number|null} value Current value (null: inherited).
     * @param {string} inheritKey en.json key of the inherited choice.
     * @param {string} focusId Focus id.
     * @param {string} label Accessible label.
     * @param {function(number|null): void} onChange Called with the new value.
     * @returns {HTMLSelectElement} Select.
     */
    function limitSelect(value, inheritKey, focusId, label, onChange) {
        const select = document.createElement('select');
        select.className = 'je-household-select';
        select.dataset.jeFocus = focusId;
        select.setAttribute('aria-label', label);
        const options = [['', X.tr(inheritKey)], ['-1', X.tr('arr_household_no_limit')]];
        const numbers = [...LIMITS];
        if (typeof value === 'number' && value > 0 && !numbers.includes(value)) numbers.push(value);
        numbers.sort((a, b) => a - b).forEach(n => options.push([String(n), X.tr('arr_household_limit_n', { n })]));
        for (const [v, text] of options) {
            const option = document.createElement('option');
            option.value = v;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = value === null || value === undefined || value === 0 ? '' : String(value);
        select.addEventListener('change', () => onChange(select.value === '' ? null : Number(select.value)));
        return select;
    }

    /**
     * A select from fixed choices.
     * @param {Array<[string, string]>} choices Value and words.
     * @param {string} value Current value.
     * @param {string} focusId Focus id.
     * @param {string} label Accessible label.
     * @param {function(string): void} onChange Called with the new value.
     * @returns {HTMLSelectElement} Select.
     */
    function choiceSelect(choices, value, focusId, label, onChange) {
        const select = document.createElement('select');
        select.className = 'je-household-select';
        select.dataset.jeFocus = focusId;
        select.setAttribute('aria-label', label);
        for (const [v, text] of choices) {
            const option = document.createElement('option');
            option.value = v;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = value;
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    /**
     * A labelled field (words above the control).
     * @param {string} text Label words.
     * @param {HTMLElement} control Control.
     * @returns {HTMLElement} Field.
     */
    function field(text, control) {
        const label = X.el('label', 'je-household-field');
        label.appendChild(X.el('span', 'je-household-field-label', text));
        label.appendChild(control);
        return label;
    }

    /**
     * The edited value of a person's override, or the served one.
     * @param {Object} person Person.
     * @returns {{role: string|null, quotaLimit: number|null}} Override.
     */
    function personOverride(person) {
        const edit = state.edits.users.get(person.id);
        if (edit) return edit;
        return { role: person.admin?.roleOverride ?? null, quotaLimit: person.admin?.quotaOverride ?? null };
    }

    /**
     * Changes one person's override (an edit equal to what was served is no edit).
     * @param {Object} person Person.
     * @param {Object} change Part to change ({role} or {quotaLimit}).
     * @returns {void}
     */
    function editPerson(person, change) {
        const next = { ...personOverride(person), ...change };
        const served = { role: person.admin?.roleOverride ?? null, quotaLimit: person.admin?.quotaOverride ?? null };
        if (next.role === served.role && next.quotaLimit === served.quotaLimit) state.edits.users.delete(person.id);
        else state.edits.users.set(person.id, next);
        state.confirming = false;
        state.result = null;
        draw();
    }

    /**
     * The house rules (administrators): preset, default role, household and per-role limits.
     * @param {Object} settings Served settings.
     * @returns {HTMLElement} Section.
     */
    function rulesSection(settings) {
        const section = X.el('section', 'je-household-rules');
        section.appendChild(X.el('h2', 'je-hub-group-title', X.tr('arr_household_rules')));
        const e = state.edits;
        const preset = e.preset ?? settings.preset;
        section.appendChild(field(X.tr('arr_household_preset'), choiceSelect(PRESETS.map(p => [p, X.tr(`arr_household_preset_${p}`)]), preset, 'household:preset', X.tr('arr_household_preset'), (v) => {
            e.preset = v === settings.preset ? null : v;
            state.confirming = false;
            state.result = null;
            draw();
        })));
        section.appendChild(X.el('div', 'je-household-help', X.tr(`arr_household_preset_${preset}_help`)));
        const defaultRole = e.defaultRole ?? settings.defaultRole;
        section.appendChild(field(X.tr('arr_household_default_role'), choiceSelect(ROLES.map(r => [r, roleText(r)]), defaultRole, 'household:default-role', X.tr('arr_household_default_role'), (v) => {
            e.defaultRole = v === settings.defaultRole ? null : v;
            state.confirming = false;
            state.result = null;
            draw();
        })));
        const limit = e.quotaLimit ?? settings.quotaLimit;
        section.appendChild(field(X.tr('arr_household_limit'), limitSelect(limit === 0 ? null : limit, 'arr_household_preset_default', 'household:limit', X.tr('arr_household_limit'), (v) => {
            const value = v === null ? 0 : v;
            e.quotaLimit = value === settings.quotaLimit ? null : value;
            state.confirming = false;
            state.result = null;
            draw();
        })));
        const roles = X.el('div', 'je-household-role-limits');
        for (const role of ['kid', 'member', 'manager']) {
            const served = settings.roles?.[role]?.quotaLimit ?? null;
            const edited = e.roles.has(role) ? e.roles.get(role) : served;
            roles.appendChild(field(X.tr('arr_household_role_limit', { role: roleText(role) }), limitSelect(edited, 'arr_household_inherit', `household:role-limit:${role}`, X.tr('arr_household_role_limit', { role: roleText(role) }), (v) => {
                if (v === served) e.roles.delete(role);
                else e.roles.set(role, v);
                state.confirming = false;
                state.result = null;
                draw();
            })));
        }
        section.appendChild(roles);
        section.appendChild(X.el('div', 'je-household-help', X.tr('arr_household_window', { days: settings.windowDays })));
        return section;
    }

    /**
     * One person's card.
     * @param {Object} person Person.
     * @param {boolean} canEdit The viewer is an administrator.
     * @param {Object|null} settings Served settings (administrators).
     * @returns {HTMLElement} Card.
     */
    function personCard(person, canEdit, settings) {
        const node = X.el('article', 'je-household-person');
        node.dataset.personId = person.id;
        const head = X.el('div', 'je-household-head');
        const name = X.el('h3', 'je-household-name', person.name || X.tr('arr_approvals_someone'));
        if (person.you) name.appendChild(X.el('span', 'je-household-you', X.tr('arr_household_you')));
        head.appendChild(name);
        const role = X.el('span', `je-household-role je-household-role-${person.role}`);
        role.appendChild(X.icon(person.role === 'admin' ? 'supervisor_account' : person.role === 'manager' ? 'how_to_reg' : person.role === 'kid' ? 'child_care' : 'person'));
        role.appendChild(document.createTextNode(roleText(person.role)));
        head.appendChild(role);
        if (person.admin?.fourK) {
            const fourK = X.el('span', 'je-hub-chip je-household-4k', X.tr('arr_household_4k'));
            head.appendChild(fourK);
        }
        node.appendChild(head);
        const usage = [quotaText(person.quota), X.tr('arr_household_open', { active: person.active | 0, waiting: person.waiting | 0 })].filter(Boolean).join(' · ');
        node.appendChild(X.el('div', 'je-approval-meta', usage));
        if (Array.isArray(person.requests) && person.requests.length) {
            const list = X.el('ul', 'je-household-requests');
            for (const request of person.requests) {
                const li = X.el('li', 'je-household-request');
                li.appendChild(X.poster(request, 'je-household-poster'));
                const words = X.el('div', 'je-household-request-body');
                words.appendChild(X.el('div', 'je-household-request-title', X.titleText(request)));
                // Where the part asked for has got to (downloading, almost ready, ...) when the server says; else the request's state.
                const state = request.group !== 'needsOk' && X.partText(request.partStatus);
                words.appendChild(X.el('div', 'je-approval-meta', [X.scopeText(request), state || X.tr(`arr_household_state_${request.group === 'needsOk' ? 'waiting' : 'on_the_way'}`)].join(' · ')));
                li.appendChild(words);
                list.appendChild(li);
            }
            node.appendChild(list);
        }
        if (canEdit && person.admin) {
            const controls = X.el('div', 'je-household-controls');
            if (person.admin.jellyfinAdmin) {
                controls.appendChild(X.el('div', 'je-household-help', X.tr('arr_household_jellyfin_admin')));
            } else {
                const current = personOverride(person);
                const defaultRole = state.edits.defaultRole ?? settings?.defaultRole ?? 'watcher';
                const choices = [['', X.tr('arr_household_role_default', { role: roleText(defaultRole) })], ...ROLES.map(r => [r, roleText(r)])];
                controls.appendChild(field(X.tr('arr_household_role'), choiceSelect(choices, current.role || '', `household:role:${person.id}`,
                    X.tr('arr_household_role_for', { name: person.name }), v => editPerson(person, { role: v || null }))));
                controls.appendChild(field(X.tr('arr_household_person_limit'), limitSelect(current.quotaLimit, 'arr_household_inherit', `household:quota:${person.id}`,
                    X.tr('arr_household_person_limit_for', { name: person.name }), v => editPerson(person, { quotaLimit: v }))));
                if (person.admin.parentalLimit && (current.role || person.role) !== 'kid') {
                    controls.appendChild(X.el('div', 'je-household-help', X.tr('arr_household_kid_hint')));
                }
            }
            node.appendChild(controls);
        }
        return node;
    }

    /**
     * The save bar (administrators with unsaved edits, or a save outcome to show).
     * @returns {HTMLElement|null} Bar.
     */
    function saveBar() {
        if (!dirty() && !state.result) return null;
        const bar = X.el('div', 'je-household-save');
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', X.tr('arr_household_save'));
        if (state.result) {
            const line = X.el('div', `je-approval-result je-approvals-tone-${state.result.tone}`, state.result.text);
            line.setAttribute('role', 'status');
            bar.appendChild(line);
        }
        if (!dirty()) return bar;
        if (state.confirming) {
            bar.appendChild(X.el('div', 'je-household-confirm', X.tr('arr_household_confirm')));
            const yes = X.button('je-approval-btn je-approval-approve', X.tr('arr_household_confirm_yes'), 'check', 'household:confirm');
            X.busy(yes, state.saving);
            yes.addEventListener('click', () => save());
            const back = X.button('je-hub-btn', X.tr('arr_household_confirm_no'), null, 'household:keep-editing');
            X.busy(back, state.saving);
            back.addEventListener('click', () => { if (!state.saving) { state.confirming = false; draw(); } });
            bar.appendChild(yes);
            bar.appendChild(back);
        } else {
            const save = X.button('je-approval-btn je-approval-approve', X.tr('arr_household_save'), 'save', 'household:save');
            save.addEventListener('click', () => { state.confirming = true; state.result = null; draw(); });
            const reset = X.button('je-hub-btn', X.tr('arr_household_discard'), 'undo', 'household:discard');
            reset.addEventListener('click', () => { discard(); state.result = null; draw(); if (state.stale) load(); });
            bar.appendChild(save);
            bar.appendChild(reset);
        }
        return bar;
    }

    /**
     * The save body: only what changed (each changed person with both of their override fields).
     * @returns {Object} Body.
     */
    function saveBody() {
        const e = state.edits;
        const body = {};
        if (e.preset !== null) body.preset = e.preset;
        if (e.defaultRole !== null) body.defaultRole = e.defaultRole;
        if (e.quotaLimit !== null) body.quotaLimit = e.quotaLimit;
        if (e.roles.size) body.roles = Object.fromEntries([...e.roles].map(([role, limit]) => [role, { quotaLimit: limit }]));
        if (e.users.size) body.users = Object.fromEntries([...e.users].map(([id, o]) => [id, { role: o.role, quotaLimit: o.quotaLimit }]));
        return body;
    }

    /**
     * Saves the edits (after the confirmation) and says how it went; reads the household again.
     * @returns {Promise<void>}
     */
    async function save() {
        if (state.saving || !dirty()) return;
        state.saving = true;
        draw();
        const asked = X.epoch();
        const answer = await X.call(ROUTE, { method: 'POST', body: saveBody() });
        state.saving = false;
        if (asked !== X.epoch()) return;
        const ok = answer.status === 200;
        let text = X.tr(ok ? 'arr_household_saved' : answer.status === 400 ? 'arr_household_save_invalid' : answer.status === 403 ? 'arr_household_save_denied' : 'arr_household_save_failed');
        if (!ok && typeof answer.body?.reason === 'string' && answer.body.reason) text = X.tr('arr_approvals_result_code', { text, code: answer.body.reason });
        state.result = { text, tone: ok ? 'done' : 'attention' };
        state.confirming = false;
        if (ok) discard();
        draw();
        if (ok) load();
    }

    /**
     * Draws the tab from what is known, keeping focus on the same control.
     * @returns {void}
     */
    function draw() {
        const panel = state.panel;
        if (!panel || !state.shown || !panel.isConnected) return;
        const focus = X.focusedId(panel);
        panel.textContent = '';
        const box = X.el('div', 'je-household');
        panel.appendChild(box);
        if (!state.data) {
            const empty = X.el('div', 'je-hub-empty', X.tr(state.error ? 'arr_household_error' : 'arr_household_loading'));
            if (state.error) {
                const retry = X.button('je-hub-btn', X.tr('arr_approvals_retry'), 'refresh', 'household:retry');
                retry.addEventListener('click', () => { state.error = false; draw(); load(); });
                empty.appendChild(retry);
            }
            box.appendChild(empty);
            X.restoreFocus(panel, focus, ['household:retry']);
            return;
        }
        if (state.error) box.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_household_error')));
        if (state.stale) box.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_household_changed')));
        const data = state.data;
        const canEdit = data.canEdit === true && !!data.settings;
        if (canEdit) box.appendChild(rulesSection(data.settings));
        const people = X.el('section', 'je-household-people');
        people.appendChild(X.el('h2', 'je-hub-group-title', X.tr('arr_household_people')));
        if (!data.people.length) people.appendChild(X.el('div', 'je-hub-empty', X.tr('arr_household_empty')));
        const list = X.el('div', 'je-household-list');
        data.people.forEach(p => list.appendChild(personCard(p, canEdit, data.settings || null)));
        people.appendChild(list);
        box.appendChild(people);
        const bar = canEdit ? saveBar() : null;
        if (bar) box.appendChild(bar);
        X.restoreFocus(panel, focus, ['household:save', 'household:preset']);
    }

    // The page redraws for the new user once their capabilities are known; the tab reads then.
    JE.session?.onUserChange?.('arr-household', () => resetForUser());

    H.extraTabs = H.extraTabs || [];
    H.extraTabs.push({ id: TAB, label: 'arr_household_tab', visible: () => X.approver(), render, leave });
    H.household = { load, state, saveBody };
})(window.JellyfinEnhanced);
