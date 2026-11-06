/**
 * @file Media Tags admin tab, Rules tab: the default tag look rules new
 * users start with (TagLookRules). A list (switch, Edit, reorder, delete
 * with undo), the same add/edit form as each user's own Rules & locks (one
 * to five conditions on library, type, genre or age rating, then the look),
 * and the rules as JSON for what the form does not set (per-rule positions
 * and episode or list-row looks). Editing a rule keeps its id, On/Off state
 * and the fields the form does not edit; a JSON draft being typed is never
 * replaced by a save or another administrator's change.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const FIELDS = ['library', 'type', 'genre', 'ageRating'];
    const TYPES = ['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video'];
    const MAX_RULES = 50;

    /**
     * Each page view's library names, library id (no dashes, lower case) →
     * name: empty until that view's own request answers (never an earlier
     * view's or another server's list).
     * @type {WeakMap<Object, Object<string, string>>}
     */
    const libraryNames = new WeakMap();

    /** @param {Object} ctx @returns {Object<string, string>} */
    const librariesOf = (ctx) => libraryNames.get(ctx) || {};

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
        try { raw = JSON.parse(trimmed); } catch (e) { return { rules: [], error: A.fmt('Not valid JSON: {message}', { message: e.message }) }; }
        if (!Array.isArray(raw)) return { rules: [], error: A.fmt('Expected a JSON array of rules.') };
        if (raw.length > MAX_RULES) return { rules: [], error: A.fmt('At most {n} rules.', { n: MAX_RULES }) };
        const rules = [];
        for (let i = 0; i < raw.length; i++) {
            const rule = raw[i];
            const n = i + 1;
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { rules: [], error: A.fmt('Rule {n}: not an object.', { n }) };
            const layout = String(get(rule, 'layout') || '').toLowerCase();
            if (!LAYOUTS.includes(layout)) return { rules: [], error: A.fmt('Rule {n}: unknown layout "{layout}".', { n, layout }) };
            const density = String(get(rule, 'density') || 'full').toLowerCase();
            if (density !== 'full' && density !== 'compact') return { rules: [], error: A.fmt('Rule {n}: density must be full or compact.', { n }) };
            const when = get(rule, 'when');
            if (!Array.isArray(when) || when.length < 1 || when.length > 5) return { rules: [], error: A.fmt('Rule {n}: "when" needs 1 to 5 conditions.', { n }) };
            const conditions = [];
            for (let j = 0; j < when.length; j++) {
                const field = String(get(when[j], 'field') || '');
                const value = String(get(when[j], 'value') || '').trim();
                if (!FIELDS.map((f) => f.toLowerCase()).includes(field.toLowerCase()) || !value) return { rules: [], error: A.fmt('Rule {n}: condition {m} needs a known field and a value.', { n, m: j + 1 }) };
                if (field.toLowerCase() === 'library' && !/^[0-9a-fA-F]{32}$/.test(value.replace(/-/g, ''))) return { rules: [], error: A.fmt('Rule {n}: a library condition needs a library id.', { n }) };
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
     * @param {Object<string, string>} [libraries] - The view's library names.
     * @returns {string}
     */
    function conditionText(cond, libraries = {}) {
        const field = String(get(cond, 'field') || '');
        const value = String(get(cond, 'value') || '');
        const key = field.toLowerCase();
        let shown = value;
        if (key === 'library') shown = libraries[value.replace(/-/g, '').toLowerCase()] || value;
        else if (key === 'type') shown = A.fmt(A.WORDS.type[value.toLowerCase()]);
        return A.fmt('{field} is {value}', { field: A.fmt(A.WORDS.field[`${key}`]), value: shown });
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
        const when = (get(rule, 'when') || []).map((cond) => conditionText(cond, librariesOf(ctx))).join(A.fmt(' and '));
        const look = A.fmt('{layout} · {density}', { layout: A.fmt(A.WORDS.layout[String(get(rule, 'layout') || 'corners').toLowerCase()]), density: A.WORDS.density[String(get(rule, 'density') || 'full').toLowerCase() === 'compact' ? 'compact' : 'full'] });
        const extra = hasExtras(rule) ? ` <span class="je-ta-hint">${ctx.tx('(also sets positions; edit as JSON)')}</span>` : '';
        const name = A.fmt('Rule {n}', { n: i + 1 });
        const editing = editsOf(ctx).index === i;
        return `<li class="je-ta-rule" data-index="${i}" data-enabled="${enabled}"${editing ? ' data-editing="true"' : ''}>
            <span class="je-ta-rule-n">${i + 1}</span>
            <input type="checkbox" data-act="enable" ${enabled ? 'checked' : ''} aria-label="${ctx.esc(A.fmt('{name} enabled', { name }))}">
            <span class="je-ta-rule-text">${ctx.esc(when)} → <strong>${ctx.esc(look)}</strong>${extra}</span>
            <span class="je-ta-rule-tools">
                <button type="button" class="je-ta-button" data-act="edit" aria-label="${ctx.esc(A.fmt('Edit rule: {rule}', { rule: name }))}"${editing ? ' aria-current="true"' : ''}>${ctx.tx('Edit')}</button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="-1" aria-label="${ctx.esc(A.fmt('Move {name} up', { name }))}" ${i === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="1" aria-label="${ctx.esc(A.fmt('Move {name} down', { name }))}" ${i === count - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="delete" aria-label="${ctx.esc(A.fmt('Delete {name}', { name }))}"><span class="material-icons" aria-hidden="true">delete</span></button>
            </span>
        </li>`;
    }

    /** @param {Object} rule @returns {boolean} The rule also sets positions or episode/list-row looks (the form keeps them). */
    const hasExtras = (rule) => !!((Array.isArray(get(rule, 'slots')) && get(rule, 'slots').length) || get(rule, 'shapes'));

    /**
     * Each view's genre and age rating suggestions (Items/Filters): null until
     * that view's own request answers; empty lists when it failed.
     * @type {WeakMap<Object, {genres: string[], ratings: string[]}>}
     */
    const suggestions = new WeakMap();

    /**
     * Each view's form state: the rule being edited (its index when Edit was
     * pressed and its id), else none.
     * @type {WeakMap<Object, {index: number, id: string}>}
     */
    const edits = new WeakMap();
    /** @param {Object} ctx @returns {{index: number, id: string}} */
    const editsOf = (ctx) => edits.get(ctx) || { index: -1, id: '' };

    /**
     * The JSON box's draft: the text last loaded from the saved rules, and
     * whether the administrator has changed it since. A dirty draft is never
     * replaced by a save, a server normalisation or another administrator's
     * change; it says when the saved rules moved on beneath it.
     * @type {WeakMap<Element, {loaded: string, dirty: boolean, check: (() => void)|null}>}
     */
    const drafts = new WeakMap();
    /** @param {Element} body @returns {{loaded: string, dirty: boolean, check: (() => void)|null}} */
    function draftOf(body) {
        let state = drafts.get(body);
        if (!state) drafts.set(body, state = { loaded: '', dirty: false, check: null });
        return state;
    }

    /**
     * The value control for a condition's field: a select of the server's
     * libraries, the item types or the library's genres, or a text box (age
     * rating, with the library's ratings suggested; a genre or library while
     * its list has not loaded).
     * @param {Object} ctx
     * @param {string} field
     * @param {string} value
     * @param {string} id - The control's id.
     * @param {boolean} [first] - The first condition (its control keeps `data-rule="value"`).
     * @returns {string}
     */
    function valueControl(ctx, field, value, id, first) {
        const attrs = `id="${id}" data-cond-value="1"${first ? ' data-rule="value"' : ''} aria-required="true"`;
        const choose = `<option value="">${ctx.tx('Choose…')}</option>`;
        const option = (v, label) => `<option value="${ctx.esc(v)}"${v === value ? ' selected' : ''}>${ctx.esc(label)}</option>`;
        if (field === 'type') return `<select ${attrs}>${choose}${TYPES.map((t) => option(t, A.fmt(A.WORDS.type[t.toLowerCase()]))).join('')}</select>`;
        if (field === 'library') {
            const entries = Object.entries(librariesOf(ctx));
            if (!entries.length) return `<input type="text" ${attrs} value="${ctx.esc(value)}" placeholder="${ctx.tx('Library id')}">`;
            const chosen = value.replace(/-/g, '').toLowerCase();
            if (chosen && !entries.some(([libId]) => libId === chosen)) entries.push([chosen, A.fmt('an unavailable library')]);
            return `<select ${attrs}>${choose}${entries.map(([libId, name]) => `<option value="${ctx.esc(libId)}"${libId === chosen ? ' selected' : ''}>${ctx.esc(name)}</option>`).join('')}</select>`;
        }
        const known = suggestions.get(ctx);
        if (field === 'genre' && known?.genres.length) {
            const match = known.genres.find((g) => g.toLowerCase() === value.toLowerCase());
            const list = value && !match ? known.genres.concat([value]) : known.genres;
            return `<select ${attrs}>${choose}${list.map((g) => `<option value="${ctx.esc(g)}"${g === (match || value) ? ' selected' : ''}>${ctx.esc(g)}</option>`).join('')}</select>`;
        }
        const ratings = field === 'ageRating' ? (known?.ratings || []) : [];
        const list = ratings.length ? ` list="${id}-ratings"` : '';
        return `<input type="text" ${attrs}${list} maxlength="100" value="${ctx.esc(value)}" placeholder="${ctx.tx(field === 'genre' ? 'e.g. Animation' : 'e.g. TV-Y')}">`
            + (ratings.length ? `<datalist id="${id}-ratings">${ratings.map((r) => `<option value="${ctx.esc(r)}"></option>`).join('')}</datalist>` : '');
    }

    let condSeq = 0;
    /**
     * One condition row: "Condition N", the field, "is", the value, remove.
     * @param {Object} ctx
     * @param {{field: string, value: string}} cond
     * @param {boolean} first
     * @returns {string}
     */
    function conditionRowHtml(ctx, cond, first) {
        const n = ++condSeq;
        const field = FIELDS.find((f) => f.toLowerCase() === String(cond.field || '').toLowerCase()) || 'library';
        return `<div class="je-ta-cond" data-cond>
            <span class="je-ta-cond-n" data-cond-n></span>
            <label class="je-ta-sr" for="jeTaCondField${n}" data-cond-field-label></label>
            <select id="jeTaCondField${n}" data-cond-field${first ? ' data-rule="field"' : ''}>${FIELDS.map((f) => `<option value="${f}"${f === field ? ' selected' : ''}>${ctx.tx(A.WORDS.field[f.toLowerCase()])}</option>`).join('')}</select>
            <span class="je-ta-cond-is" aria-hidden="true">${ctx.tx('is')}</span>
            <label class="je-ta-sr" for="jeTaCondValue${n}" data-cond-value-label></label>
            <span class="je-ta-cond-value" data-rule-value>${valueControl(ctx, field, String(cond.value || ''), `jeTaCondValue${n}`, first)}</span>
            <button type="button" class="je-ta-icon-btn" data-cond-remove><span class="material-icons" aria-hidden="true">close</span></button>
        </div>`;
    }

    A.registerSection({
        id: 'rules',
        tab: 'rules',
        order: 10,
        title: 'Default tag look rules',
        hint: 'The first enabled rule that matches a card gives it its layout and density. New users (and "Apply defaults to all users") start with these; users edit their own copy.',
        fields: [
            { id: 'tagLookRulesJson', key: 'TagLookRules', type: 'custom', label: 'Edit as JSON' },
        ],
        render(ctx, body) {
            const max = JE.core.tagLook?.MAX_CONDITIONS || 5;
            body.innerHTML = `
                <p class="je-ta-empty" data-rules-empty>${ctx.tx('No rules. New users start with the default look.')}</p>
                <ol class="je-ta-rules" data-rules></ol>
                <h4 class="je-ta-sub" id="jeTaRuleAddTitle" tabindex="-1" data-rule-title>${ctx.tx('Add a rule')}</h4>
                <div class="je-ta-rule-form" role="group" aria-labelledby="jeTaRuleAddTitle">
                    <fieldset class="je-ta-conds">
                        <legend class="je-ta-conds-legend">${ctx.tx('When all of these hold')}</legend>
                        <div data-conds></div>
                        <div class="je-ta-cond-add"><button type="button" class="je-ta-button" data-rule="add-cond">${ctx.tx('+ Condition')}</button><span class="je-ta-hint" data-cond-count></span></div>
                    </fieldset>
                    <fieldset class="je-ta-rule-look">
                        <legend class="je-ta-conds-legend">${ctx.tx('Use this look')}</legend>
                        <div class="je-ta-rule-look-row">
                            <label>${ctx.tx('Layout')}<select data-rule="layout">${LAYOUTS.map((l) => `<option value="${l}">${ctx.tx(A.WORDS.layout[l])}</option>`).join('')}</select></label>
                            <label>${ctx.tx('Label density')}<select data-rule="density"><option value="full">${ctx.tx('Full')}</option><option value="compact">${ctx.tx('Compact')}</option></select></label>
                        </div>
                    </fieldset>
                    <p class="je-ta-rule-error" id="jeTaRuleError" aria-live="assertive"></p>
                    <p class="je-ta-hint" data-rule-extras hidden>${ctx.tx('This rule also sets its own group positions or episode and list-row looks. Saving keeps them; change them as JSON.')}</p>
                    <div class="je-ta-actions je-ta-rule-actions">
                        <button type="button" class="je-ta-button je-ta-button--primary" data-rule="add"><span class="material-icons" aria-hidden="true">add</span><span data-rule-save-label>${ctx.tx('Add rule')}</span></button>
                        <button type="button" class="je-ta-button" data-rule="cancel" hidden>${ctx.tx('Cancel')}</button>
                        <span class="je-ta-hint" data-rule-hint>${ctx.tx('Added at the end of the list.')}</span>
                    </div>
                </div>
                <details class="je-ta-json" style="margin-top:14px">
                    <summary class="je-ta-link" id="tagLookRulesJsonLabel">${ctx.tx('Edit as JSON')}</summary>
                    <p class="je-ta-hint">${ctx.tx('For what the form does not set: per-rule group positions and episode or list-row looks. Each rule: when (1-5 conditions, all must hold; field library, type, genre or ageRating), layout and density. At most 50 rules.')}</p>
                    <textarea id="tagLookRulesJson" rows="10" spellcheck="false" aria-labelledby="tagLookRulesJsonLabel" aria-describedby="tagLookRulesJsonStatus tagLookRulesJsonStale"></textarea>
                    <p class="je-ta-json-status" id="tagLookRulesJsonStatus" role="status"></p>
                    <p class="je-ta-json-status je-ta-json-stale" id="tagLookRulesJsonStale" role="status" hidden>${ctx.tx('The saved rules changed while you were editing. Save JSON replaces them with this text; Revert loads the saved rules.')}</p>
                    <div class="je-ta-actions"><button type="button" class="je-ta-button" data-rule="json-save">${ctx.tx('Save JSON')}</button><button type="button" class="je-ta-button" data-rule="json-revert">${ctx.tx('Revert')}</button></div>
                </details>`;
            const form = /** @type {HTMLElement} */ (body.querySelector('.je-ta-rule-form'));
            const conds = /** @type {HTMLElement} */ (form.querySelector('[data-conds]'));
            const addCond = /** @type {HTMLButtonElement} */ (form.querySelector('[data-rule="add-cond"]'));
            const saveButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-rule="add"]'));
            const cancelButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-rule="cancel"]'));
            const error = /** @type {HTMLElement} */ (form.querySelector('#jeTaRuleError'));
            const title = /** @type {HTMLElement} */ (body.querySelector('[data-rule-title]'));
            const layoutSelect = /** @type {HTMLSelectElement} */ (form.querySelector('[data-rule="layout"]'));
            const densitySelect = /** @type {HTMLSelectElement} */ (form.querySelector('[data-rule="density"]'));

            /** Renumber the condition rows' labels; "+ Condition" and remove follow the row count. */
            const syncRows = () => {
                const rows = Array.from(conds.querySelectorAll('[data-cond]'));
                rows.forEach((row, i) => {
                    const n = String(i + 1);
                    /** @type {HTMLElement} */ (row.querySelector('[data-cond-n]')).textContent = A.fmt('Condition {n}', { n });
                    /** @type {HTMLElement} */ (row.querySelector('[data-cond-field-label]')).textContent = A.fmt('Condition {n} field', { n });
                    /** @type {HTMLElement} */ (row.querySelector('[data-cond-value-label]')).textContent = A.fmt('Condition {n} value', { n });
                    const remove = /** @type {HTMLButtonElement} */ (row.querySelector('[data-cond-remove]'));
                    remove.disabled = rows.length <= 1;
                    remove.setAttribute('aria-label', A.fmt('Remove condition {n}', { n }));
                });
                addCond.disabled = rows.length >= max;
                /** @type {HTMLElement} */ (form.querySelector('[data-cond-count]')).textContent = A.fmt('{count} of {max}', { count: rows.length, max });
            };
            /** @param {Array<{field: string, value: string}>} list */
            const setRows = (list) => {
                conds.innerHTML = list.map((cond, i) => conditionRowHtml(ctx, cond, i === 0)).join('');
                syncRows();
            };
            /** A new rule can be added only below the limit; editing one is always possible. */
            const syncCapacity = () => {
                const editing = editsOf(ctx).index >= 0;
                const full = !editing && rulesOf(ctx.config).length >= MAX_RULES;
                saveButton.disabled = full;
                /** @type {HTMLElement} */ (form.querySelector('[data-rule-hint]')).textContent = A.fmt(full ? 'You have {count} rules, the most there can be.' : editing ? 'Keeps the rule\'s place and On/Off state.' : 'Added at the end of the list.', { count: MAX_RULES });
            };
            /**
             * Show the form empty (Add a rule) or holding a rule (Edit rule N).
             * @param {Object|null} rule
             * @param {number} [index]
             */
            const fillForm = (rule, index = -1) => {
                if (rule) edits.set(ctx, { index, id: String(get(rule, 'id') || '') }); else edits.delete(ctx);
                const when = rule ? (get(rule, 'when') || []).map((c) => ({ field: String(get(c, 'field') || ''), value: String(get(c, 'value') || '') })) : [];
                setRows(when.length ? when : [{ field: 'library', value: '' }]);
                // New rules start at Caption and Compact, as in each user's own Rules & locks.
                layoutSelect.value = rule ? String(get(rule, 'layout') || 'corners').toLowerCase() : 'caption';
                densitySelect.value = rule && String(get(rule, 'density') || '').toLowerCase() !== 'compact' ? 'full' : 'compact';
                title.textContent = rule ? `${A.fmt('Edit rule')} ${index + 1}` : A.fmt('Add a rule');
                /** @type {HTMLElement} */ (form.querySelector('[data-rule-save-label]')).textContent = A.fmt(rule ? 'Save rule' : 'Add rule');
                /** @type {HTMLElement} */ (saveButton.querySelector('.material-icons')).textContent = rule ? 'check' : 'add';
                cancelButton.hidden = !rule;
                /** @type {HTMLElement} */ (form.querySelector('[data-rule-extras]')).hidden = !(rule && hasExtras(rule));
                error.textContent = '';
                syncCapacity();
            };

            conds.addEventListener('change', (e) => {
                const select = /** @type {HTMLElement} */ (e.target);
                if (select.matches?.('[data-cond-value]')) { select.removeAttribute('aria-invalid'); select.removeAttribute('aria-describedby'); return; }
                if (!select.matches?.('[data-cond-field]')) return;
                const row = /** @type {HTMLElement} */ (select.closest('[data-cond]'));
                const slot = /** @type {HTMLElement} */ (row.querySelector('[data-rule-value]'));
                const old = /** @type {HTMLElement} */ (slot.querySelector('[data-cond-value]'));
                slot.innerHTML = valueControl(ctx, /** @type {HTMLSelectElement} */ (select).value, '', old.id, old.dataset.rule === 'value');
            });
            conds.addEventListener('click', (e) => {
                const remove = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-cond-remove]'));
                if (!remove || remove.disabled) return;
                const rows = Array.from(conds.querySelectorAll('[data-cond]'));
                const at = rows.indexOf(/** @type {HTMLElement} */ (remove.closest('[data-cond]')));
                const kept = rows.filter((_, i) => i !== at).map((row) => ({ field: /** @type {HTMLSelectElement} */ (row.querySelector('[data-cond-field]')).value, value: /** @type {HTMLInputElement} */ (row.querySelector('[data-cond-value]')).value }));
                setRows(kept);
                // Focus the field of the row that took its place, else the one before it.
                const left = conds.querySelectorAll('[data-cond-field]');
                /** @type {HTMLElement|undefined} */ (left[Math.min(at, left.length - 1)])?.focus();
            });
            addCond.addEventListener('click', () => {
                const rows = Array.from(conds.querySelectorAll('[data-cond]'));
                if (rows.length >= max) return;
                conds.insertAdjacentHTML('beforeend', conditionRowHtml(ctx, { field: 'type', value: '' }, rows.length === 0));
                syncRows();
                /** @type {HTMLElement|null} */ (conds.lastElementChild?.querySelector('[data-cond-field]') || null)?.focus();
            });
            cancelButton.addEventListener('click', () => {
                const { index } = editsOf(ctx);
                fillForm(null);
                ctx.refresh({ controls: false });
                /** @type {HTMLElement|null} */ (body.querySelector(`.je-ta-rule[data-index="${index}"] [data-act="edit"]`) || title)?.focus();
            });
            saveButton.addEventListener('click', () => {
                const when = [];
                for (const row of conds.querySelectorAll('[data-cond]')) {
                    const field = /** @type {HTMLSelectElement} */ (row.querySelector('[data-cond-field]')).value;
                    const control = /** @type {HTMLInputElement} */ (row.querySelector('[data-cond-value]'));
                    const value = String(control.value || '').trim();
                    if (!value || (field === 'library' && !/^[0-9a-fA-F]{32}$/.test(value.replace(/-/g, '')))) {
                        error.textContent = A.fmt(field === 'library' ? 'Pick a library.' : 'Choose or enter a value for every condition.');
                        control.setAttribute('aria-invalid', 'true');
                        control.setAttribute('aria-describedby', 'jeTaRuleError');
                        control.focus();
                        return;
                    }
                    when.push({ Field: field, Value: field === 'library' ? value.replace(/-/g, '').toLowerCase() : value });
                }
                const rules = rulesOf(ctx.config);
                const { index, id } = editsOf(ctx);
                // The rule being edited, found by its id (it may have moved meanwhile), else at its place.
                const at = index < 0 ? -1 : (id ? rules.findIndex((r) => String(get(r, 'id') || '') === id) : (index < rules.length ? index : -1));
                if (at < 0 && rules.length >= MAX_RULES) { error.textContent = A.fmt('You have {count} rules, the most there can be.', { count: MAX_RULES }); return; }
                error.textContent = '';
                const layout = layoutSelect.value;
                const density = densitySelect.value;
                let n;
                if (at >= 0) {
                    // Editing keeps the rule's id, On/Off state, colour preset, positions and shape looks.
                    rules[at] = { ...rules[at], When: when, Layout: layout, Density: density };
                    for (const lower of ['when', 'layout', 'density']) delete rules[at][lower];
                    n = at + 1;
                } else {
                    const taken = new Set(rules.map((r) => String(get(r, 'id') || '')));
                    rules.push({ Id: JE.core.tagLook?.newRuleId ? JE.core.tagLook.newRuleId(taken) : '', Enabled: true, When: when, Layout: layout, Density: density, ColourPreset: null, Slots: null });
                    n = rules.length;
                }
                fillForm(null);
                ctx.set('TagLookRules', rules);
                ctx.announce(A.fmt(at >= 0 ? 'Rule {n} saved' : 'Rule {n} added', { n }));
                if (at >= 0) /** @type {HTMLElement|null} */ (body.querySelector(`.je-ta-rule[data-index="${at}"] [data-act="edit"]`))?.focus();
            });
            body.querySelector('[data-rules]')?.addEventListener('click', (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
                const row = /** @type {HTMLElement|null} */ (button?.closest('.je-ta-rule') || null);
                if (!button || !row || button.disabled) return;
                const i = Number(row.dataset.index);
                const rules = rulesOf(ctx.config);
                if (button.dataset.act === 'edit') {
                    if (!rules[i]) return;
                    fillForm(rules[i], i);
                    ctx.refresh({ controls: false });
                    /** @type {HTMLElement|null} */ (conds.querySelector('[data-cond-field]'))?.focus();
                } else if (button.dataset.act === 'move') {
                    const to = i + Number(button.dataset.dir);
                    if (to < 0 || to >= rules.length) return;
                    rules.splice(to, 0, rules.splice(i, 1)[0]);
                    const editing = editsOf(ctx);
                    if (editing.index === i) edits.set(ctx, { ...editing, index: to });
                    else if (editing.index === to) edits.set(ctx, { ...editing, index: i });
                    ctx.set('TagLookRules', rules);
                    const again = /** @type {HTMLButtonElement|null} */ (body.querySelector(`.je-ta-rule[data-index="${to}"] [data-act="move"][data-dir="${button.dataset.dir}"]`));
                    (again && !again.disabled ? again : body.querySelector(`.je-ta-rule[data-index="${to}"] [data-act="enable"]`))?.focus();
                } else if (button.dataset.act === 'delete') {
                    const before = rulesOf(ctx.config);
                    rules.splice(i, 1);
                    // The rule in the form is gone: the form goes back to adding (what was typed stays).
                    const editing = editsOf(ctx);
                    if (editing.index === i) { edits.delete(ctx); title.textContent = A.fmt('Add a rule'); /** @type {HTMLElement} */ (form.querySelector('[data-rule-save-label]')).textContent = A.fmt('Add rule'); cancelButton.hidden = true; syncCapacity(); }
                    else if (editing.index > i) edits.set(ctx, { ...editing, index: editing.index - 1 });
                    ctx.set('TagLookRules', rules.length ? rules : null);
                    ctx.snack(A.fmt('Rule {n} deleted', { n: i + 1 }), () => ctx.set('TagLookRules', before));
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
            const draft = draftOf(body);
            const check = () => {
                const parsed = parseRules(box.value);
                status.textContent = parsed.error ? parsed.error : (parsed.rules.length ? A.fmt('{n} {n|rule|rules} will be saved.', { n: parsed.rules.length }) : A.fmt('No rules. New users start with the default look.'));
                status.dataset.error = String(!!parsed.error);
                return parsed;
            };
            draft.check = check;
            box.addEventListener('input', () => {
                draft.dirty = box.value !== draft.loaded;
                if (!draft.dirty) /** @type {HTMLElement} */ (body.querySelector('#tagLookRulesJsonStale')).hidden = true;
                check();
            });
            body.querySelector('[data-rule="json-save"]')?.addEventListener('click', () => {
                const parsed = check();
                if (parsed.error) { box.focus(); return; }
                // The draft becomes the saved rules: the server's answer (ids filled in) loads into the box.
                draft.dirty = false;
                ctx.set('TagLookRules', parsed.rules.length ? parsed.rules : null);
                ctx.announce(A.fmt('Rules saved'));
            });
            body.querySelector('[data-rule="json-revert"]')?.addEventListener('click', () => { this.load(ctx, body, true); });
            ApiClient.getJSON(ApiClient.getUrl('Library/VirtualFolders')).then((folders) => {
                if (!ctx.isCurrent()) return;
                const names = {};
                for (const f of folders || []) if (f.ItemId) names[String(f.ItemId).replace(/-/g, '').toLowerCase()] = f.Name;
                libraryNames.set(ctx, names);
                updateChoices('library');
                ctx.refresh({ controls: false });
            }).catch((err) => console.warn('🪼 Jellyfin Enhanced: could not load the library list', err));
            // The library's genres and age ratings, for the genre choices and the age rating suggestions.
            ApiClient.getJSON(ApiClient.getUrl('Items/Filters', { userId: ApiClient.getCurrentUserId(), Recursive: true, IncludeItemTypes: 'Movie,Series,Season,Episode,BoxSet,Video' })).then((filters) => {
                if (!ctx.isCurrent()) return;
                const list = (value) => (Array.isArray(value) ? Array.from(new Set(value.map((v) => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)) : []);
                suggestions.set(ctx, { genres: list(filters?.Genres), ratings: list(filters?.OfficialRatings) });
                updateChoices('genre');
                updateChoices('ageRating');
            }).catch((err) => console.warn('🪼 Jellyfin Enhanced: could not load the genre and age rating suggestions', err));
            /**
             * A list arrived: give that field's conditions their choices without
             * losing the draft. A select keeps its element (and focus) and the
             * chosen value, even one the new list does not name; a typed value is
             * kept as typed (an age rating gains its suggestions); an empty text
             * field becomes the list.
             * @param {string} field
             */
            const updateChoices = (field) => {
                for (const row of conds.querySelectorAll('[data-cond]')) {
                    if (/** @type {HTMLSelectElement} */ (row.querySelector('[data-cond-field]')).value !== field) continue;
                    const slot = /** @type {HTMLElement} */ (row.querySelector('[data-rule-value]'));
                    const current = /** @type {HTMLInputElement|HTMLSelectElement} */ (slot.querySelector('[data-cond-value]'));
                    const value = String(current.value || '').trim();
                    const hadFocus = current === document.activeElement;
                    const next = valueControl(ctx, field, value, current.id, current.dataset.rule === 'value');
                    if (current.tagName === 'SELECT') {
                        const holder = document.createElement('div');
                        holder.innerHTML = next;
                        const fresh = holder.querySelector('select');
                        if (fresh) { current.innerHTML = fresh.innerHTML; current.value = fresh.value; }
                        continue;
                    }
                    if (value && field !== 'ageRating') continue;
                    slot.innerHTML = next;
                    const placed = /** @type {HTMLInputElement|null} */ (slot.querySelector('[data-cond-value]'));
                    if (placed && field === 'ageRating') placed.value = value;
                    if (hadFocus) placed?.focus({ preventScroll: true });
                }
            };
            fillForm(null);
            this.load(ctx, body);
        },
        /**
         * Put the stored rules into the JSON box (first draw, Revert, a save
         * or another administrator's change taken). A draft the administrator
         * changed is kept unless `force` (Revert); it then says when the saved
         * rules no longer match what it started from.
         * @param {Object} ctx
         * @param {Element} body
         * @param {boolean} [force]
         */
        load(ctx, body, force) {
            const box = /** @type {HTMLTextAreaElement|null} */ (body?.querySelector('#tagLookRulesJson'));
            if (!box) return;
            const draft = draftOf(body);
            const rules = rulesOf(ctx.config);
            const text = rules.length ? JSON.stringify(rules, null, 2) : '';
            const stale = /** @type {HTMLElement} */ (body.querySelector('#tagLookRulesJsonStale'));
            if (draft.dirty && !force) {
                stale.hidden = text === draft.loaded;
                return;
            }
            draft.loaded = text;
            draft.dirty = false;
            stale.hidden = true;
            box.value = text;
            draft.check?.();
        },
        refresh(ctx, body) {
            const list = body?.querySelector('[data-rules]');
            if (!list) return;
            const rules = rulesOf(ctx.config);
            // The rule in the form went away (another administrator, an undo): back to adding, keeping what was typed.
            const editing = editsOf(ctx);
            if (editing.index >= 0 && (editing.id ? !rules.some((r) => String(get(r, 'id') || '') === editing.id) : editing.index >= rules.length)) {
                edits.delete(ctx);
                const title = /** @type {HTMLElement|null} */ (body.querySelector('[data-rule-title]'));
                if (title) title.textContent = A.fmt('Add a rule');
                const label = /** @type {HTMLElement|null} */ (body.querySelector('[data-rule-save-label]'));
                if (label) label.textContent = A.fmt('Add rule');
                const cancel = /** @type {HTMLElement|null} */ (body.querySelector('[data-rule="cancel"]'));
                if (cancel) cancel.hidden = true;
            } else if (editing.id) {
                // Found by id: its place may have moved.
                const at = rules.findIndex((r) => String(get(r, 'id') || '') === editing.id);
                if (at !== editing.index) {
                    edits.set(ctx, { ...editing, index: at });
                    const title = /** @type {HTMLElement|null} */ (body.querySelector('[data-rule-title]'));
                    if (title) title.textContent = `${A.fmt('Edit rule')} ${at + 1}`;
                }
            }
            A.redrawList(list, rules.map((r, i) => ruleHtml(ctx, r, i, rules.length)).join(''), (el) => {
                const i = /** @type {HTMLElement|null} */ (el.closest('.je-ta-rule'))?.dataset.index;
                if (i === undefined || !el.dataset.act) return null;
                return `.je-ta-rule[data-index="${i}"] [data-act="${el.dataset.act}"]${el.dataset.dir ? `[data-dir="${el.dataset.dir}"]` : ''}`;
            });
            /** @type {HTMLElement} */ (body.querySelector('[data-rules-empty]')).hidden = rules.length > 0;
            const add = /** @type {HTMLButtonElement|null} */ (body.querySelector('[data-rule="add"]'));
            const hint = /** @type {HTMLElement|null} */ (body.querySelector('[data-rule-hint]'));
            if (add && hint) {
                const full = editsOf(ctx).index < 0 && rules.length >= MAX_RULES;
                add.disabled = full;
                hint.textContent = A.fmt(full ? 'You have {count} rules, the most there can be.' : editsOf(ctx).index >= 0 ? 'Keeps the rule\'s place and On/Off state.' : 'Added at the end of the list.', { count: MAX_RULES });
            }
            this.load(ctx, body);
        },
    });

    A.registerSection({
        id: 'rules-locks',
        tab: 'rules',
        // A pointer, not a list: after the server-wide item looks, drawn as a note.
        order: 40,
        note: true,
        title: 'Locked items',
        noteLabel: 'How user-locked looks work',
        hint: 'Locks keep one title\'s look whatever the rules say. They belong to each user, who sets them from an item\'s menu and manages them in their Media Tags settings, so there are none to set here.',
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
        const name = info ? (info.name || A.fmt('Unavailable item')) : A.fmt('Loading…');
        const type = info?.type ? `${A.fmt(A.WORDS.type[info.type.toLowerCase()])} · ` : '';
        const outcome = A.fmt('{layout} · {density}', { layout: A.fmt(A.WORDS.layout[look.layout]), density: A.WORDS.density[look.density] });
        const scope = info?.type === 'Series' ? ` · ${A.fmt(look.scope === 'item' ? 'This series poster only' : 'This series and its seasons and episodes')}` : '';
        const label = info?.name || id;
        return `<li class="je-ta-rule" data-item="${ctx.esc(id)}" data-je-focus-key="admin-item-look-row-${ctx.esc(id)}">
            <span class="je-ta-rule-text"><strong class="je-ta-rule-title">${ctx.esc(name)}</strong> <span class="je-ta-rule-meta">${ctx.esc(type)}${ctx.esc(outcome)}${ctx.esc(scope)}</span></span>
            <span class="je-ta-rule-tools">
                <button type="button" class="je-ta-button" data-act="edit" data-je-focus-key="admin-item-look-edit-${ctx.esc(id)}" aria-label="${ctx.esc(A.fmt('Edit the server-wide look of {name}', { name: label }))}">${ctx.tx('Edit')}</button>
                <button type="button" class="je-ta-icon-btn" data-act="remove" data-je-focus-key="admin-item-look-remove-${ctx.esc(id)}" aria-label="${ctx.esc(A.fmt('Remove the server-wide look of {name}', { name: label }))}"><span class="material-icons" aria-hidden="true">delete</span></button>
            </span>
        </li>`;
    }

    A.registerSection({
        id: 'item-looks',
        tab: 'rules',
        order: 30,
        title: 'Server-wide item looks',
        hint: 'Looks one title gets for every user, set with For everyone in the item\'s Media Tags editor (its ⋮ menu). A user\'s own locked look wins; rules never change these.',
        writes: ['TagLookItemOverrides'],
        render(ctx, body) {
            const heading = body.closest('[data-section]')?.querySelector('h3');
            if (heading) heading.tabIndex = -1;
            body.innerHTML = `<p class="je-ta-empty" data-item-looks-empty>${ctx.tx('No server-wide item looks yet.')}</p><ol class="je-ta-rules" data-item-looks></ol>`;
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
                    ctx.snack(A.fmt('Server-wide look removed from {name}', { name }), () => {
                        if (ctx.isCurrent()) ctx.set('TagLookItemOverrides', look.restoreItemOverrides(ctx.config.TagLookItemOverrides, removed));
                    });
                    /** @type {HTMLElement|null} */ (body.querySelector('[data-item] [data-act="remove"]') || (() => {
                        // The last one is gone: the card's heading (the empty note cannot take focus).
                        const title = /** @type {HTMLElement|null} */ (body.closest('.je-ta-card')?.querySelector('.je-ta-card-title') || null);
                        if (title) title.tabIndex = -1;
                        return title;
                    })())?.focus?.();
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
                            ctx.announce(A.fmt('Server-wide look saved for {name}', { name }));
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
