/**
 * @file Media Tags admin page, Rules tab: the default tag look rules new
 * users start with (TagLookRules). A list (switch, reorder, delete with
 * undo), a form to add a one-condition rule, and the rules as JSON for
 * anything the form does not cover (several conditions, per-rule positions).
 * Fields a rule has that the list does not edit are kept as they are.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const FIELDS = ['library', 'type', 'genre', 'ageRating'];
    const TYPES = ['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video'];
    const MAX_RULES = 50;

    /** @type {Object<string, string>} library id (no dashes, lower case) → name */
    let libraries = {};

    /**
     * Read a key in either case.
     * @param {*} obj
     * @param {string} key - camelCase.
     * @returns {*}
     */
    const get = (obj, key) => (obj && typeof obj === 'object' ? (obj[key] !== undefined ? obj[key] : obj[key.charAt(0).toUpperCase() + key.slice(1)]) : undefined);

    /**
     * Validate rules typed as JSON (the main configuration page's checks, unchanged)
     * into the stored form. A rule's per-shape looks are kept.
     * @param {string} text
     * @returns {{rules: Object[], error: string|null}}
     */
    function parseRules(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return { rules: [], error: null };
        let raw;
        try { raw = JSON.parse(trimmed); } catch (e) { return { rules: [], error: JE.t('admin_tags_rules_json_invalid', { message: e.message }) }; }
        if (!Array.isArray(raw)) return { rules: [], error: JE.t('admin_tags_rules_json_array') };
        if (raw.length > MAX_RULES) return { rules: [], error: JE.t('admin_tags_rules_json_too_many', { n: MAX_RULES }) };
        const rules = [];
        for (let i = 0; i < raw.length; i++) {
            const rule = raw[i];
            const n = i + 1;
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { rules: [], error: JE.t('admin_tags_rules_json_not_object', { n }) };
            const layout = String(get(rule, 'layout') || '').toLowerCase();
            if (!LAYOUTS.includes(layout)) return { rules: [], error: JE.t('admin_tags_rules_json_layout', { n, layout }) };
            const density = String(get(rule, 'density') || 'full').toLowerCase();
            if (density !== 'full' && density !== 'compact') return { rules: [], error: JE.t('admin_tags_rules_json_density', { n }) };
            const when = get(rule, 'when');
            if (!Array.isArray(when) || when.length < 1 || when.length > 5) return { rules: [], error: JE.t('admin_tags_rules_json_when', { n }) };
            const conditions = [];
            for (let j = 0; j < when.length; j++) {
                const field = String(get(when[j], 'field') || '');
                const value = String(get(when[j], 'value') || '').trim();
                if (!FIELDS.map((f) => f.toLowerCase()).includes(field.toLowerCase()) || !value) return { rules: [], error: JE.t('admin_tags_rules_json_condition', { n, m: j + 1 }) };
                if (field.toLowerCase() === 'library' && !/^[0-9a-fA-F]{32}$/.test(value.replace(/-/g, ''))) return { rules: [], error: JE.t('admin_tags_rules_json_library', { n }) };
                conditions.push({ Field: field, Value: value });
            }
            const slots = get(rule, 'slots');
            const shapes = get(rule, 'shapes');
            rules.push({
                Id: String(get(rule, 'id') || ''),
                Enabled: get(rule, 'enabled') !== false,
                When: conditions,
                Layout: layout,
                Density: density,
                ColourPreset: null,
                Slots: Array.isArray(slots) ? slots.map((s) => ({ Group: String(get(s, 'group') || ''), Slot: String(get(s, 'slot') || '') })) : null,
                Shapes: shapes && typeof shapes === 'object' ? shapes : null,
            });
        }
        return { rules, error: null };
    }

    /** @param {Object} c @returns {Object[]} The stored rules (a copy). */
    const rulesOf = (c) => (Array.isArray(c.TagLookRules) ? c.TagLookRules.map((r) => ({ ...r })) : []);

    /**
     * One condition as words: "Type is Episode", "Library is Anime".
     * @param {Object} cond
     * @returns {string}
     */
    function conditionText(cond) {
        const field = String(get(cond, 'field') || '');
        const value = String(get(cond, 'value') || '');
        const key = field.toLowerCase();
        let shown = value;
        if (key === 'library') shown = libraries[value.replace(/-/g, '').toLowerCase()] || value;
        else if (key === 'type') shown = JE.t(`tag_looks_type_${value.toLowerCase()}`);
        return JE.t('admin_tags_rules_condition', { field: JE.t(`tag_looks_field_${key}`), value: shown });
    }

    /**
     * A rule's list row.
     * @param {Object} ctx
     * @param {Object} rule
     * @param {number} i
     * @param {number} count
     * @returns {string}
     */
    function ruleHtml(ctx, rule, i, count) {
        const enabled = get(rule, 'enabled') !== false;
        const when = (get(rule, 'when') || []).map(conditionText).join(JE.t('admin_tags_rules_and'));
        const look = JE.t('tag_looks_outcome', { layout: JE.t(`tag_looks_layout_${String(get(rule, 'layout') || 'corners').toLowerCase()}`), density: JE.t(`panel_settings_ui_tag_density_${String(get(rule, 'density') || 'full').toLowerCase() === 'compact' ? 'compact' : 'full'}`) });
        const extra = (Array.isArray(get(rule, 'slots')) && get(rule, 'slots').length) || get(rule, 'shapes') ? ` <span class="je-ta-hint">${ctx.tx('admin_tags_rules_has_more')}</span>` : '';
        const name = JE.t('admin_tags_rules_rule_n', { n: i + 1 });
        return `<li class="je-ta-rule" data-index="${i}" data-enabled="${enabled}">
            <span class="je-ta-rule-n">${i + 1}</span>
            <input type="checkbox" data-act="enable" ${enabled ? 'checked' : ''} aria-label="${ctx.esc(JE.t('admin_tags_rules_enable', { name }))}">
            <span class="je-ta-rule-text">${ctx.esc(when)} → <strong>${ctx.esc(look)}</strong>${extra}</span>
            <span class="je-ta-rule-tools">
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="-1" aria-label="${ctx.esc(JE.t('admin_tags_move_up', { name }))}" ${i === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="1" aria-label="${ctx.esc(JE.t('admin_tags_move_down', { name }))}" ${i === count - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="delete" aria-label="${ctx.esc(JE.t('admin_tags_rules_delete', { name }))}"><span class="material-icons" aria-hidden="true">delete</span></button>
            </span>
        </li>`;
    }

    /**
     * The value control for the add form's field.
     * @param {Object} ctx
     * @param {string} field
     * @returns {string}
     */
    function valueControl(ctx, field) {
        if (field === 'type') return `<select data-rule="value">${TYPES.map((t) => `<option value="${t}">${ctx.tx(`tag_looks_type_${t.toLowerCase()}`)}</option>`).join('')}</select>`;
        if (field === 'library') {
            const entries = Object.entries(libraries);
            return entries.length ? `<select data-rule="value">${entries.map(([id, name]) => `<option value="${ctx.esc(id)}">${ctx.esc(name)}</option>`).join('')}</select>`
                : `<input type="text" data-rule="value" placeholder="${ctx.tx('admin_tags_rules_library_id')}">`;
        }
        return `<input type="text" data-rule="value" placeholder="${ctx.tx(field === 'genre' ? 'admin_tags_rules_genre_placeholder' : 'admin_tags_rules_age_placeholder')}">`;
    }

    A.registerSection({
        id: 'rules',
        tab: 'rules',
        order: 10,
        title: 'admin_tags_rules_title',
        hint: 'admin_tags_rules_desc',
        fields: [
            { id: 'tagLookRulesJson', key: 'TagLookRules', type: 'custom', label: 'admin_tags_rules_json' },
        ],
        render(ctx, body) {
            body.innerHTML = `
                <p class="je-ta-off" data-rules-empty>${ctx.tx('admin_tags_rules_none')}</p>
                <ol class="je-ta-rules" data-rules></ol>
                <h4 class="je-ta-sub" id="jeTaRuleAddTitle">${ctx.tx('admin_tags_rules_add_title')}</h4>
                <div class="je-ta-rule-form" role="group" aria-labelledby="jeTaRuleAddTitle">
                    <label>${ctx.tx('admin_tags_rules_when')}<select data-rule="field">${FIELDS.map((f) => `<option value="${f}">${ctx.tx(`tag_looks_field_${f.toLowerCase()}`)}</option>`).join('')}</select></label>
                    <label>${ctx.tx('admin_tags_rules_is')}<span data-rule-value>${valueControl(ctx, 'library')}</span></label>
                    <label>${ctx.tx('admin_tags_rules_layout')}<select data-rule="layout">${LAYOUTS.map((l) => `<option value="${l}">${ctx.tx(`tag_looks_layout_${l}`)}</option>`).join('')}</select></label>
                    <label>${ctx.tx('panel_settings_ui_tag_density')}<select data-rule="density"><option value="full">${ctx.tx('panel_settings_ui_tag_density_full')}</option><option value="compact">${ctx.tx('panel_settings_ui_tag_density_compact')}</option></select></label>
                    <button type="button" class="je-ta-button je-ta-button--primary" data-rule="add"><span class="material-icons" aria-hidden="true">add</span>${ctx.tx('admin_tags_rules_add')}</button>
                </div>
                <details class="je-ta-json" style="margin-top:14px">
                    <summary class="je-ta-link">${ctx.tx('admin_tags_rules_json')}</summary>
                    <p class="je-ta-hint">${ctx.tx('admin_tags_rules_json_desc')}</p>
                    <textarea id="tagLookRulesJson" rows="10" spellcheck="false" aria-describedby="tagLookRulesJsonStatus"></textarea>
                    <p class="je-ta-json-status" id="tagLookRulesJsonStatus" role="status"></p>
                    <div class="je-ta-actions"><button type="button" class="je-ta-button" data-rule="json-save">${ctx.tx('admin_tags_rules_json_save')}</button><button type="button" class="je-ta-button" data-rule="json-revert">${ctx.tx('admin_tags_rules_json_revert')}</button></div>
                </details>`;
            const form = /** @type {HTMLElement} */ (body.querySelector('.je-ta-rule-form'));
            const fieldSelect = /** @type {HTMLSelectElement} */ (form.querySelector('[data-rule="field"]'));
            fieldSelect.addEventListener('change', () => { /** @type {HTMLElement} */ (form.querySelector('[data-rule-value]')).innerHTML = valueControl(ctx, fieldSelect.value); });
            form.querySelector('[data-rule="add"]')?.addEventListener('click', () => {
                const valueEl = /** @type {HTMLInputElement} */ (form.querySelector('[data-rule="value"]'));
                const value = String(valueEl.value || '').trim();
                const field = fieldSelect.value;
                if (!value || (field === 'library' && !/^[0-9a-fA-F]{32}$/.test(value.replace(/-/g, '')))) {
                    ctx.snack(JE.t(field === 'library' ? 'admin_tags_rules_need_library' : 'admin_tags_rules_need_value'));
                    valueEl.focus();
                    return;
                }
                const rules = rulesOf(ctx.config);
                if (rules.length >= MAX_RULES) { ctx.snack(JE.t('admin_tags_rules_json_too_many', { n: MAX_RULES })); return; }
                rules.push({ Id: '', Enabled: true, When: [{ Field: field, Value: value }], Layout: /** @type {HTMLSelectElement} */ (form.querySelector('[data-rule="layout"]')).value, Density: /** @type {HTMLSelectElement} */ (form.querySelector('[data-rule="density"]')).value, ColourPreset: null, Slots: null });
                ctx.set('TagLookRules', rules);
                if (valueEl.tagName === 'INPUT') valueEl.value = '';
                ctx.announce(JE.t('admin_tags_rules_added', { n: rules.length }));
            });
            body.querySelector('[data-rules]')?.addEventListener('click', (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
                const row = /** @type {HTMLElement|null} */ (button?.closest('.je-ta-rule') || null);
                if (!button || !row || button.disabled) return;
                const i = Number(row.dataset.index);
                const rules = rulesOf(ctx.config);
                if (button.dataset.act === 'move') {
                    const to = i + Number(button.dataset.dir);
                    if (to < 0 || to >= rules.length) return;
                    rules.splice(to, 0, rules.splice(i, 1)[0]);
                    ctx.set('TagLookRules', rules);
                    const again = /** @type {HTMLButtonElement|null} */ (body.querySelector(`.je-ta-rule[data-index="${to}"] [data-act="move"][data-dir="${button.dataset.dir}"]`));
                    (again && !again.disabled ? again : body.querySelector(`.je-ta-rule[data-index="${to}"] [data-act="enable"]`))?.focus();
                } else if (button.dataset.act === 'delete') {
                    const before = rulesOf(ctx.config);
                    rules.splice(i, 1);
                    ctx.set('TagLookRules', rules.length ? rules : null);
                    ctx.snack(JE.t('admin_tags_rules_deleted', { n: i + 1 }), () => ctx.set('TagLookRules', before));
                    /** @type {HTMLElement|null} */ (body.querySelector(`.je-ta-rule[data-index="${Math.min(i, rules.length - 1)}"] [data-act="delete"]`) || body.querySelector('[data-rule="field"]'))?.focus();
                }
            });
            body.querySelector('[data-rules]')?.addEventListener('change', (e) => {
                const input = /** @type {HTMLInputElement} */ (e.target);
                const row = /** @type {HTMLElement|null} */ (input.closest('.je-ta-rule'));
                if (!row || input.dataset.act !== 'enable') return;
                const rules = rulesOf(ctx.config);
                const i = Number(row.dataset.index);
                rules[i] = { ...rules[i], Enabled: input.checked };
                delete rules[i].enabled;
                ctx.set('TagLookRules', rules);
                /** @type {HTMLElement|null} */ (body.querySelector(`.je-ta-rule[data-index="${i}"] [data-act="enable"]`))?.focus();
            });
            const box = /** @type {HTMLTextAreaElement} */ (body.querySelector('#tagLookRulesJson'));
            const status = /** @type {HTMLElement} */ (body.querySelector('#tagLookRulesJsonStatus'));
            const check = () => {
                const parsed = parseRules(box.value);
                status.textContent = parsed.error ? parsed.error : (parsed.rules.length ? JE.t('admin_tags_rules_json_ok', { n: parsed.rules.length }) : JE.t('admin_tags_rules_none'));
                status.dataset.error = String(!!parsed.error);
                return parsed;
            };
            box.addEventListener('input', check);
            body.querySelector('[data-rule="json-save"]')?.addEventListener('click', () => {
                const parsed = check();
                if (parsed.error) { box.focus(); return; }
                ctx.set('TagLookRules', parsed.rules.length ? parsed.rules : null);
                ctx.announce(JE.t('admin_tags_rules_json_saved'));
            });
            body.querySelector('[data-rule="json-revert"]')?.addEventListener('click', () => { this.load(ctx, body); });
            ApiClient.getJSON(ApiClient.getUrl('Library/VirtualFolders')).then((folders) => {
                libraries = {};
                for (const f of folders || []) if (f.ItemId) libraries[String(f.ItemId).replace(/-/g, '').toLowerCase()] = f.Name;
                if (fieldSelect.value === 'library') /** @type {HTMLElement} */ (form.querySelector('[data-rule-value]')).innerHTML = valueControl(ctx, 'library');
                ctx.refresh({ controls: false });
            }).catch((err) => console.warn('🪼 Jellyfin Enhanced: could not load the library list', err));
            this.load(ctx, body);
        },
        /** Put the stored rules into the JSON box (first draw, Revert, page shown again). */
        load(ctx, body) {
            const box = /** @type {HTMLTextAreaElement|null} */ (body?.querySelector('#tagLookRulesJson'));
            if (!box) return;
            const rules = rulesOf(ctx.config);
            box.value = rules.length ? JSON.stringify(rules, null, 2) : '';
            box.dispatchEvent(new Event('input'));
        },
        refresh(ctx, body) {
            const list = body?.querySelector('[data-rules]');
            if (!list) return;
            const rules = rulesOf(ctx.config);
            list.innerHTML = rules.map((r, i) => ruleHtml(ctx, r, i, rules.length)).join('');
            /** @type {HTMLElement} */ (body.querySelector('[data-rules-empty]')).hidden = rules.length > 0;
            const box = /** @type {HTMLTextAreaElement|null} */ (body.querySelector('#tagLookRulesJson'));
            if (box && document.activeElement !== box && !box.closest('details[open]')) this.load(ctx, body);
        },
    });

    A.registerSection({
        id: 'rules-locks',
        tab: 'rules',
        order: 20,
        title: 'admin_tags_locks_title',
        hint: 'admin_tags_locks_desc',
    });

    // Exposed for tests.
    A.rulesData = { parseRules, conditionText };
})(window.JellyfinEnhanced);
