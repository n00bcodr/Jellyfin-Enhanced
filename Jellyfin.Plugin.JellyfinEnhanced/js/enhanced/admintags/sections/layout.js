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
    const groupName = (g) => JE.t(`panel_settings_ui_tag_group_${g === 'ageRating' ? 'age_rating' : g}`);
    /** @param {string} g @returns {string} The group's enable setting. */
    const enabledKey = (g) => `${pascal(g)}TagsEnabled`;

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
    function capOf(g, state) {
        const meta = editorData()?.GROUP_META[g] || {};
        if (meta.capFixed) return 1;
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
        const cap = capOf(g, state);
        const slot = slotOf(c, state, state.layout, g);
        const off = c[enabledKey(g)] !== true;
        let slots;
        if (state.layout === 'corners') {
            const anchors = ANCHORS.map((a) => {
                const label = JE.t(`panel_settings_ui_tag_slot_corners_${a}`);
                return `<button type="button" class="je-ta-anchor" data-slot="${a}" aria-pressed="${slot === a}" aria-label="${ctx.esc(JE.t('admin_tags_position_aria', { group: name, slot: label }))}" title="${ctx.esc(label)}"></button>`;
            }).join('');
            const where = slot === 'off' ? JE.t('panel_settings_ui_tag_slot_off') : JE.t(`panel_settings_ui_tag_slot_corners_${slot}`);
            slots = `<span class="je-ta-anchors" role="group" id="${L().POSITION_SETTINGS[g].userKey}" aria-label="${ctx.esc(JE.t('admin_tags_position_for', { group: name }))}">${anchors}</span>`
                + `<span class="je-ta-slot-name">${ctx.esc(where)}</span>`
                + `<button type="button" class="je-ta-pill" data-slot="off" aria-pressed="${slot === 'off'}">${ctx.tx('panel_settings_ui_tag_slot_off')}</button>`;
        } else {
            slots = `<span class="je-ta-pills" role="group" aria-label="${ctx.esc(JE.t('admin_tags_position_for', { group: name }))}">${L().LAYOUT_SLOTS[state.layout].filter((s) => s !== 'dots' || g === 'quality').map((s) => {
                const label = JE.t(s === 'off' ? 'panel_settings_ui_tag_slot_off' : `panel_settings_ui_tag_slot_${state.layout}_${s}`);
                return `<button type="button" class="je-ta-pill" data-slot="${s}" aria-pressed="${slot === s}">${ctx.esc(label)}</button>`;
            }).join('')}</span>`;
        }
        return `<li class="je-ta-lrow" data-group="${g}" data-off="${off}">
            <span class="je-ta-lrow-move">
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="-1" aria-label="${ctx.esc(JE.t('admin_tags_move_up', { name }))}" ${index === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="1" aria-label="${ctx.esc(JE.t('admin_tags_move_down', { name }))}" ${index === count - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </span>
            <span class="je-ta-lrow-name">${ctx.esc(name)}${off ? `<small>${ctx.tx('admin_tags_group_off_for_new')}</small>` : ''}</span>
            <span class="je-ta-lrow-cap" role="group" aria-label="${ctx.esc(JE.t('admin_tags_limit_for', { group: name }))}">${ctx.tx('admin_tags_limit')}
                <button type="button" class="je-ta-icon-btn" data-act="cap" data-dir="-1" aria-label="${ctx.esc(JE.t('tag_shapes_fewer', { group: name }))}" ${stepCap(cap, -1, meta) === null ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">remove</span></button>
                <output aria-live="polite">${cap === 0 ? ctx.tx('panel_settings_ui_tag_editor_summary_all') : cap}</output>
                <button type="button" class="je-ta-icon-btn" data-act="cap" data-dir="1" aria-label="${ctx.esc(JE.t('tag_shapes_more', { group: name }))}" ${stepCap(cap, 1, meta) === null ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">add</span></button>
            </span>
            <span class="je-ta-lrow-slots">${slots}</span>
        </li>`;
    }

    A.registerSection({
        id: 'layout-look',
        tab: 'layout',
        order: 10,
        title: 'admin_tags_layout_look',
        hint: 'admin_tags_layout_look_desc',
        fields: [
            { id: 'tagLayout', key: 'TagLayout', type: 'custom', label: 'admin_tags_layout_default' },
            { id: 'tagLabelDensity', key: 'TagLabelDensity', type: 'pills', label: 'panel_settings_ui_tag_density', desc: 'panel_settings_ui_tag_density_desc', options: [['full', 'panel_settings_ui_tag_density_full'], ['compact', 'panel_settings_ui_tag_density_compact']], read: (v) => (String(v || '').toLowerCase() === 'compact' ? 'compact' : 'full') },
        ],
        render(ctx, body) {
            const card = body.closest('.je-ta-card');
            const tiles = document.createElement('div');
            tiles.innerHTML = `<span class="je-ta-label" id="tagLayoutLabel">${ctx.tx('admin_tags_layout_default')}</span>
                <div class="je-ta-tiles" role="radiogroup" id="tagLayout" data-je-setting-id="tagLayout" aria-labelledby="tagLayoutLabel" aria-describedby="tagLayoutDesc">${LAYOUTS.map((id) => `
                    <label class="je-ta-tile"><input type="radio" name="jeTaLayout" value="${id}"><span class="je-ta-tile-art" data-layout="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="je-ta-tile-name">${ctx.tx(`tag_looks_layout_${id}`)}</span></label>`).join('')}</div>
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

    A.registerSection({
        id: 'layout-groups',
        tab: 'layout',
        order: 20,
        title: 'admin_tags_layout_groups',
        hint: 'admin_tags_layout_groups_desc',
        fields: [
            { id: 'qualityTagsPosition', key: 'QualityTagsPosition', type: 'custom', label: 'admin_tags_position_quality' },
            { id: 'genreTagsPosition', key: 'GenreTagsPosition', type: 'custom', label: 'admin_tags_position_genre' },
            { id: 'languageTagsPosition', key: 'LanguageTagsPosition', type: 'custom', label: 'admin_tags_position_language' },
            { id: 'ratingTagsPosition', key: 'RatingTagsPosition', type: 'custom', label: 'admin_tags_position_rating' },
            { id: 'ageRatingTagsPosition', key: 'AgeRatingTagsPosition', type: 'custom', label: 'admin_tags_position_age_rating' },
            { id: 'statusTagsPosition', key: 'StatusTagsPosition', type: 'custom', label: 'admin_tags_position_status' },
        ],
        render(ctx, body) {
            body.innerHTML = '<p class="je-ta-hint" data-layout-note></p><ol class="je-ta-lrows" id="tagGroupAdminRows"></ol>';
            body.addEventListener('click', (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
                const row = /** @type {HTMLElement|null} */ (button?.closest('.je-ta-lrow') || null);
                if (!button || !row || button.disabled) return;
                const g = row.dataset.group || '';
                const c = ctx.config;
                const state = readState(c);
                const values = {};
                let keep = '';
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
                    const next = editorData()?.stepCap(capOf(g, state), Number(button.dataset.dir), editorData().GROUP_META[g] || {});
                    if (next === null || next === undefined) return;
                    state.caps[g] = next;
                    keep = `[data-act="cap"][data-dir="${button.dataset.dir}"]`;
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
                ctx.setMany({ ...writeState(state), ...values });
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
            list.innerHTML = order.map((g, i) => rowHtml(ctx, state, g, i, order.length)).join('');
            const note = body.querySelector('[data-layout-note]');
            if (note) note.textContent = JE.t('admin_tags_layout_groups_for', { layout: JE.t(`tag_looks_layout_${state.layout}`) });
        },
    });

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
                if (!(await ctx.flush())) { ctx.snack(JE.t('admin_tags_apply_all_failed')); return; }
                try {
                    await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/JellyfinEnhanced/reset-all-users-settings'), dataType: 'json' });
                    ctx.snack(JE.t('admin_tags_apply_all_done'));
                } catch (err) {
                    console.error('🪼 Jellyfin Enhanced: applying the defaults to all users failed', err);
                    ctx.snack(JE.t('admin_tags_apply_all_failed'));
                }
            });
        },
    });

    // Exposed for tests.
    A.layoutData = { readState, writeState, slotOf, capOf, shapeChoice, recommendedWire };
})(window.JellyfinEnhanced);
