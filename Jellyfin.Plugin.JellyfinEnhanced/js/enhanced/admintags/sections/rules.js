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
        else if (key === 'type') shown = JE.t(JE.core.tagLayout.VOCABULARY_KEYS.type[value.toLowerCase()]);
        return JE.t('admin_tags_rules_condition', { field: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.field[`${key}`]), value: shown });
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
        const when = (get(rule, 'when') || []).map(conditionText).join(JE.t('tag_looks_and'));
        const look = JE.t('tag_looks_outcome', { layout: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.layout[String(get(rule, 'layout') || 'corners').toLowerCase()]), density: JE.t(`panel_settings_ui_tag_density_${String(get(rule, 'density') || 'full').toLowerCase() === 'compact' ? 'compact' : 'full'}`) });
        const extra = (Array.isArray(get(rule, 'slots')) && get(rule, 'slots').length) || get(rule, 'shapes') ? ` <span class="je-ta-hint">${ctx.tx('admin_tags_rules_has_more')}</span>` : '';
        const name = JE.t('panel_media_tags_preview_source_rule', { n: i + 1 });
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
        if (field === 'type') return `<select data-rule="value">${TYPES.map((t) => `<option value="${t}">${ctx.tx(JE.core.tagLayout.VOCABULARY_KEYS.type[t.toLowerCase()])}</option>`).join('')}</select>`;
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
                <h4 class="je-ta-sub" id="jeTaRuleAddTitle">${ctx.tx('tag_looks_add_a_rule')}</h4>
                <div class="je-ta-rule-form" role="group" aria-labelledby="jeTaRuleAddTitle">
                    <label>${ctx.tx('admin_tags_rules_when')}<select data-rule="field">${FIELDS.map((f) => `<option value="${f}">${ctx.tx(JE.core.tagLayout.VOCABULARY_KEYS.field[`${f.toLowerCase()}`])}</option>`).join('')}</select></label>
                    <label>${ctx.tx('tag_looks_is')}<span data-rule-value>${valueControl(ctx, 'library')}</span></label>
                    <label>${ctx.tx('common_layout')}<select data-rule="layout">${LAYOUTS.map((l) => `<option value="${l}">${ctx.tx(JE.core.tagLayout.VOCABULARY_KEYS.layout[l])}</option>`).join('')}</select></label>
                    <label>${ctx.tx('panel_settings_ui_tag_density')}<select data-rule="density"><option value="full">${ctx.tx('panel_settings_ui_tag_density_full')}</option><option value="compact">${ctx.tx('panel_settings_ui_tag_density_compact')}</option></select></label>
                    <button type="button" class="je-ta-button je-ta-button--primary" data-rule="add"><span class="material-icons" aria-hidden="true">add</span>${ctx.tx('tag_looks_add_rule')}</button>
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
                if (!ctx.isCurrent()) return;
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
        title: 'tag_looks_locked_heading',
        hint: 'admin_tags_locks_desc',
    });

    /**
     * Each view's item titles: id → title once loaded, and the ids being loaded
     * (a refresh meanwhile asks for no more). Kept per view, so a view that
     * replaces one torn down mid-load (or a new session) asks for its own.
     * @type {WeakMap<Object, {titles: Map<string, {name: string, type: string}>, loading: Set<string>}>}
     */
    const titleState = new WeakMap();
    /** @param {Object} ctx @returns {{titles: Map<string, {name: string, type: string}>, loading: Set<string>}} */
    function titlesOf(ctx) {
        let state = titleState.get(ctx);
        if (!state) titleState.set(ctx, state = { titles: new Map(), loading: new Set() });
        return state;
    }

    /**
     * Load the titles of server-wide item looks not known yet (50 per request).
     * A view torn down meanwhile stops before its next request.
     * @param {Object} ctx
     * @param {string[]} ids
     * @returns {Promise<boolean>} Whether a title was added.
     */
    async function loadItemTitles(ctx, ids) {
        const { titles, loading } = titlesOf(ctx);
        const missing = ids.filter((id) => !titles.has(id) && !loading.has(id));
        for (const id of missing) loading.add(id);
        try {
            for (let i = 0; i < missing.length; i += 50) {
                const batch = missing.slice(i, i + 50);
                try {
                    const resp = await ApiClient.getJSON(ApiClient.getUrl(`Users/${ApiClient.getCurrentUserId()}/Items`, { Ids: batch.join(','), EnableImages: false, EnableUserData: false }));
                    if (!ctx.isCurrent()) return false;
                    for (const item of resp?.Items || []) titles.set(String(item.Id).replace(/-/g, '').toLowerCase(), { name: String(item.Name || ''), type: String(item.Type || '') });
                } catch (err) {
                    if (!ctx.isCurrent()) return false;
                    console.warn('🪼 Jellyfin Enhanced: could not load the item titles', err);
                }
                for (const id of batch) if (!titles.has(id)) titles.set(id, { name: '', type: '' });
            }
        } finally {
            for (const id of missing) loading.delete(id);
        }
        return missing.length > 0;
    }

    /**
     * One server-wide item look's list row.
     * @param {Object} ctx
     * @param {string} id
     * @param {Object} look - Normalised (core/tag-look.js).
     * @returns {string}
     */
    function itemLookHtml(ctx, id, look) {
        const info = titlesOf(ctx).titles.get(id);
        const name = info ? (info.name || JE.t('tag_looks_unknown_item')) : JE.t('hidden_content_admin_loading');
        const type = info?.type ? `${JE.t(JE.core.tagLayout.VOCABULARY_KEYS.type[info.type.toLowerCase()])} · ` : '';
        const outcome = JE.t('tag_looks_outcome', { layout: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.layout[look.layout]), density: JE.t(`panel_settings_ui_tag_density_${look.density}`) });
        const scope = info?.type === 'Series' ? ` · ${JE.t(look.scope === 'item' ? 'tag_item_editor_scope_series_only' : 'tag_item_editor_scope_series')}` : '';
        const label = info?.name || id;
        return `<li class="je-ta-rule" data-item="${ctx.esc(id)}" data-je-focus-key="admin-item-look-row-${ctx.esc(id)}">
            <span class="je-ta-rule-text"><strong>${ctx.esc(name)}</strong> ${ctx.esc(type)}${ctx.esc(outcome)}${ctx.esc(scope)}</span>
            <span class="je-ta-rule-tools">
                <button type="button" class="je-ta-button" data-act="edit" data-je-focus-key="admin-item-look-edit-${ctx.esc(id)}" aria-label="${ctx.esc(JE.t('admin_tags_item_looks_edit_named', { name: label }))}">${ctx.tx('reviews_edit')}</button>
                <button type="button" class="je-ta-icon-btn" data-act="remove" aria-label="${ctx.esc(JE.t('admin_tags_item_looks_remove_named', { name: label }))}"><span class="material-icons" aria-hidden="true">delete</span></button>
            </span>
        </li>`;
    }

    A.registerSection({
        id: 'item-looks',
        tab: 'rules',
        order: 30,
        title: 'admin_tags_item_looks_title',
        hint: 'admin_tags_item_looks_desc',
        writes: ['TagLookItemOverrides'],
        render(ctx, body) {
            const heading = body.closest('[data-section]')?.querySelector('h3');
            if (heading) heading.tabIndex = -1;
            body.innerHTML = `<p class="je-ta-off" data-item-looks-empty>${ctx.tx('admin_tags_item_looks_none')}</p><ol class="je-ta-rules" data-item-looks></ol>`;
            body.querySelector('[data-item-looks]')?.addEventListener('click', (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
                const row = /** @type {HTMLElement|null} */ (button?.closest('[data-item]') || null);
                const look = JE.core.tagLook;
                if (!button || !row || !look) return;
                const id = row.dataset.item || '';
                const stored = ctx.config.TagLookItemOverrides ?? null;
                const name = titlesOf(ctx).titles.get(id)?.name || id;
                if (button.dataset.act === 'remove') {
                    const next = look.itemOverridesWith(stored, id, null);
                    if (next === undefined) return;
                    ctx.set('TagLookItemOverrides', next);
                    const removed = look.itemOverridesToWire(new Map([[id, look.normalizeItemOverrides(stored).get(id)]]));
                    ctx.snack(JE.t('tag_item_editor_everyone_removed', { name }), () => {
                        if (ctx.isCurrent()) ctx.set('TagLookItemOverrides', look.restoreItemOverrides(ctx.config.TagLookItemOverrides, removed));
                    });
                    /** @type {HTMLElement|null} */ (body.querySelector('[data-item] [data-act="remove"]') || body.querySelector('[data-item-looks-empty]'))?.focus?.();
                } else if (button.dataset.act === 'edit') {
                    let focusTarget = id;
                    JE.tagItemEditor?.open(id, {
                        mode: 'server',
                        opener: button,
                        returnFocus: () => body.querySelector(`[data-item="${focusTarget}"] [data-act="edit"]`) || heading,
                        look: look.normalizeItemOverrides(stored).get(id) || null,
                        onSave: (chosen, target) => {
                            let next = look.itemOverridesWith(ctx.config.TagLookItemOverrides ?? null, id, target === id ? chosen : null);
                            if (next !== undefined && target !== id) next = look.itemOverridesWith(next, target, chosen);
                            if (next === undefined) return;
                            focusTarget = target;
                            ctx.set('TagLookItemOverrides', next);
                            ctx.announce(JE.t('tag_item_editor_everyone_saved', { name }));
                        },
                    });
                }
            });
        },
        refresh(ctx, body) {
            const list = body?.querySelector('[data-item-looks]');
            const look = JE.core.tagLook;
            if (!list || !look) return;
            const looks = look.normalizeItemOverrides(ctx.config.TagLookItemOverrides ?? null);
            const focusKey = list.contains(document.activeElement) ? document.activeElement?.dataset?.jeFocusKey : null;
            list.innerHTML = Array.from(looks.entries()).map(([id, entry]) => itemLookHtml(ctx, id, entry)).join('');
            if (focusKey) Array.from(list.querySelectorAll('[data-je-focus-key]')).find((el) => el.dataset.jeFocusKey === focusKey)?.focus({ preventScroll: true });
            /** @type {HTMLElement} */ (body.querySelector('[data-item-looks-empty]')).hidden = looks.size > 0;
            loadItemTitles(ctx, Array.from(looks.keys())).then((added) => { if (added && ctx.isCurrent()) this.refresh(ctx, body); });
        },
    });

    // Exposed for tests.
    A.rulesData = { parseRules, conditionText };
})(window.JellyfinEnhanced);
