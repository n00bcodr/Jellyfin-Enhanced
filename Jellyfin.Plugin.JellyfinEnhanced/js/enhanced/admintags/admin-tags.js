/**
 * @file The Media Tags administrator page (Configuration/mediaTagsPage.html):
 * a hub-like page for every server-wide Media Tags setting, built from
 * section modules (js/enhanced/admintags/sections/*.js).
 *
 * A section module calls `JE.adminTags.registerSection(def)`:
 *   { id, tab, order, title, hint?, fields?, group?, render?(ctx, body), refresh?(ctx, body) }
 * `tab` is one of TABS; on the Groups tab a section with `group` becomes a
 * group row whose panel opens below it. `fields` is a declarative list, one
 * object per line, `{ id, key, type, label, … }`: `id` is the control's DOM id
 * (the id the setting had on the main configuration page, kept so search,
 * What's New and the generators keep tracking it), `key` the
 * PluginConfiguration field it reads and writes. Types: switch, select,
 * number, text, textarea, pills, ordered (a checkbox in a reorderable list
 * whose position writes `orderKey`), enable (a group row's switch) and custom
 * (rendered by the section's own `render`; declared for tracking only).
 * Optional: desc, options, min/max/fallback/unit, read(raw, config) and
 * write(value, config) to convert, onChange(value, config) returning more
 * fields to write, when(config) (disabled unless true), visible(config)
 * (hidden unless true), place: 'section' (the section draws it with
 * A.fieldHtml; the page still binds it) and break (start a new box).
 *
 * Every change writes the field into the page's working copy and saves it
 * on its own after a short pause: the save re-reads the server
 * configuration and copies only the fields this page changed, so this page
 * and the main configuration page never overwrite each other. The preview
 * column is the settings panel hub's preview (ui-panel-tag-preview.js) fed a
 * new user's document seeded from these defaults, as the server seeds one.
 *
 * Not part of the user bundle: the page loads this file and the section
 * modules itself. It relies on the JE client bundle the dashboard already
 * runs (JE.t, core/tag-layout.js and the hub's preview).
 */
(function(JE) {
    'use strict';

    const PLUGIN_ID = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';
    const PAGE_NAME = 'JellyfinEnhancedMediaTags';
    const MAIN_PAGE_NAME = 'Jellyfin Enhanced';
    const SAVE_DELAY_MS = 400;
    const UNDO_MS = 10000;
    const TAB_STORE_KEY = 'JE_mediaTagsAdminTab';

    /** The section modules the page loads, in order (paths under js/enhanced/admintags/). */
    const SECTION_FILES = [
        'tag-styles-editor.js',
        'sections/overview.js',
        'sections/layout.js',
        'sections/quality.js',
        'sections/genre.js',
        'sections/language.js',
        'sections/rating.js',
        'sections/agerating.js',
        'sections/status.js',
        'sections/people.js',
        'sections/rules.js',
        'sections/colours.js',
        'sections/badges.js',
        'sections/server.js',
    ];

    /** The tabs, in order. */
    const TABS = [
        { id: 'overview', icon: 'dashboard', nameKey: 'admin_tags_tab_overview' },
        { id: 'layout', icon: 'view_quilt', nameKey: 'admin_tags_tab_layout' },
        { id: 'groups', icon: 'label', nameKey: 'admin_tags_tab_groups' },
        { id: 'rules', icon: 'rule', nameKey: 'admin_tags_tab_rules' },
        { id: 'colours', icon: 'palette', nameKey: 'admin_tags_tab_colours' },
        { id: 'badges', icon: 'new_releases', nameKey: 'admin_tags_tab_badges' },
        { id: 'server', icon: 'dns', nameKey: 'admin_tags_tab_server' },
    ];

    /**
     * The tag settings a new user's document copies from the configuration
     * (Controllers/JellyfinEnhancedController.cs LoadUserSettingsDocument and
     * the ApplyDefaults helpers it calls), PascalCase on the server.
     */
    const SEEDED_KEYS = [
        'QualityTagsEnabled', 'ShowResolutionTag', 'ShowSourceTag', 'ShowEditionTag', 'EditionTagOrder', 'ShowLowQualitySourceTag',
        'ShowDynamicRangeTag', 'ShowSpecialFormatTag', 'ShowVideoCodecTag', 'ShowAudioInfoTag', 'ResolutionTagOrder', 'SourceTagOrder',
        'DynamicRangeTagOrder', 'SpecialFormatTagOrder', 'VideoCodecTagOrder', 'AudioInfoTagOrder', 'GenreTagsEnabled', 'LanguageTagsEnabled',
        'RatingTagsEnabled', 'AgeRatingTagsEnabled', 'StatusTagsEnabled', 'PeopleTagsEnabled', 'TagsHideOnHover', 'QualityTagsPosition',
        'SeriesQualityAggregation', 'GenreTagsPosition', 'LanguageTagsPosition', 'RatingTagsPosition', 'RatingTagsOnMovies', 'RatingTagsOnSeries',
        'RatingTagsOnSeasons', 'RatingTagsOnEpisodes', 'RatingTagsOnContinueWatching', 'RatingTagsOnNextUp', 'RatingTagsShowCommunity',
        'RatingTagsShowCritic', 'RatingTagsSources', 'RatingTagsMinScore', 'RatingTagsColorByScore', 'AgeRatingTagsPosition', 'StatusTagsPosition',
        'StatusTagsJustAdded', 'StatusTagsNewRelease', 'StatusTagsTrending', 'StatusTagsSchedule', 'StatusTagsMilestones', 'StatusTagsSeriesStatus',
        'ShowRatingInPlayer', 'TagLayout', 'TagLabelDensity', 'TagLayouts', 'TagGroupOrder', 'TagGroupCaps',
        'LanguageTagsShowAudio', 'LanguageTagsShowSubtitles', 'LanguageTagsStyle', 'LanguageTagsCountBadge',
    ];

    /** @type {Array<Object>} registered sections, sorted by tab order then `order` */
    const sections = [];

    const esc = (value) => JE.escapeHtml(String(value ?? ''));
    /** @param {string} key @param {Object} [params] @returns {string} Translated and escaped. */
    const tx = (key, params) => esc(JE.t(key, params));

    /**
     * Register (or replace) a section.
     * @param {Object} def - See the file header.
     */
    function registerSection(def) {
        if (!def || !def.id || !TABS.some((t) => t.id === def.tab)) throw new Error(`JE admin tags: bad section ${def && def.id}`);
        const at = sections.findIndex((s) => s.id === def.id);
        if (at >= 0) sections.splice(at, 1);
        sections.push(def);
        const tabIndex = (s) => TABS.findIndex((t) => t.id === s.tab);
        sections.sort((a, b) => (tabIndex(a) - tabIndex(b)) || ((a.order || 0) - (b.order || 0)));
    }

    /**
     * A new user's settings document as the server would seed it from this
     * configuration (camelCase, as JE.currentSettings holds it).
     * @param {Object} config - The plugin configuration (PascalCase).
     * @returns {Object}
     */
    function seedUser(config) {
        const out = {};
        for (const key of SEEDED_KEYS) {
            if (config[key] !== undefined) out[key.charAt(0).toLowerCase() + key.slice(1)] = config[key];
        }
        out.tagLayoutSettingsVersion = 1;
        out.tagStylePreset = null;
        out.useNativePosterTags = null;
        return out;
    }

    /**
     * The configuration page link, optionally at a tab and group.
     * @param {string} [tab]
     * @param {string} [group]
     * @returns {string}
     */
    function pageUrl(tab, group) {
        const base = `${window.location.origin}${window.location.pathname}`;
        return `${base}#/configurationpage?name=${PAGE_NAME}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}${group ? `&group=${encodeURIComponent(group)}` : ''}`;
    }

    /**
     * The main configuration page link, optionally opened at a section
     * (configPage.html reads `jeSection`).
     * @param {string} [section]
     * @returns {string}
     */
    function mainPageUrl(section) {
        const base = `${window.location.origin}${window.location.pathname}`;
        return `${base}#/configurationpage?name=${encodeURIComponent(MAIN_PAGE_NAME)}${section ? `&jeSection=${encodeURIComponent(section)}` : ''}`;
    }

    /** @returns {{tab: string|null, group: string|null}} The tab and group the URL asks for. */
    function requestedTarget() {
        try {
            const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
            return { tab: params.get('tab'), group: params.get('group') };
        } catch {
            return { tab: null, group: null };
        }
    }

    // ── Field markup ───────────────────────────────────────────────────

    /**
     * The value a field shows for a configuration.
     * @param {Object} f - Field declaration.
     * @param {Object} config
     * @returns {*}
     */
    function fieldValue(f, config) {
        const raw = config[f.key];
        if (f.read) return f.read(raw, config);
        if (f.type === 'switch' || f.type === 'enable' || f.type === 'ordered') return raw === true;
        if (f.type === 'number') {
            const n = Number(raw);
            return Number.isFinite(n) && raw !== null && raw !== '' ? n : f.fallback;
        }
        if (raw === null || raw === undefined) return f.fallback ?? '';
        return f.type === 'pills' || f.type === 'select' ? String(raw) : raw;
    }

    /**
     * The value a field's control holds, as the configuration stores it.
     * @param {Object} f
     * @param {HTMLElement} el - The control (or, for pills, its group).
     * @param {Object} config - The configuration (for fields whose value depends on another).
     * @returns {*}
     */
    function controlValue(f, el, config) {
        let value;
        if (f.type === 'switch' || f.type === 'enable' || f.type === 'ordered') value = /** @type {HTMLInputElement} */ (el).checked;
        else if (f.type === 'pills') value = /** @type {HTMLInputElement|null} */ (el.querySelector('input:checked'))?.value ?? f.fallback;
        else if (f.type === 'number') {
            const n = Math.round(Number(/** @type {HTMLInputElement} */ (el).value));
            value = Number.isFinite(n) ? n : f.fallback;
            if (Number.isFinite(f.min)) value = Math.max(f.min, value);
            if (Number.isFinite(f.max)) value = Math.min(f.max, value);
        } else value = /** @type {HTMLInputElement} */ (el).value;
        if (f.type === 'text' || f.type === 'textarea') value = String(value).trim();
        return f.write ? f.write(value, config) : value;
    }

    /**
     * One field's markup.
     * @param {Object} f
     * @param {Object} config
     * @returns {string}
     */
    function fieldHtml(f, config) {
        const value = fieldValue(f, config);
        const descId = f.desc ? `${f.id}Desc` : '';
        const described = descId ? ` aria-describedby="${descId}"` : '';
        const data = `data-je-field="${esc(f.key)}" data-je-setting-id="${esc(f.id)}"`;
        const text = `<span class="je-ta-switch-text"><span class="je-ta-switch-name" data-je-label>${tx(f.label)}</span>${f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : ''}</span>`;
        switch (f.type) {
            case 'switch':
                return `<label class="je-ta-switch" data-field-row="${esc(f.id)}"><input type="checkbox" id="${esc(f.id)}" ${data} ${value ? 'checked' : ''}${described}>${text}</label>`;
            case 'select':
                return `<div class="je-ta-field" data-field-row="${esc(f.id)}"><span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${esc(f.id)}" data-je-label>${tx(f.label)}</label>${f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : ''}</span>`
                    + `<span class="je-ta-field-control"><select id="${esc(f.id)}" ${data}${described}>${(f.options || []).map(([v, k]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${k.startsWith('=') ? esc(k.slice(1)) : tx(k)}</option>`).join('')}</select></span></div>`;
            case 'number':
            case 'text':
                return `<div class="je-ta-field" data-field-row="${esc(f.id)}"><span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${esc(f.id)}" data-je-label>${tx(f.label)}</label>${f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : ''}</span>`
                    + `<span class="je-ta-field-control"><input type="${f.type}" id="${esc(f.id)}" ${data} value="${esc(value)}"${f.type === 'number' ? ` min="${f.min}" max="${f.max}" inputmode="numeric"` : ''}${f.placeholder ? ` placeholder="${tx(f.placeholder)}"` : ''}${described}>${f.unit ? `<span class="je-ta-unit">${tx(f.unit)}</span>` : ''}</span></div>`;
            case 'textarea':
                return `<div class="je-ta-field je-ta-field--block" data-field-row="${esc(f.id)}"><span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${esc(f.id)}" data-je-label>${tx(f.label)}</label>${f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : ''}</span>`
                    + `<span class="je-ta-field-control"><textarea id="${esc(f.id)}" ${data} rows="${f.rows || 4}" spellcheck="false"${f.placeholder ? ` placeholder="${tx(f.placeholder)}"` : ''}${described}>${esc(value)}</textarea></span></div>`;
            case 'pills':
                return `<div class="je-ta-field" data-field-row="${esc(f.id)}"><span class="je-ta-switch-text"><span class="je-ta-switch-name" id="${esc(f.id)}Label" data-je-label>${tx(f.label)}</span>${f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : ''}</span>`
                    + `<span class="je-ta-field-control"><span class="je-ta-pills" role="radiogroup" id="${esc(f.id)}" ${data} aria-labelledby="${esc(f.id)}Label"${described}>${(f.options || []).map(([v, k]) => `<label class="je-ta-pill"><input type="radio" name="${esc(f.id)}" value="${esc(v)}" ${String(v) === String(value) ? 'checked' : ''}><span>${tx(k)}</span></label>`).join('')}</span></span></div>`;
            default:
                return '';
        }
    }

    /**
     * The ordered fields of a section as one reorderable list, sorted by
     * their order keys (ties: declaration order).
     * @param {Object[]} fields - Consecutive `ordered` fields.
     * @param {Object} config
     * @returns {string}
     */
    function orderedHtml(fields, config) {
        const ranked = fields.map((f, i) => ({ f, i, n: Number.isFinite(Number(config[f.orderKey])) ? Number(config[f.orderKey]) : f.defaultOrder }))
            .sort((a, b) => (a.n - b.n) || (a.f.defaultOrder - b.f.defaultOrder) || (a.i - b.i));
        return `<ol class="je-ta-order" data-ordered-list>${ranked.map(({ f }, i) => {
            const name = JE.t(f.label);
            return `<li data-ordered="${esc(f.id)}"><span class="je-ta-rank" aria-hidden="true">${i + 1}</span>`
                + `<label><input type="checkbox" id="${esc(f.id)}" data-je-field="${esc(f.key)}" data-je-setting-id="${esc(f.id)}" ${config[f.key] === true ? 'checked' : ''}><span class="je-ta-order-name" data-je-label>${esc(name)}</span></label>`
                + `<button type="button" class="je-ta-icon-btn" data-move="-1" aria-label="${tx('admin_tags_move_up', { name })}" ${i === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>`
                + `<button type="button" class="je-ta-icon-btn" data-move="1" aria-label="${tx('admin_tags_move_down', { name })}" ${i === ranked.length - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button></li>`;
        }).join('')}</ol>`;
    }

    /**
     * A section's declared fields: switches, other fields and ordered lists
     * in runs, in declaration order. Enable and custom fields are skipped.
     * @param {Object[]} fields
     * @param {Object} config
     * @returns {string}
     */
    function fieldsHtml(fields, config) {
        const out = [];
        let run = [];
        let kind = '';
        const flush = () => {
            if (!run.length) return;
            if (kind === 'ordered') out.push(orderedHtml(run, config));
            else out.push(`<div class="${kind === 'switch' ? 'je-ta-switches' : 'je-ta-fields'}">${run.map((f) => fieldHtml(f, config)).join('')}</div>`);
            run = [];
        };
        for (const f of fields || []) {
            if (f.type === 'enable' || f.type === 'custom' || f.place === 'section') continue;
            const k = f.type === 'switch' ? 'switch' : f.type === 'ordered' ? 'ordered' : 'field';
            if (k !== kind || f.break) flush();
            kind = k;
            run.push(f);
        }
        flush();
        return out.join('');
    }

    // ── The page ───────────────────────────────────────────────────────

    /**
     * Build the page into its root and wire it.
     * @param {HTMLElement} root - The .je-tag-admin element.
     * @param {Object} config - The plugin configuration (the page's working copy).
     * @param {{api?: Object, confirm?: Function, now?: () => number}} [options] - Host
     *   hooks (tests): api = { get(): Promise<config>, put(config): Promise },
     *   confirm(text, title): Promise<boolean>.
     * @returns {Object} The page context.
     */
    function createPage(root, config, options = {}) {
        const host = options.api || {
            get: () => ApiClient.getPluginConfiguration(PLUGIN_ID),
            put: (c) => ApiClient.updatePluginConfiguration(PLUGIN_ID, c),
        };
        const changed = new Set();
        let saveTimer = null;
        let saving = null;
        let disposed = false;
        let preview = null;
        let snackTimer = null;
        /** @type {Object<string, boolean>} open state of each group row */
        const openGroups = {};

        root.classList.add('je-tag-admin');
        const groupSections = sections.filter((s) => s.tab === 'groups' && s.group);
        const tabButtons = TABS.map((tab, i) => `<button type="button" role="tab" class="je-ta-tab" id="jeTaTab-${tab.id}" data-tab="${tab.id}" aria-controls="jeTaPanel-${tab.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><span class="material-icons" aria-hidden="true">${tab.icon}</span>${tx(tab.nameKey)}</button>`).join('');
        const panels = TABS.map((tab, i) => {
            const own = sections.filter((s) => s.tab === tab.id && !s.group);
            const rows = tab.id === 'groups' ? `<div class="je-ta-grows">${groupSections.map((s) => groupRowHtml(s)).join('')}</div>` : '';
            return `<div class="je-ta-panel" role="tabpanel" id="jeTaPanel-${tab.id}" data-tab="${tab.id}" aria-labelledby="jeTaTab-${tab.id}" ${i === 0 ? '' : 'hidden'}>`
                + `<h2 tabindex="-1">${tx(tab.nameKey)}</h2><p class="je-ta-hint">${tx(`${tab.nameKey}_desc`)}</p>`
                + own.map((s) => sectionHtml(s)).join('') + rows + '</div>';
        }).join('');
        root.innerHTML = `
            <div class="je-ta-head"><a class="je-ta-back" href="${esc(mainPageUrl())}"><span class="material-icons" aria-hidden="true">arrow_back</span>${tx('admin_tags_back')}</a></div>
            <div class="je-ta-head" style="padding-top:0">
                <h2 class="je-ta-title">${tx('admin_tags_title')} <span class="je-ta-admin-chip">${tx('admin_tags_badge')}</span></h2>
                <span class="je-ta-head-spacer"></span>
                <span class="je-ta-saved" id="jeTaSaved" data-state="saved" role="status" aria-live="polite">${tx('admin_tags_saved')}</span>
            </div>
            <p class="je-ta-intro">${tx('admin_tags_intro')}</p>
            <div class="je-ta-tabs" role="tablist" aria-label="${tx('admin_tags_title')}">${tabButtons}</div>
            <div class="je-ta-body">
                <aside class="je-ta-preview" id="jeTaPreview" aria-label="${tx('admin_tags_preview')}">
                    <button type="button" class="je-ta-preview-toggle" aria-expanded="false" aria-controls="jeTaPreviewBody">${tx('admin_tags_preview')}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                    <div class="je-ta-preview-body" id="jeTaPreviewBody"><div class="je-ta-preview-mount"></div><p class="je-ta-preview-note">${tx('admin_tags_preview_note')}</p><p class="je-ta-native" id="jeTaNative"></p></div>
                </aside>
                <div class="je-ta-panels">${panels}</div>
            </div>
            <div class="je-ta-live" role="status" aria-live="polite"></div>`;

        /** @param {Object} s @returns {string} A section card. */
        function sectionHtml(s) {
            return `<section class="je-ta-card" data-section="${esc(s.id)}" aria-labelledby="jeTaSec-${esc(s.id)}">`
                + `<h3 class="je-ta-card-title" id="jeTaSec-${esc(s.id)}">${tx(s.title)}</h3>${s.hint ? `<p class="je-ta-hint">${tx(s.hint)}</p>` : ''}`
                + fieldsHtml(s.fields, config) + '<div class="je-ta-section-body"></div></section>';
        }

        /** @param {Object} s @returns {string} A Groups tab row (head + closed panel). */
        function groupRowHtml(s) {
            const enable = (s.fields || []).find((f) => f.type === 'enable');
            const on = enable ? config[enable.key] === true : true;
            const name = JE.t(s.title);
            return `<div class="je-ta-grow" data-group="${esc(s.group.id)}" data-section="${esc(s.id)}" data-enabled="${on}" data-open="false">`
                + '<div class="je-ta-grow-head">'
                + (enable ? `<input type="checkbox" id="${esc(enable.id)}" data-je-field="${esc(enable.key)}" data-je-setting-id="${esc(enable.id)}" ${on ? 'checked' : ''} aria-label="${tx(enable.label)}">` : '')
                + `<div class="je-ta-grow-text"><span class="je-ta-grow-name" id="jeTaSec-${esc(s.id)}">${esc(name)}</span><span class="je-ta-grow-sum"></span></div>`
                + '<span class="je-ta-grow-sample" aria-hidden="true"></span>'
                + `<button type="button" class="je-ta-expand" aria-expanded="false" aria-controls="jeTaGroup-${esc(s.group.id)}" aria-label="${tx('admin_tags_group_open', { name })}"><span class="je-ta-expand-text">${tx('admin_tags_open')}</span><span class="material-icons" aria-hidden="true">expand_more</span></button>`
                + '</div>'
                + `<div class="je-ta-grow-body" id="jeTaGroup-${esc(s.group.id)}" role="region" aria-labelledby="jeTaSec-${esc(s.id)}" hidden>${s.hint ? `<p class="je-ta-hint">${tx(s.hint)}</p>` : ''}${fieldsHtml(s.fields, config)}<div class="je-ta-section-body"></div></div></div>`;
        }

        const tabs = /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('[role="tab"]')));
        const live = /** @type {HTMLElement} */ (root.querySelector('.je-ta-live'));
        const savedChip = /** @type {HTMLElement} */ (root.querySelector('#jeTaSaved'));

        // ── Saving ──
        /** @param {'saved'|'saving'|'error'} state */
        const setSaveState = (state) => {
            savedChip.dataset.state = state;
            savedChip.innerHTML = state === 'saving' ? tx('admin_tags_saving')
                : state === 'error' ? `${tx('admin_tags_save_failed')}<button type="button" data-je-retry>${tx('admin_tags_retry')}</button>`
                : tx('admin_tags_saved');
        };
        savedChip.addEventListener('click', (e) => {
            if (/** @type {HTMLElement} */ (e.target).closest('[data-je-retry]')) flush();
        });

        /**
         * Save every changed field now: re-read the server configuration, copy
         * only the changed fields into it and write it back.
         * @returns {Promise<boolean>} Whether everything changed so far is saved.
         */
        function flush() {
            clearTimeout(saveTimer);
            saveTimer = null;
            if (saving) return saving.then(() => (changed.size ? flush() : true));
            if (!changed.size) return Promise.resolve(true);
            const keys = Array.from(changed);
            changed.clear();
            setSaveState('saving');
            saving = (async () => {
                try {
                    const fresh = await host.get();
                    for (const key of keys) fresh[key] = config[key];
                    await host.put(fresh);
                    if (!changed.size) setSaveState('saved');
                    return true;
                } catch (err) {
                    console.error('🪼 Jellyfin Enhanced: could not save the Media Tags settings', err);
                    for (const key of keys) changed.add(key);
                    setSaveState('error');
                    return false;
                } finally {
                    saving = null;
                }
            })();
            return saving.then((ok) => (ok && changed.size ? flush() : ok));
        }

        /** Queue a save after a short pause (a burst of changes saves once). */
        const schedule = () => {
            clearTimeout(saveTimer);
            setSaveState('saving');
            saveTimer = setTimeout(() => { flush(); }, SAVE_DELAY_MS);
        };

        /**
         * Write configuration fields, save them and redraw what depends on them.
         * @param {Object<string, *>} values - Field → value.
         * @param {{redraw?: boolean}} [opts] - redraw: false leaves the controls alone.
         */
        function setMany(values, opts = {}) {
            for (const [key, value] of Object.entries(values)) {
                config[key] = value;
                changed.add(key);
            }
            schedule();
            refresh(opts.redraw === false ? { controls: false } : {});
        }

        // ── Field wiring ──
        const allFields = sections.flatMap((s) => (s.fields || []).map((f) => ({ f, s })));
        const fieldById = new Map(allFields.map(({ f, s }) => [f.id, { f, s }]));

        /** Push the configuration into every declared control (fields changed elsewhere). */
        function syncControls() {
            for (const { f } of allFields) {
                if (f.type === 'custom') continue;
                const el = /** @type {HTMLElement|null} */ (root.querySelector(`[data-je-setting-id="${f.id}"]`));
                if (!el || el === document.activeElement) continue;
                const value = fieldValue(f, config);
                if (f.type === 'switch' || f.type === 'enable' || f.type === 'ordered') /** @type {HTMLInputElement} */ (el).checked = !!value;
                else if (f.type === 'pills') el.querySelectorAll('input').forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === String(value); });
                else /** @type {HTMLInputElement} */ (el).value = String(value ?? '');
            }
        }

        /** Disable fields whose `when` does not hold; hide those whose `visible` does not. */
        function syncAvailability() {
            for (const { f } of allFields) {
                if (f.visible) {
                    const row = /** @type {HTMLElement|null} */ (root.querySelector(`[data-field-row="${f.id}"]`));
                    if (row) row.hidden = !f.visible(config);
                }
                if (!f.when) continue;
                const el = root.querySelector(`[data-je-setting-id="${f.id}"]`);
                const row = /** @type {HTMLElement|null} */ (root.querySelector(`[data-field-row="${f.id}"]`));
                const on = !!f.when(config);
                if (f.hideWhenOff && row) row.hidden = !on;
                if (el) {
                    if (el.matches('input, select, textarea')) /** @type {HTMLInputElement} */ (el).disabled = !on;
                    else el.querySelectorAll('input').forEach((i) => { /** @type {HTMLInputElement} */ (i).disabled = !on; });
                }
            }
        }

        root.addEventListener('change', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const holder = /** @type {HTMLElement|null} */ (target.closest('[data-je-setting-id]'));
            const entry = holder && fieldById.get(holder.dataset.jeSettingId || '');
            if (!entry || entry.f.type === 'custom') return;
            const value = controlValue(entry.f, holder, config);
            const extra = entry.f.onChange ? entry.f.onChange(value, config) || {} : {};
            setMany({ [entry.f.key]: value, ...extra }, { redraw: false });
            if (entry.f.type === 'number' || entry.f.type === 'text') syncControls();
            if (entry.f.type === 'enable') {
                const row = /** @type {HTMLElement|null} */ (holder.closest('.je-ta-grow'));
                if (row) row.dataset.enabled = String(value);
            }
        });

        // Ordered lists: a move swaps two rows and writes every order key by position.
        root.addEventListener('click', (e) => {
            const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-move]'));
            if (!button || button.disabled) return;
            const li = /** @type {HTMLElement} */ (button.closest('li[data-ordered]'));
            const list = /** @type {HTMLElement} */ (li.parentElement);
            const dir = Number(button.dataset.move);
            const sibling = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
            if (!sibling) return;
            if (dir < 0) list.insertBefore(li, sibling); else list.insertBefore(sibling, li);
            const values = {};
            Array.from(list.children).forEach((row, i) => {
                const f = fieldById.get(/** @type {HTMLElement} */ (row).dataset.ordered || '')?.f;
                if (f) values[f.orderKey] = i + 1;
                const rank = row.querySelector('.je-ta-rank');
                if (rank) rank.textContent = String(i + 1);
                row.querySelector('[data-move="-1"]')?.toggleAttribute('disabled', i === 0);
                row.querySelector('[data-move="1"]')?.toggleAttribute('disabled', i === list.children.length - 1);
            });
            setMany(values, { redraw: false });
            const again = /** @type {HTMLButtonElement|null} */ (li.querySelector(`[data-move="${dir}"]`));
            (again && !again.disabled ? again : li.querySelector('[data-move]:not([disabled])') || li.querySelector('input'))?.focus();
            announce(JE.t('admin_tags_moved', { name: li.querySelector('.je-ta-order-name')?.textContent || '', n: Array.from(list.children).indexOf(li) + 1 }));
        });

        // ── Tabs ──
        const current = () => root.dataset.tab || 'overview';
        /**
         * Show a tab, optionally a group's panel on the Groups tab.
         * @param {string} id
         * @param {{group?: string|null, focus?: boolean, focusTab?: boolean}} [opts]
         * @returns {boolean}
         */
        function openTab(id, opts = {}) {
            const tab = tabs.find((t) => t.dataset.tab === id);
            if (!tab) return false;
            for (const t of tabs) {
                const on = t === tab;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
                const panel = /** @type {HTMLElement|null} */ (root.querySelector(`#jeTaPanel-${t.dataset.tab}`));
                if (panel) panel.hidden = !on;
            }
            root.dataset.tab = id;
            try { window.sessionStorage.setItem(TAB_STORE_KEY, id); } catch { /* storage unavailable */ }
            for (const s of sections) if (s.tab === id && s.show) s.show(ctx, bodyOf(s));
            if (opts.group) setGroupOpen(opts.group, true, { focus: opts.focus });
            else if (opts.focus) /** @type {HTMLElement|null} */ (root.querySelector(`#jeTaPanel-${id} > h2`))?.focus();
            if (opts.focusTab) tab.focus();
            tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
            syncSpotlight();
            return true;
        }
        const tablist = /** @type {HTMLElement} */ (root.querySelector('[role="tablist"]'));
        tablist.addEventListener('click', (e) => {
            const tab = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[role="tab"]'));
            if (tab) openTab(tab.dataset.tab || 'overview');
        });
        // Roving focus with automatic activation (WAI tabs pattern).
        tablist.addEventListener('keydown', (e) => {
            const index = tabs.indexOf(/** @type {HTMLElement} */ (document.activeElement));
            if (index < 0) return;
            let next = -1;
            if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = tabs.length - 1;
            if (next < 0) return;
            e.preventDefault();
            openTab(tabs[next].dataset.tab || 'overview', { focusTab: true });
        });
        // Any element with data-je-goto="tab[:group]" opens it.
        root.addEventListener('click', (e) => {
            const goto = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-je-goto]'));
            if (!goto) return;
            e.preventDefault();
            const [tab, group] = String(goto.dataset.jeGoto).split(':');
            openTab(tab, { group: group || null, focus: true });
        });

        // ── Group rows ──
        /**
         * Open or close a group's panel.
         * @param {string} group
         * @param {boolean} open
         * @param {{focus?: boolean}} [opts]
         */
        function setGroupOpen(group, open, opts = {}) {
            const row = /** @type {HTMLElement|null} */ (root.querySelector(`.je-ta-grow[data-group="${group}"]`));
            if (!row) {
                // Not a group: a section marked data-je-anchor (e.g. layout:apply).
                const anchor = /** @type {HTMLElement|null} */ (root.querySelector(`[data-je-anchor="${group}"]`));
                if (anchor && opts.focus) {
                    anchor.scrollIntoView?.({ block: 'start' });
                    /** @type {HTMLElement|null} */ (anchor.querySelector('button, input, select'))?.focus({ preventScroll: true });
                }
                return;
            }
            const body = /** @type {HTMLElement} */ (row.querySelector('.je-ta-grow-body'));
            const button = /** @type {HTMLElement} */ (row.querySelector('.je-ta-expand'));
            openGroups[group] = open;
            row.dataset.open = String(open);
            body.hidden = !open;
            button.setAttribute('aria-expanded', String(open));
            const text = button.querySelector('.je-ta-expand-text');
            if (text) text.textContent = JE.t(open ? 'admin_tags_close' : 'admin_tags_open');
            const s = sections.find((x) => x.group?.id === group);
            if (open && s?.show) s.show(ctx, bodyOf(s));
            if (open && opts.focus) {
                row.scrollIntoView?.({ block: 'start' });
                (/** @type {HTMLElement|null} */ (body.querySelector('input, select, textarea, button')) || button).focus({ preventScroll: true });
            }
            syncSpotlight();
        }
        root.querySelector('.je-ta-grows')?.addEventListener('click', (e) => {
            const button = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.je-ta-expand'));
            const row = /** @type {HTMLElement|null} */ (button?.closest('.je-ta-grow') || null);
            if (row) setGroupOpen(row.dataset.group || '', button?.getAttribute('aria-expanded') !== 'true');
        });

        /** @param {Object} s @returns {HTMLElement} The section's custom-content element. */
        function bodyOf(s) {
            return /** @type {HTMLElement} */ (root.querySelector(`[data-section="${s.id}"] .je-ta-section-body`));
        }

        /** Rewrite each group row's summary and sample chips. */
        function syncGroupRows() {
            for (const s of groupSections) {
                const row = /** @type {HTMLElement|null} */ (root.querySelector(`.je-ta-grow[data-group="${s.group.id}"]`));
                if (!row) continue;
                const enable = (s.fields || []).find((f) => f.type === 'enable');
                row.dataset.enabled = String(enable ? config[enable.key] === true : true);
                const sum = row.querySelector('.je-ta-grow-sum');
                if (sum) sum.textContent = s.group.summary ? s.group.summary(ctx) : '';
                const sample = row.querySelector('.je-ta-grow-sample');
                if (sample) sample.innerHTML = (s.group.sample ? s.group.sample(ctx) : []).map(([kind, text]) => `<span class="je-ta-chip" data-kind="${esc(kind)}">${esc(text)}</span>`).join('');
            }
        }

        // ── Preview ──
        const previewBox = /** @type {HTMLElement} */ (root.querySelector('#jeTaPreview'));
        const previewToggle = /** @type {HTMLElement} */ (root.querySelector('.je-ta-preview-toggle'));
        previewToggle.addEventListener('click', () => {
            const open = previewToggle.getAttribute('aria-expanded') !== 'true';
            previewToggle.setAttribute('aria-expanded', String(open));
            previewBox.classList.toggle('je-ta-preview-open', open);
        });
        const mount = /** @type {HTMLElement} */ (root.querySelector('.je-ta-preview-mount'));
        const createPreview = JE.internals?.enhancedUi?.createTagPreview;
        if (typeof createPreview === 'function') {
            preview = createPreview(mount, { source: () => ({ settings: seedUser(config), plugin: config }) });
        }
        /** Outline the group being edited in the preview. */
        function syncSpotlight() {
            if (!preview) return;
            const open = current() === 'groups' ? Object.keys(openGroups).find((g) => openGroups[g]) : null;
            const spot = current() === 'badges' ? 'status' : (open && open !== 'people' ? open : null);
            preview.setSpotlight(spot);
        }
        /** The native poster line under the preview. */
        function syncNative() {
            const line = root.querySelector('#jeTaNative');
            if (!line) return;
            const on = config.NativePosterTagsEnabled === true;
            const colours = config.TagStylesEnabled === true && ['native', 'both'].includes(String(config.TagStyleTarget || 'both'));
            line.innerHTML = `<strong>${tx('admin_tags_native_label')}</strong> ${on ? tx(colours ? 'admin_tags_native_on_colours' : 'admin_tags_native_on') : tx('admin_tags_native_off')}`;
        }

        // ── Feedback ──
        /** @param {string} message - Said by screen readers (polite). */
        function announce(message) {
            live.textContent = '';
            setTimeout(() => { if (!disposed) live.textContent = message; }, 30);
        }

        /**
         * Ask before a destructive action.
         * @param {string} text
         * @param {string} title
         * @returns {Promise<boolean>}
         */
        function confirmAction(text, title) {
            if (options.confirm) return Promise.resolve(options.confirm(text, title));
            return new Promise((resolve) => {
                try {
                    if (typeof Dashboard !== 'undefined' && typeof Dashboard.confirm === 'function') {
                        Dashboard.confirm(esc(text).replace(/\n/g, '<br>'), title, (ok) => resolve(!!ok));
                        return;
                    }
                } catch { /* fall through */ }
                resolve(window.confirm(`${title}\n\n${text}`));
            });
        }

        /**
         * A short message at the bottom of the page, with an Undo button when
         * `undo` is given.
         * @param {string} message
         * @param {(() => void)|null} [undo]
         */
        function snack(message, undo) {
            root.querySelector('.je-ta-snack')?.remove();
            clearTimeout(snackTimer);
            const bar = document.createElement('div');
            bar.className = 'je-ta-snack';
            bar.setAttribute('role', 'status');
            const text = document.createElement('span');
            text.textContent = message;
            bar.appendChild(text);
            if (undo) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'je-ta-button';
                button.textContent = JE.t('admin_tags_undo');
                button.addEventListener('click', () => { bar.remove(); undo(); announce(JE.t('admin_tags_undone')); });
                bar.appendChild(button);
            }
            root.appendChild(bar);
            snackTimer = setTimeout(() => bar.remove(), undo ? UNDO_MS : 4000);
            announce(message);
        }

        // ── Refresh ──
        /**
         * Redraw everything that depends on the configuration.
         * @param {{controls?: boolean}} [opts] - controls: false keeps the controls as they are.
         */
        function refresh(opts = {}) {
            if (disposed) return;
            if (opts.controls !== false) syncControls();
            syncAvailability();
            syncGroupRows();
            for (const s of sections) if (s.refresh) s.refresh(ctx, bodyOf(s));
            syncNative();
            preview?.refresh();
        }

        /** Tear the page down: the preview and pending timers (saves are flushed first by the caller). */
        function dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(snackTimer);
            preview?.dispose();
            preview = null;
            for (const s of sections) s.dispose?.(ctx);
        }

        /**
         * Replace the working copy with a fresh configuration (page shown again).
         * Fields with unsaved changes keep the page's values.
         * @param {Object} fresh
         */
        function reload(fresh) {
            for (const key of Object.keys(fresh)) if (!changed.has(key)) config[key] = fresh[key];
            for (const s of sections) s.load?.(ctx, bodyOf(s));
            refresh();
        }

        const ctx = {
            root, config, t: JE.t, tx, esc,
            /** @param {string} key @param {*} value */
            set: (key, value) => setMany({ [key]: value }),
            setMany, flush, refresh, reload, openTab, setGroupOpen, confirm: confirmAction, snack, announce, dispose,
            pageUrl, mainPageUrl,
            /** @returns {string} The tab shown now. */
            currentTab: current,
            /** @returns {boolean} Whether some change is not saved yet. */
            pending: () => changed.size > 0 || !!saving || !!saveTimer,
            get preview() { return preview; },
            layout: JE.core?.tagLayout || null,
            fieldValue,
        };

        for (const s of sections) s.render?.(ctx, bodyOf(s));
        refresh({ controls: false });
        let start = requestedTarget();
        if (!start.tab || !TABS.some((t) => t.id === start.tab)) {
            let saved = null;
            try { saved = window.sessionStorage.getItem(TAB_STORE_KEY); } catch { /* storage unavailable */ }
            start = { tab: TABS.some((t) => t.id === saved) ? saved : 'overview', group: null };
        }
        openTab(start.tab || 'overview', { group: start.group });
        return ctx;
    }

    /**
     * Theme: Jellyfin's themes swap a stylesheet, so tell light from dark by
     * the page background (as configPage.html does).
     * @param {HTMLElement} root
     */
    function detectTheme(root) {
        try {
            const m = getComputedStyle(document.documentElement).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            root.classList.toggle('je-ta-light', !!m && (+m[1] + +m[2] + +m[3]) > 450);
        } catch { /* keep dark */ }
    }

    /**
     * Load a script once (resolves when it ran).
     * @param {string} src
     * @returns {Promise<void>}
     */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = () => resolve();
            el.onerror = () => reject(new Error(`could not load ${src}`));
            document.head.appendChild(el);
        });
    }

    /** @type {Promise<void>|null} the section modules, loaded once per document */
    let modulesLoaded = null;
    /**
     * The one live page. Jellyfin keeps earlier views in the document, so
     * opening the page again creates another page element: only the shown
     * one is built (ids stay unique), the other is emptied and rebuilt if it
     * is shown again.
     * @type {{page: HTMLElement, root: HTMLElement, ctx: Object}|null}
     */
    let active = null;
    /** @type {Promise<Object|null>} activations run one after another */
    let queue = Promise.resolve(null);
    let unloadWired = false;

    /**
     * Make a page element the live one: build it (tearing down any other),
     * or reload its configuration when it already is; then open the tab the
     * URL asks for.
     * @param {HTMLElement} page
     * @returns {Promise<Object|null>} The page context.
     */
    function activate(page) {
        queue = queue.then(async () => {
            const root = /** @type {HTMLElement} */ (page.querySelector('.je-tag-admin'));
            detectTheme(root);
            if (active && active.page === page && root.contains(active.ctx.root.firstElementChild)) {
                try { active.ctx.reload(await ApiClient.getPluginConfiguration(PLUGIN_ID)); } catch (err) { console.warn('🪼 Jellyfin Enhanced: could not reload the configuration', err); }
                const target = requestedTarget();
                if (target.tab) active.ctx.openTab(target.tab, { group: target.group });
                return active.ctx;
            }
            if (active) {
                const previous = active;
                active = null;
                await previous.ctx.flush();
                previous.ctx.dispose();
                previous.root.replaceChildren();
                delete previous.root.dataset.tab;
            }
            Dashboard.showLoadingMsg?.();
            let config;
            try {
                config = await ApiClient.getPluginConfiguration(PLUGIN_ID);
            } finally {
                Dashboard.hideLoadingMsg?.();
            }
            const ctx = createPage(root, config);
            active = { page, root, ctx };
            return ctx;
        }).catch((err) => {
            console.error('🪼 Jellyfin Enhanced: the Media Tags page failed to load', err);
            return null;
        });
        return queue;
    }

    /**
     * Mount the page: load the section modules once, build the page, and keep
     * it live across Jellyfin's view lifecycle (rebuilt or reloaded on
     * viewshow, pending saves flushed before it hides or the tab closes).
     * @param {HTMLElement} page - The plugin page element (data-role="page").
     * @param {string} [version] - Cache-busting version for the module URLs.
     * @returns {Promise<Object|null>} The page context.
     */
    async function mount(page, version) {
        if (!modulesLoaded) {
            const query = version ? `?v=${encodeURIComponent(version)}` : '';
            modulesLoaded = SECTION_FILES.reduce((chain, file) => chain.then(() => loadScript(ApiClient.getUrl(`/JellyfinEnhanced/js/enhanced/admintags/${file}`) + query)), Promise.resolve());
        }
        await modulesLoaded;
        if (!page.dataset.jeTaWired) {
            page.dataset.jeTaWired = '1';
            page.addEventListener('viewshow', () => { activate(page); });
            page.addEventListener('viewbeforehide', () => { if (active?.page === page) active.ctx.flush(); });
        }
        if (!unloadWired) {
            unloadWired = true;
            window.addEventListener('beforeunload', (e) => {
                if (!active?.ctx.pending()) return;
                active.ctx.flush();
                e.preventDefault();
            });
        }
        return activate(page);
    }

    JE.adminTags = {
        TABS,
        SECTION_FILES,
        SEEDED_KEYS,
        PAGE_NAME,
        PLUGIN_ID,
        sections,
        registerSection,
        seedUser,
        pageUrl,
        mainPageUrl,
        fieldHtml,
        fieldsHtml,
        fieldValue,
        controlValue,
        createPage,
        mount,
        requestedTarget,
    };
})(window.JellyfinEnhanced);
