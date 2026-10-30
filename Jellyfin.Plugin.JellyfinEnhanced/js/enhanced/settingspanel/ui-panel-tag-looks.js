// @ts-check
/**
 * @file "Where each look applies" in the settings panel's Media Tags
 * section: the tag look rules (ordered, first match wins, each with an
 * On/Off switch, Edit and Delete), the add/edit rule form, the "Otherwise"
 * row (the default layout) and the locked items list (lazy titles, Unlock,
 * Unlock all). Data and saving live in core/tag-look.js; every change
 * re-presents the cards through JE.reinitializeTagLayout() without a refetch.
 * Everything is built with DOM APIs (textContent), never innerHTML.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const TITLE_BATCH = 50;
    const CONFIRM_MS = 4000;

    const PANEL_CSS = `
        .je-tag-looks { margin: 0; }
        .je-tag-looks-title { font-weight: 500; }
        .je-tag-looks-desc { font-size: 12px; color: rgba(255,255,255,0.6); margin: 2px 0 8px; }
        .je-tag-looks-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .je-tag-looks-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 8px; border-radius: 6px; background: rgba(255,255,255,0.05); }
        .je-tag-looks-row[data-off="1"] .je-tag-looks-text { opacity: 0.55; }
        .je-tag-looks-text { flex: 1 1 180px; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
        .je-tag-looks-outcome { display: block; font-size: 12px; color: rgba(255,255,255,0.65); margin-top: 2px; }
        .je-tag-looks-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
        .je-tag-looks button, .je-tag-looks select, .je-tag-looks input {
            font: inherit; font-size: 12px; color: #fff; background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 4px 8px; min-height: 28px;
        }
        .je-tag-looks button { cursor: pointer; }
        .je-tag-looks button:hover:not(:disabled) { background: rgba(255,255,255,0.16); }
        .je-tag-looks button:disabled { opacity: 0.4; cursor: default; }
        .je-tag-looks button:focus-visible, .je-tag-looks select:focus-visible, .je-tag-looks input:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
        .je-tag-looks select option { background: #222; color: #fff; }
        .je-tag-looks-pill[aria-pressed="true"] { background: rgba(76,175,80,0.35); border-color: rgba(76,175,80,0.8); }
        .je-tag-looks-locked-list { list-style: none; margin: 6px 0 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
        .je-tag-looks-locked-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; padding: 4px 6px; border-radius: 4px; background: rgba(0,0,0,0.2); }
        .je-tag-looks-locked-list li > span { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
        .je-tag-looks-add { margin-top: 8px; }
        .je-tag-looks-form { margin-top: 8px; padding: 10px; border-radius: 6px; background: rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 8px; }
        .je-tag-looks-form fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .je-tag-looks-form fieldset > button { align-self: flex-start; }
        .je-tag-looks-form legend { font-size: 12px; font-weight: 500; padding: 0; margin-bottom: 4px; }
        .je-tag-looks-cond { display: flex; gap: 6px; align-items: center; }
        .je-tag-looks-cond > select, .je-tag-looks-cond > input { flex: 1 1 0; min-width: 0; }
        .je-tag-looks-cond > select:first-of-type { flex: 0 1 35%; }
        .je-tag-looks-cond > button { flex: 0 0 auto; }
        .je-tag-looks-outcome-row { display: flex; flex-wrap: wrap; gap: 8px; }
        .je-tag-looks-outcome-row label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; flex: 1 1 140px; min-width: 0; }
        .je-tag-looks-error { color: #ff8a80; font-size: 12px; min-height: 1em; }
        .je-tag-looks-buttons { display: flex; gap: 6px; justify-content: flex-end; }
        .je-tag-looks-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    `;

    /**
     * Shared lookups for one panel instance (fetched lazily, once).
     * @typedef {Object} LooksState
     * @property {Map<string, string>|null} libraries - library id → name.
     * @property {string[]|null} genres - null until loaded; [] when the request failed.
     * @property {Map<string, {name: string, type: string}>} titles - item id → title and type.
     * @property {boolean} lockedOpen
     * @property {string|null} editing - Rule id being edited, '' for a new rule, null when no form.
     */

    /**
     * Create an element with a class and optional text.
     * @param {string} tag
     * @param {string} [className]
     * @param {string} [text]
     * @returns {HTMLElement}
     */
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /**
     * A plain button.
     * @param {string} label
     * @param {() => void} onClick
     * @param {string} [ariaLabel]
     * @returns {HTMLButtonElement}
     */
    function button(label, onClick, ariaLabel) {
        const b = /** @type {HTMLButtonElement} */ (el('button', '', label));
        b.type = 'button';
        if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
        b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
        return b;
    }

    /**
     * A select with options [value, label].
     * @param {Array<[string, string]>} options
     * @param {string} value
     * @returns {HTMLSelectElement}
     */
    function select(options, value) {
        const s = /** @type {HTMLSelectElement} */ (el('select'));
        for (const [v, label] of options) {
            const o = /** @type {HTMLOptionElement} */ (el('option', '', label));
            o.value = v;
            if (v === value) o.selected = true;
            s.appendChild(o);
        }
        return s;
    }

    /** @param {string} layout @returns {string} */
    const layoutName = (layout) => JE.t(`tag_looks_layout_${layout}`);
    /** @param {string} density @returns {string} */
    const densityName = (density) => JE.t(density === 'compact' ? 'panel_settings_ui_tag_density_compact' : 'panel_settings_ui_tag_density_full');
    /** @param {{layout: string, density: string}} look @returns {string} */
    const outcomeText = (look) => JE.t('tag_looks_outcome', { layout: layoutName(look.layout), density: densityName(look.density) });
    /** @param {string} type @returns {string} */
    const typeName = (type) => JE.t(`tag_looks_type_${type.toLowerCase()}`);

    /**
     * "When library is Kids and type is Episode".
     * @param {Array<{field: string, value: string}>} when
     * @param {LooksState} state
     * @returns {string}
     */
    function conditionText(when, state) {
        const parts = when.map((cond) => {
            let value = cond.value;
            if (cond.field === 'library') value = state.libraries?.get(cond.value) || JE.t('tag_looks_unknown_library');
            else if (cond.field === 'type') value = typeName(cond.value);
            return JE.t(`tag_looks_cond_${cond.field.toLowerCase()}`, { value });
        });
        return JE.t('tag_looks_when', { conditions: parts.join(JE.t('tag_looks_and')) });
    }

    /**
     * The current user's id.
     * @returns {string}
     */
    function userId() {
        return (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || '';
    }

    /**
     * GET a JSON endpoint through ApiClient.
     * @param {string} path
     * @param {Object} [query]
     * @returns {Promise<any>}
     */
    function getJson(path, query) {
        return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(path, query), dataType: 'json' });
    }

    /**
     * Load the user's libraries (id → name) once.
     * @param {LooksState} state
     * @returns {Promise<void>}
     */
    async function loadLibraries(state) {
        if (state.libraries) return;
        const map = new Map();
        try {
            const resp = await getJson('UserViews', { userId: userId() });
            for (const view of resp?.Items || []) {
                const id = JE.core.tagLook.normalizeId(String(view?.Id || ''));
                if (id) map.set(id, String(view.Name || id));
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not load libraries for tag look rules', err);
        }
        state.libraries = map;
    }

    /**
     * Load the genre names once ([] when the request fails: the form then
     * offers a text box).
     * @param {LooksState} state
     * @returns {Promise<void>}
     */
    async function loadGenres(state) {
        if (state.genres) return;
        try {
            const resp = await getJson('Genres', { userId: userId(), SortBy: 'SortName', SortOrder: 'Ascending', Recursive: true, EnableImages: false, EnableTotalRecordCount: false });
            const names = new Set();
            for (const g of resp?.Items || []) if (g?.Name) names.add(String(g.Name));
            state.genres = Array.from(names);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not load genres for tag look rules', err);
            state.genres = [];
        }
    }

    /**
     * Age ratings present in the server tag cache already in memory,
     * normalised the way the age rating tags show them.
     * @returns {string[]}
     */
    function knownRatings() {
        const seen = new Set();
        try {
            for (const entry of JE.tagPipeline?.serverEntries?.() || []) {
                const raw = entry?.OfficialRating;
                if (!raw) continue;
                const text = String(raw).replace(/\s+/g, ' ').trim();
                const shown = typeof JE.normalizeOfficialRating === 'function' ? (JE.normalizeOfficialRating(text) || text) : text;
                seen.add(shown);
                if (seen.size >= 200) break;
            }
        } catch { /* the list is only a convenience */ }
        return Array.from(seen).sort();
    }

    /**
     * Fetch titles for locked items not known yet, 50 ids per request.
     * @param {LooksState} state
     * @param {string[]} ids
     * @returns {Promise<void>}
     */
    async function loadTitles(state, ids) {
        const missing = ids.filter((id) => !state.titles.has(id));
        for (let i = 0; i < missing.length; i += TITLE_BATCH) {
            const batch = missing.slice(i, i + TITLE_BATCH);
            try {
                const resp = await getJson(`Users/${userId()}/Items`, { Ids: batch.join(','), EnableImages: false, EnableUserData: false });
                for (const item of resp?.Items || []) {
                    const id = JE.core.tagLook.normalizeId(String(item?.Id || ''));
                    if (id) state.titles.set(id, { name: String(item.Name || id), type: String(item.Type || '') });
                }
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: could not load locked item titles', err);
            }
            // Ids the server didn't return (deleted, or no longer visible) keep their id as the title.
            for (const id of batch) if (!state.titles.has(id)) state.titles.set(id, { name: '', type: '' });
        }
    }

    /**
     * Render the whole section into its mount.
     * @param {HTMLElement} mount
     * @param {LooksState} state
     * @param {() => void} touch - Resets the panel's auto-close timer.
     */
    function render(mount, state, touch) {
        const look = JE.core.tagLook;
        const { rules: ownOrInherited } = look.read();
        const rules = ownOrInherited;
        const locks = look.normalizeLocks(JE.currentSettings.tagLayoutLocks);
        const defaults = JE.core.tagLayout.normalizeSettings();
        const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.jeFocusKey || null;
        const hadFocus = mount.contains(document.activeElement);

        const rerender = () => render(mount, state, touch);
        const saveRules = (next) => { touch(); look.saveRules(next).catch(() => {}); rerender(); };

        const root = el('section', 'je-tag-looks');
        root.setAttribute('aria-labelledby', 'jeTagLooksTitle');
        const title = el('div', 'je-tag-looks-title', JE.t('tag_looks_title'));
        title.id = 'jeTagLooksTitle';
        root.append(title, el('div', 'je-tag-looks-desc', JE.t('tag_looks_desc')));

        const list = el('ol', 'je-tag-looks-list');

        // Locked items: always win.
        const lockedRow = el('li', 'je-tag-looks-row');
        lockedRow.dataset.jeRow = 'locked';
        const lockedText = el('div', 'je-tag-looks-text');
        lockedText.append(el('strong', '', JE.t('tag_looks_locked_count', { count: String(locks.size) })),
            el('span', 'je-tag-looks-outcome', JE.t('tag_looks_locked_desc')));
        lockedRow.appendChild(lockedText);
        const lockedActions = el('div', 'je-tag-looks-actions');
        const toggle = button(JE.t(state.lockedOpen ? 'tag_looks_hide' : 'tag_looks_show'), () => {
            state.lockedOpen = !state.lockedOpen;
            touch();
            rerender();
        });
        toggle.dataset.jeFocusKey = 'locked-toggle';
        toggle.setAttribute('aria-expanded', state.lockedOpen ? 'true' : 'false');
        toggle.setAttribute('aria-controls', 'jeTagLooksLockedList');
        toggle.disabled = locks.size === 0;
        const unlockAll = button(JE.t('tag_looks_unlock_all'), () => {
            touch();
            if (unlockAll.dataset.confirm !== '1') {
                unlockAll.dataset.confirm = '1';
                unlockAll.textContent = JE.t('tag_looks_unlock_all_confirm');
                setTimeout(() => {
                    if (!unlockAll.isConnected) return;
                    delete unlockAll.dataset.confirm;
                    unlockAll.textContent = JE.t('tag_looks_unlock_all');
                }, CONFIRM_MS);
                return;
            }
            look.unlockItems().catch(() => {});
            JE.toast?.(JE.t('tag_looks_unlocked_all_toast'));
            state.lockedOpen = false;
            rerender();
        });
        unlockAll.dataset.jeFocusKey = 'unlock-all';
        unlockAll.disabled = locks.size === 0;
        lockedActions.append(toggle, unlockAll);
        lockedRow.appendChild(lockedActions);
        if (state.lockedOpen && locks.size) {
            const lockedList = el('ul', 'je-tag-looks-locked-list');
            lockedList.id = 'jeTagLooksLockedList';
            const ordered = Array.from(locks.entries()).sort((a, b) => b[1].lockedAt - a[1].lockedAt);
            const pending = [];
            for (const [id, lock] of ordered) {
                const info = state.titles.get(id);
                if (!info) pending.push(id);
                const row = el('li');
                const name = info ? (info.name || JE.t('tag_looks_unknown_item')) : JE.t('tag_looks_loading');
                const type = info?.type ? ` · ${typeName(info.type)}` : '';
                row.append(el('span', '', `${name}${type} — ${outcomeText(lock)}`));
                const unlock = button(JE.t('tag_looks_unlock'), () => {
                    look.unlockItems([id]).catch(() => {});
                    JE.toast?.(JE.t('tag_look_unlocked_toast'));
                    touch();
                    rerender();
                }, JE.t('tag_looks_unlock_named', { name: info?.name || id }));
                unlock.dataset.jeFocusKey = `unlock-${id}`;
                row.appendChild(unlock);
                lockedList.appendChild(row);
            }
            lockedRow.appendChild(lockedList);
            if (pending.length) loadTitles(state, pending).then(() => { if (mount.isConnected && state.editing === null) rerender(); });
        }
        list.appendChild(lockedRow);

        // Rules in order.
        rules.forEach((rule, index) => {
            const row = el('li', 'je-tag-looks-row');
            row.dataset.jeRow = 'rule';
            row.dataset.jeRuleId = rule.id;
            if (!rule.enabled) row.dataset.off = '1';
            const text = el('div', 'je-tag-looks-text');
            const condition = conditionText(rule.when, state);
            text.append(el('span', '', condition), el('span', 'je-tag-looks-outcome', `→ ${outcomeText(rule)}`));
            row.appendChild(text);
            const actions = el('div', 'je-tag-looks-actions');
            const move = (delta) => {
                const next = rules.slice();
                const [moved] = next.splice(index, 1);
                next.splice(index + delta, 0, moved);
                saveRules(next);
            };
            const up = button('▲', () => move(-1), JE.t('tag_looks_move_up', { rule: condition }));
            up.disabled = index === 0;
            up.dataset.jeFocusKey = `up-${rule.id}`;
            const down = button('▼', () => move(1), JE.t('tag_looks_move_down', { rule: condition }));
            down.disabled = index === rules.length - 1;
            down.dataset.jeFocusKey = `down-${rule.id}`;
            const pill = button(JE.t(rule.enabled ? 'tag_looks_on' : 'tag_looks_off'), () => {
                saveRules(rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
            }, JE.t('tag_looks_enabled_named', { rule: condition }));
            pill.className = 'je-tag-looks-pill';
            pill.setAttribute('aria-pressed', rule.enabled ? 'true' : 'false');
            pill.dataset.jeFocusKey = `pill-${rule.id}`;
            const edit = button(JE.t('tag_looks_edit'), () => { state.editing = rule.id; touch(); rerender(); }, JE.t('tag_looks_edit_named', { rule: condition }));
            edit.dataset.jeFocusKey = `edit-${rule.id}`;
            const del = button(JE.t('tag_looks_delete'), () => {
                if (state.editing === rule.id) state.editing = null;
                saveRules(rules.filter((r) => r.id !== rule.id));
            }, JE.t('tag_looks_delete_named', { rule: condition }));
            del.dataset.jeFocusKey = `delete-${rule.id}`;
            actions.append(up, down, pill, edit, del);
            row.appendChild(actions);
            list.appendChild(row);
        });

        // Otherwise: the default layout (read-only; the Layout select above changes it).
        const otherwise = el('li', 'je-tag-looks-row');
        otherwise.dataset.jeRow = 'otherwise';
        const otherText = el('div', 'je-tag-looks-text');
        otherText.append(el('span', '', JE.t('tag_looks_otherwise')), el('span', 'je-tag-looks-outcome', `→ ${outcomeText(defaults)}`));
        otherwise.appendChild(otherText);
        const change = button(JE.t('tag_looks_change_default'), () => {
            const layoutSelect = /** @type {HTMLElement|null} */ (document.getElementById('tagLayoutSelect'));
            layoutSelect?.scrollIntoView?.({ block: 'center' });
            layoutSelect?.focus();
            touch();
        });
        otherwise.appendChild(el('div', 'je-tag-looks-actions')).appendChild(change);
        list.appendChild(otherwise);
        root.appendChild(list);

        if (state.editing === null) {
            const add = button(JE.t('tag_looks_add_rule'), () => { state.editing = ''; touch(); rerender(); });
            add.className = 'je-tag-looks-add';
            add.dataset.jeFocusKey = 'add';
            add.disabled = rules.length >= look.MAX_RULES;
            root.appendChild(add);
        } else {
            root.appendChild(buildForm(state, rules, touch, rerender, saveRules));
        }

        mount.replaceChildren(root);
        // Keep keyboard focus on the control the user just used.
        if (!hadFocus || state.editing !== null) return;
        const again = Array.from(mount.querySelectorAll('[data-je-focus-key]'))
            .find((node) => /** @type {HTMLElement} */ (node).dataset.jeFocusKey === focusKey);
        const target = again && !(/** @type {HTMLButtonElement} */ (again).disabled) ? again
            : mount.querySelector('[data-je-focus-key="add"]');
        /** @type {HTMLElement|null} */ (target)?.focus();
    }

    /**
     * The add/edit rule form.
     * @param {LooksState} state
     * @param {Array<Object>} rules
     * @param {() => void} touch
     * @param {() => void} rerender
     * @param {(rules: Array<Object>) => void} saveRules
     * @returns {HTMLElement}
     */
    function buildForm(state, rules, touch, rerender, saveRules) {
        const look = JE.core.tagLook;
        const existing = rules.find((r) => r.id === state.editing) || null;
        const form = /** @type {HTMLFormElement} */ (el('form', 'je-tag-looks-form'));
        form.setAttribute('aria-label', JE.t(existing ? 'tag_looks_edit_rule' : 'tag_looks_add_rule'));
        form.noValidate = true;

        const conditions = el('fieldset');
        conditions.appendChild(el('legend', '', JE.t('tag_looks_conditions')));
        const condList = el('div');
        conditions.appendChild(condList);
        form.appendChild(conditions);

        let rowSeq = 0;
        /**
         * The value control for a field: a select of libraries, types or
         * genres, or a text box (age rating, or genres that failed to load).
         * @param {string} field
         * @param {string} value
         * @param {string} id
         * @returns {HTMLSelectElement|HTMLInputElement}
         */
        const valueControl = (field, value, id) => {
            /** @type {HTMLSelectElement|HTMLInputElement} */
            let control;
            if (field === 'library') {
                const options = Array.from(state.libraries || new Map()).map(([libId, name]) => /** @type {[string, string]} */ ([libId, name]));
                if (value && !options.some(([v]) => v === value)) options.push([value, JE.t('tag_looks_unknown_library')]);
                control = select([['', JE.t('tag_looks_choose')], ...options], value);
            } else if (field === 'type') {
                control = select([['', JE.t('tag_looks_choose')], ...look.TYPES.map((t) => /** @type {[string, string]} */ ([t, typeName(t)]))], value);
            } else if (field === 'genre' && state.genres && state.genres.length) {
                const options = state.genres.map((g) => /** @type {[string, string]} */ ([g, g]));
                const match = state.genres.find((g) => g.toLowerCase() === value.toLowerCase());
                if (value && !match) options.push([value, value]);
                control = select([['', JE.t('tag_looks_choose')], ...options], match || value);
            } else {
                const input = /** @type {HTMLInputElement} */ (el('input'));
                input.type = 'text';
                input.maxLength = 100;
                input.value = value;
                if (field === 'ageRating') {
                    const ratings = knownRatings();
                    if (ratings.length) {
                        const listId = `${id}-ratings`;
                        const datalist = el('datalist');
                        datalist.id = listId;
                        for (const r of ratings) { const o = /** @type {HTMLOptionElement} */ (el('option')); o.value = r; datalist.appendChild(o); }
                        input.setAttribute('list', listId);
                        queueMicrotask(() => input.after(datalist));
                    }
                }
                control = input;
            }
            control.id = id;
            control.dataset.jeCondValue = '1';
            return control;
        };

        /**
         * Add one condition row.
         * @param {{field: string, value: string}} cond
         */
        const addRow = (cond) => {
            const n = ++rowSeq;
            const row = el('div', 'je-tag-looks-cond');
            row.dataset.jeCond = '1';
            const fieldId = `jeTagLooksField${n}`;
            const valueId = `jeTagLooksValue${n}`;
            const fieldLabel = el('label', 'je-tag-looks-sr', JE.t('tag_looks_field'));
            fieldLabel.setAttribute('for', fieldId);
            const fieldSelect = select(look.FIELDS.map((f) => /** @type {[string, string]} */ ([f, JE.t(`tag_looks_field_${f.toLowerCase()}`)])), cond.field);
            fieldSelect.id = fieldId;
            fieldSelect.dataset.jeCondField = '1';
            const valueLabel = el('label', 'je-tag-looks-sr', JE.t('tag_looks_value'));
            valueLabel.setAttribute('for', valueId);
            let control = valueControl(cond.field, cond.value, valueId);
            fieldSelect.addEventListener('change', () => {
                touch();
                const next = valueControl(fieldSelect.value, '', valueId);
                control.replaceWith(next);
                control.nextElementSibling?.tagName === 'DATALIST' && control.nextElementSibling.remove();
                control = next;
            });
            const remove = button('✕', () => {
                touch();
                row.remove();
                syncRows();
                /** @type {HTMLElement|null} */ (condList.querySelector('[data-je-cond-field]'))?.focus();
            }, JE.t('tag_looks_remove_condition'));
            remove.dataset.jeCondRemove = '1';
            row.append(fieldLabel, fieldSelect, valueLabel, control, remove);
            condList.appendChild(row);
            syncRows();
        };

        const addCondition = button(JE.t('tag_looks_add_condition'), () => {
            touch();
            addRow({ field: 'type', value: '' });
            /** @type {HTMLElement|null} */ (condList.lastElementChild?.querySelector('[data-je-cond-field]'))?.focus();
        });
        conditions.appendChild(addCondition);

        /** Enable/disable "+ condition" and the remove buttons for the row count. */
        function syncRows() {
            const rows = condList.querySelectorAll('[data-je-cond]');
            addCondition.disabled = rows.length >= look.MAX_CONDITIONS;
            rows.forEach((r) => { /** @type {HTMLButtonElement} */ (r.querySelector('[data-je-cond-remove]')).disabled = rows.length <= 1; });
        }

        for (const cond of existing?.when?.length ? existing.when : [{ field: 'library', value: '' }]) addRow(cond);

        const outcome = el('fieldset');
        outcome.appendChild(el('legend', '', JE.t('tag_looks_use_look')));
        const outcomeRow = el('div', 'je-tag-looks-outcome-row');
        const layoutLabel = el('label', '', JE.t('panel_settings_ui_tag_layout'));
        const layoutSelect = select(LAYOUTS.map((l) => /** @type {[string, string]} */ ([l, layoutName(l)])), existing?.layout || 'caption');
        layoutSelect.dataset.jeRuleLayout = '1';
        layoutLabel.appendChild(layoutSelect);
        const densityLabel = el('label', '', JE.t('panel_settings_ui_tag_density'));
        const densitySelect = select([['full', densityName('full')], ['compact', densityName('compact')]], existing?.density || 'full');
        densitySelect.dataset.jeRuleDensity = '1';
        densityLabel.appendChild(densitySelect);
        outcomeRow.append(layoutLabel, densityLabel);
        outcome.appendChild(outcomeRow);
        form.appendChild(outcome);

        const error = el('div', 'je-tag-looks-error');
        error.setAttribute('role', 'alert');
        form.appendChild(error);

        const buttons = el('div', 'je-tag-looks-buttons');
        const cancel = button(JE.t('tag_looks_cancel'), () => { state.editing = null; touch(); rerender(); });
        const save = /** @type {HTMLButtonElement} */ (el('button', '', JE.t('tag_looks_save')));
        save.type = 'submit';
        buttons.append(cancel, save);
        form.appendChild(buttons);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            touch();
            const when = [];
            for (const row of condList.querySelectorAll('[data-je-cond]')) {
                const field = /** @type {HTMLSelectElement} */ (row.querySelector('[data-je-cond-field]')).value;
                const value = /** @type {HTMLInputElement} */ (row.querySelector('[data-je-cond-value]')).value.trim();
                if (!value) {
                    error.textContent = JE.t('tag_looks_error_value');
                    /** @type {HTMLElement} */ (row.querySelector('[data-je-cond-value]')).focus();
                    return;
                }
                when.push({ field, value });
            }
            const candidate = { id: existing?.id || look.newRuleId(new Set(rules.map((r) => r.id))), enabled: existing ? existing.enabled : true,
                when, layout: layoutSelect.value, density: densitySelect.value, colourPreset: existing?.colourPreset || null, slots: existing?.slots || null };
            if (look.normalizeRules([candidate]).length !== 1) {
                error.textContent = JE.t('tag_looks_error_value');
                return;
            }
            const next = existing ? rules.map((r) => (r.id === existing.id ? candidate : r)) : rules.concat([candidate]);
            state.editing = null;
            saveRules(next);
            JE.toast?.(JE.t('tag_looks_saved_toast'));
        });

        queueMicrotask(() => { /** @type {HTMLElement|null} */ (form.querySelector('[data-je-cond-field]'))?.focus(); });
        return form;
    }

    /**
     * Wire the section into the open settings panel (the template renders
     * an empty #jeTagLooksMount). Libraries and genres load in the
     * background; the list renders first and again once they arrive.
     * @param {{resetAutoCloseTimer?: () => void}} ctx Shared panel context.
     */
    internal.wireTagLooks = function (ctx) {
        const mount = document.getElementById('jeTagLooksMount');
        if (!mount || !JE.core?.tagLook || !JE.core?.tagLayout) return;
        JE.core.ui?.injectCss?.('je-tag-looks-panel', PANEL_CSS);
        /** @type {LooksState} */
        const state = { libraries: null, genres: null, titles: new Map(), lockedOpen: false, editing: null };
        const touch = () => { try { ctx?.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        render(mount, state, touch);
        Promise.all([loadLibraries(state), loadGenres(state)]).then(() => {
            if (!mount.isConnected) return;
            // Don't rebuild an open form under the user's hands (it would lose
            // their input); the next render picks the lists up.
            if (state.editing === null) render(mount, state, touch);
        });
        // The default layout row follows the Layout and Density selects.
        for (const id of ['tagLayoutSelect', 'tagLabelDensitySelect']) {
            document.getElementById(id)?.addEventListener('change', () => {
                if (state.editing === null && mount.isConnected) queueMicrotask(() => render(mount, state, touch));
            });
        }
    };

    // Exposed for tests.
    internal.tagLooksPanel = { render, conditionText, loadTitles };
})(window.JellyfinEnhanced);
