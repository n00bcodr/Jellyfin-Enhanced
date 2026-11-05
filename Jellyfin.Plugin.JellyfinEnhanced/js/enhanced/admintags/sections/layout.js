/**
 * @file Media Tags admin page, Layout defaults tab: the layout and label
 * density new users start with, each group's priority order, limit and
 * position (nine anchors for corners, the layout's slots otherwise), the
 * looks of episode thumbnails and list rows, two display switches, and
 * "Apply defaults to all users".
 *
 * Writes the same fields the main configuration page wrote: TagLayout,
 * TagLabelDensity, TagGroupOrder (only once reordered), TagGroupCaps and
 * TagLayouts (explicit values only, so new users keep inheriting the
 * built-in ones), the six *TagsPosition settings (the corners profile is the
 * position settings; TagLayouts.Corners only stores "Hidden") and
 * TagShapeOverrides. The layout vocabulary comes from core/tag-layout.js.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    /** The nine corner anchors, row by row (slot ids of core/tag-layout.js). */
    const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];
    const pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    /** @returns {any} The layout controller. */
    const L = () => JE.core.tagLayout;
    /** @returns {Object} The settings panel editor's cap rules (stepCap, GROUP_META). */
    const editorData = () => JE.internals?.enhancedUi?.tagGroupEditorData || null;
    /** @param {string} g @returns {string} */
    const groupName = (g) => JE.t(JE.core.tagLayout.VOCABULARY_KEYS.group[`${g === 'ageRating' ? 'age_rating' : g}`]);
    /** @param {string} g @returns {string} The group's enable setting. */
    const enabledKey = (g) => `${g === 'logos' ? 'Logo' : pascal(g)}TagsEnabled`;

    /**
     * Read a key in either case.
     * @param {*} obj
     * @param {string} key - camelCase.
     * @returns {*}
     */
    function pick(obj, key) {
        if (!obj || typeof obj !== 'object') return undefined;
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
        const p = pascal(key);
        return obj[p] !== undefined && obj[p] !== null ? obj[p] : undefined;
    }

    /**
     * The administrator's explicit layout defaults, read from the configuration.
     * @param {Object} c
     * @returns {{layout: string, order: string[]|null, caps: Object<string, number>, profiles: Object<string, Object<string, string>>}}
     */
    function readState(c) {
        const layout = LAYOUTS.includes(String(c.TagLayout || '').toLowerCase()) ? String(c.TagLayout).toLowerCase() : 'corners';
        const groups = L().DEFAULT_ORDER;
        let order = null;
        if (Array.isArray(c.TagGroupOrder)) {
            const seen = [];
            for (const g of c.TagGroupOrder) { const id = L().normalizeGroup(g); if (id && !seen.includes(id)) seen.push(id); }
            if (seen.length) order = seen.concat(groups.filter((g) => !seen.includes(g)));
        }
        const caps = {};
        for (const g of groups) {
            const raw = pick(c.TagGroupCaps, g);
            const n = Number(raw);
            if (raw !== undefined && Number.isFinite(n)) caps[g] = Math.max(0, Math.min(L().MAX_CAP, Math.round(n)));
        }
        const profiles = {};
        for (const name of LAYOUTS) {
            const profile = {};
            const entries = pick(pick(c.TagLayouts, name), 'groups');
            for (const entry of Array.isArray(entries) ? entries : []) {
                const g = L().normalizeGroup(pick(entry, 'group'));
                const slot = String(pick(entry, 'slot') || '').toLowerCase();
                if (!g || profile[g] || !L().LAYOUT_SLOTS[name].includes(slot) || (slot === 'dots' && g !== 'quality')) continue;
                // Corners keeps only "Hidden"; corner picks live in the position settings.
                if (name === 'corners' && slot !== 'off') continue;
                profile[g] = slot;
            }
            profiles[name] = profile;
        }
        return { layout, order, caps, profiles };
    }

    /**
     * The configuration fields for a state (null where nothing is explicit).
     * @param {ReturnType<typeof readState>} state
     * @returns {Object}
     */
    function writeState(state) {
        const caps = {};
        for (const [g, n] of Object.entries(state.caps)) caps[pascal(g)] = n;
        const layouts = {};
        let anyProfile = false;
        for (const name of LAYOUTS) {
            const groups = Object.entries(state.profiles[name]).map(([g, slot]) => ({ Group: g, Slot: slot }));
            layouts[pascal(name)] = groups.length ? { Groups: groups } : null;
            if (groups.length) anyProfile = true;
        }
        return {
            TagGroupOrder: state.order ? state.order.slice() : null,
            TagGroupCaps: Object.keys(caps).length ? caps : null,
            TagLayouts: anyProfile ? layouts : null,
        };
    }

    /**
     * The slot a group shows in a layout: explicit pick, else the position
     * setting (corners) or the built-in profile.
     * @param {Object} c
     * @param {ReturnType<typeof readState>} state
     * @param {string} name
     * @param {string} g
     * @returns {string}
     */
    function slotOf(c, state, name, g) {
        if (state.profiles[name][g]) return state.profiles[name][g];
        if (name === 'corners') return L().POSITION_TO_SLOT[c[L().POSITION_SETTINGS[g].pluginKey]] || 'tl';
        return L().DEFAULT_PROFILES[name][g];
    }

    /** @param {string} g @param {ReturnType<typeof readState>} state @returns {number} */
    function capOf(g, state, config) {
        const meta = editorData()?.GROUP_META[g] || {};
        if (L().singleChipGroup(g, config)) return 1;
        return Number.isFinite(state.caps[g]) ? state.caps[g] : L().DEFAULT_CAPS[g];
    }

    /**
     * One group row: move buttons, name, limit stepper and position control.
     * @param {Object} ctx
     * @param {ReturnType<typeof readState>} state
     * @param {string} g
     * @param {number} index
     * @param {number} count
     * @returns {string}
     */
    function rowHtml(ctx, state, g, index, count) {
        const c = ctx.config;
        const name = groupName(g);
        const meta = editorData()?.GROUP_META[g] || {};
        const stepCap = editorData()?.stepCap || (() => null);
        const cap = capOf(g, state, c);
        const slot = slotOf(c, state, state.layout, g);
        const off = c[enabledKey(g)] !== true;
        let slots;
        if (state.layout === 'corners') {
            const anchors = ANCHORS.map((a) => {
                const label = JE.t(JE.core.tagLayout.VOCABULARY_KEYS.slot[`corners_${a}`]);
                return `<button type="button" class="je-ta-anchor" data-slot="${a}" aria-pressed="${slot === a}" tabindex="${slot === a ? 0 : -1}" aria-label="${ctx.esc(JE.t('admin_tags_position_aria', { group: name, slot: label }))}">${ctx.esc(label)}</button>`;
            }).join('');
            // The nine positions by name, as on the hub and in the item editor; Hidden spans the row under them.
            slots = `<span class="je-ta-anchors" role="group" id="${L().POSITION_SETTINGS[g].userKey}" aria-label="${ctx.esc(JE.t('admin_tags_position_for', { group: name }))}">${anchors}`
                + `<button type="button" class="je-ta-pill je-ta-anchor-off" data-slot="off" aria-pressed="${slot === 'off'}" tabindex="${slot === 'off' ? 0 : -1}">${ctx.tx('panel_settings_ui_tag_slot_off')}</button></span>`;
        } else {
            slots = `<span class="je-ta-pills" role="group" aria-label="${ctx.esc(JE.t('admin_tags_position_for', { group: name }))}">${L().LAYOUT_SLOTS[state.layout].filter((s) => s !== 'dots' || g === 'quality').map((s) => {
                const label = JE.t(s === 'off' ? 'panel_settings_ui_tag_slot_off' : JE.core.tagLayout.VOCABULARY_KEYS.slot[`${state.layout}_${s}`]);
                return `<button type="button" class="je-ta-pill" data-slot="${s}" aria-pressed="${slot === s}">${ctx.esc(label)}</button>`;
            }).join('')}</span>`;
        }
        const fixed = L().singleChipGroup(g, c);
        const where = JE.t(slot === 'off' ? 'panel_settings_ui_tag_slot_off' : JE.core.tagLayout.VOCABULARY_KEYS.slot[`${state.layout}_${slot}`]);
        const capText = cap === 0 ? JE.t('panel_settings_ui_tag_editor_cap_all') : String(cap);
        const summary = slot === 'off' || fixed ? where : JE.t(cap === 0 ? 'tag_item_editor_group_summary_all' : 'tag_item_editor_group_summary', { where, cap: capText });
        // Collapsed, a row says where the group goes and its limit; one row's controls open at a time.
        const open = openGroups.get(ctx) === g;
        return `<li class="je-ta-lrow" data-group="${g}" data-off="${off}" data-open="${open}" data-je-anchor="placement-${g}">
            <span class="je-ta-lrow-move">
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="-1" aria-label="${ctx.esc(JE.t('admin_tags_move_up', { name }))}" ${index === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="1" aria-label="${ctx.esc(JE.t('admin_tags_move_down', { name }))}" ${index === count - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </span>
            <span class="je-ta-lrow-name">${ctx.esc(name)}${off ? `<small>${ctx.tx('admin_tags_group_off_for_new')}</small>` : ''}</span>
            <span class="je-ta-lrow-sum">${ctx.esc(summary)}</span>
            <button type="button" class="je-ta-button je-ta-lrow-open" data-act="open" data-dir="0" aria-expanded="${open}" aria-controls="jeTaLrow-${g}" aria-label="${ctx.esc(JE.t('tag_item_editor_group_edit', { group: name }))}">${ctx.tx('tag_shapes_edit')}<span class="material-icons" aria-hidden="true">expand_more</span></button>
            <span class="je-ta-lrow-detail" id="jeTaLrow-${g}" ${open ? '' : 'hidden'}>
            <span class="je-ta-lrow-slots">${slots}</span>
            ${fixed ? '' : `<span class="je-ta-lrow-cap" role="group" aria-label="${ctx.esc(JE.t('admin_tags_limit_for', { group: name }))}">${ctx.tx('panel_settings_ui_tag_editor_show_up_to')}
                <button type="button" class="je-ta-icon-btn" data-act="cap" data-dir="-1" aria-label="${ctx.esc(JE.t('tag_shapes_fewer', { group: name }))}" ${stepCap(cap, -1, meta) === null ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">remove</span></button>
                <output aria-live="polite">${cap === 0 ? ctx.tx('panel_settings_ui_tag_editor_cap_all') : cap}</output>
                <button type="button" class="je-ta-icon-btn" data-act="cap" data-dir="1" aria-label="${ctx.esc(JE.t('tag_shapes_more', { group: name }))}" ${stepCap(cap, 1, meta) === null ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">add</span></button>
            </span>`}
            ${groupSettingsLink(ctx, g, name)}
            </span>
        </li>`;
    }

    A.registerSection({
        id: 'layout-look',
        tab: 'layout',
        order: 10,
        title: 'admin_tags_overview_look',
        hint: 'admin_tags_layout_look_desc',
        fields: [
            { id: 'tagLayout', key: 'TagLayout', type: 'custom', label: 'admin_tags_layout_default' },
            { id: 'tagLabelDensity', key: 'TagLabelDensity', type: 'pills', label: 'panel_settings_ui_tag_density', desc: 'panel_settings_ui_tag_density_desc', options: [['full', 'panel_settings_ui_tag_density_full'], ['compact', 'panel_settings_ui_tag_density_compact']], read: (v) => (String(v || '').toLowerCase() === 'compact' ? 'compact' : 'full') },
            // Size, gap and edge as the hub shows them: a row of choices with its help line.
            { id: 'tagScale', key: 'TagScale', type: 'pills', label: 'admin_tags_tagScale', desc: 'tag_scale_desc', options: [['smaller', '=85%'], ['default', '=100%'], ['larger', '=115%'], ['largest', '=130%']] },
            { id: 'tagGap', key: 'TagGap', type: 'pills', label: 'admin_tags_tagGap', desc: 'tag_gap_desc', options: [['tight', '=Tight'], ['default', '=Default'], ['roomy', '=Roomy']] },
            { id: 'tagEdgeSpacing', key: 'TagEdgeSpacing', type: 'pills', label: 'admin_tags_tagEdgeSpacing', desc: 'panel_settings_ui_tag_edge_desc', options: [['default', '=Default'], ['tight', '=Tight'], ['flush', '=Flush']] },
        ],
        render(ctx, body) {
            const card = body.closest('.je-ta-card');
            const tiles = document.createElement('div');
            tiles.innerHTML = `<span class="je-ta-label" id="tagLayoutLabel">${ctx.tx('admin_tags_layout_default')}</span>
                <div class="je-ta-tiles" role="radiogroup" id="tagLayout" data-je-setting-id="tagLayout" aria-labelledby="tagLayoutLabel" aria-describedby="tagLayoutDesc">${LAYOUTS.map((id) => `
                    <label class="je-ta-tile"><input type="radio" name="jeTaLayout" value="${id}"><span class="je-ta-tile-art" data-layout="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="je-ta-tile-name">${ctx.tx(JE.core.tagLayout.VOCABULARY_KEYS.layout[id])}</span></label>`).join('')}</div>
                <p class="je-ta-hint" id="tagLayoutDesc" aria-live="polite" style="margin-top:8px"></p>`;
            card.querySelector('.je-ta-hint')?.after(tiles);
            tiles.addEventListener('change', (e) => {
                const input = /** @type {HTMLInputElement} */ (e.target);
                if (input.name === 'jeTaLayout') ctx.set('TagLayout', input.value);
            });
        },
        refresh(ctx) {
            const layout = readState(ctx.config).layout;
            ctx.root.querySelectorAll('input[name="jeTaLayout"]').forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === layout; });
            const desc = ctx.root.querySelector('#tagLayoutDesc');
            if (desc) desc.textContent = JE.t(`panel_settings_ui_tag_layout_${layout}`);
        },
    });

    /**
     * The selector of a focused group row control, to focus it again after a redraw.
     * @param {HTMLElement} el
     * @returns {string|null}
     */
    function focusSelector(el) {
        const g = /** @type {HTMLElement|null} */ (el.closest('.je-ta-lrow'))?.dataset.group;
        if (!g) return null;
        const own = el.dataset.slot ? `[data-slot="${el.dataset.slot}"]` : el.dataset.act ? `[data-act="${el.dataset.act}"][data-dir="${el.dataset.dir}"]` : null;
        return own && `.je-ta-lrow[data-group="${g}"] ${own}`;
    }

    /**
     * The link from a placement row to the group's own settings on the Groups tab.
     * @param {Object} ctx
     * @param {string} g
     * @param {string} name
     * @returns {string}
     */
    function groupSettingsLink(ctx, g, name) {
        return `<a class="je-ta-link je-ta-crosslink" href="#" data-je-goto="groups:${g}">${ctx.esc(JE.t('admin_tags_goto_group', { group: name }))}<span class="material-icons" aria-hidden="true">arrow_forward</span></a>`;
    }

    /** Per page view: the group row whose controls are open. */
    const openGroups = new WeakMap();

    const groupsSection = {
        id: 'layout-groups',
        tab: 'layout',
        order: 20,
        title: 'admin_tags_layout_groups',
        hint: 'admin_tags_layout_groups_desc',
        writes: ['TagLayouts', 'TagGroupOrder', 'TagGroupCaps'],
        fields: [
            { id: 'qualityTagsPosition', key: 'QualityTagsPosition', type: 'custom', label: 'admin_tags_position_quality' },
            { id: 'genreTagsPosition', key: 'GenreTagsPosition', type: 'custom', label: 'admin_tags_position_genre' },
            { id: 'languageTagsPosition', key: 'LanguageTagsPosition', type: 'custom', label: 'admin_tags_position_language' },
            { id: 'ratingTagsPosition', key: 'RatingTagsPosition', type: 'custom', label: 'admin_tags_position_rating' },
            { id: 'ageRatingTagsPosition', key: 'AgeRatingTagsPosition', type: 'custom', label: 'admin_tags_position_age_rating' },
            { id: 'statusTagsPosition', key: 'StatusTagsPosition', type: 'custom', label: 'admin_tags_position_status' },
            { id: 'awardsTagsPosition', key: 'AwardsTagsPosition', type: 'custom', label: 'admin_tags_awardsTagsPosition' },
            { id: 'logoTagsPosition', key: 'LogoTagsPosition', type: 'custom', label: 'admin_tags_logoTagsPosition' },
            { id: 'customTagsPosition', key: 'CustomTagsPosition', type: 'custom', label: 'admin_tags_customTagsPosition' },
        ],
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-hint" data-layout-note></p><button type="button" class="je-ta-button je-ta-reorder" data-reorder aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${ctx.tx('panel_settings_ui_tag_editor_reorder_groups')}</span></button><ol class="je-ta-lrows" id="tagGroupAdminRows"></ol>`;
            // Phone: the order buttons show only in reorder mode.
            body.querySelector('[data-reorder]')?.addEventListener('click', (e) => {
                const toggle = /** @type {HTMLElement} */ (e.currentTarget);
                const on = !body.classList.contains('je-ta-reordering');
                body.classList.toggle('je-ta-reordering', on);
                toggle.setAttribute('aria-pressed', String(on));
                /** @type {HTMLElement} */ (toggle.lastElementChild).textContent = JE.t(on ? 'panel_settings_ui_tag_editor_reorder_done' : 'panel_settings_ui_tag_editor_reorder_groups');
            });
            // One Tab stop per position picker; arrow keys, Home and End move along it (Enter or Space picks).
            body.addEventListener('keydown', (e) => {
                const cell = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.je-ta-anchors [data-slot]'));
                if (!cell || e.altKey || e.ctrlKey || e.metaKey) return;
                const cells = Array.from(/** @type {HTMLElement} */ (cell.closest('.je-ta-anchors')).querySelectorAll('[data-slot]'));
                const at = cells.indexOf(cell);
                const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
                const next = step ? cells[Math.min(cells.length - 1, Math.max(0, at + step))] : e.key === 'Home' ? cells[0] : e.key === 'End' ? cells[cells.length - 1] : null;
                if (!next) return;
                e.preventDefault();
                cells.forEach((c) => { c.tabIndex = c === next ? 0 : -1; });
                next.focus();
            });
            body.addEventListener('click', (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
                const row = /** @type {HTMLElement|null} */ (button?.closest('.je-ta-lrow') || null);
                if (!button || !row || button.disabled) return;
                const g = row.dataset.group || '';
                const c = ctx.config;
                const state = readState(c);
                const values = {};
                let keep = '';
                if (button.dataset.act === 'open') {
                    openGroups.set(ctx, openGroups.get(ctx) === g ? null : g);
                    groupsSection.refresh(ctx, body);
                    /** @type {HTMLElement|null} */ (ctx.root.querySelector(`#tagGroupAdminRows .je-ta-lrow[data-group="${g}"] [data-act="open"]`))?.focus();
                    return;
                }
                if (button.dataset.act === 'move') {
                    const list = state.order ? state.order.slice() : L().DEFAULT_ORDER.slice();
                    const from = list.indexOf(g);
                    const to = from + Number(button.dataset.dir);
                    if (to < 0 || to >= list.length) return;
                    list.splice(to, 0, list.splice(from, 1)[0]);
                    state.order = list;
                    keep = `[data-act="move"][data-dir="${button.dataset.dir}"]`;
                    ctx.announce(JE.t('admin_tags_moved', { name: groupName(g), n: to + 1 }));
                } else if (button.dataset.act === 'cap') {
                    const next = editorData()?.stepCap(capOf(g, state, ctx.config), Number(button.dataset.dir), editorData().GROUP_META[g] || {});
                    if (next === null || next === undefined) return;
                    state.caps[g] = next;
                    keep = `[data-act="cap"][data-dir="${button.dataset.dir}"]`;
                    // The redrawn row's <output> arrives already filled, which screen readers do not read out.
                    ctx.announce(JE.t('admin_tags_limit_set', { group: groupName(g), n: next === 0 ? JE.t('panel_settings_ui_tag_editor_summary_all') : next }));
                } else if (button.dataset.slot) {
                    const slot = button.dataset.slot;
                    if (state.layout === 'corners') {
                        if (slot === 'off') state.profiles.corners[g] = 'off';
                        else {
                            delete state.profiles.corners[g];
                            values[L().POSITION_SETTINGS[g].pluginKey] = L().SLOT_TO_POSITION[slot];
                        }
                    } else {
                        state.profiles[state.layout][g] = slot;
                    }
                    keep = `[data-slot="${slot}"]`;
                } else return;
                // Only what this click changed: the stored order, caps and profiles come in the
                // server's own shape ([] for no order, members omitted, its key order), which
                // never matches writeState's text, so an untouched one would be resent and could
                // conflict with (and on Keep mine undo) another administrator's change.
                const before = writeState(readState(c));
                const after = writeState(state);
                for (const key of Object.keys(after)) if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) values[key] = after[key];
                if (!Object.keys(values).length) return;
                ctx.setMany(values);
                // Keep keyboard focus on the same control of the (redrawn) row.
                const again = /** @type {HTMLButtonElement|null} */ (ctx.root.querySelector(`#tagGroupAdminRows .je-ta-lrow[data-group="${g}"] ${keep}`));
                const fallback = ctx.root.querySelector(`#tagGroupAdminRows .je-ta-lrow[data-group="${g}"] button:not([disabled])`);
                /** @type {HTMLElement|null} */ ((again && !again.disabled ? again : fallback))?.focus();
            });
        },
        refresh(ctx, body) {
            const list = body?.querySelector('#tagGroupAdminRows');
            if (!list) return;
            const state = readState(ctx.config);
            const order = state.order || L().DEFAULT_ORDER;
            A.redrawList(list, order.map((g, i) => rowHtml(ctx, state, g, i, order.length)).join(''), focusSelector);
            const note = body.querySelector('[data-layout-note]');
            if (note) note.textContent = JE.t('admin_tags_layout_groups_for', { layout: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.layout[state.layout]) });
        },
    };
    A.registerSection(groupsSection);

    /**
     * Card shape defaults: each shape keeps the default look, takes the
     * recommended look, or keeps a custom look saved elsewhere untouched.
     */
    const SHAPE_FIELDS = { landscape: 'tagShapeLandscapeDefault', list: 'tagShapeListDefault' };

    /**
     * A recommended look in the server's wire form (PascalCase objects, camelCase array items), as the main page wrote it.
     * @param {string} shape
     * @returns {Object}
     */
    function recommendedWire(shape) {
        const look = L().RECOMMENDED_SHAPES[shape];
        const caps = look.caps ? Object.fromEntries(Object.entries(look.caps).map(([g, n]) => [pascal(g), n])) : null;
        return { Layout: look.layout, Density: look.density, Slots: Object.entries(look.slots).map(([group, slot]) => ({ group, slot })), Caps: caps };
    }

    /**
     * Whether a stored look is exactly the recommended one.
     * @param {string} shape
     * @param {Object} look
     * @returns {boolean}
     */
    function isRecommended(shape, look) {
        const want = L().readShapeOverrides({ [shape]: L().RECOMMENDED_SHAPES[shape] })[shape];
        const have = L().readShapeOverrides({ [shape]: look })[shape];
        return JSON.stringify(want) === JSON.stringify(have);
    }

    /**
     * Which choice a shape shows: inherit, recommended or custom.
     * @param {Object} c
     * @param {string} shape
     * @returns {string}
     */
    function shapeChoice(c, shape) {
        const look = pick(c.TagShapeOverrides, shape) || null;
        return !look ? 'inherit' : (isRecommended(shape, look) ? 'recommended' : 'custom');
    }

    A.registerSection({
        id: 'layout-shapes',
        tab: 'layout',
        order: 30,
        title: 'admin_tags_layout_shapes',
        hint: 'admin_tags_layout_shapes_desc',
        fields: [
            { id: 'tagShapeLandscapeDefault', key: 'TagShapeOverrides', type: 'custom', label: 'tag_shapes_landscape' },
            { id: 'tagShapeListDefault', key: 'TagShapeOverrides', type: 'custom', label: 'tag_shapes_list' },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-fields">${Object.entries(SHAPE_FIELDS).map(([shape, id]) => `
                <div class="je-ta-field"><span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${id}">${ctx.tx(`tag_shapes_${shape}`)}</label></span>
                <span class="je-ta-field-control"><select id="${id}" data-shape="${shape}">
                    <option value="inherit">${ctx.tx('admin_tags_shape_inherit')}</option>
                    <option value="recommended">${ctx.tx(`admin_tags_shape_recommended_${shape}`)}</option>
                    <option value="custom">${ctx.tx('admin_tags_shape_custom')}</option>
                </select></span></div>`).join('')}</div>`;
            body.addEventListener('change', (e) => {
                const select = /** @type {HTMLSelectElement} */ (e.target);
                const shape = select.dataset.shape;
                if (!shape) return;
                const out = {};
                for (const s of Object.keys(SHAPE_FIELDS)) {
                    const choice = s === shape ? select.value : shapeChoice(ctx.config, s);
                    out[pascal(s)] = choice === 'recommended' ? recommendedWire(s) : choice === 'custom' ? (pick(ctx.config.TagShapeOverrides, s) || null) : null;
                }
                ctx.set('TagShapeOverrides', Object.values(out).some(Boolean) ? out : null);
            });
        },
        refresh(ctx, body) {
            for (const [shape, id] of Object.entries(SHAPE_FIELDS)) {
                const select = /** @type {HTMLSelectElement|null} */ (body?.querySelector(`#${id}`));
                if (!select) continue;
                const choice = shapeChoice(ctx.config, shape);
                const custom = /** @type {HTMLOptionElement} */ (select.querySelector('option[value="custom"]'));
                custom.hidden = choice !== 'custom';
                custom.disabled = choice !== 'custom';
                if (document.activeElement !== select) select.value = choice;
            }
        },
    });

    A.registerSection({
        id: 'layout-display',
        tab: 'layout',
        order: 40,
        title: 'admin_tags_layout_display',
        fields: [
            { id: 'tagsHideOnHover', key: 'TagsHideOnHover', type: 'switch', label: 'admin_tags_hide_on_hover', desc: 'admin_tags_hide_on_hover_desc' },
            { id: 'disableTagsOnSearchPage', key: 'DisableTagsOnSearchPage', type: 'switch', label: 'admin_tags_disable_on_search', desc: 'admin_tags_disable_on_search_desc' },
        ],
    });

    A.registerSection({
        id: 'layout-apply',
        tab: 'layout',
        order: 50,
        title: 'admin_tags_apply_all',
        hint: 'admin_tags_apply_all_desc',
        render(ctx, body) {
            body.closest('.je-ta-card')?.setAttribute('data-je-anchor', 'apply');
            body.innerHTML = `<div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="jeTaApplyAll"><span class="material-icons" aria-hidden="true">group</span>${ctx.tx('admin_tags_apply_all')}</button></div>`;
            body.querySelector('#jeTaApplyAll')?.addEventListener('click', async () => {
                const ok = await ctx.confirm(JE.t('admin_tags_apply_all_confirm'), JE.t('admin_tags_apply_all'));
                if (!ok) return;
                const saved = await ctx.flush();
                if (!ctx.isCurrent()) return;
                if (!saved) { ctx.snack(JE.t('admin_tags_apply_all_failed')); return; }
                try {
                    await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/JellyfinEnhanced/reset-all-users-settings'), dataType: 'json' });
                    if (!ctx.isCurrent()) return;
                    ctx.snack(JE.t('admin_tags_apply_all_done'));
                } catch (err) {
                    if (!ctx.isCurrent()) return;
                    console.error('🪼 Jellyfin Enhanced: applying the defaults to all users failed', err);
                    ctx.snack(JE.t('admin_tags_apply_all_failed'));
                }
            });
        },
    });

    // Exposed for tests.
    A.layoutData = { readState, writeState, slotOf, capOf, shapeChoice, recommendedWire };
})(window.JellyfinEnhanced);
